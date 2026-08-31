import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAN_SIDE,
  DEFAULT_LEADERBOARD_KEYS,
  DEFAULT_LEADERBOARD_TAB,
  parseDanLeaderboardKeys,
  parseDanSide,
  parseLeaderboardAxis,
  parseLeaderboardKeys,
  parseLeaderboardTab,
} from "../lib/skill-leaderboards";

// The leaderboard tabs share /rankings' search params, so a hand-typed or stale
// URL has to land on the pp board rather than on a broken fetch.

describe("leaderboard search params", () => {
  it("falls back to the pp board for anything but a known tab", () => {
    expect(parseLeaderboardTab("skills")).toBe("skills");
    expect(parseLeaderboardTab("dan")).toBe("dan");
    for (const value of ["pp", "", "nope", undefined, null, 3, {}]) {
      expect(parseLeaderboardTab(value)).toBe(DEFAULT_LEADERBOARD_TAB);
    }
  });

  it("accepts every MSD-supported keymode from 4K through 18K", () => {
    for (let keys = 4; keys <= 18; keys += 1) {
      expect(parseLeaderboardKeys(String(keys))).toBe(keys);
    }
    for (const value of [3, 19, "abc", undefined, null]) {
      expect(parseLeaderboardKeys(value)).toBe(DEFAULT_LEADERBOARD_KEYS);
    }
  });

  it("keeps dan rankings on the three keymodes with ladders", () => {
    for (const keys of [4, 6, 7]) expect(parseDanLeaderboardKeys(keys)).toBe(keys);
    for (const value of [5, 8, 18, "abc", undefined, null]) {
      expect(parseDanLeaderboardKeys(value)).toBe(DEFAULT_LEADERBOARD_KEYS);
    }
  });

  it("keeps the dan side to the two the estimator produces", () => {
    expect(parseDanSide("ln")).toBe("ln");
    for (const value of ["rc", "hybrid", undefined, null, 1]) {
      expect(parseDanSide(value)).toBe(DEFAULT_DAN_SIDE);
    }
  });

  it("bounds the axis to the wire shape instead of trusting the URL", () => {
    expect(parseLeaderboardAxis("Chordjack")).toBe("Chordjack");
    expect(parseLeaderboardAxis("pattern:chordjack")).toBe("pattern:chordjack");
    expect(parseLeaderboardAxis("  JackSpeed  ")).toBe("JackSpeed");
    for (const value of ["pattern:", "drop table", "a".repeat(40), "x:y", 4, undefined, null]) {
      expect(parseLeaderboardAxis(value)).toBeUndefined();
    }
  });
});
