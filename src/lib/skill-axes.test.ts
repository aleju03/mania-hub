import { describe, expect, it } from "vitest";

import { qualifyingSkillModes, lnPlayShare, skillModeEntries, topSharePercent } from "./skill-axes";

describe.each(Array.from({ length: 15 }, (_, i) => i + 4))("%iK LN presentation", keyCount => {
  it("preserves the LN axis and limits independent-model evidence to 4K", () => {
    const mode = { keyCount, analyzedPlays: 100, ratings: { Overall: 30, Stream: 29 },
      patterns: [{ id: "ln", rating: 12.5, plays: 20 }, { id: "bracket", rating: 18, plays: 30 }] };
    expect(skillModeEntries(mode).filter(entry => entry.key === "ln")).toMatchObject([{ value: 12.5, axis: "pattern:ln" }]);
    expect(lnPlayShare(mode)).toBe(keyCount === 4 ? 0.2 : null);
    expect(skillModeEntries({ ...mode, patterns: [] }).some(entry => entry.key === "ln")).toBe(false);
  });
});

describe("topSharePercent", () => {
  it("keeps whole percents for ordinary standings", () => {
    expect(topSharePercent({ value: 75, population: 12371 })).toBe("25");
    expect(topSharePercent({ value: 98.2, population: 12371 })).toBe("2");
  });

  it("shows the tail of the population instead of clamping it to 1%", () => {
    expect(topSharePercent({ value: 99.5, population: 12371 })).toBe("0.5");
    expect(topSharePercent({ value: 99.94, population: 12371 })).toBe("0.06");
    // The best player: rank 1 of 12,371 is eight thousandths of a percent.
    expect(topSharePercent({ value: 99.9919, population: 12371 })).toBe("0.008");
  });

  it("never claims a finer share than one player out of the population", () => {
    // Curves that pin their top to a flat 100 still get the population floor.
    expect(topSharePercent({ value: 100, population: 25 })).toBe("4");
    expect(topSharePercent({ value: 100, population: 12371 })).toBe("0.008");
    // No population to divide by: nothing finer can be claimed.
    expect(topSharePercent({ value: 100, population: 0 })).toBe("1");
  });
});


it("keeps a newly certified keymode reachable alongside a well-established main", () => {
  const modes = [
    { keyCount: 4, analyzedPlays: 100, ratings: { Overall: 30 }, patterns: [] },
    { keyCount: 7, analyzedPlays: 0, ratings: { Overall: 0 }, patterns: [],
      dan: { rc: null, ln: { rawDan: 0, label: "", clears: 0, skillsetsOnly: true } } },
    { keyCount: 6, analyzedPlays: 1, ratings: { Overall: 4 }, patterns: [] },
  ];
  expect(qualifyingSkillModes({ modes, status: "ready", version: 1, computedAt: null, totalPlays: 101, analyzedPlays: 101, pendingPlays: 0, unsupportedPlays: 0 }).map((mode) => mode.keyCount)).toEqual([4, 7]);
});

describe("skillModeEntries", () => {
  const ratings = { Overall: 9, Stream: 8, Jumpstream: 9, Handstream: 7, Stamina: 7.5, JackSpeed: 6, Chordjack: 5, Technical: 3 };

  it("keeps a 6K/7K card on the MSD skillsets until three patterns are rated", () => {
    const thin = { keyCount: 7, analyzedPlays: 13, ratings, patterns: [{ id: "tech", rating: 4, plays: 4 }, { id: "chordstream", rating: 7, plays: 3 }] };
    expect(skillModeEntries(thin).map(entry => entry.key)).toEqual(["Jumpstream", "Stream", "Stamina", "Handstream", "JackSpeed", "Chordjack"]);
    const rated = { ...thin, patterns: [...thin.patterns, { id: "jack", rating: 6, plays: 3 }] };
    expect(skillModeEntries(rated).map(entry => entry.key)).toEqual(["chordstream", "jack", "tech"]);
  });

  it("shows Technical on 4K and 5K only", () => {
    for (const keyCount of [4, 5]) {
      expect(skillModeEntries({ keyCount, analyzedPlays: 50, ratings, patterns: [] }).some(entry => entry.key === "Technical")).toBe(true);
    }
    expect(skillModeEntries({ keyCount: 9, analyzedPlays: 50, ratings, patterns: [] }).some(entry => entry.key === "Technical")).toBe(false);
  });
});
