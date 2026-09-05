/* Control app: Raid · Map (base + align) · Squad · Quests · Layers · Setup · Help. */
(function () {
  const $ = (id) => document.getElementById(id);
  const KEYS = ["F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12","PrintScreen","ScrollLock","Pause","Insert","Home","PageUp","PageDown","End","Delete","CapsLock","Tab","Numpad0","Numpad1","Numpad2","Numpad3","Numpad4","Numpad5","Numpad6","Numpad7","Numpad8","Numpad9","NumpadMultiply","NumpadAdd","NumpadSubtract","NumpadDecimal","NumpadDivide","Mouse3","Mouse4","Mouse5"];
  const HOLD = ["CapsLock","LeftShift","LeftCtrl","LeftAlt","RightAlt","Tab","Mouse4","Mouse5","Mouse3","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12","Numpad0"];
  const LAYERS = [["extracts", "Extracts"], ["quests", "Quests"], ["landmarks", "Places"], ["hud", "Distance text"], ["squad", "Squad"], ["keys", "Keys"], ["bosses", "Bosses"], ["scavs", "Scav spawns"], ["hazards", "Hazards"], ["containers", "Containers"], ["loot", "Loot"], ["guns", "MGs"], ["switches", "Switches"]];
  const STYLES = [["photo", "Photo 2.5D"], ["studio", "Studio"], ["night", "Night"], ["none", "Plain tiles"]];
  const SLIDERS = ["mapOpacity", "overlayScale", "panelOpacity", "minimapSize", "followZoom", "margin", "gameFov", "fleaMin", "extrudeDepth"];
  let snap = null, mapPayload = null;
  let dirtySetup = false;

  for (const k of KEYS) $("screenshotKey").add(new Option(k, k));
  for (const k of HOLD) $("holdKey").add(new Option(k, k));

  document.querySelectorAll("nav a").forEach((a) => (a.onclick = () => show(a.dataset.s)));
  function show(s) {
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.s === s));
    document.querySelectorAll("main section").forEach((x) => x.classList.toggle("on", x.id === "s-" + s));
    if (s === "quests") paintQuests();
    if (s === "map") { paintMapPage(); setTimeout(() => align.refresh(), 60); if (!align.loaded() && mapPayload && $("alignMap").options.length) { $("alignMap").value = mapPayload.re3mrAvailable ? mapPayload.def.key : $("alignMap").value; align.load($("alignMap").value); } }
  }
  document.querySelectorAll("[data-go]").forEach((a) => (a.onclick = () => document.getElementById(a.dataset.go).scrollIntoView({ behavior: "smooth", block: "start" })));

  const fmtV = (id, v) => id === "fleaMin" ? (v ? Number(v).toLocaleString() + " ₽" : "off") : id === "minimapSize" || id === "margin" ? `${v} px` : id === "gameFov" ? `${v}°` : id === "followZoom" ? `${Number(v).toFixed(2)}` : id === "extrudeDepth" ? `${v}` : `${Math.round(v * 100)}%`;
  for (const id of SLIDERS) {
    $(id).oninput = () => ($(id + "V").textContent = fmtV(id, $(id).value));
    $(id).onchange = () => window.api.saveSettings({ [id]: Number($(id).value) });
  }
  document.querySelectorAll("[data-corner]").forEach((c) => (c.onclick = () => window.api.saveSettings({ corner: c.dataset.corner })));
  document.querySelectorAll("[data-tog]").forEach((c) => (c.onclick = () => window.api.saveSettings({ [c.dataset.tog]: !snap.settings[c.dataset.tog] })));
  document.querySelectorAll("[data-ping]").forEach((c) => (c.onclick = () => window.api.ping(c.dataset.ping)));
  document.querySelectorAll("[data-flag]").forEach((c) => (c.onclick = () => window.api.squadStatus(c.dataset.flag)));
  $("bBig").onclick = () => window.api.showBigMap(true);
  $("bHide").onclick = () => window.api.toggleOverlayHidden();
  $("bInteract").onclick = () => window.api.setOverlayInteractive(true);
  $("bSquadSave").onclick = () => window.api.saveSettings({ playerName: $("playerName").value.trim(), squadCode: $("squadCode").value.trim(), squadEnabled: $("squadEnabled").checked });
  $("bDetect").onclick = async () => { const p = await window.api.detectInstall(); if (p) { $("installPath").value = p; dirtySetup = true; } $("installOk").textContent = p ? `found: ${p}` : "not found — paste the folder that contains build\\Logs"; };
  $("bOpenLogs").onclick = () => window.api.openFolder("logs");
  $("bOpenShots").onclick = () => window.api.openFolder("screenshots");
  $("bOpenData").onclick = () => window.api.openFolder("data");
  $("bTiles").onclick = () => { window.api.fetchAllTiles(); $("tileSize").textContent = "downloading…"; };
  $("bClearTiles").onclick = async () => { const s = await window.api.clearTiles(); $("tileSize").textContent = `${s.files} files · ${(s.bytes / 1048576).toFixed(0)} MB`; };
  $("bTest").onclick = async () => {
    $("testOut").textContent = " waiting up to 60 s — go in raid and tap your screenshot key…";
    await saveSetup();
    const fix = await window.api.testScreenshot();
    $("testOut").textContent = fix ? ` got it: x ${fix.x.toFixed(1)}, height ${fix.y.toFixed(1)}, z ${fix.z.toFixed(1)}, facing ${Math.round(fix.yaw)}°` : " nothing arrived. Is Screenshot bound in EFT to the key above?";
  };
  $("bSave").onclick = async () => { await saveSetup(); $("saveOut").textContent = " saved"; setTimeout(() => ($("saveOut").textContent = ""), 2000); };
  for (const id of ["installPath", "screenshotsFolder", "screenshotKey", "mode", "holdKey", "intervalMs", "overlayDisplayId", "bigMapDisplayId", "bigMapEnabled", "openrouterKey", "openrouterModel"]) $(id).addEventListener("input", () => (dirtySetup = true));
  $("mapPick").onchange = () => window.api.selectMap($("mapPick").value || null);
  // Hotkey capture: focus a box, press a chord → Electron accelerator. Backspace/Delete = off.
  const NAMED = { " ": "Space", Tab: "Tab", CapsLock: "Capslock", NumLock: "Numlock", ScrollLock: "Scrolllock", Insert: "Insert", Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Escape", PrintScreen: "Printscreen", Pause: "Pause" };
  function accelFrom(e) {
    if (e.key === "Backspace" || (e.key === "Delete" && !e.ctrlKey)) return "";
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
    let k = null;
    if (/^Numpad\d$/.test(e.code)) k = "num" + e.code.slice(6);
    else if (e.code === "NumpadAdd") k = "numadd"; else if (e.code === "NumpadSubtract") k = "numsub"; else if (e.code === "NumpadMultiply") k = "nummult"; else if (e.code === "NumpadDivide") k = "numdiv"; else if (e.code === "NumpadDecimal") k = "numdec";
    else if (/^F\d{1,2}$/.test(e.key)) k = e.key;
    else if (NAMED[e.key]) k = NAMED[e.key];
    else if (/^[a-z0-9]$/i.test(e.key)) k = e.key.toUpperCase();
    else if (/^[`\-=\[\]\\;',./]$/.test(e.key)) k = e.key;
    if (!k) return null;
    return (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.shiftKey ? "Shift+" : "") + k;
  }
  document.querySelectorAll(".hk").forEach((inp) => {
    inp.onfocus = () => { inp.dataset.was = inp.value; inp.value = ""; inp.placeholder = "press a key…"; };
    inp.onblur = () => { if (!inp.value && inp.dataset.armed !== "off") inp.value = inp.dataset.was || ""; inp.placeholder = "off"; inp.dataset.armed = ""; };
    inp.onkeydown = async (e) => {
      e.preventDefault();
      const acc = accelFrom(e);
      if (acc === null) return;
      inp.dataset.armed = acc ? "" : "off"; inp.dataset.was = acc;
      const fresh = await window.api.saveSettings({ hotkeys: { [inp.dataset.hk]: acc } });
      const got = fresh.settings.hotkeys[inp.dataset.hk];
      $("hkOut").textContent = acc && got !== acc ? `${acc} is already used by another action — pick a different key` : acc ? `${acc} saved` : "switched off";
      inp.value = got; inp.dataset.was = got; inp.blur();
    };
  });
  $("ask").onkeydown = async (e) => {
    if (e.key !== "Enter" || !snap || !mapPayload) return;
    const r = await window.api.filterPrompt($("ask").value.trim());
    const s = new Set(snap.settings.layers[mapPayload.def.key] || ["extracts", "quests", "landmarks", "hud", "squad"]);
    for (const id of r.off || []) s.delete(id);
    for (const id of r.on || []) s.add(id);
    await window.api.setLayers(mapPayload.def.key, [...s]);
    if (r.fleaMin != null) await window.api.saveSettings({ fleaMin: r.fleaMin });
    $("askOut").textContent = r.understood ? `on: ${(r.on || []).join(", ") || "—"} · off: ${(r.off || []).join(", ") || "—"}` : "didn't get that";
    $("ask").value = "";
  };

  async function saveSetup() {
    const patch = {
      installPath: $("installPath").value.trim() || null, screenshotsFolder: $("screenshotsFolder").value.trim() || null,
      screenshotKey: $("screenshotKey").value, mode: $("mode").value, holdKey: $("holdKey").value, intervalMs: Number($("intervalMs").value) || 2000,
      overlayDisplayId: $("overlayDisplayId").value ? Number($("overlayDisplayId").value) : null, bigMapDisplayId: $("bigMapDisplayId").value ? Number($("bigMapDisplayId").value) : null,
      bigMapEnabled: $("bigMapEnabled").checked, openrouterKey: $("openrouterKey").value.trim(), openrouterModel: $("openrouterModel").value.trim() || "openrouter/free", setupDone: true,
    };
    dirtySetup = false;
    snap = await window.api.saveSettings(patch);
    paintAll();
  }

  // ── painters ────────────────────────────────────────────────────────────
  function paintRaid() {
    const g = snap.game;
    const pick = $("mapPick");
    if (pick.options.length === 0) { pick.add(new Option("map from the game / last raid", "")); for (const m of snap.maps) pick.add(new Option(m.name, m.key)); }
    if (document.activeElement !== pick) pick.value = snap.settings.manualMapKey || "";
    const mapName = (snap.maps.find((m) => m.key === snap.mapKey) || {}).name || "no map yet";
    $("rMap").textContent = `${mapName} · ${g.raid}`;
    $("rSide").textContent = `${g.side === "scav" ? "Scav" : "PMC"}${g.raidId ? " · raid " + g.raidId : ""}`;
    $("mapSrc").textContent = snap.mapSource === "game" ? "map from the game (in raid)" : snap.mapSource === "pick" ? "your pick — the game overrides it in a raid" : "last map the game reported";
    const f = snap.fix;
    $("rFeed").textContent = f ? `${f.x.toFixed(0)}, ${f.z.toFixed(0)} · ${Math.round(f.yaw)}°` : "no fix yet";
    $("rFeedSub").textContent = f ? `${Math.round((Date.now() - f.at) / 1000)} s ago · mode: ${snap.settings.mode}${snap.settings.mode === "hold" ? " (" + snap.settings.holdKey + ")" : ""}` : `mode: ${snap.settings.mode} · press ${snap.settings.screenshotKey} in raid`;
    $("rShots").textContent = `${snap.screenshots.files} files · ${(snap.screenshots.bytes / 1048576).toFixed(1)} MB`;
    for (const id of SLIDERS) if (document.activeElement !== $(id)) { $(id).value = snap.settings[id]; $(id + "V").textContent = fmtV(id, snap.settings[id]); }
    document.querySelectorAll("[data-corner]").forEach((c) => c.classList.toggle("on", c.dataset.corner === snap.settings.corner));
    document.querySelectorAll("[data-tog]").forEach((c) => c.classList.toggle("on", Boolean(snap.settings[c.dataset.tog])));
    $("log").textContent = snap.log.join("\n");
    $("log").scrollTop = $("log").scrollHeight;
    const d = snap.data || {};
    const missing = d.features === "missing" || d.tasks === "missing";
    for (const id of ["dataNotice", "layerNotice", "questNotice"]) { $(id).style.display = missing ? "" : "none"; $(id).textContent = `Marker and quest data from tarkov.dev is not downloaded yet${d.lastError ? " (" + d.lastError + ")" : ""}. Extracts, keys, bosses, scav spawns, containers and quest objectives stay empty until it answers; retrying every 15 minutes${d.nextRetryAt ? ", next at " + new Date(d.nextRetryAt).toLocaleTimeString() : ""}.`; }
  }

  function paintMapPage() {
    if (!snap) return;
    const bc = $("baseChips");
    bc.innerHTML = "";
    const hasR = Boolean(mapPayload && mapPayload.re3mr);
    const mk = (label, on, fn, dim) => { const c = document.createElement("span"); c.className = "chip" + (on ? " on" : "") + (dim ? " dim" : ""); c.textContent = label; c.onclick = fn; bc.appendChild(c); };
    mk(hasR ? "RE3MR 3D render (default)" : "RE3MR 3D render (default when aligned)", snap.settings.mapBase === "re3mr", () => window.api.saveSettings({ mapBase: "re3mr" }));
    for (const [id, label] of STYLES) mk(label, snap.settings.mapBase === "tiles" && snap.settings.mapStyle === id, () => window.api.saveSettings({ mapBase: "tiles", mapStyle: id }));
    const ml = $("mapList");
    ml.innerHTML = "";
    for (const m of snap.maps) {
      const p = snap.re3mrProgress && snap.re3mrProgress[m.key];
      const row = document.createElement("div");
      row.className = "maprow";
      const status = !m.re3mr ? "no render published — photo tiles + our style" : p ? `${p.stage}${p.total > 1 ? ` ${p.done}/${p.total}` : ""}` : m.re3mrReady && m.registered ? `ready · aligned ~${Math.round(m.errorM || 0)} m${(m.errorM || 0) > 8 ? " (rough first pass — refine below)" : ""}` : m.re3mrReady ? "sliced · needs alignment" : m.registered ? `aligned ~${Math.round(m.errorM || 0)} m · not downloaded yet` : "not downloaded";
      row.innerHTML = `<span class="n">${m.name}</span><span class="s">${status}</span>`;
      if (m.re3mr && !m.re3mrReady && !p) { const b = document.createElement("button"); b.textContent = "Download + slice"; b.onclick = () => window.api.re3mrPrepare(m.key); row.appendChild(b); }
      if (m.re3mr) { const b = document.createElement("button"); b.textContent = "Align"; b.onclick = () => { $("alignMap").value = m.key; align.load(m.key); }; row.appendChild(b); }
      ml.appendChild(row);
    }
    const sel = $("alignMap");
    if (sel.options.length === 0) for (const m of snap.maps.filter((x) => x.re3mr)) sel.add(new Option(m.name, m.key));
  }

  function paintLayers() {
    const el = $("layerChips");
    el.innerHTML = "";
    if (!mapPayload) { el.innerHTML = '<span class="k">pick a map first</span>'; return; }
    const set = new Set(snap.settings.layers[mapPayload.def.key] || ["extracts", "quests", "landmarks", "hud", "squad"]);
    for (const [id, label] of LAYERS) {
      const c = document.createElement("span");
      c.className = "chip" + (set.has(id) ? " on" : "");
      c.textContent = label;
      c.onclick = () => { set.has(id) ? set.delete(id) : set.add(id); window.api.setLayers(mapPayload.def.key, [...set]); };
      el.appendChild(c);
    }
  }

  function paintSquad() {
    if (document.activeElement !== $("playerName")) $("playerName").value = snap.settings.playerName;
    if (document.activeElement !== $("squadCode")) $("squadCode").value = snap.settings.squadCode;
    $("squadEnabled").checked = snap.settings.squadEnabled;
    const el = $("mates");
    const mates = Object.values(snap.squad.mates);
    el.innerHTML = mates.length ? mates.map((m) => `<div class="row"><span class="g" style="background:${TM.COLORS.squad}"></span><span>${TM.esc(m.name)}</span><span class="d">${m.floor || ""} ${m.moving ? "moving" : "still"} ${m.flag ? "· " + TM.esc(m.flag) : ""} · ${Math.round((Date.now() - m.at) / 1000)} s ago</span>${snap.fix ? `<span class="m">${Math.round(TM.dist(snap.fix, m))}<em>m</em></span>` : ""}</div>`).join("") : `<div class="k">${snap.settings.squadEnabled ? "nobody sharing yet — same code, same raid, same network" : "sharing is off"}</div>`;
  }

  async function paintQuests() {
    const list = await window.api.listQuests();
    const el = $("questList");
    if (!list.length) { el.innerHTML = `<div class="k">${snap && snap.data && snap.data.tasks === "missing" ? "quest names and objectives need tarkov.dev, which is down right now" : `${snap ? snap.activeQuestCount : 0} active quests in your log, none matched to quest data`}</div>`; return; }
    el.innerHTML = "";
    for (const q of list) {
      const row = document.createElement("div");
      row.className = "qrow";
      row.style.opacity = q.done ? ".45" : "1";
      row.innerHTML = `<img src="https://assets.tarkov.dev/${q.trader.id}.webp"><div class="n"><b>${TM.esc(q.name)}</b><span>${TM.esc(q.trader.name)}${q.map ? " · " + TM.esc(q.map) : ""} · ${q.objectives.map((o) => TM.esc(o.description)).join(" · ").slice(0, 160)}</span></div>`;
      const b = document.createElement("button");
      b.textContent = q.done ? "Undo" : "Mark done";
      b.onclick = () => window.api.markQuestDone(q.id, !q.done).then(paintQuests);
      row.appendChild(b);
      el.appendChild(row);
    }
  }

  function paintSetup() {
    if (dirtySetup) return;
    const s = snap.settings;
    $("installPath").value = s.installPath || "";
    $("screenshotsFolder").value = s.screenshotsFolder || "";
    $("installOk").innerHTML = snap.install.logsDir ? `<span class="ok">✓ logs at ${TM.esc(snap.install.logsDir)}</span>` : `<span class="bad">✗ no build\\Logs under that folder</span>`;
    $("screenshotKey").value = s.screenshotKey;
    $("mode").value = s.mode;
    $("holdKey").value = s.holdKey;
    $("intervalMs").value = s.intervalMs;
    for (const id of ["overlayDisplayId", "bigMapDisplayId"]) {
      const sel = $(id);
      sel.innerHTML = "";
      sel.add(new Option(id === "overlayDisplayId" ? "main display" : "the other display", ""));
      for (const d of snap.displays) sel.add(new Option(d.label, String(d.id)));
      sel.value = s[id] == null ? "" : String(s[id]);
    }
    $("bigMapEnabled").checked = s.bigMapEnabled;
    $("openrouterKey").value = s.openrouterKey;
    document.querySelectorAll(".hk").forEach((inp) => { if (document.activeElement !== inp) inp.value = (s.hotkeys || {})[inp.dataset.hk] || ""; });
    $("openrouterModel").value = s.openrouterModel;
    $("tileSize").textContent = `${snap.tileCache.files} files · ${(snap.tileCache.bytes / 1048576).toFixed(0)} MB`;
    $("re3mrSize").textContent = `${snap.re3mrCache.files} files · ${(snap.re3mrCache.bytes / 1048576).toFixed(0)} MB`;
  }

  function paintAll() {
    if (!snap) return;
    paintRaid();
    paintMapPage();
    paintLayers();
    paintSquad();
    paintSetup();
  }

  // ── Align tool ──────────────────────────────────────────────────────────
  const align = (() => {
    let key = null, info = null, left = null, right = null, pairs = [], pending = null, reg = null;
    const lMarkers = L.layerGroup(), rMarkers = L.layerGroup();
    function reset() { if (left) { left.remove(); left = null; } if (right) { right.remove(); right = null; } $("alignL").innerHTML = ""; $("alignR").innerHTML = ""; }
    async function load(k) {
      key = k;
      info = await window.api.re3mrInfo(k);
      pairs = info && info.registration ? info.registration.points.map((p) => [...p]) : [];
      pending = null;
      reg = info && info.registration;
      reset();
      if (!info) { $("alignOut").textContent = "no render for this map"; return; }
      if (!info.imageUrl) { $("alignOut").textContent = "render not downloaded — press Download + slice"; return; }
      const W = info.sliced ? info.sliced.width : 4000, H = info.sliced ? info.sliced.height : 3000;
      // Left map lives in image pixel space: with CRS.Simple, project(ll, maxZoom) == source pixels of the sliced pyramid.
      if (info.sliced && info.template) {
        left = L.map($("alignL"), { crs: L.CRS.Simple, zoomControl: false, attributionControl: false, minZoom: 0, maxZoom: info.sliced.maxZoom + 1, zoomSnap: 0.25, zoomAnimation: false });
        L.tileLayer(info.template, { tileSize: 256, maxNativeZoom: info.sliced.maxZoom, noWrap: true, updateWhenZooming: false }).addTo(left);
        left.setView(left.unproject(L.point(W / 2, H / 2), info.sliced.maxZoom), 1);
      } else {
        left = L.map($("alignL"), { crs: L.CRS.Simple, zoomControl: false, attributionControl: false, minZoom: -5, maxZoom: 3, zoomSnap: 0.25, zoomAnimation: false });
        L.imageOverlay(info.imageUrl, [[-H, 0], [0, W]]).addTo(left);
        left.fitBounds([[-H, 0], [0, W]]);
      }
      lMarkers.addTo(left);
      const mp = await window.api.getMap();
      if (!mp || mp.def.key !== k) { $("alignOut").textContent = "pick this map on the Raid page first, then come back"; }
      else {
        const b = TM.buildMap($("alignR"), mp, { base: "tiles", style: null });
        right = b.map;
        right.fitBounds(b.bounds);
        rMarkers.addTo(right);
        right.on("click", (e) => onRight(e.latlng));
      }
      left.on("click", (e) => onLeft(e.latlng));
      paint();
    }
    function pxOf(ll) { return info.sliced ? left.project(ll, info.sliced.maxZoom) : { x: ll.lng, y: -ll.lat }; }
    function llOf(px, py) { return info.sliced ? left.unproject(L.point(px, py), info.sliced.maxZoom) : L.latLng(-py, px); }
    function onLeft(ll) { const p = pxOf(ll); pending = { px: p.x, py: p.y }; paint(); }
    function onRight(ll) {
      if (!pending) { $("alignOut").textContent = "click the render first"; return; }
      pairs.push([ll.lng, ll.lat, pending.px, pending.py]);
      pending = null;
      fit();
    }
    async function fit() {
      reg = null;
      if (pairs.length >= 3 && info) {
        const r = await window.api.re3mrFit(key, info.sliced ? info.sliced.width : 4000, info.sliced ? info.sliced.height : 3000, pairs);
        if (!r.error) reg = r;
        $("alignOut").textContent = r.error ? r.error : `${pairs.length} pairs · mean error ${r.errorM.toFixed(1)} m${r.homography ? " (projective; affine alone " + r.affineErrorM.toFixed(1) + " m)" : ""}`;
      } else $("alignOut").textContent = `${pairs.length} pairs (need 3+, 6+ is good)`;
      paint();
    }
    function paint() {
      lMarkers.clearLayers(); rMarkers.clearLayers();
      const res = reg ? residualsOf() : [];
      pairs.forEach((p, i) => {
        lMarkers.addLayer(L.marker(llOf(p[2], p[3]), { icon: L.divIcon({ className: "", html: `<div class="cpt"></div><div class="cpt-lbl">${i + 1}${res[i] != null ? " · " + res[i].toFixed(0) + " m" : ""}</div>`, iconSize: [0, 0] }), interactive: false }));
        if (right) rMarkers.addLayer(L.marker(TM.pos(p[0], p[1]), { icon: L.divIcon({ className: "", html: `<div class="cpt"></div><div class="cpt-lbl">${i + 1}</div>`, iconSize: [0, 0] }), interactive: false }));
      });
      if (pending) lMarkers.addLayer(L.marker(llOf(pending.px, pending.py), { icon: L.divIcon({ className: "", html: '<div class="cpt pend"></div><div class="cpt-lbl">now click the tiles</div>', iconSize: [0, 0] }), interactive: false }));
      $("pairs").innerHTML = pairs.map((p, i) => `<div><span>#${i + 1}</span><span>game ${p[0].toFixed(0)}, ${p[1].toFixed(0)}</span><span>px ${p[2].toFixed(0)}, ${p[3].toFixed(0)}</span><i>${res[i] != null ? res[i].toFixed(1) + " m off" : ""}</i><b data-del="${i}" style="cursor:pointer">✕</b></div>`).join("");
      $("pairs").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { pairs.splice(Number(b.dataset.del), 1); fit(); }));
    }
    function residualsOf() {
      const a = reg.affine, s = reg.pxPerM, h = reg.homography;
      return pairs.map(([x, z, px, py]) => {
        if (h) { const w = h[6] * x + h[7] * z + h[8]; return Math.hypot((h[0] * x + h[1] * z + h[2]) / w - px, (h[3] * x + h[4] * z + h[5]) / w - py) / s; }
        return Math.hypot(a.ax * x + a.bx * z + a.cx - px, a.ay * x + a.by * z + a.cy - py) / s;
      });
    }
    $("bUndo").onclick = () => { if (pending) pending = null; else pairs.pop(); fit(); };
    $("bClearPts").onclick = () => { pairs = []; pending = null; fit(); };
    $("bSaveAlign").onclick = async () => { if (!reg) { $("alignOut").textContent = "need at least 3 pairs"; return; } await window.api.re3mrSave(reg); $("alignOut").textContent = `saved · ${reg.errorM.toFixed(1)} m mean error`; };
    $("bPrepare").onclick = () => { window.api.re3mrPrepare($("alignMap").value); $("alignOut").textContent = "downloading and slicing… watch the list above"; };
    $("alignMap").onchange = () => load($("alignMap").value);
    return { load, loaded: () => Boolean(key), refresh: () => { left && left.invalidateSize(); right && right.invalidateSize(); } };
  })();

  window.api.onSnapshot((s) => { snap = s; paintAll(); });
  window.api.onMap((m) => { mapPayload = m; if (snap) { paintMapPage(); paintLayers(); } });
  window.api.onLog((l) => { if (!snap) return; snap.log.push(l); if (snap.log.length > 60) snap.log.shift(); $("log").textContent = snap.log.join("\n"); $("log").scrollTop = $("log").scrollHeight; });
  window.api.onTick((t) => { if (snap) { snap.screenshots = t.screenshots; $("rShots").textContent = `${t.screenshots.files} files · ${(t.screenshots.bytes / 1048576).toFixed(1)} MB`; if (snap.fix) $("rFeedSub").textContent = `${Math.round((t.now - snap.fix.at) / 1000)} s ago · mode: ${snap.settings.mode}`; } });
  window.api.getState().then((s) => { snap = s; mapPayload = s.map; paintAll(); const page = location.hash.slice(1); if (page && $("s-" + page)) show(page); else if (!s.settings.setupDone) show("setup"); });
})();
