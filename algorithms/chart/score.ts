export interface OsuMod {
  acronym: string;
  settings?: Record<string, string | number | boolean>;
}

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
}

export interface OsuBeatmap {
  checksum?: string | null;
  last_updated?: string;
  id: number;
  beatmapset_id: number;
  difficulty_rating: number;
  mode: string;
  status?: string;
  cs: number;
  convert?: boolean;
  bpm: number;
  note_bpm?: number | null;
  max_combo?: number;
  version: string;
  url: string;
}

export interface OsuBeatmapset {
  id: number;
  title: string;
  artist: string;
  creator?: string;
  covers: {
    cover?: string;
    "cover@2x"?: string;
    card?: string;
    "card@2x"?: string;
    list?: string;
    "list@2x"?: string;
    slimcover?: string;
    "slimcover@2x"?: string;
  };
  status?: string;
}

export interface ScoreUser {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
  avatar_accent?: string | null;
}

export interface OscScore {
  beatmapChecksum?: string;
  id: number;
  best_id?: number | null;
  legacy_score_id?: number | null;
  user_id: number;
  accuracy: number;
  beatmap_id?: number;
  ruleset_id?: number;
  mods: OsuMod[];
  score: number;
  total_score?: number;
  classic_total_score?: number;
  legacy_total_score?: number;
  max_combo: number;
  passed: boolean;
  rank: string;
  statistics: OsuScoreStatistics;
  pp: number | null;
  beatmap?: OsuBeatmap;
  beatmapset?: OsuBeatmapset;
  user?: ScoreUser;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string;
  replay?: boolean;
  has_replay?: boolean;
  processed?: boolean;
  ranked?: boolean;
  type?: string;
  weight?: { percentage: number; pp: number };
  companellaTimed?: Pick<CompanellaScoreMark, "app"> & {
    importId?: string;
  };
}

export interface CompanellaScoreMark {
  importId: string;
  replay: boolean;
  app?: string;
  reference?: { beatmapId: number; rate: number; version?: string };
  localBeatmapId?: number;
  video?: string;
  client?: "stable" | "lazer";
}

export interface LeanTrackerScore extends Required<Pick<OscScore, "id" | "user_id" | "accuracy" | "mods" | "score" | "max_combo" | "passed" | "rank" | "statistics" | "pp">> {
  legacy_score_id?: number | null;
  beatmap_id?: number;
  total_score?: number;
  classic_total_score?: number;
  legacy_total_score?: number;
  beatmap: Pick<OsuBeatmap, "id" | "beatmapset_id" | "difficulty_rating" | "mode" | "cs" | "bpm" | "max_combo" | "version" | "url" | "convert">;
  beatmapset: Pick<OsuBeatmapset, "id" | "title" | "artist" | "covers">;
  user: ScoreUser;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string;
  replay?: boolean;
  has_replay?: boolean;
  type?: string;
  companella?: CompanellaScoreMark;
}

export type ScoreLike = OscScore | LeanTrackerScore;

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

export interface ScoreHitCounts {
  max: number;
  great: number;
  good: number;
  ok: number;
  meh: number;
  miss: number;
}

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

export function calculateStableAccuracy(stats: OsuScoreStatistics): number {
  const counts = getHitCounts(stats);
  const total = counts.countMax + counts.count300 + counts.count200 + counts.count100 + counts.count50 + counts.countMiss;
  if (total === 0) return 0;
  return (counts.countMax * 300 + counts.count300 * 300 + counts.count200 * 200 + counts.count100 * 100 + counts.count50 * 50) / (total * 300);
}

export function calculateScoreV2Accuracy(stats: OsuScoreStatistics | null | undefined): number {
  const counts = getHitCounts(stats);
  const total = counts.countMax + counts.count300 + counts.count200 + counts.count100 + counts.count50 + counts.countMiss;
  if (total === 0) return 0;
  const weighted = counts.countMax * 305 + counts.count300 * 300 + counts.count200 * 200 + counts.count100 * 100 + counts.count50 * 50;
  return Math.min(1, Math.max(0, weighted / (total * 305)));
}

export function calculateManiaCustomAccuracy(stats: OsuScoreStatistics | null | undefined): number | null {
  const counts = getHitCounts(stats);
  const total = counts.countMax + counts.count300 + counts.count200 + counts.count100 + counts.count50 + counts.countMiss;
  if (total <= 0) return null;
  const weighted = counts.countMax * 320 + counts.count300 * 300 + counts.count200 * 200 + counts.count100 * 100 + counts.count50 * 50;
  return Math.min(1, Math.max(0, weighted / (total * 320)));
}

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

export function getStoredScoreAccuracy(score: ScoreLike): number | null {
  const accuracy = calculateManiaCustomAccuracy(score.statistics);
  return accuracy != null && accuracy > 0 ? accuracy : null;
}

export function getDisplayedRank(score: ScoreLike): string {
  if (!isLazerScore(score)) {
    const stableRank = deriveStableManiaRank(score);
    if (stableRank) return stableRank;
  }

  return score.passed ? score.rank : "F";
}

export function scoreHasReplay(score: ScoreLike): boolean {
  return score.has_replay ?? score.replay ?? false;
}
