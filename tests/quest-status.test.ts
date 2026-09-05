import { describe, expect, it } from "vitest";
import type { QuestBook, TaskDef } from "../src/quests.js";
import { EMPTY_PROGRESS, allObjectivesOnMap, impliedFinished, questStates, setObjective, tickExtract, tickVisits } from "../src/quest-status.js";

const T: TaskDef[] = [
  { id: "q0", name: "Debut", trader: { id: "t", name: "Prapor" }, map: { normalizedName: "customs" }, objectives: [{ id: "o0", type: "shoot", description: "Kill 5 scavs" }] },
  { id: "q1", name: "Checking", trader: { id: "t", name: "Prapor" }, map: { normalizedName: "customs" }, taskRequirements: [{ task: "q0", status: ["complete"] }], minPlayerLevel: 2, objectives: [
    { id: "o1", type: "visit", description: "Locate the bridge", zones: [{ position: { x: 10, y: 0, z: 10 }, outline: [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, { x: 20, y: 0, z: 20 }, { x: 0, y: 0, z: 20 }] }] },
    { id: "o1b", type: "extract", description: "Survive and extract", zones: [{ position: { x: 100, y: 0, z: 100 } }] },
  ] },
  { id: "q2", name: "Shootout", trader: { id: "t", name: "Prapor" }, map: null, taskRequirements: [{ task: "q1", status: ["complete"] }], objectives: [{ id: "o2", type: "shoot", description: "Kill PMCs", maps: [{ normalizedName: "customs" }] }] },
  { id: "q3", name: "Side job", trader: { id: "t", name: "Skier" }, map: { normalizedName: "woods" }, taskRequirements: [{ task: "q1", status: ["active", "complete"] }], objectives: [] },
];

describe("quest states", () => {
  it("a started quest implies its chain, locks what follows, opens what only needs it active", () => {
    const book: QuestBook = { q1: { questId: "q1", status: "started", at: 5 } };
    expect([...impliedFinished(book, T, new Set())]).toEqual(["q0"]);
    expect(questStates(T, book, new Set())).toEqual({ q0: "done", q1: "active", q2: "locked", q3: "available" });
  });
  it("finished, failed, manual done and a fresh install", () => {
    expect(questStates(T, {}, new Set())).toEqual({ q0: "available", q1: "locked", q2: "locked", q3: "locked" });
    expect(questStates(T, { q1: { questId: "q1", status: "finished", at: 1 } }, new Set()).q2).toBe("available");
    expect(questStates(T, { q1: { questId: "q1", status: "failed", at: 1 } }, new Set()).q1).toBe("failed");
    expect(questStates(T, {}, new Set(["q1"]))).toMatchObject({ q0: "done", q1: "done", q2: "available" });
  });
});

describe("objectives on a map with state", () => {
  const book: QuestBook = { q1: { questId: "q1", status: "started", at: 5 } };
  const states = questStates(T, book, new Set());
  it("lists every quest by state and honours includeDone", () => {
    const all = allObjectivesOnMap(T, states, EMPTY_PROGRESS, "customs", true);
    expect(all.map((o) => [o.objectiveId, o.status, o.position ? "pos" : "-"])).toEqual([["o0", "done", "-"], ["o1", "active", "pos"], ["o1b", "active", "pos"], ["o2", "locked", "-"]]);
    expect(allObjectivesOnMap(T, states, EMPTY_PROGRESS, "customs", false).map((o) => o.objectiveId)).toEqual(["o1", "o1b", "o2"]);
    expect(allObjectivesOnMap(T, states, EMPTY_PROGRESS, "woods", true)).toEqual([]);
    expect(all[1]).toMatchObject({ minPlayerLevel: 2, done: false, optional: false, questName: "Checking" });
  });
  it("ticks a visit once from a fix inside the zone, never for other types, and extracts at raid end", () => {
    const all = allObjectivesOnMap(T, states, EMPTY_PROGRESS, "customs", false);
    const miss = tickVisits(all, { x: 50, z: 50 }, EMPTY_PROGRESS, 1);
    expect(miss.newlyDone).toEqual([]);
    const hit = tickVisits(all, { x: 5, z: 5 }, EMPTY_PROGRESS, 2);
    expect(hit.newlyDone).toEqual(["o1"]);
    expect(hit.progress.done.o1).toEqual({ at: 2, by: "auto" });
    const again = tickVisits(allObjectivesOnMap(T, states, hit.progress, "customs", false), { x: 5, z: 5 }, hit.progress, 3);
    expect(again.newlyDone).toEqual([]);
    expect(tickExtract(all, { x: 110, z: 95 }, EMPTY_PROGRESS, 4).newlyDone).toEqual(["o1b"]);
    expect(tickExtract(all, { x: 200, z: 200 }, EMPTY_PROGRESS, 4).newlyDone).toEqual([]);
    expect(tickExtract(all, null, EMPTY_PROGRESS, 4).newlyDone).toEqual([]);
    const manual = setObjective(EMPTY_PROGRESS, "o2", true, 9);
    expect(manual.done.o2).toEqual({ at: 9, by: "manual" });
    expect(setObjective(manual, "o2", false, 10).done).toEqual({});
  });
});
