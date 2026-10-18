import { type ChartSkillInfo, CLUSTER_SHARE_MIN, INVERSE_MOD_PATTERNS, type StoredPlaySsr, DAN_MIN_OD, isUnverifiableRevision, hybridRiceCreditFor, hybridLnCreditFor, ezWindowScale, playedOnLazer, playSlotKey, headlineFromSkillsets, headlineAlwaysFromClears, dominantSkillset, pickSkillsets, BASE_MSD_SKILLSETS, playLnSkillsets, PATTERN_TAG_MIN_SCORE, danSkillsetBucketsForClear, SKILL_RATING_SKILLSETS, hasHandstreamEndurance, RICE_MSD_SKILLSETS } from "./skill-ratings";
import { chartIsLn } from "../dan-estimator/ln-effective";
import type { MotionFeatures } from "../classification/motion-features";
import { calculateScoreV2Accuracy, calculateStableAccuracy, getDisplayedAccuracy, type OscScore } from "../chart/score";
import { danLabelFor as chartDanLabel, danTableCeilingFor, danTableFloorFor } from "../classification/chart-classifier";
import { conservativeVibroAccuracy } from "../vibro/sections";
import { LN_SKILLSET_IDS } from "../ln/skillsets";
import { creditedDanFor, danCreditBelowBarWindowFor } from "./dan-credit";
import type { DanCourseClear, DanCourseCreditOptions } from "./dan-courses";
import type { LeoBlackOdFlag } from "../leoblack/estimator";

function chartBelongsToTagBucket(bucket: DanSkillsetBucket, chart: ChartSkillInfo | undefined): boolean {
  if (bucket.clusterFamily === "tech") {
    if (chart?.techCategory != null) return chart.techCategory;
  } else if (bucket.clusterFamily != null) {
    const share = bucket.clusterFamily === "jack" ? chart?.jackShare : chart?.streamShare;
    if (share != null) return share >= CLUSTER_SHARE_MIN;
  }
  return (chart?.patterns ?? []).some((tag) => bucket.tags.includes(tag));
}

const DAN_CLEAR_QUORUM = 4;

const DAN_KYU_BAND_MAX_RAW_DAN = 1;

export interface DanClearBar {
  accuracy: number;
  currency: "stable" | "v2";
}

const STABLE_EQUIVALENT_V2_BAR_OFFSET = 0.005;

export function danClearBarFor(side: "rc" | "ln", keyCount: number, chartDan?: number): DanClearBar {
  if (keyCount === 4) {
    return side === "ln" ? { accuracy: 0.97, currency: "v2" } : { accuracy: 0.96, currency: "stable" };
  }
  if (side === "ln") return { accuracy: 0.95, currency: "stable" };
  const kyu = chartDan != null && chartDan < DAN_KYU_BAND_MAX_RAW_DAN;
  return { accuracy: kyu ? 0.95 : 0.96, currency: "stable" };
}

export const DAN_COURSE_CREDIT_OPTIONS: DanCourseCreditOptions = {
  barFor: danClearBarFor,
  stableEquivalentV2BarOffset: STABLE_EQUIVALENT_V2_BAR_OFFSET,
};

export function danLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  return chartDanLabel(rawDan, keyCount === 7 && side === "ln" && rawDan < 2.5 ? "rc" : side, keyCount);
}

export interface PlayerSkillDanVerdict {
  skillsetClear?: NonNullable<PlayerSkillDanSide["courseClear"]>;
  rawDan: number;
  label: string;
  clears: number;
  headlineCapped?: boolean;
  beyondTable?: boolean;
  clearWindow?: { have: number; need: number; skills?: { full: number; total: number } };
}

export interface PlayerSkillDanSide extends PlayerSkillDanVerdict {
  skillsetsOnly?: boolean;
  skillsets?: Record<string, PlayerSkillDanVerdict>;
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

function inverseModChartInfo(chart: ChartSkillInfo | undefined): ChartSkillInfo | undefined {
  if (!chart) return undefined;
  return {
    ...chart,
    patterns: INVERSE_MOD_PATTERNS,
    jackDemand: false,
    jackShare: null,
    streamShare: null,
    techCategory: null,
    riceTiles: null,
    clusterTrill: null,
    handstreamCluster: null,
    jumpstreamCluster: null,
    techScore: 0,
    chordjackScore: 0,
    handstreamEndurance: false,
    msdValues: null,
  };
}

const TRILL_JACK_MIN_CHORDJACK = 0.60;

const TRILL_JACK_CORROBORATED_CHORDJACK = 0.55;
const TRILL_JACK_CORROBORATED_SHARE = 0.15;

const TRILL_RUNNER_UP_MIN_LENGTH_SECONDS = 240;

function trillIsJack(chart: ChartSkillInfo | undefined): boolean {
  if (chart?.clusterTrill !== true) return false;
  if (chart.chordjackScore >= TRILL_JACK_MIN_CHORDJACK) return true;
  return chart.chordjackScore >= TRILL_JACK_CORROBORATED_CHORDJACK
    && (chart.jackShare ?? 0) >= TRILL_JACK_CORROBORATED_SHARE;
}

const STAMINA_TILE_JACK_VETO_SHARE = 0.30;

export function computeModeDan(
  keyCount: number,
  plays: StoredPlaySsr[],
  scoresByIdentity: Map<string, OscScore>,
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[] = [],
  rateVerdicts: RateVerdictMap = new Map(),
): PlayerSkillModeDan {
  const clears: Record<"rc" | "ln", DanClearEvidence[]> = { rc: [], ln: [] };
  const collected = collectDanClears(keyCount, plays, scoresByIdentity, infoByBeatmap, rateVerdicts);
  for (const clear of collected) {
    clears[clear.side].push(clear);
  }
  const forSide = (side: "rc" | "ln"): PlayerSkillDanSide | null =>
    danSideFromClears(keyCount, side, clears[side], infoByBeatmap, courseClears);
  return { rc: forSide("rc"), ln: forSide("ln") };
}

export interface DanClearEvidence {
  play: StoredPlaySsr;
  side: "rc" | "ln";
  chartDan: number;
  chartDanLabel: string | null;
  creditedDan: number;
  accuracy: number;
  bar: number;
  currency: "stable" | "v2";
  credential?: { level: string; courseName: string };
  hybridSecondary?: boolean;
}

export function creditSkillsetPracticeClears(
  clears: DanClearEvidence[],
  courseClears: DanCourseClear[],
  keyCount: number,
  skillset: string,
): DanClearEvidence[] {
  const byBeatmap = new Map<number, DanCourseClear>();
  for (const course of courseClears) {
    if (course.skillset !== skillset || course.keyCount !== keyCount) continue;
    if (course.accuracy + 1e-9 < course.bar) continue;
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

export type RateVerdictMap = Map<string, { rawDan: number; side: "rc" | "ln"; displayName?: string | null; stale?: boolean } | null>;

function clearRatePercent(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return null;
  const percent = Math.round(rate * 100);
  if (percent === 100 || percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
  return percent;
}

export function danOdFlagForPlay(play: StoredPlaySsr): RateDanVerdictPair["odFlag"] {
  return normalizeDanOdFlag(play.odOverride)
    ?? (play.mods?.includes("HR") ? "HR" : play.mods?.includes("EZ") ? "EZ" : undefined);
}

export function rateVerdictPairFor(play: StoredPlaySsr): RateDanVerdictPair | null {
  if (!Number.isInteger(play.beatmapId) || play.beatmapId <= 0) return null;
  const odFlag = danOdFlagForPlay(play);
  if (play.inverse || play.vibroAdjustment || odFlag != null) {
    if (!Number.isFinite(play.rate) || play.rate <= 0) return null;
    const percent = Math.round(play.rate * 100);
    if (percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
    return {
      beatmapId: play.beatmapId, ratePercent: percent,
      ...(play.inverse ? { modVariant: INVERSE_MOD_VARIANT }
        : play.vibroAdjustment ? { modVariant: VIBRO_ADJUSTED_VARIANT } : {}),
      ...(odFlag != null ? { odFlag } : {}),
    };
  }
  const ratePercent = clearRatePercent(play.rate);
  return ratePercent == null ? null : { beatmapId: play.beatmapId, ratePercent };
}

export const DAN_MIN_OD_7K_LN = 5;

export const DAN_MIN_OD_4K_LN = 7;

export function danMinOdFor(keyCount: number, side: "rc" | "ln" | null): number {
  if (side === "ln" && keyCount === 7) return DAN_MIN_OD_7K_LN;
  if (side === "ln" && keyCount === 4) return DAN_MIN_OD_4K_LN;
  return DAN_MIN_OD;
}

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

export interface DanClearReject {
  play: StoredPlaySsr;
  reason: DanClearRejectReason;
  side: "rc" | "ln" | null;
  chartDan: number | null;
  chartDanLabel: string | null;
  accuracy: number | null;
  bar: number | null;
  minAccuracy: number | null;
  currency: "stable" | "v2" | null;
  od: number | null;
}

export interface DanClearTarget {
  rawDan: number;
  side: "rc" | "ln";
  label: string | null;
}

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

export function collectDanClears(
  keyCount: number,
  plays: StoredPlaySsr[],
  scoresByIdentity: Map<string, OscScore>,
  infoByBeatmap: Map<number, ChartSkillInfo>,
  rateVerdicts: RateVerdictMap = new Map(),
  rejects?: DanClearReject[],
): DanClearEvidence[] {
  const clears: DanClearEvidence[] = [];
  const turnedAway: DanClearReject[] = [];
  const reject = (
    play: StoredPlaySsr,
    reason: DanClearRejectReason,
    extra: Partial<Omit<DanClearReject, "play" | "reason">> = {},
  ) => {
    if (!rejects) return;
    turnedAway.push({ play, reason, side: null, chartDan: null, chartDanLabel: null, accuracy: null, bar: null, minAccuracy: null, currency: null, od: null, ...extra });
  };
  const rejectPlay = reject;
  for (const play of plays) {
    if (play.neverRated) continue;
    const info = infoByBeatmap.get(play.beatmapId);
    if (!info) {
      reject(play, "chart_unanalyzed");
      continue;
    }
    const target = danClearTargetFor(play, info, keyCount, rateVerdicts);
    const aimed = target
      ? { side: target.side, chartDan: target.rawDan, chartDanLabel: target.label }
      : {};
    if (!info.danEligible) {
      reject(play, "chart_ineligible", aimed);
      continue;
    }
    if (isUnverifiableRevision(play, info)) {
      reject(play, "unverifiable_revision", aimed);
      continue;
    }
    const playOd = play.odOverride ?? info.od;
    const floorSide: "rc" | "ln" | null = play.inverse
      ? "ln"
      : target?.side ?? (chartIsLn(keyCount, { lnRatio: info.lnRatio, lnEffectiveRatio: info.lnEffectiveRatio }) === true ? "ln" : null);
    const hybridRice = hybridRiceCreditFor(play, info, keyCount, target);
    const hybridLn = hybridRice ? null : hybridLnCreditFor(play, info, keyCount, target);
    const hybridOther = hybridRice ? { ...hybridRice, side: "rc" as const } : hybridLn ? { ...hybridLn, side: "ln" as const } : null;
    const otherFloorMet = hybridOther != null && (playOd == null || playOd >= danMinOdFor(keyCount, hybridOther.side));
    const primaryFloorMet = playOd == null || playOd >= danMinOdFor(keyCount, floorSide);
    if (!primaryFloorMet) reject(play, "low_od", { ...aimed, od: playOd });
    if (!primaryFloorMet && !otherFloorMet) continue;
    const score = scoresByIdentity.get(play.identity);
    if (play.ezWindows ?? (score != null && ezWindowScale(score) > 1)) {
      reject(play, "ez_windows", aimed);
      continue;
    }
    const displayed = play.accuracy ?? (score ? getDisplayedAccuracy(score) : null);
    if (typeof displayed !== "number") {
      reject(play, "no_accuracy", aimed);
      continue;
    }
    const playMods = play.mods ?? (score?.mods ?? []).map((mod) => typeof mod === "string" ? mod : String(mod?.acronym ?? ""));
    const v2Displayed = playMods.some((mod) => mod === "SV2" || mod === "V2") || (score != null && playedOnLazer(score));
    const stable = play.stableAccuracy ?? (score ? calculateStableAccuracy(score.statistics ?? {}) || null : null);
    const scoreV2 = play.scoreV2Accuracy ?? (score ? calculateScoreV2Accuracy(score.statistics) || null : null)
      ?? (v2Displayed && stable == null ? displayed : null);
    const isLazerPlay = stable != null && Math.abs(displayed - stable) > 1e-9;
    const push = (rawDan: number | null, side: "rc" | "ln", chartDanLabel: string | null, hybridSecondary = false) => {
      const reject: typeof rejectPlay = hybridSecondary ? () => {} : rejectPlay;
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
        accuracy = stable ?? displayed;
        threshold += STABLE_EQUIVALENT_V2_BAR_OFFSET;
        currency = "stable";
      }
      if (play.vibroAdjustment) accuracy = conservativeVibroAccuracy(accuracy, play.vibroAdjustment.judgementShare);
      const primaryTile = side === "rc" && keyCount === 4
        ? danSkillsetBucketsForPlay(danSkillsetBuckets(keyCount, side), play, info)[0]?.id ?? null
        : null;
      const creditedDan = creditedDanFor(rawDan, accuracy, threshold, side, keyCount, { primaryTile });
      if (creditedDan == null) {
        const floor = Math.round((threshold - danCreditBelowBarWindowFor(side, keyCount)) * 1000) / 1000;
        reject(play, "below_bar", { side, chartDan: rawDan, chartDanLabel, accuracy, bar: threshold, minAccuracy: floor, currency });
        return;
      }
      clears.push({ play, side, chartDan: rawDan, chartDanLabel, creditedDan, accuracy, bar: threshold, currency, ...(hybridSecondary ? { hybridSecondary } : {}) });
    };
    if (!primaryFloorMet) {
    } else if (target) {
      push(target.rawDan, target.side, target.label);
    } else {
      reject(play, "no_chart_dan", aimed);
    }
    if (hybridOther && otherFloorMet) push(hybridOther.rawDan, hybridOther.side, hybridOther.label, true);
  }
  const selected = new Set(selectDanRatingClears(clears, infoByBeatmap));
  const kept = clears.filter((clear) => {
    if (selected.has(clear)) return true;
    if (clear.hybridSecondary) return false;
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

const DAN_CLEAR_AVERAGE_WINDOW = 20;

export function danClearAverageWindowFor(_side: "rc" | "ln", _keyCount: number): number {
  return DAN_CLEAR_AVERAGE_WINDOW;
}

const DAN_STRAY_CLEAR_REFERENCE = 5;
const DAN_STRAY_CLEAR_GAP = 5;
const DAN_STRAY_CLEAR_MAX_IGNORED = 3;

export function danIgnoredStrayCount(sortedDesc: number[]): number {
  const reference = sortedDesc.slice(0, DAN_STRAY_CLEAR_REFERENCE);
  if (reference.length === 0) return 0;
  const cut = reference.reduce((sum, value) => sum + value, 0) / reference.length - DAN_STRAY_CLEAR_GAP;
  const room = Math.min(DAN_STRAY_CLEAR_MAX_IGNORED, sortedDesc.length - DAN_CLEAR_QUORUM);
  let ignored = 0;
  while (ignored < room && sortedDesc[sortedDesc.length - 1 - ignored] < cut) ignored += 1;
  return ignored;
}

export interface WeightedDanClear {
  clear: DanClearEvidence;
  repeatWeight: number;
  weight: number;
  ignoredAsStray: boolean;
}

export function compareDanClears(left: DanClearEvidence, right: DanClearEvidence): number {
  return right.creditedDan - left.creditedDan
    || left.play.beatmapId - right.play.beatmapId
    || right.play.rate - left.play.rate
    || Number(left.play.inverse === true) - Number(right.play.inverse === true)
    || left.play.identity.localeCompare(right.play.identity);
}

export function selectDanRatingClears(
  clears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
): DanClearEvidence[] {
  const slots = new Set<string>();
  const families = new Set<string>();
  return [...clears].sort(compareDanClears).filter((clear) => {
    const { play, side } = clear;
    const slot = `${play.keyCount}:${side}:${play.ratingSlot ?? playSlotKey(play.beatmapId, play.rate, play.inverse)}`;
    if (slots.has(slot)) return false;
    slots.add(slot);
    const family = infoByBeatmap.get(play.beatmapId)?.chartFamily ?? play.chartFamily ?? `beatmap:${play.beatmapId}`;
    const key = `${play.keyCount}:${side}:${family}:${play.inverse === true}`;
    if (families.has(key)) return false;
    families.add(key);
    return true;
  });
}

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

function danFromClears(clears: DanClearEvidence[], side: "rc" | "ln", keyCount: number, infoByBeatmap: Map<number, ChartSkillInfo>): PlayerSkillDanVerdict | null {
  const needed = danClearAverageWindowFor(side, keyCount);
  const { entries, window, have } = weightedDanClearWindow(clears, infoByBeatmap, needed);
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

const DAN_ROUNDING_EPSILON = 0.005;

export const DAN_SKILLSET_AVERAGE_MIN_BUCKETS = 2;

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

const DAN_ANCHOR_CLAMP = 2;
const DAN_ANCHOR_PULL = 0.5;

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
    if (clear.accuracy + 1e-9 < clear.bar) {
      if (current && clear.rawDan > current.rawDan) {
        skillsets[clear.skillset] = {
          ...current,
          rawDan: clear.rawDan, label: danLabelFor(clear.rawDan, side, keyCount),
          skillsetClear: danCourseCredit(clear),
        };
      }
      continue;
    }
    if (!current || clear.rawDan >= current.rawDan) {
      skillsets[clear.skillset] = {
        rawDan: clear.rawDan, label: clear.level, clears: 1,
        skillsetClear: danCourseCredit(clear),
      };
    } else if (!current.skillsetClear && Math.round(current.rawDan) === Math.round(clear.rawDan)) {
      skillsets[clear.skillset] = { ...current, skillsetClear: danCourseCredit(clear) };
    }
  }
  if (!quorumDan) {
    if (best) return { ...danSideFromCourseClear(best, side, keyCount), ...(Object.keys(skillsets).length ? { skillsets } : {}) };
    if (!Object.keys(skillsets).length) return null;
    return { rawDan: 0, label: "", clears: 0, skillsetsOnly: true, skillsets };
  }
  const fromSkillsets = headlineFromSkillsets(keyCount, side, Object.keys(skillsets).length);
  const headline = (fromSkillsets
    ? anchoredSkillsetDans(skillsets, clearDans, side, keyCount, danSkillsetBuckets(keyCount, side))
      ?? averageSkillsetDans(skillsets, clearDans, side, keyCount)
    : null) ?? quorumDan;
  const withCourse = applyDanCourseFloor(headline, best, side, keyCount, clearDans);
  const windowed = withCourse.courseClear
    ? withCourse
    : { ...withCourse, clearWindow: danHeadlineClearWindow(keyCount, side, grouped, list, infoByBeatmap) };
  return Object.keys(skillsets).length > 0 ? { ...windowed, skillsets } : windowed;
}

function danHeadlineClearWindow(
  keyCount: number,
  side: "rc" | "ln",
  grouped: GroupedDanClears,
  sideClears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
): NonNullable<PlayerSkillDanVerdict["clearWindow"]> {
  const need = danClearAverageWindowFor(side, keyCount);
  const pools = grouped.primaryByBucket;
  if (pools.size === 0 || headlineAlwaysFromClears(keyCount, side)) return { have: weightedDanClearWindow(sideClears, infoByBeatmap, need).have, need };
  let have = 0;
  let full = 0;
  for (const bucketClears of pools.values()) {
    const filled = weightedDanClearWindow(bucketClears, infoByBeatmap, need).have;
    have += filled;
    if (filled >= need) full += 1;
  }
  return { have, need: need * pools.size, skills: { full, total: pools.size } };
}

function bestDanCourseClear(clears: DanCourseClear[], keyCount: number, side: "rc" | "ln"): DanCourseClear | null {
  let best: DanCourseClear | null = null;
  for (const clear of clears) {
    if (clear.skillset || clear.keyCount !== keyCount || clear.side !== side) continue;
    if (!best || clear.rawDan > best.rawDan) best = clear;
  }
  return best;
}

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

function isBeyondDanTable(rawDan: number, side: "rc" | "ln", keyCount: number): boolean {
  const ceiling = danTableCeilingFor(side, keyCount);
  return ceiling != null && rawDan >= ceiling;
}

export const DAN_MIN_OD_FLOOR = DAN_MIN_OD;

export interface DanSkillsetBucket {
  id: string;
  tags: string[];
  skillsets?: string[];
  clusterFamily?: "jack" | "stream" | "tech";
  anchor?: boolean;
}

function danSkillsetBuckets(keyCount: number, side: "rc" | "ln"): DanSkillsetBucket[] {
  if (side === "ln") {
    if (keyCount === 4) return LN_SKILLSET_IDS.map(id => ({ id, tags: [id] }));
    if (keyCount === 7) {
      return [
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
      { id: "jack", tags: ["chordjack", "speedjack"], skillsets: ["JackSpeed", "Chordjack"] },
      { id: "tech", tags: [], skillsets: ["Technical", "Jumpstream"] },
      { id: "speed", tags: [], skillsets: ["Stream"] },
      { id: "stamina", tags: [], skillsets: ["Handstream", "Stamina"] },
    ];
  }
  return [
    { id: "jack", tags: ["jack"], clusterFamily: "jack" },
    { id: "tech", tags: ["tech"], clusterFamily: "tech" },
    { id: "speed", tags: ["delay"] },
    { id: "stream", tags: ["chordstream", "bracket"], clusterFamily: "stream" },
  ];
}

export function danSkillsetBucketIds(keyCount: number, side: "rc" | "ln"): string[] {
  return danSkillsetBuckets(keyCount, side).map((bucket) => bucket.id);
}

function bucketsForClear(
  buckets: DanSkillsetBucket[],
  topSkillset: string | null,
  chart: ChartSkillInfo | undefined,
  values: Record<string, number> | undefined,
  rate = 1,
): DanSkillsetBucket[] {
  if (chart?.jackDemand === true || trillIsJack(chart)) {
    const jack = buckets.find((bucket) => bucket.id === "jack" && bucket.skillsets != null);
    if (jack) return resolveTilesForClear([jack], buckets, chart, values);
  }
  const override = buckets.find(
    (bucket) => bucket.skillsets != null && bucket.tags.length > 0 && chartBelongsToTagBucket(bucket, chart),
  );
  if (override != null) return resolveTilesForClear([override], buckets, chart, values);
  if (chart?.handstreamEndurance === true && chart.techCategory === false
    && chart.clusterTrill === false && !jackContaminated(chart.jackShare, headlineSparesJackVeto(chart))) {
    const stamina = buckets.find((bucket) => bucket.id === "stamina" && bucket.skillsets != null);
    if (stamina) return [stamina];
  }
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
  const riceTiles = chart?.riceTiles;
  const filed = riceTiles != null && riceTiles.some((id) => buckets.some((bucket) => bucket.id === id))
    ? riceTiles.flatMap((id) => buckets.filter((bucket) => bucket.id === id && bucket.skillsets == null))
    : buckets.filter((bucket) => bucket.skillsets
      ? effectiveTop != null && bucket.skillsets.includes(effectiveTop)
      : chartBelongsToTagBucket(bucket, chart));
  return resolveTilesForClear(filed, buckets, chart, values);
}

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
    if (dominantSkillset(values) !== "Stamina") return filed;
    const base = dominantSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS));
    if (base !== "Stream" && base !== "Technical") return filed;
    const modelled = speedTechTiles(values, chart?.motion ?? null, chart?.techScore ?? 0);
    if (!modelled) return filed;
    const lead = Number(values?.Technical ?? 0) - Number(values?.Stream ?? 0);
    if (Math.abs(lead) > SPEED_TECH_MODEL_MAX_STREAM_GAP) return lead > 0 ? add("tech") : filed;
    if (modelled.primary !== "tech") return filed;
    return add("tech");
  }

  return filed;
}

interface GroupedDanClears {
  byBucket: Map<string, DanClearEvidence[]>;
  primaryByBucket: Map<string, DanClearEvidence[]>;
}

export function danSkillsetBucketsForPlay(
  buckets: DanSkillsetBucket[],
  play: StoredPlaySsr,
  storedChart: ChartSkillInfo | undefined,
): DanSkillsetBucket[] {
  if (play.keyCount === 4 && buckets.some(bucket => bucket.id === "lnhybrid")) {
    const skillsets = playLnSkillsets(play.lnSkill, play.rate, play.inverse ? undefined : storedChart);
    if (skillsets) {
      return buckets.filter(bucket => Number(skillsets[bucket.id as typeof LN_SKILLSET_IDS[number]] ?? 0) >= PATTERN_TAG_MIN_SCORE);
    }
  }
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

function tileValuesForPlay(play: StoredPlaySsr, chart: ChartSkillInfo | undefined): Record<string, number> | undefined {
  if (dominantSkillset(play.values) != null) return play.values;
  return chart?.msdValues ?? play.values;
}

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
    const filed = danSkillsetBucketsForClear(buckets, clear, chart);
    filed.forEach((bucket, index) => {
      byBucket.get(bucket.id)!.push(clear);
      if (index === 0 || bucket.skillsets == null) primaryByBucket.get(bucket.id)!.push(clear);
    });
  }
  for (const [id, bucketClears] of byBucket) {
    byBucket.set(id, creditSkillsetPracticeClears(bucketClears, courseClears, keyCount, id));
  }
  return { byBucket, primaryByBucket };
}

const SPEED_NEAR_TIE_MSD = 1.25;

const TECH_NEAR_TIE_MIN_SCORE = 0.8;

const TECH_NEAR_TIE_MSD_LEAD = 0.35;

const SPEED_TECH_MODEL = {
  bias: -0.4458,
  terms: [
    { mean: 0.0509, sd: 0.0463, weight: 1.0015 },
    { mean: 0.0020, sd: 0.0047, weight: 0.8832 },
    { mean: 0.0093, sd: 0.0120, weight: 1.0178 },
    { mean: 0.2453, sd: 0.0571, weight: 0.2939 },
    { mean: -0.3798, sd: 0.7222, weight: -0.1484 },
    { mean: 0.3912, sd: 0.1990, weight: 0.8007 },
  ],
} as const;

const SPEED_TECH_INPUT_CLIP = 3;

const SPEED_TECH_DUAL_LOW = 0.35;
const SPEED_TECH_DUAL_HIGH = 0.95;

const SPEED_TECH_MODEL_MAX_STREAM_GAP = 1.75;

function streamGap(values: Record<string, number> | undefined): number {
  const top = dominantSkillset(values);
  if (top == null) return 0;
  return Number(values?.[top] ?? 0) - Number(values?.Stream ?? 0);
}

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

const STAMINA_TILE_MIN_LENGTH_SECONDS = 240;

const STAMINA_HOLD_BASE_BAND = 0.5;

const STAMINA_HOLD_RIVALS = ["Technical", "Jumpstream", "Handstream"];
function staminaHoldRival(values: Record<string, number> | undefined): number {
  return Math.max(...STAMINA_HOLD_RIVALS.map((skillset) => Number(values?.[skillset] ?? 0)));
}

const HANDSTREAM_NEAR_TIE_MSD = 0.95;

function jackContaminated(jackShare: number | null, headlineSpared = false): boolean {
  if (headlineSpared) return false;
  return jackShare != null && jackShare >= STAMINA_TILE_JACK_VETO_SHARE;
}

function headlineSparesJackVeto(chart: ChartSkillInfo | undefined): boolean {
  if (!chart) return false;
  if (chart.handstreamCluster === true) return true;
  return chart.jumpstreamCluster === true && chart.techCategory !== true && chart.clusterTrill !== true;
}

function jumpstreamRunnerUp(values: Record<string, number> | undefined, contaminated: boolean): string {
  const pool = SKILL_RATING_SKILLSETS.filter((skillset) => skillset !== "Overall"
    && skillset !== "Jumpstream"
    && !(contaminated && (skillset === "Stamina" || skillset === "Handstream")));
  return dominantSkillset(pickSkillsets(values, pool)) ?? "Jumpstream";
}

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
  if (top === "Stamina" && demandsEndurance
    && staminaHoldRival(values) >= stream - STAMINA_HOLD_BASE_BAND
    && !jackContaminated(chartJackShare, jackVetoSpared)) return top;
  const best = Number(values?.[top] ?? 0);
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
  if (nearTie === "Handstream" && jackContaminated(chartJackShare, jackVetoSpared)) {
    return bucketingSkillset(pickSkillsets(values, RICE_MSD_SKILLSETS), null, 1, chartTechScore, chartJackShare, chartHandstreamCluster, jackVetoSpared);
  }
  if (nearTie !== "Stamina" || lengthSeconds == null) return nearTie;
  if (demandsEndurance && !jackContaminated(chartJackShare, jackVetoSpared)) return nearTie;
  return bucketingSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS), null, 1, chartTechScore, chartJackShare, chartHandstreamCluster, jackVetoSpared);
}

function enduranceSeconds(lengthSeconds: number | null, rate: number): number | null {
  if (lengthSeconds == null) return null;
  const played = lengthSeconds / (Number.isFinite(rate) && rate > 0 ? rate : 1);
  return Math.max(lengthSeconds, played);
}

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

const RATE_SIBLING_TOLERANCE = 0.02;
const RATE_EDIT_MIN = 1.01;
const RATE_EDIT_MAX = 2.5;

const NAMED_RATE_PATTERNS = [
  /(?:^|[^\d.,])(\d(?:[.,]\d{1,3})?)\s*x(?![\w])/i,
  /(?:^|[^\w])x\s*(\d(?:[.,]\d{1,3})?)(?![\d.,])/i,
];

export function parseNamedRate(version: string): number | null {
  for (const pattern of NAMED_RATE_PATTERNS) {
    const match = pattern.exec(version);
    if (!match) continue;
    const rate = Number(match[1].replace(",", "."));
    if (Number.isFinite(rate) && rate >= RATE_EDIT_MIN && rate <= RATE_EDIT_MAX) return rate;
  }
  return null;
}

export const MIN_RATE_PERCENT = 50;
export const MAX_RATE_PERCENT = 200;

export type DanChartVariant = "IN" | "vibro-adjusted";
export const INVERSE_MOD_VARIANT = "IN" satisfies DanChartVariant;
export const VIBRO_ADJUSTED_VARIANT = "vibro-adjusted" satisfies DanChartVariant;

export function normalizeDanOdFlag(value: unknown): LeoBlackOdFlag | undefined {
  if (value === "HR" || value === "EZ") return value;
  return typeof value === "number" && Number.isFinite(value) && value >= -15 && value <= 15
    ? (Object.is(value, -0) ? 0 : value) : undefined;
}

function storedDanVariant(modVariant?: DanChartVariant, odFlag?: LeoBlackOdFlag): string | undefined {
  return odFlag == null ? modVariant : `${modVariant ? `${modVariant}:` : ""}OD:${odFlag}`;
}

export function rateDanVerdictKey(beatmapId: number, ratePercent: number, modVariant?: DanChartVariant, odFlag?: LeoBlackOdFlag): string {
  const variant = storedDanVariant(modVariant, odFlag);
  return `${beatmapId}:${ratePercent}${variant ? `:${variant}` : ""}`;
}

export interface RateDanVerdictPair {
  beatmapId: number;
  ratePercent: number;
  modVariant?: DanChartVariant;
  odFlag?: LeoBlackOdFlag;
}

export interface RateEditSibling {
  beatmapId: number;
  keyCount: number;
  lnCount: number;
  length: number;
  circleCount: number;
  sliderCount: number;
  spinnerCount: number;
}

export function danSkillsetBucketIdsForPlay(keyCount: number, side: "rc" | "ln", play: StoredPlaySsr, chart?: ChartSkillInfo): string[] {
  return danSkillsetBucketsForPlay(danSkillsetBuckets(keyCount, side), play, chart).map((bucket) => bucket.id);
}

export function rateEditBaseLength(
  chart: { beatmapId: number; keyCount: number | null; lengthSeconds: number | null; version: string },
  siblings: RateEditSibling[],
): number | null {
  if (chart.keyCount !== 4) return null;
  const length = chart.lengthSeconds;
  const rate = parseNamedRate(chart.version);
  if (length == null || rate == null) return null;
  if (length >= STAMINA_TILE_MIN_LENGTH_SECONDS) return null;
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
