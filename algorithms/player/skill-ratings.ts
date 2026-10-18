import { DAN_MIN_OD_7K_LN, danMinOdFor, type DanClearTarget, danOdFlagForPlay, DAN_SKILLSET_AVERAGE_MIN_BUCKETS, type DanSkillsetBucket, type DanClearEvidence, danSkillsetBucketsForPlay, INVERSE_MOD_VARIANT } from "./dan-clears";
import { analyzeLnSsrOnThread, checkRateVibroOnThread } from "../msd/inline";
import { checkRateVibro, type RateVibroCheck } from "../vibro/rate";
import { SSR_CALC_GOAL_CAP, SSR_EXTRAPOLATION_MAX_SLOPE, ssrGoalAnchors } from "../ln/ssr";
import { erf, wife3PointsAt, WIFE3_MISS_POINTS } from "./tap-wife-accuracy";
import { estimateManiaWifeAccuracy, estimateManiaWifeAccuracyFromAccuracy, type WifeCalibrationOptions } from "./wife-calibration";
import { parseJson, readSameChartChecksums, readChartJson } from "../chart/cells";
import { LN_EFFECTIVE_KEY_COUNTS, chartIsLn, lnTailPassText } from "../dan-estimator/ln-effective";
import type { MotionFeatures } from "../classification/motion-features";
import { PRISM_GOAL_FLOOR } from "../prism/params";
import { prismLnLeadValues } from "../prism/ln-lead";
import { LN_TAIL_BLEND_BY_KEYMODE, LN_TAIL_MIN_RATIO, blendLnTailValues, computeMsd, isMsdSupportedKeyCount, msdChartErrorFallback, usesPrism } from "../msd/msd";
import { hybridLnSectionsCredit, isHybridChart } from "../classification/chart-analysis";
import { invertManiaOsuText } from "../chart/invert";
import { calculateScoreV2Accuracy, isLazerScore, type OscScore, type OsuMod, type OsuScoreStatistics } from "../chart/score";
import { danTableFloorFor } from "../classification/chart-classifier";
import { parseManiaBeatmap } from "../chart/beatmap";
import { isUnrateableExclusion, type VibroAnalysis } from "../vibro/sections";
import { isLnSkillSupported, LN_SKILL_VERSION, publishedLnRating, type LnSkillResult } from "../ln/skill";
import { LN_SKILLSET_IDS } from "../ln/skillsets";
import type { LnFamilyVector } from "../ln/workload";
import { conservativeVibroAccuracy } from "../vibro/sections";

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

const PRISM_RATED_SKILLSETS: readonly string[] = [...SKILL_RATING_SKILLSETS.filter((name) => name !== "Stamina"), "Speed"];

export function ratedSkillsets(keyCount: number | null | undefined): readonly string[] {
  return usesPrism(keyCount) ? PRISM_RATED_SKILLSETS : SKILL_RATING_SKILLSETS;
}

export const PATTERN_AXIS_KEY_COUNTS: ReadonlySet<number> = new Set([6, 7, 8]);

export function usesPatternSkillAxes(keyCount: number): boolean {
  return PATTERN_AXIS_KEY_COUNTS.has(keyCount);
}

export function publishesPatternAxes(keyCount: number): boolean {
  return usesPatternSkillAxes(keyCount) && !usesPrism(keyCount);
}

const TECHNICAL_KEY_COUNTS: ReadonlySet<number> = new Set([4, 5]);

export function publishesMsdSkillset(keyCount: number, skillset: string): boolean {
  if (usesPrism(keyCount)) return skillset !== "JackSpeed" && skillset !== "Stream" && skillset !== "Stamina";
  return skillset !== "Technical" || TECHNICAL_KEY_COUNTS.has(keyCount);
}

const PATTERN_RATING_MIN_PLAYS = 3;

export const PATTERN_TAG_MIN_SCORE = 0.5;

const CHORDJACK_TAG_MIN_SCORE = 0.8;

const DELAY_TAG_MIN_SCORE = 0.25;

export function patternTagMinScore(patternId: string): number {
  if (patternId === "chordjack") return CHORDJACK_TAG_MIN_SCORE;
  if (patternId === "delay") return DELAY_TAG_MIN_SCORE;
  return PATTERN_TAG_MIN_SCORE;
}

export function chartIsJack(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  if (keyCount == null || !usesPatternSkillAxes(keyCount)) return chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
  if (jackScore >= PATTERN_TAG_MIN_SCORE) return true;
  return jackShare != null
    ? jackShare >= CLUSTER_SHARE_MIN
    : chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
}

const JACK_TECH_VETO_MIN_SCORE = 0.8;
export function jackVetoesTech(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  if (keyCount == null || !usesPatternSkillAxes(keyCount)) return chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
  if (jackScore >= JACK_TECH_VETO_MIN_SCORE) return true;
  return jackShare != null
    ? jackShare >= CLUSTER_SHARE_MIN
    : chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
}

export function chartIsTech(keyCount: number | null, techScore: number, vetoesTech: boolean, techCategory: boolean | null, chartReadsLn: boolean): boolean {
  const byScore = techScore >= PATTERN_TAG_MIN_SCORE && !vetoesTech;
  if (keyCount == null || !usesPatternSkillAxes(keyCount) || chartReadsLn) return byScore;
  return techCategory ?? byScore;
}

const CHORDSTREAM_CLUSTERS = /chordstream/i;
export function chartIsChordstream(keyCount: number | null, chordstreamScore: number, chordstreamShare: number | null): boolean {
  if (chordstreamScore < PATTERN_TAG_MIN_SCORE) return false;
  if (keyCount == null || !usesPatternSkillAxes(keyCount)) return true;
  return chordstreamShare == null || chordstreamShare >= CLUSTER_SHARE_MIN;
}

const LN_PATTERN_IDS = new Set(["ln", ...LN_SKILLSET_IDS, "lngeneral", "lnrelease", "lninverse", "lntech"]);

export const SSR_GOAL_MIN = 0.8;

const SSR_GOAL_CAP = 0.9975;

const STABLE_MAX_WINDOW_MS = 16.5;
const STABLE_WINDOW_BASES_MS = { great: 64, good: 97, ok: 127, meh: 151 } as const;
const OD_WINDOW_STEP_MS = 3;

const ASSUMED_OD = 8;

type WifeJudgement = "perfect" | keyof typeof STABLE_WINDOW_BASES_MS | "miss";

function wife3BandAverage(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return wife3PointsAt(toMs);
  const steps = 512;
  const step = (toMs - fromMs) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i += 1) sum += wife3PointsAt(fromMs + (i + 0.5) * step);
  return sum / steps;
}

const expectedWife3PointsCache = new Map<string, Record<WifeJudgement, number>>();

function expectedWife3Points(od: number, windowScale: number): Record<WifeJudgement, number> {
  const key = `${od}|${windowScale}`;
  const cached = expectedWife3PointsCache.get(key);
  if (cached) return cached;
  const edges = [
    STABLE_MAX_WINDOW_MS * windowScale,
    ...Object.values(STABLE_WINDOW_BASES_MS).map((base) => (base - OD_WINDOW_STEP_MS * od) * windowScale),
  ];
  const points = {
    perfect: wife3BandAverage(0, edges[0]),
    great: wife3BandAverage(edges[0], edges[1]),
    good: wife3BandAverage(edges[1], edges[2]),
    ok: wife3BandAverage(edges[2], edges[3]),
    meh: wife3BandAverage(edges[3], edges[4]),
    miss: WIFE3_MISS_POINTS,
  };
  expectedWife3PointsCache.set(key, points);
  return points;
}

const AGGREGATE_RATING_SCALER = 1.04;

export interface PlayerSkillPatternRating {
  id: string;
  rating: number;
  plays: number;
}

export const PLAYER_SKILL_PATTERN_AXES = [
  "chordstream",
  "bracket",
  "delay",
  "stream",
  "jack",
  "tech",
  "ln",
] as const;

export interface StoredPlaySsr {
  beatmapChecksum?: string;
  fileChecksum?: string;
  revisionPending?: boolean;
  pendingReason?: StoredPendingReason;
  neverRated?: boolean;
  startedAt?: string | null;
  score?: PlayerSkillScoreDetails | null;
  wifeScoring?: "stable" | "lazer" | "unknown";
  tapWifeOd?: number | null;
  tapWifeFileVersion?: string | null;
  tapWifeMods?: boolean;
  wifeCalibration?: StoredWifeCalibration | null;
  lnGoal?: number;
  replayTimed?: boolean;
  identity: string;
  beatmapId: number;
  chartFamily?: string | null;
  keyCount: number;
  rate: number;
  goal: number;
  pp: number;
  values: Record<string, number>;
  patterns: string[];
  source?: "top" | "tracked";
  accuracy?: number;
  customAccuracy?: number | null;
  stableAccuracy?: number | null;
  scoreV2Accuracy?: number | null;
  missShare?: number | null;
  endedAt?: string | null;
  rateMod?: string | null;
  mods?: string[];
  ezWindows?: boolean;
  odOverride?: number | null;
  rateVibroChecked?: number;
  vibroAdjustment?: Pick<VibroAnalysis, "excludedDurationMs" | "timeShare" | "noteShare" | "judgementShare">;
  unrateable?: true;
  lnTailPass?: number;
  minaCalc?: string;
  lnSkill?: LnSkillResult;
  inverse?: boolean;
  ratingExcluded?: boolean;
  calibrationPending?: boolean;
  ratingSlot?: string;
  danAttempt?: boolean;
}

export type StoredPendingReason = "revision" | "calc_budget" | "file" | "facts" | "rate_vibro" | "calc";

export function getPlayRate(mods: OsuMod[] | string[] | undefined): number | null {
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

const CHART_REWRITING_MODS = new Set(["HO", "NR"]);

export function scoreRewritesChart(mods: OsuMod[] | string[] | undefined): boolean {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (CHART_REWRITING_MODS.has(acronym)) return true;
  }
  return false;
}

export function scoreInvertsChart(mods: OsuMod[] | string[] | undefined): boolean {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === INVERSE_MOD_VARIANT) return true;
  }
  return false;
}

const INVERSE_MOD_KEY_COUNTS = new Set([4, 7]);

export const INVERSE_MOD_PATTERNS = ["ln", "lninverse"];

export function playSlotKey(beatmapId: number, rate: number, inverse: boolean | undefined): string {
  return inverse ? `${beatmapId}:${rate}:${INVERSE_MOD_VARIANT}` : `${beatmapId}:${rate}`;
}

export function ratedOsuTextFor(osuText: string, inverse: boolean | undefined): string | null {
  return inverse ? invertManiaOsuText(osuText) : osuText;
}

export function difficultyAdjustOd(mods: OsuMod[] | string[] | undefined): number | null {
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

export function daWidensHitWindows(odOverride: number | null | undefined, chartOd: number | null, floor: number = DAN_MIN_OD): boolean {
  if (odOverride == null) return false;
  if (odOverride >= floor) return false;
  if (chartOd == null) return true;
  return odOverride < chartOd;
}

export function daRatingOdFloorFor(
  keyCount: number | null | undefined,
  inverse: boolean | undefined,
  shares: { lnRatio: number | null | undefined; lnEffectiveRatio?: number | null | undefined },
): number {
  if (keyCount == null) return Math.min(DAN_MIN_OD, DAN_MIN_OD_7K_LN);
  if (inverse) return danMinOdFor(keyCount, "ln");
  const isLn = chartIsLn(keyCount, shares);
  if (isLn == null) return Math.min(danMinOdFor(keyCount, "ln"), danMinOdFor(keyCount, "rc"));
  return danMinOdFor(keyCount, isLn ? "ln" : "rc");
}

export function parseOsuOd(osuText: string): number | null {
  const match = osuText.match(/^OverallDifficulty\s*:\s*(-?\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const od = Number(match[1]);
  return Number.isFinite(od) && od >= 0 && od <= 10 ? od : null;
}

export function getRateModAcronym(mods: OsuMod[] | string[] | undefined): string | null {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "DT" || acronym === "NC" || acronym === "HT" || acronym === "DC") return acronym;
  }
  return null;
}

function modSpeed(mod: OsuMod | string, defaultSpeed: number): number | null {
  if (typeof mod === "string") return defaultSpeed;
  if (mod.settings?.speed_change == null) return defaultSpeed;
  const speed = Number(mod.settings.speed_change);
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : null;
}

export function ssrGoalForAccuracy(accuracy: number): number {
  const acc = Number.isFinite(accuracy) ? accuracy : 0.93;
  return Math.round(Math.max(SSR_GOAL_MIN, Math.min(SSR_CALC_GOAL_CAP, acc)) * 10_000) / 10_000;
}

export function estimateWifeAccuracy(
  statistics: OsuScoreStatistics | undefined,
  options?: { od?: number | null; windowScale?: number },
): number | null {
  if (!statistics) return null;
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

function readCount(value: number | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

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

type SsrGoalScore = Pick<OscScore, "accuracy" | "statistics" | "type" | "legacy_score_id" | "legacy_total_score"> & {
  mods?: OscScore["mods"] | string[];
  retainedRate?: number;
  wifeScoring?: "stable" | "lazer" | "unknown";
};

export interface StoredWifeCalibration {
  version: number;
  chartOd: number;
  chartHoldRatio: number;
  keyCount: number;
  fileVersion: string | null;
  basis?: "judgments" | "accuracy-only";
}

export interface SsrChartFacts {
  keyCount: number;
  nativeMania: boolean;
  rate: number;
}

function wifeScoringFor(score: SsrGoalScore): "stable" | "lazer" | "unknown" {
  if (score.wifeScoring != null) return score.wifeScoring;
  if (score.type == null && score.legacy_score_id == null && !(Number(score.legacy_total_score) > 0)) return "unknown";
  return isLazerScore(score as OscScore) ? "lazer" : "stable";
}

const EZ_WINDOW_SCALE = 1.4;

export function ezWindowScale(score: Pick<SsrGoalScore, "mods">): number {
  let scale = 1;
  for (const mod of score.mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "EZ") scale *= EZ_WINDOW_SCALE;
    else if (acronym === "HR") scale /= EZ_WINDOW_SCALE;
  }
  return scale;
}

export function playedOnLazer(score: OscScore): boolean {
  const client = (score as { companella?: { client?: string } }).companella?.client;
  return client ? client === "lazer" : isLazerScore(score);
}

export function ssrGoalForScore(score: SsrGoalScore, lnRatio?: number | null, od?: number | null, facts?: SsrChartFacts): number | null {
  return calibrateScoreForMsd(score, lnRatio, od, facts).goal;
}

export function calibrateScoreForMsd(score: SsrGoalScore, lnRatio?: number | null, od?: number | null, facts?: SsrChartFacts): { goal: number | null; lnGoal: number | null } {
  const unavailable = { goal: null, lnGoal: null };
  if (facts?.nativeMania === false) return unavailable;
  const rate = facts?.rate ?? score.retainedRate ?? getPlayRate(score.mods);
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return unavailable;
  if (usesPrism(facts?.keyCount)) return prismScoreGoals(score, lnRatio);
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

export function prismScoreGoals(
  score: Pick<SsrGoalScore, "statistics" | "accuracy"> & Partial<SsrGoalScore>,
  holdRatio?: number | null,
): { goal: number | null; lnGoal: number | null } {
  const counted = calculateScoreV2Accuracy(score.statistics);
  const scored = counted > 0 ? counted : Number(score.accuracy);
  if (!Number.isFinite(scored) || scored <= 0) return { goal: null, lnGoal: null };
  const accuracy = 1 - (1 - scored) * prismLazerLnMissScale(score, holdRatio);
  const goal = Math.round(Math.min(SSR_GOAL_CAP, accuracy) * 10_000) / 10_000;
  return { goal: goal > PRISM_GOAL_FLOOR ? goal : null, lnGoal: goal };
}

// Lazer judges releases more leniently than stable; this evens out lazer and stable plays on LN charts.
const PRISM_LAZER_LN_FROM_HOLDS = 0.06;
const PRISM_LAZER_LN_MISS_SLOPE = 0.41;

function prismLazerLnMissScale(score: Partial<SsrGoalScore>, holdRatio: number | null | undefined): number {
  if (holdRatio == null || !Number.isFinite(holdRatio)) return 1;
  if (wifeScoringFor(score as SsrGoalScore) !== "lazer") return 1;
  return 1 + PRISM_LAZER_LN_MISS_SLOPE * Math.max(0, Math.min(1, holdRatio) - PRISM_LAZER_LN_FROM_HOLDS);
}

export function goalsFromMeasuredWife(pressTarget: number, lnTarget: number): { goal: number | null; lnGoal: number | null } {
  if (!Number.isFinite(pressTarget) || !Number.isFinite(lnTarget)) return { goal: null, lnGoal: null };
  const goal = Math.round(Math.min(SSR_GOAL_CAP, pressTarget) * 10_000) / 10_000;
  const lnGoal = Math.max(0, Math.round(Math.min(SSR_GOAL_CAP, lnTarget) * 10_000) / 10_000);
  return { goal: goal > SSR_GOAL_MIN ? goal : null, lnGoal };
}

export function aggregateSsrs(values: number[]): number {
  return aggregateSsrValues(values, false);
}

function aggregateSsrValues(values: number[], descending: boolean): number {
  const ssrs = values.filter((value) => Number.isFinite(value) && value > 0);
  if (ssrs.length === 0) return 0;
  let rating = 0;
  let res = 10.24;
  for (let iter = 1; iter <= 11; iter += 1) {
    let sum: number;
    do {
      rating += res;
      sum = 0;
      for (const ssr of ssrs) {
        if (descending && ssr <= rating) break;
        sum += Math.max(0, 2 / (1 - erf(0.1 * (ssr - rating))) - 2);
      }
    } while (Math.pow(2, rating * 0.1) < sum);
    if (iter === 11) break;
    rating -= res;
    res /= 2;
  }
  return Math.round(rating * AGGREGATE_RATING_SCALER * 100) / 100;
}

async function runMsdAtGoal(
  osuText: string,
  options: { rate: number; keyCount: number; goal: number; lnTailTaps?: boolean; adjustVibro?: boolean },
): Promise<{ values: Record<string, number>; calcRuns: number } | null> {
  const { rate, keyCount, goal, lnTailTaps = false, adjustVibro = true } = options;
  const map = parseManiaBeatmap(osuText);
  const vibro = {};
  if (usesPrism(keyCount)) {
    const rated = await computeMsd(osuText, { rate, keyCount, scoreGoal: goal, lnTailTaps, adjustVibro, includeLnSkill: false }, map, vibro).catch(msdChartErrorFallback);
    return rated ? { values: rated.values, calcRuns: 1 } : null;
  }
  const anchors = ssrGoalAnchors(keyCount);
  const capped = await computeMsd(osuText, { rate, keyCount, scoreGoal: Math.min(goal, anchors.cap), lnTailTaps, adjustVibro, includeLnSkill: false }, map, vibro).catch(msdChartErrorFallback);
  if (!capped) return null;
  if (goal <= anchors.cap) return { values: capped.values, calcRuns: 1 };
  const base = await computeMsd(osuText, { rate, keyCount, scoreGoal: anchors.base, lnTailTaps, adjustVibro, includeLnSkill: false }, map, vibro).catch(msdChartErrorFallback);
  if (!base) return { values: capped.values, calcRuns: 1 };
  const exponent = (goal - anchors.cap) / (anchors.cap - anchors.base);
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

export async function computePlaySsrValues(
  osuText: string,
  options: { rate: number; keyCount: number; goal: number; lnGoal?: number; od?: number | null; lnRatio?: number | null; adjustVibro?: boolean;
    includeLn?: boolean },
): Promise<{ values: Record<string, number>; calcRuns: number; lnSkill?: LnSkillResult } | null> {
  const { rate, keyCount, goal, od, lnRatio, adjustVibro } = options;
  const base = await runMsdAtGoal(osuText, { rate, keyCount, goal, adjustVibro });
  if (!base) return null;
  const lnSkill = options.includeLn !== false && isLnSkillSupported(keyCount)
    ? await analyzeLnSsrOnThread(osuText, { rate, od, scoreGoal: options.lnGoal ?? goal }) : null;
  const finish = (rated: { values: Record<string, number>; calcRuns: number }) => {
    if (!lnSkill) return rated;
    const ln = publishedLnRating(lnSkill, rated.values.Overall);
    return { ...rated, values: prismLnLeadValues(lnSkill.keyCount, { ...rated.values, LN: ln }, ln, lnSkill.holdRatio), lnSkill };
  };
  const blend = LN_TAIL_BLEND_BY_KEYMODE[keyCount] ?? 0;
  if (!(blend > 0)) return finish(base);
  const tailPassText = LN_EFFECTIVE_KEY_COUNTS.has(keyCount)
    ? lnTailPassText(osuText, keyCount, { rate, od, minHoldRatio: LN_TAIL_MIN_RATIO })
    : Number(lnRatio) > LN_TAIL_MIN_RATIO ? osuText : null;
  if (tailPassText == null) return finish(base);
  const tails = await runMsdAtGoal(tailPassText, { rate, keyCount, goal, lnTailTaps: true, adjustVibro });
  if (!tails) return finish(base);
  return finish({ values: blendLnTailValues(base.values, tails.values, keyCount), calcRuns: base.calcRuns + tails.calcRuns });
}

export function selectMsdRatingPlays(plays: StoredPlaySsr[]): StoredPlaySsr[] {
  return pickMsdRatingPlays(rankMsdRatingPlays(plays));
}

export function rankMsdRatingPlays(plays: StoredPlaySsr[]): StoredPlaySsr[] {
  return plays.filter((play) => !play?.ratingExcluded && Number.isFinite(play?.values?.Overall) && play.values.Overall > 0)
    .sort((a, b) => b.values.Overall - a.values.Overall
      || b.goal - a.goal || a.beatmapId - b.beatmapId || a.rate - b.rate
      || a.identity.localeCompare(b.identity));
}

export function pickMsdRatingPlays(ranked: StoredPlaySsr[], without?: string): StoredPlaySsr[] {
  const slots = new Set<string>();
  const counts = new Map<string, number>();
  return ranked.filter((play) => {
    if (play.identity === without) return false;
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
  for (const name of ratedSkillsets(plays[0]?.keyCount)) {
    ratings[name] = aggregateSsrs(eligible.map((play) => Number(play.values[name] ?? 0)));
  }
  return ratings;
}

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

export function patternPlayRating(play: StoredPlaySsr, pattern: string): number {
  if ((LN_SKILLSET_IDS as readonly string[]).includes(pattern)) return 0;
  if (isLnSkillSupported(play.keyCount) && LN_PATTERN_IDS.has(pattern)) {
    if (play.lnSkill?.version !== LN_SKILL_VERSION || !play.patterns.includes("ln")) return 0;
    return Number(play.values.LN ?? 0);
  }
  return Number(play.values.Overall ?? 0);
}

export interface ChartSkillInfo {
  chartFamily?: string | null;
  patterns: string[];
  lnPatterns?: string[];
  jackDemand?: boolean;
  jackShare: number | null;
  streamShare: number | null;
  techCategory: boolean | null;
  riceTiles?: string[] | null;
  clusterTrill: boolean | null;
  handstreamCluster: boolean | null;
  jumpstreamCluster: boolean | null;
  handstreamEndurance?: boolean;
  msdValues?: Record<string, number> | null;
  lnSkillsets?: LnFamilyVector | null;
  techScore: number;
  chordjackScore: number;
  motion?: MotionFeatures | null;
  lnRatio: number | null;
  lnEffectiveRatio: number | null;
  lnRatingIdentity?: boolean;
  dtLnRatingIdentity?: boolean;
  htLnRatingIdentity?: boolean;
  dtLnEffectiveRatio: number | null;
  htLnEffectiveRatio: number | null;
  vibro: boolean;
  unrateable?: boolean;
  revisionChecksum: string | null;
  revisionUpdatedAt: string | null;
  revisionMutable: boolean;
  revisionDeleted: boolean;
  revisionSameChartChecksums?: string[];
  danEligible: boolean;
  rcRawDan: number | null;
  lnRawDan: number | null;
  hybrid?: boolean;
  hybridLn?: { rawDan: number; label: string | null } | null;
  rcDanLabel: string | null;
  lnDanLabel: string | null;
  dtRawDan: number | null;
  dtFamily: "rc" | "ln" | null;
  dtDanLabel: string | null;
  htRawDan: number | null;
  htFamily: "rc" | "ln" | null;
  htDanLabel: string | null;
  dtHybridRice?: { rawDan: number; label: string | null } | null;
  htHybridRice?: { rawDan: number; label: string | null } | null;
  lengthSeconds: number | null;
  od: number | null;
  keyCount?: number | null;
}

interface LeanHalfJson {
  rawDan?: unknown;
  displayName?: unknown;
}

interface LeanClassificationJson {
  lnRatio?: unknown;
  lnEffectiveRatio?: unknown;
  lnRiceShare?: unknown;
  lnWorkShare?: unknown;
  lnSections?: unknown;
  lnRatingIdentity?: unknown;
  vibro?: unknown;
  vibroAnalysis?: VibroAnalysis;
  danEligibility?: { eligible?: unknown } | null;
  rc?: LeanHalfJson | null;
  ln?: LeanHalfJson | null;
  patterns?: Array<{ id?: unknown; score?: unknown }>;
  jackDemand?: { detected?: unknown } | null;
  clusters?: Array<{ pattern?: unknown; importance?: unknown; mixed?: unknown; label?: unknown }>;
  riceShape?: { twoBack?: unknown; techSections?: unknown; motifRepeat?: unknown; speedPeak?: unknown; rollSections?: unknown } | null;
  clusterCategory?: unknown;
  motion?: Record<string, unknown> | null;
}

function readShare(value: unknown): number | null {
  if (value == null) return null;
  const share = Number(value);
  return Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : null;
}

export function playLnSkillsets(lnSkill: LnSkillResult | undefined, rate: number, info: ChartSkillInfo | undefined): LnFamilyVector | null {
  if (lnSkill?.version === LN_SKILL_VERSION) return lnSkill.skillsets ?? null;
  return rate === 1 ? info?.lnSkillsets ?? null : null;
}

export function playPatternsFor(info: ChartSkillInfo, rate: number, keyCount: number | null, lnSkill?: LnSkillResult): string[] {
  if (keyCount == null || !isLnSkillSupported(keyCount)) return info.patterns;
  const lnEffectiveRatio = rate === 1 ? info.lnEffectiveRatio
    : rate === 1.5 ? info.dtLnEffectiveRatio : rate === 0.75 ? info.htLnEffectiveRatio : null;
  const ratingIdentity = rate === 1 ? info.lnRatingIdentity === true
    : rate === 1.5 ? info.dtLnRatingIdentity === true : rate === 0.75 && info.htLnRatingIdentity === true;
  const eligible = lnSkill?.version === LN_SKILL_VERSION ? lnSkill.eligible || ratingIdentity
    : (!LN_EFFECTIVE_KEY_COUNTS.has(keyCount) || lnEffectiveRatio != null)
      && chartIsLn(keyCount, { lnRatio: info.lnRatio, lnEffectiveRatio }) === true;
  const rice = info.patterns.filter((id) => !LN_PATTERN_IDS.has(id));
  const skillsets = playLnSkillsets(lnSkill, rate, info);
  const families = skillsets ? LN_SKILLSET_IDS.filter(id => skillsets[id] >= PATTERN_TAG_MIN_SCORE) : [];
  return eligible ? [...rice, "ln", ...families] : rice;
}

export function clusterShare(parsed: LeanClassificationJson | null, pattern: RegExp): number | null {
  const clusters = Array.isArray(parsed?.clusters) ? parsed.clusters : [];
  let total = 0;
  let matched = 0;
  for (const cluster of clusters) {
    const importance = Number(cluster?.importance);
    if (!Number.isFinite(importance) || importance <= 0) continue;
    total += importance;
    if (pattern.test(String(cluster?.pattern ?? ""))) matched += importance;
  }
  return total > 0 ? matched / total : null;
}

const JACK_CLUSTERS = /jack/i;
const STREAM_CLUSTERS = /stream/i;

export const CLUSTER_SHARE_MIN = 0.4;

const TECH_CLUSTER_CATEGORY = /tech/i;

const RICE_TILE_JACK_SHARE = 0.5;
const RICE_TILE_HYBRID_JACK_SHARE = 0.4;
const RICE_TILE_DELAY_SCORE = 0.9;
const RICE_TILE_SINGLE_STREAM_SHARE = 0.4;
const RICE_TILE_TECH_LABEL_MAX_DENSE = 0.9;
const RICE_TILE_MIXED_SHARE = 0.25;
const RICE_TILE_MIXED_MAX_DENSE = 0.5;
const RICE_TILE_SPEED_TWO_BACK = 0.15;
const RICE_TILE_DELAY_SPEED_TWO_BACK = 0.2;
const RICE_TILE_DELAY_SHARED_TWO_BACK = 0.3;
const RICE_TILE_TECH_TWO_BACK = 0.25;
const RICE_TILE_TECH_SECTIONS = 0.3;

const RICE_TILE_SPEED_MAX_TECH_SECTIONS = 0.4;

const RICE_TILE_REPEATING_DELAY_SCORE = 0.7;
const RICE_TILE_REPEATING_MOTIF = 0.3;

const RICE_TILE_DELAY_JACK_SCORE = 0.7;
const RICE_TILE_DELAY_JACK_SHARE = 0.3;

const RICE_TILE_DENSE_CATEGORY = /dense chordstream/i;

const RICE_TILE_SPEED_PEAK = 0.2;

const RICE_TILE_ROLL_SECTIONS = 2;
const RICE_TILE_STREAM_TWO_BACK = 0.3;
const RICE_TILE_STREAM_JACK_SHARE = 0.2;

const RICE_TILE_RICE_CLUSTERS = /^(chordstream|stream|jacks?)$/i;
const RICE_TILE_RICE_SHARE_MAX_LN = 0.5;
const RICE_TILE_RICE_MIN_SHARE = 0.3;

const RICE_TILE_DENSE_SHARE = 0.5;
const RICE_TILE_CHORDSTREAM_SHARE = 0.85;
const RICE_TILE_DENSE_TECH_TWO_BACK = 0.2;
const RICE_TILE_DENSE_TECH_SECTIONS = 0.5;

function riceTiles7k(keyCount: number | null, parsed: LeanClassificationJson | null, delayScore: number, bracketScore: number): string[] | null {
  const tiles = riceShapeTiles7k(keyCount, parsed, delayScore, bracketScore);
  if (tiles == null || tiles.length !== 1) return tiles;
  const speedPeak = parsed?.riceShape?.speedPeak;
  if (tiles[0] === "stream" && typeof speedPeak === "number" && speedPeak >= RICE_TILE_SPEED_PEAK) return ["stream", "speed"];
  const rollSections = parsed?.riceShape?.rollSections;
  if (tiles[0] === "tech" && typeof rollSections === "number" && rollSections >= RICE_TILE_ROLL_SECTIONS) return ["tech", "speed"];
  return tiles;
}

function riceShapeTiles7k(keyCount: number | null, parsed: LeanClassificationJson | null, delayScore: number, bracketScore: number): string[] | null {
  if (keyCount !== 7) return null;
  const category = typeof parsed?.clusterCategory === "string" ? parsed.clusterCategory.trim() : "";
  const all = Array.isArray(parsed?.clusters) ? parsed.clusters : [];
  const lnRatio = Number(parsed?.lnRatio);
  const weight = (list: typeof all) => list.reduce((sum, cluster) => {
    const importance = Number(cluster?.importance);
    return Number.isFinite(importance) && importance > 0 ? sum + importance : sum;
  }, 0);
  const rice = all.filter((cluster) => RICE_TILE_RICE_CLUSTERS.test(String(cluster?.pattern ?? "")));
  const riceWeight = weight(rice);
  const useRice = riceWeight > 0 && riceWeight >= RICE_TILE_RICE_MIN_SHARE * weight(all) && !(lnRatio >= RICE_TILE_RICE_SHARE_MAX_LN);
  const clusters = useRice ? rice : all;
  let total = 0;
  let jack = 0;
  let singleStream = 0;
  let mixed = 0;
  let dense = 0;
  let chordstream = 0;
  for (const cluster of clusters) {
    const importance = Number(cluster?.importance);
    if (!Number.isFinite(importance) || importance <= 0) continue;
    total += importance;
    const pattern = String(cluster?.pattern ?? "");
    if (JACK_CLUSTERS.test(pattern)) jack += importance;
    if (pattern.toLowerCase() === "stream") singleStream += importance;
    if (CHORDSTREAM_CLUSTERS.test(pattern)) chordstream += importance;
    if (cluster?.mixed === true) mixed += importance;
    if (/dense/i.test(String(cluster?.label ?? ""))) dense += importance;
  }
  if (total <= 0 || category === "") return null;
  jack /= total;
  singleStream /= total;
  mixed /= total;
  dense /= total;
  chordstream /= total;
  const shape = parsed?.riceShape;
  const twoBack = typeof shape?.twoBack === "number" && Number.isFinite(shape.twoBack) ? shape.twoBack : null;
  const techSections = typeof shape?.techSections === "number" && Number.isFinite(shape.techSections) ? shape.techSections : null;
  const motifRepeat = typeof shape?.motifRepeat === "number" && Number.isFinite(shape.motifRepeat) ? shape.motifRepeat : null;
  const delay = delayScore >= RICE_TILE_DELAY_SCORE;
  const jackHeadline = JACK_CLUSTERS.test(category) && (!TECH_CLUSTER_CATEGORY.test(category) || jack >= RICE_TILE_HYBRID_JACK_SHARE);
  if (jackHeadline || jack >= RICE_TILE_JACK_SHARE) return ["jack"];
  if (twoBack == null) {
    if (delay || singleStream >= RICE_TILE_SINGLE_STREAM_SHARE) return ["speed"];
  } else {
    const rolls = twoBack < RICE_TILE_SPEED_TWO_BACK && (techSections ?? 0) < RICE_TILE_SPEED_MAX_TECH_SECTIONS;
    if (rolls || (delay && twoBack < RICE_TILE_DELAY_SPEED_TWO_BACK)) return ["speed"];
    if (delayScore >= RICE_TILE_REPEATING_DELAY_SCORE && (motifRepeat ?? 0) >= RICE_TILE_REPEATING_MOTIF) return ["speed"];
    if (delay && twoBack < RICE_TILE_DELAY_SHARED_TWO_BACK) return ["tech", "speed"];
  }
  if (delayScore >= RICE_TILE_DELAY_JACK_SCORE && jack >= RICE_TILE_DELAY_JACK_SHARE) return ["speed", "jack"];
  if (jack < RICE_TILE_HYBRID_JACK_SHARE && !TECH_CLUSTER_CATEGORY.test(category) && RICE_TILE_DENSE_CATEGORY.test(category)
    && mixed >= RICE_TILE_MIXED_SHARE && dense < RICE_TILE_MIXED_MAX_DENSE && twoBack != null && twoBack >= RICE_TILE_STREAM_TWO_BACK) {
    return jack >= RICE_TILE_STREAM_JACK_SHARE ? ["stream", "jack"] : ["stream"];
  }
  if (jack >= RICE_TILE_HYBRID_JACK_SHARE) return ["tech"];
  if (TECH_CLUSTER_CATEGORY.test(category) && dense < RICE_TILE_TECH_LABEL_MAX_DENSE) return ["tech"];
  if (mixed >= RICE_TILE_MIXED_SHARE && dense < RICE_TILE_MIXED_MAX_DENSE) return ["tech"];
  const denseChart = dense >= RICE_TILE_DENSE_SHARE || chordstream >= RICE_TILE_CHORDSTREAM_SHARE;
  if (twoBack != null && twoBack < (denseChart ? RICE_TILE_DENSE_TECH_TWO_BACK : RICE_TILE_TECH_TWO_BACK)) return ["tech"];
  if (techSections != null && techSections >= (denseChart ? RICE_TILE_DENSE_TECH_SECTIONS : RICE_TILE_TECH_SECTIONS)) return ["tech"];
  if (chordstream >= CLUSTER_SHARE_MIN || bracketScore >= PATTERN_TAG_MIN_SCORE) return ["stream"];
  return ["tech"];
}

const TRILL_CLUSTER_CATEGORY = /trill/i;

const HANDSTREAM_CLUSTER_CATEGORY = /handstream/i;
const JUMPSTREAM_CLUSTER_CATEGORY = /jumpstream/i;

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

function readRawDan(half: LeanHalfJson | null | undefined): number | null {
  if (half?.rawDan == null) return null;
  const rawDan = Number(half.rawDan);
  return Number.isFinite(rawDan) ? rawDan : null;
}

function readDanLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface StoredRateVerdict {
  rawDan?: unknown;
  primaryFamily?: unknown;
  primaryLabel?: unknown;
  lnEffectiveRatio?: unknown;
  lnRatingIdentity?: unknown;
  secondary?: { label?: unknown; family?: unknown; rawDan?: unknown };
}

function rateHybridRice(verdict: StoredRateVerdict | null): { rawDan: number; label: string | null } | null {
  if (verdict?.primaryFamily !== "ln" || verdict.secondary?.family !== "dan") return null;
  const rawDan = readRawDan(verdict.secondary);
  return rawDan == null ? null : { rawDan, label: readDanLabel(verdict.secondary.label) };
}

export function chartSkillInfoFromAnalysisRow(row: Record<string, unknown>): ChartSkillInfo {
  const parsed = readChartJson<LeanClassificationJson | null>(row.classification_json, null);
  const patternScores = new Map<string, number>();
  for (const hit of Array.isArray(parsed?.patterns) ? parsed.patterns : []) {
    const id = String(hit?.id ?? "");
    if (id) patternScores.set(id, Math.max(patternScores.get(id) ?? 0, Number(hit?.score ?? 0)));
  }
  const rawKeyCount = Number(row.key_count);
  const keyCount = Number.isFinite(rawKeyCount) && rawKeyCount > 0 ? rawKeyCount : null;
  const chordjackScore = patternScores.get("chordjack") ?? 0;
  const jackScore = patternScores.get("jack") ?? 0;
  const jackShare = clusterShare(parsed, JACK_CLUSTERS);
  const isJack = chartIsJack(keyCount, chordjackScore, jackScore, jackShare);
  const vetoesTech = jackVetoesTech(keyCount, chordjackScore, jackScore, jackShare);
  const rawLnRatio = Number(parsed?.lnRatio);
  const lnRatio = Number.isFinite(rawLnRatio) ? Math.max(0, Math.min(1, rawLnRatio)) : null;
  const lnEffectiveRatio = readShare(parsed?.lnEffectiveRatio);
  const chartReadsLn = chartIsLn(keyCount, { lnRatio, lnEffectiveRatio }) === true;
  const techCategory = typeof parsed?.clusterCategory === "string" && parsed.clusterCategory.trim() !== ""
    ? TECH_CLUSTER_CATEGORY.test(parsed.clusterCategory)
    : null;
  const isTech = chartIsTech(keyCount, patternScores.get("tech") ?? 0, vetoesTech, techCategory, chartReadsLn);
  const isChordstream = chartIsChordstream(keyCount, patternScores.get("chordstream") ?? 0, clusterShare(parsed, CHORDSTREAM_CLUSTERS));
  const patternIds = [...patternScores.entries()]
    .filter(([id, score]) =>
      id === "tech" ? isTech
      : id === "chordstream" ? isChordstream
      : score >= patternTagMinScore(id) && !(LN_PATTERN_IDS.has(id) && !chartReadsLn))
    .map(([id]) => id);
  if (isTech && !patternIds.includes("tech")) patternIds.push("tech");
  if (keyCount != null && usesPatternSkillAxes(keyCount) && isJack && !patternIds.includes("jack")) patternIds.push("jack");
  const danDt = parseJson<StoredRateVerdict | null>(String(row.dan_dt_json ?? ""), null);
  const dtRawDan = readRawDan(danDt ?? undefined);
  const danHt = parseJson<StoredRateVerdict | null>(String(row.dan_ht_json ?? ""), null);
  const htRawDan = readRawDan(danHt ?? undefined);
  const chartMsd = keyCount === 4
    ? readChartJson<{ values?: Record<string, number>; lnSkill?: Partial<LnSkillResult> } | null>(row.msd_json, null)
    : null;
  return {
    chartFamily: typeof row.family_key === "string" ? row.family_key : null,
    patterns: patternIds,
    lnPatterns: [...patternScores.entries()].filter(([id, score]) => LN_PATTERN_IDS.has(id) && score >= patternTagMinScore(id)).map(([id]) => id),
    jackDemand: parsed?.jackDemand?.detected === true,
    jackShare,
    streamShare: clusterShare(parsed, STREAM_CLUSTERS),
    techCategory,
    riceTiles: riceTiles7k(keyCount, parsed, patternScores.get("delay") ?? 0, patternScores.get("bracket") ?? 0),
    clusterTrill: typeof parsed?.clusterCategory === "string" && parsed.clusterCategory.trim() !== ""
      ? TRILL_CLUSTER_CATEGORY.test(parsed.clusterCategory)
      : null,
    handstreamCluster: typeof parsed?.clusterCategory === "string" && parsed.clusterCategory.trim() !== ""
      ? HANDSTREAM_CLUSTER_CATEGORY.test(parsed.clusterCategory)
      : null,
    jumpstreamCluster: typeof parsed?.clusterCategory === "string" && parsed.clusterCategory.trim() !== ""
      ? JUMPSTREAM_CLUSTER_CATEGORY.test(parsed.clusterCategory)
      : null,
    handstreamEndurance: keyCount === 4 && !chartReadsLn
      && hasHandstreamEndurance(chartMsd?.values),
    // Always null: `!chartIsLn` negates the function, not a boolean.
    msdValues: keyCount === 4 && !chartIsLn && chartMsd?.values && typeof chartMsd.values === "object"
      ? chartMsd.values
      : null,
    lnSkillsets: chartMsd?.lnSkill?.version === LN_SKILL_VERSION ? chartMsd.lnSkill.skillsets ?? null : null,
    techScore: vetoesTech ? 0 : (patternScores.get("tech") ?? 0),
    chordjackScore: chordjackScore,
    motion: readMotionFeatures(parsed?.motion),
    lnRatio,
    lnEffectiveRatio,
    lnRatingIdentity: parsed?.lnRatingIdentity === true,
    dtLnEffectiveRatio: readShare(danDt?.lnEffectiveRatio),
    htLnEffectiveRatio: readShare(danHt?.lnEffectiveRatio),
    dtLnRatingIdentity: danDt?.lnRatingIdentity === true,
    htLnRatingIdentity: danHt?.lnRatingIdentity === true,
    vibro: parsed?.vibro === true,
    unrateable: isUnrateableExclusion(parsed?.vibroAnalysis),
    revisionChecksum: typeof row.revision_checksum === "string" && row.revision_checksum ? row.revision_checksum : null,
    revisionUpdatedAt: typeof row.revision_updated_at === "string" && row.revision_updated_at ? row.revision_updated_at : null,
    revisionMutable: !["ranked", "approved", "loved"].includes(String(row.beatmap_status ?? "")),
    revisionDeleted: row.revision_deleted_at != null,
    revisionSameChartChecksums: readSameChartChecksums(row.revision_same_chart_md5s),
    danEligible: parsed?.danEligibility?.eligible !== false,
    rcRawDan: readRawDan(parsed?.rc),
    lnRawDan: readRawDan(parsed?.ln),
    hybrid: isHybridChart({ keyCount, lnRatio: parsed?.lnRatio, lnRiceShare: parsed?.lnRiceShare, lnWorkShare: parsed?.lnWorkShare }),
    hybridLn: hybridLnSectionsCredit(keyCount, parsed),
    rcDanLabel: readDanLabel(parsed?.rc?.displayName),
    lnDanLabel: readDanLabel(parsed?.ln?.displayName),
    dtRawDan,
    dtFamily: dtRawDan == null ? null : danDt?.primaryFamily === "ln" ? "ln" : "rc",
    dtDanLabel: readDanLabel(danDt?.primaryLabel),
    htRawDan,
    htFamily: htRawDan == null ? null : danHt?.primaryFamily === "ln" ? "ln" : "rc",
    htDanLabel: readDanLabel(danHt?.primaryLabel),
    dtHybridRice: rateHybridRice(danDt),
    htHybridRice: rateHybridRice(danHt),
    lengthSeconds: readLengthSeconds(row.total_length),
    od: readStoredOd(row.od),
    keyCount,
  };
}

function readStoredOd(value: unknown): number | null {
  const od = value == null ? Number.NaN : Number(value);
  return Number.isFinite(od) && od >= 0 && od <= 10 ? od : null;
}

export const DAN_MIN_OD = 5.5;

export function isUnverifiableRevision(
  play: Pick<StoredPlaySsr, "revisionPending" | "beatmapChecksum" | "startedAt" | "endedAt">,
  info: Pick<ChartSkillInfo, "revisionChecksum" | "revisionUpdatedAt" | "revisionMutable" | "revisionDeleted" | "revisionSameChartChecksums">,
): boolean {
  if (play.revisionPending !== true) return false;
  if (info.revisionDeleted) return true;
  if (play.beatmapChecksum && info.revisionChecksum) {
    return play.beatmapChecksum !== info.revisionChecksum && !info.revisionSameChartChecksums?.includes(play.beatmapChecksum);
  }
  if (!info.revisionMutable || !info.revisionUpdatedAt) return false;
  const played = Date.parse(play.startedAt ?? play.endedAt ?? "");
  const updated = Date.parse(info.revisionUpdatedAt);
  return Number.isFinite(played) && Number.isFinite(updated) && played < updated;
}

export function hybridRiceCreditFor(
  play: StoredPlaySsr,
  info: ChartSkillInfo,
  keyCount: number,
  target: DanClearTarget | null,
): { rawDan: number; label: string | null } | null {
  if (keyCount !== 4 || play.inverse || play.vibroAdjustment || danOdFlagForPlay(play) != null) return null;
  if (target?.side !== "ln") return null;
  if (!info.hybrid) return null;
  const rice = play.rate === 1 ? (info.rcRawDan != null ? { rawDan: info.rcRawDan, label: info.rcDanLabel } : null)
    : play.rate === 1.5 ? info.dtHybridRice ?? null
      : play.rate === 0.75 ? info.htHybridRice ?? null : null;
  return rice ? { rawDan: Math.max(rice.rawDan, danTableFloorFor("rc", keyCount)), label: rice.label } : null;
}

export function hybridLnCreditFor(
  play: StoredPlaySsr,
  info: ChartSkillInfo,
  keyCount: number,
  target: DanClearTarget | null,
): { rawDan: number; label: string | null } | null {
  if (keyCount !== 4 || play.inverse || play.vibroAdjustment || danOdFlagForPlay(play) != null) return null;
  if (target?.side !== "rc" || play.rate !== 1) return null;
  return info.hybridLn ?? null;
}

export function headlineFromSkillsets(keyCount: number, side: "rc" | "ln", ratedSkillsets: number): boolean {
  return ratedSkillsets >= DAN_SKILLSET_AVERAGE_MIN_BUCKETS && !headlineAlwaysFromClears(keyCount, side);
}
export const headlineAlwaysFromClears = (keyCount: number, side: "rc" | "ln") => keyCount === 4 && side === "ln";

export function parseOsuKeyCount(osuText: string): number | null {
  const match = osuText.match(/^CircleSize\s*:\s*(\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const keyCount = Math.round(Number(match[1]));
  return Number.isInteger(keyCount) && keyCount > 0 ? keyCount : null;
}

export function shouldCheckRateVibro(keyCount: number, rate: number, hasPpTrust: boolean): boolean {
  return keyCount === 4 || (rate !== 1 && !hasPpTrust);
}

export async function chartVibroAtRate(osuText: string, rate: number, hasPpTrust: boolean, baseVibro: boolean): Promise<RateVibroCheck | null> {
  try {
    return await checkRateVibroOnThread(osuText, rate, hasPpTrust, baseVibro);
  } catch {
    return checkRateVibro(osuText, rate, hasPpTrust, baseVibro);
  }
}

export function rateVibroVerdictWithoutPpTrust(osuText: string, rate: number, baseVibro: boolean): {
  vibro: boolean;
  adjustment?: Pick<VibroAnalysis, "excludedDurationMs" | "timeShare" | "noteShare" | "judgementShare">;
} | null {
  const check = checkRateVibro(osuText, rate, false, baseVibro);
  return check ? { vibro: check.vibro, adjustment: check.adjustment } : null;
}

export interface DanAttemptEntry {
  identity: string;
  goal: number;
  pp: number;
  evidence: Partial<StoredPlaySsr>;
  stable: number;
  v2: number | null;
  odFloorMet: boolean;
}

function danAttemptMeetsOdFloor(
  od: number | null | undefined,
  keyCount: number | null | undefined,
  inverse: boolean | undefined,
  info: Pick<ChartSkillInfo, "lnRatio" | "lnEffectiveRatio"> | undefined,
): boolean {
  return od == null || od >= daRatingOdFloorFor(keyCount, inverse, { lnRatio: info?.lnRatio, lnEffectiveRatio: info?.lnEffectiveRatio });
}

function danAttemptPlay(kept: StoredPlaySsr, attempt: DanAttemptEntry): StoredPlaySsr {
  return {
    ...kept,
    startedAt: undefined, beatmapChecksum: undefined, replayTimed: undefined,
    calibrationPending: undefined, pendingReason: undefined,
    ...attempt.evidence,
    identity: attempt.identity, goal: attempt.goal, pp: attempt.pp,
    ratingExcluded: true, danAttempt: true,
  };
}

export function danSkillsetBucketsForClear(
  buckets: DanSkillsetBucket[],
  clear: DanClearEvidence,
  chart: ChartSkillInfo | undefined,
): DanSkillsetBucket[] {
  const filed = danSkillsetBucketsForPlay(buckets, clear.play, chart);
  return clear.hybridSecondary ? filed.filter((bucket, index) => index === 0 || bucket.id !== "speed") : filed;
}

export const RICE_MSD_SKILLSETS = SKILL_RATING_SKILLSETS.filter(
  (skillset) => skillset !== "Overall" && skillset !== "Stamina" && skillset !== "Handstream",
);

export const BASE_MSD_SKILLSETS = SKILL_RATING_SKILLSETS.filter(
  (skillset) => skillset !== "Overall" && skillset !== "Stamina",
);

export function hasHandstreamEndurance(values: Record<string, number> | undefined): boolean {
  return dominantSkillset(values) === "Stamina"
    && dominantSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS)) === "Handstream";
}

export function pickSkillsets(values: Record<string, number> | undefined, keep: string[]): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const skillset of keep) {
    const value = Number(values?.[skillset] ?? 0);
    if (Number.isFinite(value) && value > 0) picked[skillset] = value;
  }
  return picked;
}

function readLengthSeconds(value: unknown): number | null {
  const seconds = Math.round(Number(value));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

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

export interface PlayerSkillScoreDetails {
  statistics: OsuScoreStatistics | null;
  maxCombo: number | null;
  totalScore: number | null;
  rank: string | null;
  scoreUrl: string | null;
}

export type ModInput = string[] | OsuMod[];

export interface SkillScore {
  accuracy: number;
  statistics?: OsuScoreStatistics | null;
  type?: string | null;
  legacy_score_id?: number | null;
  legacy_total_score?: number | null;
  mods?: ModInput;
  retainedRate?: number;
  wifeScoring?: "stable" | "lazer" | "unknown";
}

export interface PlayerSkillModeRatings {
  keyCount: number;
  analyzedPlays: number;
  ratings: Record<string, number>;
  patterns: PlayerSkillPatternRating[];
}

export interface DanAttemptSlotBest {
  stable?: DanAttemptEntry;
  v2?: DanAttemptEntry;
}

export interface SlotCandidate {
  goal: number;
  source: "top" | "tracked";
  stableAccuracy: number;
}

export function isNativeManiaOsu(osuText: string): boolean {
  return /^Mode\s*:\s*3\s*$/m.test(osuText);
}

export function ratingGoalFor(goal: number, vibroAdjustment: StoredPlaySsr["vibroAdjustment"] | undefined): number {
  return vibroAdjustment ? conservativeVibroAccuracy(goal, vibroAdjustment.judgementShare) : goal;
}

export function slotEntryRejection(
  score: { beatmapId: number; mods?: ModInput; retainedRate?: number },
  chart: { keyCount?: number | null; od: number | null; lnRatio?: number | null; lnEffectiveRatio?: number | null },
): "no_beatmap" | "chart_rewritten" | "no_single_rate" | "widened_windows" | null {
  if (!Number.isInteger(score.beatmapId) || score.beatmapId <= 0) return "no_beatmap";
  if (scoreRewritesChart(score.mods)) return "chart_rewritten";
  const inverse = scoreInvertsChart(score.mods);
  if (inverse && chart.keyCount != null && !INVERSE_MOD_KEY_COUNTS.has(chart.keyCount)) return "chart_rewritten";
  const rate = score.retainedRate ?? getPlayRate(score.mods);
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return "no_single_rate";
  const floor = daRatingOdFloorFor(chart.keyCount, inverse, { lnRatio: chart.lnRatio, lnEffectiveRatio: chart.lnEffectiveRatio });
  if (chart.od != null && daWidensHitWindows(difficultyAdjustOd(score.mods), chart.od, floor)) return "widened_windows";
  return null;
}

export async function slotWinnerRejection(input: {
  osuText: string;
  analysisKeyCount: number | null;
  inverse: boolean;
  rate: number;
  chartOd: number | null;
  odOverride: number | null;
  lnRatio: number | null;
  lnEffectiveRatio?: number | null;
  chartVibro: boolean;
  chartDanEligible?: boolean;
  ppBacked: boolean;
}): Promise<
  | { rejection: "widened_windows" | "chart_vibro" | "not_native_mania" | "unsupported_keymode" | "chart_rewritten" | "invert_failed" | "rate_vibro" | "pending" }
  | { rejection: null; ratedText: string; vibroAdjustment?: StoredPlaySsr["vibroAdjustment"] }> {
  if (input.odOverride != null && input.chartOd == null) {
    const floor = daRatingOdFloorFor(input.analysisKeyCount, input.inverse, { lnRatio: input.lnRatio, lnEffectiveRatio: input.lnEffectiveRatio });
    if (daWidensHitWindows(input.odOverride, parseOsuOd(input.osuText), floor)) return { rejection: "widened_windows" };
  }
  const chartVibro = input.chartVibro && !input.ppBacked;
  const knownKeyCount = input.analysisKeyCount || 0;
  if (input.chartDanEligible === false && isMsdSupportedKeyCount(knownKeyCount)) return { rejection: "chart_vibro" };
  if (chartVibro && knownKeyCount !== 4 && isMsdSupportedKeyCount(knownKeyCount)) return { rejection: "chart_vibro" };
  if (!isNativeManiaOsu(input.osuText)) return { rejection: "not_native_mania" };
  const keyCount = parseOsuKeyCount(input.osuText);
  if (keyCount == null || !isMsdSupportedKeyCount(keyCount)) return { rejection: "unsupported_keymode" };
  if (chartVibro && keyCount !== 4) return { rejection: "chart_vibro" };
  if (input.inverse && !INVERSE_MOD_KEY_COUNTS.has(keyCount)) return { rejection: "chart_rewritten" };
  const ratedText = ratedOsuTextFor(input.osuText, input.inverse);
  if (ratedText == null) return { rejection: "invert_failed" };
  if (shouldCheckRateVibro(keyCount, input.rate, input.ppBacked)) {
    const check = await chartVibroAtRate(ratedText, input.rate, input.ppBacked, input.chartVibro);
    if (check?.vibro) return { rejection: "rate_vibro" };
    if (!check) return { rejection: "pending" };
    return { rejection: null, ratedText, vibroAdjustment: check.adjustment };
  }
  return { rejection: null, ratedText };
}

export function slotCandidateWins(existing: SlotCandidate | undefined, next: SlotCandidate): boolean {
  if (!existing) return true;
  const tiedGoal = next.goal === existing.goal;
  const betterFloorAccuracy = tiedGoal && next.goal === SSR_GOAL_MIN && next.stableAccuracy > existing.stableAccuracy;
  const tiedQuality = tiedGoal && (next.goal > SSR_GOAL_MIN || next.stableAccuracy === existing.stableAccuracy);
  return next.goal > existing.goal || betterFloorAccuracy
    || (tiedQuality && next.source === "top" && existing.source === "tracked");
}

export function retainedPlayWinsSlot(previous: StoredPlaySsr, current: StoredPlaySsr | undefined): boolean {
  if (!current) return true;
  return (previous.goal > current.goal
    || (previous.ratingExcluded === true && current.ratingExcluded === true
      && (previous.stableAccuracy ?? previous.accuracy ?? 0) > (current.stableAccuracy ?? current.accuracy ?? 0)))
    && previous.identity !== current.identity;
}

export function retainedPlayKept(
  play: StoredPlaySsr,
  ctx: {
    refusedIdentities: ReadonlySet<string>;
    untrustedIdentities: ReadonlySet<string>;
    candidateRate: number | undefined;
    chart: { od: number | null; lnRatio: number | null; lnEffectiveRatio: number | null; vibro: boolean; danEligible?: boolean } | undefined;
    ppBacked: boolean;
  },
): boolean {
  if (!(play.goal > SSR_GOAL_MIN) && !play.ratingExcluded) return false;
  if (ctx.refusedIdentities.has(play.identity)) return false;
  if (!play.inverse && play.mods?.includes(INVERSE_MOD_VARIANT)) return false;
  if (play.inverse && !INVERSE_MOD_KEY_COUNTS.has(play.keyCount)) return false;
  if (play.odOverride != null) {
    const floor = daRatingOdFloorFor(play.keyCount, play.inverse, { lnRatio: play.inverse ? 1 : ctx.chart?.lnRatio, lnEffectiveRatio: ctx.chart?.lnEffectiveRatio });
    if (daWidensHitWindows(play.odOverride, ctx.chart?.od ?? null, floor)) return false;
  }
  if (ctx.chart?.danEligible === false) return false;
  if (ctx.chart?.vibro && play.keyCount !== 4 && play.source !== "top" && !ctx.ppBacked) return false;
  if (play.source !== "top" && ctx.untrustedIdentities.has(play.identity)) return false;
  if (ctx.candidateRate != null && ctx.candidateRate !== play.rate) return false;
  return true;
}

export function noteDanAttempt(best: DanAttemptSlotBest, attempt: DanAttemptEntry): DanAttemptSlotBest {
  const beats = (current: DanAttemptEntry | undefined, value: number | null, currentValue: number | null | undefined) =>
    current == null || currentValue == null
    || (attempt.odFloorMet !== current.odFloorMet ? attempt.odFloorMet : value! > currentValue);
  if (beats(best.stable, attempt.stable, best.stable?.stable)) best.stable = attempt;
  if (attempt.v2 != null && beats(best.v2, attempt.v2, best.v2?.v2)) best.v2 = attempt;
  return best;
}

export function pickDanAttempts(
  kept: StoredPlaySsr,
  best: DanAttemptSlotBest | undefined,
  chart: (Pick<ChartSkillInfo, "lnRatio" | "lnEffectiveRatio"> & { od?: number | null }) | undefined,
  refusedIdentities: ReadonlySet<string> = new Set(),
): StoredPlaySsr[] {
  if (!best || kept.neverRated) return [];
  const keptStable = kept.stableAccuracy ?? kept.accuracy ?? 0;
  const keptBarred = kept.ezWindows === true
    || !danAttemptMeetsOdFloor(kept.odOverride ?? chart?.od, kept.keyCount, kept.inverse, chart);
  const outranks = (attempt: DanAttemptEntry, value: number, keptValue: number | null | undefined) =>
    keptValue == null || value > keptValue || (keptBarred && attempt.odFloorMet);
  const picked = new Set<DanAttemptEntry>();
  if (best.stable && outranks(best.stable, best.stable.stable, keptStable)) picked.add(best.stable);
  if (best.v2?.v2 != null && outranks(best.v2, best.v2.v2, kept.scoreV2Accuracy)) picked.add(best.v2);
  const attempts: StoredPlaySsr[] = [];
  for (const attempt of picked) {
    if (attempt.identity === kept.identity || refusedIdentities.has(attempt.identity)) continue;
    attempts.push(danAttemptPlay(kept, attempt));
  }
  return attempts;
}

export function modeRatingsFor(keyCount: number, plays: StoredPlaySsr[]): PlayerSkillModeRatings {
  return {
    keyCount,
    analyzedPlays: plays.filter((play) => !play.ratingExcluded).length,
    ratings: aggregateModeRatings(plays),
    patterns: aggregateModePatternRatings(plays),
  };
}
