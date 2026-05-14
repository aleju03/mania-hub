
export const MAPS_FARMED_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
export const MAPS_FAVOURITES_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
export const MAPS_DATA_CACHE_VERSION = 12;
export const USER_FAVOURITES_PAGE_SIZE = 100;
export const USER_FAVOURITES_MAX_PAGES = 10;
export const FARMED_SINGLE_PLAYER_PP_MIN = 500;
export const USER_MOST_PLAYED_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
export const USER_FAVOURITES_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
export const MAPS_FETCH_CONCURRENCY = 6;
export const RANKINGS_CACHE_TTL = 5 * 60 * 1000;
export const RANK_HISTORY_CACHE_TTL = 24 * 60 * 60 * 1000;
export const BEST_SCORES_WINDOW_CACHE_TTL = 2 * 60 * 1000;
export const COUNTRY_BEATMAP_SCORES_CACHE_TTL = 2 * 60 * 1000;
export const COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL = 10 * 60 * 1000;
export const BEATMAP_USER_SCORES_ALL_CACHE_TTL = 10 * 60 * 1000;
export const COUNTRY_BEATMAP_LOOKUP_CONCURRENCY = 15;
export const USER_PROFILE_INSIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000;
export const USER_PROFILE_INSIGHTS_CACHE_VERSION = 6;
export const HOME_PAGE_CACHE_TTL = 60 * 1000;
export const HOME_RECENT_SCORES_CACHE_TTL = 60 * 1000;
export const HOME_POPOFFS_CACHE_TTL = 10 * 60 * 1000;
export const COUNTRY_POPOFFS_CACHE_TTL = 90 * 1000;
export const COUNTRY_POPOFFS_CACHE_VERSION = 4;
export const TRACKER_RECENT_SCORES_CACHE_TTL = 45 * 1000;
export const TRACKER_RECENT_SCORES_CACHE_VERSION = 3;
export const OSC_RECENT_SCORES_CACHE_TTL = 15 * 1000;
export const OSC_RECENT_SCORES_LIMIT = 1000;
export const OSC_RECENT_SCORES_PAGES = 3;
export const OSC_FETCH_TIMEOUT_MS = 8_000;
export const OSC_BEATMAP_METADATA_CACHE_TTL = 14 * 24 * 60 * 60 * 1000;
export const OSC_BEATMAP_METADATA_CONCURRENCY = 6;
export const COUNTRY_TOP_PLAYS_REFRESH_TTL = 3 * 60 * 1000;
export const COUNTRY_TOP_PLAYS_REFRESH_LOCK_TTL = 90 * 1000;
export const COUNTRY_TOP_PLAYS_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
export const COUNTRY_TOP_PLAYS_QUERY_LIMIT = 500;
export const SCORE_PP_GAIN_REUSE_MS = 14 * 24 * 60 * 60 * 1000;
export const SCORE_PP_GAIN_CACHE_TTL = SCORE_PP_GAIN_REUSE_MS;
export const SCORE_PP_GAIN_CACHE_VERSION = 1;
export type PopoffWindow = "24h" | "3d" | "7d" | "30d";
export const POPOFF_WINDOW_MS: Record<PopoffWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
export const HOME_RECENT_SCORES_LIVE_PLAYER_COUNT = 50;
export const HOME_RECENT_SCORES_OSU_FALLBACK_PLAYER_COUNT = 10;
export const HOME_POPOFFS_PLAYER_COUNT = 10;
export const USER_CACHE_TTL = 2 * 60 * 1000;
export const USER_SCORE_LIST_CACHE_TTL = 60 * 1000;
export const RANK_HISTORY_CONCURRENCY = 20;
export const APPROX_PP_GAINS_CONCURRENCY = 4;
export const RECENT_SCORES_CONCURRENCY = 10;
export const SNIPES_CACHE_TTL = 6 * 60 * 60 * 1000;
export const SNIPES_LOCK_TTL = 5 * 60 * 1000;
export const SNIPES_LOCK_WAIT_MS = 1000;
export const SNIPES_LOCK_WAIT_RETRIES = 90;
export const SNIPES_PLAYER_LIMIT = 15;
export const SNIPES_RECENT_LIMIT = 100;
export const SNIPES_RECENT_PLAYS_CACHE_TTL = 10 * 60 * 1000;
export const SNIPES_SCAN_CONCURRENCY = 4;
export const SNIPES_PROBE_CONCURRENCY = 5;
export const SNIPES_LOG_CAP = 500;
export const SNIPES_LOG_TTL = 30 * 24 * 60 * 60 * 1000;
export const SNIPES_SNAPSHOT_TTL = 90 * 24 * 60 * 60 * 1000;
export const SNIPES_SEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SNIPES_SEED_PROBE_BUDGET = 50;
export const SNIPES_RANKED_STATUSES = new Set(["ranked", "loved", "approved"]);
export const SNIPES_STATUS_TTL = 60 * 1000;
export const SNIPES_STATUS_THROTTLE_MS = 350;
export const snipesStatusLastWriteByCountry = new Map<string, number>();
export const TOP_PLAYS_STATUS_TTL = 60 * 1000;
export const TOP_PLAYS_STATUS_THROTTLE_MS = 350;
export const topPlaysStatusLastWriteByCountry = new Map<string, number>();
export const beatmapScoreLookupLastWriteByKey = new Map<string, number>();

export const MAX_OSU_ID = 1_000_000_000;
export const MAX_OSU_SCORE_ID = Number.MAX_SAFE_INTEGER;
export const MAX_SCORE_LIMIT = 100;
export const MAX_SCORE_OFFSET = 500;
export const MAX_BEST_WINDOW_LIMIT = 200;
export const MAX_BATCH_USERS = 100;
export const MAX_HOME_USERS = 50;
export const MAX_QUERY_LENGTH = 120;
export const MAX_CURSOR_LENGTH = 512;
export const RANKING_TYPES = new Set(["performance", "score"]);
export const BEATMAP_SORTS = new Set([
  "title_asc",
  "title_desc",
  "artist_asc",
  "artist_desc",
  "difficulty_asc",
  "difficulty_desc",
  "ranked_asc",
  "ranked_desc",
  "rating_asc",
  "rating_desc",
  "plays_asc",
  "plays_desc",
  "favourites_asc",
  "favourites_desc",
  "relevance_desc",
  "updated_desc",
]);
export const BEATMAP_STATUSES = new Set([
  "any",
  "ranked",
  "qualified",
  "loved",
  "favourites",
  "pending",
  "wip",
  "graveyard",
  "mine",
]);
export const REPLAY_MODES = new Set(["osu", "taiko", "fruits", "mania"]);

export const TRACKER_LIVE_SNAPSHOT_CACHE_TTL = 90 * 1000;
export const TRACKER_LIVE_SNAPSHOT_CACHE_VERSION = 1;
export const TRACKER_SNAPSHOT_BATCH_TIMEOUT_MS = 1500;

export const USER_CACHE_VERSION = 4;
