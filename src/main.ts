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
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { floorForPosition, interactiveMaps, type MapDef } from "./map-data.js";
import { GameWatcher, INITIAL_STATE, logsDirFor, scanQuestHistory, type GameState, type LogEvent } from "./game-watcher.js";
import { ScreenshotFeed, type PlayerFix } from "./screenshot-feed.js";
import { KeySender, vkFor } from "./key-sender.js";
import { progression, whyContext, whyItMatters } from "./progression.js";
import { execFile } from "node:child_process";
import { DEFAULT_SETTINGS, arenaScreenshotsFolder, defaultScreenshotsFolder, isMouseAccel, loadSettings, sanitize, saveSettings, type Settings } from "./settings.js";
import { detectInstall, myDocuments } from "./install.js";
import { CACHE_TTL_MS, featuresFor, fetchFeatures, readCache, writeCache, type FeatureCache } from "./map-features.js";
import { cacheMapTiles, localTemplate, readSvg, tileTemplates, type FetchProgress } from "./tiles.js";
import { activeQuestIds, applyQuestEvent, fetchTasks, objectivesOnMap, readTaskCache, TASK_CACHE_VERSION, writeTaskCache, type QuestBook, type TaskCache } from "./quests.js";
import { convertJsonMaps, convertJsonTasks, fetchJson, type JsonMapsPayload, type JsonTasksPayload, type Names } from "./tarkov-json.js";
import { lootHeat, lootPoints } from "./loot-value.js";
import { allObjectivesOnMap, questStates, readProgress, setObjective, tickExtract, tickVisits, writeProgress, type QuestProgress, type QuestState } from "./quest-status.js";
import { questItemMarkers } from "./quest-items.js";
import { SquadLink, type SquadPing, type SquadState } from "./squad.js";
import { askModelForIntent, parseFilterPrompt, type FilterIntent } from "./filter-prompt.js";
import { loadRegistration, register, saveRegistration, sourceFor, SOURCES, type ControlPoint, type Registration } from "./re3mr.js";
import { pyramidDir, pyramidDone, slice, type SliceResult } from "./re3mr-slicer.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.TARKOVMAP_USERDATA) app.setPath("userData", process.env.TARKOVMAP_USERDATA);
/** Debug captures without a single window on screen (offscreen rendering, no tray hooks, no key sender). */
const HEADLESS = Boolean(process.env.TARKOVMAP_SHOT) && process.env.TARKOVMAP_SHOT_HIDDEN === "1";
const USER = () => app.getPath("userData");
const SETTINGS_FILE = () => join(USER(), "settings.json");
const TILE_ROOT = () => join(USER(), "tiles");
const FEATURES_FILE = () => join(USER(), "features.json");
const TASKS_FILE = () => join(USER(), "tasks.json");
const QUESTS_FILE = () => join(USER(), "quests.json");
const PROGRESS_FILE = () => join(USER(), "quest-progress.json");
const RE3MR_DIR = () => join(USER(), "re3mr");
const DATA_RETRY_MS = 15 * 60 * 1000;

const MAPS: MapDef[] = interactiveMaps(JSON.parse(readFileSync(join(ROOT, "data", "maps.json"), "utf8")));

let overlay: BrowserWindow | null = null;
let tags: BrowserWindow | null = null;
let bigmap: BrowserWindow | null = null;
let control: BrowserWindow | null = null;
let bigmapDismissed = false;
let tray: Tray | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let game: GameWatcher | null = null;
let feed: ScreenshotFeed | null = null;
/** Arena writes its screenshots to its own Documents folder; watched only when that folder exists. */
let arenaFeed: ScreenshotFeed | null = null;
const sender = new KeySender();
let lastFix: PlayerFix | null = null;
const trail: Array<{ x: number; z: number; at: number }> = [];
let gameState: GameState = { ...INITIAL_STATE };
let features: FeatureCache | null = null;
let tasks: TaskCache | null = null;
let dataStatus = { features: "missing" as "ok" | "missing" | "cached" | "offline", tasks: "missing" as "ok" | "missing" | "cached" | "offline", lastError: "", nextRetryAt: 0 };
let quests: QuestBook = {};
let progress: QuestProgress = { version: 1, done: {} };
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
/** Timestamps every link of the chain leaves behind, for the health card and health.json. */
const health = { helperAt: 0, sentAt: 0, sent: [] as number[], fileAt: 0, unparsedAt: 0, lastFile: "", fixAt: 0, skipAt: 0, skipApp: "" };
/** Windows' "Print screen opens Snipping Tool" switch: true/false when the registry says, null when unset (Windows 11 default = on). */
let printScreenSnipping: boolean | null = null;
function readPrintScreenSnipping(): void {
  execFile("reg", ["query", "HKCU\\Control Panel\\Keyboard", "/v", "PrintScreenKeyForSnippingEnabled"], { windowsHide: true }, (err, out) => {
    if (err) { printScreenSnipping = null; return; }
    const m = /0x([0-9a-f]+)/i.exec(out);
    printScreenSnipping = m ? parseInt(m[1], 16) !== 0 : null;
  });
}
/** Print Screen never reaches the game while Windows hands it to Snipping Tool (unset = Windows 11 default, on). */
const printScreenBlocked = () => printScreenSnipping !== false;

export interface HealthRow { id: string; ok: boolean | null; label: string; detail: string }
function healthRows(): HealthRow[] {
  const now = Date.now();
  const age = (t: number) => (t ? Math.round((now - t) / 1000) : -1);
  const ago = (t: number) => (t ? `${age(t)} s ago` : "never");
  const rows: HealthRow[] = [];
  const helperOk = health.helperAt > 0 && now - health.helperAt < 8000;
  rows.push({ id: "helper", ok: helperOk, label: "Key helper", detail: helperOk ? "alive, polling" : health.helperAt ? `silent for ${age(health.helperAt)} s` : "not started" });
  rows.push({ id: "game", ok: gameRunning === true, label: "Tarkov running", detail: gameRunning === true ? "EscapeFromTarkov process found" : gameRunning === false ? "not running" : "checking…" });
  const front = GAME_PROCESSES.has(foregroundApp);
  rows.push({ id: "front", ok: gameRunning ? front : null, label: "Tarkov in front", detail: front ? "yes" : foregroundApp ? `no — ${foregroundApp} is the active window` : "unknown" });
  const bind = gameState.screenshotBind, raw = gameState.screenshotBindRaw;
  let bindOk: boolean | null = null, bindDetail = "waiting for the game to log its keybinds (it does at start)";
  if (raw != null) {
    if (!bind) { bindOk = false; bindDetail = `Tarkov's Make screenshot is "${raw}" — a combo the app cannot press. Rebind it to a single key like F11 in Tarkov ▸ Settings ▸ Controls.`; }
    else if (bind === "PrintScreen" && printScreenBlocked()) { bindOk = false; bindDetail = `Tarkov's Make screenshot is Print Screen, and Windows hands Print Screen to Snipping Tool before the game sees it. Rebind Make screenshot to F11 in Tarkov ▸ Settings ▸ Controls (20 seconds, once), or switch off "Use the Print screen key to open screen capture" in Windows Settings ▸ Accessibility ▸ Keyboard.`; }
    else if (bind !== settings.screenshotKey) { bindOk = false; bindDetail = `Tarkov has ${bind}, the app presses ${settings.screenshotKey}`; }
    else { bindOk = true; bindDetail = `${bind} — read from the game's own log`; }
  }
  rows.push({ id: "bind", ok: bindOk, label: "Screenshot key", detail: bindDetail });
  const recent = health.sent.filter((t) => now - t < 30000).length;
  const pressOk = settings.mode === "manual" ? null : recent > 0 ? true : front ? false : null;
  rows.push({ id: "press", ok: pressOk, label: "Presses sent", detail: settings.mode === "manual" ? "manual mode — you press the key yourself" : recent ? `${recent} in the last 30 s, last ${ago(health.sentAt)}` : front ? `none in 30 s (mode ${settings.mode})${health.skipAt && now - health.skipAt < 30000 ? ` — skipped, ${health.skipApp} was in front` : ""}` : "waiting for Tarkov in front" });
  const fileOk = health.fileAt ? now - health.fileAt < 60000 : null;
  rows.push({ id: "file", ok: recent ? Boolean(fileOk) : fileOk, label: "Screenshot files", detail: health.fileAt ? `last ${ago(health.fileAt)}${health.unparsedAt > health.fixAt ? " — but the name carried no position (not the game's format?)" : ""}` : recent ? "none appeared after the presses — the game is not taking screenshots on that key" : "none yet" });
  const fixOk = health.fixAt ? now - health.fixAt < 60000 : null;
  rows.push({ id: "fix", ok: health.fileAt ? fixOk : null, label: "Position", detail: lastFix ? `${ago(health.fixAt)} · x ${lastFix.x.toFixed(0)} z ${lastFix.z.toFixed(0)}` : "no fix yet" });
  const logAge = game?.lastLogAt ? age(game.lastLogAt) : -1;
  const mapOk = gameState.mapKey ? true : game ? (gameRunning ? false : null) : false;
  rows.push({ id: "map", ok: mapOk, label: "Map from the log", detail: game ? `${gameState.mapKey ?? "unknown"} · ${gameState.raid}${logAge >= 0 ? ` · log line ${logAge} s old` : " · no log lines read"}` : "log folder not found — set the install path in Setup" });
  const ovVis = Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
  rows.push({ id: "minimap", ok: overlayHidden ? false : ovVis ? true : front ? false : null, label: "Minimap window", detail: overlayHidden ? "hidden by you (Show minimap)" : ovVis ? "on screen" : settings.overlayOnlyInGame ? "waits for Tarkov in front" : "not shown" });
  const bigVis = Boolean(bigmap && !bigmap.isDestroyed() && bigmap.isVisible());
  rows.push({ id: "bigmap", ok: bigVis ? true : settings.bigMapEnabled ? (gameRunning ? false : null) : null, label: "Full map window", detail: bigVis ? "open" : bigmapDismissed ? "closed by you (Open full map)" : settings.bigMapEnabled ? "waits for Tarkov" : "off in Setup" });
  return rows;
}
function writeHealth(): void {
  try { writeFileSync(join(USER(), "health.json"), JSON.stringify({ at: Date.now(), version: app.getVersion(), rows: healthRows(), state: { mode: settings.mode, screenshotKey: settings.screenshotKey, bind: gameState.screenshotBind ?? null, bindRaw: gameState.screenshotBindRaw ?? null, printScreenSnipping, foregroundApp, gameRunning, raid: gameState.raid, mapKey: gameState.mapKey, fix: lastFix ? { x: lastFix.x, y: lastFix.y, z: lastFix.z, at: lastFix.at } : null } }, null, 1)); } catch { /* disk */ }
}
/** Press once and watch the chain for up to 6 s: which link answered. */
async function healthTest(): Promise<{ sent: boolean; file: boolean; fix: boolean; rows: HealthRow[] }> {
  const t0 = Date.now();
  sender.start();
  sender.pressOnce();
  const until = t0 + 6000;
  while (Date.now() < until && !(health.fixAt > t0)) await new Promise((r) => setTimeout(r, 200));
  return { sent: health.sentAt >= t0, file: health.fileAt >= t0, fix: health.fixAt >= t0, rows: healthRows() };
}

/** Foreground process name from the key helper ("fg <name>"); "" until the first report. */
let foregroundApp = "";
/** Tarkov / Arena process exists (key helper "game 1|0"); null until the first report. */
let gameRunning: boolean | null = null;
/** Started by Windows at login (or with --tray): no settings window, wait in the tray for the game. */
const TRAY_START = process.argv.includes("--tray") || /--tray/.test(process.env.TARKOVMAP_ARGS || "") || Boolean(app.getLoginItemSettings?.().wasOpenedAtLogin);
function bigMapWanted(): boolean {
  if (!settings.bigMapEnabled || bigmapDismissed) return false;
  if (!settings.overlayOnlyInGame) return true;
  return gameRunning === true;
}
const GAME_PROCESSES = new Set(["EscapeFromTarkov", "EscapeFromTarkovArena", "EscapeFromTarkov_BE", "EscapeFromTarkovArena_BE"]);
/** The overlay is on screen only when he has not hidden it AND (the game is in front, or the gate is off). */
function overlayWanted(): boolean {
  if (overlayHidden) return false;
  if (!settings.overlayOnlyInGame) return true;
  return GAME_PROCESSES.has(foregroundApp);
}
function applyOverlayVisibility(): void {
  if (HEADLESS) return;
  const want = overlayWanted();
  for (const w of [overlay, tags]) {
    if (!w || w.isDestroyed()) continue;
    if (want && !w.isVisible()) w.showInactive();
    else if (!want && w.isVisible()) w.hide();
  }
  if (bigmap && !bigmap.isDestroyed()) {
    const wantBig = bigMapWanted();
    if (wantBig && !bigmap.isVisible()) bigmap.showInactive();
    else if (!wantBig && bigmap.isVisible()) bigmap.hide();
  }
}

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
const WEB = () => ({ preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false, backgroundThrottling: false, offscreen: HEADLESS });

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
    applyOverlayVisibility();
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
    tags.setIgnoreMouseEvents(true);
    tags.setMenuBarVisibility(false);
    tags.loadFile(resolve(ROOT, "renderer", "overlay.html"), { query: { mode: "tags" } });
    tags.once("ready-to-show", () => applyOverlayVisibility());
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
  overlay.setIgnoreMouseEvents(!overlayInteractive);
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
  // ready-to-show is not reliable for a never-shown window on a second display (seen 2026-09-05: the
  // window existed, vis=False, no error). Show on whichever fires first, and once more after load.
  const reveal = () => { if (!HEADLESS && bigmap && !bigmap.isDestroyed() && !bigmap.isVisible() && bigMapWanted()) bigmap.showInactive(); };
  bigmap.once("ready-to-show", reveal);
  bigmap.webContents.once("did-finish-load", () => setTimeout(reveal, 400));
  setTimeout(reveal, 4000);
  bigmap.on("close", (e) => { if (!quitting) { e.preventDefault(); bigmapDismissed = true; bigmap?.hide(); } });
  bigmap.on("closed", () => (bigmap = null));
  wireConsole(bigmap, "bigmap");
}

function createControl(): void {
  if (control) { control.show(); control.focus(); return; }
  const d = overlayDisplay();
  control = new BrowserWindow({ width: 1100, height: 760, x: d.workArea.x + Math.round((d.workArea.width - 1100) / 2), y: d.workArea.y + Math.round((d.workArea.height - 760) / 2), minWidth: 860, minHeight: 580, backgroundColor: "#0b0c0e", title: "TarkovMap", icon: iconPath(), autoHideMenuBar: true, show: !HEADLESS, webPreferences: WEB() });
  control.loadFile(resolve(ROOT, "renderer", "control.html"), process.env.TARKOVMAP_SHOT_PAGE ? { hash: process.env.TARKOVMAP_SHOT_PAGE } : undefined);
  control.on("close", () => { quitting = true; app.quit(); });
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
  tray.setContextMenu(trayMenu());
}

/**
 * "It should turn on when it sees Tarkov, not when I start it": the app registers itself as a login
 * item (tray only, --tray) so it is already resident, and the windows come out only while the game
 * runs. A portable exe must point the login item at the launcher he double-clicks, not at the
 * per-launch %TEMP% extraction Electron reports as execPath.
 */
function applyLoginItem(): void {
  if (!app.isPackaged) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, path: exe, args: ["--tray"], name: "TarkovMap" });
  } catch (e) { log(`login item: ${(e as Error).message}`); }
}

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "Open TarkovMap", click: createControl },
    { label: `Show / hide overlay${settings.hotkeys.hide ? ` (${settings.hotkeys.hide})` : ""}`, click: toggleOverlayHidden },
    { label: "Full map window", click: () => { bigmapDismissed = false; if (!bigmap) createBigMap(); bigmap?.show(); } },
    { label: `Start with Windows${settings.startWithWindows ? "  ✓" : ""}`, click: () => patchSettings({ startWithWindows: !settings.startWithWindows }) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
}

// ── Hotkeys ────────────────────────────────────────────────────────────────
/** Tarkov just came to the front: put the overlay windows back above it (a fullscreen game with
 *  fullscreen optimizations re-layers the desktop; without re-asserting topmost they can end up beneath). */
function retopOverlay(): void {
  for (const w of [overlay, tags]) {
    if (!w || w.isDestroyed() || !w.isVisible()) continue;
    try { w.setAlwaysOnTop(true, "screen-saver"); w.moveTop(); } catch { /* window going away */ }
  }
}
function toggleOverlayHidden(): void { setOverlayHidden(!overlayHidden); }
function setOverlayHidden(hidden: boolean): void {
  overlayHidden = hidden;
  applyOverlayVisibility();
  broadcast("overlay-mode", { interactive: overlayInteractive, hidden: overlayHidden });
  pushSnapshot();
}

const HOTKEY_ACTIONS: Record<keyof Settings["hotkeys"], () => void> = {
  opacityDown: () => patchSettings({ overlayOpacity: Math.max(0.1, Math.round((settings.overlayOpacity - 0.1) * 100) / 100) }),
  opacityUp: () => patchSettings({ overlayOpacity: Math.min(1, Math.round((settings.overlayOpacity + 0.1) * 100) / 100) }),
  interact: () => { overlayInteractive = !overlayInteractive; applyClickThrough(); },
  hide: () => toggleOverlayHidden(),
  ping: () => dropPing("regroup"),
};
/** Keyboard accelerators go to Electron (swallowed system-wide); Mouse3/4/5 are watched by the key helper (the game still gets the click). */
function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const tryReg = (acc: string, fn: () => void) => {
    try { if (!globalShortcut.register(acc, fn)) log(`hotkey ${acc} is taken by another app`); } catch (e) { log(`hotkey ${acc}: ${(e as Error).message}`); }
  };
  const mouse: Record<string, number> = {};
  for (const [name, fn] of Object.entries(HOTKEY_ACTIONS) as Array<[keyof Settings["hotkeys"], () => void]>) {
    const acc = settings.hotkeys[name];
    if (!acc) continue;
    if (isMouseAccel(acc)) { const vk = vkFor(acc); if (vk) mouse[name] = vk; }
    else tryReg(acc, fn);
  }
  sender.setHotkeys(mouse);
  tray?.setContextMenu(trayMenu());
}

// ── Engine wiring ──────────────────────────────────────────────────────────
let lastBindWarn = "";
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
    // Follow the game's own Screenshot bind so nothing has to be set by hand — unless Windows would eat it.
    if (s.screenshotBind && s.screenshotBind !== settings.screenshotKey && !(s.screenshotBind === "PrintScreen" && printScreenBlocked())) {
      log(`Tarkov's Screenshot key is ${s.screenshotBind} — following it`);
      patchSettings({ screenshotKey: s.screenshotBind });
    } else if (s.screenshotBindRaw != null && (!s.screenshotBind || (s.screenshotBind === "PrintScreen" && printScreenBlocked())) && s.screenshotBindRaw !== lastBindWarn) {
      lastBindWarn = s.screenshotBindRaw;
      log(`Tarkov's Make screenshot is "${s.screenshotBindRaw}" — the app cannot use it; see the health card on the Raid page`);
    }
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
    if (ev.type === "quest") { quests = applyQuestEvent(quests, ev); persistQuests(); invalidateQuests(); pushSnapshot(); }
    if (ev.type === "ended") {
      const r = tickExtract(questPayloadNow()?.all ?? [], lastFix, progress, Date.now());
      if (r.newlyDone.length) { progress = r.progress; writeProgress(PROGRESS_FILE(), progress); log(`quest: extracted for ${r.newlyDone.length} objective(s)`); invalidateQuests(); }
    }
  });
  game.on("folder", (f: string) => { log(`reading ${f}`); mergeQuestHistory(logsDir); });
  game.start();
  gameState = game.state;
  log(`watching logs in ${logsDir}`);
  mergeQuestHistory(logsDir);
}

/** Fold every quest notification in the logs into the book (latest wins) — on boot and on every new log folder,
 *  so a quest finished while the app was closed is not missed. */
function mergeQuestHistory(logsDir: string): void {
  const hist = scanQuestHistory(logsDir);
  if (!hist.length) return;
  const before = JSON.stringify(quests);
  for (const ev of hist) quests = applyQuestEvent(quests, ev);
  const changed = JSON.stringify(quests) !== before;
  log(`quest history: ${hist.length} events, ${changed ? "book updated" : "nothing new"}, ${activeQuestIds(quests).length} active`);
  if (changed) { persistQuests(); invalidateQuests(); pushSnapshot(); }
}

function onMapChanged(): void {
  lastFix = null;
  trail.length = 0;
  myPings = [];
  mapPayloadCache = { key: null, value: null };
  questCache = { key: null, value: null };
  broadcast("quests", questPayloadNow());
  const m = currentMap();
  if (m) { void ensureTiles(m.key); void ensureRe3mr(m.key); }
  broadcast("map", mapPayloadNow());
}

function armFeed(): void {
  feed?.stop();
  arenaFeed?.stop();
  arenaFeed = null;
  const folder = settings.screenshotsFolder || defaultScreenshotsFolder(myDocuments());
  settings.screenshotsFolder = folder;
  feed = wireFeed(new ScreenshotFeed({ folder, deleteAfterRead: settings.deleteScreenshots }));
  log(`watching screenshots in ${folder}`);
  const arena = arenaScreenshotsFolder(myDocuments());
  if (arena.toLowerCase() !== folder.toLowerCase() && existsSync(arena)) {
    arenaFeed = wireFeed(new ScreenshotFeed({ folder: arena, deleteAfterRead: settings.deleteScreenshots }));
    log(`watching Arena screenshots in ${arena}`);
  }
}

function wireFeed(f: ScreenshotFeed): ScreenshotFeed {
  f.on("file", () => { health.fileAt = Date.now(); });
  f.on("unparsed", (name: string) => { health.unparsedAt = Date.now(); health.lastFile = name; });
  f.on("fix", (fix: PlayerFix) => {
    lastFix = fix;
    health.fixAt = Date.now();
    trail.push({ x: fix.x, z: fix.z, at: fix.at });
    while (trail.length > 400) trail.shift();
    const map = currentMap();
    const floor = map ? floorForPosition(map, fix.x, fix.y, fix.z)?.name ?? null : null;
    squad?.shareFix({ x: fix.x, y: fix.y, z: fix.z, yaw: fix.yaw, floor });
    for (const r of testWaiters.splice(0)) r(fix);
    tickFromFix(fix);
    pushSnapshot();
  });
  f.on("swept", (n: number) => log(`screenshots: removed ${n} leftover file(s)`));
  f.on("error", (e: Error) => log(`screenshots: ${e.message}`));
  f.start();
  return f;
}

function feedStats(): { files: number; bytes: number } {
  const a = feed?.stats() ?? { files: 0, bytes: 0 };
  const b = arenaFeed?.stats() ?? { files: 0, bytes: 0 };
  return { files: a.files + b.files, bytes: a.bytes + b.bytes };
}

function armSender(): void {
  sender.configure({ mode: settings.mode, screenshotKey: settings.screenshotKey, holdKey: settings.holdKey, intervalMs: settings.intervalMs });
  sender.start(); // also the foreground-app reporter, so it runs in manual mode too
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
  progress = readProgress(PROGRESS_FILE());
}

/** A fix inside a "visit" zone of an accepted quest ticks that objective — the one thing his own position can prove. */
function tickFromFix(fix: { x: number; z: number }): void {
  const q = questPayloadNow();
  if (!q) return;
  const r = tickVisits(q.all, fix, progress, Date.now());
  if (!r.newlyDone.length) return;
  progress = r.progress;
  writeProgress(PROGRESS_FILE(), progress);
  const names = q.all.filter((o) => r.newlyDone.includes(o.objectiveId)).map((o) => `${o.questName}: ${o.description}`);
  log(`quest: objective reached — ${[...new Set(names)].join("; ")}`);
  invalidateQuests();
}

// ── Quest payload: every objective on the map with its state, and the quest items to grab ──
let questCache: { key: string | null; value: QuestPayload | null } = { key: null, value: null };
interface QuestPayload { mapKey: string; states: Record<string, QuestState>; objectiveDone: QuestProgress["done"]; all: ReturnType<typeof allObjectivesOnMap>; items: ReturnType<typeof questItemMarkers>; hasItemData: boolean; source: string }
function questPayload(map: MapDef | null): QuestPayload | null {
  if (!map || !tasks) return null;
  const states = questStates(tasks.tasks, quests, new Set(settings.manualDone));
  const feats = featuresFor(features, map.normalizedName);
  return {
    mapKey: map.key, states, objectiveDone: progress.done,
    all: allObjectivesOnMap(tasks.tasks, states, progress, map.normalizedName, true),
    items: questItemMarkers(tasks.tasks, states, progress, feats, map.normalizedName, offlinePrices(), offlineNames()),
    hasItemData: tasks.tasks.some((t) => t.objectives.some((o) => o.items?.length)),
    source: dataStatus.tasks,
  };
}
function questPayloadNow(): QuestPayload | null {
  const map = currentMap();
  if (questCache.key !== (map?.key ?? null) || !questCache.value) questCache = { key: map?.key ?? null, value: questPayload(map) };
  return questCache.value;
}
function invalidateQuests(): void {
  questCache = { key: null, value: null };
  broadcast("quests", questPayloadNow());
}

// ── tarkov.dev data (markers, quests) ───────────────────────────────────────
let dataTimer: NodeJS.Timeout | null = null;
/** The game's English locale keys the JSON API's names are written in (data/offline/names.json). */
function offlineNames(): Names {
  try { return JSON.parse(readFileSync(join(ROOT, "data", "offline", "names.json"), "utf8")) as Names; } catch { return {}; }
}
let pricesMemo: Record<string, number> | null = null, containerMemo: Record<string, Record<string, number>> | null = null;
function offlinePrices(): Record<string, number> {
  if (!pricesMemo) { try { pricesMemo = JSON.parse(readFileSync(join(ROOT, "data", "offline", "prices.json"), "utf8")); } catch { pricesMemo = {}; } }
  return pricesMemo!;
}
function offlineContainerValues(): Record<string, Record<string, number>> {
  if (!containerMemo) { try { containerMemo = JSON.parse(readFileSync(join(ROOT, "data", "offline", "container-values.json"), "utf8")); } catch { containerMemo = {}; } }
  return containerMemo!;
}
function offlineMapIds(): Record<string, string> {
  try { return JSON.parse(readFileSync(join(ROOT, "data", "offline", "map-ids.json"), "utf8")) as Record<string, string>; } catch { return {}; }
}
async function loadData(): Promise<void> {
  features = readCache(FEATURES_FILE()) ?? (existsSync(join(ROOT, "data", "features.json")) ? readCache(join(ROOT, "data", "features.json")) : null);
  tasks = readTaskCache(TASKS_FILE()) ?? (existsSync(join(ROOT, "data", "tasks.json")) ? readTaskCache(join(ROOT, "data", "tasks.json")) : null);
  if (!tasks) { const old = readTaskCache(TASKS_FILE(), { allowOld: true }); if (old) { tasks = { ...old, fetchedAt: 0 }; } } // an older cache shape: shown until the refetch lands
  dataStatus.features = features ? "cached" : "missing";
  dataStatus.tasks = tasks ? "cached" : "missing";
  // The game's own data dump (data/offline, built by scripts/fetch-spt-data.mjs) is the floor: scav /
  // PMC / boss spawns and extract names without any network. Anything from tarkov.dev replaces it.
  const offlineF = existsSync(join(ROOT, "data", "offline", "features.json")) ? readCache(join(ROOT, "data", "offline", "features.json")) : null;
  const offlineT = existsSync(join(ROOT, "data", "offline", "tasks.json")) ? readTaskCache(join(ROOT, "data", "offline", "tasks.json"), { allowOld: true }) : null;
  if (!features && offlineF) { features = { ...offlineF, fetchedAt: 0 }; dataStatus.features = "offline"; }
  if (!tasks && offlineT) { tasks = { ...offlineT, fetchedAt: 0 }; dataStatus.tasks = "offline"; }
  const staleF = !features || Date.now() - features.fetchedAt > CACHE_TTL_MS;
  const staleT = !tasks || Date.now() - tasks.fetchedAt > CACHE_TTL_MS;
  if (!staleF && !staleT) { dataStatus.features = dataStatus.tasks = "ok"; return; }
  let failed = false;
  // json.tarkov.dev is what the tarkov.dev site itself runs on and is the route its maintainers
  // recommend while the GraphQL API is down; GraphQL stays as the second try.
  const names = offlineNames();
  const mapIds = () => ({ ...offlineMapIds(), ...(features?.mapIds ?? {}) });
  if (staleF) {
    try {
      let maps: FeatureCache["maps"], ids: Record<string, string> | undefined, via = "json.tarkov.dev";
      try { const r = convertJsonMaps(await fetchJson<JsonMapsPayload>("maps"), names); maps = r.maps; ids = r.idToKey; }
      catch (e1) { log(`json.tarkov.dev maps failed (${(e1 as Error).message}) — trying the GraphQL API`); maps = await fetchFeatures(); via = "api.tarkov.dev"; }
      features = { fetchedAt: Date.now(), maps, mapIds: ids ?? features?.mapIds }; writeCache(FEATURES_FILE(), features); dataStatus.features = "ok";
      log(`markers refreshed from ${via} (${maps.length} maps)`); mapPayloadCache = { key: null, value: null }; broadcast("map", mapPayloadNow()); invalidateQuests();
    } catch (e) { failed = true; dataStatus.lastError = (e as Error).message; }
  }
  if (staleT) {
    try {
      let list: TaskCache["tasks"], via = "json.tarkov.dev";
      try { list = convertJsonTasks(await fetchJson<JsonTasksPayload>("tasks"), mapIds(), names); }
      catch (e1) { log(`json.tarkov.dev tasks failed (${(e1 as Error).message}) — trying the GraphQL API`); list = await fetchTasks(); via = "api.tarkov.dev"; }
      tasks = { fetchedAt: Date.now(), tasks: list, version: TASK_CACHE_VERSION }; writeTaskCache(TASKS_FILE(), tasks); dataStatus.tasks = "ok"; log(`quests refreshed from ${via} (${list.length} tasks)`); invalidateQuests();
    } catch (e) { failed = true; dataStatus.lastError = (e as Error).message; }
  }
  if (failed) {
    dataStatus.nextRetryAt = Date.now() + DATA_RETRY_MS;
    log(`tarkov.dev unavailable (${dataStatus.lastError}) — ${dataStatus.features === "offline" ? "using the game's own spawn data" : features ? "using cached markers" : "no marker data yet"}; retrying in 15 min`);
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

/**
 * Folder sizes for the Setup page. NEVER walked synchronously: the tile cache holds ~134,000 files,
 * and the old synchronous walk ran inside EVERY snapshot (every fix, every 2 s) — 1-3 s of blocked
 * main thread each time. Windows filed it as AppHangTransient, every window sat black waiting on
 * `state:get`, and it read as "laggy, not loading, crashing" (2026-09-05). Now: a cached value,
 * refreshed in the background at most every 2 min or when something writes to the folder.
 */
type DirSize = { bytes: number; files: number };
const dirSizeCache = new Map<string, { value: DirSize; at: number; running: boolean }>();
const DIR_SIZE_TTL_MS = 120_000;
function dirSize(dir: string, force = false): DirSize {
  const c = dirSizeCache.get(dir) ?? { value: { bytes: 0, files: 0 }, at: 0, running: false };
  if (!dirSizeCache.has(dir)) dirSizeCache.set(dir, c);
  if (!c.running && (force || Date.now() - c.at > DIR_SIZE_TTL_MS)) {
    c.running = true;
    void walkDirAsync(dir).then((v) => { c.value = v; c.at = Date.now(); c.running = false; pushSnapshot(); }).catch(() => { c.running = false; });
  }
  return c.value;
}
async function walkDirAsync(root: string): Promise<DirSize> {
  let bytes = 0, files = 0, n = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop() as string;
    let ents: import("node:fs").Dirent[];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try { bytes += (await fsp.stat(p)).size; files++; } catch { /* skip */ }
      if (++n % 500 === 0) await new Promise((r) => setImmediate(r)); // yield so IPC keeps flowing
    }
  }
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
    dirSize(RE3MR_DIR(), true);
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

const registrationCache = new Map<string, Registration | null>();
function registrationFor(key: string): Registration | null {
  if (!registrationCache.has(key)) registrationCache.set(key, loadRegistration(RE3MR_DIR(), key) ?? loadRegistration(join(ROOT, "data", "re3mr"), key));
  return registrationCache.get(key) ?? null;
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
    maxZoom: sliced.maxZoom, width: sliced.width, height: sliced.height, affine: reg.affine, homography: reg.homography ?? null, errorM: reg.errorM, credit: src.credit,
  } : null;
  const bundled = join(ROOT, "data", "svg", `${map.key}.svg`);
  const svg = map.svgPath ? readSvg(TILE_ROOT(), map.svgPath) : existsSync(bundled) ? readFileSync(bundled, "utf8") : null;
  const feats = featuresFor(features, map.normalizedName);
  const loot = feats ? { points: lootPoints(feats, offlinePrices(), offlineNames()).slice(0, 400), heat: lootHeat(feats, offlinePrices(), offlineNames(), offlineContainerValues()[map.key] ?? {}) } : null;
  const svgTraced = !map.svgPath && existsSync(bundled) && map.key !== "the-lab";
  return { def: map, svg, svgTraced, localTemplates: local, features: feats, loot, re3mr, re3mrAvailable: Boolean(src) };
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
    objectives, activeQuestCount: activeQuestIds(quests).filter((q) => !settings.manualDone.includes(q)).length, questProgressCount: Object.keys(progress.done).length, version: app.getVersion(),
    squad: { ...squadState, pings: [...squadState.pings, ...myPings.filter((p) => p.at + p.ttlMs > Date.now())] },
    maps: MAPS.map((m) => ({ key: m.key, name: m.name, re3mr: Boolean(sourceFor(m.key)), re3mrReady: re3mrReady.has(m.key), registered: Boolean(registrationFor(m.key)), errorM: registrationFor(m.key)?.errorM ?? null, projective: Boolean(registrationFor(m.key)?.homography) })),
    displays: screen.getAllDisplays().map((d) => ({ id: d.id, label: `${d.label || "Display"} ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? " (main)" : ""}`, primary: d.id === screen.getPrimaryDisplay().id })),
    install: { path: settings.installPath, logsDir: settings.installPath ? logsDirFor(settings.installPath) : null },
    screenshots: feedStats(),
    tileCache: dirSize(TILE_ROOT()), re3mrCache: dirSize(RE3MR_DIR()), tiles: tileProgress, re3mrProgress,
    data: dataStatus, overlay: { interactive: overlayInteractive, hidden: overlayHidden, gameRunning, foregroundApp }, log: logLines.slice(-60),
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
  settings = sanitize({ ...settings, ...patch, layers: patch.layers ?? settings.layers, manualDone: patch.manualDone ?? settings.manualDone, hotkeys: { ...settings.hotkeys, ...(patch.hotkeys ?? {}) } });
  saveSettings(SETTINGS_FILE(), settings);
  if (before.installPath !== settings.installPath) armGame();
  if (before.screenshotsFolder !== settings.screenshotsFolder || before.deleteScreenshots !== settings.deleteScreenshots) armFeed();
  if (before.mode !== settings.mode || before.screenshotKey !== settings.screenshotKey || before.holdKey !== settings.holdKey || before.intervalMs !== settings.intervalMs) armSender();
  if (before.squadEnabled !== settings.squadEnabled || before.squadCode !== settings.squadCode || before.playerName !== settings.playerName) armSquad();
  if (overlay && (before.overlayDisplayId !== settings.overlayDisplayId || before.overlayScale !== settings.overlayScale || before.minimapSize !== settings.minimapSize || before.corner !== settings.corner || before.margin !== settings.margin)) overlay.setBounds(overlayBounds());
  if (before.bigMapDisplayId !== settings.bigMapDisplayId || before.bigMapEnabled !== settings.bigMapEnabled) { bigmap?.destroy(); bigmap = null; createBigMap(); }
  if (before.showTags !== settings.showTags) ensureTagsWindow();
  if (JSON.stringify(before.hotkeys) !== JSON.stringify(settings.hotkeys)) registerHotkeys();
  if (before.overlayOnlyInGame !== settings.overlayOnlyInGame) applyOverlayVisibility();
  if (before.startWithWindows !== settings.startWithWindows) { applyLoginItem(); tray?.setContextMenu(trayMenu()); }
  if ((currentMap()?.key ?? null) !== beforeMap) onMapChanged();
  else if (before.mapBase !== settings.mapBase || before.mapStyle !== settings.mapStyle) broadcast("map", mapPayloadNow());
  if (JSON.stringify(before.manualDone) !== JSON.stringify(settings.manualDone)) invalidateQuests();
  pushSnapshot();
}

// ── IPC ────────────────────────────────────────────────────────────────────
function registerIpc(): void {
  ipcMain.handle("state:get", () => ({ ...snapshot(), map: mapPayloadNow(), quests: questPayloadNow() }));
  ipcMain.handle("quests:get", () => questPayloadNow());
  ipcMain.handle("quest:markObjective", (_e, objectiveId: string, done: boolean) => { progress = setObjective(progress, String(objectiveId), Boolean(done), Date.now()); writeProgress(PROGRESS_FILE(), progress); invalidateQuests(); pushSnapshot(); });
  ipcMain.handle("quests:rescan", () => { const d = settings.installPath ? logsDirFor(settings.installPath) : null; if (d) mergeQuestHistory(d); return { active: activeQuestIds(quests).length, known: Object.keys(quests).length }; });
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
  ipcMain.handle("window:bigmap", (_e, show: boolean) => { bigmapDismissed = !show; if (!bigmap) createBigMap(); show ? bigmap?.show() : bigmap?.hide(); });
  ipcMain.handle("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle("window:hide", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.handle("overlay:interactive", (_e, v: boolean) => { overlayInteractive = v; applyClickThrough(); });
  ipcMain.handle("overlay:toggleHidden", () => toggleOverlayHidden());
  ipcMain.handle("overlay:setHidden", (_e, hidden: boolean) => setOverlayHidden(Boolean(hidden)));
  ipcMain.handle("health:test", () => healthTest());
  ipcMain.handle("health:get", () => healthRows());
  ipcMain.handle("app:quit", () => { quitting = true; app.quit(); });
  ipcMain.handle("detect:install", () => detectInstall());
  ipcMain.handle("tiles:fetchAll", () => void cacheAllTilesInBackground());
  ipcMain.handle("tiles:clear", () => { try { rmSync(TILE_ROOT(), { recursive: true, force: true }); tilesDone.clear(); tileProgress = {}; } catch (e) { log(`tiles: ${(e as Error).message}`); } return dirSize(TILE_ROOT(), true); });
  ipcMain.handle("data:refresh", () => void loadData());
  ipcMain.handle("quest:markDone", (_e, questId: string, done: boolean) => { const set = new Set(settings.manualDone); done ? set.add(questId) : set.delete(questId); patchSettings({ manualDone: [...set] }); });
  ipcMain.handle("quest:list", () => {
    if (!tasks) return [];
    const states = questStates(tasks.tasks, quests, new Set(settings.manualDone));
    const ctx = whyContext(tasks.tasks);
    return tasks.tasks.map((t) => ({
      id: t.id, name: t.name, trader: { ...t.trader, portrait: `https://assets.tarkov.dev/${t.trader.id}.webp` }, map: t.map?.normalizedName ?? null, state: states[t.id], done: settings.manualDone.includes(t.id),
      minPlayerLevel: t.minPlayerLevel, wikiLink: t.wikiLink, kappaRequired: t.kappaRequired, why: whyItMatters(t, ctx),
      objectives: t.objectives.map((o) => ({ id: o.id, type: o.type, description: o.description, maps: (o.maps ?? []).map((m) => m.normalizedName), done: Boolean(progress.done[o.id]), optional: Boolean(o.optional) })),
    }));
  });
  ipcMain.handle("quest:progression", () => {
    if (!tasks) return null;
    const states = questStates(tasks.tasks, quests, new Set(settings.manualDone));
    return progression(tasks.tasks, states, (id) => Boolean(progress.done[id]));
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
    registrationCache.delete(reg.key);
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
  if (process.env.TARKOVMAP_SHOT_SEQ) { armSequenceCapture(dir, process.env.TARKOVMAP_SHOT_SEQ); return; }
  const delay = Number(process.env.TARKOVMAP_SHOT_DELAY_MS || 12000);
  setTimeout(async () => {
    mkdirSync(dir, { recursive: true });
    for (const [name, w] of [["overlay", overlay], ["tags", tags], ["bigmap", bigmap], ["control", control]] as Array<[string, BrowserWindow | null]>) {
      if (!w || w.isDestroyed()) continue;
      try {
        if (name === "overlay" || name === "tags") await w.webContents.insertCSS("html{background:#3a3a34 !important}");
        if (name === "control" && process.env.TARKOVMAP_SHOT_SECTION) { await w.webContents.executeJavaScript(`(function(){const a=document.querySelector('nav a[data-s=' + ${JSON.stringify(JSON.stringify(process.env.TARKOVMAP_SHOT_SECTION))} + ']');if(a)a.click();})()`); await new Promise((r) => setTimeout(r, 2500)); }
        if (name === "control" && process.env.TARKOVMAP_SHOT_JS) { try { await w.webContents.executeJavaScript(process.env.TARKOVMAP_SHOT_JS); } catch (e) { log(`debug: shot js: ${(e as Error).message}`); } await new Promise((r) => setTimeout(r, 2500)); }
        if (name === "control" && process.env.TARKOVMAP_SHOT_SCROLL) { await w.webContents.executeJavaScript(`(function(){const el=document.getElementById(${JSON.stringify(process.env.TARKOVMAP_SHOT_SCROLL)});if(el)el.scrollIntoView({block:"start"});})()`); await new Promise((r) => setTimeout(r, 1500)); }
        const img = await w.webContents.capturePage();
        writeFileSync(join(dir, `${name}.png`), img.toPNG());
        log(`debug: captured ${name}`);
      } catch (e) { log(`debug: ${name} capture failed: ${(e as Error).message}`); }
    }
    if (HEADLESS) { quitting = true; app.quit(); } // nothing on screen to keep alive for
  }, delay);
}

/**
 * TARKOVMAP_SHOT_SEQ=<json>: [{name, map, style?, base?, fix?:[x,y,z,yaw], wait?}] — one boot, every
 * map/floor/style in turn, each captured to <dir>/<name>-bigmap.png and -overlay.png, then quit.
 * Settings are changed in memory only (nothing is saved); the fix is injected, not read from a file.
 */
function armSequenceCapture(dir: string, seqFile: string): void {
  type Step = { name: string; map: string; style?: "studio" | "night"; base?: "vector" | "re3mr"; fix?: [number, number, number, number]; layers?: string[]; settings?: Partial<Settings>; quests?: QuestBook; js?: string; wait?: number };
  const steps = JSON.parse(readFileSync(seqFile, "utf8")) as Step[];
  const settle = Number(process.env.TARKOVMAP_SHOT_DELAY_MS || 9000);
  setTimeout(async () => {
    mkdirSync(dir, { recursive: true });
    for (const st of steps) {
      settings = { ...settings, ...(st.settings ?? {}), manualMapKey: st.map, mapStyle: st.style ?? "studio", mapBase: st.base ?? "vector", layers: st.layers ? { ...settings.layers, [st.map]: st.layers } : settings.layers };
      if (st.quests) quests = st.quests;
      mapPayloadCache = { key: null, value: null };
      questCache = { key: null, value: null };
      broadcast("map", mapPayloadNow());
      broadcast("quests", questPayloadNow());
      if (st.fix) { lastFix = { x: st.fix[0], y: st.fix[1], z: st.fix[2], yaw: st.fix[3], q: [0, 0, 0, 1], file: "", at: Date.now() }; tickFromFix(lastFix); }
      pushSnapshot();
      await new Promise((r) => setTimeout(r, st.wait ?? 5000));
      if (st.js && bigmap && !bigmap.isDestroyed()) {
        try { const r = await bigmap.webContents.executeJavaScript(st.js); writeFileSync(join(dir, `${st.name}-js.json`), JSON.stringify(r ?? null)); await new Promise((r2) => setTimeout(r2, 600)); }
        catch (e) { writeFileSync(join(dir, `${st.name}-js.json`), JSON.stringify({ error: (e as Error).message })); }
      }
      for (const [name, w] of [["overlay", overlay], ["bigmap", bigmap]] as Array<[string, BrowserWindow | null]>) {
        if (!w || w.isDestroyed()) continue;
        try {
          if (name === "overlay") await w.webContents.insertCSS("html{background:#3a3a34 !important}");
          const img = await w.webContents.capturePage();
          writeFileSync(join(dir, `${st.name}-${name}.png`), img.toPNG());
        } catch (e) { log(`debug: ${st.name} ${name} capture failed: ${(e as Error).message}`); }
      }
      log(`debug: captured ${st.name}`);
    }
    quitting = true;
    app.quit();
  }, settle);
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
    log(`start: argv [${process.argv.slice(1).join(" ")}] env-args [${process.env.TARKOVMAP_ARGS ?? ""}] tray=${TRAY_START}`);
    if (!settings.installPath) { settings.installPath = detectInstall(); if (settings.installPath) log(`found EFT at ${settings.installPath}`); }
    if (!settings.screenshotsFolder) settings.screenshotsFolder = defaultScreenshotsFolder(myDocuments());
    // The launcher stub mangles command-line arguments (argv arrives as the extraction path), so a
    // login start cannot be told apart by a flag. It does not need to be: once the game folder is
    // known, setup is done and NO window opens at start — the tray waits, the maps come out when
    // Tarkov runs, and Setup is one tray click away.
    if (!settings.setupDone && settings.installPath && logsDirFor(settings.installPath)) { settings.setupDone = true; log("setup: game folder known — starting quietly from now on"); }
    saveSettings(SETTINGS_FILE(), settings);
    loadQuests();
    registerIpc();
    createTray();
    createOverlay();
    createBigMap();
    if ((!settings.setupDone && !TRAY_START) || (process.env.TARKOVMAP_SHOT && (!HEADLESS || process.env.TARKOVMAP_SHOT_PAGE))) createControl();
    if (!HEADLESS) { applyLoginItem(); armGame(); armFeed(); armSender(); armSquad(); }
    // Slice every render that is already on disk but not yet tiled, one at a time, off the boot path —
    // so a map he switches to later is ready instead of showing "slicing" for a minute.
    setTimeout(async () => {
      for (const src of SOURCES) {
        if (re3mrReady.has(src.key) || !existsSync(join(RE3MR_DIR(), src.file))) continue;
        if (pyramidDone(USER(), src.key)) { re3mrReady.set(src.key, pyramidDone(USER(), src.key) as SliceResult); continue; }
        await ensureRe3mr(src.key);
      }
      pushSnapshot();
    }, 20000);
    registerHotkeys();
    armDebugCapture();
    sender.on("line", (l: string) => {
      health.helperAt = Date.now();
      if (l === "sent") { health.sentAt = Date.now(); health.sent.push(health.sentAt); if (health.sent.length > 200) health.sent.splice(0, 100); return; }
      if (l.startsWith("skip-foreground")) { health.skipAt = Date.now(); health.skipApp = l.slice(15).trim(); }
      if (l.startsWith("fg ")) { foregroundApp = l.slice(3).trim(); applyOverlayVisibility(); if (GAME_PROCESSES.has(foregroundApp)) retopOverlay(); return; }
      if (l.startsWith("game ")) {
        const now = l.slice(5).trim() === "1";
        if (gameRunning !== now) { gameRunning = now; log(now ? "Tarkov is running — map windows armed" : "Tarkov closed — back to the tray"); applyOverlayVisibility(); pushSnapshot(); }
        return;
      }
      if (l.startsWith("hotkey ")) { const name = l.slice(7).trim() as keyof Settings["hotkeys"]; HOTKEY_ACTIONS[name]?.(); return; }
      if (l.startsWith("skip-foreground")) broadcast("sender", l); else if (l.startsWith("err")) log(`key: ${l}`);
    });
    sender.on("log", (l: string) => log(l));
    void loadData();
    const m = currentMap();
    if (m) void ensureRe3mr(m.key);
    void cacheAllTilesInBackground();
    setInterval(() => {
      squad?.prune();
      if (myPings.some((p) => p.at + p.ttlMs <= Date.now())) { myPings = myPings.filter((p) => p.at + p.ttlMs > Date.now()); ensureTagsWindow(); pushSnapshot(); }
    }, 5000);
    setInterval(() => broadcast("tick", { now: Date.now(), screenshots: feedStats(), health: healthRows() }), 1000);
    readPrintScreenSnipping();
    setInterval(readPrintScreenSnipping, 60000);
    writeHealth();
    setInterval(writeHealth, 5000);
  });
  app.on("window-all-closed", () => { /* stay in the tray */ });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("before-quit", () => { quitting = true; game?.stop(); feed?.stop(); arenaFeed?.stop(); sender.stop(); squad?.stop(); });
}
