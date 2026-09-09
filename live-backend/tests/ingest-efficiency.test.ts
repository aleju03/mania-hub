import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec, migrate } from "../src/db.js";
import { ScoreIngestor } from "../src/ingest/score-ingestor.js";
import { JobQueue } from "../src/jobs/queue.js";
import { nextRecentReconcileCadence, promotePendingRecentReconcileJobs, reserveRecentReconcileRequest, type RecentReconcilePayload } from "../src/jobs/recent-reconcile.js";
import { LiveEventLog } from "../src/live/event-log.js";
import type { OscScore } from "../src/shared/types.js";
import { WorkerRunner } from "../src/workers.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  const db = createClient({ url: ":memory:" });
  await migrate(db);
  const queue = new JobQueue(db);
  const events = new LiveEventLog(db);
  const ingestor = new ScoreIngestor(db, queue, events, {
    trackedCountries: ["CR"], countryWarmTtlMs: 86_400_000,
    topPlayMarginPp: 5, osuClientId: "", osuClientSecret: "",
  });
  const scores = JSON.parse(await readFile(new URL("../fixtures/scores.json", import.meta.url), "utf8")) as OscScore[];
  return { db, queue, events, ingestor, score: scores[0] };
}

const options = { processLeaderboardFeatures: false, processGoalFeatures: false, suppressTrackerEvents: true };

describe("ingest metadata efficiency", () => {
  it("leaves metadata timestamps unchanged on duplicate delivery while persisting corrected metadata", async () => {
    const { db, ingestor, score } = await setup();
    try {
      await ingestor.ingestBatch([score], "osu_recent", options);
      for (const table of ["users", "beatmaps", "beatmapsets"]) await exec(db, `update ${table} set updated_at = '2000-01-01T00:00:00.000Z'`);
      expect(await ingestor.ingestBatch([score], "osu_recent", options)).toEqual({ inserted: 0, skipped: 1 });
      for (const table of ["users", "beatmaps", "beatmapsets"]) {
        expect((await exec(db, `select updated_at from ${table}`)).rows[0].updated_at).toBe("2000-01-01T00:00:00.000Z");
      }
      await ingestor.ingestBatch([{
        ...score,
        user: { ...score.user!, username: "Corrected" },
        beatmap: { ...score.beatmap!, status: "loved" },
        beatmapset: { ...score.beatmapset!, title: "Corrected title" },
      }], "osu_recent", options);
      expect((await exec(db, "select username from users")).rows[0].username).toBe("Corrected");
      expect((await exec(db, "select status from beatmaps")).rows[0].status).toBe("loved");
      expect((await exec(db, "select title from beatmapsets")).rows[0].title).toBe("Corrected title");
    } finally { db.close(); }
  });

  it("deduplicates identical metadata within a batch without suppressing a later correction", async () => {
    const { db, ingestor, score } = await setup();
    try {
      const batch = vi.spyOn(db, "batch");
      await ingestor.ingestBatch([score, score, { ...score, beatmap: { ...score.beatmap!, version: "Corrected" } }], "osu_recent", options);
      const mapWrites = batch.mock.calls.flatMap(([statements]) => [...statements]).filter((statement) => {
        const sql = typeof statement === "string" ? statement : (statement as unknown as { sql: string }).sql;
        return sql.startsWith("insert into beatmaps (");
      });
      expect(mapWrites).toHaveLength(2);
      expect((await exec(db, "select version from beatmaps")).rows[0].version).toBe("Corrected");
    } finally { db.close(); }
  });
});

describe("recent-score adaptive polling", () => {
  it("keeps an initial correction follow-up, backs off unchanged windows, and resets on changes", () => {
    expect(nextRecentReconcileCadence(0, false)).toEqual({ unchangedPolls: 1, delayMs: 120_000 });
    expect(nextRecentReconcileCadence(1, false)).toEqual({ unchangedPolls: 2, delayMs: 240_000 });
    expect(nextRecentReconcileCadence(2, false)).toEqual({ unchangedPolls: 3, delayMs: 480_000 });
    expect(nextRecentReconcileCadence(99, false)).toEqual({ unchangedPolls: 3, delayMs: 480_000 });
    expect(nextRecentReconcileCadence(3, true)).toEqual({ unchangedPolls: 0, delayMs: 120_000 });
  });

  it("fresh feed promotion resets backoff without dropping source options", async () => {
    const { db, queue } = await setup();
    try {
      await queue.enqueue("reconcile_user_recent_scores", "recent:user:101:next:1", {
        userId: 101, unchangedPolls: 3, latestScoreAt: "old", source: "osu_recent_fallback", processLeaderboardFeatures: true,
      }, { runAfter: new Date(Date.now() + 480_000) });
      expect(await promotePendingRecentReconcileJobs(db, 101)).toBe(1);
      const row = (await exec(db, "select run_after, payload_json from jobs where dedupe_key = 'recent:user:101:next:1'")).rows[0];
      expect(Date.parse(String(row.run_after))).toBeGreaterThan(Date.now());
      expect(JSON.parse(String(row.payload_json))).toMatchObject({ unchangedPolls: 0, source: "osu_recent_fallback", processLeaderboardFeatures: true });
    } finally { db.close(); }
  });

  it.each([undefined, "follow_up"] as const)("expires stale follow-ups before the API call (kind=%s)", async (kind) => {
    const { db, queue, events, ingestor, score } = await setup();
    try {
      vi.useFakeTimers({ now: new Date("2026-09-04T12:00:00.000Z") });
      await ingestor.ingestBatch([{ ...score, ended_at: "2026-09-04T11:29:59.000Z" }], "osu_recent", options);
      await queue.enqueue("reconcile_user_recent_scores", `recent:user:${score.user_id}:next:1`, { userId: score.user_id, kind });
      const osu = { getUserRecentScores: vi.fn().mockResolvedValue([]) };
      await new WorkerRunner(db, queue, events, osu as never, ingestor).runOnce();
      expect(osu.getUserRecentScores).not.toHaveBeenCalled();
      expect((await exec(db, "select status from jobs where type = 'reconcile_user_recent_scores'")).rows[0].status).toBe("done");
    } finally { db.close(); }
  });

  it.each([undefined, "gap_repair"] as const)("retains delayed initial gap repairs without active rows (kind=%s)", async (kind) => {
    const { db, queue, events, ingestor } = await setup();
    try {
      await queue.enqueue("reconcile_user_recent_scores", "recent:user:101", { userId: 101, kind }, { runAfter: new Date(Date.now() - 86_400_000) });
      const osu = { getUserRecentScores: vi.fn().mockResolvedValue([]) };
      await new WorkerRunner(db, queue, events, osu as never, ingestor).runOnce();
      expect(osu.getUserRecentScores).toHaveBeenCalledTimes(1);
      expect(osu.getUserRecentScores).toHaveBeenCalledWith(101, "job:reconcile_user_recent_scores", { includeFails: false });
      expect((await exec(db, "select status from jobs where type = 'reconcile_user_recent_scores'")).rows[0].status).toBe("done");
    } finally { db.close(); }
  });

  it("serializes competing jobs and keeps the cooldown through fresh feed promotions and runner restarts", async () => {
    const { db, queue, events, ingestor } = await setup();
    try {
      vi.useFakeTimers({ now: new Date("2026-09-04T12:00:00.000Z") });
      for (const key of ["recent:user:101", "recent:user:101:manual"]) {
        await queue.enqueue("reconcile_user_recent_scores", key, { userId: 101 });
      }
      const osu = { getUserRecentScores: vi.fn().mockResolvedValue([]) };
      await new WorkerRunner(db, queue, events, osu as never, ingestor).runOnce();
      expect(osu.getUserRecentScores).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-09-04T12:00:30.000Z"));
      await promotePendingRecentReconcileJobs(db, 101);
      const pending = (await exec(db, "select run_after from jobs where status = 'queued' and type = 'reconcile_user_recent_scores'")).rows;
      expect(pending).toHaveLength(1);
      expect(pending[0].run_after).toBe("2026-09-04T12:02:00.000Z");
      const restarted = new WorkerRunner(db, new JobQueue(db), events, osu as never, ingestor);
      await restarted.runOnce();
      expect(osu.getUserRecentScores).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-09-04T12:02:00.000Z"));
      await restarted.runOnce();
      expect(osu.getUserRecentScores).toHaveBeenCalledTimes(2);
    } finally { db.close(); }
  });

  it("keeps a slow in-flight request exclusive after two minutes and cools down from completion", async () => {
    const { db, queue, events, ingestor } = await setup();
    let resolveRequest!: (scores: OscScore[]) => void;
    let running: Promise<void> | undefined;
    try {
      vi.useFakeTimers({ now: new Date("2026-09-04T12:00:00.000Z") });
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const osu = { getUserRecentScores: vi.fn(() => {
        started();
        return new Promise<OscScore[]>(resolve => { resolveRequest = resolve; });
      }) };
      await queue.enqueue("reconcile_user_recent_scores", "recent:user:101", { userId: 101 });
      running = new WorkerRunner(db, queue, events, osu as never, ingestor).runOnce();
      await startedPromise;
      vi.setSystemTime(new Date("2026-09-04T12:03:00.000Z"));
      // Model the lease renewal of the still-active worker without ticking the watchdog.
      await exec(db, "update jobs set locked_until = '2026-09-04T12:04:00.000Z' where status = 'running'");
      await queue.enqueue("reconcile_user_recent_scores", "recent:user:101:manual", { userId: 101 });
      await new WorkerRunner(db, queue, events, osu as never, ingestor).runOnce();
      expect(osu.getUserRecentScores).toHaveBeenCalledTimes(1);
      resolveRequest([]);
      await running;
      await promotePendingRecentReconcileJobs(db, 101);
      const pending = (await exec(db, "select run_after from jobs where status = 'queued' and type = 'reconcile_user_recent_scores'")).rows[0];
      expect(pending.run_after).toBe("2026-09-04T12:05:00.000Z");
    } finally {
      resolveRequest?.([]);
      await running;
      db.close();
    }
  });

  it("resets a follow-up to gap repair at the cooldown boundary and preserves failed retry delays", async () => {
    const { db, queue, events, ingestor } = await setup();
    try {
      vi.useFakeTimers({ now: new Date("2026-09-04T12:00:00.000Z") });
      expect(await reserveRecentReconcileRequest(db, 101)).toBe(0);
      await queue.enqueue("reconcile_user_recent_scores", "recent:user:101:next:1", { userId: 101, kind: "follow_up", unchangedPolls: 3 }, { runAfter: new Date(Date.now() + 480_000) });
      vi.setSystemTime(new Date("2026-09-04T12:00:30.000Z"));
      await promotePendingRecentReconcileJobs(db, 101);
      let row = (await exec(db, "select * from jobs where type = 'reconcile_user_recent_scores'")).rows[0];
      expect(row.run_after).toBe("2026-09-04T12:02:00.000Z");
      expect(JSON.parse(String(row.payload_json))).toMatchObject({ kind: "gap_repair", unchangedPolls: 0 });
      await exec(db, "update jobs set status = 'failed', run_after = '2026-09-04T12:10:00.000Z' where id = ?", [Number(row.id)]);
      await promotePendingRecentReconcileJobs(db, 101);
      row = (await exec(db, "select * from jobs where id = ?", [Number(row.id)])).rows[0];
      expect(row.run_after).toBe("2026-09-04T12:10:00.000Z");
      // Fresh evidence upgraded even the legacy :next: key to mandatory repair.
      vi.setSystemTime(new Date("2026-09-04T13:00:00.000Z"));
      const osu = { getUserRecentScores: vi.fn().mockResolvedValue([]) };
      await new WorkerRunner(db, queue, events, osu as never, ingestor).runOnce();
      expect(osu.getUserRecentScores).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("preserves two/four/eight-minute appointments through pressure deferral and refill", async () => {
    const { db, queue } = await setup();
    try {
      const start = Date.parse("2026-09-04T12:00:00.000Z");
      vi.useFakeTimers({ now: start });
      for (let id = 1; id <= 10; id++) {
        await queue.enqueue("reconcile_user_recent_scores", `recent:user:${id}`, { userId: id });
      }
      for (const minutes of [2, 4, 8]) {
        await queue.enqueue("reconcile_user_recent_scores", `recent:user:101:next:${minutes}`, { userId: 101, kind: "follow_up" }, { runAfter: new Date(start + minutes * 60_000) });
      }
      const parked = (await exec(db, "select status, run_after from jobs where dedupe_key like 'recent:user:101:next:%' order by run_after")).rows;
      expect(parked.map(row => row.status)).toEqual(Array(3).fill("deferred_pressure"));
      expect(parked.map(row => row.run_after)).toEqual([2, 4, 8].map(minutes => new Date(start + minutes * 60_000).toISOString()));
      const blockers = await queue.claim("test", 10, { types: ["reconcile_user_recent_scores"] });
      for (const job of blockers) await queue.complete(job.id);
      await queue.shedPressure();
      expect(await queue.claim("test", 1, { types: ["reconcile_user_recent_scores"] })).toEqual([]);
      for (const minutes of [2, 4, 8]) {
        vi.setSystemTime(start + minutes * 60_000);
        await queue.shedPressure();
        const claimed = await queue.claim("test", 10, { types: ["reconcile_user_recent_scores"] });
        expect(claimed.map(job => job.dedupeKey)).toEqual([`recent:user:101:next:${minutes}`]);
        expect(claimed[0].runAfter).toBe(new Date(start + minutes * 60_000).toISOString());
        await queue.complete(claimed[0].id);
      }
    } finally { db.close(); }
  });

  it("resets polling on replay corrections and on feed activity missing from the API response", async () => {
    const { db, queue, events, ingestor, score } = await setup();
    try {
      vi.useFakeTimers({ now: new Date("2026-09-04T12:00:00.000Z") });
      const scoreAt = "2026-09-04T11:55:00.000Z";
      const initial = { ...score, ended_at: scoreAt, has_replay: false };
      await ingestor.ingestBatch([initial], "osu_recent", options);
      const osu = { getUserRecentScores: vi.fn().mockResolvedValue([initial]) };
      const worker = new WorkerRunner(db, queue, events, osu as never, ingestor);
      const reconcile = (worker as unknown as { reconcileUserRecentScores: (payload: RecentReconcilePayload) => Promise<void> }).reconcileUserRecentScores.bind(worker);
      const payload = { userId: score.user_id, latestScoreAt: scoreAt, unchangedPolls: 2 };
      await reconcile(payload);
      let next = (await exec(db, "select run_after, payload_json from jobs where type = 'reconcile_user_recent_scores'")).rows[0];
      expect(next.run_after).toBe("2026-09-04T12:08:00.000Z");
      await exec(db, "delete from jobs where type = 'reconcile_user_recent_scores'");
      vi.setSystemTime(new Date("2026-09-04T12:08:00.000Z"));
      osu.getUserRecentScores.mockResolvedValue([{ ...initial, has_replay: true }]);
      await reconcile(payload);
      next = (await exec(db, "select run_after, payload_json from jobs where type = 'reconcile_user_recent_scores'")).rows[0];
      expect(next.run_after).toBe("2026-09-04T12:10:00.000Z");
      expect(JSON.parse(String(next.payload_json)).unchangedPolls).toBe(0);
      await exec(db, "delete from jobs where type = 'reconcile_user_recent_scores'");
      vi.setSystemTime(new Date("2026-09-04T12:10:00.000Z"));
      await ingestor.ingestBatch([{ ...initial, id: 9011, ended_at: "2026-09-04T11:59:00.000Z" }], "osu_scores_fallback", options);
      await reconcile(payload);
      next = (await exec(db, "select run_after, payload_json from jobs where type = 'reconcile_user_recent_scores'")).rows[0];
      expect(next.run_after).toBe("2026-09-04T12:12:00.000Z");
      expect(JSON.parse(String(next.payload_json)).latestScoreAt).toBe("2026-09-04T11:59:00.000Z");
    } finally { db.close(); }
  });
});
