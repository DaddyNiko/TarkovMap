/**
 * Where he is in the wipe — a summary over the quest tree, computed from the same states the Quests
 * page lists. Pure; tests in tests/progression.test.ts.
 *
 *   • Level is not in the logs, so it is bounded from below: the highest minPlayerLevel among quests
 *     the game says he started or finished.
 *   • "Kappa" is Collector's prerequisite closure plus every task tarkov.dev flags kappaRequired;
 *     "Lightkeeper" the same for Getting Acquainted / Network Provider plus lightkeeperRequired.
 *   • "Chain left" is the longest path of unfinished quests inside a track: the fewest quests he must
 *     finish one after another before the track can close, whatever he does in parallel.
 */
import type { TaskDef } from "./quests.js";
import type { QuestState } from "./quest-status.js";

export type Phase = "early" | "mid" | "late" | "endgame";

export interface TrackProgress {
  key: "kappa" | "lightkeeper";
  name: string;
  /** Final quest of the track when the data has it. */
  goal: string | null;
  goalLevel: number | null;
  total: number;
  done: number;
  active: number;
  /** Longest path of unfinished quests — sequential quests still ahead. */
  chainLeft: number;
  /** Track quests he can accept right now (all prerequisites done), by level. */
  nextUp: string[];
  goalDone: boolean;
  /** Face for the track: the trader who hands out the goal (Lightkeeper himself when the data has him). */
  goalTrader: { id: string; name: string } | null;
}

export interface TraderProgress {
  id: string;
  name: string;
  total: number;
  done: number;
  active: number;
  available: number;
}

/** Traders whose first quest opens them; used when the data carries no traderUnlock rewards. */
const TRADER_UNLOCK_BY_NAME: Record<string, string> = { Introduction: "Jaeger", "Getting Acquainted": "Lightkeeper", "Network Provider - Part 2": "Lightkeeper" };

export interface WhyContext {
  down: Map<string, Set<string>>;
  direct: Map<string, string[]>;
  kappaIds: Set<string>;
  lkIds: Set<string>;
  byId: Map<string, TaskDef>;
}

export function whyContext(tasks: TaskDef[]): WhyContext {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const direct = new Map<string, string[]>();
  for (const t of tasks) for (const r of t.taskRequirements ?? []) (direct.get(r.task) ?? direct.set(r.task, []).get(r.task)!).push(t.id);
  const goal = (names: string[]) => names.map((g) => byName.get(g)).find(Boolean);
  const kg = goal(KAPPA_GOALS), lg = goal(LIGHTKEEPER_GOALS);
  const kappaIds = closure(byId, kg ? [kg.id] : []);
  for (const t of tasks) if (t.kappaRequired) kappaIds.add(t.id);
  const lkIds = closure(byId, lg ? [lg.id] : []);
  for (const t of tasks) if (t.lightkeeperRequired) lkIds.add(t.id);
  return { down: downstream(tasks), direct, kappaIds, lkIds, byId };
}

/** One line on why a quest matters: what it opens, which road it sits on, any trader it unlocks. */
export function whyItMatters(t: TaskDef, ctx: WhyContext): string {
  const parts: string[] = [];
  const traders = t.unlocksTraders?.length ? t.unlocksTraders : TRADER_UNLOCK_BY_NAME[t.name] ? [TRADER_UNLOCK_BY_NAME[t.name]] : [];
  if (traders.length) parts.push(`Unlocks ${traders.join(" and ")} as a trader.`);
  if (t.name === KAPPA_GOALS[0]) parts.push("The Kappa quest itself — the secure container is the reward.");
  else if (ctx.kappaIds.has(t.id)) parts.push("Needed for Kappa.");
  if (ctx.lkIds.has(t.id) && !traders.includes("Lightkeeper")) parts.push("On the road to Lightkeeper.");
  const direct = (ctx.direct.get(t.id) ?? []).map((id) => ctx.byId.get(id)?.name).filter((x): x is string => Boolean(x));
  const total = ctx.down.get(t.id)?.size ?? 0;
  if (direct.length) {
    const shown = direct.slice(0, 3).join(", ") + (direct.length > 3 ? ` +${direct.length - 3}` : "");
    parts.push(total > direct.length ? `Opens ${shown}, with ${total} quests behind it in all.` : `Opens ${shown}.`);
  } else parts.push("End of its line — nothing waits on it.");
  if (t.minPlayerLevel && t.minPlayerLevel >= 30 && !parts.some((p) => p.includes("Kappa"))) parts.push(`Level ${t.minPlayerLevel} quest.`);
  return parts.join(" ");
}

export interface ActiveQuestProgress {
  id: string;
  name: string;
  trader: string;
  traderId: string;
  map: string | null;
  minPlayerLevel: number;
  /** Quests that only open once this one is finished (transitively). */
  unlocks: number;
  objectivesDone: number;
  objectivesTotal: number;
  kappa: boolean;
  lightkeeper: boolean;
  why: string;
}

export interface Progression {
  total: number;
  done: number;
  active: number;
  available: number;
  locked: number;
  pct: number;
  /** Lower bound on his level, from quests the game confirmed. */
  levelAtLeast: number;
  phase: Phase;
  phaseText: string;
  tracks: TrackProgress[];
  traders: TraderProgress[];
  activeQuests: ActiveQuestProgress[];
  /** Quests open right now that are not accepted yet, by level. */
  nextUp: Array<{ id: string; name: string; trader: string; traderId: string; map: string | null; minPlayerLevel: number; kappa: boolean; why: string }>;
}

const KAPPA_GOALS = ["Collector"];
const LIGHTKEEPER_GOALS = ["Getting Acquainted", "Network Provider - Part 2", "Network Provider - Part 1"];

function closure(byId: Map<string, TaskDef>, rootIds: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const r of byId.get(id)!.taskRequirements ?? []) stack.push(r.task);
  }
  return seen;
}

/** Quests that (transitively) require `id` to be complete or active. */
function downstream(tasks: TaskDef[]): Map<string, Set<string>> {
  const children = new Map<string, string[]>();
  for (const t of tasks) for (const r of t.taskRequirements ?? []) (children.get(r.task) ?? children.set(r.task, []).get(r.task)!).push(t.id);
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, path: Set<string>): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const out = new Set<string>();
    for (const c of children.get(id) ?? []) {
      if (path.has(c)) continue;
      out.add(c);
      path.add(c);
      for (const x of visit(c, path)) out.add(x);
      path.delete(c);
    }
    memo.set(id, out);
    return out;
  };
  for (const t of tasks) visit(t.id, new Set([t.id]));
  return memo;
}

/** Longest path (in quests) through unfinished quests of `ids`, following prerequisites. */
function longestChain(byId: Map<string, TaskDef>, ids: Set<string>, finished: (id: string) => boolean): number {
  const memo = new Map<string, number>();
  const depth = (id: string, path: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    const t = byId.get(id);
    if (!t || !ids.has(id) || finished(id)) return 0;
    let best = 0;
    for (const r of t.taskRequirements ?? []) {
      if (path.has(r.task)) continue;
      path.add(r.task);
      best = Math.max(best, depth(r.task, path));
      path.delete(r.task);
    }
    memo.set(id, best + 1);
    return best + 1;
  };
  let best = 0;
  for (const id of ids) best = Math.max(best, depth(id, new Set([id])));
  return best;
}

export function phaseFor(levelAtLeast: number, pct: number): { phase: Phase; text: string } {
  if (levelAtLeast >= 40 || pct >= 0.7) return { phase: "endgame", text: "Endgame — the long chains, Kappa and Lightkeeper are what is left" };
  if (levelAtLeast >= 25 || pct >= 0.45) return { phase: "late", text: "Late game — most traders are open, the map-spanning chains are running" };
  if (levelAtLeast >= 12 || pct >= 0.2) return { phase: "mid", text: "Mid game — the trader lines have branched, Jaeger and Ragman are in play" };
  return { phase: "early", text: "Early game — the opening quests of Prapor, Therapist and Skier" };
}

export function progression(tasks: TaskDef[], states: Record<string, QuestState>, objectiveDone: (objectiveId: string) => boolean = () => false): Progression {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const st = (id: string): QuestState => states[id] ?? "locked";
  const isDone = (id: string) => st(id) === "done";
  const count = (ids: Iterable<string>) => {
    const c = { total: 0, done: 0, active: 0, available: 0, locked: 0 };
    for (const id of ids) {
      c.total++;
      const s = st(id);
      if (s === "done") c.done++;
      else if (s === "active") c.active++;
      else if (s === "available") c.available++;
      else c.locked++;
    }
    return c;
  };

  const all = count(tasks.map((t) => t.id));
  const pct = all.total ? all.done / all.total : 0;
  let levelAtLeast = 1;
  for (const t of tasks) if ((st(t.id) === "done" || st(t.id) === "active") && (t.minPlayerLevel ?? 0) > levelAtLeast) levelAtLeast = t.minPlayerLevel!;
  const ph = phaseFor(levelAtLeast, pct);

  const track = (key: TrackProgress["key"], name: string, goals: string[], flag: (t: TaskDef) => boolean): TrackProgress => {
    const goal = goals.map((g) => byName.get(g)).find(Boolean) ?? null;
    const ids = closure(byId, goal ? [goal.id] : []);
    for (const t of tasks) if (flag(t)) ids.add(t.id);
    const c = count(ids);
    const nextUp = [...ids].filter((id) => st(id) === "available").map((id) => byId.get(id)!).sort((a, b) => (a.minPlayerLevel ?? 0) - (b.minPlayerLevel ?? 0)).slice(0, 6).map((t) => t.name);
    const face = (key === "lightkeeper" ? tasks.find((t) => t.trader.name === "Lightkeeper")?.trader : null) ?? goal?.trader ?? null;
    return { key, name, goal: goal?.name ?? null, goalLevel: goal?.minPlayerLevel ?? null, total: c.total, done: c.done, active: c.active, chainLeft: longestChain(byId, ids, isDone), nextUp, goalDone: goal ? isDone(goal.id) : false, goalTrader: face ? { id: face.id, name: face.name } : null };
  };
  const kappa = track("kappa", "Kappa", KAPPA_GOALS, (t) => Boolean(t.kappaRequired));
  const lightkeeper = track("lightkeeper", "Lightkeeper", LIGHTKEEPER_GOALS, (t) => Boolean(t.lightkeeperRequired));
  const kappaIds = new Set([...closure(byId, kappa.goal ? [byName.get(kappa.goal)!.id] : []), ...tasks.filter((t) => t.kappaRequired).map((t) => t.id)]);
  const lkIds = new Set([...closure(byId, lightkeeper.goal ? [byName.get(lightkeeper.goal)!.id] : []), ...tasks.filter((t) => t.lightkeeperRequired).map((t) => t.id)]);

  const traderMap = new Map<string, TraderProgress>();
  for (const t of tasks) {
    const tp = traderMap.get(t.trader.name) ?? { id: t.trader.id, name: t.trader.name, total: 0, done: 0, active: 0, available: 0 };
    tp.total++;
    const s = st(t.id);
    if (s === "done") tp.done++;
    else if (s === "active") tp.active++;
    else if (s === "available") tp.available++;
    traderMap.set(t.trader.name, tp);
  }
  const traders = [...traderMap.values()].sort((a, b) => b.total - a.total);

  const ctx = whyContext(tasks);
  const down = ctx.down;
  const activeQuests: ActiveQuestProgress[] = tasks
    .filter((t) => st(t.id) === "active")
    .map((t) => ({
      id: t.id, name: t.name, trader: t.trader.name, traderId: t.trader.id, map: t.map?.normalizedName ?? null, minPlayerLevel: t.minPlayerLevel ?? 1,
      unlocks: down.get(t.id)?.size ?? 0,
      objectivesDone: t.objectives.filter((o) => objectiveDone(o.id)).length, objectivesTotal: t.objectives.length,
      kappa: kappaIds.has(t.id), lightkeeper: lkIds.has(t.id), why: whyItMatters(t, ctx),
    }))
    .sort((a, b) => b.unlocks - a.unlocks || a.name.localeCompare(b.name));

  const nextUp = tasks
    .filter((t) => st(t.id) === "available")
    .sort((a, b) => (a.minPlayerLevel ?? 0) - (b.minPlayerLevel ?? 0) || (down.get(b.id)?.size ?? 0) - (down.get(a.id)?.size ?? 0))
    .slice(0, 10)
    .map((t) => ({ id: t.id, name: t.name, trader: t.trader.name, traderId: t.trader.id, map: t.map?.normalizedName ?? null, minPlayerLevel: t.minPlayerLevel ?? 1, kappa: kappaIds.has(t.id), why: whyItMatters(t, ctx) }));

  return { ...all, pct, levelAtLeast, phase: ph.phase, phaseText: ph.text, tracks: [kappa, lightkeeper], traders, activeQuests, nextUp };
}
