/**
 * Note-data motion features for the 4K tech-vs-speed axis.
 *
 * The distinction 4K players draw between the two is biomechanical rather than
 * rhythmic: a tech chart asks the wrist to oscillate (two-column trills,
 * minijacks, patterns that keep returning to a column), a speed chart asks the
 * fingers to roll across the hands in one direction. MinaCalc's Technical and
 * Stream ratings both rise with density and often land within a rating point
 * of each other on the same chart, which is why the MSD lead alone could not
 * separate the two: measured over 738 pack-labelled charts sitting in that
 * near-tie, the lead scores AUC 0.73 while these features score 0.84 on their
 * own and 0.86 alongside it (out-of-fold, packs held out whole).
 *
 * Every share is weighted by local speed (1/gap, saturated), so a dense burst
 * counts for more than a sparse intro and no burst-gap threshold has to be
 * invented. The shares are ratios of like-weighted windows, so speeding a
 * chart up does not move them: these are a property of the chart, measured
 * once at 1.0x, and a rate edit of the same chart reads the same. What the
 * rate changes is the MSD vector, which the reader supplies separately.
 *
 * 4K only. The hand split (columns 0-1 against 2-3) is what makes "one hand
 * oscillating" meaningful, and the pack corpus that validated the features is
 * 4K; other keymodes bucket by analyzer tags and never ask for this.
 */
import type { ManiaNote } from "./beatmap-parser.js";

/** The stored block. Every field is a share in [0, 1] unless noted. */
export interface MotionFeatures {
  /** Adjacent single-note pairs landing on the same hand, different column. */
  sameHand: number;
  /** Adjacent single-note pairs repeating one column (minijack). */
  miniJack: number;
  /** Three-note windows reading c,d,c with c and d on ONE hand. */
  oneHandTrill: number;
  /** Three-note windows reading c,d,c with c and d on opposite hands. The
   *  strongest single tech marker in the near-tie band: a stream varies its
   *  columns, a trill keeps coming back to the same two. */
  crossHandTrill: number;
  /** Four-note windows stepping one column at a time across all four columns,
   *  the full cross-hand roll. */
  roll4: number;
  /** Adjacent gap ratios that are not a musical 1:1, 2:1 or 1:2. */
  rhythmBreak: number;
  /** Adjacent row pairs whose chord size changes. */
  chordSwing: number;
  /** Coefficient of variation of per-second note density. Not a share. */
  densitySwing: number;
}

const ROW_EPSILON_MS = 10;
// Gaps below this are vibro/burst noise; weighting by 1/gap alone would let a
// few rows speak for the whole chart, so the weight saturates here.
const MIN_GAP_MS = 25;
// Past this the notes are not one motion any more, so the window is dropped
// rather than merely down-weighted.
const MAX_GAP_MS = 400;
// Under this many rows the shares are noise, and no chart a player clears for
// dan credit is this short.
const MIN_ROWS = 24;

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

function ratioIsMusical(ratio: number): boolean {
  for (const target of [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3, 4, 0.25]) {
    if (Math.abs(ratio - target) <= target * 0.08) return true;
  }
  return false;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

/** Null when the chart is not 4K or is too short to measure. */
export function motionFeatures(notes: ManiaNote[], keyCount: number): MotionFeatures | null {
  if (keyCount !== 4 || notes.length < 32) return null;
  const rows = buildRows(notes);
  if (rows.length < MIN_ROWS) return null;

  let pairW = 0, sameHandW = 0, miniJackW = 0, chordSwingW = 0;
  let tripW = 0, trillW = 0, crossTrillW = 0;
  let quadW = 0, roll4W = 0;
  let rhythmW = 0, rhythmBreakW = 0;

  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    const gap = b.time - a.time;
    if (gap <= 0 || gap > MAX_GAP_MS) continue;
    const w = weightFor(gap);
    pairW += w;
    if (a.columns.length !== b.columns.length) chordSwingW += w;
    if (a.columns.length === 1 && b.columns.length === 1) {
      const ca = a.columns[0], cb = b.columns[0];
      if (ca === cb) miniJackW += w;
      else if (hand(ca) === hand(cb)) sameHandW += w;
    }
  }

  for (let i = 0; i + 2 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1], c = rows[i + 2];
    const g0 = b.time - a.time, g1 = c.time - b.time;
    if (g0 <= 0 || g1 <= 0 || g0 > MAX_GAP_MS || g1 > MAX_GAP_MS) continue;
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
    if (gaps.some((gap) => gap <= 0 || gap > MAX_GAP_MS)) continue;
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
    oneHandTrill: round4(share(trillW, tripW)),
    crossHandTrill: round4(share(crossTrillW, tripW)),
    roll4: round4(share(roll4W, quadW)),
    rhythmBreak: round4(share(rhythmBreakW, rhythmW)),
    chordSwing: round4(share(chordSwingW, pairW)),
    densitySwing: round4(mean > 0 ? Math.sqrt(variance) / mean : 0),
  };
}
