import { createClient, type Client, type InValue, type ResultSet, type TransactionMode } from "@libsql/client";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "./config.js";
import { logInfo, logWarn, errorContext } from "./logger.js";
import { extractManiaVariantPps, getScoreSpeedBucket, normalizeStoredMods } from "./shared/score.js";

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

// migrate() used to be the ONE write path in this process that bypassed the
// busy-retry layer below: every statement went straight to the raw client, so
// its whole tolerance for a concurrent writer was a single busy_timeout window
// (2s by default). A deploy always races a live writer — the previous
// server-role process keeps serving while this one restarts — and on 2026-07-24
// that cost 12 worker crash-loops in ~2 minutes with score ingest down for the
// whole window: one SQLITE_BUSY out of a CREATE INDEX / UPDATE killed boot and
// systemd restarted straight back into the same contention.
//
// The budget below measures *time lost to lock contention*, not wall clock: only
// a pass that died on SQLITE_BUSY counts against it, so a legitimately slow
// migration (a fresh DB building 58 indexes) is never aborted for merely taking
// its time, while a genuinely wedged database still fails loudly once the budget
// is spent and systemd's restart stays the backstop.
export const SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS = readBoundedEnvInt("SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS", 300_000, 0, 1_800_000);
// Backoff between migration passes, so a writer that is mid-transaction gets a
// moment to finish instead of being re-raced immediately.
const MIGRATION_PASS_RETRY_INITIAL_DELAY_MS = 250;
const MIGRATION_PASS_RETRY_MAX_DELAY_MS = 5_000;

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
  // Connection reopens performed by migrate() between passes. Counted apart
  // from `reconnects` so that counter keeps meaning "a long-lived connection
  // went stale" (the write-freeze signal) instead of "a deploy was contended".
  migrationReconnects: number;
  // Best-effort cache writes that hit a busy writer and skipped rather than
  // wait out the durable budget. Tracked separately so it never looks like a
  // wedge (which the operations/attempts/exhausted counters above indicate).
  bestEffortWriteSkips: number;
  // Connections reopened because a .batch() surfaced SQLITE_BUSY (see
  // reopenPoisonedBatchConnection). Counted apart from `reconnects` so plain
  // write contention hitting batches does not spike the write-freeze signal.
  batchBusyReconnects: number;
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
  migrationReconnects: 0,
  bestEffortWriteSkips: 0,
  batchBusyReconnects: 0,
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
// Why a connection is being reopened. "wedge" is the stale-snapshot recovery
// above; "migration" is migrate() discarding a connection that lost the write
// lock; "batch" is a .batch() that surfaced SQLITE_BUSY and left the
// connection poisoned. They are counted and rate-limited differently.
type ReconnectReason = "wedge" | "migration" | "batch";
type ReconnectHook = (reason: ReconnectReason) => Promise<boolean>;

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
  const reconnect = async (reason: ReconnectReason): Promise<boolean> => {
    const now = Date.now();
    // The interval guard exists to stop reconnect churn on a long-lived serving
    // connection that keeps losing to a busy writer. A migration reopen is a
    // different animal: it is deliberate, already bounded by the migration's
    // contention budget, and separated from the next one by a whole migration
    // pass — and refusing it would strand migrate() on a connection whose writes
    // can never commit. So it is never rate-limited. Neither is a batch-poison
    // reopen: a connection whose .batch() surfaced SQLITE_BUSY must never carry
    // another write (later writes silently join its leaked transaction), so
    // under sustained contention every failed batch attempt needs a fresh
    // connection — refusing one would force a retry on a poisoned handle.
    if (reason === "wedge" && now - lastReconnectAtMs < RECONNECT_MIN_INTERVAL_MS) return false;
    lastReconnectAtMs = now;
    const previous = inner;
    inner = await open();
    try {
      previous.close();
    } catch {
      // The old handle is being abandoned either way.
    }
    // Counted apart, so "reconnects" keeps meaning "a long-lived connection went
    // stale" — the write-freeze signal /api/status and /valley watch — instead of
    // also meaning "a deploy was contended" or "a batch lost a write race".
    if (reason === "migration") {
      sqliteBusyRetryStats.migrationReconnects += 1;
    } else if (reason === "batch") {
      sqliteBusyRetryStats.batchBusyReconnects += 1;
      sqliteBusyRetryStats.lastReconnectAt = new Date().toISOString();
    } else {
      sqliteBusyRetryStats.reconnects += 1;
      sqliteBusyRetryStats.lastReconnectAt = new Date().toISOString();
    }
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
    // Everything below assumes WAL, so make it true rather than hope the file
    // was converted once by hand: the main DB already is (no-op), but the
    // analytics DB ran in delete mode for months - meaning every 1s flush
    // paid the full rollback-journal fsync dance, and any outside reader
    // could lock the writer out entirely (which wedged the 2026-08-04
    // serving process). journal_mode is persistent, so this converts a
    // fresh or legacy file once at boot and no-ops after.
    `pragma journal_mode = WAL`,
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

export interface MigrateOptions {
  // Ceiling on the time this migration may lose to lock contention: failed
  // passes plus the backoff between them. 0 keeps the pre-2026-07-24 behaviour
  // (the first SQLITE_BUSY fails boot and systemd retries).
  totalBusyBudgetMs?: number;
}

// A SQLITE_BUSY poisons the connection it came from. On the local libsql client
// that connection then keeps accepting writes and reporting success while NONE
// of them become visible to any other connection, and they are discarded when it
// closes — verified cross-process against @libsql/client 0.17 with a second
// process holding BEGIN IMMEDIATE: the whole migration resolved happily, the
// migrating connection listed all 59 tables, and a separate process saw zero.
// Retrying the failed statement in place would therefore turn the 2026-07-24
// crash-loop into something worse: a worker that boots "successfully" onto a
// schema that was never written.
//
// So contention is handled at pass granularity instead. The first SQLITE_BUSY
// aborts the pass (nothing it wrote was durable anyway, and continuing to write
// on a poisoned connection is what leaves its lock held even after close), the
// connection is reopened, and the whole migration re-runs on the fresh one.
// Re-running is always safe: every statement in a pass is idempotent, which is
// the same property that lets migrate() run at every boot.
export async function migrate(db: Db, options: MigrateOptions = {}): Promise<void> {
  const state: MigrationBusyState = {
    totalBudgetMs: options.totalBusyBudgetMs ?? SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS,
    busyWaitedMs: 0,
    failedPasses: 0,
    lastBusySql: "",
  };
  const target = withMigrationBusyTracking(db, state);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const sql = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  const statements = splitSql(sql);
  let delayMs = MIGRATION_PASS_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    const passStartedAt = Date.now();
    try {
      await runMigrationPass(target, statements, startedAtIso);
      // A deploy that had to wait out a writer must say so in the journal:
      // silence would hide contention getting steadily worse until it exhausts
      // the budget.
      if (state.failedPasses > 0) {
        logInfo("sqlite_migration_busy_summary", {
          detail: "migration completed after waiting out a concurrent writer",
          failed_passes: state.failedPasses,
          busy_waited_ms: state.busyWaitedMs,
          total_budget_ms: state.totalBudgetMs,
          duration_ms: Date.now() - startedAt,
        });
      }
      return;
    } catch (error) {
      // ONLY lock contention is retryable. A duplicate column, a syntax error, a
      // constraint violation or a corrupt page must surface immediately and
      // unchanged — exactly as before this wrapper existed.
      if (!isSqliteBusyError(error) || state.totalBudgetMs <= 0) throw error;
      state.failedPasses += 1;
      // The whole pass is lost, so all of its time counts as time lost to
      // contention, and so does the backoff before the next one.
      state.busyWaitedMs += Date.now() - passStartedAt;
      const remainingMs = state.totalBudgetMs - state.busyWaitedMs;
      const waitMs = Math.min(delayMs, Math.max(0, remainingMs));
      if (remainingMs <= 0 || !(await reopenForNextMigrationPass(db, state, error))) {
        // Feed the shared counters so migration contention is finally visible in
        // getSqliteBusyRetryStats() (/api/status, the admin panel). During the
        // 2026-07-24 crash-loop those counters read clean while the worker died.
        recordSqliteBusyRetry(error, 0, true, state.failedPasses);
        logWarn("sqlite_migration_busy_exhausted", {
          detail: "migration gave up waiting for the write lock; boot fails so systemd retries and a wedged database stays visible",
          sql: state.lastBusySql,
          failed_passes: state.failedPasses,
          busy_waited_ms: state.busyWaitedMs,
          total_budget_ms: state.totalBudgetMs,
          ...errorContext(error),
        });
        throw error;
      }
      if (state.failedPasses === 1) {
        logWarn("sqlite_migration_busy_wait", {
          detail: "migration pass hit a concurrent writer; reopening and re-running until the budget is spent",
          sql: state.lastBusySql,
          total_budget_ms: state.totalBudgetMs,
          busy_waited_ms: state.busyWaitedMs,
          ...errorContext(error),
        });
      }
      recordSqliteBusyRetry(error, waitMs, false, state.failedPasses);
      state.busyWaitedMs += waitMs;
      await sleep(waitMs);
      delayMs = Math.min(MIGRATION_PASS_RETRY_MAX_DELAY_MS, Math.ceil(delayMs * 1.6));
    }
  }
}

// One full sweep of the schema. Idempotent by construction, so migrate() can run
// it again on a reopened connection when contention poisoned the previous one.
async function runMigrationPass(target: Db, statements: string[], startedAtIso: string): Promise<void> {
  for (const statement of statements) {
    await target.execute(statement);
  }
  // From here on, other processes can *observe* this migration instead of
  // guessing at it: a serving process schedules its heavy board warm-up against
  // this marker (http/snapshots.ts) rather than a fixed delay that a contended
  // migrate() can now legitimately outlive. Stamped after the initial schema so
  // live_meta is guaranteed to exist; a database that fresh has no serving
  // process to inform anyway (it is still blocked in waitForSchema).
  await setMigrationSentinel(target, SCHEMA_MIGRATION_META_KEY, { startedAt: startedAtIso, completedAt: null });
  await migrateCountryRegistryFeatureTier(target);
  await migrateCountryRegistryKeepWarm(target);
  await migrateCountryRegistryRetiredAt(target);
  await migrateScoreEventsIdentity(target);
  await migrateProfileSnapshots(target);
  await migrateMapsFarmedOverlay(target);
  await migrateGlobalMapsFarmedSeedEpoch(target);
  await migrateUserVariantPp(target);
  await migrateFarmHelperShape(target);
  await migrateApiCallTargets(target);
  await migrateApiRateLimitReservations(target);
  await migratePlayerActivity(target);
  await migratePackCollectionCards(target);
  await migratePackPullEvents(target);
  await migrateTrackerIndexes(target);
  await migrateSnipePersonalBests(target);
  await migrateUserGoals(target);
  await migrateFarmHelperFeedback(target);
  await migrateBeatmapOsuFileCache(target);
  await migrateMapSearchIndex(target);
  await migrateMapCollections(target);
  await migrateSkins(target);
  await migrateUserReplaySkins(target);
  await migrateAdminTodos(target);
  await migrateDanBenchmark(target);
  await migrateAvatarAccents(target);
  await migrateOsuProxyCache(target);
  await migrateCountryMapsSnapshotStampsIndex(target);
  await migrateChartAnalysisDtRate(target);
  await migrateTopPlayEventsHotColumns(target);
  await migratePlayerSkillBaseline(target);
  await migratePlayerSkillAccModel(target);
  await migrateActivityMapsBestPayload(target);
  await migrateGoatPoll(target);
  await setMigrationSentinel(target, SCHEMA_MIGRATION_META_KEY, {
    startedAt: startedAtIso,
    completedAt: new Date().toISOString(),
  });
}

// Reopens the connection between passes. This is NOT the stale-snapshot wedge
// recovery (tryRecoverWedgedConnection): that one cures a LONG-LIVED connection
// and reports itself through sqlite_wedged_connection_reopened plus the
// "reconnects" counter that /api/status and /valley treat as the write-freeze
// signal from the 2026-07-18/19 incident. A migration connection is seconds old
// and has run only pragmas and DDL, so it cannot hold that stale pin, and deploy
// contention is an expected event rather than an alarm — so this gets its own
// message and counter and leaves that signal meaning what it has always meant.
async function reopenForNextMigrationPass(db: Db, state: MigrationBusyState, cause: unknown): Promise<boolean> {
  const reconnect = (db as unknown as Record<symbol, unknown>)[RECONNECT] as ReconnectHook | undefined;
  // No reopen hook means a memory or remote database, where nothing outside this
  // process holds the write lock in the first place. Nothing to recover.
  if (!reconnect) return false;
  try {
    if (!(await reconnect("migration"))) return false;
  } catch (error) {
    logWarn("sqlite_migration_reopen_failed", errorContext(error));
    return false;
  }
  logWarn("sqlite_migration_connection_reopened", {
    detail: "a pass lost the write lock, so nothing it wrote can be trusted; reopened the connection and re-running the migration",
    failed_passes: state.failedPasses,
    busy_waited_ms: state.busyWaitedMs,
    total_budget_ms: state.totalBudgetMs,
    ...errorContext(cause),
  });
  return true;
}

interface MigrationBusyState {
  totalBudgetMs: number;
  busyWaitedMs: number;
  failedPasses: number;
  // SQL of the statement that lost the lock, for the give-up log line.
  lastBusySql: string;
}

// Marks the proxy below so execBatch() can tell it is running inside migrate().
const MIGRATION_TARGET = Symbol("mania.migrationTarget");

function isMigrationDb(db: Db): boolean {
  return (db as unknown as Record<symbol, unknown>)[MIGRATION_TARGET] === true;
}

// The migration connection needs no per-statement retry — a SQLITE_BUSY is
// handled a level up, by redoing the whole pass on a reopened connection — but
// it does need to be recognizable (so execBatch() never retries in place on it)
// and it should name the statement that lost the lock. That is all this does:
// one property read and one try/catch around the same single db.execute() as
// before, so the ~30 test suites that migrate a fresh tmpdir database pay
// nothing measurable.
function withMigrationBusyTracking(db: Db, state: MigrationBusyState): Db {
  return new Proxy(db, {
    get(_target, prop) {
      if (prop === MIGRATION_TARGET) return true;
      if (prop === "execute") return (...args: unknown[]) => runMigrationStatement(db, args, state);
      const value = (db as unknown as Record<string | symbol, unknown>)[prop];
      // Bind to `db` (never to the proxy): libsql client methods read private
      // fields off `this`, which throws when `this` is a Proxy.
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(db) : value;
    },
  }) as Db;
}

async function runMigrationStatement(db: Db, args: unknown[], state: MigrationBusyState): Promise<ResultSet> {
  try {
    // Member call, so `this` stays the client.
    return await (db as unknown as { execute: (...args: unknown[]) => Promise<ResultSet> }).execute(...args);
  } catch (error) {
    if (isSqliteBusyError(error)) state.lastBusySql = describeMigrationSql(args);
    throw error;
  }
}

function describeMigrationSql(args: unknown[]): string {
  const first = args[0];
  const sql = typeof first === "string"
    ? first
    : first && typeof first === "object" && "sql" in first
      ? String((first as { sql: unknown }).sql)
      : "";
  return sql.replace(/\s+/g, " ").trim().slice(0, 200);
}

// One-shot markers in live_meta, so a migration step that is expensive but only
// ever needed once stops re-running (and re-holding the write lock) on every
// boot. Always written AFTER the work, so a crash re-runs the whole step.
async function hasMigrationSentinel(db: Db, key: string): Promise<boolean> {
  const row = (await db.execute({ sql: "select value_json from live_meta where key = ? limit 1", args: [key] })).rows[0];
  return row != null;
}

async function readMigrationSentinel<T>(db: Db, key: string, fallback: T): Promise<T> {
  const row = (await db.execute({ sql: "select value_json from live_meta where key = ? limit 1", args: [key] })).rows[0];
  return row ? parseJson<T>(String(row.value_json), fallback) : fallback;
}

// Cross-process migration state, written by migrate() and read by anything that
// must not pile work onto a migrating worker. It answers "is a migration running
// right now?" — which a delay constant can only guess at, and now guesses badly:
// migrate() may legitimately spend minutes waiting out a deploy's write lock.
export const SCHEMA_MIGRATION_META_KEY = "schema_migration:v1";

export interface SchemaMigrationState {
  startedAt: string;
  // Null while migrate() is still running; set when it completes.
  completedAt: string | null;
}

export async function readSchemaMigrationState(db: Db): Promise<SchemaMigrationState | null> {
  try {
    const row = (await db.execute({
      sql: "select value_json from live_meta where key = ? limit 1",
      args: [SCHEMA_MIGRATION_META_KEY],
    })).rows[0];
    if (!row) return null;
    const parsed = parseJson<Partial<SchemaMigrationState>>(String(row.value_json), {});
    if (typeof parsed.startedAt !== "string") return null;
    return { startedAt: parsed.startedAt, completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null };
  } catch {
    // live_meta may not exist yet (nobody has ever migrated this database).
    // "Unknown" and "nobody is migrating" are the same answer to every caller.
    return null;
  }
}

async function setMigrationSentinel(db: Db, key: string, value: unknown = true): Promise<void> {
  await db.execute({
    sql: `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
          on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    args: [key, json(value), new Date().toISOString()],
  });
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

// GLOBAL farmed projection v1 originally identified a packed board only by its
// revision. A destructive re-seed can remove maps, so it needs a separate epoch
// that changes once per seed and forces serving processes to discard boards
// from the previous corpus. Existing databases receive epoch 0; the next seed
// advances it before writing any replacement rows.
async function migrateGlobalMapsFarmedSeedEpoch(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(global_maps_farmed_state)")).rows.map((row) => String(row.name));
  if (columns.includes("seed_epoch")) return;
  await db.execute("alter table global_maps_farmed_state add column seed_epoch integer not null default 0");
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
  // Inside migrate() the statements go through .execute() ONE AT A TIME, with no
  // retry wrapper. Three reasons, in order of severity (all verified against
  // @libsql/client 0.17 on a local file URL):
  //  1. A .batch() that loses the race to a concurrent writer leaves the
  //     connection holding a leaked open transaction. Every later .batch() on it
  //     then fails "SQLITE_BUSY: cannot commit transaction - SQL statements in
  //     progress" no matter how free the lock is, and later .execute()s REPORT
  //     SUCCESS while their writes never commit and vanish when the connection
  //     closes. migrate() answers a SQLITE_BUSY by reopening the connection and
  //     re-running the whole pass, which cures that — but only if the busy error
  //     is allowed to reach it instead of being retried in place here.
  //  2. Retrying here would also stack the generic 15s budget on top of the
  //     migration budget — migrateUserVariantPp, the one migration write that
  //     still went through execBatch, is exactly the case finding 3 is about.
  //  3. recoverDb would be the migration proxy, so the wedge-recovery "rollback"
  //     forensics probe would run through it rather than being the instant probe
  //     it is written to be.
  // Losing atomicity is free here: the only migration caller writes independent
  // single-row backfills and records its sentinel only after the last one, so a
  // partial run simply re-runs on the next boot.
  if (isMigrationDb(db)) {
    for (const { sql, args = [] } of statements) results.push(await db.execute({ sql, args }));
    return results;
  }
  for (let index = 0; index < statements.length; index += EXEC_BATCH_MAX_STATEMENTS) {
    const chunk = statements
      .slice(index, index + EXEC_BATCH_MAX_STATEMENTS)
      .map(({ sql, args = [] }) => ({ sql, args }));
    results.push(...await withSqliteBusyRetry(() => db.batch(chunk, mode), { recoverDb: db, reopenBeforeRetry: true }));
  }
  return results;
}

// A single DELETE over a multi-GB table holds the write lock for its whole
// duration — the hourly retention pass did exactly that, stalling every writer
// on both processes past the full 15s busy budget (the reopen bursts of
// 2026-08-06). Deleting in bounded rowid batches keeps each lock hold short,
// and the pause between batches is what actually lets waiting writers in:
// back-to-back statements re-acquire the lock faster than a busy-waiting
// writer polls for it. `table` and `where` are trusted SQL fragments from
// internal callers, never user input.
const DELETE_BATCH_ROWS = 5_000;
const DELETE_BATCH_PAUSE_MS = 50;

export async function deleteInBatches(
  db: Db,
  table: string,
  where: string,
  args: InValue[] = [],
  options?: { batchRows?: number },
): Promise<number> {
  const batchRows = options?.batchRows ?? DELETE_BATCH_ROWS;
  let total = 0;
  for (;;) {
    const result = await exec(
      db,
      `delete from ${table} where rowid in (select rowid from ${table} where ${where} limit ${batchRows})`,
      args,
    );
    const rows = Number(result.rowsAffected ?? 0);
    total += rows;
    if (rows < batchRows) return total;
    await sleep(DELETE_BATCH_PAUSE_MS);
  }
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
  // Set by execBatch: a SQLITE_BUSY from .batch() poisons the connection (see
  // reopenPoisonedBatchConnection), so recoverDb is reopened before EVERY
  // retry instead of only at budget exhaustion. Retrying a batch in place on
  // the same connection is what held the DB-wide write lock for ~5 minutes on
  // 2026-07-25.
  reopenBeforeRetry?: boolean;
}

async function withSqliteBusyRetry<T>(operation: () => Promise<T>, options: BusyRetryOptions = {}): Promise<T> {
  const { recoverDb, bestEffort = false } = options;
  const budgetMs = options.budgetMs ?? SQLITE_BUSY_RETRY_MS;
  // Only file-backed connections carry the reconnect hook; a remote (Turso)
  // client falls back to plain retry-in-place, where the poisoning does not
  // apply (no shared local handle to leak a transaction on).
  const reopenBeforeRetry = options.reopenBeforeRetry === true
    && recoverDb != null
    && (recoverDb as unknown as Record<symbol, unknown>)[RECONNECT] != null;
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
        if (reopenBeforeRetry) {
          // The budget died on a poisoned batch connection. Reopen before
          // surfacing the error — the budget is spent either way, but a later
          // write on this handle must not silently join the leaked
          // transaction while waiting for the next batch to trip the cure.
          await reopenPoisonedBatchConnection(recoverDb!, error);
          if (bestEffort) sqliteBusyRetryStats.bestEffortWriteSkips += 1;
          else recordSqliteBusyRetry(error, 0, true, operationAttempts);
          throw error;
        }
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
      if (reopenBeforeRetry) {
        // The busy .batch() has poisoned this connection; it must be reopened
        // before the retry, or the retry both fails forever and turns later
        // writes on the connection into silent no-ops that hold the DB-wide
        // write lock (see reopenPoisonedBatchConnection). A reopen failure is
        // surfaced as the original busy error: the connection cannot be
        // trusted with a retry, and callers own their own retry machinery.
        if (!(await reopenPoisonedBatchConnection(recoverDb!, error))) {
          if (bestEffort) sqliteBusyRetryStats.bestEffortWriteSkips += 1;
          else recordSqliteBusyRetry(error, 0, true, operationAttempts);
          throw error;
        }
      }
      await sleep(waitMs);
      delayMs = Math.min(SQLITE_BUSY_RETRY_MAX_DELAY_MS, Math.ceil(delayMs * 1.6));
    }
  }
}

// Why reopening (not ROLLBACK, not retrying) is the only sound answer to a
// SQLITE_BUSY surfaced by .batch() — every step verified against
// @libsql/client 0.17.3 local file connections, and the proven mechanism of
// the 2026-07-25 prod write stall (osu! rate 0/55 for ~5 minutes), consistent
// with the 2026-07-18/19 freezes:
//   - The failed batch leaves its connection inside an invisible open
//     transaction: the failed statement is never finalized, so the client's
//     cleanup ROLLBACK is defeated, and sqlite itself then reports "cannot
//     rollback - no transaction is active" — no probe can see the state
//     (which is why the wedge recovery's hadOpenTxn forensics stayed false
//     through the whole incident).
//   - The next write on the connection silently joins that transaction: it
//     reports success, is visible only to this connection, takes the DB-wide
//     WAL write lock, and is discarded when the connection closes. Both
//     processes' writers then starve while the holder looks perfectly healthy.
//   - Retrying the batch in place fails forever ("cannot commit transaction -
//     SQL statements in progress") no matter how free the lock is.
async function reopenPoisonedBatchConnection(db: Db, cause: unknown): Promise<boolean> {
  const reconnect = (db as unknown as Record<symbol, unknown>)[RECONNECT] as ReconnectHook | undefined;
  if (!reconnect) return false;
  try {
    if (!(await reconnect("batch"))) return false;
  } catch (error) {
    logWarn("sqlite_reconnect_failed", errorContext(error));
    return false;
  }
  logWarn("sqlite_batch_busy_connection_reopened", {
    detail: "a .batch() surfaced SQLITE_BUSY; the connection is presumed to hold a leaked open transaction and was reopened before the retry",
    ...errorContext(cause),
  });
  return true;
}

// Busy-exhaustion last resort. First a ROLLBACK probe purely for forensics:
// if it succeeds, some code path leaked an open transaction on this connection
// (the prime suspect for how the wedge forms) — log it loudly so the leak can
// finally be pinpointed. Then reopen the connection, because a wedged snapshot
// pin survives rollback; only a fresh connection recovers (verified against
// libsql local). Rate-limited inside the reconnect hook so plain long-lived
// contention (a worker holding the write lock) cannot cause reconnect churn.
async function tryRecoverWedgedConnection(db: Db, cause: unknown): Promise<boolean> {
  const reconnect = (db as unknown as Record<symbol, unknown>)[RECONNECT] as ReconnectHook | undefined;
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
    reconnected = await reconnect("wedge");
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

// Diagnostics, not bookkeeping the system depends on: the osu! budget is held
// by api_rate_limit_reservations, and this table only feeds the admin call
// history. So both writes are best-effort — a call log row is never worth
// holding a connection for the full 15s durable budget, which on the serving
// connection means holding every page-load read queued behind it (the 3cc0638
// rule: request-path writes stay off ctx.db, and they stay short).
export async function logApiCall(
  db: Db,
  entry: { provider: string; caller: string; path: string; startedAt: string; durationMs?: number | null; status?: number | null },
): Promise<void> {
  await exec(
    db,
    `insert or ignore into api_call_targets (provider, caller, path)
     values (?, ?, ?)`,
    [entry.provider, entry.caller, entry.path],
    { bestEffort: true },
  );
  const row = (await exec(
    db,
    "select id from api_call_targets where provider = ? and caller = ? and path = ?",
    [entry.provider, entry.caller, entry.path],
  )).rows[0];
  // The target insert was skipped (busy writer): drop this line rather than
  // inventing a target id.
  if (row?.id == null) return;
  await exec(
    db,
    "insert into api_call_log (provider, caller, path, target_id, started_at, duration_ms, status) values (?, '', '', ?, ?, ?, ?)",
    [entry.provider, Number(row.id), entry.startedAt, entry.durationMs ?? null, entry.status ?? null],
    { bestEffort: true },
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

/* Separates a country the worker retired for having no data from one an admin
   paused on purpose. Both sit at status 'paused' and every scheduler skips
   both; only the retired one is revived by someone visiting the country. */
async function migrateCountryRegistryRetiredAt(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(country_registry)")).rows.map((row) => String(row.name));
  if (columns.includes("retired_at")) return;

  await db.execute("alter table country_registry add column retired_at text");
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
  if (await hasMigrationSentinel(db, backfillKey)) return;

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
  await setMigrationSentinel(db, backfillKey);
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
  // Guarded per column rather than as one block behind `score_time`, same as the
  // map search index and map collections below. migrations/001_initial.sql
  // creates top_play_events WITHOUT any of the three, so EVERY fresh database
  // walks this path — and a boot that died between the 1st and 2nd ALTER (budget
  // exhaustion, a deploy's SIGTERM) used to find score_time present next time,
  // skip its two siblings permanently, and then throw "no such column: key_count"
  // out of the index below. That is not a busy error, so the retry loop rethrows
  // it on attempt 1 and every subsequent boot fails identically, forever.
  if (!columns.includes("score_time")) await db.execute("alter table top_play_events add column score_time text");
  if (!columns.includes("score_beatmap_id")) await db.execute("alter table top_play_events add column score_beatmap_id integer");
  if (!columns.includes("key_count")) await db.execute("alter table top_play_events add column key_count real");
  // The backfills exist only to fill rows written before the columns did, so they
  // must not re-run on a database that already has them (on prod score_time has
  // been applied for a long time). They carry their own marker rather than riding
  // the pre-ALTER snapshot: a crash between the score_time ALTER and these UPDATEs
  // would otherwise make the next boot's snapshot report score_time present and
  // skip them permanently, leaving every pre-existing row with a null score_time
  // and key_count — silently dropped from the /top-plays window and the pp/gain
  // sorts, with the indexes below built over those nulls and no error anywhere.
  const backfillKey = "top_play_events_hot_column_backfill:v1";
  const backfilled = (await db.execute({
    sql: "select 1 from live_meta where key = ? limit 1",
    args: [backfillKey],
  })).rows[0];
  if (!columns.includes("score_time") && !backfilled) {
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
    await db.execute({
      sql: "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      args: [backfillKey, JSON.stringify({ at: new Date().toISOString() }), new Date().toISOString()],
    });
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

// Personal accuracy curve model (features/player-acc-model.ts), fitted by the
// skills job and persisted beside the ratings it derives from. Nullable; rows
// backfill on each player's next skills recompute.
async function migratePlayerSkillAccModel(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(player_skill_ratings)")).rows.map((row) => String(row.name));
  if (columns.length > 0 && !columns.includes("acc_model_json")) {
    await db.execute("alter table player_skill_ratings add column acc_model_json text");
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
      accuracy real,
      note_count integer,
      key_count integer not null default -1,
      speed_bucket text,
      mods_key text,
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
  // Peer accuracy columns: compaction blanks score_json, so accuracy and the
  // play's judged-object count get their own nullable columns. Existing rows
  // stay null until a maps-farmed refresh (or a compaction pass over rows that
  // still hold full score_json) fills them in.
  if (!farmedColumns.includes("accuracy")) {
    await db.execute("alter table country_maps_farmed_scores add column accuracy real");
  }
  if (!farmedColumns.includes("note_count")) {
    await db.execute("alter table country_maps_farmed_scores add column note_count integer");
  }
  // Farm-helper lane columns: the peer aggregation used to re-derive keymode,
  // speed lane, and mod identity from mods_json per row on every request, and
  // could only filter by keymode in JS after fetching the whole cohort's rows.
  // Stored at write time instead; -1 (key_count) and null (speed_bucket /
  // mods_key) mean "unknown" and readers fall back to the old derivation.
  if (!farmedColumns.includes("key_count")) {
    await db.execute("alter table country_maps_farmed_scores add column key_count integer not null default -1");
  }
  if (!farmedColumns.includes("speed_bucket")) {
    await db.execute("alter table country_maps_farmed_scores add column speed_bucket text");
  }
  if (!farmedColumns.includes("mods_key")) {
    await db.execute("alter table country_maps_farmed_scores add column mods_key text");
  }
  await backfillFarmedScoreLanes(db);
  // Covers the farm-helper peer aggregation outright: the (user_id, key_count)
  // prefix scopes a cohort read to one keymode, and the remaining columns are
  // everything that read consumes, so it never touches the main table. Created
  // after the backfill so the first boot builds it once over final data. It
  // also supersedes the old (user_id, beatmap_id, pp) index (dropped below;
  // every user_id-scoped read matches this prefix).
  await db.execute(`
    create index if not exists idx_country_maps_farmed_scores_user_lane
      on country_maps_farmed_scores(user_id, key_count, beatmap_id, pp, speed_bucket, mods_key, played_at, updated_at, accuracy)
  `);
  await db.execute("drop index if exists idx_country_maps_farmed_scores_user");

  // The GLOBAL projection mirrors the country rows, so it carries the same
  // nullable columns (its table is created by migrations/001_initial.sql).
  const globalFarmedColumns = (await db.execute("pragma table_info(global_maps_farmed_scores)")).rows.map((row) => String(row.name));
  if (globalFarmedColumns.length > 0 && !globalFarmedColumns.includes("accuracy")) {
    await db.execute("alter table global_maps_farmed_scores add column accuracy real");
  }
  if (globalFarmedColumns.length > 0 && !globalFarmedColumns.includes("note_count")) {
    await db.execute("alter table global_maps_farmed_scores add column note_count integer");
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

// One-time backfill of the farm-helper lane columns over existing rows. Runs
// exactly once per database (live_meta flag), synchronously at boot: prod has
// ~1.8M rows and finishes in well under a minute, and every read written since
// falls back gracefully for any row a crashed backfill left untouched (the
// WHERE clauses make a re-run resume instead of redo). key_count copies from
// maps_beatmaps (the same table readBeatmapMeta prefers, so the SQL filter and
// the JS meta filter agree); the lane identity maps through a scratch table
// with one row per distinct mods_json (a few hundred), not a JS pass over
// every row. A real table rather than a temp one: temp tables are
// per-connection and the client is free to pool.
async function backfillFarmedScoreLanes(db: Db): Promise<void> {
  const flagKey = "farmed_scores_lane_backfill:v1";
  const done = (await db.execute({ sql: "select 1 from live_meta where key = ?", args: [flagKey] })).rows[0];
  if (done) return;
  const startedAt = Date.now();

  await db.execute(`
    update country_maps_farmed_scores
    set key_count = coalesce(
      (select cast(round(b.cs) as integer) from maps_beatmaps b
        where b.beatmap_id = country_maps_farmed_scores.beatmap_id), -1)
    where key_count = -1
  `);

  const distinct = (await db.execute(
    "select distinct mods_json from country_maps_farmed_scores where speed_bucket is null",
  )).rows;
  if (distinct.length > 0) {
    await db.execute("drop table if exists _farmed_lane_backfill");
    await db.execute(
      "create table _farmed_lane_backfill (mods_json text, mods_key text not null, speed_bucket text not null)",
    );
    await db.execute("create unique index _farmed_lane_backfill_mods on _farmed_lane_backfill(mods_json)");
    for (const row of distinct) {
      const raw = row.mods_json == null ? null : String(row.mods_json);
      let parsed: string[] = [];
      try {
        const value: unknown = raw == null ? [] : JSON.parse(raw);
        if (Array.isArray(value)) parsed = value.filter((mod): mod is string => typeof mod === "string");
      } catch {
        parsed = [];
      }
      const mods = normalizeStoredMods(parsed);
      await db.execute({
        sql: "insert into _farmed_lane_backfill (mods_json, mods_key, speed_bucket) values (?, ?, ?)",
        args: [raw, mods.join(","), getScoreSpeedBucket(mods)],
      });
    }
    await db.execute(`
      update country_maps_farmed_scores
      set speed_bucket = (select m.speed_bucket from _farmed_lane_backfill m
             where m.mods_json is country_maps_farmed_scores.mods_json),
          mods_key = (select m.mods_key from _farmed_lane_backfill m
             where m.mods_json is country_maps_farmed_scores.mods_json)
      where speed_bucket is null
    `);
    await db.execute("drop table if exists _farmed_lane_backfill");
  }

  await db.execute({
    sql: "insert into live_meta (key, value_json, updated_at) values (?, ?, ?) on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at",
    args: [flagKey, JSON.stringify({ distinctMods: distinct.length }), new Date().toISOString()],
  });
  logInfo("farmed_scores_lane_backfill_done", {
    distinct_mods: distinct.length,
    duration_ms: Date.now() - startedAt,
  });
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

async function migratePackPullEvents(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists pack_pull_events (
      id integer primary key autoincrement,
      owner_user_id integer not null,
      owner_username text not null,
      card_user_id integer not null,
      card_username text not null,
      card_country_code text not null default '',
      tier text,
      pack_type text not null,
      is_new integer not null default 0,
      is_first_global integer not null default 0,
      notable integer not null default 0,
      pulled_at integer not null
    )
  `);
  await db.execute(`
    create index if not exists idx_pack_pull_events_card_time
      on pack_pull_events(card_user_id, pulled_at desc)
  `);
  await db.execute(`
    create index if not exists idx_pack_pull_events_owner_time
      on pack_pull_events(owner_user_id, pulled_at desc)
  `);
  await db.execute(`
    create index if not exists idx_pack_pull_events_time
      on pack_pull_events(pulled_at)
  `);
  await db.execute(`
    create index if not exists idx_pack_pull_events_notable_time
      on pack_pull_events(pulled_at desc) where notable = 1
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

async function migrateFarmHelperFeedback(db: Db): Promise<void> {
  // Per-player farm-helper feedback marks: "too hard" / "too easy" on one
  // recommendation lane (beatmap + speed bucket). Timestamps are epoch ms
  // (matching user_goals). A null resolved_at means the mark is active; when a
  // real score lands on the lane after the mark was set, auto-resolution stamps
  // resolved_at plus the score's pp and the real play drives recs again.
  await db.execute(`
    create table if not exists farm_helper_feedback (
      user_id integer not null,
      beatmap_id integer not null,
      speed_bucket text not null,
      verdict text not null,
      created_at integer not null,
      updated_at integer not null,
      resolved_at integer,
      resolved_pp real,
      primary key (user_id, beatmap_id, speed_bucket)
    )
  `);
  await db.execute(`
    create index if not exists idx_farm_helper_feedback_user_resolved
      on farm_helper_feedback(user_id, resolved_at)
  `);
}

async function migrateGoatPoll(db: Db): Promise<void> {
  // The community poll behind the honorary GOAT roster (src/lib/honorary-players.ts
  // on the frontend): users nominate osu!mania players and vote them up or down,
  // and the site owner reads the board by hand when the window closes. Nothing
  // here is automated on close, and no row is ever promoted to a real honoree by
  // code. Timestamps are epoch ms (matching user_goals / farm_helper_feedback).
  //
  // Both tables carry poll_id so a second poll never collides with this one's
  // rows: a rerun sets a fresh GOAT_POLL_ID and the old board stays queryable.
  //
  // Deliberately absent from retention.ts. The board IS the record of what the
  // community decided, so it outlives the poll rather than being pruned like the
  // transient run logs; the whole feature writes a few hundred rows at most.
  await db.execute(`
    create table if not exists goat_poll_nominees (
      id text primary key,
      poll_id text not null,
      osu_user_id integer,
      name_key text not null,
      username text not null,
      country_code text,
      avatar_url text,
      banned integer not null default 0,
      proof_url text,
      nominated_by integer not null,
      created_at integer not null
    )
  `);
  // Two unique indexes rather than one, because a banned or deleted account may
  // have no resolvable osu! id (the archive URL is the only handle we get, and
  // it does not always carry one). The id index is the real one: it collapses
  // the same player nominated once by search and once by hand under a different
  // spelling. name_key (punctuation-stripped, see features/goat-poll.ts) covers
  // the rows an id cannot, and applies only where there is no id — two accounts
  // whose names differ only in a dash are two players, and the id says so.
  await db.execute("drop index if exists idx_goat_poll_nominee_name");
  await db.execute(`
    create unique index if not exists idx_goat_poll_nominee_name_anon
      on goat_poll_nominees(poll_id, name_key) where osu_user_id is null
  `);
  await db.execute(`
    create unique index if not exists idx_goat_poll_nominee_user
      on goat_poll_nominees(poll_id, osu_user_id) where osu_user_id is not null
  `);
  // value is +1 or -1; clearing a vote deletes the row rather than storing 0, so
  // the per-account "how many nominees has this user touched" cap counts real
  // opinions and a user who undoes a vote gets their allowance back.
  await db.execute(`
    create table if not exists goat_poll_votes (
      poll_id text not null,
      nominee_id text not null,
      voter_user_id integer not null,
      value integer not null,
      updated_at integer not null,
      primary key (poll_id, nominee_id, voter_user_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_goat_poll_votes_voter
      on goat_poll_votes(poll_id, voter_user_id)
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
      visibility text not null default 'public',
      private_secret text,
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
  if (!skinColumns.includes("token_scope")) {
    // What an outstanding ticket unlocks on a published skin: 'previews' only
    // re-renders the keymode images, 'replace' also accepts a newer .osk.
    // Null on publish tickets, which unlock everything on a pending row.
    await db.execute("alter table skins add column token_scope text");
  }
  if (!skinColumns.includes("osk_updated_at")) {
    // When the .osk was last swapped for a newer build by its uploader; null
    // on skins that still carry the file they were published with.
    await db.execute("alter table skins add column osk_updated_at text");
  }
  if (!skinColumns.includes("visibility")) {
    // 'public' is the catalog skin everyone browses and downloads. 'private'
    // is the uploader's own: it stays off /skins, its page and its .osk answer
    // only to them, and replay viewers get the filtered bundle instead of the
    // archive. Orthogonal to status, which stays the publish/moderation axis.
    await db.execute("alter table skins add column visibility text not null default 'public'");
  }
  if (!skinColumns.includes("special_keymodes_json")) {
    // Keymodes whose layout is really (N-1)+1 (a 7K+1 skin inside its 8K
    // block), detected from skin.ini's ColumnLineWidth at upload time and
    // backfilled once for the existing catalog by backfillSkinSpecialKeymodes.
    await db.execute("alter table skins add column special_keymodes_json text not null default '[]'");
  }
  if (!skinColumns.includes("special_keymodes_manual")) {
    // Set once the owner corrects the 7K+1 detection by hand. A manual list
    // wins over anything derived from skin.ini: .osk replacements and backfill
    // re-scans must leave it alone.
    await db.execute("alter table skins add column special_keymodes_manual integer not null default 0");
  }
  if (!skinColumns.includes("visual_json")) {
    // Digest of the note art inside the .osk (shape mask, aspect, palette) for
    // the similar-skins scoring. Written at upload/replacement and backfilled
    // once for the existing catalog by backfillSkinVisualSignatures; null when
    // the archive ships no digestible note images.
    await db.execute("alter table skins add column visual_json text");
  }
  if (!skinColumns.includes("private_secret")) {
    // The capability behind a private skin's stored objects: it is a segment of
    // every R2 key the skin writes (so the public bucket URL cannot be guessed
    // from the id) and the ?t= the file endpoint checks. Handed out only in
    // owner-scoped reads, and rotated whenever a skin turns private.
    await db.execute("alter table skins add column private_secret text");
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
  // Duplicate-upload guard: the same .osk bytes are looked up by hash before a
  // ticket is minted and again when the archive lands. Not unique - a hash can
  // legitimately recur across pending rows and deleted-then-reuploaded skins.
  await db.execute(`
    create index if not exists idx_skins_osk_sha256
      on skins(osk_sha256) where osk_sha256 is not null
  `);
}

async function migrateUserReplaySkins(db: Db): Promise<void> {
  // Which published community skin (skins table) fronts a player's replays,
  // plus their customized settings as JSON. The payload references assets by
  // path inside the .osk only - the HTTP layer rejects embedded data: URLs.
  // Timestamps are ISO text (matching skins). Read by PK from the public
  // replay-skin endpoint, so no extra indexes. Durable: retention never prunes
  // it; a row whose skin was hidden or deleted simply reads back as "no skin".
  await db.execute(`
    create table if not exists user_replay_skins (
      user_id integer primary key,
      skin_id text not null,
      payload_json text not null,
      updated_at text not null
    )
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
      position real not null default 0,
      seq integer not null default 0
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

  // seq: the short human-readable handle ("#7") the owner quotes when pointing at a task. Oldest
  // task gets #1 so the numbering reads like a ledger, and it is never reused or renumbered —
  // deleting #7 leaves a gap on purpose, so an id always means the same task.
  if (!columns.includes("seq")) {
    await db.execute("alter table admin_todos add column seq integer not null default 0");
    await db.execute(`
      update admin_todos
         set seq = (
           select ranked.rn
             from (
               select id, row_number() over (order by created_at, id) as rn
                 from admin_todos
             ) ranked
            where ranked.id = admin_todos.id
         )
    `);
  }

  // Seed the allocator's high-water mark from the rows that exist. Without this the counter stays
  // absent until the first todo is *created*, and until then allocateTodoSeq falls back to
  // max(seq) — so deleting the newest task in that window would hand its id straight to the next
  // one. Runs on every boot (insert-or-ignore) so a DB that skipped the backfill is covered too.
  const maxSeq = Number((await db.execute("select max(seq) as max_seq from admin_todos")).rows[0]?.max_seq ?? 0);
  if (Number.isFinite(maxSeq) && maxSeq > 0) {
    await db.execute({
      sql: "insert or ignore into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      args: ["admin_todos_seq", JSON.stringify(maxSeq), new Date().toISOString()],
    });
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
  // These two heal rows written before raw_bytes / last_used_at existed. Every
  // write path has set both columns for a long time now (osu/beatmap-file-cache.ts),
  // so on a healed database they update zero rows — but neither predicate has a
  // usable index, and on prod this table is ~1.3GB of inline .osu blobs, so
  // "zero rows" still meant a full-table scan holding the write lock for seconds
  // on EVERY boot. That is the lock a deploy's DDL was losing the race to.
  // Run them once, record it, and stop paying the scan. Both are idempotent, and
  // the marker is written only after both succeed, so a crash in between simply
  // re-runs them rather than leaving half the table unhealed forever.
  const legacyHealKey = "beatmap_osu_files_legacy_heal:v1";
  if (!(await hasMigrationSentinel(db, legacyHealKey))) {
    await db.execute("update beatmap_osu_files set raw_bytes = length(content) where raw_bytes = 0 and content is not null and length(content) > 0");
    await db.execute("update beatmap_osu_files set last_used_at = fetched_at where last_used_at is null");
    await setMigrationSentinel(db, legacyHealKey);
  }
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
      msd_ln_json text,
      pattern_tags text not null default '',
      vibro integer not null default 0,
      updated_at text not null
    )
  `);
  // Chart-analysis join columns arrived after the table shipped; add them to
  // existing databases (fresh ones get them from the create above). Guarded per
  // column rather than as one block behind `dan_label`: a boot that died between
  // two ALTERs of a shared guard would find dan_label present next time and skip
  // its four siblings permanently.
  const mapSearchColumns = new Set((await db.execute("pragma table_info(map_search_index)")).rows.map((row) => String(row.name)));
  if (!mapSearchColumns.has("dan_label")) await db.execute("alter table map_search_index add column dan_label text");
  if (!mapSearchColumns.has("dan_family")) await db.execute("alter table map_search_index add column dan_family text");
  if (!mapSearchColumns.has("raw_dan")) await db.execute("alter table map_search_index add column raw_dan real");
  if (!mapSearchColumns.has("msd_json")) await db.execute("alter table map_search_index add column msd_json text");
  if (!mapSearchColumns.has("pattern_tags")) await db.execute("alter table map_search_index add column pattern_tags text not null default ''");
  if (!mapSearchColumns.has("vibro")) {
    await db.execute("alter table map_search_index add column vibro integer not null default 0");
  }
  if (!mapSearchColumns.has("msd_overall")) {
    // Plain real column for MSD-bucketed collections and future search sorts;
    // backfilled by the r5 BUILD_REVISION re-upsert.
    await db.execute("alter table map_search_index add column msd_overall real");
  }
  if (!mapSearchColumns.has("msd_ln_json")) {
    // Raw tail-aware MSD calc run (same semantics as
    // beatmap_chart_analysis.msd_ln_json; readers blend by keymode weight), so
    // bulk search rows carry the LN-adjusted MSD without a per-diff analysis
    // fetch. Backfilled by the r7 BUILD_REVISION re-upsert.
    await db.execute("alter table map_search_index add column msd_ln_json text");
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
  await migrateMapSearchFts(db);
  // Fresh planner stats so SQLite picks the ordered-scan + anti-join plan over
  // the older key_count-prefixed indexes.
  await analyzeMapSearchIndexIfStale(db);
}

// Trigram FTS over map_search_index.search_text: free-text terms used to be
// `search_text like '%term%'` full scans, re-run against every sibling diff
// inside the page query's dedup anti-join. The external-content FTS5 table
// keeps the same substring semantics (trigram tokenizer, terms of 3+ chars)
// behind an index; shorter terms stay on LIKE, over the FTS-narrowed rows
// whenever a longer term is present. Triggers keep it in sync with every
// writer (the index builder upserts via ON CONFLICT DO UPDATE, so the
// update-of-search_text trigger fires; REPLACE is never used on this table).
// Guarded as best-effort: a libsql build without the trigram tokenizer just
// logs and keeps the LIKE path (map-search probes availability per process).
async function migrateMapSearchFts(db: Db): Promise<void> {
  try {
    const exists = (await db.execute(
      "select 1 from sqlite_master where type = 'table' and name = 'map_search_fts'",
    )).rows[0];
    if (!exists) {
      await db.execute(
        "create virtual table map_search_fts using fts5(search_text, content='map_search_index', content_rowid='beatmap_id', tokenize='trigram')",
      );
    }
    // Triggers before the rebuild: SQLite's single-writer lock means a
    // concurrent upsert lands either before the rebuild's rescan (covered by
    // it) or after (covered by the trigger), never in between.
    await db.execute(`
      create trigger if not exists map_search_fts_ai after insert on map_search_index begin
        insert into map_search_fts(rowid, search_text) values (new.beatmap_id, new.search_text);
      end
    `);
    await db.execute(`
      create trigger if not exists map_search_fts_ad after delete on map_search_index begin
        insert into map_search_fts(map_search_fts, rowid, search_text) values ('delete', old.beatmap_id, old.search_text);
      end
    `);
    await db.execute(`
      create trigger if not exists map_search_fts_au after update of search_text on map_search_index begin
        insert into map_search_fts(map_search_fts, rowid, search_text) values ('delete', old.beatmap_id, old.search_text);
        insert into map_search_fts(rowid, search_text) values (new.beatmap_id, new.search_text);
      end
    `);
    if (!exists) {
      await db.execute("insert into map_search_fts(map_search_fts) values ('rebuild')");
    }
  } catch (error) {
    logWarn("map_search_fts_unavailable", {
      detail: "trigram FTS not created; map search keeps the LIKE path",
      ...errorContext(error),
    });
  }
}

const MAP_SEARCH_ANALYZE_KEY = "map_search_index_analyze:v1";
// Re-analyze once the table has grown/shrunk by this fraction (or 1k rows,
// whichever is larger) since the last run.
const MAP_SEARCH_ANALYZE_DRIFT = 0.25;

// `analyze` is a WRITE (it rewrites sqlite_stat1) that scans the table plus all
// 13 of its indexes — ~160MB on prod, seconds under memory pressure — and it
// used to run on every single boot, holding the write lock while the other
// process of a deploy was still serving. The planner only needs stats that are
// roughly right, so run it only when they can actually have gone wrong:
//   - the row count drifted (the reason stats decay in normal operation), or
//   - the *index set* changed. This is the case row counts cannot see: a deploy
//     that adds an index to this table — exactly what the deploy above did
//     elsewhere — leaves the new index with no sqlite_stat1 row while the other
//     13 have real ones, and that asymmetry is what makes the planner flip to a
//     bad plan. Waiting for 23k rows of drift to fix it is not acceptable.
// Both probes are cheap: the count is an index-only scan and the fingerprint is
// a sqlite_master read (milliseconds each).
async function analyzeMapSearchIndexIfStale(db: Db): Promise<void> {
  const rows = Number((await db.execute("select count(*) as cnt from map_search_index")).rows[0]?.cnt ?? 0);
  const indexes = (await db.execute(
    "select name from sqlite_master where type = 'index' and tbl_name = 'map_search_index' order by name",
  )).rows.map((row) => String(row.name)).join(",");
  const previous = await readMigrationSentinel<{ rows?: number; indexes?: string }>(db, MAP_SEARCH_ANALYZE_KEY, {});
  // A count recorded against an EMPTY table is not a baseline: stats over zero
  // rows tell the planner nothing, and treating them as fresh used to suppress
  // re-analysis until the table reached 1,000 rows. Any row at all invalidates
  // them, so only an equally empty table counts as unchanged.
  const rowsFresh = typeof previous.rows === "number"
    && (previous.rows > 0 || rows === 0)
    && Math.abs(rows - previous.rows) < Math.max(1_000, previous.rows * MAP_SEARCH_ANALYZE_DRIFT);
  if (rowsFresh && previous.indexes === indexes) return;
  await db.execute("analyze map_search_index");
  await setMigrationSentinel(db, MAP_SEARCH_ANALYZE_KEY, { rows, indexes, at: new Date().toISOString() });
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
  // Per column, not one block behind `axis`, for the same reason as the map
  // search index above: a partial block must not be permanently skippable.
  const collectionColumns = new Set((await db.execute("pragma table_info(map_collections)")).rows.map((row) => String(row.name)));
  if (!collectionColumns.has("axis")) await db.execute("alter table map_collections add column axis text");
  if (!collectionColumns.has("bucket_lo")) await db.execute("alter table map_collections add column bucket_lo real");
  if (!collectionColumns.has("bucket_hi")) await db.execute("alter table map_collections add column bucket_hi real");
  if (!collectionColumns.has("cover_sets_json")) await db.execute("alter table map_collections add column cover_sets_json text");
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
