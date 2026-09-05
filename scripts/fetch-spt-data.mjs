// Build data/offline/*.json from the SPT server dumps + tarkov-dev statics. Dev-time only; run after `npx tsc`.
//   node scripts/fetch-spt-data.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { SPT_LOCATIONS, sptToFeatures, sptQuestsToTasks } = await import(new URL("../dist/offline-data.js", import.meta.url).href);
const R = "https://raw.githubusercontent.com/sp-tarkov/server/master/project/assets/database";
const OUT = join(ROOT, "data", "offline");
mkdirSync(OUT, { recursive: true });
const get = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

const statics = await get("https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps_static.json").catch(() => ({}));
const maps = [];
const mapIdToName = {};
for (const [sptId, key] of Object.entries(SPT_LOCATIONS)) {
  let base;
  try { base = await get(`${R}/locations/${sptId}/base.json`); } catch (e) { console.log(`skip ${key}: ${e.message}`); continue; }
  if (base._Id) mapIdToName[base._Id] = key;
  const st = statics[key] || statics[sptId] || {};
  const snipers = (st.spawn_sniper_scav || []).map((s) => ({ name: s.name, position: s.position }));
  const f = sptToFeatures(base, key, snipers);
  maps.push(f);
  console.log(`${key}: ${f.spawns.length} spawns, ${f.pmcSpawns.length} pmc spawns, ${f.bosses.length} boss zones, ${f.extracts.length} extracts, ${f.hazards.length} sniper perches`);
}
writeFileSync(join(OUT, "features.json"), JSON.stringify({ fetchedAt: Date.now(), source: "spt", maps }));

const prices = await get(`${R}/templates/prices.json`);
writeFileSync(join(OUT, "prices.json"), JSON.stringify(prices));
console.log(`prices: ${Object.keys(prices).length} items`);

const quests = await get(`${R}/templates/quests.json`);
const en = await get(`${R}/locales/global/en.json`);
const tasks = sptQuestsToTasks(quests, en, mapIdToName);
// names.json: every locale key the JSON API (json.tarkov.dev) names things by — item / quest / trader /
// objective / container keys plus the map-specific strings (exfil names, hazards) it references.
const names = {};
for (const [k, v] of Object.entries(en)) if (typeof v === "string" && /^[0-9a-f]{24}( Name| ShortName| name| Nickname)?$/.test(k)) names[k] = v;
try {
  const jm = await get("https://json.tarkov.dev/regular/maps");
  const list = Array.isArray(jm.data.maps) ? jm.data.maps : Object.values(jm.data.maps);
  for (const m of list) for (const k of [m.name, ...(m.extracts ?? []).map((e) => e.name), ...(m.hazards ?? []).map((h) => h.name), ...(m.transits ?? []).flatMap((t) => [t.description, t.conditions])]) if (k && typeof en[k] === "string") names[k] = en[k];
  for (const m of list) if (m.id && m.normalizedName) mapIdToName[m.id] = mapIdToName[m.id] ?? ({ "night-factory": "factory", "ground-zero-21": "ground-zero", "ground-zero-tutorial": "ground-zero", "the-lab-dark": "the-lab" }[m.normalizedName] ?? m.normalizedName);
  console.log(`json.tarkov.dev maps: ${list.length} (locale keys picked up)`);
} catch (e) { console.log(`json.tarkov.dev maps skipped: ${e.message}`); }
try {
  const bosses = await get("https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/translations/en/bosses.json");
  for (const [k, v] of Object.entries(bosses)) if (typeof v === "string" && v && !/-(description|bio)$/.test(k)) names[k] = v;
} catch (e) { console.log(`boss names skipped: ${e.message}`); }
writeFileSync(join(OUT, "names.json"), JSON.stringify(names));
writeFileSync(join(OUT, "map-ids.json"), JSON.stringify(mapIdToName));
console.log(`names: ${Object.keys(names).length} keys, map ids: ${Object.keys(mapIdToName).length}`);
writeFileSync(join(OUT, "tasks.json"), JSON.stringify({ fetchedAt: Date.now(), source: "spt", tasks }));
console.log(`quests: ${tasks.length}`);
writeFileSync(join(OUT, "meta.json"), JSON.stringify({ fetchedAt: Date.now(), source: "github.com/sp-tarkov/server (game data dump) + the-hideout/tarkov-dev maps_static.json", note: "extract positions, keys, containers and quest zones come only from api.tarkov.dev" }, null, 2));
