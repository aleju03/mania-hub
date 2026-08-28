import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  CHART_ANALYSIS_BACKFILL_JOB,
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  cancelChartAnalysisBackfill,
  computeBeatmapChartAnalysis,
  enqueueChartAnalysisBackfill,
  getChartAnalysisBackfillStatus,
  recomputeDanEligibilityChunk,
  runChartAnalysisBackfillJob,
  startChartAnalysisBackfill,
} from "../src/features/chart-analysis.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { JobQueue } from "../src/jobs/queue.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-chart-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A 4K stream chart long enough for the LeoBlack chain to produce a verdict:
// ~700 notes of rolling 1/4 stream at 170 BPM (88ms gaps).
function buildStreamBeatmapFile(): string {
  const notes = Array.from({ length: 700 }, (_, index) => {
    const column = [0, 2, 1, 3][index % 4];
    const x = 64 + column * 128;
    const time = 1000 + index * 88;
    return `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Chart Analysis Test
Artist: Test
Creator: Mapper
Version: 4K Stream

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

function buildStdBeatmapFile(): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Metadata]
Title: Std Map
Artist: Test
Creator: Mapper
Version: Insane

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
`;
}

describe("chart analysis", () => {
  it("stores classification and MSD for a mania chart", async () => {
    await withDb(async (db) => {
      const osu = { getBeatmapFile: async () => buildStreamBeatmapFile() };
      await computeBeatmapChartAnalysis(db, osu, { beatmapId: 555 });

      const row = (await exec(
        db,
        "select * from beatmap_chart_analysis where beatmap_id = 555 and analysis_version = ?",
        [CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(row).toBeTruthy();
      expect(String(row.status)).toBe("ready");
      expect(Number(row.key_count)).toBe(4);

      const classification = JSON.parse(String(row.classification_json));
      expect(classification.keyCount).toBe(4);
      expect(Array.isArray(classification.patterns)).toBe(true);
      expect(Array.isArray(classification.clusters)).toBe(true);
      expect(classification.lnRatio).toBeLessThan(0.05);
      expect(classification.danEligibility).toMatchObject({ eligible: true, reason: null });
      // beatLength 352.94 = 170 BPM under every note.
      expect(classification.noteBpm).toBe(170);

      // MSD runs the real MinaCalc wasm; a dense 4K stream must rate above 0.
      const msd = JSON.parse(String(row.msd_json));
      expect(msd.values.Overall).toBeGreaterThan(0);
      expect(msd.values.Stream).toBeGreaterThan(0);
      expect(Number(row.msd_overall)).toBeCloseTo(msd.values.Overall, 5);
    });
  }, 30_000);

  it("marks non-mania charts unavailable instead of analyzing garbage", async () => {
    await withDb(async (db) => {
      const osu = { getBeatmapFile: async () => buildStdBeatmapFile() };
      await computeBeatmapChartAnalysis(db, osu, { beatmapId: 556 });

      const row = (await exec(
        db,
        "select status, error from beatmap_chart_analysis where beatmap_id = 556 and analysis_version = ?",
        [CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(String(row.status)).toBe("unavailable");
      expect(String(row.error)).toContain("Not a mania beatmap");
    });
  });

  it("backfills structural player-dan eligibility without changing the stored chart verdict", async () => {
    await withDb(async (db) => {
      const stacked = buildStreamBeatmapFile().replace(
        "[HitObjects]\n",
        `[HitObjects]\n${Array.from({ length: 8 }, () => "64,192,15,128,0,47:0:0:0:0:").join("\n")}\n`,
      );
      await storeCachedBeatmapFile(db, 557, stacked, { source: "test" });
      const before = {
        keyCount: 4,
        sunnySr: 99,
        warnings: ["Pattern clustering failed: Stacked LN at 15, column 1, head coincides with 2."],
        primary: { rawDan: 17.5 },
      };
      await exec(
        db,
        `insert into beatmap_chart_analysis
           (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, classification_json, updated_at)
         values (557, ?, 'ready', 4, '17++', 'ln', 17.5, json(?), ?)`,
        [CHART_ANALYSIS_VERSION, JSON.stringify(before), new Date().toISOString()],
      );

      const result = await recomputeDanEligibilityChunk(db, 0);
      expect(result.ineligible).toEqual([557]);

      const row = (await exec(
        db,
        "select primary_label, raw_dan, classification_json from beatmap_chart_analysis where beatmap_id = 557",
      )).rows[0];
      expect(String(row.primary_label)).toBe("17++");
      expect(Number(row.raw_dan)).toBe(17.5);
      const classification = JSON.parse(String(row.classification_json));
      expect(classification.danEligibility).toMatchObject({
        eligible: false,
        reason: "stacked_same_column_heads",
        maxSameColumnHeadStack: 8,
      });
    });
  });

  it("backfills analysis jobs from cached .osu files", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await storeCachedBeatmapFile(db, 777, buildStreamBeatmapFile(), { source: "test" });
      const enqueued = await enqueueChartAnalysisBackfill(db, queue, 100);
      expect(enqueued).toBe(1);

      const job = (await exec(db, "select type, dedupe_key from jobs where type = ?", [CHART_ANALYSIS_JOB])).rows[0];
      expect(job).toBeTruthy();
      expect(String(job.dedupe_key)).toBe(`chart-analysis:${CHART_ANALYSIS_VERSION}:777`);

      // Second sweep enqueues nothing new (job dedupe + same missing row set).
      const again = await enqueueChartAnalysisBackfill(db, queue, 100);
      expect(again).toBe(1);
      const count = (await exec(db, "select count(*) as n from jobs where type = ?", [CHART_ANALYSIS_JOB])).rows[0];
      expect(Number(count.n)).toBe(1);
    });
  });

  it("prioritizes the most-farmed maps when the backfill limit is smaller than the missing set", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      for (const id of [801, 802, 803]) {
        await storeCachedBeatmapFile(db, id, buildStreamBeatmapFile(), { source: "test" });
      }
      const iso = "2026-01-01T00:00:00Z";
      const farm = (beatmapId: number, userId: number) => exec(
        db,
        `insert into country_maps_farmed_scores
           (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
         values ('CR', ?, ?, ?, 100, '{}', '[]', null, ?, ?, ?)`,
        [userId, beatmapId, userId * 100000 + beatmapId, iso, iso, iso],
      );
      for (let u = 1; u <= 5; u += 1) await farm(801, u); // most farmed
      for (let u = 1; u <= 2; u += 1) await farm(802, u); // some farmed
      // 803 is never farmed.

      const enqueued = await enqueueChartAnalysisBackfill(db, queue, 2);
      expect(enqueued).toBe(2);
      const jobs = (await exec(db, "select dedupe_key from jobs where type = ?", [CHART_ANALYSIS_JOB])).rows
        .map((row) => String(row.dedupe_key));
      expect(jobs).toContain(`chart-analysis:${CHART_ANALYSIS_VERSION}:801`);
      expect(jobs).toContain(`chart-analysis:${CHART_ANALYSIS_VERSION}:802`);
      expect(jobs).not.toContain(`chart-analysis:${CHART_ANALYSIS_VERSION}:803`);
    });
  });
});

describe("chart analysis backfill run", () => {
  it("starts, tops up the queue, and finishes when nothing is missing", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await storeCachedBeatmapFile(db, 801, buildStreamBeatmapFile(), { source: "test" });
      await storeCachedBeatmapFile(db, 802, buildStreamBeatmapFile(), { source: "test" });

      const started = await startChartAnalysisBackfill(db, queue);
      expect(started.status).toBe("running");
      expect(started.remaining).toBe(2);

      // Runner tick: tops the analysis queue up and chains itself.
      const runnerJob = (await exec(db, "select payload_json from jobs where type = ?", [CHART_ANALYSIS_BACKFILL_JOB])).rows[0];
      const payload = JSON.parse(String(runnerJob.payload_json));
      await runChartAnalysisBackfillJob(db, queue, payload);
      const analysisJobs = (await exec(db, "select count(*) as n from jobs where type = ?", [CHART_ANALYSIS_JOB])).rows[0];
      expect(Number(analysisJobs.n)).toBe(2);

      // Simulate the analysis jobs completing, then the next tick finishes the run.
      const osu = { getBeatmapFile: async () => buildStreamBeatmapFile() };
      await computeBeatmapChartAnalysis(db, osu, { beatmapId: 801 });
      await computeBeatmapChartAnalysis(db, osu, { beatmapId: 802 });
      await exec(db, "delete from jobs where type = ?", [CHART_ANALYSIS_JOB]);
      await runChartAnalysisBackfillJob(db, queue, { runId: payload.runId, tick: 1 });

      const finished = await getChartAnalysisBackfillStatus(db);
      expect(finished.status).toBe("done");
      expect(finished.remaining).toBe(0);
      expect(finished.ready).toBe(2);
      expect(finished.percent).toBe(100);
    });
  }, 60_000);

  it("cancel drops queued work and a stale runner tick is ignored", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await storeCachedBeatmapFile(db, 811, buildStreamBeatmapFile(), { source: "test" });
      const started = await startChartAnalysisBackfill(db, queue);
      expect(started.status).toBe("running");

      const cancelled = await cancelChartAnalysisBackfill(db);
      expect(cancelled.status).toBe("cancelled");
      const jobs = (await exec(db, "select count(*) as n from jobs where type in (?, ?) and status = 'queued'", [CHART_ANALYSIS_JOB, CHART_ANALYSIS_BACKFILL_JOB])).rows[0];
      expect(Number(jobs.n)).toBe(0);

      // A tick from the cancelled run must not restart anything.
      await runChartAnalysisBackfillJob(db, queue, { runId: started.runId ?? "", tick: 1 });
      const after = await getChartAnalysisBackfillStatus(db);
      expect(after.status).toBe("cancelled");
    });
  });
});
