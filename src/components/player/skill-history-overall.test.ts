import { describe, expect, it } from "vitest";
import { historyOverall, overallTicks } from "./skill-history-overall";

describe("history Overall", () => {
  it("derives Etterna's Overall from the snapshot and leaves hidden LN out", () => {
    const ratings = { Overall: 20, Stream: 24, Jumpstream: 22, Handstream: 20, Stamina: 18, JackSpeed: 16, Chordjack: 14, Technical: 12, "pattern:ln": 30 };
    expect(historyOverall(ratings, 4, false, false)).toBe(20);
    expect(historyOverall(ratings, 4, true, true)).toBe(19);
    expect(historyOverall(ratings, 4, true, false)).toBeGreaterThan(19);
    expect(historyOverall({ Overall: 31 }, 7, true, false)).toBe(31);
  });
});

describe("overallTicks", () => {
  it("keeps the axis to a handful of integer labels", () => {
    expect(overallTicks(24.2, 28.9)).toEqual([25, 26, 27, 28]);
    expect(overallTicks(10, 30)).toEqual([10, 15, 20, 25, 30]);
  });
});
