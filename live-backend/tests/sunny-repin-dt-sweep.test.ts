import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  CHART_ANALYSIS_VERSION,
  SUNNY_REPIN_DT_RECOMPUTE_JOB,
  ensureSunnyRepinDtRecomputeSeeded,
  recomputeDtRateChunk,
  recomputeSunnyRepinDtChunk,
  runSunnyRepinDtRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { nowIso } from "../src/shared/score.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-sunny-repin-dt-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Same dense stream fixture as the DT-rate sweep test: long enough for
// MinaCalc to rate it above 0, lane x positions on osu!mania's 512 grid.
function buildStreamBeatmapFile(keyCount = 4): string {
  const notes = Array.from({ length: 700 }, (_, index) => {
    const column = index % keyCount;
    const x = Math.floor((512 * (column + 0.5)) / keyCount);
    const time = 1000 + index * 88;
    return `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: DT Verdict Refresh Test
Artist: Test
Creator: Mapper
Version: ${keyCount}K Stream

[Difficulty]
CircleSize:${keyCount}
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

async function seedReadyAnalysis(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number, keyCount = 4): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, updated_at)
     values (?, ?, 'ready', ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, keyCount, now],
  );
}

async function seedDtFarmed(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values ('CR', 1, ?, ?, 500, '{}', ?, null, ?, ?, ?)`,
    [beatmapId, beatmapId * 10, JSON.stringify(["DT"]), now, now, now],
  );
}

// Mints real msd_dt_json / dan_dt_json through the DT-rate sweep so the
// refresh runs against columns shaped exactly like production's.
async function mintDtColumns(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number): Promise<void> {
  await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
  await seedReadyAnalysis(db, beatmapId);
  await seedDtFarmed(db, beatmapId);
  const minted = await recomputeDtRateChunk(db, 0);
  expect(minted.computed).toContain(beatmapId);
}

describe("Sunny re-pin DT verdict sweep", () => {
  it("re-derives dan_dt_json from the stored 1.5x MSD and leaves msd_dt_json alone", async () => {
    await withDb(async (db) => {
      const beatmapId = 6100;
      await mintDtColumns(db, beatmapId);
      const before = (await exec(
        db,
        "select msd_dt_json, dan_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [beatmapId, CHART_ANALYSIS_VERSION],
      )).rows[0];

      // Simulate a pre-re-pin verdict the refresh must overwrite.
      const stale = JSON.stringify({ primaryLabel: "stale", primaryFamily: "dan", rawDan: 1 });
      await exec(
        db,
        "update beatmap_chart_analysis set dan_dt_json = json(?) where beatmap_id = ? and analysis_version = ?",
        [stale, beatmapId, CHART_ANALYSIS_VERSION],
      );

      const result = await recomputeSunnyRepinDtChunk(db, 0);
      expect(result.computed).toContain(beatmapId);
      expect(result.done).toBe(true);

      const after = (await exec(
        db,
        "select msd_dt_json, dan_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [beatmapId, CHART_ANALYSIS_VERSION],
      )).rows[0];
      // The verdict re-minted from the current estimator matches the fresh
      // mint (same code path, same stored MSD), not the stale value.
      expect(String(after.dan_dt_json)).not.toBe(stale);
      expect(JSON.parse(String(after.dan_dt_json))).toEqual(JSON.parse(String(before.dan_dt_json)));
      // The MinaCalc side is untouched.
      expect(String(after.msd_dt_json)).toBe(String(before.msd_dt_json));
    });
  }, 30_000);

  it("skips rows without a stored DT verdict", async () => {
    await withDb(async (db) => {
      const beatmapId = 6200;
      await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
      await seedReadyAnalysis(db, beatmapId);

      const result = await recomputeSunnyRepinDtChunk(db, 0);
      expect(result.scanned).toBe(0);
      expect(result.done).toBe(true);
      const row = (await exec(
        db,
        "select dan_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [beatmapId, CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(row.dan_dt_json).toBeNull();
    });
  });

  it("runs once: refreshes verdicts, marks itself done, never re-seeds", async () => {
    await withDb(async (db) => {
      const beatmapId = 6300;
      await mintDtColumns(db, beatmapId);
      const queue = new JobQueue(db);

      await ensureSunnyRepinDtRecomputeSeeded(db, queue);
      let [job] = await queue.claim("test-worker", 1);
      expect(job?.type).toBe(SUNNY_REPIN_DT_RECOMPUTE_JOB);
      while (job) {
        if (job.type === SUNNY_REPIN_DT_RECOMPUTE_JOB) {
          await runSunnyRepinDtRecomputeJob(db, queue, job.payload as { cursor?: number });
        }
        await queue.complete(job.id);
        [job] = await queue.claim("test-worker", 1);
      }

      const done = (await exec(db, "select 1 from live_meta where key = ?", ["sunny_repin_dt_recompute_done:v2"])).rows[0];
      expect(done).toBeTruthy();

      await ensureSunnyRepinDtRecomputeSeeded(db, queue);
      const after = await queue.claim("test-worker", 1);
      expect(after.length).toBe(0);
    });
  }, 30_000);
});
