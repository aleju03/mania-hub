import type {
  LeanTrackerScore,
  OsuScore,
  RankingsResponse
} from "../types";
import { SCORE_PP_GAIN_CACHE_VERSION } from "./constants";

export interface BeatmapUserScoreResponse {
  error?: string | null;
  position?: number | null;
  score?: OsuScore | null;
}

export interface BeatmapUserScoresResponse {
  scores?: OsuScore[] | null;
}

export interface ScorePpGainLookup {
  beatmapId: number;
  scoreId: number;
  timestamp: string;
  userId: number;
}

export interface CachedScorePpGain {
  pp: number;
  ppGain: number;
}

export interface TrackerUserSummary {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
}

export interface OscScore {
  id: number;
  legacy_score_id?: number | null;
  user_id: number;
  accuracy: number;
  beatmap_id: number;
  build_id?: number | null;
  mods?: OsuScore["mods"];
  score?: number;
  total_score?: number;
  classic_total_score?: number;
  legacy_total_score?: number;
  max_combo: number;
  passed: boolean;
  ranked?: boolean;
  rank: string;
  statistics?: OsuScore["statistics"];
  pp?: number | null;
  ruleset_id?: number;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string;
  replay?: boolean;
  has_replay?: boolean;
  is_perfect_combo?: boolean;
  legacy_perfect?: boolean;
  processed?: boolean;
  type?: string;
}

export interface OscScoresResponse {
  success?: boolean;
  meta?: {
    count?: number;
    oldest?: number | null;
    newest?: number | null;
    mode?: string;
    users?: number[];
    maps?: number[];
  };
  scores?: OscScore[];
}

export function scorePpGainCacheKey(scoreId: number, pp: number): string {
  return `score-pp-gain:v${SCORE_PP_GAIN_CACHE_VERSION}:${scoreId}:${Math.round(pp * 100)}`;
}

export type HomePreviewPlayer = {
  id: number;
  username: string;
  avatar_url: string;
};


export interface CountryRecentScoresResponse {
  gains: Record<number, number>;
  scores: LeanTrackerScore[];
}

export interface TrackerSnapshotResponse extends CountryRecentScoresResponse {
  country: string;
  fetchedAt: number;
  rankings: RankingsResponse;
  seedBatchCount: number;
  userIds: number[];
  users: TrackerUserSummary[];
}

export interface TrackerLiveSnapshotResponse extends CountryRecentScoresResponse {
  batchIndex: number;
  country: string;
  fetchedAt: number;
  totalBatches: number;
  userIds: number[];
  users: TrackerUserSummary[];
}
