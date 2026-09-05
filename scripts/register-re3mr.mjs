// Turn data/re3mr/<key>.points.json (from register-re3mr.py or hand-made) into the registration the app
// loads, through the SAME register() the Align page uses. usage: node scripts/register-re3mr.mjs <key> [...]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { register, saveRegistration } = await import(new URL("../dist/re3mr.js", import.meta.url).href);
for (const key of process.argv.slice(2)) {
  const f = join(ROOT, "data", "re3mr", `${key}.points.json`);
  if (!existsSync(f)) { console.error(`${key}: no ${f}`); continue; }
  const j = JSON.parse(readFileSync(f, "utf8"));
  const reg = register(key, j.width, j.height, j.points);
  saveRegistration(join(ROOT, "data", "re3mr"), reg);
  console.log(`${key}: ${reg.points.length} points, ${reg.homography ? "projective" : "affine"}, mean ${reg.errorM.toFixed(1)} m (affine ${reg.affineErrorM.toFixed(1)} m), ${reg.pxPerM.toFixed(2)} px/m`);
}
