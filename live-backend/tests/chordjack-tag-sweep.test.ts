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
  CHORDJACK_TAG_RECOMPUTE_JOB,
  ensureChordjackTagRecomputeSeeded,
  recomputeChordjackTagChunk,
  runChordjackTagRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-chordjack-tag-"));
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

// Every row is a hand chord but consecutive chords never share a column:
// the density-only chordjack detector used to tag this shape, the
// overlap-gated one must not - exactly the stale-corpus shape this sweep
// exists to fix.
function buildBracketOsuFile(): string {
  return build7kOsuFile([[0, 1, 2], [4, 5, 6], [1, 2, 3], [4, 5, 6]], "Bracket Sweep Test");
}

// Consecutive chords re-hit their columns: chordjack under both detectors.
function buildChordjackOsuFile(): string {
  return build7kOsuFile([[0, 2, 4], [0, 2, 4], [1, 3, 5], [1, 3, 5]], "Chordjack Sweep Test");
}

interface SeedOptions {
  category?: string | null;
  patternIds?: string[];
}

async function seedAnalyzedChart(db: Db, beatmapId: number, osuText: string, options: SeedOptions = {}): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  const classification = {
    lnRatio: 0,
    category: options.category ?? "Chordjack",
    patterns: (options.patternIds ?? ["chordjack"]).map((id) => ({ id, label: id, score: 0.8, confidence: 0.4 })),
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
     values (?, ?, 'ready', 7, '4-', 'jack', 4, ?, ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify(classification), now, now],
  );
}

function freshAnalysis(osuText: string) {
  const map = parseManiaBeatmap(osuText);
  return analyzeManiaPatterns(map, {
    totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
    version: map.version,
  });
}

describe("chordjack tag recompute sweep", () => {
  it("flags density-minted chordjack tags and keeps true chordjack verdicts", async () => {
    const db = await makeDb();
    const bracketText = buildBracketOsuFile();
    const chordjackText = buildChordjackOsuFile();

    // Stale verdict from the density-only detector on a bracket file.
    await seedAnalyzedChart(db, 1, bracketText, { patternIds: ["chordjack", "bracket"], category: "Chordjack" });

    // In-sync control: a true chordjack chart stored with today's verdict.
    const freshCj = freshAnalysis(chordjackText);
    await seedAnalyzedChart(db, 2, chordjackText, {
      patternIds: freshCj.patterns.map((hit) => hit.id),
      category: freshCj.primary?.label ?? null,
    });

    // Outside the candidate band: never tagged chordjack, not scanned.
    await seedAnalyzedChart(db, 3, bracketText, { patternIds: ["bracket"], category: "Bracket" });

    const result = await recomputeChordjackTagChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.changed).toEqual([1]);
    // Sanity on the fixtures: the fresh analyzer keeps chordjack on the true
    // chordjack chart and refuses it on the bracket one.
    expect(freshCj.patterns.map((hit) => hit.id)).toContain("chordjack");
    expect(freshAnalysis(bracketText).patterns.map((hit) => hit.id)).not.toContain("chordjack");
  });

  it("runs once: re-enqueues analysis for changed charts, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, buildBracketOsuFile(), { patternIds: ["chordjack", "bracket"] });
    const queue = new JobQueue(db);

    await ensureChordjackTagRecomputeSeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(CHORDJACK_TAG_RECOMPUTE_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === CHORDJACK_TAG_RECOMPUTE_JOB) {
        await runChordjackTagRecomputeJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureChordjackTagRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [CHORDJACK_TAG_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
