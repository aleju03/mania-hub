import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  CHART_ANALYSIS_VERSION,
  OSU_FILE_REPAIR_META_KEY,
  invalidateOsuFileRepairDerivatives,
  readOsuFileRepairProgress,
  repairMismatchedOsuFilesChunk,
  runOsuFileRepairJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";
import { readCachedBeatmapFile, storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { nowIso } from "../src/shared/score.js";

type TestDb = Awaited<ReturnType<typeof createDb>>;

async function withDb(run: (db: TestDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-osu-repair-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function osuFile(version: string, beatmapId: number): string {
  return `osu file format v14\r\n\r\n[Metadata]\r\nTitle:Test\r\nVersion:${version}\r\nBeatmapID:${beatmapId}\r\n\r\n[HitObjects]\r\n`;
}

async function seedCachedChart(db: TestDb, beatmapId: number, version: string, cachedVersion: string): Promise<void> {
  await exec(
    db,
    `insert into beatmaps (beatmap_id, beatmapset_id, mode, version, updated_at)
     values (?, 1, 'mania', ?, ?)`,
    [beatmapId, version, nowIso()],
  );
  await storeCachedBeatmapFile(db, beatmapId, osuFile(cachedVersion, beatmapId), { source: "beatmap_archive" });
}

function osuStub(files: Record<number, string>): { getBeatmapFile: (id: number) => Promise<string>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async getBeatmapFile(id: number) {
      calls.push(id);
      const file = files[id];
      if (!file) throw new Error(`no file for ${id}`);
      return file;
    },
  };
}

describe("repairMismatchedOsuFilesChunk", () => {
  it("refetches a chart cached as a rate edit and leaves matching ones alone", async () => {
    await withDb(async (db) => {
      await seedCachedChart(db, 10, "[4K] Eddie Van Halen", "Eddie Van Halen 1.4x");
      await seedCachedChart(db, 11, "[4K] Eddie Van Halen", "Eddie Van Halen");
      await exec(
        db,
        `insert into dan_estimates (estimator_version, beatmap_id, rate_percent, status, computed_at, updated_at)
         values (1, ?, 100, 'ready', ?, ?)`,
        [10, nowIso(), nowIso()],
      );
      await exec(
        db,
        `insert into beatmap_chart_analysis
           (beatmap_id, analysis_version, status, msd_dt_json, msd_ht_json, updated_at)
         values (10, ?, 'ready', '{}', '{}', ?)`,
        [CHART_ANALYSIS_VERSION, nowIso()],
      );
      await exec(
        db,
        `insert into beatmap_skill_vectors (beatmap_id, analysis_version, status, updated_at)
         values (10, 1, 'ready', ?)`,
        [nowIso()],
      );
      const osu = osuStub({ 10: osuFile("Eddie Van Halen", 10) });

      const result = await repairMismatchedOsuFilesChunk(db, osu, 0, 100);
      await invalidateOsuFileRepairDerivatives(db, new JobQueue(db), result.repaired);

      expect(result.repaired).toEqual([10]);
      expect(result.failed).toBe(0);
      expect(result.done).toBe(true);
      expect(osu.calls).toEqual([10]);
      expect(await readCachedBeatmapFile(db, 10)).toContain("Version:Eddie Van Halen\r\n");
      expect((await exec(db, "select count(*) as n from dan_estimates where beatmap_id = 10")).rows[0].n).toBe(0);
      expect((await exec(db, "select count(*) as n from beatmap_chart_analysis where beatmap_id = 10")).rows[0].n).toBe(0);
      expect((await exec(db, "select count(*) as n from beatmap_skill_vectors where beatmap_id = 10")).rows[0].n).toBe(0);
      const source = (await exec(db, "select source from beatmap_osu_files where beatmap_id = 10")).rows[0];
      expect(source.source).toBe("osu_api_repair_queued_dt_ht_v1");
      const jobs = (await exec(db, "select type from jobs order by type")).rows.map((row) => row.type);
      expect(jobs).toEqual(["analyze_activity_beatmap", "analyze_beatmap_chart"]);
      const chartJob = (await exec(db, "select payload_json from jobs where type = 'analyze_beatmap_chart'")).rows[0];
      expect(JSON.parse(String(chartJob.payload_json))).toMatchObject({
        beatmapId: 10,
        recomputeDtRate: true,
        recomputeHtRate: true,
      });
    });
  });

  it("reports without touching anything in dry-run mode", async () => {
    await withDb(async (db) => {
      await seedCachedChart(db, 10, "[4K] Eddie Van Halen", "Eddie Van Halen 1.4x");
      const oldLastUsedAt = "2000-01-01T00:00:00.000Z";
      await exec(db, "update beatmap_osu_files set last_used_at = ? where beatmap_id = 10", [oldLastUsedAt]);
      const osu = osuStub({});

      const result = await repairMismatchedOsuFilesChunk(db, osu, 0, 100, { dryRun: true });

      expect(result.repaired).toEqual([10]);
      expect(osu.calls).toEqual([]);
      const row = (await exec(db, "select source, last_used_at from beatmap_osu_files where beatmap_id = 10")).rows[0];
      expect(row).toMatchObject({ source: "beatmap_archive", last_used_at: oldLastUsedAt });
      expect(await readCachedBeatmapFile(db, 10, { touch: false })).toContain("Eddie Van Halen 1.4x");
    });
  });

  it("stops at the per-chunk refetch cap and resumes on the chart it stopped at", async () => {
    await withDb(async (db) => {
      const files: Record<number, string> = {};
      for (let index = 0; index < 7; index += 1) {
        const beatmapId = 100 + index;
        await seedCachedChart(db, beatmapId, "[4K] Chart", "Chart 1.4x");
        files[beatmapId] = osuFile("Chart", beatmapId);
      }
      const osu = osuStub(files);

      const first = await repairMismatchedOsuFilesChunk(db, osu, 0, 100);
      expect(first.repaired).toEqual([100, 101, 102, 103, 104]);
      expect(first.scanned).toBe(5);
      expect(first.done).toBe(false);
      expect(first.nextCursor).toBe(104);

      const second = await repairMismatchedOsuFilesChunk(db, osu, first.nextCursor, 100);
      expect(second.repaired).toEqual([105, 106]);
      expect(second.done).toBe(true);
    });
  });

  it("stops on a transient refetch failure so the queue can retry it", async () => {
    await withDb(async (db) => {
      await seedCachedChart(db, 10, "[4K] Chart", "Chart 1.4x");
      await seedCachedChart(db, 11, "[4K] Other", "Other 1.2x");
      const osu = osuStub({ 11: osuFile("Other", 11) });

      const result = await repairMismatchedOsuFilesChunk(db, osu, 0, 100);

      expect(result.failed).toBe(0);
      expect(result.repaired).toEqual([]);
      expect(result.retryableFailure).toMatchObject({ beatmapId: 10 });
      expect(result.nextCursor).toBe(0);
      expect(result.done).toBe(false);
      expect(osu.calls).toEqual([10]);
      expect(await readCachedBeatmapFile(db, 10)).toContain("Chart 1.4x");
    });
  });

  it("invalidates a permanently unavailable wrong file and moves past it", async () => {
    await withDb(async (db) => {
      await seedCachedChart(db, 10, "[4K] Chart", "Chart 1.4x");
      await seedCachedChart(db, 11, "[4K] Other", "Other 1.2x");
      const calls: number[] = [];
      const osu = {
        calls,
        async getBeatmapFile(id: number) {
          calls.push(id);
          if (id === 10) {
            throw new Error("Failed to fetch .osu file for beatmap 10: osu (404); catboy (404)");
          }
          return osuFile("Other", 11);
        },
      };

      const result = await repairMismatchedOsuFilesChunk(db, osu, 0, 100);

      expect(result.failed).toBe(1);
      expect(result.unavailable).toEqual([10]);
      expect(result.repaired).toEqual([11]);
      expect(result.retryableFailure).toBeNull();
      expect(result.nextCursor).toBe(11);
      expect(await readCachedBeatmapFile(db, 10, { touch: false })).toBeNull();
      await invalidateOsuFileRepairDerivatives(db, new JobQueue(db), result.unavailable);
      const unavailable = (await exec(db, "select source, error from beatmap_osu_files where beatmap_id = 10")).rows[0];
      expect(unavailable.source).toBe("osu_file_repair_unavailable_v1");
      expect(String(unavailable.error)).toContain("404");
      expect((await exec(db, "select count(*) as n from jobs")).rows[0].n).toBe(0);
    });
  });

  it("skips charts with no known difficulty name rather than refetching them", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 10, osuFile("Whatever 1.4x", 10), { source: "beatmap_archive" });
      const osu = osuStub({});

      const result = await repairMismatchedOsuFilesChunk(db, osu, 0, 100);

      expect(result.repaired).toEqual([]);
      expect(osu.calls).toEqual([]);
    });
  });

  it("leaves directly fetched charts out of the scan", async () => {
    await withDb(async (db) => {
      await exec(
        db,
        `insert into beatmaps (beatmap_id, beatmapset_id, mode, version, updated_at)
         values (10, 1, 'mania', '[4K] Chart', ?)`,
        [nowIso()],
      );
      await storeCachedBeatmapFile(db, 10, osuFile("Chart 1.4x", 10), { source: "osu_api" });
      const osu = osuStub({});

      const result = await repairMismatchedOsuFilesChunk(db, osu, 0, 100);

      expect(result.scanned).toBe(0);
      expect(result.repaired).toEqual([]);
    });
  });
});

describe("invalidateOsuFileRepairDerivatives", () => {
  it("purges reusable player SSRs for repaired charts and queues a recompute", async () => {
    await withDb(async (db) => {
      const plays = [
        { identity: "bad", beatmapId: 10, keyCount: 4, rate: 1, goal: 0.95, pp: 100, values: { Overall: 24 }, patterns: [] },
        { identity: "good", beatmapId: 11, keyCount: 4, rate: 1, goal: 0.95, pp: 90, values: { Overall: 12 }, patterns: [] },
      ];
      await exec(
        db,
        `insert into player_skill_ratings
           (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (7, 18, 'ready', '{}', ?, ?, ?)`,
        [JSON.stringify({ version: 18, plays }), nowIso(), nowIso()],
      );

      await invalidateOsuFileRepairDerivatives(db, new JobQueue(db), [10], { includePlayerSkills: true });

      const row = (await exec(db, "select plays_json, computed_at from player_skill_ratings where user_id = 7")).rows[0];
      const stored = JSON.parse(String(row.plays_json)) as { plays: Array<{ beatmapId: number }> };
      expect(stored.plays.map((play) => play.beatmapId)).toEqual([11]);
      expect(Date.parse(String(row.computed_at))).toBeLessThan(Date.now() - 12 * 60 * 60_000);
      const jobs = (await exec(db, "select type from jobs order by type")).rows.map((job) => job.type);
      expect(jobs).toEqual(["analyze_activity_beatmap", "analyze_beatmap_chart", "compute_player_skills"]);
    });
  });
});

describe("runOsuFileRepairJob", () => {
  it("checkpoints before retrying a transient fetch and completes after recovery", async () => {
    await withDb(async (db) => {
      await seedCachedChart(db, 10, "[4K] Chart", "Chart 1.4x");
      const queue = new JobQueue(db);

      await expect(runOsuFileRepairJob(db, queue, osuStub({}), { cursor: 0 }))
        .rejects.toThrow(/Beatmap 10 repair refetch failed/);
      expect(await readOsuFileRepairProgress(db)).toEqual({ cursor: 0, scanned: 0, repaired: 0, failed: 0 });
      expect((await exec(db, "select 1 from live_meta where key = ?", [OSU_FILE_REPAIR_META_KEY])).rows).toHaveLength(0);

      await runOsuFileRepairJob(db, queue, osuStub({ 10: osuFile("Chart", 10) }), { cursor: 0 });

      expect(await readOsuFileRepairProgress(db)).toEqual({ cursor: 10, scanned: 1, repaired: 1, failed: 0 });
      expect((await exec(db, "select 1 from live_meta where key = ?", [OSU_FILE_REPAIR_META_KEY])).rows).toHaveLength(1);
      const jobs = (await exec(db, "select type from jobs order by type")).rows.map((job) => job.type);
      expect(jobs).toEqual(["analyze_activity_beatmap", "analyze_beatmap_chart"]);
    });
  });
});
