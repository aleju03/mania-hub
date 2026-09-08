import { describe, expect, it } from "vitest";
import { assessVibroClear } from "../src/dan/vibro-clear-evidence.js";
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
