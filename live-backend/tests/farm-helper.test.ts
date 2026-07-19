import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { buildFarmHelperSnapshotForBacktest, FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperSnapshot } from "../src/features/farm-helper.js";
import { PLAYER_SKILLS_VERSION } from "../src/features/player-skills.js";
import { SKILL_BASELINE_VERSION } from "../src/features/skill-baseline.js";
import { calculateWeightedPpTotal, nowIso } from "../src/shared/score.js";
import { OsuApiError, type OsuApiClient } from "../src/osu/client.js";
import type { OscScore, OsuMod } from "../src/shared/types.js";

let dir = "";
let db: Db;

const SUBJECT_ID = 1;
const SUBJECT_PP = 5000;
const BM_IMPROVE = 10;
const BM_STALE = 11;
const BM_MISSING = 12;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-farm-helper-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function subjectScore(beatmapId: number, pp: number, endedAt: string, keys = 4, stars = 5, mods: string[] = []): OscScore {
  return {
    id: beatmapId,
    user_id: SUBJECT_ID,
    accuracy: 0.99,
    mods: mods.map((acronym): OsuMod => ({ acronym })),
    score: 1_000_000,
    max_combo: 1000,
    passed: true,
    rank: "S",
    statistics: {},
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
): Promise<void> {
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values (?, ?, ?, ?, ?, '{}', ?, null, ?, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, JSON.stringify(mods), playedAt, updatedAt, updatedAt],
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

async function seedSubjectSkillRatings(userId: number, keyCount: number, ratings: Record<string, number>, analyzedPlays: number): Promise<void> {
  const modesJson = JSON.stringify({
    totalPlays: analyzedPlays,
    analyzedPlays,
    pendingPlays: 0,
    unsupportedPlays: 0,
    modes: [{ keyCount, analyzedPlays, ratings, patterns: [] }],
  });
  const now = nowIso();
  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, plays_json, modes_json, computed_at, updated_at)
     values (?, ?, 'ready', '[]', ?, ?, ?)`,
    [userId, PLAYER_SKILLS_VERSION, modesJson, now, now],
  );
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

    expect(snapshot.totalPotentialPp).toBeCloseTo(
      snapshot.recs.reduce((sum, rec) => sum + rec.estimatedPpGain, 0),
      2,
    );

    expect(missing?.topPeers.length).toBeGreaterThan(0);
    expect(missing?.topPeers[0]?.username).toMatch(/^Peer/);
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
      await insertFarmed("US", id, targetBeatmap, 950, recent);
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

  it("does not share cached snapshots between queue-less and queue-ful callers", async () => {
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

    // Queue-less caller (Discord-style): feasibility gate disabled, the over-MSD
    // chart stays visible. This primes the snapshot cache.
    const ungated = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" });
    expect(ungated.recs.some((rec) => rec.beatmapId === hard)).toBe(true);

    // A queue-ful caller with otherwise identical params must not be served the
    // cached ungated list: its feasibility gate drops the chart.
    const gated = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    expect(gated.recs.some((rec) => rec.beatmapId === hard)).toBe(false);
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
    // Totals sum: gains use the shared full-top baseline, so per-rec gain is the
    // same in a concrete view and inside the merged view.
    expect(any.totalPotentialPp).toBeCloseTo(fourk.totalPotentialPp + sevenk.totalPotentialPp, 2);
    expect(any.totalPotentialPp).toBeGreaterThan(0);
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
    // Subject plays only 5K: neither the 4K nor 7K pipeline is eligible. Their top
    // play (700) sets the benchmark cap above the peers' 600pp target.
    const owned = Array.from({ length: 10 }, (_, i) => 700 - i * 5);
    const ownedIds = Array.from({ length: 10 }, (_, i) => 8710 + i);
    const bestScores = ownedIds.map((beatmapId, i) => subjectScore(beatmapId, owned[i], recent, 5, 5));
    await insertBeatmapMeta(target, 5, 5);
    for (const beatmapId of ownedIds) await insertBeatmapMeta(beatmapId, 5, 5);

    for (let i = 0; i < 15; i += 1) {
      const id = 8800 + i;
      await insertUser(id, SUBJECT_PP + i, i < 8 ? "CR" : "US", `TotalPeer${i}`);
      await insertFarmed(i < 8 ? "CR" : "US", id, target, 600, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores, SUBJECT_PP), "Subject", { keyMode: "any" });

    expect(snapshot.peerBand.mode).toBe("total_pp_fallback");
    expect(snapshot.peerBands).toBeUndefined();
    expect(snapshot.recs.some((rec) => rec.beatmapId === target)).toBe(true);
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
});
