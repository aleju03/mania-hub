import type { OsuMod, OsuScore } from "./types";

const PP_WEIGHT_DECAY = 0.95;

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
  return score.accuracy;
}

export function getDisplayedRank(score: OsuScore): string {
  if (!score.passed) return "F";
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
