import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { classifyChart, sunnyLowEndReroute } from "../src/dan/chart-classifier.js";
import { classifyChartWithCompanella } from "../src/dan/companella.js";
import { invertManiaOsuText } from "../src/dan/invert-mod.js";
import { runLeoBlackMixed, runLeoBlackSunny, type LeoBlackOdFlag } from "../src/dan/leoblack-estimator.js";
import { DAN_ESTIMATE_CACHE_VERSION } from "../src/dan/dan-estimator/cache-version.js";
import { computeAndStoreRateDanVerdictFromText, computeDanEstimateJob, enqueueRateDanEstimate,
  getDanEstimateBatch, loadStoredRateDanVerdicts, normalizeDanEstimateItems, rateDanVerdictKey } from "../src/features/dan-estimates.js";
import { danClearTargetFor, difficultyAdjustOd, loadChartSkillInfo, loadRateVerdictCredits,
  type StoredPlaySsr } from "../src/features/player-skills.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";

function chart(keys = 7, gap = 190, count = 420): string {
  const notes = Array.from({ length: count }, (_, i) => {
    const column = (i * 13 + Math.floor(i / 7)) % keys;
    return `${Math.floor((column + 0.5) * 512 / keys)},192,${1000 + i * gap},1,0,0:0:0:0:`;
  });
  return `osu file format v14
[General]
Mode:3
[Metadata]
Title:Synthetic OD coverage
Version:Test
[Difficulty]
CircleSize:${keys}
OverallDifficulty:7
[TimingPoints]
0,700,4,2,0,100,1,0
[HitObjects]
${notes.join("\n")}`;
}

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dan-played-od-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try { await migrate(db); await run(db); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

describe("played OD in LeoBlack dan estimates", () => {
  it("keeps public chart requests unchanged and distinguishes explicit zero/equal OD/HR/EZ internally", () => {
    const items = [undefined, 0, 7, "HR", "EZ"].map(odFlag => ({ beatmapId: 1, rate: 1, mod: "IN", odFlag }));
    expect(normalizeDanEstimateItems(items)).toEqual([{ beatmapId: 1, rate: 1, ratePercent: 100, key: "1" }]);
    const internal = normalizeDanEstimateItems([...items, items[1]], { modVariants: true });
    expect(new Set(internal.map(r => r.key)).size).toBe(5);
    expect(internal.map(r => r.odFlag)).toEqual([undefined, 0, 7, "HR", "EZ"]);
    expect(normalizeDanEstimateItems([NaN, Infinity, 16, -16, "6", {}].map(odFlag => ({ beatmapId: 1, odFlag })),
      { modVariants: true })).toEqual([]);
    // Malformed/missing wire data must not become an explicit OD0.
    expect(difficultyAdjustOd([{ acronym: "DA", settings: { overall_difficulty: null } }] as never)).toBeNull();
    expect(difficultyAdjustOd([{ acronym: "DA", settings: { overall_difficulty: 0 } }])).toBe(0);
  });

  it.each([0, 6, 7, 15, -15, "HR", "EZ"] satisfies LeoBlackOdFlag[])("matches upstream 7K Inverse at played OD %s", (odFlag) => {
    const base = chart();
    const text = invertManiaOsuText(base)!;
    for (const rate of [1, 1.5]) {
      const expected = runLeoBlackSunny(base, { cvtFlag: "IN", speedRate: rate, odFlag });
      const actual = classifyChart(parseManiaBeatmap(text), text, { rate, odFlag });
      expect(actual.verdictText).toBe(expected.estDiff);
      expect(actual.sunnySr).toBe(expected.star);
    }
    expect(runLeoBlackSunny(text, { odFlag: 6 }).star).not.toBe(runLeoBlackSunny(text).star);
  });

  it("keeps explicit OD through 4K Mixed routing and Companella's second classification", async () => {
    const text = chart(4, 50, 1400);
    const map = parseManiaBeatmap(text);
    for (const odFlag of [0, 7, "HR", "EZ"] satisfies LeoBlackOdFlag[]) {
      const mixed = runLeoBlackMixed(text, { odFlag });
      const actual = classifyChart(map, text, { odFlag });
      expect(actual.sunnySr).toBe(mixed.star);
      expect(actual.verdictText).toBe(mixed.estDiff);
      const refined = await classifyChartWithCompanella(map, text, { odFlag });
      expect(refined.sunnySr).toBe(actual.sunnySr);
      expect(refined.companellaPending).toBe(false);
    }
  }, 30_000);

  it("passes played OD to the existing Sunny low-end fallback", () => {
    const text = chart(4, 1000, 40);
    const mixed = { ...runLeoBlackMixed(text), numericDifficultyHint: "azusa-rc-v1", numericDifficulty: 3,
      debug: { sunnyNumeric: 3 } };
    const fallback = sunnyLowEndReroute(mixed, text, 1, "HR");
    expect(fallback?.star).toBe(runLeoBlackSunny(text, { odFlag: "HR" }).star);
    expect(fallback?.star).not.toBe(runLeoBlackSunny(text).star);
  });

  it("isolates job keys and cached verdicts across OD and Inverse, including terminal rows", async () => {
    await withDb(async db => {
      const queue = new JobQueue(db);
      const text = chart();
      await storeCachedBeatmapFile(db, 1, text);
      for (const modVariant of [undefined, "IN", "vibro-adjusted"] as const) {
        for (const odFlag of [undefined, 0, 6, 7, "HR", "EZ"] satisfies Array<LeoBlackOdFlag | undefined>) {
          await enqueueRateDanEstimate(queue, 1, 100, modVariant, odFlag);
          await enqueueRateDanEstimate(queue, 1, 100, modVariant, odFlag);
        }
      }
      const jobs = (await exec(db, "select payload_json from jobs where type = 'compute_dan_estimate'")).rows;
      expect(jobs).toHaveLength(18);
      for (const job of jobs) await computeDanEstimateJob(db, {} as never, JSON.parse(String(job.payload_json)));
      expect((await exec(db, "select * from dan_estimates")).rows).toHaveLength(1);
      expect((await exec(db, "select * from dan_mod_estimates")).rows).toHaveLength(17);
      const pairs = jobs.map(job => {
        const p = JSON.parse(String(job.payload_json));
        return { beatmapId: 1, ratePercent: 100, modVariant: p.mod, odFlag: p.odFlag };
      });
      const loaded = await loadStoredRateDanVerdicts(db, pairs);
      expect(loaded.size).toBe(18);
      for (const pair of pairs) {
        const value = loaded.get(rateDanVerdictKey(1, 100, pair.modVariant, pair.odFlag));
        const source = pair.modVariant === "IN" ? invertManiaOsuText(text)! : text;
        const expected = classifyChart(parseManiaBeatmap(source), source, { odFlag: pair.odFlag });
        expect(value?.rawDan).toBe(expected.primary?.rawDan);
      }
      const publicRead = await getDanEstimateBatch(db, queue, {} as never, [{ beatmapId: 1, mod: "IN", odFlag: 6 }]);
      expect(publicRead.results["1"]?.rawDan).toBe(classifyChart(parseManiaBeatmap(text), text).primary?.rawDan);
      await exec(db, "update dan_mod_estimates set status = 'unavailable' where mod_variant = 'IN:OD:6'");
      const terminal = await loadStoredRateDanVerdicts(db, pairs);
      expect(terminal.get(rateDanVerdictKey(1, 100, "IN", 6))).toBeNull();
      expect(terminal.get(rateDanVerdictKey(1, 100, "IN", 7))).not.toBeNull();
      expect(await computeAndStoreRateDanVerdictFromText(db, 1, 100, text, "IN", { odFlag: 6 })).toBeNull();
      // An older unmodified row cannot fill a missing OD-specific entry.
      await exec(db, "delete from dan_mod_estimates where mod_variant = 'IN:OD:6'");
      expect((await loadStoredRateDanVerdicts(db, pairs)).has(rateDanVerdictKey(1, 100, "IN", 6))).toBe(false);
      const direct = await computeAndStoreRateDanVerdictFromText(db, 1, 100, text, "IN", { odFlag: 6 });
      expect(direct?.rawDan).toBe(classifyChart(parseManiaBeatmap(invertManiaOsuText(text)!), invertManiaOsuText(text)!, { odFlag: 6 }).primary?.rawDan);
    });
  });

  it("uses played OD instead of ordinary normal/DT/HT columns and preserves DA precedence", async () => {
    await withDb(async db => {
      await exec(db, `insert into beatmap_chart_analysis
        (beatmap_id, analysis_version, status, classification_json, dan_dt_json, dan_ht_json, updated_at)
        values (1, ?, 'ready', ?, ?, ?, '2026-01-01')`, [CHART_ANALYSIS_VERSION,
        JSON.stringify({ lnRatio: 0, rc: { rawDan: 20 } }),
        JSON.stringify({ rawDan: 21, family: "dan" }), JSON.stringify({ rawDan: 19, family: "dan" })]);
      const info = (await loadChartSkillInfo(db, [1])).get(1)!;
      for (const rate of [0.75, 1, 1.2, 1.5]) {
        const play: StoredPlaySsr = { identity: "s1", beatmapId: 1, keyCount: 7, rate, goal: 0.95,
          pp: 100, values: { Overall: 20 }, patterns: [], odOverride: 6, mods: ["DA", "HR"] };
        const key = rateDanVerdictKey(1, Math.round(rate * 100), undefined, 6);
        expect(danClearTargetFor(play, info, 7, new Map())).toBeNull();
        expect(danClearTargetFor(play, info, 7, new Map([[key, { rawDan: 6, side: "rc", displayName: "6" }]])))
          .toEqual({ rawDan: 6, side: "rc", label: "6" });
      }
      for (const [mods, odOverride, odFlag] of [[[], 0, 0], [["HR"], null, "HR"], [["EZ"], null, "EZ"]] as const) {
        const play: StoredPlaySsr = { identity: "s1", beatmapId: 1, keyCount: 7, rate: 1, goal: 0.95,
          pp: 100, values: {}, patterns: [], mods: [...mods], odOverride };
        await exec(db, `insert into dan_mod_estimates
          (estimator_version, beatmap_id, rate_percent, mod_variant, status, raw_dan, family, display_name, computed_at, updated_at)
          values (?, 1, 100, ?, 'ready', 6, 'dan', '6', '2026-01-01', '2026-01-01')`, [DAN_ESTIMATE_CACHE_VERSION, `OD:${odFlag}`]);
        const loaded = await loadRateVerdictCredits(db, [play]);
        expect(danClearTargetFor(play, info, 7, loaded)?.rawDan).toBe(6);
      }
    });
  });
});
