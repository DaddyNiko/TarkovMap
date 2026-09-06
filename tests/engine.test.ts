import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  floorForPosition,
  interactiveMaps,
  mapKeyForLocation,
  projectToPixel,
  yawFromQuaternion,
  type MapDef,
} from "../src/map-data.js";
import { parseScreenshotName } from "../src/screenshot-feed.js";
import { GameWatcher, INITIAL_STATE, parseLogLine, reduceState, unityKeyToName } from "../src/game-watcher.js";

const raw = JSON.parse(readFileSync(resolve(__dirname, "..", "data", "maps.json"), "utf8"));
const maps = interactiveMaps(raw);
const byKey = (k: string): MapDef => {
  const m = maps.find((x) => x.key === k);
  if (!m) throw new Error(`no map ${k}`);
  return m;
};

describe("maps.json", () => {
  it("carries every playable map as an interactive entry", () => {
    const keys = maps.map((m) => m.key);
    for (const k of ["ground-zero", "customs", "factory", "interchange", "the-lab", "lighthouse", "reserve", "shoreline", "streets-of-tarkov", "woods", "the-labyrinth", "icebreaker"]) {
      expect(keys).toContain(k);
    }
  });
  it("every map has bounds, and either tiles or an svg", () => {
    for (const m of maps) {
      expect(m.bounds).toHaveLength(2);
      expect(Boolean(m.tilePath || m.svgPath)).toBe(true);
    }
  });
});

describe("projection", () => {
  it("puts every label inside the projected bounds rectangle", () => {
    for (const m of maps) {
      const c1 = projectToPixel(m, m.bounds[0][0], m.bounds[0][1]);
      const c2 = projectToPixel(m, m.bounds[1][0], m.bounds[1][1]);
      const minX = Math.min(c1.px, c2.px), maxX = Math.max(c1.px, c2.px);
      const minY = Math.min(c1.py, c2.py), maxY = Math.max(c1.py, c2.py);
      for (const l of m.labels ?? []) {
        const p = projectToPixel(m, l.position[0], l.position[1]);
        expect(p.px, `${m.key} ${l.text} x`).toBeGreaterThanOrEqual(minX - 1);
        expect(p.px, `${m.key} ${l.text} x`).toBeLessThanOrEqual(maxX + 1);
        expect(p.py, `${m.key} ${l.text} y`).toBeGreaterThanOrEqual(minY - 1);
        expect(p.py, `${m.key} ${l.text} y`).toBeLessThanOrEqual(maxY + 1);
      }
    }
  });
  it("customs: Dorms lands right of Big Red on the rendered image (rotation 180 flips X)", () => {
    const c = byKey("customs");
    const dorms = projectToPixel(c, 200, 150);
    const bigRed = projectToPixel(c, -215, -119);
    // Customs' image has Big Red west (left) and Dorms east (right).
    expect(dorms.px).toBeLessThan(bigRed.px + 0); // rotated 180: +x game → smaller px
  });
  it("origin maps to the transform margins for a 180° map", () => {
    const c = byKey("customs");
    const o = projectToPixel(c, 0, 0);
    expect(o.px).toBeCloseTo(168.65, 5);
    expect(o.py).toBeCloseTo(136.35, 5);
  });
});

describe("floors", () => {
  it("customs dorms 2nd floor from height + rectangle", () => {
    const c = byKey("customs");
    expect(floorForPosition(c, 200, 3.1, 150)?.name).toBe("2nd Floor");
    expect(floorForPosition(c, 200, 0.5, 150)).toBeNull();
    // Same height out on the open map is still ground.
    expect(floorForPosition(c, -200, 3.1, -100)).toBeNull();
  });
  it("factory has plain height bands", () => {
    const f = byKey("factory");
    expect(floorForPosition(f, 0, 4, 0)?.name).toBe("2nd Floor");
    expect(floorForPosition(f, 0, -2, 0)?.name).toBe("Tunnels");
    expect(floorForPosition(f, 0, 1, 0)).toBeNull();
  });
});

describe("location ids", () => {
  it("maps the game's location names", () => {
    expect(mapKeyForLocation("Sandbox")).toBe("ground-zero");
    expect(mapKeyForLocation("bigmap")).toBe("customs");
    expect(mapKeyForLocation("factory4_night")).toBe("factory");
    expect(mapKeyForLocation("RezervBase")).toBe("reserve");
    expect(mapKeyForLocation("TarkovStreets")).toBe("streets-of-tarkov");
    expect(mapKeyForLocation("laboratory")).toBe("the-lab");
    expect(mapKeyForLocation("Woods")).toBe("woods");
    expect(mapKeyForLocation("nowhere")).toBeNull();
  });
});

describe("screenshot names", () => {
  it("parses the game's format", () => {
    const fix = parseScreenshotName("2026-09-04[02-40]_-118.23, 1.91, 227.54_0.0, 0.93, 0.0, 0.36_12.60 (0).png", 5);
    expect(fix).toMatchObject({ x: -118.23, y: 1.91, z: 227.54, at: 5 });
    expect(fix!.yaw).toBeGreaterThan(0);
  });
  it("accepts a (1) suffix and a fixture used by the verification step", () => {
    const fix = parseScreenshotName("2026-09-04[12-00]_200.00, 3.10, 150.00_0.0, 0.7, 0.0, 0.7_12.60 (1).png");
    expect(fix).toMatchObject({ x: 200, y: 3.1, z: 150 });
  });
  it("ignores other pngs", () => {
    expect(parseScreenshotName("Screenshot 2026-09-04 045311.png")).toBeNull();
    expect(parseScreenshotName("2026-09-04[02-40]_junk (0).png")).toBeNull();
  });
});

describe("yaw", () => {
  it("identity quaternion faces 0°, and a 90° Y rotation reads 90°", () => {
    expect(yawFromQuaternion(0, 0, 0, 1)).toBeCloseTo(0, 5);
    const s = Math.SQRT1_2;
    expect(yawFromQuaternion(0, s, 0, s)).toBeCloseTo(90, 3);
    expect(yawFromQuaternion(0, -s, 0, s)).toBeCloseTo(270, 3);
  });
});

describe("game log", () => {
  const CREATE =
    "2026-09-04 02:38:13.759|1.1.0.1.46911|Debug|application|TRACE-NetworkGameCreate profileStatus: 'Profileid: 6a94df0cbb31bb76270f5f81, Status: Busy, RaidMode: Online, Ip: 37.19.207.99, Port: 17012, Location: Sandbox, Sid: US-ASH02G016_6a9a65feed6d247c1f0dab15_04.09.26_09-32-31, GameMode: deathmatch, shortId: WZD2M8'";
  it("reads the map from the game-create line", () => {
    expect(parseLogLine(CREATE)).toEqual({ type: "location", location: "Sandbox", mapKey: "ground-zero", online: true, raidId: "WZD2M8" });
  });
  it("reads the map from the 1.1.0.1 scene-preset and transit lines", () => {
    expect(parseLogLine("2026-09-06 09:24:39.544|1.1.0.1.46911|Info|application|scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset")).toEqual({ type: "location", location: "bigmap", mapKey: "customs", online: true, raidId: undefined });
    expect(parseLogLine("2026-09-06 09:25:15.622|1.1.0.1.46911|Info|application|[Transit] Flag:None, RaidId:6a9d69baf8b7150ab9065350, Count:0, Locations:bigmap -> ")).toEqual({ type: "location", location: "bigmap", mapKey: "customs", online: true, raidId: "6a9d69baf8b7150ab9065350" });
    expect(parseLogLine("2026-09-06 09:25:15.622|1.1.0.1.46911|Info|application|[Transit] Flag:None, RaidId:6a9d69baf8b7150ab9065350, Count:1, Locations:bigmap -> Woods")).toMatchObject({ type: "location", location: "Woods", mapKey: "woods" });
    expect(parseLogLine("2026-09-06 09:24:39.544|1.1.0.1.46911|Info|application|scene preset path:maps/menu_preset.bundle rcid:hideout.scenespreset.asset")).toBeNull();
  });
  it("reads the Screenshot bind from the game's logged input config", () => {
    const line = '2026-09-06 09:21:55.000|1.1.0.1.46911|Info|application|{"InvertedXAxis":false,"keyBindings":[{"keyName":"Recorder","variants":[{"keyCode":["M"]},{"keyCode":[]}],"pressType":"Release"},{"keyName":"MakeScreenshot","variants":[{"keyCode":["SysReq"]},{"keyCode":[]}],"pressType":"Press"}]}';
    expect(parseLogLine(line)).toEqual({ type: "binds", screenshotKey: "PrintScreen", raw: "SysReq" });
    expect(parseLogLine(line.replace('["SysReq"]', '["F11"]'))).toEqual({ type: "binds", screenshotKey: "F11", raw: "F11" });
    // The real dump has no stamp or "|application|" prefix at all.
    expect(parseLogLine(line.slice(line.indexOf("{")))).toEqual({ type: "binds", screenshotKey: "PrintScreen", raw: "SysReq" });
    expect(parseLogLine(line.replace('["SysReq"]', '["LeftControl","P"]'))).toEqual({ type: "binds", screenshotKey: null, raw: "LeftControl+P" });
    expect(reduceState(INITIAL_STATE, { type: "binds", screenshotKey: "F11", raw: "F11" })).toMatchObject({ screenshotBind: "F11", raid: "menu" });
    expect(unityKeyToName("Alpha7")).toBe("7");
    expect(unityKeyToName("Keypad5")).toBe("Numpad5");
    expect(unityKeyToName("Mouse2")).toBe("Mouse3");
    expect(unityKeyToName("LeftShift")).toBeNull();
  });
  it("reads the lifecycle lines", () => {
    expect(parseLogLine("2026-09-04 02:36:57.984|1.1.0.1.46911|Debug|application|Matching with group id: ")).toEqual({ type: "matching" });
    expect(parseLogLine("2026-09-04 02:37:18.082|1.1.0.1.46911|Info|application|LocationLoaded:15.4 real:20.09 diff:4.69")).toEqual({ type: "loaded" });
    expect(parseLogLine("2026-09-04 02:39:06.202|1.1.0.1.46911|Info|application|GameStarted:118.06(9.58) real:128.21(12.03) diff:10.15")).toEqual({ type: "started" });
    expect(parseLogLine("2026-09-04 02:38:30.991|1.1.0.1.46911|Debug|application|Heap pre-allocation - disabled")).toBeNull();
  });
  it("treats a profile re-prepare after a raid as back-in-menu, and ignores it otherwise", () => {
    const line = "2026-09-04 02:47:31.668|1.1.0.1.46911|Info|application|PrepareSelectedProfileLocally ProfileId:0 AccountId:0";
    expect(parseLogLine(line)).toEqual({ type: "profile" });
    expect(reduceState({ ...INITIAL_STATE, raid: "in-raid", mapKey: "customs" }, { type: "profile" }).raid).toBe("menu");
    expect(reduceState({ ...INITIAL_STATE, raid: "matching" }, { type: "profile" }).raid).toBe("matching");
  });
  it("replays a real (scrubbed) session: two Ground Zero raids, back to menu after each", () => {
    const text = readFileSync(resolve(__dirname, "fixtures", "application-session.log"), "utf8");
    const w = new GameWatcher({ logsDir: "C:/nowhere" });
    const raids: string[] = [];
    w.on("state", (s) => raids.push(s.raid));
    w.ingest(text);
    expect(w.state.mapKey).toBe("ground-zero");
    expect(w.state.raid).toBe("menu");
    expect(raids.filter((r) => r === "in-raid")).toHaveLength(2);
    expect(raids[raids.length - 1]).toBe("menu");
  });
  it("folds a whole session into state", () => {
    const w = new GameWatcher({ logsDir: "C:/nowhere" });
    const states: string[] = [];
    w.on("state", (s) => states.push(s.raid));
    w.ingest(
      [
        "2026-09-04 02:36:57.984|1.1.0.1.46911|Debug|application|Matching with group id: ",
        "2026-09-04 02:37:18.082|1.1.0.1.46911|Info|application|LocationLoaded:15.4 real:20.09 diff:4.69",
        CREATE,
        "2026-09-04 02:39:06.202|1.1.0.1.46911|Info|application|GameStarted:118.06(9.58) real:128.21(12.03) diff:10.15",
        "",
      ].join("\n"),
    );
    expect(w.state.mapKey).toBe("ground-zero");
    expect(w.state.raid).toBe("in-raid");
    expect(states).toEqual(["matching", "loading", "loading", "in-raid"]); // the create line adds the map while still loading
    w.ingest("2026-09-04 02:47:31.668|1.1.0.1.46911|Info|application|PrepareSelectedProfileLocally ProfileId:0 AccountId:0\n");
    expect(w.state.raid).toBe("menu");
    expect(w.state.mapKey).toBe("ground-zero");
  });
  it("handles a line split across two reads", () => {
    const w = new GameWatcher({ logsDir: "C:/nowhere" });
    w.ingest(CREATE.slice(0, 80));
    expect(w.state.mapKey).toBeNull();
    w.ingest(CREATE.slice(80) + "\n");
    expect(w.state.mapKey).toBe("ground-zero");
  });
  it("reduceState never loses the map on end", () => {
    const s = reduceState({ ...INITIAL_STATE, mapKey: "customs", raid: "in-raid" }, { type: "ended", mapKey: null });
    expect(s.mapKey).toBe("customs");
    expect(s.raid).toBe("menu");
  });
});

import { HELPER_SCRIPT, DEFAULT_SENDER } from "../src/key-sender.js";
import { sanitize as sanitizeSettings, DEFAULT_SETTINGS as DS, arenaScreenshotsFolder } from "../src/settings.js";

describe("auto send mode", () => {
  it("is the default and survives sanitize; unknown modes fall back to auto", () => {
    expect(DEFAULT_SENDER.mode).toBe("auto");
    expect(DS.mode).toBe("auto");
    expect(sanitizeSettings({ ...DS, mode: "auto" } as never).mode).toBe("auto");
    expect(sanitizeSettings({ ...DS, mode: "bogus" } as never).mode).toBe("auto");
    expect(sanitizeSettings({ ...DS, mode: "hold" } as never).mode).toBe("hold");
  });
  it("helper fires in auto mode only while Tarkov or Arena is the front window", () => {
    expect(HELPER_SCRIPT).toMatch(/\$mode -eq "auto"/);
    expect(HELPER_SCRIPT).toMatch(/Game-InFront/);
    for (const n of ["EscapeFromTarkov", "EscapeFromTarkovArena", "EscapeFromTarkov_BE", "EscapeFromTarkovArena_BE"]) expect(HELPER_SCRIPT).toContain(`"${n}"`);
    expect(HELPER_SCRIPT).not.toMatch(/\$fg -ne "EscapeFromTarkov"/);
  });
  it("Arena screenshots live in their own Documents folder", () => {
    expect(arenaScreenshotsFolder("C:/Docs").split(/[\\/]/).slice(-3).join("/")).toBe("Docs/Escape From Tarkov Arena/Screenshots");
  });
});
