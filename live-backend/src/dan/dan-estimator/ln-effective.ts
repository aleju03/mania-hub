/**
 * Effective LN share: how much of a chart actually demands a release.
 *
 * Plain hold share counts every body. Effective work normally requires a
 * played duration beyond the OD-dependent release 300 window. Model v3 also
 * prices recurring same-lane rearticulation: at least two successive links
 * between hold heads, bodies within 20ms of that window or longer, and
 * nonnegative tail-to-next-head gaps no larger than the window. This is a
 * structural workload heuristic, not a claim that early releases cannot hit.
 * A lone pair, a tiny body, or another column's interior head is insufficient.
 * All durations and gaps are measured at the played rate, exactly once.
 *
 * Identity reads two things per 10s window: the share of notes that are
 * holds longer than the release window, and the share that are holds with
 * release work of either kind (long, or in a same-lane chain). A window is
 * LN when 40% of its notes need a real hold, or when 60% of them are release
 * work even though the bodies themselves are tap-covered: an inverse chart at
 * 264 bpm writes 57ms bodies under a 63ms window and never has a "long" hold,
 * yet every finger is releasing and repressing on the grid. The chart-level
 * share is the note-weighted median of the per-window reading, so a chart is
 * LN when most of its playtime is, with dense sections weighing more than
 * sparse intros: short-LN filler between real LN sections does not dilute
 * them, and one LN wall in a rice chart does not qualify it. On 4K this is an
 * additional gate after the ordinary hold share: the model may demote a
 * nominal LN chart whose tails are free, but it may not promote a chart that
 * never reached the established 45% hold line.
 *
 * The 17 cached courses are an offline evaluation set, never runtime inputs.
 * Everything here is structural (times, columns, OD); no chart identity.
 */

import type { ManiaBeatmap } from "../beatmap-parser.js";
import { detectLnVibro } from "../vibro-detection.js";
import { lnPrimaryMinRatioFor } from "./ln.js";

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
  /** Holds that carry identity work (long or chained) at the identity OD, over
   * all holds. What a hold-heavy chart's holds are worth as holds: near zero
   * on a chart whose holds are vibro notation or all under the window. */
  identityWorkShare: number;
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
 * Identity never reads an OD under this. The release window widens as OD
 * falls (96ms at OD 0 against 73.5ms at OD 5), so on a low-OD file most 1/8
 * holds at any tempo count as free and a hold-heavy chart files as rice for
 * the OD its mapper left, not for what its notes ask. Measured 2026-09-18
 * over the cached 4K charts past the hold line: 923 sit at OD 0 and 580 of
 * them read rice at 1.0x; read at OD 5, 441 of those are LN. Over the 1,481
 * charts under the floor, 496 join LN at 1.0x, 210 at 1.5x and 124 at 0.75x,
 * and nothing crosses the other way (a floor of 5.5 sends one chart to rice,
 * so 5 it is). Everything that prices the chart, the LN rating, the tail pass
 * and the effective-hold counts, keeps the OD it was played at; only the
 * LN-or-rice question reads the floor.
 */
export const LN_IDENTITY_MIN_OD = 5;
/**
 * The share of a chart's holds that must carry identity work (long or
 * chained at the identity OD) before its holds count as an LN side at all:
 * for publishing an LN number and for the hybrid badge. A vibro pack chart
 * with 74% holds of 43ms and one long hold otherwise published LN 4 beside
 * its rice values. Real hybrids sit at 0.68 or above at the 5th percentile
 * of the 25-75% hold band (2026-09-18); the 80 charts under this line are
 * vibro packs.
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

/** Stored beside the derived share so a model change can rescan every row,
 * including rows whose final LN/rice side happens not to move. */
// v5: a window whose notes are 60% release work (long or chained holds) reads
// LN even when no body clears the window, so dense inverse charts at high
// tempo keep their identity; v4 counted long tails only.
// v6: identity reads the release window at OD LN_IDENTITY_MIN_OD or the
// file's, whichever is higher; the effective-hold counts keep the played OD.
// An LN vibro chart (staggered hold spam, dan/vibro-detection.ts) forms no
// chains: its 43ms holds are notation for a shake, and at 0.75x their bodies
// reached the OD 5 window and read as an inverse chart. Long holds still
// count. The identity work share is stored beside the share.
export const LN_EFFECTIVE_MODEL_VERSION = 6;

/**
 * The effective share at which a 4K chart's identity is LN.
 *
 * Deliberately its own number rather than the hold-share line (0.45): this is
 * a note-weighted median of section shares, while the hold line is a plain
 * chart-wide ratio, so the two numbers live on different scales. Both gates
 * must pass; effective share can only demote the old hold-share verdict.
 *
 * Fitted to charts players call LN that landed just under 0.45 on the first
 * pass (measured 2026-09-03, `scripts/dev/ln-effective-impact.ts`): Thule
 * [Snaefellsjokull] 0.415, farewell: to my memories 0.419, SYSTEM ERROR
 * [Anisotropic System] 0.421, COMPLEX MISCONCEPTION | ULTRA 0.439, Last Wish
 * 0.476. Against the negatives it has to keep: the full-LN "noodle" charts
 * whose tails a tap covers end to end sit at 0.30 and below (Chaoz Airflow
 * [FULL LN] 0.302), and FREEDOM DiVE [FULL DiMENSiONS] reads 0.207 at 1.5x.
 * Ange du Blanc Pur [Extra] is the complementary hold-share negative: its
 * section median is 0.412, but only 37.8% of the chart is holds and players
 * read it as ordinary jumpstream, so the 45% first gate keeps it rice.
 */
export const LN_EFFECTIVE_MIN_RATIO = 0.4;

/**
 * The share of a window's notes that must be release work (a long hold, or a
 * hold in a same-lane release/repress chain) for the window to read LN when
 * its bodies are tap-covered. Scaled onto the 0.4 line above so one stored
 * share answers both readings.
 *
 * Fitted 2026-09-17 on charts the owner watched in game: an inverse
 * handstream at 264 bpm (95% holds, 57ms bodies, chained share 0.80) and a
 * pack chart at the same tempo (85% holds, 0.66) are LN; at 1.5x a 1/4-held
 * jumpstream chart (0.53), FREEDOM DiVE [FULL DiMENSiONS] (0.48) and Le
 * Porteur d'Ombre [Lightless] (0.27) stay rice, as the owner reads DT on
 * such charts as jumpstream. The 0.53 / 0.66 pair bounds the line.
 */
export const LN_CHAINED_MIN_RATIO = 0.6;

/**
 * The line an effective share is compared against for a keymode. Only for
 * callers that hold an effective share for certain (the classifier, which
 * just computed one, and the sweep's SQL, which filters on the column):
 * everyone deciding chart identity wants `chartIsLn`, which applies the hold
 * gate and, when available, the effective gate together.
 */
export function lnIdentityMinRatioFor(keyCount: number | null | undefined): number {
  return keyCount != null && LN_EFFECTIVE_KEY_COUNTS.has(keyCount)
    ? LN_EFFECTIVE_MIN_RATIO
    : lnPrimaryMinRatioFor(keyCount);
}

/**
 * "Is this chart LN": the one question every identity consumer asks. On 4K,
 * a stored effective share adds a second gate after the ordinary hold-share
 * line; other keymodes and unswept legacy rows use the hold gate alone.
 *
 * The crossing this exists to prevent: a 4K row stored before the effective
 * sweep reached it has no effective share, so it falls back to its hold
 * share, and comparing THAT against the effective line (0.40, lower than the
 * hold-share 0.45 by construction) would promote a band of charts to LN that
 * neither rule ever called LN. A fallback share answers to the fallback line.
 *
 * Null when nothing is known about the chart's holds at all.
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

/** The ScoreV2-style release 300 window at an OD, in ms. */
export function releaseGreatWindowMs(od: number | null | undefined): number {
  const clamped = od != null && Number.isFinite(Number(od)) ? Math.max(0, Math.min(10, Number(od))) : ASSUMED_OD;
  return RELEASE_WINDOW_MULTIPLIER * (GREAT_WINDOW_BASE_MS - OD_WINDOW_STEP_MS * clamped);
}

/**
 * The effective share on keymodes that use it, the plain hold share otherwise.
 * This exposes the metric for display/measurement; identity callers must use
 * chartIsLn so the 4K hold gate cannot be skipped.
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

interface HoldVerdict {
  effective: boolean;
  reason: "short" | "shortSpanning" | "long" | "chained";
}

/** LN vibro at the played rate: dense staggered hold spam. Its same-lane
 * chains are a shake, not release work, so they never form. */
export function isLnVibroChart(notes: EffectiveLnNote[], options: EffectiveLnOptions): boolean {
  const rate = Number.isFinite(Number(options.rate)) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const keyCount = options.keyCount ?? notes.reduce((max, note) => Math.max(max, note.column + 1), 0);
  return detectLnVibro({ keyCount, notes } as unknown as ManiaBeatmap, rate);
}

function judgeHolds(notes: EffectiveLnNote[], options: EffectiveLnOptions): Array<HoldVerdict | null> {
  const rate = Number.isFinite(Number(options.rate)) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const tapCovered = releaseGreatWindowMs(options.od);
  const tolerance = LN_SAME_MOTION_TOLERANCE_MS;
  const lnVibro = isLnVibroChart(notes, options);
  // Heads in played time, sorted, with their columns alongside for the span check.
  const order = notes.map((_, index) => index).sort((a, b) => notes[a].time - notes[b].time);
  const headTimes = order.map((index) => notes[index].time / rate);
  const headColumns = order.map((index) => notes[index].column);
  // Near-window holds in a recurring same-lane chain have little recovery
  // before rearticulation. Do not extend this to arbitrarily tiny LN bodies:
  // bodies more than one shared-motion tolerance inside the window stay free.
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
      // Two consecutive links (three hold heads), not an isolated double.
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

  // Identity judges the same holds at no less than LN_IDENTITY_MIN_OD; the
  // counts above stay at the played OD for the rating and the tail pass.
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

  // Identity per window: the long-tail share, or the release-work share
  // (long plus chained) scaled from its own 0.6 line onto the 0.4 line,
  // whichever reads higher. A tap-covered chain alone needs 60% of the
  // window's notes; isolated short bodies never count. Then the
  // note-weighted median across windows.
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
 * The .osu a tail-aware calc pass should rate, or null when the pass would
 * add nothing. Keymodes on the effective share get their free holds demoted
 * first, so the pass sees only the releases that are work; every other
 * keymode keeps its full tail pass, on the blend weights fit for it.
 * `minHoldRatio` is the hold share under which the pass is skipped
 * (LN_TAIL_MIN_RATIO in dan/msd.ts, passed in so this module stays free of
 * backend imports). On 4K the established 45% identity gate is stricter and
 * wins: low-hold regular charts receive no LN-tail blend.
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
  // On 4K the tail pass follows the same conservative first gate as chart
  // identity. A low-hold regular chart does not get the full 10% LN-tail blend
  // merely because a handful of releases make the upper-bound pass enormous.
  if (analysis.holdRatio < lnPrimaryMinRatioFor(keyCount)) return null;
  if (!(analysis.effectiveHoldRatio > options.minHoldRatio)) return null;
  return rewriteFreeHolds(parsed, { ...options, od });
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
  return demoted > 0 ? lines.join("\n") : parsed.lines.join("\n");
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
  return rewriteFreeHolds(parsed, { ...options, od: options.od ?? parsed.od });
}
