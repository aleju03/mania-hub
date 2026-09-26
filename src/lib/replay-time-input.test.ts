import { describe, expect, it } from "vitest";

import { formatReplayTimeInput, parseReplayTimeInput } from "./replay-time-input";

describe("parseReplayTimeInput", () => {
  it("reads seconds, minutes and hours", () => {
    expect(parseReplayTimeInput("83")).toBe(83_000);
    expect(parseReplayTimeInput("1:23")).toBe(83_000);
    expect(parseReplayTimeInput(" 1:23.4 ")).toBe(83_400);
    expect(parseReplayTimeInput("0:05.25")).toBe(5_250);
    expect(parseReplayTimeInput("1:02:03")).toBe(3_723_000);
    expect(parseReplayTimeInput("90.5")).toBe(90_500);
  });

  it("rejects malformed times", () => {
    expect(parseReplayTimeInput("")).toBeNull();
    expect(parseReplayTimeInput("1:75")).toBeNull();
    expect(parseReplayTimeInput("1::2")).toBeNull();
    expect(parseReplayTimeInput("-3")).toBeNull();
    expect(parseReplayTimeInput("abc")).toBeNull();
  });

  it("round-trips the formatted value", () => {
    expect(formatReplayTimeInput(83_400)).toBe("1:23.4");
    expect(formatReplayTimeInput(59_960)).toBe("1:00.0");
    expect(parseReplayTimeInput(formatReplayTimeInput(125_300))).toBe(125_300);
  });
});
