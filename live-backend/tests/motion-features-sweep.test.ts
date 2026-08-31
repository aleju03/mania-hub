import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, parseJson, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_VERSION,
  MOTION_FEATURES_RECOMPUTE_JOB,
  MOTION_FEATURES_RECOMPUTE_META_KEY,
  ensureMotionFeaturesRecomputeSeeded,
  recomputeMotionFeaturesChunk,
  runMotionFeaturesRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-motion-features-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

function build4kOsuFile(pattern: number[][], title: string, intervalMs = 150, repeats = 80): string {
  const rows: string[] = [];
  for (let cycle = 0; cycle < repeats; cycle += 1) {
    pattern.forEach((columns, index) => {
      const time = 1000 + (cycle * pattern.length + index) * intervalMs;
      for (const column of columns) {
        const x = Math.floor(((column + 0.5) * 512) / 4);
        rows.push(`${x},192,${time},1,0,0:0:0:0:`);
      }
    });
  }
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title:${title}
Artist:Test
Creator:Mapper
Version:4K

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,600,4,2,0,100,1,0

[HitObjects]
${rows.join("\n")}
`;
}

async function seedChart(db: Db, beatmapId: number, osuText: string): Promise<void> {
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
       (beatmap_id, analysis_version, status, key_count, classification_json, computed_at, updated_at)
     values (?, ?, 'ready', 4, json(?), ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], clusters: [] }), now, now],
  );
}

describe("4K motion feature recompute sweep", () => {
  it("writes a motion block onto a legacy row and tells a trill from a roll", async () => {
    const db = await makeDb();
    await seedChart(db, 1, build4kOsuFile([[0], [1]], "One-hand trill"));
    await seedChart(db, 2, build4kOsuFile([[0], [1], [2], [3]], "Roll control"));

    const result = await recomputeMotionFeaturesChunk(db, 0, 50);
    expect(result).toMatchObject({ scanned: 2, changed: 2, done: true });

    const rows = (await exec(
      db,
      "select beatmap_id, classification_json from beatmap_chart_analysis order by beatmap_id",
      [],
    )).rows;
    const trill = parseJson<{ motion?: Record<string, number> }>(String(rows[0].classification_json), {});
    const roll = parseJson<{ motion?: Record<string, number> }>(String(rows[1].classification_json), {});
    expect(trill.motion?.oneHandTrill).toBeGreaterThan(0.9);
    expect(roll.motion?.oneHandTrill).toBe(0);
    expect(roll.motion?.roll4).toBeGreaterThan(0.2);
    db.close();
  });

  it("leaves a chart it cannot measure without a block, so it reads as unknown", async () => {
    const db = await makeDb();
    // Twelve rows: past the parser but under the sweep's measurable floor.
    await seedChart(db, 1, build4kOsuFile([[0], [1]], "Too short", 150, 6));
    const result = await recomputeMotionFeaturesChunk(db, 0, 50);
    expect(result).toMatchObject({ scanned: 1, changed: 0 });
    const row = (await exec(db, "select classification_json from beatmap_chart_analysis", [])).rows[0];
    expect(parseJson<{ motion?: unknown }>(String(row.classification_json), {}).motion).toBeUndefined();
    db.close();
  });

  it("rewrites nothing on a second pass over an already-measured chart", async () => {
    const db = await makeDb();
    await seedChart(db, 1, build4kOsuFile([[0], [1]], "One-hand trill"));
    expect((await recomputeMotionFeaturesChunk(db, 0, 50)).changed).toBe(1);
    expect((await recomputeMotionFeaturesChunk(db, 0, 50)).changed).toBe(0);
    db.close();
  });

  it("self-chains once, stamps its dependency marker, and does not reseed", async () => {
    const db = await makeDb();
    await seedChart(db, 1, build4kOsuFile([[0], [1]], "One-hand trill"));
    const queue = new JobQueue(db);

    await ensureMotionFeaturesRecomputeSeeded(db, queue);
    const [job] = await queue.claim("test-worker", 1, { types: [MOTION_FEATURES_RECOMPUTE_JOB] });
    expect(job?.type).toBe(MOTION_FEATURES_RECOMPUTE_JOB);
    expect(await runMotionFeaturesRecomputeJob(db, queue, job?.payload as { cursor?: number })).toBe(true);
    await queue.complete(job!.id);

    const done = (await exec(db, "select 1 from live_meta where key = ?", [MOTION_FEATURES_RECOMPUTE_META_KEY])).rows[0];
    expect(done).toBeTruthy();
    await ensureMotionFeaturesRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [MOTION_FEATURES_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending.count)).toBe(0);
    db.close();
  });
});
