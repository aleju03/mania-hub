import type { LeanTrackerScore, OscScore, OsuMod, OsuScoreStatistics } from "./types.js";

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

export function getDisplayedAccuracy(score: ScoreLike): number {
  if (isLazerScore(score) && Number.isFinite(score.accuracy) && score.accuracy > 0) return score.accuracy;
  return calculateStableAccuracy(score.statistics) || score.accuracy;
}

export function scoreHasReplay(score: ScoreLike): boolean {
  return score.has_replay ?? score.replay ?? false;
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
