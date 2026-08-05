import { describe, expect, it } from "vitest";
import { extractReplayScoreIdFromFilename, stableModBitmaskToMods } from "./replay-upload";

describe("replay upload helpers", () => {
  it("maps the mania-relevant stable mod bits", () => {
    const acronyms = (mask: number) => stableModBitmaskToMods(mask).map((mod) => mod.acronym);
    // A Mirror-only replay: dropping this bit renders the chart unmirrored while
    // the replay's presses stay mirrored, so every column is wrong.
    expect(acronyms(1 << 30)).toEqual(["MR"]);
    expect(acronyms(1 << 20)).toEqual(["FI"]);
    expect(acronyms(1 << 21)).toEqual(["RD"]);
    expect(acronyms(1 << 29)).toEqual(["SV2"]);
    // KeyCoop stays unmapped - "CO" means Cover to the viewer.
    expect(acronyms(1 << 25)).toEqual([]);
    expect(acronyms((1 << 15) | (1 << 30))).toEqual(["4K", "MR"]);
  });


  it("extracts the score id from lazer exported replay filenames", () => {
    expect(extractReplayScoreIdFromFilename("solo-replay-mania_4001513_6708716952.osr")).toBe(6708716952);
  });

  it("ignores filenames without a usable score id", () => {
    expect(extractReplayScoreIdFromFilename("replay.osr")).toBeNull();
    expect(extractReplayScoreIdFromFilename(null)).toBeNull();
  });
});
