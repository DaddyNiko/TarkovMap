import { describe, expect, it } from "vitest";
import { LogParser, parseNotification, reduceState, INITIAL_STATE, GameWatcher } from "../src/game-watcher.js";
import { activeQuestIds, applyQuestEvent, bearing, distance2D, insideZone, objectivesOnMap, type QuestBook, type TaskDef } from "../src/quests.js";
import { accepts, decode, encode, foldSquad, pruneSquad, squadTag } from "../src/squad.js";

const NOTE = (kind: string, body: string) =>
  [`2026-09-04 02:48:30.694|1.1.0.1.46911|Info|push-notifications|Got notification | ${kind}`, ...body.split("\n")].join("\n");

describe("multi-line notifications", () => {
  it("parses a quest-started chat message spread over lines", () => {
    const p = new LogParser();
    const text = NOTE("ChatMessageReceived", '{\n  "type": "new_message",\n  "message": {\n    "type": 10,\n    "templateId": "5a27b7a786f774579c3eb376 description"\n  }\n}');
    const evs = text.split("\n").flatMap((l) => p.feed(l));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "quest", questId: "5a27b7a786f774579c3eb376", status: "started" });
  });
  it("maps 12 to finished and 11 to failed, ignores player messages", () => {
    expect(parseNotification("ChatMessageReceived", { message: { type: 12, templateId: "657315df034d76585f032e01 successMessageText" } }, 1)[0]).toMatchObject({ status: "finished" });
    expect(parseNotification("ChatMessageReceived", { message: { type: 11, templateId: "657315df034d76585f032e01 failMessageText" } }, 1)[0]).toMatchObject({ status: "failed" });
    expect(parseNotification("ChatMessageReceived", { message: { type: 1, text: "hi" } }, 1)).toEqual([]);
  });
  it("UserMatchOver ends the raid with its location", () => {
    const p = new LogParser();
    const text = NOTE("UserMatchOver", '{\n  "type": "UserMatchOver",\n  "location": "bigmap",\n  "shortId": "AB12CD"\n}');
    const evs = text.split("\n").flatMap((l) => p.feed(l));
    expect(evs[0]).toEqual({ type: "ended", location: "bigmap", mapKey: "customs" });
  });
  it("GameStarted stamps the raid start from the log line time", () => {
    const w = new GameWatcher({ logsDir: "C:/nowhere" });
    w.ingest("2026-09-04 02:39:06.202|1.1.0.1.46911|Info|application|GameStarted:118.06(9.58) real:128.21(12.03) diff:10.15\n");
    expect(w.state.raid).toBe("in-raid");
    expect(w.state.raidStartedAt).toBe(new Date("2026-09-04T02:39:06").getTime());
  });
  it("side comes from Session mode", () => {
    const s = reduceState(INITIAL_STATE, { type: "side", side: "scav" });
    expect(s.side).toBe("scav");
  });
});

describe("quest book", () => {
  const T: TaskDef[] = [
    { id: "q1", name: "Shortcut", trader: { id: "54cb50c76803fa8b248b4571", name: "Prapor" }, map: { normalizedName: "customs" }, objectives: [
      { id: "o1", type: "mark", description: "Place the MS2000 at the tunnel", maps: [{ normalizedName: "customs" }], zones: [{ position: { x: 230, y: 1, z: 90 }, map: { normalizedName: "customs" } }] },
    ] },
    { id: "q2", name: "Debut", trader: { id: "54cb50c76803fa8b248b4571", name: "Prapor" }, map: null, objectives: [
      { id: "o2", type: "shoot", description: "Eliminate 5 scavs", maps: [] },
    ] },
    { id: "q3", name: "Golden Swag", trader: { id: "58330581ace78e27b8b10cee", name: "Skier" }, map: { normalizedName: "customs" }, objectives: [
      { id: "o3", type: "plantItem", description: "Plant the lighter in Dorm 206", maps: [{ normalizedName: "customs" }], zones: [{ position: { x: 206, y: 4, z: 166 } }] },
    ] },
  ];
  it("keeps started quests, drops finished ones, honours event order", () => {
    let b: QuestBook = {};
    b = applyQuestEvent(b, { type: "quest", questId: "q1", status: "started", at: 1 });
    b = applyQuestEvent(b, { type: "quest", questId: "q3", status: "started", at: 2 });
    b = applyQuestEvent(b, { type: "quest", questId: "q2", status: "started", at: 3 });
    b = applyQuestEvent(b, { type: "quest", questId: "q2", status: "finished", at: 4 });
    b = applyQuestEvent(b, { type: "quest", questId: "q3", status: "finished", at: 1 }); // stale, ignored
    expect(activeQuestIds(b).sort()).toEqual(["q1", "q3"]);
    const objs = objectivesOnMap(b, T, "customs");
    expect(objs.map((o) => o.questName).sort()).toEqual(["Golden Swag", "Shortcut"]);
    expect(objs[0].trader.portrait).toMatch(/assets\.tarkov\.dev\/54cb50c76803fa8b248b4571\.webp$/);
    expect(objectivesOnMap(b, T, "woods")).toEqual([]);
  });
  it("manual done hides a quest", () => {
    const b = applyQuestEvent({}, { type: "quest", questId: "q1", status: "started", at: 1 });
    expect(objectivesOnMap(b, T, "customs", new Set(["q1"]))).toEqual([]);
  });
  it("distance, bearing and zone entry", () => {
    expect(distance2D({ x: 0, z: 0 }, { x: 3, z: 4 })).toBe(5);
    expect(bearing({ x: 0, z: 0 }, { x: 0, z: 10 })).toBeCloseTo(0);
    expect(bearing({ x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(90);
    expect(insideZone({ x: 231, z: 92 }, { position: { x: 230, y: 0, z: 90 } })).toBe(true);
    expect(insideZone({ x: 250, z: 92 }, { position: { x: 230, y: 0, z: 90 } })).toBe(false);
    const sq = { position: { x: 0, y: 0, z: 0 }, outline: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }] };
    expect(insideZone({ x: 1, z: 1 }, sq)).toBe(true);
    expect(insideZone({ x: 9, z: 1 }, sq)).toBe(false);
  });
});

describe("squad wire", () => {
  const tag = squadTag("WOLF-7");
  it("round-trips and gates on squad, raid and self", () => {
    const fix = { kind: "fix" as const, squad: tag, raidId: "R1", name: "Dex", x: 1, y: 2, z: 3, yaw: 90, floor: null, at: 5 };
    const back = decode(encode(fix));
    expect(back).toMatchObject(fix);
    expect(accepts(fix, tag, "R1", "Niko")).toBe(true);
    expect(accepts(fix, tag, "R2", "Niko")).toBe(false);
    expect(accepts(fix, squadTag("other"), "R1", "Niko")).toBe(false);
    expect(accepts(fix, tag, "R1", "Dex")).toBe(false);
    expect(decode(Buffer.from("garbage"))).toBeNull();
    expect(decode(Buffer.from('{"v":1,"kind":"fix","squad":"x","name":"n","x":"no"}'))).toBeNull();
  });
  it("folds fixes into mates with a moving flag, and expires pings", () => {
    let s = foldSquad({ mates: {}, pings: [] }, { kind: "fix", squad: tag, raidId: "R1", name: "Dex", x: 0, y: 0, z: 0, yaw: 0, floor: "2F", at: 1000 });
    s = foldSquad(s, { kind: "fix", squad: tag, raidId: "R1", name: "Dex", x: 5, y: 0, z: 0, yaw: 0, floor: "2F", at: 3000 });
    expect(s.mates.Dex.moving).toBe(true);
    s = foldSquad(s, { kind: "ping", squad: tag, raidId: "R1", name: "Dex", x: 1, y: 0, z: 1, text: "regroup", at: 1000, ttlMs: 500 }, 1200);
    expect(s.pings).toHaveLength(1);
    expect(pruneSquad(s, 2000, 60000).pings).toHaveLength(0);
    expect(Object.keys(pruneSquad(s, 3000 + 61000).mates)).toHaveLength(0);
  });
});

describe("filter prompt", () => {
  it("understands layers, money and only/hide", async () => {
    const { parseFilterPrompt } = await import("../src/filter-prompt.js");
    const a = parseFilterPrompt("show extracts, dorm keys and anything over 40k");
    expect(a.on).toEqual(expect.arrayContaining(["extracts", "keys", "loot"]));
    expect(a.fleaMin).toBe(40000);
    expect(a.understood).toBe(true);
    const b = parseFilterPrompt("hide scavs and bosses");
    expect(b.off).toEqual(expect.arrayContaining(["scavs", "bosses"]));
    expect(b.on).toEqual([]);
    const c = parseFilterPrompt("only quests");
    expect(c.on).toEqual(["quests"]);
    expect(c.off).toContain("extracts");
    expect(parseFilterPrompt("blorp the frobnicator").understood).toBe(false);
    expect(parseFilterPrompt("where is fusion").find).toBe("fusion");
  });
});
