/* Full map window: all layers, floors, base/style, flea slider, prompt filter, squad.
 * Markers are built once per (map, layers, data) and only their distance
 * labels are updated per fix — rebuilding hundreds of DOM markers every
 * 2 s was the v0.1 lag. */
(function () {
  const $ = (id) => document.getElementById(id);
  const LAYERS = TM.LAYERS.filter((l) => !l[2] || l[2] === "bigmap");
  const STYLES = [["studio", "Light"], ["night", "Dark"]];
  let snap = null, mapPayload = null, questPayload = null, built = null, markers = L.layerGroup(), squadLayer = L.layerGroup(), meMarker = null, trailLine = null, followed = false, manualFloor = null;
  let distLabels = []; // {el, pos}
  let lastMarkersKey = "";
  let popupMarkers = []; // {layer, marker, id} — for the rail list and the capture hook
  const on = () => (snap && mapPayload ? TM.layersOn(snap.settings, mapPayload.def.key) : new Set(TM.DEFAULT_LAYERS));
  const questsHere = () => (questPayload && mapPayload && questPayload.mapKey === mapPayload.def.key ? questPayload : null);
  const popupHandlers = { obj: (id, done) => window.api.markObjectiveDone(id, done), quest: (id, done) => window.api.markQuestDone(id, done), wiki: (u) => window.api.openUrl(u) };
  const popupCtx = () => { const q = questsHere(); return { objectiveDone: q ? q.objectiveDone : {}, objectivesOf: (questId) => { const seen = new Set(); return (q ? q.all : []).filter((o) => o.questId === questId && !seen.has(o.objectiveId) && seen.add(o.objectiveId)); } }; };

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
    b.map.on("zoomend", () => { if (built === b) { lastMarkersKey = ""; paintMarkers(); } }); // small place names appear as he zooms in
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
    const f = mapPayload.features || {};
    const hasBoss = (f.spawns || []).some((sp) => (sp.categories || []).some((c) => /boss|rogue|cultist|raider/i.test(c)));
    // What each layer could draw right now — an empty chip must say so, or it reads as broken.
    const qp = questsHere();
    const EMPTY = {
      extracts: !(f.extracts || []).some((e) => e.position), keys: !(f.locks || []).length, containers: !(f.lootContainers || []).length,
      loot: !(mapPayload.loot && mapPayload.loot.points.length), guns: !(f.stationaryWeapons || []).length, switches: !(f.switches || []).length, hazards: !(f.hazards || []).length,
      bosses: !hasBoss, scavs: !(f.spawns || []).length, pmc: !(f.pmcSpawns || []).length, quests: !(snap.objectives || []).some((o) => o.position),
      allquests: !(qp && qp.all.some((o) => o.position)), questitems: !(qp && qp.hasItemData && qp.items.length),
    };
    const NEEDS_API = "no positions in the offline data — waiting for json.tarkov.dev (retrying every 15 min)";
    const TITLES = { allquests: "every quest with a spot on this map, coloured by state: amber = accepted, white = not started, grey = needs earlier quests, green = done", questitems: qp && !qp.hasItemData ? "needs the item lists from json.tarkov.dev (not in the offline data)" : "items that accepted and future quests need, at the spots where they can spawn; hover or click for the quests" };
    const lay = $("layers");
    lay.innerHTML = "";
    for (const [id, label] of LAYERS) {
      const c = document.createElement("span");
      c.className = "chip" + (set.has(id) ? " on" : "");
      c.textContent = label;
      if (TITLES[id]) c.title = TITLES[id];
      if (EMPTY[id]) {
        c.classList.add("empty");
        c.title = id === "extracts" ? "extract names are listed below; " + NEEDS_API : id === "keys" ? "locked rooms are drawn on the floor plans; key names and door pins need json.tarkov.dev" : TITLES[id] || NEEDS_API;
        c.textContent = label + " · none yet";
      }
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
    const heatReady = Boolean(mapPayload.loot && mapPayload.loot.heat && mapPayload.loot.heat.cells.length);
    lv.className = "chip" + (snap.settings.lootHeat && heatReady ? " on" : "") + (heatReady ? "" : " dim");
    lv.textContent = heatReady ? "Loot value" : "Loot value · no loot data yet";
    lv.title = heatReady ? "Colours 25 m squares by the loot that CAN spawn there (loose spawns priced at flea, containers by the game's loot tables). Possible loot — not what spawned in your raid." : "Needs the loot positions from tarkov.dev; they download on their own.";
    lv.onclick = () => { if (heatReady) window.api.saveSettings({ lootHeat: !snap.settings.lootHeat }); };
    st.appendChild(lv);
    $("heatLegend").style.display = snap.settings.lootHeat && heatReady ? "" : "none";
    $("flea").value = snap.settings.fleaMin;
    $("fleaVal").textContent = snap.settings.fleaMin ? snap.settings.fleaMin.toLocaleString() + " ₽" : "off";
    $("qiWrap").style.display = set.has("questitems") ? "" : "none";
    $("qi").value = snap.settings.questItemMin;
    $("qiVal").textContent = snap.settings.questItemMin ? `${snap.settings.questItemMin}+` : "everything";
    $("showDone").style.display = set.has("allquests") ? "" : "none";
    $("showDone").className = "chip" + (snap.settings.showDoneQuests ? " on" : "");
    const n = TM.dataNotice(snap.data);
    $("notice").style.display = n.level ? "" : "none";
    $("notice").textContent = n.text;
    $("notice").classList.toggle("soft", n.level === "offline");
  }

  function addDist(pos, el) { if (el) distLabels.push({ el, pos }); }

  function paintMarkers() {
    if (!built || !snap || !mapPayload) return;
    const qp = questsHere();
    const key = JSON.stringify([[...on()], snap.objectives.map((o) => o.objectiveId), snap.game.side, Boolean(mapPayload.features), snap.settings.fleaMin, snap.settings.lootHeat, currentFloor, Math.round(built.map.getZoom()), qp ? [qp.all.length, Object.keys(qp.objectiveDone).length, qp.items.length] : null, snap.settings.questItemMin, snap.settings.showDoneQuests]);
    if (key === lastMarkersKey) { updateDistances(); return; }
    lastMarkersKey = key;
    markers.clearLayers();
    distLabels = [];
    popupMarkers = [];
    const def = mapPayload.def, f = mapPayload.features, set = on();
    const withDist = (icon, pos) => { const m = L.marker(TM.pos(pos.x, pos.z), { icon, interactive: false }); markers.addLayer(m); requestAnimationFrame(() => { const el = m.getElement(); const s = el && el.querySelector("small"); addDist(pos, s); }); return m; };
    if (set.has("landmarks")) {
      // Dense floors (77 store names on Interchange) overlap into mush at a wide zoom: the big names always
      // show, mid-size ones two steps from the closest zoom, the small ones one step from it.
      const z = built.map.getZoom(), maxZ = def.maxZoom || 6;
      const show = (l) => !l.size || l.size >= 90 || (l.size >= 70 && z >= maxZ - 2) || z >= maxZ - 1;
      for (const l of TM.labelsForFloor(def, currentFloor)) if (show(l)) markers.addLayer(L.marker(TM.pos(l.position[0], l.position[1]), { icon: TM.place(l.text, l.size), interactive: false }));
    }
    if (set.has("extracts")) for (const e of TM.extractsFor(f, snap.game.side)) {
      if (!e.position) continue;
      const color = e.faction === "transit" ? TM.COLORS.transit : e.faction === "scav" ? TM.COLORS.scavExtract : TM.COLORS.extract;
      withDist(TM.pin(color, e.name, "…"), e.position);
      if (e.outline && e.outline.length >= 3) markers.addLayer(L.polygon(e.outline.map((p) => TM.pos(p.x, p.z)), { className: "tm-extract-outline", interactive: false }));
    }
    // Quests: accepted ones (amber) from the 2 s snapshot; every other quest on the map from the quest payload,
    // coloured by state. Both kinds open the same popup (state, level, objectives with ticks, wiki).
    const exOf = (objectiveId) => (qp ? qp.all.find((o) => o.objectiveId === objectiveId) : null);
    const questMarker = (o, status, layer) => {
      const ex = exOf(o.objectiveId) || o;
      const m = L.marker(TM.pos(o.position.x, o.position.z), { icon: TM.portrait(o.trader.portrait, o.questName, layer === "quests" ? "…" : "", status), interactive: true, zIndexOffset: status === "active" ? 500 : 450 });
      TM.bindQuestPopup(m, `${o.questName} · ${o.description}`, () => ({ ...ex, status }), popupCtx, popupHandlers);
      markers.addLayer(m);
      popupMarkers.push({ layer, marker: m, id: o.objectiveId, questId: o.questId });
      if (layer === "quests") requestAnimationFrame(() => { const el = m.getElement(); addDist(o.position, el && el.querySelector("small")); });
      if (o.outline && o.outline.length >= 3) markers.addLayer(L.polygon(o.outline.map((p) => TM.pos(p.x, p.z)), { className: "tm-outline" + (status === "active" ? "" : " tm-outline-dim"), interactive: false }));
    };
    if (set.has("quests")) for (const o of snap.objectives) if (o.position) questMarker(o, "active", "quests");
    if (set.has("allquests") && qp) {
      const activeShown = new Set(set.has("quests") ? snap.objectives.map((o) => o.objectiveId) : []);
      for (const o of qp.all) {
        if (!o.position || activeShown.has(o.objectiveId)) continue;
        if ((o.status === "done" || o.status === "failed") && !snap.settings.showDoneQuests) continue;
        questMarker(o, o.status, "allquests");
      }
    }
    if (set.has("questitems") && qp) {
      const min = snap.settings.questItemMin || 0;
      for (const it of qp.items) {
        if (it.importance < min && !(it.kind === "questItem" && it.done)) continue;
        const top = it.items[0] || {};
        const m = L.marker(TM.pos(it.position.x, it.position.z), { icon: TM.itemIcon(top.icon, it.kind === "questItem" ? it.label : "", it.importance, it.kind === "questItem" ? "quest" : "item", it.done), interactive: true, zIndexOffset: 400 });
        TM.bindQuestPopup(m, `${it.label} · ${[...new Set(it.items.flatMap((x) => x.quests.map((q) => q.questName)))].slice(0, 3).join(", ")}`, () => it, popupCtx, popupHandlers);
        markers.addLayer(m);
        popupMarkers.push({ layer: "questitems", marker: m, id: it.objectiveId || it.label, questId: it.questId || null });
      }
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
      if (set.has("containers")) for (const c of f.lootContainers || []) if (c.position) markers.addLayer(L.marker(TM.pos(c.position.x, c.position.z), { icon: TM.dot(TM.COLORS.loot, c.lootContainer ? c.lootContainer.name : ""), interactive: false }));
      // Loot = loose-loot spawn points, labelled with the best item that CAN be there; the flea slider is the floor.
      // With the slider off only the top 80 show, or the map is a pink blizzard.
      if (set.has("loot") && mapPayload.loot) {
        const min = snap.settings.fleaMin || 0;
        const pts = min ? mapPayload.loot.points.filter((p) => p.price >= min) : mapPayload.loot.points.slice(0, 80);
        for (const p of pts) markers.addLayer(L.marker(TM.pos(p.position.x, p.position.z), { icon: TM.dot(TM.COLORS.loot, `${p.name} · ${p.price >= 1000 ? Math.round(p.price / 1000) + "k" : p.price} ₽`), interactive: false }));
      }
      if (snap.settings.lootHeat && mapPayload.loot) markers.addLayer(TM.lootHeatLayer(mapPayload.loot.heat, { interactive: true }));
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
    const qp = questsHere();
    const groups = { active: [], available: [], locked: [] };
    const seen = new Set();
    const src = qp ? qp.all : snap.objectives.map((o) => ({ ...o, status: "active" }));
    for (const o of src) {
      if (seen.has(o.questId) || !groups[o.status]) continue;
      seen.add(o.questId);
      const objs = src.filter((x) => x.questId === o.questId);
      const ids = [...new Set(objs.map((x) => x.objectiveId))];
      const done = qp ? ids.filter((id) => qp.objectiveDone[id]).length : 0;
      groups[o.status].push({ id: o.questId, name: o.questName, trader: o.trader, objs, done, total: ids.length });
    }
    const row = (q, cls) => `<div class="q ${cls}" data-quest="${TM.esc(q.id)}"><img src="${q.trader.portrait}"><div><b>${TM.esc(q.name)}</b><span class="d">${TM.esc(q.trader.name)} · ${TM.esc((q.objs[0].description || "").slice(0, 44))}${q.total > 1 ? ` · ${q.done}/${q.total}` : ""}</span></div></div>`;
    const section = (title, list, cls) => (list.length ? `<div class="qsec">${title} · ${list.length}</div>${list.map((q) => row(q, cls)).join("")}` : "");
    el.innerHTML = section("Accepted", groups.active, "") + section("Not started", groups.available, "avail") + (groups.locked.length ? `<div class="qsec dimmer">${groups.locked.length} locked behind earlier quests</div>` : "") || `<div style="font-size:11px;color:var(--dim)">${snap.data && snap.data.tasks !== "missing" ? "no quests with a spot on this map" : "quest data not downloaded yet"}</div>`;
    el.querySelectorAll("[data-quest]").forEach((r) => (r.onclick = () => {
      const hit = popupMarkers.find((p) => p.questId === r.dataset.quest);
      if (hit && built) { built.map.flyTo(hit.marker.getLatLng(), Math.max(built.map.getZoom(), 4)); setTimeout(() => hit.marker.openPopup(), 500); }
    }));
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
  function onQuests(q) {
    questPayload = q;
    if (snap && mapPayload) { paintControls(); if (built) { lastMarkersKey = ""; paintMarkers(); } paintQuests(); }
  }

  $("flea").oninput = () => { $("fleaVal").textContent = Number($("flea").value) ? Number($("flea").value).toLocaleString() + " ₽" : "off"; };
  $("flea").onchange = () => window.api.saveSettings({ fleaMin: Number($("flea").value) });
  $("qi").oninput = () => { $("qiVal").textContent = Number($("qi").value) ? `${$("qi").value}+` : "everything"; };
  $("qi").onchange = () => window.api.saveSettings({ questItemMin: Number($("qi").value) });
  $("showDone").onclick = () => window.api.saveSettings({ showDoneQuests: !snap.settings.showDoneQuests });
  // Capture hook: counts and a way to open a popup without a mouse (see armSequenceCapture in main.ts).
  window.TMDebug = {
    counts: () => ({ markers: markers.getLayers().length, quests: popupMarkers.filter((p) => p.layer === "quests").length, allquests: popupMarkers.filter((p) => p.layer === "allquests").length, questitems: popupMarkers.filter((p) => p.layer === "questitems").length, all: questPayload ? questPayload.all.length : -1, items: questPayload ? questPayload.items.length : -1 }),
    openPopup: (layer, i) => { const hit = popupMarkers.filter((p) => p.layer === layer)[i || 0]; if (!hit) return null; built.map.setView(hit.marker.getLatLng(), Math.max(built.map.getZoom(), 4), { animate: false }); hit.marker.openPopup(); const el = hit.marker.getPopup().getElement(); return el ? el.innerText : null; },
  };
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
  window.api.onQuests(onQuests);
  window.api.getState().then((s) => { mapPayload = s.map; questPayload = s.quests || null; onSnapshot(s); });
})();
