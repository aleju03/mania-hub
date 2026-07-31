import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  CHART_ANALYSIS_VERSION,
  readDtRateMsd,
  recomputeDtRateChunk,
} from "../src/features/chart-analysis.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { nowIso } from "../src/shared/score.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-dt-rate-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A dense stream chart in the given keymode, long enough for MinaCalc to rate
// it above 0. Column x positions follow osu!mania's floor(x * keys / 512).
function buildStreamBeatmapFile(keyCount = 4): string {
  const notes = Array.from({ length: 700 }, (_, index) => {
    const column = index % keyCount;
    const x = Math.floor((512 * (column + 0.5)) / keyCount);
    const time = 1000 + index * 88;
    return `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: DT Rate Test
Artist: Test
Creator: Mapper
Version: ${keyCount}K Stream

[Difficulty]
CircleSize:${keyCount}
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}

async function seedReadyAnalysis(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number, keyCount = 4): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, updated_at)
     values (?, ?, 'ready', ?, ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, keyCount, now],
  );
}

async function seedDtFarmed(db: Awaited<ReturnType<typeof createDb>>, beatmapId: number, mods: string[]): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values ('CR', 1, ?, ?, 500, '{}', ?, null, ?, ?, ?)`,
    [beatmapId, beatmapId * 10, JSON.stringify(mods), now, now, now],
  );
}

describe("chart analysis DT-rate migration", () => {
  it("adds the msd_dt_json and dan_dt_json columns", async () => {
    await withDb(async (db) => {
      const columns = (await exec(db, "pragma table_info(beatmap_chart_analysis)")).rows.map((row) => String(row.name));
      expect(columns).toContain("msd_dt_json");
      expect(columns).toContain("dan_dt_json");
    });
  });
});

describe("DT-rate analysis sweep", () => {
  it("computes 1.5x MSD/dan for a DT-farmed 4K chart and reads it back", async () => {
    await withDb(async (db) => {
      const dtMap = 5100;
      await storeCachedBeatmapFile(db, dtMap, buildStreamBeatmapFile(), { source: "test" });
      await seedReadyAnalysis(db, dtMap);
      await seedDtFarmed(db, dtMap, ["DT"]);

      const result = await recomputeDtRateChunk(db, 0);
      expect(result.computed).toContain(dtMap);
      expect(result.done).toBe(true);

      const row = (await exec(
        db,
        "select msd_dt_json, dan_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [dtMap, CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(row.msd_dt_json).toBeTruthy();
      expect(row.dan_dt_json).toBeTruthy();

      // The stored 1.5x MSD parses back to a raw skillset vector.
      const parsed = JSON.parse(String(row.msd_dt_json));
      expect(parsed.values.Overall).toBeGreaterThan(0);
      const dan = JSON.parse(String(row.dan_dt_json));
      expect(dan).toHaveProperty("primaryLabel");
      expect(dan).toHaveProperty("primaryFamily");
      expect(dan).toHaveProperty("rawDan");

      const readBack = await readDtRateMsd(db, [dtMap]);
      const entry = readBack.get(dtMap);
      expect(entry).toBeDefined();
      expect(entry?.msd.length).toBe(7);
      expect(entry?.msd[0]).toBeCloseTo(parsed.values.Stream, 5);
      expect(entry?.overall).toBeCloseTo(parsed.values.Overall, 5);

      // Idempotent: the row now has msd_dt_json, so a second sweep skips it.
      const again = await recomputeDtRateChunk(db, 0);
      expect(again.computed).not.toContain(dtMap);
    });
  }, 30_000);

  it("computes 1.5x MSD/dan for a DT-farmed 7K chart, and skips other keymodes", async () => {
    await withDb(async (db) => {
      const dtMap7k = 5300;
      const dtMap6k = 5301;
      await storeCachedBeatmapFile(db, dtMap7k, buildStreamBeatmapFile(7), { source: "test" });
      await seedReadyAnalysis(db, dtMap7k, 7);
      await seedDtFarmed(db, dtMap7k, ["NC"]);
      // A DT-farmed 6K chart stays outside the sweep: the eligibility
      // predicate is key_count in (4, 7).
      await storeCachedBeatmapFile(db, dtMap6k, buildStreamBeatmapFile(6), { source: "test" });
      await seedReadyAnalysis(db, dtMap6k, 6);
      await seedDtFarmed(db, dtMap6k, ["DT"]);

      const result = await recomputeDtRateChunk(db, 0);
      expect(result.computed).toContain(dtMap7k);
      expect(result.computed).not.toContain(dtMap6k);
      expect(result.done).toBe(true);

      const row = (await exec(
        db,
        "select msd_dt_json, dan_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [dtMap7k, CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(row.msd_dt_json).toBeTruthy();
      expect(row.dan_dt_json).toBeTruthy();
      // MinaCalc rates 7K at 1.5x the same way it does at 1.0x.
      const parsed = JSON.parse(String(row.msd_dt_json));
      expect(parsed.values.Overall).toBeGreaterThan(0);

      const untouched = (await exec(
        db,
        "select msd_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [dtMap6k, CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(untouched.msd_dt_json).toBeNull();
    });
  }, 30_000);

  it("skips 4K charts that were never DT-farmed", async () => {
    await withDb(async (db) => {
      const normalMap = 5200;
      await storeCachedBeatmapFile(db, normalMap, buildStreamBeatmapFile(), { source: "test" });
      await seedReadyAnalysis(db, normalMap);
      await seedDtFarmed(db, normalMap, ["HD"]); // farmed, but not DT/NC

      const result = await recomputeDtRateChunk(db, 0);
      expect(result.computed).not.toContain(normalMap);
      const row = (await exec(
        db,
        "select msd_dt_json from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?",
        [normalMap, CHART_ANALYSIS_VERSION],
      )).rows[0];
      expect(row.msd_dt_json).toBeNull();
    });
  });
});
