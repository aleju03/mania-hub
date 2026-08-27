import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { OsuApiError } from "../src/osu/client.js";
import {
  backfillActivityComboRow,
  buildActivityComboBackfillQueue,
  countActivityComboBackfillRemaining,
  runActivityComboBackfillChunk,
  selectActivityComboBackfillRows,
  type ActivityComboBackfillRow,
} from "../src/features/activity-combo-backfill.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
  delete process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS;
  delete process.env.ACTIVITY_COMBO_BACKFILL_PLAYERS;
  delete process.env.ACTIVITY_COMBO_BACKFILL_ROWS_PER_PLAYER;
});

async function makeDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "mania-combo-backfill-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function addTrackedUser(db: Db, userId: number, pp: number): Promise<void> {
  await exec(
    db,
    "insert into users (user_id, username, avatar_url, country_code, pp, updated_at) values (?, ?, '', 'CR', ?, '2026-08-26T00:00:00.000Z')",
    [userId, `user${userId}`, pp],
  );
  await exec(
    db,
    "insert into country_rosters (country, user_id, source, is_tracked, refreshed_at) values ('CR', ?, 'test', 1, '2026-08-26T00:00:00.000Z')",
    [userId],
  );
}

/** A mania beatmap, so the row has a keymode the list can bucket it under. */
async function addManiaBeatmap(db: Db, beatmapId: number, keyCount = 6): Promise<void> {
  await exec(
    db,
    `insert or ignore into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, version, updated_at)
     values (?, ?, 'mania', 'ranked', ?, 'fixture', '2026-08-26T00:00:00.000Z')`,
    [beatmapId, beatmapId, keyCount],
  );
}

/** A play sitting in the player's osu! top-200 window, which renders from
    osu!'s own payload and so is never worth a call. */
async function addWindowPlay(db: Db, userId: number, beatmapId: number): Promise<void> {
  await exec(
    db,
    "insert into user_top_scores (user_id, score_id, position, score_json, pp, refreshed_at) values (?, ?, 1, ?, 100, '2026-08-26T00:00:00.000Z')",
    [userId, beatmapId, JSON.stringify({ beatmap_id: beatmapId })],
  );
}

async function addRow(
  db: Db,
  options: { userId: number; beatmapId: number; pp: number; scoreId?: number; day?: string; maxCombo?: number | null },
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
  await addManiaBeatmap(db, options.beatmapId);
}

function row(overrides: Partial<ActivityComboBackfillRow> = {}): ActivityComboBackfillRow {
  return {
    position: 1,
    country: "CR",
    userId: 1,
    day: "2026-07-01",
    beatmapId: 10,
    scoreId: 7_000_000_010,
    pp: 400,
    ...overrides,
  };
}

/** A score the API would return for the row above. */
function apiScore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7_000_000_010,
    ruleset_id: 3,
    user_id: 1,
    beatmap_id: 10,
    ended_at: "2026-07-01T12:00:00Z",
    max_combo: 1234,
    has_replay: true,
    total_score: 888_777,
    ...overrides,
  };
}

function osuReturning(score: Record<string, unknown>, opts: { notFound?: boolean } = {}) {
  const calls: Array<{ id: number; space: string }> = [];
  return {
    calls,
    client: {
      async getScoreById(id: number, space: "solo" | "legacy") {
        calls.push({ id, space });
        if (opts.notFound) throw new OsuApiError(404, "/scores");
        return score;
      },
    },
  };
}

async function readRow(db: Db, userId: number, beatmapId: number) {
  return (await exec(
    db,
    "select best_max_combo, best_has_replay, best_solo_score_id, best_total_score from player_activity_maps where user_id = ? and beatmap_id = ?",
    [userId, beatmapId],
  )).rows[0];
}

describe("backfillActivityComboRow", () => {
  it("writes combo, the replay flag and the solo id from the fetched score", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400, scoreId: 7_000_000_010 });
    const osu = osuReturning(apiScore());

    expect(await backfillActivityComboRow(db, osu.client, row(), "test")).toBe("filled");
    expect(await readRow(db, 1, 10)).toMatchObject({ best_max_combo: 1234, best_has_replay: 1, best_solo_score_id: 7_000_000_010, best_total_score: 888_777 });
  });

  it("refuses a score that is not the one the row recorded", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400, scoreId: 7_000_000_010 });
    // Same id, different player: the two osu! id spaces overlap, so this is a
    // real answer to a real request, and writing it would be another player's
    // combo on this row.
    const osu = osuReturning(apiScore({ user_id: 99 }));

    expect(await backfillActivityComboRow(db, osu.client, row(), "test")).toBe("mismatched");
    expect(await readRow(db, 1, 10)).toMatchObject({ best_max_combo: null });
  });

  it("reports a pruned score as missing rather than writing anything", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400, scoreId: 7_000_000_010 });
    // The score object is never reached: every call 404s.
    const osu = osuReturning(apiScore(), { notFound: true });

    expect(await backfillActivityComboRow(db, osu.client, row(), "test")).toBe("missing");
    // Both id spaces tried before giving up.
    expect(osu.calls.map((call) => call.space)).toEqual(["solo", "legacy"]);
  });

  it("never overwrites a combo ingest already wrote", async () => {
    const db = await makeDb();
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400, scoreId: 7_000_000_010, maxCombo: 777 });
    const osu = osuReturning(apiScore({ max_combo: 1234 }));

    await backfillActivityComboRow(db, osu.client, row(), "test");

    expect(await readRow(db, 1, 10)).toMatchObject({ best_max_combo: 777 });
  });
});

describe("the work list", () => {
  it("takes the strongest rows per player, capped, and only from tracked players", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "";
    process.env.ACTIVITY_COMBO_BACKFILL_PLAYERS = "1";
    process.env.ACTIVITY_COMBO_BACKFILL_ROWS_PER_PLAYER = "2";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addTrackedUser(db, 2, 900);
    for (const [beatmapId, pp] of [[10, 100], [11, 300], [12, 200]] as const) {
      await addRow(db, { userId: 1, beatmapId, pp });
    }
    await addRow(db, { userId: 2, beatmapId: 20, pp: 500 });

    expect(await buildActivityComboBackfillQueue(db)).toBe(2);
    const rows = await selectActivityComboBackfillRows(db, 0, 10);
    // Highest pp first within the player, and the weaker player misses the cut.
    expect(rows.map((entry) => entry.beatmapId)).toEqual([11, 12]);
  });

  it("takes every row of a pinned player, on top of the ranked slice", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "2";
    process.env.ACTIVITY_COMBO_BACKFILL_PLAYERS = "1";
    process.env.ACTIVITY_COMBO_BACKFILL_ROWS_PER_PLAYER = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addTrackedUser(db, 2, 900);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 100 });
    await addRow(db, { userId: 2, beatmapId: 20, pp: 500 });
    await addRow(db, { userId: 2, beatmapId: 21, pp: 50 });

    await buildActivityComboBackfillQueue(db);

    // Pinned rows first, strongest first within the player, then the ranked
    // slice: pinning somebody means fixing their profile now.
    expect((await selectActivityComboBackfillRows(db, 0, 10)).map((entry) => entry.beatmapId)).toEqual([20, 21, 10]);
  });

  it("queues one row per map, the day the list actually quotes", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 100, day: "2026-06-01", scoreId: 111 });
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400, day: "2026-07-01", scoreId: 222 });

    await buildActivityComboBackfillQueue(db);

    expect((await selectActivityComboBackfillRows(db, 0, 10)).map((entry) => entry.day)).toEqual(["2026-07-01"]);
  });

  it("leaves out a play that is inside the player's osu! window", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 300 });
    await addWindowPlay(db, 1, 10);

    await buildActivityComboBackfillQueue(db);

    expect((await selectActivityComboBackfillRows(db, 0, 10)).map((entry) => entry.beatmapId)).toEqual([11]);
  });

  it("leaves out a map no mania table knows the keymode of, which never lists", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 400 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 300 });
    await exec(db, "delete from maps_beatmaps where beatmap_id = 10");

    await buildActivityComboBackfillQueue(db);

    expect((await selectActivityComboBackfillRows(db, 0, 10)).map((entry) => entry.beatmapId)).toEqual([11]);
  });

  it("leaves out rows that already know their combo", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 100, maxCombo: 900 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 200 });

    await buildActivityComboBackfillQueue(db);

    expect((await selectActivityComboBackfillRows(db, 0, 10)).map((entry) => entry.beatmapId)).toEqual([11]);
  });

  it("drops a queued row that some other path filled before the chain reached it", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 100 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 200 });
    await buildActivityComboBackfillQueue(db);

    await exec(db, "update player_activity_maps set best_max_combo = 400 where beatmap_id = 11");

    expect(await countActivityComboBackfillRemaining(db, 0)).toBe(1);
    expect((await selectActivityComboBackfillRows(db, 0, 10)).map((entry) => entry.beatmapId)).toEqual([10]);
  });

  it("drops a queued row a better play has since beaten", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 100, day: "2026-07-01" });
    await buildActivityComboBackfillQueue(db);

    // A better day on the same map. The queued row's combo is still null (the
    // prune clears a superseded row's details), so combo alone would read as
    // "needs a call" and buy the map a second copy of its details.
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300, day: "2026-07-02" });

    expect(await countActivityComboBackfillRemaining(db, 0)).toBe(0);
    expect(await selectActivityComboBackfillRows(db, 0, 10)).toEqual([]);
  });
});

describe("runActivityComboBackfillChunk", () => {
  it("walks the list, counts each verdict, and reports done on a short chunk", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300, scoreId: 7_000_000_010 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 200, scoreId: 7_000_000_011 });
    await buildActivityComboBackfillQueue(db);
    const osu = {
      async getScoreById(id: number) {
        return apiScore({ id, beatmap_id: id - 7_000_000_000, max_combo: 500 });
      },
    };

    const result = await runActivityComboBackfillChunk(db, osu, { cursor: 0, limit: 10, caller: "test" });

    expect(result).toMatchObject({ processed: 2, filled: 2, done: true });
    expect(await readRow(db, 1, 10)).toMatchObject({ best_max_combo: 500 });
    expect(await readRow(db, 1, 11)).toMatchObject({ best_max_combo: 500 });
  });

  it("checkpoints the rows a failed chunk did finish", async () => {
    process.env.ACTIVITY_COMBO_BACKFILL_PIN_USERS = "1";
    const db = await makeDb();
    await addTrackedUser(db, 1, 15_000);
    await addRow(db, { userId: 1, beatmapId: 10, pp: 300, scoreId: 7_000_000_010 });
    await addRow(db, { userId: 1, beatmapId: 11, pp: 200, scoreId: 7_000_000_011 });
    await buildActivityComboBackfillQueue(db);
    let calls = 0;
    const osu = {
      async getScoreById(id: number) {
        calls += 1;
        if (calls > 1) throw new OsuApiError(503, "/scores");
        return apiScore({ id, beatmap_id: id - 7_000_000_000 });
      },
    };

    await expect(runActivityComboBackfillChunk(db, osu, { cursor: 0, limit: 10, caller: "test" }))
      .rejects.toMatchObject({ comboPartial: { processed: 1, filled: 1 } });
  });
});
