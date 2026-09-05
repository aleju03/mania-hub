// Main-thread side of the maps snapshot worker thread (see
// maps-snapshot-thread-worker.ts for why it exists). One persistent thread per
// database file, spawned lazily on first use and revived on failure with a
// cooldown. Every failure mode that is about the thread itself (spawn failure,
// crash, timeout) rejects with a plain Error so callers can fall back to the
// inline build; a genuine build failure inside the feature code rejects with
// MapsSnapshotBuildError, which callers propagate instead of retrying inline.
//
// The same thread also hosts the other whole-roster board builds the serving
// process needs (the pack pool's unranked members, the skill leaderboard), see
// computeOnMapsSnapshotThread: each of those is seconds of synchronous libsql
// and JSON work that used to freeze every request while it ran.
// Catalog search also runs here, returning prepared JSON under "maps-search".
import type { Worker } from "node:worker_threads";
import type { Db } from "../db.js";
import { logWarn, errorContext } from "../logger.js";
import type { MapsPageQuery } from "../features/maps.js";
import type { MapSearchQuery } from "../features/map-search.js";
import { createModuleWorker } from "../module-worker.js";
import type { PreparedJsonResponse } from "./prepared-json.js";

export type MapsSnapshotThreadBuildRequest = {
  kind: "maps-page";
  country: string;
  query: MapsPageQuery;
  encoding: "br" | "gzip" | null;
  maxAgeMs: number;
} | {
  kind: "maps-search";
  query: MapSearchQuery;
  encoding: "br" | "gzip" | null;
};

/* Board builds that come back as a value (structured clone, typed-array
   buffers transferred) rather than as a prepared HTTP response. The caller
   caches the value exactly as it would its own inline build. */
export type MapsSnapshotThreadComputeRequest =
  | { kind: "pack-pool-unranked" }
  | { kind: "skill-board" };

export type MapsSnapshotThreadRequest = (MapsSnapshotThreadBuildRequest | MapsSnapshotThreadComputeRequest) & { id: number };

export type MapsSnapshotThreadOkResponse =
  | { id: number; ok: true; kind: "maps-page" | "maps-search"; status: number; encoding: "br" | "gzip" | null; vary: boolean; body: Uint8Array }
  | { id: number; ok: true; kind: "compute"; value: unknown };

export type MapsSnapshotThreadResponse =
  | MapsSnapshotThreadOkResponse
  | { id: number; ok: false; error: string };

/** The build itself failed (feature-code error); do not retry inline. */
export class MapsSnapshotBuildError extends Error {}

interface MapsSnapshotThreadConfig {
  databaseUrl: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
  // Two-process split: the thread delegates full GLOBAL board repacks to the
  // worker process instead of running the ~1.4GB pack inside the serving
  // process (see registerGlobalFarmedBoardRepackDelegation).
  delegateBoardRepacks?: boolean;
}

interface PendingBuild {
  resolve: (response: MapsSnapshotThreadOkResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  kind: MapsSnapshotThreadRequest["kind"];
}

export interface MapsSnapshotThreadStatus {
  enabled: boolean;
  disabledReason: MapsSnapshotThreadDisabledReason | null;
  spawned: boolean;
  everOnline: boolean;
  available: boolean;
  cooldownMsRemaining: number;
  /** Builds handed to the thread and not yet answered. */
  inFlight: number;
  requested: number;
  ok: number;
  failed: number;
  timeouts: number;
  lastBuildMs: number | null;
  lastBuildAt: string | null;
  /** Which request the last build answered: a maps page or one of the board computes. */
  lastBuildKind: string | null;
  /** Body size of the last page/search build; null after a compute, which has no body. */
  lastBuildBytes: number | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastFailureReason: string | null;
}

// Very generous: a GLOBAL hydrate is ~10-15s warm but has been observed north
// of 60s against a cold page cache on a memory-pressured box. Past this the
// thread is treated as wedged: the build fails (stale cache keeps serving)
// and the thread respawns after the cooldown. Deliberately NOT an inline
// fallback — re-running a build this heavy on the main thread would freeze
// the event loop, which is the exact failure mode the thread exists to
// prevent.
const BUILD_TIMEOUT_MS = 300_000;
// After a spawn failure, crash, or timeout, don't retry the thread for a
// while (covers environments where the worker file can't load, e.g. vitest,
// and keeps a struggling box from respawn churn).
const RESPAWN_COOLDOWN_MS = 60_000;

export class MapsSnapshotThread {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingBuild>();
  private nextId = 1;
  private brokenUntil = 0;
  private everOnline = false;
  // Counters exist purely for /api/admin/status. There is no queue on this
  // side — build() posts immediately and the thread's libsql is synchronous, so
  // requests serialise inside it — which makes pending.size ("in flight") the
  // only depth signal there is. A wedged thread shows up as inFlight > 0 with
  // an old lastBuildAt for up to BUILD_TIMEOUT_MS.
  private requested = 0;
  private okBuilds = 0;
  private failedBuilds = 0;
  private timeouts = 0;
  private lastBuildMs: number | null = null;
  private lastBuildAt: number | null = null;
  private lastBuildKind: string | null = null;
  private lastBuildBytes: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  private lastFailureReason: string | null = null;

  constructor(private readonly config: MapsSnapshotThreadConfig) {}

  available(): boolean {
    return Date.now() >= this.brokenUntil;
  }

  status(): Omit<MapsSnapshotThreadStatus, "enabled" | "disabledReason"> {
    return {
      spawned: this.worker != null,
      everOnline: this.everOnline,
      available: this.available(),
      cooldownMsRemaining: Math.max(0, this.brokenUntil - Date.now()),
      inFlight: this.pending.size,
      requested: this.requested,
      ok: this.okBuilds,
      failed: this.failedBuilds,
      timeouts: this.timeouts,
      lastBuildMs: this.lastBuildMs,
      lastBuildAt: this.lastBuildAt == null ? null : new Date(this.lastBuildAt).toISOString(),
      lastBuildKind: this.lastBuildKind,
      lastBuildBytes: this.lastBuildBytes,
      lastErrorAt: this.lastErrorAt == null ? null : new Date(this.lastErrorAt).toISOString(),
      lastError: this.lastError,
      lastFailureReason: this.lastFailureReason,
    };
  }

  /**
   * Inline (main-thread) builds are only an acceptable substitute when the
   * thread has never managed to start in this process — a structural problem
   * like a missing worker file under vitest. Once the thread has been online,
   * a failure means slow or crashed, and re-running the same heavy build on
   * the event loop would stall every other request.
   */
  inlineFallbackAllowed(): boolean {
    return !this.everOnline;
  }

  async build(request: MapsSnapshotThreadBuildRequest): Promise<PreparedJsonResponse> {
    const response = await this.dispatch(request);
    if (response.kind === "compute" || response.kind !== request.kind) {
      throw new MapsSnapshotBuildError(`maps snapshot thread answered ${request.kind} with a ${response.kind} response`);
    }
    return {
      status: response.status,
      encoding: response.encoding,
      vary: response.vary,
      body: Buffer.from(response.body.buffer, response.body.byteOffset, response.body.byteLength),
    };
  }

  /** A board build whose result is a value, cached by the caller like an inline build. */
  async compute<T>(request: MapsSnapshotThreadComputeRequest): Promise<T> {
    const response = await this.dispatch(request);
    if (response.kind !== "compute") {
      throw new MapsSnapshotBuildError(`maps snapshot thread answered ${request.kind} with a ${response.kind} response`);
    }
    return response.value as T;
  }

  private dispatch(request: MapsSnapshotThreadBuildRequest | MapsSnapshotThreadComputeRequest): Promise<MapsSnapshotThreadOkResponse> {
    // Distinct search misses share the read thread. Bound the backlog so a
    // burst cannot retain unbounded requests behind one expensive query.
    if (request.kind === "maps-search" && this.pending.size >= 16) {
      return Promise.reject(new MapsSnapshotBuildError("maps search thread busy"));
    }
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error("maps snapshot thread unavailable"));
    const id = this.nextId++;
    this.requested += 1;
    return new Promise<MapsSnapshotThreadOkResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timeouts += 1;
        this.fail(new Error(`maps snapshot thread timed out after ${BUILD_TIMEOUT_MS}ms`), "timeout");
        reject(new MapsSnapshotBuildError("maps snapshot thread timed out"));
      }, BUILD_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, startedAt: Date.now(), kind: request.kind });
      worker.postMessage({ ...request, id } satisfies MapsSnapshotThreadRequest);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (!this.available()) return null;
    let worker: Worker;
    try {
      worker = createModuleWorker(new URL("./maps-snapshot-thread-worker.js", import.meta.url), {
        workerData: this.config,
      });
    } catch (error) {
      this.markBroken(error);
      return null;
    }
    // The thread must never keep an exiting process alive.
    worker.unref();
    worker.on("online", () => {
      this.everOnline = true;
    });
    worker.on("message", (response: MapsSnapshotThreadResponse) => this.handleResponse(response));
    worker.on("error", (error) => this.fail(error, "error"));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.fail(new Error(`maps snapshot thread exited with code ${code}`), "exit");
      }
    });
    this.worker = worker;
    return worker;
  }

  private handleResponse(response: MapsSnapshotThreadResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    this.lastBuildMs = Date.now() - pending.startedAt;
    this.lastBuildAt = Date.now();
    this.lastBuildKind = pending.kind;
    if (!response.ok) {
      this.failedBuilds += 1;
      this.lastBuildBytes = null;
      this.lastErrorAt = this.lastBuildAt;
      this.lastError = response.error;
      this.lastFailureReason = "build";
      pending.reject(new MapsSnapshotBuildError(response.error));
      return;
    }
    this.okBuilds += 1;
    this.lastBuildBytes = response.kind === "compute" ? null : response.body.byteLength;
    pending.resolve(response);
  }

  private fail(error: unknown, reason: string): void {
    this.markBroken(error, reason);
    const message = error instanceof Error ? error.message : String(error);
    // After 'online', a failure means the thread was slow or crashed
    // mid-build; rejecting with a build error keeps callers from re-running
    // the same heavy build inline. Before 'online' it's a spawn problem, and
    // inline is the only way to serve at all.
    const failure = this.everOnline
      ? new MapsSnapshotBuildError(message)
      : error instanceof Error
        ? error
        : new Error(message);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      this.failedBuilds += 1;
      pending.reject(failure);
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private markBroken(error: unknown, reason = "spawn"): void {
    this.brokenUntil = Date.now() + RESPAWN_COOLDOWN_MS;
    this.lastErrorAt = Date.now();
    this.lastError = error instanceof Error ? error.message : String(error);
    this.lastFailureReason = reason;
    logWarn("maps_snapshot_thread_unavailable", { reason, ...errorContext(error) });
  }
}

// One thread per database file so tests with distinct temp DBs can never read
// each other's data through a shared thread.
const threadsByDatabaseUrl = new Map<string, MapsSnapshotThread>();

// Pinned rather than inherited from the serving process's SQLITE_CACHE_MB /
// SQLITE_MMAP_MB: this connection builds one snapshot at a time, so a large
// page cache buys nothing, and its mmap window is charged to the serving
// process's RSS on a memory-tight host.
//
// mmap = 0 was measured, not assumed. Against a copy of the production
// database (5.6 GB, GLOBAL maps-page build, 32 MiB cache, warm page cache,
// 4 interleaved rounds) the build took 7.9-8.2s at every mmap setting, while
// the resident bytes charged to the database mapping (smaps) were 0 MiB at
// mmap 0, 6 MiB at 64, and 48 MiB at 256. Reading the 67.6 MB payload_json
// blob on its own was also flat (113-121 ms median at 0 / 64 / 256): the
// string copy into the JS heap dominates, so the overflow-page copying that
// mmap avoids never shows up. No latency to buy back, 48 MiB to save.
const THREAD_SQLITE_CACHE_MB = 32;
const THREAD_SQLITE_MMAP_MB = 0;

export type MapsSnapshotThreadDisabledReason = "not_file_db" | "env_disabled" | "source_mode";

function mapsSnapshotThreadDisabledReason(databaseUrl?: string): MapsSnapshotThreadDisabledReason | null {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) return "not_file_db";
  if (process.env.MAPS_SNAPSHOT_THREAD === "0") return "env_disabled";
  // Keep the existing inline source-mode development path. The explicit
  // loader in createModuleWorker lets worker integration tests run from TS,
  // while ordinary dev does not load another large maps/board isolate.
  // Compiled production reaches this code from JS and uses the worker.
  if (import.meta.url.endsWith(".ts")) return "source_mode";
  return null;
}

export function getMapsSnapshotThread(config: {
  databaseUrl?: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  role?: string;
}): MapsSnapshotThread | null {
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl || mapsSnapshotThreadDisabledReason(databaseUrl)) return null;
  let thread = threadsByDatabaseUrl.get(databaseUrl);
  if (!thread) {
    thread = new MapsSnapshotThread({
      databaseUrl,
      sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs,
      sqliteSynchronous: config.sqliteSynchronous,
      sqliteCacheMb: THREAD_SQLITE_CACHE_MB,
      sqliteMmapMb: THREAD_SQLITE_MMAP_MB,
      delegateBoardRepacks: config.role === "server",
    });
    threadsByDatabaseUrl.set(databaseUrl, thread);
  }
  return thread;
}

// Reporting must never be the thing that spawns a thread, so this reads the
// registry without inserting into it. An "idle" shape means nothing has asked
// for a build yet, which is a different state from disabled.
export function mapsSnapshotThreadStatus(config: { databaseUrl?: string }): MapsSnapshotThreadStatus {
  const disabledReason = mapsSnapshotThreadDisabledReason(config.databaseUrl);
  const thread = config.databaseUrl ? threadsByDatabaseUrl.get(config.databaseUrl) : undefined;
  const counters = thread?.status() ?? {
    spawned: false,
    everOnline: false,
    available: true,
    cooldownMsRemaining: 0,
    inFlight: 0,
    requested: 0,
    ok: 0,
    failed: 0,
    timeouts: 0,
    lastBuildMs: null,
    lastBuildAt: null,
    lastBuildKind: null,
    lastBuildBytes: null,
    lastErrorAt: null,
    lastError: null,
    lastFailureReason: null,
  };
  return { enabled: disabledReason == null, disabledReason, ...counters };
}

// Connections whose whole-roster board builds (pack pool, skill leaderboard)
// run on the thread. Registered by the serving process at boot; absent for
// tests and the headless worker, which build inline as before.
const boardThreadConfigByDb = new WeakMap<Db, Parameters<typeof getMapsSnapshotThread>[0]>();

export function registerOffThreadBoardBuilds(db: Db, config: Parameters<typeof getMapsSnapshotThread>[0]): void {
  boardThreadConfigByDb.set(db, config);
}

/* Runs a board build on the thread when one can run here. Null means the
   thread genuinely cannot (connection not registered, not a file database,
   disabled, or it never managed to spawn - e.g. under vitest) and the caller
   should build inline. Anything that went wrong after the thread has been
   online throws MapsSnapshotBuildError instead: re-running a whole-roster scan
   on the event loop is the stall the thread exists to prevent, and every
   caller already keeps serving its previous board through a failed refresh. */
export async function computeOnMapsSnapshotThread<T>(db: Db, request: MapsSnapshotThreadComputeRequest): Promise<T | null> {
  const config = boardThreadConfigByDb.get(db);
  if (!config) return null;
  const thread = getMapsSnapshotThread(config);
  if (!thread) return null;
  if (!thread.available()) {
    if (thread.inlineFallbackAllowed()) return null;
    throw new MapsSnapshotBuildError("maps snapshot thread cooling down");
  }
  try {
    return await thread.compute<T>(request);
  } catch (error) {
    if (error instanceof MapsSnapshotBuildError) throw error;
    logWarn("maps_snapshot_thread_inline_fallback", { kind: request.kind, ...errorContext(error) });
    return null;
  }
}
