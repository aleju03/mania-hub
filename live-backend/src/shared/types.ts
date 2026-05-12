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
  id: number;
  beatmapset_id: number;
  difficulty_rating: number;
  mode: string;
  status?: string;
  cs: number;
  bpm: number;
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
}

export interface OscScore {
  id: number;
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
  type?: string;
  weight?: { percentage: number; pp: number };
}

export interface LeanTrackerScore extends Required<Pick<OscScore, "id" | "user_id" | "accuracy" | "mods" | "score" | "max_combo" | "passed" | "rank" | "statistics" | "pp">> {
  legacy_score_id?: number | null;
  beatmap_id?: number;
  total_score?: number;
  classic_total_score?: number;
  legacy_total_score?: number;
  beatmap: Pick<OsuBeatmap, "id" | "beatmapset_id" | "difficulty_rating" | "mode" | "cs" | "bpm" | "max_combo" | "version" | "url">;
  beatmapset: Pick<OsuBeatmapset, "id" | "title" | "artist" | "covers">;
  user: ScoreUser;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string;
  replay?: boolean;
  has_replay?: boolean;
  type?: string;
}

export interface CountryTopPlay {
  user: { id: number; username: string; avatar_url: string };
  score: OscScore;
  pp: number;
  weightedPP: number;
  ppGain: number;
  time: string;
}

export interface SnipeEvent {
  beatmap_id: number;
  beatmapset_id: number;
  score_id: number;
  sniper: { id: number; username: string; avatar_url: string };
  victim: { id: number; username: string; avatar_url: string };
  beatmap: {
    version: string;
    difficulty_rating: number;
    cs: number;
    url: string;
  };
  beatmapset: {
    title: string;
    artist: string;
    cover_url: string;
  };
  totalScore: number;
  accuracy: number;
  mods: string[];
  pp: number | null;
  rank: string;
  isLazer: boolean;
  hasReplay: boolean;
  timestamp: string;
  victimTimestamp: string;
  detectedAt: number;
  isSeeded?: boolean;
  boardRank?: number;
  victimTotalScore?: number;
  victimPp?: number | null;
}

export interface LiveEvent<T = unknown> {
  sequence: number;
  event_id: string;
  type: string;
  country: string | null;
  payload: T;
  created_at: string;
}
