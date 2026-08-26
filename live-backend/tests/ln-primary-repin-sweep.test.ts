import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  LN_PRIMARY_REPIN_JOB,
  ensureLnPrimaryRepinSeeded,
  recomputeLnPrimaryRepinChunk,
  runLnPrimaryRepinJob,
} from "../src/features/chart-analysis.js";
import { LN_PRIMARY_MIN_RATIO } from "../src/dan/dan-estimator/ln.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-ln-repin-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// A stored analysis as the classifier wrote it under the old 0.5 routing line:
// the rice half is primary, and the LN half rides along in the JSON unless the
// chart never got one.
async function seedAnalyzedChart(
  db: Db,
  beatmapId: number,
  lnRatio: number,
  options: { lnHalf?: boolean; primaryFamily?: string } = {},
): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  const classification = {
    lnRatio,
    rc: { displayName: "9--", kind: "rc", rawDan: 8.6 },
    ln: options.lnHalf === false ? null : { displayName: "9", kind: "ln", rawDan: 9 },
    primary: { displayName: "9--", kind: "rc", rawDan: 8.6 },
  };
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, primary_label, primary_family,
        raw_dan, classification_json, computed_at, updated_at)
     values (?, ?, 'ready', 7, '9--', ?, 8.6, ?, ?, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      options.primaryFamily ?? "dan",
      JSON.stringify(classification),
      now,
      now,
    ],
  );
}

describe("LN primary re-pin sweep", () => {
  it("picks up the charts between the old and new routing lines, and nothing else", async () => {
    const db = await makeDb();
    // Legend of Millennium [7K]: LN enough to feed an LN rating, stored rice.
    await seedAnalyzedChart(db, 1, 0.4793);
    // Right on the new line.
    await seedAnalyzedChart(db, 2, LN_PRIMARY_MIN_RATIO);
    // Under it: still a rice chart, nothing to re-pin.
    await seedAnalyzedChart(db, 3, 0.42);
    // Already LN under the old line too.
    await seedAnalyzedChart(db, 4, 0.62, { primaryFamily: "ln" });
    // In the band but with no LN half to route to: re-analyzing would only
    // spend a lane slot on the same rice verdict.
    await seedAnalyzedChart(db, 5, 0.47, { lnHalf: false });

    const result = await recomputeLnPrimaryRepinChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.repinned).toEqual([1, 2]);
    expect(result.dtRewritten).toBe(0);
  });

  it("runs once: re-enqueues analysis for the band, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, 0.4793);
    const queue = new JobQueue(db);

    await ensureLnPrimaryRepinSeeded(db, queue);
    // Drive the chain like the worker lane would: the sweep re-enqueues the
    // full analysis job per chart and a collections rebuild at the end, and
    // this loop only completes those, never runs them.
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(LN_PRIMARY_REPIN_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === LN_PRIMARY_REPIN_JOB) {
        await runLnPrimaryRepinJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);
    expect(seenTypes).toContain("rebuild_map_collections");

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureLnPrimaryRepinSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [LN_PRIMARY_REPIN_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
