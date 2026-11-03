import { describe, expect, it } from "vitest";
import { historyOverall, overallTicks } from "./skill-history-overall";

describe("history Overall", () => {
  it("derives Etterna's Overall from the snapshot, LN included", () => {
    const ratings = { Overall: 20, Stream: 24, Jumpstream: 22, Handstream: 20, Stamina: 18, JackSpeed: 16, Chordjack: 14, Technical: 12, "pattern:ln": 30 };
    expect(historyOverall(ratings, 4, false)).toBe(20);
    expect(historyOverall(ratings, 4, true)).toBeGreaterThan(19);
    expect(historyOverall({ Overall: 31 }, 7, true)).toBe(31);
    // A Prism keymode averages its five skillsets and LN, best four.
    const prism = { Overall: 24.55, Stream: 20.5, Jumpstream: 24.29, Handstream: 21.7, JackSpeed: 21.47, Chordjack: 23.16, Technical: 23.21, Speed: 23.06, "pattern:ln": 23.76 };
    expect(historyOverall(prism, 7, true)).toBe(23.6);
  });
});

describe("overallTicks", () => {
  it("keeps the axis to a handful of integer labels", () => {
    expect(overallTicks(24.2, 28.9)).toEqual([25, 26, 27, 28]);
    expect(overallTicks(10, 30)).toEqual([10, 15, 20, 25, 30]);
  });
});
