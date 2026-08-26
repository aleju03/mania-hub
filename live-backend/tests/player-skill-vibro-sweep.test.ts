import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { CHART_ANALYSIS_VERSION, VIBRO_RECOMPUTE_META_KEY } from "../src/features/chart-analysis.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_VIBRO_SWEEP_JOB,
  ensurePlayerSkillVibroSweepSeeded,
  runPlayerSkillVibroSweepChunk,
  runPlayerSkillVibroSweepJob,
} from "../src/features/player-skills.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-skill-vibro-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

function play(beatmapId: number, source: "top" | "tracked") {
  return {
    identity: `s${beatmapId}`,
    beatmapId,
    keyCount: 4,
    rate: 1,
    goal: 0.93,
    pp: 100,
    values: { Overall: 25, Stream: 24 },
    patterns: [],
    source,
  };
}

async function seedChart(db: Db, beatmapId: number, vibro: boolean): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, classification_json, updated_at)
     values (?, ?, 'ready', 4, json(?), ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, json({ vibro }), "2026-08-26T00:00:00.000Z"],
  );
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

describe("player skill vibro sweep", () => {
  it("queues only rows holding a droppable play on a flagged chart", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedChart(db, 1, true);
    await seedChart(db, 2, false);

    await seedRow(db, 10, [play(1, "tracked"), play(2, "tracked")]);
    // pp-backed: a top-sourced play keeps its trust, so it is not evidence.
    await seedRow(db, 20, [play(1, "top")]);
    // Nothing flagged.
    await seedRow(db, 30, [play(2, "tracked")]);
    // Old-version rows recompute on view anyway; the sweep skips them.
    await seedRow(db, 40, [play(1, "tracked")], PLAYER_SKILLS_VERSION - 1);

    const result = await runPlayerSkillVibroSweepChunk(db, queue, 0);
    expect(result.enqueued).toEqual([10]);
    expect(result.done).toBe(true);
    expect(await queuedSkillUserIds(db)).toEqual([10]);
  });

  it("chains across chunks by user_id", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedChart(db, 1, true);
    for (const userId of [1, 2, 3]) await seedRow(db, userId, [play(1, "tracked")]);

    const first = await runPlayerSkillVibroSweepChunk(db, queue, 0, 2);
    expect(first.enqueued).toEqual([1, 2]);
    expect(first.done).toBe(false);
    const second = await runPlayerSkillVibroSweepChunk(db, queue, first.nextCursor, 2);
    expect(second.enqueued).toEqual([3]);
    expect(second.done).toBe(true);
  });

  it("waits for the vibro flags before seeding at boot", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedChart(db, 1, true);
    await seedRow(db, 10, [play(1, "tracked")]);

    await ensurePlayerSkillVibroSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_VIBRO_SWEEP_JOB])).rows.length).toBe(0);

    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, json(?), ?)",
      [VIBRO_RECOMPUTE_META_KEY, json({ finishedAt: "2026-08-26T00:00:00.000Z" }), "2026-08-26T00:00:00.000Z"],
    );
    await ensurePlayerSkillVibroSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_VIBRO_SWEEP_JOB])).rows.length).toBe(1);
  });

  it("records the done key so a later boot schedules nothing", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedChart(db, 1, true);
    await seedRow(db, 10, [play(1, "tracked")]);
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, json(?), ?)",
      [VIBRO_RECOMPUTE_META_KEY, json({ finishedAt: "2026-08-26T00:00:00.000Z" }), "2026-08-26T00:00:00.000Z"],
    );

    await runPlayerSkillVibroSweepJob(db, queue, { cursor: 0 });
    const done = (await exec(db, "select 1 from live_meta where key = 'player_skill_vibro_sweep_done:v1'", [])).rows[0];
    expect(done).toBeTruthy();

    await exec(db, "delete from jobs where type = ?", [PLAYER_SKILL_VIBRO_SWEEP_JOB]);
    await ensurePlayerSkillVibroSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_VIBRO_SWEEP_JOB])).rows.length).toBe(0);
  });
});
