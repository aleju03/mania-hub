import type { InValue } from "@libsql/client";
import { dirname, join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { readConfig } from "../config.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { isRankedRosterMember } from "../rosters/country-rosters.js";
import { getModAcronyms, getScoreIdentity, getScoreJudgementCount, getScoreTimestamp, getStoredScoreAccuracy, nowIso } from "../shared/score.js";
import { throwIfAborted } from "../shared/abort.js";
import type { OscScore } from "../shared/types.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import { markUserMissing } from "../users.js";
import { enqueueMissingChartAnalyses } from "./chart-analysis.js";
import { refreshFarmHelperKeyStatsForUser } from "./farm-helper-key-stats.js";
import { buildMapStatusPropagationStatement } from "./map-search.js";
import { loadGlobalFarmedBoardFromDisk, saveGlobalFarmedBoardToDisk } from "./maps-farmed-board-disk.js";

const MAPS_REFRESH_PRIORITY = -100;
const MAPS_FARMED_REFRESH_PRIORITY = -100;
const MAPS_FETCH_CONCURRENCY = 2;
const MAPS_FARMED_SCORE_WINDOW = 200;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
// A speed mod counts as a map's dominant farm mod when more than this share of
// the farming roster used it. Below a strict majority because, on farm maps,
// 40%+ DT among all farmers (DT vs nomod) already reads as "this is DT farm".
const FARMED_DOMINANT_MOD_SHARE = 0.4;
const USER_FAVOURITES_MAX_PAGES = 10;
const GLOBAL_MAPS_REFRESH_DEBOUNCE_MS = 10 * 60_000;
const MAPS_FARMED_OVERLAY_META_PREFIX = "maps_farmed_overlay_updated_at:";
const MAPS_FARMED_USER_OVERLAY_META_PREFIX = "maps_farmed_user_overlay_refreshed_at:";
const MAPS_USER_LIBRARY_META_PREFIX = "maps_user_library_refreshed_at:";
const MAPS_USER_LIBRARY_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60_000;
const MAPS_USER_LIBRARY_STALE_REFRESH_LIMIT = 25;
const MAPS_REFRESH_PROGRESS_META_PREFIX = "maps_refresh_progress:";
const MAPS_REFRESH_PROGRESS_WRITE_INTERVAL_MS = 1_000;
const MAPS_METADATA_BATCH_FLUSH_STATEMENTS = 500;
const GLOBAL_MAPS_FARMED_ROWS_PAGE = 25_000;
// Each map contributes five statements to an atomic projection patch, plus
// one revision-publish statement. Stay below execBatch's 500-statement chunk
// boundary so a revision and every change carrying it commit together.
const GLOBAL_MAPS_FARMED_PROJECTION_BATCH = 90;

function heapUsedMb(): number {
  return Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
}

export class MapsRosterNotReadyError extends Error {
  constructor(readonly country: string) {
    super(`Roster not ready for ${country}`);
    this.name = "MapsRosterNotReadyError";
  }
}

// A refresh that ran to completion and produced nothing usable: the roster's
// users genuinely have no farmed / most-played / favourite data. Per-user osu!
// failures are swallowed upstream (throwIfMapsRefreshShouldAbort rethrows only
// the transient ones), so this is a property of the country, not of the run —
// which is what lets the worker park it instead of retrying hourly forever. The
// message string is deliberately unchanged from the anonymous Error it replaces
// so `jobs.last_error` and the admin queue summary stay continuous.
export class MapsEmptyResultError extends Error {
  constructor(readonly country: string, readonly userCount: number) {
    super(`Maps refresh produced no usable data for ${userCount} users`);
    this.name = "MapsEmptyResultError";
  }
}

interface MapsUser {
  id: number;
  username: string;
  avatar_url: string;
}

interface MapsPlayerEntry {
  id: number;
  username: string;
  avatarUrl: string;
  count: number;
}

interface MapsAggregatedBeatmap {
  beatmapId: number;
  version: string;
  difficultyRating: number;
  totalLength: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: Record<string, string | undefined>;
  status: string;
  globalPlayCount: number;
  totalPlays: number;
  playerCount: number;
  players: MapsPlayerEntry[];
}

interface MapsAggregatedFavourite {
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: Record<string, string | undefined>;
  status: string;
  globalPlayCount: number;
  globalFavouriteCount: number;
  playerCount: number;
  players: Array<{ id: number; username: string; avatarUrl: string }>;
}

interface MapsFarmedEntry {
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
  covers: Record<string, string | undefined>;
  status: string;
  playerCount: number;
  players: Array<{
    id: number;
    username: string;
    avatarUrl: string;
    mods: string[];
    pp: number;
    scoreUrl: string | null;
    playedAt: string | null;
  }>;
  avgPp: number;
  maxPp: number;
  dominantMod?: "DT" | "HT" | null;
}

interface MapsFavouriteBeatmapset {
  id: number;
  title: string;
  artist: string;
  creator: string;
  // covers / previewUrl / maniaBeatmaps are omitted from the random-section
  // pool on the wire (GLOBAL ships ~45k entries); the frontend fills defaults.
  // Full-set reads (getMapsRandomBeatmapsets, core favourites) always set them.
  covers?: Record<string, string | undefined>;
  status: string;
  globalPlayCount: number;
  globalFavouriteCount: number;
  previewUrl?: string;
  maniaKeys: number[];
  maniaBeatmaps?: Array<{
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

interface MapsPlayerFavourites {
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

interface StoredMapsPlayer {
  id: number;
}

interface StoredMapsCountPlayer extends StoredMapsPlayer {
  count: number;
}

interface StoredMapsFarmedPlayer extends StoredMapsPlayer {
  mods: string[];
  pp: number;
  scoreUrl: string | null;
  playedAt: string | null;
}

interface StoredCountryMapsData {
  schemaVersion: 2;
  farmed: Array<Pick<MapsFarmedEntry, "beatmapId" | "playerCount" | "avgPp" | "maxPp" | "dominantMod"> & { players: StoredMapsFarmedPlayer[] }>;
  mostPlayed: Array<Pick<MapsAggregatedBeatmap, "beatmapId" | "totalPlays" | "playerCount"> & { players: StoredMapsCountPlayer[] }>;
  favourites: Array<Pick<MapsAggregatedFavourite, "beatmapsetId" | "playerCount"> & { players: StoredMapsPlayer[] }>;
  favouritesByPlayer: Array<Pick<MapsPlayerFavourites, "id" | "beatmapsetIds">>;
  beatmapsetsPool: number[];
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
}

type StoredMapsFarmedEntry = StoredCountryMapsData["farmed"][number];

interface CountryMapsFarmedSection {
  farmed: MapsFarmedEntry[];
  generatedAt: string;
}

interface CountryMapsFavouritesSection {
  mostPlayed: MapsAggregatedBeatmap[];
  favourites: MapsAggregatedFavourite[];
  favouritesByPlayer: MapsPlayerFavourites[];
  beatmapsetsPool: Record<number, MapsFavouriteBeatmapset>;
  generatedAt: string;
}

type MapsRefreshProgressStatus = "queued" | "running" | "done" | "failed";
type MapsRefreshProgressStage = "queued" | "fetching" | "persisting" | "done" | "failed";

export interface MapsRefreshProgress {
  country: string;
  status: MapsRefreshProgressStatus;
  stage: MapsRefreshProgressStage;
  percent: number;
  completedUnits: number;
  totalUnits: number;
  farmedCompleted: number;
  farmedTotal: number;
  favouritesCompleted: number;
  favouritesTotal: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
}

type MapsSnapshotResponse<T> = {
  value: T | null;
  generatedAt: string | null;
  refreshedAt: string | null;
  isStale: boolean;
  refreshQueued: boolean;
  progress: MapsRefreshProgress | null;
};

type RawBeatmap = {
  id?: number;
  beatmapset_id?: number;
  difficulty_rating?: number;
  mode?: string;
  status?: string;
  cs?: number;
  convert?: boolean;
  bpm?: number;
  total_length?: number;
  version?: string;
  url?: string;
};

type RawBeatmapset = {
  id?: number;
  title?: string;
  artist?: string;
  creator?: string;
  covers?: Record<string, string | undefined>;
  status?: string;
  play_count?: number;
  favourite_count?: number;
  preview_url?: string;
  bpm?: number;
  tags?: string;
  beatmaps?: RawBeatmap[];
};

type RawBeatmapPlaycount = {
  beatmap_id?: number;
  count?: number;
  beatmap?: RawBeatmap;
  beatmapset?: RawBeatmapset;
};

export async function enqueueMapsRefresh(queue: JobQueue, country: string, options: { priority?: number; replaceDone?: boolean; runAfter?: Date } = {}): Promise<void> {
  const normalized = country.toUpperCase();
  if (isGlobalCountry(normalized)) {
    await enqueueGlobalMapsRefresh(queue, options);
    return;
  }
  await queue.enqueue(
    "refresh_country_maps",
    `maps:${normalized}`,
    { country: normalized },
    { priority: mapsPriority(options.priority, MAPS_REFRESH_PRIORITY), replaceDone: options.replaceDone ?? true, runAfter: options.runAfter },
  );
}

// The compatibility GLOBAL snapshot (popular/favourites/random stamps) is
// rebuilt by merging country snapshots, so it keeps its own job type. Farmed
// data is maintained separately per changed map. The job still shares the
// `maps:GLOBAL` dedupe key so hasActiveMapsRefresh(db, "GLOBAL") works.
export async function enqueueGlobalMapsRefresh(
  queue: JobQueue,
  options: { priority?: number; replaceDone?: boolean; runAfter?: Date; debounce?: boolean } = {},
): Promise<void> {
  await queue.enqueue(
    "refresh_global_maps",
    `maps:${GLOBAL_COUNTRY_CODE}`,
    {},
    {
      priority: mapsPriority(options.priority, MAPS_REFRESH_PRIORITY),
      replaceDone: options.replaceDone ?? true,
      runAfter: options.runAfter,
      debounce: options.debounce,
    },
  );
}

export function globalMapsRefreshRunAfter(now = Date.now()): Date {
  return new Date(now + GLOBAL_MAPS_REFRESH_DEBOUNCE_MS);
}

// Kept as an API alias for maintenance scripts and older tests. The debounce
// now covers the remaining non-farmed GLOBAL sections; farmed writes no longer
// enqueue a GLOBAL rebuild at all.
export const globalMapsFarmedRefreshRunAfter = globalMapsRefreshRunAfter;

export async function enqueueGlobalMapsRefreshIfDue(
  db: Db,
  queue: JobQueue,
  maxAgeMs: number,
  options: { priority?: number; replaceDone?: boolean } = {},
): Promise<boolean> {
  const meta = await getMapsSnapshotMeta(db, GLOBAL_COUNTRY_CODE);
  const projectionReady = (await readGlobalMapsFarmedProjectionState(db))?.initialized === true;
  const refreshedMs = meta.refreshedAt ? new Date(meta.refreshedAt).getTime() : 0;
  const isBehindSource = isIsoAfter(meta.sourceRefreshedAt, meta.refreshedAt);
  const isPastMaxAge = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs;
  const isStale = !projectionReady || isPastMaxAge || isBehindSource;
  if (!isStale) return false;
  if (await hasActiveMapsRefresh(db, GLOBAL_COUNTRY_CODE)) return true;
  await enqueueGlobalMapsRefresh(queue, {
    ...options,
    // A burst of country snapshot writes should produce one compatibility
    // rebuild after the burst. A genuinely old/missing snapshot still starts
    // immediately so cold GLOBAL pages do not wait ten extra minutes.
    ...(projectionReady && isBehindSource && !isPastMaxAge
      ? { runAfter: globalMapsRefreshRunAfter(), debounce: true }
      : {}),
  });
  return true;
}

export async function maybeEnqueueMapsFarmedRefresh(
  db: Db,
  queue: JobQueue,
  country: string,
  score: OscScore,
  marginPp: number,
): Promise<void> {
  if (!isPotentialFarmedScore(score)) return;
  // The maps-farmed board is a ranking surface: only ranked roster members contribute to it.
  if (!await isRankedRosterMember(db, country, score.user_id)) return;
  const row = (await exec(
    db,
    "select maps_farmed_min_pp, top_play_min_pp from users where user_id = ?",
    [score.user_id],
  )).rows[0];
  const thresholdSource = row?.maps_farmed_min_pp ?? row?.top_play_min_pp ?? 0;
  const threshold = Math.max(0, Number(thresholdSource ?? 0) - marginPp);
  if ((score.pp ?? 0) < threshold) return;

  const normalized = country.toUpperCase();
  const scoreKey = getMapsFarmedScoreDedupeKey(score);
  await queue.enqueue(
    "refresh_user_maps_farmed_scores",
    `maps-farmed:${normalized}:${score.user_id}`,
    { country: normalized, userId: score.user_id, scoreId: scoreKey },
    { priority: MAPS_FARMED_REFRESH_PRIORITY, replaceDone: true },
  );
}

function mapsPriority(priority: number | undefined, fallback: number): number {
  return Math.min(priority ?? fallback, fallback);
}

export async function enqueueMapsRefreshIfDue(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
  options: { priority?: number; replaceDone?: boolean } = {},
): Promise<boolean> {
  const normalized = country.toUpperCase();
  const snapshot = await readMapsSnapshot(db, normalized, maxAgeMs);
  if (!snapshot.isStale) return false;
  if (await hasActiveMapsRefresh(db, normalized)) return true;
  await enqueueMapsRefresh(queue, normalized, options);
  return true;
}

export type MapsBrowseTab = "farmed" | "popular" | "favourites";
export type MapsKeyFilter = "all" | "4k" | "7k" | "other";
export type MapsBeatmapSort = "players" | "plays" | "stars" | "length";
export type MapsFarmedSort = "players" | "avg-pp" | "max-pp" | "stars" | "recent";
export type MapsSortDirection = "desc" | "asc";
export type MapsStatusFilter = "all" | "ranked" | "loved" | "graveyard" | "other";
export type MapsModFilter = "all" | "dt" | "ht" | "nm";

export interface MapsPageQuery {
  tab: MapsBrowseTab;
  page: number;
  pageSize: number;
  key: MapsKeyFilter;
  beatmapSort: MapsBeatmapSort;
  farmedSort: MapsFarmedSort;
  dir: MapsSortDirection;
  status: MapsStatusFilter;
  pp: number;
  mod: MapsModFilter;
  q: string;
}

export interface MapsPageValue {
  tab: MapsBrowseTab;
  page: number;
  pageSize: number;
  total: number;
  items: Array<MapsFarmedEntry | MapsAggregatedBeatmap | MapsAggregatedFavourite>;
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
}

export type MapsPlayersKind = "farmed" | "popular" | "favourite";

export interface MapsDetailsPlayer {
  id: number;
  username: string;
  avatarUrl: string;
  // 1-based position on the full ordered board (pp for farmed, count for
  // popular), independent of any search filter. Set when the page is served so
  // a searched-for player shows their true standing, not 1..n within matches.
  rank?: number;
  pp?: number;
  count?: number;
  mods?: string[];
  scoreUrl?: string | null;
  playedAt?: string | null;
}

export interface MapsPlayersValue {
  kind: MapsPlayersKind;
  id: number;
  total: number;
  matched: number;
  page: number;
  pageSize: number;
  players: MapsDetailsPlayer[];
}

export interface MapsPlayersPageQuery {
  page: number;
  pageSize: number;
  q: string;
}

export const MAPS_PLAYERS_MAX_PAGE_SIZE = 50;
const MAPS_PAGE_PREVIEW_PLAYERS = 4;

export async function getMapsSnapshot(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
): Promise<MapsSnapshotResponse<CountryMapsData>> {
  const normalized = country.toUpperCase();
  const snapshot = await readMapsSnapshot(db, normalized, maxAgeMs);
  const value = snapshot.value && !isGlobalCountry(normalized)
    ? await applyMapsFarmedOverlay(db, normalized, snapshot.value, snapshot.refreshedAt)
    : snapshot.value;
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (snapshot.isStale && !refreshQueued) {
    await enqueueMapsRefresh(queue, normalized);
    refreshQueued = true;
  }
  const progress = refreshQueued ? await readActiveMapsRefreshProgress(db, normalized) : null;
  return {
    ...snapshot,
    value: value ? { ...value, beatmapsetsPool: {} } : value,
    refreshQueued,
    progress,
  };
}

export async function getMapsPageSnapshot(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
  query: MapsPageQuery,
): Promise<MapsSnapshotResponse<MapsPageValue>> {
  const normalized = country.toUpperCase();
  if (isGlobalCountry(normalized) && query.tab === "farmed") {
    const projectionState = await readGlobalMapsFarmedProjectionState(db);
    if (projectionState?.initialized) {
      return getGlobalFarmedProjectionPageSnapshot(db, queue, normalized, maxAgeMs, query, projectionState);
    }
    await enqueueGlobalMapsRefreshIfDue(db, queue, maxAgeMs);
  }
  // Filtered GLOBAL farmed requests are answered from the packed board; when
  // it is current for the snapshot row's generation, skip readRawMapsSnapshot
  // entirely — its multi-MB GLOBAL payload_json parse would be pure overhead
  // (the board carries everything the page needs, stamps included).
  if (isGlobalCountry(normalized) && query.tab === "farmed" && (query.pp > 0 || query.mod !== "all")) {
    const lean = await getGlobalFarmedBoardPageSnapshot(db, queue, normalized, maxAgeMs, query);
    if (lean) return lean;
  }
  const snapshot = await readRawMapsSnapshot(db, normalized, maxAgeMs);
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (snapshot.isStale && !refreshQueued) {
    await enqueueMapsRefresh(queue, normalized);
    refreshQueued = true;
  }

  const value = snapshot.parsed
    ? await hydrateMapsPageValue(db, normalized, snapshot.parsed, query, snapshot.refreshedAt)
    : null;

  return {
    value,
    generatedAt: snapshot.generatedAt,
    refreshedAt: snapshot.refreshedAt,
    isStale: snapshot.isStale,
    refreshQueued,
    progress: refreshQueued ? await readActiveMapsRefreshProgress(db, normalized) : null,
  };
}

export async function getMapsRefreshProgress(
  db: Db,
  country: string,
): Promise<{ progress: MapsRefreshProgress | null }> {
  return { progress: await readActiveMapsRefreshProgress(db, country.toUpperCase()) };
}

export async function getMapsPlayersSnapshot(
  db: Db,
  country: string,
  kind: MapsPlayersKind,
  id: number,
  query: MapsPlayersPageQuery = { page: 0, pageSize: MAPS_PLAYERS_MAX_PAGE_SIZE, q: "" },
): Promise<MapsPlayersValue> {
  const normalized = country.toUpperCase();
  const safeId = Number.isSafeInteger(id) && id > 0 ? id : 0;
  const page = Math.max(0, Math.floor(query.page) || 0);
  const pageSize = Math.max(1, Math.min(MAPS_PLAYERS_MAX_PAGE_SIZE, Math.floor(query.pageSize) || MAPS_PLAYERS_MAX_PAGE_SIZE));
  if (safeId === 0) return { kind, id: safeId, total: 0, matched: 0, page, pageSize, players: [] };

  const q = query.q.trim().toLowerCase();
  const { total, matched, players } = await readMapsDetailsPlayersPage(db, normalized, kind, safeId, q, page, pageSize);
  return { kind, id: safeId, total, matched, page, pageSize, players };
}

// The per-map player board is paged straight out of the normalized tables the
// snapshots themselves are built from (farmed score rows, most-played rows,
// favourite sets), so serving a modal never touches country_maps_snapshots.
// Aggregation per kind: farmed keeps the best-pp row per user, popular sums
// play counts per user, favourite keeps distinct users; GLOBAL folds every
// non-GLOBAL country. Rank is a window over the full ordered board computed
// before the username filter, so a searched player keeps their true standing.
//
// Popular/favourite rows join the roster with the same condition snapshot
// builds use (tracked, currently ranked), because those tables retain rows
// for members who have since been soft-untracked. Farmed deliberately does
// not: the farmed modal always merged the raw score rows in unfiltered, so a
// former member's best score stays on the board.
function mapsDetailsBoardSql(kind: MapsPlayersKind, global: boolean): string {
  const scope = global ? "!=" : "=";
  // Roster status is checked against the row's own country, so a GLOBAL board
  // only counts a user's rows from countries currently tracking them.
  const rosterJoin = (alias: string): string =>
    `join country_rosters r on r.country = ${alias}.country and r.user_id = ${alias}.user_id and r.is_tracked = 1 and r.rank is not null`;
  // The display username (with the same `User <id>` fallback the client
  // renders) is resolved in SQL so the search filter and the favourite
  // ordering both see exactly what the modal shows.
  const username = "coalesce(nullif(u.username, ''), 'User ' || b.id)";
  if (kind === "farmed") {
    return `with best as (
        select id, pp, mods_json, score_url, played_at from (
          select s.user_id as id, s.pp, s.mods_json, s.score_url, s.played_at,
                 row_number() over (partition by s.user_id order by s.pp desc, s.detected_at desc, s.country asc) as rn
          from country_maps_farmed_scores s
          where s.country ${scope} ? and s.beatmap_id = ? and s.user_id > 0 and s.pp > 0
        ) where rn = 1
      ),
      board as (
        select b.id, ${username} as username, coalesce(u.avatar_url, '') as avatar_url,
               b.pp, b.mods_json, b.score_url, b.played_at,
               row_number() over (order by b.pp desc, b.id asc) as rank
        from best b left join users u on u.user_id = b.id
      )`;
  }
  if (kind === "popular") {
    return `with agg as (
        select mp.user_id as id, sum(mp.play_count) as cnt
        from country_maps_most_played mp
        ${rosterJoin("mp")}
        where mp.country ${scope} ? and mp.beatmap_id = ? and mp.user_id > 0 and mp.play_count > 0
        group by mp.user_id
      ),
      board as (
        select b.id, ${username} as username, coalesce(u.avatar_url, '') as avatar_url, b.cnt,
               row_number() over (order by b.cnt desc, b.id asc) as rank
        from agg b left join users u on u.user_id = b.id
      )`;
  }
  return `with agg as (
      select distinct f.user_id as id
      from country_maps_favourite_sets f
      ${rosterJoin("f")}
      where f.country ${scope} ? and f.beatmapset_id = ? and f.user_id > 0
    ),
    board as (
      select b.id, ${username} as username, coalesce(u.avatar_url, '') as avatar_url,
             row_number() over (order by ${username} collate nocase asc, b.id asc) as rank
      from agg b left join users u on u.user_id = b.id
    )`;
}

async function readMapsDetailsPlayersPage(
  db: Db,
  country: string,
  kind: MapsPlayersKind,
  id: number,
  q: string,
  page: number,
  pageSize: number,
): Promise<{ total: number; matched: number; players: MapsDetailsPlayer[] }> {
  const global = isGlobalCountry(country);
  const boardSql = mapsDetailsBoardSql(kind, global);
  const boardArgs = [global ? GLOBAL_COUNTRY_CODE : country, id];

  // Counts and page run in one read transaction so they see the same board.
  // Across page requests the board is only eventually consistent: a write
  // between pages can shift offsets (the client dedupes repeats), the same
  // exposure the old 60-second assembled-board cache had once it expired.
  const [countsResult, pageResult] = await execBatch(db, [
    {
      sql: `${boardSql}
        select count(*) as total,
               coalesce(sum(case when ? = '' or instr(lower(username), ?) > 0 then 1 else 0 end), 0) as matched
        from board`,
      args: [...boardArgs, q, q],
    },
    {
      sql: `${boardSql}
        select * from board
        where ? = '' or instr(lower(username), ?) > 0
        order by rank asc
        limit ? offset ?`,
      args: [...boardArgs, q, q, pageSize, page * pageSize],
    },
  ], "read");
  const counts = countsResult.rows[0];
  const rows = pageResult.rows;

  const players = rows.map((row): MapsDetailsPlayer => {
    const player: MapsDetailsPlayer = {
      id: Number(row.id),
      username: String(row.username ?? ""),
      avatarUrl: String(row.avatar_url ?? ""),
      rank: Number(row.rank),
    };
    if (kind === "farmed") {
      player.pp = Number(row.pp ?? 0);
      player.mods = parseJson<string[]>(row.mods_json, []);
      player.scoreUrl = row.score_url == null ? null : String(row.score_url);
      player.playedAt = row.played_at == null ? null : String(row.played_at);
    }
    if (kind === "popular") player.count = Number(row.cnt ?? 0);
    return player;
  });

  return {
    total: Number(counts?.total ?? 0),
    matched: Number(counts?.matched ?? 0),
    players,
  };
}

/**
 * Timestamp-only read of a country's maps snapshot row — no payload_json parse
 * or user hydration. The HTTP layer uses refreshedAt to key its response cache
 * so a cache hit can skip the (expensive) getMapsPageSnapshot() path entirely.
 */
export async function getMapsSnapshotMeta(
  db: Db,
  country: string,
): Promise<{ generatedAt: string | null; refreshedAt: string | null; sourceRefreshedAt: string | null; farmedOverlayUpdatedAt: string | null }> {
  const normalized = country.toUpperCase();
  const row = (await exec(
    db,
    "select generated_at, refreshed_at from country_maps_snapshots where country = ?",
    [normalized],
  )).rows[0];
  const sourceRefreshedAt = isGlobalCountry(normalized)
    ? await readLatestCountryMapsSourceRefreshedAt(db)
    : null;
  const projectionState = isGlobalCountry(normalized)
    ? await readGlobalMapsFarmedProjectionState(db)
    : null;
  const farmedOverlayUpdatedAt = isGlobalCountry(normalized)
    ? projectionState?.initialized
      ? projectionState.updatedAt
      : await readGlobalMapsFarmedOverlayUpdatedAt(db)
    : await readMapsFarmedOverlayUpdatedAt(db, normalized);
  return {
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt: row?.refreshed_at == null ? null : String(row.refreshed_at),
    sourceRefreshedAt,
    farmedOverlayUpdatedAt,
  };
}

async function readMapsSnapshot(
  db: Db,
  country: string,
  maxAgeMs: number,
): Promise<{ value: CountryMapsData | null; generatedAt: string | null; refreshedAt: string | null; isStale: boolean }> {
  const normalized = country.toUpperCase();
  const row = (await exec(db, "select payload_json, generated_at, refreshed_at from country_maps_snapshots where country = ?", [normalized])).rows[0];
  const refreshedAt = row?.refreshed_at == null ? null : String(row.refreshed_at);
  const refreshedMs = refreshedAt ? new Date(refreshedAt).getTime() : 0;
  const parsed = row ? parseJson<unknown>(row.payload_json, null) : null;
  const value = parsed ? await hydrateStoredMapsSnapshot(db, parsed) : null;
  const isUsable = isUsableMapsData(value) || (
    value != null &&
    isGlobalCountry(normalized) &&
    (await readGlobalMapsFarmedProjectionState(db))?.initialized === true
  );
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || (!!row && !isUsable);
  return {
    value,
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt,
    isStale,
  };
}

function isMapsSnapshotPastMaxAge(refreshedAt: string | null, maxAgeMs: number): boolean {
  const refreshedMs = refreshedAt ? new Date(refreshedAt).getTime() : 0;
  return !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs;
}

async function readRawMapsSnapshot(
  db: Db,
  country: string,
  maxAgeMs: number,
): Promise<{ parsed: StoredCountryMapsData | CountryMapsData | null; generatedAt: string | null; refreshedAt: string | null; isStale: boolean }> {
  const normalized = country.toUpperCase();
  const row = (await exec(
    db,
    "select payload_json, generated_at, refreshed_at from country_maps_snapshots where country = ?",
    [normalized],
  )).rows[0];
  const refreshedAt = row?.refreshed_at == null ? null : String(row.refreshed_at);
  const parsed = row ? parseJson<unknown>(row.payload_json, null) : null;
  let usable = isStoredCountryMapsData(parsed)
    ? isUsableStoredMapsData(parsed)
    : isCountryMapsDataShape(parsed) && isUsableMapsData(parsed);
  if (
    !usable &&
    (isStoredCountryMapsData(parsed) || isCountryMapsDataShape(parsed)) &&
    isGlobalCountry(normalized)
  ) {
    usable = (await readGlobalMapsFarmedProjectionState(db))?.initialized === true;
  }
  const globalStale = isGlobalCountry(normalized)
    ? await isGlobalMapsSnapshotBehindSources(db, refreshedAt)
    : false;
  const isStale = isMapsSnapshotPastMaxAge(refreshedAt, maxAgeMs) || (!!row && !usable) || globalStale;
  return {
    parsed: usable && (isStoredCountryMapsData(parsed) || isCountryMapsDataShape(parsed)) ? parsed : null,
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt,
    isStale,
  };
}

async function hydrateStoredMapsSnapshot(db: Db, parsed: unknown): Promise<CountryMapsData | null> {
  if (isStoredCountryMapsData(parsed)) {
    return hydrateCompactMapsSnapshot(db, parsed);
  }
  if (!isCountryMapsDataShape(parsed)) return null;
  return hydrateMapsSnapshotUsers(db, parsed);
}

function isCountryMapsDataShape(value: unknown): value is CountryMapsData {
  const candidate = value as Partial<CountryMapsData> | null;
  return !!candidate
    && Array.isArray(candidate.farmed)
    && Array.isArray(candidate.mostPlayed)
    && Array.isArray(candidate.favourites)
    && Array.isArray(candidate.favouritesByPlayer)
    && typeof candidate.beatmapsetsPool === "object"
    && candidate.beatmapsetsPool != null
    && typeof candidate.generatedAt === "string"
    && typeof candidate.farmedGeneratedAt === "string"
    && typeof candidate.favouritesGeneratedAt === "string";
}

function isStoredCountryMapsData(value: unknown): value is StoredCountryMapsData {
  const candidate = value as Partial<StoredCountryMapsData> | null;
  return !!candidate
    && candidate.schemaVersion === 2
    && Array.isArray(candidate.farmed)
    && Array.isArray(candidate.mostPlayed)
    && Array.isArray(candidate.favourites)
    && Array.isArray(candidate.favouritesByPlayer)
    && Array.isArray(candidate.beatmapsetsPool);
}

async function hydrateMapsSnapshotUsers(db: Db, value: CountryMapsData): Promise<CountryMapsData> {
  const ids = [...collectMapsSnapshotUserIds(value)];
  if (ids.length === 0) return value;
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await exec(
    db,
    `select user_id, username, avatar_url from users where user_id in (${placeholders})`,
    ids,
  )).rows;
  const usersById = new Map(
    rows.map((row) => [
      Number(row.user_id),
      {
        username: String(row.username ?? ""),
        avatarUrl: String(row.avatar_url ?? ""),
      },
    ]),
  );
  const applyUser = (player: { id: number; username: string; avatarUrl: string }) => {
    const user = usersById.get(player.id);
    if (!user) return;
    if (user.username) player.username = user.username;
    if (user.avatarUrl) player.avatarUrl = user.avatarUrl;
  };

  for (const entry of value.farmed) entry.players.forEach(applyUser);
  for (const entry of value.mostPlayed) entry.players.forEach(applyUser);
  for (const entry of value.favourites) entry.players.forEach(applyUser);
  value.favouritesByPlayer.forEach(applyUser);
  return value;
}

function collectMapsSnapshotUserIds(value: CountryMapsData): Set<number> {
  const ids = new Set<number>();
  const add = (player: { id: number }) => {
    if (Number.isSafeInteger(player.id) && player.id > 0) ids.add(player.id);
  };
  for (const entry of value.farmed) entry.players.forEach(add);
  for (const entry of value.mostPlayed) entry.players.forEach(add);
  for (const entry of value.favourites) entry.players.forEach(add);
  value.favouritesByPlayer.forEach(add);
  return ids;
}

function compactMapsSnapshotForStorage(value: CountryMapsData): StoredCountryMapsData {
  return {
    schemaVersion: 2,
    farmed: value.farmed.map((entry) => ({
      beatmapId: entry.beatmapId,
      playerCount: entry.playerCount,
      avgPp: entry.avgPp,
      maxPp: entry.maxPp,
      // Computed over the full roster (per-country snapshots are not truncated)
      // so the dominant mod reflects everyone who farmed the map, not a sample.
      dominantMod: getDominantMapsSpeedMod(entry.players),
      players: entry.players.map((player) => ({
        id: player.id,
        mods: player.mods,
        pp: player.pp,
        scoreUrl: player.scoreUrl,
        playedAt: player.playedAt,
      })),
    })),
    mostPlayed: value.mostPlayed.map((entry) => ({
      beatmapId: entry.beatmapId,
      totalPlays: entry.totalPlays,
      playerCount: entry.playerCount,
      players: entry.players.map((player) => ({ id: player.id, count: player.count })),
    })),
    favourites: value.favourites.map((entry) => ({
      beatmapsetId: entry.beatmapsetId,
      playerCount: entry.playerCount,
      players: entry.players.map((player) => ({ id: player.id })),
    })),
    favouritesByPlayer: value.favouritesByPlayer.map((player) => ({
      id: player.id,
      beatmapsetIds: player.beatmapsetIds,
    })),
    beatmapsetsPool: Object.keys(value.beatmapsetsPool).map(Number).filter((id) => Number.isFinite(id) && id > 0),
    generatedAt: value.generatedAt,
    farmedGeneratedAt: value.farmedGeneratedAt,
    favouritesGeneratedAt: value.favouritesGeneratedAt,
  };
}

async function hydrateCompactMapsSnapshot(db: Db, value: StoredCountryMapsData): Promise<CountryMapsData> {
  const directBeatmapIds = new Set<number>();
  const beatmapsetIds = new Set<number>(value.beatmapsetsPool);
  for (const entry of value.farmed) directBeatmapIds.add(entry.beatmapId);
  for (const entry of value.mostPlayed) directBeatmapIds.add(entry.beatmapId);
  for (const entry of value.favourites) beatmapsetIds.add(entry.beatmapsetId);

  const directBeatmaps = await readMapsBeatmapsByIds(db, [...directBeatmapIds]);
  for (const beatmap of directBeatmaps.values()) beatmapsetIds.add(beatmap.beatmapsetId);
  const poolBeatmaps = await readMapsBeatmapsByBeatmapsetIds(db, [...value.beatmapsetsPool]);
  const allBeatmaps = new Map(directBeatmaps);
  for (const beatmap of poolBeatmaps) allBeatmaps.set(beatmap.beatmapId, beatmap);
  const beatmapsets = await readMapsBeatmapsetsByIds(db, [...beatmapsetIds]);

  const farmed = value.farmed.flatMap((entry): MapsFarmedEntry[] => {
    const beatmap = allBeatmaps.get(entry.beatmapId);
    const beatmapset = beatmap ? beatmapsets.get(beatmap.beatmapsetId) : undefined;
    if (!isNativeManiaMapsBeatmap(beatmap) || !beatmapset) return [];
    return [{
      beatmapId: entry.beatmapId,
      version: beatmap.version,
      difficultyRating: beatmap.difficultyRating,
      totalLength: beatmap.totalLength,
      cs: beatmap.cs,
      bpm: beatmap.bpm,
      beatmapsetId: beatmap.beatmapsetId,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      covers: beatmapset.covers,
      status: beatmapset.status || beatmap.status,
      playerCount: entry.playerCount,
      players: entry.players.map((player) => ({
        id: player.id,
        username: "",
        avatarUrl: "",
        mods: player.mods,
        pp: player.pp,
        scoreUrl: player.scoreUrl,
        playedAt: player.playedAt,
      })),
      avgPp: entry.avgPp,
      maxPp: entry.maxPp,
      dominantMod: entry.dominantMod,
    }];
  });

  const mostPlayed = value.mostPlayed.flatMap((entry): MapsAggregatedBeatmap[] => {
    const beatmap = allBeatmaps.get(entry.beatmapId);
    const beatmapset = beatmap ? beatmapsets.get(beatmap.beatmapsetId) : undefined;
    if (!isNativeManiaMapsBeatmap(beatmap) || !beatmapset) return [];
    return [{
      beatmapId: entry.beatmapId,
      version: beatmap.version,
      difficultyRating: beatmap.difficultyRating,
      totalLength: beatmap.totalLength,
      beatmapsetId: beatmap.beatmapsetId,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      covers: beatmapset.covers,
      status: beatmapset.status || beatmap.status,
      globalPlayCount: beatmapset.globalPlayCount,
      totalPlays: entry.totalPlays,
      playerCount: entry.playerCount,
      players: entry.players.map((player) => ({ id: player.id, username: "", avatarUrl: "", count: player.count })),
    }];
  });

  const favourites = value.favourites.flatMap((entry): MapsAggregatedFavourite[] => {
    const beatmapset = beatmapsets.get(entry.beatmapsetId);
    if (!beatmapset) return [];
    return [{
      beatmapsetId: entry.beatmapsetId,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      covers: beatmapset.covers,
      status: beatmapset.status,
      globalPlayCount: beatmapset.globalPlayCount,
      globalFavouriteCount: beatmapset.globalFavouriteCount,
      playerCount: entry.playerCount,
      players: entry.players.map((player) => ({ id: player.id, username: "", avatarUrl: "" })),
    }];
  });

  const poolBeatmapsBySet = new Map<number, MapsBeatmapMetadata[]>();
  for (const beatmap of poolBeatmaps) {
    if (!isNativeManiaMapsBeatmap(beatmap)) continue;
    const current = poolBeatmapsBySet.get(beatmap.beatmapsetId) ?? [];
    current.push(beatmap);
    poolBeatmapsBySet.set(beatmap.beatmapsetId, current);
  }
  const beatmapsetsPool = Object.fromEntries(value.beatmapsetsPool.flatMap((id): Array<[number, MapsFavouriteBeatmapset]> => {
    const beatmapset = beatmapsets.get(id);
    const beatmaps = poolBeatmapsBySet.get(id) ?? [];
    if (!beatmapset || beatmaps.length === 0) return [];
    return [[id, buildPoolBeatmapset(id, beatmapset, beatmaps)]];
  }));

  return hydrateMapsSnapshotUsers(db, {
    farmed,
    mostPlayed,
    favourites,
    favouritesByPlayer: value.favouritesByPlayer.map((player) => ({
      id: player.id,
      username: "",
      avatarUrl: "",
      beatmapsetIds: player.beatmapsetIds,
    })),
    beatmapsetsPool,
    generatedAt: value.generatedAt,
    farmedGeneratedAt: value.farmedGeneratedAt,
    favouritesGeneratedAt: value.favouritesGeneratedAt,
  });
}

function isUsableStoredMapsData(value: StoredCountryMapsData): boolean {
  return (
    value.farmed.length > 0 ||
    value.mostPlayed.length > 0 ||
    value.favourites.length > 0 ||
    value.favouritesByPlayer.length > 0 ||
    value.beatmapsetsPool.length > 0
  );
}

// The Random card only renders osu!'s `list`/`card` thumbnail and the `cover`
// hero, so the per-set payload drops the other five cover variants.
const MAPS_RANDOM_COVER_VARIANTS = ["cover", "card", "list"] as const;
function trimMapsCovers(covers: Record<string, string | undefined>): Record<string, string | undefined> {
  const trimmed: Record<string, string | undefined> = {};
  for (const variant of MAPS_RANDOM_COVER_VARIANTS) {
    if (covers[variant]) trimmed[variant] = covers[variant];
  }
  return trimmed;
}

// Builds the full Random-pool entry for a beatmapset (per-difficulty list, key
// counts, star range). Shared by the snapshot hydrate path and the on-demand
// per-set endpoint; the latter passes trimCovers so only the used art ships.
function buildPoolBeatmapset(
  id: number,
  beatmapset: MapsBeatmapsetMetadata,
  poolBeatmaps: MapsBeatmapMetadata[],
  options: { trimCovers?: boolean } = {},
): MapsFavouriteBeatmapset {
  const maniaBeatmaps = poolBeatmaps
    .filter(isNativeManiaMapsBeatmap)
    .map((beatmap) => ({
      id: beatmap.beatmapId,
      version: beatmap.version,
      difficultyRating: beatmap.difficultyRating,
      totalLength: beatmap.totalLength,
      cs: beatmap.cs,
    }))
    .sort((a, b) => b.difficultyRating - a.difficultyRating);
  const stars = maniaBeatmaps.map((beatmap) => beatmap.difficultyRating).filter((star) => Number.isFinite(star));
  const maniaKeys = beatmapset.maniaKeys.length > 0
    ? beatmapset.maniaKeys
    : [...new Set(maniaBeatmaps.map((beatmap) => beatmap.cs).filter((key) => Number.isFinite(key)))].sort((a, b) => a - b);
  return {
    id,
    title: beatmapset.title,
    artist: beatmapset.artist,
    creator: beatmapset.creator,
    covers: options.trimCovers ? trimMapsCovers(beatmapset.covers) : beatmapset.covers,
    status: beatmapset.status,
    globalPlayCount: beatmapset.globalPlayCount,
    globalFavouriteCount: beatmapset.globalFavouriteCount,
    previewUrl: beatmapset.previewUrl,
    maniaKeys,
    maniaBeatmaps,
    starMin: stars.length ? Math.min(...stars) : 0,
    starMax: stars.length ? Math.max(...stars) : 0,
    bpm: beatmapset.bpm,
    patterns: beatmapset.patterns,
  };
}

export const MAPS_RANDOM_SET_MAX_IDS = 24;

// On-demand hydration for the Random tab: the pool snapshot ships lean entries
// (no covers / per-difficulty list / preview audio), and the client fetches the
// full record only for the set it lands on (plus a small prefetch batch).
export async function getMapsRandomBeatmapsets(db: Db, ids: number[]): Promise<MapsFavouriteBeatmapset[]> {
  const cleanIds = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, MAPS_RANDOM_SET_MAX_IDS);
  if (cleanIds.length === 0) return [];
  const beatmapsets = await readMapsBeatmapsetsByIds(db, cleanIds);
  const poolBeatmaps = await readMapsBeatmapsByBeatmapsetIds(db, cleanIds);
  const beatmapsBySet = new Map<number, MapsBeatmapMetadata[]>();
  for (const beatmap of poolBeatmaps) {
    const list = beatmapsBySet.get(beatmap.beatmapsetId) ?? [];
    list.push(beatmap);
    beatmapsBySet.set(beatmap.beatmapsetId, list);
  }
  return cleanIds.flatMap((id) => {
    const beatmapset = beatmapsets.get(id);
    const beatmaps = beatmapsBySet.get(id) ?? [];
    return beatmapset && beatmaps.length > 0 ? [buildPoolBeatmapset(id, beatmapset, beatmaps, { trimCovers: true })] : [];
  });
}

// ---------------------------------------------------------------------------
// Random draw
//
// The Random tab used to download every (player, favourite set) pair in scope
// and weight the pick in the browser — 13 MiB on the wire and ~40 MB of
// retained browser heap at GLOBAL scope. The draw now runs here: the filters
// travel with the request, SQLite samples the eligible pairs, and only the
// handful of drawn picks is hydrated. Like the per-map player boards, the
// eligible set is rebuilt from the normalized tables, so a draw never parses
// country_maps_snapshots.payload_json (67 MB at GLOBAL scope).

export type MapsRandomDrawWeight = "favourites" | "players";

// Filter vocabularies the HTTP parser validates against. They have to agree
// with the bucket CASE expressions below, so they live next to them.
export const MAPS_RANDOM_STATUS_BUCKETS = ["ranked", "loved", "graveyard", "other"];
export const MAPS_RANDOM_KEY_BUCKETS = ["4k", "7k", "other"];
// Canonical pattern names, as chart analysis writes them into patterns_json.
// The client expands its umbrella chips (Jack -> jack/chordjack/longjack/...)
// before sending them, so the server matches names verbatim and never expands.
export const MAPS_RANDOM_PATTERN_NAMES = [
  "bracket",
  "chordjack",
  "chordstream",
  "dumpstream",
  "handstream",
  "jack",
  "jumpstream",
  "ln",
  "longjack",
  "minijack",
  "rice",
  "speed",
  "speedjack",
  "stamina",
  "stream",
  "sv",
  "tech",
  "tiebreaker",
];

export const MAPS_RANDOM_DRAW_DEFAULT_COUNT = 8;
// A batch is hydrated through getMapsRandomBeatmapsets, which drops ids past
// its own cap — so a batch may never ask for more distinct sets than that.
export const MAPS_RANDOM_DRAW_MAX_COUNT = MAPS_RANDOM_SET_MAX_IDS;
export const MAPS_RANDOM_DRAW_EXCLUDE_USERS_MAX = 8;
export const MAPS_RANDOM_DRAW_EXCLUDE_SETS_MAX = 16;
export const MAPS_RANDOM_DRAW_HIDE_USERS_MAX = 100;
export const MAPS_RANDOM_DRAW_STAR_MAX = 20;

export interface MapsRandomDrawQuery {
  weight: MapsRandomDrawWeight;
  // 0 asks for the counts only: the header's "N possible picks" has to follow
  // a filter change without spending a draw.
  count: number;
  status: string[];
  statusExclude: string[];
  keys: string[];
  keysExclude: string[];
  patterns: string[];
  patternsExclude: string[];
  starMin: number;
  starMax: number;
  excludeUsers: number[];
  excludeSets: number[];
  hideUsers: number[];
  // When set, the batch is drawn from a stable hash of the pair instead of
  // random(), so the same seed over the same pool always yields the same picks.
  // The cached /discord showcase preview needs that: it is rebuilt on a timer
  // and a fresh roll every rebuild would make the page flicker.
  seed?: string;
}

// Every draw filter has an off value, and callers outside the HTTP parser only
// ever set two or three of them.
export function mapsRandomDrawQuery(overrides: Partial<MapsRandomDrawQuery> = {}): MapsRandomDrawQuery {
  return {
    weight: "favourites",
    count: MAPS_RANDOM_DRAW_DEFAULT_COUNT,
    status: [],
    statusExclude: [],
    keys: [],
    keysExclude: [],
    patterns: [],
    patternsExclude: [],
    starMin: 0,
    starMax: 0,
    excludeUsers: [],
    excludeSets: [],
    hideUsers: [],
    ...overrides,
  };
}

export interface MapsRandomDrawPick {
  player: {
    id: number;
    username: string;
    avatarUrl: string;
    // The player's in-scope favourite total, unfiltered by the draw filters —
    // it renders the "N favourites" label and is not derivable from the pick.
    favouriteCount: number;
  };
  beatmapset: MapsFavouriteBeatmapset;
  // Distinct in-scope players who favourited this set, again unfiltered by the
  // draw filters. Feeds Discord's "and N others".
  scopeFavCount: number;
}

export interface MapsRandomDrawValue {
  country: string;
  weight: MapsRandomDrawWeight;
  // Eligible (player, set) pairs and distinct sets after the filters, ignoring
  // the recency exclusions (see mapsRandomEligibleSql).
  totalPicks: number;
  uniqueSets: number;
  picks: MapsRandomDrawPick[];
  generatedAt: string | null;
  favouritesGeneratedAt: string | null;
}

// Mirrors the client's mapStatusBucket: osu! "approved" reads as ranked.
const MAPS_RANDOM_STATUS_BUCKET_SQL = `case
      when lower(coalesce(bs.status, '')) in ('ranked', 'approved') then 'ranked'
      when lower(coalesce(bs.status, '')) = 'loved' then 'loved'
      when lower(coalesce(bs.status, '')) = 'graveyard' then 'graveyard'
      else 'other' end`;
// Mirrors the client's mapKeyBucket: an exact 4/7 key count, everything else
// (including 4.x from a rate-changed diff) lands in "other".
const MAPS_RANDOM_KEY_BUCKET_SQL = "case when k.value = 4 then '4k' when k.value = 7 then '7k' else 'other' end";

function sqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

// FNV-1a, the same 32-bit hash the Discord showcase uses to vary its cached
// previews per scope. Only the mixing matters here, not the distribution.
function mapsRandomSeedValue(seed: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

// Knuth's multiplicative constant times the id, folded modulo a Mersenne prime:
// a plain sum would sort by user_id and always hand back the same player, while
// the modulus scrambles neighbouring ids apart. The prime is large enough that
// ties (which SQLite would break arbitrarily, costing determinism) are ~1e-4
// likely even on the GLOBAL pool. The widest intermediate is ~2.7e16, well
// inside SQLite's signed 64-bit integers.
const MAPS_RANDOM_SEED_MODULUS = 2147483647;
function mapsRandomSeededOrderSql(userColumn: string, setColumn: string | null): string {
  const terms = [`(${userColumn} * 2654435761)`];
  if (setColumn) terms.push(`(${setColumn} * 40503)`);
  return `((${terms.join(" + ")} + ?) % ${MAPS_RANDOM_SEED_MODULUS})`;
}

// json_each() rejects NULL and empty text, and about a third of
// maps_beatmapsets rows have never been chart-analyzed.
function mapsRandomJsonArraySql(column: string): string {
  return `json_each(coalesce(nullif(${column}, ''), '[]'))`;
}

/**
 * The CTE prefix that narrows the favourite rows to the eligible pool.
 *
 * Every CTE is AS MATERIALIZED: without it the players-weighted draw re-runs
 * the eligible scan per partition and never finishes on GLOBAL-sized data.
 * Clauses are only emitted for filters that are actually set, so an unfiltered
 * draw never touches maps_beatmapsets or maps_beatmaps at all.
 *
 * The recency exclusions deliberately live outside `elig`: "N possible picks"
 * describes the filters, so it must not flicker as the history rotates.
 */
function mapsRandomEligibleSql(
  country: string,
  query: MapsRandomDrawQuery,
): { cte: string; args: InValue[] } {
  const global = isGlobalCountry(country);
  // GLOBAL folds every country's rows, exactly like the per-map player boards.
  const scope = global ? "!=" : "=";
  const scopeArg = global ? GLOBAL_COUNTRY_CODE : country;
  const args: InValue[] = [];
  const ctes: string[] = [];

  const setClauses: string[] = [];
  if (query.status.length > 0) {
    setClauses.push(`(${MAPS_RANDOM_STATUS_BUCKET_SQL}) in (${sqlPlaceholders(query.status)})`);
    args.push(...query.status);
  }
  if (query.statusExclude.length > 0) {
    setClauses.push(`(${MAPS_RANDOM_STATUS_BUCKET_SQL}) not in (${sqlPlaceholders(query.statusExclude)})`);
    args.push(...query.statusExclude);
  }
  // A set matches an include chip when ANY of its key counts / patterns match,
  // and is dropped by an exclude chip when ANY of them match — the same
  // some()/!some() pair the client applied over the pool entry's arrays.
  if (query.keys.length > 0) {
    setClauses.push(`exists (select 1 from ${mapsRandomJsonArraySql("bs.mania_keys_json")} k where (${MAPS_RANDOM_KEY_BUCKET_SQL}) in (${sqlPlaceholders(query.keys)}))`);
    args.push(...query.keys);
  }
  if (query.keysExclude.length > 0) {
    setClauses.push(`not exists (select 1 from ${mapsRandomJsonArraySql("bs.mania_keys_json")} k where (${MAPS_RANDOM_KEY_BUCKET_SQL}) in (${sqlPlaceholders(query.keysExclude)}))`);
    args.push(...query.keysExclude);
  }
  if (query.patterns.length > 0) {
    setClauses.push(`exists (select 1 from ${mapsRandomJsonArraySql("bs.patterns_json")} p where p.value in (${sqlPlaceholders(query.patterns)}))`);
    args.push(...query.patterns);
  }
  if (query.patternsExclude.length > 0) {
    setClauses.push(`not exists (select 1 from ${mapsRandomJsonArraySql("bs.patterns_json")} p where p.value in (${sqlPlaceholders(query.patternsExclude)}))`);
    args.push(...query.patternsExclude);
  }
  const hasSetFilter = setClauses.length > 0;
  if (hasSetFilter) {
    ctes.push(`sets as materialized (
      select bs.beatmapset_id as beatmapset_id
      from maps_beatmapsets bs
      where ${setClauses.join("\n        and ")}
    )`);
  }

  const starMin = query.starMin > 0 ? query.starMin : 0;
  const starMax = query.starMax > 0 ? query.starMax : 0;
  const hasStarFilter = starMin > 0 || starMax > 0;
  if (hasStarFilter) {
    // The star aggregate is restricted to sets somebody in scope actually
    // favourited; otherwise a country draw pays for the whole maps_beatmaps
    // table (measured 224 ms -> 41 ms on the largest country).
    ctes.push(`pool as materialized (
      select distinct f.beatmapset_id as beatmapset_id
      from country_maps_favourite_sets f
      ${hasSetFilter ? "join sets s on s.beatmapset_id = f.beatmapset_id" : ""}
      where f.country ${scope} ?
    )`);
    args.push(scopeArg);
    // Range OVERLAP, matching the client: keep a set whose hardest diff clears
    // the floor and whose easiest diff stays under the ceiling. The star range
    // counts native-mania diffs only, same as the hydrated pick's starMin/Max.
    const having: string[] = [];
    if (starMin > 0) having.push("max(b.difficulty_rating) >= ?");
    if (starMax > 0) having.push("min(b.difficulty_rating) <= ?");
    ctes.push(`stars as materialized (
      select b.beatmapset_id as beatmapset_id
      from maps_beatmaps b
      join pool pl on pl.beatmapset_id = b.beatmapset_id
      left join beatmaps raw on raw.beatmap_id = b.beatmap_id
      where ${nativeManiaBeatmapSql("b")}
      group by b.beatmapset_id
      having ${having.join(" and ")}
    )`);
    if (starMin > 0) args.push(starMin);
    if (starMax > 0) args.push(starMax);
  }

  // Roster status is checked against the row's own country, exactly like the
  // per-map player boards: favourite rows survive a member being untracked or
  // dropping off the ranking, and neither may put a player on a draw.
  const eligClauses = [`f.country ${scope} ?`];
  const eligArgs: InValue[] = [scopeArg];
  if (query.hideUsers.length > 0) {
    eligClauses.push(`f.user_id not in (${sqlPlaceholders(query.hideUsers)})`);
    eligArgs.push(...query.hideUsers);
  }
  // distinct because a player tracked by two countries has one favourite row
  // per country, and a GLOBAL draw must not weight them double.
  ctes.push(`elig as materialized (
      select distinct f.user_id as user_id, f.beatmapset_id as beatmapset_id
      from country_maps_favourite_sets f
      ${hasSetFilter ? "join sets s on s.beatmapset_id = f.beatmapset_id" : ""}
      ${hasStarFilter ? "join stars st on st.beatmapset_id = f.beatmapset_id" : ""}
      join country_rosters r on r.country = f.country and r.user_id = f.user_id and r.is_tracked = 1 and r.rank is not null
      where ${eligClauses.join("\n        and ")}
    )`);
  args.push(...eligArgs);

  return { cte: `with ${ctes.join(",\n    ")}`, args };
}

/**
 * Counts and batch in ONE statement, so the eligible set is materialized once
 * and the two provably describe the same pool. Every row carries the counts
 * (uncorrelated scalar subqueries over the materialized CTE, evaluated once);
 * the left join keeps that row alive when the batch comes back empty, with
 * null ids the hydrator drops. Measured on prod-size data, folding the counts
 * in this way costs ~40 % less than running them as a second statement.
 */
function mapsRandomDrawStatement(
  country: string,
  query: MapsRandomDrawQuery,
  count: number,
  options: { applyExclusions: boolean },
): DbStatement {
  const { cte, args } = mapsRandomEligibleSql(country, query);
  const keptClauses: string[] = [];
  if (options.applyExclusions && query.excludeUsers.length > 0) {
    keptClauses.push(`user_id not in (${sqlPlaceholders(query.excludeUsers)})`);
    args.push(...query.excludeUsers);
  }
  if (options.applyExclusions && query.excludeSets.length > 0) {
    keptClauses.push(`beatmapset_id not in (${sqlPlaceholders(query.excludeSets)})`);
    args.push(...query.excludeSets);
  }
  const kept = `kept as (
      select user_id, beatmapset_id from elig${keptClauses.length > 0 ? `\n      where ${keptClauses.join(" and ")}` : ""}
    )`;
  // A seeded draw swaps random() for a hash of the pair. Its arguments are
  // pushed in textual order, since they interleave with the batch's limit.
  const seed = query.seed ? mapsRandomSeedValue(query.seed) : null;
  const picksArgs: InValue[] = [];
  let picks: string;
  if (query.weight === "players") {
    // "Equal chance per player": sample distinct players uniformly, then one
    // of that player's eligible sets uniformly.
    const userOrder = seed == null ? "random()" : mapsRandomSeededOrderSql("user_id", null);
    if (seed != null) picksArgs.push(seed);
    picksArgs.push(count);
    const pairOrder = seed == null ? "random()" : mapsRandomSeededOrderSql("k.user_id", "k.beatmapset_id");
    if (seed != null) picksArgs.push(seed);
    picks = `picked as materialized (
      select user_id from (select distinct user_id from kept) order by ${userOrder} limit ?
    ),
    picks as (
      select user_id, beatmapset_id from (
        select k.user_id as user_id, k.beatmapset_id as beatmapset_id,
               row_number() over (partition by k.user_id order by ${pairOrder}) as rn
        from kept k join picked p on p.user_id = k.user_id
      ) where rn = 1
    )`;
  } else {
    // "Equal chance per map": sample (player, set) pairs uniformly.
    const pairOrder = seed == null ? "random()" : mapsRandomSeededOrderSql("user_id", "beatmapset_id");
    if (seed != null) picksArgs.push(seed);
    picksArgs.push(count);
    picks = `picks as (
      select user_id, beatmapset_id from kept order by ${pairOrder} limit ?
    )`;
  }

  return {
    sql: `${cte},
    ${kept},
    ${picks}
    select (select count(*) from elig) as total_picks,
           (select count(distinct beatmapset_id) from elig) as unique_sets,
           p.user_id as user_id, p.beatmapset_id as beatmapset_id
    from (select 1) one left join picks p on 1 = 1`,
    args: [...args, ...picksArgs],
  };
}

/**
 * Draws a batch of Random-tab picks plus the eligible-pool counts.
 *
 * Recency is a hard exclusion here, not the client's old 0.1 soft weight: a
 * player/set in excludeUsers/excludeSets cannot come back for the next few
 * draws instead of being ten times less likely. The client only fills those
 * lists when its "avoid repeats" toggle is on.
 */
export async function getMapsRandomDraw(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
  query: MapsRandomDrawQuery,
): Promise<MapsSnapshotResponse<MapsRandomDrawValue>> {
  const normalized = country.toUpperCase();
  // Stamps only: the draw reads the normalized tables, so payload_json is never
  // touched. It still drives the same staleness/refresh bookkeeping the pool
  // endpoint had, which is what keeps a cold country's build progressing.
  const row = (await exec(
    db,
    "select generated_at, refreshed_at from country_maps_snapshots where country = ?",
    [normalized],
  )).rows[0];
  const generatedAt = row?.generated_at == null ? null : String(row.generated_at);
  const refreshedAt = row?.refreshed_at == null ? null : String(row.refreshed_at);
  const refreshedMs = refreshedAt ? new Date(refreshedAt).getTime() : 0;
  const globalStale = isGlobalCountry(normalized)
    ? await isGlobalMapsSnapshotBehindSources(db, refreshedAt)
    : false;
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || globalStale;
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (isStale && !refreshQueued) {
    if (isGlobalCountry(normalized)) {
      refreshQueued = await enqueueGlobalMapsRefreshIfDue(db, queue, maxAgeMs);
    } else {
      await enqueueMapsRefresh(queue, normalized);
      refreshQueued = true;
    }
  }
  const progress = refreshQueued ? await readActiveMapsRefreshProgress(db, normalized) : null;

  // A missing snapshot row means this country's maps have never been built.
  // Report the null value the frontend's "Building maps... (N%)" flow waits on
  // rather than an empty draw, which would read as "nothing matches".
  if (!row) return { value: null, generatedAt, refreshedAt, isStale, refreshQueued, progress };

  return {
    value: await drawMapsRandomPicks(db, normalized, query, generatedAt),
    generatedAt,
    refreshedAt,
    isStale,
    refreshQueued,
    progress,
  };
}

async function drawMapsRandomPicks(
  db: Db,
  country: string,
  query: MapsRandomDrawQuery,
  generatedAt: string | null,
): Promise<MapsRandomDrawValue> {
  const count = Math.max(0, Math.min(MAPS_RANDOM_DRAW_MAX_COUNT, Math.floor(query.count) || 0));
  const hasExclusions = query.excludeUsers.length > 0 || query.excludeSets.length > 0;
  const statement = mapsRandomDrawStatement(country, query, count, { applyExclusions: hasExclusions });
  let drawn = (await exec(db, statement.sql, statement.args)).rows;
  const totalPicks = Number(drawn[0]?.total_picks ?? 0);
  const uniqueSets = Number(drawn[0]?.unique_sets ?? 0);

  // Reroll must never dead-end: when the recency exclusions empty an otherwise
  // non-empty pool, draw again with only the hidden-user filter left in place.
  if (count > 0 && hasExclusions && totalPicks > 0 && drawn.every((row) => row.user_id == null)) {
    const retry = mapsRandomDrawStatement(country, query, count, { applyExclusions: false });
    drawn = (await exec(db, retry.sql, retry.args)).rows;
  }

  return {
    country,
    weight: query.weight,
    totalPicks,
    uniqueSets,
    picks: await hydrateMapsRandomPicks(db, country, drawn),
    generatedAt,
    // The stored payload's favouritesGeneratedAt trails generatedAt by the
    // seconds one refresh takes, and digging it out of a 67 MB payload_json
    // costs ~180 ms per draw at GLOBAL scope — more than the draw itself.
    favouritesGeneratedAt: generatedAt,
  };
}

async function hydrateMapsRandomPicks(
  db: Db,
  country: string,
  rows: Record<string, unknown>[],
): Promise<MapsRandomDrawPick[]> {
  const pairs = rows
    .map((row) => ({ userId: Number(row.user_id), beatmapsetId: Number(row.beatmapset_id) }))
    .filter((pair) => Number.isSafeInteger(pair.userId) && pair.userId > 0 && Number.isSafeInteger(pair.beatmapsetId) && pair.beatmapsetId > 0);
  if (pairs.length === 0) return [];

  const userIds = [...new Set(pairs.map((pair) => pair.userId))];
  const setIds = [...new Set(pairs.map((pair) => pair.beatmapsetId))];
  const beatmapsets = new Map((await getMapsRandomBeatmapsets(db, setIds)).map((beatmapset) => [beatmapset.id, beatmapset]));
  const users = await readMapsUserDisplayByIds(db, userIds);
  const favouriteCounts = await readMapsScopeFavouriteCounts(db, country, "user_id", userIds);
  const scopeFavCounts = await readMapsScopeFavouriteCounts(db, country, "beatmapset_id", setIds);

  return pairs.flatMap((pair) => {
    // A set whose beatmaps have since been pruned cannot be rendered; drop the
    // pick rather than shipping a half-empty card.
    const beatmapset = beatmapsets.get(pair.beatmapsetId);
    if (!beatmapset) return [];
    const user = users.get(pair.userId);
    return [{
      player: {
        id: pair.userId,
        // Same fallback the per-map player board renders for a user row that
        // has not been enriched yet.
        username: user?.username || `User ${pair.userId}`,
        avatarUrl: user?.avatarUrl ?? "",
        favouriteCount: favouriteCounts.get(pair.userId) ?? 0,
      },
      beatmapset,
      scopeFavCount: scopeFavCounts.get(pair.beatmapsetId) ?? 0,
    }];
  });
}

// Per-player favourite totals and per-set favouriter counts for the drawn
// batch. Both stay unfiltered by the draw filters — they describe the scope,
// not the query — and both apply the same roster join as the draw itself.
async function readMapsScopeFavouriteCounts(
  db: Db,
  country: string,
  groupBy: "user_id" | "beatmapset_id",
  ids: number[],
): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const global = isGlobalCountry(country);
  const scope = global ? "!=" : "=";
  const counted = groupBy === "user_id" ? "beatmapset_id" : "user_id";
  const rows = (await exec(
    db,
    `select f.${groupBy} as id, count(distinct f.${counted}) as total
     from country_maps_favourite_sets f
     join country_rosters r on r.country = f.country and r.user_id = f.user_id and r.is_tracked = 1 and r.rank is not null
     where f.country ${scope} ? and f.${groupBy} in (${sqlPlaceholders(ids)})
     group by f.${groupBy}`,
    [global ? GLOBAL_COUNTRY_CODE : country, ...ids],
  )).rows;
  return new Map(rows.map((row) => [Number(row.id), Number(row.total ?? 0)]));
}

async function hydrateMapsPageValue(
  db: Db,
  country: string,
  parsed: StoredCountryMapsData | CountryMapsData,
  query: MapsPageQuery,
  refreshedAt: string | null,
): Promise<MapsPageValue> {
  const page = Math.max(0, Math.floor(query.page));
  const pageSize = Math.max(1, Math.min(48, Math.floor(query.pageSize)));

  if (isStoredCountryMapsData(parsed)) {
    const value = await hydrateCompactMapsPageValue(db, country, parsed, { ...query, page, pageSize }, refreshedAt);
    return value;
  }

  let value = await hydrateMapsSnapshotUsers(db, parsed);
  if (query.tab === "farmed" && !isGlobalCountry(country)) {
    value = await applyMapsFarmedOverlay(db, country, value, refreshedAt);
  }
  const allItems = filterSortMapsPageItems(value, query);
  const items = limitMapsPagePreviewPlayers(await hydrateMapsPageItemUsers(db, allItems.slice(page * pageSize, page * pageSize + pageSize)));
  return {
    tab: query.tab,
    page,
    pageSize,
    total: allItems.length,
    items,
    generatedAt: value.generatedAt,
    farmedGeneratedAt: value.farmedGeneratedAt,
    favouritesGeneratedAt: value.favouritesGeneratedAt,
  };
}

async function hydrateCompactMapsPageValue(
  db: Db,
  country: string,
  parsed: StoredCountryMapsData,
  query: MapsPageQuery,
  refreshedAt: string | null,
): Promise<MapsPageValue> {
  if (query.tab === "farmed" && isGlobalCountry(country) && (query.pp > 0 || query.mod !== "all")) {
    return hydrateGlobalCompactFarmedFilteredPageValue(db, parsed, query, refreshedAt);
  }

  if (await canUseCompactFarmedPageFastPath(db, country, query, refreshedAt)) {
    return hydrateCompactFarmedPageFastPath(db, parsed, query);
  }

  let value: CountryMapsData;

  if (query.tab === "farmed") {
    value = {
      farmed: await hydrateCompactFarmedEntries(db, parsed.farmed),
      mostPlayed: [],
      favourites: [],
      favouritesByPlayer: [],
      beatmapsetsPool: {},
      generatedAt: parsed.generatedAt,
      farmedGeneratedAt: parsed.farmedGeneratedAt,
      favouritesGeneratedAt: parsed.favouritesGeneratedAt,
    };
    value = await applyMapsFarmedOverlay(db, country, value, refreshedAt);
  } else if (query.tab === "popular") {
    value = {
      farmed: [],
      mostPlayed: await hydrateCompactMostPlayedEntries(db, parsed.mostPlayed),
      favourites: [],
      favouritesByPlayer: [],
      beatmapsetsPool: {},
      generatedAt: parsed.generatedAt,
      farmedGeneratedAt: parsed.farmedGeneratedAt,
      favouritesGeneratedAt: parsed.favouritesGeneratedAt,
    };
  } else {
    value = {
      farmed: [],
      mostPlayed: [],
      favourites: await hydrateCompactFavouriteEntries(db, parsed.favourites),
      favouritesByPlayer: [],
      beatmapsetsPool: {},
      generatedAt: parsed.generatedAt,
      farmedGeneratedAt: parsed.farmedGeneratedAt,
      favouritesGeneratedAt: parsed.favouritesGeneratedAt,
    };
  }

  const allItems = filterSortMapsPageItems(value, query);
  const items = limitMapsPagePreviewPlayers(await hydrateMapsPageItemUsers(db, allItems.slice(query.page * query.pageSize, query.page * query.pageSize + query.pageSize)));
  return {
    tab: query.tab,
    page: query.page,
    pageSize: query.pageSize,
    total: allItems.length,
    items,
    generatedAt: value.generatedAt,
    farmedGeneratedAt: value.farmedGeneratedAt,
    favouritesGeneratedAt: value.favouritesGeneratedAt,
  };
}

async function canUseCompactFarmedPageFastPath(
  db: Db,
  country: string,
  query: MapsPageQuery,
  refreshedAt: string | null,
): Promise<boolean> {
  if (query.tab !== "farmed") return false;
  if (!refreshedAt) return true;
  if (isGlobalCountry(country)) return true;

  const overlayUpdatedAt = isGlobalCountry(country)
    ? await readGlobalMapsFarmedOverlayUpdatedAt(db)
    : await readMapsFarmedOverlayUpdatedAt(db, country);
  if (!overlayUpdatedAt) {
    const rowsUpdatedAt = isGlobalCountry(country)
      ? await readGlobalMapsFarmedOverlayRowsUpdatedAt(db)
      : await readMapsFarmedOverlayRowsUpdatedAt(db, country);
    return !rowsUpdatedAt || rowsUpdatedAt <= refreshedAt;
  }
  return overlayUpdatedAt <= refreshedAt;
}

async function hydrateCompactFarmedPageFastPath(
  db: Db,
  parsed: StoredCountryMapsData,
  query: MapsPageQuery,
): Promise<MapsPageValue> {
  const allItems = await filterSortStoredFarmedMapsForPage(db, parsed.farmed, query);
  const pageItems = allItems.slice(query.page * query.pageSize, query.page * query.pageSize + query.pageSize);
  const items = limitMapsPagePreviewPlayers(await hydrateMapsPageItemUsers(db, await hydrateCompactFarmedEntries(db, pageItems)));
  return {
    tab: query.tab,
    page: query.page,
    pageSize: query.pageSize,
    total: allItems.length,
    items,
    generatedAt: parsed.generatedAt,
    farmedGeneratedAt: parsed.farmedGeneratedAt,
    favouritesGeneratedAt: parsed.favouritesGeneratedAt,
  };
}

async function hydrateGlobalCompactFarmedFilteredPageValue(
  db: Db,
  parsed: StoredCountryMapsData,
  query: MapsPageQuery,
  refreshedAt: string | null,
): Promise<MapsPageValue> {
  const board = await getGlobalFarmedBoard(db, parsed, refreshedAt ?? "");
  return buildGlobalFarmedBoardPageValue(db, board, query);
}

async function buildGlobalFarmedBoardPageValue(db: Db, board: GlobalFarmedBoard, query: MapsPageQuery): Promise<MapsPageValue> {
  const ranked = filterSortGlobalFarmedBoard(board, query);
  const pageRanked = ranked.slice(query.page * query.pageSize, query.page * query.pageSize + query.pageSize);
  const pageEntries = pageRanked.map((item) => materializeGlobalFarmedBoardEntry(board, item));
  const items = limitMapsPagePreviewPlayers(await hydrateMapsPageItemUsers(db, await hydrateCompactFarmedEntries(db, pageEntries)));
  return {
    tab: query.tab,
    page: query.page,
    pageSize: query.pageSize,
    total: ranked.length,
    items,
    // Stamps travel with the board so they always describe the data actually
    // served (a stale-served board reports its own generation's stamps).
    generatedAt: board.generatedAt,
    farmedGeneratedAt: board.farmedGeneratedAt,
    favouritesGeneratedAt: board.favouritesGeneratedAt,
  };
}

async function getGlobalFarmedProjectionPageSnapshot(
  db: Db,
  queue: JobQueue,
  normalized: string,
  maxAgeMs: number,
  query: MapsPageQuery,
  projectionState: GlobalMapsFarmedProjectionState,
): Promise<MapsSnapshotResponse<MapsPageValue>> {
  const row = (await exec(
    db,
    "select generated_at, refreshed_at from country_maps_snapshots where country = ?",
    [normalized],
  )).rows[0];
  const generatedAt = row?.generated_at == null ? projectionState.updatedAt : String(row.generated_at);
  const refreshedAt = row?.refreshed_at == null ? projectionState.updatedAt : String(row.refreshed_at);
  const refreshedMs = new Date(refreshedAt).getTime();
  const globalStale = await isGlobalMapsSnapshotBehindSources(db, refreshedAt);
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || globalStale;
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (isStale && !refreshQueued) {
    refreshQueued = await enqueueGlobalMapsRefreshIfDue(db, queue, maxAgeMs);
  }

  const board = await getGlobalFarmedProjectionBoard(db, projectionState, {
    generatedAt,
    farmedGeneratedAt: projectionState.updatedAt,
    favouritesGeneratedAt: generatedAt,
  });
  return {
    value: await buildGlobalFarmedBoardPageValue(db, board, query),
    generatedAt,
    refreshedAt,
    isStale,
    refreshQueued,
    progress: refreshQueued ? await readActiveMapsRefreshProgress(db, normalized) : null,
  };
}

export interface GlobalMapsRandomFarmedQuery {
  key: MapsKeyFilter;
  status: MapsStatusFilter;
  starsMin: number | null;
  starsMax: number | null;
  minPp: number;
}

// Discord's /randomfarm needs a weighted draw rather than a ranked page. Keep
// that small consumer on the same packed projection so removing the farmed
// array from the compatibility GLOBAL blob does not narrow its pool.
export async function getGlobalMapsRandomFarmedMap(
  db: Db,
  query: GlobalMapsRandomFarmedQuery,
): Promise<CountryMapsData["farmed"][number] | null> {
  const state = await readGlobalMapsFarmedProjectionState(db);
  if (!state?.initialized) return null;
  const row = (await exec(
    db,
    "select generated_at from country_maps_snapshots where country = ?",
    [GLOBAL_COUNTRY_CODE],
  )).rows[0];
  const generatedAt = String(row?.generated_at ?? state.updatedAt);
  const board = await getGlobalFarmedProjectionBoard(db, state, {
    generatedAt,
    farmedGeneratedAt: state.updatedAt,
    favouritesGeneratedAt: generatedAt,
  });
  const ranked = filterSortGlobalFarmedBoard(board, {
    tab: "farmed",
    page: 0,
    pageSize: 1,
    key: query.key,
    beatmapSort: "players",
    farmedSort: "players",
    dir: "desc",
    status: "all",
    pp: Math.max(0, query.minPp),
    mod: "all",
    q: "",
  }).filter((entry) => {
    const meta = board.metadata.get(entry.beatmapId);
    if (!meta || !matchesMapsStatusFilter(meta.status, query.status)) return false;
    if (query.starsMin != null && meta.difficultyRating < query.starsMin) return false;
    if (query.starsMax != null && meta.difficultyRating > query.starsMax) return false;
    return true;
  });
  if (ranked.length === 0) return null;

  const totalWeight = ranked.reduce((sum, entry) => sum + Math.max(1, entry.playerCount), 0);
  let pick = Math.random() * totalWeight;
  let selected = ranked[ranked.length - 1];
  for (const entry of ranked) {
    pick -= Math.max(1, entry.playerCount);
    if (pick <= 0) {
      selected = entry;
      break;
    }
  }
  const hydrated = await hydrateMapsPageItemUsers(
    db,
    await hydrateCompactFarmedEntries(db, [materializeGlobalFarmedBoardEntry(board, selected)]),
  );
  return hydrated[0] ?? null;
}

// Serve a filtered GLOBAL farmed page without touching payload_json: only
// possible while the cached board matches the snapshot row's generation.
// Returns null whenever the full (parse + board build) path must run instead.
// The staleness/refresh bookkeeping mirrors readRawMapsSnapshot for GLOBAL; a
// board existing for this generation implies the payload was usable when it
// was built, so the usability probe needs no payload either.
async function getGlobalFarmedBoardPageSnapshot(
  db: Db,
  queue: JobQueue,
  normalized: string,
  maxAgeMs: number,
  query: MapsPageQuery,
): Promise<MapsSnapshotResponse<MapsPageValue> | null> {
  const board = globalFarmedBoardStates.get(db)?.board;
  if (!board) return null;
  const row = (await exec(
    db,
    "select generated_at, refreshed_at from country_maps_snapshots where country = ?",
    [normalized],
  )).rows[0];
  const refreshedAt = row?.refreshed_at == null ? null : String(row.refreshed_at);
  if (!refreshedAt || board.generation !== refreshedAt) return null;

  const refreshedMs = new Date(refreshedAt).getTime();
  const globalStale = await isGlobalMapsSnapshotBehindSources(db, refreshedAt);
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || globalStale;
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (isStale && !refreshQueued) {
    await enqueueMapsRefresh(queue, normalized);
    refreshQueued = true;
  }

  return {
    value: await buildGlobalFarmedBoardPageValue(db, board, query),
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt,
    isStale,
    refreshQueued,
    progress: refreshQueued ? await readActiveMapsRefreshProgress(db, normalized) : null,
  };
}

// ---------------------------------------------------------------------------
// Global farmed board cache
//
// A pp/mod-filtered GLOBAL farmed page must recount every player. The durable
// projection supplies the already-deduplicated rows, which are packed once per
// process; later revisions patch only changed beatmaps over that base.
//
// Memory is the constraint (this cache lives for the life of the process, on
// the maps snapshot thread in production): per-player fields are packed into
// flat typed arrays (~30 bytes/player, ~40MB at prod's 1.35M players) instead
// of ~1.35M string-bearing objects (hundreds of MB). Mods arrays are interned
// through a small dictionary (a few hundred combos exist) and score URLs are
// stored as their numeric score id (every prod row is
// https://osu.ppy.sh/scores/<id>; the rare mismatch goes to an override map).
//
// The bounded override map is occasionally repacked in the background so a
// long-lived serving process cannot slowly recreate an object-heavy full board.

export interface GlobalFarmedBoardEntry {
  beatmapId: number;
  /** Index of this map's first player in the flat player arrays. */
  start: number;
  /** Number of players, stored contiguously and sorted by pp desc. */
  count: number;
}

// modsFlags bits per dictionary combo: bit 0 = counts as DT (has DT or NC),
// bit 1 = literally includes "HT". Both are needed to reproduce
// getDominantStoredMapsSpeedMod exactly (its HT branch checks the top
// player's raw mods, not the DT/HT bucketing).
const GLOBAL_FARMED_MOD_FLAG_DT = 1;
const GLOBAL_FARMED_MOD_FLAG_HT = 2;

interface GlobalFarmedBoard {
  generation: string;
  // Response stamps captured from the payload this board was built from.
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
  entries: GlobalFarmedBoardEntry[];
  // Float64 for ids keeps every safe integer exact (no int32 wrap hazard).
  userIds: Float64Array;
  pps: Float64Array;
  modsIdx: Uint32Array;
  playedAtMs: Float64Array;
  scoreIds: Float64Array;
  scoreUrlOverrides: Map<number, string>;
  modsDict: string[][];
  modsFlags: Uint8Array;
  metadata: Map<number, MapsFarmedPageMetadata>;
  projectionRevision: number | null;
  // Changed maps are tiny compared with the packed base. Keeping them as row
  // objects lets a serving process patch cross-process writes in O(changed
  // maps) without copying every typed array on each update.
  overrides: Map<number, StoredMapsFarmedEntry | null>;
}

interface GlobalFarmedBoardState {
  board: GlobalFarmedBoard | null;
  inflight: Promise<GlobalFarmedBoard> | null;
  inflightGeneration: string | null;
  deltaInflight: Promise<boolean> | null;
}

// Per-Db so tests with separate databases never share a board; production has
// one Db per process (the snapshot thread's own connection).
const globalFarmedBoardStates = new WeakMap<Db, GlobalFarmedBoardState>();

// Where each Db persists its packed board between restarts (B2). Absent for
// unregistered connections (memory databases, most tests), which simply skip
// the disk tier.
const globalFarmedBoardDiskPaths = new WeakMap<Db, string>();

/**
 * Opts a connection into the on-disk board snapshot: every pack writes the
 * typed-array columns to a file next to the SQLite database, and a cold
 * process restores from it (validated against the projection state, patched
 * forward with deltas) instead of paying the ~20-25s full repack at boot.
 * The file is a cache and always safe to delete.
 */
export function registerGlobalFarmedBoardDiskCache(db: Db, databaseUrl: string): void {
  if (!databaseUrl.startsWith("file:")) return;
  const dbPath = resolve(databaseUrl.slice("file:".length));
  globalFarmedBoardDiskPaths.set(db, join(dirname(dbPath), "global-farmed-board-cache.bin"));
}

// How often the resident board checks the projection state for pending deltas.
// Small enough that per-tick work stays a handful of maps under normal ingest;
// the point is that no request ever pays for an idle-period backlog (B1).
const GLOBAL_FARMED_BOARD_CATCHUP_TICK_MS = 30_000;

function ensureGlobalFarmedBoardState(db: Db): GlobalFarmedBoardState {
  let state = globalFarmedBoardStates.get(db);
  if (!state) {
    state = { board: null, inflight: null, inflightGeneration: null, deltaInflight: null };
    globalFarmedBoardStates.set(db, state);
    startGlobalFarmedBoardCatchUpTicker(db);
  }
  return state;
}

// The ticker holds only a WeakRef to the Db: a strong reference from the
// interval closure would pin every test database (and its board) in memory
// forever through the WeakMap above. When the Db is collected the ticker
// dismantles itself. unref'd so it never keeps an exiting process alive.
function startGlobalFarmedBoardCatchUpTicker(db: Db): void {
  const ref = new WeakRef(db);
  const timer = setInterval(() => {
    const live = ref.deref();
    if (!live) {
      clearInterval(timer);
      return;
    }
    void catchUpGlobalFarmedBoard(live).catch((error) => logWarn("global_farmed_board_catchup_tick_failed", errorContext(error)));
  }, GLOBAL_FARMED_BOARD_CATCHUP_TICK_MS);
  timer.unref();
}

/**
 * One background catch-up pass for the resident GLOBAL board: applies pending
 * projection deltas, or starts a repack when the seed epoch changed or the
 * backlog/override pressure calls for one. Runs from the 30s ticker so the
 * board converges even with zero traffic; exported so tests can drive a tick
 * directly instead of waiting on the interval.
 */
export async function catchUpGlobalFarmedBoard(db: Db): Promise<void> {
  const state = globalFarmedBoardStates.get(db);
  const board = state?.board;
  if (!state || !board || state.inflight || state.deltaInflight) return;
  // Only projection-generation boards participate; a legacy payload-derived
  // board is replaced through its own generation check on the request path.
  if (!board.generation.startsWith(`${GLOBAL_FARMED_PROJECTION_GENERATION}:`)) return;
  const projectionState = await readGlobalMapsFarmedProjectionState(db);
  if (!projectionState?.initialized) return;
  const generation = globalFarmedProjectionGeneration(projectionState.seedEpoch);
  const stamps = await readGlobalFarmedBoardStampsFromSnapshotRow(db, projectionState);
  if (board.generation !== generation) {
    // Seed epoch changed: no delta in the new corpus can describe this board,
    // only a full pack replaces it.
    void startGlobalFarmedProjectionBoardBuild(db, state, projectionState, stamps, generation)
      .catch((error) => logWarn("global_farmed_projection_board_reseed_repack_failed", errorContext(error)));
    return;
  }
  if ((board.projectionRevision ?? 0) < projectionState.revision) {
    scheduleGlobalFarmedProjectionCatchUp(db, state, board, projectionState, stamps, generation);
    return;
  }
  if (board.overrides.size >= GLOBAL_FARMED_PROJECTION_REPACK_OVERRIDES) {
    void startGlobalFarmedProjectionBoardBuild(
      db,
      state,
      projectionState,
      stamps,
      `${generation}:repack:${board.projectionRevision ?? 0}`,
    ).catch((error) => logWarn("global_farmed_projection_board_repack_failed", errorContext(error)));
  }
}

// The ticker runs outside any request, so it rebuilds the response stamps the
// same way getGlobalFarmedProjectionPageSnapshot does for its callers.
async function readGlobalFarmedBoardStampsFromSnapshotRow(
  db: Db,
  projectionState: GlobalMapsFarmedProjectionState,
): Promise<GlobalFarmedBoardStamps> {
  const row = (await exec(
    db,
    "select generated_at from country_maps_snapshots where country = ?",
    [GLOBAL_COUNTRY_CODE],
  )).rows[0];
  const generatedAt = row?.generated_at == null ? projectionState.updatedAt : String(row.generated_at);
  return { generatedAt, farmedGeneratedAt: projectionState.updatedAt, favouritesGeneratedAt: generatedAt };
}

async function getGlobalFarmedBoard(db: Db, parsed: StoredCountryMapsData, generation: string): Promise<GlobalFarmedBoard> {
  const stateRef = ensureGlobalFarmedBoardState(db);
  const current = stateRef.board;
  if (current && current.generation === generation) return current;

  if (!stateRef.inflight || stateRef.inflightGeneration !== generation) {
    stateRef.inflightGeneration = generation;
    const build = buildGlobalFarmedBoard(db, parsed, generation);
    stateRef.inflight = build;
    build
      .then((board) => {
        // A newer generation may have started while this build ran; never let
        // a slow older build clobber it.
        if (stateRef.inflightGeneration === generation) stateRef.board = board;
      })
      .catch((error) => logWarn("global_farmed_board_build_failed", { generation, ...errorContext(error) }))
      .finally(() => {
        if (stateRef.inflight === build) stateRef.inflight = null;
      });
  }

  // Stale-serve: an outdated board answers immediately while the rebuild runs
  // in the background (mirrors the HTTP layer's GLOBAL stale-serve).
  if (current) return current;
  return stateRef.inflight;
}

interface GlobalFarmedBoardStamps {
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
}

const GLOBAL_FARMED_PROJECTION_GENERATION = "projection:v1";
const GLOBAL_FARMED_PROJECTION_REPACK_OVERRIDES = 5_000;
const GLOBAL_FARMED_PROJECTION_MAX_DELTA_MAPS = 5_000;

function globalFarmedProjectionGeneration(seedEpoch: number): string {
  return `${GLOBAL_FARMED_PROJECTION_GENERATION}:seed:${seedEpoch}`;
}

function startGlobalFarmedProjectionBoardBuild(
  db: Db,
  state: GlobalFarmedBoardState,
  projectionState: GlobalMapsFarmedProjectionState,
  stamps: GlobalFarmedBoardStamps,
  token: string,
  options?: { tryDiskRestore?: boolean },
): Promise<GlobalFarmedBoard> {
  if (state.inflight && state.inflightGeneration === token) return state.inflight;
  state.inflightGeneration = token;
  const build = (async () => {
    if (options?.tryDiskRestore) {
      // Cold-boot path only: repacks and catch-up packs must rebuild from the
      // projection tables, never from the (older) disk snapshot.
      try {
        const restored = await restoreGlobalFarmedProjectionBoardFromDisk(db, projectionState);
        if (restored) return restored;
      } catch (error) {
        logWarn("global_farmed_board_disk_restore_failed", errorContext(error));
      }
    }
    return buildGlobalFarmedProjectionBoard(db, projectionState, stamps);
  })();
  state.inflight = build;
  build
    .then((board) => {
      if (state.inflightGeneration === token) state.board = board;
    })
    .catch((error) => logWarn("global_farmed_projection_board_build_failed", { token, ...errorContext(error) }))
    .finally(() => {
      if (state.inflight === build) state.inflight = null;
    });
  return build;
}

async function getGlobalFarmedProjectionBoard(
  db: Db,
  projectionState: GlobalMapsFarmedProjectionState,
  stamps: GlobalFarmedBoardStamps,
): Promise<GlobalFarmedBoard> {
  const stateRef = ensureGlobalFarmedBoardState(db);
  const current = stateRef.board;
  const generation = globalFarmedProjectionGeneration(projectionState.seedEpoch);

  if (current?.generation === generation) {
    if ((current.projectionRevision ?? 0) >= projectionState.revision) {
      // Only claim the projection's stamps once the board actually carries
      // every change up to them; a board serving mid-catchup is older than
      // they say and keeps its own stamps instead.
      current.generatedAt = stamps.generatedAt;
      current.farmedGeneratedAt = projectionState.updatedAt;
      current.favouritesGeneratedAt = stamps.favouritesGeneratedAt;
    } else if (!stateRef.inflight) {
      // Behind the projection: never pay for catch-up on the request path.
      // Serve the board as-is and patch it in the background; the 30s ticker
      // (catchUpGlobalFarmedBoard) converges the board even with no traffic,
      // this nudge just makes a visited page converge sooner. Mirrors the
      // long-standing stale-serve for the >5,000-map backlog: a board a few
      // revisions behind is a far better answer than a blocked request (the
      // sync catch-up here measured 11s after a 52-minute idle gap on prod).
      scheduleGlobalFarmedProjectionCatchUp(db, stateRef, current, projectionState, stamps, generation);
    }
    if (current.overrides.size >= GLOBAL_FARMED_PROJECTION_REPACK_OVERRIDES && !stateRef.inflight) {
      void startGlobalFarmedProjectionBoardBuild(
        db,
        stateRef,
        projectionState,
        stamps,
        `${generation}:repack:${current.projectionRevision ?? 0}`,
      ).catch((error) => logWarn("global_farmed_projection_board_repack_failed", errorContext(error)));
    }
    return current;
  }

  if (current) {
    // Seed epoch changed while this process holds a packed board. A re-seed
    // can remove an entire country, so no delta in the new corpus can describe
    // this board and only a full pack replaces it -- but that pack is ~20-25s
    // on prod, and blocking every visitor on it is worse than briefly serving
    // the pre-seed corpus. Re-seeds are admin-triggered and rare, and the
    // ticker replaces the board within a tick even with no traffic.
    void startGlobalFarmedProjectionBoardBuild(db, stateRef, projectionState, stamps, generation)
      .catch((error) => logWarn("global_farmed_projection_board_reseed_repack_failed", errorContext(error)));
    return current;
  }

  // Cold process with nothing to serve: this request has to wait for a board
  // either way. The disk snapshot (written at every pack, patched forward with
  // deltas on load) makes that wait sub-second instead of the ~20-25s full
  // pack; the boot warm (warmGlobalMapsFarmedBoard) is what keeps real
  // visitors off even that.
  return startGlobalFarmedProjectionBoardBuild(db, stateRef, projectionState, stamps, generation, { tryDiskRestore: true });
}

// Fire-and-forget delta catch-up; the caller keeps serving the current board.
// An oversized backlog falls through to a full background repack: it is
// cheaper and safer to repack once than to materialize thousands of full
// per-map player arrays as overrides.
function scheduleGlobalFarmedProjectionCatchUp(
  db: Db,
  state: GlobalFarmedBoardState,
  board: GlobalFarmedBoard,
  projectionState: GlobalMapsFarmedProjectionState,
  stamps: GlobalFarmedBoardStamps,
  generation: string,
): void {
  if (state.inflight || state.deltaInflight) return;
  state.deltaInflight = applyGlobalFarmedProjectionDeltas(db, board, projectionState)
    .then((patched) => {
      if (!patched) {
        void startGlobalFarmedProjectionBoardBuild(
          db,
          state,
          projectionState,
          stamps,
          `${generation}:catchup:${projectionState.revision}`,
        ).catch((error) => logWarn("global_farmed_projection_board_catchup_failed", errorContext(error)));
      }
      return patched;
    })
    .catch((error) => {
      logWarn("global_farmed_projection_delta_apply_failed", errorContext(error));
      return false;
    })
    .finally(() => {
      state.deltaInflight = null;
    });
}

/**
 * Test hook: settle the in-flight board work (delta catch-up and builds) for
 * this Db. Loops because a delta catch-up that finds an oversized backlog
 * hands off to a background repack.
 */
export async function waitForGlobalFarmedBoardBuild(db: Db): Promise<void> {
  for (;;) {
    const state = globalFarmedBoardStates.get(db);
    const pending: Promise<unknown> | null = state?.deltaInflight ?? state?.inflight ?? null;
    if (!pending) return;
    await pending.then(() => undefined, () => undefined);
  }
}

/** Test hook for asserting whether a request patched or fully repacked. */
export function getGlobalFarmedBoardCacheStatsForTests(
  db: Db,
): { generation: string; revision: number; overrides: number; buildToken: string | null } | null {
  const state = globalFarmedBoardStates.get(db);
  const board = state?.board;
  return board
    ? {
        generation: board.generation,
        revision: board.projectionRevision ?? 0,
        overrides: board.overrides.size,
        buildToken: state?.inflightGeneration ?? null,
      }
    : null;
}

async function buildGlobalFarmedBoard(db: Db, parsed: StoredCountryMapsData, generation: string): Promise<GlobalFarmedBoard> {
  const startedAt = Date.now();
  const source = await readGlobalFarmedEntriesForFilteredPage(db, parsed.farmed);
  const metadata = await readMapsFarmedPageMetadataByIds(db, source.map((entry) => entry.beatmapId));
  const board = encodeGlobalFarmedBoard(generation, parsed, source, metadata);
  logInfo("global_farmed_board_built", {
    generation,
    entries: board.entries.length,
    players: board.userIds.length,
    duration_ms: Date.now() - startedAt,
    heap_used_mb: heapUsedMb(),
  });
  return board;
}

async function readGlobalFarmedChangeRevision(db: Db): Promise<number> {
  const row = (await exec(db, "select max(revision) as revision from global_maps_farmed_changes")).rows[0];
  return Math.max(0, Number(row?.revision ?? 0));
}

async function buildGlobalFarmedProjectionBoard(
  db: Db,
  projectionState: GlobalMapsFarmedProjectionState,
  stamps: GlobalFarmedBoardStamps,
): Promise<GlobalFarmedBoard> {
  const startedAt = Date.now();
  const baseRevision = await readGlobalFarmedChangeRevision(db);
  const source = await readGlobalFarmedProjectionEntries(db);
  const metadata = await readMapsFarmedPageMetadataByIds(db, source.map((entry) => entry.beatmapId));
  const parsed: StoredCountryMapsData = {
    schemaVersion: 2,
    farmed: [],
    mostPlayed: [],
    favourites: [],
    favouritesByPlayer: [],
    beatmapsetsPool: [],
    generatedAt: stamps.generatedAt,
    farmedGeneratedAt: projectionState.updatedAt,
    favouritesGeneratedAt: stamps.favouritesGeneratedAt,
  };
  const board = encodeGlobalFarmedBoard(globalFarmedProjectionGeneration(projectionState.seedEpoch), parsed, source, metadata);
  board.projectionRevision = baseRevision;
  // Persist before the trailing delta apply: the typed columns never change
  // after encode but the metadata/override maps do, and a clean board plus the
  // load-time delta patch is strictly simpler than serializing overrides. The
  // write streams views over the live arrays, so no second board copy exists.
  await persistGlobalFarmedBoardToDisk(db, board);
  const latestState = await readGlobalMapsFarmedProjectionState(db);
  if (latestState && latestState.revision > baseRevision) {
    await applyGlobalFarmedProjectionDeltas(db, board, latestState);
  }
  logInfo("global_farmed_projection_board_built", {
    revision: board.projectionRevision,
    entries: board.entries.length,
    players: board.userIds.length,
    duration_ms: Date.now() - startedAt,
    heap_used_mb: heapUsedMb(),
  });
  return board;
}

// Best-effort by design: a failed write only means the next cold boot repacks.
async function persistGlobalFarmedBoardToDisk(db: Db, board: GlobalFarmedBoard): Promise<void> {
  const filePath = globalFarmedBoardDiskPaths.get(db);
  if (!filePath) return;
  const startedAt = Date.now();
  try {
    await saveGlobalFarmedBoardToDisk(filePath, { ...board, projectionRevision: board.projectionRevision ?? 0 });
    logInfo("global_farmed_board_disk_saved", {
      revision: board.projectionRevision ?? 0,
      entries: board.entries.length,
      players: board.userIds.length,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    logWarn("global_farmed_board_disk_save_failed", errorContext(error));
  }
}

async function restoreGlobalFarmedProjectionBoardFromDisk(
  db: Db,
  projectionState: GlobalMapsFarmedProjectionState,
): Promise<GlobalFarmedBoard | null> {
  const filePath = globalFarmedBoardDiskPaths.get(db);
  if (!filePath) return null;
  const startedAt = Date.now();
  // The loader rejects (and deletes) any snapshot from another format version,
  // seed epoch, or a revision ahead of this database (a restored backup).
  const persisted = await loadGlobalFarmedBoardFromDisk(filePath, {
    generation: globalFarmedProjectionGeneration(projectionState.seedEpoch),
    maxRevision: projectionState.revision,
  });
  if (!persisted) return null;
  const board: GlobalFarmedBoard = { ...persisted, overrides: new Map() };
  if ((board.projectionRevision ?? 0) < projectionState.revision) {
    // Patch forward with the deltas written since the snapshot. An oversized
    // backlog leaves the board where it is; the normal catch-up machinery then
    // repacks in the background while this board serves.
    await applyGlobalFarmedProjectionDeltas(db, board, projectionState);
  }
  logInfo("global_farmed_board_disk_restored", {
    revision: board.projectionRevision,
    entries: board.entries.length,
    players: board.userIds.length,
    overrides: board.overrides.size,
    duration_ms: Date.now() - startedAt,
    heap_used_mb: heapUsedMb(),
  });
  return board;
}

async function readGlobalFarmedProjectionEntries(
  db: Db,
  beatmapIds?: number[],
): Promise<StoredMapsFarmedEntry[]> {
  const ids = beatmapIds
    ? [...new Set(beatmapIds)].filter((id) => Number.isSafeInteger(id) && id > 0)
    : null;
  if (ids && ids.length === 0) return [];

  const aggregateRows: Record<string, unknown>[] = [];
  if (ids) {
    for (let index = 0; index < ids.length; index += 900) {
      const chunk = ids.slice(index, index + 900);
      aggregateRows.push(...(await exec(
        db,
        `select beatmap_id, player_count, avg_pp, max_pp, dominant_mod
         from global_maps_farmed_aggregates
         where beatmap_id in (${sqlPlaceholders(chunk)})`,
        chunk,
      )).rows);
    }
  } else {
    aggregateRows.push(...(await exec(
      db,
      "select beatmap_id, player_count, avg_pp, max_pp, dominant_mod from global_maps_farmed_aggregates",
    )).rows);
  }

  const byBeatmap = new Map<number, StoredMapsFarmedEntry>();
  for (const row of aggregateRows) {
    const beatmapId = Number(row.beatmap_id);
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    byBeatmap.set(beatmapId, {
      beatmapId,
      playerCount: Number(row.player_count ?? 0),
      avgPp: Number(row.avg_pp ?? 0),
      maxPp: Number(row.max_pp ?? 0),
      dominantMod: row.dominant_mod === "DT" || row.dominant_mod === "HT" ? row.dominant_mod : null,
      players: [],
    });
  }
  if (byBeatmap.size === 0) return [];

  if (ids) {
    for (let index = 0; index < ids.length; index += 900) {
      const chunk = ids.slice(index, index + 900);
      const rows = (await exec(
        db,
        `select beatmap_id, user_id, pp, mods_json, score_url, played_at
         from global_maps_farmed_scores
         where beatmap_id in (${sqlPlaceholders(chunk)})
         order by beatmap_id asc, pp desc, user_id asc`,
        chunk,
      )).rows;
      appendGlobalMapsFarmedProjectionPlayers(byBeatmap, rows);
    }
  } else {
    let cursor = 0;
    for (;;) {
      const rows = (await exec(
        db,
        `select s.rowid as rid, s.beatmap_id, s.user_id, s.pp, s.mods_json, s.score_url, s.played_at
         from global_maps_farmed_scores s
         join global_maps_farmed_aggregates a on a.beatmap_id = s.beatmap_id
         where s.rowid > ?
         order by s.rowid
         limit ?`,
        [cursor, GLOBAL_MAPS_FARMED_ROWS_PAGE],
      )).rows;
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1].rid);
      appendGlobalMapsFarmedProjectionPlayers(byBeatmap, rows);
      await yieldToEventLoop();
      if (rows.length < GLOBAL_MAPS_FARMED_ROWS_PAGE) break;
    }
  }

  for (const entry of byBeatmap.values()) entry.players.sort((a, b) => b.pp - a.pp || a.id - b.id);
  return [...byBeatmap.values()].sort((a, b) => a.beatmapId - b.beatmapId);
}

function appendGlobalMapsFarmedProjectionPlayers(
  byBeatmap: Map<number, StoredMapsFarmedEntry>,
  rows: Record<string, unknown>[],
): void {
  for (const row of rows) {
    const entry = byBeatmap.get(Number(row.beatmap_id));
    if (!entry) continue;
    const userId = Number(row.user_id);
    const pp = Number(row.pp ?? 0);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(pp) || pp <= 0) continue;
    entry.players.push({
      id: userId,
      pp,
      mods: parseJson<string[]>(row.mods_json, []),
      scoreUrl: row.score_url == null ? null : String(row.score_url),
      playedAt: row.played_at == null ? null : String(row.played_at),
    });
  }
}

async function applyGlobalFarmedProjectionDeltas(
  db: Db,
  board: GlobalFarmedBoard,
  projectionState: GlobalMapsFarmedProjectionState,
): Promise<boolean> {
  const fromRevision = board.projectionRevision ?? 0;
  const changes = (await exec(
    db,
    `select beatmap_id, revision, updated_at
     from global_maps_farmed_changes
     where revision > ?
     order by revision, beatmap_id
     limit ?`,
    [fromRevision, GLOBAL_FARMED_PROJECTION_MAX_DELTA_MAPS + 1],
  )).rows;
  if (changes.length > GLOBAL_FARMED_PROJECTION_MAX_DELTA_MAPS) {
    logInfo("global_farmed_projection_delta_repack", {
      from_revision: fromRevision,
      to_revision: projectionState.revision,
      threshold_maps: GLOBAL_FARMED_PROJECTION_MAX_DELTA_MAPS,
    });
    return false;
  }
  if (changes.length === 0) {
    // An initialized-but-empty projection still advances the state revision.
    // Mark it observed so an empty GLOBAL board does not re-run this query on
    // every request forever.
    board.projectionRevision = Math.max(fromRevision, projectionState.revision);
    board.farmedGeneratedAt = projectionState.updatedAt;
    return true;
  }
  const beatmapIds = changes.map((row) => Number(row.beatmap_id));
  const entries = await readGlobalFarmedProjectionEntries(db, beatmapIds);
  const byBeatmap = new Map(entries.map((entry) => [entry.beatmapId, entry]));
  const metadata = await readMapsFarmedPageMetadataByIds(db, beatmapIds);
  for (const beatmapId of beatmapIds) {
    board.overrides.set(beatmapId, byBeatmap.get(beatmapId) ?? null);
    const meta = metadata.get(beatmapId);
    if (meta) board.metadata.set(beatmapId, meta);
    else board.metadata.delete(beatmapId);
  }
  board.projectionRevision = changes.reduce((latest, row) => {
    const revision = Number(row.revision ?? 0);
    return Number.isFinite(revision) ? Math.max(latest, revision) : latest;
  }, fromRevision);
  board.farmedGeneratedAt = projectionState.updatedAt;
  return true;
}

const GLOBAL_FARMED_SCORE_URL_PATTERN = /^https:\/\/osu\.ppy\.sh\/scores\/(\d+)$/;

function encodeGlobalFarmedBoard(
  generation: string,
  parsed: StoredCountryMapsData,
  source: StoredMapsFarmedEntry[],
  metadata: Map<number, MapsFarmedPageMetadata>,
): GlobalFarmedBoard {
  let total = 0;
  for (const entry of source) total += entry.players.length;

  const userIds = new Float64Array(total);
  const pps = new Float64Array(total);
  const modsIdx = new Uint32Array(total);
  const playedAtMs = new Float64Array(total);
  const scoreIds = new Float64Array(total);
  const scoreUrlOverrides = new Map<number, string>();
  const modsDict: string[][] = [];
  const modsFlags: number[] = [];
  const dictIndexByKey = new Map<string, number>();
  const entries: GlobalFarmedBoardEntry[] = [];

  let cursor = 0;
  for (const entry of source) {
    const start = cursor;
    for (const player of entry.players) {
      const mods = Array.isArray(player.mods) ? player.mods : [];
      const modsKey = JSON.stringify(mods);
      let dictIndex = dictIndexByKey.get(modsKey);
      if (dictIndex === undefined) {
        dictIndex = modsDict.length;
        dictIndexByKey.set(modsKey, dictIndex);
        modsDict.push([...mods]);
        modsFlags.push(
          (mods.includes("DT") || mods.includes("NC") ? GLOBAL_FARMED_MOD_FLAG_DT : 0)
          | (mods.includes("HT") ? GLOBAL_FARMED_MOD_FLAG_HT : 0),
        );
      }
      userIds[cursor] = player.id;
      pps[cursor] = player.pp;
      modsIdx[cursor] = dictIndex;
      const playedMs = player.playedAt == null ? Number.NaN : Date.parse(player.playedAt);
      playedAtMs[cursor] = Number.isFinite(playedMs) ? playedMs : Number.NaN;
      if (player.scoreUrl != null && player.scoreUrl !== "") {
        const match = GLOBAL_FARMED_SCORE_URL_PATTERN.exec(player.scoreUrl);
        const scoreId = match ? Number(match[1]) : Number.NaN;
        if (Number.isSafeInteger(scoreId) && scoreId > 0) scoreIds[cursor] = scoreId;
        else scoreUrlOverrides.set(cursor, player.scoreUrl);
      }
      cursor++;
    }
    entries.push({ beatmapId: entry.beatmapId, start, count: cursor - start });
  }

  return {
    generation,
    generatedAt: parsed.generatedAt,
    farmedGeneratedAt: parsed.farmedGeneratedAt,
    favouritesGeneratedAt: parsed.favouritesGeneratedAt,
    entries,
    userIds,
    pps,
    modsIdx,
    playedAtMs,
    scoreIds,
    scoreUrlOverrides,
    modsDict,
    modsFlags: Uint8Array.from(modsFlags),
    metadata,
    projectionRevision: null,
    overrides: new Map(),
  };
}

interface GlobalFarmedBoardRanked {
  beatmapId: number;
  boardIndex: number;
  overrideEntry?: StoredMapsFarmedEntry;
  /** Players meeting the pp filter — a prefix, since players sort by pp desc. */
  keptCount: number;
  playerCount: number;
  avgPp: number;
  maxPp: number;
  dominantMod: "DT" | "HT" | null;
  latestPlayedAtMs: number;
  stars: number;
}

// In-memory equivalent of filterSortStoredFarmedMapsForPage over the packed
// board; the aggregate/dominant/sort semantics must stay identical to it.
function filterSortGlobalFarmedBoard(board: GlobalFarmedBoard, query: MapsPageQuery): GlobalFarmedBoardRanked[] {
  const ranked: GlobalFarmedBoardRanked[] = [];
  const { entries, pps, modsIdx, modsFlags, playedAtMs, metadata } = board;

  for (let boardIndex = 0; boardIndex < entries.length; boardIndex++) {
    const entry = entries[boardIndex];
    if (board.overrides.has(entry.beatmapId)) continue;
    const meta = metadata.get(entry.beatmapId);
    if (!meta) continue;
    if (!matchesMapsKeyFilter(meta.cs, query.key)) continue;
    if (!matchesMapsSearch(query.q, [meta.title, meta.artist, meta.creator, meta.version])) continue;

    const start = entry.start;
    let kept = entry.count;
    if (query.pp > 0) {
      // Binary search for the first player below the threshold.
      let lo = 0;
      let hi = entry.count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pps[start + mid] >= query.pp) lo = mid + 1;
        else hi = mid;
      }
      kept = lo;
    }
    const maxPp = kept > 0 ? pps[start] : 0;
    if (kept < 2 && maxPp < FARMED_SINGLE_PLAYER_PP_MIN) continue;

    let ppSum = 0;
    let dtCount = 0;
    let htCount = 0;
    let latest = 0;
    for (let i = start; i < start + kept; i++) {
      ppSum += pps[i];
      const flags = modsFlags[modsIdx[i]];
      if (flags & GLOBAL_FARMED_MOD_FLAG_DT) dtCount++;
      else if (flags & GLOBAL_FARMED_MOD_FLAG_HT) htCount++;
      const played = playedAtMs[i];
      if (played > latest) latest = played;
    }

    let dominantMod: "DT" | "HT" | null = null;
    if (dtCount > 0 || htCount > 0) {
      if (dtCount >= htCount) {
        dominantMod = dtCount > kept * FARMED_DOMINANT_MOD_SHARE ? "DT" : null;
      } else if (
        htCount > kept * FARMED_DOMINANT_MOD_SHARE
        // The top-pp player (index `start`, players sorted desc) must itself
        // carry HT — same rule as getDominantStoredMapsSpeedMod.
        && (modsFlags[modsIdx[start]] & GLOBAL_FARMED_MOD_FLAG_HT) !== 0
      ) {
        dominantMod = "HT";
      }
    }

    if (query.mod !== "all") {
      if (query.mod === "dt" && dominantMod !== "DT") continue;
      if (query.mod === "ht" && dominantMod !== "HT") continue;
      if (query.mod !== "dt" && query.mod !== "ht" && dominantMod !== null) continue;
    }

    ranked.push({
      beatmapId: entry.beatmapId,
      boardIndex,
      keptCount: kept,
      playerCount: kept,
      avgPp: kept > 0 ? ppSum / kept : 0,
      maxPp,
      dominantMod,
      latestPlayedAtMs: latest,
      stars: meta.difficultyRating,
    });
  }

  for (const overrideEntry of board.overrides.values()) {
    if (!overrideEntry) continue;
    const meta = metadata.get(overrideEntry.beatmapId);
    if (!meta) continue;
    if (!matchesMapsKeyFilter(meta.cs, query.key)) continue;
    if (!matchesMapsSearch(query.q, [meta.title, meta.artist, meta.creator, meta.version])) continue;

    let kept = overrideEntry.players.length;
    if (query.pp > 0) {
      let lo = 0;
      let hi = overrideEntry.players.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (overrideEntry.players[mid].pp >= query.pp) lo = mid + 1;
        else hi = mid;
      }
      kept = lo;
    }
    const keptPlayers = overrideEntry.players.slice(0, kept);
    const maxPp = keptPlayers[0]?.pp ?? 0;
    if (kept < 2 && maxPp < FARMED_SINGLE_PLAYER_PP_MIN) continue;
    const dominantMod = getDominantStoredMapsSpeedMod(keptPlayers);
    if (query.mod !== "all") {
      if (query.mod === "dt" && dominantMod !== "DT") continue;
      if (query.mod === "ht" && dominantMod !== "HT") continue;
      if (query.mod !== "dt" && query.mod !== "ht" && dominantMod !== null) continue;
    }

    ranked.push({
      beatmapId: overrideEntry.beatmapId,
      boardIndex: -1,
      overrideEntry,
      keptCount: kept,
      playerCount: kept,
      avgPp: kept > 0 ? keptPlayers.reduce((sum, player) => sum + player.pp, 0) / kept : 0,
      maxPp,
      dominantMod,
      latestPlayedAtMs: getLatestStoredFarmedPlayTime({ ...overrideEntry, players: keptPlayers }),
      stars: meta.difficultyRating,
    });
  }

  const flip = query.dir === "asc" ? -1 : 1;
  return ranked.sort((a, b) => {
    if (query.farmedSort === "players") return (b.playerCount - a.playerCount) * flip || b.avgPp - a.avgPp;
    if (query.farmedSort === "avg-pp") return (b.avgPp - a.avgPp) * flip;
    if (query.farmedSort === "max-pp") return (b.maxPp - a.maxPp) * flip;
    if (query.farmedSort === "stars") return (b.stars - a.stars) * flip || b.playerCount - a.playerCount || b.avgPp - a.avgPp;
    return (b.latestPlayedAtMs - a.latestPlayedAtMs) * flip || b.playerCount - a.playerCount || b.avgPp - a.avgPp;
  });
}

// Unpack one page entry back into the stored shape the shared hydrate path
// expects; only the (up to pageSize) entries actually returned pay this.
// Players are capped at the preview size: every aggregate the downstream
// hydrate reads (playerCount/avgPp/maxPp/dominantMod) is precomputed here, and
// limitMapsPagePreviewPlayers truncates the response to the same cap, so
// materializing (and user-hydrating) a popular map's thousands of players
// would be pure waste.
function materializeGlobalFarmedBoardEntry(board: GlobalFarmedBoard, ranked: GlobalFarmedBoardRanked): StoredMapsFarmedEntry {
  if (ranked.overrideEntry) {
    return {
      beatmapId: ranked.overrideEntry.beatmapId,
      playerCount: ranked.playerCount,
      avgPp: ranked.avgPp,
      maxPp: ranked.maxPp,
      dominantMod: ranked.dominantMod,
      players: ranked.overrideEntry.players.slice(0, Math.min(ranked.keptCount, MAPS_PAGE_PREVIEW_PLAYERS)).map((player) => ({
        ...player,
        mods: [...player.mods],
      })),
    };
  }
  const entry = board.entries[ranked.boardIndex];
  const players: StoredMapsFarmedPlayer[] = [];
  const materializeCount = Math.min(ranked.keptCount, MAPS_PAGE_PREVIEW_PLAYERS);
  for (let i = entry.start; i < entry.start + materializeCount; i++) {
    const playedMs = board.playedAtMs[i];
    const scoreId = board.scoreIds[i];
    players.push({
      id: board.userIds[i],
      pp: board.pps[i],
      mods: [...board.modsDict[board.modsIdx[i]]],
      scoreUrl: scoreId > 0 ? `https://osu.ppy.sh/scores/${scoreId}` : board.scoreUrlOverrides.get(i) ?? null,
      // Source timestamps are whole-second "…SSZ" strings; strip the ms field
      // toISOString adds so round-tripped values match the originals.
      playedAt: Number.isFinite(playedMs) ? new Date(playedMs).toISOString().replace(".000Z", "Z") : null,
    });
  }
  return {
    beatmapId: entry.beatmapId,
    playerCount: ranked.playerCount,
    avgPp: ranked.avgPp,
    maxPp: ranked.maxPp,
    dominantMod: ranked.dominantMod,
    players,
  };
}

async function readGlobalFarmedEntriesForFilteredPage(
  db: Db,
  fallbackEntries: StoredCountryMapsData["farmed"],
): Promise<StoredMapsFarmedEntry[]> {
  const byBeatmap = new Map<number, Map<number, StoredMapsFarmedPlayer>>();

  for (const entry of fallbackEntries) {
    mergeStoredFarmedEntryPlayers(byBeatmap, entry.beatmapId, entry.players);
  }

  // Stream one country snapshot at a time (not a single `where country != ?`
  // blob read): each read holds only a short WAL read-mark and releases before
  // the next, so it can't pin the WAL for the whole multi-second GLOBAL fetch.
  const countryRows = (await exec(
    db,
    "select country from country_maps_snapshots where country != ? order by country",
    [GLOBAL_COUNTRY_CODE],
  )).rows;
  for (const countryRow of countryRows) {
    await yieldToEventLoop();
    const row = (await exec(
      db,
      "select payload_json from country_maps_snapshots where country = ?",
      [String(countryRow.country)],
    )).rows[0];
    const stored = row ? toStoredCountryMapsData(parseJson<unknown>(row.payload_json, null)) : null;
    if (!stored) continue;
    for (const entry of stored.farmed) {
      mergeStoredFarmedEntryPlayers(byBeatmap, entry.beatmapId, entry.players);
    }
  }

  // Farmed-score rows (>1M on prod) paged by rowid for the same reason.
  let cursor = 0;
  for (;;) {
    const page = (await exec(
      db,
      `select rowid as rid, beatmap_id, user_id, pp, mods_json, score_url, played_at
       from country_maps_farmed_scores
       where rowid > ? and country != ?
       order by rowid
       limit ?`,
      [cursor, GLOBAL_COUNTRY_CODE, GLOBAL_MAPS_FARMED_ROWS_PAGE],
    )).rows;
    if (page.length === 0) break;
    for (const row of page) {
      cursor = Number(row.rid);
      const beatmapId = Number(row.beatmap_id);
      const userId = Number(row.user_id);
      const pp = Number(row.pp ?? 0);
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0 || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(pp) || pp <= 0) {
        continue;
      }
      mergeStoredFarmedEntryPlayers(byBeatmap, beatmapId, [{
        id: userId,
        pp,
        mods: parseJson<string[]>(row.mods_json, []),
        scoreUrl: row.score_url == null ? null : String(row.score_url),
        playedAt: row.played_at == null ? null : String(row.played_at),
      }]);
    }
    await yieldToEventLoop();
    if (page.length < GLOBAL_MAPS_FARMED_ROWS_PAGE) break;
  }

  return [...byBeatmap.entries()]
    .flatMap(([beatmapId, playerMap]): StoredMapsFarmedEntry[] => {
      const players = [...playerMap.values()].sort((a, b) => b.pp - a.pp);
      const maxPp = players.reduce((max, player) => Math.max(max, player.pp), 0);
      if (players.length < 2 && maxPp < FARMED_SINGLE_PLAYER_PP_MIN) return [];
      return [{
        beatmapId,
        playerCount: players.length,
        avgPp: players.reduce((sum, player) => sum + player.pp, 0) / players.length,
        maxPp,
        dominantMod: getDominantStoredMapsSpeedMod(players),
        players,
      }];
    });
}

function mergeStoredFarmedEntryPlayers(
  byBeatmap: Map<number, Map<number, StoredMapsFarmedPlayer>>,
  beatmapId: number,
  incomingPlayers: StoredMapsFarmedPlayer[],
): void {
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) return;
  let players = byBeatmap.get(beatmapId);
  if (!players) byBeatmap.set(beatmapId, (players = new Map()));

  for (const incoming of incomingPlayers) {
    const userId = Number(incoming.id);
    const pp = Number(incoming.pp ?? 0);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(pp) || pp <= 0) continue;
    const player: StoredMapsFarmedPlayer = {
      id: userId,
      pp,
      mods: Array.isArray(incoming.mods) ? incoming.mods : [],
      scoreUrl: incoming.scoreUrl ?? null,
      playedAt: incoming.playedAt ?? null,
    };
    const existing = players.get(userId);
    if (!existing || player.pp > existing.pp || (player.pp === existing.pp && (player.playedAt ?? "") > (existing.playedAt ?? ""))) {
      players.set(userId, player);
    }
  }
}

async function hydrateCompactFarmedEntries(
  db: Db,
  entries: StoredCountryMapsData["farmed"],
): Promise<MapsFarmedEntry[]> {
  const beatmaps = await readMapsBeatmapsByIds(db, entries.map((entry) => entry.beatmapId));
  const beatmapsets = await readMapsBeatmapsetsByIds(db, [...new Set([...beatmaps.values()].map((beatmap) => beatmap.beatmapsetId))]);

  return entries.flatMap((entry): MapsFarmedEntry[] => {
    const beatmap = beatmaps.get(entry.beatmapId);
    const beatmapset = beatmap ? beatmapsets.get(beatmap.beatmapsetId) : undefined;
    if (!isNativeManiaMapsBeatmap(beatmap) || !beatmapset) return [];
    return [{
      beatmapId: entry.beatmapId,
      version: beatmap.version,
      difficultyRating: beatmap.difficultyRating,
      totalLength: beatmap.totalLength,
      cs: beatmap.cs,
      bpm: beatmap.bpm,
      beatmapsetId: beatmap.beatmapsetId,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      covers: beatmapset.covers,
      status: beatmapset.status || beatmap.status,
      playerCount: Number(entry.playerCount ?? entry.players.length),
      players: entry.players.map((player) => ({
        id: player.id,
        username: "",
        avatarUrl: "",
        mods: player.mods ?? [],
        pp: Number(player.pp ?? 0),
        scoreUrl: player.scoreUrl,
        playedAt: player.playedAt,
      })),
      avgPp: Number(entry.avgPp ?? 0),
      maxPp: Number(entry.maxPp ?? 0),
      dominantMod: entry.dominantMod,
    }];
  });
}

async function hydrateCompactMostPlayedEntries(
  db: Db,
  entries: StoredCountryMapsData["mostPlayed"],
): Promise<MapsAggregatedBeatmap[]> {
  const beatmaps = await readMapsBeatmapsByIds(db, entries.map((entry) => entry.beatmapId));
  const beatmapsets = await readMapsBeatmapsetsByIds(db, [...new Set([...beatmaps.values()].map((beatmap) => beatmap.beatmapsetId))]);

  return entries.flatMap((entry): MapsAggregatedBeatmap[] => {
    const beatmap = beatmaps.get(entry.beatmapId);
    const beatmapset = beatmap ? beatmapsets.get(beatmap.beatmapsetId) : undefined;
    if (!isNativeManiaMapsBeatmap(beatmap) || !beatmapset) return [];
    return [{
      beatmapId: entry.beatmapId,
      version: beatmap.version,
      difficultyRating: beatmap.difficultyRating,
      totalLength: beatmap.totalLength,
      beatmapsetId: beatmap.beatmapsetId,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      covers: beatmapset.covers,
      status: beatmapset.status || beatmap.status,
      globalPlayCount: beatmapset.globalPlayCount,
      totalPlays: Number(entry.totalPlays ?? 0),
      playerCount: Number(entry.playerCount ?? entry.players.length),
      players: entry.players.map((player) => ({
        id: player.id,
        username: "",
        avatarUrl: "",
        count: Number(player.count ?? 0),
      })),
    }];
  });
}

async function hydrateCompactFavouriteEntries(
  db: Db,
  entries: StoredCountryMapsData["favourites"],
): Promise<MapsAggregatedFavourite[]> {
  const beatmapsets = await readMapsBeatmapsetsByIds(db, entries.map((entry) => entry.beatmapsetId));

  return entries.flatMap((entry): MapsAggregatedFavourite[] => {
    const beatmapset = beatmapsets.get(entry.beatmapsetId);
    if (!beatmapset) return [];
    return [{
      beatmapsetId: entry.beatmapsetId,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      covers: beatmapset.covers,
      status: beatmapset.status,
      globalPlayCount: beatmapset.globalPlayCount,
      globalFavouriteCount: beatmapset.globalFavouriteCount,
      playerCount: Number(entry.playerCount ?? entry.players.length),
      players: entry.players.map((player) => ({ id: player.id, username: "", avatarUrl: "" })),
    }];
  });
}

type MapsPageItem = MapsFarmedEntry | MapsAggregatedBeatmap | MapsAggregatedFavourite;

function limitMapsPagePreviewPlayers<T extends MapsPageItem>(items: T[]): T[] {
  return items.map((item) => {
    const players = item.players.slice(0, MAPS_PAGE_PREVIEW_PLAYERS);
    const covers = trimMapsPageCovers(item.covers);
    if ("avgPp" in item) {
      return {
        ...item,
        covers,
        dominantMod: resolveStoredDominantMod(item.dominantMod, () => getDominantMapsSpeedMod(item.players)),
        players,
      };
    }
    return { ...item, covers, players };
  }) as T[];
}

function trimMapsPageCovers(covers: Record<string, string | undefined>): Record<string, string | undefined> {
  const card = covers.card ?? covers.cover ?? covers.list ?? covers["list@2x"] ?? "";
  return card ? { card } : {};
}

async function hydrateMapsPageItemUsers<T extends MapsPageItem>(db: Db, items: T[]): Promise<T[]> {
  const ids = new Set<number>();
  for (const item of items) {
    for (const player of item.players) {
      if (Number.isSafeInteger(player.id) && player.id > 0) ids.add(player.id);
    }
  }
  if (ids.size === 0) return items;

  const users = await readMapsUserDisplayByIds(db, [...ids]);
  for (const item of items) {
    for (const player of item.players) {
      const user = users.get(player.id);
      if (!user) continue;
      if (user.username) player.username = user.username;
      if (user.avatarUrl) player.avatarUrl = user.avatarUrl;
    }
  }
  return items;
}

async function readMapsUserDisplayByIds(
  db: Db,
  ids: number[],
): Promise<Map<number, { username: string; avatarUrl: string }>> {
  const rows = await selectRowsByIntegerSet(
    db,
    "select user_id, username, avatar_url from users where user_id in",
    ids,
  );
  return new Map(rows.map((row) => [
    Number(row.user_id),
    {
      username: String(row.username ?? ""),
      avatarUrl: String(row.avatar_url ?? ""),
    },
  ]));
}

function filterSortMapsPageItems(value: CountryMapsData, query: MapsPageQuery): MapsPageItem[] {
  if (query.tab === "farmed") return filterSortFarmedMaps(value.farmed, query);
  if (query.tab === "popular") return filterSortMostPlayedMaps(value.mostPlayed, query);
  return filterSortFavouriteMaps(value.favourites, query);
}

function filterSortFarmedMaps(items: MapsFarmedEntry[], query: MapsPageQuery): MapsFarmedEntry[] {
  return items
    .map((entry) => {
      if (query.pp <= 0) return entry;
      const players = entry.players.filter((player) => player.pp >= query.pp);
      const maxPp = Math.max(...players.map((player) => player.pp), 0);
      if (players.length < 2 && maxPp < FARMED_SINGLE_PLAYER_PP_MIN) return null;
      return {
        ...entry,
        players,
        playerCount: players.length,
        avgPp: players.reduce((sum, player) => sum + player.pp, 0) / players.length,
        maxPp,
        // pp filter narrows the roster, so recompute the dominant over the kept players.
        dominantMod: getDominantMapsSpeedMod(players),
      };
    })
    .filter((entry): entry is MapsFarmedEntry => {
      if (entry === null) return false;
      if (!matchesMapsKeyFilter(entry.cs, query.key)) return false;
      if (!matchesMapsSearch(query.q, [entry.title, entry.artist, entry.creator, entry.version])) return false;
      if (query.mod === "all") return true;
      const dominant = resolveStoredDominantMod(entry.dominantMod, () => getDominantMapsSpeedMod(entry.players));
      if (query.mod === "dt") return dominant === "DT";
      if (query.mod === "ht") return dominant === "HT";
      return dominant === null;
    })
    .sort((a, b) => {
      const flip = query.dir === "asc" ? -1 : 1;
      if (query.farmedSort === "players") return (b.playerCount - a.playerCount) * flip || b.avgPp - a.avgPp;
      if (query.farmedSort === "avg-pp") return (b.avgPp - a.avgPp) * flip;
      if (query.farmedSort === "max-pp") return (b.maxPp - a.maxPp) * flip;
      if (query.farmedSort === "recent") {
        return (getLatestFarmedPlayTime(b) - getLatestFarmedPlayTime(a)) * flip || b.playerCount - a.playerCount || b.avgPp - a.avgPp;
      }
      return (b.difficultyRating - a.difficultyRating) * flip;
    });
}

export interface MapsFarmedPageMetadata {
  beatmapId: number;
  cs: number;
  difficultyRating: number;
  version: string;
  title: string;
  artist: string;
  creator: string;
  status: string;
}

async function filterSortStoredFarmedMapsForPage(
  db: Db,
  items: StoredMapsFarmedEntry[],
  query: MapsPageQuery,
): Promise<StoredMapsFarmedEntry[]> {
  const metadata = await readMapsFarmedPageMetadataByIds(db, items.map((entry) => entry.beatmapId));
  return items
    .map((entry) => {
      if (query.pp <= 0) return entry;
      const players = entry.players.filter((player) => Number(player.pp ?? 0) >= query.pp);
      const maxPp = Math.max(...players.map((player) => Number(player.pp ?? 0)), 0);
      if (players.length < 2 && maxPp < FARMED_SINGLE_PLAYER_PP_MIN) return null;
      return {
        ...entry,
        players,
        playerCount: players.length,
        avgPp: players.length > 0
          ? players.reduce((sum, player) => sum + Number(player.pp ?? 0), 0) / players.length
          : 0,
        maxPp,
        // pp filter narrows the roster, so recompute the dominant over the kept players.
        dominantMod: getDominantStoredMapsSpeedMod(players),
      };
    })
    .filter((entry): entry is StoredMapsFarmedEntry => {
      if (!entry) return false;
      const meta = metadata.get(entry.beatmapId);
      if (!meta) return false;
      if (!matchesMapsKeyFilter(meta.cs, query.key)) return false;
      if (!matchesMapsSearch(query.q, [meta.title, meta.artist, meta.creator, meta.version])) return false;
      if (query.mod === "all") return true;
      const dominant = resolveStoredDominantMod(entry.dominantMod, () => getDominantStoredMapsSpeedMod(entry.players));
      if (query.mod === "dt") return dominant === "DT";
      if (query.mod === "ht") return dominant === "HT";
      return dominant === null;
    })
    .sort((a, b) => {
      const flip = query.dir === "asc" ? -1 : 1;
      const aPlayerCount = Number(a.playerCount ?? a.players.length);
      const bPlayerCount = Number(b.playerCount ?? b.players.length);
      const aAvgPp = Number(a.avgPp ?? 0);
      const bAvgPp = Number(b.avgPp ?? 0);
      const aMaxPp = Number(a.maxPp ?? 0);
      const bMaxPp = Number(b.maxPp ?? 0);
      if (query.farmedSort === "players") return (bPlayerCount - aPlayerCount) * flip || bAvgPp - aAvgPp;
      if (query.farmedSort === "avg-pp") return (bAvgPp - aAvgPp) * flip;
      if (query.farmedSort === "max-pp") return (bMaxPp - aMaxPp) * flip;
      if (query.farmedSort === "stars") {
        const aStars = metadata.get(a.beatmapId)?.difficultyRating ?? 0;
        const bStars = metadata.get(b.beatmapId)?.difficultyRating ?? 0;
        return (bStars - aStars) * flip || bPlayerCount - aPlayerCount || bAvgPp - aAvgPp;
      }
      return (getLatestStoredFarmedPlayTime(b) - getLatestStoredFarmedPlayTime(a)) * flip || bPlayerCount - aPlayerCount || bAvgPp - aAvgPp;
    });
}

function filterSortMostPlayedMaps(items: MapsAggregatedBeatmap[], query: MapsPageQuery): MapsAggregatedBeatmap[] {
  return items
    .filter((entry) =>
      matchesMapsKeyFilter(parseMapsKeyCount(entry.version), query.key) &&
      matchesMapsSearch(query.q, [entry.title, entry.artist, entry.creator, entry.version]),
    )
    .sort((a, b) => {
      const flip = query.dir === "asc" ? -1 : 1;
      if (query.beatmapSort === "plays") return (b.totalPlays - a.totalPlays) * flip;
      if (query.beatmapSort === "players") return (b.playerCount - a.playerCount) * flip || b.totalPlays - a.totalPlays;
      if (query.beatmapSort === "stars") return (b.difficultyRating - a.difficultyRating) * flip;
      return (b.totalLength - a.totalLength) * flip;
    });
}

function filterSortFavouriteMaps(items: MapsAggregatedFavourite[], query: MapsPageQuery): MapsAggregatedFavourite[] {
  return items
    .filter((entry) =>
      matchesMapsStatusFilter(entry.status, query.status) &&
      matchesMapsSearch(query.q, [entry.title, entry.artist, entry.creator]),
    )
    .sort((a, b) => b.playerCount - a.playerCount || b.globalFavouriteCount - a.globalFavouriteCount);
}

function parseMapsKeyCount(version: string): number | null {
  const match = version.match(/\b(\d)K\b/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function matchesMapsKeyFilter(keyCount: number | null, filter: MapsKeyFilter): boolean {
  if (filter === "all") return true;
  if (filter === "4k") return keyCount === 4;
  if (filter === "7k") return keyCount === 7;
  return keyCount !== null && keyCount !== 4 && keyCount !== 7;
}

function matchesMapsStatusFilter(status: string, filter: MapsStatusFilter): boolean {
  const normalized = status.toLowerCase();
  if (filter === "all") return true;
  if (filter === "ranked") return normalized === "ranked" || normalized === "approved";
  if (filter === "loved") return normalized === "loved";
  if (filter === "graveyard") return normalized === "graveyard";
  return normalized !== "ranked" && normalized !== "approved" && normalized !== "loved" && normalized !== "graveyard";
}

function matchesMapsSearch(query: string, fields: Array<string | null | undefined>): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(normalized));
}

function getLatestFarmedPlayTime(entry: MapsFarmedEntry): number {
  return entry.players.reduce((latest, player) => {
    const time = new Date(player.playedAt ?? 0).getTime();
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
}

function getLatestStoredFarmedPlayTime(entry: StoredMapsFarmedEntry): number {
  return entry.players.reduce((latest, player) => {
    const time = new Date(player.playedAt ?? 0).getTime();
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
}

// A stored dominant mod is computed over the full roster (before Global truncates
// each entry's players to the top GLOBAL_MAPS_PLAYERS_PER_ENTRY by pp), so it is
// authoritative. null is a real value ("no dominant mod") and must be preserved;
// only undefined ("not computed", e.g. a pre-fix snapshot) falls back to deriving
// the mod from whatever players are on hand, which on Global is a pp-skewed sample.
function resolveStoredDominantMod(
  stored: "DT" | "HT" | null | undefined,
  recompute: () => "DT" | "HT" | null,
): "DT" | "HT" | null {
  return stored === undefined ? recompute() : stored;
}

function getDominantMapsSpeedMod(players: MapsFarmedEntry["players"]): "DT" | "HT" | null {
  if (players.length === 0) return null;
  let dtCount = 0;
  let htCount = 0;
  for (const player of players) {
    const mods = player.mods ?? [];
    if (mods.includes("DT") || mods.includes("NC")) dtCount++;
    else if (mods.includes("HT")) htCount++;
  }

  if (dtCount === 0 && htCount === 0) return null;
  if (dtCount >= htCount) return dtCount > players.length * FARMED_DOMINANT_MOD_SHARE ? "DT" : null;
  if (htCount > players.length * FARMED_DOMINANT_MOD_SHARE) {
    const topPlayer = players.reduce((best, player) => (player.pp > best.pp ? player : best), players[0]);
    if ((topPlayer.mods ?? []).includes("HT")) return "HT";
  }
  return null;
}

function getDominantStoredMapsSpeedMod(players: StoredMapsFarmedPlayer[]): "DT" | "HT" | null {
  if (players.length === 0) return null;
  let dtCount = 0;
  let htCount = 0;
  for (const player of players) {
    const mods = player.mods ?? [];
    if (mods.includes("DT") || mods.includes("NC")) dtCount++;
    else if (mods.includes("HT")) htCount++;
  }

  if (dtCount === 0 && htCount === 0) return null;
  if (dtCount >= htCount) return dtCount > players.length * FARMED_DOMINANT_MOD_SHARE ? "DT" : null;
  if (htCount > players.length * FARMED_DOMINANT_MOD_SHARE) {
    const topPlayer = players.reduce((best, player) => (Number(player.pp ?? 0) > Number(best.pp ?? 0) ? player : best), players[0]);
    if ((topPlayer.mods ?? []).includes("HT")) return "HT";
  }
  return null;
}

async function hasActiveMapsRefresh(db: Db, country: string): Promise<boolean> {
  const now = nowIso();
  const row = (await exec(
    db,
    `select 1 as active
     from jobs
     where dedupe_key = ?
       and (status in ('queued', 'running') or (status = 'failed' and run_after > ?))
     limit 1`,
    [`maps:${country.toUpperCase()}`, now],
  )).rows[0];
  return !!row;
}

async function readActiveMapsRefreshProgress(db: Db, country: string): Promise<MapsRefreshProgress | null> {
  const normalized = country.toUpperCase();
  const stored = await readStoredMapsRefreshProgress(db, normalized);
  const now = nowIso();
  const job = (await exec(
    db,
    `select status, run_after, updated_at, last_error
     from jobs
     where dedupe_key = ?
       and (status in ('queued', 'running') or (status = 'failed' and run_after > ?))
     order by updated_at desc
     limit 1`,
    [`maps:${normalized}`, now],
  )).rows[0];
  if (!job) return stored?.status === "running" || stored?.status === "queued" ? stored : null;
  if (stored && stored.status !== "done" && stored.status !== "failed") return stored;

  const updatedAt = String(job.updated_at ?? now);
  const failedRetry = String(job.status) === "failed";
  return {
    country: normalized,
    status: String(job.status) === "running" ? "running" : "queued",
    stage: "queued",
    percent: 0,
    completedUnits: 0,
    totalUnits: 0,
    farmedCompleted: 0,
    farmedTotal: 0,
    favouritesCompleted: 0,
    favouritesTotal: 0,
    message: failedRetry ? "Waiting to retry maps build..." : "Queued maps build...",
    startedAt: updatedAt,
    updatedAt,
    finishedAt: null,
    error: failedRetry && job.last_error != null ? String(job.last_error) : null,
  };
}

async function readStoredMapsRefreshProgress(db: Db, country: string): Promise<MapsRefreshProgress | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [mapsRefreshProgressMetaKey(country)])).rows[0];
  return normalizeMapsRefreshProgress(parseJson<unknown>(row?.value_json, null), country);
}

function normalizeMapsRefreshProgress(value: unknown, country: string): MapsRefreshProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<MapsRefreshProgress>;
  const status = candidate.status;
  const stage = candidate.stage;
  if (status !== "queued" && status !== "running" && status !== "done" && status !== "failed") return null;
  if (stage !== "queued" && stage !== "fetching" && stage !== "persisting" && stage !== "done" && stage !== "failed") return null;
  const totalUnits = safeProgressNumber(candidate.totalUnits);
  const completedUnits = Math.min(totalUnits, safeProgressNumber(candidate.completedUnits));
  const updatedAt = typeof candidate.updatedAt === "string" && candidate.updatedAt ? candidate.updatedAt : nowIso();
  const startedAt = typeof candidate.startedAt === "string" && candidate.startedAt ? candidate.startedAt : updatedAt;
  return {
    country: country.toUpperCase(),
    status,
    stage,
    percent: Math.max(0, Math.min(100, Number(candidate.percent ?? 0))),
    completedUnits,
    totalUnits,
    farmedCompleted: safeProgressNumber(candidate.farmedCompleted),
    farmedTotal: safeProgressNumber(candidate.farmedTotal),
    favouritesCompleted: safeProgressNumber(candidate.favouritesCompleted),
    favouritesTotal: safeProgressNumber(candidate.favouritesTotal),
    message: typeof candidate.message === "string" && candidate.message ? candidate.message : "Building maps...",
    startedAt,
    updatedAt,
    finishedAt: typeof candidate.finishedAt === "string" && candidate.finishedAt ? candidate.finishedAt : null,
    error: typeof candidate.error === "string" && candidate.error ? candidate.error : null,
  };
}

function safeProgressNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

async function writeMapsRefreshProgress(db: Db, progress: MapsRefreshProgress): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [mapsRefreshProgressMetaKey(progress.country), json(progress), progress.updatedAt],
  );
}

function mapsRefreshProgressMetaKey(country: string): string {
  return `${MAPS_REFRESH_PROGRESS_META_PREFIX}${country.toUpperCase()}`;
}

class MapsRefreshProgressReporter {
  private status: MapsRefreshProgressStatus = "running";
  private stage: MapsRefreshProgressStage = "fetching";
  private farmedCompleted = 0;
  private favouritesCompleted = 0;
  private readonly startedAt = nowIso();
  private finishedAt: string | null = null;
  private error: string | null = null;
  private lastWriteMs = 0;
  private lastPercent = 0;
  private writeChain = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly country: string,
    private readonly totalUsers: number,
  ) {}

  start(): Promise<void> {
    return this.write(true);
  }

  markUserDone(section: "farmed" | "favourites"): Promise<void> {
    if (section === "farmed") {
      this.farmedCompleted = Math.min(this.totalUsers, this.farmedCompleted + 1);
    } else {
      this.favouritesCompleted = Math.min(this.totalUsers, this.favouritesCompleted + 1);
    }
    return this.write(false);
  }

  markSectionDone(section: "farmed" | "favourites"): Promise<void> {
    if (section === "farmed") this.farmedCompleted = this.totalUsers;
    else this.favouritesCompleted = this.totalUsers;
    return this.write(true);
  }

  markPersisting(): Promise<void> {
    this.stage = "persisting";
    return this.write(true);
  }

  markDone(): Promise<void> {
    this.status = "done";
    this.stage = "done";
    this.farmedCompleted = this.totalUsers;
    this.favouritesCompleted = this.totalUsers;
    this.finishedAt = nowIso();
    this.error = null;
    return this.write(true);
  }

  markFailed(error: unknown): Promise<void> {
    this.status = "failed";
    this.stage = "failed";
    this.finishedAt = nowIso();
    this.error = error instanceof Error ? error.message : String(error);
    return this.write(true);
  }

  private write(force: boolean): Promise<void> {
    const nowMs = Date.now();
    if (!force && nowMs - this.lastWriteMs < MAPS_REFRESH_PROGRESS_WRITE_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastWriteMs = nowMs;
    const snapshot = this.snapshot();
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => writeMapsRefreshProgress(this.db, snapshot))
      .catch(() => {});
    return this.writeChain;
  }

  private snapshot(): MapsRefreshProgress {
    const totalUnits = this.totalUsers * 2;
    const completedUnits = Math.min(totalUnits, this.farmedCompleted + this.favouritesCompleted);
    let percent = totalUnits > 0 ? (completedUnits / totalUnits) * 96 : 0;
    if (this.stage === "persisting") percent = Math.max(percent, 98);
    if (this.status === "done") percent = 100;
    if (this.status === "failed") percent = this.lastPercent;
    percent = Math.max(this.lastPercent, Math.min(100, percent));
    this.lastPercent = percent;
    return {
      country: this.country.toUpperCase(),
      status: this.status,
      stage: this.stage,
      percent,
      completedUnits,
      totalUnits,
      farmedCompleted: this.farmedCompleted,
      farmedTotal: this.totalUsers,
      favouritesCompleted: this.favouritesCompleted,
      favouritesTotal: this.totalUsers,
      message: this.message(),
      startedAt: this.startedAt,
      updatedAt: nowIso(),
      finishedAt: this.finishedAt,
      error: this.error,
    };
  }

  private message(): string {
    if (this.status === "done") return "Maps ready.";
    if (this.status === "failed") return "Maps build failed.";
    if (this.stage === "persisting") return "Saving maps...";
    if (this.farmedCompleted >= this.totalUsers && this.favouritesCompleted < this.totalUsers) return "Loading favorites...";
    if (this.favouritesCompleted >= this.totalUsers && this.farmedCompleted < this.totalUsers) return "Loading top scores...";
    return "Building maps...";
  }
}

export async function refreshCountryMaps(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow" | "getUserMostPlayed" | "getUserFavourites">,
  queue: JobQueue,
  payload: { country: string },
): Promise<CountryMapsData> {
  const country = payload.country.toUpperCase();
  const users = await getMapsUsers(db, country);
  if (users.length === 0) throw new MapsRosterNotReadyError(country);
  const progress = new MapsRefreshProgressReporter(db, country, users.length);
  await progress.start();
  const emptyGeneratedAt = nowIso();
  let latestFarmed: CountryMapsFarmedSection = { farmed: [], generatedAt: emptyGeneratedAt };
  let latestFavourites: CountryMapsFavouritesSection = {
    mostPlayed: [],
    favourites: [],
    favouritesByPlayer: [],
    beatmapsetsPool: {},
    generatedAt: emptyGeneratedAt,
  };
  let persistChain = Promise.resolve();
  const persistLatest = () => {
    const value = composeCountryMapsData(latestFarmed, latestFavourites);
    persistChain = persistChain.then(() => persistMapsSnapshot(db, country, value));
    return persistChain;
  };

  try {
    const farmedPromise = buildCountryFarmed(db, osu, queue, country, users, progress).then(async (section) => {
      latestFarmed = section;
      await progress.markSectionDone("farmed");
      await persistLatest();
      return section;
    });
    const favouritesPromise = buildCountryFavourites(db, osu, country, users, progress).then(async (section) => {
      latestFavourites = section;
      await progress.markSectionDone("favourites");
      await persistLatest();
      return section;
    });

    const [farmedSection, favSection] = await Promise.all([farmedPromise, favouritesPromise]);
    await progress.markPersisting();
    const value = composeCountryMapsData(farmedSection, favSection);
    assertUsableMapsData(value, country, users.length);
    await persistMapsSnapshot(db, country, value);
    await progress.markDone();
    return value;
  } catch (error) {
    await progress.markFailed(error);
    throw error;
  }
}

// Global keeps real aggregate counts but stores only enough per-map players for
// card previews. Full modal lists are loaded lazily from country snapshots /
// farmed-score rows through /api/snapshots/maps-players.
const GLOBAL_MAPS_PLAYERS_PER_ENTRY = 80;

interface GlobalMapsFarmedProjectionState {
  initialized: boolean;
  revision: number;
  seedEpoch: number;
  updatedAt: string;
}

async function readGlobalMapsFarmedProjectionState(db: Db): Promise<GlobalMapsFarmedProjectionState | null> {
  const row = (await exec(
    db,
    "select initialized, revision, seed_epoch, updated_at from global_maps_farmed_state where singleton = 1",
  )).rows[0];
  if (!row) return null;
  return {
    initialized: Number(row.initialized ?? 0) === 1,
    revision: Math.max(0, Number(row.revision ?? 0)),
    seedEpoch: Math.max(0, Number(row.seed_epoch ?? 0)),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapsFarmedSpeedMod(mods: string[]): "DT" | "HT" | null {
  if (mods.includes("DT") || mods.includes("NC")) return "DT";
  if (mods.includes("HT")) return "HT";
  return null;
}

function mapsFarmedSpeedModSql(alias: string): string {
  return `case
    when exists (select 1 from json_each(coalesce(${alias}.mods_json, '[]')) where value in ('DT', 'NC')) then 'DT'
    when exists (select 1 from json_each(coalesce(${alias}.mods_json, '[]')) where value = 'HT') then 'HT'
    else null
  end`;
}

function publishGlobalMapsFarmedRevisionStatement(updatedAt: string, initialized = false): DbStatement {
  return {
    sql: `insert into global_maps_farmed_state (singleton, initialized, revision, updated_at)
          values (1, ?, 1, ?)
          on conflict(singleton) do update set
            initialized = max(global_maps_farmed_state.initialized, excluded.initialized),
            revision = global_maps_farmed_state.revision + 1,
            updated_at = max(global_maps_farmed_state.updated_at, excluded.updated_at)`,
    args: [initialized ? 1 : 0, updatedAt],
  };
}

function rebuildGlobalMapsFarmedAggregateStatements(
  beatmapId: number,
  updatedAt: string,
): DbStatement[] {
  return [
    { sql: "delete from global_maps_farmed_aggregates where beatmap_id = ?", args: [beatmapId] },
    {
      sql: `insert into global_maps_farmed_aggregates
         (beatmap_id, player_count, pp_sum, avg_pp, max_pp, dominant_mod, revision, updated_at)
       select
         s.beatmap_id,
         count(*) as player_count,
         sum(s.pp) as pp_sum,
         avg(s.pp) as avg_pp,
         max(s.pp) as max_pp,
         case
           when sum(case when s.speed_mod = 'DT' then 1 else 0 end) >= sum(case when s.speed_mod = 'HT' then 1 else 0 end)
             and sum(case when s.speed_mod = 'DT' then 1 else 0 end) > count(*) * ? then 'DT'
           when sum(case when s.speed_mod = 'HT' then 1 else 0 end) > sum(case when s.speed_mod = 'DT' then 1 else 0 end)
             and sum(case when s.speed_mod = 'HT' then 1 else 0 end) > count(*) * ?
             and (select top.speed_mod
                  from global_maps_farmed_scores top
                  where top.beatmap_id = s.beatmap_id
                  order by top.pp desc, top.user_id asc
                  limit 1) = 'HT' then 'HT'
           else null
         end,
         (select revision from global_maps_farmed_state where singleton = 1), ?
       from global_maps_farmed_scores s
       where s.beatmap_id = ?
       group by s.beatmap_id
       having count(*) >= 2 or max(s.pp) >= ?`,
      args: [FARMED_DOMINANT_MOD_SHARE, FARMED_DOMINANT_MOD_SHARE, updatedAt, beatmapId, FARMED_SINGLE_PLAYER_PP_MIN],
    },
    {
      sql: `insert into global_maps_farmed_changes (beatmap_id, revision, updated_at)
            select ?, revision, ? from global_maps_farmed_state where singleton = 1
            on conflict(beatmap_id) do update set revision = excluded.revision, updated_at = excluded.updated_at`,
      args: [beatmapId, updatedAt],
    },
  ];
}

// Reconcile only one player's rows on the maps their country overlay changed.
// The normalized country table remains the source of truth; this projection is
// disposable and can always be rebuilt by refreshGlobalMaps(). Exported for the
// admin wipe-user-data purge: after the country rows are deleted, this removes
// the user's global rows, rebuilds the touched per-beatmap aggregates, and
// publishes the revision + per-beatmap changes that make every serving
// process's packed in-memory board (and its disk cache) catch up.
export async function syncGlobalMapsFarmedUserBeatmaps(
  db: Db,
  userId: number,
  beatmapIds: number[],
  updatedAt: string,
): Promise<void> {
  const ids = [...new Set(beatmapIds)]
    .filter((beatmapId) => Number.isSafeInteger(beatmapId) && beatmapId > 0);
  if (ids.length === 0) return;

  for (let index = 0; index < ids.length; index += GLOBAL_MAPS_FARMED_PROJECTION_BATCH) {
    const chunk = ids.slice(index, index + GLOBAL_MAPS_FARMED_PROJECTION_BATCH);
    // SQLite serializes these transactions. Publishing the revision inside the
    // same batch as its rows means commit order and revision order are always
    // identical, even when live ingest and a bulk top-200 replace overlap.
    const statements: DbStatement[] = [publishGlobalMapsFarmedRevisionStatement(updatedAt)];
    for (const beatmapId of chunk) {
      statements.push({
        sql: `insert into global_maps_farmed_scores
           (beatmap_id, user_id, pp, mods_json, speed_mod, score_url, played_at, detected_at, source_country, source_updated_at, accuracy, note_count)
         select s.beatmap_id, s.user_id, s.pp, s.mods_json, ${mapsFarmedSpeedModSql("s")},
                s.score_url, s.played_at, s.detected_at, s.country, s.updated_at, s.accuracy, s.note_count
         from country_maps_farmed_scores s
         where s.country != ? and s.user_id = ? and s.beatmap_id = ? and s.pp > 0
         order by s.pp desc, s.detected_at desc, s.country asc
         limit 1
         on conflict(beatmap_id, user_id) do update set
           pp = excluded.pp,
           mods_json = excluded.mods_json,
           speed_mod = excluded.speed_mod,
           score_url = excluded.score_url,
           played_at = excluded.played_at,
           detected_at = excluded.detected_at,
           source_country = excluded.source_country,
           source_updated_at = excluded.source_updated_at,
           accuracy = excluded.accuracy,
           note_count = excluded.note_count`,
        args: [GLOBAL_COUNTRY_CODE, userId, beatmapId],
      });
      statements.push({
        sql: `delete from global_maps_farmed_scores
              where beatmap_id = ? and user_id = ?
                and not exists (
                  select 1 from country_maps_farmed_scores s
                  where s.country != ? and s.user_id = ? and s.beatmap_id = ? and s.pp > 0
                )`,
        args: [beatmapId, userId, GLOBAL_COUNTRY_CODE, userId, beatmapId],
      });
      statements.push(...rebuildGlobalMapsFarmedAggregateStatements(beatmapId, updatedAt));
    }
    await execBatch(db, statements);
    await yieldToEventLoop();
  }
}

function globalMapsFarmedProjectionUpsertStatement(
  beatmapId: number,
  player: StoredMapsFarmedPlayer,
  sourceCountry: string,
  sourceUpdatedAt: string,
): DbStatement {
  const detectedAt = player.playedAt || sourceUpdatedAt;
  // Legacy snapshot players carry no per-score statistics, so accuracy and
  // note_count stay null here; the normalized-row backfill that runs after
  // this fallback overwrites the row with real values where they exist.
  return {
    sql: `insert into global_maps_farmed_scores
       (beatmap_id, user_id, pp, mods_json, speed_mod, score_url, played_at, detected_at, source_country, source_updated_at, accuracy, note_count)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)
     on conflict(beatmap_id, user_id) do update set
       pp = excluded.pp,
       mods_json = excluded.mods_json,
       speed_mod = excluded.speed_mod,
       score_url = excluded.score_url,
       played_at = excluded.played_at,
       detected_at = excluded.detected_at,
       source_country = excluded.source_country,
       source_updated_at = excluded.source_updated_at
     where excluded.pp > global_maps_farmed_scores.pp
        or (excluded.pp = global_maps_farmed_scores.pp and excluded.detected_at >= global_maps_farmed_scores.detected_at)`,
    args: [
      beatmapId,
      player.id,
      player.pp,
      json(player.mods ?? []),
      mapsFarmedSpeedMod(player.mods ?? []),
      player.scoreUrl,
      player.playedAt,
      detectedAt,
      sourceCountry,
      sourceUpdatedAt,
    ],
  };
}

async function backfillGlobalMapsFarmedProjection(db: Db, signal?: AbortSignal): Promise<void> {
  const state = await readGlobalMapsFarmedProjectionState(db);
  if (state?.initialized) return;
  const includeLegacySnapshotFallback = state == null;

  const startedAt = Date.now();
  logInfo("global_maps_farmed_projection_backfill", { phase: "start" });
  await execBatch(db, [
    { sql: "delete from global_maps_farmed_changes" },
    { sql: "delete from global_maps_farmed_aggregates" },
    { sql: "delete from global_maps_farmed_scores" },
    {
      sql: `insert into global_maps_farmed_state (singleton, initialized, revision, seed_epoch, updated_at)
            values (1, 0, 1, 1, ?)
            on conflict(singleton) do update set
              initialized = 0,
              revision = global_maps_farmed_state.revision + 1,
              seed_epoch = global_maps_farmed_state.seed_epoch + 1,
              updated_at = excluded.updated_at`,
      args: [nowIso()],
    },
  ]);

  // On the first upgrade only, preserve already-materialized players that
  // predate the normalized source table. A destructive re-seed must use the
  // normalized rows exclusively: country blobs can lag a user's latest top-200
  // replacement and would otherwise resurrect scores that were deleted there.
  const countries = includeLegacySnapshotFallback
    ? (await exec(
        db,
        "select country, refreshed_at from country_maps_snapshots where country != ? order by country",
        [GLOBAL_COUNTRY_CODE],
      )).rows
    : [];
  let snapshotPlayers = 0;
  for (const countryRow of countries) {
    throwIfAborted(signal);
    const country = String(countryRow.country);
    const row = (await exec(db, "select payload_json from country_maps_snapshots where country = ?", [country])).rows[0];
    const stored = row ? toStoredCountryMapsData(parseJson<unknown>(row.payload_json, null)) : null;
    if (!stored) continue;
    const sourceUpdatedAt = String(countryRow.refreshed_at ?? stored.farmedGeneratedAt);
    let statements: DbStatement[] = [];
    for (const entry of stored.farmed) {
      for (const player of entry.players) {
        statements.push(globalMapsFarmedProjectionUpsertStatement(entry.beatmapId, player, country, sourceUpdatedAt));
        snapshotPlayers++;
        if (statements.length >= 500) {
          await execBatch(db, statements);
          statements = [];
        }
      }
    }
    await execBatch(db, statements);
    await yieldToEventLoop();
  }

  // The normalized rows are newer and complete; page the insert by rowid so a
  // one-time upgrade never creates a million-row JS result or one giant WAL
  // transaction.
  let cursor = 0;
  let normalizedRows = 0;
  for (;;) {
    throwIfAborted(signal);
    const edge = (await exec(
      db,
      `select max(rid) as rid, count(*) as count from (
         select rowid as rid
         from country_maps_farmed_scores
         where rowid > ? and country != ?
         order by rowid
         limit ?
       )`,
      [cursor, GLOBAL_COUNTRY_CODE, GLOBAL_MAPS_FARMED_ROWS_PAGE],
    )).rows[0];
    const count = Number(edge?.count ?? 0);
    if (count === 0) break;
    const end = Number(edge?.rid ?? cursor);
    await exec(
      db,
      `insert into global_maps_farmed_scores
         (beatmap_id, user_id, pp, mods_json, speed_mod, score_url, played_at, detected_at, source_country, source_updated_at, accuracy, note_count)
       select s.beatmap_id, s.user_id, s.pp, s.mods_json, ${mapsFarmedSpeedModSql("s")},
              s.score_url, s.played_at, s.detected_at, s.country, s.updated_at, s.accuracy, s.note_count
       from country_maps_farmed_scores s
       where s.rowid > ? and s.rowid <= ? and s.country != ? and s.pp > 0
       on conflict(beatmap_id, user_id) do update set
         pp = excluded.pp,
         mods_json = excluded.mods_json,
         speed_mod = excluded.speed_mod,
         score_url = excluded.score_url,
         played_at = excluded.played_at,
         detected_at = excluded.detected_at,
         source_country = excluded.source_country,
         source_updated_at = excluded.source_updated_at,
         accuracy = excluded.accuracy,
         note_count = excluded.note_count
       where excluded.pp > global_maps_farmed_scores.pp
          or (excluded.pp = global_maps_farmed_scores.pp and excluded.detected_at >= global_maps_farmed_scores.detected_at)`,
      [cursor, end, GLOBAL_COUNTRY_CODE],
    );
    cursor = end;
    normalizedRows += count;
    await yieldToEventLoop();
  }

  const completedAt = nowIso();
  await execBatch(db, [
    // This short final transaction closes the backfill/ingest race. A source
    // write either published its projection patch before this batch (and is
    // included below), or publishes after initialized=1 with a later revision.
    publishGlobalMapsFarmedRevisionStatement(completedAt, true),
    {
      sql: `insert into global_maps_farmed_aggregates
         (beatmap_id, player_count, pp_sum, avg_pp, max_pp, dominant_mod, revision, updated_at)
       select
         s.beatmap_id,
         count(*),
         sum(s.pp),
         avg(s.pp),
         max(s.pp),
         case
           when sum(case when s.speed_mod = 'DT' then 1 else 0 end) >= sum(case when s.speed_mod = 'HT' then 1 else 0 end)
             and sum(case when s.speed_mod = 'DT' then 1 else 0 end) > count(*) * ? then 'DT'
           when sum(case when s.speed_mod = 'HT' then 1 else 0 end) > sum(case when s.speed_mod = 'DT' then 1 else 0 end)
             and sum(case when s.speed_mod = 'HT' then 1 else 0 end) > count(*) * ?
             and (select top.speed_mod from global_maps_farmed_scores top
                  where top.beatmap_id = s.beatmap_id
                  order by top.pp desc, top.user_id asc limit 1) = 'HT' then 'HT'
           else null
         end,
         (select revision from global_maps_farmed_state where singleton = 1), ?
       from global_maps_farmed_scores s
       group by s.beatmap_id
       having count(*) >= 2 or max(s.pp) >= ?
       on conflict(beatmap_id) do update set
         player_count = excluded.player_count,
         pp_sum = excluded.pp_sum,
         avg_pp = excluded.avg_pp,
         max_pp = excluded.max_pp,
         dominant_mod = excluded.dominant_mod,
         revision = excluded.revision,
         updated_at = excluded.updated_at`,
      args: [FARMED_DOMINANT_MOD_SHARE, FARMED_DOMINANT_MOD_SHARE, completedAt, FARMED_SINGLE_PLAYER_PP_MIN],
    },
    {
      sql: `insert into global_maps_farmed_changes (beatmap_id, revision, updated_at)
            select a.beatmap_id, s.revision, ?
            from global_maps_farmed_aggregates a
            cross join global_maps_farmed_state s
            where s.singleton = 1
            on conflict(beatmap_id) do update set
              revision = excluded.revision,
              updated_at = excluded.updated_at`,
      args: [completedAt],
    },
  ]);
  logInfo("global_maps_farmed_projection_backfill", {
    phase: "done",
    countries: countries.length,
    legacy_snapshot_fallback: includeLegacySnapshotFallback,
    snapshot_players: snapshotPlayers,
    normalized_rows: normalizedRows,
    duration_ms: Date.now() - startedAt,
  });
}

// Rebuilds the compatibility GLOBAL snapshot for popular/favourites/random.
// The farmed section is deliberately absent: it lives in the row-granular
// projection above and is served from its packed board. Consequently this job
// never folds >1M score rows or serializes the old ~60 MB farmed blob.
export async function refreshGlobalMaps(db: Db, signal?: AbortSignal): Promise<{ generatedAt: string; farmed: number; mostPlayed: number; favourites: number; beatmapsetPool: number }> {
  logInfo("refresh_global_maps_memory", { phase: "start", heap_used_mb: heapUsedMb() });
  await backfillGlobalMapsFarmedProjection(db, signal);
  const countryRows = (await exec(
    db,
    "select country from country_maps_snapshots where country != ? order by country",
    [GLOBAL_COUNTRY_CODE],
  )).rows;

  const mostPlayedByBeatmap = new Map<number, Map<number, StoredMapsCountPlayer>>();
  const favouritesByBeatmapset = new Map<number, Set<number>>();
  const favouritesByPlayerSets = new Map<number, Set<number>>();
  const pool = new Set<number>();

  for (const countryRow of countryRows) {
    throwIfAborted(signal);
    // One country's parse+merge is the unit of synchronous work; yield between
    // them so HTTP requests can interleave with this aggregation. The payload is
    // fetched, parsed locally and folded here, then goes out of scope before the
    // next country loads — the multi-hundred-MB set of parsed trees is never
    // held resident at once (deliberately uncached).
    await yieldToEventLoop();
    const payloadRow = (await exec(
      db,
      "select payload_json from country_maps_snapshots where country = ?",
      [String(countryRow.country)],
    )).rows[0];
    const stored = payloadRow ? toStoredCountryMapsData(parseJson<unknown>(payloadRow.payload_json, null)) : null;
    if (!stored) continue;
    for (const entry of stored.mostPlayed) {
      let players = mostPlayedByBeatmap.get(entry.beatmapId);
      if (!players) mostPlayedByBeatmap.set(entry.beatmapId, (players = new Map()));
      for (const player of entry.players) {
        const existing = players.get(player.id);
        if (existing) existing.count += player.count;
        else players.set(player.id, { id: player.id, count: player.count });
      }
    }
    for (const entry of stored.favourites) {
      let set = favouritesByBeatmapset.get(entry.beatmapsetId);
      if (!set) favouritesByBeatmapset.set(entry.beatmapsetId, (set = new Set()));
      for (const player of entry.players) set.add(player.id);
    }
    for (const player of stored.favouritesByPlayer) {
      let set = favouritesByPlayerSets.get(player.id);
      if (!set) favouritesByPlayerSets.set(player.id, (set = new Set()));
      for (const id of player.beatmapsetIds) set.add(id);
    }
    for (const id of stored.beatmapsetsPool) pool.add(id);
  }
  logInfo("refresh_global_maps_memory", { phase: "countries_merged", countries: countryRows.length, heap_used_mb: heapUsedMb() });

  await yieldToEventLoop();
  const mostPlayed = [...mostPlayedByBeatmap.entries()]
    .map(([beatmapId, playerMap]): StoredCountryMapsData["mostPlayed"][number] => {
      const players = [...playerMap.values()].sort((a, b) => b.count - a.count);
      return {
        beatmapId,
        totalPlays: players.reduce((sum, player) => sum + player.count, 0),
        playerCount: players.length,
        players: players.slice(0, GLOBAL_MAPS_PLAYERS_PER_ENTRY),
      };
    })
    .sort((a, b) => b.playerCount - a.playerCount || b.totalPlays - a.totalPlays);

  await yieldToEventLoop();
  const favourites = [...favouritesByBeatmapset.entries()]
    .map(([beatmapsetId, set]): StoredCountryMapsData["favourites"][number] => ({
      beatmapsetId,
      playerCount: set.size,
      players: [...set].slice(0, GLOBAL_MAPS_PLAYERS_PER_ENTRY).map((id) => ({ id })),
    }))
    .sort((a, b) => b.playerCount - a.playerCount);

  const favouritesByPlayer = [...favouritesByPlayerSets.entries()]
    .map(([id, set]) => ({ id, beatmapsetIds: [...set] }))
    .filter((player) => player.beatmapsetIds.length > 0)
    .sort((a, b) => b.beatmapsetIds.length - a.beatmapsetIds.length);

  // Keep the most-favourited sets first so the Random tab pool stays dense,
  // while still keeping every eligible set in the compact stored pool.
  const beatmapsetsPool = [...pool]
    .sort((a, b) => (favouritesByBeatmapset.get(b)?.size ?? 0) - (favouritesByBeatmapset.get(a)?.size ?? 0));

  const generatedAt = nowIso();
  const projectionState = await readGlobalMapsFarmedProjectionState(db);
  const farmedCount = Number((await exec(
    db,
    "select count(*) as count from global_maps_farmed_aggregates",
  )).rows[0]?.count ?? 0);
  const stored: StoredCountryMapsData = {
    schemaVersion: 2,
    farmed: [],
    mostPlayed,
    favourites,
    favouritesByPlayer,
    beatmapsetsPool,
    generatedAt,
    farmedGeneratedAt: projectionState?.updatedAt || generatedAt,
    favouritesGeneratedAt: generatedAt,
  };

  logInfo("refresh_global_maps_memory", {
    phase: "aggregated",
    farmed: stored.farmed.length,
    most_played: stored.mostPlayed.length,
    favourites: stored.favourites.length,
    beatmapset_pool: stored.beatmapsetsPool.length,
    heap_used_mb: heapUsedMb(),
  });

  const refreshedAt = nowIso();
  // The compatibility payload no longer contains the large farmed board, so
  // this serialization is limited to popular/favourites/random data.
  await yieldToEventLoop();
  await exec(
    db,
    `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
     values (?, ?, ?, ?)
     on conflict(country) do update set payload_json = excluded.payload_json, generated_at = excluded.generated_at, refreshed_at = excluded.refreshed_at`,
    [GLOBAL_COUNTRY_CODE, json(stored), generatedAt, refreshedAt],
  );

  // Intentionally does not hydrate `stored` back into display form: the only
  // caller (the refresh_global_maps job) discards the return value, and the read
  // path hydrates the requested page on demand from the persisted snapshot.
  logInfo("refresh_global_maps_memory", { phase: "persisted", heap_used_mb: heapUsedMb() });
  return {
    generatedAt,
    farmed: farmedCount,
    mostPlayed: stored.mostPlayed.length,
    favourites: stored.favourites.length,
    beatmapsetPool: stored.beatmapsetsPool.length,
  };
}

// Normalises a stored maps payload (compact schema v2 or the legacy hydrated
// shape) into the compact form the Global merge operates on.
function toStoredCountryMapsData(parsed: unknown): StoredCountryMapsData | null {
  if (isStoredCountryMapsData(parsed)) return parsed;
  if (isCountryMapsDataShape(parsed)) return compactMapsSnapshotForStorage(parsed);
  return null;
}

async function persistMapsSnapshot(db: Db, country: string, value: CountryMapsData): Promise<void> {
  const refreshedAt = nowIso();
  await persistMapsSnapshotDisplayMetadata(db, value, refreshedAt);
  await exec(
    db,
    `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
     values (?, ?, ?, ?)
     on conflict(country) do update set payload_json = excluded.payload_json, generated_at = excluded.generated_at, refreshed_at = excluded.refreshed_at`,
    [country.toUpperCase(), json(compactMapsSnapshotForStorage(value)), value.generatedAt, refreshedAt],
  );
}

export async function compactCountryMapsSnapshots(db: Db): Promise<{ scanned: number; compacted: number; skipped: number }> {
  const countries = (await exec(
    db,
    `select country
     from country_maps_snapshots
     where payload_json not like '{"schemaVersion":2,%'
     order by country`,
  )).rows;
  let compacted = 0;
  let skipped = 0;
  for (const countryRow of countries) {
    const country = String(countryRow.country);
    const row = (await exec(
      db,
      "select country, payload_json, generated_at, refreshed_at from country_maps_snapshots where country = ?",
      [country],
    )).rows[0];
    if (!row) {
      skipped++;
      continue;
    }
    const parsed = parseJson<unknown>(row.payload_json, null);
    if (!parsed || isStoredCountryMapsData(parsed)) {
      skipped++;
      continue;
    }
    if (!isCountryMapsDataShape(parsed) || !isUsableMapsData(parsed)) {
      skipped++;
      continue;
    }
    const refreshedAt = String(row.refreshed_at ?? nowIso());
    await persistMapsSnapshotDisplayMetadata(db, parsed, refreshedAt);
    await exec(
      db,
      `update country_maps_snapshots
       set payload_json = ?, generated_at = ?, refreshed_at = ?
       where country = ?`,
      [json(compactMapsSnapshotForStorage(parsed)), String(row.generated_at ?? parsed.generatedAt), refreshedAt, country],
    );
    compacted++;
  }
  return { scanned: countries.length, compacted, skipped };
}

interface MapsBeatmapMetadata {
  beatmapId: number;
  beatmapsetId: number;
  mode: string;
  convert?: boolean;
  status: string;
  cs: number;
  difficultyRating: number;
  bpm: number;
  totalLength: number;
  version: string;
  url: string;
}

interface MapsBeatmapsetMetadata {
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  status: string;
  covers: Record<string, string | undefined>;
  globalPlayCount: number;
  globalFavouriteCount: number;
  previewUrl: string;
  bpm: number;
  maniaKeys: number[];
  patterns: string[];
}

async function persistMapsSnapshotDisplayMetadata(db: Db, value: CountryMapsData, updatedAt: string): Promise<void> {
  const users = new Map<number, { username: string; avatarUrl: string }>();
  const addUser = (player: { id: number; username: string; avatarUrl: string }) => {
    if (!Number.isSafeInteger(player.id) || player.id <= 0) return;
    if (!users.has(player.id) || player.username) users.set(player.id, { username: player.username, avatarUrl: player.avatarUrl });
  };
  for (const entry of value.farmed) entry.players.forEach(addUser);
  for (const entry of value.mostPlayed) entry.players.forEach(addUser);
  for (const entry of value.favourites) entry.players.forEach(addUser);
  value.favouritesByPlayer.forEach(addUser);

  const statements: DbStatement[] = [];
  const pushStatement = async (statement: DbStatement): Promise<void> => {
    statements.push(statement);
    if (statements.length >= MAPS_METADATA_BATCH_FLUSH_STATEMENTS) {
      await execBatch(db, statements.splice(0));
    }
  };
  for (const [userId, user] of users) {
    await pushStatement({
      sql: `insert into users (user_id, username, avatar_url, country_code, updated_at)
            values (?, ?, ?, null, ?)
            on conflict(user_id) do update set
              username = excluded.username,
              avatar_url = excluded.avatar_url,
              updated_at = excluded.updated_at`,
      args: [userId, user.username || `User ${userId}`, user.avatarUrl, updatedAt],
    });
  }

  for (const entry of value.farmed) {
    await pushStatement(mapsBeatmapsetStatement({
      beatmapsetId: entry.beatmapsetId,
      title: entry.title,
      artist: entry.artist,
      creator: entry.creator,
      status: entry.status,
      covers: entry.covers,
    }, updatedAt));
    await pushStatement(mapsBeatmapStatement({
      beatmapId: entry.beatmapId,
      beatmapsetId: entry.beatmapsetId,
      mode: "mania",
      status: entry.status,
      cs: entry.cs,
      difficultyRating: entry.difficultyRating,
      bpm: entry.bpm,
      totalLength: entry.totalLength,
      version: entry.version,
      url: `https://osu.ppy.sh/beatmaps/${entry.beatmapId}`,
    }, updatedAt));
  }

  for (const entry of value.mostPlayed) {
    await pushStatement(mapsBeatmapsetStatement({
      beatmapsetId: entry.beatmapsetId,
      title: entry.title,
      artist: entry.artist,
      creator: entry.creator,
      status: entry.status,
      covers: entry.covers,
      globalPlayCount: entry.globalPlayCount,
    }, updatedAt));
    await pushStatement(mapsBeatmapStatement({
      beatmapId: entry.beatmapId,
      beatmapsetId: entry.beatmapsetId,
      mode: "mania",
      status: entry.status,
      difficultyRating: entry.difficultyRating,
      totalLength: entry.totalLength,
      version: entry.version,
      url: `https://osu.ppy.sh/beatmaps/${entry.beatmapId}`,
    }, updatedAt));
  }

  for (const entry of value.favourites) {
    await pushStatement(mapsBeatmapsetStatement({
      beatmapsetId: entry.beatmapsetId,
      title: entry.title,
      artist: entry.artist,
      creator: entry.creator,
      status: entry.status,
      covers: entry.covers,
      globalPlayCount: entry.globalPlayCount,
      globalFavouriteCount: entry.globalFavouriteCount,
    }, updatedAt));
  }

  for (const beatmapset of Object.values(value.beatmapsetsPool)) {
    await pushStatement(mapsBeatmapsetStatement({
      beatmapsetId: beatmapset.id,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      status: beatmapset.status,
      covers: beatmapset.covers ?? {},
      globalPlayCount: beatmapset.globalPlayCount,
      globalFavouriteCount: beatmapset.globalFavouriteCount,
      previewUrl: beatmapset.previewUrl,
      bpm: beatmapset.bpm,
      maniaKeys: beatmapset.maniaKeys,
      patterns: beatmapset.patterns,
    }, updatedAt));
    for (const beatmap of beatmapset.maniaBeatmaps ?? []) {
      await pushStatement(mapsBeatmapStatement({
        beatmapId: beatmap.id,
        beatmapsetId: beatmapset.id,
        mode: "mania",
        status: beatmapset.status,
        cs: beatmap.cs,
        difficultyRating: beatmap.difficultyRating,
        bpm: beatmapset.bpm,
        totalLength: beatmap.totalLength,
        version: beatmap.version,
        url: `https://osu.ppy.sh/beatmaps/${beatmap.id}`,
      }, updatedAt));
    }
  }
  await execBatch(db, statements);
}

function mapsBeatmapsetStatement(
  value: Pick<MapsBeatmapsetMetadata, "beatmapsetId" | "title" | "artist" | "creator" | "status" | "covers"> & Partial<Pick<MapsBeatmapsetMetadata, "globalPlayCount" | "globalFavouriteCount" | "previewUrl" | "bpm" | "maniaKeys" | "patterns">>,
  updatedAt: string,
): DbStatement {
  return {
    sql: `insert into maps_beatmapsets
       (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(beatmapset_id) do update set
       title = excluded.title,
       artist = excluded.artist,
       creator = excluded.creator,
       status = excluded.status,
       covers_json = excluded.covers_json,
       global_play_count = coalesce(excluded.global_play_count, maps_beatmapsets.global_play_count),
       global_favourite_count = coalesce(excluded.global_favourite_count, maps_beatmapsets.global_favourite_count),
       preview_url = coalesce(excluded.preview_url, maps_beatmapsets.preview_url),
       bpm = coalesce(excluded.bpm, maps_beatmapsets.bpm),
       mania_keys_json = coalesce(excluded.mania_keys_json, maps_beatmapsets.mania_keys_json),
       patterns_json = coalesce(excluded.patterns_json, maps_beatmapsets.patterns_json),
       updated_at = excluded.updated_at`,
    args: [
      value.beatmapsetId,
      value.title,
      value.artist,
      value.creator || null,
      value.status || null,
      json(value.covers ?? {}),
      value.globalPlayCount ?? null,
      value.globalFavouriteCount ?? null,
      value.previewUrl || null,
      value.bpm ?? null,
      value.maniaKeys ? json(value.maniaKeys) : null,
      value.patterns ? json(value.patterns) : null,
      updatedAt,
    ],
  };
}

function mapsBeatmapStatement(
  value: Omit<MapsBeatmapMetadata, "cs" | "bpm"> & Partial<Pick<MapsBeatmapMetadata, "cs" | "bpm">>,
  updatedAt: string,
): DbStatement {
  return {
    sql: `insert into maps_beatmaps
       (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       beatmapset_id = excluded.beatmapset_id,
       mode = excluded.mode,
       status = coalesce(excluded.status, maps_beatmaps.status),
       cs = coalesce(excluded.cs, maps_beatmaps.cs),
       difficulty_rating = coalesce(excluded.difficulty_rating, maps_beatmaps.difficulty_rating),
       bpm = coalesce(excluded.bpm, maps_beatmaps.bpm),
       total_length = coalesce(excluded.total_length, maps_beatmaps.total_length),
       version = excluded.version,
       url = coalesce(excluded.url, maps_beatmaps.url),
       updated_at = excluded.updated_at`,
    args: [
      value.beatmapId,
      value.beatmapsetId,
      value.mode,
      value.status || null,
      // 0 is never a real keymode/bpm (snapshot hydration bakes unknowns as 0);
      // store null so the coalesce above keeps or later heals the real value.
      value.cs || null,
      value.difficultyRating,
      value.bpm || null,
      value.totalLength,
      value.version,
      value.url,
      updatedAt,
    ],
  };
}

async function readMapsBeatmapsByIds(db: Db, ids: number[]): Promise<Map<number, MapsBeatmapMetadata>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select
       b.beatmap_id,
       b.beatmapset_id,
       coalesce(json_extract(raw.metadata_json, '$.mode'), b.mode) as mode,
       coalesce(json_extract(raw.metadata_json, '$.convert'), 0) as convert,
       b.status,
       b.cs,
       b.difficulty_rating,
       b.bpm,
       b.total_length,
       b.version,
       b.url
     from maps_beatmaps b
     left join beatmaps raw on raw.beatmap_id = b.beatmap_id
     where b.beatmap_id in`,
    ids,
    `and ${nativeManiaBeatmapSql("b")}`,
  );
  return new Map(rows.map((row) => {
    const beatmap = rowToMapsBeatmapMetadata(row);
    return [beatmap.beatmapId, beatmap];
  }));
}

async function readMapsBeatmapsByBeatmapsetIds(db: Db, ids: number[]): Promise<MapsBeatmapMetadata[]> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select
       b.beatmap_id,
       b.beatmapset_id,
       coalesce(json_extract(raw.metadata_json, '$.mode'), b.mode) as mode,
       coalesce(json_extract(raw.metadata_json, '$.convert'), 0) as convert,
       b.status,
       b.cs,
       b.difficulty_rating,
       b.bpm,
       b.total_length,
       b.version,
       b.url
     from maps_beatmaps b
     left join beatmaps raw on raw.beatmap_id = b.beatmap_id
     where b.beatmapset_id in`,
    ids,
    `and ${nativeManiaBeatmapSql("b")}`,
  );
  return rows.map(rowToMapsBeatmapMetadata);
}

async function readMapsFarmedPageMetadataByIds(db: Db, ids: number[]): Promise<Map<number, MapsFarmedPageMetadata>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select
       b.beatmap_id,
       b.cs,
       b.difficulty_rating,
       b.version,
       bs.title,
       bs.artist,
       bs.creator,
       coalesce(nullif(bs.status, ''), b.status, '') as status
     from maps_beatmaps b
     left join beatmaps raw on raw.beatmap_id = b.beatmap_id
     left join maps_beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
     where b.beatmap_id in`,
    ids,
    `and ${nativeManiaBeatmapSql("b")}`,
  );
  return new Map(rows.map((row) => {
    const beatmapId = Number(row.beatmap_id);
    return [beatmapId, {
      beatmapId,
      cs: Number(row.cs ?? 0),
      difficultyRating: Number(row.difficulty_rating ?? 0),
      version: String(row.version ?? ""),
      title: String(row.title ?? ""),
      artist: String(row.artist ?? ""),
      creator: String(row.creator ?? ""),
      status: String(row.status ?? ""),
    }];
  }));
}

async function readMapsBeatmapsetsByIds(db: Db, ids: number[]): Promise<Map<number, MapsBeatmapsetMetadata>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json
     from maps_beatmapsets
     where beatmapset_id in`,
    ids,
  );
  return new Map(rows.map((row) => {
    const beatmapset = rowToMapsBeatmapsetMetadata(row);
    return [beatmapset.beatmapsetId, beatmapset];
  }));
}

async function selectRowsByIntegerSet(db: Db, sqlPrefix: string, values: number[], sqlSuffix = ""): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < ids.length; index += 900) {
    const chunk = ids.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...(await exec(db, `${sqlPrefix} (${placeholders}) ${sqlSuffix}`, chunk)).rows);
  }
  return rows;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function nativeManiaBeatmapSql(beatmapAlias: string, rawAlias = "raw"): string {
  return `coalesce(json_extract(${rawAlias}.metadata_json, '$.convert'), 0) != 1
    and coalesce(json_extract(${rawAlias}.metadata_json, '$.mode'), ${beatmapAlias}.mode, '') = 'mania'`;
}

function isNativeManiaRawBeatmap(beatmap: RawBeatmap | OscScore["beatmap"] | undefined): beatmap is RawBeatmap | NonNullable<OscScore["beatmap"]> {
  return !!beatmap && beatmap.mode === "mania" && !readBoolean(beatmap.convert);
}

function isNativeManiaMapsBeatmap(beatmap: Pick<MapsBeatmapMetadata, "mode" | "convert"> | undefined): beatmap is MapsBeatmapMetadata {
  return !!beatmap && beatmap.mode === "mania" && !beatmap.convert;
}

function rowToMapsBeatmapMetadata(row: Record<string, unknown>): MapsBeatmapMetadata {
  const beatmapId = Number(row.beatmap_id);
  return {
    beatmapId,
    beatmapsetId: Number(row.beatmapset_id),
    mode: String(row.mode ?? "mania"),
    convert: readBoolean(row.convert),
    status: String(row.status ?? ""),
    cs: Number(row.cs ?? 0),
    difficultyRating: Number(row.difficulty_rating ?? 0),
    bpm: Number(row.bpm ?? 0),
    totalLength: Number(row.total_length ?? 0),
    version: String(row.version ?? ""),
    url: String(row.url ?? `https://osu.ppy.sh/beatmaps/${beatmapId}`),
  };
}

function rowToMapsBeatmapsetMetadata(row: Record<string, unknown>): MapsBeatmapsetMetadata {
  return {
    beatmapsetId: Number(row.beatmapset_id),
    title: String(row.title ?? ""),
    artist: String(row.artist ?? ""),
    creator: String(row.creator ?? ""),
    status: String(row.status ?? ""),
    covers: parseJson<Record<string, string | undefined>>(row.covers_json, {}),
    globalPlayCount: Number(row.global_play_count ?? 0),
    globalFavouriteCount: Number(row.global_favourite_count ?? 0),
    previewUrl: String(row.preview_url ?? ""),
    bpm: Number(row.bpm ?? 0),
    maniaKeys: parseJson<number[]>(row.mania_keys_json, []),
    patterns: parseJson<string[]>(row.patterns_json, []),
  };
}

export async function refreshUserMapsFarmedScores(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow">,
  queue: JobQueue,
  payload: { country: string; userId: number },
): Promise<{ country: string; userId: number; scoreCount: number; updatedAt: string }> {
  const country = payload.country.toUpperCase();
  let bestScores: OscScore[];
  try {
    bestScores = await osu.getUserBestScoresWindow(payload.userId, MAPS_FARMED_SCORE_WINDOW, "job:refresh_user_maps_farmed_scores");
  } catch (error) {
    if (!(error instanceof OsuApiError && error.status === 404)) throw error;
    await markUserMissing(db, payload.userId, `refresh_user_maps_farmed_scores: ${error.message}`);
    const updatedAt = nowIso();
    await replaceUserMapsFarmedOverlay(db, queue, country, payload.userId, [], updatedAt);
    return { country, userId: payload.userId, scoreCount: 0, updatedAt };
  }
  const updatedAt = nowIso();
  const rows = buildMapsFarmedOverlayRows(country, bestScores, updatedAt, payload.userId);
  await persistMapsFarmedScoreDisplayMetadata(db, bestScores, updatedAt);
  await replaceUserMapsFarmedOverlay(db, queue, country, payload.userId, rows, updatedAt);
  await updateUserMapsFarmedThreshold(db, payload.userId, bestScores, updatedAt);
  return { country, userId: payload.userId, scoreCount: rows.length, updatedAt };
}

export async function recordMapsFarmedScore(
  db: Db,
  country: string,
  score: OscScore,
  updatedAt = nowIso(),
): Promise<{ country: string; userId: number; beatmapId: number; updatedAt: string } | null> {
  const rows = buildMapsFarmedOverlayRows(country.toUpperCase(), [score], updatedAt);
  const row = rows[0];
  if (!row) return null;
  await persistMapsFarmedScoreDisplayMetadata(db, [score], updatedAt);
  const result = await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, accuracy, note_count)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(country, user_id, beatmap_id) do update set
       score_id = excluded.score_id,
       pp = excluded.pp,
       score_json = excluded.score_json,
       mods_json = excluded.mods_json,
       score_url = excluded.score_url,
       played_at = excluded.played_at,
       detected_at = excluded.detected_at,
       updated_at = excluded.updated_at,
       accuracy = excluded.accuracy,
       note_count = excluded.note_count
     where excluded.pp > country_maps_farmed_scores.pp
        or (excluded.pp = country_maps_farmed_scores.pp and excluded.detected_at >= country_maps_farmed_scores.detected_at)`,
    [
      row.country,
      row.userId,
      row.beatmapId,
      row.scoreId,
      row.pp,
      row.scoreJson,
      row.modsJson,
      row.scoreUrl,
      row.playedAt,
      row.detectedAt,
      row.updatedAt,
      row.accuracy,
      row.noteCount,
    ],
  );
  if (Number(result.rowsAffected ?? 0) === 0) return null;
  await syncGlobalMapsFarmedUserBeatmaps(db, row.userId, [row.beatmapId], updatedAt);
  await refreshFarmHelperKeyStatsForUser(db, row.userId, updatedAt);
  await touchMapsFarmedOverlay(db, row.country, updatedAt);
  return { country: row.country, userId: row.userId, beatmapId: row.beatmapId, updatedAt };
}

async function getMapsUsers(db: Db, country: string): Promise<MapsUser[]> {
  const config = readConfig();
  const rosterSize = Math.max(1, Math.floor(config.rosterSize));
  const rows = (await exec(
    db,
    `select r.user_id, u.username, u.avatar_url
     from country_rosters r
     left join users u on u.user_id = r.user_id
     where r.country = ? and r.is_tracked = 1 and r.rank is not null
     order by r.rank asc
     limit ?`,
    [country, rosterSize],
  )).rows;
  return rows.map((row) => ({
    id: Number(row.user_id),
    username: String(row.username ?? `User ${row.user_id}`),
    avatar_url: String(row.avatar_url ?? ""),
  }));
}

async function buildCountryFarmed(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow">,
  queue: JobQueue,
  country: string,
  users: MapsUser[],
  progress?: MapsRefreshProgressReporter,
): Promise<CountryMapsFarmedSection> {
  const missingUsers = await getUsersMissingMapsFarmedOverlay(db, country, users);
  if (missingUsers.length > 0) {
    await seedCountryFarmedOverlayUsers(db, osu, queue, country, missingUsers, progress);
  }
  return readCountryFarmedOverlaySection(db, country, users);
}

async function seedCountryFarmedOverlayUsers(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow">,
  queue: JobQueue,
  country: string,
  users: MapsUser[],
  progress?: MapsRefreshProgressReporter,
): Promise<void> {
  await mapWithConcurrency(users, MAPS_FETCH_CONCURRENCY, async (user) => {
    try {
      const bestScores = await osu.getUserBestScoresWindow(user.id, 200, "job:refresh_country_maps:farmed")
        .catch((error) => {
          throwIfMapsRefreshShouldAbort(error);
          return [] as OscScore[];
        });
      const updatedAt = nowIso();
      const rows = buildMapsFarmedOverlayRows(country, bestScores, updatedAt, user.id);
      await persistMapsFarmedScoreDisplayMetadata(db, bestScores, updatedAt);
      await replaceUserMapsFarmedOverlay(db, queue, country, user.id, rows, updatedAt);
      await updateUserMapsFarmedThreshold(db, user.id, bestScores, updatedAt);
    } finally {
      await progress?.markUserDone("farmed");
    }
  });
}

async function getUsersMissingMapsFarmedOverlay(db: Db, country: string, users: MapsUser[]): Promise<MapsUser[]> {
  const seeded = new Set<number>();
  for (let index = 0; index < users.length; index += 900) {
    const chunk = users.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const metaKeys = chunk.map((user) => mapsFarmedUserOverlayMetaKey(country, user.id));
    const metaRows = (await exec(
      db,
      `select key
       from live_meta
       where key in (${placeholders})`,
      metaKeys,
    )).rows;
    for (const row of metaRows) {
      const userId = userIdFromMapsFarmedUserOverlayMetaKey(String(row.key ?? ""));
      if (userId != null) seeded.add(userId);
    }
  }
  return users.filter((user) => !seeded.has(user.id));
}

async function readCountryFarmedOverlaySection(
  db: Db,
  country: string,
  users: MapsUser[],
): Promise<CountryMapsFarmedSection> {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < users.length; index += 900) {
    const chunk = users.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...(await exec(
      db,
      `select
         s.country,
         s.user_id,
         s.beatmap_id,
         s.score_id,
         s.pp,
         s.score_json,
         s.mods_json,
         s.score_url,
         s.played_at,
         s.detected_at,
         s.updated_at,
         u.username,
         u.avatar_url,
         u.country_code,
         coalesce(b.beatmapset_id, mb.beatmapset_id) as beatmapset_id,
         coalesce(json_extract(b.metadata_json, '$.mode'), b.mode, mb.mode) as mode,
         coalesce(json_extract(b.metadata_json, '$.convert'), 0) as convert,
         coalesce(b.status, mb.status) as beatmap_status,
         coalesce(b.cs, mb.cs) as cs,
         coalesce(b.difficulty_rating, mb.difficulty_rating) as difficulty_rating,
         coalesce(b.bpm, mb.bpm) as bpm,
         b.max_combo,
         coalesce(b.version, mb.version) as version,
         coalesce(b.url, mb.url) as url,
         coalesce(mb.total_length, 0) as total_length,
         coalesce(bs.title, mbs.title) as title,
         coalesce(bs.artist, mbs.artist) as artist,
         coalesce(bs.creator, mbs.creator) as creator,
         coalesce(bs.status, mbs.status) as beatmapset_status,
         coalesce(bs.covers_json, mbs.covers_json) as covers_json
       from country_maps_farmed_scores s
       left join users u on u.user_id = s.user_id
       left join beatmaps b on b.beatmap_id = s.beatmap_id
       left join maps_beatmaps mb on mb.beatmap_id = s.beatmap_id
       left join beatmapsets bs on bs.beatmapset_id = coalesce(b.beatmapset_id, mb.beatmapset_id)
       left join maps_beatmapsets mbs on mbs.beatmapset_id = coalesce(b.beatmapset_id, mb.beatmapset_id)
       where s.country = ? and s.user_id in (${placeholders})
       order by s.updated_at asc`,
      [country, ...chunk.map((user) => user.id)],
    )).rows);
  }

  const farmedMap = new Map<number, MapsFarmedEntry>();
  let rowsProcessed = 0;
  for (const row of rows) {
    if (++rowsProcessed % 2000 === 0) await yieldToEventLoop();
    const merged = farmedOverlayRowToEntry(row);
    if (!merged) continue;
    mergeFarmedEntry(farmedMap, merged.entry, merged.player);
  }

  const farmed: MapsFarmedEntry[] = [];
  for (const entry of farmedMap.values()) {
    finalizeFarmedEntry(entry);
    if (entry.playerCount < 2 && entry.maxPp < FARMED_SINGLE_PLAYER_PP_MIN) continue;
    farmed.push(entry);
  }
  farmed.sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);
  return { farmed, generatedAt: nowIso() };
}

async function buildCountryFavourites(
  db: Db,
  osu: Pick<OsuApiClient, "getUserMostPlayed" | "getUserFavourites">,
  country: string,
  users: MapsUser[],
  progress?: MapsRefreshProgressReporter,
): Promise<CountryMapsFavouritesSection> {
  const dueUsers = await getUsersDueForMapsUserLibrary(db, country, users);
  if (dueUsers.length > 0) {
    await seedCountryMapsUserLibraryUsers(db, osu, country, dueUsers, progress);
  }
  return readCountryMapsUserLibrarySection(db, country, users);
}

async function getUsersDueForMapsUserLibrary(db: Db, country: string, users: MapsUser[]): Promise<MapsUser[]> {
  const refreshedByUser = new Map<number, string>();
  for (let index = 0; index < users.length; index += 900) {
    const chunk = users.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const keys = chunk.map((user) => mapsUserLibraryMetaKey(country, user.id));
    const rows = (await exec(
      db,
      `select key, value_json
       from live_meta
       where key in (${placeholders})`,
      keys,
    )).rows;
    for (const row of rows) {
      const userId = userIdFromMapsUserLibraryMetaKey(String(row.key ?? ""));
      const refreshedAt = parseJson<string | null>(row.value_json, null);
      if (userId != null && typeof refreshedAt === "string" && refreshedAt) {
        refreshedByUser.set(userId, refreshedAt);
      }
    }
  }

  const missing: MapsUser[] = [];
  const stale: Array<{ user: MapsUser; refreshedMs: number }> = [];
  const staleCutoffMs = Date.now() - MAPS_USER_LIBRARY_REFRESH_INTERVAL_MS;
  for (const user of users) {
    const refreshedAt = refreshedByUser.get(user.id);
    const refreshedMs = refreshedAt ? new Date(refreshedAt).getTime() : Number.NaN;
    if (!Number.isFinite(refreshedMs)) {
      missing.push(user);
    } else if (refreshedMs < staleCutoffMs) {
      stale.push({ user, refreshedMs });
    }
  }

  if (missing.length > 0) return missing;
  return stale
    .sort((a, b) => a.refreshedMs - b.refreshedMs)
    .slice(0, MAPS_USER_LIBRARY_STALE_REFRESH_LIMIT)
    .map((entry) => entry.user);
}

async function seedCountryMapsUserLibraryUsers(
  db: Db,
  osu: Pick<OsuApiClient, "getUserMostPlayed" | "getUserFavourites">,
  country: string,
  users: MapsUser[],
  progress?: MapsRefreshProgressReporter,
): Promise<void> {
  await mapWithConcurrency(users, MAPS_FETCH_CONCURRENCY, async (user) => {
    try {
      const [mostPlayed, favourites] = await Promise.all([
        osu.getUserMostPlayed(user.id, "job:refresh_country_maps:most_played")
          .then((rows) => rows as RawBeatmapPlaycount[])
          .catch((error) => {
            throwIfMapsRefreshShouldAbort(error);
            return [] as RawBeatmapPlaycount[];
          }),
        osu.getUserFavourites(user.id, USER_FAVOURITES_MAX_PAGES, "job:refresh_country_maps:favourites")
          .then((rows) => rows as RawBeatmapset[])
          .catch((error) => {
            throwIfMapsRefreshShouldAbort(error);
            return [] as RawBeatmapset[];
          }),
      ]);
      await replaceUserMapsUserLibrary(db, country, user.id, mostPlayed, favourites, nowIso());
    } finally {
      await progress?.markUserDone("favourites");
    }
  });
}

async function replaceUserMapsUserLibrary(
  db: Db,
  country: string,
  userId: number,
  mostPlayed: RawBeatmapPlaycount[],
  favourites: RawBeatmapset[],
  updatedAt: string,
): Promise<void> {
  const statements: DbStatement[] = [
    { sql: "delete from country_maps_most_played where country = ? and user_id = ?", args: [country, userId] },
    { sql: "delete from country_maps_favourite_sets where country = ? and user_id = ?", args: [country, userId] },
  ];

  for (const mp of mostPlayed) {
    if (!isNativeManiaRawBeatmap(mp.beatmap) || !mp.beatmapset) continue;
    const beatmapId = Number(mp.beatmap_id ?? mp.beatmap.id);
    const beatmapsetId = Number(mp.beatmapset.id ?? mp.beatmap.beatmapset_id ?? 0);
    const count = Math.floor(Number(mp.count ?? 0));
    if (
      !Number.isSafeInteger(beatmapId) || beatmapId <= 0
      || !Number.isSafeInteger(beatmapsetId) || beatmapsetId <= 0
      || !Number.isFinite(count) || count <= 0
    ) {
      continue;
    }
    statements.push(mapsBeatmapsetStatement({
      beatmapsetId,
      title: String(mp.beatmapset.title ?? ""),
      artist: String(mp.beatmapset.artist ?? ""),
      creator: String(mp.beatmapset.creator ?? ""),
      status: String(mp.beatmapset.status ?? ""),
      covers: mp.beatmapset.covers ?? {},
      globalPlayCount: Number(mp.beatmapset.play_count ?? 0),
      globalFavouriteCount: Number(mp.beatmapset.favourite_count ?? 0),
    }, updatedAt));
    statements.push(mapsBeatmapStatement({
      beatmapId,
      beatmapsetId,
      mode: "mania",
      status: String(mp.beatmap.status ?? mp.beatmapset.status ?? ""),
      // most_played returns compact beatmaps with no cs/bpm; leave them unset
      // so the upsert keeps values learned from richer payloads.
      cs: mp.beatmap.cs == null ? undefined : Number(mp.beatmap.cs),
      difficultyRating: Number(mp.beatmap.difficulty_rating ?? 0),
      bpm: mp.beatmap.bpm == null ? undefined : Number(mp.beatmap.bpm),
      totalLength: getTotalLength(mp.beatmap),
      version: String(mp.beatmap.version ?? ""),
      url: String(mp.beatmap.url ?? `https://osu.ppy.sh/beatmaps/${beatmapId}`),
    }, updatedAt));
    statements.push({
      sql: `insert into country_maps_most_played
           (country, user_id, beatmap_id, play_count, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(country, user_id, beatmap_id) do update set
           play_count = excluded.play_count,
           updated_at = excluded.updated_at`,
      args: [country, userId, beatmapId, count, updatedAt],
    });
  }

  for (const fav of favourites) {
    const beatmapset = rawFavouriteBeatmapsetToPoolEntry(fav);
    if (!beatmapset) continue;
    statements.push(mapsBeatmapsetStatement({
      beatmapsetId: beatmapset.id,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      status: beatmapset.status,
      covers: beatmapset.covers ?? {},
      globalPlayCount: beatmapset.globalPlayCount,
      globalFavouriteCount: beatmapset.globalFavouriteCount,
      previewUrl: beatmapset.previewUrl,
      bpm: beatmapset.bpm,
      maniaKeys: beatmapset.maniaKeys,
      patterns: beatmapset.patterns,
    }, updatedAt));
    for (const beatmap of beatmapset.maniaBeatmaps ?? []) {
      statements.push(mapsBeatmapStatement({
        beatmapId: beatmap.id,
        beatmapsetId: beatmapset.id,
        mode: "mania",
        status: beatmapset.status,
        cs: beatmap.cs,
        difficultyRating: beatmap.difficultyRating,
        bpm: beatmapset.bpm,
        totalLength: beatmap.totalLength,
        version: beatmap.version,
        url: `https://osu.ppy.sh/beatmaps/${beatmap.id}`,
      }, updatedAt));
    }
    statements.push({
      sql: `insert into country_maps_favourite_sets
           (country, user_id, beatmapset_id, updated_at)
         values (?, ?, ?, ?)
         on conflict(country, user_id, beatmapset_id) do update set
           updated_at = excluded.updated_at`,
      args: [country, userId, beatmapset.id, updatedAt],
    });
  }

  statements.push({
    sql: `insert into live_meta (key, value_json, updated_at)
       values (?, ?, ?)
       on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    args: [mapsUserLibraryMetaKey(country, userId), json(updatedAt), updatedAt],
  });
  await execBatch(db, statements);
}

function rawFavouriteBeatmapsetToPoolEntry(fav: RawBeatmapset): MapsFavouriteBeatmapset | null {
  const id = Number(fav.id ?? 0);
  const maniaBeatmaps = (fav.beatmaps ?? [])
    .filter((beatmap) => isNativeManiaRawBeatmap(beatmap) && Number.isSafeInteger(Number(beatmap.id)) && Number(beatmap.id) > 0);
  if (!Number.isSafeInteger(id) || id <= 0 || maniaBeatmaps.length === 0) return null;

  const keys = new Set<number>();
  const stars: number[] = [];
  for (const beatmap of maniaBeatmaps) {
    const keyCount = Number(beatmap.cs ?? 0);
    const star = Number(beatmap.difficulty_rating ?? 0);
    if (Number.isFinite(keyCount)) keys.add(keyCount);
    if (Number.isFinite(star)) stars.push(star);
  }

  return {
    id,
    title: String(fav.title ?? ""),
    artist: String(fav.artist ?? ""),
    creator: String(fav.creator ?? ""),
    covers: fav.covers ?? {},
    status: String(fav.status ?? ""),
    globalPlayCount: Number(fav.play_count ?? 0),
    globalFavouriteCount: Number(fav.favourite_count ?? 0),
    previewUrl: String(fav.preview_url ?? ""),
    maniaKeys: [...keys].sort((a, b) => a - b),
    maniaBeatmaps: maniaBeatmaps
      .map((beatmap) => ({
        id: Number(beatmap.id),
        version: String(beatmap.version ?? ""),
        difficultyRating: Number(beatmap.difficulty_rating ?? 0),
        totalLength: getTotalLength(beatmap),
        cs: Number(beatmap.cs ?? 0),
      }))
      .sort((a, b) => b.difficultyRating - a.difficultyRating),
    starMin: stars.length ? Math.min(...stars) : 0,
    starMax: stars.length ? Math.max(...stars) : 0,
    bpm: Number(fav.bpm ?? 0),
    patterns: detectManiaPatterns(String(fav.tags ?? ""), maniaBeatmaps.map((beatmap) => String(beatmap.version ?? "")), String(fav.title ?? "")),
  };
}

async function readCountryMapsUserLibrarySection(
  db: Db,
  country: string,
  users: MapsUser[],
): Promise<CountryMapsFavouritesSection> {
  const [mostPlayed, favouriteSection] = await Promise.all([
    readCountryMostPlayedSection(db, country, users),
    readCountryFavouriteSection(db, country, users),
  ]);
  return { mostPlayed, ...favouriteSection, generatedAt: nowIso() };
}

async function readCountryMostPlayedSection(db: Db, country: string, users: MapsUser[]): Promise<MapsAggregatedBeatmap[]> {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < users.length; index += 900) {
    const chunk = users.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...(await exec(
      db,
      `select
         mp.user_id,
         mp.beatmap_id,
         mp.play_count,
         u.username,
         u.avatar_url,
         b.beatmapset_id,
         coalesce(json_extract(raw.metadata_json, '$.mode'), b.mode) as mode,
         coalesce(json_extract(raw.metadata_json, '$.convert'), 0) as convert,
         b.status as beatmap_status,
         b.cs,
         b.difficulty_rating,
         b.bpm,
         b.total_length,
         b.version,
         b.url,
         bs.title,
         bs.artist,
         bs.creator,
         bs.status as beatmapset_status,
         bs.covers_json,
         bs.global_play_count
       from country_maps_most_played mp
       left join users u on u.user_id = mp.user_id
       left join maps_beatmaps b on b.beatmap_id = mp.beatmap_id
       left join beatmaps raw on raw.beatmap_id = mp.beatmap_id
       left join maps_beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
       where mp.country = ? and mp.user_id in (${placeholders})`,
      [country, ...chunk.map((user) => user.id)],
    )).rows);
  }

  const mpMap = new Map<number, MapsAggregatedBeatmap>();
  let rowsProcessed = 0;
  for (const row of rows) {
    if (++rowsProcessed % 2000 === 0) await yieldToEventLoop();
    const beatmapId = Number(row.beatmap_id);
    const userId = Number(row.user_id);
    const count = Number(row.play_count ?? 0);
    const beatmapsetId = Number(row.beatmapset_id);
    if (
      !Number.isSafeInteger(beatmapId) || beatmapId <= 0
      || !Number.isSafeInteger(userId) || userId <= 0
      || !Number.isFinite(count) || count <= 0
      || !Number.isSafeInteger(beatmapsetId) || beatmapsetId <= 0
      || String(row.mode ?? "mania") !== "mania"
      || readBoolean(row.convert)
      || row.version == null
      || row.title == null
      || row.artist == null
    ) {
      continue;
    }

    const player = {
      id: userId,
      username: String(row.username ?? `User ${userId}`),
      avatarUrl: String(row.avatar_url ?? ""),
      count,
    };
    const existing = mpMap.get(beatmapId);
    if (existing) {
      existing.totalPlays += count;
      existing.playerCount++;
      existing.players.push(player);
    } else {
      mpMap.set(beatmapId, {
        beatmapId,
        version: String(row.version),
        difficultyRating: Number(row.difficulty_rating ?? 0),
        totalLength: Number(row.total_length ?? 0),
        beatmapsetId,
        title: String(row.title),
        artist: String(row.artist),
        creator: String(row.creator ?? ""),
        covers: parseJson<Record<string, string | undefined>>(row.covers_json, {}),
        status: String(row.beatmapset_status ?? row.beatmap_status ?? ""),
        globalPlayCount: Number(row.global_play_count ?? 0),
        totalPlays: count,
        playerCount: 1,
        players: [player],
      });
    }
  }

  for (const entry of mpMap.values()) entry.players.sort((a, b) => b.count - a.count);
  const mostPlayed = [...mpMap.values()]
    .filter((entry) => entry.playerCount >= 2)
    .sort((a, b) => b.playerCount - a.playerCount || b.totalPlays - a.totalPlays);

  return mostPlayed;
}

async function readCountryFavouriteSection(
  db: Db,
  country: string,
  users: MapsUser[],
): Promise<Omit<CountryMapsFavouritesSection, "mostPlayed" | "generatedAt">> {
  const rosterUsers = new Map(users.map((user, index) => [user.id, { user, index }]));
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < users.length; index += 900) {
    const chunk = users.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...(await exec(
      db,
      `select
         f.user_id,
         f.beatmapset_id,
         u.username,
         u.avatar_url
       from country_maps_favourite_sets f
       left join users u on u.user_id = f.user_id
       where f.country = ? and f.user_id in (${placeholders})`,
      [country, ...chunk.map((user) => user.id)],
    )).rows);
  }

  const beatmapsetIds = [...new Set(rows.map((row) => Number(row.beatmapset_id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const beatmapsets = await readMapsBeatmapsetsByIds(db, beatmapsetIds);
  const poolBeatmaps = await readMapsBeatmapsByBeatmapsetIds(db, beatmapsetIds);
  const poolBeatmapsBySet = new Map<number, MapsBeatmapMetadata[]>();
  for (const beatmap of poolBeatmaps) {
    const list = poolBeatmapsBySet.get(beatmap.beatmapsetId) ?? [];
    list.push(beatmap);
    poolBeatmapsBySet.set(beatmap.beatmapsetId, list);
  }

  const favMap = new Map<number, MapsAggregatedFavourite>();
  const favouritesByPlayerSets = new Map<number, { username: string; avatarUrl: string; beatmapsetIds: Set<number> }>();
  const beatmapsetsPool: Record<number, MapsFavouriteBeatmapset> = {};

  let rowsProcessed = 0;
  for (const row of rows) {
    if (++rowsProcessed % 2000 === 0) await yieldToEventLoop();
    const userId = Number(row.user_id);
    const beatmapsetId = Number(row.beatmapset_id);
    const beatmapset = beatmapsets.get(beatmapsetId);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !beatmapset) continue;

    const rosterUser = rosterUsers.get(userId)?.user;
    const player = {
      id: userId,
      username: String(row.username ?? rosterUser?.username ?? `User ${userId}`),
      avatarUrl: String(row.avatar_url ?? rosterUser?.avatar_url ?? ""),
    };
    const playerFavourites = favouritesByPlayerSets.get(userId) ?? {
      username: player.username,
      avatarUrl: player.avatarUrl,
      beatmapsetIds: new Set<number>(),
    };
    playerFavourites.beatmapsetIds.add(beatmapsetId);
    favouritesByPlayerSets.set(userId, playerFavourites);

    if (!beatmapsetsPool[beatmapsetId]) {
      beatmapsetsPool[beatmapsetId] = buildPoolBeatmapset(beatmapsetId, beatmapset, poolBeatmapsBySet.get(beatmapsetId) ?? []);
    }

    const existing = favMap.get(beatmapsetId);
    if (existing) {
      if (!existing.players.some((candidate) => candidate.id === userId)) {
        existing.playerCount++;
        existing.players.push(player);
      }
    } else {
      favMap.set(beatmapsetId, {
        beatmapsetId,
        title: beatmapset.title,
        artist: beatmapset.artist,
        creator: beatmapset.creator,
        covers: beatmapset.covers,
        status: beatmapset.status,
        globalPlayCount: beatmapset.globalPlayCount,
        globalFavouriteCount: beatmapset.globalFavouriteCount,
        playerCount: 1,
        players: [player],
      });
    }
  }

  const favourites = [...favMap.values()]
    .filter((entry) => entry.playerCount >= 2)
    .sort((a, b) => b.playerCount - a.playerCount || b.globalFavouriteCount - a.globalFavouriteCount);

  const favouritesByPlayer = [...favouritesByPlayerSets.entries()]
    .map(([id, value]) => ({
      id,
      username: value.username,
      avatarUrl: value.avatarUrl,
      beatmapsetIds: [...value.beatmapsetIds],
    }))
    .filter((player) => player.beatmapsetIds.length > 0)
    .sort((a, b) => (rosterUsers.get(a.id)?.index ?? Number.MAX_SAFE_INTEGER) - (rosterUsers.get(b.id)?.index ?? Number.MAX_SAFE_INTEGER));

  return { favourites, favouritesByPlayer, beatmapsetsPool };
}

function composeCountryMapsData(farmedSection: CountryMapsFarmedSection, favSection: CountryMapsFavouritesSection): CountryMapsData {
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

function isUsableMapsData(value: CountryMapsData | null): value is CountryMapsData {
  if (!value) return false;
  return (
    value.farmed.length > 0 ||
    value.favourites.length > 0 ||
    value.favouritesByPlayer.length > 0 ||
    Object.keys(value.beatmapsetsPool).length > 0
  );
}

function assertUsableMapsData(value: CountryMapsData, country: string, userCount: number): void {
  if (isUsableMapsData(value)) return;
  throw new MapsEmptyResultError(country, userCount);
}

function throwIfMapsRefreshShouldAbort(error: unknown): void {
  if (error instanceof OsuApiError && (error.status === 429 || error.status >= 500)) throw error;
  if (error instanceof Error && error.message.includes("OSU_CLIENT_ID")) throw error;
}

interface MapsFarmedOverlayWriteRow {
  country: string;
  userId: number;
  beatmapId: number;
  scoreId: number;
  pp: number;
  scoreJson: string;
  modsJson: string;
  scoreUrl: string | null;
  playedAt: string | null;
  detectedAt: string;
  updatedAt: string;
  accuracy: number | null;
  noteCount: number | null;
}

function buildMapsFarmedOverlayRows(country: string, scores: OscScore[], updatedAt: string, fallbackUserId?: number): MapsFarmedOverlayWriteRow[] {
  const rows = new Map<string, MapsFarmedOverlayWriteRow>();
  for (const score of scores) {
    if (!isPotentialFarmedScore(score)) continue;
    const userId = Number(score.user_id ?? score.user?.id ?? fallbackUserId);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) continue;
    const scoreId = getMapsFarmedDisplayScoreId(score);
    if (!Number.isFinite(scoreId) || scoreId < 0) continue;
    const pp = Number(score.pp);
    const detectedAt = getScoreTimestamp(score) || updatedAt;
    const playedAt = getScoreTimestamp(score) || null;
    const key = `${country}:${userId}:${beatmapId}`;
    const candidate = {
      country,
      userId,
      beatmapId,
      scoreId,
      pp,
      scoreJson: "{}",
      modsJson: json(getModAcronyms(score.mods)),
      scoreUrl: getScoreUrl(score),
      playedAt,
      detectedAt,
      updatedAt,
      // Peer accuracy is captured here, before the bulky score payload is
      // dropped: the pp-linear mania custom accuracy (see
      // getStoredScoreAccuracy) plus the play's judged-object count as a
      // chart-length weight.
      accuracy: getStoredScoreAccuracy(score),
      noteCount: getScoreJudgementCount(score),
    };
    const existing = rows.get(key);
    if (!existing || pp > existing.pp || (pp === existing.pp && detectedAt >= existing.detectedAt)) {
      rows.set(key, candidate);
    }
  }
  return [...rows.values()];
}

async function replaceUserMapsFarmedOverlay(
  db: Db,
  queue: JobQueue,
  country: string,
  userId: number,
  rows: MapsFarmedOverlayWriteRow[],
  updatedAt: string,
): Promise<void> {
  const previousBeatmapIds = (await exec(
    db,
    "select beatmap_id from country_maps_farmed_scores where country = ? and user_id = ?",
    [country, userId],
  )).rows
    .map((row) => Number(row.beatmap_id))
    .filter((beatmapId) => Number.isSafeInteger(beatmapId) && beatmapId > 0);
  const statements: DbStatement[] = [
    { sql: "delete from country_maps_farmed_scores where country = ? and user_id = ?", args: [country, userId] },
  ];
  for (const row of rows) {
    statements.push({
      sql: `insert into country_maps_farmed_scores
         (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, accuracy, note_count)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(country, user_id, beatmap_id) do update set
         score_id = excluded.score_id,
         pp = excluded.pp,
         score_json = excluded.score_json,
         mods_json = excluded.mods_json,
         score_url = excluded.score_url,
         played_at = excluded.played_at,
         detected_at = excluded.detected_at,
         updated_at = excluded.updated_at,
         accuracy = excluded.accuracy,
         note_count = excluded.note_count`,
      args: [
        row.country,
        row.userId,
        row.beatmapId,
        row.scoreId,
        row.pp,
        row.scoreJson,
        row.modsJson,
        row.scoreUrl,
        row.playedAt,
        row.detectedAt,
        row.updatedAt,
        row.accuracy,
        row.noteCount,
      ],
    });
  }
  const results = await execBatch(db, statements);
  const deleted = results[0];
  const affectedBeatmapIds = [...new Set([...previousBeatmapIds, ...rows.map((row) => row.beatmapId)])];
  if (affectedBeatmapIds.length > 0) {
    await syncGlobalMapsFarmedUserBeatmaps(db, userId, affectedBeatmapIds, updatedAt);
  }
  await markUserMapsFarmedOverlaySeeded(db, country, userId, updatedAt);
  if (rows.length > 0 || Number(deleted?.rowsAffected ?? 0) > 0) {
    await refreshFarmHelperKeyStatsForUser(db, userId, updatedAt);
    await touchMapsFarmedOverlay(db, country, updatedAt);
  }
  // Overlay rows come from the osu! API top-200 window, not live ingest, so
  // this is the only place aggregation-farmed maps can pick up chart analysis
  // (live-played maps get theirs from the activity recorder). Best-effort:
  // dedupe-guarded, and a failed enqueue must not fail the refresh.
  if (rows.length > 0) {
    await enqueueMissingChartAnalyses(db, queue, rows.map((row) => row.beatmapId)).catch(() => {});
  }
}

async function persistMapsFarmedScoreDisplayMetadata(db: Db, scores: OscScore[], updatedAt: string): Promise<void> {
  const statements: DbStatement[] = [];
  const propagatedSets = new Set<number>();
  for (const score of scores) {
    if (score.user) {
      statements.push({
        sql: `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at)
              values (?, ?, ?, ?, ?, ?)
              on conflict(user_id) do update set
                username = excluded.username,
                avatar_url = excluded.avatar_url,
                country_code = coalesce(excluded.country_code, users.country_code),
                updated_at = excluded.updated_at`,
        args: [
          score.user.id,
          score.user.username,
          score.user.avatar_url,
          score.user.country_code,
          json(score.user),
          updatedAt,
        ],
      });
    }

    if (score.beatmapset) {
      statements.push({
        sql: `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(beatmapset_id) do update set
                title = excluded.title,
                artist = excluded.artist,
                creator = excluded.creator,
                status = excluded.status,
                covers_json = excluded.covers_json,
                updated_at = excluded.updated_at`,
        args: [
          score.beatmapset.id,
          score.beatmapset.title,
          score.beatmapset.artist,
          score.beatmapset.creator ?? null,
          score.beatmapset.status ?? null,
          json(score.beatmapset.covers ?? {}),
          json(score.beatmapset),
          updatedAt,
        ],
      });
      statements.push(mapsBeatmapsetStatement({
        beatmapsetId: score.beatmapset.id,
        title: score.beatmapset.title,
        artist: score.beatmapset.artist,
        creator: score.beatmapset.creator ?? "",
        status: score.beatmapset.status ?? "",
        covers: score.beatmapset.covers ?? {},
      }, updatedAt));
      // A player landing a score on a freshly-ranked map is our earliest,
      // API-free signal that the set has settled. Push that status straight into
      // the search index so /maps stops showing a stale QUALIFIED. Deduped per
      // set; the builder no-ops unless the payload names a settled status.
      if (!propagatedSets.has(score.beatmapset.id)) {
        propagatedSets.add(score.beatmapset.id);
        const propagation = buildMapStatusPropagationStatement(score.beatmapset.id, score.beatmapset.status, updatedAt);
        if (propagation) statements.push(propagation);
      }
    }

    if (score.beatmap) {
      statements.push({
        sql: `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(beatmap_id) do update set
                beatmapset_id = excluded.beatmapset_id,
                mode = excluded.mode,
                status = excluded.status,
                cs = excluded.cs,
                difficulty_rating = excluded.difficulty_rating,
                bpm = excluded.bpm,
                max_combo = excluded.max_combo,
                version = excluded.version,
                url = excluded.url,
                updated_at = excluded.updated_at`,
        args: [
          score.beatmap.id,
          score.beatmap.beatmapset_id,
          score.beatmap.mode,
          score.beatmap.status ?? null,
          score.beatmap.cs,
          score.beatmap.difficulty_rating,
          score.beatmap.bpm,
          score.beatmap.max_combo ?? null,
          score.beatmap.version,
          score.beatmap.url,
          json(score.beatmap),
          updatedAt,
        ],
      });
      statements.push(mapsBeatmapStatement({
        beatmapId: score.beatmap.id,
        beatmapsetId: score.beatmap.beatmapset_id,
        mode: score.beatmap.mode,
        status: score.beatmap.status ?? "",
        cs: score.beatmap.cs,
        difficultyRating: score.beatmap.difficulty_rating,
        bpm: score.beatmap.bpm,
        totalLength: getTotalLength(score.beatmap),
        version: score.beatmap.version,
        url: score.beatmap.url,
      }, updatedAt));
    }
  }
  await execBatch(db, statements);
}

async function updateUserMapsFarmedThreshold(db: Db, userId: number, bestScores: OscScore[], refreshedAt: string): Promise<void> {
  const positivePps = bestScores
    .map((score) => score.pp)
    .filter((pp): pp is number => typeof pp === "number" && Number.isFinite(pp) && pp > 0);
  const minPp = positivePps.length >= MAPS_FARMED_SCORE_WINDOW ? Math.min(...positivePps) : 0;
  await exec(
    db,
    `update users
     set maps_farmed_min_pp = ?, maps_farmed_scores_refreshed_at = ?
     where user_id = ?`,
    [minPp, refreshedAt, userId],
  );
}

async function applyMapsFarmedOverlay(
  db: Db,
  country: string,
  value: CountryMapsData,
  refreshedAt: string | null,
): Promise<CountryMapsData> {
  if (!refreshedAt) return value;
  const global = isGlobalCountry(country);
  const rows = (await exec(
    db,
    `select
       s.country,
       s.user_id,
       s.beatmap_id,
       s.score_id,
       s.pp,
       s.score_json,
       s.mods_json,
       s.score_url,
       s.played_at,
       s.detected_at,
       s.updated_at,
       u.username,
       u.avatar_url,
       u.country_code,
       coalesce(b.beatmapset_id, mb.beatmapset_id) as beatmapset_id,
       coalesce(json_extract(b.metadata_json, '$.mode'), b.mode, mb.mode) as mode,
       coalesce(json_extract(b.metadata_json, '$.convert'), 0) as convert,
       coalesce(b.status, mb.status) as beatmap_status,
       coalesce(b.cs, mb.cs) as cs,
       coalesce(b.difficulty_rating, mb.difficulty_rating) as difficulty_rating,
       coalesce(b.bpm, mb.bpm) as bpm,
       b.max_combo,
       coalesce(b.version, mb.version) as version,
       coalesce(b.url, mb.url) as url,
       coalesce(mb.total_length, 0) as total_length,
       coalesce(bs.title, mbs.title) as title,
       coalesce(bs.artist, mbs.artist) as artist,
       coalesce(bs.creator, mbs.creator) as creator,
       coalesce(bs.status, mbs.status) as beatmapset_status,
       coalesce(bs.covers_json, mbs.covers_json) as covers_json
     from country_maps_farmed_scores s
     left join users u on u.user_id = s.user_id
     left join beatmaps b on b.beatmap_id = s.beatmap_id
     left join maps_beatmaps mb on mb.beatmap_id = s.beatmap_id
     left join beatmapsets bs on bs.beatmapset_id = coalesce(b.beatmapset_id, mb.beatmapset_id)
     left join maps_beatmapsets mbs on mbs.beatmapset_id = coalesce(b.beatmapset_id, mb.beatmapset_id)
     where ${global ? "s.country != ?" : "s.country = ?"} and s.updated_at > ?
     order by s.updated_at asc`,
    [global ? GLOBAL_COUNTRY_CODE : country, refreshedAt],
  )).rows;
  if (rows.length === 0) return value;

  const byBeatmap = new Map<number, MapsFarmedEntry>();
  for (const entry of value.farmed) {
    byBeatmap.set(entry.beatmapId, {
      ...entry,
      players: entry.players.map((player) => ({ ...player, mods: [...player.mods] })),
    });
  }

  let farmedGeneratedAt = value.farmedGeneratedAt;
  let overlayRowsProcessed = 0;
  for (const row of rows) {
    // Each row may JSON.parse a stored score blob; this runs on the request
    // path, so yield periodically instead of holding the loop for the batch.
    if (++overlayRowsProcessed % 500 === 0) await yieldToEventLoop();
    const merged = farmedOverlayRowToEntry(row);
    if (!merged) continue;
    mergeFarmedEntry(byBeatmap, merged.entry, merged.player);
    const updatedAt = String(row.updated_at ?? "");
    if (updatedAt > farmedGeneratedAt) farmedGeneratedAt = updatedAt;
  }

  const farmed = [...byBeatmap.values()].flatMap((entry) => {
    const hadTruncatedAggregate = entry.playerCount > entry.players.length;
    const aggregatePlayerCount = entry.playerCount;
    const aggregateAvgPp = entry.avgPp;
    finalizeFarmedEntry(entry);
    if (hadTruncatedAggregate) {
      entry.playerCount = Math.max(aggregatePlayerCount, entry.players.length);
      entry.avgPp = aggregateAvgPp;
    }
    if (entry.playerCount < 2 && entry.maxPp < FARMED_SINGLE_PLAYER_PP_MIN) return [];
    return [entry];
  });
  farmed.sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);

  return {
    ...value,
    farmed,
    farmedGeneratedAt,
    generatedAt: farmedGeneratedAt < value.favouritesGeneratedAt ? farmedGeneratedAt : value.favouritesGeneratedAt,
  };
}

function farmedOverlayRowToEntry(row: Record<string, unknown>): { entry: MapsFarmedEntry; player: MapsFarmedEntry["players"][number] } | null {
  const columnEntry = farmedOverlayColumnRowToEntry(row);
  if (columnEntry) return columnEntry;

  const raw = parseJson<OscScore | null>(row.score_json, null);
  if (!raw) return null;
  const score = hydrateMapsFarmedOverlayScore(row, raw);
  if (!isPotentialFarmedScore(score) || !score.beatmap || !score.beatmapset) return null;
  const pp = Number(row.pp ?? score.pp);
  const beatmapId = Number(row.beatmap_id ?? score.beatmap.id);
  const beatmapsetId = Number(score.beatmapset.id ?? score.beatmap.beatmapset_id);
  const userId = Number(row.user_id ?? score.user_id);
  if (!Number.isFinite(pp) || pp <= 0 || !Number.isFinite(beatmapId) || beatmapId <= 0 || !Number.isFinite(userId) || userId <= 0) {
    return null;
  }
  const user = score.user;
  const player = {
    id: userId,
    username: user?.username || String(row.username ?? `User ${userId}`),
    avatarUrl: user?.avatar_url || String(row.avatar_url ?? ""),
    mods: getModAcronyms(score.mods),
    pp,
    scoreUrl: getScoreUrl(score),
    playedAt: getScoreTimestamp(score) || null,
  };
  return {
    entry: {
      beatmapId,
      version: score.beatmap.version,
      difficultyRating: score.beatmap.difficulty_rating,
      totalLength: getTotalLength(score.beatmap),
      cs: score.beatmap.cs,
      bpm: score.beatmap.bpm,
      beatmapsetId,
      title: score.beatmapset.title,
      artist: score.beatmapset.artist,
      creator: score.beatmapset.creator ?? "",
      covers: score.beatmapset.covers,
      status: score.beatmapset.status ?? score.beatmap.status ?? "",
      playerCount: 1,
      players: [player],
      avgPp: pp,
      maxPp: pp,
    },
    player,
  };
}

function farmedOverlayColumnRowToEntry(row: Record<string, unknown>): { entry: MapsFarmedEntry; player: MapsFarmedEntry["players"][number] } | null {
  const pp = Number(row.pp);
  const beatmapId = Number(row.beatmap_id);
  const beatmapsetId = Number(row.beatmapset_id);
  const userId = Number(row.user_id);
  if (
    !Number.isFinite(pp) || pp <= 0
    || !Number.isFinite(beatmapId) || beatmapId <= 0
    || !Number.isFinite(beatmapsetId) || beatmapsetId <= 0
    || !Number.isFinite(userId) || userId <= 0
    || row.version == null
    || row.title == null
    || row.artist == null
  ) {
    return null;
  }

  if (String(row.mode ?? "mania") !== "mania" || readBoolean(row.convert)) return null;

  const status = String(row.beatmapset_status ?? row.beatmap_status ?? "");
  if (status && status.toLowerCase() !== "ranked") return null;
  const player = {
    id: userId,
    username: String(row.username ?? `User ${userId}`),
    avatarUrl: String(row.avatar_url ?? ""),
    mods: parseJson<string[]>(row.mods_json, []),
    pp,
    scoreUrl: row.score_url == null ? null : String(row.score_url),
    playedAt: row.played_at == null ? null : String(row.played_at),
  };
  return {
    entry: {
      beatmapId,
      version: String(row.version),
      difficultyRating: Number(row.difficulty_rating ?? 0),
      totalLength: Number(row.total_length ?? 0),
      cs: Number(row.cs ?? 0),
      bpm: Number(row.bpm ?? 0),
      beatmapsetId,
      title: String(row.title),
      artist: String(row.artist),
      creator: String(row.creator ?? ""),
      covers: parseJson<Record<string, string | undefined>>(row.covers_json, {}),
      status,
      playerCount: 1,
      players: [player],
      avgPp: pp,
      maxPp: pp,
    },
    player,
  };
}

function hydrateMapsFarmedOverlayScore(row: Record<string, unknown>, score: OscScore): OscScore {
  const userId = Number(row.user_id ?? score.user_id);
  const storedUser = Number.isFinite(userId) && userId > 0
    ? {
        id: userId,
        username: String(row.username ?? score.user?.username ?? `User ${userId}`),
        avatar_url: String(row.avatar_url ?? score.user?.avatar_url ?? ""),
        country_code: String(row.country_code ?? score.user?.country_code ?? ""),
      }
    : score.user;
  const storedBeatmap = rowMapsBeatmap(row);
  const storedBeatmapset = rowMapsBeatmapset(row);
  const beatmap = score.beatmap
    ? {
        ...(storedBeatmap ?? {}),
        ...score.beatmap,
        status: score.beatmap.status ?? storedBeatmap?.status,
      }
    : storedBeatmap;
  const beatmapset = score.beatmapset
    ? {
        ...(storedBeatmapset ?? {}),
        ...score.beatmapset,
        creator: score.beatmapset.creator ?? storedBeatmapset?.creator,
        covers: Object.keys(score.beatmapset.covers ?? {}).length > 0 ? score.beatmapset.covers : storedBeatmapset?.covers ?? {},
        status: score.beatmapset.status ?? storedBeatmapset?.status,
      }
    : storedBeatmapset;
  return { ...score, user: storedUser, beatmap, beatmapset };
}

function rowMapsBeatmap(row: Record<string, unknown>): OscScore["beatmap"] | undefined {
  const id = Number(row.beatmap_id);
  const beatmapsetId = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(beatmapsetId) || beatmapsetId <= 0 || row.version == null) return undefined;
  return {
    id,
    beatmapset_id: beatmapsetId,
    difficulty_rating: Number(row.difficulty_rating ?? 0),
    mode: String(row.mode ?? "mania"),
    convert: readBoolean(row.convert),
    status: row.beatmap_status == null ? undefined : String(row.beatmap_status),
    cs: Number(row.cs ?? 0),
    bpm: Number(row.bpm ?? 0),
    max_combo: row.max_combo == null ? undefined : Number(row.max_combo),
    version: String(row.version),
    url: String(row.url ?? `https://osu.ppy.sh/beatmaps/${id}`),
  };
}

function rowMapsBeatmapset(row: Record<string, unknown>): OscScore["beatmapset"] | undefined {
  const id = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || row.title == null || row.artist == null) return undefined;
  return {
    id,
    title: String(row.title),
    artist: String(row.artist),
    creator: row.creator == null ? undefined : String(row.creator),
    covers: parseJson<Record<string, string | undefined>>(row.covers_json, {}),
    status: row.beatmapset_status == null ? undefined : String(row.beatmapset_status),
  };
}

function mergeFarmedEntry(
  byBeatmap: Map<number, MapsFarmedEntry>,
  incoming: MapsFarmedEntry,
  player: MapsFarmedEntry["players"][number],
): void {
  const existing = byBeatmap.get(incoming.beatmapId);
  if (!existing) {
    byBeatmap.set(incoming.beatmapId, incoming);
    return;
  }
  const playerIndex = existing.players.findIndex((candidate) => candidate.id === player.id);
  if (playerIndex >= 0) {
    const current = existing.players[playerIndex];
    if (player.pp < current.pp || (player.pp === current.pp && (player.playedAt ?? "") < (current.playedAt ?? ""))) return;
    existing.players[playerIndex] = player;
  } else {
    existing.players.push(player);
  }
}

function finalizeFarmedEntry(entry: MapsFarmedEntry): void {
  entry.players.sort((a, b) => b.pp - a.pp);
  entry.playerCount = entry.players.length;
  entry.maxPp = Math.max(...entry.players.map((player) => player.pp), 0);
  entry.avgPp = entry.players.length > 0
    ? entry.players.reduce((sum, player) => sum + player.pp, 0) / entry.players.length
    : 0;
}

function isPotentialFarmedScore(score: OscScore): boolean {
  if (score.pp == null || score.pp <= 0) return false;
  if (score.beatmap && score.beatmap.mode !== "mania") return false;
  if (score.beatmap?.convert) return false;
  if (score.ranked === false) return false;
  const knownStatus = String(score.beatmapset?.status ?? score.beatmap?.status ?? "").toLowerCase();
  return knownStatus === "" || knownStatus === "ranked";
}

function getMapsFarmedDisplayScoreId(score: OscScore): number {
  return score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id;
}

function getMapsFarmedScoreDedupeKey(score: OscScore): string {
  const scoreId = getMapsFarmedDisplayScoreId(score);
  return scoreId > 0 ? String(scoreId) : getScoreIdentity(score);
}

async function readMapsFarmedOverlayUpdatedAt(db: Db, country: string): Promise<string | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [mapsFarmedOverlayMetaKey(country)])).rows[0];
  const parsed = parseJson<string | null>(row?.value_json, null);
  return typeof parsed === "string" && parsed ? parsed : null;
}

async function readMapsFarmedOverlayRowsUpdatedAt(db: Db, country: string): Promise<string | null> {
  const row = (await exec(
    db,
    "select max(updated_at) as updated_at from country_maps_farmed_scores where country = ?",
    [country],
  )).rows[0];
  return row?.updated_at == null ? null : String(row.updated_at);
}

async function readLatestCountryMapsSourceRefreshedAt(db: Db): Promise<string | null> {
  const row = (await exec(
    db,
    "select max(refreshed_at) as refreshed_at from country_maps_snapshots where country != ?",
    [GLOBAL_COUNTRY_CODE],
  )).rows[0];
  return row?.refreshed_at == null ? null : String(row.refreshed_at);
}

async function isGlobalMapsSnapshotBehindSources(db: Db, refreshedAt: string | null): Promise<boolean> {
  // Farmed freshness is tracked by global_maps_farmed_state and patched onto
  // the packed board. Only the blob-backed popular/favourite/random sections
  // can make the compatibility GLOBAL snapshot stale now.
  return isIsoAfter(await readLatestCountryMapsSourceRefreshedAt(db), refreshedAt);
}

function isIsoAfter(candidate: string | null | undefined, baseline: string | null | undefined): boolean {
  if (!candidate) return false;
  if (!baseline) return true;
  return candidate > baseline;
}

async function readGlobalMapsFarmedOverlayUpdatedAt(db: Db): Promise<string | null> {
  const rows = (await exec(
    db,
    "select value_json from live_meta where key like ? and key != ?",
    [`${MAPS_FARMED_OVERLAY_META_PREFIX}%`, mapsFarmedOverlayMetaKey(GLOBAL_COUNTRY_CODE)],
  )).rows;
  let latest: string | null = null;
  for (const row of rows) {
    const value = parseJson<string | null>(row.value_json, null);
    if (typeof value === "string" && value && (!latest || value > latest)) latest = value;
  }
  return latest;
}

async function readGlobalMapsFarmedOverlayRowsUpdatedAt(db: Db): Promise<string | null> {
  const row = (await exec(
    db,
    "select max(updated_at) as updated_at from country_maps_farmed_scores where country != ?",
    [GLOBAL_COUNTRY_CODE],
  )).rows[0];
  return row?.updated_at == null ? null : String(row.updated_at);
}

async function touchMapsFarmedOverlay(db: Db, country: string, updatedAt: string): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [mapsFarmedOverlayMetaKey(country), json(updatedAt), updatedAt],
  );
}

function mapsFarmedOverlayMetaKey(country: string): string {
  return `${MAPS_FARMED_OVERLAY_META_PREFIX}${country.toUpperCase()}`;
}

async function markUserMapsFarmedOverlaySeeded(db: Db, country: string, userId: number, updatedAt: string): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [mapsFarmedUserOverlayMetaKey(country, userId), json(updatedAt), updatedAt],
  );
}

function mapsFarmedUserOverlayMetaKey(country: string, userId: number): string {
  return `${MAPS_FARMED_USER_OVERLAY_META_PREFIX}${country.toUpperCase()}:${userId}`;
}

function userIdFromMapsFarmedUserOverlayMetaKey(key: string): number | null {
  if (!key.startsWith(MAPS_FARMED_USER_OVERLAY_META_PREFIX)) return null;
  const id = Number(key.slice(key.lastIndexOf(":") + 1));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function mapsUserLibraryMetaKey(country: string, userId: number): string {
  return `${MAPS_USER_LIBRARY_META_PREFIX}${country.toUpperCase()}:${userId}`;
}

function userIdFromMapsUserLibraryMetaKey(key: string): number | null {
  if (!key.startsWith(MAPS_USER_LIBRARY_META_PREFIX)) return null;
  const id = Number(key.slice(key.lastIndexOf(":") + 1));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getTotalLength(beatmap: RawBeatmap | NonNullable<OscScore["beatmap"]>): number {
  return Number("total_length" in beatmap ? beatmap.total_length ?? 0 : 0);
}

function getScoreUrl(score: OscScore): string | null {
  if (score.id <= 0) return null;
  if (score.type === "solo_score") return `https://osu.ppy.sh/scores/${score.id}`;
  return `https://osu.ppy.sh/scores/${score.beatmap?.mode ?? "mania"}/${score.id}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const PATTERN_VARIANTS: Array<{ canonical: string; variants: string[]; sources?: Array<"tags" | "version" | "title"> }> = [
  { canonical: "chordjack", variants: ["chordjack", "chord jack"] },
  { canonical: "longjack", variants: ["longjack", "long jack"] },
  { canonical: "speedjack", variants: ["speedjack", "speed jack", "jackspeed", "jack speed"] },
  { canonical: "minijack", variants: ["minijack", "mini jack"] },
  { canonical: "jack", variants: ["jack"] },
  { canonical: "jumpstream", variants: ["jumpstream", "jump stream"] },
  { canonical: "chordstream", variants: ["chordstream", "chord stream"] },
  { canonical: "handstream", variants: ["handstream", "hand stream"] },
  { canonical: "dumpstream", variants: ["dumpstream", "dump stream"] },
  { canonical: "stream", variants: ["stream"] },
  { canonical: "stamina", variants: ["stamina"] },
  { canonical: "tech", variants: ["tech", "technical"] },
  { canonical: "ln", variants: ["ln", "long note", "long notes", "noodle", "noodles"] },
  { canonical: "rice", variants: ["rice"] },
  { canonical: "sv", variants: ["sv", "scroll velocity"] },
  { canonical: "bracket", variants: ["bracket", "brackets"] },
  { canonical: "speed", variants: ["speed"], sources: ["version", "title"] },
  { canonical: "tiebreaker", variants: ["tiebreaker", "tb", "mwc", "grandfinals", "world cup"] },
];

const SUBSUMED: Record<string, string[]> = {
  jack: ["chordjack", "longjack", "speedjack", "minijack"],
  stream: ["jumpstream", "chordstream", "handstream", "dumpstream"],
};

function detectManiaPatterns(tagsText: string, versionNames: string[] = [], title = ""): string[] {
  const pack = isPackTitle(title);
  const sources = [
    { kind: "tags" as const, text: tagsText },
    ...(pack
      ? [{ kind: "title" as const, text: title }]
      : versionNames.map((version) => ({ kind: "version" as const, text: version }))),
  ].filter((source) => source.text.trim());
  if (sources.length === 0) return [];

  const detected = new Set<string>();
  for (const { canonical, variants, sources: allowedSources } of PATTERN_VARIANTS) {
    const candidateSources = allowedSources ? sources.filter((source) => allowedSources.includes(source.kind)) : sources;
    for (const variant of variants) {
      if (candidateSources.some((source) => sourceHasVariant(source.text, variant))) {
        detected.add(canonical);
        break;
      }
    }
  }
  for (const [generic, specifics] of Object.entries(SUBSUMED)) {
    if (specifics.some((specific) => detected.has(specific))) detected.delete(generic);
  }
  return [...detected];
}

function isPackTitle(title: string): boolean {
  const tokens = new Set(title.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean));
  return ["pack", "packs", "collection", "compilation", "marathon"].some((hint) => tokens.has(hint));
}

function sourceHasVariant(text: string, variant: string): boolean {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  if (variant === "world cup") return tokens.includes("world") && tokens.includes("cup");
  if (!variant.includes(" ")) return tokens.includes(variant);
  for (let index = 0; index < tokens.length - 1; index++) {
    if (`${tokens[index]} ${tokens[index + 1]}` === variant) return true;
  }
  return false;
}
