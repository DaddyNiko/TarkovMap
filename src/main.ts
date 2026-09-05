/**
 * TarkovMap — Electron main process.
 *
 * Windows:
 *   overlay  — small transparent always-on-top window covering only the
 *              minimap + side panel region of the main display. Click-through
 *              unless F9. (v0.1 covered the whole display and made the game lag.)
 *   tags     — full-display transparent window for in-game squad tags and
 *              pings; exists only while there is something to draw.
 *   bigmap   — the full map on the second display (or on demand).
 *   control  — the settings / squad / quests / align app.
 *
 * Never touches the game: reads its log files and the screenshot folder,
 * and (hold/timer mode) sends one keypress to the game window.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { floorForPosition, interactiveMaps, type MapDef } from "./map-data.js";
import { GameWatcher, INITIAL_STATE, logsDirFor, scanQuestHistory, type GameState, type LogEvent } from "./game-watcher.js";
import { ScreenshotFeed, type PlayerFix } from "./screenshot-feed.js";
import { KeySender } from "./key-sender.js";
import { DEFAULT_SETTINGS, defaultScreenshotsFolder, loadSettings, sanitize, saveSettings, type Settings } from "./settings.js";
import { detectInstall, myDocuments } from "./install.js";
import { CACHE_TTL_MS, featuresFor, fetchFeatures, readCache, writeCache, type FeatureCache } from "./map-features.js";
import { cacheMapTiles, localTemplate, readSvg, tileTemplates, type FetchProgress } from "./tiles.js";
import { activeQuestIds, applyQuestEvent, fetchTasks, objectivesOnMap, readTaskCache, writeTaskCache, type QuestBook, type TaskCache } from "./quests.js";
import { SquadLink, type SquadPing, type SquadState } from "./squad.js";
import { askModelForIntent, parseFilterPrompt, type FilterIntent } from "./filter-prompt.js";
import { loadRegistration, register, saveRegistration, sourceFor, type ControlPoint, type Registration } from "./re3mr.js";
import { pyramidDir, pyramidDone, slice, type SliceResult } from "./re3mr-slicer.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER = () => app.getPath("userData");
const SETTINGS_FILE = () => join(USER(), "settings.json");
const TILE_ROOT = () => join(USER(), "tiles");
const FEATURES_FILE = () => join(USER(), "features.json");
const TASKS_FILE = () => join(USER(), "tasks.json");
const QUESTS_FILE = () => join(USER(), "quests.json");
const RE3MR_DIR = () => join(USER(), "re3mr");
const DATA_RETRY_MS = 15 * 60 * 1000;

const MAPS: MapDef[] = interactiveMaps(JSON.parse(readFileSync(join(ROOT, "data", "maps.json"), "utf8")));

let overlay: BrowserWindow | null = null;
let tags: BrowserWindow | null = null;
let bigmap: BrowserWindow | null = null;
let control: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let game: GameWatcher | null = null;
let feed: ScreenshotFeed | null = null;
const sender = new KeySender();
let lastFix: PlayerFix | null = null;
const trail: Array<{ x: number; z: number; at: number }> = [];
let gameState: GameState = { ...INITIAL_STATE };
let features: FeatureCache | null = null;
let tasks: TaskCache | null = null;
let dataStatus = { features: "missing" as "ok" | "missing" | "cached", tasks: "missing" as "ok" | "missing" | "cached", lastError: "", nextRetryAt: 0 };
let quests: QuestBook = {};
let squad: SquadLink | null = null;
let squadState: SquadState = { mates: {}, pings: [] };
let myPings: SquadPing[] = [];
let tileProgress: Record<string, FetchProgress> = {};
const re3mrReady = new Map<string, SliceResult>();
const re3mrProgress: Record<string, { done: number; total: number; stage: string }> = {};
const logLines: string[] = [];
let quitting = false;
let overlayInteractive = false;
let overlayHidden = false;

function log(line: string): void {
  const stamped = `${new Date().toLocaleTimeString()} ${line}`;
  logLines.push(stamped);
  if (logLines.length > 400) logLines.shift();
  console.log(stamped);
  broadcast("log", stamped);
}

function windows(): BrowserWindow[] {
  return [overlay, tags, bigmap, control].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed()));
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of windows()) w.webContents.send(channel, payload);
}

// ── Displays & windows ─────────────────────────────────────────────────────
function displayById(id: number | null, fallback: Electron.Display): Electron.Display {
  if (id == null) return fallback;
  return screen.getAllDisplays().find((d) => d.id === id) ?? fallback;
}

function overlayDisplay(): Electron.Display {
  return displayById(settings.overlayDisplayId, screen.getPrimaryDisplay());
}

function bigMapDisplay(): Electron.Display | null {
  const primary = overlayDisplay();
  if (settings.bigMapDisplayId != null) {
    const d = displayById(settings.bigMapDisplayId, primary);
    return d.id === primary.id ? null : d;
  }
  return screen.getAllDisplays().find((d) => d.id !== primary.id) ?? null;
}

const PRELOAD = () => resolve(ROOT, "src", "preload.cjs");
const WEB = () => ({ preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false, backgroundThrottling: false });

/** The rectangle the HUD window occupies: minimap + panel, scaled, in the chosen corner. */
function overlayBounds(): Electron.Rectangle {
  const d = overlayDisplay();
  const s = settings.overlayScale;
  const panelW = 360, gap = 20, panelH = 560;
  const w = Math.round((settings.margin * 2 + settings.minimapSize + gap + panelW) * s);
  const h = Math.round((settings.margin * 2 + Math.max(settings.minimapSize, panelH)) * s);
  const width = Math.min(w, d.bounds.width), height = Math.min(h, d.bounds.height);
  const x = settings.corner.endsWith("left") ? d.bounds.x : d.bounds.x + d.bounds.width - width;
  const y = settings.corner.startsWith("top") ? d.bounds.y : d.bounds.y + d.bounds.height - height;
  return { x, y, width, height };
}

function createOverlay(): void {
  const b = overlayBounds();
  overlay = new BrowserWindow({ ...b, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, webPreferences: WEB() });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setMenuBarVisibility(false);
  overlay.loadFile(resolve(ROOT, "renderer", "overlay.html"));
  overlay.once("ready-to-show", () => {
    if (!overlayHidden) overlay?.showInactive();
    applyClickThrough();
  });
  overlay.on("closed", () => (overlay = null));
  wireConsole(overlay, "overlay");
}

function ensureTagsWindow(): void {
  const want = settings.showTags && gameState.raid === "in-raid" && (Object.keys(squadState.mates).length > 0 || squadState.pings.length > 0 || myPings.length > 0);
  if (want && !tags) {
    const d = overlayDisplay();
    tags = new BrowserWindow({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, webPreferences: WEB() });
    tags.setAlwaysOnTop(true, "screen-saver");
    tags.setIgnoreMouseEvents(true, { forward: true });
    tags.setMenuBarVisibility(false);
    tags.loadFile(resolve(ROOT, "renderer", "overlay.html"), { query: { mode: "tags" } });
    tags.once("ready-to-show", () => { if (!overlayHidden) tags?.showInactive(); });
    tags.on("closed", () => (tags = null));
    wireConsole(tags, "tags");
  } else if (!want && tags) {
    tags.destroy();
    tags = null;
  }
}

function wireConsole(w: BrowserWindow, name: string): void {
  w.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) log(`${name}: ${message} (${source.split(/[\\/]/).pop()}:${line})`);
  });
}

function applyClickThrough(): void {
  if (!overlay) return;
  overlay.setIgnoreMouseEvents(!overlayInteractive, { forward: true });
  overlay.setFocusable(overlayInteractive);
  if (overlayInteractive) overlay.focus();
  broadcast("overlay-mode", { interactive: overlayInteractive, hidden: overlayHidden });
}

function createBigMap(): void {
  const d = bigMapDisplay();
  if (!d || !settings.bigMapEnabled) return;
  bigmap = new BrowserWindow({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height, frame: false, backgroundColor: "#0b0c0e", show: false, title: "TarkovMap — full map", icon: iconPath(), webPreferences: WEB() });
  bigmap.setMenuBarVisibility(false);
  bigmap.loadFile(resolve(ROOT, "renderer", "bigmap.html"));
  bigmap.once("ready-to-show", () => bigmap?.showInactive());
  bigmap.on("close", (e) => { if (!quitting) { e.preventDefault(); bigmap?.hide(); } });
  bigmap.on("closed", () => (bigmap = null));
  wireConsole(bigmap, "bigmap");
}

function createControl(): void {
  if (control) { control.show(); control.focus(); return; }
  const d = overlayDisplay();
  control = new BrowserWindow({ width: 1100, height: 760, x: d.workArea.x + Math.round((d.workArea.width - 1100) / 2), y: d.workArea.y + Math.round((d.workArea.height - 760) / 2), minWidth: 860, minHeight: 580, backgroundColor: "#0b0c0e", title: "TarkovMap", icon: iconPath(), autoHideMenuBar: true, webPreferences: WEB() });
  control.loadFile(resolve(ROOT, "renderer", "control.html"), process.env.TARKOVMAP_SHOT_PAGE ? { hash: process.env.TARKOVMAP_SHOT_PAGE } : undefined);
  control.on("close", (e) => { if (!quitting) { e.preventDefault(); control?.hide(); } });
  control.on("closed", () => (control = null));
  control.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  wireConsole(control, "control");
}

function iconPath(): string {
  return resolve(ROOT, "build", "icon.png");
}

function createTray(): void {
  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip("TarkovMap");
  tray.on("double-click", createControl);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open TarkovMap", click: createControl },
    { label: "Show / hide overlay (F10)", click: toggleOverlayHidden },
    { label: "Full map window", click: () => { if (!bigmap) createBigMap(); bigmap?.show(); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

// ── Hotkeys ────────────────────────────────────────────────────────────────
function toggleOverlayHidden(): void {
  overlayHidden = !overlayHidden;
  for (const w of [overlay, tags]) if (w) overlayHidden ? w.hide() : w.showInactive();
  broadcast("overlay-mode", { interactive: overlayInteractive, hidden: overlayHidden });
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const tryReg = (acc: string, fn: () => void) => {
    try { if (!globalShortcut.register(acc, fn)) log(`hotkey ${acc} is taken by another app`); } catch (e) { log(`hotkey ${acc}: ${(e as Error).message}`); }
  };
  tryReg("F7", () => patchSettings({ mapOpacity: Math.max(0.15, settings.mapOpacity - 0.1) }));
  tryReg("F8", () => patchSettings({ mapOpacity: Math.min(1, settings.mapOpacity + 0.1) }));
  tryReg("F9", () => { overlayInteractive = !overlayInteractive; applyClickThrough(); });
  tryReg("F10", toggleOverlayHidden);
  tryReg("F6", () => dropPing("regroup"));
}

// ── Engine wiring ──────────────────────────────────────────────────────────
function armGame(): void {
  game?.stop();
  game = null;
  const install = settings.installPath;
  const logsDir = install ? logsDirFor(install) : null;
  if (!logsDir) { log("EFT install not found — set it in Setup."); return; }
  game = new GameWatcher({ logsDir });
  game.on("state", (s: GameState) => {
    const before = currentMap()?.key ?? null;
    const raidChanged = s.raid !== gameState.raid;
    gameState = s;
    sender.setInRaid(s.raid === "in-raid");
    const after = currentMap()?.key ?? null;
    if (after !== before) onMapChanged();
    if (s.mapKey && settings.lastMapKey !== s.mapKey) { settings = { ...settings, lastMapKey: s.mapKey }; saveSettings(SETTINGS_FILE(), settings); }
    if (raidChanged) {
      applyClickThrough();
      if (s.raid !== "in-raid") { squadState = { mates: {}, pings: [] }; myPings = []; }
      ensureTagsWindow();
    }
    log(`game: ${s.raid}${s.mapKey ? ` on ${s.mapKey}` : ""}${s.side === "scav" ? " (scav)" : ""}`);
    pushSnapshot();
  });
  game.on("event", (ev: LogEvent) => {
    if (ev.type === "quest") { quests = applyQuestEvent(quests, ev); persistQuests(); pushSnapshot(); }
  });
  game.on("folder", (f: string) => log(`reading ${f}`));
  game.start();
  gameState = game.state;
  log(`watching logs in ${logsDir}`);
  if (Object.keys(quests).length === 0) {
    const hist = scanQuestHistory(logsDir);
    for (const ev of hist) quests = applyQuestEvent(quests, ev);
    if (hist.length) { log(`quest history: ${hist.length} events, ${activeQuestIds(quests).length} active`); persistQuests(); }
  }
}

function onMapChanged(): void {
  lastFix = null;
  trail.length = 0;
  myPings = [];
  mapPayloadCache = { key: null, value: null };
  const m = currentMap();
  if (m) { void ensureTiles(m.key); void ensureRe3mr(m.key); }
  broadcast("map", mapPayloadNow());
}

function armFeed(): void {
  feed?.stop();
  const folder = settings.screenshotsFolder || defaultScreenshotsFolder(myDocuments());
  settings.screenshotsFolder = folder;
  feed = new ScreenshotFeed({ folder, deleteAfterRead: settings.deleteScreenshots });
  feed.on("fix", (fix: PlayerFix) => {
    lastFix = fix;
    trail.push({ x: fix.x, z: fix.z, at: fix.at });
    while (trail.length > 400) trail.shift();
    const map = currentMap();
    const floor = map ? floorForPosition(map, fix.x, fix.y, fix.z)?.name ?? null : null;
    squad?.shareFix({ x: fix.x, y: fix.y, z: fix.z, yaw: fix.yaw, floor });
    for (const r of testWaiters.splice(0)) r(fix);
    pushSnapshot();
  });
  feed.on("swept", (n: number) => log(`screenshots: removed ${n} leftover file(s)`));
  feed.on("error", (e: Error) => log(`screenshots: ${e.message}`));
  feed.start();
  log(`watching screenshots in ${folder}`);
}

function armSender(): void {
  sender.configure({ mode: settings.mode, screenshotKey: settings.screenshotKey, holdKey: settings.holdKey, intervalMs: settings.intervalMs });
  if (settings.mode !== "manual") sender.start();
}

function armSquad(): void {
  if (!settings.squadEnabled || !settings.squadCode.trim() || !settings.playerName.trim()) {
    squad?.stop(); squad = null; squadState = { mates: {}, pings: [] }; ensureTagsWindow(); return;
  }
  if (!squad) {
    squad = new SquadLink(() => ({ name: settings.playerName.trim(), raidId: gameState.raidId }));
    squad.on("update", (s: SquadState) => { squadState = s; ensureTagsWindow(); pushSnapshot(); });
    squad.on("log", (l: string) => log(l));
  }
  squad.start(settings.squadCode);
  log(`squad "${settings.squadCode}" on as ${settings.playerName}`);
}

function dropPing(text: string): void {
  if (!lastFix) return;
  const p: SquadPing = squad?.ping({ x: lastFix.x, y: lastFix.y, z: lastFix.z, text }) ?? { kind: "ping", squad: "", raidId: gameState.raidId ?? "", name: settings.playerName || "me", x: lastFix.x, y: lastFix.y, z: lastFix.z, text, at: Date.now(), ttlMs: 5 * 60000 };
  myPings = [...myPings.filter((q) => q.text !== text), p];
  ensureTagsWindow();
  pushSnapshot();
}

const testWaiters: Array<(fix: PlayerFix) => void> = [];

/** In a raid the game decides; in the menu his pick (or the last map) decides. */
function currentMap(): MapDef | null {
  const key = gameState.raid === "in-raid" && gameState.mapKey ? gameState.mapKey : settings.manualMapKey ?? gameState.mapKey ?? settings.lastMapKey;
  return MAPS.find((m) => m.key === key) ?? null;
}

function persistQuests(): void {
  try { mkdirSync(USER(), { recursive: true }); writeFileSync(QUESTS_FILE(), JSON.stringify(quests)); } catch (e) { log(`quests: ${(e as Error).message}`); }
}

function loadQuests(): void {
  try { if (existsSync(QUESTS_FILE())) quests = JSON.parse(readFileSync(QUESTS_FILE(), "utf8")) as QuestBook; } catch { quests = {}; }
}

// ── tarkov.dev data (markers, quests) ───────────────────────────────────────
let dataTimer: NodeJS.Timeout | null = null;
async function loadData(): Promise<void> {
  features = readCache(FEATURES_FILE()) ?? (existsSync(join(ROOT, "data", "features.json")) ? readCache(join(ROOT, "data", "features.json")) : null);
  tasks = readTaskCache(TASKS_FILE()) ?? (existsSync(join(ROOT, "data", "tasks.json")) ? readTaskCache(join(ROOT, "data", "tasks.json")) : null);
  dataStatus.features = features ? "cached" : "missing";
  dataStatus.tasks = tasks ? "cached" : "missing";
  const staleF = !features || Date.now() - features.fetchedAt > CACHE_TTL_MS;
  const staleT = !tasks || Date.now() - tasks.fetchedAt > CACHE_TTL_MS;
  if (!staleF && !staleT) { dataStatus.features = dataStatus.tasks = "ok"; return; }
  let failed = false;
  if (staleF) {
    try { const maps = await fetchFeatures(); features = { fetchedAt: Date.now(), maps }; writeCache(FEATURES_FILE(), features); dataStatus.features = "ok"; log(`markers refreshed from tarkov.dev (${maps.length} maps)`); mapPayloadCache = { key: null, value: null }; broadcast("map", mapPayloadNow()); }
    catch (e) { failed = true; dataStatus.lastError = (e as Error).message; }
  }
  if (staleT) {
    try { const list = await fetchTasks(); tasks = { fetchedAt: Date.now(), tasks: list }; writeTaskCache(TASKS_FILE(), tasks); dataStatus.tasks = "ok"; log(`quests refreshed from tarkov.dev (${list.length} tasks)`); }
    catch (e) { failed = true; dataStatus.lastError = (e as Error).message; }
  }
  if (failed) {
    dataStatus.nextRetryAt = Date.now() + DATA_RETRY_MS;
    log(`tarkov.dev unavailable (${dataStatus.lastError}) — ${features ? "using cached markers" : "no marker data yet"}; retrying in 15 min`);
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = setTimeout(() => void loadData(), DATA_RETRY_MS);
  } else dataStatus.nextRetryAt = 0;
  pushSnapshot();
}

// ── tile caches ────────────────────────────────────────────────────────────
const tilesDone = new Set<string>();
async function ensureTiles(key: string): Promise<void> {
  if (tilesDone.has(key)) return;
  const map = MAPS.find((m) => m.key === key);
  if (!map) return;
  tilesDone.add(key);
  try {
    const p = await cacheMapTiles(map, TILE_ROOT(), (prog) => { tileProgress[key] = { ...prog }; if (prog.done % 100 === 0 || prog.done === prog.total) broadcast("tiles", tileProgress); });
    tileProgress[key] = p;
    broadcast("tiles", tileProgress);
    if (p.total > 0) log(`tiles: ${key} ${p.done}/${p.total}${p.failed ? ` (${p.failed} failed)` : ""}`);
  } catch (e) { tilesDone.delete(key); log(`tiles: ${key} failed — ${(e as Error).message}`); }
}

async function cacheAllTilesInBackground(): Promise<void> {
  const order = [currentMap()?.key, ...MAPS.map((m) => m.key)].filter((k): k is string => Boolean(k));
  for (const k of [...new Set(order)]) await ensureTiles(k);
}

function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  const walk = (d: string) => {
    let ents: string[];
    try { ents = readdirSync(d); } catch { return; }
    for (const e of ents) {
      const p = join(d, e);
      try { const st = statSync(p); if (st.isDirectory()) walk(p); else { bytes += st.size; files++; } } catch { /* skip */ }
    }
  };
  walk(dir);
  return { bytes, files };
}

// ── RE3MR base ─────────────────────────────────────────────────────────────
const re3mrInFlight = new Set<string>();
async function ensureRe3mr(key: string): Promise<void> {
  const src = sourceFor(key);
  if (!src || re3mrReady.has(key) || re3mrInFlight.has(key)) return;
  const done = pyramidDone(USER(), key);
  if (done) { re3mrReady.set(key, done); broadcast("map", mapPayloadNow()); return; }
  re3mrInFlight.add(key);
  try {
    mkdirSync(RE3MR_DIR(), { recursive: true });
    const file = join(RE3MR_DIR(), src.file);
    if (!existsSync(file) || statSync(file).size < 100000) {
      re3mrProgress[key] = { done: 0, total: 1, stage: "downloading" };
      pushSnapshot();
      log(`re3mr: downloading ${key} render from reemr.se`);
      const res = await fetch(src.url, { headers: { "user-agent": "TarkovMap (personal use; CC BY-NC-SA credit shown)" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.startsWith("image/")) throw new Error(`not an image (${ct})`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    }
    re3mrProgress[key] = { done: 0, total: 1, stage: "slicing" };
    pushSnapshot();
    const r = await slice(USER(), key, file, (d, t) => { re3mrProgress[key] = { done: d, total: t, stage: "slicing" }; if (d % 100 === 0) pushSnapshot(); });
    re3mrReady.set(key, r);
    delete re3mrProgress[key];
    log(`re3mr: ${key} ready (${r.tiles} tiles, ${r.width}×${r.height})`);
    mapPayloadCache = { key: null, value: null };
    broadcast("map", mapPayloadNow());
  } catch (e) {
    re3mrProgress[key] = { done: 0, total: 1, stage: `failed: ${(e as Error).message}` };
    log(`re3mr: ${key} — ${(e as Error).message}`);
  } finally {
    re3mrInFlight.delete(key);
    pushSnapshot();
  }
}

function registrationFor(key: string): Registration | null {
  return loadRegistration(RE3MR_DIR(), key) ?? loadRegistration(join(ROOT, "data", "re3mr"), key);
}

// ── Payloads ───────────────────────────────────────────────────────────────
function mapPayload(map: MapDef | null) {
  if (!map) return null;
  const local: Record<string, string> = {};
  for (const t of tileTemplates(map)) local[t] = localTemplate(TILE_ROOT(), t);
  const reg = registrationFor(map.key);
  const sliced = re3mrReady.get(map.key) ?? null;
  const src = sourceFor(map.key);
  const re3mr = reg && sliced && src ? {
    template: pathToFileURL(join(pyramidDir(USER(), map.key), "{z}", "{x}", "{y}.png")).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"),
    maxZoom: sliced.maxZoom, width: sliced.width, height: sliced.height, affine: reg.affine, errorM: reg.errorM, credit: src.credit,
  } : null;
  return { def: map, svg: map.svgPath ? readSvg(TILE_ROOT(), map.svgPath) : null, localTemplates: local, features: featuresFor(features, map.normalizedName), re3mr, re3mrAvailable: Boolean(src) };
}

let mapPayloadCache: { key: string | null; value: unknown } = { key: null, value: null };
function mapPayloadNow() {
  const map = currentMap();
  if (mapPayloadCache.key !== (map?.key ?? null) || !mapPayloadCache.value) mapPayloadCache = { key: map?.key ?? null, value: mapPayload(map) };
  return mapPayloadCache.value;
}

function snapshot() {
  const map = currentMap();
  const objectives = map && tasks ? objectivesOnMap(quests, tasks.tasks, map.normalizedName, new Set(settings.manualDone)) : [];
  const floor = map && lastFix ? floorForPosition(map, lastFix.x, lastFix.y, lastFix.z)?.name ?? null : null;
  return {
    settings, game: gameState, fix: lastFix, floor, trail: trail.slice(-200), mapKey: map?.key ?? null,
    mapSource: gameState.raid === "in-raid" && gameState.mapKey ? "game" : settings.manualMapKey ? "pick" : "last",
    objectives, activeQuestCount: activeQuestIds(quests).filter((q) => !settings.manualDone.includes(q)).length,
    squad: { ...squadState, pings: [...squadState.pings, ...myPings.filter((p) => p.at + p.ttlMs > Date.now())] },
    maps: MAPS.map((m) => ({ key: m.key, name: m.name, re3mr: Boolean(sourceFor(m.key)), re3mrReady: re3mrReady.has(m.key), registered: Boolean(registrationFor(m.key)) })),
    displays: screen.getAllDisplays().map((d) => ({ id: d.id, label: `${d.label || "Display"} ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? " (main)" : ""}`, primary: d.id === screen.getPrimaryDisplay().id })),
    install: { path: settings.installPath, logsDir: settings.installPath ? logsDirFor(settings.installPath) : null },
    screenshots: feed ? feed.stats() : { files: 0, bytes: 0 },
    tileCache: dirSize(TILE_ROOT()), re3mrCache: dirSize(RE3MR_DIR()), tiles: tileProgress, re3mrProgress,
    data: dataStatus, overlay: { interactive: overlayInteractive, hidden: overlayHidden }, log: logLines.slice(-60),
  };
}

let pushTimer: NodeJS.Timeout | null = null;
function pushSnapshot(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; broadcast("snapshot", snapshot()); }, 40);
}

function patchSettings(patch: Partial<Settings>): void {
  const before = settings;
  const beforeMap = currentMap()?.key ?? null;
  settings = sanitize({ ...settings, ...patch, layers: patch.layers ?? settings.layers, manualDone: patch.manualDone ?? settings.manualDone });
  saveSettings(SETTINGS_FILE(), settings);
  if (before.installPath !== settings.installPath) armGame();
  if (before.screenshotsFolder !== settings.screenshotsFolder || before.deleteScreenshots !== settings.deleteScreenshots) armFeed();
  if (before.mode !== settings.mode || before.screenshotKey !== settings.screenshotKey || before.holdKey !== settings.holdKey || before.intervalMs !== settings.intervalMs) armSender();
  if (before.squadEnabled !== settings.squadEnabled || before.squadCode !== settings.squadCode || before.playerName !== settings.playerName) armSquad();
  if (overlay && (before.overlayDisplayId !== settings.overlayDisplayId || before.overlayScale !== settings.overlayScale || before.minimapSize !== settings.minimapSize || before.corner !== settings.corner || before.margin !== settings.margin)) overlay.setBounds(overlayBounds());
  if (before.bigMapDisplayId !== settings.bigMapDisplayId || before.bigMapEnabled !== settings.bigMapEnabled) { bigmap?.destroy(); bigmap = null; createBigMap(); }
  if (before.showTags !== settings.showTags) ensureTagsWindow();
  if ((currentMap()?.key ?? null) !== beforeMap) onMapChanged();
  else if (before.mapBase !== settings.mapBase || before.mapStyle !== settings.mapStyle) broadcast("map", mapPayloadNow());
  pushSnapshot();
}

// ── IPC ────────────────────────────────────────────────────────────────────
function registerIpc(): void {
  ipcMain.handle("state:get", () => ({ ...snapshot(), map: mapPayloadNow() }));
  ipcMain.handle("map:get", () => mapPayloadNow());
  ipcMain.handle("settings:save", (_e, patch: Partial<Settings>) => { patchSettings(patch); return snapshot(); });
  ipcMain.handle("map:select", (_e, key: string | null) => patchSettings({ manualMapKey: key || null }));
  ipcMain.handle("press", () => { sender.start(); sender.pressOnce(); });
  ipcMain.handle("test:screenshot", () => new Promise<PlayerFix | null>((res) => { const t = setTimeout(() => res(null), 60000); testWaiters.push((fix) => { clearTimeout(t); res(fix); }); }));
  ipcMain.handle("open:folder", (_e, which: string) => {
    const p = which === "screenshots" ? settings.screenshotsFolder : which === "logs" ? (settings.installPath ? logsDirFor(settings.installPath) : null) : which === "tiles" ? TILE_ROOT() : USER();
    if (p && existsSync(p)) void shell.openPath(p);
  });
  ipcMain.handle("open:url", (_e, url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });
  ipcMain.handle("window:control", () => createControl());
  ipcMain.handle("window:bigmap", (_e, show: boolean) => { if (!bigmap) createBigMap(); show ? bigmap?.show() : bigmap?.hide(); });
  ipcMain.handle("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle("window:hide", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.handle("overlay:interactive", (_e, v: boolean) => { overlayInteractive = v; applyClickThrough(); });
  ipcMain.handle("overlay:toggleHidden", () => toggleOverlayHidden());
  ipcMain.handle("app:quit", () => { quitting = true; app.quit(); });
  ipcMain.handle("detect:install", () => detectInstall());
  ipcMain.handle("tiles:fetchAll", () => void cacheAllTilesInBackground());
  ipcMain.handle("tiles:clear", () => { try { rmSync(TILE_ROOT(), { recursive: true, force: true }); tilesDone.clear(); tileProgress = {}; } catch (e) { log(`tiles: ${(e as Error).message}`); } return dirSize(TILE_ROOT()); });
  ipcMain.handle("data:refresh", () => void loadData());
  ipcMain.handle("quest:markDone", (_e, questId: string, done: boolean) => { const set = new Set(settings.manualDone); done ? set.add(questId) : set.delete(questId); patchSettings({ manualDone: [...set] }); });
  ipcMain.handle("quest:list", () => {
    const active = new Set(activeQuestIds(quests));
    return (tasks?.tasks ?? []).filter((t) => active.has(t.id)).map((t) => ({ id: t.id, name: t.name, trader: t.trader, map: t.map?.normalizedName ?? null, done: settings.manualDone.includes(t.id), objectives: t.objectives.map((o) => ({ id: o.id, type: o.type, description: o.description, maps: (o.maps ?? []).map((m) => m.normalizedName) })) }));
  });
  ipcMain.handle("squad:ping", (_e, text: string) => dropPing(String(text).slice(0, 40) || "ping"));
  ipcMain.handle("squad:status", (_e, flag: string) => squad?.status(String(flag).slice(0, 20)));
  ipcMain.handle("filter:prompt", async (_e, sentence: string): Promise<FilterIntent> => {
    const local = parseFilterPrompt(sentence);
    if (local.understood || !settings.openrouterKey) return local;
    return (await askModelForIntent(sentence, settings.openrouterKey, settings.openrouterModel)) ?? local;
  });
  ipcMain.handle("layers:set", (_e, mapKey: string, on: string[]) => patchSettings({ layers: { ...settings.layers, [mapKey]: on } }));
  // RE3MR registration (Align page)
  ipcMain.handle("re3mr:info", (_e, key: string) => {
    const src = sourceFor(key);
    if (!src) return null;
    const file = join(RE3MR_DIR(), src.file);
    const sliced = re3mrReady.get(key) ?? pyramidDone(USER(), key);
    const template = sliced ? pathToFileURL(join(pyramidDir(USER(), key), "{z}", "{x}", "{y}.png")).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}") : null;
    return { key, credit: src.credit, url: src.url, imageUrl: existsSync(file) ? pathToFileURL(file).href : null, template, sliced, registration: registrationFor(key), progress: re3mrProgress[key] ?? null };
  });
  ipcMain.handle("re3mr:prepare", (_e, key: string) => void ensureRe3mr(key));
  ipcMain.handle("re3mr:fit", (_e, key: string, width: number, height: number, points: ControlPoint[]) => {
    try { return register(key, width, height, points); } catch (e) { return { error: (e as Error).message }; }
  });
  ipcMain.handle("re3mr:save", (_e, reg: Registration) => {
    saveRegistration(RE3MR_DIR(), reg);
    log(`re3mr: ${reg.key} registration saved (${reg.points.length} points, ${reg.errorM.toFixed(1)} m)`);
    mapPayloadCache = { key: null, value: null };
    broadcast("map", mapPayloadNow());
    pushSnapshot();
  });
}

// ── Debug capture (TARKOVMAP_SHOT=<dir>) ────────────────────────────────────
function armDebugCapture(): void {
  const dir = process.env.TARKOVMAP_SHOT;
  if (!dir) return;
  const delay = Number(process.env.TARKOVMAP_SHOT_DELAY_MS || 12000);
  setTimeout(async () => {
    mkdirSync(dir, { recursive: true });
    for (const [name, w] of [["overlay", overlay], ["tags", tags], ["bigmap", bigmap], ["control", control]] as Array<[string, BrowserWindow | null]>) {
      if (!w || w.isDestroyed()) continue;
      try {
        if (name === "overlay" || name === "tags") await w.webContents.insertCSS("html{background:#3a3a34 !important}");
        if (name === "control" && process.env.TARKOVMAP_SHOT_SCROLL) { await w.webContents.executeJavaScript(`(function(){const el=document.getElementById(${JSON.stringify(process.env.TARKOVMAP_SHOT_SCROLL)});if(el)el.scrollIntoView({block:"start"});})()`); await new Promise((r) => setTimeout(r, 1500)); }
        const img = await w.webContents.capturePage();
        writeFileSync(join(dir, `${name}.png`), img.toPNG());
        log(`debug: captured ${name}`);
      } catch (e) { log(`debug: ${name} capture failed: ${(e as Error).message}`); }
    }
  }, delay);
}

// ── Boot ───────────────────────────────────────────────────────────────────
const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on("second-instance", createControl);
  app.whenReady().then(() => {
    mkdirSync(USER(), { recursive: true });
    settings = loadSettings(SETTINGS_FILE());
    if (!settings.installPath) { settings.installPath = detectInstall(); if (settings.installPath) log(`found EFT at ${settings.installPath}`); }
    if (!settings.screenshotsFolder) settings.screenshotsFolder = defaultScreenshotsFolder(myDocuments());
    saveSettings(SETTINGS_FILE(), settings);
    loadQuests();
    registerIpc();
    createTray();
    createOverlay();
    createBigMap();
    if (!settings.setupDone || process.env.TARKOVMAP_SHOT) createControl();
    armGame();
    armFeed();
    armSender();
    armSquad();
    registerHotkeys();
    armDebugCapture();
    sender.on("line", (l: string) => { if (l.startsWith("skip-foreground")) broadcast("sender", l); else if (l.startsWith("err")) log(`key: ${l}`); });
    sender.on("log", (l: string) => log(l));
    void loadData();
    const m = currentMap();
    if (m) void ensureRe3mr(m.key);
    void cacheAllTilesInBackground();
    setInterval(() => {
      squad?.prune();
      if (myPings.some((p) => p.at + p.ttlMs <= Date.now())) { myPings = myPings.filter((p) => p.at + p.ttlMs > Date.now()); ensureTagsWindow(); pushSnapshot(); }
    }, 5000);
    setInterval(() => broadcast("tick", { now: Date.now(), screenshots: feed?.stats() ?? { files: 0, bytes: 0 } }), 1000);
  });
  app.on("window-all-closed", () => { /* stay in the tray */ });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("before-quit", () => { quitting = true; game?.stop(); feed?.stop(); sender.stop(); squad?.stop(); });
}
