"""Side-by-side crops for hand alignment of a RE3MR render to tarkov.dev tiles.

usage: python scripts/align-crops.py <mapKey> <label> <x> <z> [--size 480] [--rsize 700]
       python scripts/align-crops.py <mapKey> --labels          # one crop pair per maps.json label

Left: the zoom-5 tile stitch around game (x, z), crosshair at (x, z), grid every 50 px with tile
pixel coordinates. Right: the render around where the current coarse/registration predicts (x, z),
grid every 50 px with FULL render pixel coordinates. Read the same feature off both, then add
[tileU, tileV, renderPx, renderPy] to data/re3mr/<key>.coarse.json (tile px are zoom-5) — or the
game coordinate straight from the tile grid via the printed to_game() mapping.
Writes to data/re3mr/thumbs/crops/<key>-<label>.jpg.
"""
import json, os, sys, math
import numpy as np, cv2
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0], sys.argv[1], "--coarse-only"] + sys.argv[2:]
G = {"__file__": os.path.join(ROOT, "scripts", "register-re3mr.py"), "__name__": "reg"}
code = open(os.path.join(ROOT, "scripts", "register-re3mr.py"), encoding="utf8").read().split("if COARSE_ONLY: sys.exit(0)")[0]
exec(compile(code, "register-re3mr.py", "exec"), G)
globals().update({k: v for k, v in G.items() if not k.startswith("__")})
OUT = os.path.join(THUMBS, "crops"); os.makedirs(OUT, exist_ok=True)
rest = sys.argv[3:]
SIZE = int(rest[rest.index("--size") + 1]) if "--size" in rest else 480
RSIZE = int(rest[rest.index("--rsize") + 1]) if "--rsize" in rest else 700

def grid(im, x0, y0, step=50, color=(0, 255, 255)):
    h, w = im.shape[:2]
    for gx in range(0, w, step):
        cv2.line(im, (gx, 0), (gx, h), color, 1)
        cv2.putText(im, str(x0 + gx), (gx + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.38, color, 1, cv2.LINE_AA)
    for gy in range(0, h, step):
        cv2.line(im, (0, gy), (w, gy), color, 1)
        cv2.putText(im, str(y0 + gy), (2, gy + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.38, color, 1, cv2.LINE_AA)
    return im

def crop_at(im, cx, cy, size):
    h, w = im.shape[:2]
    x0 = int(max(0, min(w - size, cx - size / 2))); y0 = int(max(0, min(h - size, cy - size / 2)))
    return im[y0:y0 + size, x0:x0 + size].copy(), x0, y0

def pair(label, x, z):
    u, v = L5.from_game(x, z)
    left, lx, ly = crop_at(L5.canvas, u, v, SIZE)
    left = grid(left, lx, ly)
    cv2.drawMarker(left, (int(u - lx), int(v - ly)), (0, 0, 255), cv2.MARKER_CROSS, 40, 2)
    rp = H_rg_inv @ np.array([x, z, 1.0]); rp /= rp[2]
    right, rx, ry = crop_at(render, rp[0], rp[1], RSIZE)
    right = grid(right, rx, ry, color=(255, 200, 0))
    cv2.drawMarker(right, (int(rp[0] - rx), int(rp[1] - ry)), (0, 0, 255), cv2.MARKER_CROSS, 40, 2)
    right = cv2.resize(right, (SIZE, SIZE))
    canvas_img = np.hstack([left, right])
    cv2.putText(canvas_img, f"{label}  game ({x:.0f}, {z:.0f})  tiles z5 crosshair=({u:.0f},{v:.0f})  render pred=({rp[0]:.0f},{rp[1]:.0f}) crop scale {RSIZE / SIZE:.2f}", (6, SIZE - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    f = os.path.join(OUT, f"{KEY}-{label}.jpg".replace(" ", "_").replace("/", "-"))
    cv2.imwrite(f, canvas_img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print("wrote", f)

H_rg_inv = np.linalg.inv(H_rg)
if "--labels" in rest:
    for lab in mdef.get("labels", []):
        p = lab.get("position") or []
        if len(p) < 2: continue
        x, z = p[0], p[1]
        pair(lab.get("text", "label"), float(x), float(z))
else:
    label, x, z = rest[0], float(rest[1]), float(rest[2])
    pair(label, x, z)
print("to_game(u, v) for zoom-5 tile px: x = ", end="")
u0, v0 = L5.from_game(0, 0); u1, v1 = L5.from_game(100, 0); u2, v2 = L5.from_game(0, 100)
print(f"solve from origin z5=({u0:.1f},{v0:.1f}); +100x -> ({u1:.1f},{v1:.1f}); +100z -> ({u2:.1f},{v2:.1f})")
