import { describe, expect, it } from "vitest";
import { buildReplaySegments, calculateReplayAccuracy, getManiaReplayHitWindows, getManiaReplayRuleset, simulateManiaReplayJudgements } from "./mania-replay-judgement";
import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

describe("mania replay judgement helpers", () => {
  it("uses stable classic windows for legacy scores", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);

    expect(windows.perfect).toBe(16.5);
    expect(windows.great).toBe(40.5);
    expect(windows.good).toBe(73.5);
    expect(windows.ok).toBe(103.5);
    expect(windows.meh).toBe(127.5);
    expect(windows.miss).toBe(164.5);
  });

  it("uses lazer windows for lazer scores", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(5, ruleset);

    expect(windows.perfect).toBe(19.5);
    expect(windows.great).toBe(49.5);
    expect(windows.good).toBe(82.5);
    expect(windows.ok).toBe(112.5);
    expect(windows.meh).toBe(136.5);
    expect(windows.miss).toBe(173.5);
  });

  it("uses the correct accuracy weights per ruleset", () => {
    const counts = [0, 1, 1, 0, 0, 0, 0];

    expect(calculateReplayAccuracy(counts, "stable")).toBe(100);
    expect(calculateReplayAccuracy(counts, "lazer")).toBeCloseTo(((305 + 300) / (2 * 305)) * 100, 6);
  });

  it("splits hold notes into head and tail judgements", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows);

    expect(simulated.events.filter((event) => event.judgment != null)).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-tail", judgment: 1, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: null,
      headJudgment: 1,
      tailJudgment: 1,
      tailTime: 2000,
    }));
  });

  it("caps the tail to 50 after a dropped hold", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1200, keyState: 0 },
      { time: 1800, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows);

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-break", judgment: null, time: 1200 }),
      expect.objectContaining({ part: "hold-tail", judgment: 5, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: 1200,
      displayJudgment: 1,
      headJudgment: 1,
      tailJudgment: 5,
    }));
  });

  it("applies note lock so earlier notes do not steal later presses", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 1100, endTime: 1100, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1110, keyState: 1 },
      { time: 1120, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows);

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 1,
      headJudgment: 1,
    }));
  });
});
