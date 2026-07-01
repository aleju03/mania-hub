import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  BEATMAP_OSU_FILE_BACKFILL_JOB,
  getBeatmapOsuFileBackfillStatus,
  runBeatmapOsuFileBackfillJob,
  startBeatmapOsuFileBackfill,
} from "../src/features/beatmap-osu-file-backfill.js";
import { JobQueue } from "../src/jobs/queue.js";

describe("beatmap .osu file backfill", () => {
  it("queues and completes a compressed cache backfill for analyzed maps", async () => {
    const { db, queue, cleanup } = await setupDb();
    try {
      await seedReadyVector(db, 101);
      await seedReadyVector(db, 102);
      const fetched: number[] = [];
      const osu = {
        getBeatmapFile: async (beatmapId: number) => {
          fetched.push(beatmapId);
          return buildBeatmapFile(beatmapId);
        },
      };

      const queued = await startBeatmapOsuFileBackfill(db, queue);
      expect(queued.missing).toBe(2);
      expect(queued.status).toBe("queued");

      const [job] = await queue.claim("test-worker", 1, { types: [BEATMAP_OSU_FILE_BACKFILL_JOB] });
      expect(job).toBeTruthy();
      await runBeatmapOsuFileBackfillJob(db, queue, osu as never, job.payload as { runId: string; cursor?: number });
      await queue.complete(job.id);

      const status = await getBeatmapOsuFileBackfillStatus(db);
      expect(status.status).toBe("done");
      expect(status.cached).toBe(2);
      expect(status.missing).toBe(0);
      expect(status.stored).toBe(2);
      expect(fetched).toEqual([101, 102]);
    } finally {
      await cleanup();
    }
  });

  it("marks terminal missing .osu files unavailable so the run can finish", async () => {
    const { db, queue, cleanup } = await setupDb();
    try {
      await seedReadyVector(db, 404001);
      const osu = {
        getBeatmapFile: async () => {
          throw new Error("Failed to fetch .osu file for beatmap 404001: osu (404); catboy (404)");
        },
      };

      await startBeatmapOsuFileBackfill(db, queue);
      const [job] = await queue.claim("test-worker", 1, { types: [BEATMAP_OSU_FILE_BACKFILL_JOB] });
      await runBeatmapOsuFileBackfillJob(db, queue, osu as never, job.payload as { runId: string; cursor?: number });
      await queue.complete(job.id);

      const status = await getBeatmapOsuFileBackfillStatus(db);
      expect(status.status).toBe("done");
      expect(status.cached).toBe(0);
      expect(status.unavailable).toBe(1);
      expect(status.missing).toBe(0);
      expect(status.lastError).toContain("404001");

      const row = (await exec(db, "select source, error from beatmap_osu_files where beatmap_id = 404001")).rows[0];
      expect(row.source).toBe("unavailable");
      expect(String(row.error)).toContain("404");
    } finally {
      await cleanup();
    }
  });

  it("queues the next batch immediately while the current batch is still running", async () => {
    const { db, queue, cleanup } = await setupDb();
    try {
      for (let beatmapId = 201; beatmapId <= 213; beatmapId++) {
        await seedReadyVector(db, beatmapId);
      }
      const osu = {
        getBeatmapFile: async (beatmapId: number) => buildBeatmapFile(beatmapId),
      };

      await startBeatmapOsuFileBackfill(db, queue);
      const [firstJob] = await queue.claim("test-worker", 1, { types: [BEATMAP_OSU_FILE_BACKFILL_JOB] });
      await runBeatmapOsuFileBackfillJob(db, queue, osu as never, firstJob.payload as { runId: string; cursor?: number });
      await queue.complete(firstJob.id);

      const afterFirstBatch = await getBeatmapOsuFileBackfillStatus(db);
      expect(afterFirstBatch.cached).toBe(12);
      expect(afterFirstBatch.missing).toBe(1);
      expect(afterFirstBatch.jobs.queued).toBe(1);
      expect(afterFirstBatch.jobs.deferred).toBe(0);

      const [secondJob] = await queue.claim("test-worker", 1, { types: [BEATMAP_OSU_FILE_BACKFILL_JOB] });
      expect(secondJob).toBeTruthy();
      await runBeatmapOsuFileBackfillJob(db, queue, osu as never, secondJob.payload as { runId: string; cursor?: number });
      await queue.complete(secondJob.id);

      const done = await getBeatmapOsuFileBackfillStatus(db);
      expect(done.status).toBe("done");
      expect(done.cached).toBe(13);
      expect(done.missing).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

async function setupDb(): Promise<{ db: Awaited<ReturnType<typeof createDb>>; queue: JobQueue; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-osu-backfill-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return {
    db,
    queue: new JobQueue(db),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function seedReadyVector(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number): Promise<void> {
  await exec(
    db,
    `insert into beatmap_skill_vectors (beatmap_id, analysis_version, status, skills_json, updated_at)
     values (?, 4, 'ready', '{}', '2026-01-01T00:00:00.000Z')`,
    [beatmapId],
  );
}

function buildBeatmapFile(beatmapId: number): string {
  const notes = Array.from({ length: 128 }, (_, index) => {
    const column = index % 4;
    const x = 64 + column * 128;
    const time = 1000 + index * 100;
    return `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
Mode: 3

[Metadata]
Title: Backfill Test
Artist: Test
Creator: Mapper
Version: 4K
BeatmapID:${beatmapId}

[Difficulty]
CircleSize:4

[HitObjects]
${notes}
`;
}
