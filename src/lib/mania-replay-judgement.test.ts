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

  it("applies stable HR and EZ through OD before calculating classic windows", () => {
    const hardRock = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["HR"]));
    const easy = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["EZ"]));

    expect(hardRock.great).toBe(34.5);
    expect(hardRock.good).toBe(67.5);
    expect(easy.great).toBe(52.5);
    expect(easy.good).toBe(85.5);
  });

  it("applies stable replay-time hit windows for rate-changing mods", () => {
    const normal = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, []));
    const doubleTime = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["DT"]));
    const halfTime = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["HT"]));
    const daycore = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["DC"]));

    expect(doubleTime.great).toBe(60.5);
    expect(halfTime.great).toBe(30.5);
    expect(daycore).toEqual(halfTime);
    expect(normal.great).toBe(40.5);
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

  it("stable mode misses tap notes after the late OK window instead of awarding late 50s", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1120, keyState: 1 },
      { time: 1130, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "note", judgment: 6, time: 1103.5 }),
    ]);
  });

  it("stable mode still allows early 50s on tap notes", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 880, keyState: 1 },
      { time: 890, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "note", judgment: 5, time: 880 }),
    ]);
  });

  it("lazer mode emits separate head and tail judgements for a hold", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

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

  it("lazer mode caps the tail to 50 after a dropped hold", () => {
    const ruleset = getManiaReplayRuleset(true, []);
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
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-break", judgment: null, time: 1200 }),
      expect.objectContaining({ part: "hold-tail", judgment: 5, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: 1200,
      headJudgment: 1,
      tailJudgment: 5,
    }));
  });

  it("lazer mode times out untouched tap notes after the 50 window", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1135, keyState: 1 },
      { time: 1145, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "note", judgment: 6, time: 1127.5 }),
    ]);
  });

  it("lazer mode times out untouched hold tails after the lenient 50 window", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events.filter((event) => event.judgment != null)).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-tail", judgment: 6, time: 2191.25 }),
    ]);
  });

  it("lazer mode times out untouched hold heads after the 50 window", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 2500, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events.filter((event) => event.judgment != null)).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 6, time: 1127.5 }),
      expect.objectContaining({ part: "hold-tail", judgment: 6, time: 2191.25 }),
    ]);
  });

  it("stable mode emits a single combined judgement for a perfectly held LN", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events.filter((event) => event.part !== "hold-break")).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 1, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: null,
      headJudgment: 1,
      tailJudgment: 1,
      displayJudgment: 1,
      tailTime: 2000,
    }));
  });

  it("stable mode caps the combined judgement to 50 after a body break", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1200, keyState: 0 },
      { time: 1950, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-break", judgment: null, time: 1200 }),
      expect.objectContaining({ part: "hold-combined", judgment: 5, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: 1200,
      headJudgment: 1,
      tailJudgment: 5,
      displayJudgment: 5,
    }));
  });

  it("stable mode truncates LN combined judgement thresholds", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2039, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 2, time: 2039 }),
    ]);
  });

  it("stable mode downgrades via the combined hit error tier", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    // windows.perfect = 16.5 → perfect*1.2 = 19.8, perfect*2.4 = 39.6
    // head offset 15 (within 19.8), tail offset 25 (combined = 40) → exceeds perfect tier combined bound
    // Should drop to GREAT (great*1.1 = 44.55, great*2.2 = 89.1) → GREAT passes
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1015, keyState: 1 },
      { time: 2025, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    const combined = simulated.events.find((event) => event.part === "hold-combined");
    expect(combined?.judgment).toBe(2);
    expect(simulated.noteStates[0].headJudgment).toBe(1);
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
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

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
