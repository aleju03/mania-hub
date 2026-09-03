// Worker-thread entry for building GLOBAL maps-page responses off the server's
// event loop. Local libsql runs every query synchronously on the calling
// thread, and a GLOBAL maps page can require a multi-second payload parse and
// hydrate. Running the whole build here keeps the main thread serving requests
// while it happens. The thread opens its own libsql connection to the same
// database file (WAL handles the concurrency, exactly like the split worker
// process does).
//
// The pack pool's unranked-member read and the skill leaderboard build run
// here too, for the same reason: each is a whole-roster scan plus JSON parsing
// that measured seconds of main-thread CPU per rebuild in production.
import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "../db.js";
import { JobQueue } from "../jobs/queue.js";
import { readUnrankedPoolEntries } from "../features/global-rankings.js";
import { enqueueGlobalFarmedBoardRepack, getMapsPageSnapshot, registerGlobalFarmedBoardDiskCache, registerGlobalFarmedBoardRepackDelegation } from "../features/maps.js";
import { buildSkillBoard } from "../features/skill-leaderboards.js";
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
    if (request.kind === "pack-pool-unranked") {
      respond({ id: request.id, ok: true, kind: "compute", value: await readUnrankedPoolEntries(db) });
      return;
    }
    if (request.kind === "skill-board") {
      const board = await buildSkillBoard(db);
      // The board is mostly typed-array columns; moving their buffers instead
      // of copying them keeps the hand-over to the main thread at the cost of
      // cloning the player records, not the numbers.
      respond({ id: request.id, ok: true, kind: "compute", value: board }, transferableBuffers(board));
      return;
    }
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
        kind: "maps-page",
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

/* Every ArrayBuffer backing a typed array anywhere in the value, once each. A
   view that shares its buffer with another view (or one sliced from a larger
   allocation) stays out of the list, because transferring it would detach
   memory the other view still needs; those few get cloned instead. */
function transferableBuffers(value: unknown): ArrayBuffer[] {
  const owners = new Map<ArrayBuffer, number>();
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (ArrayBuffer.isView(node)) {
      const buffer = node.buffer;
      if (!(buffer instanceof ArrayBuffer)) return;
      const wholeBuffer = node.byteOffset === 0 && node.byteLength === buffer.byteLength;
      owners.set(buffer, (owners.get(buffer) ?? 0) + (wholeBuffer ? 1 : 2));
      return;
    }
    if (node instanceof Map) {
      for (const [key, entry] of node) {
        walk(key);
        walk(entry);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    for (const entry of Object.values(node)) walk(entry);
  };
  walk(value);
  const buffers: ArrayBuffer[] = [];
  for (const [buffer, views] of owners) {
    if (views === 1) buffers.push(buffer);
  }
  return buffers;
}
