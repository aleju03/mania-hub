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

function assignAmbiguousJudgments(
  possibleJudgments: Exclude<Judgment, 0>[][],
  remainingTarget: number[],
): Exclude<Judgment, 0>[] | null {
  const grouped = new Map<string, { count: number; judgments: Exclude<Judgment, 0>[]; indices: number[] }>();

  for (let index = 0; index < possibleJudgments.length; index++) {
    const judgments = possibleJudgments[index];
    const key = judgments.join(",");
    const group = grouped.get(key);
    if (group) {
      group.count++;
      group.indices.push(index);
    } else {
      grouped.set(key, { count: 1, judgments, indices: [index] });
    }
  }

  const groups = [...grouped.values()];
  const source = 0;
  const groupOffset = 1;
  const judgmentOffset = groupOffset + groups.length;
  const sink = judgmentOffset + 6;
  const graph: Array<Array<{ cap: number; rev: number; to: number }>> = Array.from({ length: sink + 1 }, () => []);
  const groupJudgmentEdges: Array<Array<{ edgeIndex: number; judgment: Exclude<Judgment, 0> }>> = [];

  function addEdge(from: number, to: number, cap: number) {
    const forward = { cap, rev: graph[to].length, to };
    const reverse = { cap: 0, rev: graph[from].length, to: from };
    graph[from].push(forward);
    graph[to].push(reverse);
  }

  for (let index = 0; index < groups.length; index++) {
    const groupNode = groupOffset + index;
    addEdge(source, groupNode, groups[index].count);
    groupJudgmentEdges[index] = [];

    for (const judgment of groups[index].judgments) {
      const edgeIndex = graph[groupNode].length;
      addEdge(groupNode, judgmentOffset + judgment - 1, groups[index].count);
      groupJudgmentEdges[index].push({ edgeIndex, judgment });
    }
  }

  for (let judgment = 1; judgment <= 6; judgment++) {
    addEdge(judgmentOffset + judgment - 1, sink, remainingTarget[judgment]);
  }

  let flow = 0;
  const targetFlow = possibleJudgments.length;

  while (flow < targetFlow) {
    const levels = new Array(graph.length).fill(-1);
    const queue = [source];
    levels[source] = 0;

    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      for (const edge of graph[node]) {
        if (edge.cap > 0 && levels[edge.to] < 0) {
          levels[edge.to] = levels[node] + 1;
          queue.push(edge.to);
        }
      }
    }

    if (levels[sink] < 0) break;

    const iter = new Array(graph.length).fill(0);
    const dfs = (node: number, amount: number): number => {
      if (node === sink) return amount;

      for (let i = iter[node]; i < graph[node].length; i++) {
        iter[node] = i;
        const edge = graph[node][i];
        if (edge.cap <= 0 || levels[node] >= levels[edge.to]) continue;

        const pushed = dfs(edge.to, Math.min(amount, edge.cap));
        if (pushed <= 0) continue;

        edge.cap -= pushed;
        graph[edge.to][edge.rev].cap += pushed;
        return pushed;
      }

      return 0;
    };

    while (flow < targetFlow) {
      const pushed = dfs(source, targetFlow - flow);
      if (pushed <= 0) break;
      flow += pushed;
    }
  }

  if (flow !== targetFlow) return null;

  const assigned = new Array<Exclude<Judgment, 0>>(possibleJudgments.length);

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const groupNode = groupOffset + groupIndex;
    const assignments: Exclude<Judgment, 0>[] = [];

    for (const { edgeIndex, judgment } of groupJudgmentEdges[groupIndex]) {
      const edge = graph[groupNode][edgeIndex];
      const used = graph[edge.to][edge.rev].cap;
      for (let i = 0; i < used; i++) assignments.push(judgment);
    }

    for (let i = 0; i < groups[groupIndex].indices.length; i++) {
      assigned[groups[groupIndex].indices[i]] = assignments[i];
    }
  }

  return assigned;
}

function reconcileEventsToExpectedCounts(
  events: ReplayJudgementEvent[],
  expectedCounts: ReplayHitCounts,
): ReplayJudgementEvent[] | null {
  const current = replayHitCountsToArray(countReplayJudgements(events));
  const target = replayHitCountsToArray(expectedCounts);

  if (current.slice(1).reduce((sum, count) => sum + count, 0) !== target.slice(1).reduce((sum, count) => sum + count, 0)) {
    return null;
  }

  const surplus = current.map((count, index) => count - target[index]);
  const deficits = target.map((count, index) => count - current[index]);
  if (surplus.slice(1).every((count) => count === 0)) return null;

  const resolvedEvents = events.map((event) => ({ ...event }));
  const candidatesByJudgment: Record<number, Array<{ cost: number; index: number }>> = {};

  for (let index = 0; index < events.length; index++) {
    const judgment = events[index].judgment;
    if (!isCountedJudgment(judgment) || surplus[judgment] <= 0) continue;

    const possible = uniqueCountedJudgments(events[index].possibleJudgments);
    for (let targetJudgment = 1; targetJudgment <= 6; targetJudgment++) {
      if (targetJudgment === judgment || deficits[targetJudgment] <= 0) continue;

      const isExplicitlyPossible = possible.includes(targetJudgment as Exclude<Judgment, 0>);
      const cost = (isExplicitlyPossible ? 0 : 100) + Math.abs(targetJudgment - judgment);
      candidatesByJudgment[targetJudgment] ??= [];
      candidatesByJudgment[targetJudgment].push({ cost, index });
    }
  }

  for (const candidates of Object.values(candidatesByJudgment)) {
    candidates.sort((a, b) => a.cost - b.cost || a.index - b.index);
  }

  for (let targetJudgment = 1; targetJudgment <= 6; targetJudgment++) {
    let needed = deficits[targetJudgment];
    if (needed <= 0) continue;

    for (const candidate of candidatesByJudgment[targetJudgment] ?? []) {
      if (needed <= 0) break;

      const currentJudgment = resolvedEvents[candidate.index].judgment;
      if (!isCountedJudgment(currentJudgment) || surplus[currentJudgment] <= 0) continue;

      resolvedEvents[candidate.index].judgment = targetJudgment as Exclude<Judgment, 0>;
      surplus[currentJudgment]--;
      needed--;
    }

    if (needed > 0) return null;
  }

  const reconciledCounts = replayHitCountsFromArray(replayHitCountsToArray(countReplayJudgements(resolvedEvents)));
  const diffs = diffReplayHitCounts(reconciledCounts, expectedCounts);
  return Object.values(diffs).every((diff) => diff === 0) ? resolvedEvents : null;
}

export function resolveReplayJudgementEvents(
  events: ReplayJudgementEvent[],
  expectedCounts: ReplayHitCounts,
  options: { allowLegacyScoreReconciliation?: boolean } = {},
): { events: ReplayJudgementEvent[]; resolved: boolean } {
  const fixedCounts = [0, 0, 0, 0, 0, 0, 0];
  const ambiguous: Exclude<Judgment, 0>[][] = [];
  const ambiguousEventIndexes: number[] = [];

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!isCountedJudgment(event.judgment)) continue;

    const possible = uniqueCountedJudgments(event.possibleJudgments);
    if (possible.length > 1) {
      ambiguous.push(possible);
      ambiguousEventIndexes.push(index);
    } else {
      fixedCounts[event.judgment]++;
    }
  }

  if (ambiguous.length === 0) {
    const reconciled = options.allowLegacyScoreReconciliation
      ? reconcileEventsToExpectedCounts(events, expectedCounts)
      : null;
    return reconciled ? { events: reconciled, resolved: true } : { events, resolved: false };
  }

  const target = replayHitCountsToArray(expectedCounts);
  const remainingTarget = target.map((count, index) => count - fixedCounts[index]);

  if (remainingTarget.slice(1).some((count) => count < 0)) {
    const reconciled = options.allowLegacyScoreReconciliation
      ? reconcileEventsToExpectedCounts(events, expectedCounts)
      : null;
    return reconciled ? { events: reconciled, resolved: true } : { events, resolved: false };
  }
  if (remainingTarget.slice(1).reduce((sum, count) => sum + count, 0) !== ambiguous.length) {
    const reconciled = options.allowLegacyScoreReconciliation
      ? reconcileEventsToExpectedCounts(events, expectedCounts)
      : null;
    return reconciled ? { events: reconciled, resolved: true } : { events, resolved: false };
  }

  const assigned = assignAmbiguousJudgments(ambiguous, remainingTarget);
  if (!assigned) {
    const reconciled = options.allowLegacyScoreReconciliation
      ? reconcileEventsToExpectedCounts(events, expectedCounts)
      : null;
    return reconciled ? { events: reconciled, resolved: true } : { events, resolved: false };
  }

  const resolvedEvents = events.map((event) => ({ ...event }));
  for (let i = 0; i < ambiguousEventIndexes.length; i++) {
    resolvedEvents[ambiguousEventIndexes[i]].judgment = assigned[i];
  }

  return { events: resolvedEvents, resolved: true };
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
  const resolvedEvents =
    input.legacyReplayFrameRounding
      ? resolveReplayJudgementEvents(simulated.events, input.expectedCounts, {
          allowLegacyScoreReconciliation: ruleset.accuracyMode === "stable",
        })
      : null;
  const ambiguityResolvedCounts = resolvedEvents?.resolved
    ? countReplayJudgements(resolvedEvents.events)
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
