import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";
import type { Judgment, ReplayAccuracyMode, ReplayJudgementEvent } from "./mania-replay-judgement.ts";
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
  legacyReplayAmbiguityResolved: boolean;
  matched: boolean;
  rawSimulatedCounts: ReplayHitCounts;
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
  legacyReplayFrameRounding?: boolean;
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

function replayHitCountsFromArray(counts: number[]): ReplayHitCounts {
  return {
    countGeki: counts[1] ?? 0,
    count300: counts[2] ?? 0,
    countKatu: counts[3] ?? 0,
    count100: counts[4] ?? 0,
    count50: counts[5] ?? 0,
    countMiss: counts[6] ?? 0,
  };
}

function isCountedJudgment(judgment: Judgment | null): judgment is Exclude<Judgment, 0> {
  return judgment != null && judgment >= 1 && judgment <= 6;
}

function uniqueCountedJudgments(judgments: Judgment[] | undefined): Exclude<Judgment, 0>[] {
  if (!judgments) return [];
  return [...new Set(judgments)]
    .filter((judgment): judgment is Exclude<Judgment, 0> => judgment >= 1 && judgment <= 6)
    .sort((a, b) => a - b);
}

function canAssignAmbiguousJudgments(
  possibleJudgments: Exclude<Judgment, 0>[][],
  remainingTarget: number[],
): boolean {
  const memo = new Set<string>();

  function search(index: number, remaining: number[]): boolean {
    if (index === possibleJudgments.length) {
      return remaining.slice(1).every((count) => count === 0);
    }

    const key = `${index}:${remaining.slice(1).join(",")}`;
    if (memo.has(key)) return false;

    for (const judgment of possibleJudgments[index]) {
      if (remaining[judgment] <= 0) continue;

      remaining[judgment]--;
      if (search(index + 1, remaining)) return true;
      remaining[judgment]++;
    }

    memo.add(key);
    return false;
  }

  return search(0, [...remainingTarget]);
}

function resolveRoundedReplayAmbiguity(
  events: ReplayJudgementEvent[],
  expectedCounts: ReplayHitCounts,
): ReplayHitCounts | null {
  const fixedCounts = [0, 0, 0, 0, 0, 0, 0];
  const ambiguous: Exclude<Judgment, 0>[][] = [];

  for (const event of events) {
    if (!isCountedJudgment(event.judgment)) continue;

    const possible = uniqueCountedJudgments(event.possibleJudgments);
    if (possible.length > 1) {
      ambiguous.push(possible);
    } else {
      fixedCounts[event.judgment]++;
    }
  }

  if (ambiguous.length === 0) return null;

  const target = replayHitCountsToArray(expectedCounts);
  const remainingTarget = target.map((count, index) => count - fixedCounts[index]);

  if (remainingTarget.slice(1).some((count) => count < 0)) return null;
  if (remainingTarget.slice(1).reduce((sum, count) => sum + count, 0) !== ambiguous.length) return null;

  return canAssignAmbiguousJudgments(ambiguous, remainingTarget)
    ? replayHitCountsFromArray(target)
    : null;
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
    {
      legacyReplayFrameRounding: input.legacyReplayFrameRounding ?? false,
    },
  );
  const rawSimulatedCounts = countReplayJudgements(simulated.events);
  const ambiguityResolvedCounts =
    input.legacyReplayFrameRounding && ruleset.accuracyMode === "lazer"
      ? resolveRoundedReplayAmbiguity(simulated.events, input.expectedCounts)
      : null;
  const simulatedCounts = ambiguityResolvedCounts ?? rawSimulatedCounts;
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
    legacyReplayAmbiguityResolved: ambiguityResolvedCounts != null,
    matched: totalCountDiff === 0,
    rawSimulatedCounts,
    simulatedAccuracy,
    simulatedCounts,
    totalCountDiff,
    totalExpected,
    totalSimulated,
    diffs,
  };
}
