"""Automatic RE3MR render registration against tarkov.dev's photo tiles.

usage: python scripts/register-re3mr.py <mapKey> [--debug] [--coarse-only] [--ignore-existing]

1. Stitch the cached tarkov.dev main tiles into one raster per zoom whose pixel→game mapping is
   exact (maps.json transform — mirrors src/map-data.ts projectToPixel).
2. COARSE: a global homography render→game from (a) data/re3mr/<key>.coarse.json — ≥4 pairs
   [[x, z, renderPx, renderPy]] (game metres, full render px) eyeballed on the thumbnails written to
   data/re3mr/thumbs/, (b) an existing data/re3mr/<key>.json registration, or
   (c) SIFT, which rarely works between a top-down and an oblique render.
3. FINE, coarse-to-fine over zooms 3 → 4 → 5: warp the render into the tile frame, slide a grid of
   patches over it and find each patch's true offset by normalised cross-correlation of edge maps
   against the tiles; fit a homography with RANSAC; that becomes the next zoom's coarse guess.
4. Write data/re3mr/<key>.points.json — control points [x, z, px, py] (game metres ↔ render px) and
   the residuals. `node scripts/register-re3mr.mjs <key>` turns that into the app's registration.
Needs opencv-python-headless + numpy (pip).
"""
import json, os, sys, math
import numpy as np, cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(os.environ["APPDATA"], "tarkovmap")
OUTDIR = os.path.join(ROOT, "data", "re3mr")
THUMBS = os.path.join(OUTDIR, "thumbs"); os.makedirs(THUMBS, exist_ok=True)
args = sys.argv[1:]
KEY = args[0]
DEBUG = "--debug" in args
COARSE_ONLY = "--coarse-only" in args
TH = 1600

maps = json.load(open(os.path.join(ROOT, "data", "maps.json"), encoding="utf8"))
maps = (maps if isinstance(maps, list) else maps.get("maps") or list(maps.values()))
flat = []
for m in maps:
    flat.extend(m.get("maps") or [m])
mdef = next(m for m in flat if (m.get("key") or m.get("normalizedName")) == KEY)
src = json.load(open(os.path.join(OUTDIR, "sources.json"), encoding="utf8"))[KEY]

T = mdef["transform"]; ROT = mdef.get("coordinateRotation", 0)
def game_to_px0(x, z):
    a = math.radians(ROT); c, s = math.cos(a), math.sin(a)
    rx, rz = x * c - z * s, x * s + z * c
    return T[0] * rx + T[1], -T[2] * rz + T[3]
def px0_to_game(px, py):
    rx = (px - T[1]) / T[0]; rz = -(py - T[3]) / T[2]
    a = math.radians(-ROT); c, s = math.cos(a), math.sin(a)
    return rx * c - rz * s, rx * s + rz * c

(x0, z0), (x1, z1) = mdef["bounds"]  # [x, z] pairs (TM.boundsFor)
corners0 = [game_to_px0(x, z) for x in (x0, x1) for z in (z0, z1)]
tile = mdef.get("tileSize", 256)
rel = mdef["tilePath"].split("/maps/", 1)[1]

class Level:
    def __init__(self, zoom):
        self.zoom = zoom; S = 2 ** zoom; self.S = S
        minx = min(c[0] for c in corners0) * S; maxx = max(c[0] for c in corners0) * S
        miny = min(c[1] for c in corners0) * S; maxy = max(c[1] for c in corners0) * S
        tx0, tx1 = int(minx // tile), int(maxx // tile); ty0, ty1 = int(miny // tile), int(maxy // tile)
        self.W, self.H = (tx1 - tx0 + 1) * tile, (ty1 - ty0 + 1) * tile
        self.origin = (tx0 * tile, ty0 * tile)
        self.canvas = np.zeros((self.H, self.W, 3), np.uint8); n = 0
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                p = os.path.join(CACHE, "tiles", rel.replace("{z}", str(zoom)).replace("{x}", str(tx)).replace("{y}", str(ty)))
                if not os.path.exists(p): continue
                im = cv2.imread(p, cv2.IMREAD_COLOR)
                if im is None: continue
                self.canvas[(ty - ty0) * tile:(ty - ty0 + 1) * tile, (tx - tx0) * tile:(tx - tx0 + 1) * tile] = cv2.resize(im, (tile, tile)); n += 1
        self.px_per_m = T[0] * S
        print(f"zoom {zoom}: {self.W}x{self.H}, {n} tiles, {self.px_per_m:.2f} px/m")
    def to_game(self, u, v): return px0_to_game((u + self.origin[0]) / self.S, (v + self.origin[1]) / self.S)
    def from_game(self, x, z): px, py = game_to_px0(x, z); return px * self.S - self.origin[0], py * self.S - self.origin[1]

levels = {z: Level(z) for z in (3, 4, 5)}
L5 = levels[5]
gx, gz = L5.to_game(*L5.from_game(123.4, -56.7)); assert abs(gx - 123.4) < 1e-6 and abs(gz + 56.7) < 1e-6

render = cv2.imread(os.path.join(CACHE, "re3mr", src["file"]), cv2.IMREAD_COLOR)
RH, RW = render.shape[:2]
crop = src.get("crop") or [0, 0, RW, RH]
print(f"render {RW}x{RH}, crop {crop}")
mask_r = np.zeros((RH, RW), np.uint8); mask_r[crop[1]:crop[3], crop[0]:crop[2]] = 255
cv2.imwrite(os.path.join(THUMBS, f"{KEY}.tiles.jpg"), cv2.resize(L5.canvas, (TH, int(L5.H * TH / L5.W))), [cv2.IMWRITE_JPEG_QUALITY, 80])
cv2.imwrite(os.path.join(THUMBS, f"{KEY}.render.jpg"), cv2.resize(render, (TH, int(RH * TH / RW))), [cv2.IMWRITE_JPEG_QUALITY, 80])

def gray(im): return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY))

# ── coarse: homography render px → game metres (H_rg) ───────────────────────
def H_from_pairs(render_pts, game_pts):
    Hm, _ = cv2.findHomography(np.float32(render_pts), np.float32(game_pts), 0); return Hm
H_rg = None
coarse_file = os.path.join(OUTDIR, f"{KEY}.coarse.json"); reg_file = os.path.join(OUTDIR, f"{KEY}.json")
if os.path.exists(coarse_file):
    pairs = json.load(open(coarse_file))  # [[x, z, renderPx, renderPy], ...] in GAME metres and full render px
    H_rg = H_from_pairs([[p[2], p[3]] for p in pairs], [[p[0], p[1]] for p in pairs])
    print(f"coarse: {len(pairs)} hand pairs")
elif os.path.exists(reg_file) and "--ignore-existing" not in args:
    a = json.load(open(reg_file))["affine"]
    H_rg = np.linalg.inv(np.array([[a["ax"], a["bx"], a["cx"]], [a["ay"], a["by"], a["cy"]], [0, 0, 1.0]]))
    print(f"coarse: existing {KEY}.json affine")
else:
    cs = 2000 / max(L5.W, RW)
    tiles_s = cv2.resize(L5.canvas, None, fx=cs, fy=cs, interpolation=cv2.INTER_AREA)
    rend_s = cv2.resize(render, None, fx=cs, fy=cs, interpolation=cv2.INTER_AREA)
    mask_s = cv2.resize(mask_r, (rend_s.shape[1], rend_s.shape[0]), interpolation=cv2.INTER_NEAREST)
    sift = cv2.SIFT_create(nfeatures=20000, contrastThreshold=0.02)
    kA, dA = sift.detectAndCompute(gray(tiles_s), None); kB, dB = sift.detectAndCompute(gray(rend_s), mask_s)
    if dA is not None and dB is not None:
        for d in (dA, dB): d /= (d.sum(1, keepdims=True) + 1e-7); np.sqrt(d, out=d)
        good = [m for m, n in cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=128)).knnMatch(dB, dA, k=2) if m.distance < 0.8 * n.distance]
        if len(good) >= 12:
            P = np.float32([kB[m.queryIdx].pt for m in good]) / cs; Q = np.float32([L5.to_game(*(np.array(kA[m.trainIdx].pt) / cs)) for m in good])
            Hm, inl = cv2.findHomography(P, Q, cv2.RANSAC, 15.0, maxIters=50000, confidence=0.9995)
            n = int(inl.sum()) if inl is not None else 0
            print(f"coarse SIFT: {len(good)} matches, {n} inliers")
            if n >= 15: H_rg = Hm
if H_rg is None:
    print(f"NO COARSE FIT. Eyeball >=4 pairs on data/re3mr/thumbs/{KEY}.tiles.jpg / {KEY}.render.jpg (zoom-5 tile px, full render px) into {os.path.basename(coarse_file)}.")
    sys.exit(2)
if COARSE_ONLY: sys.exit(0)

def edges(im):
    """Matching representation: blurred Canny edges + a road mask (grey, low-saturation ground), which
    the Customs experiment showed is the only pair of features shared by a top-down tile and an
    oblique render with different lighting. Both are blurred so a peak survives small perspective drift."""
    g = cv2.GaussianBlur(gray(im), (0, 0), 3)
    e = cv2.GaussianBlur(cv2.Canny(g, 40, 110).astype(np.float32), (0, 0), 6)
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    road = cv2.GaussianBlur(((hsv[..., 1] < 40) & (hsv[..., 2] > 90) & (hsv[..., 2] < 200)).astype(np.float32) * 255, (0, 0), 3)
    return e / (e.max() + 1e-6) + road / (road.max() + 1e-6)

def fine(level, H_rg, search_m, cell_px=320, step_px=128, ncc_min=0.25):
    """One coarse-to-fine pass at a zoom level. Returns control points [x, z, px, py] + per-point score."""
    gp = np.float32([[0, 0], [100, 0], [0, 100]]); cp = np.float32([level.from_game(x, z) for x, z in gp])
    G2C = np.vstack([cv2.getAffineTransform(gp, cp), [0, 0, 1]])  # game → canvas (exact, affine)
    H_rc = G2C @ H_rg
    warped = cv2.warpPerspective(render, H_rc, (level.W, level.H), flags=cv2.INTER_AREA)
    wmask = cv2.warpPerspective(mask_r, H_rc, (level.W, level.H), flags=cv2.INTER_NEAREST)
    Hinv = np.linalg.inv(H_rc)
    E_t, E_r = edges(level.canvas), edges(warped)
    SEARCH = int(math.ceil(search_m * level.px_per_m)); CELL = cell_px; STEP = step_px
    pts, scores, rej, best = [], [], {"mask": 0, "flat": 0, "weak": 0}, []
    for cy in range(SEARCH + CELL // 2, level.H - SEARCH - CELL // 2, STEP):
        for cx in range(SEARCH + CELL // 2, level.W - SEARCH - CELL // 2, STEP):
            y0, y1, xa, xb = cy - CELL // 2, cy + CELL // 2, cx - CELL // 2, cx + CELL // 2
            if wmask[y0:y1, xa:xb].mean() < 240: rej["mask"] += 1; continue
            patch = E_r[y0:y1, xa:xb]; win = E_t[y0 - SEARCH:y1 + SEARCH, xa - SEARCH:xb + SEARCH]
            if patch.std() < 0.05 or win.std() < 0.05: rej["flat"] += 1; continue
            res = cv2.matchTemplate(win, patch, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(res)
            r2 = res.copy(); cv2.circle(r2, loc, max(6, CELL // 16), -1, -1); _, mx2, _, _ = cv2.minMaxLoc(r2)
            best.append(float(mx))
            if mx < ncc_min or mx > 0.995 or mx - mx2 < 0.04: rej["weak"] += 1; continue
            tu, tv = cx + loc[0] - SEARCH, cy + loc[1] - SEARCH
            rp = Hinv @ np.array([cx, cy, 1.0]); rp /= rp[2]
            x, z = level.to_game(tu, tv)
            pts.append([round(float(x), 2), round(float(z), 2), round(float(rp[0]), 1), round(float(rp[1]), 1)]); scores.append(float(mx))
    q = np.percentile(best, [25, 50, 75, 95]).round(2).tolist() if best else []
    print(f"  zoom {level.zoom} search +-{search_m} m: {len(pts)} cells kept, rejected {rej}, NCC quartiles {q}")
    if DEBUG:
        cv2.imwrite(os.path.join(THUMBS, f"{KEY}.z{level.zoom}.warped.jpg"), cv2.resize(cv2.addWeighted(level.canvas, 0.5, warped, 0.5, 0), (TH, int(level.H * TH / level.W))), [cv2.IMWRITE_JPEG_QUALITY, 80])
    return pts, scores

def fit(pts, thresh_m):
    P = np.float32([[p[2], p[3]] for p in pts]); Q = np.float32([[p[0], p[1]] for p in pts])
    Hm, inl = cv2.findHomography(P, Q, cv2.RANSAC, thresh_m, maxIters=20000, confidence=0.999)
    if Hm is None or inl is None: return None, [], None
    inl = inl.ravel().astype(bool)
    kept = [p for p, k in zip(pts, inl) if k]
    P, Q = P[inl], Q[inl]
    Hm, _ = cv2.findHomography(P, Q, 0)
    proj = cv2.perspectiveTransform(P.reshape(-1, 1, 2), Hm).reshape(-1, 2)
    return Hm, kept, np.hypot(*(proj - Q).T)

schedule = [(3, 70.0, 15.0), (4, 25.0, 8.0), (5, 10.0, 5.0)]
pts = []; err = None
for zoom, search_m, thr in schedule:
    cand, _ = fine(levels[zoom], H_rg, search_m)
    if len(cand) < 8: print(f"  too few cells at zoom {zoom}"); break
    Hn, kept, e = fit(cand, thr)
    if Hn is None or len(kept) < 8: print(f"  no stable fit at zoom {zoom}"); break
    print(f"  fit zoom {zoom}: {len(kept)}/{len(cand)} inliers, mean {e.mean():.1f} m, p90 {np.percentile(e, 90):.1f} m, max {e.max():.1f} m")
    H_rg, pts, err = Hn, kept, e
if not pts: sys.exit(3)

P = np.float32([[p[2], p[3]] for p in pts]); Q = np.float32([[p[0], p[1]] for p in pts])
Af, _ = cv2.estimateAffine2D(P, Q, method=cv2.LMEDS)
ea = np.hypot(*((P @ Af[:, :2].T + Af[:, 2]) - Q).T)
print(f"final: {len(pts)} points | homography mean {err.mean():.1f} m p90 {np.percentile(err, 90):.1f} | affine mean {ea.mean():.1f} m p90 {np.percentile(ea, 90):.1f}")
grid = {}
for p, s in zip(pts, err):
    grid.setdefault((int(p[2] // (RW / 14)), int(p[3] // (RH / 10))), []).append((s, p))
thinned = []
for ps in grid.values():
    ps.sort(key=lambda t: t[0]); thinned.extend([p for _, p in ps[:2]])
json.dump({"key": KEY, "width": RW, "height": RH, "points": thinned, "homographyMeanErrM": round(float(err.mean()), 2), "affineMeanErrM": round(float(ea.mean()), 2), "homography": H_rg.tolist()}, open(os.path.join(OUTDIR, f"{KEY}.points.json"), "w"))
print(f"wrote {KEY}.points.json with {len(thinned)} points")
if DEBUG:
    vis = L5.canvas.copy()
    for (x, z, px, py) in thinned:
        u, v = L5.from_game(x, z); cv2.circle(vis, (int(u), int(v)), 12, (0, 0, 255), 3)
    cv2.imwrite(os.path.join(THUMBS, f"{KEY}.points.jpg"), cv2.resize(vis, (TH, int(L5.H * TH / L5.W))), [cv2.IMWRITE_JPEG_QUALITY, 80])
