import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, parseJson, type Db } from "../src/db.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_DAN_SWEEP_JOB,
  ensurePlayerSkillDanSweepSeeded,
  recomputePlayerSkillDanChunk,
  runPlayerSkillDanSweepJob,
} from "../src/features/player-skills.js";
import { CHART_ANALYSIS_VERSION, HT_RATE_ANALYSIS_META_KEY } from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-skill-dan-sweep-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function seedChart(db: Db, beatmapId: number, rcRawDan: number): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
     values (?, ?, 'ready', json(?), ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, json({ lnRatio: 0, patterns: [], rc: { rawDan: rcRawDan } }), "2026-08-20T00:00:00.000Z"],
  );
}

// A bare pass at the 96% bar: the old fade credited 8.0 - 0.4 = 7.6, the
// course rules credit the chart's whole 8.0.
function barePass(beatmapId: number) {
  return {
    identity: `s${beatmapId}`, beatmapId, keyCount: 4, rate: 1, goal: 0.93, pp: 100,
    values: { Overall: 22 }, patterns: [], accuracy: 0.96, stableAccuracy: 0.96,
  };
}

const STALE_DAN = { rc: { rawDan: 7.6, label: "8-", clears: 4 }, ln: null };

async function seedRow(db: Db, userId: number, beatmapIds: number[]): Promise<void> {
  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
     values (?, ?, 'ready', json(?), json(?), ?, ?)`,
    [
      userId,
      PLAYER_SKILLS_VERSION,
      json({ totalPlays: beatmapIds.length, analyzedPlays: beatmapIds.length, pendingPlays: 0, unsupportedPlays: 0, modes: [{ keyCount: 4, analyzedPlays: beatmapIds.length, ratings: { Overall: 22 }, dan: STALE_DAN }] }),
      json({ plays: beatmapIds.map(barePass) }),
      "2026-08-20T00:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
    ],
  );
}

describe("recomputePlayerSkillDanChunk", () => {
  it("rewrites the stored dan from the plays without touching the ratings or forcing a recompute", async () => {
    const db = await makeDb();
    for (const beatmapId of [301, 302, 303, 304]) await seedChart(db, beatmapId, 8);
    await seedRow(db, 11, [301, 302, 303, 304]);

    const result = await recomputePlayerSkillDanChunk(db, 0);
    expect(result).toMatchObject({ scanned: 1, rewritten: 1, done: true });

    const row = (await exec(db, "select modes_json, plays_json, computed_at from player_skill_ratings where user_id = 11", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ keyCount: number; ratings: Record<string, number>; dan: { rc: { rawDan: number; clears: number } | null } }> }>(String(row.modes_json ?? ""), { modes: [] });
    expect(summary.modes[0].dan.rc).toMatchObject({ rawDan: 8, clears: 4 });
    // The SSRs and the recompute clock are the expensive parts; neither moves.
    expect(summary.modes[0].ratings.Overall).toBe(22);
    expect(parseJson<{ plays: unknown[] }>(String(row.plays_json ?? ""), { plays: [] }).plays.length).toBe(4);
    expect(String(row.computed_at)).toBe("2026-08-20T00:00:00.000Z");
    db.close();
  });

  it("keeps each keymode's dan on its own plays", async () => {
    const db = await makeDb();
    for (const beatmapId of [301, 302, 303, 304]) await seedChart(db, beatmapId, 8);
    for (const beatmapId of [311, 312, 313, 314]) await seedChart(db, beatmapId, 3);
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
       values (?, ?, 'ready', json(?), json(?), ?, ?)`,
      [
        31,
        PLAYER_SKILLS_VERSION,
        json({ modes: [{ keyCount: 4, dan: STALE_DAN }, { keyCount: 7, dan: STALE_DAN }] }),
        json({
          plays: [
            ...[301, 302, 303, 304].map(barePass),
            ...[311, 312, 313, 314].map((id) => ({ ...barePass(id), keyCount: 7 })),
          ],
        }),
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ],
    );

    await recomputePlayerSkillDanChunk(db, 0);
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 31", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ keyCount: number; dan: { rc: { rawDan: number } | null } }> }>(String(row.modes_json ?? ""), { modes: [] });
    const byKeyCount = new Map(summary.modes.map((mode) => [mode.keyCount, mode]));
    // The 7K plays sit on 3-dan charts; without the per-keymode split they
    // would inherit the 4K pool's 8.
    expect(byKeyCount.get(4)?.dan.rc?.rawDan).toBe(8);
    expect(byKeyCount.get(7)?.dan.rc?.rawDan).toBe(3);
    db.close();
  });

  it("leaves a row alone when its charts carry no dan rating", async () => {
    const db = await makeDb();
    await seedRow(db, 12, [401, 402, 403, 404]);

    await recomputePlayerSkillDanChunk(db, 0);
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 12", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ dan: { rc: unknown } }> }>(String(row.modes_json ?? ""), { modes: [] });
    expect(summary.modes[0].dan.rc).toBeNull();
    db.close();
  });

  it("chains chunks and stamps the done key once the corpus is swept", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    for (const beatmapId of [301, 302, 303, 304]) await seedChart(db, beatmapId, 8);
    for (const userId of [21, 22, 23]) await seedRow(db, userId, [301, 302, 303, 304]);

    await runPlayerSkillDanSweepJob(db, queue, { cursor: 0 });
    const done = (await exec(db, "select 1 from live_meta where key = 'player_skill_dan_sweep_done:v1'", [])).rows[0];
    expect(done).toBeTruthy();

    // A boot past the done key schedules nothing.
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    const jobs = (await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0];
    expect(Number(jobs.c)).toBe(0);
    db.close();
  });

  // Both sweeps share one claimLimit:1 lane and self-chain a chunk at a time,
  // so the HT sweep can finish while this one is midway through its pass. The
  // rows already written that pass saw no 0.75x verdict, so the pass has to be
  // treated as stale even though it went on to stamp a later done key.
  it("re-runs when the HT sweep finished midway through a pass, not just before it", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    for (const beatmapId of [401, 402, 403, 404]) await seedChart(db, beatmapId, 8);
    for (const userId of [31, 32]) await seedRow(db, userId, [401, 402, 403, 404]);

    // The pass starts, then HT stamps done, then the pass finishes.
    const startedAt = "2026-08-26T00:00:00.000Z";
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [HT_RATE_ANALYSIS_META_KEY, json({ finishedAt: "2026-08-26T00:00:30.000Z" }), "2026-08-26T00:00:30.000Z"]);
    await runPlayerSkillDanSweepJob(db, queue, { cursor: 0, startedAt });

    await ensurePlayerSkillDanSweepSeeded(db, queue);
    const queued = (await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0];
    expect(Number(queued.c)).toBe(1);
    db.close();
  });

  it("stays done when the HT sweep finished before the pass began", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    for (const beatmapId of [501, 502, 503, 504]) await seedChart(db, beatmapId, 8);
    await seedRow(db, 41, [501, 502, 503, 504]);

    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [HT_RATE_ANALYSIS_META_KEY, json({ finishedAt: "2026-08-26T00:00:00.000Z" }), "2026-08-26T00:00:00.000Z"]);
    await runPlayerSkillDanSweepJob(db, queue, { cursor: 0, startedAt: "2026-08-26T00:00:30.000Z" });

    await ensurePlayerSkillDanSweepSeeded(db, queue);
    const queued = (await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0];
    expect(Number(queued.c)).toBe(0);
    db.close();
  });
});
