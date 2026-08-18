import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { analyzeManiaPatterns } from "../src/dan/dan-estimator/patterns.js";
import {
  BRACKET_TAG_RECOMPUTE_JOB,
  CHART_ANALYSIS_JOB,
  CHART_ANALYSIS_VERSION,
  ensureBracketTagRecomputeSeeded,
  recomputeBracketTagChunk,
  runBracketTagRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-bracket-tag-"));
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

// Every row is a bracket-shaped chord but consecutive chords never share a
// column: the tag the overlap-gated bracket detector must keep.
// Chords that overlap in column range but share no column: bracket content by
// the analyzer's window. Full-hand alternation ([0,1,2] -> [4,5,6]) is not, the
// column ranges never overlap, which makes it a roll.
function buildBracketOsuFile(): string {
  return build7kOsuFile([[0, 1, 3], [2, 4, 5]], "Bracket Tag Sweep Test");
}

// Bracket-shaped rows jacked in place: consecutive chords re-hit their
// columns, so this is chordjack. The shape-only detector used to store a
// saturated bracket tag on it - exactly the stale-corpus verdict this sweep
// exists to fix.
function buildJackedBracketOsuFile(): string {
  return build7kOsuFile([[0, 1, 2], [0, 1, 2], [1, 2, 3], [1, 2, 3]], "Jacked Bracket Sweep Test");
}

interface SeedOptions {
  category?: string | null;
  patternIds?: string[];
}

async function seedAnalyzedChart(db: Db, beatmapId: number, osuText: string, options: SeedOptions = {}): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  const classification = {
    lnRatio: 0,
    category: options.category ?? "Bracket",
    patterns: (options.patternIds ?? ["bracket"]).map((id) => ({ id, label: id, score: 0.8, confidence: 0.4 })),
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

describe("bracket tag recompute sweep", () => {
  it("flags shape-minted bracket tags on jacked chords and keeps true bracket verdicts", async () => {
    const db = await makeDb();
    const bracketText = buildBracketOsuFile();
    const jackedText = buildJackedBracketOsuFile();

    // Stale verdict from the shape-only detector on a chordjack file.
    await seedAnalyzedChart(db, 1, jackedText, { patternIds: ["bracket", "chordjack"], category: "Bracket" });

    // In-sync control: a true bracket chart stored with today's verdict.
    const freshBracket = freshAnalysis(bracketText);
    await seedAnalyzedChart(db, 2, bracketText, {
      patternIds: freshBracket.patterns.map((hit) => hit.id),
      category: freshBracket.primary?.label ?? null,
    });

    // Outside the candidate band: never tagged bracket, not scanned.
    await seedAnalyzedChart(db, 3, jackedText, { patternIds: ["chordjack"], category: "Chordjack" });

    const result = await recomputeBracketTagChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.changed).toEqual([1]);
    // Sanity on the fixtures: the fresh analyzer keeps bracket on the moving
    // chords and refuses it on the jacked ones.
    expect(freshBracket.patterns.map((hit) => hit.id)).toContain("bracket");
    const freshJacked = freshAnalysis(jackedText);
    expect(freshJacked.patterns.map((hit) => hit.id)).not.toContain("bracket");
    expect(freshJacked.patterns.map((hit) => hit.id)).toContain("chordjack");
  });

  it("runs once: re-enqueues analysis for changed charts, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, buildJackedBracketOsuFile(), { patternIds: ["bracket", "chordjack"] });
    const queue = new JobQueue(db);

    await ensureBracketTagRecomputeSeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(BRACKET_TAG_RECOMPUTE_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === BRACKET_TAG_RECOMPUTE_JOB) {
        await runBracketTagRecomputeJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureBracketTagRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [BRACKET_TAG_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
