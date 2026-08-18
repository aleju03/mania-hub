import { createServerFn } from "@tanstack/react-start";
import type { CardMotif } from "./card-motif";
import { requireAdminAccess, requireTrueAdminAccess } from "./auth";
import { harvestAvatarAccents } from "./avatar-accent-harvest";
import { buildRandomDrawQuery } from "./maps-random-draw-params";
import type { LiveMapsRandomDrawParams } from "./maps-random-draw-params";
import type { MyDataSkillBreakdown } from "./my-data";
import type { ReplaySpectatorTicket } from "./replay-spectator";
import { CrossTabEventSource, supportsCrossTabEventSource } from "./cross-tab-event-source";
import { SharedEventSourcePool, type PoolableEventSource, type SharedEventSource } from "./shared-event-source";

export type LivePlayerSkills = MyDataSkillBreakdown;

export interface LivePlayerSkillPlay {
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  creator: string | null;
  version: string;
  coverUrl: string | null;
  keyCount: number;
  rating: number;
  overallRating: number;
  pp: number | null;
  accuracy: number | null;
  rate: number;
  playedAt: string | null;
  source: "top" | "tracked";
  scoreId: number | null;
}

export interface LivePlayerSkillPlaysPage {
  items: LivePlayerSkillPlay[];
  total: number;
  limit: number;
  offset: number;
}

import type {
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

/** Every event name `/api/live` emits. A runtime value (not just a type)
 *  because the cross-tab relay must addEventListener per name to forward the
 *  stream to follower tabs — a name missing here would reach the leader tab
 *  but silently never reach the others. */
export const LIVE_EVENT_NAMES = [
  "hello",
  "heartbeat",
  "status",
  "tracker_score",
  "score_gain",
  "top_play",
  "maps_farmed_update",
  "snipe",
  "goal_completed",
  "pack_pull",
  "goat_poll",
  "job_status",
] as const;

export type LiveEventName = (typeof LIVE_EVENT_NAMES)[number];

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
  total?: number;
  offset?: number;
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

export interface LiveSnipeBoardEntry {
  position: number;
  user: { id: number; username: string; avatar_url: string; avatar_accent?: string | null };
  scoreId: number;
  totalScore: number;
  pp: number | null;
  accuracy: number;
  grade: string;
  mods: string[];
  isLazer: boolean;
  hasReplay: boolean;
  endedAt: string;
}

export interface LiveSnipeBoardSnapshot {
  beatmapId: number;
  laneKey: string;
  total: number;
  entries: LiveSnipeBoardEntry[];
}

export type LiveMapsRefreshProgressStatus = "queued" | "running" | "done" | "failed";
export type LiveMapsRefreshProgressStage = "queued" | "fetching" | "persisting" | "done" | "failed";

export interface LiveMapsRefreshProgress {
  country: string;
  status: LiveMapsRefreshProgressStatus;
  stage: LiveMapsRefreshProgressStage;
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
  progress: LiveMapsRefreshProgress | null;
}

export interface LiveMapsProgressSnapshot {
  progress: LiveMapsRefreshProgress | null;
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

// A drawn pick is fully hydrated (~1 KiB), so the Random tab prefetches a batch
// of them and serves rerolls from that buffer instead of round-tripping.
export const RANDOM_DRAW_BATCH_SIZE = 8;

// The request half lives with the URL-param translation it grew out of.
export type { LiveMapsRandomDrawParams };

export interface LiveMapsRandomPick {
  player: {
    id: number;
    username: string;
    avatarUrl: string;
    // The player's unfiltered in-scope favourite total ("N favourites").
    favouriteCount: number;
  };
  beatmapset: MapsFavouriteBeatmapset;
  // Distinct in-scope players who favourited this set, ignoring the draw filters.
  scopeFavCount: number;
}

export interface LiveMapsRandomDrawValue {
  country: string;
  weight: "favourites" | "players";
  // Eligible (player, set) pairs after filters -> "N possible picks".
  totalPicks: number;
  uniqueSets: number;
  picks: LiveMapsRandomPick[];
  generatedAt: string | null;
  favouritesGeneratedAt: string | null;
}

export interface LiveMapsRandomDrawSnapshot {
  value: LiveMapsRandomDrawValue | null;
  generatedAt: string | null;
  refreshedAt: string | null;
  isStale: boolean;
  refreshQueued: boolean;
  progress: LiveMapsRefreshProgress | null;
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
    appliedRecentScores: number;
    projectedPp: number | null;
    basePp: number | null;
    provenanceByScoreId: Record<number, "osu_snapshot" | "live_top_play_event" | "tracked_recent_score">;
  };
}

export interface LivePlayerProfileSection<T> {
  userId: number;
  section: "about" | "recent";
  payload: T;
  fetchedAt: string;
  isStale: boolean;
}

export interface LivePlayerReplayScoresPage {
  items: OsuScore[];
  total: number;
  limit: number;
  offset: number;
}

export type LivePlayerRecentSource = "tracked" | "osu";

export interface LivePlayerAboutPayload {
  html: string | null;
  /** Raw BBCode source of the page; absent on payloads cached before it was added. */
  raw?: string | null;
}

/** Pattern id -> 0..1 intensity. Ids come from the backend's dan estimator
 * families (stream, jumpstream, handstream, jack, chordjack, stamina, tech)
 * plus ln and its 7K subtypes; the record stays open so new backend families
 * render without frontend changes. */
export type LivePlayerActivityPatterns = Record<string, number>;

export interface LivePlayerActivitySkillReadout {
  patterns: LivePlayerActivityPatterns;
  analyzedPlays: number;
  totalPlays: number;
  keyModes: LivePlayerActivityKeyModeSkillReadout[];
}

export type LivePlayerActivityPrimarySkill = string;

export interface LivePlayerActivitySkillVector {
  primary: LivePlayerActivityPrimarySkill;
  patterns: LivePlayerActivityPatterns;
}

export interface LivePlayerActivityKeyModeSkillReadout {
  keyCount: number | null;
  patterns: LivePlayerActivityPatterns;
  analyzedPlays: number;
  totalPlays: number;
}

export interface LivePlayerActivityMap {
  key: string;
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  version: string;
  coverUrl: string | null;
  plays: number;
  accuracy: number | null;
  pp: number | null;
  rank: string | null;
  keyCount: number | null;
  skills: LivePlayerActivitySkillVector | null;
}

export interface LivePlayerActivityTimelineSegment {
  key: string;
  sessionIndex: number;
  startAt: string;
  endAt: string;
  playCount: number;
  keyCount: number | null;
  primarySkill: LivePlayerActivityPrimarySkill;
  patterns: LivePlayerActivityPatterns;
}

export interface LivePlayerActivityDay {
  date: string;
  scoreCount: number;
  passedCount: number;
  sessionCount: number;
  mapCount: number;
  maps: LivePlayerActivityMap[];
  skills: LivePlayerActivitySkillReadout | null;
  timeline: LivePlayerActivityTimelineSegment[];
}

export interface LivePlayerActivitySnapshot {
  available: boolean;
  isTracked: boolean;
  userId: number;
  country: string | null;
  /** IANA timezone the backend used to bucket days (the player country's local time). */
  timezone?: string;
  year: number;
  availableYears: number[];
  totalScores: number;
  activeDays: number;
  totalSessions: number;
  typicalSession: number;
  currentStreak: number;
  generatedAt: string;
  days: LivePlayerActivityDay[];
}

export function getLiveBackendUrl(): string | null {
  const value = import.meta.env.VITE_LIVE_BACKEND_URL || import.meta.env.LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

export function isLiveBackendConfigured(): boolean {
  return getLiveBackendUrl() !== null;
}

export function getServerLiveBackendUrl(): string | null {
  const value = process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

function normalizeAdminPath(input: unknown): string {
  if (typeof input !== "string") throw new Error("Invalid server admin path.");
  const url = new URL(input, "http://live-backend.local");
  const path = `${url.pathname}${url.search}`;
  const exact = new Set([
    "/api/admin/clear-failed-jobs",
    "/api/admin/pause-workers",
    "/api/admin/resume-workers",
    "/api/admin/run-retention",
    "/api/admin/osc-smoke",
    "/api/admin/run-osc-backfill",
    "/api/admin/osu-file-backfill/start",
    "/api/admin/osu-file-backfill/cancel",
    "/api/admin/discord/register-commands",
    "/api/admin/discord/register-emojis",
    "/api/admin/rebuild-collections",
  ]);
  if (exact.has(path)) return path;
  if (url.pathname === "/api/admin/discord/remove-subscription") {
    const id = url.searchParams.get("id");
    if (id && /^\d+$/.test(id)) return `/api/admin/discord/remove-subscription?id=${id}`;
  }
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
  if (url.pathname === "/api/admin/add-country") {
    const country = url.searchParams.get("country");
    if (country && /^[A-Za-z]{2}$/.test(country)) return `/api/admin/add-country?country=${country.toUpperCase()}`;
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
  throw new Error("Unsupported server admin action.");
}

export const runLiveBackendAdminAction = createServerFn({ method: "POST" })
  .validator((data: { path?: unknown }) => ({
    path: normalizeAdminPath(data?.path),
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; body: string | null }> => {
    await requireAdminAccess("Server admin action");
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
        : `Server ${response.status} for ${data.path}`;
      throw new Error(message);
    }
    return { ok: true, body: text || null };
  });

export const fetchLiveBackendAdminStatus = createServerFn({ method: "GET" })
  .validator((data: { country?: unknown } | undefined) => {
    const rawCountry = typeof data?.country === "string" ? data.country.trim().toUpperCase() : "";
    return { country: /^([A-Z]{2}|GLOBAL)$/.test(rawCountry) ? rawCountry : null };
  })
  .handler(async ({ data }): Promise<any> => {
    await requireAdminAccess("Server admin status");
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
        // Rolling-deploy fallback for a backend old enough to predate
        // /api/admin/status. Carries the same bearer: /api/status is admin-only
        // now, and on an older backend the header is simply ignored.
        response = await fetch(`${base}/api/status`, { headers, signal: controller.signal });
      }
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`Server admin status timed out after ${Math.round(LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS / 1000)}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json() as any;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Server ${response.status} for /api/admin/status`;
      throw new Error(message);
    }
    return body;
  });

export interface LiveBackendStorageBreakdown {
  tables: Array<{ name: string; bytes: number }>;
  tableBytes: number;
  fileBytes: number | null;
  walBytes: number | null;
  maxBytes: number;
  capturedAt: string;
}

export interface LiveBackendStorageBreakdownResponse {
  storage: LiveBackendStorageBreakdown | null;
  scanning?: boolean;
  stale?: boolean;
}

// Per-table DB storage for the admin storage modal. Admin-gated; the token is
// injected server-side (never in the browser), mirroring fetchLiveBackendAdminStatus.
export const fetchLiveBackendStorageBreakdown = createServerFn({ method: "GET" })
  .handler(async (): Promise<LiveBackendStorageBreakdownResponse> => {
    await requireAdminAccess("Server storage breakdown");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/api/admin/storage-breakdown`, { headers, signal: controller.signal });
    } catch (err) {
      if (isAbortError(err)) throw new Error("Storage breakdown timed out.");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json() as LiveBackendStorageBreakdownResponse & { error?: unknown };
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Server ${response.status} for /api/admin/storage-breakdown`;
      throw new Error(message);
    }
    return { storage: body.storage ?? null, scanning: !!body.scanning, stale: !!body.stale };
  });

export type LiveBackendSweepStatus = "done" | "running" | "pending" | "unknown";

export interface LiveBackendSweep {
  id: string;
  label: string;
  description: string;
  kind: "one-time" | "recurring";
  status: LiveBackendSweepStatus;
  progress?: Record<string, number>;
  updatedAt?: string | null;
  detail?: string | null;
}

export interface LiveBackendSweepsResponse {
  sweeps: LiveBackendSweep[];
}

// Status of the backend's long-running background sweeps (done-key/self-chaining
// jobs coordinated through live_meta) for the admin Sweeps section. Admin-gated;
// the token is injected server-side (never in the browser), mirroring
// fetchLiveBackendStorageBreakdown. Returns null when the backend predates the
// endpoint (404).
export const fetchLiveBackendSweeps = createServerFn({ method: "GET" })
  .handler(async (): Promise<LiveBackendSweepsResponse | null> => {
    await requireAdminAccess("Server sweeps status");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/api/admin/sweeps`, { headers, signal: controller.signal });
    } catch (err) {
      if (isAbortError(err)) throw new Error("Sweeps status timed out.");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404) return null;
    const body = await response.json() as LiveBackendSweepsResponse & { error?: unknown };
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Server ${response.status} for /api/admin/sweeps`;
      throw new Error(message);
    }
    return { sweeps: Array.isArray(body.sweeps) ? body.sweeps : [] };
  });

export interface LiveBackendHonoraryCardOwner {
  userId: number;
  username: string;
  copies: number;
  firstPulledAt: number;
  lastPulledAt: number;
}

export interface LiveBackendHonoraryCardPulls {
  cardUserId: number;
  cardUsername: string | null;
  owners: LiveBackendHonoraryCardOwner[];
  ownerCount: number;
  copies: number;
  firstPulledAt: number | null;
  lastPulledAt: number | null;
}

export interface LiveBackendHonoraryCollector {
  userId: number;
  username: string;
  cards: number;
  copies: number;
  lastPulledAt: number;
}

export interface LiveBackendHonoraryLatestPull {
  ownerUserId: number;
  ownerUsername: string;
  cardUserId: number;
  cardUsername: string | null;
  pulledAt: number;
}

export interface LiveBackendHonoraryPulls {
  rosterSize: number;
  pulledCards: number;
  distinctOwners: number;
  totalCopies: number;
  cards: LiveBackendHonoraryCardPulls[];
  /* Absent from a backend that predates the leaderboard. */
  collectors?: LiveBackendHonoraryCollector[];
  collectorsListed?: number;
  latest?: LiveBackendHonoraryLatestPull | null;
  ownersPerCard: number;
  capturedAt: number;
}

// Who holds which GOAT card, for the admin roster section. Admin-gated; the
// token is injected server-side (never in the browser), mirroring
// fetchLiveBackendSweeps. Returns null when the backend predates the endpoint.
export const fetchLiveBackendHonoraryPulls = createServerFn({ method: "GET" })
  .handler(async (): Promise<LiveBackendHonoraryPulls | null> => {
    await requireAdminAccess("Server honorary pulls");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/api/admin/honorary-pulls`, { headers, signal: controller.signal });
    } catch (err) {
      if (isAbortError(err)) throw new Error("Honorary pulls timed out.");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404) return null;
    const body = await response.json() as LiveBackendHonoraryPulls & { error?: unknown };
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Server ${response.status} for /api/admin/honorary-pulls`;
      throw new Error(message);
    }
    return { ...body, cards: Array.isArray(body.cards) ? body.cards : [] };
  });

export type LiveBackendTableCell = string | number | boolean | null;

export interface LiveBackendTablePreview {
  table: string;
  columns: Array<{ name: string; type: string }>;
  totalRows: number;
  limit: number;
  offset: number;
  rows: Array<Record<string, LiveBackendTableCell>>;
}

// One page of rows from a single backend table, for the storage modal's table
// browser. Admin-gated; the token is injected server-side (never in the
// browser), mirroring fetchLiveBackendStorageBreakdown.
export const fetchLiveBackendTableRows = createServerFn({ method: "GET" })
  .validator((data: { table?: unknown; limit?: unknown; offset?: unknown; search?: unknown }) => {
    const table = typeof data?.table === "string" ? data.table.trim() : "";
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error("Invalid table name.");
    const limit = Math.min(Math.max(Math.trunc(Number(data?.limit)) || 25, 1), 100);
    const offset = Math.max(Math.trunc(Number(data?.offset)) || 0, 0);
    const search = typeof data?.search === "string" ? data.search.trim().slice(0, 100) : "";
    return { table, limit, offset, search };
  })
  .handler(async ({ data }): Promise<LiveBackendTablePreview | null> => {
    await requireAdminAccess("Server table rows");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const params = new URLSearchParams({
      table: data.table,
      limit: String(data.limit),
      offset: String(data.offset),
    });
    if (data.search) params.set("search", data.search);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/api/admin/table-rows?${params.toString()}`, { headers, signal: controller.signal });
    } catch (err) {
      if (isAbortError(err)) throw new Error("Table read timed out.");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404) return null;
    const body = await response.json() as LiveBackendTablePreview & { error?: unknown };
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Server ${response.status} for /api/admin/table-rows`;
      throw new Error(message);
    }
    return body;
  });

export interface LiveBackendUserActiveResult {
  ok: boolean;
  userId: number;
  username: string | null;
  active: boolean;
  untrackedRosters?: number;
  deletedJobs?: number;
  retrackedRosters?: number;
}

// Admin soft-deactivate / reactivate for a single player (the reversible
// "delete this cheater" button). Admin-gated; the token is injected server-side.
// Accepts a user id or a username; the backend resolves and 404s if unknown.
export const setLiveBackendUserActive = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; username?: unknown; active?: unknown }) => {
    const userId = Number(data?.userId);
    const username = typeof data?.username === "string" ? data.username.trim().slice(0, 60) : "";
    if ((!Number.isInteger(userId) || userId <= 0) && !username) {
      throw new Error("Provide a user id or username.");
    }
    return {
      userId: Number.isInteger(userId) && userId > 0 ? userId : null,
      username: username || null,
      active: data?.active === true,
    };
  })
  .handler(async ({ data }): Promise<LiveBackendUserActiveResult> => {
    await requireAdminAccess("Server set user active");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = { "content-type": "application/json" };
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const response = await fetch(`${base}/api/admin/set-user-active`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: data.userId, username: data.username, active: data.active }),
    });
    const body = await response.json() as LiveBackendUserActiveResult & { error?: unknown };
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Server ${response.status} for /api/admin/set-user-active`;
      throw new Error(message === "user_not_found" ? "No user with that id or username." : message);
    }
    return body;
  });

export interface LiveBackendUserWipeResult {
  ok: boolean;
  userId: number;
  username: string | null;
  untrackedRosters?: number;
  deletedJobs?: number;
  deleted: Record<string, number>;
}

// Admin hard purge: deactivates the player AND permanently deletes their
// board/score projection rows (farmed scores, snipe boards, top scores, key
// stats, skill ratings, feedback marks). Irreversible; re-tracking rebuilds
// only from future fetches. Accepts a user id or username like set-user-active.
export const wipeLiveBackendUserData = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; username?: unknown }) => {
    const userId = Number(data?.userId);
    const username = typeof data?.username === "string" ? data.username.trim().slice(0, 60) : "";
    if ((!Number.isInteger(userId) || userId <= 0) && !username) {
      throw new Error("Provide a user id or username.");
    }
    return {
      userId: Number.isInteger(userId) && userId > 0 ? userId : null,
      username: username || null,
    };
  })
  .handler(async ({ data }): Promise<LiveBackendUserWipeResult> => {
    await requireAdminAccess("Server wipe user data");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = { "content-type": "application/json" };
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const response = await fetch(`${base}/api/admin/wipe-user-data`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: data.userId, username: data.username }),
    });
    const body = await response.json() as LiveBackendUserWipeResult & { error?: unknown };
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Server ${response.status} for /api/admin/wipe-user-data`;
      throw new Error(message === "user_not_found" ? "No user with that id or username." : message);
    }
    return body;
  });

export interface DiscordPublicInfo {
  configured: boolean;
  applicationId: string | null;
  inviteUrl: string | null;
  feedsEnabled: boolean;
  commands: Array<{ name: string; description: string }>;
}

// Public Discord info (no secrets) for the /discord tool page. Proxies the
// backend's public /api/discord/info; returns a "not configured" shape when the
// live backend is unset or unreachable so the page can still render setup help.
export const fetchDiscordPublicInfo = createServerFn({ method: "GET" })
  .handler(async (): Promise<DiscordPublicInfo> => {
    const offline: DiscordPublicInfo = { configured: false, applicationId: null, inviteUrl: null, feedsEnabled: false, commands: [] };
    const base = getServerLiveBackendUrl();
    if (!base) return offline;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${base}/api/discord/info`, { signal: controller.signal });
      if (!response.ok) return offline;
      return await response.json() as DiscordPublicInfo;
    } catch {
      return offline;
    } finally {
      clearTimeout(timeout);
    }
  });

// Admin-only Discord status (recent interactions, subscriptions). Requires admin.
export const fetchDiscordAdminStatus = createServerFn({ method: "GET" })
  .handler(async (): Promise<any> => {
    await requireAdminAccess("Discord admin status");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/api/admin/discord/status`, { headers, signal: controller.signal });
      const body = await response.json() as any;
      if (!response.ok) {
        const message = body && typeof body === "object" && "error" in body
          ? String((body as { error?: unknown }).error)
          : `Server ${response.status} for /api/admin/discord/status`;
        throw new Error(message);
      }
      return body;
    } catch (err) {
      if (isAbortError(err)) throw new Error("Discord admin status timed out.");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  });

// Admin-only: which Discord servers the bot is a member of (live from Discord).
// Separate from the status fetch so it isn't hit on every status poll.
export const fetchDiscordGuilds = createServerFn({ method: "GET" })
  .handler(async (): Promise<any> => {
    await requireAdminAccess("Discord guild list");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = {};
    if (process.env.LIVE_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/api/admin/discord/guilds`, { headers, signal: controller.signal });
      const body = await response.json() as any;
      if (!response.ok) {
        const message = body && typeof body === "object" && "error" in body
          ? String((body as { error?: unknown }).error)
          : `Server ${response.status} for /api/admin/discord/guilds`;
        throw new Error(message);
      }
      return body;
    } catch (err) {
      if (isAbortError(err)) throw new Error("Discord guild list timed out.");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  });

export type LiveBackendStatus = "ok" | "offline";

export interface LiveBackendBootstrap {
  status: LiveBackendStatus;
  countryFeatures: LiveCountryFeaturesSnapshot | null;
}

const LIVE_BACKEND_ADMIN_STATUS_TIMEOUT_MS = 30_000;
const LIVE_BACKEND_BOOTSTRAP_TIMEOUT_MS = 1_000;
const SERVER_BOOTSTRAP_CACHE_TTL_MS = 30_000;

async function loadLiveBackendBootstrap(): Promise<LiveBackendBootstrap> {
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
}

// Country features are identical for every visitor, but the root context used to
// round-trip to the server for them on every SSR request (twice: once
// directly and once via getInitialCountry). Memoize per server instance:
// successful results are reused for a short window, concurrent callers share one
// in-flight request, and failures are never cached so recovery stays immediate.
let serverBootstrapCache: { value: LiveBackendBootstrap; expiresAt: number } | null = null;
let serverBootstrapInflight: Promise<LiveBackendBootstrap> | null = null;

export const fetchLiveBackendBootstrap = createServerFn({ method: "GET" })
  .handler(async (): Promise<LiveBackendBootstrap> => {
    if (serverBootstrapCache && serverBootstrapCache.expiresAt > Date.now()) {
      return serverBootstrapCache.value;
    }
    if (!serverBootstrapInflight) {
      serverBootstrapInflight = loadLiveBackendBootstrap()
        .then((value) => {
          if (value.status === "ok" && value.countryFeatures) {
            serverBootstrapCache = { value, expiresAt: Date.now() + SERVER_BOOTSTRAP_CACHE_TTL_MS };
          }
          return value;
        })
        .finally(() => {
          serverBootstrapInflight = null;
        });
    }
    return serverBootstrapInflight;
  });

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

const LIVE_BACKEND_ACTIVATE_TIMEOUT_MS = 2_500;

// Registers a geo-detected but never-tracked country on the server so a
// visit from it starts tracking right away (active status, live tier). The
// visitor's forwarded IP is passed through so the backend's activation rate
// limits key on the visitor instead of this server. Server-side only.
export async function activateLiveCountryOnServer(country: string, forwardedFor?: string | null): Promise<boolean> {
  const base = getServerLiveBackendUrl();
  if (!base) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_BACKEND_ACTIVATE_TIMEOUT_MS);
  try {
    const headers: HeadersInit = {};
    if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
    const response = await fetch(`${base}/api/countries/activate?country=${encodeURIComponent(country)}`, {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    // The memoized bootstrap predates this registration; drop it so the next
    // request sees the new registry row instead of bouncing back to Global.
    serverBootstrapCache = null;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export const fetchLivePlayerCachedProfileSnapshot = createServerFn({ method: "GET" })
  .validator((data: { key?: unknown }) => {
    if (typeof data?.key !== "string" || !data.key.trim()) throw new Error("Invalid profile key.");
    return { key: data.key.trim().slice(0, 120) };
  })
  .handler(async ({ data }): Promise<LivePlayerProfileSnapshot | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    const response = await fetch(`${base}/api/profiles/${encodeURIComponent(data.key)}/cached-snapshot`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Server ${response.status} for cached profile snapshot`);
    return response.json() as Promise<LivePlayerProfileSnapshot>;
  });

export const fetchLivePlayerRecentScores = createServerFn({ method: "GET" })
  .validator((data: { userId?: unknown; source?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
    const source = data?.source === "osu" ? "osu" : "tracked";
    return { userId, source };
  })
  .handler(async ({ data }): Promise<LivePlayerProfileSection<OsuScore[]> | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    const query = data.source === "osu" ? "?source=osu" : "";
    const response = await fetch(`${base}/api/profiles/${data.userId}/recent${query}`);
    if (!response.ok) throw new Error(`Server ${response.status} for profile recent scores`);
    return response.json() as Promise<LivePlayerProfileSection<OsuScore[]>>;
  });

export const fetchLivePlayerAbout = createServerFn({ method: "GET" })
  .validator((data: { userId?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
    return { userId };
  })
  .handler(async ({ data }): Promise<LivePlayerProfileSection<LivePlayerAboutPayload> | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    const response = await fetch(`${base}/api/profiles/${data.userId}/about`);
    if (!response.ok) throw new Error(`Server ${response.status} for profile about`);
    return response.json() as Promise<LivePlayerProfileSection<LivePlayerAboutPayload>>;
  });

// Direct browser fetch: the backend allows CORS from the site origins, so the
// post-hydration snapshot refresh skips the SSR server hop entirely.
export async function fetchLivePlayerProfileSnapshotDirect(
  key: string,
  options: { lookup?: "id"; refresh?: boolean } = {},
): Promise<LivePlayerProfileSnapshot | null> {
  const trimmed = key.trim().slice(0, 120);
  if (!trimmed) throw new Error("Invalid profile key.");
  const params = new URLSearchParams();
  if (options.lookup === "id") params.set("lookup", "id");
  // refresh: false keeps the read from scheduling a background profile refresh.
  // For a caller that already accepts staleness (the pack card path) one dealt
  // hand would otherwise queue a priority-80 re-mint per card.
  if (options.refresh === false) params.set("refresh", "0");
  const query = params.toString();
  return fetchLiveJson(`/api/profiles/${encodeURIComponent(trimmed)}/snapshot${query ? `?${query}` : ""}`);
}

export async function fetchLivePlayerCachedProfileSnapshotDirect(key: string): Promise<LivePlayerProfileSnapshot | null> {
  const trimmed = key.trim().slice(0, 120);
  if (!trimmed) throw new Error("Invalid profile key.");
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const response = await fetch(`${base}/api/profiles/${encodeURIComponent(trimmed)}/cached-snapshot`, { credentials: "omit" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Server ${response.status}`);
  const snapshot = await response.json() as LivePlayerProfileSnapshot;
  harvestAvatarAccents(snapshot);
  return snapshot;
}

/* Slim cached-snapshot view for pack card minting: the same projected best
   scores, trimmed server-side to the fields the maniacard pipeline reads
   (score pp/mods/statistics plus beatmap difficulty numbers, and the user's
   id/name/pp). bestScores is typed OsuScore[] for the card pipeline's sake,
   but each score carries only that subset; do not feed it to surfaces that
   render beatmapset or per-score user data. */
export interface LivePackCardSnapshot {
  view: "card";
  user: {
    id: number;
    username: string;
    avatar_url: string;
    country_code: string;
    statistics: { pp: number | null; global_rank: number | null };
  };
  bestScores: OsuScore[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
}

/* Carries the HTTP status (and a 429's retry-after) so a caller can tell a
   rejected request from a real "nothing stored" answer, instead of collapsing
   both into an empty result. */
export class LiveBackendRequestError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`Server ${status}`);
    this.name = "LiveBackendRequestError";
  }
}

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/* A whole dealt hand in one request. The backend reads the players' stored
   rows together (shared beatmap lookup, one trip through the rate limiter),
   and players it has nothing cached for are simply absent from the result. */
export async function fetchLivePackCardSnapshotsDirect(userIds: readonly number[]): Promise<Map<number, LivePackCardSnapshot>> {
  const ids = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  const cards = new Map<number, LivePackCardSnapshot>();
  if (ids.length === 0) return cards;
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const response = await fetch(`${base}/api/packs/cards?ids=${ids.join(",")}`, { credentials: "omit" });
  if (!response.ok) throw new LiveBackendRequestError(response.status, retryAfterMs(response));
  const payload = await response.json() as { cards?: LivePackCardSnapshot[] };
  harvestAvatarAccents(payload);
  for (const card of payload.cards ?? []) {
    const id = Number(card?.user?.id);
    if (Number.isInteger(id) && id > 0) cards.set(id, card);
  }
  return cards;
}

/* Which of these players a card can be built for, as a plain yes/no. The draw
   asks this to decide who it may deal; asking fetchLivePackCardSnapshotsDirect
   instead would build every card just to throw them away, which at peak pack
   rates is real synchronous DB time on the backend for no answer it needs. */
export async function fetchLivePackPlayersReady(userIds: readonly number[]): Promise<Set<number>> {
  const ids = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return new Set();
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const response = await fetch(`${base}/api/packs/cards/ready?ids=${ids.join(",")}`, { credentials: "omit" });
  if (!response.ok) throw new LiveBackendRequestError(response.status, retryAfterMs(response));
  const payload = await response.json() as { ready?: unknown };
  const ready = Array.isArray(payload.ready) ? payload.ready : [];
  return new Set(ready.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0));
}

export async function fetchLivePackCardSnapshotDirect(key: string): Promise<LivePackCardSnapshot | null> {
  const trimmed = key.trim().slice(0, 120);
  if (!trimmed) throw new Error("Invalid profile key.");
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const response = await fetch(`${base}/api/profiles/${encodeURIComponent(trimmed)}/cached-snapshot?view=card&lookup=id`, { credentials: "omit" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Server ${response.status}`);
  const snapshot = await response.json() as LivePackCardSnapshot;
  harvestAvatarAccents(snapshot);
  return snapshot;
}

export async function fetchLivePlayerRecentScoresDirect(
  userId: number,
  source: LivePlayerRecentSource = "tracked",
): Promise<LivePlayerProfileSection<OsuScore[]>> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  const query = source === "osu" ? "?source=osu" : "";
  return fetchLiveJson(`/api/profiles/${userId}/recent${query}`);
}

export async function fetchLivePlayerReplayScoresDirect(
  userId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<LivePlayerReplayScoresPage> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  const query = new URLSearchParams({
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0),
  });
  return fetchLiveJson(`/api/profiles/${userId}/replay-scores?${query.toString()}`);
}

export async function fetchLivePlayerAboutDirect(userId: number): Promise<LivePlayerProfileSection<LivePlayerAboutPayload>> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  return fetchLiveJson(`/api/profiles/${userId}/about`);
}

// Public per-player skill ratings (the same shape the My Data card consumes,
// plus percentiles and player dan). Server-side compute enqueueing is gated to
// players the backend already tracks, so this can 200 with status "pending"
// forever for arbitrary unknown ids.
export async function fetchLivePlayerSkillsDirect(userId: number): Promise<LivePlayerSkills> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  return fetchLiveJson(`/api/profiles/${userId}/skills`);
}

export async function fetchLivePlayerSkillPlaysDirect(
  userId: number,
  keyCount: number,
  axis: string,
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<LivePlayerSkillPlaysPage> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  if (!Number.isInteger(keyCount) || keyCount <= 0) throw new Error("Invalid key count.");
  const query = new URLSearchParams({
    keys: String(keyCount),
    axis,
    limit: String(Math.max(1, Math.min(50, Math.floor(options.limit ?? 50)))),
    offset: String(Math.max(0, Math.floor(options.offset ?? 0))),
  });
  return fetchLiveJson(`/api/profiles/${userId}/skill-plays?${query.toString()}`, options.signal ? { signal: options.signal } : undefined);
}

export async function fetchLivePlayerActivityDirect(
  userId: number,
  country: string,
  year: number,
): Promise<LivePlayerActivitySnapshot> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  const query = new URLSearchParams({
    country: country.trim().toUpperCase(),
    year: String(Math.floor(year)),
  });
  return fetchLiveJson(`/api/profiles/${userId}/activity?${query.toString()}`);
}

export async function fetchLivePlayerActivityDayDirect(
  userId: number,
  country: string,
  date: string,
): Promise<LivePlayerActivityDay> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user ID.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid activity date.");
  const query = new URLSearchParams({
    country: country.trim().toUpperCase(),
    date,
  });
  return fetchLiveJson(`/api/profiles/${userId}/activity-day?${query.toString()}`);
}

export interface LiveTrackerSnapshotFilters {
  scoreFilter?: "ranked";
  grade?: "SS" | "S" | "A" | "B";
  key?: "4k" | "other";
  miss?: "fc" | "fc_choke";
}

export async function fetchLiveTrackerSnapshot(
  country: string,
  limit = 100,
  options?: { observe?: boolean; offset?: number; hours?: number; filters?: LiveTrackerSnapshotFilters; sort?: "recent" | "stars"; sortDirection?: "asc" | "desc"; userIds?: number[] },
): Promise<LiveTrackerSnapshot> {
  const query = new URLSearchParams({ country, limit: String(limit) });
  if (options?.observe) query.set("observe", "1");
  if (options?.offset != null) query.set("offset", String(options.offset));
  if (options?.hours != null) query.set("hours", String(options.hours));
  if (options?.filters?.scoreFilter) query.set("scoreFilter", options.filters.scoreFilter);
  if (options?.filters?.grade) query.set("grade", options.filters.grade);
  if (options?.filters?.key) query.set("key", options.filters.key);
  if (options?.filters?.miss) query.set("miss", options.filters.miss);
  if (options?.sort && options.sort !== "recent") query.set("sort", options.sort);
  if (options?.sortDirection && options.sortDirection !== "desc") query.set("sortDirection", options.sortDirection);
  if (options?.userIds && options.userIds.length > 0) query.set("userIds", options.userIds.join(","));
  return fetchLiveJson(`/api/snapshots/tracker?${query.toString()}`);
}

export type LiveFarmHelperReason = "missing" | "improve" | "stale" | "owned" | "push";
export type LiveFarmHelperKeyMode = "4k" | "7k" | "any";
export type LiveFarmHelperView = "gain" | "popular";
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
  listCover?: string;
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
  // The player's best score on this beatmap in a different speed lane, when
  // this lane has none of their own: a "missing" HT lane on a map they hold an
  // NM pb on. Optional so older backends still parse.
  subjectOtherLanePp?: number | null;
  subjectOtherLaneSpeed?: LiveFarmHelperSpeedBucket | null;
  peerCount: number;
  peerSampleSize: number;
  peerFraction: number;
  // Shape match between the player and this chart in [0,1], or null when the
  // backend has no comparable shape. Optional so older builds still parse.
  patternFit?: number | null;
  peerPpMedian: number;
  peerPpP75: number;
  latestPeerPlayedAt: string | null;
  peerRecencyPlayedAt: string | null;
  topPeers: LiveFarmHelperPeer[];
  scoreUrl: string | null;
  mapUrl: string;
  rankScore: number;
  // P(finish) estimate in [0,1] for lanes the player has not cleared (1 = no
  // risk detected). Null on the popular browse; optional so older backends
  // still parse. The gain/target shown are if-you-finish values; the backend
  // ranking already discounts by this.
  survival?: number | null;
  // True when the backend judged this lane a risky clear (survival below its
  // threshold): render it as a clear attempt, not a farm.
  clearRisk?: boolean;
  // Active feedback mark from the snapshot's own player on this lane. Only set
  // on owner requests; optional so older backends still parse.
  feedback?: "too_hard" | "too_easy";
}

export interface LiveFarmHelperPeerBand {
  mode: string;
  count: number;
  farmDataCount: number;
  minPp: number;
  maxPp: number;
  effectiveCount?: number;
}

export interface LiveFarmHelperSnapshot {
  status: "ready";
  userId: number;
  username: string;
  avatarUrl: string;
  coverUrl: string;
  pp: number;
  keyMode: LiveFarmHelperKeyMode;
  view: LiveFarmHelperView;
  peerBand: LiveFarmHelperPeerBand;
  // Per-keymode cohort summaries on the merged "any" view (absent on concrete
  // views and the total-pp fallback). Optional so older builds still parse.
  peerBands?: Partial<Record<"4k" | "7k", LiveFarmHelperPeerBand>>;
  totalPotentialPp: number;
  // What the gain numbers measure: the player's overall profile pp ("any"
  // view) or the requested keymode's variant pp (concrete "4k"/"7k" views).
  // Optional: older backend builds don't send it; treat absent as "overall".
  gainBasis?: "overall" | "keymode";
  // Optional: older backend builds don't send it. Count of qualifying recs
  // before server-side truncation to the requested limit.
  totalQualifying?: number;
  // Gain view only: lanes hidden because the player marked them too_hard.
  // Optional so older backends still parse.
  feedbackHiddenCount?: number;
  // Gain view only: lanes that cleared every gate except the minimum visible
  // gain (under 1pp for this player). Lets the empty board explain itself.
  // Optional so older backends still parse.
  belowGainFloorCount?: number;
  // False while the backend has not analyzed enough of this player's plays to
  // trust its models yet. Absent means ready (older backends don't send it).
  modelsReady?: boolean;
  // Gain view only: false until the player has achieved (or come very close
  // to) one of the skillboost targets a board suggested to them. The default
  // list hides skillboost rows while false; the skillboost tab still shows
  // them. Absent (older backends, popular view) means never hide.
  pushUnlocked?: boolean;
  recs: LiveFarmHelperRec[];
  generatedAt: string;
}

export async function fetchLiveFarmHelperSnapshot(
  userKey: string,
  params?: {
    keyMode?: LiveFarmHelperKeyMode;
    view?: LiveFarmHelperView;
    limit?: number;
    fresh?: boolean | number;
    signal?: AbortSignal;
  },
): Promise<LiveFarmHelperSnapshot> {
  const query = new URLSearchParams({ user: userKey });
  if (params?.keyMode) query.set("key", params.keyMode);
  if (params?.view) query.set("view", params.view);
  if (params?.limit != null) query.set("limit", String(params.limit));
  // Cache-buster: the endpoint serves max-age=60, so fetches right after a
  // feedback mutation must skip the browser HTTP cache. Passing a number uses
  // it as a stable epoch, so every fetch in the same epoch shares one cache
  // entry; `true` is a one-off buster. The backend ignores unknown params.
  if (typeof params?.fresh === "number") query.set("ts", String(params.fresh));
  else if (params?.fresh) query.set("ts", String(Date.now()));
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
  options?: { keyMode?: LiveFarmHelperKeyMode; signal?: AbortSignal },
): Promise<LiveFarmHelperFarmers> {
  const query = new URLSearchParams({ user: userKey, beatmap: String(beatmapId) });
  if (speedBucket) query.set("speed", speedBucket);
  if (options?.keyMode) query.set("key", options.keyMode);
  return fetchLiveJson(`/api/snapshots/farm-helper-farmers?${query.toString()}`, options?.signal ? { signal: options.signal } : undefined);
}

export interface LiveFarmHelperNeighbor {
  userId: number;
  username: string;
  avatarUrl: string;
  modePp: number;
}

export interface LiveFarmHelperNeighbors {
  userId: number;
  username: string;
  avatarUrl: string;
  keyMode: LiveFarmHelperKeyMode;
  bandMode: string;
  subjectModePp: number;
  neighborCount: number;
  neighbors: LiveFarmHelperNeighbor[];
}

export async function fetchLiveFarmHelperNeighbors(
  userKey: string,
  options?: { keyMode?: LiveFarmHelperKeyMode; signal?: AbortSignal },
): Promise<LiveFarmHelperNeighbors> {
  const query = new URLSearchParams({ user: userKey });
  if (options?.keyMode) query.set("key", options.keyMode);
  return fetchLiveJson(`/api/snapshots/farm-helper-neighbors?${query.toString()}`, options?.signal ? { signal: options.signal } : undefined);
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

/**
 * The country board a snipe was taken on. The lane is derived backend-side from
 * the mods and client the score was set with, so callers pass what the snipe
 * event already carries rather than a lane key.
 */
export async function fetchLiveSnipeBoard(
  country: string,
  beatmapId: number,
  params: { mods: string[]; isLazer: boolean; limit?: number },
  options?: { signal?: AbortSignal },
): Promise<LiveSnipeBoardSnapshot> {
  const query = new URLSearchParams({ country, beatmap: String(beatmapId) });
  if (params.mods.length > 0) query.set("mods", params.mods.join(","));
  if (params.isLazer) query.set("lazer", "1");
  if (params.limit != null) query.set("limit", String(params.limit));
  return fetchLiveJson(`/api/snapshots/snipe-board?${query.toString()}`, options?.signal ? { signal: options.signal } : undefined);
}

// The Random tab draws server-side: the filters travel with the request and the
// response carries a handful of fully hydrated picks plus the eligible counts,
// instead of the whole favourites pool (13 MiB at GLOBAL scope).
export async function fetchLiveMapsRandomDraw(
  country: string,
  params: LiveMapsRandomDrawParams,
  options?: { signal?: AbortSignal },
): Promise<LiveMapsRandomDrawSnapshot> {
  const query = buildRandomDrawQuery(country, params);
  return fetchLiveJson(`/api/snapshots/maps-random-draw?${query}`, options?.signal ? { signal: options.signal } : undefined);
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

export async function fetchLiveMapsProgress(country: string): Promise<LiveMapsProgressSnapshot> {
  const query = new URLSearchParams({ country, observe: "1" });
  return fetchLiveJson(`/api/snapshots/maps-progress?${query.toString()}`);
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

// ---------------------------------------------------------------------------
// Global map search + collections (catalog-wide, country-agnostic)
// ---------------------------------------------------------------------------

export interface LiveMapSearchEntry {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  version: string;
  status: string;
  keyCount: number;
  stars: number;
  bpm: number;
  length: number;
  playCount: number;
  lnCount: number;
  primaryPattern: string;
  patterns: Record<string, number>;
  // Detected subfamily tags from the chart analysis (bracket, speedjack,
  // lngeneral, ...), strongest first; empty (or absent on cached payloads)
  // until the analysis lands.
  patternTags?: string[];
  covers: Record<string, string> | null;
  // From the unified chart analysis; null until the chart's analysis job lands.
  dan?: { label: string; family: string; rawDan: number } | null;
  msd?: Record<string, number> | null;
  // Rate-adjusted (1.5x / DT) dan + MSD, present on the single-map detail entry
  // once the DT-rate sweep covers the chart; used to show real DT difficulty.
  danDt?: { label: string; family: string; rawDan: number } | null;
  msdDt?: Record<string, number> | null;
  // LN-adjusted (tail-aware) MSD at 1.0x for hold-bearing charts, on bulk
  // search rows and diffs as well as the single-map detail entry (absent only
  // on payloads cached before the field shipped). Already blended server-side;
  // matches the skill-rating engine's valuation.
  msdLn?: Record<string, number> | null;
  // Vibro-like chart per the classifier: ratings are unreliable and dan-scoped
  // searches skip these server-side.
  vibro?: boolean;
  // Search results are one entry per beatmapset: the top-level fields describe
  // the representative diff and `diffs` lists every filter-matching diff of the
  // set (easiest first). Absent on collection items, which are already deduped.
  diffCount?: number;
  diffs?: LiveMapSearchEntry[];
}

export interface LiveMapSearchResult {
  items: LiveMapSearchEntry[];
  total: number;
  page: number;
  pageSize: number;
  // Present (true) when the backend stopped counting at its cap (5000), so
  // the count renders as "5,000+" instead of a fake-exact number.
  totalCapped?: boolean;
}

export interface LiveMapSearchParams {
  q: string;
  keys: string[];
  keysExclude: string[];
  statuses: string[];
  statusesExclude: string[];
  patterns: string[];
  patternsExclude: string[];
  starMin: number | null;
  starMax: number | null;
  bpmMin: number | null;
  bpmMax: number | null;
  lenMin: number | null;
  lenMax: number | null;
  danMin: number | null;
  danMax: number | null;
  country: string | null;
  sort: string;
  dir: string;
  page: number;
  pageSize: number;
}

export interface LiveMapCollectionSummary {
  id: string;
  recipeId: string;
  kind: string;
  title: string;
  description: string | null;
  keyCount: number | null;
  pattern: string | null;
  /** Difficulty axis the pack is bucketed on: dan estimate or MSD overall. */
  axis: "dan" | "msd" | null;
  bucketLo: number | null;
  bucketHi: number | null;
  sortOrder: number;
  coverSetId: number | null;
  coverSetIds: number[];
  memberCount: number;
  refreshedAt: string;
}

export interface LiveMapCollectionsRotation {
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  intervalMs: number;
}

export interface LiveMapCollectionsResult {
  collections: LiveMapCollectionSummary[];
  rotation: LiveMapCollectionsRotation | null;
}

export interface LiveMapCollectionDetail extends LiveMapCollectionSummary {
  items: LiveMapSearchEntry[];
  newBeatmapIds: number[];
}

export async function fetchLiveMapSearch(params: LiveMapSearchParams): Promise<LiveMapSearchResult> {
  const query = new URLSearchParams({
    sort: params.sort,
    dir: params.dir,
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.q.trim()) query.set("q", params.q.trim());
  if (params.keys.length) query.set("keys", params.keys.join(","));
  if (params.keysExclude.length) query.set("keysExclude", params.keysExclude.join(","));
  if (params.statuses.length) query.set("statuses", params.statuses.join(","));
  if (params.statusesExclude.length) query.set("statusesExclude", params.statusesExclude.join(","));
  if (params.patterns.length) query.set("patterns", params.patterns.join(","));
  if (params.patternsExclude.length) query.set("patternsExclude", params.patternsExclude.join(","));
  if (params.starMin != null) query.set("starMin", String(params.starMin));
  if (params.starMax != null) query.set("starMax", String(params.starMax));
  if (params.bpmMin != null) query.set("bpmMin", String(params.bpmMin));
  if (params.bpmMax != null) query.set("bpmMax", String(params.bpmMax));
  if (params.lenMin != null) query.set("lenMin", String(params.lenMin));
  if (params.lenMax != null) query.set("lenMax", String(params.lenMax));
  if (params.danMin != null) query.set("danMin", String(params.danMin));
  if (params.danMax != null) query.set("danMax", String(params.danMax));
  if (params.country) query.set("country", params.country);
  return fetchLiveJson(`/api/snapshots/maps-search?${query.toString()}`);
}

// Single set entry for /maps?map=<beatmapId> share links; the requested diff is
// the representative and `diffs` carries the whole set. Null when the map is
// unknown to the catalog (or the backend is unreachable).
export async function fetchLiveMapSearchEntry(beatmapId: number): Promise<LiveMapSearchEntry | null> {
  try {
    const result = await fetchLiveJson<{ entry: LiveMapSearchEntry }>(
      `/api/snapshots/map-search-entry?beatmapId=${Math.floor(beatmapId)}`,
    );
    return result.entry ?? null;
  } catch {
    return null;
  }
}

export async function fetchLiveMapCollections(opts?: { fresh?: boolean }): Promise<LiveMapCollectionsResult> {
  // The snapshot carries a 5-min cache-control; after a manual admin rebuild we
  // bypass it with no-store so the new rotation shows immediately.
  const init = opts?.fresh ? { cache: "no-store" as const } : undefined;
  const result = await fetchLiveJson<LiveMapCollectionsResult>("/api/snapshots/map-collections", init);
  return { collections: result.collections ?? [], rotation: result.rotation ?? null };
}

export async function fetchLiveMapCollection(id: string): Promise<LiveMapCollectionDetail | null> {
  const result = await fetchLiveJson<{ collection: LiveMapCollectionDetail | null }>(
    `/api/snapshots/map-collection?id=${encodeURIComponent(id)}`,
  );
  return result.collection ?? null;
}

export interface LiveChartAnalysisPatternHit {
  id: string;
  label: string;
  score: number;
  confidence: number;
}

export interface LiveChartAnalysisCluster {
  label: string;
  pattern: string;
  bpm: number;
  mixed: boolean;
  amount: number;
  importance: number;
}

// The stored lean chart classification for one beatmap: detected pattern hits
// in the in-house vocabulary plus the LeoBlack cluster readout. Backs the map
// detail modal's keymode-honest pattern strip for non-4K charts.
export interface LiveChartAnalysisDetail {
  beatmapId: number;
  status: string;
  keyCount: number | null;
  patterns: LiveChartAnalysisPatternHit[];
  clusters: LiveChartAnalysisCluster[];
  clusterCategory: string | null;
  modeTag: string | null;
  verdictText: string | null;
  lnRatio: number | null;
  // LN-adjusted (tail-aware, keymode-blended) MSD; null for rice charts or
  // until the LN MSD sweep covers this chart.
  msdLn?: Record<string, number> | null;
}

export async function fetchLiveChartAnalysis(beatmapId: number): Promise<LiveChartAnalysisDetail | null> {
  try {
    return await fetchLiveJson<LiveChartAnalysisDetail>(`/api/chart-analysis?beatmapId=${beatmapId}`);
  } catch {
    return null;
  }
}

/* Player search off the backend's stored users (roster members plus anyone seen
   in ingest). The site's search boxes call this per typed query, which the osu!
   /search endpoint could not absorb: its calls come out of the same ~45/min
   budget as ingest. Untracked players are the gap, so the boxes that must find
   any osu! player fall back to the API only when this comes back empty
   (src/lib/player-search.ts). */

export interface LiveUserSearchEntry {
  id: number;
  username: string;
  avatarUrl: string;
  countryCode: string | null;
  pp: number | null;
  globalRank: number | null;
  avatarAccent?: string | null;
}

export async function fetchLiveUserSearch(query: string, limit?: number): Promise<LiveUserSearchEntry[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const params = new URLSearchParams({ q: trimmed });
  if (limit != null) params.set("limit", String(limit));
  const response = await fetchLiveJson<{ users?: LiveUserSearchEntry[] }>(`/api/users/search?${params.toString()}`);
  return response?.users ?? [];
}

/* The temporary GOAT nomination poll board (/packs). Read straight from the
   browser rather than through a server fn: it refreshes on a timer in every
   open packs tab and carries no per-viewer data, so there is nothing worth
   spending the frontend node process on. The viewer's own ballot and every
   write go through src/lib/goat-poll.ts instead, which is where the osu! login
   is verified. A null return means the poll is off (the endpoint 404s). */

export interface GoatPollNominee {
  id: string;
  osuUserId: number | null;
  username: string;
  countryCode: string | null;
  avatarUrl: string | null;
  banned: boolean;
  proofUrl: string | null;
  nominatedBy: number;
  createdAt: number;
  up: number;
  down: number;
  net: number;
}

/* "There is no poll" — a retired one, or an unreleased one seen by someone who
   is not an admin, which answer the same 404 on purpose. Distinct from null
   (the backend was unreachable) so the widget can stop polling for good in the
   first case and keep trying in the second. */
export const GOAT_POLL_OFF = "goat_poll_off" as const;
export type GoatPollOff = typeof GOAT_POLL_OFF;

/* The `goat_poll` SSE frame: one changed row, or the id of one that is gone.
   A vote touches exactly one nominee, so the stream carries that row and the
   board patches itself — sending the whole board per click would be up to
   150 KiB to every viewer. */
export interface GoatPollLiveChange {
  pollId: string;
  nominee?: GoatPollNominee;
  removedId?: string;
}

/* The board's own order, mirrored on the client so a patched row lands where
   the next fetch would put it: best net first, then the one more people
   actually upvoted, then the earlier nomination. */
export function sortGoatPollNominees(nominees: GoatPollNominee[]): GoatPollNominee[] {
  return [...nominees].sort((a, b) => b.net - a.net || b.up - a.up || a.createdAt - b.createdAt);
}

export interface GoatPollBoardPayload {
  pollId: string;
  /* The pie fills across opensAt -> closesAt. Both come from the backend: a
     client that assumed a fixed poll length would draw the wedge at the wrong
     rate for any poll that was not exactly that long. */
  opensAt: number;
  closesAt: number;
  /* The backend's clock when it answered. */
  serverNow: number;
  /* True while the poll is running but unreleased. Only an admin ever sees a
     board with this set — for everyone else the endpoint 404s. */
  adminOnly: boolean;
  nominees: GoatPollNominee[];
  /* How many nominees the whole board holds. `nominees` carries only as many
     as were asked for, so this is what says whether there are more to load. */
  totalNominees: number;
}

export interface GoatPollBoard extends GoatPollBoardPayload {
  /* The browser's clock when the answer landed, stamped by the widget. It counts
     down against Date.now() + (serverNow - receivedAt) rather than Date.now(),
     so a machine whose clock is days out still sees the same deadline as
     everyone else — and the same one the backend enforces on the way in. Half a
     round trip of latency is folded into the offset; over a poll measured in
     hours that is not worth correcting for. */
  receivedAt: number;
}

/* The public board read, browser-direct. Returns null when the poll is off —
   and also when it is admin-only, which is the same 404 on purpose: an
   unreleased poll should be indistinguishable from one that does not exist.
   Admins read it through fetchGoatPollBoardAsAdmin() in src/lib/goat-poll.ts
   instead, which carries the bridge token. */
export async function fetchGoatPollBoard(limit?: number): Promise<GoatPollBoardPayload | GoatPollOff | null> {
  if (!isLiveBackendConfigured()) return GOAT_POLL_OFF;
  try {
    // No limit means the whole board. The widget passes how many rows it is
    // actually showing, so its 20-second refresh stops carrying hundreds of
    // rows to draw eight.
    const query = limit != null && Number.isInteger(limit) && limit > 0 ? `?limit=${limit}` : "";
    return await fetchLiveJson<GoatPollBoardPayload>(`/api/goat-poll${query}`);
  } catch (error) {
    /* A 404 is the backend saying there is no poll — retired, or unreleased and
       this viewer is not an admin. Told apart from a network blip so the widget
       can stop asking: once a poll is over, every open packs tab would otherwise
       spend a request on it every 20 seconds for as long as the tab lives. */
    return error instanceof LiveBackendRequestError && error.status === 404 ? GOAT_POLL_OFF : null;
  }
}

export interface LiveGlobalRankingEntry {
  rank: number;
  user: { id: number; username: string; avatar_url: string; cover_url: string; country_code: string; avatar_accent: string | null };
  pp: number;
  global_rank: number | null;
  country_rank: number | null;
  hit_accuracy: number | null;
  play_count: number | null;
  ranked_score: number | null;
  grade_counts: {
    ss: number;
    ssh: number;
    s: number;
    sh: number;
    a: number;
  } | null;
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
  /* "packs" asks for the card-pack draw pool: the ranked board with manual
     opt-in roster members merged in by pp. Leaderboard surfaces omit it. */
  pool?: "packs";
  /* With pool "packs", narrows the pool to main-4K or main-7K players (the
     backend classifies from variant pp, falling back to farmed key stats). */
  keys?: 4 | 7;
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
  if (params.pool) query.set("pool", params.pool);
  if (params.pool && params.keys) query.set("keys", String(params.keys));
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

export async function fetchLiveRankingsSnapshot(
  country: string,
  options: number | LiveGlobalRankingsParams = 50,
): Promise<LiveGlobalRankingsSnapshot> {
  const params = typeof options === "number" ? { page: 1, pageSize: options } : options;
  const query = new URLSearchParams({
    country: country.trim().toUpperCase(),
    page: String(Math.max(1, Math.floor(params.page ?? 1))),
    pageSize: String(Math.max(1, Math.min(50, Math.floor(params.pageSize ?? 50)))),
    sort: params.sort ?? "rank",
    dir: params.dir === "asc" ? "asc" : "desc",
  });
  const snapshot = await fetchLiveJson<Record<string, unknown>>(
    `/api/snapshots/rankings?${query.toString()}`,
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
  const grades = readRecord(entry.grade_counts);
  return {
    rank: readPositiveInteger(entry.rank) ?? index + 1,
    user: {
      id: readPositiveInteger(user.id) ?? 0,
      username: readString(user.username),
      avatar_url: readString(user.avatar_url),
      cover_url: readString(user.cover_url),
      country_code: readString(user.country_code),
      // Keep the accent on the entry so cached boards (home top players) color
      // names without a follow-up lookup, which privacy extensions can block.
      avatar_accent: typeof user.avatar_accent === "string" && user.avatar_accent ? user.avatar_accent : null,
    },
    pp: readFiniteNumber(entry.pp) ?? 0,
    global_rank: readPositiveInteger(entry.global_rank),
    country_rank: readPositiveInteger(entry.country_rank),
    hit_accuracy: readFiniteNumber(entry.hit_accuracy),
    play_count: readNonNegativeInteger(entry.play_count),
    ranked_score: readNonNegativeInteger(entry.ranked_score),
    grade_counts: grades
      ? {
        ss: readNonNegativeInteger(grades.ss) ?? 0,
        ssh: readNonNegativeInteger(grades.ssh) ?? 0,
        s: readNonNegativeInteger(grades.s) ?? 0,
        sh: readNonNegativeInteger(grades.sh) ?? 0,
        a: readNonNegativeInteger(grades.a) ?? 0,
      }
      : null,
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

/* Tells the backend which players a freshly dealt pack drew, so cold
   players' profile snapshots start fetching before their card is flipped.
   Fire-and-forget: the response only reports how many fetches started. */
export async function warmLivePackPlayers(userIds: number[]): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 10);
  if (uniqueUserIds.length === 0) return;
  await fetchLiveJson("/api/packs/warm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userIds: uniqueUserIds }),
  });
}

export interface LivePackCardStats {
  userId: number;
  owners: number;
  copies: number;
}

export interface LivePackPulledStats {
  userId: number;
  owners: number;
  copies: number;
  pullEvents7d: number;
  lastPulledAt: number | null;
}

export interface LivePackPullFeedEntry {
  id: number;
  ownerUserId: number;
  ownerUsername: string;
  cardUserId: number;
  cardUsername: string;
  cardCountryCode: string;
  cardAvatarUrl: string | null;
  tier: string | null;
  packType: string;
  isNew: boolean;
  isFirstGlobal: boolean;
  pulledAt: number;
}

/* Community ownership counts for a hand of cards ("owned by N collectors"). */
export async function fetchLivePackCardStats(userIds: number[]): Promise<LivePackCardStats[]> {
  const uniqueUserIds = [...new Set(userIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 10);
  if (uniqueUserIds.length === 0) return [];
  const body = await fetchLiveJson<{ cards?: LivePackCardStats[] }>(
    `/api/packs/card-stats?ids=${uniqueUserIds.join(",")}`,
  );
  return Array.isArray(body.cards) ? body.cards : [];
}

/* How the community holds one player's own card ("your card got pulled"). */
export async function fetchLivePackPulledStats(userId: number): Promise<LivePackPulledStats> {
  return fetchLiveJson(`/api/packs/pulled-stats/${userId}`);
}

/* The streak game's per-player question numbers (oldest top play, DT/7K
   counts, playtime, join date, followers, replay views), read from the
   backend's stored projections. Every field nullable: a null means that
   question is not asked about this player, never that anything should be
   fetched. Cheap by design (local projections + an hour of browser cache), so
   the game can call it once per page of the pool. */
export interface LiveStreakPlayerMetrics {
  userId: number;
  oldestTopAt: number | null;
  dtTop: number | null;
  k7Top: number | null;
  playTimeHours: number | null;
  joinedAt: number | null;
  followers: number | null;
  replayViews: number | null;
}

export async function fetchLiveStreakMetrics(userIds: number[]): Promise<Map<number, LiveStreakPlayerMetrics>> {
  const uniqueUserIds = [...new Set(userIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 50);
  const metrics = new Map<number, LiveStreakPlayerMetrics>();
  if (uniqueUserIds.length === 0) return metrics;
  const body = await fetchLiveJson<{ players?: Record<string, LiveStreakPlayerMetrics> }>(
    `/api/packs/streak-metrics?ids=${uniqueUserIds.join(",")}`,
  );
  for (const [key, value] of Object.entries(body.players ?? {})) {
    const userId = Number(key);
    if (Number.isInteger(userId) && userId > 0 && value && typeof value === "object") metrics.set(userId, value);
  }
  return metrics;
}

/* The blitz higher-or-lower board: the ten longest streaks recorded in a
   pool, plus where the viewer sits when they did not make it. Public, like
   every other leaderboard here, and read fresh rather than cached because it
   is sitting next to the game that changes it. */
export interface LiveStreakBoardEntry {
  rank: number;
  userId: number;
  username: string;
  streak: number;
  achievedAt: number;
}

export interface LiveStreakBoard {
  pool: "top500" | "top" | "anyone";
  entries: LiveStreakBoardEntry[];
  viewer: LiveStreakBoardEntry | null;
}

export async function fetchLiveStreakBoard(
  pool: "top500" | "top" | "anyone",
  viewerId?: number | null,
): Promise<LiveStreakBoard> {
  const me = Number.isInteger(viewerId) && (viewerId ?? 0) > 0 ? `&me=${viewerId}` : "";
  const body = await fetchLiveJson<Partial<LiveStreakBoard>>(`/api/packs/games/streak/board?pool=${pool}${me}`);
  return {
    pool,
    entries: Array.isArray(body.entries) ? body.entries : [],
    viewer: body.viewer ?? null,
  };
}

export interface LiveStreakRemoveResult {
  ok: boolean;
  removed: boolean;
  entry: LiveStreakBoardEntry | null;
  runsDeleted: number;
}

/* Moderation for the blitz board, done from the board itself. Deletes one
   record (and that account's ended runs in the pool); the account keeps
   playing and can set another streak, so this removes a result rather than a
   player. True-admin only, and server-side rather than a browser fetch for the
   same reason every other admin call here is: the backend token never leaves
   the server. */
export const removeLiveStreakBest = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; pool?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("A user id is required.");
    return {
      userId,
      pool: data?.pool === "top500" || data?.pool === "anyone" ? data.pool : "top" as const,
    };
  })
  .handler(async ({ data }): Promise<LiveStreakRemoveResult> => {
    await requireTrueAdminAccess("Server remove streak best");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers: HeadersInit = { "content-type": "application/json" };
    if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    const response = await fetch(`${base}/api/admin/packs/streak/remove`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: data.userId, pool: data.pool }),
    });
    const body = await response.json() as LiveStreakRemoveResult & { error?: unknown };
    if (!response.ok) {
      throw new Error(response.status === 404 ? "That account has no streak in this pool." : `Server ${response.status}`);
    }
    return body;
  });

export interface LiveSharedPackCard {
  owner: { userId: number; username: string };
  card: {
    userId: number;
    username: string;
    avatarUrl: string;
    countryCode: string;
    tier: string | null;
    tierLabel: string | null;
    /* Badge text this one holding was given, printed on the card art in place
       of the tier's name. Null for every ordinary card. */
    customLabel: string | null;
    /* And the image it floats in its background in place of the tier's own
       pattern, for the same reason: a shared card has to look like the card
       its owner holds. Null for every ordinary card. */
    motif: CardMotif | null;
    skills: unknown | null;
    pp: number;
    globalRank: number;
    copies: number;
    firstPulledAt: number;
  };
  owners: number;
  /* Mint order: #1 is whoever pulled this card first, anywhere. Null for a
     pull the log never saw (anonymous wallets, and anything from before the
     serial registry existed). mintedTotal is the denominator, counting owners
     who have since recycled the card away. */
  /* Absent on a backend older than the serial registry, so read defensively
     rather than trusting the field to be there. */
  serial: number | null;
  mintedTotal: number;
  /* The exact recent event requested by a live-feed link. Optional so the
     frontend remains compatible while the backend rolls out; null for plain
     durable collection links and for an event that has aged out. */
  pullEvent?: { id: number; pulledAt: number; isNew: boolean } | null;
  /* Set only when the pull log recorded this card arriving at the GOAT tier.
     Null for a card pulled out of the ranked pool before the player joined the
     honorary roster, and for pulls older than the log. */
  goatPull: { packType: string; pulledAt: number } | null;
}

/* One owned card as a shareable artifact: backs the /pull/{owner}/{card}
   permalink page. A live-feed link includes pullId so a duplicate uses that
   event's date instead of the holding's first date. Throws on 404 when the
   card was recycled away or never synced. */
export async function fetchLivePackSharedCard(
  ownerId: number,
  cardId: number,
  pullId?: number,
): Promise<LiveSharedPackCard> {
  const normalizedPullId = Math.floor(Number(pullId) || 0);
  const query = normalizedPullId > 0 ? `?pull=${normalizedPullId}` : "";
  return fetchLiveJson(`/api/packs/pulled-card/${Math.floor(ownerId)}/${Math.floor(cardId)}${query}`);
}

/* The public pull feed: notable-only by default (high mints and first-ever
   pulls); includeAll pulls in everything for the ambient live ticker. */
export async function fetchLivePackRecentPulls(
  limit = 20,
  options?: { includeAll?: boolean },
): Promise<LivePackPullFeedEntry[]> {
  const query = `limit=${Math.max(1, Math.floor(limit))}${options?.includeAll ? "&all=1" : ""}`;
  const body = await fetchLiveJson<{ pulls?: LivePackPullFeedEntry[] }>(`/api/packs/recent-pulls?${query}`);
  return Array.isArray(body.pulls) ? body.pulls : [];
}

/** Per-replay presence stream for the viewer's ingame-style "Spectators (N)"
 *  counter. `key` is `score:<id>` or `upload:<id>`; the stream emits `count`
 *  events, anonymous unless a watcher opted into being named. `observe`
 *  receives them without registering as a watcher (the admin ignoring
 *  themselves). `identity` is a signed ticket from `getReplaySpectatorTicket`
 *  and is only sent for viewers who turned the setting on. */
export function openReplayPresenceEventSource(
  key: string,
  options?: { observe?: boolean; identity?: ReplaySpectatorTicket | null },
): EventSource | null {
  const base = getLiveBackendUrl();
  if (!base || typeof EventSource === "undefined") return null;
  const query = new URLSearchParams({ key });
  if (options?.observe) query.set("observe", "1");
  const identity = options?.identity;
  if (identity) {
    query.set("uid", String(identity.userId));
    query.set("name", identity.username);
    query.set("exp", String(identity.expiresAt));
    query.set("sig", identity.signature);
  }
  return new EventSource(`${base}/api/replay/presence?${query.toString()}`);
}

const AVATAR_LIVE_EVENT_NAMES: LiveEventName[] = ["tracker_score", "score_gain", "top_play", "snipe"];

const liveEventSourcePool = new SharedEventSourcePool((url) => {
  // One live connection per browser, not per tab: tabs elect a leader via Web
  // Locks and the rest receive the stream over a BroadcastChannel, so a pile
  // of open tabs holds a single slot of the backend's per-IP SSE budget.
  let source: PoolableEventSource | null = null;
  if (supportsCrossTabEventSource()) {
    try {
      source = new CrossTabEventSource(url, LIVE_EVENT_NAMES);
    } catch {
      // Locked-down contexts (sandboxed iframes, strict privacy modes) can
      // refuse channel or lock construction; a per-tab connection still works.
    }
  }
  if (!source) source = new EventSource(url);
  const harvest = (event: Event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string" || !data.includes("avatar")) return;
    try {
      harvestAvatarAccents(JSON.parse(data));
    } catch {
      // Not JSON or malformed: the consumer decides how to handle it.
    }
  };
  // Attached on the local fan-out (not the physical EventSource) so follower
  // tabs harvest accents from relayed events too.
  for (const type of AVATAR_LIVE_EVENT_NAMES) source.addEventListener(type, harvest);
  return source;
});

export function openLiveEventSource(country: string, options?: { observe?: boolean }): SharedEventSource | null {
  const base = getLiveBackendUrl();
  if (!base || typeof EventSource === "undefined") return null;
  const query = new URLSearchParams({ country: country.trim().toUpperCase() });
  if (options?.observe) query.set("observe", "1");
  return liveEventSourcePool.open(`${base}/api/live?${query.toString()}`);
}

async function fetchLiveJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const response = await fetch(`${base}${path}`, { credentials: "omit", ...init });
  // Same "Server <status>" message as the plain Error this used to throw, but
  // carrying the status and a 429's retry-after so callers like the pack draw
  // can tell a rate-limited request from a broken backend.
  if (!response.ok) throw new LiveBackendRequestError(response.status, retryAfterMs(response));
  const payload = await response.json();
  // Snapshot payloads carry avatar accents next to avatar URLs; feed them to the accent store so
  // player names and their colors land in the same commit.
  harvestAvatarAccents(payload);
  return payload as T;
}

// ---------------------------------------------------------------------------
// Discord command showcase (real-data backing for the /discord preview page)
// ---------------------------------------------------------------------------
// These mirror live-backend/src/discord/showcase.ts. The payload is
// presentation-ready (numbers + formatted strings) so the showcase renders it
// directly, and every section is nullable: a missing one falls back to the
// page's synthetic mock rather than breaking the preview.

export interface DiscordShowcaseScoreHits {
  max: number;
  n300: number;
  n200: number;
  n100: number;
  n50: number;
  miss: number;
}

export interface DiscordShowcaseScore {
  grade: string;
  title: string;
  version: string;
  keys: string;
  mods: string[];
  acc: string;
  pp: string;
  gain?: string;
  combo?: string;
  score?: string;
  stars?: string;
  hits?: DiscordShowcaseScoreHits;
  cover?: string;
}

export interface DiscordShowcaseSnipe {
  sniper: string;
  sniperId: number;
  victim: string;
  fromRank: number | null;
  title: string;
  grade: string;
  mods: string[];
  acc: string;
  pp: string;
  score: string;
  victimScore: string | null;
  keys: string;
  stars: string;
  cover: string | null;
}

export interface DiscordShowcasePlayer {
  id: number;
  username: string;
  countryCode: string;
  globalRank: number | null;
  countryRank: number | null;
  pp: number | null;
  accuracy: number | null;
  playCount: number | null;
  level: number | null;
  ssCount?: number | null;
  sCount?: number | null;
  aCount?: number | null;
  topMod?: string | null;
}

export interface DiscordShowcaseRankRow {
  rank: number;
  username: string;
  userId: number;
  countryCode: string;
  pp: string;
}

export interface DiscordShowcaseTopRow {
  username: string;
  userId: number;
  grade: string;
  title: string;
  mods: string[];
  pp: string;
  gain?: string;
}

export interface DiscordShowcaseTrackerRow {
  grade: string;
  username: string;
  userId: number;
  title: string;
  mods: string[];
  acc: string;
  pp: string;
}

export interface DiscordShowcaseFarmedRow {
  rank: number;
  title: string;
  stars: string;
  avg: string;
  players: string;
}

export interface DiscordShowcaseMe {
  globalRank: number | null;
  countryRank: number | null;
  countryCode: string;
  pp: number | null;
  activeDays: number;
  sessions: number;
  topPlayCount: number;
  biggestDay: string | null;
  longestStreak: string | null;
  ppGained: string | null;
  goalsLine: string;
}

export interface DiscordShowcaseActivity {
  activeDays: number;
  totalPlays: number;
  sessions: number;
  playsPerSession: number;
  currentStreak: number;
  year: number;
  patterns: Array<{ label: string; pct: number }>;
}

export interface DiscordShowcaseVsRow {
  label: string;
  a: string;
  b: string;
}

export interface DiscordShowcaseBeatmap {
  title: string;
  stars: string;
  keys: string;
  status: string;
  bpm: string;
  length: string;
  dan: string;
  cover: string | null;
}

export interface DiscordShowcaseRandomFarm {
  title: string;
  stars: string;
  keys: string;
  bpm: string;
  status: string;
  avgPp: string;
  maxPp: string;
  players: number;
  dominantMod: string | null;
  cover: string | null;
}

export interface DiscordShowcaseRandomFav {
  title: string;
  stars: string;
  keys: string;
  status: string;
  bpm: string;
  globalFavs: string;
  patterns: string;
  pickedBy: string;
  others: number;
  cover: string | null;
}

export interface DiscordShowcase {
  country: string;
  isGlobal: boolean;
  generatedAt: number;
  // Distinct top players, one per player-centric command (see the backend's
  // index assignment in live-backend/src/discord/showcase.ts).
  players: DiscordShowcasePlayer[];
  topPlays: DiscordShowcaseScore[];
  recent: DiscordShowcaseScore[];
  pb: (DiscordShowcaseScore & { mapTitle: string; combo: string }) | null;
  me: DiscordShowcaseMe | null;
  activity: DiscordShowcaseActivity | null;
  vs: { title: string; rows: DiscordShowcaseVsRow[]; gap: string | null } | null;
  rankings: DiscordShowcaseRankRow[];
  topList: DiscordShowcaseTopRow[];
  tracker: DiscordShowcaseTrackerRow[];
  mapsFarmed: DiscordShowcaseFarmedRow[];
  randomFarm: DiscordShowcaseRandomFarm | null;
  randomFav: DiscordShowcaseRandomFav | null;
  map: DiscordShowcaseBeatmap | null;
  dan: { displayName: string; family: string; confidence: string; label: string; familyKey: string } | null;
  feedTopPlay:
    | {
      username: string;
      userId: number;
      title: string;
      grade: string;
      mods: string[];
      keys: string;
      acc: string;
      pp: string;
      gain: string;
      combo: string | null;
      score: string | null;
      stars: string | null;
      hits: DiscordShowcaseScoreHits | null;
      cover: string | null;
    }
    | null;
  feedSnipe: DiscordShowcaseSnipe | null;
  feedNewMap: { title: string; keys: string; stars: string; cover: string | null } | null;
}

export async function fetchDiscordShowcase(
  country: string,
  options?: { fresh?: boolean },
): Promise<DiscordShowcase> {
  const query = new URLSearchParams({ country: country.trim().toUpperCase() });
  if (options?.fresh) query.set("fresh", "1");
  return fetchLiveJson<DiscordShowcase>(`/api/discord/showcase?${query.toString()}`);
}
