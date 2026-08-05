import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getGlobalRankingsSnapshot } from "../src/features/global-rankings.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-keymode-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  // Mark the farm-helper key stats as seeded so reading them does not kick a
  // rebuild that would wipe the rows this test inserts directly.
  for (const keyCount of [4, 7]) {
    await exec(
      db,
      `insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)`,
      [`farm_helper_key_stats_seeded:${keyCount}`, "2", new Date().toISOString()],
    );
  }
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedPlayer(
  userId: number,
  username: string,
  pp: number,
  variants?: { pp4k: number; pp7k: number },
): Promise<void> {
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, pp_4k, pp_7k, profile_json, updated_at)
     values (?, ?, ?, 'CR', ?, ?, ?, ?, ?, '{}', ?)`,
    [
      userId,
      username,
      `https://a.ppy.sh/${userId}`,
      pp,
      userId,
      userId,
      variants ? variants.pp4k : null,
      variants ? variants.pp7k : null,
      new Date().toISOString(),
    ],
  );
  await exec(
    db,
    `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
     values ('CR', ?, ?, 'test', 1, ?)`,
    [userId, userId, new Date().toISOString()],
  );
}

async function seedFarmedKeyStat(userId: number, keyCount: number, weightedPp: number): Promise<void> {
  await exec(
    db,
    `insert into farm_helper_user_key_stats (key_count, user_id, weighted_pp, score_count, source_updated_at, updated_at)
     values (?, ?, ?, 20, ?, ?)`,
    [keyCount, userId, weightedPp, new Date().toISOString(), new Date().toISOString()],
  );
}

describe("pack pool keymode filter", () => {
  it("narrows pool=packs to one main keymode, with a farmed-stats fallback, and renumbers", async () => {
    // Variant pp decides where available; charlie has no variants and falls
    // back to farmed key stats; delta has no signal at all and lands nowhere.
    await seedPlayer(1, "alpha", 9000, { pp4k: 8800, pp7k: 120 });
    await seedPlayer(2, "bravo", 8000, { pp4k: 40, pp7k: 7900 });
    await seedPlayer(3, "charlie", 7000);
    await seedPlayer(4, "delta", 6000);
    await seedFarmedKeyStat(3, 4, 5200);
    await seedFarmedKeyStat(3, 7, 300);

    const fourKey = await getGlobalRankingsSnapshot(db, { pool: "packs", keys: 4, pageSize: 50 });
    expect(fourKey.ranking.map((entry) => entry.user.username)).toEqual(["alpha", "charlie"]);
    // Pool positions stay dense so uniform draws over [1, total] resolve.
    expect(fourKey.ranking.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(fourKey.total).toBe(2);

    const sevenKey = await getGlobalRankingsSnapshot(db, { pool: "packs", keys: 7, pageSize: 50 });
    expect(sevenKey.ranking.map((entry) => entry.user.username)).toEqual(["bravo"]);
    expect(sevenKey.total).toBe(1);

    // The unfiltered pool and the leaderboard are untouched by the filter.
    const wholePool = await getGlobalRankingsSnapshot(db, { pool: "packs", pageSize: 50 });
    expect(wholePool.total).toBe(4);
    const board = await getGlobalRankingsSnapshot(db, { pageSize: 50, keys: 4 });
    expect(board.total).toBe(4);
  });
});
