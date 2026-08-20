// Main-thread side of the pack community snapshot worker thread (see
// pack-community-thread-worker.ts for why it exists). One persistent thread per
// database file, spawned lazily on first use and revived on failure with a
// cooldown, modelled on http/maps-snapshot-thread.ts.
//
// Every failure mode that is about the thread itself (spawn failure, crash,
// timeout) rejects with a plain Error so the caller can decide to build inline;
// a genuine build failure inside the feature code rejects with
// PackCommunitySnapshotBuildError, which callers must not retry inline.
import { Worker } from "node:worker_threads";
import { errorContext, logWarn } from "../logger.js";

/** Which half of the economy roll-up a request wants. */
export type PackCommunitySnapshotKind = "collector" | "card" | "totals";

export type PackCommunityThreadRequest = { id: number; kind: PackCommunitySnapshotKind; now: number };

/* The snapshot travels as UTF-8 JSON bytes rather than as an object graph. The
   collector half is a couple of thousand records that would otherwise be
   structured-cloned field by field on both sides; serialising once in the
   thread and parsing once here is cheaper, and the same bytes are what the
   disk cache stores, so the persist path costs the main thread nothing. */
export type PackCommunityThreadResponse =
  | { id: number; ok: true; json: Uint8Array }
  | { id: number; ok: false; error: string };

/** The build itself failed (feature-code error); do not retry inline. */
export class PackCommunitySnapshotBuildError extends Error {}

interface PackCommunityThreadConfig {
  databaseUrl: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
}

interface PendingBuild {
  resolve: (json: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

export interface PackCommunityThreadStatus {
  enabled: boolean;
  disabledReason: PackCommunityThreadDisabledReason | null;
  spawned: boolean;
  everOnline: boolean;
  available: boolean;
  cooldownMsRemaining: number;
  inFlight: number;
  requested: number;
  ok: number;
  failed: number;
  timeouts: number;
  lastBuildMs: number | null;
  lastBuildAt: string | null;
  lastBuildBytes: number | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastFailureReason: string | null;
}

// Generous: the cold collector + card scans measured ~12s serialised against
// the production database with nothing else running, and a contended box can
// be several times that. Past this the thread is treated as wedged; the build
// fails, the last good snapshot keeps serving, and the thread respawns after
// the cooldown. Deliberately not an inline fallback: re-running a scan this
// heavy on the event loop is the exact stall the thread exists to prevent.
const BUILD_TIMEOUT_MS = 240_000;
const RESPAWN_COOLDOWN_MS = 60_000;

export class PackCommunitySnapshotThread {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingBuild>();
  private nextId = 1;
  private brokenUntil = 0;
  private everOnline = false;
  private requested = 0;
  private okBuilds = 0;
  private failedBuilds = 0;
  private timeouts = 0;
  private lastBuildMs: number | null = null;
  private lastBuildAt: number | null = null;
  private lastBuildBytes: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  private lastFailureReason: string | null = null;

  constructor(private readonly config: PackCommunityThreadConfig) {}

  available(): boolean {
    return Date.now() >= this.brokenUntil;
  }

  status(): Omit<PackCommunityThreadStatus, "enabled" | "disabledReason"> {
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
      lastBuildBytes: this.lastBuildBytes,
      lastErrorAt: this.lastErrorAt == null ? null : new Date(this.lastErrorAt).toISOString(),
      lastError: this.lastError,
      lastFailureReason: this.lastFailureReason,
    };
  }

  /**
   * Inline (main-thread) builds are only an acceptable substitute when the
   * thread has never managed to start in this process — a structural problem
   * like a missing worker file under vitest. Once it has been online, a
   * failure means slow or crashed, and re-running the scan on the event loop
   * would stall every other request for its whole duration.
   */
  inlineFallbackAllowed(): boolean {
    return !this.everOnline;
  }

  build(kind: PackCommunitySnapshotKind, now: number): Promise<Buffer> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error("pack community snapshot thread unavailable"));
    const id = this.nextId++;
    this.requested += 1;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timeouts += 1;
        this.fail(new Error(`pack community snapshot thread timed out after ${BUILD_TIMEOUT_MS}ms`), "timeout");
        reject(new PackCommunitySnapshotBuildError("pack community snapshot thread timed out"));
      }, BUILD_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, startedAt: Date.now() });
      worker.postMessage({ id, kind, now } satisfies PackCommunityThreadRequest);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (!this.available()) return null;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./pack-community-thread-worker.js", import.meta.url), {
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
    worker.on("message", (response: PackCommunityThreadResponse) => this.handleResponse(response));
    worker.on("error", (error) => this.fail(error, "error"));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.fail(new Error(`pack community snapshot thread exited with code ${code}`), "exit");
      }
    });
    this.worker = worker;
    return worker;
  }

  private handleResponse(response: PackCommunityThreadResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    this.lastBuildMs = Date.now() - pending.startedAt;
    this.lastBuildAt = Date.now();
    if (!response.ok) {
      this.failedBuilds += 1;
      this.lastBuildBytes = null;
      this.lastErrorAt = this.lastBuildAt;
      this.lastError = response.error;
      this.lastFailureReason = "build";
      pending.reject(new PackCommunitySnapshotBuildError(response.error));
      return;
    }
    this.okBuilds += 1;
    this.lastBuildBytes = response.json.byteLength;
    pending.resolve(Buffer.from(response.json.buffer, response.json.byteOffset, response.json.byteLength));
  }

  private fail(error: unknown, reason: string): void {
    this.markBroken(error, reason);
    const message = error instanceof Error ? error.message : String(error);
    const failure = this.everOnline
      ? new PackCommunitySnapshotBuildError(message)
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
    logWarn("pack_community_thread_unavailable", { reason, ...errorContext(error) });
  }
}

// One thread per database file so tests with distinct temp DBs can never read
// each other's data through a shared thread.
const threadsByDatabaseUrl = new Map<string, PackCommunitySnapshotThread>();

// Pinned for the same reason the maps thread pins them: this connection runs
// one roll-up at a time, so a large page cache buys nothing, and its mmap
// window would be charged to the serving process's RSS on a memory-tight host.
const THREAD_SQLITE_CACHE_MB = 32;
const THREAD_SQLITE_MMAP_MB = 0;

export type PackCommunityThreadDisabledReason = "not_file_db" | "env_disabled" | "source_mode";

function packCommunityThreadDisabledReason(databaseUrl?: string): PackCommunityThreadDisabledReason | null {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) return "not_file_db";
  if (process.env.PACK_COMMUNITY_THREAD === "0") return "env_disabled";
  // `node --import tsx` can run this source module, but its worker threads do
  // not remap the worker's internal `.js` imports back to `.ts`. Source-mode
  // development therefore uses the inline fallback rather than spawning a
  // worker that is guaranteed to fail. Compiled production reaches this from a
  // `.js` module and keeps the thread.
  if (import.meta.url.endsWith(".ts")) return "source_mode";
  return null;
}

export function getPackCommunitySnapshotThread(config: {
  databaseUrl?: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
}): PackCommunitySnapshotThread | null {
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl || packCommunityThreadDisabledReason(databaseUrl)) return null;
  let thread = threadsByDatabaseUrl.get(databaseUrl);
  if (!thread) {
    thread = new PackCommunitySnapshotThread({
      databaseUrl,
      sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs,
      sqliteSynchronous: config.sqliteSynchronous,
      sqliteCacheMb: THREAD_SQLITE_CACHE_MB,
      sqliteMmapMb: THREAD_SQLITE_MMAP_MB,
    });
    threadsByDatabaseUrl.set(databaseUrl, thread);
  }
  return thread;
}

// Reporting must never be the thing that spawns a thread, so this reads the
// registry without inserting into it.
export function packCommunityThreadStatus(config: { databaseUrl?: string }): PackCommunityThreadStatus {
  const disabledReason = packCommunityThreadDisabledReason(config.databaseUrl);
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
    lastBuildBytes: null,
    lastErrorAt: null,
    lastError: null,
    lastFailureReason: null,
  };
  return { enabled: disabledReason == null, disabledReason, ...counters };
}
