import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { requireAdminAccess } from "./auth";
import {
  beatmapScoreLookupPartialKey,
  beatmapScoreLookupStatusKey,
  sortBeatmapScores,
} from "./beatmap-score-progress";

function edgeCache(sMaxage: number, swr?: number): void {
  const effectiveSwr = swr ?? sMaxage * 4;
  setResponseHeader(
    "Cache-Control",
    `public, s-maxage=${sMaxage}, stale-while-revalidate=${effectiveSwr}`,
  );
}

function noStore(): void {
  setResponseHeader("Cache-Control", "no-store");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
import {
  osuFetch,
  osuFetchBinary,
  acquireCacheLock,
  fetchBeatmapFile,
  fetchWithCacheLock,
  fetchWithStaleAllowed,
  runCacheRebuild,
  releaseCacheLock,
  runWithCacheLockRenewal,
  deleteExpiredCacheEntriesByPrefix,
  deletePersistentCacheEntries,
  getPersistentCacheEntry,
  getPersistentCacheEntryAllowStale,
  getPersistentCacheEntries,
  getPersistentCached,
  setPersistentCache,
} from "./api";
import type { OsuFetchContextValue } from "./api";
import type { ReplayEndpointKind } from "./r2-cache";
import { db, ensureCacheSchema, hasDb } from "./db";
import { calculateApproxPpGainMap, calculateReplacementPpGain, getBoardLaneKey, getModAcronyms, getModDisplayList, getScoreDisplayValues, getScoreTimestamp, getScoreUrl, hasCustomRateMod } from "./score";
import { detectManiaPatterns } from "./mania-patterns";
import { calculateUserProfileInsights } from "./profile-insights";
import type {
  OsuUser,
  OsuScore,
  OsuBeatmap,
  OsuBeatmapset,
  OsuGradeCounts,
  RankingsResponse,
  LeanRankingEntry,
  LeanHomeScore,
  LeanHomePopoff,
  LeanTrackerScore,
  BeatmapsetSearchResponse,
  BeatmapScoresResponse,
  BeatmapScoreLookupStatus,
  UserSearchResponse,
  BeatmapPlaycount,
  CountryMapsData,
  MapsAggregatedBeatmap,
  MapsAggregatedFavourite,
  MapsFarmedEntry,
  MapsFavouriteBeatmapset,
  MapsPlayerFavourites,
  HomePageData,
  SnipeEvent,
  CountryBoardSnapshot,
  CountryBoardSnapshotEntry,
  CountryBoardScore,
  SnipesResponse,
  SnipesScanStatus,
  CountryTopPlay,
  TopPlaysRefreshStatus,
  TopPlaysResponse,
  LeanDanEstimate,
} from "./types";
import { parseManiaBeatmap } from "./beatmap-parser";
import { estimateDan } from "./dan-estimator";
import { DAN_ESTIMATE_CACHE_VERSION } from "./dan-estimator/cache-version";
import { isSupportedCountryCode, normalizeCountryCode } from "./country";

const sanitizeServerProfilePageHtml = createServerOnlyFn(
  async (html: string | null | undefined): Promise<string | null> => {
    if (!html) return null;
    const { sanitizeProfilePageHtml } = await import("./profile-page");
    return sanitizeProfilePageHtml(html);
  },
);

// Raw shape returned by the osu! API's /rankings endpoint. We never expose
// this off of the server — `getRankings` trims each user down to
// `LeanRankingEntry` before responding or caching.
interface RawRankingsResponse {
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

function toLeanRankingEntry(raw: RawRankingsResponse["ranking"][number]): LeanRankingEntry {
  return {
    user: {
      id: raw.user.id,
      username: raw.user.username,
      avatar_url: raw.user.avatar_url,
      cover_url: raw.user.cover?.url ?? raw.user.cover_url ?? "",
      country_code: raw.user.country_code,
      is_online: raw.user.is_online,
      is_active: raw.user.is_active,
    },
    hit_accuracy: raw.hit_accuracy,
    play_count: raw.play_count,
    pp: raw.pp,
    global_rank: raw.global_rank,
    ranked_score: raw.ranked_score,
    grade_counts: raw.grade_counts,
  };
}

function toLeanHomeScore(
  score: OsuScore,
  fallbackUser?: { id?: number; username?: string; avatar_url?: string },
): LeanHomeScore {
  const display = getScoreDisplayValues(score);
  const user = {
    id: score.user?.id ?? fallbackUser?.id ?? score.user_id,
    username: score.user?.username ?? fallbackUser?.username ?? "Unknown",
    avatar_url: score.user?.avatar_url ?? fallbackUser?.avatar_url ?? "",
  };
  return {
    id: score.id,
    pp: score.pp,
    displayAcc: display.accuracy,
    displayRank: display.rank,
    isLazer: display.isLazer,
    mods: getModDisplayList(score.mods),
    timestamp: getScoreTimestamp(score),
    title: score.beatmapset?.title ?? "",
    version: score.beatmap?.version ?? "",
    keyCount: Number(score.beatmap?.cs) || 0,
    beatmapsetId: score.beatmapset?.id,
    user,
  };
}

const MAPS_FARMED_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
const MAPS_FAVOURITES_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
const MAPS_DATA_CACHE_VERSION = 12;
const USER_FAVOURITES_PAGE_SIZE = 100;
const USER_FAVOURITES_MAX_PAGES = 10;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const USER_MOST_PLAYED_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const USER_FAVOURITES_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const MAPS_FETCH_CONCURRENCY = 6;
const RANKINGS_CACHE_TTL = 5 * 60 * 1000;
const RANK_HISTORY_CACHE_TTL = 24 * 60 * 60 * 1000;
const BEST_SCORES_WINDOW_CACHE_TTL = 2 * 60 * 1000;
const COUNTRY_BEATMAP_SCORES_CACHE_TTL = 2 * 60 * 1000;
const COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL = 10 * 60 * 1000;
const BEATMAP_USER_SCORES_ALL_CACHE_TTL = 10 * 60 * 1000;
const COUNTRY_BEATMAP_LOOKUP_CONCURRENCY = 15;
const USER_PROFILE_INSIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000;
const USER_PROFILE_INSIGHTS_CACHE_VERSION = 6;
const HOME_PAGE_CACHE_TTL = 60 * 1000;
const HOME_RECENT_SCORES_CACHE_TTL = 60 * 1000;
const HOME_POPOFFS_CACHE_TTL = 10 * 60 * 1000;
const COUNTRY_POPOFFS_CACHE_TTL = 90 * 1000;
const COUNTRY_POPOFFS_CACHE_VERSION = 4;
const TRACKER_RECENT_SCORES_CACHE_TTL = 45 * 1000;
const TRACKER_RECENT_SCORES_CACHE_VERSION = 3;
const OSC_RECENT_SCORES_CACHE_TTL = 15 * 1000;
const OSC_RECENT_SCORES_LIMIT = 1000;
const OSC_RECENT_SCORES_PAGES = 3;
const OSC_FETCH_TIMEOUT_MS = 8_000;
const OSC_BEATMAP_METADATA_CACHE_TTL = 14 * 24 * 60 * 60 * 1000;
const OSC_BEATMAP_METADATA_CONCURRENCY = 6;
const COUNTRY_TOP_PLAYS_REFRESH_TTL = 3 * 60 * 1000;
const COUNTRY_TOP_PLAYS_REFRESH_LOCK_TTL = 90 * 1000;
const COUNTRY_TOP_PLAYS_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const COUNTRY_TOP_PLAYS_QUERY_LIMIT = 500;
const SCORE_PP_GAIN_REUSE_MS = 14 * 24 * 60 * 60 * 1000;
const SCORE_PP_GAIN_CACHE_TTL = SCORE_PP_GAIN_REUSE_MS;
const SCORE_PP_GAIN_CACHE_VERSION = 1;
export type PopoffWindow = "24h" | "3d" | "7d" | "30d";
const POPOFF_WINDOW_MS: Record<PopoffWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
const HOME_RECENT_SCORES_LIVE_PLAYER_COUNT = 50;
const HOME_RECENT_SCORES_OSU_FALLBACK_PLAYER_COUNT = 10;
const HOME_POPOFFS_PLAYER_COUNT = 10;
const USER_CACHE_TTL = 2 * 60 * 1000;
const USER_SCORE_LIST_CACHE_TTL = 60 * 1000;
const RANK_HISTORY_CONCURRENCY = 20;
const APPROX_PP_GAINS_CONCURRENCY = 4;
const RECENT_SCORES_CONCURRENCY = 10;
const SNIPES_CACHE_TTL = 6 * 60 * 60 * 1000;
const SNIPES_LOCK_TTL = 5 * 60 * 1000;
const SNIPES_LOCK_WAIT_MS = 1000;
const SNIPES_LOCK_WAIT_RETRIES = 90;
const SNIPES_PLAYER_LIMIT = 15;
const SNIPES_RECENT_LIMIT = 100;
const SNIPES_RECENT_PLAYS_CACHE_TTL = 10 * 60 * 1000;
const SNIPES_SCAN_CONCURRENCY = 4;
const SNIPES_PROBE_CONCURRENCY = 5;
const SNIPES_LOG_CAP = 500;
const SNIPES_LOG_TTL = 30 * 24 * 60 * 60 * 1000;
const SNIPES_SNAPSHOT_TTL = 90 * 24 * 60 * 60 * 1000;
const SNIPES_SEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNIPES_SEED_PROBE_BUDGET = 50;
const SNIPES_RANKED_STATUSES = new Set(["ranked", "loved", "approved"]);
const SNIPES_STATUS_TTL = 60 * 1000;
const SNIPES_STATUS_THROTTLE_MS = 350;
const snipesStatusLastWriteByCountry = new Map<string, number>();
const TOP_PLAYS_STATUS_TTL = 60 * 1000;
const TOP_PLAYS_STATUS_THROTTLE_MS = 350;
const topPlaysStatusLastWriteByCountry = new Map<string, number>();
const beatmapScoreLookupLastWriteByKey = new Map<string, number>();

function snipesStatusKey(country: string): string {
  return `snipes-scan-status:${country}`;
}

function writeSnipesScanStatus(
  country: string,
  status: Omit<SnipesScanStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const now = Date.now();
  const last = snipesStatusLastWriteByCountry.get(country) ?? 0;
  if (!options.force && now - last < SNIPES_STATUS_THROTTLE_MS) return;
  snipesStatusLastWriteByCountry.set(country, now);
  // Fire-and-forget: status updates must not block the scan, and a failed
  // write just means the client briefly sees stale status.
  void setPersistentCache(snipesStatusKey(country), { ...status, updatedAt: now }, SNIPES_STATUS_TTL);
}

function clearSnipesScanStatus(country: string): void {
  snipesStatusLastWriteByCountry.delete(country);
  // Overwrite with a 1s-TTL marker so the client's next poll sees it gone.
  void setPersistentCache(snipesStatusKey(country), null, 1000);
}

function snipesPartialEventsKey(country: string): string {
  return `snipes-partial-events:v2:${country}`;
}

function writePartialSnipeEvents(country: string, events: SnipeEvent[]): void {
  if (events.length === 0) return;
  const sorted = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  void setPersistentCache(snipesPartialEventsKey(country), sorted, SNIPES_STATUS_TTL);
}

function clearPartialSnipeEvents(country: string): void {
  void setPersistentCache(snipesPartialEventsKey(country), null, 1000);
}

function topPlaysStatusKey(country: string): string {
  return `top-plays-refresh-status:${country}`;
}

function writeTopPlaysRefreshStatus(
  country: string,
  status: Omit<TopPlaysRefreshStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const now = Date.now();
  const last = topPlaysStatusLastWriteByCountry.get(country) ?? 0;
  if (!options.force && now - last < TOP_PLAYS_STATUS_THROTTLE_MS) return;
  topPlaysStatusLastWriteByCountry.set(country, now);
  void setPersistentCache(topPlaysStatusKey(country), { ...status, updatedAt: now }, TOP_PLAYS_STATUS_TTL);
}

function clearTopPlaysRefreshStatus(country: string): void {
  topPlaysStatusLastWriteByCountry.delete(country);
  void setPersistentCache(topPlaysStatusKey(country), null, 1000);
}

function writeBeatmapScoreLookupStatus(
  beatmapId: number,
  country: string,
  status: Omit<BeatmapScoreLookupStatus, "updatedAt">,
  options: { force?: boolean } = {},
): void {
  const key = beatmapScoreLookupStatusKey(beatmapId, country);
  const now = Date.now();
  const last = beatmapScoreLookupLastWriteByKey.get(key) ?? 0;
  if (!options.force && now - last < 350) return;
  beatmapScoreLookupLastWriteByKey.set(key, now);
  void setPersistentCache(key, { ...status, updatedAt: now }, TOP_PLAYS_STATUS_TTL);
}

function writePartialBeatmapScores(beatmapId: number, country: string, scores: OsuScore[]): void {
  void setPersistentCache(
    beatmapScoreLookupPartialKey(beatmapId, country),
    sortBeatmapScores(scores),
    TOP_PLAYS_STATUS_TTL,
  );
}

function clearBeatmapScoreLookupStatus(beatmapId: number, country: string): void {
  const key = beatmapScoreLookupStatusKey(beatmapId, country);
  beatmapScoreLookupLastWriteByKey.delete(key);
  void setPersistentCache(key, null, 1000);
}

function topPlaysPartialKey(country: string): string {
  return `top-plays-partial:v1:${country}`;
}

function writePartialTopPlays(country: string, popoffs: CountryTopPlay[]): void {
  if (popoffs.length === 0) return;
  void setPersistentCache(
    topPlaysPartialKey(country),
    sortCountryPopoffs(popoffs).slice(0, COUNTRY_TOP_PLAYS_QUERY_LIMIT),
    TOP_PLAYS_STATUS_TTL,
  );
}

function clearPartialTopPlays(country: string): void {
  void setPersistentCache(topPlaysPartialKey(country), null, 1000);
}
const userRecentPlaysPromiseCache = new Map<number, Promise<OsuScore[]>>();
const userPromiseCache = new Map<string, Promise<OsuUser>>();
const userScoresListPromiseCache = new Map<string, Promise<OsuScore[]>>();
const rankHistoryPromiseCache = new Map<number, Promise<number[] | null>>();
const bestScoresWindowPromiseCache = new Map<string, Promise<OsuScore[]>>();
const oscRecentScoresPromiseCache = new Map<string, Promise<OscScore[]>>();
const MIXED_SCORE_USER_IDS = new Set<number>([
  23341349, // happy amke sure
  25914429, // jaimito
]);

interface BeatmapUserScoreResponse {
  error?: string | null;
  position?: number | null;
  score?: OsuScore | null;
}

interface BeatmapUserScoresResponse {
  scores?: OsuScore[] | null;
}

interface ScorePpGainLookup {
  beatmapId: number;
  scoreId: number;
  timestamp: string;
  userId: number;
}

interface CachedScorePpGain {
  pp: number;
  ppGain: number;
}

interface TrackerUserSummary {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
}

interface OscScore {
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

interface OscScoresResponse {
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

function scorePpGainCacheKey(scoreId: number, pp: number): string {
  return `score-pp-gain:v${SCORE_PP_GAIN_CACHE_VERSION}:${scoreId}:${Math.round(pp * 100)}`;
}

const MAX_OSU_ID = 1_000_000_000;
const MAX_OSU_SCORE_ID = Number.MAX_SAFE_INTEGER;
const MAX_SCORE_LIMIT = 100;
const MAX_SCORE_OFFSET = 500;
const MAX_BEST_WINDOW_LIMIT = 200;
const MAX_BATCH_USERS = 100;
const MAX_HOME_USERS = 50;
const MAX_QUERY_LENGTH = 120;
const MAX_CURSOR_LENGTH = 512;
const RANKING_TYPES = new Set(["performance", "score"]);
const BEATMAP_SORTS = new Set([
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
const BEATMAP_STATUSES = new Set([
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
const REPLAY_MODES = new Set(["osu", "taiko", "fruits", "mania"]);

function asInputRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

function parseBoundedInt(
  value: unknown,
  label: string,
  options: { min: number; max: number; fallback?: number },
): number {
  if (value == null || value === "") {
    if (options.fallback != null) return options.fallback;
    throw new Error(`Missing ${label}.`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < options.min || n > options.max) {
    throw new Error(`Invalid ${label}.`);
  }
  return n;
}

function parseOptionalBoundedInt(
  value: unknown,
  label: string,
  options: { min: number; max: number },
): number | undefined {
  if (value == null || value === "") return undefined;
  return parseBoundedInt(value, label, options);
}

function parseOsuId(value: unknown, label: string): number {
  return parseBoundedInt(value, label, { min: 1, max: MAX_OSU_ID });
}

function parseOsuScoreId(value: unknown, label: string): number {
  return parseBoundedInt(value, label, { min: 1, max: MAX_OSU_SCORE_ID });
}

function parseString(value: unknown, label: string, maxLength: number, fallback?: string): string {
  if (value == null) {
    if (fallback != null) return fallback;
    throw new Error(`Missing ${label}.`);
  }
  const text = String(value).trim();
  if (!text || text.length > maxLength) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

function parseOptionalCountry(value: unknown): string | undefined {
  if (value == null || String(value).trim() === "") return undefined;
  const country = String(value).trim().toUpperCase();
  if (!isSupportedCountryCode(country)) {
    throw new Error("Invalid country.");
  }
  return country;
}

function parsePopoffWindow(value: unknown): PopoffWindow {
  if (value == null || value === "") return "30d";
  if (value === "24h" || value === "3d" || value === "7d" || value === "30d") return value;
  throw new Error("Invalid popoff window.");
}

function parseUserIds(value: unknown, max = MAX_BATCH_USERS): number[] {
  if (!Array.isArray(value)) throw new Error("Invalid userIds payload.");
  if (value.length > max) throw new Error(`User list is limited to ${max} users.`);
  return [...new Set(value.map((id) => parseOsuId(id, "user id")))];
}

function parseHomePlayers(value: unknown, max = MAX_HOME_USERS): HomePreviewPlayer[] {
  if (!Array.isArray(value)) throw new Error("Invalid players payload.");
  if (value.length > max) throw new Error(`Player list is limited to ${max} users.`);

  const seen = new Set<number>();
  const players: HomePreviewPlayer[] = [];
  for (const raw of value) {
    const input = asInputRecord(raw);
    const id = parseOsuId(input.id, "player id");
    if (seen.has(id)) continue;
    seen.add(id);
    players.push({
      id,
      username: parseString(input.username, "username", 64, "Unknown"),
      avatar_url: String(input.avatar_url ?? "").slice(0, 512),
    });
  }
  return players;
}

function parseTrackerUsers(value: unknown, max = MAX_BATCH_USERS): TrackerUserSummary[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid users payload.");
  if (value.length > max) throw new Error(`User list is limited to ${max} users.`);

  const seen = new Set<number>();
  const users: TrackerUserSummary[] = [];
  for (const raw of value) {
    const input = asInputRecord(raw);
    const id = parseOsuId(input.id, "user id");
    if (seen.has(id)) continue;
    seen.add(id);
    users.push({
      id,
      username: parseString(input.username, "username", 64, "Unknown"),
      avatar_url: String(input.avatar_url ?? "").slice(0, 512),
      country_code: String(input.country_code ?? "").trim().toUpperCase().slice(0, 2),
    });
  }
  return users;
}

function normalizeUserKeyPayload(data: unknown): { key: string } {
  const input = asInputRecord(data);
  return { key: parseString(input.key, "user key", 64) };
}

function normalizeUserIdPayload(data: unknown): { userId: number } {
  const input = asInputRecord(data);
  return { userId: parseOsuId(input.userId, "user id") };
}

function normalizeScoreListPayload(data: unknown): {
  userId: number;
  limit?: number;
  offset?: number;
  include_fails?: boolean;
} {
  const input = asInputRecord(data);
  return {
    userId: parseOsuId(input.userId, "user id"),
    limit: parseOptionalBoundedInt(input.limit, "limit", { min: 1, max: MAX_SCORE_LIMIT }),
    offset: parseOptionalBoundedInt(input.offset, "offset", { min: 0, max: MAX_SCORE_OFFSET }),
    include_fails: input.include_fails === true,
  };
}

function normalizeBestWindowPayload(data: unknown): { userId: number; totalLimit?: number } {
  const input = asInputRecord(data);
  return {
    userId: parseOsuId(input.userId, "user id"),
    totalLimit: parseBoundedInt(input.totalLimit, "totalLimit", {
      min: 1,
      max: MAX_BEST_WINDOW_LIMIT,
      fallback: 200,
    }),
  };
}

function normalizeRankingsPayload(data: unknown): { type?: string; page?: number; country?: string } {
  const input = asInputRecord(data);
  const type = input.type == null || input.type === "" ? "performance" : String(input.type);
  if (!RANKING_TYPES.has(type)) throw new Error("Invalid ranking type.");
  return {
    type,
    page: parseBoundedInt(input.page, "page", { min: 1, max: 200, fallback: 1 }),
    country: parseOptionalCountry(input.country),
  };
}

function normalizeCountryPayload(data: unknown): { country?: string } {
  const input = asInputRecord(data);
  return { country: parseOptionalCountry(input.country) };
}

function normalizeHomeRecentScoresPayload(data: unknown): { userIds: number[] } {
  const input = asInputRecord(data);
  return { userIds: parseUserIds(input.userIds, MAX_HOME_USERS) };
}

function normalizeHomePopoffsPayload(data: unknown): { players: HomePreviewPlayer[] } {
  const input = asInputRecord(data);
  return { players: parseHomePlayers(input.players, MAX_HOME_USERS) };
}

function normalizeCountryPopoffsPayload(data: unknown): {
  country?: string;
  players: HomePreviewPlayer[];
  window?: PopoffWindow;
  refresh?: boolean;
} {
  const input = asInputRecord(data);
  return {
    country: parseOptionalCountry(input.country),
    players: parseHomePlayers(input.players, MAX_BATCH_USERS),
    window: parsePopoffWindow(input.window),
    refresh: input.refresh !== false,
  };
}

function normalizeRankHistoryPayload(data: unknown): { userIds: number[] } {
  const input = asInputRecord(data);
  return { userIds: parseUserIds(input.userIds, MAX_BATCH_USERS) };
}

function normalizeBeatmapSearchPayload(data: unknown): {
  query?: string;
  sort?: string;
  cursor_string?: string;
  status?: string;
} {
  const input = asInputRecord(data);
  const sort = input.sort == null || input.sort === "" ? "ranked_desc" : String(input.sort);
  const status = input.status == null || input.status === "" ? undefined : String(input.status);
  if (!BEATMAP_SORTS.has(sort)) throw new Error("Invalid beatmap sort.");
  if (status && !BEATMAP_STATUSES.has(status)) throw new Error("Invalid beatmap status.");
  return {
    query: input.query == null ? undefined : String(input.query).trim().slice(0, MAX_QUERY_LENGTH),
    sort,
    cursor_string: input.cursor_string == null
      ? undefined
      : String(input.cursor_string).slice(0, MAX_CURSOR_LENGTH),
    status,
  };
}

function normalizeMapperSearchPayload(data: unknown): { usernames?: string[] } {
  const input = asInputRecord(data);
  const usernames = Array.isArray(input.usernames)
    ? input.usernames.map((username) => String(username).trim()).filter(Boolean).slice(0, 3)
    : [];
  return { usernames };
}

function normalizeBeatmapsetPayload(data: unknown): { beatmapsetId: number } {
  const input = asInputRecord(data);
  return { beatmapsetId: parseOsuId(input.beatmapsetId, "beatmapset id") };
}

function normalizeBeatmapPayload(data: unknown): { beatmapId: number } {
  const input = asInputRecord(data);
  return { beatmapId: parseOsuId(input.beatmapId, "beatmap id") };
}

function normalizeBeatmapScoresPayload(data: unknown): { beatmapId: number; country?: string; page: number } {
  const input = asInputRecord(data);
  const page = parseBoundedInt(input.page, "page", { min: 1, max: 2, fallback: 1 });
  return {
    beatmapId: parseOsuId(input.beatmapId, "beatmap id"),
    country: parseOptionalCountry(input.country),
    page,
  };
}

function normalizeSearchUsersPayload(data: unknown): { query: string } {
  const input = asInputRecord(data);
  return { query: parseString(input.query, "query", 64) };
}

function normalizeCountryRecentScoresPayload(data: unknown): {
  userIds: number[];
  users: TrackerUserSummary[];
  batchSize?: number;
  batchIndex?: number;
  recentLimit?: number;
  source?: "backfill" | "live";
} {
  const input = asInputRecord(data);
  const source = input.source == null || input.source === "" ? undefined : String(input.source);
  if (source != null && source !== "backfill" && source !== "live") {
    throw new Error("Invalid tracker score source.");
  }
  return {
    userIds: parseUserIds(input.userIds, MAX_BATCH_USERS),
    users: parseTrackerUsers(input.users, MAX_BATCH_USERS),
    batchSize: parseBoundedInt(input.batchSize, "batchSize", { min: 1, max: 50, fallback: 5 }),
    batchIndex: parseBoundedInt(input.batchIndex, "batchIndex", { min: 0, max: 500, fallback: 0 }),
    recentLimit: parseBoundedInt(input.recentLimit, "recentLimit", { min: 1, max: 100, fallback: 20 }),
    source: source as "backfill" | "live" | undefined,
  };
}

function normalizeReplayParsedPayload(data: unknown): { scoreId: number; mode: string; keyCount?: number } {
  const input = asInputRecord(data);
  const mode = String(input.mode ?? "mania");
  if (!REPLAY_MODES.has(mode)) throw new Error("Invalid replay mode.");
  const keyCount = input.keyCount == null || input.keyCount === ""
    ? undefined
    : parseBoundedInt(input.keyCount, "keyCount", { min: 1, max: 18 });
  return {
    scoreId: parseOsuScoreId(input.scoreId, "score id"),
    mode,
    keyCount,
  };
}

function normalizeScorePayload(data: unknown): { scoreId: number; mode?: string } {
  const input = asInputRecord(data);
  const mode = input.mode == null || input.mode === "" ? "mania" : String(input.mode);
  if (!REPLAY_MODES.has(mode)) throw new Error("Invalid score mode.");
  return { scoreId: parseOsuScoreId(input.scoreId, "score id"), mode };
}

async function assertDevMutationAllowed(action: string): Promise<void> {
  await requireAdminAccess(action);
}

interface CountryRecentScoresResponse {
  gains: Record<number, number>;
  scores: LeanTrackerScore[];
}

interface TrackerSnapshotResponse extends CountryRecentScoresResponse {
  country: string;
  fetchedAt: number;
  rankings: RankingsResponse;
  seedBatchCount: number;
  userIds: number[];
  users: TrackerUserSummary[];
}

interface TrackerLiveSnapshotResponse extends CountryRecentScoresResponse {
  batchIndex: number;
  country: string;
  fetchedAt: number;
  totalBatches: number;
  userIds: number[];
  users: TrackerUserSummary[];
}

const TRACKER_LIVE_SNAPSHOT_CACHE_TTL = 90 * 1000;
const TRACKER_LIVE_SNAPSHOT_CACHE_VERSION = 1;
const TRACKER_SNAPSHOT_BATCH_TIMEOUT_MS = 1500;

async function withTrackerSnapshotBatchBudget(
  feedPromise: Promise<CountryRecentScoresResponse>,
): Promise<CountryRecentScoresResponse | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), TRACKER_SNAPSHOT_BATCH_TIMEOUT_MS);
  });
  return Promise.race([
    feedPromise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

function getScoreRequestParams(
  userId: number,
  params: Record<string, string | number | undefined>,
): Record<string, string | number | undefined> {
  return {
    ...params,
    legacy_only: MIXED_SCORE_USER_IDS.has(userId) ? undefined : 1,
  };
}

const USER_CACHE_VERSION = 4;

function getUserCacheKey(key: string): string {
  return `user:v${USER_CACHE_VERSION}:${key.trim().toLowerCase()}`;
}

function getUserScoreListCacheKey(
  type: "best" | "recent" | "firsts" | "pinned",
  userId: number,
  params: { limit: number; offset: number; includeFails?: boolean },
): string {
  return [
    "user-score-list",
    type,
    userId,
    params.limit,
    params.offset,
    params.includeFails ? 1 : 0,
  ].join(":");
}

export async function getCachedUser(key: string): Promise<OsuUser> {
  const cacheKey = getUserCacheKey(key);
  const cached = await getPersistentCached<OsuUser>(cacheKey);
  if (cached) return cached;

  const pending = userPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, USER_CACHE_TTL, async () => {
    const user = await osuFetch<OsuUser>(`/users/${encodeURIComponent(key)}/mania`, undefined, {
      caller: "getUser",
    });
    if (user.page) {
      user.page.html = await sanitizeServerProfilePageHtml(user.page.html);
    }
    void Promise.allSettled([
      setPersistentCache(getUserCacheKey(user.username), user, USER_CACHE_TTL),
      setPersistentCache(`user-id:v${USER_CACHE_VERSION}:${user.id}`, user, USER_CACHE_TTL),
    ]);
    return user;
  }).finally(() => {
    userPromiseCache.delete(cacheKey);
  });

  userPromiseCache.set(cacheKey, request);
  return request;
}

export async function getCachedUserScores(
  type: "best" | "recent" | "firsts" | "pinned",
  userId: number,
  options: { limit: number; offset: number; includeFails?: boolean },
): Promise<OsuScore[]> {
  const cacheKey = getUserScoreListCacheKey(type, userId, options);
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = userScoresListPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, USER_SCORE_LIST_CACHE_TTL, () =>
    osuFetch<OsuScore[]>(
      `/users/${userId}/scores/${type}`,
      getScoreRequestParams(userId, {
        mode: "mania",
        limit: options.limit,
        offset: options.offset,
        include_fails: type === "recent" && options.includeFails ? 1 : 0,
      }),
      {
        caller: `getUserScores:${type}`,
        context: {
          source: "user-score-list",
          userId,
          limit: options.limit,
          offset: options.offset,
          includeFails: type === "recent" && !!options.includeFails,
        },
      },
    ),
  ).finally(() => {
    userScoresListPromiseCache.delete(cacheKey);
  });

  userScoresListPromiseCache.set(cacheKey, request);
  return request;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

async function getUserRankHistory(userId: number): Promise<number[] | null> {
  const cacheKey = `rank-history:user:${userId}`;
  const cached = await getPersistentCacheEntry<number[] | null>(cacheKey);
  if (cached.hit) return cached.value;

  const pending = rankHistoryPromiseCache.get(userId);
  if (pending) return pending;

  const request = osuFetch<OsuUser>(`/users/${userId}/mania`, undefined, {
    caller: "getUserRankHistory",
  })
    .then((user) => {
      const history = user.rank_history?.data ?? null;
      void setPersistentCache(cacheKey, history, RANK_HISTORY_CACHE_TTL);
      return history;
    })
    .finally(() => {
      rankHistoryPromiseCache.delete(userId);
    });

  rankHistoryPromiseCache.set(userId, request);
  return request;
}

// ── User ────────────────────────────────────────────────────────────────────

export const getUser = createServerFn({ method: "GET" })
  .inputValidator(normalizeUserKeyPayload)
  .handler(async ({ data }: { data: { key: string } }) => {
    edgeCache(60, 300);
    return getCachedUser(data.key);
  });

export const getUserScoresBest = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(120, 600);
    return getCachedUserScores("best", data.userId, {
      limit: data.limit ?? 20,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresRecent = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number; include_fails?: boolean } }) => {
    edgeCache(30, 120);
    return getCachedUserScores("recent", data.userId, {
      limit: data.limit ?? 10,
      offset: data.offset ?? 0,
      includeFails: data.include_fails,
    });
  });

export const getUserScoresFirsts = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(300, 1800);
    return getCachedUserScores("firsts", data.userId, {
      limit: data.limit ?? 100,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresPinned = createServerFn({ method: "GET" })
  .inputValidator(normalizeScoreListPayload)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    edgeCache(600, 3600);
    return getCachedUserScores("pinned", data.userId, {
      limit: data.limit ?? 50,
      offset: data.offset ?? 0,
    });
  });

function getTimestampMs(score: OsuScore): number {
  const timestamp = getScoreTimestamp(score);
  return timestamp ? new Date(timestamp).getTime() : 0;
}

async function fetchUserBestScoresWindow(
  userId: number,
  totalLimit = 200,
  context?: Record<string, OsuFetchContextValue>,
): Promise<OsuScore[]> {
  const cacheKey = `user-best-scores-window:${userId}:${totalLimit}`;
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = bestScoresWindowPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, BEST_SCORES_WINDOW_CACHE_TTL, async () => {
    const firstPage = await osuFetch<OsuScore[]>(
      `/users/${userId}/scores/best`,
      getScoreRequestParams(userId, {
        mode: "mania",
        limit: Math.min(totalLimit, 100),
        offset: 0,
      }),
      {
        caller: "fetchUserBestScoresWindow:p1",
        context: {
          source: "best-scores-window",
          userId,
          totalLimit,
          page: 1,
          ...context,
        },
      },
    );

    let scores = firstPage;

    if (totalLimit > 100 && firstPage.length >= 100) {
      const secondPage = await osuFetch<OsuScore[]>(
        `/users/${userId}/scores/best`,
        getScoreRequestParams(userId, {
          mode: "mania",
          limit: Math.min(totalLimit - 100, 100),
          offset: 100,
        }),
        {
          caller: "fetchUserBestScoresWindow:p2",
          context: {
            source: "best-scores-window",
            userId,
            totalLimit,
            page: 2,
            ...context,
          },
        },
      );
      scores = [...firstPage, ...secondPage];
    }

    return scores;
  }).finally(() => {
    bestScoresWindowPromiseCache.delete(cacheKey);
  });

  bestScoresWindowPromiseCache.set(cacheKey, request);
  return request;
}

async function getBeatmapUserScoresAll(
  beatmapId: number,
  userId: number,
  context?: Record<string, OsuFetchContextValue>,
): Promise<OsuScore[]> {
  const cacheKey = `beatmap-user-scores-all:v2:${beatmapId}:${userId}`;
  return fetchWithCacheLock(cacheKey, BEATMAP_USER_SCORES_ALL_CACHE_TTL, async () => {
    const response = await osuFetch<BeatmapUserScoresResponse>(
      `/beatmaps/${beatmapId}/scores/users/${userId}/all`,
      { ruleset: "mania" },
      {
        caller: "getBeatmapUserScoresAll",
        context: {
          source: "beatmap-user-scores-all",
          beatmapId,
          userId,
          ...context,
        },
      },
    );
    return response.scores ?? [];
  });
}

export const getUserBeatmapScores = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    const input = asInputRecord(data);
    const beatmapId = Number(input.beatmapId);
    const userId = Number(input.userId);
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) throw new Error("Invalid beatmap ID.");
    if (!Number.isFinite(userId) || userId <= 0) throw new Error("Invalid user ID.");
    return { beatmapId, userId };
  })
  .handler(async ({ data }: { data: { beatmapId: number; userId: number } }) => {
    edgeCache(60, 300);
    return getBeatmapUserScoresAll(data.beatmapId, data.userId, {
      feature: "user-beatmap-scores",
      source: "getUserBeatmapScores",
    });
  });

function getPreviousBeatmapBestScore(scores: OsuScore[], target: ScorePpGainLookup): OsuScore | null {
  const targetTimestampMs = new Date(target.timestamp).getTime();
  if (!Number.isFinite(targetTimestampMs) || targetTimestampMs <= 0) return null;

  const olderScores = scores
    .filter((score) => score.id !== target.scoreId)
    .filter((score) => {
      const timestampMs = getTimestampMs(score);
      return Number.isFinite(timestampMs) && timestampMs > 0 && timestampMs < targetTimestampMs;
    })
    .filter((score) => score.pp != null && score.pp > 0);

  if (olderScores.length === 0) return null;

  olderScores.sort((a, b) => {
    const ppDiff = (b.pp ?? 0) - (a.pp ?? 0);
    if (ppDiff !== 0) return ppDiff;
    return getTimestampMs(b) - getTimestampMs(a);
  });

  return olderScores[0];
}

async function calculateReplacementPpGainMapForTargets(
  bestScores: OsuScore[],
  targets: ScorePpGainLookup[],
): Promise<Record<number, number>> {
  if (targets.length === 0) return {};

  const bestScoreById = new Map(
    bestScores
      .filter((score) => score.id > 0 && score.pp != null && score.pp > 0)
      .map((score) => [score.id, score]),
  );
  const fallbackGainMap = calculateApproxPpGainMap(bestScores);
  const relevantTargets = targets.filter((target) => bestScoreById.has(target.scoreId));
  if (relevantTargets.length === 0) return {};

  const cacheKeyByScoreId = new Map<number, string>();
  for (const target of relevantTargets) {
    const currentScore = bestScoreById.get(target.scoreId);
    if (!currentScore?.pp) continue;
    cacheKeyByScoreId.set(target.scoreId, scorePpGainCacheKey(target.scoreId, currentScore.pp));
  }

  const cachedGains = await getPersistentCacheEntries<CachedScorePpGain>(
    [...new Set(cacheKeyByScoreId.values())],
  );
  const gains: Record<number, number> = {};
  const uncachedTargets: ScorePpGainLookup[] = [];

  for (const target of relevantTargets) {
    const currentScore = bestScoreById.get(target.scoreId);
    const cacheKey = cacheKeyByScoreId.get(target.scoreId);
    const cached = cacheKey ? cachedGains.get(cacheKey) : undefined;
    if (
      currentScore?.pp &&
      cached &&
      Number.isFinite(cached.pp) &&
      Number.isFinite(cached.ppGain) &&
      Math.abs(cached.pp - currentScore.pp) < 0.01
    ) {
      if (cached.ppGain > 0) gains[target.scoreId] = cached.ppGain;
      continue;
    }

    uncachedTargets.push(target);
  }

  if (uncachedTargets.length === 0) return gains;

  const previousScores = await mapWithConcurrency(
    uncachedTargets,
    APPROX_PP_GAINS_CONCURRENCY,
    async (target) => {
      try {
        const history = await getBeatmapUserScoresAll(target.beatmapId, target.userId, {
          feature: "pp-gain-fallback",
          batchSize: uncachedTargets.length,
          concurrency: APPROX_PP_GAINS_CONCURRENCY,
          scoreId: target.scoreId,
        });
        return getPreviousBeatmapBestScore(history, target);
      } catch (error) {
        console.warn("[osu] failed to fetch beatmap score history for pp gain fallback", {
          beatmapId: target.beatmapId,
          scoreId: target.scoreId,
          timestamp: target.timestamp,
          userId: target.userId,
          error: getErrorMessage(error),
        });
        return undefined;
      }
    },
  );

  uncachedTargets.forEach((target, index) => {
    const currentScore = bestScoreById.get(target.scoreId);
    if (!currentScore) return;

    const previousScore = previousScores[index];
    if (previousScore === undefined) {
      const fallbackGain = fallbackGainMap[target.scoreId];
      if (fallbackGain > 0) gains[target.scoreId] = fallbackGain;
      return;
    }

    const gain = calculateReplacementPpGain(bestScores, target.scoreId, previousScore ?? null);
    const cacheKey = cacheKeyByScoreId.get(target.scoreId);
    if (cacheKey && currentScore.pp != null) {
      void setPersistentCache(
        cacheKey,
        { pp: currentScore.pp, ppGain: gain } satisfies CachedScorePpGain,
        SCORE_PP_GAIN_CACHE_TTL,
      );
    }
    if (gain > 0) gains[target.scoreId] = gain;
  });

  return gains;
}

export const getUserScoresBestWindow = createServerFn({ method: "GET" })
  .inputValidator(normalizeBestWindowPayload)
  .handler(async ({ data }: { data: { userId: number; totalLimit?: number } }) => {
    edgeCache(120, 600);
    return fetchUserBestScoresWindow(data.userId, data.totalLimit ?? 200, {
      feature: "user-best-window",
      source: "getUserScoresBestWindow",
    });
  });

export const getUserProfileInsights = createServerFn({ method: "GET" })
  .inputValidator(normalizeUserIdPayload)
  .handler(async ({ data }: { data: { userId: number } }) => {
    edgeCache(1800, 21600);
    const cacheKey = `user-profile-insights:v${USER_PROFILE_INSIGHTS_CACHE_VERSION}:${data.userId}`;
    return fetchWithCacheLock(cacheKey, USER_PROFILE_INSIGHTS_CACHE_TTL, async () =>
      calculateUserProfileInsights(await fetchUserBestScoresWindow(data.userId, 200, {
        feature: "profile-insights",
      })),
    );
  });

// ── Rankings ────────────────────────────────────────────────────────────────

export const getRankings = createServerFn({ method: "GET" })
  .inputValidator(normalizeRankingsPayload)
  .handler(async ({ data }: { data: { type?: string; page?: number; country?: string } }): Promise<RankingsResponse> => {
    edgeCache(60, 300);
    const type = data.type ?? "performance";
    return fetchRankingsPage(type, data.page ?? 1, data.country);
  });

async function fetchRankingsPage(type: string, page: number, country?: string): Promise<RankingsResponse> {
  // v4: lean ranking users read cover_url from user.cover.url for replay
  // suggestion banners. Bumped so broken v3 entries with undefined banners
  // are refetched.
  const cacheKey = `rankings:v4:${type}:${page}:${country ?? ""}`;
  return fetchWithCacheLock(cacheKey, RANKINGS_CACHE_TTL, async () => {
    const raw = await osuFetch<RawRankingsResponse>(
      `/rankings/mania/${type}`,
      {
        "cursor[page]": page,
        country,
      },
      { caller: "getRankings" },
    );
    return {
      cursor: raw.cursor,
      ranking: raw.ranking.map(toLeanRankingEntry),
      total: raw.total,
    };
  });
}

function getOscBaseUrl(): string | null {
  if (process.env.OSC_TRACKER_ENABLED === "0" || process.env.OSC_TRACKER_DISABLED === "1") {
    return null;
  }
  const baseUrl = (process.env.OSC_BASE_URL ?? "https://osc.kaysting.dev").trim().replace(/\/+$/, "");
  return baseUrl || null;
}

async function fetchPublicJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function getOscScoreTimeMs(score: OscScore): number {
  const timestamp = score.ended_at ?? score.created_at ?? "";
  return timestamp ? new Date(timestamp).getTime() : 0;
}

async function fetchOscRecentScoresPage(before?: number | null): Promise<OscScoresResponse> {
  const baseUrl = getOscBaseUrl();
  if (!baseUrl) throw new Error("oSC tracker feed is disabled.");

  const params = new URLSearchParams({
    limit: String(OSC_RECENT_SCORES_LIMIT),
    mode: "mania",
  });
  if (before != null) params.set("before", String(before));
  return fetchPublicJsonWithTimeout<OscScoresResponse>(
    `${baseUrl}/api/scores?${params.toString()}`,
    OSC_FETCH_TIMEOUT_MS,
  );
}

async function fetchOscRecentScores(): Promise<OscScore[]> {
  const cacheKey = `osc-recent-scores:mania:v1:${OSC_RECENT_SCORES_LIMIT}:${OSC_RECENT_SCORES_PAGES}`;
  const pending = oscRecentScoresPromiseCache.get(cacheKey);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, OSC_RECENT_SCORES_CACHE_TTL, async () => {
    const scores: OscScore[] = [];
    const seen = new Set<number>();
    let before: number | null | undefined;

    for (let page = 0; page < OSC_RECENT_SCORES_PAGES; page++) {
      const response = await fetchOscRecentScoresPage(before);
      if (response.success === false) {
        throw new Error("oSC returned an unsuccessful response.");
      }
      const pageScores = response.scores ?? [];
      for (const score of pageScores) {
        if (!score || (score.ruleset_id != null && score.ruleset_id !== 3)) continue;
        if (!Number.isFinite(score.id) || seen.has(score.id)) continue;
        seen.add(score.id);
        scores.push(score);
      }

      const older = response.meta?.oldest;
      if (!older || pageScores.length === 0) break;
      before = older;
    }

    return scores.sort((a, b) => {
      const timeDelta = getOscScoreTimeMs(b) - getOscScoreTimeMs(a);
      return timeDelta !== 0 ? timeDelta : b.id - a.id;
    });
  }).finally(() => {
    oscRecentScoresPromiseCache.delete(cacheKey);
  });

  oscRecentScoresPromiseCache.set(cacheKey, request);
  return request;
}

async function getCachedBeatmapMetadataForTracker(
  beatmapId: number,
): Promise<{ beatmap: OsuBeatmap; beatmapset: OsuBeatmapset } | null> {
  const cacheKey = `tracker-beatmap-metadata:v1:${beatmapId}`;
  return fetchWithCacheLock(cacheKey, OSC_BEATMAP_METADATA_CACHE_TTL, async () => {
    const beatmap = await osuFetch<OsuBeatmap>(
      `/beatmaps/${beatmapId}`,
      undefined,
      { caller: "trackerBeatmapMetadata:beatmap" },
    );
    const beatmapset = await osuFetch<OsuBeatmapset>(
      `/beatmapsets/${beatmap.beatmapset_id}`,
      undefined,
      { caller: "trackerBeatmapMetadata:beatmapset" },
    );
    return { beatmap, beatmapset };
  }).catch((error) => {
    console.warn("[osu] failed to hydrate oSC beatmap metadata", {
      beatmapId,
      error: getErrorMessage(error),
    });
    return null;
  });
}

async function getTrackerUserSummary(
  userId: number,
  usersById: ReadonlyMap<number, TrackerUserSummary>,
): Promise<TrackerUserSummary | null> {
  const known = usersById.get(userId);
  if (known) return known;

  try {
    const user = await getCachedUser(String(userId));
    return {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      country_code: user.country_code,
    };
  } catch {
    return null;
  }
}

function scoreNumberFromOsc(score: OscScore): number {
  return score.score
    ?? score.legacy_total_score
    ?? score.classic_total_score
    ?? score.total_score
    ?? 0;
}

function hydrateOscScore(
  score: OscScore,
  user: TrackerUserSummary,
  metadata: { beatmap: OsuBeatmap; beatmapset: OsuBeatmapset },
): OsuScore {
  return {
    id: score.id,
    legacy_score_id: score.legacy_score_id,
    user_id: score.user_id,
    accuracy: score.accuracy,
    beatmap_id: score.beatmap_id,
    build_id: score.build_id,
    mods: score.mods ?? [],
    score: scoreNumberFromOsc(score),
    total_score: score.total_score,
    classic_total_score: score.classic_total_score,
    legacy_total_score: score.legacy_total_score,
    max_combo: score.max_combo,
    passed: score.passed,
    ranked: score.ranked,
    rank: score.rank,
    statistics: score.statistics ?? {},
    pp: score.pp ?? null,
    beatmap: metadata.beatmap,
    beatmapset: metadata.beatmapset,
    user,
    created_at: score.created_at,
    started_at: score.started_at,
    ended_at: score.ended_at,
    replay: score.replay,
    has_replay: score.has_replay,
    is_perfect_combo: score.is_perfect_combo,
    legacy_perfect: score.legacy_perfect,
    processed: score.processed,
    type: score.type,
  };
}

async function fetchOscCountryRecentScores(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number; users?: TrackerUserSummary[] },
): Promise<OsuScore[] | null> {
  if (!getOscBaseUrl()) return null;

  const batch = getCountryRecentScoresBatchUserIds(userIds, options);
  if (batch.length === 0) return [];

  const batchUserIds = new Set(batch);
  const usersById = new Map((options?.users ?? []).map((user) => [user.id, user]));
  const maxScores = Math.max(1, batch.length * (options?.recentLimit ?? 20));
  const rawScores = await fetchOscRecentScores();
  const matched = rawScores
    .filter((score) => batchUserIds.has(score.user_id))
    .filter((score) => Number.isFinite(score.beatmap_id) && score.beatmap_id > 0)
    .slice(0, maxScores);

  if (matched.length === 0) return [];

  const uniqueBeatmapIds = [...new Set(matched.map((score) => score.beatmap_id))];
  const metadataEntries = await mapWithConcurrency(
    uniqueBeatmapIds,
    OSC_BEATMAP_METADATA_CONCURRENCY,
    async (beatmapId) => [beatmapId, await getCachedBeatmapMetadataForTracker(beatmapId)] as const,
  );
  const metadataByBeatmapId = new Map(metadataEntries.filter((entry): entry is readonly [number, {
    beatmap: OsuBeatmap;
    beatmapset: OsuBeatmapset;
  }] => entry[1] !== null));

  const userEntries = await mapWithConcurrency(
    [...new Set(matched.map((score) => score.user_id))],
    OSC_BEATMAP_METADATA_CONCURRENCY,
    async (userId) => [userId, await getTrackerUserSummary(userId, usersById)] as const,
  );
  const hydratedUsersById = new Map(userEntries.filter((entry): entry is readonly [number, TrackerUserSummary] => entry[1] !== null));

  const scores: OsuScore[] = [];
  for (const score of matched) {
    const user = hydratedUsersById.get(score.user_id);
    const metadata = metadataByBeatmapId.get(score.beatmap_id);
    if (!user || !metadata) continue;
    scores.push(hydrateOscScore(score, user, metadata));
  }

  if (scores.length === 0) return null;
  return scores;
}

async function fetchCountryRecentScores(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number },
): Promise<OsuScore[]> {
  const batch = getCountryRecentScoresBatchUserIds(userIds, options);
  const recentLimit = options?.recentLimit ?? 20;

  const results = await mapWithConcurrency(
    batch,
    RECENT_SCORES_CONCURRENCY,
    async (uid: number) => {
      try {
        return await getCachedUserScores("recent", uid, {
          limit: recentLimit,
          offset: 0,
          includeFails: true,
        });
      } catch {
        return [];
      }
    },
  );

  return results.flatMap((scores) => scores);
}

function getCountryRecentScoresBatchUserIds(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number },
): number[] {
  if (userIds.length === 0) return [];
  const size = options?.batchSize ?? 5;
  const start = ((options?.batchIndex ?? 0) * size) % userIds.length;
  return userIds.slice(start, start + size);
}

function getTrackerRecentScoresCacheKey(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number; source?: "backfill" | "live" },
): string {
  const batchUserIds = getCountryRecentScoresBatchUserIds(userIds, options);
  return [
    `tracker-recent-scores:v${TRACKER_RECENT_SCORES_CACHE_VERSION}`,
    options?.source ?? "live",
    options?.recentLimit ?? 20,
    batchUserIds.join(","),
  ].join(":");
}

function toTrackerUserSummaries(rankings: RankingsResponse): TrackerUserSummary[] {
  return rankings.ranking
    .filter((entry) => entry.user.is_active !== false)
    .map((entry) => ({
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
      country_code: entry.user.country_code,
    }));
}

function getTrackerScoreKey(score: LeanTrackerScore): string {
  return score.id > 0
    ? String(score.id)
    : `${score.user_id}:${score.beatmap_id ?? ""}:${score.created_at ?? ""}:${score.ended_at ?? ""}`;
}

function getLeanTrackerScoreTimeMs(score: LeanTrackerScore): number {
  return new Date(score.ended_at ?? score.created_at ?? score.started_at ?? "").getTime() || 0;
}

async function fetchTrackerRecentScoresCached(
  userIds: number[],
  options: {
    batchIndex?: number;
    batchSize?: number;
    recentLimit?: number;
    source?: "backfill" | "live";
    users?: TrackerUserSummary[];
  },
): Promise<CountryRecentScoresResponse> {
  const cacheKey = getTrackerRecentScoresCacheKey(userIds, options);
  return fetchWithCacheLock(cacheKey, TRACKER_RECENT_SCORES_CACHE_TTL, () =>
    fetchCountryRecentScoresWithGains(userIds, options),
  );
}

function toLeanTrackerScore(score: OsuScore): LeanTrackerScore {
  return {
    id: score.id,
    legacy_score_id: score.legacy_score_id,
    user_id: score.user_id,
    accuracy: score.accuracy,
    beatmap_id: score.beatmap_id ?? score.beatmap?.id,
    mods: score.mods,
    score: score.score,
    total_score: score.total_score,
    classic_total_score: score.classic_total_score,
    legacy_total_score: score.legacy_total_score,
    max_combo: score.max_combo,
    passed: score.passed,
    rank: score.rank,
    statistics: score.statistics,
    pp: score.pp,
    beatmap: {
      id: score.beatmap.id,
      beatmapset_id: score.beatmap.beatmapset_id,
      difficulty_rating: score.beatmap.difficulty_rating,
      mode: score.beatmap.mode,
      cs: score.beatmap.cs,
      bpm: score.beatmap.bpm,
      max_combo: score.beatmap.max_combo,
      version: score.beatmap.version,
      url: score.beatmap.url,
    },
    beatmapset: {
      id: score.beatmapset.id,
      title: score.beatmapset.title,
      artist: score.beatmapset.artist,
      covers: score.beatmapset.covers,
    },
    user: {
      id: score.user.id,
      username: score.user.username,
      avatar_url: score.user.avatar_url,
      country_code: score.user.country_code,
    },
    created_at: score.created_at,
    started_at: score.started_at,
    ended_at: score.ended_at,
    replay: score.replay,
    has_replay: score.has_replay,
    type: score.type,
  };
}

async function fetchCountryRecentScoresWithGains(
  userIds: number[],
  options?: { batchSize?: number; batchIndex?: number; recentLimit?: number; users?: TrackerUserSummary[]; source?: "backfill" | "live" },
): Promise<CountryRecentScoresResponse> {
  let scores: OsuScore[];
  if (options?.source === "backfill") {
    scores = await fetchCountryRecentScores(userIds, options);
  } else {
    try {
      scores = await fetchOscCountryRecentScores(userIds, options) ?? await fetchCountryRecentScores(userIds, options);
    } catch (error) {
      console.warn("[osu] oSC tracker feed failed; falling back to osu! recent scores", {
        error: getErrorMessage(error),
      });
      scores = await fetchCountryRecentScores(userIds, options);
    }
  }
  const rankedTargets = Array.from(
    new Map(
      scores
        .filter((score) => score.id > 0 && score.pp != null && score.pp > 0)
        .map((score) => [
          score.id,
          {
            beatmapId: score.beatmap_id ?? score.beatmap?.id ?? 0,
            scoreId: score.id,
            timestamp: getScoreTimestamp(score),
            userId: score.user_id,
          } satisfies ScorePpGainLookup,
        ]),
    ).values(),
  );

  if (rankedTargets.length === 0) {
    return { scores: scores.map(toLeanTrackerScore), gains: {} };
  }

  const targetsByUserId = new Map<number, ScorePpGainLookup[]>();
  rankedTargets.forEach((target) => {
    const list = targetsByUserId.get(target.userId);
    if (list) list.push(target);
    else targetsByUserId.set(target.userId, [target]);
  });

  const groupedTargets = [...targetsByUserId.entries()];
  const groupedGains = await mapWithConcurrency(
    groupedTargets,
    APPROX_PP_GAINS_CONCURRENCY,
    async ([userId, targets]) => {
      try {
        const bestScores = await fetchUserBestScoresWindow(userId, 200, {
          feature: "tracker-pp-gains",
          groupedUsers: groupedTargets.length,
          targetCount: targets.length,
          concurrency: APPROX_PP_GAINS_CONCURRENCY,
        });
        return await calculateReplacementPpGainMapForTargets(bestScores, targets);
      } catch {
        return {} as Record<number, number>;
      }
    },
  );

  const gains: Record<number, number> = {};
  groupedGains.forEach((group) => Object.assign(gains, group));
  return { scores: scores.map(toLeanTrackerScore), gains };
}

function buildRecentScoresPreview(scores: OsuScore[], limit = 5): OsuScore[] {
  const seenUsers = new Set<number>();

  return scores
    .filter((score) => score.passed)
    .sort((a, b) => getTimestampMs(b) - getTimestampMs(a))
    .filter((score) => {
      if (seenUsers.has(score.user_id)) return false;
      seenUsers.add(score.user_id);
      return true;
    })
    .slice(0, limit);
}

async function buildHomeRecentScoresPreview(userIds: number[]): Promise<LeanHomeScore[]> {
  const liveUserIds = userIds.slice(0, HOME_RECENT_SCORES_LIVE_PLAYER_COUNT);
  if (liveUserIds.length === 0) return [];
  const fallbackUserIds = liveUserIds.slice(0, HOME_RECENT_SCORES_OSU_FALLBACK_PLAYER_COUNT);
  // Keep the response lean while merging the public live tracker feed for the
  // first rankings page with a small osu! recent-score fallback.
  const cacheKey = `home-recent-scores:v6:${liveUserIds.join(",")}`;

  return fetchWithCacheLock(cacheKey, HOME_RECENT_SCORES_CACHE_TTL, async () => {
    const [liveResult, fallbackResult] = await Promise.allSettled([
      fetchOscCountryRecentScores(liveUserIds, {
        batchSize: liveUserIds.length,
        batchIndex: 0,
        recentLimit: 20,
      }),
      fetchCountryRecentScores(fallbackUserIds, {
        batchSize: fallbackUserIds.length,
        batchIndex: 0,
        recentLimit: 20,
      }),
    ]);
    const liveScores = liveResult.status === "fulfilled" ? liveResult.value ?? [] : [];
    const fallbackScores = fallbackResult.status === "fulfilled" ? fallbackResult.value : [];
    const scores = [...liveScores, ...fallbackScores];
    return buildRecentScoresPreview(scores, 5).map((score) => toLeanHomeScore(score));
  });
}

type HomePreviewPlayer = {
  id: number;
  username: string;
  avatar_url: string;
};

type CountryPopoff = CountryTopPlay;

async function buildHomePopoffs(players: HomePreviewPlayer[]): Promise<LeanHomePopoff[]> {
  const topPlayersForPopoffs = players.slice(0, HOME_POPOFFS_PLAYER_COUNT);
  if (topPlayersForPopoffs.length === 0) return [];
  // v2: response is now LeanHomePopoff[] (pre-digested display values).
  const cacheKey = `home-popoffs:v2:${topPlayersForPopoffs.map((player) => player.id).join(",")}`;

  return fetchWithCacheLock(cacheKey, HOME_POPOFFS_CACHE_TTL, async () => {
    type FatPopoff = { user: HomePreviewPlayer; score: OsuScore };
    const results = await mapWithConcurrency(
      topPlayersForPopoffs,
      APPROX_PP_GAINS_CONCURRENCY,
      async (player): Promise<FatPopoff[]> => {
        try {
          const scores = await fetchUserBestScoresWindow(player.id, 100, {
            feature: "home-popoffs",
            playerCount: topPlayersForPopoffs.length,
            concurrency: APPROX_PP_GAINS_CONCURRENCY,
          });
          return scores
            .filter((score) => {
              const age = Date.now() - getTimestampMs(score);
              return age < 7 * 24 * 60 * 60 * 1000 && score.pp != null && score.pp > 0;
            })
            .map((score) => ({ user: player, score }));
        } catch {
          return [];
        }
      },
    );

    const sorted = results
      .flatMap((entries) => entries)
      .sort((a, b) => {
        const ppDiff = (b.score.pp ?? 0) - (a.score.pp ?? 0);
        if (ppDiff !== 0) return ppDiff;
        return getTimestampMs(b.score) - getTimestampMs(a.score);
      });

    const picked: FatPopoff[] = [];
    const seenUsers = new Set<string>();
    for (const entry of sorted) {
      if (picked.length >= 5) break;
      if (!seenUsers.has(entry.user.username)) {
        seenUsers.add(entry.user.username);
        picked.push(entry);
      }
    }
    if (picked.length < 5) {
      for (const entry of sorted) {
        if (picked.length >= 5) break;
        if (!picked.includes(entry)) picked.push(entry);
      }
    }

    return picked.map(({ user, score }) => ({
      user: { username: user.username, avatar_url: user.avatar_url },
      score: toLeanHomeScore(score, user),
    }));
  });
}

function filterPopoffsForWindow(popoffs: CountryPopoff[], window: PopoffWindow): CountryPopoff[] {
  const windowMs = POPOFF_WINDOW_MS[window];
  const cutoff = Date.now() - windowMs;
  return popoffs.filter((popoff) => {
    const scoreTime = new Date(popoff.time).getTime();
    return Number.isFinite(scoreTime) && scoreTime >= cutoff;
  });
}

function sortCountryPopoffs(popoffs: CountryPopoff[]): CountryPopoff[] {
  return [...popoffs].sort((a, b) => {
    if (b.pp !== a.pp) return b.pp - a.pp;
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });
}

async function buildCountryPopoffsForPlayer(
  player: HomePreviewPlayer,
  windowMs: number,
  options: { knownPpGainsByScoreId?: ReadonlyMap<number, CachedScorePpGain> } = {},
): Promise<CountryPopoff[]> {
  const scores = await fetchUserBestScoresWindow(player.id, 100, {
    feature: "home-profile-preview",
  });
  const relevantScores = scores.filter((score) => {
    const age = Date.now() - getTimestampMs(score);
    return age < windowMs && score.pp != null && score.pp > 0;
  });
  const cachedGainMap: Record<number, number> = {};
  const uncachedTargets: ScorePpGainLookup[] = [];

  relevantScores.forEach((score) => {
    const scoreId = score.id;
    const known = options.knownPpGainsByScoreId?.get(scoreId);
    const currentPp = score.pp ?? 0;
    if (
      scoreId > 0 &&
      known &&
      Number.isFinite(known.pp) &&
      Number.isFinite(known.ppGain) &&
      Math.abs(known.pp - currentPp) < 0.01
    ) {
      cachedGainMap[scoreId] = Math.max(0, known.ppGain);
      return;
    }

    uncachedTargets.push({
      beatmapId: score.beatmap_id ?? score.beatmap?.id ?? 0,
      scoreId,
      timestamp: getScoreTimestamp(score),
      userId: player.id,
    });
  });

  const gainMap = await calculateReplacementPpGainMapForTargets(
    scores,
    uncachedTargets,
  );
  const mergedGainMap = { ...cachedGainMap, ...gainMap };

  return relevantScores
    .map((score) => ({
      user: player,
      score,
      pp: score.pp ?? 0,
      weightedPP: score.weight?.pp ?? 0,
      ppGain: mergedGainMap[score.id] ?? 0,
      time: getScoreTimestamp(score),
    }));
}

async function buildLiveCountryPopoffs(
  players: HomePreviewPlayer[],
  window: PopoffWindow,
  options: {
    progressCountry?: string;
    knownPpGainsByScoreId?: ReadonlyMap<number, CachedScorePpGain>;
  } = {},
): Promise<CountryPopoff[]> {
  const topPlayers = players.slice(0, 30);
  if (topPlayers.length === 0) return [];

  const windowMs = POPOFF_WINDOW_MS[window];
  const cacheKey = `country-popoffs:v${COUNTRY_POPOFFS_CACHE_VERSION}:${window}:${topPlayers.map((player) => player.id).join(",")}`;

  return fetchWithCacheLock(cacheKey, COUNTRY_POPOFFS_CACHE_TTL, async () => {
    let completed = 0;
    const partialPopoffs: CountryPopoff[] = [];
    const progressCountry = options.progressCountry;
    if (progressCountry) {
      clearPartialTopPlays(progressCountry);
      writeTopPlaysRefreshStatus(
        progressCountry,
        {
          phase: "scores",
          label: "Checking players' best scores",
          current: 0,
          total: topPlayers.length,
          found: 0,
        },
        { force: true },
      );
    }

    const results = await mapWithConcurrency(
      topPlayers,
      APPROX_PP_GAINS_CONCURRENCY,
      async (player) => {
        let playerPopoffs: CountryPopoff[] = [];
        try {
          playerPopoffs = await buildCountryPopoffsForPlayer(player, windowMs, {
            knownPpGainsByScoreId: options.knownPpGainsByScoreId,
          });
          return playerPopoffs;
        } catch (error) {
          console.warn("[osu] failed to build country popoff scores for player", {
            playerId: player.id,
            username: player.username,
            error: getErrorMessage(error),
          });
          return [] as CountryPopoff[];
        } finally {
          completed += 1;
          partialPopoffs.push(...playerPopoffs);
          const latest = sortCountryPopoffs(partialPopoffs);
          if (progressCountry) {
            writeTopPlaysRefreshStatus(progressCountry, {
              phase: "scores",
              label: "Checking players' best scores",
              current: completed,
              total: topPlayers.length,
              found: latest.length,
            });
            writePartialTopPlays(progressCountry, latest);
          }
        }
      },
    );

    return sortCountryPopoffs(results.flatMap((scores) => scores));
  });
}

async function getStoredCountryTopPlays(country: string, window: PopoffWindow): Promise<CountryPopoff[]> {
  if (!hasDb() || !db) return [];

  try {
    await ensureCacheSchema();

    const result = await db.execute({
      sql: `
        SELECT user_id, username, avatar_url, score_json, pp, weighted_pp, pp_gain, score_time
        FROM country_top_plays INDEXED BY idx_country_top_plays_country_pp_time
        WHERE country = ?
          AND score_time >= ?
        ORDER BY pp DESC, score_time DESC
        LIMIT ?
      `,
      args: [
        normalizeCountryCode(country),
        Date.now() - POPOFF_WINDOW_MS[window],
        COUNTRY_TOP_PLAYS_QUERY_LIMIT,
      ],
    });

    const popoffs: CountryPopoff[] = [];
    for (const row of result.rows) {
      try {
        popoffs.push({
          user: {
            id: Number(row.user_id),
            username: String(row.username),
            avatar_url: String(row.avatar_url),
          },
          score: JSON.parse(String(row.score_json)) as OsuScore,
          pp: Number(row.pp),
          weightedPP: Number(row.weighted_pp),
          ppGain: Number(row.pp_gain),
          time: new Date(Number(row.score_time)).toISOString(),
        });
      } catch (error) {
        console.warn("[osu] failed to parse stored country top play", {
          country,
          error: getErrorMessage(error),
        });
      }
    }

    return sortCountryPopoffs(popoffs);
  } catch (error) {
    console.warn("[osu] failed to read stored country top plays", {
      country,
      error: getErrorMessage(error),
    });
    return [];
  }
}

async function upsertStoredCountryTopPlays(country: string, popoffs: CountryPopoff[]): Promise<void> {
  if (!hasDb() || !db) return;

  const normalizedCountry = normalizeCountryCode(country);
  const now = Date.now();
  const cutoff = now - COUNTRY_TOP_PLAYS_RETENTION_MS;

  try {
    await ensureCacheSchema();

    const statements = popoffs
      .filter((popoff) => popoff.score.id > 0)
      .map((popoff) => {
        const scoreTime = new Date(popoff.time).getTime();
        return {
          sql: `
            INSERT INTO country_top_plays (
              country, score_id, user_id, username, avatar_url, score_json,
              pp, weighted_pp, pp_gain, score_time, discovered_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(country, score_id) DO UPDATE SET
              user_id = excluded.user_id,
              username = excluded.username,
              avatar_url = excluded.avatar_url,
              score_json = excluded.score_json,
              pp = excluded.pp,
              weighted_pp = excluded.weighted_pp,
              pp_gain = excluded.pp_gain,
              score_time = excluded.score_time,
              updated_at = excluded.updated_at
          `,
          args: [
            normalizedCountry,
            popoff.score.id,
            popoff.user.id,
            popoff.user.username,
            popoff.user.avatar_url,
            JSON.stringify(popoff.score),
            popoff.pp,
            popoff.weightedPP,
            popoff.ppGain,
            Number.isFinite(scoreTime) ? scoreTime : now,
            now,
            now,
          ],
        };
      });

    if (statements.length > 0) {
      await db.batch(statements);
    }

    await db.execute({
      sql: "DELETE FROM country_top_plays WHERE country = ? AND score_time < ?",
      args: [normalizedCountry, cutoff],
    });
  } catch (error) {
    console.warn("[osu] failed to write stored country top plays", {
      country,
      error: getErrorMessage(error),
    });
  }
}

async function refreshStoredCountryTopPlays(country: string, players: HomePreviewPlayer[]): Promise<number> {
  const knownPpGainsByScoreId = new Map<number, CachedScorePpGain>();
  const reuseCutoff = Date.now() - SCORE_PP_GAIN_REUSE_MS;
  const stored = await getStoredCountryTopPlays(country, "30d");
  for (const popoff of stored) {
    const scoreId = popoff.score.id;
    const scoreTime = new Date(popoff.time).getTime();
    if (scoreId <= 0) continue;
    if (!Number.isFinite(scoreTime) || scoreTime < reuseCutoff) continue;
    if (!Number.isFinite(popoff.pp) || !Number.isFinite(popoff.ppGain)) continue;
    knownPpGainsByScoreId.set(scoreId, {
      pp: popoff.pp,
      ppGain: popoff.ppGain,
    });
  }

  const refreshed = await buildLiveCountryPopoffs(players, "30d", {
    progressCountry: country,
    knownPpGainsByScoreId,
  });
  await upsertStoredCountryTopPlays(country, refreshed);
  return Date.now();
}

async function refreshStoredCountryTopPlaysWithLock(country: string, players: HomePreviewPlayer[]): Promise<boolean> {
  const normalizedCountry = normalizeCountryCode(country);
  const cacheKey = `country-top-plays-refresh:v1:${normalizedCountry}`;
  let ranRefresh = false;
  await fetchWithCacheLock(
    cacheKey,
    COUNTRY_TOP_PLAYS_REFRESH_TTL,
    () => {
      ranRefresh = true;
      return refreshStoredCountryTopPlays(normalizedCountry, players);
    },
    COUNTRY_TOP_PLAYS_REFRESH_LOCK_TTL,
  );
  return ranRefresh;
}

const topPlaysBackgroundRefreshInProgress = new Set<string>();

function refreshStoredCountryTopPlaysInBackground(country: string, players: HomePreviewPlayer[]): boolean {
  const normalizedCountry = normalizeCountryCode(country);
  if (topPlaysBackgroundRefreshInProgress.has(normalizedCountry)) return true;
  topPlaysBackgroundRefreshInProgress.add(normalizedCountry);
  void refreshStoredCountryTopPlaysWithLock(normalizedCountry, players)
    .then((ranRefresh) => {
      if (!ranRefresh) return;
      clearTopPlaysRefreshStatus(normalizedCountry);
      clearPartialTopPlays(normalizedCountry);
    })
    .catch((error) => {
      console.warn("[osu] failed to refresh stored country top plays in background", {
        country: normalizedCountry,
        error: getErrorMessage(error),
      });
    })
    .finally(() => {
      topPlaysBackgroundRefreshInProgress.delete(normalizedCountry);
    });
  return true;
}

async function buildCountryPopoffs(
  country: string | undefined,
  players: HomePreviewPlayer[],
  window: PopoffWindow,
  refresh: boolean,
): Promise<TopPlaysResponse> {
  if (!country || !hasDb()) {
    const popoffs = await buildLiveCountryPopoffs(
      players,
      window,
      country ? { progressCountry: normalizeCountryCode(country) } : {},
    );
    return { popoffs, scannedAt: Date.now(), window };
  }

  const normalizedCountry = normalizeCountryCode(country);
  const stored = await getStoredCountryTopPlays(normalizedCountry, window);
  if (stored.length > 0) {
    const refreshInProgress = refresh && refreshStoredCountryTopPlaysInBackground(normalizedCountry, players);
    return {
      popoffs: stored,
      scannedAt: Date.now(),
      window,
      refreshInProgress,
    };
  }

  let live: CountryPopoff[] = [];
  try {
    live = await buildLiveCountryPopoffs(players, window, { progressCountry: normalizedCountry });
  } finally {
    clearTopPlaysRefreshStatus(normalizedCountry);
    clearPartialTopPlays(normalizedCountry);
  }
  await upsertStoredCountryTopPlays(normalizedCountry, live);

  if (window !== "30d") {
    refreshStoredCountryTopPlaysInBackground(normalizedCountry, players);
  }

  const selectedWindow = sortCountryPopoffs(filterPopoffsForWindow(live, window));
  if (selectedWindow.length > 0 || window !== "30d") {
    return {
      popoffs: selectedWindow,
      scannedAt: Date.now(),
      window,
      refreshInProgress: window !== "30d",
    };
  }

  try {
    await refreshStoredCountryTopPlaysWithLock(normalizedCountry, players);
    clearTopPlaysRefreshStatus(normalizedCountry);
    clearPartialTopPlays(normalizedCountry);
  } catch (error) {
    console.warn("[osu] failed to warm stored country top plays", {
      country: normalizedCountry,
      error: getErrorMessage(error),
    });
    return { popoffs: selectedWindow, scannedAt: Date.now(), window };
  }

  const refreshed = await getStoredCountryTopPlays(normalizedCountry, window);
  if (refreshed.length > 0) {
    return { popoffs: refreshed, scannedAt: Date.now(), window };
  }
  return { popoffs: selectedWindow, scannedAt: Date.now(), window };
}

export const getHomePageData = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<HomePageData> => {
    edgeCache(30, 300);
    const country = data?.country ?? "CR";
    // v2: rankings and scores are now lean shapes.
    const cacheKey = `home-page-data:v2:${country}`;
    return fetchWithCacheLock(cacheKey, HOME_PAGE_CACHE_TTL, async () => {
      const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
      const activeRankings = rankings.ranking.filter((entry) => entry.user.is_active !== false);
      const userIds = activeRankings.map((entry) => entry.user.id);
      const players = activeRankings.map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
      }));

      const [recentScores, popoffs] = await Promise.all([
        buildHomeRecentScoresPreview(userIds),
        buildHomePopoffs(players),
      ]);

      return { rankings, recentScores, popoffs } satisfies HomePageData;
    }, 30_000);
  });

export const getHomeRecentScores = createServerFn({ method: "GET" })
  .inputValidator(normalizeHomeRecentScoresPayload)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    edgeCache(60, 300);
    return buildHomeRecentScoresPreview(data.userIds);
  });

export const getHomePopoffs = createServerFn({ method: "GET" })
  .inputValidator(normalizeHomePopoffsPayload)
  .handler(async ({ data }: { data: { players: HomePreviewPlayer[] } }) => {
    edgeCache(300, 1800);
    return buildHomePopoffs(data.players);
  });

export const getCountryPopoffs = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPopoffsPayload)
  .handler(async ({ data }: { data: { country?: string; players: HomePreviewPlayer[]; window?: PopoffWindow; refresh?: boolean } }) => {
    noStore();
    return buildCountryPopoffs(data.country, data.players, data.window ?? "30d", data.refresh !== false);
  });

export const getTopPlaysRefreshStatus = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<TopPlaysRefreshStatus | null> => {
    noStore();
    const country = normalizeCountryCode(data?.country ?? "CR");
    return (await getPersistentCached<TopPlaysRefreshStatus>(topPlaysStatusKey(country))) ?? null;
  });

export const getPartialTopPlays = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data?: { country?: string } }): Promise<CountryTopPlay[]> => {
    noStore();
    const country = normalizeCountryCode(data?.country ?? "CR");
    return (await getPersistentCached<CountryTopPlay[]>(topPlaysPartialKey(country))) ?? [];
  });

// ── Batch user rank history ────────────────────────────────────────────────

export const getUsersRankHistory = createServerFn({ method: "GET" })
  .inputValidator(normalizeRankHistoryPayload)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    edgeCache(3600, 86400);
    const uniqueUserIds = [...new Set(data.userIds)];

    const results = await mapWithConcurrency(
      uniqueUserIds,
      RANK_HISTORY_CONCURRENCY,
      async (userId) => {
        try {
          const history = await getUserRankHistory(userId);
          return { userId, history };
        } catch {
          return { userId, history: null };
        }
      },
    );

    const out: Record<number, number[]> = {};

    results.forEach(({ userId, history }) => {
      if (history?.length) {
        out[userId] = history;
      }
    });

    return out;
  });

// ── Beatmaps ────────────────────────────────────────────────────────────────

export const searchBeatmaps = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapSearchPayload)
  .handler(async ({ data }: { data: { query?: string; sort?: string; cursor_string?: string; status?: string } }) => {
    edgeCache(300, 3600);
    return osuFetch<BeatmapsetSearchResponse>(
      "/beatmapsets/search",
      {
        m: 3, // mania
        q: data.query,
        sort: data.sort ?? "ranked_desc",
        cursor_string: data.cursor_string,
        s: data.status,
      },
      { caller: "searchBeatmaps" },
    );
  });

export const searchBeatmapsByMappers = createServerFn({ method: "GET" })
  .inputValidator(normalizeMapperSearchPayload)
  .handler(async ({ data }: { data: { usernames?: string[] } }) => {
    edgeCache(300, 3600);

    const usernames = [...new Set((data.usernames ?? [])
      .map((username) => username.trim())
      .filter((username) => /^[\w[\]-]{3,24}$/.test(username)))]
      .slice(0, 3);
    const beatmapsetTypes = ["loved", "ranked", "pending", "graveyard"] as const;
    const beatmapsetsById = new Map<number, OsuBeatmapset>();

    for (const username of usernames) {
      try {
        const user = await osuFetch<OsuUser>(
          `/users/${encodeURIComponent(username)}/mania`,
          undefined,
          { caller: "searchBeatmapsByMappers:user" },
        );

        for (const type of beatmapsetTypes) {
          try {
            const beatmapsets = await osuFetch<OsuBeatmapset[]>(
              `/users/${user.id}/beatmapsets/${type}`,
              { limit: 50, offset: 0 },
              { caller: "searchBeatmapsByMappers:beatmapsets" },
            );
            for (const beatmapset of beatmapsets) {
              if ((beatmapset.beatmaps ?? []).some((beatmap) => beatmap.mode === "mania")) {
                beatmapsetsById.set(beatmapset.id, beatmapset);
              }
            }
          } catch {
            // Some users simply have no sets in a category.
          }
        }
      } catch {
        // Treat non-user tokens from broad searches as misses.
      }
    }

    return { beatmapsets: [...beatmapsetsById.values()] };
  });

export const getBeatmapset = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapsetPayload)
  .handler(async ({ data }: { data: { beatmapsetId: number } }) => {
    edgeCache(300, 3600);
    return osuFetch<OsuBeatmapset>(
      `/beatmapsets/${data.beatmapsetId}`,
      undefined,
      { caller: "getBeatmapset" },
    );
  });

export const getBeatmapsetForBeatmap = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapPayload)
  .handler(async ({ data }: { data: { beatmapId: number } }) => {
    edgeCache(300, 3600);
    const beatmap = await osuFetch<OsuBeatmap>(
      `/beatmaps/${data.beatmapId}`,
      undefined,
      { caller: "getBeatmapsetForBeatmap" },
    );
    return osuFetch<OsuBeatmapset>(
      `/beatmapsets/${beatmap.beatmapset_id}`,
      undefined,
      { caller: "getBeatmapsetForBeatmap:beatmapset" },
    );
  });

async function getBeatmapUserScore(beatmapId: number, userId: number): Promise<OsuScore | null> {
  const cacheKey = `beatmap-user-score:${beatmapId}:${userId}`;
  return fetchWithCacheLock(cacheKey, COUNTRY_BEATMAP_USER_SCORE_CACHE_TTL, async () => {
    const response = await osuFetch<BeatmapUserScoreResponse>(
      `/beatmaps/${beatmapId}/scores/users/${userId}`,
      { mode: "mania" },
      { caller: "getBeatmapUserScore" },
    );
    return response.score ?? null;
  });
}

async function getCountryBeatmapScores(beatmapId: number, country: string, page: number): Promise<OsuScore[]> {
  const normalizedCountry = country.trim().toUpperCase();
  const safePage = Math.max(1, Math.min(2, Math.round(page)));
  const cacheKey = `country-beatmap-scores:${beatmapId}:${normalizedCountry}:page:${safePage}`;

  return fetchWithCacheLock(cacheKey, COUNTRY_BEATMAP_SCORES_CACHE_TTL, async () => {
    writeBeatmapScoreLookupStatus(beatmapId, normalizedCountry, {
      phase: "scores",
      label: "Loading country players",
      current: 0,
      total: 0,
      found: 0,
    }, { force: true });
    writePartialBeatmapScores(beatmapId, normalizedCountry, []);

    try {
      const rankingPage = await getRankings({ data: { type: "performance", page: safePage, country: normalizedCountry } });
      const rankedUsers = rankingPage.ranking;
      const userIds = Array.from(new Set(rankedUsers.map((entry) => entry.user.id)));
      const partialScores: OsuScore[] = [];
      let checked = 0;

      writeBeatmapScoreLookupStatus(beatmapId, normalizedCountry, {
        phase: "scores",
        label: "Checking player scores",
        current: checked,
        total: userIds.length,
        found: partialScores.length,
      }, { force: true });

      await mapWithConcurrency(
        userIds,
        COUNTRY_BEATMAP_LOOKUP_CONCURRENCY,
        async (userId) => {
          const score = await getBeatmapUserScore(beatmapId, userId).catch(() => null);
          checked += 1;

          if (score?.user?.country_code === normalizedCountry) {
            partialScores.push(score);
            writePartialBeatmapScores(beatmapId, normalizedCountry, partialScores);
          }

          writeBeatmapScoreLookupStatus(beatmapId, normalizedCountry, {
            phase: "scores",
            label: "Checking player scores",
            current: checked,
            total: userIds.length,
            found: partialScores.length,
          });
        },
      );

      const sortedScores = sortBeatmapScores(partialScores);
      writePartialBeatmapScores(beatmapId, normalizedCountry, sortedScores);
      return sortedScores;
    } finally {
      clearBeatmapScoreLookupStatus(beatmapId, normalizedCountry);
    }
  });
}

export const getBeatmapScores = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapScoresPayload)
  .handler(async ({ data }: { data: { beatmapId: number; country?: string; page: number } }) => {
    edgeCache(120, 600);
    if (data.country?.trim()) {
      return { scores: await getCountryBeatmapScores(data.beatmapId, data.country, data.page) };
    }

    return osuFetch<BeatmapScoresResponse>(
      `/beatmaps/${data.beatmapId}/scores`,
      {
        mode: "mania",
        type: "global",
      },
      { caller: "getBeatmapScores" },
    );
  });

export const getBeatmapScoreLookupStatus = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapScoresPayload)
  .handler(async ({ data }: { data: { beatmapId: number; country?: string; page: number } }): Promise<BeatmapScoreLookupStatus | null> => {
    noStore();
    if (!data.country?.trim()) return null;
    return (await getPersistentCached<BeatmapScoreLookupStatus>(
      beatmapScoreLookupStatusKey(data.beatmapId, data.country),
    )) ?? null;
  });

export const getPartialBeatmapScores = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapScoresPayload)
  .handler(async ({ data }: { data: { beatmapId: number; country?: string; page: number } }): Promise<OsuScore[]> => {
    noStore();
    if (!data.country?.trim()) return [];
    return (await getPersistentCached<OsuScore[]>(
      beatmapScoreLookupPartialKey(data.beatmapId, data.country),
    )) ?? [];
  });

// ── Search ──────────────────────────────────────────────────────────────────

export const searchUsers = createServerFn({ method: "GET" })
  .inputValidator(normalizeSearchUsersPayload)
  .handler(async ({ data }: { data: { query: string } }) => {
    edgeCache(60, 600);
    return osuFetch<UserSearchResponse>(
      "/search",
      {
        mode: "user",
        query: data.query,
      },
      { caller: "searchUsers" },
    );
  });

// ── Score Feed (CR top players' recent scores) ─────────────────────────────

export const getCountryRecentScores = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryRecentScoresPayload)
  .handler(async ({ data }: { data: { userIds: number[]; users?: TrackerUserSummary[]; batchSize?: number; batchIndex?: number; recentLimit?: number; source?: "backfill" | "live" } }) => {
    edgeCache(30, 120);
    return fetchTrackerRecentScoresCached(data.userIds, data);
  });

export const getTrackerSnapshot = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<TrackerSnapshotResponse> => {
    edgeCache(30, 120);
    const country = normalizeCountryCode(data.country);
    const rankings = await fetchRankingsPage("performance", 1, country);
    const users = toTrackerUserSummaries(rankings);
    const userIds = users.map((user) => user.id);
    const seedBatchCount = Math.min(3, Math.ceil(userIds.length / 10));
    const feedResults = await Promise.allSettled(
      Array.from({ length: seedBatchCount }, async (_, batchIndex) => {
        const batchUsers = users.slice(batchIndex * 10, batchIndex * 10 + 10);
        const batchUserIds = batchUsers.map((user) => user.id);
        const feedOptions = {
          userIds: batchUserIds,
          users: batchUsers,
          batchSize: 10,
          batchIndex: 0,
          recentLimit: 10,
          source: "live" as const,
        };
        return withTrackerSnapshotBatchBudget(
          fetchTrackerRecentScoresCached(batchUserIds, feedOptions),
        );
      }),
    );
    const mergedScores = new Map<string, LeanTrackerScore>();
    const gains: Record<number, number> = {};
    for (const result of feedResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      Object.assign(gains, result.value.gains);
      for (const score of result.value.scores) {
        const key = getTrackerScoreKey(score);
        if (!mergedScores.has(key)) mergedScores.set(key, score);
      }
    }
    const scores = [...mergedScores.values()]
      .sort((a, b) => getLeanTrackerScoreTimeMs(b) - getLeanTrackerScoreTimeMs(a))
      .slice(0, 100);

    return {
      country,
      rankings,
      seedBatchCount,
      userIds,
      users,
      scores,
      gains,
      fetchedAt: Date.now(),
    };
  });

export const getTrackerLiveSnapshot = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<TrackerLiveSnapshotResponse> => {
    edgeCache(30, 120);
    const country = normalizeCountryCode(data.country);
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const cacheKey = `tracker-live-snapshot:v${TRACKER_LIVE_SNAPSHOT_CACHE_VERSION}:${country}:${minuteBucket}`;

    return fetchWithCacheLock(cacheKey, TRACKER_LIVE_SNAPSHOT_CACHE_TTL, async () => {
      const rankings = await fetchRankingsPage("performance", 1, country);
      const users = toTrackerUserSummaries(rankings);
      const userIds = users.map((user) => user.id);
      const batchSize = 10;
      const totalBatches = Math.max(1, Math.ceil(userIds.length / batchSize));
      const batchIndex = minuteBucket % totalBatches;
      const batchUsers = users.slice(batchIndex * batchSize, batchIndex * batchSize + batchSize);
      const batchUserIds = batchUsers.map((user) => user.id);
      const feed = await fetchTrackerRecentScoresCached(batchUserIds, {
        users: batchUsers,
        batchSize,
        batchIndex: 0,
        recentLimit: 20,
        source: "live",
      });

      return {
        batchIndex,
        country,
        fetchedAt: Date.now(),
        gains: feed.gains,
        scores: feed.scores,
        totalBatches,
        userIds,
        users,
      };
    });
  });

// ── Maps (aggregated most-played + favourites across CR players) ───────────

async function fetchUserMostPlayed(userId: number): Promise<BeatmapPlaycount[]> {
  const cacheKey = `user-most-played:${userId}`;
  return fetchWithCacheLock(cacheKey, USER_MOST_PLAYED_CACHE_TTL, () =>
    osuFetch<BeatmapPlaycount[]>(
      `/users/${userId}/beatmapsets/most_played`,
      { limit: 100, offset: 0 },
      { caller: "fetchUserMostPlayed" },
    ),
  );
}

async function fetchUserFavourites(userId: number): Promise<OsuBeatmapset[]> {
  const cacheKey = `user-favourites-all:${userId}`;
  return fetchWithCacheLock(cacheKey, USER_FAVOURITES_CACHE_TTL, async () => {
    const all: OsuBeatmapset[] = [];
    for (let page = 0; page < USER_FAVOURITES_MAX_PAGES; page++) {
      const batch = await osuFetch<OsuBeatmapset[]>(
        `/users/${userId}/beatmapsets/favourite`,
        { limit: USER_FAVOURITES_PAGE_SIZE, offset: page * USER_FAVOURITES_PAGE_SIZE },
        { caller: "fetchUserFavourites" },
      );
      all.push(...batch);
      if (batch.length < USER_FAVOURITES_PAGE_SIZE) break;
    }
    return all;
  });
}

type MapsUser = { id: number; username: string; avatar_url: string };

const MAPS_REBUILD_LOCK_TTL_MS = 60_000;
const MAPS_ORPHAN_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAPS_MAX_USERS = 100;
const MAPS_MAX_USERNAME_LENGTH = 64;
const MAPS_MAX_AVATAR_URL_LENGTH = 512;

function normalizeMapsUserId(value: unknown): number | null {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 1_000_000_000) return null;
  return id;
}

function normalizeMapsUsers(users: unknown): MapsUser[] {
  if (!Array.isArray(users)) {
    throw new Error("Invalid maps users payload.");
  }
  if (users.length > MAPS_MAX_USERS) {
    throw new Error(`Maps requests are limited to ${MAPS_MAX_USERS} users.`);
  }

  const out: MapsUser[] = [];
  const seen = new Set<number>();

  for (const raw of users) {
    if (!raw || typeof raw !== "object") continue;
    const input = raw as Partial<MapsUser>;
    const id = normalizeMapsUserId(input.id);
    if (!id || seen.has(id)) continue;

    seen.add(id);
    out.push({
      id,
      username: String(input.username ?? "Unknown").slice(0, MAPS_MAX_USERNAME_LENGTH),
      avatar_url: String(input.avatar_url ?? "").slice(0, MAPS_MAX_AVATAR_URL_LENGTH),
    });
  }

  return out;
}

function normalizeMapsUserPayload(data: { users?: unknown }): { users: MapsUser[] } {
  return { users: normalizeMapsUsers(data?.users) };
}

function normalizeMapsUserRebuildPayload(data: { users?: unknown; userId?: unknown }): {
  users: MapsUser[];
  userId: number;
} {
  const users = normalizeMapsUsers(data?.users);
  const userId = normalizeMapsUserId(data?.userId);
  if (!userId) {
    throw new Error("Invalid maps rebuild user.");
  }
  if (!users.some((user) => user.id === userId)) {
    throw new Error("Maps rebuild user must be present in the bounded users payload.");
  }
  return { users, userId };
}

function computeMapsUserKey(users: MapsUser[]): string {
  return users
    .map((user) => user.id)
    .sort((a, b) => a - b)
    .join(",");
}

function computeMapsFarmedCacheKey(users: MapsUser[]): string {
  return `country-maps-farmed:v${MAPS_DATA_CACHE_VERSION}:${computeMapsUserKey(users)}`;
}

function computeMapsFavouritesCacheKey(users: MapsUser[]): string {
  return `country-maps-favourites:v${MAPS_DATA_CACHE_VERSION}:${computeMapsUserKey(users)}`;
}

export interface CountryMapsFarmedSection {
  farmed: MapsFarmedEntry[];
  generatedAt: string;
}

export interface CountryMapsFavouritesSection {
  mostPlayed: MapsAggregatedBeatmap[];
  favourites: MapsAggregatedFavourite[];
  favouritesByPlayer: MapsPlayerFavourites[];
  beatmapsetsPool: Record<number, MapsFavouriteBeatmapset>;
  generatedAt: string;
}

async function buildCountryFarmed(users: MapsUser[]): Promise<CountryMapsFarmedSection> {
      const userResults = await mapWithConcurrency(
        users,
        MAPS_FETCH_CONCURRENCY,
        async (user) => {
          const bestScores = await fetchUserBestScoresWindow(user.id, 200, {
            feature: "country-top-plays-refresh",
          }).catch(() => [] as OsuScore[]);
          return { user, bestScores };
        },
      );

      // ── Farmed: maps in 2+ players' top 200 best scores ──────────
      const farmedMap = new Map<number, MapsFarmedEntry>();
      for (const { user, bestScores } of userResults) {
        for (const score of bestScores) {
          if (!score.beatmap || score.beatmap.mode !== "mania") continue;
          if (!score.pp || score.pp <= 0) continue;
          if (score.beatmapset?.status !== "ranked") continue;

          const bid = score.beatmap.id;
          const existing = farmedMap.get(bid);
          if (existing) {
            if (!existing.players.some((p) => p.id === user.id)) {
              existing.playerCount++;
              existing.players.push({
                id: user.id,
                username: user.username,
                avatarUrl: user.avatar_url,
                mods: getModAcronyms(score.mods),
                pp: score.pp,
                scoreUrl: getScoreUrl(score),
                playedAt: getScoreTimestamp(score),
              });
              existing.maxPp = Math.max(existing.maxPp, score.pp);
            }
          } else {
            farmedMap.set(bid, {
              beatmapId: bid,
              version: score.beatmap.version,
              difficultyRating: score.beatmap.difficulty_rating,
              totalLength: score.beatmap.total_length,
              cs: score.beatmap.cs,
              bpm: score.beatmap.bpm,
              beatmapsetId: score.beatmapset.id,
              title: score.beatmapset.title,
              artist: score.beatmapset.artist,
              creator: score.beatmapset.creator,
              covers: score.beatmapset.covers,
              status: score.beatmapset.status,
              playerCount: 1,
              players: [
                {
                  id: user.id,
                  username: user.username,
                  avatarUrl: user.avatar_url,
                  mods: getModAcronyms(score.mods),
                  pp: score.pp,
                  scoreUrl: getScoreUrl(score),
                  playedAt: getScoreTimestamp(score),
                },
              ],
              avgPp: 0,
              maxPp: score.pp,
            });
          }
        }
      }

      const farmed: MapsFarmedEntry[] = [];
      for (const entry of farmedMap.values()) {
        if (entry.playerCount < 2 && entry.maxPp < FARMED_SINGLE_PLAYER_PP_MIN) continue;
        entry.players.sort((a, b) => b.pp - a.pp);
        entry.avgPp =
          entry.players.reduce((sum, p) => sum + p.pp, 0) / entry.players.length;
        farmed.push(entry);
      }
      farmed.sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);

      return { farmed, generatedAt: new Date().toISOString() };
}

async function buildCountryFavourites(users: MapsUser[]): Promise<CountryMapsFavouritesSection> {
      const userResults = await mapWithConcurrency(
        users,
        MAPS_FETCH_CONCURRENCY,
        async (user) => {
          const [mostPlayed, favourites] = await Promise.all([
            fetchUserMostPlayed(user.id).catch(() => [] as BeatmapPlaycount[]),
            fetchUserFavourites(user.id).catch(() => [] as OsuBeatmapset[]),
          ]);
          return { user, mostPlayed, favourites };
        },
      );

      // ── Most played: from most_played endpoint (mania only) ──────
      const mpMap = new Map<number, MapsAggregatedBeatmap>();
      for (const { user, mostPlayed } of userResults) {
        for (const mp of mostPlayed) {
          if (mp.beatmap.mode !== "mania") continue;
          const existing = mpMap.get(mp.beatmap_id);
          if (existing) {
            existing.totalPlays += mp.count;
            existing.playerCount++;
            existing.players.push({
              id: user.id,
              username: user.username,
              avatarUrl: user.avatar_url,
              count: mp.count,
            });
          } else {
            mpMap.set(mp.beatmap_id, {
              beatmapId: mp.beatmap_id,
              version: mp.beatmap.version,
              difficultyRating: mp.beatmap.difficulty_rating,
              totalLength: mp.beatmap.total_length,
              beatmapsetId: mp.beatmapset.id,
              title: mp.beatmapset.title,
              artist: mp.beatmapset.artist,
              creator: mp.beatmapset.creator,
              covers: mp.beatmapset.covers,
              status: mp.beatmapset.status,
              globalPlayCount: mp.beatmapset.play_count,
              totalPlays: mp.count,
              playerCount: 1,
              players: [
                {
                  id: user.id,
                  username: user.username,
                  avatarUrl: user.avatar_url,
                  count: mp.count,
                },
              ],
            });
          }
        }
      }

      for (const entry of mpMap.values()) {
        entry.players.sort((a, b) => b.count - a.count);
      }

      const mostPlayed = [...mpMap.values()]
        .filter((m) => m.playerCount >= 2)
        .sort((a, b) => b.playerCount - a.playerCount || b.totalPlays - a.totalPlays)
        .slice(0, 200);

      // ── Favourites (mania-only) ──────────────────────────────────
      const favMap = new Map<number, MapsAggregatedFavourite>();
      const beatmapsetsPool: Record<number, MapsFavouriteBeatmapset> = {};
      const favouritesByPlayer: MapsPlayerFavourites[] = [];
      for (const { user, favourites } of userResults) {
        const playerIds: number[] = [];
        for (const fav of favourites) {
          const maniaBeatmaps = (fav.beatmaps ?? []).filter((bm) => bm.mode === "mania");
          if (maniaBeatmaps.length === 0) continue;

          playerIds.push(fav.id);

          if (!beatmapsetsPool[fav.id]) {
            const maniaKeysSet = new Set<number>();
            for (const bm of maniaBeatmaps) {
              if (typeof bm.cs === "number") maniaKeysSet.add(bm.cs);
            }
            const stars = maniaBeatmaps
              .map((bm) => bm.difficulty_rating)
              .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
            const starMin = stars.length ? Math.min(...stars) : 0;
            const starMax = stars.length ? Math.max(...stars) : 0;
            const versionNames = maniaBeatmaps.map((bm) => bm.version ?? "");
            const patterns = detectManiaPatterns(fav.tags ?? "", versionNames, fav.title ?? "");

            beatmapsetsPool[fav.id] = {
              id: fav.id,
              title: fav.title,
              artist: fav.artist,
              creator: fav.creator,
              covers: fav.covers,
              status: fav.status,
              globalPlayCount: fav.play_count,
              globalFavouriteCount: fav.favourite_count,
              previewUrl: fav.preview_url,
              maniaKeys: [...maniaKeysSet].sort((a, b) => a - b),
              maniaBeatmaps: maniaBeatmaps
                .map((bm) => ({
                  id: bm.id,
                  version: bm.version,
                  difficultyRating: bm.difficulty_rating,
                  totalLength: bm.total_length,
                  cs: bm.cs,
                }))
                .sort((a, b) => b.difficultyRating - a.difficultyRating),
              starMin,
              starMax,
              bpm: typeof fav.bpm === "number" ? fav.bpm : 0,
              patterns,
            };
          }

          const existing = favMap.get(fav.id);
          if (existing) {
            existing.playerCount++;
            existing.players.push({
              id: user.id,
              username: user.username,
              avatarUrl: user.avatar_url,
            });
          } else {
            favMap.set(fav.id, {
              beatmapsetId: fav.id,
              title: fav.title,
              artist: fav.artist,
              creator: fav.creator,
              covers: fav.covers,
              status: fav.status,
              globalPlayCount: fav.play_count,
              globalFavouriteCount: fav.favourite_count,
              playerCount: 1,
              players: [
                {
                  id: user.id,
                  username: user.username,
                  avatarUrl: user.avatar_url,
                },
              ],
            });
          }
        }

        if (playerIds.length > 0) {
          favouritesByPlayer.push({
            id: user.id,
            username: user.username,
            avatarUrl: user.avatar_url,
            beatmapsetIds: playerIds,
          });
        }
      }

      const favourites = [...favMap.values()]
        .filter((f) => f.playerCount >= 2)
        .sort(
          (a, b) =>
            b.playerCount - a.playerCount ||
            b.globalFavouriteCount - a.globalFavouriteCount,
        )
        .slice(0, 100);

      return {
        mostPlayed,
        favourites,
        favouritesByPlayer,
        beatmapsetsPool,
        generatedAt: new Date().toISOString(),
      };
}

export function composeCountryMapsData(
  farmedSection: CountryMapsFarmedSection,
  favSection: CountryMapsFavouritesSection,
): CountryMapsData {
  const farmedAt = farmedSection.generatedAt;
  const favAt = favSection.generatedAt;
  return {
    farmed: farmedSection.farmed,
    mostPlayed: favSection.mostPlayed,
    favourites: favSection.favourites,
    favouritesByPlayer: favSection.favouritesByPlayer,
    beatmapsetsPool: favSection.beatmapsetsPool,
    generatedAt: farmedAt < favAt ? farmedAt : favAt,
    farmedGeneratedAt: farmedAt,
    favouritesGeneratedAt: favAt,
  };
}

export const getCountryMapsData = createServerFn({ method: "GET" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    edgeCache(3600, 86400);
    const farmedKey = computeMapsFarmedCacheKey(data.users);
    const favKey = computeMapsFavouritesCacheKey(data.users);
    const [farmedRes, favRes] = await Promise.all([
      fetchWithStaleAllowed<CountryMapsFarmedSection>(
        farmedKey,
        MAPS_FARMED_CACHE_TTL,
        () => buildCountryFarmed(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
      fetchWithStaleAllowed<CountryMapsFavouritesSection>(
        favKey,
        MAPS_FAVOURITES_CACHE_TTL,
        () => buildCountryFavourites(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
    ]);
    return {
      value: composeCountryMapsData(farmedRes.value, favRes.value),
      isStale: farmedRes.isStale || favRes.isStale,
    };
  });

export const rebuildCountryMapsData = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    await assertDevMutationAllowed("Country maps rebuild");
    const farmedKey = computeMapsFarmedCacheKey(data.users);
    const favKey = computeMapsFavouritesCacheKey(data.users);
    const [farmedRebuild, favRebuild] = await Promise.all([
      runCacheRebuild<CountryMapsFarmedSection>(
        farmedKey,
        MAPS_FARMED_CACHE_TTL,
        async () => {
          const result = await buildCountryFarmed(data.users);
          await deleteExpiredCacheEntriesByPrefix(
            "country-maps-farmed:",
            MAPS_ORPHAN_CLEANUP_AGE_MS,
          );
          return result;
        },
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
      runCacheRebuild<CountryMapsFavouritesSection>(
        favKey,
        MAPS_FAVOURITES_CACHE_TTL,
        async () => {
          const result = await buildCountryFavourites(data.users);
          await deleteExpiredCacheEntriesByPrefix(
            "country-maps-favourites:",
            MAPS_ORPHAN_CLEANUP_AGE_MS,
          );
          // Clean out legacy single-blob entries from before the split.
          await deleteExpiredCacheEntriesByPrefix(
            "country-maps-data:",
            MAPS_ORPHAN_CLEANUP_AGE_MS,
          );
          return result;
        },
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
    ]);
    const farmedValue = farmedRebuild.value;
    const favValue = favRebuild.value;
    return {
      rebuilt: farmedRebuild.rebuilt || favRebuild.rebuilt,
      value: farmedValue && favValue ? composeCountryMapsData(farmedValue, favValue) : null,
    };
  });

// Per-section exports so the client can fetch farmed and favourites in parallel
// and show incremental progress as each completes.
export const getCountryMapsFarmed = createServerFn({ method: "GET" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    edgeCache(3600, 86400);
    return fetchWithStaleAllowed<CountryMapsFarmedSection>(
      computeMapsFarmedCacheKey(data.users),
      MAPS_FARMED_CACHE_TTL,
      () => buildCountryFarmed(data.users),
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

export const getCountryMapsFavourites = createServerFn({ method: "GET" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    edgeCache(3600, 86400);
    return fetchWithStaleAllowed<CountryMapsFavouritesSection>(
      computeMapsFavouritesCacheKey(data.users),
      MAPS_FAVOURITES_CACHE_TTL,
      () => buildCountryFavourites(data.users),
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

export const rebuildCountryMapsFarmed = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    await assertDevMutationAllowed("Country maps farmed rebuild");
    return runCacheRebuild<CountryMapsFarmedSection>(
      computeMapsFarmedCacheKey(data.users),
      MAPS_FARMED_CACHE_TTL,
      async () => {
        const result = await buildCountryFarmed(data.users);
        await deleteExpiredCacheEntriesByPrefix(
          "country-maps-farmed:",
          MAPS_ORPHAN_CLEANUP_AGE_MS,
        );
        return result;
      },
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

export const rebuildCountryMapsFavourites = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserPayload)
  .handler(async ({ data }: { data: { users: MapsUser[] } }) => {
    await assertDevMutationAllowed("Country maps favourites rebuild");
    return runCacheRebuild<CountryMapsFavouritesSection>(
      computeMapsFavouritesCacheKey(data.users),
      MAPS_FAVOURITES_CACHE_TTL,
      async () => {
        const result = await buildCountryFavourites(data.users);
        await deleteExpiredCacheEntriesByPrefix(
          "country-maps-favourites:",
          MAPS_ORPHAN_CLEANUP_AGE_MS,
        );
        return result;
      },
      MAPS_REBUILD_LOCK_TTL_MS,
    );
  });

// Invalidate one player's per-user caches (favourites / most-played / best
// scores) and rebuild the country aggregate. Every other player's per-user
// data still hits the 6h cache, so only the target player is re-fetched from
// osu! — useful when a single player updates their favourites and you don't
// want to force-refresh the entire top 50.
export const rebuildCountryMapsForUser = createServerFn({ method: "POST" })
  .inputValidator(normalizeMapsUserRebuildPayload)
  .handler(async ({ data }: { data: { users: MapsUser[]; userId: number } }) => {
    await assertDevMutationAllowed("Country maps user rebuild");
    await deletePersistentCacheEntries([
      `user-favourites-all:${data.userId}`,
      `user-most-played:${data.userId}`,
      `user-best-scores-window:${data.userId}:200`,
      `user-best-scores-window:${data.userId}:100`,
    ]);

    const farmedKey = computeMapsFarmedCacheKey(data.users);
    const favKey = computeMapsFavouritesCacheKey(data.users);
    const [farmedRebuild, favRebuild] = await Promise.all([
      runCacheRebuild<CountryMapsFarmedSection>(
        farmedKey,
        MAPS_FARMED_CACHE_TTL,
        () => buildCountryFarmed(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
      runCacheRebuild<CountryMapsFavouritesSection>(
        favKey,
        MAPS_FAVOURITES_CACHE_TTL,
        () => buildCountryFavourites(data.users),
        MAPS_REBUILD_LOCK_TTL_MS,
      ),
    ]);
    const farmedValue = farmedRebuild.value;
    const favValue = favRebuild.value;
    return {
      rebuilt: farmedRebuild.rebuilt || favRebuild.rebuilt,
      value: farmedValue && favValue ? composeCountryMapsData(farmedValue, favValue) : null,
    };
  });

// ── Replay (parsed server-side via osu-parsers) ────────────────────────────

const REPLAY_CACHE_LOCK_TTL_MS = 30_000;
const REPLAY_CACHE_LOCK_WAIT_MS = 500;
const REPLAY_CACHE_LOCK_WAIT_RETRIES = 8;
const REPLAY_PARSED_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const REPLAY_PARSED_CACHE_VERSION = 1;

type ReplayDownload = {
  buffer: Buffer;
  endpointKind: ReplayEndpointKind;
};

type ParsedReplayResponse = {
  header: {
    playerName: string;
    gameMode: number;
    totalScore: number;
    maxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countGeki: number;
    countKatu: number;
    countMiss: number;
    isPerfect: boolean;
  };
  lifeBarFrames: Array<{ time: number; health: number }>;
  framesPacked: { count: number; times: string; keys: string };
  keyCount: number;
};

type ReplayCacheModule = typeof import("./r2-cache");

function getReplayCacheModule(): Promise<ReplayCacheModule> {
  return import("./r2-cache");
}

function replayCacheLockKey(scoreId: number): string {
  return `replay-osr:v1:${scoreId}`;
}

function replayEndpointPath(endpointKind: ReplayEndpointKind, mode: string, scoreId: number): string {
  return endpointKind === "legacy"
    ? `/scores/${mode}/${scoreId}/download`
    : `/scores/${scoreId}/download`;
}

function replaySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadReplay(
  data: { scoreId: number; mode: string },
  preferredEndpointKind: ReplayEndpointKind | null,
): Promise<ReplayDownload> {
  const endpointKinds: ReplayEndpointKind[] = preferredEndpointKind
    ? [preferredEndpointKind, preferredEndpointKind === "legacy" ? "modern" : "legacy"]
    : ["legacy", "modern"];
  let firstError: unknown = null;
  let lastError: unknown = null;

  for (const endpointKind of endpointKinds) {
    try {
      const buffer = await osuFetchBinary(replayEndpointPath(endpointKind, data.mode, data.scoreId), {
        caller: `getReplayParsed:${endpointKind}`,
      });
      return {
        buffer: Buffer.from(buffer),
        endpointKind,
      };
    } catch (error) {
      firstError ??= error;
      lastError = error;
    }
  }

  throw (preferredEndpointKind ? firstError : lastError) ?? new Error("Failed to download replay");
}

async function getReplayBuffer(data: { scoreId: number; mode: string }): Promise<Buffer> {
  const {
    getCachedReplay,
    getCachedReplayEndpointKind,
    isR2ReplayCacheConfigured,
    putCachedReplay,
  } = await getReplayCacheModule();
  const cached = await getCachedReplay(data.scoreId);
  if (cached) return cached.buffer;

  const preferredEndpointKind = await getCachedReplayEndpointKind(data.scoreId);
  if (!isR2ReplayCacheConfigured()) {
    return (await downloadReplay(data, preferredEndpointKind)).buffer;
  }

  const lockKey = replayCacheLockKey(data.scoreId);
  const lockOwner = await acquireCacheLock(lockKey, REPLAY_CACHE_LOCK_TTL_MS);

  if (lockOwner) {
    try {
      return await runWithCacheLockRenewal(lockKey, lockOwner, REPLAY_CACHE_LOCK_TTL_MS, async () => {
        const rechecked = await getCachedReplay(data.scoreId);
        if (rechecked) return rechecked.buffer;

        const download = await downloadReplay(data, preferredEndpointKind);
        const stored = await putCachedReplay(data.scoreId, download.endpointKind, download.buffer);
        return stored?.buffer ?? download.buffer;
      });
    } finally {
      await releaseCacheLock(lockKey, lockOwner);
    }
  }

  for (let i = 0; i < REPLAY_CACHE_LOCK_WAIT_RETRIES; i++) {
    await replaySleep(REPLAY_CACHE_LOCK_WAIT_MS);
    const polled = await getCachedReplay(data.scoreId);
    if (polled) return polled.buffer;
  }

  const download = await downloadReplay(data, preferredEndpointKind);
  await putCachedReplay(data.scoreId, download.endpointKind, download.buffer).catch(() => null);
  return download.buffer;
}

export const getReplayParsed = createServerFn({ method: "GET" })
  .inputValidator(normalizeReplayParsedPayload)
  .handler(async ({ data }: { data: { scoreId: number; mode: string; keyCount?: number } }) => {
    edgeCache(86400, 604800);
    const cacheKey = [
      `replay-parsed:v${REPLAY_PARSED_CACHE_VERSION}`,
      data.scoreId,
      data.mode,
      data.keyCount ?? 0,
    ].join(":");

    return fetchWithCacheLock<ParsedReplayResponse>(cacheKey, REPLAY_PARSED_CACHE_TTL, async () => {
      const { ScoreDecoder } = await import("osu-parsers");
      const buffer = await getReplayBuffer(data);
      const decoder = new ScoreDecoder();
      const score = await decoder.decodeFromBuffer(buffer);

      const info = score.info;
      const rawFrames = (score.replay?.frames ?? []) as any[];
      const lifeBarFrames = (score.replay?.lifeBar ?? [])
        .map((frame: any) => ({
          time: Math.round(Number(frame.startTime ?? frame.time ?? 0)),
          health: Math.max(0, Math.min(1, Number(frame.health ?? 0))),
        }))
        .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.health))
        .sort((a, b) => a.time - b.time);

      // Pack frames into typed arrays to shrink the wire payload ~20x vs JSON.
      // Little-endian host is assumed (every x86/ARM server and client is LE).
      // For mania, column bitmask is in mouseX (position.x), NOT buttonState.
      const frameCount = rawFrames.length;
      const times = new Int32Array(frameCount);
      const keys = new Uint16Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        const f = rawFrames[i];
        times[i] = f.startTime | 0;
        keys[i] = Math.round(f.mouseX ?? f.position?.x ?? f.buttonState ?? 0) & 0xffff;
      }

      // Detect key count: prefer beatmap CS from score API, fall back to OR of all frames
      let keyCount = data.keyCount ?? 0;
      if (!keyCount) {
        let allBits = 0;
        for (let i = 0; i < frameCount; i++) allBits |= keys[i];
        let maxBit = 0;
        let tmp = allBits;
        while (tmp > 0) { maxBit++; tmp >>= 1; }
        keyCount = Math.max(maxBit, 4);
      }

      const timesB64 = Buffer.from(times.buffer, times.byteOffset, times.byteLength).toString("base64");
      const keysB64 = Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength).toString("base64");

      return {
        header: {
          playerName: info?.username ?? "Unknown",
          gameMode: info?.rulesetId ?? 3,
          totalScore: info?.totalScore ?? 0,
          maxCombo: info?.maxCombo ?? 0,
          count300: info?.count300 ?? 0,
          count100: info?.count100 ?? 0,
          count50: info?.count50 ?? 0,
          countGeki: info?.countGeki ?? 0,
          countKatu: info?.countKatu ?? 0,
          countMiss: info?.countMiss ?? 0,
          isPerfect: info?.perfect ?? false,
        },
        lifeBarFrames,
        framesPacked: { count: frameCount, times: timesB64, keys: keysB64 },
        keyCount,
      };
    }, REPLAY_CACHE_LOCK_TTL_MS);
  });

export const getBeatmapFile = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapPayload)
  .handler(async ({ data }: { data: { beatmapId: number } }) => {
    noStore();
    const osuFile = await fetchBeatmapFile(data.beatmapId);
    return { content: osuFile };
  });

export const getScore = createServerFn({ method: "GET" })
  .inputValidator(normalizeScorePayload)
  .handler(async ({ data }: { data: { scoreId: number; mode?: string } }) => {
    edgeCache(300, 1800);
    const mode = data.mode ?? "mania";

    try {
      const legacyScore = await osuFetch<OsuScore>(
        `/scores/${mode}/${data.scoreId}`,
        undefined,
        { caller: "getScore:legacy" },
      );
      const resolvedMode = legacyScore.beatmap?.mode ?? mode;
      if (resolvedMode === mode) {
        return legacyScore;
      }
    } catch {
      // Fall back to modern score lookup below.
    }

    return osuFetch<OsuScore>(`/scores/${data.scoreId}`, undefined, {
      caller: "getScore:modern",
    });
  });

// ── Snipes (per-beatmap country leaderboard #1 changes) ─────────────────────

async function fetchUserRecentPlays(userId: number): Promise<OsuScore[]> {
  const cacheKey = `user-recent-plays:mania:${userId}`;
  const cached = await getPersistentCached<OsuScore[]>(cacheKey);
  if (cached) return cached;

  const pending = userRecentPlaysPromiseCache.get(userId);
  if (pending) return pending;

  const request = fetchWithCacheLock(cacheKey, SNIPES_RECENT_PLAYS_CACHE_TTL, () =>
    osuFetch<OsuScore[]>(
      `/users/${userId}/scores/recent`,
      getScoreRequestParams(userId, {
        mode: "mania",
        limit: SNIPES_RECENT_LIMIT,
        offset: 0,
        include_fails: 0,
      }),
      { caller: "fetchUserRecentPlays" },
    ),
  ).finally(() => {
    userRecentPlaysPromiseCache.delete(userId);
  });

  userRecentPlaysPromiseCache.set(userId, request);
  return request;
}

function isSnipesRankedScore(score: OsuScore): boolean {
  if (score.ranked === false) return false;
  return !hasCustomRateMod(score.mods);
}

function boardScoreFromScore(score: OsuScore): CountryBoardScore | null {
  if (!score.user) return null;
  const display = getScoreDisplayValues(score);
  const totalScore = display.totalScore ?? score.total_score ?? score.score ?? 0;
  return {
    userId: score.user.id,
    username: score.user.username,
    avatarUrl: score.user.avatar_url,
    scoreId: score.id,
    totalScore,
    accuracy: display.accuracy,
    mods: getModAcronyms(score.mods),
    pp: score.pp,
    rank: display.rank,
    isLazer: display.isLazer,
    hasReplay: score.has_replay ?? score.replay ?? false,
    endedAt: getScoreTimestamp(score),
  };
}

type BoardMeta = Pick<CountryBoardSnapshotEntry, "beatmap" | "beatmapset">;

function boardMetadataFromScore(
  score: OsuScore,
  fallbackBeatmapset?: OsuScore["beatmapset"],
): BoardMeta | null {
  const beatmap = score.beatmap;
  const beatmapset = score.beatmapset ?? fallbackBeatmapset;
  if (!beatmap || !beatmapset) return null;
  return {
    beatmap: {
      version: beatmap.version,
      difficulty_rating: beatmap.difficulty_rating,
      cs: beatmap.cs,
      url: beatmap.url ?? `https://osu.ppy.sh/beatmaps/${beatmap.id}`,
    },
    beatmapset: {
      id: beatmapset.id,
      title: beatmapset.title,
      artist: beatmapset.artist,
      cover_url: beatmapset.covers?.["cover@2x"] ?? beatmapset.covers?.cover ?? "",
    },
  };
}

function buildSnipeEvent(
  beatmapId: number,
  meta: BoardMeta,
  sniper: CountryBoardScore,
  victim: CountryBoardScore,
  boardRank: number,
  isSeeded = false,
): SnipeEvent {
  return {
    beatmap_id: beatmapId,
    beatmapset_id: meta.beatmapset.id,
    score_id: sniper.scoreId,
    sniper: {
      id: sniper.userId,
      username: sniper.username,
      avatar_url: sniper.avatarUrl,
    },
    victim: {
      id: victim.userId,
      username: victim.username,
      avatar_url: victim.avatarUrl,
    },
    beatmap: meta.beatmap,
    beatmapset: meta.beatmapset,
    totalScore: sniper.totalScore,
    accuracy: sniper.accuracy,
    mods: sniper.mods,
    pp: sniper.pp,
    rank: sniper.rank,
    isLazer: sniper.isLazer,
    hasReplay: sniper.hasReplay,
    timestamp: sniper.endedAt,
    victimTimestamp: victim.endedAt,
    victimTotalScore: victim.totalScore,
    victimPp: victim.pp,
    detectedAt: Date.now(),
    boardRank,
    ...(isSeeded ? { isSeeded: true } : {}),
  };
}

interface SnipesRosterPlayer {
  id: number;
  username: string;
  avatar_url: string;
}

async function probeCountryBoardLanes(
  beatmapId: number,
  roster: SnipesRosterPlayer[],
  meta: BoardMeta,
): Promise<Record<string, CountryBoardSnapshotEntry> | null> {
  // getBeatmapUserScoresAll returns every score the user has on the map
  // (different mod sets, lazer/stable splits, etc). We need all of them so
  // we can segment by lane — getBeatmapUserScore only returns the user's
  // single "best" score and would collapse lanes.
  //
  // Note: this endpoint does NOT embed `user` on each returned score
  // (only `user_id`), nor does it include beatmap/beatmapset. That's why
  // we receive roster players and beatmap meta from the caller instead of
  // deriving them from the response.
  const perUserResults = await mapWithConcurrency(
    roster,
    SNIPES_PROBE_CONCURRENCY,
    async (player) => {
      try {
        const scores = await getBeatmapUserScoresAll(beatmapId, player.id, {
          feature: "snipes-probe-country-board",
          rosterSize: roster.length,
          concurrency: SNIPES_PROBE_CONCURRENCY,
          beatmapsetId: meta.beatmapset.id,
        });
        return { player, scores };
      } catch {
        return { player, scores: [] as OsuScore[] };
      }
    },
  );

  // For each (user, lane), compute the best play AND the best prior play
  // (highest totalScore with endedAt strictly before the best's endedAt). The
  // prior-best lets the seed heuristic detect self-improvement false positives
  // without needing cross-scan history.
  const perLane = new Map<string, Map<number, CountryBoardScore>>();
  for (const { player, scores } of perUserResults) {
    // Group this user's scores by lane first so prior-best stays lane-scoped.
    const byLane = new Map<string, { score: OsuScore; totalScore: number; endedAtMs: number }[]>();
    for (const score of scores) {
      if (!score) continue;
      if (!isSnipesRankedScore(score)) continue;
      const display = getScoreDisplayValues(score);
      const totalScore = display.totalScore ?? score.total_score ?? score.score ?? 0;
      if (totalScore <= 0) continue;
      const mods = getModAcronyms(score.mods);
      const lane = getBoardLaneKey(mods, display.isLazer);
      const endedAtMs = new Date(getScoreTimestamp(score)).getTime();
      if (!byLane.has(lane)) byLane.set(lane, []);
      byLane.get(lane)!.push({ score, totalScore, endedAtMs });
    }

    for (const [lane, entries] of byLane) {
      if (entries.length === 0) continue;
      entries.sort((a, b) => b.totalScore - a.totalScore);
      const best = entries[0];
      const display = getScoreDisplayValues(best.score);

      let priorBestTotalScore: number | undefined;
      if (Number.isFinite(best.endedAtMs)) {
        for (let i = 1; i < entries.length; i++) {
          const e = entries[i];
          if (!Number.isFinite(e.endedAtMs) || e.endedAtMs >= best.endedAtMs) continue;
          if (priorBestTotalScore == null || e.totalScore > priorBestTotalScore) {
            priorBestTotalScore = e.totalScore;
          }
        }
      }

      const board: CountryBoardScore = {
        userId: player.id,
        username: player.username,
        avatarUrl: player.avatar_url,
        scoreId: best.score.id,
        totalScore: best.totalScore,
        accuracy: display.accuracy,
        mods: getModAcronyms(best.score.mods),
        pp: best.score.pp,
        rank: display.rank,
        isLazer: display.isLazer,
        hasReplay: best.score.has_replay ?? best.score.replay ?? false,
        endedAt: getScoreTimestamp(best.score),
        ...(priorBestTotalScore != null ? { priorBestTotalScore } : {}),
      };

      let users = perLane.get(lane);
      if (!users) {
        users = new Map();
        perLane.set(lane, users);
      }
      users.set(board.userId, board);
    }
  }

  if (perLane.size === 0) return null;

  const entries: Record<string, CountryBoardSnapshotEntry> = {};
  const now = Date.now();
  for (const [lane, users] of perLane) {
    const scores = [...users.values()].sort((a, b) => b.totalScore - a.totalScore);
    entries[lane] = {
      ...meta,
      scores,
      lastTouchedAt: now,
    };
  }

  return entries;
}

const snipesBackgroundScanInProgress = new Set<string>();

function refreshCountrySnipesInBackground(
  country: string,
  cacheKey: string,
  snapshotKey: string,
  logKey: string,
): void {
  if (snipesBackgroundScanInProgress.has(country)) return;
  snipesBackgroundScanInProgress.add(country);
  let ranScan = false;
  void fetchWithCacheLock(
    cacheKey,
    SNIPES_CACHE_TTL,
    () => {
      ranScan = true;
      return runSnipesScan(country, snapshotKey, logKey);
    },
    SNIPES_LOCK_TTL,
    {
      waitMs: SNIPES_LOCK_WAIT_MS,
      waitRetries: SNIPES_LOCK_WAIT_RETRIES,
      runWithoutLockOnTimeout: false,
    },
  )
    .catch((err) => console.warn("[snipes] background scan failed:", getErrorMessage(err)))
    .finally(() => {
      if (ranScan) {
        clearSnipesScanStatus(country);
        clearPartialSnipeEvents(country);
      }
      snipesBackgroundScanInProgress.delete(country);
    });
}

async function runSnipesScan(
  country: string,
  snapshotKey: string,
  logKey: string,
): Promise<SnipesResponse> {
  try {
    clearPartialSnipeEvents(country);
    writeSnipesScanStatus(
      country,
      { phase: "roster", label: "Fetching country roster", current: 0, total: 1 },
      { force: true },
    );
    const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
    const players = rankings.ranking
      .filter((entry) => entry.user.is_active !== false)
      .slice(0, SNIPES_PLAYER_LIMIT)
      .map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
      }));

    if (players.length === 0) {
      clearSnipesScanStatus(country);
      clearPartialSnipeEvents(country);
      return { events: [], scannedAt: Date.now() };
    }

    writeSnipesScanStatus(
      country,
      {
        phase: "recent",
        label: `Loading recent plays from top ${players.length} players`,
        current: 0,
        total: players.length,
      },
      { force: true },
    );

    let recentDone = 0;
    const recentByPlayer = await mapWithConcurrency(
      players,
      SNIPES_SCAN_CONCURRENCY,
      async (player) => {
        try {
          const scores = await fetchUserRecentPlays(player.id);
          return { player, scores };
        } catch (error) {
          console.warn("[osu] failed to fetch recent plays for snipes scan", {
            playerId: player.id,
            error: getErrorMessage(error),
          });
          return { player, scores: [] as OsuScore[] };
        } finally {
          recentDone += 1;
          writeSnipesScanStatus(country, {
            phase: "recent",
            label: `Loading recent plays from top ${players.length} players`,
            current: recentDone,
            total: players.length,
          });
        }
      },
    );

    const candidates: OsuScore[] = [];
    for (const { scores } of recentByPlayer) {
      for (const score of scores) {
        if (!score.passed) continue;
        if (!score.beatmap || !score.beatmapset || !score.user) continue;
        if (score.beatmap.mode !== "mania") continue;
        if (!SNIPES_RANKED_STATUSES.has(score.beatmapset.status)) continue;
        if (!isSnipesRankedScore(score)) continue;
        candidates.push(score);
      }
    }

    const snapshot: CountryBoardSnapshot =
      (await getPersistentCached<CountryBoardSnapshot>(snapshotKey)) ?? {};

    const newEvents: SnipeEvent[] = [];
    const seedQueue: { beatmapId: number; bestCandidate: OsuScore }[] = [];

    const candidatesByBeatmap = new Map<number, OsuScore[]>();
    for (const score of candidates) {
      const bid = score.beatmap.id;
      let bucket = candidatesByBeatmap.get(bid);
      if (!bucket) {
        bucket = [];
        candidatesByBeatmap.set(bid, bucket);
      }
      bucket.push(score);
    }

    const compareTotal = candidatesByBeatmap.size;
    const compareLabel = `Comparing ${candidates.length} recent plays across ${compareTotal} beatmap${compareTotal === 1 ? "" : "s"}`;
    writeSnipesScanStatus(
      country,
      {
        phase: "compare",
        label: compareLabel,
        current: 0,
        total: compareTotal,
      },
      { force: true },
    );

    let compareDone = 0;
    for (const [bid, scoresForMap] of candidatesByBeatmap.entries()) {
      scoresForMap.sort((a, b) => {
        const aMs = new Date(getScoreTimestamp(a)).getTime();
        const bMs = new Date(getScoreTimestamp(b)).getTime();
        return aMs - bMs;
      });

      const existingLanes = snapshot[bid];
      if (!existingLanes || Object.keys(existingLanes).length === 0) {
        let bestCandidate = scoresForMap[0];
        let bestTotal = boardScoreFromScore(bestCandidate)?.totalScore ?? 0;
        for (const s of scoresForMap.slice(1)) {
          const t = boardScoreFromScore(s)?.totalScore ?? 0;
          if (t > bestTotal) {
            bestCandidate = s;
            bestTotal = t;
          }
        }
        seedQueue.push({ beatmapId: bid, bestCandidate });
        compareDone += 1;
        writeSnipesScanStatus(country, {
          phase: "compare",
          label: compareLabel,
          current: compareDone,
          total: compareTotal,
        });
        continue;
      }

      let lanesForBid: Record<string, CountryBoardSnapshotEntry> = { ...existingLanes };
      const anyLaneMeta: BoardMeta | null = (() => {
        const first = Object.values(existingLanes)[0];
        return first ? { beatmap: first.beatmap, beatmapset: first.beatmapset } : null;
      })();

      for (const score of scoresForMap) {
        const newScore = boardScoreFromScore(score);
        if (!newScore) continue;
        const lane = getBoardLaneKey(newScore.mods, newScore.isLazer);
        const entry = lanesForBid[lane];

        if (!entry) {
          const meta = boardMetadataFromScore(score) ?? anyLaneMeta;
          if (!meta) continue;
          lanesForBid = {
            ...lanesForBid,
            [lane]: { ...meta, scores: [newScore], lastTouchedAt: Date.now() },
          };
          continue;
        }

        const oldIdx = entry.scores.findIndex((s) => s.userId === newScore.userId);
        if (oldIdx >= 0 && entry.scores[oldIdx].totalScore >= newScore.totalScore) {
          continue;
        }

        const withoutPlayer =
          oldIdx >= 0 ? entry.scores.filter((_, i) => i !== oldIdx) : entry.scores;
        const newSorted = [...withoutPlayer, newScore].sort(
          (a, b) => b.totalScore - a.totalScore,
        );
        const newIdx = newSorted.findIndex((s) => s.userId === newScore.userId);

        const movedUp =
          oldIdx < 0 ? newIdx < entry.scores.length : newIdx < oldIdx;
        if (movedUp) {
          const victim = entry.scores[newIdx];
          if (victim && victim.userId !== newScore.userId) {
            newEvents.push(
              buildSnipeEvent(
                bid,
                { beatmap: entry.beatmap, beatmapset: entry.beatmapset },
                newScore,
                victim,
                newIdx + 1,
              ),
            );
          }
        }

        lanesForBid = {
          ...lanesForBid,
          [lane]: { ...entry, scores: newSorted, lastTouchedAt: Date.now() },
        };
      }

      snapshot[bid] = lanesForBid;
      compareDone += 1;
      writeSnipesScanStatus(country, {
        phase: "compare",
        label: compareLabel,
        current: compareDone,
        total: compareTotal,
      });
    }

    if (newEvents.length > 0) writePartialSnipeEvents(country, newEvents);

    if (seedQueue.length > 0) {
      seedQueue.sort((a, b) => {
        const aMs = new Date(getScoreTimestamp(a.bestCandidate)).getTime();
        const bMs = new Date(getScoreTimestamp(b.bestCandidate)).getTime();
        return bMs - aMs;
      });
      const probeBatch = seedQueue.slice(0, SNIPES_SEED_PROBE_BUDGET);

      writeSnipesScanStatus(
        country,
        {
          phase: "seed",
          label: `Checking ${probeBatch.length} new beatmap${probeBatch.length === 1 ? "" : "s"}`,
          current: 0,
          total: probeBatch.length,
        },
        { force: true },
      );

      let seedDone = 0;
      const seedCutoff = Date.now() - SNIPES_SEED_MAX_AGE_MS;
      await mapWithConcurrency(
        probeBatch,
        SNIPES_SCAN_CONCURRENCY,
        async ({ beatmapId, bestCandidate }) => {
          try {
            const meta = boardMetadataFromScore(bestCandidate);
            if (!meta) return;
            const lanes = await probeCountryBoardLanes(beatmapId, players, meta);
            if (!lanes || Object.keys(lanes).length === 0) return;
            snapshot[beatmapId] = lanes;

            const userHasOlderScore = new Map<number, number>();
            for (const entry of Object.values(lanes)) {
              for (const s of entry.scores) {
                const ms = new Date(s.endedAt).getTime();
                if (!Number.isFinite(ms)) continue;
                const prev = userHasOlderScore.get(s.userId);
                if (prev == null || ms < prev) userHasOlderScore.set(s.userId, ms);
              }
            }

            for (const entry of Object.values(lanes)) {
              for (let i = 0; i < entry.scores.length - 1; i++) {
                const top = entry.scores[i];
                const next = entry.scores[i + 1];
                if (top.userId === next.userId) continue;
                const topMs = new Date(top.endedAt).getTime();
                const nextMs = new Date(next.endedAt).getTime();
                if (!Number.isFinite(topMs) || !Number.isFinite(nextMs)) continue;
                if (topMs <= nextMs) continue;
                if (topMs < seedCutoff) continue;
                if (
                  top.priorBestTotalScore != null &&
                  top.priorBestTotalScore > next.totalScore
                ) {
                  continue;
                }
                const oldestForSniper = userHasOlderScore.get(top.userId);
                if (oldestForSniper != null && oldestForSniper < topMs) continue;
                newEvents.push(
                  buildSnipeEvent(
                    beatmapId,
                    { beatmap: entry.beatmap, beatmapset: entry.beatmapset },
                    top,
                    next,
                    i + 1,
                    true,
                  ),
                );
              }
            }
            writePartialSnipeEvents(country, newEvents);
          } catch (error) {
            console.warn("[osu] snipes seed probe failed", {
              beatmapId,
              country,
              error: getErrorMessage(error),
            });
          } finally {
            seedDone += 1;
            writeSnipesScanStatus(country, {
              phase: "seed",
              label: `Checking ${probeBatch.length} new beatmap${probeBatch.length === 1 ? "" : "s"}`,
              current: seedDone,
              total: probeBatch.length,
            });
          }
        },
      );
    }

    const existingLog = (await getPersistentCached<SnipeEvent[]>(logKey)) ?? [];
    const merged = new Map<string, SnipeEvent>();
    for (const event of existingLog) {
      merged.set(`${event.beatmap_id}:${event.score_id}`, event);
    }
    for (const event of newEvents) {
      merged.set(`${event.beatmap_id}:${event.score_id}`, event);
    }
    const mergedLog = [...merged.values()]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, SNIPES_LOG_CAP);

    void Promise.allSettled([
      setPersistentCache(logKey, mergedLog, SNIPES_LOG_TTL),
      setPersistentCache(snapshotKey, snapshot, SNIPES_SNAPSHOT_TTL),
    ]);

    return { events: mergedLog, scannedAt: Date.now() };
  } catch (err) {
    clearSnipesScanStatus(country);
    clearPartialSnipeEvents(country);
    throw err;
  }
}

export const getCountrySnipes = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipesResponse> => {
    edgeCache(60, 600);
    const country = normalizeCountryCode(data.country);
    const cacheKey = `country-snipes-response:v5:${country}`;
    const snapshotKey = `country-board-snapshot:v5:${country}`;
    const logKey = `country-snipes-log:v3:${country}`;

    // Stale-while-revalidate: return expired data immediately so the client
    // never blocks on the ~55s scan. A background scan refreshes the cache
    // for the next request.
    const cached = await getPersistentCacheEntryAllowStale<SnipesResponse>(cacheKey);
    if (cached.hit) {
      if (!cached.isStale) return cached.value;
      refreshCountrySnipesInBackground(country, cacheKey, snapshotKey, logKey);
      return { ...cached.value, refreshInProgress: true };
    }

    // The 6h response entry may have been purged while the durable 30d snipe
    // log is still present. Serve that log immediately and rebuild the shorter
    // response cache in the background instead of making the page wait for a
    // full scan.
    const loggedEvents = await getPersistentCacheEntryAllowStale<SnipeEvent[]>(logKey);
    if (loggedEvents.hit && loggedEvents.value.length > 0) {
      refreshCountrySnipesInBackground(country, cacheKey, snapshotKey, logKey);
      return {
        events: loggedEvents.value,
        scannedAt: loggedEvents.updatedAt ?? Date.now(),
        refreshInProgress: true,
      };
    }

    // No data at all (true cold start) - block on the full scan.
    let ranScan = false;
    return fetchWithCacheLock(
      cacheKey,
      SNIPES_CACHE_TTL,
      () => {
        ranScan = true;
        return runSnipesScan(country, snapshotKey, logKey);
      },
      SNIPES_LOCK_TTL,
      {
        waitMs: SNIPES_LOCK_WAIT_MS,
        waitRetries: SNIPES_LOCK_WAIT_RETRIES,
        runWithoutLockOnTimeout: false,
      },
    ).finally(() => {
      if (ranScan) {
        clearSnipesScanStatus(country);
        clearPartialSnipeEvents(country);
      }
    });
  });

export const getSnipesScanStatus = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipesScanStatus | null> => {
    edgeCache(0, 0);
    const country = normalizeCountryCode(data.country);
    return (await getPersistentCached<SnipesScanStatus>(snipesStatusKey(country))) ?? null;
  });

export const getPartialSnipeEvents = createServerFn({ method: "GET" })
  .inputValidator(normalizeCountryPayload)
  .handler(async ({ data }: { data: { country?: string } }): Promise<SnipeEvent[]> => {
    edgeCache(0, 0);
    const country = normalizeCountryCode(data.country);
    return (await getPersistentCached<SnipeEvent[]>(snipesPartialEventsKey(country))) ?? [];
  });

// ── Dan Estimates ──────────────────────────────────────────────────────────────

const DAN_ESTIMATE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const DAN_ESTIMATE_CONCURRENCY = 6;

function danCacheKey(beatmapId: number, rate: number): string {
  const r = Math.round(rate * 100);
  return r === 100
    ? `dan:v${DAN_ESTIMATE_CACHE_VERSION}:${beatmapId}`
    : `dan:v${DAN_ESTIMATE_CACHE_VERSION}:${beatmapId}:r${r}`;
}

interface DanEstimateRequest {
  beatmapId: number;
  starRating?: number;
  rate?: number;
}

async function computeDanEstimate(
  req: DanEstimateRequest,
): Promise<LeanDanEstimate | null> {
  const rate = req.rate ?? 1;
  const key = danCacheKey(req.beatmapId, rate);
  const cached = await getPersistentCached<LeanDanEstimate>(key);
  if (cached) return cached;

  try {
    const osuFile = await fetchBeatmapFile(req.beatmapId);
    const map = parseManiaBeatmap(osuFile);
    if (map.keyCount !== 4) return null;

    const estimate = estimateDan(map, {
      starRating: req.starRating,
      rate: rate !== 1 ? rate : undefined,
    });

    const lean: LeanDanEstimate = {
      label: estimate.label,
      variant: estimate.variant,
      displayName: estimate.displayName,
      rawDan: estimate.rawDan,
      family: estimate.family,
      confidence: estimate.confidence,
      estimatorVersion: DAN_ESTIMATE_CACHE_VERSION,
    };

    await setPersistentCache(key, lean, DAN_ESTIMATE_CACHE_TTL);
    return lean;
  } catch {
    return null;
  }
}

export const getDanEstimates = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { items?: unknown[]; estimatorVersion?: unknown }): { items: DanEstimateRequest[]; estimatorVersion: number } => {
      const raw = asInputRecord(input);
      const items = Array.isArray(raw.items) ? raw.items : [];
      return {
        estimatorVersion: Number(raw.estimatorVersion) || DAN_ESTIMATE_CACHE_VERSION,
        items: items.map((item: any) => ({
          beatmapId: Number(item.beatmapId),
          starRating: item.starRating != null ? Number(item.starRating) : undefined,
          rate: item.rate != null ? Number(item.rate) : undefined,
        })),
      };
    },
  )
  .handler(
    async ({
      data,
    }: {
      data: { items: DanEstimateRequest[]; estimatorVersion: number };
    }): Promise<Record<string, LeanDanEstimate | null>> => {
      const { readCurrentAuth } = await import("./auth-server");
      const auth = await readCurrentAuth();
      const allowed = auth.canUseDevFeatures;

      if (allowed) edgeCache(3600, 86400);
      else setResponseHeader("Cache-Control", "private, no-store");

      const results: Record<string, LeanDanEstimate | null> = {};
      if (!allowed) {
        for (const req of data.items) {
          const rate = req.rate ?? 1;
          const key = rate === 1
            ? String(req.beatmapId)
            : `${req.beatmapId}:${Math.round(rate * 100)}`;
          results[key] = null;
        }
        return results;
      }

      await mapWithConcurrency(data.items, DAN_ESTIMATE_CONCURRENCY, async (req) => {
        const rate = req.rate ?? 1;
        const key = rate === 1
          ? String(req.beatmapId)
          : `${req.beatmapId}:${Math.round(rate * 100)}`;
        results[key] = await computeDanEstimate(req);
      });

      return results;
    },
  );
