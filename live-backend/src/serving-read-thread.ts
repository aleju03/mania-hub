import type { Worker } from "node:worker_threads";
import type { Db } from "./db.js";
import { createModuleWorker } from "./module-worker.js";
import { logWarn } from "./logger.js";
import type { TrackerSnapshotOptions, getTrackerSnapshot } from "./features/tracker.js";
import type { StreakPlayerMetrics } from "./features/pack-games.js";
import type { StatusReadOptions, readStatusAggregates } from "./http/status-reads.js";
import type { PackCollectionOptions, PackCollectionPage } from "./features/pack-wallets.js";
import type { DanEvidenceOptions, PlayerSkillBreakdown, PlayerSkillPlaysOptions, PlayerSkillPlaysPage, readPlayerSkillDanEvidence } from "./features/player-skills.js";
import type { PublicPlayerSkillBreakdown } from "./features/skill-baseline.js";

export type ServingReadRequest =
  | { kind: "tracker"; country: string; limit: number; offset: number; options: TrackerSnapshotOptions }
  | { kind: "metrics"; userIds: number[]; now: number }
  | { kind: "status"; options: StatusReadOptions }
  | { kind: "packCollection"; userId: number; options: PackCollectionOptions }
  | { kind: "skillPlays"; userId: number; keyCount: number; axis: string; options: PlayerSkillPlaysOptions }
  | { kind: "danEvidence"; userId: number; keyCount: number; side: "rc" | "ln"; options: DanEvidenceOptions }
  | { kind: "skillDecoration"; userId: number; breakdown: PlayerSkillBreakdown };
export interface ServingReadResults {
  tracker: Awaited<ReturnType<typeof getTrackerSnapshot>>;
  metrics: Record<number, StreakPlayerMetrics>;
  status: Awaited<ReturnType<typeof readStatusAggregates>>;
  packCollection: PackCollectionPage;
  skillPlays: PlayerSkillPlaysPage;
  danEvidence: Awaited<ReturnType<typeof readPlayerSkillDanEvidence>>;
  skillDecoration: PublicPlayerSkillBreakdown;
}
export type ServingReadResponse = { id: number; json: Uint8Array } | { id: number; error: string };
export interface ServingReadConfig { databaseUrl: string; journalDatabaseUrl?: string }
export class ServingReadError extends Error {}

interface PendingRead {
  id: number;
  request: ServingReadRequest;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

// Independent queues for tracker, status, arcade, shelves and profile skills.
// Each has one active read and a bounded backlog; profile operations share one.
export class ServingReadThread {
  private worker: Worker | null = null;
  private active: PendingRead | null = null;
  private waiting: PendingRead[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private brokenUntil = 0;
  private closed = false;

  constructor(private readonly config: ServingReadConfig) {}

  run<K extends ServingReadRequest["kind"]>(request: Extract<ServingReadRequest, { kind: K }>): Promise<ServingReadResults[K]> {
    if (this.closed || Date.now() < this.brokenUntil || this.waiting.length + (this.active ? 1 : 0) >= 16) {
      return Promise.reject(new ServingReadError("Snapshot reader is busy or temporarily unavailable"));
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ id: this.nextId++, request, resolve: (result) => resolve(result as ServingReadResults[K]), reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.fail(new Error("Snapshot reader closed"));
  }

  private dispatch(): void {
    if (this.active || !this.waiting.length) return;
    this.active = this.waiting.shift()!;
    try {
      if (!this.worker) {
        const worker = createModuleWorker(new URL("./serving-read-thread-worker.js", import.meta.url), { workerData: this.config });
        this.worker = worker;
        worker.on("message", (response: ServingReadResponse) => {
          if (this.worker !== worker || this.active?.id !== response.id) return;
          const pending = this.active;
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.active = null;
          try {
            if ("error" in response) pending.reject(new ServingReadError(response.error));
            else pending.resolve(JSON.parse(Buffer.from(response.json.buffer, response.json.byteOffset, response.json.byteLength).toString("utf8")));
          } catch (error) {
            pending.reject(new ServingReadError(String(error)));
          }
          worker.unref();
          this.dispatch();
        });
        worker.on("error", (error) => { if (this.worker === worker) void this.fail(error); });
        worker.on("exit", (code) => { if (this.worker === worker) void this.fail(new Error(`Snapshot reader exited with code ${code}`)); });
      }
      this.worker.ref();
      this.timer = setTimeout(() => { void this.fail(new Error("Snapshot read timed out after 60000ms")); }, 60_000);
      this.worker.postMessage({ id: this.active.id, request: this.active.request });
    } catch (error) {
      void this.fail(error);
    }
  }

  private async fail(cause: unknown): Promise<void> {
    const error = new ServingReadError(cause instanceof Error ? cause.message : String(cause));
    this.brokenUntil = Date.now() + 30_000;
    if (!this.closed) logWarn("serving_read_thread_unavailable", { error: error.message });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const pending of [...(this.active ? [this.active] : []), ...this.waiting]) pending.reject(error);
    this.active = null;
    this.waiting = [];
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

type ReadThreads = Record<ServingReadRequest["kind"], ServingReadThread>;
const threads = new WeakMap<Db, ReadThreads>();

// Like Farm Helper, only serving handles opt in. Offline tools and in-memory
// tests retain direct reads. Registered handles never fall back after failure.
export function registerServingReadThreads(db: Db, config: ServingReadConfig, aliases: Db[] = []): ReadThreads | null {
  if (!config.databaseUrl.startsWith("file:") || config.databaseUrl === "file::memory:") return null;
  let readers = threads.get(db);
  if (!readers) {
    const init = { databaseUrl: config.databaseUrl, journalDatabaseUrl: config.journalDatabaseUrl };
    const profiles = new ServingReadThread(init);
    readers = {
      tracker: new ServingReadThread(init), metrics: new ServingReadThread(init), status: new ServingReadThread(init),
      packCollection: new ServingReadThread(init),
      skillPlays: profiles, danEvidence: profiles, skillDecoration: profiles,
    };
    threads.set(db, readers);
  }
  for (const alias of aliases) threads.set(alias, readers);
  return readers;
}

export function getServingReadThread(db: Db, kind: ServingReadRequest["kind"]): ServingReadThread | null {
  return threads.get(db)?.[kind] ?? null;
}
