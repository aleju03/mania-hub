import { describe, expect, it } from "vitest";
import { extractReplayScoreIdFromFilename } from "./replay-upload";

describe("replay upload helpers", () => {
  it("extracts the score id from lazer exported replay filenames", () => {
    expect(extractReplayScoreIdFromFilename("solo-replay-mania_4001513_6708716952.osr")).toBe(6708716952);
  });

  it("ignores filenames without a usable score id", () => {
    expect(extractReplayScoreIdFromFilename("replay.osr")).toBeNull();
    expect(extractReplayScoreIdFromFilename(null)).toBeNull();
  });
});
