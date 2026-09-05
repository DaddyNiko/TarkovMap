/**
 * tarkov.dev's JSON API (json.tarkov.dev) — the source the tarkov.dev site itself runs on, and the
 * one its maintainers point to while the GraphQL API is down (down since 2026-07-21, issue #474).
 *
 * It carries every position we want (extracts, locks, containers, loose loot, hazards, switches,
 * stationary guns, boss spawn zones, quest zones) but its NAMES are locale keys — "<itemId> Name",
 * "<questId> name", "EXFIL_ZB013", "ScavRole/Marksman". The game's own English locale uses the same
 * keys, so data/offline/names.json (built by scripts/fetch-spt-data.mjs) resolves them; anything it
 * does not know falls back to a readable form of the key rather than an id.
 *
 * Pure conversions into the shapes the rest of the app already consumes (MapFeatures, TaskDef).
 */
import type { MapFeatures, Vec3 } from "./map-features.js";
import type { TaskDef, TaskObjective, TaskZone } from "./quests.js";
import { bossDisplayName } from "./offline-data.js";

export type Names = Record<string, string>;
export const JSON_API = "https://json.tarkov.dev/regular";

/** JSON API map variants that are the same map to the game log and to us. */
export const MAP_ALIASES: Record<string, string> = { "night-factory": "factory", "ground-zero-21": "ground-zero", "ground-zero-tutorial": "ground-zero", "the-lab-dark": "the-lab" };

interface JsonExtract { id: string; name: string; faction: string; switches?: string[]; transferItem?: string | null; position: Vec3 | null; outline?: Vec3[]; top?: number; bottom?: number }
interface JsonBoss { mob?: string; boss?: string; name?: string; id?: string; spawnChance: number; spawnLocations?: Array<{ name: string; chance?: number; positions?: Vec3[] }> }
interface JsonMap {
  id: string; name: string; normalizedName: string;
  extracts?: JsonExtract[]; transits?: Array<{ id: string; description?: string; conditions?: string; position: Vec3 }>;
  spawns?: Array<{ position: Vec3; sides: string[]; categories: string[]; zoneName?: string }>;
  bosses?: JsonBoss[]; hazards?: Array<{ hazardType: string; name: string; position: Vec3 }>;
  locks?: Array<{ lockType: string; key?: string | null; needsPower?: boolean; position: Vec3 }>;
  lootContainers?: Array<{ lootContainer: string; position: Vec3 }>; lootLoose?: Array<{ position: Vec3; items: string[] }>;
  switches?: Array<{ id: string; name: string; position: Vec3 }>; stationaryWeapons?: Array<{ stationaryWeapon: string; position: Vec3 }>;
}
export interface JsonMapsPayload {
  data: { maps: Record<string, JsonMap> | JsonMap[]; mobs?: Record<string, { id?: string; name?: string; normalizedName?: string }>; lootContainers?: Record<string, { name?: string; normalizedName?: string }>; stationaryWeapons?: Record<string, { name?: string; normalizedName?: string }> };
}
interface JsonObjective { id: string; type: string; description?: string; count?: number; items?: string[]; questItem?: string | null; zones?: Array<{ id?: string; map?: string; position: Vec3; outline?: Vec3[] }>; possibleLocations?: Array<{ map?: string; positions?: Vec3[] }> }
interface JsonTask { id: string; name: string; trader?: string; map?: string | null; minPlayerLevel?: number; objectives?: JsonObjective[] }
export interface JsonTasksPayload { data: { tasks: Record<string, JsonTask> | JsonTask[]; questItems?: Record<string, { name?: string }> } }

const values = <T>(x: Record<string, T> | T[] | undefined): T[] => (Array.isArray(x) ? x : Object.values(x ?? {}));

/** A readable form of a locale key nobody translated: "usec-stash-key" → "Usec stash key". */
export function prettify(key: string): string {
  const s = key.replace(/^(EXFIL_|switch_|custom_)+/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}
export function nameOf(names: Names, key: string | undefined | null, fallback?: string): string {
  if (!key) return fallback ?? "";
  return names[key] ?? fallback ?? prettify(key);
}
const itemName = (names: Names, id: string): string => names[`${id} Name`] ?? names[`${id} ShortName`] ?? prettify(id);
function centroid(points: Vec3[]): Vec3 | null {
  const pts = points.filter((p) => p && typeof p.x === "number");
  if (!pts.length) return null;
  const s = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / pts.length, y: s.y / pts.length, z: s.z / pts.length };
}

/** JSON maps payload → MapFeatures per canonical map, plus the game's map id → our map key table. */
export function convertJsonMaps(payload: JsonMapsPayload, names: Names): { maps: MapFeatures[]; idToKey: Record<string, string> } {
  const d = payload.data;
  const idToKey: Record<string, string> = {};
  const out: MapFeatures[] = [];
  const seen = new Set<string>();
  for (const m of values(d.maps)) {
    const key = MAP_ALIASES[m.normalizedName] ?? m.normalizedName;
    idToKey[m.id] = key;
    if (key !== m.normalizedName || seen.has(key)) continue; // a variant: same map, same key, skip its copy
    seen.add(key);
    const switchName = (id: string) => { const s = (m.switches ?? []).find((x) => x.id === id); return s ? prettify(s.name) : "switch"; };
    const spawns: MapFeatures["spawns"] = [];
    const pmcSpawns: NonNullable<MapFeatures["pmcSpawns"]> = [];
    for (const sp of m.spawns ?? []) {
      if (!sp.position) continue;
      const cats = (sp.categories ?? []).map((c) => c.toLowerCase());
      if (cats.includes("player")) pmcSpawns.push({ position: sp.position, zoneName: sp.zoneName });
      if (cats.includes("boss")) continue; // named below from `bosses`, with the chance
      if (cats.includes("bot") || cats.includes("all") || cats.includes("sniper")) spawns.push({ position: sp.position, sides: sp.sides ?? [], categories: cats.includes("sniper") ? ["sniper", "scav"] : ["scav"], zoneName: sp.zoneName });
    }
    for (const b of m.bosses ?? []) {
      const id = b.mob ?? b.boss ?? b.id ?? b.name ?? "";
      const mob = d.mobs?.[id];
      const name = (mob?.normalizedName && names[mob.normalizedName]) || bossDisplayName(id || mob?.name || "boss");
      const pct = Math.round((b.spawnChance ?? 0) * 100);
      if (pct <= 0) continue;
      for (const loc of b.spawnLocations ?? []) {
        const pos = centroid(loc.positions ?? []);
        if (pos) spawns.push({ position: pos, sides: ["savage"], categories: ["boss"], zoneName: `${name} · ${pct}%` });
      }
    }
    out.push({
      normalizedName: key,
      extracts: (m.extracts ?? []).map((e) => ({ id: e.id, name: nameOf(names, e.name), faction: e.faction, position: e.position as Vec3, outline: e.outline, top: e.top, bottom: e.bottom, ...(e.switches?.length ? { switches: e.switches.map((id) => ({ name: switchName(id) })) } : {}) })),
      transits: (m.transits ?? []).map((t) => ({ id: t.id, description: nameOf(names, t.description, "Transit"), conditions: t.conditions ? nameOf(names, t.conditions) : undefined, position: t.position })),
      spawns,
      hazards: (m.hazards ?? []).map((h) => ({ hazardType: h.hazardType, name: nameOf(names, h.name), position: h.position })),
      locks: (m.locks ?? []).map((l) => ({ lockType: l.lockType, key: l.key ? { name: itemName(names, l.key) } : null, position: l.position, needsPower: l.needsPower })),
      lootContainers: (m.lootContainers ?? []).map((c) => { const t = d.lootContainers?.[c.lootContainer]; return { position: c.position, lootContainer: { id: c.lootContainer, name: nameOf(names, t?.name, prettify(t?.normalizedName ?? c.lootContainer)), normalizedName: t?.normalizedName ?? c.lootContainer } }; }),
      stationaryWeapons: (m.stationaryWeapons ?? []).map((w) => { const t = d.stationaryWeapons?.[w.stationaryWeapon]; return { position: w.position, stationaryWeapon: { name: nameOf(names, t?.name, prettify(t?.normalizedName ?? "gun")) } }; }),
      switches: (m.switches ?? []).map((s) => ({ id: s.id, name: prettify(s.name), position: s.position })),
      lootLoose: (m.lootLoose ?? []).filter((l) => l.position && l.items?.length).map((l) => ({ position: l.position, items: l.items })),
      pmcSpawns,
    });
  }
  return { maps: out, idToKey };
}

/** JSON tasks payload → TaskDef[] (positions on zones, names from the locale table). */
export function convertJsonTasks(payload: JsonTasksPayload, idToKey: Record<string, string>, names: Names): TaskDef[] {
  const d = payload.data;
  const keyFor = (mapId: string | undefined | null) => (mapId ? { normalizedName: idToKey[mapId] ?? mapId } : null);
  return values(d.tasks).map((t) => {
    const objectives: TaskObjective[] = (t.objectives ?? []).map((o) => {
      const zones: TaskZone[] = [];
      for (const z of o.zones ?? []) if (z.position) zones.push({ position: z.position, outline: z.outline, map: keyFor(z.map) });
      for (const p of o.possibleLocations ?? []) for (const pos of p.positions ?? []) zones.push({ position: pos, map: keyFor(p.map) });
      const mapKeys = [...new Set(zones.map((z) => z.map?.normalizedName).filter((x): x is string => Boolean(x)))];
      const questItem = o.questItem ? { name: nameOf(names, d.questItems?.[o.questItem]?.name ?? `${o.questItem} Name`) } : null;
      return {
        id: o.id, type: o.type, description: nameOf(names, o.description ?? o.id, o.type), count: o.count,
        maps: mapKeys.length ? mapKeys.map((k) => ({ normalizedName: k })) : t.map ? [{ normalizedName: idToKey[t.map] ?? t.map }] : undefined,
        zones: zones.length ? zones : undefined,
        item: o.items?.length ? { name: itemName(names, o.items[0]), iconLink: `https://assets.tarkov.dev/${o.items[0]}-icon.webp` } : null,
        questItem,
      };
    });
    return { id: t.id, name: nameOf(names, t.name), trader: { id: t.trader ?? "", name: t.trader ? nameOf(names, `${t.trader} Nickname`, t.trader) : "" }, map: keyFor(t.map), objectives, minPlayerLevel: t.minPlayerLevel };
  });
}

/** One JSON API dataset ("maps", "tasks"). The maps file is ~9 MB, hence the long timeout. */
export async function fetchJson<T>(dataset: "maps" | "tasks", base = JSON_API): Promise<T> {
  const res = await fetch(`${base}/${dataset}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`json.tarkov.dev ${res.status}`);
  const body = (await res.json()) as T & { data?: unknown };
  if (!body || typeof body !== "object" || !("data" in body)) throw new Error("json.tarkov.dev: unexpected body");
  return body;
}
