import { describe, expect, it } from "vitest";
import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";
import { countReplayJudgements, validateReplaySimulation } from "./replay-validation";
import type { ReplayJudgementEvent } from "./mania-replay-judgement";

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
});
