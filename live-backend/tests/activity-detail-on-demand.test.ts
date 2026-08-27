import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import { OsuApiError } from "../src/osu/client.js";
import {
  ACTIVITY_DETAIL_ON_DEMAND_JOB,
  enqueueMissingPlayDetails,
  runActivityDetailOnDemandJob,
  runOnDemandDetailChunk,
  selectOnDemandDetailRows,
} from "../src/features/activity-detail-on-demand.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function makeDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "mania-on-demand-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function addRow(
  db: Db,
  options: { userId: number; beatmapId: number; pp: number; day?: string; scoreId?: number; maxCombo?: number | null },
): Promise<void> {
  const day = options.day ?? "2026-07-01";
  await exec(
    db,
    `insert into player_activity_maps
       (country, user_id, day, beatmap_id, play_count, best_score_id, best_pp, best_max_combo, first_played_at, last_played_at, updated_at)
     values ('CR', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      options.userId,
      day,
      options.beatmapId,
      options.scoreId ?? 7_000_000_000 + options.beatmapId,
      options.pp,
      options.maxCombo ?? null,
      `${day}T12:00:00.000Z`,
      `${day}T12:00:00.000Z`,
      "2026-07-01T00:00:00.000Z",
    ],
  );
  await exec(
    db,
    `insert or ignore into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, version, updated_at)
     values (?, ?, 'mania', 'ranked', 6, 'fixture', '2026-08-26T00:00:00.000Z')`,
    [options.beatmapId, options.beatmapId],
  );
}

function apiScore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7_000_000_010,
    ruleset_id: 3,
    user_id: 1,
    beatmap_id: 10,
    ended_at: "2026-07-01T12:00:00Z",
    max_combo: 1500,
    has_replay: true,
    total_score: 800_000,
    ...overrides,
  };
}

const osuAlways = {
  async getScoreById(id: number) {
    return apiScore({ id, beatmap_id: id - 7_000_000_000 });
  },
};

async function readRow(db: Db, userId: number, beatmapId: number) {
  return (await exec(
    db,
    "select best_max_combo, best_total_score, best_solo_score_id from player_activity_maps where user_id = ? and beatmap_id = ?",
    [userId, beatmapId],
  )).rows[0];
}

describe("view-driven detail completion", () => {
  it("queues one job for a profile that has incomplete plays", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });

    expect(await enqueueMissingPlayDetails(db, queue, 1)).toBe(true);
    const jobs = (await exec(db, "select dedupe_key from jobs where type = ?", [ACTIVITY_DETAIL_ON_DEMAND_JOB])).rows;
    expect(jobs).toHaveLength(1);

    // A second view while the first job is still queued adds nothing.
    await enqueueMissingPlayDetails(db, queue, 1);
    expect((await exec(db, "select count(*) as n from jobs where type = ?", [ACTIVITY_DETAIL_ON_DEMAND_JOB])).rows[0]?.n).toBe(1);
  });

  it("queues nothing for a profile whose plays are already complete", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300, maxCombo: 900 });

    expect(await enqueueMissingPlayDetails(db, queue, 1)).toBe(false);
    expect((await exec(db, "select count(*) as n from jobs where type = ?", [ACTIVITY_DETAIL_ON_DEMAND_JOB])).rows[0]?.n).toBe(0);
  });

  it("leaves rows the capped sweep already queued to the sweep", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 200 });
    await exec(
      db,
      `insert into activity_combo_backfill_queue (position, country, user_id, day, beatmap_id, score_id, pp)
       values (1, 'CR', 1, '2026-07-01', 10, 7000000010, 300)`,
    );

    expect((await selectOnDemandDetailRows(db, 1, 10)).map((row) => row.beatmapId)).toEqual([11]);
  });

  it("skips a play that sits inside the player's osu! window", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 200 });
    await exec(
      db,
      "insert into user_top_scores (user_id, score_id, position, score_json, pp, refreshed_at) values (1, 1, 1, ?, 300, '2026-08-26T00:00:00.000Z')",
      [JSON.stringify({ beatmap_id: 10 })],
    );

    expect((await selectOnDemandDetailRows(db, 1, 10)).map((row) => row.beatmapId)).toEqual([11]);
  });

  it("fills what it can, strongest play first", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 100 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 900 });

    const result = await runOnDemandDetailChunk(db, osuAlways, 1);

    expect(result).toMatchObject({ processed: 2, filled: 2 });
    expect(await readRow(db, 1, 11)).toMatchObject({ best_max_combo: 1500, best_total_score: 800_000, best_solo_score_id: 7_000_000_011 });
  });

  it("remembers a score osu! cannot serve, so the next view does not re-ask", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });
    const osu = { async getScoreById() { throw new OsuApiError(404, "/scores/x"); } };

    const result = await runOnDemandDetailChunk(db, osu, 1);

    expect(result).toMatchObject({ missing: 1, filled: 0 });
    expect((await exec(db, "select reason from activity_play_detail_misses")).rows[0]?.reason).toBe("missing");
    expect(await selectOnDemandDetailRows(db, 1, 10)).toHaveLength(0);
  });

  it("remembers a score that came back belonging to somebody else", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });
    const osu = { async getScoreById(id: number) { return apiScore({ id, user_id: 999 }); } };

    expect(await runOnDemandDetailChunk(db, osu, 1)).toMatchObject({ mismatched: 1, filled: 0 });
    expect(await selectOnDemandDetailRows(db, 1, 10)).toHaveLength(0);
    expect(await readRow(db, 1, 10)).toMatchObject({ best_max_combo: null });
  });

  it("only ever asks about the day each map's list actually quotes", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 100, day: "2026-06-01", scoreId: 111 });
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400, day: "2026-07-01", scoreId: 222 });

    expect((await selectOnDemandDetailRows(db, 1, 10)).map((row) => row.day)).toEqual(["2026-07-01"]);
  });

  it("reports more work left when it fills a whole chunk", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 200 });

    expect(await runOnDemandDetailChunk(db, osuAlways, 1, 2)).toMatchObject({ more: true });
  });

  it("chains under a fresh key, so the continuation survives the running job", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });

    await enqueueMissingPlayDetails(db, queue, 1);
    const [running] = await queue.claim("worker", 1, { types: [ACTIVITY_DETAIL_ON_DEMAND_JOB] });
    expect(running?.dedupeKey).toBe(`${ACTIVITY_DETAIL_ON_DEMAND_JOB}:1:0`);

    // The chunk limit is 20 and only one row exists, so force the chain by
    // running the job while its own row is still 'running' with a full chunk.
    await addRows(db, 1, 20);
    await runActivityDetailOnDemandJob(db, queue, osuAlways, running?.payload as { userId?: number; link?: number });

    // Enqueuing the continuation under the running job's own key wrote
    // nothing: the conflict clause skips a running row, so the chain stopped
    // after one chunk and the done row blocked the next profile view.
    const keys = (await exec(db, "select dedupe_key from jobs where type = ? order by dedupe_key", [ACTIVITY_DETAIL_ON_DEMAND_JOB])).rows
      .map((row) => String(row.dedupe_key));
    expect(keys).toContain(`${ACTIVITY_DETAIL_ON_DEMAND_JOB}:1:1`);
  });

  it("adds nothing while a later link of the chain is still in flight", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });
    await queue.enqueue(ACTIVITY_DETAIL_ON_DEMAND_JOB, `${ACTIVITY_DETAIL_ON_DEMAND_JOB}:1:7`, { userId: 1, link: 7 }, {});

    expect(await enqueueMissingPlayDetails(db, queue, 1)).toBe(false);
    expect((await exec(db, "select count(*) as n from jobs where type = ?", [ACTIVITY_DETAIL_ON_DEMAND_JOB])).rows[0]?.n).toBe(1);
  });

  it("re-queues a player whose chain finished without completing them", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300 });
    await queue.enqueue(ACTIVITY_DETAIL_ON_DEMAND_JOB, `${ACTIVITY_DETAIL_ON_DEMAND_JOB}:1:0`, { userId: 1, link: 0 }, {});
    await exec(db, "update jobs set status = 'done' where type = ?", [ACTIVITY_DETAIL_ON_DEMAND_JOB]);

    expect(await enqueueMissingPlayDetails(db, queue, 1)).toBe(true);
    expect((await exec(db, "select status from jobs where type = ?", [ACTIVITY_DETAIL_ON_DEMAND_JOB])).rows[0]?.status).toBe("queued");
  });
});

async function addRows(db: Db, userId: number, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await addRow(db, { userId, beatmapId: 200 + index, pp: 100 + index });
  }
}
