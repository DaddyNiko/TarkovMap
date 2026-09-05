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
  // icebreaker deliberately absent: a 16-deck ship — the render is a poster, not a map to track on.
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
  /** Optional projective fit (row-major 3×3, game → px). Present only when it beats the affine. */
  homography?: number[];
  /** Mean error of the affine alone, for the Align page to show what the homography bought. */
  affineErrorM?: number;
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

/**
 * Least-squares homography game (x,z) → image px (normalised DLT). RE3MR's renders are oblique, so
 * an affine leaves 20-40 m of systematic error across a map; a homography absorbs the perspective.
 * Row-major 3×3, h[8] = 1. Needs ≥4 points in general position; returns null otherwise.
 */
export function fitHomography(points: ControlPoint[]): number[] | null {
  if (points.length < 4) return null;
  const norm = (pts: number[][]) => {
    const n = pts.length;
    const cx = pts.reduce((a, p) => a + p[0], 0) / n, cy = pts.reduce((a, p) => a + p[1], 0) / n;
    const d = pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / n || 1;
    const s = Math.SQRT2 / d;
    return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], pts: pts.map((p) => [s * (p[0] - cx), s * (p[1] - cy)]) };
  };
  const A = norm(points.map((p) => [p[0], p[1]])), B = norm(points.map((p) => [p[2], p[3]]));
  // Build the 2n×9 system and solve via the normal equations' smallest eigenvector (power-iteration on the inverse
  // is fragile; use Jacobi eigen-decomposition of the 9×9 AᵀA, which is tiny).
  const M: number[][] = Array.from({ length: 9 }, () => new Array(9).fill(0));
  for (let i = 0; i < points.length; i++) {
    const [x, y] = A.pts[i], [u, v] = B.pts[i];
    const rows = [[-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]];
    for (const r of rows) for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) M[a][b] += r[a] * r[b];
  }
  const h = smallestEigenvector(M);
  if (!h) return null;
  // denormalise: H = B.T⁻¹ · Hn · A.T
  const Hn = [h.slice(0, 3), h.slice(3, 6), h.slice(6, 9)];
  const inv3 = (t: number[]) => [1 / t[0], 0, -t[2] / t[0], 0, 1 / t[4], -t[5] / t[4], 0, 0, 1];
  const mul = (P: number[], Q: number[]) => { const R = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i * 3 + j] += P[i * 3 + k] * Q[k * 3 + j]; return R; };
  const H = mul(mul(inv3(B.T), Hn.flat()), A.T);
  if (!Number.isFinite(H[8]) || Math.abs(H[8]) < 1e-12) return null;
  return H.map((v) => v / H[8]);
}

function smallestEigenvector(M: number[][]): number[] | null {
  const n = M.length;
  const A = M.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (A[i][i] < A[best][best]) best = i;
  const v = V.map((r) => r[best]);
  return v.every((x) => Number.isFinite(x)) ? v : null;
}

/** Project with a homography (game → px). */
export function projectH(h: number[], x: number, z: number): [number, number] {
  const w = h[6] * x + h[7] * z + h[8];
  return [(h[0] * x + h[1] * z + h[2]) / w, (h[3] * x + h[4] * z + h[5]) / w];
}

/** Invert a 3×3 row-major homography. */
export function invertH(h: number[]): number[] {
  const [a, b, c, d, e, f, g, hh, i] = h;
  const A = e * i - f * hh, B = -(d * i - f * g), C = d * hh - e * g;
  const det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * hh), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * hh - b * g), a * e - b * d].map((v) => v / det);
  return inv;
}

export function residualsH(h: number[], points: ControlPoint[], pxPerM: number): number[] {
  return points.map(([x, z, px, py]) => { const [qx, qy] = projectH(h, x, z); return Math.hypot(qx - px, qy - py) / pxPerM; });
}

export function register(key: string, width: number, height: number, points: ControlPoint[]): Registration {
  const affine = fitAffine(points);
  const pxPerM = pxPerMetre(affine);
  const rA = residuals(affine, points);
  const errA = rA.reduce((a, b) => a + b, 0) / rA.length;
  const homography = points.length >= 6 ? fitHomography(points) : null;
  if (homography) {
    const rH = residualsH(homography, points, pxPerM);
    const errH = rH.reduce((a, b) => a + b, 0) / rH.length;
    // keep the projective fit only when it genuinely helps; a degenerate one must never win
    if (Number.isFinite(errH) && errH < errA * 0.9) return { key, width, height, points, affine, homography, errorM: errH, affineErrorM: errA, pxPerM };
  }
  return { key, width, height, points, affine, errorM: errA, affineErrorM: errA, pxPerM };
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
