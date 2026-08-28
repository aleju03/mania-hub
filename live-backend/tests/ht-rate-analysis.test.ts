import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import {
  CHART_ANALYSIS_VERSION,
  HT_RATE_ANALYSIS_JOB,
  HT_RATE_ANALYSIS_META_KEY,
  ensureHtRateAnalysisSeeded,
  recomputeHtRateChunk,
  runHtRateAnalysisJob,
} from "../src/features/chart-analysis.js";
import { PLAYER_SKILL_DAN_SWEEP_JOB, ensurePlayerSkillDanSweepSeeded, loadChartSkillInfo } from "../src/features/player-skills.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-ht-rate-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function seedAnalysis(db: Db, beatmapId: number, extra: { ht?: unknown } = {}): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, raw_dan, classification_json, dan_dt_json, dan_ht_json, updated_at)
     values (?, ?, 'ready', 4, 12.0, json(?), json(?), ${extra.ht === undefined ? "null" : "json(?)"}, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      json({ lnRatio: 0, patterns: [], rc: { rawDan: 12.0 } }),
      json({ rawDan: 14.5, primaryFamily: "dan" }),
      ...(extra.ht === undefined ? [] : [json(extra.ht)]),
      "2026-08-20T00:00:00.000Z",
    ] as never,
  );
}

describe("HT rate analysis", () => {
  it("exposes the 0.75x verdict and its side on the chart skill info", async () => {
    const db = await makeDb();
    await seedAnalysis(db, 501, { ht: { rawDan: 8.4, primaryFamily: "dan" } });
    await seedAnalysis(db, 502, { ht: { rawDan: 7.1, primaryFamily: "ln" } });
    await seedAnalysis(db, 503);

    const info = await loadChartSkillInfo(db, [501, 502, 503]);
    // The HT verdict sits well under the chart's own 12.0, which is the point.
    expect(info.get(501)).toMatchObject({ htRawDan: 8.4, htFamily: "rc", rcRawDan: 12, dtRawDan: 14.5 });
    expect(info.get(502)).toMatchObject({ htRawDan: 7.1, htFamily: "ln" });
    // No sweep yet for this chart: nothing to credit an HT clear against.
    expect(info.get(503)).toMatchObject({ htRawDan: null, htFamily: null });
    db.close();
  });

  it("only picks up charts someone is recorded playing slowed down", async () => {
    const db = await makeDb();
    for (const beatmapId of [601, 602, 603]) await seedAnalysis(db, beatmapId);
    // 601 seen HT in farmed scores, 602 seen DC in tracked activity, 603 never.
    await exec(
      db,
      `insert into country_maps_farmed_scores (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, detected_at, updated_at, key_count)
       values ('CR', 1, 601, 1, 100, json(?), json(?), ?, ?, 4)`,
      [json({}), json([{ acronym: "HT" }]), "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z"],
    );
    await exec(
      db,
      `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_accuracy, best_mods_json, updated_at)
       values ('CR', 1, '2026-08-20', 602, 1, 0.99, json(?), ?)`,
      [json([{ acronym: "DC" }]), "2026-08-20T00:00:00.000Z"],
    );

    // No cached .osu in this fixture, so nothing computes; what is asserted is
    // the scope, which is the part that decides how big the sweep is.
    const result = await recomputeHtRateChunk(db, 0);
    expect(result.scanned).toBe(2);
    expect(result.computed).toEqual([]);
    db.close();
  });

  it("stamps done and stops seeding once the corpus is swept", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    expect(await runHtRateAnalysisJob(db, queue, { cursor: 0 })).toBe(true);
    const done = (await exec(db, "select value_json from live_meta where key = ?", [HT_RATE_ANALYSIS_META_KEY])).rows[0];
    expect(done).toBeTruthy();

    await ensureHtRateAnalysisSeeded(db, queue);
    const jobs = (await exec(db, "select count(*) c from jobs where type = ?", [HT_RATE_ANALYSIS_JOB])).rows[0];
    expect(Number(jobs.c)).toBe(0);
    db.close();
  });

  it("re-seeds a finished dan sweep once HT verdicts land, but not otherwise", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    // A dan sweep that already finished, before any HT verdicts existed.
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, json(?), ?)",
      ["player_skill_dan_sweep_done:v12", json({ finishedAt: "2026-08-20T00:00:00.000Z" }), "2026-08-20T00:00:00.000Z"],
    );
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    expect(Number((await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0].c)).toBe(0);

    // HT finishes after it, so the stored dans are stale and it runs again.
    expect(await runHtRateAnalysisJob(db, queue, { cursor: 0 })).toBe(true);
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    expect(Number((await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0].c)).toBe(1);
    db.close();
  });
});
