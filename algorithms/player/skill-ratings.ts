// Etterna-style player skill ratings. Each eligible play gets MinaCalc SSRs at
// its music rate, with its estimated Wife3 accuracy as the goal. The best play
// per (chart, rate, Invert) slot counts, and each keymode's SSRs aggregate with
// Etterna's erfc rating aggregation. Dan clears are in dan-clears.ts.
//
// The goal is Wife3 because osu! accuracy weighs MAX and 300 the same, so most
// top plays sit at 97%+ and would hit MinaCalc's 0.965 goal cap. Goals above
// the cap are extrapolated from the calc's own 0.93 -> 0.965 slope.
//
// 6K, 7K and 8K publish per-pattern ratings in the analyzer's vocabulary
// instead of MinaCalc's 4K-born skillsets.
import { isLazerScore, type OscScore, type OsuMod, type OsuScoreStatistics } from "../chart/score";
import { parseManiaBeatmap } from "../chart/beatmap";
import { invertManiaOsuText } from "../chart/invert";
import type { MotionFeatures } from "../classification/motion-features";
import { LN_EFFECTIVE_KEY_COUNTS, chartIsLn, lnTailPassText } from "../dan-estimator/ln-effective";
import { isLnSkillSupported, type LnSkillResult } from "../ln/skill";
import { SSR_CALC_GOAL_CAP, SSR_EXTRAPOLATION_BASE_GOAL, SSR_EXTRAPOLATION_MAX_SLOPE, analyzeLnSsr } from "../ln/ssr";
import { LN_TAIL_BLEND_BY_KEYMODE, LN_TAIL_MIN_RATIO, blendLnTailValues, computeMsd, isMsdSupportedKeyCount, msdChartErrorFallback } from "../msd/msd";
import { detectRateVibro } from "../vibro/detection";
import { analyzeVibroSections, conservativeVibroAccuracy, usesSectionVibro, type VibroAnalysis } from "../vibro/sections";
import { DAN_MIN_OD_7K_LN, DAN_MIN_OD_FLOOR, danMinOdFor } from "./dan-clears";
import {
  WIFE3_MISS_POINTS,
  erf,
  estimateManiaWifeAccuracy,
  estimateManiaWifeAccuracyFromAccuracy,
  wife3PointsAt,
  type WifeCalibrationOptions,
} from "./wife-calibration";

export const SKILL_RATING_SKILLSETS = [
  "Overall",
  "Stream",
  "Jumpstream",
  "Handstream",
  "Stamina",
  "JackSpeed",
  "Chordjack",
  "Technical",
] as const;

/**
 * Keymodes whose skill card uses the analyzer's pattern names instead of
 * MinaCalc's skillsets, and which get the derived jack tag. 8K shares 7K's
 * vocabulary. Pattern ratings are computed for every keymode.
 */
export const PATTERN_AXIS_KEY_COUNTS: ReadonlySet<number> = new Set([6, 7, 8]);

/** The published pattern axes. The jack tag absorbs chordjack, so it has no axis. */
export const PLAYER_SKILL_PATTERN_AXES = [
  "chordstream",
  "bracket",
  "delay",
  "stream",
  "jack",
  "tech",
  "ln",
] as const;

/**
 * The calc's goal floor. Plays at or below it get no SSR, since clamping up to
 * 0.8 would rate a scraped pass on a hard chart near full MSD. They stay as
 * dan evidence.
 */
export const SSR_GOAL_MIN = 0.8;

/**
 * Ceiling for judgement-backed goals. An all-MAX play estimates about 0.998,
 * and the extrapolation past 0.965 is only trusted about one slope window out.
 */
const SSR_GOAL_CAP = 0.9975;

/** OD assumed when neither the score nor the chart states one. */
const ASSUMED_OD = 8;

/** Etterna's rating_scaler from ScoreManager::CalcPlayerRating. */
const AGGREGATE_RATING_SCALER = 1.04;

/**
 * EZ scales every mania hit window by 1.4 and HR by 1/1.4 in both clients.
 * Older lazer plays shifted OD instead, which this approximates.
 */
const EZ_WINDOW_SCALE = 1.4;

/** The acronym of lazer's Invert mod. */
export const INVERSE_MOD_VARIANT = "IN";

/**
 * Keymodes an Invert play is rated on. 7K has an inverse LN tile. 4K LN
 * verdicts come from LeoBlack, which is unchecked on inverted charts.
 */
const INVERSE_MOD_KEY_COUNTS = new Set([7]);

/**
 * Tags an Invert play carries instead of its chart's. The bare "ln" tag also
 * files it under the 7K LN General tile.
 */
export const INVERSE_MOD_PATTERNS = ["ln", "lninverse"];

/**
 * Mods that change the chart the play describes, so the play is skipped. Hold
 * Off turns holds into taps and No Release frees every tail. Invert is handled
 * by rating the inverted chart, and Difficulty Adjust only moves OD.
 */
const CHART_REWRITING_MODS = new Set(["HO", "NR"]);

const PATTERN_RATING_MIN_PLAYS = 3;

// Analysis stores patterns down to trace hits, so common tags would land on
// nearly every chart. A chart counts toward a pattern only above this score.
export const PATTERN_TAG_MIN_SCORE = 0.5;

// The detector reads dense 7K chordstream as chordjack. At 0.8, 87% of 7K
// jack-pack charts stay tagged against 3 of 100 stream-pack charts.
const CHORDJACK_TAG_MIN_SCORE = 0.8;

// Delay under-fires and is the only signal behind the 6K/7K speed tile. 0.25
// means 27.5% of rows off the 16th grid, which keeps 96% of delay-pack charts
// and 1% of stream charts.
const DELAY_TAG_MIN_SCORE = 0.25;

/**
 * Share of LeoBlack cluster importance a family needs for a chart to count as
 * jack or stream. At 0.4 it keeps 118 of 131 7K jack-pack charts and no stream
 * charts. Lower lets in chordstream with half-BPM jacks.
 */
export const CLUSTER_SHARE_MIN = 0.4;

// The LeoBlack cluster families the rules read.
const JACK_CLUSTERS = /jack/i;
const STREAM_CLUSTERS = /stream/i;
const CHORDSTREAM_CLUSTERS = /chordstream/i;

// Patterns in LeoBlack's headline label for the whole chart. Tech has no
// cluster of its own and only shows up as a label suffix.
const TECH_CLUSTER_CATEGORY = /tech/i;
// 4K players call trills tech even when MinaCalc rates them Jumpstream.
const TRILL_CLUSTER_CATEGORY = /trill/i;
const HANDSTREAM_CLUSTER_CATEGORY = /handstream/i;
const JUMPSTREAM_CLUSTER_CATEGORY = /jumpstream/i;

/**
 * The whole-LN tag plus the four LN subtypes. Each needs the chart to read LN
 * by identity (chartIsLn), since the ln score follows hold pressure and fires
 * on rice charts with a short hold section.
 */
const LN_PATTERN_IDS = new Set(["ln", "lngeneral", "lnrelease", "lninverse", "lntech"]);

// MinaCalc only rates Technical on 4K and 5K. Other keymodes return a flat
// stub for it, so it is computed but not published.
const TECHNICAL_KEY_COUNTS: ReadonlySet<number> = new Set([4, 5]);

/** The base skillsets Stamina sits on top of. */
export const BASE_MSD_SKILLSETS: string[] = SKILL_RATING_SKILLSETS.filter(
  (skillset) => skillset !== "Overall" && skillset !== "Stamina",
);

/** Base skillsets for a jack-heavy chart, without the endurance readings. */
export const RICE_MSD_SKILLSETS: string[] = SKILL_RATING_SKILLSETS.filter(
  (skillset) => skillset !== "Overall" && skillset !== "Stamina" && skillset !== "Handstream",
);

/** One mod as it arrives: an API mod object, or a bare acronym. */
export type ModInput = OsuMod | string;

/** The score fields the goal and eligibility rules read. */
export interface SkillScore {
  /** The accuracy the client recorded (0-1). */
  accuracy: number;
  statistics?: OsuScoreStatistics | null;
  /** "solo_score" for lazer submissions; any other type is a legacy submission. */
  type?: string | null;
  legacy_score_id?: number | null;
  legacy_total_score?: number | null;
  mods?: ModInput[];
  /** The rate of a stored play whose mods no longer carry it. */
  retainedRate?: number;
  /** Explicit client provenance; "unknown" is never inferred. */
  wifeScoring?: "stable" | "lazer" | "unknown";
}

/** Verified facts about the chart file, needed before a goal is trusted. */
export interface SsrChartFacts {
  keyCount: number;
  nativeMania: boolean;
  rate: number;
}

/** One play as the rating and dan rules read it. */
export interface StoredPlaySsr {
  /** Score identity ("official:<score id>"). */
  identity: string;
  beatmapId: number;
  /** Note-verified family of uniformly rated reuploads; never a difficulty input. */
  chartFamily?: string | null;
  keyCount: number;
  rate: number;
  /** Press/hold Wife3 goal the SSR was computed at. */
  goal: number;
  /** Release-aware goal for the separate LN rating. */
  lnGoal?: number;
  pp: number;
  /** SSR per skillset (SKILL_RATING_SKILLSETS, plus "LN" on LN-rated keymodes). */
  values: Record<string, number>;
  /** Pattern tags of the chart at this play's rate (playPatternsFor). */
  patterns: string[];
  /** "top" when the play came from the player's pp-ranked top plays. */
  source?: "top" | "tracked";
  /** The accuracy the client displayed. */
  accuracy?: number;
  /**
   * Stable-formula accuracy from the judgement counts, MAX counted as 300.
   * Both clients share it for rice. Null when counts are gone.
   */
  stableAccuracy?: number | null;
  /** 305-weighted ScoreV2 accuracy from the counts, used by the 4K LN ladder. */
  scoreV2Accuracy?: number | null;
  /** Every mod acronym; [] is known NoMod, undefined is unknown. */
  mods?: string[];
  /** EZ widened the play's hit windows; such plays credit no dan. */
  ezWindows?: boolean;
  /** The OD Difficulty Adjust set, when it moved the slider. */
  odOverride?: number | null;
  /** Section vibro removed part of the chart from the rating. */
  vibroAdjustment?: Pick<VibroAnalysis, "excludedDurationMs" | "timeShare" | "noteShare" | "judgementShare">;
  /** The independent LN rating and identity at this play's keycount/rate/OD/goal. */
  lnSkill?: LnSkillResult;
  /** Set under Invert: rated against the inverted chart, in a slot of its own. */
  inverse?: boolean;
  /** No valid SSR; kept as dan evidence only. */
  ratingExcluded?: boolean;
  /** Replaces the chart/rate slot for evidence with no osu! beatmap id. */
  ratingSlot?: string;
  /**
   * A more accurate attempt at a slot rated on another score. Dan evidence
   * only, see pickDanAttempts.
   */
  danAttempt?: boolean;
  /** A placeholder for a play not yet rated; neither a clear nor a refusal. */
  neverRated?: boolean;
  /**
   * The chart changed after this play and no revision check can settle it.
   * Set outside these rules.
   */
  unverifiableRevision?: boolean;
}

/**
 * Per-chart facts the rules read, derived from the chart analysis
 * (chartSkillInfoFromAnalysis) plus the beatmap's metadata.
 */
export interface ChartSkillInfo {
  /** Verified note layout shared by uniformly rated reuploads. */
  chartFamily?: string | null;
  patterns: string[];
  /** LN tags before the identity gate, for HT/custom-rate promotion. */
  lnPatterns?: string[];
  /** Structurally detected 4K quadstream/minijack/jack-marathon demand. */
  jackDemand?: boolean;
  /** Share of LeoBlack cluster importance on jack / stream clusters; null without clusters. */
  jackShare: number | null;
  streamShare: number | null;
  /** Whether LeoBlack's headline label carries "Tech"; null when no label. */
  techCategory: boolean | null;
  /** Whether that label names a trill; null when no label. */
  clusterTrill: boolean | null;
  /** Whether that label names handstream; null when no label. */
  handstreamCluster: boolean | null;
  /** Whether that label names jumpstream; null when no label. */
  jumpstreamCluster: boolean | null;
  /** Stamina leads the chart's MSD, with Handstream the strongest base skill. */
  handstreamEndurance?: boolean;
  /** The chart's own MSD vector at 1.0x (4K rice), the tile fallback for a play with no SSRs. */
  msdValues?: Record<string, number> | null;
  /** The analyzer's raw tech score at 1.0x, zeroed when the jack veto strips the tag. */
  techScore: number;
  /** The analyzer's raw chordjack score. */
  chordjackScore: number;
  /** Wrist-versus-roll note shares at 1.0x (4K only); null when not measured. */
  motion?: MotionFeatures | null;
  /** Hold-note share of the chart (0-1). */
  lnRatio: number | null;
  /** Effective LN share at 1.0x (ln-effective.ts); null when not measured. */
  lnEffectiveRatio: number | null;
  /** The rating tiebreak decided the chart's LN identity at 1.0x / 1.5x / 0.75x. */
  lnRatingIdentity?: boolean;
  dtLnRatingIdentity?: boolean;
  htLnRatingIdentity?: boolean;
  /** Effective LN share at 1.5x / 0.75x. */
  dtLnEffectiveRatio: number | null;
  htLnEffectiveRatio: number | null;
  /** The chart as a whole reads as vibro at 1.0x. */
  vibro: boolean;
  /** False when the chart's object structure makes its dan verdict unsafe as player evidence. */
  danEligible: boolean;
  /** Stored dan verdicts per half at 1.0x, and the primary verdict at 1.5x / 0.75x. */
  rcRawDan: number | null;
  lnRawDan: number | null;
  /** The printed label per half, the words the maps pages show. */
  rcDanLabel: string | null;
  lnDanLabel: string | null;
  dtRawDan: number | null;
  dtFamily: "rc" | "ln" | null;
  dtDanLabel: string | null;
  htRawDan: number | null;
  htFamily: "rc" | "ln" | null;
  htDanLabel: string | null;
  /**
   * Drain length at 1.0x in seconds. For a confirmed pre-rated upload this is
   * the base-rate length (rateEditBaseLength in dan-clears.ts).
   */
  lengthSeconds: number | null;
  /** The chart's overall difficulty; null when unknown. */
  od: number | null;
  keyCount?: number | null;
}

/** Stored chart-analysis output, read unvalidated. */
export interface ChartAnalysisFacts {
  keyCount: number | null;
  classification: {
    lnRatio?: unknown;
    lnEffectiveRatio?: unknown;
    lnRatingIdentity?: unknown;
    vibro?: unknown;
    danEligibility?: { eligible?: unknown } | null;
    rc?: { rawDan?: unknown; displayName?: unknown } | null;
    ln?: { rawDan?: unknown; displayName?: unknown } | null;
    patterns?: Array<{ id?: unknown; score?: unknown }>;
    jackDemand?: { detected?: unknown } | null;
    clusters?: Array<{ pattern?: unknown; importance?: unknown }>;
    clusterCategory?: unknown;
    motion?: Record<string, unknown> | null;
  } | null;
  /** The chart's MSD at 1.0x, read on 4K only. */
  msd?: { values?: Record<string, number> } | null;
  /** The primary dan verdict at 1.5x / 0.75x. */
  dt?: VerdictAtRate | null;
  ht?: VerdictAtRate | null;
  lengthSeconds: number | null;
  od: number | null;
  chartFamily?: string | null;
}

interface VerdictAtRate {
  rawDan?: unknown;
  primaryFamily?: unknown;
  primaryLabel?: unknown;
  lnEffectiveRatio?: unknown;
  lnRatingIdentity?: unknown;
}

export interface PlayerSkillPatternRating {
  id: string;
  rating: number;
  plays: number;
}

export interface PlayerSkillModeRatings {
  keyCount: number;
  /** Plays with an SSR on this keymode. */
  analyzedPlays: number;
  ratings: Record<string, number>;
  patterns: PlayerSkillPatternRating[];
}

/** One attempt at a slot, ranked on each dan currency. */
export interface DanAttemptEntry {
  identity: string;
  goal: number;
  pp: number;
  /**
   * The attempt's own score facts, copied over the rated play's. Every
   * score-specific field is set, null when empty, so none of the rated play's
   * leaks through.
   */
  evidence: Partial<StoredPlaySsr>;
  /** Stable accuracy, falling back to the displayed accuracy for accuracy-only rows. */
  stable: number;
  v2: number | null;
}

/** The slot's most accurate attempts: one per dan currency. */
export interface DanAttemptSlotBest {
  stable?: DanAttemptEntry;
  v2?: DanAttemptEntry;
}

/** One score competing for its slot (slotCandidateWins). */
export interface SlotCandidate {
  goal: number;
  source: "top" | "tracked";
  /** calculateStableAccuracy of its counts, or the displayed accuracy when that is 0. */
  stableAccuracy: number;
}

export function usesPatternSkillAxes(keyCount: number): boolean {
  return PATTERN_AXIS_KEY_COUNTS.has(keyCount);
}

export function publishesMsdSkillset(keyCount: number, skillset: string): boolean {
  return skillset !== "Technical" || TECHNICAL_KEY_COUNTS.has(keyCount);
}

/**
 * The constant music rate of a play, rounded to 0.01. Null when there is no
 * single rate (Wind Up/Down, Adaptive Speed) or the speed value is corrupt.
 */
export function getPlayRate(mods: ModInput[] | undefined): number | null {
  let rate = 1;
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "DT" || acronym === "NC") {
      const speed = modSpeed(mod, 1.5);
      if (speed == null) return null;
      rate *= speed;
    } else if (acronym === "HT" || acronym === "DC") {
      const speed = modSpeed(mod, 0.75);
      if (speed == null) return null;
      rate *= speed;
    } else if (acronym === "WU" || acronym === "WD" || acronym === "AS") {
      return null;
    }
  }
  return Math.round(rate * 100) / 100;
}

/**
 * The rate mod a play carries. The numeric rate cannot tell NC and DC from DT
 * and HT.
 */
export function getRateModAcronym(mods: ModInput[] | undefined): string | null {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "DT" || acronym === "NC" || acronym === "HT" || acronym === "DC") return acronym;
  }
  return null;
}

/** Whether a play carries Hold Off or No Release (CHART_REWRITING_MODS). */
export function scoreRewritesChart(mods: ModInput[] | undefined): boolean {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (CHART_REWRITING_MODS.has(acronym)) return true;
  }
  return false;
}

export function scoreInvertsChart(mods: ModInput[] | undefined): boolean {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === INVERSE_MOD_VARIANT) return true;
  }
  return false;
}

/**
 * The OD a Difficulty Adjust play was judged at, or null without a DA that
 * moved the slider. Returns the raw -15..15 Extended Limits value, since
 * daWidensHitWindows would read a clamped -15 on an OD 0 chart as no change.
 */
export function difficultyAdjustOd(mods: ModInput[] | undefined): number | null {
  for (const mod of mods ?? []) {
    if (typeof mod === "string") continue;
    if (String(mod?.acronym ?? "") !== "DA") continue;
    const raw = mod.settings?.overall_difficulty;
    if (raw == null || raw === "") return null;
    const od = Number(raw);
    if (!Number.isFinite(od)) return null;
    return Math.max(-15, Math.min(15, od));
  }
  return null;
}

/**
 * Whether DA widened the windows below the ladder's OD floor. Down to the
 * floor a DA play is rated like a chart shipped at that OD. Under it the play
 * is refused, since OD -15 makes a 2.0x run hittable and the wife goal does not
 * offset the rate. Raising OD always stays rated.
 *
 * Null `chartOd` means unknown, and a DA under the floor then disqualifies on
 * its own. `floor` comes from daRatingOdFloorFor.
 */
export function daWidensHitWindows(odOverride: number | null | undefined, chartOd: number | null, floor: number = DAN_MIN_OD_FLOOR): boolean {
  if (odOverride == null) return false;
  if (odOverride >= floor) return false;
  if (chartOd == null) return true;
  return odOverride < chartOd;
}

/**
 * The OD floor a DA play is held to before a dan verdict names its ladder.
 * With the keymode or hold share unknown, the lowest possible floor applies so
 * a play is not refused on a guess.
 */
export function daRatingOdFloorFor(
  keyCount: number | null | undefined,
  inverse: boolean | undefined,
  shares: { lnRatio: number | null | undefined; lnEffectiveRatio?: number | null | undefined },
): number {
  if (keyCount == null) return Math.min(DAN_MIN_OD_FLOOR, DAN_MIN_OD_7K_LN);
  if (inverse) return danMinOdFor(keyCount, "ln");
  const isLn = chartIsLn(keyCount, shares);
  if (isLn == null) return Math.min(danMinOdFor(keyCount, "ln"), danMinOdFor(keyCount, "rc"));
  return danMinOdFor(keyCount, isLn ? "ln" : "rc");
}

/** The chart's OD as the .osu states it, or null when absent or outside 0-10. */
export function parseOsuOd(osuText: string): number | null {
  const match = osuText.match(/^OverallDifficulty\s*:\s*(-?\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const od = Number(match[1]);
  return Number.isFinite(od) && od >= 0 && od <= 10 ? od : null;
}

/** The chart's key count from the .osu CircleSize line. */
export function parseOsuKeyCount(osuText: string): number | null {
  const match = osuText.match(/^CircleSize\s*:\s*(\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const keyCount = Math.round(Number(match[1]));
  return Number.isInteger(keyCount) && keyCount > 0 ? keyCount : null;
}

/** Converts serve the std .osu under the mania id; only Mode 3 files are rated. */
export function isNativeManiaOsu(osuText: string): boolean {
  return /^Mode\s*:\s*3\s*$/m.test(osuText);
}

export function ezWindowScale(score: { mods?: ModInput[] }): number {
  let scale = 1;
  for (const mod of score.mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "EZ") scale *= EZ_WINDOW_SCALE;
    else if (acronym === "HR") scale /= EZ_WINDOW_SCALE;
  }
  return scale;
}

/** Raw accuracy clamped into the calc's goal range, rounded to 4 decimals. */
export function ssrGoalForAccuracy(accuracy: number): number {
  const acc = Number.isFinite(accuracy) ? accuracy : 0.93;
  return Math.round(Math.max(SSR_GOAL_MIN, Math.min(SSR_CALC_GOAL_CAP, acc)) * 10_000) / 10_000;
}

/** The press/hold goal, or null at or below the 0.8 floor. See calibrateScoreForMsd. */
export function ssrGoalForScore(score: SkillScore, lnRatio?: number | null, od?: number | null, facts?: SsrChartFacts): number | null {
  return calibrateScoreForMsd(score, lnRatio, od, facts).goal;
}

/**
 * A play's press/hold goal for MinaCalc and its release-aware `lnGoal` for the
 * LN rating. Accuracy-only history cannot exceed 0.965. Unknown client
 * provenance takes the lower of the stable and lazer estimates. `od` is the OD
 * the play was judged at.
 */
export function calibrateScoreForMsd(score: SkillScore, lnRatio?: number | null, od?: number | null, facts?: SsrChartFacts): { goal: number | null; lnGoal: number | null } {
  const unavailable = { goal: null, lnGoal: null };
  if (facts?.nativeMania === false) return unavailable;
  const rate = facts?.rate ?? score.retainedRate ?? getPlayRate(score.mods);
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return unavailable;
  const counts = Object.values(readWifeCounts(score.statistics ?? {}));
  const hasJudgments = counts.some((count) => count > 0);
  const mods = (score.mods ?? []).map((mod) => typeof mod === "string" ? mod : mod.acronym);
  const scoreV2 = mods.some((mod) => mod === "SV2" || mod === "V2");
  const scoring = wifeScoringFor(score);
  const profiles: WifeCalibrationOptions["scoring"][] = scoreV2 ? ["stable-scorev2"]
    : scoring === "unknown" ? ["stable", "lazer"] : [scoring];
  const predictions = profiles.map((client) => {
    const options: WifeCalibrationOptions = {
      od: od != null && Number.isFinite(od) ? Math.max(0, Math.min(10, od)) : ASSUMED_OD,
      rate, windowScale: ezWindowScale(score), scoring: client, classicWindows: mods.includes("CL"),
      holdRatio: lnRatio != null && Number.isFinite(lnRatio) ? Math.max(0, Math.min(1, lnRatio)) : 0,
    };
    const predict = (target: "press" | "ln") => hasJudgments ? estimateManiaWifeAccuracy(counts, { ...options, target })
      : estimateManiaWifeAccuracyFromAccuracy(score.accuracy, { ...options, target });
    return { press: predict("press"), ln: predict("ln") };
  });
  if (predictions.some((value) => value.press == null || value.ln == null)) return unavailable;
  const cap = hasJudgments ? SSR_GOAL_CAP : SSR_CALC_GOAL_CAP;
  const goal = Math.round(Math.min(cap, ...predictions.map((value) => value.press!)) * 10_000) / 10_000;
  const lnGoal = Math.max(0, Math.round(Math.min(cap, ...predictions.map((value) => value.ln!)) * 10_000) / 10_000);
  return { goal: goal > SSR_GOAL_MIN ? goal : null, lnGoal };
}

/**
 * The same goals from Wife3 measured on a replay, capped and rounded like
 * calibrateScoreForMsd.
 */
export function goalsFromMeasuredWife(pressTarget: number, lnTarget: number): { goal: number | null; lnGoal: number | null } {
  if (!Number.isFinite(pressTarget) || !Number.isFinite(lnTarget)) return { goal: null, lnGoal: null };
  const goal = Math.round(Math.min(SSR_GOAL_CAP, pressTarget) * 10_000) / 10_000;
  const lnGoal = Math.max(0, Math.round(Math.min(SSR_GOAL_CAP, lnTarget) * 10_000) / 10_000);
  return { goal: goal > SSR_GOAL_MIN ? goal : null, lnGoal };
}

/**
 * Reference estimate that values each judgement at Wife3 averaged over its
 * band of stable's windows. Kept for comparison; ratings use
 * calibrateScoreForMsd.
 */
export function estimateWifeAccuracy(
  statistics: OsuScoreStatistics | undefined,
  options?: { od?: number | null; windowScale?: number },
): number | null {
  if (!statistics) return null;
  // A null od takes ASSUMED_OD instead of reading as OD 0.
  const rawOd = options?.od == null ? Number.NaN : Number(options.od);
  const od = Number.isFinite(rawOd) ? Math.max(0, Math.min(10, rawOd)) : ASSUMED_OD;
  const rawScale = Number(options?.windowScale);
  const windowScale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const expected = expectedWife3Points(od, windowScale);
  const counts = readWifeCounts(statistics);
  let total = 0;
  let points = 0;
  for (const [name, count] of Object.entries(counts) as Array<[WifeJudgement, number]>) {
    total += count;
    points += count * expected[name];
  }
  return total > 0 ? points / total : null;
}

/** The goal a play is rated at once section vibro removed part of its chart. */
export function ratingGoalFor(goal: number, vibroAdjustment: StoredPlaySsr["vibroAdjustment"] | undefined): number {
  return vibroAdjustment ? conservativeVibroAccuracy(goal, vibroAdjustment.judgementShare) : goal;
}

/**
 * SSRs for a play at its rate and goal, plus "LN" on keymodes with an LN
 * rating. On 6K/7K charts with holds the values blend toward a tail-aware pass
 * (LN_TAIL_BLEND_BY_KEYMODE). Null when the calc rejects the chart.
 */
export async function computePlaySsrValues(
  osuText: string,
  options: { rate: number; keyCount: number; goal: number; lnGoal?: number; od?: number | null; lnRatio?: number | null; adjustVibro?: boolean },
): Promise<{ values: Record<string, number>; calcRuns: number; lnSkill?: LnSkillResult } | null> {
  const { rate, keyCount, goal, od, lnRatio, adjustVibro } = options;
  const base = await runMsdAtGoal(osuText, { rate, keyCount, goal, adjustVibro });
  if (!base) return null;
  const lnSkill = isLnSkillSupported(keyCount) ? analyzeLnSsr(osuText, { rate, od, scoreGoal: options.lnGoal ?? goal }) : null;
  const finish = (rated: { values: Record<string, number>; calcRuns: number }) => lnSkill
    ? { ...rated, values: { ...rated.values, LN: lnSkill.rated ? lnSkill.rating ?? 0 : 0 }, lnSkill }
    : rated;
  const blend = LN_TAIL_BLEND_BY_KEYMODE[keyCount] ?? 0;
  if (!(blend > 0)) return finish(base);
  // Note: the effective-share branch is for 4K, whose blend weight is 0, so it
  // never runs. 6K/7K take the second branch.
  const tailPassText = LN_EFFECTIVE_KEY_COUNTS.has(keyCount)
    ? lnTailPassText(osuText, keyCount, { rate, od, minHoldRatio: LN_TAIL_MIN_RATIO })
    : Number(lnRatio) > LN_TAIL_MIN_RATIO ? osuText : null;
  if (tailPassText == null) return finish(base);
  const tails = await runMsdAtGoal(tailPassText, { rate, keyCount, goal, lnTailTaps: true, adjustVibro });
  if (!tails) return finish(base);
  return finish({ values: blendLnTailValues(base.values, tails.values, keyCount), calcRuns: base.calcRuns + tails.calcRuns });
}

/** The .osu an Invert play is rated against, or the chart's own for any other. */
export function ratedOsuTextFor(osuText: string, inverse: boolean | undefined): string | null {
  return inverse ? invertManiaOsuText(osuText) : osuText;
}

/**
 * 4K always goes through the rate-vibro check, since its section policy needs
 * the notes even at 1.0x. Other keymodes only off 1.0x without pp trust.
 */
export function shouldCheckRateVibro(keyCount: number, rate: number, hasPpTrust: boolean): boolean {
  return keyCount === 4 || (rate !== 1 && !hasPpTrust);
}

/**
 * Whether a chart is vibro at the played rate, plus the section adjustment
 * when only part of it is. 4K rice follows the section analysis. Other charts
 * use the 1.0x flag unless the player has a pp top play on it, or the rate
 * check off 1.0x. Null when the file cannot be read.
 */
export function chartVibroAtRate(osuText: string, rate: number, hasPpTrust: boolean, baseVibro: boolean): {
  vibro: boolean;
  adjustment?: Pick<VibroAnalysis, "excludedDurationMs" | "timeShare" | "noteShare" | "judgementShare">;
} | null {
  try {
    const map = parseManiaBeatmap(osuText);
    const analysis = usesSectionVibro(map) ? analyzeVibroSections(map, rate) : null;
    return {
      vibro: analysis ? analysis.status === "excluded"
        : (!hasPpTrust && baseVibro) || (rate !== 1 && detectRateVibro(map, rate)),
      adjustment: analysis?.status === "adjusted" ? {
        excludedDurationMs: analysis.excludedDurationMs, timeShare: analysis.timeShare,
        noteShare: analysis.noteShare, judgementShare: analysis.judgementShare,
      } : undefined,
    };
  } catch {
    return null;
  }
}

/** The rate-vibro verdict for a play on a chart with no pp behind it. */
export function rateVibroVerdictWithoutPpTrust(osuText: string, rate: number, baseVibro: boolean): {
  vibro: boolean;
  adjustment?: Pick<VibroAnalysis, "excludedDurationMs" | "timeShare" | "noteShare" | "judgementShare">;
} | null {
  const check = chartVibroAtRate(osuText, rate, false, baseVibro);
  return check ? { vibro: check.vibro, adjustment: check.adjustment } : null;
}

/**
 * Why a score cannot compete for a slot, or null. Runs before the file is
 * read. The Invert and DA checks wait for slotWinnerRejection when the key
 * count or chart OD is still unknown.
 */
export function slotEntryRejection(
  score: { beatmapId: number; mods?: ModInput[]; retainedRate?: number },
  chart: { keyCount?: number | null; od: number | null; lnRatio?: number | null; lnEffectiveRatio?: number | null },
): "no_beatmap" | "chart_rewritten" | "no_single_rate" | "widened_windows" | null {
  if (!Number.isInteger(score.beatmapId) || score.beatmapId <= 0) return "no_beatmap";
  if (scoreRewritesChart(score.mods)) return "chart_rewritten";
  const inverse = scoreInvertsChart(score.mods);
  if (inverse && chart.keyCount != null && !INVERSE_MOD_KEY_COUNTS.has(chart.keyCount)) return "chart_rewritten";
  const rate = score.retainedRate ?? getPlayRate(score.mods);
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return "no_single_rate";
  // With the chart's OD unknown the DA check waits for slotWinnerRejection.
  const floor = daRatingOdFloorFor(chart.keyCount, inverse, { lnRatio: chart.lnRatio, lnEffectiveRatio: chart.lnEffectiveRatio });
  if (chart.od != null && daWidensHitWindows(difficultyAdjustOd(score.mods), chart.od, floor)) return "widened_windows";
  return null;
}

/**
 * The gates a slot's winning play meets once its .osu is read, in order.
 * Returns the rejection ("pending" when the vibro check could not read the
 * file), or the text to rate and any section vibro adjustment.
 */
export function slotWinnerRejection(input: {
  osuText: string;
  analysisKeyCount: number | null;
  inverse: boolean;
  rate: number;
  chartOd: number | null;
  odOverride: number | null;
  lnRatio: number | null;
  lnEffectiveRatio?: number | null;
  chartVibro: boolean;
  ppBacked: boolean;
}):
  | { rejection: "widened_windows" | "chart_vibro" | "not_native_mania" | "unsupported_keymode" | "chart_rewritten" | "invert_failed" | "rate_vibro" | "pending" }
  | { rejection: null; ratedText: string; vibroAdjustment?: StoredPlaySsr["vibroAdjustment"] } {
  // The DA check slotEntryRejection deferred, against the .osu's OD.
  if (input.odOverride != null && input.chartOd == null) {
    const floor = daRatingOdFloorFor(input.analysisKeyCount, input.inverse, { lnRatio: input.lnRatio, lnEffectiveRatio: input.lnEffectiveRatio });
    if (daWidensHitWindows(input.odOverride, parseOsuOd(input.osuText), floor)) return { rejection: "widened_windows" };
  }
  // MinaCalc overrates mash walls, so a vibro chart is out unless pp backs it.
  // 4K rice goes through the section policy below.
  const chartVibro = input.chartVibro && !input.ppBacked;
  const knownKeyCount = input.analysisKeyCount || 0;
  if (chartVibro && knownKeyCount !== 4 && isMsdSupportedKeyCount(knownKeyCount)) return { rejection: "chart_vibro" };
  if (!isNativeManiaOsu(input.osuText)) return { rejection: "not_native_mania" };
  const keyCount = parseOsuKeyCount(input.osuText);
  if (keyCount == null || !isMsdSupportedKeyCount(keyCount)) return { rejection: "unsupported_keymode" };
  if (chartVibro && keyCount !== 4) return { rejection: "chart_vibro" };
  if (input.inverse && !INVERSE_MOD_KEY_COUNTS.has(keyCount)) return { rejection: "chart_rewritten" };
  const ratedText = ratedOsuTextFor(input.osuText, input.inverse);
  if (ratedText == null) return { rejection: "invert_failed" };
  // pp only vouches for the chart at 1.0x, so ranked 4K uprates are checked
  // too.
  if (shouldCheckRateVibro(keyCount, input.rate, input.ppBacked)) {
    const check = chartVibroAtRate(ratedText, input.rate, input.ppBacked, input.chartVibro);
    if (check?.vibro) return { rejection: "rate_vibro" };
    if (!check) return { rejection: "pending" };
    return { rejection: null, ratedText, vibroAdjustment: check.adjustment };
  }
  return { rejection: null, ratedText };
}

/** Best play per (chart, rate). An Invert play gets its own slot. */
export function playSlotKey(beatmapId: number, rate: number, inverse: boolean | undefined): string {
  return inverse ? `${beatmapId}:${rate}:${INVERSE_MOD_VARIANT}` : `${beatmapId}:${rate}`;
}

/**
 * Whether `next` takes the slot from `existing`. Scores arrive top plays first,
 * so the first of equals keeps the slot. The higher goal wins. On a tie at the
 * floor accuracy decides, and otherwise a top play beats a tracked one.
 */
export function slotCandidateWins(existing: SlotCandidate | undefined, next: SlotCandidate): boolean {
  if (!existing) return true;
  const tiedGoal = next.goal === existing.goal;
  const betterFloorAccuracy = tiedGoal && next.goal === SSR_GOAL_MIN && next.stableAccuracy > existing.stableAccuracy;
  const tiedQuality = tiedGoal && (next.goal > SSR_GOAL_MIN || next.stableAccuracy === existing.stableAccuracy);
  return next.goal > existing.goal || betterFloorAccuracy
    || (tiedQuality && next.source === "top" && existing.source === "tracked");
}

/**
 * Whether a stored play whose score is no longer visible takes its slot back.
 * Needs a strictly better goal, or better accuracy when both are unrated.
 */
export function retainedPlayWinsSlot(previous: StoredPlaySsr, current: StoredPlaySsr | undefined): boolean {
  if (!current) return true;
  return (previous.goal > current.goal
    || (previous.ratingExcluded === true && current.ratingExcluded === true
      && (previous.stableAccuracy ?? previous.accuracy ?? 0) > (current.stableAccuracy ?? current.accuracy ?? 0)))
    && previous.identity !== current.identity;
}

/** Whether a stored play whose score is no longer visible stays in the pool. */
export function retainedPlayKept(
  play: StoredPlaySsr,
  ctx: {
    /** Identities seen carrying a chart-rewriting mod or a window-widening DA. */
    refusedIdentities: ReadonlySet<string>;
    /** Tracked identities whose only record is a mod-less archived row. */
    untrustedIdentities: ReadonlySet<string>;
    /** The rate a live score with the same identity was found at. */
    candidateRate: number | undefined;
    /** The chart as currently analyzed; `od` from metadata, analysis or the .osu. */
    chart: { od: number | null; lnRatio: number | null; lnEffectiveRatio: number | null; vibro: boolean } | undefined;
    ppBacked: boolean;
  },
): boolean {
  // A rated goal at the floor is a leftover clamp.
  if (!(play.goal > SSR_GOAL_MIN) && !play.ratingExcluded) return false;
  if (ctx.refusedIdentities.has(play.identity)) return false;
  // Invert played without the flag was rated against the un-inverted chart.
  if (!play.inverse && play.mods?.includes(INVERSE_MOD_VARIANT)) return false;
  if (play.inverse && !INVERSE_MOD_KEY_COUNTS.has(play.keyCount)) return false;
  // The stored OD catches a widening DA after the score payload is gone.
  if (play.odOverride != null) {
    const floor = daRatingOdFloorFor(play.keyCount, play.inverse, { lnRatio: play.inverse ? 1 : ctx.chart?.lnRatio, lnEffectiveRatio: ctx.chart?.lnEffectiveRatio });
    if (daWidensHitWindows(play.odOverride, ctx.chart?.od ?? null, floor)) return false;
  }
  // The chart now reads vibro. Top plays keep the pp trust they were rated with.
  if (ctx.chart?.vibro && play.keyCount !== 4 && play.source !== "top" && !ctx.ppBacked) return false;
  // A rate assumed from a mod-less archive row cannot be verified.
  if (play.source !== "top" && ctx.untrustedIdentities.has(play.identity)) return false;
  // A stored copy at another rate than the live score is stale.
  if (ctx.candidateRate != null && ctx.candidateRate !== play.rate) return false;
  return true;
}

/**
 * Tracks a slot's most accurate attempt per dan currency. Dan clears grade on
 * stable or ScoreV2 accuracy, so a retry with fewer misses can win the goal at
 * lower accuracy. EZ plays and DA plays with unknown chart OD are never noted.
 */
export function noteDanAttempt(best: DanAttemptSlotBest, attempt: DanAttemptEntry): DanAttemptSlotBest {
  if (!best.stable || attempt.stable > best.stable.stable) best.stable = attempt;
  if (attempt.v2 != null && (best.v2?.v2 == null || attempt.v2 > best.v2.v2)) best.v2 = attempt;
  return best;
}

/**
 * The slot's most accurate attempts per currency, when they beat the rated play
 * and are other scores. Each copies the rated play's chart fields so it files
 * into the same tiles, with its own score facts on top.
 */
export function pickDanAttempts(kept: StoredPlaySsr, best: DanAttemptSlotBest | undefined, refusedIdentities: ReadonlySet<string> = new Set()): StoredPlaySsr[] {
  if (!best || kept.neverRated) return [];
  const keptStable = kept.stableAccuracy ?? kept.accuracy ?? 0;
  const picked = new Set<DanAttemptEntry>();
  if (best.stable && best.stable.stable > keptStable) picked.add(best.stable);
  if (best.v2?.v2 != null && (kept.scoreV2Accuracy == null || best.v2.v2 > kept.scoreV2Accuracy)) picked.add(best.v2);
  const attempts: StoredPlaySsr[] = [];
  for (const attempt of picked) {
    if (attempt.identity === kept.identity || refusedIdentities.has(attempt.identity)) continue;
    attempts.push({
      ...kept,
      ...attempt.evidence,
      identity: attempt.identity, goal: attempt.goal, pp: attempt.pp,
      ratingExcluded: true, danAttempt: true,
    });
  }
  return attempts;
}

/**
 * Etterna's ScoreManager::AggregateSSRs. Binary-searches the rating whose
 * erfc-weighted SSR overages match the exponential target, scaled by 1.04.
 */
export function aggregateSsrs(values: number[]): number {
  const ssrs = values.filter((value) => Number.isFinite(value) && value > 0);
  if (ssrs.length === 0) return 0;
  let rating = 0;
  let res = 10.24;
  for (let iter = 1; iter <= 11; iter += 1) {
    let sum: number;
    do {
      rating += res;
      sum = 0;
      for (const ssr of ssrs) sum += Math.max(0, 2 / (1 - erf(0.1 * (ssr - rating))) - 2);
    } while (Math.pow(2, rating * 0.1) < sum);
    if (iter === 11) break;
    rating -= res;
    res /= 2;
  }
  return Math.round(rating * AGGREGATE_RATING_SCALER * 100) / 100;
}

/**
 * The plays a keymode's ratings aggregate. As in Etterna the slot's rate PB is
 * chosen by Overall. Only the best two per verified chart family count, so one
 * song at many rates cannot stack a rating.
 */
export function selectMsdRatingPlays(plays: StoredPlaySsr[]): StoredPlaySsr[] {
  const ranked = plays.filter((play) => !play?.ratingExcluded && Number.isFinite(play?.values?.Overall) && play.values.Overall > 0)
    .sort((a, b) => b.values.Overall - a.values.Overall
      || b.goal - a.goal || a.beatmapId - b.beatmapId || a.rate - b.rate
      || a.identity.localeCompare(b.identity));
  const slots = new Set<string>();
  const counts = new Map<string, number>();
  return ranked.filter((play) => {
    const slot = `${play.keyCount}:${play.ratingSlot ?? playSlotKey(play.beatmapId, play.rate, play.inverse)}`;
    if (slots.has(slot)) return false;
    slots.add(slot);
    const family = `${play.keyCount}:${play.chartFamily ?? `beatmap:${play.beatmapId}`}:${play.inverse === true}`;
    const count = counts.get(family) ?? 0;
    if (count >= 2) return false;
    counts.set(family, count + 1);
    return true;
  });
}

export function aggregateModeRatings(plays: StoredPlaySsr[]): Record<string, number> {
  const eligible = selectMsdRatingPlays(plays);
  const ratings: Record<string, number> = {};
  for (const name of SKILL_RATING_SKILLSETS) {
    ratings[name] = aggregateSsrs(eligible.map((play) => Number(play.values[name] ?? 0)));
  }
  return ratings;
}

/**
 * Per pattern tag, the aggregated Overall SSRs of plays on charts carrying it,
 * or the LN rating for LN tags. Needs PATTERN_RATING_MIN_PLAYS plays.
 */
export function aggregateModePatternRatings(plays: StoredPlaySsr[]): PlayerSkillPatternRating[] {
  const playsByPattern = new Map<string, StoredPlaySsr[]>();
  for (const play of selectMsdRatingPlays(plays)) {
    for (const pattern of play.patterns) {
      if (LN_PATTERN_IDS.has(pattern) && !(patternPlayRating(play, pattern) > 0)) continue;
      const list = playsByPattern.get(pattern);
      if (list) list.push(play);
      else playsByPattern.set(pattern, [play]);
    }
  }
  return [...playsByPattern.entries()]
    .filter(([, list]) => list.length >= PATTERN_RATING_MIN_PLAYS)
    .map(([id, list]) => ({
      id,
      rating: aggregateSsrs(list.map((play) => patternPlayRating(play, id))),
      plays: list.length,
    }))
    .filter((entry) => entry.rating > 0)
    .sort((a, b) => b.rating - a.rating);
}

/** One keymode's ratings. Its dan comes from computeModeDan in dan-clears.ts. */
export function modeRatingsFor(keyCount: number, plays: StoredPlaySsr[]): PlayerSkillModeRatings {
  return {
    keyCount,
    analyzedPlays: plays.filter((play) => !play.ratingExcluded).length,
    ratings: aggregateModeRatings(plays),
    patterns: aggregateModePatternRatings(plays),
  };
}

/**
 * The pattern tags a play carries at its own rate. LN tags follow the play's LN
 * result, or the chart's stored effective share at 1.0x, 1.5x or 0.75x. A
 * custom rate with no result gets none.
 */
export function playPatternsFor(info: ChartSkillInfo, rate: number, keyCount: number | null, lnSkill?: LnSkillResult): string[] {
  if (keyCount == null || !isLnSkillSupported(keyCount)) return info.patterns;
  const lnEffectiveRatio = rate === 1 ? info.lnEffectiveRatio
    : rate === 1.5 ? info.dtLnEffectiveRatio : rate === 0.75 ? info.htLnEffectiveRatio : null;
  const ratingIdentity = rate === 1 ? info.lnRatingIdentity === true
    : rate === 1.5 ? info.dtLnRatingIdentity === true : rate === 0.75 && info.htLnRatingIdentity === true;
  const eligible = lnSkill ? lnSkill.eligible || ratingIdentity
    : (!LN_EFFECTIVE_KEY_COUNTS.has(keyCount) || lnEffectiveRatio != null)
      && chartIsLn(keyCount, { lnRatio: info.lnRatio, lnEffectiveRatio }) === true;
  const rice = info.patterns.filter((id) => !LN_PATTERN_IDS.has(id));
  return eligible ? [...new Set([...rice, "ln", ...(info.lnPatterns ?? info.patterns.filter(id => LN_PATTERN_IDS.has(id)))])] : rice;
}

/** The per-chart facts the rules read, including the chart's pattern tags. */
export function chartSkillInfoFromAnalysis(facts: ChartAnalysisFacts): ChartSkillInfo {
  const parsed = facts.classification;
  const patternScores = new Map<string, number>();
  for (const hit of Array.isArray(parsed?.patterns) ? parsed.patterns : []) {
    const id = String(hit?.id ?? "");
    if (id) patternScores.set(id, Math.max(patternScores.get(id) ?? 0, Number(hit?.score ?? 0)));
  }
  const keyCount = facts.keyCount != null && Number.isFinite(facts.keyCount) && facts.keyCount > 0 ? facts.keyCount : null;
  const chordjackScore = patternScores.get("chordjack") ?? 0;
  const jackScore = patternScores.get("jack") ?? 0;
  const jackShare = clusterShare(parsed?.clusters, JACK_CLUSTERS);
  const isJack = chartIsJack(keyCount, chordjackScore, jackScore, jackShare);
  const vetoesTech = jackVetoesTech(keyCount, chordjackScore, jackScore, jackShare);
  const rawLnRatio = Number(parsed?.lnRatio);
  const lnRatio = Number.isFinite(rawLnRatio) ? Math.max(0, Math.min(1, rawLnRatio)) : null;
  const lnEffectiveRatio = readShare(parsed?.lnEffectiveRatio);
  // A chart with no lnRatio cannot be verified as LN, so it keeps no LN tag.
  const chartReadsLn = chartIsLn(keyCount, { lnRatio, lnEffectiveRatio }) === true;
  const label = typeof parsed?.clusterCategory === "string" && parsed.clusterCategory.trim() !== "" ? parsed.clusterCategory : null;
  const techCategory = label != null ? TECH_CLUSTER_CATEGORY.test(label) : null;
  const isTech = chartIsTech(keyCount, patternScores.get("tech") ?? 0, vetoesTech, techCategory, chartReadsLn);
  const isChordstream = chartIsChordstream(keyCount, patternScores.get("chordstream") ?? 0, clusterShare(parsed?.clusters, CHORDSTREAM_CLUSTERS));
  // Tech and chordstream use their own rules. A labelled chart with no tech
  // entry still gets the tag below.
  const patternIds = [...patternScores.entries()]
    .filter(([id, score]) =>
      id === "tech" ? isTech
      : id === "chordstream" ? isChordstream
      : score >= patternTagMinScore(id) && !(LN_PATTERN_IDS.has(id) && !chartReadsLn))
    .map(([id]) => id);
  if (isTech && !patternIds.includes("tech")) patternIds.push("tech");
  // The derived jack tag. Chordjack stays for consumers that mean chord jack.
  if (keyCount != null && usesPatternSkillAxes(keyCount) && isJack && !patternIds.includes("jack")) patternIds.push("jack");
  const dtRawDan = readRawDan(facts.dt);
  const htRawDan = readRawDan(facts.ht);
  const chartMsd = keyCount === 4 ? facts.msd ?? null : null;
  return {
    chartFamily: facts.chartFamily ?? null,
    patterns: patternIds,
    lnPatterns: [...patternScores.entries()].filter(([id, score]) => LN_PATTERN_IDS.has(id) && score >= patternTagMinScore(id)).map(([id]) => id),
    jackDemand: parsed?.jackDemand?.detected === true,
    jackShare,
    streamShare: clusterShare(parsed?.clusters, STREAM_CLUSTERS),
    techCategory,
    clusterTrill: label != null ? TRILL_CLUSTER_CATEGORY.test(label) : null,
    handstreamCluster: label != null ? HANDSTREAM_CLUSTER_CATEGORY.test(label) : null,
    jumpstreamCluster: label != null ? JUMPSTREAM_CLUSTER_CATEGORY.test(label) : null,
    handstreamEndurance: keyCount === 4 && !chartReadsLn && hasHandstreamEndurance(chartMsd?.values),
    // Note: `!chartIsLn` negates the imported function, so msdValues is always
    // null and the fallback in tileValuesForPlay never runs. `!chartReadsLn`
    // was likely meant.
    msdValues: keyCount === 4 && !chartIsLn && chartMsd?.values && typeof chartMsd.values === "object"
      ? chartMsd.values
      : null,
    techScore: vetoesTech ? 0 : (patternScores.get("tech") ?? 0),
    chordjackScore,
    motion: readMotionFeatures(parsed?.motion),
    lnRatio,
    lnEffectiveRatio,
    lnRatingIdentity: parsed?.lnRatingIdentity === true,
    dtLnEffectiveRatio: readShare(facts.dt?.lnEffectiveRatio),
    htLnEffectiveRatio: readShare(facts.ht?.lnEffectiveRatio),
    dtLnRatingIdentity: facts.dt?.lnRatingIdentity === true,
    htLnRatingIdentity: facts.ht?.lnRatingIdentity === true,
    vibro: parsed?.vibro === true,
    // Analyses without the field count as eligible.
    danEligible: parsed?.danEligibility?.eligible !== false,
    rcRawDan: readRawDan(parsed?.rc),
    lnRawDan: readRawDan(parsed?.ln),
    rcDanLabel: readDanLabel(parsed?.rc?.displayName),
    lnDanLabel: readDanLabel(parsed?.ln?.displayName),
    dtRawDan,
    dtFamily: dtRawDan == null ? null : facts.dt?.primaryFamily === "ln" ? "ln" : "rc",
    dtDanLabel: readDanLabel(facts.dt?.primaryLabel),
    htRawDan,
    htFamily: htRawDan == null ? null : facts.ht?.primaryFamily === "ln" ? "ln" : "rc",
    htDanLabel: readDanLabel(facts.ht?.primaryLabel),
    lengthSeconds: facts.lengthSeconds,
    od: facts.od,
    keyCount,
  };
}

/** The score a pattern must reach to tag a chart, per tag. */
export function patternTagMinScore(patternId: string): number {
  if (patternId === "chordjack") return CHORDJACK_TAG_MIN_SCORE;
  if (patternId === "delay") return DELAY_TAG_MIN_SCORE;
  return PATTERN_TAG_MIN_SCORE;
}

/**
 * Whether a chart is jack, chord or single-note. On 6K/7K/8K a jack score over
 * the bar or CLUSTER_SHARE_MIN of LeoBlack importance qualifies. The chordjack
 * score is only a fallback without clusters, since it cannot tell hard jack
 * from half-time filler. 4K tiles read MSD, so 4K uses chordjack alone.
 */
export function chartIsJack(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  if (keyCount == null || !usesPatternSkillAxes(keyCount)) return chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
  if (jackScore >= PATTERN_TAG_MIN_SCORE) return true;
  return jackShare != null
    ? jackShare >= CLUSTER_SHARE_MIN
    : chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
}

// Dense jack saturates the tech detector, and chordjack >= 0.8 carried a false
// tech tag 75-88% of the time. The jack score vetoes only at this bar so charts
// that are both keep tech.
const JACK_TECH_VETO_MIN_SCORE = 0.8;

/**
 * Whether a chart's jack content strips its tech tag. Clusters overrule a high
 * chordjack score, since a stream-led hybrid can hold a chordjack section.
 */
export function jackVetoesTech(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  if (keyCount == null || !usesPatternSkillAxes(keyCount)) return chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
  if (jackScore >= JACK_TECH_VETO_MIN_SCORE) return true;
  return jackShare != null
    ? jackShare >= CLUSTER_SHARE_MIN
    : chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
}

/**
 * The tech tag. On 6K/7K/8K it follows LeoBlack's headline label, since the
 * in-house score tags 89% of stream-pack charts tech. Charts with no label, and
 * LN charts whose "Tech" label means lntech, keep the score read.
 */
export function chartIsTech(keyCount: number | null, techScore: number, vetoesTech: boolean, techCategory: boolean | null, chartReadsLn: boolean): boolean {
  const byScore = techScore >= PATTERN_TAG_MIN_SCORE && !vetoesTech;
  if (keyCount == null || !usesPatternSkillAxes(keyCount) || chartReadsLn) return byScore;
  return techCategory ?? byScore;
}

/**
 * The chordstream tag. On 6K/7K/8K chordstream clusters must carry
 * CLUSTER_SHARE_MIN, since a jack chart's bridges also score chordstream.
 * Charts with no clusters keep the score read.
 */
export function chartIsChordstream(keyCount: number | null, chordstreamScore: number, chordstreamShare: number | null): boolean {
  if (chordstreamScore < PATTERN_TAG_MIN_SCORE) return false;
  if (keyCount == null || !usesPatternSkillAxes(keyCount)) return true;
  return chordstreamShare == null || chordstreamShare >= CLUSTER_SHARE_MIN;
}

/**
 * The share of LeoBlack cluster importance (amount x difficulty) on clusters
 * matching `pattern`. Null when the chart has no clusters.
 */
export function clusterShare(clusters: Array<{ pattern?: unknown; importance?: unknown }> | undefined, pattern: RegExp): number | null {
  const list = Array.isArray(clusters) ? clusters : [];
  let total = 0;
  let matched = 0;
  for (const cluster of list) {
    const importance = Number(cluster?.importance);
    if (!Number.isFinite(importance) || importance <= 0) continue;
    total += importance;
    if (pattern.test(String(cluster?.pattern ?? ""))) matched += importance;
  }
  return total > 0 ? matched / total : null;
}

/** The highest non-Overall MSD skillset of an SSR vector, if any. */
export function dominantSkillset(values: Record<string, number> | undefined): string | null {
  let best: string | null = null;
  let bestValue = 0;
  for (const skillset of SKILL_RATING_SKILLSETS) {
    if (skillset === "Overall") continue;
    const value = Number(values?.[skillset] ?? 0);
    if (Number.isFinite(value) && value > bestValue) {
      best = skillset;
      bestValue = value;
    }
  }
  return best;
}

/** A copy of an SSR vector holding only the named skillsets (positive values). */
export function pickSkillsets(values: Record<string, number> | undefined, keep: string[]): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const skillset of keep) {
    const value = Number(values?.[skillset] ?? 0);
    if (Number.isFinite(value) && value > 0) picked[skillset] = value;
  }
  return picked;
}

/** Stamina first and Handstream the strongest base skillset. */
export function hasHandstreamEndurance(values: Record<string, number> | undefined): boolean {
  return dominantSkillset(values) === "Stamina"
    && dominantSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS)) === "Handstream";
}

/**
 * SSRs at `goal`. Past the calc's 0.965 cap each skillset is extended along the
 * chart's own 0.93 -> 0.965 log-slope, capped at SSR_EXTRAPOLATION_MAX_SLOPE.
 */
async function runMsdAtGoal(
  osuText: string,
  options: { rate: number; keyCount: number; goal: number; lnTailTaps?: boolean; adjustVibro?: boolean },
): Promise<{ values: Record<string, number>; calcRuns: number } | null> {
  const { rate, keyCount, goal, lnTailTaps = false, adjustVibro = true } = options;
  const capped = await computeMsd(osuText, { rate, keyCount, scoreGoal: Math.min(goal, SSR_CALC_GOAL_CAP), lnTailTaps, adjustVibro, includeLnSkill: false }).catch(msdChartErrorFallback);
  if (!capped) return null;
  if (goal <= SSR_CALC_GOAL_CAP) return { values: capped.values, calcRuns: 1 };
  const base = await computeMsd(osuText, { rate, keyCount, scoreGoal: SSR_EXTRAPOLATION_BASE_GOAL, lnTailTaps, adjustVibro, includeLnSkill: false }).catch(msdChartErrorFallback);
  if (!base) return { values: capped.values, calcRuns: 1 };
  const exponent = (goal - SSR_CALC_GOAL_CAP) / (SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL);
  const values: Record<string, number> = {};
  for (const [name, atCap] of Object.entries(capped.values)) {
    const atBase = Number(base.values[name] ?? 0);
    if (!(atCap > 0) || !(atBase > 0) || atCap <= atBase) {
      values[name] = atCap;
      continue;
    }
    const slope = Math.min(atCap / atBase, SSR_EXTRAPOLATION_MAX_SLOPE);
    values[name] = atCap * Math.pow(slope, exponent);
  }
  return { values, calcRuns: 2 };
}

/** A play's value for a pattern tag. LN tags read the LN rating where one exists. */
function patternPlayRating(play: StoredPlaySsr, pattern: string): number {
  if (isLnSkillSupported(play.keyCount) && LN_PATTERN_IDS.has(pattern)) {
    // The LN value exists on every hold-heavy chart, so only plays tagged ln
    // read it.
    return play.lnSkill != null && play.patterns.includes("ln") ? Number(play.values.LN ?? 0) : 0;
  }
  return Number(play.values.Overall ?? 0);
}

/** Client provenance for the goal: explicit when recorded, else from the score's submission fields. */
function wifeScoringFor(score: SkillScore): "stable" | "lazer" | "unknown" {
  if (score.wifeScoring != null) return score.wifeScoring;
  if (score.type == null && score.legacy_score_id == null && !(Number(score.legacy_total_score) > 0)) return "unknown";
  return isLazerScore(score as unknown as OscScore) ? "lazer" : "stable";
}

type WifeJudgement = "perfect" | "great" | "good" | "ok" | "meh" | "miss";

/** Judgement counts under either naming (lazer or stable), floored to non-negative integers. */
function readWifeCounts(statistics: OsuScoreStatistics): Record<WifeJudgement, number> {
  return {
    perfect: readCount(statistics.perfect ?? statistics.count_geki),
    great: readCount(statistics.great ?? statistics.count_300),
    good: readCount(statistics.good ?? statistics.count_katu),
    ok: readCount(statistics.ok ?? statistics.count_100),
    meh: readCount(statistics.meh ?? statistics.count_50),
    miss: readCount(statistics.miss ?? statistics.count_miss),
  };
}

function readCount(value: number | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// Stable's windows for the reference estimator. MAX is fixed, the rest shrink
// 3 ms per OD point.
const STABLE_MAX_WINDOW_MS = 16.5;
const STABLE_WINDOW_BASES_MS = { great: 64, good: 97, ok: 127, meh: 151 } as const;
const OD_WINDOW_STEP_MS = 3;

/** Wife3 averaged uniformly over each judgement's band. */
function expectedWife3Points(od: number, windowScale: number): Record<WifeJudgement, number> {
  const edges = [
    STABLE_MAX_WINDOW_MS * windowScale,
    ...Object.values(STABLE_WINDOW_BASES_MS).map((base) => (base - OD_WINDOW_STEP_MS * od) * windowScale),
  ];
  return {
    perfect: wife3BandAverage(0, edges[0]),
    great: wife3BandAverage(edges[0], edges[1]),
    good: wife3BandAverage(edges[1], edges[2]),
    ok: wife3BandAverage(edges[2], edges[3]),
    meh: wife3BandAverage(edges[3], edges[4]),
    miss: WIFE3_MISS_POINTS,
  };
}

function wife3BandAverage(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return wife3PointsAt(toMs);
  const steps = 512;
  const step = (toMs - fromMs) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i += 1) sum += wife3PointsAt(fromMs + (i + 0.5) * step);
  return sum / steps;
}

function modSpeed(mod: ModInput, defaultSpeed: number): number | null {
  if (typeof mod === "string") return defaultSpeed;
  if (mod.settings?.speed_change == null) return defaultSpeed;
  const speed = Number(mod.settings.speed_change);
  // Lazer's slider bounds. Anything outside is a corrupt payload.
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : null;
}

function readShare(value: unknown): number | null {
  if (value == null) return null;
  const share = Number(value);
  return Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : null;
}

// Zero or negative values are kept, since a bottom-rung chart's regression can
// run below the table. danClearTargetFor clamps them to the ladder floor.
function readRawDan(half: { rawDan?: unknown } | null | undefined): number | null {
  if (half?.rawDan == null) return null;
  const rawDan = Number(half.rawDan);
  return Number.isFinite(rawDan) ? rawDan : null;
}

function readDanLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Any non-finite share makes the whole block unread, and the MSD-lead arms
// stand.
function readMotionFeatures(value: unknown): MotionFeatures | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const keys = ["sameHand", "miniJack", "anchor", "oneHandTrill", "crossHandTrill", "roll4", "rhythmBreak", "chordSwing", "densitySwing"] as const;
  const read: Partial<Record<(typeof keys)[number], number>> = {};
  for (const key of keys) {
    const share = Number(raw[key]);
    if (!Number.isFinite(share)) return null;
    read[key] = key === "densitySwing" ? Math.max(0, share) : Math.min(1, Math.max(0, share));
  }
  return read as MotionFeatures;
}
