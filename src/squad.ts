/**
 * Squad sharing: each member broadcasts their OWN fixes and pings to the
 * others. LAN UDP broadcast on one port, gated by a squad code and the
 * raid id (both must match). Nothing is sent outside a raid, nothing is
 * stored, and nothing about anyone who isn't running the app exists here.
 */
import { createSocket, type Socket } from "node:dgram";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

export const SQUAD_PORT = 41277;

export interface SquadFix {
  kind: "fix";
  squad: string;
  raidId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  floor: string | null;
  at: number;
}

export interface SquadPing {
  kind: "ping";
  squad: string;
  raidId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  text: string;
  at: number;
  /** ms after which receivers drop it */
  ttlMs: number;
}

export interface SquadStatus {
  kind: "status";
  squad: string;
  raidId: string;
  name: string;
  flag: string;
  at: number;
}

export type SquadMessage = SquadFix | SquadPing | SquadStatus;

/** Squad codes are hashed on the wire so a sniffer can't learn the code itself. */
export function squadTag(code: string): string {
  return createHash("sha256").update(`tarkovmap:${code.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

export function encode(msg: SquadMessage): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, ...msg }), "utf8");
}

export function decode(buf: Buffer): SquadMessage | null {
  try {
    const o = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    if (o.v !== 1 || typeof o.kind !== "string" || typeof o.squad !== "string" || typeof o.name !== "string") return null;
    if (o.kind !== "fix" && o.kind !== "ping" && o.kind !== "status") return null;
    if (o.kind !== "status" && ![o.x, o.y, o.z].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return o as unknown as SquadMessage;
  } catch {
    return null;
  }
}

/** Should a received message be shown? Same squad, same raid, not from me. */
export function accepts(msg: SquadMessage, mySquadTag: string, myRaidId: string | null, myName: string): boolean {
  if (msg.squad !== mySquadTag) return false;
  if (msg.name === myName) return false;
  if (!myRaidId || msg.raidId !== myRaidId) return false;
  return true;
}

export interface Teammate {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  floor: string | null;
  at: number;
  flag?: string;
  moving: boolean;
}

export interface SquadState {
  mates: Record<string, Teammate>;
  pings: SquadPing[];
}

export function foldSquad(state: SquadState, msg: SquadMessage, now = Date.now()): SquadState {
  if (msg.kind === "fix") {
    const prev = state.mates[msg.name];
    const moving = prev ? Math.hypot(prev.x - msg.x, prev.z - msg.z) > 0.5 : false;
    return { ...state, mates: { ...state.mates, [msg.name]: { name: msg.name, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, floor: msg.floor, at: msg.at, flag: prev?.flag, moving } } };
  }
  if (msg.kind === "status") {
    const prev = state.mates[msg.name];
    if (!prev) return state;
    return { ...state, mates: { ...state.mates, [msg.name]: { ...prev, flag: msg.flag } } };
  }
  const pings = [...state.pings.filter((p) => !(p.name === msg.name && p.text === msg.text)), msg].filter((p) => p.at + p.ttlMs > now);
  return { ...state, pings };
}

/** Drop stale mates (no fix for `staleMs`) and expired pings. */
export function pruneSquad(state: SquadState, now = Date.now(), staleMs = 60000): SquadState {
  const mates: Record<string, Teammate> = {};
  for (const [k, m] of Object.entries(state.mates)) if (now - m.at < staleMs) mates[k] = m;
  return { mates, pings: state.pings.filter((p) => p.at + p.ttlMs > now) };
}

export class SquadLink extends EventEmitter {
  private sock: Socket | null = null;
  private tag = "";
  state: SquadState = { mates: {}, pings: [] };

  constructor(private readonly me: () => { name: string; raidId: string | null }) {
    super();
  }

  start(code: string): void {
    this.stop();
    this.tag = squadTag(code);
    const s = createSocket({ type: "udp4", reuseAddr: true });
    s.on("message", (buf) => {
      const msg = decode(buf);
      if (!msg) return;
      const me = this.me();
      if (!accepts(msg, this.tag, me.raidId, me.name)) return;
      this.state = foldSquad(this.state, msg);
      this.emit("update", this.state);
    });
    s.on("error", (e) => this.emit("log", `squad: ${e.message}`));
    s.bind(SQUAD_PORT, () => {
      try {
        s.setBroadcast(true);
      } catch {
        /* not fatal */
      }
    });
    this.sock = s;
  }

  stop(): void {
    this.sock?.close();
    this.sock = null;
    this.state = { mates: {}, pings: [] };
  }

  get active(): boolean {
    return this.sock !== null;
  }

  private send(msg: SquadMessage): void {
    if (!this.sock) return;
    const buf = encode(msg);
    this.sock.send(buf, 0, buf.length, SQUAD_PORT, "255.255.255.255");
  }

  shareFix(f: { x: number; y: number; z: number; yaw: number; floor: string | null }): void {
    const me = this.me();
    if (!me.raidId) return;
    this.send({ kind: "fix", squad: this.tag, raidId: me.raidId, name: me.name, ...f, at: Date.now() });
  }

  ping(p: { x: number; y: number; z: number; text: string; ttlMs?: number }): SquadPing | null {
    const me = this.me();
    if (!me.raidId) return null;
    const msg: SquadPing = { kind: "ping", squad: this.tag, raidId: me.raidId, name: me.name, x: p.x, y: p.y, z: p.z, text: p.text, at: Date.now(), ttlMs: p.ttlMs ?? 5 * 60000 };
    this.send(msg);
    return msg;
  }

  status(flag: string): void {
    const me = this.me();
    if (!me.raidId) return;
    this.send({ kind: "status", squad: this.tag, raidId: me.raidId, name: me.name, flag, at: Date.now() });
  }

  prune(): void {
    const next = pruneSquad(this.state);
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next;
      this.emit("update", this.state);
    }
  }
}
