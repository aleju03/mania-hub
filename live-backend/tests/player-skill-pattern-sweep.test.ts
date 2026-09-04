import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, json, migrate, parseJson, type Db } from "../src/db.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_PATTERN_SWEEP_JOB,
  ensurePlayerSkillPatternSweepSeeded,
  recomputePlayerSkillPatternChunk,
  runPlayerSkillPatternSweepJob,
} from "../src/features/player-skills.js";
import { CHART_ANALYSIS_VERSION, JACK_TAG_META_KEY } from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-skill-pattern-sweep-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function seedChart(db: Db, beatmapId: number, patterns: Array<{ id: string; score: number }>): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, key_count, status, classification_json, updated_at)
     values (?, ?, 8, 'ready', json(?), ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, json({ lnRatio: 0, patterns }), "2026-08-27T00:00:00.000Z"],
  );
}

function play(beatmapId: number, patterns: string[]) {
  return {
    identity: `s${beatmapId}`, beatmapId, keyCount: 8, rate: 1, goal: 0.93, pp: 100,
    values: { Overall: 22 }, patterns,
  };
}

// A row folded before the jack re-tag: its charts carried only a tech tag.
async function seedRow(db: Db, userId: number, beatmapIds: number[], keyCount = 8): Promise<void> {
  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
     values (?, ?, 'ready', json(?), json(?), ?, ?)`,
    [
      userId,
      PLAYER_SKILLS_VERSION,
      json({
        totalPlays: beatmapIds.length, analyzedPlays: beatmapIds.length, pendingPlays: 0, unsupportedPlays: 0,
        modes: [{
          keyCount, analyzedPlays: beatmapIds.length, ratings: { Overall: 22 },
          patterns: [{ id: "tech", rating: 22, plays: beatmapIds.length }], dan: null,
        }],
      }),
      json({ plays: beatmapIds.map((id) => ({ ...play(id, ["tech"]), keyCount })) }),
      "2026-08-20T00:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
    ],
  );
}

describe("recomputePlayerSkillPatternChunk", () => {
  it("refolds the patterns block from the fresh chart tags without touching ratings or the recompute clock", async () => {
    const db = await makeDb();
    for (const beatmapId of [701, 702, 703]) await seedChart(db, beatmapId, [{ id: "jack", score: 0.9 }]);
    await seedRow(db, 11, [701, 702, 703]);

    const result = await recomputePlayerSkillPatternChunk(db, 0);
    expect(result).toMatchObject({ scanned: 1, rewritten: 1, done: true });

    const row = (await exec(db, "select modes_json, plays_json, computed_at from player_skill_ratings where user_id = 11", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ ratings: Record<string, number>; patterns: Array<{ id: string; plays: number; rating: number }> }> }>(String(row.modes_json ?? ""), { modes: [] });
    const patterns = new Map(summary.modes[0].patterns.map((entry) => [entry.id, entry]));
    // The stale tech fold is gone with its tag; the jack axis appears.
    expect(patterns.get("jack")).toMatchObject({ plays: 3 });
    expect(patterns.get("jack")!.rating).toBeGreaterThan(0);
    expect(patterns.get("tech")).toBeUndefined();
    expect(summary.modes[0].ratings.Overall).toBe(22);
    expect(String(row.computed_at)).toBe("2026-08-20T00:00:00.000Z");
    // The per-play tags move with the summary: the explorer filters on them.
    const stored = parseJson<{ plays: Array<{ patterns: string[] }> }>(String(row.plays_json ?? ""), { plays: [] });
    expect(stored.plays.map((entry) => entry.patterns)).toEqual([["jack"], ["jack"], ["jack"]]);
    db.close();
  });

  it("rewrites a row whose summary already folded but whose plays still carry the old tags", async () => {
    const db = await makeDb();
    for (const beatmapId of [701, 702, 703]) await seedChart(db, beatmapId, [{ id: "jack", score: 0.9 }]);
    await seedRow(db, 12, [701, 702, 703]);
    // What the v2 sweep left behind: a jack summary over tech-tagged plays.
    const folded = await recomputePlayerSkillPatternChunk(db, 0);
    expect(folded.rewritten).toBe(1);
    await exec(
      db,
      "update player_skill_ratings set plays_json = json(?) where user_id = 12",
      [json({ plays: [701, 702, 703].map((id) => play(id, ["tech"])) })],
    );

    const result = await recomputePlayerSkillPatternChunk(db, 0);
    expect(result).toMatchObject({ scanned: 1, rewritten: 1, done: true });
    const row = (await exec(db, "select plays_json from player_skill_ratings where user_id = 12", [])).rows[0];
    const stored = parseJson<{ plays: Array<{ patterns: string[] }> }>(String(row.plays_json ?? ""), { plays: [] });
    expect(stored.plays.map((entry) => entry.patterns)).toEqual([["jack"], ["jack"], ["jack"]]);
    db.close();
  });

  it("keeps stored tags for plays whose chart has no analysis row", async () => {
    const db = await makeDb();
    await seedRow(db, 21, [801, 802, 803]);

    const result = await recomputePlayerSkillPatternChunk(db, 0);
    expect(result).toMatchObject({ scanned: 1, done: true });
    // The fold ran on the stored tags: still a tech row, no minted jack.
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 21", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ patterns: Array<{ id: string; plays: number }> }> }>(String(row.modes_json ?? ""), { modes: [] });
    expect(summary.modes[0].patterns.map((entry) => entry.id)).toEqual(["tech"]);
    expect(summary.modes[0].patterns[0].plays).toBe(3);
    db.close();
  });

  it("skips pure-4K rows and is idempotent on a second pass", async () => {
    const db = await makeDb();
    for (const beatmapId of [701, 702, 703]) await seedChart(db, beatmapId, [{ id: "jack", score: 0.9 }]);
    await seedRow(db, 31, [701, 702, 703]);
    await seedRow(db, 32, [701, 702, 703], 4);

    const first = await recomputePlayerSkillPatternChunk(db, 0);
    expect(first).toMatchObject({ scanned: 1, rewritten: 1, done: true });
    const second = await recomputePlayerSkillPatternChunk(db, 0);
    expect(second).toMatchObject({ scanned: 1, rewritten: 0, done: true });
    db.close();
  });

  it("leaves a row alone when a recompute wrote it between the read and the rewrite", async () => {
    const db = await makeDb();
    for (const beatmapId of [701, 702, 703]) await seedChart(db, beatmapId, [{ id: "jack", score: 0.9 }]);
    await seedRow(db, 41, [701, 702, 703]);

    const client = db as unknown as { execute: (stmt: unknown) => Promise<unknown> };
    const realExecute = client.execute.bind(client);
    let raced = false;
    client.execute = async (stmt: unknown) => {
      const sql = String((stmt as { sql?: unknown })?.sql ?? stmt ?? "");
      if (!raced && sql.includes("beatmap_chart_analysis")) {
        raced = true;
        await realExecute({
          sql: "update player_skill_ratings set modes_json = json(?), updated_at = ? where user_id = ?",
          args: [
            json({ modes: [{ keyCount: 8, patterns: [{ id: "jack", rating: 30, plays: 9 }] }] }),
            "2026-08-28T00:00:00.000Z",
            41,
          ],
        });
      }
      return realExecute(stmt);
    };

    const result = await recomputePlayerSkillPatternChunk(db, 0);
    expect(raced).toBe(true);
    expect(result).toMatchObject({ scanned: 1, rewritten: 0, done: true });
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 41", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ patterns: Array<{ rating: number }> }> }>(String(row.modes_json ?? ""), { modes: [] });
    expect(summary.modes[0].patterns[0].rating).toBe(30);
    db.close();
  });
});

describe("ensurePlayerSkillPatternSweepSeeded", () => {
  it("waits for the chart-side jack sweep, seeds once, and stays quiet after the done key", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    const jobCount = async () => Number((await exec(
      db,
      "select count(*) as cnt from jobs where type = ?",
      [PLAYER_SKILL_PATTERN_SWEEP_JOB],
    )).rows[0]?.cnt ?? 0);

    // Chart sweep still running: folding now would bake half-swept tags.
    await ensurePlayerSkillPatternSweepSeeded(db, queue);
    expect(await jobCount()).toBe(0);

    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [JACK_TAG_META_KEY, json({ finishedAt: "2026-08-28T00:00:00.000Z" }), "2026-08-28T00:00:00.000Z"],
    );
    await ensurePlayerSkillPatternSweepSeeded(db, queue);
    expect(await jobCount()).toBe(1);

    // The finishing chunk stamps done and reports it, so the dispatcher can
    // force the baseline rebuild.
    expect(await runPlayerSkillPatternSweepJob(db, queue, { cursor: 0 })).toBe(true);
    const done = (await exec(db, "select 1 from live_meta where key = 'player_skill_pattern_sweep_done:v4'", [])).rows[0];
    expect(done).toBeTruthy();

    await ensurePlayerSkillPatternSweepSeeded(db, queue);
    expect(await jobCount()).toBe(1);
    db.close();
  });
});
