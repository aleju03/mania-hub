import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import * as analysis from "../src/features/chart-analysis.js";
import { LEOBLACK_FUSION_JOB, LEOBLACK_FUSION_META_KEY, ensureLeoblackFusionSeeded, recomputeLeoblackFusionChunk, runLeoblackFusionJob } from "../src/features/leoblack-fusion.js";
import { computeAndStoreRateDanVerdictFromText, loadStoredRateDanVerdicts } from "../src/features/dan-estimates.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../src/dan/dan-estimator/cache-version.js";
import { JobQueue } from "../src/jobs/queue.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";

const TEXT = ["osu file format v14", "[General]", "Mode:3", "[Difficulty]",
  "CircleSize:4", "OverallDifficulty:8", "[TimingPoints]", "0,352.94,4,2,0,100,1,0", "[HitObjects]",
  ...Array.from({ length: 700 }, (_, i) => `${64 + i % 4 * 128},192,${1000 + i * 88},1,0,0:0:0:0:`),
].join("\n");

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-fusion-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try {
    await migrate(db);
    await run(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(db: Db, id: number, sunnySr = 4, lnRatio = 0, keys = 4): Promise<void> {
  await storeCachedBeatmapFile(db, id, TEXT, { source: "test" });
  await exec(db, `insert into beatmap_chart_analysis
    (beatmap_id, analysis_version, status, key_count, raw_dan, classification_json, updated_at)
    values (?, ?, 'ready', ?, 99, ?, ?)`,
  [id, analysis.CHART_ANALYSIS_VERSION, keys, JSON.stringify({ sunnySr, lnRatio }), new Date().toISOString()]);
}

afterEach(() => vi.restoreAllMocks());

describe("LeoBlack fusion rollout", () => {
  it("refreshes low-band charts and existing HT/custom-rate verdicts, including high base SR", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      await seed(db, 2, 10); // Its HT verdict can still fall below Sunny 9.
      await seed(db, 3, 10); // No rate data and no low-band base verdict.
      await seed(db, 4, 4, 0.5);
      await seed(db, 5, 4, 0, 7);
      await seed(db, 6);
      await exec(db, "delete from beatmap_osu_files where beatmap_id = 6");
      expect(await analysis.storeHtRateVerdict(db, 2)).toBe(true);
      await exec(db, "update beatmap_chart_analysis set dan_ht_json = '{\"rawDan\":99}' where beatmap_id = 2");
      await computeAndStoreRateDanVerdictFromText(db, 1, 125, TEXT);
      await exec(db, "update dan_estimates set estimator_version = ?, raw_dan = 99 where beatmap_id = 1",
        [DAN_ESTIMATE_CACHE_VERSION - 1]);

      const first = await recomputeLeoblackFusionChunk(db, 0, { limit: 1 });
      expect(first).toMatchObject({ nextCursor: 1, rewritten: 1, done: false });
      const rest = await recomputeLeoblackFusionChunk(db, first.nextCursor);
      expect(rest).toMatchObject({ nextCursor: 6, scanned: 2, rewritten: 1, done: true });
      const rows = (await exec(db, "select beatmap_id, raw_dan, dan_ht_json from beatmap_chart_analysis order by beatmap_id")).rows;
      expect(Number(rows[0].raw_dan)).not.toBe(99);
      expect(JSON.parse(String(rows[1].dan_ht_json)).rawDan).not.toBe(99);
      expect(rows.slice(1).every((row) => Number(row.raw_dan) === 99)).toBe(true);
      const rates = await loadStoredRateDanVerdicts(db, [{ beatmapId: 1, ratePercent: 125 }]);
      expect(rates.size).toBe(1);
      expect([...rates.values()][0]?.rawDan).not.toBe(99);
    });
  }, 30_000);

  it("does not stamp completion on a failed repair and retries the same chart", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      const queue = new JobQueue(db);
      vi.spyOn(analysis, "computeBeatmapChartAnalysis").mockImplementationOnce(async () => {
        await exec(db, "update beatmap_chart_analysis set status = 'failed' where beatmap_id = 1");
        throw new Error("worker unavailable");
      });
      await expect(runLeoblackFusionJob(db, queue, { cursor: 0 })).rejects.toThrow("worker unavailable");
      expect((await exec(db, "select 1 from live_meta where key = ?", [LEOBLACK_FUSION_META_KEY])).rows).toHaveLength(0);
      expect((await exec(db, "select status from beatmap_chart_analysis where beatmap_id = 1")).rows[0].status).toBe("ready");
      expect(await recomputeLeoblackFusionChunk(db, 0)).toMatchObject({ rewritten: 1, done: true });
    });
  }, 30_000);

  it("seeds once and rebuilds collections after the final repair", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      const queue = new JobQueue(db);
      await ensureLeoblackFusionSeeded(db, queue);
      await ensureLeoblackFusionSeeded(db, queue);
      const [job] = await queue.claim("test", 1);
      expect(job.type).toBe(LEOBLACK_FUSION_JOB);
      await runLeoblackFusionJob(db, queue, job.payload as { cursor?: number });
      await queue.complete(job.id);
      await ensureLeoblackFusionSeeded(db, queue);
      expect((await exec(db, "select 1 from live_meta where key = ?", [LEOBLACK_FUSION_META_KEY])).rows).toHaveLength(1);
      expect((await exec(db, "select type from jobs where status = 'queued'")).rows.map((row) => row.type))
        .toEqual(["rebuild_map_collections"]);
    });
  }, 30_000);

  it("preserves unaffected v15 rate evidence without replacing current results or reviving older versions", async () => {
    await withDb(async (db) => {
      await seed(db, 7, 4, 0, 7);
      await seed(db, 8, 4, 0.5);
      await seed(db, 9); // Affected rice evidence must be recomputed, never promoted.
      await exec(db, "delete from beatmap_osu_files where beatmap_id = 9");
      for (const [id, rate, version, raw] of [[7, 125, 15, 7], [7, 125, 16, 8], [7, 120, 15, 9], [8, 125, 15, 10], [8, 120, 14, 11], [9, 125, 15, 99]]) {
        await exec(db, `insert into dan_estimates
          (estimator_version, beatmap_id, rate_percent, status, raw_dan, computed_at, updated_at)
          values (?, ?, ?, 'ready', ?, ?, ?)`, [version, id, rate, raw, new Date().toISOString(), new Date().toISOString()]);
      }
      await exec(db, `insert into dan_mod_estimates
        (estimator_version, beatmap_id, rate_percent, mod_variant, status, raw_dan, computed_at, updated_at)
        values (15, 7, 150, 'IN', 'ready', 12, ?, ?)`, [new Date().toISOString(), new Date().toISOString()]);
      await runLeoblackFusionJob(db, new JobQueue(db), { cursor: 0 });
      const values = (await exec(db,
        "select beatmap_id, rate_percent, raw_dan from dan_estimates where estimator_version = 16 order by beatmap_id, rate_percent")).rows;
      expect(values.map((row) => [Number(row.beatmap_id), Number(row.rate_percent), Number(row.raw_dan)]))
        .toEqual([[7, 120, 9], [7, 125, 8], [8, 125, 10]]);
      expect((await exec(db, "select raw_dan from dan_mod_estimates where estimator_version = 16")).rows[0]?.raw_dan).toBe(12);
    });
  });
});
