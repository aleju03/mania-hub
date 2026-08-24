import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, parseJson, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  LEOBLACK_REPIN_DT_RECOMPUTE_JOB,
  LEOBLACK_REPIN_RECOMPUTE_JOB,
  ensureLeoblackRepinDtRecomputeSeeded,
  ensureLeoblackRepinRecomputeSeeded,
  hasCapPinnedSkillset,
  recomputeDtRateChunk,
  recomputeLeoblackRepinChunk,
  recomputeLeoblackRepinDtChunk,
  runLeoblackRepinDtRecomputeJob,
  runLeoblackRepinRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { nowIso } from "../src/shared/score.js";

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-leoblack-repin-"));
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
Title: LeoBlack Repin DT Test
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

async function seedReadyAnalysis(db: Db, beatmapId: number, keyCount = 4): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, updated_at)
     values (?, ?, 'ready', ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, keyCount, now],
  );
}

async function seedDtFarmed(db: Db, beatmapId: number): Promise<void> {
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
async function mintDtColumns(db: Db, beatmapId: number): Promise<void> {
  await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
  await seedReadyAnalysis(db, beatmapId);
  await seedDtFarmed(db, beatmapId);
  const minted = await recomputeDtRateChunk(db, 0);
  expect(minted.computed).toContain(beatmapId);
}

async function readDtColumns(db: Db, beatmapId: number): Promise<{ msd: string; dan: string }> {
  const row = (await exec(
    db,
    "select msd_dt_json, dan_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
    [beatmapId, CHART_ANALYSIS_VERSION],
  )).rows[0];
  return { msd: String(row.msd_dt_json), dan: String(row.dan_dt_json) };
}

describe("cap-pin signature", () => {
  it("matches any skillset at exactly the old 40 clamp and nothing else", () => {
    expect(hasCapPinnedSkillset({ Stream: 40, Overall: 41.57, Jumpstream: 40 })).toBe(true);
    expect(hasCapPinnedSkillset({ Stream: 39.999, Overall: 41.57 })).toBe(false);
    expect(hasCapPinnedSkillset({ Stream: 24.5, Overall: 26.1 })).toBe(false);
    expect(hasCapPinnedSkillset(undefined)).toBe(false);
    expect(hasCapPinnedSkillset(null)).toBe(false);
  });
});

describe("LeoBlack re-pin main sweep", () => {
  it("recomputes a small chunk inline instead of parking one queue job per chart", async () => {
    await withDb(async (db) => {
      for (const beatmapId of [1, 2]) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await seedReadyAnalysis(db, beatmapId);
      }

      const first = await recomputeLeoblackRepinChunk(
        db,
        { getBeatmapFile: async () => buildStreamBeatmapFile() },
        0,
        { limit: 1, interMapPauseMs: 0 },
      );
      expect(first).toMatchObject({ scanned: 1, recomputed: [1], done: false });

      const rows = (await exec(
        db,
        `select beatmap_id, status, computed_at
         from beatmap_chart_analysis
         where analysis_version = ?
         order by beatmap_id`,
        [CHART_ANALYSIS_VERSION],
      )).rows;
      expect(String(rows[0].status)).toBe("ready");
      expect(rows[0].computed_at).toBeTruthy();
      expect(rows[1].computed_at).toBeNull();
    });
  }, 30_000);

  it("runs once: finishes analyses before rebuilding collections and never re-seeds", async () => {
    await withDb(async (db) => {
      await storeCachedBeatmapFile(db, 1, buildStreamBeatmapFile(), { source: "test" });
      await seedReadyAnalysis(db, 1);
      const queue = new JobQueue(db);
      const osu = { getBeatmapFile: async () => buildStreamBeatmapFile() };

      await ensureLeoblackRepinRecomputeSeeded(db, queue);
      const seenTypes: string[] = [];
      let [job] = await queue.claim("test-worker", 1);
      expect(job?.type).toBe(LEOBLACK_REPIN_RECOMPUTE_JOB);
      while (job) {
        seenTypes.push(job.type);
        if (job.type === LEOBLACK_REPIN_RECOMPUTE_JOB) {
          await runLeoblackRepinRecomputeJob(db, queue, osu, job.payload as { cursor?: number });
        }
        await queue.complete(job.id);
        [job] = await queue.claim("test-worker", 1);
      }

      expect(seenTypes).not.toContain(CHART_ANALYSIS_JOB);
      expect(seenTypes).toContain("rebuild_map_collections");

      const analysis = (await exec(
        db,
        "select status, computed_at from beatmap_chart_analysis where beatmap_id = 1 and analysis_version = ?",
        [CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(String(analysis.status)).toBe("ready");
      expect(analysis.computed_at).toBeTruthy();

      const done = (await exec(db, "select 1 from live_meta where key = ?", ["leoblack_repin_recompute_done:v1"])).rows[0];
      expect(done).toBeTruthy();

      await ensureLeoblackRepinRecomputeSeeded(db, queue);
      const after = await queue.claim("test-worker", 1);
      expect(after.length).toBe(0);
    });
  }, 30_000);

  it("gives an interactive chart analysis the lane between sweep links", async () => {
    await withDb(async (db) => {
      for (let beatmapId = 100; beatmapId <= 110; beatmapId += 1) {
        await storeCachedBeatmapFile(db, beatmapId, buildStreamBeatmapFile(), { source: "test" });
        await seedReadyAnalysis(db, beatmapId);
      }
      const queue = new JobQueue(db);
      const osu = { getBeatmapFile: async () => buildStreamBeatmapFile() };

      await ensureLeoblackRepinRecomputeSeeded(db, queue);
      const [sweep] = await queue.claim("test-worker", 1);
      expect(sweep?.type).toBe(LEOBLACK_REPIN_RECOMPUTE_JOB);

      // Arrives while the first ten-map link is running. It must beat the
      // priority -10 continuation as soon as that link yields the lane.
      await queue.enqueue(
        CHART_ANALYSIS_JOB,
        `chart-analysis:${CHART_ANALYSIS_VERSION}:999`,
        { beatmapId: 999 },
        { priority: 4, replaceDone: true },
      );
      await runLeoblackRepinRecomputeJob(db, queue, osu, sweep.payload as { cursor?: number });
      await queue.complete(sweep.id);

      const [next] = await queue.claim("test-worker", 1);
      expect(next?.type).toBe(CHART_ANALYSIS_JOB);
      const done = (await exec(db, "select 1 from live_meta where key = ?", ["leoblack_repin_recompute_done:v1"])).rows[0];
      expect(done).toBeUndefined();
      const remaining = (await exec(
        db,
        "select computed_at from beatmap_chart_analysis where beatmap_id = 110 and analysis_version = ?",
        [CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(remaining.computed_at).toBeNull();
    });
  }, 30_000);
});

describe("LeoBlack re-pin DT sweep", () => {
  it("re-mints the verdict from stored MSD on unpinned rows, leaving msd_dt_json alone", async () => {
    await withDb(async (db) => {
      const beatmapId = 7100;
      await mintDtColumns(db, beatmapId);
      const before = await readDtColumns(db, beatmapId);

      // Simulate a pre-re-pin verdict the refresh must overwrite.
      const stale = JSON.stringify({ primaryLabel: "stale", primaryFamily: "dan", rawDan: 1 });
      await exec(
        db,
        "update beatmap_chart_analysis set dan_dt_json = json(?) where beatmap_id = ? and analysis_version = ?",
        [stale, beatmapId, CHART_ANALYSIS_VERSION],
      );

      const result = await recomputeLeoblackRepinDtChunk(db, 0);
      expect(result.computed).toContain(beatmapId);
      expect(result.msdRefreshed).toEqual([]);
      expect(result.done).toBe(true);

      const after = await readDtColumns(db, beatmapId);
      expect(after.dan).not.toBe(stale);
      expect(JSON.parse(after.dan)).toEqual(JSON.parse(before.dan));
      expect(after.msd).toBe(before.msd);
    });
  }, 30_000);

  it("redoes the 1.5x MinaCalc pass on rows with a skillset pinned at the old cap", async () => {
    await withDb(async (db) => {
      const beatmapId = 7200;
      await mintDtColumns(db, beatmapId);
      const before = await readDtColumns(db, beatmapId);

      // Doctor the stored vector into the pinned shape the old engine wrote.
      const doctored = parseJson<{ values: Record<string, number> }>(before.msd, { values: {} });
      doctored.values.Stream = 40;
      await exec(
        db,
        "update beatmap_chart_analysis set msd_dt_json = json(?) where beatmap_id = ? and analysis_version = ?",
        [JSON.stringify(doctored), beatmapId, CHART_ANALYSIS_VERSION],
      );

      const result = await recomputeLeoblackRepinDtChunk(db, 0);
      expect(result.msdRefreshed).toEqual([beatmapId]);
      expect(result.computed).toContain(beatmapId);

      // The refreshed MinaCalc pass replaces the doctored vector with the
      // engine's real output (this fixture rates nowhere near the cap).
      const after = await readDtColumns(db, beatmapId);
      const refreshed = parseJson<{ values: Record<string, number> }>(after.msd, { values: {} });
      expect(refreshed.values.Stream).not.toBe(40);
      expect(after.msd).toBe(before.msd);
      expect(JSON.parse(after.dan)).toEqual(JSON.parse(before.dan));
    });
  }, 30_000);

  it("runs once and records the done key", async () => {
    await withDb(async (db) => {
      const beatmapId = 7300;
      await mintDtColumns(db, beatmapId);
      const queue = new JobQueue(db);

      await ensureLeoblackRepinDtRecomputeSeeded(db, queue);
      let [job] = await queue.claim("test-worker", 1);
      expect(job?.type).toBe(LEOBLACK_REPIN_DT_RECOMPUTE_JOB);
      while (job) {
        if (job.type === LEOBLACK_REPIN_DT_RECOMPUTE_JOB) {
          await runLeoblackRepinDtRecomputeJob(db, queue, job.payload as { cursor?: number });
        }
        await queue.complete(job.id);
        [job] = await queue.claim("test-worker", 1);
      }

      const done = (await exec(db, "select 1 from live_meta where key = ?", ["leoblack_repin_dt_recompute_done:v1"])).rows[0];
      expect(done).toBeTruthy();

      await ensureLeoblackRepinDtRecomputeSeeded(db, queue);
      const after = await queue.claim("test-worker", 1);
      expect(after.length).toBe(0);
    });
  }, 30_000);
});
