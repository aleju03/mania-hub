import type { IncomingMessage, ServerResponse } from "node:http";
import { GLOBAL_COUNTRY_CODE } from "../countries.js";
import type { Db } from "../db.js";
import { getMapsSnapshotMeta } from "../features/maps.js";
import { errorContext, logWarn } from "../logger.js";
import { BOARD_WARMUP_DELAY_MS, unrefDelay, waitForQuietSchema } from "../warmup.js";
import type { HttpContext } from "./context.js";
import { getMapsSnapshotThread, MapsSnapshotBuildError, type MapsSnapshotThreadBuildRequest } from "./maps-snapshot-thread.js";
import type { PreparedJsonResponse } from "./prepared-json.js";
import { writePreparedJson } from "./respond.js";

// Prepared /maps-page responses are cached already serialized and compressed.
// The shorter TTL while a country refresh is running bounds how long volatile
// refresh-state flags can lag; generation markers invalidate settled entries.
export const MAPS_PAGE_RESPONSE_CACHE_TTL_MS = 10 * 60_000;
const MAPS_PAGE_RESPONSE_CACHE_MAX_ENTRIES = 128;
export const MAPS_REFRESHING_RESPONSE_CACHE_TTL_MS = 30_000;
// Byte budgets (Phase 7). Entry counts alone can't bound memory: one entry may
// hold a large body. Maps-page bodies are normally <= ~64 KiB, so this budget
// is a safety ceiling rather than a tuning knob.
const MAPS_PAGE_RESPONSE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
// No single body may occupy a meaningful slice of a cache budget. Larger
// bodies are still served, just never retained.
const MAPS_RESPONSE_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
// A 200 body above this size is only served compressed: clients that accept
// neither br nor gzip get a cached 406 instead. This keeps very large identity
// bodies out of the cache without opening a rebuild-per-request path for
// Accept-Encoding-less clients — the tiny 406 is cached under the identity
// key. Every browser and standard HTTP library sends Accept-Encoding.
const MAPS_IDENTITY_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
// How long past its TTL a GLOBAL entry may still be served while a background
// rebuild replaces it. GLOBAL page builds can be expensive, so requests get
// the previous generation instantly and the rebuild runs once off the request
// path. Country entries don't opt in (staleServeMs 0).
export const MAPS_GLOBAL_STALE_SERVE_MS = 45 * 60_000;

export interface MapsResponseCacheEntry extends PreparedJsonResponse {
  storedAt: number;
  ttlMs: number;
  staleServeMs: number;
  freshnessKey: string;
}

// A prepared-response cache bounded by body bytes as well as entry count.
// totalBytes is maintained incrementally by the set/delete helpers below; all
// mutations must go through them.
export interface MapsResponseCache {
  entries: Map<string, MapsResponseCacheEntry>;
  totalBytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
}

// Maps-search responses: short TTL (the index reconciles statuses on its own
// cadence and the browser already caches for 60s), sized for a burst of
// distinct queries. Every repeat of a query inside the TTL costs zero SQL,
// which is the whole defense for the LIKE-only query shapes.
export const MAP_SEARCH_RESPONSE_CACHE_TTL_MS = 30_000;
const MAP_SEARCH_RESPONSE_CACHE_MAX_ENTRIES = 256;
const MAP_SEARCH_RESPONSE_CACHE_MAX_BYTES = 16 * 1024 * 1024;

// Per-Db cache state so entries never leak across databases (one process holds
// a single Db in production; tests spin up a fresh Db each). This matters now
// that GLOBAL keys are stable across generations instead of embedding
// refreshed_at.
interface MapsResponseCacheState {
  pageResponses: MapsResponseCache;
  pageInflight: Map<string, Promise<PreparedJsonResponse>>;
  searchResponses: MapsResponseCache;
  searchInflight: Map<string, Promise<PreparedJsonResponse>>;
}

const mapsResponseCacheByDb = new WeakMap<Db, MapsResponseCacheState>();

export function createMapsResponseCache(
  maxEntries: number,
  maxBytes: number,
  maxEntryBytes = MAPS_RESPONSE_CACHE_MAX_ENTRY_BYTES,
): MapsResponseCache {
  return { entries: new Map(), totalBytes: 0, maxEntries, maxBytes, maxEntryBytes };
}

export function getMapsResponseCacheState(db: Db): MapsResponseCacheState {
  let state = mapsResponseCacheByDb.get(db);
  if (!state) {
    state = {
      pageResponses: createMapsResponseCache(MAPS_PAGE_RESPONSE_CACHE_MAX_ENTRIES, MAPS_PAGE_RESPONSE_CACHE_MAX_BYTES),
      pageInflight: new Map(),
      searchResponses: createMapsResponseCache(MAP_SEARCH_RESPONSE_CACHE_MAX_ENTRIES, MAP_SEARCH_RESPONSE_CACHE_MAX_BYTES),
      searchInflight: new Map(),
    };
    mapsResponseCacheByDb.set(db, state);
  }
  return state;
}

export function mapsResponseCacheDelete(cache: MapsResponseCache, key: string): void {
  const existing = cache.entries.get(key);
  if (!existing) return;
  cache.entries.delete(key);
  cache.totalBytes -= existing.body.length;
}

export function mapsResponseCacheSet(cache: MapsResponseCache, key: string, entry: MapsResponseCacheEntry): void {
  // Oversized bodies are served but never retained: a single entry must not
  // occupy a meaningful slice of the cache budget.
  if (entry.body.length > cache.maxEntryBytes) {
    mapsResponseCacheDelete(cache, key);
    return;
  }
  // Delete-then-set keeps Map insertion order meaningful for the oldest-first
  // eviction below.
  mapsResponseCacheDelete(cache, key);
  cache.entries.set(key, entry);
  cache.totalBytes += entry.body.length;
  evictMapsResponseCacheOverflow(cache);
}

function evictMapsResponseCacheOverflow(cache: MapsResponseCache): void {
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (cache.entries.size > cache.maxEntries || cache.totalBytes > cache.maxBytes) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    mapsResponseCacheDelete(cache, oldest);
  }
}

export function pruneMapsResponseCache(cache: MapsResponseCache, now: number): void {
  for (const [key, entry] of cache.entries) {
    if (now - entry.storedAt > entry.ttlMs + entry.staleServeMs) mapsResponseCacheDelete(cache, key);
  }
  evictMapsResponseCacheOverflow(cache);
}

// A 200 body too large for identity transfer becomes a tiny cacheable 406:
// see MAPS_IDENTITY_RESPONSE_MAX_BYTES. vary is set because the outcome
// depends on Accept-Encoding even though this body itself is uncompressed.
export function enforceCompressedLargeBody(
  result: { prepared: PreparedJsonResponse; cacheTtlMs: number | null },
  encoding: "br" | "gzip" | null,
): { prepared: PreparedJsonResponse; cacheTtlMs: number | null } {
  const { prepared } = result;
  if (encoding !== null || prepared.status !== 200 || prepared.body.length <= MAPS_IDENTITY_RESPONSE_MAX_BYTES) {
    return result;
  }
  const body = Buffer.from(JSON.stringify({
    error: "compression_required",
    message: "This response is only served compressed. Repeat the request with Accept-Encoding: br or gzip.",
  }), "utf8");
  return { prepared: { status: 406, encoding: null, vary: true, body }, cacheTtlMs: result.cacheTtlMs };
}

// Try to run a GLOBAL maps-page build on the snapshot worker thread, where its
// synchronous libsql reads and multi-second hydrate can't stall the server's
// event loop. Null means the thread genuinely can't run here (disabled, or it
// never managed to spawn — e.g. under vitest) and the caller should build
// inline. Anything that went wrong after the thread has been online (build
// failure, timeout, crash, cooldown) throws MapsSnapshotBuildError instead:
// re-running a build that heavy inline on the loop is exactly the stall the
// thread exists to prevent, and the stale cache keeps serving meanwhile.
export async function buildGlobalMapsResponseOnThread(
  ctx: HttpContext,
  request: MapsSnapshotThreadBuildRequest,
): Promise<PreparedJsonResponse | null> {
  const thread = getMapsSnapshotThread(ctx.config);
  if (!thread) return null;
  if (!thread.available()) {
    if (thread.inlineFallbackAllowed()) return null;
    throw new MapsSnapshotBuildError("maps snapshot thread cooling down");
  }
  try {
    return await thread.build(request);
  } catch (error) {
    if (error instanceof MapsSnapshotBuildError) throw error;
    logWarn("maps_snapshot_thread_inline_fallback", errorContext(error));
    return null;
  }
}

// Search misses must never retry on the serving connection after a worker
// failure, including a failed first spawn. Source-mode/remote/explicitly
// disabled threads retain the existing inline path.
export async function buildMapSearchResponseOnThread(
  ctx: HttpContext,
  request: Extract<MapsSnapshotThreadBuildRequest, { kind: "maps-search" }>,
): Promise<PreparedJsonResponse | null> {
  const thread = getMapsSnapshotThread(ctx.config);
  if (!thread) return null;
  if (!thread.available()) throw new MapsSnapshotBuildError("maps search thread cooling down");
  try {
    return await thread.build(request);
  } catch (error) {
    logWarn("maps_search_thread_build_failed", errorContext(error));
    throw new MapsSnapshotBuildError(error instanceof Error ? error.message : String(error));
  }
}

export interface MapsResponseCachedServeOptions {
  cache: MapsResponseCache;
  inflight: Map<string, Promise<PreparedJsonResponse>>;
  /** Stable cache key; null disables caching (no snapshot row yet). */
  key: string | null;
  /**
   * Generation marker checked against the stored entry. When the key itself
   * carries every input (country entries), pass a constant "".
   */
  freshnessKey: string;
  /** 0 = never serve a stale/mismatched entry; rebuild in the foreground. */
  staleServeMs: number;
  build: () => Promise<{ prepared: PreparedJsonResponse; cacheTtlMs: number | null }>;
}

export async function serveMapsResponseCached(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  options: MapsResponseCachedServeOptions,
): Promise<void> {
  const { cache, inflight, key, freshnessKey, staleServeMs, build } = options;
  if (!key) {
    writePreparedJson(req, res, ctx, (await build()).prepared);
    return;
  }
  const now = Date.now();
  const entry = cache.entries.get(key);
  if (entry) {
    const age = now - entry.storedAt;
    if (entry.freshnessKey === freshnessKey && age < entry.ttlMs) {
      writePreparedJson(req, res, ctx, entry);
      return;
    }
    if (staleServeMs > 0 && age < entry.ttlMs + staleServeMs) {
      // Serve the previous generation immediately; replace it in the
      // background, single-flight per key so a burst can't stack rebuilds.
      if (!inflight.has(key)) {
        void startMapsResponseBuild(options).catch(() => undefined);
      }
      writePreparedJson(req, res, ctx, entry);
      return;
    }
  }
  // Coalesce concurrent misses: a burst of visitors right after a rebuild
  // (or restart) must run the multi-second hydrate once, not once each.
  const pending = inflight.get(key) ?? startMapsResponseBuild(options);
  writePreparedJson(req, res, ctx, await pending);
}

function startMapsResponseBuild(options: MapsResponseCachedServeOptions): Promise<PreparedJsonResponse> {
  const { cache, inflight, key, freshnessKey, staleServeMs, build } = options;
  if (!key) return build().then(({ prepared }) => prepared);
  const promise = build()
    .then(({ prepared, cacheTtlMs }) => {
      if (cacheTtlMs != null) {
        mapsResponseCacheSet(cache, key, { ...prepared, storedAt: Date.now(), ttlMs: cacheTtlMs, staleServeMs, freshnessKey });
      }
      return prepared;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

// The first GLOBAL farmed request after a restart packs the durable player
// projection (maps.ts patches later revisions by beatmap). Build it shortly after
// boot so a user never fronts that cost. Runs on the maps snapshot thread; if
// the thread is unavailable (memory DB, MAPS_SNAPSHOT_THREAD=0, vitest) this
// deliberately does nothing rather than stall the main event loop.
//
// The build is a pure read (it never takes the write lock), but packing a
// production-sized player corpus still pegs a core, so landing it on top of a
// deploy's schema migration on a 2-vCPU / 3.7GB box starves the writer of CPU
// and page cache. No constant can separate the two: migrate() may now spend up
// to SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS purely waiting out a concurrent writer,
// so a delay big enough for the contended case would penalize every ordinary
// restart (where the migration is done in seconds) with minutes of cold board.
// So observe it instead — migrate() publishes its start/finish in live_meta —
// and keep the floor at the boot-burst settle time it always was. Both halves
// live in warmup.ts now; the skill/dan board warms on the same terms.

export function warmGlobalMapsFarmedBoard(ctx: HttpContext): void {
  void (async () => {
    await unrefDelay(BOARD_WARMUP_DELAY_MS);
    await waitForQuietSchema(ctx.db, "maps_global_farmed");
    const meta = await getMapsSnapshotMeta(ctx.db, GLOBAL_COUNTRY_CODE);
    if (!meta.refreshedAt) return;
    await buildGlobalMapsResponseOnThread(ctx, {
      kind: "maps-page",
      country: GLOBAL_COUNTRY_CODE,
      // Any pp > 0 routes through the filtered path and builds the shared
      // board; the specific filter values do not matter.
      query: { tab: "farmed", page: 0, pageSize: 48, key: "all", beatmapSort: "players", farmedSort: "players", dir: "desc", status: "all", pp: 1, mod: "all", q: "" },
      encoding: null,
      maxAgeMs: ctx.config.mapsRefreshIntervalMs,
    });
  })().catch((error) => logWarn("maps_global_farmed_board_warmup_failed", errorContext(error)));
}
