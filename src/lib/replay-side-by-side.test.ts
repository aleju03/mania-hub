import { describe, expect, it } from "vitest";
import { getSideBySideCandidateIssue, getSideBySideIssue, getSideBySideScoreIssue } from "./replay-side-by-side";
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
    has_replay: true,
    beatmap: { id: 100, mode: "mania" },
    beatmapset: {},
    user: { id: 1, username: "player", avatar_url: "", country_code: "US" },
    ...overrides,
  } as OsuScore;
}

describe("getSideBySideScoreIssue", () => {
  it("passes a mania score with a replay", () => {
    expect(getSideBySideScoreIssue(score({}))).toBeNull();
  });

  it("names the player whose replay is missing", () => {
    const issue = getSideBySideScoreIssue(score({
      has_replay: false,
      replay: false,
      user: { id: 2, username: "instal", avatar_url: "", country_code: "TH" },
    }));
    expect(issue?.code).toBe("unplayable");
    expect(issue?.message).toBe("instal: This score doesn't have a downloadable replay.");
  });
});

describe("getSideBySideIssue", () => {
  it("accepts two different runs of the same chart at the same rate", () => {
    expect(getSideBySideIssue(score({ id: 1 }), score({ id: 2, mods: [{ acronym: "MR" }] }))).toBeNull();
  });

  it("rejects the same score on both sides", () => {
    expect(getSideBySideIssue(score({ id: 7 }), score({ id: 7 }))?.code).toBe("same-score");
  });

  it("rejects runs on different beatmaps", () => {
    const issue = getSideBySideIssue(score({ id: 1 }), score({ id: 2, beatmap: { id: 200, mode: "mania" } as OsuScore["beatmap"] }));
    expect(issue?.code).toBe("different-map");
  });

  it("rejects a rate mismatch, and says which rates", () => {
    const issue = getSideBySideIssue(score({ id: 1 }), score({ id: 2, mods: [{ acronym: "DT" }] }));
    expect(issue?.code).toBe("different-rate");
    expect(issue?.message).toContain("1x vs 1.5x");
  });

  it("reports an unplayable side before comparing the two", () => {
    const issue = getSideBySideIssue(
      score({ id: 1, has_replay: false, replay: false }),
      score({ id: 2, beatmap: { id: 999, mode: "mania" } as OsuScore["beatmap"] }),
    );
    expect(issue?.code).toBe("unplayable");
  });
});

describe("getSideBySideCandidateIssue", () => {
  it("checks a candidate on its own when no side is picked yet", () => {
    expect(getSideBySideCandidateIssue(score({ id: 3 }), null)).toBeNull();
    expect(getSideBySideCandidateIssue(score({ id: 3, has_replay: false, replay: false }), null)?.code).toBe("unplayable");
  });

  it("checks a candidate against the run already picked", () => {
    expect(getSideBySideCandidateIssue(score({ id: 3, mods: [{ acronym: "DT" }] }), score({ id: 1 }))?.code).toBe("different-rate");
  });
});
