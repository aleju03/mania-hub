import type { OsuScore } from "./types";

const PP_WEIGHT_DECAY = 0.95;

export function getScoreTimestamp(score: OsuScore): string {
  return score.ended_at ?? score.created_at ?? "";
}

export function getScoreTimeMs(score: OsuScore): number {
  const timestamp = getScoreTimestamp(score);
  return timestamp ? new Date(timestamp).getTime() : 0;
}

export function getDisplayedTotalScore(score: OsuScore): number | null {
  const value =
    score.classic_total_score ??
    score.total_score ??
    score.legacy_total_score ??
    score.score;

  return value && value > 0 ? value : null;
}

export function scoreHasReplay(score: OsuScore): boolean {
  return score.has_replay ?? score.replay ?? false;
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
