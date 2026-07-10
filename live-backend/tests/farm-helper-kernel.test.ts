import { describe, expect, it } from "vitest";
import { triangular, weightedQuantile } from "../src/features/farm-helper.js";
import { calibrateProxy, type ProxyCalibration } from "../src/features/farm-helper-key-stats.js";

// Reference unweighted type-7 quantile (matches the private `quantile` in
// farm-helper.ts) so the weighted version can be checked against it.
function unweighted(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

describe("triangular kernel", () => {
  it("peaks at the center and is zero at/after the edges", () => {
    expect(triangular(0, 0.08, 0.15)).toBe(1);
    expect(triangular(-0.08, 0.08, 0.15)).toBe(0);
    expect(triangular(0.15, 0.08, 0.15)).toBe(0);
    expect(triangular(-0.2, 0.08, 0.15)).toBe(0);
    expect(triangular(0.3, 0.08, 0.15)).toBe(0);
  });

  it("falls linearly and is asymmetric between the down and up widths", () => {
    expect(triangular(-0.04, 0.08, 0.15)).toBeCloseTo(0.5, 6);
    expect(triangular(0.075, 0.08, 0.15)).toBeCloseTo(0.5, 6);
    // Same absolute distance weighs more on the wider (up) side.
    expect(triangular(0.05, 0.08, 0.15)).toBeGreaterThan(triangular(-0.05, 0.08, 0.15));
  });
});

describe("weightedQuantile", () => {
  it("reduces to the unweighted type-7 quantile for uniform weights", () => {
    const cases: number[][] = [
      [10, 20],
      [1, 2, 3],
      [5, 1, 9, 3, 7],
      [100, 200, 300, 400],
    ];
    for (const values of cases) {
      for (const q of [0, 0.25, 0.4, 0.5, 0.75, 1]) {
        const pairs = values.map((v) => ({ v, w: 1 }));
        expect(weightedQuantile(pairs, q)).toBeCloseTo(unweighted(values, q), 6);
      }
    }
  });

  it("is invariant to a uniform weight scale", () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6];
    for (const q of [0.1, 0.5, 0.9]) {
      const w1 = weightedQuantile(values.map((v) => ({ v, w: 1 })), q);
      const w7 = weightedQuantile(values.map((v) => ({ v, w: 7 })), q);
      expect(w7).toBeCloseTo(w1, 6);
    }
  });

  it("pulls the median toward heavily weighted values", () => {
    const values = [100, 200, 900];
    const uniform = weightedQuantile(values.map((v) => ({ v, w: 1 })), 0.5);
    expect(uniform).toBeCloseTo(200, 6);
    // Concentrating weight on the low cluster drags the median below the
    // unweighted median toward that cluster.
    const heavyLow = weightedQuantile([{ v: 100, w: 8 }, { v: 200, w: 8 }, { v: 900, w: 1 }], 0.5);
    expect(heavyLow).toBeLessThan(uniform);
    expect(heavyLow).toBeGreaterThan(100);
  });

  it("ignores zero and negative weights, returns 0 on an empty set", () => {
    expect(weightedQuantile([], 0.5)).toBe(0);
    expect(weightedQuantile([{ v: 42, w: 0 }, { v: 99, w: -1 }, { v: 7, w: 2 }], 0.5)).toBe(7);
  });
});

describe("calibrateProxy", () => {
  it("returns identity when there are too few pairs to trust an adjustment", () => {
    const cal: ProxyCalibration = { keyCount: 4, pairs: 10, buckets: null, globalRatio: null, computedAt: "" };
    expect(calibrateProxy(cal, 5000)).toBe(5000);
  });

  it("applies a single global ratio", () => {
    const cal: ProxyCalibration = { keyCount: 4, pairs: 80, buckets: null, globalRatio: 1.2, computedAt: "" };
    expect(calibrateProxy(cal, 5000)).toBeCloseTo(6000, 6);
  });

  it("interpolates ratios across decile bucket centers and clamps outside them", () => {
    const cal: ProxyCalibration = {
      keyCount: 4,
      pairs: 400,
      buckets: [
        { proxyCenter: 1000, ratio: 1.5 },
        { proxyCenter: 3000, ratio: 1.1 },
      ],
      globalRatio: null,
      computedAt: "",
    };
    // Below the first center -> clamp to its ratio.
    expect(calibrateProxy(cal, 500)).toBeCloseTo(500 * 1.5, 6);
    // Halfway between centers -> ratio interpolates to 1.3.
    expect(calibrateProxy(cal, 2000)).toBeCloseTo(2000 * 1.3, 6);
    // Above the last center -> clamp to its ratio.
    expect(calibrateProxy(cal, 5000)).toBeCloseTo(5000 * 1.1, 6);
  });
});
