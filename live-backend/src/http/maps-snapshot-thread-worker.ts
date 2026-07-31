// Worker-thread entry for building GLOBAL maps-page responses off the server's
// event loop. Local libsql runs every query synchronously on the calling
// thread, and a GLOBAL maps page can require a multi-second payload parse and
// hydrate. Running the whole build here keeps the main thread serving requests
// while it happens. The thread opens its own libsql connection to the same
// database file (WAL handles the concurrency, exactly like the split worker
// process does).
import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "../db.js";
import { JobQueue } from "../jobs/queue.js";
import { enqueueGlobalFarmedBoardRepack, getMapsPageSnapshot, registerGlobalFarmedBoardDiskCache, registerGlobalFarmedBoardRepackDelegation } from "../features/maps.js";
import { prepareJsonResponse } from "./prepared-json.js";
import type { MapsSnapshotThreadRequest, MapsSnapshotThreadResponse } from "./maps-snapshot-thread.js";

interface MapsSnapshotThreadInit {
  databaseUrl: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
  delegateBoardRepacks?: boolean;
}

const port = parentPort;
if (!port) throw new Error("maps-snapshot-thread-worker must run as a worker thread");

const init = workerData as MapsSnapshotThreadInit;
const connection = (async () => {
  const db = await createDb(init);
  // This thread is where the packed GLOBAL farmed board lives in production;
  // registering enables its disk snapshot (persist on pack, restore at boot).
  registerGlobalFarmedBoardDiskCache(db, init.databaseUrl);
  const queue = new JobQueue(db);
  if (init.delegateBoardRepacks) {
    // Full repacks balloon whichever isolate runs them by ~1.4GB of pages that
    // never return to the OS — and this thread lives inside the serving
    // process. Delegate to the worker process; enqueueing on this thread's own
    // connection is fine, it serialises with the builds anyway.
    registerGlobalFarmedBoardRepackDelegation(db, () => enqueueGlobalFarmedBoardRepack(queue));
  }
  return { db, queue };
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
    const snapshot = await getMapsPageSnapshot(db, queue, request.country, request.maxAgeMs, request.query);
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
