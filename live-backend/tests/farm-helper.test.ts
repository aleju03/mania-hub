import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { buildFarmHelperSnapshotForBacktest, computeAccBenchmarkScale, computeSurvival, FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperSnapshot, invalidateFarmHelperCacheForUser, SURVIVAL_CLEAR_RISK_MAX } from "../src/features/farm-helper.js";
import { ACC_MODEL_PRIOR_TYPICAL_ACC, ACC_MODEL_VERSION, predictPlayerAccuracy, type AccModelMode, type PlayerAccModel } from "../src/features/player-acc-model.js";
import { PLAYER_SKILLS_VERSION } from "../src/features/player-skills.js";
import { getScoreSpeedBucket } from "../src/shared/score.js";
import { SKILL_BASELINE_VERSION } from "../src/features/skill-baseline.js";
import { calculateManiaCustomAccuracy, calculateWeightedPpTotal, nowIso } from "../src/shared/score.js";
import { OsuApiError, type OsuApiClient } from "../src/osu/client.js";
import type { OscScore, OsuMod, OsuScoreStatistics } from "../src/shared/types.js";

let dir = "";
let db: Db;

const SUBJECT_ID = 1;
const SUBJECT_PP = 5000;
const BM_IMPROVE = 10;
const BM_STALE = 11;
const BM_MISSING = 12;
const BM_PUSH = 13;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-farm-helper-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function subjectScore(
  beatmapId: number,
  pp: number,
  endedAt: string,
  keys = 4,
  stars = 5,
  mods: string[] = [],
  statistics: OsuScoreStatistics = {},
): OscScore {
  return {
    id: beatmapId,
    user_id: SUBJECT_ID,
    accuracy: 0.99,
    mods: mods.map((acronym): OsuMod => ({ acronym })),
    score: 1_000_000,
    max_combo: 1000,
    passed: true,
    rank: "S",
    statistics,
    pp,
    beatmap_id: beatmapId,
    beatmap: {
      id: beatmapId,
      beatmapset_id: beatmapId + 100,
      difficulty_rating: stars,
      mode: "mania",
      cs: keys,
      bpm: 180,
      version: "Insane",
      url: `https://osu.ppy.sh/b/${beatmapId}`,
    },
    ended_at: endedAt,
  };
}

// Judgement counts hitting a target 320-weighted custom accuracy exactly using
// only Perfect/300 judgements: acc = 1 - great / (16 * total).
function statsForCustomAcc(acc: number, total = 1000): OsuScoreStatistics {
  const great = Math.round(16 * total * (1 - acc));
  return { count_geki: total - great, count_300: great };
}

function buildSubjectBestScores(): OscScore[] {
  const recent = "2024-06-01T00:00:00Z";
  const old = "2022-01-01T00:00:00Z";
  const scores: OscScore[] = [
    subjectScore(990, 700, recent), // their #1, keeps the cap above all benchmarks
    subjectScore(BM_IMPROVE, 400, recent), // below peer median -> "improve"
    subjectScore(BM_STALE, 600, old), // old PB, headroom at p75 -> "stale"
  ];
  for (let i = 0; i < 30; i += 1) {
    scores.push(subjectScore(900 + i, 500 - i * 5, recent));
  }
  return scores;
}

function makeOsuStub(
  bestScores: OscScore[],
  pp = SUBJECT_PP,
  variantPps: Partial<Record<"4k" | "7k", number>> = {},
): Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow"> {
  const variants = Object.entries(variantPps).map(([variant, variantPp]) => ({
    mode: "mania",
    variant,
    pp: variantPp,
    global_rank: null,
    country_rank: null,
  }));
  const user = {
    id: SUBJECT_ID,
    username: "Subject",
    avatar_url: "https://a.ppy.sh/1",
    country_code: "CR",
    statistics: { pp, variants },
  };
  return {
    getUser: async () => user,
    getUserByKey: async () => user,
    getUserBestScoresWindow: async () => bestScores,
  } as unknown as Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow">;
}

let nextScoreId = 1;

async function insertUser(id: number, pp: number, country: string, username = `Peer${id}`): Promise<void> {
  await exec(
    db,
    "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
    [id, username, `https://a.ppy.sh/${id}`, country, pp, nowIso()],
  );
}

async function insertFarmed(
  country: string,
  userId: number,
  beatmapId: number,
  pp: number,
  updatedAt: string,
  mods: string[] = [],
  playedAt = updatedAt,
  accuracy: number | null = null,
): Promise<void> {
  // Mirrors the real writers: the lane columns (speed_bucket / mods_key) are
  // stored at write time and the aggregation reads them instead of mods_json.
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, accuracy, speed_bucket, mods_key)
     values (?, ?, ?, ?, ?, '{}', ?, null, ?, ?, ?, ?, ?, ?)`,
    [
      country, userId, beatmapId, nextScoreId++, pp, JSON.stringify(mods), playedAt, updatedAt, updatedAt, accuracy,
      getScoreSpeedBucket(mods), mods.join(","),
    ],
  );
}

async function insertBeatmapMeta(beatmapId: number, keys = 4, stars = 5): Promise<void> {
  const setId = beatmapId + 100;
  const now = nowIso();
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
     values (?, ?, 'mania', 'ranked', ?, ?, 180, 120, 'Insane', ?, ?)`,
    [beatmapId, setId, keys, stars, `https://osu.ppy.sh/b/${beatmapId}`, now],
  );
  await exec(
    db,
    `insert into maps_beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
     values (?, ?, 'Artist', 'Mapper', 'ranked', ?, 1000, 10, '', 180, ?, '[]', ?)`,
    [setId, `Map ${beatmapId}`, JSON.stringify({ list: `cover-${beatmapId}` }), JSON.stringify([keys]), now],
  );
}

// Pattern-mix order: jack, stream, jumpstream, handstream, stamina, chordjack, tech, ln.
async function insertSearchIndex(beatmapId: number, pat: number[], keyCount = 4, msdValues?: Record<string, number>): Promise<void> {
  const msdJson = msdValues ? JSON.stringify({ etternaVersion: "test", values: { ...msdValues, Overall: Math.max(...Object.values(msdValues)) } }) : null;
  const msdOverall = msdValues ? Math.max(...Object.values(msdValues)) : null;
  await exec(
    db,
    `insert into map_search_index
       (beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version, search_text,
        key_count, stars, bpm, length, status, primary_pattern,
        pat_jack, pat_stream, pat_jumpstream, pat_handstream, pat_stamina, pat_chordjack, pat_tech, pat_ln,
        msd_json, msd_overall, updated_at)
     values (?, ?, 1, ?, 'Artist', 'Mapper', 'Insane', '', ?, 5, 180, 120, 'ranked', 'stream',
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       pat_jack = excluded.pat_jack, pat_stream = excluded.pat_stream, pat_jumpstream = excluded.pat_jumpstream,
       pat_handstream = excluded.pat_handstream, pat_stamina = excluded.pat_stamina, pat_chordjack = excluded.pat_chordjack,
       pat_tech = excluded.pat_tech, pat_ln = excluded.pat_ln, msd_json = excluded.msd_json, msd_overall = excluded.msd_overall`,
    [beatmapId, beatmapId + 100, `Map ${beatmapId}`, keyCount, ...pat, msdJson, msdOverall, nowIso()],
  );
}

// Rate-adjusted (1.5x/DT) MSD for a 4K chart, in the beatmap_chart_analysis
// row the DT feasibility gate reads via readDtRateMsd.
async function insertDtRateAnalysis(beatmapId: number, msdValues: Record<string, number>): Promise<void> {
  const msdJson = JSON.stringify({ etternaVersion: "test", values: { ...msdValues, Overall: Math.max(...Object.values(msdValues)) } });
  const danJson = JSON.stringify({ primaryLabel: null, primaryFamily: null, rawDan: null });
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, msd_dt_json, dan_dt_json, updated_at)
     values (?, 1, 'ready', 4, ?, ?, ?)`,
    [beatmapId, msdJson, danJson, nowIso()],
  );
}

interface SeededSkillMode {
  keyCount: number;
  analyzedPlays: number;
  ratings: Record<string, number>;
  patterns?: Array<{ id: string; rating: number; plays: number }>;
}

async function seedSubjectSkillModes(userId: number, modes: SeededSkillMode[]): Promise<void> {
  const analyzedPlays = modes.reduce((sum, mode) => sum + mode.analyzedPlays, 0);
  const modesJson = JSON.stringify({
    totalPlays: analyzedPlays,
    analyzedPlays,
    pendingPlays: 0,
    unsupportedPlays: 0,
    modes: modes.map((mode) => ({
      keyCount: mode.keyCount,
      analyzedPlays: mode.analyzedPlays,
      ratings: mode.ratings,
      patterns: mode.patterns ?? [],
    })),
  });
  const now = nowIso();
  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, plays_json, modes_json, computed_at, updated_at)
     values (?, ?, 'ready', '[]', ?, ?, ?)`,
    [userId, PLAYER_SKILLS_VERSION, modesJson, now, now],
  );
}

async function seedSubjectSkillRatings(userId: number, keyCount: number, ratings: Record<string, number>, analyzedPlays: number): Promise<void> {
  await seedSubjectSkillModes(userId, [{ keyCount, analyzedPlays, ratings }]);
}

const stubQueue = { enqueue: async () => {} } as unknown as Parameters<typeof getFarmHelperSnapshot>[4];

async function seedBaselineVector(
  userId: number,
  keyCount: number,
  ratings: Record<string, number>,
  analyzedPlays: number,
  latestPlayedAt: string,
): Promise<void> {
  await exec(
    db,
    `insert into player_skill_baseline (user_id, key_count, baseline_version, analyzed_plays, ratings_json, latest_played_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [userId, keyCount, SKILL_BASELINE_VERSION, analyzedPlays, JSON.stringify(ratings), latestPlayedAt, nowIso()],
  );
}

// The merged "any" view runs the concrete 4k pipeline, whose peer pool only
// admits players with at least KEYMODE_MIN_PROXY_SCORES (8) farmed 4K maps. These
// filler maps are ones buildSubjectBestScores already owns at ~480-500pp, so
// peers who farm them at 300pp qualify for the 4K pool without those maps ever
// surfacing as recommendations (the subject owns them competitively -> dropped in
// the gain view). Distinct from BM_IMPROVE/STALE/MISSING and any per-test ids.
const FILLER_4K = [900, 901, 902, 903, 904, 905, 906];

async function seedFiller4kMeta(): Promise<void> {
  for (const beatmapId of FILLER_4K) await insertBeatmapMeta(beatmapId, 4, 5);
}

// Farms every filler map for one peer so they clear the 4K pool's farm-count
// floor. playedAt is overridable for backtest cutoff tests.
async function farmFiller4k(country: string, id: number, playedAt = nowIso()): Promise<void> {
  for (const beatmapId of FILLER_4K) await insertFarmed(country, id, beatmapId, 300, playedAt, [], playedAt);
}

async function seedPeers(): Promise<void> {
  const recent = nowIso();
  await seedFiller4kMeta();
  for (let i = 0; i < 15; i += 1) {
    const id = 100 + i;
    const country = i < 8 ? "CR" : "US"; // two countries -> exercises global aggregation
    await insertUser(id, SUBJECT_PP, country);
    await insertFarmed(country, id, BM_IMPROVE, 600, recent); // median 600 (subject only 400)
    await insertFarmed(country, id, BM_MISSING, 620, recent); // median 620 (subject missing)
    await insertFarmed(country, id, BM_STALE, i < 10 ? 600 : 660, recent); // median 600, p75 660
    await farmFiller4k(country, id, recent); // qualify for the concrete 4K pool
  }
  await insertBeatmapMeta(BM_IMPROVE);
  await insertBeatmapMeta(BM_STALE);
  await insertBeatmapMeta(BM_MISSING);
}

function expectedGain(bestScores: OscScore[], beatmapId: number, benchmark: number): number {
  const baseline = bestScores
    .filter((s) => typeof s.pp === "number" && (s.pp ?? 0) > 0)
    .map((s) => ({ pp: s.pp as number, beatmapId: s.beatmap_id ?? 0 }));
  const baseTotal = calculateWeightedPpTotal(baseline);
  const hypothetical = baseline.filter((e) => e.beatmapId !== beatmapId).map((e) => ({ pp: e.pp }));
  hypothetical.push({ pp: benchmark });
  return Math.max(0, calculateWeightedPpTotal(hypothetical) - baseTotal);
}

// Mirrors the snapshot's headline total: one simulation inserting every rec's
// benchmark at once (best lane per map), not a sum of independent gains.
function expectedCombinedGain(bestScores: OscScore[], recs: Array<{ beatmapId: number; benchmarkPp: number }>): number {
  const baseline = bestScores
    .filter((s) => typeof s.pp === "number" && (s.pp ?? 0) > 0)
    .map((s) => ({ pp: s.pp as number, beatmapId: s.beatmap_id ?? 0 }));
  const baseTotal = calculateWeightedPpTotal(baseline);
  const benchByMap = new Map<number, number>();
  for (const rec of recs) benchByMap.set(rec.beatmapId, Math.max(rec.benchmarkPp, benchByMap.get(rec.beatmapId) ?? 0));
  const hypothetical = baseline.filter((e) => !benchByMap.has(e.beatmapId)).map((e) => ({ pp: e.pp }));
  for (const benchmark of benchByMap.values()) hypothetical.push({ pp: benchmark });
  return Math.max(0, calculateWeightedPpTotal(hypothetical) - baseTotal);
}

describe("farm helper", () => {
  it("recommends missing, improve and stale farm maps with sane gains", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");

    expect(snapshot.status).toBe("ready");
    expect(snapshot.userId).toBe(SUBJECT_ID);
    expect(snapshot.keyMode).toBe("any");
    expect(snapshot.peerBand.count).toBe(15);
    expect(snapshot.peerBand.farmDataCount).toBe(15);
    expect(snapshot.recs.length).toBe(3);

    const byBeatmap = new Map(snapshot.recs.map((rec) => [rec.beatmapId, rec]));

    const missing = byBeatmap.get(BM_MISSING);
    expect(missing?.reason).toBe("missing");
    expect(missing?.subjectPp).toBeNull();
    expect(missing?.peerCount).toBe(15);
    expect(missing?.peerSampleSize).toBe(15);

    const improve = byBeatmap.get(BM_IMPROVE);
    expect(improve?.reason).toBe("improve");
    expect(improve?.subjectPp).toBe(400);

    const stale = byBeatmap.get(BM_STALE);
    expect(stale?.reason).toBe("stale");
    expect(stale?.subjectPp).toBe(600);
    expect(stale?.benchmarkPp).toBeGreaterThan(600);

    for (const rec of snapshot.recs) {
      expect(rec.estimatedPpGain).toBeGreaterThan(0);
      const expected = Math.round(expectedGain(bestScores, rec.beatmapId, rec.benchmarkPp) * 100) / 100;
      expect(rec.estimatedPpGain).toBeCloseTo(expected, 2);
      expect(rec.cover).toBe(`cover-${rec.beatmapId}`);
    }

    // The headline total is a combined simulation (all benchmarks inserted at
    // once), so it never exceeds the naive per-rec sum.
    expect(snapshot.totalPotentialPp).toBeCloseTo(expectedCombinedGain(bestScores, snapshot.recs), 2);
    expect(snapshot.totalPotentialPp).toBeLessThanOrEqual(
      snapshot.recs.reduce((sum, rec) => sum + rec.estimatedPpGain, 0) + 0.01,
    );

    expect(missing?.topPeers.length).toBeGreaterThan(0);
    expect(missing?.topPeers[0]?.username).toMatch(/^Peer/);
  });

  it("offers a push target for an owned strong score with no peers above", async () => {
    const recent = "2024-06-01T00:00:00Z";
    const bestScores = buildSubjectBestScores();
    // The #1's high accuracy sets the demonstrated-best cap above the push target.
    bestScores[0] = subjectScore(990, 700, recent, 4, 5, [], statsForCustomAcc(0.99));
    bestScores.push(subjectScore(BM_PUSH, 400, recent, 4, 5, [], statsForCustomAcc(0.97)));
    await seedPeers();
    await insertBeatmapMeta(BM_PUSH);
    // Every peer farms the map BELOW the subject's 400pp: no improve, no stale.
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_PUSH, 395, nowIso());
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const push = snapshot.recs.find((rec) => rec.beatmapId === BM_PUSH);

    expect(push?.reason).toBe("push");
    expect(push?.subjectPp).toBe(400);
    // pp is linear in (5*acc - 4): target = own pp rescaled a fixed accuracy step up.
    const accNow = calculateManiaCustomAccuracy(statsForCustomAcc(0.97))!;
    const targetAcc = accNow + 0.0075;
    const expectedBenchmark = 400 * (5 * targetAcc - 4) / (5 * accNow - 4);
    expect(push?.benchmarkPp).toBeCloseTo(expectedBenchmark, 1);
    expect(push?.estimatedPpGain).toBeCloseTo(expectedGain(bestScores, BM_PUSH, expectedBenchmark), 1);
    // Fixture scores without judgement counts never push: the only recs are the
    // three peer-driven ones plus this push target.
    expect(snapshot.recs.length).toBe(4);
  });

  it("does not push a score already at the player's demonstrated best accuracy", async () => {
    const recent = "2024-06-01T00:00:00Z";
    const bestScores = buildSubjectBestScores();
    // The only stat-bearing score IS the demonstrated best: the accuracy cap
    // (best + headroom) leaves less than the minimum meaningful delta. At 700pp
    // even that capped delta would clear the pp margin, so an absent rec proves
    // the accuracy guardrail (not the margin gate) blocked it.
    bestScores.push(subjectScore(BM_PUSH, 700, recent, 4, 5, [], statsForCustomAcc(0.97)));
    await seedPeers();
    await insertBeatmapMeta(BM_PUSH);
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_PUSH, 600, nowIso());
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(snapshot.recs.find((rec) => rec.beatmapId === BM_PUSH)).toBeUndefined();
  });

  it("never replaces an improve or stale reason with push", async () => {
    const recent = "2024-06-01T00:00:00Z";
    const old = "2022-01-01T00:00:00Z";
    const bestScores = buildSubjectBestScores();
    // Give the improve/stale scores judgement counts so push COULD fire on them
    // if the branch order were wrong.
    bestScores[1] = subjectScore(BM_IMPROVE, 400, recent, 4, 5, [], statsForCustomAcc(0.97));
    bestScores[2] = subjectScore(BM_STALE, 600, old, 4, 5, [], statsForCustomAcc(0.97));
    bestScores[0] = subjectScore(990, 700, recent, 4, 5, [], statsForCustomAcc(0.99));
    await seedPeers();

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const byBeatmap = new Map(snapshot.recs.map((rec) => [rec.beatmapId, rec]));

    expect(byBeatmap.get(BM_IMPROVE)?.reason).toBe("improve");
    expect(byBeatmap.get(BM_STALE)?.reason).toBe("stale");
    expect(snapshot.recs.filter((rec) => rec.reason === "push").length).toBe(0);
  });

  it("drops push targets below the minimum visible gain", async () => {
    const recent = "2024-06-01T00:00:00Z";
    // A deep baseline: the owned 300pp map sits past position 60, so its
    // ~13pp raw push improvement is worth well under MIN_VISIBLE_GAIN_PP once
    // weighted (0.95^61 ~ 0.044).
    const bestScores: OscScore[] = [subjectScore(990, 700, recent, 4, 5, [], statsForCustomAcc(0.99))];
    for (let i = 0; i < 60; i += 1) {
      bestScores.push(subjectScore(900 + i, 690 - i * 3, recent));
    }
    bestScores.push(subjectScore(BM_PUSH, 300, recent, 4, 5, [], statsForCustomAcc(0.97)));
    await seedPeers();
    await insertBeatmapMeta(BM_PUSH);
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_PUSH, 295, nowIso());
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(snapshot.recs.find((rec) => rec.beatmapId === BM_PUSH)).toBeUndefined();
  });

  it("lists every peer who farmed a map, ranked by pp", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();

    const result = await getFarmHelperFarmers(db, makeOsuStub(bestScores), "Subject", BM_MISSING);

    expect(result.beatmapId).toBe(BM_MISSING);
    expect(result.total).toBe(15);
    expect(result.farmers.length).toBe(15);
    // Sorted by pp descending and hydrated with user info.
    for (let i = 1; i < result.farmers.length; i += 1) {
      expect(result.farmers[i - 1].pp).toBeGreaterThanOrEqual(result.farmers[i].pp);
    }
    expect(result.farmers[0].username).toMatch(/^Peer/);
    expect(result.farmers[0].avatarUrl).toContain("a.ppy.sh");
  });

  it("excludes deactivated users from who-farms and the peer cohort while identical active peers stay", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    // An inactive clone of the active peers: identical farmed + filler rows,
    // only the users row differs (is_active = 0, the ban-detection tombstone).
    await insertUser(500, SUBJECT_PP, "CR", "BannedPeer");
    await exec(db, "update users set is_active = 0 where user_id = 500");
    await insertFarmed("CR", 500, BM_MISSING, 640, nowIso());
    await farmFiller4k("CR", 500);

    const farmers = await getFarmHelperFarmers(db, makeOsuStub(bestScores), "Subject", BM_MISSING);
    expect(farmers.total).toBe(15);
    expect(farmers.farmers.some((farmer) => farmer.userId === 500)).toBe(false);
    expect(farmers.farmers.some((farmer) => farmer.userId === 100)).toBe(true);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_MISSING);
    expect(rec?.peerCount).toBe(15);
    expect(rec?.topPeers.some((peer) => peer.userId === 500)).toBe(false);
  });

  it("dedupes the same peer's farm score across countries by map speed lane", async () => {
    const bestScores = buildSubjectBestScores();
    const recent = nowIso();
    await seedPeers();
    await insertFarmed("US", 100, BM_MISSING, 700, recent);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_MISSING);
    expect(rec?.peerSampleSize).toBe(15);
    expect(rec?.peerCount).toBe(15);
    expect(rec?.peerFraction).toBe(1);
    expect(rec?.topPeers.filter((peer) => peer.userId === 100)).toHaveLength(1);
    expect(rec?.topPeers.find((peer) => peer.userId === 100)?.pp).toBe(700);

    const farmers = await getFarmHelperFarmers(db, makeOsuStub(bestScores), "Subject", BM_MISSING);
    expect(farmers.total).toBe(15);
    expect(farmers.farmers.filter((farmer) => farmer.userId === 100)).toHaveLength(1);
    expect(farmers.farmers[0]).toMatchObject({ userId: 100, pp: 700 });
  });

  it("does not hide missing maps behind bottom-quartile peer scores", async () => {
    const bestScores = buildSubjectBestScores();
    const recent = nowIso();
    const targetBeatmap = 50;

    await insertBeatmapMeta(targetBeatmap);
    await seedFiller4kMeta();
    for (let i = 0; i < 15; i += 1) {
      const id = 700 + i;
      await insertUser(id, SUBJECT_PP, "CR", `SpreadPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, i < 5 ? 500 : 700, recent);
      await farmFiller4k("CR", id, recent); // qualify for the concrete 4K pool
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(rec?.reason).toBe("missing");
    expect(rec?.benchmarkPp).toBeGreaterThan(500);
    expect(rec?.estimatedPpGain).toBeGreaterThan(1);
  });

  // (The old "uses every player in the pp band instead of capping at 250 peers"
  // test exercised the total-pp cohort's non-farming members. The merged "any"
  // view runs the concrete 4K pool instead, which only admits farmers, so that
  // premise no longer applies; the 300-peer cap is covered by "uses every
  // key-mode peer instead of capping the proxy cohort at 250".)

  it("scores Any-mode farm overlap against peers with farm data", async () => {
    const bestScores = buildSubjectBestScores();
    const recent = nowIso();
    const targetBeatmap = 65;
    const fillerBeatmap = 66;

    await insertBeatmapMeta(targetBeatmap);
    await insertBeatmapMeta(fillerBeatmap);
    await seedFiller4kMeta();
    // 8 peers with 4K farm data (qualifying for the concrete pool); 4 farm the
    // target, 4 farm a different map. Only these 8 form the cohort; the fraction
    // denominator is the farm-data cohort, so the target's fraction is 4/8.
    for (let i = 0; i < 8; i += 1) {
      const id = 6000 + i;
      await insertUser(id, SUBJECT_PP + 100 + i, "US", `DataPeer${i}`);
      await insertFarmed("US", id, i < 4 ? targetBeatmap : fillerBeatmap, 620, recent);
      await farmFiller4k("US", id, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { keyMode: "any" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.count).toBe(8);
    expect(snapshot.peerBand.farmDataCount).toBe(8);
    expect(rec?.reason).toBe("missing");
    expect(rec?.peerCount).toBe(4);
    expect(rec?.peerSampleSize).toBe(8);
    expect(rec?.peerFraction).toBe(0.5);
  });

  it("uses every key-mode peer instead of capping the proxy cohort at 250", async () => {
    const recent = nowIso();
    const targetBeatmap = 70;
    const supportBeatmaps = Array.from({ length: 8 }, (_, i) => 7000 + i);
    const supportPps = [900, 850, 840, 830, 820, 810, 800, 790];
    const bestScores = supportBeatmaps.map((beatmapId, index) => subjectScore(beatmapId, supportPps[index] ?? 0, recent, 4, 5));

    await insertBeatmapMeta(targetBeatmap, 4, 5);
    for (const beatmapId of supportBeatmaps) await insertBeatmapMeta(beatmapId, 4, 5);

    // 300 peers at the same key-mode strength (so none are distance-discounted),
    // all farming the same support set plus the target: exercises the cohort
    // above the old 250 cap.
    for (let i = 0; i < 300; i += 1) {
      const id = 3000 + i;
      await insertUser(id, SUBJECT_PP + i, "CR", `KeyPeer${i}`);
      for (let j = 0; j < supportBeatmaps.length; j += 1) {
        await insertFarmed("CR", id, supportBeatmaps[j], supportPps[j] ?? 0, recent);
      }
      await insertFarmed("CR", id, targetBeatmap, 620, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { keyMode: "4k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.mode).toBe("knn");
    expect(snapshot.peerBand.count).toBe(300);
    expect(snapshot.peerBand.farmDataCount).toBe(300);
    expect(rec?.reason).toBe("missing");
    expect(rec?.peerCount).toBe(300);
    expect(rec?.peerSampleSize).toBe(300);
    // Every eligible peer farms the target, so it holds the full weight mass.
    expect(rec?.peerFraction).toBe(1);
  });

  it("returns an empty farmer list for a map nobody farmed", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();

    const result = await getFarmHelperFarmers(db, makeOsuStub(bestScores), "Subject", 999999);
    expect(result.total).toBe(0);
    expect(result.farmers).toEqual([]);
  });

  it("respects the key-mode filter", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { keyMode: "7k" });
    expect(snapshot.recs.length).toBe(0);
  });

  it("popular view keeps already-cleared maps that the gain view drops, ranked by popularity", async () => {
    const recent = nowIso();
    const BM_OWNED = 13;
    // Subject already owns BM_OWNED at the peer median, so the gain view's
    // already-cleared gate drops it even though peers actively farm it.
    const bestScores = [...buildSubjectBestScores(), subjectScore(BM_OWNED, 600, recent)];
    await seedPeers();
    for (let i = 0; i < 12; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_OWNED, 600, recent);
    }
    await insertBeatmapMeta(BM_OWNED);

    const gain = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const popular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });

    expect(gain.view).toBe("gain");
    expect(popular.view).toBe("popular");

    // Gain view omits the already-cleared map; popular includes it, labelled "owned".
    expect(gain.recs.some((rec) => rec.beatmapId === BM_OWNED)).toBe(false);
    const owned = popular.recs.find((rec) => rec.beatmapId === BM_OWNED);
    expect(owned?.reason).toBe("owned");
    expect(owned?.subjectPp).toBe(600);
    expect(owned?.peerCount).toBe(12);

    // Popular surfaces a superset of the gain view, ranked by peer popularity.
    expect(popular.recs.length).toBeGreaterThan(gain.recs.length);
    for (let i = 1; i < popular.recs.length; i += 1) {
      expect(popular.recs[i - 1].peerFraction).toBeGreaterThanOrEqual(popular.recs[i].peerFraction);
    }
    // The fully-farmed maps (fraction 1) outrank the 0.8-fraction owned map.
    expect(popular.recs[popular.recs.length - 1]?.beatmapId).toBe(BM_OWNED);
  });

  it("uses third-latest peer played-at recency for popular sorting, with a small-sample fallback", async () => {
    const bestScores = buildSubjectBestScores();
    const BM_RECENT = 14;
    const BM_SMALL_SAMPLE = 15;
    await seedPeers();
    await insertBeatmapMeta(BM_RECENT);
    await insertBeatmapMeta(BM_SMALL_SAMPLE);
    const newestPlayedAt = "2025-04-01T12:34:56.000Z";
    const olderPlayedAt = "2025-01-01T00:00:00.000Z";
    const refreshedAt = "2026-06-01T00:00:00.000Z";
    for (let i = 0; i < 12; i += 1) {
      await insertFarmed(
        i < 8 ? "CR" : "US",
        100 + i,
        BM_RECENT,
        610,
        refreshedAt,
        [],
        i === 0 ? newestPlayedAt : olderPlayedAt,
      );
    }
    for (let i = 0; i < 3; i += 1) {
      await insertFarmed(
        "CR",
        100 + i,
        BM_SMALL_SAMPLE,
        610,
        refreshedAt,
        [],
        i === 0 ? newestPlayedAt : olderPlayedAt,
      );
    }

    const popular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });
    const rec = popular.recs.find((candidate) => candidate.beatmapId === BM_RECENT);
    const smallSample = popular.recs.find((candidate) => candidate.beatmapId === BM_SMALL_SAMPLE);

    expect(rec?.latestPeerPlayedAt).toBe(newestPlayedAt);
    expect(rec?.peerRecencyPlayedAt).toBe(olderPlayedAt);
    expect(rec?.latestPeerPlayedAt).not.toBe(refreshedAt);
    expect(smallSample?.peerRecencyPlayedAt).toBe(newestPlayedAt);
  });

  it("does not fall back to total pp peers for an explicit key-mode request", async () => {
    const recent = nowIso();
    const targetBeatmap = 75;
    const bestScores = buildSubjectBestScores();

    await insertBeatmapMeta(targetBeatmap, 7, 8);
    for (let i = 0; i < 15; i += 1) {
      const id = 7000 + i;
      await insertUser(id, 12_350 + i, "CR", `OverallPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, 720, recent);
    }

    const osu = makeOsuStub(bestScores, 12_341, { "4k": 12_341, "7k": 2_535 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" });

    // Strict key-mode requests never fall back to the total-pp pool: the peers
    // have only a single 7k farmed score (below the proxy score-count floor), so
    // the cohort is legitimately empty rather than borrowing total-pp neighbours.
    expect(snapshot.peerBand.mode).toBe("knn");
    expect(snapshot.peerBand.count).toBe(0);
    expect(snapshot.recs).toEqual([]);
  });

  it("only recommends a keymode's maps in Any when that keymode has its own cohort", async () => {
    // Merged design: Any runs the 4K and 7K pipelines separately. The subject is
    // 4K-strong; their 7K variant pp is tiny and the peers farm only a single 7K
    // map (below the 7K pool's farm-count floor), so the 7K cohort is empty and
    // the 7K chart drops out - not via an off-key gate, but because no 7K cohort
    // exists. The 4K chart, backed by a real 4K cohort, survives.
    const recent = nowIso();
    const safe4kBeatmap = 76;
    const tooHard7kBeatmap = 77;
    const bestScores = buildSubjectBestScores();

    await insertBeatmapMeta(safe4kBeatmap, 4, 5);
    await insertBeatmapMeta(tooHard7kBeatmap, 7, 8);
    await seedFiller4kMeta();
    for (let i = 0; i < 15; i += 1) {
      const id = 7100 + i;
      await insertUser(id, 12_350 + i, "CR", `OverallPeer${i}`);
      await insertFarmed("CR", id, safe4kBeatmap, 620, recent);
      await insertFarmed("CR", id, tooHard7kBeatmap, 620, recent);
      await farmFiller4k("CR", id, recent); // qualify for the concrete 4K pool
    }

    const osu = makeOsuStub(bestScores, 12_341, { "4k": 12_341, "7k": 2_535 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });

    expect(snapshot.recs.some((rec) => rec.beatmapId === safe4kBeatmap)).toBe(true);
    expect(snapshot.recs.some((rec) => rec.beatmapId === tooHard7kBeatmap)).toBe(false);
  });

  it("does not let Any use overall peers for unsupported off-primary key recommendations", async () => {
    const recent = nowIso();
    const unsupported7kBeatmap = 78;
    const supportBeatmaps = Array.from({ length: 8 }, (_, i) => 7800 + i);
    const supportPps = [700, 660, 630, 600, 570, 540, 510, 480];
    const bestScores = [
      ...buildSubjectBestScores(),
      ...supportBeatmaps.map((beatmapId, index) => subjectScore(beatmapId, Math.max(260, (supportPps[index] ?? 0) - 250), recent, 7, 5)),
    ];

    await insertBeatmapMeta(unsupported7kBeatmap, 7, 5.5);
    for (const beatmapId of supportBeatmaps) await insertBeatmapMeta(beatmapId, 7, 5);

    for (let i = 0; i < 15; i += 1) {
      const id = 7200 + i;
      await insertUser(id, SUBJECT_PP + i, "CR", `Overall7kPeer${i}`);
      await insertFarmed("CR", id, unsupported7kBeatmap, 620, recent);
    }

    for (let i = 0; i < 15; i += 1) {
      const id = 7300 + i;
      await insertUser(id, 11_000 + i, "US", `Key7kPeer${i}`);
      for (let j = 0; j < supportBeatmaps.length; j += 1) {
        await insertFarmed("US", id, supportBeatmaps[j], (supportPps[j] ?? 0) - i, recent);
      }
    }

    const osu = makeOsuStub(bestScores, SUBJECT_PP, { "4k": 5_000, "7k": 4_000 });
    const anySnapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });
    const keySnapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" });

    expect(anySnapshot.recs.some((rec) => rec.beatmapId === unsupported7kBeatmap)).toBe(false);
    expect(keySnapshot.recs.some((rec) => rec.beatmapId === unsupported7kBeatmap)).toBe(false);
  });

  it("uses official key-mode variant pp when selecting explicit key-mode peers", async () => {
    const recent = nowIso();
    const targetBeatmap = 80;
    const supportBeatmaps = Array.from({ length: 8 }, (_, i) => 8000 + i);
    const subjectSupportPps = [600, 580, 560, 540, 520, 500, 480, 460];
    const strongSupportPps = [1000, 980, 960, 940, 920, 900, 880, 860];
    const bestScores = supportBeatmaps.map((beatmapId, index) => subjectScore(beatmapId, subjectSupportPps[index] ?? 0, recent, 7, 8));

    await insertBeatmapMeta(targetBeatmap, 7, 8);
    for (const beatmapId of supportBeatmaps) await insertBeatmapMeta(beatmapId, 7, 8);

    for (let i = 0; i < 12; i += 1) {
      const id = 8000 + i;
      await insertUser(id, 13_000, "CR", `Low7kPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, 620, recent);
      for (let j = 0; j < supportBeatmaps.length; j += 1) {
        await insertFarmed("CR", id, supportBeatmaps[j], subjectSupportPps[j] ?? 0, recent);
      }
    }

    for (let i = 0; i < 12; i += 1) {
      const id = 9000 + i;
      await insertUser(id, 15_000, "US", `Strong7kPeer${i}`);
      // 660 stays under the subject's demonstrated-top growth cap (600 * 1.15)
      // so the rec survives; the point here is cohort selection, not the cap.
      await insertFarmed("US", id, targetBeatmap, 660, recent);
      for (let j = 0; j < supportBeatmaps.length; j += 1) {
        await insertFarmed("US", id, supportBeatmaps[j], (strongSupportPps[j] ?? 0) - i, recent);
      }
    }

    const osu = makeOsuStub(bestScores, 15_000, { "7k": 7_600 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.mode).toMatch(/^knn/);
    expect(rec?.peerCount).toBe(12);
    expect(rec?.topPeers.every((peer) => peer.username.startsWith("Strong7kPeer"))).toBe(true);
    expect(rec?.topPeers.some((peer) => peer.username.startsWith("Low7kPeer"))).toBe(false);
  });

  it("uses key-mode strength instead of total pp for mixed-mode peer selection", async () => {
    const recent = nowIso();
    const targetBeatmap = 30;
    const supportBeatmaps = Array.from({ length: 8 }, (_, i) => 3000 + i);
    const bestScores: OscScore[] = [
      subjectScore(2999, 700, recent, 4, 8),
      subjectScore(targetBeatmap, 400, recent, 4, 8.5),
      ...supportBeatmaps.map((beatmapId, index) => subjectScore(beatmapId, 500 - index * 5, recent, 4, 7.8)),
    ];

    await insertBeatmapMeta(targetBeatmap, 4, 8.5);
    await insertBeatmapMeta(2999, 4, 8);
    for (const beatmapId of supportBeatmaps) await insertBeatmapMeta(beatmapId, 4, 7.8);

    for (let i = 0; i < 12; i += 1) {
      const id = 300 + i;
      await insertUser(id, 13_000, "CR", `KeyPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, 520, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("CR", id, beatmapId, 500 - i, recent);
    }

    for (let i = 0; i < 12; i += 1) {
      const id = 400 + i;
      await insertUser(id, 15_000, "US", `Specialist${i}`);
      await insertFarmed("US", id, targetBeatmap, 900, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("US", id, beatmapId, 900 - i, recent);
    }

    const osu = makeOsuStub(bestScores, 15_000);
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.mode).toMatch(/^knn/);
    expect(rec?.peerCount).toBe(12);
    expect(rec?.benchmarkPp).toBe(430);
    expect(rec?.topPeers.every((peer) => peer.username.startsWith("KeyPeer"))).toBe(true);
    expect(rec?.topPeers.some((peer) => peer.username.startsWith("Specialist"))).toBe(false);

    const farmers = await getFarmHelperFarmers(db, osu, "Subject", targetBeatmap);
    expect(farmers.total).toBe(12);
    expect(farmers.farmers.every((peer) => peer.username.startsWith("KeyPeer"))).toBe(true);
  });

  it("scopes the who-farms list to an Any-view card's own keymode cohort", async () => {
    // Merged design: an Any-view 4K card is generated by the concrete 4K cohort,
    // so the who-farms modal must sample that same 4K cohort (decision 8: the
    // frontend passes the card's "4k", not the view's "any"). The high-total-pp,
    // 4K-light farmers sit in the 4K pool but far from the subject's 4K pp, so the
    // kernel excludes them - only the matched 4K-strength peers form the cohort.
    const recent = nowIso();
    const targetBeatmap = 70;
    const supportBeatmaps = Array.from({ length: 8 }, (_, i) => 7000 + i);
    const bestScores: OscScore[] = [
      subjectScore(6999, 700, recent, 4, 8),
      subjectScore(targetBeatmap, 400, recent, 4, 8.5),
      ...supportBeatmaps.map((beatmapId, index) => subjectScore(beatmapId, 500 - index * 5, recent, 4, 7.8)),
    ];

    await insertBeatmapMeta(targetBeatmap, 4, 8.5);
    await insertBeatmapMeta(6999, 4, 8);
    for (const beatmapId of supportBeatmaps) await insertBeatmapMeta(beatmapId, 4, 7.8);

    // 4K-strength peers whose 4K farm strength matches the subject: the cohort.
    for (let i = 0; i < 12; i += 1) {
      const id = 700 + i;
      await insertUser(id, 13_000, "CR", `KeyPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, 520, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("CR", id, beatmapId, 500 - i, recent);
    }

    // 4K-light-but-high-total-pp farmers (the bojii/logann case): in the 4K pool
    // but their 4K farm strength is ~2x the subject's, so the kernel drops them.
    for (let i = 0; i < 12; i += 1) {
      const id = 800 + i;
      await insertUser(id, 15_000, "US", `TotalPpPeer${i}`);
      await insertFarmed("US", id, targetBeatmap, 900, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("US", id, beatmapId, 900 - i, recent);
    }

    const osu = makeOsuStub(bestScores, 15_000);

    // The Any card for this 4K map is backed by the matched 4K cohort.
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });
    expect(snapshot.peerBand.mode).toMatch(/^knn/);
    expect(snapshot.peerBand.count).toBe(12);
    expect(snapshot.peerBand.farmDataCount).toBe(12);
    const anyRec = snapshot.recs.find((rec) => rec.beatmapId === targetBeatmap);
    expect(anyRec?.topPeers.every((peer) => peer.username.startsWith("KeyPeer"))).toBe(true);

    // The modal for an Any-view 4K card passes the card's keymode ("4k"), so it
    // mirrors the card's 4K cohort instead of switching pools.
    const cardFarmers = await getFarmHelperFarmers(db, osu, "Subject", targetBeatmap, undefined, "4k");
    expect(cardFarmers.total).toBe(12);
    expect(cardFarmers.farmers.every((peer) => peer.username.startsWith("KeyPeer"))).toBe(true);

    // A direct caller without a keyMode still falls back to the map's key count.
    const keyFarmers = await getFarmHelperFarmers(db, osu, "Subject", targetBeatmap);
    expect(keyFarmers.total).toBe(12);
    expect(keyFarmers.farmers.every((peer) => peer.username.startsWith("KeyPeer"))).toBe(true);
  });

  it("does not compare halftime subject scores against nomod farm scores", async () => {
    const recent = nowIso();
    const targetBeatmap = 40;
    const supportBeatmaps = Array.from({ length: 8 }, (_, i) => 4000 + i);
    const bestScores: OscScore[] = [
      subjectScore(3999, 700, recent, 7, 8),
      subjectScore(targetBeatmap, 500, recent, 7, 8.2, ["HT"]),
      ...supportBeatmaps.map((beatmapId, index) => subjectScore(beatmapId, 520 - index * 5, recent, 7, 7.9)),
    ];

    await insertBeatmapMeta(targetBeatmap, 7, 8.2);
    await insertBeatmapMeta(3999, 7, 8);
    for (const beatmapId of supportBeatmaps) await insertBeatmapMeta(beatmapId, 7, 7.9);

    for (let i = 0; i < 12; i += 1) {
      const id = 500 + i;
      await insertUser(id, 14_000, "CR", `HtPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, 540, recent, ["HT"]);
      for (const beatmapId of supportBeatmaps) await insertFarmed("CR", id, beatmapId, 520 - i, recent);
    }

    for (let i = 0; i < 12; i += 1) {
      const id = 600 + i;
      await insertUser(id, 14_000, "US", `NmSpecialist${i}`);
      await insertFarmed("US", id, targetBeatmap, 950, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("US", id, beatmapId, 900 - i, recent);
    }

    const osu = makeOsuStub(bestScores, 14_000);
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap && candidate.speedBucket === "ht");

    expect(rec?.peerCount).toBe(12);
    expect(rec?.benchmarkPp).toBe(530);
    expect(rec?.recommendedMods).toEqual(["HT"]);
    expect(rec?.topPeers.every((peer) => peer.username.startsWith("HtPeer"))).toBe(true);
    expect(snapshot.recs.some((candidate) => candidate.beatmapId === targetBeatmap && candidate.speedBucket === "normal")).toBe(false);

    const farmers = await getFarmHelperFarmers(db, osu, "Subject", targetBeatmap, "ht");
    expect(farmers.total).toBe(12);
    expect(farmers.farmers.every((peer) => peer.username.startsWith("HtPeer"))).toBe(true);
    expect(farmers.farmers.every((peer) => peer.mods.includes("HT"))).toBe(true);
  });

  it("throws when the user cannot be resolved", async () => {
    const osu = {
      getUser: async () => {
        throw new OsuApiError(404, "/users/ghost");
      },
      getUserByKey: async () => {
        throw new OsuApiError(404, "/users/ghost");
      },
      getUserBestScoresWindow: async () => [],
    } as unknown as Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow">;

    await expect(getFarmHelperSnapshot(db, osu, "ghost")).rejects.toBeInstanceOf(FarmHelperUserNotFoundError);
  });

  it("up-weights peers whose farm charts match the subject's shape (LN vs jack)", async () => {
    const recent = nowIso();
    const LN = [0, 0, 0, 0, 0, 0, 0, 1];
    const JACK = [1, 0, 0, 0, 0, 0, 0, 0];
    const target = 9700;

    // Subject is an LN main: 10 LN-shaped 4K top plays, pinned to 3000 4K pp.
    const subjectMaps = Array.from({ length: 10 }, (_, i) => 9800 + i);
    const bestScores = subjectMaps.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 4, 5));
    for (const beatmapId of subjectMaps) {
      await insertBeatmapMeta(beatmapId, 4, 5);
      await insertSearchIndex(beatmapId, LN);
    }
    await insertBeatmapMeta(target, 4, 5);
    await insertSearchIndex(target, LN);

    const lnSupport = Array.from({ length: 8 }, (_, i) => 9500 + i);
    const jackSupport = Array.from({ length: 8 }, (_, i) => 9600 + i);
    for (const beatmapId of lnSupport) { await insertBeatmapMeta(beatmapId, 4, 5); await insertSearchIndex(beatmapId, LN); }
    for (const beatmapId of jackSupport) { await insertBeatmapMeta(beatmapId, 4, 5); await insertSearchIndex(beatmapId, JACK); }

    // LN peers farm LN charts and clear the target at 400; jack peers farm jack
    // charts and clear it at 800. Both cohorts sit near the subject's 4K pp.
    for (let i = 0; i < 12; i += 1) {
      const id = 9110 + i;
      await insertUser(id, 10_000, "CR", `LnPeer${i}`);
      await insertFarmed("CR", id, target, 400, recent);
      for (const beatmapId of lnSupport) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    for (let i = 0; i < 12; i += 1) {
      const id = 9210 + i;
      await insertUser(id, 10_000, "US", `JackPeer${i}`);
      await insertFarmed("US", id, target, 800, recent);
      for (const beatmapId of jackSupport) await insertFarmed("US", id, beatmapId, 400, recent);
    }

    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === target);

    // The subject is missing the target, so its benchmark is the shape-weighted
    // quantile of peer pps. LN peers (matching shape) dominate over jack peers,
    // dragging the benchmark toward the LN cohort's 400 rather than the ~600
    // midpoint an unweighted cohort would produce.
    expect(rec).toBeDefined();
    expect(rec?.peerPpMedian).toBeLessThan(550);
    // With a comparable subject and chart shape, patternFit is a real number.
    expect(rec?.patternFit).not.toBeNull();
    expect(rec?.patternFit ?? 0).toBeGreaterThan(0.5);
  });

  it("fades long-inactive peers from the cohort by baseline recency", async () => {
    const recent = nowIso();
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();
    const activeMap = 9700;
    const staleMap = 9701;
    const subjectMaps = Array.from({ length: 10 }, (_, i) => 9800 + i);
    const support = Array.from({ length: 8 }, (_, i) => 9500 + i);
    const bestScores = subjectMaps.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 4, 5));
    for (const beatmapId of [...subjectMaps, ...support, activeMap, staleMap]) await insertBeatmapMeta(beatmapId, 4, 5);

    // Two symmetric cohorts at the same pp: the active peers' newest baseline
    // top play is recent, the stale peers' is three years old. Farmed-row
    // timestamps are identical, so any spread comes from the affinity factor.
    for (let i = 0; i < 12; i += 1) {
      const id = 9110 + i;
      await insertUser(id, 10_000, "CR", `ActivePeer${i}`);
      await seedBaselineVector(id, 4, { Overall: 20, Stream: 18, Stamina: 17, JackSpeed: 16 }, 40, recent);
      await insertFarmed("CR", id, activeMap, 400, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    for (let i = 0; i < 12; i += 1) {
      const id = 9210 + i;
      await insertUser(id, 10_000, "US", `StalePeer${i}`);
      await seedBaselineVector(id, 4, { Overall: 20, Stream: 18, Stamina: 17, JackSpeed: 16 }, 40, threeYearsAgo);
      await insertFarmed("US", id, staleMap, 400, recent);
      for (const beatmapId of support) await insertFarmed("US", id, beatmapId, 400, recent);
    }

    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const active = snapshot.recs.find((rec) => rec.beatmapId === activeMap);
    const stale = snapshot.recs.find((rec) => rec.beatmapId === staleMap);
    expect(active).toBeDefined();
    expect(stale).toBeDefined();
    expect(active!.peerFraction).toBeGreaterThan(stale!.peerFraction);
    expect(active!.peerFraction).toBeGreaterThan(0.55);
    expect(stale!.peerFraction).toBeLessThan(0.4);
  });

  it("up-weights peers whose skill shape matches the subject's baseline vector", async () => {
    const recent = nowIso();
    const similarMap = 9700;
    const dissimilarMap = 9701;
    const subjectMaps = Array.from({ length: 10 }, (_, i) => 9800 + i);
    const support = Array.from({ length: 8 }, (_, i) => 9500 + i);
    const bestScores = subjectMaps.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 4, 5));
    for (const beatmapId of [...subjectMaps, ...support, similarMap, dissimilarMap]) await insertBeatmapMeta(beatmapId, 4, 5);

    // Subject is jack-leaning; one cohort mirrors that shape, the other is the
    // inverse (stream-leaning). Same pp, same recency: only shape differs.
    const jackShape = { Overall: 20, JackSpeed: 24, Chordjack: 22, Stream: 14, Stamina: 18 };
    const streamShape = { Overall: 20, JackSpeed: 14, Chordjack: 15, Stream: 24, Stamina: 21 };
    await seedBaselineVector(SUBJECT_ID, 4, jackShape, 50, recent);
    for (let i = 0; i < 12; i += 1) {
      const id = 9110 + i;
      await insertUser(id, 10_000, "CR", `JackPeer${i}`);
      await seedBaselineVector(id, 4, jackShape, 40, recent);
      await insertFarmed("CR", id, similarMap, 400, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    for (let i = 0; i < 12; i += 1) {
      const id = 9210 + i;
      await insertUser(id, 10_000, "US", `StreamPeer${i}`);
      await seedBaselineVector(id, 4, streamShape, 40, recent);
      await insertFarmed("US", id, dissimilarMap, 400, recent);
      for (const beatmapId of support) await insertFarmed("US", id, beatmapId, 400, recent);
    }

    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const similar = snapshot.recs.find((rec) => rec.beatmapId === similarMap);
    const dissimilar = snapshot.recs.find((rec) => rec.beatmapId === dissimilarMap);
    expect(similar).toBeDefined();
    expect(dissimilar).toBeDefined();
    expect(similar!.peerFraction).toBeGreaterThan(dissimilar!.peerFraction);
    expect(similar!.peerFraction).toBeGreaterThan(0.55);
    expect(dissimilar!.peerFraction).toBeLessThan(0.45);
  });

  it("drops charts whose dominant skill outstrips the subject rating from gain, keeps feasible ones", async () => {
    const recent = nowIso();
    const hard = 9900; // dominant Technical 30, above the subject's 15 + margin
    const easy = 9901; // dominant Technical 15, within reach
    const support = Array.from({ length: 8 }, (_, i) => 9910 + i);
    const bestScores = [
      subjectScore(9990, 500, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 4, 5)),
    ];
    const msd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });

    await insertBeatmapMeta(hard, 4, 5);
    await insertBeatmapMeta(easy, 4, 5);
    await insertSearchIndex(hard, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(30));
    await insertSearchIndex(easy, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(15));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 9920 + i;
      await insertUser(id, 10_000, "CR", `MsdPeer${i}`);
      await insertFarmed("CR", id, hard, 500, recent);
      await insertFarmed("CR", id, easy, 500, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillRatings(SUBJECT_ID, 4, msd(15), 50);
    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    expect(gain.recs.some((rec) => rec.beatmapId === easy)).toBe(true);
    expect(gain.recs.some((rec) => rec.beatmapId === hard)).toBe(false);

    // The over-MSD chart is still browsable in popular (the gate is gain-only).
    const popular = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k", view: "popular" }, stubQueue);
    expect(popular.recs.some((rec) => rec.beatmapId === hard)).toBe(true);
  });

  it("gates DT recs on 1.5x MSD with the wider DT margin, keeping ones within reach", async () => {
    const recent = nowIso();
    const hardDt = 9700; // dominant Technical 25 at 1.5x, above the subject's 15 + 3.5
    const easyDt = 9701; // dominant Technical 17 at 1.5x, within the DT margin
    const support = Array.from({ length: 8 }, (_, i) => 9710 + i);
    const bestScores = [
      subjectScore(9790, 500, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 4, 5)),
    ];
    const msd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });

    await insertBeatmapMeta(hardDt, 4, 5);
    await insertBeatmapMeta(easyDt, 4, 5);
    // Normal-lane MSD sits below the subject's rating, so only the DT gate can
    // fire; it just puts both ids into the feasibility context. The 1.5x MSD that
    // the DT lane screens against lives in the chart-analysis row.
    await insertSearchIndex(hardDt, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(12));
    await insertSearchIndex(easyDt, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(12));
    await insertDtRateAnalysis(hardDt, msd(25));
    await insertDtRateAnalysis(easyDt, msd(17));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 9720 + i;
      await insertUser(id, 10_000, "CR", `DtPeer${i}`);
      await insertFarmed("CR", id, hardDt, 500, recent, ["DT"]);
      await insertFarmed("CR", id, easyDt, 500, recent, ["DT"]);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillRatings(SUBJECT_ID, 4, msd(15), 50);
    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    const easyRec = gain.recs.find((rec) => rec.beatmapId === easyDt);
    expect(easyRec).toBeDefined();
    expect(easyRec?.speedBucket).toBe("dt");
    expect(gain.recs.some((rec) => rec.beatmapId === hardDt)).toBe(false);

    // Popular still browses the over-MSD DT chart (the gate is gain-only).
    const popular = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k", view: "popular" }, stubQueue);
    expect(popular.recs.some((rec) => rec.beatmapId === hardDt)).toBe(true);
  });

  it("gates 7K charts on the subject's 7K ratings (an LN main is not fed rice-speed charts)", async () => {
    const recent = nowIso();
    // The LN-main shape: pp earned on LN control, ratings low on the speed axes.
    // A rice-speed chart peers at his pp farm freely must NOT recommend; an
    // LN chart at the same Overall must.
    const riceSpeed = 9800; // dominant Stream 30, above the subject's 16 + 3.5
    const lnChart = 9801; // dominant Stream 16, within reach of the LN main
    const support = Array.from({ length: 8 }, (_, i) => 9810 + i);
    const bestScores = [
      subjectScore(9890, 500, recent, 7, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 7, 5)),
    ];
    const msd = (stream: number) => ({ Stream: stream, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: 10 });

    await insertBeatmapMeta(riceSpeed, 7, 5);
    await insertBeatmapMeta(lnChart, 7, 5);
    await insertSearchIndex(riceSpeed, [0, 1, 0, 0, 0, 0, 0, 0], 7, msd(30));
    await insertSearchIndex(lnChart, [0, 0, 0, 0, 0, 0, 0, 1], 7, msd(16));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 7, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 9820 + i;
      await insertUser(id, 10_000, "CR", `SevenKPeer${i}`);
      await insertFarmed("CR", id, riceSpeed, 500, recent);
      await insertFarmed("CR", id, lnChart, 500, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    // LN-earned rating vector: strong Overall, thin on the speed skillsets.
    await seedSubjectSkillRatings(SUBJECT_ID, 7, { ...msd(16), Overall: 24 }, 50);
    const osu = makeOsuStub(bestScores, 10_000, { "7k": 3000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" }, stubQueue);
    expect(gain.recs.some((rec) => rec.beatmapId === lnChart)).toBe(true);
    expect(gain.recs.some((rec) => rec.beatmapId === riceSpeed)).toBe(false);

    // Popular still browses the out-of-reach chart (the gate is gain-only).
    const popular = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k", view: "popular" }, stubQueue);
    expect(popular.recs.some((rec) => rec.beatmapId === riceSpeed)).toBe(true);
  });

  it("gates a sparse keymode via cross-keymode transfer and caps its targets at the demonstrated top play", async () => {
    const recent = nowIso();
    // Subject is a 7K main (50 analyzed plays, all axes rated 16) dabbling in
    // 4K (9 analyzed plays, inflated axis ratings of 20 from that tiny
    // sample). The old behavior omitted the sparse 4K keymode entirely, so
    // exactly these subjects got zero 4K filtering.
    const hard4k = 9950; // Technical 19: inside the full 3.0 margin, outside the tighter sparse one (16 + 1.5)
    const easy4k = 9951; // Technical 17, farmed at 290: feasible and under the demonstrated-top cap
    const mid4k = 9952; // Technical 17 but farmed at 500: feasible MSD, dropped by the 300 * 1.04 top-play cap
    const own4k = Array.from({ length: 5 }, (_, i) => 9960 + i);
    const own7k = Array.from({ length: 10 }, (_, i) => 9970 + i);
    const bestScores = [
      ...own7k.map((beatmapId, i) => subjectScore(beatmapId, 600 - i * 5, recent, 7, 5)),
      ...own4k.map((beatmapId, i) => subjectScore(beatmapId, 300 - i * 10, recent, 4, 5)),
    ];
    const msd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });
    const flat = (value: number) => ({ Stream: value, Jumpstream: value, Handstream: value, Stamina: value, JackSpeed: value, Chordjack: value, Technical: value });

    for (const beatmapId of [hard4k, easy4k, mid4k]) await insertBeatmapMeta(beatmapId, 4, 5);
    await insertSearchIndex(hard4k, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(19));
    await insertSearchIndex(easy4k, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(17));
    await insertSearchIndex(mid4k, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(17));
    for (const beatmapId of own4k) await insertBeatmapMeta(beatmapId, 4, 5);
    for (const beatmapId of own7k) await insertBeatmapMeta(beatmapId, 7, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 30_000 + i;
      await insertUser(id, 10_000, "CR", `SparsePeer${i}`);
      await insertFarmed("CR", id, hard4k, 290, recent);
      await insertFarmed("CR", id, easy4k, 290, recent);
      await insertFarmed("CR", id, mid4k, 500, recent);
      // 8 farmed 4K maps total per peer clears the keymode pool floor.
      for (const beatmapId of own4k) await insertFarmed("CR", id, beatmapId, 280, recent);
    }
    await seedSubjectSkillModes(SUBJECT_ID, [
      { keyCount: 7, analyzedPlays: 50, ratings: { ...flat(16), Overall: 20 } },
      { keyCount: 4, analyzedPlays: 9, ratings: { ...flat(20), Overall: 20 } },
    ]);
    const osu = makeOsuStub(bestScores, 10_000, { "4k": 2_300, "7k": 6_000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    expect(gain.recs.some((rec) => rec.beatmapId === easy4k)).toBe(true);
    // Transferred ratings: per-axis min(own 20, donor 16 scaled by the Overall
    // ratio) = 16, and the sparse margin is 1.5, so Technical 19 drops even
    // though the subject's own thin 4K ratings would have allowed it.
    expect(gain.recs.some((rec) => rec.beatmapId === hard4k)).toBe(false);
    // Feasible MSD, but the 500pp peer benchmark exceeds the demonstrated 4K
    // top play (300) plus headroom: projection, not a target.
    expect(gain.recs.some((rec) => rec.beatmapId === mid4k)).toBe(false);

    // Popular still browses everything (the gate and caps are gain-only).
    const popular = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k", view: "popular" }, stubQueue);
    expect(popular.recs.some((rec) => rec.beatmapId === hard4k)).toBe(true);
    expect(popular.recs.some((rec) => rec.beatmapId === mid4k)).toBe(true);
  });

  it("gates on the chart's pattern family rating even when the MSD axes pass", async () => {
    const recent = nowIso();
    // 7K LN main: every MSD axis rated 16 (LN-earned), family ratings say LN 24
    // but jack only 12. Two charts with IDENTICAL MSD (JackSpeed 16 dominant,
    // within the axis margin) differ only in pattern family: the jack-family
    // chart outstrips what the player has shown on jack charts and drops.
    const riceChart = 9930;
    const lnChart = 9931;
    const support = Array.from({ length: 8 }, (_, i) => 9935 + i);
    const bestScores = [
      subjectScore(9944, 520, recent, 7, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 7, 5)),
    ];
    const msd = (jackSpeed: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: jackSpeed, Chordjack: 10, Technical: 10 });

    await insertBeatmapMeta(riceChart, 7, 5);
    await insertBeatmapMeta(lnChart, 7, 5);
    await insertSearchIndex(riceChart, [1, 0, 0, 0, 0, 0, 0, 0], 7, msd(16));
    await insertSearchIndex(lnChart, [0, 0, 0, 0, 0, 0, 0, 1], 7, msd(16));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 7, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 31_000 + i;
      await insertUser(id, 10_000, "CR", `FamilyPeer${i}`);
      await insertFarmed("CR", id, riceChart, 500, recent);
      await insertFarmed("CR", id, lnChart, 500, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillModes(SUBJECT_ID, [{
      keyCount: 7,
      analyzedPlays: 50,
      ratings: { ...msd(16), Overall: 20 },
      patterns: [
        { id: "ln", rating: 24, plays: 30 },
        { id: "jack", rating: 12, plays: 4 },
      ],
    }]);
    const osu = makeOsuStub(bestScores, 10_000, { "7k": 3000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" }, stubQueue);
    expect(gain.recs.some((rec) => rec.beatmapId === lnChart)).toBe(true);
    // JackSpeed 16 <= 16 + 3.5 passes the axis check, but the chart's primary
    // family is jack and 16 > 12 + 3.5: family evidence gates it.
    expect(gain.recs.some((rec) => rec.beatmapId === riceChart)).toBe(false);

    const popular = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k", view: "popular" }, stubQueue);
    expect(popular.recs.some((rec) => rec.beatmapId === riceChart)).toBe(true);
  });

  it("gates on near-dominant secondary MSD axes but ignores far-below-dominant ones", async () => {
    const recent = nowIso();
    // Subject: strong everywhere (20) except JackSpeed (10). Both charts share
    // a within-reach dominant Technical 21; one is nearly co-dominant on
    // JackSpeed (20.5, checked, far above 10 + 3), the other's JackSpeed 15
    // sits well below the dominant (unchecked texture, even though 15 > 13).
    const secondaryHeavy = 9940;
    const secondaryLight = 9941;
    const support = Array.from({ length: 8 }, (_, i) => 9945 + i);
    const bestScores = [
      subjectScore(9954, 500, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 4, 5)),
    ];
    const msd = (jackSpeed: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: jackSpeed, Chordjack: 10, Technical: 21 });

    await insertBeatmapMeta(secondaryHeavy, 4, 5);
    await insertBeatmapMeta(secondaryLight, 4, 5);
    await insertSearchIndex(secondaryHeavy, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(20.5));
    await insertSearchIndex(secondaryLight, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(15));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 32_000 + i;
      await insertUser(id, 10_000, "CR", `AxisPeer${i}`);
      await insertFarmed("CR", id, secondaryHeavy, 500, recent);
      await insertFarmed("CR", id, secondaryLight, 500, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillRatings(SUBJECT_ID, 4, { Stream: 20, Jumpstream: 20, Handstream: 20, Stamina: 20, JackSpeed: 10, Chordjack: 20, Technical: 20 }, 50);
    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    expect(gain.recs.some((rec) => rec.beatmapId === secondaryLight)).toBe(true);
    expect(gain.recs.some((rec) => rec.beatmapId === secondaryHeavy)).toBe(false);
  });

  it("gates HT-lane recs on rate-scaled 1.0x MSD", async () => {
    const recent = nowIso();
    // No stored 0.75x MSD exists, so the HT lane screens the 1.0x vector
    // scaled by the rate: Technical 30 -> 22.5 (above 15 + 3, drops) while
    // Technical 22 -> 16.5 (kept, even though the NORMAL lane would drop 22).
    const hardHt = 9970;
    const easyHt = 9971;
    const support = Array.from({ length: 8 }, (_, i) => 9975 + i);
    const bestScores = [
      subjectScore(9985, 500, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 4, 5)),
    ];
    const msd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });

    await insertBeatmapMeta(hardHt, 4, 5);
    await insertBeatmapMeta(easyHt, 4, 5);
    await insertSearchIndex(hardHt, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(30));
    await insertSearchIndex(easyHt, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(22));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 33_000 + i;
      await insertUser(id, 10_000, "CR", `HtGatePeer${i}`);
      await insertFarmed("CR", id, hardHt, 500, recent, ["HT"]);
      await insertFarmed("CR", id, easyHt, 500, recent, ["HT"]);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillRatings(SUBJECT_ID, 4, msd(15), 50);
    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    const easyRec = gain.recs.find((rec) => rec.beatmapId === easyHt);
    expect(easyRec).toBeDefined();
    expect(easyRec?.speedBucket).toBe("ht");
    expect(gain.recs.some((rec) => rec.beatmapId === hardHt)).toBe(false);

    // Popular still browses the out-of-reach HT chart (the gate is gain-only).
    const popular = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k", view: "popular" }, stubQueue);
    expect(popular.recs.some((rec) => rec.beatmapId === hardHt)).toBe(true);
  });

  it("caps targets by the demonstrated top play in the chart's pattern family, not variant pp", async () => {
    const recent = nowIso();
    // 7K player: LN family demonstrated at 1000pp, jack family at only 300pp.
    // Peers farm both targets at 800. The old cap (20% of variant pp = 1872)
    // never bound, so the 800pp rice target sailed through; the family cap
    // binds it at 300 * 1.15 while the LN target stays within 1000 * 1.15.
    const riceTarget = 9955;
    const lnTarget = 9956;
    const ownLn = Array.from({ length: 10 }, (_, i) => 9960 + i);
    const ownJack = [9975, 9976];
    const LN = [0, 0, 0, 0, 0, 0, 0, 1];
    const JACK = [1, 0, 0, 0, 0, 0, 0, 0];
    const bestScores = [
      ...ownLn.map((beatmapId, i) => subjectScore(beatmapId, 1000 - i * 5, recent, 7, 5)),
      ...ownJack.map((beatmapId, i) => subjectScore(beatmapId, 300 - i * 10, recent, 7, 5)),
    ];
    for (const beatmapId of ownLn) {
      await insertBeatmapMeta(beatmapId, 7, 5);
      await insertSearchIndex(beatmapId, LN, 7);
    }
    for (const beatmapId of ownJack) {
      await insertBeatmapMeta(beatmapId, 7, 5);
      await insertSearchIndex(beatmapId, JACK, 7);
    }
    await insertBeatmapMeta(riceTarget, 7, 5);
    await insertSearchIndex(riceTarget, JACK, 7);
    await insertBeatmapMeta(lnTarget, 7, 5);
    await insertSearchIndex(lnTarget, LN, 7);

    for (let i = 0; i < 12; i += 1) {
      const id = 34_000 + i;
      await insertUser(id, 10_000, "CR", `CapPeer${i}`);
      await insertFarmed("CR", id, riceTarget, 800, recent);
      await insertFarmed("CR", id, lnTarget, 800, recent);
      for (const beatmapId of ownLn) await insertFarmed("CR", id, beatmapId, 700, recent);
    }
    // No skill ratings seeded: the feasibility gate stays off, isolating the
    // family cap.
    const osu = makeOsuStub(bestScores, 10_000, { "7k": 9_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" });

    expect(snapshot.recs.some((rec) => rec.beatmapId === lnTarget)).toBe(true);
    expect(snapshot.recs.some((rec) => rec.beatmapId === riceTarget)).toBe(false);
  });

  it("exercises the feasibility gate on the queue-less backtest path", async () => {
    const recent = nowIso();
    const hard = 9990; // dominant Technical 30, above the subject's 15 + margin
    const easy = 9991; // dominant Technical 15, within reach
    const support = Array.from({ length: 8 }, (_, i) => 9910 + i);
    const bestScores = [
      subjectScore(9905, 500, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 4, 5)),
    ];
    const msd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });

    await insertBeatmapMeta(hard, 4, 5);
    await insertBeatmapMeta(easy, 4, 5);
    await insertSearchIndex(hard, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(30));
    await insertSearchIndex(easy, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(15));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 35_000 + i;
      await insertUser(id, 10_000, "CR", `BacktestGatePeer${i}`);
      await insertFarmed("CR", id, hard, 500, recent);
      await insertFarmed("CR", id, easy, 500, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillRatings(SUBJECT_ID, 4, msd(15), 50);

    const user = {
      id: SUBJECT_ID,
      username: "Subject",
      avatar_url: "https://a.ppy.sh/1",
      statistics: {
        pp: 10_000,
        variants: [{ mode: "mania", variant: "4k", pp: 3000, global_rank: null, country_rank: null }],
      },
    };
    const snapshot = await buildFarmHelperSnapshotForBacktest(db, user, bestScores, {
      asOf: Date.now() + 60_000,
      keyMode: "4k",
      view: "gain",
      limit: 100,
    });

    expect(snapshot.recs.some((rec) => rec.beatmapId === easy)).toBe(true);
    expect(snapshot.recs.some((rec) => rec.beatmapId === hard)).toBe(false);
  });

  it("computes key-mode peer distance on mode pp, not identical total pp", async () => {
    const recent = nowIso();
    const targetBeatmap = 90;
    const supportBeatmaps = Array.from({ length: 8 }, (_, i) => 9000 + i);
    // Subject is a 4K player pinned to a 3000 4K variant pp; total pp is 10000,
    // the SAME total as every seeded peer below.
    const bestScores: OscScore[] = [
      subjectScore(8999, 500, recent, 4, 5),
      subjectScore(targetBeatmap, 300, recent, 4, 5),
      ...supportBeatmaps.map((beatmapId, index) => subjectScore(beatmapId, 460 - index * 5, recent, 4, 5)),
    ];

    await insertBeatmapMeta(targetBeatmap, 4, 5);
    await insertBeatmapMeta(8999, 4, 5);
    for (const beatmapId of supportBeatmaps) await insertBeatmapMeta(beatmapId, 4, 5);

    // "Match" peers: identical total pp, 4K farm strength near the subject.
    for (let i = 0; i < 12; i += 1) {
      const id = 9100 + i;
      await insertUser(id, 10_000, "CR", `MatchPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, 500, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("CR", id, beatmapId, 450, recent);
    }
    // "Off" peers: SAME total pp, far higher 4K farm strength. If distance used
    // total pp they would tie with the match peers; on mode pp they fall outside.
    for (let i = 0; i < 12; i += 1) {
      const id = 9200 + i;
      await insertUser(id, 10_000, "US", `OffPeer${i}`);
      await insertFarmed("US", id, targetBeatmap, 1300, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("US", id, beatmapId, 1200, recent);
    }

    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.count).toBe(12);
    expect(rec?.peerCount).toBe(12);
    expect(rec?.topPeers.every((peer) => peer.username.startsWith("MatchPeer"))).toBe(true);
    expect(rec?.topPeers.some((peer) => peer.username.startsWith("OffPeer"))).toBe(false);
    // No chart shapes seeded here -> patternFit is null and ranking falls back to
    // the star-proximity difficultyFit.
    expect(rec?.patternFit).toBeNull();
  });

  it("backtest reconstruction filters peer farmed rows and subject scores by the asOf cutoff", async () => {
    const BM_PAST = 20;
    const BM_FUTURE = 21;
    const asOf = Date.parse("2024-06-01T00:00:00Z");

    const bestScores = buildSubjectBestScores();
    // A subject score set AFTER the cutoff must be ignored, so BM_PAST stays a
    // "missing" recommendation rather than looking already-owned.
    bestScores.push(subjectScore(BM_PAST, 900, "2024-07-15T00:00:00Z"));

    await insertBeatmapMeta(BM_PAST);
    await insertBeatmapMeta(BM_FUTURE);
    await seedFiller4kMeta();
    for (let i = 0; i < 15; i += 1) {
      const id = 200 + i;
      await insertUser(id, SUBJECT_PP, i < 8 ? "CR" : "US");
      // BM_PAST farmed before the cutoff (kept), BM_FUTURE after (dropped).
      await insertFarmed("CR", id, BM_PAST, 620, "2024-05-01T00:00:00Z", [], "2024-05-01T00:00:00Z");
      await insertFarmed("CR", id, BM_FUTURE, 620, "2024-07-01T00:00:00Z", [], "2024-07-01T00:00:00Z");
      // Pre-cutoff filler so the peer clears the 4K pool's farm-count floor even
      // after the as-of aggregation drops BM_FUTURE.
      await farmFiller4k("CR", id, "2024-05-01T00:00:00Z");
    }

    const user = {
      id: SUBJECT_ID,
      username: "Subject",
      avatar_url: "https://a.ppy.sh/1",
      statistics: { pp: SUBJECT_PP, variants: [] },
    };

    const snapshot = await buildFarmHelperSnapshotForBacktest(db, user, bestScores, { asOf, view: "gain", limit: 100 });

    const byBeatmap = new Map(snapshot.recs.map((rec) => [rec.beatmapId, rec]));
    // The future-only map has no peer support as of the cutoff -> not recommended.
    expect(byBeatmap.has(BM_FUTURE)).toBe(false);
    // The past map survives, and the subject's post-cutoff score is ignored.
    const past = byBeatmap.get(BM_PAST);
    expect(past?.reason).toBe("missing");
    expect(past?.subjectPp).toBeNull();
  });

  it("falls back to the nearest peers when everyone sits outside the widest kernel", async () => {
    const recent = nowIso();
    const target = 9600;
    const support = Array.from({ length: 8 }, (_, i) => 9610 + i);
    const subjectMaps = Array.from({ length: 10 }, (_, i) => 9650 + i);
    const bestScores = subjectMaps.map((beatmapId, i) => subjectScore(beatmapId, 460 - i * 5, recent, 4, 5));

    await insertBeatmapMeta(target, 4, 5);
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);
    for (const beatmapId of subjectMaps) await insertBeatmapMeta(beatmapId, 4, 5);

    // Every 4K peer's proxy sits at roughly a third of the subject's 4K variant
    // pp: outside even the widest discovery kernel, where the old band ladder's
    // terminal "nearest" mode still produced a cohort.
    for (let i = 0; i < 12; i += 1) {
      const id = 9660 + i;
      await insertUser(id, 3_000, "CR", `FarPeer${i}`);
      await insertFarmed("CR", id, target, 420, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }

    const osu = makeOsuStub(bestScores, 9_000, { "4k": 9_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });

    expect(snapshot.peerBand.mode).toBe("knn_sparse");
    expect(snapshot.peerBand.count).toBe(12);
    expect(snapshot.recs.some((rec) => rec.beatmapId === target)).toBe(true);
  });

  it("scores Any-view candidates against their own keymode's subject shape, not the dominant mode's", async () => {
    const recent = nowIso();
    const JACK = [1, 0, 0, 0, 0, 0, 0, 0];
    const LN = [0, 0, 0, 0, 0, 0, 0, 1];
    const jackTarget4k = 9300; // matches the subject's 4K (jack) shape
    const lnTarget4k = 9301; // matches their 7K (LN) shape, but is a 4K chart

    // Hybrid subject: 7K is the stronger mode (LN main there), 4K is jack. Both
    // modes clear the Any primary-mode ratio so 4K candidates flow normally.
    const subject4k = Array.from({ length: 10 }, (_, i) => 9310 + i);
    const subject7k = Array.from({ length: 10 }, (_, i) => 9330 + i);
    const bestScores = [
      ...subject7k.map((beatmapId, i) => subjectScore(beatmapId, 600 - i * 5, recent, 7, 5)),
      ...subject4k.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 4, 5)),
    ];
    for (const beatmapId of subject4k) {
      await insertBeatmapMeta(beatmapId, 4, 5);
      await insertSearchIndex(beatmapId, JACK, 4);
    }
    for (const beatmapId of subject7k) {
      await insertBeatmapMeta(beatmapId, 7, 5);
      await insertSearchIndex(beatmapId, LN, 7);
    }
    await insertBeatmapMeta(jackTarget4k, 4, 5);
    await insertSearchIndex(jackTarget4k, JACK, 4);
    await insertBeatmapMeta(lnTarget4k, 4, 5);
    await insertSearchIndex(lnTarget4k, LN, 4);

    for (let i = 0; i < 12; i += 1) {
      const id = 9360 + i;
      await insertUser(id, 10_000, "CR", `HybridPeer${i}`);
      await insertFarmed("CR", id, jackTarget4k, 520, recent);
      await insertFarmed("CR", id, lnTarget4k, 520, recent);
      for (const beatmapId of subject4k) await insertFarmed("CR", id, beatmapId, 500, recent);
    }

    const osu = makeOsuStub(bestScores, 10_000, { "4k": 8_500, "7k": 9_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });
    const jackRec = snapshot.recs.find((rec) => rec.beatmapId === jackTarget4k);
    const lnRec = snapshot.recs.find((rec) => rec.beatmapId === lnTarget4k);

    // The dominant mode is 7K (LN). Judged against that profile the fits would
    // invert: jack 4K chart near 0, LN 4K chart near 1. Per-candidate keymode
    // shapes judge both against the subject's 4K (jack) profile instead.
    expect(jackRec?.patternFit ?? 0).toBeGreaterThan(0.9);
    expect(lnRec?.patternFit ?? 1).toBeLessThan(0.1);
  });

  it("applies the feasibility gate to queue-less callers (Discord/backtest parity)", async () => {
    const recent = nowIso();
    const hard = 9400; // dominant Technical 30, above the subject's 15 + margin
    const support = Array.from({ length: 8 }, (_, i) => 9410 + i);
    const bestScores = [
      subjectScore(9490, 500, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 4, 5)),
    ];
    const msd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });

    await insertBeatmapMeta(hard, 4, 5);
    await insertSearchIndex(hard, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(30));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);
    for (let i = 0; i < 12; i += 1) {
      const id = 9420 + i;
      await insertUser(id, 10_000, "CR", `CachePeer${i}`);
      await insertFarmed("CR", id, hard, 500, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillRatings(SUBJECT_ID, 4, msd(15), 50);
    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });

    // Queue-less caller (Discord-style): the gate reads the stored ratings
    // without enqueueing anything, so the over-MSD chart drops here too. The
    // old behavior disabled the gate entirely without a queue, which meant
    // Discord (and the backtest) served ungated lists.
    const noQueue = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    expect(noQueue.recs.some((rec) => rec.beatmapId === hard)).toBe(false);

    // A queue-ful caller sees the same content (and may share the cache entry).
    const withQueue = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    expect(withQueue.recs.some((rec) => rec.beatmapId === hard)).toBe(false);
  });

  it("self-heals proxy-only cohort peers by enqueueing their variant enrichment", async () => {
    const recent = nowIso();
    const target = 9550;
    const support = Array.from({ length: 8 }, (_, i) => 9560 + i);
    const bestScores = [
      subjectScore(9590, 700, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 500 - i * 5, recent, 4, 5)),
    ];

    await insertBeatmapMeta(target, 4, 5);
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);

    // 12 proxy-only peers (no pp_4k, no variants in profile_json) plus two
    // controls: one with real variant pp, one whose profile already carries a
    // variants block (a fetch cannot improve either).
    const seedPeer = async (id: number, name: string) => {
      await insertUser(id, 13_000, "CR", name);
      await insertFarmed("CR", id, target, 520, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 500, recent);
    };
    for (let i = 0; i < 12; i += 1) await seedPeer(9500 + i, `ProxyPeer${i}`);
    await seedPeer(9540, "VariantPeer");
    await exec(db, "update users set pp_4k = 3800 where user_id = 9540");
    await seedPeer(9541, "ProfiledPeer");
    await exec(db, `update users set profile_json = '{"statistics":{"variants":[]}}' where user_id = 9541`);

    const enqueued: Array<{ type: string; key: string }> = [];
    const captureQueue = {
      enqueue: async (type: string, key: string) => {
        enqueued.push({ type, key });
      },
    } as unknown as Parameters<typeof getFarmHelperSnapshot>[4];

    const osu = makeOsuStub(bestScores, 15_000);
    await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, captureQueue);

    const enriches = enqueued.filter((entry) => entry.type === "enrich_user");
    expect(enriches.length).toBeGreaterThan(0);
    expect(enriches.some((entry) => entry.key === "user:9500")).toBe(true);
    // Neither control peer qualifies: one already has variant pp, the other's
    // profile shows the variants block was fetched and carried nothing usable.
    expect(enriches.some((entry) => entry.key === "user:9540")).toBe(false);
    expect(enriches.some((entry) => entry.key === "user:9541")).toBe(false);
  });

  it("reports lanes hidden only by the gain floor so an empty board can explain itself", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    // A lane peers demonstrably farm, at a pp so far below the subject's tail
    // that its estimated gain lands under MIN_VISIBLE_GAIN_PP: it must drop
    // from the board but be counted in belowGainFloorCount.
    const BM_TINY = 60;
    await insertBeatmapMeta(BM_TINY, 4, 5);
    const recent = nowIso();
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_TINY, 3, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(snapshot.recs.find((rec) => rec.beatmapId === BM_TINY)).toBeUndefined();
    expect(snapshot.belowGainFloorCount ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("merges the concrete 4K and 7K runs into the Any view (union of recs and totals)", async () => {
    const recent = nowIso();
    const fourkTarget = 8100;
    const sevenkTarget = 8200;
    const subj4k = Array.from({ length: 10 }, (_, i) => 8110 + i);
    const subj7k = Array.from({ length: 10 }, (_, i) => 8210 + i);
    // Hybrid subject: 10 owned 4K plays + 10 owned 7K plays, both keymodes eligible.
    const bestScores = [
      ...subj4k.map((beatmapId, i) => subjectScore(beatmapId, 500 - i * 5, recent, 4, 5)),
      ...subj7k.map((beatmapId, i) => subjectScore(beatmapId, 500 - i * 5, recent, 7, 5)),
    ];
    await insertBeatmapMeta(fourkTarget, 4, 5);
    await insertBeatmapMeta(sevenkTarget, 7, 5);
    for (const beatmapId of subj4k) await insertBeatmapMeta(beatmapId, 4, 5);
    for (const beatmapId of subj7k) await insertBeatmapMeta(beatmapId, 7, 5);

    // Disjoint cohorts: 4K peers farm the 4K target + the owned 4K support (below
    // the subject's held pp so that support stays "owned" and drops out); 7K peers
    // do the same on the 7K side. Each cohort clears its own pool's farm floor.
    for (let i = 0; i < 12; i += 1) {
      const id = 8300 + i;
      await insertUser(id, 10_000, "CR", `FourkPeer${i}`);
      await insertFarmed("CR", id, fourkTarget, 520, recent);
      for (const beatmapId of subj4k) await insertFarmed("CR", id, beatmapId, 300, recent);
    }
    for (let i = 0; i < 12; i += 1) {
      const id = 8400 + i;
      await insertUser(id, 10_000, "US", `SevenkPeer${i}`);
      await insertFarmed("US", id, sevenkTarget, 520, recent);
      for (const beatmapId of subj7k) await insertFarmed("US", id, beatmapId, 300, recent);
    }

    const osu = makeOsuStub(bestScores, 10_000);
    const fourk = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const sevenk = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "7k" });
    const any = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });

    const ids = (snap: typeof any) => new Set(snap.recs.map((rec) => rec.beatmapId));
    expect(fourk.recs.some((rec) => rec.beatmapId === fourkTarget)).toBe(true);
    expect(sevenk.recs.some((rec) => rec.beatmapId === sevenkTarget)).toBe(true);
    // Any = union of the two concrete views' recs.
    expect(ids(any)).toEqual(new Set([...ids(fourk), ...ids(sevenk)]));
    // Any measures gain against the overall list; the concrete views measure it
    // against each keymode's own (shorter) list, so a rec is worth at least as
    // much there - a play displaces fewer higher entries in its variant list.
    expect(any.gainBasis).toBe("overall");
    expect(fourk.gainBasis).toBe("keymode");
    expect(any.totalPotentialPp).toBeGreaterThan(0);
    expect(fourk.totalPotentialPp + sevenk.totalPotentialPp).toBeGreaterThanOrEqual(any.totalPotentialPp);
    for (const merged of any.recs) {
      const concrete = [...fourk.recs, ...sevenk.recs].find(
        (rec) => rec.beatmapId === merged.beatmapId && rec.speedBucket === merged.speedBucket,
      );
      expect(concrete).toBeDefined();
      expect(concrete!.estimatedPpGain).toBeGreaterThanOrEqual(merged.estimatedPpGain);
    }
  });

  it("keeps a 4K-inflated same-total-pp peer out of an Any-view 4K card's cohort (konkawe)", async () => {
    const recent = nowIso();
    const target = 8500;
    const support = Array.from({ length: 8 }, (_, i) => 8510 + i);
    const subjOwned4k = Array.from({ length: 10 }, (_, i) => 8520 + i);
    const subjOwned7k = Array.from({ length: 10 }, (_, i) => 8540 + i);
    const bestScores = [
      ...subjOwned4k.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 4, 5)),
      ...subjOwned7k.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 7, 5)),
    ];
    await insertBeatmapMeta(target, 4, 5);
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);
    for (const beatmapId of subjOwned4k) await insertBeatmapMeta(beatmapId, 4, 5);
    for (const beatmapId of subjOwned7k) await insertBeatmapMeta(beatmapId, 7, 5);

    // 12 legit 4K peers with a real pp_4k right at the subject's 4K variant pp, so
    // the kernel gives them full weight (effective sample >= floor, no sparse
    // fallback). They farm the target + support.
    for (let i = 0; i < 12; i += 1) {
      const id = 8600 + i;
      await insertUser(id, 15_300, "CR", `LegitPeer${i}`);
      await exec(db, "update users set pp_4k = 13600 where user_id = ?", [id]);
      await insertFarmed("CR", id, target, 520, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 500, recent);
    }
    // The konkawe case: same TOTAL pp as the subject, but a 4K variant pp ~90%
    // above it. On the 4K axis this peer is far away, so the 4K cohort must drop it.
    await insertUser(15665805, 15_300, "US", "Konkawe");
    await exec(db, "update users set pp_4k = 25840 where user_id = 15665805");
    await insertFarmed("US", 15665805, target, 900, recent);
    for (const beatmapId of support) await insertFarmed("US", 15665805, beatmapId, 880, recent);

    const osu = makeOsuStub(bestScores, 15_300, { "4k": 13_600, "7k": 14_700 });
    const any = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });
    const rec = any.recs.find((candidate) => candidate.beatmapId === target);

    expect(any.peerBands?.["4k"]?.mode).toMatch(/^knn/);
    expect(rec).toBeDefined();
    expect(rec?.topPeers.some((peer) => peer.username === "Konkawe")).toBe(false);
    expect(rec?.topPeers.every((peer) => peer.username.startsWith("LegitPeer"))).toBe(true);

    // The who-farms modal for the 4K card (frontend passes "4k") also excludes it.
    const farmers = await getFarmHelperFarmers(db, osu, "Subject", target, undefined, "4k");
    expect(farmers.farmers.some((peer) => peer.username === "Konkawe")).toBe(false);
    expect(farmers.total).toBe(12);
  });

  it("falls back to the total-pp cohort when the subject has no keymode evidence", async () => {
    const recent = nowIso();
    const target = 8700;
    const target4k = 8701;
    // Subject plays only 5K: neither the 4K nor 7K pipeline is eligible. Their top
    // play (700) sets the benchmark cap above the peers' 600pp target.
    const owned = Array.from({ length: 10 }, (_, i) => 700 - i * 5);
    const ownedIds = Array.from({ length: 10 }, (_, i) => 8710 + i);
    const bestScores = ownedIds.map((beatmapId, i) => subjectScore(beatmapId, owned[i], recent, 5, 5));
    await insertBeatmapMeta(target, 5, 5);
    await insertBeatmapMeta(target4k, 4, 5);
    for (const beatmapId of ownedIds) await insertBeatmapMeta(beatmapId, 5, 5);

    for (let i = 0; i < 15; i += 1) {
      const id = 8800 + i;
      await insertUser(id, SUBJECT_PP + i, i < 8 ? "CR" : "US", `TotalPeer${i}`);
      await insertFarmed(i < 8 ? "CR" : "US", id, target, 600, recent);
      await insertFarmed(i < 8 ? "CR" : "US", id, target4k, 600, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores, SUBJECT_PP), "Subject", { keyMode: "any" });

    expect(snapshot.peerBand.mode).toBe("total_pp_fallback");
    expect(snapshot.peerBands).toBeUndefined();
    expect(snapshot.recs.some((rec) => rec.beatmapId === target)).toBe(true);

    // 4K/7K candidates have no per-mode cap evidence for a pure 5K player;
    // they fall back to the overall cap (700 * 1.15) instead of dropping, so
    // the mostly-4K/7K farm tables still populate the board. (The old
    // behavior dropped every 4K/7K candidate on the null per-mode cap.)
    const rec4k = snapshot.recs.find((rec) => rec.beatmapId === target4k);
    expect(rec4k?.reason).toBe("missing");
    expect(rec4k?.benchmarkPp).toBe(600);
  });

  it("exposes per-keymode peerBands only on the merged Any view", async () => {
    const recent = nowIso();
    const fourkTarget = 8900;
    const subj4k = Array.from({ length: 10 }, (_, i) => 8910 + i);
    const bestScores = subj4k.map((beatmapId, i) => subjectScore(beatmapId, 500 - i * 5, recent, 4, 5));
    await insertBeatmapMeta(fourkTarget, 4, 5);
    for (const beatmapId of subj4k) await insertBeatmapMeta(beatmapId, 4, 5);
    for (let i = 0; i < 12; i += 1) {
      const id = 8950 + i;
      await insertUser(id, 10_000, "CR", `BandPeer${i}`);
      await insertFarmed("CR", id, fourkTarget, 520, recent);
      for (const beatmapId of subj4k) await insertFarmed("CR", id, beatmapId, 300, recent);
    }

    const osu = makeOsuStub(bestScores, 10_000);
    const any = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });
    const concrete = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });

    // Subject is 4K-only, so the merged view exposes just the 4K band.
    expect(any.peerBands).toBeDefined();
    expect(any.peerBands?.["4k"]?.count).toBe(12);
    expect(any.peerBands?.["7k"]).toBeUndefined();
    // The concrete view keeps the single peerBand and omits peerBands entirely.
    expect(concrete.peerBands).toBeUndefined();
    expect(concrete.peerBand.count).toBe(12);
  });

  it("measures concrete-keymode gain in that keymode's variant pp (a 7K main still gets 4K picks)", async () => {
    const recent = nowIso();
    const fourkTarget = 9500;
    const subj4k = Array.from({ length: 8 }, (_, i) => 9510 + i);
    // The todo-#35 shape: 140 high 7K plays fill the overall top-100, so any
    // feasible 4K benchmark contributes literally zero overall pp. The 4K side
    // profile still exists (8 plays at ~265-300pp) and osu! reports it as
    // variant pp; the 4K tab must measure gain against that, not the 7K wall.
    const bestScores: OscScore[] = [
      ...Array.from({ length: 140 }, (_, i) => subjectScore(20_000 + i, 800 - i, recent, 7, 8)),
      ...subj4k.map((beatmapId, i) => subjectScore(beatmapId, 300 - i * 5, recent, 4, 5)),
    ];
    await insertBeatmapMeta(fourkTarget, 4, 5);
    for (const beatmapId of subj4k) await insertBeatmapMeta(beatmapId, 4, 5);
    for (let i = 0; i < 12; i += 1) {
      const id = 9550 + i;
      await insertUser(id, 2_100, "CR", `SidePeer${i}`);
      await insertFarmed("CR", id, fourkTarget, 340, recent);
      for (const beatmapId of subj4k) await insertFarmed("CR", id, beatmapId, 290, recent);
    }

    const osu = makeOsuStub(bestScores, 15_000, { "4k": 2_000, "7k": 14_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    expect(snapshot.gainBasis).toBe("keymode");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === fourkTarget);
    expect(rec?.reason).toBe("missing");

    // Sanity on the fixture: against the overall list this benchmark is worth
    // exactly nothing, which is what used to blank the 4K tab for a 7K main.
    expect(expectedGain(bestScores, fourkTarget, rec?.benchmarkPp ?? 0)).toBe(0);
    // The reported gain is the 4K-local (variant pp) estimate.
    const fourkScores = bestScores.filter((score) => score.beatmap?.cs === 4);
    const modeGain = expectedGain(fourkScores, fourkTarget, rec?.benchmarkPp ?? 0);
    expect(modeGain).toBeGreaterThan(1);
    expect(rec?.estimatedPpGain).toBeCloseTo(Math.round(modeGain * 100) / 100, 1);

    // The merged Any view keeps overall-pp semantics: this pick genuinely does
    // not move the player's profile pp, so it stays out of that list.
    const any = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });
    expect(any.gainBasis).toBe("overall");
    expect(any.recs.some((candidate) => candidate.beatmapId === fourkTarget)).toBe(false);
  });

  it("calibrates a truncated keymode baseline to the official variant pp (full window)", async () => {
    const recent = nowIso();
    const targetA = 9600;
    const targetB = 9601;
    const subj4k = Array.from({ length: 9 }, (_, i) => 9610 + i);
    // Full 200-score window: 191 7K plays crowd out everything 4K below 470,
    // so only the true top nine 4K plays are visible (~3.6k weighted) while the
    // official pp_4k says the full list weighs 8,000. Gains must be measured
    // against the calibrated 8k baseline, not the visible stub.
    const bestScores: OscScore[] = [
      ...Array.from({ length: 191 }, (_, i) => subjectScore(20_000 + i, 900 - i * 2, recent, 7, 8)),
      ...subj4k.map((beatmapId, i) => subjectScore(beatmapId, 510 - i * 5, recent, 4, 5)),
    ];
    expect(bestScores.length).toBe(200);
    await insertBeatmapMeta(targetA, 4, 5);
    await insertBeatmapMeta(targetB, 4, 5);
    for (const beatmapId of subj4k) await insertBeatmapMeta(beatmapId, 4, 5);
    for (let i = 0; i < 12; i += 1) {
      const id = 9650 + i;
      await insertUser(id, 8_100, "CR", `CalPeer${i}`);
      await insertFarmed("CR", id, targetA, 560, recent);
      await insertFarmed("CR", id, targetB, 555, recent);
      for (const beatmapId of subj4k) await insertFarmed("CR", id, beatmapId, 470, recent);
    }

    const variant4kPp = 8_000;
    const osu = makeOsuStub(bestScores, 16_400, { "4k": variant4kPp, "7k": 16_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const recA = snapshot.recs.find((rec) => rec.beatmapId === targetA);
    const recB = snapshot.recs.find((rec) => rec.beatmapId === targetB);
    expect(recA?.reason).toBe("missing");
    expect(recB?.reason).toBe("missing");

    // Both benchmarks top the visible 4K plays, so the gain is exact:
    // benchmark minus 5% of the full variant-pp mass it displaces. Against the
    // visible-only baseline these would read ~380, a 2.4x overstatement.
    expect(recA?.estimatedPpGain).toBeCloseTo(560 - 0.05 * variant4kPp, 0);
    expect(recB?.estimatedPpGain).toBeCloseTo(555 - 0.05 * variant4kPp, 0);

    // Headline total: one simulation with both benchmarks inserted, strictly
    // below the sum of the independent per-rec gains.
    const naiveSum = (recA?.estimatedPpGain ?? 0) + (recB?.estimatedPpGain ?? 0);
    expect(snapshot.totalPotentialPp).toBeCloseTo(560 + 0.95 * 555 - (1 - 0.95 ** 2) * variant4kPp, 0);
    expect(snapshot.totalPotentialPp).toBeLessThan(naiveSum);
  });

  it("recommends a keymode with zero visible plays off the official variant pp alone", async () => {
    const recent = nowIso();
    const target = 9700;
    const supports = Array.from({ length: 9 }, (_, i) => 9710 + i);
    // The all-7K wall: every one of the 200 windowed plays is 7K, yet osu!
    // reports pp_4k = 7,000. Every hidden 4K play sits below the window cutoff
    // (502), so a benchmark above it provably tops the entire 4K list.
    const bestScores = Array.from({ length: 200 }, (_, i) => subjectScore(20_000 + i, 900 - i * 2, recent, 7, 8));
    await insertBeatmapMeta(target, 4, 5);
    for (const beatmapId of supports) await insertBeatmapMeta(beatmapId, 4, 5);
    for (let i = 0; i < 12; i += 1) {
      const id = 9750 + i;
      await insertUser(id, 7_100, "CR", `NoPlayPeer${i}`);
      await insertFarmed("CR", id, target, 620, recent);
      for (const beatmapId of supports) await insertFarmed("CR", id, beatmapId, 300, recent);
    }

    const variant4kPp = 7_000;
    const osu = makeOsuStub(bestScores, 19_500, { "4k": variant4kPp, "7k": 19_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    expect(snapshot.gainBasis).toBe("keymode");

    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === target);
    expect(rec?.reason).toBe("missing");
    // 620 beats the 502 cutoff, so it beats every hidden 4K play: exact gain.
    expect(rec?.estimatedPpGain).toBeCloseTo(620 - 0.05 * variant4kPp, 0);

    // A benchmark below the cutoff cannot be placed, so it sorts below the
    // synthetic tail: present, but at a conservative fraction of its value.
    const support = snapshot.recs.find((candidate) => candidate.beatmapId === supports[0]);
    expect(support?.estimatedPpGain ?? 0).toBeGreaterThan(1);
    expect(support?.estimatedPpGain ?? 0).toBeLessThan(300 * 0.4);
  });
});

// A8: peer benchmarks scaled by the subject's predicted custom accuracy,
// benchmark * (5 * accYou - 4) / (5 * accTypical - 4), clamped to [0, 1].
describe("farm helper predicted-accuracy benchmark scaling", () => {
  const BM_ACC = 14;
  // pat order: jack, stream, jumpstream, handstream, stamina, chordjack, tech, ln.
  const STREAM_PAT = [0, 1, 0, 0, 0, 0, 0, 0];

  // A ready acc model row for the subject's 4K keymode. The partial msd
  // fixtures below (only Stream set) give the chart an msd_overall without a
  // full skillset vector, so the hard feasibility gate stays out of the way
  // and every drop/discount observed here comes from the multiplier.
  function accModelForTest(overrides: Partial<AccModelMode> = {}): PlayerAccModel {
    const mode: AccModelMode = {
      keys: 4,
      rating: 25,
      n: 100,
      w: 1000,
      a: -2.8,
      bn: 0.085,
      bp: 0.15,
      s: 0.3,
      mean: 0.95,
      lo: -10,
      hi: 10,
      fam: {},
      choke: [],
      ...overrides,
    };
    return { v: ACC_MODEL_VERSION, modes: { "4": mode } };
  }

  async function seedSubjectAccModel(model: PlayerAccModel): Promise<void> {
    await seedSubjectSkillRatings(SUBJECT_ID, 4, { Overall: 25 }, 40);
    await exec(db, "update player_skill_ratings set acc_model_json = ? where user_id = ?", [
      JSON.stringify(model),
      SUBJECT_ID,
    ]);
  }

  it("floors the multiplier at 0.5 and clamps it at one", () => {
    // (5 * acc - 4) hits 0 at 80% and goes negative below. The multiplier
    // used to floor at 0, which could scale every benchmark below the
    // subject's own tail and empty the whole gain board; it now stops at 0.5
    // (below half the peer benchmark the model is extrapolating outside its
    // evidence).
    expect(computeAccBenchmarkScale({ accConservative: 0.75 }, 0.94)).toBe(0.5);
    expect(computeAccBenchmarkScale({ accConservative: 0.8 }, 0.94)).toBe(0.5);
    // A prediction above the typical accuracy never inflates the benchmark.
    expect(computeAccBenchmarkScale({ accConservative: 0.999 }, 0.94)).toBe(1);
    expect(computeAccBenchmarkScale({ accConservative: 0.9 }, 0.94))
      .toBeCloseTo((5 * 0.9 - 4) / (5 * 0.94 - 4), 6);
    // Degenerate typical accuracy (denominator <= 0): leave unscaled.
    expect(computeAccBenchmarkScale({ accConservative: 0.9 }, 0.8)).toBe(1);
  });

  it("shrinks the target for a chart the model predicts weak accuracy on", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_ACC, 4, 5);
    // msd_overall 24 (gap -1 against the model's rating 25).
    await insertSearchIndex(BM_ACC, STREAM_PAT, 4, { Stream: 24 });
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_ACC, 620, nowIso());
    }
    // A weak curve: ~90% median custom accuracy even 1 MSD below the
    // player's level.
    const model = accModelForTest({ a: Math.log(0.10) });
    await seedSubjectAccModel(model);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_ACC);

    const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 24, family: "stream" })!;
    const scale = computeAccBenchmarkScale(prediction, ACC_MODEL_PRIOR_TYPICAL_ACC);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);

    expect(rec?.reason).toBe("missing");
    expect(rec?.benchmarkPp).toBeCloseTo(620 * scale, 1);
    expect(rec?.benchmarkPp ?? 620).toBeLessThan(620);
    // Raw peer stats stay unscaled: they describe the peers, not the target.
    expect(rec?.peerPpMedian).toBe(620);
  });

  it("prefers stored peer accuracy over the prior once enough rows carry one", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_ACC, 4, 5);
    await insertSearchIndex(BM_ACC, STREAM_PAT, 4, { Stream: 24 });
    // All 15 farmed rows carry the A9 accuracy column (>= the 5-row floor).
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_ACC, 620, nowIso(), [], nowIso(), 0.97);
    }
    const model = accModelForTest({ a: Math.log(0.10) });
    await seedSubjectAccModel(model);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_ACC);

    const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 24, family: "stream" })!;
    const storedScale = computeAccBenchmarkScale(prediction, 0.97);
    const priorScale = computeAccBenchmarkScale(prediction, ACC_MODEL_PRIOR_TYPICAL_ACC);
    // The stored 97% typical accuracy discounts harder than the ~93.9% prior.
    expect(storedScale).toBeLessThan(priorScale);
    expect(rec?.benchmarkPp).toBeCloseTo(620 * storedScale, 1);
  });

  it("keeps a collapsed-prediction chart at the floored multiplier instead of dropping it", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_ACC, 4, 5);
    // 2.5 MSD above the model's rating with the steepest above-level slope:
    // predicted error rate saturates, accConservative <= 80%. The raw ratio
    // would be 0 (which used to erase the chart, and for a low-accuracy
    // player could erase the whole board); the floor holds it at 0.5.
    await insertSearchIndex(BM_ACC, STREAM_PAT, 4, { Stream: 27.5 });
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_ACC, 620, nowIso());
    }
    const model = accModelForTest({ bp: 0.9 });
    await seedSubjectAccModel(model);

    const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 27.5, family: "stream" })!;
    expect(computeAccBenchmarkScale(prediction, ACC_MODEL_PRIOR_TYPICAL_ACC)).toBe(0.5);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    // The chart stays, at half the unscaled 620 benchmark...
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_ACC);
    expect(rec?.reason).toBe("missing");
    expect(rec?.benchmarkPp).toBeCloseTo(310, 1);
    // ...and an un-covered chart (no msd_overall -> no prediction) stays too.
    expect(snapshot.recs.find((candidate) => candidate.beatmapId === BM_MISSING)?.reason).toBe("missing");
  });

  it("leaves benchmarks unscaled when the subject has no acc model", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_ACC, 4, 5);
    await insertSearchIndex(BM_ACC, STREAM_PAT, 4, { Stream: 24 });
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_ACC, 620, nowIso());
    }
    // Ready skill ratings but no acc_model_json: readPlayerAccModel is null.
    await seedSubjectSkillRatings(SUBJECT_ID, 4, { Overall: 25 }, 40);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_ACC);
    expect(rec?.reason).toBe("missing");
    expect(rec?.benchmarkPp).toBe(620);
  });

  it("still binds the existing caps on the scaled value", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    // BM_IMPROVE (owned at 400, peers at 600) gets an msd_overall so the
    // multiplier applies; the strong curve clamps the multiplier at 1, and
    // the nextPlayedMapBenchmark cap (400 + 30) must still bind.
    await insertSearchIndex(BM_IMPROVE, STREAM_PAT, 4, { Stream: 24 });
    const model = accModelForTest({ a: Math.log(0.04) });
    await seedSubjectAccModel(model);

    const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 24, family: "stream" })!;
    expect(computeAccBenchmarkScale(prediction, ACC_MODEL_PRIOR_TYPICAL_ACC)).toBe(1);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_IMPROVE);
    expect(rec?.reason).toBe("improve");
    expect(rec?.benchmarkPp).toBe(430);
  });

  it("never double-scales push targets", async () => {
    const recent = "2024-06-01T00:00:00Z";
    const bestScores = buildSubjectBestScores();
    bestScores[0] = subjectScore(990, 700, recent, 4, 5, [], statsForCustomAcc(0.99));
    bestScores.push(subjectScore(BM_PUSH, 400, recent, 4, 5, [], statsForCustomAcc(0.97)));
    await seedPeers();
    await insertBeatmapMeta(BM_PUSH);
    // The push chart has an msd_overall and the model discounts it (< 1), so
    // a double-applied multiplier would show up as a much lower target.
    await insertSearchIndex(BM_PUSH, STREAM_PAT, 4, { Stream: 24 });
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_PUSH, 395, nowIso());
    }
    const model = accModelForTest({ a: Math.log(0.10) });
    await seedSubjectAccModel(model);

    const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 24, family: "stream" })!;
    const scale = computeAccBenchmarkScale(prediction, ACC_MODEL_PRIOR_TYPICAL_ACC);
    expect(scale).toBeLessThan(1);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const push = snapshot.recs.find((rec) => rec.beatmapId === BM_PUSH);

    expect(push?.reason).toBe("push");
    // The push benchmark is the subject's own accuracy rescale, untouched by
    // the peer multiplier.
    const accNow = calculateManiaCustomAccuracy(statsForCustomAcc(0.97))!;
    const targetAcc = accNow + 0.0075;
    const expectedBenchmark = 400 * (5 * targetAcc - 4) / (5 * accNow - 4);
    expect(push?.benchmarkPp).toBeCloseTo(expectedBenchmark, 1);
  });
});

describe("farm helper survival term (A10)", () => {
  const BM_RISKY = 15;
  const BM_SAFE = 16;
  // pat order: jack, stream, jumpstream, handstream, stamina, chordjack, tech, ln.
  const STREAM_PAT = [0, 1, 0, 0, 0, 0, 0, 0];
  // Six choke bins (gap centers -7..3), all well above the min-n floor and
  // heavily choked: the subject drops combo on charts at every gap.
  const HEAVY_CHOKE = Array.from({ length: 6 }, () => ({ n: 10, c: 0.9, m: 0.05 }));

  // A ready 4K acc model whose accuracy curve is strong (the A8 multiplier
  // clamps at 1, so every gain difference observed here comes from the
  // survival term alone), with configurable choke bins.
  function chokeModelForTest(choke: Array<{ n: number; c: number; m: number }>): PlayerAccModel {
    const mode: AccModelMode = {
      keys: 4,
      rating: 25,
      n: 100,
      w: 1000,
      a: Math.log(0.04),
      bn: 0.085,
      bp: 0.15,
      s: 0.3,
      mean: 0.95,
      lo: -10,
      hi: 10,
      fam: {},
      choke,
    };
    return { v: ACC_MODEL_VERSION, modes: { "4": mode } };
  }

  async function seedSubjectAccModel(model: PlayerAccModel): Promise<void> {
    await seedSubjectSkillRatings(SUBJECT_ID, 4, { Overall: 25 }, 40);
    await exec(db, "update player_skill_ratings set acc_model_json = ? where user_id = ?", [
      JSON.stringify(model),
      SUBJECT_ID,
    ]);
  }

  async function setPassStats(beatmapId: number, playCount: number, passCount: number): Promise<void> {
    await exec(db, "update map_search_index set play_count = ?, pass_count = ? where beatmap_id = ?", [
      playCount,
      passCount,
      beatmapId,
    ]);
  }

  it("treats missing signals as neutral (never punish missing data)", () => {
    expect(computeSurvival({ playCount: null, passCount: null, lengthSec: 0, choke: null })).toBe(1);
    // play_count 0 = never counted, not "nobody passes".
    expect(computeSurvival({ playCount: 0, passCount: 0, lengthSec: 0, choke: null })).toBe(1);
    // Length alone never discounts: with no choke signal the exponent is a no-op.
    expect(computeSurvival({ playCount: null, passCount: null, lengthSec: 600, choke: null })).toBe(1);
    // A healthy pass rate maps to neutral.
    expect(computeSurvival({ playCount: 10_000, passCount: 5_000, lengthSec: 120, choke: null })).toBe(1);
    // A thin play count barely moves even a zero pass count (shrunk to prior).
    expect(computeSurvival({ playCount: 10, passCount: 0, lengthSec: 120, choke: null })).toBeGreaterThan(0.9);
  });

  it("is monotone in each signal and only labels genuinely risky lanes", () => {
    // Mild signals stay above the clear-risk threshold.
    const mild = computeSurvival({
      playCount: 10_000,
      passCount: 5_000,
      lengthSec: 120,
      choke: { chokeRate: 0.3, confidence: 0.5 },
    });
    expect(mild).toBeGreaterThan(SURVIVAL_CLEAR_RISK_MAX);
    // Low pass rate + heavy personal choke + a long map falls below it.
    const risky = computeSurvival({
      playCount: 20_000,
      passCount: 500,
      lengthSec: 240,
      choke: { chokeRate: 0.9, confidence: 0.8 },
    });
    expect(risky).toBeLessThan(SURVIVAL_CLEAR_RISK_MAX);
    // Monotone: a lower pass rate, a higher choke rate, and a longer map each
    // only lower the estimate.
    const base = { playCount: 20_000, passCount: 8_000, lengthSec: 120, choke: { chokeRate: 0.5, confidence: 0.8 } };
    expect(computeSurvival({ ...base, passCount: 2_000 })).toBeLessThan(computeSurvival(base));
    expect(computeSurvival({ ...base, choke: { chokeRate: 0.9, confidence: 0.8 } })).toBeLessThan(computeSurvival(base));
    expect(computeSurvival({ ...base, lengthSec: 300 })).toBeLessThan(computeSurvival(base));
  });

  it("sinks a low pass-rate high-choke lane below a safer equal-gain lane and labels it", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_RISKY, 4, 5);
    await insertBeatmapMeta(BM_SAFE, 4, 5);
    // The risky chart has an msd_overall (gap -1 against the model's rating
    // 25, feeding the choke curve) and terrible population pass stats; the
    // safe chart has no index row at all (all survival signals neutral).
    await insertSearchIndex(BM_RISKY, STREAM_PAT, 4, { Stream: 24 });
    await setPassStats(BM_RISKY, 20_000, 500);
    for (let i = 0; i < 15; i += 1) {
      const country = i < 8 ? "CR" : "US";
      await insertFarmed(country, 100 + i, BM_RISKY, 620, nowIso());
      await insertFarmed(country, 100 + i, BM_SAFE, 620, nowIso());
    }
    await seedSubjectAccModel(chokeModelForTest(HEAVY_CHOKE));

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const risky = snapshot.recs.find((rec) => rec.beatmapId === BM_RISKY);
    const safe = snapshot.recs.find((rec) => rec.beatmapId === BM_SAFE);
    expect(risky).toBeDefined();
    expect(safe).toBeDefined();

    // Identical peer evidence: the if-you-finish target and gain match.
    expect(risky?.benchmarkPp).toBe(safe?.benchmarkPp);
    expect(risky?.estimatedPpGain).toBe(safe?.estimatedPpGain);

    // popFactor 0.5 (pass rate far below typical) * chokeFactor 0.64
    // (chokeRate 0.9 at confidence 60/90) at the 120s reference length.
    expect(risky?.survival).toBeCloseTo(0.32, 2);
    expect(risky?.clearRisk).toBe(true);
    expect(safe?.survival).toBe(1);
    expect(safe?.clearRisk).toBe(false);

    // The ranking runs on expected gain, so the risky lane sinks.
    const riskyIndex = snapshot.recs.findIndex((rec) => rec.beatmapId === BM_RISKY);
    const safeIndex = snapshot.recs.findIndex((rec) => rec.beatmapId === BM_SAFE);
    expect(riskyIndex).toBeGreaterThan(safeIndex);
    expect(risky!.rankScore).toBeLessThan(safe!.rankScore);

    // A chart with no index row anywhere (BM_MISSING) stays neutral too.
    const uncovered = snapshot.recs.find((rec) => rec.beatmapId === BM_MISSING);
    expect(uncovered?.survival).toBe(1);
    expect(uncovered?.clearRisk).toBe(false);

    // The payload fields survive JSON serialization (the HTTP snapshot path).
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const serialized = roundTripped.recs.find((rec) => rec.beatmapId === BM_RISKY);
    expect(serialized?.survival).toBeCloseTo(0.32, 2);
    expect(serialized?.clearRisk).toBe(true);
  });

  it("keeps already-cleared lanes neutral even with terrible population stats", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    // BM_IMPROVE is owned by the subject (400pp vs peer median 600): the lane
    // is proven finishable, so awful pass stats must not label it.
    await insertSearchIndex(BM_IMPROVE, STREAM_PAT, 4);
    await setPassStats(BM_IMPROVE, 50_000, 100);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const improve = snapshot.recs.find((rec) => rec.beatmapId === BM_IMPROVE);
    expect(improve?.reason).toBe("improve");
    expect(improve?.survival).toBe(1);
    expect(improve?.clearRisk).toBe(false);
  });

  it("leaves survival null on the popular view and under the backtest A/B flag", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertSearchIndex(BM_MISSING, STREAM_PAT, 4);
    await setPassStats(BM_MISSING, 20_000, 500);

    const popular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });
    const popularRec = popular.recs.find((rec) => rec.beatmapId === BM_MISSING);
    expect(popularRec?.survival).toBeNull();
    expect(popularRec?.clearRisk).toBe(false);

    const user = {
      id: SUBJECT_ID,
      username: "Subject",
      avatar_url: "",
      statistics: { pp: SUBJECT_PP },
    } as Record<string, unknown>;
    const disabled = await buildFarmHelperSnapshotForBacktest(db, user, bestScores, {
      asOf: Date.now(),
      view: "gain",
      limit: 100,
      noSurvival: true,
    });
    const disabledRec = disabled.recs.find((rec) => rec.beatmapId === BM_MISSING);
    expect(disabledRec).toBeDefined();
    expect(disabledRec?.survival).toBeNull();
    expect(disabledRec?.clearRisk).toBe(false);
  });

  it("discounts ranking on population-only risk but never sets the personal clearRisk label", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    // Terrible population pass stats on BM_MISSING, but NO acc model at all:
    // predictPlayerChoke never runs, so the survival discount is purely the
    // population prior. It must sink the ranking (survival < 1) without
    // claiming "finishing this looks risky for YOU".
    await insertSearchIndex(BM_MISSING, STREAM_PAT, 4);
    await setPassStats(BM_MISSING, 20_000, 500);

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_MISSING);
    expect(rec).toBeDefined();
    // popFactor bottoms out at the 0.5 floor for this pass rate; well below
    // the clear-risk threshold, yet unlabelled without a personal signal.
    expect(rec?.survival).toBeCloseTo(0.5, 2);
    expect(rec?.survival ?? 1).toBeLessThan(SURVIVAL_CLEAR_RISK_MAX);
    expect(rec?.clearRisk).toBe(false);
  });
});

describe("farm helper benchmark kernel symmetry (D)", () => {
  it("admits slightly-below peers into the benchmark kernel without granting discovery weight", async () => {
    const recent = nowIso();
    const target = 41_000;
    const support = Array.from({ length: 8 }, (_, i) => 41_010 + i);
    // Subject: 10 owned 4K plays (top 700 keeps the cap at 805, above every
    // benchmark here), pinned to a 10,000 4K variant pp.
    const subjectMaps = Array.from({ length: 10 }, (_, i) => 41_050 + i);
    const bestScores = subjectMaps.map((beatmapId, i) => subjectScore(beatmapId, 700 - i * 5, recent, 4, 5));
    await insertBeatmapMeta(target, 4, 5);
    for (const beatmapId of [...support, ...subjectMaps]) await insertBeatmapMeta(beatmapId, 4, 5);

    // 13 near peers at exactly the subject's 4K pp (d = 0: full wD and wB)
    // farm the target at 700; 60 "slightly below" peers at d = -0.081 sit
    // just past the discovery kernel (0.08) but inside the benchmark kernel
    // (0.10): wD = 0, wB ~ 0.19 each (~11.4 total mass). They farm the
    // target at 400.
    for (let i = 0; i < 13; i += 1) {
      const id = 41_100 + i;
      await insertUser(id, 15_000, "CR", `NearPeer${i}`);
      await exec(db, "update users set pp_4k = 10000 where user_id = ?", [id]);
      await insertFarmed("CR", id, target, 700, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 300, recent);
    }
    for (let i = 0; i < 60; i += 1) {
      const id = 41_200 + i;
      await insertUser(id, 15_000, "US", `BelowPeer${i}`);
      await exec(db, "update users set pp_4k = 9190 where user_id = ?", [id]);
      await insertFarmed("US", id, target, 400, recent);
      for (const beatmapId of support) await insertFarmed("US", id, beatmapId, 300, recent);
    }

    const osu = makeOsuStub(bestScores, 15_000, { "4k": 10_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === target);

    expect(snapshot.peerBand.mode).toBe("knn");
    expect(snapshot.peerBand.count).toBe(73);
    expect(rec).toBeDefined();
    // Both cohorts contribute entries: the below peers are cohort members now
    // (the old wD-only admission dropped all 60 of them).
    expect(rec?.peerCount).toBe(73);
    // Discovery stays wD-only: the below peers hold zero discovery weight, so
    // the fraction is still "all 13 discovery peers farm this" = 1.
    expect(rec?.peerFraction).toBe(1);
    // The missing-map benchmark (q0.4 of the benchmark kernel) now sees the
    // below-you mass and lands in the 400 block; the old clipped cohort read
    // a pure-700 kernel and quoted 700.
    expect(rec?.benchmarkPp ?? 700).toBeLessThan(550);
    expect(rec?.benchmarkPp ?? 0).toBeGreaterThanOrEqual(400);
  });
});

describe("farm helper peerFraction eligibility (E)", () => {
  it("excludes drive-by farmers from the fraction numerator like the denominator", async () => {
    const recent = nowIso();
    const target = 42_000;
    const support = Array.from({ length: 5 }, (_, i) => 42_010 + i);
    // Pure 5K subject -> total-pp fallback cohort (no keymode pool floor, so
    // peers with a single farmed row can exist at all).
    const ownedIds = Array.from({ length: 10 }, (_, i) => 42_050 + i);
    const bestScores = ownedIds.map((beatmapId, i) => subjectScore(beatmapId, 700 - i * 5, recent, 5, 5));
    await insertBeatmapMeta(target, 5, 5);
    for (const beatmapId of [...support, ...ownedIds]) await insertBeatmapMeta(beatmapId, 5, 5);

    // 6 meaningful-sample peers (5 support rows each; >= MIN_FARMED_FOR_SAMPLE),
    // 3 of whom also farm the target. 4 drive-by peers farm ONLY the target.
    for (let i = 0; i < 6; i += 1) {
      const id = 42_100 + i;
      await insertUser(id, SUBJECT_PP, "CR", `SamplePeer${i}`);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 600, recent);
      if (i < 3) await insertFarmed("CR", id, target, 600, recent);
    }
    for (let i = 0; i < 4; i += 1) {
      const id = 42_200 + i;
      await insertUser(id, SUBJECT_PP, "US", `DriveByPeer${i}`);
      await insertFarmed("US", id, target, 600, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores, SUBJECT_PP), "Subject", { keyMode: "any" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === target);

    expect(snapshot.peerBand.mode).toBe("total_pp_fallback");
    expect(rec).toBeDefined();
    // All 7 farmers appear as entries, but only the 3 eligible ones count
    // toward the fraction: 3 of 6 meaningful-sample peers = 0.5. The old
    // numerator summed all 7 against the 6-peer denominator and hid the
    // overflow behind the Math.min(1, ...) clamp.
    expect(rec?.peerCount).toBe(7);
    expect(rec?.peerSampleSize).toBe(6);
    expect(rec?.peerFraction).toBe(0.5);
  });
});

describe("farm helper quantile reliability guard (F)", () => {
  const target = 43_000;
  const support = Array.from({ length: 8 }, (_, i) => 43_010 + i);

  // Subject owns the target lane (with judgement counts, so a push target is
  // available) plus 10 4K plays pinning the variant pp. 15 near peers (d = 0,
  // full wB) farm ONLY the support maps; 11 far peers at d = +0.12 sit inside
  // the discovery kernel (wD ~ 0.2) but OUTSIDE the benchmark kernel (wB = 0)
  // and are the target lane's only farmers: the lane's entries clear
  // PEER_MIN_COUNT while its benchmark kernel is empty.
  async function seedEmptyKernelLane(): Promise<OscScore[]> {
    const recent = nowIso();
    const subjectMaps = Array.from({ length: 10 }, (_, i) => 43_050 + i);
    const bestScores = subjectMaps.map((beatmapId, i) => subjectScore(beatmapId, 480 - i * 5, recent, 4, 5));
    bestScores.push(subjectScore(target, 400, recent, 4, 5, [], statsForCustomAcc(0.97)));
    await insertBeatmapMeta(target, 4, 5);
    for (const beatmapId of [...support, ...subjectMaps]) await insertBeatmapMeta(beatmapId, 4, 5);

    for (let i = 0; i < 15; i += 1) {
      const id = 43_100 + i;
      await insertUser(id, 15_000, "CR", `NearPeer${i}`);
      await exec(db, "update users set pp_4k = 10000 where user_id = ?", [id]);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 300, recent);
    }
    for (let i = 0; i < 11; i += 1) {
      const id = 43_200 + i;
      await insertUser(id, 15_000, "US", `FarPeer${i}`);
      await exec(db, "update users set pp_4k = 11200 where user_id = ?", [id]);
      await insertFarmed("US", id, target, 395, recent);
      for (let j = 0; j < 7; j += 1) await insertFarmed("US", id, support[j], 300, recent);
    }
    return bestScores;
  }

  it("gain view never ships a rec whose benchmark kernel holds fewer than two peers", async () => {
    const bestScores = await seedEmptyKernelLane();
    const osu = makeOsuStub(bestScores, 15_000, { "4k": 10_000 });
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    // The old behavior shipped a push rec here with peerPpMedian 0 (every
    // benchmark weight is 0, weightedQuantile of an empty kernel).
    expect(snapshot.recs.some((rec) => rec.beatmapId === target)).toBe(false);
    expect(snapshot.recs.every((rec) => rec.peerPpMedian > 0)).toBe(true);
  });

  it("popular view falls back to unweighted quantiles instead of a 0 median", async () => {
    const bestScores = await seedEmptyKernelLane();
    const osu = makeOsuStub(bestScores, 15_000, { "4k": 10_000 });
    const popular = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k", view: "popular" });
    const rec = popular.recs.find((candidate) => candidate.beatmapId === target);
    expect(rec).toBeDefined();
    expect(rec?.reason).toBe("owned");
    // The unweighted fallback median over the 11 far entries, not 0.
    expect(rec?.peerPpMedian).toBe(395);
  });
});

describe("farm helper stale recency (G/H)", () => {
  const BM_ABANDONED = 17;
  const BM_REPLAYED = 18;

  it("does not call a map stale when peers only refreshed it, not played it", async () => {
    const old = "2022-01-01T00:00:00Z";
    const oldPlayedAt = "2023-01-01T00:00:00.000Z";
    const recent = nowIso();
    const bestScores = [...buildSubjectBestScores(), subjectScore(BM_ABANDONED, 600, old)];
    await seedPeers();
    await insertBeatmapMeta(BM_ABANDONED);
    // Peer rows on the abandoned map: p75 clears the margin, updated_at is
    // fresh (the periodic refresh rewrites it for every row), but nobody has
    // actually PLAYED it since 2023. The old updated_at-based gate always
    // passed; the real play recency must fail it.
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_ABANDONED, i < 10 ? 600 : 660, recent, [], oldPlayedAt);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_ABANDONED)).toBe(false);
    // Control: BM_STALE (identical spread, recently played peers) still fires.
    expect(snapshot.recs.find((rec) => rec.beatmapId === BM_STALE)?.reason).toBe("stale");
  });

  it("does not call a lane stale when the subject replayed it recently below their PB", async () => {
    const old = "2022-01-01T00:00:00Z";
    // Genuinely recent (within STALE_AGE_MS of now), unlike the fixture's
    // frozen 2024 "recent" which has itself aged past the threshold.
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const bestScores = [
      ...buildSubjectBestScores(),
      // Old PB at 600 plus a recent lower play on the same lane (distinct
      // score id): the lane is fresh engagement, not an old PB gathering dust.
      subjectScore(BM_REPLAYED, 600, old),
      { ...subjectScore(BM_REPLAYED, 500, recent), id: 999_918 },
    ];
    await seedPeers();
    await insertBeatmapMeta(BM_REPLAYED);
    // Median 600 (no improve), p75 660 (stale headroom) - the BM_STALE shape.
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_REPLAYED, i < 10 ? 600 : 660, nowIso());
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_REPLAYED)).toBe(false);
    // Control: the same peer shape with no recent replay still reads stale,
    // and the displayed date stays the PB's ("your 600pp score is X old").
    const stale = snapshot.recs.find((rec) => rec.beatmapId === BM_STALE);
    expect(stale?.reason).toBe("stale");
    expect(stale?.subjectPlayedAt).toBe(old);
  });
});

describe("farm helper popular view parity (K)", () => {
  const BM_ACC = 14;
  const BM_OVER_CAP = 44_000;
  const STREAM_PAT = [0, 1, 0, 0, 0, 0, 0, 0];

  it("quotes the same acc-scaled, capped numbers as the gain view; rows clamp instead of dropping", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_ACC, 4, 5);
    await insertSearchIndex(BM_ACC, STREAM_PAT, 4, { Stream: 24 });
    await insertBeatmapMeta(BM_OVER_CAP, 4, 5);
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_ACC, 620, nowIso());
      // Far above the subject's cap (700 * 1.15 = 805): the gain view drops
      // it, popular keeps the row but clamps the target to the cap instead
      // of quoting the uncapped 900.
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_OVER_CAP, 900, nowIso());
    }
    // A weak accuracy curve discounts BM_ACC's target below the peers' 620.
    const model: PlayerAccModel = {
      v: ACC_MODEL_VERSION,
      modes: {
        "4": {
          keys: 4, rating: 25, n: 100, w: 1000, a: Math.log(0.10), bn: 0.085, bp: 0.15,
          s: 0.3, mean: 0.95, lo: -10, hi: 10, fam: {}, choke: [],
        },
      },
    };
    await seedSubjectSkillRatings(SUBJECT_ID, 4, { Overall: 25 }, 40);
    await exec(db, "update player_skill_ratings set acc_model_json = ? where user_id = ?", [JSON.stringify(model), SUBJECT_ID]);

    const gain = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const popular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });

    const gainAcc = gain.recs.find((rec) => rec.beatmapId === BM_ACC);
    const popularAcc = popular.recs.find((rec) => rec.beatmapId === BM_ACC);
    expect(gainAcc).toBeDefined();
    expect(popularAcc).toBeDefined();
    // Same map, same number on both views (the old popular forced accModel
    // null and quoted the unscaled 620).
    expect(popularAcc?.benchmarkPp).toBe(gainAcc?.benchmarkPp);
    expect(popularAcc?.benchmarkPp ?? 620).toBeLessThan(620);
    expect(popularAcc?.estimatedPpGain).toBe(gainAcc?.estimatedPpGain);

    // The over-cap map: dropped from gain, clamped (not uncapped) on popular.
    expect(gain.recs.some((rec) => rec.beatmapId === BM_OVER_CAP)).toBe(false);
    const popularCapped = popular.recs.find((rec) => rec.beatmapId === BM_OVER_CAP);
    expect(popularCapped?.benchmarkPp).toBeCloseTo(700 * 1.15, 1);
  });
});

describe("farm helper gain-view lane collapse (L)", () => {
  it("keeps one lane per beatmap on the gain board, preferring the stronger lane", async () => {
    const BM_DUAL = 19;
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_DUAL);
    // Every peer farms the same chart in BOTH speed lanes; each lane alone
    // qualifies, and both claim (nearly) the full gain against the shared
    // baseline. The board must spend one slot, not two. (The farmed table is
    // unique per country+user+beatmap, so the DT rows live under a third
    // country; lanes are still keyed per user across countries.)
    for (let i = 0; i < 15; i += 1) {
      const country = i < 8 ? "CR" : "US";
      await insertFarmed(country, 100 + i, BM_DUAL, 620, nowIso());
      await insertFarmed("JP", 100 + i, BM_DUAL, 630, nowIso(), ["DT"]);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const dualRecs = snapshot.recs.filter((rec) => rec.beatmapId === BM_DUAL);
    expect(dualRecs.length).toBe(1);
    // The DT lane's higher benchmark wins the collapse.
    expect(dualRecs[0]?.speedBucket).toBe("dt");
    // totalQualifying counts collapsed lanes (3 seedPeers maps + 1 here).
    expect(snapshot.totalQualifying).toBe(4);
  });
});

describe("farm helper lane-scaled meta (M)", () => {
  it("emits rate-adjusted bpm and length on DT/HT lanes and raw meta on normal lanes", async () => {
    const BM_DT = 45_000;
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_DT, 4, 5);
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_DT, 620, nowIso(), ["DT"]);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const dt = snapshot.recs.find((rec) => rec.beatmapId === BM_DT);
    expect(dt?.speedBucket).toBe("dt");
    // Base meta is 180 bpm / 120s: the DT lane plays at 270 bpm for 80s,
    // which is what the map detail page shows at the 1.5x rate. Stars stay
    // NM-scaled on both surfaces.
    expect(dt?.bpm).toBe(270);
    expect(dt?.lengthSec).toBe(80);
    expect(dt?.stars).toBe(5);

    const normal = snapshot.recs.find((rec) => rec.beatmapId === BM_MISSING);
    expect(normal?.bpm).toBe(180);
    expect(normal?.lengthSec).toBe(120);
  });
});

describe("farm helper modelsReady flag (N)", () => {
  it("reports whether the subject's skill breakdown is ready, on both views", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();

    const before = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const beforePopular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });
    expect(before.modelsReady).toBe(false);
    expect(beforePopular.modelsReady).toBe(false);

    await seedSubjectSkillRatings(SUBJECT_ID, 4, { Overall: 25 }, 40);
    invalidateFarmHelperCacheForUser(db, SUBJECT_ID);
    const after = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const afterPopular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });
    expect(after.modelsReady).toBe(true);
    expect(afterPopular.modelsReady).toBe(true);
  });
});
