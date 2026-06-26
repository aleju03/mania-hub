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
  reconcileGoalsForUser,
  reconcilePpGoalsForUser,
  refreshGoalUserIndex,
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
  it("completes play_pp goals from stored top scores created before the goal", async () => {
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [USER, 777, 0, JSON.stringify(scoreWith({ id: 777, pp: 252.4, passed: true })), 252.4, 252.4, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    );
    const goal = await createUserGoal(db, queue, { userId: USER, country: "CR", kind: "play_pp", targetValue: 200 });
    await reconcileGoalsForUser(db, events, USER);
    const done = await getUserGoal(db, goal.id);
    expect(done?.status).toBe("completed");
    expect(done?.completedValue).toBeCloseTo(252.4, 1);
    expect(done?.completedScoreId).toBe("official:777");
  });

  it("completes map goals from stored activity created before the goal", async () => {
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
    expect((await getUserGoal(db, accuracy.id))?.status).toBe("completed");
    expect((await getUserGoal(db, grade.id))?.status).toBe("completed");
    expect((await getUserGoal(db, pass.id))?.status).toBe("completed");
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
