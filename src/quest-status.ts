/**
 * Quest state and objective progress — what the game told us, what we can prove ourselves, what he ticked.
 *
 *   • The game's notifications say started / failed / finished per quest (game-watcher). Nothing in the
 *     logs carries objective counters (2/5) or the player's level — every surface says so.
 *   • A started or finished quest implies its prerequisites are finished (impliedFinished), which is the
 *     only way "locked" is right on an install whose logs do not reach back to the start of the wipe.
 *   • "visit" objectives are proved by his own position entering the zone (tickVisits); "extract"
 *     objectives by where he stood when the raid ended (tickExtract). Everything else is a manual tick.
 *
 * Pure except the two file helpers; tests in tests/quest-status.test.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { insideZone, objectiveZonesOnMap, traderPortrait, type MapObjective, type QuestBook, type TaskDef } from "./quests.js";

export type QuestState = "active" | "available" | "locked" | "done" | "failed";

export interface QuestProgress {
  version: 1;
  done: Record<string, { at: number; by: "auto" | "manual" }>;
}
export const EMPTY_PROGRESS: QuestProgress = { version: 1, done: {} };

/** Quests finished for sure: the book says so, he ticked it, or a later quest in its chain was started. */
export function impliedFinished(book: QuestBook, tasks: TaskDef[], manualDone: Set<string>): Set<string> {
  const finished = new Set<string>(manualDone);
  for (const q of Object.values(book)) if (q.status === "finished") finished.add(q.questId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack: string[] = [];
  for (const q of Object.values(book)) if (q.status === "started" || q.status === "finished") stack.push(q.questId);
  for (const id of manualDone) stack.push(id);
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of byId.get(id)?.taskRequirements ?? []) {
      if (!r.status.includes("complete") && !r.status.includes("active")) continue;
      if (r.status.includes("complete") && !r.status.includes("active")) finished.add(r.task);
      stack.push(r.task);
    }
  }
  return finished;
}

export function questState(t: TaskDef, book: QuestBook, finished: Set<string>): QuestState {
  if (finished.has(t.id)) return "done";
  const rec = book[t.id];
  if (rec?.status === "failed") return "failed";
  if (rec?.status === "started") return "active";
  for (const r of t.taskRequirements ?? []) {
    const ok = (r.status.includes("complete") && finished.has(r.task)) || (r.status.includes("active") && (finished.has(r.task) || book[r.task]?.status === "started")) || (r.status.includes("failed") && book[r.task]?.status === "failed");
    if (!ok) return "locked";
  }
  return "available";
}

export function questStates(tasks: TaskDef[], book: QuestBook, manualDone: Set<string>): Record<string, QuestState> {
  const finished = impliedFinished(book, tasks, manualDone);
  const out: Record<string, QuestState> = {};
  for (const t of tasks) out[t.id] = questState(t, book, finished);
  return out;
}

export interface MapObjectiveEx extends MapObjective {
  status: QuestState;
  done: boolean;
  doneBy?: "auto" | "manual";
  optional: boolean;
  minPlayerLevel?: number;
  wikiLink?: string;
  kappaRequired?: boolean;
  items?: string[];
  foundInRaid?: boolean;
  count?: number;
}

/** Every objective on the map, whatever the quest's state (`includeDone` = keep done/failed quests too). */
export function allObjectivesOnMap(tasks: TaskDef[], states: Record<string, QuestState>, progress: QuestProgress, mapNormalizedName: string, includeDone: boolean): MapObjectiveEx[] {
  const out: MapObjectiveEx[] = [];
  for (const t of tasks) {
    const status = states[t.id] ?? "available";
    if (!includeDone && (status === "done" || status === "failed")) continue;
    for (const o of t.objectives ?? []) {
      const { onMap, zones } = objectiveZonesOnMap(t, o, mapNormalizedName);
      if (!onMap) continue;
      const d = progress.done[o.id];
      const base: Omit<MapObjectiveEx, "position"> = {
        questId: t.id, questName: t.name, trader: { id: t.trader.id, name: t.trader.name, portrait: traderPortrait(t.trader.id) },
        objectiveId: o.id, type: o.type, description: o.description,
        item: o.item ? { name: o.item.name, iconLink: o.item.iconLink, count: o.count } : o.questItem ? { name: o.questItem.name } : undefined,
        status, done: Boolean(d), doneBy: d?.by, optional: Boolean(o.optional), minPlayerLevel: t.minPlayerLevel, wikiLink: t.wikiLink, kappaRequired: t.kappaRequired,
        items: o.items, foundInRaid: o.foundInRaid, count: o.count,
      };
      if (zones.length === 0) out.push({ ...base, position: null });
      else for (const z of zones) out.push({ ...base, position: z.position, outline: z.outline });
    }
  }
  return out;
}

const tick = (progress: QuestProgress, ids: string[], now: number, by: "auto" | "manual"): QuestProgress => {
  if (!ids.length) return progress;
  const done = { ...progress.done };
  for (const id of ids) done[id] = { at: now, by };
  return { version: 1, done };
};

/** "visit" objectives of active quests whose zone his position is inside — proof from his own fix. */
export function tickVisits(objs: MapObjectiveEx[], fix: { x: number; z: number }, progress: QuestProgress, now: number, radius = 6): { progress: QuestProgress; newlyDone: string[] } {
  const newlyDone: string[] = [];
  for (const o of objs) {
    if (o.type !== "visit" || o.status !== "active" || o.done || !o.position || newlyDone.includes(o.objectiveId)) continue;
    if (insideZone(fix, { position: o.position, outline: o.outline }, radius)) newlyDone.push(o.objectiveId);
  }
  return { progress: tick(progress, newlyDone, now, "auto"), newlyDone };
}

/** "extract" objectives of active quests: the raid ended while he stood within `radius` of the objective's spot. */
export function tickExtract(objs: MapObjectiveEx[], lastFix: { x: number; z: number } | null, progress: QuestProgress, now: number, radius = 25): { progress: QuestProgress; newlyDone: string[] } {
  const newlyDone: string[] = [];
  if (lastFix) for (const o of objs) {
    if (o.type !== "extract" || o.status !== "active" || o.done || !o.position || newlyDone.includes(o.objectiveId)) continue;
    if (insideZone(lastFix, { position: o.position, outline: o.outline }, radius)) newlyDone.push(o.objectiveId);
  }
  return { progress: tick(progress, newlyDone, now, "auto"), newlyDone };
}

export function setObjective(progress: QuestProgress, objectiveId: string, done: boolean, now: number): QuestProgress {
  if (!done) { const rest = { ...progress.done }; delete rest[objectiveId]; return { version: 1, done: rest }; }
  return tick(progress, [objectiveId], now, "manual");
}

export function readProgress(file: string): QuestProgress {
  try {
    if (!existsSync(file)) return EMPTY_PROGRESS;
    const p = JSON.parse(readFileSync(file, "utf8")) as QuestProgress;
    return p && typeof p.done === "object" && p.done ? { version: 1, done: p.done } : EMPTY_PROGRESS;
  } catch { return EMPTY_PROGRESS; }
}

export function writeProgress(file: string, p: QuestProgress): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(p));
  renameSync(tmp, file);
}
