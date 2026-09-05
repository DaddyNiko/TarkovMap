import { describe, expect, it } from "vitest";
import { bestItem, containerExpectedValue, lootHeat, lootPoints } from "../src/loot-value.js";

const prices = { a: 1000, b: 50000, c: 0, d: 200000 };
const names = { "a Name": "Bandage", "b Name": "GPU", "d Name": "LEDX" };

describe("bestItem / lootPoints", () => {
  it("picks the priciest possible item and names it", () => {
    expect(bestItem(["a", "b", "c"], prices, names)).toEqual({ id: "b", name: "GPU", price: 50000 });
    expect(bestItem(["zzz"], prices, names)).toEqual({ id: "zzz", name: "zzz", price: 0 });
    expect(bestItem([], prices, names)).toBeNull();
  });
  it("lists points most valuable first with the pool size", () => {
    const pts = lootPoints({ lootLoose: [{ position: { x: 0, y: 0, z: 0 }, items: ["a"] }, { position: { x: 1, y: 0, z: 1 }, items: ["a", "d", "c"] }] }, prices, names);
    expect(pts.map((p) => [p.name, p.price, p.count])).toEqual([["LEDX", 200000, 3], ["Bandage", 1000, 1]]);
  });
});

describe("lootHeat", () => {
  it("sums loose pools (by mean) and containers (by type value) into cells with quantile tiers", () => {
    const f = {
      lootLoose: [
        { position: { x: 3, y: 0, z: 3 }, items: ["a", "b"] }, // mean 25500 → cell 0,0
        { position: { x: 30, y: 0, z: 3 }, items: ["a"] }, // 1000 → cell 1,0
        { position: { x: 60, y: 0, z: 3 }, items: ["c"] }, // unpriced → nothing
      ],
      lootContainers: [
        { position: { x: 4, y: 0, z: 4 }, lootContainer: { id: "safe", name: "Safe", normalizedName: "safe" } }, // 40000 → cell 0,0
        { position: { x: 80, y: 0, z: 80 }, lootContainer: { id: "nope", name: "Nope", normalizedName: "nope" } }, // no value → nothing
      ],
    };
    const h = lootHeat(f, prices, names, { safe: 40000 }, 25);
    expect(h.cell).toBe(25);
    expect(h.cells).toHaveLength(2);
    const hot = h.cells.find((c) => c.x === 12.5 && c.z === 12.5)!;
    expect(hot.value).toBe(65500);
    expect(hot.top).toEqual(["Safe", "GPU"]);
    const cold = h.cells.find((c) => c.x === 37.5)!;
    expect(cold.value).toBe(1000);
    expect(hot.tier).toBeGreaterThan(cold.tier);
    expect(h.max).toBe(65500);
    expect(h.thresholds).toHaveLength(4);
  });
  it("is empty, not broken, without loot data", () => {
    expect(lootHeat({}, prices, names, {})).toEqual({ cell: 25, cells: [], thresholds: [0, 0, 0, 0], max: 0 });
  });
});

describe("containerExpectedValue", () => {
  it("multiplies expected count by the probability-weighted item price", () => {
    const dist = { itemcountDistribution: [{ count: 1, relativeProbability: 50 }, { count: 3, relativeProbability: 50 }], itemDistribution: [{ tpl: "a", relativeProbability: 90 }, { tpl: "b", relativeProbability: 10 }] };
    // E[count] = 2; E[price] = 0.9*1000 + 0.1*50000 = 5900 → 11800
    expect(containerExpectedValue(dist, prices)).toBe(11800);
    expect(containerExpectedValue({}, prices)).toBe(0);
  });
});
