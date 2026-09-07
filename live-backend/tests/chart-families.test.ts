import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import {
  chartTopologyKey, sameChartAtDifferentRate, storeChartFamily,
  recomputeChartFamilyChunk, ensureChartFamilySweepSeeded, runChartFamilySweepJob,
  CHART_FAMILY_META_KEY, CHART_FAMILY_SWEEP_JOB,
} from "../src/features/chart-families.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { CHART_ANALYSIS_VERSION, JACK_DEMAND_RECOMPUTE_META_KEY, MOTION_FEATURES_RECOMPUTE_META_KEY } from "../src/features/chart-analysis.js";
import { getPlayerSkillDanEvidence, loadChartSkillInfo, PLAYER_SKILLS_VERSION, recomputePlayerSkillDanChunk } from "../src/features/player-skills.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";
let db: Db | undefined;
afterEach(async () => {
  db?.close();
  db = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});
async function database(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-chart-families-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

function file(rate = 1, offset = 1000): string {
  const columns = [0, 1, 3, 2, 1, 2, 0, 3];
  const notes = Array.from({ length: 120 }, (_, i) => {
    const column = columns[i % columns.length];
    const time = Math.round(offset + (i * 133.3333 + Math.floor(i / 11) * 250) / rate);
    const hold = i % 9 === 0;
    const end = Math.round(offset + (i * 133.3333 + Math.floor(i / 11) * 250 + 75) / rate);
    return `${64 + column * 128},192,${time},${hold ? 128 : 1},0,${hold ? `${end}:` : ""}0:0:0:0:`;
  });
  return `osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\n[Metadata]\nTitle:Untrusted title\nVersion:Not a rate label\n[HitObjects]\n${notes.join("\n")}\n`;
}

describe("structural chart families", () => {
  it("matches rounded rate edits and shifted offsets without consulting metadata or BPM", () => {
    const base = parseManiaBeatmap(file());
    for (const rate of [0.7, 0.99, 1.01, 1.05, 1.37, 1.5, 2]) {
      const rated = parseManiaBeatmap(file(rate, -250));
      expect(chartTopologyKey(rated)).toBe(chartTopologyKey(base));
      expect(sameChartAtDifferentRate(base, rated)).toBe(true);
      expect(sameChartAtDifferentRate(rated, base)).toBe(true);
    }
  });

  it("requires matching columns, keymode, note count, rhythm and hold endings", () => {
    const base = parseManiaBeatmap(file());
    for (const edit of ["column", "keys", "count", "rhythm", "tail"] as const) {
      const changed = parseManiaBeatmap(file(1.05));
      if (edit === "column") changed.notes[50].column = (changed.notes[50].column + 1) % 4;
      if (edit === "keys") changed.keyCount = 7;
      if (edit === "count") changed.notes.pop();
      if (edit === "rhythm") {
        changed.notes[50].time += 25;
        changed.notes[50].endTime += 25;
        // Topology alone cannot identify this edit.
        expect(chartTopologyKey(changed)).toBe(chartTopologyKey(base));
      }
      if (edit === "tail") changed.notes[45].endTime += 25;
      expect(sameChartAtDifferentRate(base, changed), edit).toBe(false);
    }
  });

  it("declines malformed timing rather than treating NaN comparisons as a match", () => {
    const base = parseManiaBeatmap(file());
    const broken = parseManiaBeatmap(file());
    broken.notes[50].time = Number.NaN;
    expect(chartTopologyKey(broken)).toBeNull();
    expect(sameChartAtDifferentRate(base, broken)).toBe(false);
  });

  it("backfills reuploads into one durable family and exposes it in chart skill reads", async () => {
    const db = await database();
    await storeCachedBeatmapFile(db, 1, file());
    await storeCachedBeatmapFile(db, 2, file(1.05, 500));
    expect(await recomputeChartFamilyChunk(db, 0, 1)).toEqual({ nextCursor: 1, done: false });
    expect(await recomputeChartFamilyChunk(db, 1, 10)).toEqual({ nextCursor: 2, done: true });
    const rows = (await exec(db, "select family_key from beatmap_chart_families order by beatmap_id")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].family_key).toBe(rows[1].family_key);
    for (const id of [1, 2]) await exec(db,
      `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
       values (?, ?, 'ready', '{"rc":{"rawDan":10}}', '2026-09-06')`, [id, CHART_ANALYSIS_VERSION]);
    const info = await loadChartSkillInfo(db, [1, 2]);
    expect(info.get(1)?.chartFamily).toBe(rows[0].family_key);
    expect(info.get(2)?.chartFamily).toBe(rows[0].family_key);
  });

  it("does not attach a changed chart to its old family or trust a stale candidate file", async () => {
    const db = await database();
    const base = file();
    await storeCachedBeatmapFile(db, 1, base);
    await storeChartFamily(db, 1, base);
    await storeCachedBeatmapFile(db, 2, file(1.05));
    await storeChartFamily(db, 2, file(1.05));
    const oldFamily = (await exec(db, "select family_key from beatmap_chart_families where beatmap_id = 1")).rows[0].family_key;
    const changed = base.replace(",1000,128,0,1075:", ",1000,128,0,1100:");
    expect(changed).not.toBe(base);
    await storeCachedBeatmapFile(db, 1, changed);
    await storeChartFamily(db, 1, changed);
    const rows = (await exec(db, "select family_key from beatmap_chart_families order by beatmap_id")).rows;
    expect(rows[0].family_key).not.toBe(oldFamily);
    expect(rows[1].family_key).toBe(oldFamily);
    await storeCachedBeatmapFile(db, 3, file(1.1));
    await storeChartFamily(db, 3, file(1.1));
    expect((await exec(db, "select family_key from beatmap_chart_families where beatmap_id = 3")).rows[0].family_key).toBe(oldFamily);
  });

  it("resumes once and seeds the dan refold after family backfill finishes", async () => {
    const db = await database();
    const queue = new JobQueue(db);
    for (const key of [JACK_DEMAND_RECOMPUTE_META_KEY, MOTION_FEATURES_RECOMPUTE_META_KEY]) {
      await exec(db, "insert into live_meta (key, value_json, updated_at) values (?, '{}', '2026-09-06')", [key]);
    }
    await ensureChartFamilySweepSeeded(db, queue);
    await ensureChartFamilySweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [CHART_FAMILY_SWEEP_JOB])).rows).toHaveLength(1);
    await runChartFamilySweepJob(db, queue, { cursor: 0 });
    expect((await exec(db, "select 1 from live_meta where key = ?", [CHART_FAMILY_META_KEY])).rows).toHaveLength(1);
    expect((await exec(db, "select 1 from jobs where type = 'recompute_player_skill_dan_sweep'")).rows).toHaveLength(1);
    await ensureChartFamilySweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [CHART_FAMILY_SWEEP_JOB])).rows).toHaveLength(1);
  });

  it("ships every weighted contributor and agrees with the persisted dan refold", async () => {
    const db = await database();
    const plays = [];
    for (let id = 1; id <= 22; id += 1) {
      const rawDan = id <= 2 ? 12 : 10;
      await exec(db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
         values (?, ?, 'ready', 4, ?, '2026-09-06')`,
        [id, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, rc: { rawDan } })]);
      if (id <= 2) {
        await storeCachedBeatmapFile(db, id, file(id === 1 ? 1 : 1.05));
        await storeChartFamily(db, id, file(id === 1 ? 1 : 1.05));
      }
      plays.push({ identity: `score:${id}`, beatmapId: id, keyCount: 4, rate: 1, goal: 0.93,
        pp: 0, patterns: [], accuracy: 0.96, stableAccuracy: 0.96, values: { Overall: 20, Chordjack: 20 } });
    }
    await exec(db,
      `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
       values (123, ?, 'ready', ?, ?, '2026-09-06', '2026-09-06')`,
      [PLAYER_SKILLS_VERSION, JSON.stringify({ modes: [{ keyCount: 4, ratings: { Overall: 20 } }] }), JSON.stringify({ plays })]);
    await recomputePlayerSkillDanChunk(db, 0);
    const evidence = (await getPlayerSkillDanEvidence(db, 123, 4, "rc"))!;
    const jack = evidence.skillsets.find((section) => section.id === "jack")!;
    expect(jack.plays).toHaveLength(21);
    expect(jack.weightedClears).toBe(20);
    expect(jack.plays[1].averagingWeight).toBeCloseTo(0.9);
    expect(jack.plays.at(-1)?.averagingWeight).toBeCloseTo(0.1);
    const reconstructed = jack.plays.reduce((sum, play) => sum + play.creditedDan * play.averagingWeight!, 0) / 20;
    expect(jack.dan?.rawDan).toBe(Math.round(reconstructed * 100) / 100);
    const summary = JSON.parse(String((await exec(db, "select modes_json from player_skill_ratings where user_id = 123")).rows[0].modes_json));
    expect(summary.modes[0].dan.rc.rawDan).toBe(evidence.dan?.rawDan);
    expect(summary.modes[0].dan.rc.skillsets.jack.rawDan).toBe(jack.dan?.rawDan);
    const recent = (await getPlayerSkillDanEvidence(db, 123, 4, "rc", undefined, { sort: "recent" }))!;
    expect(recent.skillsets).toEqual(evidence.skillsets);
  });
});
