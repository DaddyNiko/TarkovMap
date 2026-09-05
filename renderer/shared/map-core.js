/* TarkovMap renderer core: Leaflet CRS from tarkov.dev's maps.json, layers,
 * markers, projection helpers. Classic script; exposes window.TM. */
(function () {
  const TM = {};

  TM.RAID_MINUTES = { customs: 40, woods: 40, shoreline: 45, interchange: 40, reserve: 40, lighthouse: 40, "streets-of-tarkov": 45, "the-lab": 35, factory: 20, "ground-zero": 35, "the-labyrinth": 35, icebreaker: 40, terminal: 40 };

  TM.COLORS = { extract: "#78e68c", scavExtract: "#b8f0a0", transit: "#9be0ff", quest: "#ffc45c", loot: "#ff6e96", key: "#c8a0ff", squad: "#60c8ff", boss: "#ff5a5a", scav: "#d9c27a", hazard: "#ff8a3d", ping: "#ffc45c", gun: "#bfbfbf", switch: "#7fe3ff" };

  TM.rot = function (ll, r) {
    if (!r) return ll;
    const a = (r * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const x = ll.lng, y = ll.lat;
    return L.latLng(x * s + y * c, x * c - y * s);
  };

  TM.crsFor = function (def) {
    const T = def.transform || [1, 0, 1, 0];
    const R = def.coordinateRotation || 0;
    return L.extend({}, L.CRS.Simple, {
      transformation: new L.Transformation(T[0], T[1], -T[2], T[3]),
      projection: L.extend({}, L.Projection.LonLat, {
        project: (ll) => L.Projection.LonLat.project(TM.rot(ll, R)),
        unproject: (p) => TM.rot(L.Projection.LonLat.unproject(p), -R),
      }),
    });
  };

  TM.pos = (x, z) => L.latLng(z, x);
  TM.boundsFor = (def) => L.latLngBounds([def.bounds[0][1], def.bounds[0][0]], [def.bounds[1][1], def.bounds[1][0]]);

  TM.dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  TM.bearing = (a, b) => { let d = (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI; if (d < 0) d += 360; return d; };
  TM.fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
  TM.glyph = function (rel) {
    // rel = bearing relative to facing, 0 = ahead
    const r = ((rel % 360) + 360) % 360;
    if (r < 22.5 || r >= 337.5) return "▲";
    if (r < 67.5) return "◥";
    if (r < 112.5) return "▶";
    if (r < 157.5) return "◢";
    if (r < 202.5) return "▼";
    if (r < 247.5) return "◣";
    if (r < 292.5) return "◀";
    return "◤";
  };

  /** A tile layer that falls back to the remote URL when the local cache misses. */
  TM.tileLayer = function (remote, local, opts) {
    const layer = L.tileLayer(local || remote, Object.assign({ tileSize: 256, keepBuffer: 4, updateWhenIdle: false, crossOrigin: false }, opts));
    if (local && local !== remote) {
      layer.on("tileerror", (e) => {
        const img = e.tile;
        if (img && !img.dataset.fallback) {
          img.dataset.fallback = "1";
          img.src = remote.replace("{z}", e.coords.z).replace("{x}", e.coords.x).replace("{y}", e.coords.y);
        }
      });
    }
    return layer;
  };

  /**
   * Build a map into `el` for a map payload {def, svg, localTemplates}.
   * Returns {map, setFloor(name|null), floors[]}.
   */
  TM.buildMap = function (el, payload, options) {
    const def = payload.def;
    const crs = TM.crsFor(def);
    const bounds = TM.boundsFor(def);
    const map = L.map(el, Object.assign({
      crs, zoomControl: false, attributionControl: false, minZoom: Math.max(1, (def.minZoom || 2) - 1), maxZoom: (def.maxZoom || 6) + 1,
      zoomSnap: 0.25, zoomDelta: 0.5, inertia: true, fadeAnimation: false, zoomAnimation: true, markerZoomAnimation: false, doubleClickZoom: false,
    }, options || {}));
    const tileSize = def.tileSize || 256;
    let base = null, baseSvgEl = null;
    const floorLayers = new Map();
    if (def.tilePath) {
      base = TM.tileLayer(def.tilePath, payload.localTemplates[def.tilePath], { tileSize, bounds, className: "tm-base" }).addTo(map);
    } else if (payload.svg) {
      const wrap = document.createElement("div");
      wrap.innerHTML = payload.svg;
      baseSvgEl = wrap.querySelector("svg");
      if (baseSvgEl) {
        base = L.svgOverlay(baseSvgEl, bounds, { className: "tm-base-svg", interactive: false }).addTo(map);
      }
    }
    const floors = (def.layers || []).map((l) => l.name);
    for (const l of def.layers || []) {
      if (l.tilePath) floorLayers.set(l.name, { kind: "tile", layer: TM.tileLayer(l.tilePath, payload.localTemplates[l.tilePath], { tileSize, bounds, className: "tm-floor" }), svgLayer: l.svgLayer });
      else if (l.svgLayer) floorLayers.set(l.name, { kind: "svg", svgLayer: l.svgLayer });
    }
    let current = null;
    function showSvgGroup(id) {
      if (!baseSvgEl) return;
      const root = baseSvgEl.children[0] && baseSvgEl.children[0].tagName === "g" && !baseSvgEl.children[0].id ? baseSvgEl.children[0] : baseSvgEl;
      for (const g of root.querySelectorAll(":scope > g[id]")) {
        const isBase = g.id === (def.svgLayer || "Ground_Level");
        g.style.display = id ? (g.id === id ? "" : isBase ? "" : "none") : isBase ? "" : (floors.some((f) => (floorLayers.get(f) || {}).svgLayer === g.id) ? "none" : "");
        if (id && isBase && g.id !== id) g.style.opacity = "0.35"; else g.style.opacity = "";
      }
    }
    function setFloor(name) {
      if (name === current) return;
      for (const [n, f] of floorLayers) if (f.kind === "tile" && n !== name && map.hasLayer(f.layer)) map.removeLayer(f.layer);
      current = name;
      const f = name ? floorLayers.get(name) : null;
      if (f && f.kind === "tile") {
        f.layer.addTo(map);
        if (base && base.getContainer) base.getContainer().classList.add("tm-dim");
        showSvgGroup(f.svgLayer || null);
      } else {
        if (base && base.getContainer) base.getContainer().classList.remove("tm-dim");
        showSvgGroup(f ? f.svgLayer : null);
      }
    }
    showSvgGroup(null);
    return { map, setFloor, floors, bounds, def };
  };

  // ── marker factories ────────────────────────────────────────────────────
  const icon = (html, size, anchor, cls) => L.divIcon({ className: cls || "tm-ico", html, iconSize: size, iconAnchor: anchor });
  TM.icon = icon;

  TM.pin = (color, label, sub) => icon(`<div class="tm-pin" style="background:${color}"><i></i></div>${label ? `<div class="tm-lbl">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>` : ""}`, [14, 14], [7, 14]);
  TM.dot = (color, label) => icon(`<div class="tm-dot" style="background:${color}"></div>${label ? `<div class="tm-lbl tm-lbl-dot">${esc(label)}</div>` : ""}`, [9, 9], [4, 4]);
  TM.place = (text, size) => icon(`<div class="tm-place" style="font-size:${size ? Math.round(size / 9) : 10}px">${esc(text)}</div>`, [0, 0], [0, 0]);
  TM.me = () => icon('<div class="tm-cone"></div><div class="tm-me"></div>', [0, 0], [0, 0]);
  TM.mate = (name, sub, color) => icon(`<div class="tm-mate" style="border-bottom-color:${color || TM.COLORS.squad}"></div><div class="tm-lbl" style="color:${color || TM.COLORS.squad}">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`, [0, 0], [0, 0]);
  TM.ping = (text, who) => icon(`<div class="tm-ping"></div><div class="tm-lbl" style="color:${TM.COLORS.ping}">${esc(text)}${who ? `<small>${esc(who)}</small>` : ""}</div>`, [0, 0], [0, 0]);
  TM.portrait = (url, label, sub) => icon(`<img class="tm-av" src="${url}" onerror="this.style.display='none'"><div class="tm-lbl">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`, [26, 26], [13, 13]);

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  TM.esc = esc;

  /** Which extracts apply to the player's side. */
  TM.extractsFor = function (features, side) {
    if (!features) return [];
    const list = (features.extracts || []).filter((e) => {
      const f = String(e.faction || "shared").toLowerCase();
      return f === "shared" || f === side || (side === "pmc" && f === "pmc") || (side === "scav" && f === "scav");
    });
    const transits = (features.transits || []).map((t) => ({ id: t.id, name: t.description || "Transit", faction: "transit", position: t.position }));
    return list.concat(transits);
  };

  /** Rotate a vector by a unit quaternion (x,y,z,w). */
  function rotv(q, v) {
    const [qx, qy, qz, qw] = q;
    const ix = qw * v[0] + qy * v[2] - qz * v[1];
    const iy = qw * v[1] + qz * v[0] - qx * v[2];
    const iz = qw * v[2] + qx * v[1] - qy * v[0];
    const iw = -qx * v[0] - qy * v[1] - qz * v[2];
    return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
  }

  /**
   * Project a world point onto the screen given the camera fix (position +
   * quaternion), vertical FOV in degrees and the screen size. Returns
   * {x, y, behind, dist} in CSS pixels.
   */
  TM.projectToScreen = function (fix, fovDeg, W, H, target, eyeHeight) {
    const cam = [fix.x, fix.y + (eyeHeight == null ? 1.4 : eyeHeight), fix.z];
    const fwd = rotv(fix.q, [0, 0, 1]);
    const right = rotv(fix.q, [1, 0, 0]);
    const up = rotv(fix.q, [0, 1, 0]);
    const d = [target.x - cam[0], (target.y == null ? cam[1] : target.y) - cam[1], target.z - cam[2]];
    const zc = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
    const xc = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
    const yc = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    const dist = Math.hypot(d[0], d[1], d[2]);
    if (zc <= 0.5) return { behind: true, dist, x: 0, y: 0 };
    const tanV = Math.tan((fovDeg * Math.PI) / 360);
    const aspect = W / H;
    const x = W / 2 + ((xc / zc) / (tanV * aspect)) * (W / 2);
    const y = H / 2 - ((yc / zc) / tanV) * (H / 2);
    return { behind: false, dist, x, y };
  };

  window.TM = TM;
})();
