import { createClient, type Client, type InValue, type ResultSet, type TransactionMode } from "@libsql/client";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "./config.js";
import { logWarn, errorContext } from "./logger.js";
import { extractManiaVariantPps } from "./shared/score.js";

export type Db = Client;

type PragmaConfig = Partial<Pick<Config, "sqliteBusyTimeoutMs" | "sqliteSynchronous" | "sqliteCacheMb" | "sqliteMmapMb">>;

const SQLITE_BUSY_RETRY_MS = readBoundedEnvInt("SQLITE_BUSY_RETRY_MS", 15_000, 0, 120_000);
const SQLITE_BUSY_RETRY_INITIAL_DELAY_MS = 25;
const SQLITE_BUSY_RETRY_MAX_DELAY_MS = 500;
// Best-effort request-path writes (throwaway caches like the osu! proxy cache)
// must never burn the full durable-write budget above or trigger a connection
// reopen: a page load that only wanted to *populate* a cache would otherwise
// hang 15-48s waiting for a writer the worker is holding during a backfill
// burst. With this short budget the write instead gives up and skips caching,
// which is invisible to the user (the payload was already fetched).
const SQLITE_BEST_EFFORT_WRITE_BUDGET_MS = readBoundedEnvInt("SQLITE_BEST_EFFORT_WRITE_BUDGET_MS", 250, 0, 5_000);

export interface SqliteBusyRetryStats {
  retryBudgetMs: number;
  operations: number;
  attempts: number;
  exhausted: number;
  totalWaitMs: number;
  lastAt: string | null;
  lastMessage: string | null;
  leakedTxnRollbacks: number;
  reconnects: number;
  lastReconnectAt: string | null;
  // Best-effort cache writes that hit a busy writer and skipped rather than
  // wait out the durable budget. Tracked separately so it never looks like a
  // wedge (which the operations/attempts/exhausted counters above indicate).
  bestEffortWriteSkips: number;
}

const sqliteBusyRetryStats: SqliteBusyRetryStats = {
  retryBudgetMs: SQLITE_BUSY_RETRY_MS,
  operations: 0,
  attempts: 0,
  exhausted: 0,
  totalWaitMs: 0,
  lastAt: null,
  lastMessage: null,
  leakedTxnRollbacks: 0,
  reconnects: 0,
  lastReconnectAt: null,
  bestEffortWriteSkips: 0,
};

// A local libsql connection can wedge permanently: once it is left inside (or
// pinned to) a stale read snapshot while another process advances the WAL,
// every write on it fails SQLITE_BUSY instantly and unretryably, reads serve
// stale data, and no SQL (rollback / begin immediate / checkpoint) un-pins it —
// only reopening the connection does. That is the 2026-07-18/19 server write
// freeze. The reconnect hook below lets the busy-retry path swap the underlying
// client in place, invisibly to every holder of the Db reference.
const RECONNECT = Symbol("mania.sqliteReconnect");
const RECONNECT_MIN_INTERVAL_MS = 5_000;

export async function createDb(config: Pick<Config, "databaseUrl" | "databaseAuthToken"> & PragmaConfig): Promise<Db> {
  const isFile = config.databaseUrl.startsWith("file:");
  if (isFile) {
    const filePath = config.databaseUrl.slice("file:".length);
    await mkdir(dirname(resolve(filePath)), { recursive: true });
  }
  const open = async () => {
    const client = createClient({
      url: config.databaseUrl,
      authToken: config.databaseAuthToken,
    });
    // Local libsql runs every query synchronously on the calling thread, and each
    // process opens its own connection, so connection-level pragmas must be set
    // here. Skipped for remote (Turso) URLs, which manage these server-side.
    if (isFile) await applyConnectionPragmas(client, config);
    return client;
  };
  let inner = await open();
  if (!isFile) return inner;
  let lastReconnectAtMs = 0;
  const reconnect = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastReconnectAtMs < RECONNECT_MIN_INTERVAL_MS) return false;
    lastReconnectAtMs = now;
    const previous = inner;
    inner = await open();
    try {
      previous.close();
    } catch {
      // The old handle is being abandoned either way.
    }
    sqliteBusyRetryStats.reconnects += 1;
    sqliteBusyRetryStats.lastReconnectAt = new Date().toISOString();
    return true;
  };
  return new Proxy(inner, {
    get(_target, prop) {
      if (prop === RECONNECT) return reconnect;
      const value = (inner as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
    },
  }) as Db;
}

async function applyConnectionPragmas(db: Db, config: PragmaConfig): Promise<void> {
  // busy_timeout makes a connection wait for a lock instead of failing with
  // SQLITE_BUSY immediately. This is mandatory once a second process/connection
  // (a split worker) writes to the same WAL file concurrently.
  const busyTimeoutMs = config.sqliteBusyTimeoutMs ?? 5_000;
  // NORMAL fsyncs only at checkpoints (not every commit) and is durable/safe
  // under WAL: a crash can lose the last few committed transactions but never
  // corrupts the database. A big win for the write-heavy ingest/job path.
  const synchronous = (config.sqliteSynchronous ?? "NORMAL").toUpperCase();
  const cacheMb = config.sqliteCacheMb ?? 64;
  const mmapBytes = (config.sqliteMmapMb ?? 256) * 1024 * 1024;
  const pragmas = [
    `pragma busy_timeout = ${busyTimeoutMs}`,
    `pragma synchronous = ${/^(OFF|NORMAL|FULL|EXTRA)$/.test(synchronous) ? synchronous : "NORMAL"}`,
    `pragma wal_autocheckpoint = 1000`,
    // The WAL file never shrinks on its own: checkpoints reset the write cursor
    // but leave the file at its high-water mark (a past write burst left it at
    // ~1GB, slowing WAL recovery on every restart). This trims it back after
    // each successful checkpoint reset without ever blocking readers/writers.
    `pragma journal_size_limit = ${64 * 1024 * 1024}`,
  ];
  // Negative cache_size is in KiB of memory (positive is in pages).
  if (cacheMb > 0) pragmas.push(`pragma cache_size = ${-cacheMb * 1024}`);
  if (mmapBytes > 0) pragmas.push(`pragma mmap_size = ${mmapBytes}`);
  for (const pragma of pragmas) {
    await withSqliteBusyRetry(() => db.execute(pragma), {}).catch((error) => {
      console.warn(`[db] failed to apply ${pragma}:`, error instanceof Error ? error.message : error);
    });
  }
}

export async function migrate(db: Db): Promise<void> {
  const sql = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  for (const statement of splitSql(sql)) {
    await db.execute(statement);
  }
  await migrateCountryRegistryFeatureTier(db);
  await migrateCountryRegistryKeepWarm(db);
  await migrateScoreEventsIdentity(db);
  await migrateProfileSnapshots(db);
  await migrateMapsFarmedOverlay(db);
  await migrateUserVariantPp(db);
  await migrateFarmHelperShape(db);
  await migrateApiCallTargets(db);
  await migrateApiRateLimitReservations(db);
  await migratePlayerActivity(db);
  await migratePackCollectionCards(db);
  await migrateTrackerIndexes(db);
  await migrateSnipePersonalBests(db);
  await migrateUserGoals(db);
  await migrateBeatmapOsuFileCache(db);
  await migrateMapSearchIndex(db);
  await migrateMapCollections(db);
  await migrateSkins(db);
  await migrateAdminTodos(db);
  await migrateDanBenchmark(db);
  await migrateAvatarAccents(db);
  await migrateOsuProxyCache(db);
  await migrateCountryMapsSnapshotStampsIndex(db);
  await migrateChartAnalysisDtRate(db);
  await migrateTopPlayEventsHotColumns(db);
  await migratePlayerSkillBaseline(db);
  await migrateActivityMapsBestPayload(db);
}

// getMapsSnapshotMeta reads only (generated_at, refreshed_at) for a country on
// the serving loop on every /maps request, but country_maps_snapshots rows carry
// the ~60MB GLOBAL payload_json, so fetching the row walks its overflow chain.
// A covering index over just the stamp columns keeps that read index-only.
async function migrateCountryMapsSnapshotStampsIndex(db: Db): Promise<void> {
  await db.execute(
    "create index if not exists idx_country_maps_snapshots_stamps on country_maps_snapshots(country, generated_at, refreshed_at)",
  );
}

export async function dbHealth(db: Db): Promise<boolean> {
  try {
    await db.execute("select 1");
    return true;
  } catch {
    return false;
  }
}

export function splitSql(sql: string): string[] {
  // Strip whole-line `--` comments from inside each statement, not just chunks that begin with
  // one: a comment block sitting directly above a `create table` (no `;` between) would otherwise
  // make the chunk start with `--` and drop the table entirely, leaving its index to fail.
  return sql
    .split(";")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

export interface DbStatement {
  sql: string;
  args?: InValue[];
}

const EXEC_BATCH_MAX_STATEMENTS = 500;

export interface ExecOptions {
  // Best-effort writes skip the durable retry budget and the connection reopen:
  // on a busy writer they fail fast so the caller can move on without caching.
  bestEffort?: boolean;
}

export async function exec(db: Db, sql: string, args: InValue[] = [], options?: ExecOptions) {
  if (options?.bestEffort) {
    return withSqliteBusyRetry(() => db.execute({ sql, args }), {
      budgetMs: SQLITE_BEST_EFFORT_WRITE_BUDGET_MS,
      bestEffort: true,
    });
  }
  return withSqliteBusyRetry(() => db.execute({ sql, args }), { recoverDb: db });
}

export async function execBatch(db: Db, statements: DbStatement[], mode: TransactionMode = "write") {
  if (statements.length === 0) return [];
  const results: ResultSet[] = [];
  for (let index = 0; index < statements.length; index += EXEC_BATCH_MAX_STATEMENTS) {
    const chunk = statements.slice(index, index + EXEC_BATCH_MAX_STATEMENTS);
    results.push(...await withSqliteBusyRetry(() => db.batch(chunk.map(({ sql, args = [] }) => ({ sql, args })), mode), { recoverDb: db }));
  }
  return results;
}

// Shared write rule for the users.pp_4k / pp_7k columns. Returns a conditional
// UPDATE only when the payload actually carried a variants array, so a partial
// user upsert (no variants) leaves the columns intact, while a variants payload
// overwrites both, including nulling a keymode whose pp legitimately decayed to
// none. Never coalesce-guard these columns (Number(x ?? 0) poison bug).
export function variantPpUpdateStatement(userId: number, statistics: unknown): DbStatement | null {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const variantPps = extractManiaVariantPps(statistics);
  if (!variantPps) return null;
  return {
    sql: "update users set pp_4k = ?, pp_7k = ? where user_id = ?",
    args: [variantPps.pp4k, variantPps.pp7k, userId],
  };
}

export async function writeVariantPps(db: Db, userId: number, statistics: unknown): Promise<void> {
  const statement = variantPpUpdateStatement(userId, statistics);
  if (!statement) return;
  await exec(db, statement.sql, statement.args ?? []);
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_(BUSY|LOCKED)|database is locked|database table is locked/i.test(message);
}

export function getSqliteBusyRetryStats(): SqliteBusyRetryStats {
  return { ...sqliteBusyRetryStats };
}

interface BusyRetryOptions {
  // Passed only for durable writes: on budget exhaustion the connection is
  // reopened (the stale-snapshot wedge recovery). Best-effort writes omit it.
  recoverDb?: Db;
  // Retry ceiling; defaults to the durable budget. Best-effort writes pass the
  // short best-effort budget instead.
  budgetMs?: number;
  // Best-effort writes record a skip counter instead of the wedge stats and
  // never attempt connection recovery.
  bestEffort?: boolean;
}

async function withSqliteBusyRetry<T>(operation: () => Promise<T>, options: BusyRetryOptions = {}): Promise<T> {
  const { recoverDb, bestEffort = false } = options;
  const budgetMs = options.budgetMs ?? SQLITE_BUSY_RETRY_MS;
  if (budgetMs <= 0) {
    try {
      return await operation();
    } catch (error) {
      if (isSqliteBusyError(error)) {
        if (bestEffort) sqliteBusyRetryStats.bestEffortWriteSkips += 1;
        else recordSqliteBusyRetry(error, 0, true);
      }
      throw error;
    }
  }
  let startedAt = Date.now();
  let delayMs = SQLITE_BUSY_RETRY_INITIAL_DELAY_MS;
  let operationAttempts = 0;
  let recoveryAttempted = false;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      const elapsedMs = Date.now() - startedAt;
      operationAttempts += 1;
      if (elapsedMs >= budgetMs) {
        if (!recoveryAttempted && recoverDb && await tryRecoverWedgedConnection(recoverDb, error)) {
          // The connection was likely wedged on a stale read snapshot (the
          // 2026-07-18/19 server write freezes) — reopening it is the only
          // cure, and the operation deserves a fresh budget on the new
          // connection.
          recoveryAttempted = true;
          startedAt = Date.now();
          delayMs = SQLITE_BUSY_RETRY_INITIAL_DELAY_MS;
          continue;
        }
        if (bestEffort) sqliteBusyRetryStats.bestEffortWriteSkips += 1;
        else recordSqliteBusyRetry(error, 0, true, operationAttempts);
        throw error;
      }
      const waitMs = Math.min(delayMs, budgetMs - elapsedMs);
      // Best-effort skips are expected and frequent under load; keep them out of
      // the wedge stats (only the final give-up bumps the skip counter).
      if (!bestEffort) recordSqliteBusyRetry(error, waitMs, false, operationAttempts);
      await sleep(waitMs);
      delayMs = Math.min(SQLITE_BUSY_RETRY_MAX_DELAY_MS, Math.ceil(delayMs * 1.6));
    }
  }
}

// Busy-exhaustion last resort. First a ROLLBACK probe purely for forensics:
// if it succeeds, some code path leaked an open transaction on this connection
// (the prime suspect for how the wedge forms) — log it loudly so the leak can
// finally be pinpointed. Then reopen the connection, because a wedged snapshot
// pin survives rollback; only a fresh connection recovers (verified against
// libsql local). Rate-limited inside the reconnect hook so plain long-lived
// contention (a worker holding the write lock) cannot cause reconnect churn.
async function tryRecoverWedgedConnection(db: Db, cause: unknown): Promise<boolean> {
  const reconnect = (db as unknown as Record<symbol, unknown>)[RECONNECT] as (() => Promise<boolean>) | undefined;
  if (!reconnect) return false;
  let hadOpenTxn = false;
  try {
    await db.execute("rollback");
    hadOpenTxn = true;
    sqliteBusyRetryStats.leakedTxnRollbacks += 1;
  } catch {
    // No open transaction — the pin (if any) formed some other way.
  }
  let reconnected = false;
  try {
    reconnected = await reconnect();
  } catch (error) {
    logWarn("sqlite_reconnect_failed", errorContext(error));
    return false;
  }
  if (reconnected) {
    logWarn("sqlite_wedged_connection_reopened", {
      detail: "write busy-retry budget exhausted; reopened the connection",
      hadOpenTxn,
      ...errorContext(cause),
    });
  }
  return reconnected;
}

function recordSqliteBusyRetry(error: unknown, waitMs: number, exhausted: boolean, operationAttempts = 1): void {
  if (operationAttempts === 1) sqliteBusyRetryStats.operations += 1;
  sqliteBusyRetryStats.attempts += 1;
  if (exhausted) sqliteBusyRetryStats.exhausted += 1;
  sqliteBusyRetryStats.totalWaitMs += Math.max(0, Math.ceil(waitMs));
  sqliteBusyRetryStats.lastAt = new Date().toISOString();
  sqliteBusyRetryStats.lastMessage = error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.ceil(ms))));
}

function readBoundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export async function logApiCall(
  db: Db,
  entry: { provider: string; caller: string; path: string; startedAt: string; durationMs?: number | null; status?: number | null },
): Promise<void> {
  await exec(
    db,
    `insert or ignore into api_call_targets (provider, caller, path)
     values (?, ?, ?)`,
    [entry.provider, entry.caller, entry.path],
  );
  const row = (await exec(
    db,
    "select id from api_call_targets where provider = ? and caller = ? and path = ?",
    [entry.provider, entry.caller, entry.path],
  )).rows[0];
  await exec(
    db,
    "insert into api_call_log (provider, caller, path, target_id, started_at, duration_ms, status) values (?, '', '', ?, ?, ?, ?)",
    [entry.provider, Number(row.id), entry.startedAt, entry.durationMs ?? null, entry.status ?? null],
  );
}

export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function migrateCountryRegistryFeatureTier(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(country_registry)")).rows.map((row) => String(row.name));
  if (columns.includes("feature_tier")) return;

  await db.execute("alter table country_registry add column feature_tier text not null default 'live'");
}

async function migrateCountryRegistryKeepWarm(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(country_registry)")).rows.map((row) => String(row.name));
  if (columns.includes("keep_warm")) return;

  await db.execute("alter table country_registry add column keep_warm integer not null default 0");
}

async function migrateScoreEventsIdentity(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(score_events)")).rows.map((row) => String(row.name));
  if (columns.includes("score_identity")) return;

  await db.execute("alter table score_events rename to score_events_old");
  await db.execute(`
    create table score_events (
      id integer primary key autoincrement,
      score_id integer not null,
      score_identity text not null,
      legacy_score_id integer,
      user_id integer not null,
      country text,
      beatmap_id integer not null,
      ruleset_id integer not null,
      score_json text not null,
      pp real,
      total_score integer,
      accuracy real,
      rank text,
      passed integer not null,
      processed integer not null default 0,
      is_lazer integer not null,
      has_replay integer not null,
      ended_at text not null,
      received_at text not null,
      source text not null,
      unique(country, score_identity)
    )
  `);
  await db.execute(`
    insert or ignore into score_events (
      score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json,
      pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source
    )
    select
      score_id,
      'official:' || coalesce(legacy_score_id, score_id),
      legacy_score_id,
      user_id,
      country,
      beatmap_id,
      ruleset_id,
      score_json,
      pp,
      total_score,
      accuracy,
      rank,
      passed,
      processed,
      is_lazer,
      has_replay,
      ended_at,
      received_at,
      source
    from score_events_old
  `);
  await db.execute("drop table score_events_old");
}

async function migrateProfileSnapshots(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists profile_snapshots (
      user_id integer primary key,
      username_key text not null unique,
      user_json text not null,
      best_scores_json text not null,
      best_scores_limit integer not null,
      fetched_at text not null,
      user_fetched_at text not null,
      updated_at text not null,
      refresh_error text
    )
  `);
  const snapshotColumns = (await db.execute("pragma table_info(profile_snapshots)")).rows.map((row) => String(row.name));
  if (!snapshotColumns.includes("user_fetched_at")) {
    await db.execute("alter table profile_snapshots add column user_fetched_at text");
    await db.execute("update profile_snapshots set user_fetched_at = fetched_at where user_fetched_at is null");
  }
  await db.execute(`
    create index if not exists idx_profile_snapshots_username_key
      on profile_snapshots(username_key)
  `);
  await db.execute(`
    create table if not exists profile_section_cache (
      cache_key text primary key,
      user_id integer not null,
      section text not null,
      payload_json text not null,
      fetched_at text not null,
      updated_at text not null
    )
  `);
  await db.execute(`
    create index if not exists idx_profile_section_cache_user_section
      on profile_section_cache(user_id, section)
  `);
}

// Real per-keymode osu! pp columns for the farm helper. Populated from the
// enrichment payload's statistics.variants at the full-user upsert paths and
// backfilled once from stored profile_json here so the columns are usable
// before the enrichment drip finishes covering the roster.
async function migrateUserVariantPp(db: Db): Promise<void> {
  const userColumns = (await db.execute("pragma table_info(users)")).rows.map((row) => String(row.name));
  if (!userColumns.includes("pp_4k")) {
    await db.execute("alter table users add column pp_4k real");
  }
  if (!userColumns.includes("pp_7k")) {
    await db.execute("alter table users add column pp_7k real");
  }

  const backfillKey = "farm_helper_variant_pp_backfill:v1";
  const done = (await db.execute({
    sql: "select 1 from live_meta where key = ? limit 1",
    args: [backfillKey],
  })).rows[0];
  if (done) return;

  const rows = (await db.execute(
    "select user_id, profile_json from users where profile_json like '%\"variants\"%'",
  )).rows;
  const updates: DbStatement[] = [];
  for (const row of rows) {
    const userId = Number(row.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    let statistics: unknown;
    try {
      statistics = (JSON.parse(String(row.profile_json)) as { statistics?: unknown }).statistics;
    } catch {
      continue;
    }
    const variantPps = extractManiaVariantPps(statistics);
    if (!variantPps) continue;
    updates.push({
      sql: "update users set pp_4k = ?, pp_7k = ? where user_id = ?",
      args: [variantPps.pp4k, variantPps.pp7k, userId],
    });
  }
  await execBatch(db, updates);
  await db.execute({
    sql: `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
          on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    args: [backfillKey, json(true), new Date().toISOString()],
  });
}

// Per-peer chart-shape profile for the farm helper (Stage 3). Populated by the
// key-stats seed rebuild and the per-user refresh; the column just needs to exist.
async function migrateFarmHelperShape(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(farm_helper_user_key_stats)")).rows.map((row) => String(row.name));
  if (!columns.includes("shape_json")) {
    await db.execute("alter table farm_helper_user_key_stats add column shape_json text");
  }
}

// Rate-adjusted (1.5x/DT) analysis for DT-farmed 4K charts, so the farm helper's
// feasibility gate can screen DT recs too (stored 1.0x MSD/dan can't). Populated
// by the boot-seeded DT-rate sweep in features/chart-analysis.ts; the columns
// just need to exist. Same shapes as msd_json / a lean dan verdict.
// Top-plays snapshots used to filter/sort/join via json_extract over every
// payload_json in the window (~5s for GLOBAL 30d, on the serving loop). These
// columns materialize the extracted fields once; the covering indexes keep the
// count/pp-gain scans off the payload overflow pages entirely.
async function migrateTopPlayEventsHotColumns(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(top_play_events)")).rows.map((row) => String(row.name));
  if (!columns.includes("score_time")) {
    await db.execute("alter table top_play_events add column score_time text");
    await db.execute("alter table top_play_events add column score_beatmap_id integer");
    await db.execute("alter table top_play_events add column key_count real");
    await db.execute(`
      update top_play_events set
        score_time = coalesce(case when json_valid(payload_json) then json_extract(payload_json, '$.time') end, detected_at),
        score_beatmap_id = cast(case when json_valid(payload_json) then coalesce(json_extract(payload_json, '$.score.beatmap_id'), json_extract(payload_json, '$.score.beatmap.id')) end as integer),
        key_count = cast(case when json_valid(payload_json) then json_extract(payload_json, '$.score.beatmap.cs') end as real)
    `);
    await db.execute(`
      update top_play_events
      set key_count = (select b.cs from beatmaps b where b.beatmap_id = top_play_events.score_beatmap_id)
      where key_count is null and score_beatmap_id is not null
    `);
  }
  await db.execute("create index if not exists idx_top_play_events_country_score_time on top_play_events(country, score_time desc, key_count)");
  await db.execute("create index if not exists idx_top_play_events_score_time on top_play_events(score_time desc, key_count, pp_gain, user_id)");
  // pp/gain sorts walk these in order and check the window + key filter from
  // the index itself; without them each candidate row costs a table lookup.
  await db.execute("create index if not exists idx_top_play_events_pp_window on top_play_events(pp desc, score_time, key_count)");
  await db.execute("create index if not exists idx_top_play_events_gain_window on top_play_events(pp_gain desc, score_time, key_count)");
}

// Approximate per-user skill ratings backing the population percentiles
// (features/skill-baseline.ts). Written by the chunked refresh_skill_baseline
// job; the quantile curves themselves live in live_meta.
async function migratePlayerSkillBaseline(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists player_skill_baseline (
      user_id integer not null,
      key_count integer not null,
      baseline_version integer not null,
      analyzed_plays integer not null,
      ratings_json text not null,
      latest_played_at text,
      updated_at text not null,
      primary key (user_id, key_count, baseline_version)
    )
  `);
  // Added after the table first shipped; dev DBs created without it need the
  // column, and rows backfill naturally on the next baseline run.
  const columns = (await db.execute("pragma table_info(player_skill_baseline)")).rows.map((row) => String(row.name));
  if (!columns.includes("latest_played_at")) {
    await db.execute("alter table player_skill_baseline add column latest_played_at text");
  }
}

// The day-best rows outlive raw score payloads by ~2 years, and the skill
// pipeline reads them back as archived evidence. Mods and judgement counts
// are the two fields that evidence needs beyond accuracy (real rate, wife
// goal, miss share); ~100 bytes per row vs the multi-KB payload.
async function migrateActivityMapsBestPayload(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(player_activity_maps)")).rows.map((row) => String(row.name));
  if (!columns.includes("best_mods_json")) {
    await db.execute("alter table player_activity_maps add column best_mods_json text");
  }
  if (!columns.includes("best_statistics_json")) {
    await db.execute("alter table player_activity_maps add column best_statistics_json text");
  }
}

async function migrateChartAnalysisDtRate(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(beatmap_chart_analysis)")).rows.map((row) => String(row.name));
  if (!columns.includes("msd_dt_json")) {
    await db.execute("alter table beatmap_chart_analysis add column msd_dt_json text");
  }
  if (!columns.includes("dan_dt_json")) {
    await db.execute("alter table beatmap_chart_analysis add column dan_dt_json text");
  }
  // Raw tail-aware MSD (lnTailTaps run, same { values } shape as msd_json);
  // readers blend it toward msd_json by the keymode weight in dan/msd.ts.
  if (!columns.includes("msd_ln_json")) {
    await db.execute("alter table beatmap_chart_analysis add column msd_ln_json text");
  }
}

async function migrateMapsFarmedOverlay(db: Db): Promise<void> {
  const userColumns = (await db.execute("pragma table_info(users)")).rows.map((row) => String(row.name));
  if (!userColumns.includes("maps_farmed_min_pp")) {
    await db.execute("alter table users add column maps_farmed_min_pp real");
  }
  if (!userColumns.includes("maps_farmed_scores_refreshed_at")) {
    await db.execute("alter table users add column maps_farmed_scores_refreshed_at text");
  }

  await db.execute(`
    create table if not exists maps_beatmapsets (
      beatmapset_id integer primary key,
      title text not null,
      artist text not null,
      creator text,
      status text,
      covers_json text,
      global_play_count integer,
      global_favourite_count integer,
      preview_url text,
      bpm real,
      mania_keys_json text,
      patterns_json text,
      updated_at text not null
    )
  `);
  await db.execute(`
    create table if not exists maps_beatmaps (
      beatmap_id integer primary key,
      beatmapset_id integer not null,
      mode text not null,
      status text,
      cs real,
      difficulty_rating real,
      bpm real,
      total_length integer,
      version text not null,
      url text,
      updated_at text not null
    )
  `);
  await db.execute(`
    create index if not exists idx_maps_beatmaps_beatmapset
      on maps_beatmaps(beatmapset_id)
  `);

  await db.execute(`
    create table if not exists country_maps_farmed_scores (
      country text not null,
      user_id integer not null,
      beatmap_id integer not null,
      score_id integer not null,
      pp real not null,
      score_json text not null,
      mods_json text,
      score_url text,
      played_at text,
      detected_at text not null,
      updated_at text not null,
      primary key (country, user_id, beatmap_id)
    )
  `);
  const farmedColumns = (await db.execute("pragma table_info(country_maps_farmed_scores)")).rows.map((row) => String(row.name));
  if (!farmedColumns.includes("mods_json")) {
    await db.execute("alter table country_maps_farmed_scores add column mods_json text");
  }
  if (!farmedColumns.includes("score_url")) {
    await db.execute("alter table country_maps_farmed_scores add column score_url text");
  }
  if (!farmedColumns.includes("played_at")) {
    await db.execute("alter table country_maps_farmed_scores add column played_at text");
  }
  await db.execute(`
    create index if not exists idx_country_maps_farmed_scores_country_updated
      on country_maps_farmed_scores(country, updated_at desc)
  `);
  await db.execute(`
    create index if not exists idx_country_maps_farmed_scores_country_beatmap
      on country_maps_farmed_scores(country, beatmap_id)
  `);

  await db.execute(`
    create table if not exists country_maps_most_played (
      country text not null,
      user_id integer not null,
      beatmap_id integer not null,
      play_count integer not null,
      updated_at text not null,
      primary key (country, user_id, beatmap_id)
    )
  `);
  await db.execute(`
    create table if not exists country_maps_favourite_sets (
      country text not null,
      user_id integer not null,
      beatmapset_id integer not null,
      updated_at text not null,
      primary key (country, user_id, beatmapset_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_country_maps_most_played_country_beatmap
      on country_maps_most_played(country, beatmap_id)
  `);
  await db.execute(`
    create index if not exists idx_country_maps_favourite_sets_country_set
      on country_maps_favourite_sets(country, beatmapset_id)
  `);
}

async function migrateApiCallTargets(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists api_call_targets (
      id integer primary key autoincrement,
      provider text not null,
      caller text not null,
      path text not null,
      unique(provider, caller, path)
    )
  `);
  const columns = (await db.execute("pragma table_info(api_call_log)")).rows.map((row) => String(row.name));
  if (!columns.includes("target_id")) {
    await db.execute("alter table api_call_log add column target_id integer");
  }
  if (!columns.includes("duration_ms")) {
    await db.execute("alter table api_call_log add column duration_ms integer");
  }
  if (!columns.includes("status")) {
    await db.execute("alter table api_call_log add column status integer");
  }
  await db.execute(`
    create index if not exists idx_api_call_log_target_time
      on api_call_log(target_id, started_at desc)
  `);
}

async function migrateApiRateLimitReservations(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists api_rate_limit_reservations (
      id integer primary key autoincrement,
      provider text not null,
      started_at_ms integer not null,
      caller text not null,
      path text not null,
      lane text not null,
      created_at_ms integer not null
    )
  `);
  await db.execute(`
    create index if not exists idx_api_rate_limit_reservations_provider_time
      on api_rate_limit_reservations(provider, started_at_ms)
  `);
}

async function migratePlayerActivity(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists beatmap_skill_vectors (
      beatmap_id integer not null,
      analysis_version integer not null,
      status text not null,
      stream_score real not null default 0,
      jack_score real not null default 0,
      bracket_score real not null default 0,
      ln_score real not null default 0,
      ln_general_score real not null default 0,
      ln_release_score real not null default 0,
      ln_inverse_score real not null default 0,
      ln_tech_score real not null default 0,
      skills_json text,
      error text,
      computed_at text,
      updated_at text not null,
      primary key (beatmap_id, analysis_version)
    )
  `);
  const vectorColumns = (await db.execute("pragma table_info(beatmap_skill_vectors)")).rows.map((row) => String(row.name));
  if (!vectorColumns.includes("bracket_score")) {
    await db.execute("alter table beatmap_skill_vectors add column bracket_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_general_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_general_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_release_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_release_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_inverse_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_inverse_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_tech_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_tech_score real not null default 0");
  }
  if (!vectorColumns.includes("skills_json")) {
    await db.execute("alter table beatmap_skill_vectors add column skills_json text");
  }
  await db.execute(`
    create table if not exists player_activity_score_refs (
      country text not null,
      score_identity text not null,
      user_id integer not null,
      day text not null,
      beatmap_id integer not null,
      passed integer not null,
      ended_at text not null,
      created_at text not null,
      primary key (country, score_identity)
    )
  `);
  const refColumns = (await db.execute("pragma table_info(player_activity_score_refs)")).rows.map((row) => String(row.name));
  if (!refColumns.includes("passed")) {
    await db.execute("alter table player_activity_score_refs add column passed integer not null default 1");
  }
  await db.execute(`
    create table if not exists player_activity_days (
      country text not null,
      user_id integer not null,
      day text not null,
      score_count integer not null default 0,
      passed_count integer not null default 0,
      session_count integer not null default 0,
      first_score_at text,
      last_score_at text,
      updated_at text not null,
      primary key (country, user_id, day)
    )
  `);
  await db.execute(`
    create table if not exists player_activity_maps (
      country text not null,
      user_id integer not null,
      day text not null,
      beatmap_id integer not null,
      play_count integer not null default 0,
      best_score_id integer,
      best_pp real,
      best_accuracy real,
      best_rank text,
      first_played_at text,
      last_played_at text,
      updated_at text not null,
      primary key (country, user_id, day, beatmap_id)
    )
  `);
  await db.execute(`
    create table if not exists player_activity_backfill_cursors (
      country text not null,
      user_id integer not null,
      last_event_id integer not null default 0,
      updated_at text not null,
      primary key (country, user_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_beatmap_skill_vectors_status_updated
      on beatmap_skill_vectors(status, updated_at desc)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_refs_user_day
      on player_activity_score_refs(country, user_id, day, ended_at)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_refs_user_time
      on player_activity_score_refs(user_id, ended_at desc)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_refs_day
      on player_activity_score_refs(day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_user_day
      on player_activity_days(country, user_id, day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_user_day_all
      on player_activity_days(user_id, day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_user_year
      on player_activity_days(country, user_id, substr(day, 1, 4))
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_day
      on player_activity_days(day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_user_day
      on player_activity_maps(country, user_id, day, play_count desc)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_user_beatmap
      on player_activity_maps(user_id, beatmap_id)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_beatmap
      on player_activity_maps(beatmap_id)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_day
      on player_activity_maps(day)
  `);
}

async function migratePackCollectionCards(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists pack_collection_cards (
      owner_user_id integer not null,
      card_user_id integer not null,
      username text not null,
      avatar_url text not null,
      country_code text not null,
      tier text,
      tier_label text,
      skills_json text,
      pp real not null,
      global_rank integer not null,
      copies integer not null,
      recycled_copies integer not null,
      first_pulled_at integer not null,
      last_pulled_at integer not null,
      updated_at integer not null,
      primary key(owner_user_id, card_user_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_owner_rank
      on pack_collection_cards(owner_user_id, copies, global_rank)
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_owner_tier
      on pack_collection_cards(owner_user_id, tier, copies, pp desc)
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_owner_username
      on pack_collection_cards(owner_user_id, username)
  `);
}

async function migrateTrackerIndexes(db: Db): Promise<void> {
  await db.execute(`
    create index if not exists idx_score_events_user_time
      on score_events(user_id, ended_at desc)
  `);
  await db.execute(`
    create index if not exists idx_top_play_events_score
      on top_play_events(score_id)
  `);
  await db.execute(`
    create index if not exists idx_top_play_events_time
      on top_play_events(detected_at desc)
  `);
  await db.execute(`
    create index if not exists idx_top_play_events_user_pp
      on top_play_events(user_id, pp desc)
  `);
}

async function migrateSnipePersonalBests(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists country_beatmap_score_pbs (
      country text not null,
      beatmap_id integer not null,
      lane_key text not null,
      user_id integer not null,
      score_identity text not null,
      score_id integer not null,
      total_score integer not null,
      pp real,
      accuracy real,
      rank text,
      mods_json text not null,
      is_lazer integer not null,
      has_replay integer not null,
      ended_at text not null,
      updated_at text not null,
      primary key (country, beatmap_id, lane_key, user_id, score_identity)
    )
  `);
  await db.execute(`
    create index if not exists idx_country_beatmap_score_pbs_lookup
      on country_beatmap_score_pbs(country, beatmap_id, lane_key, user_id, ended_at desc, total_score desc)
  `);
  await db.execute(`
    create table if not exists country_beatmap_score_pb_state (
      country text not null,
      beatmap_id integer not null,
      lane_key text not null,
      user_id integer not null,
      verified_at text not null,
      primary key (country, beatmap_id, lane_key, user_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_country_beatmap_score_pb_state_lookup
      on country_beatmap_score_pb_state(country, beatmap_id, lane_key, user_id)
  `);
}

async function migrateUserGoals(db: Db): Promise<void> {
  // Per-player goals that auto-complete from the ingest pipeline. Timestamps are epoch ms
  // (matching the pack tables); status is 'open' | 'completed'. beatmap_id scopes map goals,
  // target_value carries pp / accuracy fraction, target_count carries count goals, target_grade
  // carries S/SS-style targets or the rank scope, speed_bucket carries normal/ht/dt for map goals.
  await db.execute(`
    create table if not exists user_goals (
      id text primary key,
      user_id integer not null,
      country text,
      kind text not null,
      beatmap_id integer,
      beatmapset_id integer,
      beatmap_label text,
      target_value real,
      target_count integer,
      target_grade text,
      speed_bucket text,
      note text,
      status text not null default 'open',
      created_at integer not null,
      completed_at integer,
      completed_value real,
      completed_score_id text,
      completed_beatmap_id integer,
      updated_at integer not null
    )
  `);
  const goalColumns = (await db.execute("pragma table_info(user_goals)")).rows.map((row) => String(row.name));
  if (!goalColumns.includes("beatmapset_id")) {
    await db.execute("alter table user_goals add column beatmapset_id integer");
  }
  if (!goalColumns.includes("target_count")) {
    await db.execute("alter table user_goals add column target_count integer");
  }
  if (!goalColumns.includes("speed_bucket")) {
    await db.execute("alter table user_goals add column speed_bucket text");
  }
  if (!goalColumns.includes("start_value")) {
    // Baseline captured when a numeric-target goal is set, so its progress bar measures the climb
    // from there (a "reach 15.5k" goal made at 15.1k starts near 0, not 97%). Backfill existing
    // open pp goals from the player's current totals; map-accuracy baselines fill in on recreate.
    await db.execute("alter table user_goals add column start_value real");
    await db.execute(
      "update user_goals set start_value = (select pp from users where users.user_id = user_goals.user_id) where status = 'open' and kind = 'reach_pp' and start_value is null",
    );
    await db.execute(
      "update user_goals set start_value = (select max(pp) from user_top_scores where user_top_scores.user_id = user_goals.user_id) where status = 'open' and kind = 'play_pp' and start_value is null",
    );
  }
  await db.execute(`
    create index if not exists idx_user_goals_user_status
      on user_goals(user_id, status)
  `);
  await db.execute(`
    create index if not exists idx_user_goals_user_beatmap
      on user_goals(user_id, status, beatmap_id)
  `);
}

async function migrateSkins(db: Db): Promise<void> {
  // Community skin uploads. A row is created in 'pending' status when an upload
  // ticket is minted (upload_token + token_expires_at are the ticket); the .osk,
  // composed preview, and screenshots attach to it, and finish flips it to
  // 'published'. Keymodes are server-derived from skin.ini, never client-asserted.
  // Timestamps are ISO text (matching replay_video_exports). Retention prunes
  // expired pending rows; published/hidden rows are durable.
  await db.execute(`
    create table if not exists skins (
      id text primary key,
      owner_user_id integer not null,
      owner_username text not null,
      name text not null,
      description text,
      keymodes_json text not null default '[]',
      download_count integer not null default 0,
      accent_color text,
      search_text text not null default '',
      status text not null default 'pending',
      upload_token text,
      token_expires_at text,
      osk_key text,
      osk_size_bytes integer,
      osk_sha256 text,
      osk_url text,
      preview_key text,
      preview_url text,
      preview_width integer,
      preview_height integer,
      screenshots_json text not null default '[]',
      created_at text not null,
      updated_at text not null,
      published_at text
    )
  `);
  const skinColumns = (await db.execute("pragma table_info(skins)")).rows.map((row) => String(row.name));
  if (!skinColumns.includes("download_count")) {
    await db.execute("alter table skins add column download_count integer not null default 0");
  }
  if (!skinColumns.includes("description")) {
    await db.execute("alter table skins add column description text");
  }
  if (!skinColumns.includes("previews_json")) {
    // Per-keymode playfield previews: [{keys, key, url, width, height}].
    // preview_* stays the card cover (one of these, chosen by the uploader).
    await db.execute("alter table skins add column previews_json text not null default '[]'");
  }
  if (!skinColumns.includes("slug")) {
    // URL slug assigned at publish time (null while pending). Backfilled for
    // already-published rows by backfillSkinSlugs at boot.
    await db.execute("alter table skins add column slug text");
  }
  if (!skinColumns.includes("author")) {
    // Who made the skin (skin.ini Author or uploader-provided), as opposed to
    // who uploaded it; primary attribution on the browse cards.
    await db.execute("alter table skins add column author text");
  }
  await db.execute(`
    create unique index if not exists idx_skins_slug
      on skins(slug) where slug is not null
  `);
  await db.execute(`
    create index if not exists idx_skins_status_published
      on skins(status, published_at desc)
  `);
  await db.execute(`
    create index if not exists idx_skins_owner
      on skins(owner_user_id, created_at desc)
  `);
}

async function migrateAdminTodos(db: Db): Promise<void> {
  // Private owner todo list (admin-only) for reminders / bugs found / things left to do. Single
  // user, so no per-user scoping. category is bug|feature|idea|chore|task, priority is
  // low|normal|high, status is open|done. Timestamps are epoch ms. Durable: retention never
  // prunes this table.
  await db.execute(`
    create table if not exists admin_todos (
      id text primary key,
      title text not null,
      notes text,
      category text not null default 'task',
      priority text not null default 'normal',
      status text not null default 'open',
      created_at integer not null,
      updated_at integer not null,
      done_at integer,
      position real not null default 0
    )
  `);
  await db.execute(`
    create index if not exists idx_admin_todos_status
      on admin_todos(status, created_at desc)
  `);

  // position: manual drag-to-reorder key for the open list (lower = higher up). Backfill existing
  // rows with spaced values that match the old default sort (open before done; open by priority
  // then newest; done by most-recently-completed) so the board looks unchanged the first time it
  // loads, then becomes freely reorderable. Spaced by 1000 to leave room for midpoint inserts.
  const columns = (await db.execute("pragma table_info(admin_todos)")).rows.map((row) => String(row.name));
  if (!columns.includes("position")) {
    await db.execute("alter table admin_todos add column position real not null default 0");
    await db.execute(`
      update admin_todos
         set position = (
           select ranked.rn * 1000.0
             from (
               select id,
                      row_number() over (
                        order by case when status = 'open' then 0 else 1 end,
                                 case when status = 'done' then coalesce(done_at, 0) else 0 end desc,
                                 case priority when 'high' then 0 when 'normal' then 1 else 2 end,
                                 created_at desc
                      ) as rn
                 from admin_todos
             ) ranked
            where ranked.id = admin_todos.id
         )
    `);
  }
}

async function migrateDanBenchmark(db: Db): Promise<void> {
  // Owner-curated dan benchmark ground truth (labels + hidden diffs), moved here from the legacy
  // frontend Turso store. beatmap_id is the primary key in both tables: a beatmap carries at most
  // one label / one hidden flag, with the family recorded alongside (mirrors the old schema, whose
  // upserts were on conflict(beatmap_id)). Durable: retention never prunes these.
  await db.execute(`
    create table if not exists dan_benchmark_labels (
      beatmap_id integer primary key,
      expected_label text not null,
      family text not null,
      updated_at integer not null
    )
  `);
  await db.execute(`
    create index if not exists idx_dan_benchmark_labels_family
      on dan_benchmark_labels(family)
  `);
  await db.execute(`
    create table if not exists dan_benchmark_hidden_diffs (
      beatmap_id integer primary key,
      family text not null,
      updated_at integer not null
    )
  `);
  await db.execute(`
    create index if not exists idx_dan_benchmark_hidden_family
      on dan_benchmark_hidden_diffs(family)
  `);
}

async function migrateAvatarAccents(db: Db): Promise<void> {
  // Per-avatar-URL accent colors for player names (features/avatar-accents.ts). a.ppy.sh URLs are
  // cache-busted per avatar change, so a row is effectively content-addressed: accent computed once,
  // shipped in snapshot payloads. status is ok|error (error rows retry after a day). Retention
  // prunes rows older than ~180d as a slow refresh; everything self-heals via compute jobs.
  await db.execute(`
    create table if not exists avatar_accents (
      avatar_url text primary key,
      accent text,
      status text not null default 'ok',
      computed_at integer not null
    )
  `);
  await db.execute(`
    create index if not exists idx_avatar_accents_computed
      on avatar_accents(computed_at)
  `);
}

async function migrateOsuProxyCache(db: Db): Promise<void> {
  // Response cache for the /api/osu/v2 GET-JSON proxy (features/osu-proxy-cache.ts). Callers opt in
  // per request with TTL/stale hints; rows past their stale window are pruned by retention. Nothing
  // here is durable.
  await db.execute(`
    create table if not exists osu_proxy_cache (
      cache_key text primary key,
      path text not null,
      body text not null,
      expires_at integer not null,
      stale_until integer not null,
      updated_at integer not null
    )
  `);
  await db.execute(`
    create index if not exists idx_osu_proxy_cache_stale
      on osu_proxy_cache(stale_until)
  `);
}

async function migrateBeatmapOsuFileCache(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists beatmap_osu_files (
      beatmap_id integer primary key,
      beatmapset_id integer,
      compression text not null default 'gzip',
      content_blob blob,
      content text not null default '',
      raw_bytes integer not null default 0,
      compressed_bytes integer not null default 0,
      source text not null default 'unknown',
      error text,
      fetched_at text not null,
      last_used_at text not null
    )
  `);

  const columns = (await db.execute("pragma table_info(beatmap_osu_files)")).rows.map((row) => String(row.name));
  if (!columns.includes("beatmapset_id")) {
    await db.execute("alter table beatmap_osu_files add column beatmapset_id integer");
  }
  if (!columns.includes("compression")) {
    await db.execute("alter table beatmap_osu_files add column compression text not null default 'gzip'");
  }
  if (!columns.includes("content_blob")) {
    await db.execute("alter table beatmap_osu_files add column content_blob blob");
  }
  if (!columns.includes("raw_bytes")) {
    await db.execute("alter table beatmap_osu_files add column raw_bytes integer not null default 0");
  }
  if (!columns.includes("compressed_bytes")) {
    await db.execute("alter table beatmap_osu_files add column compressed_bytes integer not null default 0");
  }
  if (!columns.includes("source")) {
    await db.execute("alter table beatmap_osu_files add column source text not null default 'unknown'");
  }
  if (!columns.includes("error")) {
    await db.execute("alter table beatmap_osu_files add column error text");
  }
  if (!columns.includes("last_used_at")) {
    await db.execute("alter table beatmap_osu_files add column last_used_at text");
    await db.execute("update beatmap_osu_files set last_used_at = fetched_at where last_used_at is null");
  }
  await db.execute("update beatmap_osu_files set raw_bytes = length(content) where raw_bytes = 0 and content is not null and length(content) > 0");
  await db.execute("update beatmap_osu_files set last_used_at = fetched_at where last_used_at is null");
  // Covering index for the status/backfill count scans. The table's B-tree
  // pages are dominated by inline .osu blob content, so a "count the cached
  // rows" aggregate that touches the table reads gigabytes (a 10-40s scan
  // that, with synchronous local libsql, stalls the whole event loop); the
  // same aggregate over this small index runs in milliseconds.
  await db.execute("create index if not exists idx_beatmap_osu_files_meta on beatmap_osu_files (beatmap_id, compressed_bytes, source, error)");
}

async function migrateMapSearchIndex(db: Db): Promise<void> {
  // Denormalized, indexed projection of every chart-analyzed mania beatmap, built
  // from beatmap_skill_vectors joined to beatmaps/beatmapsets. Backs the global
  // /maps Search section. Materialized (not queried on-the-fly with json_extract)
  // because libsql is synchronous and a 54k-row JSON scan blocks the event loop
  // for ~115ms per request. Durable projection, never pruned by retention.
  await db.execute(`
    create table if not exists map_search_index (
      beatmap_id integer primary key,
      beatmapset_id integer not null,
      analysis_version integer not null,
      title text not null,
      artist text not null,
      creator text,
      version text not null,
      search_text text not null,
      key_count integer not null,
      stars real not null,
      bpm real not null,
      length integer not null,
      status text not null,
      play_count integer not null default 0,
      pass_count integer not null default 0,
      ln_count integer not null default 0,
      primary_pattern text not null,
      pat_jack real not null default 0,
      pat_stream real not null default 0,
      pat_jumpstream real not null default 0,
      pat_handstream real not null default 0,
      pat_stamina real not null default 0,
      pat_chordjack real not null default 0,
      pat_tech real not null default 0,
      pat_ln real not null default 0,
      covers_json text,
      ranked_date text,
      dan_label text,
      dan_family text,
      raw_dan real,
      msd_json text,
      msd_overall real,
      pattern_tags text not null default '',
      vibro integer not null default 0,
      updated_at text not null
    )
  `);
  // Chart-analysis join columns arrived after the table shipped; add them to
  // existing databases (fresh ones get them from the create above).
  const mapSearchColumns = new Set((await db.execute("pragma table_info(map_search_index)")).rows.map((row) => String(row.name)));
  if (!mapSearchColumns.has("dan_label")) {
    await db.execute("alter table map_search_index add column dan_label text");
    await db.execute("alter table map_search_index add column dan_family text");
    await db.execute("alter table map_search_index add column raw_dan real");
    await db.execute("alter table map_search_index add column msd_json text");
    await db.execute("alter table map_search_index add column pattern_tags text not null default ''");
  }
  if (!mapSearchColumns.has("vibro")) {
    await db.execute("alter table map_search_index add column vibro integer not null default 0");
  }
  if (!mapSearchColumns.has("msd_overall")) {
    // Plain real column for MSD-bucketed collections and future search sorts;
    // backfilled by the r5 BUILD_REVISION re-upsert.
    await db.execute("alter table map_search_index add column msd_overall real");
  }
  await db.execute("create index if not exists idx_map_search_key_stars on map_search_index(key_count, stars)");
  await db.execute("create index if not exists idx_map_search_key_plays on map_search_index(key_count, play_count desc)");
  await db.execute("create index if not exists idx_map_search_key_bpm on map_search_index(key_count, bpm)");
  await db.execute("create index if not exists idx_map_search_key_length on map_search_index(key_count, length)");
  await db.execute("create index if not exists idx_map_search_primary on map_search_index(primary_pattern, key_count, stars)");
  await db.execute("create index if not exists idx_map_search_status on map_search_index(status, key_count, stars)");
  // The search page dedups sets with a per-row sibling anti-join and pages with
  // an ordered index walk, so it needs beatmapset_id for the probes plus one
  // (sort column, beatmap_id) index per sort. The explicit beatmap_id column
  // matters: it lets both scan directions satisfy ORDER BY without a temp sort.
  await db.execute("create index if not exists idx_map_search_set on map_search_index(beatmapset_id)");
  await db.execute("create index if not exists idx_map_search_plays_id on map_search_index(play_count, beatmap_id)");
  await db.execute("create index if not exists idx_map_search_stars_id on map_search_index(stars, beatmap_id)");
  await db.execute("create index if not exists idx_map_search_bpm_id on map_search_index(bpm, beatmap_id)");
  await db.execute("create index if not exists idx_map_search_length_id on map_search_index(length, beatmap_id)");
  await db.execute("create index if not exists idx_map_search_date_id on map_search_index(ranked_date, beatmap_id)");
  await db.execute("create index if not exists idx_map_search_raw_dan on map_search_index(raw_dan, beatmap_id)");
  // Fresh planner stats so SQLite picks the ordered-scan + anti-join plan over
  // the older key_count-prefixed indexes. Cheap (<100ms) at boot.
  await db.execute("analyze map_search_index");
}

async function migrateMapCollections(db: Db): Promise<void> {
  // Auto-generated map packs (pattern x key x difficulty bucket on the dan and
  // MSD axes) materialized from map_search_index by code-defined recipes.
  // Members are deduped by beatmapset so a pack is not twelve diffs of one
  // mapset. Durable projection; membership rotates on every rebuild.
  await db.execute(`
    create table if not exists map_collections (
      id text primary key,
      recipe_id text not null,
      kind text not null,
      title text not null,
      description text,
      key_count integer,
      axis text,
      bucket_lo real,
      bucket_hi real,
      sort_order integer not null default 0,
      cover_set_id integer,
      cover_sets_json text,
      member_count integer not null default 0,
      refreshed_at text not null,
      updated_at text not null
    )
  `);
  // The dan/MSD bucket columns arrived with the collections rework; add them to
  // databases created before it (fresh ones get them from the create above).
  const collectionColumns = new Set((await db.execute("pragma table_info(map_collections)")).rows.map((row) => String(row.name)));
  if (!collectionColumns.has("axis")) {
    await db.execute("alter table map_collections add column axis text");
    await db.execute("alter table map_collections add column bucket_lo real");
    await db.execute("alter table map_collections add column bucket_hi real");
    await db.execute("alter table map_collections add column cover_sets_json text");
  }
  await db.execute(`
    create table if not exists map_collection_members (
      collection_id text not null,
      beatmap_id integer not null,
      position integer not null,
      score real not null,
      added_at text not null,
      primary key (collection_id, beatmap_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_map_collection_members_pos
      on map_collection_members(collection_id, position)
  `);
}
