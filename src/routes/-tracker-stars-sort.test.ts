import { describe, expect, it } from "vitest";
import { sortTrackerScores } from "./tracker";
import type { LeanTrackerScore } from "../lib/types";

let nextId = 1;

function makeScore(stars: number | undefined, endedAtSeconds: number, companella = false): LeanTrackerScore {
  const id = nextId++;
  return {
    id: companella ? -id : id,
    user_id: 1,
    accuracy: 0.97,
    mods: [],
    score: 900_000,
    max_combo: 500,
    passed: true,
    rank: "S",
    statistics: {},
    pp: null,
    beatmap: {
      id: companella ? 0 : 100 + id,
      beatmapset_id: 0,
      difficulty_rating: stars as number,
      mode: "mania",
      cs: 4,
      bpm: 0,
      max_combo: 0,
      version: "4K",
      url: companella ? "" : `https://osu.ppy.sh/beatmaps/${100 + id}`,
    },
    beatmapset: { id: 0, title: "Song", artist: "Artist", covers: {} as never },
    user: { id: 1, username: "player", avatar_url: "", country_code: "CR" },
    ended_at: new Date(Date.UTC(2026, 8, 22, 12, 0, endedAtSeconds)).toISOString(),
    ...(companella ? { companella: { importId: `import-${id}`, replay: false } } : {}),
  };
}

describe("tracker stars sort", () => {
  // Newest first among unrated rows, like the time tiebreak everywhere else.
  const easy = makeScore(2.5, 10);
  const hard = makeScore(6.1, 20);
  const unratedOld = makeScore(0, 30, true);
  const unratedNew = makeScore(0, 40, true);
  const missing = makeScore(undefined, 50);
  const scores = [unratedOld, easy, missing, hard, unratedNew];

  it("puts a zero or missing star rating last when sorting hardest first", () => {
    expect(sortTrackerScores(scores, "stars", "desc")).toEqual([hard, easy, missing, unratedNew, unratedOld]);
  });

  it("puts a zero or missing star rating last when sorting easiest first", () => {
    expect(sortTrackerScores(scores, "stars", "asc")).toEqual([easy, hard, missing, unratedNew, unratedOld]);
  });

  it("leaves the recent order alone", () => {
    expect(sortTrackerScores(scores, "recent", "desc")).toBe(scores);
  });
});
