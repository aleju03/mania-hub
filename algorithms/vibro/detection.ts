import type { ManiaBeatmap } from "../chart/beatmap";
import { analyzeCollapsedNotes, analyzeHoldVibro, analyzeStackedHeads, analyzeVibroSections, analyzeWideJumptrill, usesSectionVibro } from "./sections";

const LN_VIBRO_MIN_ROWS = 150;
const LN_VIBRO_MIN_HOLD_RATIO = 0.5;
const LN_VIBRO_MAX_P75_ROW_GAP_MS = 40;

const RICE_VIBRO_MIN_NOTES = 300;
const RICE_VIBRO_COLUMN_GAP_MS = 92;
const RICE_VIBRO_COLUMN_MIN_RUN = 24;
const RICE_VIBRO_COLUMN_MIN_RATIO = 0.25;

const RICE_VIBRO_WALL_GAP_MS = 105;
const RICE_VIBRO_WALL_MIN_ROWS = 12;
const RICE_VIBRO_WALL_MIN_ROW_RATIO = 0.035;
const RICE_VIBRO_WALL_COLUMN_GAP_MS = 98;
const RICE_VIBRO_WALL_COLUMN_MIN_RATIO = 0.32;

const RICE_VIBRO_BURST_MIN_NOTES = 200;
const RICE_VIBRO_BURST_GAP_MS = 100;
const RICE_VIBRO_BURST_MIN_RUN = 8;
const RICE_VIBRO_BURST_MIN_RUNS = 4;
const RICE_VIBRO_BURST_MIN_FRACTION = 0.2;

const RICE_VIBRO_ROW_RATE_WINDOW_MS = 1000;
const RICE_VIBRO_MAX_ROWS_PER_SECOND = 65;

const RICE_VIBRO_CHORD_WALL_GAP_MS = 70;
const RICE_VIBRO_CHORD_WALL_MIN_RATIO = 0.02;

const RICE_VIBRO_ROLL_GAP_MS = 70;
const RICE_VIBRO_ROLL_MIN_RATIO = 0.25;
const RICE_VIBRO_ROLL_ROW_GAP_MS = 25;
const RICE_VIBRO_ROLL_MIN_ROW_RATIO = 0.3;

function columnFastGaps(map: ManiaBeatmap, cutoffMs: number): { maxRun: number; ratio: number } {
  const byColumn = new Map<number, number[]>();
  for (const note of map.notes) {
    const list = byColumn.get(note.column) ?? [];
    list.push(note.time);
    byColumn.set(note.column, list);
  }
  let maxRun = 0;
  let fast = 0;
  let total = 0;
  for (const times of byColumn.values()) {
    times.sort((a, b) => a - b);
    let run = 0;
    for (let index = 1; index < times.length; index++) {
      const gap = times[index] - times[index - 1];
      if (gap <= 0) continue;
      total++;
      if (gap <= cutoffMs) {
        fast++;
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
  }
  return { maxRun, ratio: total > 0 ? fast / total : 0 };
}

function fastRollRowShare(map: ManiaBeatmap, cutoffMs: number): number {
  const rows = new Map<number, Set<number>>();
  for (const note of map.notes) {
    const columns = rows.get(note.time) ?? new Set<number>();
    columns.add(note.column);
    rows.set(note.time, columns);
  }
  const times = [...rows.keys()].sort((a, b) => a - b);
  if (times.length < 2) return 0;
  let fast = 0;
  for (let index = 1; index < times.length; index++) {
    if (times[index] - times[index - 1] > cutoffMs) continue;
    const previous = rows.get(times[index - 1])!;
    let shared = false;
    for (const column of rows.get(times[index])!) if (previous.has(column)) { shared = true; break; }
    if (!shared) fast++;
  }
  return fast / (times.length - 1);
}

function columnBurstRuns(map: ManiaBeatmap, cutoffMs: number, minRun: number): { runs: number; fraction: number } {
  const byColumn = new Map<number, number[]>();
  for (const note of map.notes) {
    const list = byColumn.get(note.column) ?? [];
    list.push(note.time);
    byColumn.set(note.column, list);
  }
  let runs = 0;
  let inRuns = 0;
  let total = 0;
  for (const times of byColumn.values()) {
    times.sort((a, b) => a - b);
    let run = 0;
    const flush = () => {
      if (run >= minRun) {
        runs++;
        inRuns += run;
      }
      run = 0;
    };
    for (let index = 1; index < times.length; index++) {
      const gap = times[index] - times[index - 1];
      if (gap <= 0) continue;
      total++;
      if (gap <= cutoffMs) run++;
      else flush();
    }
    flush();
  }
  return { runs, fraction: total > 0 ? inRuns / total : 0 };
}

function quadWallRows(map: ManiaBeatmap, cutoffMs: number): { rows: number; ratio: number } {
  const rowSizes = new Map<number, number>();
  for (const note of map.notes) rowSizes.set(note.time, (rowSizes.get(note.time) ?? 0) + 1);
  const times = [...rowSizes.keys()].sort((a, b) => a - b);
  let rows = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap <= 0 || gap > cutoffMs) continue;
    if ((rowSizes.get(times[index]) ?? 0) >= 4 && (rowSizes.get(times[index - 1]) ?? 0) >= 4) rows++;
  }
  return { rows, ratio: times.length > 1 ? rows / (times.length - 1) : 0 };
}

function chordWallRatio(map: ManiaBeatmap, cutoffMs: number): number {
  const rowSizes = new Map<number, number>();
  for (const note of map.notes) rowSizes.set(note.time, (rowSizes.get(note.time) ?? 0) + 1);
  const times = [...rowSizes.keys()].sort((a, b) => a - b);
  if (times.length < 2) return 0;
  const minChord = Math.max(2, map.keyCount - 1);
  let walls = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap <= 0 || gap > cutoffMs) continue;
    if ((rowSizes.get(times[index]) ?? 0) >= minChord && (rowSizes.get(times[index - 1]) ?? 0) >= minChord) walls++;
  }
  return walls / (times.length - 1);
}

function peakRowsPerSecond(map: ManiaBeatmap, windowMs: number): number {
  const times = [...new Set(map.notes.map((note) => note.time))].sort((a, b) => a - b);
  let peak = 0;
  let start = 0;
  for (let index = 0; index < times.length; index++) {
    while (times[index] - times[start] > windowMs) start++;
    const rows = index - start + 1;
    if (rows > peak) peak = rows;
  }
  return peak;
}

export function detectRollVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (map.keyCount !== 4 || map.notes.length < RICE_VIBRO_MIN_NOTES) return false;
  return columnFastGaps(map, RICE_VIBRO_ROLL_GAP_MS * rate).ratio >= RICE_VIBRO_ROLL_MIN_RATIO
    && fastRollRowShare(map, RICE_VIBRO_ROLL_ROW_GAP_MS * rate) >= RICE_VIBRO_ROLL_MIN_ROW_RATIO;
}

const RATE_VIBRO_CHORD_WALL_MIN_RATIO = 0.5;

const SUSTAINED_CHORD_VIBRO_BANDS = [
  { gapMs: 70, columnShare: 0.4 },
  { gapMs: 60, columnShare: 0.35 },
] as const;
const SUSTAINED_CHORD_VIBRO_MIN_ROW_SHARE = 0.2;

const SUSTAINED_CHORD_VIBRO_MIN_ROWS = 32;
const SUSTAINED_CHORD_VIBRO_MAX_HOLD_RATIO = 0.1;

export function detectSustainedChordVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (map.keyCount !== 4 || map.notes.length < RICE_VIBRO_MIN_NOTES || !Number.isFinite(rate) || rate <= 0) return false;
  const rows = new Map<number, number>();
  let holds = 0;
  for (const note of map.notes) {
    rows.set(note.time, (rows.get(note.time) ?? 0) | (1 << note.column));
    if (note.isHold) holds++;
  }
  if (holds / map.notes.length > SUSTAINED_CHORD_VIBRO_MAX_HOLD_RATIO) return false;

  const times = [...rows.keys()].sort((a, b) => a - b);
  for (const band of SUSTAINED_CHORD_VIBRO_BANDS) {
    const lastColumnTimes = new Array<number>(4).fill(-Infinity);
    const cutoff = band.gapMs * rate;
    let columnGaps = 0;
    let fastColumnGaps = 0;
    let chordRows = 0;
    let consecutiveRows = 0;
    let longestRun = 0;
    for (const time of times) {
      const mask = rows.get(time)!;
      let fastFingers = 0;
      for (let column = 0; column < 4; column++) {
        if (!(mask & (1 << column))) continue;
        const gap = time - lastColumnTimes[column];
        if (Number.isFinite(gap) && gap > 0) {
          columnGaps++;
          if (gap <= cutoff) {
            fastColumnGaps++;
            fastFingers++;
          }
        }
        lastColumnTimes[column] = time;
      }
      if (fastFingers >= 2) {
        chordRows++;
        consecutiveRows++;
        longestRun = Math.max(longestRun, consecutiveRows);
      } else {
        consecutiveRows = 0;
      }
    }
    if (columnGaps > 0
      && fastColumnGaps / columnGaps >= band.columnShare
      && chordRows / rows.size >= SUSTAINED_CHORD_VIBRO_MIN_ROW_SHARE
      && longestRun >= SUSTAINED_CHORD_VIBRO_MIN_ROWS) return true;
  }
  return false;
}

export function detectRateVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (usesSectionVibro(map)) return analyzeVibroSections(map, rate).status === "excluded";
  if (analyzeStackedHeads(map, rate) || analyzeWideJumptrill(map, rate) || analyzeCollapsedNotes(map, rate)
    || analyzeHoldVibro(map, rate)) return true;
  if (detectRollVibro(map, rate)) return true;
  if (detectSustainedChordVibro(map, rate)) return true;
  if (map.notes.length < RICE_VIBRO_BURST_MIN_NOTES) return false;
  return chordWallRatio(map, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RATE_VIBRO_CHORD_WALL_MIN_RATIO;
}

export function detectRiceVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (usesSectionVibro(map)) return analyzeVibroSections(map, rate).status === "excluded";
  if (analyzeStackedHeads(map, rate) || analyzeWideJumptrill(map, rate) || analyzeCollapsedNotes(map, rate)
    || analyzeHoldVibro(map, rate)) return true;
  if (map.notes.length >= RICE_VIBRO_MIN_NOTES) {
    const sustained = columnFastGaps(map, RICE_VIBRO_COLUMN_GAP_MS * rate);
    if (sustained.maxRun >= RICE_VIBRO_COLUMN_MIN_RUN && sustained.ratio >= RICE_VIBRO_COLUMN_MIN_RATIO) return true;
    if (detectSustainedChordVibro(map, rate)) return true;

    if (map.keyCount === 4) {
      const walls = quadWallRows(map, RICE_VIBRO_WALL_GAP_MS * rate);
      if (walls.rows >= RICE_VIBRO_WALL_MIN_ROWS && walls.ratio >= RICE_VIBRO_WALL_MIN_ROW_RATIO) {
        const fast = columnFastGaps(map, RICE_VIBRO_WALL_COLUMN_GAP_MS * rate);
        if (fast.ratio >= RICE_VIBRO_WALL_COLUMN_MIN_RATIO) return true;
      }
      if (detectRollVibro(map, rate)) return true;
    }
  }

  if (map.notes.length >= RICE_VIBRO_BURST_MIN_NOTES) {
    const bursts = columnBurstRuns(map, RICE_VIBRO_BURST_GAP_MS * rate, RICE_VIBRO_BURST_MIN_RUN);
    if (bursts.runs >= RICE_VIBRO_BURST_MIN_RUNS && bursts.fraction >= RICE_VIBRO_BURST_MIN_FRACTION) return true;

    if (peakRowsPerSecond(map, RICE_VIBRO_ROW_RATE_WINDOW_MS * rate) >= RICE_VIBRO_MAX_ROWS_PER_SECOND) return true;

    if (chordWallRatio(map, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RICE_VIBRO_CHORD_WALL_MIN_RATIO) return true;
  }
  return false;
}

export function detectLnVibro(map: ManiaBeatmap, rate = 1): boolean {
  let holds = 0;
  const rowTimes = new Set<number>();
  for (const note of map.notes) {
    if (note.isHold && note.endTime > note.time) holds++;
    rowTimes.add(note.time);
  }
  if (map.notes.length === 0 || rowTimes.size < LN_VIBRO_MIN_ROWS) return false;
  if (holds / map.notes.length < LN_VIBRO_MIN_HOLD_RATIO) return false;
  const times = [...rowTimes].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index++) gaps.push(times[index] - times[index - 1]);
  gaps.sort((a, b) => a - b);
  const p75 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.75))];
  return p75 <= LN_VIBRO_MAX_P75_ROW_GAP_MS * rate;
}
