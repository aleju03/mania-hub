import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { computeAccBenchmarkScale, getFarmHelperSnapshot, invalidateFarmHelperCacheForUser } from "../src/features/farm-helper.js";
import {
  clearFarmHelperFeedback,
  countActiveFarmHelperFeedback,
  FARM_HELPER_FEEDBACK_ACTIVE_MARK_CAP,
  listFarmHelperFeedback,
  refreshFarmHelperFeedbackUserIndex,
  resolveFarmHelperFeedbackForScore,
  setFarmHelperFeedback,
  type FarmHelperFeedbackInput,
} from "../src/features/farm-helper-feedback.js";
import { runRetention } from "../src/retention.js";
import { ScoreIngestor } from "../src/ingest/score-ingestor.js";
import { ACC_MODEL_PRIOR_TYPICAL_ACC, ACC_MODEL_VERSION, predictPlayerAccuracy, type AccModelMode, type PlayerAccModel } from "../src/features/player-acc-model.js";
import { PLAYER_SKILLS_VERSION } from "../src/features/player-skills.js";
import { getScoreSpeedBucket, nowIso } from "../src/shared/score.js";
import type { OsuApiClient } from "../src/osu/client.js";
import type { OscScore, OsuMod } from "../src/shared/types.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const SUBJECT_ID = 1;
const SUBJECT_PP = 5000;
const BM_IMPROVE = 10;
const BM_STALE = 11;
const BM_MISSING = 12;

const ADMIN = { authorization: "Bearer secret" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-farm-feedback-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
  // Rebind the module-level "who has active marks" negative cache to this
  // fresh (empty) db so state never leaks between cases (goals-index pattern).
  await refreshFarmHelperFeedbackUserIndex(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Snapshot fixtures (trimmed copies of the farm-helper test helpers).

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

// The success arm of setFarmHelperFeedback, or a hard failure: most cases
// here write marks that must land, and the narrowing keeps mark-field access
// compiling against the discriminated result.
async function setMarkOrThrow(input: FarmHelperFeedbackInput) {
  const result = await setFarmHelperFeedback(db, input);
  if (!result.ok) throw new Error(`unexpected feedback refusal: ${result.reason}`);
  return result;
}

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
  // Mirrors the real writers: lane columns stored at write time.
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, speed_bucket, mods_key)
     values (?, ?, ?, ?, ?, '{}', ?, null, ?, ?, ?, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, JSON.stringify(mods), playedAt, updatedAt, updatedAt, getScoreSpeedBucket(mods), mods.join(",")],
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
     values (?, ?, 'ready', '[]', ?, ?, ?)`,
    [userId, PLAYER_SKILLS_VERSION, modesJson, now, now],
  );
}

const stubQueue = { enqueue: async () => {} } as unknown as Parameters<typeof getFarmHelperSnapshot>[4];

// Filler 4K maps the subject owns competitively, so peers qualify for the
// concrete 4K pool without those maps surfacing as recommendations.
const FILLER_4K = [900, 901, 902, 903, 904, 905, 906];

async function seedPeers(): Promise<void> {
  const recent = nowIso();
  for (const beatmapId of FILLER_4K) await insertBeatmapMeta(beatmapId, 4, 5);
  for (let i = 0; i < 15; i += 1) {
    const id = 100 + i;
    const country = i < 8 ? "CR" : "US";
    await insertUser(id, SUBJECT_PP, country);
    await insertFarmed(country, id, BM_IMPROVE, 600, recent); // median 600 (subject only 400)
    await insertFarmed(country, id, BM_MISSING, 620, recent); // median 620 (subject missing)
    await insertFarmed(country, id, BM_STALE, i < 10 ? 600 : 660, recent); // median 600, p75 660
    for (const beatmapId of FILLER_4K) await insertFarmed(country, id, beatmapId, 300, recent);
  }
  await insertBeatmapMeta(BM_IMPROVE);
  await insertBeatmapMeta(BM_STALE);
  await insertBeatmapMeta(BM_MISSING);
}

// A ready 4K acc model row for the subject (the acc-scaling fixture shape).
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

async function setPassStats(beatmapId: number, playCount: number, passCount: number): Promise<void> {
  await exec(db, "update map_search_index set play_count = ?, pass_count = ? where beatmap_id = ?", [
    playCount,
    passCount,
    beatmapId,
  ]);
}

// ---------------------------------------------------------------------------
// HTTP harness (the skins-http shape).

function httpCtx() {
  return {
    db,
    queue,
    events,
    abuse: new AbuseGuard(),
    config: {
      nodeEnv: "production",
      liveAdminToken: "secret",
      allowedOrigins: ["http://localhost:3000"],
      trackedCountries: ["CR"],
      trustProxyHeaders: true,
      publicApiRatePerMinute: 240,
      publicCostlyRatePerMinute: 60,
    },
    osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
    oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
  } as never;
}

function mockReq(method: string, url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
}

function bodyReq(method: string, url: string, body: unknown, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
}

function mockRes() {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (key: string, value: number | string | readonly string[]) => {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    writeHead: (status: number) => {
      res.statusCode = status;
      return res;
    },
    write: (chunk: string | Buffer) => {
      writes.push(String(chunk));
      return true;
    },
    destroy: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk != null) writes.push(String(chunk));
    },
  }) as unknown as ServerResponse & { statusCode: number };
  return { res, writes };
}

async function call(req: IncomingMessage) {
  const response = mockRes();
  await routeHttp(req, response.res, httpCtx());
  const raw = response.writes.join("");
  let body: ReturnType<typeof JSON.parse> = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.res.statusCode, body };
}

const SET_BODY = { userId: SUBJECT_ID, beatmapId: 555, speedBucket: "normal", verdict: "too_hard" };

describe("farm helper feedback endpoints", () => {
  it("401s all three endpoints without the admin token", async () => {
    expect((await call(mockReq("GET", `/api/farm-helper/feedback?userId=${SUBJECT_ID}`))).status).toBe(401);
    expect((await call(bodyReq("POST", "/api/farm-helper/feedback/set", SET_BODY))).status).toBe(401);
    expect((await call(bodyReq("POST", "/api/farm-helper/feedback/clear", SET_BODY))).status).toBe(401);
  });

  it("round trips set, get and clear", async () => {
    const set = await call(bodyReq("POST", "/api/farm-helper/feedback/set", SET_BODY, ADMIN));
    expect(set.status).toBe(200);
    expect(set.body.ok).toBe(true);
    expect(set.body.mark).toMatchObject({ beatmapId: 555, speedBucket: "normal", verdict: "too_hard", resolvedAt: null, resolvedPp: null });
    expect(set.body.mark.createdAt).toBeGreaterThan(0);

    const listed = await call(mockReq("GET", `/api/farm-helper/feedback?userId=${SUBJECT_ID}`, ADMIN));
    expect(listed.status).toBe(200);
    expect(listed.body.marks).toHaveLength(1);
    expect(listed.body.marks[0]).toMatchObject({ beatmapId: 555, speedBucket: "normal", verdict: "too_hard", resolvedAt: null });

    const cleared = await call(bodyReq("POST", "/api/farm-helper/feedback/clear", SET_BODY, ADMIN));
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ ok: true });

    const empty = await call(mockReq("GET", `/api/farm-helper/feedback?userId=${SUBJECT_ID}`, ADMIN));
    expect(empty.body.marks).toEqual([]);
  });

  it("lists active marks before resolved ones, newest first", async () => {
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 1, speedBucket: "normal", verdict: "too_hard" });
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 2, speedBucket: "dt", verdict: "too_easy" });
    // Resolve the first mark manually; it must sort after the active one.
    await exec(db, "update farm_helper_feedback set resolved_at = ?, resolved_pp = ? where user_id = ? and beatmap_id = 1", [Date.now(), 412.5, SUBJECT_ID]);

    const marks = await listFarmHelperFeedback(db, SUBJECT_ID);
    expect(marks.map((mark) => mark.beatmapId)).toEqual([2, 1]);
    expect(marks[0].resolvedAt).toBeNull();
    expect(marks[1].resolvedAt).toBeGreaterThan(0);
    expect(marks[1].resolvedPp).toBeCloseTo(412.5, 3);
  });

  it("reactivates a resolved mark on re-set, refreshing createdAt", async () => {
    const first = await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: 7, speedBucket: "normal", verdict: "too_easy" });
    // Backdate creation, then resolve the mark (the score-landed state).
    const oldCreatedAt = first.createdAt - 60_000;
    await exec(db, "update farm_helper_feedback set created_at = ?, resolved_at = ?, resolved_pp = 300 where user_id = ? and beatmap_id = 7", [oldCreatedAt, Date.now(), SUBJECT_ID]);

    const reactivated = await call(bodyReq("POST", "/api/farm-helper/feedback/set", { userId: SUBJECT_ID, beatmapId: 7, speedBucket: "normal", verdict: "too_easy" }, ADMIN));
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.mark.resolvedAt).toBeNull();
    expect(reactivated.body.mark.resolvedPp).toBeNull();
    // createdAt refreshes so the score that resolved the mark cannot instantly
    // re-resolve the reactivated one.
    expect(reactivated.body.mark.createdAt).toBeGreaterThan(oldCreatedAt);

    // A verdict change on an active mark refreshes createdAt too.
    await exec(db, "update farm_helper_feedback set created_at = ? where user_id = ? and beatmap_id = 7", [oldCreatedAt, SUBJECT_ID]);
    const flipped = await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: 7, speedBucket: "normal", verdict: "too_hard" });
    expect(flipped.verdict).toBe("too_hard");
    expect(flipped.createdAt).toBeGreaterThan(oldCreatedAt);

    // Re-posting the unchanged active mark is idempotent (createdAt kept).
    const repeated = await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: 7, speedBucket: "normal", verdict: "too_hard" });
    expect(repeated.createdAt).toBe(flipped.createdAt);
  });

  it("400s bad input", async () => {
    expect((await call(mockReq("GET", "/api/farm-helper/feedback?userId=nope", ADMIN))).body).toEqual({ error: "invalid_user_id" });
    expect((await call(bodyReq("POST", "/api/farm-helper/feedback/set", { ...SET_BODY, userId: 0 }, ADMIN))).body).toEqual({ error: "invalid_user_id" });
    expect((await call(bodyReq("POST", "/api/farm-helper/feedback/set", { ...SET_BODY, beatmapId: "x" }, ADMIN))).body).toEqual({ error: "invalid_beatmap" });
    expect((await call(bodyReq("POST", "/api/farm-helper/feedback/set", { ...SET_BODY, speedBucket: "2x" }, ADMIN))).body).toEqual({ error: "invalid_speed_bucket" });
    expect((await call(bodyReq("POST", "/api/farm-helper/feedback/set", { ...SET_BODY, verdict: "way_too_hard" }, ADMIN))).body).toEqual({ error: "invalid_verdict" });
    expect((await call(bodyReq("POST", "/api/farm-helper/feedback/clear", { ...SET_BODY, speedBucket: "nope" }, ADMIN))).body).toEqual({ error: "invalid_speed_bucket" });
    for (const result of [
      await call(bodyReq("POST", "/api/farm-helper/feedback/set", { ...SET_BODY, userId: 0 }, ADMIN)),
      await call(bodyReq("POST", "/api/farm-helper/feedback/set", { ...SET_BODY, verdict: "way_too_hard" }, ADMIN)),
    ]) {
      expect(result.status).toBe(400);
    }
  });
});

describe("farm helper feedback in recommendations", () => {
  it("hides a too_hard lane from the gain view and reports it; popular keeps it labelled", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: BM_MISSING, speedBucket: "normal", verdict: "too_hard" });

    const gain = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(gain.recs.some((rec) => rec.beatmapId === BM_MISSING)).toBe(false);
    expect(gain.feedbackHiddenCount).toBe(1);
    // The other lanes are untouched.
    expect(gain.recs.some((rec) => rec.beatmapId === BM_IMPROVE)).toBe(true);
    expect(gain.recs.some((rec) => rec.beatmapId === BM_STALE)).toBe(true);
    expect(gain.recs.every((rec) => rec.feedback === undefined)).toBe(true);

    const popular = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject", { view: "popular" });
    const popularRec = popular.recs.find((rec) => rec.beatmapId === BM_MISSING);
    expect(popularRec).toBeDefined();
    expect(popularRec?.feedback).toBe("too_hard");
    expect(popular.feedbackHiddenCount).toBeUndefined();
  });

  it("keeps a too_easy lane recommended and tags it", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: BM_MISSING, speedBucket: "normal", verdict: "too_easy" });

    const gain = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = gain.recs.find((candidate) => candidate.beatmapId === BM_MISSING);
    expect(rec?.feedback).toBe("too_easy");
    expect(gain.feedbackHiddenCount).toBe(0);
  });

  it("too_easy bypasses the feasibility gate for that lane only", async () => {
    // The feasibility fixture: two identical over-MSD charts (dominant
    // Technical 30 vs the subject's rating 15 + margin 3); only the marked one
    // may come back.
    const recent = nowIso();
    const hardMarked = 9900;
    const hardUnmarked = 9902;
    const support = Array.from({ length: 8 }, (_, i) => 9910 + i);
    const bestScores = [
      subjectScore(9990, 500, recent, 4, 5),
      ...support.map((beatmapId, i) => subjectScore(beatmapId, 450 - i * 5, recent, 4, 5)),
    ];
    const msd = (technical: number) => ({ Stream: 10, Jumpstream: 10, Handstream: 10, Stamina: 10, JackSpeed: 10, Chordjack: 10, Technical: technical });

    await insertBeatmapMeta(hardMarked, 4, 5);
    await insertBeatmapMeta(hardUnmarked, 4, 5);
    await insertSearchIndex(hardMarked, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(30));
    await insertSearchIndex(hardUnmarked, [0, 0, 0, 0, 0, 0, 1, 0], 4, msd(30));
    for (const beatmapId of support) await insertBeatmapMeta(beatmapId, 4, 5);

    for (let i = 0; i < 12; i += 1) {
      const id = 9920 + i;
      await insertUser(id, 10_000, "CR", `MsdPeer${i}`);
      await insertFarmed("CR", id, hardMarked, 500, recent);
      await insertFarmed("CR", id, hardUnmarked, 500, recent);
      for (const beatmapId of support) await insertFarmed("CR", id, beatmapId, 400, recent);
    }
    await seedSubjectSkillRatings(SUBJECT_ID, 4, msd(15), 50);
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: hardMarked, speedBucket: "normal", verdict: "too_easy" });
    const osu = makeOsuStub(bestScores, 10_000, { "4k": 3000 });

    const gain = await getFarmHelperSnapshot(db, osu, "Subject", { keyMode: "4k" }, stubQueue);
    const marked = gain.recs.find((rec) => rec.beatmapId === hardMarked);
    expect(marked).toBeDefined();
    expect(marked?.feedback).toBe("too_easy");
    // The identical unmarked chart still drops on the gate.
    expect(gain.recs.some((rec) => rec.beatmapId === hardUnmarked)).toBe(false);
  });

  it("too_easy scales the benchmark on the optimistic accP85 instead of the conservative estimate", async () => {
    const BM_ACC = 14;
    const STREAM_PAT = [0, 1, 0, 0, 0, 0, 0, 0];
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_ACC, 4, 5);
    // msd_overall 24 (gap -1 against the model's rating 25).
    await insertSearchIndex(BM_ACC, STREAM_PAT, 4, { Stream: 24 });
    for (let i = 0; i < 15; i += 1) {
      await insertFarmed(i < 8 ? "CR" : "US", 100 + i, BM_ACC, 620, nowIso());
    }
    // A weak curve, so the conservative multiplier discounts visibly.
    const model = accModelForTest({ a: Math.log(0.10) });
    await seedSubjectAccModel(model);
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: BM_ACC, speedBucket: "normal", verdict: "too_easy" });

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const rec = snapshot.recs.find((candidate) => candidate.beatmapId === BM_ACC);

    const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 24, family: "stream" })!;
    const optimisticScale = computeAccBenchmarkScale({ accConservative: prediction.accP85 }, ACC_MODEL_PRIOR_TYPICAL_ACC);
    const conservativeScale = computeAccBenchmarkScale(prediction, ACC_MODEL_PRIOR_TYPICAL_ACC);
    expect(optimisticScale).toBeGreaterThan(conservativeScale);

    expect(rec?.reason).toBe("missing");
    expect(rec?.feedback).toBe("too_easy");
    expect(rec?.benchmarkPp).toBeCloseTo(620 * optimisticScale, 1);
    expect(rec?.benchmarkPp ?? 0).toBeGreaterThan(620 * conservativeScale);
  });

  it("too_easy suppresses the survival discount and clear-risk label for that lane only", async () => {
    const BM_RISKY_MARKED = 15;
    const BM_RISKY_UNMARKED = 17;
    const STREAM_PAT = [0, 1, 0, 0, 0, 0, 0, 0];
    // Heavy choke bins at every gap: the subject drops combo everywhere.
    const HEAVY_CHOKE = Array.from({ length: 6 }, () => ({ n: 10, c: 0.9, m: 0.05 }));
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    await insertBeatmapMeta(BM_RISKY_MARKED, 4, 5);
    await insertBeatmapMeta(BM_RISKY_UNMARKED, 4, 5);
    await insertSearchIndex(BM_RISKY_MARKED, STREAM_PAT, 4, { Stream: 24 });
    await insertSearchIndex(BM_RISKY_UNMARKED, STREAM_PAT, 4, { Stream: 24 });
    await setPassStats(BM_RISKY_MARKED, 20_000, 500);
    await setPassStats(BM_RISKY_UNMARKED, 20_000, 500);
    for (let i = 0; i < 15; i += 1) {
      const country = i < 8 ? "CR" : "US";
      await insertFarmed(country, 100 + i, BM_RISKY_MARKED, 620, nowIso());
      await insertFarmed(country, 100 + i, BM_RISKY_UNMARKED, 620, nowIso());
    }
    // A strong accuracy curve (multiplier clamps at 1) with heavy choke bins.
    await seedSubjectAccModel(accModelForTest({ a: Math.log(0.04), choke: HEAVY_CHOKE }));
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: BM_RISKY_MARKED, speedBucket: "normal", verdict: "too_easy" });

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    const marked = snapshot.recs.find((rec) => rec.beatmapId === BM_RISKY_MARKED);
    const unmarked = snapshot.recs.find((rec) => rec.beatmapId === BM_RISKY_UNMARKED);

    expect(marked?.feedback).toBe("too_easy");
    expect(marked?.survival).toBe(1);
    expect(marked?.clearRisk).toBe(false);

    // The identical unmarked lane keeps its discount and label.
    expect(unmarked?.survival ?? 1).toBeLessThan(1);
    expect(unmarked?.clearRisk).toBe(true);
  });

  it("read-time reconcile: a later subject score resolves the mark, an earlier one does not", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();
    // Mark A predates the subject's 400pp score on BM_IMPROVE (2024-06-01):
    // it must resolve and the lane behaves unmarked. Mark B postdates the
    // subject's old BM_STALE score (2022-01-01): it stays active and hides.
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: BM_IMPROVE, speedBucket: "normal", verdict: "too_hard" });
    await exec(db, "update farm_helper_feedback set created_at = ? where user_id = ? and beatmap_id = ?", [
      Date.parse("2023-01-01T00:00:00Z"),
      SUBJECT_ID,
      BM_IMPROVE,
    ]);
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: BM_STALE, speedBucket: "normal", verdict: "too_hard" });

    const snapshot = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_IMPROVE)).toBe(true);
    expect(snapshot.recs.find((rec) => rec.beatmapId === BM_IMPROVE)?.feedback).toBeUndefined();
    expect(snapshot.recs.some((rec) => rec.beatmapId === BM_STALE)).toBe(false);
    expect(snapshot.feedbackHiddenCount).toBe(1);

    const marks = await listFarmHelperFeedback(db, SUBJECT_ID);
    const resolved = marks.find((mark) => mark.beatmapId === BM_IMPROVE);
    const active = marks.find((mark) => mark.beatmapId === BM_STALE);
    expect(resolved?.resolvedAt).toBeGreaterThan(0);
    expect(resolved?.resolvedPp).toBeCloseTo(400, 1);
    expect(active?.resolvedAt).toBeNull();
  });

  it("a feedback write through the endpoint evicts the cached snapshot", async () => {
    const bestScores = buildSubjectBestScores();
    await seedPeers();

    const first = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(first.recs.some((rec) => rec.beatmapId === BM_MISSING)).toBe(true);

    // A direct table write alone leaves the 5-minute cache serving stale recs.
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: BM_MISSING, speedBucket: "normal", verdict: "too_hard" });
    const stale = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(stale.recs.some((rec) => rec.beatmapId === BM_MISSING)).toBe(true);

    // The eviction (as the set/clear handlers call it) makes the next build fresh.
    invalidateFarmHelperCacheForUser(db, SUBJECT_ID);
    const fresh = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(fresh.recs.some((rec) => rec.beatmapId === BM_MISSING)).toBe(false);
    expect(fresh.feedbackHiddenCount).toBe(1);

    // End to end through the HTTP handler: clearing the mark brings it back.
    const cleared = await call(bodyReq("POST", "/api/farm-helper/feedback/clear", { userId: SUBJECT_ID, beatmapId: BM_MISSING, speedBucket: "normal" }, ADMIN));
    expect(cleared.status).toBe(200);
    const restored = await getFarmHelperSnapshot(db, makeOsuStub(bestScores), "Subject");
    expect(restored.recs.some((rec) => rec.beatmapId === BM_MISSING)).toBe(true);
    expect(restored.feedbackHiddenCount).toBe(0);
  });
});

describe("farm helper feedback ingest auto-resolution", () => {
  function ingestScore(beatmapId: number, endedAt: string, pp: number, mods: string[] = [], passed = true): OscScore {
    return {
      id: 5_000_000 + nextScoreId++,
      user_id: SUBJECT_ID,
      accuracy: 0.98,
      mods: mods.map((acronym): OsuMod => ({ acronym })),
      score: 900_000,
      max_combo: 800,
      passed,
      rank: passed ? "S" : "F",
      statistics: {},
      pp,
      beatmap_id: beatmapId,
      ended_at: endedAt,
    };
  }

  it("resolves active marks on a matching-lane score after the mark, stamping the score's pp", async () => {
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 777, speedBucket: "normal", verdict: "too_easy" });
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    await exec(db, "update farm_helper_feedback set created_at = ? where user_id = ? and beatmap_id = 777", [t0, SUBJECT_ID]);

    // A score before the mark never resolves it.
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(777, "2025-12-01T00:00:00Z", 300))).toBe(0);
    // A DT score is a different lane.
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(777, "2026-02-01T00:00:00Z", 300, ["DT"]))).toBe(0);
    // The matching-lane score after the mark retires it.
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(777, "2026-02-01T00:00:00Z", 512))).toBe(1);
    // Idempotent: nothing left to resolve.
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(777, "2026-03-01T00:00:00Z", 520))).toBe(0);

    const marks = await listFarmHelperFeedback(db, SUBJECT_ID);
    expect(marks[0].resolvedAt).toBeGreaterThan(0);
    expect(marks[0].resolvedPp).toBeCloseTo(512, 3);
  });

  it("skips users absent from the loaded index until the version bump refreshes it", async () => {
    // Insert a mark directly, bypassing noteFarmHelperFeedbackUserActive,
    // while the index is loaded-and-empty: the fast path gates the user out.
    const now = Date.now();
    await exec(
      db,
      "insert into farm_helper_feedback (user_id, beatmap_id, speed_bucket, verdict, created_at, updated_at) values (?, 888, 'normal', 'too_easy', ?, ?)",
      [SUBJECT_ID, now - 60_000, now - 60_000],
    );
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(888, new Date(now).toISOString(), 400))).toBe(0);

    // A cross-process version bump (what the set endpoint writes) triggers the
    // in-memory refresh on the next check.
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      ["farm_helper_feedback_changed_at", JSON.stringify(now), nowIso()],
    );
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(888, new Date(now).toISOString(), 400))).toBe(1);
  });

  it("a failed score never resolves a mark, for either verdict; the later pass does", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    // One lane per verdict: dying mid-map contradicts neither "too hard"
    // (obviously) nor "too easy" (the mark is only retired by real evidence).
    await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: 801, speedBucket: "normal", verdict: "too_hard" });
    await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: 802, speedBucket: "normal", verdict: "too_easy" });
    await exec(db, "update farm_helper_feedback set created_at = ? where user_id = ?", [t0, SUBJECT_ID]);

    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(801, "2026-02-01T00:00:00Z", 450, [], false))).toBe(0);
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(802, "2026-02-01T00:00:00Z", 450, [], false))).toBe(0);
    const afterFails = await listFarmHelperFeedback(db, SUBJECT_ID);
    expect(afterFails.every((mark) => mark.resolvedAt === null)).toBe(true);

    // The same lanes resolve the moment the player actually passes.
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(801, "2026-02-02T00:00:00Z", 460))).toBe(1);
    expect(await resolveFarmHelperFeedbackForScore(db, ingestScore(802, "2026-02-02T00:00:00Z", 470))).toBe(1);
    const afterPasses = await listFarmHelperFeedback(db, SUBJECT_ID);
    expect(afterPasses.every((mark) => mark.resolvedAt !== null)).toBe(true);
  });

  it("resolves marks through ingestScore for a player on no tracked roster", async () => {
    const ingestor = new ScoreIngestor(db, queue, events, {
      topPlayMarginPp: 5,
      trackedCountries: ["CR"],
      countryWarmTtlMs: 24 * 60 * 60 * 1000,
      osuClientId: "test-client",
      osuClientSecret: "test-secret",
    });
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: 803, speedBucket: "normal", verdict: "too_hard" });
    await exec(db, "update farm_helper_feedback set created_at = ? where user_id = ?", [t0, SUBJECT_ID]);

    // No country_rosters row and no user payload: the roster gate rejects the
    // score (ingestScore returns false), but the feedback hook has already run.
    const failed = ingestScore(803, "2026-02-01T00:00:00Z", 480, [], false);
    expect(await ingestor.ingestScore(failed)).toBe(false);
    expect((await listFarmHelperFeedback(db, SUBJECT_ID))[0].resolvedAt).toBeNull();

    const passed = ingestScore(803, "2026-02-01T01:00:00Z", 480);
    expect(await ingestor.ingestScore(passed)).toBe(false);
    const marks = await listFarmHelperFeedback(db, SUBJECT_ID);
    expect(marks[0].resolvedAt).toBeGreaterThan(0);
    expect(marks[0].resolvedPp).toBeCloseTo(480, 3);
    const resolvedAt = marks[0].resolvedAt;

    // Idempotent under re-delivery: there is no score_events insert to dedupe
    // on for non-rostered players, so the resolver's own `resolved_at is null
    // and created_at < scoreTime` predicate has to make the second delivery of
    // the same score a no-op.
    expect(await ingestor.ingestScore({ ...passed })).toBe(false);
    const again = await listFarmHelperFeedback(db, SUBJECT_ID);
    expect(again[0].resolvedAt).toBe(resolvedAt);
  });

  it("double resolution is a no-op even when the resolver is called back to back", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: 804, speedBucket: "dt", verdict: "too_easy" });
    await exec(db, "update farm_helper_feedback set created_at = ? where user_id = ?", [t0, SUBJECT_ID]);

    const score = ingestScore(804, "2026-02-01T00:00:00Z", 333, ["DT"]);
    expect(await resolveFarmHelperFeedbackForScore(db, score)).toBe(1);
    const [mark] = await listFarmHelperFeedback(db, SUBJECT_ID);
    // The exact same score again resolves nothing and leaves the stamps alone.
    expect(await resolveFarmHelperFeedbackForScore(db, score)).toBe(0);
    const [markAgain] = await listFarmHelperFeedback(db, SUBJECT_ID);
    expect(markAgain.resolvedAt).toBe(mark.resolvedAt);
    expect(markAgain.resolvedPp).toBe(mark.resolvedPp);
  });

  it("clearFarmHelperFeedback removes the row", async () => {
    await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 9, speedBucket: "ht", verdict: "too_hard" });
    expect(await clearFarmHelperFeedback(db, SUBJECT_ID, 9, "ht")).toBe(true);
    expect(await clearFarmHelperFeedback(db, SUBJECT_ID, 9, "ht")).toBe(false);
    expect(await listFarmHelperFeedback(db, SUBJECT_ID)).toEqual([]);
  });
});

describe("farm helper feedback active-mark cap", () => {
  // Chunked below SQLite's 500-term compound VALUES limit.
  async function bulkInsertActiveMarks(userId: number, count: number, firstBeatmapId = 10_000): Promise<void> {
    const now = Date.now();
    for (let offset = 0; offset < count; offset += 250) {
      const values = Array.from(
        { length: Math.min(250, count - offset) },
        (_, index) => `(${userId}, ${firstBeatmapId + offset + index}, 'normal', 'too_hard', ${now}, ${now}, null, null)`,
      ).join(", ");
      await exec(
        db,
        `insert into farm_helper_feedback (user_id, beatmap_id, speed_bucket, verdict, created_at, updated_at, resolved_at, resolved_pp)
         values ${values}`,
      );
    }
  }

  it("refuses a new mark at the cap; updates and reactivations stay exempt", async () => {
    await bulkInsertActiveMarks(SUBJECT_ID, FARM_HELPER_FEEDBACK_ACTIVE_MARK_CAP);
    // Plus one already-resolved lane: total rows 501, active exactly at cap.
    const resolvedLane = 30_000;
    const now = Date.now();
    await exec(
      db,
      "insert into farm_helper_feedback (user_id, beatmap_id, speed_bucket, verdict, created_at, updated_at, resolved_at, resolved_pp) values (?, ?, 'normal', 'too_hard', ?, ?, ?, 250)",
      [SUBJECT_ID, resolvedLane, now - 60_000, now - 60_000, now - 30_000],
    );
    expect(await countActiveFarmHelperFeedback(db, SUBJECT_ID)).toBe(FARM_HELPER_FEEDBACK_ACTIVE_MARK_CAP);

    // A NEW lane is refused and writes nothing.
    const refused = await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 40_000, speedBucket: "normal", verdict: "too_hard" });
    expect(refused).toEqual({ ok: false, reason: "too_many_marks" });
    expect((await exec(db, "select 1 from farm_helper_feedback where user_id = ? and beatmap_id = 40000", [SUBJECT_ID])).rows).toHaveLength(0);

    // A verdict flip on an existing active mark is exempt.
    const flipped = await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 10_000, speedBucket: "normal", verdict: "too_easy" });
    expect(flipped.ok).toBe(true);

    // Reactivating the resolved lane is exempt too, even with the cap full.
    const reactivated = await setMarkOrThrow({ userId: SUBJECT_ID, beatmapId: resolvedLane, speedBucket: "normal", verdict: "too_hard" });
    expect(reactivated.resolvedAt).toBeNull();

    // The cap is per user: another player is untouched by the subject's marks.
    const other = await setFarmHelperFeedback(db, { userId: 2, beatmapId: 40_000, speedBucket: "normal", verdict: "too_hard" });
    expect(other.ok).toBe(true);
  });

  it("admits a new mark again once an active one clears", async () => {
    await bulkInsertActiveMarks(SUBJECT_ID, FARM_HELPER_FEEDBACK_ACTIVE_MARK_CAP);
    expect((await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 40_001, speedBucket: "normal", verdict: "too_hard" })).ok).toBe(false);
    expect(await clearFarmHelperFeedback(db, SUBJECT_ID, 10_000, "normal")).toBe(true);
    expect((await setFarmHelperFeedback(db, { userId: SUBJECT_ID, beatmapId: 40_001, speedBucket: "normal", verdict: "too_hard" })).ok).toBe(true);
  });
});

describe("farm helper feedback retention", () => {
  it("prunes resolved marks past 180 days and never touches active ones", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const rows: Array<[number, number | null]> = [
      [601, null], // active forever, never pruned (created long ago)
      [602, now - 200 * day], // resolved past the window: pruned
      [603, now - 10 * day], // resolved recently: kept
    ];
    for (const [beatmapId, resolvedAt] of rows) {
      await exec(
        db,
        "insert into farm_helper_feedback (user_id, beatmap_id, speed_bucket, verdict, created_at, updated_at, resolved_at, resolved_pp) values (?, ?, 'normal', 'too_hard', ?, ?, ?, ?)",
        [SUBJECT_ID, beatmapId, now - 400 * day, now - 400 * day, resolvedAt, resolvedAt == null ? null : 300],
      );
    }

    const deleted = await runRetention(db, {
      databaseUrl: `file:${join(dir, "test.db")}`,
      scoreEventRetentionDays: 14,
      liveEventRetentionDays: 7,
      doneJobRetentionDays: 2,
      apiCallLogRetentionDays: 7,
      replayVideoJobRetentionDays: 2,
      rankSnapshotRetentionDays: 14,
      activityRetentionYears: 2,
      replayVideoWorkDir: join(dir, "replay-video-jobs"),
      maxLocalDbBytes: Number.MAX_SAFE_INTEGER,
      targetLocalDbBytes: Number.MAX_SAFE_INTEGER,
      nodeEnv: "test",
      livePublicOrigin: "http://localhost:7227",
    });

    expect(deleted.farmHelperFeedbackResolved).toBe(1);
    const remaining = (await exec(db, "select beatmap_id from farm_helper_feedback where user_id = ? order by beatmap_id", [SUBJECT_ID])).rows.map((row) => Number(row.beatmap_id));
    expect(remaining).toEqual([601, 603]);
  });
});
