// Judgement and accuracy helpers for osu! scores: stable, ScoreV2 and pp
// accuracy from judgement counts, the accuracy, grade and total score a score
// displays, and which client (stable or lazer) submitted it. Only the helpers
// the player rating modules use are kept here.

/** One mod as the osu! API sends it. Some payloads carry bare acronym strings instead. */
export interface OsuMod {
  acronym: string;
  settings?: Record<string, unknown>;
}

/**
 * Judgement counts. Stable payloads use count_* names, lazer payloads use the
 * judgement names; either set may be present.
 */
export interface OsuScoreStatistics {
  count_geki?: number;
  count_300?: number;
  count_katu?: number;
  count_100?: number;
  count_50?: number;
  count_miss?: number;
  perfect?: number;
  great?: number;
  good?: number;
  ok?: number;
  meh?: number;
  miss?: number;
  [other: string]: number | undefined;
}

/** The score fields these helpers read (a subset of the osu! API score object). */
export interface OscScore {
  id: number;
  legacy_score_id?: number | null;
  user_id: number;
  beatmap_id?: number | null;
  beatmap?: { id: number; mode?: string } | null;
  mods?: OsuMod[];
  accuracy: number;
  rank: string;
  passed: boolean;
  statistics: OsuScoreStatistics;
  score?: number | null;
  total_score?: number | null;
  classic_total_score?: number | null;
  legacy_total_score?: number | null;
  // "solo_score" for lazer submissions; any other type is a legacy submission.
  type?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  has_replay?: boolean;
  replay?: boolean;
}

export type ScoreLike = OscScore;

export interface ScoreHitCounts {
  /** Perfect / rainbow 300 (geki). */
  max: number;
  great: number; // 300
  good: number; // 200 (katu)
  ok: number; // 100
  meh: number; // 50
  miss: number;
}

export function getModAcronyms(mods: OsuMod[] | undefined, excludeCl = true): string[] {
  return (mods ?? [])
    .map((mod: unknown) => (typeof mod === "string" ? mod : (mod as OsuMod)?.acronym ?? ""))
    .filter((acronym) => acronym && (!excludeCl || acronym !== "CL"));
}

/** A lazer submission: not a legacy score type, no legacy score id, no legacy total. */
export function isLazerScore(score: ScoreLike): boolean {
  return !isLegacySubmittedScore(score);
}

/** Judgement breakdown (max/300/200/100/50/miss) across both statistic shapes. */
export function getScoreHitCounts(score: Pick<ScoreLike, "statistics">): ScoreHitCounts {
  const counts = getHitCounts(score.statistics);
  return {
    max: counts.countMax,
    great: counts.count300,
    good: counts.count200,
    ok: counts.count100,
    meh: counts.count50,
    miss: counts.countMiss,
  };
}

/** Stable display accuracy, share 0-1: MAX and 300 both weigh 300. 0 without judgement counts. */
export function calculateStableAccuracy(stats: OsuScoreStatistics): number {
  const counts = getHitCounts(stats);
  const total = counts.countMax + counts.count300 + counts.count200 + counts.count100 + counts.count50 + counts.countMiss;
  if (total === 0) return 0;
  return (counts.countMax * 300 + counts.count300 * 300 + counts.count200 * 200 + counts.count100 * 100 + counts.count50 * 50) / (total * 300);
}

// ScoreV2 / lazer accuracy, share 0-1: MAX weighs 305 against a 305
// denominator. Computed from judgement counts, so a stable play and a lazer
// play of the same performance land on the same number, and dan tables that
// set their bar in ScoreV2 terms (4K LN) can be checked against either client
// without an assumed offset. 0 without judgement counts.
export function calculateScoreV2Accuracy(stats: OsuScoreStatistics | null | undefined): number {
  const counts = getHitCounts(stats);
  const total = counts.countMax + counts.count300 + counts.count200 + counts.count100 + counts.count50 + counts.countMiss;
  if (total === 0) return 0;
  const weighted = counts.countMax * 305 + counts.count300 * 300 + counts.count200 * 200 + counts.count100 * 100 + counts.count50 * 50;
  return Math.min(1, Math.max(0, weighted / (total * 305)));
}

/** Lazer scores show their own accuracy; stable scores show the stable accuracy from counts. */
export function getDisplayedAccuracy(score: ScoreLike): number {
  if (isLazerScore(score) && Number.isFinite(score.accuracy) && score.accuracy > 0) return score.accuracy;
  return calculateStableAccuracy(score.statistics) || score.accuracy;
}

/** Stable scores get the grade stable would show; lazer scores keep theirs. Failed plays are F. */
export function getDisplayedRank(score: ScoreLike): string {
  if (!isLazerScore(score)) {
    const stableRank = deriveStableManiaRank(score);
    if (stableRank) return stableRank;
  }

  return score.passed ? score.rank : "F";
}

export function getDisplayedTotalScore(score: ScoreLike): number | null {
  return getPreferredTotalScore(score, isLazerScore(score));
}

/**
 * The pp-weighted (320) accuracy of a play, share 0-1, or null without
 * judgement counts. For a fixed map and mods, mania pp is linear in
 * (5 * accuracy - 4), and the value is the same for stable and lazer
 * submissions of the same play.
 */
export function getStoredScoreAccuracy(score: ScoreLike): number | null {
  const accuracy = ppAccuracyFromStatistics(score.statistics);
  return accuracy != null && accuracy > 0 ? accuracy : null;
}

/**
 * A key that identifies one play: the official score id when there is one,
 * otherwise the player, beatmap, time, mods, grade, accuracy and total score.
 */
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

export function scoreHasReplay(score: ScoreLike): boolean {
  return score.has_replay ?? score.replay ?? false;
}

function isLegacySubmittedScore(score: ScoreLike): boolean {
  if (score.type != null && score.type !== "solo_score") return true;
  return score.legacy_score_id != null || !!(score.legacy_total_score && score.legacy_total_score > 0);
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

// ManiaPerformanceCalculator.calculateCustomAccuracy over raw statistics:
// Perfect weighs 320. Null without judgement counts. Same formula as
// calculateManiaCustomAccuracy in pp.ts, except that one clamps a negative
// miss count to 0 and returns 0 instead of null.
function ppAccuracyFromStatistics(stats: OsuScoreStatistics | null | undefined): number | null {
  const counts = getHitCounts(stats);
  const total = counts.countMax + counts.count300 + counts.count200 + counts.count100 + counts.count50 + counts.countMiss;
  if (total <= 0) return null;
  const weighted = counts.countMax * 320 + counts.count300 * 300 + counts.count200 * 200 + counts.count100 * 100 + counts.count50 * 50;
  return Math.min(1, Math.max(0, weighted / (total * 320)));
}

// Stable mania grades from stable accuracy: SS at 100%, S above 95%, A above
// 90%, B above 80%, C above 70%, else D. HD, FI and FL give the silver SS/S.
// Null for non-mania beatmaps or when there are no judgement counts.
function deriveStableManiaRank(score: ScoreLike): string | null {
  const mode = score.beatmap?.mode ?? "mania";
  if (mode !== "mania") return null;
  if (!score.passed) return "F";

  const stableAccuracy = calculateStableAccuracy(score.statistics);
  if (!Number.isFinite(stableAccuracy) || stableAccuracy <= 0) return null;

  const silverGrade = getModAcronyms(score.mods).some((mod) => mod === "HD" || mod === "FI" || mod === "FL");
  if (stableAccuracy >= 1) return silverGrade ? "XH" : "X";
  if (stableAccuracy > 0.95) return silverGrade ? "SH" : "S";
  if (stableAccuracy > 0.9) return "A";
  if (stableAccuracy > 0.8) return "B";
  if (stableAccuracy > 0.7) return "C";
  return "D";
}

// Lazer scores prefer the classic total, stable scores the legacy total; the
// first positive candidate wins.
function getPreferredTotalScore(score: ScoreLike, isLazer: boolean): number | null {
  const candidates = isLazer
    ? [score.classic_total_score, score.total_score, score.legacy_total_score, score.score]
    : [score.legacy_total_score, score.classic_total_score, score.total_score, score.score];
  for (const value of candidates) {
    if (value != null && value > 0) return value;
  }
  return null;
}
