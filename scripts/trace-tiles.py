"""Trace a tile-only map (no vector anywhere) into a floor-plan SVG from the photo tiles' alpha footprint.

usage: python scripts/trace-tiles.py <mapKey> [--zoom 4] [--out data/svg/<key>.svg]

For every tile layer of the map (base + floors) the cached tiles are stitched at the zoom, cropped to the
map's bounds rectangle (so the SVG viewBox maps onto `bounds` exactly like tarkov.dev's SVGs), the alpha
channel is traced into floor polygons (class "floor") and the dark interior edges into wall strokes
(class "wall"). Groups: the base layer is <g id="Ground_Level">, each floor layer <g id="<Layer Name>">.
Output goes through the same style engine as every other map. Needs opencv-python-headless + numpy.
"""
import json, os, sys, math
import numpy as np, cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(os.environ["APPDATA"], "tarkovmap", "tiles")
args = sys.argv[1:]
KEY = args[0]
ZOOM = int(args[args.index("--zoom") + 1]) if "--zoom" in args else 4
OUT = args[args.index("--out") + 1] if "--out" in args else os.path.join(ROOT, "data", "svg", f"{KEY}.svg")

raw = json.load(open(os.path.join(ROOT, "data", "maps.json"), encoding="utf8"))
groups = raw if isinstance(raw, list) else raw.get("maps") or list(raw.values())
mdef = None
for g in groups:
    for m in (g.get("maps") or [g]):
        if m.get("projection") == "interactive" and m.get("bounds") and (m.get("key") or m.get("normalizedName")) == KEY: mdef = m
assert mdef, KEY
T = mdef["transform"]; ROT = mdef.get("coordinateRotation", 0); tile = mdef.get("tileSize", 256)
def px0(x, z):
    a = math.radians(ROT); c, s = math.cos(a), math.sin(a)
    rx, rz = x * c - z * s, x * s + z * c
    return T[0] * rx + T[1], -T[2] * rz + T[3]
(x0, z0), (x1, z1) = mdef["bounds"]
corners = [px0(x, z) for x in (x0, x1) for z in (z0, z1)]
S = 2 ** ZOOM
bx0, bx1 = min(c[0] for c in corners) * S, max(c[0] for c in corners) * S
by0, by1 = min(c[1] for c in corners) * S, max(c[1] for c in corners) * S
W, H = int(round(bx1 - bx0)), int(round(by1 - by0))

def stitch(template):
    rel = template.split("/maps/", 1)[1]
    canvas = np.zeros((H, W, 4), np.uint8)
    tx0, tx1 = int(bx0 // tile), int(bx1 // tile); ty0, ty1 = int(by0 // tile), int(by1 // tile)
    n = 0
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            p = os.path.join(CACHE, rel.replace("{z}", str(ZOOM)).replace("{x}", str(tx)).replace("{y}", str(ty)))
            if not os.path.exists(p): continue
            im = cv2.imread(p, cv2.IMREAD_UNCHANGED)
            if im is None: continue
            if im.ndim == 2: im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
            elif im.shape[2] == 3: im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
            im = cv2.resize(im, (tile, tile), interpolation=cv2.INTER_AREA)
            ox, oy = int(tx * tile - bx0), int(ty * tile - by0)
            xa, ya = max(0, ox), max(0, oy); xb, yb = min(W, ox + tile), min(H, oy + tile)
            if xb <= xa or yb <= ya: continue
            canvas[ya:yb, xa:xb] = im[ya - oy:yb - oy, xa - ox:xb - ox]; n += 1
    return canvas, n

def trace(canvas):
    alpha = canvas[..., 3]
    # void is transparent in some tiles and opaque near-black in others (the render's backdrop)
    bright = canvas[..., :3].max(axis=2)
    mask = ((alpha > 40) & (bright > 28)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    floors = []
    for i, c in enumerate(contours):
        if cv2.contourArea(c) < 60: continue
        approx = cv2.approxPolyDP(c, 1.2, True)
        hole = hier[0][i][3] != -1
        floors.append((approx.reshape(-1, 2), hole))
    # walls: dark structure inside the footprint (edges of the photo), thinned to lines
    g = cv2.cvtColor(canvas[..., :3], cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(g, (0, 0), 1.0)
    edges = cv2.Canny(g, 60, 140)
    edges[mask == 0] = 0
    er = cv2.erode(mask, np.ones((7, 7), np.uint8))
    edges[er == 0] = 0  # keep interior edges only; the outline is the floor polygon itself
    wall_contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    walls = [cv2.approxPolyDP(c, 1.2, False).reshape(-1, 2) for c in wall_contours if len(c) >= 6 and cv2.arcLength(c, False) >= 18]
    return floors, walls

def poly_path(pts, close=True):
    d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    return d + (" Z" if close else "")

layers = [("Ground_Level", mdef["tilePath"])] + [(l["name"], l["tilePath"]) for l in (mdef.get("layers") or []) if l.get("tilePath") and l["tilePath"] != mdef["tilePath"]]
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">', '<style>.floor{fill:#e0c9a0;stroke:#5d4832;stroke-width:1.2}.wall{fill:none;stroke:#3a3129;stroke-width:.7;opacity:.7}</style>']
for name, tpl in layers:
    canvas, n = stitch(tpl)
    if n == 0: print("no tiles for", name); continue
    floors, walls = trace(canvas)
    gid = name if name == "Ground_Level" else name
    parts.append(f'<g id="{gid}">')
    parts.append('<g id="Floor">')
    # even-odd so holes cut out
    outer = [poly_path(p) for p, hole in floors if not hole]; holes = [poly_path(p) for p, hole in floors if hole]
    if outer: parts.append(f'<path class="floor" fill-rule="evenodd" d="{" ".join(outer + holes)}"/>')
    parts.append("</g><g id=\"Wall\">")
    for w in walls:
        if len(w) >= 2: parts.append(f'<path class="wall" d="{poly_path(w, False)}"/>')
    parts.append("</g></g>")
    print(f"{KEY} / {name}: {n} tiles, {len(floors)} floor polygons, {len(walls)} wall strokes")
parts.append("</svg>")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf8").write("\n".join(parts))
print("wrote", OUT, f"viewBox 0 0 {W} {H}")
