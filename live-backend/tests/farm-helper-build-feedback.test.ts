import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { buildFarmHelperSnapshotForBacktest, getFarmHelperSnapshot, invalidateFarmHelperCacheForUser } from "../src/features/farm-helper.js";
import { PLAYER_SKILLS_VERSION } from "../src/features/player-skills.js";
import { getScoreSpeedBucket, nowIso } from "../src/shared/score.js";
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

async function insertFarmed(country: string, userId: number, beatmapId: number, pp: number, mods: string[] = []): Promise<void> {
  const now = nowIso();
  // Mirrors the real writers: lane columns stored at write time.
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, speed_bucket, mods_key)
     values (?, ?, ?, ?, ?, '{}', ?, null, ?, ?, ?, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, JSON.stringify(mods), now, now, now, getScoreSpeedBucket(mods), mods.join(",")],
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

// Feasibility fixtures (mirroring tests/farm-helper.test.ts): a map_search_index
// row with an MSD vector for the gate, and a ready player_skill_ratings row for
// the subject. Pattern-mix order: jack, stream, jumpstream, handstream,
// stamina, chordjack, tech, ln.
const TECH_PAT = [0, 0, 0, 0, 0, 0, 1, 0];

async function insertSearchIndex(beatmapId: number, pat: number[], keyCount: number, msdValues?: Record<string, number>): Promise<void> {
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
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [beatmapId, beatmapId + 100, `Map ${beatmapId}`, keyCount, ...pat, msdJson, msdOverall, nowIso()],
  );
}

async function seedSubjectSkillRatings(keyCount: number, ratings: Record<string, number>, analyzedPlays: number): Promise<void> {
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
    [SUBJECT_ID, PLAYER_SKILLS_VERSION, modesJson, now, now],
  );
}

const stubQueue = { enqueue: async () => {} } as unknown as Parameters<typeof getFarmHelperSnapshot>[4];

const techMsd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });

// The generalization scenario: a 4K subject rated Technical 15 with 50 analyzed
// plays (not sparse), so the base ceiling for tech charts is 15 + 3.0 = 18.
// One "boundary" candidate chart (peers farm it) whose dominant Technical sits
// near that ceiling, plus 8 support charts the subject owns competitively (so
// only the boundary chart can surface). Marked charts are seeded separately
// (insertMarkableChart) and are NOT candidates: their influence on the
// snapshot can only flow through the margin adjustment.
const BM_BOUNDARY = 47_901;
const BM_CLAIM = 47_902;
const FEAS_SUPPORT = Array.from({ length: 8 }, (_, i) => 47_910 + i);

async function seedFeasibilityScenario(boundaryTechnical: number): Promise<OscScore[]> {
  const recent = nowIso();
  const bestScores = [
    subjectScore(47_990, 500, recent),
    ...FEAS_SUPPORT.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent)),
  ];
  await insertBeatmapMeta(BM_BOUNDARY, 4, 5);
  await insertSearchIndex(BM_BOUNDARY, TECH_PAT, 4, techMsd(boundaryTechnical));
  for (const beatmapId of FEAS_SUPPORT) await insertBeatmapMeta(beatmapId, 4, 5);
  for (let i = 0; i < 12; i += 1) {
    const id = 47_800 + i;
    await insertUser(id, 10_000, "CR", `FeasPeer${i}`);
    await insertFarmed("CR", id, BM_BOUNDARY, 500);
    for (const beatmapId of FEAS_SUPPORT) await insertFarmed("CR", id, beatmapId, 400);
  }
  await seedSubjectSkillRatings(4, techMsd(15), 50);
  return bestScores;
}

// A chart that exists only to be marked: meta + MSD, no peer farm rows.
async function insertMarkableChart(beatmapId: number, technical: number, withMsd = true): Promise<void> {
  await insertBeatmapMeta(beatmapId, 4, 5);
  if (withMsd) await insertSearchIndex(beatmapId, TECH_PAT, 4, techMsd(technical));
}

async function getFeasSnapshot(bestScores: OscScore[], view?: "gain" | "popular") {
  const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });
  return getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k", ...(view ? { view } : {}) }, stubQueue);
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

// Feedback generalization: active marks vote on the per-keymode feasibility
// margins (net >= 2 moves them by 5% per net vote beyond the first, clamped to
// 15%), so marks auto-adjust recommendations beyond their own lanes. The
// subject is rated Technical 15 (base tech ceiling 15 + 3.0 = 18); a 5%
// tighten lands the ceiling at 17.85, a 5% loosen at 18.15.
describe("farm helper feedback margin generalization", () => {
  it("two too_hard marks on gate-passing charts tighten the ceiling and drop a boundary chart", async () => {
    const bestScores = await seedFeasibilityScenario(17.9); // passes the base ceiling of 18
    const before = await getFeasSnapshot(bestScores);
    expect(before.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);
    expect(before.feedbackMarginAdjust).toBeUndefined();

    // Both marked charts pass the gate (16.5 and 17 sit under the ceiling), so
    // each too_hard mark is a tighten vote: net 2 -> 5% tighter margins.
    await insertMarkableChart(48_001, 16.5);
    await insertMarkableChart(48_002, 17);
    await insertMark(48_001, "normal", "too_hard");
    await insertMark(48_002, "normal", "too_hard");
    invalidateFarmHelperCacheForUser(db, SUBJECT_ID);

    const after = await getFeasSnapshot(bestScores);
    expect(after.feedbackMarginAdjust).toEqual({ "4k": -0.05 });
    // 17.9 > 15 + 3.0 * 0.95 = 17.85: the boundary chart now drops.
    expect(after.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(false);
  });

  it("a single mark moves nothing (below the net-vote floor)", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    await insertMarkableChart(48_001, 16.5);
    await insertMark(48_001, "normal", "too_hard");

    const snapshot = await getFeasSnapshot(bestScores);
    expect(snapshot.feedbackMarginAdjust).toBeUndefined();
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);
  });

  it("two too_easy marks on gate-dropped charts loosen the ceiling and admit a dropped boundary chart", async () => {
    const bestScores = await seedFeasibilityScenario(18.1); // drops at the base ceiling of 18
    const before = await getFeasSnapshot(bestScores);
    expect(before.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(false);

    // Both marked charts would DROP (25 and 26 far above the ceiling), so each
    // too_easy mark is a loosen vote: net -2 -> 5% wider margins.
    await insertMarkableChart(48_003, 25);
    await insertMarkableChart(48_004, 26);
    await insertMark(48_003, "normal", "too_easy");
    await insertMark(48_004, "normal", "too_easy");
    invalidateFarmHelperCacheForUser(db, SUBJECT_ID);

    const after = await getFeasSnapshot(bestScores);
    expect(after.feedbackMarginAdjust).toEqual({ "4k": 0.05 });
    // 18.1 <= 15 + 3.0 * 1.05 = 18.15: the boundary chart now passes.
    expect(after.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);
  });

  it("opposing votes cancel", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    await insertMarkableChart(48_001, 16.5); // passes -> too_hard = tighten vote
    await insertMarkableChart(48_003, 25); // drops -> too_easy = loosen vote
    await insertMark(48_001, "normal", "too_hard");
    await insertMark(48_003, "normal", "too_easy");

    const snapshot = await getFeasSnapshot(bestScores);
    expect(snapshot.feedbackMarginAdjust).toBeUndefined();
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);
  });

  it("the clamp holds at many votes: exactly 15%", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    // Five tighten votes would be (5 - 1) * 5% = 20%; the clamp caps at 15%.
    for (let i = 0; i < 5; i += 1) {
      const beatmapId = 48_010 + i;
      await insertMarkableChart(beatmapId, 16 + i * 0.2);
      await insertMark(beatmapId, "normal", "too_hard");
    }

    const snapshot = await getFeasSnapshot(bestScores);
    expect(snapshot.feedbackMarginAdjust).toEqual({ "4k": -0.15 });
    // 17.9 > 15 + 3.0 * 0.85 = 17.55: the boundary chart drops.
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(false);
  });

  it("marks with no resolvable MSD are ignored", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    // Meta exists but no MSD vector on either chart: never guess, no votes.
    await insertMarkableChart(48_020, 0, false);
    await insertMarkableChart(48_021, 0, false);
    await insertMark(48_020, "normal", "too_hard");
    await insertMark(48_021, "normal", "too_hard");

    const snapshot = await getFeasSnapshot(bestScores);
    expect(snapshot.feedbackMarginAdjust).toBeUndefined();
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);
  });

  it("a too_easy-marked lane still bypasses a tightened ceiling (per-lane effects take precedence)", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    // A second candidate chart identical to the boundary one, farmed by the
    // same peers, but claimed too_easy by the subject.
    await insertBeatmapMeta(BM_CLAIM, 4, 5);
    await insertSearchIndex(BM_CLAIM, TECH_PAT, 4, techMsd(17.9));
    for (let i = 0; i < 12; i += 1) await insertFarmed("CR", 47_800 + i, BM_CLAIM, 500);
    // Three tighten votes; the claim itself is a loosen vote (17.9 passes only
    // inside the margin band, above the subject's rating of 15): net 2 -> -5%.
    for (let i = 0; i < 3; i += 1) {
      const beatmapId = 48_030 + i;
      await insertMarkableChart(beatmapId, 16 + i * 0.4);
      await insertMark(beatmapId, "normal", "too_hard");
    }
    await insertMark(BM_CLAIM, "normal", "too_easy");

    const snapshot = await getFeasSnapshot(bestScores);
    expect(snapshot.feedbackMarginAdjust).toEqual({ "4k": -0.05 });
    // The unmarked boundary chart drops under the tightened ceiling, while the
    // identically-hard claimed lane bypasses the gate outright.
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(false);
    const claimed = snapshot.recs.find((rec) => rec.beatmapId === BM_CLAIM);
    expect(claimed).toBeDefined();
    expect(claimed?.feedback).toBe("too_easy");
  });

  it("DT marks without a stored 1.5x sweep only vote conservatively (loosen via the 1.0x lower bound, never tighten)", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    // No beatmap_chart_analysis rows: every DT mark falls back to the 1.0x
    // vector, a lower bound on the DT difficulty. Two too_easy marks on charts
    // already over the ceiling at 1.0x are certain loosen votes; the too_hard
    // mark on a chart passing at 1.0x proves nothing about 1.5x and is
    // skipped. Net -2 -> +5%. (Had the too_hard mark counted, net would be -1
    // and no adjustment would surface.)
    await insertMarkableChart(48_040, 25);
    await insertMarkableChart(48_041, 26);
    await insertMarkableChart(48_042, 10);
    await insertMark(48_040, "dt", "too_easy");
    await insertMark(48_041, "dt", "too_easy");
    await insertMark(48_042, "dt", "too_hard");

    const snapshot = await getFeasSnapshot(bestScores);
    expect(snapshot.feedbackMarginAdjust).toEqual({ "4k": 0.05 });
  });

  it("leaves the popular view unaffected", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    await insertMarkableChart(48_001, 16.5);
    await insertMarkableChart(48_002, 17);
    await insertMark(48_001, "normal", "too_hard");
    await insertMark(48_002, "normal", "too_hard");

    // The tighten applies on gain...
    const gain = await getFeasSnapshot(bestScores);
    expect(gain.feedbackMarginAdjust).toEqual({ "4k": -0.05 });
    expect(gain.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(false);
    // ...while popular still browses the chart and carries no adjustment.
    const popular = await getFeasSnapshot(bestScores, "popular");
    expect(popular.feedbackMarginAdjust).toBeUndefined();
    expect(popular.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);
  });

  it("leaves the backtest path unchanged (no marks load, no adjustment)", async () => {
    const bestScores = await seedFeasibilityScenario(17.9);
    const user = {
      id: SUBJECT_ID,
      username: "Subject",
      statistics: {
        pp: 10_000,
        variants: [{ mode: "mania", variant: "4k", pp: 3000, global_rank: null, country_rank: null }],
      },
    };
    const asOf = Date.now();
    const before = await buildFarmHelperSnapshotForBacktest(db, user, bestScores, { asOf, keyMode: "4k" });
    expect(before.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);

    await insertMarkableChart(48_001, 16.5);
    await insertMarkableChart(48_002, 17);
    await insertMark(48_001, "normal", "too_hard");
    await insertMark(48_002, "normal", "too_hard");

    const after = await buildFarmHelperSnapshotForBacktest(db, user, bestScores, { asOf, keyMode: "4k" });
    expect(after.feedbackMarginAdjust).toBeUndefined();
    // Bite-for-bite: the marks changed nothing about the reconstruction.
    expect(after.recs).toEqual(before.recs);
    expect(after.recs.some((rec) => rec.beatmapId === BM_BOUNDARY)).toBe(true);
    // And the backtest never touched (reconciled) the marks.
    const rows = (await exec(db, "select resolved_at from farm_helper_feedback where user_id = ?", [SUBJECT_ID])).rows;
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.resolved_at).toBeNull();
  });
});
