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
import { CHART_ANALYSIS_VERSION, HT_RATE_ANALYSIS_META_KEY, JACK_DEMAND_RECOMPUTE_META_KEY, MOTION_FEATURES_RECOMPUTE_META_KEY, SUNNY_REPIN_DT_META_KEY } from "../src/features/chart-analysis.js";
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

/** The fold reads classification_json.jackDemand, so its seeder waits on this. */
async function markJackDemandSwept(db: Db): Promise<void> {
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, json(?), ?)",
    [JACK_DEMAND_RECOMPUTE_META_KEY, json({ finishedAt: "2026-08-19T00:00:00.000Z" }), "2026-08-19T00:00:00.000Z"],
  );
}

/** The v20 fold also reads classification_json.motion. */
async function markMotionFeaturesSwept(db: Db): Promise<void> {
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, json(?), ?)",
    [MOTION_FEATURES_RECOMPUTE_META_KEY, json({ finishedAt: "2026-08-30T00:00:00.000Z" }), "2026-08-30T00:00:00.000Z"],
  );
}

async function markDanDependenciesSwept(db: Db): Promise<void> {
  await markJackDemandSwept(db);
  await markMotionFeaturesSwept(db);
}

async function seedChart(
  db: Db,
  beatmapId: number,
  rcRawDan: number,
  patterns: Array<{ id: string; score: number }> = [],
): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
     values (?, ?, 'ready', json(?), ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, json({ lnRatio: 0, patterns, rc: { rawDan: rcRawDan } }), "2026-08-20T00:00:00.000Z"],
  );
}

async function seedLnChart(db: Db, beatmapId: number, lnRawDan: number): Promise<void> {
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
     values (?, ?, 'ready', json(?), ?)`,
    [beatmapId, CHART_ANALYSIS_VERSION, json({ lnRatio: 0.8, ln: { rawDan: lnRawDan } }), "2026-08-20T00:00:00.000Z"],
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

  it("can patch only 4K LN while preserving RC and every other keymode", async () => {
    const db = await makeDb();
    const beatmapIds = [501, 502, 503, 504];
    for (const beatmapId of beatmapIds) await seedLnChart(db, beatmapId, 10);
    const rc = { rawDan: 8.25, label: "beta+", clears: 9 };
    const staleLn = { rawDan: 4, label: "4", clears: 4 };
    const sevenKeyDan = { rc: { rawDan: 6, label: "6", clears: 4 }, ln: null as typeof rc | null };
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
       values (?, ?, 'ready', json(?), json(?), ?, ?)`,
      [
        61,
        PLAYER_SKILLS_VERSION,
        json({
          modes: [
            { keyCount: 4, ratings: { Overall: 31 }, dan: { rc, ln: staleLn } },
            { keyCount: 7, ratings: { Overall: 19 }, dan: sevenKeyDan },
          ],
        }),
        json({
          plays: beatmapIds.map((beatmapId) => ({
            identity: `s${beatmapId}`,
            beatmapId,
            keyCount: 4,
            rate: 1,
            goal: 0.99,
            pp: 100,
            values: { Overall: 31 },
            patterns: [],
            accuracy: 0.99,
            stableAccuracy: 0.99,
            scoreV2Accuracy: 0.99,
          })),
        }),
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ],
    );

    const result = await recomputePlayerSkillDanChunk(db, 0, 200, "4k-ln");
    expect(result).toMatchObject({ scanned: 1, rewritten: 1, done: true });
    const row = (await exec(db, "select modes_json, computed_at from player_skill_ratings where user_id = 61", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ keyCount: number; ratings: Record<string, number>; dan: typeof sevenKeyDan }> }>(String(row.modes_json ?? ""), { modes: [] });
    const byKeyCount = new Map(summary.modes.map((mode) => [mode.keyCount, mode]));
    expect(byKeyCount.get(4)?.dan.rc).toEqual(rc);
    expect(byKeyCount.get(4)?.dan.ln?.rawDan).toBe(10.3);
    expect(byKeyCount.get(4)?.ratings).toEqual({ Overall: 31 });
    expect(byKeyCount.get(7)).toEqual({ keyCount: 7, ratings: { Overall: 19 }, dan: sevenKeyDan });
    expect(String(row.computed_at)).toBe("2026-08-20T00:00:00.000Z");
    db.close();
  });

  it("does not rewrite a pure-RC row during the 4K LN pass", async () => {
    const db = await makeDb();
    for (const beatmapId of [301, 302, 303, 304]) await seedChart(db, beatmapId, 8);
    await seedRow(db, 62, [301, 302, 303, 304]);

    const result = await recomputePlayerSkillDanChunk(db, 0, 200, "4k-ln");
    expect(result).toMatchObject({ scanned: 1, rewritten: 0, done: true });
    const row = (await exec(db, "select modes_json, updated_at from player_skill_ratings where user_id = 62", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ dan: typeof STALE_DAN }> }>(String(row.modes_json ?? ""), { modes: [] });
    expect(summary.modes[0]?.dan).toEqual(STALE_DAN);
    expect(String(row.updated_at)).toBe("2026-08-20T00:00:00.000Z");
    db.close();
  });

  it("stores a per-skillset verdict beside the side's own", async () => {
    const db = await makeDb();
    for (const beatmapId of [301, 302, 303, 304]) await seedChart(db, beatmapId, 8);
    for (const beatmapId of [321, 322, 323, 324]) await seedChart(db, beatmapId, 5);
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
       values (?, ?, 'ready', json(?), json(?), ?, ?)`,
      [
        41,
        PLAYER_SKILLS_VERSION,
        json({ modes: [{ keyCount: 4, dan: STALE_DAN }] }),
        json({
          plays: [
            // Four jack clears on 8-dan charts and four stamina clears on
            // 5-dan ones: two rated skillsets, so the side averages them.
            ...[301, 302, 303, 304].map((id) => ({ ...barePass(id), values: { Overall: 22, JackSpeed: 25 } })),
            ...[321, 322, 323, 324].map((id) => ({ ...barePass(id), values: { Overall: 20, Stamina: 23 } })),
          ],
        }),
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ],
    );

    await recomputePlayerSkillDanChunk(db, 0);
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 41", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ dan: { rc: { rawDan: number; skillsets?: Record<string, { rawDan: number }> } | null } }> }>(String(row.modes_json ?? ""), { modes: [] });
    const dan = summary.modes[0].dan.rc!;
    // The mean of the two rated skillsets, not the 4th best clear (8).
    expect(dan.rawDan).toBe(6.5);
    expect(dan.skillsets?.jack.rawDan).toBe(8);
    expect(dan.skillsets?.stamina.rawDan).toBe(5);
    // A bucket under the quorum has no verdict rather than a thin one.
    expect(dan.skillsets?.tech).toBeUndefined();
    db.close();
  });

  it("rewrites speedjack-tagged Jumpstream clears into the jack verdict", async () => {
    const db = await makeDb();
    const beatmapIds = [331, 332, 333, 334];
    for (const beatmapId of beatmapIds) {
      await seedChart(db, beatmapId, 8, [{ id: "speedjack", score: 0.947 }]);
    }
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
       values (?, ?, 'ready', json(?), json(?), ?, ?)`,
      [
        42,
        PLAYER_SKILLS_VERSION,
        json({ modes: [{ keyCount: 4, dan: STALE_DAN }] }),
        json({
          plays: beatmapIds.map((id) => ({
            ...barePass(id),
            // Beatmap 4627199's measured shape: Jumpstream wins while
            // JackSpeed is last, which used to put every clear in tech.
            values: {
              Overall: 34, Stream: 22.26, Jumpstream: 33.95, Handstream: 32.29,
              Stamina: 33.14, JackSpeed: 17.94, Chordjack: 31.32, Technical: 32.53,
            },
          })),
        }),
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ],
    );

    await recomputePlayerSkillDanChunk(db, 0);
    const row = (await exec(db, "select modes_json from player_skill_ratings where user_id = 42", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ dan: { rc: { skillsets?: Record<string, { rawDan: number }> } | null } }> }>(String(row.modes_json ?? ""), { modes: [] });
    expect(summary.modes[0].dan.rc?.skillsets?.jack.rawDan).toBe(8);
    expect(summary.modes[0].dan.rc?.skillsets?.tech).toBeUndefined();
    db.close();
  });

  it("leaves a row alone when a recompute wrote it between the read and the rewrite", async () => {
    const db = await makeDb();
    for (const beatmapId of [301, 302, 303, 304]) await seedChart(db, beatmapId, 8);
    await seedRow(db, 51, [301, 302, 303, 304]);

    // The chart lookup sits between the sweep's read and its write, and skill
    // computation runs in another lane, so that gap is a real window. Landing
    // a fresh row in it and watching the sweep decline to overwrite it is the
    // whole point of the updated_at guard.
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
            json({ modes: [{ keyCount: 4, dan: { rc: { rawDan: 9, label: "9", clears: 4 }, ln: null } }] }),
            "2026-08-21T00:00:00.000Z",
            51,
          ],
        });
      }
      return realExecute(stmt);
    };

    const result = await recomputePlayerSkillDanChunk(db, 0);
    expect(raced).toBe(true);
    expect(result).toMatchObject({ scanned: 1, rewritten: 0, done: true });

    const row = (await exec(db, "select modes_json, updated_at from player_skill_ratings where user_id = 51", [])).rows[0];
    const summary = parseJson<{ modes: Array<{ dan: { rc: { rawDan: number } | null } }> }>(String(row.modes_json ?? ""), { modes: [] });
    expect(summary.modes[0].dan.rc?.rawDan).toBe(9);
    expect(String(row.updated_at)).toBe("2026-08-21T00:00:00.000Z");
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

    await markDanDependenciesSwept(db);
    await runPlayerSkillDanSweepJob(db, queue, { cursor: 0 });
    const done = (await exec(db, "select 1 from live_meta where key = 'player_skill_dan_sweep_done:v22'", [])).rows[0];
    expect(done).toBeTruthy();

    // A boot past the done key schedules nothing.
    await markDanDependenciesSwept(db);
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    const jobs = (await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0];
    expect(Number(jobs.c)).toBe(0);
    db.close();
  });

  it("waits for both chart-side dependencies before folding", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    // Folding first would bake a half-patched corpus into the done key.
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows).toHaveLength(0);
    // A job queued by older code is guarded at execution time too.
    await runPlayerSkillDanSweepJob(db, queue, { cursor: 0 });
    expect((await exec(db, "select 1 from live_meta where key = 'player_skill_dan_sweep_done:v22'", [])).rows).toHaveLength(0);

    await markJackDemandSwept(db);
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows).toHaveLength(0);

    await markMotionFeaturesSwept(db);
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    expect((await exec(db, "select 1 from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows).toHaveLength(1);
    db.close();
  });

  it("uses the full scope when only an older marker exists", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    await markDanDependenciesSwept(db);
    await exec(
      db,
      "insert into live_meta (key, value_json, updated_at) values (?, json(?), ?)",
      ["player_skill_dan_sweep_done:v20", json({ finishedAt: "2026-08-30T00:00:00.000Z" }), "2026-08-30T00:00:00.000Z"],
    );
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    const jobs = (await exec(db, "select payload_json from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows;
    expect(jobs).toHaveLength(1);
    expect(parseJson<{ scope?: string }>(String(jobs[0].payload_json), {}).scope).toBe("all");
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
    await markDanDependenciesSwept(db);
    await runPlayerSkillDanSweepJob(db, queue, { cursor: 0, startedAt });

    await ensurePlayerSkillDanSweepSeeded(db, queue);
    const queued = (await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0];
    expect(Number(queued.c)).toBe(1);
    db.close();
  });

  it("automatically re-runs when the Sunny DT repair finished midway through a pass", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    for (const beatmapId of [451, 452, 453, 454]) await seedChart(db, beatmapId, 8);
    await seedRow(db, 36, [451, 452, 453, 454]);

    const startedAt = "2026-08-27T00:00:00.000Z";
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [SUNNY_REPIN_DT_META_KEY, json({ finishedAt: "2026-08-27T00:00:30.000Z" }), "2026-08-27T00:00:30.000Z"]);
    await markDanDependenciesSwept(db);
    // Model the production worker accurately: the cursor-0 job is still
    // running while its handler tries to schedule the required second pass.
    await queue.enqueue(PLAYER_SKILL_DAN_SWEEP_JOB, `${PLAYER_SKILL_DAN_SWEEP_JOB}:0`, { cursor: 0, startedAt });
    const [running] = await queue.claim("test-worker", 1, { types: [PLAYER_SKILL_DAN_SWEEP_JOB] });
    expect(running?.dedupeKey).toBe(`${PLAYER_SKILL_DAN_SWEEP_JOB}:0`);
    await runPlayerSkillDanSweepJob(db, queue, running.payload as { cursor?: number; startedAt?: string });

    // No boot or external seeder call is needed: the finishing player pass
    // notices that its chart inputs moved after it began and starts over.
    const queued = (await exec(db, "select payload_json from jobs where type = ? and status = 'queued'", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows;
    expect(queued).toHaveLength(1);
    expect(parseJson<{ scope?: string }>(String(queued[0].payload_json), {}).scope).toBe("all");
    db.close();
  });

  it("stays done when the HT sweep finished before the pass began", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    for (const beatmapId of [501, 502, 503, 504]) await seedChart(db, beatmapId, 8);
    await seedRow(db, 41, [501, 502, 503, 504]);

    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [HT_RATE_ANALYSIS_META_KEY, json({ finishedAt: "2026-08-26T00:00:00.000Z" }), "2026-08-26T00:00:00.000Z"]);
    await markDanDependenciesSwept(db);
    await runPlayerSkillDanSweepJob(db, queue, { cursor: 0, startedAt: "2026-08-26T00:00:30.000Z" });

    await ensurePlayerSkillDanSweepSeeded(db, queue);
    const queued = (await exec(db, "select count(*) c from jobs where type = ?", [PLAYER_SKILL_DAN_SWEEP_JOB])).rows[0];
    expect(Number(queued.c)).toBe(0);
    db.close();
  });
});
