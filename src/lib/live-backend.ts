import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import type {
  CountryMapsData,
  CountryTopPlay,
  LeanDanEstimate,
  LeanTrackerScore,
  MapsAggregatedBeatmap,
  MapsAggregatedFavourite,
  MapsFarmedEntry,
  MapsFavouriteBeatmapset,
  OsuScore,
  OsuUser,
  SnipeEvent,
} from "./types";

export type LiveEventName =
  | "hello"
  | "heartbeat"
  | "status"
  | "tracker_score"
  | "score_gain"
  | "top_play"
  | "maps_farmed_update"
  | "snipe"
  | "job_status";

export type LiveCountryFeatureTier = "indexed" | "maps_warm" | "live" | "snipes";

export interface LiveCountryFeature {
  country: string;
  featureTier: LiveCountryFeatureTier;
}

export interface LiveCountryFeaturesSnapshot {
  generatedAt: string;
  countries: LiveCountryFeature[];
}

export interface LiveTrackerSnapshot {
  country: string;
  scores: LeanTrackerScore[];
  gains: Record<number, number>;
  fetchedAt: number;
}

export interface LiveTopPlaysSnapshot {
  popoffs: CountryTopPlay[];
  scannedAt: number;
  window: "24h" | "3d" | "7d" | "30d";
  total?: number;
  page?: number;
  pageSize?: number;
  ppGains?: LiveTopPlaysPpGain[];
}

export type LiveTopPlaysSort = "recent" | "pp" | "gain";
export type LiveTopPlaysDirection = "asc" | "desc";
export type LiveTopPlaysKeyFilter = "all" | "4k" | "other";

export interface LiveTopPlaysPpGain {
  id: number;
  username: string;
  avatar_url: string;
  country_code?: string;
  totalGain: number;
}

export interface LiveSnipesSnapshot {
  events: SnipeEvent[];
  scannedAt: number;
}

export interface LiveMapsSnapshot {
  value: CountryMapsData | null;
  generatedAt: string | null;
  refreshedAt: string | null;
  isStale: boolean;
  refreshQueued: boolean;
}

export type LiveMapsBrowseTab = "farmed" | "popular" | "favourites";

export interface LiveMapsPageParams {
  tab: LiveMapsBrowseTab;
  page: number;
  pageSize: number;
  key: string;
  beatmapSort: string;
  farmedSort: string;
  dir: string;
  status: string;
  pp: number;
  mod: string;
  q: string;
}

export interface LiveMapsPageValue {
  tab: LiveMapsBrowseTab;
  page: number;
  pageSize: number;
  total: number;
  items: Array<MapsFarmedEntry | MapsAggregatedBeatmap | MapsAggregatedFavourite>;
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
}

export interface LiveMapsPageSnapshot {
  value: LiveMapsPageValue | null;
  generatedAt: string | null;
  refreshedAt: string | null;
  isStale: boolean;
  refreshQueued: boolean;
}

export type LiveMapsPlayersKind = "farmed" | "popular" | "favourite";

export interface LiveMapsDetailsPlayer {
  id: number;
  username: string;
  avatarUrl: string;
  // 1-based rank on the full board, independent of the active search filter.
  rank?: number;
  pp?: number;
  count?: number;
  mods?: string[];
  scoreUrl?: string | null;
  playedAt?: string | null;
}

export interface LiveMapsPlayersSnapshot {
  kind: LiveMapsPlayersKind;
  id: number;
  total: number;
  matched: number;
  page: number;
  pageSize: number;
  players: LiveMapsDetailsPlayer[];
}

export const LIVE_MAPS_PLAYERS_PAGE_SIZE = 50;

export interface LiveDanEstimateRequest {
  beatmapId: number;
  starRating?: number;
  rate?: number;
}

export interface LiveDanEstimateBatch {
  results: Record<string, LeanDanEstimate | null>;
  pending: string[];
  estimatorVersion: number;
}

export interface LiveRankDelta {
  userId: number;
  globalChange: number | null;
  countryChange: number | null;
  oldGlobalRank: number | null;
  oldCountryRank: number | null;
  capturedAt: string;
}

export interface LiveRankDeltaSnapshot {
  country: string;
  windowDays: number;
  targetAt: string;
  deltas: Record<number, LiveRankDelta>;
}

export interface LivePlayerProfileSnapshot {
  user: OsuUser;
  bestScores: OsuScore[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
  projection: {
    appliedTopPlayEvents: number;
    projectedPp: number | null;
    basePp: number | null;
    provenanceByScoreId: Record<number, "osu_snapshot" | "live_top_play_event">;
  };
}

export interface LivePlayerProfileSection<T> {
  userId: number;
  section: "about" | "recent";
  payload: T;
  fetchedAt: string;
  isStale: boolean;
}

export function getLiveBackendUrl(): string | null {
  const value = import.meta.env.VITE_LIVE_BACKEND_URL || import.meta.env.LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

export function isLiveBackendConfigured(): boolean {
  return getLiveBackendUrl() !== null;
}

function getServerLiveBackendUrl(): string | null {
  const value = process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

function normalizeAdminPath(input: unknown): string {
  if (typeof input !== "string") throw new Error("Invalid live backend admin path.");
  const url = new URL(input, "http://live-backend.local");
  const path = `${url.pathname}${url.search}`;
  const exact = new Set([
    "/api/admin/clear-failed-jobs",
    "/api/admin/pause-workers",
    "/api/admin/resume-workers",
    "/api/admin/run-retention",
    "/api/admin/osc-smoke",
    "/api/admin/run-osc-backfill",
  ]);
  if (exact.has(path)) return path;
  if (url.pathname === "/api/admin/refresh-roster") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/refresh-roster?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/catch-up-country") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/catch-up-country?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/pause-country" || url.pathname === "/api/admin/resume-country") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `${url.pathname}?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/set-country-status") {
    const country = url.searchParams.get("country");
    const status = url.searchParams.get("status");
    const validStatus = status === "active" || status === "warm" || status === "paused";
    if (country && /^[A-Za-z]{2}$/.test(country) && validStatus) {
      return `/api/admin/set-country-status?country=${country.toUpperCase()}&status=${status}`;
    }
  }
  if (url.pathname === "/api/admin/delete-country") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/delete-country?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/refresh-maps") {
    const country = url.searchParams.get("country");
    // Global is a valid maps scope (it merges every country's snapshot).
    if (country && /^([A-Za-z]{2}|GLOBAL)$/i.test(country)) return `/api/admin/refresh-maps?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/set-country-tier") {
    const country = url.searchParams.get("country");
    const tier = url.searchParams.get("tier");
    const validTier = tier === "indexed" || tier === "maps_warm" || tier === "live" || tier === "snipes";
    if (country && /^[A-Za-z]{2}$/.test(country) && validTier) {
      return `/api/admin/set-country-tier?country=${country.toUpperCase()}&tier=${tier}`;
    }
  }
  throw new Error("Unsupported live backend admin action.");
}

export const runLiveBackendAdminAction = createServerFn({ method: "POST" })
  .inputValidator((data: { path?: unknown }) => ({
    path: normalizeAdminPath(data?.path),
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; body: string | null }> => {
    await requireAdminAccess("Live backend admin action");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const response = await fetch(`${base}${data.path}`, {
      method: "POST",
      headers,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : null;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Live backend ${response.status} for ${data.path}`;
      throw new Error(message);
    }
    return { ok: true, body: text || null };
  });

export const fetchLiveBackendAdminStatus = createServerFn({ method: "GET" })
  .inputValidator((data: { country?: unknown } | undefined) => {
    const rawCountry = typeof data?.country === "string" ? data.country.trim().toUpperCase() : "";
    return { country: /^([A-Z]{2}|GLOBAL)$/.test(rawCountry) ? rawCountry : null };
  })
  .handler(async ({ data }): Promise<any> => {
    await requireAdminAccess("Live backend admin status");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const query = data.country ? `?country=${encodeURIComponent(data.country)}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/api/admin/status${query}`, { headers, signal: controller.signal });
      if (response.status === 404) {
        response = await fetch(`${base}/api/status`, { signal: controller.signal });
      }
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`Live backend admin status timed out after ${Math.round(LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS / 1000)}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json() as any;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Live backend ${response.status} for /api/admin/status`;
      throw new Error(message);
    }
    return body;
  });

export type LiveBackendStatus = "ok" | "offline";

export interface LiveBackendBootstrap {
  status: LiveBackendStatus;
  countryFeatures: LiveCountryFeaturesSnapshot | null;
}

const LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS = 30_000;
const LIVE_BACKEND_BOOTSTRAP_TIMEOUT_MS = 1_000;

export const fetchLiveBackendBootstrap = createServerFn({ method: "GET" })
  .handler(async (): Promise<LiveBackendBootstrap> => {
    const base = getServerLiveBackendUrl();
    if (!base) return { status: "offline", countryFeatures: null };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_BOOTSTRAP_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/api/countries/features`, { signal: controller.signal });
      const body = await response.json() as Partial<LiveCountryFeaturesSnapshot>;
      if (!response.ok || !Array.isArray(body.countries)) {
        return { status: "offline", countryFeatures: null };
      }
      return {
        status: "ok",
        countryFeatures: {
          generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
          countries: body.countries
            .filter((entry): entry is LiveCountryFeature =>
              !!entry &&
              typeof entry === "object" &&
              typeof entry.country === "string" &&
              isCountryFeatureTier((entry as Partial<LiveCountryFeature>).featureTier),
            )
            .map((entry) => ({ country: entry.country.toUpperCase().slice(0, 2), featureTier: entry.featureTier })),
        },
      };
    } catch (error) {
      if (isAbortError(error)) return { status: "ok", countryFeatures: null };
      return { status: "offline", countryFeatures: null };
    } finally {
      clearTimeout(timeout);
    }
  });

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

export const fetchLivePlayerProfileSnapshot = createServerFn({ method: "GET" })
  .inputValidator((data: { key?: unknown }) => {
    if (typeof data?.key !== "string" || !data.key.trim()) throw new Error("Invalid profile key.");
    return { key: data.key.trim().slice(0, 120) };
  })
  .handler(async ({ data }): Promise<LivePlayerProfileSnapshot | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    const response = await fetch(`${base}/api/profiles/${encodeURIComponent(data.key)}/snapshot`);
    if (!response.ok) throw new Error(`Live backend ${response.status} for profile snapshot`);
    return response.json() as Promise<LivePlayerProfileSnapshot>;
  });

export const fetchLivePlayerCachedProfileSnapshot = createServerFn({ method: "GET" })
  .inputValidator((data: { key?: unknown }) => {
    if (typeof data?.key !== "string" || !data.key.trim()) throw new Error("Invalid profile key.");
    return { key: data.key.trim().slice(0, 120) };
  })
  .handler(async ({ data }): Promise<LivePlayerProfileSnapshot | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    const response = await fetch(`${base}/api/profiles/${encodeURIComponent(data.key)}/cached-snapshot`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Live backend ${response.status} for cached profile snapshot`);
    return response.json() as Promise<LivePlayerProfileSnapshot>;
  });

export const fetchLivePlayerRecentScores = createServerFn({ method: "GET" })
  .inputValidator((data: { userId?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
    return { userId };
  })
  .handler(async ({ data }): Promise<LivePlayerProfileSection<OsuScore[]> | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    const response = await fetch(`${base}/api/profiles/${data.userId}/recent`);
    if (!response.ok) throw new Error(`Live backend ${response.status} for profile recent scores`);
    return response.json() as Promise<LivePlayerProfileSection<OsuScore[]>>;
  });

export const fetchLivePlayerAbout = createServerFn({ method: "GET" })
  .inputValidator((data: { userId?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
    return { userId };
  })
  .handler(async ({ data }): Promise<LivePlayerProfileSection<{ html: string | null }> | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    const response = await fetch(`${base}/api/profiles/${data.userId}/about`);
    if (!response.ok) throw new Error(`Live backend ${response.status} for profile about`);
    return response.json() as Promise<LivePlayerProfileSection<{ html: string | null }>>;
  });

export async function fetchLivePlayerRecentScoresDirect(userId: number): Promise<LivePlayerProfileSection<OsuScore[]>> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  return fetchLiveJson(`/api/profiles/${userId}/recent`);
}

export async function fetchLivePlayerAboutDirect(userId: number): Promise<LivePlayerProfileSection<{ html: string | null }>> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  return fetchLiveJson(`/api/profiles/${userId}/about`);
}

export async function fetchLiveTrackerSnapshot(country: string, limit = 100, options?: { observe?: boolean }): Promise<LiveTrackerSnapshot> {
  const query = new URLSearchParams({ country, limit: String(limit) });
  if (options?.observe) query.set("observe", "1");
  return fetchLiveJson(`/api/snapshots/tracker?${query.toString()}`);
}

export type LiveFarmHelperReason = "missing" | "improve" | "stale";
export type LiveFarmHelperKeyMode = "4k" | "7k" | "any";
export type LiveFarmHelperSpeedBucket = "ht" | "normal" | "dt";

export interface LiveFarmHelperPeer {
  userId: number;
  username: string;
  avatarUrl: string;
  pp: number;
}

export interface LiveFarmHelperRec {
  beatmapId: number;
  speedBucket: LiveFarmHelperSpeedBucket;
  recommendedMods?: string[];
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  version: string;
  cover: string;
  status: string;
  stars: number;
  keys: number;
  bpm: number;
  lengthSec: number;
  reason: LiveFarmHelperReason;
  estimatedPpGain: number;
  benchmarkPp: number;
  subjectPp: number | null;
  subjectPlayedAt: string | null;
  peerCount: number;
  peerSampleSize: number;
  peerFraction: number;
  peerPpMedian: number;
  peerPpP75: number;
  topPeers: LiveFarmHelperPeer[];
  scoreUrl: string | null;
  mapUrl: string;
  rankScore: number;
}

export interface LiveFarmHelperSnapshot {
  status: "ready";
  userId: number;
  username: string;
  avatarUrl: string;
  coverUrl: string;
  pp: number;
  keyMode: LiveFarmHelperKeyMode;
  peerBand: { mode: string; count: number; farmDataCount: number; minPp: number; maxPp: number };
  totalPotentialPp: number;
  recs: LiveFarmHelperRec[];
  generatedAt: string;
}

export async function fetchLiveFarmHelperSnapshot(
  userKey: string,
  params?: { keyMode?: LiveFarmHelperKeyMode; limit?: number; signal?: AbortSignal },
): Promise<LiveFarmHelperSnapshot> {
  const query = new URLSearchParams({ user: userKey });
  if (params?.keyMode) query.set("key", params.keyMode);
  if (params?.limit != null) query.set("limit", String(params.limit));
  return fetchLiveJson(`/api/snapshots/farm-helper?${query.toString()}`, params?.signal ? { signal: params.signal } : undefined);
}

export interface LiveFarmHelperFarmer {
  userId: number;
  username: string;
  avatarUrl: string;
  pp: number;
  mods?: string[];
}

export interface LiveFarmHelperFarmers {
  beatmapId: number;
  total: number;
  farmers: LiveFarmHelperFarmer[];
}

export async function fetchLiveFarmHelperFarmers(
  userKey: string,
  beatmapId: number,
  speedBucket?: LiveFarmHelperSpeedBucket,
  options?: { signal?: AbortSignal },
): Promise<LiveFarmHelperFarmers> {
  const query = new URLSearchParams({ user: userKey, beatmap: String(beatmapId) });
  if (speedBucket) query.set("speed", speedBucket);
  return fetchLiveJson(`/api/snapshots/farm-helper-farmers?${query.toString()}`, options?.signal ? { signal: options.signal } : undefined);
}

export interface LiveCountryActivation {
  ok: boolean;
  // True while the country has no roster projection yet, so every country
  // surface (rankings/maps/tracker/...) is empty until backend warmup runs.
  warming: boolean;
  // Feature tier caps what the backend does for this country. Snipes is the
  // gated tier (enables the expensive snipe board seeding).
  featureTier: LiveCountryFeatureTier;
}

function readCountryFeatureTier(value: unknown): LiveCountryFeatureTier {
  return isCountryFeatureTier(value)
    ? value
    : "indexed";
}

function isCountryFeatureTier(value: unknown): value is LiveCountryFeatureTier {
  return value === "snipes" || value === "live" || value === "maps_warm" || value === "indexed";
}

export async function activateLiveCountry(country: string): Promise<LiveCountryActivation | null> {
  const base = getLiveBackendUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/api/countries/activate?country=${encodeURIComponent(country)}`, {
      method: "POST",
      credentials: "omit",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<LiveCountryActivation>;
    return {
      ok: body.ok === true,
      warming: body.warming === true,
      featureTier: readCountryFeatureTier(body.featureTier),
    };
  } catch {
    return null;
  }
}

export async function fetchLiveTopPlaysSnapshot(
  country: string,
  window: LiveTopPlaysSnapshot["window"],
  options?: {
    observe?: boolean;
    sort?: LiveTopPlaysSort;
    dir?: LiveTopPlaysDirection;
    keys?: LiveTopPlaysKeyFilter;
    page?: number;
    pageSize?: number;
    includePpGains?: boolean;
    userIds?: number[];
  },
): Promise<LiveTopPlaysSnapshot> {
  const query = new URLSearchParams({ country, window });
  if (options?.observe) query.set("observe", "1");
  if (options?.sort) query.set("sort", options.sort);
  if (options?.dir) query.set("dir", options.dir);
  if (options?.keys) query.set("keys", options.keys);
  if (options?.page != null) query.set("page", String(options.page));
  if (options?.pageSize != null) query.set("pageSize", String(options.pageSize));
  if (options?.includePpGains) query.set("includePpGains", "1");
  if (options?.userIds && options.userIds.length > 0) query.set("userIds", options.userIds.join(","));
  return fetchLiveJson(`/api/snapshots/top-plays?${query.toString()}`);
}

export async function fetchLiveSnipesSnapshot(country: string, limit = 500, options?: { observe?: boolean }): Promise<LiveSnipesSnapshot> {
  const query = new URLSearchParams({ country, limit: String(limit) });
  if (options?.observe) query.set("observe", "1");
  return fetchLiveJson(`/api/snapshots/snipes?${query.toString()}`);
}

export async function fetchLiveMapsSnapshot(
  country: string,
  section: "core" | "random" = "core",
): Promise<LiveMapsSnapshot> {
  const query = new URLSearchParams({ country });
  if (section === "random") query.set("section", "random");
  return fetchLiveJson(`/api/snapshots/maps?${query.toString()}`);
}

export async function fetchLiveMapsPageSnapshot(
  country: string,
  params: LiveMapsPageParams,
): Promise<LiveMapsPageSnapshot> {
  const query = new URLSearchParams({
    country,
    tab: params.tab,
    page: String(params.page),
    pageSize: String(params.pageSize),
    key: params.key,
    beatmapSort: params.beatmapSort,
    farmedSort: params.farmedSort,
    dir: params.dir,
    status: params.status,
    pp: String(params.pp),
    mod: params.mod,
  });
  if (params.q.trim()) query.set("q", params.q.trim());
  return fetchLiveJson(`/api/snapshots/maps-page?${query.toString()}`);
}

export async function fetchLiveMapsPlayersSnapshot(
  country: string,
  kind: LiveMapsPlayersKind,
  id: number,
  options: { page?: number; pageSize?: number; q?: string } = {},
): Promise<LiveMapsPlayersSnapshot> {
  const query = new URLSearchParams({ country, kind, id: String(id) });
  query.set("page", String(Math.max(0, options.page ?? 0)));
  query.set("pageSize", String(options.pageSize ?? LIVE_MAPS_PLAYERS_PAGE_SIZE));
  const q = options.q?.trim();
  if (q) query.set("q", q);
  return fetchLiveJson(`/api/snapshots/maps-players?${query.toString()}`);
}

// Full per-set metadata (covers, per-difficulty list, preview audio) for the
// Random tab, fetched on demand since the pool snapshot now ships lean entries.
export async function fetchLiveMapsBeatmapsets(
  country: string,
  ids: number[],
): Promise<MapsFavouriteBeatmapset[]> {
  const cleanIds = [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0);
  if (cleanIds.length === 0) return [];
  const query = new URLSearchParams({ country, ids: cleanIds.join(",") });
  const result = await fetchLiveJson<{ beatmapsets: MapsFavouriteBeatmapset[] }>(
    `/api/snapshots/maps-set?${query.toString()}`,
  );
  return result.beatmapsets ?? [];
}

export interface LiveGlobalRankingEntry {
  rank: number;
  user: { id: number; username: string; avatar_url: string; cover_url: string; country_code: string };
  pp: number;
  global_rank: number | null;
  country_rank: number | null;
  hit_accuracy: number;
  play_count: number;
  ranked_score: number;
  grade_counts: {
    ss: number;
    ssh: number;
    s: number;
    sh: number;
    a: number;
  };
  global_change: number | null;
  country_change: number | null;
}

export interface LiveGlobalRankingsSnapshot {
  ranking: LiveGlobalRankingEntry[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: number;
}

export interface LiveGlobalRankingsParams {
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: "asc" | "desc";
}

// The combined leaderboard across every tracked country's roster, ranked by pp.
export async function fetchLiveGlobalRankings(options: number | LiveGlobalRankingsParams = 100): Promise<LiveGlobalRankingsSnapshot> {
  const params = typeof options === "number" ? { page: 1, pageSize: options } : options;
  const query = new URLSearchParams({
    page: String(Math.max(1, Math.floor(params.page ?? 1))),
    pageSize: String(Math.max(1, Math.min(50, Math.floor(params.pageSize ?? 50)))),
    sort: params.sort ?? "rank",
    dir: params.dir === "asc" ? "asc" : "desc",
  });
  const snapshot = await fetchLiveJson<Record<string, unknown>>(
    `/api/snapshots/global-rankings?${query.toString()}`,
  );
  const ranking = Array.isArray(snapshot.ranking)
    ? snapshot.ranking.map(normalizeLiveGlobalRankingEntry)
    : [];
  return {
    ranking,
    total: readFiniteNumber(snapshot.total) ?? ranking.length,
    page: readPositiveInteger(snapshot.page) ?? params.page ?? 1,
    pageSize: readPositiveInteger(snapshot.pageSize) ?? params.pageSize ?? ranking.length,
    fetchedAt: readFiniteNumber(snapshot.fetchedAt) ?? Date.now(),
  };
}

function normalizeLiveGlobalRankingEntry(value: unknown, index: number): LiveGlobalRankingEntry {
  const entry = readRecord(value) ?? {};
  const user = readRecord(entry.user) ?? {};
  const grades = readRecord(entry.grade_counts) ?? {};
  return {
    rank: readPositiveInteger(entry.rank) ?? index + 1,
    user: {
      id: readPositiveInteger(user.id) ?? 0,
      username: readString(user.username),
      avatar_url: readString(user.avatar_url),
      cover_url: readString(user.cover_url),
      country_code: readString(user.country_code),
    },
    pp: readFiniteNumber(entry.pp) ?? 0,
    global_rank: readPositiveInteger(entry.global_rank),
    country_rank: readPositiveInteger(entry.country_rank),
    hit_accuracy: readFiniteNumber(entry.hit_accuracy) ?? 0,
    play_count: readNonNegativeInteger(entry.play_count) ?? 0,
    ranked_score: readNonNegativeInteger(entry.ranked_score) ?? 0,
    grade_counts: {
      ss: readNonNegativeInteger(grades.ss) ?? 0,
      ssh: readNonNegativeInteger(grades.ssh) ?? 0,
      s: readNonNegativeInteger(grades.s) ?? 0,
      sh: readNonNegativeInteger(grades.sh) ?? 0,
      a: readNonNegativeInteger(grades.a) ?? 0,
    },
    global_change: readFiniteNumber(entry.global_change),
    country_change: readFiniteNumber(entry.country_change),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const numberValue = readFiniteNumber(value);
  return numberValue != null && Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

function readPositiveInteger(value: unknown): number | null {
  const numberValue = readFiniteNumber(value);
  return numberValue != null && Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

export async function fetchLiveRankDeltas(country: string, userIds: number[]): Promise<LiveRankDeltaSnapshot> {
  const uniqueUserIds = [...new Set(userIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 100);
  return fetchLiveJson(`/api/snapshots/rank-deltas?country=${encodeURIComponent(country)}&userIds=${uniqueUserIds.join(",")}`);
}

export async function fetchLiveDanEstimates(items: LiveDanEstimateRequest[], estimatorVersion: number): Promise<LiveDanEstimateBatch> {
  return fetchLiveJson("/api/dan-estimates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, estimatorVersion, computeMissing: true }),
  });
}

export function openLiveEventSource(country: string, options?: { observe?: boolean }): EventSource | null {
  const base = getLiveBackendUrl();
  if (!base || typeof EventSource === "undefined") return null;
  const query = new URLSearchParams({ country });
  if (options?.observe) query.set("observe", "1");
  return new EventSource(`${base}/api/live?${query.toString()}`);
}

async function fetchLiveJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Live backend is not configured.");
  const response = await fetch(`${base}${path}`, { credentials: "omit", ...init });
  if (!response.ok) throw new Error(`Live backend ${response.status}`);
  return response.json() as Promise<T>;
}
