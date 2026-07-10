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
  LN_SUBTYPE_RECOMPUTE_JOB,
  ensureLnSubtypeRecomputeSeeded,
  recomputeLnSubtypeChunk,
  runLnSubtypeRecomputeJob,
} from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-ln-subtype-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// 7K inverse chart at 80 BPM: one hold per row cycling the columns, each hold
// filling most of the 910ms column period and releasing 150ms before the next
// press - a 1/4-beat-ish inverse gap that the old fixed 120ms cap misread as
// not-inverse. This is exactly the stale-corpus shape the sweep exists to fix.
function buildSlowInverseOsuFile(): string {
  const rows = Array.from({ length: 7 * 36 }, (_, index) => {
    const column = index % 7;
    const time = 1000 + index * 130;
    const x = Math.floor(((column + 0.5) * 512) / 7);
    return `${x},192,${time},128,0,${time + 760}:0:0:0:0:`;
  });
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: LN Subtype Sweep Test
Artist: Test
Creator: Mapper
Version: 7K

[Difficulty]
CircleSize:7
OverallDifficulty:8

[TimingPoints]
0,750,4,2,0,100,1,0

[HitObjects]
${rows.join("\n")}
`;
}

interface SeedOptions {
  keyCount?: number;
  lnRatio?: number;
  category?: string | null;
  patternIds?: string[];
}

async function seedAnalyzedChart(db: Db, beatmapId: number, osuText: string, options: SeedOptions = {}): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  const classification = {
    lnRatio: options.lnRatio ?? 0.98,
    category: options.category ?? "LN General",
    patterns: (options.patternIds ?? ["lngeneral", "ln"]).map((id) => ({ id, label: id, score: 0.5, confidence: 0.4 })),
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
     values (?, ?, 'ready', ?, '4-', 'ln', 4, ?, ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, options.keyCount ?? 7, JSON.stringify(classification), now, now],
  );
}

describe("LN subtype recompute sweep", () => {
  it("flags charts whose stored pattern tags differ from the fresh analyzer verdict", async () => {
    const db = await makeDb();
    const osuText = buildSlowInverseOsuFile();

    // Stale verdict from before the tempo-aware gap cap: stored as lngeneral.
    await seedAnalyzedChart(db, 1, osuText, { patternIds: ["lngeneral", "ln"], category: "LN General" });

    // In-sync control: stored tags match what the analyzer says today.
    const map = parseManiaBeatmap(osuText);
    const fresh = analyzeManiaPatterns(map, {
      totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
      version: map.version,
    });
    await seedAnalyzedChart(db, 2, osuText, {
      patternIds: fresh.patterns.map((hit) => hit.id),
      category: fresh.primary?.label ?? null,
    });

    // Outside the candidate band: 4K charts have no 7K LN subtypes.
    await seedAnalyzedChart(db, 3, osuText, { keyCount: 4 });

    const result = await recomputeLnSubtypeChunk(db, 0, 50);
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.changed).toEqual([1]);
    // Sanity: the fixture really is inverse under the fresh analyzer.
    expect(fresh.patterns.map((hit) => hit.id)).toContain("lninverse");
  });

  it("runs once: re-enqueues analysis for changed charts, marks itself done, never re-seeds", async () => {
    const db = await makeDb();
    await seedAnalyzedChart(db, 1, buildSlowInverseOsuFile(), { patternIds: ["lngeneral", "ln"] });
    const queue = new JobQueue(db);

    await ensureLnSubtypeRecomputeSeeded(db, queue);
    const seenTypes: string[] = [];
    let [job] = await queue.claim("test-worker", 1);
    expect(job?.type).toBe(LN_SUBTYPE_RECOMPUTE_JOB);
    while (job) {
      seenTypes.push(job.type);
      if (job.type === LN_SUBTYPE_RECOMPUTE_JOB) {
        await runLnSubtypeRecomputeJob(db, queue, job.payload as { cursor?: number });
      }
      await queue.complete(job.id);
      [job] = await queue.claim("test-worker", 1);
    }
    expect(seenTypes).toContain(CHART_ANALYSIS_JOB);

    // A restart re-runs the boot seed; the done marker must make it a no-op.
    await ensureLnSubtypeRecomputeSeeded(db, queue);
    const pending = (await exec(
      db,
      "select count(*) as count from jobs where type = ? and status = 'queued'",
      [LN_SUBTYPE_RECOMPUTE_JOB],
    )).rows[0];
    expect(Number(pending?.count)).toBe(0);
  });
});
