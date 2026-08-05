import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { exec, isSqliteBusyError } from "../db.js";
import type { OsuApiClient } from "../osu/client.js";
import { errorContext, logWarn } from "../logger.js";

// Response cache for the /api/osu/v2 GET-JSON proxy. The osu! API budget (~45/min token bucket) is
// the scarce shared resource, and frontend instances come and go across deploys/restarts and would
// each re-fetch the same user/rankings data - so the cross-instance cache lives here, next to the
// token bucket, instead of in a frontend-owned store. Callers opt in per request with cacheTtlMs (and
// optionally staleMs: how long past expiry a row may still be served when the upstream call fails,
// which is how "serve a stale profile while osu! is erroring" works now).
//
// Concurrent identical requests collapse onto one upstream call via an in-process in-flight map;
// this is what the old distributed cache_locks table existed for, and a single always-on process
// does not need a lock table to achieve it.

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
// Bodies above this are not cached (served straight through). Score lists run tens of KB; this cap
// only exists so a pathological response cannot bloat the table.
const MAX_BODY_BYTES = 1024 * 1024;

export interface OsuProxyCacheHints {
  cacheTtlMs: number;
  staleMs: number;
}

export function normalizeOsuProxyCacheHints(body: { cacheTtlMs?: unknown; staleMs?: unknown }): OsuProxyCacheHints | null {
  const cacheTtlMs = Number(body.cacheTtlMs);
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) return null;
  const staleMs = Number(body.staleMs);
  return {
    cacheTtlMs: Math.min(Math.floor(cacheTtlMs), MAX_TTL_MS),
    staleMs: Number.isFinite(staleMs) && staleMs > 0 ? Math.min(Math.floor(staleMs), MAX_STALE_MS) : 0,
  };
}

function cacheKeyFor(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

interface CachedRow {
  body: string;
  expiresAt: number;
  staleUntil: number;
}

async function readRow(db: Db, key: string): Promise<CachedRow | null> {
  const result = await exec(
    db,
    "select body, expires_at, stale_until from osu_proxy_cache where cache_key = ? limit 1",
    [key],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    body: String(row.body),
    expiresAt: Number(row.expires_at),
    staleUntil: Number(row.stale_until),
  };
}

async function writeRow(db: Db, key: string, path: string, body: string, hints: OsuProxyCacheHints): Promise<void> {
  const now = Date.now();
  const expiresAt = now + hints.cacheTtlMs;
  await exec(
    db,
    `insert into osu_proxy_cache (cache_key, path, body, expires_at, stale_until, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(cache_key) do update set
       path = excluded.path,
       body = excluded.body,
       expires_at = excluded.expires_at,
       stale_until = excluded.stale_until,
       updated_at = excluded.updated_at`,
    [key, path, body, expiresAt, expiresAt + hints.staleMs, now],
    // Populating the cache is a pure optimization: if the writer is busy (a
    // worker backfill burst holds the single WAL writer), skip fast instead of
    // stalling the page load that triggered this proxy call.
    { bestEffort: true },
  );
}

export type OsuProxyCacheStatus = "hit" | "miss" | "stale";
export type OsuProxyCacheResult = { payload: unknown; cache: OsuProxyCacheStatus };

const inFlight = new Map<string, Promise<OsuProxyCacheResult>>();

async function lookupOrFetch(
  readDb: Db,
  writeDb: Db,
  osu: OsuApiClient,
  path: string,
  caller: string,
  hints: OsuProxyCacheHints,
  key: string,
): Promise<OsuProxyCacheResult> {
  const now = Date.now();
  let row: CachedRow | null = null;
  try {
    row = await readRow(readDb, key);
  } catch (error) {
    logWarn("osu_proxy_cache_read_failed", { path, ...errorContext(error) });
  }
  if (row && now < row.expiresAt) {
    return { payload: JSON.parse(row.body), cache: "hit" };
  }

  try {
    const payload = await osu.getJson(path, caller);
    try {
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES) {
        await writeRow(writeDb, key, path, body, hints);
      }
    } catch (error) {
      // A busy writer is an expected skip (best-effort write), not a failure —
      // tracked via sqliteBusy.bestEffortWriteSkips. Only log real write errors.
      if (!isSqliteBusyError(error)) {
        logWarn("osu_proxy_cache_write_failed", { path, ...errorContext(error) });
      }
    }
    return { payload, cache: "miss" };
  } catch (error) {
    // Upstream failed: within the caller's stale window an expired row is still better than an
    // error (used by profile surfaces to ride out osu! outages).
    if (row && now < row.staleUntil) {
      logWarn("osu_proxy_cache_served_stale", { path, caller, ...errorContext(error) });
      return { payload: JSON.parse(row.body), cache: "stale" };
    }
    throw error;
  }
}

export async function getOsuJsonWithProxyCache(
  readDb: Db,
  writeDb: Db,
  osu: OsuApiClient,
  path: string,
  caller: string,
  hints: OsuProxyCacheHints,
): Promise<OsuProxyCacheResult> {
  const key = cacheKeyFor(path);

  // Registered synchronously (before any await) so truly concurrent identical requests all
  // piggyback on one lookup+fetch instead of racing past each other into the token bucket.
  const existing = inFlight.get(key);
  if (existing) {
    try {
      return await existing;
    } catch {
      // The attempt we piggybacked on failed; run our own (it may serve stale).
    }
  }

  const attempt = lookupOrFetch(readDb, writeDb, osu, path, caller, hints, key);
  inFlight.set(key, attempt);
  try {
    return await attempt;
  } finally {
    if (inFlight.get(key) === attempt) inFlight.delete(key);
  }
}

// Retention: a row is useless once even its stale window has passed.
export async function pruneOsuProxyCache(db: Db): Promise<number> {
  const result = await exec(db, "delete from osu_proxy_cache where stale_until < ?", [Date.now()]);
  return result.rowsAffected ?? 0;
}
