import type { OsuMod, OsuScore } from "./types";

const PP_WEIGHT_DECAY = 0.95;

function getCount(score: OsuScore, key: "perfect" | "great" | "good" | "ok" | "meh" | "miss"): number {
  const stats = score.statistics;
  switch (key) {
    case "perfect":
      return stats?.count_geki ?? stats?.perfect ?? 0;
    case "great":
      return stats?.count_300 ?? stats?.great ?? 0;
    case "good":
      return stats?.count_katu ?? stats?.good ?? 0;
    case "ok":
      return stats?.count_100 ?? stats?.ok ?? 0;
    case "meh":
      return stats?.count_50 ?? stats?.meh ?? 0;
    case "miss":
      return stats?.count_miss ?? stats?.miss ?? 0;
  }
}

function getTotalHits(score: OsuScore): number {
  return (
    getCount(score, "perfect") +
    getCount(score, "great") +
    getCount(score, "good") +
    getCount(score, "ok") +
    getCount(score, "meh") +
    getCount(score, "miss")
  );
}

function shouldRepairClassicDisplay(score: OsuScore): boolean {
  return score.type === "solo_score" && score.accuracy === 0 && getTotalHits(score) > 0;
}

function calculateManiaClassicAccuracy(score: OsuScore): number {
  const totalHits = getTotalHits(score);
  if (totalHits === 0) return 0;

  const weightedTotal =
    getCount(score, "perfect") * 6 +
    getCount(score, "great") * 6 +
    getCount(score, "good") * 4 +
    getCount(score, "ok") * 2 +
    getCount(score, "meh");

  return weightedTotal / (totalHits * 6);
}

function getClassicRankFromAccuracy(accuracy: number): string {
  if (accuracy >= 1) return "SS";
  if (accuracy >= 0.95) return "S";
  if (accuracy >= 0.9) return "A";
  if (accuracy >= 0.8) return "B";
  if (accuracy >= 0.7) return "C";
  return "D";
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
  const value =
    score.classic_total_score ||
    score.total_score ||
    score.legacy_total_score ||
    score.score;

  return value && value > 0 ? value : null;
}

export function getDisplayedAccuracy(score: OsuScore): number {
  return shouldRepairClassicDisplay(score) ? calculateManiaClassicAccuracy(score) : score.accuracy;
}

export function getDisplayedRank(score: OsuScore): string {
  if (!score.passed) return "F";
  if (shouldRepairClassicDisplay(score)) {
    return getClassicRankFromAccuracy(getDisplayedAccuracy(score));
  }
  return score.rank;
}

export function isDisplayedPassed(score: OsuScore): boolean {
  return score.passed && getDisplayedRank(score) !== "D";
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

export function calculateWeightedPpTotal(scores: Array<Pick<OsuScore, "pp">>): number {
  return scores.reduce((total, score, index) => {
    const pp = score.pp ?? 0;
    return total + pp * PP_WEIGHT_DECAY ** index;
  }, 0);
}

export function calculateApproxPpGainMap(bestScores: OsuScore[]): Record<number, number> {
  const rankedBestScores = bestScores.filter((score) => score.pp != null && score.pp > 0);
  const weightedWithAll = calculateWeightedPpTotal(rankedBestScores);
  const gains: Record<number, number> = {};

  rankedBestScores.forEach((score) => {
    const withoutScore = rankedBestScores.filter((candidate) => candidate.id !== score.id);
    const weightedWithoutScore = calculateWeightedPpTotal(withoutScore);
    const gain = weightedWithAll - weightedWithoutScore;

    if (gain > 0) {
      gains[score.id] = gain;
    }
  });

  return gains;
}
