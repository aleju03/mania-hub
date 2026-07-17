import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { extractDanFeatures } from "../src/dan/dan-estimator/features.js";
import { estimateLnDan } from "../src/dan/dan-estimator/ln.js";
import {
  CHART_ANALYSIS_VERSION,
  recomputeLnSourceChunk,
} from "../src/features/chart-analysis.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { nowIso } from "../src/shared/score.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-ln-sweep-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function columnX(column: number): number {
  return Math.floor(((column + 0.5) * 512) / 4);
}

// A continuous dense chorded-hold chart: unambiguous LN signal for the kNN.
function buildLnBeatmapFile(): string {
  const hitObjects: string[] = [];
  const rows = Math.floor(150_000 / 150);
  for (let row = 0; row < rows; row++) {
    const start = 1000 + row * 150;
    const end = start + 320;
    const first = (row * 7) % 4;
    const second = (first + 1 + (row % 3)) % 4;
    hitObjects.push(`${columnX(first)},192,${start},128,0,${end}:0:0:0:0:`);
    hitObjects.push(`${columnX(second)},192,${start},128,0,${end}:0:0:0:0:`);
  }
  return [
    "osu file format v14",
    "",
    "[General]",
    "Mode: 3",
    "",
    "[Metadata]",
    "Title:Synthetic LN Chart",
    "Artist:Test",
    "Creator:Test",
    "Version:Test",
    "",
    "[Difficulty]",
    "CircleSize:4",
    "OverallDifficulty:8",
    "HPDrainRate:8",
    "",
    "[TimingPoints]",
    "0,352.94,4,2,0,100,1,0",
    "",
    "[HitObjects]",
    ...hitObjects,
  ].join("\n");
}

// The verdict the sweep will recompute for the fixture (no star rating seeded).
function freshFixtureVerdict(): string {
  const map = parseManiaBeatmap(buildLnBeatmapFile());
  const input = { totalLength: map.totalLength / 1000, version: map.version };
  const features = extractDanFeatures(map, input, 1);
  const est = estimateLnDan(map, input, features.metrics, 0, features.durationMs, 1);
  if (!est) throw new Error("fixture no longer triggers the LN kNN");
  return `${est.label}${est.variant ?? ""}`;
}

async function seedKnnLnAnalysis(
  db: Awaited<ReturnType<typeof createDb>>,
  beatmapId: number,
  storedDisplayName: string,
  options: { danDt?: boolean } = {},
): Promise<void> {
  const now = nowIso();
  const lean = {
    keyCount: 4,
    ln: { kind: "ln", source: "inhouse-ln-knn", label: storedDisplayName, variant: null, displayName: storedDisplayName, rawDan: 14.4, estimatedSr: 14.4, confidence: 0.7 },
  };
  await exec(
    db,
    `insert into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, classification_json, dan_dt_json, updated_at)
     values (?, ?, 'ready', 4, ?, 'ln', 14.4, ?, ?, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      storedDisplayName,
      JSON.stringify(lean),
      options.danDt ? JSON.stringify({ primaryLabel: "16", primaryFamily: "ln", rawDan: 16.2 }) : null,
      now,
    ],
  );
}

describe("4K LN estimate sweep", () => {
  it("re-flags charts whose fresh kNN verdict differs and refreshes their DT verdict", async () => {
    await withDb(async (db) => {
      const staleMap = 6100;
      await storeCachedBeatmapFile(db, staleMap, buildLnBeatmapFile(), { source: "test" });
      // Stored verdict that no longer matches what the extended references produce.
      await seedKnnLnAnalysis(db, staleMap, "1", { danDt: true });

      const result = await recomputeLnSourceChunk(db, 0);
      expect(result.changed).toContain(staleMap);
      expect(result.done).toBe(true);

      // The DT dan verdict was recomputed inline with the current references.
      const row = (await exec(
        db,
        "select dan_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [staleMap, CHART_ANALYSIS_VERSION],
      )).rows[0];
      const danDt = JSON.parse(String(row.dan_dt_json));
      expect(danDt).toHaveProperty("primaryLabel");
      expect(danDt.rawDan).not.toBe(16.2);
    });
  }, 30_000);

  it("skips charts whose stored verdict already matches the fresh estimate", async () => {
    await withDb(async (db) => {
      const freshMap = 6200;
      await storeCachedBeatmapFile(db, freshMap, buildLnBeatmapFile(), { source: "test" });
      await seedKnnLnAnalysis(db, freshMap, freshFixtureVerdict());

      const result = await recomputeLnSourceChunk(db, 0);
      expect(result.changed).not.toContain(freshMap);
      expect(result.done).toBe(true);
    });
  }, 30_000);

  it("ignores rows whose LN half is not kNN-sourced", async () => {
    await withDb(async (db) => {
      const leoMap = 6300;
      const now = nowIso();
      await storeCachedBeatmapFile(db, leoMap, buildLnBeatmapFile(), { source: "test" });
      await exec(
        db,
        `insert into beatmap_chart_analysis
           (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, classification_json, updated_at)
         values (?, ?, 'ready', 4, '13+', 'ln', 13.2, ?, ?)`,
        [
          leoMap,
          CHART_ANALYSIS_VERSION,
          JSON.stringify({ keyCount: 4, ln: { kind: "ln", source: "leoblack-sunny-table", label: "13", variant: "+", displayName: "13+", rawDan: 13.2, estimatedSr: 13.2, confidence: 0.6 } }),
          now,
        ],
      );

      const result = await recomputeLnSourceChunk(db, 0);
      expect(result.scanned).toBe(0);
      expect(result.changed).toEqual([]);
    });
  });
});
