import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { MARATHON_CORRECTION_JOB, MARATHON_CORRECTION_META_KEY, ensureMarathonCorrectionSeeded,
  recomputeMarathonCorrectionChunk, runMarathonCorrectionJob } from "../src/features/marathon-correction.js";
import { JobQueue } from "../src/jobs/queue.js";
import * as files from "../src/osu/beatmap-file-cache.js";
import * as msd from "../src/dan/msd.js";
import * as companella from "../src/dan/companella.js";

const VALUES = { Overall: 20, Stream: 20, Jumpstream: 19, Handstream: 18,
  Stamina: 20, JackSpeed: 19, Chordjack: 18, Technical: 19 };
const MSD = { etternaVersion: "test", values: VALUES };
const UNBALANCED = { etternaVersion: "test", values: { ...VALUES,
  Stream: 1, Jumpstream: 1, Handstream: 1, Stamina: 1, Technical: 1, Chordjack: 35, JackSpeed: 35 } };
const NOW = "2026-09-09T00:00:00.000Z";

function chart(span = 420, keys = 4): string {
  return ["osu file format v14", "[General]", "Mode:3", "[Difficulty]",
    `CircleSize:${keys}`, "OverallDifficulty:8", "[TimingPoints]", "0,350,4,2,0,100,1,0", "[HitObjects]",
    ...Array.from({ length: 2801 }, (_, i) => `${64 + i % keys * Math.floor(512 / keys)},192,${1000 + Math.round(i * span * 1000 / 2800)},1,0,0:0:0:0:`),
  ].join("\n");
}

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-marathon-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try { await migrate(db); await run(db); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

async function seed(db: Db, id: number, span = 420, keys = 4, metadata = true): Promise<void> {
  await files.storeCachedBeatmapFile(db, id, chart(span, keys), { source: "test" });
  await exec(db, `insert into beatmaps (beatmap_id, beatmapset_id, mode, cs, version, metadata_json, updated_at)
    values (?, 1, 'mania', ?, 'test', ?, ?)`, [id, keys, metadata ? JSON.stringify({ total_length: span + 1 }) : null, NOW]);
  await exec(db, `insert into beatmap_chart_analysis
    (beatmap_id, analysis_version, status, key_count, raw_dan, classification_json, msd_json, computed_at, updated_at)
    values (?, ?, 'ready', ?, 99, ?, ?, ?, ?)`,
  [id, CHART_ANALYSIS_VERSION, keys, JSON.stringify({ primary: { rawDan: 99 }, motion: { preserved: true }, patterns: ["keep"] }), JSON.stringify(MSD), NOW, NOW]);
}

async function rate(db: Db, id: number, percent: number, version = 19, variant?: string, raw = 99): Promise<void> {
  const columns = variant ? ", mod_variant" : "";
  await exec(db, `insert into ${variant ? "dan_mod_estimates" : "dan_estimates"}
    (estimator_version, beatmap_id, rate_percent, status, raw_dan, msd_json, computed_at, updated_at${columns})
    values (?, ?, ?, 'ready', ?, ?, ?, ?${variant ? ", ?" : ""})`,
  [version, id, percent, raw, JSON.stringify({ ...MSD, ...(variant ? { vibroAdjusted: true } : {}) }), NOW, NOW, ...(variant ? [variant] : [])]);
}

afterEach(() => vi.restoreAllMocks());

describe("targeted marathon correction rollout", () => {
  it("advances bounded pages, gates on exact note span, and supports a read-only preview", async () => {
    await withDb(async (db) => {
      await seed(db, 1, 240);
      await seed(db, 2, 420, 7);
      await seed(db, 3, 300, 4, false);
      await seed(db, 4, 301, 4, false);
      await rate(db, 1, 125);
      const read = vi.spyOn(files, "readCachedBeatmapFile");
      const execute = vi.spyOn(db, "execute");
      expect(await recomputeMarathonCorrectionChunk(db, 0, { limit: 2, dryRun: true }))
        .toMatchObject({ nextCursor: 2, scanned: 2, candidates: 0, rewritten: 0, done: false });
      expect(read).not.toHaveBeenCalled();
      const query = execute.mock.calls.map(([arg]) => typeof arg === "string" ? { sql: arg, args: [] } : arg)
        .find((arg) => arg.sql.includes("with page as"))!;
      const plan = (await db.execute({ ...query, sql: `explain query plan ${query.sql}` })).rows.map((r) => String(r.detail)).join("\n");
      expect(plan).toMatch(/(?:rowid|beatmap_id)>\?/);
      expect(plan).not.toContain("status_updated");
      expect(await recomputeMarathonCorrectionChunk(db, 2, { limit: 2, dryRun: true }))
        .toMatchObject({ nextCursor: 4, scanned: 2, candidates: 1, rewritten: 0, done: false });
      expect(await recomputeMarathonCorrectionChunk(db, 4, { limit: 2, dryRun: true }))
        .toMatchObject({ nextCursor: 4, scanned: 0, done: true });
      expect((await exec(db, "select estimator_version from dan_estimates")).rows[0].estimator_version).toBe(19);
      expect((await exec(db, "select raw_dan from beatmap_chart_analysis")).rows.every((r) => r.raw_dan === 99)).toBe(true);
      const statements = execute.mock.calls.map(([arg]) => typeof arg === "string" ? arg : (arg as { sql: string }).sql);
      expect(statements.some((sql) => /^\s*(update|insert|delete|replace)\b/i.test(sql))).toBe(false);
    });
  });

  it("reuses cached MSD for base, DT, HT, custom and player-adjusted rates; preserves unrelated analysis", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      await seed(db, 2, 240);
      await seed(db, 3);
      // Base balance cannot suppress a rate whose skillsets are balanced.
      await exec(db, "update beatmap_chart_analysis set msd_json = ? where beatmap_id = 3", [JSON.stringify(UNBALANCED)]);
      for (const id of [1, 3]) await exec(db, `update beatmap_chart_analysis set msd_dt_json = ?, dan_dt_json = ?,
        msd_ht_json = ?, dan_ht_json = ? where beatmap_id = ?`,
      [JSON.stringify(MSD), JSON.stringify({ rawDan: 99, vibroAnalysis: { keep: true } }), JSON.stringify(MSD), '{"rawDan":99}', id]);
      await rate(db, 1, 125);
      await rate(db, 1, 110, 19, "vibro-adjusted");
      await rate(db, 1, 120, 19);
      await rate(db, 1, 120, 20, undefined, 77);
      const compute = vi.spyOn(msd, "computeMsd").mockRejectedValue(new Error("MSD must be reused"));
      const result = await recomputeMarathonCorrectionChunk(db, 0);
      expect(result).toMatchObject({ candidates: 2, rewritten: 1, ratesRewritten: 6, done: true });
      expect(compute).not.toHaveBeenCalled();
      const rows = (await exec(db, "select beatmap_id, raw_dan, classification_json, msd_json, dan_dt_json, dan_ht_json, computed_at from beatmap_chart_analysis order by beatmap_id")).rows;
      expect(rows[0].raw_dan).not.toBe(99);
      expect(rows[1].raw_dan).toBe(99);
      expect(rows[2].raw_dan).toBe(99);
      expect(JSON.parse(String(rows[0].classification_json))).toMatchObject({ motion: { preserved: true }, patterns: ["keep"] });
      expect(rows[0].computed_at).toBe(NOW);
      expect(rows[0].msd_json).toBe(JSON.stringify(MSD));
      for (const row of [rows[0], rows[2]]) {
        expect(JSON.parse(String(row.dan_dt_json))).toMatchObject({ vibroAnalysis: { keep: true } });
        expect(JSON.parse(String(row.dan_dt_json)).rawDan).not.toBe(99);
        expect(JSON.parse(String(row.dan_ht_json)).rawDan).not.toBe(99);
      }
      expect((await exec(db, "select raw_dan from dan_estimates where estimator_version = 20 and rate_percent = 120")).rows[0].raw_dan).toBe(77);
      expect((await exec(db, "select raw_dan from dan_mod_estimates where estimator_version = 20")).rows[0].raw_dan).not.toBe(99);
    });
  }, 30_000);

  it("includes rate-only charts and carries unaffected v19 entries forward without promoting older results", async () => {
    await withDb(async (db) => {
      await seed(db, 1, 240);
      await seed(db, 2, 420, 7);
      await seed(db, 3);
      await exec(db, "delete from beatmap_chart_analysis where beatmap_id = 3");
      await rate(db, 1, 125);
      await rate(db, 1, 125, 20, undefined, 77);
      await rate(db, 1, 120, 18);
      await rate(db, 1, 115);
      await rate(db, 2, 150, 19, "IN");
      await rate(db, 3, 125);
      expect(await recomputeMarathonCorrectionChunk(db, 0))
        .toMatchObject({ candidates: 1, rewritten: 0, ratesRewritten: 1, done: true });
      const promoted = (await exec(db, "select rate_percent, raw_dan from dan_estimates where beatmap_id = 1 and estimator_version = 20 order by rate_percent")).rows;
      expect(promoted.map((r) => [r.rate_percent, r.raw_dan])).toEqual([[115, 99], [125, 77]]);
      expect((await exec(db, "select estimator_version from dan_mod_estimates")).rows[0].estimator_version).toBe(20);
      expect((await exec(db, "select raw_dan from dan_estimates where beatmap_id = 3 and estimator_version = 20")).rows[0].raw_dan).not.toBe(99);
    });
  }, 30_000);

  it("does not overwrite a concurrent full-analysis refresh", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      const original = companella.classifyChartWithCompanella;
      vi.spyOn(companella, "classifyChartWithCompanella").mockImplementationOnce(async (...args) => {
        await exec(db, "update beatmap_chart_analysis set classification_json = ? where beatmap_id = 1",
          ['{"patterns":["newer"]}']);
        return original(...args);
      });
      await expect(recomputeMarathonCorrectionChunk(db, 0)).rejects.toThrow("changed during marathon repair");
      expect((await exec(db, "select classification_json from beatmap_chart_analysis")).rows[0].classification_json)
        .toBe('{"patterns":["newer"]}');
    });
  }, 30_000);

  it("does not save a partial Companella fallback as a completed rate repair", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      await exec(db, "delete from beatmap_chart_analysis");
      await rate(db, 1, 125);
      const original = companella.classifyChartWithCompanella;
      vi.spyOn(companella, "classifyChartWithCompanella").mockImplementationOnce(async (...args) => ({
        ...await original(...args), companellaPending: true,
      }));
      await expect(recomputeMarathonCorrectionChunk(db, 0)).rejects.toThrow("Companella unavailable");
      expect((await exec(db, "select estimator_version, raw_dan from dan_estimates")).rows)
        .toEqual([expect.objectContaining({ estimator_version: 19, raw_dan: 99 })]);
    });
  }, 30_000);

  it("retries failed charts without advancing or stamping completion, then seeds downstream refreshes once", async () => {
    await withDb(async (db) => {
      await seed(db, 1);
      const queue = new JobQueue(db);
      await ensureMarathonCorrectionSeeded(db, queue);
      await ensureMarathonCorrectionSeeded(db, queue);
      expect((await exec(db, "select type from jobs")).rows.map((r) => r.type)).toEqual([MARATHON_CORRECTION_JOB]);
      const classify = vi.spyOn(companella, "classifyChartWithCompanella").mockRejectedValueOnce(new Error("worker unavailable"));
      await expect(runMarathonCorrectionJob(db, queue, { cursor: 0 })).rejects.toThrow("worker unavailable");
      expect((await exec(db, "select 1 from live_meta where key = ?", [MARATHON_CORRECTION_META_KEY])).rows).toHaveLength(0);
      expect((await exec(db, "select status, raw_dan from beatmap_chart_analysis")).rows[0]).toMatchObject({ status: "ready", raw_dan: 99 });
      classify.mockRestore();
      await runMarathonCorrectionJob(db, queue, { cursor: 0 });
      expect((await exec(db, "select 1 from live_meta where key = ?", [MARATHON_CORRECTION_META_KEY])).rows).toHaveLength(1);
      expect((await exec(db, "select type from jobs where type = 'rebuild_map_collections'")).rows).toHaveLength(1);
      await ensureMarathonCorrectionSeeded(db, queue);
      expect((await exec(db, "select type from jobs where type = ?", [MARATHON_CORRECTION_JOB])).rows).toHaveLength(1);
    });
  }, 30_000);
});
