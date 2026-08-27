import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getKeyModePeerPool, refreshFarmHelperKeyStatsForUser } from "../src/features/farm-helper-key-stats.js";
import { getPlayerProfileSnapshot, ProfileUserSuppressedError } from "../src/features/player-profiles.js";
import { getSnipesSnapshot } from "../src/features/snipes.js";
import { getTrackerSnapshot } from "../src/features/tracker.js";
import { refreshCountryRoster } from "../src/rosters/country-rosters.js";
import { markUserMissing, previewUserWipe, wipeUserProjections } from "../src/users.js";
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
    await exec(
      db,
      `insert into top_play_events (country, user_id, score_id, score_beatmap_id, pp, weighted_pp, pp_gain, payload_json, score_time, detected_at)
       values ('CR', ?, ?, ?, 600, 600, 50, '{}', ?, ?)`,
      [userId, nextScoreId++, BM_A, now, now],
    );
    await exec(
      db,
      `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, '{}', '[]', 200, ?, ?, ?)`,
      [userId, `player${userId}`, now, now, now],
    );
    await exec(
      db,
      `insert into profile_section_cache (cache_key, user_id, section, payload_json, fetched_at, updated_at)
       values (?, ?, 'top', '{}', ?, ?)`,
      [`player${userId}:top`, userId, now, now],
    );
    await exec(
      db,
      `insert into player_activity_days (country, user_id, day, score_count, passed_count, session_count, first_score_at, last_score_at, updated_at)
       values ('CR', ?, '2026-08-01', 3, 3, 1, ?, ?, ?)`,
      [userId, now, now, now],
    );
    await exec(
      db,
      `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_score_id, best_pp, best_accuracy, best_rank, first_played_at, last_played_at, updated_at)
       values ('CR', ?, '2026-08-01', ?, 2, ?, 600, 0.99, 'S', ?, ?, ?)`,
      [userId, BM_A, nextScoreId++, now, now, now],
    );
    await exec(
      db,
      `insert into player_activity_score_refs (country, score_identity, user_id, day, beatmap_id, passed, ended_at, created_at)
       values ('CR', ?, ?, '2026-08-01', ?, 1, ?, ?)`,
      [`ref:${userId}:${nextScoreId++}`, userId, BM_A, now, now],
    );
    await exec(
      db,
      "insert into player_activity_backfill_cursors (country, user_id, last_event_id, updated_at) values ('CR', ?, 42, ?)",
      [userId, now],
    );
    await exec(
      db,
      `insert into activity_mods_backfill_queue (country, user_id, day, beatmap_id, score_id, dan)
       values ('CR', ?, '2026-08-01', ?, ?, 0)`,
      [userId, BM_A, nextScoreId++],
    );
    const rawScoreId = nextScoreId++;
    await exec(
      db,
      `insert into score_events
         (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (?, ?, ?, 'CR', ?, 3, '{}', 1, 1, 1, 0, ?, ?, 'test')`,
      [rawScoreId, `official:${rawScoreId}`, userId, BM_A, now, now],
    );
    await exec(
      db,
      `insert into country_beatmap_score_pbs
         (country, beatmap_id, lane_key, user_id, score_identity, score_id, total_score, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
       values ('CR', ?, 'nm', ?, ?, ?, 980000, 0.98, 'S', '[]', 1, 0, ?, ?)`,
      [BM_A, userId, `official:${rawScoreId}`, rawScoreId, now, now],
    );
    await exec(
      db,
      "insert into country_beatmap_score_pb_state (country, beatmap_id, lane_key, user_id, verified_at) values ('CR', ?, 'nm', ?, ?)",
      [BM_A, userId, now],
    );
    await exec(
      db,
      "insert into country_rank_snapshots (country, user_id, country_rank, global_rank, pp, captured_at) values ('CR', ?, 10, 100, 5000, ?)",
      [userId, now],
    );
    await exec(
      db,
      "insert into country_maps_most_played (country, user_id, beatmap_id, play_count, updated_at) values ('CR', ?, ?, 12, ?)",
      [userId, BM_A, now],
    );
    await exec(
      db,
      "insert into country_maps_favourite_sets (country, user_id, beatmapset_id, updated_at) values ('CR', ?, ?, ?)",
      [userId, BM_A + 1000, now],
    );
    await exec(
      db,
      `insert into farm_helper_push_targets
         (user_id, beatmap_id, speed_bucket, target_pp, subject_pp, suggested_at)
       values (?, ?, 'nm', 650, 600, ?)`,
      [userId, BM_A, Date.now()],
    );
    await exec(
      db,
      "insert into jobs (type, dedupe_key, status, run_after, payload_json, created_at, updated_at) values ('compute_player_skills', ?, 'running', ?, ?, ?, ?)",
      [`skills:${userId}`, now, JSON.stringify({ userId }), now, now],
    );
    await exec(
      db,
      "insert into live_event_log (event_id, type, country, payload_json, created_at) values (?, 'tracker_score', 'CR', ?, ?)",
      [`tracker:${userId}`, JSON.stringify({ schemaVersion: 1, ref: "tracker_score", scoreIdentity: `official:${rawScoreId}` }), now],
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
      top_play_events: 1,
      profile_snapshots: 1,
      profile_section_cache: 1,
      player_activity_days: 1,
      player_activity_maps: 1,
      player_activity_score_refs: 1,
      player_activity_backfill_cursors: 1,
      activity_mods_backfill_queue: 1,
      score_events: 1,
      country_beatmap_score_pbs: 1,
      country_beatmap_score_pb_state: 1,
      country_rank_snapshots: 1,
      country_maps_most_played: 1,
      country_maps_favourite_sets: 1,
      farm_helper_push_targets: 1,
      jobs: 1,
      live_event_log: 1,
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
      "top_play_events",
      "profile_snapshots",
      "profile_section_cache",
      "player_activity_days",
      "player_activity_maps",
      "player_activity_score_refs",
      "player_activity_backfill_cursors",
      "activity_mods_backfill_queue",
      "score_events",
      "country_beatmap_score_pbs",
      "country_beatmap_score_pb_state",
      "country_rank_snapshots",
      "country_maps_most_played",
      "country_maps_favourite_sets",
      "farm_helper_push_targets",
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

  it("resolves numeric usernames before ids and requires an explicit id prefix", async () => {
    await insertUser(TARGET, 5000, true, "Alpha");
    await insertUser(999, 4000, true, String(TARGET));

    await expect(previewUserWipe(db, String(TARGET))).resolves.toMatchObject({ userId: 999, username: String(TARGET) });
    await expect(previewUserWipe(db, `#${TARGET}`)).resolves.toMatchObject({ userId: TARGET, username: "Alpha" });
    await expect(previewUserWipe(db, `id:${TARGET}`)).resolves.toMatchObject({ userId: TARGET, username: "Alpha" });
  });

  it("refuses a logged-in/account-owned user without changing anything", async () => {
    await insertUser(TARGET, 5000, true, "Owner");
    await exec(
      db,
      `insert into user_goals (id, user_id, kind, status, created_at, updated_at)
       values ('goal-1', ?, 'reach_pp', 'open', ?, ?)`,
      [TARGET, Date.now(), Date.now()],
    );

    await expect(previewUserWipe(db, "Owner")).resolves.toMatchObject({ canWipe: false, impact: { accountDataRows: 1 } });
    await expect(wipeUserProjections(db, TARGET)).rejects.toMatchObject({ code: "user_has_account_data" });
    expect(Number((await exec(db, "select is_active from users where user_id = ?", [TARGET])).rows[0]?.is_active)).toBe(1);
    expect(await countRows("user_goals", TARGET)).toBe(1);
  });

  it("removes target card projections and snapshot references without touching the collector's other card", async () => {
    await insertUser(TARGET, 5000, true, "Cheater");
    await insertUser(BYSTANDER, 5000, true, "Collector");
    const now = Date.now();
    await exec(db, "insert into pack_cards (card_key, tier, card_user_id, username, avatar_url, country_code, updated_at) values (?, '', ?, 'Cheater', '', 'CR', ?)", [String(TARGET), TARGET, now]);
    await exec(db, "insert into pack_cards (card_key, tier, card_user_id, username, avatar_url, country_code, updated_at) values (?, '', ?, 'Safe', '', 'CR', ?)", [String(BYSTANDER), BYSTANDER, now]);
    for (const cardUserId of [TARGET, BYSTANDER]) {
      await exec(
        db,
        `insert into pack_collection_cards
           (owner_user_id, card_user_id, card_key, pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at)
         values (?, ?, ?, 5000, 100, 1, 0, ?, ?, ?)`,
        [BYSTANDER, cardUserId, String(cardUserId), now, now, now],
      );
    }
    await exec(db, "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, ?)", [BYSTANDER, String(TARGET), now]);

    await wipeUserProjections(db, TARGET);

    expect(Number((await exec(db, "select count(*) as n from pack_collection_cards where card_user_id = ?", [TARGET])).rows[0]?.n)).toBe(0);
    expect(Number((await exec(db, "select count(*) as n from pack_showcase_cards where owner_user_id = ?", [BYSTANDER])).rows[0]?.n)).toBe(0);
    expect(Number((await exec(db, "select count(*) as n from pack_collection_cards where card_user_id = ?", [BYSTANDER])).rows[0]?.n)).toBe(1);
  });

  it("scrubs compact map snapshots and public history reads", async () => {
    await insertUser(TARGET, 5000, true, "Cheater");
    await insertUser(BYSTANDER, 5000, true, "Safe");
    const stamp = nowIso();
    const stored = {
      schemaVersion: 2,
      farmed: [{ beatmapId: BM_A, playerCount: 2, avgPp: 550, maxPp: 600, dominantMod: null, players: [
        { id: TARGET, mods: [], pp: 600, scoreUrl: null, playedAt: stamp },
        { id: BYSTANDER, mods: [], pp: 500, scoreUrl: null, playedAt: stamp },
      ] }],
      mostPlayed: [{ beatmapId: BM_A, totalPlays: 30, playerCount: 3, players: [{ id: TARGET, count: 20 }, { id: BYSTANDER, count: 10 }] }],
      favourites: [{ beatmapsetId: BM_A + 1000, playerCount: 3, players: [{ id: TARGET }, { id: BYSTANDER }] }],
      favouritesByPlayer: [{ id: TARGET, beatmapsetIds: [BM_A + 1000] }, { id: BYSTANDER, beatmapsetIds: [BM_A + 1000] }],
      beatmapsetsPool: [BM_A + 1000],
      generatedAt: stamp,
      farmedGeneratedAt: stamp,
      favouritesGeneratedAt: stamp,
    };
    await exec(db, "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values ('CR', ?, ?, ?)", [JSON.stringify(stored), stamp, stamp]);
    await exec(
      db,
      `insert into snipe_events (country, beatmap_id, lane_key, score_id, sniper_id, victim_id, payload_json, detected_at)
       values ('CR', ?, 'nm', 123, ?, ?, ?, ?)`,
      [BM_A, TARGET, BYSTANDER, JSON.stringify({ sniper: { id: TARGET }, victim: { id: BYSTANDER } }), stamp],
    );

    const result = await wipeUserProjections(db, TARGET);

    expect(result.updated.country_maps_snapshots).toBe(1);
    const payload = String((await exec(db, "select payload_json from country_maps_snapshots where country = 'CR'")).rows[0]?.payload_json ?? "");
    expect(payload).not.toContain(`\"id\":${TARGET}`);
    expect(payload).toContain(`\"id\":${BYSTANDER}`);
    expect((await getTrackerSnapshot(db, "CR", 100)).scores).toEqual([]);
    expect((await getSnipesSnapshot(db, "CR", 100)).events).toEqual([]);
  });

  it("blocks a cold profile mint for an inactive tombstone without calling osu!", async () => {
    await insertUser(TARGET, 5000, false, "Gone");
    let calls = 0;
    const osu = {
      getUserByKey: async () => { calls++; return { id: TARGET, username: "Gone" }; },
      getUserBestScoresWindow: async () => { calls++; return []; },
    };
    await expect(getPlayerProfileSnapshot(db, osu, "Gone")).rejects.toBeInstanceOf(ProfileUserSuppressedError);
    expect(calls).toBe(0);
  });

  it("does not let a roster refresh re-track an inactive tombstone", async () => {
    await insertUser(TARGET, 5000, false, "Gone");
    await exec(db, "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', ?, null, 'osu_rankings', 0, ?)", [TARGET, nowIso()]);
    let page = 0;
    const osu = {
      getRanking: async () => ({
        ranking: page++ === 0 ? [{ pp: 5000, global_rank: 100, country_rank: 1, user: { id: TARGET, username: "Gone", avatar_url: "", country_code: "CR" } }] : [],
      }),
    };
    await refreshCountryRoster(db, osu as never, "CR", "test");
    const roster = (await exec(db, "select rank, is_tracked from country_rosters where country = 'CR' and user_id = ?", [TARGET])).rows[0];
    expect(Number(roster?.is_tracked)).toBe(0);
    expect(roster?.rank).toBeNull();
    expect(await countRows("country_rank_snapshots", TARGET)).toBe(0);
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
