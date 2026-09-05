/* Control app: Raid · Squad · Quests · Layers · Setup · Help. */
(function () {
  const $ = (id) => document.getElementById(id);
  const KEYS = ["F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12","PrintScreen","ScrollLock","Pause","Insert","Home","PageUp","PageDown","End","Delete","CapsLock","Tab","Numpad0","Numpad1","Numpad2","Numpad3","Numpad4","Numpad5","Numpad6","Numpad7","Numpad8","Numpad9","NumpadMultiply","NumpadAdd","NumpadSubtract","NumpadDecimal","NumpadDivide","Mouse3","Mouse4","Mouse5"];
  const HOLD = ["CapsLock","LeftShift","LeftCtrl","LeftAlt","RightAlt","Tab","Mouse4","Mouse5","Mouse3","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12","Numpad0"];
  const LAYERS = [["extracts", "Extracts"], ["quests", "Quests"], ["landmarks", "Places"], ["hud", "Distance text"], ["squad", "Squad"], ["keys", "Keys"], ["bosses", "Bosses"], ["scavs", "Scav spawns"], ["hazards", "Hazards"], ["containers", "Containers"], ["loot", "Loot"], ["guns", "MGs"], ["switches", "Switches"]];
  const SLIDERS = ["mapOpacity", "overlayScale", "panelOpacity", "minimapSize", "followZoom", "margin", "gameFov", "fleaMin"];
  let snap = null;
  let dirtySetup = false;

  for (const k of KEYS) $("screenshotKey").add(new Option(k, k));
  for (const k of HOLD) $("holdKey").add(new Option(k, k));

  document.querySelectorAll("nav a").forEach((a) => (a.onclick = () => show(a.dataset.s)));
  function show(s) {
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.s === s));
    document.querySelectorAll("main section").forEach((x) => x.classList.toggle("on", x.id === "s-" + s));
    if (s === "quests") paintQuests();
  }
  document.querySelectorAll("[data-go]").forEach((a) => (a.onclick = () => document.getElementById(a.dataset.go).scrollIntoView({ behavior: "smooth", block: "start" })));

  const fmtV = (id, v) => id === "fleaMin" ? (v ? Number(v).toLocaleString() + " ₽" : "off") : id === "minimapSize" || id === "margin" ? `${v} px` : id === "gameFov" ? `${v}°` : id === "followZoom" ? `${Number(v).toFixed(2)}` : `${Math.round(v * 100)}%`;
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
  $("ask").onkeydown = async (e) => {
    if (e.key !== "Enter" || !snap || !snap.map) return;
    const r = await window.api.filterPrompt($("ask").value.trim());
    const s = new Set(snap.settings.layers[snap.map.def.key] || ["extracts", "quests", "landmarks", "hud", "squad"]);
    for (const id of r.off || []) s.delete(id);
    for (const id of r.on || []) s.add(id);
    await window.api.setLayers(snap.map.def.key, [...s]);
    if (r.fleaMin != null) await window.api.saveSettings({ fleaMin: r.fleaMin });
    $("askOut").textContent = r.understood ? `on: ${(r.on || []).join(", ") || "—"} · off: ${(r.off || []).join(", ") || "—"}` : "didn't get that";
    $("ask").value = "";
  };

  async function saveSetup() {
    dirtySetup = false;
    await window.api.saveSettings({
      installPath: $("installPath").value.trim() || null,
      screenshotsFolder: $("screenshotsFolder").value.trim() || null,
      screenshotKey: $("screenshotKey").value,
      mode: $("mode").value,
      holdKey: $("holdKey").value,
      intervalMs: Number($("intervalMs").value),
      overlayDisplayId: $("overlayDisplayId").value === "" ? null : Number($("overlayDisplayId").value),
      bigMapDisplayId: $("bigMapDisplayId").value === "" ? null : Number($("bigMapDisplayId").value),
      bigMapEnabled: $("bigMapEnabled").checked,
      openrouterKey: $("openrouterKey").value.trim(),
      openrouterModel: $("openrouterModel").value.trim() || "openrouter/free",
      setupDone: true,
    });
  }

  function paintSetup() {
    const s = snap.settings;
    if (dirtySetup) return;
    $("installPath").value = s.installPath || "";
    $("screenshotsFolder").value = s.screenshotsFolder || "";
    $("screenshotKey").value = s.screenshotKey;
    $("mode").value = s.mode;
    $("holdKey").value = s.holdKey;
    $("intervalMs").value = s.intervalMs;
    $("openrouterKey").value = s.openrouterKey || "";
    $("openrouterModel").value = s.openrouterModel || "";
    $("bigMapEnabled").checked = s.bigMapEnabled;
    for (const [id, cur] of [["overlayDisplayId", s.overlayDisplayId], ["bigMapDisplayId", s.bigMapDisplayId]]) {
      const sel = $(id);
      sel.innerHTML = "";
      sel.add(new Option(id === "overlayDisplayId" ? "main display" : "the other display", ""));
      for (const d of snap.displays) sel.add(new Option(d.label, String(d.id)));
      sel.value = cur == null ? "" : String(cur);
    }
    $("installOk").innerHTML = snap.install.logsDir ? `<span class="ok">✓ logs at ${snap.install.logsDir}</span>` : `<span class="bad">✗ no Logs folder found under that path</span>`;
    $("tileSize").textContent = `${snap.tileCache.files} files · ${(snap.tileCache.bytes / 1048576).toFixed(0)} MB`;
  }

  $("mapPick").onchange = () => window.api.selectMap($("mapPick").value || null);
  function paintRaid() {
    const g = snap.game;
    const pick = $("mapPick");
    if (pick.options.length === 0) { pick.add(new Option("pick a map to plan…", "")); for (const m of snap.maps) pick.add(new Option(m.name, m.key)); }
    if (document.activeElement !== pick) pick.value = snap.map ? snap.map.def.key : "";
    $("rMap").textContent = `${snap.map ? snap.map.def.name : "no map"} · ${g.raid}`;
    $("rSide").textContent = `${g.side} · ${snap.activeQuestCount} active quests · ${snap.hasFeatures ? "markers ok" : "markers pending"}`;
    const f = snap.fix;
    $("rFeed").textContent = f ? `${Math.round((Date.now() - f.at) / 1000)} s ago` : "no fix yet";
    $("rFeedSub").textContent = f ? `x ${f.x.toFixed(0)} · z ${f.z.toFixed(0)} · ${snap.floor || "ground"} · ${snap.settings.mode}` : `mode: ${snap.settings.mode} · key ${snap.settings.screenshotKey}`;
    $("rShots").textContent = `${snap.screenshots.files} files · ${(snap.screenshots.bytes / 1048576).toFixed(1)} MB`;
    for (const id of SLIDERS) { $(id).value = snap.settings[id]; $(id + "V").textContent = fmtV(id, snap.settings[id]); }
    document.querySelectorAll("[data-corner]").forEach((c) => c.classList.toggle("on", c.dataset.corner === snap.settings.corner));
    document.querySelectorAll("[data-tog]").forEach((c) => c.classList.toggle("on", Boolean(snap.settings[c.dataset.tog])));
    $("log").textContent = snap.log.join("\n");
    $("log").scrollTop = $("log").scrollHeight;
  }

  function paintSquad() {
    if (document.activeElement !== $("playerName") && document.activeElement !== $("squadCode")) {
      $("playerName").value = snap.settings.playerName;
      $("squadCode").value = snap.settings.squadCode;
      $("squadEnabled").checked = snap.settings.squadEnabled;
    }
    const m = Object.values(snap.squad.mates);
    $("mates").innerHTML = m.length ? m.map((x) => `<div class="row"><span class="g" style="background:#60c8ff"></span><span>${esc(x.name)}</span><span class="d">${x.floor || ""} ${x.moving ? "moving" : "still"} ${x.flag ? "· " + esc(x.flag) : ""} · ${Math.round((Date.now() - x.at) / 1000)} s</span></div>`).join("") : `<span class="k">${snap.settings.squadEnabled ? "nobody sharing in this raid yet" : "sharing is off"}</span>`;
  }

  function paintLayers() {
    const el = $("layerChips");
    el.innerHTML = "";
    if (!snap.map) { el.innerHTML = `<span class="k">no map yet — layers are per map</span>`; return; }
    const on = new Set(snap.settings.layers[snap.map.def.key] || ["extracts", "quests", "landmarks", "hud", "squad"]);
    for (const [id, label] of LAYERS) {
      const c = document.createElement("span");
      c.className = "chip" + (on.has(id) ? " on" : "");
      c.textContent = label;
      c.onclick = () => { on.has(id) ? on.delete(id) : on.add(id); window.api.setLayers(snap.map.def.key, [...on]); };
      el.appendChild(c);
    }
  }

  async function paintQuests() {
    const list = await window.api.listQuests();
    $("questList").innerHTML = list.length ? list.map((q) => `<div class="qrow"><img src="https://assets.tarkov.dev/${q.trader.id}.webp"><div class="n"><b>${esc(q.name)}</b><span>${esc(q.trader.name)} · ${q.map || "any map"} · ${q.objectives.map((o) => esc(o.description)).join(" · ").slice(0, 140)}</span></div><button data-q="${q.id}" data-d="${q.done ? 0 : 1}">${q.done ? "Undo" : "Mark done"}</button></div>`).join("") : `<span class="k">${snap && snap.hasTasks ? "no active quests known yet — start one in game and it appears here" : "quest data not downloaded yet (tarkov.dev) — it retries hourly"}</span>`;
    document.querySelectorAll("[data-q]").forEach((b) => (b.onclick = async () => { await window.api.markQuestDone(b.dataset.q, b.dataset.d === "1"); paintQuests(); }));
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function onSnapshot(s) {
    snap = s;
    paintRaid();
    paintSquad();
    paintLayers();
    paintSetup();
  }
  window.api.onSnapshot(onSnapshot);
  window.api.onTick(() => { if (snap) { $("rFeed").textContent = snap.fix ? `${Math.round((Date.now() - snap.fix.at) / 1000)} s ago` : "no fix yet"; } });
  window.api.onLog((l) => { if (snap) { snap.log.push(l); $("log").textContent = snap.log.slice(-60).join("\n"); $("log").scrollTop = $("log").scrollHeight; } });
  window.api.getState().then((s) => { onSnapshot(s); if (!s.settings.setupDone) show("setup"); });
})();
