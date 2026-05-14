import type { LeanTrackerScore, OscScore, OsuMod, OsuScoreStatistics } from "./types.js";

const PP_WEIGHT_DECAY = 0.95;

export type ScoreLike = OscScore | LeanTrackerScore;

export function nowIso(): string {
  return new Date().toISOString();
}

export function getScoreTimestamp(score: ScoreLike): string {
  return score.ended_at ?? score.created_at ?? "";
}

export function getModAcronyms(mods: OsuMod[] | undefined, excludeCl = true): string[] {
  return (mods ?? [])
    .map((m: unknown) => (typeof m === "string" ? m : (m as OsuMod)?.acronym ?? ""))
    .filter((acronym) => acronym && (!excludeCl || acronym !== "CL"));
}

function isLegacySubmittedScore(score: ScoreLike): boolean {
  if (score.type != null && score.type !== "solo_score") return true;
  return score.legacy_score_id != null || !!(score.legacy_total_score && score.legacy_total_score > 0);
}

export function isLazerScore(score: ScoreLike): boolean {
  return !isLegacySubmittedScore(score);
}

function getHitCounts(stats: OsuScoreStatistics | null | undefined) {
  const safe = stats ?? {};
  return {
    countMax: safe.count_geki ?? safe.perfect ?? 0,
    count300: safe.count_300 ?? safe.great ?? 0,
    count200: safe.count_katu ?? safe.good ?? 0,
    count100: safe.count_100 ?? safe.ok ?? 0,
    count50: safe.count_50 ?? safe.meh ?? 0,
    countMiss: safe.count_miss ?? safe.miss ?? 0,
  };
}

function calculateStableAccuracy(stats: OsuScoreStatistics): number {
  const counts = getHitCounts(stats);
  const total = counts.countMax + counts.count300 + counts.count200 + counts.count100 + counts.count50 + counts.countMiss;
  if (total === 0) return 0;
  return (counts.countMax * 300 + counts.count300 * 300 + counts.count200 * 200 + counts.count100 * 100 + counts.count50 * 50) / (total * 300);
}

function getPreferredTotalScore(score: ScoreLike, isLazer: boolean): number | null {
  const candidates = isLazer
    ? [score.classic_total_score, score.total_score, score.legacy_total_score, score.score]
    : [score.legacy_total_score, score.classic_total_score, score.total_score, score.score];
  for (const value of candidates) {
    if (value != null && value > 0) return value;
  }
  return null;
}

export function getDisplayedTotalScore(score: ScoreLike): number | null {
  return getPreferredTotalScore(score, isLazerScore(score));
}

export function getScoreIdentity(score: ScoreLike): string {
  const officialId = score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id;
  if (officialId > 0) return `official:${officialId}`;
  const beatmapId = score.beatmap_id ?? score.beatmap?.id ?? "unknown";
  const timestamp = score.ended_at ?? score.created_at ?? score.started_at ?? "unknown";
  const mods = getModAcronyms(score.mods, false).join(",");
  return [
    "recent",
    score.user_id,
    beatmapId,
    timestamp,
    mods,
    score.rank,
    Math.round(getDisplayedAccuracy(score) * 1_000_000),
    getDisplayedTotalScore(score) ?? score.score ?? 0,
  ].join(":");
}

export function getDisplayedAccuracy(score: ScoreLike): number {
  if (isLazerScore(score) && Number.isFinite(score.accuracy) && score.accuracy > 0) return score.accuracy;
  return calculateStableAccuracy(score.statistics) || score.accuracy;
}

export function scoreHasReplay(score: ScoreLike): boolean {
  return score.has_replay ?? score.replay ?? false;
}

export function hasPublicLeaderboardStatus(status: unknown): boolean {
  const normalized = String(status ?? "").toLowerCase();
  return normalized === "ranked"
    || normalized === "approved"
    || normalized === "loved"
    || normalized === "qualified";
}

export function scoreHasPublicLeaderboard(score: Pick<OscScore, "ranked" | "beatmap" | "beatmapset">): boolean {
  if (typeof score.ranked === "boolean") return score.ranked;
  return hasPublicLeaderboardStatus(score.beatmap?.status ?? score.beatmapset?.status);
}

export type ScoreSpeedBucket = "ht" | "normal" | "dt";

export function getScoreSpeedBucket(mods: string[]): ScoreSpeedBucket {
  for (const mod of mods) {
    if (mod === "DT" || mod === "NC") return "dt";
    if (mod === "HT" || mod === "DC") return "ht";
  }
  return "normal";
}

export function getBoardLaneKey(mods: string[], isLazer: boolean): string {
  return `${getScoreSpeedBucket(mods)}:${isLazer ? "lazer" : "stable"}`;
}

export function calculateWeightedPp(pp: number, position: number): number {
  return pp * 0.95 ** position;
}

type WeightedPpScore = Pick<OscScore, "pp"> & Partial<Pick<OscScore, "id">>;

function sortWeightedPpScores(scores: WeightedPpScore[]): WeightedPpScore[] {
  return [...scores]
    .filter((score) => score.pp != null && score.pp > 0)
    .sort((a, b) => {
      const ppDiff = (b.pp ?? 0) - (a.pp ?? 0);
      if (ppDiff !== 0) return ppDiff;
      return (a.id ?? 0) - (b.id ?? 0);
    });
}

export function calculateWeightedPpTotal(scores: Array<Pick<OscScore, "pp">>): number {
  return sortWeightedPpScores(scores as WeightedPpScore[]).reduce((total, score, index) => {
    const pp = score.pp ?? 0;
    return total + pp * PP_WEIGHT_DECAY ** index;
  }, 0);
}

export function calculateApproxPpGainMap(bestScores: OscScore[]): Record<number, number> {
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

export function toLeanTrackerScore(score: OscScore): LeanTrackerScore {
  if (!score.beatmap || !score.beatmapset || !score.user) {
    throw new Error(`score ${score.id} is missing display metadata`);
  }
  return {
    id: score.id,
    legacy_score_id: score.legacy_score_id,
    user_id: score.user_id,
    accuracy: score.accuracy,
    beatmap_id: score.beatmap_id ?? score.beatmap.id,
    mods: score.mods,
    score: score.score,
    total_score: score.total_score,
    classic_total_score: score.classic_total_score,
    legacy_total_score: score.legacy_total_score,
    max_combo: score.max_combo,
    passed: score.passed,
    rank: score.rank,
    statistics: score.statistics,
    pp: score.pp,
    beatmap: score.beatmap,
    beatmapset: {
      id: score.beatmapset.id,
      title: score.beatmapset.title,
      artist: score.beatmapset.artist,
      covers: score.beatmapset.covers,
    },
    user: score.user,
    created_at: score.created_at,
    started_at: score.started_at,
    ended_at: score.ended_at,
    replay: score.replay,
    has_replay: score.has_replay,
    type: score.type,
  };
}
