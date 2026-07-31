import { describe, expect, it } from "vitest";
import { getProgressPollDelay } from "./progress-poll";

describe("getProgressPollDelay", () => {
  it("backs off progress polling after the first few seconds", () => {
    expect(getProgressPollDelay(0)).toBe(750);
    expect(getProgressPollDelay(4_999)).toBe(750);
    expect(getProgressPollDelay(5_000)).toBe(2_000);
    expect(getProgressPollDelay(19_999)).toBe(2_000);
    expect(getProgressPollDelay(20_000)).toBe(4_000);
  });
});
