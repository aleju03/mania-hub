import { describe, expect, it } from "vitest";
import { parseReplayScoreInput } from "./replay-score-input";

describe("parseReplayScoreInput", () => {
  it("accepts a pasted score id", () => {
    expect(parseReplayScoreInput("5921518069")).toBe(5921518069);
    expect(parseReplayScoreInput(" 5921518069 ")).toBe(5921518069);
  });

  it("accepts osu score urls", () => {
    expect(parseReplayScoreInput("https://osu.ppy.sh/scores/mania/5921518069")).toBe(5921518069);
    expect(parseReplayScoreInput("https://osu.ppy.sh/scores/5921518069?mode=mania")).toBe(5921518069);
    expect(parseReplayScoreInput("https://osu.ppy.sh/scores/mania/5921518069#replay")).toBe(5921518069);
  });

  it("rejects empty and unrelated input", () => {
    expect(parseReplayScoreInput("")).toBeNull();
    expect(parseReplayScoreInput("not a play")).toBeNull();
    expect(parseReplayScoreInput("https://osu.ppy.sh/beatmapsets/123#mania/456")).toBeNull();
  });
});
