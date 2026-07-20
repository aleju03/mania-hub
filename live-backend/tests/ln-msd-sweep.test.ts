import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { blendLnTailValues } from "../src/dan/msd.js";
import { CHART_ANALYSIS_VERSION, recomputeLnMsdChunk } from "../src/features/chart-analysis.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-ln-msd-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

function buildChart(ln: boolean): string {
  const pattern = [0, 1, 2, 3, 1, 3, 0, 2];
  const notes = Array.from({ length: 700 }, (_, index) => {
    const column = pattern[index % pattern.length];
    const x = 64 + column * 128;
    const time = 1000 + index * 88;
    return ln
      ? `${x},192,${time},128,0,${time + 250}:0:0:0:0:`
      : `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: LN MSD Sweep Test
Artist: Test
Creator: Mapper
Version: 4K

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

async function insertReadyAnalysis(db: Db, beatmapId: number, lnRatio: number): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, classification_json, msd_json, msd_overall, updated_at)
     values (?, ?, 'ready', 4, ?, ?, 20, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      JSON.stringify({ lnRatio, patterns: [] }),
      JSON.stringify({ values: { Overall: 20 } }),
      new Date().toISOString(),
    ],
  );
}

describe("recomputeLnMsdChunk", () => {
  it("backfills tail-aware MSD for hold-bearing charts and skips rice", async () => {
    const db = await makeDb();
    await storeCachedBeatmapFile(db, 501, buildChart(true), { source: "test" });
    await storeCachedBeatmapFile(db, 502, buildChart(false), { source: "test" });
    await insertReadyAnalysis(db, 501, 1);
    await insertReadyAnalysis(db, 502, 0);

    const result = await recomputeLnMsdChunk(db, 0, 10);
    expect(result.done).toBe(true);
    expect(result.computed).toEqual([501]);

    const rows = (await exec(
      db,
      "select beatmap_id, msd_ln_json from beatmap_chart_analysis order by beatmap_id",
    )).rows;
    const byId = new Map(rows.map((row) => [Number(row.beatmap_id), row.msd_ln_json]));
    expect(byId.get(502)).toBeNull();
    const lnJson = JSON.parse(String(byId.get(501)));
    // The tail-aware run must rate the LN chart above its rice skeleton.
    expect(Number(lnJson.values.Overall)).toBeGreaterThan(0);

    // A second pass finds nothing left to do.
    const again = await recomputeLnMsdChunk(db, 0, 10);
    expect(again.scanned).toBe(0);
    expect(again.done).toBe(true);
  });
});

describe("blendLnTailValues", () => {
  it("blends by keymode weight and never lowers a value", () => {
    const base = { Overall: 20, Stream: 10 };
    const tails = { Overall: 30, Stream: 8 };
    const blended4 = blendLnTailValues(base, tails, 4);
    expect(blended4.Overall).toBeCloseTo(21, 5);
    // A tails value below base (calc noise) never drags the blend down.
    expect(blended4.Stream).toBe(10);
    const blended7 = blendLnTailValues(base, tails, 7);
    expect(blended7.Overall).toBeCloseTo(23, 5);
    // Unsupported keymodes pass through untouched.
    expect(blendLnTailValues(base, tails, 8).Overall).toBe(20);
  });
});
