import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { buildFarmHelperSnapshotForBacktest, FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperSnapshot } from "../src/features/farm-helper.js";
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
     values (?, 3, 'ready', '[]', ?, ?, ?)`,
    [userId, modesJson, now, now],
  );
}

const stubQueue = { enqueue: async () => {} } as unknown as Parameters<typeof getFarmHelperSnapshot>[4];

async function seedPeers(): Promise<void> {
  const recent = nowIso();
  for (let i = 0; i < 15; i += 1) {
    const id = 100 + i;
    const country = i < 8 ? "CR" : "US"; // two countries -> exercises global aggregation
    await insertUser(id, SUBJECT_PP, country);
    await insertFarmed(country, id, BM_IMPROVE, 600, recent); // median 600 (subject only 400)
    await insertFarmed(country, id, BM_MISSING, 620, recent); // median 620 (subject missing)
    await insertFarmed(country, id, BM_STALE, i < 10 ? 600 : 660, recent); // median 600, p75 660
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
    for (let i = 0; i < 15; i += 1) {
      const id = 700 + i;
      await insertUser(id, SUBJECT_PP, "CR", `SpreadPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, i < 5 ? 500 : 700, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(rec?.reason).toBe("missing");
    expect(rec?.benchmarkPp).toBeGreaterThan(500);
    expect(rec?.estimatedPpGain).toBeGreaterThan(1);
  });

  it("uses every player in the pp band instead of capping at 250 peers", async () => {
    const bestScores = buildSubjectBestScores();
    const recent = nowIso();
    const targetBeatmap = 60;

    await insertBeatmapMeta(targetBeatmap);
    for (let i = 0; i < 264; i += 1) {
      await insertUser(1000 + i, SUBJECT_PP + i, "CR", `ClosePeer${i}`);
    }
    for (let i = 0; i < 36; i += 1) {
      const id = 2000 + i;
      await insertUser(id, SUBJECT_PP + 300 + i, "US", `OuterPeer${i}`);
      await insertFarmed("US", id, targetBeatmap, 620, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { keyMode: "any" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.mode).toBe("knn");
    expect(snapshot.peerBand.count).toBe(300);
    expect(snapshot.peerBand.farmDataCount).toBe(36);
    expect(rec?.reason).toBe("missing");
    expect(rec?.peerCount).toBe(36);
    expect(rec?.peerSampleSize).toBe(36);
    expect(rec?.peerFraction).toBe(1);
  });

  it("scores Any-mode farm overlap against peers with farm data", async () => {
    const bestScores = buildSubjectBestScores();
    const recent = nowIso();
    const targetBeatmap = 65;
    const fillerBeatmap = 66;

    await insertBeatmapMeta(targetBeatmap);
    await insertBeatmapMeta(fillerBeatmap);
    for (let i = 0; i < 39; i += 1) {
      await insertUser(5000 + i, SUBJECT_PP + i, "CR", `NoDataPeer${i}`);
    }
    for (let i = 0; i < 8; i += 1) {
      const id = 6000 + i;
      await insertUser(id, SUBJECT_PP + 100 + i, "US", `DataPeer${i}`);
      await insertFarmed("US", id, i < 4 ? targetBeatmap : fillerBeatmap, 620, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { keyMode: "any" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.count).toBe(47);
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

  it("does not show off-keymode Any recommendations above the player's key-mode range", async () => {
    const recent = nowIso();
    const safe4kBeatmap = 76;
    const tooHard7kBeatmap = 77;
    const bestScores = buildSubjectBestScores();

    await insertBeatmapMeta(safe4kBeatmap, 4, 5);
    await insertBeatmapMeta(tooHard7kBeatmap, 7, 8);
    for (let i = 0; i < 15; i += 1) {
      const id = 7100 + i;
      await insertUser(id, 12_350 + i, "CR", `OverallPeer${i}`);
      await insertFarmed("CR", id, safe4kBeatmap, 620, recent);
      await insertFarmed("CR", id, tooHard7kBeatmap, 620, recent);
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

  it("scopes the who-farms list to the snapshot keyMode (Any keeps the total-pp pool)", async () => {
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

    // 4K-strength peers: total pp BELOW the subject's total-pp band, but their 4K
    // farm strength matches the subject, so only the key-mode band should see them.
    for (let i = 0; i < 12; i += 1) {
      const id = 700 + i;
      await insertUser(id, 13_000, "CR", `KeyPeer${i}`);
      await insertFarmed("CR", id, targetBeatmap, 520, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("CR", id, beatmapId, 500 - i, recent);
    }

    // High total-pp, 4K-light farmers (the bojii/logann case): inside the subject's
    // total-pp band, so the Any/total-pp pool is the cohort that should see them.
    for (let i = 0; i < 12; i += 1) {
      const id = 800 + i;
      await insertUser(id, 15_000, "US", `TotalPpPeer${i}`);
      await insertFarmed("US", id, targetBeatmap, 900, recent);
      for (const beatmapId of supportBeatmaps) await insertFarmed("US", id, beatmapId, 900 - i, recent);
    }

    const osu = makeOsuStub(bestScores, 15_000);

    // The Any card samples the total-pp band -> the high-total-pp cohort.
    const snapshot = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "any" });
    expect(snapshot.peerBand.mode).toBe("knn");
    expect(snapshot.peerBand.count).toBe(12);
    expect(snapshot.peerBand.farmDataCount).toBe(12);

    // The who-farms list must mirror that Any cohort, not silently switch to a 4K
    // band (which is what produced the card-vs-modal count mismatch).
    const anyFarmers = await getFarmHelperFarmers(db, osu, "Subject", targetBeatmap, undefined, "any");
    expect(anyFarmers.total).toBe(12);
    expect(anyFarmers.farmers.every((peer) => peer.username.startsWith("TotalPpPeer"))).toBe(true);

    // Without a keyMode it still falls back to the map's key count (4K), selecting
    // the key-strength cohort instead -> a disjoint set of players.
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
    for (let i = 0; i < 15; i += 1) {
      const id = 200 + i;
      await insertUser(id, SUBJECT_PP, i < 8 ? "CR" : "US");
      // BM_PAST farmed before the cutoff (kept), BM_FUTURE after (dropped).
      await insertFarmed("CR", id, BM_PAST, 620, "2024-05-01T00:00:00Z", [], "2024-05-01T00:00:00Z");
      await insertFarmed("CR", id, BM_FUTURE, 620, "2024-07-01T00:00:00Z", [], "2024-07-01T00:00:00Z");
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
});
