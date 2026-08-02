import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  COMPANELLA_RECOMPUTE_JOB,
  ensureCompanellaRecomputeSeeded,
  recomputeCompanellaChunk,
  runCompanellaRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-companella-sweep-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// The sweep reads only classification_json, so the fixture is just the two
// values Mixed's Companella gate is a function of, plus the key count.
async function seedAnalyzedChart(
  db: Db,
  beatmapId: number,
  options: { lnRatio: number; sunnySr: number | null; keyCount?: number; status?: string } ,
): Promise<void> {
  const now = new Date().toISOString();
  const classification = { keyCount: options.keyCount ?? 4, lnRatio: options.lnRatio, sunnySr: options.sunnySr };
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, classification_json, computed_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      options.status ?? "ready",
      options.keyCount ?? 4,
      JSON.stringify(classification),
      now,
      now,
    ],
  );
}

describe("Companella recompute sweep", () => {
  it("selects exactly the charts Mixed would hand to Companella", async () => {
    const db = await makeDb();

    // In band: 4K, mode tag is not RC (lnRatio > 0.15), under 9 Sunny stars.
    await seedAnalyzedChart(db, 1, { lnRatio: 0.38, sunnySr: 5.5 });
    await seedAnalyzedChart(db, 2, { lnRatio: 0.92, sunnySr: 8.99 });

    // lnRatio at/below 0.15 makes the mode tag RC, which never plans Companella.
    await seedAnalyzedChart(db, 3, { lnRatio: 0.15, sunnySr: 5.5 });
    await seedAnalyzedChart(db, 4, { lnRatio: 0.02, sunnySr: 5.5 });

    // 9 stars and above takes the Daniel branch instead.
    await seedAnalyzedChart(db, 5, { lnRatio: 0.5, sunnySr: 9 });
    await seedAnalyzedChart(db, 6, { lnRatio: 0.5, sunnySr: 12.4 });

    // Companella is 4K only.
    await seedAnalyzedChart(db, 7, { lnRatio: 0.5, sunnySr: 5.5, keyCount: 7 });
    await seedAnalyzedChart(db, 8, { lnRatio: 0.5, sunnySr: 5.5, keyCount: 6 });

    // A null Sunny star means Mixed produced no verdict, so no plan either.
    await seedAnalyzedChart(db, 9, { lnRatio: 0.5, sunnySr: null });

    // Rows that never completed carry no verdict to correct.
    await seedAnalyzedChart(db, 10, { lnRatio: 0.5, sunnySr: 5.5, status: "unavailable" });

    const result = await recomputeCompanellaChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.changed).toEqual([1, 2]);
  });

  it("pages through with the cursor instead of re-scanning", async () => {
    const db = await makeDb();
    for (let id = 1; id <= 5; id++) await seedAnalyzedChart(db, id, { lnRatio: 0.4, sunnySr: 5 });

    const first = await recomputeCompanellaChunk(db, 0, 2);
    expect(first.changed).toEqual([1, 2]);
    expect(first.done).toBe(false);

    const second = await recomputeCompanellaChunk(db, first.nextCursor, 2);
    expect(second.changed).toEqual([3, 4]);
    expect(second.done).toBe(false);

    const third = await recomputeCompanellaChunk(db, second.nextCursor, 2);
    expect(third.changed).toEqual([5]);
    expect(third.done).toBe(true);
  });

  it("runs once: re-enqueues analysis for matched charts, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, { lnRatio: 0.4, sunnySr: 5 });
    const queue = new JobQueue(db);

    await ensureCompanellaRecomputeSeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(COMPANELLA_RECOMPUTE_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === COMPANELLA_RECOMPUTE_JOB) {
        await runCompanellaRecomputeJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }

    // The matched chart got a full re-analysis queued behind the sweep.
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);

    // Done marker written, so a restart does not sweep again.
    const done = (await exec(db, "select 1 from live_meta where key = ?", ["companella_recompute_done:v1"])).rows[0];
    expect(done).toBeTruthy();

    await ensureCompanellaRecomputeSeeded(db, queue);
    const after = await queue.claim("test-worker", 1);
    expect(after.length).toBe(0);
  });
});
