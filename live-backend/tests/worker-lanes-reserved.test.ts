import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { JobQueue, type Job } from "../src/jobs/queue.js";
import { prioritizePendingRecentRepairs, RECENT_RECONCILE_REPAIR_PRIORITY } from "../src/jobs/recent-reconcile.js";
import { defaultWorkerLanes, WorkerRunner } from "../src/workers.js";

type Db = Awaited<ReturnType<typeof createDb>>;
type WorkerLane = ReturnType<typeof defaultWorkerLanes>[number];

async function withDb(run: (db: Db, queue: JobQueue) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-lanes-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db, new JobQueue(db));
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function enqueueRoster(queue: JobQueue, country: string, priority: number): Promise<void> {
  await queue.enqueue("refresh_country_roster", `roster:${country}`, { country }, { priority });
}

describe("worker lanes for reserved types", () => {
  const lanes = defaultWorkerLanes();
  const laneNames = (type: string) => lanes.filter((lane) => lane.jobTypes?.includes(type)).map((lane) => lane.name);

  // Both guarantees at once: a dedicated lane so scheduled work always drains,
  // and a fast-lane seat so an admitted urgent job runs immediately.
  it("gives rosters and reconciles a dedicated lane while keeping them in fast", () => {
    expect(laneNames("refresh_country_roster")).toEqual(["fast", "country-rosters"]);
    expect(laneNames("reconcile_user_recent_scores")).toEqual(["fast", "recent-reconcile"]);
    expect(laneNames("refresh_profile_snapshot")).toEqual(["fast", "profile-snapshots"]);
  });

  it("drains deferred snapshots under sustained shared pressure and fast traffic", async () => {
    await withDb(async (db, queue) => {
      const now = new Date().toISOString();
      for (let i = 0; i < 110; i++) {
        await exec(db, `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at)
          values ('compute_player_skills', ?, 'queued', 100, ?, 0, '{}', ?, ?)`, [`skills:${i}`, now, now, now]);
      }
      for (let i = 0; i < 15; i++) {
        await queue.enqueue("refresh_profile_snapshot", `snapshot:${i}`, { userId: i }, { priority: 80 });
        await queue.enqueue("refresh_profile_user", `profile:${i}`, { userId: i }, { priority: 120 });
        await queue.enqueue("reconcile_user_recent_scores", `repair:${i}`, { userId: i }, { priority: 150 });
      }
      expect(await queue.depth()).toBe(110);
      expect(Number((await exec(db, "select count(*) as n from jobs where type = 'refresh_profile_snapshot' and status = 'deferred_pressure'")).rows[0].n)).toBe(5);
      const lane = lanes.find((entry) => entry.name === "profile-snapshots")!;
      const completed: string[] = [];
      for (let turn = 0; turn < 20; turn++) {
        const jobs = await queue.claim("snapshots-worker", lane.claimLimit, { types: lane.jobTypes });
        for (const job of jobs) {
          expect(job.type).toBe("refresh_profile_snapshot");
          completed.push(job.dedupeKey);
          await queue.complete(job.id);
        }
      }
      expect(new Set(completed).size).toBe(15);
      expect(await queue.depth()).toBe(110);
    });
  });

  it("serves both old chart sweeps while fresh high-priority analyses keep arriving", async () => {
    await withDb(async (db, queue) => {
      const now = Date.now();
      const types = ["analyze_beatmap_chart", "recompute_leoblack_fusion_sweep", "recompute_vibro_sweep"];
      await queue.enqueue(types[1], "fusion", {}, { priority: -10, runAfter: new Date(now - 120_000) });
      await queue.enqueue(types[2], "vibro", {}, { priority: -10, runAfter: new Date(now - 110_000) });
      await queue.enqueue(types[1], "leased", {}, { priority: -10, runAfter: new Date(now - 180_000) });
      await exec(db, "update jobs set status = 'running', locked_by = 'other', locked_until = ? where dedupe_key = 'leased'", [new Date(now + 600_000).toISOString()]);
      await queue.enqueue(types[1], "retry", {}, { priority: 200, runAfter: new Date(now + 600_000) });
      await exec(db, "update jobs set status = 'failed' where dedupe_key = 'retry'");
      const claimed: string[] = [];
      for (let turn = 0; turn < 10; turn++) {
        await queue.enqueue(types[0], `fresh:${turn}`, {}, { priority: 4 });
        const jobs = await queue.claim("chart-worker", 1, { types });
        expect(jobs).toHaveLength(1);
        claimed.push(jobs[0].dedupeKey);
        await queue.complete(jobs[0].id);
      }
      expect(claimed.slice(0, 4).every((key) => key.startsWith("fresh:"))).toBe(true);
      expect(claimed[4]).toBe("fusion");
      expect(claimed[9]).toBe("vibro");
      expect(claimed).not.toContain("leased");
      expect(claimed).not.toContain("retry");
    });
  });

  it("claims a roster even while higher-priority fast work floods the queue", async () => {
    await withDb(async (_db, queue) => {
      await enqueueRoster(queue, "LI", 10);
      for (let i = 0; i < 20; i += 1) {
        await queue.enqueue("refresh_profile_user", `profile:${i}`, { userId: i }, { priority: 120 });
      }
      const fast = lanes.find((lane) => lane.name === "fast")!;
      expect((await queue.claim("fast-worker", fast.claimLimit, { types: fast.jobTypes })).every((job) => job.type === "refresh_profile_user")).toBe(true);

      const rosterLane = lanes.find((lane) => lane.name === "country-rosters")!;
      const claimed = await queue.claim("roster-worker", rosterLane.claimLimit, { types: rosterLane.jobTypes });
      expect(claimed.map((job) => job.dedupeKey)).toEqual(["roster:LI"]);
    });
  });

  it("preserves parked jobs and retry deadlines while upgrading existing required repairs", async () => {
    await withDb(async (db, queue) => {
      const future = new Date(Date.now() + 600_000);
      const entries = [
        ["recent:user:1", { userId: 1 }],
        ["recent:user:2:next:1", { userId: 2, kind: "gap_repair" }],
        ["recent:user:3:next:1", { userId: 3 }],
        ["recent:user:4:next:1", { userId: 4, kind: "follow_up" }],
        ["recent:user:5", { userId: 5, kind: "gap_repair" }],
      ] as const;
      for (const [key, payload] of entries) {
        await queue.enqueue("reconcile_user_recent_scores", key, payload, { priority: 25, runAfter: future });
      }
      await exec(db, "update jobs set status = 'deferred_pressure', attempts = 2, last_error = 'retry me'");
      await exec(db, `update jobs set status = 'running', locked_by = 'old-worker', locked_until = ?,
        run_after = '2026-01-01T00:00:00.000Z' where dedupe_key = 'recent:user:5'`, [future.toISOString()]);
      const before = (await exec(db, "select * from jobs order by id")).rows;
      expect(await prioritizePendingRecentRepairs(db)).toBe(3);
      expect(await prioritizePendingRecentRepairs(db)).toBe(0);
      const after = (await exec(db, "select * from jobs order by id")).rows;
      expect(after).toEqual(before.map((row, i) => ({
        ...row, priority: i < 2 || i === 4 ? RECENT_RECONCILE_REPAIR_PRIORITY : row.priority,
      })));
      expect(await queue.claim("worker", 10, { types: ["reconcile_user_recent_scores"] })).toEqual([]);
      await exec(db, "update jobs set locked_until = '2026-01-01T00:00:00.000Z' where dedupe_key = 'recent:user:5'");
      const resumed = await queue.claim("worker", 1, { types: ["reconcile_user_recent_scores"] });
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ dedupeKey: "recent:user:5", priority: 150 });
      expect(Number((await exec(db, "select attempts from jobs where dedupe_key = 'recent:user:5'")).rows[0].attempts)).toBe(3);
    });
  });

  it("reserves fast capacity for oldest repairs without starving profile work", async () => {
    await withDb(async (db, queue) => {
      for (let i = 0; i < 10; i++) {
        await queue.enqueue("refresh_profile_user", `profile:${i}`, { userId: i }, { priority: 120 });
        await queue.enqueue("reconcile_user_recent_scores", `recent:user:${i + 1}`, { userId: i + 1, kind: "gap_repair" }, {
          priority: 70, runAfter: new Date(Date.now() - (10 - i) * 60_000),
        });
      }
      await prioritizePendingRecentRepairs(db);
      const runner = new WorkerRunner(db, queue, {} as never, {} as never, {} as never);
      const fast = lanes.find((lane) => lane.name === "fast")!;
      const claim = (runner as unknown as {
        claimFastJobs(workerId: string, lane: WorkerLane): Promise<Job[]>;
      }).claimFastJobs.bind(runner);
      const jobs = await claim("fast-worker", fast);
      expect(jobs.map((job) => job.type)).toEqual([
        "reconcile_user_recent_scores", "refresh_profile_user", "refresh_profile_user",
      ]);
      expect(jobs[0].dedupeKey).toBe("recent:user:1");
      const dedicated = lanes.find((lane) => lane.name === "recent-reconcile")!;
      const repairs = await queue.claim("recent-worker", dedicated.claimLimit, { types: dedicated.jobTypes });
      expect(repairs.map((job) => job.dedupeKey)).toEqual(["recent:user:2", "recent:user:3", "recent:user:4", "recent:user:5"]);
    });
  });
});
