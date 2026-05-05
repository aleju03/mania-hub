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

export interface OsuRankHighest {
  rank: number;
  updated_at: string;
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
  is_active?: boolean;
  is_online: boolean;
  is_supporter: boolean;
  statistics: OsuUserStatistics;
  rank_history: OsuRankHistory | null;
  rank_highest: OsuRankHighest | null;
  page: { html: string | null; raw: string | null } | null;
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
  tags?: string;
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

// Only the user fields the rankings and home pages actually read. The raw
// osu! API response wraps each rank row in a full `OsuUser` (page HTML,
// badges, achievements, cover URLs, rank history, full statistics, etc.),
// which is ~20 KB per row and ~1 MB per page of 50. Trimming to this shape
// server-side cuts the bulk of rankings Fast Origin Transfer.
export interface LeanRankingUser {
  id: number;
  username: string;
  avatar_url: string;
  cover_url: string;
  country_code: string;
  is_online: boolean;
  is_active?: boolean;
}

export interface LeanRankingEntry {
  user: LeanRankingUser;
  hit_accuracy: number;
  play_count: number;
  pp: number;
  global_rank: number;
  ranked_score: number;
  grade_counts: OsuGradeCounts;
}

export interface RankingsResponse {
  cursor: { page: number } | null;
  ranking: LeanRankingEntry[];
  total: number;
}

// Pre-digested score for the home page's recent-scores and popoff lists.
// The home page only needs display values, not the full osu! score shape,
// so we compute accuracy/rank/timestamps server-side and ship the minimum.
export interface LeanHomeScore {
  id: number;
  pp: number | null;
  displayAcc: number;
  displayRank: string;
  isLazer?: boolean;
  mods: Array<{ acronym: string; rate?: number }>;
  timestamp: string;
  title: string;
  version: string;
  keyCount: number;
  beatmapsetId?: number;
  user: {
    id: number;
    username: string;
    avatar_url: string;
  };
}

export interface LeanHomePopoff {
  user: { username: string; avatar_url: string };
  score: LeanHomeScore;
}

export interface BeatmapsetSearchResponse {
  beatmapsets: OsuBeatmapset[];
  cursor_string: string | null;
  total: number;
  recommended_difficulty: number | null;
}

export interface BeatmapScoresResponse {
  scores: OsuScore[];
}

export interface LeanDanEstimate {
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  family: string;
  confidence: number;
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
  mods: string[];
  pp: number;
  scoreUrl: string | null;
  playedAt: string | null;
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

export interface MapsFavouriteBeatmapset {
  id: number;
  title: string;
  artist: string;
  creator: string;
  covers: OsuCovers;
  status: string;
  globalPlayCount: number;
  globalFavouriteCount: number;
  previewUrl: string;
  maniaKeys: number[];
  maniaBeatmaps: Array<{
    id: number;
    version: string;
    difficultyRating: number;
    totalLength: number;
    cs: number;
  }>;
  starMin: number;
  starMax: number;
  bpm: number;
  patterns: string[];
}

export interface MapsPlayerFavourites {
  id: number;
  username: string;
  avatarUrl: string;
  beatmapsetIds: number[];
}

export interface CountryMapsData {
  farmed: MapsFarmedEntry[];
  mostPlayed: MapsAggregatedBeatmap[];
  favourites: MapsAggregatedFavourite[];
  favouritesByPlayer: MapsPlayerFavourites[];
  beatmapsetsPool: Record<number, MapsFavouriteBeatmapset>;
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
}

export interface UserProfileKeyBucket {
  keyCount: number;
  count: number;
}

export interface UserProfileCountStat {
  label: string;
  count: number;
  total: number;
}

export interface InsightScoreSnapshot {
  title: string;
  artist: string;
  version: string;
  pp: number | null;
  rank: string;
  coverUrl: string;
  beatmapUrl: string;
  date: string;
  mods: string[];
}

export interface UserProfileBpmKeyBucket {
  keyCount: number;
  median: number;
  count: number;
}

export interface UserProfileInsights {
  sampleSize: number;
  keySplit: UserProfileKeyBucket[];
  mostUsedMod: UserProfileCountStat | null;
  modBreakdown: UserProfileCountStat[];
  medianBpm: number | null;
  bpmRange: {
    min: number;
    max: number;
    minScore: InsightScoreSnapshot;
    maxScore: InsightScoreSnapshot;
  } | null;
  bpmByKeyMode: UserProfileBpmKeyBucket[];
  newestTopPlay: InsightScoreSnapshot | null;
  oldestTopPlay: InsightScoreSnapshot | null;
  ppRange: {
    top: number;
    bottom: number;
  } | null;
}

export interface HomePageData {
  rankings: RankingsResponse;
  recentScores: LeanHomeScore[];
  popoffs: LeanHomePopoff[];
}

// Snipes types

export interface SnipePlayer {
  id: number;
  username: string;
  avatar_url: string;
}

export interface SnipeEvent {
  beatmap_id: number;
  beatmapset_id: number;
  score_id: number;
  sniper: SnipePlayer;
  victim: SnipePlayer;
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
  /** 1-indexed country leaderboard rank the snipe happened at. Optional for
   *  backward compatibility with events emitted before this field existed. */
  boardRank?: number;
  /** Victim's totalScore at the moment they were displaced. Optional for
   *  backward compatibility with events emitted before this field existed. */
  victimTotalScore?: number;
  /** Victim's PP at the moment they were displaced. Helps surface the "sniper
   *  won on totalScore but the play itself is worse" case common in mania
   *  where totalScore (affected by combo) and PP can diverge. Optional for
   *  backward compatibility with events emitted before this field existed. */
  victimPp?: number | null;
}

export interface CountryBoardScore {
  userId: number;
  username: string;
  avatarUrl: string;
  scoreId: number;
  totalScore: number;
  accuracy: number;
  mods: string[];
  pp: number | null;
  rank: string;
  isLazer: boolean;
  hasReplay: boolean;
  endedAt: string;
  /** Max totalScore this user had in this lane on this map with endedAt
   *  strictly before the current best's endedAt. Used in the seed path to
   *  kill self-improvement false positives: if priorBestTotalScore is above
   *  the adjacent victim's current best, the "sniper" already held a rank
   *  above them before the current play — not a snipe. */
  priorBestTotalScore?: number;
}

export interface CountryBoardSnapshotEntry {
  beatmap: {
    version: string;
    difficulty_rating: number;
    cs: number;
    url: string;
  };
  beatmapset: {
    id: number;
    title: string;
    artist: string;
    cover_url: string;
  };
  scores: CountryBoardScore[]; // sorted by totalScore desc
  lastTouchedAt: number;
}

/** v3: per-beatmap snapshot is further segmented by lane key
 *  (`${speedBucket}:${client}`, e.g. "normal:lazer", "dt:stable"). Each lane
 *  is treated as an independent leaderboard for snipe-detection purposes. */
export type CountryBoardSnapshot = Record<number, Record<string, CountryBoardSnapshotEntry>>;

export interface SnipesResponse {
  events: SnipeEvent[];
  /** Epoch ms when the server produced this list (either by running a scan
   *  or serving a cached response from a prior scan). The client should use
   *  this, not receive time, for "last updated" labels. */
  scannedAt: number;
  /** True when this response was served from stale/logged data and a scan was
   *  started in the background to refresh the country snipes cache. */
  refreshInProgress?: boolean;
}

export interface SnipesScanStatus {
  phase: "roster" | "recent" | "compare" | "seed";
  label: string;
  current: number;
  total: number;
  updatedAt: number;
}

export interface CountryTopPlay {
  user: { id: number; username: string; avatar_url: string };
  score: OsuScore;
  pp: number;
  weightedPP: number;
  ppGain: number;
  time: string;
}

export interface TopPlaysResponse {
  popoffs: CountryTopPlay[];
  scannedAt: number;
  window: "24h" | "3d" | "7d" | "30d";
  refreshInProgress?: boolean;
}

export interface TopPlaysRefreshStatus {
  phase: "scores";
  label: string;
  current: number;
  total: number;
  found: number;
  updatedAt: number;
}

export interface BeatmapScoreLookupStatus {
  phase: "scores";
  label: string;
  current: number;
  total: number;
  found: number;
  updatedAt: number;
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

export interface ReplayLifeBarFrame {
  time: number;   // absolute time in ms
  health: number; // 0..1
}

export interface ParsedReplay {
  header: ReplayHeader;
  frames: ReplayFrame[];
  lifeBarFrames: ReplayLifeBarFrame[];
  keyCount: number;
}
