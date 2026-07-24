import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getMapsSnapshot } from "../src/features/maps.js";
import { JobQueue } from "../src/jobs/queue.js";

// The legacy /api/snapshots/maps?section=random read still serves already
// deployed frontends. It only needs favouritesByPlayer + beatmapsetsPool, which
// is ~3 % of a stored payload, so it pulls those out with json_extract instead
// of parsing the whole row (67.6 MB on GLOBAL, +212 MiB of transient heap in
// the serving process). Everything the extract cannot answer must still fall
// back to the whole-row read.

const NOW = "2026-07-01T00:00:00.000Z";
const POOL_SET = 301;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

describe("random maps snapshot read", () => {
  let dir = "";
  let db: Db;
  let queue: JobQueue;
  // Set by the proxy below for the statement that reaches the payload column.
  let lastRead: { narrowBytes: number; wholePayload: string | null } | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-maps-random-read-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    queue = new JobQueue(db);
    lastRead = null;
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (101, 'Alpha', 'https://a.ppy.sh/101', 'CR', ?)",
      [NOW],
    );
    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (?, 'Set', 'Artist', 'Creator', 'ranked', '{"cover":"c","card":"d","list":"l"}', 10, 5, 'p', 180, '[4]', '["jack"]', ?)`,
      [POOL_SET, NOW],
    );
    await exec(
      db,
      `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
       values (3011, ?, 'mania', 'ranked', 4, 4.2, 180, 120, 'Diff', 'https://osu.ppy.sh/beatmaps/3011', ?)`,
      [POOL_SET, NOW],
    );
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // Observes what SQLite actually shipped back for the snapshot read: a
  // narrowly-read row carries the extracted parts and a null payload column, a
  // fallback row carries the whole payload.
  function observingDb(): Db {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return async (arg: { sql?: string } | string) => {
            const result = await target.execute(arg as never);
            const sql = typeof arg === "string" ? arg : arg?.sql ?? "";
            if (sql.includes("'$.favouritesByPlayer'")) {
              const row = result.rows[0] as Record<string, unknown> | undefined;
              lastRead = {
                narrowBytes: row?.parts == null ? 0 : String(row.parts).length,
                wholePayload: row?.payload_json == null ? null : String(row.payload_json),
              };
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async function seedSnapshot(payload: unknown): Promise<void> {
    await exec(
      db,
      "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values ('CR', ?, ?, ?)",
      [typeof payload === "string" ? payload : JSON.stringify(payload), NOW, new Date().toISOString()],
    );
  }

  function compactPayload(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 2,
      // A farmed section large enough that shipping it would be obvious in the
      // byte count the proxy records.
      farmed: Array.from({ length: 200 }, (_, index) => ({
        beatmapId: 500 + index,
        playerCount: 1,
        avgPp: 400,
        maxPp: 500,
        dominantMod: null,
        players: [{ id: 101, mods: ["DT"], pp: 500, scoreUrl: null, playedAt: NOW }],
      })),
      mostPlayed: [],
      favourites: [],
      favouritesByPlayer: [{ id: 101, beatmapsetIds: [POOL_SET] }],
      beatmapsetsPool: [POOL_SET],
      generatedAt: NOW,
      farmedGeneratedAt: NOW,
      favouritesGeneratedAt: NOW,
      ...overrides,
    };
  }

  const read = (database: Db = db) => getMapsSnapshot(database, queue, "CR", MAX_AGE_MS, "random");

  it("serves a compact row without shipping the whole payload", async () => {
    const payload = compactPayload();
    await seedSnapshot(payload);

    const snapshot = await read(observingDb());

    expect(snapshot.value?.favouritesByPlayer).toEqual([
      { id: 101, username: "Alpha", avatarUrl: "https://a.ppy.sh/101", beatmapsetIds: [POOL_SET] },
    ]);
    expect(snapshot.value?.beatmapsetsPool[POOL_SET]).toMatchObject({ id: POOL_SET, title: "Set", maniaKeys: [4] });
    expect(snapshot.value?.farmed).toEqual([]);
    expect(snapshot.isStale).toBe(false);

    // The farmed section is 97 % of this fixture and never crosses into JS.
    expect(lastRead?.wholePayload).toBeNull();
    expect(lastRead?.narrowBytes).toBeGreaterThan(0);
    expect(lastRead?.narrowBytes).toBeLessThan(JSON.stringify(payload).length / 4);
  });

  it("falls back to the whole row for a legacy hydrated payload", async () => {
    await seedSnapshot({
      farmed: [],
      mostPlayed: [],
      favourites: [],
      favouritesByPlayer: [{ id: 101, username: "Alpha", avatarUrl: "https://a.ppy.sh/101", beatmapsetIds: [POOL_SET] }],
      beatmapsetsPool: {
        [POOL_SET]: {
          id: POOL_SET,
          title: "Set",
          artist: "Artist",
          creator: "Creator",
          covers: { cover: "c" },
          status: "ranked",
          globalPlayCount: 10,
          globalFavouriteCount: 5,
          previewUrl: "p",
          maniaKeys: [4],
          maniaBeatmaps: [],
          starMin: 4.2,
          starMax: 4.2,
          bpm: 180,
          patterns: ["jack"],
        },
      },
      generatedAt: NOW,
      farmedGeneratedAt: NOW,
      favouritesGeneratedAt: NOW,
    });

    const snapshot = await read(observingDb());

    expect(lastRead?.wholePayload).not.toBeNull();
    expect(snapshot.value?.favouritesByPlayer[0]).toMatchObject({ id: 101, username: "Alpha" });
    // The legacy slice drops the heavy per-set fields the lean wire format omits.
    expect(snapshot.value?.beatmapsetsPool[POOL_SET]).toMatchObject({ id: POOL_SET, starMin: 4.2 });
    expect(snapshot.value?.beatmapsetsPool[POOL_SET].covers).toBeUndefined();
    expect(snapshot.isStale).toBe(false);
  });

  it("answers a corrupt payload with a controlled empty build and queues a refresh", async () => {
    await seedSnapshot("{not json");

    const snapshot = await read(observingDb());

    // json_valid() keeps json_extract from raising; the whole-row path then
    // fails to parse and reports "nothing usable yet" exactly as before.
    expect(lastRead?.wholePayload).toBe("{not json");
    expect(snapshot.value).toBeNull();
    expect(snapshot.isStale).toBe(true);
    expect(snapshot.refreshQueued).toBe(true);
  });

  it("defers to the whole row when both random sections are empty", async () => {
    // Usability then depends on farmed / mostPlayed / favourites, which the
    // narrow read skips: guessing here would enqueue a refresh that is not due.
    await seedSnapshot(compactPayload({ favouritesByPlayer: [], beatmapsetsPool: [] }));

    const snapshot = await read(observingDb());

    expect(lastRead?.wholePayload).not.toBeNull();
    expect(snapshot.value).toMatchObject({ favouritesByPlayer: [], beatmapsetsPool: {} });
    expect(snapshot.isStale).toBe(false);
    expect(snapshot.refreshQueued).toBe(false);
  });

  it("reports a missing row as not built yet", async () => {
    const snapshot = await read(observingDb());
    expect(snapshot.value).toBeNull();
    expect(snapshot.isStale).toBe(true);
    expect(snapshot.refreshQueued).toBe(true);
  });
});
