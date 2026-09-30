// A player's dan per keymode and side (rice "rc" or LN), from their plays.
// A clear is a pass at the bar the real dan courses set, credited at the
// chart's dan at the played rate plus an accuracy offset (dan-credit.ts).
// Clears file into skillset tiles. A tile with four primary clears gets the
// mean of its best twenty credited clears, and the headline is the mean of
// the tile dans. A verified course clear floors the headline.
//
// A clear only counts for the chart's own side. LN accuracy is earned on the
// holds and says nothing about rice, and the reverse. Misses have no separate
// gate because accuracy already prices them.
import { danLabelFor as chartDanLabel, danTableCeilingFor, danTableFloorFor } from "../classification/chart-classifier";
import { chartIsLn } from "../dan-estimator/ln-effective";
import type { LeoBlackOdFlag } from "../leoblack/estimator";
import type { MotionFeatures } from "../classification/motion-features";
import { conservativeVibroAccuracy } from "../vibro/sections";
import { creditedDanFor, danCreditBelowBarWindowFor } from "./dan-credit";
import type { DanCourseClear, DanCourseCreditOptions } from "./dan-courses";
import {
  BASE_MSD_SKILLSETS,
  CLUSTER_SHARE_MIN,
  INVERSE_MOD_PATTERNS,
  INVERSE_MOD_VARIANT,
  PATTERN_TAG_MIN_SCORE,
  RICE_MSD_SKILLSETS,
  SKILL_RATING_SKILLSETS,
  dominantSkillset,
  hasHandstreamEndurance,
  pickSkillsets,
  playSlotKey,
  type ChartSkillInfo,
  type StoredPlaySsr,
} from "./skill-ratings";

/**
 * Clears a side or tile needs before it has a dan, the same count a course
 * asks for back to back. Credited clears under the bar count too.
 */
const DAN_CLEAR_QUORUM = 4;

/**
 * How many clears a dan averages over, large enough that a few strong clears
 * cannot set a skillset alone. A smaller pool averages what it has.
 */
const DAN_CLEAR_AVERAGE_WINDOW = 20;

/** 6K/7K tables open at level 0, the Normal Kyu band, where rice courses set a lower bar. */
const DAN_KYU_BAND_MAX_RAW_DAN = 1;

/**
 * Added to a ScoreV2 bar when only stable accuracy is known. Stable reads
 * about half a point higher for the same hands, so 97% becomes 97.5%. Lazer
 * plays already display ScoreV2.
 */
const STABLE_EQUIVALENT_V2_BAR_OFFSET = 0.005;

/**
 * Lowest judged OD that credits dan. Looser windows say little about the
 * level. A DA play is held to the OD it set. A chart with no known OD passes.
 */
export const DAN_MIN_OD_FLOOR = 5.5;

/** 7K LN floor. The official 7K LN courses are OD 5. */
export const DAN_MIN_OD_7K_LN = 5;

/**
 * 4K LN floor. Release windows are 1.5x the head's, so a low OD loosens LN
 * far more than rice. The official 4K LN courses are OD 8 and 8.5.
 */
export const DAN_MIN_OD_4K_LN = 7;

/**
 * Dans are stored at two decimals, so "clears at or above the estimate"
 * allows for rounding. Without it a clear can miss the estimate it set.
 */
const DAN_ROUNDING_EPSILON = 0.005;

/**
 * Tiles a side needs rated before their mean is the headline. Missing tiles
 * mostly mean few plays. Every 4K rice player past 500 analysed plays has all
 * four.
 */
const DAN_SKILLSET_AVERAGE_MIN_BUCKETS = 2;

/**
 * The anchored headline (anchoredSkillsetDans) counts each tile's distance
 * from the anchor up to DAN_ANCHOR_CLAMP levels and takes DAN_ANCHOR_PULL of
 * the mean, so it moves at most one level either way. On 7K LN, Release sits
 * a median 3.75 levels under General because top release charts barely exist.
 */
const DAN_ANCHOR_CLAMP = 2;
const DAN_ANCHOR_PULL = 0.5;

/**
 * Strays are clears far under the rest of a window. A clear more than five
 * levels under the mean of the window's best five is ignored, three at most,
 * so a tile cannot shed most of its clears and jump levels.
 */
const DAN_STRAY_CLEAR_REFERENCE = 5;
const DAN_STRAY_CLEAR_GAP = 5;
const DAN_STRAY_CLEAR_MAX_IGNORED = 3;

// Keys for the rate-verdict store. Plays at a rate the chart analysis does not
// cover (anything but 1.0x, 1.5x, 0.75x), under Invert, with a section vibro
// adjustment or at a changed OD read the verdict for that exact combination.
export type DanChartVariant = "IN" | "vibro-adjusted";
export const VIBRO_ADJUSTED_VARIANT = "vibro-adjusted" satisfies DanChartVariant;
/** The dan estimator's supported rate band, in percent. */
export const MIN_RATE_PERCENT = 50;
export const MAX_RATE_PERCENT = 200;

/** One (chart, rate[, variant][, OD]) the clear rules want a verdict for. */
export interface RateDanVerdictPair {
  beatmapId: number;
  ratePercent: number;
  modVariant?: DanChartVariant;
  odFlag?: LeoBlackOdFlag;
}

/**
 * Stored dan verdicts at rates or variants the chart analysis does not cover,
 * keyed by rateDanVerdictKey. A null value is a verdict with nothing to credit;
 * an absent key is one not computed yet.
 */
export type RateVerdictMap = Map<string, { rawDan: number; side: "rc" | "ln"; displayName?: string | null } | null>;

export interface DanClearBar {
  accuracy: number;
  /** "stable" is the 300-weighted display accuracy, "v2" the 305-weighted ScoreV2/lazer one. */
  currency: "stable" | "v2";
}

/** One credited clear and the dan it demonstrates. */
export interface DanClearEvidence {
  play: StoredPlaySsr;
  side: "rc" | "ln";
  /** The chart's own dan at the played rate, before the accuracy credit. */
  chartDan: number;
  /** The stored verdict's printed label for that dan, when kept. */
  chartDanLabel: string | null;
  /** chartDan plus the accuracy offset, clamped to the ladder (creditedDanFor). */
  creditedDan: number;
  /** The accuracy the clear was judged on, in this ladder's currency. */
  accuracy: number;
  /** The bar it was judged against, after any stable -> v2 conversion. */
  bar: number;
  /** "stable" against a v2 ladder when the counts are gone and the bar was converted instead. */
  currency: "stable" | "v2";
  /** Set when a registered practice chart set the credit (creditSkillsetPracticeClears). */
  credential?: { level: string; courseName: string };
}

/**
 * Why a rated play credits no dan. HO/NR, Invert outside its keymodes and DA
 * under the floor are refused a rating in skill-ratings.ts and never get here.
 * `low_od` includes a DA raise that stopped short of the floor.
 */
export type DanClearRejectReason =
  | "chart_unanalyzed"
  | "chart_ineligible"
  | "chart_vibro"
  | "rate_vibro"
  | "low_od"
  | "ez_windows"
  | "no_accuracy"
  | "no_chart_dan"
  | "chart_repeat_limit"
  | "unverifiable_revision"
  | "below_bar";

/** One rated play that credited no dan, with the rule that stopped it. */
export interface DanClearReject {
  play: StoredPlaySsr;
  reason: DanClearRejectReason;
  /** The side it would have testified for, when the chart names one. */
  side: "rc" | "ln" | null;
  /** The chart's dan at the played rate, when it has one. */
  chartDan: number | null;
  chartDanLabel: string | null;
  /** below_bar only: what it was judged on, and the bar it missed. */
  accuracy: number | null;
  bar: number | null;
  /** below_bar only: the lowest accuracy that would still have credited. */
  minAccuracy: number | null;
  /** below_bar only: the formula `accuracy` and `bar` are written in. */
  currency: "stable" | "v2" | null;
  /** low_od only: the OD the play was judged at. */
  od: number | null;
}

/** The dan a play is measured against at its own rate, before any accuracy gate. */
export interface DanClearTarget {
  rawDan: number;
  side: "rc" | "ln";
  label: string | null;
}

/** A dan estimate on the continuous chart-dan scale. */
export interface PlayerSkillDanVerdict {
  /** A practice credential set this tile's number. */
  skillsetClear?: NonNullable<PlayerSkillDanSide["courseClear"]>;
  rawDan: number;
  label: string;
  /** Qualifying clears at or above the estimate. */
  clears: number;
  /** This tile's pull on an anchored headline was capped. */
  headlineCapped?: boolean;
  /** At or above the top of the table, so the label is a floor. */
  beyondTable?: boolean;
  /**
   * `have` weighted clears of the `need` a full window averages. A headline
   * sums every published tile, and `skills` counts the full ones.
   */
  clearWindow?: { have: number; need: number; skills?: { full: number; total: number } };
}

export interface PlayerSkillDanSide extends PlayerSkillDanVerdict {
  /** Skill credentials exist, but no overall estimate has a quorum yet. */
  skillsetsOnly?: boolean;
  /** Each rated tile's dan, keyed by tile id. */
  skillsets?: Record<string, PlayerSkillDanVerdict>;
  /** Set when a verified course clear floored the headline. */
  courseClear?: {
    beatmapId: number;
    courseName: string;
    level: string;
    accuracy: number;
    currency: "stable" | "v2";
    bar: number;
    displayedAccuracy?: number | null;
  };
}

export interface PlayerSkillModeDan {
  rc: PlayerSkillDanSide | null;
  ln: PlayerSkillDanSide | null;
}

export interface WeightedDanClear {
  clear: DanClearEvidence;
  /** Always 1; selected clears have full weight. */
  repeatWeight: number;
  /** Averaging weight, clipped at the window edge and zero outside it. */
  weight: number;
  ignoredAsStray: boolean;
}

/** A diff in the same beatmapset, for confirming a pre-rated upload's base length. */
export interface RateEditSibling {
  beatmapId: number;
  keyCount: number;
  lnCount: number;
  /** Seconds. */
  length: number;
  circleCount: number;
  sliderCount: number;
  spinnerCount: number;
}

/**
 * The pass bar for one side of one keymode's ladder, from its courses.
 *   4K rice   96% stable
 *   4K LN     97% ScoreV2
 *   6K/7K rice 96% for the dan levels, 95% for the Normal Kyu band
 *   6K/7K LN  95% stable
 * Accuracy is recomputed from the judgement counts in the bar's currency, so
 * stable and lazer plays qualify alike.
 */
export function danClearBarFor(side: "rc" | "ln", keyCount: number, chartDan?: number): DanClearBar {
  if (keyCount === 4) {
    return side === "ln" ? { accuracy: 0.97, currency: "v2" } : { accuracy: 0.96, currency: "stable" };
  }
  if (side === "ln") return { accuracy: 0.95, currency: "stable" };
  const kyu = chartDan != null && chartDan < DAN_KYU_BAND_MAX_RAW_DAN;
  return { accuracy: kyu ? 0.95 : 0.96, currency: "stable" };
}

/** Shared with course credit so courses and charts use the same bars. */
export const DAN_COURSE_CREDIT_OPTIONS: DanCourseCreditOptions = {
  barFor: danClearBarFor,
  stableEquivalentV2BarOffset: STABLE_EQUIVALENT_V2_BAR_OFFSET,
};

/** The OD floor the play's own ladder holds it to. */
export function danMinOdFor(keyCount: number, side: "rc" | "ln" | null): number {
  if (side === "ln" && keyCount === 7) return DAN_MIN_OD_7K_LN;
  if (side === "ln" && keyCount === 4) return DAN_MIN_OD_4K_LN;
  return DAN_MIN_OD_FLOOR;
}

export function danClearAverageWindowFor(_side: "rc" | "ln", _keyCount: number): number {
  return DAN_CLEAR_AVERAGE_WINDOW;
}

/**
 * One keymode's dan, both sides. `plays` are the keymode's stored plays, rated
 * and dan-only, plus the slot dan attempts (pickDanAttempts). `rateVerdicts`
 * holds verdicts at rates and variants the chart analysis does not cover.
 */
export function computeModeDan(
  keyCount: number,
  plays: StoredPlaySsr[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[] = [],
  rateVerdicts: RateVerdictMap = new Map(),
): PlayerSkillModeDan {
  const clears: Record<"rc" | "ln", DanClearEvidence[]> = { rc: [], ln: [] };
  for (const clear of collectDanClears(keyCount, plays, infoByBeatmap, rateVerdicts)) {
    clears[clear.side].push(clear);
  }
  const forSide = (side: "rc" | "ln"): PlayerSkillDanSide | null =>
    danSideFromClears(keyCount, side, clears[side], infoByBeatmap, courseClears);
  return { rc: forSide("rc"), ln: forSide("ln") };
}

/**
 * The credited clears among a keymode's plays. When `rejects` is given, every
 * play turned away is appended with its reason; a dan attempt is only listed
 * when it credits, and then the rated play it outscored is not listed either.
 */
export function collectDanClears(
  keyCount: number,
  plays: StoredPlaySsr[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  rateVerdicts: RateVerdictMap = new Map(),
  rejects?: DanClearReject[],
): DanClearEvidence[] {
  const clears: DanClearEvidence[] = [];
  // Held back until the slot selection below knows which attempt credited.
  const turnedAway: DanClearReject[] = [];
  const reject = (
    play: StoredPlaySsr,
    reason: DanClearRejectReason,
    extra: Partial<Omit<DanClearReject, "play" | "reason">> = {},
  ) => {
    if (!rejects) return;
    turnedAway.push({ play, reason, side: null, chartDan: null, chartDanLabel: null, accuracy: null, bar: null, minAccuracy: null, currency: null, od: null, ...extra });
  };
  for (const play of plays) {
    // Unrated placeholders have not had their vibro check yet.
    if (play.neverRated) continue;
    const info = infoByBeatmap.get(play.beatmapId);
    if (!info) {
      reject(play, "chart_unanalyzed");
      continue;
    }
    // Resolved first so rejections can name the target dan and the OD floor
    // knows its ladder.
    const target = danClearTargetFor(play, info, keyCount, rateVerdicts);
    const aimed = target
      ? { side: target.side, chartDan: target.rawDan, chartDanLabel: target.label }
      : {};
    if (!info.danEligible) {
      reject(play, "chart_ineligible", aimed);
      continue;
    }
    if (play.unverifiableRevision === true) {
      reject(play, "unverifiable_revision", aimed);
      continue;
    }
    // The floor follows the verdict's side. Invert plays are always LN, even
    // before the inverted chart has a verdict. Otherwise the hold share decides.
    const playOd = play.odOverride ?? info.od;
    const floorSide: "rc" | "ln" | null = play.inverse
      ? "ln"
      : target?.side ?? (chartIsLn(keyCount, { lnRatio: info.lnRatio, lnEffectiveRatio: info.lnEffectiveRatio }) === true ? "ln" : null);
    if (playOd != null && playOd < danMinOdFor(keyCount, floorSide)) {
      reject(play, "low_od", { ...aimed, od: playOd });
      continue;
    }
    // EZ widens every window 1.4x, so the accuracy does not meet the bar's
    // windows. The play stays rated.
    if (play.ezWindows) {
      reject(play, "ez_windows", aimed);
      continue;
    }
    const displayed = play.accuracy ?? null;
    if (typeof displayed !== "number") {
      reject(play, "no_accuracy", aimed);
      continue;
    }
    // Both currencies come from the judgement counts. Displayed accuracy is
    // the fallback when they are gone.
    const stable = play.stableAccuracy ?? null;
    const scoreV2 = play.scoreV2Accuracy ?? null;
    // A lazer submission already displays ScoreV2.
    const isLazerPlay = stable != null && Math.abs(displayed - stable) > 1e-9;
    const push = (rawDan: number | null, side: "rc" | "ln", chartDanLabel: string | null) => {
      if (rawDan == null) {
        reject(play, "no_chart_dan", aimed);
        return;
      }
      const bar = danClearBarFor(side, keyCount, rawDan);
      let threshold = bar.accuracy;
      let accuracy: number;
      let currency = bar.currency;
      if (bar.currency !== "v2") {
        accuracy = stable ?? displayed;
      } else if (scoreV2 != null) {
        accuracy = scoreV2;
      } else if (isLazerPlay) {
        accuracy = displayed;
      } else {
        // Stable-only row on a v2 ladder. The whole credit scale moves with
        // the converted bar.
        accuracy = stable ?? displayed;
        threshold += STABLE_EQUIVALENT_V2_BAR_OFFSET;
        currency = "stable";
      }
      if (play.vibroAdjustment) accuracy = conservativeVibroAccuracy(accuracy, play.vibroAdjustment.judgementShare);
      // The jack tile's bonus is damped, so the credit needs the primary tile.
      const primaryTile = side === "rc" && keyCount === 4
        ? danSkillsetBucketsForPlay(danSkillsetBuckets(keyCount, side), play, info)[0]?.id ?? null
        : null;
      const creditedDan = creditedDanFor(rawDan, accuracy, threshold, side, keyCount, { primaryTile });
      if (creditedDan == null) {
        // Passes under the bar credit down to the window edge, so that edge is
        // what this play missed.
        const floor = Math.round((threshold - danCreditBelowBarWindowFor(side, keyCount)) * 1000) / 1000;
        reject(play, "below_bar", { side, chartDan: rawDan, chartDanLabel, accuracy, bar: threshold, minAccuracy: floor, currency });
        return;
      }
      clears.push({ play, side, chartDan: rawDan, chartDanLabel, creditedDan, accuracy, bar: threshold, currency });
    };
    if (target) {
      push(target.rawDan, target.side, target.label);
    } else {
      reject(play, "no_chart_dan", aimed);
    }
  }
  const selected = new Set(selectDanRatingClears(clears, infoByBeatmap));
  const kept = clears.filter((clear) => {
    if (selected.has(clear)) return true;
    reject(clear.play, "chart_repeat_limit", {
      side: clear.side, chartDan: clear.chartDan, chartDanLabel: clear.chartDanLabel,
      accuracy: clear.accuracy, bar: clear.bar, currency: clear.currency,
    });
    return false;
  });
  if (rejects) {
    const slotOf = (play: StoredPlaySsr) => `${play.keyCount}:${play.ratingSlot ?? playSlotKey(play.beatmapId, play.rate, play.inverse)}`;
    const creditedByAttempt = new Set(kept.filter((clear) => clear.play.danAttempt).map((clear) => slotOf(clear.play)));
    rejects.push(...turnedAway.filter((entry) => !entry.play.danAttempt && !creditedByAttempt.has(slotOf(entry.play))));
  }
  return kept;
}

/**
 * The dan a play is measured against. Verdicts under the ladder floor credit
 * at the floor. Invert, a section vibro adjustment or a changed OD (DA, HR,
 * EZ) read the verdict for that variant at any rate. 1.0x reads the chart's
 * own verdict, 1.5x and 0.75x the stored ones, and other rates in the 50-200%
 * band the verdict at that rate.
 */
export function danClearTargetFor(
  play: StoredPlaySsr,
  info: ChartSkillInfo,
  keyCount: number,
  rateVerdicts: RateVerdictMap,
): DanClearTarget | null {
  const target = (rawDan: number | null, side: "rc" | "ln", label: string | null): DanClearTarget | null =>
    rawDan == null ? null : { rawDan: Math.max(rawDan, danTableFloorFor(side, keyCount)), side, label };
  if (play.inverse || play.vibroAdjustment || danOdFlagForPlay(play) != null) {
    const pair = rateVerdictPairFor(play);
    const verdict = pair ? rateVerdicts.get(rateDanVerdictKey(pair.beatmapId, pair.ratePercent, pair.modVariant, pair.odFlag)) : null;
    return verdict ? target(verdict.rawDan, verdict.side, verdict.displayName ?? null) : null;
  }
  if (play.rate === 1 && info.lnRatio != null) {
    const side = chartIsLn(keyCount, { lnRatio: info.lnRatio, lnEffectiveRatio: info.lnEffectiveRatio }) === true ? "ln" : "rc";
    return target(side === "ln" ? info.lnRawDan : info.rcRawDan, side, side === "ln" ? info.lnDanLabel : info.rcDanLabel);
  }
  if (play.rate === 1.5 && info.dtFamily != null) {
    return target(info.dtRawDan, info.dtFamily, info.dtDanLabel);
  }
  if (play.rate === 0.75 && info.htFamily != null) {
    return target(info.htRawDan, info.htFamily, info.htDanLabel);
  }
  const ratePercent = clearRatePercent(play.rate);
  if (ratePercent == null) return null;
  const verdict = rateVerdicts.get(rateDanVerdictKey(play.beatmapId, ratePercent));
  return verdict ? target(verdict.rawDan, verdict.side, verdict.displayName ?? null) : null;
}

/**
 * The rate-verdict entry a play's clear reads, or null for a plain 1.0x play
 * or a rate outside the estimator's band.
 */
export function rateVerdictPairFor(play: StoredPlaySsr): RateDanVerdictPair | null {
  if (!Number.isInteger(play.beatmapId) || play.beatmapId <= 0) return null;
  const odFlag = danOdFlagForPlay(play);
  if (play.inverse || play.vibroAdjustment || odFlag != null) {
    if (!Number.isFinite(play.rate) || play.rate <= 0) return null;
    const percent = Math.round(play.rate * 100);
    if (percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
    return {
      beatmapId: play.beatmapId, ratePercent: percent,
      ...(play.inverse ? { modVariant: INVERSE_MOD_VARIANT as DanChartVariant }
        : play.vibroAdjustment ? { modVariant: VIBRO_ADJUSTED_VARIANT } : {}),
      ...(odFlag != null ? { odFlag } : {}),
    };
  }
  const ratePercent = clearRatePercent(play.rate);
  return ratePercent == null ? null : { beatmapId: play.beatmapId, ratePercent };
}

/**
 * Key a verdict is filed under. An explicit DA OD equal to the file's own
 * still gets its own key, since the estimator's Mixed routing treats an
 * explicit OD differently from none.
 */
export function rateDanVerdictKey(beatmapId: number, ratePercent: number, modVariant?: DanChartVariant, odFlag?: LeoBlackOdFlag): string {
  const variant = odFlag == null ? modVariant : `${modVariant ? `${modVariant}:` : ""}OD:${odFlag}`;
  return `${beatmapId}:${ratePercent}${variant ? `:${variant}` : ""}`;
}

/** An OD flag the estimator accepts: "HR", "EZ", or a DA slider value in -15..15. */
export function normalizeDanOdFlag(value: unknown): LeoBlackOdFlag | undefined {
  if (value === "HR" || value === "EZ") return value;
  return typeof value === "number" && Number.isFinite(value) && value >= -15 && value <= 15
    ? (Object.is(value, -0) ? 0 : value) : undefined;
}

/**
 * Raises clears on registered practice charts to the level the chart
 * certifies, inside its own skillset only. The estimator can rate such a chart
 * a level and a half away from that. chartDan stays as rated. One raise per
 * chart, on its strongest clear, and only when it beats what the clear earned.
 */
export function creditSkillsetPracticeClears(
  clears: DanClearEvidence[],
  courseClears: DanCourseClear[],
  keyCount: number,
  skillset: string,
): DanClearEvidence[] {
  const byBeatmap = new Map<number, DanCourseClear>();
  for (const course of courseClears) {
    if (course.skillset !== skillset || course.keyCount !== keyCount) continue;
    const current = byBeatmap.get(course.beatmapId);
    if (!current || course.rawDan > current.rawDan) byBeatmap.set(course.beatmapId, course);
  }
  if (byBeatmap.size === 0) return clears;
  const raised = new Map<number, DanClearEvidence>();
  for (const clear of clears) {
    const course = byBeatmap.get(clear.play.beatmapId);
    if (!course || course.side !== clear.side || course.rawDan <= clear.creditedDan) continue;
    const current = raised.get(clear.play.beatmapId);
    if (!current || clear.creditedDan > current.creditedDan) raised.set(clear.play.beatmapId, clear);
  }
  if (raised.size === 0) return clears;
  return clears.map((clear) => {
    if (raised.get(clear.play.beatmapId) !== clear) return clear;
    const course = byBeatmap.get(clear.play.beatmapId)!;
    return { ...clear, creditedDan: course.rawDan, credential: { level: course.level, courseName: course.courseName } };
  });
}

export function compareDanClears(left: DanClearEvidence, right: DanClearEvidence): number {
  return right.creditedDan - left.creditedDan
    || left.play.beatmapId - right.play.beatmapId
    || right.play.rate - left.play.rate
    || Number(left.play.inverse === true) - Number(right.play.inverse === true)
    || left.play.identity.localeCompare(right.play.identity);
}

/**
 * One clear per slot, and the best two per verified chart family and ladder,
 * strongest first. Selected once before tile grouping so a third rate cannot
 * enter through another tile. Invert is a different chart, as for MSD.
 */
export function selectDanRatingClears(
  clears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
): DanClearEvidence[] {
  const slots = new Set<string>();
  const counts = new Map<string, number>();
  return [...clears].sort(compareDanClears).filter((clear) => {
    const { play, side } = clear;
    const slot = `${play.keyCount}:${side}:${play.ratingSlot ?? playSlotKey(play.beatmapId, play.rate, play.inverse)}`;
    if (slots.has(slot)) return false;
    slots.add(slot);
    const family = infoByBeatmap.get(play.beatmapId)?.chartFamily ?? play.chartFamily ?? `beatmap:${play.beatmapId}`;
    const key = `${play.keyCount}:${side}:${family}:${play.inverse === true}`;
    const count = counts.get(key) ?? 0;
    if (count >= 2) return false;
    counts.set(key, count + 1);
    return true;
  });
}

/**
 * The averaging window over selected clears, best first: each clear weighs 1
 * until `need` is reached (the last one clipped), then 0. Strays at the bottom
 * of the window are marked (danIgnoredStrayCount).
 */
export function weightedDanClearWindow(
  clears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  need = DAN_CLEAR_AVERAGE_WINDOW,
): { entries: WeightedDanClear[]; window: WeightedDanClear[]; have: number } {
  let have = 0;
  const entries = selectDanRatingClears(clears, infoByBeatmap).map((clear): WeightedDanClear => {
    const repeatWeight = 1;
    const weight = Math.min(1, Math.max(0, need - have));
    have += weight;
    if (need - have < 1e-10) have = need;
    return { clear, repeatWeight, weight, ignoredAsStray: false };
  });
  const window = entries.filter((entry) => entry.weight > 0);
  const ignored = danIgnoredStrayCount(window.map((entry) => entry.clear.creditedDan));
  for (const entry of window.slice(window.length - ignored)) entry.ignoredAsStray = true;
  return { entries, window, have };
}

/**
 * How many of a window's lowest clears the stray rule ignores, given the
 * window best first. Never trims below the quorum, which would drop the tile
 * from the headline.
 */
export function danIgnoredStrayCount(sortedDesc: number[]): number {
  const reference = sortedDesc.slice(0, DAN_STRAY_CLEAR_REFERENCE);
  if (reference.length === 0) return 0;
  const cut = reference.reduce((sum, value) => sum + value, 0) / reference.length - DAN_STRAY_CLEAR_GAP;
  const room = Math.min(DAN_STRAY_CLEAR_MAX_IGNORED, sortedDesc.length - DAN_CLEAR_QUORUM);
  let ignored = 0;
  while (ignored < room && sortedDesc[sortedDesc.length - 1 - ignored] < cut) ignored += 1;
  return ignored;
}

/**
 * One side's tile dans and headline. A tile opens on its primary clears and
 * then averages everything filed there. The headline is the anchored mean
 * (7K LN), else the tile mean, else the side-wide best-clears mean, floored
 * by the best course clear.
 */
export function danSideFromClears(
  keyCount: number,
  side: "rc" | "ln",
  list: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[] = [],
): PlayerSkillDanSide | null {
  list = selectDanRatingClears(list, infoByBeatmap);
  const best = bestDanCourseClear(courseClears, keyCount, side);
  const clearDans = list.map((clear) => clear.creditedDan);
  const quorumDan = danFromClears(list, side, keyCount, infoByBeatmap);
  const skillsets: Record<string, PlayerSkillDanVerdict> = {};
  const grouped = groupDanClearsBySkillset(keyCount, side, list, infoByBeatmap, courseClears);
  for (const [id, bucketClears] of grouped.byBucket) {
    if ((grouped.primaryByBucket.get(id)?.length ?? 0) < DAN_CLEAR_QUORUM) continue;
    const bucketDan = danFromClears(bucketClears, side, keyCount, infoByBeatmap);
    if (bucketDan) skillsets[id] = bucketDan;
  }
  for (const clear of courseClears) {
    if (!clear.skillset || clear.keyCount !== keyCount || clear.side !== side) continue;
    const current = skillsets[clear.skillset];
    if (!current || clear.rawDan >= current.rawDan) {
      skillsets[clear.skillset] = {
        rawDan: clear.rawDan, label: clear.level, clears: 1,
        skillsetClear: danCourseCredit(clear),
      };
    } else if (!current.skillsetClear && Math.round(current.rawDan) === Math.round(clear.rawDan)) {
      // A stronger estimate on the credential's own level keeps its number and
      // carries the credential.
      skillsets[clear.skillset] = { ...current, skillsetClear: danCourseCredit(clear) };
    }
  }
  // A practice clear certifies one skill. Keep its tile visible while the side
  // has no quorum.
  if (!quorumDan) {
    if (best) return { ...danSideFromCourseClear(best, side, keyCount), ...(Object.keys(skillsets).length ? { skillsets } : {}) };
    if (!Object.keys(skillsets).length) return null;
    return { rawDan: 0, label: "", clears: 0, skillsetsOnly: true, skillsets };
  }
  const headline = anchoredSkillsetDans(skillsets, clearDans, side, keyCount, danSkillsetBuckets(keyCount, side))
    ?? averageSkillsetDans(skillsets, clearDans, side, keyCount)
    ?? quorumDan;
  const withCourse = applyDanCourseFloor(headline, best, side, keyCount, clearDans);
  // A course-floored headline has no averaging window.
  const windowed = withCourse.courseClear
    ? withCourse
    : { ...withCourse, clearWindow: danHeadlineClearWindow(keyCount, side, grouped, list, infoByBeatmap) };
  return Object.keys(skillsets).length > 0 ? { ...windowed, skillsets } : windowed;
}

/** The tile ids a keymode/side publishes, in declaration order. */
export function danSkillsetBucketIds(keyCount: number, side: "rc" | "ln"): string[] {
  return danSkillsetBuckets(keyCount, side).map((bucket) => bucket.id);
}

/** The tiles an SSR vector files under, with the chart's stored analysis when given. */
export function danSkillsetBucketsForValues(
  keyCount: number,
  side: "rc" | "ln",
  values: Record<string, number>,
  lengthSeconds: number | null = null,
  rate = 1,
  chart?: ChartSkillInfo,
): string[] {
  const top = bucketingSkillset(values, lengthSeconds, rate, chart?.techScore ?? 0, chart?.jackShare ?? null, chart?.handstreamCluster === true, headlineSparesJackVeto(chart));
  return bucketsForClear(danSkillsetBuckets(keyCount, side), top, chart, values, rate).map((bucket) => bucket.id);
}

/** The tile ids one play files under, in filing order (first is primary). */
export function danSkillsetBucketIdsForPlay(keyCount: number, side: "rc" | "ln", play: StoredPlaySsr, chart?: ChartSkillInfo): string[] {
  return danSkillsetBucketsForPlay(danSkillsetBuckets(keyCount, side), play, chart).map((bucket) => bucket.id);
}

// A pre-rated upload bakes its rate into the notes, so its stored length is
// not the 1.0x drain the stamina gate wants. The rate in the diff name counts
// only when another diff in the set has the same keymode, hold count and
// object counts at the predicted length, within 2%. Object counts must match
// exactly because rice diffs all share zero holds.
const RATE_SIBLING_TOLERANCE = 0.02;
const RATE_EDIT_MIN = 1.01;
const RATE_EDIT_MAX = 2.5;
// Matches "1.4x", "x1.05", "[1.15x Rate]" and comma decimals like "1,1x".
const NAMED_RATE_PATTERNS = [
  /(?:^|[^\d.,])(\d(?:[.,]\d{1,3})?)\s*x(?![\w])/i,
  /(?:^|[^\w])x\s*(\d(?:[.,]\d{1,3})?)(?![\d.,])/i,
];

/** The uprate a diff name claims (1.01x-2.5x), or null. */
export function parseNamedRate(version: string): number | null {
  for (const pattern of NAMED_RATE_PATTERNS) {
    const match = pattern.exec(version);
    if (!match) continue;
    const rate = Number(match[1].replace(",", "."));
    if (Number.isFinite(rate) && rate >= RATE_EDIT_MIN && rate <= RATE_EDIT_MAX) return rate;
  }
  return null;
}

/**
 * The 1.0x length in seconds of a confirmed pre-rated 4K upload, or null. Only
 * charts under the stamina gate whose named rate carries them past it qualify.
 * `siblings` is every diff in the set, including the chart.
 */
export function rateEditBaseLength(
  chart: { beatmapId: number; keyCount: number | null; lengthSeconds: number | null; version: string },
  siblings: RateEditSibling[],
): number | null {
  if (chart.keyCount !== 4) return null;
  const length = chart.lengthSeconds;
  const rate = parseNamedRate(chart.version);
  if (length == null || rate == null) return null;
  if (length >= STAMINA_TILE_MIN_LENGTH_SECONDS) return null;
  // Tolerance applies here too because API lengths are whole seconds.
  if (length * rate < STAMINA_TILE_MIN_LENGTH_SECONDS * (1 - RATE_SIBLING_TOLERANCE)) return null;
  const self = siblings.find((entry) => entry.beatmapId === chart.beatmapId);
  if (!self) return null;
  if (self.circleCount + self.sliderCount + self.spinnerCount <= 0) return null;
  const predicted = length * rate;
  const confirmed = siblings
    .filter((entry) =>
      entry.beatmapId !== chart.beatmapId
      && entry.keyCount === self.keyCount
      && entry.lnCount === self.lnCount
      && entry.circleCount === self.circleCount
      && entry.sliderCount === self.sliderCount
      && entry.spinnerCount === self.spinnerCount
      && Math.abs(entry.length - predicted) <= RATE_SIBLING_TOLERANCE * predicted)
    .sort((left, right) =>
      Math.abs(left.length - predicted) - Math.abs(right.length - predicted)
      || left.beatmapId - right.beatmapId)[0];
  return confirmed ? Math.round(confirmed.length) : null;
}

// Player dans go below the 7K LN estimator's 3rd-dan floor. The 7K rice labeler
// prints the same 0-2 levels.
function danLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  return chartDanLabel(rawDan, keyCount === 7 && side === "ln" && rawDan < 2.5 ? "rc" : side, keyCount);
}

/**
 * The rate a clear would read a rate verdict at, or null for 1.0x (the chart's
 * own verdict covers it) or outside the estimator's 50-200% band.
 */
function clearRatePercent(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return null;
  const percent = Math.round(rate * 100);
  if (percent === 100 || percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
  return percent;
}

/** The OD a play was judged at, as the estimator's flag: a DA value first, then HR, then EZ. */
function danOdFlagForPlay(play: StoredPlaySsr): LeoBlackOdFlag | undefined {
  return normalizeDanOdFlag(play.odOverride)
    ?? (play.mods?.includes("HR") ? "HR" : play.mods?.includes("EZ") ? "EZ" : undefined);
}

/** The best-clears mean over a pool, or null under the quorum. */
function danFromClears(clears: DanClearEvidence[], side: "rc" | "ln", keyCount: number, infoByBeatmap: Map<number, ChartSkillInfo>): PlayerSkillDanVerdict | null {
  const needed = danClearAverageWindowFor(side, keyCount);
  const { entries, window, have } = weightedDanClearWindow(clears, infoByBeatmap, needed);
  // The quorum counts selected clears, so many rates of one chart are still two.
  if (entries.length < DAN_CLEAR_QUORUM) return null;
  const counted = window.filter((entry) => !entry.ignoredAsStray);
  const weight = counted.reduce((sum, entry) => sum + entry.weight, 0);
  const rawDan = Math.round(counted.reduce((sum, entry) => sum + entry.clear.creditedDan * entry.weight, 0) / weight * 100) / 100;
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: entries.filter(({ clear }) => clear.creditedDan >= rawDan - DAN_ROUNDING_EPSILON).length,
    clearWindow: { have, need: needed },
    ...(isBeyondDanTable(rawDan, side, keyCount) ? { beyondTable: true } : {}),
  };
}

/**
 * The headline as the mean of the player's rated tile dans. A best-clears mean
 * rates a specialist on their one pattern, while a course asks for a mix.
 * Unrated tiles are left out rather than counted as zero.
 */
function averageSkillsetDans(
  skillsets: Record<string, PlayerSkillDanVerdict>,
  clearDans: number[],
  side: "rc" | "ln",
  keyCount: number,
): PlayerSkillDanVerdict | null {
  const values = Object.values(skillsets).map((verdict) => verdict.rawDan);
  if (values.length < DAN_SKILLSET_AVERAGE_MIN_BUCKETS) return null;
  const rawDan = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: clearDans.filter((value) => value >= rawDan - DAN_ROUNDING_EPSILON).length,
    ...(isBeyondDanTable(rawDan, side, keyCount) ? { beyondTable: true } : {}),
  };
}

/**
 * The headline of a side with an anchor tile. The anchor's dan moves toward
 * the other rated tiles (DAN_ANCHOR_CLAMP, DAN_ANCHOR_PULL) and capped tiles
 * are flagged headlineCapped. Null without a rated anchor or enough tiles.
 */
function anchoredSkillsetDans(
  skillsets: Record<string, PlayerSkillDanVerdict>,
  clearDans: number[],
  side: "rc" | "ln",
  keyCount: number,
  buckets: DanSkillsetBucket[],
): PlayerSkillDanVerdict | null {
  const anchorId = buckets.find((bucket) => bucket.anchor)?.id;
  const anchor = anchorId == null ? undefined : skillsets[anchorId];
  if (anchorId == null || anchor == null) return null;
  const others = Object.entries(skillsets).filter(([id]) => id !== anchorId);
  if (others.length + 1 < DAN_SKILLSET_AVERAGE_MIN_BUCKETS) return null;
  let distance = 0;
  for (const [id, verdict] of others) {
    const raw = verdict.rawDan - anchor.rawDan;
    const capped = Math.max(-DAN_ANCHOR_CLAMP, Math.min(DAN_ANCHOR_CLAMP, raw));
    if (capped !== raw) skillsets[id] = { ...verdict, headlineCapped: true };
    distance += capped;
  }
  const rawDan = Math.round((anchor.rawDan + DAN_ANCHOR_PULL * (distance / others.length)) * 100) / 100;
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: clearDans.filter((value) => value >= rawDan - DAN_ROUNDING_EPSILON).length,
    ...(isBeyondDanTable(rawDan, side, keyCount) ? { beyondTable: true } : {}),
  };
}

/**
 * How full the pools behind a headline are. Each tile wants a full window, so
 * the headline sums them over primary filings.
 */
function danHeadlineClearWindow(
  keyCount: number,
  side: "rc" | "ln",
  grouped: GroupedDanClears,
  sideClears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
): NonNullable<PlayerSkillDanVerdict["clearWindow"]> {
  const need = danClearAverageWindowFor(side, keyCount);
  const pools = grouped.primaryByBucket;
  if (pools.size === 0) return { have: weightedDanClearWindow(sideClears, infoByBeatmap, need).have, need };
  let have = 0;
  let full = 0;
  for (const bucketClears of pools.values()) {
    const filled = weightedDanClearWindow(bucketClears, infoByBeatmap, need).have;
    have += filled;
    if (filled >= need) full += 1;
  }
  return { have, need: need * pools.size, skills: { full, total: pools.size } };
}

/** The strongest credited course run (not a practice credential) on one side. */
function bestDanCourseClear(clears: DanCourseClear[], keyCount: number, side: "rc" | "ln"): DanCourseClear | null {
  let best: DanCourseClear | null = null;
  for (const clear of clears) {
    if (clear.skillset || clear.keyCount !== keyCount || clear.side !== side) continue;
    if (!best || clear.rawDan > best.rawDan) best = clear;
  }
  return best;
}

/**
 * A verified course clear floors the headline and never caps it. Tiles are
 * left alone because a course mixes patterns.
 */
function applyDanCourseFloor(
  headline: PlayerSkillDanVerdict,
  best: DanCourseClear | null,
  side: "rc" | "ln",
  keyCount: number,
  clearDans: number[],
): PlayerSkillDanSide {
  if (!best || !(best.rawDan > headline.rawDan + DAN_ROUNDING_EPSILON)) return headline;
  return {
    ...danVerdictAt(best.rawDan, side, keyCount, clearDans),
    courseClear: danCourseCredit(best),
  };
}

/** A side that exists only because of a course clear. */
function danSideFromCourseClear(best: DanCourseClear, side: "rc" | "ln", keyCount: number): PlayerSkillDanSide {
  return {
    ...danVerdictAt(best.rawDan, side, keyCount, []),
    courseClear: danCourseCredit(best),
  };
}

function danCourseCredit(best: DanCourseClear): NonNullable<PlayerSkillDanSide["courseClear"]> {
  return {
    beatmapId: best.beatmapId,
    courseName: best.courseName,
    level: best.level,
    accuracy: best.accuracy,
    currency: best.currency,
    bar: best.bar,
    ...(best.displayedAccuracy != null ? { displayedAccuracy: best.displayedAccuracy } : {}),
  };
}

function danVerdictAt(rawDan: number, side: "rc" | "ln", keyCount: number, clearDans: number[]): PlayerSkillDanVerdict {
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: clearDans.filter((value) => value >= rawDan - DAN_ROUNDING_EPSILON).length,
    ...(isBeyondDanTable(rawDan, side, keyCount) ? { beyondTable: true } : {}),
  };
}

/** At or above the table's top level, where the estimate is a floor. */
function isBeyondDanTable(rawDan: number, side: "rc" | "ln", keyCount: number): boolean {
  const ceiling = danTableCeilingFor(side, keyCount);
  return ceiling != null && rawDan >= ceiling;
}

// ---------------------------------------------------------------------------
// Skillset tiles

interface DanSkillsetBucket {
  id: string;
  /** Analyzer pattern tags that put a clear in this tile. */
  tags: string[];
  /**
  /** MSD skillsets that file a clear here by the play's strongest skillset. 4K only. */
  skillsets?: string[];
  /**
   * File by a LeoBlack cluster share (CLUSTER_SHARE_MIN) or label, with `tags`
   * as the fallback for charts with no clusters. Cluster importance weighs
   * difficulty, so it says whether the pattern carries the chart.
   */
  clusterFamily?: "jack" | "stream" | "tech";
  /** The side's anchor tile: the headline follows it (anchoredSkillsetDans). */
  anchor?: boolean;
}

interface GroupedDanClears {
  /** Every clear filed into each tile, primary or shared. Tiles average these. */
  byBucket: Map<string, DanClearEvidence[]>;
  /** Clears whose first tile is this one. The quorum counts these. */
  primaryByBucket: Map<string, DanClearEvidence[]>;
}

/**
 * The skill tiles per keymode and side. 4K files by the play's strongest
 * MinaCalc skillset at the played rate. Speed is Stream alone because
 * Jumpstream also fires on dense jumptrill. Jack tags and verified jack demand
 * override the argmax because MinaCalc cannot see speedjack.
 *
 * 6K/7K/8K file by analyzer tags and LeoBlack clusters, overlapping by design,
 * because that calc does not rate Technical. Only 7K has LN tiles.
 */
function danSkillsetBuckets(keyCount: number, side: "rc" | "ln"): DanSkillsetBucket[] {
  if (side === "ln") {
    if (keyCount === 7) {
      return [
        // General also takes the bare "ln" tag, so it holds all LN work and
        // anchors the headline.
        { id: "lngeneral", tags: ["lngeneral", "ln"], anchor: true },
        { id: "lntech", tags: ["lntech"] },
        { id: "lninverse", tags: ["lninverse"] },
        { id: "lnrelease", tags: ["lnrelease"] },
      ];
    }
    return [];
  }
  if (keyCount === 4) {
    return [
      // The jack tile's tags are the analyzer override (bucketsForClear).
      { id: "jack", tags: ["chordjack", "speedjack"], skillsets: ["JackSpeed", "Chordjack"] },
      // Jumpstream pairs with tech only as a fallback. bucketsForClear
      // re-files a Jumpstream argmax by label and runner-up.
      { id: "tech", tags: [], skillsets: ["Technical", "Jumpstream"] },
      { id: "speed", tags: [], skillsets: ["Stream"] },
      { id: "stamina", tags: [], skillsets: ["Handstream", "Stamina"] },
    ];
  }
  return [
    // `tags` is the fallback for the ~1% of charts with no clusters.
    { id: "jack", tags: ["jack"], clusterFamily: "jack" },
    { id: "tech", tags: ["tech"], clusterFamily: "tech" },
    { id: "speed", tags: ["delay"] },
    { id: "stream", tags: ["chordstream", "bracket"], clusterFamily: "stream" },
  ];
}

/** Whether chart analysis places a chart in a tile's tag/cluster arm. */
function chartBelongsToTagBucket(bucket: DanSkillsetBucket, chart: ChartSkillInfo | undefined): boolean {
  // Tech is a whole-chart label. Jack and stream are shares of the chart.
  if (bucket.clusterFamily === "tech") {
    if (chart?.techCategory != null) return chart.techCategory;
  } else if (bucket.clusterFamily != null) {
    const share = bucket.clusterFamily === "jack" ? chart?.jackShare : chart?.streamShare;
    if (share != null) return share >= CLUSTER_SHARE_MIN;
  }
  return (chart?.patterns ?? []).some((tag) => bucket.tags.includes(tag));
}

/**
 * The tiles a play files under, first is primary. Depends only on the play and
 * chart, so it also names the tile of a play that credited nothing.
 */
function danSkillsetBucketsForPlay(
  buckets: DanSkillsetBucket[],
  play: StoredPlaySsr,
  storedChart: ChartSkillInfo | undefined,
): DanSkillsetBucket[] {
  // An Invert play files by what the mod made of the chart.
  const chart = play.inverse ? inverseModChartInfo(storedChart) : storedChart;
  const values = tileValuesForPlay(play, chart);
  const topSkillset = bucketingSkillset(
    values,
    chart?.lengthSeconds ?? null,
    play.rate,
    chart?.techScore ?? 0,
    chart?.jackShare ?? null,
    chart?.handstreamCluster === true,
    headlineSparesJackVeto(chart),
  );
  return bucketsForClear(buckets, topSkillset, chart, values, play.rate);
}

/**
 * The MSD vector a play files by. Falls back to the chart's 1.0x vector when
 * the goal floor left the play none.
 */
function tileValuesForPlay(play: StoredPlaySsr, chart: ChartSkillInfo | undefined): Record<string, number> | undefined {
  if (dominantSkillset(play.values) != null) return play.values;
  return chart?.msdValues ?? play.values;
}

/**
 * Chart facts for an Invert play. Tags and cluster shares describe notes the
 * player never held, so INVERSE_MOD_PATTERNS replaces them.
 */
function inverseModChartInfo(chart: ChartSkillInfo | undefined): ChartSkillInfo | undefined {
  if (!chart) return undefined;
  return {
    ...chart,
    patterns: INVERSE_MOD_PATTERNS,
    jackDemand: false,
    jackShare: null,
    streamShare: null,
    techCategory: null,
    clusterTrill: null,
    handstreamCluster: null,
    jumpstreamCluster: null,
    techScore: 0,
    chordjackScore: 0,
    handstreamEndurance: false,
    msdValues: null,
  };
}

/** A side's clears filed into its tiles (every published tile present, empty lists included). */
function groupDanClearsBySkillset(
  keyCount: number,
  side: "rc" | "ln",
  clears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[],
): GroupedDanClears {
  const buckets = danSkillsetBuckets(keyCount, side);
  const byBucket = new Map<string, DanClearEvidence[]>();
  const primaryByBucket = new Map<string, DanClearEvidence[]>();
  for (const bucket of buckets) {
    byBucket.set(bucket.id, []);
    primaryByBucket.set(bucket.id, []);
  }
  for (const clear of clears) {
    const chart = infoByBeatmap.get(clear.play.beatmapId);
    const filed = danSkillsetBucketsForPlay(buckets, clear.play, chart);
    filed.forEach((bucket, index) => {
      byBucket.get(bucket.id)!.push(clear);
      // Every tag filing is primary. Only 4K's shared second tile is not.
      if (index === 0 || bucket.skillsets == null) primaryByBucket.get(bucket.id)!.push(clear);
    });
  }
  for (const [id, bucketClears] of byBucket) {
    byBucket.set(id, creditSkillsetPracticeClears(bucketClears, courseClears, keyCount, id));
  }
  return { byBucket, primaryByBucket };
}

// Jumpstream arbitration's jack arm. A dense trill uses the chordjack wrist
// motion, so a trill chart at this raw chordjack score files jack. 0.60 splits
// jumptrill charts read as jack (0.65 and up) from tech (0.57 and under).
const TRILL_JACK_MIN_CHORDJACK = 0.60;

// A lighter trill files jack only when LeoBlack's jack clusters back it up,
// since the chordjack score saturates on any dense oscillation. Jack-read
// charts at this score carry 21% or more jack importance.
const TRILL_JACK_CORROBORATED_CHORDJACK = 0.55;
const TRILL_JACK_CORROBORATED_SHARE = 0.15;

// A trill keeps tech unless the file is long enough for endurance to count.
// Then the runner-up skillset decides.
const TRILL_RUNNER_UP_MIN_LENGTH_SECONDS = 240;

// Jack cluster share that keeps a chart off the stamina tile whatever the
// argmax, so a rate mod cannot move it from tech to stamina. Handstream and
// jumpstream packs sit under 0.285 at p95. Every stamina route checks it.
const STAMINA_TILE_JACK_VETO_SHARE = 0.30;

// Stream wins the tile from within this much of the top skillset. At speed
// densities Stream, Stamina and Technical rate alike and the leader is noise.
// At 2.0 hand-labelled tech charts start to flip.
const SPEED_NEAR_TIE_MSD = 1.25;

// Inside the near-tie a speed clear moves to tech when Technical is also
// within SPEED_NEAR_TIE_MSD of Stream and the raw tech score is at least this.
// The 0.5 tag would put most stamina charts on tech.
const TECH_NEAR_TIE_MIN_SCORE = 0.8;

// Second tech arm, for tech-tagged charts under 0.8. Technical must lead
// Stream by this much. One chart uploaded at seven rates leads by 0.35 to
// 0.81, and 0.35 keeps it on one tile at every rate.
const TECH_NEAR_TIE_MSD_LEAD = 0.35;

/**
 * Logistic model for the 4K speed/tech split. Tech oscillates the wrist and
 * speed rolls the fingers across the hands, which the motion shares
 * (classification/motion-features.ts) read better than the ratings. Fitted on
 * 181 packs held out whole, AUC 0.883. Rhythm irregularity is left out
 * because it reads swing on streams as tech.
 */
const SPEED_TECH_MODEL = {
  bias: -0.4458,
  terms: [
    { mean: 0.0509, sd: 0.0463, weight: 1.0015 },  // crossHandTrill
    { mean: 0.0020, sd: 0.0047, weight: 0.8832 },  // miniJack
    { mean: 0.0093, sd: 0.0120, weight: 1.0178 },  // anchor
    { mean: 0.2453, sd: 0.0571, weight: 0.2939 },  // sameHand
    { mean: -0.3798, sd: 0.7222, weight: -0.1484 }, // Technical - Stream
    { mean: 0.3912, sd: 0.1990, weight: 0.8007 },  // analyzer tech score
  ],
} as const;

// Standardised inputs are clipped to this many sd, in the fit and here, so one
// heavy-tailed share cannot decide a chart alone.
const SPEED_TECH_INPUT_CLIP = 3;

// Between these probabilities the chart carries both tiles. The tech side is
// wider because labelled speed charts are the ones a tech call gets wrong
// most. Outside the band the call is right 93.3% of the time.
const SPEED_TECH_DUAL_LOW = 0.35;
const SPEED_TECH_DUAL_HIGH = 0.95;

// How far Stream may sit under the top skillset for the model to decide. It
// was fitted on near-ties and puts clear tech and jumptrill charts on speed
// past this.
const SPEED_TECH_MODEL_MAX_STREAM_GAP = 1.75;

/**
 * MinaCalc's Stamina tracks the strongest sustained base skillset and never
 * wins by more than 0.45%, so a Stamina win only says the file is long. It
 * keeps the tile at 4:00 or longer, and shorter files go under their best base
 * skillset. Handstream-led clears hold the tile at any length.
 */
const STAMINA_TILE_MIN_LENGTH_SECONDS = 240;

/**
 * A 4:00+ Stamina argmax holds the tile against the speed near-tie while
 * Technical, Jumpstream or Handstream sits within this of Stream. On marathons
 * Stream in second is often argmax noise. The jack skillsets stay out because
 * a marathon that reads jack second is not endurance.
 */
const STAMINA_HOLD_BASE_BAND = 0.5;
const STAMINA_HOLD_RIVALS = ["Technical", "Jumpstream", "Handstream"];

/**
 * How far under the top skillset Handstream may sit and still win, on a chart
 * LeoBlack labels handstream. MinaCalc's Handstream moves with accuracy, so
 * without this one chart filed stamina for one player and tech for the next.
 * Must stay under 0.99, the gap on a handstream chart read as tech.
 */
const HANDSTREAM_NEAR_TIE_MSD = 0.95;

/**
 * The tiles one clear belongs to. On 4K, verified jack demand, a jack-read
 * trill or a tile's analyzer tag files the clear outright, else the
 * arbitrated argmax does. resolveTilesForClear may add a second tile. Tag
 * keymodes file by chartBelongsToTagBucket alone.
 */
function bucketsForClear(
  buckets: DanSkillsetBucket[],
  topSkillset: string | null,
  chart: ChartSkillInfo | undefined,
  values: Record<string, number> | undefined,
  rate = 1,
): DanSkillsetBucket[] {
  // Jack demand verified from the notes outranks every MSD argmax.
  if (chart?.jackDemand === true || trillIsJack(chart)) {
    const jack = buckets.find((bucket) => bucket.id === "jack" && bucket.skillsets != null);
    if (jack) return resolveTilesForClear([jack], buckets, chart, values);
  }
  const override = buckets.find(
    (bucket) => bucket.skillsets != null && bucket.tags.length > 0 && chartBelongsToTagBucket(bucket, chart),
  );
  if (override != null) return resolveTilesForClear([override], buckets, chart, values);
  // Accuracy can reorder a play's SSRs without changing the pattern. A
  // handstream-endurance chart with a plain, non-trill label stays on stamina.
  if (chart?.handstreamEndurance === true && chart.techCategory === false
    && chart.clusterTrill === false && !jackContaminated(chart.jackShare, headlineSparesJackVeto(chart))) {
    const stamina = buckets.find((bucket) => bucket.id === "stamina" && bucket.skillsets != null);
    if (stamina) return [stamina];
  }
  // Jumpstream arbitration. MinaCalc's Jumpstream fires on jumptrill,
  // chordstream stamina and fast jumpstream alike.
  // - A trill label keeps tech, or takes the runner-up skillset on a 4:00+ file.
  // - A tech-suffixed label ("Jumpstream Tech") takes the runner-up skillset.
  // - A plain label files stamina at any length unless jack contaminates it.
  // - No label keeps tech.
  const contaminated = jackContaminated(chart?.jackShare ?? null, headlineSparesJackVeto(chart));
  const effectiveTop = topSkillset !== "Jumpstream" || chart?.clusterTrill == null
    ? topSkillset
    : chart.clusterTrill
      ? ((enduranceSeconds(chart.lengthSeconds, rate) ?? 0) >= TRILL_RUNNER_UP_MIN_LENGTH_SECONDS
        ? jumpstreamRunnerUp(values, contaminated)
        : topSkillset)
      : chart.techCategory === true
        ? jumpstreamRunnerUp(values, contaminated)
        : contaminated ? topSkillset : "Stamina";
  const filed = buckets.filter((bucket) => bucket.skillsets
    ? effectiveTop != null && bucket.skillsets.includes(effectiveTop)
    : chartBelongsToTagBucket(bucket, chart));
  return resolveTilesForClear(filed, buckets, chart, values);
}

/**
 * Which 4K tiles a clear ends on. The speed/tech model re-decides speed and
 * tech filings and shares both inside its dual band. A stamina marathon whose
 * base reads tech also files tech. At most two tiles, and only the first
 * counts toward a quorum. Jack filings stay jack-only.
 */
function resolveTilesForClear(
  filed: DanSkillsetBucket[],
  buckets: DanSkillsetBucket[],
  chart: ChartSkillInfo | undefined,
  values: Record<string, number> | undefined,
): DanSkillsetBucket[] {
  if (filed.length !== 1 || filed[0].skillsets == null) return filed;
  const primary = filed[0];
  const add = (id: string): DanSkillsetBucket[] => {
    const sibling = buckets.find((bucket) => bucket.id === id && bucket.skillsets != null);
    return sibling ? [primary, sibling] : filed;
  };

  if (primary.id === "tech" || primary.id === "speed") {
    // The model only decides near-ties and needs a motion reading. Otherwise
    // the MSD filing stands.
    if (streamGap(values) > SPEED_TECH_MODEL_MAX_STREAM_GAP) return filed;
    const modelled = speedTechTiles(values, chart?.motion ?? null, chart?.techScore ?? 0);
    if (!modelled) return filed;
    const decided = buckets.find((bucket) => bucket.id === modelled.primary && bucket.skillsets != null);
    if (!decided) return filed;
    if (!modelled.shared) return [decided];
    const other = buckets.find((bucket) => bucket.id === (modelled.primary === "tech" ? "speed" : "tech") && bucket.skillsets != null);
    return other ? [decided, other] : [decided];
  }

  if (primary.id === "stamina") {
    // A Stamina argmax says the file is long, and the best base skillset says
    // what it is. A Stream or Technical base that the notes read as tech also
    // files tech.
    if (dominantSkillset(values) !== "Stamina") return filed;
    const base = dominantSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS));
    if (base !== "Stream" && base !== "Technical") return filed;
    const modelled = speedTechTiles(values, chart?.motion ?? null, chart?.techScore ?? 0);
    if (!modelled) return filed;
    // Past the near-tie the ratings decide, since the model's clipped inputs
    // cannot see a large lead.
    const lead = Number(values?.Technical ?? 0) - Number(values?.Stream ?? 0);
    if (Math.abs(lead) > SPEED_TECH_MODEL_MAX_STREAM_GAP) return lead > 0 ? add("tech") : filed;
    if (modelled.primary !== "tech") return filed;
    return add("tech");
  }

  return filed;
}

/**
 * The skillset a 4K play files under, starting from its strongest. Handstream
 * endurance, the stamina hold, the handstream and speed near-ties and the jack
 * veto can each move it (see the constants above). A short Stamina argmax falls
 * to the best base skillset. An unknown length is not treated as short.
 */
function bucketingSkillset(
  values: Record<string, number> | undefined,
  lengthSeconds: number | null = null,
  rate = 1,
  chartTechScore = 0,
  chartJackShare: number | null = null,
  chartHandstreamCluster = false,
  jackVetoSpared = false,
): string | null {
  const top = dominantSkillset(values);
  if (top == null) return top;
  if (hasHandstreamEndurance(values) && !jackContaminated(chartJackShare, jackVetoSpared)) return "Handstream";
  const stream = Number(values?.Stream ?? 0);
  const endurance = enduranceSeconds(lengthSeconds, rate);
  const demandsEndurance = endurance != null && endurance >= STAMINA_TILE_MIN_LENGTH_SECONDS;
  // Stamina hold. A near-tie at the top of a marathon is argmax noise.
  if (top === "Stamina" && demandsEndurance
    && staminaHoldRival(values) >= stream - STAMINA_HOLD_BASE_BAND
    && !jackContaminated(chartJackShare, jackVetoSpared)) return top;
  const best = Number(values?.[top] ?? 0);
  // A small loss to another skillset on a handstream-labelled chart is noise.
  // Downrates shift the whole vector by up to 1.92, which this does not cover.
  if (top !== "Handstream" && chartHandstreamCluster && !jackContaminated(chartJackShare, jackVetoSpared)) {
    const handstream = Number(values?.Handstream ?? 0);
    if (handstream > 0 && handstream >= best - HANDSTREAM_NEAR_TIE_MSD) return "Handstream";
  }
  const nearTie = top === "Stream" || (stream > 0 && stream >= best - SPEED_NEAR_TIE_MSD)
    ? "Stream"
    : top;
  if (nearTie === "Stream") {
    const technical = Number(values?.Technical ?? 0);
    const techBacked = chartTechScore >= TECH_NEAR_TIE_MIN_SCORE
      && technical > 0
      && technical >= stream - SPEED_NEAR_TIE_MSD;
    const leadBacked = chartTechScore >= PATTERN_TAG_MIN_SCORE
      && technical > 0
      && technical - stream >= TECH_NEAR_TIE_MSD_LEAD;
    return techBacked || leadBacked ? "Technical" : "Stream";
  }
  // Re-file a jack-contaminated handstream chart without the endurance skillsets.
  if (nearTie === "Handstream" && jackContaminated(chartJackShare, jackVetoSpared)) {
    return bucketingSkillset(pickSkillsets(values, RICE_MSD_SKILLSETS), null, 1, chartTechScore, chartJackShare, chartHandstreamCluster, jackVetoSpared);
  }
  if (nearTie !== "Stamina" || lengthSeconds == null) return nearTie;
  if (demandsEndurance && !jackContaminated(chartJackShare, jackVetoSpared)) return nearTie;
  return bucketingSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS), null, 1, chartTechScore, chartJackShare, chartHandstreamCluster, jackVetoSpared);
}

/**
 * Whether a trill-labelled chart reads as jack. Runs before the argmax because
 * a jack-read trill can rate Technical first, out of the Jumpstream
 * arbitration's reach.
 */
function trillIsJack(chart: ChartSkillInfo | undefined): boolean {
  if (chart?.clusterTrill !== true) return false;
  if (chart.chordjackScore >= TRILL_JACK_MIN_CHORDJACK) return true;
  return chart.chordjackScore >= TRILL_JACK_CORROBORATED_CHORDJACK
    && (chart.jackShare ?? 0) >= TRILL_JACK_CORROBORATED_SHARE;
}

/**
 * Whether jack clusters carry too much of a chart to call it endurance.
 * Handstream and plain jumpstream headlines are spared, since their chords
 * also read as half-time chordjack clusters.
 */
function jackContaminated(jackShare: number | null, headlineSpared = false): boolean {
  if (headlineSpared) return false;
  return jackShare != null && jackShare >= STAMINA_TILE_JACK_VETO_SHARE;
}

/** A handstream headline, or a jumpstream one that names no tech or trill. */
function headlineSparesJackVeto(chart: ChartSkillInfo | undefined): boolean {
  if (!chart) return false;
  if (chart.handstreamCluster === true) return true;
  return chart.jumpstreamCluster === true && chart.techCategory !== true && chart.clusterTrill !== true;
}

/**
 * The strongest skillset besides Jumpstream, for a Jumpstream argmax the label
 * cannot resolve. A jack-contaminated chart skips the endurance skillsets.
 * With nothing else rated it returns Jumpstream.
 */
function jumpstreamRunnerUp(values: Record<string, number> | undefined, contaminated: boolean): string {
  const pool = SKILL_RATING_SKILLSETS.filter((skillset) => skillset !== "Overall"
    && skillset !== "Jumpstream"
    && !(contaminated && (skillset === "Stamina" || skillset === "Handstream")));
  return dominantSkillset(pickSkillsets(values, pool)) ?? "Jumpstream";
}

function staminaHoldRival(values: Record<string, number> | undefined): number {
  return Math.max(...STAMINA_HOLD_RIVALS.map((skillset) => Number(values?.[skillset] ?? 0)));
}

/**
 * How long a play asks for in seconds, the longer of the 1.0x drain and the
 * played duration. Null when the length is unknown.
 */
function enduranceSeconds(lengthSeconds: number | null, rate: number): number | null {
  if (lengthSeconds == null) return null;
  const played = lengthSeconds / (Number.isFinite(rate) && rate > 0 ? rate : 1);
  return Math.max(lengthSeconds, played);
}

/** How far Stream sits under the chart's best MSD skillset. */
function streamGap(values: Record<string, number> | undefined): number {
  const top = dominantSkillset(values);
  if (top == null) return 0;
  return Number(values?.[top] ?? 0) - Number(values?.Stream ?? 0);
}

/** Tech probability from notes and ratings, 0-1. Null without a motion reading. */
function speedTechProbability(
  values: Record<string, number> | undefined,
  motion: MotionFeatures | null,
  techScore: number,
): number | null {
  if (!motion) return null;
  const inputs = [
    motion.crossHandTrill,
    motion.miniJack,
    motion.anchor,
    motion.sameHand,
    Number(values?.Technical ?? 0) - Number(values?.Stream ?? 0),
    techScore,
  ];
  let z = SPEED_TECH_MODEL.bias;
  for (let index = 0; index < inputs.length; index++) {
    const term = SPEED_TECH_MODEL.terms[index];
    const input = Number(inputs[index]);
    if (!Number.isFinite(input)) return null;
    const standardised = (input - term.mean) / term.sd;
    z += term.weight * Math.max(-SPEED_TECH_INPUT_CLIP, Math.min(SPEED_TECH_INPUT_CLIP, standardised));
  }
  return 1 / (1 + Math.exp(-z));
}

/** One tile when the model is sure, both inside its dual band; null without a reading. */
function speedTechTiles(
  values: Record<string, number> | undefined,
  motion: MotionFeatures | null,
  techScore: number,
): { primary: "tech" | "speed"; shared: boolean } | null {
  const probability = speedTechProbability(values, motion, techScore);
  if (probability == null) return null;
  return {
    primary: probability >= 0.5 ? "tech" : "speed",
    shared: probability > SPEED_TECH_DUAL_LOW && probability < SPEED_TECH_DUAL_HIGH,
  };
}
