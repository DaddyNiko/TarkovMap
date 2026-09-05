/* Overlay renderer. Two modes from the query string:
 *   (default) — the HUD window: heading-up minimap + side panel.
 *   ?mode=tags — a full-display transparent window that only draws
 *                teammate / ping tags projected into the game view. */
(function () {
  const $ = (id) => document.getElementById(id);
  const MODE = new URLSearchParams(location.search).get("mode") === "tags" ? "tags" : "hud";
  let snap = null, mapPayload = null;
  let built = null; // {map, setFloor, key, base}
  let markers = L.layerGroup();
  let squadLayer = L.layerGroup();
  let meMarker = null;
  let trailLine = null;
  let lastFixAt = 0;
  let lastLayersKey = "";

  const RAID_MIN = TM.RAID_MINUTES;
  const defaultLayers = ["extracts", "quests", "landmarks", "hud", "squad", "bosses"];
  const onLayers = () => new Set((snap && mapPayload && snap.settings.layers[mapPayload.def.key]) || defaultLayers);

  // ── HUD layout (window is already sized to the region by main) ─────────
  function layout() {
    if (!snap) return;
    const s = snap.settings;
    const ui = $("ui");
    ui.style.transform = `scale(${s.overlayScale})`;
    ui.style.width = `${100 / s.overlayScale}%`;
    ui.style.height = `${100 / s.overlayScale}%`;
    const mm = $("mmwrap");
    const size = s.minimapSize;
    mm.style.width = mm.style.height = `${size}px`;
    mm.style.opacity = s.mapOpacity;
    const m = s.margin;
    const corner = s.corner;
    mm.style.left = mm.style.right = mm.style.top = mm.style.bottom = "";
    if (corner.endsWith("left")) mm.style.left = `${m}px`; else mm.style.right = `${m}px`;
    if (corner.startsWith("top")) mm.style.top = `${m}px`; else mm.style.bottom = `${m}px`;
    $("mm").classList.toggle("round", s.roundMask);
    const side = $("side");
    side.style.opacity = s.panelOpacity;
    side.style.left = side.style.right = side.style.top = side.style.bottom = "";
    if (corner.endsWith("left")) { side.style.left = `${m + size + 20}px`; side.classList.remove("right"); }
    else { side.style.right = `${m + size + 20}px`; side.classList.add("right"); }
    if (corner.startsWith("top")) side.style.top = `${m + 2}px`; else side.style.bottom = `${m + 2}px`;
    side.style.display = s.showHudText || s.showQuests ? "" : "none";
    for (const id of ["ring1", "ring2", "ringl1", "ringl2"]) $(id).style.display = s.rangeRings ? "" : "none";
    $("credit").style.display = built && built.base === "re3mr" ? "" : "none";
    if (built) setTimeout(() => built.map.invalidateSize(), 50);
  }

  function baseChoice() {
    const s = snap.settings;
    if (s.mapBase === "re3mr" && mapPayload && mapPayload.re3mr) return "re3mr";
    return "vector";
  }

  function ensureMap() {
    const key = mapPayload ? mapPayload.def.key : null;
    const base = key ? baseChoice() : null;
    const style = snap.settings.mapStyle;
    const sig = key ? `${key}|${base}|${style}|${snap.settings.extrudeDepth}` : null;
    if (!key) { $("status").classList.add("show"); return; }
    if (built && built.sig === sig) return;
    if (built) { built.map.remove(); built = null; }
    $("map").innerHTML = "";
    const b = TM.buildMap($("map"), mapPayload, { dragging: false, scrollWheelZoom: false, keyboard: false, touchZoom: false, boxZoom: false, zoomAnimation: false, base, style, extrudeDepth: snap.settings.extrudeDepth });
    built = { map: b.map, setFloor: b.setFloor, key, base, sig };
    markers = L.layerGroup().addTo(b.map);
    squadLayer = L.layerGroup().addTo(b.map);
    meMarker = L.marker(TM.pos(0, 0), { icon: TM.me(), interactive: false, zIndexOffset: 1000 }).addTo(b.map);
    trailLine = L.polyline([], { className: "tm-trail", interactive: false, renderer: L.canvas() }).addTo(b.map);
    b.map.setView(b.bounds.getCenter(), followZoom());
    b.map.on("zoomend", updateRings);
    lastLayersKey = "";
    lastFixAt = 0;
    paintMarkers();
    updateRings();
    $("credit").textContent = b.credit || "";
    $("status").classList.remove("show");
    layout();
  }

  /** RE3MR pyramids are denser than tarkov.dev's; keep the same metres-per-pixel. */
  function followZoom() {
    const z = snap.settings.followZoom;
    if (!built || built.base !== "re3mr" || !mapPayload.re3mr) return z;
    const T = mapPayload.def.transform || [1, 0, 1, 0];
    const tdPxPerM = T[0] * 2 ** z; // tarkov.dev px/m at zoom z
    const rPxPerM = Math.sqrt(Math.abs(mapPayload.re3mr.affine.ax * mapPayload.re3mr.affine.by - mapPayload.re3mr.affine.bx * mapPayload.re3mr.affine.ay));
    return Math.log2(tdPxPerM / rPxPerM) + mapPayload.re3mr.maxZoom;
  }

  function paintMarkers() {
    if (!built || !snap || !mapPayload) return;
    const key = JSON.stringify([[...onLayers()], snap.objectives.map((o) => o.objectiveId), snap.game.side, Boolean(mapPayload.features), snap.settings.showLabels, snap.settings.showQuests, snap.floor]);
    if (key === lastLayersKey) return;
    lastLayersKey = key;
    markers.clearLayers();
    const s = snap.settings;
    const def = mapPayload.def;
    const f = mapPayload.features;
    const on = onLayers();
    if (s.showLabels && on.has("landmarks")) for (const l of TM.labelsForFloor(def, snap.floor)) markers.addLayer(L.marker(TM.pos(l.position[0], l.position[1]), { icon: TM.place(l.text, l.size), interactive: false }));
    if (on.has("extracts")) for (const e of TM.extractsFor(f, snap.game.side)) {
      if (!e.position) continue;
      const color = e.faction === "transit" ? TM.COLORS.transit : e.faction === "scav" ? TM.COLORS.scavExtract : TM.COLORS.extract;
      markers.addLayer(L.marker(TM.pos(e.position.x, e.position.z), { icon: TM.pin(color, e.name), interactive: false }));
    }
    if (s.showQuests && on.has("quests")) for (const o of snap.objectives) {
      if (!o.position) continue;
      markers.addLayer(L.marker(TM.pos(o.position.x, o.position.z), { icon: TM.portrait(o.trader.portrait, o.questName), interactive: false, zIndexOffset: 500 }));
      if (o.outline && o.outline.length >= 3) markers.addLayer(L.polygon(o.outline.map((p) => TM.pos(p.x, p.z)), { className: "tm-outline", interactive: false }));
    }
    if (f) {
      if (on.has("keys")) for (const k of f.locks || []) if (k.position) markers.addLayer(L.marker(TM.pos(k.position.x, k.position.z), { icon: TM.dot(TM.COLORS.key, k.key ? k.key.name.replace(/ key$/i, "") : ""), interactive: false }));
      if (on.has("bosses") || on.has("scavs")) for (const sp of f.spawns || []) {
        const cats = (sp.categories || []).map((c) => String(c).toLowerCase());
        const isBoss = cats.some((c) => /boss|rogue|cultist|raider/.test(c));
        const isScav = cats.includes("scav") || cats.includes("all") || cats.includes("sniper");
        if (isBoss && on.has("bosses")) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.pin(TM.COLORS.boss, sp.zoneName || ""), interactive: false }));
        else if (isScav && !isBoss && on.has("scavs")) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.dot(cats.includes("sniper") ? TM.COLORS.hazard : TM.COLORS.scav, ""), interactive: false }));
      }
      if (on.has("pmc")) for (const sp of f.pmcSpawns || []) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.dot(TM.COLORS.squad, ""), interactive: false }));
      if (on.has("hazards")) for (const h of f.hazards || []) if (h.position) markers.addLayer(L.marker(TM.pos(h.position.x, h.position.z), { icon: TM.dot(TM.COLORS.hazard, h.name), interactive: false }));
      if (on.has("containers") || on.has("loot")) for (const c of f.lootContainers || []) if (c.position) markers.addLayer(L.marker(TM.pos(c.position.x, c.position.z), { icon: TM.dot(TM.COLORS.loot, ""), interactive: false }));
      if (on.has("guns")) for (const g of f.stationaryWeapons || []) if (g.position) markers.addLayer(L.marker(TM.pos(g.position.x, g.position.z), { icon: TM.dot(TM.COLORS.gun, g.stationaryWeapon ? g.stationaryWeapon.name : "MG"), interactive: false }));
      if (on.has("switches")) for (const sw of f.switches || []) if (sw.position) markers.addLayer(L.marker(TM.pos(sw.position.x, sw.position.z), { icon: TM.dot(TM.COLORS.switch, sw.name), interactive: false }));
    }
  }

  function paintSquad() {
    if (!built || !snap) return;
    squadLayer.clearLayers();
    if (!onLayers().has("squad")) return;
    for (const m of Object.values(snap.squad.mates)) {
      const sub = snap.fix ? TM.fmtM(TM.dist(snap.fix, m)) + (m.floor ? " · " + m.floor : "") : m.floor || "";
      const mk = L.marker(TM.pos(m.x, m.z), { icon: TM.mate(m.name, sub), interactive: false, zIndexOffset: 800 });
      squadLayer.addLayer(mk);
      requestAnimationFrame(() => { const el = mk.getElement(); if (el) el.style.setProperty("--rot", `${m.yaw - currentRotation()}deg`); });
    }
    for (const p of snap.squad.pings) squadLayer.addLayer(L.marker(TM.pos(p.x, p.z), { icon: TM.ping(p.text, p.name), interactive: false, zIndexOffset: 900 }));
  }

  function currentRotation() {
    return snap && snap.settings.headingUp && snap.fix ? snap.fix.yaw : 0;
  }

  function applyRotation() {
    const r = currentRotation();
    $("rot").style.transform = `rotate(${-r}deg)`;
    document.documentElement.style.setProperty("--unrot", `${r}deg`);
    document.documentElement.style.setProperty("--me-rot", `${snap && snap.fix ? snap.fix.yaw - r : 0}deg`);
    $("north").style.transform = `rotate(${-r}deg)`;
  }

  function updateRings() {
    if (!built || !snap) return;
    const c = built.map.getCenter();
    const p0 = built.map.latLngToContainerPoint(c);
    const p1 = built.map.latLngToContainerPoint(TM.pos(c.lng + 100, c.lat));
    const pxPer100 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const px50 = pxPer100 / 2;
    $("ring1").style.width = $("ring1").style.height = `${px50 * 2}px`;
    $("ring2").style.width = $("ring2").style.height = `${pxPer100 * 2}px`;
    const half = $("mmwrap").clientWidth / 2;
    $("ringl1").style.top = `${half - px50 - 12}px`;
    $("ringl2").style.top = `${half - pxPer100 - 12}px`;
  }

  function follow() {
    if (!built || !snap || !snap.fix) return;
    const ll = TM.pos(snap.fix.x, snap.fix.z);
    meMarker.setLatLng(ll);
    const now = Date.now();
    const dur = Math.min(2, Math.max(0.3, (snap.settings.intervalMs || 2000) / 1000));
    if (now - lastFixAt < 15000 && Math.abs(built.map.getZoom() - followZoom()) < 0.01) built.map.panTo(ll, { animate: true, duration: dur, easeLinearity: 1, noMoveStart: true });
    else built.map.setView(ll, followZoom(), { animate: false });
    lastFixAt = now;
    trailLine.setLatLngs(snap.settings.showTrail ? snap.trail.map((t) => TM.pos(t.x, t.z)) : []);
    built.setFloor(snap.floor);
    $("floor").textContent = snap.floor ? shortFloor(snap.floor) : "G";
  }

  function shortFloor(n) {
    const m = /^(\d)/.exec(n);
    if (m) return m[1] + "F";
    if (/under|tunnel|basement|bunker|garage/i.test(n)) return "U";
    return n.slice(0, 3).toUpperCase();
  }

  function paintPanel() {
    if (!snap) return;
    const s = snap.settings;
    const fix = snap.fix;
    const yaw = fix ? fix.yaw : 0;
    const qEl = $("quests"), tEl = $("targets");
    qEl.innerHTML = "";
    tEl.innerHTML = "";
    if (s.showQuests && mapPayload) {
      const byQuest = new Map();
      for (const o of snap.objectives) { const e = byQuest.get(o.questId) || { name: o.questName, trader: o.trader, objs: [] }; e.objs.push(o); byQuest.set(o.questId, e); }
      if (byQuest.size) {
        qEl.innerHTML = `<div class="h4">Quests here</div>`;
        for (const [id, q] of byQuest) {
          const nearest = q.objs.filter((o) => o.position && fix).map((o) => TM.dist(fix, o.position)).sort((a, b) => a - b)[0];
          const el = document.createElement("div");
          el.className = "q";
          el.innerHTML = `<img src="${q.trader.portrait}"><div><b>${TM.esc(q.name)}</b><span class="d">${TM.esc(q.trader.name)} · ${TM.esc((q.objs[0].description || "").slice(0, 60))}</span></div>${nearest != null ? `<span class="m">${Math.round(nearest)}<em>m</em></span>` : ""}`;
          el.title = id;
          qEl.appendChild(el);
        }
      } else if (snap.data && snap.data.tasks === "missing") {
        qEl.innerHTML = `<div class="h4">Quests here</div><div class="row"><span class="d">quest data not downloaded yet (tarkov.dev down)</span></div>`;
      }
    }
    if (s.showHudText && mapPayload) {
      const rows = [];
      if (fix) {
        for (const e of TM.extractsFor(mapPayload.features, snap.game.side)) if (e.position) rows.push({ color: e.faction === "transit" ? TM.COLORS.transit : TM.COLORS.extract, name: e.name, sub: e.faction === "transit" ? "transit" : "", d: TM.dist(fix, e.position), b: TM.bearing(fix, e.position) });
        for (const m of Object.values(snap.squad.mates)) rows.push({ color: TM.COLORS.squad, name: m.name, sub: (m.moving ? "moving" : "still") + (m.floor ? " · " + m.floor : "") + (m.flag ? " · " + m.flag : ""), d: TM.dist(fix, m), b: TM.bearing(fix, m) });
        for (const p of snap.squad.pings) rows.push({ color: TM.COLORS.ping, name: `${p.name}: ${p.text}`, sub: "", d: TM.dist(fix, p), b: TM.bearing(fix, p) });
      }
      rows.sort((a, b) => a.d - b.d);
      const html = rows.slice(0, 6).map((r) => `<div class="row"><span class="g" style="background:${r.color}"></span><span class="b">${TM.glyph(r.b - yaw)}</span><span class="m">${Math.round(r.d)}<em>m</em></span><span>${TM.esc(r.name)}</span>${r.sub ? `<span class="d">${TM.esc(r.sub)}</span>` : ""}</div>`).join("");
      tEl.innerHTML = rows.length ? `<div class="h4">Extracts · squad</div>${html}` : fix && snap.data && snap.data.features === "missing" ? `<div class="h4">Extracts</div><div class="row"><span class="d">extract data not downloaded yet</span></div>` : "";
    }
    const g = snap.game;
    const mapName = mapPayload ? mapPayload.def.name : "No map";
    const side = g.side === "scav" ? "Scav" : "PMC";
    let timer = "";
    if (g.raid === "in-raid" && g.raidStartedAt && mapPayload) {
      const total = (RAID_MIN[mapPayload.def.key] || 40) * 60000;
      const left = Math.max(0, total - (Date.now() - g.raidStartedAt));
      timer = `<b>${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}</b>`;
    }
    const feedAge = fix ? Math.round((Date.now() - fix.at) / 1000) : null;
    const feedTxt = feedAge == null ? "no fix yet" : feedAge < 5 ? "live" : `${feedAge}s ago`;
    $("raidline").innerHTML = `${TM.esc(mapName)} · ${side} ${timer} ${g.raid === "in-raid" ? "" : "· " + g.raid} · <span style="color:${feedAge != null && feedAge < 6 ? "#78e68c" : "rgba(255,255,255,.55)"}">${feedTxt}</span>`;
  }

  // ── tags window ─────────────────────────────────────────────────────────
  function paintTags() {
    const el = $("tags");
    el.innerHTML = "";
    if (!snap || !snap.settings.showTags || !snap.fix || !snap.fix.q || snap.game.raid !== "in-raid") return;
    const W = window.innerWidth, H = window.innerHeight;
    const fov = snap.settings.gameFov;
    const items = [];
    for (const m of Object.values(snap.squad.mates)) items.push({ cls: "mate", name: m.name, pos: { x: m.x, y: m.y + 1.6, z: m.z } });
    for (const p of snap.squad.pings) items.push({ cls: "ping", name: `◆ ${p.name}: ${p.text}`, pos: { x: p.x, y: p.y + 1.2, z: p.z } });
    for (const it of items) {
      const pr = TM.projectToScreen(snap.fix, fov, W, H, it.pos);
      if (pr.behind) continue;
      const x = Math.max(60, Math.min(W - 60, pr.x));
      const y = Math.max(40, Math.min(H - 40, pr.y));
      const d = document.createElement("div");
      d.className = `wtag ${it.cls}`;
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      d.style.opacity = pr.x !== x || pr.y !== y ? "0.6" : "1";
      d.innerHTML = `${TM.esc(it.name)}<b>${TM.fmtM(pr.dist)}</b><i></i>`;
      el.appendChild(d);
    }
  }

  function onSnapshot(s) {
    const settingsChanged = !snap || JSON.stringify(snap.settings) !== JSON.stringify(s.settings);
    snap = s;
    if (MODE === "tags") { paintTags(); return; }
    if (settingsChanged) layout();
    if (mapPayload && (!built || settingsChanged)) ensureMap();
    if (built) paintMarkers();
    applyRotation();
    follow();
    paintSquad();
    paintPanel();
    if (built) updateRings();
    $("status").classList.toggle("show", !mapPayload);
    if (!mapPayload) $("status").textContent = s.game.raid === "menu" ? "In menu · pick a map in TarkovMap or start a raid" : "Loading…";
  }

  function onMap(p) {
    mapPayload = p;
    if (MODE === "tags") return;
    if (snap) ensureMap();
    if (!p) { if (built) { built.map.remove(); built = null; } $("status").classList.add("show"); }
  }

  if (MODE === "tags") {
    document.body.classList.add("tags-only");
  } else {
    window.api.onOverlayMode((m) => {
      $("interact").classList.toggle("show", m.interactive);
      $("hint").classList.toggle("show", m.interactive);
      $("hint").textContent = "Interactive · F9 to hand the mouse back · F7/F8 map opacity · F10 hide";
      if (built) { built.map.dragging[m.interactive ? "enable" : "disable"](); built.map.scrollWheelZoom[m.interactive ? "enable" : "disable"](); }
    });
    $("bOpen").onclick = () => window.api.openControl();
    $("bBig").onclick = () => window.api.showBigMap(true);
    $("bPing").onclick = () => window.api.ping("regroup");
    $("bDone").onclick = () => window.api.setOverlayInteractive(false);
    window.api.onTick(() => { if (snap) paintPanel(); });
    window.addEventListener("resize", () => layout());
  }
  window.api.onSnapshot(onSnapshot);
  window.api.onMap(onMap);
  window.api.getState().then((s) => { mapPayload = s.map; onSnapshot(s); });
})();
