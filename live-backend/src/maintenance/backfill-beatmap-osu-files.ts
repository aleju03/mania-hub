import { readConfig } from "../config.js";
import { createDb, exec, logApiCall, migrate, type Db } from "../db.js";
import { getCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { OsuApiClient } from "../osu/client.js";
import { SqliteSharedRateLimiter } from "../osu/shared-rate-limiter.js";

interface BackfillOptions {
  batchSize: number;
  concurrency: number;
  limit: number | null;
  dryRun: boolean;
  analysisVersion: number | null;
}

interface BackfillResult {
  processed: number;
  stored: number;
  failed: number;
}

const options = readOptions(process.argv.slice(2));
const config = readConfig();
const db = await createDb(config);
const rateLimitDb = await createDb(config);

await migrate(db);

const total = await countMissingCachedFiles(db, options);
const planned = options.limit == null ? total : Math.min(total, options.limit);
if (options.dryRun) {
  console.log(`Would backfill ${planned} of ${total} analyzed beatmap .osu files missing compressed cache rows.`);
  db.close();
  rateLimitDb.close();
  process.exit(0);
}

const sharedLimiter = new SqliteSharedRateLimiter(rateLimitDb, {
  provider: "osu",
  targetPerMinute: config.osuApiTargetPerMinute,
  hardPerMinute: config.osuApiHardPerMinute,
});
const osu = new OsuApiClient(config, fetch, (entry) => {
  void logApiCall(db, {
    provider: "osu",
    caller: entry.caller,
    path: entry.path,
    startedAt: new Date(entry.startedAt).toISOString(),
  }).catch(() => {});
}, { sharedLimiter });

const result = await backfillBeatmapOsuFiles(db, osu, options, planned);
console.log(`Backfill complete: stored ${result.stored}, failed ${result.failed}, processed ${result.processed}.`);

db.close();
rateLimitDb.close();

async function backfillBeatmapOsuFiles(
  db: Db,
  osu: OsuApiClient,
  options: BackfillOptions,
  planned: number,
): Promise<BackfillResult> {
  const result: BackfillResult = { processed: 0, stored: 0, failed: 0 };
  let afterBeatmapId = 0;

  while (options.limit == null || result.processed < options.limit) {
    const remaining = options.limit == null ? options.batchSize : Math.min(options.batchSize, options.limit - result.processed);
    if (remaining <= 0) break;

    const beatmapIds = await selectMissingCachedBeatmapIds(db, afterBeatmapId, remaining, options);
    if (beatmapIds.length === 0) break;
    afterBeatmapId = beatmapIds[beatmapIds.length - 1] ?? afterBeatmapId;

    await mapWithConcurrency(beatmapIds, options.concurrency, async (beatmapId) => {
      try {
        await getCachedBeatmapFile(db, osu, beatmapId, "maintenance:backfill_osu_file_cache");
        if (await hasCompressedCachedFile(db, beatmapId)) {
          result.stored++;
        } else {
          result.failed++;
          console.warn(`store failed for beatmap ${beatmapId}`);
        }
      } catch (error) {
        result.failed++;
        console.warn(`fetch failed for beatmap ${beatmapId}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        result.processed++;
      }
    });

    console.log(`Processed ${result.processed}/${planned}: stored ${result.stored}, failed ${result.failed}, last beatmap ${afterBeatmapId}.`);
  }

  return result;
}

async function countMissingCachedFiles(db: Db, options: BackfillOptions): Promise<number> {
  const { where, args } = missingCacheWhere(options);
  const row = (await exec(
    db,
    `select count(*) as count
     from (
       select distinct v.beatmap_id
       from beatmap_skill_vectors v
       ${where}
     )`,
    args,
  )).rows[0];
  const count = Number(row?.count);
  return Number.isFinite(count) ? count : 0;
}

async function selectMissingCachedBeatmapIds(
  db: Db,
  afterBeatmapId: number,
  limit: number,
  options: BackfillOptions,
): Promise<number[]> {
  const { where, args } = missingCacheWhere(options, afterBeatmapId);
  const rows = (await exec(
    db,
    `select distinct v.beatmap_id
     from beatmap_skill_vectors v
     ${where}
     order by v.beatmap_id asc
     limit ?`,
    [...args, limit],
  )).rows;
  return rows.map((row) => Number(row.beatmap_id)).filter((beatmapId) => Number.isSafeInteger(beatmapId) && beatmapId > 0);
}

function missingCacheWhere(options: BackfillOptions, afterBeatmapId = 0): { where: string; args: Array<string | number> } {
  const clauses = [
    "v.status = 'ready'",
    `not exists (
       select 1
       from beatmap_osu_files f
       where f.beatmap_id = v.beatmap_id
         and f.content_blob is not null
         and f.compressed_bytes > 0
     )`,
  ];
  const args: Array<string | number> = [];

  if (options.analysisVersion != null) {
    clauses.push("v.analysis_version = ?");
    args.push(options.analysisVersion);
  }
  if (afterBeatmapId > 0) {
    clauses.push("v.beatmap_id > ?");
    args.push(afterBeatmapId);
  }

  return { where: `where ${clauses.join("\n       and ")}`, args };
}

async function hasCompressedCachedFile(db: Db, beatmapId: number): Promise<boolean> {
  const row = (await exec(
    db,
    `select compressed_bytes
     from beatmap_osu_files
     where beatmap_id = ?
       and content_blob is not null
       and compressed_bytes > 0
     limit 1`,
    [beatmapId],
  )).rows[0];
  return Number(row?.compressed_bytes) > 0;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function readOptions(args: string[]): BackfillOptions {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const batchSize = readBoundedOption(args, "--batch-size", 500, 1, 5_000);
  const concurrency = readBoundedOption(args, "--concurrency", 4, 1, 16);
  const limitValue = readOptionalPositiveInt(args, "--limit");
  const analysisVersion = readOptionalPositiveInt(args, "--analysis-version");
  return {
    batchSize,
    concurrency,
    limit: limitValue,
    dryRun: args.includes("--dry-run"),
    analysisVersion,
  };
}

function readBoundedOption(args: string[], name: string, fallback: number, min: number, max: number): number {
  const value = readOptionalPositiveInt(args, name) ?? fallback;
  return Math.max(min, Math.min(max, value));
}

function readOptionalPositiveInt(args: string[], name: string): number | null {
  const prefix = `${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function printHelp(): void {
  console.log(`Backfill compressed .osu files for already-analyzed beatmaps.

Options:
  --dry-run                 Count rows without fetching.
  --limit=N                 Stop after N candidate beatmaps.
  --batch-size=N            Candidate DB page size. Default: 500.
  --concurrency=N           Concurrent fetch workers. Default: 4.
  --analysis-version=N      Restrict to one beatmap_skill_vectors version.
`);
}
