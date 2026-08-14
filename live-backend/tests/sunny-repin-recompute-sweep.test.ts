import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  SUNNY_REPIN_RECOMPUTE_JOB,
  ensureSunnyRepinRecomputeSeeded,
  recomputeSunnyRepinChunk,
  runSunnyRepinRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-sunny-repin-sweep-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function seedAnalyzedChart(
  db: Db,
  beatmapId: number,
  options: { keyCount?: number; status?: string; version?: number } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, classification_json, computed_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      beatmapId,
      options.version ?? CHART_ANALYSIS_VERSION,
      options.status ?? "ready",
      options.keyCount ?? 4,
      JSON.stringify({ keyCount: options.keyCount ?? 4 }),
      now,
      now,
    ],
  );
}

describe("Sunny re-pin recompute sweep", () => {
  it("selects every ready row at the current version, regardless of keymode", async () => {
    const db = await makeDb();

    // The SR change touches every chart, so all ready rows are in band.
    await seedAnalyzedChart(db, 1);
    await seedAnalyzedChart(db, 2, { keyCount: 7 });
    await seedAnalyzedChart(db, 3, { keyCount: 6 });

    // Rows that never completed carry no verdict to refresh.
    await seedAnalyzedChart(db, 4, { status: "unavailable" });
    await seedAnalyzedChart(db, 5, { status: "failed" });

    // Rows from another analysis version are not served anywhere.
    await seedAnalyzedChart(db, 6, { version: CHART_ANALYSIS_VERSION + 1 });

    const result = await recomputeSunnyRepinChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.changed).toEqual([1, 2, 3]);
  });

  it("pages through with the cursor instead of re-scanning", async () => {
    const db = await makeDb();
    for (let id = 1; id <= 5; id++) await seedAnalyzedChart(db, id);

    const first = await recomputeSunnyRepinChunk(db, 0, 2);
    expect(first.changed).toEqual([1, 2]);
    expect(first.done).toBe(false);

    const second = await recomputeSunnyRepinChunk(db, first.nextCursor, 2);
    expect(second.changed).toEqual([3, 4]);
    expect(second.done).toBe(false);

    const third = await recomputeSunnyRepinChunk(db, second.nextCursor, 2);
    expect(third.changed).toEqual([5]);
    expect(third.done).toBe(true);
  });

  it("runs once: re-enqueues analysis per chart, rebuilds collections, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1);
    const queue = new JobQueue(db);

    await ensureSunnyRepinRecomputeSeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(SUNNY_REPIN_RECOMPUTE_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === SUNNY_REPIN_RECOMPUTE_JOB) {
        await runSunnyRepinRecomputeJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }

    // The chart got a full re-analysis queued behind the sweep, and the dan
    // collections rebuild rides the finish.
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);
    expect(seenTypes).toContain("rebuild_map_collections");

    // Done marker written, so a restart does not sweep again.
    const done = (await exec(db, "select 1 from live_meta where key = ?", ["sunny_repin_recompute_done:v1"])).rows[0];
    expect(done).toBeTruthy();

    await ensureSunnyRepinRecomputeSeeded(db, queue);
    const after = await queue.claim("test-worker", 1);
    expect(after.length).toBe(0);
  });
});
