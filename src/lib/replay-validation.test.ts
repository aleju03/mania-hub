import { describe, expect, it } from "vitest";
import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";
import { buildStableReplayComboEvents, countReplayJudgements, resolveReplayJudgementEvents, validateReplaySimulation } from "./replay-validation";
import type { ReplayJudgementEvent, ReplayNoteState } from "./mania-replay-judgement";

describe("replay validation", () => {
  it("converts replay judgement events into osu!mania hit counts", () => {
    const events: ReplayJudgementEvent[] = [
      { column: 0, judgment: 1, noteIndex: 0, offsetMs: 0, part: "note", time: 1000 },
      { column: 0, judgment: 2, noteIndex: 1, offsetMs: 20, part: "note", time: 1020 },
      { column: 0, judgment: 3, noteIndex: 2, offsetMs: 60, part: "note", time: 1060 },
      { column: 0, judgment: 4, noteIndex: 3, offsetMs: 90, part: "note", time: 1090 },
      { column: 0, judgment: 5, noteIndex: 4, offsetMs: -120, part: "note", time: 880 },
      { column: 0, judgment: 6, noteIndex: 5, offsetMs: 160, part: "note", time: 1160 },
      { column: 0, judgment: null, noteIndex: 6, offsetMs: -500, part: "hold-break", time: 1500 },
    ];

    expect(countReplayJudgements(events)).toEqual({
      countGeki: 1,
      count300: 1,
      countKatu: 1,
      count100: 1,
      count50: 1,
      countMiss: 1,
    });
  });

  it("uses stable life-bar timing to choose which ambiguous misses to keep", () => {
    const events: ReplayJudgementEvent[] = [
      { column: 0, judgment: 6, noteIndex: 0, offsetMs: 168.5, part: "note", possibleJudgments: [1, 6], time: 1000 },
      { column: 1, judgment: 6, noteIndex: 1, offsetMs: 168.5, part: "note", possibleJudgments: [1, 6], time: 2000 },
    ];

    const resolved = resolveReplayJudgementEvents(events, {
      countGeki: 1,
      count300: 0,
      countKatu: 0,
      count100: 0,
      count50: 0,
      countMiss: 1,
    }, {
      lifeBarFrames: [
        { time: 900, health: 0.8 },
        { time: 1010, health: 0.55 },
        { time: 1900, health: 0.6 },
        { time: 2010, health: 0.62 },
      ],
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.events.map((event) => event.judgment)).toEqual([6, 1]);
  });

  it("uses stable combo-break timing when life-bar frames are unavailable", () => {
    const events: ReplayJudgementEvent[] = [
      { column: 0, judgment: 6, noteIndex: 0, offsetMs: 168.5, part: "note", possibleJudgments: [1, 6], time: 1000 },
      { column: 1, judgment: 6, noteIndex: 1, offsetMs: 168.5, part: "note", possibleJudgments: [1, 6], time: 2000 },
    ];

    const resolved = resolveReplayJudgementEvents(events, {
      countGeki: 1,
      count300: 0,
      countKatu: 0,
      count100: 0,
      count50: 0,
      countMiss: 1,
    }, {
      comboBreakTimes: [1005],
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.events.map((event) => event.judgment)).toEqual([6, 1]);
  });

  it("keeps missed stable LNs alive for held ticks and breaks again at tail miss", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 2000, isHold: true },
    ];
    const noteStates: ReplayNoteState[] = [
      {
        bodyBreakTime: null,
        bodyBreakTimes: [],
        displayJudgment: 6,
        displayTime: 2000,
        headJudgment: 6,
        headOffsetMs: 180,
        headTime: 1180,
        heldSegments: [{ start: 900, end: 2100 }],
        releaseTime: 2100,
        tailJudgment: 6,
        tailOffsetMs: 0,
        tailTime: 2000,
      },
    ];

    expect(buildStableReplayComboEvents(notes, noteStates)).toEqual([
      { kind: "break", time: 1180 },
      { kind: "hit", time: 1200 },
      { kind: "hit", time: 1300 },
      { kind: "hit", time: 1400 },
      { kind: "hit", time: 1500 },
      { kind: "hit", time: 1600 },
      { kind: "hit", time: 1700 },
      { kind: "hit", time: 1800 },
      { kind: "hit", time: 1900 },
      { kind: "break", time: 2000 },
    ]);
  });

  it("orders delayed stable LN misses before same-end non-miss tail combo hits", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1007, endTime: 2000, isHold: true },
      { column: 1, time: 1007, endTime: 2000, isHold: true },
      { column: 2, time: 1007, endTime: 2000, isHold: true },
      { column: 3, time: 1007, endTime: 2000, isHold: true },
    ];
    const noteStates: ReplayNoteState[] = [
      {
        bodyBreakTime: null,
        bodyBreakTimes: [],
        displayJudgment: 6,
        displayTime: 1130,
        headJudgment: 6,
        headOffsetMs: 130,
        headTime: 1130,
        releaseTime: 0,
        stableMissedInsideConsumedSegment: true,
        tailJudgment: 6,
        tailOffsetMs: 170,
        tailTime: 1130,
      },
      {
        bodyBreakTime: null,
        bodyBreakTimes: [],
        displayJudgment: 6,
        displayTime: 1130,
        headJudgment: 6,
        headOffsetMs: 130,
        headTime: 1130,
        releaseTime: 0,
        stableMissedInsideConsumedSegment: true,
        tailJudgment: 6,
        tailOffsetMs: 170,
        tailTime: 1130,
      },
      {
        bodyBreakTime: null,
        bodyBreakTimes: [],
        displayJudgment: 3,
        displayTime: 2008,
        headJudgment: 3,
        headOffsetMs: 60,
        headTime: 1060,
        heldSegments: [{ start: 1060, end: 2008 }],
        releaseTime: 2008,
        tailJudgment: 3,
        tailOffsetMs: 8,
        tailTime: 2008,
      },
      {
        bodyBreakTime: null,
        bodyBreakTimes: [],
        displayJudgment: 3,
        displayTime: 2008,
        headJudgment: 3,
        headOffsetMs: 60,
        headTime: 1060,
        heldSegments: [{ start: 1060, end: 2008 }],
        releaseTime: 2008,
        tailJudgment: 3,
        tailOffsetMs: 8,
        tailTime: 2008,
      },
    ];

    const endingEvents = buildStableReplayComboEvents(notes, noteStates).filter((event) => event.time >= 2000);

    expect(endingEvents).toEqual([
      { kind: "break", time: 2000 },
      { kind: "break", time: 2000 },
      { kind: "hit", time: 2008 },
      { kind: "hit", time: 2008 },
    ]);
  });

  it("validates simulated replay counts against expected stable counts", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 1, time: 1200, endTime: 1200, isHold: false },
      { column: 0, time: 1500, endTime: 1500, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1010, keyState: 0 },
      { time: 1240, keyState: 2 },
      { time: 1250, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 1,
        count300: 1,
        countKatu: 0,
        count100: 0,
        count50: 0,
        countMiss: 1,
      },
      frames,
      keyCount: 2,
      notes,
      od: 8,
    });

    expect(result.matched).toBe(true);
    expect(result.totalCountDiff).toBe(0);
    expect(result.simulatedAccuracy).toBeCloseTo(result.expectedAccuracy, 6);
  });

  it("resolves lazer legacy replay rounding ambiguity on hold-note tails", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 2000, isHold: true },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1974, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 1,
        count300: 1,
        countKatu: 0,
        count100: 0,
        count50: 0,
        countMiss: 0,
      },
      frames,
      isLazer: true,
      keyCount: 1,
      legacyReplayFrameRounding: true,
      notes,
      od: 7,
    });

    expect(result.rawSimulatedCounts).toEqual({
      countGeki: 2,
      count300: 0,
      countKatu: 0,
      count100: 0,
      count50: 0,
      countMiss: 0,
    });
    expect(result.legacyReplayResolution).toBe("ambiguity");
    expect(result.legacyReplayAmbiguityResolved).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.totalCountDiff).toBe(0);
  });

  it("uses stable sampled replay frame-edge ambiguity for raw scoring", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 1000, keyState: 0 },
      { time: 1017, keyState: 1 },
      { time: 1030, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 1,
        count300: 0,
        countKatu: 0,
        count100: 0,
        count50: 0,
        countMiss: 0,
      },
      frames,
      keyCount: 1,
      legacyReplayFrameRounding: true,
      notes,
      od: 8,
    });

    expect(result.rawSimulatedCounts).toEqual({
      countGeki: 0,
      count300: 1,
      countKatu: 0,
      count100: 0,
      count50: 0,
      countMiss: 0,
    });
    expect(result.legacyReplayResolution).toBe("ambiguity");
    expect(result.legacyReplayAmbiguityResolved).toBe(true);
    expect(result.matched).toBe(true);
  });

  it("treats stable late OK as open on the right edge", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 2000, endTime: 2000, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1111, keyState: 1 },
      { time: 1120, keyState: 0 },
      { time: 2112, keyState: 1 },
      { time: 2120, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 0,
        count300: 0,
        countKatu: 0,
        count100: 1,
        count50: 0,
        countMiss: 1,
      },
      frames,
      keyCount: 1,
      notes,
      od: 5,
    });

    expect(result.matched).toBe(true);
    expect(result.rawSimulatedCounts).toEqual({
      countGeki: 0,
      count300: 0,
      countKatu: 0,
      count100: 1,
      count50: 0,
      countMiss: 1,
    });
  });

  it("cuts stable note hitability off at the next note start", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 1080, endTime: 1080, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1090, keyState: 1 },
      { time: 1100, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 1,
        count300: 0,
        countKatu: 0,
        count100: 0,
        count50: 0,
        countMiss: 1,
      },
      frames,
      keyCount: 1,
      notes,
      od: 5,
    });

    expect(result.matched).toBe(true);
    expect(result.rawSimulatedCounts).toEqual({
      countGeki: 1,
      count300: 0,
      countKatu: 0,
      count100: 0,
      count50: 0,
      countMiss: 1,
    });
  });

  it("allows stable sampled replay gaps to explain short unrecorded hits", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 990, keyState: 0 },
      { time: 1004, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 0,
        count300: 0,
        countKatu: 0,
        count100: 1,
        count50: 0,
        countMiss: 0,
      },
      frames,
      keyCount: 1,
      legacyReplayFrameRounding: true,
      notes,
      od: 8,
    });

    expect(result.rawSimulatedCounts.countMiss).toBe(1);
    expect(result.legacyReplayAmbiguityResolved).toBe(true);
    expect(result.matched).toBe(true);
  });

  it("allows stable sampled early-miss presses to match the stored score bucket", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 860, keyState: 1 },
      { time: 1040, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 1,
        count300: 0,
        countKatu: 0,
        count100: 0,
        count50: 0,
        countMiss: 0,
      },
      frames,
      keyCount: 1,
      legacyReplayFrameRounding: true,
      notes,
      od: 8,
    });

    expect(result.rawSimulatedCounts.countMiss).toBe(1);
    expect(result.legacyReplayAmbiguityResolved).toBe(true);
    expect(result.matched).toBe(true);
  });

  it("allows stable sampled long-note body breaks hidden between pressed samples", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 2000, isHold: true },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 996, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1500, keyState: 1 },
      { time: 1998, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const result = validateReplaySimulation({
      expectedCounts: {
        countGeki: 0,
        count300: 0,
        countKatu: 0,
        count100: 0,
        count50: 1,
        countMiss: 0,
      },
      frames,
      keyCount: 1,
      legacyReplayFrameRounding: true,
      notes,
      od: 8,
    });

    expect(result.rawSimulatedCounts).toEqual({
      countGeki: 1,
      count300: 0,
      countKatu: 0,
      count100: 0,
      count50: 0,
      countMiss: 0,
    });
    expect(result.legacyReplayResolution).toBe("ambiguity");
    expect(result.legacyReplayAmbiguityResolved).toBe(true);
    expect(result.matched).toBe(true);
  });

  it("can reconcile stable sampled replay counts when exact edge ambiguity is insufficient", () => {
    const events: ReplayJudgementEvent[] = [
      { column: 0, judgment: 1, noteIndex: 0, offsetMs: 0, part: "note", time: 1000 },
      { column: 0, judgment: 2, noteIndex: 1, offsetMs: 30, part: "note", time: 1100 },
      { column: 0, judgment: 3, noteIndex: 2, offsetMs: 70, part: "note", time: 1200 },
      { column: 0, judgment: 4, noteIndex: 3, offsetMs: 100, part: "note", time: 1300 },
      { column: 0, judgment: 6, noteIndex: 4, offsetMs: 160, part: "note", time: 1400 },
    ];

    const unresolved = resolveReplayJudgementEvents(events, {
      countGeki: 0,
      count300: 1,
      countKatu: 1,
      count100: 0,
      count50: 2,
      countMiss: 1,
    });
    expect(unresolved.resolved).toBe(false);

    const resolved = resolveReplayJudgementEvents(events, {
      countGeki: 0,
      count300: 1,
      countKatu: 1,
      count100: 0,
      count50: 2,
      countMiss: 1,
    }, { allowLegacyScoreReconciliation: true });

    expect(resolved.resolved).toBe(true);
    expect(resolved.mode).toBe("score-header");
    expect(countReplayJudgements(resolved.events)).toEqual({
      countGeki: 0,
      count300: 1,
      countKatu: 1,
      count100: 0,
      count50: 2,
      countMiss: 1,
    });
  });

  it("does not front-load stable score-header reconciliation onto clean early hits", () => {
    const events: ReplayJudgementEvent[] = [
      { column: 0, judgment: 1, noteIndex: 0, offsetMs: 0, part: "note", possibleJudgments: [1, 2], time: 1000 },
      { column: 1, judgment: 1, noteIndex: 1, offsetMs: 92, part: "note", possibleJudgments: [1, 2], time: 1100 },
      { column: 2, judgment: 6, noteIndex: 2, offsetMs: 171, part: "note", time: 38000 },
      { column: 3, judgment: 1, noteIndex: 3, offsetMs: 16, part: "note", possibleJudgments: [1, 2], time: 39000 },
      { column: 0, judgment: 1, noteIndex: 4, offsetMs: 18, part: "note", possibleJudgments: [1, 2], time: 40000 },
    ];

    const resolved = resolveReplayJudgementEvents(events, {
      countGeki: 2,
      count300: 0,
      countKatu: 1,
      count100: 1,
      count50: 0,
      countMiss: 1,
    }, { allowLegacyScoreReconciliation: true });

    expect(resolved.resolved).toBe(true);
    expect(resolved.mode).toBe("score-header");
    expect(resolved.events.map((event) => event.judgment)).toEqual([1, 1, 6, 4, 3]);
  });

  it("does not force stable score-header reconciliation outside explicit replay ambiguity", () => {
    const events: ReplayJudgementEvent[] = [
      { column: 0, judgment: 1, noteIndex: 0, offsetMs: 0, part: "note", possibleJudgments: [1, 2], time: 1000 },
      { column: 1, judgment: 1, noteIndex: 1, offsetMs: -2, part: "note", possibleJudgments: [1, 2], time: 1100 },
      { column: 2, judgment: 1, noteIndex: 2, offsetMs: -16, part: "note", possibleJudgments: [1, 2], time: 1200 },
    ];

    const resolved = resolveReplayJudgementEvents(events, {
      countGeki: 2,
      count300: 0,
      countKatu: 1,
      count100: 0,
      count50: 0,
      countMiss: 0,
    }, { allowLegacyScoreReconciliation: true });

    expect(resolved.resolved).toBe(false);
    expect(resolved.events.map((event) => event.judgment)).toEqual([1, 1, 1]);
  });
});
