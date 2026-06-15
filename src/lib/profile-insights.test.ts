import { describe, expect, it } from "vitest";
import { calculateUserProfileInsights } from "./profile-insights";
import type { OsuScore } from "./types";

interface TestScoreInput {
  id: number;
  cs: number;
  bpm: number;
  created_at: string;
  pp: number;
  mods?: OsuScore["mods"];
  mode?: string;
  title?: string;
}

function createScore(overrides: TestScoreInput): OsuScore {
  const title = overrides.title ?? `Song ${overrides.id}`;
  return {
    accuracy: 1,
    beatmap: {
      id: 10_000 + overrides.id,
      beatmapset_id: 20_000 + overrides.id,
      bpm: overrides.bpm,
      cs: overrides.cs,
      mode: overrides.mode ?? "mania",
      url: `https://osu.ppy.sh/beatmaps/${10_000 + overrides.id}`,
      version: `${overrides.cs}K Another`,
    } as OsuScore["beatmap"],
    beatmapset: {
      artist: "Tester",
      covers: { cover: `https://assets.example/${overrides.id}.jpg` },
      id: 20_000 + overrides.id,
      title,
    } as OsuScore["beatmapset"],
    created_at: overrides.created_at,
    id: overrides.id,
    max_combo: 1,
    mods: overrides.mods ?? [],
    passed: true,
    pp: overrides.pp,
    rank: "S",
    score: 1,
    statistics: {},
    type: "score_best_mania",
    user: {
      id: 1,
      username: "test",
      avatar_url: "",
      country_code: "CR",
    },
    user_id: 1,
  };
}

describe("calculateUserProfileInsights", () => {
  it("summarizes key split, mods, BPM, top play dates, and PP range", () => {
    const insights = calculateUserProfileInsights([
      createScore({
        id: 1,
        cs: 4,
        bpm: 180,
        created_at: "2025-01-01T00:00:00Z",
        pp: 500,
        mods: [{ acronym: "DT" }],
        title: "Old DT",
      }),
      createScore({
        id: 2,
        cs: 7,
        bpm: 120,
        created_at: "2025-02-01T00:00:00Z",
        pp: 700,
        mods: [{ acronym: "HD" }],
        title: "Middle HD",
      }),
      createScore({
        id: 3,
        cs: 4,
        bpm: 200,
        created_at: "2025-03-01T00:00:00Z",
        pp: 450,
        title: "Newest NM",
      }),
      createScore({
        id: 5,
        cs: 7,
        bpm: 170,
        created_at: "2025-02-15T00:00:00Z",
        pp: 350,
        title: "Lower PP",
      }),
      createScore({
        id: 4,
        cs: 4,
        bpm: 90,
        created_at: "2025-04-01T00:00:00Z",
        pp: 900,
        mode: "osu",
        mods: [{ acronym: "HR" }],
      }),
    ]);

    expect(insights.sampleSize).toBe(4);
    expect(insights.keySplit).toEqual([
      { keyCount: 4, count: 2 },
      { keyCount: 7, count: 2 },
    ]);
    expect(insights.mostUsedMod).toEqual({ label: "DT", count: 1, total: 2 });
    expect(insights.modBreakdown).toEqual([
      { label: "DT", count: 1, total: 4 },
      { label: "HD", count: 1, total: 4 },
    ]);
    expect(insights.medianBpm).toBe(185);
    expect(insights.bpmByKeyMode).toEqual([
      { keyCount: 4, median: 235, count: 2 },
      { keyCount: 7, median: 145, count: 2 },
    ]);
    expect(insights.bpmRange?.min).toBe(120);
    expect(insights.bpmRange?.minScore.title).toBe("Middle HD");
    expect(insights.bpmRange?.max).toBe(270);
    expect(insights.bpmRange?.maxScore.title).toBe("Old DT");
    expect(insights.oldestTopPlay?.title).toBe("Old DT");
    expect(insights.oldestTopPlay?.scoreUrl).toBe("https://osu.ppy.sh/scores/mania/1");
    expect(insights.newestTopPlay?.title).toBe("Newest NM");
    expect(insights.newestTopPlay?.scoreUrl).toBe("https://osu.ppy.sh/scores/mania/3");
    expect(insights.ppRange).toEqual({ top: 700, bottom: 350 });
    expect(insights.ppDistribution).toEqual([
      { min: 700, max: null, count: 1, total: 4 },
      { min: 500, max: 599, count: 1, total: 4 },
      { min: 400, max: 499, count: 1, total: 4 },
      { min: 300, max: 399, count: 1, total: 4 },
    ]);
  });

  it("uses smaller pp bands for lower-pp profiles", () => {
    const insights = calculateUserProfileInsights([
      createScore({
        id: 1,
        cs: 4,
        bpm: 120,
        created_at: "2025-01-01T00:00:00Z",
        pp: 138,
      }),
      createScore({
        id: 2,
        cs: 4,
        bpm: 130,
        created_at: "2025-01-02T00:00:00Z",
        pp: 103,
      }),
      createScore({
        id: 3,
        cs: 4,
        bpm: 140,
        created_at: "2025-01-03T00:00:00Z",
        pp: 77,
      }),
      createScore({
        id: 4,
        cs: 4,
        bpm: 150,
        created_at: "2025-01-04T00:00:00Z",
        pp: 28,
      }),
    ]);

    expect(insights.ppRange).toEqual({ top: 138, bottom: 28 });
    expect(insights.ppDistribution).toEqual([
      { min: 100, max: null, count: 2, total: 4 },
      { min: 50, max: 99, count: 1, total: 4 },
      { min: null, max: 49, count: 1, total: 4 },
    ]);
  });
});
