/* Full map window: all layers, floors, base/style, flea slider, prompt filter, squad.
 * Markers are built once per (map, layers, data) and only their distance
 * labels are updated per fix — rebuilding hundreds of DOM markers every
 * 2 s was the v0.1 lag. */
(function () {
  const $ = (id) => document.getElementById(id);
  const LAYERS = [["extracts", "Extracts"], ["quests", "Quests"], ["landmarks", "Places"], ["squad", "Squad"], ["keys", "Keys"], ["bosses", "Bosses"], ["scavs", "Scav spawns"], ["pmc", "PMC spawns"], ["hazards", "Hazards"], ["containers", "Containers"], ["loot", "Loot"], ["guns", "MGs"], ["switches", "Switches"]];
  const STYLES = [["studio", "Studio"], ["night", "Night"]];
  let snap = null, mapPayload = null, built = null, markers = L.layerGroup(), squadLayer = L.layerGroup(), meMarker = null, trailLine = null, followed = false, manualFloor = null;
  let distLabels = []; // {el, pos}
  let lastMarkersKey = "";
  const defaultLayers = ["extracts", "quests", "landmarks", "hud", "squad"];
  const on = () => new Set((snap && mapPayload && snap.settings.layers[mapPayload.def.key]) || defaultLayers);

  function baseChoice() {
    return snap.settings.mapBase === "re3mr" && mapPayload && mapPayload.re3mr ? "re3mr" : "vector";
  }
  let currentFloor = null; // what the map is showing right now (auto or manual)

  window.addEventListener("resize", () => built && built.map.invalidateSize());
  function ensureMap() {
    const key = mapPayload ? mapPayload.def.key : null;
    $("title").textContent = key ? mapPayload.def.name : "no map yet";
    if (!key) { if (built) { built.map.remove(); built = null; } return; }
    const base = baseChoice();
    const style = snap.settings.mapStyle;
    const sig = `${key}|${base}|${style}|${snap.settings.extrudeDepth}`;
    if (built && built.sig === sig) return;
    let view = null;
    if (built) { view = built.key === key ? { c: built.map.getCenter(), z: built.map.getZoom() } : null; built.map.remove(); built = null; }
    $("map").innerHTML = "";
    const b = TM.buildMap($("map"), mapPayload, { base, style, extrudeDepth: snap.settings.extrudeDepth });
    built = { map: b.map, setFloor: b.setFloor, floors: b.floors, key, base, sig, bounds: b.bounds };
    setTimeout(() => built && built.map.invalidateSize(), 80);
    setTimeout(() => built && built.map.invalidateSize(), 600);
    if (view && base === built.base) b.map.setView(view.c, view.z, { animate: false }); else b.map.fitBounds(b.bounds);
    markers = L.layerGroup().addTo(b.map);
    squadLayer = L.layerGroup().addTo(b.map);
    meMarker = L.marker(TM.pos(0, 0), { icon: TM.me(), interactive: false, zIndexOffset: 1000 });
    trailLine = L.polyline([], { className: "tm-trail", interactive: false, renderer: L.canvas() }).addTo(b.map);
    followed = Boolean(view);
    manualFloor = null;
    currentFloor = null;
    lastMarkersKey = "";
    $("credit").textContent = b.credit || "";
    $("credit").style.display = b.credit ? "" : "none";
    paintMarkers();
    paintFloors();
  }

  function applyFloor() {
    if (!built || !snap) return;
    const want = manualFloor === "__ground" ? null : (manualFloor || snap.floor || null);
    if (want === currentFloor) return;
    currentFloor = want;
    built.setFloor(want);
    lastMarkersKey = ""; // labels are per floor
    paintMarkers();
    paintFloors();
  }
  function paintFloors() {
    const el = $("floors");
    el.innerHTML = "";
    if (!built) return;
    const auto = snap && snap.floor ? snap.floor : "Ground";
    const mk = (name, label) => { const c = document.createElement("span"); c.className = "chip" + ((manualFloor === name) ? " on" : "") + (name === null && !manualFloor ? " on" : ""); c.textContent = label; c.onclick = () => { manualFloor = manualFloor === name ? null : name; applyFloor(); }; el.appendChild(c); };
    mk(null, `auto · ${auto}`);
    if (built.floors.length) mk("__ground", "Ground");
    for (const f of built.floors) mk(f, f);
  }

  function paintControls() {
    if (!snap || !mapPayload) return;
    const set = on();
    const lay = $("layers");
    lay.innerHTML = "";
    for (const [id, label] of LAYERS) {
      const c = document.createElement("span");
      c.className = "chip" + (set.has(id) ? " on" : "");
      c.textContent = label;
      c.onclick = () => { const s = on(); s.has(id) ? s.delete(id) : s.add(id); window.api.setLayers(mapPayload.def.key, [...s]); };
      lay.appendChild(c);
    }
    const st = $("styles");
    st.innerHTML = "";
    const hasR = Boolean(mapPayload.re3mr);
    for (const [id, label] of STYLES) {
      const c = document.createElement("span");
      c.className = "chip" + (snap.settings.mapBase !== "re3mr" || !hasR ? (snap.settings.mapStyle === id ? " on" : "") : "");
      c.textContent = label;
      c.onclick = () => window.api.saveSettings({ mapBase: "vector", mapStyle: id });
      st.appendChild(c);
    }
    if (mapPayload.re3mrAvailable) {
      const r = document.createElement("span");
      const prog = snap.re3mrProgress && snap.re3mrProgress[mapPayload.def.key];
      r.className = "chip" + (snap.settings.mapBase === "re3mr" && hasR ? " on" : "") + (!hasR ? " dim" : "");
      r.textContent = hasR ? "3D" : prog ? "3D · " + prog.stage : "3D · preparing";
      r.title = "RE3MR's 3D render (reemr.se)";
      r.onclick = () => { if (hasR) window.api.saveSettings({ mapBase: snap.settings.mapBase === "re3mr" ? "vector" : "re3mr" }); };
      st.appendChild(r);
    }
    const lv = document.createElement("span");
    lv.className = "chip dim"; lv.textContent = "Loot value · waiting for tarkov.dev"; lv.title = "Colours areas by how valuable the loot that can spawn there is. Needs container and loose-loot positions, which only tarkov.dev's API carries; it lights up when the API answers.";
    st.appendChild(lv);
    $("flea").value = snap.settings.fleaMin;
    $("fleaVal").textContent = snap.settings.fleaMin ? snap.settings.fleaMin.toLocaleString() + " ₽" : "off";
    const d = snap.data || {};
    const missing = d.features === "missing" || d.tasks === "missing";
    const offline = d.features === "offline" || d.tasks === "offline";
    $("notice").style.display = missing || offline ? "" : "none";
    if (missing) $("notice").textContent = `marker data not downloaded yet — tarkov.dev is down${d.lastError ? " (" + d.lastError + ")" : ""}; retrying every 15 min`;
    else if (offline) { $("notice").textContent = "spawns, bosses and extract names come from the game's own data (offline). Extract pins, keys, containers and quest markers need tarkov.dev — retrying every 15 min."; $("notice").classList.add("soft"); }
  }

  function addDist(pos, el) { if (el) distLabels.push({ el, pos }); }

  function paintMarkers() {
    if (!built || !snap || !mapPayload) return;
    const key = JSON.stringify([[...on()], snap.objectives.map((o) => o.objectiveId), snap.game.side, Boolean(mapPayload.features), snap.settings.fleaMin, currentFloor]);
    if (key === lastMarkersKey) { updateDistances(); return; }
    lastMarkersKey = key;
    markers.clearLayers();
    distLabels = [];
    const def = mapPayload.def, f = mapPayload.features, set = on();
    const withDist = (icon, pos) => { const m = L.marker(TM.pos(pos.x, pos.z), { icon, interactive: false }); markers.addLayer(m); requestAnimationFrame(() => { const el = m.getElement(); const s = el && el.querySelector("small"); addDist(pos, s); }); return m; };
    if (set.has("landmarks")) for (const l of TM.labelsForFloor(def, currentFloor)) markers.addLayer(L.marker(TM.pos(l.position[0], l.position[1]), { icon: TM.place(l.text, l.size), interactive: false }));
    if (set.has("extracts")) for (const e of TM.extractsFor(f, snap.game.side)) {
      if (!e.position) continue;
      const color = e.faction === "transit" ? TM.COLORS.transit : e.faction === "scav" ? TM.COLORS.scavExtract : TM.COLORS.extract;
      withDist(TM.pin(color, e.name, "…"), e.position);
      if (e.outline && e.outline.length >= 3) markers.addLayer(L.polygon(e.outline.map((p) => TM.pos(p.x, p.z)), { className: "tm-extract-outline", interactive: false }));
    }
    if (set.has("quests")) for (const o of snap.objectives) {
      if (!o.position) continue;
      const m = L.marker(TM.pos(o.position.x, o.position.z), { icon: TM.portrait(o.trader.portrait, o.questName, "…"), interactive: false, zIndexOffset: 500 });
      markers.addLayer(m);
      requestAnimationFrame(() => { const el = m.getElement(); addDist(o.position, el && el.querySelector("small")); });
      if (o.outline && o.outline.length >= 3) markers.addLayer(L.polygon(o.outline.map((p) => TM.pos(p.x, p.z)), { className: "tm-outline", interactive: false }));
    }
    if (f) {
      if (set.has("keys")) for (const k of f.locks || []) if (k.position) markers.addLayer(L.marker(TM.pos(k.position.x, k.position.z), { icon: TM.dot(TM.COLORS.key, k.key ? k.key.name.replace(/ key$/i, "") : "lock"), interactive: false }));
      for (const sp of f.spawns || []) {
        const cats = (sp.categories || []).map((c) => String(c).toLowerCase());
        const isBoss = cats.some((c) => /boss|rogue|cultist|raider/.test(c));
        const isSniper = cats.includes("sniper");
        const isScav = cats.includes("scav") || cats.includes("all");
        if (isBoss && set.has("bosses")) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.pin(TM.COLORS.boss, sp.zoneName || cats.join("/")), interactive: false, zIndexOffset: 300 }));
        else if (isSniper && (set.has("scavs") || set.has("hazards"))) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.dot(TM.COLORS.hazard, "sniper"), interactive: false }));
        else if (isScav && !isBoss && set.has("scavs")) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.dot(TM.COLORS.scav, ""), interactive: false }));
      }
      if (set.has("pmc")) for (const sp of f.pmcSpawns || []) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.dot(TM.COLORS.squad, ""), interactive: false }));
      if (set.has("hazards")) for (const h of f.hazards || []) if (h.position) markers.addLayer(L.marker(TM.pos(h.position.x, h.position.z), { icon: TM.dot(TM.COLORS.hazard, h.name), interactive: false }));
      if (set.has("containers") || set.has("loot")) for (const c of f.lootContainers || []) if (c.position) markers.addLayer(L.marker(TM.pos(c.position.x, c.position.z), { icon: TM.dot(TM.COLORS.loot, set.has("containers") && c.lootContainer ? c.lootContainer.name : ""), interactive: false }));
      if (set.has("guns")) for (const g of f.stationaryWeapons || []) if (g.position) markers.addLayer(L.marker(TM.pos(g.position.x, g.position.z), { icon: TM.dot(TM.COLORS.gun, g.stationaryWeapon ? g.stationaryWeapon.name : "MG"), interactive: false }));
      if (set.has("switches")) for (const sw of f.switches || []) if (sw.position) markers.addLayer(L.marker(TM.pos(sw.position.x, sw.position.z), { icon: TM.dot(TM.COLORS.switch, sw.name), interactive: false }));
    }
    requestAnimationFrame(updateDistances);
  }

  function updateDistances() {
    if (!snap || !snap.fix) return;
    for (const d of distLabels) if (d.el) d.el.textContent = TM.fmtM(TM.dist(snap.fix, d.pos));
  }

  function paintSquad() {
    if (!built || !snap) return;
    squadLayer.clearLayers();
    if (!on().has("squad")) return;
    for (const m of Object.values(snap.squad.mates)) {
      const mk = L.marker(TM.pos(m.x, m.z), { icon: TM.mate(m.name, snap.fix ? TM.fmtM(TM.dist(snap.fix, m)) : ""), interactive: false, zIndexOffset: 800 });
      squadLayer.addLayer(mk);
      requestAnimationFrame(() => { const el = mk.getElement(); if (el) el.style.setProperty("--rot", `${m.yaw}deg`); });
    }
    for (const p of snap.squad.pings) squadLayer.addLayer(L.marker(TM.pos(p.x, p.z), { icon: TM.ping(p.text, p.name), interactive: false, zIndexOffset: 900 }));
    const el = $("mates");
    el.innerHTML = Object.values(snap.squad.mates).map((m) => `<div class="row"><span class="g" style="background:${TM.COLORS.squad}"></span><span>${TM.esc(m.name)}</span><span class="d">${m.floor || ""} ${m.moving ? "moving" : "still"} ${m.flag ? "· " + TM.esc(m.flag) : ""}</span>${snap.fix ? `<span class="m">${Math.round(TM.dist(snap.fix, m))}<em>m</em></span>` : ""}</div>`).join("") || `<div style="font-size:11px;color:var(--dim)">${snap.settings.squadEnabled ? "nobody sharing yet" : "squad sharing is off"}</div>`;
  }

  function paintQuests() {
    const el = $("quests");
    if (!snap || !mapPayload) { el.innerHTML = ""; return; }
    const by = new Map();
    for (const o of snap.objectives) { const e = by.get(o.questId) || { name: o.questName, trader: o.trader, objs: [] }; e.objs.push(o); by.set(o.questId, e); }
    el.innerHTML = [...by.entries()].map(([, q]) => `<div class="q"><img src="${q.trader.portrait}"><div><b>${TM.esc(q.name)}</b><span class="d">${TM.esc(q.trader.name)} · ${TM.esc((q.objs[0].description || "").slice(0, 50))}</span></div></div>`).join("") || `<div style="font-size:11px;color:var(--dim)">${snap.data && snap.data.tasks !== "missing" ? "no active quests on this map" : "quest data not downloaded yet"}</div>`;
  }

  function follow() {
    if (!built || !snap || !snap.fix) return;
    const ll = TM.pos(snap.fix.x, snap.fix.z);
    if (!built.map.hasLayer(meMarker)) meMarker.addTo(built.map);
    meMarker.setLatLng(ll);
    const el = meMarker.getElement();
    if (el) el.style.setProperty("--me-rot", `${snap.fix.yaw}deg`);
    if (!followed) { built.map.setView(ll, Math.max(built.map.getZoom(), built.base === "re3mr" ? 3 : 3)); followed = true; }
    trailLine.setLatLngs(snap.trail.map((t) => TM.pos(t.x, t.z)));
    applyFloor();
  }

  function onSnapshot(s) {
    const prev = snap;
    snap = s;
    if (document.hidden) return;
    if (mapPayload && (!built || !prev || prev.settings.mapBase !== s.settings.mapBase || prev.settings.mapStyle !== s.settings.mapStyle || prev.settings.extrudeDepth !== s.settings.extrudeDepth)) ensureMap();
    paintControls();
    applyFloor();
    if (built) paintMarkers();
    follow();
    paintSquad();
    paintQuests();
  }

  function onMap(p) {
    mapPayload = p;
    if (snap) { ensureMap(); paintControls(); if (built) paintMarkers(); paintQuests(); }
  }

  $("flea").oninput = () => { $("fleaVal").textContent = Number($("flea").value) ? Number($("flea").value).toLocaleString() + " ₽" : "off"; };
  $("flea").onchange = () => window.api.saveSettings({ fleaMin: Number($("flea").value) });
  $("ask").onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    const text = $("ask").value.trim();
    if (!text || !mapPayload) return;
    $("ans").textContent = "…";
    const r = await window.api.filterPrompt(text);
    const s = on();
    for (const id of r.off || []) s.delete(id);
    for (const id of r.on || []) s.add(id);
    await window.api.setLayers(mapPayload.def.key, [...s]);
    if (r.fleaMin != null) await window.api.saveSettings({ fleaMin: r.fleaMin });
    if (r.find && built) {
      const hit = (mapPayload.def.labels || []).find((l) => l.text.toLowerCase().includes(r.find.toLowerCase())) || (TM.extractsFor(mapPayload.features, snap.game.side).find((x) => x.name.toLowerCase().includes(r.find.toLowerCase())) || {});
      if (hit.position) { const p = Array.isArray(hit.position) ? TM.pos(hit.position[0], hit.position[1]) : TM.pos(hit.position.x, hit.position.z); built.map.flyTo(p, built.map.getZoom() + 1); }
    }
    $("ans").textContent = r.understood ? `on: ${(r.on || []).join(", ") || "—"} · off: ${(r.off || []).join(", ") || "—"}${r.fleaMin ? ` · flea ≥ ${r.fleaMin.toLocaleString()}` : ""}${r.find ? ` · find ${r.find}` : ""}` : "didn't get that — try 'show extracts and keys' or 'hide scavs'";
    $("ask").value = "";
  };
  for (const c of document.querySelectorAll("[data-ping]")) c.onclick = () => window.api.ping(c.dataset.ping);
  $("close").onclick = () => window.api.hide();
  $("open").onclick = () => window.api.openControl();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && snap) onSnapshot(snap); });
  window.api.onSnapshot(onSnapshot);
  window.api.onMap(onMap);
  window.api.getState().then((s) => { mapPayload = s.map; onSnapshot(s); });
})();
