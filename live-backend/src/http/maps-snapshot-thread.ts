// Main-thread side of the maps snapshot worker thread (see
// maps-snapshot-thread-worker.ts for why it exists). One persistent thread per
// database file, spawned lazily on first use and revived on failure with a
// cooldown. Every failure mode that is about the thread itself (spawn failure,
// crash, timeout) rejects with a plain Error so callers can fall back to the
// inline build; a genuine build failure inside the feature code rejects with
// MapsSnapshotBuildError, which callers propagate instead of retrying inline.
import { Worker } from "node:worker_threads";
import { logWarn, errorContext } from "../logger.js";
import type { MapsPageQuery } from "../features/maps.js";
import type { PreparedJsonResponse } from "./prepared-json.js";

export type MapsSnapshotThreadBuildRequest =
  | { kind: "maps"; country: string; section: "core" | "random"; encoding: "br" | "gzip" | null; maxAgeMs: number }
  | { kind: "maps-page"; country: string; query: MapsPageQuery; encoding: "br" | "gzip" | null; maxAgeMs: number };

export type MapsSnapshotThreadRequest = MapsSnapshotThreadBuildRequest & { id: number };

export type MapsSnapshotThreadResponse =
  | { id: number; ok: true; status: number; encoding: "br" | "gzip" | null; vary: boolean; body: Uint8Array }
  | { id: number; ok: false; error: string };

/** The build itself failed (feature-code error); do not retry inline. */
export class MapsSnapshotBuildError extends Error {}

interface MapsSnapshotThreadConfig {
  databaseUrl: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
}

interface PendingBuild {
  resolve: (result: PreparedJsonResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
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

  constructor(private readonly config: MapsSnapshotThreadConfig) {}

  available(): boolean {
    return Date.now() >= this.brokenUntil;
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

  build(request: MapsSnapshotThreadBuildRequest): Promise<PreparedJsonResponse> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error("maps snapshot thread unavailable"));
    const id = this.nextId++;
    return new Promise<PreparedJsonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fail(new Error(`maps snapshot thread timed out after ${BUILD_TIMEOUT_MS}ms`), "timeout");
        reject(new MapsSnapshotBuildError("maps snapshot thread timed out"));
      }, BUILD_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...request, id } satisfies MapsSnapshotThreadRequest);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (!this.available()) return null;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./maps-snapshot-thread-worker.js", import.meta.url), {
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
    if (!response.ok) {
      pending.reject(new MapsSnapshotBuildError(response.error));
      return;
    }
    pending.resolve({
      status: response.status,
      encoding: response.encoding,
      vary: response.vary,
      body: Buffer.from(response.body.buffer, response.body.byteOffset, response.body.byteLength),
    });
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
      pending.reject(failure);
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private markBroken(error: unknown, reason = "spawn"): void {
    this.brokenUntil = Date.now() + RESPAWN_COOLDOWN_MS;
    logWarn("maps_snapshot_thread_unavailable", { reason, ...errorContext(error) });
  }
}

// One thread per database file so tests with distinct temp DBs can never read
// each other's data through a shared thread.
const threadsByDatabaseUrl = new Map<string, MapsSnapshotThread>();

export function getMapsSnapshotThread(config: {
  databaseUrl?: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
}): MapsSnapshotThread | null {
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl || !databaseUrl.startsWith("file:")) return null;
  if (process.env.MAPS_SNAPSHOT_THREAD === "0") return null;
  let thread = threadsByDatabaseUrl.get(databaseUrl);
  if (!thread) {
    thread = new MapsSnapshotThread({
      databaseUrl,
      sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs,
      sqliteSynchronous: config.sqliteSynchronous,
      sqliteCacheMb: config.sqliteCacheMb,
      sqliteMmapMb: config.sqliteMmapMb,
    });
    threadsByDatabaseUrl.set(databaseUrl, thread);
  }
  return thread;
}
