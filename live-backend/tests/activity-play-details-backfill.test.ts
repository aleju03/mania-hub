import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { backfillActivityPlayDetails } from "../src/features/activity-play-details-backfill.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function makeDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "mania-activity-details-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

/** An activity row as it was written before the detail columns existed. The
    score id is the whole identity here: it is what a candidate must match. */
async function addBareRow(
  db: Db,
  options: { userId: number; beatmapId: number; pp: number; scoreId: number; day?: string },
): Promise<void> {
  const day = options.day ?? "2026-06-01";
  await exec(
    db,
    `insert into player_activity_maps
       (country, user_id, day, beatmap_id, play_count, best_score_id, best_pp, best_accuracy, best_rank, first_played_at, last_played_at, updated_at)
     values ('CR', ?, ?, ?, 1, ?, ?, 0.97, 'A', ?, ?, ?)`,
    [options.userId, day, options.beatmapId, options.scoreId, options.pp, `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`, "2026-06-01T00:00:00.000Z"],
  );
}

async function readRow(db: Db, userId: number, beatmapId: number, day?: string) {
  return (await exec(
    db,
    `select best_max_combo, best_has_replay, best_solo_score_id, best_total_score, best_played_at
     from player_activity_maps
     where user_id = ? and beatmap_id = ?${day ? " and day = ?" : ""}`,
    day ? [userId, beatmapId, day] : [userId, beatmapId],
  )).rows[0];
}

async function addScoreEvent(
  db: Db,
  options: { userId: number; beatmapId: number; pp: number; soloScoreId: number; maxCombo: number; hasReplay?: boolean; legacyScoreId?: number; endedAt?: string },
): Promise<void> {
  await exec(
    db,
    `insert into score_events
       (score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
     values (?, ?, ?, ?, 'CR', ?, 3, ?, ?, 900000, 0.97, 'A', 1, 1, 1, ?, ?, '2026-06-01T00:00:00.000Z', 'test')`,
    [
      options.soloScoreId,
      `official:${options.soloScoreId}`,
      options.legacyScoreId ?? null,
      options.userId,
      options.beatmapId,
      JSON.stringify({ id: options.soloScoreId, max_combo: options.maxCombo, has_replay: options.hasReplay ?? true, total_score: 912_345 }),
      options.pp,
      options.hasReplay === false ? 0 : 1,
      options.endedAt ?? "2026-06-01T00:00:00.000Z",
    ],
  );
}

async function addTopPlayEvent(
  db: Db,
  options: { userId: number; beatmapId: number; pp: number; soloScoreId: number; maxCombo: number; hasReplay?: boolean },
): Promise<void> {
  await exec(
    db,
    `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at, score_time, score_beatmap_id, key_count)
     values ('CR', ?, ?, ?, ?, 0, ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', ?, 4)`,
    [
      options.soloScoreId,
      options.userId,
      options.pp,
      options.pp,
      JSON.stringify({
        pp: options.pp,
        score: { id: options.soloScoreId, beatmap_id: options.beatmapId, max_combo: options.maxCombo, has_replay: options.hasReplay ?? true },
      }),
      options.beatmapId,
    ],
  );
}

async function addBoardScore(
  db: Db,
  options: { userId: number; beatmapId: number; pp: number; scoreId: number; isLazer: boolean; hasReplay?: boolean },
): Promise<void> {
  await exec(
    db,
    `insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
     values ('CR', ?, 'nm', ?, ?, 900000, ?, 0.97, 'A', '[]', ?, ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    [options.beatmapId, options.userId, options.scoreId, options.pp, options.isLazer ? 1 : 0, options.hasReplay === false ? 0 : 1],
  );
}

describe("backfillActivityPlayDetails", () => {
  it("fills combo, replay, the solo id and the play's own instant from a stored score payload", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 10, pp: 481.23, scoreId: 7269020174 });
    await addScoreEvent(db, { userId: 1, beatmapId: 10, pp: 481.23, soloScoreId: 7269020174, maxCombo: 4412, endedAt: "2026-06-01T11:22:33.000Z" });

    const result = await backfillActivityPlayDetails(db);

    expect(result.updated).toBe(1);
    expect(await readRow(db, 1, 10)).toMatchObject({
      best_max_combo: 4412,
      best_has_replay: 1,
      best_solo_score_id: 7269020174,
      best_total_score: 912_345,
      best_played_at: "2026-06-01T11:22:33.000Z",
    });
  });

  it("matches a stable play through the legacy id the row recorded", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 15, pp: 320, scoreId: 661735936 });
    await addScoreEvent(db, { userId: 1, beatmapId: 15, pp: 320, soloScoreId: 7269020175, legacyScoreId: 661735936, maxCombo: 1500 });

    await backfillActivityPlayDetails(db);

    // best_score_id prefers the legacy id, so that is the id a candidate has
    // to answer to; the solo id is what /replay then resolves.
    expect(await readRow(db, 1, 15)).toMatchObject({ best_max_combo: 1500, best_solo_score_id: 7269020175 });
  });

  it("falls back to a top-play payload when the raw event is out of retention", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 20, pp: 300.5, scoreId: 7276733479 });
    await addTopPlayEvent(db, { userId: 1, beatmapId: 20, pp: 300.5, soloScoreId: 7276733479, maxCombo: 615 });

    await backfillActivityPlayDetails(db);

    expect(await readRow(db, 1, 20)).toMatchObject({ best_max_combo: 615, best_has_replay: 1, best_solo_score_id: 7276733479 });
  });

  it("takes an id from a lazer board row, which has no legacy id to prefer", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 30, pp: 250, scoreId: 7300000000 });
    await addBoardScore(db, { userId: 1, beatmapId: 30, pp: 250, scoreId: 7300000000, isLazer: true });

    await backfillActivityPlayDetails(db);

    // The board keeps no combo, so that one stays unknown rather than zero.
    expect(await readRow(db, 1, 30)).toMatchObject({ best_max_combo: null, best_has_replay: 1, best_solo_score_id: 7300000000 });
  });

  it("leaves a stable board row alone, since its id may be the legacy one", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 40, pp: 190, scoreId: 4123456789 });
    await addBoardScore(db, { userId: 1, beatmapId: 40, pp: 190, scoreId: 4123456789, isLazer: false });

    await backfillActivityPlayDetails(db);

    expect(await readRow(db, 1, 40)).toMatchObject({ best_max_combo: null, best_has_replay: null, best_solo_score_id: null });
  });

  it("refuses a play of the same map at the same pp that is a different score", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 50, pp: 400, scoreId: 7000000001 });
    // Same player, same map, same pp to the cent, different play: rounded pp
    // was never an identity, and taking this one would put another run's
    // replay link on the row.
    await addScoreEvent(db, { userId: 1, beatmapId: 50, pp: 400, soloScoreId: 7000000009, maxCombo: 800 });
    await addScoreEvent(db, { userId: 2, beatmapId: 50, pp: 400, soloScoreId: 7000000002, maxCombo: 900 });

    await backfillActivityPlayDetails(db);

    expect(await readRow(db, 1, 50)).toMatchObject({ best_max_combo: null, best_has_replay: null, best_solo_score_id: null });
  });

  it("prefers the raw payload over a board row, and never overwrites ingest", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 60, pp: 275, scoreId: 7111111111 });
    await addScoreEvent(db, { userId: 1, beatmapId: 60, pp: 275, soloScoreId: 7111111111, maxCombo: 1200 });
    await addBoardScore(db, { userId: 1, beatmapId: 60, pp: 275, scoreId: 7111111111, isLazer: true });
    await exec(
      db,
      `insert into player_activity_maps
         (country, user_id, day, beatmap_id, play_count, best_score_id, best_pp, best_max_combo, best_has_replay, best_solo_score_id, first_played_at, last_played_at, updated_at)
       values ('CR', 1, '2026-08-20', 61, 1, 7444444444, 275, 999, 0, 7444444444, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    );
    await addScoreEvent(db, { userId: 1, beatmapId: 61, pp: 275, soloScoreId: 7444444444, maxCombo: 111 });

    await backfillActivityPlayDetails(db);

    expect(await readRow(db, 1, 60)).toMatchObject({ best_max_combo: 1200, best_solo_score_id: 7111111111 });
    expect(await readRow(db, 1, 61)).toMatchObject({ best_max_combo: 999, best_has_replay: 0, best_solo_score_id: 7444444444 });
  });

  it("records a play with no replay as known-without-one, not as unknown", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 70, pp: 210, scoreId: 7555555555 });
    await addScoreEvent(db, { userId: 1, beatmapId: 70, pp: 210, soloScoreId: 7555555555, maxCombo: 700, hasReplay: false });

    await backfillActivityPlayDetails(db);

    expect(await readRow(db, 1, 70)).toMatchObject({ best_has_replay: 0, best_solo_score_id: 7555555555 });
  });

  it("keeps one map's details on the best day and takes them off the days it beat", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 90, pp: 300, scoreId: 7900000001, day: "2026-06-01" });
    await addBareRow(db, { userId: 1, beatmapId: 90, pp: 100, scoreId: 7900000002, day: "2026-06-02" });
    await addScoreEvent(db, { userId: 1, beatmapId: 90, pp: 300, soloScoreId: 7900000001, maxCombo: 1000 });
    // v2 wrote details onto every day of a map, so the weaker one carries a
    // copy the lists never quote.
    await exec(
      db,
      "update player_activity_maps set best_max_combo = 55, best_solo_score_id = 7900000002 where user_id = 1 and beatmap_id = 90 and day = '2026-06-02'",
    );

    const result = await backfillActivityPlayDetails(db);

    expect(result.healed).toBe(1);
    expect(await readRow(db, 1, 90, "2026-06-01")).toMatchObject({ best_max_combo: 1000, best_solo_score_id: 7900000001 });
    expect(await readRow(db, 1, 90, "2026-06-02")).toMatchObject({ best_max_combo: null, best_solo_score_id: null });
  });

  it("re-derives a row whose stored solo id belongs to another play", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 95, pp: 260, scoreId: 7950000001 });
    await addScoreEvent(db, { userId: 1, beatmapId: 95, pp: 260, soloScoreId: 7950000001, maxCombo: 1300 });
    // What a rounded-pp match could produce: the row's own score says one
    // thing, the stored id points at a different play.
    await exec(
      db,
      "update player_activity_maps set best_max_combo = 77, best_solo_score_id = 7950009999 where user_id = 1 and beatmap_id = 95",
    );

    await backfillActivityPlayDetails(db);

    expect(await readRow(db, 1, 95)).toMatchObject({ best_max_combo: 1300, best_solo_score_id: 7950000001 });
  });

  it("runs once, then skips, and drops its lookup table either way", async () => {
    const db = await makeDb();
    await addBareRow(db, { userId: 1, beatmapId: 80, pp: 150, scoreId: 7666666666 });
    await addScoreEvent(db, { userId: 1, beatmapId: 80, pp: 150, soloScoreId: 7666666666, maxCombo: 500 });

    const first = await backfillActivityPlayDetails(db);
    const second = await backfillActivityPlayDetails(db);

    expect(first.skipped).toBe(false);
    expect(second).toMatchObject({ skipped: true, updated: 0 });
    const leftovers = (await exec(db, "select name from sqlite_master where name like '_activity_play_details%'")).rows;
    expect(leftovers).toHaveLength(0);
  });

  it("sweeps every rowid window, not just the first chunk", async () => {
    const db = await makeDb();
    for (let index = 0; index < 25; index += 1) {
      const pp = 100 + index;
      await addBareRow(db, { userId: 1, beatmapId: 1000 + index, pp, scoreId: 8000000000 + index });
      await addScoreEvent(db, { userId: 1, beatmapId: 1000 + index, pp, soloScoreId: 8000000000 + index, maxCombo: 300 + index });
    }

    const result = await backfillActivityPlayDetails(db, { chunkRows: 4 });

    expect(result.updated).toBe(25);
    expect(await readRow(db, 1, 1024)).toMatchObject({ best_max_combo: 324, best_solo_score_id: 8000000024 });
  });
});
