import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getPlayerKeymodePpKeyCounts, getPlayerKeymodePpTail } from "../src/features/keymode-pp.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function makeDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "mania-keymode-pp-"));
  dirs.push(dir);
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function addManiaBeatmapWithDifficulty(
  db: Db,
  beatmapId: number,
  keyCount: number,
  stars: number,
  bpm: number,
): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, version, updated_at)
     values (?, ?, 'mania', 'ranked', ?, ?, ?, 'fixture', '2026-08-26T00:00:00.000Z')`,
    [beatmapId, beatmapId, keyCount, stars, bpm],
  );
}

async function addManiaBeatmap(db: Db, beatmapId: number, keyCount: number): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, version, updated_at)
     values (?, ?, 'mania', 'ranked', ?, 'fixture', '2026-08-26T00:00:00.000Z')`,
    [beatmapId, beatmapId, keyCount],
  );
}

async function addSearchIndexBeatmap(db: Db, beatmapId: number, keyCount: number): Promise<void> {
  await exec(
    db,
    `insert into map_search_index
       (beatmap_id, beatmapset_id, analysis_version, title, artist, version, search_text, key_count, stars, bpm, length, status, primary_pattern, updated_at)
     values (?, ?, 1, 'fixture', 'fixture', 'fixture', 'fixture', ?, 5, 180, 120, 'ranked', 'stream', '2026-08-26T00:00:00.000Z')`,
    [beatmapId, beatmapId, keyCount],
  );
}

async function addSet(db: Db, beatmapsetId: number, title: string): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, updated_at)
     values (?, ?, 'fixture', 'fixture', 'ranked', '{}', '2026-08-26T00:00:00.000Z')`,
    [beatmapsetId, title],
  );
}

async function addPlay(
  db: Db,
  options: {
    userId: number;
    beatmapId: number;
    pp: number | null;
    day?: string;
    country?: string;
    accuracy?: number;
    rank?: string;
    mods?: string[];
    maxCombo?: number;
    hasReplay?: boolean;
    soloScoreId?: number;
    scoreId?: number;
    statistics?: Record<string, number>;
  },
): Promise<void> {
  await exec(
    db,
    `insert into player_activity_maps
       (country, user_id, day, beatmap_id, play_count, best_score_id, best_pp, best_accuracy, best_rank, best_mods_json, best_statistics_json, best_max_combo, best_has_replay, best_solo_score_id, first_played_at, last_played_at, updated_at)
     values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.country ?? "CR",
      options.userId,
      options.day ?? "2026-08-01",
      options.beatmapId,
      options.scoreId ?? options.beatmapId,
      options.pp,
      options.accuracy ?? null,
      options.rank ?? null,
      options.mods ? JSON.stringify(options.mods.map((acronym) => ({ acronym }))) : null,
      options.statistics ? JSON.stringify(options.statistics) : null,
      options.maxCombo ?? null,
      options.hasReplay == null ? null : options.hasReplay ? 1 : 0,
      options.soloScoreId ?? null,
      `${options.day ?? "2026-08-01"}T00:00:00.000Z`,
      `${options.day ?? "2026-08-01"}T00:00:00.000Z`,
      "2026-08-26T00:00:00.000Z",
    ],
  );
}

describe("getPlayerKeymodePpTail", () => {
  it("groups tracked plays by the keymode the beatmap is", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 10, 4);
    await addManiaBeatmap(db, 11, 6);
    await addPlay(db, { userId: 1, beatmapId: 10, pp: 300 });
    await addPlay(db, { userId: 1, beatmapId: 11, pp: 250 });

    const tail = await getPlayerKeymodePpTail(db, 1);

    expect(tail.tracked).toBe(true);
    expect(tail.plays).toMatchObject([
      { beatmapId: 10, keyCount: 4, pp: 300 },
      { beatmapId: 11, keyCount: 6, pp: 250 },
    ]);
  });

  it("keeps one row per map, at the best pp any day saw", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 20, 7);
    await addPlay(db, { userId: 2, beatmapId: 20, pp: 180, day: "2026-06-01" });
    await addPlay(db, { userId: 2, beatmapId: 20, pp: 240, day: "2026-07-02" });

    const tail = await getPlayerKeymodePpTail(db, 2);

    expect(tail.plays).toMatchObject([{ beatmapId: 20, keyCount: 7, pp: 240 }]);
    expect(tail.trackedFrom).toBe("2026-06-01");
  });

  it("leaves out plays with no pp and converts, which have no mania row to join", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 30, 4);
    await addPlay(db, { userId: 3, beatmapId: 30, pp: 120 });
    // A failed or unranked play: recorded, but worth no pp.
    await addPlay(db, { userId: 3, beatmapId: 30, pp: null, day: "2026-08-02" });
    // A convert: played in mania, but the map itself is not a mania map, so
    // neither mania-only source carries a key count for it.
    await addPlay(db, { userId: 3, beatmapId: 31, pp: 400 });

    const tail = await getPlayerKeymodePpTail(db, 3);

    expect(tail.plays).toMatchObject([{ beatmapId: 30, keyCount: 4, pp: 120 }]);
    expect(tail.unknownKeyCount).toBe(1);
  });

  it("falls back to the map search index when the maps projection never stored the beatmap", async () => {
    const db = await makeDb();
    await addSearchIndexBeatmap(db, 40, 5);
    await addPlay(db, { userId: 4, beatmapId: 40, pp: 210 });

    const tail = await getPlayerKeymodePpTail(db, 4);

    expect(tail.plays).toMatchObject([{ beatmapId: 40, keyCount: 5, pp: 210 }]);
    expect(tail.unknownKeyCount).toBe(0);
  });

  it("caps each keymode at its own limit, keeping the highest pp", async () => {
    const db = await makeDb();
    for (let i = 0; i < 5; i++) {
      await addManiaBeatmap(db, 50 + i, 4);
      await addPlay(db, { userId: 5, beatmapId: 50 + i, pp: 100 + i });
    }

    const tail = await getPlayerKeymodePpTail(db, 5, { perKeymodeLimit: 2 });

    expect(tail.plays).toMatchObject([
      { beatmapId: 54, keyCount: 4, pp: 104 },
      { beatmapId: 53, keyCount: 4, pp: 103 },
    ]);
  });

  it("counts a keymode limit per keymode, not across the whole tail", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 60, 4);
    await addManiaBeatmap(db, 61, 4);
    await addManiaBeatmap(db, 62, 7);
    await addPlay(db, { userId: 6, beatmapId: 60, pp: 500 });
    await addPlay(db, { userId: 6, beatmapId: 61, pp: 400 });
    await addPlay(db, { userId: 6, beatmapId: 62, pp: 10 });

    const tail = await getPlayerKeymodePpTail(db, 6, { perKeymodeLimit: 1 });

    expect(tail.plays).toMatchObject([
      { beatmapId: 60, keyCount: 4, pp: 500 },
      { beatmapId: 62, keyCount: 7, pp: 10 },
    ]);
  });

  it("reads a player the ingest never saw as untracked rather than failing", async () => {
    const db = await makeDb();

    const tail = await getPlayerKeymodePpTail(db, 999);

    expect(tail).toMatchObject({ tracked: false, trackedFrom: null, plays: [], unknownKeyCount: 0 });
  });

  it("merges the same player across countries, which a move leaves behind", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 70, 4);
    await addManiaBeatmap(db, 71, 4);
    await addPlay(db, { userId: 7, beatmapId: 70, pp: 300, country: "CR", day: "2026-05-01" });
    await addPlay(db, { userId: 7, beatmapId: 71, pp: 200, country: "ES", day: "2026-06-01" });

    const tail = await getPlayerKeymodePpTail(db, 7);

    expect(tail.plays.map((play) => play.beatmapId)).toEqual([70, 71]);
    expect(tail.trackedFrom).toBe("2026-05-01");
  });
  it("quotes the play that won the map, not whichever day sorted first", async () => {
    const db = await makeDb();
    await addSet(db, 80, "Fixture Song");
    await addManiaBeatmap(db, 80, 7);
    await addPlay(db, { userId: 8, beatmapId: 80, pp: 180, day: "2026-06-01", accuracy: 0.94, rank: "A", mods: ["EZ"] });
    await addPlay(db, {
      userId: 8,
      beatmapId: 80,
      pp: 240,
      day: "2026-07-02",
      accuracy: 0.98,
      rank: "S",
      mods: ["DT", "CL"],
      maxCombo: 1234,
      hasReplay: true,
      soloScoreId: 9001,
      scoreId: 9001,
      statistics: { perfect: 900, great: 100, miss: 3 },
    });

    const tail = await getPlayerKeymodePpTail(db, 8);

    expect(tail.plays).toEqual([{
      beatmapId: 80,
      keyCount: 7,
      pp: 240,
      beatmapsetId: 80,
      title: "Fixture Song",
      artist: "fixture",
      version: "fixture",
      creator: "fixture",
      accuracy: 0.98,
      rank: "S",
      // CL is bookkeeping, not a mod anyone played with.
      mods: ["DT"],
      playedAt: "2026-07-02T00:00:00.000Z",
      maxCombo: 1234,
      hasReplay: true,
      soloScoreId: 9001,
      totalScore: null,
      // Same id in both columns, so this play was set on lazer.
      legacyScoreId: null,
      statistics: { perfect: 900, great: 100, miss: 3 },
      stars: null,
      bpm: null,
    }]);
  });

  it("marks a play with a legacy id beside its solo one as a stable score", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 81, 7);
    await addPlay(db, { userId: 8, beatmapId: 81, pp: 200, soloScoreId: 9002, scoreId: 4_123_456_789 });

    const [play] = (await getPlayerKeymodePpTail(db, 8)).plays;

    expect(play).toMatchObject({ soloScoreId: 9002, legacyScoreId: 4_123_456_789 });
  });

  it("sends the map's own stars and bpm, and no judgement counts it never kept", async () => {
    const db = await makeDb();
    await addManiaBeatmapWithDifficulty(db, 82, 4, 5.5, 190);
    await addPlay(db, { userId: 8, beatmapId: 82, pp: 210 });

    const [play] = (await getPlayerKeymodePpTail(db, 8)).plays;

    expect(play).toMatchObject({ stars: 5.5, bpm: 190, statistics: null });
  });
  it("reads combo and replay as unknown for plays ingested before they were kept", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 90, 4);
    await addPlay(db, { userId: 9, beatmapId: 90, pp: 150 });

    const tail = await getPlayerKeymodePpTail(db, 9);

    // Null, not zero: nobody knows this play's combo, and "0x" would be a lie.
    expect(tail.plays[0]).toMatchObject({ maxCombo: null, hasReplay: null, soloScoreId: null });
  });
});

describe("getPlayerKeymodePpKeyCounts", () => {
  it("names every keymode the tail has plays for, and nothing else", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 101, 4);
    await addManiaBeatmap(db, 102, 18);
    await addSearchIndexBeatmap(db, 103, 7);
    // A second 4K map must not make 4K appear twice.
    await addManiaBeatmap(db, 104, 4);
    await addPlay(db, { userId: 11, beatmapId: 101, pp: 300 });
    await addPlay(db, { userId: 11, beatmapId: 102, pp: 40 });
    await addPlay(db, { userId: 11, beatmapId: 103, pp: 120 });
    await addPlay(db, { userId: 11, beatmapId: 104, pp: 90 });

    const keys = await getPlayerKeymodePpKeyCounts(db, 11);
    const tailKeyCounts = [...new Set((await getPlayerKeymodePpTail(db, 11)).plays.map((play) => play.keyCount))].sort((a, b) => a - b);

    expect(keys).toMatchObject({ userId: 11, tracked: true, keyCounts: [4, 7, 18] });
    // The chips and the lists behind them have to agree, or a chip filters to nothing.
    expect(keys.keyCounts).toEqual(tailKeyCounts);
  });

  it("leaves out a map no mania source can name a key count for", async () => {
    const db = await makeDb();
    await addManiaBeatmap(db, 111, 4);
    await addPlay(db, { userId: 12, beatmapId: 111, pp: 200 });
    await addPlay(db, { userId: 12, beatmapId: 999, pp: 500 });

    expect(await getPlayerKeymodePpKeyCounts(db, 12)).toMatchObject({ tracked: true, keyCounts: [4] });
  });

  it("reads an untracked player as untracked with no keymodes", async () => {
    const db = await makeDb();

    expect(await getPlayerKeymodePpKeyCounts(db, 404)).toMatchObject({ tracked: false, keyCounts: [] });
  });
});
