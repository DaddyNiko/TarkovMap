/**
 * Which map, whether a raid is live, and quest progress — read from the
 * game's own logs.
 *
 * EFT writes `<install>\build\Logs\log_<ts>\<ts> application_000.log` and
 * `… push-notifications_000.log` (a new folder per game launch). Lines we
 * care about, verified against a real session:
 *
 *   …|application|TRACE-NetworkGameCreate profileStatus: '… Location: Sandbox, … RaidMode: Online …'
 *     (older builds; 1.1.0.1 stopped writing it — the two lines below carry the map now)
 *   …|application|scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset
 *   …|application|[Transit] Flag:None, RaidId:6a9d69ba…, Count:0, Locations:bigmap ->
 *   …|application|LocationLoaded:15.4 real:20.09 diff:4.69
 *   …|application|GameStarted:…
 *   …|application|PrepareSelectedProfileLocally ProfileId:…   (back in the menu after a raid)
 *   …|push-notifications|Got notification | UserMatchOver
 *   { "location": "Sandbox", … }                                (JSON on the following lines)
 *   …|push-notifications|Got notification | ChatMessageReceived
 *   { "message": { "type": 10|11|12, "templateId": "<questId> …" } }  (quest started/failed/finished)
 *
 * Read-only: files are opened for reading and tailed from the last offset.
 */
import { EventEmitter } from "node:events";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mapKeyForLocation } from "./map-data.js";

export type RaidState = "menu" | "matching" | "loading" | "in-raid";

export type QuestStatus = "started" | "failed" | "finished";

export type LogEvent =
  | { type: "location"; location: string; mapKey: string | null; online: boolean; raidId?: string }
  | { type: "matching" }
  | { type: "loaded" }
  | { type: "started" }
  | { type: "ended"; location?: string; mapKey: string | null }
  | { type: "aborted" }
  /** The profile is re-prepared when the player is back in the menu after a raid. */
  | { type: "profile" }
  /** The game logs its whole input config at start; this is its MakeScreenshot bind in the app's key names. */
  | { type: "binds"; screenshotKey: string | null; raw: string }
  | { type: "side"; side: "pmc" | "scav" }
  | { type: "quest"; questId: string; status: QuestStatus; at: number };

const LOCATION_RE = /Location: (?<loc>[^,'\s]+)/;
const RAID_ID_RE = /shortId: (?<id>[A-Z0-9]{4,8})/;
const NOTIFICATION_RE = /Got notification \| (?<kind>[A-Za-z]+)/;
const STAMP_RE = /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2})/;
const SCENE_RE = /rcid:(?<loc>[A-Za-z0-9_]+)\.scenespreset/;
const SHOT_BIND_RE = /"keyName":"MakeScreenshot","variants":\[\{"keyCode":\[(?<codes>[^\]]*)\]/;

/** Unity KeyCode name → the app's key name (the Setup page list / key-sender VK table), or null when unsendable. */
export function unityKeyToName(code: string): string | null {
  const c = code.trim();
  if (/^F([1-9]|1[0-2])$/.test(c)) return c;
  if (c === "SysReq" || c === "Print") return "PrintScreen";
  if (/^Alpha[0-9]$/.test(c)) return c.slice(5);
  if (/^Keypad[0-9]$/.test(c)) return "Numpad" + c.slice(6);
  const kp: Record<string, string> = { KeypadMultiply: "NumpadMultiply", KeypadPlus: "NumpadAdd", KeypadMinus: "NumpadSubtract", KeypadPeriod: "NumpadDecimal", KeypadDivide: "NumpadDivide", Return: "Enter", Mouse2: "Mouse3", Mouse3: "Mouse4", Mouse4: "Mouse5" };
  if (kp[c]) return kp[c];
  if (["Insert", "Home", "PageUp", "PageDown", "End", "Delete", "CapsLock", "Tab", "Space", "Backspace", "ScrollLock", "Pause"].includes(c)) return c;
  if (/^[A-Z]$/.test(c)) return c;
  return null;
}
const TRANSIT_RE = /RaidId:(?<id>[0-9a-f]{24}).*Locations:(?<locs>[^|]*)$/;

export function parseLogLine(line: string): LogEvent | null {
  // The input config is dumped as a bare JSON line: no stamp, no "|application|" prefix.
  if (line.includes('"keyName":"MakeScreenshot"')) {
    const codes = (SHOT_BIND_RE.exec(line)?.groups?.codes ?? "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const raw = codes.join("+");
    return { type: "binds", screenshotKey: codes.length === 1 ? unityKeyToName(codes[0]) : null, raw };
  }
  let cut = line.indexOf("|application|");
  if (cut >= 0) cut += "|application|".length;
  else return null;
  const body = line.slice(cut);
  if (body.startsWith("TRACE-NetworkGameCreate") || body.startsWith("TRACE-NetworkGameJoin")) {
    const loc = LOCATION_RE.exec(body)?.groups?.loc;
    if (!loc) return null;
    return {
      type: "location",
      location: loc,
      mapKey: mapKeyForLocation(loc),
      online: body.includes("RaidMode: Online"),
      raidId: RAID_ID_RE.exec(body)?.groups?.id,
    };
  }
  if (body.startsWith("scene preset path:")) {
    const loc = SCENE_RE.exec(body)?.groups?.loc;
    const mapKey = loc ? mapKeyForLocation(loc) : null;
    if (!loc || !mapKey) return null;
    return { type: "location", location: loc, mapKey, online: true, raidId: undefined };
  }
  if (body.startsWith("[Transit]")) {
    const m = TRANSIT_RE.exec(body);
    const locs = (m?.groups?.locs ?? "").split("->").map((x) => x.trim()).filter(Boolean);
    const loc = locs[locs.length - 1];
    const mapKey = loc ? mapKeyForLocation(loc) : null;
    if (!loc || !mapKey) return null;
    return { type: "location", location: loc, mapKey, online: true, raidId: m?.groups?.id };
  }
  if (body.startsWith("Matching with group id")) return { type: "matching" };
  if (body.startsWith("LocationLoaded")) return { type: "loaded" };
  if (body.startsWith("GameStarted")) return { type: "started" };
  if (body.startsWith("Network game matching aborted") || body.startsWith("Network game matching cancelled")) return { type: "aborted" };
  if (body.startsWith("PrepareSelectedProfileLocally") || body.startsWith("CompleteSelectedProfile")) return { type: "profile" };
  const side = /Session mode: (?<mode>\w+)/.exec(body)?.groups?.mode;
  if (side) return { type: "side", side: /scav/i.test(side) ? "scav" : "pmc" };
  return null;
}

/** The kind of a `Got notification | X` line, or null. */
export function notificationKind(line: string): string | null {
  if (!line.includes("|push-notifications|")) return null;
  return NOTIFICATION_RE.exec(line)?.groups?.kind ?? null;
}

/** Epoch ms of a log line's stamp (local time), or `fallback`. */
export function lineTime(line: string, fallback = Date.now()): number {
  const m = STAMP_RE.exec(line);
  if (!m?.groups) return fallback;
  const t = new Date(`${m.groups.date}T${m.groups.time}`).getTime();
  return Number.isFinite(t) ? t : fallback;
}

/** Turn a completed notification (kind + its JSON body) into events. */
export function parseNotification(kind: string, json: unknown, at: number): LogEvent[] {
  const obj = (json ?? {}) as Record<string, unknown>;
  if (kind === "UserMatchOver") {
    const loc = typeof obj.location === "string" ? obj.location : undefined;
    return [{ type: "ended", location: loc, mapKey: loc ? mapKeyForLocation(loc) : null }];
  }
  if (kind === "ChatMessageReceived") {
    const msg = (obj.message ?? {}) as Record<string, unknown>;
    const t = Number(msg.type);
    const tpl = typeof msg.templateId === "string" ? msg.templateId : "";
    const questId = tpl.split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{24}$/i.test(questId)) return [];
    const status: QuestStatus | null = t === 10 ? "started" : t === 11 ? "failed" : t === 12 ? "finished" : null;
    if (!status) return [];
    return [{ type: "quest", questId, status, at }];
  }
  return [];
}

export interface GameState {
  /** Tarkov's MakeScreenshot bind as an app key name; null until the game logged it or when it is a combo. */
  screenshotBind?: string | null;
  screenshotBindRaw?: string | null;
  mapKey: string | null;
  location: string | null;
  raid: RaidState;
  raidId: string | null;
  online: boolean;
  side: "pmc" | "scav";
  /** Epoch ms when GameStarted was seen, for the raid timer. */
  raidStartedAt: number | null;
}

/** Pure reducer: fold a log event into the game state. */
export function reduceState(prev: GameState, ev: LogEvent, at = Date.now()): GameState {
  switch (ev.type) {
    case "location":
      return {
        ...prev,
        mapKey: ev.mapKey ?? prev.mapKey,
        location: ev.location,
        raidId: ev.raidId ?? null,
        online: ev.online,
        raid: prev.raid === "in-raid" ? prev.raid : "loading",
      };
    case "matching":
      return { ...prev, raid: "matching" };
    case "loaded":
      return { ...prev, raid: prev.raid === "in-raid" ? prev.raid : "loading" };
    case "started":
      return { ...prev, raid: "in-raid", raidStartedAt: at };
    case "ended":
      return { ...prev, raid: "menu", raidId: null, raidStartedAt: null };
    case "aborted":
      return { ...prev, raid: "menu" };
    case "profile":
      return prev.raid === "in-raid" ? { ...prev, raid: "menu", raidId: null, raidStartedAt: null } : prev;
    case "side":
      return { ...prev, side: ev.side };
    case "quest":
      return prev;
    case "binds":
      return { ...prev, screenshotBind: ev.screenshotKey, screenshotBindRaw: ev.raw };
  }
}

export const INITIAL_STATE: GameState = { mapKey: null, location: null, raid: "menu", raidId: null, online: false, side: "pmc", raidStartedAt: null };

/** Newest `log_*` folder under a Logs directory, by name (they embed the timestamp). */
export function newestLogFolder(logsDir: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(logsDir).filter((d) => d.startsWith("log_"));
  } catch {
    return null;
  }
  if (dirs.length === 0) return null;
  dirs.sort();
  return join(logsDir, dirs[dirs.length - 1]);
}

/** Every `log_*` folder, oldest first. */
export function allLogFolders(logsDir: string): string[] {
  try {
    return readdirSync(logsDir)
      .filter((d) => d.startsWith("log_"))
      .sort()
      .map((d) => join(logsDir, d));
  } catch {
    return [];
  }
}

/** The application log first, then the push-notifications log. */
export function logsIn(folder: string): string[] {
  try {
    const names = readdirSync(folder);
    const app = names.find((n) => /application(_\d+)?\.log$/i.test(n));
    const push = names.find((n) => /push-notifications(_\d+)?\.log$/i.test(n));
    return [app, push].filter((n): n is string => Boolean(n)).map((n) => join(folder, n));
  } catch {
    return [];
  }
}

/** Resolve `<install>\build\Logs` or `<install>\Logs`. */
export function logsDirFor(installPath: string): string | null {
  for (const c of [join(installPath, "build", "Logs"), join(installPath, "Logs")]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Stateful line parser: single-line application events plus multi-line
 * notification JSON bodies. Pure apart from its own buffer.
 */
export class LogParser {
  private pendingKind: string | null = null;
  private pendingAt = 0;
  private buf: string[] = [];
  private depth = 0;

  feed(line: string): LogEvent[] {
    if (this.pendingKind) {
      this.buf.push(line);
      for (const ch of line) {
        if (ch === "{") this.depth++;
        else if (ch === "}") this.depth--;
      }
      if (this.depth <= 0 && this.buf.length > 0) {
        const kind = this.pendingKind;
        const at = this.pendingAt;
        const text = this.buf.join("\n");
        this.pendingKind = null;
        this.buf = [];
        this.depth = 0;
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return parseNotification(kind, json, at);
      }
      return [];
    }
    const kind = notificationKind(line);
    if (kind) {
      this.pendingKind = kind;
      this.pendingAt = lineTime(line);
      this.buf = [];
      this.depth = 0;
      return [];
    }
    const ev = parseLogLine(line);
    return ev ? [ev] : [];
  }
}

export interface WatcherOptions {
  logsDir: string;
  pollMs?: number;
  /** Replay the current log from its start on first read (default true), so a
   * raid already in progress is known at launch. */
  replay?: boolean;
}

interface Tail {
  file: string;
  offset: number;
  carry: string;
  parser: LogParser;
}

export class GameWatcher extends EventEmitter {
  state: GameState = { ...INITIAL_STATE };
  private folder: string | null = null;
  private tails: Tail[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: Required<WatcherOptions>;

  constructor(opts: WatcherOptions) {
    super();
    this.opts = { pollMs: 1000, replay: true, ...opts };
  }

  start(): void {
    this.tick(true);
    this.timer = setInterval(() => this.tick(false), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get currentFolder(): string | null {
    return this.folder;
  }

  private tick(first: boolean): void {
    const folder = newestLogFolder(this.opts.logsDir);
    if (folder !== this.folder) {
      this.folder = folder;
      this.tails = [];
      if (!folder) return;
      if (!first) {
        this.state = { ...INITIAL_STATE, side: this.state.side };
        this.emit("state", this.state);
      }
      this.emit("folder", folder);
    }
    if (!this.folder) return;
    for (const file of logsIn(this.folder)) {
      if (this.tails.some((t) => t.file === file)) continue;
      let offset = 0;
      if (first && !this.opts.replay) {
        try {
          offset = statSync(file).size;
        } catch {
          offset = 0;
        }
      }
      this.tails.push({ file, offset, carry: "", parser: new LogParser() });
    }
    for (const t of this.tails) this.read(t);
  }

  private read(t: Tail): void {
    let size = 0;
    try {
      size = statSync(t.file).size;
    } catch {
      return;
    }
    if (size < t.offset) t.offset = 0;
    if (size === t.offset) return;
    const fd = openSync(t.file, "r");
    try {
      const buf = Buffer.alloc(size - t.offset);
      const n = readSync(fd, buf, 0, buf.length, t.offset);
      t.offset += n;
      const chunk = t.carry + buf.subarray(0, n).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      t.carry = lines.pop() ?? "";
      this.ingestLines(lines, t.parser);
    } finally {
      closeSync(fd);
    }
  }

  /** Exposed for tests: feed raw text as if read from one log. */
  ingest(text: string): void {
    let t = this.tails.find((x) => x.file === "<test>");
    if (!t) {
      t = { file: "<test>", offset: 0, carry: "", parser: new LogParser() };
      this.tails.push(t);
    }
    const chunk = t.carry + text;
    const lines = chunk.split(/\r?\n/);
    t.carry = lines.pop() ?? "";
    this.ingestLines(lines, t.parser);
  }

  /** Epoch ms of the newest log line ingested (the log's own stamp) — the health card's "log alive". */
  lastLogAt = 0;

  private ingestLines(lines: string[], parser: LogParser): void {
    for (const line of lines) {
      const at = lineTime(line, 0);
      if (at > this.lastLogAt) this.lastLogAt = at;
      for (const ev of parser.feed(line)) {
        const next = reduceState(this.state, ev, lineTime(line));
        const changed = JSON.stringify(next) !== JSON.stringify(this.state);
        this.state = next;
        this.emit("event", ev);
        if (changed) this.emit("state", this.state);
      }
    }
  }
}

/**
 * One pass over EVERY log folder (oldest first) collecting quest events, so a
 * fresh install knows which quests are started-but-not-finished.
 */
export function scanQuestHistory(logsDir: string): Array<Extract<LogEvent, { type: "quest" }>> {
  const out: Array<Extract<LogEvent, { type: "quest" }>> = [];
  for (const folder of allLogFolders(logsDir)) {
    for (const file of logsIn(folder)) {
      if (!/push-notifications/i.test(file)) continue;
      let text: string;
      try {
        const fd = openSync(file, "r");
        try {
          const size = statSync(file).size;
          const buf = Buffer.alloc(size);
          readSync(fd, buf, 0, size, 0);
          text = buf.toString("utf8");
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const parser = new LogParser();
      for (const line of text.split(/\r?\n/)) {
        for (const ev of parser.feed(line)) if (ev.type === "quest") out.push(ev);
      }
    }
  }
  return out;
}
