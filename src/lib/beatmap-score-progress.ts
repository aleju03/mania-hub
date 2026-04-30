import { getScoreDisplayValues } from "./score";
import type { OsuScore } from "./types";

function normalizeLookupCountry(country: string): string {
  return country.trim().toUpperCase();
}

export function beatmapScoreLookupStatusKey(beatmapId: number, country: string): string {
  return `beatmap-score-lookup-status:${beatmapId}:${normalizeLookupCountry(country)}`;
}

export function beatmapScoreLookupPartialKey(beatmapId: number, country: string): string {
  return `beatmap-score-lookup-partial:v1:${beatmapId}:${normalizeLookupCountry(country)}`;
}

export function sortBeatmapScores(scores: OsuScore[]): OsuScore[] {
  return [...scores].sort((left, right) => {
    const scoreDelta = (getScoreDisplayValues(right).totalScore ?? 0) - (getScoreDisplayValues(left).totalScore ?? 0);
    if (scoreDelta !== 0) return scoreDelta;

    const ppDelta = (right.pp ?? 0) - (left.pp ?? 0);
    if (ppDelta !== 0) return ppDelta;

    return right.accuracy - left.accuracy;
  });
}
