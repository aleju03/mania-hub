import { describe, expect, test } from "vitest";
import { computeManiaSkills } from "./maniacard";
import type { OsuScore } from "./types";

function score(overrides: Partial<OsuScore> = {}): OsuScore {
  return {
    id: 1,
    user_id: 1,
    accuracy: 0.9876,
    beatmap_id: 1,
    mods: [],
    score: 980000,
    max_combo: 900,
    passed: true,
    rank: "S",
    statistics: { count_miss: 0 },
    pp: 420,
    beatmap: {
      id: 1,
      beatmapset_id: 1,
      difficulty_rating: 6.2,
      mode: "mania",
      status: "ranked",
      total_length: 120,
      cs: 4,
      drain: 6,
      accuracy: 8,
      ar: 9,
      bpm: 180,
      convert: false,
      count_circles: 900,
      count_sliders: 0,
      count_spinners: 0,
      max_combo: 900,
      version: "Regular Difficulty",
      url: "",
    },
    beatmapset: {
      id: 1,
      title: "Plain Song",
      artist: "Plain Artist",
      creator: "Mapper",
      user_id: 1,
      covers: {} as OsuScore["beatmapset"]["covers"],
      status: "ranked",
      play_count: 0,
      favourite_count: 0,
      submitted_date: "",
      ranked_date: "",
      last_updated: "",
      bpm: 180,
      preview_url: "",
    },
    user: {
      id: 1,
      username: "player",
      avatar_url: "",
      country_code: "CR",
    },
    ...overrides,
  };
}

describe("computeManiaSkills", () => {
  test("uses rate-adjusted star estimates for tempo mods", () => {
    const nm = computeManiaSkills([score()]);
    const dt = computeManiaSkills([score({ mods: [{ acronym: "DT" }] })]);
    const ht = computeManiaSkills([score({ mods: [{ acronym: "HT" }] })]);

    expect(nm?.starAvg).toBeCloseTo(6.2, 5);
    expect(dt?.starAvg).toBeCloseTo(6.2 * Math.pow(1.5, 0.72), 5);
    expect(ht?.starAvg).toBeCloseTo(6.2 * Math.pow(0.75, 0.72), 5);
  });

  test("does not change skills based on map title or difficulty text", () => {
    const plain = computeManiaSkills([score()]);
    const tagged = computeManiaSkills([
      score({
        beatmap: {
          ...score().beatmap,
          version: "LN Tech Speed Jack Stamina Dump",
        },
        beatmapset: {
          ...score().beatmapset,
          title: "Long Note Stream Marathon",
          artist: "Hybrid Burst",
        },
      }),
    ]);

    expect(tagged).toEqual(plain);
  });
});
