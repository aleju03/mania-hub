import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { analyzeManiaPatterns } from "../src/dan/dan-estimator/patterns.js";
import {
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  JACK_TAG_RECOMPUTE_JOB,
  ensureJackTagRecomputeSeeded,
  recomputeJackTagChunk,
  runJackTagRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-jack-tag-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

function build7kOsuFile(pattern: number[][], title: string, intervalMs = 100, repeats = 60): string {
  const rows: string[] = [];
  for (let cycle = 0; cycle < repeats; cycle += 1) {
    pattern.forEach((columns, index) => {
      const time = 1000 + (cycle * pattern.length + index) * intervalMs;
      for (const column of columns) {
        const x = Math.floor(((column + 0.5) * 512) / 7);
        rows.push(`${x},192,${time},1,0,0:0:0:0:`);
      }
    });
  }
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: ${title}
Artist: Test
Creator: Mapper
Version: 7K

[Difficulty]
CircleSize:7
OverallDifficulty:8

[TimingPoints]
0,400,4,2,0,100,1,0

[HitObjects]
${rows.join("\n")}
`;
}

// A strict two-set chord trill ([12][45][12][45]...): the Ningen Shikkaku
// shape. Zero repeated chords (chordjack blind), zero consecutive-row column
// re-hits, but wall-to-wall two-row alternation - exactly the stale-corpus
// shape this sweep exists to backfill a jack tag onto.
function buildTrillOsuFile(): string {
  return build7kOsuFile([[1, 2], [4, 5]], "Trill Sweep Test");
}

// Rolls that never re-hit a column within two rows: no jack under any arm.
function buildRollOsuFile(): string {
  return build7kOsuFile([[0], [2], [4], [6], [1], [3], [5]], "Roll Sweep Test");
}

interface SeedOptions {
  category?: string | null;
  patternIds?: string[];
  keyCount?: number;
}

async function seedAnalyzedChart(db: Db, beatmapId: number, osuText: string, options: SeedOptions = {}): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  const classification = {
    lnRatio: 0,
    category: options.category ?? "Tech",
    patterns: (options.patternIds ?? ["tech"]).map((id) => ({ id, label: id, score: 0.8, confidence: 0.4 })),
  };
  await exec(
    db,
    `insert into beatmap_osu_files (beatmap_id, content, fetched_at, last_used_at)
     values (?, ?, ?, ?)`,
    [beatmapId, osuText, now, now],
  );
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, classification_json, computed_at, updated_at)
     values (?, ?, 'ready', ?, '4-', 'tech', 4, ?, ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, options.keyCount ?? 7, JSON.stringify(classification), now, now],
  );
}

function freshAnalysis(osuText: string) {
  const map = parseManiaBeatmap(osuText);
  return analyzeManiaPatterns(map, {
    totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
    version: map.version,
  });
}

describe("jack tag recompute sweep", () => {
  it("flags stored verdicts the single-note jack detector changes, skips in-sync ones", async () => {
    const db = await makeDb();
    const trillText = buildTrillOsuFile();
    const rollText = buildRollOsuFile();

    // Stale verdict from before the detector: a trill chart stored as tech.
    await seedAnalyzedChart(db, 1, trillText, { patternIds: ["tech", "chordstream"], category: "Tech" });

    // In-sync control: a roll chart whose stored verdict matches today's.
    const freshRoll = freshAnalysis(rollText);
    await seedAnalyzedChart(db, 2, rollText, {
      patternIds: freshRoll.patterns.map((hit) => hit.id),
      category: freshRoll.primary?.label ?? null,
    });

    // Outside the scan: 4K rows keep their native analyzer vocabulary.
    await seedAnalyzedChart(db, 3, trillText, { patternIds: ["tech"], keyCount: 4 });

    const result = await recomputeJackTagChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.changed).toEqual([1]);
    // Sanity on the fixtures: the fresh analyzer tags the trill chart jack
    // and leaves the roll chart without one.
    expect(freshAnalysis(trillText).patterns.map((hit) => hit.id)).toContain("jack");
    expect(freshRoll.patterns.map((hit) => hit.id)).not.toContain("jack");
  });

  it("runs once: re-enqueues analysis for changed charts, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, buildTrillOsuFile(), { patternIds: ["tech", "chordstream"] });
    const queue = new JobQueue(db);

    await ensureJackTagRecomputeSeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(JACK_TAG_RECOMPUTE_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === JACK_TAG_RECOMPUTE_JOB) {
        await runJackTagRecomputeJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureJackTagRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [JACK_TAG_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
