import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../src/dan/dan-estimator/cache-version.js";
import { computeDanEstimateJob, getDanEstimateBatch, getRateAdjustedChartAnalysis, loadStoredRateDanVerdicts, normalizeDanEstimateItems, rateDanVerdictKey } from "../src/features/dan-estimates.js";
import { JobQueue } from "../src/jobs/queue.js";

describe("normalizeDanEstimateItems", () => {
  it("serves the previous estimate and MSD while queued, then replaces them with the job's current result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-dan-refresh-"));
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    try {
      await migrate(db);
      const queue = new JobQueue(db);
      const now = new Date().toISOString();
      await exec(db, `insert into dan_estimates
        (estimator_version, beatmap_id, rate_percent, status, label, display_name, raw_dan, family, confidence, msd_json, computed_at, updated_at)
        values (?, 991, 120, 'ready', '8', '8', 8, 'dan', 0.9, '{"values":{"Overall":20}}', ?, ?)`,
      [15, now, now]);
      const osu = { getBeatmapFile: vi.fn(async () => buildFourKeyBeatmapFile()) };
      const items = [{ beatmapId: 991, rate: 1.2 }];
      const batch = await getDanEstimateBatch(db, queue, osu as never, items, { computeMissing: true });
      expect(batch.results["991:120"]).toMatchObject({ rawDan: 8, estimatorVersion: 15 });
      expect(batch.pending).toEqual(["991:120"]);
      expect(osu.getBeatmapFile).not.toHaveBeenCalled();
      expect(await getRateAdjustedChartAnalysis(db, osu as never, 991, 1.2, queue)).toMatchObject({
        status: "ready", dan: { rawDan: 8 }, msd: { Overall: 20 },
      });
      expect((await exec(db, "select id from jobs where type = 'compute_dan_estimate'")).rows).toHaveLength(1);
      const failedQueue = { enqueue: async () => { throw new Error("queue busy"); } };
      expect((await getDanEstimateBatch(db, failedQueue as never, osu as never, items)).results["991:120"]?.rawDan).toBe(8);

      await computeDanEstimateJob(db, osu as never, items[0]);
      const fresh = await getDanEstimateBatch(db, queue, osu as never, items);
      expect(fresh.pending).toEqual([]);
      expect(fresh.results["991:120"]?.estimatorVersion).toBe(DAN_ESTIMATE_CACHE_VERSION);
      expect(osu.getBeatmapFile).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps old rate and Invert credit separate, honors current negatives, and rejects poisoned fallbacks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-dan-fallback-"));
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    try {
      await migrate(db);
      const now = new Date().toISOString();
      await exec(db, "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, difficulty_rating, updated_at) values (992, 1, 'mania', '4K', 4.2, ?)", [now]);
      for (const table of ["dan_estimates", "dan_mod_estimates"]) {
        const modColumn = table === "dan_mod_estimates" ? ", mod_variant" : "";
        const modValue = table === "dan_mod_estimates" ? ", 'IN'" : "";
        for (const rate of [120, 130, 140]) {
          await exec(db, `insert into ${table}
            (estimator_version, beatmap_id, rate_percent, status, label, display_name, raw_dan, family, confidence, star_rating, computed_at, updated_at${modColumn})
            values (?, 992, ?, 'ready', '8', 'old', ?, 'dan', 0.9, ?, ?, ?${modValue})`,
          [15, rate, table === "dan_estimates" ? 8 : 9, rate === 140 ? 1000 : 4.2, now, now]);
        }
      }
      const pairs = [120, 130, 140].flatMap((ratePercent) => [
        { beatmapId: 992, ratePercent }, { beatmapId: 992, ratePercent, modVariant: "IN" as const },
      ]);
      const old = await loadStoredRateDanVerdicts(db, pairs);
      expect(old.get("992:120")).toMatchObject({ rawDan: 8, stale: true });
      expect(old.get(rateDanVerdictKey(992, 120, "IN"))).toMatchObject({ rawDan: 9, stale: true });
      expect(old.has("992:140")).toBe(false);
      expect(old.has(rateDanVerdictKey(992, 140, "IN"))).toBe(false);
      await exec(db, `insert into dan_estimates
        (estimator_version, beatmap_id, rate_percent, status, computed_at, updated_at)
        values (?, 992, 120, 'unsupported', ?, ?)`, [DAN_ESTIMATE_CACHE_VERSION, now, now]);
      await exec(db, `insert into dan_estimates
        (estimator_version, beatmap_id, rate_percent, status, label, display_name, raw_dan, family, confidence, star_rating, computed_at, updated_at)
        values (?, 992, 130, 'ready', '7', 'new', 7, 'dan', 0.9, 4.2, ?, ?)`, [DAN_ESTIMATE_CACHE_VERSION, now, now]);
      const fresh = await loadStoredRateDanVerdicts(db, pairs);
      expect(fresh.get("992:120")).toBeNull();
      expect(fresh.get("992:130")).toEqual({ rawDan: 7, family: "dan", displayName: "new" });
      expect(fresh.get(rateDanVerdictKey(992, 120, "IN"))).toMatchObject({ rawDan: 9, stale: true });
      const batch = await getDanEstimateBatch(db, new JobQueue(db), {} as never,
        [120, 130, 140].map((rate) => ({ beatmapId: 992, rate: rate / 100 })));
      expect(batch.results["992:120"]).toBeNull();
      expect(batch.results["992:130"]?.rawDan).toBe(7);
      expect(batch.results["992:140"]).toBeUndefined();
      expect(batch.pending).toEqual(["992:140"]);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates response keys, clamps unusual rates and drops client star ratings", () => {
    expect(normalizeDanEstimateItems([
      // starRating is client input on a public endpoint whose row is keyed
      // only by (beatmap, rate); it must never shape a stored estimate.
      { beatmapId: 123, starRating: 1000 },
      { beatmapId: 123, rate: 1 },
      { beatmapId: 456, rate: 2.5 },
      { beatmapId: 789, rate: 0.2 },
      { beatmapId: "nope" },
    ])).toEqual([
      { beatmapId: 123, rate: 1, ratePercent: 100, key: "123" },
      { beatmapId: 456, rate: 2, ratePercent: 200, key: "456:200" },
      { beatmapId: 789, rate: 0.5, ratePercent: 50, key: "789:50" },
    ]);
  });

  it("computes a missing 4K estimate once and then serves it from cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-dan-"));
    try {
      const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
      await migrate(db);
      const queue = new JobQueue(db);
      let fetchCount = 0;
      const osu = {
        getBeatmapFile: async () => {
          fetchCount++;
          return buildFourKeyBeatmapFile();
        },
      };

      const first = await getDanEstimateBatch(db, queue, osu as never, [{ beatmapId: 123, starRating: 4.2 }], { computeMissing: true });
      expect(first.pending).toEqual([]);
      expect(first.results["123"]?.estimatorVersion).toBe(DAN_ESTIMATE_CACHE_VERSION);
      expect(fetchCount).toBe(1);

      const second = await getDanEstimateBatch(db, queue, osu as never, [{ beatmapId: 123, starRating: 4.2 }], { computeMissing: false });
      expect(second.pending).toEqual([]);
      expect(second.results["123"]).toEqual(first.results["123"]);
      expect(fetchCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores the beatmaps row's star rating, never the client's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-dan-"));
    try {
      const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
      await migrate(db);
      const queue = new JobQueue(db);
      await exec(
        db,
        "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, difficulty_rating, updated_at) values (123, 1, 'mania', '4K', 4.2, ?)",
        [new Date().toISOString()],
      );
      const osu = { getBeatmapFile: async () => buildFourKeyBeatmapFile() };

      await getDanEstimateBatch(db, queue, osu as never, [{ beatmapId: 123, starRating: 1000 }], { computeMissing: true });
      const row = (await exec(
        db,
        "select star_rating from dan_estimates where estimator_version = ? and beatmap_id = 123 and rate_percent = 100",
        [DAN_ESTIMATE_CACHE_VERSION],
      )).rows[0];
      expect(Number(row?.star_rating)).toBeCloseTo(4.2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalidates a stored estimate whose star rating contradicts the beatmaps row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-dan-"));
    try {
      const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
      await migrate(db);
      const queue = new JobQueue(db);
      const now = new Date().toISOString();
      await exec(
        db,
        "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, difficulty_rating, updated_at) values (321, 1, 'mania', '4K', 4.2, ?)",
        [now],
      );
      // A poisoned row from the era the batch endpoint trusted client star
      // ratings: absurd rating, absurd dan.
      await exec(
        db,
        `insert into dan_estimates (
           estimator_version, beatmap_id, rate_percent, status, label, display_name, raw_dan, family, confidence, star_rating, computed_at, updated_at
         ) values (?, 321, 120, 'ready', 'x', 'x', 1166.09, 'dan', 0.9, 1000, ?, ?)`,
        [DAN_ESTIMATE_CACHE_VERSION, now, now],
      );
      // A legitimate row on the same chart at another rate, within tolerance.
      await exec(
        db,
        `insert into dan_estimates (
           estimator_version, beatmap_id, rate_percent, status, label, display_name, raw_dan, family, confidence, star_rating, computed_at, updated_at
         ) values (?, 321, 130, 'ready', 'x', 'x', 8.1, 'dan', 0.9, 4.2, ?, ?)`,
        [DAN_ESTIMATE_CACHE_VERSION, now, now],
      );

      // The batch read treats the poisoned row as missing and re-queues it.
      const batch = await getDanEstimateBatch(db, queue, { getBeatmapFile: async () => buildFourKeyBeatmapFile() } as never, [{ beatmapId: 321, rate: 1.2 }], { computeMissing: false });
      expect(batch.results["321:120"]).toBeUndefined();
      expect(batch.pending).toEqual(["321:120"]);

      // The dan clear credit path skips it the same way and keeps the honest row.
      const verdicts = await loadStoredRateDanVerdicts(db, [
        { beatmapId: 321, ratePercent: 120 },
        { beatmapId: 321, ratePercent: 130 },
      ]);
      expect(verdicts.has(rateDanVerdictKey(321, 120))).toBe(false);
      expect(verdicts.get(rateDanVerdictKey(321, 130))).toEqual({ rawDan: 8.1, family: "dan", displayName: "x" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function buildFourKeyBeatmapFile(): string {
  const notes = Array.from({ length: 96 }, (_, index) => {
    const column = index % 4;
    const x = 64 + column * 128;
    const time = 1000 + index * 110;
    return `${x},192,${time},1,0,0:0:0:0:`;
  }).join("\n");
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Test Dan
Artist: Test
Creator: Mapper
Version: 4K

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${notes}
`;
}
