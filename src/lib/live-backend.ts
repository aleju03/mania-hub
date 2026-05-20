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
  if (url.pathname === "/api/admin/pause-country" || url.pathname === "/api/admin/resume-country") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `${url.pathname}?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/delete-country") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/delete-country?country=${country.toUpperCase()}`;
  }
  if (url.pathname === "/api/admin/refresh-maps") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/refresh-maps?country=${country.toUpperCase()}`;
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
  .handler(async (): Promise<any> => {
    await requireAdminAccess("Live backend admin status");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    let response = await fetch(`${base}/api/admin/status`, { headers });
    if (response.status === 404) {
      response = await fetch(`${base}/api/status`);
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

export async function fetchLiveTrackerSnapshot(country: string, limit = 100): Promise<LiveTrackerSnapshot> {
  return fetchLiveJson(`/api/snapshots/tracker?country=${encodeURIComponent(country)}&limit=${limit}`);
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

export async function fetchLiveTopPlaysSnapshot(country: string, window: LiveTopPlaysSnapshot["window"]): Promise<LiveTopPlaysSnapshot> {
  return fetchLiveJson(`/api/snapshots/top-plays?country=${encodeURIComponent(country)}&window=${window}`);
}

export async function fetchLiveSnipesSnapshot(country: string, limit = 500): Promise<LiveSnipesSnapshot> {
  return fetchLiveJson(`/api/snapshots/snipes?country=${encodeURIComponent(country)}&limit=${limit}`);
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
    status: params.status,
    pp: String(params.pp),
    mod: params.mod,
  });
  if (params.q.trim()) query.set("q", params.q.trim());
  return fetchLiveJson(`/api/snapshots/maps-page?${query.toString()}`);
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

export function openLiveEventSource(country: string): EventSource | null {
  const base = getLiveBackendUrl();
  if (!base || typeof EventSource === "undefined") return null;
  return new EventSource(`${base}/api/live?country=${encodeURIComponent(country)}`);
}

async function fetchLiveJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Live backend is not configured.");
  const response = await fetch(`${base}${path}`, { credentials: "omit", ...init });
  if (!response.ok) throw new Error(`Live backend ${response.status}`);
  return response.json() as Promise<T>;
}
