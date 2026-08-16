// Worker-thread entry for the admin analytics monitor scan set. Local libsql
// executes queries synchronously on the calling thread, and a large-range scan
// over a multi-hundred-MB events file is seconds of work — enough to stall
// every request and SSE write when run on the serving event loop. The thread
// opens its own read connection to the analytics file (WAL handles the
// concurrency with the main thread's batched writer, which flushes before the
// thread is spawned) and posts back the finished, display-ready payload.
import { parentPort, workerData } from "node:worker_threads";
import { createDb, type Db } from "../db.js";
import { computeMonitorSnapshot, type AnalyticsMonitorResponse, type MonitorComputeOptions } from "./analytics.js";

export interface MonitorScanInit {
  databaseUrl: string;
  options: MonitorComputeOptions;
  params: { rangeHours: number; recentCountry?: string | null; recentLimit?: number; now: number };
}

export type MonitorScanResult =
  | { ok: true; data: AnalyticsMonitorResponse }
  | { ok: false; error: string };

const port = parentPort;
if (!port) throw new Error("analytics-monitor-worker must run as a worker thread");

void (async () => {
  let result: MonitorScanResult;
  let db: Db | null = null;
  try {
    const init = workerData as MonitorScanInit;
    db = await createDb({ databaseUrl: init.databaseUrl, sqliteCacheMb: 8, sqliteMmapMb: 0 });
    result = { ok: true, data: await computeMonitorSnapshot(db, init.options, init.params) };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(result);
  // The thread ends itself rather than waiting to be terminated: a scan that
  // outran the parent's patience is still inside a synchronous libsql call, and
  // killing the thread there leaves a pending exception the native binding
  // asserts on — a Rust panic that aborts the whole serving process, not just
  // this thread. So the parent stops listening and this closes up on its own.
  try {
    db?.close();
  } catch {
    // The handle dies with the thread either way.
  }
  port.close();
})();
