import { describe, expect, it } from "vitest";
import { DEFAULT_HOTKEYS, sanitize, sanitizeHotkeys, DEFAULT_SETTINGS } from "../src/settings.js";

describe("hotkeys", () => {
  it("defaults when nothing is stored (old settings files)", () => {
    expect(sanitizeHotkeys(undefined)).toEqual(DEFAULT_HOTKEYS);
    expect(sanitize({ ...DEFAULT_SETTINGS, hotkeys: undefined as never }).hotkeys).toEqual(DEFAULT_HOTKEYS);
  });
  it("keeps valid accelerators and blanks an explicit off", () => {
    const h = sanitizeHotkeys({ ...DEFAULT_HOTKEYS, ping: "Ctrl+Alt+P", hide: "", interact: "num5" });
    expect(h.ping).toBe("Ctrl+Alt+P");
    expect(h.hide).toBe("");
    expect(h.interact).toBe("num5");
  });
  it("falls back to the default on garbage", () => {
    expect(sanitizeHotkeys({ ...DEFAULT_HOTKEYS, hide: "not a key" }).hide).toBe("F10");
  });
  it("one key cannot drive two actions — the later one is switched off", () => {
    const h = sanitizeHotkeys({ ...DEFAULT_HOTKEYS, opacityUp: "F6" });
    expect(h.ping).toBe("F6");
    expect(h.opacityUp).toBe("");
  });
});

import { isMouseAccel } from "../src/settings.js";
import { HELPER_SCRIPT as HELPER } from "../src/key-sender.js";
describe("mouse-button hotkeys", () => {
  it("Mouse3/4/5 are valid accelerators and flagged as mouse; modifiers are not allowed on them", () => {
    expect(sanitizeHotkeys({ ...DEFAULT_HOTKEYS, ping: "Mouse3" }).ping).toBe("Mouse3");
    expect(sanitizeHotkeys({ ...DEFAULT_HOTKEYS, ping: "Mouse5" }).ping).toBe("Mouse5");
    expect(sanitizeHotkeys({ ...DEFAULT_HOTKEYS, ping: "Mouse2" }).ping).toBe("F6");
    expect(isMouseAccel("Mouse4")).toBe(true);
    expect(isMouseAccel("F6")).toBe(false);
  });
  it("the key helper watches them and reports a press edge", () => {
    expect(HELPER).toMatch(/"hk" \{/);
    expect(HELPER).toContain('"hotkey " + $name');
  });
});
