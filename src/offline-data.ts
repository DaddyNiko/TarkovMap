/**
 * Offline marker data from the game's own location dumps (the SPT server repository publishes
 * `locations/<id>/base.json` etc.). tarkov.dev's API is the primary source; this is what the app
 * ships with so scav spawns, boss zones, PMC spawns and extract names show without the network.
 *
 * Pure conversions only — the fetch lives in scripts/fetch-spt-data.mjs and the tests feed fixtures.
 */
import type { MapFeatures, Vec3 } from "./map-features.js";
import type { TaskDef } from "./quests.js";

/** SPT location folder → the app's map key / tarkov.dev normalizedName. */
export const SPT_LOCATIONS: Record<string, string> = {
  bigmap: "customs",
  factory4_day: "factory",
  laboratory: "the-lab",
  rezervbase: "reserve",
  sandbox: "ground-zero",
  tarkovstreets: "streets-of-tarkov",
  woods: "woods",
  shoreline: "shoreline",
  interchange: "interchange",
  lighthouse: "lighthouse",
  terminal: "terminal",
};

export interface SptSpawnPoint { Position: Vec3; Categories?: string[]; Sides?: string[]; BotZoneName?: string; Infiltration?: string }
export interface SptBoss { BossName: string; BossZone?: string; BossChance?: number; BossEscortAmount?: string; BossEscortType?: string }
export interface SptExit { Name: string; EntryPoints?: string; PassageRequirement?: string; ExfiltrationType?: string; RequirementTip?: string; Chance?: number }
export interface SptBase { _Id?: string; Id?: string; Name?: string; SpawnPointParams?: SptSpawnPoint[]; BossLocationSpawn?: SptBoss[]; exits?: SptExit[] }

export interface BossSpawn { name: string; zone: string; chance: number; position: Vec3 | null; escorts?: string }

/** Extra fields the offline snapshot adds on top of the API shape. */
export interface OfflineMapFeatures extends MapFeatures {
  bosses: BossSpawn[];
  pmcSpawns: Array<{ position: Vec3; zoneName?: string }>;
  source: "spt";
}

const BOSS_NAMES: Record<string, string> = {
  bossBully: "Reshala", bossKilla: "Killa", bossGluhar: "Glukhar", bossSanitar: "Sanitar", bossKojaniy: "Shturman", bossTagilla: "Tagilla",
  bossKnight: "Knight", followerBigPipe: "Big Pipe", followerBirdEye: "Birdeye", bossZryachiy: "Zryachiy", bossBoar: "Kaban", bossKolontay: "Kollontay",
  bossPartisan: "Partisan", sectantPriest: "Cultist priest", bossPunisher: "Punisher", pmcBot: "Raiders", exUsec: "Rogues", gifter: "Santa",
  arenaFighterEvent: "Arena fighters", crazyAssaultEvent: "Crazy scavs", sectactPriestEvent: "Cultists", bossTagillaAgro: "Tagilla",
};
export function bossDisplayName(id: string): string {
  return BOSS_NAMES[id] ?? id.replace(/^boss|^follower/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function centroid(points: Vec3[]): Vec3 | null {
  if (!points.length) return null;
  const s = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / points.length, y: s.y / points.length, z: s.z / points.length };
}

/**
 * base.json → the API's MapFeatures shape. Extracts carry NO position in the dump (only names and
 * requirements) — the renderer already skips extracts without one; they still fill the side list.
 */
export function sptToFeatures(base: SptBase, normalizedName: string, snipers?: Array<{ name?: string; position: Vec3 }>): OfflineMapFeatures {
  const spawns: OfflineMapFeatures["spawns"] = [];
  const pmcSpawns: OfflineMapFeatures["pmcSpawns"] = [];
  const byZone = new Map<string, Vec3[]>();
  for (const sp of base.SpawnPointParams ?? []) {
    if (!sp.Position || typeof sp.Position.x !== "number") continue;
    const cats = (sp.Categories ?? []).map((c) => c.toLowerCase());
    const sides = (sp.Sides ?? []).map((s) => s.toLowerCase());
    if (sp.BotZoneName) { const list = byZone.get(sp.BotZoneName) ?? []; list.push(sp.Position); byZone.set(sp.BotZoneName, list); }
    if (cats.includes("player")) { pmcSpawns.push({ position: sp.Position, zoneName: sp.BotZoneName }); continue; }
    if (cats.includes("bot") || cats.includes("boss")) {
      const isSniper = /sniper|snipe/i.test(sp.BotZoneName ?? "");
      spawns.push({ position: sp.Position, sides: sides.length ? sides : ["savage"], categories: isSniper ? ["sniper", "scav"] : ["scav"], zoneName: sp.BotZoneName });
    }
  }
  const bosses: BossSpawn[] = [];
  for (const b of base.BossLocationSpawn ?? []) {
    if (!b.BossName || (b.BossChance ?? 0) <= 0) continue;
    const zones = (b.BossZone ?? "").split(",").map((z) => z.trim()).filter(Boolean);
    const pts = zones.flatMap((z) => byZone.get(z) ?? nearZone(byZone, z));
    bosses.push({ name: bossDisplayName(b.BossName), zone: zones.join(", "), chance: Math.round(b.BossChance ?? 0), position: centroid(pts), escorts: b.BossEscortType ? bossDisplayName(b.BossEscortType) : undefined });
  }
  // a boss is also a "spawn" so the existing bosses layer draws it without new renderer paths
  for (const b of bosses) if (b.position) spawns.push({ position: b.position, sides: ["savage"], categories: ["boss"], zoneName: `${b.name} · ${b.chance}%` });
  const extracts: MapFeatures["extracts"] = (base.exits ?? []).map((e) => ({
    id: e.Name, name: e.Name, faction: exitFaction(e), position: null as unknown as Vec3,
    ...(e.PassageRequirement && e.PassageRequirement !== "None" ? { switches: [{ name: e.PassageRequirement }] } : {}),
  }));
  const hazards: MapFeatures["hazards"] = (snipers ?? []).map((s) => ({ hazardType: "sniper", name: s.name ? `Sniper · ${s.name}` : "Sniper", position: s.position }));
  return { normalizedName, extracts, transits: [], spawns, hazards, locks: [], lootContainers: [], stationaryWeapons: [], switches: [], bosses, pmcSpawns, source: "spt" };
}

/** Spawn points of every zone sharing the boss zone's stem ("ZoneCarShowroom" -> "ZoneSnipeCarShowroom"); the boss walks there. */
function nearZone(byZone: Map<string, Vec3[]>, zone: string): Vec3[] {
  const stem = zone.replace(/^Zone/i, "").toLowerCase();
  if (stem.length < 4) return [];
  return [...byZone.entries()].filter(([k]) => k.toLowerCase().includes(stem)).flatMap(([, v]) => v);
}

function exitFaction(e: SptExit): string {
  const n = e.Name.toLowerCase();
  if (/transit/.test(n) || e.ExfiltrationType === "Transit") return "transit";
  if (/scav|exfil_.*_scav|smugglers|old road|passage/i.test(n) && !/pmc/i.test(n)) return "scav";
  return "pmc";
}

// ── quests ─────────────────────────────────────────────────────────────────
export interface SptQuest { _id: string; QuestName?: string; location?: string; traderId?: string; conditions?: { AvailableForFinish?: Array<{ id?: string; conditionType?: string; target?: unknown; value?: number; zoneId?: string }> } }

/**
 * templates/quests.json + the English locale → TaskDef[] without positions (those need the API's
 * zones). Names and objective texts come from en.json: "<questId> name", "<conditionId>".
 */
export function sptQuestsToTasks(quests: Record<string, SptQuest>, en: Record<string, string>, mapIdToName: Record<string, string>): TaskDef[] {
  const out: TaskDef[] = [];
  for (const q of Object.values(quests)) {
    const name = en[`${q._id} name`] ?? q.QuestName ?? q._id;
    const traderId = q.traderId ?? "";
    const trader = { id: traderId, name: en[`${traderId} Nickname`] ?? traderId };
    const mapName = q.location && q.location !== "any" ? mapIdToName[q.location] : undefined;
    const objectives = (q.conditions?.AvailableForFinish ?? []).map((c, i) => ({
      id: c.id ?? `${q._id}:${i}`,
      type: (c.conditionType ?? "unknown").toLowerCase(),
      description: (c.id && en[c.id]) || (c.conditionType ?? "objective"),
      maps: mapName ? [{ normalizedName: mapName }] : undefined,
      count: typeof c.value === "number" ? c.value : undefined,
    }));
    out.push({ id: q._id, name, trader, map: mapName ? { normalizedName: mapName } : null, objectives });
  }
  return out;
}
