
// Threshold used by the maps page to keep single-player farmed entries out of
// the board unless the play is actually worth pp.
export const FARMED_SINGLE_PLAYER_PP_MIN = 500;
export const RANKINGS_CACHE_TTL = 5 * 60 * 1000;
// Backend osu!-proxy stale window: how long past its TTL a cached response may
// still be served when the upstream osu! call fails. Keeps profiles and
// scoreboards readable through osu! hiccups (the old Turso-era 6h stale-profile
// retention, relocated into the proxy).
export const OSU_PROXY_STALE_MS = 6 * 60 * 60 * 1000;
export const RANK_HISTORY_CACHE_TTL = 24 * 60 * 60 * 1000;
export const BEST_SCORES_WINDOW_CACHE_TTL = 5 * 60 * 1000;
export const COUNTRY_BEATMAP_SCORES_CACHE_TTL = 2 * 60 * 1000;
export const COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL = 10 * 60 * 1000;
export const BEATMAP_USER_SCORES_ALL_CACHE_TTL = 10 * 60 * 1000;
export const COUNTRY_BEATMAP_LOOKUP_CONCURRENCY = 15;
export const USER_PROFILE_INSIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000;
export const USER_PROFILE_INSIGHTS_CACHE_VERSION = 7;
export const USER_CACHE_TTL = 5 * 60 * 1000;
export const USER_SCORE_LIST_CACHE_TTL = 5 * 60 * 1000;
export const RANK_HISTORY_CONCURRENCY = 20;
// Progress writes for the replay-browse country scoreboard scans.
export const BEATMAP_SCORE_LOOKUP_STATUS_TTL = 60 * 1000;
export const beatmapScoreLookupLastWriteByKey = new Map<string, number>();

export const MAX_OSU_ID = 1_000_000_000;
export const MAX_OSU_SCORE_ID = Number.MAX_SAFE_INTEGER;
export const MAX_SCORE_LIMIT = 100;
export const MAX_SCORE_OFFSET = 500;
export const MAX_BEST_WINDOW_LIMIT = 200;
export const MAX_BATCH_USERS = 100;
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

export const USER_CACHE_VERSION = 4;
