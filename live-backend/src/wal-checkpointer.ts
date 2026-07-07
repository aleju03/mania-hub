import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { createDb, type Db } from "./db.js";
import { errorContext, logInfo, logWarn } from "./logger.js";

// Active WAL brake. libsql's automatic wal_autocheckpoint only ever runs PASSIVE
// checkpoints, which apply frames but never shrink/reset the -wal file once any
// reader sits behind the checkpoint point. Under sustained cross-process reader
// load the file grew unbounded (to multi-GB) until reads slowed into a 30s
// busy-retry death-spiral that took the whole site down (2026-07-07). This runs
// on a dedicated connection in the worker/all process: when the -wal file grows
// past the threshold it forces a PASSIVE-then-TRUNCATE reset, so the file stays
// bounded and a pre-existing bloated WAL self-heals ~5s after boot — no more
// stop-both-services runbook.
//
// Only meaningful for a local file: database (Turso/remote manage the WAL
// server-side); returns a no-op stop() otherwise.
export function startWalCheckpointer(config: Config): () => void {
  const walPath = walFilePath(config.databaseUrl);
  if (!walPath) return () => {};

  const FIRST_TICK_MS = 5_000;
  let stopped = false;
  let db: Db | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const walBytes = await fileSizeOrZero(walPath);
      if (walBytes >= config.walCheckpointTruncateBytes) {
        // A dedicated connection with busy_timeout=0 (never wait on a lock) and
        // tiny cache/mmap (this box has no swap). Opened lazily so an idle WAL
        // costs nothing.
        if (!db) db = await createDb({ ...config, sqliteBusyTimeoutMs: 0, sqliteCacheMb: 2, sqliteMmapMb: 0 });
        const startedAt = Date.now();
        const { busy, checkpointed } = await runWalTruncateCheckpoint(db);
        const durationMs = Date.now() - startedAt;
        logInfo("wal_checkpoint", { wal_bytes: walBytes, busy, checkpointed, duration_ms: durationMs });
        // busy != 0 means a reader kept us from fully resetting. Fine occasionally
        // (we retry next tick), but if it persists while the WAL is large a reader
        // is pinning it — surface that instead of letting it spiral silently.
        if (busy !== 0 && walBytes >= config.walCheckpointWarnBytes) {
          logWarn("wal_checkpoint_stuck", { wal_bytes: walBytes, busy, checkpointed, duration_ms: durationMs });
        }
      }
    } catch (error) {
      logWarn("wal_checkpoint_failed", errorContext(error));
    }
    if (!stopped) setTimeout(tick, config.walCheckpointIntervalMs).unref();
  };

  setTimeout(tick, FIRST_TICK_MS).unref();
  return () => {
    stopped = true;
    try {
      db?.close();
    } catch {
      // ignore close races on shutdown
    }
  };
}

// PASSIVE first applies frames so the synchronous TRUNCATE's residual copy stays
// small; both run directly (not via the busy-retry loop) so a busy_timeout=0
// connection returns promptly instead of blocking. Returns the TRUNCATE result:
// busy=0 means the WAL fully reset; busy=1 means a reader kept it from resetting.
export async function runWalTruncateCheckpoint(db: Db): Promise<{ busy: number; checkpointed: number }> {
  await db.execute("pragma wal_checkpoint(PASSIVE)").catch(() => undefined);
  const result = await db.execute("pragma wal_checkpoint(TRUNCATE)");
  return parseCheckpointRow(result.rows[0]);
}

function walFilePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("file:")) return null;
  const rawPath = databaseUrl.slice("file:".length);
  if (!rawPath || rawPath === ":memory:") return null;
  return `${resolve(rawPath)}-wal`;
}

async function fileSizeOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

// PRAGMA wal_checkpoint returns (busy, log, checkpointed). libsql rows expose
// values by column name and by position; read defensively so a naming change
// can't break the (log-only) parse.
function parseCheckpointRow(row: unknown): { busy: number; checkpointed: number } {
  const record = row as (Record<string, unknown> & Record<number, unknown>) | undefined;
  const num = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : -1;
  };
  if (!record) return { busy: -1, checkpointed: -1 };
  return {
    busy: num(record.busy ?? record[0]),
    checkpointed: num(record.checkpointed ?? record[2]),
  };
}
