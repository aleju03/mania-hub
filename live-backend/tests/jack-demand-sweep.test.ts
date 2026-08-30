import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, parseJson, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_VERSION,
  JACK_DEMAND_RECOMPUTE_JOB,
  JACK_DEMAND_RECOMPUTE_META_KEY,
  ensureJackDemandRecomputeSeeded,
  recomputeJackDemandChunk,
  runJackDemandRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-jack-demand-"));
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

describe("4K Jack-demand recompute sweep", () => {
  it("patches a dense alternating-chord chart and leaves an ordinary roll negative", async () => {
    const db = await makeDb();
    // A-B-A-B chords: adjacent rows share a column, while two rows apart
    // reload both fingers. This is the structural arm the sweep backfills.
    await seedChart(db, 1, build4kOsuFile([[0, 1], [1, 2]], "Alternating chords"));
    await seedChart(db, 2, build4kOsuFile([[0], [1], [2], [3]], "Roll control"));

    const result = await recomputeJackDemandChunk(db, 0, 50);
    expect(result).toMatchObject({ scanned: 2, changed: 1, done: true });

    const rows = (await exec(
      db,
      "select beatmap_id, classification_json from beatmap_chart_analysis order by beatmap_id",
      [],
    )).rows;
    const positive = parseJson<{ jackDemand?: { detected?: boolean; reasons?: string[] } }>(String(rows[0].classification_json), {});
    const control = parseJson<{ jackDemand?: unknown }>(String(rows[1].classification_json), {});
    expect(positive.jackDemand).toMatchObject({ detected: true, reasons: ["dense_alternating_chords"] });
    expect(control.jackDemand).toBeUndefined();
    db.close();
  });

  it("self-chains once, stamps its dependency marker, and does not reseed", async () => {
    const db = await makeDb();
    await seedChart(db, 1, build4kOsuFile([[0, 1], [1, 2]], "Alternating chords"));
    const queue = new JobQueue(db);

    await ensureJackDemandRecomputeSeeded(db, queue);
    const [job] = await queue.claim("test-worker", 1, { types: [JACK_DEMAND_RECOMPUTE_JOB] });
    expect(job?.type).toBe(JACK_DEMAND_RECOMPUTE_JOB);
    expect(await runJackDemandRecomputeJob(db, queue, job?.payload as { cursor?: number })).toBe(true);
    await queue.complete(job!.id);

    const done = (await exec(db, "select 1 from live_meta where key = ?", [JACK_DEMAND_RECOMPUTE_META_KEY])).rows[0];
    expect(done).toBeTruthy();
    await ensureJackDemandRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [JACK_DEMAND_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending.count)).toBe(0);
    db.close();
  });
});
