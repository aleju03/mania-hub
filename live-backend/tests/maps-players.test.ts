import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getMapsPlayersSnapshot } from "../src/features/maps.js";

// The per-map player boards are served straight from the normalized tables
// (country_maps_farmed_scores / country_maps_most_played /
// country_maps_favourite_sets). The expectations below are hand-derived from
// the previous snapshot-scan implementation's aggregation rules on the same
// fixture: farmed keeps the best-pp row per user, popular sums play counts per
// user, favourite keeps distinct users, and GLOBAL folds every non-GLOBAL
// country before deduplicating.

const FARMED_MAP = 900;
const FARMED_TIE_MAP = 902;
const POPULAR_MAP = 910;
const FAVOURITE_SET = 920;

describe("getMapsPlayersSnapshot", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-maps-players-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await seedFixture(db);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedUser(id: number, username: string, countryCode: string): Promise<void> {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, ?, '2026-01-01')",
      [id, username, `https://a.ppy.sh/${id}`, countryCode],
    );
  }

  async function seedFarmed(
    country: string,
    userId: number,
    beatmapId: number,
    pp: number,
    extra: { mods?: string[]; scoreUrl?: string | null; playedAt?: string | null; detectedAt?: string } = {},
  ): Promise<void> {
    await exec(
      db,
      `insert into country_maps_farmed_scores
         (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
       values (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, '2026-01-02')`,
      [
        country,
        userId,
        beatmapId,
        userId * 10 + beatmapId,
        pp,
        JSON.stringify(extra.mods ?? []),
        extra.scoreUrl ?? null,
        extra.playedAt ?? null,
        extra.detectedAt ?? "2026-01-01T00:00:00Z",
      ],
    );
  }

  async function seedRoster(country: string, userId: number, rank: number | null, isTracked: number): Promise<void> {
    await exec(
      db,
      "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values (?, ?, ?, 'ranking', ?, '2026-01-01')",
      [country, userId, rank, isTracked],
    );
  }

  async function seedFixture(database: Db): Promise<void> {
    await seedUser(101, "Alpha", "CR");
    await seedUser(102, "bravo", "CR");
    await seedUser(103, "Charlie", "US");
    await seedUser(104, "delta", "US");
    await seedUser(106, "Foxtrot", "CR");
    // User 105 is deliberately absent from users: display falls back to "User 105".

    await seedRoster("CR", 101, 1, 1);
    await seedRoster("CR", 102, 2, 1);
    await seedRoster("CR", 105, 3, 1);
    await seedRoster("US", 103, 1, 1);
    await seedRoster("US", 104, 2, 1);
    // 101 is tracked in both countries, so GLOBAL sums their rows from both;
    // rows from a country that no longer tracks the user would not count.
    await seedRoster("US", 101, 3, 1);
    // 106 fell off the CR roster: soft-untracked, rank cleared. Their
    // popular/favourite rows below must stay off the boards; their farmed
    // score stays on (the farmed modal always included raw score rows).
    await seedRoster("CR", 106, null, 0);

    // Farmed: user 101 has rows in both CR and US (best pp must win for GLOBAL),
    // 104's zero-pp row must be excluded, and beatmap 901 must not leak in.
    await seedFarmed("CR", 101, FARMED_MAP, 300, { mods: ["DT"], scoreUrl: "https://osu.ppy.sh/scores/1", playedAt: "2026-01-01T10:00:00Z" });
    await seedFarmed("CR", 102, FARMED_MAP, 500);
    await seedFarmed("CR", 105, FARMED_MAP, 200);
    await seedFarmed("CR", 104, FARMED_MAP, 0);
    await seedFarmed("CR", 106, FARMED_MAP, 100);
    await seedFarmed("CR", 102, 901, 999);
    await seedFarmed("US", 101, FARMED_MAP, 350, { mods: ["MR"], scoreUrl: "https://osu.ppy.sh/scores/2", playedAt: "2026-01-02T10:00:00Z" });
    await seedFarmed("US", 103, FARMED_MAP, 400);
    // Equal pp on another map: the tie must break deterministically by user id.
    await seedFarmed("CR", 102, FARMED_TIE_MAP, 250);
    await seedFarmed("CR", 101, FARMED_TIE_MAP, 250);

    // Popular: user 101 is tracked in CR and US (counts sum for GLOBAL);
    // 103's CR row is a leftover from a country that no longer tracks them
    // (only the US 30 may count); 104's zero count is excluded; untracked
    // 106's chart-topping count must never surface.
    const popularRows: Array<[string, number, number]> = [
      ["CR", 101, 40],
      ["CR", 102, 10],
      ["CR", 103, 7],
      ["CR", 106, 99],
      ["US", 101, 5],
      ["US", 103, 30],
      ["US", 104, 0],
    ];
    for (const [country, userId, count] of popularRows) {
      await exec(
        database,
        "insert into country_maps_most_played (country, user_id, beatmap_id, play_count, updated_at) values (?, ?, ?, ?, '2026-01-02')",
        [country, userId, POPULAR_MAP, count],
      );
    }

    // Favourites: user 101 favourited the set from two countries (must stay
    // one row on the GLOBAL board); untracked 106's favourite must not count.
    const favouriteRows: Array<[string, number]> = [
      ["CR", 101],
      ["CR", 102],
      ["CR", 106],
      ["US", 101],
      ["US", 104],
    ];
    for (const [country, userId] of favouriteRows) {
      await exec(
        database,
        "insert into country_maps_favourite_sets (country, user_id, beatmapset_id, updated_at) values (?, ?, ?, '2026-01-02')",
        [country, userId, FAVOURITE_SET],
      );
    }

    // A stale country snapshot carrying a phantom player (999) on every board.
    // The payload is a fully valid compact snapshot (schemaVersion 2 with all
    // section arrays — the shape the old reader accepted), so if the players
    // path ever consulted snapshots again, 999 would surface.
    await exec(
      database,
      "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values ('CR', ?, '2026-01-01', '2026-01-01')",
      [JSON.stringify({
        schemaVersion: 2,
        farmed: [{ beatmapId: FARMED_MAP, playerCount: 1, avgPp: 9999, maxPp: 9999, players: [{ id: 999, pp: 9999, mods: [], scoreUrl: null, playedAt: null }] }],
        mostPlayed: [{ beatmapId: POPULAR_MAP, totalPlays: 9999, playerCount: 1, players: [{ id: 999, count: 9999 }] }],
        favourites: [{ beatmapsetId: FAVOURITE_SET, playerCount: 1, players: [{ id: 999 }] }],
        favouritesByPlayer: [],
        beatmapsetsPool: [],
        generatedAt: "2026-01-01T00:00:00Z",
        farmedGeneratedAt: "2026-01-01T00:00:00Z",
        favouritesGeneratedAt: "2026-01-01T00:00:00Z",
      })],
    );
  }

  it("serves the CR farmed board with best-pp ordering and metadata passthrough", async () => {
    const value = await getMapsPlayersSnapshot(db, "CR", "farmed", FARMED_MAP);
    expect(value).toMatchObject({ kind: "farmed", id: FARMED_MAP, total: 4, matched: 4, page: 0 });
    expect(value.players).toEqual([
      { id: 102, username: "bravo", avatarUrl: "https://a.ppy.sh/102", rank: 1, pp: 500, mods: [], scoreUrl: null, playedAt: null },
      { id: 101, username: "Alpha", avatarUrl: "https://a.ppy.sh/101", rank: 2, pp: 300, mods: ["DT"], scoreUrl: "https://osu.ppy.sh/scores/1", playedAt: "2026-01-01T10:00:00Z" },
      { id: 105, username: "User 105", avatarUrl: "", rank: 3, pp: 200, mods: [], scoreUrl: null, playedAt: null },
      // Untracked 106 stays on the farmed board: the old modal always merged
      // raw score rows in, roster or not.
      { id: 106, username: "Foxtrot", avatarUrl: "https://a.ppy.sh/106", rank: 4, pp: 100, mods: [], scoreUrl: null, playedAt: null },
    ]);
  });

  it("folds every country on the GLOBAL farmed board, best pp per duplicated user", async () => {
    const value = await getMapsPlayersSnapshot(db, "GLOBAL", "farmed", FARMED_MAP);
    expect(value.total).toBe(5);
    expect(value.players.map((player) => [player.id, player.pp, player.rank])).toEqual([
      [102, 500, 1],
      [103, 400, 2],
      [101, 350, 3],
      [105, 200, 4],
      [106, 100, 5],
    ]);
    // 101's US row (350pp) beat the CR row: its metadata must ride along.
    expect(value.players[2]).toMatchObject({ mods: ["MR"], scoreUrl: "https://osu.ppy.sh/scores/2" });
    // The stale CR snapshot's phantom player must not appear.
    expect(value.players.some((player) => player.id === 999)).toBe(false);
  });

  it("breaks equal-pp ties by user id for stable pagination", async () => {
    const value = await getMapsPlayersSnapshot(db, "CR", "farmed", FARMED_TIE_MAP);
    expect(value.players.map((player) => [player.id, player.rank])).toEqual([[101, 1], [102, 2]]);
  });

  it("serves the popular board per country and sums counts across countries for GLOBAL", async () => {
    // Untracked 106's count-99 row would top both boards if the roster join
    // were missing.
    const cr = await getMapsPlayersSnapshot(db, "CR", "popular", POPULAR_MAP);
    expect(cr.total).toBe(2);
    expect(cr.players).toEqual([
      { id: 101, username: "Alpha", avatarUrl: "https://a.ppy.sh/101", rank: 1, count: 40 },
      { id: 102, username: "bravo", avatarUrl: "https://a.ppy.sh/102", rank: 2, count: 10 },
    ]);

    const global = await getMapsPlayersSnapshot(db, "GLOBAL", "popular", POPULAR_MAP);
    expect(global.total).toBe(3);
    expect(global.players.map((player) => [player.id, player.count, player.rank])).toEqual([
      [101, 45, 1],
      [103, 30, 2],
      [102, 10, 3],
    ]);
  });

  it("serves distinct favourite users ordered by display name", async () => {
    // Untracked 106's favourite row must stay off both boards.
    const cr = await getMapsPlayersSnapshot(db, "CR", "favourite", FAVOURITE_SET);
    expect(cr.players).toEqual([
      { id: 101, username: "Alpha", avatarUrl: "https://a.ppy.sh/101", rank: 1 },
      { id: 102, username: "bravo", avatarUrl: "https://a.ppy.sh/102", rank: 2 },
    ]);

    const global = await getMapsPlayersSnapshot(db, "GLOBAL", "favourite", FAVOURITE_SET);
    expect(global.total).toBe(3);
    expect(global.players.map((player) => [player.id, player.username, player.rank])).toEqual([
      [101, "Alpha", 1],
      [102, "bravo", 2],
      [104, "delta", 3],
    ]);
  });

  it("search keeps the true rank from the unfiltered board", async () => {
    const value = await getMapsPlayersSnapshot(db, "GLOBAL", "farmed", FARMED_MAP, { page: 0, pageSize: 50, q: "USER" });
    expect(value.total).toBe(5);
    expect(value.matched).toBe(1);
    expect(value.players).toEqual([
      { id: 105, username: "User 105", avatarUrl: "", rank: 4, pp: 200, mods: [], scoreUrl: null, playedAt: null },
    ]);

    const fav = await getMapsPlayersSnapshot(db, "GLOBAL", "favourite", FAVOURITE_SET, { page: 0, pageSize: 50, q: "DELT" });
    expect(fav).toMatchObject({ total: 3, matched: 1 });
    expect(fav.players.map((player) => [player.id, player.rank])).toEqual([[104, 3]]);
  });

  it("pages the board in SQL with counts on every page", async () => {
    const page0 = await getMapsPlayersSnapshot(db, "GLOBAL", "farmed", FARMED_MAP, { page: 0, pageSize: 2, q: "" });
    expect(page0).toMatchObject({ total: 5, matched: 5, page: 0, pageSize: 2 });
    expect(page0.players.map((player) => player.id)).toEqual([102, 103]);

    const page1 = await getMapsPlayersSnapshot(db, "GLOBAL", "farmed", FARMED_MAP, { page: 1, pageSize: 2, q: "" });
    expect(page1).toMatchObject({ total: 5, matched: 5 });
    expect(page1.players.map((player) => player.id)).toEqual([101, 105]);

    const beyond = await getMapsPlayersSnapshot(db, "GLOBAL", "farmed", FARMED_MAP, { page: 50, pageSize: 2, q: "" });
    expect(beyond).toMatchObject({ total: 5, matched: 5, players: [] });
  });

  it("returns an empty board for maps with no rows and for invalid ids", async () => {
    const empty = await getMapsPlayersSnapshot(db, "CR", "popular", 777777);
    expect(empty).toMatchObject({ total: 0, matched: 0, players: [] });

    const invalid = await getMapsPlayersSnapshot(db, "CR", "farmed", 0);
    expect(invalid).toMatchObject({ id: 0, total: 0, matched: 0, players: [] });
  });
});
