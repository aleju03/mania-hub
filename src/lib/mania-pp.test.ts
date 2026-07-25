import { describe, expect, it } from "vitest";
import { calculateManiaCustomAccuracy, calculateManiaPp, getManiaPpModMultiplier } from "./mania-pp";
import type { ManiaPpCounts } from "./mania-pp";

function counts(partial: Partial<ManiaPpCounts>): ManiaPpCounts {
  return { perfect: 0, great: 0, good: 0, ok: 0, meh: 0, miss: 0, ...partial };
}

describe("calculateManiaCustomAccuracy", () => {
  it("weights judgements 320/300/200/100/50", () => {
    expect(calculateManiaCustomAccuracy(counts({ perfect: 900, great: 80, good: 10, ok: 5, meh: 3, miss: 2 })))
      .toBeCloseTo(0.98328125, 12);
  });

  it("is 1 for an all-MAX score and 0 with no judgements", () => {
    expect(calculateManiaCustomAccuracy(counts({ perfect: 500 }))).toBe(1);
    expect(calculateManiaCustomAccuracy(counts({}))).toBe(0);
  });
});

describe("calculateManiaPp", () => {
  it("matches the lazer formula for an SS", () => {
    // 8 * (5 - 0.15)^2.2 * 1 * (1 + 0.1 * 1000/1500)
    expect(calculateManiaPp({ starRating: 5, counts: counts({ perfect: 1000 }) }))
      .toBeCloseTo(275.264709230941, 8);
  });

  it("matches the lazer formula for a mixed score", () => {
    expect(calculateManiaPp({ starRating: 4.2, counts: counts({ perfect: 900, great: 80, good: 10, ok: 5, meh: 3, miss: 2 }) }))
      .toBeCloseTo(169.67107214183224, 8);
  });

  it("caps the length bonus at 1500 total hits", () => {
    const at1500 = calculateManiaPp({ starRating: 5, counts: counts({ perfect: 1500 }) });
    const at2000 = calculateManiaPp({ starRating: 5, counts: counts({ perfect: 2000 }) });
    expect(at2000).toBe(at1500);
    expect(at2000).toBeCloseTo(283.8667313944079, 8);
  });

  it("awards nothing at or below 80% custom accuracy", () => {
    // 500 MAX + 500 misses = exactly 50% custom accuracy.
    expect(calculateManiaPp({ starRating: 6, counts: counts({ perfect: 500, miss: 500 }) })).toBe(0);
    // 1000 Ok = 100/320 custom accuracy.
    expect(calculateManiaPp({ starRating: 6, counts: counts({ ok: 1000 }) })).toBe(0);
  });

  it("returns 0 before any judgement", () => {
    expect(calculateManiaPp({ starRating: 7.2, counts: counts({}) })).toBe(0);
  });

  it("applies the mod multiplier linearly", () => {
    const base = calculateManiaPp({ starRating: 5, counts: counts({ perfect: 1000 }) });
    const eased = calculateManiaPp({ starRating: 5, counts: counts({ perfect: 1000 }), modMultiplier: 0.5 });
    expect(eased).toBeCloseTo(base * 0.5, 12);
  });
});

describe("getManiaPpModMultiplier", () => {
  it("only NF and EZ scale mania pp", () => {
    expect(getManiaPpModMultiplier([])).toBe(1);
    expect(getManiaPpModMultiplier(["DT", "HD", "MR"])).toBe(1);
    expect(getManiaPpModMultiplier(["NF"])).toBe(0.75);
    expect(getManiaPpModMultiplier(["EZ"])).toBe(0.5);
    expect(getManiaPpModMultiplier(["NF", "EZ"])).toBe(0.375);
  });

  it("normalizes case and ignores duplicates", () => {
    expect(getManiaPpModMultiplier(["nf"])).toBe(0.75);
    expect(getManiaPpModMultiplier(["NF", "NF"])).toBe(0.75);
  });
});
