import type { Worker } from "node:worker_threads";
import { createModuleWorker } from "../module-worker.js";
import { errorContext, logWarn } from "../logger.js";
import type { MsdOptions, MsdResult } from "./msd.js";

export interface MsdThreadRequest {
  id: number;
  osuText: string;
  options: MsdOptions;
}

export type MsdThreadResponse =
  | { ok: true; id: number; result: MsdResult }
  | { ok: false; id: number; error: string };

export class MsdThreadUnavailableError extends Error {}

// One persistent isolate per process, with one active request. Its watchdog
// starts after queueing, so time spent behind other jobs cannot kill a healthy
// calculation. Failures reject; they never fall back to main-thread WASM.
export class MsdThread {
  private worker: Worker | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private brokenUntil = 0;
  private closed = false;
  private pending: {
    id: number;
    resolve: (result: MsdResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  compute(osuText: string, options: MsdOptions): Promise<MsdResult> {
    const run = this.chain.then(() => this.dispatch(osuText, options));
    this.chain = run.catch(() => {});
    return run;
  }

  close(): void {
    this.closed = true;
    this.dispose(new MsdThreadUnavailableError("MSD thread closed"));
  }

  private dispatch(osuText: string, options: MsdOptions): Promise<MsdResult> {
    if (this.closed) return Promise.reject(new MsdThreadUnavailableError("MSD thread closed"));
    if (Date.now() < this.brokenUntil) return Promise.reject(new MsdThreadUnavailableError("MSD thread cooling down"));
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      this.fail(error);
      return Promise.reject(new MsdThreadUnavailableError(error instanceof Error ? error.message : String(error)));
    }
    const id = this.nextId++;
    return new Promise<MsdResult>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("MSD calculation timed out after 120000ms")), 120_000);
      this.pending = { id, resolve, reject, timer };
      // Keep scripts awaiting a calculation alive; idle workers do not prevent
      // shutdown. Production already has listeners, but maintenance tools may not.
      worker.ref();
      try {
        worker.postMessage({ id, osuText, options } satisfies MsdThreadRequest);
      } catch (error) {
        this.fail(error);
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createModuleWorker(new URL("./msd-thread-worker.js", import.meta.url));
    this.worker = worker;
    worker.on("message", (response: MsdThreadResponse) => {
      if (this.worker !== worker || this.pending?.id !== response.id) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      worker.unref();
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    });
    worker.on("error", (error) => {
      if (this.worker === worker) this.fail(error);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.fail(new Error(`MSD thread exited with code ${code}`));
    });
    worker.unref();
    return worker;
  }

  private fail(error: unknown): void {
    this.brokenUntil = Date.now() + 60_000;
    logWarn("msd_thread_unavailable", errorContext(error));
    this.dispose(new MsdThreadUnavailableError(error instanceof Error ? error.message : String(error)));
  }

  private dispose(error: Error): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    const worker = this.worker;
    this.worker = null;
    // This isolate owns no database or writes; interrupting a wedged WASM
    // calculation cannot abandon a transaction or lose a projection update.
    if (worker) void worker.terminate().catch(() => {});
  }
}

const thread = new MsdThread();
export function computeMsdOnThread(osuText: string, options: MsdOptions): Promise<MsdResult> {
  return thread.compute(osuText, options);
}
