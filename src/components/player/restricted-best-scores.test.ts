import { describe, expect, it } from "vitest";
import type { RestrictedPpPlay } from "../../lib/live-backend";
import { calculateUserProfileInsights } from "../../lib/profile-insights";
import { companellaReplayImportId } from "../../lib/companella-scores";
import { getBeatmapUrl, getScoreDisplayValues, getScoreIdentity, getScoreUrl, scoreHasReplay } from "../../lib/score";
import { buildRestrictedBestList } from "./restricted-best-scores";

const owner = { id: 7, username: "someone", avatar_url: "", country_code: "CR" };

function play(overrides: Partial<RestrictedPpPlay> = {}): RestrictedPpPlay {
  return {
    scoreId: "import-0001",
    userId: 7,
    beatmapId: 100,
    beatmapsetId: 50,
    title: "Title",
    artist: "Artist",
    version: "Hard",
    creator: "Mapper",
    keyCount: 4,
    mods: [],
    rate: 1,
    starRating: 4.2,
    pp: 300,
    weightedPp: 300,
    // (900 * 300 + 90 * 300 + 10 * 200) / (1000 * 300)
    accuracy: 0.9966666666666667,
    grade: "S",
    totalScore: 987_654,
    maxCombo: 1_200,
    counts: { countGeki: 900, count300: 90, countKatu: 10, count100: 0, count50: 0, countMiss: 0 },
    playedAt: "2026-09-01T10:00:00.000Z",
    receivedAt: "2026-09-01T10:05:00.000Z",
    ...overrides,
  };
}

describe("buildRestrictedBestList", () => {
  it("reads as a stable play with its own accuracy, grade and total", () => {
    const scores = buildRestrictedBestList([play()], owner);
    const display = getScoreDisplayValues(scores[0]);
    expect(display.isLazer).toBe(false);
    expect(display.accuracy).toBeCloseTo(0.9966666666666667, 10);
    expect(display.rank).toBe("S");
    expect(display.totalScore).toBe(987_654);
  });

  it("keeps the weight osu! gives each place in the list", () => {
    const scores = buildRestrictedBestList([
      play({ scoreId: "import-0001", pp: 300, weightedPp: 300 }),
      play({ scoreId: "import-0002", beatmapId: 101, pp: 200, weightedPp: 190 }),
      play({ scoreId: "import-0003", beatmapId: 102, pp: 100, weightedPp: null }),
    ], owner);
    expect(scores[0].weight).toEqual({ percentage: 100, pp: 300 });
    expect(scores[1].weight?.percentage).toBeCloseTo(95, 10);
    expect(scores[1].weight?.pp).toBe(190);
    expect(scores[2].weight).toBeUndefined();
  });

  it("marks each score with the import its replay opens", () => {
    const scores = buildRestrictedBestList([
      play({ scoreId: "import-0001" }),
      play({ scoreId: "import-0002", beatmapId: 101 }),
    ], owner);
    expect(scores.map((score) => score.companella)).toEqual([
      { importId: "import-0001", replay: true },
      { importId: "import-0002", replay: true },
    ]);
    expect(scores.map(companellaReplayImportId)).toEqual(["import-0001", "import-0002"]);
    // Two plays with no osu! id still read as two rows.
    expect(new Set(scores.map(getScoreIdentity)).size).toBe(2);
    // The osu! replay path never applies: there is no osu! score to open.
    expect(scores.every((score) => !scoreHasReplay(score))).toBe(true);
  });

  it("links the map, never an osu! score page", () => {
    const scores = buildRestrictedBestList([play()], owner);
    expect(getScoreUrl(scores[0])).toBeNull();
    expect(getBeatmapUrl(scores[0])).toBe("https://osu.ppy.sh/beatmaps/100");
  });

  it("drops the played-rate stars on a rate-modded play", () => {
    const scores = buildRestrictedBestList([
      play({ mods: ["HD"], grade: "SH" }),
      play({ beatmapId: 101, mods: ["DT"], rate: 1.5, starRating: 6.1 }),
    ], owner);
    expect(scores[0].beatmap.difficulty_rating).toBe(4.2);
    expect(scores[1].beatmap.difficulty_rating).toBeUndefined();
    expect(getScoreDisplayValues(scores[0]).rank).toBe("SH");
  });

  it("dates a play without a played time by when it arrived", () => {
    const scores = buildRestrictedBestList([play({ playedAt: null })], owner);
    expect(scores[0].ended_at).toBe("2026-09-01T10:05:00.000Z");
  });

  it("feeds the profile insights like a window list", () => {
    const scores = buildRestrictedBestList([
      play({ pp: 300, weightedPp: 300 }),
      play({ beatmapId: 101, keyCount: 7, mods: ["HD"], grade: "SH", pp: 200, weightedPp: 190 }),
    ], owner);
    const insights = calculateUserProfileInsights(scores);
    expect(insights.sampleSize).toBe(2);
    expect(insights.keySplit.map((entry) => entry.keyCount).sort()).toEqual([4, 7]);
    expect(insights.ppRange).toMatchObject({ top: 300, bottom: 200 });
    expect(insights.newestTopPlay?.scoreUrl).toBeNull();
  });
});
