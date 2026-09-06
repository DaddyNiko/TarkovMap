/** settings.json in userData. The OpenRouter key is the only secret; it is stored as-is (single-user PC) and never leaves the machine except to openrouter.ai. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SendMode } from "./key-sender.js";

export type Corner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export interface Settings {
  installPath: string | null;
  screenshotsFolder: string | null;
  /** Debug-only escape hatch; there is deliberately no UI for it. */
  deleteScreenshots: boolean;
  mode: SendMode;
  screenshotKey: string;
  holdKey: string;
  intervalMs: number;
  /** Ghost defaults: map 40 %, scale 80 %, panel 80 %. */
  mapOpacity: number;
  /** One dial for the whole overlay: minimap, side panel, tags. 0.1–1. */
  overlayOpacity: number;
  overlayScale: number;
  panelOpacity: number;
  /** Minimap size in px before scale, and which corner of the main display. */
  minimapSize: number;
  corner: Corner;
  margin: number;
  headingUp: boolean;
  rangeRings: boolean;
  roundMask: boolean;
  followZoom: number;
  /** Which display the overlay covers (null = primary) and whether a big map window opens on another display. */
  overlayDisplayId: number | null;
  bigMapDisplayId: number | null;
  bigMapEnabled: boolean;
  clickThroughInRaid: boolean;
  showTrail: boolean;
  showLabels: boolean;
  showHudText: boolean;
  showQuests: boolean;
  showTags: boolean;
  /** Vertical field of view used to project teammate tags onto the screen. */
  gameFov: number;
  /** Per-map layer toggles: key → list of layer ids switched on. */
  layers: Record<string, string[]>;
  /** Layer ids kept off the in-game minimap (the eye toggles on the Layers page); the full map still draws them. */
  hiddenInGame: string[];
  /** Flea filter threshold in roubles (0 = off). */
  fleaMin: number;
  /** Colour the map by how valuable the loot that can spawn there is (possible loot, never what spawned). */
  lootHeat: boolean;
  /** Quest-items layer: only items scoring at least this (0 = everything). */
  questItemMin: number;
  /** All-quests layer: also draw finished / failed quests. */
  showDoneQuests: boolean;
  /** Squad */
  playerName: string;
  squadCode: string;
  squadEnabled: boolean;
  /** AI: OpenRouter key for the plain-English filter prompt (free models first). */
  openrouterKey: string;
  openrouterModel: string;
  /** Quests the user marked done by hand (quest ids). */
  manualDone: string[];
  /** Last map the game reported, shown while in the menu. */
  lastMapKey: string | null;
  /** A map he picked by hand in the control app; wins while not in a raid. */
  manualMapKey: string | null;
  /** Base: our vector map (Studio / Night) or RE3MR's 3D render where one exists and is aligned. */
  mapBase: "vector" | "re3mr";
  /** The vector look: studio (default) | night. */
  mapStyle: "studio" | "night";
  extrudeDepth: number;
  /** Global hotkeys as Electron accelerators; "" = off. A key the app takes here never reaches the game. */
  hotkeys: Hotkeys;
  /** Show the overlay only while Escape from Tarkov / Arena is the foreground window. */
  overlayOnlyInGame: boolean;
  /** Register the exe as a Windows login item (tray only) so it is already running when Tarkov opens. */
  startWithWindows: boolean;
  setupDone: boolean;
}

export interface Hotkeys { ping: string; opacityDown: string; opacityUp: string; interact: string; hide: string; }
export const DEFAULT_HOTKEYS: Hotkeys = { ping: "F6", opacityDown: "F7", opacityUp: "F8", interact: "F9", hide: "F10" };
const ACCEL = /^((Ctrl|Alt|Shift|Super)\+){0,3}(F([1-9]|1\d|2[0-4])|[A-Z0-9]|Space|Tab|Capslock|Numlock|Scrolllock|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|Escape|Printscreen|Pause|num[0-9]|numadd|numsub|nummult|numdiv|numdec|Mouse[345]|[`\-=\[\]\\;',./])$/;
/** Mouse3 / Mouse4 / Mouse5 are watched by the key helper (GetAsyncKeyState), not registered with Electron; the game still gets the click. */
export const MOUSE_ACCEL = /^Mouse([345])$/;
export function isMouseAccel(acc: string): boolean { return MOUSE_ACCEL.test(acc); }
/** Keep a valid accelerator, blank an invalid one, drop duplicates (the second binding of one key loses). */
export function sanitizeHotkeys(h: unknown): Hotkeys {
  const src = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_HOTKEYS };
  const seen = new Set<string>();
  for (const k of Object.keys(DEFAULT_HOTKEYS) as Array<keyof Hotkeys>) {
    const v = typeof src[k] === "string" ? (src[k] as string).trim() : DEFAULT_HOTKEYS[k];
    const ok = v === "" ? "" : ACCEL.test(v) ? v : DEFAULT_HOTKEYS[k];
    out[k] = ok && seen.has(ok.toLowerCase()) ? "" : ok;
    if (ok) seen.add(ok.toLowerCase());
  }
  return out;
}

export const DEFAULT_SETTINGS: Settings = {
  installPath: null,
  screenshotsFolder: null,
  deleteScreenshots: true,
  mode: "auto",
  screenshotKey: "F11",
  holdKey: "CapsLock",
  intervalMs: 2000,
  mapOpacity: 0.4,
  overlayOpacity: 1,
  overlayScale: 0.8,
  panelOpacity: 0.8,
  minimapSize: 470,
  corner: "top-right",
  margin: 20,
  headingUp: true,
  rangeRings: true,
  roundMask: false,
  followZoom: 4.5,
  overlayDisplayId: null,
  bigMapDisplayId: null,
  bigMapEnabled: true,
  clickThroughInRaid: true,
  showTrail: true,
  showLabels: true,
  showHudText: true,
  showQuests: true,
  showTags: true,
  gameFov: 65,
  layers: {},
  hiddenInGame: ["allquests"],
  fleaMin: 0,
  lootHeat: false,
  questItemMin: 8,
  showDoneQuests: false,
  playerName: "",
  squadCode: "",
  squadEnabled: false,
  openrouterKey: "",
  openrouterModel: "openrouter/free",
  manualDone: [],
  lastMapKey: null,
  manualMapKey: null,
  mapBase: "vector",
  mapStyle: "studio",
  extrudeDepth: 4,
  hotkeys: { ...DEFAULT_HOTKEYS },
  overlayOnlyInGame: true,
  startWithWindows: true,
  setupDone: false,
};

export function loadSettings(file: string): Settings {
  try {
    if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
    return sanitize({ ...DEFAULT_SETTINGS, ...parsed, layers: parsed.layers ?? {}, manualDone: parsed.manualDone ?? [] });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const CORNERS: Corner[] = ["top-right", "top-left", "bottom-right", "bottom-left"];

export function sanitize(s: Settings): Settings {
  return {
    ...s,
    mapOpacity: clamp(num(s.mapOpacity, DEFAULT_SETTINGS.mapOpacity), 0.15, 1),
    overlayOpacity: clamp(num(s.overlayOpacity, DEFAULT_SETTINGS.overlayOpacity), 0.1, 1),
    overlayScale: clamp(num(s.overlayScale, DEFAULT_SETTINGS.overlayScale), 0.5, 1.5),
    panelOpacity: clamp(num(s.panelOpacity, DEFAULT_SETTINGS.panelOpacity), 0.15, 1),
    minimapSize: Math.round(clamp(num(s.minimapSize, DEFAULT_SETTINGS.minimapSize), 200, 1200)),
    margin: Math.round(clamp(num(s.margin, DEFAULT_SETTINGS.margin), 0, 400)),
    intervalMs: Math.round(clamp(num(s.intervalMs, DEFAULT_SETTINGS.intervalMs), 500, 30000)),
    followZoom: clamp(num(s.followZoom, DEFAULT_SETTINGS.followZoom), 1, 7),
    gameFov: clamp(num(s.gameFov, DEFAULT_SETTINGS.gameFov), 40, 110),
    fleaMin: Math.max(0, Math.round(num(s.fleaMin, 0))),
    lootHeat: Boolean(s.lootHeat),
    questItemMin: Math.round(clamp(num(s.questItemMin, 8), 0, 30)),
    showDoneQuests: Boolean(s.showDoneQuests),
    corner: CORNERS.includes(s.corner) ? s.corner : "top-right",
    mode: (["auto", "manual", "hold", "timer"] as const).includes(s.mode) ? s.mode : "auto",
    playerName: String(s.playerName ?? "").slice(0, 24),
    squadCode: String(s.squadCode ?? "").slice(0, 32),
    openrouterKey: String(s.openrouterKey ?? "").trim(),
    openrouterModel: String(s.openrouterModel || DEFAULT_SETTINGS.openrouterModel),
    manualDone: Array.isArray(s.manualDone) ? s.manualDone.filter((x) => typeof x === "string") : [],
    mapBase: s.mapBase === "re3mr" ? "re3mr" : "vector",
    mapStyle: s.mapStyle === "night" ? "night" : "studio",
    extrudeDepth: Math.round(clamp(num(s.extrudeDepth, 4), 0, 12)),
    manualMapKey: typeof s.manualMapKey === "string" && s.manualMapKey ? s.manualMapKey : null,
    hotkeys: sanitizeHotkeys(s.hotkeys),
    hiddenInGame: Array.isArray(s.hiddenInGame) ? s.hiddenInGame.filter((x): x is string => typeof x === "string").slice(0, 40) : [...DEFAULT_SETTINGS.hiddenInGame],
    overlayOnlyInGame: s.overlayOnlyInGame !== false,
    startWithWindows: s.startWithWindows !== false,
  };
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function saveSettings(file: string, s: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.settings-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

/** EFT's default screenshot folder: <MyDocuments>\Escape From Tarkov\Screenshots. */
export function defaultScreenshotsFolder(myDocuments: string): string {
  return join(myDocuments, "Escape From Tarkov", "Screenshots");
}
/** Arena writes next door: <MyDocuments>\Escape From Tarkov Arena\Screenshots. */
export function arenaScreenshotsFolder(myDocuments: string): string {
  return join(myDocuments, "Escape From Tarkov Arena", "Screenshots");
}
