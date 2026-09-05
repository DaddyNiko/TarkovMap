/**
 * RE3MR renders as the base map.
 *
 * reemr.se publishes near top-down 3D renders of every map under
 * CC BY-NC-SA 4.0. For personal use with his credit visible they are the
 * best-looking base there is. This module owns:
 *   - the registry (which file for which map, where it came from),
 *   - registration: control points (game x,z ↔ image px) → affine fit,
 *   - the one-time slice of the big image into a 256-px tile pyramid.
 * Everything except the slicer is pure and unit-tested.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Re3mrSource {
  /** map key as in maps.json */
  key: string;
  url: string;
  /** file name inside the cache dir */
  file: string;
  credit: string;
}

export const SOURCES: Re3mrSource[] = [
  { key: "customs", url: "https://maps.reemr.se/Customs/re3mrCustoms2.png", file: "customs.png", credit: "3D map by RE3MR · reemr.se" },
  { key: "woods", url: "https://reemr.se/maps/Woods/WoodsRe3mrClean.jpg", file: "woods.jpg", credit: "3D map by RE3MR · reemr.se" },
  { key: "streets-of-tarkov", url: "https://reemr.se/maps/Streets/re3mrStreetsofTarkov.png", file: "streets.png", credit: "3D map by RE3MR · reemr.se" },
  { key: "shoreline", url: "https://reemr.se/maps/Shoreline/re3mrShoreline2.png", file: "shoreline.png", credit: "3D map by RE3MR · reemr.se" },
  { key: "lighthouse", url: "https://reemr.se/maps/Lighthouse/re3mrLighthouseVERT.png", file: "lighthouse.png", credit: "3D map by RE3MR · reemr.se" },
  { key: "reserve", url: "https://reemr.se/maps/Reserve/Re3mrReserveLossless.png", file: "reserve.png", credit: "3D map by RE3MR · reemr.se" },
  { key: "icebreaker", url: "https://reemr.se/maps/Icebreaker/re3mrIcebreaker.png", file: "icebreaker.png", credit: "3D map by RE3MR · reemr.se" },
];

export function sourceFor(key: string): Re3mrSource | null {
  return SOURCES.find((s) => s.key === key) ?? null;
}

/** [gameX, gameZ, imagePxX, imagePxY] */
export type ControlPoint = [number, number, number, number];

/** px = ax·x + bx·z + cx ; py = ay·x + by·z + cy */
export interface Affine {
  ax: number;
  bx: number;
  cx: number;
  ay: number;
  by: number;
  cy: number;
}

export interface Registration {
  key: string;
  width: number;
  height: number;
  points: ControlPoint[];
  affine: Affine;
  /** mean residual in metres */
  errorM: number;
  /** image pixels per metre */
  pxPerM: number;
}

function solve3(S: number[][], b: number[]): number[] {
  const [[a, b1, c], [d, e, f], [g, h, i]] = S;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b1 * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("degenerate control points");
  const inv = [
    [A / det, -(b1 * i - c * h) / det, (b1 * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b1 * g) / det, (a * e - b1 * d) / det],
  ];
  return inv.map((row) => row[0] * b[0] + row[1] * b[1] + row[2] * b[2]);
}

/** Least-squares affine fit of game (x,z) → image (px,py). Needs ≥3 non-collinear points. */
export function fitAffine(points: ControlPoint[]): Affine {
  if (points.length < 3) throw new Error("need at least 3 control points");
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bx = [0, 0, 0], by = [0, 0, 0];
  for (const [x, z, px, py] of points) {
    const v = [x, z, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j];
      bx[i] += v[i] * px;
      by[i] += v[i] * py;
    }
  }
  const X = solve3(S, bx), Y = solve3(S, by);
  return { ax: X[0], bx: X[1], cx: X[2], ay: Y[0], by: Y[1], cy: Y[2] };
}

export function project(a: Affine, x: number, z: number): [number, number] {
  return [a.ax * x + a.bx * z + a.cx, a.ay * x + a.by * z + a.cy];
}

/** Invert the affine: image px → game (x,z). */
export function unproject(a: Affine, px: number, py: number): [number, number] {
  const det = a.ax * a.by - a.bx * a.ay;
  const u = px - a.cx, v = py - a.cy;
  return [(a.by * u - a.bx * v) / det, (-a.ay * u + a.ax * v) / det];
}

export function pxPerMetre(a: Affine): number {
  return Math.sqrt(Math.abs(a.ax * a.by - a.bx * a.ay));
}

export function residuals(a: Affine, points: ControlPoint[]): number[] {
  const s = pxPerMetre(a);
  return points.map(([x, z, px, py]) => {
    const [qx, qy] = project(a, x, z);
    return Math.hypot(qx - px, qy - py) / s;
  });
}

export function register(key: string, width: number, height: number, points: ControlPoint[]): Registration {
  const affine = fitAffine(points);
  const r = residuals(affine, points);
  return { key, width, height, points, affine, errorM: r.reduce((a, b) => a + b, 0) / r.length, pxPerM: pxPerMetre(affine) };
}

export function loadRegistration(dir: string, key: string): Registration | null {
  try {
    const f = join(dir, `${key}.json`);
    if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, "utf8")) as Registration;
    return j && j.affine && Array.isArray(j.points) ? j : null;
  } catch {
    return null;
  }
}

export function saveRegistration(dir: string, reg: Registration): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${reg.key}.json`), JSON.stringify(reg, null, 2));
}

/** Zoom levels for a tile pyramid: 0 = whole image in one 256 tile … max = native. */
export function pyramidLevels(width: number, height: number, tile = 256): number {
  const max = Math.max(width, height);
  return Math.max(0, Math.ceil(Math.log2(max / tile)));
}

/** Tiles at a zoom for an image: {z, x, y, sx, sy, sw, sh} in source pixels. */
export function tilesAt(width: number, height: number, z: number, maxZ: number, tile = 256): Array<{ z: number; x: number; y: number; sx: number; sy: number; sw: number; sh: number; scale: number }> {
  const scale = 2 ** (maxZ - z); // source px per output px
  const out = [];
  const srcTile = tile * scale;
  for (let y = 0; y * srcTile < height; y++) {
    for (let x = 0; x * srcTile < width; x++) {
      out.push({ z, x, y, sx: x * srcTile, sy: y * srcTile, sw: Math.min(srcTile, width - x * srcTile), sh: Math.min(srcTile, height - y * srcTile), scale });
    }
  }
  return out;
}
