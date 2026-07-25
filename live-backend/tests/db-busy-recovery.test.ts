import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must land before db.js is imported: the busy-retry budgets are read at module
// load. Keep them short so the exhaustion paths run in test time, not 15s, and
// keep the best-effort budget well under the durable one so the two are visibly
// distinct in the fail-fast test below.
process.env.SQLITE_BUSY_RETRY_MS = "300";
process.env.SQLITE_BEST_EFFORT_WRITE_BUDGET_MS = "60";
const { createDb, exec, execBatch, getSqliteBusyRetryStats } = await import("../src/db.js");

describe("sqlite busy-exhaustion wedged-connection recovery", () => {
  it("reopens a connection pinned to a stale snapshot and retries the write (the 2026-07-18/19 server freeze)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-busy-"));
    try {
      const url = `file:${join(dir, "test.db")}`;
      const a = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      const b = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      await a.execute("pragma journal_mode = wal");
      await exec(a, "create table t (id integer primary key, v text)");
      await exec(a, "insert into t (id, v) values (1, 'x')");

      // Wedge connection A the way prod wedged: an open deferred transaction
      // materializes a read snapshot, then another connection advances the
      // WAL. Every write on A now fails SQLITE_BUSY instantly and no SQL can
      // un-pin it — only reopening the connection recovers.
      await a.execute("begin deferred");
      await a.execute("select * from t");
      await exec(b, "insert into t (id, v) values (2, 'y')");

      const before = getSqliteBusyRetryStats();
      await exec(a, "insert into t (id, v) values (3, 'z')");
      const after = getSqliteBusyRetryStats();
      expect(after.leakedTxnRollbacks).toBe(before.leakedTxnRollbacks + 1);
      expect(after.reconnects).toBe(before.reconnects + 1);
      const rows = (await exec(b, "select count(*) as cnt from t")).rows;
      expect(Number(rows[0]?.cnt)).toBe(3);
      // The reopened connection reads fresh data, not the pinned snapshot.
      const fresh = (await exec(a, "select count(*) as cnt from t")).rows;
      expect(Number(fresh[0]?.cnt)).toBe(3);
      a.close();
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still throws on plain lock contention when the holder never releases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-busy-"));
    try {
      const url = `file:${join(dir, "test.db")}`;
      const a = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      const b = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      await a.execute("pragma journal_mode = wal");
      await exec(a, "create table t (id integer primary key)");

      // B holds the write lock for real; A's write exhausts the retry budget,
      // reconnects once (harmless), exhausts again, and surfaces SQLITE_BUSY.
      await b.execute("begin immediate");
      await expect(exec(a, "insert into t (id) values (1)")).rejects.toThrow(/SQLITE_BUSY|database is locked/i);
      await b.execute("rollback");
      await exec(a, "insert into t (id) values (2)");
      a.close();
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("best-effort writes give up fast without reconnecting when the writer is held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-besteffort-"));
    try {
      const url = `file:${join(dir, "test.db")}`;
      const a = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      const b = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      await a.execute("pragma journal_mode = wal");
      await exec(a, "create table t (id integer primary key)");

      // B holds the write lock. A durable write would burn the 300ms budget and
      // reconnect; a best-effort write must instead skip within its 60ms budget.
      await b.execute("begin immediate");
      const before = getSqliteBusyRetryStats();
      const startedAt = Date.now();
      await expect(exec(a, "insert into t (id) values (1)", [], { bestEffort: true }))
        .rejects.toThrow(/SQLITE_BUSY|database is locked/i);
      const elapsedMs = Date.now() - startedAt;
      const after = getSqliteBusyRetryStats();

      // Gave up inside the short best-effort budget, well under the durable 300ms.
      expect(elapsedMs).toBeLessThan(250);
      // Recorded as a skip, and left the wedge stats untouched (no reconnect, no
      // durable exhaustion, no counted operation) so it never masks a real wedge.
      expect(after.bestEffortWriteSkips).toBe(before.bestEffortWriteSkips + 1);
      expect(after.reconnects).toBe(before.reconnects);
      expect(after.exhausted).toBe(before.exhausted);
      expect(after.operations).toBe(before.operations);

      // Once the lock frees, best-effort writes succeed normally.
      await b.execute("rollback");
      await exec(a, "insert into t (id) values (2)", [], { bestEffort: true });
      expect(Number((await exec(a, "select count(*) as cnt from t")).rows[0]?.cnt)).toBe(1);
      a.close();
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reopens a poisoned batch connection before retrying (the 2026-07-25 write-lock stall)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-batchbusy-"));
    try {
      const url = `file:${join(dir, "test.db")}`;
      const a = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      const b = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      await a.execute("pragma journal_mode = wal");
      await exec(a, "create table t (id integer primary key, v text)");

      // B holds the write lock while A's batch first fires, then releases —
      // the retention/checkpoint collision that poisoned prod. On 0.17.3 the
      // failed batch leaves A inside an invisible open transaction: without
      // the reopen-before-retry, A's later writes report success but never
      // commit (and hold the DB-wide write lock), and batch retries fail
      // forever with "cannot commit transaction - SQL statements in progress".
      await b.execute("begin immediate");
      const releaseLock = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        await b.execute("rollback");
      })();

      const before = getSqliteBusyRetryStats();
      const batchDone = execBatch(a, [
        { sql: "insert into t (id, v) values (1, 'a')" },
        { sql: "insert into t (id, v) values (2, 'b')" },
      ]);
      // Interleave a plain write on A while the batch is between retries: on a
      // poisoned connection it would phantom-succeed and vanish; on the
      // reopened connection it must end up durable.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const interleaved = exec(a, "insert into t (id, v) values (3, 'c')");
      await Promise.all([batchDone, interleaved, releaseLock]);

      const after = getSqliteBusyRetryStats();
      expect(after.batchBusyReconnects).toBeGreaterThan(before.batchBusyReconnects);

      // Every write is durable as seen from the OTHER connection — the
      // phantom-write regression guard.
      const rows = (await b.execute("select count(*) as cnt from t")).rows;
      expect(Number(rows[0]?.cnt)).toBe(3);
      // And A leaked no transaction: B can take the write lock immediately.
      await b.execute("begin immediate");
      await b.execute("rollback");
      a.close();
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a batch that never wins the lock fails within budget and leaves no leaked lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-batchbusy-"));
    try {
      const url = `file:${join(dir, "test.db")}`;
      const a = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      const b = await createDb({ databaseUrl: url, sqliteBusyTimeoutMs: 10 });
      await a.execute("pragma journal_mode = wal");
      await exec(a, "create table t (id integer primary key)");

      await b.execute("begin immediate");
      await expect(execBatch(a, [{ sql: "insert into t (id) values (1)" }]))
        .rejects.toThrow(/SQLITE_BUSY|database is locked/i);
      await b.execute("rollback");

      // The failure left A on a fresh connection with nothing leaked. The
      // plain write goes FIRST: on a still-poisoned handle it would silently
      // join the leaked transaction and vanish, so its durability (checked
      // from B below) is the guard for the exhaustion path's reopen.
      await exec(a, "insert into t (id) values (3)");
      await execBatch(a, [{ sql: "insert into t (id) values (2)" }]);
      const rows = (await b.execute("select count(*) as cnt from t")).rows;
      expect(Number(rows[0]?.cnt)).toBe(2);
      a.close();
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
