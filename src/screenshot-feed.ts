/**
 * Player position from Escape from Tarkov's own screenshot filenames.
 *
 * The game names every in-game screenshot with the player's position and
 * facing (it is how BSG's bug reports carry a location):
 *
 *   2026-09-04[02-40]_-118.23, 1.91, 227.54_0.0, 0.93, 0.0, 0.36_12.60 (0).png
 *   <date>[<time>]_<x>, <y>, <z>_<qx>, <qy>, <qz>, <qw>_<fov> (<n>).png
 *
 * We only ever read the NAME. The PNG itself is deleted after parsing unless
 * the user asks to keep it (they are 5–8 MB each at 1440p).
 */
import { watch, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { yawFromQuaternion } from "./map-data.js";

export interface PlayerFix {
  x: number;
  y: number;
  z: number;
  /** degrees, 0 = game +Z, clockwise */
  yaw: number;
  /** The raw camera rotation quaternion, for projecting tags onto the screen. */
  q: [number, number, number, number];
  file: string;
  at: number;
}

const NAME_RE = /^\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]_?(?<body>.+) \(\d+\)\.png$/i;
const POS_RE =
  /(?<x>-?\d+\.\d+), (?<y>-?\d+\.\d+), (?<z>-?\d+\.\d+)_?(?<rx>-?\d+\.\d+), (?<ry>-?\d+\.\d+), (?<rz>-?\d+\.\d+), (?<rw>-?\d+\.\d+)/;

export function parseScreenshotName(name: string, at = Date.now()): PlayerFix | null {
  const m = NAME_RE.exec(name);
  if (!m?.groups) return null;
  const p = POS_RE.exec(m.groups.body);
  if (!p?.groups) return null;
  const n = (k: string) => Number.parseFloat(p.groups![k]);
  const fix = { x: n("x"), y: n("y"), z: n("z") };
  if (![fix.x, fix.y, fix.z].every(Number.isFinite)) return null;
  return {
    ...fix,
    yaw: yawFromQuaternion(n("rx"), n("ry"), n("rz"), n("rw")),
    q: [n("rx"), n("ry"), n("rz"), n("rw")],
    file: name,
    at,
  };
}

export interface FeedOptions {
  folder: string;
  /** Delete the PNG once its name has been read (default true). */
  deleteAfterRead?: boolean;
  /** Poll interval fallback when fs.watch misses events (ms). */
  pollMs?: number;
}

/**
 * Watches the screenshots folder and emits `fix` for every new screenshot.
 * fs.watch on Windows is reliable for creates, but the game writes the file
 * in two steps (create, then fill), so deletion waits until the size is stable.
 */
export class ScreenshotFeed extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private readonly opts: Required<FeedOptions>;

  constructor(opts: FeedOptions) {
    super();
    this.opts = { deleteAfterRead: true, pollMs: 1500, ...opts };
  }

  get folder(): string {
    return this.opts.folder;
  }

  /** Files in the folder that the game wrote (never anything else), with total bytes. */
  stats(): { files: number; bytes: number } {
    let files = 0, bytes = 0;
    for (const f of safeList(this.opts.folder)) {
      if (!NAME_RE.test(f)) continue;
      files++;
      try {
        bytes += statSync(join(this.opts.folder, f)).size;
      } catch {
        /* vanished */
      }
    }
    return { files, bytes };
  }

  /**
   * Delete every game screenshot in the folder except ones still being
   * written (younger than 3 s). Runs at start and every minute so a crash
   * mid-raid can never leave a pile behind. Only the game's own naming
   * pattern is touched.
   */
  sweep(): number {
    if (!this.opts.deleteAfterRead) return 0;
    let n = 0;
    const now = Date.now();
    for (const f of safeList(this.opts.folder)) {
      if (!NAME_RE.test(f)) continue;
      const p = join(this.opts.folder, f);
      try {
        if (now - statSync(p).mtimeMs < 3000) continue;
        unlinkSync(p);
        n++;
      } catch {
        /* locked or gone */
      }
    }
    if (n) this.emit("swept", n);
    return n;
  }

  private sweeper: NodeJS.Timeout | null = null;

  start(): void {
    const { folder } = this.opts;
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    // Anything already there is old — never replay stale positions, and clear it.
    for (const f of safeList(folder)) this.seen.add(f);
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), 60000);
    try {
      this.watcher = watch(folder, (_ev, name) => {
        if (name) this.consider(String(name));
      });
      this.watcher.on("error", (e) => this.emit("error", e));
    } catch (e) {
      this.emit("error", e);
    }
    this.poll = setInterval(() => {
      for (const f of safeList(folder)) this.consider(f);
    }, this.opts.pollMs);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private consider(name: string): void {
    if (this.seen.has(name)) return;
    if (!/\.png$/i.test(name)) return;
    this.seen.add(name);
    const fix = parseScreenshotName(name);
    if (!fix) return;
    this.emit("fix", fix);
    if (this.opts.deleteAfterRead) this.deleteWhenStable(join(this.opts.folder, name), 0);
  }

  private deleteWhenStable(path: string, lastSize: number, tries = 0): void {
    setTimeout(() => {
      let size = -1;
      try {
        size = statSync(path).size;
      } catch {
        return; // already gone
      }
      if (size > 0 && size === lastSize) {
        try {
          unlinkSync(path);
        } catch (e) {
          if (tries < 10) this.deleteWhenStable(path, size, tries + 1);
          else this.emit("error", e);
        }
        return;
      }
      if (tries < 20) this.deleteWhenStable(path, size, tries + 1);
    }, 700);
  }
}

function safeList(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}
