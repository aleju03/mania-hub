import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, parseJson, type Db } from "../src/db.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_MSD_CAP_JOB,
  ensurePlayerSkillMsdCapSweepSeeded,
  isCapPinnedPlayValues,
  recomputePlayerSkillMsdCapChunk,
  runPlayerSkillMsdCapSweepJob,
} from "../src/features/player-skills.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-skill-msd-cap-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// The old engine's clamp: a skillset whose true SSR exceeded 40 stored
// exactly 40 (the real prod example carried three pinned skillsets with an
// uncapped Overall above them).
function cappedValues(): Record<string, number> {
  return {
    Stream: 40, Jumpstream: 40, Handstream: 40,
    Stamina: 36.2, JackSpeed: 28.9, Chordjack: 31.4,
    Technical: 38.6, Overall: 41.57,
  };
}

function healthyValues(): Record<string, number> {
  return {
    Stream: 25.02, Jumpstream: 24.1, Handstream: 22.7,
    Stamina: 23.4, JackSpeed: 18.9, Chordjack: 21.38,
    Technical: 27.58, Overall: 28.09,
  };
}

function play(beatmapId: number, values: Record<string, number>) {
  return { identity: `s${beatmapId}`, beatmapId, keyCount: 4, rate: 1, goal: 0.93, pp: 100, values, patterns: ["ln"] };
}

async function seedRow(db: Db, userId: number, plays: unknown[], computedAt = "2026-08-20T00:00:00.000Z"): Promise<void> {
  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
     values (?, ?, 'ready', json(?), json(?), ?, ?)`,
    [userId, PLAYER_SKILLS_VERSION, json({ modes: [] }), json({ plays }), computedAt, computedAt],
  );
}

async function readPlays(db: Db, userId: number): Promise<Array<{ beatmapId: number; values: Record<string, number> }>> {
  const row = (await exec(db, "select plays_json from player_skill_ratings where user_id = ?", [userId])).rows[0];
  return parseJson<{ plays?: Array<{ beatmapId: number; values: Record<string, number> }> }>(String(row?.plays_json ?? ""), {}).plays ?? [];
}

describe("player skill MSD-cap sweep", () => {
  it("recognises the pin signature and leaves sub-cap ratings alone", () => {
    expect(isCapPinnedPlayValues(cappedValues())).toBe(true);
    expect(isCapPinnedPlayValues({ ...healthyValues(), JackSpeed: 40 })).toBe(true);
    expect(isCapPinnedPlayValues(healthyValues())).toBe(false);
    // Near-cap but honest ratings stay: the clamp wrote exactly 40.
    expect(isCapPinnedPlayValues({ ...healthyValues(), Stream: 39.98 })).toBe(false);
    expect(isCapPinnedPlayValues(undefined)).toBe(false);
  });

  it("drops pinned plays, keeps the rest, and marks the row stale", async () => {
    const db = await makeDb();
    await seedRow(db, 10, [play(1, healthyValues()), play(2, cappedValues()), play(3, healthyValues())]);

    const result = await recomputePlayerSkillMsdCapChunk(db, 0);
    expect(result.cleaned).toEqual([10]);
    expect(result.droppedPlays).toBe(1);
    expect(result.done).toBe(true);

    const plays = await readPlays(db, 10);
    expect(plays.map((p) => p.beatmapId)).toEqual([1, 3]);

    // Backdated past the 12h ready TTL so the next profile view recomputes,
    // but still a plausible timestamp rather than the epoch.
    const row = (await exec(db, "select computed_at from player_skill_ratings where user_id = ?", [10])).rows[0];
    const computedAtMs = Date.parse(String(row?.computed_at));
    expect(Date.now() - computedAtMs).toBeGreaterThan(12 * 60 * 60_000);
    expect(Date.now() - computedAtMs).toBeLessThan(24 * 60 * 60_000);
  });

  it("leaves clean rows completely untouched", async () => {
    const db = await makeDb();
    await seedRow(db, 20, [play(1, healthyValues())]);

    const result = await recomputePlayerSkillMsdCapChunk(db, 0);
    expect(result.cleaned).toEqual([]);
    expect(result.droppedPlays).toBe(0);

    const row = (await exec(db, "select computed_at from player_skill_ratings where user_id = ?", [20])).rows[0];
    expect(String(row?.computed_at)).toBe("2026-08-20T00:00:00.000Z");
  });

  it("records the done key so a later boot schedules nothing", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedRow(db, 30, [play(1, cappedValues())]);

    await ensurePlayerSkillMsdCapSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_MSD_CAP_JOB])).rows.length).toBe(1);

    await runPlayerSkillMsdCapSweepJob(db, queue, { cursor: 0 });
    const done = (await exec(db, "select 1 from live_meta where key = 'player_skill_msd_cap_sweep_done:v1'", [])).rows[0];
    expect(done).toBeTruthy();

    await exec(db, "delete from jobs", []);
    await ensurePlayerSkillMsdCapSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_MSD_CAP_JOB])).rows.length).toBe(0);
  });
});
