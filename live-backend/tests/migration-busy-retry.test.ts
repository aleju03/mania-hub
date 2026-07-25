import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must land before db.js is imported: the busy-retry budgets are read at module
// load. This one only bounds the generic durable-write path (the pragma re-apply
// inside a reconnect); the migration budgets are passed per call below so each
// case can pick its own without touching the module registry.
process.env.SQLITE_BUSY_RETRY_MS = "300";
const { createDb, getSqliteBusyRetryStats, migrate } = await import("../src/db.js");
type Db = Awaited<ReturnType<typeof createDb>>;

// The 2026-07-24 deploy: the worker restarted into a database the previous
// process was still writing, migrate() threw SQLITE_BUSY out of a CREATE INDEX,
// and systemd crash-looped it 12 times in ~2 minutes with score ingest down.
// Every case below generates the contention for real, with a second connection
// holding a write transaction, rather than mocking libsql.
describe("migrate() under write-lock contention", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  async function tempDbUrl(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-migrate-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return `file:${join(dir, "test.db")}`;
  }

  async function openDb(url: string): Promise<Db> {
    // busy_timeout 10ms so a blocked statement fails fast and the retry loop is
    // what we are actually measuring; prod uses 10s on the migration connection.
    const db = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10, sqliteCacheMb: 2, sqliteMmapMb: 0 });
    cleanups.push(() => db.close());
    return db;
  }

  // Holds the single SQLite write lock exactly the way a still-running previous
  // process does during a deploy.
  async function holdWriteLock(url: string): Promise<{ release: () => Promise<void> }> {
    const holder = await openDb(url);
    await holder.execute("pragma journal_mode = wal");
    await holder.execute("begin immediate");
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await holder.execute("rollback");
    };
    cleanups.push(release);
    return { release };
  }

  function captureLogs(): { lines: Array<Record<string, unknown>> } {
    const lines: Array<Record<string, unknown>> = [];
    const record = (value: unknown) => {
      if (typeof value !== "string") return;
      try {
        lines.push(JSON.parse(value) as Record<string, unknown>);
      } catch {
        // Not a structured log line.
      }
    };
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "log").mockImplementation(record);
    return { lines };
  }

  // Records the SQL of every statement migrate() issues, so a test can prove
  // what was retried (and what was not re-run).
  function recordStatements(db: Db, sink: string[]): Db {
    return new Proxy(db, {
      get(_target, prop) {
        if (prop === "execute") {
          return (...args: unknown[]) => {
            sink.push(sqlOf(args));
            return (db as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute(...args);
          };
        }
        const value = (db as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(db) : value;
      },
    }) as Db;
  }

  it("waits out a concurrent writer and lands the schema DURABLY", async () => {
    const url = await tempDbUrl();
    const lock = await holdWriteLock(url);
    const db = await openDb(url);
    const logs = captureLogs();

    const contended: string[] = [];
    const before = getSqliteBusyRetryStats();
    const migration = migrate(recordStatements(db, contended), { totalBusyBudgetMs: 30_000 });
    // The writer holds on past the first pass, then lets go — the deploy case
    // that used to kill the worker outright.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await lock.release();
    await expect(migration).resolves.toBeUndefined();

    const after = getSqliteBusyRetryStats();
    expect(after.attempts).toBeGreaterThan(before.attempts);
    expect(after.exhausted).toBe(before.exhausted);

    // THE assertion, and the one a same-connection check cannot make: a libsql
    // connection that has once returned SQLITE_BUSY keeps reporting success for
    // writes that never commit, so the migrating connection would happily list
    // all 59 tables while a second process saw an empty database. Read the result
    // through a connection that did not run the migration.
    const reader = await openDb(url);
    const tables = new Set((await reader.execute("select name from sqlite_master where type = 'table'")).rows.map((row) => String(row.name)));
    for (const table of ["live_meta", "jobs", "map_search_index", "skins", "user_goals", "map_collections"]) {
      expect(tables.has(table)).toBe(true);
    }

    // The pass that finally landed is an ordinary, complete migration: identical
    // statements, in identical order, to an uncontended run. Nothing was resumed
    // half-way, which is what would re-enter the multi-column ALTER guards.
    const uncontended: string[] = [];
    const freshDb = await openDb(await tempDbUrl());
    await migrate(recordStatements(freshDb, uncontended));
    const finalPassStart = contended.lastIndexOf(uncontended[0]!);
    expect(contended.slice(finalPassStart)).toEqual(uncontended);
    expect(finalPassStart).toBeGreaterThan(0); // i.e. an earlier pass really was thrown away

    // And it said so in the journal, under its own message and counter — never
    // the stale-connection wedge signal (see the budget test below).
    const waited = logs.lines.filter((line) => line.message === "sqlite_migration_busy_wait");
    expect(waited.length).toBeGreaterThan(0);
    expect(String(waited[0]?.sql ?? "")).not.toBe("");
    expect(logs.lines.some((line) => line.message === "sqlite_migration_connection_reopened")).toBe(true);
    expect(after.migrationReconnects).toBeGreaterThan(before.migrationReconnects);
    expect(after.reconnects).toBe(before.reconnects);
    const summary = logs.lines.find((line) => line.message === "sqlite_migration_busy_summary");
    expect(summary).toBeTruthy();
    expect(Number(summary?.busy_waited_ms)).toBeGreaterThan(0);
    expect(Number(summary?.failed_passes)).toBeGreaterThan(0);
  });

  it("reproduces the incident with the retry disabled (budget 0)", async () => {
    // The pre-fix path, kept as the control for the case above: the same
    // contention, the same database, no retry budget — and migrate() dies on the
    // first statement, which is what crash-looped the worker on 2026-07-24.
    const url = await tempDbUrl();
    const lock = await holdWriteLock(url);
    const db = await openDb(url);

    const migration = migrate(db, { totalBusyBudgetMs: 0 });
    await expect(migration).rejects.toThrow(/SQLITE_BUSY|database is locked/i);
    await lock.release();
  });

  it("gives up once the budget is spent, loudly, instead of retrying forever", async () => {
    const url = await tempDbUrl();
    await holdWriteLock(url); // never released
    const db = await openDb(url);
    const logs = captureLogs();

    const before = getSqliteBusyRetryStats();
    const startedAt = Date.now();
    await expect(migrate(db, { totalBusyBudgetMs: 800 }))
      .rejects.toThrow(/SQLITE_BUSY|database is locked/i);
    const elapsedMs = Date.now() - startedAt;

    // Bounded by the contention budget: a wedged database fails boot (so systemd
    // retries and the wedge stays visible) instead of hanging it.
    expect(elapsedMs).toBeLessThan(4_000);
    const after = getSqliteBusyRetryStats();
    expect(after.exhausted).toBe(before.exhausted + 1);
    // Deploy contention must NOT masquerade as the stale-snapshot wedge. That
    // recovery's warn and its "reconnects" counter (surfaced by /api/status and
    // /valley) mean one specific thing — a long-lived connection went stale —
    // and a seconds-old migration connection that has run only pragmas and DDL
    // cannot be in that state. Firing it here would turn the write-freeze signal
    // from the previous incident into deploy noise.
    expect(after.reconnects).toBe(before.reconnects);
    expect(logs.lines.some((line) => line.message === "sqlite_wedged_connection_reopened")).toBe(false);

    const exhausted = logs.lines.find((line) => line.message === "sqlite_migration_busy_exhausted");
    expect(exhausted).toBeTruthy();
    expect(String(exhausted?.sql ?? "")).toContain("create table");
    expect(exhausted?.total_budget_ms).toBe(800);
    expect(Number(exhausted?.failed_passes)).toBeGreaterThan(0);
  });

  it("fails immediately on anything that is not lock contention", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);
    const logs = captureLogs();

    // Poison one statement mid-migration with a non-busy error (a schema error,
    // a constraint violation and a corrupt page all land here). It must surface
    // unchanged and be attempted exactly once, not retried for 30s.
    let seen = 0;
    let poisonSql: string | null = null;
    let poisonAttempts = 0;
    const poisoned = new Proxy(db, {
      get(_target, prop) {
        if (prop === "execute") {
          return (...args: unknown[]) => {
            const sql = sqlOf(args);
            seen += 1;
            if (seen === 5 && poisonSql === null) poisonSql = sql;
            if (poisonSql !== null && sql === poisonSql) {
              poisonAttempts += 1;
              return Promise.reject(new Error('SQLITE_ERROR: near "bogus": syntax error'));
            }
            return (db as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute(...args);
          };
        }
        const value = (db as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(db) : value;
      },
    }) as Db;

    const startedAt = Date.now();
    await expect(migrate(poisoned, { totalBusyBudgetMs: 300_000 }))
      .rejects.toThrow(/near "bogus": syntax error/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(poisonAttempts).toBe(1);
    expect(logs.lines.some((line) => String(line.message ?? "").startsWith("sqlite_migration_busy"))).toBe(false);
  });

  it("takes the untouched path when nothing is contending", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);
    const logs = captureLogs();

    const before = getSqliteBusyRetryStats();
    const first: string[] = [];
    await migrate(recordStatements(db, first));
    const second: string[] = [];
    await migrate(recordStatements(db, second));
    const after = getSqliteBusyRetryStats();

    // Zero retries, zero recorded busy operations, zero extra statements: the
    // ~30 suites that migrate a tmpdir database keep exactly today's behaviour.
    expect(after.attempts).toBe(before.attempts);
    expect(after.operations).toBe(before.operations);
    expect(after.exhausted).toBe(before.exhausted);
    expect(after.reconnects).toBe(before.reconnects);
    expect(after.migrationReconnects).toBe(before.migrationReconnects);
    expect(logs.lines.some((line) => String(line.message ?? "").startsWith("sqlite_migration_"))).toBe(false);
    // Every statement issued exactly once per run — nothing was re-issued and
    // nothing was replayed from the top.
    expect(first.filter((sql) => sql === "pragma journal_mode = WAL")).toHaveLength(1);
    expect(second.filter((sql) => sql === "pragma journal_mode = WAL")).toHaveLength(1);
  });

  it("stops re-running the expensive one-shot steps on every boot", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);

    const firstBoot: string[] = [];
    await migrate(recordStatements(db, firstBoot));
    const secondBoot: string[] = [];
    await migrate(recordStatements(db, secondBoot));

    // The two beatmap_osu_files heals are full-table scans over ~1.3GB of inline
    // .osu blobs on prod, and `analyze map_search_index` is a write that scans
    // the table plus 13 indexes. All three used to hold the write lock on every
    // single boot, which is what a deploy's DDL was losing the race to.
    const legacyHeal = /update beatmap_osu_files set (raw_bytes|last_used_at)/i;
    const analyze = /^analyze map_search_index$/i;
    expect(firstBoot.filter((sql) => legacyHeal.test(sql)).length).toBe(2);
    expect(firstBoot.filter((sql) => analyze.test(sql)).length).toBe(1);
    expect(secondBoot.filter((sql) => legacyHeal.test(sql)).length).toBe(0);
    expect(secondBoot.filter((sql) => analyze.test(sql)).length).toBe(0);

    const markers = (await db.execute(
      "select key from live_meta where key in ('beatmap_osu_files_legacy_heal:v1', 'map_search_index_analyze:v1')",
    )).rows.map((row) => String(row.key));
    expect(markers.sort()).toEqual(["beatmap_osu_files_legacy_heal:v1", "map_search_index_analyze:v1"]);
  });

  it("re-analyzes map_search_index when the index set changes, not just the row count", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);
    await migrate(db);

    // A future deploy adds an index to this table (exactly what this deploy did
    // to top_play_events). The new index has no sqlite_stat1 row while the other
    // 13 have real ones, and that asymmetry is what flips the planner onto a bad
    // plan — but the table has not grown, so a row-count gate would leave it
    // that way until the table gained 23k rows.
    await db.execute("create index idx_map_search_test_probe on map_search_index(key_count, length, stars)");
    const afterNewIndex: string[] = [];
    await migrate(recordStatements(db, afterNewIndex));
    expect(afterNewIndex.filter((sql) => /^analyze map_search_index$/i.test(sql))).toHaveLength(1);

    // ...and once the fingerprint is recorded it goes quiet again.
    const steady: string[] = [];
    await migrate(recordStatements(db, steady));
    expect(steady.filter((sql) => /^analyze map_search_index$/i.test(sql))).toHaveLength(0);

    // Stats taken over an empty table are worthless the moment there are rows,
    // so the first non-empty boot re-analyzes instead of waiting for 1k rows.
    await db.execute(
      `insert into map_search_index
         (beatmap_id, beatmapset_id, analysis_version, title, artist, version, search_text, key_count, stars, bpm, length, status, primary_pattern, updated_at)
       values (1, 1, 1, 't', 'a', 'v', 't a v', 4, 5.0, 180, 120, 'ranked', 'stream', '2026-01-01')`,
    );
    const afterFirstRow: string[] = [];
    await migrate(recordStatements(db, afterFirstRow));
    expect(afterFirstRow.filter((sql) => /^analyze map_search_index$/i.test(sql))).toHaveLength(1);
  });

  it("recovers from a boot that died between two ALTERs of the same guard", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);
    // Exactly the state a crash (budget exhaustion, a deploy's SIGTERM) between
    // the 1st and 2nd ALTER of migrateTopPlayEventsHotColumns leaves behind:
    // 001_initial.sql's table plus score_time, without its two siblings. Every
    // fresh database traverses that block, and while all three columns hid
    // behind one score_time guard, the next boot skipped them forever and then
    // threw "no such column: key_count" out of the index below — a non-busy
    // error, so the retry loop rethrew it on attempt 1, on every boot, forever.
    await db.execute(`
      create table top_play_events (
        country text not null,
        score_id integer not null,
        user_id integer not null,
        pp real not null,
        weighted_pp real not null,
        pp_gain real not null,
        payload_json text not null,
        detected_at text not null,
        score_time text,
        primary key (country, score_id)
      )
    `);

    await expect(migrate(db)).resolves.toBeUndefined();

    const columns = (await db.execute("pragma table_info(top_play_events)")).rows.map((row) => String(row.name));
    expect(columns).toEqual(expect.arrayContaining(["score_time", "score_beatmap_id", "key_count"]));
    const indexes = (await db.execute(
      "select name from sqlite_master where type = 'index' and tbl_name = 'top_play_events'",
    )).rows.map((row) => String(row.name));
    expect(indexes).toContain("idx_top_play_events_country_score_time");
    // And it stays fixed: the next boot is a clean no-op.
    await expect(migrate(db)).resolves.toBeUndefined();
  });

  it("carries execBatch's migration writes on the migration budget, without .batch()", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);
    await migrate(db);
    // migrateUserVariantPp is the one migration helper that writes through
    // execBatch, and its live_meta sentinel makes it a no-op after the first
    // run — so re-arm it and give it a row to back-fill.
    await db.execute("delete from live_meta where key = 'farm_helper_variant_pp_backfill:v1'");
    await db.execute(
      `insert into users (user_id, username, avatar_url, country_code, pp, updated_at, profile_json)
       values (1, 'alpha', 'https://example.invalid/a.png', 'CR', 100, '2026-01-01', '{"statistics":{"variants":[{"mode":"mania","variant":"4k","pp":900},{"mode":"mania","variant":"7k","pp":800}]}}')`,
    );

    let batchCalls = 0;
    const watched = new Proxy(db, {
      get(_target, prop) {
        if (prop === "batch") {
          return (...args: unknown[]) => {
            batchCalls += 1;
            return (db as unknown as { batch: (...a: unknown[]) => Promise<unknown> }).batch(...args);
          };
        }
        const value = (db as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(db) : value;
      },
    }) as Db;

    // Held for longer than the generic durable budget (SQLITE_BUSY_RETRY_MS =
    // 300ms, set at the top of this file). If execBatch still retried in place on
    // the generic budget, this write would either fail outright or — worse —
    // "succeed" on a connection whose writes never commit.
    const holder = await holdWriteLock(url);
    const migration = migrate(watched, { totalBusyBudgetMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await holder.release();
    await expect(migration).resolves.toBeUndefined();

    // .batch() is unusable mid-migration: one that loses the race leaves the
    // libsql connection with a leaked transaction, after which further batches
    // fail forever and single statements report success without ever committing.
    expect(batchCalls).toBe(0);
    // Durability checked on a connection that did not run the migration, which
    // is the only way to tell a real commit from a write stranded in a leaked
    // transaction (the migrating connection would happily read its own).
    const reader = await openDb(url);
    expect(Number((await reader.execute("select pp_4k from users where user_id = 1")).rows[0]?.pp_4k)).toBe(900);
  });

  it("publishes migration start/finish so other processes can wait it out", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);
    const { readSchemaMigrationState } = await import("../src/db.js");

    // Nobody has migrated: indistinguishable from "nobody is migrating".
    expect(await readSchemaMigrationState(db)).toBeNull();

    // An array, not a `let`: the write happens inside the proxy's closure, which
    // control-flow narrowing does not see, so a `let x = null` would still be
    // typed `null` at the assertions below.
    const inFlight: Array<Awaited<ReturnType<typeof readSchemaMigrationState>>> = [];
    let probed = false;
    const probing = new Proxy(db, {
      get(_target, prop) {
        if (prop === "execute") {
          return async (...args: unknown[]) => {
            const result = await (db as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute(...args);
            // Probe from the middle of the run, the way a serving process polls
            // while the worker is still working.
            if (!probed && sqlOf(args).includes("create index if not exists idx_map_search_key_stars")) {
              probed = true;
              inFlight.push(await readSchemaMigrationState(db));
            }
            return result;
          };
        }
        const value = (db as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(db) : value;
      },
    }) as Db;

    await migrate(probing);
    expect(probed).toBe(true);
    expect(inFlight[0]?.startedAt).toBeTruthy();
    expect(inFlight[0]?.completedAt).toBeNull();

    const done = await readSchemaMigrationState(db);
    expect(done?.completedAt).toBeTruthy();
    expect(Date.parse(String(done?.completedAt))).toBeGreaterThanOrEqual(Date.parse(String(done?.startedAt)));

    // What the serving process's board warm-up keys off (http/snapshots.ts):
    // "in flight" is observable, and a database nobody has migrated reads the
    // same as a quiet one, so a missing marker never blocks the warm-up.
    const quiet = (state: { completedAt: string | null } | null) => !state || Boolean(state.completedAt);
    expect(quiet(inFlight[0] ?? null)).toBe(false);
    expect(quiet(done)).toBe(true);
    expect(quiet(null)).toBe(true);
  });

  it("still heals legacy rows on the boot that records the marker", async () => {
    const url = await tempDbUrl();
    const db = await openDb(url);
    // The pre-raw_bytes shape of the table, with a row exactly as that version
    // wrote them: inline text content, no size, no last-used stamp.
    await db.execute(`
      create table beatmap_osu_files (
        beatmap_id integer primary key,
        compression text not null default 'gzip',
        content text not null default '',
        fetched_at text not null,
        last_used_at text
      )
    `);
    await db.execute(
      "insert into beatmap_osu_files (beatmap_id, compression, content, fetched_at) values (1, 'none', 'osu file body', '2026-01-01T00:00:00.000Z')",
    );

    await migrate(db);

    const row = (await db.execute("select raw_bytes, last_used_at from beatmap_osu_files where beatmap_id = 1")).rows[0];
    expect(Number(row?.raw_bytes)).toBe("osu file body".length);
    expect(String(row?.last_used_at)).toBe("2026-01-01T00:00:00.000Z");
    // Marker written only after both heals succeeded, so a crash in between
    // re-runs them rather than stranding half the table.
    expect((await db.execute("select 1 from live_meta where key = 'beatmap_osu_files_legacy_heal:v1'")).rows).toHaveLength(1);
  });
});

// Requirement the incident exposed from the other side: while the worker
// migrates, the server-role process is polling for the schema. If its poll can
// expire before migrate()'s contention budget does, a worker that is
// legitimately waiting out a deploy turns a worker stall into a full outage.
describe("schema-wait / migration budget coherence", () => {
  it("lets the server outwait a worker that is spending its whole busy budget", async () => {
    const { SCHEMA_WAIT_TIMEOUT_MS } = await import("../src/server.js");
    const { SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS } = await import("../src/db.js");
    // Contention budget plus room for the uncontended part of a fresh-database
    // migration; 60s is the floor that must survive any future retuning.
    expect(SCHEMA_WAIT_TIMEOUT_MS).toBeGreaterThan(SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS + 60_000);
  });
});

function sqlOf(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "sql" in first) return String((first as { sql: unknown }).sql);
  return "";
}
