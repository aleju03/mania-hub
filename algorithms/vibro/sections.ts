import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { REPEATED_QUAD_GAP_MS, SLOW_QUAD_MIN_ROWS, scanMotionVibro } from "./motion";
import { usesPrism } from "../msd/prism";
import { inspectChartDanEligibility } from "../classification/dan-eligibility";

export const VIBRO_SECTION_VERSION = 11;

const RECURRING_REPETITION_GAP_MS = 80;

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
  | "jumptrill"
  | "stacked_heads"
  | "flam_chords"
  | "sustained_density";

export interface VibroSection {
  startTime: number;
  endTime: number;
  reasons: VibroReason[];
}

export interface VibroAnalysis {
  version: number;
  status: "clean" | "adjusted" | "excluded";
  sections: VibroSection[];
  excludedDurationMs: number;
  activeDurationMs: number;
  timeShare: number;
  noteShare: number;
  judgementShare: number;
  remainingNotes: number;
  repeatShare: number;
  reasonShares: Partial<Record<VibroReason, number>>;
}

const UNRATEABLE_REASONS: ReadonlySet<string> = new Set<VibroReason>(["jumptrill", "stacked_heads", "flam_chords"]);

export function isUnrateableExclusion(analysis: Pick<VibroAnalysis, "status" | "reasonShares"> | null | undefined): boolean {
  if (analysis?.status !== "excluded") return false;
  const reasons = Object.keys(analysis.reasonShares ?? {});
  return reasons.length > 0 && reasons.every((reason) => UNRATEABLE_REASONS.has(reason));
}

export function analyzeStackedHeads(map: ManiaBeatmap, rate = 1): VibroAnalysis | null {
  if (!map.notes.length || !Number.isFinite(rate) || rate <= 0 || inspectChartDanEligibility(map).eligible) return null;
  const activeDurationMs = measureActiveDuration(buildVibroScan(map, rate));
  let first = Infinity;
  let last = -Infinity;
  for (const note of map.notes) {
    first = Math.min(first, note.time);
    last = Math.max(last, note.time);
  }
  return {
    version: VIBRO_SECTION_VERSION, status: "excluded",
    sections: [{ startTime: first, endTime: last, reasons: ["stacked_heads"] }],
    excludedDurationMs: activeDurationMs, activeDurationMs, timeShare: 1, noteShare: 1, judgementShare: 1,
    remainingNotes: 0, repeatShare: 0, reasonShares: { stacked_heads: 1 },
  };
}

const FLAM_PRESS_MS = 40;
const FLAM_FINGER_FREE_MS = 100;
const FLAM_CHART_SHARE = 0.3;

export function analyzeCollapsedNotes(map: ManiaBeatmap, rate = 1): VibroAnalysis | null {
  if (map.keyCount !== 4 || !map.notes.length || !Number.isFinite(rate) || rate <= 0) return null;
  const taps = buildVibroScan({ ...map, notes: map.notes.filter((note) => !note.isHold) }, rate);
  if (!taps.times.length || countFlamChordNotes(taps) < map.notes.length * FLAM_CHART_SHARE) return null;
  const scan = buildVibroScan(map, rate);
  const activeDurationMs = measureActiveDuration(scan);
  return {
    version: VIBRO_SECTION_VERSION, status: "excluded",
    sections: [{ startTime: scan.times[0], endTime: scan.times.at(-1)!, reasons: ["flam_chords"] }],
    excludedDurationMs: activeDurationMs, activeDurationMs, timeShare: 1, noteShare: 1, judgementShare: 1,
    remainingNotes: 0, repeatShare: 0, reasonShares: { flam_chords: 1 },
  };
}

function countFlamChordNotes({ times, rows, prefixNotes, rate }: VibroScan): number {
  const nextOnColumns = new Array<number>(times.length);
  const nextOnColumn = new Array<number>(4).fill(Infinity);
  for (let i = times.length - 1; i >= 0; i--) {
    let next = Infinity;
    for (let column = 0; column < 4; column++) {
      if (!(rows[i] & (1 << column))) continue;
      next = Math.min(next, nextOnColumn[column]);
      nextOnColumn[column] = times[i];
    }
    nextOnColumns[i] = next;
  }
  let flamNotes = 0;
  let start = 0;
  let mask = rows[0];
  const closePress = (end: number) => {
    if (end - start < 2) return;
    for (let k = start; k < end; k++) if (prefixNotes[k + 1] - prefixNotes[k] < 2) return;
    flamNotes += prefixNotes[end] - prefixNotes[start];
  };
  for (let i = 1; i < times.length; i++) {
    let joins = times[i] - times[start] <= FLAM_PRESS_MS * rate && !(rows[i] & mask);
    for (let k = start; joins && k < i; k++) joins = nextOnColumns[k] - times[i] >= FLAM_FINGER_FREE_MS * rate;
    if (joins) {
      mask |= rows[i];
      continue;
    }
    closePress(i);
    start = i;
    mask = rows[i];
  }
  closePress(times.length);
  return flamNotes;
}

export function usesSectionVibro(map: ManiaBeatmap): boolean {
  return map.keyCount === 4 && map.notes.length > 0
    && map.notes.filter((note) => note.isHold).length / map.notes.length <= 0.1;
}

const bitCount = (mask: number) => {
  let count = 0;
  for (; mask; mask &= mask - 1) count++;
  return count;
};

export function analyzeVibroSections(map: ManiaBeatmap, rate = 1): VibroAnalysis {
  const result: VibroAnalysis = {
    version: VIBRO_SECTION_VERSION, status: "clean", sections: [],
    excludedDurationMs: 0, activeDurationMs: 0, timeShare: 0,
    noteShare: 0, judgementShare: 0, remainingNotes: map.notes.length, repeatShare: 0, reasonShares: {},
  };
  if (!usesSectionVibro(map) || !Number.isFinite(rate) || rate <= 0) return result;
  const unrateable = analyzeStackedHeads(map, rate) ?? analyzeCollapsedNotes(map, rate);
  if (unrateable) return unrateable;
  const scan = buildVibroScan(map, rate);
  result.activeDurationMs = measureActiveDuration(scan);

  for (const motion of scanMotionVibro(map, rate)) addSection(scan, motion.startTime, motion.endTime, motion.reason);
  scanRepeatedRows(scan);
  scanQuadBody(scan);
  scanLockedHands(scan);
  scanFastTrills(scan);
  scanJumptrills(scan);
  scanHammeredChords(scan);
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
  if (result.sections.length > 0) measureSectionCoverage(result, map, scan);
  return result;
}

interface VibroScan {
  readonly times: readonly number[];
  readonly rows: readonly number[];
  readonly prefixNotes: readonly number[];
  readonly rate: number;
  readonly intervals: VibroSection[];
  readonly repetitionBursts: VibroSection[];
}

function buildVibroScan(map: ManiaBeatmap, rate: number): VibroScan {
  const masks = new Map<number, number>();
  for (const note of map.notes) masks.set(note.time, (masks.get(note.time) ?? 0) | (1 << note.column));
  const times = [...masks.keys()].sort((a, b) => a - b);
  const rows = times.map((time) => masks.get(time)!);
  const prefixNotes = [0];
  for (const mask of rows) prefixNotes.push(prefixNotes.at(-1)! + bitCount(mask));
  return { times, rows, prefixNotes, rate, intervals: [], repetitionBursts: [] };
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

function addSection(scan: VibroScan, start: number, end: number, reason: VibroReason): void {
  if (end > start) scan.intervals.push({ startTime: start, endTime: end, reasons: [reason] });
}

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

const REPEATED_ROW_GAP_MS = 92;
const repeatedRowGapMs = (mask: number) => mask === 15 ? REPEATED_QUAD_GAP_MS : REPEATED_ROW_GAP_MS;

const SLOW_QUAD_GAP_MS = 105;

const IDLE_WALL_MIN_ROWS = 12;
const IDLE_WALL_MIN_COUNT = 2;
const IDLE_WALL_CONTEXT_ROWS = 16;
const IDLE_WALL_ACTIVE_SHARE = 0.4;

function scanIdleQuadWalls(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  const idle: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= times.length; i++) {
    const quad = i < times.length && rows[i] === 15;
    if (quad && start >= 0 && times[i] - times[i - 1] <= SLOW_QUAD_GAP_MS * rate) continue;
    if (start >= 0 && i - start >= IDLE_WALL_MIN_ROWS) {
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

function scanRepeatedRows(scan: VibroScan): void {
  const { times, rows, rate } = scan;
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

const JUMPTRILL_PRESS_MS = 30;
const JUMPTRILL_GAP_MS = 65;
const JUMPTRILL_MIN_PRESSES = 8;
const JUMPTRILL_FULL_SHARE = 0.75;
const JUMPTRILL_CHART_SHARE = 0.3;

function scanJumptrills(scan: VibroScan): void {
  const { bursts, burstNotes } = findJumptrillBursts(scan.times, scan.rows, scan.rate, [0b0011, 0b1100], -1, JUMPTRILL_GAP_MS);
  if (burstNotes >= scan.prefixNotes.at(-1)! * JUMPTRILL_CHART_SHARE) scan.intervals.push(...bursts);
}

function findJumptrillBursts(
  times: readonly number[],
  rows: readonly number[],
  rate: number,
  handMasks: readonly [number, number],
  middleColumn: number,
  gapMs: number,
): { bursts: VibroSection[]; burstNotes: number } {
  type Press = { start: number; end: number; hand: number; mask: number };
  const presses: Press[] = [];
  const open: (Press | null)[] = [null, null];
  const middleBit = middleColumn >= 0 ? 1 << middleColumn : 0;
  for (let i = 0; i < times.length; i++) {
    const sides = [rows[i] & handMasks[0], rows[i] & handMasks[1]];
    if (rows[i] & middleBit) {
      if (sides[0] && !sides[1]) sides[0] |= middleBit;
      else if (sides[1] && !sides[0]) sides[1] |= middleBit;
      else if (!sides[0] && !sides[1]) {
        const hand = [0, 1].find((h) => open[h] && times[i] - open[h]!.start <= JUMPTRILL_PRESS_MS * rate && !(open[h]!.mask & middleBit));
        if (hand !== undefined) sides[hand] |= middleBit;
      }
    }
    for (let hand = 0; hand < 2; hand++) {
      const bits = sides[hand];
      if (!bits) continue;
      const press = open[hand];
      if (press && times[i] - press.start <= JUMPTRILL_PRESS_MS * rate && !(press.mask & bits)) {
        press.mask |= bits;
        press.end = times[i];
        continue;
      }
      const next = { start: times[i], end: times[i], hand, mask: bits };
      presses.push(next);
      open[hand] = next;
    }
  }
  const bursts: VibroSection[] = [];
  let burstNotes = 0;
  let start = 0;
  const full = (press: Press) => (press.mask & handMasks[press.hand]) === handMasks[press.hand];
  for (let i = 1; i <= presses.length; i++) {
    if (i < presses.length && presses[i].hand !== presses[i - 1].hand
      && presses[i].start - presses[i - 1].start <= gapMs * rate) continue;
    const run = presses.slice(start, i);
    if (run.length >= JUMPTRILL_MIN_PRESSES && run.filter(full).length >= run.length * JUMPTRILL_FULL_SHARE) {
      bursts.push({ startTime: run[0].start, endTime: run.at(-1)!.end, reasons: ["jumptrill"] });
      burstNotes += run.reduce((sum, press) => sum + bitCount(press.mask), 0);
    }
    start = i;
  }
  return { bursts, burstNotes };
}

export function analyzeHoldVibro(map: ManiaBeatmap, rate = 1): VibroAnalysis | null {
  if (map.keyCount !== 4 || !map.notes.length || usesSectionVibro(map) || !Number.isFinite(rate) || rate <= 0) return null;
  const scan = buildVibroScan(map, rate);
  for (const motion of scanMotionVibro(map, rate)) addSection(scan, motion.startTime, motion.endTime, motion.reason);
  if (!scan.intervals.length) return null;
  const activeDurationMs = measureActiveDuration(scan);
  const result: VibroAnalysis = {
    version: VIBRO_SECTION_VERSION, status: "clean", sections: mergeSections(scan.intervals),
    excludedDurationMs: 0, activeDurationMs, timeShare: 0, noteShare: 0, judgementShare: 0,
    remainingNotes: map.notes.length, repeatShare: 0,
    reasonShares: measureReasonShares(scan.intervals, rate, activeDurationMs),
  };
  measureSectionCoverage(result, map, scan);
  return result.status === "excluded" ? result : null;
}

const WIDE_JUMPTRILL_GAP_MS = 75;

export function analyzeWideJumptrill(map: ManiaBeatmap, rate = 1): VibroAnalysis | null {
  if (map.keyCount < 4 || (map.keyCount === 4 && usesSectionVibro(map)) || usesPrism(map.keyCount)
    || !map.notes.length || !Number.isFinite(rate) || rate <= 0) return null;
  const half = Math.floor(map.keyCount / 2);
  const middleColumn = map.keyCount % 2 ? half : -1;
  const handMasks: [number, number] = [0, 0];
  for (let column = 0; column < map.keyCount; column++) {
    if (column !== middleColumn) handMasks[column < half ? 0 : 1] |= 1 << column;
  }
  const scan = buildVibroScan(map, rate);
  const fourKey = map.keyCount === 4;
  const read = fourKey ? buildVibroScan({ ...map, notes: map.notes.filter((note) => !note.isHold) }, rate) : scan;
  const { bursts, burstNotes } = findJumptrillBursts(read.times, read.rows, rate, handMasks, middleColumn,
    fourKey ? JUMPTRILL_GAP_MS : WIDE_JUMPTRILL_GAP_MS);
  if (burstNotes < map.notes.length * JUMPTRILL_CHART_SHARE) return null;
  const activeDurationMs = measureActiveDuration(scan);
  const sections = mergeSections(bursts);
  let excludedDurationMs = 0;
  for (const section of sections) excludedDurationMs += (section.endTime - section.startTime) / rate;
  const timeShare = activeDurationMs > 0 ? Math.min(1, excludedDurationMs / activeDurationMs) : 1;
  const noteShare = burstNotes / map.notes.length;
  return {
    version: VIBRO_SECTION_VERSION, status: "excluded", sections, excludedDurationMs, activeDurationMs,
    timeShare, noteShare, judgementShare: noteShare, remainingNotes: map.notes.length - burstNotes,
    repeatShare: 0, reasonShares: { jumptrill: timeShare },
  };
}

const HAMMER_GAP_MS = 92;
const HAMMER_MIN_REPEATS = 4;
const HAMMER_MIN_ROWS = 24;
const HAMMER_RUN_SHARE = 0.66;

function scanHammeredChords(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  let start = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && bitCount(rows[i]) >= 3 && bitCount(rows[i - 1]) >= 3
      && times[i] - times[i - 1] <= HAMMER_GAP_MS * rate) continue;
    if (i - start >= HAMMER_MIN_ROWS && bitCount(rows[start]) >= 3) {
      let inRuns = 0;
      let runStart = start;
      for (let k = start + 1; k <= i; k++) {
        if (k < i && rows[k] === rows[k - 1]) continue;
        if (k - runStart >= HAMMER_MIN_REPEATS && bitCount(rows[runStart]) === 3) inRuns += k - runStart;
        runStart = k;
      }
      if (inRuns >= (i - start) * HAMMER_RUN_SHARE) addSection(scan, times[start], times[i - 1], "repeated_chord");
    }
    start = i;
  }
}

const ONE_FINGER_GAP_MS = 90;
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

function scanRepeatedJackStreams(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  const burstRows = new Uint8Array(times.length);
  const burstShapes = new Uint8Array(times.length);
  let repeatStart = 0;
  let maxRepeatGap = 0;
  for (let i = 1; i <= times.length; i++) {
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

function scanRepeatedPairs(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  for (const pair of [3, 5, 6, 9, 10, 12]) {
    scanConsecutiveRows(scan, (i) => (rows[i] & pair) === pair && (rows[i - 1] & pair) === pair
      && times[i] - times[i - 1] <= 70 * rate,
    11, "repeated_chord");
  }
}

interface RepetitionBand {
  gapMs: number;
  averageGapMs: number;
  minHits: number;
  minShare: number;
  reason: VibroReason;
}

const SINGLE_FINGER_BANDS: readonly RepetitionBand[] = [
  { gapMs: 30, averageGapMs: 30, minHits: 4, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 85, averageGapMs: 55, minHits: 9, minShare: 0, reason: "rapid_jack_burst" },
];

const PAIR_LOCK_GAP_MS = 85;

const PAIR_BANDS: readonly RepetitionBand[] = [
  { gapMs: 55, averageGapMs: 55, minHits: 4, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 60, averageGapMs: 60, minHits: 6, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 92, averageGapMs: 92, minHits: 12, minShare: 0.7, reason: "repeated_chord" },
];
const QUAD_BANDS: readonly RepetitionBand[] = [
  { gapMs: 92, averageGapMs: 92, minHits: 8, minShare: 0, reason: "repeated_wall" },
];

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

function collectShortRepetitions(scan: VibroScan, indices: number[], fingers: number): void {
  const { times, prefixNotes, rate, repetitionBursts } = scan;
  const minHits = fingers === 1 ? 6 : 4;
  const maxHits = fingers === 1 ? 24 : fingers === 2 ? 11 : 7;
  let start = 0;
  for (let end = 1; end <= indices.length; end++) {
    if (end < indices.length && times[indices[end]] - times[indices[end - 1]] <= 100 * rate) continue;
    const hits = end - start;
    if (hits >= minHits && hits <= maxHits) {
      for (let i = start + minHits - 1; i < end; i++) {
        const first = indices[i - minHits + 1], last = indices[i];
        if (times[last] - times[first] > (minHits - 1) * RECURRING_REPETITION_GAP_MS * rate) continue;
        const share = minHits * fingers / (prefixNotes[last + 1] - prefixNotes[first]);
        if (fingers === 1 ? share <= 0.5 || minHits / (last - first + 1) < 0.9 : fingers === 2 && share < 2 / 3) continue;
        repetitionBursts.push({ startTime: times[first], endTime: times[last],
          reasons: [fingers === 1 ? "isolated_jack" : fingers === 2 ? "repeated_chord" : "repeated_wall"] });
      }
    }
    start = end;
  }
}

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
  if (bursts.length >= 4 && isolatedBurstNotes / prefixNotes.at(-1)! >= 0.2) intervals.push(...bursts);
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

function scanRecurringRepetitions(scan: VibroScan): void {
  collectAlternatingChords(scan);
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

function scanExtremeDensity(scan: VibroScan): void {
  const { times, rate } = scan;
  let windowStart = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[windowStart] > 1000 * rate) windowStart++;
    if (i - windowStart + 1 >= 65) addSection(scan, times[windowStart], times[i], "extreme_density");
  }
}

const SUSTAINED_WINDOW_MS = 10_000;
const SUSTAINED_FINGER_RATE = 12.2;

function scanSustainedDensity(scan: VibroScan): void {
  const { times, prefixNotes, rate } = scan;
  const minNotes = SUSTAINED_FINGER_RATE * 4 * SUSTAINED_WINDOW_MS / 1000;
  let windowStart = 0;
  for (let i = 0; i < times.length; i++) {
    while ((times[i] - times[windowStart]) / rate > SUSTAINED_WINDOW_MS + 1e-6) windowStart++;
    if (prefixNotes[i + 1] - prefixNotes[windowStart] >= minNotes) {
      addSection(scan, times[windowStart], times[i], "sustained_density");
    }
  }
}

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

function measureActiveDuration({ times, rate }: VibroScan): number {
  let duration = 0;
  for (let i = 1; i < times.length; i++) {
    duration += Math.min(times[i] - times[i - 1], 1000 * rate) / rate;
  }
  return duration;
}

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
  const noteCap = result.repeatShare >= REPEAT_BODY_SHARE ? REPEAT_BODY_NOTE_CAP : 0.25;
  const hammered = measureChordRunShare(scan.rate > 1 ? { ...scan, rate: 1 } : scan) >= CHORD_RUN_BODY_SHARE;
  result.status = !result.reasonShares.sustained_density && !hammered
    && result.timeShare <= 0.15 && result.noteShare <= noteCap
    && result.remainingNotes >= 300 && result.activeDurationMs - result.excludedDurationMs >= 20_000
    ? "adjusted" : "excluded";
}

const REPEAT_RUN_GAP_MS = 95;
const REPEAT_RUN_MIN_HITS = 4;
const REPEAT_BODY_SHARE = 0.25;
const REPEAT_BODY_NOTE_CAP = 0.13;

function measureRepeatShare(scan: VibroScan): number {
  const { times, rows, prefixNotes, rate } = scan;
  const total = prefixNotes.at(-1)!;
  if (total === 0) return 0;
  const covered = new Uint8Array(rows.length);
  for (let column = 0; column < 4; column++) {
    const indices = rows.flatMap((mask, index) => mask & (1 << column) ? [index] : []);
    let start = 0;
    for (let i = 1; i <= indices.length; i++) {
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

const CHORD_RUN_GAP_MS = 95;
const CHORD_RUN_MIN_REPEATS = 4;
const CHORD_RUN_BODY_SHARE = 0.3;

function measureChordRunShare(scan: VibroScan): number {
  const { times, rows, prefixNotes, rate } = scan;
  const total = prefixNotes.at(-1)!;
  if (total === 0) return 0;
  let notes = 0;
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i] === rows[i - 1] && bitCount(rows[i]) >= 2
      && times[i] - times[i - 1] <= CHORD_RUN_GAP_MS * rate) continue;
    if (i - start >= CHORD_RUN_MIN_REPEATS && bitCount(rows[start]) >= 2) notes += prefixNotes[i] - prefixNotes[start];
    start = i;
  }
  return notes / total;
}

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

export function removeVibroSections(osuText: string, sections: VibroSection[]): string {
  let hitObjects = false;
  return osuText.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) hitObjects = trimmed === "[HitObjects]";
    if (!hitObjects || !trimmed.includes(",")) return true;
    const parts = trimmed.split(",");
    const start = Number(parts[2]);
    const end = Number(parts[3]) & 128 ? Number(parts[5]?.split(":")[0]) : start;
    return !overlapsVibro(start, end, sections);
  }).join("\n");
}

export function prepareVibroChart(osuText: string, rate = 1, map = parseManiaBeatmap(osuText)) {
  const analysis = analyzeVibroSections(map, rate);
  return {
    analysis,
    osuText: analysis.status === "adjusted" ? removeVibroSections(osuText, analysis.sections) : osuText,
  };
}

export function conservativeVibroAccuracy(accuracy: number, removedShare: number): number {
  if (!Number.isFinite(accuracy) || !Number.isFinite(removedShare) || removedShare >= 1) return 0;
  return Math.max(0, Math.min(1, 1 - (1 - accuracy) / (1 - Math.max(0, removedShare))));
}
