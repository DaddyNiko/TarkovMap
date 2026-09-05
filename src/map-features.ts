/**
 * Extracts, spawns, hazards, loot, locks — the opt-in overlays, from
 * tarkov.dev's GraphQL API, cached on disk so the map works offline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MapFeatures {
  normalizedName: string;
  extracts: Array<{ id: string; name: string; faction: string; position: Vec3; outline?: Vec3[]; top?: number; bottom?: number; switches?: Array<{ name: string }> }>;
  transits: Array<{ id: string; description: string; conditions?: string; position: Vec3 }>;
  spawns: Array<{ position: Vec3; sides: string[]; categories: string[]; zoneName?: string }>;
  hazards: Array<{ hazardType: string; name: string; position: Vec3 }>;
  locks: Array<{ lockType: string; key?: { name: string } | null; position: Vec3; needsPower?: boolean }>;
  lootContainers: Array<{ position: Vec3; lootContainer: { name: string; normalizedName: string } }>;
  stationaryWeapons: Array<{ position: Vec3; stationaryWeapon: { name: string } }>;
  switches: Array<{ id: string; name: string; position: Vec3 }>;
}

export const FEATURES_QUERY = `{
  maps(lang: en) {
    normalizedName
    extracts { id name faction position { x y z } outline { x y z } top bottom switches { name } }
    transits { id description conditions position { x y z } }
    spawns { position { x y z } sides categories zoneName }
    hazards { hazardType name position { x y z } }
    locks { lockType key { name } position { x y z } needsPower }
    lootContainers { position { x y z } lootContainer { name normalizedName } }
    stationaryWeapons { position { x y z } stationaryWeapon { name } }
    switches { id name position { x y z } }
  }
}`;

export interface FeatureCache {
  fetchedAt: number;
  maps: MapFeatures[];
}

export function readCache(file: string): FeatureCache | null {
  try {
    if (!existsSync(file)) return null;
    const c = JSON.parse(readFileSync(file, "utf8")) as FeatureCache;
    return Array.isArray(c?.maps) ? c : null;
  } catch {
    return null;
  }
}

export function writeCache(file: string, c: FeatureCache): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c));
}

export async function fetchFeatures(endpoint = "https://api.tarkov.dev/graphql"): Promise<MapFeatures[]> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: FEATURES_QUERY }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`tarkov.dev ${res.status}`);
  const body = (await res.json()) as { data?: { maps?: MapFeatures[] }; errors?: unknown[] };
  if (!body.data?.maps) throw new Error(`tarkov.dev: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
  return body.data.maps;
}

/** Refresh weekly; keep whatever we have if the API is down. */
export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

export function featuresFor(cache: FeatureCache | null, normalizedName: string): MapFeatures | null {
  return cache?.maps.find((m) => m.normalizedName === normalizedName) ?? null;
}
