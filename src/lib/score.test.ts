import { describe, expect, it } from "vitest";
import { getDisplayedAccuracy, isLazerScore } from "./score";
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

    expect(accuracy).toBeCloseTo(620 / 640);
  });
});
