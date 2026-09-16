import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { DAN_SKILLSET_CHARTS } from "../src/features/dan-skillset-registry.js";
import { danSkillsetFingerprint, danSkillsetMatchStatement, DAN_SKILLSET_BY_FINGERPRINT } from "../src/features/dan-skillset-identity.js";
import { danCourseLevelFor } from "../src/features/dan-courses.js";
import { creditSkillsetPracticeClears, danSideFromClearsForTest, danSideFromClearEvidenceForTest, loadPlayerDanCourseClears, getPlayerSkillDanEvidence, PLAYER_SKILLS_VERSION, recomputePlayerSkillDanChunk, type DanClearEvidence } from "../src/features/player-skills.js";
import { storeCachedBeatmapFile, markCachedBeatmapFileUnavailable } from "../src/osu/beatmap-file-cache.js";
import { recomputeChartFamilyChunk } from "../src/features/chart-families.js";
import type { OsuMod } from "../src/shared/types.js";

const file = (id: number) => readFileSync(new URL(`./fixtures/dan-skillsets/${id}.osu`, import.meta.url), "utf8");
const AQUARIS = file(1887432);
let dir = "";
let db: Db;
afterEach(async () => { db?.close(); if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });
async function setup() {
  dir = await mkdtemp(join(tmpdir(), "mania-skillset-clears-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}
async function score(db: Db, id: number, map: number, mods: OsuMod[] | null = [], accuracy = 0.96, passed = true, checksum?: string) {
  await exec(db, `insert into score_events
    (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
    values (?, ?, 42, 'CR', ?, 3, ?, ?, 1, 0, 0, '2026-09-16T00:00:00Z', '2026-09-16T00:00:00Z', 'osc')`,
  [id, `official:${id}`, map, json({ id, user_id: 42, beatmap_id: map, mods, accuracy, passed, rank: "S", beatmap: { checksum } }), Number(passed)]);
}
async function storedPlayer(db: Db) {
  await exec(db, `insert into player_skill_ratings
    (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
    values (42, ?, 'ready', ?, ?, '2026-09-16', '2026-09-16')`, [PLAYER_SKILLS_VERSION,
    json({ modes: [{ keyCount: 4, analyzedPlays: 0, ratings: { Overall: 0 }, patterns: [] }] }),
    json({ plays: [], danOnly: [] })]);
}

describe("practice chart identity", () => {
  it("matches the two real Aquaris uploads, but excludes the real 1.08 rate", () => {
    const fingerprint = danSkillsetFingerprint(AQUARIS);
    expect(fingerprint).toBe(danSkillsetFingerprint(file(4961182)));
    expect(fingerprint).not.toBe(danSkillsetFingerprint(file(4282465)));
    expect(DAN_SKILLSET_BY_FINGERPRINT.get(fingerprint!)).toMatchObject({ skillset: "jack", level: "delta", od: 9 });
  });
  it("requires identical OD, keymode and every note, while allowing global offsets and metadata edits", () => {
    const hash = danSkillsetFingerprint(AQUARIS);
    expect(danSkillsetFingerprint(AQUARIS.replace("OverallDifficulty:9", "OverallDifficulty:8"))).not.toBe(hash);
    expect(danSkillsetFingerprint(AQUARIS.replace("CircleSize:4", "CircleSize:7"))).not.toBe(hash);
    const shifted = AQUARIS.replace(/^(\d+,\d+,)(\d+)(,.*)$/gm, (_, a, t, b) => `${a}${Number(t) + 2000}${b}`);
    expect(danSkillsetFingerprint(shifted.replace("Aquaris", "Different title"))).toBe(hash);
    const changed = AQUARIS.replace(/^(\d+,\d+,)(\d+)(,.*)$/m, (_, a, t, b) => `${a}${Number(t) + 1}${b}`);
    expect(danSkillsetFingerprint(changed)).not.toBe(hash);
    expect(danSkillsetFingerprint(AQUARIS.replace(/^OverallDifficulty:.*$/m, ""))).toBeNull();
    expect(danSkillsetFingerprint(AQUARIS.replace("OverallDifficulty:9", "OverallDifficulty:9\nOverallDifficulty:8"))).toBeNull();
    expect(danSkillsetFingerprint(AQUARIS.replace("[Difficulty]", "[FakeDifficulty]"))).toBeNull();
  });
  it("preserves hold ends as well as heads", () => {
    const ln = file(3888155);
    const edited = ln.replace(/^(\d+,\d+,\d+,128,\d+,)(\d+):/m, (_, p, end) => `${p}${Number(end) + 1}:`);
    expect(edited).not.toBe(ln);
    expect(danSkillsetFingerprint(edited)).not.toBe(danSkillsetFingerprint(ln));
  });
  it("covers every requested tier, including 7K LN below the estimator table", () => {
    expect(DAN_SKILLSET_CHARTS).toHaveLength(190);
    expect(DAN_SKILLSET_BY_FINGERPRINT.size).toBe(190);
    expect(DAN_SKILLSET_CHARTS.some((c) => c.beatmapId === 4490039 || c.side === "ln" && c.keyCount === 4)).toBe(false);
    for (const c of DAN_SKILLSET_CHARTS) {
      expect(danCourseLevelFor({ ...c, courseName: c.name }), c.name).not.toBeNull();
      expect(c.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const skill of ["jack", "tech", "speed", "stamina"]) {
      expect(new Set(DAN_SKILLSET_CHARTS.filter((c) => c.keyCount === 4 && c.skillset === skill).map((c) => c.level)).size).toBe(17);
    }
    for (const skill of ["jack", "tech", "speed", "stream", "lngeneral", "lninverse", "lntech", "lnrelease"]) {
      expect(new Set(DAN_SKILLSET_CHARTS.filter((c) => c.keyCount === 7 && c.skillset === skill).map((c) => c.level)).size).toBe(15);
    }
  });
});

describe("verified skillset clears", () => {
  it("grants one skill immediately on an arbitrary reupload without granting an overall dan", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    await score(db, 900, 999);
    const clears = await loadPlayerDanCourseClears(db, 42);
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ beatmapId: 999, skillset: "jack", rawDan: 14, accuracy: 0.96 });
    const side = danSideFromClearsForTest(4, "rc", [], new Map(), clears);
    expect(side).toMatchObject({ skillsetsOnly: true, skillsets: { jack: { rawDan: 14, label: "delta", clears: 1, skillsetClear: { beatmapId: 999 } } } });
    expect(side?.courseClear).toBeUndefined();
    expect(danSideFromClearsForTest(7, "rc", [], new Map(), clears)).toBeNull();
    await storedPlayer(db);
    const evidence = await getPlayerSkillDanEvidence(db, 42, 4, "rc");
    expect(evidence?.dan).toBeNull();
    expect(evidence?.skillsets).toEqual([expect.objectContaining({ id: "jack", dan: { rawDan: 14, label: "delta" }, skillsetClear: expect.objectContaining({ beatmapId: 999, scoreId: 900 }) })]);
  });
  it("does not lower an existing stronger skillset", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    await score(db, 900, 999);
    const credentials = await loadPlayerDanCourseClears(db, 42);
    const chartClears = Array.from({ length: 4 }, (_, i) => ({
      play: { identity: `p${i}`, beatmapId: i + 1, keyCount: 4, rate: 1, goal: 0.93, pp: 0, values: { Overall: 35, Chordjack: 36 }, patterns: [] },
      side: "rc", chartDan: 16, chartDanLabel: "zeta", creditedDan: 16, accuracy: 0.96, bar: 0.96, currency: "stable",
    } as DanClearEvidence));
    const result = danSideFromClearEvidenceForTest(4, "rc", chartClears, new Map(), credentials);
    expect(result?.skillsets?.jack.rawDan).toBe(16);
    expect(result?.skillsets?.jack.skillsetClear).toBeUndefined();
  });
  it("credits the clear of the practice chart itself, once, without rerating the chart", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    await score(db, 900, 999);
    const credentials = await loadPlayerDanCourseClears(db, 42);
    // Two rate plays of the same chart plus an unrelated clear: the credential
    // is one credit, so only the strongest play of the practice chart takes it.
    const clear = (beatmapId: number, rate: number, creditedDan: number): DanClearEvidence => ({
      play: { identity: `p${beatmapId}:${rate}`, beatmapId, keyCount: 4, rate, goal: 0.93, pp: 0, values: { Overall: 20, Chordjack: 21 }, patterns: [] },
      side: "rc", chartDan: creditedDan, chartDanLabel: "7", creditedDan, accuracy: 0.96, bar: 0.96, currency: "stable",
    } as DanClearEvidence);
    const credited = creditSkillsetPracticeClears(
      [clear(999, 1, 7.4), clear(999, 1.1, 7.1), clear(7, 1, 7.4)], credentials, 4, "jack",
    );
    expect(credited.map((entry) => entry.creditedDan)).toEqual([14, 7.1, 7.4]);
    expect(credited[0].chartDan).toBe(7.4);
    expect(credited[0].credential).toEqual({ level: "delta", courseName: "Aquaris ~ Delta ~ (Marathon)" });
    expect(credited[1].credential).toBeUndefined();
    // A different keymode's ladder never sees the credit.
    expect(creditSkillsetPracticeClears([clear(999, 1, 7.4)], credentials, 7, "jack")[0].creditedDan).toBe(7.4);
  });
  it.each([
    { keys: 7, side: "ln" as const, skillset: "lnrelease", other: "lngeneral", level: "gamma", credit: 11, accuracy: 0.95 },
    { keys: 4, side: "rc" as const, skillset: "tech", other: "stamina", level: "delta", credit: 14, accuracy: 0.96 },
  ])("keeps $skillset credentials out of the shared $other tile and all-clears credit", async ({ keys, side, skillset, other, level, credit, accuracy }) => {
    const db = await setup();
    const reference = DAN_SKILLSET_CHARTS.find((chart) => chart.keyCount === keys && chart.skillset === skillset && chart.level === level)!;
    // Identity matching is tested against real files above. Here an arbitrary
    // verified reupload shares ordinary evidence with another skillset.
    await exec(db, "insert into dan_skillset_chart_matches (beatmap_id, fingerprint, checksum) values (999, ?, 'verified')", [reference.fingerprint]);
    await score(db, 900, 999, [], accuracy);
    const plays = [999, 1000, 1001, 1002].map((id) => ({
      identity: `official:${id === 999 ? 900 : id}`, beatmapId: id, keyCount: keys,
      rate: 1, goal: 0.95, pp: 100, accuracy, stableAccuracy: accuracy,
      values: keys === 4 ? { Overall: 25, Stamina: 25, Technical: 24.9, Stream: 1 } : { Overall: 25 }, patterns: [],
    }));
    for (const play of plays) {
      await exec(db, `insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at)
        values (?, 1, 'mania', 'test', ?, '2026-09-16')`, [play.beatmapId, json({ total_length: 300, accuracy: 9 })]);
      await exec(db, `insert into beatmap_chart_analysis (beatmap_id, analysis_version, key_count, status, classification_json, updated_at)
        values (?, ?, ?, 'ready', ?, '2026-09-16')`, [play.beatmapId, CHART_ANALYSIS_VERSION, keys, json({
        lnRatio: side === "ln" ? 0.8 : 0,
        [side]: { rawDan: 5 },
        patterns: side === "ln" ? [{ id: "lnrelease", score: 1 }, { id: "ln", score: 1 }] : [],
        ...(keys === 4 ? { motion: {
          sameHand: 0.2302, miniJack: 0.0020, anchor: 0.0114, oneHandTrill: 0.0117, crossHandTrill: 0.0780,
          roll4: 0.0798, rhythmBreak: 0.0391, chordSwing: 0.2609, densitySwing: 0.3895,
        } } : {}),
      })]);
    }
    await storedPlayer(db);
    await exec(db, "update player_skill_ratings set modes_json = ?, plays_json = ? where user_id = 42", [
      json({ modes: [{ keyCount: keys, analyzedPlays: 4, ratings: { Overall: 25 }, patterns: [] }] }), json({ plays }),
    ]);
    await recomputePlayerSkillDanChunk(db, 0, 10);
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 42")).rows[0];
    const stored = JSON.parse(String(row.modes_json)).modes[0].dan[side];
    expect(stored.skillsets[skillset].rawDan).toBe(credit);
    expect(stored.skillsets[other].rawDan).toBe(5);
    expect(stored.skillsets[other].skillsetClear).toBeUndefined();
    const evidence = await getPlayerSkillDanEvidence(db, 42, keys, side);
    const target = evidence!.skillsets.find((tile) => tile.id === skillset)!;
    const shared = evidence!.skillsets.find((tile) => tile.id === other)!;
    expect(target.dan?.rawDan).toBe(credit);
    expect(shared.dan?.rawDan).toBe(5);
    expect(target.plays.find((clear) => clear.play.beatmapId === 999)).toMatchObject({ creditedDan: credit, chartDan: 5, credential: { level } });
    expect(shared.plays.find((clear) => clear.play.beatmapId === 999)).toMatchObject({ creditedDan: 5, chartDan: 5 });
    expect(shared.plays.find((clear) => clear.play.beatmapId === 999)?.credential).toBeUndefined();
    expect(evidence!.clears.find((clear) => clear.play.beatmapId === 999)?.creditedDan).toBe(5);
    expect(evidence!.clears.find((clear) => clear.play.beatmapId === 999)?.credential).toBeUndefined();
  });
  it("rejects lower rates, wrong OD, failed/sub-bar plays, missing mods and altered judgement conditions", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 1, AQUARIS);
    await storeCachedBeatmapFile(db, 2, file(4282465));
    await storeCachedBeatmapFile(db, 3, AQUARIS.replace("OverallDifficulty:9", "OverallDifficulty:8"));
    await score(db, 1, 2); await score(db, 2, 3);
    await score(db, 3, 1, [], 0.95999); await score(db, 4, 1, [], 0.99, false);
    await score(db, 5, 1, null);
    let id = 10;
    for (const mod of ["HR", "EZ", "NF", "HT", "DC", "DA", "HO", "IN", "NR", "RD", "AT", "CN", "7K", "UNKNOWN"]) await score(db, id++, 1, [{ acronym: mod }]);
    await score(db, id++, 1, [{ acronym: "DT", settings: { speed_change: 0.9 } }]);
    await score(db, id++, 1, [], 0.99, true, "00000000000000000000000000000000");
    expect(await loadPlayerDanCourseClears(db, 42)).toEqual([]);
    await score(db, id++, 1, [{ acronym: "MR" }, { acronym: "HD" }]);
    expect(await loadPlayerDanCourseClears(db, 42)).toHaveLength(1);
  });
  it("removes a match atomically when an upload changes OD or notes", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    await score(db, 900, 999);
    expect(await loadPlayerDanCourseClears(db, 42)).toHaveLength(1);
    await storeCachedBeatmapFile(db, 999, AQUARIS.replace("OverallDifficulty:9", "OverallDifficulty:8"), { repairDerivatives: true });
    expect(await loadPlayerDanCourseClears(db, 42)).toEqual([]);
  });
  it("does not let an older sweep read overwrite a newer file match", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    const staleDelete = danSkillsetMatchStatement(999, AQUARIS.replace("OverallDifficulty:9", "OverallDifficulty:8"), "2000-01-01");
    await exec(db, staleDelete.sql, staleDelete.args);
    await score(db, 900, 999);
    expect(await loadPlayerDanCourseClears(db, 42)).toHaveLength(1);
    await markCachedBeatmapFileUnavailable(db, 999);
    const staleInsert = danSkillsetMatchStatement(999, AQUARIS, "2000-01-01");
    await exec(db, staleInsert.sql, staleInsert.args);
    expect(await loadPlayerDanCourseClears(db, 42)).toEqual([]);
  });
  it("recovers cached reuploads in the family sweep without fetching files", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    await exec(db, "delete from dan_skillset_chart_matches");
    await recomputeChartFamilyChunk(db, 0, 10);
    await score(db, 900, 999);
    expect(await loadPlayerDanCourseClears(db, 42)).toHaveLength(1);
  });
  it("requires pass proof for the exact archived best score", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    await exec(db, `insert into player_activity_maps (country,user_id,day,beatmap_id,play_count,best_accuracy,best_mods_json,best_score_id,best_solo_score_id,updated_at)
      values ('CR',42,'2026-09-01',999,2,0.96,'[]',900,1900,'2026-09-01')`);
    await exec(db, `insert into player_activity_score_refs (country,score_identity,user_id,day,beatmap_id,passed,ended_at,created_at)
      values ('CR','official:901',42,'2026-09-01',999,1,'2026-09-01','2026-09-01')`);
    expect(await loadPlayerDanCourseClears(db, 42)).toEqual([]);
    await exec(db, "update player_activity_score_refs set score_identity = 'official:900'");
    expect(await loadPlayerDanCourseClears(db, 42)).toHaveLength(1);
  });
  it("credits the 7K LN 0th reference at its actual level", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 111, file(3888155));
    await score(db, 900, 111, [], 0.95);
    const clears = await loadPlayerDanCourseClears(db, 42);
    expect(clears[0]).toMatchObject({ rawDan: 0, skillset: "lninverse" });
    expect(danSideFromClearsForTest(7, "ln", [], new Map(), clears)?.skillsets?.lninverse.label).toBe("0");
  });
  it("backfills a skillset-only player even with no retained SSR plays", async () => {
    const db = await setup();
    await storeCachedBeatmapFile(db, 999, AQUARIS);
    await score(db, 900, 999);
    await storedPlayer(db);
    await recomputePlayerSkillDanChunk(db, 0, 10);
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 42")).rows[0];
    expect(JSON.parse(String(row.modes_json)).modes[0].dan?.rc?.skillsets?.jack?.label).toBe("delta");
  });
});
