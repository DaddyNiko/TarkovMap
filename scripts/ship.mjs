// Copy release/TarkovMap.exe to the repo root — the one launcher he clicks.
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "release", "TarkovMap.exe");
const DEST = resolve(ROOT, "TarkovMap.exe");

if (!existsSync(SRC)) {
  console.error(`No build to ship: ${SRC} does not exist.`);
  process.exit(1);
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
if (existsSync(DEST) && statSync(SRC).size === statSync(DEST).size && sha(SRC) === sha(DEST)) {
  console.log("Already shipped.");
  process.exit(0);
}
try {
  copyFileSync(SRC, DEST);
  console.log(`Shipped ${(statSync(DEST).size / 1048576).toFixed(0)} MB → ${DEST}`);
} catch (e) {
  if (e.code === "EBUSY" || e.code === "EPERM") {
    console.log("TarkovMap.exe is running, so the root launcher is locked. Quit it from the tray and run `node scripts/ship.mjs`.");
    process.exit(0);
  }
  throw e;
}
