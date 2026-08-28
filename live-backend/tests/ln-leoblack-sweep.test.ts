import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { CHART_ANALYSIS_VERSION, recomputeLnLeoblackChunk } from "../src/features/chart-analysis.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { classifyChart } from "../src/dan/chart-classifier.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { nowIso } from "../src/shared/score.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-ln-leoblack-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Dense 4K hold chart so classifyChart yields an LN half; lane x positions on
// osu!mania's 512 grid, hold bodies long enough for a real lnRatio.
function buildLnBeatmapFile(): string {
  const notes = Array.from({ length: 700 }, (_, index) => {
    const column = index % 4;
    const x = Math.floor((512 * (column + 0.5)) / 4);
    const time = 1000 + index * 88;
    return `${x},192,${time},128,0,${time + 70}:0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: LN Verdict Refresh Test
Artist: Test
Creator: Mapper
Version: 4K LN

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

async function seedAnalysisRow(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number, ln: object): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
     values (?, ?, 'ready', 4, ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 1, patterns: [], ln }), nowIso()],
  );
}

describe("recomputeLnLeoblackChunk", () => {
  it("re-queues a kNN row whose stored rawDan disagrees, even under a matching label", async () => {
    await withDb(async (db) => {
      const osuText = buildLnBeatmapFile();
      const map = parseManiaBeatmap(osuText);
      const fresh = classifyChart(map, osuText, { version: map.version }).ln!;
      expect(fresh).toBeTruthy();

      // The pre-2026-08-25 kNN's signature staleness: the fresh verdict's own
      // label and source, but a rawDan that ran past it. The v1 sweep's
      // label-only diff read this as unchanged.
      await storeCachedBeatmapFile(db, 301, osuText, { source: "test" });
      await seedAnalysisRow(db, 301, { ...fresh, source: "inhouse-ln-knn", rawDan: fresh.rawDan + 1.8 });

      // Control: a stored half identical to the fresh verdict stays put (only
      // meaningful when the fixture's fresh source IS the kNN; otherwise the
      // source mismatch legitimately re-queues it).
      await storeCachedBeatmapFile(db, 302, osuText, { source: "test" });
      await seedAnalysisRow(db, 302, { ...fresh, source: "inhouse-ln-knn" });

      const result = await recomputeLnLeoblackChunk(db, 0, 10);
      expect(result.changed).toContain(301);
      if (fresh.source === "inhouse-ln-knn") {
        expect(result.changed).not.toContain(302);
      }
      expect(result.done).toBe(true);
    });
  });
});
