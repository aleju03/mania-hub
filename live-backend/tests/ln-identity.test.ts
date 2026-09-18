import { describe, expect, it } from "vitest";
import { LN_EFFECTIVE_MIN_RATIO } from "../src/dan/dan-estimator/ln-effective.js";
import { LN_RATING_IDENTITY_MARGIN, lnRatingIdentityUndecided, resolveChartLnIdentity, resolveLnIdentityShare } from "../src/dan/ln-identity.js";

describe("LN rating identity tiebreak", () => {
  it("only applies to 4K charts past the hold line that structure left rice", () => {
    expect(lnRatingIdentityUndecided(4, { lnRatio: 0.46, lnEffectiveRatio: 0.315 })).toBe(true);
    expect(lnRatingIdentityUndecided(4, { lnRatio: 0.46, lnEffectiveRatio: 0.54 })).toBe(false);
    expect(lnRatingIdentityUndecided(4, { lnRatio: 0.38, lnEffectiveRatio: 0.41 })).toBe(false);
    expect(lnRatingIdentityUndecided(4, { lnRatio: 0.46 })).toBe(false);
    expect(lnRatingIdentityUndecided(7, { lnRatio: 0.3, lnEffectiveRatio: 0.2 })).toBe(false);
  });

  it("lifts the stored share to the line only when LN beats Overall by the margin", () => {
    const shares = { lnRatio: 0.46, lnEffectiveRatio: 0.315 };
    const lifted = resolveLnIdentityShare(4, shares, { lnRating: 29.5, rated: true, overall: 26.5 });
    expect(lifted).toEqual({ lnEffectiveRatio: LN_EFFECTIVE_MIN_RATIO, lnRatingIdentity: true, lnStructuralRatio: 0.315 });
    // A near tie stays with structure, as does a chart with nothing to rate.
    expect(resolveLnIdentityShare(4, shares, { lnRating: 28.9, rated: true, overall: 29.1 }).lnRatingIdentity).toBe(false);
    expect(resolveLnIdentityShare(4, shares, { lnRating: 27.4, rated: true, overall: 27.4 + LN_RATING_IDENTITY_MARGIN - 0.01 }).lnRatingIdentity).toBe(false);
    expect(resolveLnIdentityShare(4, shares, { lnRating: 40, rated: false, overall: 20 }).lnRatingIdentity).toBe(false);
    expect(resolveLnIdentityShare(4, shares, { lnRating: 40, rated: true, overall: null }).lnRatingIdentity).toBe(false);
    // Structure already LN: nothing to lift, share untouched.
    expect(resolveLnIdentityShare(4, { lnRatio: 0.9, lnEffectiveRatio: 0.7 }, { lnRating: 40, rated: true, overall: 20 }))
      .toEqual({ lnEffectiveRatio: 0.7, lnRatingIdentity: false });
  });

  it("reads the notes and leaves structure in charge without an Overall", () => {
    const hold = (column: number, time: number, length: number) => ({ column, time, endTime: time + length, isHold: length > 0 });
    // Sparse long holds in one column under a rice stream: past the hold line, far under the share line.
    const notes = [
      ...Array.from({ length: 20 }, (_, i) => hold(0, i * 2000, 300)),
      ...Array.from({ length: 100 }, (_, i) => hold(1, 50 + i * 400, 30)),
      ...Array.from({ length: 100 }, (_, i) => hold(2 + (i % 2), 25 + i * 400, 0)),
    ];
    const map = { notes, keyCount: 4, od: 8 };
    const structural = resolveChartLnIdentity(map, { rate: 1, overall: null });
    expect(structural.holdRatio).toBeCloseTo(120 / 220, 3);
    expect(structural.lnEffectiveRatio).toBeLessThan(LN_EFFECTIVE_MIN_RATIO);
    expect(structural.lnRatingIdentity).toBe(false);
    const lifted = resolveChartLnIdentity(map, { rate: 1, overall: 0.1 });
    expect(lifted).toMatchObject({ lnEffectiveRatio: LN_EFFECTIVE_MIN_RATIO, lnRatingIdentity: true, lnStructuralRatio: structural.lnEffectiveRatio });
    expect(resolveChartLnIdentity(map, { rate: 1, overall: 100 }).lnRatingIdentity).toBe(false);
  });
});
