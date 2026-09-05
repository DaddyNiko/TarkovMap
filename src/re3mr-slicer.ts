/**
 * Slice a big RE3MR render into a 256-px tile pyramid with Electron's
 * nativeImage (no native deps). Runs once per map in the main process;
 * a 7832×5016 PNG becomes ~830 tiles in well under a minute.
 */
import { nativeImage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pyramidLevels, tilesAt } from "./re3mr.js";

export interface SliceResult {
  key: string;
  width: number;
  height: number;
  maxZoom: number;
  tiles: number;
  dir: string;
}

export function pyramidDir(cacheRoot: string, key: string): string {
  return join(cacheRoot, "re3mr", "tiles", key);
}

export function pyramidDone(cacheRoot: string, key: string): SliceResult | null {
  try {
    const f = join(pyramidDir(cacheRoot, key), "pyramid.json");
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8")) as SliceResult;
  } catch {
    return null;
  }
}

export async function slice(cacheRoot: string, key: string, imagePath: string, onProgress?: (done: number, total: number) => void): Promise<SliceResult> {
  const done = pyramidDone(cacheRoot, key);
  if (done) return done;
  const img = nativeImage.createFromPath(imagePath);
  const { width, height } = img.getSize();
  if (!width || !height) throw new Error(`could not decode ${imagePath}`);
  const maxZ = pyramidLevels(width, height);
  const dir = pyramidDir(cacheRoot, key);
  const jobs: ReturnType<typeof tilesAt> = [];
  for (let z = 0; z <= maxZ; z++) jobs.push(...tilesAt(width, height, z, maxZ));
  let n = 0;
  // Pre-scale one copy per zoom so each tile is a cheap crop.
  const scaled = new Map<number, Electron.NativeImage>();
  for (const j of jobs) {
    let src = scaled.get(j.z);
    if (!src) {
      src = j.scale === 1 ? img : img.resize({ width: Math.round(width / j.scale), height: Math.round(height / j.scale), quality: "good" });
      scaled.set(j.z, src);
    }
    const x = Math.round(j.sx / j.scale), y = Math.round(j.sy / j.scale);
    const w = Math.max(1, Math.round(j.sw / j.scale)), h = Math.max(1, Math.round(j.sh / j.scale));
    const tile = src.crop({ x, y, width: Math.min(w, src.getSize().width - x), height: Math.min(h, src.getSize().height - y) });
    const out = join(dir, String(j.z), String(j.x), `${j.y}.png`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, tile.toPNG());
    n++;
    if (onProgress && (n % 25 === 0 || n === jobs.length)) onProgress(n, jobs.length);
    if (n % 40 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the event loop breathing
  }
  const result: SliceResult = { key, width, height, maxZoom: maxZ, tiles: n, dir };
  writeFileSync(join(dir, "pyramid.json"), JSON.stringify(result));
  return result;
}
