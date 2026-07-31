import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getKeyModePeerPool, refreshFarmHelperKeyStatsForUser } from "../src/features/farm-helper-key-stats.js";
import { markUserMissing, wipeUserProjections } from "../src/users.js";
import { nowIso } from "../src/shared/score.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-wipe-user-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function insertUser(id: number, pp: number, isActive = true, username = `Peer${id}`): Promise<void> {
  await exec(
    db,
    "insert into users (user_id, username, avatar_url, country_code, is_active, pp, updated_at) values (?, ?, ?, 'CR', ?, ?, ?)",
    [id, username, `https://a.ppy.sh/${id}`, isActive ? 1 : 0, pp, nowIso()],
  );
}

let nextScoreId = 1;

async function insertFarmed(country: string, userId: number, beatmapId: number, pp: number): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
     values (?, ?, ?, ?, ?, '{}', '[]', null, ?, ?, ?)`,
    [country, userId, beatmapId, nextScoreId++, pp, now, now, now],
  );
}

async function insertGlobalFarmed(userId: number, beatmapId: number, pp: number): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into global_maps_farmed_scores
       (beatmap_id, user_id, pp, mods_json, speed_mod, score_url, played_at, detected_at, source_country, source_updated_at)
     values (?, ?, ?, '[]', null, null, ?, ?, 'CR', ?)`,
    [beatmapId, userId, pp, now, now, now],
  );
}

async function insertKeyStats(userId: number, keyCount: number, weightedPp = 500, scoreCount = 10): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into farm_helper_user_key_stats (key_count, user_id, weighted_pp, score_count, source_updated_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [keyCount, userId, weightedPp, scoreCount, now, now],
  );
}

async function countRows(table: string, userId: number): Promise<number> {
  const row = (await exec(db, `select count(*) as n from ${table} where user_id = ?`, [userId])).rows[0];
  return Number(row?.n ?? 0);
}

// Marks the key stats as already seeded so getKeyModePeerPool reads the rows we
// insert directly instead of rebuilding from farmed scores.
async function markKeyStatsSeeded(keyCount: number): Promise<void> {
  await exec(
    db,
    "insert into live_meta (key, value_json, updated_at) values (?, '999', ?)",
    [`farm_helper_key_stats_seeded:${keyCount}`, nowIso()],
  );
}

describe("wipeUserProjections", () => {
  const TARGET = 55;
  const BYSTANDER = 66;
  const THIRD = 77;
  const BM_A = 900;
  const BM_B = 901;

  async function seedProjectionRows(userId: number): Promise<void> {
    const now = nowIso();
    await insertFarmed("CR", userId, BM_A, 600);
    await insertFarmed("CR", userId, BM_B, 610);
    await insertGlobalFarmed(userId, BM_A, 600);
    await insertKeyStats(userId, 4);
    await insertKeyStats(userId, 7);
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (?, ?, 1, '{}', 600, 600, ?, ?)`,
      [userId, nextScoreId++, now, now],
    );
    await exec(
      db,
      `insert into country_beatmap_scores
         (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
       values ('CR', ?, 'nm', ?, ?, 990000, 600, 0.99, 'S', '[]', 1, 0, ?, ?)`,
      [BM_A, userId, nextScoreId++, now, now],
    );
    await exec(
      db,
      `insert into farm_helper_feedback (user_id, beatmap_id, speed_bucket, verdict, created_at, updated_at)
       values (?, ?, 'nm', 'too_hard', ?, ?)`,
      [userId, BM_A, Date.now(), Date.now()],
    );
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, updated_at) values (?, 1, 'done', ?)`,
      [userId, now],
    );
    await exec(
      db,
      `insert into player_skill_baseline (user_id, key_count, baseline_version, analyzed_plays, ratings_json, updated_at)
       values (?, 4, 1, 20, '{}', ?)`,
      [userId, now],
    );
  }

  it("deletes every projection table, keeps the users row as an inactive tombstone, and spares other users", async () => {
    await insertUser(TARGET, 5000, true, "Cheater");
    await insertUser(BYSTANDER, 5000);
    await insertUser(THIRD, 5000);
    await exec(
      db,
      "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', ?, 10, 'rankings', 1, ?)",
      [TARGET, nowIso()],
    );
    await seedProjectionRows(TARGET);
    await seedProjectionRows(BYSTANDER);
    // Third global row on BM_A so the rebuilt aggregate keeps a >= 2 player count.
    await insertGlobalFarmed(THIRD, BM_A, 620);
    // Initialized global board state: the wipe must advance revision, not reseed.
    await exec(
      db,
      "insert into global_maps_farmed_state (singleton, initialized, revision, seed_epoch, updated_at) values (1, 1, 5, 2, ?)",
      [nowIso()],
    );

    const result = await wipeUserProjections(db, TARGET);

    expect(result.userId).toBe(TARGET);
    expect(result.untrackedRosters).toBe(1);
    expect(result.deleted).toMatchObject({
      country_maps_farmed_scores: 2,
      global_maps_farmed_scores: 1,
      farm_helper_user_key_stats: 2,
      user_top_scores: 1,
      country_beatmap_scores: 1,
      farm_helper_feedback: 1,
      player_skill_ratings: 1,
      player_skill_baseline: 1,
    });

    // The users row survives as the inactive tombstone; nothing else does.
    const userRow = (await exec(db, "select username, is_active from users where user_id = ?", [TARGET])).rows[0];
    expect(userRow).toBeTruthy();
    expect(String(userRow?.username)).toBe("Cheater");
    expect(Number(userRow?.is_active)).toBe(0);
    for (const table of [
      "country_maps_farmed_scores",
      "global_maps_farmed_scores",
      "farm_helper_user_key_stats",
      "user_top_scores",
      "country_beatmap_scores",
      "farm_helper_feedback",
      "player_skill_ratings",
      "player_skill_baseline",
    ]) {
      expect(await countRows(table, TARGET), table).toBe(0);
      expect(await countRows(table, BYSTANDER), `${table} bystander`).toBeGreaterThan(0);
    }
  });

  it("publishes a global-board revision and rebuilds the touched aggregates so packed boards catch up", async () => {
    await insertUser(TARGET, 5000);
    await insertUser(BYSTANDER, 5000);
    await insertUser(THIRD, 5000);
    await seedProjectionRows(TARGET);
    await seedProjectionRows(BYSTANDER);
    await insertGlobalFarmed(THIRD, BM_A, 620);
    await exec(
      db,
      "insert into global_maps_farmed_state (singleton, initialized, revision, seed_epoch, updated_at) values (1, 1, 5, 2, ?)",
      [nowIso()],
    );

    await wipeUserProjections(db, TARGET);

    const state = (await exec(db, "select initialized, revision, seed_epoch from global_maps_farmed_state where singleton = 1")).rows[0];
    expect(Number(state?.initialized)).toBe(1);
    expect(Number(state?.revision)).toBeGreaterThan(5);
    // No destructive world reseed: seed_epoch is untouched, only the revision moved.
    expect(Number(state?.seed_epoch)).toBe(2);

    // The wiped user's global rows are gone, others remain.
    expect(await countRows("global_maps_farmed_scores", TARGET)).toBe(0);
    expect(await countRows("global_maps_farmed_scores", BYSTANDER)).toBe(1);
    expect(await countRows("global_maps_farmed_scores", THIRD)).toBe(1);

    // The touched beatmap re-aggregated without the wiped user and published a
    // change row at the new revision (what serving processes patch from).
    const aggregate = (await exec(db, "select player_count, revision from global_maps_farmed_aggregates where beatmap_id = ?", [BM_A])).rows[0];
    expect(Number(aggregate?.player_count)).toBe(2);
    const change = (await exec(db, "select revision from global_maps_farmed_changes where beatmap_id = ?", [BM_A])).rows[0];
    expect(Number(change?.revision)).toBe(Number(state?.revision));
  });

  it("handles a user with no projection rows and rejects invalid ids", async () => {
    await insertUser(TARGET, 5000);
    const result = await wipeUserProjections(db, TARGET);
    expect(Object.values(result.deleted).every((count) => count === 0)).toBe(true);
    expect(Number((await exec(db, "select is_active from users where user_id = ?", [TARGET])).rows[0]?.is_active)).toBe(0);
    await expect(wipeUserProjections(db, 0)).rejects.toThrow("Invalid user id");
  });
});

describe("farm helper read-time exclusion of inactive users", () => {
  it("keeps deactivated users out of the key-mode peer pool while identical active users stay", async () => {
    await markKeyStatsSeeded(4);
    await insertUser(1001, 5000, true);
    await insertUser(1002, 5000, false);
    await insertKeyStats(1001, 4);
    await insertKeyStats(1002, 4);

    const { peers } = await getKeyModePeerPool(db, 4);
    const ids = peers.map((peer) => peer.userId);
    expect(ids).toContain(1001);
    expect(ids).not.toContain(1002);
  });

  it("still builds key stats for a user with farmed rows but NO users row, and purges them once deactivated", async () => {
    const orphan = 999;
    const now = nowIso();
    await exec(
      db,
      `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, version, updated_at)
       values (700, 800, 'mania', 'ranked', 4, 5, 'Insane', ?)`,
      [now],
    );
    await insertFarmed("CR", orphan, 700, 400);

    // Missing users row must never exclude anyone.
    await refreshFarmHelperKeyStatsForUser(db, orphan);
    expect(await countRows("farm_helper_user_key_stats", orphan)).toBe(1);

    // Once deactivated, the same refresh acts as write-time hygiene.
    await markUserMissing(db, orphan, "test");
    await refreshFarmHelperKeyStatsForUser(db, orphan);
    expect(await countRows("farm_helper_user_key_stats", orphan)).toBe(0);
  });
});
