import type { OsuMod, OsuScore, OsuScoreStatistics } from "./types";

const PP_WEIGHT_DECAY = 0.95;

export interface ScoreDisplayValues {
  accuracy: number;
  isLazer: boolean;
  passed: boolean;
  rank: string;
  totalScore: number | null;
}

export function getScoreTimestamp(score: OsuScore): string {
  return score.ended_at ?? score.created_at ?? "";
}

export function getScoreTimeMs(score: OsuScore): number {
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

export interface ModDisplay {
  acronym: string;
  /** Custom speed_change when the player picked a non-default rate (lazer only). */
  rate?: number;
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

export function getScoreIdentity(score: OsuScore): string {
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

export function getDisplayedTotalScore(score: OsuScore): number | null {
  return getScoreDisplayValues(score).totalScore;
}

function isLegacySubmittedScore(score: OsuScore): boolean {
  if (score.type != null && score.type !== "solo_score") {
    return true;
  }

  return score.legacy_score_id != null || !!(score.legacy_total_score && score.legacy_total_score > 0);
}

export function isLazerScore(score: OsuScore): boolean {
  return !isLegacySubmittedScore(score);
}

/** Lazer mania score accuracy follows the score processor base values: MAX=305, 300=300, 200=200, 100=100, 50=50. */
function calculateLazerAccuracy(stats: OsuScoreStatistics): number {
  const countMax = stats.count_geki ?? stats.perfect ?? 0;
  const count300 = stats.count_300 ?? stats.great ?? 0;
  const count200 = stats.count_katu ?? stats.good ?? 0;
  const count100 = stats.count_100 ?? stats.ok ?? 0;
  const count50 = stats.count_50 ?? stats.meh ?? 0;
  const countMiss = stats.count_miss ?? stats.miss ?? 0;
  const total = countMax + count300 + count200 + count100 + count50 + countMiss;
  if (total === 0) return 0;
  return (countMax * 305 + count300 * 300 + count200 * 200 + count100 * 100 + count50 * 50) / (total * 305);
}

/** Stable mania accuracy: MAX=300=300, 200=200, 100=100, 50=50, miss=0 */
function calculateStableAccuracy(stats: OsuScoreStatistics): number {
  const countMax = stats.count_geki ?? stats.perfect ?? 0;
  const count300 = stats.count_300 ?? stats.great ?? 0;
  const count200 = stats.count_katu ?? stats.good ?? 0;
  const count100 = stats.count_100 ?? stats.ok ?? 0;
  const count50 = stats.count_50 ?? stats.meh ?? 0;
  const countMiss = stats.count_miss ?? stats.miss ?? 0;
  const total = countMax + count300 + count200 + count100 + count50 + countMiss;
  if (total === 0) return 0;
  return (countMax * 300 + count300 * 300 + count200 * 200 + count100 * 100 + count50 * 50) / (total * 300);
}

function getPreferredTotalScore(score: OsuScore, isLazer: boolean): number | null {
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

function getPreferredAccuracy(score: OsuScore, isLazer: boolean): number {
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

function deriveStableManiaRank(score: OsuScore): string | null {
  const mode = score.beatmap?.mode ?? "mania";
  if (mode !== "mania") {
    return null;
  }

  if (!score.passed) {
    return "F";
  }

  const stableAccuracy = calculateStableAccuracy(score.statistics);
  if (!Number.isFinite(stableAccuracy) || stableAccuracy <= 0) {
    return null;
  }

  const silverGrade = getModAcronyms(score.mods).some((mod) => mod === "HD" || mod === "FI" || mod === "FL");
  if (stableAccuracy >= 1) {
    return silverGrade ? "XH" : "X";
  }
  if (stableAccuracy > 0.95) {
    return silverGrade ? "SH" : "S";
  }
  if (stableAccuracy > 0.9) {
    return "A";
  }
  if (stableAccuracy > 0.8) {
    return "B";
  }
  if (stableAccuracy > 0.7) {
    return "C";
  }
  return "D";
}

function getPreferredRank(score: OsuScore, isLazer: boolean): string {
  if (!isLazer) {
    const stableRank = deriveStableManiaRank(score);
    if (stableRank) {
      return stableRank;
    }
  }

  return score.passed ? score.rank : "F";
}

export function getScoreDisplayValues(score: OsuScore): ScoreDisplayValues {
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

export function getDisplayedAccuracy(score: OsuScore): number {
  return getScoreDisplayValues(score).accuracy;
}

export function getDisplayedRank(score: OsuScore): string {
  return getScoreDisplayValues(score).rank;
}

export function isDisplayedPassed(score: OsuScore): boolean {
  return getScoreDisplayValues(score).passed;
}

export function scoreHasReplay(score: OsuScore): boolean {
  return score.has_replay ?? score.replay ?? false;
}

export function getBeatmapUrl(score: OsuScore): string | null {
  return score.beatmap?.url ?? (
    score.beatmap?.id != null
      ? `https://osu.ppy.sh/beatmaps/${score.beatmap.id}`
      : null
  );
}

export function getScoreUrl(score: OsuScore): string | null {
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
  return sortWeightedPpScores(scores as WeightedPpScore[]).reduce((total, score, index) => {
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
