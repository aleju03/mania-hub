import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  DAN_FLOOR_PIN_RECOMPUTE_JOB,
  ensureDanFloorPinRecomputeSeeded,
  recomputeDanFloorPinChunk,
  runDanFloorPinRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-floor-pin-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// 4K rice chart of `count` taps `gapMs` apart. 500ms gaps (~2 nps) model the
// trivial ranked-Easy shape whose Roxy raw signal pins at the scale floor;
// 115ms rolls model an on-scale chart.
function buildRiceOsuFile(count: number, gapMs: number, columns = 2): string {
  const columnsX = [64, 192, 320, 448];
  const notes = Array.from(
    { length: count },
    (_, index) => `${columnsX[index % columns]},192,${1000 + index * gapMs},1,0,0:0:0:0:`,
  );
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Floor Pin Test
Artist: Test
Creator: Mapper
Version: 4K

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes.join("\n")}
`;
}

async function seedAnalyzedChart(db: Db, beatmapId: number, osuText: string, rawDan: number): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  await exec(
    db,
    `insert into beatmap_osu_files (beatmap_id, content, fetched_at, last_used_at)
     values (?, ?, ?, ?)`,
    [beatmapId, osuText, now, now],
  );
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, computed_at, updated_at)
     values (?, ?, 'ready', 4, '4-', 'dan', ?, ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, rawDan, now, now],
  );
}

describe("dan floor-pin recompute sweep", () => {
  it("flags stored verdicts whose Roxy raw signal is pinned, leaving on-scale charts alone", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, buildRiceOsuFile(130, 500), 3.73); // pinned trivial Easy
    await seedAnalyzedChart(db, 2, buildRiceOsuFile(780, 115, 4), 4.5); // on-scale chart
    await seedAnalyzedChart(db, 3, buildRiceOsuFile(130, 500), 8); // outside the candidate band

    const result = await recomputeDanFloorPinChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.pinned).toEqual([1]);
  });

  it("runs once: re-enqueues analysis for pinned charts, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, buildRiceOsuFile(130, 500), 3.73);
    const queue = new JobQueue(db);

    await ensureDanFloorPinRecomputeSeeded(db, queue);
    // Drive the chain like the worker lane would. The sweep re-enqueues the
    // full analysis job for the pinned chart and a collections rebuild at the
    // end; this loop only completes those, never runs them.
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(DAN_FLOOR_PIN_RECOMPUTE_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === DAN_FLOOR_PIN_RECOMPUTE_JOB) {
        await runDanFloorPinRecomputeJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);
    expect(seenTypes).toContain("rebuild_map_collections");

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureDanFloorPinRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [DAN_FLOOR_PIN_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
