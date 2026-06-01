import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperSnapshot } from "../src/features/farm-helper.js";
import { calculateWeightedPpTotal, nowIso } from "../src/shared/score.js";
import { OsuApiError, type OsuApiClient } from "../src/osu/client.js";
import type { OscScore } from "../src/shared/types.js";

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

function subjectScore(beatmapId: number, pp: number, endedAt: string): OscScore {
  return {
    id: beatmapId,
    user_id: SUBJECT_ID,
    accuracy: 0.99,
    mods: [],
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
      difficulty_rating: 5,
      mode: "mania",
      cs: 4,
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

function makeOsuStub(bestScores: OscScore[]): Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow"> {
  const user = {
    id: SUBJECT_ID,
    username: "Subject",
    avatar_url: "https://a.ppy.sh/1",
    country_code: "CR",
    statistics: { pp: SUBJECT_PP },
  };
  return {
    getUser: async () => user,
    getUserByKey: async () => user,
    getUserBestScoresWindow: async () => bestScores,
  } as unknown as Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow">;
}

let nextScoreId = 1;

async function insertUser(id: number, pp: number, country: string): Promise<void> {
  await exec(
    db,
    "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
    [id, `Peer${id}`, `https://a.ppy.sh/${id}`, country, pp, nowIso()],
  );
}

async function insertFarmed(country: string, userId: number, beatmapId: number, pp: number, updatedAt: string): Promise<void> {
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values (?, ?, ?, ?, ?, '{}', null, null, ?, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, updatedAt, updatedAt, updatedAt],
  );
}

async function insertBeatmapMeta(beatmapId: number): Promise<void> {
  const setId = beatmapId + 100;
  const now = nowIso();
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
     values (?, ?, 'mania', 'ranked', 4, 5, 180, 120, 'Insane', ?, ?)`,
    [beatmapId, setId, `https://osu.ppy.sh/b/${beatmapId}`, now],
  );
  await exec(
    db,
    `insert into maps_beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
     values (?, ?, 'Artist', 'Mapper', 'ranked', ?, 1000, 10, '', 180, '[4]', '[]', ?)`,
    [setId, `Map ${beatmapId}`, JSON.stringify({ list: `cover-${beatmapId}` }), now],
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
    expect(snapshot.keyMode).toBe("4k");
    expect(snapshot.peerBand.count).toBe(15);
    expect(snapshot.recs.length).toBe(3);

    const byBeatmap = new Map(snapshot.recs.map((rec) => [rec.beatmapId, rec]));

    const missing = byBeatmap.get(BM_MISSING);
    expect(missing?.reason).toBe("missing");
    expect(missing?.subjectPp).toBeNull();
    expect(missing?.peerCount).toBe(15);

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
