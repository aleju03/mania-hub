import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getFarmHelperSnapshot, invalidateFarmHelperCacheForUser } from "../src/features/farm-helper.js";
import { nowIso } from "../src/shared/score.js";
import type { OsuApiClient } from "../src/osu/client.js";
import type { OscScore, OsuMod } from "../src/shared/types.js";

// Build-time feedback behavior of the farm-helper snapshot builder:
//  - the read-time reconcile writes through the caller-provided writeDb
//    (the HTTP serving-path invariant), never the read connection when one
//    is given;
//  - a "too easy" mark clamps an over-cap benchmark instead of vanishing
//    the rec;
//  - feedbackHiddenCount counts ONLY lanes that would actually have shown
//    (the too_hard hide runs as the last check before emission);
//  - a too_hard-hidden lane never shadows the same beatmap's other speed
//    lane through the gain-view collapse (hide first, then collapse).
// Feedback marks are seeded via direct SQL so these cases stay independent
// of the feedback module's own API (owned by tests/farm-helper-feedback.test.ts).

let dir = "";
let db: Db;

const SUBJECT_ID = 1;
const SUBJECT_PP = 5000;
const BM_IMPROVE = 10;
const BM_STALE = 11;
const BM_MISSING = 12;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-farm-build-feedback-"));
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
    subjectScore(990, 700, recent), // their #1, keeps the cap at 700 * 1.15 = 805
    subjectScore(BM_IMPROVE, 400, recent),
    subjectScore(BM_STALE, 600, old),
  ];
  for (let i = 0; i < 30; i += 1) {
    scores.push(subjectScore(900 + i, 500 - i * 5, recent));
  }
  return scores;
}

function makeOsuStub(bestScores: OscScore[], pp = SUBJECT_PP): Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow"> {
  const user = {
    id: SUBJECT_ID,
    username: "Subject",
    avatar_url: "https://a.ppy.sh/1",
    country_code: "CR",
    statistics: { pp, variants: [] },
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

async function insertFarmed(country: string, userId: number, beatmapId: number, pp: number, mods: string[] = []): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values (?, ?, ?, ?, ?, '{}', ?, null, ?, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, JSON.stringify(mods), now, now, now],
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

// Filler 4K maps the subject owns competitively, so peers clear the concrete
// 4K pool's farm-count floor without the fillers surfacing as recs.
const FILLER_4K = [900, 901, 902, 903, 904, 905, 906];

async function seedPeers(): Promise<void> {
  for (const beatmapId of FILLER_4K) await insertBeatmapMeta(beatmapId, 4, 5);
  for (let i = 0; i < 15; i += 1) {
    const id = 100 + i;
    const country = i < 8 ? "CR" : "US";
    await insertUser(id, SUBJECT_PP, country);
    await insertFarmed(country, id, BM_IMPROVE, 600);
    await insertFarmed(country, id, BM_MISSING, 620);
    await insertFarmed(country, id, BM_STALE, i < 10 ? 600 : 660);
    for (const beatmapId of FILLER_4K) await insertFarmed(country, id, beatmapId, 300);
  }
  await insertBeatmapMeta(BM_IMPROVE);
  await insertBeatmapMeta(BM_STALE);
  await insertBeatmapMeta(BM_MISSING);
}

async function insertMark(
  beatmapId: number,
  speedBucket: "normal" | "dt" | "ht",
  verdict: "too_hard" | "too_easy",
  createdAt = Date.now(),
): Promise<void> {
  await exec(
    db,
    `insert into farm_helper_feedback (user_id, beatmap_id, speed_bucket, verdict, created_at, updated_at, resolved_at, resolved_pp)
     values (?, ?, ?, ?, ?, ?, null, null)`,
    [SUBJECT_ID, beatmapId, speedBucket, verdict, createdAt, createdAt],
  );
}

describe("farm helper build-time feedback", () => {
  it("routes the read-time reconcile's writes through the provided writeDb (A)", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    // An active too_easy mark on the BM_IMPROVE lane, created BEFORE the
    // subject's stored 400pp play on it (2024-06-01): the build must reconcile
    // (resolve) it, and that write must go through writeDb, not db.
    await insertMark(BM_IMPROVE, "normal", "too_easy", Date.parse("2024-01-01T00:00:00Z"));

    let writeBatches = 0;
    const writeDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          const original = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            writeBatches += 1;
            return original.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as Db;

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", {}, undefined, { writeDb });
    expect(snapshot.status).toBe("ready");
    // The reconcile ran on the write connection...
    expect(writeBatches).toBeGreaterThanOrEqual(1);
    // ...and actually resolved the mark, stamping the later play's pp.
    const row = (await exec(
      db,
      "select resolved_at, resolved_pp from farm_helper_feedback where user_id = ? and beatmap_id = ?",
      [SUBJECT_ID, BM_IMPROVE],
    )).rows[0];
    expect(row?.resolved_at).not.toBeNull();
    expect(Number(row?.resolved_pp)).toBe(400);
    // The resolved mark no longer tags the rec.
    const improve = snapshot.recs.find((rec) => rec.beatmapId === BM_IMPROVE);
    expect(improve?.feedback).toBeUndefined();
  });

  it("keeps working without a writeDb (Discord and other queue-less callers)", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertMark(BM_IMPROVE, "normal", "too_easy", Date.parse("2024-01-01T00:00:00Z"));

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(snapshot.status).toBe("ready");
    const row = (await exec(
      db,
      "select resolved_at from farm_helper_feedback where user_id = ? and beatmap_id = ?",
      [SUBJECT_ID, BM_IMPROVE],
    )).rows[0];
    // The reconcile falls back to the read connection and still resolves.
    expect(row?.resolved_at).not.toBeNull();
  });

  it("clamps a too_easy lane's over-cap benchmark to the cap instead of dropping it (B)", async () => {
    const BM_CLAIMED = 46_000;
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_CLAIMED, 4, 5);
    // Peers farm the claimed map at 900, above the subject's benchmark cap
    // (top play 700 * 1.15 = 805).
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_CLAIMED, 900);
    }

    // Unmarked control: the over-cap benchmark still drops the lane.
    const unmarked = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(unmarked.recs.some((rec) => rec.beatmapId === BM_CLAIMED)).toBe(false);

    // An active too_easy mark: the player claimed the lane, so the target
    // clamps to the cap rather than vanishing.
    await insertMark(BM_CLAIMED, "normal", "too_easy");
    invalidateFarmHelperCacheForUser(db, SUBJECT_ID);
    const marked = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = marked.recs.find((candidate) => candidate.beatmapId === BM_CLAIMED);
    expect(rec).toBeDefined();
    expect(rec?.reason).toBe("missing");
    expect(rec?.benchmarkPp).toBeCloseTo(700 * 1.15, 1);
    expect(rec?.feedback).toBe("too_easy");
    // The player's claim also waives the survival label.
    expect(rec?.survival).toBe(1);
    expect(rec?.clearRisk).toBe(false);
  });

  it("counts only lanes that would have shown in feedbackHiddenCount (C)", async () => {
    const BM_WOULD_SHOW = 46_100;
    const BM_NEVER_QUALIFIED = 46_200;
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_WOULD_SHOW, 4, 5);
    await insertBeatmapMeta(BM_NEVER_QUALIFIED, 4, 5);
    for (let i = 0; i < 15; i += 1) {
      const country = i < 8 ? "CR" : "US";
      // Would-show lane: same shape as BM_MISSING (620, under the 805 cap).
      await insertFarmed(country, 100 + i, BM_WOULD_SHOW, 620);
      // Never-qualified lane: 900 sits over the cap, so it would have been
      // dropped with or without the mark.
      await insertFarmed(country, 100 + i, BM_NEVER_QUALIFIED, 900);
    }
    await insertMark(BM_WOULD_SHOW, "normal", "too_hard");
    await insertMark(BM_NEVER_QUALIFIED, "normal", "too_hard");

    const gain = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(gain.recs.some((rec) => rec.beatmapId === BM_WOULD_SHOW)).toBe(false);
    expect(gain.recs.some((rec) => rec.beatmapId === BM_NEVER_QUALIFIED)).toBe(false);
    // Only the lane that passed every other gate counts as "hidden by your
    // feedback"; the over-cap lane was never going to show.
    expect(gain.feedbackHiddenCount).toBe(1);

    // The popular browse keeps both rows, tagged.
    const popular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });
    expect(popular.recs.find((rec) => rec.beatmapId === BM_WOULD_SHOW)?.feedback).toBe("too_hard");
    expect(popular.recs.find((rec) => rec.beatmapId === BM_NEVER_QUALIFIED)?.feedback).toBe("too_hard");
    expect(popular.feedbackHiddenCount).toBeUndefined();
  });

  it("a too_hard-hidden speed lane never shadows the map's other lane (hide before collapse)", async () => {
    const BM_DUAL = 46_300;
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_DUAL, 4, 5);
    // Both lanes of the same chart qualify (the DT lane would win the
    // gain-view collapse on its higher benchmark). The farmed table is unique
    // per country+user+beatmap, so the DT rows live under a third country.
    for (let i = 0; i < 15; i += 1) {
      const country = i < 8 ? "CR" : "US";
      await insertFarmed(country, 100 + i, BM_DUAL, 620);
      await insertFarmed("JP", 100 + i, BM_DUAL, 630, ["DT"]);
    }
    await insertMark(BM_DUAL, "dt", "too_hard");

    const gain = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const dualRecs = gain.recs.filter((rec) => rec.beatmapId === BM_DUAL);
    // The hidden DT lane counts as hidden (it would have shown) but the NM
    // lane survives the collapse: hide first, then collapse.
    expect(gain.feedbackHiddenCount).toBe(1);
    expect(dualRecs.length).toBe(1);
    expect(dualRecs[0]?.speedBucket).toBe("normal");
    expect(dualRecs[0]?.feedback).toBeUndefined();
  });
});
