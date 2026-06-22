import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperSnapshot } from "../src/features/farm-helper.js";
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

async function insertFarmed(country: string, userId: number, beatmapId: number, pp: number, updatedAt: string, mods: string[] = []): Promise<void> {
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values (?, ?, ?, ?, ?, '{}', ?, null, ?, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, JSON.stringify(mods), updatedAt, updatedAt, updatedAt],
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

    expect(snapshot.peerBand.mode).toBe("pp_band");
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

    for (let i = 0; i < 264; i += 1) {
      const id = 3000 + i;
      await insertUser(id, SUBJECT_PP + i, "CR", `KeyClosePeer${i}`);
      for (let j = 0; j < supportBeatmaps.length; j += 1) {
        await insertFarmed("CR", id, supportBeatmaps[j], supportPps[j] ?? 0, recent);
      }
    }
    for (let i = 0; i < 36; i += 1) {
      const id = 4000 + i;
      await insertUser(id, SUBJECT_PP + 300 + i, "US", `KeyOuterPeer${i}`);
      for (let j = 0; j < supportBeatmaps.length; j += 1) {
        await insertFarmed("US", id, supportBeatmaps[j], supportPps[j] ?? 0, recent);
      }
      await insertFarmed("US", id, targetBeatmap, 620, recent);
    }

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { keyMode: "4k" });
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === targetBeatmap);

    expect(snapshot.peerBand.mode).toBe("4k_pp_proxy");
    expect(snapshot.peerBand.count).toBe(300);
    expect(snapshot.peerBand.farmDataCount).toBe(300);
    expect(rec?.reason).toBe("missing");
    expect(rec?.peerCount).toBe(36);
    expect(rec?.peerSampleSize).toBe(300);
    expect(rec?.peerFraction).toBe(0.12);
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

    expect(snapshot.peerBand.mode).toBe("7k_nearest");
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

    expect(snapshot.peerBand.mode).toMatch(/^7k_pp_proxy/);
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

    expect(snapshot.peerBand.mode).toMatch(/^4k_pp_proxy/);
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
    expect(snapshot.peerBand.mode).toBe("pp_band");
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
});
