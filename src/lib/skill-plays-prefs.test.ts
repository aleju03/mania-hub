// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_PLAYS_PREFS,
  normalizeSkillPlaysPrefs,
  readSkillPlaysPrefs,
  writeSkillPlaysPrefs,
  SKILL_PLAYS_PREFS_STORAGE_KEY,
} from "./skill-plays-prefs";

describe("normalizeSkillPlaysPrefs", () => {
  it("falls back to the defaults on nothing, garbage, and the wrong type", () => {
    expect(normalizeSkillPlaysPrefs(null)).toEqual(DEFAULT_SKILL_PLAYS_PREFS);
    expect(normalizeSkillPlaysPrefs("nonsense")).toEqual(DEFAULT_SKILL_PLAYS_PREFS);
    expect(normalizeSkillPlaysPrefs([])).toEqual(DEFAULT_SKILL_PLAYS_PREFS);
  });

  it("keeps the good fields when one is bad, rather than dropping all six", () => {
    expect(normalizeSkillPlaysPrefs({
      keyCount: "seven",
      axis: "pattern:jack",
      side: "ln",
      sort: "recent",
      hideRanked: true,
      maxPerChart: 2,
      showRejected: false,
    })).toEqual({
      keyCount: null,
      axis: "pattern:jack",
      side: "ln",
      sort: "recent",
      hideRanked: true,
      maxPerChart: 2,
      showRejected: false,
    });
  });

  it("only accepts a cap the control can actually produce", () => {
    expect(normalizeSkillPlaysPrefs({ maxPerChart: 3 }).maxPerChart).toBe(3);
    // A hand-edited 50 would silently thin every list, so it reads as no cap.
    expect(normalizeSkillPlaysPrefs({ maxPerChart: 50 }).maxPerChart).toBe(0);
    expect(normalizeSkillPlaysPrefs({ maxPerChart: -1 }).maxPerChart).toBe(0);
  });

  it("keeps the turned-away plays listed unless a stored entry says otherwise", () => {
    // An entry written before this control existed has no field, and a reader
    // who never touched it should keep seeing the rows the feature is for.
    expect(normalizeSkillPlaysPrefs({}).showRejected).toBe(true);
    expect(normalizeSkillPlaysPrefs({ showRejected: false }).showRejected).toBe(false);
  });

  it("keeps a keymode only when it could be one", () => {
    expect(normalizeSkillPlaysPrefs({ keyCount: 7 }).keyCount).toBe(7);
    expect(normalizeSkillPlaysPrefs({ keyCount: 0 }).keyCount).toBeNull();
    expect(normalizeSkillPlaysPrefs({ keyCount: 99 }).keyCount).toBeNull();
  });

  it("does not validate the axis against a keymode, which it cannot know", () => {
    // The explorer falls back to Overall when the stored axis is not one this
    // keymode rates, so an axis from another keymode is kept, not discarded.
    expect(normalizeSkillPlaysPrefs({ axis: "Technical" }).axis).toBe("Technical");
    expect(normalizeSkillPlaysPrefs({ axis: "   " }).axis).toBe("Overall");
  });
});

describe("readSkillPlaysPrefs", () => {
  it("round-trips through storage and survives a corrupt entry", () => {
    writeSkillPlaysPrefs({
      keyCount: 7,
      axis: "pattern:ln",
      side: "ln",
      sort: "recent",
      hideRanked: true,
      maxPerChart: 3,
      showRejected: false,
    });
    expect(readSkillPlaysPrefs()).toEqual({
      keyCount: 7,
      axis: "pattern:ln",
      side: "ln",
      sort: "recent",
      hideRanked: true,
      maxPerChart: 3,
      showRejected: false,
    });

    window.localStorage.setItem(SKILL_PLAYS_PREFS_STORAGE_KEY, "{not json");
    expect(readSkillPlaysPrefs()).toEqual(DEFAULT_SKILL_PLAYS_PREFS);
  });
});
