import { readSchemaMigrationState, SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS, type Db } from "./db.js";
import { logInfo, logWarn } from "./logger.js";

// Shared scaffolding for the boot-time board warm-ups: caches that cost seconds
// to build and would otherwise be built inside the first visitor's request.

// How long a warm-up waits before touching the database at all. A deploy's
// schema migration on a small box starves the writer of CPU and page cache, so
// no constant can separate "boot burst" from "migration in flight": the floor
// below is only the boot-burst settle time, and waitForQuietSchema observes the
// migration itself.
export const BOARD_WARMUP_DELAY_MS = 15_000;
const BOARD_WARMUP_POLL_MS = 5_000;
// Never poll longer than the window in which a migration could still be making
// progress: past that the worker has either finished, died (systemd restarts
// it), or left a stale in-flight marker behind, and none of those is a reason
// to leave a board cold forever.
const BOARD_WARMUP_MAX_WAIT_MS = SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS + 60_000;

// unref'd so a pending warm-up never holds the process open (the headless worker
// role and every test rely on the event loop draining on its own).
export function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/* Blocks while a worker/all-role process is inside migrate(). By the time this
   first runs the delay above has elapsed, which is far longer than a restarting
   worker needs to reach its in-flight marker (written right after the initial
   schema), so "no marker in flight" here really does mean nobody is migrating.
   `board` names the caller in the logs. */
export async function waitForQuietSchema(db: Db, board: string): Promise<void> {
  const startedAt = Date.now();
  let polls = 0;
  for (;;) {
    const state = await readSchemaMigrationState(db);
    if (!state || state.completedAt) {
      if (polls > 0) {
        logInfo("board_warmup_waited", {
          board,
          detail: "deferred the build until the schema migration finished",
          waited_ms: Date.now() - startedAt,
        });
      }
      return;
    }
    const migrationAgeMs = Date.now() - Date.parse(state.startedAt);
    const stale = !Number.isFinite(migrationAgeMs) || migrationAgeMs > BOARD_WARMUP_MAX_WAIT_MS;
    if (stale || Date.now() - startedAt >= BOARD_WARMUP_MAX_WAIT_MS) {
      logWarn("board_warmup_impatient", {
        board,
        detail: "schema migration still marked in flight; building anyway",
        migration_started_at: state.startedAt,
        waited_ms: Date.now() - startedAt,
      });
      return;
    }
    polls += 1;
    await unrefDelay(BOARD_WARMUP_POLL_MS);
  }
}
