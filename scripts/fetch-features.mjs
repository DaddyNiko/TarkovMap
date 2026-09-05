// Snapshot tarkov.dev's extracts/spawns/etc into data/features.json so a
// fresh install has markers before its first successful API call.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFeatures } from "../dist/map-features.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maps = await fetchFeatures();
writeFileSync(resolve(ROOT, "data", "features.json"), JSON.stringify({ fetchedAt: Date.now(), maps }));
console.log(`wrote data/features.json (${maps.length} maps)`);
