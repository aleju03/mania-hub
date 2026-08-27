import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import { recordPlayerActivity } from "../src/features/activity.js";
import { getPlayerKeymodePpTail } from "../src/features/keymode-pp.js";
import type { OscScore } from "../src/shared/types.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function makeDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "mania-play-details-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, version, updated_at)
     values (55, 55, 'mania', 'ranked', 6, 'fixture', '2026-08-26T00:00:00.000Z')`,
  );
  return db;
}

function play(options: { scoreId: number; pp: number; endedAt: string; maxCombo: number; totalScore: number }): OscScore {
  return {
    id: options.scoreId,
    user_id: 1,
    beatmap_id: 55,
    ruleset_id: 3,
    accuracy: 0.97,
    rank: "S",
    pp: options.pp,
    max_combo: options.maxCombo,
    total_score: options.totalScore,
    passed: true,
    has_replay: true,
    ended_at: options.endedAt,
    mods: [{ acronym: "DT" }],
    statistics: { great: 900, miss: 2 },
    beatmap: { id: 55, beatmapset_id: 55, mode: "mania", cs: 6, version: "fixture" },
    user: { id: 1, username: "tester", country_code: "CR" },
  } as unknown as OscScore;
}

async function readRow(db: Db, day: string) {
  return (await exec(
    db,
    `select best_pp, best_max_combo, best_total_score, best_has_replay, best_solo_score_id, best_mods_json, best_statistics_json
     from player_activity_maps where user_id = 1 and beatmap_id = 55 and day = ?`,
    [day],
  )).rows[0];
}

describe("archived play details", () => {
  it("keeps the details of the best play on a map, and takes them off the ones it beat", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 900, pp: 200, endedAt: "2026-08-01T12:00:00Z", maxCombo: 800, totalScore: 700_000 }), "official:900");
    // Same map, a better day: the older row is no longer the one any list quotes.
    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 901, pp: 400, endedAt: "2026-08-02T12:00:00Z", maxCombo: 1200, totalScore: 950_000 }), "official:901");

    expect(await readRow(db, "2026-08-02")).toMatchObject({
      best_pp: 400,
      best_max_combo: 1200,
      best_total_score: 950_000,
      best_has_replay: 1,
      best_solo_score_id: 901,
    });
    const beaten = await readRow(db, "2026-08-01");
    expect(beaten).toMatchObject({ best_pp: 200, best_max_combo: null, best_total_score: null, best_has_replay: null, best_solo_score_id: null });
    // Mods and judgement counts stay: the dan pipeline reads every archived
    // day-best on its own, not just the strongest one.
    expect(beaten?.best_mods_json).toBeTruthy();
    expect(beaten?.best_statistics_json).toBeTruthy();
  });

  it("leaves the better play alone when a worse one lands afterwards", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 910, pp: 400, endedAt: "2026-08-01T12:00:00Z", maxCombo: 1200, totalScore: 950_000 }), "official:910");
    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 911, pp: 100, endedAt: "2026-08-02T12:00:00Z", maxCombo: 300, totalScore: 200_000 }), "official:911");

    expect(await readRow(db, "2026-08-01")).toMatchObject({ best_max_combo: 1200, best_total_score: 950_000 });
    expect(await readRow(db, "2026-08-02")).toMatchObject({ best_max_combo: null, best_total_score: null });
  });

  it("serves the surviving details to the per-keymode list", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 920, pp: 200, endedAt: "2026-08-01T12:00:00Z", maxCombo: 800, totalScore: 700_000 }), "official:920");
    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 921, pp: 400, endedAt: "2026-08-02T12:00:00Z", maxCombo: 1200, totalScore: 950_000 }), "official:921");

    const [entry] = (await getPlayerKeymodePpTail(db, 1)).plays;

    expect(entry).toMatchObject({ pp: 400, maxCombo: 1200, totalScore: 950_000, soloScoreId: 921, hasReplay: true });
  });

  it("keeps one copy when two days tie at the map's best pp, and quotes that one", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 930, pp: 300, endedAt: "2026-08-01T12:00:00Z", maxCombo: 800, totalScore: 700_000 }), "official:930");
    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 931, pp: 300, endedAt: "2026-08-02T12:00:00Z", maxCombo: 1200, totalScore: 950_000 }), "official:931");

    // Pruning on pp alone left both rows of a tie holding a copy, and the
    // endpoint was free to quote either of them.
    expect(await readRow(db, "2026-08-01")).toMatchObject({ best_max_combo: null, best_solo_score_id: null });
    expect(await readRow(db, "2026-08-02")).toMatchObject({ best_max_combo: 1200, best_solo_score_id: 931 });

    const [entry] = (await getPlayerKeymodePpTail(db, 1)).plays;
    expect(entry).toMatchObject({ pp: 300, maxCombo: 1200, soloScoreId: 931 });
  });

  it("dates a play by its own instant, not by the day's last attempt", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);

    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 940, pp: 400, endedAt: "2026-08-01T02:00:00Z", maxCombo: 1200, totalScore: 950_000 }), "official:940");
    // A weaker retry later the same day moves last_played_at but not the play
    // the row describes.
    await recordPlayerActivity(db, queue, "CR", play({ scoreId: 941, pp: 100, endedAt: "2026-08-01T23:00:00Z", maxCombo: 300, totalScore: 200_000 }), "official:941");

    const [entry] = (await getPlayerKeymodePpTail(db, 1)).plays;
    expect(entry.pp).toBe(400);
    expect(entry.playedAt).toBe("2026-08-01T02:00:00.000Z");
  });
});
