import { describe, expect, it } from "vitest";
import { buildTrackedPlayScore, getTrackedPlayRank } from "./tracked-play-score";
import { getManiaJudgementCounts, getScoreUrl, isLazerScore } from "./score";
import type { LiveKeymodePpPlay } from "./live-backend";

const viewer = { id: 7, username: "Tester", avatar_url: "https://a/7.png", country_code: "CR" };

function play(overrides: Partial<LiveKeymodePpPlay> = {}): LiveKeymodePpPlay {
  return {
    beatmapId: 5_220_675,
    keyCount: 6,
    pp: 481.37,
    beatmapsetId: 39_804,
    title: "FREEDOM DiVE",
    artist: "xi",
    version: "[6K] SUN DiMENSiONS",
    accuracy: 0.9411,
    rank: "A",
    mods: [],
    playedAt: "2026-08-10T12:00:00.000Z",
    maxCombo: 558,
    hasReplay: true,
    soloScoreId: 7_245_658_770,
    totalScore: 758_466,
    legacyScoreId: null,
    statistics: { perfect: 4412, great: 2105, good: 340, ok: 79, meh: 76, miss: 154 },
    creator: "Realazy",
    stars: 6.12,
    bpm: 222.22,
    ...overrides,
  };
}

describe("getTrackedPlayRank", () => {
  it("keeps the grade the row stored", () => {
    expect(getTrackedPlayRank(play({ rank: "S" }))).toBe("S");
  });

  it("grades a row that stored none from its accuracy", () => {
    expect(getTrackedPlayRank(play({ rank: null, accuracy: 0.9677 }))).toBe("S");
    expect(getTrackedPlayRank(play({ rank: null, accuracy: 0.9677, mods: ["FI"] }))).toBe("SH");
    expect(getTrackedPlayRank(play({ rank: null, accuracy: 0.9411 }))).toBe("A");
  });

  it("falls back to the judgement counts when the row kept no accuracy either", () => {
    expect(getTrackedPlayRank(play({ rank: null, accuracy: null }))).toBe("A");
  });

  it("still answers with a grade when the row kept nothing to grade", () => {
    expect(getTrackedPlayRank(play({ rank: null, accuracy: null, statistics: null }))).toBe("D");
  });
});

describe("buildTrackedPlayScore", () => {
  it("reads a stable run with no legacy id as stable, not lazer", () => {
    // osu! answers a stable run on an unranked map with legacy_score_id 0,
    // which the row stores as no legacy id at all.
    const score = buildTrackedPlayScore(play({ isLazer: false, legacyScoreId: null, totalScore: 840_256 }), viewer);
    expect(isLazerScore(score)).toBe(false);
  });

  it("leaves a row that names no client to its ids", () => {
    expect(isLazerScore(buildTrackedPlayScore(play({ isLazer: null }), viewer))).toBe(true);
  });

  it("carries the play's own numbers onto the details card", () => {
    const score = buildTrackedPlayScore(play(), viewer);

    expect(score.pp).toBe(481.37);
    expect(score.accuracy).toBe(0.9411);
    expect(score.rank).toBe("A");
    expect(score.max_combo).toBe(558);
    expect(score.total_score).toBe(758_466);
    expect(score.beatmapset.title).toBe("FREEDOM DiVE");
    expect(score.beatmapset.creator).toBe("Realazy");
    expect(score.beatmap.cs).toBe(6);
    expect(getManiaJudgementCounts(score.statistics)).toEqual([
      { label: "MAX", value: 4412 },
      { label: "300", value: 2105 },
      { label: "200", value: 340 },
      { label: "100", value: 79 },
      { label: "50", value: 76 },
      { label: "Miss", value: 154 },
    ]);
  });

  it("leaves what the row never stored absent, so the card can say so", () => {
    const score = buildTrackedPlayScore(
      play({ maxCombo: null, statistics: null, stars: null, bpm: null, hasReplay: null, soloScoreId: null, totalScore: null }),
      viewer,
    );

    expect(score.max_combo).toBe(0);
    expect(score.statistics).toEqual({});
    expect(score.beatmap.difficulty_rating).toBeUndefined();
    expect(score.beatmap.bpm).toBeUndefined();
    expect(score.total_score).toBeUndefined();
    // No id to open, so the card offers no osu! link rather than a broken one.
    expect(getScoreUrl(score)).toBeNull();
  });

  it("drops the map's stars and bpm for a rate-modded play", () => {
    const score = buildTrackedPlayScore(play({ mods: ["DT"] }), viewer);

    expect(score.beatmap.difficulty_rating).toBeUndefined();
    expect(score.beatmap.bpm).toBeUndefined();
    expect(score.mods).toEqual([{ acronym: "DT" }]);
  });

  it("reads as lazer or stable by whether a legacy id rode along", () => {
    expect(isLazerScore(buildTrackedPlayScore(play(), viewer))).toBe(true);
    expect(isLazerScore(buildTrackedPlayScore(play({ legacyScoreId: 4_123_456_789 }), viewer))).toBe(false);
  });

  it("links osu! at the solo id even for a stable play, which is what resolves", () => {
    const score = buildTrackedPlayScore(play({ legacyScoreId: 4_123_456_789 }), viewer);

    expect(score.id).toBe(7_245_658_770);
    expect(getScoreUrl(score)).toBe("https://osu.ppy.sh/scores/7245658770");
  });
});
