import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";
import type { Judgment, ReplayAccuracyMode, ReplayJudgementEvent, ReplayNoteState } from "./mania-replay-judgement.ts";
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
  expectedMaxCombo: number | null;
  expectedAccuracy: number;
  expectedCounts: ReplayHitCounts;
  legacyReplayAmbiguityResolved: boolean;
  legacyReplayResolution: "none" | "ambiguity" | "combo-header" | "score-header";
  matched: boolean;
  maxComboDiff: number | null;
  rawSimulatedCounts: ReplayHitCounts;
  simulatedAccuracy: number;
  simulatedCounts: ReplayHitCounts;
  simulatedMaxCombo: number;
  totalCountDiff: number;
  totalExpected: number;
  totalSimulated: number;
  diffs: ReplayHitCounts;
}

export interface ReplayValidationInput {
  expectedCounts: ReplayHitCounts;
  expectedMaxCombo?: number | null;
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

export function calculateReplayMaxCombo(
  events: ReplayJudgementEvent[],
  options: { initialCombo?: number } = {},
): number {
  const initialCombo = options.initialCombo ?? 0;
  let combo = Math.max(0, Math.floor(initialCombo));
  let maxCombo = combo;

  for (const event of events) {
    if (event.judgment == null || event.judgment === 6) {
      combo = 0;
    } else if (event.judgment >= 1 && event.judgment <= 5) {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
    }
  }

  return maxCombo;
}

type ReplayComboEvent = { kind: "break" | "hit"; time: number };

function calculateReplayComboEventsMaxCombo(events: ReplayComboEvent[]): number {
  let combo = 0;
  let maxCombo = 0;

  for (const event of events) {
    if (event.kind === "break") {
      combo = 0;
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
    }
  }

  return maxCombo;
}

export function buildStableReplayComboEvents(notes: ManiaNote[], noteStates: ReplayNoteState[]): ReplayComboEvent[] {
  const events: ReplayComboEvent[] = [];

  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    const state = noteStates[index];
    if (!state) continue;

    const isHold = note.isHold && note.endTime > note.time;
    if (!isHold) {
      events.push({
        kind: state.headJudgment === 6 ? "break" : "hit",
        time: state.headTime,
      });
      continue;
    }

    if (state.headJudgment === 6) {
      events.push({ kind: "break", time: state.headTime });
      continue;
    }

    if (state.bodyBreakTime != null) {
      events.push({ kind: "break", time: state.bodyBreakTime });
    }
    if (state.tailJudgment === 6) {
      events.push({ kind: "break", time: state.tailTime ?? note.endTime });
    }

    for (let time = note.time; time <= note.endTime + 1e-6; time += 100) {
      if (time >= state.headTime - 1e-6) {
        events.push({ kind: "hit", time });
      }
    }
  }

  return events.sort((a, b) => a.time - b.time || (a.kind === "break" ? -1 : 1));
}

export function calculateReplayMaxComboForMode(
  accuracyMode: ReplayAccuracyMode,
  judgementEvents: ReplayJudgementEvent[],
  notes: ManiaNote[],
  noteStates: ReplayNoteState[],
): number {
  if (accuracyMode === "stable") {
    return calculateReplayComboEventsMaxCombo(buildStableReplayComboEvents(notes, noteStates));
  }

  return calculateReplayMaxCombo(judgementEvents);
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

function possibleCountedJudgmentsForEvent(event: ReplayJudgementEvent): Exclude<Judgment, 0>[] {
  const possible = uniqueCountedJudgments(event.possibleJudgments);
  if (possible.length > 0) return possible;
  return isCountedJudgment(event.judgment) ? [event.judgment] : [];
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

function getReplayJudgmentTargets(counts: ReplayHitCounts): number[] {
  return replayHitCountsToArray(counts);
}

function getReplayBreakerCandidateData(events: ReplayJudgementEvent[]) {
  const counted: Array<{
    eventIndex: number;
    canHit: boolean;
    canMiss: boolean;
    mustMiss: boolean;
    possible: Exclude<Judgment, 0>[];
  }> = [];
  const forcedBreaks: number[] = [];

  for (const [eventIndex, event] of events.entries()) {
    if (event.judgment == null) {
      forcedBreaks.push(counted.length);
      continue;
    }

    const possible = possibleCountedJudgmentsForEvent(event);
    if (possible.length === 0) continue;

    counted.push({
      eventIndex,
      canHit: possible.some((judgment) => judgment >= 1 && judgment <= 5),
      canMiss: possible.includes(6),
      mustMiss: possible.every((judgment) => judgment === 6),
      possible,
    });
  }

  return { counted, forcedBreaks };
}

function hasForcedBreakInside(forcedBreaks: number[], start: number, end: number): boolean {
  return forcedBreaks.some((breakIndex) => breakIndex > start && breakIndex <= end);
}

function calculateComboFromMissSet(
  countedLength: number,
  forcedBreaks: number[],
  missIndexes: Set<number>,
): number {
  let combo = 0;
  let maxCombo = 0;
  let forcedCursor = 0;

  for (let index = 0; index < countedLength; index++) {
    while (forcedCursor < forcedBreaks.length && forcedBreaks[forcedCursor] <= index) {
      combo = 0;
      forcedCursor++;
    }

    if (missIndexes.has(index)) {
      combo = 0;
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
    }
  }

  return maxCombo;
}

function enforceMaxComboOutsideProtectedRun(
  counted: ReturnType<typeof getReplayBreakerCandidateData>["counted"],
  forcedBreaks: number[],
  protectedStart: number,
  protectedEnd: number,
  targetMaxCombo: number,
  missIndexes: Set<number>,
): boolean {
  let combo = 0;
  let lastMissCandidate = -1;
  let forcedCursor = 0;

  for (let index = 0; index < counted.length; index++) {
    while (forcedCursor < forcedBreaks.length && forcedBreaks[forcedCursor] <= index) {
      combo = 0;
      lastMissCandidate = -1;
      forcedCursor++;
    }

    if (index >= protectedStart && index <= protectedEnd) {
      combo++;
      continue;
    }

    if (missIndexes.has(index) || counted[index].mustMiss) {
      missIndexes.add(index);
      combo = 0;
      lastMissCandidate = -1;
      continue;
    }

    if (counted[index].canMiss) lastMissCandidate = index;
    combo++;

    if (combo > targetMaxCombo) {
      if (lastMissCandidate < 0 || lastMissCandidate >= protectedStart && lastMissCandidate <= protectedEnd) {
        return false;
      }
      missIndexes.add(lastMissCandidate);
      index = lastMissCandidate;
      combo = 0;
      lastMissCandidate = -1;
    }
  }

  return true;
}

function chooseMissesForExpectedMaxCombo(
  events: ReplayJudgementEvent[],
  expectedCounts: ReplayHitCounts,
  expectedMaxCombo: number,
): Set<number> | null {
  const targetMisses = expectedCounts.countMiss;
  if (targetMisses < 0 || expectedMaxCombo <= 0) return null;

  const { counted, forcedBreaks } = getReplayBreakerCandidateData(events);
  if (counted.length === 0) return null;

  const forcedBreakSet = new Set(forcedBreaks);
  const runLength = Math.floor(expectedMaxCombo);

  for (let start = 0; start + runLength <= counted.length; start++) {
    const end = start + runLength - 1;
    if (hasForcedBreakInside(forcedBreaks, start, end)) continue;

    let protectedRunCanHit = true;
    for (let index = start; index <= end; index++) {
      if (!counted[index].canHit || counted[index].mustMiss) {
        protectedRunCanHit = false;
        break;
      }
    }
    if (!protectedRunCanHit) continue;

    const leftBreak = start - 1;
    const rightBreak = end + 1;
    const leftOk = start === 0 || forcedBreakSet.has(start) || counted[leftBreak]?.canMiss;
    const rightOk = end === counted.length - 1 || forcedBreakSet.has(rightBreak) || counted[rightBreak]?.canMiss;
    if (!leftOk || !rightOk) continue;

    const missIndexes = new Set<number>();
    if (leftBreak >= 0 && !forcedBreakSet.has(start)) missIndexes.add(leftBreak);
    if (rightBreak < counted.length && !forcedBreakSet.has(rightBreak)) missIndexes.add(rightBreak);

    for (let index = 0; index < counted.length; index++) {
      if (index >= start && index <= end) continue;
      if (counted[index].mustMiss) missIndexes.add(index);
    }

    if (!enforceMaxComboOutsideProtectedRun(counted, forcedBreaks, start, end, runLength, missIndexes)) {
      continue;
    }
    if (missIndexes.size > targetMisses) continue;

    for (let index = 0; index < counted.length && missIndexes.size < targetMisses; index++) {
      if (index >= start && index <= end) continue;
      if (missIndexes.has(index) || !counted[index].canMiss) continue;
      missIndexes.add(index);
    }

    if (missIndexes.size !== targetMisses) continue;
    if (calculateComboFromMissSet(counted.length, forcedBreaks, missIndexes) !== runLength) continue;

    return missIndexes;
  }

  return null;
}

function resolveEventsToExpectedCombo(
  events: ReplayJudgementEvent[],
  expectedCounts: ReplayHitCounts,
  expectedMaxCombo?: number | null,
): ReplayJudgementEvent[] | null {
  if (expectedMaxCombo == null || expectedMaxCombo <= 0) return null;

  const { counted } = getReplayBreakerCandidateData(events);
  const missIndexes = chooseMissesForExpectedMaxCombo(events, expectedCounts, expectedMaxCombo);
  if (!missIndexes) return null;

  const possibleJudgments: Exclude<Judgment, 0>[][] = [];
  const eventIndexes: number[] = [];

  for (let countedIndex = 0; countedIndex < counted.length; countedIndex++) {
    const item = counted[countedIndex];
    const possible = missIndexes.has(countedIndex)
      ? item.possible.filter((judgment) => judgment === 6)
      : item.possible.filter((judgment) => judgment >= 1 && judgment <= 5);

    if (possible.length === 0) return null;
    possibleJudgments.push(possible);
    eventIndexes.push(item.eventIndex);
  }

  const assigned = assignAmbiguousJudgments(possibleJudgments, getReplayJudgmentTargets(expectedCounts));
  if (!assigned) return null;

  const resolvedEvents = events.map((event) => ({ ...event }));
  for (let index = 0; index < eventIndexes.length; index++) {
    resolvedEvents[eventIndexes[index]].judgment = assigned[index];
  }

  const counts = countReplayJudgements(resolvedEvents);
  const diffs = diffReplayHitCounts(counts, expectedCounts);
  if (!Object.values(diffs).every((diff) => diff === 0)) return null;
  if (calculateReplayMaxCombo(resolvedEvents) !== Math.floor(expectedMaxCombo)) return null;

  return resolvedEvents;
}

export function resolveReplayJudgementEvents(
  events: ReplayJudgementEvent[],
  expectedCounts: ReplayHitCounts,
  options: { allowLegacyScoreReconciliation?: boolean; expectedMaxCombo?: number | null } = {},
): { events: ReplayJudgementEvent[]; mode: "none" | "ambiguity" | "combo-header" | "score-header"; resolved: boolean } {
  const comboResolved = resolveEventsToExpectedCombo(events, expectedCounts, options.expectedMaxCombo);
  if (comboResolved) {
    return { events: comboResolved, mode: "combo-header", resolved: true };
  }

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
    return reconciled
      ? { events: reconciled, mode: "score-header", resolved: true }
      : { events, mode: "none", resolved: false };
  }

  const target = replayHitCountsToArray(expectedCounts);
  const remainingTarget = target.map((count, index) => count - fixedCounts[index]);

  if (remainingTarget.slice(1).some((count) => count < 0)) {
    const reconciled = options.allowLegacyScoreReconciliation
      ? reconcileEventsToExpectedCounts(events, expectedCounts)
      : null;
    return reconciled
      ? { events: reconciled, mode: "score-header", resolved: true }
      : { events, mode: "none", resolved: false };
  }
  if (remainingTarget.slice(1).reduce((sum, count) => sum + count, 0) !== ambiguous.length) {
    const reconciled = options.allowLegacyScoreReconciliation
      ? reconcileEventsToExpectedCounts(events, expectedCounts)
      : null;
    return reconciled
      ? { events: reconciled, mode: "score-header", resolved: true }
      : { events, mode: "none", resolved: false };
  }

  const assigned = assignAmbiguousJudgments(ambiguous, remainingTarget);
  if (!assigned) {
    const reconciled = options.allowLegacyScoreReconciliation
      ? reconcileEventsToExpectedCounts(events, expectedCounts)
      : null;
    return reconciled
      ? { events: reconciled, mode: "score-header", resolved: true }
      : { events, mode: "none", resolved: false };
  }

  const resolvedEvents = events.map((event) => ({ ...event }));
  for (let i = 0; i < ambiguousEventIndexes.length; i++) {
    resolvedEvents[ambiguousEventIndexes[i]].judgment = assigned[i];
  }

  return { events: resolvedEvents, mode: "ambiguity", resolved: true };
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
          expectedMaxCombo: input.expectedMaxCombo,
        })
      : null;
  const ambiguityResolvedCounts = resolvedEvents?.resolved
    ? countReplayJudgements(resolvedEvents.events)
    : null;
  const finalEvents = resolvedEvents?.resolved ? resolvedEvents.events : simulated.events;
  const simulatedCounts = ambiguityResolvedCounts ?? rawSimulatedCounts;
  const expectedMaxCombo = input.expectedMaxCombo != null && input.expectedMaxCombo > 0
    ? input.expectedMaxCombo
    : null;
  const simulatedMaxCombo = calculateReplayMaxComboForMode(ruleset.accuracyMode, finalEvents, input.notes, simulated.noteStates);
  const maxComboDiff = expectedMaxCombo == null ? null : simulatedMaxCombo - expectedMaxCombo;
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
    expectedMaxCombo,
    expectedAccuracy,
    expectedCounts: input.expectedCounts,
    legacyReplayAmbiguityResolved: ambiguityResolvedCounts != null,
    legacyReplayResolution: resolvedEvents?.mode ?? "none",
    matched: totalCountDiff === 0,
    maxComboDiff,
    rawSimulatedCounts,
    simulatedAccuracy,
    simulatedCounts,
    simulatedMaxCombo,
    totalCountDiff,
    totalExpected,
    totalSimulated,
    diffs,
  };
}
