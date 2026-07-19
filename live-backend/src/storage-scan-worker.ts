// Worker-thread entry for the admin storage-breakdown scan. dbstat walks the
// page metadata of every table and index, which on a multi-GB file is minutes
// of work — and local libsql executes queries synchronously on the calling
// thread, so running the walk on the serving event loop froze the whole site
// for its duration. The thread opens its own read connection to the same file
// (WAL handles the concurrency) and posts back the aggregated per-table sizes.
//
// The walk is deliberately gentle: one dbstat query per btree (table or index)
// instead of one monolithic statement, with a pause between chunks matching
// the time the chunk took (~50% duty cycle, capped). A single multi-minute
// statement holds one read snapshot the whole time — pinning the WAL against
// truncation — and saturates the disk so hard that the ingest process's write
// transactions stretch past other connections' busy budgets. Short chunks
// release the snapshot between btrees and leave the disk breathing room.
import { parentPort, workerData } from "node:worker_threads";
import { createDb, exec } from "./db.js";

export interface StorageScanInit {
  databaseUrl: string;
}

export type StorageScanResult =
  | { ok: true; tables: Array<{ name: string; bytes: number }> }
  | { ok: false; error: string };

const CHUNK_PAUSE_MAX_MS = 3_000;

const port = parentPort;
if (!port) throw new Error("storage-scan-worker must run as a worker thread");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

void (async () => {
  let result: StorageScanResult;
  try {
    const init = workerData as StorageScanInit;
    const db = await createDb({ databaseUrl: init.databaseUrl, sqliteCacheMb: 8, sqliteMmapMb: 0 });
    const btrees = (await exec(
      db,
      "select name, tbl_name from sqlite_master where type in ('table', 'index')",
    )).rows;
    const byTable = new Map<string, number>();
    for (const btree of btrees) {
      const startedAt = Date.now();
      const row = (await exec(
        db,
        "select sum(pgsize) as bytes from dbstat where name = ?",
        [String(btree.name)],
      )).rows[0];
      const table = String(btree.tbl_name);
      byTable.set(table, (byTable.get(table) ?? 0) + Number(row?.bytes ?? 0));
      await sleep(Math.min(CHUNK_PAUSE_MAX_MS, Date.now() - startedAt));
    }
    const tables = [...byTable.entries()]
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    result = { ok: true, tables };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(result);
})();
