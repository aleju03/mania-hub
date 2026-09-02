import { readConfig } from "../config.js";
import { createDb, exec, json, logApiCall, migrate } from "../db.js";
import { ensureJournalSchema } from "../journal.js";
import {
  OSU_FILE_REPAIR_META_KEY,
  OSU_FILE_REPAIR_PROGRESS_META_KEY,
  invalidateOsuFileRepairDerivatives,
  readOsuFileRepairAffectedBeatmapIds,
  readOsuFileRepairProgress,
  repairMismatchedOsuFilesChunk,
} from "../features/chart-analysis.js";
import { JobQueue } from "../jobs/queue.js";
import { OsuApiClient } from "../osu/client.js";
import { SqliteSharedRateLimiter } from "../osu/shared-rate-limiter.js";
import { nowIso } from "../shared/score.js";

// Manual/inspection wrapper around the wrong-difficulty .osu repair sweep. The
// backend runs the same sweep automatically at boot as a self-chaining job (see
// ensureOsuFileRepairSeeded in features/chart-analysis.ts); this script exists
// for --dry-run auditing and for running it flat out by hand.
//
// Usage: npm run repair:osu-files          (add --dry-run to only report)

const dryRun = process.argv.includes("--dry-run");

const config = readConfig();
const db = await createDb(config);
const rateLimitDb = await createDb({ databaseUrl: config.journalDatabaseUrl, sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs, sqliteCacheMb: 2, sqliteMmapMb: 0 });
await ensureJournalSchema(rateLimitDb);
await migrate(db);
const queue = new JobQueue(db);

const sharedLimiter = new SqliteSharedRateLimiter(rateLimitDb, {
  provider: "osu",
  targetPerMinute: config.osuApiTargetPerMinute,
  hardPerMinute: config.osuApiHardPerMinute,
});
const osu = new OsuApiClient(config, fetch, (entry) => {
  void logApiCall(rateLimitDb, {
    provider: "osu",
    caller: entry.caller,
    path: entry.path,
    startedAt: new Date(entry.startedAt).toISOString(),
    durationMs: entry.durationMs,
    status: entry.status,
  }).catch(() => {});
}, { sharedLimiter });

try {
  const initial = dryRun
    ? { cursor: 0, scanned: 0, repaired: 0, failed: 0 }
    : await readOsuFileRepairProgress(db);
  let { cursor, scanned, repaired, failed } = initial;
  for (;;) {
    const result = await repairMismatchedOsuFilesChunk(db, osu, cursor, 200, { dryRun });
    cursor = result.nextCursor;
    scanned += result.scanned;
    repaired += result.repaired.length;
    failed += result.failed;
    if (!dryRun) {
      await invalidateOsuFileRepairDerivatives(db, queue, [...result.repaired, ...result.unavailable]);
      await exec(
        db,
        "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
        [OSU_FILE_REPAIR_PROGRESS_META_KEY, json({ cursor, scanned, repaired, failed }), nowIso()],
      );
    }
    for (const beatmapId of [...result.repaired, ...result.unavailable]) {
      const row = (await exec(
        db,
        "select title, version from map_search_index where beatmap_id = ? limit 1",
        [beatmapId],
      )).rows[0];
      const action = result.unavailable.includes(beatmapId) ? "invalidated unavailable" : dryRun ? "would repair" : "repaired";
      console.log(`${action}: ${beatmapId} ${String(row?.title ?? "?")} [${String(row?.version ?? "?")}]`);
    }
    if (result.retryableFailure) {
      throw new Error(
        `Beatmap ${result.retryableFailure.beatmapId} repair refetch failed: ${result.retryableFailure.message}`,
      );
    }
    if (result.done) break;
    if (scanned % 5000 < 200) console.log(`scanned ${scanned} cached files (${repaired} wrong, ${failed} unavailable)...`);
  }

  if (!dryRun) {
    const affectedBeatmapIds = await readOsuFileRepairAffectedBeatmapIds(db);
    await invalidateOsuFileRepairDerivatives(db, queue, affectedBeatmapIds, { includePlayerSkills: true });
    const now = nowIso();
    const progress = { cursor, scanned, repaired, failed };
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [OSU_FILE_REPAIR_PROGRESS_META_KEY, json(progress), now],
    );
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [OSU_FILE_REPAIR_META_KEY, json({ finishedAt: now, ...progress }), now],
    );
  }

  console.log(`${dryRun ? "[dry-run] " : ""}Done: ${scanned} cached files scanned, ${repaired} had a mismatched Version, ${failed} were unavailable.`);
} finally {
  db.close();
  rateLimitDb.close();
}
