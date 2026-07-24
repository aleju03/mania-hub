import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getMapsRandomDraw, type MapsRandomDrawQuery, type MapsRandomDrawValue } from "../src/features/maps.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { routeHttp } from "../src/http/snapshots.js";

// The Random draw is served straight from the normalized tables
// (country_maps_favourite_sets + country_rosters + maps_beatmapsets +
// maps_beatmaps), never from country_maps_snapshots.payload_json. The
// expectations below are hand-derived from the filter rules the browser used to
// apply to the downloaded pool: status/key/pattern chips are include-any /
// exclude-any over the set's own metadata, stars are a range OVERLAP, and only
// currently tracked + ranked roster members may appear.

// Set 201: ranked, 4K, jack + chordjack, stars 3.0 - 5.0
// Set 202: loved, 7K, stream, star 6.5
// Set 203: graveyard, 4K + 7K, ln, star 2.0
// Set 204: pending (-> "other"), 5K, tech, star 8.0
// Set 206: ranked, 4K, tiebreaker — favourited, but has no maps_beatmaps rows
const RANKED_SET = 201;
const LOVED_SET = 202;
const GRAVEYARD_SET = 203;
const OTHER_SET = 204;
const UNRENDERABLE_SET = 206;

const NOW = "2026-07-01T00:00:00.000Z";
const GLOBAL_STAMP = "2026-07-01T00:00:01.000Z";

function drawQuery(overrides: Partial<MapsRandomDrawQuery> = {}): MapsRandomDrawQuery {
  return {
    weight: "favourites",
    // Larger than any fixture pool, so a draw returns every eligible pair and
    // the assertions stay deterministic despite `order by random()`.
    count: 24,
    status: [],
    statusExclude: [],
    keys: [],
    keysExclude: [],
    patterns: [],
    patternsExclude: [],
    starMin: 0,
    starMax: 0,
    excludeUsers: [],
    excludeSets: [],
    hideUsers: [],
    ...overrides,
  };
}

function pairsOf(value: MapsRandomDrawValue | null): Array<[number, number]> {
  return (value?.picks ?? [])
    .map((pick): [number, number] => [pick.player.id, pick.beatmapset.id])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

describe("getMapsRandomDraw", () => {
  let dir = "";
  let db: Db;
  let queue: JobQueue;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-maps-random-draw-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    queue = new JobQueue(db);
    await seedFixture();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedUser(id: number, username: string): Promise<void> {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, 'CR', ?)",
      [id, username, `https://a.ppy.sh/${id}`, NOW],
    );
  }

  async function seedRoster(country: string, userId: number, rank: number | null, isTracked: number): Promise<void> {
    await exec(
      db,
      "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values (?, ?, ?, 'ranking', ?, ?)",
      [country, userId, rank, isTracked, NOW],
    );
  }

  async function seedBeatmapset(
    id: number,
    status: string,
    maniaKeys: number[],
    patterns: string[],
    stars: number[],
  ): Promise<void> {
    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (?, ?, 'Artist', 'Creator', ?, ?, 1000, 50, 'https://b.ppy.sh/preview.mp3', 180, ?, ?, ?)`,
      [
        id,
        `Set ${id}`,
        status,
        JSON.stringify({ cover: `cover-${id}`, card: `card-${id}`, list: `list-${id}`, slimcover: `slim-${id}` }),
        JSON.stringify(maniaKeys),
        JSON.stringify(patterns),
        NOW,
      ],
    );
    for (const [index, star] of stars.entries()) {
      await exec(
        db,
        `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
         values (?, ?, 'mania', ?, ?, ?, 180, 120, ?, ?, ?)`,
        [id * 10 + index, id, status, maniaKeys[0] ?? 4, star, `Diff ${index}`, `https://osu.ppy.sh/beatmaps/${id * 10 + index}`, NOW],
      );
    }
  }

  async function seedFavourite(country: string, userId: number, beatmapsetId: number): Promise<void> {
    await exec(
      db,
      "insert into country_maps_favourite_sets (country, user_id, beatmapset_id, updated_at) values (?, ?, ?, ?)",
      [country, userId, beatmapsetId, NOW],
    );
  }

  async function seedFixture(): Promise<void> {
    await seedUser(101, "Alpha");
    await seedUser(102, "bravo");
    await seedUser(103, "Charlie");
    await seedUser(104, "delta");
    await seedUser(106, "Foxtrot");
    await seedUser(107, "Golf");
    await seedUser(108, "Hotel");
    // 105 is deliberately absent from users: display falls back to "User 105".

    await seedRoster("CR", 101, 1, 1);
    await seedRoster("CR", 102, 2, 1);
    await seedRoster("CR", 105, 3, 1);
    await seedRoster("CR", 108, 4, 1);
    // 106 was soft-untracked and 107 dropped off the ranking: both keep their
    // favourite rows, and neither may reach a draw.
    await seedRoster("CR", 106, null, 0);
    await seedRoster("CR", 107, null, 1);
    await seedRoster("US", 103, 1, 1);
    await seedRoster("US", 104, 2, 1);
    // 101 is tracked in both countries, so their duplicated favourite row must
    // collapse to one pair on a GLOBAL draw.
    await seedRoster("US", 101, 3, 1);

    await seedBeatmapset(RANKED_SET, "ranked", [4], ["jack", "chordjack"], [3, 5]);
    await seedBeatmapset(LOVED_SET, "loved", [7], ["stream"], [6.5]);
    await seedBeatmapset(GRAVEYARD_SET, "graveyard", [4, 7], ["ln"], [2]);
    await seedBeatmapset(OTHER_SET, "pending", [5], ["tech"], [8]);
    await seedBeatmapset(UNRENDERABLE_SET, "ranked", [4], ["tiebreaker"], []);

    await seedFavourite("CR", 101, RANKED_SET);
    await seedFavourite("CR", 101, LOVED_SET);
    await seedFavourite("CR", 102, RANKED_SET);
    await seedFavourite("CR", 102, GRAVEYARD_SET);
    await seedFavourite("CR", 105, OTHER_SET);
    await seedFavourite("CR", 108, UNRENDERABLE_SET);
    await seedFavourite("CR", 106, RANKED_SET);
    await seedFavourite("CR", 107, LOVED_SET);
    await seedFavourite("US", 103, RANKED_SET);
    await seedFavourite("US", 104, LOVED_SET);
    await seedFavourite("US", 104, GRAVEYARD_SET);
    await seedFavourite("US", 101, RANKED_SET);

    // Snapshot rows only carry the stamps the draw reports; the payload is
    // deliberately junk to prove it is never parsed.
    for (const [country, refreshedAt] of [["CR", NOW], ["GLOBAL", GLOBAL_STAMP]] as const) {
      await exec(
        db,
        "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values (?, 'not json', ?, ?)",
        [country, refreshedAt, refreshedAt],
      );
    }
  }

  const draw = (country: string, overrides: Partial<MapsRandomDrawQuery> = {}) =>
    getMapsRandomDraw(db, queue, country, 30 * 24 * 60 * 60_000, drawQuery(overrides));

  it("draws every eligible pair in favourites mode and reports the pool counts", async () => {
    const snapshot = await draw("CR");
    expect(snapshot).toMatchObject({ generatedAt: NOW, refreshedAt: NOW, isStale: false, refreshQueued: false });
    // Six eligible pairs: untracked 106 and unranked 107 are excluded by the
    // roster join, and the US rows are out of scope.
    expect(snapshot.value).toMatchObject({ country: "CR", weight: "favourites", totalPicks: 6, uniqueSets: 5 });
    // Set 206 has no beatmap rows, so it counts as a pick but cannot render.
    expect(pairsOf(snapshot.value)).toEqual([
      [101, RANKED_SET],
      [101, LOVED_SET],
      [102, RANKED_SET],
      [102, GRAVEYARD_SET],
      [105, OTHER_SET],
    ]);
  });

  it("draws at most one set per player in players mode", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await draw("CR", { weight: "players" });
      expect(snapshot.value).toMatchObject({ weight: "players", totalPicks: 6, uniqueSets: 5 });
      const picks = snapshot.value?.picks ?? [];
      const playerIds = picks.map((pick) => pick.player.id);
      expect([...new Set(playerIds)]).toEqual(playerIds);
      // 108's only favourite cannot render, so the batch is 101/102/105.
      expect([...playerIds].sort((a, b) => a - b)).toEqual([101, 102, 105]);
      const favouritesByPlayer = new Map<number, number[]>([
        [101, [RANKED_SET, LOVED_SET]],
        [102, [RANKED_SET, GRAVEYARD_SET]],
        [105, [OTHER_SET]],
      ]);
      for (const pick of picks) {
        expect(favouritesByPlayer.get(pick.player.id)).toContain(pick.beatmapset.id);
      }
    }
  });

  it("folds every country into GLOBAL and counts a doubly tracked player once", async () => {
    const snapshot = await draw("GLOBAL");
    // CR's six pairs plus US 103/201, 104/202, 104/203 — 101/201 arrives from
    // both countries and must not be double-counted.
    expect(snapshot.value).toMatchObject({ country: "GLOBAL", totalPicks: 9, uniqueSets: 5 });
    expect(pairsOf(snapshot.value)).toEqual([
      [101, RANKED_SET],
      [101, LOVED_SET],
      [102, RANKED_SET],
      [102, GRAVEYARD_SET],
      [103, RANKED_SET],
      [104, LOVED_SET],
      [104, GRAVEYARD_SET],
      [105, OTHER_SET],
    ]);
  });

  it("keeps untracked and unranked roster members off every draw", async () => {
    for (const country of ["CR", "GLOBAL"]) {
      const snapshot = await draw(country);
      const playerIds = new Set((snapshot.value?.picks ?? []).map((pick) => pick.player.id));
      expect(playerIds.has(106)).toBe(false);
      expect(playerIds.has(107)).toBe(false);
    }
  });

  it("filters by status bucket, including and excluding", async () => {
    const ranked = await draw("CR", { status: ["ranked"] });
    expect(ranked.value).toMatchObject({ totalPicks: 3, uniqueSets: 2 });
    expect(pairsOf(ranked.value)).toEqual([[101, RANKED_SET], [102, RANKED_SET]]);

    const notRanked = await draw("CR", { statusExclude: ["ranked"] });
    expect(notRanked.value).toMatchObject({ totalPicks: 3, uniqueSets: 3 });
    expect(pairsOf(notRanked.value)).toEqual([[101, LOVED_SET], [102, GRAVEYARD_SET], [105, OTHER_SET]]);

    // "pending" is not one of the three named buckets, so it lands in "other".
    const other = await draw("CR", { status: ["other"] });
    expect(pairsOf(other.value)).toEqual([[105, OTHER_SET]]);
  });

  it("filters by key bucket over the set's whole key list", async () => {
    // 203 is a 4K+7K set: an include chip keeps it, an exclude chip drops it.
    const fourKey = await draw("CR", { keys: ["4k"] });
    expect(fourKey.value).toMatchObject({ totalPicks: 4, uniqueSets: 3 });
    expect(pairsOf(fourKey.value)).toEqual([[101, RANKED_SET], [102, RANKED_SET], [102, GRAVEYARD_SET]]);

    const notSevenKey = await draw("CR", { keysExclude: ["7k"] });
    expect(notSevenKey.value).toMatchObject({ totalPicks: 4, uniqueSets: 3 });
    expect(pairsOf(notSevenKey.value)).toEqual([[101, RANKED_SET], [102, RANKED_SET], [105, OTHER_SET]]);

    // A 5K set is neither 4K nor 7K.
    expect(pairsOf((await draw("CR", { keys: ["other"] })).value)).toEqual([[105, OTHER_SET]]);
  });

  it("matches canonical pattern names verbatim without expanding umbrellas", async () => {
    const chordjack = await draw("CR", { patterns: ["chordjack"] });
    expect(chordjack.value).toMatchObject({ totalPicks: 2, uniqueSets: 1 });
    expect(pairsOf(chordjack.value)).toEqual([[101, RANKED_SET], [102, RANKED_SET]]);

    const notJack = await draw("CR", { patternsExclude: ["jack"] });
    expect(notJack.value).toMatchObject({ totalPicks: 4, uniqueSets: 4 });
    expect(pairsOf(notJack.value)).toEqual([[101, LOVED_SET], [102, GRAVEYARD_SET], [105, OTHER_SET]]);

    // "stream" does not sweep in "jumpstream"-style siblings server-side.
    expect(pairsOf((await draw("CR", { patterns: ["stream"] })).value)).toEqual([[101, LOVED_SET]]);
  });

  it("treats the star range as an overlap, not containment", async () => {
    // 201 spans 3.0-5.0; a 3-5 window keeps it and drops the 2.0/6.5/8.0 sets.
    const window = await draw("CR", { starMin: 3, starMax: 5 });
    expect(window.value).toMatchObject({ totalPicks: 2, uniqueSets: 1 });
    expect(pairsOf(window.value)).toEqual([[101, RANKED_SET], [102, RANKED_SET]]);

    // Floor only: a set qualifies when its hardest diff clears it.
    const hard = await draw("CR", { starMin: 6 });
    expect(hard.value).toMatchObject({ totalPicks: 2, uniqueSets: 2 });
    expect(pairsOf(hard.value)).toEqual([[101, LOVED_SET], [105, OTHER_SET]]);

    // Ceiling only: a set qualifies when its easiest diff stays under it.
    const easy = await draw("CR", { starMax: 2.5 });
    expect(easy.value).toMatchObject({ totalPicks: 1, uniqueSets: 1 });
    expect(pairsOf(easy.value)).toEqual([[102, GRAVEYARD_SET]]);

    // 201 straddles the window from below, so a floor inside its range keeps it.
    expect(pairsOf((await draw("CR", { starMin: 4.5, starMax: 5.5 })).value)).toEqual([
      [101, RANKED_SET],
      [102, RANKED_SET],
    ]);
  });

  it("combines set filters with the star range", async () => {
    const combined = await draw("GLOBAL", { keys: ["4k"], patternsExclude: ["ln"], starMin: 4 });
    expect(combined.value).toMatchObject({ totalPicks: 3, uniqueSets: 1 });
    expect(pairsOf(combined.value)).toEqual([[101, RANKED_SET], [102, RANKED_SET], [103, RANKED_SET]]);
  });

  it("excludes recent users and sets from the draw but not from the counts", async () => {
    const withoutUsers = await draw("CR", { excludeUsers: [101, 102] });
    expect(withoutUsers.value).toMatchObject({ totalPicks: 6, uniqueSets: 5 });
    expect(pairsOf(withoutUsers.value)).toEqual([[105, OTHER_SET]]);

    const withoutSets = await draw("CR", { excludeSets: [RANKED_SET, LOVED_SET] });
    expect(withoutSets.value).toMatchObject({ totalPicks: 6, uniqueSets: 5 });
    expect(pairsOf(withoutSets.value)).toEqual([[102, GRAVEYARD_SET], [105, OTHER_SET]]);
  });

  it("falls back to the unexcluded pool when the exclusions empty it", async () => {
    const snapshot = await draw("CR", {
      excludeUsers: [101, 102, 105, 108],
      excludeSets: [RANKED_SET, LOVED_SET, GRAVEYARD_SET, OTHER_SET, UNRENDERABLE_SET],
    });
    expect(snapshot.value).toMatchObject({ totalPicks: 6, uniqueSets: 5 });
    // Reroll can never dead-end: the batch comes back from the full pool.
    expect(pairsOf(snapshot.value)).toEqual([
      [101, RANKED_SET],
      [101, LOVED_SET],
      [102, RANKED_SET],
      [102, GRAVEYARD_SET],
      [105, OTHER_SET],
    ]);
  });

  it("does not fall back when the filters themselves leave nothing", async () => {
    const snapshot = await draw("CR", { patterns: ["bracket"], excludeUsers: [101] });
    expect(snapshot.value).toMatchObject({ totalPicks: 0, uniqueSets: 0, picks: [] });
  });

  it("hides users from both the picks and the counts", async () => {
    const snapshot = await draw("CR", { hideUsers: [101, 102] });
    expect(snapshot.value).toMatchObject({ totalPicks: 2, uniqueSets: 2 });
    expect(pairsOf(snapshot.value)).toEqual([[105, OTHER_SET]]);
  });

  it("keeps hidden users out of the pool even when they are also excluded", async () => {
    const snapshot = await draw("CR", { hideUsers: [101, 102, 105], excludeUsers: [108] });
    // The fallback drops the recency exclusions but never the hidden users, so
    // the only remaining pair is 108's unrenderable set.
    expect(snapshot.value).toMatchObject({ totalPicks: 1, uniqueSets: 1, picks: [] });
  });

  it("returns counts only for count=0", async () => {
    const snapshot = await draw("CR", { count: 0 });
    expect(snapshot.value).toMatchObject({ totalPicks: 6, uniqueSets: 5, picks: [] });

    const filtered = await draw("CR", { count: 0, status: ["ranked"] });
    expect(filtered.value).toMatchObject({ totalPicks: 3, uniqueSets: 2, picks: [] });
  });

  it("hydrates each pick with the full set record and its scope counts", async () => {
    const snapshot = await draw("CR", { patterns: ["chordjack"] });
    const pick = (snapshot.value?.picks ?? []).find((candidate) => candidate.player.id === 101);
    expect(pick).toBeDefined();
    expect(pick?.player).toMatchObject({
      id: 101,
      username: "Alpha",
      avatarUrl: "https://a.ppy.sh/101",
      // Unfiltered in-scope total: sets 201 and 202, not just the drawn one.
      favouriteCount: 2,
    });
    // Only the three covers the Random card renders survive the trim.
    expect(Object.keys(pick?.beatmapset.covers ?? {}).sort()).toEqual(["card", "cover", "list"]);
    expect(pick?.beatmapset).toMatchObject({
      id: RANKED_SET,
      title: `Set ${RANKED_SET}`,
      status: "ranked",
      maniaKeys: [4],
      patterns: ["jack", "chordjack"],
      starMin: 3,
      starMax: 5,
      previewUrl: "https://b.ppy.sh/preview.mp3",
    });
    expect(pick?.beatmapset.maniaBeatmaps?.length).toBe(2);
    // In CR, 101 and 102 favourited 201; untracked 106 does not count.
    expect(pick?.scopeFavCount).toBe(2);

    const global = await draw("GLOBAL", { patterns: ["chordjack"] });
    const globalPick = (global.value?.picks ?? []).find((candidate) => candidate.player.id === 101);
    // 101's two distinct sets across CR + US, and 201's three distinct favouriters.
    expect(globalPick?.player.favouriteCount).toBe(2);
    expect(globalPick?.scopeFavCount).toBe(3);
  });

  it("falls back to a placeholder username for a player with no users row", async () => {
    const snapshot = await draw("CR", { status: ["other"] });
    expect(snapshot.value?.picks[0]?.player).toMatchObject({ id: 105, username: "User 105", avatarUrl: "" });
  });

  it("clamps the batch size to what the set hydrator can serve", async () => {
    // The fixture pool is smaller than the clamp, so grow it well past 24 pairs
    // — all on one renderable set, so the count clamp is what bounds the batch
    // rather than the hydrator's own 24-distinct-sets cap.
    for (let index = 0; index < 40; index += 1) {
      const userId = 500 + index;
      await seedUser(userId, `Extra ${index}`);
      await seedRoster("CR", userId, 100 + index, 1);
      await seedFavourite("CR", userId, RANKED_SET);
    }

    // 108 is hidden so the one unrenderable pair cannot land in the batch and
    // make the drawn count ambiguous.
    const snapshot = await draw("CR", { count: 500, hideUsers: [108] });
    expect(snapshot.value?.totalPicks).toBe(45);
    expect(snapshot.value?.picks.length).toBe(24);
    // Every clamped row is a distinct pair, so the batch is 24 real picks
    // rather than 24 rows that collapsed on hydration.
    expect(new Set(pairsOf(snapshot.value).map((pair) => pair.join(":"))).size).toBe(24);
    // Far fewer than 24 distinct sets are in play, so the count clamp — not the
    // hydrator's own id cap — is what stopped the batch at 24.
    expect(new Set((snapshot.value?.picks ?? []).map((pick) => pick.beatmapset.id)).size).toBeLessThanOrEqual(4);
  });

  it("reports a null value and queues a build for a country with no snapshot", async () => {
    const snapshot = await getMapsRandomDraw(db, queue, "AU", 30 * 24 * 60 * 60_000, drawQuery());
    expect(snapshot).toMatchObject({ value: null, generatedAt: null, isStale: true, refreshQueued: true });
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_country_maps'")).rows[0].count)).toBe(1);
  });
});

describe("GET /api/snapshots/maps-random-draw", () => {
  let dir = "";
  let db: Db;
  let ctx: never;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-maps-random-draw-http-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    ctx = {
      db,
      queue: new JobQueue(db),
      events: new LiveEventLog(db),
      config: {
        allowedOrigins: ["http://localhost:3000"],
        trackedCountries: ["CR"],
        rosterRefreshIntervalMs: 24 * 60 * 60_000,
        mapsRefreshIntervalMs: 7 * 24 * 60 * 60_000,
      },
      osu: {},
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function request(url: string): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const writes: string[] = [];
    const headers: Record<string, string> = {};
    const req = new EventEmitter() as IncomingMessage;
    req.method = "GET";
    req.url = url;
    req.headers = { host: "localhost" };
    const res = {
      statusCode: 200,
      setHeader: vi.fn((key: string, value: string) => {
        headers[key.toLowerCase()] = String(value);
      }),
      getHeader: vi.fn((key: string) => headers[key.toLowerCase()]),
      end: vi.fn((chunk?: string) => {
        if (chunk != null) writes.push(String(chunk));
      }),
    } as unknown as ServerResponse & { statusCode: number };

    expect(await routeHttp(req, res, ctx)).toBe(true);
    return { status: res.statusCode, headers, body: JSON.parse(writes.join("")) };
  }

  it("queues a maps refresh for a cold country and never caches the draw", async () => {
    const response = await request("/api/snapshots/maps-random-draw?country=CR&count=8");
    expect(response.status).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ value: null, isStale: true, refreshQueued: true });
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_country_maps'")).rows[0].count)).toBe(1);
  });

  it("parses the filter query string and serves a hydrated batch", async () => {
    const stamp = new Date().toISOString();
    await exec(
      db,
      "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values ('CR', 'not json', ?, ?)",
      [stamp, stamp],
    );
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (401, 'India', 'https://a.ppy.sh/401', 'CR', ?)",
      [stamp],
    );
    await exec(
      db,
      "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', 401, 1, 'ranking', 1, ?)",
      [stamp],
    );
    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (301, 'Set 301', 'Artist', 'Creator', 'ranked', '{"card":"card-301"}', 10, 2, '', 200, '[4]', '["jack"]', ?)`,
      [stamp],
    );
    await exec(
      db,
      `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
       values (3010, 301, 'mania', 'ranked', 4, 4.5, 200, 100, 'Diff', '', ?)`,
      [stamp],
    );
    await exec(
      db,
      "insert into country_maps_favourite_sets (country, user_id, beatmapset_id, updated_at) values ('CR', 401, 301, ?)",
      [stamp],
    );

    const response = await request(
      "/api/snapshots/maps-random-draw?country=CR&count=4&weight=players&status=ranked&keys=4k&patterns=jack&starMin=4&starMax=5&excludeUsers=999&hideUsers=998",
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      value: {
        country: "CR",
        weight: "players",
        totalPicks: 1,
        uniqueSets: 1,
        picks: [{
          player: { id: 401, username: "India", favouriteCount: 1 },
          beatmapset: { id: 301, title: "Set 301", starMin: 4.5, starMax: 4.5 },
          scopeFavCount: 1,
        }],
      },
      refreshQueued: false,
    });
  });

  it("ignores unknown filter values instead of rejecting the request", async () => {
    const stamp = new Date().toISOString();
    await exec(
      db,
      "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values ('CR', 'not json', ?, ?)",
      [stamp, stamp],
    );
    const response = await request(
      "/api/snapshots/maps-random-draw?country=CR&count=abc&weight=nonsense&status=ranked,bogus&keys=9k&patterns=&starMin=99&starMax=-4",
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ value: { weight: "favourites", totalPicks: 0, uniqueSets: 0, picks: [] } });
  });
});
