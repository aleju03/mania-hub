import { parentPort, workerData } from "node:worker_threads";
import { createClient } from "@libsql/client";
import type { ServingReadConfig, ServingReadRequest, ServingReadResponse } from "./serving-read-thread.js";

const port = parentPort;
if (!port) throw new Error("serving-read-thread-worker must run in a worker thread");
const config = workerData as ServingReadConfig;
async function open(url: string) {
  const db = createClient({ url });
  await db.executeMultiple("pragma query_only = on; pragma busy_timeout = 0; pragma cache_size = -32768; pragma mmap_size = 0;");
  return db;
}
const connection = open(config.databaseUrl);
// Only the status worker needs a journal connection or status module graph.
let journalConnection: ReturnType<typeof open> | undefined;
port.on("message", ({ id, request }: { id: number; request: ServingReadRequest }) => {
  void (async () => {
    try {
      const db = await connection;
      let result: unknown;
      switch (request.kind) {
        case "tracker": {
          const { readTrackerSnapshot } = await import("./features/tracker.js");
          result = await readTrackerSnapshot(db, request.country, request.limit, request.offset, request.options);
          break;
        }
        case "metrics": {
          const { getStreakPlayerMetrics } = await import("./features/pack-games.js");
          result = await getStreakPlayerMetrics(db, request.userIds, request.now);
          break;
        }
        case "status": {
          const { readStatusAggregates } = await import("./http/status-reads.js");
          journalConnection ??= config.journalDatabaseUrl && config.journalDatabaseUrl !== config.databaseUrl ? open(config.journalDatabaseUrl) : connection;
          result = await readStatusAggregates(db, await journalConnection, request.options);
          break;
        }
      }
      // Serialize only the finished page/metrics/aggregates here. Transferring
      // bytes avoids reconstructing thousands of raw libsql rows on the server.
      const json = new TextEncoder().encode(JSON.stringify(result));
      port.postMessage({ id, json } satisfies ServingReadResponse, [json.buffer]);
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies ServingReadResponse);
    }
  })();
});
