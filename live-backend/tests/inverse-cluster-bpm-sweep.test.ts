import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  INVERSE_CLUSTER_BPM_JOB,
  ensureInverseClusterBpmRecoverySeeded,
  recomputeInverseClusterBpmChunk,
  runInverseClusterBpmRecoveryJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-inverse-cluster-sweep-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// The bug's stored shape: a mixed Density cluster whose BPM was inflated by
// averaging inverse windows' zero-tempo sentinel into the pool.
const INFLATED_CLUSTER = { label: "~1327BPM Mixed Inverse", pattern: "Density", bpm: 1327, mixed: true, amount: 56844, importance: 113147982 };
const HEALTHY_DENSITY_CLUSTER = { label: "148BPM DCS Density", pattern: "Density", bpm: 148, mixed: false, amount: 58922, importance: 7848410 };
const MIXED_CHORDSTREAM_CLUSTER = { label: "~148BPM Mixed Jumpstream", pattern: "Chordstream", bpm: 148, mixed: true, amount: 40000, importance: 5000000 };
const SENTINEL_CLUSTER = { label: "~0BPM Mixed Inverse", pattern: "Density", bpm: 0, mixed: true, amount: 56844, importance: 0 };

async function seedAnalyzedChart(
  db: Db,
  beatmapId: number,
  clusters: object[] | null,
  options: { status?: string; version?: number } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, classification_json, computed_at, updated_at)
     values (?, ?, ?, 7, ?, ?, ?)`,
    [
      beatmapId,
      options.version ?? CHART_ANALYSIS_VERSION,
      options.status ?? "ready",
      JSON.stringify({ keyCount: 7, clusters: clusters ?? [] }),
      now,
      now,
    ],
  );
}

describe("inverse cluster BPM recovery sweep", () => {
  it("selects only rows whose mixed Density cluster stored a nonzero BPM", async () => {
    const db = await makeDb();

    await seedAnalyzedChart(db, 1, [INFLATED_CLUSTER, HEALTHY_DENSITY_CLUSTER]);
    await seedAnalyzedChart(db, 2, [HEALTHY_DENSITY_CLUSTER]);
    await seedAnalyzedChart(db, 3, [MIXED_CHORDSTREAM_CLUSTER]);
    // An all-sentinel pool already stored BPM 0; the fix changes nothing there.
    await seedAnalyzedChart(db, 4, [SENTINEL_CLUSTER]);
    await seedAnalyzedChart(db, 5, null);
    // Non-ready rows and other analysis versions are not served anywhere.
    await seedAnalyzedChart(db, 6, [INFLATED_CLUSTER], { status: "failed" });
    await seedAnalyzedChart(db, 7, [INFLATED_CLUSTER], { version: CHART_ANALYSIS_VERSION + 1 });

    const result = await recomputeInverseClusterBpmChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.changed).toEqual([1]);
  });

  it("pages through with the cursor instead of re-scanning", async () => {
    const db = await makeDb();
    for (let id = 1; id <= 5; id++) await seedAnalyzedChart(db, id, [INFLATED_CLUSTER]);

    const first = await recomputeInverseClusterBpmChunk(db, 0, 2);
    expect(first.changed).toEqual([1, 2]);
    expect(first.done).toBe(false);

    const second = await recomputeInverseClusterBpmChunk(db, first.nextCursor, 2);
    expect(second.changed).toEqual([3, 4]);
    expect(second.done).toBe(false);

    const third = await recomputeInverseClusterBpmChunk(db, second.nextCursor, 2);
    expect(third.changed).toEqual([5]);
    expect(third.done).toBe(true);
  });

  it("runs once: re-enqueues analysis per affected chart, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, [INFLATED_CLUSTER]);
    await seedAnalyzedChart(db, 2, [HEALTHY_DENSITY_CLUSTER]);
    const queue = new JobQueue(db);

    await ensureInverseClusterBpmRecoverySeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(INVERSE_CLUSTER_BPM_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === INVERSE_CLUSTER_BPM_JOB) {
        await runInverseClusterBpmRecoveryJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }

    // Only the inflated chart gets a re-analysis; cluster BPM feeds no dan
    // collection bucket, so no collections rebuild rides the finish.
    expect(seenTypes.filter((type) => type === CHART_ANALYSIS_JOB)).toHaveLength(1);
    expect(seenTypes).not.toContain("rebuild_map_collections");

    const done = (await exec(db, "select 1 from live_meta where key = ?", ["inverse_cluster_bpm_recovery_done:v1"])).rows[0];
    expect(done).toBeTruthy();

    await ensureInverseClusterBpmRecoverySeeded(db, queue);
    const after = await queue.claim("test-worker", 1);
    expect(after.length).toBe(0);
  });
});
