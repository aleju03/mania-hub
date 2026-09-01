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
  isDanLeaderboardKeyCount,
  isSkillLeaderboardKeyCount,
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
  dan?: {
    rc?: { rawDan: number; label: string; clears: number; beyondTable?: boolean; skillsets?: Record<string, { rawDan: number; label: string; clears: number }> };
    ln?: { rawDan: number; label: string; clears: number };
  };
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
  it("accepts 4K-18K for MSD while keeping dan on its three ladders", () => {
    for (let keyCount = 4; keyCount <= 18; keyCount += 1) {
      expect(isSkillLeaderboardKeyCount(keyCount)).toBe(true);
    }
    expect(isSkillLeaderboardKeyCount(3)).toBe(false);
    expect(isSkillLeaderboardKeyCount(19)).toBe(false);
    expect([4, 6, 7].every(isDanLeaderboardKeyCount)).toBe(true);
    expect([5, 8, 18].some(isDanLeaderboardKeyCount)).toBe(false);
  });

  it("gives 4K, 5K and 8K+ the MSD skillsets plus the grafted LN pattern axis", () => {
    for (const keyCount of [4, 5, 8, 10, 18]) {
      const axes = leaderboardAxesFor(keyCount);
      expect(axes).toContain("Chordjack");
      expect(axes).toContain("JackSpeed");
      expect(axes).toContain("pattern:ln");
      expect(axes).not.toContain("pattern:jack");
      expect(axes).not.toContain("pattern:chordjack");
    }
  });

  it("gives 6K and 7K the pattern vocabulary only", () => {
    for (const keyCount of [6, 7]) {
      const axes = leaderboardAxesFor(keyCount);
      expect(axes).toContain("pattern:jack");
      expect(axes).toContain("pattern:chordstream");
      // MinaCalc's skillset names are 4K-born and mislead on 6K/7K.
      expect(axes).not.toContain("Chordjack");
      // The jack tile absorbed chordjack; publishing both would rank the
      // same charts twice under two names.
      expect(axes).not.toContain("pattern:chordjack");
    }
  });

  it("leads every keymode with Overall, so the default board needs no specialty", () => {
    for (let keyCount = 4; keyCount <= 18; keyCount += 1) {
      expect(leaderboardAxesFor(keyCount)[0]).toBe("Overall");
    }
  });
});

describe("skill leaderboard", () => {
  const sevenKPlayers: SeedPlayer[] = [
    { userId: 11, username: "deep", country: "JP", keyCount: 7, analyzedPlays: 300, patterns: [{ id: "jack", rating: 30, plays: 200 }] },
    { userId: 12, username: "mid", country: "KR", keyCount: 7, analyzedPlays: 200, patterns: [{ id: "jack", rating: 28, plays: 60 }] },
    { userId: 13, username: "thin", country: "JP", keyCount: 7, analyzedPlays: 4, patterns: [{ id: "jack", rating: 26, plays: 4 }] },
    { userId: 14, username: "rice", country: "US", keyCount: 7, analyzedPlays: 120, patterns: [{ id: "tech", rating: 24, plays: 40 }] },
  ];

  it("ranks an axis descending, pages it, and reports evidence", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" });
      expect(board.total).toBe(3);
      expect(board.ranking.map((entry) => entry.user.username)).toEqual(["deep", "mid", "thin"]);
      expect(board.ranking[0].rank).toBe(1);
      expect(board.ranking[0].plays).toBe(200);
      expect(board.ranking[0].analyzedPlays).toBe(300);
      expect(board.keyCounts).toEqual([7]);
      // No curves seeded, so nothing is shrunk and the payload says so.
      expect(board.shrunk).toBe(false);
      expect(board.ranking[0].value).toBe(30);

      const second = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack", page: 2, pageSize: 2 });
      expect(second.ranking.map((entry) => entry.user.username)).toEqual(["thin"]);
      expect(second.ranking[0].rank).toBe(3);
      expect(second.total).toBe(3);
    });
  });

  it("marks thin keymodes provisional at the same floor the profile uses", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" });
      const byName = new Map(board.ranking.map((entry) => [entry.user.username, entry]));
      expect(byName.get("deep")!.provisional).toBeUndefined();
      expect(byName.get("thin")!.provisional).toBe(true);
    });
  });

  it("publishes only axes that have a population, per scope", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const global = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" });
      const axes = new Map(global.axes.map((info) => [info.axis, info.players]));
      expect(axes.get("pattern:jack")).toBe(3);
      expect(axes.get("pattern:tech")).toBe(1);
      // Nobody has these, so the picker must never offer them.
      expect(axes.has("pattern:stream")).toBe(false);
      expect(axes.has("pattern:chordjack")).toBe(false);

      const us = await getSkillLeaderboard(db, { country: "US", keyCount: 7, axis: "pattern:tech" });
      const usAxes = new Map(us.axes.map((info) => [info.axis, info.players]));
      expect(usAxes.get("pattern:tech")).toBe(1);
      expect(usAxes.has("pattern:chordjack")).toBe(false);
    });
  });

  it("narrows to a country and a region and renumbers", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      const jp = await getSkillLeaderboard(db, { country: "JP", keyCount: 7, axis: "pattern:jack" });
      expect(jp.ranking.map((entry) => entry.user.username)).toEqual(["deep", "thin"]);
      expect(jp.ranking.map((entry) => entry.rank)).toEqual([1, 2]);
      expect(jp.total).toBe(2);

      // R-EASIA covers JP and KR but not US.
      const region = await getSkillLeaderboard(db, { country: "R-EASIA", keyCount: 7, axis: "pattern:jack" });
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

  it("builds boards for the newly supported keymodes", async () => {
    await withDb(async (db) => {
      await seed(db, [
        // 10K and 18K publish MinaCalc's own skillsets, like 4K: a stored
        // pattern rating stays off the board there.
        { userId: 51, username: "ten", country: "JP", keyCount: 10, analyzedPlays: 80, ratings: { Overall: 23, Handstream: 22 }, patterns: [{ id: "stream", rating: 22, plays: 40 }] },
        { userId: 52, username: "eighteen", country: "KR", keyCount: 18, analyzedPlays: 60, ratings: { Overall: 21, Chordjack: 20 }, patterns: [{ id: "jack", rating: 20, plays: 30 }] },
      ]);

      const ten = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 10, axis: "Overall" });
      expect(ten.ranking.map((entry) => entry.user.username)).toEqual(["ten"]);
      expect(ten.axes).toContainEqual({ axis: "Handstream", players: 1 });
      expect(ten.axes.map((entry) => entry.axis)).not.toContain("pattern:stream");
      expect(ten.keyCounts).toEqual([10, 18]);

      const eighteen = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 18, axis: "Chordjack" });
      expect(eighteen.ranking.map((entry) => entry.user.username)).toEqual(["eighteen"]);
    });
  });

  it("publishes only keymodes with a rated player in the requested scope", async () => {
    await withDb(async (db) => {
      await seed(db, [
        { userId: 61, username: "four", country: "JP", keyCount: 4, analyzedPlays: 80, ratings: { Overall: 24 } },
        { userId: 62, username: "ten", country: "KR", keyCount: 10, analyzedPlays: 60, ratings: { Overall: 20 } },
        // A stored mode without a publishable rating must not create a chip.
        { userId: 63, username: "empty", country: "US", keyCount: 18, analyzedPlays: 40 },
      ]);

      const global = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 4, axis: "Overall" });
      expect(global.keyCounts).toEqual([4, 10]);

      const jp = await getSkillLeaderboard(db, { country: "JP", keyCount: 4, axis: "Overall" });
      expect(jp.keyCounts).toEqual([4]);

      const us = await getSkillLeaderboard(db, { country: "US", keyCount: 18, axis: "Overall" });
      expect(us.keyCounts).toEqual([]);
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
      const first = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" });
      expect(first.total).toBe(3);

      // Break the scan, then age the board out: the read answers stale.
      await exec(db, "drop table country_rosters");
      expireSkillLeaderboardBoard(db);
      const builds = skillLeaderboardBuildCount();
      const stale = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" });
      expect(stale.total).toBe(3);
      // Let the background rebuild fail and set its cooldown.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(skillLeaderboardBuildCount()).toBe(builds + 1);

      // Every read inside the cooldown is served from the stale board without
      // starting another doomed scan.
      for (let i = 0; i < 5; i += 1) {
        expect((await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" })).total).toBe(3);
      }
      expect(skillLeaderboardBuildCount()).toBe(builds + 1);
    });
  });

  it("holds a cold-start failure too, where there is no stale board to serve", async () => {
    await withDb(async (db) => {
      await exec(db, "drop table country_rosters");
      await expect(getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" })).rejects.toThrow();
      const builds = skillLeaderboardBuildCount();
      await expect(getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" })).rejects.toThrow();
      expect(skillLeaderboardBuildCount()).toBe(builds);
    });
  });

  it("keeps superseded-version rows on the board until their recompute lands", async () => {
    await withDb(async (db) => {
      await seed(db, sevenKPlayers);
      // A version bump leaves most of the roster on the old version. Their
      // rows must keep ranking; a player with both versions ready (the brief
      // window before the compute deletes the old row) counts once, at the
      // newer numbers.
      await exec(
        db,
        "update player_skill_ratings set analysis_version = ? where user_id in (12, 13, 14)",
        [PLAYER_SKILLS_VERSION - 1],
      );
      const now = new Date().toISOString();
      const upgraded = {
        totalPlays: 500,
        analyzedPlays: 500,
        pendingPlays: 0,
        unsupportedPlays: 0,
        modes: [{ keyCount: 7, analyzedPlays: 220, ratings: {}, patterns: [{ id: "jack", rating: 31, plays: 210 }] }],
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (12, ?, 'ready', ?, '{"plays":[]}', ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify(upgraded), now, now],
      );
      resetSkillLeaderboardCache(db);

      const board = await getSkillLeaderboard(db, { country: "GLOBAL", keyCount: 7, axis: "pattern:jack" });
      expect(board.total).toBe(3);
      expect(board.ranking.map((entry) => entry.user.username)).toEqual(["mid", "deep", "thin"]);
      expect(board.ranking[0].value).toBeCloseTo(31, 5);
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

  it("ranks a skillset column off the stored bucket verdicts", async () => {
    await withDb(async (db) => {
      await seed(db, [
        // "mid" is the weaker player overall but the stronger jack player, so a
        // skillset column that merely re-sorted the side's dan would not move.
        { userId: 41, username: "top", country: "AR", keyCount: 4, analyzedPlays: 200, dan: { rc: { rawDan: 17.51, label: "eta", clears: 9, skillsets: { jack: { rawDan: 14, label: "delta", clears: 4 }, tech: { rawDan: 17, label: "eta", clears: 5 } } } } },
        { userId: 42, username: "mid", country: "KR", keyCount: 4, analyzedPlays: 200, dan: { rc: { rawDan: 16.96, label: "eta", clears: 4, skillsets: { jack: { rawDan: 16, label: "zeta", clears: 4 } } } } },
        // No skillsets at all: a row written before the verdicts shipped, and
        // it must stay on the every-clear board rather than vanish from it.
        { userId: 43, username: "legacy", country: "KR", keyCount: 4, analyzedPlays: 200, dan: { rc: { rawDan: 17.2, label: "eta", clears: 4 } } },
      ]);

      const jack = await getDanLeaderboard(db, { country: "GLOBAL", keyCount: 4, side: "rc", skillset: "jack" });
      expect(jack.skillset).toBe("jack");
      expect(jack.ranking.map((entry) => entry.user.username)).toEqual(["mid", "top"]);
      expect(jack.ranking[0].rawDan).toBe(16);
      expect(jack.ranking[0].label).toBe("zeta");
      expect(jack.total).toBe(2);

      const overall = await getDanLeaderboard(db, { country: "GLOBAL", keyCount: 4, side: "rc" });
      expect(overall.skillset).toBe("overall");
      expect(overall.ranking.map((entry) => entry.user.username)).toEqual(["top", "legacy", "mid"]);

      // Only columns with a population, in publication order, and the side
      // counts stay the side's own rather than the selected column's.
      expect(jack.skillsets).toEqual([
        { skillset: "overall", players: 3 },
        { skillset: "jack", players: 2 },
        { skillset: "tech", players: 1 },
      ]);
      expect(jack.sides).toEqual([{ side: "rc", players: 3 }]);

      // A column this ladder does not publish falls back to every clear rather
      // than serving an empty board.
      const stream = await getDanLeaderboard(db, { country: "GLOBAL", keyCount: 4, side: "rc", skillset: "stream" });
      expect(stream.skillset).toBe("overall");
      expect(stream.total).toBe(3);
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
