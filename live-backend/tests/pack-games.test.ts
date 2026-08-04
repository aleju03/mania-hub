import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { packJson } from "../src/shared/compressed-json.js";
import {
  clearStreakMetricsCache,
  GAME_SHARD_DAILY_CAP,
  getPackGameAllowance,
  getStreakPlayerMetrics,
  grantPackGameShards,
  nextStreakMilestone,
  rewardDay,
  streakShardReward,
} from "../src/features/pack-games.js";

let dir = "";
let db: Db;

const PLAYER = 4242;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-games-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  // The metrics cache is module-level and would otherwise leak answers from
  // one test's database into the next one's.
  clearStreakMetricsCache();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function walletShards(userId: number): Promise<number> {
  const row = (await exec(db, "select payload from pack_wallets where user_id = ?", [userId])).rows[0];
  return row ? Number(JSON.parse(String(row.payload)).shards) : 0;
}

describe("what a streak is worth", () => {
  it("pays a shard a guess, plus a growing bonus every five in a row", () => {
    expect(streakShardReward(0)).toBe(0);
    expect(streakShardReward(1)).toBe(1);
    expect(streakShardReward(4)).toBe(4);
    // Fifth in a row: 5 guesses plus the first milestone.
    expect(streakShardReward(5)).toBe(10);
    expect(streakShardReward(9)).toBe(14);
    // Tenth: 10 guesses plus 5 and 10.
    expect(streakShardReward(10)).toBe(25);
    expect(streakShardReward(20)).toBe(70);
  });

  it("is worth going deep rather than restarting", () => {
    // Two runs of five against one run of ten: the same number of correct
    // guesses, and the long run has to pay more or the game is asking to be
    // quit every five.
    expect(streakShardReward(5) * 2).toBeLessThan(streakShardReward(10));
    expect(streakShardReward(10) * 2).toBeLessThan(streakShardReward(20));
  });

  it("says what the next milestone is worth", () => {
    expect(nextStreakMilestone(0)).toEqual({ at: 5, bonus: 5 });
    expect(nextStreakMilestone(4)).toEqual({ at: 5, bonus: 5 });
    expect(nextStreakMilestone(5)).toEqual({ at: 10, bonus: 10 });
    expect(nextStreakMilestone(12)).toEqual({ at: 15, bonus: 15 });
  });

  it("clamps a claimed streak before it ever reaches the allowance", () => {
    expect(streakShardReward(10 ** 6)).toBe(streakShardReward(1000));
  });

  it("refuses to pay for a nonsense streak", () => {
    expect(streakShardReward(Number.NaN)).toBe(0);
    expect(streakShardReward(-5)).toBe(0);
  });
});

describe("the daily allowance", () => {
  it("pays out and books what it paid", async () => {
    expect(await grantPackGameShards(db, PLAYER, "streak", 4)).toMatchObject({
      granted: 4,
      remainingToday: GAME_SHARD_DAILY_CAP - 4,
      cap: GAME_SHARD_DAILY_CAP,
    });
    expect(await walletShards(PLAYER)).toBe(4);
    expect(await getPackGameAllowance(db, PLAYER)).toMatchObject({
      remainingToday: GAME_SHARD_DAILY_CAP - 4,
    });
  });

  it("trims the last payout of the day to what is left, then pays nothing", async () => {
    await grantPackGameShards(db, PLAYER, "streak", GAME_SHARD_DAILY_CAP - 2);
    // Asking for more than remains is not refused, it is trimmed: a good run
    // should still bank whatever was left.
    expect((await grantPackGameShards(db, PLAYER, "duel", 5)).granted).toBe(2);
    expect((await grantPackGameShards(db, PLAYER, "streak", 5)).granted).toBe(0);
    expect(await walletShards(PLAYER)).toBe(GAME_SHARD_DAILY_CAP);
  });

  it("shares one allowance across both games", async () => {
    await grantPackGameShards(db, PLAYER, "duel", 12);
    expect((await getPackGameAllowance(db, PLAYER)).remainingToday).toBe(GAME_SHARD_DAILY_CAP - 12);
  });

  it("starts a fresh allowance the next day", async () => {
    const today = Date.parse("2026-08-04T22:00:00Z");
    const tomorrow = Date.parse("2026-08-05T01:00:00Z");
    await grantPackGameShards(db, PLAYER, "streak", GAME_SHARD_DAILY_CAP, today);
    expect((await grantPackGameShards(db, PLAYER, "streak", 5, today)).granted).toBe(0);
    expect((await grantPackGameShards(db, PLAYER, "streak", 5, tomorrow)).granted).toBe(5);
    expect(rewardDay(today)).not.toBe(rewardDay(tomorrow));
  });

  it("pays nobody for a zero reward or a bogus account", async () => {
    expect((await grantPackGameShards(db, PLAYER, "streak", 0)).granted).toBe(0);
    expect((await grantPackGameShards(db, 0, "streak", 5)).granted).toBe(0);
    expect((await exec(db, "select count(*) as n from pack_game_rewards")).rows[0].n).toBe(0);
  });
});

describe("the streak question numbers", () => {
  async function seedBeatmap(beatmapId: number, cs: number, stars: number): Promise<void> {
    await exec(
      db,
      `insert into beatmaps (beatmap_id, beatmapset_id, mode, cs, difficulty_rating, bpm, version, url, updated_at)
       values (?, 1, 'mania', ?, ?, 180, 'test', '', '2026-01-01T00:00:00Z')`,
      [beatmapId, cs, stars],
    );
  }

  async function seedTopScore(
    userId: number,
    position: number,
    beatmapId: number,
    mods: string[],
    endedAt: string,
  ): Promise<void> {
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (?, ?, ?, ?, 500, 500, ?, '2026-01-01T00:00:00Z')`,
      [
        userId,
        userId * 1000 + position,
        position,
        JSON.stringify({ id: userId * 1000 + position, beatmap_id: beatmapId, mods: mods.map((acronym) => ({ acronym })) }),
        endedAt,
      ],
    );
  }

  it("aggregates a player's stored top plays", async () => {
    await seedBeatmap(11, 4, 9.81);
    await seedBeatmap(12, 7, 5.2);
    await seedTopScore(PLAYER, 1, 11, ["DT"], "2024-05-01T00:00:00Z");
    await seedTopScore(PLAYER, 2, 12, [], "2019-10-05T00:00:00Z");
    await seedTopScore(PLAYER, 3, 12, ["NC"], "2025-01-01T00:00:00Z");

    const metrics = (await getStreakPlayerMetrics(db, [PLAYER]))[PLAYER];
    expect(metrics.bestStars).toBeCloseTo(9.81);
    expect(metrics.oldestTopAt).toBe(Date.parse("2019-10-05T00:00:00Z"));
    // NC is DT with a different sound.
    expect(metrics.dtTop).toBe(2);
    expect(metrics.k7Top).toBe(2);
  });

  it("reads the profile numbers, packed or plain", async () => {
    const profile = {
      join_date: "2014-05-20T00:00:00Z",
      follower_count: 321,
      statistics: { play_time: 7200 * 100, replays_watched_by_others: 5678 },
    };
    await exec(
      db,
      "insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at) values (?, 'a', ?, '[]', 100, '', '', '')",
      [PLAYER, JSON.stringify(profile)],
    );
    await exec(
      db,
      "insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at) values (?, 'b', ?, '[]', 100, '', '', '')",
      [PLAYER + 1, packJson(profile)],
    );

    const metrics = await getStreakPlayerMetrics(db, [PLAYER, PLAYER + 1]);
    for (const userId of [PLAYER, PLAYER + 1]) {
      expect(metrics[userId].joinedAt).toBe(Date.parse("2014-05-20T00:00:00Z"));
      expect(metrics[userId].followers).toBe(321);
      expect(metrics[userId].playTimeHours).toBe(200);
      expect(metrics[userId].replayViews).toBe(5678);
    }
  });

  it("answers all-null for a player the projections never met, and zero for an empty mod count", async () => {
    await seedBeatmap(21, 4, 8);
    await seedTopScore(PLAYER, 1, 21, [], "2024-01-01T00:00:00Z");

    const metrics = await getStreakPlayerMetrics(db, [PLAYER, 999999]);
    // Zero DT plays is an answer; a player with no stored plays has none.
    expect(metrics[PLAYER].dtTop).toBe(0);
    expect(metrics[PLAYER].k7Top).toBe(0);
    expect(metrics[999999]).toMatchObject({ bestStars: null, dtTop: null, joinedAt: null, playTimeHours: null });
  });

  it("serves repeat asks from memory instead of re-reading the database", async () => {
    await seedBeatmap(31, 7, 6);
    await seedTopScore(PLAYER, 1, 31, [], "2024-01-01T00:00:00Z");
    const first = await getStreakPlayerMetrics(db, [PLAYER]);
    expect(first[PLAYER].k7Top).toBe(1);
    // A new top play lands; the cached answer stands until the TTL passes.
    await seedBeatmap(32, 7, 6.5);
    await seedTopScore(PLAYER, 2, 32, [], "2024-02-01T00:00:00Z");
    const cached = await getStreakPlayerMetrics(db, [PLAYER]);
    expect(cached[PLAYER].k7Top).toBe(1);
    const later = await getStreakPlayerMetrics(db, [PLAYER], Date.now() + 7 * 60 * 60 * 1000);
    expect(later[PLAYER].k7Top).toBe(2);
  });
});
