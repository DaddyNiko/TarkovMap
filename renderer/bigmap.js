/* Full map window: all layers, floors, flea slider, prompt filter, squad. */
(function () {
  const $ = (id) => document.getElementById(id);
  const LAYERS = [["extracts", "Extracts"], ["quests", "Quests"], ["landmarks", "Places"], ["squad", "Squad"], ["keys", "Keys"], ["bosses", "Bosses"], ["scavs", "Scav spawns"], ["hazards", "Hazards"], ["containers", "Containers"], ["loot", "Loot"], ["guns", "MGs"], ["switches", "Switches"]];
  let snap = null, built = null, markers = L.layerGroup(), squadLayer = L.layerGroup(), meMarker = null, trailLine = null, followed = false, manualFloor = null;

  const on = () => new Set((snap.settings.layers[snap.map.def.key]) || ["extracts", "quests", "landmarks", "hud", "squad"]);

  function ensureMap() {
    const key = snap && snap.map ? snap.map.def.key : null;
    $("title").textContent = key ? snap.map.def.name : "no map yet";
    if (!key) return;
    if (built && built.key === key) return;
    if (built) { built.map.remove(); built = null; }
    $("map").innerHTML = "";
    const b = TM.buildMap($("map"), snap.map, {});
    built = { map: b.map, setFloor: b.setFloor, floors: b.floors, key };
    b.map.fitBounds(b.bounds);
    markers = L.layerGroup().addTo(b.map);
    squadLayer = L.layerGroup().addTo(b.map);
    meMarker = L.marker(TM.pos(0, 0), { icon: TM.me(), interactive: false, zIndexOffset: 1000 });
    trailLine = L.polyline([], { className: "tm-trail", interactive: false }).addTo(b.map);
    followed = false;
    manualFloor = null;
    paintMarkers();
    paintFloors();
  }

  function paintFloors() {
    const el = $("floors");
    el.innerHTML = "";
    if (!built) return;
    const mk = (name, label) => { const c = document.createElement("span"); c.className = "chip" + ((manualFloor === name) ? " on" : ""); c.textContent = label; c.onclick = () => { manualFloor = manualFloor === name ? null : name; built.setFloor(manualFloor || snap.floor); paintFloors(); }; el.appendChild(c); };
    mk(null, "auto");
    for (const f of built.floors) mk(f, f);
  }

  function paintLayers() {
    const el = $("layers");
    el.innerHTML = "";
    if (!snap || !snap.map) return;
    const set = on();
    for (const [id, label] of LAYERS) {
      const c = document.createElement("span");
      c.className = "chip" + (set.has(id) ? " on" : "");
      c.textContent = label;
      c.onclick = () => { const s = on(); s.has(id) ? s.delete(id) : s.add(id); window.api.setLayers(snap.map.def.key, [...s]); };
      el.appendChild(c);
    }
    $("flea").value = snap.settings.fleaMin;
    $("fleaVal").textContent = snap.settings.fleaMin ? snap.settings.fleaMin.toLocaleString() + " ₽" : "off";
  }

  function paintMarkers() {
    if (!built || !snap) return;
    markers.clearLayers();
    const def = snap.map.def, f = snap.map.features, set = on();
    if (set.has("landmarks")) for (const l of def.labels || []) markers.addLayer(L.marker(TM.pos(l.position[0], l.position[1]), { icon: TM.place(l.text, l.size), interactive: false }));
    if (set.has("extracts")) for (const e of TM.extractsFor(f, snap.game.side)) {
      if (!e.position) continue;
      const color = e.faction === "transit" ? TM.COLORS.transit : e.faction === "scav" ? TM.COLORS.scavExtract : TM.COLORS.extract;
      markers.addLayer(L.marker(TM.pos(e.position.x, e.position.z), { icon: TM.pin(color, e.name, snap.fix ? TM.fmtM(TM.dist(snap.fix, e.position)) : ""), interactive: false }));
      if (e.outline && e.outline.length >= 3) markers.addLayer(L.polygon(e.outline.map((p) => TM.pos(p.x, p.z)), { className: "tm-extract-outline", interactive: false }));
    }
    if (set.has("quests")) for (const o of snap.objectives) {
      if (!o.position) continue;
      markers.addLayer(L.marker(TM.pos(o.position.x, o.position.z), { icon: TM.portrait(o.trader.portrait, o.questName, snap.fix ? TM.fmtM(TM.dist(snap.fix, o.position)) : ""), interactive: false, zIndexOffset: 500 }));
      if (o.outline && o.outline.length >= 3) markers.addLayer(L.polygon(o.outline.map((p) => TM.pos(p.x, p.z)), { className: "tm-outline", interactive: false }));
    }
    if (f) {
      if (set.has("keys")) for (const k of f.locks || []) if (k.position) markers.addLayer(L.marker(TM.pos(k.position.x, k.position.z), { icon: TM.dot(TM.COLORS.key, k.key ? k.key.name.replace(/ key$/i, "") : "lock"), interactive: false }));
      for (const sp of f.spawns || []) {
        const cats = (sp.categories || []).map((c) => String(c).toLowerCase());
        const isBoss = cats.some((c) => /boss|rogue|cultist|raider|sniper/.test(c));
        const isScav = cats.includes("scav") || cats.includes("all");
        if ((isBoss && set.has("bosses")) || (isScav && !isBoss && set.has("scavs"))) markers.addLayer(L.marker(TM.pos(sp.position.x, sp.position.z), { icon: TM.dot(isBoss ? TM.COLORS.boss : TM.COLORS.scav, isBoss ? (sp.zoneName || cats.join("/")) : ""), interactive: false }));
      }
      if (set.has("hazards")) for (const h of f.hazards || []) if (h.position) markers.addLayer(L.marker(TM.pos(h.position.x, h.position.z), { icon: TM.dot(TM.COLORS.hazard, h.name), interactive: false }));
      if (set.has("containers") || set.has("loot")) for (const c of f.lootContainers || []) if (c.position) markers.addLayer(L.marker(TM.pos(c.position.x, c.position.z), { icon: TM.dot(TM.COLORS.loot, set.has("containers") && c.lootContainer ? c.lootContainer.name : ""), interactive: false }));
      if (set.has("guns")) for (const g of f.stationaryWeapons || []) if (g.position) markers.addLayer(L.marker(TM.pos(g.position.x, g.position.z), { icon: TM.dot(TM.COLORS.gun, g.stationaryWeapon ? g.stationaryWeapon.name : "MG"), interactive: false }));
      if (set.has("switches")) for (const sw of f.switches || []) if (sw.position) markers.addLayer(L.marker(TM.pos(sw.position.x, sw.position.z), { icon: TM.dot(TM.COLORS.switch, sw.name), interactive: false }));
    }
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
    el.innerHTML = Object.values(snap.squad.mates).map((m) => `<div class="row"><span class="g" style="background:${TM.COLORS.squad}"></span><span>${TM.esc(m.name)}</span><span class="d">${m.floor || ""} ${m.moving ? "moving" : "still"} ${m.flag ? "· " + TM.esc(m.flag) : ""}</span>${snap.fix ? `<span class="m">${Math.round(TM.dist(snap.fix, m))}<em>m</em></span>` : ""}</div>`).join("") || `<div class="d" style="font-size:11px;color:var(--dim)">${snap.settings.squadEnabled ? "nobody sharing yet" : "squad sharing is off"}</div>`;
  }

  function paintQuests() {
    const el = $("quests");
    if (!snap || !snap.map) { el.innerHTML = ""; return; }
    const by = new Map();
    for (const o of snap.objectives) { const e = by.get(o.questId) || { name: o.questName, trader: o.trader, objs: [] }; e.objs.push(o); by.set(o.questId, e); }
    el.innerHTML = [...by.entries()].map(([id, q]) => `<div class="q"><img src="${q.trader.portrait}"><div><b>${TM.esc(q.name)}</b><span class="d">${TM.esc(q.trader.name)} · ${TM.esc((q.objs[0].description || "").slice(0, 50))}</span></div></div>`).join("") || `<div style="font-size:11px;color:var(--dim)">${snap.hasTasks ? "no active quests on this map" : "quest data not downloaded yet"}</div>`;
  }

  function follow() {
    if (!built || !snap || !snap.fix) return;
    const ll = TM.pos(snap.fix.x, snap.fix.z);
    if (!built.map.hasLayer(meMarker)) meMarker.addTo(built.map);
    meMarker.setLatLng(ll);
    const el = meMarker.getElement();
    if (el) el.style.setProperty("--me-rot", `${snap.fix.yaw}deg`);
    if (!followed) { built.map.setView(ll, Math.max(built.map.getZoom(), 3)); followed = true; }
    trailLine.setLatLngs(snap.trail.map((t) => TM.pos(t.x, t.z)));
    if (!manualFloor) built.setFloor(snap.floor);
  }

  function onSnapshot(s) {
    const prev = snap;
    snap = s;
    ensureMap();
    if (built && (!prev || JSON.stringify(prev.settings.layers) !== JSON.stringify(s.settings.layers) || prev.objectives.length !== s.objectives.length || prev.hasFeatures !== s.hasFeatures || prev.game.side !== s.game.side || (prev.fix ? prev.fix.at : 0) !== (s.fix ? s.fix.at : 0))) paintMarkers();
    paintLayers();
    follow();
    paintSquad();
    paintQuests();
  }

  $("flea").oninput = () => { $("fleaVal").textContent = Number($("flea").value) ? Number($("flea").value).toLocaleString() + " ₽" : "off"; };
  $("flea").onchange = () => window.api.saveSettings({ fleaMin: Number($("flea").value) });
  $("ask").onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    const text = $("ask").value.trim();
    if (!text || !snap || !snap.map) return;
    $("ans").textContent = "…";
    const r = await window.api.filterPrompt(text);
    const s = on();
    for (const id of r.off || []) s.delete(id);
    for (const id of r.on || []) s.add(id);
    await window.api.setLayers(snap.map.def.key, [...s]);
    if (r.fleaMin != null) await window.api.saveSettings({ fleaMin: r.fleaMin });
    if (r.find && built) {
      const hit = (snap.map.def.labels || []).find((l) => l.text.toLowerCase().includes(r.find.toLowerCase())) || (TM.extractsFor(snap.map.features, snap.game.side).find((x) => x.name.toLowerCase().includes(r.find.toLowerCase())) || {});
      if (hit.position) { const p = Array.isArray(hit.position) ? TM.pos(hit.position[0], hit.position[1]) : TM.pos(hit.position.x, hit.position.z); built.map.flyTo(p, 5); }
    }
    $("ans").textContent = r.understood ? `on: ${(r.on || []).join(", ") || "—"} · off: ${(r.off || []).join(", ") || "—"}${r.fleaMin ? ` · flea ≥ ${r.fleaMin.toLocaleString()}` : ""}${r.find ? ` · find ${r.find}` : ""}` : "didn't get that — try 'show extracts and keys' or 'hide scavs'";
    $("ask").value = "";
  };
  for (const c of document.querySelectorAll("[data-ping]")) c.onclick = () => window.api.ping(c.dataset.ping);
  $("close").onclick = () => window.api.hide();
  window.api.onSnapshot(onSnapshot);
  window.api.getState().then(onSnapshot);
})();
