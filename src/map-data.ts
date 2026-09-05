/**
 * Map definitions and the game→map coordinate model.
 *
 * Everything here is PURE (no fs, no electron) so it is unit-testable. The
 * source of truth is tarkov.dev's `maps.json` (MIT), vendored under data/.
 * Their Leaflet CRS is reproduced in `projectToPixel` so tests can assert
 * where a game coordinate lands without a DOM; the renderer builds the same
 * CRS from the same `transform` + `coordinateRotation` fields.
 */

export interface LayerExtent {
  /** [low, high] player height (game Y) that belongs to this layer. */
  height: [number, number];
  /** Optional rectangles ([[x1,z1],[x2,z2],"name"]) restricting the extent. */
  bounds?: Array<[[number, number], [number, number], string?]>;
}

export interface MapLayer {
  name: string;
  svgLayer?: string;
  tilePath?: string;
  show?: boolean;
  extents?: LayerExtent[];
}

export interface MapLabel {
  position: [number, number];
  text: string;
  rotation?: number | string;
  size?: number;
  top?: number;
  bottom?: number;
}

export interface MapDef {
  key: string;
  name: string;
  /** tarkov.dev group name (e.g. "customs"), used for API lookups. */
  normalizedName: string;
  projection: string;
  transform?: [number, number, number, number];
  coordinateRotation?: number;
  bounds: [[number, number], [number, number]];
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  svgPath?: string;
  svgLayer?: string;
  tilePath?: string;
  heightRange?: [number, number];
  layers?: MapLayer[];
  labels?: MapLabel[];
}

interface RawGroup {
  normalizedName: string;
  primaryPath: string;
  maps: Array<Record<string, unknown>>;
}

/** Only the "interactive" projection of each group is a live map. */
export function interactiveMaps(raw: unknown): MapDef[] {
  const out: MapDef[] = [];
  for (const g of raw as RawGroup[]) {
    for (const m of g.maps) {
      if (m.projection !== "interactive") continue;
      if (!m.bounds) continue;
      out.push({
        ...(m as unknown as MapDef),
        normalizedName: g.normalizedName,
        name: titleFor(g.normalizedName),
      });
    }
  }
  return out;
}

const TITLES: Record<string, string> = {
  "ground-zero": "Ground Zero",
  customs: "Customs",
  factory: "Factory",
  interchange: "Interchange",
  "the-lab": "The Lab",
  "the-labyrinth": "The Labyrinth",
  lighthouse: "Lighthouse",
  reserve: "Reserve",
  shoreline: "Shoreline",
  "streets-of-tarkov": "Streets of Tarkov",
  woods: "Woods",
  icebreaker: "Icebreaker",
  terminal: "Terminal",
};

export function titleFor(normalizedName: string): string {
  return TITLES[normalizedName] ?? normalizedName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The game's internal location ids, as they appear in the log line
 * `TRACE-NetworkGameCreate profileStatus: '… Location: Sandbox …'` and in
 * the raid-end JSON's `"location"`. Keys are compared case-insensitively.
 */
export const LOCATION_TO_MAP: Record<string, string> = {
  sandbox: "ground-zero",
  sandbox_high: "ground-zero",
  bigmap: "customs",
  factory4_day: "factory",
  factory4_night: "factory",
  interchange: "interchange",
  laboratory: "the-lab",
  labyrinth: "the-labyrinth",
  lighthouse: "lighthouse",
  rezervbase: "reserve",
  shoreline: "shoreline",
  tarkovstreets: "streets-of-tarkov",
  woods: "woods",
  icebreaker: "icebreaker",
  terminal: "terminal",
};

export function mapKeyForLocation(location: string): string | null {
  const k = location.trim().toLowerCase();
  if (LOCATION_TO_MAP[k]) return LOCATION_TO_MAP[k];
  // Tolerate suffixed variants the game adds over time (e.g. "Sandbox_high").
  for (const [id, key] of Object.entries(LOCATION_TO_MAP)) {
    if (k.startsWith(id)) return key;
  }
  return null;
}

/** Rotate a game (x, z) pair the way tarkov.dev's CRS does before projecting. */
export function rotateXZ(x: number, z: number, rotationDeg: number | undefined): [number, number] {
  if (!rotationDeg) return [x, z];
  const a = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Their applyRotation takes latLng {lng: x, lat: z}: x' = x cos − z sin ; z' = x sin + z cos
  return [x * c - z * s, x * s + z * c];
}

/**
 * Zoom-0 pixel position of a game coordinate on this map, identical to what
 * Leaflet computes with `L.Transformation(sx, mx, -sy, my)` over the rotated
 * point. Multiply by 2^zoom for a zoom level's pixel grid.
 */
export function projectToPixel(map: MapDef, x: number, z: number): { px: number; py: number } {
  const [sx, mx, sy, my] = map.transform ?? [1, 0, 1, 0];
  const [rx, rz] = rotateXZ(x, z, map.coordinateRotation);
  return { px: sx * rx + mx, py: -sy * rz + my };
}

/** Yaw (degrees, 0 = game +Z, clockwise) from the screenshot quaternion. */
export function yawFromQuaternion(x: number, y: number, z: number, w: number): number {
  // Unity quaternion, rotation around the Y (up) axis.
  const siny = 2 * (w * y + x * z);
  const cosy = 1 - 2 * (y * y + z * z);
  let deg = (Math.atan2(siny, cosy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** The floor layer a player at (x, y, z) is on, or null for the base layer. */
export function floorForPosition(map: MapDef, x: number, y: number, z: number): MapLayer | null {
  for (const layer of map.layers ?? []) {
    for (const ext of layer.extents ?? []) {
      const [lo, hi] = ext.height;
      if (y < lo || y > hi) continue;
      if (!ext.bounds || ext.bounds.length === 0) return layer;
      for (const b of ext.bounds) {
        const [[x1, z1], [x2, z2]] = b;
        const inX = x >= Math.min(x1, x2) && x <= Math.max(x1, x2);
        const inZ = z >= Math.min(z1, z2) && z <= Math.max(z1, z2);
        if (inX && inZ) return layer;
      }
    }
  }
  return null;
}

/** True when a game coordinate falls inside the map's declared bounds. */
export function inBounds(map: MapDef, x: number, z: number): boolean {
  const [[x1, z1], [x2, z2]] = map.bounds;
  return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && z >= Math.min(z1, z2) && z <= Math.max(z1, z2);
}
