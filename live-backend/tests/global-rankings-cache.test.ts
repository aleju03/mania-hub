import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getGlobalRankingsSnapshot } from "../src/features/global-rankings.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-global-board-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedPlayer(userId: number, username: string, pp: number, country = "CR", rank = userId): Promise<void> {
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, profile_json, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      username,
      `https://a.ppy.sh/${userId}`,
      country,
      pp,
      userId,
      rank,
      JSON.stringify({ statistics: { hit_accuracy: 98.5, play_count: 1000, ranked_score: 12345 } }),
      new Date().toISOString(),
    ],
  );
  await exec(
    db,
    `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
     values (?, ?, ?, 'test', 1, ?)`,
    [country, userId, rank, new Date().toISOString()],
  );
}

describe("global rankings board cache", () => {
  it("builds the board from tracked rosters ordered by pp", async () => {
    await seedPlayer(1, "alpha", 9000);
    await seedPlayer(2, "beta", 12000);
    const snapshot = await getGlobalRankingsSnapshot(db, { page: 1, pageSize: 50 });
    expect(snapshot.total).toBe(2);
    expect(snapshot.ranking.map((entry) => entry.user.username)).toEqual(["beta", "alpha"]);
    expect(snapshot.ranking[0].rank).toBe(1);
    expect(snapshot.ranking[0].hit_accuracy).toBeCloseTo(98.5);
  });

  it("answers repeat requests from the cached board instead of re-reading the roster", async () => {
    await seedPlayer(1, "alpha", 9000);
    const first = await getGlobalRankingsSnapshot(db, { page: 1 });
    expect(first.ranking[0].user.username).toBe("alpha");

    // A row change inside the TTL must not surface: the board is served from memory.
    await exec(db, `update users set username = 'renamed' where user_id = 1`);
    const second = await getGlobalRankingsSnapshot(db, { page: 1 });
    expect(second.ranking[0].user.username).toBe("alpha");
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it("keeps separate boards per db instance", async () => {
    await seedPlayer(1, "alpha", 9000);
    await getGlobalRankingsSnapshot(db, { page: 1 });

    const otherDir = await mkdtemp(join(tmpdir(), "mania-global-board-b-"));
    try {
      const otherDb = await createDb({ databaseUrl: `file:${join(otherDir, "test.db")}` });
      await migrate(otherDb);
      const snapshot = await getGlobalRankingsSnapshot(otherDb, { page: 1 });
      expect(snapshot.total).toBe(0);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("returns clones so response mutation cannot corrupt the shared board", async () => {
    await seedPlayer(1, "alpha", 9000);
    const first = await getGlobalRankingsSnapshot(db, { page: 1 });
    (first.ranking[0].user as Record<string, unknown>).avatarAccent = "#ff0000";
    first.ranking[0].user.username = "mutated";

    const second = await getGlobalRankingsSnapshot(db, { page: 1 });
    expect(second.ranking[0].user.username).toBe("alpha");
    expect((second.ranking[0].user as Record<string, unknown>).avatarAccent).toBeUndefined();
  });

  it("serves every sort and page from the same cached board", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await seedPlayer(i, `player${i}`, 10000 - i * 100);
    }
    const byRank = await getGlobalRankingsSnapshot(db, { page: 1, pageSize: 2 });
    const pageTwo = await getGlobalRankingsSnapshot(db, { page: 2, pageSize: 2 });
    const byPlayer = await getGlobalRankingsSnapshot(db, { sort: "player", dir: "asc" });
    expect(byRank.ranking.map((entry) => entry.user.username)).toEqual(["player1", "player2"]);
    expect(pageTwo.ranking.map((entry) => entry.user.username)).toEqual(["player3", "player4"]);
    expect(byPlayer.ranking[0].user.username).toBe("player1");
    expect(byPlayer.fetchedAt).toBe(byRank.fetchedAt);
  });
});
