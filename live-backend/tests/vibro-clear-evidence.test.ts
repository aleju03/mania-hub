import { describe, expect, it } from "vitest";
import { assessVibroClear, hasOnlyClearEvidencePatterns } from "../src/dan/vibro-clear-evidence.js";
import { analyzeVibroSections } from "../src/dan/vibro-sections.js";
import { vibroFixture } from "./vibro-fixtures.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { calculateManiaCustomAccuracy, calculateStableAccuracy } from "../src/shared/score.js";

// Judgement evidence from the reviewed clear; no player/chart identity.
const reviewed = { perfect: 1072, great: 418, good: 176, ok: 13, meh: 0, miss: 4 };

describe("individual vibro clear evidence", () => {
  it("accepts the reviewed high-OD accuracy and MAX:300 evidence", () => {
    const evidence = assessVibroClear({ statistics: reviewed, widenedWindows: false }, 9);
    expect(evidence?.stableAccuracy).toBeCloseTo(0.95761536938);
    expect(evidence?.max300Ratio).toBeCloseTo(1072 / 418);
    expect(evidence?.ratioIsLowerBound).toBe(false);
    expect(evidence?.statistics).toEqual(reviewed);
  });

  it("requires accuracy, ratio, known narrow windows and OD together", () => {
    expect(assessVibroClear({ statistics: reviewed, widenedWindows: false }, 8.9)).toBeUndefined();
    expect(assessVibroClear({ statistics: reviewed, widenedWindows: true }, 9)).toBeUndefined();
    expect(assessVibroClear({ statistics: reviewed, widenedWindows: false }, NaN)).toBeUndefined();
    expect(assessVibroClear({ statistics: { perfect: 400, great: 800 }, widenedWindows: false }, 9)).toBeUndefined();
    expect(assessVibroClear({ statistics: { perfect: 900, miss: 100 }, widenedWindows: false }, 9)).toBeUndefined();
    expect(assessVibroClear({ stableAccuracy: 0.99, widenedWindows: false }, 9)).toBeUndefined();
    expect(assessVibroClear({ statistics: { perfect: -1, great: 1 }, widenedWindows: false }, 9)).toBeUndefined();
  });

  it("uses the same judgement evidence for both statistic naming schemes", () => {
    const legacy = { count_geki: 1072, count_300: 418, count_katu: 176, count_100: 13, count_50: 0, count_miss: 4 };
    expect(assessVibroClear({ statistics: legacy, widenedWindows: false }, 9))
      .toEqual(assessVibroClear({ statistics: reviewed, widenedWindows: false }, 9));
  });

  it("recovers only a conservative ratio bound from durable judgement summaries", () => {
    const evidence = assessVibroClear({
      stableAccuracy: calculateStableAccuracy(reviewed),
      customAccuracy: calculateManiaCustomAccuracy(reviewed),
      missShare: 4 / 1683, widenedWindows: false,
    }, 9);
    expect(evidence?.ratioIsLowerBound).toBe(true);
    expect(evidence?.max300Ratio).toBeGreaterThan(2);
    expect(evidence?.max300Ratio).toBeLessThan(1072 / 418);
    expect(evidence?.statistics).toBeUndefined();
    expect(assessVibroClear({ stableAccuracy: 0.96, customAccuracy: 1, missShare: 0, widenedWindows: false }, 9)).toBeUndefined();
  });

  it("never overstates the actual ratio when recovering summaries", () => {
    let accepted = 0;
    for (const perfect of [40, 60, 80, 100]) for (const great of [0, 20, 40, 60]) {
      for (const good of [0, 1, 5]) for (const ok of [0, 1, 3]) {
        for (const meh of [0, 1]) for (const miss of [0, 1, 3]) {
          const statistics = { perfect, great, good, ok, meh, miss };
          const evidence = assessVibroClear({
            stableAccuracy: calculateStableAccuracy(statistics), customAccuracy: calculateManiaCustomAccuracy(statistics),
            missShare: miss / (perfect + great + good + ok + meh + miss), widenedWindows: false,
          }, 9);
          if (!evidence) continue;
          accepted++;
          expect(perfect).toBeGreaterThanOrEqual(2 * great);
          if (great > 0) {
            expect(evidence.max300Ratio).not.toBeNull();
            expect(evidence.max300Ratio!).toBeLessThanOrEqual(perfect / great + 1e-9);
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("which detections a clear can vouch for", () => {
  const section = (reasons: string[]) => ({ startTime: 0, endTime: 1000, reasons: reasons as never });

  it("needs clear-evidence material and refuses a chart made of limit breaches", () => {
    expect(hasOnlyClearEvidencePatterns([section(["dense_chord_repetition"])], { dense_chord_repetition: 0.4 })).toBe(true);
    expect(hasOnlyClearEvidencePatterns([], {})).toBe(false);
    expect(hasOnlyClearEvidencePatterns([section(["finger_rate_ceiling"])], { finger_rate_ceiling: 0.4 })).toBe(false);
    // A repeated wall is not a dense chord and no score vouches for it.
    expect(hasOnlyClearEvidencePatterns([section(["dense_chord_repetition", "repeated_wall"])],
      { dense_chord_repetition: 0.4, repeated_wall: 0.3 })).toBe(false);
  });

  it("does not let an incidental brush against a limit veto the exception", () => {
    // Merging unions reasons, so a one-second breach inside a twelve-second
    // chord passage arrives tagged onto it. Weigh it by what it covers alone.
    const merged = [section(["dense_chord_repetition", "sustained_chords", "finger_rate_ceiling"])];
    expect(hasOnlyClearEvidencePatterns(merged,
      { dense_chord_repetition: 0.22, sustained_chords: 0.06, finger_rate_ceiling: 0.022 })).toBe(true);
    expect(hasOnlyClearEvidencePatterns(merged,
      { dense_chord_repetition: 0.22, sustained_chords: 0.06, finger_rate_ceiling: 0.13 })).toBe(false);
    // Missing shares stay conservative: an unknown reason blocks.
    expect(hasOnlyClearEvidencePatterns(merged, {})).toBe(false);
  });

  it("holds on the reported uprate the exception was built for", () => {
    const analysis = analyzeVibroSections(parseManiaBeatmap(vibroFixture(4706643)), 1.5);
    expect(analysis.status).toBe("excluded");
    expect(analysis.reasonShares.finger_rate_ceiling).toBeLessThan(0.05);
    expect(hasOnlyClearEvidencePatterns(analysis.sections, analysis.reasonShares)).toBe(true);
  });

  it("does not forgive hard patterns or give each ceiling a separate allowance", () => {
    for (const reason of ["repeated_wall", "isolated_jack", "fast_roll", "split_hand_double"] as const) {
      expect(hasOnlyClearEvidencePatterns([section(["dense_chord_repetition", reason])],
        { dense_chord_repetition: 0.3, [reason]: 0.01 })).toBe(false);
    }
    expect(hasOnlyClearEvidencePatterns([section(["dense_chord_repetition", "finger_rate_ceiling", "hand_action_ceiling"])],
      { dense_chord_repetition: 0.3, finger_rate_ceiling: 0.04, hand_action_ceiling: 0.04 })).toBe(false);
  });
});
