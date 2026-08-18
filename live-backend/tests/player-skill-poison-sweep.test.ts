import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, parseJson, type Db } from "../src/db.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_POISON_JOB,
  ensurePlayerSkillPoisonRecoverySeeded,
  isPoisonedPlayValues,
  recomputePlayerSkillPoisonChunk,
  runPlayerSkillPoisonRecoveryJob,
} from "../src/features/player-skills.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-skill-poison-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

// The 2026-08-14 signature: a frozen wasm instance returns one value for every
// skillset. 9.626 is the value the real incident produced.
function poisonedValues(): Record<string, number> {
  return {
    Stream: 9.626, Jumpstream: 9.626, Handstream: 9.626,
    Stamina: 7.188, JackSpeed: 9.626, Chordjack: 9.626,
    Technical: 9.626, Overall: 10.1565,
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

async function seedRow(db: Db, userId: number, plays: unknown[], computedAt = "2026-08-17T00:00:00.000Z"): Promise<void> {
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

describe("player skill poison sweep", () => {
  it("recognises the floor signature and leaves real ratings alone", () => {
    expect(isPoisonedPlayValues(poisonedValues())).toBe(true);
    expect(isPoisonedPlayValues(healthyValues())).toBe(false);
    // A rice chart with no hold content can legitimately rate 0 across the
    // board; the signature requires a positive value so it cannot match.
    expect(isPoisonedPlayValues({ Stream: 0, Technical: 0, Chordjack: 0 })).toBe(false);
    expect(isPoisonedPlayValues(undefined)).toBe(false);
  });

  it("drops poisoned plays, keeps the good ones, and marks the row stale", async () => {
    const db = await makeDb();
    await seedRow(db, 10, [play(1, healthyValues()), play(2, poisonedValues()), play(3, healthyValues())]);

    const result = await recomputePlayerSkillPoisonChunk(db, 0);
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

    const result = await recomputePlayerSkillPoisonChunk(db, 0);
    expect(result.cleaned).toEqual([]);
    expect(result.droppedPlays).toBe(0);

    const row = (await exec(db, "select computed_at from player_skill_ratings where user_id = ?", [20])).rows[0];
    expect(String(row?.computed_at)).toBe("2026-08-17T00:00:00.000Z");
  });

  it("chains across chunks by user_id and finishes", async () => {
    const db = await makeDb();
    for (const userId of [1, 2, 3, 4, 5]) {
      await seedRow(db, userId, [play(userId, poisonedValues()), play(userId + 100, healthyValues())]);
    }

    const first = await recomputePlayerSkillPoisonChunk(db, 0, 2);
    expect(first.cleaned).toEqual([1, 2]);
    expect(first.done).toBe(false);

    const second = await recomputePlayerSkillPoisonChunk(db, first.nextCursor, 2);
    expect(second.cleaned).toEqual([3, 4]);
    expect(second.done).toBe(false);

    const third = await recomputePlayerSkillPoisonChunk(db, second.nextCursor, 2);
    expect(third.cleaned).toEqual([5]);
    expect(third.done).toBe(true);

    for (const userId of [1, 2, 3, 4, 5]) {
      expect((await readPlays(db, userId)).map((p) => p.beatmapId)).toEqual([userId + 100]);
    }
  });

  it("records the done key so a later boot schedules nothing", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedRow(db, 30, [play(1, poisonedValues())]);

    await ensurePlayerSkillPoisonRecoverySeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_POISON_JOB])).rows.length).toBe(1);

    await runPlayerSkillPoisonRecoveryJob(db, queue, { cursor: 0 });
    const done = (await exec(db, "select 1 from live_meta where key = 'player_skill_poison_recovery_done:v1'", [])).rows[0];
    expect(done).toBeTruthy();

    // Second boot: done key present, nothing new enqueued.
    await exec(db, "delete from jobs", []);
    await ensurePlayerSkillPoisonRecoverySeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_POISON_JOB])).rows.length).toBe(0);
  });
});
