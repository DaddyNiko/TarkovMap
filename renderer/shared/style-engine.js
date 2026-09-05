/* TarkovMap style engine — turns a tarkov.dev (or traced / TarkovTracker) map SVG into the Studio
 * or Night look: terrain palette, road casings + centre lines, extruded beige buildings, floor plans
 * (rooms, walls, doors, stairs) and ONE floor at a time.
 *
 *   TMStyle.style(svgText, "studio"|"night", { floor, floorIds, depth })  → styled <svg> element
 *   TMStyle.floorGroups(svgText)                                          → floor group ids present
 *
 * A floor is EXCLUSIVE: with `floor` set only that group is emitted; the ground level and every other
 * floor are removed (his call: "hide the other floors, not just darken"). Without `floor`, the ground
 * level is emitted and every floor group removed. Group ids are the vocabulary tarkov.dev uses
 * (Ground_Level, Underground_Level, First_Floor … Fifth_Floor, Basement, Bunkers, Tunnels) plus the
 * traced maps' deck names passed through `floorIds`. Pure DOM work on a parsed SVG; no network. */
(function () {
  const PRESETS = {
    studio: { name: "Studio", land: "#6f8a4c", trees: "#3e6a35", treeDot: "#2f5428", water: "#4f86b6", cement: "#cfc8bb", gravel: "#b39664", rock: "#c9c1a6",
      roofs: ["#e0c9a0", "#d9b98a", "#e6d3b0", "#cdb48e"], side: "#8a6f4e", sideLit: "#a68662", roofEdge: "#5d4832",
      road: "#8f9399", roadCase: "#3b3f45", roadCenter: "#d8d8d0", rail: "#7a5a44", fence: "rgba(255,255,255,.45)", floor: "#e0c9a0", roomLine: "#7c6a4e",
      wall: "#4a3f34", stairs: "#2f9e4f", door: "#c98f2a", obstacle: "#9a8f80", depth: 4, tileFilter: "saturate(.75) contrast(1.15) brightness(1.08)" },
    night: { name: "Night", land: "#232d27", trees: "#1b2f24", treeDot: "#12231a", water: "#1f3a56", cement: "#3f454d", gravel: "#3f3627", rock: "#3d3d38",
      roofs: ["#3a4a5c", "#374559", "#40506a", "#33414f"], side: "#161d26", sideLit: "#243040", roofEdge: "#ffc45c",
      road: "#b9bcc2", roadCase: "#0b0d10", roadCenter: "#ffffff", rail: "#a0724f", fence: "rgba(255,196,92,.55)", floor: "#3a4a5c", roomLine: "#ffc45c",
      wall: "#ffc45c", stairs: "#6fdc7a", door: "#ffd27a", obstacle: "#4a525e", depth: 4, tileFilter: "brightness(.55) saturate(.35) hue-rotate(190deg)" },
  };

  const parser = new DOMParser();
  const FLOOR_RE = /(_Level|_Floor|^Basement$|^Bunkers$|^Tunnels)/i;
  const GROUND_RE = /^(Ground_Level|Ground_Floor|First_Level)$/i;
  const CLASS_RE = /^(building|floor|land|cement|gravel|tarmac|water|trees|rock|wood|fence|railroad|danger|stairs|wall|locked|misc)$/;

  function topGroups(svg) {
    const gs = [...svg.children].filter((c) => c.tagName === "g");
    const root = gs.length === 1 && !gs[0].id ? gs[0] : svg;
    return [...root.querySelectorAll(":scope > g[id]")];
  }

  /** Every top-level group id (floor plans and ground alike) — buildMap asks this before hiding the ground for a floor. */
  function groupIds(svgText) {
    const svg = parser.parseFromString(svgText, "image/svg+xml").documentElement;
    return topGroups(svg).map((g) => g.id);
  }

  function floorGroups(svgText) {
    const svg = parser.parseFromString(svgText, "image/svg+xml").documentElement;
    return topGroups(svg).map((g) => g.id).filter((id) => FLOOR_RE.test(id) && !GROUND_RE.test(id));
  }

  /**
   * @param {string} svgText
   * @param {"studio"|"night"} presetName
   * @param {{depth?:number, floor?:string|null, floorIds?:string[]|null}} [opts]
   */
  function style(svgText, presetName, opts) {
    opts = opts || {};
    const P = PRESETS[presetName] || PRESETS.studio;
    const depth = opts.depth == null ? P.depth : opts.depth;
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    for (const s of svg.querySelectorAll("style")) s.remove();
    const st = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    st.textContent = `.land{fill:${P.land}} .trees{fill:url(#tm-canopy)} .water{fill:${P.water}} .cement{fill:${P.cement}} .gravel{fill:${P.gravel}} .rock{fill:${P.rock}} .wood{fill:#7a4b1e} .tarmac{fill:${P.road}}
      .building{fill:${P.roofs[0]};stroke:${P.roofEdge};stroke-width:.9} .floor{fill:${P.floor};stroke:${P.roofEdge};stroke-width:1} .locked{fill:#c46a6a} .fence{fill:none;stroke:${P.fence};stroke-width:1}
      .road_tarmac{fill:none;stroke:${P.road}} .road_gravel{fill:none;stroke:${P.gravel}} .road_small{stroke-width:5} .road_medium{stroke-width:8} .road_large{stroke-width:12}
      .railroad{fill:none;stroke:${P.rail};stroke-dasharray:6;stroke-width:3} .powerline{fill:none;stroke:rgba(255,206,0,.5);stroke-width:2;stroke-dasharray:6,6} .map_border{fill:none;stroke:none}
      .danger{fill:red;fill-opacity:.25;stroke:red;stroke-width:2} .danger_small{fill:red;fill-opacity:.35;stroke:red;stroke-width:1} .task{fill:#000} .stairs{fill:${P.stairs}} .shadow{filter:none} .plane{fill:#fff} .misc{fill:${P.cement}}
      .wall{fill:${P.wall};fill-opacity:.55;stroke:${P.wall};stroke-width:.35} .door{fill:${P.door}} .obstacle{fill:${P.obstacle}} .structure{fill:${P.cement}}`;
    svg.insertBefore(st, svg.firstChild);
    const defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `<pattern id="tm-canopy" patternUnits="userSpaceOnUse" width="7" height="7"><rect width="7" height="7" fill="${P.trees}"/><circle cx="2" cy="2" r="1.6" fill="${P.treeDot}"/><circle cx="5.5" cy="5" r="1.2" fill="${P.treeDot}"/></pattern>`;
    svg.insertBefore(defs, svg.firstChild);

    // Group-level classes (Streets: <g id="buildings" class="building">; Customs nests Trees/Roads/Buildings
    // INSIDE the land group): every class-less leaf takes the class of its NEAREST classed ancestor.
    for (const p of svg.querySelectorAll("path,rect,polygon,circle,ellipse")) {
      if (p.classList.length) continue;
      const g = p.parentNode && p.parentNode.closest ? p.parentNode.closest("g[class]") : null;
      if (!g) continue;
      const cls = [...g.classList].filter((c) => CLASS_RE.test(c));
      if (cls.length) p.classList.add(...cls);
    }
    // <use> copies (Customs' map limit re-uses the land path) would now paint with the referenced shape's
    // class — the limit is invisible in our styles anyway, so drop such copies outright.
    for (const u of svg.querySelectorAll("use")) {
      const g = u.closest("g[class]");
      if (g && /map_border|limit/i.test(g.getAttribute("class") || "")) u.remove();
      else { u.style.fill = "none"; u.style.stroke = "none"; }
    }
    // Floor-plan vocabulary (Factory, Labs, traced maps): Wall-*, Stairs-*, Obstacles-*, Doors, Rooms, Arrows, Floor-*.
    for (const g of svg.querySelectorAll("g[id]")) {
      const id = g.id;
      const leafs = () => g.querySelectorAll("path,rect,polygon");
      if (/^Wall/i.test(id)) for (const p of leafs()) p.classList.add("wall");
      else if (/^Stairs/i.test(id) || /^Arrows$/i.test(id)) for (const p of leafs()) { p.classList.add("stairs"); if (/^Arrows$/i.test(id)) p.removeAttribute("style"); }
      else if (/^Obstacles/i.test(id)) for (const p of leafs()) p.classList.add("obstacle");
      else if (/^Doors$/i.test(id)) for (const p of leafs()) { p.classList.add("door"); p.removeAttribute("style"); }
      else if (/^Rooms$/i.test(id)) for (const p of leafs()) { p.classList.add("floor"); p.removeAttribute("style"); }
      else if (/^Floor/i.test(id)) for (const p of leafs()) { if (!p.classList.length) p.classList.add("floor"); }
    }

    // ── floors: exclusive ────
    const groups = topGroups(svg);
    const floor = opts.floor || null;
    const isFloor = (g) => (opts.floorIds ? opts.floorIds.includes(g.id) : FLOOR_RE.test(g.id) && !GROUND_RE.test(g.id));
    for (const g of groups) {
      const keep = floor ? g.id.toLowerCase() === floor.toLowerCase() : !isFloor(g);
      if (!keep) g.remove();
    }

    // ── roads: casing under, centre line over (any casing of the id) ────
    for (const roads of svg.querySelectorAll("g[id]")) {
      if (!/^(roads|normal_roads|highways|main_roads|high_roads|dirt_roads|dirty_roads|dirt_road|small roads|roads_small|roads_medium|roads_unpaved|road)$/i.test(roads.id)) continue;
      if (roads.dataset.tmDone) continue;
      roads.dataset.tmDone = "1";
      const c = roads.cloneNode(true);
      c.removeAttribute("id");
      for (const p of c.querySelectorAll("*")) {
        p.removeAttribute("id");
        const w = p.classList.contains("road_large") ? 12 : p.classList.contains("road_medium") ? 8 : p.classList.contains("road_small") ? 5 : 0;
        if (w) { p.style.stroke = P.roadCase; p.style.strokeWidth = `${w + 3.5}px`; p.style.fill = "none"; }
      }
      roads.parentNode.insertBefore(c, roads);
      const cl = roads.cloneNode(true);
      cl.removeAttribute("id");
      for (const p of cl.querySelectorAll("*")) {
        p.removeAttribute("id");
        if (p.classList.contains("road_large")) { p.style.stroke = P.roadCenter; p.style.strokeWidth = ".7px"; p.style.strokeDasharray = "4 3"; p.style.fill = "none"; }
        else if (p.tagName !== "g") p.remove();
      }
      roads.parentNode.insertBefore(cl, roads.nextSibling);
    }

    // ── buildings: roof colours cycled + extrusion (offset darker copies under the roofs) ────
    const buildingsGroup = [...svg.querySelectorAll("g[id]")].find((g) => /^buildings$/i.test(g.id));
    if (buildingsGroup) {
      let k = 0;
      for (const p of buildingsGroup.querySelectorAll(".building")) if (p.tagName !== "g" && !p.style.fill) p.style.fill = P.roofs[k++ % P.roofs.length];
      for (let i = depth; i >= 1; i--) {
        const c = buildingsGroup.cloneNode(true);
        c.removeAttribute("id");
        c.setAttribute("transform", `translate(${0.4 * i},${0.75 * i})`);
        for (const p of c.querySelectorAll("*")) {
          p.removeAttribute("id");
          p.style.fill = i % 2 ? P.side : P.sideLit;
          p.style.stroke = i === depth ? "rgba(0,0,0,.4)" : "none";
          p.style.strokeWidth = ".6px";
        }
        buildingsGroup.parentNode.insertBefore(c, buildingsGroup);
      }
    }
    return svg;
  }

  window.TMStyle = { PRESETS, style, floorGroups, groupIds, FLOOR_RE, GROUND_RE };
})();
