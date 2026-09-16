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

export function scanMotionVibro(map: ManiaBeatmap, rate: number): MotionInterval[] {
  return [
    ...scanSplitHandDoubles(map, rate),
    ...scanFingerRateCeiling(map, rate),
    ...scanHandActionCeiling(map, rate),
  ];
}
