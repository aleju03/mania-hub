// Whole-chart vibro detection for chart analysis and player ratings. 4K rice
// (at most 10% holds) goes to the section detector in ./sections; everything
// else is checked against the tiers below. Timings are chart time scaled by
// the played rate.

import type { ManiaBeatmap } from "../chart/beatmap";
import { analyzeVibroSections, usesSectionVibro } from "./sections";

// LN vibro: dense staggered holds across the whole chart. The densest ranked
// LN charts sit at ~75ms p75 row gaps; LN vibro measures ~22ms.
const LN_VIBRO_MIN_ROWS = 150;
const LN_VIBRO_MIN_HOLD_RATIO = 0.5;
const LN_VIBRO_MAX_P75_ROW_GAP_MS = 40;

// Rice vibro tiers, calibrated on vibro packs against ranked jack files and
// dense charts at 1.05-1.2x.
//
// Tier 1 (any keymode): long same-column runs, 24+ hits at <=92ms with a
// quarter of all column gaps that fast. Ranked jack files have runs of 6 or
// less.
const RICE_VIBRO_MIN_NOTES = 300;
const RICE_VIBRO_COLUMN_GAP_MS = 92;
const RICE_VIBRO_COLUMN_MIN_RUN = 24;
const RICE_VIBRO_COLUMN_MIN_RATIO = 0.25;

// Tier 2 (4K only): quad walls at ~97-105ms. Legit 4K tops out at ~3.3% wall
// rows and keeps its column repeats above 98ms.
const RICE_VIBRO_WALL_GAP_MS = 105;
const RICE_VIBRO_WALL_MIN_ROWS = 12;
const RICE_VIBRO_WALL_MIN_ROW_RATIO = 0.035;
const RICE_VIBRO_WALL_COLUMN_GAP_MS = 98;
const RICE_VIBRO_WALL_COLUMN_MIN_RATIO = 0.32;

// Tier 3 (any keymode): charts made of 8+ hit bursts at <=100ms, too short for
// tier 1. Legit charts keep under ~0.13 of their column gaps in such bursts.
const RICE_VIBRO_BURST_MIN_NOTES = 200;
const RICE_VIBRO_BURST_GAP_MS = 100;
const RICE_VIBRO_BURST_MIN_RUN = 8;
const RICE_VIBRO_BURST_MIN_RUNS = 4;
const RICE_VIBRO_BURST_MIN_FRACTION = 0.2;

// Tier 4 (any keymode): peak rows per second, for spam spread across columns
// as jumps or quads. Rows rather than notes, since a chord is one action.
// Ranked and loved charts peak at 55 (4K), 57 (7K) and 49 (6K).
const RICE_VIBRO_ROW_RATE_WINDOW_MS = 1000;
const RICE_VIBRO_MAX_ROWS_PER_SECOND = 65;

// Tier 5 (any keymode): back-to-back near-full chords inside 70ms, a 214BPM
// chordjack. Catches triple/quad mixes that tier 2 misses. Ranked and loved
// charts top out at 0.004 of row transitions.
const RICE_VIBRO_CHORD_WALL_GAP_MS = 70;
const RICE_VIBRO_CHORD_WALL_MIN_RATIO = 0.02;

// Tier 6 (4K only): roll vibro. Needs both a share of fast column repeats
// (~15/s per finger) and a share of fast row changes that move to another
// column, which is what separates a roll from a jack. No ranked or loved 4K
// chart meets both at 1.0x. Ranked 7K has fast column repeats all the time, so
// this stays 4K only.
const RICE_VIBRO_ROLL_GAP_MS = 70;
const RICE_VIBRO_ROLL_MIN_RATIO = 0.25;
const RICE_VIBRO_ROLL_ROW_GAP_MS = 25;
const RICE_VIBRO_ROLL_MIN_ROW_RATIO = 0.3;

// Tier 5 at rate needs half the chart to be chord walls. At 2% it flags short
// fast chordjack bursts in legit DT plays.
const RATE_VIBRO_CHORD_WALL_MIN_RATIO = 0.5;

// Sustained chord vibro (4K rice): long runs of rows where two fingers re-hit
// fast while the third rotates out. Speed, share and run length are all
// required. No matches in 8,090 ranked or loved 4K rice charts at 1.0x, or
// 5,599 with a 96%+ DT clear. The faster band needs less coverage.
const SUSTAINED_CHORD_VIBRO_BANDS = [
  { gapMs: 70, columnShare: 0.4 },
  { gapMs: 60, columnShare: 0.35 },
] as const;
const SUSTAINED_CHORD_VIBRO_MIN_ROW_SHARE = 0.2;
// About two seconds at 70ms. Counted in rows so a rate can't shorten a
// section out of it.
const SUSTAINED_CHORD_VIBRO_MIN_ROWS = 32;
const SUSTAINED_CHORD_VIBRO_MAX_HOLD_RATIO = 0.1;

/** Tier 6 on its own. */
export function detectRollVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (map.keyCount !== 4 || map.notes.length < RICE_VIBRO_MIN_NOTES) return false;
  return columnFastGaps(map, RICE_VIBRO_ROLL_GAP_MS * rate).ratio >= RICE_VIBRO_ROLL_MIN_RATIO
    && fastRollRowShare(map, RICE_VIBRO_ROLL_ROW_GAP_MS * rate) >= RICE_VIBRO_ROLL_MIN_ROW_RATIO;
}

/** A row counts when at least two fingers each re-hit within the band's
 * window. */
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

/** Vibro at the played rate, for player ratings. Only an "excluded" section
 * verdict counts. Tiers 1-4 are left out because at rate they flag real DT
 * jack clears. */
export function detectRateVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (usesSectionVibro(map)) return analyzeVibroSections(map, rate).status === "excluded";
  if (detectRollVibro(map, rate)) return true;
  if (detectSustainedChordVibro(map, rate)) return true;
  if (map.notes.length < RICE_VIBRO_BURST_MIN_NOTES) return false;
  return chordWallRatio(map, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RATE_VIBRO_CHORD_WALL_MIN_RATIO;
}

/** Vibro for chart analysis, using every tier. */
export function detectRiceVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (usesSectionVibro(map)) return analyzeVibroSections(map, rate).status === "excluded";
  if (map.notes.length >= RICE_VIBRO_MIN_NOTES) {
    const sustained = columnFastGaps(map, RICE_VIBRO_COLUMN_GAP_MS * rate);
    if (sustained.maxRun >= RICE_VIBRO_COLUMN_MIN_RUN && sustained.ratio >= RICE_VIBRO_COLUMN_MIN_RATIO) return true;
    if (detectSustainedChordVibro(map, rate)) return true;

    // Wider keymodes have legit 4-note chords everywhere.
    if (map.keyCount === 4) {
      const walls = quadWallRows(map, RICE_VIBRO_WALL_GAP_MS * rate);
      if (walls.rows >= RICE_VIBRO_WALL_MIN_ROWS && walls.ratio >= RICE_VIBRO_WALL_MIN_ROW_RATIO) {
        const fast = columnFastGaps(map, RICE_VIBRO_WALL_COLUMN_GAP_MS * rate);
        if (fast.ratio >= RICE_VIBRO_WALL_COLUMN_MIN_RATIO) return true;
      }
      if (detectRollVibro(map, rate)) return true;
    }
  }

  // Lower note floor so short burst charts still count.
  if (map.notes.length >= RICE_VIBRO_BURST_MIN_NOTES) {
    const bursts = columnBurstRuns(map, RICE_VIBRO_BURST_GAP_MS * rate, RICE_VIBRO_BURST_MIN_RUN);
    if (bursts.runs >= RICE_VIBRO_BURST_MIN_RUNS && bursts.fraction >= RICE_VIBRO_BURST_MIN_FRACTION) return true;

    if (peakRowsPerSecond(map, RICE_VIBRO_ROW_RATE_WINDOW_MS * rate) >= RICE_VIBRO_MAX_ROWS_PER_SECOND) return true;

    if (chordWallRatio(map, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RICE_VIBRO_CHORD_WALL_MIN_RATIO) return true;
  }
  return false;
}

/** At least 150 rows, half the notes holds, and a p75 row gap of 40ms or
 * less at the played rate. */
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

function notesByColumn(map: ManiaBeatmap): Map<number, number[]> {
  const byColumn = new Map<number, number[]>();
  for (const note of map.notes) {
    const list = byColumn.get(note.column) ?? [];
    list.push(note.time);
    byColumn.set(note.column, list);
  }
  return byColumn;
}

/** Longest run of consecutive same-column gaps at or under cutoffMs, and the
 * share of all column gaps that are that fast. Zero gaps (stacked notes) are
 * skipped. */
function columnFastGaps(map: ManiaBeatmap, cutoffMs: number): { maxRun: number; ratio: number } {
  let maxRun = 0;
  let fast = 0;
  let total = 0;
  for (const times of notesByColumn(map).values()) {
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

/** Share of fast row transitions that move to other columns. Same-column
 * pairs are flams or stacks. */
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

/** Tier 3 signal: the number of same-column runs of at least minRun fast gaps,
 * and the share of all column gaps that sit inside them. */
function columnBurstRuns(map: ManiaBeatmap, cutoffMs: number, minRun: number): { runs: number; fraction: number } {
  let runs = 0;
  let inRuns = 0;
  let total = 0;
  for (const times of notesByColumn(map).values()) {
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

/** Tier 2 signal: adjacent row pairs that are both 4+ note chords inside
 * cutoffMs, as a count and as a share of row transitions. */
function quadWallRows(map: ManiaBeatmap, cutoffMs: number): { rows: number; ratio: number } {
  const rowSizes = rowSizesByTime(map);
  const times = [...rowSizes.keys()].sort((a, b) => a - b);
  let rows = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap <= 0 || gap > cutoffMs) continue;
    if ((rowSizes.get(times[index]) ?? 0) >= 4 && (rowSizes.get(times[index - 1]) ?? 0) >= 4) rows++;
  }
  return { rows, ratio: times.length > 1 ? rows / (times.length - 1) : 0 };
}

/** Tier 5 signal: share of row transitions where both rows carry a near-full
 * chord (keyCount - 1 notes, at least 2) inside cutoffMs. */
function chordWallRatio(map: ManiaBeatmap, cutoffMs: number): number {
  const rowSizes = rowSizesByTime(map);
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

/** Tier 4 signal: most rows inside any one window. */
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

function rowSizesByTime(map: ManiaBeatmap): Map<number, number> {
  const rowSizes = new Map<number, number>();
  for (const note of map.notes) rowSizes.set(note.time, (rowSizes.get(note.time) ?? 0) + 1);
  return rowSizes;
}
