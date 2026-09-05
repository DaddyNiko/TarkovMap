import { describe, expect, it } from "vitest";
import { fitAffine, project, unproject, pxPerMetre, residuals, register, pyramidLevels, tilesAt, type ControlPoint } from "../src/re3mr.js";

describe("re3mr registration", () => {
  it("recovers an exact affine from clean points", () => {
    const truth = { ax: -8, bx: 0.3, cx: 3800, ay: 0.2, by: 8.2, cy: 2100 };
    const pts: ControlPoint[] = [[0, 0], [200, 150], [-200, -200], [400, 30], [50, -60], [-70, 10]].map(([x, z]) => [x, z, truth.ax * x + truth.bx * z + truth.cx, truth.ay * x + truth.by * z + truth.cy]);
    const a = fitAffine(pts);
    for (const k of Object.keys(truth) as Array<keyof typeof truth>) expect(a[k]).toBeCloseTo(truth[k], 6);
    expect(residuals(a, pts).every((r) => r < 1e-6)).toBe(true);
    expect(pxPerMetre(a)).toBeCloseTo(Math.sqrt(8 * 8.2 + 0.3 * 0.2), 6);
    const [x, z] = unproject(a, ...project(a, 123, -45));
    expect(x).toBeCloseTo(123, 6);
    expect(z).toBeCloseTo(-45, 6);
  });
  it("reports mean error in metres from noisy points", () => {
    const pts: ControlPoint[] = [[0, 0, 100, 100], [100, 0, 900, 100], [0, 100, 100, 900], [100, 100, 910, 890]];
    const reg = register("customs", 2000, 2000, pts);
    expect(reg.pxPerM).toBeCloseTo(8, 0);
    expect(reg.errorM).toBeGreaterThan(0);
    expect(reg.errorM).toBeLessThan(2);
  });
  it("refuses degenerate input", () => {
    expect(() => fitAffine([[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2]])).toThrow();
    expect(() => fitAffine([[0, 0, 0, 0], [1, 1, 1, 1]])).toThrow();
  });
  it("builds a pyramid that covers the image at every level", () => {
    const w = 7832, h = 5016;
    const max = pyramidLevels(w, h);
    expect(max).toBe(5); // 256·2^5 = 8192 ≥ 7832
    const top = tilesAt(w, h, 0, max);
    expect(top).toHaveLength(1);
    expect(top[0].sw).toBe(w);
    const full = tilesAt(w, h, max, max);
    expect(full.length).toBe(Math.ceil(w / 256) * Math.ceil(h / 256));
    expect(full[full.length - 1].sw).toBe(w - 256 * (Math.ceil(w / 256) - 1));
  });
});
