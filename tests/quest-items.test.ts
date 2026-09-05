import { describe, expect, it } from "vitest";
import type { TaskDef } from "../src/quests.js";
import { EMPTY_PROGRESS } from "../src/quest-status.js";
import { importance, neededItems, questItemMarkers } from "../src/quest-items.js";

const names = { "gas Name": "Gas analyzer", "salewa Name": "Salewa", "doc Name": "Secure folder" };
const prices = { gas: 40000, salewa: 20000 };
const T: TaskDef[] = [
  { id: "a", name: "Sanitary Standards", trader: { id: "t", name: "Therapist" }, map: null, objectives: [{ id: "a1", type: "giveItem", description: "Hand over 2 gas analyzers", items: ["gas"], count: 2, foundInRaid: true }] },
  { id: "b", name: "Operation Aquarius", trader: { id: "t", name: "Therapist" }, map: null, objectives: [
    { id: "b1", type: "giveItem", description: "Hand over a gas analyzer", items: ["gas"], count: 1 },
    { id: "b2", type: "giveItem", description: "Hand over 3 Salewas", items: ["salewa"], count: 3, foundInRaid: true },
  ] },
  { id: "c", name: "Done one", trader: { id: "t", name: "Prapor" }, map: null, objectives: [{ id: "c1", type: "giveItem", description: "x", items: ["salewa"], count: 9 }] },
  { id: "d", name: "Documents", trader: { id: "t", name: "Prapor" }, map: { normalizedName: "customs" }, objectives: [{ id: "d1", type: "findQuestItem", description: "Find the folder", questItem: { name: "Secure folder", id: "doc" }, zones: [{ position: { x: 1, y: 0, z: 1 } }, { position: { x: 50, y: 0, z: 50 }, map: { normalizedName: "woods" } }] }] },
];
const states = { a: "active" as const, b: "available" as const, c: "done" as const, d: "active" as const };

describe("neededItems", () => {
  it("merges per item across quests, sums counts, FIR if any, skips done quests and ticked objectives", () => {
    const n = neededItems(T, states, EMPTY_PROGRESS, prices, names);
    const gas = n.find((x) => x.id === "gas")!;
    expect(gas).toMatchObject({ name: "Gas analyzer", price: 40000, count: 3, fir: true });
    expect(gas.quests.map((q) => [q.questName, q.status, q.count, q.fir])).toEqual([["Sanitary Standards", "active", 2, true], ["Operation Aquarius", "available", 1, false]]);
    expect(n.find((x) => x.id === "salewa")).toMatchObject({ count: 3, fir: true });
    const ticked = neededItems(T, states, { version: 1, done: { b2: { at: 1, by: "manual" } } }, prices, names);
    expect(ticked.find((x) => x.id === "salewa")).toBeUndefined();
  });
});

describe("importance", () => {
  it("is additive and monotone", () => {
    expect(importance({ count: 1, questsNeeding: 1, fir: false, spawnPointsOnMap: 50, price: 0, activeQuest: false })).toBe(3);
    expect(importance({ count: 3, questsNeeding: 2, fir: true, spawnPointsOnMap: 2, price: 40000, activeQuest: true })).toBe(3 + 4 + 2 + 4 + 4 + 2);
    expect(importance({ count: 99, questsNeeding: 99, fir: true, spawnPointsOnMap: 1, price: 1e9, activeQuest: true })).toBe(5 + 8 + 2 + 4 + 4 + 4);
  });
});

describe("questItemMarkers", () => {
  const features = { lootLoose: [
    { position: { x: 100, y: 0, z: 100 }, items: ["gas", "junk"] },
    { position: { x: 102, y: 0, z: 101 }, items: ["salewa"] }, // same 5 m cell as the point above
    { position: { x: 300, y: 0, z: 300 }, items: ["junk"] },
    { position: { x: 400, y: 0, z: 400 }, items: ["salewa", "salewa"] },
  ] };
  it("places quest-specific items at their spots and needed items at coalesced spawns, most important first", () => {
    const m = questItemMarkers(T, states, EMPTY_PROGRESS, features, "customs", prices, names);
    // gas cell: count 3 + 2 quests×2 + FIR 2 + active 4 + scarcity 4 + 40k → 2 = 19; the folder: 1+2+2+4+4+5 = 18; salewa cell: 3+2+2+0+4+1 = 12
    expect(m.map((x) => [x.kind, x.position.x, x.label, x.importance])).toEqual([
      ["item", 100, "Gas analyzer · Salewa", 19],
      ["questItem", 1, "Secure folder", 18],
      ["item", 400, "Salewa", 12],
    ]);
    const cell = m[0];
    expect(cell.items.map((i) => [i.id, i.spawnPointsOnMap])).toEqual([["gas", 1], ["salewa", 2]]);
    expect(cell.importance).toBe(cell.items[0].importance);
    expect(m[1]).toMatchObject({ objectiveId: "d1", questId: "d", status: "active", done: false });
    expect(m[1].items[0].quests[0].questName).toBe("Documents");
  });
  it("respects the cap and drops nothing when there is no loot data", () => {
    expect(questItemMarkers(T, states, EMPTY_PROGRESS, features, "customs", prices, names, { limit: 1 })).toHaveLength(1);
    expect(questItemMarkers(T, states, EMPTY_PROGRESS, null, "customs", prices, names).map((x) => x.kind)).toEqual(["questItem"]);
    expect(questItemMarkers(T, states, EMPTY_PROGRESS, features, "woods", prices, names).map((x) => x.kind)).toEqual(["item", "questItem", "item"]);
  });
});
