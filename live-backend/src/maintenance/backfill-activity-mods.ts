// Manual runner for the archived-mods backfill (features/activity-mods-backfill.ts).
//
// Refills best_mods_json / best_statistics_json on player_activity_maps rows
// written before those columns shipped, so pre-2026-07-20 archived clears
// become dan evidence again. One osu! API call per row, paced by the shared
// rate limiter, resumable via the progress key in live_meta.
//
//   npm run backfill:activity-mods -- --dry-run
//   npm run backfill:activity-mods -- --limit 500
//   npm run backfill:activity-mods            # runs to completion
//
// Flags:
//   --dry-run        report how many rows are in scope and exit
//   --limit N        stop after N rows this run (default: no limit)
//   --chunk N        rows per progress write (default 100)
//   --min-accuracy X clear bar the row must already meet (default 0.96)
//   --user ID        backfill one player's eligible rows, ignoring the work
//                    list entirely (for fixing a specific player on request)
//   --rebuild-queue  re-rank and rebuild the work list before running
//   --restart        ignore the stored cursor and sweep from the top
//   --no-recompute   skip marking touched players' skill ratings stale

import { readConfig } from "../config.js";
import { createDb, exec, json, logApiCall, migrate } from "../db.js";
import { nowIso } from "../shared/score.js";
import { OsuApiClient } from "../osu/client.js";
import { SqliteSharedRateLimiter } from "../osu/shared-rate-limiter.js";
import {
  ACTIVITY_MODS_BACKFILL_DONE_META_KEY,
  ACTIVITY_MODS_BACKFILL_MIN_ACCURACY,
  ACTIVITY_MODS_BACKFILL_START,
  backfillActivityModsRow,
  buildActivityModsBackfillQueue,
  selectActivityModsRowsForUser,
  countActivityModsBackfillRemaining,
  markPlayerSkillsStale,
  readActivityModsBackfillProgress,
  readChunkPartial,
  runActivityModsBackfillChunk,
  writeActivityModsBackfillProgress,
  type ActivityModsBackfillChunkResult,
  type ActivityModsBackfillCursor,
} from "../features/activity-mods-backfill.js";

const CALLER = "backfill-activity-mods";
// Matches READY_RECOMPUTE_TTL_MS in features/player-skills.ts: pushing
// computed_at past it is what makes the next profile read recompute.
const READY_RECOMPUTE_TTL_MS = 12 * 60 * 60_000;

interface Options {
  userId: number | null;
  rebuildQueue: boolean;
  dryRun: boolean;
  limit: number | null;
  chunk: number;
  minAccuracy: number;
  restart: boolean;
  recompute: boolean;
}

// Declared before the dry-run exit so shutdown() can always clear it.
let keepAlive: NodeJS.Timeout | null = null;

const options = readOptions(process.argv.slice(2));
const config = readConfig();
const db = await createDb(config);
const rateLimitDb = await createDb(config);
await migrate(db);

const progress = options.restart
  ? {
    cursor: { ...ACTIVITY_MODS_BACKFILL_START },
    processed: 0,
    filled: 0,
    missing: 0,
    mismatched: 0,
    updatedAt: "",
  }
  : await readActivityModsBackfillProgress(db);

if (options.userId != null) {
  const rows = await selectActivityModsRowsForUser(db, options.userId, options.minAccuracy);
  if (options.dryRun) {
    console.log(`${rows.length} eligible archived rows for user ${options.userId}.`);
    await shutdown(0);
  }
  console.log(`Backfilling ${rows.length} rows for user ${options.userId}.`);
  keepAlive = setInterval(() => {}, 30_000);
  const osuClient = buildOsuClient();
  let filled = 0;
  let missing = 0;
  let mismatched = 0;
  for (const row of rows) {
    const outcome = await backfillActivityModsRow(db, osuClient, row, CALLER);
    if (outcome === "filled") filled += 1;
    else if (outcome === "missing") missing += 1;
    else mismatched += 1;
  }
  if (options.recompute && filled > 0) {
    const staleComputedAt = new Date(Date.now() - READY_RECOMPUTE_TTL_MS - 60_000).toISOString();
    await markPlayerSkillsStale(db, [options.userId], staleComputedAt);
    console.log("Marked their skill rating for recompute.");
  }
  console.log(`Done: ${filled} filled, ${missing} pruned by osu!, ${mismatched} mismatched.`);
  await shutdown(0);
}

if (options.rebuildQueue) {
  const size = await buildActivityModsBackfillQueue(db, options.minAccuracy);
  console.log(`Work list rebuilt: ${size} rows.`);
}
{
  const existing = (await exec(db, "select count(*) as n from activity_mods_backfill_queue")).rows[0];
  if (Number(existing?.n ?? 0) === 0) {
    const size = await buildActivityModsBackfillQueue(db, options.minAccuracy);
    console.log(`Work list built: ${size} rows.`);
  }
}

const remaining = await countActivityModsBackfillRemaining(db, progress.cursor, options.minAccuracy);
const planned = options.limit == null ? remaining : Math.min(remaining, options.limit);

if (options.dryRun) {
  console.log(
    `${remaining} archived rows in scope (mania, >= ${(options.minAccuracy * 100).toFixed(0)}% accuracy, chart has a dan rating).`
    + `\nWould fetch ${planned} this run at roughly ${config.osuApiTargetPerMinute}/min -> ~${estimateHours(planned, config.osuApiTargetPerMinute)}h.`
    + (progress.processed > 0 ? `\nResuming at work-list position ${progress.cursor.position}; ${progress.filled} filled so far.` : ""),
  );
  await shutdown(0);
}

const osu = buildOsuClient();

console.log(`Backfilling ${planned} of ${remaining} archived rows, strongest chart first. Ctrl-C is safe; progress is checkpointed.`);

// The osu! client spaces calls with an unref'd setTimeout (deliberate: in the
// server the HTTP listener holds the loop open). A CLI has no such handle, so
// between two calls the loop would have nothing ref'd left and node would exit
// mid-await - silently, having done one request. This heartbeat is the ref.
keepAlive = setInterval(() => {}, 30_000);

const touchedUsers = new Set<number>();
let cursor: ActivityModsBackfillCursor = progress.cursor;
let runProcessed = 0;
let exitCode = 0;

try {
  while (options.limit == null || runProcessed < options.limit) {
    const limit = options.limit == null
      ? options.chunk
      : Math.min(options.chunk, options.limit - runProcessed);
    const result = await runActivityModsBackfillChunk(db, osu, {
      cursor,
      limit,
      minAccuracy: options.minAccuracy,
      caller: CALLER,
    });
    await absorb(result);
    console.log(
      `  pos ${cursor.position} | +${result.filled} filled, ${result.missing} pruned, ${result.mismatched} mismatched`
      + ` | ${runProcessed}/${planned} this run`,
    );
    if (result.done) {
      const now = nowIso();
      await exec(
        db,
        "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
        [ACTIVITY_MODS_BACKFILL_DONE_META_KEY, json({
          finishedAt: now,
          processed: progress.processed,
          filled: progress.filled,
          missing: progress.missing,
          mismatched: progress.mismatched,
        }), now],
      );
      console.log("Scope exhausted; done key written.");
      break;
    }
  }
} catch (error) {
  // Checkpoint the rows the failed chunk did finish before reporting, so the
  // rerun resumes after them rather than re-spending their calls.
  const partial = readChunkPartial(error);
  if (partial) await absorb(partial);
  console.error(`Stopped early: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Rerun to resume from work-list position ${cursor.position}.`);
  exitCode = 1;
}

/** Fold a chunk result (whole or partial) into this run's totals and store it. */
async function absorb(result: ActivityModsBackfillChunkResult): Promise<void> {
  cursor = result.cursor;
  runProcessed += result.processed;
  progress.cursor = cursor;
  progress.processed += result.processed;
  progress.filled += result.filled;
  progress.missing += result.missing;
  progress.mismatched += result.mismatched;
  for (const userId of result.users) touchedUsers.add(userId);
  await writeActivityModsBackfillProgress(db, progress);
}

if (options.recompute && touchedUsers.size > 0) {
  const staleComputedAt = new Date(Date.now() - READY_RECOMPUTE_TTL_MS - 60_000).toISOString();
  const marked = await markPlayerSkillsStale(db, touchedUsers, staleComputedAt);
  console.log(`Marked ${marked} of ${touchedUsers.size} touched players' skill ratings for recompute.`);
}

console.log(
  `Backfill run complete: ${progress.filled} filled, ${progress.missing} pruned by osu!,`
  + ` ${progress.mismatched} id-space mismatches, ${progress.processed} processed in total.`,
);
await shutdown(exitCode);

function buildOsuClient(): OsuApiClient {
  const sharedLimiter = new SqliteSharedRateLimiter(rateLimitDb, {
    provider: "osu",
    targetPerMinute: config.osuApiTargetPerMinute,
    hardPerMinute: config.osuApiHardPerMinute,
  });
  return new OsuApiClient(config, fetch, (entry) => {
    void logApiCall(db, {
      provider: "osu",
      caller: entry.caller,
      path: entry.path,
      startedAt: new Date(entry.startedAt).toISOString(),
      durationMs: entry.durationMs,
      status: entry.status,
    }).catch(() => {});
  }, { sharedLimiter });
}

function estimateHours(rows: number, perMinute: number): string {
  if (!(perMinute > 0)) return "?";
  return (rows / perMinute / 60).toFixed(1);
}

async function shutdown(code: number): Promise<never> {
  if (keepAlive) clearInterval(keepAlive);
  db.close();
  rateLimitDb.close();
  process.exit(code);
}

function readOptions(argv: string[]): Options {
  const options: Options = { userId: null, rebuildQueue: false, dryRun: false, limit: null, chunk: 100, minAccuracy: ACTIVITY_MODS_BACKFILL_MIN_ACCURACY, restart: false, recompute: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[index + 1];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--restart") options.restart = true;
    else if (arg === "--rebuild-queue") options.rebuildQueue = true;
    else if (arg === "--user") { options.userId = Math.floor(Number(next())); index += 1; }
    else if (arg === "--no-recompute") options.recompute = false;
    else if (arg === "--limit") { options.limit = Math.max(1, Math.floor(Number(next()))); index += 1; }
    else if (arg === "--chunk") { options.chunk = Math.max(1, Math.floor(Number(next()))); index += 1; }
    else if (arg === "--min-accuracy") { options.minAccuracy = Math.min(1, Math.max(0, Number(next()))); index += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.userId != null && !Number.isSafeInteger(options.userId)) throw new Error("--user needs an osu! user id");
  if (options.limit != null && !Number.isFinite(options.limit)) throw new Error("--limit needs a number");
  if (!Number.isFinite(options.chunk)) throw new Error("--chunk needs a number");
  if (!Number.isFinite(options.minAccuracy)) throw new Error("--min-accuracy needs a number");
  return options;
}
