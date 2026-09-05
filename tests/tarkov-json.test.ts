import { describe, expect, it } from "vitest";
import { convertJsonMaps, convertJsonTasks, nameOf, prettify, MAP_ALIASES } from "../src/tarkov-json.js";

const names = {
  EXFIL_ZB013: "ZB-013", "56f40101d2720b2a4d8b45d6 Name": "Customs", "5da743f586f7744014504f72 Name": "USEC stash key",
  "ScavRole/Marksman": "Sniper", "5909d76c86f77471e53d2adf Name": "Weapon box", "5cdeb229d7f00c000e7ce174 Name": "NSV Utyos",
  "q1 name": "Debut", "t1 Nickname": "Prapor", c1: "Locate the Emercom station", reshala: "Reshala", "590c695186f7741e566b64a2 Name": "Salewa",
};
const maps = {
  data: {
    maps: {
      a: {
        id: "56f40101d2720b2a4d8b45d6", name: "56f40101d2720b2a4d8b45d6 Name", normalizedName: "customs",
        extracts: [{ id: "x1", name: "EXFIL_ZB013", faction: "pmc", switches: ["sw1"], position: { x: 200, y: -1, z: -153 }, top: 1, bottom: -2 }, { id: "x2", name: "Crossroads", faction: "shared", position: { x: 1, y: 0, z: 2 } }],
        spawns: [
          { position: { x: 1, y: 0, z: 1 }, sides: ["pmc"], categories: ["player"], zoneName: "ZoneA" },
          { position: { x: 2, y: 0, z: 2 }, sides: ["scav"], categories: ["bot"], zoneName: "ZoneB" },
          { position: { x: 3, y: 0, z: 3 }, sides: ["scav"], categories: ["boss"], zoneName: "ZoneDormitory" },
          { position: { x: 4, y: 0, z: 4 }, sides: ["scav"], categories: ["sniper"], zoneName: "ZoneSnipe" },
        ],
        bosses: [{ mob: "bossBully", spawnChance: 0.3, spawnLocations: [{ name: "ZoneDormitory", positions: [{ x: 10, y: 0, z: 10 }, { x: 20, y: 0, z: 30 }] }] }, { boss: "bossKilla", spawnChance: 0, spawnLocations: [{ name: "Z", positions: [{ x: 1, y: 1, z: 1 }] }] }],
        hazards: [{ hazardType: "sniper", name: "ScavRole/Marksman", position: { x: 5, y: 0, z: 5 } }],
        locks: [{ lockType: "door", key: "5da743f586f7744014504f72", needsPower: false, position: { x: 6, y: 0, z: 6 } }, { lockType: "container", key: null, position: { x: 7, y: 0, z: 7 } }],
        lootContainers: [{ lootContainer: "5909d76c86f77471e53d2adf", position: { x: 8, y: 0, z: 8 } }],
        lootLoose: [{ position: { x: 9, y: 0, z: 9 }, items: ["590c695186f7741e566b64a2"] }, { position: { x: 9, y: 0, z: 9 }, items: [] }],
        switches: [{ id: "sw1", name: "switch_custom_DesignStuff_00034_reserve_electric_switcher_lever", position: { x: 11, y: 0, z: 11 } }],
        stationaryWeapons: [{ stationaryWeapon: "5cdeb229d7f00c000e7ce174", position: { x: 12, y: 0, z: 12 } }],
      },
      b: { id: "nf", name: "nf Name", normalizedName: "night-factory", extracts: [{ id: "n", name: "Gate 3", faction: "pmc", position: { x: 0, y: 0, z: 0 } }] },
      c: { id: "f", name: "f Name", normalizedName: "factory", extracts: [] },
    },
    mobs: { bossBully: { id: "bossBully", normalizedName: "reshala" }, bossKilla: { id: "bossKilla", normalizedName: "killa" } },
    lootContainers: { "5909d76c86f77471e53d2adf": { name: "5909d76c86f77471e53d2adf Name", normalizedName: "weapon-box" } },
    stationaryWeapons: { "5cdeb229d7f00c000e7ce174": { name: "5cdeb229d7f00c000e7ce174 Name", normalizedName: "nsv-utyos" } },
  },
};

describe("convertJsonMaps", () => {
  const { maps: out, idToKey } = convertJsonMaps(maps, names);
  const c = out.find((m) => m.normalizedName === "customs")!;
  it("maps variants onto one key and converts only the canonical record", () => {
    expect(idToKey).toEqual({ "56f40101d2720b2a4d8b45d6": "customs", nf: "factory", f: "factory" });
    expect(out.map((m) => m.normalizedName)).toEqual(["customs", "factory"]);
    expect(out[1].extracts).toEqual([]);
  });
  it("names extracts from the locale table and resolves their switches", () => {
    expect(c.extracts[0]).toMatchObject({ name: "ZB-013", faction: "pmc", position: { x: 200 }, top: 1, bottom: -2, switches: [{ name: "DesignStuff 00034 reserve electric switcher lever" }] });
    expect(c.extracts[1]).toMatchObject({ name: "Crossroads", faction: "shared" });
    expect(c.extracts[1].switches).toBeUndefined();
  });
  it("splits PMC spawns, drops raw boss points and names bosses with their chance", () => {
    expect(c.pmcSpawns).toEqual([{ position: { x: 1, y: 0, z: 1 }, zoneName: "ZoneA" }]);
    expect(c.spawns.filter((s) => s.categories.includes("scav"))).toHaveLength(2);
    expect(c.spawns.find((s) => s.zoneName === "ZoneSnipe")?.categories).toEqual(["sniper", "scav"]);
    const bosses = c.spawns.filter((s) => s.categories.includes("boss"));
    expect(bosses).toEqual([{ position: { x: 15, y: 0, z: 20 }, sides: ["savage"], categories: ["boss"], zoneName: "Reshala · 30%" }]);
  });
  it("names keys, containers, guns and hazards; keeps loose loot with items", () => {
    expect(c.locks[0]).toMatchObject({ lockType: "door", key: { name: "USEC stash key" }, needsPower: false });
    expect(c.locks[1].key).toBeNull();
    expect(c.lootContainers[0].lootContainer).toEqual({ name: "Weapon box", normalizedName: "weapon-box" });
    expect(c.stationaryWeapons[0].stationaryWeapon.name).toBe("NSV Utyos");
    expect(c.hazards[0]).toMatchObject({ hazardType: "sniper", name: "Sniper" });
    expect(c.switches[0].name).toBe("DesignStuff 00034 reserve electric switcher lever");
    expect(c.lootLoose).toEqual([{ position: { x: 9, y: 0, z: 9 }, items: ["590c695186f7741e566b64a2"] }]);
  });
});

describe("convertJsonTasks", () => {
  it("resolves names, traders, maps and puts every position into zones", () => {
    const tasks = {
      data: {
        tasks: {
          q1: {
            id: "q1", name: "q1 name", trader: "t1", map: "56f40101d2720b2a4d8b45d6", minPlayerLevel: 3,
            objectives: [
              { id: "c1", description: "c1", type: "visit", zones: [{ id: "z", map: "56f40101d2720b2a4d8b45d6", position: { x: 1, y: 2, z: 3 }, outline: [{ x: 0, y: 0, z: 0 }] }] },
              { id: "c2", description: "c2", type: "findQuestItem", count: 1, questItem: "qi1", possibleLocations: [{ map: "nf", positions: [{ x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }] }] },
              { id: "c3", description: "c3", type: "giveItem", count: 3, items: ["590c695186f7741e566b64a2", "other"] },
            ],
          },
          q2: { id: "q2", name: "q2 name", map: null, objectives: [] },
        },
        questItems: { qi1: { name: "qi1 Name" } },
      },
    };
    const out = convertJsonTasks(tasks, { "56f40101d2720b2a4d8b45d6": "customs", nf: "factory" }, names);
    expect(out[0]).toMatchObject({ id: "q1", name: "Debut", trader: { id: "t1", name: "Prapor" }, map: { normalizedName: "customs" }, minPlayerLevel: 3 });
    expect(out[0].objectives[0]).toMatchObject({ id: "c1", type: "visit", description: "Locate the Emercom station", maps: [{ normalizedName: "customs" }] });
    expect(out[0].objectives[0].zones).toEqual([{ position: { x: 1, y: 2, z: 3 }, outline: [{ x: 0, y: 0, z: 0 }], map: { normalizedName: "customs" } }]);
    expect(out[0].objectives[1].zones).toHaveLength(2);
    expect(out[0].objectives[1].maps).toEqual([{ normalizedName: "factory" }]);
    expect(out[0].objectives[1].questItem).toEqual({ name: "Qi1 Name" });
    expect(out[0].objectives[2]).toMatchObject({ item: { name: "Salewa", iconLink: "https://assets.tarkov.dev/590c695186f7741e566b64a2-icon.webp" }, count: 3, maps: [{ normalizedName: "customs" }], description: "giveItem" });
    expect(out[1]).toMatchObject({ id: "q2", name: "Q2 name", map: null, trader: { id: "", name: "" } });
  });
});

describe("names", () => {
  it("falls back to a readable key, never a bare id", () => {
    expect(prettify("EXFIL_ZB013")).toBe("ZB013");
    expect(prettify("usec-stash-key")).toBe("Usec stash key");
    expect(nameOf({}, "ScavRole/Marksman")).toBe("ScavRole/Marksman");
    expect(nameOf({ a: "A" }, "a", "z")).toBe("A");
    expect(nameOf({}, "a", "z")).toBe("z");
    expect(MAP_ALIASES["night-factory"]).toBe("factory");
  });
});
