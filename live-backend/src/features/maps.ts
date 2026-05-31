import type { InValue } from "@libsql/client";
import { readConfig } from "../config.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getModAcronyms, getScoreIdentity, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

const MAPS_REFRESH_PRIORITY = 20;
const MAPS_FARMED_REFRESH_PRIORITY = 35;
const MAPS_FETCH_CONCURRENCY = 2;
const MAPS_FARMED_SCORE_WINDOW = 200;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const USER_FAVOURITES_MAX_PAGES = 10;
const MAPS_FARMED_OVERLAY_META_PREFIX = "maps_farmed_overlay_updated_at:";

export class MapsRosterNotReadyError extends Error {
  constructor(readonly country: string) {
    super(`Roster not ready for ${country}`);
    this.name = "MapsRosterNotReadyError";
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
}

interface MapsFavouriteBeatmapset {
  id: number;
  title: string;
  artist: string;
  creator: string;
  covers: Record<string, string | undefined>;
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
  farmed: Array<Pick<MapsFarmedEntry, "beatmapId" | "playerCount" | "avgPp" | "maxPp"> & { players: StoredMapsFarmedPlayer[] }>;
  mostPlayed: Array<Pick<MapsAggregatedBeatmap, "beatmapId" | "totalPlays" | "playerCount"> & { players: StoredMapsCountPlayer[] }>;
  favourites: Array<Pick<MapsAggregatedFavourite, "beatmapsetId" | "playerCount"> & { players: StoredMapsPlayer[] }>;
  favouritesByPlayer: Array<Pick<MapsPlayerFavourites, "id" | "beatmapsetIds">>;
  beatmapsetsPool: number[];
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
}

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

type RawBeatmap = {
  id?: number;
  beatmapset_id?: number;
  difficulty_rating?: number;
  mode?: string;
  status?: string;
  cs?: number;
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

export async function enqueueMapsRefresh(queue: JobQueue, country: string, options: { priority?: number; replaceDone?: boolean } = {}): Promise<void> {
  const normalized = country.toUpperCase();
  if (isGlobalCountry(normalized)) {
    await enqueueGlobalMapsRefresh(queue, options);
    return;
  }
  await queue.enqueue(
    "refresh_country_maps",
    `maps:${normalized}`,
    { country: normalized },
    { priority: options.priority ?? MAPS_REFRESH_PRIORITY, replaceDone: options.replaceDone ?? true },
  );
}

// The Global maps aggregate is rebuilt by merging every country's stored
// snapshot, so it gets its own job type (no roster fetch). It still shares the
// `maps:GLOBAL` dedupe key so hasActiveMapsRefresh(db, "GLOBAL") works.
export async function enqueueGlobalMapsRefresh(queue: JobQueue, options: { priority?: number; replaceDone?: boolean } = {}): Promise<void> {
  await queue.enqueue(
    "refresh_global_maps",
    `maps:${GLOBAL_COUNTRY_CODE}`,
    {},
    { priority: options.priority ?? MAPS_REFRESH_PRIORITY, replaceDone: options.replaceDone ?? true },
  );
}

export async function enqueueGlobalMapsRefreshIfDue(
  db: Db,
  queue: JobQueue,
  maxAgeMs: number,
  options: { priority?: number; replaceDone?: boolean } = {},
): Promise<boolean> {
  const meta = await getMapsSnapshotMeta(db, GLOBAL_COUNTRY_CODE);
  const refreshedMs = meta.refreshedAt ? new Date(meta.refreshedAt).getTime() : 0;
  const sourceRefreshedAt = meta.sourceRefreshedAt;
  const sourceRefreshedMs = sourceRefreshedAt ? new Date(sourceRefreshedAt).getTime() : 0;
  const isBehindSource = Number.isFinite(sourceRefreshedMs)
    && sourceRefreshedMs > 0
    && (!Number.isFinite(refreshedMs) || sourceRefreshedMs > refreshedMs);
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || isBehindSource;
  if (!isStale) return false;
  if (await hasActiveMapsRefresh(db, GLOBAL_COUNTRY_CODE)) return true;
  await enqueueGlobalMapsRefresh(queue, options);
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

export async function deferMapsRefreshesWaitingForRoster(db: Db, retryDelayMs = 10 * 60_000): Promise<number> {
  const result = await exec(
    db,
    `update jobs
     set status = 'queued',
         locked_by = null,
         locked_until = null,
         run_after = ?,
         last_error = null,
         updated_at = ?
     where type = 'refresh_country_maps'
       and status = 'failed'
       and last_error like 'No tracked roster users available for %'`,
    [new Date(Date.now() + retryDelayMs).toISOString(), nowIso()],
  );
  return Number(result.rowsAffected ?? 0);
}

export type MapsSnapshotSection = "core" | "random";
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

export async function getMapsSnapshot(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
  section: MapsSnapshotSection = "core",
): Promise<{ value: CountryMapsData | null; generatedAt: string | null; refreshedAt: string | null; isStale: boolean; refreshQueued: boolean }> {
  const normalized = country.toUpperCase();
  const snapshot = await readMapsSnapshot(db, normalized, maxAgeMs);
  const value = section === "core" && snapshot.value
    ? await applyMapsFarmedOverlay(db, normalized, snapshot.value, snapshot.refreshedAt)
    : snapshot.value;
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (snapshot.isStale && !refreshQueued) {
    await enqueueMapsRefresh(queue, normalized);
    refreshQueued = true;
  }
  return { ...snapshot, value: sliceMapsSnapshotSection(value, section), refreshQueued };
}

export async function getMapsPageSnapshot(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
  query: MapsPageQuery,
): Promise<{ value: MapsPageValue | null; generatedAt: string | null; refreshedAt: string | null; isStale: boolean; refreshQueued: boolean }> {
  const normalized = country.toUpperCase();
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
  };
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

  const all = await getFullMapsDetailsPlayers(db, normalized, kind, safeId);
  const q = query.q.trim().toLowerCase();
  const matched = q ? all.filter((player) => player.username.toLowerCase().includes(q)) : all;
  const start = page * pageSize;
  return {
    kind,
    id: safeId,
    total: all.length,
    matched: matched.length,
    page,
    pageSize,
    players: matched.slice(start, start + pageSize),
  };
}

// The full player list for one map is assembled from every country's stored
// snapshot (and the farmed-score rows), which is expensive to parse. Modal
// pagination/search re-hits the same map repeatedly, so the assembled list is
// cached for a short window (matching the HTTP cache-control) under a bounded
// LRU so paging through a 1k+ player map never re-parses all snapshots.
interface CachedMapsDetailsPlayers {
  players: MapsDetailsPlayer[];
  expiresAt: number;
}

const MAPS_DETAILS_PLAYERS_CACHE_TTL_MS = 60_000;
const MAPS_DETAILS_PLAYERS_CACHE_MAX_ENTRIES = 48;
// Per-Db cache so the entries never leak across databases (one process holds a
// single Db in production; tests spin up a fresh Db each).
const mapsDetailsPlayersCache = new WeakMap<Db, Map<string, CachedMapsDetailsPlayers>>();

async function getFullMapsDetailsPlayers(
  db: Db,
  country: string,
  kind: MapsPlayersKind,
  id: number,
): Promise<MapsDetailsPlayer[]> {
  let cache = mapsDetailsPlayersCache.get(db);
  if (!cache) mapsDetailsPlayersCache.set(db, (cache = new Map()));
  const cacheKey = `${country}:${kind}:${id}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached.players;
  }

  const players = kind === "farmed"
    ? mergeFarmedDetailsPlayers(
        await readMapsDetailsPlayersFromSnapshots(db, country, kind, id),
        await readFarmedDetailsPlayersFromScores(db, country, id),
      )
    : await readMapsDetailsPlayersFromSnapshots(db, country, kind, id);

  cache.set(cacheKey, { players, expiresAt: now + MAPS_DETAILS_PLAYERS_CACHE_TTL_MS });
  while (cache.size > MAPS_DETAILS_PLAYERS_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return players;
}

/**
 * Timestamp-only read of a country's maps snapshot row — no payload_json parse
 * or user hydration. The HTTP layer uses refreshedAt to key its response cache
 * so a cache hit can skip the (expensive) getMapsSnapshot() path entirely.
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
  const farmedOverlayUpdatedAt = isGlobalCountry(normalized)
    ? await readGlobalMapsFarmedOverlayUpdatedAt(db)
    : await readMapsFarmedOverlayUpdatedAt(db, normalized);
  return {
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt: row?.refreshed_at == null ? null : String(row.refreshed_at),
    sourceRefreshedAt,
    farmedOverlayUpdatedAt,
  };
}

// The maps snapshot is served in two parts so /maps first paint stays small.
// "core" carries the three browsable tabs; "random" carries only the heavy
// beatmapsetsPool the Random tab needs. favouritesByPlayer is tiny, so it
// always rides with "core" — that lets the client tell "no random pool exists"
// apart from "random pool not loaded yet".
function sliceMapsSnapshotSection(value: CountryMapsData | null, section: MapsSnapshotSection): CountryMapsData | null {
  if (!value) return value;
  if (section === "random") {
    // The Random tab only needs each set's filter/label fields here; the heavy
    // covers, per-difficulty list and preview audio are fetched per pick via
    // getMapsRandomBeatmapsets, so strip them to keep this payload small.
    const beatmapsetsPool: Record<number, MapsFavouriteBeatmapset> = {};
    for (const [id, set] of Object.entries(value.beatmapsetsPool)) {
      beatmapsetsPool[Number(id)] = { ...set, covers: {}, maniaBeatmaps: [], previewUrl: "" };
    }
    return { ...value, farmed: [], mostPlayed: [], favourites: [], beatmapsetsPool };
  }
  return { ...value, beatmapsetsPool: {} };
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
  const isUsable = isUsableMapsData(value);
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || (!!row && !isUsable);
  return {
    value,
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt,
    isStale,
  };
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
  const refreshedMs = refreshedAt ? new Date(refreshedAt).getTime() : 0;
  const parsed = row ? parseJson<unknown>(row.payload_json, null) : null;
  const usable = isStoredCountryMapsData(parsed)
    ? isUsableStoredMapsData(parsed)
    : isCountryMapsDataShape(parsed) && isUsableMapsData(parsed);
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || (!!row && !usable);
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
    if (!beatmap || !beatmapset) return [];
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
    }];
  });

  const mostPlayed = value.mostPlayed.flatMap((entry): MapsAggregatedBeatmap[] => {
    const beatmap = allBeatmaps.get(entry.beatmapId);
    const beatmapset = beatmap ? beatmapsets.get(beatmap.beatmapsetId) : undefined;
    if (!beatmap || !beatmapset) return [];
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
    const current = poolBeatmapsBySet.get(beatmap.beatmapsetId) ?? [];
    current.push(beatmap);
    poolBeatmapsBySet.set(beatmap.beatmapsetId, current);
  }
  const beatmapsetsPool = Object.fromEntries(value.beatmapsetsPool.flatMap((id): Array<[number, MapsFavouriteBeatmapset]> => {
    const beatmapset = beatmapsets.get(id);
    if (!beatmapset) return [];
    return [[id, buildPoolBeatmapset(id, beatmapset, poolBeatmapsBySet.get(id) ?? [])]];
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
    return beatmapset ? [buildPoolBeatmapset(id, beatmapset, beatmapsBySet.get(id) ?? [], { trimCovers: true })] : [];
  });
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
  if (query.tab === "farmed") {
    value = await applyMapsFarmedOverlay(db, country, value, refreshedAt);
  }
  const allItems = filterSortMapsPageItems(value, query);
  const items = await hydrateMapsPageItemUsers(db, allItems.slice(page * pageSize, page * pageSize + pageSize));
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
  const items = await hydrateMapsPageItemUsers(db, allItems.slice(query.page * query.pageSize, query.page * query.pageSize + query.pageSize));
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

async function hydrateCompactFarmedEntries(
  db: Db,
  entries: StoredCountryMapsData["farmed"],
): Promise<MapsFarmedEntry[]> {
  const beatmaps = await readMapsBeatmapsByIds(db, entries.map((entry) => entry.beatmapId));
  const beatmapsets = await readMapsBeatmapsetsByIds(db, [...new Set([...beatmaps.values()].map((beatmap) => beatmap.beatmapsetId))]);

  return entries.flatMap((entry): MapsFarmedEntry[] => {
    const beatmap = beatmaps.get(entry.beatmapId);
    const beatmapset = beatmap ? beatmapsets.get(beatmap.beatmapsetId) : undefined;
    if (!beatmap || !beatmapset) return [];
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
    if (!beatmap || !beatmapset) return [];
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

async function readFarmedDetailsPlayersFromScores(db: Db, country: string, beatmapId: number): Promise<MapsDetailsPlayer[]> {
  const global = isGlobalCountry(country);
  const rows = (await exec(
    db,
    `select s.user_id, s.pp, s.mods_json, s.score_url, s.played_at, u.username, u.avatar_url
     from country_maps_farmed_scores s
     left join users u on u.user_id = s.user_id
     where ${global ? "s.country != ?" : "s.country = ?"} and s.beatmap_id = ?
     order by s.pp desc`,
    [global ? GLOBAL_COUNTRY_CODE : country, beatmapId],
  )).rows;

  const byUser = new Map<number, MapsDetailsPlayer>();
  for (const row of rows) {
    const userId = Number(row.user_id);
    const pp = Number(row.pp ?? 0);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(pp) || pp <= 0) continue;
    const current = byUser.get(userId);
    if (current?.pp != null && current.pp >= pp) continue;
    byUser.set(userId, {
      id: userId,
      username: String(row.username ?? `User ${userId}`),
      avatarUrl: String(row.avatar_url ?? ""),
      pp,
      mods: parseJson<string[]>(row.mods_json, []),
      scoreUrl: row.score_url == null ? null : String(row.score_url),
      playedAt: row.played_at == null ? null : String(row.played_at),
    });
  }

  return [...byUser.values()].sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));
}

function mergeFarmedDetailsPlayers(...groups: MapsDetailsPlayer[][]): MapsDetailsPlayer[] {
  const byUser = new Map<number, MapsDetailsPlayer>();
  for (const group of groups) {
    for (const player of group) {
      const current = byUser.get(player.id);
      if (current?.pp != null && player.pp != null && current.pp >= player.pp) continue;
      byUser.set(player.id, player);
    }
  }
  return [...byUser.values()].sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));
}

async function readMapsDetailsPlayersFromSnapshots(
  db: Db,
  country: string,
  kind: MapsPlayersKind,
  id: number,
): Promise<MapsDetailsPlayer[]> {
  const rows = (await exec(
    db,
    `select payload_json
     from country_maps_snapshots
     where ${isGlobalCountry(country) ? "country != ?" : "country = ?"}`,
    [isGlobalCountry(country) ? GLOBAL_COUNTRY_CODE : country],
  )).rows;

  const byUser = new Map<number, MapsDetailsPlayer>();
  for (const row of rows) {
    const stored = toStoredCountryMapsData(parseJson<unknown>(row.payload_json, null));
    if (!stored) continue;

    if (kind === "farmed") {
      const entry = stored.farmed.find((candidate) => candidate.beatmapId === id);
      if (!entry) continue;
      for (const player of entry.players) {
        const current = byUser.get(player.id);
        if (current?.pp != null && current.pp >= player.pp) continue;
        byUser.set(player.id, {
          id: player.id,
          username: "",
          avatarUrl: "",
          pp: player.pp,
          mods: [...player.mods],
          scoreUrl: player.scoreUrl,
          playedAt: player.playedAt,
        });
      }
      continue;
    }

    if (kind === "popular") {
      const entry = stored.mostPlayed.find((candidate) => candidate.beatmapId === id);
      if (!entry) continue;
      for (const player of entry.players) {
        const current = byUser.get(player.id);
        byUser.set(player.id, {
          id: player.id,
          username: "",
          avatarUrl: "",
          count: (current?.count ?? 0) + player.count,
        });
      }
      continue;
    }

    const entry = stored.favourites.find((candidate) => candidate.beatmapsetId === id);
    if (!entry) continue;
    for (const player of entry.players) {
      if (byUser.has(player.id)) continue;
      byUser.set(player.id, { id: player.id, username: "", avatarUrl: "" });
    }
  }

  const players = [...byUser.values()];
  await hydrateMapsDetailsPlayers(db, players);
  if (kind === "farmed") return players.sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));
  if (kind === "popular") return players.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return players.sort((a, b) => a.username.localeCompare(b.username));
}

async function hydrateMapsDetailsPlayers(db: Db, players: MapsDetailsPlayer[]): Promise<void> {
  const users = await readMapsUserDisplayByIds(db, players.map((player) => player.id));
  for (const player of players) {
    const user = users.get(player.id);
    player.username = user?.username || player.username || `User ${player.id}`;
    player.avatarUrl = user?.avatarUrl || player.avatarUrl || "";
  }
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
      };
    })
    .filter(
      (entry): entry is MapsFarmedEntry =>
        entry !== null &&
        matchesMapsKeyFilter(entry.cs, query.key) &&
        matchesMapsSearch(query.q, [entry.title, entry.artist, entry.creator, entry.version]) &&
        (query.mod === "all" || (
          query.mod === "dt" ? getDominantMapsSpeedMod(entry.players) === "DT" :
          query.mod === "ht" ? getDominantMapsSpeedMod(entry.players) === "HT" :
          getDominantMapsSpeedMod(entry.players) === null
        )),
    )
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
  if (dtCount >= htCount) return dtCount > players.length / 2 ? "DT" : null;
  if (htCount > players.length / 2) {
    const topPlayer = players.reduce((best, player) => (player.pp > best.pp ? player : best), players[0]);
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

export async function refreshCountryMaps(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow" | "getUserMostPlayed" | "getUserFavourites">,
  payload: { country: string },
): Promise<CountryMapsData> {
  const country = payload.country.toUpperCase();
  const users = await getMapsUsers(db, country);
  if (users.length === 0) throw new MapsRosterNotReadyError(country);
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

  const farmedPromise = buildCountryFarmed(db, osu, users).then(async (section) => {
    latestFarmed = section;
    await persistLatest();
    return section;
  });
  const favouritesPromise = buildCountryFavourites(osu, users).then(async (section) => {
    latestFavourites = section;
    await persistLatest();
    return section;
  });

  const [farmedSection, favSection] = await Promise.all([farmedPromise, favouritesPromise]);
  const value = composeCountryMapsData(farmedSection, favSection);
  assertUsableMapsData(value, users.length);
  await persistMapsSnapshot(db, country, value);
  return value;
}

// The merged Global snapshot keeps every distinct farmed/popular/favourite map
// (a few thousand each across all countries) so the tab totals are real. The
// per-map player list remains a page preview; full modal player lists are read
// on demand from compact per-country snapshots / farmed-score rows.
const GLOBAL_MAPS_PLAYERS_PER_ENTRY = 80;

// Rebuilds the synthetic GLOBAL maps snapshot by merging every country's stored
// snapshot. Works entirely on the compact (ID-only) stored form: the beatmap,
// beatmapset and user display rows the read path hydrates from were already
// written by each country's own refresh, so no osu! API calls are needed.
export async function refreshGlobalMaps(db: Db): Promise<CountryMapsData> {
  const rows = (await exec(
    db,
    "select payload_json from country_maps_snapshots where country != ?",
    [GLOBAL_COUNTRY_CODE],
  )).rows;

  const farmedByBeatmap = new Map<number, Map<number, StoredMapsFarmedPlayer>>();
  const mostPlayedByBeatmap = new Map<number, Map<number, StoredMapsCountPlayer>>();
  const favouritesByBeatmapset = new Map<number, Set<number>>();
  const favouritesByPlayerSets = new Map<number, Set<number>>();
  const pool = new Set<number>();

  for (const row of rows) {
    const stored = toStoredCountryMapsData(parseJson<unknown>(row.payload_json, null));
    if (!stored) continue;
    for (const entry of stored.farmed) {
      let players = farmedByBeatmap.get(entry.beatmapId);
      if (!players) farmedByBeatmap.set(entry.beatmapId, (players = new Map()));
      for (const player of entry.players) {
        const existing = players.get(player.id);
        if (!existing || player.pp > existing.pp) players.set(player.id, player);
      }
    }
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

  // Farmed scores also live in a compact row table as players refresh over
  // time. Merge those in so Global farmed counts are not limited to whatever
  // was present in the last per-country snapshot.
  const farmedScoreRows = (await exec(
    db,
    `select beatmap_id, user_id, pp, mods_json, score_url, played_at
     from country_maps_farmed_scores
     where country != ?`,
    [GLOBAL_COUNTRY_CODE],
  )).rows;
  for (const row of farmedScoreRows) {
    const beatmapId = Number(row.beatmap_id);
    const userId = Number(row.user_id);
    const pp = Number(row.pp ?? 0);
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0 || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(pp) || pp <= 0) {
      continue;
    }
    let players = farmedByBeatmap.get(beatmapId);
    if (!players) farmedByBeatmap.set(beatmapId, (players = new Map()));
    const player: StoredMapsFarmedPlayer = {
      id: userId,
      pp,
      mods: parseJson<string[]>(row.mods_json, []),
      scoreUrl: row.score_url == null ? null : String(row.score_url),
      playedAt: row.played_at == null ? null : String(row.played_at),
    };
    const existing = players.get(userId);
    if (!existing || player.pp > existing.pp || (player.pp === existing.pp && (player.playedAt ?? "") > (existing.playedAt ?? ""))) {
      players.set(userId, player);
    }
  }

  const farmed = [...farmedByBeatmap.entries()]
    .flatMap(([beatmapId, playerMap]): StoredCountryMapsData["farmed"] => {
      const players = [...playerMap.values()].sort((a, b) => b.pp - a.pp);
      const maxPp = players.reduce((max, player) => Math.max(max, player.pp), 0);
      if (players.length < 2 && maxPp < FARMED_SINGLE_PLAYER_PP_MIN) return [];
      const avgPp = players.reduce((sum, player) => sum + player.pp, 0) / players.length;
      return [{
        beatmapId,
        playerCount: players.length,
        avgPp,
        maxPp,
        players: players.slice(0, GLOBAL_MAPS_PLAYERS_PER_ENTRY),
      }];
    })
    .sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);

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
  const stored: StoredCountryMapsData = {
    schemaVersion: 2,
    farmed,
    mostPlayed,
    favourites,
    favouritesByPlayer,
    beatmapsetsPool,
    generatedAt,
    farmedGeneratedAt: generatedAt,
    favouritesGeneratedAt: generatedAt,
  };

  const refreshedAt = nowIso();
  await exec(
    db,
    `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
     values (?, ?, ?, ?)
     on conflict(country) do update set payload_json = excluded.payload_json, generated_at = excluded.generated_at, refreshed_at = excluded.refreshed_at`,
    [GLOBAL_COUNTRY_CODE, json(stored), generatedAt, refreshedAt],
  );

  return hydrateCompactMapsSnapshot(db, stored);
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

  for (const [userId, user] of users) {
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (?, ?, ?, null, ?)
       on conflict(user_id) do update set
         username = excluded.username,
         avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at`,
      [userId, user.username || `User ${userId}`, user.avatarUrl, updatedAt],
    );
  }

  for (const entry of value.farmed) {
    await upsertMapsBeatmapset(db, {
      beatmapsetId: entry.beatmapsetId,
      title: entry.title,
      artist: entry.artist,
      creator: entry.creator,
      status: entry.status,
      covers: entry.covers,
    }, updatedAt);
    await upsertMapsBeatmap(db, {
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
    }, updatedAt);
  }

  for (const entry of value.mostPlayed) {
    await upsertMapsBeatmapset(db, {
      beatmapsetId: entry.beatmapsetId,
      title: entry.title,
      artist: entry.artist,
      creator: entry.creator,
      status: entry.status,
      covers: entry.covers,
      globalPlayCount: entry.globalPlayCount,
    }, updatedAt);
    await upsertMapsBeatmap(db, {
      beatmapId: entry.beatmapId,
      beatmapsetId: entry.beatmapsetId,
      mode: "mania",
      status: entry.status,
      difficultyRating: entry.difficultyRating,
      totalLength: entry.totalLength,
      version: entry.version,
      url: `https://osu.ppy.sh/beatmaps/${entry.beatmapId}`,
    }, updatedAt);
  }

  for (const entry of value.favourites) {
    await upsertMapsBeatmapset(db, {
      beatmapsetId: entry.beatmapsetId,
      title: entry.title,
      artist: entry.artist,
      creator: entry.creator,
      status: entry.status,
      covers: entry.covers,
      globalPlayCount: entry.globalPlayCount,
      globalFavouriteCount: entry.globalFavouriteCount,
    }, updatedAt);
  }

  for (const beatmapset of Object.values(value.beatmapsetsPool)) {
    await upsertMapsBeatmapset(db, {
      beatmapsetId: beatmapset.id,
      title: beatmapset.title,
      artist: beatmapset.artist,
      creator: beatmapset.creator,
      status: beatmapset.status,
      covers: beatmapset.covers,
      globalPlayCount: beatmapset.globalPlayCount,
      globalFavouriteCount: beatmapset.globalFavouriteCount,
      previewUrl: beatmapset.previewUrl,
      bpm: beatmapset.bpm,
      maniaKeys: beatmapset.maniaKeys,
      patterns: beatmapset.patterns,
    }, updatedAt);
    for (const beatmap of beatmapset.maniaBeatmaps) {
      await upsertMapsBeatmap(db, {
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
      }, updatedAt);
    }
  }
}

async function upsertMapsBeatmapset(
  db: Db,
  value: Pick<MapsBeatmapsetMetadata, "beatmapsetId" | "title" | "artist" | "creator" | "status" | "covers"> & Partial<Pick<MapsBeatmapsetMetadata, "globalPlayCount" | "globalFavouriteCount" | "previewUrl" | "bpm" | "maniaKeys" | "patterns">>,
  updatedAt: string,
): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmapsets
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
    [
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
  );
}

async function upsertMapsBeatmap(
  db: Db,
  value: Omit<MapsBeatmapMetadata, "cs" | "bpm"> & Partial<Pick<MapsBeatmapMetadata, "cs" | "bpm">>,
  updatedAt: string,
): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmaps
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
    [
      value.beatmapId,
      value.beatmapsetId,
      value.mode,
      value.status || null,
      value.cs ?? null,
      value.difficultyRating,
      value.bpm ?? null,
      value.totalLength,
      value.version,
      value.url,
      updatedAt,
    ],
  );
}

async function readMapsBeatmapsByIds(db: Db, ids: number[]): Promise<Map<number, MapsBeatmapMetadata>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url
     from maps_beatmaps
     where beatmap_id in`,
    ids,
  );
  return new Map(rows.map((row) => {
    const beatmap = rowToMapsBeatmapMetadata(row);
    return [beatmap.beatmapId, beatmap];
  }));
}

async function readMapsBeatmapsByBeatmapsetIds(db: Db, ids: number[]): Promise<MapsBeatmapMetadata[]> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url
     from maps_beatmaps
     where beatmapset_id in`,
    ids,
  );
  return rows.map(rowToMapsBeatmapMetadata);
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

async function selectRowsByIntegerSet(db: Db, sqlPrefix: string, values: number[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < ids.length; index += 900) {
    const chunk = ids.slice(index, index + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...(await exec(db, `${sqlPrefix} (${placeholders})`, chunk)).rows);
  }
  return rows;
}

function rowToMapsBeatmapMetadata(row: Record<string, unknown>): MapsBeatmapMetadata {
  const beatmapId = Number(row.beatmap_id);
  return {
    beatmapId,
    beatmapsetId: Number(row.beatmapset_id),
    mode: String(row.mode ?? "mania"),
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
  payload: { country: string; userId: number },
): Promise<{ country: string; userId: number; scoreCount: number; updatedAt: string }> {
  const country = payload.country.toUpperCase();
  const bestScores = await osu.getUserBestScoresWindow(payload.userId, MAPS_FARMED_SCORE_WINDOW, "job:refresh_user_maps_farmed_scores");
  const updatedAt = nowIso();
  await updateUserMapsFarmedThreshold(db, payload.userId, bestScores, updatedAt);
  await persistMapsFarmedScoreDisplayMetadata(db, bestScores, updatedAt);
  const rows = buildMapsFarmedOverlayRows(country, bestScores, updatedAt);
  await replaceUserMapsFarmedOverlay(db, country, payload.userId, rows, updatedAt);
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
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(country, user_id, beatmap_id) do update set
       score_id = excluded.score_id,
       pp = excluded.pp,
       score_json = excluded.score_json,
       mods_json = excluded.mods_json,
       score_url = excluded.score_url,
       played_at = excluded.played_at,
       detected_at = excluded.detected_at,
       updated_at = excluded.updated_at
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
    ],
  );
  if (Number(result.rowsAffected ?? 0) === 0) return null;
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
     where r.country = ? and r.is_tracked = 1
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
  users: MapsUser[],
): Promise<CountryMapsFarmedSection> {
  const userResults = await mapWithConcurrency(users, MAPS_FETCH_CONCURRENCY, async (user) => {
    const bestScores = await osu.getUserBestScoresWindow(user.id, 200, "job:refresh_country_maps:farmed")
      .catch((error) => {
        throwIfMapsRefreshShouldAbort(error);
        return [] as OscScore[];
      });
    return { user, bestScores };
  });
  const generatedAt = nowIso();
  await Promise.all(userResults.map(({ user, bestScores }) => updateUserMapsFarmedThreshold(db, user.id, bestScores, generatedAt)));

  const farmedMap = new Map<number, MapsFarmedEntry>();
  for (const { user, bestScores } of userResults) {
    for (const score of bestScores) {
      if (!score.beatmap || score.beatmap.mode !== "mania") continue;
      if (!score.pp || score.pp <= 0) continue;
      if (score.beatmapset?.status !== "ranked") continue;

      const bid = score.beatmap.id;
      const existing = farmedMap.get(bid);
      const player = {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatar_url,
        mods: getModAcronyms(score.mods),
        pp: score.pp,
        scoreUrl: getScoreUrl(score),
        playedAt: getScoreTimestamp(score) || null,
      };
      if (existing) {
        if (!existing.players.some((p) => p.id === user.id)) {
          existing.playerCount++;
          existing.players.push(player);
          existing.maxPp = Math.max(existing.maxPp, score.pp);
        }
      } else {
        farmedMap.set(bid, {
          beatmapId: bid,
          version: score.beatmap.version,
          difficultyRating: score.beatmap.difficulty_rating,
          totalLength: getTotalLength(score.beatmap),
          cs: score.beatmap.cs,
          bpm: score.beatmap.bpm,
          beatmapsetId: score.beatmapset.id,
          title: score.beatmapset.title,
          artist: score.beatmapset.artist,
          creator: score.beatmapset.creator ?? "",
          covers: score.beatmapset.covers,
          status: score.beatmapset.status ?? "",
          playerCount: 1,
          players: [player],
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
    entry.avgPp = entry.players.reduce((sum, player) => sum + player.pp, 0) / entry.players.length;
    farmed.push(entry);
  }
  farmed.sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);
  return { farmed, generatedAt };
}

async function buildCountryFavourites(
  osu: Pick<OsuApiClient, "getUserMostPlayed" | "getUserFavourites">,
  users: MapsUser[],
): Promise<CountryMapsFavouritesSection> {
  const userResults = await mapWithConcurrency(users, MAPS_FETCH_CONCURRENCY, async (user) => {
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
    return { user, mostPlayed, favourites };
  });

  const mpMap = new Map<number, MapsAggregatedBeatmap>();
  for (const { user, mostPlayed } of userResults) {
    for (const mp of mostPlayed) {
      if (mp.beatmap?.mode !== "mania" || !mp.beatmapset) continue;
      const beatmapId = Number(mp.beatmap_id ?? mp.beatmap.id);
      const count = Number(mp.count ?? 0);
      const existing = mpMap.get(beatmapId);
      const player = { id: user.id, username: user.username, avatarUrl: user.avatar_url, count };
      if (existing) {
        existing.totalPlays += count;
        existing.playerCount++;
        existing.players.push(player);
      } else {
        mpMap.set(beatmapId, {
          beatmapId,
          version: String(mp.beatmap.version ?? ""),
          difficultyRating: Number(mp.beatmap.difficulty_rating ?? 0),
          totalLength: getTotalLength(mp.beatmap),
          beatmapsetId: Number(mp.beatmapset.id ?? 0),
          title: String(mp.beatmapset.title ?? ""),
          artist: String(mp.beatmapset.artist ?? ""),
          creator: String(mp.beatmapset.creator ?? ""),
          covers: mp.beatmapset.covers ?? {},
          status: String(mp.beatmapset.status ?? ""),
          globalPlayCount: Number(mp.beatmapset.play_count ?? 0),
          totalPlays: count,
          playerCount: 1,
          players: [player],
        });
      }
    }
  }

  for (const entry of mpMap.values()) entry.players.sort((a, b) => b.count - a.count);
  const mostPlayed = [...mpMap.values()]
    .filter((entry) => entry.playerCount >= 2)
    .sort((a, b) => b.playerCount - a.playerCount || b.totalPlays - a.totalPlays);

  const favMap = new Map<number, MapsAggregatedFavourite>();
  const beatmapsetsPool: Record<number, MapsFavouriteBeatmapset> = {};
  const favouritesByPlayer: MapsPlayerFavourites[] = [];
  for (const { user, favourites } of userResults) {
    const playerIds: number[] = [];
    for (const fav of favourites) {
      const maniaBeatmaps = (fav.beatmaps ?? []).filter((beatmap) => beatmap.mode === "mania" && Number.isFinite(Number(beatmap.id)));
      if (maniaBeatmaps.length === 0 || !fav.id) continue;
      playerIds.push(fav.id);

      if (!beatmapsetsPool[fav.id]) {
        const keys = new Set<number>();
        const stars: number[] = [];
        for (const beatmap of maniaBeatmaps) {
          const keyCount = Number(beatmap.cs ?? 0);
          const star = Number(beatmap.difficulty_rating ?? 0);
          if (Number.isFinite(keyCount)) keys.add(keyCount);
          if (Number.isFinite(star)) stars.push(star);
        }
        beatmapsetsPool[fav.id] = {
          id: fav.id,
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

      const existing = favMap.get(fav.id);
      const player = { id: user.id, username: user.username, avatarUrl: user.avatar_url };
      if (existing) {
        existing.playerCount++;
        existing.players.push(player);
      } else {
        favMap.set(fav.id, {
          beatmapsetId: fav.id,
          title: String(fav.title ?? ""),
          artist: String(fav.artist ?? ""),
          creator: String(fav.creator ?? ""),
          covers: fav.covers ?? {},
          status: String(fav.status ?? ""),
          globalPlayCount: Number(fav.play_count ?? 0),
          globalFavouriteCount: Number(fav.favourite_count ?? 0),
          playerCount: 1,
          players: [player],
        });
      }
    }
    if (playerIds.length > 0) {
      favouritesByPlayer.push({ id: user.id, username: user.username, avatarUrl: user.avatar_url, beatmapsetIds: playerIds });
    }
  }

  const favourites = [...favMap.values()]
    .filter((entry) => entry.playerCount >= 2)
    .sort((a, b) => b.playerCount - a.playerCount || b.globalFavouriteCount - a.globalFavouriteCount);

  return { mostPlayed, favourites, favouritesByPlayer, beatmapsetsPool, generatedAt: nowIso() };
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

function assertUsableMapsData(value: CountryMapsData, userCount: number): void {
  if (isUsableMapsData(value)) return;
  throw new Error(`Maps refresh produced no usable data for ${userCount} users`);
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
}

function buildMapsFarmedOverlayRows(country: string, scores: OscScore[], updatedAt: string): MapsFarmedOverlayWriteRow[] {
  const rows = new Map<string, MapsFarmedOverlayWriteRow>();
  for (const score of scores) {
    if (!isPotentialFarmedScore(score)) continue;
    const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) continue;
    const scoreId = getMapsFarmedDisplayScoreId(score);
    if (!Number.isFinite(scoreId) || scoreId < 0) continue;
    const pp = Number(score.pp);
    const detectedAt = getScoreTimestamp(score) || updatedAt;
    const playedAt = getScoreTimestamp(score) || null;
    const key = `${country}:${score.user_id}:${beatmapId}`;
    const candidate = {
      country,
      userId: score.user_id,
      beatmapId,
      scoreId,
      pp,
      scoreJson: "{}",
      modsJson: json(getModAcronyms(score.mods)),
      scoreUrl: getScoreUrl(score),
      playedAt,
      detectedAt,
      updatedAt,
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
  country: string,
  userId: number,
  rows: MapsFarmedOverlayWriteRow[],
  updatedAt: string,
): Promise<void> {
  const deleted = await exec(db, "delete from country_maps_farmed_scores where country = ? and user_id = ?", [country, userId]);
  for (const row of rows) {
    await exec(
      db,
      `insert into country_maps_farmed_scores
         (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(country, user_id, beatmap_id) do update set
         score_id = excluded.score_id,
         pp = excluded.pp,
         score_json = excluded.score_json,
         mods_json = excluded.mods_json,
         score_url = excluded.score_url,
         played_at = excluded.played_at,
         detected_at = excluded.detected_at,
         updated_at = excluded.updated_at`,
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
      ],
    );
  }
  if (rows.length > 0 || Number(deleted.rowsAffected ?? 0) > 0) {
    await touchMapsFarmedOverlay(db, country, updatedAt);
  }
}

async function persistMapsFarmedScoreDisplayMetadata(db: Db, scores: OscScore[], updatedAt: string): Promise<void> {
  for (const score of scores) {
    const statements: Array<{ sql: string; args: InValue[] }> = [];
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
    }

    for (const statement of statements) {
      await exec(db, statement.sql, statement.args);
    }
  }
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
       b.beatmapset_id,
       b.mode,
       b.status as beatmap_status,
       b.cs,
       b.difficulty_rating,
       b.bpm,
       b.max_combo,
       b.version,
       b.url,
       bs.title,
       bs.artist,
       bs.creator,
       bs.status as beatmapset_status,
       bs.covers_json
     from country_maps_farmed_scores s
     left join users u on u.user_id = s.user_id
     left join beatmaps b on b.beatmap_id = s.beatmap_id
     left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
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
  for (const row of rows) {
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
      totalLength: 0,
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

async function readLatestCountryMapsSourceRefreshedAt(db: Db): Promise<string | null> {
  const row = (await exec(
    db,
    "select max(refreshed_at) as refreshed_at from country_maps_snapshots where country != ?",
    [GLOBAL_COUNTRY_CODE],
  )).rows[0];
  return row?.refreshed_at == null ? null : String(row.refreshed_at);
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
  { canonical: "tiebreaker", variants: ["tiebreaker", "tb"] },
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
  if (!variant.includes(" ")) return tokens.includes(variant);
  for (let index = 0; index < tokens.length - 1; index++) {
    if (`${tokens[index]} ${tokens[index + 1]}` === variant) return true;
  }
  return false;
}
