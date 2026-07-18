// Server-only: fetch wrapper for osu! API v2 (proxied through the live backend, which owns the
// token bucket) plus a per-instance in-memory response cache. Cross-instance caching deliberately
// does NOT live here anymore: osu! responses are cached inside the backend proxy (opt-in per call
// via cacheTtlMs/staleMs on osuFetch), heavy artifacts live in R2, so this module only keeps the
// short-lived memory tier and in-flight deduplication. The get/set/lock helper signatures survive
// from the old persistent-store era so their many callers stay untouched.
import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { trackServerEvent } from "./server-track";

const LIVE_BACKEND_OSU_TIMEOUT_MS = 120_000;
const BEATMAP_FILE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

// Simple response cache (5 min TTL)
const responseCache = new Map<string, { value: unknown; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_RESPONSE_CACHE_ENTRIES = 1000;
const warnedCacheIssues = new Set<string>();

export type CacheLookup<T> =
  | { hit: true; value: T }
  | { hit: false };

export type StaleCacheLookup<T> =
  | { hit: true; value: T; isStale: boolean; updatedAt?: number }
  | { hit: false };

function warnCacheIssue(action: string, key: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const warningKey = `${action}:${key}:${message}`;
  if (warnedCacheIssues.has(warningKey)) return;
  warnedCacheIssues.add(warningKey);
  console.warn(`[cache] ${action} failed for "${key}": ${message}`);
}

function makeLockOwner(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function setMemoryCache(key: string, value: unknown, expires: number): void {
  responseCache.delete(key);
  responseCache.set(key, { value, expires });

  const now = Date.now();
  for (const [entryKey, entry] of responseCache) {
    if (entry.expires <= now) responseCache.delete(entryKey);
  }

  while (responseCache.size > MAX_RESPONSE_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey === undefined) break;
    responseCache.delete(oldestKey);
  }
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function getCachedEntry<T>(key: string): CacheLookup<T> {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expires) {
    responseCache.delete(key);
    responseCache.set(key, entry);
    return { hit: true, value: entry.value as T };
  }
  if (entry) responseCache.delete(key);
  return { hit: false };
}

export function getCached<T>(key: string): T | null {
  const entry = getCachedEntry<T>(key);
  return entry.hit ? entry.value : null;
}

export function setCache(key: string, data: unknown, ttlMs = CACHE_TTL): void {
  setMemoryCache(key, data, Date.now() + ttlMs);
}

// ── "Persistent" cache helpers - now a memory tier only ──
// These kept their historical names and signatures because dozens of call sites use them, but the
// backing store is gone: cross-instance caching of osu! data happens inside the backend proxy
// (osuFetch cacheTtlMs/staleMs), and heavy artifacts (parsed replays, community .osu files) live in
// R2. What remains here is the per-instance fast path.

export async function getPersistentCacheEntry<T>(key: string): Promise<CacheLookup<T>> {
  return getCachedEntry<T>(key);
}

export async function getPersistentCacheEntries<T>(keys: string[]): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  for (const key of keys) {
    const mem = getCachedEntry<T>(key);
    if (mem.hit) results.set(key, mem.value);
  }
  return results;
}

export async function getPersistentCached<T>(key: string): Promise<T | null> {
  return getCached<T>(key);
}

export async function getPersistentCacheEntryAllowStale<T>(
  key: string,
): Promise<StaleCacheLookup<T>> {
  // Memory entries are dropped at expiry, so a hit is never stale. Stale serving for osu! data
  // moved into the proxy (staleMs hint: it serves an expired row when the upstream call fails).
  const memoryCached = getCachedEntry<T>(key);
  if (memoryCached.hit) return { hit: true, value: memoryCached.value, isStale: false };
  return { hit: false };
}

export async function setPersistentCache(key: string, data: unknown, ttlMs = CACHE_TTL): Promise<void> {
  setMemoryCache(key, data, Date.now() + ttlMs);
}

// ── Herd control - per-instance in-flight deduplication ──
// The old distributed lock table is gone. Within one server instance, concurrent same-key builds
// collapse onto one promise here; across instances, the herd is absorbed one layer down (the osu!
// proxy dedupes identical upstream fetches in-process on the backend, which is the resource that
// actually needed protecting). Lock acquire/release keep their signatures as free passes for the
// few call sites that use them directly.

const DEFAULT_LOCK_TTL = 15_000;
const inFlightBuilds = new Map<string, Promise<unknown>>();

async function dedupedBuild<T>(cacheKey: string, build: () => Promise<T>): Promise<T> {
  const existing = inFlightBuilds.get(cacheKey);
  if (existing) return existing as Promise<T>;
  const attempt = build();
  inFlightBuilds.set(cacheKey, attempt);
  try {
    return await attempt;
  } finally {
    if (inFlightBuilds.get(cacheKey) === attempt) inFlightBuilds.delete(cacheKey);
  }
}

export async function acquireCacheLock(_key: string, _lockTtlMs: number): Promise<string | null> {
  return makeLockOwner();
}

export async function releaseCacheLock(_key: string, _owner: string | null): Promise<void> {}

export async function runWithCacheLockRenewal<T>(
  _key: string,
  _owner: string,
  _lockTtlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}

export async function fetchWithCacheLock<T>(
  cacheKey: string,
  cacheTtlMs: number,
  fetchFn: () => Promise<T>,
  _lockTtlMs: number = DEFAULT_LOCK_TTL,
  _options: {
    waitMs?: number;
    waitRetries?: number;
    runWithoutLockOnTimeout?: boolean;
  } = {},
): Promise<T> {
  const cached = getCached<T>(cacheKey);
  if (cached) return cached;

  return dedupedBuild(cacheKey, async () => {
    const rechecked = getCached<T>(cacheKey);
    if (rechecked) return rechecked;
    const result = await fetchFn();
    setCache(cacheKey, result, cacheTtlMs);
    return result;
  });
}

export async function refreshCacheInBackground<T>(
  cacheKey: string,
  cacheTtlMs: number,
  fetchFn: () => Promise<T>,
  _lockTtlMs: number = DEFAULT_LOCK_TTL,
): Promise<void> {
  try {
    await dedupedBuild(`${cacheKey}:refresh`, async () => {
      const result = await fetchFn();
      setCache(cacheKey, result, cacheTtlMs);
      return result;
    });
  } catch (error) {
    warnCacheIssue("background refresh", cacheKey, error);
  }
}

async function clearServerCachesInternal(): Promise<void> {
  responseCache.clear();
  warnedCacheIssues.clear();
}

export const clearDevServerCaches = createServerFn({ method: "POST" })
  .handler(async () => {
    await requireAdminAccess("Server cache clearing");
    await clearServerCachesInternal();
    return { ok: true };
  });

// ── osu! API rate-limit snapshot for server error telemetry ──
// State is stashed on globalThis so that all server module contexts (SSR
// loaders, route handlers, and extracted server-function bundles) share it.
// TanStack Start / Vinxi can end up with multiple module instances of this
// file in dev, which caused the state to appear empty to the reader fn.
const RATE_WINDOW_MS = 60_000;
const MAX_RECENT_CALLS = 200;

type RecentOsuCall = {
  ts: number;
  path: string;
  caller: string;
  status: number;
};

type OsuRateState = {
  recentCalls: RecentOsuCall[];
  lastRateLimit: { remaining: number; limit: number; at: number } | null;
};

function getOsuRateState(): OsuRateState {
  const g = globalThis as unknown as { __maniaHubOsuRate?: OsuRateState };
  if (!g.__maniaHubOsuRate) {
    g.__maniaHubOsuRate = { recentCalls: [], lastRateLimit: null };
  }
  return g.__maniaHubOsuRate;
}

function recordOsuCall(res: Response, path: string, caller: string): void {
  const state = getOsuRateState();
  const now = Date.now();
  state.recentCalls.push({ ts: now, path, caller, status: res.status });
  if (state.recentCalls.length > MAX_RECENT_CALLS) {
    state.recentCalls.splice(0, state.recentCalls.length - MAX_RECENT_CALLS);
  }

  const remaining = res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("x-ratelimit-limit");
  if (remaining != null && limit != null) {
    const remainingNum = Number(remaining);
    const limitNum = Number(limit);
    if (Number.isFinite(remainingNum) && Number.isFinite(limitNum)) {
      state.lastRateLimit = { remaining: remainingNum, limit: limitNum, at: now };
    }
  }
}

export type OsuFetchContextValue = string | number | boolean | null | undefined;
export type OsuFetchOptions = {
  caller?: string;
  context?: Record<string, OsuFetchContextValue>;
  // Opt-in cross-instance caching, executed inside the backend proxy (which owns the osu! token
  // bucket): cacheTtlMs caches the JSON response for that long; staleMs additionally lets the proxy
  // serve the expired response when the upstream call fails (profile surfaces ride out osu! outages
  // this way). GET-JSON requests only.
  cacheTtlMs?: number;
  staleMs?: number;
  // Statuses that are normal caller outcomes rather than API problems (404 for
  // a deleted score or restricted user): still thrown, but not reported to
  // analytics as osu_api_error.
  expectedStatuses?: number[];
};

export type BeatmapFileSource = "osu" | "catboy" | "archive";
type BeatmapFileCacheValue = {
  content: string;
  source: BeatmapFileSource;
  cachedAt: number;
};
export type BeatmapFileResult = BeatmapFileCacheValue & {
  cacheStatus: "hit" | "miss";
};

// Truncate API error response bodies before they hit logs / analytics. osu!
// errors are usually compact JSON, but rate-limit HTML pages or stack traces
// can be huge — cap them so the dashboard stays readable.
function truncateErrorBody(text: string, max = 240): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function getOsuRateSnapshot(): {
  perMin: number;
  remaining: number | null;
  limit: number | null;
  updatedAgoMs: number | null;
} {
  const state = getOsuRateState();
  const now = Date.now();
  const windowCutoff = now - RATE_WINDOW_MS;
  let perMin = 0;
  for (const c of state.recentCalls) {
    if (c.ts >= windowCutoff) perMin += 1;
  }
  return {
    perMin,
    remaining: state.lastRateLimit?.remaining ?? null,
    limit: state.lastRateLimit?.limit ?? null,
    updatedAgoMs: state.lastRateLimit ? now - state.lastRateLimit.at : null,
  };
}

function cleanOsuFetchContext(
  context: Record<string, OsuFetchContextValue> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!context) return undefined;
  const entries = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .slice(0, 16)
    .map(([key, value]) => [key, value ?? null] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export async function osuFetch<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>,
  options?: OsuFetchOptions,
): Promise<T> {
  const caller = options?.caller ?? "unknown";
  const context = cleanOsuFetchContext(options?.context);
  const requestPath = pathWithParams(path, params);
  const response = await fetchLiveBackendOsu(path, params, caller, "json", options);
  recordOsuCall(response, requestPath, caller);
  if (response.ok) return response.json() as Promise<T>;
  return await throwLiveBackendOsuError(response, caller, requestPath, "json", context, options?.expectedStatuses);
}

export async function osuFetchBinary(
  path: string,
  options?: OsuFetchOptions,
): Promise<ArrayBuffer> {
  const caller = options?.caller ?? "unknown";
  const context = cleanOsuFetchContext(options?.context);
  const response = await fetchLiveBackendOsu(path, undefined, caller, "binary");
  recordOsuCall(response, path, caller);
  if (response.ok) return response.arrayBuffer();
  return await throwLiveBackendOsuError(response, caller, path, "binary", context, options?.expectedStatuses);
}

export async function fetchBeatmapFileWithMeta(beatmapId: number, beatmapsetId?: number | null): Promise<BeatmapFileResult> {
  const cacheKey = `beatmap-file:v1:${beatmapId}`;
  const cached = await getPersistentCacheEntry<BeatmapFileCacheValue>(cacheKey);
  if (cached.hit && cached.value.content.trim()) {
    return { ...cached.value, cacheStatus: "hit" };
  }

  const errors: string[] = [];
  try {
    const osuFile = await fetchLiveBackendBeatmapFile(beatmapId, "fetchBeatmapFile");
    const result = {
      content: osuFile,
      source: "osu",
      cachedAt: Date.now(),
    } satisfies BeatmapFileCacheValue;
    await setPersistentCache(cacheKey, result, BEATMAP_FILE_CACHE_TTL);
    return { ...result, cacheStatus: "miss" };
  } catch (error) {
    errors.push(`server (${error instanceof Error ? error.message : String(error)})`);
  }

  if (beatmapsetId) {
    try {
      const { extractBeatmapArchiveOsuFile } = await import("./beatmap-archive");
      const archiveFile = await extractBeatmapArchiveOsuFile(String(beatmapsetId), beatmapId);
      if (!isLikelyBeatmapFile(archiveFile)) {
        throw new Error("archive returned an invalid .osu file");
      }
      const result = {
        content: archiveFile,
        source: "archive",
        cachedAt: Date.now(),
      } satisfies BeatmapFileCacheValue;
      await setPersistentCache(cacheKey, result, BEATMAP_FILE_CACHE_TTL);
      return { ...result, cacheStatus: "miss" };
    } catch (archiveError) {
      errors.push(`archive (${archiveError instanceof Error ? archiveError.message : String(archiveError)})`);
    }
  }

  throw new Error(`Failed to fetch .osu file for beatmap ${beatmapId}: ${errors.join("; ")}`);
}

export async function fetchBeatmapFile(beatmapId: number, beatmapsetId?: number | null): Promise<string> {
  return (await fetchBeatmapFileWithMeta(beatmapId, beatmapsetId)).content;
}

function isLikelyBeatmapFile(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("osu file format") && content.includes("[HitObjects]");
}

function getServerLiveBackendUrl(): string {
  const value = process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("LIVE_BACKEND_URL is required for osu! API calls.");
  }
  return value.replace(/\/+$/, "");
}

function liveBackendHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) {
    headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  }
  return headers;
}

function pathWithParams(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return path;
  const url = new URL(path, "https://osu.ppy.sh");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

async function fetchLiveBackendOsu(
  path: string,
  params: Record<string, string | number | undefined> | undefined,
  caller: string,
  kind: "json" | "binary",
  cache?: { cacheTtlMs?: number; staleMs?: number },
): Promise<Response> {
  const base = getServerLiveBackendUrl();
  return fetchWithTimeout(
    `${base}/api/osu/v2`,
    {
      method: "POST",
      headers: liveBackendHeaders(),
      body: JSON.stringify({
        path,
        params,
        caller,
        kind,
        ...(cache?.cacheTtlMs ? { cacheTtlMs: cache.cacheTtlMs, staleMs: cache.staleMs } : {}),
      }),
    },
    LIVE_BACKEND_OSU_TIMEOUT_MS,
  );
}

async function fetchLiveBackendBeatmapFile(beatmapId: number, caller: string): Promise<string> {
  const base = getServerLiveBackendUrl();
  const url = new URL(`${base}/api/osu/beatmap-file`);
  url.searchParams.set("beatmapId", String(beatmapId));
  url.searchParams.set("caller", caller);
  const response = await fetchWithTimeout(
    url,
    { headers: liveBackendHeaders() },
    LIVE_BACKEND_OSU_TIMEOUT_MS,
  );
  recordOsuCall(response, `/osu/${beatmapId}`, caller);
  if (!response.ok) {
    await throwLiveBackendOsuError(response, caller, `/osu/${beatmapId}`, "beatmap-file");
  }
  const text = await response.text();
  if (!isLikelyBeatmapFile(text)) throw new Error("Server returned an invalid .osu file");
  return text;
}

async function throwLiveBackendOsuError(
  response: Response,
  caller: string,
  path: string,
  kind: "json" | "binary" | "beatmap-file",
  context?: Record<string, string | number | boolean | null>,
  expectedStatuses?: number[],
): Promise<never> {
  const text = await response.text().catch(() => "");
  const bodyPreview = truncateErrorBody(text);
  const rate = getOsuRateSnapshot();
  if (expectedStatuses?.includes(response.status)) {
    throw new Error(
      `[liveBackendOsu:${caller}] ${response.status} ${path} - ${bodyPreview || "<empty body>"}`,
    );
  }
  trackServerEvent("osu_api_error", {
    caller,
    path,
    status: response.status,
    attempts: 1,
    kind,
    body_preview: bodyPreview,
    context,
    rate_per_min: rate.perMin,
    rate_remaining: rate.remaining,
    rate_limit: rate.limit,
    rate_updated_ago_ms: rate.updatedAgoMs,
    retry_after: response.headers.get("retry-after"),
  });
  throw new Error(
    `[liveBackendOsu:${caller}] ${response.status} ${path} - ${bodyPreview || "<empty body>"}`,
  );
}
