import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import { PLAYER_SKILLS_VERSION } from "../src/features/player-skills.js";
import { decoratePlayerSkillBreakdown, runSkillBaselineJob } from "../src/features/skill-baseline.js";
import {
  expireSkillLeaderboardBoard,
  getDanLeaderboard,
  getSkillLeaderboard,
  leaderboardAxesFor,
  resetSkillLeaderboardCache,
  skillLeaderboardBuildCount,
} from "../src/features/skill-leaderboards.js";

type TestDb = Awaited<ReturnType<typeof createDb>>;

async function withDb(run: (db: TestDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-skill-board-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface SeedPlayer {
  userId: number;
  username: string;
  country: string;
  keyCount: number;
  analyzedPlays: number;
  ratings?: Record<string, number>;
  patterns?: Array<{ id: string; rating: number; plays: number }>;
  dan?: { rc?: { rawDan: number; label: string; clears: number; beyondTable?: boolean }; ln?: { rawDan: number; label: string; clears: number } };
}

async function seed(db: TestDb, players: SeedPlayer[]): Promise<void> {
  const now = new Date().toISOString();
  const byUser = new Map<number, SeedPlayer[]>();
  for (const player of players) {
    const list = byUser.get(player.userId);
    if (list) list.push(player);
    else byUser.set(player.userId, [player]);
  }
  for (const [userId, modes] of byUser) {
    const first = modes[0];
    await exec(
      db,
      "insert or replace into users (user_id, username, avatar_url, country_code, is_active, pp, global_rank, updated_at) values (?, ?, ?, ?, 1, ?, ?, ?)",
      [userId, first.username, `https://a.osu.ppy.sh/${userId}`, first.country, 1000, userId, now],
    );
    await exec(
      db,
      "insert or replace into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values (?, ?, ?, 'test', 1, ?)",
      [first.country, userId, 1, now],
    );
    const summary = {
      totalPlays: 500,
      analyzedPlays: 500,
      pendingPlays: 0,
      unsupportedPlays: 0,
      modes: modes.map((mode) => ({
        keyCount: mode.keyCount,
        analyzedPlays: mode.analyzedPlays,
        ratings: mode.ratings ?? {},
        patterns: mode.patterns ?? [],
        ...(mode.dan ? { dan: { rc: mode.dan.rc ?? null, ln: mode.dan.ln ?? null } } : {}),
      })),
    };
    await exec(
      db,
      `insert or replace into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
       values (?, ?, 'ready', ?, ?, ?, ?)`,
      [userId, PLAYER_SKILLS_VERSION, JSON.stringify(summary), JSON.stringify({ plays: [] }), now, now],
    );
  }
  resetSkillLeaderboardCache(db);
}

describe("leaderboardAxesFor", () => {
  it("gives 4K the MSD skillsets plus the grafted LN pattern axis", () => {
    const axes = leaderboardAxesFor(4);
    expect(axes).toContain("Chordjack");
    expect(axes).toContain("JackSpeed");
    expect(axes).toContain("pattern:ln");
    expect(axes).not.toContain("pattern:chordjack");
  });

  it("gives non-4K keymodes the pattern vocabulary only", () => {
    for (const keyCount of [6, 7]) {
      const axes = leaderboardAxesFor(keyCount);
      expect(axes).toContain("pattern:chordjack");
      expect(axes).toContain("pattern:chordstream");
      // MinaCalc's skillset names are 4K-born and unreliable elsewhere.
      expect(axes).not.toContain("Chordjack");
    }
  });

  it("leads every keymode with Overall, so the default board needs no specialty", () => {
    for (const keyCount of [4, 6, 7]) {
      expect(leaderboardAxesFor(keyCount)[0]).toBe("Overall");
    }
  });
});

describe("skill leaderboard", () => {
  const sevenKPlayers: SeedPlayer[] = [
    { userId: 11, username: "deep", country: "JP", keyCount: 7, analyzedPlays: 300, patterns: [{ id: "chordjack", rating: 30, plays: 200 }] },
    { userId: 12, username: "mid", country: "KR", keyCount: 7, analyzedPlays: 200, patterns: [{ id: "chordjack", rating: 28, plays: 60 }] },
    { userId: 13, username: "thin", country: "JP", keyCount: 7, analyzedPlays: 4, patterns: [{ id: "chordjack", rating: 26, plays: 4 }] },
    { userId: 14, username: "rice", country: "US", keyCount: 7, analyzedPlays: 120, patterns: [{ id: "tech", rating: 24, plays: 40 }] },
  ];

  it("ranks an axis descending, pages it, and reports evidence", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" });
      expect(board.total).toBe(3);
      expect(board.ranking.map((entry) => entry.user.username)).toEqual(["deep", "mid", "thin"]);
      expect(board.ranking[0].rank).toBe(1);
      expect(board.ranking[0].plays).toBe(200);
      expect(board.ranking[0].analyzedPlays).toBe(300);
      // No curves seeded, so nothing is shrunk and the payload says so.
      expect(board.shrunk).toBe(false);
      expect(board.ranking[0].value).toBe(30);

      const second = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack", page: 2, pageSize: 2 });
      expect(second.ranking.map((entry) => entry.user.username)).toEqual(["thin"]);
      expect(second.ranking[0].rank).toBe(3);
      expect(second.total).toBe(3);
    });
  });

  it("marks thin keymodes provisional at the same floor the profile uses", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" });
      const byName = new Map(board.ranking.map((entry) => [entry.user.username, entry]));
      expect(byName.get("deep")!.provisional).toBeUndefined();
      expect(byName.get("thin")!.provisional).toBe(true);
    });
  });

  it("publishes only axes that have a population, per scope", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const global = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" });
      const axes = new Map(global.axes.map((info) => [info.axis, info.players]));
      expect(axes.get("pattern:chordjack")).toBe(3);
      expect(axes.get("pattern:tech")).toBe(1);
      // Nobody has these, so the picker must never offer them.
      expect(axes.has("pattern:stream")).toBe(false);
      expect(axes.has("pattern:jack")).toBe(false);

      const us = await getSkillLeaderboard(db, { country: "US", keyCount: 7, axis: "pattern:tech" });
      const usAxes = new Map(us.axes.map((info) => [info.axis, info.players]));
      expect(usAxes.get("pattern:tech")).toBe(1);
      expect(usAxes.has("pattern:chordjack")).toBe(false);
    });
  });

  it("narrows to a country and a region and renumbers", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const jp = await getSkillLeaderboard(db, { country: "JP", keyCount: 7, axis: "pattern:chordjack" });
      expect(jp.ranking.map((entry) => entry.user.username)).toEqual(["deep", "thin"]);
      expect(jp.ranking.map((entry) => entry.rank)).toEqual([1, 2]);
      expect(jp.total).toBe(2);

      // R-EASIA covers JP and KR but not US.
      const region = await getSkillLeaderboard(db, { country: "R-EASIA", keyCount: 7, axis: "pattern:chordjack" });
      expect(region.ranking.map((entry) => entry.user.username)).toEqual(["deep", "mid", "thin"]);
    });
  });

  it("ranks the Overall aggregate on a non-4K keymode", async () => {
    await withDb(async (db) => {
      await seed(db, [
        { userId: 31, username: "a", country: "JP", keyCount: 7, analyzedPlays: 300, ratings: { Overall: 30 } },
        { userId: 32, username: "b", country: "JP", keyCount: 7, analyzedPlays: 300, ratings: { Overall: 26 } },
      ]);
      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "Overall" });
      expect(board.ranking.map((entry) => entry.user.username)).toEqual(["a", "b"]);
      expect(board.axes[0]).toEqual({ axis: "Overall", players: 2 });
    });
  });

  it("returns an empty board rather than throwing for an axis nobody has", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:bracket" });
      expect(board.ranking).toEqual([]);
      expect(board.total).toBe(0);
    });
  });

  it("prints the same shrunk rating the profile page serves", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      // A population wide enough for the curve builder's minimums, with one
      // deep pool and one thin pool that shrink must reorder.
      const players: SeedPlayer[] = [];
      for (let index = 0; index < 30; index += 1) {
        players.push({
          userId: 3000 + index,
          username: `pop${index}`,
          country: "CR",
          keyCount: 4,
          analyzedPlays: 100,
          ratings: { Overall: 20 + index * 0.1, Chordjack: 20 + index * 0.1 },
        });
      }
      players.push({ userId: 4001, username: "deepstack", country: "CR", keyCount: 4, analyzedPlays: 400, ratings: { Overall: 28, Chordjack: 28 } });
      players.push({ userId: 4002, username: "thinstack", country: "CR", keyCount: 4, analyzedPlays: 6, ratings: { Overall: 31, Chordjack: 31 } });
      await seed(db, players);
      await runSkillBaselineJob(db, queue, { runId: "board-run", cursor: 0 });
      resetSkillLeaderboardCache(db);

      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 4, axis: "Chordjack" });
      expect(board.shrunk).toBe(true);

      const byName = new Map(board.ranking.map((entry) => [entry.user.username, entry]));
      // The raw 31 loses to the raw 28 once evidence is priced in: that is the
      // whole reason the board ranks shrunk values.
      expect(byName.get("deepstack")!.rank).toBeLessThan(byName.get("thinstack")!.rank);

      for (const username of ["deepstack", "thinstack"]) {
        const entry = byName.get(username)!;
        const decorated = await decoratePlayerSkillBreakdown(db, entry.user.id, {
          status: "ready",
          version: PLAYER_SKILLS_VERSION,
          computedAt: new Date().toISOString(),
          totalPlays: entry.analyzedPlays,
          analyzedPlays: entry.analyzedPlays,
          pendingPlays: 0,
          unsupportedPlays: 0,
          modes: [
            {
              keyCount: 4,
              analyzedPlays: entry.analyzedPlays,
              ratings: { Overall: username === "deepstack" ? 28 : 31, Chordjack: username === "deepstack" ? 28 : 31 },
              patterns: [],
            },
          ],
        });
        expect(entry.value).toBeCloseTo(decorated.modes[0].ratings.Chordjack, 5);
      }
    });
  });

  it("shrinks a sparse axis too, and says so per axis rather than per board", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      /* Two 7K axes with very different populations: chordstream is wide
         enough to quantile, bracket sits under that floor but well over the
         median floor. The old board-wide flag reported `shrunk: true` for
         bracket off chordstream's curve while ranking bracket raw. */
      const players: SeedPlayer[] = [];
      for (let index = 0; index < 24; index += 1) {
        players.push({
          userId: 5000 + index,
          username: `wide${index}`,
          country: "CR",
          keyCount: 7,
          analyzedPlays: 100,
          patterns: [
            { id: "chordstream", rating: 20 + index * 0.1, plays: 60 },
            ...(index < 8 ? [{ id: "bracket", rating: 20 + index * 0.1, plays: 60 }] : []),
          ],
        });
      }
      players.push({ userId: 6001, username: "deepstack", country: "CR", keyCount: 7, analyzedPlays: 400, patterns: [{ id: "bracket", rating: 28, plays: 200 }] });
      players.push({ userId: 6002, username: "thinstack", country: "CR", keyCount: 7, analyzedPlays: 400, patterns: [{ id: "bracket", rating: 31, plays: 4 }] });
      await seed(db, players);
      await runSkillBaselineJob(db, queue, { runId: "sparse-run", cursor: 0 });
      resetSkillLeaderboardCache(db);

      const sparse = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:bracket" });
      expect(sparse.shrunk).toBe(true);
      const byName = new Map(sparse.ranking.map((entry) => [entry.user.username, entry]));
      // 200 plays at 28 beats 4 plays at 31 once the sparse axis shrinks too.
      expect(byName.get("deepstack")!.rank).toBeLessThan(byName.get("thinstack")!.rank);
      expect(byName.get("thinstack")!.value).toBeLessThan(31);
      // No curve behind it, so no percentile is claimed off a dozen players.
      expect(byName.get("thinstack")!.percentile).toBeUndefined();

      // The wide axis still quantiles, so it keeps its percentiles.
      const wide = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordstream" });
      expect(wide.shrunk).toBe(true);
      expect(wide.ranking[0].percentile).toBeGreaterThan(0);

      // An axis nobody rates has no median either, and admits it.
      const empty = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:delay" });
      expect(empty.shrunk).toBe(false);
    });
  });

  it("holds a failed rebuild for a retry window instead of rescanning per request", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const first = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" });
      expect(first.total).toBe(3);

      // Break the scan, then age the board out: the read answers stale.
      await exec(db, "drop table country_rosters");
      expireSkillLeaderboardBoard(db);
      const builds = skillLeaderboardBuildCount();
      const stale = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" });
      expect(stale.total).toBe(3);
      // Let the background rebuild fail and set its cooldown.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(skillLeaderboardBuildCount()).toBe(builds + 1);

      // Every read inside the cooldown is served from the stale board without
      // starting another doomed scan.
      for (let i = 0; i < 5; i += 1) {
        expect((await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" })).total).toBe(3);
      }
      expect(skillLeaderboardBuildCount()).toBe(builds + 1);
    });
  });

  it("holds a cold-start failure too, where there is no stale board to serve", async () => {
    await withDb(async (db) => {
      await exec(db, "drop table country_rosters");
      await expect(getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" })).rejects.toThrow();
      const builds = skillLeaderboardBuildCount();
      await expect(getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:chordjack" })).rejects.toThrow();
      expect(skillLeaderboardBuildCount()).toBe(builds);
    });
  });
});

describe("dan leaderboard", () => {
  const danPlayers: SeedPlayer[] = [
    { userId: 21, username: "top", country: "AR", keyCount: 4, analyzedPlays: 200, ratings: { Overall: 25 }, dan: { rc: { rawDan: 17.51, label: "eta", clears: 9 }, ln: { rawDan: 12.2, label: "12", clears: 4 } } },
    { userId: 22, username: "mid", country: "KR", keyCount: 4, analyzedPlays: 200, ratings: { Overall: 24 }, dan: { rc: { rawDan: 16.96, label: "eta", clears: 4 } } },
    { userId: 23, username: "capped", country: "CN", keyCount: 4, analyzedPlays: 200, ratings: { Overall: 23 }, dan: { rc: { rawDan: 18.4, label: "kappa", clears: 5, beyondTable: true } } },
    { userId: 24, username: "nodan", country: "KR", keyCount: 4, analyzedPlays: 200, ratings: { Overall: 22 } },
  ];

  it("ranks by raw dan and carries the label, play depth and ladder pin", async () => {
    await withDb(async (db) => {
      await seed(db, danPlayers);
      const board = await getDanLeaderboard(db, { country: "GLOBAL", keyCount: 4, side: "rc" });
      expect(board.ranking.map((entry) => entry.user.username)).toEqual(["capped", "top", "mid"]);
      expect(board.total).toBe(3);
      expect(board.ranking[0].beyondTable).toBe(true);
      expect(board.ranking[0].label).toBe("kappa");
      expect(board.ranking[1].rawDan).toBe(17.51);
      // No clear count on the wire: the stored one counts ties with the dan
      // level, so it reads 4 for nearly everyone. Play depth is the row's
      // secondary number instead.
      expect(board.ranking[1]).not.toHaveProperty("clears");
      // Nor a shrink flag: a dan is the level of a real clear, never shrunk.
      expect(board).not.toHaveProperty("shrunk");
      expect(board.ranking[1].analyzedPlays).toBe(200);
      // A player with no dan side is simply absent, not a zero row.
      expect(board.ranking.some((entry) => entry.user.username === "nodan")).toBe(false);
      expect(board.ranking[2].beyondTable).toBeUndefined();
    });
  });

  it("reports which sides have a population and narrows by scope", async () => {
    await withDb(async (db) => {
      await seed(db, danPlayers);
      const board = await getDanLeaderboard(db, { country: "GLOBAL", keyCount: 4, side: "ln" });
      expect(board.sides).toEqual([{ side: "rc", players: 3 }, { side: "ln", players: 1 }]);
      expect(board.ranking.map((entry) => entry.user.username)).toEqual(["top"]);

      const kr = await getDanLeaderboard(db, { country: "KR", keyCount: 4, side: "rc" });
      expect(kr.ranking.map((entry) => entry.user.username)).toEqual(["mid"]);
      expect(kr.sides).toEqual([{ side: "rc", players: 1 }]);
    });
  });
});
