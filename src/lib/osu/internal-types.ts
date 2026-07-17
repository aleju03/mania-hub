import type { OsuScore } from "../types";

export interface BeatmapUserScoreResponse {
  error?: string | null;
  position?: number | null;
  score?: OsuScore | null;
}

export interface BeatmapUserScoresResponse {
  scores?: OsuScore[] | null;
}
