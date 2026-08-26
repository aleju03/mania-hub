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
  await migratePackWalletOwnerUsername(target);
  await migratePackEternalRewards(target);
  await migratePackPullEvents(target);
  await migrateTrackerIndexes(target);
  await migrateSnipePersonalBests(target);
  await migrateUserGoals(target);
  await migrateFarmHelperFeedback(target);
  await migrateBeatmapOsuFileCache(target);
  await migrateMapSearchIndex(target);
  await migrateMapCollections(target);
  await migrateSkins(target);
  await migrateUploadedReplays(target);
  await migrateDiscordCommunities(target);
  await migrateUserReplaySkins(target);
  await migrateUserSignatures(target);
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
  await migrateTranslationReports(target);
  await migrateBugReports(target);
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
  // Whole-line `--` comments go before the split, not after it. Stripping them per chunk meant a
  // comment block sitting directly above a `create table` (no `;` between) made the chunk start
  // with `--` and dropped the table entirely; stripping them first also means a `;` *inside* a
  // comment can no longer cut the comment in half and paste its tail onto the next statement.
  // Safe because the schema file has no `--` outside line-leading comments (no inline comments,
  // none inside string literals), which `migration-sql.test.ts` holds to.
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
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
      card_key text not null,
      tier text,
      skills_id integer,
      pp real not null,
      global_rank integer not null,
      copies integer not null,
      recycled_copies integer not null,
      first_pulled_at integer not null,
      last_pulled_at integer not null,
      updated_at integer not null,
      completion_eligible integer not null default 1,
      primary key(owner_user_id, card_key)
    )
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_owner_tier
      on pack_collection_cards(owner_user_id, tier, copies, pp desc)
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_card_pulled
      on pack_collection_cards(card_user_id, first_pulled_at)
  `);
  await db.execute(`
    create table if not exists pack_cards (
      card_key text not null,
      tier text not null default '',
      card_user_id integer not null,
      username text not null default '',
      avatar_url text not null default '',
      country_code text not null default '',
      tier_label text,
      updated_at integer not null,
      primary key(card_key, tier)
    )
  `);
  await db.execute(`
    create table if not exists pack_card_skills (
      id integer primary key autoincrement,
      skills_json text not null unique
    )
  `);
  // One collector's own name for their copy, overriding the variant's shared
  // label. Only /admin/collections writes it; a pulled card leaves it null and
  // keeps reading the catalog's.
  const columns = (await db.execute("pragma table_info(pack_collection_cards)")).rows.map((row) => String(row.name));
  if (!columns.includes("tier_label")) {
    await db.execute("alter table pack_collection_cards add column tier_label text");
  }
  // The image this holding's card front floats in place of its tier's triangle
  // flecks or starfield, as the bounded JSON of src/lib/card-motif.ts. Same
  // ownership as the label above: /admin/collections writes it, the wallet
  // sync never touches it, and a pulled card leaves it null.
  if (!columns.includes("motif")) {
    await db.execute("alter table pack_collection_cards add column motif text");
  }
  // When the grant desk handed this holding out, null for a card that was
  // pulled. Rows that predate the column stay null and read as pulls, which is
  // right for all but the handful of cards granted before it existed.
  if (!columns.includes("granted_at")) {
    await db.execute("alter table pack_collection_cards add column granted_at integer");
  }
  // Browser-local first-login imports remain real holdings, but cannot count
  // as proof for the Eternal completion reward. A constant default keeps this
  // metadata-only for the existing multi-million-row table; only new import
  // writes opt out, while server deals opt back in on conflict.
  if (!columns.includes("completion_eligible")) {
    await db.execute("alter table pack_collection_cards add column completion_eligible integer not null default 1");
  }
  const serialColumns = (await db.execute("pragma table_info(pack_card_serials)")).rows.map((row) => String(row.name));
  if (!serialColumns.includes("pull_report_pending")) {
    // A constant default makes this a metadata-only ALTER on existing SQLite
    // databases. Every serial already present predates write-time minting and
    // is therefore settled; only new server draws explicitly write 1.
    await db.execute("alter table pack_card_serials add column pull_report_pending integer not null default 0");
  }
  // Dropped rather than declared: (owner_user_id, minted_at desc) was built for
  // a "this collector's mints, newest first" read nobody ever wrote. minted_at
  // is inserted and never read back, and every query against pack_card_serials
  // plans onto the primary key, idx_pack_card_serials_card or the serial = 1
  // partial index instead - so this was 50.8 MB of b-tree plus an insert on
  // every mint, for nothing. The migration no longer creates it; this clears it
  // off the databases that already have it.
  await db.execute("drop index if exists idx_pack_card_serials_owner");
}

// The last username a wallet's pulls were recorded under. Durable, unlike the
// pull log it used to be read back out of: collector-name fallbacks (the
// collectors list, the share card, the honorary report) need a name for owners
// with no users row, and pull events are pruned on a short retention now.
async function migratePackWalletOwnerUsername(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(pack_wallets)")).rows.map((row) => String(row.name));
  if (!columns.includes("owner_username")) {
    await db.execute("alter table pack_wallets add column owner_username text");
  }
}

async function migratePackEternalRewards(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists pack_eternal_rewards (
      owner_user_id integer primary key,
      claim_token text not null,
      dealt_at integer not null
    )
  `);
  // Seed the stronger claim registry from every existing Eternal holding,
  // including the manually granted variant-keyed cards that predate the
  // completion reward. Drive the join from the small card catalog, then seek
  // exact serial/holding keys, rather than scanning millions of collection
  // rows during deploy.
  await db.execute(`
    insert or ignore into pack_eternal_rewards (owner_user_id, claim_token, dealt_at)
    select c.owner_user_id, 'legacy:' || c.owner_user_id,
      max(coalesce(s.minted_at, c.updated_at))
    from pack_cards pc
    join pack_collection_cards c
      on c.card_key = pc.card_key and c.tier = 'eternal'
    left join pack_card_serials s
      on s.card_key = c.card_key and s.owner_user_id = c.owner_user_id
    where pc.tier = 'eternal'
    group by c.owner_user_id
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
      view_count integer not null default 0,
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
  if (!skinColumns.includes("view_count")) {
    // Skin-page opens, the other half of the popularity signal: most people
    // look at the previews and never grab the .osk, so downloads alone read as
    // near-zero interest. Seeded once from the analytics store's own pageviews
    // by backfillSkinViewCounts.
    await db.execute("alter table skins add column view_count integer not null default 0");
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
  if (!skinColumns.includes("lane_cover")) {
    // The archive facts the /skins filters read (src/skins/archive-meta.ts):
    // whether the .osk ships a lane cover, its own mania stage art, and
    // lazer-only modification files; and what the tap notes are, classified
    // from the visual signature. Written at upload/replacement and backfilled
    // once by backfillSkinArchiveMeta; null means not analyzed.
    await db.execute("alter table skins add column lane_cover integer");
    await db.execute("alter table skins add column mania_stage integer");
    await db.execute("alter table skins add column lazer integer");
    await db.execute("alter table skins add column note_shape text");
  }
  if (!skinColumns.includes("note_shapes_json")) {
    // Every distinct per-keymode note shape. note_shape remains the primary
    // label; this array lets a catalog filter include mixed skins too.
    await db.execute("alter table skins add column note_shapes_json text not null default '[]'");
  }
  if (!skinColumns.includes("resolution")) {
    // The uploader's word on what resolution the skin is made for ("1920x1080",
    // normalized). Optional at upload, editable with the details; never derived
    // from the archive.
    await db.execute("alter table skins add column resolution text");
  }
  if (!skinColumns.includes("listed_at")) {
    // When the skin first entered the public catalog, which is what the browse
    // page's newest sort orders by. published_at is the upload date and stays
    // that: a skin uploaded private and made public weeks later was published
    // then but listed now, and ordering the catalog on published_at buried it
    // pages deep on the day it became browsable. Null means never public yet.
    // Only the first listing stamps it, so toggling private and back is not a
    // way to bump a skin to the top.
    await db.execute("alter table skins add column listed_at text");
    // Every skin already in the catalog was listed the moment it published.
    await db.execute(
      "update skins set listed_at = published_at where visibility = 'public' and published_at is not null",
    );
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

async function migrateUploadedReplays(db: Db): Promise<void> {
  // Who uploaded which .osr through the frontend's /api/replay-upload. The file
  // and everything derived from it stay where they were (R2, plus the derived
  // description artifact) - this is only the owner index those cannot answer,
  // so a player can find their own uploads again and delete one.
  //
  // Timestamps are ISO text, matching skins and replay_video_exports. Rows are
  // durable: retention never prunes them, since a pruned row would silently
  // orphan a file the uploader can no longer reach.
  await db.execute(`
    create table if not exists uploaded_replays (
      id text primary key,
      owner_user_id integer not null,
      owner_username text not null,
      original_filename text,
      uploaded_at text not null
    )
  `);
  await db.execute(`
    create index if not exists idx_uploaded_replays_owner
      on uploaded_replays(owner_user_id, uploaded_at desc)
  `);
  // The admin shelf reads every uploader's newest first.
  await db.execute(`
    create index if not exists idx_uploaded_replays_uploaded_at
      on uploaded_replays(uploaded_at desc)
  `);
}

async function migrateDiscordCommunities(db: Db): Promise<void> {
  // The /communities directory: osu!mania Discord servers posted by the people
  // who run them. A row is written 'pending' and only an admin's approval makes
  // it public, so status is the whole publish axis here (skins, which publish on
  // upload, need a second visibility axis; this table does not).
  //
  // The server's identity - name, icon, banner, member counts - is whatever
  // Discord's invite endpoint reported, never what the form said, and the
  // refresh sweep keeps rewriting it. Only the pitch and the tags come from the
  // submitter. guild_id is unique, so one Discord server is one listing however
  // many people try to post it.
  //
  // Timestamps are ISO text (matching skins). Durable: retention only sweeps
  // pending rows nobody ever reviewed.
  await db.execute(`
    create table if not exists discord_communities (
      id text primary key,
      guild_id text not null,
      invite_code text not null,
      name text not null,
      icon_hash text,
      banner_hash text,
      member_count integer not null default 0,
      online_count integer not null default 0,
      pitch text not null default '',
      country_code text,
      language text,
      tags_json text not null default '[]',
      search_text text not null default '',
      owner_user_id integer not null,
      owner_username text not null,
      discord_user_id text not null,
      discord_username text not null,
      is_guild_owner integer not null default 0,
      status text not null default 'pending',
      reject_reason text,
      edited_since_review integer not null default 0,
      reviewed_at text,
      approved_at text,
      invite_ok integer not null default 1,
      invite_fail_count integer not null default 0,
      invite_checked_at text,
      invite_expires_at text,
      created_at text not null,
      updated_at text not null
    )
  `);
  // Keymode and purpose tags were dropped before the directory ever opened: a
  // list of Discord servers has no business asking about keys. Nothing reads
  // these, so they go rather than linger as columns nobody can explain. Guarded
  // for databases created during the day they existed; neither is indexed, so
  // the drop is safe.
  const communityColumns = (await db.execute("pragma table_info(discord_communities)")).rows.map((row) => String(row.name));
  if (communityColumns.includes("keymodes_json")) {
    await db.execute("alter table discord_communities drop column keymodes_json");
  }
  if (communityColumns.includes("purposes_json")) {
    await db.execute("alter table discord_communities drop column purposes_json");
  }
  // Tags came back, but owner-typed rather than picked from a vocabulary: the
  // fixed lists above were the part that read wrong, not the idea of tagging. A
  // JSON array of already-normalized strings, read with json_each for the facet
  // row on the directory, so the filters are only ever what people actually
  // typed. Added after the table existed, hence the guard.
  if (!communityColumns.includes("tags_json")) {
    await db.execute("alter table discord_communities add column tags_json text not null default '[]'");
  }
  // When the listed invite stops working, or null for a permanent one. An
  // expiring invite used to be refused outright; it is allowed now, warned
  // about, and remembered here so the owner and the review page can see it
  // coming rather than only finding out when the sweep hides the listing.
  if (!communityColumns.includes("invite_expires_at")) {
    await db.execute("alter table discord_communities add column invite_expires_at text");
  }
  // What Discord itself knows about the server, for its listing page: the
  // server's own description (not the submitter's pitch), how many boosts it is
  // carrying, and flags like PARTNERED or COMMUNITY. All three ride the invite
  // response, so they cost no extra call and are rewritten by the same refresh
  // sweep. Rows listed before this fill in on their next sweep.
  if (!communityColumns.includes("guild_description")) {
    await db.execute("alter table discord_communities add column guild_description text");
  }
  if (!communityColumns.includes("boost_count")) {
    await db.execute("alter table discord_communities add column boost_count integer not null default 0");
  }
  if (!communityColumns.includes("features_json")) {
    await db.execute("alter table discord_communities add column features_json text not null default '[]'");
  }
  // Who the server is for: a JSON array of scope codes, mixing plain country
  // codes with the R- region codes from regions.ts, and empty meaning everyone.
  // access_hidden is the owner's second choice - whether someone outside those
  // places sees the listing without a way in, or does not see it at all.
  //
  // Note this filters, it does not enforce. The invite is withheld from a
  // viewer who does not match, but anyone already inside can paste it anywhere;
  // a real wall is Discord-side membership screening.
  if (!communityColumns.includes("access_scopes_json")) {
    await db.execute("alter table discord_communities add column access_scopes_json text not null default '[]'");
  }
  if (!communityColumns.includes("access_hidden")) {
    await db.execute("alter table discord_communities add column access_hidden integer not null default 0");
  }
  // One Discord server is one listing. Enforced here rather than in the feature
  // module because two people who both run the server can submit concurrently.
  await db.execute(`
    create unique index if not exists idx_discord_communities_guild
      on discord_communities(guild_id)
  `);
  // The default browse order: approved rows, biggest first.
  await db.execute(`
    create index if not exists idx_discord_communities_status_members
      on discord_communities(status, member_count desc)
  `);
  // "My listings" on the page, and the per-account cap on submit.
  await db.execute(`
    create index if not exists idx_discord_communities_owner
      on discord_communities(owner_user_id, created_at desc)
  `);
  // The admin queue reads pending rows and approved-but-edited rows together;
  // both are covered by leading with status.
  await db.execute(`
    create index if not exists idx_discord_communities_review
      on discord_communities(status, edited_since_review, created_at desc)
  `);
  // The refresh sweep claims the approved rows checked longest ago. Nulls sort
  // first in SQLite, so a never-checked row is picked up before any other.
  await db.execute(`
    create index if not exists idx_discord_communities_checked
      on discord_communities(status, invite_checked_at)
  `);

  /*
   * What someone browsing the directory flagged about a listing.
   *
   * Read only by the review page, never by the listing's owner: a report is a
   * message to a moderator, and showing an owner who complained about them
   * would make it something else. status goes open -> resolved, and every
   * review decision on the listing resolves its open reports, because the
   * decision is the answer to them.
   */
  await db.execute(`
    create table if not exists discord_community_reports (
      id text primary key,
      community_id text not null,
      reporter_user_id integer not null,
      reporter_username text not null default '',
      reason text not null default 'other',
      details text not null default '',
      status text not null default 'open',
      resolved_at text,
      resolved_by integer,
      created_at text not null,
      updated_at text not null
    )
  `);
  // One person, one report per listing. Reporting again rewrites their own row
  // rather than adding to a pile, so ten clicks are still one voice, and a
  // listing that was already dealt with can be flagged again afterwards.
  await db.execute(`
    create unique index if not exists idx_discord_community_reports_one
      on discord_community_reports(community_id, reporter_user_id)
  `);
  // The review page reads the open ones, oldest first.
  await db.execute(`
    create index if not exists idx_discord_community_reports_open
      on discord_community_reports(status, created_at)
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

async function migrateUserSignatures(db: Db): Promise<void> {
  // Dynamic renders: the opt-in record behind a player's signature images.
  // `token` addresses the renders in a URL the player pastes into an osu!
  // profile, so it is unique and carries its own index; rotating it is the
  // only way to revoke an embed already out in the world, and disabling keeps
  // it so re-enabling restores the same URL. Timestamps are epoch ms (matching
  // user_goals). `enabled_types_json` is per-type publication rather than one
  // switch: with a single token, publishing a maniacard would otherwise make
  // the goals URL constructible from it, so goals must be opted into on their
  // own. Read by token on an image path, so no extra indexes. Durable:
  // retention never prunes it, and a reaped token would break a pasted profile.
  await db.execute(`
    create table if not exists user_signatures (
      user_id integer primary key,
      token text not null unique,
      enabled integer not null default 1,
      enabled_types_json text not null default '["maniacard"]',
      skills_key_count integer,
      created_at integer not null,
      updated_at integer not null,
      rotated_at integer
    )
  `);
  // Per-type look (background, accent, opacity, blur), authored on the
  // /dynamic-renders page. It lives here rather than in the image URL because
  // that URL is pasted once and never edited, and because a style that came
  // from the request would let one URL mint unbounded stored renders. Stored
  // opaquely: the frontend owns the option lists and normalizes both on write
  // and on read, and this column's only job here is to feed the version hash.
  const columns = (await db.execute("pragma table_info(user_signatures)")).rows.map((row) => String(row.name));
  if (!columns.includes("style_json")) {
    await db.execute("alter table user_signatures add column style_json text");
  }
  // The moderation kill switch, separate from `enabled` on purpose: `enabled`
  // is the player's own switch and they can flip it back, so reusing it for a
  // block would let the account undo the moderation. A blocked row refuses to
  // resolve, so every image behind that token 404s no matter what the player
  // does next.
  if (!columns.includes("blocked_at")) {
    await db.execute("alter table user_signatures add column blocked_at integer");
  }
  // How many times an admin has taken a background off this row. Clearing a
  // picture is an undo rather than a penalty - the player can set another one
  // straight away and is never told - so without a tally the escalation from
  // "clear it" to "block them" depends on a moderator remembering faces.
  if (!columns.includes("cleared_count")) {
    await db.execute("alter table user_signatures add column cleared_count integer not null default 0");
  }
  // The player's own IANA zone, sent by their browser from /dynamic-renders.
  // A render prints the day a top play was set, and there is no viewer at
  // render time to ask - the PNG is stored once per version and served to
  // everyone - so the day has to be the OWNER's. Without this it was UTC, which
  // dates an evening play in the Americas to the following morning. Null means
  // "never told", and falls back to UTC, so nothing already stored moves until
  // its player opens the page.
  if (!columns.includes("time_zone")) {
    await db.execute("alter table user_signatures add column time_zone text");
  }
}

async function migrateTranslationReports(db: Db): Promise<void> {
  // Reader-submitted reports about the site's UI translations (see
  // features/translation-reports.ts). Open to signed-out visitors, so user_id
  // is nullable and `reporter_key` carries the opaque per-reporter bucket the
  // caps key on ("user:<id>" or "ip:<hash>"), never shown on the admin board.
  // status is new|resolved|dismissed, timestamps are epoch ms. Durable:
  // retention never prunes this table.
  await db.execute(`
    create table if not exists translation_reports (
      id text primary key,
      locale text not null,
      status text not null default 'new',
      source_text text not null,
      suggestion text,
      note text,
      page_path text,
      user_id integer,
      username text,
      admin_note text,
      created_at integer not null,
      updated_at integer not null,
      reviewed_at integer,
      reporter_key text not null default 'anon'
    )
  `);
  await db.execute(`
    create index if not exists idx_translation_reports_status
      on translation_reports(status, created_at desc)
  `);
  // The per-reporter cap and the duplicate guard both scan one reporter's
  // recent rows on every submit.
  await db.execute(`
    create index if not exists idx_translation_reports_reporter
      on translation_reports(reporter_key, created_at desc)
  `);
}

async function migrateBugReports(db: Db): Promise<void> {
  // Player-filed bug reports (see features/bug-reports.ts). Same open-write
  // shape as translation_reports above: signed-out visitors may file, so
  // user_id is nullable and `reporter_key` carries the opaque per-reporter
  // bucket the caps key on. status is new|investigating|fixed|wontfix|
  // duplicate, timestamps are epoch ms. Durable: retention never prunes this
  // table.
  //
  // Two text columns that look alike are not: `admin_note` is private triage
  // scratch, `reply` is written for the reporter and shown back to them on
  // /report. Nothing joins them, so a note can never leak by being rendered on
  // the wrong side.
  await db.execute(`
    create table if not exists bug_reports (
      id text primary key,
      status text not null default 'new',
      body text not null,
      page_path text,
      context_json text,
      user_id integer,
      username text,
      reporter_key text not null default 'anon',
      screenshot_keys text,
      upload_token text,
      token_expires_at integer,
      admin_note text,
      reply text,
      replied_at integer,
      todo_id text,
      created_at integer not null,
      updated_at integer not null,
      resolved_at integer
    )
  `);
  await db.execute(`
    create index if not exists idx_bug_reports_status
      on bug_reports(status, created_at desc)
  `);
  // The per-reporter cap and the duplicate guard both scan one reporter's
  // recent rows on every submit.
  await db.execute(`
    create index if not exists idx_bug_reports_reporter
      on bug_reports(reporter_key, created_at desc)
  `);
  // "Your reports" on /report reads one signed-in reporter's own rows.
  await db.execute(`
    create index if not exists idx_bug_reports_user
      on bug_reports(user_id, created_at desc)
  `);
  // Replies are a conversation, not one mutable cell. The report body remains
  // the first reporter message on bug_reports; everything after it is appended
  // here so both sides keep the full history. `legacy_reply` identifies rows
  // copied from the old mutable column; ordinary messages remain free to repeat
  // the same text.
  await db.execute(`
    create table if not exists bug_report_messages (
      id text primary key,
      report_id text not null,
      author_role text not null,
      body text not null,
      created_at integer not null,
      legacy_reply integer not null default 0
    )
  `);
  await db.execute(`
    create index if not exists idx_bug_report_messages_report
      on bug_report_messages(report_id, created_at, id)
  `);
  await db.execute(`
    create unique index if not exists idx_bug_report_messages_legacy
      on bug_report_messages(report_id) where legacy_reply = 1
  `);
  // New conversation writes mirror the newest admin message into `reply` for
  // rolling-deploy compatibility. The original backfill only looked for a
  // legacy-marked row, so the next boot mistook that mirror for old data and
  // copied the modern message a second time. Remove only those exact generated
  // pairs before applying the corrected backfill below.
  await db.execute(`
    delete from bug_report_messages
     where legacy_reply = 1
       and exists (
         select 1 from bug_report_messages as current_message
          where current_message.report_id = bug_report_messages.report_id
            and current_message.author_role = 'admin'
            and current_message.legacy_reply = 0
            and current_message.body = bug_report_messages.body
            and current_message.created_at = bug_report_messages.created_at
       )
  `);
  await db.execute(`
    insert into bug_report_messages (id, report_id, author_role, body, created_at, legacy_reply)
    select lower(hex(randomblob(16))), report.id, 'admin', report.reply,
           coalesce(report.replied_at, report.updated_at), 1
      from bug_reports as report
     where report.reply is not null and trim(report.reply) <> ''
       and not exists (
         select 1 from bug_report_messages as message
          where message.report_id = report.id
            and (
              message.legacy_reply = 1
              or (
                message.author_role = 'admin'
                and message.body = report.reply
                and message.created_at = coalesce(report.replied_at, report.updated_at)
              )
            )
       )
  `);
  // A reporter follow-up reopens a report and moves it to the front of both
  // queues, so these reads order by updated_at rather than original filing day.
  await db.execute(`
    create index if not exists idx_bug_reports_status_updated
      on bug_reports(status, updated_at desc)
  `);
  await db.execute(`
    create index if not exists idx_bug_reports_user_updated
      on bug_reports(user_id, updated_at desc)
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
  // Per-osu-account accent colors for player names (features/avatar-accents.ts). status is ok|error
  // (error rows retry after a day). Retention prunes rows older than ~180d as a slow refresh;
  // everything self-heals via compute jobs.
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

  // v1 stored the complete cache-busted osu! URL (`/123?timestamp.jpeg`). The account-keyed v2
  // normalizer intentionally strips that query, but shipping it without moving the existing rows
  // made every known accent look like a miss and flooded the extraction lane with thousands of
  // duplicate jobs. Collapse the old rows in-place, keeping the newest result when an account has
  // more than one avatar URL, then retire only the now-redundant queued jobs. This is deliberately
  // a one-shot boot migration: the request path only writes canonical keys after this version.
  const canonicalKeyMigration = "avatar_accents_account_keys:v1";
  if (!(await hasMigrationSentinel(db, canonicalKeyMigration))) {
    const prefix = "https://a.ppy.sh/";
    await db.execute({
      sql: `
        insert into avatar_accents (avatar_url, accent, status, computed_at)
        select substr(avatar_url, 1, instr(avatar_url, '?') - 1), accent, status, computed_at
          from avatar_accents
         where substr(avatar_url, 1, ?) = ?
           and instr(avatar_url, '?') > ?
           and length(substr(avatar_url, ? + 1, instr(avatar_url, '?') - ? - 1)) between 1 and 12
           and substr(avatar_url, ? + 1, instr(avatar_url, '?') - ? - 1) glob '[0-9]*'
           and substr(avatar_url, ? + 1, instr(avatar_url, '?') - ? - 1) not glob '*[^0-9]*'
        on conflict(avatar_url) do update set
          accent = excluded.accent,
          status = excluded.status,
          computed_at = excluded.computed_at
        where excluded.computed_at > avatar_accents.computed_at
      `,
      args: [
        prefix.length,
        prefix,
        prefix.length + 1,
        prefix.length,
        prefix.length,
        prefix.length,
        prefix.length,
        prefix.length,
        prefix.length,
      ],
    });
    await db.execute({
      sql: `
        delete from avatar_accents
         where substr(avatar_url, 1, ?) = ?
           and instr(avatar_url, '?') > ?
           and length(substr(avatar_url, ? + 1, instr(avatar_url, '?') - ? - 1)) between 1 and 12
           and substr(avatar_url, ? + 1, instr(avatar_url, '?') - ? - 1) glob '[0-9]*'
           and substr(avatar_url, ? + 1, instr(avatar_url, '?') - ? - 1) not glob '*[^0-9]*'
      `,
      args: [
        prefix.length,
        prefix,
        prefix.length + 1,
        prefix.length,
        prefix.length,
        prefix.length,
        prefix.length,
        prefix.length,
        prefix.length,
      ],
    });
    await db.execute(`
      delete from jobs
       where type = 'compute_avatar_accent'
         and status = 'queued'
         and exists (
           select 1 from avatar_accents
            where avatar_accents.status = 'ok'
              and jobs.dedupe_key = 'avatar-accent:' || avatar_accents.avatar_url
         )
    `);
    await setMigrationSentinel(db, canonicalKeyMigration);
  }
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
  // The archived-mods backfill's work list (features/activity-mods-backfill.ts).
  // Materialized once at seed time because picking it needs a per-player
  // ranking, which does not chunk against a cursor; the chain then walks this
  // by `position`. Small and bounded by ACTIVITY_MODS_BACKFILL_MAX_ROWS.
  await db.execute(`
    create table if not exists activity_mods_backfill_queue (
      position integer primary key,
      country text not null,
      user_id integer not null,
      day text not null,
      beatmap_id integer not null,
      score_id integer not null,
      dan real not null
    )
  `);
}
