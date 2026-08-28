import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  LN7_PRIMARY_REPIN_JOB,
  ensureLn7PrimaryRepinSeeded,
  recomputeLn7PrimaryRepinChunk,
  runLn7PrimaryRepinJob,
} from "../src/features/chart-analysis.js";
import { LN_PRIMARY_7K_MIN_RATIO, LN_PRIMARY_MIN_RATIO, lnPrimaryMinRatioFor } from "../src/dan/dan-estimator/ln.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-ln7-repin-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// A stored analysis as the classifier wrote it under the shared 0.45 line:
// rice primary with the LN half riding along, unless the chart never got one.
async function seedAnalyzedChart(
  db: Db,
  beatmapId: number,
  lnRatio: number,
  options: { lnHalf?: boolean; primaryFamily?: string; keyCount?: number } = {},
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
     values (?, ?, 'ready', ?, '9--', ?, 8.6, ?, ?, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      options.keyCount ?? 7,
      options.primaryFamily ?? "dan",
      JSON.stringify(classification),
      now,
      now,
    ],
  );
}

describe("the 7K identity line", () => {
  it("is 0.375 on 7K and the shared 0.45 everywhere else", () => {
    expect(lnPrimaryMinRatioFor(7)).toBe(LN_PRIMARY_7K_MIN_RATIO);
    expect(lnPrimaryMinRatioFor(4)).toBe(LN_PRIMARY_MIN_RATIO);
    expect(lnPrimaryMinRatioFor(6)).toBe(LN_PRIMARY_MIN_RATIO);
    expect(lnPrimaryMinRatioFor(null)).toBe(LN_PRIMARY_MIN_RATIO);
  });
});

describe("7K LN primary re-pin sweep", () => {
  it("picks up the 7K charts between the two lines, and nothing else", async () => {
    const db = await makeDb();
    // King Atlantis [7K] Abyssal Overlord: the chart that argued for the line.
    await seedAnalyzedChart(db, 1, 0.378);
    // Right on the new line.
    await seedAnalyzedChart(db, 2, LN_PRIMARY_7K_MIN_RATIO);
    // Under it: still a rice chart.
    await seedAnalyzedChart(db, 3, 0.35);
    // At or over the shared line: the 0.5 -> 0.45 sweep's territory, not ours.
    await seedAnalyzedChart(db, 4, 0.46);
    // Already LN.
    await seedAnalyzedChart(db, 5, 0.4, { primaryFamily: "ln" });
    // In the band but no LN half to route to.
    await seedAnalyzedChart(db, 6, 0.4, { lnHalf: false });
    // A 4K chart at the same hold share keeps its rice reading: 7K only.
    await seedAnalyzedChart(db, 7, 0.4, { keyCount: 4 });

    const result = await recomputeLn7PrimaryRepinChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.repinned).toEqual([1, 2]);
    expect(result.dtRewritten).toBe(0);
  });

  it("runs once: re-enqueues analysis for the band, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, 0.4);
    const queue = new JobQueue(db);

    await ensureLn7PrimaryRepinSeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(LN7_PRIMARY_REPIN_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === LN7_PRIMARY_REPIN_JOB) {
        await runLn7PrimaryRepinJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);
    expect(seenTypes).toContain("rebuild_map_collections");

    await ensureLn7PrimaryRepinSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [LN7_PRIMARY_REPIN_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
