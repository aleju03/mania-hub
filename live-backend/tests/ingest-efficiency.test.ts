import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec, migrate } from "../src/db.js";
import { ScoreIngestor } from "../src/ingest/score-ingestor.js";
import { JobQueue } from "../src/jobs/queue.js";
import { nextRecentReconcileCadence, promotePendingRecentReconcileJobs, type RecentReconcilePayload } from "../src/jobs/recent-reconcile.js";
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
      const [job] = await queue.claim("fast", 1);
      expect(job.payload).toMatchObject({ unchangedPolls: 0, source: "osu_recent_fallback", processLeaderboardFeatures: true });
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
      osu.getUserRecentScores.mockResolvedValue([{ ...initial, has_replay: true }]);
      await reconcile(payload);
      next = (await exec(db, "select run_after, payload_json from jobs where type = 'reconcile_user_recent_scores'")).rows[0];
      expect(next.run_after).toBe("2026-09-04T12:02:00.000Z");
      expect(JSON.parse(String(next.payload_json)).unchangedPolls).toBe(0);
      await exec(db, "delete from jobs where type = 'reconcile_user_recent_scores'");
      await ingestor.ingestBatch([{ ...initial, id: 9011, ended_at: "2026-09-04T11:59:00.000Z" }], "osu_scores_fallback", options);
      await reconcile(payload);
      next = (await exec(db, "select run_after, payload_json from jobs where type = 'reconcile_user_recent_scores'")).rows[0];
      expect(next.run_after).toBe("2026-09-04T12:02:00.000Z");
      expect(JSON.parse(String(next.payload_json)).latestScoreAt).toBe("2026-09-04T11:59:00.000Z");
    } finally { db.close(); }
  });
});
