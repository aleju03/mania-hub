import { describe, expect, it } from "vitest";
import { estimateManiaWifeAccuracy, estimateManiaWifeAccuracyFromAccuracy, type WifeCalibrationOptions } from "../src/features/wife-calibration.js";
import { maniaTimingEdges } from "../src/features/tap-wife-accuracy.js";
import { calibrateScoreForMsd, ssrGoalForScore } from "../src/features/player-skills.js";

const counts = [1088, 760, 241, 43, 17, 42];
const profile: WifeCalibrationOptions = { od: 8, scoring: "lazer", holdRatio: 0, rate: 1 };

describe("unified mania Wife calibration", () => {
  it("matches the independent constrained fit and shares its tap anchor across clients", () => {
    expect(estimateManiaWifeAccuracy(counts, profile)).toBeCloseTo(0.82177714, 6);
    expect(estimateManiaWifeAccuracy(counts, { ...profile, scoring: "stable" }))
      .toBe(estimateManiaWifeAccuracy(counts, profile));
  });

  it("normalizes DT/HT/custom windows to real time and applies difficulty mods once", () => {
    expect(maniaTimingEdges(8, true, { rate: 1.5 })).toEqual([24.5 / 1.5, 60.5 / 1.5, 109.5 / 1.5, 154.5 / 1.5, 190.5 / 1.5]);
    for (const rate of [0.5, 0.75, 1.25, 1.5, 1.75, 2]) {
      const value = estimateManiaWifeAccuracy(counts, { ...profile, rate })!;
      expect(Math.abs(value - estimateManiaWifeAccuracy(counts, profile)!)).toBeLessThan(0.003);
    }
    expect(estimateManiaWifeAccuracy(counts, { ...profile, windowScale: 1.4 }))
      .toBeLessThan(estimateManiaWifeAccuracy(counts, profile)!);
    expect(estimateManiaWifeAccuracy(counts, { ...profile, windowScale: 1 / 1.4 }))
      .toBeGreaterThan(estimateManiaWifeAccuracy(counts, profile)!);
  });

  it("models combined stable holds and separate lazer/SV2 tails without a raw-accuracy blend", () => {
    for (const scoring of ["stable", "lazer", "stable-scorev2"] as const) for (const rate of [0.75, 1, 1.5]) {
      expect(estimateManiaWifeAccuracy([2000, 0, 0, 0, 0, 0], { od: 8, rate, scoring, holdRatio: 1 })).toBeGreaterThan(0.999);
      expect(estimateManiaWifeAccuracy([0, 0, 0, 0, 0, 2000], { od: 8, rate, scoring, holdRatio: 1 })).toBe(-5);
      const value = estimateManiaWifeAccuracy(counts, { od: 8, rate, scoring, holdRatio: 0.6 });
      expect(value).not.toBeNull();
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("rejects invalid inputs without inventing a rating", () => {
    expect(estimateManiaWifeAccuracy([], profile)).toBeNull();
    expect(estimateManiaWifeAccuracy([0, 0, 0, 0, 0, 0], profile)).toBeNull();
    for (const rate of [0, -1, NaN, Infinity]) expect(estimateManiaWifeAccuracy(counts, { ...profile, rate })).toBeNull();
    for (const holdRatio of [-1, 2, NaN]) expect(estimateManiaWifeAccuracy(counts, { ...profile, holdRatio })).toBeNull();
  });

  it("converts accuracy-only history monotonically rather than passing raw accuracy through", () => {
    for (const scoring of ["stable", "lazer", "stable-scorev2"] as const)
      for (const target of ["press", "ln"] as const) for (const rate of [0.75, 1, 1.5]) for (const holdRatio of [0, 0.15, 0.5, 1]) {
        const options = { ...profile, scoring, target, rate, holdRatio };
        let previous = -Infinity;
        for (let i = 0; i <= 100; i += 1) {
          const value = estimateManiaWifeAccuracyFromAccuracy(i / 100, options)!;
          expect(value).toBeGreaterThanOrEqual(previous);
          expect(value).toBeLessThanOrEqual(1);
          previous = value;
        }
      }
    expect(estimateManiaWifeAccuracyFromAccuracy(0.94, profile)).not.toBe(0.94);
    for (const accuracy of [-1, 1.01, NaN, Infinity]) expect(estimateManiaWifeAccuracyFromAccuracy(accuracy, profile)).toBeNull();
  });

  it("keeps press quality separate from release-aware LN performance", () => {
    const score = { type: "solo_score", accuracy: 0.99, mods: [],
      statistics: { perfect: 1000, great: 350, good: 30, ok: 10, meh: 4, miss: 6 } };
    const ln = calibrateScoreForMsd(score, 1, 8);
    expect(ln.goal).toBeGreaterThan(ln.lnGoal!);
    const tap = calibrateScoreForMsd(score, 0, 8);
    expect(tap.goal).toBe(tap.lnGoal);
    expect(estimateManiaWifeAccuracy([0, 0, 0, 0, 0, 100], { ...profile, holdRatio: 1, target: "ln" })).toBe(-2.75);
  });

  it.each(Array.from({ length: 15 }, (_, i) => i + 4))("routes %iK DT taps and LN counts through the same calibration", (keyCount) => {
    const statistics = { perfect: 1000, great: 350, good: 30, ok: 10, meh: 4, miss: 6 };
    const score = { type: "solo_score", accuracy: 0.99, mods: [{ acronym: "DT" }], statistics };
    for (const holdRatio of [0, 0.1, 1]) {
      const expected = estimateManiaWifeAccuracy([1000, 350, 30, 10, 4, 6], { od: 8, scoring: "lazer", rate: 1.5, holdRatio })!;
      const rounded = Math.round(Math.min(0.9975, expected) * 10000) / 10000;
      expect(ssrGoalForScore(score, holdRatio, 8, { keyCount, nativeMania: true, rate: 1.5 })).toBe(rounded > 0.8 ? rounded : null);
    }
  });

  it("keeps score improvements monotone across clients, rates and hold shares", () => {
    const samples = [[700, 220, 55, 15, 5, 5], [400, 300, 180, 50, 25, 45], [990, 5, 2, 1, 1, 1]];
    for (const target of ["press", "ln"] as const) for (const scoring of ["stable", "lazer", "stable-scorev2"] as const) for (const od of [6, 8, 10])
      for (const rate of [0.75, 1, 1.5]) for (const holdRatio of [0.01, 0.5, 1]) for (const original of samples) {
        const options = { scoring, od, rate, holdRatio, target };
        const value = estimateManiaWifeAccuracy(original, options)!;
        expect(value).toBeGreaterThanOrEqual(-2.75 - 2.25 * holdRatio);
        expect(value).toBeLessThanOrEqual(1);
        for (let j = 1; j < 6; j += 1) {
          const improved = [...original]; improved[j] -= 1; improved[j - 1] += 1;
          const next = estimateManiaWifeAccuracy(improved, options)!;
          expect(next, JSON.stringify({ options, original, judgment: j, delta: next - value })).toBeGreaterThanOrEqual(value - 1e-7);
        }
      }
  });
});
