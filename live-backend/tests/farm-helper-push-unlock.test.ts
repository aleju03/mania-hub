import { registerFarmHelperBuildThread, getFarmHelperBuildThread } from "../src/features/farm-helper-thread.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getFarmHelperSnapshot, invalidateFarmHelperCacheForUser } from "../src/features/farm-helper.js";
import { calculateManiaCustomAccuracy, calculateWeightedPpTotal, getScoreSpeedBucket, nowIso } from "../src/shared/score.js";
import type { OsuApiClient } from "../src/osu/client.js";
import type { OscScore, OsuMod, OsuScoreStatistics } from "../src/shared/types.js";

// Skillboost ("push") suggestion memory and unlock state:
//  - a served gain board records its push lanes into farm_helper_push_targets
//    (frozen at first sight) and reports pushUnlocked false while nothing is
//    achieved; the locked headline total excludes the push recs;
//  - covering most of the pp gap toward a stored target marks it achieved and
//    flips pushUnlocked, permanently (the achieved row keeps it true even
//    after the lane stops pushing);
//  - progress below the achievement ratio stays locked;
//  - the popular browse never carries the field.

let dir = "";
let db: Db;

const SUBJECT_ID = 1;
const SUBJECT_PP = 5000;
const BM_PUSH = 13;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-farm-push-unlock-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  registerFarmHelperBuildThread(db, { databaseUrl: `file:${join(dir, "test.db")}` });
});

afterEach(async () => {
  await getFarmHelperBuildThread(db)?.close();
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

const RECENT = "2024-06-01T00:00:00Z";

// The subject's board with one push lane: their #1's high accuracy keeps the
// demonstrated-best cap above the push target, and BM_PUSH is owned at
// `pushPp` with judgement counts so computePushBenchmark can fire.
function buildBestScores(pushPp: number): OscScore[] {
  const scores: OscScore[] = [
    subjectScore(990, 700, RECENT, 4, 5, [], statsForCustomAcc(0.99)),
    subjectScore(BM_PUSH, pushPp, RECENT, 4, 5, [], statsForCustomAcc(0.97)),
  ];
  for (let i = 0; i < 30; i += 1) {
    scores.push(subjectScore(900 + i, 500 - i * 5, RECENT));
  }
  return scores;
}

function makeOsuStub(bestScores: OscScore[]): Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow"> {
  const user = {
    id: SUBJECT_ID,
    username: "Subject",
    avatar_url: "https://a.ppy.sh/1",
    country_code: "CR",
    statistics: { pp: SUBJECT_PP, variants: [] },
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

async function insertFarmed(country: string, userId: number, beatmapId: number, pp: number): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, accuracy, speed_bucket, mods_key)
     values (?, ?, ?, ?, ?, '{}', '[]', null, ?, ?, ?, null, ?, '')`,
    [country, userId, beatmapId, nextScoreId++, pp, now, now, now, getScoreSpeedBucket([])],
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

// Filler maps the subject owns competitively (~480-500pp): peers who farm them
// at 300pp qualify for the concrete 4K pool without the maps surfacing as recs.
const FILLER_4K = [900, 901, 902, 903, 904, 905, 906];

// Peers at the subject's pp who all farm BM_PUSH BELOW the subject's score, so
// the lane is neither improve nor stale and falls through to the push branch.
async function seedPushScenario(): Promise<void> {
  for (const beatmapId of FILLER_4K) await insertBeatmapMeta(beatmapId, 4, 5);
  await insertBeatmapMeta(BM_PUSH);
  for (let i = 0; i < 15; i += 1) {
    const id = 100 + i;
    const country = i < 8 ? "CR" : "US";
    await insertUser(id, SUBJECT_PP, country);
    await insertFarmed(country, id, BM_PUSH, 395);
    for (const beatmapId of FILLER_4K) await insertFarmed(country, id, beatmapId, 300);
  }
}

function expectedPushTarget(pushPp: number): number {
  const accNow = calculateManiaCustomAccuracy(statsForCustomAcc(0.97))!;
  const targetAcc = accNow + 0.0075;
  return pushPp * (5 * targetAcc - 4) / (5 * accNow - 4);
}

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

// The profile layer stores each mint in profile_snapshots and serves it for
// its TTL, so a build after a "new score" must drop the stored row for the
// stub's updated list to be re-read.
async function forgetStoredProfile(): Promise<void> {
  await exec(db, "delete from profile_snapshots where user_id = ?", [SUBJECT_ID]);
  invalidateFarmHelperCacheForUser(db, SUBJECT_ID);
}

async function readTargetRow(): Promise<Record<string, unknown> | undefined> {
  return (await exec(
    db,
    "select * from farm_helper_push_targets where user_id = ? and beatmap_id = ?",
    [SUBJECT_ID, BM_PUSH],
  )).rows[0] as Record<string, unknown> | undefined;
}

describe("farm helper skillboost unlock", () => {
  it("records suggested push lanes and serves the board locked until one is achieved", async () => {
    const bestScores = buildBestScores(400);
    await seedPushScenario();

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const push = snapshot.recs.find((rec) => rec.beatmapId === BM_PUSH);
    expect(push?.reason).toBe("push");
    expect(snapshot.pushUnlocked).toBe(false);

    const row = await readTargetRow();
    expect(row).toBeDefined();
    expect(Number(row?.subject_pp)).toBe(400);
    expect(Number(row?.target_pp)).toBeCloseTo(expectedPushTarget(400), 1);
    expect(row?.achieved_at).toBeNull();

    // The locked headline excludes the push rec: it is not in the default view.
    const withoutPush = snapshot.recs.filter((rec) => rec.reason !== "push");
    expect(snapshot.totalPotentialPp).toBeCloseTo(expectedCombinedGain(bestScores, withoutPush), 2);

    // The popular browse never carries the unlock state.
    const popular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });
    expect(popular.pushUnlocked).toBeUndefined();
  });

  it("unlocks once the player covers most of the gap to a suggested target, and stays unlocked", async () => {
    await seedPushScenario();
    await getFarmHelperSnapshot(db, makeOsuStub(buildBestScores(400)), "Subject");
    const target = expectedPushTarget(400); // ~417.6, gap ~17.6, 75% covered at ~413.2

    await forgetStoredProfile();
    const unlocked = await getFarmHelperSnapshot(db, makeOsuStub(buildBestScores(414)), "Subject");
    expect(unlocked.pushUnlocked).toBe(true);

    const row = await readTargetRow();
    expect(row?.achieved_at).not.toBeNull();
    expect(Number(row?.achieved_pp)).toBe(414);
    // The suggestion stays frozen at first sight: the improved score's new,
    // higher push target must not overwrite the achieved yardstick.
    expect(Number(row?.target_pp)).toBeCloseTo(target, 1);

    // The achieved row keeps the board unlocked on later builds, and the
    // headline now counts the push rec.
    await forgetStoredProfile();
    const later = await getFarmHelperSnapshot(db, makeOsuStub(buildBestScores(414)), "Subject");
    expect(later.pushUnlocked).toBe(true);
    expect(later.totalPotentialPp).toBeCloseTo(expectedCombinedGain(buildBestScores(414), later.recs), 2);
  });

  it("stays locked while progress sits below the achievement ratio", async () => {
    await seedPushScenario();
    await getFarmHelperSnapshot(db, makeOsuStub(buildBestScores(400)), "Subject");

    // 405 covers ~5pp of the ~17.6pp gap: well under the 75% achievement bar.
    await forgetStoredProfile();
    const stillLocked = await getFarmHelperSnapshot(db, makeOsuStub(buildBestScores(405)), "Subject");
    expect(stillLocked.pushUnlocked).toBe(false);
    expect((await readTargetRow())?.achieved_at).toBeNull();
  });
});
