/**
 * Effective LN share, the part of a chart that demands a release.
 *
 * A hold is work when its played duration exceeds the OD-dependent release
 * 300 window, or when it sits in a same-lane release/repress chain of three
 * or more near-window holds. Durations and gaps are at the played rate.
 *
 * Identity reads each 10 s window two ways and keeps the higher. One is the
 * share of long holds against a 40% line. The other is the share of all
 * release work against a 60% line scaled onto 0.40, which catches dense
 * inverse whose bodies all sit under the window. The chart share is the
 * note-weighted median of the windows. On 4K this is a second gate after the
 * 45% hold line, so it can demote an LN chart and never promote one.
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
  /** Chart OD; null/undefined falls back to OD 8. */
  od?: number | null;
  /** Column count, for the LN vibro check; derived from the notes when absent. */
  keyCount?: number;
}

export interface EffectiveLnAnalysis {
  notes: number;
  holds: number;
  effectiveHolds: number;
  /** Plain hold share (holds over all notes). */
  holdRatio: number;
  /** Effective holds over all notes, chart-wide. Gates the tail-aware MinaCalc pass. */
  effectiveHoldRatio: number;
  /** Note-weighted median of the per-window identity share. The second 4K LN identity gate. */
  effectiveLnRatio: number;
  /** Tap-covered holds without another column's head inside. Not effective. */
  shortTails: number;
  /** Tap-covered holds spanning another column's head. Reported only. */
  shortSpanning: number;
  /** Holds longer than the release window. */
  longTails: number;
  /** Near-window short holds in a recurring same-lane release/repress chain. */
  chainedShortHolds: number;
  /** Share of holds that are long or chained at the identity OD. */
  identityWorkShare: number;
  /** The chart is LN vibro at this rate. Its chains are not counted. */
  lnVibro: boolean;
}

/**
 * Identity never reads an OD under this. The release window widens as OD
 * falls, so most 1/8 holds on a low-OD file would count as free. Only
 * identity uses the floor. The LN rating, tail pass and effective-hold
 * counts keep the played OD.
 */
export const LN_IDENTITY_MIN_OD = 5;

/**
 * Share of a chart's holds that must be long or chained at the identity OD
 * before it gets an LN number or the hybrid badge. Real hybrids sit at 0.68
 * or above. Charts under 0.1 are vibro.
 */
export const LN_MIN_WORK_SHARE = 0.1;

/**
 * A head this close to a hold's head or release belongs to the same chord.
 */
export const LN_SAME_MOTION_TOLERANCE_MS = 20;

/** Keymodes whose LN identity adds the effective-share gate. 7K keeps its
 * hold-share line until its courses are measured against this model. */
export const LN_EFFECTIVE_KEY_COUNTS: ReadonlySet<number> = new Set([4]);

/**
 * The effective share at which a 4K chart's identity is LN. A median of
 * window shares sits on a different scale from the 0.45 hold line. Charts
 * players call LN read 0.415 to 0.476, and full-LN charts with tap-covered
 * tails read 0.30 and below.
 */
export const LN_EFFECTIVE_MIN_RATIO = 0.4;

/**
 * Share of a window's notes that must be release work for the window to
 * read LN when its bodies are tap-covered. Scaled onto the 0.4 line so one
 * stored share answers both readings. Sits between a 1/4-held jumpstream
 * chart at 1.5x (0.53) and a 264 BPM LN chart (0.66).
 */
export const LN_CHAINED_MIN_RATIO = 0.6;

// ScoreV2 (and lazer's split-tail judgement) gives releases windows 1.5x the
// head's; the head 300 window is 64 ms less 3 ms per OD point.
const RELEASE_WINDOW_MULTIPLIER = 1.5;
const GREAT_WINDOW_BASE_MS = 64;
const OD_WINDOW_STEP_MS = 3;
const ASSUMED_OD = 8;
const WINDOW_MS = 10_000;
/** Windows with fewer notes are breaks and carry no LN verdict either way. */
const WINDOW_MIN_NOTES = 8;

/**
 * The line an effective share is compared against for a keymode. Identity
 * checks go through `chartIsLn`, which also applies the hold gate.
 */
export function lnIdentityMinRatioFor(keyCount: number | null | undefined): number {
  return keyCount != null && LN_EFFECTIVE_KEY_COUNTS.has(keyCount)
    ? LN_EFFECTIVE_MIN_RATIO
    : lnPrimaryMinRatioFor(keyCount);
}

/**
 * Whether a chart is LN. On 4K with an effective share it needs both the
 * hold line and the effective line. Otherwise the hold share answers to the
 * hold line alone. Null when nothing is known about the chart's holds.
 */
export function chartIsLn(
  keyCount: number | null | undefined,
  shares: { lnRatio: number | null | undefined; lnEffectiveRatio?: number | null | undefined },
): boolean | null {
  const share = chartLnShareFor(keyCount, shares);
  if (share == null) return null;
  const onEffective = keyCount != null
    && LN_EFFECTIVE_KEY_COUNTS.has(keyCount)
    && shares.lnEffectiveRatio != null
    && Number.isFinite(Number(shares.lnEffectiveRatio));
  if (!onEffective) return share >= lnPrimaryMinRatioFor(keyCount);
  const rawHoldShare = shares.lnRatio == null ? Number.NaN : Number(shares.lnRatio);
  if (!Number.isFinite(rawHoldShare)) return null;
  const holdShare = Math.max(0, Math.min(1, rawHoldShare));
  return holdShare >= lnPrimaryMinRatioFor(keyCount) && share >= LN_EFFECTIVE_MIN_RATIO;
}

/** The ScoreV2-style release 300 window at an OD, in ms: 1.5 * (64 - 3 * OD). */
export function releaseGreatWindowMs(od: number | null | undefined): number {
  const clamped = od != null && Number.isFinite(Number(od)) ? Math.max(0, Math.min(10, Number(od))) : ASSUMED_OD;
  return RELEASE_WINDOW_MULTIPLIER * (GREAT_WINDOW_BASE_MS - OD_WINDOW_STEP_MS * clamped);
}

/**
 * The effective share on keymodes that use it, the plain hold share
 * otherwise. For display. Identity goes through chartIsLn so the 4K hold
 * gate cannot be skipped.
 */
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

/** LN vibro at the played rate. Its same-lane chains never count as
 * release work. */
export function isLnVibroChart(notes: EffectiveLnNote[], options: EffectiveLnOptions): boolean {
  const rate = Number.isFinite(Number(options.rate)) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const keyCount = options.keyCount ?? notes.reduce((max, note) => Math.max(max, note.column + 1), 0);
  return detectLnVibro({ keyCount, notes } as unknown as ManiaBeatmap, rate);
}

/** Index-aligned with `notes`: true for a hold that demands a release. */
export function effectiveHoldMask(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}): boolean[] {
  return judgeHolds(notes, options).map((verdict) => verdict?.effective === true);
}

export function analyzeEffectiveLn(notes: EffectiveLnNote[], options: EffectiveLnOptions = {}): EffectiveLnAnalysis {
  const rate = Number.isFinite(Number(options.rate)) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const verdicts = judgeHolds(notes, options);
  const counts = { holds: 0, effectiveHolds: 0, shortTails: 0, shortSpanning: 0, longTails: 0, chainedShortHolds: 0 };
  for (const verdict of verdicts) {
    if (!verdict) continue;
    counts.holds += 1;
    if (verdict.effective) counts.effectiveHolds += 1;
    if (verdict.reason === "short") counts.shortTails += 1;
    else if (verdict.reason === "shortSpanning") counts.shortSpanning += 1;
    else if (verdict.reason === "chained") counts.chainedShortHolds += 1;
    else counts.longTails += 1;
  }
  const total = notes.length;
  const holdRatio = total > 0 ? counts.holds / total : 0;
  const effectiveHoldRatio = total > 0 ? counts.effectiveHolds / total : 0;

  // Identity judges holds at LN_IDENTITY_MIN_OD or higher. The counts above
  // keep the played OD.
  const playedOd = options.od != null && Number.isFinite(Number(options.od)) ? Number(options.od) : null;
  const identityVerdicts = playedOd != null && playedOd < LN_IDENTITY_MIN_OD
    ? judgeHolds(notes, { ...options, od: LN_IDENTITY_MIN_OD })
    : verdicts;
  const identityCounts = { long: 0, chained: 0 };
  for (const verdict of identityVerdicts) {
    if (verdict?.reason === "long") identityCounts.long += 1;
    else if (verdict?.reason === "chained") identityCounts.chained += 1;
  }
  const identityWorkShare = counts.holds > 0 ? (identityCounts.long + identityCounts.chained) / counts.holds : 0;

  // With no window of 8+ notes the chart-wide reading stands.
  const identityShare = (long: number, chained: number, count: number) => count > 0
    ? Math.max(long / count, ((long + chained) / count) * (LN_EFFECTIVE_MIN_RATIO / LN_CHAINED_MIN_RATIO))
    : 0;
  let effectiveLnRatio = identityShare(identityCounts.long, identityCounts.chained, total);
  if (total > 0) {
    const firstTime = notes.reduce((first, note) => Math.min(first, note.time / rate), Infinity);
    const windows = new Map<number, { notes: number; long: number; chained: number }>();
    notes.forEach((note, index) => {
      const slot = Math.floor((note.time / rate - firstTime) / WINDOW_MS);
      const window = windows.get(slot) ?? { notes: 0, long: 0, chained: 0 };
      window.notes += 1;
      if (identityVerdicts[index]?.reason === "long") window.long += 1;
      else if (identityVerdicts[index]?.reason === "chained") window.chained += 1;
      windows.set(slot, window);
    });
    const shares = [...windows.values()]
      .filter((window) => window.notes >= WINDOW_MIN_NOTES)
      .map((window) => ({ share: identityShare(window.long, window.chained, window.notes), weight: window.notes }))
      .sort((a, b) => a.share - b.share);
    const weightTotal = shares.reduce((sum, entry) => sum + entry.weight, 0);
    if (weightTotal > 0) {
      let cumulative = 0;
      for (const entry of shares) {
        cumulative += entry.weight;
        if (cumulative * 2 >= weightTotal) {
          effectiveLnRatio = entry.share;
          break;
        }
      }
    }
  }

  return {
    notes: total,
    holds: counts.holds,
    effectiveHolds: counts.effectiveHolds,
    holdRatio,
    effectiveHoldRatio,
    effectiveLnRatio,
    shortTails: counts.shortTails,
    shortSpanning: counts.shortSpanning,
    longTails: counts.longTails,
    chainedShortHolds: counts.chainedShortHolds,
    identityWorkShare,
    lnVibro: isLnVibroChart(notes, options),
  };
}

/**
 * The .osu text a tail-aware MinaCalc pass should rate, or null to skip the
 * pass. `minHoldRatio` is LN_TAIL_MIN_RATIO from ../msd/msd. On 4K free
 * holds become plain notes first and the stricter 45% identity line applies.
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
  const od = options.od ?? parsed.od;
  const analysis = analyzeEffectiveLn(parsed.objects.map((object) => object.note), { ...options, od });
  if (analysis.holdRatio < lnPrimaryMinRatioFor(keyCount)) return null;
  if (!(analysis.effectiveHoldRatio > options.minHoldRatio)) return null;
  return rewriteFreeHolds(parsed, { ...options, od });
}

/**
 * The chart with every hold that demands no release rewritten as a plain
 * note. OD comes from the file unless the caller passes one.
 */
export function demoteFreeHolds(osuText: string, options: EffectiveLnOptions = {}): string {
  const parsed = parseHitObjects(osuText);
  if (!parsed) return osuText;
  return rewriteFreeHolds(parsed, { ...options, od: options.od ?? parsed.od });
}

interface HoldVerdict {
  effective: boolean;
  reason: "short" | "shortSpanning" | "long" | "chained";
}

/** Index-aligned with `notes`: null for a tap, otherwise why the hold is or is not work. */
function judgeHolds(notes: EffectiveLnNote[], options: EffectiveLnOptions): Array<HoldVerdict | null> {
  const rate = Number.isFinite(Number(options.rate)) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const tapCovered = releaseGreatWindowMs(options.od);
  const tolerance = LN_SAME_MOTION_TOLERANCE_MS;
  const lnVibro = isLnVibroChart(notes, options);
  // Sorted heads in played time, with their columns for the span check.
  const order = notes.map((_, index) => index).sort((a, b) => notes[a].time - notes[b].time);
  const headTimes = order.map((index) => notes[index].time / rate);
  const headColumns = order.map((index) => notes[index].column);

  // Near-window holds in a same-lane chain leave little recovery before the
  // repress. Bodies more than the tolerance inside the window stay free.
  const chained = new Set<number>();
  const lanes = new Map<number, number[]>();
  for (const index of order) {
    const lane = lanes.get(notes[index].column) ?? [];
    lane.push(index);
    lanes.set(notes[index].column, lane);
  }
  for (const lane of lanes.values()) {
    if (lnVibro) break;
    let run: number[] = [];
    const flush = () => {
      // Needs two links (three heads). A lone pair stays free.
      if (run.length >= 2) for (const index of run) chained.add(index);
      run = [];
    };
    for (let i = 0; i + 1 < lane.length; i += 1) {
      const note = notes[lane[i]], next = notes[lane[i + 1]];
      const duration = (note.endTime - note.time) / rate;
      const gap = (next.time - note.endTime) / rate;
      if (note.isHold && next.isHold && next.endTime > next.time
        && duration >= tapCovered - tolerance && duration > 0
        && gap >= 0 && gap <= tapCovered) run.push(lane[i]);
      else flush();
    }
    flush();
  }

  return notes.map((note, index) => {
    if (!note.isHold || !(note.endTime > note.time)) return null;
    const start = note.time / rate;
    const end = note.endTime / rate;
    if (end - start > tapCovered) return { effective: true, reason: "long" };
    if (chained.has(index)) return { effective: true, reason: "chained" };
    // Another column's head strictly inside the body.
    for (let i = lowerBound(headTimes, start + tolerance); i < headTimes.length && headTimes[i] < end - tolerance; i += 1) {
      if (headColumns[i] !== note.column) return { effective: false, reason: "shortSpanning" };
    }
    return { effective: false, reason: "short" };
  });
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface HitObjectLine {
  /** Line number in the .osu text. */
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

/** Minimal [HitObjects] reader that keeps line positions so holds can be rewritten in place. */
function parseHitObjects(osuText: string): ParsedHitObjects | null {
  const lines = osuText.split("\n");
  const keyCountMatch = /^CircleSize\s*:\s*([\d.]+)/m.exec(osuText);
  const keyCount = Math.max(1, Math.round(Number(keyCountMatch?.[1] ?? 4)) || 4);
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
    const x = Number(parts[0]);
    const time = Number(parts[2]);
    const type = Number(parts[3]);
    if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type)) continue;
    const extras = parts.slice(5).join(",");
    const isHold = (type & 128) !== 0;
    const endTime = isHold ? Number(extras.split(":")[0]) : time;
    objects.push({
      index,
      x,
      y: Number(parts[1]),
      time,
      type,
      hitSound: Number(parts[4]),
      extras,
      note: {
        column: Math.max(0, Math.min(keyCount - 1, Math.floor((x * keyCount) / 512))),
        time,
        endTime: isHold && Number.isFinite(endTime) ? endTime : time,
        isHold: isHold && Number.isFinite(endTime) && endTime > time,
      },
    });
  }
  return { lines, objects, od: Number.isFinite(od) ? od : null };
}

/** Rewrites each free hold line as a plain note (type bit 128 cleared, bit 1
 * set), keeping its hit sample and dropping the end time. */
function rewriteFreeHolds(parsed: ParsedHitObjects, options: EffectiveLnOptions): string {
  const { lines, objects } = parsed;
  const mask = effectiveHoldMask(objects.map((object) => object.note), options);
  let demoted = 0;
  objects.forEach((object, i) => {
    if (!object.note.isHold || mask[i]) return;
    const sample = object.extras.includes(":") ? object.extras.slice(object.extras.indexOf(":") + 1) : "0:0:0:0:";
    lines[object.index] = `${object.x},${object.y},${object.time},${(object.type & ~128) | 1},${object.hitSound},${sample}`;
    demoted += 1;
  });
  // Both branches return the same text because `lines` is parsed.lines.
  return demoted > 0 ? lines.join("\n") : parsed.lines.join("\n");
}
