// Worker-thread entry for building the /packs/collections economy roll-up off
// the server's event loop.
//
// Local libsql runs every query synchronously on the calling thread, so the
// group-bys behind this page (millions of ownership rows, ~12s serialised
// against the production database when cold) freeze the whole process while
// they run — not just this page but every other request, which is how a
// two-minute refresh turned into a site-wide stall. Running the scans here
// keeps the main thread serving while they happen. The thread opens its own
// libsql connection to the same database file, exactly like the maps snapshot
// thread does.
import { parentPort, workerData } from "node:worker_threads";
import { createDb } from "../db.js";
import { buildPackCardSnapshot, buildPackCollectorSnapshotWire, buildPackCommunityTotals } from "./pack-community.js";
import { reconcilePackCommunityRollupsQuietly } from "./pack-community-rollups.js";
import type { PackCommunityThreadRequest, PackCommunityThreadResponse } from "./pack-community-thread.js";

interface PackCommunityThreadInit {
  databaseUrl: string;
  sqliteBusyTimeoutMs?: number;
  sqliteSynchronous?: string;
  sqliteCacheMb?: number;
  sqliteMmapMb?: number;
}

const port = parentPort;
if (!port) throw new Error("pack-community-thread-worker must run as a worker thread");

const init = workerData as PackCommunityThreadInit;
const connection = createDb(init);

/* One build at a time. Both snapshots are asked for on the same tick, and this
   thread's libsql connection runs every query synchronously anyway, so handling
   them concurrently only interleaves two scans and two reconciles for no gain.
   handle() resolves either way, so nothing can wedge the queue. */
let queue: Promise<void> = Promise.resolve();
port.on("message", (request: PackCommunityThreadRequest) => {
  queue = queue.then(() => handle(request));
});

async function handle(request: PackCommunityThreadRequest): Promise<void> {
  try {
    const db = await connection;
    /* Bring the maintained roll-up level with the ownership table first. This
       is the one place in the backend that writes those tables: the reconcile
       is small and owner-scoped, and running it here keeps it off both the
       serving event loop and the connection score ingest writes on.
       The totals build asks for this every twenty seconds, which is also what
       keeps the dirty tables from ever holding more than a few pulls' worth. */
    await reconcilePackCommunityRollupsQuietly(db, request.now);
    const snapshot = request.kind === "collector"
      ? await buildPackCollectorSnapshotWire(db, request.now)
      : request.kind === "card"
        ? await buildPackCardSnapshot(db, request.now)
        : await buildPackCommunityTotals(db, request.now);
    // Serialised here rather than on the main thread: these bytes are both the
    // message and what the disk cache stores, so the receiving side never pays
    // a stringify and the transfer is zero-copy.
    const json = Buffer.from(JSON.stringify(snapshot), "utf8");
    const body = new Uint8Array(json.buffer, json.byteOffset, json.byteLength);
    const ownsBuffer = json.byteOffset === 0 && json.byteLength === json.buffer.byteLength;
    port!.postMessage(
      { id: request.id, ok: true, json: body } satisfies PackCommunityThreadResponse,
      ownsBuffer ? [json.buffer as ArrayBuffer] : [],
    );
  } catch (error) {
    port!.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies PackCommunityThreadResponse);
  }
}
