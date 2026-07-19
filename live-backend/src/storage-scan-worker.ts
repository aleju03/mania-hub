// Worker-thread entry for the admin storage-breakdown scan. dbstat walks the
// page metadata of every table and index, which on a multi-GB file is tens of
// seconds of work — and local libsql executes queries synchronously on the
// calling thread, so running the walk on the serving event loop freezes every
// request until it finishes. The thread opens its own read connection to the
// same file (WAL handles the concurrency) and posts back the aggregated
// per-table sizes, then exits.
import { parentPort, workerData } from "node:worker_threads";
import { createDb, exec } from "./db.js";

export interface StorageScanInit {
  databaseUrl: string;
}

export type StorageScanResult =
  | { ok: true; tables: Array<{ name: string; bytes: number }> }
  | { ok: false; error: string };

const port = parentPort;
if (!port) throw new Error("storage-scan-worker must run as a worker thread");

void (async () => {
  let result: StorageScanResult;
  try {
    const init = workerData as StorageScanInit;
    const db = await createDb({ databaseUrl: init.databaseUrl, sqliteCacheMb: 8, sqliteMmapMb: 0 });
    const rows = (await exec(
      db,
      `select m.tbl_name as name, sum(d.pgsize) as bytes
       from dbstat d
       join sqlite_master m on m.name = d.name
       where m.type in ('table', 'index')
       group by m.tbl_name
       order by bytes desc`,
    )).rows;
    result = { ok: true, tables: rows.map((row) => ({ name: String(row.name), bytes: Number(row.bytes ?? 0) })) };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(result);
})();
