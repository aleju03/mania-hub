import { describe, expect, it } from "vitest";
import type { ManiaNote } from "./beatmap-parser";
import {
  calculateReplayAccuracy,
  getManiaReplayHitWindows,
  getManiaReplayRuleset,
  simulateManiaReplayJudgements,
} from "./mania-replay-judgement";
import { getManiaAccuracyFromCounts, scoreUsesLazerScoring } from "./score";

const hold: ManiaNote = { column: 0, time: 1000, endTime: 2000, isHold: true };

describe("stable ScoreV2 replays", () => {
  it.each(["SV2", "V2"])("recognizes %s without identifying the replay as lazer", (mod) => {
    expect(scoreUsesLazerScoring(null, 20260820)).toBe(false);
    const ruleset = getManiaReplayRuleset(false, ["DT", mod]);
    expect(ruleset.accuracyMode).toBe("stable-scorev2");
    expect(ruleset.speedMultiplier).toBe(1.5);
    expect(ruleset.useClassicWindows).toBe(false);
    expect(getManiaReplayHitWindows(5, ruleset).perfect).toBe(29.5);
    expect(getManiaReplayHitWindows(5, getManiaReplayRuleset(false, ["DT"])).perfect).toBe(24.5);
  });

  it("counts the head and tail separately, with lenient release windows", () => {
    const ruleset = getManiaReplayRuleset(false, ["SV2"]);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const { events } = simulateManiaReplayJudgements(
      [hold], [[{ start: 1030, end: 2025 }]], 1, windows, ruleset.accuracyMode,
    );
    expect(events.map(({ part, judgment, time }) => ({ part, judgment, time }))).toEqual([
      { part: "hold-head", judgment: 2, time: 1030 },
      { part: "hold-tail", judgment: 1, time: 2025 },
    ]);
  });

  it("caps a re-grabbed hold's tail after a body break", () => {
    const ruleset = getManiaReplayRuleset(false, ["SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [hold], [[{ start: 1000, end: 1200 }, { start: 1800, end: 2000 }]], 1,
      getManiaReplayHitWindows(5, ruleset), ruleset.accuracyMode,
    );
    expect(events.map(({ part, judgment }) => [part, judgment])).toEqual([
      ["hold-head", 1], ["hold-break", null], ["hold-tail", 5],
    ]);
  });

  it("keeps the re-grab press with the broken hold instead of reusing it for the next note", () => {
    const ruleset = getManiaReplayRuleset(false, ["SV2"]);
    const notes = [hold, { column: 0, time: 2050, endTime: 2050, isHold: false }];
    // This release breaks the hold well before the tail's input window.
    const { events } = simulateManiaReplayJudgements(notes, [[
      { start: 1000, end: 1600 },
      { start: 1980, end: 2010 },
      { start: 2055, end: 2070 },
    ]], 1, getManiaReplayHitWindows(5, ruleset), ruleset.accuracyMode);
    expect(events.map(({ part, judgment, time }) => [part, judgment, time])).toEqual([
      ["hold-head", 1, 1000],
      ["hold-break", null, 1600],
      ["hold-tail", 5, 1863.5],
      ["note", 1, 2055],
    ]);
  });

  it("leaves a press after the broken hold's deadline available to the next note", () => {
    const ruleset = getManiaReplayRuleset(false, ["SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [hold, { column: 0, time: 2300, endTime: 2300, isHold: false }],
      [[{ start: 1000, end: 1500 }, { start: 2300, end: 2320 }]],
      1, getManiaReplayHitWindows(5, ruleset), ruleset.accuracyMode,
    );
    expect(events.filter((event) => event.part === "hold-tail").map((event) => event.judgment)).toEqual([5]);
    expect(events.at(-1)).toMatchObject({ part: "note", judgment: 1, time: 2300 });
  });

  it("consumes a recovery press for a missed head before judging the following note", () => {
    const ruleset = getManiaReplayRuleset(false, ["SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [hold, { column: 0, time: 2025, endTime: 2025, isHold: false }],
      [[{ start: 1950, end: 2020 }, { start: 2030, end: 2050 }]],
      1, getManiaReplayHitWindows(5, ruleset), ruleset.accuracyMode,
    );
    expect(events.map(({ part, judgment }) => [part, judgment])).toEqual([
      ["hold-head", 6], ["hold-tail", 5], ["note", 1],
    ]);
  });

  it("retains stable's late OK cutoff instead of accepting lazer's late Meh", () => {
    const ruleset = getManiaReplayRuleset(false, ["SV2"]);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const note = { ...hold, endTime: hold.time, isHold: false };
    const segments = [[{ start: 1120, end: 1130 }]];
    const stable = simulateManiaReplayJudgements([note], segments, 1, windows, ruleset.accuracyMode);
    const lazer = simulateManiaReplayJudgements([note], segments, 1, windows, "lazer");
    expect(stable.events[0].judgment).toBe(6);
    expect(lazer.events[0].judgment).toBe(5);
  });

  it("gates early DT input on the unscaled miss window, including early Meh taps", () => {
    const ruleset = getManiaReplayRuleset(false, ["DT", "SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [{ column: 0, time: 1000, endTime: 1000, isHold: false }],
      [[{ start: 832, end: 834 }, { start: 837, end: 900 }]],
      1, getManiaReplayHitWindows(7.6, ruleset), ruleset.accuracyMode,
      { speedMultiplier: 1.5 },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ judgment: 5, time: 837, offsetMs: -163 });
  });

  it.each([
    { previousFrame: 1149, nextJudgment: 1, nextHitTime: 1323 },
    { previousFrame: 1156, nextJudgment: 5, nextHitTime: 1157 },
  ])("uses the previous replay frame to expire a tap ($previousFrame)", ({ previousFrame, nextJudgment, nextHitTime }) => {
    const ruleset = getManiaReplayRuleset(false, ["DT", "SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [1000, 1320].map((time) => ({ column: 0, time, endTime: time, isHold: false })),
      [[{ startPrevious: previousFrame, start: 1157, end: 1200 }, { startPrevious: 1310, start: 1323, end: 1400 }]],
      1, getManiaReplayHitWindows(7.6, ruleset), ruleset.accuracyMode,
      { speedMultiplier: 1.5, legacyReplayFrameRounding: true },
    );
    expect(events.find((event) => event.noteIndex === 0)?.judgment).toBe(6);
    expect(events.find((event) => event.noteIndex === 1)).toMatchObject({ judgment: nextJudgment, time: nextHitTime });
  });

  it("gives an input at the next note's exact timestamp to that note", () => {
    const ruleset = getManiaReplayRuleset(false, ["DT", "SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [66000, 66128].map((time) => ({ column: 0, time, endTime: time, isHold: false })),
      [[{ startPrevious: 66120, start: 66128, end: 66200 }]],
      1, getManiaReplayHitWindows(7.6, ruleset), ruleset.accuracyMode,
      { speedMultiplier: 1.5, legacyReplayFrameRounding: true },
    );
    expect(events.find((event) => event.noteIndex === 0)?.judgment).toBe(6);
    expect(events.find((event) => event.noteIndex === 1)).toMatchObject({ judgment: 1, time: 66128 });
  });

  it("does not let an untouched hold grab input after its tail has passed", () => {
    const ruleset = getManiaReplayRuleset(false, ["DT", "SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [{ ...hold, endTime: 1100 }, { column: 0, time: 1250, endTime: 1250, isHold: false }],
      [[{ startPrevious: 1205, start: 1210, end: 1260 }]],
      1, getManiaReplayHitWindows(7.6, ruleset), ruleset.accuracyMode,
      { speedMultiplier: 1.5, legacyReplayFrameRounding: true },
    );
    expect(events.filter((event) => event.noteIndex === 0).map((event) => event.judgment)).toEqual([6, 6]);
    expect(events.find((event) => event.noteIndex === 1)).toMatchObject({ judgment: 2, time: 1210 });
  });

  it.each([
    { offset: -91, judgment: 2 }, { offset: -92, judgment: 3 },
    { offset: -166, judgment: 3 }, { offset: -167, judgment: 4 },
  ])("truncates the tail window before applying release lenience ($offset)", ({ offset, judgment }) => {
    const ruleset = getManiaReplayRuleset(false, ["DT", "SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [hold], [[{ start: 1000, end: 2000 + offset }]],
      1, getManiaReplayHitWindows(7.6, ruleset), ruleset.accuracyMode, { speedMultiplier: 1.5 },
    );
    expect(events.find((event) => event.part === "hold-tail")?.judgment).toBe(judgment);
  });

  it("misses both components of an untouched hold", () => {
    const ruleset = getManiaReplayRuleset(false, ["SV2"]);
    const { events } = simulateManiaReplayJudgements(
      [hold], [[]], 1, getManiaReplayHitWindows(5, ruleset), ruleset.accuracyMode,
    );
    expect(events.map(({ part, judgment }) => [part, judgment])).toEqual([
      ["hold-head", 6], ["hold-tail", 6],
    ]);
  });

  it("matches the captured 83.36% accuracy from SWADEEF's ScoreV2 header", () => {
    const counts = [0, 2762, 2746, 1712, 633, 142, 182];
    expect(calculateReplayAccuracy(counts, "stable-scorev2")).toBeCloseTo(83.360966, 6);
    const stats = { count_geki: 2762, count_300: 2746, count_katu: 1712, count_100: 633, count_50: 142, count_miss: 182 };
    expect(getManiaAccuracyFromCounts(stats, false, ["DT", "SV2"]) * 100).toBeCloseTo(83.360966, 6);
    expect(getManiaAccuracyFromCounts(stats, false) * 100).toBeCloseTo(84.187355, 6);
  });
});
