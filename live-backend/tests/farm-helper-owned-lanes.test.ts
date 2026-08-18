import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getFarmHelperSnapshot } from "../src/features/farm-helper.js";
import { nowIso } from "../src/shared/score.js";
import type { OsuApiClient } from "../src/osu/client.js";
import type { OscScore, OsuMod } from "../src/shared/types.js";

// What the board does with a map the subject already owns when their peers farm
// it under different mods:
//  - the rec carries their pb from the other speed lane
//    (subjectOtherLanePp/subjectOtherLaneSpeed) so the UI never claims they
//    never played it;
//  - that lane's target is the peer median, not the lower discovery quantile,
//    which would advertise a number below a score they already hold;
//  - the popularity floor, a discovery filter, does not apply to a lane they
//    already have a score on, so the lane holding their pp cannot vanish just
//    because their band farms the chart on another rate.

let dir = "";
let db: Db;

const SUBJECT_ID = 1;
const SUBJECT_PP = 5000;
// Peers farm this one on HT; the subject owns it on nomod.
const BM_OTHER_LANE = 20;
// Peers farm this one on HT too, with the identical spread; the subject has
// never touched it, so it stays the discovery case throughout.
const BM_UNPLAYED = 21;
const SUBJECT_NOMOD_PP = 700;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-farm-other-lane-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function subjectScore(beatmapId: number, pp: number, mods: string[] = []): OscScore {
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
      difficulty_rating: 5,
      mode: "mania",
      cs: 4,
      bpm: 180,
      version: "Insane",
      url: `https://osu.ppy.sh/b/${beatmapId}`,
    },
    ended_at: "2024-06-01T00:00:00Z",
  };
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

async function insertUser(id: number, country: string): Promise<void> {
  await exec(
    db,
    "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
    [id, `Peer${id}`, `https://a.ppy.sh/${id}`, country, SUBJECT_PP, nowIso()],
  );
}

async function insertFarmed(country: string, userId: number, beatmapId: number, pp: number, mods: string[] = []): Promise<void> {
  const now = nowIso();
  const speedBucket = mods.includes("HT") ? "ht" : mods.includes("DT") ? "dt" : "normal";
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, accuracy, speed_bucket, mods_key)
     values (?, ?, ?, ?, ?, '{}', ?, null, ?, ?, ?, null, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, JSON.stringify(mods), now, now, now, speedBucket, mods.join(",")],
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

// Filler maps the subject owns competitively: peers farming them qualifies the
// cohort without those maps surfacing as recs of their own.
const FILLER = [900, 901, 902, 903, 904, 905, 906];

// Peers count for the popularity floor: PEER_MIN_COUNT (3) farmers out of a
// cohort this size weighs in well under PEER_MIN_FRACTION (0.12), which is
// exactly the shape the floor used to swallow.
const RARE_PEERS = 3;
const RARE_TOTAL_PEERS = 60;
const BM_RARE_OWNED = 30;
const BM_RARE_UNOWNED = 31;
// Every peer needs a farm profile whose weighted pp lands near the subject's
// SUBJECT_PP, or the cohort selection drops them before any gate runs, and every
// peer's profile has to be IDENTICAL, or the kernel weights the rare farmers
// differently and the cohort share stops being 3-in-60. So the rare farmers
// swap two fillers for the two rare maps at the same pp rather than adding them.
const RARE_FILLER = Array.from({ length: 20 }, (_, i) => 800 + i);
const RARE_FILLER_PP = 400;
// The subject sits well under the peers on the rare map, so the lane is a real
// improve rec once it clears the floor.
const SUBJECT_RARE_PP = 250;

// The two HT lanes carry an identical, deliberately skewed peer spread, so the
// peer median and the lower discovery quantile are far apart and which one a
// lane's target used is readable off the rec.
function htPeerPp(i: number): number {
  return 300 + i * 30;
}

async function seed(): Promise<void> {
  for (const beatmapId of [...FILLER, BM_OTHER_LANE, BM_UNPLAYED]) await insertBeatmapMeta(beatmapId);
  for (let i = 0; i < 15; i += 1) {
    const id = 100 + i;
    const country = i < 8 ? "CR" : "US";
    await insertUser(id, country);
    await insertFarmed(country, id, BM_OTHER_LANE, htPeerPp(i), ["HT"]);
    await insertFarmed(country, id, BM_UNPLAYED, htPeerPp(i), ["HT"]);
    for (const beatmapId of FILLER) await insertFarmed(country, id, beatmapId, 300);
  }
}

// A cohort where only RARE_PEERS of RARE_TOTAL_PEERS farm two otherwise
// identical maps: one the subject already has a score on, one they do not.
async function seedRare(): Promise<void> {
  for (const beatmapId of [...RARE_FILLER, BM_RARE_OWNED, BM_RARE_UNOWNED]) await insertBeatmapMeta(beatmapId);
  for (let i = 0; i < RARE_TOTAL_PEERS; i += 1) {
    const id = 200 + i;
    const country = i < RARE_TOTAL_PEERS / 2 ? "CR" : "US";
    await insertUser(id, country);
    const farms = i < RARE_PEERS
      ? [...RARE_FILLER.slice(0, RARE_FILLER.length - 2), BM_RARE_OWNED, BM_RARE_UNOWNED]
      : RARE_FILLER;
    for (const beatmapId of farms) await insertFarmed(country, id, beatmapId, RARE_FILLER_PP);
  }
}

function buildBestScores(): OscScore[] {
  const scores = [subjectScore(BM_OTHER_LANE, SUBJECT_NOMOD_PP)];
  for (let i = 0; i < 30; i += 1) scores.push(subjectScore(900 + i, 500 - i * 5));
  return scores;
}

describe("farm helper owned lanes", () => {
  it("reports the subject's nomod pb on a lane peers farm under HT, and nothing on a map they never played", async () => {
    await seed();

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(buildBestScores()), "Subject", { view: "popular" });

    const htLane = snapshot.recs.find((rec) => rec.beatmapId === BM_OTHER_LANE);
    expect(htLane).toBeDefined();
    expect(htLane?.speedBucket).toBe("ht");
    // No score of theirs in THIS lane, so the lane still reads missing...
    expect(htLane?.reason).toBe("missing");
    expect(htLane?.subjectPp).toBeNull();
    // ...but the map is theirs, under nomod, which is what the copy needs.
    expect(htLane?.subjectOtherLanePp).toBe(SUBJECT_NOMOD_PP);
    expect(htLane?.subjectOtherLaneSpeed).toBe("normal");

    const unplayed = snapshot.recs.find((rec) => rec.beatmapId === BM_UNPLAYED);
    expect(unplayed).toBeDefined();
    expect(unplayed?.reason).toBe("missing");
    expect(unplayed?.subjectPp).toBeNull();
    expect(unplayed?.subjectOtherLanePp).toBeNull();
    expect(unplayed?.subjectOtherLaneSpeed).toBeNull();
  });

  it("targets an owned map's other lane at the peer median, not the discovery quantile", async () => {
    await seed();

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(buildBestScores()), "Subject", { view: "popular" });
    const owned = snapshot.recs.find((rec) => rec.beatmapId === BM_OTHER_LANE);
    const discovery = snapshot.recs.find((rec) => rec.beatmapId === BM_UNPLAYED);

    // Same peer spread on both, so the only difference is that one map is
    // already the subject's.
    expect(owned?.peerPpMedian).toBe(discovery?.peerPpMedian);
    expect(owned?.benchmarkPp).toBe(owned?.peerPpMedian);
    // The map they have never touched keeps the lower discovery target.
    expect(discovery?.benchmarkPp).toBeLessThan(discovery!.peerPpMedian);
  });

  it("keeps a lane the subject already scored on even below the popularity floor", async () => {
    await seedRare();

    const scores = [subjectScore(BM_RARE_OWNED, SUBJECT_RARE_PP)];
    for (const beatmapId of RARE_FILLER) scores.push(subjectScore(beatmapId, 430));

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(scores), "Subject");
    const owned = snapshot.recs.find((rec) => rec.beatmapId === BM_RARE_OWNED);
    const unowned = snapshot.recs.find((rec) => rec.beatmapId === BM_RARE_UNOWNED);

    // Same peers, same pp, same share of the cohort: only the subject's own
    // score separates them.
    expect(owned?.reason).toBe("improve");
    expect(owned?.subjectPp).toBe(SUBJECT_RARE_PP);
    expect(owned!.peerFraction).toBeLessThan(0.12);
    expect(owned!.estimatedPpGain).toBeGreaterThan(0);
    // The floor still hides the chart they have no stake in.
    expect(unowned).toBeUndefined();
  });

  it("leaves the other-lane fields empty when the lane itself is played", async () => {
    await seed();

    // Same board, but the subject's pb on BM_OTHER_LANE is itself an HT score.
    const scores = [subjectScore(BM_OTHER_LANE, SUBJECT_NOMOD_PP, ["HT"])];
    for (let i = 0; i < 30; i += 1) scores.push(subjectScore(900 + i, 500 - i * 5));

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(scores), "Subject", { view: "popular" });
    const htLane = snapshot.recs.find((rec) => rec.beatmapId === BM_OTHER_LANE);
    expect(htLane?.subjectPp).toBe(SUBJECT_NOMOD_PP);
    expect(htLane?.subjectOtherLanePp).toBeNull();
    expect(htLane?.subjectOtherLaneSpeed).toBeNull();
  });
});
