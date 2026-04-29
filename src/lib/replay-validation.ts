import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";
import type { ReplayAccuracyMode, ReplayJudgementEvent } from "./mania-replay-judgement.ts";
import {
  buildReplaySegments,
  calculateReplayAccuracy,
  getManiaReplayHitWindows,
  getManiaReplayRuleset,
  simulateManiaReplayJudgements,
} from "./mania-replay-judgement.ts";

export interface ReplayHitCounts {
  countGeki: number;
  count300: number;
  countKatu: number;
  count100: number;
  count50: number;
  countMiss: number;
}

export interface ReplayValidationResult {
  accuracyMode: ReplayAccuracyMode;
  accuracyDiff: number;
  expectedAccuracy: number;
  expectedCounts: ReplayHitCounts;
  matched: boolean;
  simulatedAccuracy: number;
  simulatedCounts: ReplayHitCounts;
  totalCountDiff: number;
  totalExpected: number;
  totalSimulated: number;
  diffs: ReplayHitCounts;
}

export interface ReplayValidationInput {
  expectedCounts: ReplayHitCounts;
  frames: ReplayFrame[];
  isConvert?: boolean;
  isLazer?: boolean;
  keyCount: number;
  mods?: string[];
  notes: ManiaNote[];
  od: number;
}

export function emptyReplayHitCounts(): ReplayHitCounts {
  return {
    countGeki: 0,
    count300: 0,
    countKatu: 0,
    count100: 0,
    count50: 0,
    countMiss: 0,
  };
}

export function countReplayJudgements(events: ReplayJudgementEvent[]): ReplayHitCounts {
  const counts = emptyReplayHitCounts();

  for (const event of events) {
    switch (event.judgment) {
      case 1:
        counts.countGeki++;
        break;
      case 2:
        counts.count300++;
        break;
      case 3:
        counts.countKatu++;
        break;
      case 4:
        counts.count100++;
        break;
      case 5:
        counts.count50++;
        break;
      case 6:
        counts.countMiss++;
        break;
    }
  }

  return counts;
}

export function replayHitCountsToArray(counts: ReplayHitCounts): number[] {
  return [
    0,
    counts.countGeki,
    counts.count300,
    counts.countKatu,
    counts.count100,
    counts.count50,
    counts.countMiss,
  ];
}

export function getReplayHitCountTotal(counts: ReplayHitCounts): number {
  return counts.countGeki + counts.count300 + counts.countKatu + counts.count100 + counts.count50 + counts.countMiss;
}

export function diffReplayHitCounts(
  simulated: ReplayHitCounts,
  expected: ReplayHitCounts,
): ReplayHitCounts {
  return {
    countGeki: simulated.countGeki - expected.countGeki,
    count300: simulated.count300 - expected.count300,
    countKatu: simulated.countKatu - expected.countKatu,
    count100: simulated.count100 - expected.count100,
    count50: simulated.count50 - expected.count50,
    countMiss: simulated.countMiss - expected.countMiss,
  };
}

export function validateReplaySimulation(input: ReplayValidationInput): ReplayValidationResult {
  const ruleset = getManiaReplayRuleset(input.isLazer ?? false, input.mods ?? [], input.isConvert ?? false);
  const hitWindows = getManiaReplayHitWindows(input.od, ruleset);
  const frameDuration = input.frames.length > 0 ? input.frames[input.frames.length - 1].time : 0;
  const noteDuration = input.notes.length > 0 ? Math.max(...input.notes.map((note) => note.endTime)) : 0;
  const totalDuration = Math.max(frameDuration, noteDuration + hitWindows.miss * 1.5);
  const segments = buildReplaySegments(input.frames, input.keyCount, totalDuration);
  const simulated = simulateManiaReplayJudgements(
    input.notes,
    segments,
    input.keyCount,
    hitWindows,
    ruleset.accuracyMode,
  );
  const simulatedCounts = countReplayJudgements(simulated.events);
  const diffs = diffReplayHitCounts(simulatedCounts, input.expectedCounts);
  const totalExpected = getReplayHitCountTotal(input.expectedCounts);
  const totalSimulated = getReplayHitCountTotal(simulatedCounts);
  const expectedAccuracy = calculateReplayAccuracy(replayHitCountsToArray(input.expectedCounts), ruleset.accuracyMode);
  const simulatedAccuracy = calculateReplayAccuracy(replayHitCountsToArray(simulatedCounts), ruleset.accuracyMode);
  const totalCountDiff = Math.abs(diffs.countGeki)
    + Math.abs(diffs.count300)
    + Math.abs(diffs.countKatu)
    + Math.abs(diffs.count100)
    + Math.abs(diffs.count50)
    + Math.abs(diffs.countMiss);

  return {
    accuracyMode: ruleset.accuracyMode,
    accuracyDiff: simulatedAccuracy - expectedAccuracy,
    expectedAccuracy,
    expectedCounts: input.expectedCounts,
    matched: totalCountDiff === 0,
    simulatedAccuracy,
    simulatedCounts,
    totalCountDiff,
    totalExpected,
    totalSimulated,
    diffs,
  };
}
