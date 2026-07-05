// Worker-thread entry for building maps snapshot responses off the server's
// event loop. Local libsql runs every query synchronously on the calling
// thread, and the GLOBAL maps hydrate is the heaviest read in the process
// (~10-15s: a multi-MB payload_json parse, hydrate, JSON.stringify of a
// ~136MB body, compression). Running the whole build here keeps the main
// thread serving requests while it happens. The thread opens its own libsql
// connection to the same database file (WAL handles the concurrency, exactly
// like the split worker process does).
import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "../db.js";
import { JobQueue } from "../jobs/queue.js";
import { getMapsPageSnapshot, getMapsSnapshot } from "../features/maps.js";
import { prepareJsonResponse } from "./prepared-json.js";
import type { MapsSnapshotThreadRequest, MapsSnapshotThreadResponse } from "./maps-snapshot-thread.js";

interface MapsSnapshotThreadInit {
  databaseUrl: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
}

const port = parentPort;
if (!port) throw new Error("maps-snapshot-thread-worker must run as a worker thread");

const init = workerData as MapsSnapshotThreadInit;
const connection = (async () => {
  const db = await createDb(init);
  return { db, queue: new JobQueue(db) };
})();

port.on("message", (request: MapsSnapshotThreadRequest) => {
  void handle(request);
});

async function handle(request: MapsSnapshotThreadRequest): Promise<void> {
  const respond = (response: MapsSnapshotThreadResponse, transfer: ArrayBuffer[] = []): void => {
    port!.postMessage(response, transfer);
  };
  try {
    const { db, queue } = await connection;
    const snapshot = request.kind === "maps"
      ? await getMapsSnapshot(db, queue, request.country, request.maxAgeMs, request.section)
      : await getMapsPageSnapshot(db, queue, request.country, request.maxAgeMs, request.query);
    const status = snapshot.value ? 200 : 202;
    const prepared = await prepareJsonResponse(status, snapshot, request.encoding);
    // Transfer the body's ArrayBuffer when the Buffer owns it outright (large
    // bodies do); small pooled Buffers fall back to a structured-clone copy.
    const ownsBuffer = prepared.body.byteOffset === 0 && prepared.body.byteLength === prepared.body.buffer.byteLength;
    respond(
      {
        id: request.id,
        ok: true,
        status: prepared.status,
        encoding: prepared.encoding,
        vary: prepared.vary,
        body: prepared.body,
      },
      ownsBuffer ? [prepared.body.buffer as ArrayBuffer] : [],
    );
  } catch (error) {
    respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
