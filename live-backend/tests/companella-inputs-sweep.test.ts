import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { COMPANELLA_INPUTS_JOB, COMPANELLA_INPUTS_META_KEY, ensureCompanellaInputsSeeded,
  recomputeCompanellaInputsChunk, runCompanellaInputsJob } from "../src/features/companella-inputs.js";
import { JobQueue } from "../src/jobs/queue.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import * as companella from "../src/dan/companella.js";
import * as msd from "../src/dan/msd.js";
import { MsdThreadUnavailableError } from "../src/dan/msd-thread.js";

const NOW = "2026-09-19T00:00:00.000Z";
const MSD = { etternaVersion: "0.72.3", values: { Overall: 20, Stream: 20, Jumpstream: 19,
  Handstream: 18, Stamina: 20, JackSpeed: 19, Chordjack: 18, Technical: 19 } };
function chart(keys = 4): string {
  return ["osu file format v14", "[General]", "Mode:3", "[Difficulty]", `CircleSize:${keys}`,
    "OverallDifficulty:8", "[TimingPoints]", "0,350,4,2,0,100,1,0", "[HitObjects]",
    ...Array.from({ length: 1000 }, (_, i) => `${Math.floor((i % keys + .5) * 512 / keys)},192,${1000 + i * 115},1,0,0:0:0:0:`),
  ].join("\n");
}
async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-companella-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try { await migrate(db); await run(db); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}
async function seed(db: Db, id: number, keys = 4): Promise<void> {
  await storeCachedBeatmapFile(db, id, chart(keys), { source: "test" });
  await exec(db, `insert into beatmaps (beatmap_id, beatmapset_id, mode, cs, version, updated_at)
    values (?, 1, 'mania', ?, 'test', ?)`, [id, keys, NOW]);
  await exec(db, `insert into beatmap_chart_analysis
    (beatmap_id, analysis_version, status, key_count, raw_dan, classification_json, msd_json, computed_at, updated_at)
    values (?, ?, 'ready', ?, 99, ?, ?, ?, ?)`, [id, CHART_ANALYSIS_VERSION, keys,
    JSON.stringify({ primary: { rawDan: 99 }, motion: { preserved: true }, patterns: ["keep"] }), JSON.stringify(MSD), NOW, NOW]);
}
async function rate(db: Db, id: number, percent: number, version = 29, variant?: string, raw = 99): Promise<void> {
  const table = variant ? "dan_mod_estimates" : "dan_estimates";
  await exec(db, `insert into ${table} (estimator_version, beatmap_id, rate_percent, ${variant ? "mod_variant," : ""}
    status, raw_dan, family, display_name, computed_at, updated_at) values (?, ?, ?, ${variant ? "?," : ""} 'ready', ?, 'dan', '10', ?, ?)`,
  [version, id, percent, ...(variant ? [variant] : []), raw, NOW, NOW]);
}
afterEach(() => vi.restoreAllMocks());

describe("Companella input repair", () => {
  it("repairs base, DT/HT, custom rates and OD/player variants without replacing native MSD or current caches", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      const oldRate = JSON.stringify({ primaryLabel: "99", rawDan: 99, vibroAnalysis: { keep: true } });
      await exec(db, `update beatmap_chart_analysis set msd_dt_json = ?, msd_ht_json = ?, dan_dt_json = ?, dan_ht_json = ?`,
        [JSON.stringify(MSD), JSON.stringify(MSD), oldRate, oldRate]);
      await rate(db, 1, 125);
      await rate(db, 1, 125, 28); // Only the newest row per slot is considered.
      await rate(db, 1, 120);
      await rate(db, 1, 120, 30, undefined, 77);
      for (const variant of ["OD:9", "OD:HR", "vibro-adjusted", "vibro-adjusted:OD:EZ"]) await rate(db, 1, 100, 29, variant);
      const execute = vi.spyOn(db, "execute");
      const compute = vi.spyOn(msd, "computeMsd");
      const result = await recomputeCompanellaInputsChunk(db, 0);
      expect(result).toMatchObject({ rewritten: 1, ratesRewritten: 7, done: true });
      expect(compute.mock.calls.some(([, options]) => options?.etternaVersion === "0.74.0")).toBe(true);
      const row = (await exec(db, "select * from beatmap_chart_analysis")).rows[0];
      expect(row.raw_dan).not.toBe(99);
      expect(row.status).toBe("ready");
      expect(row.computed_at).toBe(NOW);
      for (const column of ["msd_json", "msd_dt_json", "msd_ht_json"]) expect(row[column]).toBe(JSON.stringify(MSD));
      expect(JSON.parse(String(row.classification_json))).toMatchObject({ motion: { preserved: true }, patterns: ["keep"] });
      for (const column of ["dan_dt_json", "dan_ht_json"]) {
        expect(JSON.parse(String(row[column]))).toMatchObject({ vibroAnalysis: { keep: true } });
        expect(JSON.parse(String(row[column])).rawDan).not.toBe(99);
      }
      const current = (await exec(db, "select rate_percent, raw_dan from dan_estimates where estimator_version = 30 order by rate_percent")).rows;
      expect(current[0].raw_dan).toBe(77);
      expect(current[1].raw_dan).not.toBe(99);
      const mods = (await exec(db, "select mod_variant, raw_dan from dan_mod_estimates where estimator_version = 30")).rows;
      expect(mods).toHaveLength(4);
      expect(mods.every((r) => r.raw_dan !== 99)).toBe(true);
      const query = execute.mock.calls.map(([arg]) => typeof arg === "string" ? { sql: arg, args: [] } : arg)
        .find((arg) => arg.sql.includes("union all") && arg.sql.includes("dan_mod_estimates"))!;
      const plan = (await db.execute({ ...query, sql: `explain query plan ${query.sql}` })).rows.map((r) => String(r.detail)).join("\n");
      expect(plan).toContain("SEARCH dan_mod_estimates");
      expect(plan).not.toContain("SCAN dan_mod_estimates");
    });
  }, 30_000);

  it("pages over non-4K and rate-only maps; promotes only the unaffected immediate predecessor", async () => {
    await withDb(async (db) => {
      await seed(db, 1, 7);
      await seed(db, 2);
      await exec(db, "delete from beatmap_chart_analysis where beatmap_id = 2");
      await rate(db, 1, 125);
      await rate(db, 1, 125, 30, undefined, 77);
      await rate(db, 1, 120, 28);
      await rate(db, 1, 150, 29, "IN");
      await rate(db, 2, 125, 29, "OD:9");
      const first = await recomputeCompanellaInputsChunk(db, 0, { limit: 1 });
      expect(first).toMatchObject({ nextCursor: 1, scanned: 1, rewritten: 0, done: false });
      expect((await exec(db, "select raw_dan from dan_estimates where estimator_version = 30")).rows.map((r) => r.raw_dan)).toEqual([77]);
      expect((await exec(db, "select estimator_version from dan_mod_estimates where beatmap_id = 1")).rows[0].estimator_version).toBe(30);
      expect(await recomputeCompanellaInputsChunk(db, first.nextCursor)).toMatchObject({ rewritten: 0, ratesRewritten: 1, done: true });
      expect((await exec(db, "select raw_dan from dan_mod_estimates where beatmap_id = 2 and estimator_version = 30")).rows[0].raw_dan).not.toBe(99);
    });
  }, 30_000);

  it("retries worker failures without marking the sweep complete or hiding old results", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      const queue = new JobQueue(db);
      await ensureCompanellaInputsSeeded(db, queue);
      await ensureCompanellaInputsSeeded(db, queue);
      expect((await exec(db, "select 1 from jobs where type = ?", [COMPANELLA_INPUTS_JOB])).rows).toHaveLength(1);
      const compute = vi.spyOn(msd, "computeMsd").mockRejectedValueOnce(new MsdThreadUnavailableError("worker down"));
      await expect(runCompanellaInputsJob(db, queue, { cursor: 0 })).rejects.toThrow("worker down");
      expect((await exec(db, "select 1 from live_meta where key = ?", [COMPANELLA_INPUTS_META_KEY])).rows).toHaveLength(0);
      expect((await exec(db, "select status, raw_dan from beatmap_chart_analysis")).rows[0]).toMatchObject({ status: "ready", raw_dan: 99 });
      compute.mockRestore();
      await runCompanellaInputsJob(db, queue, { cursor: 0 });
      expect((await exec(db, "select 1 from live_meta where key = ?", [COMPANELLA_INPUTS_META_KEY])).rows).toHaveLength(1);
      expect((await exec(db, "select 1 from jobs where type = 'rebuild_map_collections'")).rows).toHaveLength(1);
    });
  }, 30_000);

  it("skips a chart LeoBlack refuses instead of pinning the sweep on it", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      await seed(db, 2);
      await exec(db, `update beatmap_chart_analysis set raw_dan = null, primary_label = null,
        classification_json = '{"supported":false,"primary":null,"warnings":["LeoBlack estimator failed: Beatmap parse failed."]}'
        where beatmap_id = 1`);
      const original = companella.classifyChartWithCompanella;
      vi.spyOn(companella, "classifyChartWithCompanella").mockImplementationOnce(async (...args) => ({
        ...await original(...args), primary: null, rc: null, ln: null, companellaPending: false,
      }));
      const result = await recomputeCompanellaInputsChunk(db, 0);
      expect(result).toMatchObject({ nextCursor: 2, scanned: 2, rewritten: 1, done: true });
      const rows = (await exec(db, "select beatmap_id, raw_dan from beatmap_chart_analysis order by beatmap_id")).rows;
      expect(rows[0]).toMatchObject({ beatmap_id: 1, raw_dan: null });
      expect(rows[1].raw_dan).not.toBe(99);
    });
  }, 30_000);

  it("refuses to overwrite a concurrent chart refresh", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      const original = companella.classifyChartWithCompanella;
      vi.spyOn(companella, "classifyChartWithCompanella").mockImplementationOnce(async (...args) => {
        await exec(db, "update beatmap_chart_analysis set classification_json = '{\"concurrent\":true}'");
        return original(...args);
      });
      await expect(recomputeCompanellaInputsChunk(db, 0)).rejects.toThrow("changed during Companella repair");
      expect((await exec(db, "select classification_json from beatmap_chart_analysis")).rows[0].classification_json).toBe('{"concurrent":true}');
    });
  }, 30_000);
});
