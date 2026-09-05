import { describe, expect, it } from "vitest";
import { bossDisplayName, sptQuestsToTasks, sptToFeatures } from "../src/offline-data.js";

const base = {
  _Id: "56f40101d2720b2a4d8b45d6",
  SpawnPointParams: [
    { Position: { x: 10, y: 0, z: 20 }, Categories: ["Player"], Sides: ["Pmc"], Infiltration: "Customs" },
    { Position: { x: 100, y: 1, z: 200 }, Categories: ["Bot"], Sides: ["Savage"], BotZoneName: "ZoneDormitory" },
    { Position: { x: 120, y: 1, z: 220 }, Categories: ["Bot"], Sides: ["Savage"], BotZoneName: "ZoneDormitory" },
    { Position: { x: 5, y: 30, z: 5 }, Categories: ["Bot"], Sides: ["Savage"], BotZoneName: "ZoneSnipeTower" },
    { Position: { x: 0, y: 0, z: 0 }, Categories: ["Bot"], Sides: ["Savage"], BotZoneName: "ZoneNever" },
  ],
  BossLocationSpawn: [
    { BossName: "bossBully", BossZone: "ZoneDormitory", BossChance: 38, BossEscortType: "followerBully" },
    { BossName: "bossKilla", BossZone: "ZoneNever", BossChance: 0 },
  ],
  exits: [
    { Name: "Crossroads", ExfiltrationType: "Individual", PassageRequirement: "None" },
    { Name: "ZB-1011", PassageRequirement: "None" },
    { Name: "Smugglers Boat", ExfiltrationType: "Individual" },
    { Name: "Transit to Reserve", ExfiltrationType: "Transit" },
    { Name: "Dorms V-Ex", PassageRequirement: "TransferItem" },
  ],
};

describe("sptToFeatures", () => {
  const f = sptToFeatures(base, "customs", [{ name: "Tower", position: { x: 1, y: 2, z: 3 } }]);
  it("splits player spawns from bot spawns and marks sniper zones", () => {
    expect(f.pmcSpawns).toHaveLength(1);
    expect(f.spawns.filter((s) => s.categories.includes("scav"))).toHaveLength(4);
    expect(f.spawns.find((s) => s.zoneName === "ZoneSnipeTower")?.categories).toEqual(["sniper", "scav"]);
  });
  it("places a boss at the centroid of its zone and skips zero-chance bosses", () => {
    expect(f.bosses).toHaveLength(1);
    expect(f.bosses[0]).toMatchObject({ name: "Reshala", chance: 38, position: { x: 110, z: 210 } });
    const marker = f.spawns.find((s) => s.categories.includes("boss"));
    expect(marker?.zoneName).toBe("Reshala · 38%");
  });
  it("keeps extract names with factions and requirements but no position", () => {
    expect(f.extracts.map((e) => [e.name, e.faction])).toEqual([["Crossroads", "pmc"], ["ZB-1011", "pmc"], ["Smugglers Boat", "scav"], ["Transit to Reserve", "transit"], ["Dorms V-Ex", "pmc"]]);
    expect(f.extracts[4].switches).toEqual([{ name: "TransferItem" }]);
    expect(f.extracts.every((e) => e.position === null)).toBe(true);
  });
  it("carries sniper perches as hazards and marks the source", () => {
    expect(f.hazards).toEqual([{ hazardType: "sniper", name: "Sniper · Tower", position: { x: 1, y: 2, z: 3 } }]);
    expect(f.source).toBe("spt");
    expect(f.normalizedName).toBe("customs");
  });
});

describe("bossDisplayName", () => {
  it("maps known ids and humanises unknown ones", () => {
    expect(bossDisplayName("bossGluhar")).toBe("Glukhar");
    expect(bossDisplayName("bossNewGuy")).toBe("New Guy");
  });
});

describe("sptQuestsToTasks", () => {
  it("names quests and objectives from the locale and resolves the map", () => {
    const quests = { q1: { _id: "q1", QuestName: "raw", location: "56f40101d2720b2a4d8b45d6", traderId: "t1", conditions: { AvailableForFinish: [{ id: "c1", conditionType: "FindItem", value: 3 }, { conditionType: "Visit" }] } }, q2: { _id: "q2", location: "any" } };
    const en = { "q1 name": "Debut", "t1 Nickname": "Prapor", c1: "Find 3 things" };
    const t = sptQuestsToTasks(quests, en, { "56f40101d2720b2a4d8b45d6": "customs" });
    expect(t[0]).toMatchObject({ id: "q1", name: "Debut", trader: { id: "t1", name: "Prapor" }, map: { normalizedName: "customs" } });
    expect(t[0].objectives[0]).toMatchObject({ id: "c1", type: "finditem", description: "Find 3 things", count: 3, maps: [{ normalizedName: "customs" }] });
    expect(t[0].objectives[1]).toMatchObject({ id: "q1:1", type: "visit", description: "Visit" });
    expect(t[1]).toMatchObject({ id: "q2", name: "q2", map: null });
  });
});
