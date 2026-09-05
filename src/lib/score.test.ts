import { describe, expect, it } from "vitest";
import { calculateReplacementPpGain, getBeatmapKeyCount, getBeatmapKeymodeLabel, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getEffectiveManiaKeyCount, getManiaJudgementCounts, getManiaKeyModCount, getModDisplayList, getScoreDisplayValues, getStableScaleManiaAccuracy, getManiaAccuracyFromCounts, hasCustomRateMod, isLazerScore, scoreUsesLazerScoring, withModRate, FIRST_LAZER_REPLAY_VERSION } from "./score";
import type { OsuScore } from "./types";

function createScore(overrides: Partial<OsuScore>): OsuScore {
  return {
    accuracy: 1,
    beatmap: {} as OsuScore["beatmap"],
    beatmapset: {} as OsuScore["beatmapset"],
    id: 1,
    max_combo: 1,
    mods: [],
    passed: true,
    pp: 1,
    rank: "A",
    score: 1,
    statistics: {},
    type: "solo_score",
    user: {
      id: 1,
      username: "test",
      avatar_url: "",
      country_code: "CR",
    },
    user_id: 1,
    ...overrides,
  };
}

describe("isLazerScore", () => {
  it("treats legacy-submitted scores as non-lazer even when type is solo_score", () => {
    expect(isLazerScore(createScore({
      legacy_score_id: 654682642,
      legacy_total_score: 947432,
      type: "solo_score",
    }))).toBe(false);
  });

  it("treats recent stable fails as non-lazer when they only have legacy totals", () => {
    expect(isLazerScore(createScore({
      legacy_score_id: 0,
      legacy_total_score: 450535,
      passed: false,
      type: "solo_score",
    }))).toBe(false);
  });

  it("keeps lazer-only scores flagged when legacy markers are absent", () => {
    expect(isLazerScore(createScore({
      legacy_score_id: null,
      legacy_total_score: 0,
      type: "solo_score",
    }))).toBe(true);
  });

  it("treats non-solo score payloads as legacy even without legacy markers", () => {
    expect(isLazerScore(createScore({
      legacy_score_id: null,
      legacy_total_score: 0,
      type: "score_best_mania",
    }))).toBe(false);
  });
});

describe("score display helpers", () => {
  it("normalizes fractional beatmap CS for keymode labels and marks converts", () => {
    expect(getBeatmapKeyCount({ cs: 3.3 })).toBe(4);
    expect(getBeatmapKeyCount({ cs: 3.5 })).toBe(4);
    expect(getBeatmapKeymodeLabel({ cs: 3.3, convert: true })).toBe("4K convert");
    expect(getBeatmapKeymodeLabel({ cs: 7, convert: false })).toBe("7K");
  });

  it("keeps the Cover mod in rendered mod badges", () => {
    expect(getModDisplayList([{ acronym: "CO" }, { acronym: "HD" }])).toEqual([{ acronym: "CO" }, { acronym: "HD" }]);
  });

  it("uses xK mods only for converted mania key counts", () => {
    expect(getManiaKeyModCount([{ acronym: "4K" }])).toBe(4);
    expect(getEffectiveManiaKeyCount({ cs: 7, mode: "osu" }, [{ acronym: "4K" }])).toBe(4);
    expect(getEffectiveManiaKeyCount({ cs: 7, mode: "mania" }, [{ acronym: "4K" }])).toBe(7);
  });
});

describe("getDisplayedAccuracy", () => {
  it("uses stable mania accuracy for legacy scores instead of the API accuracy field", () => {
    const accuracy = getDisplayedAccuracy(createScore({
      accuracy: 0.999012,
      legacy_score_id: 654681964,
      legacy_total_score: 998117,
      statistics: {
        perfect: 1388,
        great: 89,
      },
      type: "solo_score",
    }));

    expect(accuracy).toBe(1);
  });

  it("uses lazer mania accuracy for lazer-only scores", () => {
    const accuracy = getDisplayedAccuracy(createScore({
      accuracy: 0,
      legacy_score_id: null,
      legacy_total_score: 0,
      statistics: {
        perfect: 1,
        great: 1,
      },
      type: "solo_score",
    }));

    expect(accuracy).toBeCloseTo((305 + 300) / (2 * 305), 6);
  });
});

describe("getStableScaleManiaAccuracy", () => {
  it("scores a lazer all-great play as 100% instead of the 305-weighted value", () => {
    const score = createScore({
      accuracy: 300 / 305,
      legacy_score_id: null,
      legacy_total_score: 0,
      statistics: { perfect: 0, great: 1000, miss: 0 },
      type: "solo_score",
    });

    // Lazer reports ~98.4% via the 305 MAX weighting; on the stable scale a
    // miss-free all-300 play is 100%.
    expect(getDisplayedAccuracy(score)).toBeCloseTo(300 / 305, 6);
    expect(getStableScaleManiaAccuracy(score)).toBe(1);
  });

  it("matches the stable accuracy for legacy-submitted scores", () => {
    const score = createScore({
      accuracy: 0.999012,
      legacy_score_id: 654681964,
      legacy_total_score: 998117,
      statistics: { perfect: 1388, great: 89 },
      type: "solo_score",
    });

    expect(getStableScaleManiaAccuracy(score)).toBe(1);
  });

  it("falls back to displayed accuracy when judgement counts are missing", () => {
    const score = createScore({
      accuracy: 0.97,
      legacy_score_id: null,
      legacy_total_score: 0,
      statistics: {},
      type: "solo_score",
    });

    expect(getStableScaleManiaAccuracy(score)).toBeCloseTo(0.97, 6);
  });
});

describe("getDisplayedRank", () => {
  it("derives the stable mania grade for legacy-submitted scores", () => {
    const rank = getDisplayedRank(createScore({
      accuracy: 0.945677,
      legacy_score_id: 654180694,
      legacy_total_score: 785567,
      rank: "A",
      statistics: {
        ok: 55,
        meh: 33,
        good: 341,
        miss: 138,
        great: 2572,
        perfect: 3527,
      },
      type: "solo_score",
    }));

    expect(rank).toBe("S");
  });
});

describe("getManiaJudgementCounts", () => {
  it("normalizes stable and lazer judgement keys in display order", () => {
    expect(getManiaJudgementCounts({
      count_geki: 1,
      count_300: 2,
      count_katu: 3,
      count_100: 4,
      count_50: 5,
      count_miss: 6,
    })).toEqual([
      { label: "MAX", value: 1 },
      { label: "300", value: 2 },
      { label: "200", value: 3 },
      { label: "100", value: 4 },
      { label: "50", value: 5 },
      { label: "Miss", value: 6 },
    ]);

    expect(getManiaJudgementCounts({
      perfect: 7,
      great: 8,
      good: 9,
      ok: 10,
      meh: 11,
      miss: 12,
    })).toEqual([
      { label: "MAX", value: 7 },
      { label: "300", value: 8 },
      { label: "200", value: 9 },
      { label: "100", value: 10 },
      { label: "50", value: 11 },
      { label: "Miss", value: 12 },
    ]);
  });
});

describe("getScoreDisplayValues", () => {
  const referenceScores: Array<{
    expectedAccuracy: number;
    expectedIsLazer: boolean;
    expectedTotalScore: number;
    score: OsuScore;
  }> = [
    {
      expectedAccuracy: 1,
      expectedIsLazer: false,
      expectedTotalScore: 996631,
      score: createScore({
        id: 2180669956,
        accuracy: 0.998233,
        classic_total_score: 956237,
        total_score: 956237,
        legacy_score_id: 450232351,
        legacy_total_score: 996631,
        rank: "X",
        statistics: {
          great: 29,
          perfect: 240,
        },
        type: "solo_score",
      }),
    },
    {
      expectedAccuracy: 0.9822224200570612,
      expectedIsLazer: true,
      expectedTotalScore: 929938,
      score: createScore({
        id: 5451648091,
        accuracy: 0.982222,
        classic_total_score: 929938,
        total_score: 929938,
        legacy_score_id: null,
        legacy_total_score: 0,
        rank: "S",
        statistics: {
          ok: 14,
          meh: 4,
          good: 215,
          miss: 10,
          great: 2484,
          perfect: 5007,
        },
        type: "solo_score",
      }),
    },
    {
      expectedAccuracy: 1,
      expectedIsLazer: false,
      expectedTotalScore: 996683,
      score: createScore({
        id: 6199744810,
        accuracy: 0,
        classic_total_score: 0,
        total_score: 0,
        legacy_score_id: 0,
        legacy_total_score: 996683,
        rank: "D",
        statistics: {
          great: 276,
          perfect: 2324,
        },
        type: "solo_score",
      }),
    },
    {
      expectedAccuracy: 0.9630958385876419,
      expectedIsLazer: true,
      expectedTotalScore: 855507,
      score: createScore({
        id: 6458299766,
        accuracy: 0.963096,
        classic_total_score: 855507,
        total_score: 855507,
        legacy_score_id: null,
        legacy_total_score: 0,
        rank: "S",
        statistics: {
          ok: 58,
          meh: 20,
          good: 395,
          miss: 55,
          great: 2511,
          perfect: 4761,
        },
        type: "solo_score",
      }),
    },
  ];

  it("normalizes the reference stable and lazer scores consistently", () => {
    referenceScores.forEach(({ expectedAccuracy, expectedIsLazer, expectedTotalScore, score }) => {
      const display = getScoreDisplayValues(score);

      expect(display.isLazer).toBe(expectedIsLazer);
      expect(display.accuracy).toBeCloseTo(expectedAccuracy, 6);
      expect(display.totalScore).toBe(expectedTotalScore);
      expect(getDisplayedAccuracy(score)).toBeCloseTo(expectedAccuracy, 6);
      expect(getDisplayedTotalScore(score)).toBe(expectedTotalScore);
      expect(isLazerScore(score)).toBe(expectedIsLazer);
    });
  });
});

describe("hasCustomRateMod", () => {
  it("detects lazer custom rate settings on rate-changing mods", () => {
    expect(hasCustomRateMod([{ acronym: "NC", settings: { speed_change: 1.4 } }])).toBe(true);
    expect(hasCustomRateMod([{ acronym: "DT", settings: { speed_change: 1.25 } }])).toBe(true);
    expect(hasCustomRateMod([{ acronym: "HT", settings: { speed_change: 0.9 } }])).toBe(true);
  });

  it("allows default rate mods and unrelated settings", () => {
    expect(hasCustomRateMod([{ acronym: "NC" }])).toBe(false);
    expect(hasCustomRateMod([{ acronym: "NC", settings: { speed_change: 1.5 } }])).toBe(false);
    expect(hasCustomRateMod([{ acronym: "HD", settings: { speed_change: 1.4 } }])).toBe(false);
  });
});

describe("scoreUsesLazerScoring", () => {
  // Regression: an uploaded lazer .osr has no API score, and reading that as
  // "stable" labelled obviously-lazer plays Stable and judged them on stable
  // windows. The version stamp is the same cutoff osu!'s own decoder uses.
  it("falls back to the replay's own version stamp when there is no API score", () => {
    expect(scoreUsesLazerScoring(null, 30_000_019)).toBe(true);
    expect(scoreUsesLazerScoring(null, FIRST_LAZER_REPLAY_VERSION)).toBe(true);
    expect(scoreUsesLazerScoring(null, 20_231_019)).toBe(false); // stable stamps a date
    expect(scoreUsesLazerScoring(null, undefined)).toBe(false);
    expect(scoreUsesLazerScoring(undefined)).toBe(false);
  });

  it("trusts the API score over the version when both are known", () => {
    const legacy = createScore({ id: 1, legacy_score_id: 5 });
    const lazer = createScore({ id: 2 });
    expect(scoreUsesLazerScoring(legacy, 30_000_019)).toBe(false);
    expect(scoreUsesLazerScoring(lazer, 20_231_019)).toBe(true);
  });
});

describe("getManiaAccuracyFromCounts", () => {
  it("displays stable ScoreV2 on its own scale while retaining the fixed stable-scale helper", () => {
    const score = createScore({
      legacy_score_id: 1,
      mods: [{ acronym: "SV2" }],
      statistics: { count_geki: 1, count_300: 1 },
    });
    expect(getDisplayedAccuracy(score)).toBeCloseTo(605 / 610, 10);
    expect(getStableScaleManiaAccuracy(score)).toBe(1);
    expect(isLazerScore(score)).toBe(false);
  });

  // The same play measured both ways: lazer's MAX is worth 305 of 305, stable's
  // is worth 300 of 300, so a play carrying anything below MAX reads lower on
  // lazer. Counts are from uploadId 5UjidMiPv4-vOCoph4o9.
  it("measures the same counts on each client's scale", () => {
    const counts = { count_geki: 2978, count_300: 1681, count_katu: 300, count_100: 19, count_50: 7, count_miss: 11 };
    expect(getManiaAccuracyFromCounts(counts, true)).toBeCloseTo(0.96788, 5);
    expect(getManiaAccuracyFromCounts(counts, false)).toBeCloseTo(0.97408, 5);
  });

  it("agrees on an all-MAX play and on an empty one", () => {
    expect(getManiaAccuracyFromCounts({ count_geki: 100 }, true)).toBe(1);
    expect(getManiaAccuracyFromCounts({ count_geki: 100 }, false)).toBe(1);
    expect(getManiaAccuracyFromCounts({}, true)).toBe(0);
  });
});

describe("withModRate", () => {
  it("puts a stored rate back on the mod that owns it", () => {
    expect(withModRate(["HD", "DT"], 1.1)).toEqual([{ acronym: "HD" }, { acronym: "DT", rate: 1.1 }]);
    expect(withModRate(["DC"], 0.85)).toEqual([{ acronym: "DC", rate: 0.85 }]);
  });

  it("leaves the list alone when there is no rate to restore", () => {
    expect(withModRate(["DT", "HR"], undefined)).toEqual([{ acronym: "DT" }, { acronym: "HR" }]);
    expect(withModRate(["DT"], null)).toEqual([{ acronym: "DT" }]);
    expect(withModRate(["DT"], 0)).toEqual([{ acronym: "DT" }]);
    expect(withModRate(["HD"], 1.1)).toEqual([{ acronym: "HD" }]);
  });
});

describe("calculateReplacementPpGain", () => {
  it("measures the incremental gain from replacing a previous best on the same map", () => {
    const bestScores = [
      createScore({ id: 1, pp: 700 }),
      createScore({ id: 2, pp: 650 }),
      createScore({ id: 3, pp: 600 }),
    ];

    const gain = calculateReplacementPpGain(bestScores, 2, createScore({ id: 20, pp: 649 }));

    expect(gain).toBeCloseTo(0.95, 6);
  });

  it("falls back to the score-removal delta when the play had no previous ranked score", () => {
    const bestScores = [
      createScore({ id: 1, pp: 700 }),
      createScore({ id: 2, pp: 650 }),
      createScore({ id: 3, pp: 600 }),
    ];

    const gain = calculateReplacementPpGain(bestScores, 2, null);

    expect(gain).toBeCloseTo(589, 6);
  });

  it("uses the displaced 101st play when a new score enters the weighted top 100", () => {
    const higherScores = Array.from({ length: 99 }, (_, index) => createScore({ id: index + 1, pp: 700 - index }));
    const bestScores = [
      ...higherScores,
      createScore({ id: 100, pp: 600 }),
      createScore({ id: 101, pp: 300 }),
    ];

    const gain = calculateReplacementPpGain(bestScores, 100, null);

    expect(gain).toBeCloseTo((600 - 300) * 0.95 ** 99, 6);
  });
});
