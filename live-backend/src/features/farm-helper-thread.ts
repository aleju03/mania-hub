import type { Worker } from "node:worker_threads";
import { exec, type Db, type DbStatement } from "../db.js";
import { createModuleWorker } from "../module-worker.js";
import { logWarn } from "../logger.js";
import type { FarmHelperBuildInput, FarmHelperBuildResult } from "./farm-helper.js";
import type { FarmHelperTimingData, FarmHelperTimings } from "./farm-helper-timing.js";

const MAX_PENDING = 8;
const BUILD_TIMEOUT_MS = 60_000;
const RESPAWN_COOLDOWN_MS = 30_000;

export class FarmHelperBuildError extends Error {}

export interface FarmHelperThreadConfig {
  databaseUrl: string;
}

export type FarmHelperThreadRequest =
  | { kind: "build"; id: number; generation: number; input: FarmHelperBuildInput }
  | { kind: "write-result"; id: number; writeId: number; error?: string };

export type FarmHelperThreadResponse =
  | { kind: "result"; id: number; result: FarmHelperBuildResult; timings: FarmHelperTimingData }
  | { kind: "error"; id: number; error: string }
  | { kind: "write"; id: number; writeId: number; statement: DbStatement };

interface PendingBuild {
  id: number;
  input: FarmHelperBuildInput;
  writeDb: Db;
  timings?: FarmHelperTimings;
  resolve: (result: FarmHelperBuildResult) => void;
  reject: (error: Error) => void;
  queuedAt: number;
}

// One active build, at most seven waiting. Only the active input is posted to
// the worker; even async SQLite retries cannot interleave two builds there.
export class FarmHelperBuildThread {
  private worker: Worker | null = null;
  private active: PendingBuild | null = null;
  private waiting: PendingBuild[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private generation = 0;
  private brokenUntil = 0;
  private closed = false;
  private completed = 0;
  private failed = 0;
  private rejected = 0;
  private lastError: string | null = null;

  constructor(private readonly config: FarmHelperThreadConfig) {}

  status() {
    return {
      spawned: this.worker != null,
      inFlight: this.active ? 1 : 0,
      queued: this.waiting.length,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
      cooldownMsRemaining: Math.max(0, this.brokenUntil - Date.now()),
      lastError: this.lastError,
    };
  }

  invalidateCaches(): void {
    this.generation += 1;
  }

  build(input: FarmHelperBuildInput, writeDb: Db, timings?: FarmHelperTimings): Promise<FarmHelperBuildResult> {
    if (this.closed || Date.now() < this.brokenUntil || this.waiting.length + (this.active ? 1 : 0) >= MAX_PENDING) {
      this.rejected += 1;
      return Promise.reject(new FarmHelperBuildError("Farm Helper is busy or temporarily unavailable"));
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ id: this.nextId++, input, writeDb, timings, resolve, reject, queuedAt: performance.now() });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.fail(new Error("Farm Helper thread closed"), false);
    if (worker) await worker.terminate();
  }

  private dispatch(): void {
    if (this.active || this.waiting.length === 0) return;
    this.active = this.waiting.shift()!;
    const pending = this.active;
    pending.timings?.add("fh_thread_queue", performance.now() - pending.queuedAt);
    try {
      if (!this.worker) {
        const worker = createModuleWorker(new URL("./farm-helper-thread-worker.js", import.meta.url), { workerData: this.config });
        this.worker = worker;
        worker.on("message", (response: FarmHelperThreadResponse) => {
          if (this.worker === worker) void this.handleResponse(worker, response);
        });
        worker.on("error", (error) => { if (this.worker === worker) this.fail(error); });
        worker.on("exit", (code) => {
          if (this.worker === worker) this.fail(new Error(`Farm Helper thread exited with code ${code}`));
        });
      }
      this.worker.ref();
      this.timer = setTimeout(() => this.fail(new Error(`Farm Helper build timed out after ${BUILD_TIMEOUT_MS}ms`)), BUILD_TIMEOUT_MS);
      this.worker.postMessage({ kind: "build", id: pending.id, generation: this.generation, input: pending.input } satisfies FarmHelperThreadRequest);
    } catch (error) {
      this.fail(error);
    }
  }

  private async handleResponse(worker: Worker, response: FarmHelperThreadResponse): Promise<void> {
    const pending = this.active;
    if (!pending || pending.id !== response.id) return;
    if (response.kind === "write") {
      // Only derived key-stat seeding/calibration uses this bridge. Native
      // writes stay on the caller's coalesced writer, so terminating the read
      // worker cannot interrupt a write transaction.
      let error: string | undefined;
      try {
        // Calibration is the one optional observability write in this bridge;
        // preserve its short busy budget instead of delaying durable writes.
        const metaKey = response.statement.args?.[0];
        const bestEffort = typeof metaKey === "string" && metaKey.startsWith("farm_helper_proxy_calibration:");
        await exec(pending.writeDb, response.statement.sql, response.statement.args, { bestEffort });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        logWarn("farm_helper_thread_derived_write_failed", { error });
      }
      // Detached calibration writes can finish after the build response. The
      // worker still needs their acknowledgement to release its promise.
      if (this.worker === worker) {
        worker.postMessage({ kind: "write-result", id: pending.id, writeId: response.writeId, ...(error ? { error } : {}) } satisfies FarmHelperThreadRequest);
      }
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    if (response.kind === "error") {
      this.failed += 1;
      this.lastError = response.error;
      logWarn("farm_helper_thread_build_failed", { error: response.error });
      pending.reject(new FarmHelperBuildError(response.error));
    } else {
      this.completed += 1;
      pending.timings?.merge(response.timings);
      pending.resolve(response.result);
    }
    worker.unref();
    this.dispatch();
  }

  private fail(cause: unknown, terminate = true): void {
    const error = new FarmHelperBuildError(cause instanceof Error ? cause.message : String(cause));
    this.lastError = error.message;
    this.brokenUntil = Date.now() + RESPAWN_COOLDOWN_MS;
    if (!this.closed) logWarn("farm_helper_thread_unavailable", { error: error.message });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const pending of [...(this.active ? [this.active] : []), ...this.waiting]) {
      this.failed += 1;
      pending.reject(error);
    }
    this.active = null;
    this.waiting = [];
    const worker = this.worker;
    this.worker = null;
    if (worker && terminate) void worker.terminate().catch(() => undefined);
  }
}

const threads = new WeakMap<Db, FarmHelperBuildThread>();

// Registration is explicit: server.ts opts serving connections in, including
// source-mode development. Unregistered offline/test callers compute inline.
export function registerFarmHelperBuildThread(db: Db, config: FarmHelperThreadConfig): FarmHelperBuildThread | null {
  if (!config.databaseUrl.startsWith("file:") || config.databaseUrl === "file::memory:") return null;
  let thread = threads.get(db);
  if (!thread) {
    thread = new FarmHelperBuildThread({ databaseUrl: config.databaseUrl });
    threads.set(db, thread);
  }
  return thread;
}

export function getFarmHelperBuildThread(db: Db): FarmHelperBuildThread | null {
  return threads.get(db) ?? null;
}

export function invalidateFarmHelperThreadCaches(db: Db): void {
  threads.get(db)?.invalidateCaches();
}
