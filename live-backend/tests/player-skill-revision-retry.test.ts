import { describe, expect, it } from "vitest";
import { revisionRetryDelayMs } from "../src/features/player-skill-jobs.js";

describe("revisionRetryDelayMs", () => {
  it("doubles from fifteen minutes and caps at six hours", () => {
    expect(revisionRetryDelayMs(0)).toBe(15 * 60_000);
    expect(revisionRetryDelayMs(1)).toBe(30 * 60_000);
    expect(revisionRetryDelayMs(4)).toBe(4 * 60 * 60_000);
    expect(revisionRetryDelayMs(5)).toBe(6 * 60 * 60_000);
    expect(revisionRetryDelayMs(40)).toBe(6 * 60 * 60_000);
    expect(revisionRetryDelayMs(Number.NaN)).toBe(15 * 60_000);
  });
});
