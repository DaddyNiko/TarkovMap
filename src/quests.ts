/**
 * Active quests and their objectives on the current map.
 *
 * Quest lifecycle comes from the game's notification log (see game-watcher);
 * objective positions, trader and portrait come from tarkov.dev `tasks`,
 * cached on disk. Everything here is pure except the fetch/cache helpers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEvent, QuestStatus } from "./game-watcher.js";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TaskZone {
  position: Vec3;
  outline?: Vec3[];
  map?: { normalizedName: string } | null;
}

export interface TaskObjective {
  id: string;
  type: string;
  description: string;
  maps?: Array<{ normalizedName: string }>;
  zones?: TaskZone[];
  item?: { name: string; iconLink?: string } | null;
  count?: number;
  questItem?: { name: string } | null;
}

export interface TaskDef {
  id: string;
  name: string;
  trader: { id: string; name: string };
  map?: { normalizedName: string } | null;
  objectives: TaskObjective[];
  minPlayerLevel?: number;
}

export const TASKS_QUERY = `{
  tasks(lang: en) {
    id name minPlayerLevel
    trader { id name }
    map { normalizedName }
    objectives {
      id type description
      maps { normalizedName }
      ... on TaskObjectiveBasic { zones { map { normalizedName } position { x y z } outline { x y z } } }
      ... on TaskObjectiveShoot { zones { map { normalizedName } position { x y z } } }
      ... on TaskObjectiveUseItem { zones { map { normalizedName } position { x y z } } }
      ... on TaskObjectiveMark { zones { map { normalizedName } position { x y z } } }
      ... on TaskObjectiveQuestItem { questItem { name } zones { map { normalizedName } position { x y z } } }
      ... on TaskObjectiveItem { item { name iconLink } count }
    }
  }
}`;

export interface TaskCache {
  fetchedAt: number;
  tasks: TaskDef[];
}

export function readTaskCache(file: string): TaskCache | null {
  try {
    if (!existsSync(file)) return null;
    const c = JSON.parse(readFileSync(file, "utf8")) as TaskCache;
    return Array.isArray(c?.tasks) ? c : null;
  } catch {
    return null;
  }
}

export function writeTaskCache(file: string, c: TaskCache): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c));
}

export async function fetchTasks(endpoint = "https://api.tarkov.dev/graphql"): Promise<TaskDef[]> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: TASKS_QUERY }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`tarkov.dev ${res.status}`);
  const body = (await res.json()) as { data?: { tasks?: TaskDef[] }; errors?: unknown[] };
  if (!body.data?.tasks) throw new Error(`tarkov.dev: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
  return body.data.tasks;
}

/** Trader portrait URL as served by tarkov.dev's asset host. */
export function traderPortrait(traderId: string): string {
  return `https://assets.tarkov.dev/${traderId}.webp`;
}

// ── Quest state ────────────────────────────────────────────────────────────

export interface QuestRecord {
  questId: string;
  status: QuestStatus;
  at: number;
}

export type QuestBook = Record<string, QuestRecord>;

/** Fold a quest event into the book (latest status wins). */
export function applyQuestEvent(book: QuestBook, ev: Extract<LogEvent, { type: "quest" }>): QuestBook {
  const prev = book[ev.questId];
  if (prev && prev.at > ev.at) return book;
  return { ...book, [ev.questId]: { questId: ev.questId, status: ev.status, at: ev.at } };
}

export function activeQuestIds(book: QuestBook): string[] {
  return Object.values(book)
    .filter((q) => q.status === "started")
    .map((q) => q.questId);
}

export interface MapObjective {
  questId: string;
  questName: string;
  trader: { id: string; name: string; portrait: string };
  objectiveId: string;
  type: string;
  description: string;
  /** null when the objective has no fixed spot (e.g. "kill 5 scavs on Customs"). */
  position: Vec3 | null;
  outline?: Vec3[];
  item?: { name: string; iconLink?: string; count?: number };
}

/**
 * Objectives of the active quests that belong to `mapNormalizedName`:
 * either the objective lists that map, or a zone sits on it, or the quest
 * itself is bound to it and the objective names no map.
 */
export function objectivesOnMap(book: QuestBook, tasks: TaskDef[], mapNormalizedName: string, manualDone: Set<string> = new Set()): MapObjective[] {
  const active = new Set(activeQuestIds(book).filter((id) => !manualDone.has(id)));
  const out: MapObjective[] = [];
  for (const t of tasks) {
    if (!active.has(t.id)) continue;
    const questMap = t.map?.normalizedName ?? null;
    for (const o of t.objectives ?? []) {
      const objMaps = (o.maps ?? []).map((m) => m.normalizedName);
      const impliedHere = objMaps.includes(mapNormalizedName) || (objMaps.length === 0 && questMap === mapNormalizedName);
      const zonesHere = (o.zones ?? []).filter((z) => (z.map ? z.map.normalizedName === mapNormalizedName : impliedHere));
      const onMap = impliedHere || zonesHere.length > 0;
      if (!onMap) continue;
      const base = {
        questId: t.id,
        questName: t.name,
        trader: { id: t.trader.id, name: t.trader.name, portrait: traderPortrait(t.trader.id) },
        objectiveId: o.id,
        type: o.type,
        description: o.description,
        item: o.item ? { name: o.item.name, iconLink: o.item.iconLink, count: o.count } : o.questItem ? { name: o.questItem.name } : undefined,
      };
      if (zonesHere.length === 0) {
        out.push({ ...base, position: null });
      } else {
        for (const z of zonesHere) out.push({ ...base, position: z.position, outline: z.outline });
      }
    }
  }
  return out;
}

/** Metres between two game positions (1 unit = 1 m), ignoring height. */
export function distance2D(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Bearing from a to b in degrees (0 = +Z, clockwise), matching the yaw convention. */
export function bearing(a: { x: number; z: number }, b: { x: number; z: number }): number {
  let deg = (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** True when the point is inside the zone: within `radius` of its position or inside its outline. */
export function insideZone(p: { x: number; z: number }, zone: { position: Vec3; outline?: Vec3[] }, radius = 6): boolean {
  if (zone.outline && zone.outline.length >= 3) return pointInPolygon(p, zone.outline);
  return distance2D(p, zone.position) <= radius;
}

function pointInPolygon(p: { x: number; z: number }, poly: Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    const hit = zi > p.z !== zj > p.z && p.x < ((xj - xi) * (p.z - zi)) / (zj - zi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
