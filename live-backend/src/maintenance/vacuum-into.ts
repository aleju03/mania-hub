import { rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import type { Db } from "../db.js";

export interface VacuumIntoSwapResult {
  dbPath: string;
  /** Where the pre-vacuum file (with its -wal/-shm, if any) was moved to. */
  retiredPath: string;
  bytesBefore: number;
  bytesAfter: number;
}

export const REBUILD_SUFFIX = ".vacuum-rebuild";
export const RETIRED_SUFFIX = ".pre-vacuum";
const SIDE_FILE_SUFFIXES = ["-wal", "-shm"] as const;

/* Rebuilds the database with VACUUM INTO and swaps the copy into place.

   A plain VACUUM is not usable on this database: the bundled libsql is compiled
   with SQLITE_TEMP_STORE=2, so the transient database VACUUM copies everything
   into lives in RAM (SQLITE_TMPDIR is never consulted) and on 2026-09-12 the
   17 GB production file took the process to 7 GB of anonymous memory before
   the kernel OOM killer ended it. VACUUM INTO writes straight to a file, holds
   only a page cache, and skips the copy-back that would otherwise push the
   whole rebuilt file through the WAL, so it also needs half the disk and
   about half the time. temp_store is pinned to FILE anyway so the index sorts
   the rebuild runs spill to SQLITE_TMPDIR rather than memory.

   The caller must be the only process with the database open: the swap
   renames files underneath anyone else holding it. The old file is kept
   beside the new one (see RETIRED_SUFFIX) rather than deleted, so a bad
   rebuild is a rename away from undone. */
export async function vacuumIntoAndSwap(
  db: Db,
  databaseUrl: string,
  log: (line: string) => void = console.log,
): Promise<VacuumIntoSwapResult> {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(`VACUUM needs a file: database url, got ${databaseUrl}`);
  }
  const dbPath = resolve(databaseUrl.slice("file:".length));
  const rebuiltPath = dbPath + REBUILD_SUFFIX;
  const retiredPath = dbPath + RETIRED_SUFFIX;
  if (await exists(retiredPath)) {
    throw new Error(`${retiredPath} already exists: delete or move that earlier retired copy before vacuuming again`);
  }
  // A run that died mid-copy leaves a partial file here, and VACUUM INTO
  // refuses to write over a non-empty one.
  await rm(rebuiltPath, { force: true });
  const bytesBefore = (await stat(dbPath)).size;
  const schemaObjects = await countSchemaObjects(db);

  await db.execute("pragma temp_store = FILE");
  log(`Rebuilding ${formatBytes(bytesBefore)} into ${rebuiltPath} (VACUUM INTO)...`);
  await db.execute(`vacuum into '${rebuiltPath.replaceAll("'", "''")}'`);
  const bytesAfter = (await stat(rebuiltPath)).size;
  await prepareRebuiltFile(rebuiltPath, schemaObjects);

  // Nothing touches the old file through this connection from here on. Closing
  // it checkpoints and drops its WAL, which is what makes the rename safe.
  db.close();
  // The old -wal/-shm move with the old file. Left next to the rebuilt one,
  // SQLite would replay that WAL into the new pages on the next open.
  await rename(dbPath, retiredPath);
  for (const suffix of SIDE_FILE_SUFFIXES) {
    if (await exists(dbPath + suffix)) await rename(dbPath + suffix, retiredPath + suffix);
  }
  await rename(rebuiltPath, dbPath);
  log(`Swapped in the rebuilt file: ${formatBytes(bytesBefore)} -> ${formatBytes(bytesAfter)}.`);
  return { dbPath, retiredPath, bytesBefore, bytesAfter };
}

/* Puts the rebuilt file into WAL mode before it is swapped in (VACUUM INTO does
   not promise to carry the journal mode over, and letting two booting processes
   race to convert it is the kind of SQLITE_BUSY the boot path does not need),
   and makes sure it holds the same schema objects as the source. */
async function prepareRebuiltFile(rebuiltPath: string, expectedSchemaObjects: number): Promise<void> {
  const rebuilt = createClient({ url: `file:${rebuiltPath}` });
  try {
    const objects = await countSchemaObjects(rebuilt);
    if (objects !== expectedSchemaObjects) {
      throw new Error(`rebuilt file has ${objects} schema objects, source has ${expectedSchemaObjects}`);
    }
    const mode = String((await rebuilt.execute("pragma journal_mode = WAL")).rows[0]?.journal_mode ?? "").toLowerCase();
    if (mode !== "wal") throw new Error(`could not put the rebuilt file into WAL mode (got ${mode || "nothing"})`);
  } finally {
    rebuilt.close();
  }
  for (const suffix of SIDE_FILE_SUFFIXES) {
    const side = rebuiltPath + suffix;
    const size = await stat(side).then((stats) => stats.size).catch(() => null);
    if (size == null) continue;
    if (size > 0 && suffix === "-wal") throw new Error(`${side} still holds ${size} bytes after close; refusing to swap`);
    await rm(side, { force: true });
  }
}

async function countSchemaObjects(db: Db): Promise<number> {
  return Number((await db.execute("select count(*) as n from sqlite_master")).rows[0]?.n ?? 0);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
