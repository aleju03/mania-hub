import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../src/dan/dan-estimator/cache-version.js";
import { computeMsd } from "../src/dan/msd.js";
import { computeMsdOnThread } from "../src/dan/msd-thread.js";
import { prepareVibroChart, VIBRO_SECTION_VERSION } from "../src/dan/vibro-sections.js";
import {
  VIBRO_ADJUSTED_VARIANT, computeAndStoreRateDanVerdictFromText,
  computeDanEstimateJob, enqueueRateDanEstimate, getDanEstimateBatch,
  getRateAdjustedChartAnalysis, loadStoredRateDanVerdicts, normalizeDanEstimateItems,
  rateDanVerdictKey,
  type RateDanVerdictPair,
} from "../src/features/dan-estimates.js";
import { parseDtRateVerdict } from "../src/features/map-search.js";
import { JobQueue } from "../src/jobs/queue.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { localizedVibroFixture } from "./vibro-fixtures.js";

const noNetwork = { getBeatmapFile: async () => { throw new Error("Unexpected network request"); } };

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-dan-vibro-scope-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try {
    await migrate(db);
    await run(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ordinary chart and player vibro rating separation", () => {
  it.each([1, 1.5])("rates every chart note by default, and only retained player notes at %sx", async (rate) => {
    const text = localizedVibroFixture();
    const full = await computeMsd(text, { rate, keyCount: 4 });
    const player = await computeMsd(text, { rate, keyCount: 4, adjustVibro: true });
    const expectedFull = await computeMsdOnThread(text, { rate, keyCount: 4 });
    const expectedPlayer = await computeMsdOnThread(prepareVibroChart(text, rate).osuText, { rate, keyCount: 4 });
    expect(full?.values).toEqual(expectedFull.values);
    expect(player?.values).toEqual(expectedPlayer.values);
    expect(full?.values.Overall).not.toBe(player?.values.Overall);
    expect(full?.vibroAnalysis).toEqual(player?.vibroAnalysis);
    expect(full?.vibroAdjusted).toBe(false);
    expect(player?.vibroAdjusted).toBe(true);
  });

  it.each([100, 150])("keeps public estimates and player variants in separate caches at %s%%", async (ratePercent) => {
    await withDb(async (db) => {
      const id = 941000 + ratePercent;
      const text = localizedVibroFixture();
      await storeCachedBeatmapFile(db, id, text, { source: "test" });
      // Exercise both write orders: neither cache may overwrite the other.
      const compute = (player: boolean) => computeAndStoreRateDanVerdictFromText(db, id, ratePercent, text,
        player ? VIBRO_ADJUSTED_VARIANT : undefined);
      const [first, second] = [ratePercent === 100, ratePercent !== 100];
      const firstValue = await compute(first);
      const secondValue = await compute(second);
      const player = first ? firstValue : secondValue;
      const full = first ? secondValue : firstValue;
      expect(full!.rawDan).toBeGreaterThan(player!.rawDan);
      const pairs: RateDanVerdictPair[] = [{ beatmapId: id, ratePercent }, { beatmapId: id, ratePercent, modVariant: VIBRO_ADJUSTED_VARIANT }];
      const stored = await loadStoredRateDanVerdicts(db, pairs);
      expect(stored.get(rateDanVerdictKey(id, ratePercent))?.rawDan).toBe(full!.rawDan);
      expect(stored.get(rateDanVerdictKey(id, ratePercent, VIBRO_ADJUSTED_VARIANT))?.rawDan).toBe(player!.rawDan);
      const publicRate = await getRateAdjustedChartAnalysis(db, noNetwork as never, id, ratePercent / 100);
      expect(publicRate?.dan?.rawDan).toBe(full!.rawDan);
      expect(publicRate?.msd).toEqual((await computeMsdOnThread(text, { keyCount: 4, rate: ratePercent / 100 })).values);
      expect(publicRate?.vibroAnalysis?.status).toBe("adjusted");
      expect(await getRateAdjustedChartAnalysis(db, noNetwork as never, id, ratePercent / 100)).toEqual(publicRate);

      const queue = new JobQueue(db);
      const key = normalizeDanEstimateItems([{ beatmapId: id, rate: ratePercent / 100 }])[0].key;
      const batch = await getDanEstimateBatch(db, queue, noNetwork as never,
        [{ beatmapId: id, rate: ratePercent / 100, mod: VIBRO_ADJUSTED_VARIANT }]);
      expect(batch.results[key]?.rawDan).toBe(full!.rawDan);

      // A queued internal request retains the variant; public items ignore it.
      const queuedId = id + 1;
      await storeCachedBeatmapFile(db, queuedId, text, { source: "test" });
      await enqueueRateDanEstimate(queue, queuedId, ratePercent, VIBRO_ADJUSTED_VARIANT);
      const [job] = await queue.claim("test", 1);
      expect(job.payload).toMatchObject({ mod: VIBRO_ADJUSTED_VARIANT });
      await computeDanEstimateJob(db, noNetwork as never, job.payload);
      const queued = await loadStoredRateDanVerdicts(db, [
        { beatmapId: queuedId, ratePercent },
        { beatmapId: queuedId, ratePercent, modVariant: VIBRO_ADJUSTED_VARIANT },
      ]);
      expect(queued.has(rateDanVerdictKey(queuedId, ratePercent))).toBe(false);
      expect(queued.get(rateDanVerdictKey(queuedId, ratePercent, VIBRO_ADJUSTED_VARIANT))?.rawDan).toBe(player!.rawDan);
    });
  });

  it("preserves v16 player credit without serving it as an ordinary chart estimate", async () => {
    await withDb(async (db) => {
      const now = new Date().toISOString();
      await exec(db, `insert into dan_estimates
        (estimator_version, beatmap_id, rate_percent, status, label, display_name, raw_dan, family, confidence, computed_at, updated_at)
        values (16, 941999, 100, 'ready', '8', '8', 8, 'dan', 0.72, ?, ?)`, [now, now]);
      const pairs: RateDanVerdictPair[] = [{ beatmapId: 941999, ratePercent: 100 },
        { beatmapId: 941999, ratePercent: 100, modVariant: VIBRO_ADJUSTED_VARIANT }];
      const key = rateDanVerdictKey(941999, 100, VIBRO_ADJUSTED_VARIANT);
      const stored = await loadStoredRateDanVerdicts(db, pairs);
      // A clean player's existing rate evidence stays usable as well.
      expect(stored.get(rateDanVerdictKey(941999, 100))).toMatchObject({ rawDan: 8, stale: true });
      expect(stored.get(key)).toMatchObject({ rawDan: 8, stale: true });
      const batch = await getDanEstimateBatch(db, new JobQueue(db), noNetwork as never, [{ beatmapId: 941999 }]);
      expect(batch.results["941999"]).toBeUndefined();
      expect(batch.pending).toEqual(["941999"]);

      await exec(db, `insert into dan_mod_estimates
        (estimator_version, beatmap_id, rate_percent, mod_variant, status, computed_at, updated_at)
        values (?, 941999, 100, ?, 'unsupported', ?, ?)`, [DAN_ESTIMATE_CACHE_VERSION, VIBRO_ADJUSTED_VARIANT, now, now]);
      expect((await loadStoredRateDanVerdicts(db, pairs)).get(key)).toBeNull();
    });
  });

  it("does not expose legacy adjusted DT columns as ordinary chart estimates", () => {
    const row = { key_count: 4, dan_dt_json: JSON.stringify({ primaryLabel: "8", rawDan: 8 }),
      msd_dt_json: JSON.stringify({ values: { Overall: 20 }, vibroVersion: 1 }) };
    expect(parseDtRateVerdict(row)).toEqual({ danDt: null, msdDt: null });
    row.msd_dt_json = JSON.stringify({ values: { Overall: 20 }, vibroVersion: VIBRO_SECTION_VERSION, vibroAdjusted: false });
    expect(parseDtRateVerdict(row).danDt?.rawDan).toBe(8);
  });
});
