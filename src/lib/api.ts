// Server-only: OAuth token management + fetch wrapper for osu! API v2
import { db, ensureCacheSchema, hasDb } from "./db";

let tokenCache: { access_token: string; expires_at: number } | null = null;
const OSU_FETCH_RETRIES = 2;

// Simple response cache (5 min TTL)
const responseCache = new Map<string, { value: unknown; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_ENVELOPE_MARKER = "__mania_hub_cache_v1";
const warnedCacheIssues = new Set<string>();

export type CacheLookup<T> =
  | { hit: true; value: T }
  | { hit: false };

function warnCacheIssue(action: string, key: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const warningKey = `${action}:${key}:${message}`;
  if (warnedCacheIssues.has(warningKey)) return;
  warnedCacheIssues.add(warningKey);
  console.warn(`[cache] ${action} failed for "${key}": ${message}`);
}

function encodeCacheValue(data: unknown): string {
  return JSON.stringify({
    [CACHE_ENVELOPE_MARKER]: true,
    value: data,
  });
}

function decodeCacheValue(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
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

export function getCachedEntry<T>(key: string): CacheLookup<T> {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expires) {
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
  responseCache.set(key, { value: data, expires: Date.now() + ttlMs });
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

    const parsed = decodeCacheValue(String(row.cache_value)) as T;
    responseCache.set(key, { value: parsed, expires: expiresAt });
    return { hit: true, value: parsed };
  } catch (error) {
    warnCacheIssue("persistent read", key, error);
    return { hit: false };
  }
}

export async function getPersistentCached<T>(key: string): Promise<T | null> {
  const cached = await getPersistentCacheEntry<T>(key);
  return cached.hit ? cached.value : null;
}

export async function setPersistentCache(key: string, data: unknown, ttlMs = CACHE_TTL): Promise<void> {
  const expiresAt = Date.now() + ttlMs;
  responseCache.set(key, { value: data, expires: expiresAt });
  if (!hasDb() || !db) return;

  try {
    await ensureCacheSchema();

    await db.execute({
      sql: `
        INSERT INTO cache_entries (cache_key, cache_value, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          cache_value = excluded.cache_value,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
      args: [key, encodeCacheValue(data), expiresAt, Date.now()],
    });
  } catch (error) {
    warnCacheIssue("persistent write", key, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  const res = await fetch("https://osu.ppy.sh/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: Number(process.env.OSU_CLIENT_ID),
      client_secret: process.env.OSU_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "public",
    }),
  });

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

export async function osuFetch<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const token = await getToken();

  const url = new URL(`https://osu.ppy.sh/api/v2${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  for (let attempt = 0; attempt <= OSU_FETCH_RETRIES; attempt++) {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-version": "20220705",
      },
    });

    if (res.ok) {
      return res.json() as Promise<T>;
    }

    const shouldRetry = (res.status === 429 || res.status >= 500) && attempt < OSU_FETCH_RETRIES;
    if (shouldRetry) {
      await sleep(getRetryDelayMs(res, attempt));
      continue;
    }

    const text = await res.text();
    throw new Error(`osu! API error ${res.status} on ${path}: ${text}`);
  }

  throw new Error(`osu! API error on ${path}: exhausted retries`);
}

export async function osuFetchBinary(path: string): Promise<ArrayBuffer> {
  const token = await getToken();

  for (let attempt = 0; attempt <= OSU_FETCH_RETRIES; attempt++) {
    const res = await fetch(`https://osu.ppy.sh/api/v2${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.ok) {
      return res.arrayBuffer();
    }

    const shouldRetry = (res.status === 429 || res.status >= 500) && attempt < OSU_FETCH_RETRIES;
    if (shouldRetry) {
      await sleep(getRetryDelayMs(res, attempt));
      continue;
    }

    throw new Error(`osu! API binary error ${res.status} on ${path}`);
  }

  throw new Error(`osu! API binary error on ${path}: exhausted retries`);
}

export async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const res = await fetch(`https://osu.ppy.sh/osu/${beatmapId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch .osu file for beatmap ${beatmapId}`);
  }
  return res.text();
}
