"""Loot-value heat cells from the game's own loot data (SPT dump): every static container on a map ×
that container type's item pool × flea prices → expected roubles per container → summed per hex cell.

usage: python scripts/loot-heat.py <mapKey> <sptDir> [--cell 25] [--out data/offline/loot-heat/<key>.json]
  sptDir must hold <sptId>-staticContainers.json, <sptId>-staticLoot.json, prices.json
Output: {"cell": m, "tiers": [t1..t4 thresholds], "cells": [{"x", "z", "v", "tier", "n", "top": [names]}]}
It is a POSSIBLE-loot map (what can spawn), never what did.
"""
import json, os, sys, math
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
KEY, SPT = args[0], args[1]
CELL = float(args[args.index("--cell") + 1]) if "--cell" in args else 25.0
OUT = args[args.index("--out") + 1] if "--out" in args else os.path.join(ROOT, "data", "offline", "loot-heat", f"{KEY}.json")
SPT_ID = {"customs": "bigmap", "factory": "factory4_day", "the-lab": "laboratory", "reserve": "rezervbase", "ground-zero": "sandbox", "streets-of-tarkov": "tarkovstreets", "woods": "woods", "shoreline": "shoreline", "interchange": "interchange", "lighthouse": "lighthouse", "terminal": "terminal"}[KEY]
containers = json.load(open(os.path.join(SPT, f"{SPT_ID}-staticContainers.json"), encoding="utf8"))["staticContainers"]
pools = json.load(open(os.path.join(SPT, f"{SPT_ID}-staticLoot.json"), encoding="utf8"))
prices = json.load(open(os.path.join(SPT, "prices.json"), encoding="utf8"))
names = {}
hb = os.path.join(SPT, "handbook.json")
if os.path.exists(hb):
    try:
        for it in json.load(open(hb, encoding="utf8")).get("Items", []): names[it["Id"]] = it.get("Id")
    except Exception: pass

def expected_value(tpl):
    p = pools.get(tpl)
    if not p: return 0.0, []
    dist = p.get("itemDistribution") or []
    tot = sum(d.get("relativeProbability", 0) for d in dist) or 1
    cnt = p.get("itemcountDistribution") or []
    ctot = sum(c.get("relativeProbability", 0) for c in cnt) or 1
    avg_count = sum(c.get("count", 0) * c.get("relativeProbability", 0) for c in cnt) / ctot if cnt else 1.0
    ev_item = sum(prices.get(d.get("tpl"), 0) * d.get("relativeProbability", 0) for d in dist) / tot
    top = sorted(((prices.get(d.get("tpl"), 0), d.get("tpl")) for d in dist), reverse=True)[:3]
    return avg_count * ev_item, [t for _, t in top]

def hex_key(x, z):
    # pointy-top hex grid in game metres
    w = CELL * math.sqrt(3); h = CELL * 1.5
    q = x / w; r = z / h
    row = round(r); col = round(q - (0.5 if row % 2 else 0))
    return (col, row)
def hex_center(col, row):
    w = CELL * math.sqrt(3); h = CELL * 1.5
    return ((col + (0.5 if row % 2 else 0)) * w, row * h)

cells = {}
skipped = 0
for entry in containers:
    c = entry.get("template") or entry
    prob = entry.get("probability", 1.0) or 1.0
    tpl = (c.get("Items") or [{}])[0].get("_tpl") or ""
    pos = c.get("Position") or {}
    x, z = pos.get("x"), pos.get("z")
    if x is None or (abs(x) < 1e-6 and abs(z) < 1e-6): skipped += 1; continue  # some entries carry no world position
    ev, top = expected_value(tpl)
    ev *= prob
    if ev <= 0: continue
    k = hex_key(x, z)
    e = cells.setdefault(k, {"v": 0.0, "n": 0, "top": {}})
    e["v"] += ev; e["n"] += 1
    for t in top: e["top"][t] = max(e["top"].get(t, 0), prices.get(t, 0))
vals = sorted(e["v"] for e in cells.values())
if not vals: print("no valued containers"); sys.exit(2)
q = lambda f: vals[min(len(vals) - 1, int(f * len(vals)))]
tiers = [q(0.35), q(0.6), q(0.8), q(0.93)]
out = []
for (col, row), e in cells.items():
    cx, cz = hex_center(col, row)
    tier = sum(1 for t in tiers if e["v"] >= t)
    out.append({"x": round(cx, 1), "z": round(cz, 1), "v": round(e["v"]), "tier": tier, "n": e["n"], "top": [t for t, _ in sorted(e["top"].items(), key=lambda kv: -kv[1])[:3]]})
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"key": KEY, "cell": CELL, "tiers": [round(t) for t in tiers], "cells": out}, open(OUT, "w"))
print(f"{KEY}: {len(containers)} containers ({skipped} without a position), {len(out)} cells, tiers {[round(t) for t in tiers]}, max {round(vals[-1])} ₽")
