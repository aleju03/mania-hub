import { describe, expect, it } from "vitest";
import { getReplayScoreAvailability } from "./replay-score-availability";
import type { OsuScore } from "./types";

function score(overrides: Partial<OsuScore>): OsuScore {
  return {
    id: 1,
    user_id: 1,
    accuracy: 1,
    mods: [],
    score: 1,
    max_combo: 1,
    passed: true,
    rank: "S",
    statistics: {},
    pp: null,
    beatmap: { mode: "mania" },
    beatmapset: {},
    user: { id: 1, username: "player", avatar_url: "", country_code: "US" },
    ...overrides,
  } as OsuScore;
}

describe("getReplayScoreAvailability", () => {
  it("allows mania scores with replay data", () => {
    expect(getReplayScoreAvailability(score({ has_replay: true }))).toEqual({ available: true });
  });

  it("rejects non-mania scores", () => {
    expect(getReplayScoreAvailability(score({ beatmap: { mode: "osu" } as OsuScore["beatmap"], has_replay: true }))).toEqual({
      available: false,
      reason: "non-mania",
      message: "This score is for osu!standard, not mania.",
    });
  });

  it("rejects scores without downloadable replays", () => {
    expect(getReplayScoreAvailability(score({ has_replay: false, replay: false }))).toEqual({
      available: false,
      reason: "no-replay",
      message: "This score doesn't have a downloadable replay.",
    });
  });
});
