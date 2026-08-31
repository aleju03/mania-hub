import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";

type Db = Awaited<ReturnType<typeof createDb>>;

async function withDb(run: (db: Db, queue: JobQueue) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-reserve-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db, new JobQueue(db));
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function statusOf(db: Db, dedupeKey: string): Promise<string> {
  const row = (await exec(db, "select status from jobs where dedupe_key = ?", [dedupeKey])).rows[0];
  return String(row?.status ?? "missing");
}

// refresh_country_roster reserves two slots. Its scheduled sweep enqueues at
// priority 10 and a country activation at 85.
async function enqueueRoster(queue: JobQueue, country: string, priority: number): Promise<void> {
  await queue.enqueue("refresh_country_roster", `roster:${country}`, { country }, { priority });
}

async function runnableCount(db: Db, type: string): Promise<number> {
  const row = (await exec(
    db,
    "select count(*) as count from jobs where type = ? and (status = 'running' or (status in ('queued', 'failed') and run_after <= ?))",
    [type, new Date().toISOString()],
  )).rows[0];
  return Number(row?.count ?? 0);
}

describe("reserved-lane admission", () => {
  // The BA incident: two scheduled rosters held the reserve for days, so the
  // activation of a country someone was actually looking at parked behind them.
  it("lets a higher-priority arrival displace a lower-priority waiter", async () => {
    await withDb(async (db, queue) => {
      await enqueueRoster(queue, "LI", 10);
      await enqueueRoster(queue, "MQ", 10);
      expect(await statusOf(db, "roster:LI")).toBe("queued");
      expect(await statusOf(db, "roster:MQ")).toBe("queued");

      await enqueueRoster(queue, "BA", 85);
      expect(await statusOf(db, "roster:BA")).toBe("queued");
      // The newest waiter is the one that yields its slot, not the oldest.
      expect(await statusOf(db, "roster:MQ")).toBe("deferred_pressure");
      expect(await statusOf(db, "roster:LI")).toBe("queued");
      expect(await runnableCount(db, "refresh_country_roster")).toBe(2);
    });
  });

  it("never lets displacement push the lane past its reserve", async () => {
    await withDb(async (db, queue) => {
      for (const country of ["LI", "MQ", "AD", "SM", "MC"]) await enqueueRoster(queue, country, 10);
      for (const country of ["BA", "RS", "HR"]) await enqueueRoster(queue, country, 85);
      expect(await runnableCount(db, "refresh_country_roster")).toBe(2);
      const runnable = (await exec(
        db,
        "select dedupe_key from jobs where type = 'refresh_country_roster' and status = 'queued' and run_after <= ? order by dedupe_key",
        [new Date().toISOString()],
      )).rows.map((row) => String(row.dedupe_key));
      // The first two activations each took a scheduled slot; the third had
      // nothing left to outrank and waits its turn.
      expect(runnable).toEqual(["roster:BA", "roster:RS"]);
      expect(await statusOf(db, "roster:HR")).toBe("deferred_pressure");
    });
  });

  it("leaves equal-priority arrivals deferred so a sweep does not churn the reserve", async () => {
    await withDb(async (db, queue) => {
      await enqueueRoster(queue, "LI", 10);
      await enqueueRoster(queue, "MQ", 10);
      await enqueueRoster(queue, "AD", 10);
      expect(await statusOf(db, "roster:AD")).toBe("deferred_pressure");
      expect(await statusOf(db, "roster:LI")).toBe("queued");
      expect(await statusOf(db, "roster:MQ")).toBe("queued");
    });
  });

  it("does not displace a running job", async () => {
    await withDb(async (db, queue) => {
      await enqueueRoster(queue, "LI", 10);
      await enqueueRoster(queue, "MQ", 10);
      const claimed = await queue.claim("worker-1", 2, { types: ["refresh_country_roster"] });
      expect(claimed.length).toBe(2);

      await enqueueRoster(queue, "BA", 85);
      expect(await statusOf(db, "roster:LI")).toBe("running");
      expect(await statusOf(db, "roster:MQ")).toBe("running");
      expect(await statusOf(db, "roster:BA")).toBe("deferred_pressure");
    });
  });

  // A re-request of an already-queued job is the same unit of work, so it must
  // not park a neighbour to make room for a slot it already holds.
  it("does not evict a neighbour when re-enqueued at a higher priority", async () => {
    await withDb(async (db, queue) => {
      await enqueueRoster(queue, "LI", 10);
      await enqueueRoster(queue, "BA", 10);
      await enqueueRoster(queue, "BA", 85);
      expect(await statusOf(db, "roster:BA")).toBe("queued");
      expect(await statusOf(db, "roster:LI")).toBe("queued");
      expect(await runnableCount(db, "refresh_country_roster")).toBe(2);
    });
  });

  // Once the lane runs dry the reserve refills highest-priority-first, so a
  // displaced job comes back ahead of the scheduled backlog rather than behind
  // it. seed_snipe_board reserves a single slot, which makes the refill pick
  // exactly one job.
  it("reactivates the highest-priority parked job when a slot frees", async () => {
    await withDb(async (db, queue) => {
      const seed = (key: string, priority: number) => queue.enqueue("seed_snipe_board", key, { key }, { priority });
      await seed("snipe:a", 40);
      await seed("snipe:b", 10);
      await seed("snipe:c", 80);
      expect(await statusOf(db, "snipe:c")).toBe("queued");
      expect(await statusOf(db, "snipe:a")).toBe("deferred_pressure");
      expect(await statusOf(db, "snipe:b")).toBe("deferred_pressure");

      const claimed = await queue.claim("worker-1", 1, { types: ["seed_snipe_board"] });
      expect(claimed[0]?.dedupeKey).toBe("snipe:c");
      await queue.complete(claimed[0]!.id);

      // Nothing runnable left, so this claim refills the reserve instead.
      expect(await queue.claim("worker-1", 1, { types: ["seed_snipe_board"] })).toEqual([]);
      expect(await statusOf(db, "snipe:a")).toBe("queued");
      expect(await statusOf(db, "snipe:b")).toBe("deferred_pressure");
    });
  });
});
