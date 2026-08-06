import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { clearStreakMetricsCache, streakShardReward } from "../src/features/pack-games.js";
import {
  cashOutStreakRun,
  getStreakBoard,
  guessStreakRound,
  isStreakGuessCorrect,
  normalizeStreakPool,
  pickStreakMetric,
  removeStreakBest,
  startStreakRun,
  sweepAbandonedStreakRuns,
  STREAK_REVEAL_HOLD_MS,
  STREAK_ROUND_MS,
  type StreakGuess,
  type StreakRunView,
} from "../src/features/pack-streak.js";

// The blitz game's whole reason to exist is that the browser is not trusted
// with it, so these tests are about what the server refuses to take the
// client's word for: the answer, the clock, and whose run it is.

let dir = "";
let db: Db;

const NOW = 1_800_000_000_000;
const PLAYER = 4242;
const OTHER_PLAYER = 5353;
const POOL_SIZE = 40;

/* Play count and ranked score both climb with the user id, so whichever of the
   two questions a round happens to ask, the higher id is the higher number.
   That is what lets a test answer a round it did not deal. */
function playsOf(userId: number): number {
  return userId * 1000;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-streak-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  clearStreakMetricsCache();
  for (let userId = 1; userId <= POOL_SIZE; userId += 1) {
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, profile_json, updated_at)
       values (?, ?, ?, 'CR', ?, ?, ?, ?, ?)`,
      [
        userId,
        `player${userId}`,
        `https://a.ppy.sh/${userId}`,
        20000 - userId * 100,
        userId,
        userId,
        JSON.stringify({
          statistics: { play_count: playsOf(userId), ranked_score: playsOf(userId) * 10000 },
        }),
        new Date(NOW).toISOString(),
      ],
    );
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values ('CR', ?, ?, 'test', 1, ?)`,
      [userId, userId, new Date(NOW).toISOString()],
    );
  }
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/* The answer to the round on the table, worked out from the seed rather than
   from anything the server sent: the face-down number is exactly what the
   client is not given. */
function correctGuessFor(run: StreakRunView): StreakGuess {
  const round = run.round;
  if (!round) throw new Error("no round on the table");
  return playsOf(round.right.player.userId) > playsOf(round.left.player.userId) ? "more" : "less";
}

function wrongGuessFor(run: StreakRunView): StreakGuess {
  return correctGuessFor(run) === "more" ? "less" : "more";
}

async function startRun(now = NOW, seed = 7, pool: "top" | "anyone" = "top"): Promise<StreakRunView> {
  const run = await startStreakRun(db, {
    userId: PLAYER,
    username: "runner",
    pool,
    now,
    // The run id is drawn from this too, so two runs in one test need two
    // seeds or they collide on the primary key.
    rng: seededRng(seed),
  });
  if (!run) throw new Error("could not deal a run");
  return run;
}

async function walletShards(userId: number): Promise<number> {
  const row = (await exec(db, "select payload from pack_wallets where user_id = ?", [userId])).rows[0];
  return row ? Number(JSON.parse(String(row.payload)).shards) : 0;
}

describe("dealing a blitz round", () => {
  it("sends the face-up number and withholds the one being guessed at", async () => {
    const run = await startRun();
    expect(run.status).toBe("live");
    expect(run.streak).toBe(0);
    expect(run.round?.left.value).toBeGreaterThan(0);
    // The face-down card is a name and a rank. Its number is the question.
    expect(JSON.stringify(run.round?.right)).not.toContain("value");
    expect(run.round?.left.player.userId).not.toBe(run.round?.right.player.userId);
    // The opening deal carries the same hold later rounds get for their
    // reveal: this one is spent minting the two cards' art.
    expect(run.round?.deadlineAt).toBe(NOW + STREAK_ROUND_MS + STREAK_REVEAL_HOLD_MS);
  });

  it("carries the answered card over as the next round's face-up one", async () => {
    const run = await startRun();
    const previousRight = run.round!.right.player.userId;
    const next = await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: correctGuessFor(run),
      now: NOW + 2000,
      rng: seededRng(11),
    });
    expect(next?.correct).toBe(true);
    expect(next?.streak).toBe(1);
    expect(next?.round?.left.player.userId).toBe(previousRight);
    // The reveal is paid for on top of the thinking time, so the round that
    // lands mid-animation is still worth a full twelve seconds.
    expect(next?.round?.deadlineAt).toBe(NOW + 2000 + STREAK_ROUND_MS + STREAK_REVEAL_HOLD_MS);
    // The round just answered is revealed now that it has been paid for.
    expect(next?.revealed?.userId).toBe(previousRight);
  });

  it("never deals the same player twice in one run", async () => {
    let run = await startRun();
    const seen = new Set([run.round!.left.player.userId, run.round!.right.player.userId]);
    for (let round = 0; round < 8; round += 1) {
      const next = await guessStreakRound(db, {
        userId: PLAYER,
        runId: run.runId,
        guess: correctGuessFor(run),
        now: NOW + 1000 * (round + 1),
        rng: seededRng(20 + round),
      });
      if (!next?.round) break;
      expect(seen.has(next.round.right.player.userId)).toBe(false);
      seen.add(next.round.right.player.userId);
      run = next;
    }
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe("what ends a run", () => {
  it("ends on a wrong answer and pays the streak the server counted", async () => {
    let run = await startRun();
    for (let round = 0; round < 3; round += 1) {
      const next = await guessStreakRound(db, {
        userId: PLAYER,
        runId: run.runId,
        guess: correctGuessFor(run),
        now: NOW + 1000 * (round + 1),
        rng: seededRng(30 + round),
      });
      run = next!;
    }
    expect(run.streak).toBe(3);

    const lost = await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: wrongGuessFor(run),
      now: NOW + 5000,
    });
    expect(lost?.correct).toBe(false);
    expect(lost?.status).toBe("ended");
    expect(lost?.endedBy).toBe("wrong");
    expect(lost?.streak).toBe(3);
    expect(lost?.revealed?.value).toBeGreaterThan(0);
    expect(lost?.reward?.granted).toBe(streakShardReward(3));
    expect(await walletShards(PLAYER)).toBe(streakShardReward(3));
  });

  it("kills a late guess even when it was the right one", async () => {
    const run = await startRun();
    const late = await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: correctGuessFor(run),
      now: NOW + STREAK_ROUND_MS + 30_000,
    });
    expect(late?.expired).toBe(true);
    expect(late?.correct).toBe(false);
    expect(late?.status).toBe("ended");
    expect(late?.endedBy).toBe("timeout");
    expect(late?.streak).toBe(0);
  });

  it("lets a guess through inside the grace it allows for the wire", async () => {
    const run = await startRun();
    const justInTime = await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: correctGuessFor(run),
      now: NOW + STREAK_ROUND_MS + STREAK_REVEAL_HOLD_MS + 1000,
    });
    expect(justInTime?.expired).toBe(false);
    expect(justInTime?.streak).toBe(1);
  });

  it("banks a cash-out once, and pays nothing for cashing out again", async () => {
    let run = await startRun();
    for (let round = 0; round < 2; round += 1) {
      run = (await guessStreakRound(db, {
        userId: PLAYER,
        runId: run.runId,
        guess: correctGuessFor(run),
        now: NOW + 1000 * (round + 1),
        rng: seededRng(40 + round),
      }))!;
    }
    const banked = await cashOutStreakRun(db, { userId: PLAYER, runId: run.runId, now: NOW + 4000 });
    expect(banked?.endedBy).toBe("cashout");
    expect(banked?.reward?.granted).toBe(streakShardReward(2));

    const again = await cashOutStreakRun(db, { userId: PLAYER, runId: run.runId, now: NOW + 5000 });
    expect(again?.reward).toBeNull();
    expect(await walletShards(PLAYER)).toBe(streakShardReward(2));
  });

  it("closes and pays a run left hanging when the next one starts", async () => {
    let run = await startRun();
    run = (await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: correctGuessFor(run),
      now: NOW + 1000,
      rng: seededRng(51),
    }))!;

    const second = await startRun(NOW + 60_000, 99);
    expect(second.runId).not.toBe(run.runId);
    expect(second.streak).toBe(0);
    expect(await walletShards(PLAYER)).toBe(streakShardReward(1));

    const abandoned = (await exec(db, "select status, ended_by from pack_streak_runs where id = ?", [run.runId])).rows[0];
    expect(abandoned?.status).toBe("ended");
    expect(abandoned?.ended_by).toBe("abandoned");
  });

  it("will not let anyone play someone else's run", async () => {
    const run = await startRun();
    const stolen = await guessStreakRound(db, {
      userId: OTHER_PLAYER,
      runId: run.runId,
      guess: correctGuessFor(run),
      now: NOW + 1000,
    });
    expect(stolen).toBeNull();
    const live = (await exec(db, "select status from pack_streak_runs where id = ?", [run.runId])).rows[0];
    expect(live?.status).toBe("live");
  });

  it("does not score a run that has already ended", async () => {
    const run = await startRun();
    await cashOutStreakRun(db, { userId: PLAYER, runId: run.runId, now: NOW + 1000 });
    const after = await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: correctGuessFor(run),
      now: NOW + 2000,
    });
    expect(after?.status).toBe("ended");
    expect(after?.streak).toBe(0);
  });
});

describe("the board", () => {
  /* Seeds a finished run the way endRun leaves one: the run row for the
     record, and the account's best in the table the board actually reads. */
  async function seedRun(userId: number, username: string, pool: string, streak: number, at: number): Promise<void> {
    await exec(
      db,
      `insert into pack_streak_runs (id, user_id, username, pool, streak, status, ended_by, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'ended', 'wrong', ?, ?)`,
      [`run-${userId}-${pool}-${streak}`, userId, username, pool, streak, at, at],
    );
    await exec(
      db,
      `insert into pack_streak_bests (user_id, pool, username, streak, achieved_at, run_id, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(user_id, pool) do update set
         streak = excluded.streak, achieved_at = excluded.achieved_at, username = excluded.username
       where excluded.streak > pack_streak_bests.streak`,
      [userId, pool, username, streak, at, `run-${userId}-${pool}-${streak}`, at],
    );
  }

  it("keeps one row per account, their best, earliest first on a tie", async () => {
    await seedRun(1, "alpha", "top", 12, NOW);
    await seedRun(1, "alpha", "top", 30, NOW + 1000);
    await seedRun(2, "bravo", "top", 30, NOW + 500);
    await seedRun(3, "charlie", "top", 9, NOW);

    const board = await getStreakBoard(db, "top");
    expect(board.entries.map((entry) => entry.username)).toEqual(["bravo", "alpha", "charlie"]);
    expect(board.entries[0]?.rank).toBe(1);
    expect(board.entries[1]?.streak).toBe(30);
  });

  it("keeps the three pools apart", async () => {
    await seedRun(1, "alpha", "top", 20, NOW);
    await seedRun(2, "bravo", "anyone", 40, NOW);
    await seedRun(3, "charlie", "top500", 30, NOW);

    expect((await getStreakBoard(db, "top")).entries.map((entry) => entry.username)).toEqual(["alpha"]);
    expect((await getStreakBoard(db, "anyone")).entries.map((entry) => entry.username)).toEqual(["bravo"]);
    expect((await getStreakBoard(db, "top500")).entries.map((entry) => entry.username)).toEqual(["charlie"]);
  });

  it("names the pool a run was played in, and refuses anything else", () => {
    expect(normalizeStreakPool("top500")).toBe("top500");
    expect(normalizeStreakPool("anyone")).toBe("anyone");
    expect(normalizeStreakPool("top")).toBe("top");
    // Anything the client made up plays the middle pool rather than the
    // deepest one.
    expect(normalizeStreakPool("top50000")).toBe("top");
    expect(normalizeStreakPool(null)).toBe("top");
  });

  it("gives someone outside the top ten their real rank", async () => {
    for (let userId = 1; userId <= 12; userId += 1) {
      await seedRun(userId, `player${userId}`, "top", 100 - userId, NOW + userId);
    }
    const board = await getStreakBoard(db, "top", 12);
    expect(board.entries).toHaveLength(10);
    expect(board.entries.some((entry) => entry.userId === 12)).toBe(false);
    expect(board.viewer?.rank).toBe(12);
    expect(board.viewer?.streak).toBe(88);
  });

  it("reads the viewer off the board itself when they are on it", async () => {
    await seedRun(1, "alpha", "top", 20, NOW);
    const board = await getStreakBoard(db, "top", 1);
    expect(board.viewer?.rank).toBe(1);
    expect(board.viewer).toBe(board.entries[0]);
  });

  it("has nothing to say about an account that never finished a run", async () => {
    await seedRun(1, "alpha", "top", 20, NOW);
    expect((await getStreakBoard(db, "top", 99)).viewer).toBeNull();
  });

  it("takes one entry off the board without touching the account or the other pools", async () => {
    await seedRun(1, "alpha", "top", 30, NOW);
    await seedRun(1, "alpha", "top500", 12, NOW);
    await seedRun(2, "bravo", "top", 20, NOW);

    const removed = await removeStreakBest(db, { userId: 1, pool: "top" });
    expect(removed.removed).toBe(true);
    expect(removed.entry?.streak).toBe(30);
    // The evidence for the call goes with it, and only for that pool.
    expect(removed.runsDeleted).toBe(1);

    expect((await getStreakBoard(db, "top")).entries.map((entry) => entry.username)).toEqual(["bravo"]);
    expect((await getStreakBoard(db, "top500")).entries.map((entry) => entry.username)).toEqual(["alpha"]);
    expect((await getStreakBoard(db, "top", 1)).viewer).toBeNull();
  });

  it("lets a removed account set a new record straight away", async () => {
    await seedRun(1, "alpha", "top", 30, NOW);
    await removeStreakBest(db, { userId: 1, pool: "top" });
    // Nothing is remembered about the removal, so the next run stands on its
    // own rather than having to beat a record that is gone.
    await seedRun(1, "alpha", "top", 4, NOW + 5_000);
    const board = await getStreakBoard(db, "top");
    expect(board.entries.map((entry) => entry.streak)).toEqual([4]);
  });

  it("says nothing was removed when the account has no record in that pool", async () => {
    await seedRun(1, "alpha", "top", 30, NOW);
    const missing = await removeStreakBest(db, { userId: 1, pool: "anyone" });
    expect(missing).toEqual({ removed: false, entry: null, runsDeleted: 0 });
    expect((await getStreakBoard(db, "top")).entries).toHaveLength(1);
  });

  it("leaves a run that is still being played alone", async () => {
    await seedRun(1, "alpha", "top", 30, NOW);
    await exec(
      db,
      `insert into pack_streak_runs (id, user_id, username, pool, streak, status, dealt_at, deadline_at, created_at, updated_at)
       values ('live-run', 1, 'alpha', 'top', 3, 'live', ?, ?, ?, ?)`,
      [NOW, NOW + 12_000, NOW, NOW],
    );
    await removeStreakBest(db, { userId: 1, pool: "top" });
    const live = await exec(db, "select id from pack_streak_runs where status = 'live'");
    expect(live.rows).toHaveLength(1);
  });
});

describe("what the board is made of", () => {
  it("records a best when a run ends, and does not let a worse one replace it", async () => {
    let run = await startRun();
    for (let round = 0; round < 3; round += 1) {
      run = (await guessStreakRound(db, {
        userId: PLAYER,
        runId: run.runId,
        guess: correctGuessFor(run),
        now: NOW + 1000 * (round + 1),
        rng: seededRng(60 + round),
      }))!;
    }
    await cashOutStreakRun(db, { userId: PLAYER, runId: run.runId, now: NOW + 5000 });
    let board = await getStreakBoard(db, "top", PLAYER);
    expect(board.viewer?.streak).toBe(3);
    const firstAchievedAt = board.viewer?.achievedAt;

    // A shorter run later: the record stands, and so does when it was set.
    const second = await startRun(NOW + 60_000, 77);
    await cashOutStreakRun(db, { userId: PLAYER, runId: second.runId, now: NOW + 61_000 });
    board = await getStreakBoard(db, "top", PLAYER);
    expect(board.viewer?.streak).toBe(3);
    expect(board.viewer?.achievedAt).toBe(firstAchievedAt);
  });

  it("drops the draw's bookkeeping when a run ends, and keeps the timings", async () => {
    const run = await startRun();
    await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: wrongGuessFor(run),
      now: NOW + 1500,
    });
    const row = (await exec(db, "select seen_json, round_json, guess_ms_json from pack_streak_runs where id = ?", [run.runId])).rows[0];
    // The seen set and the round are spent; nothing can be drawn or answered.
    expect(row?.seen_json).toBeNull();
    expect(row?.round_json).toBeNull();
    // Whether that run was played by a human is still an open question.
    expect(row?.guess_ms_json).not.toBeNull();
  });

  it("closes a run somebody walked away from, so what it earned still counts", async () => {
    let run = await startRun();
    run = (await guessStreakRound(db, {
      userId: PLAYER,
      runId: run.runId,
      guess: correctGuessFor(run),
      now: NOW + 1000,
      rng: seededRng(81),
    }))!;
    // Nothing on the board while the run is still open.
    expect((await getStreakBoard(db, "top", PLAYER)).viewer).toBeNull();

    // Long enough past the deadline that it is not a browser mid-request.
    expect(await sweepAbandonedStreakRuns(db, NOW + 60 * 60 * 1000)).toBe(1);
    const board = await getStreakBoard(db, "top", PLAYER);
    expect(board.viewer?.streak).toBe(1);
    expect(await walletShards(PLAYER)).toBe(streakShardReward(1));

    // And it is not swept twice into a second payout.
    expect(await sweepAbandonedStreakRuns(db, NOW + 2 * 60 * 60 * 1000)).toBe(0);
    expect(await walletShards(PLAYER)).toBe(streakShardReward(1));
  });

  it("leaves a run whose clock only just ran out alone", async () => {
    const run = await startRun();
    expect(await sweepAbandonedStreakRuns(db, NOW + STREAK_ROUND_MS + 5_000)).toBe(0);
    const live = (await exec(db, "select status from pack_streak_runs where id = ?", [run.runId])).rows[0];
    expect(live?.status).toBe("live");
  });
});

describe("scoring rules", () => {
  it("scores a tie as a right answer", () => {
    expect(isStreakGuessCorrect("more", 100, 100)).toBe(true);
    expect(isStreakGuessCorrect("less", 100, 100)).toBe(true);
    expect(isStreakGuessCorrect("more", 100, 101)).toBe(true);
    expect(isStreakGuessCorrect("more", 100, 99)).toBe(false);
  });

  it("asks about something the two cards differ on when it can", () => {
    const left = { plays: 10, dtTop: 3 };
    const right = { plays: 20, dtTop: 3 };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(pickStreakMetric(left, right, seededRng(attempt))).toBe("plays");
    }
  });

  it("has no question for two cards with nothing in common", () => {
    expect(pickStreakMetric({ plays: 10 }, { dtTop: 4 }, seededRng(1))).toBeNull();
  });
});
