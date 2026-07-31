import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { SKILL_BASELINE_JOB } from "../src/features/skill-baseline.js";
import {
  ensureTopScoresBackfillSeeded,
  readTopScoresBackfillProgress,
  runTopScoresBackfillJob,
  selectBackfillUserIds,
  TOP_SCORES_BACKFILL_DONE_META_KEY,
  TOP_SCORES_BACKFILL_JOB,
  TOP_SCORES_BACKFILL_PROGRESS_META_KEY,
} from "../src/features/top-scores-backfill.js";
import { JobQueue } from "../src/jobs/queue.js";
import { OsuApiError } from "../src/osu/client.js";
import type { OscScore } from "../src/shared/types.js";

let dir = "";
let db: Db;
let queue: JobQueue;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-top-backfill-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedRosterUser(userId: number, options: { tracked?: boolean; active?: boolean; country?: string } = {}): Promise<void> {
  const now = new Date().toISOString();
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, is_active, pp, profile_json, updated_at)
     values (?, ?, '', ?, ?, 1000, '{}', ?)`,
    [userId, `player-${userId}`, options.country ?? "CR", options.active === false ? 0 : 1, now],
  );
  await exec(
    db,
    `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
     values (?, ?, ?, 'osu_rankings', ?, ?)`,
    [options.country ?? "CR", userId, userId, options.tracked === false ? 0 : 1, now],
  );
}

async function seedStoredTopScore(userId: number): Promise<void> {
  await exec(
    db,
    `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
     values (?, ?, 1, '{}', 100, 100, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    [userId, userId * 10],
  );
}

function bestScore(userId: number, id: number, pp = 100): OscScore {
  return {
    id,
    user_id: userId,
    pp,
    ended_at: "2026-06-01T00:00:00Z",
  } as OscScore;
}

function mockOsu(overrides: { failWith404?: Set<number>; failWithError?: Set<number>; emptyFor?: Set<number> } = {}) {
  const fetched: number[] = [];
  return {
    fetched,
    getUserBestScores: async () => {
      throw new Error("sweep should use the windowed fetch");
    },
    getUserBestScoresWindow: async (userId: number) => {
      if (overrides.failWith404?.has(userId)) throw new OsuApiError(404, `/users/${userId}/scores/best`);
      if (overrides.failWithError?.has(userId)) throw new OsuApiError(503, `/users/${userId}/scores/best`);
      fetched.push(userId);
      if (overrides.emptyFor?.has(userId)) return [];
      return [bestScore(userId, userId * 10)];
    },
  };
}

async function backfillJobRows() {
  return (await exec(db, "select dedupe_key, status, run_after, payload_json from jobs where type = ? order by id asc", [TOP_SCORES_BACKFILL_JOB])).rows;
}

async function storedTopScoreUserIds(): Promise<number[]> {
  return (await exec(db, "select distinct user_id from user_top_scores order by user_id asc")).rows.map((row) => Number(row.user_id));
}

describe("top scores backfill sweep", () => {
  it("selects only tracked roster users missing from user_top_scores, past the cursor", async () => {
    await seedRosterUser(1);
    await seedRosterUser(2);
    await seedRosterUser(3); // gets a stored projection below
    await seedRosterUser(4, { tracked: false });
    await seedRosterUser(5, { active: false });
    await seedRosterUser(6, { country: "AR" });
    await seedStoredTopScore(3);

    expect(await selectBackfillUserIds(db, 0, 10)).toEqual([1, 2, 6]);
    expect(await selectBackfillUserIds(db, 1, 10)).toEqual([2, 6]);
    expect(await selectBackfillUserIds(db, 6, 10)).toEqual([]);
  });

  it("processes a chunk, stores projections, advances the cursor, and chains the next chunk", async () => {
    // 27 eligible users: one full 25-user chunk plus a remainder.
    for (let userId = 1; userId <= 27; userId += 1) await seedRosterUser(userId);
    const osu = mockOsu({ emptyFor: new Set([2]) });

    const result = await runTopScoresBackfillJob(db, queue, osu, { cursor: 0 });

    expect(result).toMatchObject({ nextCursor: 25, processed: 25, fetched: 24, missing: 0, done: false });
    expect(osu.fetched).toHaveLength(25);
    expect(await storedTopScoreUserIds()).toEqual(Array.from({ length: 24 }, (_, i) => i + 1).filter((id) => id !== 2).concat(25).sort((a, b) => a - b));
    // User 2 (empty best scores) is passed by the cursor, not retried forever.
    expect(await selectBackfillUserIds(db, result.nextCursor, 10)).toEqual([26, 27]);

    const jobs = await backfillJobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `${TOP_SCORES_BACKFILL_JOB}:25`, status: "queued" });
    expect(String(jobs[0].run_after) > new Date().toISOString()).toBe(true);

    const progress = await readTopScoresBackfillProgress(db);
    expect(progress).toMatchObject({ cursor: 25, processed: 25, fetched: 24, missing: 0, failed: 0 });
    expect(progress.updatedAt).not.toBe("");
  });

  it("marks a 404 user missing and keeps sweeping the rest of the chunk", async () => {
    await seedRosterUser(1);
    await seedRosterUser(2);
    await seedRosterUser(3);
    const osu = mockOsu({ failWith404: new Set([2]) });

    const result = await runTopScoresBackfillJob(db, queue, osu, { cursor: 0 });

    expect(result).toMatchObject({ nextCursor: 3, processed: 3, fetched: 2, missing: 1, done: true });
    expect(await storedTopScoreUserIds()).toEqual([1, 3]);
    const banned = (await exec(db, "select is_active from users where user_id = 2")).rows[0];
    expect(Number(banned.is_active)).toBe(0);
    const bannedRoster = (await exec(db, "select is_tracked from country_rosters where user_id = 2")).rows[0];
    expect(Number(bannedRoster.is_tracked)).toBe(0);
    expect((await readTopScoresBackfillProgress(db)).missing).toBe(1);
  });

  it("persists progress and rethrows on a transient API error so the chunk retries via backoff", async () => {
    await seedRosterUser(1);
    await seedRosterUser(2);
    await seedRosterUser(3);
    const osu = mockOsu({ failWithError: new Set([2]) });

    await expect(runTopScoresBackfillJob(db, queue, osu, { cursor: 0 })).rejects.toThrow("osu! API 503");

    // User 1 got through before the failure and stays stored.
    expect(await storedTopScoreUserIds()).toEqual([1]);
    const progress = await readTopScoresBackfillProgress(db);
    expect(progress).toMatchObject({ cursor: 1, processed: 1, fetched: 1, failed: 1 });
    // No chain link and no done key: the failed job itself is the retry.
    expect(await backfillJobRows()).toHaveLength(0);
    const done = (await exec(db, "select 1 from live_meta where key = ?", [TOP_SCORES_BACKFILL_DONE_META_KEY])).rows;
    expect(done).toHaveLength(0);

    // The retry reselects only users still missing a projection.
    const retry = await runTopScoresBackfillJob(db, queue, mockOsu(), { cursor: 0 });
    expect(retry).toMatchObject({ processed: 2, fetched: 2, done: true });
    expect(await storedTopScoreUserIds()).toEqual([1, 2, 3]);
  });

  it("writes the done key and enqueues the skill-baseline refresh on completion, without rescheduling", async () => {
    await seedRosterUser(1);
    await seedRosterUser(2);
    const osu = mockOsu();

    const result = await runTopScoresBackfillJob(db, queue, osu, { cursor: 0 });

    expect(result).toMatchObject({ processed: 2, fetched: 2, done: true });
    const doneRow = (await exec(db, "select value_json from live_meta where key = ?", [TOP_SCORES_BACKFILL_DONE_META_KEY])).rows[0];
    expect(doneRow).toBeTruthy();
    expect(JSON.parse(String(doneRow.value_json))).toMatchObject({ processed: 2, fetched: 2, missing: 0, failed: 0 });
    // No further backfill chain link.
    expect(await backfillJobRows()).toHaveLength(0);
    // The baseline refold starts immediately instead of at the weekly interval.
    const baselineJobs = (await exec(db, "select status from jobs where type = ?", [SKILL_BASELINE_JOB])).rows;
    expect(baselineJobs).toHaveLength(1);
  });

  it("finishes without triggering the baseline refold when nothing was fetched", async () => {
    const result = await runTopScoresBackfillJob(db, queue, mockOsu(), { cursor: 0 });
    expect(result).toMatchObject({ processed: 0, fetched: 0, done: true });
    expect((await exec(db, "select 1 from live_meta where key = ?", [TOP_SCORES_BACKFILL_DONE_META_KEY])).rows).toHaveLength(1);
    expect((await exec(db, "select 1 from jobs where type = ?", [SKILL_BASELINE_JOB])).rows).toHaveLength(0);
  });

  it("seeds once at boot, resumes from stored progress, and schedules nothing once done", async () => {
    await seedRosterUser(1);

    // No done key, no pending link: seed at cursor 0.
    await ensureTopScoresBackfillSeeded(db, queue);
    let jobs = await backfillJobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `${TOP_SCORES_BACKFILL_JOB}:0`, status: "queued" });

    // A pending link means a second boot must not add another chain.
    await ensureTopScoresBackfillSeeded(db, queue);
    expect(await backfillJobRows()).toHaveLength(1);

    // A dead chain resumes from the persisted progress cursor, not from 0.
    await exec(db, "delete from jobs where type = ?", [TOP_SCORES_BACKFILL_JOB]);
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [TOP_SCORES_BACKFILL_PROGRESS_META_KEY, JSON.stringify({ cursor: 42, processed: 10, fetched: 9, missing: 1, failed: 0, updatedAt: "2026-07-01T00:00:00Z" }), "2026-07-01T00:00:00Z"],
    );
    await ensureTopScoresBackfillSeeded(db, queue);
    jobs = await backfillJobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `${TOP_SCORES_BACKFILL_JOB}:42` });
    expect(JSON.parse(String(jobs[0].payload_json))).toMatchObject({ cursor: 42 });

    // Done key present: boots schedule nothing, ever.
    await exec(db, "delete from jobs where type = ?", [TOP_SCORES_BACKFILL_JOB]);
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [TOP_SCORES_BACKFILL_DONE_META_KEY, JSON.stringify({ finishedAt: "2026-07-01T00:00:00Z" }), "2026-07-01T00:00:00Z"],
    );
    await ensureTopScoresBackfillSeeded(db, queue);
    expect(await backfillJobRows()).toHaveLength(0);
  });

  it("refreshes users through the windowed best-scores path and updates the pp threshold", async () => {
    await seedRosterUser(1);
    const osu = {
      fetched: [] as Array<{ userId: number; limit: number }>,
      getUserBestScores: async () => {
        throw new Error("sweep should use the windowed fetch");
      },
      getUserBestScoresWindow: async (userId: number, limit: number) => {
        (osu.fetched as Array<{ userId: number; limit: number }>).push({ userId, limit });
        return Array.from({ length: 100 }, (_, i) => bestScore(userId, 1000 + i, 200 - i));
      },
    };

    await runTopScoresBackfillJob(db, queue, osu, { cursor: 0 });

    expect(osu.fetched).toEqual([{ userId: 1, limit: 200 }]);
    const rows = (await exec(db, "select count(*) as count from user_top_scores where user_id = 1")).rows;
    expect(Number(rows[0].count)).toBe(100);
    // 100 positive-pp plays: top_play_min_pp becomes the window's minimum.
    const user = (await exec(db, "select top_play_min_pp, top_scores_refreshed_at from users where user_id = 1")).rows[0];
    expect(Number(user.top_play_min_pp)).toBe(101);
    expect(user.top_scores_refreshed_at).toBeTruthy();
  });
});
