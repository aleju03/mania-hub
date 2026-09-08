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
import { localizedVibroFixture } from "./vibro-fixtures.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { prepareVibroChart } from "../src/dan/vibro-sections.js";
import { getRateAdjustedChartAnalysis } from "../src/features/dan-estimates.js";
import { OsuApiClient } from "../src/osu/client.js";

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
  it("restarts an older detector's continuation instead of skipping already-scanned charts", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, 20);
    await runVibroRecomputeJob(db, new JobQueue(db), { cursor: 999, revision: "vibro_recompute_done:v8" });
    const row = (await exec(db, "select classification_json from beatmap_chart_analysis where beatmap_id = 1")).rows[0];
    expect(JSON.parse(String(row.classification_json)).vibro).toBe(true);
  });

  it("restores old false positives and replaces inflated base and rate values with adjusted ratings", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, 100);
    await storeCachedBeatmapFile(db, 1, localizedVibroFixture(), { source: "test" });
    const now = "2026-09-07T00:00:00Z";
    await exec(db, `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, updated_at)
      values (10, 'Test', 'Test', 'Test', 'graveyard', '{}', ?)`, [now]);
    await exec(db, `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, version, metadata_json, updated_at)
      values (1, 10, 'mania', 'graveyard', 4, 5, 'test', '{"total_length":120,"mode":"mania"}', ?)`, [now]);
    await exec(db, `insert into beatmap_skill_vectors (beatmap_id, analysis_version, status, skills_json, updated_at)
      values (1, ?, 'ready', '{"primary":"stream","patterns":{}}', ?)`, [ACTIVITY_SKILL_ANALYSIS_VERSION, now]);
    await exec(db, `update beatmap_chart_analysis set classification_json = '{"lnRatio":0,"vibro":true}',
      msd_json = '{"values":{"Overall":999}}', msd_overall = 999,
      msd_dt_json = '{"values":{"Overall":999}}', dan_dt_json = '{"rawDan":99}' where beatmap_id = 1`);
    await exec(db, "update map_search_index set vibro = 1 where beatmap_id = 1");
    await recomputeVibroChunk(db, 0);
    const row = (await exec(db, "select * from beatmap_chart_analysis where beatmap_id = 1")).rows[0];
    const classification = JSON.parse(String(row.classification_json));
    expect(classification.vibro).toBe(false);
    expect(classification.vibroAnalysis.status).toBe("adjusted");
    expect(Number(row.msd_overall)).toBeLessThan(999);
    const dt = JSON.parse(String(row.msd_dt_json));
    expect(dt.values.Overall).toBeLessThan(999);
    expect(dt.vibroAnalysis.status).toBe("adjusted");
    expect(Number((await exec(db, "select vibro from map_search_index where beatmap_id = 1")).rows[0].vibro)).toBe(0);

    // Arbitrary-rate responses preserve the explanation on cache hits too.
    const osu = { getBeatmapFile: async () => { throw new Error("No network"); } } as unknown as OsuApiClient;
    const fresh = await getRateAdjustedChartAnalysis(db, osu, 1, 1.2);
    const cached = await getRateAdjustedChartAnalysis(db, osu, 1, 1.2);
    expect(fresh?.vibroAnalysis?.status).toBe("adjusted");
    expect(cached).toEqual(fresh);

    // Running again on clean material clears the previous adjustment metadata.
    await storeCachedBeatmapFile(db, 1, prepareVibroChart(localizedVibroFixture()).osuText, { source: "test" });
    await recomputeVibroChunk(db, 0);
    const clean = JSON.parse(String((await exec(db, "select classification_json from beatmap_chart_analysis where beatmap_id = 1")).rows[0].classification_json));
    expect(clean.vibroAnalysis.status).toBe("clean");
  });

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
    // Drive the chain to completion like the worker lane would. Completion also
    // enqueues a collections rebuild (freshly flagged charts must leave the
    // packs) and the player-skill vibro sweep (players holding a play on a
    // freshly flagged chart must re-rate), which this loop only completes.
    const followUps: string[] = [];
    while (job) {
      if (job.type === VIBRO_RECOMPUTE_JOB) {
        await runVibroRecomputeJob(db, queue, job.payload as { cursor?: number });
      } else {
        followUps.push(job.type);
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(followUps.sort()).toEqual(["rebuild_map_collections", "recompute_player_skill_vibro_sweep"]);

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
