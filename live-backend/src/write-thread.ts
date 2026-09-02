import { Worker } from "node:worker_threads";
import { createDb, RECONNECT, type Db, type ReconnectHook, type ReconnectReason } from "./db.js";
import { errorContext, logInfo, logWarn } from "./logger.js";
import {
  createCoalescedDb,
  createInlineWriteExecutor,
  deserializeError,
  WriteCoalescer,
  type GroupOutcome,
  type SerializedError,
  type WriteExecutor,
  type WriteGroup,
} from "./write-coalescer.js";

/*
 * The serving process's dedicated writer: one worker thread holding the write
 * connections (main database + journal), fed by a WriteCoalescer per target.
 * Local libsql runs every statement synchronously on the calling thread, so
 * on the main thread a write that lands while another process holds the WAL
 * lock parks the whole event loop inside SQLite's busy wait (the 2026-08-29
 * saturation freeze). On this thread the same wait costs nobody anything: the
 * main thread awaits a message, requests and SSE writes keep flowing, and the
 * coalescer merges everything that queued up meanwhile into the next
 * transaction.
 *
 * The thread is never terminate()d. A libsql call interrupted by
 * Worker.terminate() leaves a pending exception the native binding asserts
 * on, which aborts the whole process (prod, 2026-08-16, the analytics
 * monitor thread). Shutdown asks it to close and lets it exit on its own; a
 * thread that dies on its own is respawned on the next write.
 *
 * Source-mode (tsx dev, vitest) has no compiled worker file, so the same
 * coalescer runs an inline executor over a connection on the calling thread:
 * batching still applies, the busy wait blocks as it always did there.
 */

export type WriteTarget = "main" | "journal";

export interface WriteConnectionConfig {
  databaseUrl: string;
  databaseAuthToken?: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
}

export interface WriteThreadInit {
  targets: Partial<Record<WriteTarget, WriteConnectionConfig>>;
}

export type WriteThreadRequest =
  | { id: number; kind: "run"; target: WriteTarget; groups: WriteGroup[] }
  | { id: number; kind: "reopen"; target: WriteTarget }
  | { id: number; kind: "close" };

export type WriteThreadResponse =
  | { id: number; ok: true; outcomes?: GroupOutcome[]; reopened?: boolean }
  | { id: number; ok: false; error: SerializedError };

const RESPAWN_MIN_INTERVAL_MS = 1_000;

interface PendingRequest {
  resolve: (response: WriteThreadResponse) => void;
  reject: (error: Error) => void;
}

export interface WriteThreadStatus {
  mode: "thread" | "inline";
  alive: boolean;
  spawns: number;
  exits: number;
  lastExitCode: number | null;
  lastError: string | null;
  inFlight: number;
}

export class WriteThread {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closing = false;
  private spawns = 0;
  private exits = 0;
  private lastExitCode: number | null = null;
  private lastError: string | null = null;
  private lastSpawnAt = 0;

  constructor(private readonly init: WriteThreadInit) {}

  static available(): boolean {
    return !import.meta.url.endsWith(".ts");
  }

  status(): WriteThreadStatus {
    return {
      mode: "thread",
      alive: this.worker != null,
      spawns: this.spawns,
      exits: this.exits,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      inFlight: this.pending.size,
    };
  }

  executor(target: WriteTarget): WriteExecutor {
    return async (groups) => {
      const response = await this.request({ id: 0, kind: "run", target, groups });
      if (!response.ok) throw deserializeError(response.error);
      return response.outcomes ?? [];
    };
  }

  async reopen(target: WriteTarget): Promise<boolean> {
    const response = await this.request({ id: 0, kind: "reopen", target });
    return response.ok && response.reopened === true;
  }

  /** Asks the thread to close its connections and exit; never terminates. */
  close(): void {
    this.closing = true;
    const worker = this.worker;
    if (!worker) return;
    try {
      worker.postMessage({ id: this.nextId++, kind: "close" } satisfies WriteThreadRequest);
    } catch {
      // Already gone.
    }
  }

  private request(request: WriteThreadRequest): Promise<WriteThreadResponse> {
    if (this.closing) return Promise.reject(new Error("write thread is closing"));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<WriteThreadResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...request, id } satisfies WriteThreadRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const now = Date.now();
    if (now - this.lastSpawnAt < RESPAWN_MIN_INTERVAL_MS && this.spawns > 0) {
      throw new Error(`SQLITE_BUSY: write thread is respawning (${this.lastError ?? "exited"})`);
    }
    this.lastSpawnAt = now;
    this.spawns += 1;
    const worker = new Worker(new URL("./write-thread-worker.js", import.meta.url), { workerData: this.init });
    // The thread must never keep an exiting process alive.
    worker.unref();
    worker.on("message", (response: WriteThreadResponse) => {
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      entry.resolve(response);
    });
    worker.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      logWarn("write_thread_error", errorContext(error));
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.exits += 1;
      this.lastExitCode = code;
      const reason = `write thread exited with code ${code}`;
      if (!this.closing) logWarn("write_thread_exited", { code, in_flight: this.pending.size });
      // Every caller retries on its own budget (the busy-retry loop in db.ts),
      // which is exactly the right reaction to a writer that went away.
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        entry.reject(new Error(`SQLITE_BUSY: ${reason}`));
      }
    });
    this.worker = worker;
    if (this.spawns > 1) logInfo("write_thread_respawned", { spawns: this.spawns });
    return worker;
  }
}

export interface ServeWriteConnections {
  main: Db;
  journal: Db | null;
  status: () => WriteThreadStatus;
  close: () => void;
}

export interface ServeWriteOptions {
  coalesceMs: number;
  useThread: boolean;
}

/**
 * The serving process's write connections: a coalesced Db per target, backed
 * by the write thread when it can run (compiled dist) and by an inline
 * connection otherwise.
 */
export async function createServeWriteConnections(init: WriteThreadInit, options: ServeWriteOptions): Promise<ServeWriteConnections> {
  const mainConfig = init.targets.main;
  if (!mainConfig) throw new Error("serve write connections need a main target");
  if (options.useThread && WriteThread.available()) {
    const thread = new WriteThread(init);
    const build = (target: WriteTarget) => createCoalescedDb(
      new WriteCoalescer(thread.executor(target), { coalesceMs: options.coalesceMs }),
      {
        reconnect: () => thread.reopen(target).catch(() => false),
      },
    );
    return {
      main: build("main"),
      journal: init.targets.journal ? build("journal") : null,
      status: () => thread.status(),
      close: () => thread.close(),
    };
  }
  const opened: Db[] = [];
  const build = async (config: WriteConnectionConfig) => {
    const db = await createDb(config);
    opened.push(db);
    return createCoalescedDb(
      new WriteCoalescer(createInlineWriteExecutor(db), { coalesceMs: options.coalesceMs }),
      {
        reconnect: (reason) => reopenInline(db, reason),
        close: () => db.close(),
      },
    );
  };
  const main = await build(mainConfig);
  const journal = init.targets.journal ? await build(init.targets.journal) : null;
  return {
    main,
    journal,
    status: () => ({ mode: "inline", alive: true, spawns: 0, exits: 0, lastExitCode: null, lastError: null, inFlight: 0 }),
    close: () => {
      for (const db of opened) {
        try {
          db.close();
        } catch {
          // ignore close races on shutdown
        }
      }
    },
  };
}

async function reopenInline(db: Db, reason: ReconnectReason): Promise<boolean> {
  const hook = (db as unknown as Record<symbol, unknown>)[RECONNECT] as ReconnectHook | undefined;
  if (!hook) return false;
  try {
    return await hook(reason);
  } catch {
    return false;
  }
}
