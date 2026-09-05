import { parentPort, workerData } from "node:worker_threads";
import { createClient } from "@libsql/client";
import type { Db, DbStatement } from "../db.js";
import { clearFarmHelperCache, computeFarmHelperRecommendations } from "./farm-helper.js";
import { clearFarmHelperKeyStatsCaches } from "./farm-helper-key-stats.js";
import { FarmHelperTimings } from "./farm-helper-timing.js";
import type { FarmHelperThreadConfig, FarmHelperThreadRequest, FarmHelperThreadResponse } from "./farm-helper-thread.js";

const port = parentPort;
if (!port) throw new Error("farm-helper-thread-worker must run in a worker thread");
const config = workerData as FarmHelperThreadConfig;
// query_only is connection-local. No migrations or writes run on this handle.
const db = createClient({ url: config.databaseUrl });
const ready = db.executeMultiple("pragma query_only = on; pragma busy_timeout = 0; pragma cache_size = -32768; pragma mmap_size = 0;");
let generation = -1;
let nextWriteId = 1;
const writes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

function respond(response: FarmHelperThreadResponse): void {
  port!.postMessage(response);
}

port.on("message", (request: FarmHelperThreadRequest) => {
  if (request.kind === "write-result") {
    const pending = writes.get(request.writeId);
    if (!pending) return;
    writes.delete(request.writeId);
    // The serving writer already exhausted the appropriate retry budget. Do
    // not expose SQLITE_BUSY in the outer message: exec() on this proxy would
    // retry again, possibly after a detached calibration's build has finished.
    if (request.error) pending.reject(new Error("Farm Helper derived-state write failed", { cause: request.error }));
    else pending.resolve();
    return;
  }
  void build(request);
});

async function build(request: Extract<FarmHelperThreadRequest, { kind: "build" }>): Promise<void> {
  // The key-stat code only needs execute(). It awaits seed writes before
  // reading the seeded rows; calibration writes are observability only.
  const writeDb = {
    execute: async (statement: DbStatement) => {
      const writeId = nextWriteId++;
      await new Promise<void>((resolve, reject) => {
        writes.set(writeId, { resolve, reject });
        respond({ kind: "write", id: request.id, writeId, statement });
      });
      return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined };
    },
  } as unknown as Db;
  try {
    await ready;
    if (generation !== request.generation) {
      clearFarmHelperCache(db);
      clearFarmHelperKeyStatsCaches(db);
      generation = request.generation;
    }
    const timings = new FarmHelperTimings();
    const result = await computeFarmHelperRecommendations(db, request.input, writeDb, timings);
    respond({ kind: "result", id: request.id, result, timings: timings.exportData() });
  } catch (error) {
    respond({ kind: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
}
