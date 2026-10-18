import type { ManiaBeatmap } from "../chart/beatmap";
import type { VibroReason } from "./sections";

export const REPEATED_QUAD_GAP_MS = 95;

export const SLOW_QUAD_MIN_ROWS = 24;

export interface MotionInterval {
  startTime: number;
  endTime: number;
  reason: VibroReason;
}

const SPLIT_WINDOW_MS = 30;

const SPLIT_RUN_GAP_MS = 250;

const SPLIT_RUN_MIN_ACTIONS = 16;
const SPLIT_RUN_MIN_CYCLE_RATE = 12;

const FINGER_CEILING_RATE = 13.5;
const FINGER_CEILING_WINDOW_MS = 1000;

const ANCHOR_CEILING_RATE = 14.1;

const ANCHOR_MIN_QUAD_SHARE = 0.2;

function decompose(map: ManiaBeatmap): { times: number[]; rows: number[] } {
  const masks = new Map<number, number>();
  for (const note of map.notes) masks.set(note.time, (masks.get(note.time) ?? 0) | (1 << note.column));
  const times = [...masks.keys()].sort((a, b) => a - b);
  return { times, rows: times.map((time) => masks.get(time)!) };
}

export function scanSplitHandDoubles(map: ManiaBeatmap, rate: number): MotionInterval[] {
  const out: MotionInterval[] = [];
  const { times, rows } = decompose(map);
  for (const hand of [0, 1]) {
    const mask = hand === 0 ? 0b0011 : 0b1100;
    const instants: number[] = [];
    for (let i = 0; i < rows.length; i++) if (rows[i] & mask) instants.push(times[i]);
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
    let start = 0;
    let openFrom = -1;
    let openTo = -1;
    for (let i = 0; i < column.length; i++) {
      while ((column[i] - column[start]) / rate > FINGER_CEILING_WINDOW_MS) start++;
      const span = (column[i] - column[start]) / rate;
      if (span < FINGER_CEILING_WINDOW_MS * 0.9) continue;
      const anchored = anchorsAllowed && lowerBound(times, column[i]) - lowerBound(times, column[start]) === i - start;
      if ((i - start) / (span / 1000) < (anchored ? ANCHOR_CEILING_RATE : FINGER_CEILING_RATE)) continue;
      if (openFrom >= 0 && column[start] <= openTo) { openTo = column[i]; continue; }
      if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason: "finger_rate_ceiling" });
      openFrom = column[start];
      openTo = column[i];
    }
    if (openFrom >= 0) out.push({ startTime: openFrom, endTime: openTo, reason: "finger_rate_ceiling" });
  }
  return out;
}

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

const CYCLE_TOLERANCE_MS = 43;

const CYCLE_PURITY = 0.98;

const CYCLE_MIN_PERIOD_MS = 55;
const CYCLE_MAX_PERIOD_MS = 105;

const CYCLE_MIN_PULSES = 12;

const CYCLE_QUAD_SPREAD_MS = 10;
const CYCLE_PERIOD_STEP_MS = 2;
const CYCLE_PHASE_DIVISOR = 8;

const CYCLE_BODY_SHARE = 0.12;

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
