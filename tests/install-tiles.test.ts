import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { interactiveMaps } from "../src/map-data.js";
import { installsFromRegDump, installsFromSteamVdf } from "../src/install.js";
import { localTemplate, localTilePath, tileRanges, tileTemplates } from "../src/tiles.js";

const maps = interactiveMaps(JSON.parse(readFileSync(resolve(__dirname, "..", "data", "maps.json"), "utf8")));
const customs = maps.find((m) => m.key === "customs")!;

describe("install detection parsing", () => {
  it("picks EFT and not Arena from a reg dump", () => {
    const dump = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\...\\Uninstall\\Steam App 1",
      "    DisplayName    REG_SZ    Escape from Tarkov",
      "    InstallLocation    REG_SZ    C:\\Steam\\steamapps\\common\\Escape from Tarkov\\",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\...\\Uninstall\\Arena",
      "    DisplayName    REG_SZ    Escape from Tarkov: Arena",
      "    InstallLocation    REG_SZ    C:\\Battlestate Games\\Escape from Tarkov Arena",
    ].join("\r\n");
    expect(installsFromRegDump(dump)).toEqual(["C:\\Steam\\steamapps\\common\\Escape from Tarkov"]);
  });
  it("reads Steam library folders", () => {
    const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Steam"\n\t}\n}';
    expect(installsFromSteamVdf(vdf)).toEqual(["C:\\Steam\\steamapps\\common\\Escape from Tarkov"]);
  });
});

describe("tiles", () => {
  it("computes tile ranges that grow with zoom", () => {
    const r = tileRanges(customs);
    expect(r[0].z).toBe(customs.minZoom);
    expect(r[r.length - 1].z).toBe(customs.maxZoom);
    for (let i = 1; i < r.length; i++) expect(r[i].x1 - r[i].x0).toBeGreaterThanOrEqual(r[i - 1].x1 - r[i - 1].x0);
  });
  it("mirrors the remote layout locally", () => {
    expect(localTilePath("C:\\cache", customs.tilePath!, 3, 4, 5).replace(/\\/g, "/")).toBe("C:/cache/customs_0.16/main/3/4/5.png");
    expect(localTemplate("C:\\cache", customs.tilePath!)).toBe("file:///C:/cache/customs_0.16/main/{z}/{x}/{y}.png");
    expect(tileTemplates(customs)).toHaveLength(5);
  });
});
