/* TarkovMap renderer core: Leaflet CRS from tarkov.dev's maps.json, layers,
 * markers, projection helpers. Classic script; exposes window.TM. */
(function () {
  const TM = {};

  TM.RAID_MINUTES = { customs: 40, woods: 40, shoreline: 45, interchange: 40, reserve: 40, lighthouse: 40, "streets-of-tarkov": 45, "the-lab": 35, factory: 20, "ground-zero": 35, "the-labyrinth": 35, icebreaker: 40, terminal: 40 };

  /** THE layer list — every surface reads this one. Third field = the only surface that offers the chip. */
  TM.LAYERS = [["extracts", "Extracts"], ["quests", "Quests"], ["allquests", "All quests"], ["questitems", "Quest items"], ["landmarks", "Places"], ["hud", "Distance text", "control"], ["squad", "Squad"], ["keys", "Keys"], ["bosses", "Bosses"], ["scavs", "Scav spawns"], ["pmc", "PMC spawns"], ["hazards", "Hazards"], ["containers", "Containers"], ["loot", "Loot"], ["guns", "MGs"], ["switches", "Switches"]];
  TM.DEFAULT_LAYERS = ["extracts", "quests", "landmarks", "hud", "squad", "bosses"];
  TM.layersOn = (settings, mapKey) => new Set((settings && settings.layers && settings.layers[mapKey]) || TM.DEFAULT_LAYERS);
  /** What the in-game minimap draws: the map's layers minus the ones eye-toggled off for in-game. */
  TM.overlayLayersOn = (settings, mapKey) => { const s = TM.layersOn(settings, mapKey); for (const h of (settings && settings.hiddenInGame) || []) s.delete(h); return s; };
  /** One wording for the state of the marker/quest data, used by every surface. */
  TM.dataNotice = function (d) {
    d = d || {};
    const missing = d.features === "missing" || d.tasks === "missing";
    const offline = d.features === "offline" || d.tasks === "offline";
    const err = d.lastError ? ` (${d.lastError})` : "";
    if (missing) return { level: "missing", text: `Marker and quest data are not downloaded yet${err} — trying json.tarkov.dev every 15 min.` };
    if (offline) return { level: "offline", text: `Running on the game's own data (offline): spawns, bosses, extract and quest names only. Extract pins, keys, containers, loot and quest items arrive when json.tarkov.dev answers${err}; retrying every 15 min.` };
    return { level: null, text: "" };
  };
  /** Loot-value tiers, cold → hot. Fill only; the map stays readable underneath. */
  TM.HEAT_COLORS = ["#8a8f98", "#4caf50", "#f2c230", "#f28c28", "#e04848"];
  /** Square cells of expected loot value (see src/loot-value.ts) as one layer group. */
  TM.lootHeatLayer = function (heat, opts) {
    const g = L.layerGroup();
    if (!heat || !heat.cells) return g;
    const half = heat.cell / 2;
    const fmt = (v) => (v >= 1000 ? Math.round(v / 1000) + "k" : String(v));
    for (const c of heat.cells) {
      const b = L.latLngBounds(TM.pos(c.x - half, c.z - half), TM.pos(c.x + half, c.z + half));
      const r = L.rectangle(b, { stroke: false, fillColor: TM.HEAT_COLORS[c.tier - 1] || TM.HEAT_COLORS[0], fillOpacity: c.tier >= 4 ? 0.5 : 0.38, interactive: Boolean(opts && opts.interactive) });
      if (opts && opts.interactive) r.bindTooltip(`~${fmt(c.value)} ₽ possible · ${c.top.join(", ")}`, { direction: "top", sticky: true, opacity: 0.95 });
      g.addLayer(r);
    }
    return g;
  };
  /** How much of the ground shows through under a floor plan. */
  TM.GHOST_OPACITY = 0.22;
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

  /**
   * CRS for a RE3MR render registered with an affine (game x,z → image px).
   * The rotation/shear goes into the projection, the translation into the
   * transformation, so latLng stays [z, x] like every other layer here.
   */
  TM.crsAffine = function (a, maxZoom, homography) {
    const s = 1 / 2 ** maxZoom; // image px at zoom `maxZoom` == 1 map pixel at zoom 0 scaled by 2^z
    if (homography && homography.length === 9) {
      // Projective registration: projection does the whole game→px map, transformation only scales.
      const h = homography;
      const [A, B, C, D, E, F, G, Hh, I] = h;
      const det = A * (E * I - F * Hh) - B * (D * I - F * G) + C * (D * Hh - E * G);
      const inv = [E * I - F * Hh, -(B * I - C * Hh), B * F - C * E, -(D * I - F * G), A * I - C * G, -(A * F - C * D), D * Hh - E * G, -(A * Hh - B * G), A * E - B * D].map((v) => v / det);
      return L.extend({}, L.CRS.Simple, {
        transformation: new L.Transformation(s, 0, s, 0),
        projection: L.extend({}, L.Projection.LonLat, {
          project: (ll) => { const x = ll.lng, z = ll.lat; const w = G * x + Hh * z + I; return L.point((A * x + B * z + C) / w, (D * x + E * z + F) / w); },
          unproject: (p) => { const w = inv[6] * p.x + inv[7] * p.y + inv[8]; return L.latLng((inv[3] * p.x + inv[4] * p.y + inv[5]) / w, (inv[0] * p.x + inv[1] * p.y + inv[2]) / w); },
        }),
      });
    }
    return L.extend({}, L.CRS.Simple, {
      transformation: new L.Transformation(s, a.cx * s, s, a.cy * s),
      projection: L.extend({}, L.Projection.LonLat, {
        project: (ll) => {
          const x = ll.lng, z = ll.lat;
          return L.point(a.ax * x + a.bx * z, a.ay * x + a.by * z);
        },
        unproject: (p) => {
          const det = a.ax * a.by - a.bx * a.ay;
          return L.latLng((-a.ay * p.x + a.ax * p.y) / det, (a.by * p.x - a.bx * p.y) / det);
        },
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
    // maxNativeZoom keeps Leaflet from requesting tiles past the pyramid
    // (tarkov.dev stops at the map's maxZoom): it upsamples instead of going black.
    const layer = L.tileLayer(local || remote, Object.assign({ tileSize: 256, keepBuffer: 4, updateWhenIdle: false, updateWhenZooming: false, crossOrigin: false }, opts));
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

  /** Floor group ids for maps whose maps.json layers carry no svgLayer (Labs vector from TarkovTracker; traced decks). */
  const FLOOR_ID_OVERRIDES = { "the-lab": { "Second Level": "Second_Level", "Technical": "Technical_Level" } };
  TM.floorGroupId = function (def, floorName) {
    if (!floorName) return null;
    const o = FLOOR_ID_OVERRIDES[def.key];
    if (o && o[floorName]) return o[floorName];
    const l = (def.layers || []).find((x) => x.name === floorName);
    return (l && l.svgLayer) || floorName;
  };

  /** Height band [lo, hi] of a floor (from maps.json extents); ground = below the lowest floor band. */
  TM.floorBand = function (def, floorName) {
    const layers = def.layers || [];
    if (!floorName) {
      let lo = -Infinity, hi = Infinity;
      for (const l of layers) for (const e of l.extents || []) if (e.height[0] > 0 && e.height[0] < hi) hi = e.height[0];
      for (const l of layers) for (const e of l.extents || []) if (e.height[1] < 0 && e.height[1] > lo) lo = e.height[1];
      return [lo, hi];
    }
    const l = layers.find((x) => x.name === floorName);
    if (!l || !l.extents || !l.extents.length) return [-Infinity, Infinity];
    return [Math.min(...l.extents.map((e) => e.height[0])), Math.max(...l.extents.map((e) => e.height[1]))];
  };

  /** Labels that belong on a floor: their [bottom, top] band overlaps the floor's band (labels without heights sit on the ground). */
  TM.labelsForFloor = function (def, floorName) {
    const labels = def.labels || [];
    const [lo, hi] = TM.floorBand(def, floorName);
    return labels.filter((l) => {
      if (l.bottom == null || l.top == null) return !floorName;
      const b = Math.min(l.bottom, l.top), t = Math.max(l.bottom, l.top);
      return t > lo && b < hi;
    });
  };

  /**
   * Build a map into `el` for a map payload {def, svg, localTemplates, re3mr}.
   * options: { base: "re3mr"|"vector", style: "studio"|"night", extrudeDepth, ...leaflet options }
   * Returns {map, setFloor(name|null), floors[], bounds, def, base, credit}.
   * The vector base draws the styled SVG; photo tiles only when a map has no vector at all.
   * A floor is EXCLUSIVE: setFloor(name) swaps the whole styled SVG for that floor's plan (cached per floor).
   */
  TM.buildMap = function (el, payload, options) {
    options = options || {};
    const def = payload.def;
    const useRe3mr = Boolean(payload.re3mr && options.base === "re3mr");
    const style = options.style === "night" ? "night" : "studio";
    const crs = useRe3mr ? TM.crsAffine(payload.re3mr.affine, payload.re3mr.maxZoom, payload.re3mr.homography) : TM.crsFor(def);
    const bounds = TM.boundsFor(def);
    const nativeMax = useRe3mr ? payload.re3mr.maxZoom : def.maxZoom || 6;
    const leafletOpts = Object.assign({
      crs, zoomControl: false, attributionControl: false, minZoom: useRe3mr ? 0 : Math.max(1, (def.minZoom || 2) - 1), maxZoom: nativeMax + 2,
      zoomSnap: 0.25, zoomDelta: 0.5, inertia: true, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false, doubleClickZoom: false,
    }, options);
    delete leafletOpts.base; delete leafletOpts.style; delete leafletOpts.extrudeDepth;
    const map = L.map(el, leafletOpts);
    const floors = (def.layers || []).map((l) => l.name);
    const floorIds = payload.svgTraced ? floors : null; // traced maps name their deck groups after the layer
    const tileSize = def.tileSize || 256;
    const hasVector = Boolean(payload.svg && window.TMStyle);
    const depth = options.extrudeDepth == null ? undefined : options.extrudeDepth;
    let current = null, credit = null;
    const styledCache = new Map(); // floor name|"" → styled svg element
    // Which floors the vector actually draws. Reserve's and Customs' upper floors exist only as
    // tarkov.dev tile plans (no SVG group), so "exclusive" for them means the tile plan alone —
    // hiding the ground and drawing nothing is the one outcome that is never right.
    const groupIds = hasVector ? window.TMStyle.groupIds(payload.svg).map((g) => g.toLowerCase()) : [];
    const planExists = (floorName) => { const id = TM.floorGroupId(def, floorName); return Boolean(id) && groupIds.includes(id.toLowerCase()); };
    const tileFloorFor = (floorName) => { const l = (def.layers || []).find((x) => x.name === floorName); return l && l.tilePath ? l : null; };
    const styled = (floorName) => {
      const k = floorName || "";
      if (!styledCache.has(k)) styledCache.set(k, window.TMStyle.style(payload.svg, style, { depth, floor: TM.floorGroupId(def, floorName), floorIds }));
      return styledCache.get(k);
    };

    if (useRe3mr) {
      const R = payload.re3mr;
      credit = R.credit;
      const base = L.tileLayer(R.template, { tileSize: 256, maxNativeZoom: R.maxZoom, minNativeZoom: 0, className: "tm-base", keepBuffer: 4, updateWhenZooming: false, noWrap: true }).addTo(map);
      let floorOverlay = null;
      const setFloor = (name) => {
        if (name === current) return;
        current = name;
        if (floorOverlay) { map.removeLayer(floorOverlay); floorOverlay = null; }
        // on a floor the render is hidden: only that floor's plan shows (exclusive, like the vector base)
        const plan = name && hasVector && planExists(name) ? "vector" : name && tileFloorFor(name) ? "tile" : null;
        // on a floor the render stays underneath, faint — enough to see where the floor sits, not enough to compete
        if (base.getContainer()) base.getContainer().style.opacity = plan ? String(TM.GHOST_OPACITY) : "";
        if (plan === "vector") floorOverlay = L.svgOverlay(styled(name), bounds, { className: "tm-style", interactive: false }).addTo(map);
        else if (plan === "tile") { const l = tileFloorFor(name); floorOverlay = TM.tileLayer(l.tilePath, payload.localTemplates[l.tilePath], { tileSize, bounds, className: "tm-floor tm-f-" + style, maxNativeZoom: def.maxZoom || 6 }).addTo(map); }
      };
      return { map, setFloor, floors, bounds, def, base: "re3mr", credit };
    }

    // ── vector base (Light / Dark) — photo tiles only when there is no vector at all ────
    let tileBase = null, floorTile = null, overlay = null, ghost = null;
    if (!hasVector && def.tilePath) {
      tileBase = TM.tileLayer(def.tilePath, payload.localTemplates[def.tilePath], { tileSize, bounds, className: "tm-base tm-f-" + style, maxNativeZoom: nativeMax }).addTo(map);
    }
    const setFloor = (name) => {
      if (name === current && (overlay || tileBase)) return;
      current = name;
      if (overlay) { map.removeLayer(overlay); overlay = null; }
      if (floorTile) { map.removeLayer(floorTile); floorTile = null; }
      if (ghost) { map.removeLayer(ghost); ghost = null; }
      // A floor = the ground faint underneath (his ask: "add the map back, pretty low opacity, so I can
      // see which floor I'm on") + ONLY that floor's plan on top. Every other floor stays hidden.
      if (hasVector && name && !planExists(name)) {
        const l = tileFloorFor(name);
        ghost = L.svgOverlay(styled(null), bounds, { className: "tm-style" + (l ? " tm-ghost" : ""), interactive: false }).addTo(map); // no plan anywhere: the ground, full strength, beats a blank
        if (l) floorTile = TM.tileLayer(l.tilePath, payload.localTemplates[l.tilePath], { tileSize, bounds, className: "tm-floor tm-f-" + style, maxNativeZoom: nativeMax }).addTo(map);
      } else if (hasVector) {
        if (name) ghost = L.svgOverlay(styled(null), bounds, { className: "tm-style tm-ghost", interactive: false }).addTo(map);
        overlay = L.svgOverlay(styled(name), bounds, { className: "tm-style", interactive: false }).addTo(map);
      } else if (name) {
        const l = (def.layers || []).find((x) => x.name === name);
        if (l && l.tilePath) { floorTile = TM.tileLayer(l.tilePath, payload.localTemplates[l.tilePath], { tileSize, bounds, className: "tm-floor tm-f-" + style, maxNativeZoom: nativeMax }).addTo(map); if (tileBase) tileBase.getContainer().style.opacity = String(TM.GHOST_OPACITY); }
      } else if (tileBase) tileBase.getContainer().style.opacity = "";
    };
    setFloor(null);
    return { map, setFloor, floors, bounds, def, base: "vector", credit };
  };

  // ── marker factories ────────────────────────────────────────────────────
  const icon = (html, size, anchor, cls) => L.divIcon({ className: cls || "tm-ico", html, iconSize: size, iconAnchor: anchor });
  TM.icon = icon;

  TM.pin = (color, label, sub) => icon(`<div class="tm-pin" style="background:${color}"><i></i></div>${label ? `<div class="tm-lbl">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>` : ""}`, [14, 14], [7, 14]);
  TM.dot = (color, label) => icon(`<div class="tm-dot" style="background:${color}"></div>${label ? `<div class="tm-lbl tm-lbl-dot">${esc(label)}</div>` : ""}`, [9, 9], [4, 4]);
  TM.place = (text, size) => icon(`<div class="tm-place" style="font-size:${size ? Math.max(11, Math.round(size / 8)) : 11}px">${esc(text)}</div>`, [0, 0], [0, 0]);
  TM.me = () => icon('<div class="tm-cone"></div><div class="tm-me"></div>', [0, 0], [0, 0]);
  TM.mate = (name, sub, color) => icon(`<div class="tm-mate" style="border-bottom-color:${color || TM.COLORS.squad}"></div><div class="tm-lbl" style="color:${color || TM.COLORS.squad}">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`, [0, 0], [0, 0]);
  TM.ping = (text, who) => icon(`<div class="tm-ping"></div><div class="tm-lbl" style="color:${TM.COLORS.ping}">${esc(text)}${who ? `<small>${esc(who)}</small>` : ""}</div>`, [0, 0], [0, 0]);
  TM.portrait = (url, label, sub, status) => icon(`<img class="tm-av${status ? " tm-av-" + status : ""}" src="${url}" onerror="this.style.display='none'"><div class="tm-lbl">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`, [26, 26], [13, 13]);
  /** A quest item: the item's own icon with an importance badge; tone "quest" = a quest-specific world item, "item" = an ordinary needed item. */
  TM.itemIcon = (iconUrl, label, importance, tone, done) => icon(`<div class="tm-item tm-item-${tone || "item"}${done ? " tm-item-done" : ""}">${iconUrl ? `<img src="${iconUrl}" onerror="this.style.display='none'">` : ""}<i class="tm-imp">${Math.round(importance || 0)}</i></div>${label ? `<div class="tm-lbl tm-lbl-item">${esc(label)}</div>` : ""}`, [24, 24], [12, 12]);

  const STATE_WORD = { active: "accepted", available: "not started", locked: "needs earlier quests", done: "done", failed: "failed" };
  /** The popup for a quest objective (MapObjectiveEx) or a quest-item marker (QuestItemMarker). Strings are escaped; buttons carry data-act. */
  TM.questPopupHtml = function (entry, ctx) {
    ctx = ctx || {};
    const objDone = ctx.objectiveDone || {};
    const questLine = (q) => {
      const st = q.status || "available";
      const objs = (ctx.objectivesOf ? ctx.objectivesOf(q.questId) : []) || [];
      const objHtml = objs.length ? `<div class="objs">${objs.map((o) => `<div class="obj${objDone[o.objectiveId] ? " done" : ""}${o.optional ? " opt" : ""}"><span class="tick" data-act="obj" data-id="${esc(o.objectiveId)}" data-done="${objDone[o.objectiveId] ? "1" : "0"}">${objDone[o.objectiveId] ? "☑" : "☐"}</span><span>${esc(o.description)}${o.count > 1 ? ` ×${o.count}` : ""}${o.foundInRaid ? " · FIR" : ""}${o.optional ? " · optional" : ""}</span></div>`).join("")}</div>` : "";
      const lvl = q.minPlayerLevel ? `<span class="pill lvl">level ${q.minPlayerLevel}+</span>` : "";
      return `<div class="qh"><img src="${esc(q.trader.portrait)}" onerror="this.style.display='none'"><div><b>${esc(q.questName)}</b><span class="d">${esc(q.trader.name)}</span></div></div>
        <div class="pills"><span class="pill ${esc(st)}">${STATE_WORD[st] || st}</span>${lvl}${q.kappaRequired ? `<span class="pill kappa">Kappa</span>` : ""}</div>
        ${objHtml}
        <div class="acts"><button data-act="quest" data-id="${esc(q.questId)}" data-done="${st === "done" ? "1" : "0"}">${st === "done" ? "Undo done" : "Mark quest done"}</button>${q.wikiLink ? `<button data-act="wiki" data-url="${esc(q.wikiLink)}">Wiki</button>` : ""}</div>`;
    };
    if (entry.kind === "item" || entry.kind === "questItem") {
      const items = entry.items || [];
      const byQuest = (qs) => { const seen = new Set(); return (qs || []).filter((q) => !seen.has(q.questId) && seen.add(q.questId)); };
      return `<div class="tm-pop-body">${items.map((it) => `<div class="it"><img src="${esc(it.icon || "")}" onerror="this.style.display='none'"><div><b>${esc(it.name)}</b><span class="d">${it.count > 1 ? `×${it.count} · ` : ""}${it.fir ? "found in raid" : "any"}${it.price ? ` · ${it.price >= 1000 ? Math.round(it.price / 1000) + "k" : it.price} ₽` : ""}${entry.kind === "item" ? ` · ${it.spawnPointsOnMap} spot${it.spawnPointsOnMap === 1 ? "" : "s"} on this map` : " · lies here"}</span></div><i class="tm-imp">${Math.round(it.importance)}</i></div>${byQuest(it.quests).map(questLine).join("")}`).join("<hr>")}
        <div class="note">${entry.kind === "item" ? "A spawn spot, not what spawned. " : ""}Started / finished come from the game's notifications; your level isn't in the logs.</div></div>`;
    }
    // a quest objective marker
    const q = { questId: entry.questId, questName: entry.questName, trader: entry.trader, status: entry.status, minPlayerLevel: entry.minPlayerLevel, wikiLink: entry.wikiLink, kappaRequired: entry.kappaRequired };
    return `<div class="tm-pop-body"><div class="here"><span class="tick" data-act="obj" data-id="${esc(entry.objectiveId)}" data-done="${objDone[entry.objectiveId] ? "1" : "0"}">${objDone[entry.objectiveId] ? "☑" : "☐"}</span> ${esc(entry.description)}${entry.item ? ` — ${esc(entry.item.name)}${entry.item.count > 1 ? " ×" + entry.item.count : ""}` : ""}</div>${questLine(q)}<div class="note">Visit and extract objectives tick themselves from your position; item counts aren't in the logs — tick those by hand.</div></div>`;
  };
  /** Sticky tooltip + lazy popup on a marker; data-act buttons inside the popup call the handlers. */
  TM.bindQuestPopup = function (marker, short, entryFn, ctxFn, handlers) {
    if (short) marker.bindTooltip(short, { direction: "top", sticky: true, opacity: 0.95, className: "tm-tip" });
    marker.bindPopup(() => TM.questPopupHtml(entryFn(), ctxFn ? ctxFn() : {}), { className: "tm-pop", maxWidth: 360, minWidth: 260, autoPan: true, closeButton: true });
    marker.on("popupopen", (e) => {
      const el = e.popup.getElement();
      if (!el) return;
      el.querySelectorAll("[data-act]").forEach((b) => {
        b.onclick = (ev) => {
          ev.stopPropagation();
          const act = b.dataset.act;
          if (act === "obj" && handlers.obj) handlers.obj(b.dataset.id, b.dataset.done !== "1");
          else if (act === "quest" && handlers.quest) handlers.quest(b.dataset.id, b.dataset.done !== "1");
          else if (act === "wiki" && handlers.wiki) handlers.wiki(b.dataset.url);
          if (act !== "wiki") setTimeout(() => { if (marker.isPopupOpen()) marker.getPopup().setContent(TM.questPopupHtml(entryFn(), ctxFn ? ctxFn() : {})); }, 250);
        };
      });
    });
    return marker;
  };


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
