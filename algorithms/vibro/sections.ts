// Section-level vibro for 4K rice (4K, at most 10% holds). Finds the passages
// that can be shaken rather than hit, at the played rate, and decides whether
// the chart is "clean", "adjusted" (rate what is left once the sections are
// removed) or "excluded" (too much of it is vibro to rate at all). Chart
// identity and metadata never take part in the decision.

import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { REPEATED_QUAD_GAP_MS, SLOW_QUAD_MIN_ROWS, scanMotionVibro } from "./motion";

export type VibroReason =
  | "repeated_wall"
  | "sustained_jack"
  | "repeated_jack_stream"
  | "repeated_chord"
  | "rapid_jack_burst"
  | "isolated_jack"
  | "fast_roll"
  | "extreme_density"
  | "split_hand_double"
  | "finger_rate_ceiling"
  | "hand_action_ceiling"
  | "four_key_cycle"
  | "locked_hands"
  | "fast_trill"
  | "sustained_density";

export interface VibroSection {
  /** Original chart timestamps, before applying the music rate. */
  startTime: number;
  endTime: number;
  reasons: VibroReason[];
}

export interface VibroAnalysis {
  /** Player-rating eligibility; informational on ordinary full-chart estimates. */
  status: "clean" | "adjusted" | "excluded";
  sections: VibroSection[];
  /** Real-time ms inside sections; gaps longer than 1s count as 1s. */
  excludedDurationMs: number;
  /** Real-time ms of the chart, with each gap between rows capped at 1s so
   * intros, breaks and padding do not dilute a spam section. */
  activeDurationMs: number;
  timeShare: number;
  noteShare: number;
  /** Upper bound on the removed share of judgement weight (hold tails included).
   * Used to assign all observed accuracy loss to the retained material. */
  judgementShare: number;
  remainingNotes: number;
  /** Share of notes sitting in repeated single-column runs across the whole
   * chart, inside sections or not. Says what the body is built from. */
  repeatShare: number;
  /** Share of active duration each reason covers on its own, before sections
   * are merged. Merging unions reasons, so a one-second detection inside a long
   * one looks like evidence in its own right once merged; a caller weighing one
   * kind of evidence against another needs this instead. */
  reasonShares: Partial<Record<VibroReason, number>>;
}

/** Charts the section detector handles: 4K with at most 10% holds. */
export function usesSectionVibro(map: ManiaBeatmap): boolean {
  return map.keyCount === 4 && map.notes.length > 0
    && map.notes.filter((note) => note.isHold).length / map.notes.length <= 0.1;
}

/** Locate vibro at the played speed, then measure the retained chart. */
export function analyzeVibroSections(map: ManiaBeatmap, rate = 1): VibroAnalysis {
  const result: VibroAnalysis = {
    status: "clean", sections: [],
    excludedDurationMs: 0, activeDurationMs: 0, timeShare: 0,
    noteShare: 0, judgementShare: 0, remainingNotes: map.notes.length, repeatShare: 0, reasonShares: {},
  };
  if (!usesSectionVibro(map) || !Number.isFinite(rate) || rate <= 0) return result;
  const scan = buildVibroScan(map, rate);
  result.activeDurationMs = measureActiveDuration(scan);

  // Order matters: scanIsolatedJacks reads the wall sections found before it,
  // and scanRecurringRepetitions reads bursts collected by the scanners above it.
  for (const motion of scanMotionVibro(map, rate)) addSection(scan, motion.startTime, motion.endTime, motion.reason);
  scanRepeatedRows(scan);
  scanQuadBody(scan);
  scanLockedHands(scan);
  scanFastTrills(scan);
  scanOneFingerBody(scan);
  scanRepeatedJackStreams(scan);
  scanRepeatedPairs(scan);
  scanFixedFingerWindows(scan);
  scanIsolatedJacks(scan);
  scanFastRolls(scan, countFastFingerReturns(scan, 70));
  scanExtremeDensity(scan);
  scanSustainedDensity(scan);
  scanRecurringRepetitions(scan);

  result.reasonShares = measureReasonShares(scan.intervals, rate, result.activeDurationMs);
  result.sections = mergeSections(scan.intervals);
  // Note: repeatShare is only measured when a section exists, so a clean chart reports 0.
  if (result.sections.length > 0) measureSectionCoverage(result, map, scan);
  return result;
}

/** Remove the hit objects inside the sections from .osu text. Timestamps,
 * metadata and breaks stay as they are; stitching the remaining notes together
 * would create stamina that is not in the chart. */
export function removeVibroSections(osuText: string, sections: VibroSection[]): string {
  let hitObjects = false;
  return osuText.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) hitObjects = trimmed === "[HitObjects]";
    if (!hitObjects || !trimmed.includes(",")) return true;
    const parts = trimmed.split(",");
    const start = Number(parts[2]);
    // Type bit 128 is a mania hold; its end time is the first field of extras.
    const end = Number(parts[3]) & 128 ? Number(parts[5]?.split(":")[0]) : start;
    return !overlapsVibro(start, end, sections);
  }).join("\n");
}

/** Analyze a chart and, when it is "adjusted", return the .osu text with its
 * vibro sections removed for rating. */
export function prepareVibroChart(osuText: string, rate = 1, map = parseManiaBeatmap(osuText)) {
  const analysis = analyzeVibroSections(map, rate);
  return {
    analysis,
    osuText: analysis.status === "adjusted" ? removeVibroSections(osuText, analysis.sections) : osuText,
  };
}

/** Lower bound on retained-note accuracy: assume the removed notes were
 * perfect and all losses occurred in the remainder. Input and output are 0-1. */
export function conservativeVibroAccuracy(accuracy: number, removedShare: number): number {
  if (!Number.isFinite(accuracy) || !Number.isFinite(removedShare) || removedShare >= 1) return 0;
  return Math.max(0, Math.min(1, 1 - (1 - accuracy) / (1 - Math.max(0, removedShare))));
}

// Scan state

interface VibroScan {
  /** Distinct hit times, ascending. */
  readonly times: readonly number[];
  /** Column bitmask of each row (bit 0 = column 1). */
  readonly rows: readonly number[];
  /** prefixNotes[i] = notes in rows 0..i-1. */
  readonly prefixNotes: readonly number[];
  readonly rate: number;
  /** Proven sections, one reason each until merged. */
  readonly intervals: VibroSection[];
  /** Short repetitions that only count when they recur nearby. */
  readonly repetitionBursts: VibroSection[];
}

const bitCount = (mask: number) => {
  let count = 0;
  for (; mask; mask &= mask - 1) count++;
  return count;
};

function buildVibroScan(map: ManiaBeatmap, rate: number): VibroScan {
  const masks = new Map<number, number>();
  for (const note of map.notes) masks.set(note.time, (masks.get(note.time) ?? 0) | (1 << note.column));
  const times = [...masks.keys()].sort((a, b) => a - b);
  const rows = times.map((time) => masks.get(time)!);
  const prefixNotes = [0];
  for (const mask of rows) prefixNotes.push(prefixNotes.at(-1)! + bitCount(mask));
  return { times, rows, prefixNotes, rate, intervals: [], repetitionBursts: [] };
}

function addSection(scan: VibroScan, start: number, end: number, reason: VibroReason): void {
  if (end > start) scan.intervals.push({ startTime: start, endTime: end, reasons: [reason] });
}

/** Add a section for every run of consecutive rows where matches(i) holds for
 * at least minTransitions row-to-row transitions. */
function scanConsecutiveRows(
  scan: VibroScan,
  matches: (index: number) => boolean,
  minTransitions: number,
  reason: VibroReason,
): void {
  const { times } = scan;
  let start = 1;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && matches(i)) continue;
    if (i - start >= minTransitions) addSection(scan, times[start - 1], times[i - 1], reason);
    start = i + 1;
  }
}

// Repeated rows and walls

// Short repetitions need faster reloads than the 92ms sustained-longjack floor,
// plus corroborating bursts in the same local phrase.
const RECURRING_REPETITION_GAP_MS = 80;

// Row reload (ms) at which a repeated shape stops being jacked and starts being
// shaken. Quads get a slightly wider cutoff; past it, a short quad wall (under
// 10.5 hits/s per finger) is quadjack a strong jack player hits finger by finger.
const REPEATED_ROW_GAP_MS = 92;
const repeatedRowGapMs = (mask: number) => mask === 15 ? REPEATED_QUAD_GAP_MS : REPEATED_ROW_GAP_MS;
// Past that reload a quad wall is still a wall when it goes on long enough.
const SLOW_QUAD_GAP_MS = 105;

// A shorter slow quad wall still counts when nothing around it is chordjack.
// Inside active chordjack, where the rows either side keep changing chord, a
// 17-21-quad wall at 96-105ms is quadjack (a short-wall quadjack chart holds
// 53-84% changing-chord rows around each wall). Dropped between repeated
// shapes, rolls and one-hand jumps (19-38% around the walls of a vibro dan
// course) it is a wall on its own. One such wall is an accent a jack player
// hits; the chart has to drop two before they count.
const IDLE_WALL_MIN_ROWS = 12;
const IDLE_WALL_MIN_COUNT = 2;
const IDLE_WALL_CONTEXT_ROWS = 16;
const IDLE_WALL_ACTIVE_SHARE = 0.4;

function scanRepeatedRows(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  // The same chord shape repeated separates a wall from varied chordjack.
  scanConsecutiveRows(scan, (i) => rows[i] === rows[i - 1] && bitCount(rows[i]) >= 2
    && times[i] - times[i - 1] <= repeatedRowGapMs(rows[i]) * rate,
  11, "repeated_wall");
  scanConsecutiveRows(scan, (i) => rows[i] === 15 && rows[i - 1] === 15
    && times[i] - times[i - 1] <= SLOW_QUAD_GAP_MS * rate,
  SLOW_QUAD_MIN_ROWS - 1, "repeated_wall");
  scanIdleQuadWalls(scan);
  scanConsecutiveRows(scan, (i) => rows[i] === rows[i - 1] && times[i] - times[i - 1] <= 92 * rate,
  24, "sustained_jack");
}

function scanIdleQuadWalls(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  const idle: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= times.length; i++) {
    const quad = i < times.length && rows[i] === 15;
    if (quad && start >= 0 && times[i] - times[i - 1] <= SLOW_QUAD_GAP_MS * rate) continue;
    if (start >= 0 && i - start >= IDLE_WALL_MIN_ROWS) {
      // Share of the 16 rows either side that are chords changing shape.
      let active = 0;
      let context = 0;
      const count = (k: number) => {
        context++;
        if (bitCount(rows[k]) >= 2 && rows[k] !== rows[k - 1]) active++;
      };
      for (let k = Math.max(1, start - IDLE_WALL_CONTEXT_ROWS); k < start; k++) count(k);
      for (let k = i; k < Math.min(times.length, i + IDLE_WALL_CONTEXT_ROWS); k++) count(k);
      if (context > 0 && active / context < IDLE_WALL_ACTIVE_SHARE) idle.push([times[start], times[i - 1]]);
    }
    start = quad ? i : -1;
  }
  if (idle.length < IDLE_WALL_MIN_COUNT) return;
  for (const [from, to] of idle) addSection(scan, from, to, "repeated_wall");
}

// A chart built out of quad walls is quadslop whatever each wall's length: the
// walls are the whole demand.
// Tier 1: share of notes in runs of 12+ consecutive quads at <=125ms. At 1.0x
// no ranked or loved 4K chart passes 12% (a short-wall quadjack chart sits
// exactly there), jack-practice packs put 1 of 4,858 charts past 25%, and 179
// of 778 charts from vibro-titled packs are past 30%. The gap bound keeps slow
// quad training (100 BPM 1/4, 150ms) out; a 125 BPM quad-wall chart at 120ms
// is in.
// Tier 2: the same in smaller pieces, runs of 3+ quads at <=100ms. At every
// rate played no ranked or loved chart passes 19% (a short-wall quadjack chart
// at 1.1x is the top), while 328 charts from vibro-titled packs pass 30%.
// Continuous quad chordjack that lifts one finger every few rows reads the same
// way and is excluded with it.
const QUAD_BODY_TIERS = [
  { gapMs: 125, minRows: 12, share: 0.25 },
  { gapMs: 100, minRows: 3, share: 0.3 },
] as const;

function scanQuadBody(scan: VibroScan): void {
  const { times, rows, prefixNotes, rate } = scan;
  for (const tier of QUAD_BODY_TIERS) {
    const walls: Array<[number, number]> = [];
    let wallNotes = 0;
    let start = -1;
    for (let i = 0; i <= times.length; i++) {
      const quad = i < times.length && rows[i] === 15;
      if (quad && start >= 0 && times[i] - times[i - 1] <= tier.gapMs * rate) continue;
      if (start >= 0 && i - start >= tier.minRows) {
        walls.push([start, i - 1]);
        wallNotes += (i - start) * 4;
      }
      start = quad ? i : -1;
    }
    if (wallNotes < prefixNotes.at(-1)! * tier.share) continue;
    for (const [first, last] of walls) addSection(scan, times[first], times[last], "repeated_wall");
  }
}

// Locked hands. Rows that are only a left-hand jump, a right-hand jump or a
// quad never ask a finger to move on its own: each hand strikes both its keys
// together. When every row also shares a hand with the one before it, the
// hands are jacking those jumps (quad, right, right, right, quad, left, left...)
// and each can shake as one unit. A jumptrill alternates hands on every row and
// never qualifies. Runs count from 24 such rows at <=95ms with a jump on each
// hand alone somewhere in them (a plain quad wall belongs to the wall rules).
// Runs that long are also ordinary accents in chordjack, so they only count
// once they carry 40% of the chart's notes: a gimmick chart of this shape holds
// 58% in 29-row runs, a chordjack chart with the same 27-30-row runs between
// its triples holds 31%. A single run of 64 rows counts on its own.
const LOCKED_HAND_GAP_MS = 95;
const LOCKED_HAND_MIN_ROWS = 24;
const LOCKED_HAND_LONG_ROWS = 64;
const LOCKED_HAND_SHARE = 0.4;

function scanLockedHands(scan: VibroScan): void {
  const { times, rows, prefixNotes, rate } = scan;
  const runs: Array<[number, number]> = [];
  let runNotes = 0;
  let start = -1;
  for (let i = 0; i <= times.length; i++) {
    const locked = i < times.length && (rows[i] === 3 || rows[i] === 12 || rows[i] === 15);
    if (locked && start >= 0 && (rows[i] & rows[i - 1]) !== 0
      && times[i] - times[i - 1] <= LOCKED_HAND_GAP_MS * rate) continue;
    if (start >= 0 && i - start >= LOCKED_HAND_MIN_ROWS) {
      let left = false;
      let right = false;
      for (let k = start; k < i; k++) {
        if (rows[k] === 3) left = true;
        if (rows[k] === 12) right = true;
      }
      if (left && right) {
        runs.push([start, i - 1]);
        runNotes += prefixNotes[i] - prefixNotes[start];
      }
    }
    start = locked ? i : -1;
  }
  const body = runNotes >= prefixNotes.at(-1)! * LOCKED_HAND_SHARE;
  for (const [first, last] of runs) {
    if (body || last - first + 1 >= LOCKED_HAND_LONG_ROWS) addSection(scan, times[first], times[last], "locked_hands");
  }
}

// Fast trills. Two fingers trading single notes and nothing else, fast and
// long: each finger sits near 12 hits/s, under the per-finger ceiling, for two
// seconds and more. The pair may change along the way (a 1-3 trill into a 2-4
// trill) as long as 80% of rows return to the finger two rows back. Over the
// played and labelled chart+rate pairs, runs of 48+ such rows at <=45ms appear
// in 29 pairs: 12 from vibro-titled packs and 3 ranked or loved pairs, all at
// DT, where only the trill is removed.
const FAST_TRILL_GAP_MS = 45;
const FAST_TRILL_MIN_ROWS = 48;
const FAST_TRILL_RETURN_SHARE = 0.8;

function scanFastTrills(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  const single = (mask: number) => mask !== 0 && (mask & (mask - 1)) === 0;
  let start = 0;
  let returns = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && single(rows[i]) && single(rows[i - 1]) && rows[i] !== rows[i - 1]
      && times[i] - times[i - 1] <= FAST_TRILL_GAP_MS * rate) {
      if (i - start >= 2 && rows[i] === rows[i - 2]) returns++;
      continue;
    }
    const length = i - start;
    if (length >= FAST_TRILL_MIN_ROWS && returns >= (length - 2) * FAST_TRILL_RETURN_SHARE) {
      addSection(scan, times[start], times[i - 1], "fast_trill");
    }
    start = i;
    returns = 0;
  }
}

// One-finger body. One finger jacking on every row at 11.4+ hits/s while the
// others add little, handed from column to column so no single run is long.
// Each run is 7+ hits at <=88ms, on 90% of the rows it spans, carrying 40% of
// the notes there. It counts once such runs hold a quarter of the chart. At
// every rate played no ranked or loved chart passes 19%; the 88ms bound keeps
// longjack training at ~10.8 hits/s out.
const ONE_FINGER_GAP_MS = 88;
const ONE_FINGER_MIN_HITS = 7;
const ONE_FINGER_COVERAGE = 0.9;
const ONE_FINGER_DOMINANCE = 0.4;
const ONE_FINGER_SHARE = 0.25;

function scanOneFingerBody(scan: VibroScan): void {
  const { times, rows, prefixNotes, rate } = scan;
  const runs: Array<[number, number]> = [];
  const covered = new Uint8Array(times.length);
  for (let column = 0; column < 4; column++) {
    const indices = rows.flatMap((mask, i) => mask & (1 << column) ? [i] : []);
    let start = 0;
    for (let i = 1; i <= indices.length; i++) {
      if (i < indices.length && times[indices[i]] - times[indices[i - 1]] <= ONE_FINGER_GAP_MS * rate) continue;
      const count = i - start;
      const first = indices[start];
      const last = indices[i - 1];
      if (count >= ONE_FINGER_MIN_HITS && count / (last - first + 1) >= ONE_FINGER_COVERAGE
        && count / (prefixNotes[last + 1] - prefixNotes[first]) >= ONE_FINGER_DOMINANCE) {
        runs.push([first, last]);
        covered.fill(1, first, last + 1);
      }
      start = i;
    }
  }
  let coveredNotes = 0;
  for (let i = 0; i < times.length; i++) if (covered[i]) coveredNotes += prefixNotes[i + 1] - prefixNotes[i];
  if (coveredNotes < prefixNotes.at(-1)! * ONE_FINGER_SHARE) return;
  for (const [first, last] of runs) addSection(scan, times[first], times[last], "isolated_jack");
}

/** A sustained stream of short fixed-shape jacks. Rows that belong to 3-11-hit
 * repetitions of one shape (at the wall reload, quads at their wider one) are
 * counted over 64-row windows of uninterrupted <=100ms rows. A window counts
 * when 70% of its rows are such repetitions, 35% are repeated chords, and it
 * holds at least two different repeated shapes. Quad accents and a different
 * repeated jump in the next beat do not reset the passage. Single-finger
 * triples with occasional chord accents are ordinary minijack, and longer
 * walls have their own rule, so they cannot spread into nearby chordjack
 * through this window. Slower jump-jack bursts do not qualify by lasting
 * longer. */
function scanRepeatedJackStreams(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  const burstRows = new Uint8Array(times.length);
  const burstShapes = new Uint8Array(times.length);
  let repeatStart = 0;
  let maxRepeatGap = 0;
  for (let i = 1; i <= times.length; i++) {
    // Phrase boundaries use the 100ms stream cutoff, not the reload cutoff:
    // splitting a long jack on rounded 92/93ms gaps would manufacture short
    // repetitions.
    if (i < times.length && rows[i] === rows[i - 1] && times[i] - times[i - 1] <= 100 * rate) {
      maxRepeatGap = Math.max(maxRepeatGap, times[i] - times[i - 1]);
      continue;
    }
    const count = i - repeatStart;
    if (count >= 3 && count < 12 && maxRepeatGap <= repeatedRowGapMs(rows[repeatStart]) * rate) {
      burstRows.fill(1, repeatStart, i);
      burstShapes.fill(rows[repeatStart], repeatStart, i);
    }
    repeatStart = i;
    maxRepeatGap = 0;
  }
  let fastStart = 0;
  let repeatedInWindow = 0;
  let repeatedChordsInWindow = 0;
  const shapeCounts = new Int32Array(16);
  let distinctShapes = 0;
  const burstWindowRows = 64;
  for (let i = 0; i < times.length; i++) {
    if (i > 0 && times[i] - times[i - 1] > 100 * rate) fastStart = i;
    repeatedInWindow += burstRows[i];
    repeatedChordsInWindow += burstRows[i] && bitCount(rows[i]) >= 2 ? 1 : 0;
    if (burstShapes[i] && shapeCounts[burstShapes[i]]++ === 0) distinctShapes++;
    if (i >= burstWindowRows) repeatedInWindow -= burstRows[i - burstWindowRows];
    if (i >= burstWindowRows) repeatedChordsInWindow -= burstRows[i - burstWindowRows] && bitCount(rows[i - burstWindowRows]) >= 2 ? 1 : 0;
    if (i >= burstWindowRows && burstShapes[i - burstWindowRows]
      && --shapeCounts[burstShapes[i - burstWindowRows]] === 0) distinctShapes--;
    if (i - fastStart + 1 >= burstWindowRows && repeatedInWindow / burstWindowRows >= 0.7
      && repeatedChordsInWindow / burstWindowRows >= 0.35 && distinctShapes >= 2) {
      addSection(scan, times[i - burstWindowRows + 1], times[i], "repeated_jack_stream");
    }
  }
}

/** The same two-finger pair on 12+ consecutive rows at <=70ms, whatever else
 * is struck alongside it. An occasional accent cannot disguise a fixed pair,
 * but the pair has to be the same throughout, not a different shared pair on
 * each changing chord. */
function scanRepeatedPairs(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  for (const pair of [3, 5, 6, 9, 10, 12]) {
    scanConsecutiveRows(scan, (i) => (rows[i] & pair) === pair && (rows[i - 1] & pair) === pair
      && times[i] - times[i - 1] <= 70 * rate,
    11, "repeated_chord");
  }
}

// Fixed-finger windows

interface RepetitionBand {
  /** Longest gap (ms) between hits before the phrase restarts. */
  gapMs: number;
  /** Longest average gap (ms) across the minHits window. */
  averageGapMs: number;
  minHits: number;
  /** Share of the window's notes the fixed fingers must carry. */
  minShare: number;
  reason: VibroReason;
}

const SINGLE_FINGER_BANDS: readonly RepetitionBand[] = [
  { gapMs: 30, averageGapMs: 30, minHits: 4, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 85, averageGapMs: 55, minHits: 9, minShare: 0, reason: "rapid_jack_burst" },
];
// Row spacing (ms) at which a shared pair stops being material a player can
// articulate: two fingers returning this fast sit at the ranked corpus's finger
// maximum (12.81 hits/s, 4K rice), while chordjack of the kind this gate
// protects reloads at 11.24/s.
const PAIR_LOCK_GAP_MS = 85;

const PAIR_BANDS: readonly RepetitionBand[] = [
  { gapMs: 55, averageGapMs: 55, minHits: 4, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 60, averageGapMs: 60, minHits: 6, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 92, averageGapMs: 92, minHits: 12, minShare: 0.7, reason: "repeated_chord" },
];
const QUAD_BANDS: readonly RepetitionBand[] = [
  { gapMs: 92, averageGapMs: 92, minHits: 8, minShare: 0, reason: "repeated_wall" },
];

/** Follow fixed fingers (one finger, a pair, or all four) through chord
 * accents and rows in between. Each window must meet its own speed and
 * repetition requirements, so slower context cannot dilute a fast local
 * window. At moderate speed a fixed pair must dominate the local notes, so a
 * shared pair in otherwise varied chordjack is not enough. Quads need fewer
 * repetitions. Irregular fast single-finger runs may include brief slower
 * gaps as long as their average return stays very short. */
function scanFixedFingerWindows(scan: VibroScan): void {
  const { times, rows, prefixNotes, rate } = scan;
  for (const mask of [1, 2, 4, 8, 3, 5, 6, 9, 10, 12, 15]) {
    const fingers = bitCount(mask);
    const indices = rows.flatMap((row, i) => (row & mask) === mask ? [i] : []);
    const bands = fingers === 1 ? SINGLE_FINGER_BANDS : fingers === 4 ? QUAD_BANDS : PAIR_BANDS;
    for (const band of bands) {
      let phraseStart = 0;
      let phraseEnd = 0;
      for (let i = 0; i < indices.length; i++) {
        if (i > 0 && times[indices[i]] - times[indices[i - 1]] > band.gapMs * rate) phraseStart = i;
        if (fingers === 2 && band.minShare > 0 && i === phraseStart) {
          phraseEnd = i;
          while (phraseEnd + 1 < indices.length
            && times[indices[phraseEnd + 1]] - times[indices[phraseEnd]] <= band.gapMs * rate) phraseEnd++;
        }
        const firstHit = i - band.minHits + 1;
        if (firstHit < phraseStart) continue;
        const first = indices[firstHit];
        const last = indices[i];
        if (times[last] - times[first] > (band.minHits - 1) * band.averageGapMs * rate) continue;
        const localNotes = prefixNotes[last + 1] - prefixNotes[first];
        // At the moderate long-jack speed, a shared pair under changing
        // accompaniment is chordjack, so the pair has to hold most of the rows.
        // What counts as holding depends on reload speed. Slower than
        // PAIR_LOCK_GAP_MS the bare pair is required: restriking two fingers
        // while the shape around them changes is chordjack a player can
        // articulate. At or under it the pair only has to be present, because
        // two fingers returning every 85ms or less do the same work whether or
        // not something is struck alongside them; requiring a bare row would
        // let a 79ms double pass by decorating every other row. Varied
        // chordjack rotates its pairs, so no single pair holds two thirds of the
        // rows either way. A pair sustained for 25+ hits at the band's share
        // skips the two-thirds test.
        if (fingers === 2 && band.minShare > 0) {
          const locked = (times[last] - times[first]) / (last - first) <= PAIR_LOCK_GAP_MS * rate;
          let heldRows = 0;
          for (let row = first; row <= last; row++) {
            if (locked ? (rows[row] & mask) === mask : rows[row] === mask) heldRows++;
          }
          const phraseHits = phraseEnd - phraseStart + 1;
          const phraseNotes = prefixNotes[indices[phraseEnd] + 1] - prefixNotes[indices[phraseStart]];
          const sustainedPair = phraseHits >= 25 && phraseHits * fingers / phraseNotes >= band.minShare;
          if (!sustainedPair && heldRows / (last - first + 1) < 2 / 3) continue;
        }
        if (band.minHits * fingers / localNotes >= band.minShare) addSection(scan, times[first], times[last], band.reason);
      }
    }
    collectShortRepetitions(scan, indices, fingers);
  }
}

/** Short jacks below the immediate-burst speed. They become sections only when
 * scanRecurringRepetitions finds them recurring nearby. */
function collectShortRepetitions(scan: VibroScan, indices: number[], fingers: number): void {
  const { times, prefixNotes, rate, repetitionBursts } = scan;
  const minHits = fingers === 1 ? 6 : 4;
  const maxHits = fingers === 1 ? 24 : fingers === 2 ? 11 : 7;
  let start = 0;
  for (let end = 1; end <= indices.length; end++) {
    // Keep a whole run together across rounding and minor rhythm changes;
    // splitting long walls into short candidates would manufacture recurrence.
    if (end < indices.length && times[indices[end]] - times[indices[end - 1]] <= 100 * rate) continue;
    const hits = end - start;
    if (hits >= minHits && hits <= maxHits) {
      for (let i = start + minHits - 1; i < end; i++) {
        const first = indices[i - minHits + 1], last = indices[i];
        // Short runs need faster reloads than a sustained longjack, so ordinary
        // ~90ms speedjack bursts do not become vibro by repeating.
        if (times[last] - times[first] > (minHits - 1) * RECURRING_REPETITION_GAP_MS * rate) continue;
        const share = minHits * fingers / (prefixNotes[last + 1] - prefixNotes[first]);
        // Quad accents at both ends of a four-hit pair leave 8 of 12 notes on
        // that pair, which must still count as the repetition in its middle.
        if (fingers === 1 ? share <= 0.5 || minHits / (last - first + 1) < 0.9 : fingers === 2 && share < 2 / 3) continue;
        repetitionBursts.push({ startTime: times[first], endTime: times[last],
          reasons: [fingers === 1 ? "isolated_jack" : fingers === 2 ? "repeated_chord" : "repeated_wall"] });
      }
    }
    start = end;
  }
}

/** Single-finger runs of 9+ hits at <=100ms that sparse accompaniment cannot
 * hide. Long runs (25+ hits averaging <=92ms) count on their own when the
 * finger carries 65% of the local notes, or a majority while sitting on 90% of
 * the rows. Any run carrying 65% also counts once 4+ such runs together hold
 * 20% of the chart's notes.
 * Dense changing chords around a busy finger meet neither rule. */
function scanIsolatedJacks(scan: VibroScan): void {
  const { times, rows, prefixNotes, rate, intervals } = scan;
  const bursts: VibroSection[] = [];
  const slowerRuns: Array<VibroSection & { column: number }> = [];
  let isolatedBurstNotes = 0;
  for (let column = 0; column < 4; column++) {
    const indices = rows.flatMap((mask, i) => mask & (1 << column) ? [i] : []);
    let start = 0;
    for (let i = 1; i <= indices.length; i++) {
      if (i < indices.length && times[indices[i]] - times[indices[i - 1]] <= 100 * rate) continue;
      const count = i - start;
      if (count >= 9) {
        const first = indices[start];
        const last = indices[i - 1];
        const localNotes = prefixNotes[last + 1] - prefixNotes[first];
        const dominant = count / localNotes >= 0.65;
        const longRun = count >= 25 && (times[last] - times[first]) / (count - 1) <= 92 * rate;
        const accompaniedLongJack = longRun && count / localNotes > 0.5 && count / (last - first + 1) >= 0.9;
        if (!longRun && count >= 25 && (times[last] - times[first]) / (count - 1) <= 100 * rate
          && count / localNotes > 0.5 && count / (last - first + 1) >= 0.9) {
          slowerRuns.push({ startTime: times[first], endTime: times[last], reasons: ["isolated_jack"], column });
        }
        if (dominant || accompaniedLongJack) {
          const section: VibroSection = { startTime: times[first], endTime: times[last], reasons: ["isolated_jack"] };
          if (dominant) {
            bursts.push(section);
            isolatedBurstNotes += count;
          }
          if (longRun) intervals.push(section);
        }
      }
      start = i;
    }
  }
  // Repeated short isolated bursts are evidence together; a lone speedjack
  // burst in an otherwise varied chart is not removed.
  if (bursts.length >= 4 && isolatedBurstNotes / prefixNotes.at(-1)! >= 0.2) intervals.push(...bursts);
  // A slower accompanied longjack (averaging 92-100ms) alone is legit training
  // material. It counts only inside a local mixed phrase: runs within 2s of
  // each other on at least two fingers, within 2s of a separately detected
  // wall or repeated chord section lasting 1s+.
  const wallSections = mergeSections(intervals.filter((section) => section.reasons.includes("repeated_wall")
    || section.reasons.includes("repeated_chord")))
    .filter((section) => section.endTime - section.startTime >= 1000 * rate);
  slowerRuns.sort((a, b) => a.startTime - b.startTime);
  let start = 0;
  for (let end = 1; end <= slowerRuns.length; end++) {
    if (end < slowerRuns.length && slowerRuns[end].startTime - slowerRuns[end - 1].endTime <= 2000 * rate) continue;
    const phrase = slowerRuns.slice(start, end);
    if (new Set(phrase.map((run) => run.column)).size >= 2 && wallSections.some((wall) =>
      wall.startTime <= phrase.at(-1)!.endTime + 2000 * rate
      && wall.endTime >= phrase[0].startTime - 2000 * rate)) {
      for (const { column: _column, ...section } of phrase) intervals.push(section);
    }
    start = end;
  }
}

// Rolls and density

/** Per row, how many of its fingers re-hit within gapMs of their previous note. */
function countFastFingerReturns(scan: VibroScan, gapMs: number): number[] {
  const { times, rows, rate } = scan;
  const lastTimes = new Array<number>(4).fill(-Infinity);
  const repeatedFingers: number[] = [];
  for (let i = 0; i < times.length; i++) {
    let fast = 0;
    for (let column = 0; column < 4; column++) {
      if (!(rows[i] & (1 << column))) continue;
      if (times[i] - lastTimes[column] <= gapMs * rate) fast++;
      lastTimes[column] = times[i];
    }
    repeatedFingers.push(fast);
  }
  return repeatedFingers;
}

/** Rolls: 9+ rows where each row shares no column with the previous one and
 * sits <=25ms after it. Disjoint fast rows alone include flams, so the run also
 * needs a quarter of its notes to be fast finger returns (<=70ms). Runs of 25+
 * rows count on their own; shorter ones count when 4+ of them together hold 20%
 * of the chart. */
function scanFastRolls(scan: VibroScan, repeatedFingers: readonly number[]): void {
  const { times, rows, prefixNotes, rate, intervals } = scan;
  let rollStart = 1;
  const rollBursts: VibroSection[] = [];
  let rollBurstNotes = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && !(rows[i] & rows[i - 1]) && times[i] - times[i - 1] <= 25 * rate) continue;
    if (i - rollStart >= 8) {
      const fast = repeatedFingers.slice(rollStart, i).reduce((a, b) => a + b, 0);
      const notes = prefixNotes[i] - prefixNotes[rollStart];
      // Returns counted inside this burst only (<=80ms), without borrowing hits
      // from the chord or jack passage before it. These feed the recurrence
      // check rather than proving a section.
      const lastTimes = new Array<number>(4).fill(-Infinity);
      let contextualFast = 0;
      for (let row = rollStart - 1; row < i; row++) {
        for (let column = 0; column < 4; column++) {
          if (!(rows[row] & (1 << column))) continue;
          if (times[row] - lastTimes[column] <= RECURRING_REPETITION_GAP_MS * rate) contextualFast++;
          lastTimes[column] = times[row];
        }
      }
      if (contextualFast / notes >= 0.25) {
        scan.repetitionBursts.push({ startTime: times[rollStart - 1], endTime: times[i - 1], reasons: ["fast_roll"] });
      }
      if (fast / notes >= 0.25) {
        const section: VibroSection = { startTime: times[rollStart - 1], endTime: times[i - 1], reasons: ["fast_roll"] };
        if (i - rollStart >= 24) intervals.push(section);
        rollBursts.push(section);
        rollBurstNotes += notes;
      }
    }
    rollStart = i + 1;
  }
  if (rollBursts.length >= 4 && rollBurstNotes / prefixNotes.at(-1)! >= 0.2) intervals.push(...rollBursts);
}

/** 65+ rows inside any one second of play. */
function scanExtremeDensity(scan: VibroScan): void {
  const { times, rate } = scan;
  let windowStart = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[windowStart] > 1000 * rate) windowStart++;
    if (i - windowStart + 1 >= 65) addSection(scan, times[windowStart], times[i], "extreme_density");
  }
}

/** Ten seconds in which all four fingers average 12.2 hits a second each, at
 * the played rate. No single-finger or hand ceiling fires on it, since every
 * note is in reach of a finger, but nobody jacks four columns that fast for ten
 * seconds without vibrating. The densest chordjack ruled legit stops at 11.9,
 * the DT chordjack walls ruled vibro start at 12.4. Excludes whatever the
 * coverage. */
const SUSTAINED_WINDOW_MS = 10_000;
const SUSTAINED_FINGER_RATE = 12.2;

function scanSustainedDensity(scan: VibroScan): void {
  const { times, prefixNotes, rate } = scan;
  const minNotes = SUSTAINED_FINGER_RATE * 4 * SUSTAINED_WINDOW_MS / 1000;
  let windowStart = 0;
  for (let i = 0; i < times.length; i++) {
    // The slack keeps an exact ten-second window the same whether the rate is
    // applied here or already baked into the timestamps.
    while ((times[i] - times[windowStart]) / rate > SUSTAINED_WINDOW_MS + 1e-6) windowStart++;
    if (prefixNotes[i + 1] - prefixNotes[windowStart] >= minNotes) {
      addSection(scan, times[windowStart], times[i], "sustained_density");
    }
  }
}

// Recurring short repetitions

/** Alternating fixed jumps (two disjoint 2-note chords trading at <=50ms, each
 * returning within 80ms) reload the same fingers even though adjacent rows
 * differ. 8+ rows become a repetition burst. */
function collectAlternatingChords(scan: VibroScan): void {
  const { times, rows, rate, repetitionBursts } = scan;
  let start = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && bitCount(rows[i]) === 2 && bitCount(rows[i - 1]) === 2
      && !(rows[i] & rows[i - 1]) && times[i] - times[i - 1] <= 50 * rate
      && (i === start + 1 || (rows[i] === rows[i - 2] && times[i] - times[i - 2] <= RECURRING_REPETITION_GAP_MS * rate))) continue;
    if (i - start >= 8) repetitionBursts.push({ startTime: times[start], endTime: times[i - 1], reasons: ["repeated_chord"] });
    start = i;
  }
}

/** Short repetition bursts become sections when three or more nearby ones
 * (gaps of at most 1s, spanning at most 6.4s) cover 24+ rows and 70% of their
 * span, with at least two of them jacks rather than rolls. The bursts' own
 * intervals are kept, not the pauses between them. */
function scanRecurringRepetitions(scan: VibroScan): void {
  collectAlternatingChords(scan);
  // Merge overlapping finger windows first, so one repeated jump does not count
  // as three bursts because both fingers and their pair were detected. Touching
  // bursts stay separate: a shared quad accent can end one hand's burst and
  // start the other's.
  const bursts = mergeSections(scan.repetitionBursts, false);
  if (bursts.length < 3) return;
  const indices = new Map(scan.times.map((time, index) => [time, index]));
  const prefixDuration = [0], prefixRows = [0], prefixJacks = [0];
  for (const [i, burst] of bursts.entries()) {
    prefixDuration.push(prefixDuration.at(-1)! + burst.endTime - burst.startTime);
    const sharedRow = i > 0 && bursts[i - 1].endTime === burst.startTime;
    prefixRows.push(prefixRows.at(-1)! + indices.get(burst.endTime)! - indices.get(burst.startTime)! + (sharedRow ? 0 : 1));
    prefixJacks.push(prefixJacks.at(-1)! + (burst.reasons.some((reason) => reason !== "fast_roll") ? 1 : 0));
  }
  // Difference array: mark every burst covered by at least one qualifying group.
  const included = new Int32Array(bursts.length + 1);
  let phraseStart = 0;
  for (let end = 0; end < bursts.length; end++) {
    if (end > 0 && bursts[end].startTime - bursts[end - 1].endTime > 1000 * scan.rate) phraseStart = end;
    for (let start = end - 2; start >= phraseStart; start--) {
      const span = bursts[end].endTime - bursts[start].startTime;
      if (span > 6400 * scan.rate) break;
      const duration = prefixDuration[end + 1] - prefixDuration[start];
      const sharedFirstRow = start > 0 && bursts[start - 1].endTime === bursts[start].startTime;
      const rows = prefixRows[end + 1] - prefixRows[start] + (sharedFirstRow ? 1 : 0);
      // Rolls can join a repetitive jack passage but cannot establish one alone.
      const jacks = prefixJacks[end + 1] - prefixJacks[start];
      if (jacks >= 2 && rows >= 24 && duration / span >= 0.7) {
        included[start]++;
        included[end + 1]--;
      }
    }
  }
  let support = 0;
  for (let i = 0; i < bursts.length; i++) {
    support += included[i];
    if (support > 0) scan.intervals.push(bursts[i]);
  }
}

// Merging and coverage

/** Sort intervals by start (in place) and merge overlapping ones, unioning
 * their reasons. Touching intervals merge unless mergeTouching is false. */
function mergeSections(intervals: VibroSection[], mergeTouching = true): VibroSection[] {
  const sections: VibroSection[] = [];
  for (const section of intervals.sort((a, b) => a.startTime - b.startTime)) {
    const previous = sections.at(-1);
    if (previous && (section.startTime < previous.endTime || (mergeTouching && section.startTime === previous.endTime))) {
      previous.endTime = Math.max(previous.endTime, section.endTime);
      previous.reasons = [...new Set([...previous.reasons, ...section.reasons])];
    } else sections.push({ ...section });
  }
  return sections;
}

function measureReasonShares(
  intervals: readonly VibroSection[],
  rate: number,
  activeDurationMs: number,
): Partial<Record<VibroReason, number>> {
  const shares: Partial<Record<VibroReason, number>> = {};
  if (activeDurationMs <= 0) return shares;
  const byReason = new Map<VibroReason, VibroSection[]>();
  for (const interval of intervals) {
    for (const reason of interval.reasons) {
      const bucket = byReason.get(reason);
      if (bucket) bucket.push(interval);
      else byReason.set(reason, [interval]);
    }
  }
  for (const [reason, group] of byReason) {
    let covered = 0;
    for (const merged of mergeSections(group)) covered += (merged.endTime - merged.startTime) / rate;
    shares[reason] = covered / activeDurationMs;
  }
  return shares;
}

function measureActiveDuration({ times, rate }: VibroScan): number {
  // Intros, breaks and padding must not dilute a dominant spam section.
  let duration = 0;
  for (let i = 1; i < times.length; i++) {
    duration += Math.min(times[i] - times[i - 1], 1000 * rate) / rate;
  }
  return duration;
}

// Repeat body. Share of notes inside single-column runs of 4+ back-to-back rows
// at <=95ms, over the whole chart. It never removes anything on its own; it
// sets how much proven vibro a chart may carry and still be rated on the rest.
// When it reaches 25%, the note cap drops from 25% to 13%: a chart that repeats
// a column this often across its whole body is not a varied chart with a few
// vibro accents, and its proven sections are samples rather than exceptions.
// Over the 70,074 cached 4K rice charts with rated plays, 85 of them (665 of
// 1,754,954 rated plays, 0.038%) clear both bars, almost all from packs that
// advertise themselves as vibro. No chart in the dan course registry comes
// within 0.12 of the note bar, and the closest chart kept as "adjusted" stops
// 0.12 short of it with a higher repeat share, which sets the bar.
const REPEAT_RUN_GAP_MS = 95;
const REPEAT_RUN_MIN_HITS = 4;
const REPEAT_BODY_SHARE = 0.25;
const REPEAT_BODY_NOTE_CAP = 0.13;

function measureSectionCoverage(result: VibroAnalysis, map: ManiaBeatmap, scan: VibroScan): void {
  const { times, rate } = scan;
  let removedNotes = 0;
  let removedWeight = 0;
  for (const note of map.notes) {
    if (!overlapsVibro(note.time, note.endTime, result.sections)) continue;
    removedNotes++;
    removedWeight += note.isHold ? 2 : 1;
  }
  result.remainingNotes -= removedNotes;
  result.noteShare = removedNotes / map.notes.length;
  // Repeat share is read at the chart's own speed, never faster: a rate pushes
  // any 1/4 chordjack into the jack band, so every uprated chordjack chart
  // would look built from repetition. Slowed plays keep their own rate, which
  // only narrows the band.
  result.repeatShare = measureRepeatShare(scan.rate > 1 ? { ...scan, rate: 1 } : scan);
  result.judgementShare = removedWeight / (removedWeight + result.remainingNotes);
  let sectionIndex = 0;
  for (let i = 1; i < times.length; i++) {
    while (sectionIndex < result.sections.length && result.sections[sectionIndex].endTime < times[i - 1]) sectionIndex++;
    for (let j = sectionIndex; j < result.sections.length && result.sections[j].startTime < times[i]; j++) {
      const section = result.sections[j];
      const overlap = Math.min(times[i], section.endTime) - Math.max(times[i - 1], section.startTime);
      if (overlap > 0) result.excludedDurationMs += Math.min(overlap, 1000 * rate) / rate;
    }
  }
  result.timeShare = result.activeDurationMs > 0 ? result.excludedDurationMs / result.activeDurationMs : 1;
  // Time and note coverage both matter. The remaining chart is rated again from
  // scratch, so easy padding cannot keep the spam-inflated difficulty.
  const noteCap = result.repeatShare >= REPEAT_BODY_SHARE ? REPEAT_BODY_NOTE_CAP : 0.25;
  // Ten seconds of four-finger density is the body of the chart at this rate,
  // not an accent to cut around.
  result.status = !result.reasonShares.sustained_density
    && result.timeShare <= 0.15 && result.noteShare <= noteCap
    && result.remainingNotes >= 300 && result.activeDurationMs - result.excludedDurationMs >= 20_000
    ? "adjusted" : "excluded";
}

function measureRepeatShare(scan: VibroScan): number {
  const { times, rows, prefixNotes, rate } = scan;
  const total = prefixNotes.at(-1)!;
  if (total === 0) return 0;
  const covered = new Uint8Array(rows.length);
  for (let column = 0; column < 4; column++) {
    const indices = rows.flatMap((mask, index) => mask & (1 << column) ? [index] : []);
    let start = 0;
    for (let i = 1; i <= indices.length; i++) {
      // Back-to-back rows only. A finger returning every other row is trilling
      // with its neighbour, which the motion arms cover; this measures jacks.
      if (i < indices.length && indices[i] === indices[i - 1] + 1
        && times[indices[i]] - times[indices[i - 1]] <= REPEAT_RUN_GAP_MS * rate) continue;
      if (i - start >= REPEAT_RUN_MIN_HITS) for (let k = start; k < i; k++) covered[indices[k]] = 1;
      start = i;
    }
  }
  let notes = 0;
  for (let i = 0; i < rows.length; i++) if (covered[i]) notes += bitCount(rows[i]);
  return notes / total;
}

/** Whether [start, end] touches any section. Sections are sorted and disjoint. */
function overlapsVibro(start: number, end: number, sections: VibroSection[]): boolean {
  let low = 0;
  let high = sections.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sections[mid].endTime < start) low = mid + 1;
    else high = mid;
  }
  return low < sections.length && sections[low].startTime <= end;
}
