import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, createRuntimeDb, exec, execBatch, getSqliteBusyRetryStats } from "../src/db.js";

describe("runtime SQLite contention", () => {
  it.each(["statement", "batch"])("yields during a contended %s and commits durably after the lock is released", async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "mania-runtime-lock-"));
    const config = { databaseUrl: `file:${join(dir, "test.db")}`, sqliteBusyTimeoutMs: 2_000 };
    const runtime = await createRuntimeDb(config);
    const holder = await createDb(config);
    let releaseTimer: NodeJS.Timeout | undefined;
    const timerTimes: number[] = [];
    const heartbeat = setInterval(() => timerTimes.push(performance.now()), 5);
    try {
      await exec(holder, "create table t (id integer primary key)");
      await holder.execute("begin immediate");
      const before = getSqliteBusyRetryStats();
      const started = performance.now();
      const released = new Promise<void>((resolve, reject) => {
        releaseTimer = setTimeout(() => { void holder.execute("rollback").then(() => resolve(), reject); }, 150);
      });
      const write = kind === "batch"
        ? execBatch(runtime, [{ sql: "insert into t values (1)" }, { sql: "insert into t values (2)" }])
        : exec(runtime, "insert into t values (1)");
      // With the old 2s timeout this timer cannot run until the write attempt
      // releases the event loop. Assert the first tick, not total job latency.
      await Promise.all([write, released]);
      expect(timerTimes.length).toBeGreaterThan(1);
      expect(timerTimes[0] - started).toBeLessThan(500);
      expect((await holder.execute("select * from t")).rows).toHaveLength(kind === "batch" ? 2 : 1);
      expect(Number((await runtime.execute("pragma busy_timeout")).rows[0].timeout)).toBe(0);
      if (kind === "batch") {
        // Recovery must preserve the runtime timeout on the reopened handle.
        expect(getSqliteBusyRetryStats().batchBusyReconnects).toBeGreaterThan(before.batchBusyReconnects);
      }
      await holder.execute("begin immediate");
      await holder.execute("rollback");
    } finally {
      clearInterval(heartbeat);
      clearTimeout(releaseTimer);
      runtime.close();
      holder.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
