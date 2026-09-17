import type { ManiaBeatmap } from "./beatmap-parser.js";
import type { VibroReason } from "./vibro-sections.js";

/** A passage the motion arms object to, in original chart timestamps. */
export interface MotionInterval {
  startTime: number;
  endTime: number;
  reason: VibroReason;
}

// Two hits by one hand separated by more than 0ms and at most this far apart are
// one motion, not two actions: too late to be a chord, too early to be a second
// hit. The pathology is the small nonzero gap, so exact chords are excluded.
const SPLIT_WINDOW_MS = 30;
// Gap allowed between consecutive split actions before the run is considered over.
const SPLIT_RUN_GAP_MS = 250;
// A run has to be long enough and fast enough to be a sustained demand rather
// than one dense bar. Measured over the local snapshot: 0 of 6,175 ranked 4K
// rice charts and 0 of 1,939 loved ones reach both, against 7.9% of 687 charts
// from vibro-titled packs; 4 of 26,212 accepted chart+rate pairs do.
const SPLIT_RUN_MIN_ACTIONS = 16;
const SPLIT_RUN_MIN_CYCLE_RATE = 12;

// Peak sustained per-finger rate over a one-second window, counted as the
// intervals a run covers rather than its hits, so a uniform run is not
// overstated by count/(count-1). Measured over the local snapshot: 6,175 ranked
// 4K rice charts top out at 12.81 hits/s and 1,939 loved ones at 13.33, and of
// 26,212 accepted chart+rate pairs only 12 reach 13.5 - several of which name
// themselves vibro in their own difficulty. This sits above every ranked chart
// with room to spare and below the loved tail's maximum.
const FINGER_CEILING_RATE = 13.5;
const FINGER_CEILING_WINDOW_MS = 1000;

function decompose(map: ManiaBeatmap): { times: number[]; rows: number[] } {
  const masks = new Map<number, number>();
  for (const note of map.notes) masks.set(note.time, (masks.get(note.time) ?? 0) | (1 << note.column));
  const times = [...masks.keys()].sort((a, b) => a - b);
  return { times, rows: times.map((time) => masks.get(time)!) };
}

/** Arm A. One hand splitting a single motion into two hits, over and over. */
export function scanSplitHandDoubles(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const out: MotionInterval[] = [];
  const { times, rows } = decompose(map);
  for (const hand of [0, 1]) {
    const mask = hand === 0 ? 0b0011 : 0b1100;
    // Distinct instants at which this hand has to do something.
    const instants: number[] = [];
    for (let i = 0; i < rows.length; i++) if (rows[i] & mask) instants.push(times[i]);
    // Collapse into actions. An action carrying 2+ distinct instants is a split.
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

/** Arm C. Past what any ranked chart asks of one finger.
 * The section is the union of the one-second windows that breach, so it covers
 * the whole of a long breaching run without ever growing past it into the
 * ordinary material either side. */
export function scanFingerRateCeiling(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const out: MotionInterval[] = [];
  const columns: number[][] = [[], [], [], []];
  for (const note of map.notes) columns[note.column]?.push(note.time);
  for (const column of columns) {
    column.sort((a, b) => a - b);
    let start = 0;
    let openFrom = -1;
    let openTo = -1;
    for (let i = 0; i < column.length; i++) {
      while ((column[i] - column[start]) / rate > FINGER_CEILING_WINDOW_MS) start++;
      const span = (column[i] - column[start]) / rate;
      if (span < FINGER_CEILING_WINDOW_MS * 0.9) continue;
      if ((i - start) / (span / 1000) < FINGER_CEILING_RATE) continue;
      if (openFrom >= 0 && column[start] <= openTo) { openTo = column[i]; continue; }
      if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason: "finger_rate_ceiling" });
      openFrom = column[start];
      openTo = column[i];
    }
    if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason: "finger_rate_ceiling" });
  }
  return out;
}

/** Arm D. Past what any ranked chart asks of one hand.
 * Two notes at the same instant are one action: the hand moves once, whatever
 * it is holding. Two notes 40ms apart are two motions. Counting actions rather
 * than notes is what separates a chordjack, where the hand strikes a chord and
 * moves on, from a hand that has to alternate its fingers - the second costs
 * twice the motion for the same note count, and it is what a player is doing
 * when they shake. Measured over the local snapshot: 6,175 ranked 4K rice
 * charts peak at 22.65 actions/s and 1,939 loved ones put 4 charts above this
 * line, against 17.5% of 640 charts from vibro-titled packs. Sections are the
 * union of the breaching one-second windows, so a chart is only rated on the
 * seconds that breach. */
const HAND_CEILING_RATE = 23;
const HAND_CEILING_WINDOW_MS = 1000;

export function scanHandActionCeiling(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const out: MotionInterval[] = [];
  for (const hand of [0b0011, 0b1100]) {
    const instants = new Set<number>();
    for (const note of map.notes) if (hand & (1 << note.column)) instants.add(note.time);
    const times = [...instants].sort((a, b) => a - b);
    let start = 0;
    let openFrom = -1;
    let openTo = -1;
    for (let i = 0; i < times.length; i++) {
      while ((times[i] - times[start]) / rate > HAND_CEILING_WINDOW_MS) start++;
      const span = (times[i] - times[start]) / rate;
      if (span < HAND_CEILING_WINDOW_MS * 0.9) continue;
      if ((i - start) / (span / 1000) < HAND_CEILING_RATE) continue;
      if (openFrom >= 0 && times[start] <= openTo) { openTo = times[i]; continue; }
      if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason: "hand_action_ceiling" });
      openFrom = times[start];
      openTo = times[i];
    }
    if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason: "hand_action_ceiling" });
  }
  return out;
}

// Arm B constants. A four-key cycle is a run of evenly spaced instants at which
// every column has a note to give, so one repeated four-finger motion covers the
// whole passage whatever the notation says. The pathology is not the tapping
// rate, which sits under arms C and D by construction; it is that four fingers
// share one clock.
//
// How far a note may sit from its pulse and still ride it. Half of the 85ms at
// which a decorated pair already reads as one locked motion in vibro-sections,
// so the two rules agree about when separate notes stop being separate.
const CYCLE_TOLERANCE_MS = 43;
// The pulses must account for this share of every note inside their own span.
// Without it the search is free to thread a cycle through a busy passage and
// ignore the material it did not cover, which no player may do. Measured over
// the local snapshot at 31,217 played 4K chart+rate pairs: at 0.92 an official
// dan course stage reaches 0.205 at 1.2x, at 0.98 it reaches 0.111 while the
// reported chart holds 0.532, so this is what separates the two populations.
const CYCLE_PURITY = 0.98;
// Cycle period bounds. 105ms is the reload the repeated-wall rule already treats
// as a wall; below 55ms one finger would breach arm C on its own.
const CYCLE_MIN_PERIOD_MS = 55;
const CYCLE_MAX_PERIOD_MS = 105;
// Same length bar as a literal repeated wall: 12 rows of it.
const CYCLE_MIN_PULSES = 12;
const CYCLE_PERIOD_STEP_MS = 2;
const CYCLE_PHASE_DIVISOR = 8;
// A cycle counts when the chart is built from one, not when a bar of ordinary
// dense material happens to admit one. Measured over the local snapshot at
// 31,217 played 4K chart+rate pairs: 506 carry some cycle at all, and the share
// they carry sorts the two populations cleanly. Everything from 0.12 up is a
// vibro, jumptrill or rate-spam pack naming itself as one in its own metadata,
// topping out at 4 plays; below it sit ranked charts with one incidental dense
// second, including a 760-play ranked chart at 1.0x. The reported chart holds
// 0.25 at 1.1x and 0.36 at 1.2x, twice the bar and rising with the rate.
const CYCLE_BODY_SHARE = 0.12;

/** Cheap necessary condition, so the phase search only ever sees candidates:
 * a chain of 12 pulses needs some window of 12 * CYCLE_MAX_PERIOD_MS in which
 * every column has at least 11 notes to give. Skips 91% of the played corpus. */
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

function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Arm B. Four fingers on one clock.
 * Walks a fixed period and phase across the chart, consuming one note per column
 * per pulse. A run of pulses that every column can feed, and that leaves almost
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
      // Bounds are the notes the pulses actually consumed, not the pulse times:
      // a chain must claim the material it covers and nothing either side of it.
      let from = Infinity;
      let to = -Infinity;
      let pulses = 0;
      const close = () => {
        if (pulses >= CYCLE_MIN_PULSES && pulses * 4 >= notesInside(from, to) * CYCLE_PURITY) {
          found.push({ startTime: from, endTime: to, reason: "four_key_cycle" });
        }
        from = Infinity;
        to = -Infinity;
        pulses = 0;
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
        if (!complete) { close(); for (let c = 0; c < 4; c++) cursor[c] = take[c]; continue; }
        for (let c = 0; c < 4; c++) {
          from = Math.min(from, columns[c][take[c] - 1]);
          to = Math.max(to, columns[c][take[c] - 1]);
          cursor[c] = take[c];
        }
        pulses++;
      }
      close();
    }
  }
  return coversEnough(found, all) ? found : [];
}

/** Share of the chart's notes the cycles cover once their spans are merged. */
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

export function scanMotionVibro(map: ManiaBeatmap, rate: number): MotionInterval[] {
  return [
    ...scanSplitHandDoubles(map, rate),
    ...scanFourKeyCycles(map, rate),
    ...scanFingerRateCeiling(map, rate),
    ...scanHandActionCeiling(map, rate),
  ];
}
