/**
 * Quest items — what to pick up now for quests later, and where it can spawn on this map.
 *
 *   (a) quest-specific world items: "findQuestItem" objectives carry the exact spots (zones).
 *   (b) ordinary items future quests hand in (giveItem / findItem / plantItem with an item list): shown at the
 *       loose-loot spawn points on this map whose pool contains the item, coalesced on a small grid.
 *
 * Importance is a plain additive score so the slider means the same thing on every map. Pure; tested.
 */
import type { MapFeatures, Vec3 } from "./map-features.js";
import type { TaskDef } from "./quests.js";
import { traderPortrait } from "./quests.js";
import { itemIcon, itemName } from "./tarkov-json.js";
import type { QuestProgress, QuestState } from "./quest-status.js";
import { objectiveZonesOnMap } from "./quests.js";

export type Prices = Record<string, number>;
export type Names = Record<string, string>;

export interface QuestRef {
  questId: string; questName: string; trader: { id: string; name: string; portrait: string }; status: QuestState;
  objectiveId: string; description: string; count: number; fir: boolean; optional: boolean; done: boolean;
  minPlayerLevel?: number; wikiLink?: string; kappaRequired?: boolean;
}
export interface NeededItem { id: string; name: string; icon: string; price: number; count: number; fir: boolean; quests: QuestRef[] }

const ITEM_TYPES = new Set(["giveItem", "findItem", "plantItem"]);
const ref = (t: TaskDef, o: TaskDef["objectives"][number], status: QuestState, done: boolean): QuestRef => ({
  questId: t.id, questName: t.name, trader: { id: t.trader.id, name: t.trader.name, portrait: traderPortrait(t.trader.id) }, status,
  objectiveId: o.id, description: o.description, count: o.count ?? 1, fir: Boolean(o.foundInRaid), optional: Boolean(o.optional), done,
  minPlayerLevel: t.minPlayerLevel, wikiLink: t.wikiLink, kappaRequired: t.kappaRequired,
});

/** Items that active and future quests still want, merged per item id (count summed, FIR if any quest wants it FIR). */
export function neededItems(tasks: TaskDef[], states: Record<string, QuestState>, progress: QuestProgress, prices: Prices, names: Names): NeededItem[] {
  const by = new Map<string, NeededItem>();
  for (const t of tasks) {
    const status = states[t.id] ?? "available";
    if (status === "done" || status === "failed") continue;
    for (const o of t.objectives ?? []) {
      if (!ITEM_TYPES.has(o.type) || !o.items?.length || progress.done[o.id]) continue;
      const r = ref(t, o, status, false);
      for (const id of o.items) {
        let it = by.get(id);
        if (!it) { it = { id, name: itemName(names, id), icon: itemIcon(id), price: prices[id] ?? 0, count: 0, fir: false, quests: [] }; by.set(id, it); }
        it.count += r.count;
        it.fir = it.fir || r.fir;
        if (!it.quests.some((q) => q.objectiveId === r.objectiveId)) it.quests.push(r);
      }
    }
  }
  return [...by.values()];
}

export interface ImportanceInput { count: number; questsNeeding: number; fir: boolean; spawnPointsOnMap: number; price: number; activeQuest: boolean; questSpecific?: boolean }
/** Additive, monotone: more needed, more quests, FIR, an accepted quest, rare on this map, pricey → higher.
 *  A quest-specific world item (the folder, the flash drive) is the tedious kind — one spot, one chance — so it carries a bonus. */
export function importance(i: ImportanceInput): number {
  const scarcity = i.spawnPointsOnMap <= 3 ? 4 : i.spawnPointsOnMap <= 10 ? 2 : 0;
  const priceTier = i.price >= 100000 ? 4 : i.price >= 30000 ? 2 : i.price >= 10000 ? 1 : 0;
  return Math.min(i.count, 5) + Math.min(i.questsNeeding, 4) * 2 + (i.fir ? 2 : 0) + (i.activeQuest ? 4 : 0) + scarcity + priceTier + (i.questSpecific ? 5 : 0);
}

export interface QuestItemMarkerItem { id: string; name: string; icon: string; count: number; fir: boolean; price: number; spawnPointsOnMap: number; importance: number; quests: QuestRef[] }
export interface QuestItemMarker {
  kind: "questItem" | "item";
  position: Vec3;
  importance: number;
  label: string;
  items: QuestItemMarkerItem[];
  objectiveId?: string; questId?: string; status?: QuestState; done?: boolean;
}

/** Markers for one map: quest-specific world items at their spots, needed ordinary items at the loose spawns that can hold them. */
export function questItemMarkers(tasks: TaskDef[], states: Record<string, QuestState>, progress: QuestProgress, features: Pick<MapFeatures, "lootLoose"> | null, mapNormalizedName: string, prices: Prices, names: Names, opts: { cell?: number; limit?: number } = {}): QuestItemMarker[] {
  const cell = opts.cell ?? 5, limit = opts.limit ?? 500;
  const out: QuestItemMarker[] = [];
  // (a) quest-specific items lying in the world
  for (const t of tasks) {
    const status = states[t.id] ?? "available";
    if (status === "done" || status === "failed") continue;
    for (const o of t.objectives ?? []) {
      if (o.type !== "findQuestItem") continue;
      const { zones } = objectiveZonesOnMap(t, o, mapNormalizedName);
      if (!zones.length) continue;
      const done = Boolean(progress.done[o.id]);
      const name = o.questItem?.name ?? o.description;
      const r = ref(t, o, status, done);
      const imp = importance({ count: 1, questsNeeding: 1, fir: true, spawnPointsOnMap: zones.length, price: 0, activeQuest: status === "active", questSpecific: true });
      for (const z of zones) out.push({ kind: "questItem", position: z.position, importance: done ? 0 : imp, label: name, objectiveId: o.id, questId: t.id, status, done, items: [{ id: o.questItem?.id ?? o.id, name, icon: o.questItem?.id ? itemIcon(o.questItem.id) : "", count: 1, fir: true, price: 0, spawnPointsOnMap: zones.length, importance: imp, quests: [r] }] });
    }
  }
  // (b) ordinary needed items at loose-loot spawns
  const needed = new Map(neededItems(tasks, states, progress, prices, names).map((n) => [n.id, n]));
  const points = (features?.lootLoose ?? []).filter((p) => p.position && p.items?.length);
  const spawnCount = new Map<string, number>();
  for (const p of points) for (const id of new Set(p.items)) if (needed.has(id)) spawnCount.set(id, (spawnCount.get(id) ?? 0) + 1);
  const cells = new Map<string, { position: Vec3; items: Map<string, QuestItemMarkerItem> }>();
  for (const p of points) {
    const hits = [...new Set(p.items)].filter((id) => needed.has(id));
    if (!hits.length) continue;
    const k = `${Math.floor(p.position.x / cell)},${Math.floor(p.position.z / cell)}`;
    let c = cells.get(k);
    if (!c) { c = { position: p.position, items: new Map() }; cells.set(k, c); }
    for (const id of hits) {
      if (c.items.has(id)) continue;
      const n = needed.get(id)!;
      const imp = importance({ count: n.count, questsNeeding: n.quests.length, fir: n.fir, spawnPointsOnMap: spawnCount.get(id) ?? 1, price: n.price, activeQuest: n.quests.some((q) => q.status === "active") });
      c.items.set(id, { id, name: n.name, icon: n.icon, count: n.count, fir: n.fir, price: n.price, spawnPointsOnMap: spawnCount.get(id) ?? 1, importance: imp, quests: n.quests });
    }
  }
  for (const c of cells.values()) {
    const items = [...c.items.values()].sort((a, b) => b.importance - a.importance).slice(0, 3);
    out.push({ kind: "item", position: c.position, importance: items[0].importance, label: items.map((i) => i.name).join(" · "), items });
  }
  return out.sort((a, b) => b.importance - a.importance).slice(0, limit);
}
