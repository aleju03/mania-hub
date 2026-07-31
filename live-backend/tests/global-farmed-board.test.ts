import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import {
  catchUpGlobalFarmedBoard,
  getMapsPageSnapshot,
  refreshGlobalMaps,
  registerGlobalFarmedBoardDiskCache,
  waitForGlobalFarmedBoardBuild,
  type MapsPageQuery,
} from "../src/features/maps.js";
import {
  GLOBAL_FARMED_BOARD_DISK_FORMAT_VERSION,
  loadGlobalFarmedBoardFromDisk,
  saveGlobalFarmedBoardToDisk,
  type PersistedGlobalFarmedBoard,
} from "../src/features/maps-farmed-board-disk.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

const NOW = "2026-05-12T12:00:00.000Z";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const QUERY: MapsPageQuery = {
  tab: "farmed", page: 0, pageSize: 24, key: "all", beatmapSort: "players", farmedSort: "max-pp", dir: "desc", status: "all", pp: 0, mod: "all", q: "",
};

function sampleBoard(): PersistedGlobalFarmedBoard {
  return {
    generation: "projection:v1:seed:3",
    generatedAt: "2026-05-12T12:00:00Z",
    farmedGeneratedAt: "2026-05-12T12:05:00Z",
    favouritesGeneratedAt: "2026-05-12T12:00:00Z",
    projectionRevision: 7,
    entries: [
      { beatmapId: 11, start: 0, count: 2 },
      { beatmapId: 21, start: 2, count: 1 },
    ],
    userIds: Float64Array.from([101, 102, 9_007_199_254_740_991]),
    pps: Float64Array.from([650.25, 600, 550]),
    modsIdx: Uint32Array.from([1, 0, 0]),
    // A null playedAt is stored as NaN; the round trip must preserve it.
    playedAtMs: Float64Array.from([1_777_000_000_000, Number.NaN, 1_777_000_100_000]),
    scoreIds: Float64Array.from([6_665_949_113, 0, 12]),
    scoreUrlOverrides: new Map([[1, "https://example.test/scores/abc"]]),
    modsDict: [[], ["DT", "HD"]],
    modsFlags: Uint8Array.from([0, 1]),
    metadata: new Map([
      [11, { beatmapId: 11, cs: 4, difficultyRating: 5.5, version: "[4K] A", title: "Song", artist: "Artist", creator: "Mapper", status: "ranked" }],
      [21, { beatmapId: 21, cs: 7, difficultyRating: 6.1, version: "[7K] B", title: "Tune", artist: "Artist", creator: "Mapper", status: "loved" }],
    ]),
  };
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("global farmed board disk snapshot", () => {
  it("round-trips a packed board through the disk format", async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-board-"));
    const path = join(dir, "board.bin");
    const board = sampleBoard();
    await saveGlobalFarmedBoardToDisk(path, board);
    const loaded = await loadGlobalFarmedBoardFromDisk(path, { generation: board.generation, maxRevision: board.projectionRevision });
    expect(loaded).toEqual(board);
    // NaN round-trips (toEqual treats NaN as equal to itself, so pin it).
    expect(Number.isNaN(loaded!.playedAtMs[1])).toBe(true);
  });

  it("round-trips an empty board", async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-board-"));
    const path = join(dir, "board.bin");
    const board: PersistedGlobalFarmedBoard = {
      ...sampleBoard(),
      entries: [],
      userIds: new Float64Array(0),
      pps: new Float64Array(0),
      modsIdx: new Uint32Array(0),
      playedAtMs: new Float64Array(0),
      scoreIds: new Float64Array(0),
      scoreUrlOverrides: new Map(),
      modsDict: [],
      modsFlags: new Uint8Array(0),
      metadata: new Map(),
    };
    await saveGlobalFarmedBoardToDisk(path, board);
    expect(await loadGlobalFarmedBoardFromDisk(path, { generation: board.generation, maxRevision: 7 })).toEqual(board);
  });

  it("invalidates on generation (seed epoch) mismatch", async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-board-"));
    const path = join(dir, "board.bin");
    await saveGlobalFarmedBoardToDisk(path, sampleBoard());
    expect(await loadGlobalFarmedBoardFromDisk(path, { generation: "projection:v1:seed:4", maxRevision: 100 })).toBeNull();
    // The stale snapshot is deleted so it is never re-probed.
    expect(await fileExists(path)).toBe(false);
  });

  it("invalidates a snapshot whose revision is ahead of the database", async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-board-"));
    const path = join(dir, "board.bin");
    const board = sampleBoard();
    await saveGlobalFarmedBoardToDisk(path, board);
    expect(await loadGlobalFarmedBoardFromDisk(path, { generation: board.generation, maxRevision: board.projectionRevision - 1 })).toBeNull();
    expect(await fileExists(path)).toBe(false);
  });

  it("invalidates on a format version bump or corrupted magic", async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-board-"));
    const board = sampleBoard();

    const versionPath = join(dir, "version.bin");
    await saveGlobalFarmedBoardToDisk(versionPath, board);
    const bumped = Buffer.from(await readFile(versionPath));
    bumped.writeUInt32LE(GLOBAL_FARMED_BOARD_DISK_FORMAT_VERSION + 1, 4);
    await writeFile(versionPath, bumped);
    expect(await loadGlobalFarmedBoardFromDisk(versionPath, { generation: board.generation, maxRevision: 100 })).toBeNull();
    expect(await fileExists(versionPath)).toBe(false);

    const magicPath = join(dir, "magic.bin");
    await saveGlobalFarmedBoardToDisk(magicPath, board);
    const garbled = Buffer.from(await readFile(magicPath));
    garbled.write("NOPE", 0, "ascii");
    await writeFile(magicPath, garbled);
    expect(await loadGlobalFarmedBoardFromDisk(magicPath, { generation: board.generation, maxRevision: 100 })).toBeNull();
    expect(await fileExists(magicPath)).toBe(false);
  });

  it("invalidates a truncated snapshot", async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-board-"));
    const path = join(dir, "board.bin");
    const board = sampleBoard();
    await saveGlobalFarmedBoardToDisk(path, board);
    const whole = await readFile(path);
    await writeFile(path, whole.subarray(0, whole.byteLength - 8));
    expect(await loadGlobalFarmedBoardFromDisk(path, { generation: board.generation, maxRevision: 100 })).toBeNull();
    expect(await fileExists(path)).toBe(false);
  });
});

async function setupDb() {
  dir = await mkdtemp(join(tmpdir(), "mania-farmed-board-"));
  const databaseUrl = `file:${join(dir, "test.db")}`;
  const db = await createDb({ databaseUrl });
  await migrate(db);
  return { db, queue: new JobQueue(db), databaseUrl };
}

async function seedFarmedMap(
  db: Awaited<ReturnType<typeof createDb>>,
  setId: number,
  beatmapId: number,
  users: Array<{ id: number; pp: number }>,
): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmapsets
       (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
     values (?, ?, 'Artist', 'Mapper', 'ranked', '{}', 1, 1, '', 180, '[4]', '[]', ?)`,
    [setId, `Set ${setId}`, NOW],
  );
  await exec(
    db,
    `insert into maps_beatmaps
       (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
     values (?, ?, 'mania', 'ranked', 4, 5.5, 180, 120, ?, ?, ?)`,
    [beatmapId, setId, `[4K] ${beatmapId}`, `https://osu.ppy.sh/beatmaps/${beatmapId}`, NOW],
  );
  for (const user of users) {
    await exec(
      db,
      `insert into country_maps_farmed_scores
         (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
       values ('CR', ?, ?, ?, ?, '{}', '[]', null, ?, ?, ?)`,
      [user.id, beatmapId, user.id * 1000 + beatmapId, user.pp, NOW, NOW, NOW],
    );
  }
}

// Mimics the production write point: a new score row plus its aggregate, one
// change row carrying the bumped revision, and the state revision itself.
async function injectProjectionDelta(
  db: Awaited<ReturnType<typeof createDb>>,
  beatmapId: number,
  userId: number,
  pp: number,
): Promise<void> {
  await exec(db, "update global_maps_farmed_state set revision = revision + 1, updated_at = ? where singleton = 1", [NOW]);
  await exec(
    db,
    `insert into global_maps_farmed_scores
       (beatmap_id, user_id, pp, mods_json, speed_mod, score_url, played_at, detected_at, source_country, source_updated_at)
     values (?, ?, ?, '[]', null, null, ?, ?, 'CR', ?)`,
    [beatmapId, userId, pp, NOW, NOW, NOW],
  );
  await exec(
    db,
    `insert into global_maps_farmed_aggregates (beatmap_id, player_count, pp_sum, avg_pp, max_pp, dominant_mod, revision, updated_at)
     values (?, 1, ?, ?, ?, null, (select revision from global_maps_farmed_state where singleton = 1), ?)`,
    [beatmapId, pp, pp, pp, NOW],
  );
  await exec(
    db,
    `insert into global_maps_farmed_changes (beatmap_id, revision, updated_at)
     values (?, (select revision from global_maps_farmed_state where singleton = 1), ?)
     on conflict(beatmap_id) do update set revision = excluded.revision, updated_at = excluded.updated_at`,
    [beatmapId, NOW],
  );
}

function pageIds(page: Awaited<ReturnType<typeof getMapsPageSnapshot>>): number[] {
  return (page.value?.items ?? []).map((item) => (item as { beatmapId: number }).beatmapId);
}

describe("global farmed board persistence and catch-up", () => {
  it("persists the packed board on pack and restores it on a cold process", async () => {
    const { db, queue, databaseUrl } = await setupDb();
    registerGlobalFarmedBoardDiskCache(db, databaseUrl);
    await seedFarmedMap(db, 10, 11, [{ id: 101, pp: 650 }, { id: 102, pp: 600 }]);
    await refreshGlobalMaps(db);

    const first = await getMapsPageSnapshot(db, queue, "GLOBAL", WEEK_MS, QUERY);
    expect(pageIds(first)).toEqual([11]);
    const cachePath = join(dir, "global-farmed-board-cache.bin");
    expect(await fileExists(cachePath)).toBe(true);

    // Deleting the projection's score rows makes a full repack observably
    // different (it would find zero players): the cold connection below can
    // only answer with players by restoring the disk snapshot.
    await exec(db, "delete from global_maps_farmed_scores");

    const coldDb = await createDb({ databaseUrl });
    registerGlobalFarmedBoardDiskCache(coldDb, databaseUrl);
    const coldPage = await getMapsPageSnapshot(coldDb, new JobQueue(coldDb), "GLOBAL", WEEK_MS, QUERY);
    expect(pageIds(coldPage)).toEqual([11]);
    expect((coldPage.value?.items[0] as { playerCount: number }).playerCount).toBe(2);
  });

  it("patches a restored board forward with deltas written after the pack", async () => {
    const { db, queue, databaseUrl } = await setupDb();
    registerGlobalFarmedBoardDiskCache(db, databaseUrl);
    await seedFarmedMap(db, 10, 11, [{ id: 101, pp: 650 }, { id: 102, pp: 600 }]);
    await refreshGlobalMaps(db);
    await getMapsPageSnapshot(db, queue, "GLOBAL", WEEK_MS, QUERY);

    // A new map lands after the snapshot was written.
    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (20, 'Set 20', 'Artist', 'Mapper', 'ranked', '{}', 1, 1, '', 180, '[4]', '[]', ?)`,
      [NOW],
    );
    await exec(
      db,
      `insert into maps_beatmaps
         (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
       values (21, 20, 'mania', 'ranked', 4, 6.5, 180, 120, '[4K] 21', 'https://osu.ppy.sh/beatmaps/21', ?)`,
      [NOW],
    );
    await injectProjectionDelta(db, 21, 303, 700);

    const coldDb = await createDb({ databaseUrl });
    registerGlobalFarmedBoardDiskCache(coldDb, databaseUrl);
    const coldPage = await getMapsPageSnapshot(coldDb, new JobQueue(coldDb), "GLOBAL", WEEK_MS, QUERY);
    // 21 (700pp) outranks 11 (650pp) under max-pp: the restored board carries
    // the post-snapshot delta, not just the packed base.
    expect(pageIds(coldPage)).toEqual([21, 11]);
  });

  it("applies pending deltas from the background ticker, not the request path", async () => {
    const { db, queue } = await setupDb();
    await seedFarmedMap(db, 10, 11, [{ id: 101, pp: 650 }, { id: 102, pp: 600 }]);
    await refreshGlobalMaps(db);
    expect(pageIds(await getMapsPageSnapshot(db, queue, "GLOBAL", WEEK_MS, QUERY))).toEqual([11]);

    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (20, 'Set 20', 'Artist', 'Mapper', 'ranked', '{}', 1, 1, '', 180, '[4]', '[]', ?)`,
      [NOW],
    );
    await exec(
      db,
      `insert into maps_beatmaps
         (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
       values (21, 20, 'mania', 'ranked', 4, 6.5, 180, 120, '[4K] 21', 'https://osu.ppy.sh/beatmaps/21', ?)`,
      [NOW],
    );
    await injectProjectionDelta(db, 21, 303, 700);

    // A tick (what the 30s interval runs) converges the board with no request
    // involved at all.
    await catchUpGlobalFarmedBoard(db);
    await waitForGlobalFarmedBoardBuild(db);
    expect(pageIds(await getMapsPageSnapshot(db, queue, "GLOBAL", WEEK_MS, QUERY))).toEqual([21, 11]);
  });
});
