/**
 * TarkovMap — Electron main process.
 *
 * Three windows:
 *   overlay  — transparent, always-on-top, covers the main display; hosts the
 *              heading-up minimap, the side panel and the in-game tags.
 *              Click-through while a raid is live.
 *   bigmap   — the full map on the second display (or F9 on the main one).
 *   control  — the settings / squad / quests app with a left rail.
 *
 * It never touches the game: it reads the game's own log files and the
 * screenshot folder, and (hold/timer mode) sends one keypress to the game.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER = () => app.getPath("userData");
const SETTINGS_FILE = () => join(USER(), "settings.json");
const TILE_ROOT = () => join(USER(), "tiles");
const FEATURES_FILE = () => join(USER(), "features.json");
const TASKS_FILE = () => join(USER(), "tasks.json");
const QUESTS_FILE = () => join(USER(), "quests.json");

const MAPS: MapDef[] = interactiveMaps(JSON.parse(readFileSync(join(ROOT, "data", "maps.json"), "utf8")));

let overlay: BrowserWindow | null = null;
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
let quests: QuestBook = {};
let squad: SquadLink | null = null;
let squadState: SquadState = { mates: {}, pings: [] };
let myPings: SquadPing[] = [];
let tileProgress: Record<string, FetchProgress> = {};
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

function broadcast(channel: string, payload: unknown): void {
  for (const w of [overlay, bigmap, control]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
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

function createOverlay(): void {
  const d = overlayDisplay();
  overlay = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false, backgroundThrottling: false },
  });
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

/** Renderer console → main log, so a broken page is visible from outside. */
function wireConsole(w: BrowserWindow, name: string): void {
  w.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) log(`${name}: ${message} (${source.split(/[\\/]/).pop()}:${line})`);
  });
}

function applyClickThrough(): void {
  if (!overlay) return;
  // The overlay covers the whole display, so it must NEVER hold the mouse
  // unless he asked for it (F9). `clickThroughInRaid` only decides whether
  // F9's interactive mode is allowed to persist into a raid.
  const passthrough = !overlayInteractive || (gameState.raid === "in-raid" && settings.clickThroughInRaid && !overlayInteractive);
  overlay.setIgnoreMouseEvents(passthrough, { forward: true });
  overlay.setFocusable(overlayInteractive);
  if (overlayInteractive) overlay.focus();
  broadcast("overlay-mode", { interactive: overlayInteractive, hidden: overlayHidden });
}

function createBigMap(): void {
  const d = bigMapDisplay();
  if (!d || !settings.bigMapEnabled) return;
  bigmap = new BrowserWindow({
    x: d.workArea.x,
    y: d.workArea.y,
    width: d.workArea.width,
    height: d.workArea.height,
    frame: false,
    backgroundColor: "#0b0c0e",
    show: false,
    skipTaskbar: false,
    title: "TarkovMap — full map",
    icon: iconPath(),
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false, backgroundThrottling: false },
  });
  bigmap.setMenuBarVisibility(false);
  bigmap.loadFile(resolve(ROOT, "renderer", "bigmap.html"));
  bigmap.once("ready-to-show", () => bigmap?.showInactive());
  bigmap.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      bigmap?.hide();
    }
  });
  bigmap.on("closed", () => (bigmap = null));
  wireConsole(bigmap, "bigmap");
}

function createControl(): void {
  if (control) {
    control.show();
    control.focus();
    return;
  }
  const d = overlayDisplay();
  control = new BrowserWindow({
    width: 1040,
    height: 720,
    x: d.workArea.x + Math.round((d.workArea.width - 1040) / 2),
    y: d.workArea.y + Math.round((d.workArea.height - 720) / 2),
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0b0c0e",
    title: "TarkovMap",
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false },
  });
  control.loadFile(resolve(ROOT, "renderer", "control.html"));
  control.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      control?.hide();
    }
  });
  control.on("closed", () => (control = null));
  wireConsole(control, "control");
  control.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function iconPath(): string {
  return resolve(ROOT, "build", "icon.png");
}

function createTray(): void {
  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip("TarkovMap");
  tray.on("double-click", createControl);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open TarkovMap", click: createControl },
      { label: "Show / hide overlay (F10)", click: toggleOverlayHidden },
      { label: "Full map window", click: () => { if (!bigmap) createBigMap(); bigmap?.show(); } },
      { type: "separator" },
      { label: "Quit", click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

// ── Hotkeys ────────────────────────────────────────────────────────────────
function toggleOverlayHidden(): void {
  overlayHidden = !overlayHidden;
  if (overlay) overlayHidden ? overlay.hide() : overlay.showInactive();
  broadcast("overlay-mode", { interactive: overlayInteractive, hidden: overlayHidden });
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const tryReg = (acc: string, fn: () => void) => {
    try {
      if (!globalShortcut.register(acc, fn)) log(`hotkey ${acc} is taken by another app`);
    } catch (e) {
      log(`hotkey ${acc}: ${(e as Error).message}`);
    }
  };
  tryReg("F7", () => patchSettings({ mapOpacity: Math.max(0.15, settings.mapOpacity - 0.1) }));
  tryReg("F8", () => patchSettings({ mapOpacity: Math.min(1, settings.mapOpacity + 0.1) }));
  tryReg("F9", () => {
    overlayInteractive = !overlayInteractive;
    applyClickThrough();
  });
  tryReg("F10", toggleOverlayHidden);
  tryReg("F6", () => dropPing("regroup"));
}

// ── Engine wiring ──────────────────────────────────────────────────────────
function armGame(): void {
  game?.stop();
  game = null;
  const install = settings.installPath;
  const logsDir = install ? logsDirFor(install) : null;
  if (!logsDir) {
    log("EFT install not found — set it in Setup.");
    return;
  }
  game = new GameWatcher({ logsDir });
  game.on("state", (s: GameState) => {
    const mapChanged = s.mapKey !== gameState.mapKey;
    const raidChanged = s.raid !== gameState.raid;
    gameState = s;
    sender.setInRaid(s.raid === "in-raid");
    if (mapChanged) {
      lastFix = null;
      trail.length = 0;
      myPings = [];
      mapPayloadCache = { key: null, value: null };
      if (s.mapKey) {
        void ensureTiles(s.mapKey);
        if (settings.lastMapKey !== s.mapKey) {
          settings = { ...settings, lastMapKey: s.mapKey };
          saveSettings(SETTINGS_FILE(), settings);
        }
      }
    }
    if (raidChanged) {
      applyClickThrough();
      if (s.raid !== "in-raid") {
        squadState = { mates: {}, pings: [] };
        myPings = [];
      }
    }
    log(`game: ${s.raid}${s.mapKey ? ` on ${s.mapKey}` : ""}${s.side === "scav" ? " (scav)" : ""}`);
    pushSnapshot();
  });
  game.on("event", (ev: LogEvent) => {
    if (ev.type === "quest") {
      quests = applyQuestEvent(quests, ev);
      persistQuests();
      pushSnapshot();
    }
  });
  game.on("folder", (f: string) => log(`reading ${f}`));
  game.start();
  gameState = game.state;
  log(`watching logs in ${logsDir}`);
  // One-time history seed so started-not-finished quests are known on first run.
  if (Object.keys(quests).length === 0) {
    const hist = scanQuestHistory(logsDir);
    for (const ev of hist) quests = applyQuestEvent(quests, ev);
    if (hist.length) {
      log(`quest history: ${hist.length} events, ${activeQuestIds(quests).length} active`);
      persistQuests();
    }
  }
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
    squad?.stop();
    squad = null;
    squadState = { mates: {}, pings: [] };
    return;
  }
  if (!squad) {
    squad = new SquadLink(() => ({ name: settings.playerName.trim(), raidId: gameState.raidId }));
    squad.on("update", (s: SquadState) => {
      squadState = s;
      pushSnapshot();
    });
    squad.on("log", (l: string) => log(l));
  }
  squad.start(settings.squadCode);
  log(`squad "${settings.squadCode}" on as ${settings.playerName}`);
}

function dropPing(text: string): void {
  if (!lastFix) return;
  const p: SquadPing = squad?.ping({ x: lastFix.x, y: lastFix.y, z: lastFix.z, text }) ?? {
    kind: "ping", squad: "", raidId: gameState.raidId ?? "", name: settings.playerName || "me", x: lastFix.x, y: lastFix.y, z: lastFix.z, text, at: Date.now(), ttlMs: 5 * 60000,
  };
  myPings = [...myPings.filter((q) => q.text !== text), p];
  pushSnapshot();
}

const testWaiters: Array<(fix: PlayerFix) => void> = [];

/** The game's map when it has one, else the last one it had (or the manual pick). */
function currentMap(): MapDef | null {
  const key = gameState.mapKey ?? settings.lastMapKey;
  return MAPS.find((m) => m.key === key) ?? null;
}

function persistQuests(): void {
  try {
    mkdirSync(USER(), { recursive: true });
    writeFileSync(QUESTS_FILE(), JSON.stringify(quests));
  } catch (e) {
    log(`quests: ${(e as Error).message}`);
  }
}

function loadQuests(): void {
  try {
    if (existsSync(QUESTS_FILE())) quests = JSON.parse(readFileSync(QUESTS_FILE(), "utf8")) as QuestBook;
  } catch {
    quests = {};
  }
}

async function loadFeatures(): Promise<void> {
  features = readCache(FEATURES_FILE()) ?? (existsSync(join(ROOT, "data", "features.json")) ? readCache(join(ROOT, "data", "features.json")) : null);
  const stale = !features || Date.now() - features.fetchedAt > CACHE_TTL_MS;
  if (!stale) return;
  try {
    const maps = await fetchFeatures();
    features = { fetchedAt: Date.now(), maps };
    writeCache(FEATURES_FILE(), features);
    log(`markers refreshed from tarkov.dev (${maps.length} maps)`);
    pushSnapshot();
  } catch (e) {
    log(`tarkov.dev markers unavailable (${(e as Error).message}) — ${features ? "using cached" : "retrying hourly"}`);
    setTimeout(() => void loadFeatures(), 3600 * 1000);
  }
}

async function loadTasks(): Promise<void> {
  tasks = readTaskCache(TASKS_FILE()) ?? (existsSync(join(ROOT, "data", "tasks.json")) ? readTaskCache(join(ROOT, "data", "tasks.json")) : null);
  const stale = !tasks || Date.now() - tasks.fetchedAt > CACHE_TTL_MS;
  if (!stale) return;
  try {
    const list = await fetchTasks();
    tasks = { fetchedAt: Date.now(), tasks: list };
    writeTaskCache(TASKS_FILE(), tasks);
    log(`quests refreshed from tarkov.dev (${list.length} tasks)`);
    pushSnapshot();
  } catch (e) {
    log(`tarkov.dev quests unavailable (${(e as Error).message}) — ${tasks ? "using cached" : "retrying hourly"}`);
    setTimeout(() => void loadTasks(), 3600 * 1000);
  }
}

const tilesDone = new Set<string>();
async function ensureTiles(key: string): Promise<void> {
  if (tilesDone.has(key)) return;
  const map = MAPS.find((m) => m.key === key);
  if (!map) return;
  tilesDone.add(key);
  try {
    const p = await cacheMapTiles(map, TILE_ROOT(), (prog) => {
      tileProgress[key] = { ...prog };
      if (prog.done % 100 === 0 || prog.done === prog.total) broadcast("tiles", tileProgress);
    });
    tileProgress[key] = p;
    broadcast("tiles", tileProgress);
    if (p.total > 0) log(`tiles: ${key} ${p.done}/${p.total}${p.failed ? ` (${p.failed} failed)` : ""}`);
  } catch (e) {
    tilesDone.delete(key);
    log(`tiles: ${key} failed — ${(e as Error).message}`);
  }
}

async function cacheAllTilesInBackground(): Promise<void> {
  const order = [gameState.mapKey, ...MAPS.map((m) => m.key)].filter((k): k is string => Boolean(k));
  for (const k of [...new Set(order)]) await ensureTiles(k);
}

function tileCacheSize(): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  const walk = (dir: string) => {
    let ents: string[];
    try {
      ents = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else {
          bytes += st.size;
          files++;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(TILE_ROOT());
  return { bytes, files };
}

// ── Snapshot ───────────────────────────────────────────────────────────────
function mapPayload(map: MapDef | null) {
  if (!map) return null;
  const local: Record<string, string> = {};
  for (const t of tileTemplates(map)) local[t] = localTemplate(TILE_ROOT(), t);
  return {
    def: map,
    svg: map.svgPath ? readSvg(TILE_ROOT(), map.svgPath) : null,
    localTemplates: local,
    features: featuresFor(features, map.normalizedName),
  };
}

let mapPayloadCache: { key: string | null; value: unknown } = { key: null, value: null };

function snapshot() {
  const map = currentMap();
  if (mapPayloadCache.key !== (map?.key ?? null) || !mapPayloadCache.value) {
    mapPayloadCache = { key: map?.key ?? null, value: mapPayload(map) };
  }
  const objectives = map && tasks ? objectivesOnMap(quests, tasks.tasks, map.normalizedName, new Set(settings.manualDone)) : [];
  const floor = map && lastFix ? floorForPosition(map, lastFix.x, lastFix.y, lastFix.z)?.name ?? null : null;
  return {
    settings,
    game: gameState,
    fix: lastFix,
    floor,
    trail: trail.slice(-200),
    map: mapPayloadCache.value,
    objectives,
    activeQuestCount: activeQuestIds(quests).filter((q) => !settings.manualDone.includes(q)).length,
    squad: { ...squadState, pings: [...squadState.pings, ...myPings.filter((p) => p.at + p.ttlMs > Date.now())] },
    maps: MAPS.map((m) => ({ key: m.key, name: m.name })),
    displays: screen.getAllDisplays().map((d) => ({ id: d.id, label: `${d.label || "Display"} ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? " (main)" : ""}`, primary: d.id === screen.getPrimaryDisplay().id })),
    install: { path: settings.installPath, logsDir: settings.installPath ? logsDirFor(settings.installPath) : null },
    screenshots: feed ? feed.stats() : { files: 0, bytes: 0 },
    tileCache: tileCacheSize(),
    tiles: tileProgress,
    hasFeatures: Boolean(features),
    hasTasks: Boolean(tasks),
    overlay: { interactive: overlayInteractive, hidden: overlayHidden },
    log: logLines.slice(-60),
  };
}

let pushTimer: NodeJS.Timeout | null = null;
function pushSnapshot(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    broadcast("snapshot", snapshot());
  }, 40);
}

function patchSettings(patch: Partial<Settings>): void {
  const before = settings;
  settings = sanitize({ ...settings, ...patch, layers: patch.layers ?? settings.layers, manualDone: patch.manualDone ?? settings.manualDone });
  saveSettings(SETTINGS_FILE(), settings);
  if (before.installPath !== settings.installPath) armGame();
  if (before.screenshotsFolder !== settings.screenshotsFolder || before.deleteScreenshots !== settings.deleteScreenshots) armFeed();
  if (before.mode !== settings.mode || before.screenshotKey !== settings.screenshotKey || before.holdKey !== settings.holdKey || before.intervalMs !== settings.intervalMs) armSender();
  if (before.squadEnabled !== settings.squadEnabled || before.squadCode !== settings.squadCode || before.playerName !== settings.playerName) armSquad();
  if (before.clickThroughInRaid !== settings.clickThroughInRaid) applyClickThrough();
  if (before.overlayDisplayId !== settings.overlayDisplayId && overlay) {
    const d = overlayDisplay();
    overlay.setBounds(d.bounds);
  }
  if ((before.bigMapDisplayId !== settings.bigMapDisplayId || before.bigMapEnabled !== settings.bigMapEnabled)) {
    bigmap?.destroy();
    bigmap = null;
    createBigMap();
  }
  pushSnapshot();
}

// ── IPC ────────────────────────────────────────────────────────────────────
function registerIpc(): void {
  ipcMain.handle("state:get", () => snapshot());
  ipcMain.handle("settings:save", (_e, patch: Partial<Settings>) => {
    patchSettings(patch);
    return snapshot();
  });
  ipcMain.handle("press", () => {
    sender.start();
    sender.pressOnce();
  });
  ipcMain.handle("test:screenshot", () =>
    new Promise<PlayerFix | null>((res) => {
      const t = setTimeout(() => res(null), 60000);
      testWaiters.push((fix) => {
        clearTimeout(t);
        res(fix);
      });
    }),
  );
  ipcMain.handle("open:folder", (_e, which: "screenshots" | "logs" | "tiles" | "data") => {
    const p = which === "screenshots" ? settings.screenshotsFolder : which === "logs" ? (settings.installPath ? logsDirFor(settings.installPath) : null) : which === "tiles" ? TILE_ROOT() : USER();
    if (p && existsSync(p)) void shell.openPath(p);
  });
  ipcMain.handle("open:url", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle("window:control", () => createControl());
  ipcMain.handle("window:bigmap", (_e, show: boolean) => {
    if (!bigmap) createBigMap();
    show ? bigmap?.show() : bigmap?.hide();
  });
  ipcMain.handle("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle("window:hide", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.handle("overlay:interactive", (_e, v: boolean) => {
    overlayInteractive = v;
    applyClickThrough();
  });
  ipcMain.handle("overlay:toggleHidden", () => toggleOverlayHidden());
  ipcMain.handle("app:quit", () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle("detect:install", () => detectInstall());
  ipcMain.handle("tiles:fetchAll", () => void cacheAllTilesInBackground());
  ipcMain.handle("tiles:clear", () => {
    try {
      rmSync(TILE_ROOT(), { recursive: true, force: true });
      tilesDone.clear();
      tileProgress = {};
    } catch (e) {
      log(`tiles: ${(e as Error).message}`);
    }
    return tileCacheSize();
  });
  ipcMain.handle("quest:markDone", (_e, questId: string, done: boolean) => {
    const set = new Set(settings.manualDone);
    done ? set.add(questId) : set.delete(questId);
    patchSettings({ manualDone: [...set] });
  });
  ipcMain.handle("quest:list", () => {
    const active = new Set(activeQuestIds(quests));
    return (tasks?.tasks ?? [])
      .filter((t) => active.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, trader: t.trader, map: t.map?.normalizedName ?? null, done: settings.manualDone.includes(t.id), objectives: t.objectives.map((o) => ({ id: o.id, type: o.type, description: o.description, maps: (o.maps ?? []).map((m) => m.normalizedName) })) }));
  });
  ipcMain.handle("squad:ping", (_e, text: string) => dropPing(String(text).slice(0, 40) || "ping"));
  ipcMain.handle("squad:status", (_e, flag: string) => squad?.status(String(flag).slice(0, 20)));
  ipcMain.handle("filter:prompt", async (_e, sentence: string): Promise<FilterIntent> => {
    const local = parseFilterPrompt(sentence);
    if (local.understood || !settings.openrouterKey) return local;
    const viaModel = await askModelForIntent(sentence, settings.openrouterKey, settings.openrouterModel);
    return viaModel ?? local;
  });
  ipcMain.handle("map:select", (_e, key: string | null) => {
    mapPayloadCache = { key: null, value: null };
    patchSettings({ lastMapKey: key && MAPS.some((m) => m.key === key) ? key : null });
    if (key) void ensureTiles(key);
  });
  ipcMain.handle("layers:set", (_e, mapKey: string, on: string[]) => {
    patchSettings({ layers: { ...settings.layers, [mapKey]: on } });
  });
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
    if (!settings.installPath) {
      settings.installPath = detectInstall();
      if (settings.installPath) log(`found EFT at ${settings.installPath}`);
    }
    if (!settings.screenshotsFolder) settings.screenshotsFolder = defaultScreenshotsFolder(myDocuments());
    saveSettings(SETTINGS_FILE(), settings);
    loadQuests();
    registerIpc();
    createTray();
    createOverlay();
    createBigMap();
    if (!settings.setupDone) createControl();
    armGame();
    armFeed();
    armSender();
    armSquad();
    registerHotkeys();
    sender.on("line", (l: string) => {
      if (l.startsWith("skip-foreground")) broadcast("sender", l);
      else if (l.startsWith("err")) log(`key: ${l}`);
    });
    sender.on("log", (l: string) => log(l));
    void loadFeatures();
    void loadTasks();
    void cacheAllTilesInBackground();
    setInterval(() => {
      squad?.prune();
      if (myPings.some((p) => p.at + p.ttlMs <= Date.now())) {
        myPings = myPings.filter((p) => p.at + p.ttlMs > Date.now());
        pushSnapshot();
      }
    }, 5000);
    setInterval(() => broadcast("tick", { now: Date.now(), screenshots: feed?.stats() ?? { files: 0, bytes: 0 } }), 1000);
    // Debug: TARKOVMAP_SHOT=<dir> captures every window to PNG after boot so a
    // session can verify the build without touching the desktop.
    const shotDir = process.env.TARKOVMAP_SHOT;
    if (shotDir) {
      setTimeout(async () => {
        for (const [name, w] of [["overlay", overlay], ["bigmap", bigmap], ["control", control]] as const) {
          if (!w || w.isDestroyed()) continue;
          try {
            if (name === "overlay") await w.webContents.insertCSS("html{background:#3a3a34 !important}");
            const img = await w.webContents.capturePage();
            writeFileSync(join(shotDir, `${name}.png`), img.toPNG());
            log(`debug: captured ${name}`);
          } catch (e) {
            log(`debug: capture ${name} failed: ${(e as Error).message}`);
          }
        }
      }, Number(process.env.TARKOVMAP_SHOT_DELAY_MS || 9000));
    }
  });
  app.on("window-all-closed", () => {
    /* stay in the tray */
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("before-quit", () => {
    quitting = true;
    game?.stop();
    feed?.stop();
    sender.stop();
    squad?.stop();
  });
}
