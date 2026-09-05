/**
 * Loot value — what CAN spawn where, priced. Two inputs, both from data already on disk:
 *   • loose-loot spawn points (JSON API `lootLoose`: a position and the item ids that may appear there)
 *   • containers (positions from the JSON API; an expected value per container type per map from the
 *     game's own loot tables, data/offline/container-values.json, built by scripts/fetch-spt-data.mjs)
 * priced with data/offline/prices.json (flea prices per item id).
 *
 * It is a POSSIBLE-loot map, never a loot radar: it cannot know what spawned in his raid, and every
 * surface that shows it says so. Pure; tested.
 */
import type { MapFeatures, Vec3 } from "./map-features.js";

export type Prices = Record<string, number>;
export type Names = Record<string, string>;
export type ContainerValues = Record<string, number>;

export interface LootPoint { position: Vec3; name: string; price: number; count: number }
export interface HeatCell { x: number; z: number; value: number; tier: number; top: string[] }
export interface LootHeat { cell: number; cells: HeatCell[]; thresholds: number[]; max: number }

const itemName = (names: Names, id: string) => names[`${id} Name`] ?? names[`${id} ShortName`] ?? id;

/** The most valuable item a loose-loot point can produce. */
export function bestItem(items: string[], prices: Prices, names: Names): { id: string; name: string; price: number } | null {
  let best: { id: string; name: string; price: number } | null = null;
  for (const id of items) {
    const price = prices[id] ?? 0;
    if (!best || price > best.price) best = { id, name: itemName(names, id), price };
  }
  return best;
}

/** Loose-loot points with their best possible item, most valuable first. */
export function lootPoints(f: Pick<MapFeatures, "lootLoose">, prices: Prices, names: Names): LootPoint[] {
  const out: LootPoint[] = [];
  for (const p of f.lootLoose ?? []) {
    const b = bestItem(p.items, prices, names);
    if (b && p.position) out.push({ position: p.position, name: b.name, price: b.price, count: p.items.length });
  }
  return out.sort((a, b) => b.price - a.price);
}

/** Mean price of a loose point's pool — one item spawns, odds unknown, so the pool average is the fair expectation. */
function poolMean(items: string[], prices: Prices): number {
  const priced = items.map((id) => prices[id] ?? 0).filter((p) => p > 0);
  return priced.length ? priced.reduce((a, b) => a + b, 0) / priced.length : 0;
}

/**
 * Expected value per `cell` metre square: loose points by pool mean + containers by their type's expected
 * value. Tiers 1-5 are quantiles (20/40/60/80 %) of the non-empty cells so every map has a red end.
 */
export function lootHeat(f: Pick<MapFeatures, "lootLoose" | "lootContainers">, prices: Prices, names: Names, containerValues: ContainerValues, cell = 25): LootHeat {
  const acc = new Map<string, { x: number; z: number; value: number; items: Map<string, number> }>();
  const add = (pos: Vec3, value: number, label: string) => {
    if (!pos || value <= 0) return;
    const i = Math.floor(pos.x / cell), j = Math.floor(pos.z / cell), k = `${i},${j}`;
    let c = acc.get(k);
    if (!c) { c = { x: (i + 0.5) * cell, z: (j + 0.5) * cell, value: 0, items: new Map() }; acc.set(k, c); }
    c.value += value;
    c.items.set(label, (c.items.get(label) ?? 0) + value);
  };
  for (const p of f.lootLoose ?? []) {
    const b = bestItem(p.items, prices, names);
    if (b) add(p.position, poolMean(p.items, prices), b.name);
  }
  for (const c of f.lootContainers ?? []) {
    const id = c.lootContainer?.id ?? c.lootContainer?.normalizedName ?? "";
    const v = containerValues[id] ?? 0;
    if (v > 0) add(c.position, v, c.lootContainer?.name ?? "container");
  }
  const values = [...acc.values()].map((c) => c.value).sort((a, b) => a - b);
  const q = (p: number) => (values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 0);
  const thresholds = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const tierOf = (v: number) => thresholds.filter((t) => v > t).length + 1;
  const cells: HeatCell[] = [...acc.values()].map((c) => ({
    x: c.x, z: c.z, value: Math.round(c.value), tier: tierOf(c.value),
    top: [...c.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n),
  }));
  return { cell, cells, thresholds: thresholds.map(Math.round), max: values.length ? Math.round(values[values.length - 1]) : 0 };
}

/**
 * Expected value of one container type from the game's loot table: E[item count] × Σ p(item) × price.
 * `dist` is SPT's staticLoot entry ({itemcountDistribution, itemDistribution} with relative probabilities).
 */
export function containerExpectedValue(dist: { itemcountDistribution?: Array<{ count: number; relativeProbability: number }>; itemDistribution?: Array<{ tpl: string; relativeProbability: number }> }, prices: Prices): number {
  const counts = dist.itemcountDistribution ?? [];
  const ctot = counts.reduce((a, c) => a + c.relativeProbability, 0);
  const expectedCount = ctot ? counts.reduce((a, c) => a + c.count * (c.relativeProbability / ctot), 0) : 0;
  const items = dist.itemDistribution ?? [];
  const itot = items.reduce((a, i) => a + i.relativeProbability, 0);
  const expectedItem = itot ? items.reduce((a, i) => a + (prices[i.tpl] ?? 0) * (i.relativeProbability / itot), 0) : 0;
  return Math.round(expectedCount * expectedItem);
}
