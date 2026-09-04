import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_LEASE_MS, JobQueue } from "../src/jobs/queue.js";
import { JobLeaseLostError, maintainJobLease } from "../src/jobs/lease.js";

afterEach(() => { vi.useRealTimers(); });

async function setup() {
  const db = createClient({ url: ":memory:" });
  const schema = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  await db.execute(schema.match(/create table if not exists jobs \([\s\S]*?\);/)![0]);
  return { db, queue: new JobQueue(db) };
}

describe("job leases", () => {
  it("renews a long-running job and permits recovery when renewals stop", async () => {
    const { db, queue } = await setup();
    vi.useFakeTimers();
    try {
      await queue.enqueue("enrich_user", "user:1", { userId: 1 });
      const [job] = await queue.claim("fast", 1);
      const controller = new AbortController();
      const guard = maintainJobLease(queue, job.id, { workerId: "fast", attempt: 1 }, controller);
      await vi.advanceTimersByTimeAsync(3 * JOB_LEASE_MS);
      expect(await queue.claim("enrich", 1)).toEqual([]);
      expect(controller.signal.aborted).toBe(false);
      guard.stop();
      await vi.advanceTimersByTimeAsync(JOB_LEASE_MS + 1);
      expect((await queue.claim("enrich", 1))[0].id).toBe(job.id);
    } finally { db.close(); }
  });

  it("fences completion, failure, deferral and renewal from an obsolete attempt", async () => {
    const { db, queue } = await setup();
    vi.useFakeTimers();
    try {
      await queue.enqueue("enrich_user", "user:1", { userId: 1 });
      const [job] = await queue.claim("same-lane", 1);
      const stale = { workerId: "same-lane", attempt: 1 };
      await vi.advanceTimersByTimeAsync(JOB_LEASE_MS + 1);
      await queue.claim("same-lane", 1);
      expect(await queue.renewLease(job.id, stale)).toBe(false);
      expect(await queue.complete(job.id, stale)).toBe(false);
      expect(await queue.fail(job.id, new Error("late failure"), 0, stale)).toBe(false);
      expect(await queue.defer(job.id, 0, stale)).toBe(false);
      expect((await db.execute("select status, attempts from jobs")).rows[0]).toMatchObject({ status: "running", attempts: 2 });
      expect(await queue.complete(job.id, { workerId: "same-lane", attempt: 2 })).toBe(true);
    } finally { db.close(); }
  });

  it("retries transient renewal errors but aborts if the lease can no longer be confirmed", async () => {
    vi.useFakeTimers();
    const renewLease = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(true);
    const controller = new AbortController();
    const guard = maintainJobLease({ renewLease }, 1, { workerId: "fast", attempt: 1 }, controller);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(renewLease).toHaveBeenCalledTimes(2);
    expect(controller.signal.aborted).toBe(false);
    renewLease.mockRejectedValue(new Error("busy"));
    await vi.advanceTimersByTimeAsync(JOB_LEASE_MS);
    await expect(guard.lost).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(controller.signal.aborted).toBe(true);
    guard.stop();
  });

  it("aborts promptly on ownership loss and does not schedule more renewals", async () => {
    vi.useFakeTimers();
    const renewLease = vi.fn().mockResolvedValue(false);
    const controller = new AbortController();
    const guard = maintainJobLease({ renewLease }, 1, { workerId: "fast", attempt: 1 }, controller);
    await vi.advanceTimersByTimeAsync(JOB_LEASE_MS);
    await expect(guard.lost).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts at the confirmed deadline when the renewal promise never settles", async () => {
    vi.useFakeTimers();
    const renewLease = vi.fn(() => new Promise<boolean>(() => {}));
    const controller = new AbortController();
    const guard = maintainJobLease({ renewLease }, 1, { workerId: "fast", attempt: 1 }, controller);
    await vi.advanceTimersByTimeAsync(JOB_LEASE_MS - 1);
    expect(controller.signal.aborted).toBe(false);
    expect(renewLease).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(guard.lost).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(controller.signal.aborted).toBe(true);
    guard.stop();
  });

  it("does not issue write statements for an empty lane, but revives a newly deferred job", async () => {
    const { db, queue } = await setup();
    try {
      const execute = vi.spyOn(db, "execute");
      expect(await queue.claim("fast", 3, { types: ["enrich_user", "refresh_country_roster", "refresh_user_top_scores", "reconcile_user_recent_scores"] })).toEqual([]);
      const writes = execute.mock.calls.filter(([statement]) => /^\s*(?:update|insert|delete)/i.test(typeof statement === "string" ? statement : (statement as unknown as { sql: string }).sql));
      expect(writes).toHaveLength(0);
      await queue.enqueue("enrich_user", "user:1", { userId: 1 });
      await db.execute("update jobs set status = 'deferred_pressure'");
      await queue.claim("fast", 1, { types: ["enrich_user"] });
      expect((await queue.claim("fast", 1, { types: ["enrich_user"] }))[0].dedupeKey).toBe("user:1");
    } finally { db.close(); }
  });
});
