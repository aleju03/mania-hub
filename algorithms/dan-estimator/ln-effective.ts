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
  rate?: number;
  od?: number | null;
  keyCount?: number;
}

export interface EffectiveLnAnalysis {
  notes: number;
  holds: number;
  effectiveHolds: number;
  holdRatio: number;
  effectiveHoldRatio: number;
  effectiveLnRatio: number;
  shortTails: number;
  shortSpanning: number;
  longTails: number;
  chainedShortHolds: number;
  identityWorkShare: number;
  trackedShare: number;
  tapCovered: boolean;
  heldPeakPinned: number;
  heldPeakUnderHold: number;
  heldPeakLight: boolean;
  lnVibro: boolean;
}

const RELEASE_WINDOW_MULTIPLIER = 1.5;
const GREAT_WINDOW_BASE_MS = 64;
const OD_WINDOW_STEP_MS = 3;
const ASSUMED_OD = 8;

export const LN_IDENTITY_MIN_OD = 5;

export const LN_MIN_WORK_SHARE = 0.1;

export const LN_SAME_MOTION_TOLERANCE_MS = 20;
const WINDOW_MS = 10_000;

const WINDOW_MIN_NOTES = 8;

export const LN_EFFECTIVE_KEY_COUNTS: ReadonlySet<number> = new Set([4]);

export const LN_EFFECTIVE_MODEL_VERSION = 15;

export const LN_EFFECTIVE_MIN_RATIO = 0.4;

export const LN_CHAINED_MIN_RATIO = 0.6;

const TAP_MEDIAN_BASE_MS = 36;
const TAP_MEDIAN_PER_GAP = 0.213;
const TAP_MEDIAN_MAX_MS = 80;
const TAP_LOG_SPREAD = 0.29;

export const LN_TRACKED_MIN_SHARE = 0.1;

export const LN_TAP_GATE_CHAIN_EXEMPT_SHARE = 0.1;
export const LN_TAP_GATE_CHAIN_EXEMPT_LONG_SHARE = 0.15;

export const LN_HELD_PEAK_QUANTILE = 0.9;
export const LN_HELD_PEAK_MIN_PINNED_SHARE = 0.15;
export const LN_HELD_PEAK_MIN_UNDER_HOLD_SHARE = 0.08;

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

export function releaseGreatWindowMs(od: number | null | undefined): number {
  const clamped = od != null && Number.isFinite(Number(od)) ? Math.max(0, Math.min(10, Number(od))) : ASSUMED_OD;
  return RELEASE_WINDOW_MULTIPLIER * (GREAT_WINDOW_BASE_MS - OD_WINDOW_STEP_MS * clamped);
}

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
  inChain: boolean;
}

export function isLnVibroChart(notes: EffectiveLnNote[], options: EffectiveLnOptions): boolean {
  const keyCount = options.keyCount ?? notes.reduce((max, note) => Math.max(max, note.column + 1), 0);
  return detectLnVibro({ keyCount, notes } as unknown as ManiaBeatmap, playedRate(options.rate));
}

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
    for (let i = lowerBound(headTimes, start + tolerance); i < headTimes.length && headTimes[i] < end - tolerance; i += 1) {
      if (notes[order[i]].column !== note.column) return verdict("shortSpanning", inChain);
    }
    return verdict("short", inChain);
  });
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function tapShortfallChance(bodyMs: number, gapMs: number, windowMs: number): number {
  const needed = bodyMs - windowMs;
  if (!(needed > 0)) return 0;
  const median = Math.min(TAP_MEDIAN_MAX_MS, TAP_MEDIAN_BASE_MS + TAP_MEDIAN_PER_GAP * gapMs);
  const chance = 0.5 * (1 + erf(Math.log(needed / median) / (TAP_LOG_SPREAD * Math.SQRT2)));
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

export function tapShortfallChances(notes: EffectiveLnNote[], options: EffectiveLnOptions & { windowMs?: number } = {}): number[] {
  return tapChances(sortChart(notes), playedRate(options.rate), options.windowMs ?? releaseGreatWindowMs(options.od));
}

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
  mask: boolean[];
  weights: number[];
}

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

export function effectiveHoldMask(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}): boolean[] {
  return readEffectiveHolds(notes, options, { weights: false }).mask;
}

export function effectiveHoldWeights(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}): number[] {
  return readEffectiveHolds(notes, options).weights;
}

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

export function demoteFreeHolds(osuText: string, options: EffectiveLnOptions = {}): string {
  const parsed = parseHitObjects(osuText);
  if (!parsed) return osuText;
  const notes = parsed.objects.map((object) => object.note);
  return rewriteFreeHolds(parsed, readEffectiveHolds(notes, { ...options, od: options.od ?? parsed.od }, { weights: false }).mask);
}
