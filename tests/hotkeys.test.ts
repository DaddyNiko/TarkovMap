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
