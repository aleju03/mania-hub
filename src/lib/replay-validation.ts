import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame, ReplayLifeBarFrame } from "./types";
import type { Judgment, ManiaReplayMod, ManiaReplayTimingPoint, ReplayAccuracyMode, ReplayJudgementEvent, ReplayNoteState } from "./mania-replay-judgement.ts";
import {
  applyManiaReplayModsToNotes,
  buildReplaySegments,
  calculateReplayAccuracy,
  getManiaReplayHitWindows,
  getManiaReplayModAcronym,
  getManiaReplayModSetting,
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
  legacyReplayResolution: "none" | "ambiguity" | "score-header";
  matched: boolean;
  maxComboDiff: number | null;
  maxComboHeaderApplied: boolean;
  maxComboSource: "judgement-events" | "replay-frame-reconstruction";
  rawSimulatedCounts: ReplayHitCounts;
  simulatedAccuracy: number;
  simulatedCounts: ReplayHitCounts;
  simulatedMaxCombo: number;
  stableComboReconstruction: "approximate" | "visible-frame-match" | null;
  totalCountDiff: number;
  totalExpected: number;
  totalSimulated: number;
  diffs: ReplayHitCounts;
}

export interface ReplayValidationInput {
  allowStableScoreHeaderReconciliation?: boolean;
  expectedCounts: ReplayHitCounts;
  expectedMaxCombo?: number | null;
  comboBreakTimes?: number[];
  frames: ReplayFrame[];
  isConvert?: boolean;
  isLazer?: boolean;
  keyCount: number;
  legacyReplayFrameRounding?: boolean;
  lifeBarFrames?: ReplayLifeBarFrame[];
  mods?: ManiaReplayMod[];
  notes: ManiaNote[];
  od: number;
  resolveLegacyFrameAmbiguity?: boolean;
  timingPoints?: ManiaReplayTimingPoint[];
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

function segmentCoversTime(segment: { start: number; end: number }, time: number): boolean {
  const epsilon = 1e-6;
  return segment.start <= time + epsilon && time < segment.end - epsilon;
}

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
  const delayedMissedHoldEndTimes = new Set<number>();

  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    const state = noteStates[index];
    if (
      state?.headJudgment === 6
      && state.stableMissedInsideConsumedSegment
      && note.isHold
      && note.endTime > note.time
    ) {
      delayedMissedHoldEndTimes.add(note.endTime);
    }
  }

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
      events.push({
        kind: "break",
        time: state.stableMissedInsideConsumedSegment ? note.endTime : state.headTime,
      });
    } else {
      events.push({ kind: "hit", time: state.headTime });
    }

    for (const breakTime of state.bodyBreakTimes ?? (state.bodyBreakTime == null ? [] : [state.bodyBreakTime])) {
      events.push({ kind: "break", time: breakTime });
    }
    let tailEventTime: number | null = null;
    if (state.tailJudgment === 6) {
      tailEventTime = state.tailTime ?? note.endTime;
      events.push({ kind: "break", time: tailEventTime });
    } else if (state.tailJudgment != null && delayedMissedHoldEndTimes.has(note.endTime)) {
      tailEventTime = state.tailTime ?? note.endTime;
      events.push({ kind: "hit", time: tailEventTime });
    }

    const heldSegments = state.heldSegments ?? [];
    for (let time = note.time + 100; time <= note.endTime + 1e-6; time += 100) {
      if (tailEventTime != null && time >= tailEventTime - 1e-6) break;
      if (time >= state.headTime - 1e-6 && heldSegments.some((segment) => segmentCoversTime(segment, time))) {
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

function getLifeBarDropScore(lifeBarFrames: ReplayLifeBarFrame[] | undefined, time: number): number {
  if (!lifeBarFrames || lifeBarFrames.length < 2) return 0;

  const beforeMs = 250;
  const afterMs = 650;
  const maxDistance = Math.max(beforeMs, afterMs);
  let bestDrop = 0;

  for (let index = 1; index < lifeBarFrames.length; index++) {
    const frame = lifeBarFrames[index];
    if (frame.time < time - beforeMs) continue;
    if (frame.time > time + afterMs) break;

    const previous = lifeBarFrames[index - 1];
    const drop = previous.health - frame.health;
    if (drop <= 0.005) continue;

    const distance = Math.abs(frame.time - time);
    const proximity = Math.max(0, 1 - distance / maxDistance);
    bestDrop = Math.max(bestDrop, drop * proximity);
  }

  return bestDrop;
}

function getNearbyComboBreakScore(comboBreakTimes: number[] | undefined, time: number): number {
  if (!comboBreakTimes || comboBreakTimes.length === 0) return 0;

  const windowMs = 140;
  let bestScore = 0;
  for (const breakTime of comboBreakTimes) {
    if (breakTime < time - windowMs) continue;
    if (breakTime > time + windowMs) break;

    const proximity = 1 - Math.abs(breakTime - time) / windowMs;
    bestScore = Math.max(bestScore, proximity);
  }

  return bestScore;
}

function getJudgmentAssignmentCost(
  event: ReplayJudgementEvent,
  targetJudgment: Exclude<Judgment, 0>,
  lifeBarFrames: ReplayLifeBarFrame[] | undefined,
  comboBreakTimes: number[] | undefined,
): number {
  const currentJudgment = isCountedJudgment(event.judgment) ? event.judgment : targetJudgment;
  const possible = uniqueCountedJudgments(event.possibleJudgments);
  const explicitlyPossible = possible.length === 0 || possible.includes(targetJudgment);
  const timingEvidence = Math.max(
    getLifeBarDropScore(lifeBarFrames, event.time) * 4,
    getNearbyComboBreakScore(comboBreakTimes, event.time),
  );
  const offsetWeight = Math.min(200, Math.abs(event.offsetMs)) * 0.25;
  let cost = Math.abs(targetJudgment - currentJudgment) * 10 + (explicitlyPossible ? 0 : 500);

  if (targetJudgment === currentJudgment) cost -= 20;
  if (targetJudgment > currentJudgment) cost -= offsetWeight;
  else if (targetJudgment < currentJudgment) cost += offsetWeight;

  if (targetJudgment === 6) {
    cost += timingEvidence > 0 ? -1000 - timingEvidence * 1000 : 300;
  } else if (currentJudgment === 6) {
    cost += timingEvidence > 0 ? 400 : -200;
  }

  return cost;
}

function assignTimelineAwareAmbiguousJudgments(
  events: ReplayJudgementEvent[],
  ambiguousEventIndexes: number[],
  possibleJudgments: Exclude<Judgment, 0>[][],
  remainingTarget: number[],
  lifeBarFrames: ReplayLifeBarFrame[] | undefined,
  comboBreakTimes: number[] | undefined,
): Exclude<Judgment, 0>[] | null {
  if ((!lifeBarFrames || lifeBarFrames.length < 2) && (!comboBreakTimes || comboBreakTimes.length === 0)) return null;

  const assigned = new Array<Exclude<Judgment, 0> | null>(possibleJudgments.length).fill(null);
  const remaining = [...remainingTarget];
  let neededMisses = remaining[6];

  if (neededMisses > 0) {
    const missCandidates = possibleJudgments
      .map((possible, ambiguousIndex) => ({ possible, ambiguousIndex }))
      .filter(({ possible }) => possible.includes(6))
      .map(({ ambiguousIndex }) => {
        const event = events[ambiguousEventIndexes[ambiguousIndex]];
        return {
          ambiguousIndex,
          cost: getJudgmentAssignmentCost(event, 6, lifeBarFrames, comboBreakTimes),
        };
      })
      .sort((a, b) => a.cost - b.cost || ambiguousEventIndexes[a.ambiguousIndex] - ambiguousEventIndexes[b.ambiguousIndex]);

    for (const candidate of missCandidates) {
      if (neededMisses <= 0) break;
      assigned[candidate.ambiguousIndex] = 6;
      neededMisses--;
    }

    if (neededMisses > 0) return null;
    remaining[6] = 0;
  }

  const unassignedIndexes = assigned
    .map((judgment, ambiguousIndex) => judgment == null ? ambiguousIndex : -1)
    .filter((ambiguousIndex) => ambiguousIndex >= 0);
  const remainingAssignments = assignAmbiguousJudgments(
    unassignedIndexes.map((ambiguousIndex) => possibleJudgments[ambiguousIndex].filter((judgment) => judgment !== 6)),
    remaining,
  );
  if (!remainingAssignments) return null;

  for (let index = 0; index < unassignedIndexes.length; index++) {
    assigned[unassignedIndexes[index]] = remainingAssignments[index];
  }

  return assigned.every((judgment): judgment is Exclude<Judgment, 0> => judgment != null)
    ? assigned
    : null;
}

function reconcileEventsToExpectedCounts(
  events: ReplayJudgementEvent[],
  expectedCounts: ReplayHitCounts,
  lifeBarFrames?: ReplayLifeBarFrame[],
  comboBreakTimes?: number[],
  allowOutsidePossibleAfterTime?: number,
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
      const outsideExplicitPossibility = possible.length > 0 && !possible.includes(targetJudgment as Exclude<Judgment, 0>);
      if (
        outsideExplicitPossibility &&
        (allowOutsidePossibleAfterTime == null || events[index].time < allowOutsidePossibleAfterTime)
      ) {
        continue;
      }

      const isExplicitlyPossible = !outsideExplicitPossibility && possible.includes(targetJudgment as Exclude<Judgment, 0>);
      const cost = (isExplicitlyPossible ? 0 : outsideExplicitPossibility ? 1000 : 100)
        + getJudgmentAssignmentCost(events[index], targetJudgment as Exclude<Judgment, 0>, lifeBarFrames, comboBreakTimes);
      candidatesByJudgment[targetJudgment] ??= [];
      candidatesByJudgment[targetJudgment].push({ cost, index });
    }
  }

  for (const [targetJudgment, candidates] of Object.entries(candidatesByJudgment)) {
    const target = Number(targetJudgment);
    candidates.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost - b.cost;

      const aEvent = events[a.index];
      const bEvent = events[b.index];
      const aOffset = Math.abs(aEvent.offsetMs);
      const bOffset = Math.abs(bEvent.offsetMs);
      const aCurrent = isCountedJudgment(aEvent.judgment) ? aEvent.judgment : target;
      const bCurrent = isCountedJudgment(bEvent.judgment) ? bEvent.judgment : target;

      if (target > aCurrent || target > bCurrent) return bOffset - aOffset;
      if (target < aCurrent || target < bCurrent) return aOffset - bOffset;
      return a.index - b.index;
    });
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
  options: { allowLegacyScoreReconciliation?: boolean; comboBreakTimes?: number[]; lifeBarFrames?: ReplayLifeBarFrame[] } = {},
): { events: ReplayJudgementEvent[]; mode: "none" | "ambiguity" | "score-header"; resolved: boolean } {
  const firstAccuracyBreakTime = events.find((event) => isCountedJudgment(event.judgment) && event.judgment > 2)?.time;
  const reconcileLegacyScoreHeader = () => options.allowLegacyScoreReconciliation
    ? reconcileEventsToExpectedCounts(
        events,
        expectedCounts,
        options.lifeBarFrames,
        options.comboBreakTimes,
        firstAccuracyBreakTime,
      )
    : null;
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
    const reconciled = reconcileLegacyScoreHeader();
    return reconciled
      ? { events: reconciled, mode: "score-header", resolved: true }
      : { events, mode: "none", resolved: false };
  }

  const target = replayHitCountsToArray(expectedCounts);
  const remainingTarget = target.map((count, index) => count - fixedCounts[index]);

  if (remainingTarget.slice(1).some((count) => count < 0)) {
    const reconciled = reconcileLegacyScoreHeader();
    return reconciled
      ? { events: reconciled, mode: "score-header", resolved: true }
      : { events, mode: "none", resolved: false };
  }
  if (remainingTarget.slice(1).reduce((sum, count) => sum + count, 0) !== ambiguous.length) {
    const reconciled = reconcileLegacyScoreHeader();
    return reconciled
      ? { events: reconciled, mode: "score-header", resolved: true }
      : { events, mode: "none", resolved: false };
  }

  const assigned = assignTimelineAwareAmbiguousJudgments(
    events,
    ambiguousEventIndexes,
    ambiguous,
    remainingTarget,
    options.lifeBarFrames,
    options.comboBreakTimes,
  ) ?? assignAmbiguousJudgments(ambiguous, remainingTarget);
  if (!assigned) {
    const reconciled = reconcileLegacyScoreHeader();
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
  const mods = input.mods ?? [];
  const modAcronyms = mods.map(getManiaReplayModAcronym);
  const ruleset = getManiaReplayRuleset(input.isLazer ?? false, modAcronyms, input.isConvert ?? false);
  const notes = applyManiaReplayModsToNotes(input.notes, input.keyCount, mods, {
    timingPoints: input.timingPoints,
  });
  const difficultyAdjustMod = mods[modAcronyms.indexOf("DA")];
  const overriddenOd = Number(getManiaReplayModSetting(difficultyAdjustMod, ["overall_difficulty", "overallDifficulty"]));
  const hitWindows = getManiaReplayHitWindows(Number.isFinite(overriddenOd) ? overriddenOd : input.od, ruleset);
  const frameDuration = input.frames.length > 0 ? input.frames[input.frames.length - 1].time : 0;
  const noteDuration = notes.length > 0 ? Math.max(...notes.map((note) => note.endTime)) : 0;
  const totalDuration = Math.max(frameDuration, noteDuration + hitWindows.miss * 1.5);
  const segments = buildReplaySegments(input.frames, input.keyCount, totalDuration);
  const simulated = simulateManiaReplayJudgements(
    notes,
    segments,
    input.keyCount,
    hitWindows,
    ruleset.accuracyMode,
    {
      lazerNoReleaseTails: modAcronyms.includes("NR"),
      legacyReplayFrameRounding: input.legacyReplayFrameRounding ?? false,
      speedMultiplier: ruleset.speedMultiplier,
    },
  );
  const rawSimulatedCounts = countReplayJudgements(simulated.events);
  const comboBreakTimes = input.comboBreakTimes
    ?? (ruleset.accuracyMode === "stable"
      ? buildStableReplayComboEvents(notes, simulated.noteStates)
          .filter((event) => event.kind === "break")
          .map((event) => event.time)
      : undefined);
  const resolvedEvents =
    input.legacyReplayFrameRounding && (input.resolveLegacyFrameAmbiguity ?? true)
      ? resolveReplayJudgementEvents(simulated.events, input.expectedCounts, {
          allowLegacyScoreReconciliation: Boolean(input.allowStableScoreHeaderReconciliation) && ruleset.accuracyMode === "stable",
          comboBreakTimes,
          lifeBarFrames: input.lifeBarFrames,
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
  const simulatedMaxCombo = calculateReplayMaxComboForMode(ruleset.accuracyMode, finalEvents, notes, simulated.noteStates);
  const maxComboDiff = expectedMaxCombo == null ? null : simulatedMaxCombo - expectedMaxCombo;
  const stableComboReconstruction = ruleset.accuracyMode === "stable"
    ? maxComboDiff === 0 ? "visible-frame-match" : "approximate"
    : null;
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
    maxComboHeaderApplied: false,
    maxComboSource: ruleset.accuracyMode === "stable" ? "replay-frame-reconstruction" : "judgement-events",
    rawSimulatedCounts,
    simulatedAccuracy,
    simulatedCounts,
    simulatedMaxCombo,
    stableComboReconstruction,
    totalCountDiff,
    totalExpected,
    totalSimulated,
    diffs,
  };
}
