import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_VERSION,
  VIBRO_RECOMPUTE_JOB,
  ensureVibroRecomputeSeeded,
  recomputeVibroChunk,
  runVibroRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-vibro-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// 4K mania chart: one hold per row, columns cycling, rows `gapMs` apart. Tight
// gaps (20ms) model staggered LN vibro; 100ms models a legit dense LN chart.
function buildLnOsuFile(rowCount: number, gapMs: number): string {
  const columnsX = [64, 192, 320, 448];
  const notes: string[] = [];
  for (let index = 0; index < rowCount; index++) {
    const time = 1000 + index * gapMs;
    notes.push(`${columnsX[index % 4]},192,${time},128,0,${time + 150}:0:0:0:0:`);
  }
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Vibro Test
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

async function seedAnalyzedChart(db: Db, beatmapId: number, gapMs: number): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  await exec(
    db,
    `insert into beatmap_osu_files (beatmap_id, content, fetched_at, last_used_at)
     values (?, ?, ?, ?)`,
    [beatmapId, buildLnOsuFile(400, gapMs), now, now],
  );
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, classification_json, computed_at, updated_at)
     values (?, ?, 'ready', 4, ?, ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, json({ lnRatio: 0.9, vibro: false }), now, now],
  );
  await exec(
    db,
    `insert into map_search_index
       (beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version, search_text,
        key_count, stars, bpm, length, status, primary_pattern, updated_at)
     values (?, ?, 1, 'Vibro Test', 'Test', 'Mapper', '4K', 'vibro test', 4, 5, 180, 60, 'graveyard', 'ln', ?)`,
    [beatmapId, beatmapId * 10, now],
  );
}

describe("vibro recompute sweep", () => {
  it("flags staggered LN spam and patches analysis + index, leaving legit LN charts alone", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, 20); // vibro: 20ms staggered hold rows
    await seedAnalyzedChart(db, 2, 100); // legit: 100ms rows

    const result = await recomputeVibroChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.flagged).toEqual([1]);

    const flags = (await exec(
      db,
      `select a.beatmap_id as id, json_extract(a.classification_json, '$.vibro') as vibro, i.vibro as indexed
       from beatmap_chart_analysis a join map_search_index i on i.beatmap_id = a.beatmap_id
       order by a.beatmap_id`,
    )).rows;
    expect(flags.map((row) => [Number(row.id), Number(row.vibro), Number(row.indexed)])).toEqual([
      [1, 1, 1],
      [2, 0, 0],
    ]);
  });

  it("runs once: the seeded job chain marks itself done and never re-seeds on later boots", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, 20);
    const queue = new JobQueue(db);

    await ensureVibroRecomputeSeeded(db, queue);
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(VIBRO_RECOMPUTE_JOB);
    // Drive the chain to completion like the worker lane would.
    while (job) {
      await runVibroRecomputeJob(db, queue, job.payload as { cursor?: number });
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureVibroRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [VIBRO_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
