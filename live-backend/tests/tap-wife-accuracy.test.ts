import { describe, expect, it } from "vitest";
import { estimateTapWifeAccuracy, wife3PointsAt } from "../src/features/tap-wife-accuracy.js";
import { estimateWifeAccuracy, ssrGoalForScore, type SsrChartFacts } from "../src/features/player-skills.js";

const facts: SsrChartFacts = { keyCount: 4, nativeMania: true, rate: 1 };
const statistics = { perfect: 1088, great: 760, good: 241, ok: 43, meh: 17, miss: 42 };
const score = { accuracy: 0.94, type: "solo_score", mods: [], statistics };

describe("tap Wife3 calibration", () => {
  it("matches independent audit anchors, including both sides of 80%", () => {
    expect(estimateTapWifeAccuracy([1088, 760, 241, 43, 17, 42], 8, false)).toBeCloseTo(0.8200260786, 7);
    expect(estimateTapWifeAccuracy([1548, 1221, 265, 72, 43, 77], 8, false)).toBeCloseTo(0.7988379970, 7);
    expect(estimateTapWifeAccuracy([973, 794, 224, 19, 9, 17], 7.6, false)).toBeCloseTo(0.8776246952, 7);
  });

  it("keeps the Wife3 curve and miss penalty, with no SSR floor inside the model", () => {
    expect(wife3PointsAt(0)).toBe(1);
    expect(wife3PointsAt(-5)).toBe(1);
    expect(wife3PointsAt(65)).toBeCloseTo(0, 7);
    expect(wife3PointsAt(180)).toBe(-2.75);
    expect(wife3PointsAt(250)).toBe(-2.75);
    expect(estimateTapWifeAccuracy([0, 0, 0, 0, 0, 100], 8, false)).toBe(-2.75);
    expect(estimateTapWifeAccuracy([100, 0, 0, 0, 0, 0], 8, false)).toBeGreaterThan(0.9999);
  });

  it("refuses malformed counts and unknown OD instead of fitting them", () => {
    for (const od of [NaN, Infinity, -1, 11]) expect(estimateTapWifeAccuracy([100, 0, 0, 0, 0, 0], od, false)).toBeNull();
    for (const counts of [[], [0, 0, 0, 0, 0, 0], [1.5, 0, 0, 0, 0, 0], [-1, 0, 0, 0, 0, 0],
      [Infinity, 0, 0, 0, 0, 0], [Number.MAX_SAFE_INTEGER, 1, 0, 0, 0, 0]]) {
      expect(estimateTapWifeAccuracy(counts, 8, false)).toBeNull();
    }
  });

  it("uses client-specific MAX windows and classic windows for CL", () => {
    const precise = { ...score, statistics: { perfect: 850, great: 140, good: 10 } };
    const stable = ssrGoalForScore({ ...precise, legacy_score_id: 0 }, 0, 6, facts)!;
    const lazer = ssrGoalForScore(precise, 0, 6, facts)!;
    expect(stable).not.toBe(lazer);
    expect(ssrGoalForScore({ ...precise, mods: [{ acronym: "CL" }] }, 0, 6, facts)).toBe(stable);
  });

  it("enforces the existing eligibility floor and cap after fitting", () => {
    expect(estimateWifeAccuracy(statistics, { od: 8 })).toBeLessThan(0.8);
    expect(ssrGoalForScore(score, 0, 8, facts)).toBe(0.8218);
    expect(ssrGoalForScore({ ...score, statistics: { perfect: 1548, great: 1221, good: 265, ok: 72, meh: 43, miss: 77 } }, 0, 8, facts)).toBeNull();
    expect(ssrGoalForScore({ ...score, statistics: { perfect: 1000 } }, 0, 8, facts)).toBe(0.9975);
    expect(ssrGoalForScore({ ...score, statistics: {} }, 0, 8, facts)).toBe(0.8753);
  });

  it("shares calibration across keycounts and keeps chart conversion eligibility separate", () => {
    for (const changed of [undefined, { ...facts, keyCount: 7 }, { ...facts, keyCount: 18 }]) {
      expect(ssrGoalForScore(score, 0, 8, changed)).toBe(ssrGoalForScore(score, 0, 8));
    }
    expect(ssrGoalForScore(score, 0, 8, { ...facts, nativeMania: false })).toBeNull();
    expect(ssrGoalForScore(score, 0, 8, { ...facts, rate: 1.5 })).not.toBeNull();
    for (const lnRatio of [undefined, null, 0.001, 0.5, 1]) {
      expect(ssrGoalForScore(score, lnRatio, 8, facts)).toBe(ssrGoalForScore(score, lnRatio, 8));
    }
    for (const od of [undefined, null, NaN, -1, 11]) {
      expect(ssrGoalForScore(score, 0, od, facts)).toBe(ssrGoalForScore(score, 0, od));
    }
    for (const mods of [undefined, [{ acronym: "DT", settings: { speed_change: 1 } }], [{ acronym: "EZ" }],
      [{ acronym: "HR" }], [{ acronym: "DA" }], [{ acronym: "RD" }], [{ acronym: "SV2" }],
      [{ acronym: "CL", settings: { custom: true } }]]) {
      const changed = { ...score, mods };
      expect(ssrGoalForScore(changed, 0, 8, facts)).toBe(ssrGoalForScore(changed, 0, 8));
    }
    const unknown = { ...score, type: undefined };
    expect(ssrGoalForScore(unknown, 0, 8, facts)).toBe(ssrGoalForScore(unknown, 0, 8));
    const archived = { ...score, wifeScoring: "unknown" as const };
    expect(ssrGoalForScore(archived, 0, 8, facts)).toBe(ssrGoalForScore(archived, 0, 8));
  });

  it("treats the two statistics naming schemes identically", () => {
    const legacyNames = { count_geki: 1088, count_300: 760, count_katu: 241, count_100: 43, count_50: 17, count_miss: 42 };
    expect(ssrGoalForScore({ ...score, statistics: legacyNames }, 0, 8, facts)).toBe(ssrGoalForScore(score, 0, 8, facts));
    // Preserve the uniform estimator's modern-name precedence on mixed payloads.
    expect(ssrGoalForScore({ ...score, statistics: { ...statistics, count_geki: 0 } }, 0, 8, facts))
      .toBe(ssrGoalForScore(score, 0, 8, facts));
  });

  it("stays inside the score bounds allowed by its actual judgment intervals", () => {
    const edges = [0, 16.5, 40.5, 73.5, 103.5, 127.5]; // Native OD8, both clients.
    const samples = [
      ...Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => i === j ? 1000 : 0)),
      [1088, 760, 241, 43, 17, 42], [1, 1, 1, 1, 1, 1], [1, 0, 0, 0, 0, 9999],
    ];
    for (const counts of samples) {
      const total = counts.reduce((sum, count) => sum + count, 0);
      const lower = (counts.slice(0, 5).reduce((sum, count, i) => sum + count * wife3PointsAt(edges[i + 1]), 0) - 2.75 * counts[5]) / total;
      const upper = (counts.slice(0, 5).reduce((sum, count, i) => sum + count * wife3PointsAt(edges[i]), 0) - 2.75 * counts[5]) / total;
      const value = estimateTapWifeAccuracy(counts, 8, false)!;
      expect(value).toBeGreaterThanOrEqual(lower - 1e-10);
      expect(value).toBeLessThanOrEqual(upper + 1e-10);
    }
  });

  it("depends on judgment proportions and varies smoothly with a one-note change", () => {
    const counts = [1298, 903, 233, 28, 11, 15];
    const value = estimateTapWifeAccuracy(counts, 8, false)!;
    const repeated = counts.map((count) => count * 1000);
    expect(estimateTapWifeAccuracy(repeated, 8, false)).toBeCloseTo(value, 7);
    repeated[5] -= 1;
    repeated[4] += 1;
    const improved = estimateTapWifeAccuracy(repeated, 8, false)!;
    expect(improved).toBeGreaterThanOrEqual(value - 1e-7);
    expect(improved - value).toBeLessThan(1e-5);
  });

  it("stays within judgment bounds and never lowers accuracy for an improved judgment", () => {
    let seed = 814903;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const samples = [
      [1298, 903, 233, 28, 11, 15], // Coarse-search regression: miss -> 50.
      [1000, 0, 0, 0, 0, 1], [0, 0, 0, 0, 1, 999], [1, 1, 1, 1, 1, 1],
      ...Array.from({ length: 18 }, () => Array.from({ length: 6 }, () => Math.floor(random() ** 3 * 4000))),
    ];
    for (const od of [0, 5, 6, 7.6, 8, 8.5, 10]) for (const classic of [true, false]) for (const counts of samples) {
      const value = estimateTapWifeAccuracy(counts, od, classic)!;
      expect(value).toBeGreaterThanOrEqual(-2.75);
      expect(value).toBeLessThanOrEqual(1);
      for (let j = 1; j < 6; j += 1) {
        if (counts[j] === 0) continue;
        const improved = [...counts]; improved[j] -= 1; improved[j - 1] += 1;
        const next = estimateTapWifeAccuracy(improved, od, classic)!;
        expect(next, JSON.stringify({ od, classic, counts, improved })).toBeGreaterThanOrEqual(value - 1e-7);
      }
    }
  });
});
