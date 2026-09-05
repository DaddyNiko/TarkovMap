/**
 * The plain-English filter prompt: "show extracts, dorm keys and anything
 * over 40k". Keyword rules first (free, instant, offline); when they don't
 * understand the sentence and an OpenRouter key exists, ask a free model to
 * emit the same structure. The model only ever sees the sentence.
 */

export const LAYER_IDS = ["extracts", "quests", "allquests", "questitems", "landmarks", "hud", "keys", "bosses", "scavs", "pmc", "hazards", "loot", "squad", "containers", "switches", "guns"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export interface FilterIntent {
  on: LayerId[];
  off: LayerId[];
  fleaMin?: number;
  /** Free-text search for a landmark/extract to fly to. */
  find?: string;
  /** Whether the keyword parser was confident. */
  understood: boolean;
}

const SYNONYMS: Record<LayerId, string[]> = {
  extracts: ["extract", "extracts", "exfil", "exit", "exits", "extraction"],
  quests: ["quest", "quests", "task", "tasks", "objective", "objectives"],
  allquests: ["all quests", "every quest", "future quests", "locked quests", "all tasks", "every task"],
  questitems: ["quest items", "quest item", "items for quests", "quest loot", "fir items", "items to pick up", "pick up"],
  pmc: ["pmc spawns", "pmc spawn", "player spawns", "pmcs"],
  landmarks: ["landmark", "landmarks", "place", "places", "name", "names", "label", "labels"],
  hud: ["hud", "distance", "distances", "text", "meters", "metres"],
  keys: ["key", "keys", "door", "doors", "lock", "locks", "locked"],
  bosses: ["boss", "bosses", "rogue", "rogues", "goons", "reshala", "killa", "glukhar", "shturman", "sanitar", "tagilla", "cultist", "cultists", "raider", "raiders"],
  scavs: ["scav", "scavs", "spawn", "spawns", "sniper", "snipers"],
  hazards: ["hazard", "hazards", "mine", "mines", "minefield", "mortar", "danger"],
  loot: ["loot", "valuable", "valuables", "item", "items", "ledx", "flea", "money", "roubles", "rubles"],
  squad: ["squad", "team", "teammate", "teammates", "friends", "group"],
  containers: ["container", "containers", "safe", "safes", "crate", "crates", "jacket", "jackets", "drawer", "drawers", "toolbox", "weapon box"],
  switches: ["switch", "switches", "power", "lever"],
  guns: ["stationary", "machine gun", "mg", "utyos", "gun nest"],
};

const MONEY_RE = /(?:over|above|at least|min(?:imum)?|>=?|worth|more than)\s*(\d+(?:[.,]\d+)?)\s*(k|m|thousand|million)?|(\d+(?:[.,]\d+)?)\s*(k|m)\b/i;

export function parseFilterPrompt(text: string): FilterIntent {
  let t = text.toLowerCase().trim();
  const on: LayerId[] = [];
  const off: LayerId[] = [];
  let understood = false;
  // Multi-word layers first, and the phrase leaves the sentence so "all quests" is not also "all" + "quests".
  const hideModeEarly = /\b(hide|remove|without|no|off|clear)\b/.test(t) && !/\b(show|display|add)\b/.test(t);
  for (const id of ["allquests", "questitems", "pmc"] as const) {
    for (const w of SYNONYMS[id]) {
      const re = new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`);
      if (re.test(t)) { understood = true; (hideModeEarly ? off : on).push(id); t = t.replace(re, " "); break; }
    }
  }
  const hideMode = /\b(hide|remove|without|no|off|clear)\b/.test(t);
  const onlyMode = /\b(only|just)\b/.test(t);
  for (const id of LAYER_IDS) {
    if (on.includes(id) || off.includes(id)) continue;
    if (SYNONYMS[id].some((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`).test(t))) {
      understood = true;
      (hideMode && !/\b(show|display|add)\b/.test(t) ? off : on).push(id);
    }
  }
  if (onlyMode && on.length) for (const id of LAYER_IDS) if (!on.includes(id) && id !== "hud" && id !== "landmarks") off.push(id);
  let fleaMin: number | undefined;
  const m = MONEY_RE.exec(t);
  if (m) {
    const raw = (m[1] ?? m[3] ?? "").replace(",", ".");
    const unit = (m[2] ?? m[4] ?? "").toLowerCase();
    let v = Number.parseFloat(raw);
    if (Number.isFinite(v)) {
      if (unit.startsWith("k") || unit === "thousand") v *= 1000;
      if (unit.startsWith("m") || unit === "million") v *= 1_000_000;
      fleaMin = Math.round(v);
      if (!on.includes("loot")) on.push("loot");
      understood = true;
    }
  }
  if (/\b(all|everything|reset)\b/.test(t) && on.length === 0) {
    understood = true;
    if (hideMode) off.push(...LAYER_IDS.filter((x) => x !== "hud"));
    else on.push("extracts", "quests", "landmarks", "hud");
  }
  const find = /\b(?:find|where(?: is|'s)?|go to|fly to|show me)\s+([a-z0-9' -]{3,})$/.exec(t)?.[1]?.trim();
  return { on, off, fleaMin, find: on.length === 0 && find ? find : undefined, understood: understood || Boolean(find) };
}

export const MODEL_SYSTEM = `You convert a player's sentence about a map overlay into JSON. Layers: ${LAYER_IDS.join(", ")}. Reply with ONLY {"on":[...],"off":[...],"fleaMin":number|null,"find":string|null}. fleaMin is a rouble threshold for loot spawns (40k = 40000). find is a place name to locate. No prose.`;

/** Ask an OpenRouter model (free rung first). Returns null on any failure. */
export async function askModelForIntent(sentence: string, apiKey: string, model = "openrouter/free"): Promise<FilterIntent | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "HTTP-Referer": "https://github.com/DaddyNiko/TarkovMap", "X-Title": "TarkovMap" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: MODEL_SYSTEM }, { role: "user", content: sentence.slice(0, 400) }], max_tokens: 200, temperature: 0 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content ?? "";
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    const o = JSON.parse(m[0]) as { on?: unknown; off?: unknown; fleaMin?: unknown; find?: unknown };
    const pick = (v: unknown): LayerId[] => (Array.isArray(v) ? v.filter((x): x is LayerId => (LAYER_IDS as readonly string[]).includes(String(x))) : []);
    return {
      on: pick(o.on),
      off: pick(o.off),
      fleaMin: typeof o.fleaMin === "number" && o.fleaMin > 0 ? Math.round(o.fleaMin) : undefined,
      find: typeof o.find === "string" && o.find.trim() ? o.find.trim() : undefined,
      understood: true,
    };
  } catch {
    return null;
  }
}
