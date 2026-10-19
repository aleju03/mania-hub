import type { ManiaNote } from "../chart/beatmap";

export interface MotionFeatures {
  sameHand: number;
  miniJack: number;
  anchor: number;
  oneHandTrill: number;
  crossHandTrill: number;
  roll4: number;
  rhythmBreak: number;
  chordSwing: number;
  densitySwing: number;
}

const ROW_EPSILON_MS = 10;

const MIN_GAP_MS = 25;

const MAX_GAP_MS = 400;

const MIN_ROWS = 24;

const PACE_QUANTILE = 0.25;

const PACE_SLACK = 1.6;

const PACE_CONTEXT = 8;

interface Row {
  time: number;
  columns: number[];
}

function hand(column: number): number {
  return column < 2 ? 0 : 1;
}

function buildRows(notes: ManiaNote[]): Row[] {
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const rows: Row[] = [];
  for (const note of sorted) {
    const last = rows[rows.length - 1];
    if (last && note.time - last.time <= ROW_EPSILON_MS) last.columns.push(note.column);
    else rows.push({ time: note.time, columns: [note.column] });
  }
  for (const row of rows) row.columns.sort((a, b) => a - b);
  return rows;
}

function weightFor(gap: number): number {
  return 1 / Math.max(gap, MIN_GAP_MS);
}

function atPace(rows: Row[]): boolean[] {
  const gaps: number[] = [];
  for (let i = 0; i + 1 < rows.length; i++) gaps.push(rows[i + 1].time - rows[i].time);
  const valid = gaps.filter((gap) => gap > 0 && gap <= MAX_GAP_MS).sort((a, b) => a - b);
  if (valid.length === 0) return gaps.map(() => false);
  const pace = valid[Math.min(valid.length - 1, Math.floor(valid.length * PACE_QUANTILE))];
  const limit = pace * PACE_SLACK;
  return gaps.map((_, index) => {
    const around: number[] = [];
    for (let j = Math.max(0, index - PACE_CONTEXT); j <= Math.min(gaps.length - 1, index + PACE_CONTEXT); j++) {
      if (gaps[j] > 0 && gaps[j] <= MAX_GAP_MS) around.push(gaps[j]);
    }
    if (around.length === 0) return false;
    around.sort((a, b) => a - b);
    return around[Math.floor(around.length / 2)] <= limit;
  });
}

function ratioIsMusical(ratio: number): boolean {
  for (const target of [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3, 4, 0.25]) {
    if (Math.abs(ratio - target) <= target * 0.08) return true;
  }
  return false;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function motionFeatures(notes: ManiaNote[], keyCount: number): MotionFeatures | null {
  if (keyCount !== 4 || notes.length < 32) return null;
  const rows = buildRows(notes);
  if (rows.length < MIN_ROWS) return null;
  const inPace = atPace(rows);

  let pairW = 0, sameHandW = 0, miniJackW = 0, anchorW = 0, chordSwingW = 0;
  let tripW = 0, trillW = 0, crossTrillW = 0;
  let quadW = 0, roll4W = 0;
  let rhythmW = 0, rhythmBreakW = 0;

  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    const gap = b.time - a.time;
    if (gap <= 0 || gap > MAX_GAP_MS || !inPace[i]) continue;
    const w = weightFor(gap);
    pairW += w;
    if (a.columns.length !== b.columns.length) chordSwingW += w;
    if (a.columns.length === 1 && b.columns.length === 1) {
      const ca = a.columns[0], cb = b.columns[0];
      if (ca === cb) miniJackW += w;
      else if (hand(ca) === hand(cb)) sameHandW += w;
    } else if (a.columns.some((column) => b.columns.includes(column))) {
      const identical = a.columns.length === b.columns.length && a.columns.every((column, k) => column === b.columns[k]);
      if (!identical) anchorW += w;
    }
  }

  for (let i = 0; i + 2 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1], c = rows[i + 2];
    const g0 = b.time - a.time, g1 = c.time - b.time;
    if (g0 <= 0 || g1 <= 0 || g0 > MAX_GAP_MS || g1 > MAX_GAP_MS || !inPace[i]) continue;
    const w = weightFor(Math.max(g0, g1));
    rhythmW += w;
    if (!ratioIsMusical(g1 / g0)) rhythmBreakW += w;
    if (a.columns.length !== 1 || b.columns.length !== 1 || c.columns.length !== 1) continue;
    tripW += w;
    const ca = a.columns[0], cb = b.columns[0], cc = c.columns[0];
    if (ca === cc && ca !== cb) {
      if (hand(ca) === hand(cb)) trillW += w;
      else crossTrillW += w;
    }
  }

  for (let i = 0; i + 3 < rows.length; i++) {
    const window = [rows[i], rows[i + 1], rows[i + 2], rows[i + 3]];
    const gaps = [window[1].time - window[0].time, window[2].time - window[1].time, window[3].time - window[2].time];
    if (gaps.some((gap) => gap <= 0 || gap > MAX_GAP_MS) || !inPace[i]) continue;
    if (window.some((row) => row.columns.length !== 1)) continue;
    const w = weightFor(Math.max(...gaps));
    quadW += w;
    const columns = window.map((row) => row.columns[0]);
    const steps = [columns[1] - columns[0], columns[2] - columns[1], columns[3] - columns[2]];
    if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) roll4W += w;
  }

  const first = rows[0].time, last = rows[rows.length - 1].time;
  const seconds = Math.max(1, Math.ceil((last - first) / 1000));
  const perSecond = new Array<number>(seconds).fill(0);
  for (const row of rows) {
    const index = Math.min(seconds - 1, Math.floor((row.time - first) / 1000));
    perSecond[index] += row.columns.length;
  }
  const active = perSecond.filter((count) => count > 0);
  const mean = active.length ? active.reduce((sum, n) => sum + n, 0) / active.length : 0;
  const variance = active.length
    ? active.reduce((sum, n) => sum + (n - mean) * (n - mean), 0) / active.length
    : 0;

  const share = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : 0);
  return {
    sameHand: round4(share(sameHandW, pairW)),
    miniJack: round4(share(miniJackW, pairW)),
    anchor: round4(share(anchorW, pairW)),
    oneHandTrill: round4(share(trillW, tripW)),
    crossHandTrill: round4(share(crossTrillW, tripW)),
    roll4: round4(share(roll4W, quadW)),
    rhythmBreak: round4(share(rhythmBreakW, rhythmW)),
    chordSwing: round4(share(chordSwingW, pairW)),
    densitySwing: round4(mean > 0 ? Math.sqrt(variance) / mean : 0),
  };
}
