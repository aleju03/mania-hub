import { describe, expect, it } from "vitest";
import {
  beatmapScoreLookupPartialKey,
  beatmapScoreLookupStatusKey,
  sortBeatmapScores,
} from "./beatmap-score-progress";
import type { OsuScore } from "./types";

function score(overrides: Partial<OsuScore>): OsuScore {
  return {
    accuracy: 0.95,
    beatmap: {} as OsuScore["beatmap"],
    beatmapset: {} as OsuScore["beatmapset"],
    created_at: "2024-01-01T00:00:00Z",
    id: 1,
    max_combo: 0,
    mods: [],
    passed: true,
    pp: 0,
    rank: "A",
    replay: true,
    score: 0,
    statistics: {},
    total_score: 0,
    user: { id: 1, username: "player", avatar_url: "", country_code: "CR" },
    user_id: 1,
    ...overrides,
  };
}

describe("beatmap score progress helpers", () => {
  it("scopes status and partial keys by beatmap and normalized country", () => {
    expect(beatmapScoreLookupStatusKey(54235, "cr")).toBe("beatmap-score-lookup-status:54235:CR");
    expect(beatmapScoreLookupPartialKey(54235, "cr")).toBe("beatmap-score-lookup-partial:v1:54235:CR");
  });

  it("sorts scores by displayed score, then pp, then accuracy", () => {
    const lowScoreHighPp = score({ id: 1, total_score: 900_000, pp: 700, accuracy: 0.99 });
    const highScoreLowPp = score({ id: 2, total_score: 950_000, pp: 500, accuracy: 0.97 });
    const sameScoreHigherPp = score({ id: 3, total_score: 950_000, pp: 650, accuracy: 0.96 });
    const sameScoreSamePpHigherAcc = score({ id: 4, total_score: 950_000, pp: 650, accuracy: 0.98 });

    expect(sortBeatmapScores([
      lowScoreHighPp,
      highScoreLowPp,
      sameScoreHigherPp,
      sameScoreSamePpHigherAcc,
    ]).map((s) => s.id)).toEqual([4, 3, 2, 1]);
  });
});
