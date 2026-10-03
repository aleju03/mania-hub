/**
 * Effective LN share: how much of a chart actually demands a release.
 *
 * A hold is effective when its played body outlasts the OD's release 300
 * window ("long"), or when it sits in a recurring same-lane release/repress
 * chain ("chained": two or more links, bodies within 20ms of the window or
 * longer, tail-to-next-head gaps from 0 to the window). A lone pair, a tiny
 * body or another column's head inside the body is not enough. Durations and
 * gaps are measured at the played rate, exactly once.
 *
 * Identity reads each 10s window: LN when 40% of its notes are long holds, or
 * when 60% are release work of either kind (an inverse chart at 264 bpm writes
 * 57ms bodies under a 63ms window and never has a long hold). The chart's
 * share is the note-weighted median over windows, so it is LN when most of
 * its playtime is: short-LN filler does not dilute real LN sections, and one
 * LN wall does not qualify a rice chart. On 4K this gate follows the 45% hold
 * line; it can demote a nominal LN chart whose tails are free, never promote.
 *
 * Everything here is structural (times, columns, OD); no chart identity.
 */

import type { ManiaBeatmap } from "../chart/beatmap";
import { detectLnVibro } from "../vibro/detection";
import { lnPrimaryMinRatioFor } from "./ln";

export interface EffectiveLnNote {
  column: number;
  time: number;
  endTime: number;
  isHold: boolean;
}

export interface EffectiveLnOptions {
  /** Playback rate; note times divide by it. */
  rate?: number;
  /** Chart OD; null/undefined falls back to the OD8 the wife model assumes. */
  od?: number | null;
  /** Column count, for the LN vibro check; derived from the notes when absent. */
  keyCount?: number;
}

export interface EffectiveLnAnalysis {
  notes: number;
  holds: number;
  effectiveHolds: number;
  /** Plain hold share, the lnRatio the classifier has always reported. */
  holdRatio: number;
  /** Effective holds over all notes, chart-wide. Gates the tail-aware calc pass. */
  effectiveHoldRatio: number;
  /** Note-weighted median of the per-window identity reading (long-tail share, or the
   * chained-work share scaled to the same 0.4 line). The second 4K LN identity gate. */
  effectiveLnRatio: number;
  /** Tap-covered holds without an interior head. Not effective. */
  shortTails: number;
  /** Tap-covered holds spanning another column's head. Diagnostic, not effective. */
  shortSpanning: number;
  /** Holds longer than a tap covers. */
  longTails: number;
  /** Near-window short holds in a recurring same-lane release/repress chain. */
  chainedShortHolds: number;
  /** Holds carrying identity work (long or chained) at the identity OD, over
   * all holds: near zero when the holds are vibro notation or all free. */
  identityWorkShare: number;
  /** Median over windows of the holds an ordinary tap cannot release in time,
   * each weighted by that chance, over the window's notes: the higher of the
   * note-weighted and the time-weighted median (see LN_TRACKED_MIN_SHARE). */
  trackedShare: number;
  /** trackedShare is under LN_TRACKED_MIN_SHARE: the holds are tapped through,
   * and no rating tiebreak may lift the chart to LN (dan/ln-identity.ts). */
  tapCovered: boolean;
  /** The pinned and under-hold shares of the window at LN_HELD_PEAK_QUANTILE. */
  heldPeakPinned: number;
  heldPeakUnderHold: number;
  /** Both under their lines and no written chains: the rating tiebreak cannot
   * make the chart LN (dan/ln-identity.ts). */
  heldPeakLight: boolean;
  /** The chart is LN vibro (dan/vibro-detection.ts) at this rate: staggered
   * hold spam played by shaking. Its chains establish nothing. */
  lnVibro: boolean;
}

// ScoreV2 (and lazer's split-tail judgement) gives releases windows 1.5x the
// head's; the head 300 window is 64ms less 3ms per OD point (the same table
// the wife model in features/player-skills.ts values judgements against).
const RELEASE_WINDOW_MULTIPLIER = 1.5;
const GREAT_WINDOW_BASE_MS = 64;
const OD_WINDOW_STEP_MS = 3;
const ASSUMED_OD = 8;
/**
 * Identity never reads an OD under this: the release window widens as OD
 * falls (96ms at OD 0, 73.5ms at OD 5), so on a low-OD file most 1/8 holds
 * read free and a hold-heavy chart files as rice for the OD its mapper left.
 * Over the 1,481 cached 4K charts under the floor past the hold line
 * (2026-09-18), 496 join LN at 1.0x and nothing crosses the other way; 5.5
 * sends one chart to rice. Pricing (the rating, the tail pass, the counts)
 * keeps the played OD; only the LN-or-rice question reads the floor.
 */
export const LN_IDENTITY_MIN_OD = 5;
/**
 * The share of a chart's holds that must carry identity work (long or chained
 * at the identity OD) for its holds to count as an LN side at all, for the LN
 * number and the hybrid badge. Real hybrids sit at 0.68 or above (5th
 * percentile of the 25-75% hold band, 2026-09-18); the 80 charts under 0.1
 * are vibro packs of 43ms holds.
 */
export const LN_MIN_WORK_SHARE = 0.1;
// A head this close to the hold's own head or release is the same chord, not
// something pressed under the hold. osu! quantizes to whole ms, and 1/4 grids
// at any playable tempo sit well outside it.
export const LN_SAME_MOTION_TOLERANCE_MS = 20;
const WINDOW_MS = 10_000;
// Windows with fewer notes are breaks and carry no LN verdict either way.
const WINDOW_MIN_NOTES = 8;

/** Keymodes whose LN identity adds the effective-share gate. 7K's hybrid
 * mapping culture sits on its own hold-share line (LN_PRIMARY_7K_MIN_RATIO)
 * and stays there until its courses are measured against this model. */
export const LN_EFFECTIVE_KEY_COUNTS: ReadonlySet<number> = new Set([4]);

/** Stored beside the derived share so a model change rescans every row.
 * v5 chained-work reading; v6 identity OD floor and LN vibro; v7 tap gate;
 * v8 tap line 0.10 and no LN number on tapped-through charts; v9 tap-weighted
 * release work; v10 pair-fitted rate response; v11 chains read as written;
 * v12 tap gate also reads the time-weighted median; v13 chains exempt a chart
 * from the tap gate; v14 the rating tiebreak needs a held peak; v15 it needs
 * held-through holds where only chains lift the tap gate (dan/ln-identity.ts). */
export const LN_EFFECTIVE_MODEL_VERSION = 15;

/**
 * The effective share at which a 4K chart's identity is LN: a note-weighted
 * median of window shares, so on its own scale rather than the 0.45 hold line.
 * Fitted 2026-09-03 to hand-labeled LN charts that land just under 0.45
 * (0.415 to 0.439). Full-LN "noodle" charts a tap covers end to end sit at
 * 0.30 and below. A chart at 0.412 with 37.8% holds plays as jumpstream: the
 * hold line keeps it rice.
 */
export const LN_EFFECTIVE_MIN_RATIO = 0.4;

/**
 * The share of a window's notes that must be release work (long or chained
 * holds) for it to read LN when its bodies are tap-covered, scaled onto the
 * 0.4 line so one stored share answers both readings. Fitted 2026-09-17 on
 * hand-labeled charts: an inverse handstream at 264 bpm (0.80) and a pack
 * chart at the same tempo (0.66) are LN; at 1.5x three jumpstream charts
 * written in holds (0.53, 0.48 and 0.27) stay rice.
 */
export const LN_CHAINED_MIN_RATIO = 0.6;

/**
 * How long a key stays down on an ordinary tap, from 2.46M taps in 1,230
 * lazer 4K LN replays (2026-09-28): log-normal, median growing with the time
 * to the same column's next head (48ms at 55ms, 80ms from 210ms on), log
 * spread 0.29 at every gap. A hold a tap like that releases in time demands
 * nothing a tap does not; key-down time stays near 80ms for bodies up to
 * 110ms and only follows the body past 130ms.
 */
const TAP_MEDIAN_BASE_MS = 36;
const TAP_MEDIAN_PER_GAP = 0.213;
const TAP_MEDIAN_MAX_MS = 80;
const TAP_LOG_SPREAD = 0.29;

/**
 * The share of a window's notes that must be holds an ordinary tap cannot
 * release in time (each counted by that chance), as the note-weighted median
 * over windows. Under it the holds are notation a player taps through: the
 * chart is rice and publishes no LN number. Bounded by hand-labeled charts:
 * rice reaches 0.084 (a chart at 1.0x that plays as jumpstream), LN starts at
 * 0.112 (one chart at 1.5x, another at 0.113); every LN course reads 0.154 or
 * more.
 *
 * The share is the higher of two medians over the 10s windows: weighted by
 * notes, and weighted by time (every window alike). Notes alone let the
 * densest windows decide, and at speed those are exactly the ones a tap
 * covers, so a chart with LN through most of its playtime read as rice.
 * Time alone drops charts whose LN sits in the dense windows. On 18
 * hand-labeled plays at 1.0x and 1.5x (2026-09-29) notes alone agree on 11,
 * the higher of the two on 15; over the 11,080 cached 4K charts past the hold
 * line it adds 77 LN charts at 1.0x, 128 at 1.5x and 27 at 0.75x, and removes
 * none.
 */
export const LN_TRACKED_MIN_SHARE = 0.1;

/**
 * The tap gate stands down on a chart whose chained short holds (released,
 * then the same lane pressed again inside the chain window) are a tenth of
 * its notes and whose long holds are 15%. A tap releases a short hold in
 * time, but a same-lane release and re-press among real holds is a motion a
 * tapped-through chart never asks for; the long-hold share keeps out a fast
 * 1/4-held stream, whose same-lane repeats chain at speed with no long hold.
 * Of 20 hand-labeled plays under the tap line (2026-09-30), 7 of the 11 LN
 * plays pass both (chains 0.11 to 0.35, long 0.20 to 0.51), against 1 of the
 * 9 rice plays; the other rice plays reach 0.08 chained. Over the
 * 11,144 cached 4K charts past the hold line it lifts the gate on 143 of the
 * 769 tapped-through charts at 1.0x, 1,568 of 4,817 at 1.5x and 7 of 235 at
 * 0.75x; structure or the rating tiebreak then decides them.
 */
export const LN_TAP_GATE_CHAIN_EXEMPT_SHARE = 0.1;
export const LN_TAP_GATE_CHAIN_EXEMPT_LONG_SHARE = 0.15;

/**
 * The rating tiebreak (dan/ln-identity.ts) needs the chart's heaviest
 * sections to hold a finger down. A finger is pinned for the part of a hold
 * past the longest ordinary tap (TAP_MEDIAN_MAX_MS) and before the release
 * window; per 10s window, the pinned share is the time any finger is pinned
 * and the under-hold share is the notes struck while another column is
 * pinned. A chart whose window at LN_HELD_PEAK_QUANTILE stays under both
 * lines plays as rice with hold notation, however its rating compares to
 * Overall. Same-lane chains as written (at 1.0x) on a tenth of its notes
 * (LN_TAP_GATE_CHAIN_EXEMPT_SHARE) exempt it: inverse pins nothing and is LN
 * by its releases.
 *
 * Fitted 2026-10-02 on hand-labeled charts. Every LN label at 1.5x reads 0.19
 * pinned or more and 0.09 under hold or more (the ninth-decile window);
 * a 185 bpm jumpstream chart with 1/16 and 1/8 holds labeled rice at 1.5x
 * reads 0.13 and 0.07 there, against 0.45 and 0.61 at 1.0x. Over
 * the 12,278 cached 4K charts past the hold line it returns to rice 9 of 541
 * tiebreak LN charts at 1.0x, 14 of 136 at 1.5x and none at 0.75x, and no
 * labeled LN play.
 */
export const LN_HELD_PEAK_QUANTILE = 0.9;
export const LN_HELD_PEAK_MIN_PINNED_SHARE = 0.15;
export const LN_HELD_PEAK_MIN_UNDER_HOLD_SHARE = 0.08;

/**
 * "Is this chart LN", for every identity consumer. On 4K a stored effective
 * share adds its gate after the hold-share line; other keymodes and unswept
 * rows use the hold gate alone, since a fallback hold share compared against
 * the lower effective line would promote charts neither rule calls LN. Null
 * when nothing is known about the chart's holds.
 */
export function chartIsLn(
  keyCount: number | null | undefined,
  shares: { lnRatio: number | null | undefined; lnEffectiveRatio?: number | null | undefined },
): boolean | null {
  const share = chartLnShareFor(keyCount, shares);
  if (share == null) return null;
  const onEffective = keyCount != null && LN_EFFECTIVE_KEY_COUNTS.has(keyCount)
    && shares.lnEffectiveRatio != null && Number.isFinite(Number(shares.lnEffectiveRatio));
  if (!onEffective) return share >= lnPrimaryMinRatioFor(keyCount);
  const holdShare = shares.lnRatio == null ? Number.NaN : Number(shares.lnRatio);
  if (!Number.isFinite(holdShare)) return null;
  return Math.max(0, Math.min(1, holdShare)) >= lnPrimaryMinRatioFor(keyCount) && share >= LN_EFFECTIVE_MIN_RATIO;
}

/** The ScoreV2-style release 300 window at an OD, in ms. */
export function releaseGreatWindowMs(od: number | null | undefined): number {
  const clamped = od != null && Number.isFinite(Number(od)) ? Math.max(0, Math.min(10, Number(od))) : ASSUMED_OD;
  return RELEASE_WINDOW_MULTIPLIER * (GREAT_WINDOW_BASE_MS - OD_WINDOW_STEP_MS * clamped);
}

/** The effective share on keymodes that use it, the hold share otherwise.
 * For display; identity callers use chartIsLn so the hold gate applies. */
export function chartLnShareFor(
  keyCount: number | null | undefined,
  shares: { lnRatio: number | null | undefined; lnEffectiveRatio?: number | null | undefined },
): number | null {
  const effective = shares.lnEffectiveRatio == null ? Number.NaN : Number(shares.lnEffectiveRatio);
  if (keyCount != null && LN_EFFECTIVE_KEY_COUNTS.has(keyCount) && Number.isFinite(effective)) {
    return Math.max(0, Math.min(1, effective));
  }
  const raw = shares.lnRatio == null ? Number.NaN : Number(shares.lnRatio);
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : null;
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const playedRate = (rate: number | undefined) => Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1;

type HoldKind = "short" | "shortSpanning" | "long" | "chained";
interface HoldVerdict {
  kind: HoldKind;
  effective: boolean;
  /** In a same-lane release/repress chain, whether or not it is also long. */
  inChain: boolean;
}

/** LN vibro at the played rate: dense staggered hold spam. Its same-lane
 * chains are a shake, not release work, so they never form. */
export function isLnVibroChart(notes: EffectiveLnNote[], options: EffectiveLnOptions): boolean {
  const keyCount = options.keyCount ?? notes.reduce((max, note) => Math.max(max, note.column + 1), 0);
  return detectLnVibro({ keyCount, notes } as unknown as ManiaBeatmap, playedRate(options.rate));
}

/** The notes in time order, overall and per column, shared by every reading of one chart. */
interface SortedChart {
  notes: EffectiveLnNote[];
  order: number[];
  lanes: number[][];
}

function sortChart(notes: EffectiveLnNote[]): SortedChart {
  const order = notes.map((_, index) => index).sort((a, b) => notes[a].time - notes[b].time);
  const lanes = new Map<number, number[]>();
  for (const index of order) {
    const lane = lanes.get(notes[index].column);
    if (lane) lane.push(index);
    else lanes.set(notes[index].column, [index]);
  }
  return { notes, order, lanes: [...lanes.values()] };
}

function judgeHolds({ notes, order, lanes }: SortedChart, rate: number, windowMs: number, lnVibro: boolean): Array<HoldVerdict | null> {
  const tolerance = LN_SAME_MOTION_TOLERANCE_MS;
  // Near-window holds in a recurring same-lane chain (two links, three heads)
  // have little recovery before rearticulation. Bodies more than one
  // tolerance inside the window stay free however they are chained.
  const chained = new Set<number>();
  for (const lane of lnVibro ? [] : lanes) {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) for (const index of run) chained.add(index);
      run = [];
    };
    for (let i = 0; i + 1 < lane.length; i += 1) {
      const note = notes[lane[i]], next = notes[lane[i + 1]];
      const duration = (note.endTime - note.time) / rate;
      const gap = (next.time - note.endTime) / rate;
      if (note.isHold && next.isHold && next.endTime > next.time
        && duration >= windowMs - tolerance && duration > 0
        && gap >= 0 && gap <= windowMs) run.push(lane[i]);
      else flush();
    }
    flush();
  }
  const headTimes = order.map((index) => notes[index].time / rate);
  const verdict = (kind: HoldKind, inChain: boolean): HoldVerdict => ({ kind, effective: kind === "long" || kind === "chained", inChain });
  return notes.map((note, index) => {
    if (!note.isHold || !(note.endTime > note.time)) return null;
    const start = note.time / rate, end = note.endTime / rate;
    const inChain = chained.has(index);
    if (end - start > windowMs) return verdict("long", inChain);
    if (inChain) return verdict("chained", inChain);
    // Another column's head strictly inside the body.
    for (let i = lowerBound(headTimes, start + tolerance); i < headTimes.length && headTimes[i] < end - tolerance; i += 1) {
      if (notes[order[i]].column !== note.column) return verdict("shortSpanning", inChain);
    }
    return verdict("short", inChain);
  });
}

// Abramowitz-Stegun 7.1.26, within 1.5e-7.
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** Chance an ordinary tap is too short to release a hold of this body inside
 * the window: the tap would have to last at least body - window. `gapMs` is the
 * time until the same column's next head. */
function tapShortfallChance(bodyMs: number, gapMs: number, windowMs: number): number {
  const needed = bodyMs - windowMs;
  if (!(needed > 0)) return 0;
  const median = Math.min(TAP_MEDIAN_MAX_MS, TAP_MEDIAN_BASE_MS + TAP_MEDIAN_PER_GAP * gapMs);
  const chance = 0.5 * (1 + erf(Math.log(needed / median) / (TAP_LOG_SPREAD * Math.SQRT2)));
  // Past a thousandth either way the answer is certain; keep it exact.
  return chance > 0.999 ? 1 : chance < 0.001 ? 0 : chance;
}

function tapChances({ notes, lanes }: SortedChart, rate: number, windowMs: number): number[] {
  const chances = new Array<number>(notes.length).fill(0);
  for (const lane of lanes) {
    lane.forEach((index, at) => {
      const note = notes[index];
      if (!note.isHold || !(note.endTime > note.time)) return;
      const nextHead = at + 1 < lane.length ? notes[lane[at + 1]].time : Infinity;
      chances[index] = tapShortfallChance((note.endTime - note.time) / rate, (nextHead - note.time) / rate, windowMs);
    });
  }
  return chances;
}

/**
 * Index-aligned with `notes`: for each hold, the chance an ordinary tap is too
 * short to release it inside the release window at the played OD (or
 * `windowMs` when given); 0 for taps.
 */
export function tapShortfallChances(notes: EffectiveLnNote[], options: EffectiveLnOptions & { windowMs?: number } = {}): number[] {
  return tapChances(sortChart(notes), playedRate(options.rate), options.windowMs ?? releaseGreatWindowMs(options.od));
}

/** See LN_HELD_PEAK_QUANTILE. */
function heldPeak({ notes, lanes }: SortedChart, rate: number, windowMs: number): { pinned: number; underHold: number } {
  const pins = lanes.map((lane) => {
    const spans: Array<[number, number]> = [];
    for (const index of lane) {
      const note = notes[index];
      if (!note.isHold) continue;
      const start = note.time / rate + TAP_MEDIAN_MAX_MS, end = note.endTime / rate - windowMs;
      if (end > start) spans.push([start, end]);
    }
    return { column: notes[lane[0]].column, spans };
  });
  const pinnedAt = (spans: Array<[number, number]>, time: number) => {
    let lo = 0, hi = spans.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid][0] <= time) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at >= 0 && time < spans[at][1];
  };
  let first = Infinity, last = -Infinity;
  for (const note of notes) {
    first = Math.min(first, note.time / rate);
    last = Math.max(last, (note.isHold && note.endTime > note.time ? note.endTime : note.time) / rate);
  }
  const slots = new Map<number, { notes: number; under: number; pinnedMs: number }>();
  const slot = (key: number) => {
    let window = slots.get(key);
    if (!window) slots.set(key, window = { notes: 0, under: 0, pinnedMs: 0 });
    return window;
  };
  for (const note of notes) {
    const window = slot(Math.floor((note.time / rate - first) / WINDOW_MS));
    window.notes += 1;
    if (pins.some((pin) => pin.column !== note.column && pinnedAt(pin.spans, note.time / rate))) window.under += 1;
  }
  // Time with any finger pinned: the union of every lane's spans, split by window.
  const merged = pins.flatMap((pin) => pin.spans).sort((a, b) => a[0] - b[0]);
  let runStart = -Infinity, runEnd = -Infinity;
  const addPinned = (start: number, end: number) => {
    for (let key = Math.floor((start - first) / WINDOW_MS); first + key * WINDOW_MS < end; key += 1) {
      const from = Math.max(start, first + key * WINDOW_MS), to = Math.min(end, first + (key + 1) * WINDOW_MS);
      if (to > from) slot(key).pinnedMs += to - from;
    }
  };
  for (const [start, end] of merged) {
    if (start > runEnd) {
      if (runEnd > runStart) addPinned(runStart, runEnd);
      runStart = start;
      runEnd = end;
    } else runEnd = Math.max(runEnd, end);
  }
  if (runEnd > runStart) addPinned(runStart, runEnd);
  const windows = [...slots.entries()].filter(([, window]) => window.notes >= WINDOW_MIN_NOTES).map(([key, window]) => ({
    pinned: window.pinnedMs / Math.max(1, Math.min(WINDOW_MS, last - (first + key * WINDOW_MS))),
    underHold: window.under / window.notes,
  }));
  const quantile = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * LN_HELD_PEAK_QUANTILE)];
  };
  return { pinned: quantile(windows.map((window) => window.pinned)), underHold: quantile(windows.map((window) => window.underHold)) };
}

function weightedMedian(entries: Array<{ share: number; weight: number }>): number | null {
  const sorted = [...entries].sort((a, b) => a.share - b.share);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return null;
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative * 2 >= total) return entry.share;
  }
  return null;
}

/** Per 10s window: the long share, or the release-work share (long plus
 * chained) scaled from its 0.6 line onto the 0.4 line, whichever is higher.
 * A tap-covered chart keeps only the chain reading: same-lane release/repress
 * stays LN however short its bodies (inverse plays as LN), while long
 * bodies a tap covers establish nothing. */
function identityShare(window: { notes: number; long: number; chained: number; inChain: number }, tapCovered: boolean): number {
  if (!(window.notes > 0)) return 0;
  const scale = LN_EFFECTIVE_MIN_RATIO / LN_CHAINED_MIN_RATIO;
  if (tapCovered) return (window.inChain / window.notes) * scale;
  return Math.max(window.long / window.notes, ((window.long + window.chained) / window.notes) * scale);
}

function analyzeSorted(chart: SortedChart, options: EffectiveLnOptions, played: Array<HoldVerdict | null>, lnVibro: boolean): EffectiveLnAnalysis {
  const { notes } = chart;
  const rate = playedRate(options.rate), total = notes.length;
  const kinds: Record<HoldKind, number> = { short: 0, shortSpanning: 0, long: 0, chained: 0 };
  for (const verdict of played) if (verdict) kinds[verdict.kind] += 1;
  const holds = kinds.short + kinds.shortSpanning + kinds.long + kinds.chained;
  const effectiveHolds = kinds.long + kinds.chained;

  // Identity judges the same holds at no less than LN_IDENTITY_MIN_OD; the
  // counts above stay at the played OD for the rating and the tail pass.
  const playedOd = options.od != null && Number.isFinite(Number(options.od)) ? Number(options.od) : null;
  const identityOd = playedOd != null && playedOd < LN_IDENTITY_MIN_OD ? LN_IDENTITY_MIN_OD : options.od;
  const identityWindow = releaseGreatWindowMs(identityOd);
  const identity = identityOd === options.od ? played : judgeHolds(chart, rate, identityWindow, lnVibro);
  const tracked = tapChances(chart, rate, identityWindow);

  const whole = { notes: total, long: 0, chained: 0, inChain: 0, tracked: 0 };
  const slots = new Map<number, typeof whole>();
  const firstTime = notes.reduce((first, note) => Math.min(first, note.time / rate), Infinity);
  notes.forEach((note, index) => {
    const slot = Math.floor((note.time / rate - firstTime) / WINDOW_MS);
    let window = slots.get(slot);
    if (!window) slots.set(slot, window = { notes: 0, long: 0, chained: 0, inChain: 0, tracked: 0 });
    const verdict = identity[index];
    window.notes += 1;
    window.tracked += tracked[index];
    whole.tracked += tracked[index];
    if (verdict?.inChain) { window.inChain += 1; whole.inChain += 1; }
    if (verdict?.kind === "long") { window.long += 1; whole.long += 1; }
    else if (verdict?.kind === "chained") { window.chained += 1; whole.chained += 1; }
  });
  const windows = [...slots.values()].filter((window) => window.notes >= WINDOW_MIN_NOTES);
  const byNotes = weightedMedian(windows.map((window) => ({ share: window.tracked / window.notes, weight: window.notes })));
  const byTime = weightedMedian(windows.map((window) => ({ share: window.tracked / window.notes, weight: 1 })));
  const trackedShare = byNotes == null || byTime == null
    ? (total > 0 ? whole.tracked / total : 0)
    : Math.max(byNotes, byTime);
  const chainExempt = whole.chained / total >= LN_TAP_GATE_CHAIN_EXEMPT_SHARE && whole.long / total >= LN_TAP_GATE_CHAIN_EXEMPT_LONG_SHARE;
  const tapCovered = total > 0 && trackedShare < LN_TRACKED_MIN_SHARE && !chainExempt;
  const effectiveLnRatio = weightedMedian(windows.map((window) => ({ share: identityShare(window, tapCovered), weight: window.notes })))
    ?? identityShare(whole, tapCovered);
  const peak = heldPeak(chart, rate, identityWindow);
  let heldPeakLight = peak.pinned < LN_HELD_PEAK_MIN_PINNED_SHARE && peak.underHold < LN_HELD_PEAK_MIN_UNDER_HOLD_SHARE;
  if (heldPeakLight && total > 0) {
    // Chains as written: a rate mod does not write inverse (see EffectiveHolds.weights).
    const written = rate === 1 ? identity : judgeHolds(chart, 1, identityWindow, isLnVibroChart(notes, { ...options, rate: 1 }));
    const writtenChained = written.reduce((count, verdict) => count + (verdict?.kind === "chained" ? 1 : 0), 0);
    if (writtenChained / total >= LN_TAP_GATE_CHAIN_EXEMPT_SHARE) heldPeakLight = false;
  }

  return {
    notes: total,
    holds,
    effectiveHolds,
    holdRatio: total > 0 ? holds / total : 0,
    effectiveHoldRatio: total > 0 ? effectiveHolds / total : 0,
    effectiveLnRatio,
    shortTails: kinds.short,
    shortSpanning: kinds.shortSpanning,
    longTails: kinds.long,
    chainedShortHolds: kinds.chained,
    identityWorkShare: holds > 0 ? (whole.long + whole.chained) / holds : 0,
    trackedShare,
    tapCovered,
    heldPeakPinned: peak.pinned,
    heldPeakUnderHold: peak.underHold,
    heldPeakLight,
    lnVibro,
  };
}

export function analyzeEffectiveLn(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}): EffectiveLnAnalysis {
  return readEffectiveHolds(notes, options, { weights: false }).analysis;
}

export interface EffectiveHolds {
  analysis: EffectiveLnAnalysis;
  /** Index-aligned with the notes: true for a hold that demands a release. */
  mask: boolean[];
  /**
   * Index-aligned with the notes: how much of a hold's release work the LN
   * rating prices. 0 for taps and free holds; 1 for a hold in a same-lane
   * chain as the chart is written (at 1.0x), whose release and repress are
   * the work however short the body (inverse); for any other effective hold,
   * the chance an ordinary tap cannot release it in time at the played rate.
   *
   * Chains read at 1.0x because a rate mod does not write inverse: at 1.5x a
   * chart's same-lane gaps shrink under the window and ordinary holds would
   * price as full chains, a jump the players do not show. On the same
   * player's 1.0x and DT plays of 21 charts (8 or more players each), LN's
   * rise tracks native Overall's per chart within 0.064 (median, log) this
   * way, against 0.086 when chains were read at the played rate (2026-09-29).
   */
  weights: number[];
}

/** One pass over a chart's holds: the identity analysis, the effective mask
 * and the rating's hold weights (skipped with `weights: false`). */
export function readEffectiveHolds(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}, want = { weights: true }): EffectiveHolds {
  const chart = sortChart(notes);
  const rate = playedRate(options.rate), window = releaseGreatWindowMs(options.od);
  const lnVibro = isLnVibroChart(notes, options);
  const played = judgeHolds(chart, rate, window, lnVibro);
  const analysis = analyzeSorted(chart, options, played, lnVibro);
  const mask = played.map((verdict) => verdict?.effective === true);
  if (!want.weights) return { analysis, mask, weights: [] };
  const written = rate === 1 ? played : judgeHolds(chart, 1, window, isLnVibroChart(notes, { ...options, rate: 1 }));
  const chances = tapChances(chart, rate, window);
  return { analysis, mask, weights: played.map((verdict, index) => !verdict?.effective ? 0 : written[index]?.inChain ? 1 : chances[index]) };
}

/** Index-aligned with `notes`: true for a hold that demands a release. */
export function effectiveHoldMask(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}): boolean[] {
  return readEffectiveHolds(notes, options, { weights: false }).mask;
}

/** Index-aligned with `notes`: see EffectiveHolds.weights. */
export function effectiveHoldWeights(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}): number[] {
  return readEffectiveHolds(notes, options).weights;
}

/**
 * The .osu a tail-aware calc pass should rate, or null when the pass would
 * add nothing. On keymodes with the effective share the free holds are
 * demoted first, so the pass sees only the releases that are work, and the
 * 45% hold line applies; other keymodes keep the full pass above
 * `minHoldRatio` (LN_TAIL_MIN_RATIO in dan/msd.ts, passed in so this module
 * stays free of backend imports).
 */
export function lnTailPassText(
  osuText: string,
  keyCount: number,
  options: EffectiveLnOptions & { minHoldRatio: number },
): string | null {
  const parsed = parseHitObjects(osuText);
  if (!parsed) return null;
  if (!LN_EFFECTIVE_KEY_COUNTS.has(keyCount)) {
    const holds = parsed.objects.filter((object) => object.note.isHold).length;
    return holds / Math.max(1, parsed.objects.length) > options.minHoldRatio ? osuText : null;
  }
  const { analysis, mask } = readEffectiveHolds(parsed.objects.map((object) => object.note), { ...options, od: options.od ?? parsed.od }, { weights: false });
  if (analysis.holdRatio < lnPrimaryMinRatioFor(keyCount) || !(analysis.effectiveHoldRatio > options.minHoldRatio)) return null;
  return rewriteFreeHolds(parsed, mask);
}

interface HitObjectLine {
  index: number;
  x: number;
  y: number;
  time: number;
  type: number;
  hitSound: number;
  extras: string;
  note: EffectiveLnNote;
}

interface ParsedHitObjects {
  lines: string[];
  objects: HitObjectLine[];
  od: number | null;
}

function parseHitObjects(osuText: string): ParsedHitObjects | null {
  const lines = osuText.split("\n");
  const keyCount = Math.max(1, Math.round(Number(/^CircleSize\s*:\s*([\d.]+)/m.exec(osuText)?.[1] ?? 4)) || 4);
  const odMatch = /^OverallDifficulty\s*:\s*([\d.]+)/m.exec(osuText);
  const od = odMatch ? Number(odMatch[1]) : null;
  const start = lines.findIndex((line) => line.trim() === "[HitObjects]");
  if (start < 0) return null;
  const objects: HitObjectLine[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (raw.startsWith("[")) break;
    if (!raw || raw.startsWith("//")) continue;
    const parts = raw.split(",");
    if (parts.length < 5) continue;
    const [x, y, time, type, hitSound] = parts.slice(0, 5).map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type)) continue;
    const extras = parts.slice(5).join(",");
    const endTime = (type & 128) !== 0 ? Number(extras.split(":")[0]) : Number.NaN;
    const isHold = Number.isFinite(endTime) && endTime > time;
    objects.push({ index, x, y, time, type, hitSound, extras, note: {
      column: Math.max(0, Math.min(keyCount - 1, Math.floor((x * keyCount) / 512))),
      time,
      endTime: Number.isFinite(endTime) ? endTime : time,
      isHold,
    } });
  }
  return { lines, objects, od: Number.isFinite(od) ? od : null };
}

function rewriteFreeHolds({ lines, objects }: ParsedHitObjects, mask: boolean[]): string {
  objects.forEach((object, i) => {
    if (!object.note.isHold || mask[i]) return;
    const sample = object.extras.includes(":") ? object.extras.slice(object.extras.indexOf(":") + 1) : "0:0:0:0:";
    lines[object.index] = `${object.x},${object.y},${object.time},${(object.type & ~128) | 1},${object.hitSound},${sample}`;
  });
  return lines.join("\n");
}

/**
 * The chart as it plays: every hold that demands no release rewritten as a
 * plain note, so a tail-aware calc pass sees only the releases that are work.
 * Keymode comes from CircleSize and OD from OverallDifficulty unless the
 * caller supplies one.
 */
export function demoteFreeHolds(osuText: string, options: EffectiveLnOptions = {}): string {
  const parsed = parseHitObjects(osuText);
  if (!parsed) return osuText;
  const notes = parsed.objects.map((object) => object.note);
  return rewriteFreeHolds(parsed, readEffectiveHolds(notes, { ...options, od: options.od ?? parsed.od }, { weights: false }).mask);
}
