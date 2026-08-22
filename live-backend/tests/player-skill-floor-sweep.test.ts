import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_FLOOR_SWEEP_JOB,
  ensurePlayerSkillFloorSweepSeeded,
  runPlayerSkillFloorSweepChunk,
  runPlayerSkillFloorSweepJob,
} from "../src/features/player-skills.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-skill-floor-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

function play(beatmapId: number, goal: number) {
  return {
    identity: `s${beatmapId}`,
    beatmapId,
    keyCount: 4,
    rate: 1,
    goal,
    pp: 100,
    values: { Overall: 25, Stream: 24 },
    patterns: [],
  };
}

async function seedRow(db: Db, userId: number, plays: unknown[], version = PLAYER_SKILLS_VERSION): Promise<void> {
  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
     values (?, ?, 'ready', json(?), json(?), ?, ?)`,
    [userId, version, json({ modes: [] }), json({ plays }), "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z"],
  );
}

async function queuedSkillUserIds(db: Db): Promise<number[]> {
  const rows = (await exec(db, "select payload_json from jobs where type = 'compute_player_skills' order by id", [])).rows;
  return rows.map((row) => Number(JSON.parse(String(row.payload_json)).userId));
}

describe("player skill floor sweep", () => {
  it("queues recomputes only for rows holding a floor-rated play", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedRow(db, 10, [play(1, 0.8), play(2, 0.95)]);
    await seedRow(db, 20, [play(3, 0.93)]);
    // Old-version rows recompute on view anyway; the sweep skips them.
    await seedRow(db, 30, [play(4, 0.8)], PLAYER_SKILLS_VERSION - 1);

    const result = await runPlayerSkillFloorSweepChunk(db, queue, 0);
    expect(result.enqueued).toEqual([10]);
    expect(result.done).toBe(true);
    expect(await queuedSkillUserIds(db)).toEqual([10]);
  });

  it("chains across chunks by user_id", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    for (const userId of [1, 2, 3]) await seedRow(db, userId, [play(userId, 0.8)]);

    const first = await runPlayerSkillFloorSweepChunk(db, queue, 0, 2);
    expect(first.enqueued).toEqual([1, 2]);
    expect(first.done).toBe(false);
    const second = await runPlayerSkillFloorSweepChunk(db, queue, first.nextCursor, 2);
    expect(second.enqueued).toEqual([3]);
    expect(second.done).toBe(true);
    expect(await queuedSkillUserIds(db)).toEqual([1, 2, 3]);
  });

  it("records the done key so a later boot schedules nothing", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedRow(db, 40, [play(1, 0.8)]);

    await ensurePlayerSkillFloorSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_FLOOR_SWEEP_JOB])).rows.length).toBe(1);

    await runPlayerSkillFloorSweepJob(db, queue, { cursor: 0 });
    const done = (await exec(db, "select 1 from live_meta where key = 'player_skill_floor_sweep_done:v1'", [])).rows[0];
    expect(done).toBeTruthy();

    await exec(db, "delete from jobs where type = ?", [PLAYER_SKILL_FLOOR_SWEEP_JOB]);
    await ensurePlayerSkillFloorSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_FLOOR_SWEEP_JOB])).rows.length).toBe(0);
  });
});
