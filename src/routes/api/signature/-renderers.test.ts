import { describe, expect, it } from "vitest";

import type { UserGoal } from "../../../lib/goals";
import { completedGoalDate, goalsForDynamicRender, insightCellWidths } from "./-renderers";

function goal(overrides: Partial<UserGoal>): UserGoal {
  return {
    id: "goal",
    userId: 1,
    country: "CR",
    kind: "reach_pp",
    beatmapId: null,
    beatmapsetId: null,
    beatmapLabel: null,
    targetValue: 10_000,
    targetCount: null,
    targetGrade: null,
    speedBucket: null,
    note: null,
    status: "open",
    createdAt: 1,
    completedAt: null,
    completedValue: null,
    completedScoreId: null,
    completedBeatmapId: null,
    progress: { current: 5_000, target: 10_000, pct: 50, detail: null },
    ...overrides,
  };
}

describe("insightCellWidths", () => {
  it("keeps ordinary key splits on four equal columns", () => {
    expect(insightCellWidths(824, 4)).toEqual([206, 206, 206, 206]);
  });

  it("makes room for a full 4K through 10K split", () => {
    const widths = insightCellWidths(824, 7);

    expect(widths).toEqual([365, 153, 153, 153]);
    expect(widths.reduce((total, width) => total + width, 0)).toBe(824);
  });

  it("caps the key split so the other readings remain visible", () => {
    const widths = insightCellWidths(824, 20);

    expect(widths[0]).toBeLessThanOrEqual(Math.floor(824 * 0.45));
    expect(widths.slice(1).every((width) => width > 0)).toBe(true);
    expect(widths.reduce((total, width) => total + width, 0)).toBe(824);
  });
});

describe("dynamic-render goals", () => {
  it("keeps completed goals visible after open goals, newest completion first", () => {
    const ordered = goalsForDynamicRender([
      goal({ id: "old-done", status: "completed", completedAt: 100 }),
      goal({ id: "open", progress: { current: 8_000, target: 10_000, pct: 80, detail: null } }),
      goal({ id: "new-done", status: "completed", completedAt: 200 }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual(["open", "new-done", "old-done"]);
  });

  it("dates a completion in the signature owner's time zone", () => {
    const completed = goal({
      status: "completed",
      completedAt: Date.parse("2026-08-21T02:00:00.000Z"),
    });

    expect(completedGoalDate(completed, "America/Costa_Rica")).toBe("August 20, 2026");
  });
});
