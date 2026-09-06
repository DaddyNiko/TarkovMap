import { describe, expect, it } from "vitest";
import type { TaskDef } from "../src/quests.js";
import type { QuestState } from "../src/quest-status.js";
import { phaseFor, progression } from "../src/progression.js";

const q = (id: string, name: string, trader: string, extra: Partial<TaskDef> = {}): TaskDef => ({ id, name, trader: { id: trader, name: trader }, map: null, objectives: [{ id: `${id}-o1`, type: "shoot", description: "x" }, { id: `${id}-o2`, type: "visit", description: "y" }], ...extra });
const req = (...ids: string[]) => ids.map((task) => ({ task, status: ["complete"] }));

// Prapor: a → b → c → Collector ; Skier: s1 → s2 ; Mechanic: np1 → np2 → ga (Lightkeeper) ; loose: x (kappaRequired flag only)
const T: TaskDef[] = [
  q("a", "Debut", "Prapor", { minPlayerLevel: 1 }),
  q("b", "Checking", "Prapor", { minPlayerLevel: 2, taskRequirements: req("a") }),
  q("c", "Shootout", "Prapor", { minPlayerLevel: 5, taskRequirements: req("b") }),
  q("col", "Collector", "Fence", { minPlayerLevel: 62, taskRequirements: req("c", "s2") }),
  q("s1", "Side 1", "Skier", { minPlayerLevel: 3 }),
  q("s2", "Side 2", "Skier", { minPlayerLevel: 14, taskRequirements: req("s1") }),
  q("np1", "Network Provider - Part 1", "Mechanic", { minPlayerLevel: 20 }),
  q("np2", "Network Provider - Part 2", "Mechanic", { minPlayerLevel: 20, taskRequirements: req("np1") }),
  q("ga", "Getting Acquainted", "Mechanic", { minPlayerLevel: 20, taskRequirements: req("np2") }),
  q("x", "Loose", "Ragman", { minPlayerLevel: 8, kappaRequired: true }),
];

describe("progression", () => {
  it("fresh wipe: level 1, early, everything ahead", () => {
    const st: Record<string, QuestState> = { a: "available", b: "locked", c: "locked", col: "locked", s1: "available", s2: "locked", np1: "available", np2: "locked", ga: "locked", x: "available" };
    const p = progression(T, st);
    expect(p).toMatchObject({ total: 10, done: 0, active: 0, available: 4, locked: 6, levelAtLeast: 1, phase: "early" });
    const kappa = p.tracks.find((t) => t.key === "kappa")!;
    // Collector closure (a b c col s1 s2) plus the flagged loose quest
    expect(kappa).toMatchObject({ goal: "Collector", goalLevel: 62, total: 7, done: 0, chainLeft: 4, goalDone: false });
    expect(kappa.nextUp).toEqual(["Debut", "Side 1", "Loose"]);
    expect(kappa.goalTrader).toEqual({ id: "Fence", name: "Fence" });
    const lk = p.tracks.find((t) => t.key === "lightkeeper")!;
    expect(lk).toMatchObject({ goal: "Getting Acquainted", total: 3, chainLeft: 3, goalTrader: { id: "Mechanic", name: "Mechanic" } });
    expect(p.traders.find((t) => t.name === "Prapor")).toMatchObject({ id: "Prapor", total: 3 });
    expect(p.nextUp[0]).toMatchObject({ traderId: "Prapor", map: null, minPlayerLevel: 1 });
    expect(p.nextUp.map((n) => n.name)).toEqual(["Debut", "Side 1", "Loose", "Network Provider - Part 1"]);
  });
  it("mid-wipe: level bound from confirmed quests, unlock counts, chain shrinks, trader split", () => {
    const st: Record<string, QuestState> = { a: "done", b: "done", c: "active", col: "locked", s1: "done", s2: "active", np1: "done", np2: "active", ga: "locked", x: "done" };
    const p = progression(T, st, (o) => o === "c-o1");
    expect(p.levelAtLeast).toBe(20);
    expect(p.phase).toBe("late"); // 5 of 10 done outranks level 20
    expect(p.done).toBe(5);
    const kappa = p.tracks.find((t) => t.key === "kappa")!;
    expect(kappa).toMatchObject({ done: 4, active: 2, chainLeft: 2 });
    expect(p.traders.find((t) => t.name === "Prapor")).toMatchObject({ total: 3, done: 2, active: 1 });
    const c = p.activeQuests.find((a) => a.id === "c")!;
    expect(c).toMatchObject({ unlocks: 1, objectivesDone: 1, objectivesTotal: 2, kappa: true, lightkeeper: false, traderId: "Prapor", minPlayerLevel: 5 });
    expect(p.activeQuests.find((a) => a.id === "np2")).toMatchObject({ unlocks: 1, lightkeeper: true, kappa: false });
  });
  it("kappa done", () => {
    const st = Object.fromEntries(T.map((t) => [t.id, "done" as QuestState]));
    const p = progression(T, st);
    expect(p.tracks[0]).toMatchObject({ goalDone: true, chainLeft: 0, done: 7 });
    expect(p.phase).toBe("endgame");
  });
  it("phase thresholds by level or by share done", () => {
    expect(phaseFor(1, 0).phase).toBe("early");
    expect(phaseFor(12, 0).phase).toBe("mid");
    expect(phaseFor(1, 0.5).phase).toBe("late");
    expect(phaseFor(45, 0).phase).toBe("endgame");
  });
  it("survives a requirement cycle and missing tasks", () => {
    const C: TaskDef[] = [q("p", "P", "T", { taskRequirements: req("r", "ghost") }), q("r", "R", "T", { taskRequirements: req("p") })];
    const p = progression(C, { p: "available", r: "locked" });
    expect(p.total).toBe(2);
    expect(p.activeQuests).toEqual([]);
  });
});

import { whyContext, whyItMatters } from "../src/progression.js";
describe("why it matters", () => {
  const ctx = whyContext(T);
  const by = (n: string) => T.find((t) => t.name === n)!;
  it("names what a quest opens and the road it is on", () => {
    expect(whyItMatters(by("Debut"), ctx)).toBe("Needed for Kappa. Opens Checking, with 3 quests behind it in all.");
    expect(whyItMatters(by("Collector"), ctx)).toBe("The Kappa quest itself — the secure container is the reward. End of its line — nothing waits on it.");
    expect(whyItMatters(by("Getting Acquainted"), ctx)).toBe("Unlocks Lightkeeper as a trader. End of its line — nothing waits on it.");
    expect(whyItMatters(by("Network Provider - Part 1"), ctx)).toBe("On the road to Lightkeeper. Opens Network Provider - Part 2, with 2 quests behind it in all.");
    expect(whyItMatters(by("Loose"), ctx)).toBe("Needed for Kappa. End of its line — nothing waits on it.");
  });
  it("data-supplied trader unlocks win over the name table", () => {
    expect(whyItMatters({ ...by("Loose"), unlocksTraders: ["Ref"] }, ctx)).toMatch(/^Unlocks Ref as a trader\./);
  });
});
