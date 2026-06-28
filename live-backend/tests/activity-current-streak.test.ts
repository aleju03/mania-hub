import { describe, expect, it } from "vitest";
import { getCurrentActivityStreak, type PlayerActivityDay } from "../src/features/activity.js";

function day(date: string, scoreCount: number): PlayerActivityDay {
  return {
    date,
    scoreCount,
    passedCount: scoreCount,
    sessionCount: scoreCount > 0 ? 1 : 0,
    mapCount: scoreCount,
    maps: [],
    skills: null,
    timeline: [],
  };
}

function consecutiveDays(start: string, count: number, scores = 1): PlayerActivityDay[] {
  const [y, m, d] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, i) =>
    day(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10), scores),
  );
}

describe("getCurrentActivityStreak", () => {
  it("counts consecutive active days ending today", () => {
    const days = consecutiveDays("2026-06-14", 14);
    expect(getCurrentActivityStreak(days, 2026, "2026-06-27")).toBe(14);
  });

  it("keeps the streak when the current local day has no plays yet", () => {
    // Player played Jun 14-27 straight, but in their timezone it is already
    // Jun 28 with no score logged yet. Today is in progress, so yesterday's
    // streak should still stand. Regression for the dwdestroyer1 "0d" bug.
    const days = consecutiveDays("2026-06-14", 14);
    expect(getCurrentActivityStreak(days, 2026, "2026-06-28")).toBe(14);
  });

  it("extends the streak through today once a play lands", () => {
    const days = consecutiveDays("2026-06-14", 15);
    expect(getCurrentActivityStreak(days, 2026, "2026-06-28")).toBe(15);
  });

  it("breaks once a gap appears before the in-progress day", () => {
    // Last play was Jun 26 (Jun 27 missed), and today (Jun 28) has no play.
    // Skipping the empty today lands on the empty Jun 27, so the streak is 0.
    const days = consecutiveDays("2026-06-14", 13);
    expect(getCurrentActivityStreak(days, 2026, "2026-06-28")).toBe(0);
  });

  it("returns 0 when there is no activity at all", () => {
    expect(getCurrentActivityStreak([], 2026, "2026-06-28")).toBe(0);
  });

  it("for a past year measures the streak ending Dec 31 and requires that day", () => {
    const days = consecutiveDays("2025-12-20", 12);
    expect(getCurrentActivityStreak(days, 2025, "2026-06-28")).toBe(12);
  });
});
