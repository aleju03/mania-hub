import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

export type Judgment = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ReplayAccuracyMode = "stable" | "lazer";

export interface ReplaySegment {
  start: number;
  end: number;
  endPrevious?: number;
  samples?: number[];
  startPrevious?: number;
}

export interface ManiaReplayHitWindows {
  perfect: number;
  great: number;
  good: number;
  ok: number;
  meh: number;
  miss: number;
}

export interface ManiaReplayRuleset {
  accuracyMode: ReplayAccuracyMode;
  difficultyMultiplier: number;
  isConvert: boolean;
  speedMultiplier: number;
  useClassicWindows: boolean;
}

export interface ReplayJudgementEvent {
  column: number;
  judgment: Judgment | null;
  noteIndex: number;
  offsetMs: number;
  part: "note" | "hold-head" | "hold-tail" | "hold-combined" | "hold-break";
  possibleJudgments?: Judgment[];
  time: number;
}

export interface ManiaReplaySimulationOptions {
  stableBodyBreakCapJudgment?: Judgment | null;
  stableColumnInputOwnership?: boolean;
  legacyReplayFrameRounding?: boolean;
  stableCoarseEdgePlaybackDelay?: number;
  stableCoarsePressPlayback?: boolean;
  stableCoarseReleasePlayback?: boolean;
  stableConsumeHeldSegmentAtLongNoteTimeout?: boolean;
  stableDenseCoarseEdgePlaybackDelay?: number;
  stableDenseForceCoarsePlaybackMaxMedian?: number;
  stableDisableLongNoteHeadRefinement?: boolean;
  stableEnableLongNoteHeadRefinement?: boolean;
  stableHighKeyReleaseDelayCap?: number;
  stableForceCoarsePlayback?: boolean;
  stableAllowCoarseLongNoteHeadRefinement?: boolean;
  stableHeldOkTimeoutAsMiss?: boolean;
  stableHeldOkTimeoutJudgment?: Judgment;
  stableHeldTailTimeoutMode?: "timeout" | "first-sample" | "segment-end";
  stableHighKeyReleaseDelayMaxHeadOffset?: number;
  stableHighKeyReleaseDelayMissOnly?: boolean;
  stableHighKeyReleaseDelayRawThreshold?: number;
  stableMissedInsideConsumedSegmentJudgment?: Judgment;
  stableMissedInsideConsumedNoAdvanceJudgment?: Judgment;
  stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian?: number;
  stablePreHeadReleaseMissRecoveryExcludeBeforeTap?: boolean;
  stablePreHeadReleaseMissRecoveryExcludeNextShortMaxDuration?: number;
  stablePreHeadReleaseMissRecoveryExcludeNextShortMaxGap?: number;
  stablePreHeadReleaseMissRecoveryMaxHeadOffset?: number;
  stablePreHeadReleaseMissRecoveryMaxNextNoteGap?: number;
  stablePreHeadReleaseMissRecoveryMaxTailOffset?: number;
  stablePreHeadReleaseMissRecoveryMinNextNextNoteGap?: number;
  stablePreHeadReleaseMissConsumesRecovery?: boolean;
  stablePreHeadReleaseMissesAtHead?: boolean;
  stablePreserveLongNoteScoringPressAfterBreak?: boolean;
  stablePreserveLongNoteScoringPressAfterTailBreak?: boolean;
  stablePreserveLongNoteScoringPressTime?: boolean;
  stableRequirePreHeadRecoveryForActivation?: boolean;
  stableSuppressHiddenBodyBreakCap?: boolean;
  stableTailEarlyMissLenience?: number;
  stableNextNoteEdgeGrace?: number;
  stablePreciseEdgePosition?: number;
  stableReuseTailSegmentForNextHead?: boolean;
  stableTailSegmentReuseGrace?: number;
  stableTailEdgeGrace?: number;
  speedMultiplier?: number;
}

export interface ReplayNoteState {
  bodyBreakTime: number | null;
  bodyBreakTimes?: number[];
  displayJudgment: Judgment;
  displayTime: number;
  headJudgment: Judgment;
  headOffsetMs: number;
  headTime: number;
  heldSegments?: ReplaySegment[];
  releaseTime: number;
  stableBarelyCrossedTailOnTimeout?: boolean;
  stableConsumedHeldSegmentAtTimeout?: boolean;
  stableHeldOkTimeout?: boolean;
  stableHiddenBodyBreakPossible?: boolean;
  stableLateStartReleasePastOk?: boolean;
  stableMatchedPreviousTailSegment?: boolean;
  stableMatchedSegmentIndex?: number;
  stableMissedInsideConsumedSegment?: boolean;
  stableNextSegmentCursor?: number;
  stablePreHeadReleaseMiss?: boolean;
  stablePreHeadReleaseMissConsumedRecovery?: boolean;
  stablePreHeadPressActivatedLongNote?: boolean;
  stableSegmentCursorAfter?: number;
  stableSegmentCursorBefore?: number;
  stableTailJudgementSourceTime?: number | null;
  stableTailSegmentIndex?: number | null;
  stableTailSegmentReleaseDelay?: number;
  stableTailWasHeldAtJudgement?: boolean;
  stableLastConsumedSegmentIndex?: number;
  stableLastScannedSegmentIndex?: number;
  scoringHeadOffsetMs?: number;
  scoringTailOffsetMs?: number;
  tailJudgment: Judgment | null;
  tailOffsetMs: number;
  tailTime: number | null;
}

const PERFECT_WINDOW_RANGE = { min: 22.4, mid: 19.4, max: 13.9 };
const GREAT_WINDOW_RANGE = { min: 64, mid: 49, max: 34 };
const GOOD_WINDOW_RANGE = { min: 97, mid: 82, max: 67 };
const OK_WINDOW_RANGE = { min: 127, mid: 112, max: 97 };
const MEH_WINDOW_RANGE = { min: 151, mid: 136, max: 121 };
const MISS_WINDOW_RANGE = { min: 188, mid: 173, max: 158 };
const RELEASE_WINDOW_LENIENCE = 1.5;

function difficultyRange(
  difficulty: number,
  min: number,
  mid: number,
  max: number,
): number {
  if (difficulty > 5) {
    return mid + (max - mid) * ((difficulty - 5) / 5);
  }
  if (difficulty < 5) {
    return mid + (mid - min) * ((difficulty - 5) / 5);
  }
  return mid;
}

export function getManiaReplayRuleset(
  isLazer: boolean,
  mods: string[] = [],
  isConvert = false,
  speedMultiplierOverride?: number,
): ManiaReplayRuleset {
  const modSet = new Set(mods.map((mod) => mod.toUpperCase()));
  const speedMultiplier = Number(speedMultiplierOverride);

  return {
    accuracyMode: isLazer ? "lazer" : "stable",
    difficultyMultiplier: modSet.has("HR") ? 1.4 : modSet.has("EZ") ? 1 / 1.4 : 1,
    isConvert,
    speedMultiplier: Number.isFinite(speedMultiplier) && speedMultiplier > 0
      ? speedMultiplier
      : modSet.has("DT") || modSet.has("NC")
        ? 1.5
        : modSet.has("HT") || modSet.has("DC")
          ? 0.75
          : 1,
    useClassicWindows: !isLazer || (modSet.has("CL") && !modSet.has("SV2")),
  };
}

export function applyManiaReplayModsToNotes(
  notes: ManiaNote[],
  keyCount: number,
  mods: string[] = [],
): ManiaNote[] {
  const modSet = new Set(mods.map((mod) => mod.toUpperCase()));
  if (!modSet.has("MR")) return [...notes];

  return notes.map((note) => ({
    ...note,
    column: keyCount - 1 - note.column,
  }));
}

export function getManiaReplayHitWindows(
  od: number,
  ruleset: ManiaReplayRuleset,
): ManiaReplayHitWindows {
  const totalMultiplier = ruleset.speedMultiplier / ruleset.difficultyMultiplier;

  if (ruleset.useClassicWindows) {
    const effectiveOd = od;

    if (ruleset.isConvert) {
      return {
        perfect: Math.floor(16 * totalMultiplier) + 0.5,
        great: Math.floor((Math.round(effectiveOd) > 4 ? 34 : 47) * totalMultiplier) + 0.5,
        good: Math.floor((Math.round(effectiveOd) > 4 ? 67 : 77) * totalMultiplier) + 0.5,
        ok: Math.floor(97 * totalMultiplier) + 0.5,
        meh: Math.floor(121 * totalMultiplier) + 0.5,
        miss: Math.floor(158 * totalMultiplier) + 0.5,
      };
    }

    const invertedOd = 10 - effectiveOd;
    return {
      perfect: Math.floor(16 * totalMultiplier) + 0.5,
      great: Math.floor((34 + 3 * invertedOd) * totalMultiplier) + 0.5,
      good: Math.floor((67 + 3 * invertedOd) * totalMultiplier) + 0.5,
      ok: Math.floor((97 + 3 * invertedOd) * totalMultiplier) + 0.5,
      meh: Math.floor((121 + 3 * invertedOd) * totalMultiplier) + 0.5,
      miss: Math.floor((158 + 3 * invertedOd) * totalMultiplier) + 0.5,
    };
  }

  return {
    perfect: Math.floor(difficultyRange(od, PERFECT_WINDOW_RANGE.min, PERFECT_WINDOW_RANGE.mid, PERFECT_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    great: Math.floor(difficultyRange(od, GREAT_WINDOW_RANGE.min, GREAT_WINDOW_RANGE.mid, GREAT_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    good: Math.floor(difficultyRange(od, GOOD_WINDOW_RANGE.min, GOOD_WINDOW_RANGE.mid, GOOD_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    ok: Math.floor(difficultyRange(od, OK_WINDOW_RANGE.min, OK_WINDOW_RANGE.mid, OK_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    meh: Math.floor(difficultyRange(od, MEH_WINDOW_RANGE.min, MEH_WINDOW_RANGE.mid, MEH_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    miss: Math.floor(difficultyRange(od, MISS_WINDOW_RANGE.min, MISS_WINDOW_RANGE.mid, MISS_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
  };
}

export function buildReplaySegments(
  frames: ReplayFrame[],
  keyCount: number,
  totalDuration: number,
): ReplaySegment[][] {
  const segments: ReplaySegment[][] = Array.from({ length: keyCount }, () => []);
  const active: Array<{ samples: number[]; start: number; startPrevious?: number } | null> = new Array(keyCount).fill(null);
  const previousFrameTimes: Array<number | undefined> = new Array(keyCount).fill(undefined);

  for (const frame of frames) {
    for (let column = 0; column < keyCount; column++) {
      const pressed = (frame.keyState & (1 << column)) !== 0;
      const segment = active[column];
      if (pressed && segment === null) {
        active[column] = { samples: [frame.time], start: frame.time, startPrevious: previousFrameTimes[column] };
      } else if (pressed && segment !== null) {
        segment.samples.push(frame.time);
      } else if (!pressed && segment !== null) {
        segments[column].push({
          start: segment.start,
          end: frame.time,
          endPrevious: segment.samples[segment.samples.length - 1],
          samples: segment.samples,
          startPrevious: segment.startPrevious,
        });
        active[column] = null;
      }
      previousFrameTimes[column] = frame.time;
    }
  }

  for (let column = 0; column < keyCount; column++) {
    const segment = active[column];
    if (segment !== null) {
      segments[column].push({
        start: segment.start,
        end: totalDuration,
        endPrevious: segment.samples[segment.samples.length - 1],
        samples: segment.samples,
        startPrevious: segment.startPrevious,
      });
    }
  }

  return segments;
}

function getJudgmentForOffset(
  offsetMs: number,
  windows: ManiaReplayHitWindows,
): Judgment {
  const delta = Math.abs(offsetMs);
  if (delta <= windows.perfect) return 1;
  if (delta <= windows.great) return 2;
  if (delta <= windows.good) return 3;
  if (delta <= windows.ok) return 4;
  if (delta <= windows.meh) return 5;
  if (delta <= windows.miss) return 6;
  return 0;
}

function capLazerTailJudgment(judgment: Judgment, capToMeh: boolean): Judgment {
  return capToMeh && judgment !== 0 && judgment < 5 ? 5 : judgment;
}

function getRoundedLegacyTailPossibleJudgments(
  rawTailOffsetMs: number,
  windows: ManiaReplayHitWindows,
  capToMeh: boolean,
): Judgment[] {
  const minRaw = rawTailOffsetMs - 0.5;
  const maxRaw = rawTailOffsetMs + 0.5;
  const epsilon = 1e-7;
  const samples = new Set<number>([
    minRaw,
    rawTailOffsetMs,
    maxRaw - epsilon,
  ]);

  for (const window of [
    windows.perfect,
    windows.great,
    windows.good,
    windows.ok,
    windows.meh,
    windows.miss,
  ]) {
    const rawBoundary = window * RELEASE_WINDOW_LENIENCE;

    for (const sign of [-1, 1]) {
      const boundary = sign * rawBoundary;
      if (boundary >= minRaw && boundary < maxRaw) {
        samples.add(boundary - epsilon);
        samples.add(boundary);
        samples.add(boundary + epsilon);
      }
    }
  }

  const possible = new Set<Judgment>();
  for (const raw of samples) {
    let judgment = getJudgmentForOffset(raw / RELEASE_WINDOW_LENIENCE, windows);
    if (judgment === 0) judgment = 6;
    possible.add(capLazerTailJudgment(judgment, capToMeh));
  }

  return [...possible].sort((a, b) => a - b);
}

function getStableHeadJudgmentForOffset(
  offsetMs: number,
  windows: ManiaReplayHitWindows,
): Judgment {
  offsetMs = Math.round(offsetMs);
  // Stable's score-v1 mania late OK window is open. For example, OD5 has
  // late OK at 111ms, while 112ms is already a miss.
  if (offsetMs >= Math.floor(windows.ok)) {
    return offsetMs <= windows.miss ? 6 : 0;
  }
  return getJudgmentForOffset(offsetMs, windows);
}

// Stable .osr data gives us sampled key states, not exact input-edge times.
// When a key flips between two samples, estimate the edge inside that interval
// tightly for high-resolution transitions, and conservatively for coarser
// frame gaps.
const STABLE_PRECISE_EDGE_INTERVAL = 4;
const STABLE_PRECISE_EDGE_POSITION = 1;
const STABLE_COARSE_EDGE_PLAYBACK_DELAY = 0;
const STABLE_COARSE_REPLAY_MEDIAN_TRANSITION = 6;
const STABLE_CROSSED_LN_HEAD_MEDIAN_TRANSITION = 9;
const STABLE_MIN_NEXT_NOTE_EDGE_GRACE = 10;
const STABLE_MAX_NEXT_NOTE_EDGE_GRACE = 15;
const STABLE_TAIL_EDGE_GRACE = 0;
const STABLE_HIDDEN_BODY_BREAK_MIN_GAP = 30;
const STABLE_HIDDEN_BODY_BREAK_MEDIAN_SCALE = 4.5;

function getStablePressEstimate(
  segment: ReplaySegment,
  _targetTime: number,
  useCoarsePlayback: boolean,
  coarsePlaybackDelay: number,
  preciseEdgePosition = STABLE_PRECISE_EDGE_POSITION,
): number {
  const startMin = segment.startPrevious ?? segment.start;
  const lower = Math.min(startMin, segment.start);
  const upper = Math.max(startMin, segment.start);
  if (upper - lower > STABLE_PRECISE_EDGE_INTERVAL) {
    return useCoarsePlayback
      ? segment.start + coarsePlaybackDelay
      : lower + (upper - lower) * preciseEdgePosition;
  }
  return upper;
}

function getStableTapPressEstimate(
  segment: ReplaySegment,
  targetTime: number,
  useCoarsePlayback: boolean,
  coarsePlaybackDelay: number,
  preciseEdgePosition = STABLE_PRECISE_EDGE_POSITION,
): number {
  return getStablePressEstimate(segment, targetTime, useCoarsePlayback, coarsePlaybackDelay, preciseEdgePosition);
}

function getStableReleaseEstimate(
  segment: ReplaySegment,
  _targetTime: number,
  useCoarsePlayback: boolean,
  coarsePlaybackDelay: number,
  preciseEdgePosition = STABLE_PRECISE_EDGE_POSITION,
): number {
  const releaseMin = segment.endPrevious ?? segment.end;
  const lower = Math.min(releaseMin, segment.end);
  const upper = Math.max(releaseMin, segment.end);
  if (upper - lower > STABLE_PRECISE_EDGE_INTERVAL) {
    return useCoarsePlayback
      ? segment.end + coarsePlaybackDelay
      : lower + (upper - lower) * preciseEdgePosition;
  }
  return upper;
}

function getStableHeldTailTimeoutTime(
  segment: ReplaySegment,
  tailTimeout: number,
  mode: ManiaReplaySimulationOptions["stableHeldTailTimeoutMode"],
): number {
  if (mode === "segment-end") return segment.end;
  if (mode === "first-sample") {
    for (const sample of segment.samples ?? []) {
      if (sample >= tailTimeout) return sample;
    }
  }

  return tailTimeout;
}

function getStableSegmentPressRange(segment: ReplaySegment): { min: number; max: number } {
  const startMin = segment.startPrevious ?? segment.start;
  return {
    min: Math.min(startMin, segment.start),
    max: Math.max(startMin, segment.start),
  };
}

function getStableTapPressRange(segment: ReplaySegment): { min: number; max: number } {
  return getStableSegmentPressRange(segment);
}

function getStableNextNoteEdgeGrace(transitionMedian: number): number {
  // Stable .osg comparisons currently favor a fixed next-note edge allowance:
  // sampled edges just past a following object still belong to the earlier
  // active LN often enough that lowering this regresses more exact captures.
  return transitionMedian > 0
    ? STABLE_MAX_NEXT_NOTE_EDGE_GRACE
    : STABLE_MIN_NEXT_NOTE_EDGE_GRACE;
}

function stableRangeIsPastHeadDeadline(rangeMin: number, deadline: number, edgeGrace: number): boolean {
  const grace = edgeGrace > 0 ? edgeGrace : 0;
  return rangeMin > deadline + grace;
}

function getStableColumnInputOwnershipEnd(
  note: ManiaNote,
  nextNote: ManiaNote | null,
  windows: ManiaReplayHitWindows,
): number {
  if (!nextNote) return Number.POSITIVE_INFINITY;

  const meh = Math.floor(windows.meh);
  const gap = nextNote.time - note.time;
  return Math.min(note.time + meh, nextNote.time - 1)
    + Math.max(0, gap - meh * 2);
}

function stableCanBridgeTailEdgeGap(
  segment: ReplaySegment,
  nextSegment: ReplaySegment | undefined,
  tailEarlyBound: number,
  legacyReplayFrameRounding: boolean | undefined,
  edgeGrace: number,
  tailEdgeGrace: number,
): boolean {
  if (!legacyReplayFrameRounding || !nextSegment) return false;
  if (tailEarlyBound - segment.end > tailEdgeGrace) return false;

  const nextRange = getStableSegmentPressRange(nextSegment);
  return nextRange.min <= tailEarlyBound + edgeGrace;
}

function getStableTransitionMedian(segments: ReplaySegment[][]): number {
  const spans: number[] = [];
  for (const columnSegments of segments) {
    for (const segment of columnSegments) {
      if (segment.startPrevious != null) {
        const span = Math.abs(segment.start - segment.startPrevious);
        if (span > 0) spans.push(span);
      }
      if (segment.endPrevious != null) {
        const span = Math.abs(segment.end - segment.endPrevious);
        if (span > 0) spans.push(span);
      }
    }
  }

  if (spans.length === 0) return 0;
  spans.sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)];
}

function getStableHiddenBodyBreakGapThreshold(transitionMedian: number, speedMultiplier: number | undefined): number {
  // DT replays are sampled in beatmap time, so the same real frame gap spans
  // more milliseconds in replay time. Keep the threshold near the first truly
  // skipped-frame gaps there, while using a median-scaled threshold for normal
  // playback so dense, high-fps LN play does not invent dropped holds.
  if (speedMultiplier != null && speedMultiplier > 1.01) {
    return STABLE_HIDDEN_BODY_BREAK_MIN_GAP;
  }

  return Math.max(
    STABLE_HIDDEN_BODY_BREAK_MIN_GAP,
    transitionMedian * STABLE_HIDDEN_BODY_BREAK_MEDIAN_SCALE,
  );
}

function stablePressIsLikelyForNextNote(
  pressTime: number,
  note: ManiaNote,
  nextNote: ManiaNote | null,
): boolean {
  if (!nextNote) return false;
  if (!(note.time < pressTime && pressTime < nextNote.time)) return false;

  return nextNote.time - pressTime < pressTime - note.time;
}

function sampleRangeWithBoundaries(min: number, max: number, boundaries: number[]): number[] {
  if (max < min) return [];

  const epsilon = 1e-7;
  const samples = new Set<number>([min, max]);

  for (const boundary of boundaries) {
    for (const sample of [boundary - epsilon, boundary, boundary + epsilon]) {
      if (sample >= min && sample <= max) samples.add(sample);
    }
  }

  return [...samples];
}

function stableOffsetBoundaries(windows: ManiaReplayHitWindows): number[] {
  return [
    -windows.miss,
    -windows.meh,
    -windows.ok,
    -windows.good,
    -windows.great,
    -windows.perfect,
    windows.perfect,
    windows.great,
    windows.good,
    windows.ok,
    windows.meh,
    windows.miss,
  ];
}

function getStableTapPossibleJudgments(
  segment: ReplaySegment,
  note: ManiaNote,
  windows: ManiaReplayHitWindows,
): Judgment[] {
  const range = getStableTapPressRange(segment);
  const possible = new Set<Judgment>();

  for (const offset of sampleRangeWithBoundaries(
    range.min - note.time,
    range.max - note.time,
    stableOffsetBoundaries(windows),
  )) {
    const judgment = getStableHeadJudgmentForOffset(offset, windows);
    if (judgment !== 0) possible.add(judgment);
  }

  return [...possible].sort((a, b) => a - b);
}

// Stable (ScoreV1) long-note combined judgement rule.
// Wiki: https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu%21mania
// The final judgement for an LN depends on head error AND the combined error
// (|headErr| + |tailErr|). Each tier tightens both independently. Stable's
// dropped-hold flag caps MAX/300 results to GOOD/200.
function judgeStableLongNoteCombined(
  headOffsetMs: number,
  tailOffsetMs: number,
  bodyBreakCapJudgment: Judgment | null,
  windows: ManiaReplayHitWindows,
): Judgment {
  const headErr = Math.abs(Math.round(headOffsetMs));
  const tailErr = Math.abs(Math.round(tailOffsetMs));
  const combinedErr = headErr + tailErr;
  const perfect = Math.floor(windows.perfect);
  const great = Math.floor(windows.great);
  const good = Math.floor(windows.good);
  const ok = Math.floor(windows.ok);

  let result: Judgment;
  if (headErr <= perfect * 1.2 && combinedErr <= perfect * 2.4) {
    result = 1;
  } else if (headErr <= great * 1.1 && combinedErr <= great * 2.2) {
    result = 2;
  } else if (headErr <= good && combinedErr <= good * 2) {
    result = 3;
  } else if (headErr <= ok && combinedErr <= ok * 2) {
    result = 4;
  } else {
    result = 5;
  }

  if (bodyBreakCapJudgment != null && result < bodyBreakCapJudgment) {
    result = bodyBreakCapJudgment;
  }

  return result;
}

function getStableLongNoteScoringHeadTime(
  note: ManiaNote,
  pressTime: number,
  windows: ManiaReplayHitWindows,
): number {
  const meh = Math.floor(windows.meh);
  if (pressTime < note.time - meh) return note.endTime - 1;
  if (pressTime < note.time) return note.time + (note.time - pressTime);
  return pressTime;
}

function getStableLongNoteScoringTailTime(
  note: ManiaNote,
  tailTime: number,
  tailWasHeldAtJudgement: boolean,
): number {
  if (tailWasHeldAtJudgement) return tailTime;
  if (tailTime > note.endTime) return note.endTime - (tailTime - note.endTime);
  return tailTime;
}

function getStableLongNoteHeadPreviewJudgment(
  offsetMs: number,
  windows: ManiaReplayHitWindows,
): Judgment {
  const delta = Math.abs(Math.round(offsetMs));
  if (delta <= Math.floor(windows.perfect)) return 1;
  if (delta <= Math.floor(windows.great)) return 2;
  if (delta <= Math.floor(windows.good)) return 3;
  if (delta <= Math.floor(windows.ok)) return 4;
  if (delta <= Math.floor(windows.miss)) return 5;
  return 0;
}

function judgeStableLongNoteScoreV1(
  note: ManiaNote,
  pressTime: number,
  tailTime: number,
  tailWasHeldAtJudgement: boolean,
  bodyBreakCapJudgment: Judgment | null,
  tailEarlyMissLenience: number,
  windows: ManiaReplayHitWindows,
): { headOffsetMs: number; judgment: Judgment; tailOffsetMs: number } {
  const scoringHeadTime = getStableLongNoteScoringHeadTime(note, pressTime, windows);
  const scoringTailTime = getStableLongNoteScoringTailTime(note, tailTime, tailWasHeldAtJudgement);
  const meh = Math.floor(windows.meh);
  const tailOffsetMs = scoringTailTime - note.endTime;

  if (tailOffsetMs < -meh * tailEarlyMissLenience) {
    return {
      headOffsetMs: scoringHeadTime - note.time,
      judgment: 6,
      tailOffsetMs,
    };
  }

  return {
    headOffsetMs: scoringHeadTime - note.time,
    judgment: judgeStableLongNoteCombined(
      scoringHeadTime - note.time,
      scoringTailTime - note.endTime,
      bodyBreakCapJudgment,
      windows,
    ),
    tailOffsetMs,
  };
}

// Stable downloaded replays sample the key state once per game frame (typically
// ~16-17ms at 60fps). Two consecutive pressed samples spaced one frame apart do
// NOT plausibly hide a release/re-press: the user would have had to drop and
// recover the key inside a single frame. We only treat a hidden body break as
// possible when the gap between adjacent observed events is substantially
// longer than normal sampling cadence, indicating that at least one full
// frame's worth of input state was actually skipped.
function getStableSegmentHiddenBodyBreakTime(
  segment: ReplaySegment,
  startTime: number,
  endTime: number,
  gapThreshold: number,
): number | null {
  const samples = segment.samples ?? [];
  let previousPressedSample: number | null = null;

  for (const sample of samples) {
    if (sample < startTime) {
      previousPressedSample = sample;
      continue;
    }

    if (sample > endTime) break;

    if (previousPressedSample != null) {
      const lowerBound = Math.max(previousPressedSample, startTime);
      if (sample - lowerBound > gapThreshold) {
        return lowerBound + (sample - lowerBound) / 2;
      }
    }

    previousPressedSample = sample;
  }

  // The release edge itself can hide a release/re-press/release sequence in
  // the gap between the last observed pressed sample and the end-of-segment
  // sample. Same threshold rule: only flag it when the gap is wide enough to
  // contain a real release, not when it's just one frame of normal sampling.
  if (segment.end <= endTime && segment.endPrevious != null) {
    const lowerBound = Math.max(segment.endPrevious, startTime);
    if (segment.end - lowerBound > gapThreshold) {
      return lowerBound + (segment.end - lowerBound) / 2;
    }
  }

  return null;
}

function getStableLongNoteHiddenBodyBreakTime(
  note: ManiaNote,
  scannedSegments: ReplaySegment[],
  judgmentTime: number,
  gapThreshold: number,
): number | null {
  const startTime = note.time;
  const endTime = Math.max(startTime, judgmentTime);

  for (const segment of scannedSegments) {
    if (segment.end <= startTime || segment.start >= endTime) continue;

    const breakTime = getStableSegmentHiddenBodyBreakTime(segment, startTime, endTime, gapThreshold);
    if (breakTime != null) return breakTime;
  }

  return null;
}

function stableLongNoteCanHideBodyBreak(
  note: ManiaNote,
  scannedSegments: ReplaySegment[],
  judgmentTime: number,
  gapThreshold: number,
): boolean {
  return getStableLongNoteHiddenBodyBreakTime(note, scannedSegments, judgmentTime, gapThreshold) != null;
}

function getStableLongNotePossibleJudgments(
  note: ManiaNote,
  headSegment: ReplaySegment,
  tailSegment: ReplaySegment | null,
  currentJudgment: Judgment,
  currentTailOffsetMs: number,
  bodyBreakCapJudgment: Judgment | null,
  hiddenBodyBreakPossible: boolean,
  windows: ManiaReplayHitWindows,
): Judgment[] {
  const possible = new Set<Judgment>([currentJudgment]);
  const boundaries = stableOffsetBoundaries(windows);
  const headStartMin = headSegment.startPrevious ?? headSegment.start;
  const headOffsets = sampleRangeWithBoundaries(
    headStartMin - note.time,
    headSegment.start - note.time,
    boundaries,
  );

  let tailOffsets = [currentTailOffsetMs];
  let missPossible = false;

  if (tailSegment) {
    const releaseMin = tailSegment.endPrevious ?? tailSegment.end;
    const releaseMax = tailSegment.end;
    const tailMin = releaseMin - note.endTime;
    const tailMax = releaseMax - note.endTime;
    const latestScoringRelease = Math.min(tailMax, Math.floor(windows.ok));

    if (tailMin <= latestScoringRelease) {
      tailOffsets = sampleRangeWithBoundaries(tailMin, latestScoringRelease, boundaries);
    }
    if (tailMax > windows.ok) {
      missPossible = true;
    }
  }

  for (const headOffset of headOffsets) {
    for (const tailOffset of tailOffsets) {
      possible.add(judgeStableLongNoteCombined(headOffset, tailOffset, bodyBreakCapJudgment, windows));

      // Downloaded stable replays are sampled key states, not the full input
      // stream. Around short drops, the sampled edge can make the body-break
      // cap ambiguous even though the score header has the original result.
      if (bodyBreakCapJudgment != null) {
        possible.add(judgeStableLongNoteCombined(headOffset, tailOffset, null, windows));
      }
    }
  }

  if (hiddenBodyBreakPossible) possible.add(5);
  if (missPossible) possible.add(6);

  return [...possible].sort((a, b) => a - b);
}

function createMissState(
  note: ManiaNote,
  noteIndex: number,
  windows: ManiaReplayHitWindows,
  column: number,
  events: ReplayJudgementEvent[],
  accuracyMode: ReplayAccuracyMode,
  actualHead?: { time: number; offsetMs: number; releaseTime: number },
  possibleJudgments?: Judgment[],
  stableJudgmentOverride?: Judgment,
): ReplayNoteState {
  const isLN = note.isHold && note.endTime > note.time;
  const passiveHeadWindow = accuracyMode === "lazer"
    ? windows.meh
    : accuracyMode === "stable" && isLN
      ? windows.meh
      : windows.miss;
  const headTime = actualHead?.time ?? note.time + passiveHeadWindow;
  const headOffsetMs = actualHead?.offsetMs ?? passiveHeadWindow;
  const releaseTime = actualHead?.releaseTime ?? 0;

  if (!isLN) {
    const stableTimeout = accuracyMode === "stable" && !actualHead;
    const lazerTimeout = accuracyMode === "lazer" && !actualHead;
    const eventTime = stableTimeout ? note.time + windows.ok : lazerTimeout ? note.time + windows.meh : headTime;
    events.push({
      column,
      judgment: 6,
      noteIndex,
      offsetMs: headOffsetMs,
      part: "note",
      ...(possibleJudgments && possibleJudgments.length > 1 ? { possibleJudgments } : {}),
      time: eventTime,
    });
    return {
      bodyBreakTime: null,
      displayJudgment: 6,
      displayTime: eventTime,
      headJudgment: 6,
      headOffsetMs,
      headTime: eventTime,
      releaseTime,
      tailJudgment: null,
      tailOffsetMs: 0,
      tailTime: null,
    };
  }

  if (accuracyMode === "lazer") {
    const tailTime = note.endTime + windows.meh * RELEASE_WINDOW_LENIENCE;
    events.push({
      column,
      judgment: 6,
      noteIndex,
      offsetMs: headOffsetMs,
      part: "hold-head",
      time: headTime,
    });
    events.push({
      column,
      judgment: 6,
      noteIndex,
      offsetMs: windows.meh * RELEASE_WINDOW_LENIENCE,
      part: "hold-tail",
      time: tailTime,
    });
    return {
      bodyBreakTime: null,
      displayJudgment: 6,
      displayTime: tailTime,
      headJudgment: 6,
      headOffsetMs,
      headTime,
      releaseTime,
      tailJudgment: 6,
      tailOffsetMs: windows.meh * RELEASE_WINDOW_LENIENCE,
      tailTime,
    };
  }

  // Stable fires a passive LN head miss as soon as the head times out. The
  // tail/body can still produce hit-error entries later, but the score bucket
  // has already moved.
  const combinedTime = headTime;
  const stableJudgment = stableJudgmentOverride ?? 6;
  events.push({
    column,
    judgment: stableJudgment,
    noteIndex,
    offsetMs: headOffsetMs,
    part: "hold-combined",
    ...(possibleJudgments && possibleJudgments.length > 1 ? { possibleJudgments } : {}),
    time: combinedTime,
  });
  return {
    bodyBreakTime: null,
    displayJudgment: stableJudgment,
    displayTime: combinedTime,
    headJudgment: stableJudgment,
    headOffsetMs,
    headTime,
    releaseTime,
    tailJudgment: stableJudgment,
    tailOffsetMs: windows.miss,
    tailTime: combinedTime,
  };
}

export function simulateManiaReplayJudgements(
  notes: ManiaNote[],
  segments: ReplaySegment[][],
  keyCount: number,
  windows: ManiaReplayHitWindows,
  accuracyMode: ReplayAccuracyMode = "lazer",
  options: ManiaReplaySimulationOptions = {},
): { events: ReplayJudgementEvent[]; noteStates: ReplayNoteState[] } {
  const noteStates: ReplayNoteState[] = new Array(notes.length);
  const events: ReplayJudgementEvent[] = [];
  const notesByColumn: number[][] = Array.from({ length: keyCount }, () => []);
  const isLazer = accuracyMode === "lazer";
  const stableTransitionMedian = !isLazer && options.legacyReplayFrameRounding
    ? getStableTransitionMedian(segments)
    : 0;
  const useDenseForcedCoarsePlayback = !isLazer
    && Boolean(options.legacyReplayFrameRounding)
    && options.stableDenseForceCoarsePlaybackMaxMedian != null
    && stableTransitionMedian <= options.stableDenseForceCoarsePlaybackMaxMedian;
  const useCoarseStablePlayback = !isLazer
    && Boolean(options.legacyReplayFrameRounding)
    && (
      options.stableForceCoarsePlayback
      || useDenseForcedCoarsePlayback
      || stableTransitionMedian > STABLE_COARSE_REPLAY_MEDIAN_TRANSITION
    );
  const stableCoarseEdgePlaybackDelay = useDenseForcedCoarsePlayback && options.stableDenseCoarseEdgePlaybackDelay != null
    ? options.stableDenseCoarseEdgePlaybackDelay
    : options.stableCoarseEdgePlaybackDelay ?? STABLE_COARSE_EDGE_PLAYBACK_DELAY;
  const useStableCoarsePressPlayback = options.stableCoarsePressPlayback ?? useCoarseStablePlayback;
  const useStableCoarseReleasePlayback = options.stableCoarseReleasePlayback
    ?? (!isLazer && Boolean(options.legacyReplayFrameRounding));
  const useStableLongNoteHeadRefinement = Boolean(options.stableEnableLongNoteHeadRefinement)
    && !options.stableDisableLongNoteHeadRefinement
    && (!useCoarseStablePlayback || Boolean(options.stableAllowCoarseLongNoteHeadRefinement));
  const stableConsumeHeldSegmentAtLongNoteTimeout = options.stableConsumeHeldSegmentAtLongNoteTimeout ?? true;
  const stableHighKeyReleaseDelayCap = options.stableHighKeyReleaseDelayCap ?? 2;
  const stableHeldOkTimeoutAsMiss = options.stableHeldOkTimeoutAsMiss ?? keyCount <= 4;
  const stableHeldOkTimeoutJudgment = options.stableHeldOkTimeoutJudgment ?? 6;
  const stableHeldTailTimeoutMode = options.stableHeldTailTimeoutMode ?? "first-sample";
  const stableHighKeyReleaseDelayMaxHeadOffset = options.stableHighKeyReleaseDelayMaxHeadOffset;
  const stableHighKeyReleaseDelayMissOnly = options.stableHighKeyReleaseDelayMissOnly ?? false;
  const stableHighKeyReleaseDelayRawThreshold = options.stableHighKeyReleaseDelayRawThreshold;
  const stableMissedInsideConsumedSegmentJudgment = options.stableMissedInsideConsumedSegmentJudgment;
  const stableMissedInsideConsumedNoAdvanceJudgment = options.stableMissedInsideConsumedNoAdvanceJudgment;
  const stablePreHeadReleaseMissConsumesRecovery = (options.stablePreHeadReleaseMissConsumesRecovery ?? false)
    || (
      !isLazer
      && Boolean(options.legacyReplayFrameRounding)
      && options.stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian != null
      && stableTransitionMedian <= options.stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian
    );
  const stablePreHeadReleaseMissRecoveryExcludeBeforeTap = options.stablePreHeadReleaseMissRecoveryExcludeBeforeTap ?? false;
  const stablePreHeadReleaseMissRecoveryExcludeNextShortMaxDuration = options.stablePreHeadReleaseMissRecoveryExcludeNextShortMaxDuration;
  const stablePreHeadReleaseMissRecoveryExcludeNextShortMaxGap = options.stablePreHeadReleaseMissRecoveryExcludeNextShortMaxGap;
  const stablePreHeadReleaseMissRecoveryMaxHeadOffset = options.stablePreHeadReleaseMissRecoveryMaxHeadOffset;
  const stablePreHeadReleaseMissRecoveryMaxNextNoteGap = options.stablePreHeadReleaseMissRecoveryMaxNextNoteGap;
  const stablePreHeadReleaseMissRecoveryMaxTailOffset = options.stablePreHeadReleaseMissRecoveryMaxTailOffset;
  const stablePreHeadReleaseMissRecoveryMinNextNextNoteGap = options.stablePreHeadReleaseMissRecoveryMinNextNextNoteGap;
  const stablePreHeadReleaseMissesAtHead = options.stablePreHeadReleaseMissesAtHead ?? true;
  const stablePreserveLongNoteScoringPressAfterBreak = options.stablePreserveLongNoteScoringPressAfterBreak ?? false;
  const stablePreserveLongNoteScoringPressAfterTailBreak = options.stablePreserveLongNoteScoringPressAfterTailBreak ?? false;
  const stablePreserveLongNoteScoringPressTime = options.stablePreserveLongNoteScoringPressTime ?? false;
  const stableRequirePreHeadRecoveryForActivation = options.stableRequirePreHeadRecoveryForActivation ?? false;
  const stableSuppressHiddenBodyBreakCap = options.stableSuppressHiddenBodyBreakCap ?? false;
  const stableTailEarlyMissLenience = Math.max(1, options.stableTailEarlyMissLenience ?? 1);
  const stableBodyBreakCapJudgment = options.stableBodyBreakCapJudgment === undefined
    ? 3
    : options.stableBodyBreakCapJudgment;
  const stableTailSegmentReuseGrace = options.stableTailSegmentReuseGrace ?? 0;
  const stableTailEdgeGrace = options.stableTailEdgeGrace ?? STABLE_TAIL_EDGE_GRACE;
  const stableNextNoteEdgeGrace = !isLazer && options.legacyReplayFrameRounding
    ? options.stableNextNoteEdgeGrace ?? getStableNextNoteEdgeGrace(stableTransitionMedian)
    : 0;
  const stablePreciseEdgePosition = options.stablePreciseEdgePosition ?? STABLE_PRECISE_EDGE_POSITION;
  const stableHiddenBodyBreakGapThreshold = !isLazer && options.legacyReplayFrameRounding
    ? getStableHiddenBodyBreakGapThreshold(stableTransitionMedian, options.speedMultiplier)
    : Number.POSITIVE_INFINITY;

  for (let i = 0; i < notes.length; i++) {
    const column = notes[i].column;
    if (column >= 0 && column < keyCount) {
      notesByColumn[column].push(i);
    }
  }

  for (let column = 0; column < keyCount; column++) {
    const columnNotes = notesByColumn[column];
    const columnSegments = segments[column];
    let segmentCursor = 0;

    for (let notePosition = 0; notePosition < columnNotes.length; notePosition++) {
      const noteIndex = columnNotes[notePosition];
      const note = notes[noteIndex];
      const previousNoteIndex = columnNotes[notePosition - 1] ?? null;
      const previousNote = previousNoteIndex != null ? notes[previousNoteIndex] : null;
      const nextNoteIndex = columnNotes[notePosition + 1] ?? null;
      const nextNote = nextNoteIndex != null ? notes[nextNoteIndex] : null;
      const nextNextNoteIndex = columnNotes[notePosition + 2] ?? null;
      const nextNextNote = nextNextNoteIndex != null ? notes[nextNextNoteIndex] : null;
      const isLN = note.isHold && note.endTime > note.time;
      // Stable tap replay frames can straddle a press across the next note's
      // start time. Keep those ambiguous taps eligible for the earlier note;
      // LN heads have separate hold/body behaviour and should keep scrolling
      // when they are held late.
      const canUseStableCrossedHeadEdge = !isLN;
      const stableNextEdgeGrace = !isLazer
        && options.legacyReplayFrameRounding
        && canUseStableCrossedHeadEdge
        && nextNote != null
        ? stableNextNoteEdgeGrace
        : 0;

      while (segmentCursor < columnSegments.length && columnSegments[segmentCursor].start < note.time - windows.miss) {
        segmentCursor++;
      }
      const stableSegmentCursorBefore = segmentCursor;

      let matchedSegmentIndex = -1;
      let headJudgment: Judgment = 0;
      let headTime = 0;
      const stableHeadDeadline = note.time + Math.floor(isLN ? windows.meh : windows.ok) - Number.EPSILON;
      const stableHeadEdgeGrace = !isLazer
        && options.legacyReplayFrameRounding
        && canUseStableCrossedHeadEdge
        && nextNote != null
        ? Math.max(stableNextEdgeGrace, stableHeadDeadline - nextNote.time)
        : stableNextEdgeGrace;
      const stableColumnInputOwnershipEnd = !isLazer
        && options.legacyReplayFrameRounding
        && options.stableColumnInputOwnership
        ? getStableColumnInputOwnershipEnd(note, nextNote, windows)
        : Number.POSITIVE_INFINITY;
      const latestHeadHitTime = isLazer
        ? Math.min(note.time + windows.meh, nextNote ? nextNote.time - Number.EPSILON : note.time + windows.meh)
        : isLN
          ? stableHeadDeadline
          : Math.min(stableHeadDeadline, nextNote ? nextNote.time - Number.EPSILON : stableHeadDeadline);

      for (let s = segmentCursor; matchedSegmentIndex === -1 && s < columnSegments.length; s++) {
        const segment = columnSegments[s];
        const pressRange = !isLazer && options.legacyReplayFrameRounding
          ? isLN ? getStableSegmentPressRange(segment) : getStableTapPressRange(segment)
          : null;
        if (stableRangeIsPastHeadDeadline(pressRange?.min ?? segment.start, latestHeadHitTime, stableHeadEdgeGrace)) break;

        let currentHeadTime = pressRange
          ? isLN
            ? getStablePressEstimate(segment, note.time, useStableCoarsePressPlayback, stableCoarseEdgePlaybackDelay, stablePreciseEdgePosition)
            : getStableTapPressEstimate(segment, note.time, useStableCoarsePressPlayback, stableCoarseEdgePlaybackDelay, stablePreciseEdgePosition)
          : segment.start;
        if (!useStableCoarsePressPlayback && currentHeadTime > latestHeadHitTime) {
          if (!canUseStableCrossedHeadEdge) break;
          if (!pressRange || stableRangeIsPastHeadDeadline(pressRange.min, latestHeadHitTime, stableHeadEdgeGrace)) break;
        }
        if (currentHeadTime > stableColumnInputOwnershipEnd) break;
        const currentHeadOffsetMs = currentHeadTime - note.time;
        const previousNoteIsLongNote = previousNote != null
          && previousNote.isHold
          && previousNote.endTime > previousNote.time;
        if (
          !isLazer &&
          options.legacyReplayFrameRounding &&
          previousNote != null &&
          !previousNoteIsLongNote &&
          currentHeadTime < previousNote.time
        ) {
          continue;
        }

        const currentHeadJudgment = isLazer
          ? getJudgmentForOffset(currentHeadOffsetMs, windows)
          : isLN
            ? getStableLongNoteHeadPreviewJudgment(currentHeadOffsetMs, windows)
            : getStableHeadJudgmentForOffset(currentHeadOffsetMs, windows);
        if (currentHeadJudgment !== 0) {
          const stableTimedOutCrossedLongNoteHead = !isLazer
            && isLN
            && stableTransitionMedian === STABLE_CROSSED_LN_HEAD_MEDIAN_TRANSITION
            && currentHeadOffsetMs > windows.meh;
          if (
            !isLazer
            && isLN
            && nextNote
            && currentHeadTime >= nextNote.time
            && currentHeadJudgment >= 5
            && (
              stableTransitionMedian < STABLE_CROSSED_LN_HEAD_MEDIAN_TRANSITION
              || stableTimedOutCrossedLongNoteHead
            )
          ) {
            break;
          }
          matchedSegmentIndex = s;
          headJudgment = currentHeadJudgment;
          headTime = currentHeadTime;
          const keepShortLongNoteEarlyMeh = !isLazer
            && isLN
            && headJudgment === 5
            && note.endTime - note.time <= Math.max(20, stableTransitionMedian * 4);

          if (
            !keepShortLongNoteEarlyMeh
            && !isLazer
              && isLN
              && options.legacyReplayFrameRounding
              && useStableLongNoteHeadRefinement
              && headJudgment >= 4
          ) {
            let bestOffset = headTime - note.time;
            for (let next = s + 1; next < columnSegments.length; next++) {
              const nextSegment = columnSegments[next];
              const nextRange = getStableSegmentPressRange(nextSegment);
              if (stableRangeIsPastHeadDeadline(nextRange.min, latestHeadHitTime, stableHeadEdgeGrace)) break;

              const nextHeadTime = getStablePressEstimate(
                nextSegment,
                note.time,
                useStableCoarsePressPlayback,
                stableCoarseEdgePlaybackDelay,
                stablePreciseEdgePosition,
              );
              if (nextHeadTime > latestHeadHitTime) break;
              if (stablePressIsLikelyForNextNote(nextHeadTime, note, nextNote)) continue;

              const nextOffset = nextHeadTime - note.time;
              const nextJudgment = getStableLongNoteHeadPreviewJudgment(nextOffset, windows);
              if (nextJudgment === 0) continue;

              const nextIsBetter = nextJudgment < headJudgment
                || (nextJudgment === headJudgment && Math.abs(nextOffset) < Math.abs(bestOffset));
              if (nextIsBetter) {
                matchedSegmentIndex = next;
                headJudgment = nextJudgment;
                headTime = nextHeadTime;
                bestOffset = nextOffset;
              }
            }
          }
          break;
        }
      }

      if (matchedSegmentIndex === -1) {
        // Lazer holds can still earn a user-triggered tail judgement after the
        // head timed out: DrawableHoldNote.OnPressed calls beginHoldAt before
        // Head.UpdateResult() decides whether the input is consumed, so a
        // press that falls through to a later note (or to nothing) still
        // starts holding this note, and the non-consuming OnReleased then
        // fires Tail.UpdateResult() on every held note in the column. The
        // press must be no earlier than the head miss window (guaranteed by
        // the segment cursor) and no later than the tail's raw Meh window;
        // the release judges via the 1.5x lenience windows and is capped to
        // Meh because the head was not hit.
        if (isLazer && isLN) {
          const tailDeadline = note.endTime + windows.meh * RELEASE_WINDOW_LENIENCE;
          let regrabTail: { judgment: Judgment; offsetMs: number; time: number } | null = null;
          for (let s = segmentCursor; s < columnSegments.length; s++) {
            const segment = columnSegments[s];
            if (segment.start > note.endTime + windows.meh) break;
            if (segment.end > tailDeadline) break;

            // Note lock (OrderedHitPolicy.IsHittable): the press only reaches
            // this hold if it lands strictly before the next alive object's
            // start time. Approximate "alive" as not yet timed out at press
            // time.
            let nextAliveStart: number | null = null;
            for (let p = notePosition + 1; p < columnNotes.length; p++) {
              const laterNote = notes[columnNotes[p]];
              if (segment.start <= laterNote.time + windows.meh) {
                nextAliveStart = laterNote.time;
                break;
              }
            }
            if (nextAliveStart != null) {
              if (segment.start >= nextAliveStart) continue;
              // A successful hit on the next object triggers
              // OrderedHitPolicy.HandleHit, which force-misses every earlier
              // unjudged nested object ending before it - including this
              // tail. Only presses that miss (or fall short of) the next
              // object's hit window leave the tail judgeable.
              if (nextAliveStart - segment.start <= windows.meh && note.endTime < nextAliveStart) break;
            }

            const rawTailJudgment = getJudgmentForOffset(
              (segment.end - note.endTime) / RELEASE_WINDOW_LENIENCE,
              windows,
            );
            if (rawTailJudgment === 0) continue;
            regrabTail = {
              judgment: capLazerTailJudgment(rawTailJudgment, true),
              offsetMs: segment.end - note.endTime,
              time: segment.end,
            };
            break;
          }
          if (regrabTail) {
            const headTimeoutTime = note.time + windows.meh;
            events.push({
              column,
              judgment: 6,
              noteIndex,
              offsetMs: windows.meh,
              part: "hold-head",
              time: headTimeoutTime,
            });
            events.push({
              column,
              judgment: regrabTail.judgment,
              noteIndex,
              offsetMs: regrabTail.offsetMs,
              part: "hold-tail",
              time: regrabTail.time,
            });
            noteStates[noteIndex] = {
              bodyBreakTime: null,
              displayJudgment: regrabTail.judgment,
              displayTime: regrabTail.time,
              headJudgment: 6,
              headOffsetMs: windows.meh,
              headTime: headTimeoutTime,
              releaseTime: regrabTail.time,
              tailJudgment: regrabTail.judgment,
              tailOffsetMs: regrabTail.offsetMs,
              tailTime: regrabTail.time,
            };
            continue;
          }
        }

        let timedOutHeldSegmentIndex = -1;
        if (
          !isLazer
          && isLN
          && nextNote != null
          && options.legacyReplayFrameRounding
          && stableConsumeHeldSegmentAtLongNoteTimeout
        ) {
          const passiveTimeout = note.time + windows.meh;
          for (let s = segmentCursor; s < columnSegments.length; s++) {
            const segment = columnSegments[s];
            const pressRange = getStableSegmentPressRange(segment);
            if (pressRange.min > passiveTimeout + STABLE_PRECISE_EDGE_INTERVAL) break;
            if (segment.end < passiveTimeout) continue;

            const pressTime = getStablePressEstimate(
              segment,
              note.time,
              useStableCoarsePressPlayback,
              stableCoarseEdgePlaybackDelay,
              stablePreciseEdgePosition,
            );
            const edgeCanBelongToNextHead = pressRange.min < nextNote.time && pressTime >= nextNote.time;
            const startsAfterThisTail = pressTime > note.endTime;
            if (edgeCanBelongToNextHead && startsAfterThisTail) {
              timedOutHeldSegmentIndex = s;
              break;
            }
          }
        }

        const previousConsumedSegment = columnSegments[Math.max(0, segmentCursor) - 1];
        const stableMissedInsideConsumedSegment = !isLazer
          && isLN
          && options.legacyReplayFrameRounding
          && previousConsumedSegment != null
          && previousConsumedSegment.start < note.time
          && previousConsumedSegment.end > note.time;
        const stableMissedInsideConsumedNoAdvance = stableMissedInsideConsumedSegment
          && timedOutHeldSegmentIndex < segmentCursor;
        const stableMissedInsideConsumedJudgment = stableMissedInsideConsumedNoAdvance
          ? stableMissedInsideConsumedNoAdvanceJudgment ?? stableMissedInsideConsumedSegmentJudgment
          : stableMissedInsideConsumedSegmentJudgment;
        const missState = createMissState(
          note,
          noteIndex,
          windows,
          column,
          events,
          accuracyMode,
          undefined,
          !isLazer && options.legacyReplayFrameRounding ? [1, 2, 3, 4, 5, 6] : undefined,
          stableMissedInsideConsumedSegment ? stableMissedInsideConsumedJudgment : undefined,
        );
        if (stableMissedInsideConsumedSegment) {
          missState.stableMissedInsideConsumedSegment = true;
        }
        if (timedOutHeldSegmentIndex >= segmentCursor) {
          missState.stableConsumedHeldSegmentAtTimeout = true;
          segmentCursor = timedOutHeldSegmentIndex + 1;
        }
        missState.stableSegmentCursorBefore = stableSegmentCursorBefore;
        missState.stableSegmentCursorAfter = segmentCursor;
        missState.stableMatchedSegmentIndex = timedOutHeldSegmentIndex >= 0 ? timedOutHeldSegmentIndex : undefined;
        missState.stableNextSegmentCursor = segmentCursor;
        noteStates[noteIndex] = missState;
        continue;
      }

      const headSegment = columnSegments[matchedSegmentIndex];
      const headOffsetMs = headTime - note.time;
      const stableMatchedPreviousTailSegment = !isLazer
        && isLN
        && options.legacyReplayFrameRounding
        && previousNote != null
        && previousNote.isHold
        && previousNote.endTime > previousNote.time
        && headSegment.start < previousNote.endTime
        && headSegment.end > note.time;

      // A stable press that lands in the miss tier (|offset| in (meh, miss])
      // registers the LN as a miss at the real press time. Lazer is different:
      // the head is counted as a miss but the tail still gets its own judgement
      // (capped to Meh by the head-miss combo-break rule), so we let lazer fall
      // through to the regular flow.
      if (headJudgment === 6 && !isLazer && !isLN) {
        noteStates[noteIndex] = createMissState(
          note,
          noteIndex,
          windows,
          column,
          events,
          accuracyMode,
          { time: headTime, offsetMs: headOffsetMs, releaseTime: headSegment.end },
          options.legacyReplayFrameRounding ? [1, 2, 3, 4, 5, 6] : undefined,
        );
        if (!options.legacyReplayFrameRounding && matchedSegmentIndex >= segmentCursor) {
          segmentCursor = matchedSegmentIndex + 1;
        }
        continue;
      }

      // Regular note (or a "hold" whose endTime == time which we treat as a tap)
      if (!isLN) {
        events.push({
          column,
          judgment: headJudgment,
          noteIndex,
          offsetMs: headOffsetMs,
          part: "note",
          ...(!isLazer && options.legacyReplayFrameRounding
            ? { possibleJudgments: getStableTapPossibleJudgments(headSegment, note, windows) }
            : {}),
          time: headTime,
        });
        noteStates[noteIndex] = {
          bodyBreakTime: null,
          displayJudgment: headJudgment,
          displayTime: headTime,
          headJudgment,
          headOffsetMs,
          headTime,
          releaseTime: headSegment.end,
          tailJudgment: null,
          tailOffsetMs: 0,
          tailTime: null,
        };
        if (matchedSegmentIndex >= segmentCursor) {
          segmentCursor = matchedSegmentIndex + 1;
        }
        continue;
      }

      // --- Long note ---
      if (isLazer) {
        events.push({
          column,
          judgment: headJudgment,
          noteIndex,
          offsetMs: headOffsetMs,
          part: "hold-head",
          time: headTime,
        });

        let bodyBreakTime: number | null = null;
        let releaseTime = headSegment.end;
        let scanIndex = matchedSegmentIndex;
        const tailDeadline = note.endTime + windows.meh * RELEASE_WINDOW_LENIENCE;
        let tailJudgment: Judgment = 6;
        let tailOffsetMs = windows.meh * RELEASE_WINDOW_LENIENCE;
        let tailTime = tailDeadline;
        let possibleTailJudgments: Judgment[] | undefined;

        // Lazer's DrawableHoldNoteTail.GetCappedResult: the tail is capped to
        // Meh if the head was missed OR the body had a hold break.
        const headMissed = headJudgment === 6;

        while (scanIndex < columnSegments.length) {
          const segment = columnSegments[scanIndex];
          releaseTime = Math.max(releaseTime, segment.end);

          if (segment.end > tailDeadline) {
            tailJudgment = 6;
            tailOffsetMs = tailDeadline - note.endTime;
            tailTime = tailDeadline;
            break;
          }

          const releaseOffsetMs = (segment.end - note.endTime) / RELEASE_WINDOW_LENIENCE;
          const rawTailJudgment = getJudgmentForOffset(releaseOffsetMs, windows);

          if (rawTailJudgment !== 0) {
            const hasComboBreak = bodyBreakTime != null || headMissed;
            tailJudgment = capLazerTailJudgment(rawTailJudgment, hasComboBreak);
            tailOffsetMs = segment.end - note.endTime;
            tailTime = segment.end;
            possibleTailJudgments = options.legacyReplayFrameRounding
              ? getRoundedLegacyTailPossibleJudgments(tailOffsetMs, windows, hasComboBreak)
              : undefined;
            break;
          }

          if (segment.end >= tailDeadline) {
            tailJudgment = 6;
            tailOffsetMs = tailDeadline - note.endTime;
            tailTime = tailDeadline;
            break;
          }

          if (bodyBreakTime == null) {
            bodyBreakTime = segment.end;
            events.push({
              column,
              judgment: null,
              noteIndex,
              offsetMs: segment.end - note.endTime,
              part: "hold-break",
              time: segment.end,
            });
          }

          scanIndex++;
          if (scanIndex >= columnSegments.length || columnSegments[scanIndex].start > tailDeadline) {
            tailJudgment = 6;
            tailOffsetMs = tailDeadline - note.endTime;
            tailTime = tailDeadline;
            break;
          }
        }

        events.push({
          column,
          judgment: tailJudgment,
          noteIndex,
          offsetMs: tailOffsetMs,
          part: "hold-tail",
          ...(possibleTailJudgments && possibleTailJudgments.length > 1
            ? { possibleJudgments: possibleTailJudgments }
            : {}),
          time: tailTime,
        });

        noteStates[noteIndex] = {
          bodyBreakTime,
          displayJudgment: tailJudgment,
          displayTime: tailTime,
          headJudgment,
          headOffsetMs,
          headTime,
          releaseTime,
          tailJudgment,
          tailOffsetMs,
          tailTime,
        };

        if (matchedSegmentIndex >= segmentCursor) {
          segmentCursor = matchedSegmentIndex + 1;
        }
        continue;
      }

      // --- Stable LN: one ScoreV1 combined judgement event. Stable stores the
      // last press/release times for the hold object, reflects early heads and
      // late releases around the note boundaries, and only times out held tails
      // at the 50 window.
      const stableMeh = Math.floor(windows.meh);
      const tailEarlyBound = note.endTime - stableMeh;
      const tailTimeout = note.endTime + stableMeh;
      const tailEarlyMissBound = note.endTime - stableMeh * stableTailEarlyMissLenience;

      let bodyBreakTime: number | null = null;
      const bodyBreakTimes: number[] = [];
      let bodyBreakCapJudgment: Judgment | null = null;
      const heldSegments: ReplaySegment[] = [];
      let releaseTime = headSegment.end;
      let scanIndex = matchedSegmentIndex;
      let scoringPressTime = headTime;
      let previousReleaseTime: number | null = null;
      let previousReleaseWasBridged = false;
      let tailJudgementSourceTime: number | null = null;
      let tailWasHeldAtJudgement = false;
      let tailOffsetMs = windows.miss;
      let lastScannedSegmentIndex = matchedSegmentIndex;
      let tailSegment: ReplaySegment | null = null;
      let tailSegmentIndex: number | null = null;
      let tailSegmentReleaseDelay = 0;
      let bodyBreakMiss: { offsetMs: number; time: number } | null = null;
      let stablePreHeadPressActivatedLongNote = false;
      let stablePreHeadReleaseMiss = false;
      let stablePreHeadReleaseMissConsumedRecovery = false;

      while (scanIndex < columnSegments.length) {
        const segment = columnSegments[scanIndex];
        const isFirstMatchedSegment = scanIndex === matchedSegmentIndex;
        const segmentPressRange = options.legacyReplayFrameRounding
          ? getStableSegmentPressRange(segment)
          : null;
        const segmentPressTimeForOwnership = segmentPressRange?.min ?? segment.start;
        if (!isFirstMatchedSegment && segmentPressTimeForOwnership > stableColumnInputOwnershipEnd) {
          break;
        }

        if (
          !isFirstMatchedSegment &&
          previousReleaseTime != null &&
          !previousReleaseWasBridged &&
          previousReleaseTime < tailEarlyBound &&
          tailEarlyBound - previousReleaseTime <= stableNextNoteEdgeGrace &&
          (segmentPressRange?.min ?? segment.start) > tailEarlyBound &&
          segment.end < note.endTime
        ) {
          tailJudgementSourceTime = previousReleaseTime;
          tailWasHeldAtJudgement = false;
          break;
        }

        lastScannedSegmentIndex = scanIndex;

        if (
          !isFirstMatchedSegment
          && !previousReleaseWasBridged
          && !stablePreserveLongNoteScoringPressTime
          && !(stablePreserveLongNoteScoringPressAfterBreak && bodyBreakTime != null)
          && !(
            stablePreserveLongNoteScoringPressAfterTailBreak
            && bodyBreakTime != null
            && segmentPressTimeForOwnership >= note.endTime
          )
        ) {
          scoringPressTime = options.legacyReplayFrameRounding
            ? getStablePressEstimate(segment, note.time, useStableCoarsePressPlayback, stableCoarseEdgePlaybackDelay, stablePreciseEdgePosition)
            : segment.start;
        }

        releaseTime = Math.max(releaseTime, segment.end);
        if (segment.end > note.time && segment.start < note.endTime) {
          heldSegments.push(segment);
        }

        let segmentReleaseTime = options.legacyReplayFrameRounding
          ? getStableReleaseEstimate(segment, note.endTime, useStableCoarseReleasePlayback, stableCoarseEdgePlaybackDelay, stablePreciseEdgePosition)
          : segment.end;
        const rawSegmentReleaseDelay = options.legacyReplayFrameRounding
          && useStableCoarseReleasePlayback
          && segment.endPrevious != null
          && segmentReleaseTime > note.endTime
          ? Math.max(0, segment.end - segment.endPrevious)
          : 0;
        const segmentReleaseDelay = keyCount > 4
          ? stableHighKeyReleaseDelayRawThreshold != null
            && rawSegmentReleaseDelay < stableHighKeyReleaseDelayRawThreshold
              ? Math.min(2, rawSegmentReleaseDelay)
              : Math.min(stableHighKeyReleaseDelayCap, rawSegmentReleaseDelay)
          : 0;
        if (segment.end < tailEarlyBound) {
          const nextSegment = columnSegments[scanIndex + 1];
          const canBridgeTailEdgeGap = stableCanBridgeTailEdgeGap(
            segment,
            nextSegment,
            tailEarlyBound,
            options.legacyReplayFrameRounding,
            stableNextNoteEdgeGrace,
            stableTailEdgeGrace,
          );

          const releasedAfterHead = segment.end > note.time;
          const releasedMatchedPreHeadPress = isFirstMatchedSegment
            && segment.start < note.time
            && segment.end <= note.time;
          const nextSegmentPressRange = nextSegment && options.legacyReplayFrameRounding
            ? getStableSegmentPressRange(nextSegment)
            : null;
          const nextSegmentPressTime = nextSegment
            ? options.legacyReplayFrameRounding
              ? getStablePressEstimate(
                  nextSegment,
                  note.time,
                  useStableCoarsePressPlayback,
                  stableCoarseEdgePlaybackDelay,
                  stablePreciseEdgePosition,
                )
              : nextSegment.start
            : Number.POSITIVE_INFINITY;
          const preHeadRecoveryIsAlreadyAtHead = nextSegmentPressTime <= note.time + STABLE_PRECISE_EDGE_INTERVAL;
          const nextSegmentCoversTailEdge = nextSegment != null
            && (nextSegmentPressRange?.min ?? nextSegment.start) <= tailEarlyBound
            && nextSegment.end >= tailEarlyBound;
          const isShortStableLongNote = note.endTime - note.time <= stableMeh;
          const preHeadPressActivatedLongNote = releasedMatchedPreHeadPress
            && isShortStableLongNote
            && (
              preHeadRecoveryIsAlreadyAtHead
              || (!stableRequirePreHeadRecoveryForActivation && scoringPressTime < note.time - stableMeh)
            );
          const preHeadReleaseMissesAtHead = releasedMatchedPreHeadPress
            && stablePreHeadReleaseMissesAtHead
            && (
              preHeadPressActivatedLongNote
              || (!preHeadRecoveryIsAlreadyAtHead && !nextSegmentCoversTailEdge)
            );
          const nextNoteGap = nextNote ? nextNote.time - note.endTime : Number.POSITIVE_INFINITY;
          const nextNoteDuration = nextNote ? nextNote.endTime - nextNote.time : Number.POSITIVE_INFINITY;
          const nextNextNoteGap = nextNote && nextNextNote
            ? nextNextNote.time - nextNote.endTime
            : Number.POSITIVE_INFINITY;
          const recoveryWouldStealCloseShortNextNote = nextNote?.isHold === true
            && stablePreHeadReleaseMissRecoveryExcludeNextShortMaxGap != null
            && stablePreHeadReleaseMissRecoveryExcludeNextShortMaxDuration != null
            && nextNoteGap <= stablePreHeadReleaseMissRecoveryExcludeNextShortMaxGap
            && nextNoteDuration <= stablePreHeadReleaseMissRecoveryExcludeNextShortMaxDuration;
          const releaseBeforeTailEdge = tailEarlyBound - segment.end;
          const lateTailEdgeBreakMisses = releasedAfterHead
            && releaseBeforeTailEdge > 1
            && releaseBeforeTailEdge <= stableNextNoteEdgeGrace
            && segment.end < tailEarlyMissBound
            && !nextSegmentCoversTailEdge;
          const releasedPreHeadButRecovered = releasedMatchedPreHeadPress
            && !preHeadReleaseMissesAtHead
            && nextSegmentCoversTailEdge;

          if (!canBridgeTailEdgeGap && (releasedAfterHead || releasedMatchedPreHeadPress)) {
            const capJudgment = stableBodyBreakCapJudgment;
            if (capJudgment != null) {
              bodyBreakCapJudgment = bodyBreakCapJudgment == null
                ? capJudgment
                : Math.max(bodyBreakCapJudgment, capJudgment) as Judgment;
            }

            if (releasedAfterHead || releasedPreHeadButRecovered) {
              bodyBreakTimes.push(segment.end);
            }

            if (preHeadReleaseMissesAtHead || lateTailEdgeBreakMisses) {
              stablePreHeadPressActivatedLongNote = preHeadPressActivatedLongNote;
              stablePreHeadReleaseMiss = preHeadReleaseMissesAtHead;
              bodyBreakMiss = {
                offsetMs: segment.end - note.endTime,
                time: preHeadReleaseMissesAtHead ? note.time : segment.end,
              };
              bodyBreakTime = bodyBreakMiss.time;
              if (!bodyBreakTimes.includes(segment.end)) {
                bodyBreakTimes.push(segment.end);
              }
              if (preHeadPressActivatedLongNote && nextSegment != null && nextSegment.start < note.time) {
                lastScannedSegmentIndex = Math.max(lastScannedSegmentIndex, scanIndex + 1);
              }
              if (
                preHeadReleaseMissesAtHead
                && stablePreHeadReleaseMissConsumesRecovery
                && nextSegment != null
                && (nextSegmentPressRange?.min ?? nextSegment.start) < note.endTime
                && (!stablePreHeadReleaseMissRecoveryExcludeBeforeTap || nextNote?.isHold !== false)
                && !recoveryWouldStealCloseShortNextNote
                && (
                  stablePreHeadReleaseMissRecoveryMaxNextNoteGap == null
                  || nextNoteGap <= stablePreHeadReleaseMissRecoveryMaxNextNoteGap
                )
                && (
                  stablePreHeadReleaseMissRecoveryMinNextNextNoteGap == null
                  || nextNextNoteGap >= stablePreHeadReleaseMissRecoveryMinNextNextNoteGap
                )
                && (
                  stablePreHeadReleaseMissRecoveryMaxHeadOffset == null
                  || Math.abs(getStableLongNoteScoringHeadTime(note, scoringPressTime, windows) - note.time)
                    <= stablePreHeadReleaseMissRecoveryMaxHeadOffset
                )
                && (
                  stablePreHeadReleaseMissRecoveryMaxTailOffset == null
                  || segment.end - note.endTime <= stablePreHeadReleaseMissRecoveryMaxTailOffset
                )
              ) {
                stablePreHeadReleaseMissConsumedRecovery = true;
                lastScannedSegmentIndex = Math.max(lastScannedSegmentIndex, scanIndex + 1);
              }
              break;
            }

            if ((releasedAfterHead || releasedPreHeadButRecovered) && bodyBreakTime == null) {
              bodyBreakTime = segment.end;
              events.push({
                column,
                judgment: null,
                noteIndex,
                offsetMs: segment.end - note.endTime,
                part: "hold-break",
                time: segment.end,
              });
            }
          }

          previousReleaseTime = segmentReleaseTime;
          previousReleaseWasBridged = canBridgeTailEdgeGap;
          scanIndex++;
          continue;
        }

        if (segment.end <= tailTimeout) {
          tailJudgementSourceTime = segmentReleaseTime;
          tailWasHeldAtJudgement = false;
          tailSegment = segment;
          tailSegmentIndex = scanIndex;
          tailSegmentReleaseDelay = segmentReleaseDelay;
          break;
        }

        tailJudgementSourceTime = getStableHeldTailTimeoutTime(
          segment,
          tailTimeout,
          stableHeldTailTimeoutMode,
        );
        tailWasHeldAtJudgement = true;
        tailSegment = segment;
        tailSegmentIndex = scanIndex;
        tailSegmentReleaseDelay = 0;
        break;
      }

      let combinedJudgment: Judgment;
      let combinedTime: number;
      let scoringHeadOffsetMs = headOffsetMs;
      let scoringTailOffsetMs = tailOffsetMs;
      let barelyCrossedTailOnTimeout = false;
      let lateStartReleasePastOk = false;
      let stableHeldOkTimeout = false;
      let hiddenBodyBreakPossible = false;

      if (bodyBreakMiss != null) {
        combinedJudgment = 6;
        combinedTime = bodyBreakMiss.time;
        tailOffsetMs = bodyBreakMiss.offsetMs;
        scoringHeadOffsetMs = getStableLongNoteScoringHeadTime(note, scoringPressTime, windows) - note.time;
        scoringTailOffsetMs = bodyBreakMiss.offsetMs;
      } else {
        if (tailJudgementSourceTime == null) {
          tailJudgementSourceTime = previousReleaseTime;
        }

        if (tailJudgementSourceTime == null) {
          combinedJudgment = 6;
          combinedTime = Math.max(headTime, tailEarlyBound);
          tailOffsetMs = -stableMeh;
          scoringHeadOffsetMs = getStableLongNoteScoringHeadTime(note, scoringPressTime, windows) - note.time;
          scoringTailOffsetMs = -stableMeh;
        } else {
          hiddenBodyBreakPossible = bodyBreakCapJudgment != null && stableLongNoteCanHideBodyBreak(
            note,
            columnSegments.slice(matchedSegmentIndex, lastScannedSegmentIndex + 1),
            Math.max(tailJudgementSourceTime, tailEarlyBound),
            stableHiddenBodyBreakGapThreshold,
          );
          const effectiveBodyBreakCapJudgment = stableSuppressHiddenBodyBreakCap && hiddenBodyBreakPossible
            ? null
            : bodyBreakCapJudgment;
          const judged = judgeStableLongNoteScoreV1(
            note,
            scoringPressTime,
            tailJudgementSourceTime,
            tailWasHeldAtJudgement,
            effectiveBodyBreakCapJudgment,
            stableTailEarlyMissLenience,
            windows,
          );
          const delayedJudged = !tailWasHeldAtJudgement
            && tailSegmentReleaseDelay > 0
            && judged.judgment >= 3
            && judged.judgment <= 4
              ? judgeStableLongNoteScoreV1(
                  note,
                  scoringPressTime,
                  tailJudgementSourceTime + tailSegmentReleaseDelay,
                  tailWasHeldAtJudgement,
                  effectiveBodyBreakCapJudgment,
                  stableTailEarlyMissLenience,
                  windows,
              )
            : judged;
          const highKeyReleaseDelayHeadAllowed = stableHighKeyReleaseDelayMaxHeadOffset == null
            || Math.abs(judged.headOffsetMs) <= stableHighKeyReleaseDelayMaxHeadOffset;
          const useDelayedJudgment = delayedJudged.judgment > judged.judgment
            && highKeyReleaseDelayHeadAllowed
            && (!stableHighKeyReleaseDelayMissOnly || delayedJudged.judgment === 6);
          const finalJudged = useDelayedJudgment ? delayedJudged : judged;
          barelyCrossedTailOnTimeout = headTime > note.endTime
            && headTime <= note.endTime + STABLE_PRECISE_EDGE_INTERVAL;
          lateStartReleasePastOk = scoringPressTime > note.endTime
            && keyCount <= 4
            && (options.speedMultiplier ?? 1) <= 1.01
            && stableTransitionMedian >= STABLE_CROSSED_LN_HEAD_MEDIAN_TRANSITION
            && !tailWasHeldAtJudgement
            && tailJudgementSourceTime > note.endTime + Math.floor(windows.ok)
            && tailJudgementSourceTime <= tailTimeout
            && finalJudged.judgment === 4;
          stableHeldOkTimeout = tailWasHeldAtJudgement
            && stableHeldOkTimeoutAsMiss
            && finalJudged.judgment === 4
            && stableTransitionMedian <= 8
            && !barelyCrossedTailOnTimeout;
          combinedJudgment = lateStartReleasePastOk
            ? 5
            : stableHeldOkTimeout
            ? stableHeldOkTimeoutJudgment
            : finalJudged.judgment;
          combinedTime = judged.judgment === 6
            && headJudgment === 6
            && headTime >= note.time + stableMeh
            ? note.time + stableMeh
            : tailWasHeldAtJudgement
            ? tailTimeout
            : Math.max(tailJudgementSourceTime, tailEarlyBound);
          tailOffsetMs = finalJudged.tailOffsetMs;
          scoringHeadOffsetMs = finalJudged.headOffsetMs;
          scoringTailOffsetMs = finalJudged.tailOffsetMs;
        }
      }

      events.push({
        column,
        judgment: combinedJudgment,
        noteIndex,
        offsetMs: tailOffsetMs,
        part: "hold-combined",
        ...(options.legacyReplayFrameRounding
          ? {
              possibleJudgments: getStableLongNotePossibleJudgments(
                note,
                headSegment,
                tailSegment,
                combinedJudgment,
                tailOffsetMs,
                stableSuppressHiddenBodyBreakCap ? null : bodyBreakCapJudgment,
                stableLongNoteCanHideBodyBreak(
                  note,
                  columnSegments.slice(matchedSegmentIndex, lastScannedSegmentIndex + 1),
                  combinedTime,
                  stableHiddenBodyBreakGapThreshold,
                ),
                windows,
              ),
            }
          : {}),
        time: combinedTime,
      });

      let lastConsumedSegmentIndex = lastScannedSegmentIndex;
      if (
        options.stableReuseTailSegmentForNextHead
        && tailSegment != null
        && tailSegmentIndex != null
        && tailSegmentIndex > matchedSegmentIndex
        && nextNote != null
      ) {
        const tailSegmentPressRange = options.legacyReplayFrameRounding
          ? getStableSegmentPressRange(tailSegment)
          : { min: tailSegment.start, max: tailSegment.start };
        const tailSegmentStartsAfterTail = tailSegmentPressRange.min >= note.endTime - stableTailSegmentReuseGrace
          && tailSegmentPressRange.min < nextNote.time
          && tailSegment.end > nextNote.time;
        if (tailSegmentStartsAfterTail) {
          lastConsumedSegmentIndex = tailSegmentIndex - 1;
        }
      }

      const nextSegmentCursor = Math.max(matchedSegmentIndex + 1, lastConsumedSegmentIndex + 1);
      noteStates[noteIndex] = {
        bodyBreakTime,
        bodyBreakTimes,
        displayJudgment: combinedJudgment,
        displayTime: combinedTime,
        headJudgment,
        headOffsetMs,
        headTime,
        heldSegments,
        releaseTime,
        stableBarelyCrossedTailOnTimeout: barelyCrossedTailOnTimeout || undefined,
        stableHeldOkTimeout: stableHeldOkTimeout || undefined,
        stableHiddenBodyBreakPossible: hiddenBodyBreakPossible || undefined,
        stableLastConsumedSegmentIndex: lastConsumedSegmentIndex,
        stableLastScannedSegmentIndex: lastScannedSegmentIndex,
        stableLateStartReleasePastOk: lateStartReleasePastOk || undefined,
        stableMatchedPreviousTailSegment: stableMatchedPreviousTailSegment || undefined,
        stableMatchedSegmentIndex: matchedSegmentIndex,
        stableNextSegmentCursor: nextSegmentCursor,
        stablePreHeadPressActivatedLongNote: stablePreHeadPressActivatedLongNote || undefined,
        stablePreHeadReleaseMiss: stablePreHeadReleaseMiss || undefined,
        stablePreHeadReleaseMissConsumedRecovery: stablePreHeadReleaseMissConsumedRecovery || undefined,
        stableSegmentCursorBefore,
        stableTailWasHeldAtJudgement: tailWasHeldAtJudgement || undefined,
        stableTailJudgementSourceTime: tailJudgementSourceTime,
        stableTailSegmentIndex: tailSegmentIndex,
        stableTailSegmentReleaseDelay: tailSegmentReleaseDelay || undefined,
        scoringHeadOffsetMs,
        scoringTailOffsetMs,
        tailJudgment: combinedJudgment,
        tailOffsetMs,
        tailTime: combinedTime,
      };

      if (nextSegmentCursor > segmentCursor) {
        segmentCursor = nextSegmentCursor;
      }
      noteStates[noteIndex].stableSegmentCursorAfter = segmentCursor;
    }
  }

  events.sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);

  return { events, noteStates };
}

export function calculateReplayAccuracy(
  counts: number[],
  accuracyMode: ReplayAccuracyMode,
): number {
  const totalNotes = counts[1] + counts[2] + counts[3] + counts[4] + counts[5] + counts[6];
  if (totalNotes <= 0) return 100;

  const perfectValue = accuracyMode === "lazer" ? 305 : 300;
  const totalValue =
    counts[1] * perfectValue +
    counts[2] * 300 +
    counts[3] * 200 +
    counts[4] * 100 +
    counts[5] * 50;

  return (totalValue / (totalNotes * perfectValue)) * 100;
}

export function getTailReleaseWindowLenience() {
  return RELEASE_WINDOW_LENIENCE;
}
