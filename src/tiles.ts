/**
 * Local tile cache. tarkov.dev serves each map as a {z}/{x}/{y}.png pyramid
 * over Leaflet's CRS.Simple; we fetch every tile inside the map's bounds once
 * and keep it under userData so the second monitor never depends on the
 * network mid-raid. SVG-only maps cache the SVG document the same way.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectToPixel, type MapDef } from "./map-data.js";

export interface TileRange {
  z: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Tile index ranges covering the map bounds at each zoom. */
export function tileRanges(map: MapDef): TileRange[] {
  const tileSize = map.tileSize ?? 256;
  const c1 = projectToPixel(map, map.bounds[0][0], map.bounds[0][1]);
  const c2 = projectToPixel(map, map.bounds[1][0], map.bounds[1][1]);
  const minX = Math.min(c1.px, c2.px), maxX = Math.max(c1.px, c2.px);
  const minY = Math.min(c1.py, c2.py), maxY = Math.max(c1.py, c2.py);
  const out: TileRange[] = [];
  for (let z = map.minZoom ?? 1; z <= (map.maxZoom ?? 6); z++) {
    const s = 2 ** z;
    out.push({
      z,
      x0: Math.max(0, Math.floor((minX * s) / tileSize)),
      x1: Math.max(0, Math.floor((maxX * s) / tileSize)),
      y0: Math.max(0, Math.floor((minY * s) / tileSize)),
      y1: Math.max(0, Math.floor((maxY * s) / tileSize)),
    });
  }
  return out;
}

/** Every tile URL template the map uses (base + each floor). */
export function tileTemplates(map: MapDef): string[] {
  const t = [map.tilePath, ...(map.layers ?? []).map((l) => l.tilePath)].filter((x): x is string => Boolean(x));
  return [...new Set(t)];
}

/** Path inside the cache for a template + tile. */
export function localTilePath(cacheRoot: string, template: string, z: number, x: number, y: number): string {
  const rel = template.replace(/^https?:\/\/[^/]+\/maps\//, "").replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  return join(cacheRoot, rel);
}

/** The local template for the renderer (file:// URL), mirroring the remote layout. */
export function localTemplate(cacheRoot: string, template: string): string {
  const rel = template.replace(/^https?:\/\/[^/]+\/maps\//, "");
  return "file:///" + join(cacheRoot, rel).replace(/\\/g, "/");
}

export function svgLocalPath(cacheRoot: string, svgPath: string): string {
  return join(cacheRoot, "svg", svgPath.split("/").pop() ?? "map.svg");
}

export interface FetchProgress {
  map: string;
  done: number;
  total: number;
  failed: number;
}

/** Download every missing tile for a map. 404s are normal at pyramid edges. */
export async function cacheMapTiles(map: MapDef, cacheRoot: string, onProgress?: (p: FetchProgress) => void, concurrency = 8): Promise<FetchProgress> {
  const jobs: Array<{ url: string; file: string }> = [];
  for (const tpl of tileTemplates(map)) {
    for (const r of tileRanges(map)) {
      for (let x = r.x0; x <= r.x1; x++) {
        for (let y = r.y0; y <= r.y1; y++) {
          const file = localTilePath(cacheRoot, tpl, r.z, x, y);
          if (existsSync(file) || existsSync(file + ".missing")) continue;
          jobs.push({ url: tpl.replace("{z}", String(r.z)).replace("{x}", String(x)).replace("{y}", String(y)), file });
        }
      }
    }
  }
  if (map.svgPath) {
    const file = svgLocalPath(cacheRoot, map.svgPath);
    if (!existsSync(file)) jobs.push({ url: map.svgPath, file });
  }
  const p: FetchProgress = { map: map.key, done: 0, total: jobs.length, failed: 0 };
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      try {
        const res = await fetch(job.url, { signal: AbortSignal.timeout(30000) });
        mkdirSync(dirname(job.file), { recursive: true });
        if (res.status === 404) {
          writeFileSync(job.file + ".missing", "");
        } else if (res.ok) {
          writeFileSync(job.file, Buffer.from(await res.arrayBuffer()));
        } else {
          p.failed++;
        }
      } catch {
        p.failed++;
      }
      p.done++;
      onProgress?.(p);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return p;
}

export function readSvg(cacheRoot: string, svgPath: string): string | null {
  const f = svgLocalPath(cacheRoot, svgPath);
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
}
