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
        id: 4,
        cs: 4,
        bpm: 90,
        created_at: "2025-04-01T00:00:00Z",
        pp: 900,
        mode: "osu",
        mods: [{ acronym: "HR" }],
      }),
    ]);

    expect(insights.sampleSize).toBe(3);
    expect(insights.keySplit).toEqual([
      { keyCount: 4, count: 2 },
      { keyCount: 7, count: 1 },
    ]);
    expect(insights.mostUsedMod).toEqual({ label: "DT", count: 1, total: 2 });
    expect(insights.modBreakdown).toEqual([
      { label: "DT", count: 1, total: 3 },
      { label: "HD", count: 1, total: 3 },
    ]);
    expect(insights.medianBpm).toBe(200);
    expect(insights.bpmByKeyMode).toEqual([
      { keyCount: 4, median: 235, count: 2 },
      { keyCount: 7, median: 120, count: 1 },
    ]);
    expect(insights.bpmRange?.min).toBe(120);
    expect(insights.bpmRange?.minScore.title).toBe("Middle HD");
    expect(insights.bpmRange?.max).toBe(270);
    expect(insights.bpmRange?.maxScore.title).toBe("Old DT");
    expect(insights.oldestTopPlay?.title).toBe("Old DT");
    expect(insights.newestTopPlay?.title).toBe("Newest NM");
    expect(insights.ppRange).toEqual({ top: 700, bottom: 450 });
  });
});
