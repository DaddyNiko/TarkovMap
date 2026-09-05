/* TarkovMap style engine: turns tarkov.dev's vector SVG into OUR map.
 * Strips their stylesheet, injects a preset palette, adds road casings and
 * centre lines, extrudes buildings (offset clones under a lit roof), styles
 * floor groups as rooms. Pure DOM work on a parsed SVG; no network. */
(function () {
  const PRESETS = {
    photo: { name: "Photo 2.5D", tiles: true, land: "none", trees: "none", treeDot: "none", water: "none", cement: "none", gravel: "none", rock: "none",
      roofs: ["rgba(224,201,160,.9)", "rgba(217,185,138,.9)", "rgba(230,211,176,.9)", "rgba(205,180,142,.9)"], side: "#4e3d2b", sideLit: "#6b5540", roofEdge: "#3f3224",
      road: "rgba(150,154,160,.75)", roadCase: "#1e2125", roadCenter: "rgba(240,240,232,.9)", rail: "#7a5a44", fence: "rgba(255,255,255,.5)", floor: "rgba(242,234,216,.92)", roomLine: "#7c6a4e", depth: 4 },
    studio: { name: "Studio", tiles: false, land: "#6f8a4c", trees: "#3e6a35", treeDot: "#2f5428", water: "#4f86b6", cement: "#cfc8bb", gravel: "#b39664", rock: "#c9c1a6",
      roofs: ["#e0c9a0", "#d9b98a", "#e6d3b0", "#cdb48e"], side: "#8a6f4e", sideLit: "#a68662", roofEdge: "#5d4832",
      road: "#8f9399", roadCase: "#3b3f45", roadCenter: "#d8d8d0", rail: "#7a5a44", fence: "rgba(255,255,255,.45)", floor: "#f2ead8", roomLine: "#7c6a4e", depth: 4 },
    night: { name: "Night Ops", tiles: false, land: "#232d27", trees: "#1b2f24", treeDot: "#12231a", water: "#1f3a56", cement: "#3f454d", gravel: "#3f3627", rock: "#3d3d38",
      roofs: ["#3a4a5c", "#374559", "#40506a", "#33414f"], side: "#161d26", sideLit: "#243040", roofEdge: "#ffc45c",
      road: "#b9bcc2", roadCase: "#0b0d10", roadCenter: "#ffffff", rail: "#a0724f", fence: "rgba(255,196,92,.55)", floor: "#4a5668", roomLine: "#ffc45c", depth: 4 },
  };

  const parser = new DOMParser();

  /**
   * @param {string} svgText tarkov.dev map SVG
   * @param {string} presetName photo|studio|night
   * @param {{depth?:number}} [opts]
   * @returns {SVGSVGElement}
   */
  function style(svgText, presetName, opts) {
    const P = PRESETS[presetName] || PRESETS.photo;
    const depth = (opts && opts.depth) || P.depth;
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    for (const s of svg.querySelectorAll("style")) s.remove();
    if (P.tiles) for (const e of svg.querySelectorAll(".land,.trees,.rock,.gravel,.cement,.water,#Ground,#Trees,#Rocks,#Pavement,#Base_Terrain,#Water,#Gravel")) e.remove();
    const st = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    st.textContent = `.land{fill:${P.land}} .trees{fill:url(#tm-canopy)} .water{fill:${P.water}} .cement{fill:${P.cement}} .gravel{fill:${P.gravel}} .rock{fill:${P.rock}} .wood{fill:#7a4b1e} .tarmac{fill:${P.road}}
      .building{fill:${P.roofs[0]};stroke:${P.roofEdge};stroke-width:.9} .floor{fill:${P.floor};stroke:${P.roomLine};stroke-width:.8} .locked{fill:#c46a6a} .fence{fill:none;stroke:${P.fence};stroke-width:1}
      .road_tarmac{fill:none;stroke:${P.road}} .road_gravel{fill:none;stroke:${P.gravel === "none" ? "#b39664" : P.gravel}} .road_small{stroke-width:5} .road_medium{stroke-width:8} .road_large{stroke-width:12}
      .railroad{fill:none;stroke:${P.rail};stroke-dasharray:6;stroke-width:3} .powerline{fill:none;stroke:rgba(255,206,0,.5);stroke-width:2;stroke-dasharray:6,6} .map_border{fill:none;stroke:none}
      .danger{fill:red;fill-opacity:.25;stroke:red;stroke-width:2} .task{fill:#000} .stairs{fill:#6fdc7a} .shadow{filter:none} .plane{fill:#fff}`;
    svg.insertBefore(st, svg.firstChild);
    const defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `<pattern id="tm-canopy" patternUnits="userSpaceOnUse" width="7" height="7"><rect width="7" height="7" fill="${P.trees}"/><circle cx="2" cy="2" r="1.6" fill="${P.treeDot}"/><circle cx="5.5" cy="5" r="1.2" fill="${P.treeDot}"/></pattern>`;
    svg.insertBefore(defs, svg.firstChild);
    // Roads: casing under, centre line over.
    for (const roads of svg.querySelectorAll("#Roads,#Normal_Roads,#Highways,#Main_Roads,#High_Roads,#Dirt_Roads")) {
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
    // Buildings: roof colours + extrusion.
    const b = svg.querySelector("#Buildings");
    if (b) {
      let k = 0;
      for (const p of b.querySelectorAll(".building")) p.style.fill = P.roofs[k++ % P.roofs.length];
      for (let i = depth; i >= 1; i--) {
        const c = b.cloneNode(true);
        c.removeAttribute("id");
        c.setAttribute("transform", `translate(${0.4 * i},${0.75 * i})`);
        for (const p of c.querySelectorAll("*")) {
          p.removeAttribute("id");
          p.style.fill = i % 2 ? P.side : P.sideLit;
          p.style.stroke = i === depth ? "rgba(0,0,0,.4)" : "none";
          p.style.strokeWidth = ".6px";
        }
        b.parentNode.insertBefore(c, b);
      }
    }
    return svg;
  }

  /** Only one floor group (rooms), styled, everything else removed — for floors over a photo/RE3MR base. */
  function floorOnly(svgText, groupId) {
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    const g = svg.querySelector("#" + CSS.escape(groupId));
    if (!g) return null;
    for (const s of svg.querySelectorAll("style")) s.remove();
    // keep only the ancestors of g and g itself
    const keep = new Set();
    let n = g;
    while (n && n !== svg) { keep.add(n); n = n.parentNode; }
    const prune = (node) => {
      for (const c of [...node.children]) {
        if (c === g) continue;
        if (keep.has(c)) prune(c); else if (c.tagName !== "defs") c.remove();
      }
    };
    prune(svg);
    const st = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    st.textContent = `.floor{fill:rgba(242,234,216,.85);stroke:#5b4a34;stroke-width:.9} .locked{fill:rgba(196,106,106,.85)} .stairs{fill:#6fdc7a} .building{fill:rgba(242,234,216,.6);stroke:#5b4a34;stroke-width:.9} .shadow{filter:none} *{vector-effect:non-scaling-stroke}`;
    svg.insertBefore(st, svg.firstChild);
    return svg;
  }

  window.TMStyle = { PRESETS, style, floorOnly };
})();
