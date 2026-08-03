import { describe, expect, it } from "vitest";

import type { LivePlayerProfileSnapshot } from "../lib/live-backend";
import { computeManiaSkills } from "../lib/maniacard";
import { calculateUserProfileInsights } from "../lib/profile-insights";
import type { OsuScore } from "../lib/types";
import { buildPlayerLoaderData } from "./player/$username";

function createBestScore(index: number): OsuScore {
  const id = index + 1;
  return {
    accuracy: 0.98,
    beatmap: {
      id: 10_000 + id,
      beatmapset_id: 20_000 + id,
      bpm: 180,
      difficulty_rating: 6 + index / 100,
      accuracy: 8,
      drain: 7,
      cs: index === 199 ? 6 : 4,
      total_length: 120,
      count_circles: 600,
      count_sliders: 300,
      count_spinners: 0,
      max_combo: 900,
      mode: "mania",
      url: `https://osu.ppy.sh/beatmaps/${10_000 + id}`,
      version: "4K Test",
    } as OsuScore["beatmap"],
    beatmapset: {
      artist: "Tester",
      covers: { cover: `https://assets.example/${id}.jpg` },
      id: 20_000 + id,
      title: `Song ${id}`,
    } as OsuScore["beatmapset"],
    created_at: new Date(Date.UTC(2025, 0, id)).toISOString(),
    id,
    max_combo: 850,
    mods: [{ acronym: index < 40 ? "HT" : index === 199 ? "HD" : "DT" }],
    passed: true,
    pp: 500 - index,
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

describe("player loader insights", () => {
  it("summarizes the full top-play window while trimming SSR display scores", () => {
    const bestScores = Array.from({ length: 200 }, (_, index) => createBestScore(index));
    const snapshot = {
      user: {
        id: 1,
        username: "test",
        avatar_url: "",
        country_code: "CR",
        statistics: { pp: 13_952 },
      },
      bestScores,
      fetchedAt: "2025-08-01T00:00:00.000Z",
      userFetchedAt: "2025-08-01T00:00:00.000Z",
      isStale: false,
      projection: {
        appliedTopPlayEvents: 0,
        appliedRecentScores: 0,
        projectedPp: null,
        basePp: null,
        provenanceByScoreId: {},
      },
    } as LivePlayerProfileSnapshot;

    const loaderData = buildPlayerLoaderData(snapshot);
    const trimmedInsights = calculateUserProfileInsights(loaderData.cachedSnapshot!.bestScores);
    const trimmedSkills = computeManiaSkills(loaderData.cachedSnapshot!.bestScores, { globalPp: 13_952 });

    expect(loaderData.cachedSnapshot?.bestScores).toHaveLength(50);
    expect(trimmedInsights.sampleSize).toBe(50);
    expect(trimmedInsights.mostUsedMod?.label).toBe("HT");
    expect(trimmedInsights.newestTopPlay?.title).toBe("Song 50");
    expect(trimmedInsights.ppRange?.bottom).toBe(451);

    expect(loaderData.cachedInsights?.sampleSize).toBe(200);
    expect(loaderData.cachedInsights?.mostUsedMod).toEqual({ label: "DT", count: 159, total: 200 });
    expect(loaderData.cachedInsights?.newestTopPlay?.title).toBe("Song 200");
    expect(loaderData.cachedInsights?.ppRange?.bottom).toBe(301);
    expect(loaderData.cachedBestFilters).toEqual({
      keyModes: ["4k", "6k"],
      mods: ["DT|NC", "HT|DC", "HD"],
    });
    expect(loaderData.cachedManiaCardSkills).toEqual(computeManiaSkills(bestScores, { globalPp: 13_952 }));
    expect(loaderData.cachedManiaCardSkills).not.toEqual(trimmedSkills);
  });
});
