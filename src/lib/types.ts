// osu! API v2 response types - mania-focused

export interface OsuCountry {
  code: string;
  name: string;
}

export interface OsuGradeCounts {
  ss: number;
  ssh: number;
  s: number;
  sh: number;
  a: number;
}

export interface OsuUserStatistics {
  count_300: number;
  count_100: number;
  count_50: number;
  count_miss: number;
  global_rank: number | null;
  country_rank: number | null;
  pp: number;
  ranked_score: number;
  hit_accuracy: number;
  play_count: number;
  play_time: number | null;
  total_score: number;
  total_hits: number;
  maximum_combo: number;
  replays_watched_by_others: number;
  is_ranked: boolean;
  grade_counts: OsuGradeCounts;
  level: { current: number; progress: number };
}

export interface OsuRankHistory {
  mode: string;
  data: number[];
}

export interface OsuBadge {
  awarded_at: string;
  description: string;
  image_url: string;
  image_2x_url: string;
  url: string;
}

export interface OsuUser {
  id: number;
  username: string;
  avatar_url: string;
  cover_url: string;
  cover: { custom_url: string | null; url: string; id: string | null };
  country_code: string;
  country: OsuCountry;
  join_date: string;
  last_visit: string | null;
  is_online: boolean;
  is_supporter: boolean;
  statistics: OsuUserStatistics;
  rank_history: OsuRankHistory | null;
  badges: OsuBadge[];
  user_achievements: Array<{ achieved_at: string; achievement_id: number }>;
  follower_count: number;
  mapping_follower_count: number;
  previous_usernames: string[];
  playmode: string;
  playstyle: string[] | null;
  post_count: number;
  comments_count: number;
}

export interface OsuCovers {
  cover: string;
  "cover@2x": string;
  card: string;
  "card@2x": string;
  list: string;
  "list@2x": string;
  slimcover: string;
  "slimcover@2x": string;
}

export interface OsuBeatmap {
  id: number;
  beatmapset_id: number;
  difficulty_rating: number;
  mode: string;
  status: string;
  total_length: number;
  cs: number; // In mania, CS = key count
  drain: number;
  accuracy: number; // OD
  ar: number;
  bpm: number;
  convert: boolean;
  count_circles: number;
  count_sliders: number; // hold notes in mania
  count_spinners: number;
  max_combo?: number;
  version: string; // difficulty name
  url: string;
}

export interface OsuBeatmapset {
  id: number;
  title: string;
  artist: string;
  creator: string;
  user_id: number;
  covers: OsuCovers;
  status: string;
  play_count: number;
  favourite_count: number;
  submitted_date: string;
  ranked_date: string | null;
  last_updated: string;
  bpm: number;
  beatmaps?: OsuBeatmap[];
  preview_url: string;
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

export interface OsuMod {
  acronym: string;
  settings?: Record<string, string | number | boolean>;
}

export interface OsuScore {
  id: number;
  legacy_score_id?: number | null;
  user_id: number;
  accuracy: number;
  beatmap_id?: number;
  build_id?: number | null;
  mods: OsuMod[];
  score: number;
  total_score?: number;
  classic_total_score?: number;
  legacy_total_score?: number;
  max_combo: number;
  passed: boolean;
  ranked?: boolean;
  rank: string;
  statistics: OsuScoreStatistics;
  pp: number | null;
  beatmap: OsuBeatmap;
  beatmapset: OsuBeatmapset;
  user: {
    id: number;
    username: string;
    avatar_url: string;
    country_code: string;
  };
  created_at?: string;
  started_at?: string | null;
  ended_at?: string;
  replay?: boolean;
  has_replay?: boolean;
  is_perfect_combo?: boolean;
  legacy_perfect?: boolean;
  processed?: boolean;
  type?: string;
  weight?: { percentage: number; pp: number };
}

export interface RankingsResponse {
  cursor: { page: number } | null;
  ranking: Array<{
    user: OsuUser;
    hit_accuracy: number;
    play_count: number;
    pp: number;
    global_rank: number;
    ranked_score: number;
    grade_counts: OsuGradeCounts;
  }>;
  total: number;
}

export interface BeatmapsetSearchResponse {
  beatmapsets: OsuBeatmapset[];
  cursor_string: string | null;
  total: number;
  recommended_difficulty: number | null;
}

export interface UserSearchResponse {
  user: {
    data: Array<{
      id: number;
      username: string;
      avatar_url: string;
      country_code: string;
      is_online: boolean;
      statistics?: OsuUserStatistics;
    }>;
    total: number;
  };
}

// Maps aggregation types

export interface BeatmapPlaycount {
  beatmap_id: number;
  count: number;
  beatmap: {
    beatmapset_id: number;
    difficulty_rating: number;
    id: number;
    mode: string;
    status: string;
    total_length: number;
    user_id: number;
    version: string;
  };
  beatmapset: {
    id: number;
    title: string;
    artist: string;
    creator: string;
    covers: OsuCovers;
    status: string;
    play_count: number;
    favourite_count: number;
    preview_url: string;
  };
}

export interface MapsPlayerEntry {
  id: number;
  username: string;
  avatarUrl: string;
  count: number;
}

export interface MapsAggregatedBeatmap {
  beatmapId: number;
  version: string;
  difficultyRating: number;
  totalLength: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: OsuCovers;
  status: string;
  globalPlayCount: number;
  totalPlays: number;
  playerCount: number;
  players: MapsPlayerEntry[];
}

export interface MapsAggregatedFavourite {
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: OsuCovers;
  status: string;
  globalPlayCount: number;
  globalFavouriteCount: number;
  playerCount: number;
  players: Array<{ id: number; username: string; avatarUrl: string }>;
}

export interface MapsFarmedPlayer {
  id: number;
  username: string;
  avatarUrl: string;
  pp: number;
}

export interface MapsFarmedEntry {
  beatmapId: number;
  version: string;
  difficultyRating: number;
  totalLength: number;
  cs: number;
  bpm: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: OsuCovers;
  status: string;
  playerCount: number;
  players: MapsFarmedPlayer[];
  avgPp: number;
  maxPp: number;
}

export interface CountryMapsData {
  farmed: MapsFarmedEntry[];
  mostPlayed: MapsAggregatedBeatmap[];
  favourites: MapsAggregatedFavourite[];
  generatedAt: string;
}

// Replay types
export interface ReplayHeader {
  gameMode: number;
  gameVersion: number;
  beatmapHash: string;
  playerName: string;
  replayHash: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;  // mania: MAX (rainbow 300)
  countKatu: number;  // mania: 200
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  isPerfect: boolean;
  modsUsed: number;   // bitmask
  lifeBarGraph: string;
  timestamp: number;
  replayDataLength: number;
}

export interface ReplayFrame {
  time: number;     // absolute time in ms
  keyState: number; // bitmask: bit N = column N pressed
}

export interface ParsedReplay {
  header: ReplayHeader;
  frames: ReplayFrame[];
  keyCount: number;
}
