import { describe, expect, it } from "vitest";
import { parseUnratedPlaysKeys, parseUnratedPlaysRange, parseUnratedPlaysSort } from "./unrated-plays";

// The unrated plays board's two controls share /rankings' search params, so a
// hand-typed or stale value must land on the default board, not on a fetch.
describe("unrated plays search params", () => {
  it("accepts the three numbers and falls back to pp", () => {
    expect(parseUnratedPlaysSort("pp")).toBe("pp");
    expect(parseUnratedPlaysSort("msd")).toBe("msd");
    expect(parseUnratedPlaysSort("dan")).toBe("dan");
    for (const value of ["accuracy", "", 4, undefined, null, "PP"]) {
      expect(parseUnratedPlaysSort(value)).toBe("pp");
    }
  });

  it("mixes every keymode unless a real one is asked for", () => {
    expect(parseUnratedPlaysKeys(7)).toBe(7);
    expect(parseUnratedPlaysKeys("4")).toBe(4);
    for (const value of ["all", 3, 19, "", undefined, null]) {
      expect(parseUnratedPlaysKeys(value)).toBe("all");
    }
  });

  it("accepts all time and the week and falls back to all time", () => {
    expect(parseUnratedPlaysRange("all")).toBe("all");
    expect(parseUnratedPlaysRange("week")).toBe("week");
    for (const value of ["7d", "month", "", undefined, null]) {
      expect(parseUnratedPlaysRange(value)).toBe("all");
    }
  });
});
