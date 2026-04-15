import { describe, expect, it } from "vitest";
import { calculateReplacementPpGain, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getScoreDisplayValues, isLazerScore } from "./score";
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
      accuracy: 0.987,
      legacy_score_id: null,
      legacy_total_score: 0,
      statistics: {
        perfect: 1,
        great: 1,
      },
      type: "solo_score",
    }));

    expect(accuracy).toBe(0.987);
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
      expectedAccuracy: 0.982222,
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
      expectedAccuracy: 0.963096,
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
});
