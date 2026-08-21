import { describe, expect, it } from "vitest";
import { getI18n } from "./i18n";
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

  // The message is a catalog descriptor now, so it is compared as the English
  // line the source string resolves to.
  it("rejects non-mania scores", () => {
    const result = getReplayScoreAvailability(score({ beatmap: { mode: "osu" } as OsuScore["beatmap"], has_replay: true }));
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toBe("non-mania");
    expect(result.available === false && getI18n("en")._(result.message)).toBe("This score is for osu!standard, not mania.");
  });

  it("rejects scores without downloadable replays", () => {
    const result = getReplayScoreAvailability(score({ has_replay: false, replay: false }));
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toBe("no-replay");
    expect(result.available === false && getI18n("en")._(result.message)).toBe("This score doesn't have a downloadable replay.");
  });
});
