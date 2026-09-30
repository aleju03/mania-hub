// Motion arms for 4K rice vibro: passages judged by what the hands have to do
// rather than by how the notes are written. Each arm returns the intervals it
// objects to, in chart time; ./sections merges them with the pattern scanners.
// All timing limits are real time, so chart gaps are divided by the rate.

import type { ManiaBeatmap } from "../chart/beatmap";
import type { VibroReason } from "./sections";

// Quad reload (ms) past which a short quad wall is quadjack rather than
// shaking. Shared by the repeated-wall rule and the four-key cycle.
export const REPEATED_QUAD_GAP_MS = 95;
// How many consecutive quads past that reload a wall needs to count anyway.
// Counting quads whose reload sits between 92 and 105ms at 1.0x, no ranked or
// loved 4K chart reaches 24 (a short-wall quadjack chart tops out at 21), while
// 21 charts from vibro-titled packs run 32 or more (up to 385).
export const SLOW_QUAD_MIN_ROWS = 24;

/** A passage the motion arms object to, in original chart timestamps. */
export interface MotionInterval {
  startTime: number;
  endTime: number;
  reason: VibroReason;
}

// Arm A. Two hits by one hand more than 0ms and at most 30ms apart are one
// motion, not two actions: too late to be a chord, too early to be a second
// hit. Exact chords (0ms) are not splits.
const SPLIT_WINDOW_MS = 30;
// Gap between consecutive split actions after which the run is over.
const SPLIT_RUN_GAP_MS = 250;
// A run has to be long and fast enough to be a sustained demand rather than one
// dense bar. 0 of 6,175 ranked and 0 of 1,939 loved 4K rice charts reach both,
// against 7.9% of 687 charts from vibro-titled packs; 4 of 26,212 accepted
// chart+rate pairs do.
const SPLIT_RUN_MIN_ACTIONS = 16;
const SPLIT_RUN_MIN_CYCLE_RATE = 12;

// Arm C. Peak sustained per-finger rate over a one-second window, counted as
// the intervals a run covers rather than its hits, so a uniform run is not
// overstated by count/(count-1). 6,175 ranked 4K rice charts top out at 12.81
// hits/s and 1,939 loved ones at 13.33; of 26,212 accepted chart+rate pairs
// only 12 reach 13.5, several of them labelled vibro in their own difficulty
// name. The line sits above every ranked chart and below the loved maximum.
const FINGER_CEILING_RATE = 13.5;
const FINGER_CEILING_WINDOW_MS = 1000;
// A finger on every row of its window is the anchor of a chordjack struck on
// the chart's own pulse: the hand plays each chord and moves on, with nothing
// to do between hits. It gets slightly more room than a finger whose hand also
// plays faster rows around it, enough for 1/4 chordjack at 211 BPM (71ms rows),
// and only in a chart whose fast rows are chordjack: at least a fifth of the
// rows within the quadjack reload of the last one are quads. Charts ruled vibro
// at this speed sit at 1-13% (jump walls, hands trading fingers), the dense
// chordjack ruled legit at 25-54%.
const ANCHOR_CEILING_RATE = 14.1;
const ANCHOR_MIN_QUAD_SHARE = 0.2;

// Arm D. Peak actions per second for one hand. Notes at the same instant are
// one action (the hand moves once); notes 40ms apart are two. Counting actions
// separates a chordjack, where the hand strikes a chord and moves on, from a
// hand alternating its fingers, which costs twice the motion for the same note
// count and is what shaking is. 6,175 ranked 4K rice charts peak at 22.65
// actions/s and 1,939 loved ones put 4 charts above 23, against 17.5% of 640
// charts from vibro-titled packs.
const HAND_CEILING_RATE = 23;
const HAND_CEILING_WINDOW_MS = 1000;

// Arm B. A four-key cycle is a run of evenly spaced instants at which every
// column has a note to give, so one repeated four-finger motion covers the
// passage whatever the notation says. The tapping rate sits under arms C and D
// by construction; what this catches is four fingers sharing one clock.
//
// How far (ms) a note may sit from its pulse and still ride it: half of the
// 85ms at which ./sections already reads a decorated pair as one locked motion.
const CYCLE_TOLERANCE_MS = 43;
// The pulses must account for this share of every note inside their own span,
// so a cycle cannot be threaded through a busy passage while ignoring the notes
// it skips. Over 31,217 played 4K chart+rate pairs, at 0.92 an official dan
// course stage reaches a 0.205 body share at 1.2x; at 0.98 it reaches 0.111
// while a vibro chart holds 0.532.
const CYCLE_PURITY = 0.98;
// Period bounds (ms). 105 is the reload the repeated-wall rule treats as a
// wall; below 55 one finger would breach arm C on its own.
const CYCLE_MIN_PERIOD_MS = 55;
const CYCLE_MAX_PERIOD_MS = 105;
// Same length bar as a literal repeated wall: 12 rows.
const CYCLE_MIN_PULSES = 12;
// A chain whose every pulse is a struck quad (spread <= 10ms) is a literal quad
// wall, and one slower than REPEATED_QUAD_GAP_MS is quadjack unless it runs as
// long as SLOW_QUAD_MIN_ROWS. Rolled or rotating pulses keep the 12-pulse bar
// at any period, since a roll has no chord to jack.
const CYCLE_QUAD_SPREAD_MS = 10;
const CYCLE_PERIOD_STEP_MS = 2;
const CYCLE_PHASE_DIVISOR = 8;
// Cycles count only when the chart is built from them, not when a bar of dense
// material happens to admit one. Of 31,217 played 4K chart+rate pairs, 506
// carry some cycle, and the note share they cover sorts the two populations:
// everything from 0.12 up is a vibro, jumptrill or rate-spam pack labelled as
// such in its own metadata (at most 4 plays each); below it sit ranked charts
// with one incidental dense second, including a 760-play ranked chart at 1.0x.
// A vibro chart of this kind holds 0.25 at 1.1x and 0.36 at 1.2x.
const CYCLE_BODY_SHARE = 0.12;

/** All four motion arms at the played rate. */
export function scanMotionVibro(map: ManiaBeatmap, rate: number): MotionInterval[] {
  return [
    ...scanSplitHandDoubles(map, rate),
    ...scanFourKeyCycles(map, rate),
    ...scanFingerRateCeiling(map, rate),
    ...scanHandActionCeiling(map, rate),
  ];
}

/** Arm A. One hand splitting a single motion into two hits, over and over:
 * runs of 16+ split actions cycling at 12+ actions/s. */
export function scanSplitHandDoubles(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const out: MotionInterval[] = [];
  const { times, rows } = decompose(map);
  for (const hand of [0, 1]) {
    const mask = hand === 0 ? 0b0011 : 0b1100;
    // Distinct instants at which this hand has to do something.
    const instants: number[] = [];
    for (let i = 0; i < rows.length; i++) if (rows[i] & mask) instants.push(times[i]);
    // Collapse into actions; an action carrying 2+ distinct instants is a split.
    const actions: Array<{ time: number; split: boolean }> = [];
    for (const time of instants) {
      const last = actions.at(-1);
      if (last && (time - last.time) / rate <= SPLIT_WINDOW_MS) last.split = true;
      else actions.push({ time, split: false });
    }
    let start = -1;
    const close = (endIndex: number) => {
      if (start < 0) return;
      const count = endIndex - start + 1;
      const span = (actions[endIndex].time - actions[start].time) / rate / 1000;
      const cycleRate = span > 0 ? (count - 1) / span : 0;
      if (count >= SPLIT_RUN_MIN_ACTIONS && cycleRate >= SPLIT_RUN_MIN_CYCLE_RATE) {
        out.push({ startTime: actions[start].time, endTime: actions[endIndex].time, reason: "split_hand_double" });
      }
      start = -1;
    };
    for (let i = 0; i < actions.length; i++) {
      if (!actions[i].split) { close(i - 1); continue; }
      if (start >= 0 && (actions[i].time - actions[i - 1].time) / rate > SPLIT_RUN_GAP_MS) close(i - 1);
      if (start < 0) start = i;
    }
    close(actions.length - 1);
  }
  return out;
}

/** Arm C. Past what any ranked chart asks of one finger. The interval is the
 * union of the one-second windows that breach, so it covers a long breaching
 * run without growing into the ordinary material either side. */
export function scanFingerRateCeiling(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const out: MotionInterval[] = [];
  const columns: number[][] = [[], [], [], []];
  for (const note of map.notes) columns[note.column]?.push(note.time);
  const { times, rows } = decompose(map);
  let fastRows = 0;
  let fastQuads = 0;
  for (let k = 1; k < times.length; k++) {
    if ((times[k] - times[k - 1]) / rate > REPEATED_QUAD_GAP_MS) continue;
    fastRows++;
    if (rows[k] === 0b1111) fastQuads++;
  }
  const anchorsAllowed = fastRows > 0 && fastQuads / fastRows >= ANCHOR_MIN_QUAD_SHARE;
  for (const column of columns) {
    column.sort((a, b) => a - b);
    const ceiling = (first: number, last: number) => anchorsAllowed
      && lowerBound(times, column[last]) - lowerBound(times, column[first]) === last - first
      ? ANCHOR_CEILING_RATE : FINGER_CEILING_RATE;
    out.push(...breachingWindows(column, rate, FINGER_CEILING_WINDOW_MS, ceiling, "finger_rate_ceiling"));
  }
  return out;
}

/** Arm D. Past what any ranked chart asks of one hand, counted in actions
 * (distinct instants) per second. Intervals are the union of the breaching
 * one-second windows, so a chart is only rated on the seconds that breach. */
export function scanHandActionCeiling(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const out: MotionInterval[] = [];
  for (const hand of [0b0011, 0b1100]) {
    const instants = new Set<number>();
    for (const note of map.notes) if (hand & (1 << note.column)) instants.add(note.time);
    const times = [...instants].sort((a, b) => a - b);
    out.push(...breachingWindows(times, rate, HAND_CEILING_WINDOW_MS, HAND_CEILING_RATE, "hand_action_ceiling"));
  }
  return out;
}

/** Arm B. Four fingers on one clock.
 * Walks a fixed period and phase across the chart, consuming one note per
 * column per pulse. A run of pulses every column can feed, which leaves almost
 * nothing else inside its own span, is a four-key wall however it is written:
 * rotating chords, rolls and jumptrills all collapse onto the same motion. */
export function scanFourKeyCycles(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const columns: number[][] = [[], [], [], []];
  const all: number[] = [];
  for (const note of map.notes) {
    if (note.column >= 4) continue;
    columns[note.column].push(note.time);
    all.push(note.time);
  }
  for (const column of columns) column.sort((a, b) => a - b);
  all.sort((a, b) => a - b);
  if (!couldCarryCycle(columns, rate)) return [];

  const tolerance = CYCLE_TOLERANCE_MS * rate;
  const firstNote = all[0];
  const lastNote = all.at(-1)!;
  const notesInside = (from: number, to: number) =>
    lowerBound(all, to + 1e-6) - lowerBound(all, from);

  const found: MotionInterval[] = [];
  for (let step = CYCLE_MIN_PERIOD_MS; step <= CYCLE_MAX_PERIOD_MS; step += CYCLE_PERIOD_STEP_MS) {
    const period = step * rate;
    for (let phase = 0; phase < period; phase += period / CYCLE_PHASE_DIVISOR) {
      const cursor = [0, 0, 0, 0];
      // Bounds are the notes the pulses consumed, not the pulse times: a chain
      // claims the material it covers and nothing either side of it.
      let from = Infinity;
      let to = -Infinity;
      let pulses = 0;
      let spread = 0;
      const close = () => {
        const slowQuads = spread <= CYCLE_QUAD_SPREAD_MS * rate
          && (to - from) / Math.max(1, pulses - 1) > REPEATED_QUAD_GAP_MS * rate;
        const minPulses = slowQuads ? SLOW_QUAD_MIN_ROWS : CYCLE_MIN_PULSES;
        if (pulses >= minPulses && pulses * 4 >= notesInside(from, to) * CYCLE_PURITY) {
          found.push({ startTime: from, endTime: to, reason: "four_key_cycle" });
        }
        from = Infinity;
        to = -Infinity;
        pulses = 0;
        spread = 0;
      };
      for (let time = firstNote - tolerance + phase; time <= lastNote + tolerance; time += period) {
        const take = [0, 0, 0, 0];
        let complete = true;
        for (let column = 0; column < 4; column++) {
          const notes = columns[column];
          let i = cursor[column];
          while (i < notes.length && notes[i] < time - tolerance) i++;
          if (i < notes.length && notes[i] <= time + tolerance) take[column] = i + 1;
          else { take[column] = i; complete = false; }
        }
        // An incomplete pulse ends the chain; columns that did have a note
        // still consume it.
        if (!complete) { close(); for (let c = 0; c < 4; c++) cursor[c] = take[c]; continue; }
        let first = Infinity;
        let last = -Infinity;
        for (let c = 0; c < 4; c++) {
          first = Math.min(first, columns[c][take[c] - 1]);
          last = Math.max(last, columns[c][take[c] - 1]);
          cursor[c] = take[c];
        }
        from = Math.min(from, first);
        to = Math.max(to, last);
        spread = Math.max(spread, last - first);
        pulses++;
      }
      close();
    }
  }
  return coversEnough(found, all) ? found : [];
}

/** Distinct hit times and the column mask of each row. */
function decompose(map: ManiaBeatmap): { times: number[]; rows: number[] } {
  const masks = new Map<number, number>();
  for (const note of map.notes) masks.set(note.time, (masks.get(note.time) ?? 0) | (1 << note.column));
  const times = [...masks.keys()].sort((a, b) => a - b);
  return { times, rows: times.map((time) => masks.get(time)!) };
}

/** Sliding real-time window over sorted hit times. A window counts once it
 * spans at least 90% of windowMs and its interval rate reaches ceilingRate;
 * overlapping breaching windows are unioned into one interval. */
function breachingWindows(
  times: readonly number[],
  rate: number,
  windowMs: number,
  ceilingRate: number | ((first: number, last: number) => number),
  reason: VibroReason,
): MotionInterval[] {
  const out: MotionInterval[] = [];
  let start = 0;
  let openFrom = -1;
  let openTo = -1;
  for (let i = 0; i < times.length; i++) {
    while ((times[i] - times[start]) / rate > windowMs) start++;
    const span = (times[i] - times[start]) / rate;
    if (span < windowMs * 0.9) continue;
    if ((i - start) / (span / 1000) < (typeof ceilingRate === "number" ? ceilingRate : ceilingRate(start, i))) continue;
    if (openFrom >= 0 && times[start] <= openTo) { openTo = times[i]; continue; }
    if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason });
    openFrom = times[start];
    openTo = times[i];
  }
  if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason });
  return out;
}

/** Cheap necessary condition, so the phase search only sees candidates: a
 * chain of 12 pulses needs some window of 12 * CYCLE_MAX_PERIOD_MS in which
 * every column has at least 11 notes. Skips 91% of the played corpus. */
function couldCarryCycle(columns: readonly number[][], rate: number): boolean {
  const window = CYCLE_MIN_PULSES * CYCLE_MAX_PERIOD_MS * rate;
  for (const column of columns) if (column.length < CYCLE_MIN_PULSES - 1) return false;
  for (const anchor of columns[0]) {
    let ok = true;
    for (const column of columns) {
      let count = 0;
      for (let i = lowerBound(column, anchor); i < column.length && column[i] <= anchor + window; i++) count++;
      if (count < CYCLE_MIN_PULSES - 1) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Whether the merged cycle spans cover at least CYCLE_BODY_SHARE of the notes. */
function coversEnough(found: readonly MotionInterval[], all: readonly number[]): boolean {
  if (found.length === 0 || all.length === 0) return false;
  const spans = found.map((interval) => [interval.startTime, interval.endTime] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let covered = 0;
  for (const [start, end] of merged) covered += lowerBound(all, end + 1e-6) - lowerBound(all, start);
  return covered >= all.length * CYCLE_BODY_SHARE;
}

/** First index whose value is >= target in a sorted array. */
function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
