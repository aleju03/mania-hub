import type { LeanTrackerScore, OsuBeatmap, OsuMod, OsuScore, OsuScoreStatistics } from "./types";

const PP_WEIGHT_DECAY = 0.95;
const MAX_WEIGHTED_PP_SCORES = 100;
export type ScoreLike = OsuScore | LeanTrackerScore;

export interface ScoreDisplayValues {
  accuracy: number;
  isLazer: boolean;
  passed: boolean;
  rank: string;
  totalScore: number | null;
}

export function getScoreTimestamp(score: ScoreLike): string {
  return score.ended_at ?? score.created_at ?? "";
}

export function getScoreTimeMs(score: ScoreLike): number {
  const timestamp = getScoreTimestamp(score);
  return timestamp ? new Date(timestamp).getTime() : 0;
}

/** Extract acronym strings from mods array (handles both object and plain-string formats) */
export function getModAcronyms(mods: OsuMod[] | undefined, excludeCl = true): string[] {
  return (mods ?? [])
    .map((m: any) => (typeof m === "string" ? m : m?.acronym ?? ""))
    .filter((a: string) => a && (!excludeCl || a !== "CL"));
}

// Lazer rate-changing mods. A score with one of these at its default speed
// has no `settings.speed_change` in the API response; a custom rate does.
const MOD_RATE_DEFAULTS: Record<string, number> = {
  DT: 1.5,
  NC: 1.5,
  HT: 0.75,
  DC: 0.75,
};
const MANIA_KEY_MOD_COUNTS: Record<string, number> = {
  "1K": 1,
  "2K": 2,
  "3K": 3,
  "4K": 4,
  "5K": 5,
  "6K": 6,
  "7K": 7,
  "8K": 8,
  "9K": 9,
  "10K": 10,
};
const RATE_EPSILON = 0.0001;

export interface ModDisplay {
  acronym: string;
  /** Custom speed_change when the player picked a non-default rate (lazer only). */
  rate?: number;
}

export function getBeatmapKeyCount(beatmap: Pick<OsuBeatmap, "cs"> | null | undefined): number | null {
  const keys = Number(beatmap?.cs);
  if (!Number.isFinite(keys) || keys <= 0) return null;
  return Number.isInteger(keys) ? keys : Math.ceil(keys);
}

export function getBeatmapKeymodeLabel(
  beatmap: (Pick<OsuBeatmap, "cs"> & Partial<Pick<OsuBeatmap, "convert">>) | null | undefined,
): string | null {
  const keys = getBeatmapKeyCount(beatmap);
  if (keys == null) return null;
  return `${keys}K${beatmap?.convert ? " convert" : ""}`;
}

export function getManiaKeyModCount(mods: OsuMod[] | undefined): number | null {
  for (const acronym of getModAcronyms(mods, false)) {
    const keyCount = MANIA_KEY_MOD_COUNTS[acronym.toUpperCase()];
    if (keyCount != null) return keyCount;
  }
  return null;
}

/** Whether a beatmap object represents a convert rather than a native mania chart.
 *  The mania score endpoints return convert beatmaps with mode "mania" and
 *  convert: true; raw beatmap lookups report the original mode instead. */
export function isManiaConvertBeatmap(
  beatmap: (Pick<OsuBeatmap, "mode"> & Partial<Pick<OsuBeatmap, "convert">>) | null | undefined,
): boolean {
  if (!beatmap) return false;
  return beatmap.convert === true || (beatmap.mode != null && beatmap.mode !== "mania");
}

export function getEffectiveManiaKeyCount(
  beatmap: (Pick<OsuBeatmap, "cs" | "mode"> & Partial<Pick<OsuBeatmap, "convert">>) | null | undefined,
  mods: OsuMod[] | undefined,
): number | null {
  const keyModCount = getManiaKeyModCount(mods);
  if (keyModCount != null && isManiaConvertBeatmap(beatmap)) return keyModCount;
  return getBeatmapKeyCount(beatmap);
}

/** Key count to pass when parsing this score's .osu chart. Converts only honor
 *  the xK keymod (null lets the convert column formula decide, since the chart
 *  itself knows it is a Mode 0 file); native mania charts use the API key count. */
export function getManiaParseKeyCount(
  beatmap: (Pick<OsuBeatmap, "cs" | "mode"> & Partial<Pick<OsuBeatmap, "convert">>) | null | undefined,
  mods: OsuMod[] | undefined,
): number | null {
  if (isManiaConvertBeatmap(beatmap)) return getManiaKeyModCount(mods);
  return getBeatmapKeyCount(beatmap);
}

/** Effective speed multiplier for a score's mods. Returns the lazer custom
 *  `settings.speed_change` if present, otherwise the mod's default rate, else 1. */
export function getScoreRate(mods: OsuMod[] | undefined): number {
  for (const m of mods ?? []) {
    const acronym = typeof m === "string" ? m : (m as any)?.acronym ?? "";
    if (!acronym) continue;
    const defaultRate = MOD_RATE_DEFAULTS[acronym];
    if (defaultRate === undefined) continue;
    const rateSetting = typeof m === "object" ? Number((m as any)?.settings?.speed_change) : NaN;
    return Number.isFinite(rateSetting) && rateSetting > 0 ? rateSetting : defaultRate;
  }
  return 1;
}

/** Whether the active rate-changing mod also shifts pitch with speed. NC/DC
 *  scale audio sample rate (so pitch follows tempo); DT/HT keep pitch
 *  constant via time-stretching. Replay audio mirrors this so NC sounds
 *  like nightcore, not just sped-up DT. */
export function modShiftsPitchWithRate(mods: OsuMod[] | undefined): boolean {
  for (const m of mods ?? []) {
    const acronym = typeof m === "string" ? m : (m as any)?.acronym ?? "";
    if (acronym === "NC" || acronym === "DC") return true;
  }
  return false;
}

/** osu!lazer allows custom speed_change values for rate mods, but those
 *  scores are not ranked. Detect them so ranked-only surfaces can skip them. */
export function hasCustomRateMod(mods: OsuMod[] | undefined): boolean {
  for (const m of mods ?? []) {
    const acronym = typeof m === "string" ? m : (m as any)?.acronym ?? "";
    const defaultRate = MOD_RATE_DEFAULTS[acronym];
    if (defaultRate === undefined || typeof m !== "object") continue;

    const rateSetting = Number((m as any)?.settings?.speed_change);
    if (
      Number.isFinite(rateSetting) &&
      rateSetting > 0 &&
      Math.abs(rateSetting - defaultRate) > RATE_EPSILON
    ) {
      return true;
    }
  }
  return false;
}

/** Rebuilds a display list from acronyms that were stored without their
 *  settings, putting a custom rate back on whichever mod owns it. For records
 *  that keep the rate as one separate number rather than a full mod list. */
export function withModRate(acronyms: string[], rate: number | null | undefined): ModDisplay[] {
  const custom = Number(rate);
  return acronyms.map((acronym) => (
    Number.isFinite(custom) && custom > 0 && MOD_RATE_DEFAULTS[acronym] !== undefined
      ? { acronym, rate: custom }
      : { acronym }
  ));
}

/** Like `getModAcronyms`, but preserves lazer custom rate settings so the UI
 *  can render e.g. "0.9x" instead of the plain DC icon. */
export function getModDisplayList(mods: OsuMod[] | undefined, excludeCl = true): ModDisplay[] {
  const out: ModDisplay[] = [];
  for (const m of mods ?? []) {
    const acronym = typeof m === "string" ? m : (m as any)?.acronym ?? "";
    if (!acronym) continue;
    if (excludeCl && acronym === "CL") continue;
    const rateSetting = typeof m === "object" ? Number((m as any)?.settings?.speed_change) : NaN;
    const defaultRate = MOD_RATE_DEFAULTS[acronym];
    if (Number.isFinite(rateSetting) && defaultRate !== undefined && rateSetting !== defaultRate) {
      out.push({ acronym, rate: rateSetting });
    } else {
      out.push({ acronym });
    }
  }
  return out;
}

export type ScoreSpeedBucket = "ht" | "normal" | "dt";

/** Bucket a mania score by its effective speed mod. In osu!, HT/DC, NM, and
 *  DT/NC score pools are effectively distinct leaderboards — scores from one
 *  bucket shouldn't "snipe" another because totalScore across rate-mods isn't
 *  directly comparable. */
export function getScoreSpeedBucket(mods: string[]): ScoreSpeedBucket {
  for (const m of mods) {
    if (m === "DT" || m === "NC") return "dt";
    if (m === "HT" || m === "DC") return "ht";
  }
  return "normal";
}

/** Lane key for snipe-detection snapshots: combines speed bucket and client
 *  (lazer vs stable). Lazer and stable score differently enough that a
 *  cross-client "snipe" isn't meaningful; same reasoning applies to rate mods. */
export function getBoardLaneKey(mods: string[], isLazer: boolean): string {
  return `${getScoreSpeedBucket(mods)}:${isLazer ? "lazer" : "stable"}`;
}

export function getScoreIdentity(score: ScoreLike): string {
  if (score.id > 0) {
    return `id:${score.id}`;
  }

  const beatmapId = score.beatmap_id ?? score.beatmap?.id ?? "unknown";
  const timestamp = getScoreTimestamp(score) || score.started_at || "unknown";
  const mods = getModAcronyms(score.mods, false).join(",");

  return [
    "fallback",
    score.user_id,
    beatmapId,
    timestamp,
    score.passed ? "passed" : "failed",
    score.rank,
    score.max_combo,
    Math.round(score.accuracy * 10000),
    getDisplayedTotalScore(score) ?? 0,
    mods,
  ].join(":");
}

export function getDisplayedTotalScore(score: ScoreLike): number | null {
  return getScoreDisplayValues(score).totalScore;
}

function isLegacySubmittedScore(score: ScoreLike): boolean {
  if (score.type != null && score.type !== "solo_score") {
    return true;
  }

  return score.legacy_score_id != null || !!(score.legacy_total_score && score.legacy_total_score > 0);
}

export function isLazerScore(score: ScoreLike): boolean {
  return !isLegacySubmittedScore(score);
}

// Every .osr records the client that wrote it: stable stamps a yyyymmdd date,
// lazer everything from here up. This is the cutoff osu!'s own decoder uses to
// set IsLegacyScore (LegacyScoreEncoder.FIRST_LAZER_VERSION).
export const FIRST_LAZER_REPLAY_VERSION = 30_000_000;

// The replay viewer's judging flag: whether the play was scored by lazer's
// ruleset. An uploaded .osr has no API score to ask, so it falls back to the
// version its own header carries - without which every lazer upload rendered
// as a stable play, judged on stable windows and labelled "Stable".
export function scoreUsesLazerScoring(
  score: ScoreLike | null | undefined,
  replayGameVersion?: number | null,
): boolean {
  if (score != null) return isLazerScore(score);
  return (replayGameVersion ?? 0) >= FIRST_LAZER_REPLAY_VERSION;
}

// Only ranked and approved maps award pp; loved, qualified, and graveyard
// plays carry pp: null no matter how good they are. Gates every locally
// computed pp display so dan courses and other unranked charts don't show
// fictional numbers.
export function beatmapStatusAwardsPp(status: string | null | undefined): boolean {
  return status === "ranked" || status === "approved";
}

export type ManiaJudgementLabel = "MAX" | "300" | "200" | "100" | "50" | "Miss";

interface ManiaHitCounts {
  countMax: number;
  count300: number;
  count200: number;
  count100: number;
  count50: number;
  countMiss: number;
}

export interface ManiaJudgementCount {
  label: ManiaJudgementLabel;
  value: number;
}

function getManiaHitCounts(stats: OsuScoreStatistics | null | undefined): ManiaHitCounts {
  const safeStats = stats ?? {};
  return {
    countMax: safeStats.count_geki ?? safeStats.perfect ?? 0,
    count300: safeStats.count_300 ?? safeStats.great ?? 0,
    count200: safeStats.count_katu ?? safeStats.good ?? 0,
    count100: safeStats.count_100 ?? safeStats.ok ?? 0,
    count50: safeStats.count_50 ?? safeStats.meh ?? 0,
    countMiss: safeStats.count_miss ?? safeStats.miss ?? 0,
  };
}

export function getManiaJudgementCounts(stats: OsuScoreStatistics | null | undefined): ManiaJudgementCount[] {
  const counts = getManiaHitCounts(stats);
  return [
    { label: "MAX", value: counts.countMax },
    { label: "300", value: counts.count300 },
    { label: "200", value: counts.count200 },
    { label: "100", value: counts.count100 },
    { label: "50", value: counts.count50 },
    { label: "Miss", value: counts.countMiss },
  ];
}

/** Lazer mania score accuracy follows the score processor base values: MAX=305, 300=300, 200=200, 100=100, 50=50. */
function calculateLazerAccuracy(stats: OsuScoreStatistics): number {
  const { countMax, count300, count200, count100, count50, countMiss } = getManiaHitCounts(stats);
  const total = countMax + count300 + count200 + count100 + count50 + countMiss;
  if (total === 0) return 0;
  return (countMax * 305 + count300 * 300 + count200 * 200 + count100 * 100 + count50 * 50) / (total * 305);
}

/** Stable mania accuracy: MAX=300=300, 200=200, 100=100, 50=50, miss=0 */
function calculateStableAccuracy(stats: OsuScoreStatistics): number {
  const { countMax, count300, count200, count100, count50, countMiss } = getManiaHitCounts(stats);
  const total = countMax + count300 + count200 + count100 + count50 + countMiss;
  if (total === 0) return 0;
  return (countMax * 300 + count300 * 300 + count200 * 200 + count100 * 100 + count50 * 50) / (total * 300);
}

/** Mania accuracy on the scale the play was judged on, from raw counts rather
 *  than a score object. For an uploaded .osr, whose header counts are the only
 *  statistics there are: lazer writes its own judgements into the same legacy
 *  fields, so the counts are right either way and only the scale differs. */
export function getManiaAccuracyFromCounts(stats: OsuScoreStatistics, isLazer: boolean): number {
  return isLazer ? calculateLazerAccuracy(stats) : calculateStableAccuracy(stats);
}

function getPreferredTotalScore(score: ScoreLike, isLazer: boolean): number | null {
  const candidates = isLazer
    ? [score.classic_total_score, score.total_score, score.legacy_total_score, score.score]
    : [score.legacy_total_score, score.classic_total_score, score.total_score, score.score];

  for (const value of candidates) {
    if (value != null && value > 0) {
      return value;
    }
  }

  return null;
}

function getPreferredAccuracy(score: ScoreLike, isLazer: boolean): number {
  if (isLazer) {
    if (Number.isFinite(score.accuracy) && score.accuracy > 0) {
      return score.accuracy;
    }

    return calculateLazerAccuracy(score.statistics);
  }

  const stableAccuracy = calculateStableAccuracy(score.statistics);
  if (stableAccuracy > 0) {
    return stableAccuracy;
  }

  return score.accuracy;
}

/**
 * The grade osu!mania gives an accuracy. Stable and lazer share these
 * thresholds and differ only in how they compute accuracy, so the caller
 * passes the number that client displayed. Null when there is no usable
 * accuracy to grade, which is not the same as a bottom grade.
 */
export function getManiaGradeFromAccuracy(accuracy: number, mods?: OsuMod[] | string[]): string | null {
  if (!Number.isFinite(accuracy) || accuracy <= 0) {
    return null;
  }

  const silverGrade = getModAcronyms(mods as OsuMod[] | undefined).some((mod) => mod === "HD" || mod === "FI" || mod === "FL");
  if (accuracy >= 1) {
    return silverGrade ? "XH" : "X";
  }
  if (accuracy > 0.95) {
    return silverGrade ? "SH" : "S";
  }
  if (accuracy > 0.9) {
    return "A";
  }
  if (accuracy > 0.8) {
    return "B";
  }
  if (accuracy > 0.7) {
    return "C";
  }
  return "D";
}

function deriveStableManiaRank(score: ScoreLike): string | null {
  const mode = score.beatmap?.mode ?? "mania";
  if (mode !== "mania") {
    return null;
  }

  if (!score.passed) {
    return "F";
  }

  return getManiaGradeFromAccuracy(calculateStableAccuracy(score.statistics), score.mods);
}

function getPreferredRank(score: ScoreLike, isLazer: boolean): string {
  if (!isLazer) {
    const stableRank = deriveStableManiaRank(score);
    if (stableRank) {
      return stableRank;
    }
  }

  return score.passed ? score.rank : "F";
}

export function getScoreDisplayValues(score: ScoreLike): ScoreDisplayValues {
  const lazer = isLazerScore(score);
  const rank = getPreferredRank(score, lazer);

  return {
    accuracy: getPreferredAccuracy(score, lazer),
    isLazer: lazer,
    passed: score.passed && rank !== "D",
    rank,
    totalScore: getPreferredTotalScore(score, lazer),
  };
}

export function getDisplayedAccuracy(score: ScoreLike): number {
  return getScoreDisplayValues(score).accuracy;
}

/**
 * Mania accuracy on the stable 300-weighted scale, computed from raw judgement
 * counts so the maniacard always measures on one fixed scale. This is not the
 * number the API reports: a score's `accuracy` field carries the 305-weighted
 * (rainbow-MAX) value, checked against 5,821 lazer submissions in a prod
 * snapshot, all 5,821 of which match the 305 formula to 1e-6 and none the 300
 * one. So a lazer play reads about half a point higher here than on its own
 * score page, which is the point: the card measures every play on one scale,
 * and dropping the MAX-vs-300 distinction keeps lazer's separate, great-skewed
 * LN tail judgements from leaking in. Any surface that shows this number next
 * to the player's own has to name the scale (as the dan evidence rows do) or
 * it reads as a miscalculation. Falls back to the displayed accuracy when
 * judgement counts are missing.
 */
export function getStableScaleManiaAccuracy(score: ScoreLike): number {
  const stableAccuracy = calculateStableAccuracy(score.statistics);
  return stableAccuracy > 0 ? stableAccuracy : getDisplayedAccuracy(score);
}

export function getDisplayedRank(score: ScoreLike): string {
  return getScoreDisplayValues(score).rank;
}

export function isDisplayedPassed(score: ScoreLike): boolean {
  return getScoreDisplayValues(score).passed;
}

export function scoreHasReplay(score: ScoreLike): boolean {
  return score.has_replay ?? score.replay ?? false;
}

export function getBeatmapUrl(score: ScoreLike): string | null {
  return score.beatmap?.url ?? (
    score.beatmap?.id != null
      ? `https://osu.ppy.sh/beatmaps/${score.beatmap.id}`
      : null
  );
}

export function getScoreUrl(score: ScoreLike): string | null {
  if (score.id <= 0) return null;

  // Lazer score — universal URL without ruleset prefix
  if (score.type === "solo_score") {
    return `https://osu.ppy.sh/scores/${score.id}`;
  }

  // Legacy/stable score — needs ruleset prefix
  const ruleset = score.beatmap?.mode ?? "mania";
  return `https://osu.ppy.sh/scores/${ruleset}/${score.id}`;
}

type WeightedPpScore = Pick<OsuScore, "pp"> & Partial<Pick<OsuScore, "id">>;

function sortWeightedPpScores(scores: WeightedPpScore[]): WeightedPpScore[] {
  return [...scores]
    .filter((score) => score.pp != null && score.pp > 0)
    .sort((a, b) => {
      const ppDiff = (b.pp ?? 0) - (a.pp ?? 0);
      if (ppDiff !== 0) return ppDiff;
      return (a.id ?? 0) - (b.id ?? 0);
    });
}

export function calculateWeightedPpTotal(scores: Array<Pick<OsuScore, "pp">>): number {
  return sortWeightedPpScores(scores as WeightedPpScore[]).slice(0, MAX_WEIGHTED_PP_SCORES).reduce((total, score, index) => {
    const pp = score.pp ?? 0;
    return total + pp * PP_WEIGHT_DECAY ** index;
  }, 0);
}

export function calculateApproxPpGainMap(bestScores: OsuScore[]): Record<number, number> {
  const rankedBestScores = sortWeightedPpScores(bestScores);
  const weightedWithAll = calculateWeightedPpTotal(rankedBestScores);
  const gains: Record<number, number> = {};

  rankedBestScores.forEach((score) => {
    const withoutScore = rankedBestScores.filter((candidate) => candidate.id !== score.id);
    const weightedWithoutScore = calculateWeightedPpTotal(withoutScore);
    const gain = weightedWithAll - weightedWithoutScore;

    if (gain > 0 && score.id != null) {
      gains[score.id] = gain;
    }
  });

  return gains;
}

export function calculateReplacementPpGain(
  bestScores: WeightedPpScore[],
  currentScoreId: number,
  previousScore: WeightedPpScore | null,
): number {
  const rankedBestScores = sortWeightedPpScores(bestScores);
  if (!rankedBestScores.some((score) => score.id === currentScoreId)) {
    return 0;
  }

  const weightedWithAll = calculateWeightedPpTotal(rankedBestScores);
  const hypotheticalScores = rankedBestScores.filter((score) => score.id !== currentScoreId);

  if (
    previousScore &&
    previousScore.id !== currentScoreId &&
    previousScore.pp != null &&
    previousScore.pp > 0
  ) {
    hypotheticalScores.push(previousScore);
  }

  const weightedWithPrevious = calculateWeightedPpTotal(hypotheticalScores);
  const gain = weightedWithAll - weightedWithPrevious;
  return gain > 0 ? gain : 0;
}
