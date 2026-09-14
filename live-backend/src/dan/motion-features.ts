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
 * Only the sections at the chart's own pace are read. The pace is the gap a
 * quarter of its rows sit at or under, and a window whose surroundings (the
 * median gap over the PACE_CONTEXT rows either side) run more than PACE_SLACK
 * times slower than that is filler (a break, a half-time bridge, the
 * jumpstream between the streams) and is dropped the way a window past
 * MAX_GAP_MS already is. Weighting by 1/gap alone only halved such material,
 * and that was enough for it to decide a chart: a 277 BPM roll chart with
 * fifteen slow triple jacks in its breaks and two 139 BPM trill bridges read
 * five times the corpus minijack share and twice its cross-hand trill share
 * off notes at half the speed its difficulty sits at, and filed under tech.
 * The gate reads the surroundings rather than the window's own gap so that a
 * jack or a trill written INTO a stream at half its snap still counts: that
 * is where the tech-pack minijacks live, and gating on the window's own gap
 * threw them away (minijack alone separates the fit band at AUC 0.77 with
 * this gate, 0.73 without it, 0.60 gated on its own gap; measured 2026-09-12
 * with scripts/dev/speed-tech-model.ts). Measured relative to the pace, the
 * gate is rate-invariant like the shares.
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
  /** Adjacent row pairs that differ, involve at least one chord and share a
   *  column: a minijack into or out of a jump, the anchor a jumpstream keeps
   *  one finger on. miniJack cannot see these because it reads single-note
   *  pairs only, and a jumpstream tech chart writes almost all of its jacks
   *  this way. Added 2026-09-13; blocks stored before then lack the field. */
  anchor: number;
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
// The chart's pace: the gap this share of its adjacent-row gaps (within
// MAX_GAP_MS) sit at or under. A quarter says the fast material has to be a
// real body of the chart, not a burst: a file that is 15% 1/8 bursts over a
// 1/4 body keeps the body, one that is a third bursts is read off the bursts.
const PACE_QUANTILE = 0.25;
// How much slower than the pace a window's surroundings may run and still
// count. 1.6 keeps the neighbouring snaps of one tempo (1/3 beside 1/4 at
// 1.33x, 1/6 beside 1/4 at 1.5x) and drops the half-time ones (1/2 beside
// 1/4 at 2x), with margin on both sides so a BPM change of a few percent
// cannot flip a snap.
const PACE_SLACK = 1.6;
// Rows either side of a window whose median gap is "its surroundings": 17
// gaps, about a bar of 1/4 notes, so a section has to be slow for a bar to
// read as filler and a single slow jack inside a stream never does.
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

/** Per adjacent-row gap, whether the window starting there sits in a section
 *  at the chart's pace (true) or in filler (false). */
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

/** Null when the chart is not 4K or is too short to measure. */
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
