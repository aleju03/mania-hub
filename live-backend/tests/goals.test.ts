import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import {
  createUserGoal,
  deleteUserGoal,
  evaluatePpGoals,
  evaluateScoreGoals,
  getUserGoal,
  listUserGoals,
  listUserGoalsWithProgress,
  reconcileGoalsForUser,
  reconcilePpGoalsForUser,
  reconcileStatGoalsForCountry,
  refreshGoalUserIndex,
  updateUserGoal,
} from "../src/features/goals.js";
import type { OscScore } from "../src/shared/types.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;
let baseScore: OscScore;

const USER = 101;
const MAP = 501;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-goals-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
  // Reset the module-level "who has open goals" negative cache to this fresh (empty) db so state
  // never leaks between cases. createUserGoal then re-populates it via noteGoalUserActive.
  await refreshGoalUserIndex(db);
  const scores = JSON.parse(await readFile(new URL("../fixtures/scores.json", import.meta.url), "utf8")) as OscScore[];
  // fixture[0] is a lazer mania pass: user 101, beatmap 501, acc 0.987, rank S, pp 252.4.
  baseScore = scores[0];
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function scoreWith(overrides: Partial<OscScore>): OscScore {
  return { ...baseScore, user_id: USER, beatmap_id: MAP, ...overrides };
}

async function goalCompletedEvents(): Promise<number> {
  return (await exec(db, "select count(*) as n from live_event_log where type = 'goal_completed'")).rows[0]?.n as number;
}

async function insertScoreEvent(score: OscScore, country = "CR", identity = `test:${score.id}`): Promise<void> {
  const endedAt = score.ended_at ?? "2026-01-01T00:00:00Z";
  await exec(
    db,
    `insert into score_events
       (score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      score.id,
      identity,
      score.legacy_score_id ?? null,
      score.user_id,
      country,
      score.beatmap_id ?? score.beatmap?.id ?? MAP,
      score.ruleset_id ?? 3,
      JSON.stringify(score),
      score.pp,
      score.total_score ?? score.score,
      score.accuracy,
      score.rank,
      score.passed ? 1 : 0,
      score.processed ? 1 : 0,
      1,
      score.has_replay || score.replay ? 1 : 0,
      endedAt,
      endedAt,
      "test",
    ],
  );
}

describe("accuracy goals", () => {
  it("completes the instant a passed score clears the target", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.96 });
    await evaluateScoreGoals(db, events, scoreWith({ accuracy: 0.987, passed: true, rank: "S" }), ["CR"]);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedValue).toBeCloseTo(0.987, 3);
    expect(done?.completedScoreId).toBeTruthy();
    expect(done?.completedAt).toBeGreaterThan(0);
    expect(await goalCompletedEvents()).toBe(1);
  });

  it("stays open when the score is below the target", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.99 });
    await evaluateScoreGoals(db, events, scoreWith({ accuracy: 0.987, passed: true }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });

  it("ignores scores on a different beatmap", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.5 });
    await evaluateScoreGoals(db, events, scoreWith({ beatmap_id: 999, accuracy: 1, passed: true }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });

  it("requires a passed score even if accuracy is high mid-map", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.9 });
    await evaluateScoreGoals(db, events, scoreWith({ accuracy: 0.99, passed: false, rank: "F" }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });

  it("does not complete a plain map goal from a Daycore score", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.95 });
    await evaluateScoreGoals(
      db,
      events,
      scoreWith({ id: 9101, accuracy: 0.9618, passed: true, rank: "S", mods: [{ acronym: "DC", settings: { speed_change: 0.9 } }] }),
      ["CR"],
    );
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");

    await evaluateScoreGoals(db, events, scoreWith({ id: 9102, accuracy: 0.951, passed: true, rank: "S", mods: [] }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("completed");
  });

  it("lets a map goal target the HT speed bucket", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.95, speedBucket: "ht" });
    await evaluateScoreGoals(db, events, scoreWith({ id: 9111, accuracy: 0.99, passed: true, rank: "S", mods: [] }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");

    await evaluateScoreGoals(db, events, scoreWith({ id: 9112, accuracy: 0.961, passed: true, rank: "S", mods: [{ acronym: "HT" }] }), ["CR"]);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.speedBucket).toBe("ht");
  });
});

describe("pass goals", () => {
  it("completes on the first passed score on the map", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "pass", beatmapId: MAP });
    await evaluateScoreGoals(db, events, scoreWith({ passed: true }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("completed");
  });

  it("stays open on a fail", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "pass", beatmapId: MAP });
    await evaluateScoreGoals(db, events, scoreWith({ passed: false, rank: "F" }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });
});

describe("fc goals", () => {
  it("completes on a passed score with no misses", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "fc", beatmapId: MAP });
    await evaluateScoreGoals(db, events, scoreWith({ passed: true, statistics: { count_miss: 0 } }), ["CR"]);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedBeatmapId).toBe(MAP);
  });

  it("stays open when the passed score has misses", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "fc", beatmapId: MAP });
    await evaluateScoreGoals(db, events, scoreWith({ passed: true, statistics: { count_miss: 3 } }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });

  it("stays open on a no-miss fail", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "fc", beatmapId: MAP });
    await evaluateScoreGoals(db, events, scoreWith({ passed: false, rank: "F", statistics: { count_miss: 0 } }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });

  it("ignores a no-miss pass on a different beatmap", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "fc", beatmapId: MAP });
    await evaluateScoreGoals(db, events, scoreWith({ beatmap_id: 999, passed: true, statistics: { count_miss: 0 } }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });
});

describe("grade goals", () => {
  it("completes when the achieved grade meets or beats the target", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "grade", beatmapId: MAP, targetGrade: "A" });
    await evaluateScoreGoals(db, events, scoreWith({ passed: true, rank: "S" }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("completed");
  });

  it("treats SS as strictly above S", async () => {
    const ssGoal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "grade", beatmapId: MAP, targetGrade: "SS" });
    await evaluateScoreGoals(db, events, scoreWith({ passed: true, rank: "S" }), ["CR"]);
    expect((await getUserGoal(db, ssGoal.id))?.status).toBe("open");
    await evaluateScoreGoals(db, events, scoreWith({ passed: true, rank: "X" }), ["CR"]);
    expect((await getUserGoal(db, ssGoal.id))?.status).toBe("completed");
  });
});

describe("play pp goals", () => {
  it("completes when a single play clears the pp target", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 200 });
    await evaluateScoreGoals(db, events, scoreWith({ pp: 252.4, passed: true }), ["CR"]);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedValue).toBeCloseTo(252.4, 1);
    expect(done?.completedBeatmapId).toBe(MAP);
  });

  it("stays open below the target and for unranked (null pp) plays", async () => {
    const below = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 300 });
    const nullPp = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 50 });
    await evaluateScoreGoals(db, events, scoreWith({ pp: null as unknown as number, passed: true }), ["CR"]);
    expect((await getUserGoal(db, below.id))?.status).toBe("open");
    expect((await getUserGoal(db, nullPp.id))?.status).toBe("open");
  });

  it("does not complete from older stored top scores", async () => {
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [USER, 777, 0, JSON.stringify(scoreWith({ id: 777, pp: 252.4, passed: true })), 252.4, 252.4, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 200 });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });
});

describe("play pp progress", () => {
  it("reports the best play from the profile snapshot, not just live-tracked plays", async () => {
    // PB (927) lives in the cached profile best-100; a smaller live play (798) is all score_events
    // knows about. The "best so far" hint must reflect the real PB.
    await exec(
      db,
      `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER,
        "tester",
        "{}",
        JSON.stringify([scoreWith({ id: 555, pp: 927, passed: true }), scoreWith({ id: 556, pp: 700, passed: true })]),
        100,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      ],
    );
    await evaluateScoreGoals(db, events, scoreWith({ id: 999, pp: 798, passed: true }), ["CR"]);
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 1000 });
    const withProgress = (await listUserGoalsWithProgress(db, USER)).find((g) => g.id === goal.id);
    expect(withProgress?.progress?.current).toBeCloseTo(927, 0);
  });
});

describe("pp play count goals", () => {
  it("completes when a fresh qualifying score reaches the count target", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp_count", targetValue: 200, targetCount: 1 });
    await evaluateScoreGoals(db, events, scoreWith({ pp: 252.4, passed: true }), ["CR"]);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedValue).toBe(1);
  });

  it("reconciles against stored top scores", async () => {
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER, 777, 0, JSON.stringify(scoreWith({ id: 777, pp: 640, passed: true })), 640, 640, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z",
        USER, 778, 1, JSON.stringify(scoreWith({ id: 778, pp: 615, passed: true })), 615, 584.25, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z",
        USER, 779, 2, JSON.stringify(scoreWith({ id: 779, pp: 590, passed: true })), 590, 532.48, "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z",
      ],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp_count", targetValue: 600, targetCount: 2 });
    await reconcileGoalsForUser(db, events, USER);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedValue).toBe(2);
  });

  it("stays open while the known count is below target", async () => {
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [USER, 777, 0, JSON.stringify(scoreWith({ id: 777, pp: 640, passed: true })), 640, 640, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp_count", targetValue: 600, targetCount: 2 });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });
});

describe("reach pp goals", () => {
  it("completes when observed overall pp crosses the target", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_pp", targetValue: 5000 });
    await evaluatePpGoals(db, events, USER, 4000, "CR");
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
    await evaluatePpGoals(db, events, USER, 5200, "CR");
    expect((await getUserGoal(db, goal.id))?.status).toBe("completed");
  });

  it("a score-shaped evaluation never touches reach_pp goals", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_pp", targetValue: 1 });
    await evaluateScoreGoals(db, events, scoreWith({ pp: 9999, passed: true }), ["CR"]);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });

  it("reconciles against the stored overall pp lazily", async () => {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
      [USER, "tester", "https://a.ppy.sh/101", "CR", 6000, new Date().toISOString()],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_pp", targetValue: 5500 });
    await reconcilePpGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, goal.id))?.status).toBe("completed");
  });
});

describe("reach rank goals", () => {
  async function seedUser(globalRank: number, countryRank: number): Promise<void> {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      [USER, "tester", "https://a.ppy.sh/101", "CR", 6000, globalRank, countryRank, new Date().toISOString()],
    );
  }

  it("completes when the global rank reaches the target", async () => {
    await seedUser(480, 3);
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_rank", targetValue: 500, targetGrade: "global" });
    await reconcileGoalsForUser(db, events, USER);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedValue).toBe(480);
  });

  it("reads the country leaderboard when the scope is country", async () => {
    await seedUser(9000, 1);
    const globalGoal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_rank", targetValue: 500, targetGrade: "global" });
    const countryGoal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_rank", targetValue: 1, targetGrade: "country" });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, globalGoal.id))?.status).toBe("open"); // #9000 global is short of #500
    expect((await getUserGoal(db, countryGoal.id))?.status).toBe("completed"); // but country #1 clears
  });

  it("stays open while the rank is worse than the target", async () => {
    await seedUser(1200, 5);
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_rank", targetValue: 1000, targetGrade: "global" });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });
});

describe("roster-refresh stat goal reconcile", () => {
  async function seedRosterUser(country = "CR"): Promise<void> {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      [USER, "tester", "https://a.ppy.sh/101", country, 6000, 480, 3, new Date().toISOString()],
    );
    await exec(
      db,
      "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values (?, ?, 3, 'osu_rankings', 1, ?)",
      [country, USER, new Date().toISOString()],
    );
  }

  it("settles reach_pp and reach_rank goals for the country's roster members", async () => {
    await seedRosterUser();
    const ppGoal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_pp", targetValue: 5500 });
    const rankGoal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_rank", targetValue: 500, targetGrade: "global" });
    const mapGoal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "pass", beatmapId: MAP });
    await reconcileStatGoalsForCountry(db, events, "CR");
    expect((await getUserGoal(db, ppGoal.id))?.status).toBe("completed");
    expect((await getUserGoal(db, rankGoal.id))?.status).toBe("completed");
    // Map goals settle from the score pipeline, not the roster refresh.
    expect((await getUserGoal(db, mapGoal.id))?.status).toBe("open");
    expect(await goalCompletedEvents()).toBe(2);
  });

  it("ignores goal owners outside the refreshed country's roster", async () => {
    await seedRosterUser("CR");
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_pp", targetValue: 5500 });
    await reconcileStatGoalsForCountry(db, events, "US");
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });
});

describe("goal crud", () => {
  it("lists open goals before completed and only for the owner", async () => {
    // A goal on a different map stays open; the play_pp goal is completed by the score below.
    await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "pass", beatmapId: 999 });
    const completed = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 100 });
    await createUserGoal(db, queue, { userId: 202, country: "CR", kind: "pass", beatmapId: MAP });
    await evaluateScoreGoals(db, events, scoreWith({ pp: 252.4, passed: true }), ["CR"]);

    const mine = await listUserGoals(db, USER);
    expect(mine).toHaveLength(2);
    expect(mine[0].status).toBe("open"); // open sorts first
    expect(mine.some((g) => g.id === completed.id && g.status === "completed")).toBe(true);
    expect(mine.every((g) => g.userId === USER)).toBe(true);
  });

  it("edits an open goal's target while keeping the progress baseline", async () => {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
      [USER, "tester", "https://a.ppy.sh/101", "CR", 6000, new Date().toISOString()],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_pp", targetValue: 7000 });
    expect(goal.startValue).toBe(6000);
    const updated = await updateUserGoal(db, USER, goal.id, { targetValue: 8000 });
    expect(updated?.targetValue).toBe(8000);
    expect(updated?.startValue).toBe(6000); // baseline survives a plain target edit
    expect(updated?.status).toBe("open");
  });

  it("rejects edits by non-owners and on completed goals", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 200 });
    expect(await updateUserGoal(db, 999, goal.id, { targetValue: 300 })).toBeNull();
    await evaluateScoreGoals(db, events, scoreWith({ pp: 252.4, passed: true }), ["CR"]);
    expect(await updateUserGoal(db, USER, goal.id, { targetValue: 300 })).toBeNull();
    expect((await getUserGoal(db, goal.id))?.targetValue).toBe(200);
  });

  it("recomputes the rank baseline when the leaderboard scope changes", async () => {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      [USER, "tester", "https://a.ppy.sh/101", "CR", 6000, 480, 3, new Date().toISOString()],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_rank", targetValue: 400, targetGrade: "global" });
    expect(goal.startValue).toBe(480);
    const updated = await updateUserGoal(db, USER, goal.id, { targetValue: 2, targetGrade: "country" });
    expect(updated?.targetGrade).toBe("country");
    expect(updated?.startValue).toBe(3); // global baseline is meaningless on the country board
  });

  it("recomputes the accuracy baseline when the speed bucket changes", async () => {
    await insertScoreEvent(scoreWith({ id: 9501, accuracy: 0.97, rank: "S", passed: true, mods: [] }));
    await insertScoreEvent(scoreWith({ id: 9502, accuracy: 0.93, rank: "A", passed: true, mods: [{ acronym: "DT" }] }));
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.98 });
    expect(goal.startValue).toBeCloseTo(0.97, 3);
    const updated = await updateUserGoal(db, USER, goal.id, { targetValue: 0.98, speedBucket: "dt" });
    expect(updated?.speedBucket).toBe("dt");
    expect(updated?.startValue).toBeCloseTo(0.93, 3);
  });

  it("completes on the next reconcile when the target is edited below the current value", async () => {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, ?, ?, ?, ?)",
      [USER, "tester", "https://a.ppy.sh/101", "CR", 6000, new Date().toISOString()],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "reach_pp", targetValue: 9000 });
    await updateUserGoal(db, USER, goal.id, { targetValue: 5500 });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, goal.id))?.status).toBe("completed");
  });

  it("deletes only the owner's goal", async () => {
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "pass", beatmapId: MAP });
    expect(await deleteUserGoal(db, 999, goal.id)).toBe(false);
    expect(await getUserGoal(db, goal.id)).not.toBeNull();
    expect(await deleteUserGoal(db, USER, goal.id)).toBe(true);
    expect(await getUserGoal(db, goal.id)).toBeNull();
    expect(await deleteUserGoal(db, USER, "missing")).toBe(false);
  });
});

describe("historical goal reconciliation", () => {
  it("does not complete map goals from mod-blind stored activity", async () => {
    await exec(
      db,
      `insert into player_activity_maps
       (country, user_id, day, beatmap_id, play_count, best_accuracy, best_rank, first_played_at, last_played_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["CR", USER, "2026-01-01", MAP, 1, 0.9825, "S", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    );
    const accuracy = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.98 });
    const grade = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "grade", beatmapId: MAP, targetGrade: "A" });
    const pass = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "pass", beatmapId: MAP });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, accuracy.id))?.status).toBe("open");
    expect((await getUserGoal(db, grade.id))?.status).toBe("open");
    expect((await getUserGoal(db, pass.id))?.status).toBe("open");
  });

  it("completes map goals from stored base-rate score events", async () => {
    await insertScoreEvent(scoreWith({ id: 9201, accuracy: 0.9825, rank: "S", passed: true, mods: [] }));
    const accuracy = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.98 });
    const grade = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "grade", beatmapId: MAP, targetGrade: "A" });
    const pass = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "pass", beatmapId: MAP });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, accuracy.id))?.status).toBe("completed");
    expect((await getUserGoal(db, grade.id))?.status).toBe("completed");
    expect((await getUserGoal(db, pass.id))?.status).toBe("completed");
  });

  it("does not complete map goals from stored rate-changed score events", async () => {
    await insertScoreEvent(
      scoreWith({ id: 9301, accuracy: 0.9618, rank: "S", passed: true, mods: [{ acronym: "DC", settings: { speed_change: 0.9 } }] }),
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.95 });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, goal.id))?.status).toBe("open");
  });

  it("completes stored HT speed-bucket map goals from stored HT score events", async () => {
    await insertScoreEvent(scoreWith({ id: 9351, accuracy: 0.9618, rank: "S", passed: true, mods: [{ acronym: "HT" }] }));
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.95, speedBucket: "ht" });
    await reconcileGoalsForUser(db, events, USER);
    expect((await getUserGoal(db, goal.id))?.status).toBe("completed");
  });

  it("reopens a completed map goal when its retained completion score was rate-changed", async () => {
    await insertScoreEvent(
      scoreWith({ id: 9401, accuracy: 0.9618, rank: "S", passed: true, mods: [{ acronym: "DC", settings: { speed_change: 0.9 } }] }),
      "CR",
      "bad-completion",
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "accuracy", beatmapId: MAP, targetValue: 0.95 });
    await exec(
      db,
      `update user_goals
       set status = 'completed', completed_at = ?, completed_value = ?, completed_score_id = ?, completed_beatmap_id = ?, updated_at = ?
       where id = ?`,
      [Date.now(), 0.9618, "bad-completion", MAP, Date.now(), goal.id],
    );

    await reconcileGoalsForUser(db, events, USER);
    const reopened = await getUserGoal(db, goal.id);
    expect(reopened?.status).toBe("open");
    expect(reopened?.completedScoreId).toBeNull();
    expect(reopened?.completedValue).toBeNull();
  });
});

describe("open-goal index gating", () => {
  it("skips users absent from the loaded index until it is refreshed", async () => {
    // Insert a goal directly, bypassing noteGoalUserActive, while the index is loaded-and-empty.
    const now = Date.now();
    await exec(
      db,
      "insert into user_goals (id, user_id, country, kind, beatmap_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, 'open', ?, ?)",
      ["raw-goal", USER, "CR", "pass", MAP, now, now],
    );
    await evaluateScoreGoals(db, events, scoreWith({ passed: true }), ["CR"]);
    expect((await getUserGoal(db, "raw-goal"))?.status).toBe("open"); // gated out

    await refreshGoalUserIndex(db);
    await evaluateScoreGoals(db, events, scoreWith({ passed: true }), ["CR"]);
    expect((await getUserGoal(db, "raw-goal"))?.status).toBe("completed");
  });

  it("refreshes the loaded index when another process bumps the goal version", async () => {
    const now = Date.now();
    await exec(
      db,
      "insert into user_goals (id, user_id, country, kind, beatmap_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, 'open', ?, ?)",
      ["split-goal", USER, "CR", "pass", MAP, now, now],
    );
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      ["user_goals_changed_at", JSON.stringify(now), "2026-01-01T00:00:00Z"],
    );
    await evaluateScoreGoals(db, events, scoreWith({ passed: true }), ["CR"]);
    expect((await getUserGoal(db, "split-goal"))?.status).toBe("completed");
  });
});
