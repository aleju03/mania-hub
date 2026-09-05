import { describe, expect, it } from "vitest";
import type { ManiaNote } from "./beatmap-parser";
import type { ReplayNoteState } from "./mania-replay-judgement";
import { buildReplayMasterTimeline, drawReplayMasterTimeline } from "./replay-master-overlay";

const note = (time: number, endTime = time): ManiaNote => ({ column: 0, time, endTime, isHold: endTime > time });
const state = (patch: Partial<ReplayNoteState> = {}): ReplayNoteState => ({
  bodyBreakTime: null, displayJudgment: 2, displayTime: 1020,
  headJudgment: 2, headOffsetMs: 20, headTime: 1020, releaseTime: 1050,
  tailJudgment: null, tailOffsetMs: 0, tailTime: null, ...patch,
});

function render(timeline: ReturnType<typeof buildReplayMasterTimeline>, time: number, rate = 1, scrollSpeed = 1) {
  const rectangles: { x: number; y: number; width: number; height: number; color: string }[] = [];
  drawReplayMasterTimeline(timeline, time, rate, 4, 216, 384, (x, y, width, height, color) => {
    rectangles.push({ x, y, width, height, color });
  }, scrollSpeed);
  return rectangles;
}

describe("Mania Replay Master overlay", () => {
  it("adjusts scrolling independently while keeping notes and input bars the same thickness", () => {
    const timeline = buildReplayMasterTimeline([note(1000)], [state()], [[{ start: 1020, end: 1050 }]], 1);
    const normal = render(timeline, 900);
    const slow = render(timeline, 900, 1, 0.5);
    const fast = render(timeline, 900, 1, 2);
    const press = (rects: ReturnType<typeof render>) => rects.find((rect) => Math.abs(rect.width - 21.6) < 0.01)!;
    expect(press(slow).height).toBeCloseTo(press(normal).height);
    expect(press(fast).height).toBeCloseTo(press(normal).height);
    expect(384 - press(slow).y - press(slow).height).toBeCloseTo((384 - press(normal).y - press(normal).height) / 2);
    expect(384 - press(fast).y - press(fast).height).toBeCloseTo((384 - press(normal).y - press(normal).height) * 2);
    expect(slow[2].height).toBeCloseTo(normal[2].height);
    // A slow fixed-height note remains partially visible after its timestamp.
    expect(render(timeline, 1100, 1, 0.25).length).toBeGreaterThan(0);
  });
  it("draws actual raw input offsets even when stable interpolates judgement time", () => {
    const timeline = buildReplayMasterTimeline([note(1000)], [state()], [[{ start: 1028, end: 1050 }]], 1);
    expect(timeline.shapes.find((shape) => shape.kind === "press")).toMatchObject({ start: 1028, judgment: 2 });
    const rects = render(timeline, 600);
    const press = rects.find((rect) => Math.abs(rect.width - 21.6) < 0.01)!;
    expect(press.y + press.height).toBeCloseTo(384 - 428 * 0.48);
    expect(press.color).toBe("#ffd237");
  });

  it("keeps missed notes and stray inputs distinct without inventing timeout presses", () => {
    const timeline = buildReplayMasterTimeline([note(1000)], [state({ headJudgment: 6, headTime: 1150, releaseTime: 0 })], [[{ start: 800, end: 810 }]], 1);
    expect(timeline.shapes.filter((shape) => shape.kind === "press")).toEqual([
      expect.objectContaining({ start: 800, judgment: 6 }),
    ]);
    expect(timeline.shapes.find((shape) => shape.kind === "note")?.judgment).toBe(6);
  });

  it("shows raw long-note re-grabs, release judgements and interrupted hold trails", () => {
    const segments = [{ start: 1020, end: 1300 }, { start: 1400, end: 1950 }];
    const timeline = buildReplayMasterTimeline([note(1000, 2000)], [state({
      stableMatchedSegmentIndex: 0, stableTailSegmentIndex: 1,
      heldSegments: segments, releaseTime: 1950, tailJudgment: 3, tailTime: 1950,
    })], [segments], 1);
    expect(timeline.shapes.filter((shape) => shape.kind === "hold")).toMatchObject([
      { start: 1020, end: 1300 }, { start: 1400, end: 1950 },
    ]);
    expect(timeline.shapes.find((shape) => shape.kind === "release" && shape.start === 1950)?.judgment).toBe(3);
    expect(render(timeline, 1200).some((rect) => rect.color === "#646464")).toBe(true);
  });

  it("keeps re-grab trails when separate-head/tail scoring only provides interpolated head timing", () => {
    const timeline = buildReplayMasterTimeline([note(1000, 2000)], [state({
      releaseTime: 1950, tailJudgment: 3, tailTime: 1950,
    })], [[{ start: 1028, startPrevious: 1016, end: 1300 }, { start: 1400, end: 1950 }]], 1);
    expect(timeline.shapes.filter((shape) => shape.kind === "hold")).toHaveLength(2);
    expect(timeline.shapes.find((shape) => shape.kind === "press" && shape.start === 1028)?.judgment).toBe(2);
  });

  it.each([0.75, 1.5])("scales map time by rate %s while preserving visual hit offsets", (rate) => {
    const normal = buildReplayMasterTimeline([note(1000)], [state()], [[{ start: 1020, end: 1050 }]], 1);
    const modified = buildReplayMasterTimeline([note(1000 * rate)], [state({ headTime: 1020 * rate, releaseTime: 1050 * rate })], [[{ start: 1020 * rate, end: 1050 * rate }]], rate);
    const expected = render(normal, 600);
    const actual = render(modified, 600 * rate, rate);
    expect(actual).toHaveLength(expected.length);
    actual.forEach((rect, i) => {
      expect(rect.color).toBe(expected[i].color);
      for (const dimension of ["x", "y", "width", "height"] as const) {
        expect(rect[dimension]).toBeCloseTo(expected[i][dimension]);
      }
    });
  });

  it("clips long holds without closing their outlines at the viewport edges and supports backwards seeks", () => {
    const timeline = buildReplayMasterTimeline([note(0, 60000)], [state({
      headTime: 0, releaseTime: 60000, tailJudgment: 1, tailTime: 60000,
      stableMatchedSegmentIndex: 0, stableTailSegmentIndex: 0,
    })], [[{ start: 0, end: 60000 }]], 1);
    const before = render(timeline, 30000);
    expect(before.length).toBeGreaterThan(10);
    expect(before.every((rect) => rect.y >= 0 && rect.y + rect.height <= 384)).toBe(true);
    expect(before.filter((rect) => rect.width > 10)).toHaveLength(0);
    render(timeline, 59000);
    expect(render(timeline, 30000)).toEqual(before);
    expect(render(timeline, 70000)).toEqual([]);
  });
});
