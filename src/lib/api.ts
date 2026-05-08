// Server-only: OAuth token management + fetch wrapper for osu! API v2
import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess, requireDevFeatureAccess } from "./auth";
import { db, ensureCacheSchema, hasDb } from "./db";
import { trackServerEvent } from "./server-track";

// Lazy zlib loader. Using a dynamic import keeps `node:zlib` out of the client
// module graph, because this file is transitively imported client-side via
// `clearDevServerCaches` in Nav.tsx. A top-level `import "node:zlib"` would
// otherwise be externalized by Vite and crash the browser at runtime.
type ZlibAsync = {
  gzipAsync: (buf: Buffer) => Promise<Buffer>;
  gunzipAsync: (buf: Buffer) => Promise<Buffer>;
};
let zlibPromise: Promise<ZlibAsync> | null = null;
function getZlib(): Promise<ZlibAsync> {
  if (!zlibPromise) {
    zlibPromise = (async () => {
      // Keep Node built-ins invisible to Vite's client resolver; this path only
      // runs on the server when persistent cache compression is used.
      const importNodeModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      const [zlib, util] = await Promise.all([
        importNodeModule("node:zlib"),
        importNodeModule("node:util"),
      ]);
      return {
        gzipAsync: util.promisify(zlib.gzip) as (buf: Buffer) => Promise<Buffer>,
        gunzipAsync: util.promisify(zlib.gunzip) as (buf: Buffer) => Promise<Buffer>,
      };
    })().catch((error) => {
      zlibPromise = null;
      throw error;
    });
  }
  return zlibPromise;
}

let tokenCache: { access_token: string; expires_at: number } | null = null;
const OSU_FETCH_RETRIES = 2;
const OAUTH_FETCH_TIMEOUT_MS = 10_000;
const OSU_FETCH_TIMEOUT_MS = 15_000;
const BEATMAP_FILE_FETCH_TIMEOUT_MS = 15_000;
const BEATMAP_FILE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

// Simple response cache (5 min TTL)
const responseCache = new Map<string, { value: unknown; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_RESPONSE_CACHE_ENTRIES = 1000;
const CACHE_ENVELOPE_MARKER = "__mania_hub_cache_v1";
// Anything above this gets gzipped before storage. Below it, gzip header
// overhead dominates and compression would hurt more than help.
const CACHE_COMPRESS_THRESHOLD_BYTES = 4096;
const warnedCacheIssues = new Set<string>();

// Opportunistic auto-purge of expired rows. Every Nth successful write fires
// a background DELETE of up to M expired rows. Keeps the table bounded without
// scheduled jobs or new infrastructure.
const CACHE_PURGE_EVERY_N_WRITES = 20;
const CACHE_PURGE_BATCH_SIZE = 50;
let writesSinceLastPurge = 0;

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

function getCacheKeyPrefix(key: string): string {
  const separatorIndex = key.indexOf(":");
  return separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
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

async function encodeCacheValue(data: unknown): Promise<string> {
  const json = JSON.stringify({
    [CACHE_ENVELOPE_MARKER]: true,
    value: data,
  });
  if (json.length < CACHE_COMPRESS_THRESHOLD_BYTES) {
    return `P:${json}`;
  }
  // Defensive: encode/decode should only run server-side. If a client build
  // somehow calls this, Buffer + dynamic node: imports would throw, so we
  // bail to plain encoding.
  if (typeof window !== "undefined") {
    return `P:${json}`;
  }
  try {
    const { gzipAsync } = await getZlib();
    const compressed = await gzipAsync(Buffer.from(json, "utf8"));
    return `Z:${compressed.toString("base64")}`;
  } catch {
    return `P:${json}`;
  }
}

async function decodeCacheValue(raw: string): Promise<unknown> {
  let json: string;
  if (raw.startsWith("Z:")) {
    if (typeof window !== "undefined") {
      throw new Error("cannot decode compressed cache value in client context");
    }
    const { gunzipAsync } = await getZlib();
    const compressed = Buffer.from(raw.slice(2), "base64");
    const decompressed = await gunzipAsync(compressed);
    json = decompressed.toString("utf8");
  } else if (raw.startsWith("P:")) {
    json = raw.slice(2);
  } else {
    // Legacy entries written before the P:/Z: prefix format existed.
    json = raw;
  }

  const parsed = JSON.parse(json) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    CACHE_ENVELOPE_MARKER in parsed &&
    "value" in parsed
  ) {
    return (parsed as { value: unknown }).value;
  }

  return parsed;
}

async function purgeExpiredCacheEntries(): Promise<void> {
  if (!hasDb() || !db) return;
  try {
    await db.execute({
      sql: `
        DELETE FROM cache_entries
        WHERE cache_key IN (
          SELECT cache_key FROM cache_entries
          WHERE expires_at < ?
          LIMIT ?
        )
      `,
      args: [Date.now(), CACHE_PURGE_BATCH_SIZE],
    });
  } catch (error) {
    warnCacheIssue("auto-purge expired", "cache_entries", error);
  }
}

function scheduleOpportunisticPurge(): void {
  writesSinceLastPurge += 1;
  if (writesSinceLastPurge < CACHE_PURGE_EVERY_N_WRITES) return;
  writesSinceLastPurge = 0;
  purgeExpiredCacheEntries().catch(() => {});
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

export async function getPersistentCacheEntry<T>(key: string): Promise<CacheLookup<T>> {
  const memoryCached = getCachedEntry<T>(key);
  if (memoryCached.hit) return memoryCached;
  if (!hasDb() || !db) return { hit: false };

  try {
    await ensureCacheSchema();

    const result = await db.execute({
      sql: `
        SELECT cache_value, expires_at
        FROM cache_entries
        WHERE cache_key = ?
        LIMIT 1
      `,
      args: [key],
    });

    const row = result.rows[0];
    if (!row) return { hit: false };

    const expiresAt = Number(row.expires_at);
    if (Date.now() >= expiresAt) {
      try {
        await db.execute({
          sql: `DELETE FROM cache_entries WHERE cache_key = ?`,
          args: [key],
        });
      } catch (error) {
        warnCacheIssue("delete expired entry", key, error);
      }
      return { hit: false };
    }

    const parsed = (await decodeCacheValue(String(row.cache_value))) as T;
    setMemoryCache(key, parsed, expiresAt);
    return { hit: true, value: parsed };
  } catch (error) {
    warnCacheIssue("persistent read", key, error);
    return { hit: false };
  }
}

export async function getPersistentCacheEntries<T>(keys: string[]): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  if (keys.length === 0) return results;

  const dbKeys: string[] = [];
  for (const key of keys) {
    const mem = getCachedEntry<T>(key);
    if (mem.hit) {
      results.set(key, mem.value);
    } else {
      dbKeys.push(key);
    }
  }

  if (dbKeys.length === 0 || !hasDb() || !db) return results;

  try {
    await ensureCacheSchema();

    const placeholders = dbKeys.map(() => "?").join(",");
    const result = await db.execute({
      sql: `SELECT cache_key, cache_value, expires_at FROM cache_entries WHERE cache_key IN (${placeholders})`,
      args: dbKeys,
    });

    const now = Date.now();
    for (const row of result.rows) {
      const key = String(row.cache_key);
      const expiresAt = Number(row.expires_at);
      if (now >= expiresAt) continue;

      try {
        const parsed = (await decodeCacheValue(String(row.cache_value))) as T;
        setMemoryCache(key, parsed, expiresAt);
        results.set(key, parsed);
      } catch (error) {
        warnCacheIssue("batch decode", key, error);
      }
    }
  } catch (error) {
    warnCacheIssue("persistent batch read", `${dbKeys.length} keys`, error);
  }

  return results;
}

export async function getPersistentCached<T>(key: string): Promise<T | null> {
  const cached = await getPersistentCacheEntry<T>(key);
  return cached.hit ? cached.value : null;
}

export async function getPersistentCacheEntryAllowStale<T>(
  key: string,
): Promise<StaleCacheLookup<T>> {
  const memoryCached = getCachedEntry<T>(key);
  if (memoryCached.hit) return { hit: true, value: memoryCached.value, isStale: false };
  if (!hasDb() || !db) return { hit: false };

  try {
    await ensureCacheSchema();

    const result = await db.execute({
      sql: `
        SELECT cache_value, expires_at, updated_at
        FROM cache_entries
        WHERE cache_key = ?
        LIMIT 1
      `,
      args: [key],
    });

    const row = result.rows[0];
    if (!row) return { hit: false };

    const expiresAt = Number(row.expires_at);
    const updatedAt = Number(row.updated_at);
    const parsed = (await decodeCacheValue(String(row.cache_value))) as T;
    const isStale = Date.now() >= expiresAt;

    if (!isStale) {
      setMemoryCache(key, parsed, expiresAt);
    }

    return {
      hit: true,
      value: parsed,
      isStale,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
    };
  } catch (error) {
    warnCacheIssue("persistent read (stale allowed)", key, error);
    return { hit: false };
  }
}

export async function setPersistentCache(key: string, data: unknown, ttlMs = CACHE_TTL): Promise<void> {
  const expiresAt = Date.now() + ttlMs;
  setMemoryCache(key, data, expiresAt);
  if (!hasDb() || !db) return;

  try {
    await ensureCacheSchema();

    const encoded = await encodeCacheValue(data);
    await db.execute({
      sql: `
        INSERT INTO cache_entries (cache_key, cache_prefix, cache_value, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          cache_prefix = excluded.cache_prefix,
          cache_value = excluded.cache_value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
      args: [key, getCacheKeyPrefix(key), encoded, expiresAt, Date.now()],
    });
    scheduleOpportunisticPurge();
  } catch (error) {
    warnCacheIssue("persistent write", key, error);
  }
}

// ── Distributed cache lock (prevents thundering herd across serverless instances) ──

const LOCK_WAIT_MS = 300;
const LOCK_WAIT_RETRIES = 5;
const DEFAULT_LOCK_TTL = 15_000;
const LOCK_PURGE_BATCH_SIZE = 250;

async function purgeExpiredCacheLocks(now: number): Promise<void> {
  if (!hasDb() || !db) return;
  try {
    await db.execute({
      sql: `
        DELETE FROM cache_locks
        WHERE lock_key IN (
          SELECT lock_key FROM cache_locks
          WHERE expires_at <= ?
          LIMIT ?
        )
      `,
      args: [now, LOCK_PURGE_BATCH_SIZE],
    });
  } catch (error) {
    warnCacheIssue("purge expired locks", "cache_locks", error);
  }
}

export async function acquireCacheLock(key: string, lockTtlMs: number): Promise<string | null> {
  if (!hasDb() || !db) return makeLockOwner();
  try {
    await ensureCacheSchema();
    const now = Date.now();
    await purgeExpiredCacheLocks(now);
    const owner = makeLockOwner();
    const results = await db.batch([
      {
        sql: "DELETE FROM cache_locks WHERE lock_key = ? AND expires_at <= ?",
        args: [key, now],
      },
      {
        sql: "INSERT INTO cache_locks (lock_key, lock_owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(lock_key) DO NOTHING",
        args: [key, owner, now + lockTtlMs],
      },
    ]);
    return (results[1].rowsAffected ?? 0) > 0 ? owner : null;
  } catch (error) {
    warnCacheIssue("acquire lock", key, error);
    return makeLockOwner();
  }
}

export async function releaseCacheLock(key: string, owner: string | null): Promise<void> {
  if (!hasDb() || !db) return;
  if (!owner) return;
  try {
    await db.execute({
      sql: "DELETE FROM cache_locks WHERE lock_key = ? AND lock_owner = ?",
      args: [key, owner],
    });
  } catch (error) {
    warnCacheIssue("release lock", key, error);
  }
}

async function renewCacheLock(key: string, owner: string | null, lockTtlMs: number): Promise<void> {
  if (!hasDb() || !db) return;
  if (!owner) return;
  try {
    await db.execute({
      sql: "UPDATE cache_locks SET expires_at = ? WHERE lock_key = ? AND lock_owner = ?",
      args: [Date.now() + lockTtlMs, key, owner],
    });
  } catch (error) {
    warnCacheIssue("renew lock", key, error);
  }
}

export async function runWithCacheLockRenewal<T>(
  key: string,
  owner: string,
  lockTtlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  if (hasDb() && db) {
    renewalTimer = setInterval(() => {
      renewCacheLock(key, owner, lockTtlMs).catch(() => {});
    }, Math.max(1000, Math.floor(lockTtlMs / 2)));
  }
  try {
    return await fn();
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
  }
}

export async function fetchWithCacheLock<T>(
  cacheKey: string,
  cacheTtlMs: number,
  fetchFn: () => Promise<T>,
  lockTtlMs: number = DEFAULT_LOCK_TTL,
  options: {
    waitMs?: number;
    waitRetries?: number;
    runWithoutLockOnTimeout?: boolean;
  } = {},
): Promise<T> {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const waitRetries = options.waitRetries ?? LOCK_WAIT_RETRIES;
  const runWithoutLockOnTimeout = options.runWithoutLockOnTimeout ?? true;
  const cached = await getPersistentCached<T>(cacheKey);
  if (cached) return cached;

  const lockOwner = await acquireCacheLock(cacheKey, lockTtlMs);

  if (lockOwner) {
    try {
      const rechecked = await getPersistentCached<T>(cacheKey);
      if (rechecked) return rechecked;

      const result = await runWithCacheLockRenewal(cacheKey, lockOwner, lockTtlMs, fetchFn);
      await setPersistentCache(cacheKey, result, cacheTtlMs);
      return result;
    } finally {
      await releaseCacheLock(cacheKey, lockOwner);
    }
  }

  for (let i = 0; i < waitRetries; i++) {
    await sleep(waitMs);
    const cached = await getPersistentCached<T>(cacheKey);
    if (cached) return cached;
  }

  if (!runWithoutLockOnTimeout) {
    const retryLockOwner = await acquireCacheLock(cacheKey, lockTtlMs);
    if (retryLockOwner) {
      try {
        const rechecked = await getPersistentCached<T>(cacheKey);
        if (rechecked) return rechecked;

        const result = await runWithCacheLockRenewal(cacheKey, retryLockOwner, lockTtlMs, fetchFn);
        await setPersistentCache(cacheKey, result, cacheTtlMs);
        return result;
      } finally {
        await releaseCacheLock(cacheKey, retryLockOwner);
      }
    }

    throw new Error(`Timed out waiting for cache rebuild: ${cacheKey}`);
  }

  const result = await fetchFn();
  await setPersistentCache(cacheKey, result, cacheTtlMs);
  return result;
}

export async function fetchWithStaleAllowed<T>(
  cacheKey: string,
  cacheTtlMs: number,
  fetchFn: () => Promise<T>,
  lockTtlMs: number = DEFAULT_LOCK_TTL,
): Promise<{ value: T; isStale: boolean }> {
  const cached = await getPersistentCacheEntryAllowStale<T>(cacheKey);
  if (cached.hit) return { value: cached.value, isStale: cached.isStale };

  const lockOwner = await acquireCacheLock(cacheKey, lockTtlMs);

  if (lockOwner) {
    try {
      const rechecked = await getPersistentCacheEntryAllowStale<T>(cacheKey);
      if (rechecked.hit) return { value: rechecked.value, isStale: rechecked.isStale };

      const result = await fetchFn();
      await setPersistentCache(cacheKey, result, cacheTtlMs);
      return { value: result, isStale: false };
    } finally {
      await releaseCacheLock(cacheKey, lockOwner);
    }
  }

  for (let i = 0; i < LOCK_WAIT_RETRIES; i++) {
    await sleep(LOCK_WAIT_MS);
    const polled = await getPersistentCacheEntryAllowStale<T>(cacheKey);
    if (polled.hit) return { value: polled.value, isStale: polled.isStale };
  }

  const result = await fetchFn();
  await setPersistentCache(cacheKey, result, cacheTtlMs);
  return { value: result, isStale: false };
}

const REBUILD_POLL_MS = 2000;
const REBUILD_POLL_RETRIES = 20;

export async function runCacheRebuild<T>(
  cacheKey: string,
  cacheTtlMs: number,
  fetchFn: () => Promise<T>,
  lockTtlMs: number = DEFAULT_LOCK_TTL,
): Promise<{ rebuilt: boolean; value: T | null }> {
  const lockOwner = await acquireCacheLock(cacheKey, lockTtlMs);

  if (lockOwner) {
    try {
      const result = await fetchFn();
      await setPersistentCache(cacheKey, result, cacheTtlMs);
      return { rebuilt: true, value: result };
    } finally {
      await releaseCacheLock(cacheKey, lockOwner);
    }
  }

  // Another instance is already rebuilding. Wait for it to publish fresh data to Turso,
  // then return that so this caller still gets an up-to-date value.
  for (let i = 0; i < REBUILD_POLL_RETRIES; i++) {
    await sleep(REBUILD_POLL_MS);
    const polled = await getPersistentCacheEntryAllowStale<T>(cacheKey);
    if (polled.hit && !polled.isStale) {
      return { rebuilt: false, value: polled.value };
    }
  }

  return { rebuilt: false, value: null };
}

export async function deleteExpiredCacheEntriesByPrefix(
  prefix: string,
  olderThanMs: number,
): Promise<void> {
  if (!hasDb() || !db) return;
  try {
    await ensureCacheSchema();
    const threshold = Date.now() - olderThanMs;
    await db.execute({
      sql: "DELETE FROM cache_entries WHERE cache_prefix = ? AND expires_at < ?",
      args: [getCacheKeyPrefix(prefix), threshold],
    });
  } catch (error) {
    warnCacheIssue("cleanup expired entries", prefix, error);
  }
}

export async function deletePersistentCacheEntries(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (const key of keys) responseCache.delete(key);
  if (!hasDb() || !db) return;
  try {
    await ensureCacheSchema();
    const placeholders = keys.map(() => "?").join(",");
    await db.execute({
      sql: `DELETE FROM cache_entries WHERE cache_key IN (${placeholders})`,
      args: keys,
    });
  } catch (error) {
    warnCacheIssue("delete entries", keys.join(","), error);
  }
}

async function clearServerCachesInternal(): Promise<void> {
  responseCache.clear();
  warnedCacheIssues.clear();

  if (!hasDb() || !db) return;

  try {
    await ensureCacheSchema();
    await db.execute("DELETE FROM cache_entries");
  } catch (error) {
    warnCacheIssue("clear persistent cache", "cache_entries", error);
    throw error;
  }
}

export const clearDevServerCaches = createServerFn({ method: "POST" })
  .handler(async () => {
    await requireAdminAccess("Server cache clearing");
    await clearServerCachesInternal();
    return { ok: true };
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── osu! API rate-limit tracker (dev HUD) ──
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

export const getOsuRateStats = createServerFn({ method: "GET" }).handler(async () => {
  await requireDevFeatureAccess("osu! rate stats");
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
    recent: state.recentCalls.slice().reverse(),
  };
});

function getRetryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  return 500 * 2 ** attempt;
}

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires_at - 60_000) {
    return tokenCache.access_token;
  }

  const res = await fetchWithTimeout(
    "https://osu.ppy.sh/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: Number(process.env.OSU_CLIENT_ID),
        client_secret: process.env.OSU_CLIENT_SECRET,
        grant_type: "client_credentials",
        scope: "public",
      }),
    },
    OAUTH_FETCH_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.access_token;
}

export type OsuFetchContextValue = string | number | boolean | null | undefined;
export type OsuFetchOptions = {
  caller?: string;
  context?: Record<string, OsuFetchContextValue>;
};

type BeatmapFileSource = "osu" | "catboy";
type BeatmapFileCacheValue = {
  content: string;
  source: BeatmapFileSource;
  cachedAt: number;
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
  const token = await getToken();

  const url = new URL(`https://osu.ppy.sh/api/v2${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  for (let attempt = 0; attempt <= OSU_FETCH_RETRIES; attempt++) {
    const res = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-version": "20220705",
        },
      },
      OSU_FETCH_TIMEOUT_MS,
    );
    recordOsuCall(res, url.pathname.replace(/^\/api\/v2/, "") + url.search, caller);

    if (res.ok) {
      return res.json() as Promise<T>;
    }

    const shouldRetry = (res.status === 429 || res.status >= 500) && attempt < OSU_FETCH_RETRIES;
    if (shouldRetry) {
      await sleep(getRetryDelayMs(res, attempt));
      continue;
    }

    const text = await res.text().catch(() => "");
    const bodyPreview = truncateErrorBody(text);
    const rate = getOsuRateSnapshot();
    trackServerEvent("osu_api_error", {
      caller,
      path: url.pathname.replace(/^\/api\/v2/, "") + url.search,
      status: res.status,
      attempts: attempt + 1,
      kind: "json",
      body_preview: bodyPreview,
      context,
      rate_per_min: rate.perMin,
      rate_remaining: rate.remaining,
      rate_limit: rate.limit,
      rate_updated_ago_ms: rate.updatedAgoMs,
      retry_after: res.headers.get("retry-after"),
    });
    throw new Error(
      `[osuFetch:${caller}] ${res.status} ${path} — ${bodyPreview || "<empty body>"}`,
    );
  }

  // Unreachable: the loop's final iteration always throws above. Keep as a
  // typing safety net so TS knows osuFetch never returns undefined.
  throw new Error(`[osuFetch:${caller}] retries exhausted on ${path}`);
}

export async function osuFetchBinary(
  path: string,
  options?: OsuFetchOptions,
): Promise<ArrayBuffer> {
  const caller = options?.caller ?? "unknown";
  const context = cleanOsuFetchContext(options?.context);
  const token = await getToken();

  for (let attempt = 0; attempt <= OSU_FETCH_RETRIES; attempt++) {
    const res = await fetchWithTimeout(
      `https://osu.ppy.sh/api/v2${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      OSU_FETCH_TIMEOUT_MS,
    );
    recordOsuCall(res, path, caller);

    if (res.ok) {
      return res.arrayBuffer();
    }

    const shouldRetry = (res.status === 429 || res.status >= 500) && attempt < OSU_FETCH_RETRIES;
    if (shouldRetry) {
      await sleep(getRetryDelayMs(res, attempt));
      continue;
    }

    // Binary endpoints sometimes return a small text/html or text/plain
    // error page. Capture it for the dashboard so we can see *why* the
    // download failed instead of just "binary error 404".
    const text = await res.text().catch(() => "");
    const bodyPreview = truncateErrorBody(text);
    const rate = getOsuRateSnapshot();
    trackServerEvent("osu_api_error", {
      caller,
      path,
      status: res.status,
      attempts: attempt + 1,
      kind: "binary",
      body_preview: bodyPreview,
      context,
      rate_per_min: rate.perMin,
      rate_remaining: rate.remaining,
      rate_limit: rate.limit,
      rate_updated_ago_ms: rate.updatedAgoMs,
      retry_after: res.headers.get("retry-after"),
    });
    throw new Error(
      `[osuFetchBinary:${caller}] ${res.status} ${path} — ${bodyPreview || "<empty body>"}`,
    );
  }

  throw new Error(`[osuFetchBinary:${caller}] retries exhausted on ${path}`);
}

export async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const cacheKey = `beatmap-file:v1:${beatmapId}`;
  const cached = await getPersistentCached<BeatmapFileCacheValue>(cacheKey);
  if (cached?.content?.trim()) return cached.content;

  let osuError: unknown;
  try {
    const osuFile = await fetchBeatmapFileFromSource(
      "osu",
      `https://osu.ppy.sh/osu/${beatmapId}`,
    );
    await setPersistentCache(cacheKey, {
      content: osuFile,
      source: "osu",
      cachedAt: Date.now(),
    } satisfies BeatmapFileCacheValue, BEATMAP_FILE_CACHE_TTL);
    return osuFile;
  } catch (error) {
    osuError = error;
  }

  try {
    const catboyFile = await fetchBeatmapFileFromSource(
      "catboy",
      `https://catboy.best/osu/${beatmapId}`,
    );
    await setPersistentCache(cacheKey, {
      content: catboyFile,
      source: "catboy",
      cachedAt: Date.now(),
    } satisfies BeatmapFileCacheValue, BEATMAP_FILE_CACHE_TTL);
    return catboyFile;
  } catch (catboyError) {
    const osuMessage = osuError instanceof Error ? osuError.message : String(osuError);
    const catboyMessage = catboyError instanceof Error ? catboyError.message : String(catboyError);
    throw new Error(`Failed to fetch .osu file for beatmap ${beatmapId}: osu (${osuMessage}); catboy (${catboyMessage})`);
  }
}

function isLikelyBeatmapFile(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("osu file format") && content.includes("[HitObjects]");
}

async function fetchBeatmapFileFromSource(
  source: BeatmapFileSource,
  url: string,
): Promise<string> {
  const res = await fetchWithTimeout(url, undefined, BEATMAP_FILE_FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`${source} returned ${res.status}`);
  }
  const text = await res.text();
  if (!isLikelyBeatmapFile(text)) {
    throw new Error(`${source} returned an invalid .osu file`);
  }
  return text;
}
