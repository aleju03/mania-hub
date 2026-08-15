import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  MSD_POISON_RECOVERY_JOB,
  ensureMsdPoisonRecoverySeeded,
  recomputeMsdPoisonChunk,
  runMsdPoisonRecoveryJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-msd-poison-sweep-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// The poisoned instance's resting floor: every skillset identical. Healthy
// MinaCalc output never has Stream, Chordjack and Technical exactly equal.
const POISONED_MSD = {
  values: {
    Stream: 9.625999450683594,
    Jumpstream: 9.625999450683594,
    Handstream: 9.625999450683594,
    Stamina: 7.187958240509033,
    JackSpeed: 9.625999450683594,
    Chordjack: 9.625999450683594,
    Technical: 9.625999450683594,
    Overall: 10.156500816345215,
  },
};

const HEALTHY_MSD = {
  values: {
    Stream: 26.26,
    Jumpstream: 23.38,
    Handstream: 23.86,
    Stamina: 28.67,
    JackSpeed: 15.86,
    Chordjack: 20.18,
    Technical: 28.54,
    Overall: 29.09,
  },
};

async function seedAnalyzedChart(
  db: Db,
  beatmapId: number,
  options: {
    status?: string;
    version?: number;
    msd?: object | null;
    msdLn?: object | null;
    msdDt?: object | null;
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, classification_json, msd_json, msd_ln_json, msd_dt_json, dan_dt_json, computed_at, updated_at)
     values (?, ?, ?, 4, ?, ?, ?, ?, ?, ?, ?)`,
    [
      beatmapId,
      options.version ?? CHART_ANALYSIS_VERSION,
      options.status ?? "ready",
      JSON.stringify({ keyCount: 4 }),
      options.msd === undefined ? JSON.stringify(HEALTHY_MSD) : options.msd ? JSON.stringify(options.msd) : null,
      options.msdLn ? JSON.stringify(options.msdLn) : null,
      options.msdDt ? JSON.stringify(options.msdDt) : null,
      options.msdDt ? JSON.stringify({ primaryLabel: "5", primaryFamily: "dan", rawDan: 5 }) : null,
      now,
      now,
    ],
  );
}

describe("MSD poisoning recovery sweep", () => {
  it("selects only rows whose base or LN-tail MSD carries the floor signature", async () => {
    const db = await makeDb();

    await seedAnalyzedChart(db, 1, { msd: POISONED_MSD });
    await seedAnalyzedChart(db, 2, { msd: HEALTHY_MSD });
    // The LN-tail pass ran on a poisoned instance while the base pass was
    // still healthy (a job straddling the poisoning moment).
    await seedAnalyzedChart(db, 3, { msd: HEALTHY_MSD, msdLn: POISONED_MSD });
    // Charts MinaCalc never rated carry no values to match on.
    await seedAnalyzedChart(db, 4, { msd: null });
    // Non-ready rows and other analysis versions are not served anywhere.
    await seedAnalyzedChart(db, 5, { msd: POISONED_MSD, status: "failed" });
    await seedAnalyzedChart(db, 6, { msd: POISONED_MSD, version: CHART_ANALYSIS_VERSION + 1 });

    const result = await recomputeMsdPoisonChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.changed).toEqual([1, 3]);
    expect(result.dtRecomputed).toEqual([]);
  });

  it("redoes only the DT columns for a row whose DT MSD is poisoned, without a full re-analysis", async () => {
    const db = await makeDb();

    // Healthy base pass, poisoned 1.5x mint: full re-analysis would preserve
    // the junk DT columns, so the sweep must repair them itself.
    await seedAnalyzedChart(db, 1, { msd: HEALTHY_MSD, msdDt: POISONED_MSD });
    await seedAnalyzedChart(db, 2, { msd: HEALTHY_MSD, msdDt: HEALTHY_MSD });

    const result = await recomputeMsdPoisonChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.dtRecomputed).toEqual([1]);

    // No cached .osu in this DB, so the mint cannot re-rate the chart: the
    // junk columns are nulled, which the DT feasibility gate reads as no data.
    const row = (await exec(
      db,
      "select msd_dt_json, dan_dt_json from beatmap_chart_analysis where beatmap_id = 1",
    )).rows[0];
    expect(row?.msd_dt_json).toBeNull();
    expect(row?.dan_dt_json).toBeNull();

    const untouched = (await exec(
      db,
      "select msd_dt_json from beatmap_chart_analysis where beatmap_id = 2",
    )).rows[0];
    expect(untouched?.msd_dt_json).toBeTruthy();
  });

  it("handles a row poisoned in both the base and DT columns with one pass", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, { msd: POISONED_MSD, msdDt: POISONED_MSD });

    const result = await recomputeMsdPoisonChunk(db, 0, 50);
    expect(result.changed).toEqual([1]);
    expect(result.dtRecomputed).toEqual([1]);
  });

  it("pages through with the cursor instead of re-scanning", async () => {
    const db = await makeDb();
    for (let id = 1; id <= 5; id++) await seedAnalyzedChart(db, id, { msd: POISONED_MSD });

    const first = await recomputeMsdPoisonChunk(db, 0, 2);
    expect(first.changed).toEqual([1, 2]);
    expect(first.done).toBe(false);

    const second = await recomputeMsdPoisonChunk(db, first.nextCursor, 2);
    expect(second.changed).toEqual([3, 4]);
    expect(second.done).toBe(false);

    const third = await recomputeMsdPoisonChunk(db, second.nextCursor, 2);
    expect(third.changed).toEqual([5]);
    expect(third.done).toBe(true);
  });

  it("seeding cleans the incident window's junk dan estimates and skill ratings, keeping everything outside it", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    const inWindow = "2026-08-15T00:00:00.000Z";
    const preWindow = "2026-08-10T00:00:00.000Z";
    const postSeed = new Date(Date.now() + 3_600_000).toISOString();

    const seedDanEstimate = (beatmapId: number, version: number, computedAt: string) => exec(
      db,
      `insert into dan_estimates
         (estimator_version, beatmap_id, rate_percent, status, label, display_name, computed_at, updated_at)
       values (?, ?, 100, 'ready', 'alpha', 'alpha+', ?, ?)`,
      [version, beatmapId, computedAt, computedAt],
    );
    await seedDanEstimate(1, 13, inWindow);
    await seedDanEstimate(2, 13, preWindow);
    await seedDanEstimate(3, 12, inWindow);

    const seedSkillRating = (userId: number, updatedAt: string) => exec(
      db,
      "insert into player_skill_ratings (user_id, analysis_version, status, updated_at) values (?, 1, 'ready', ?)",
      [userId, updatedAt],
    );
    await seedSkillRating(10, inWindow);
    await seedSkillRating(11, preWindow);
    await seedSkillRating(12, postSeed);

    await ensureMsdPoisonRecoverySeeded(db, queue);

    const danRows = (await exec(db, "select beatmap_id from dan_estimates order by beatmap_id")).rows;
    expect(danRows.map((row) => Number(row.beatmap_id))).toEqual([2, 3]);
    const skillRows = (await exec(db, "select user_id from player_skill_ratings order by user_id")).rows;
    expect(skillRows.map((row) => Number(row.user_id))).toEqual([11, 12]);
  });

  it("runs once: re-enqueues analysis per poisoned chart, rebuilds collections, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, { msd: POISONED_MSD });
    await seedAnalyzedChart(db, 2, { msd: HEALTHY_MSD });
    const queue = new JobQueue(db);

    await ensureMsdPoisonRecoverySeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(MSD_POISON_RECOVERY_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === MSD_POISON_RECOVERY_JOB) {
        await runMsdPoisonRecoveryJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }

    // Only the poisoned chart got a full re-analysis queued, and the dan
    // collections rebuild rides the finish.
    expect(seenTypes.filter((type) => type === CHART_ANALYSIS_JOB)).toHaveLength(1);
    expect(seenTypes).toContain("rebuild_map_collections");

    // Done marker written, so a restart does not sweep again.
    const done = (await exec(db, "select 1 from live_meta where key = ?", ["msd_poison_recovery_done:v1"])).rows[0];
    expect(done).toBeTruthy();

    await ensureMsdPoisonRecoverySeeded(db, queue);
    const after = await queue.claim("test-worker", 1);
    expect(after.length).toBe(0);
  });
});
