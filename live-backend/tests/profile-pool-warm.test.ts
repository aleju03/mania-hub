import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  enqueueProfilePoolWarmIfIdle,
  PROFILE_POOL_WARM_JOB,
  runProfilePoolWarmJob,
  selectColdPoolUserIds,
} from "../src/features/profile-pool-warm.js";
import { JobQueue } from "../src/jobs/queue.js";
import { OsuApiError } from "../src/osu/client.js";
import type { OscScore } from "../src/shared/types.js";

let dir = "";
let db: Db;
let queue: JobQueue;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pool-warm-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedPoolUser(userId: number, pp: number, options: { tracked?: boolean; active?: boolean } = {}): Promise<void> {
  const now = new Date().toISOString();
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, is_active, pp, global_rank, profile_json, updated_at)
     values (?, ?, '', 'CR', ?, ?, ?, '{}', ?)`,
    [userId, `player-${userId}`, options.active === false ? 0 : 1, pp, Math.round(20_000 / pp), now],
  );
  await exec(
    db,
    `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
     values ('CR', ?, ?, 'osu_rankings', ?, ?)`,
    [userId, userId, options.tracked === false ? 0 : 1, now],
  );
}

function bestScore(userId: number, id: number): OscScore {
  return {
    id,
    user_id: userId,
    pp: 100,
    ended_at: "2026-06-01T00:00:00Z",
  } as OscScore;
}

function mockOsu(overrides: { failWith404?: Set<number> } = {}) {
  const fetched: number[] = [];
  return {
    fetched,
    getUserByKey: async (key: string) => {
      const userId = Number(key);
      if (overrides.failWith404?.has(userId)) throw new OsuApiError(404, `/users/${userId}`);
      fetched.push(userId);
      return { id: userId, username: `player-${userId}` };
    },
    getUserBestScoresWindow: async (userId: number) => [bestScore(userId, userId * 10)],
  };
}

async function jobRows() {
  return (await exec(db, "select dedupe_key, status, payload_json from jobs where type = ? order by id asc", [PROFILE_POOL_WARM_JOB])).rows;
}

describe("profile pool warm sweep", () => {
  it("selects only pool players with no stored best scores, hottest pp first", async () => {
    await seedPoolUser(1, 5000);
    await seedPoolUser(2, 3000);
    await seedPoolUser(3, 8000); // gets a profile snapshot below
    await seedPoolUser(4, 7000); // gets user_top_scores rows below
    await seedPoolUser(5, 9000, { tracked: false });
    await seedPoolUser(6, 9500, { active: false });
    await exec(
      db,
      `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (3, 'player-3', '{}', '[]', 200, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
    );
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (4, 40, 1, '{}', 100, 100, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    );

    expect(await selectColdPoolUserIds(db, 10)).toEqual([1, 2]);
  });

  it("warms a batch, stores snapshots, and chains the next run", async () => {
    await seedPoolUser(1, 5000);
    await seedPoolUser(2, 3000);
    const osu = mockOsu();

    const result = await runProfilePoolWarmJob(db, queue, osu, { seq: 7 });

    expect(result).toMatchObject({ warmed: 2, markedMissing: 0, done: false });
    expect(osu.fetched).toEqual([1, 2]);
    const snapshots = (await exec(db, "select user_id from profile_snapshots order by user_id asc")).rows.map((row) => Number(row.user_id));
    expect(snapshots).toEqual([1, 2]);
    const jobs = await jobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `${PROFILE_POOL_WARM_JOB}:8`, status: "queued" });
    expect(await selectColdPoolUserIds(db, 10)).toEqual([]);
  });

  it("marks 404 players missing and keeps warming the rest of the batch", async () => {
    await seedPoolUser(1, 5000);
    await seedPoolUser(2, 3000);
    const osu = mockOsu({ failWith404: new Set([1]) });

    const result = await runProfilePoolWarmJob(db, queue, osu, { seq: 0 });

    expect(result).toMatchObject({ warmed: 1, markedMissing: 1, done: false });
    const bannedUser = (await exec(db, "select is_active from users where user_id = 1")).rows[0];
    expect(Number(bannedUser.is_active)).toBe(0);
    const bannedRoster = (await exec(db, "select is_tracked from country_rosters where user_id = 1")).rows[0];
    expect(Number(bannedRoster.is_tracked)).toBe(0);
    expect((await exec(db, "select user_id from profile_snapshots")).rows.map((row) => Number(row.user_id))).toEqual([2]);
    expect(await selectColdPoolUserIds(db, 10)).toEqual([]);
  });

  it("finishes without chaining when the pool has nothing cold", async () => {
    const osu = mockOsu();
    const result = await runProfilePoolWarmJob(db, queue, osu, { seq: 0 });
    expect(result).toMatchObject({ warmed: 0, done: true });
    expect(await jobRows()).toHaveLength(0);
  });

  it("seeds the chain only when idle and cold players exist", async () => {
    // Nothing cold: no seed.
    expect(await enqueueProfilePoolWarmIfIdle(db, queue)).toBe(false);
    expect(await jobRows()).toHaveLength(0);

    await seedPoolUser(1, 5000);
    expect(await enqueueProfilePoolWarmIfIdle(db, queue)).toBe(true);
    expect(await jobRows()).toHaveLength(1);

    // A pending link means the watchdog must not add a second chain (which
    // would accelerate the pacing).
    expect(await enqueueProfilePoolWarmIfIdle(db, queue)).toBe(false);
    expect(await jobRows()).toHaveLength(1);
  });
});
