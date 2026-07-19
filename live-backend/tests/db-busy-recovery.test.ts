import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must land before db.js is imported: the busy-retry budget is read at module
// load. Keep it short so the exhaustion paths run in test time, not 15s.
process.env.SQLITE_BUSY_RETRY_MS = "300";
const { createDb, exec, getSqliteBusyRetryStats } = await import("../src/db.js");

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
});
