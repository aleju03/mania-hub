import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { buildMapSearchIndexBatch, ensureMapSearchIndexSeeded, getMapSearchPage, MAP_SEARCH_BUILD_JOB, type MapSearchQuery } from "../src/features/map-search.js";
import { getMapCollection, getMapCollections, rebuildMapCollections } from "../src/features/map-collections.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-mapsearch-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

interface SeedMap {
  beatmapId: number;
  beatmapsetId: number;
  cs?: number;
  stars?: number;
  bpm?: number;
  status?: string;
  title?: string;
  artist?: string;
  creator?: string;
  version?: string;
  playcount?: number;
  totalLength?: number;
  rankedDate?: string;
  mode?: string;
  convert?: boolean;
  primary: string;
  patterns: Record<string, number>;
}

async function seedMap(db: Db, map: SeedMap): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  await exec(
    db,
    `insert or replace into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      map.beatmapsetId,
      map.title ?? `Set ${map.beatmapsetId}`,
      map.artist ?? "Artist",
      map.creator ?? "Mapper",
      map.status ?? "ranked",
      json({ card: `https://example/${map.beatmapsetId}.jpg` }),
      json({ ranked_date: map.rankedDate ?? "2020-01-01T00:00:00Z" }),
      now,
    ],
  );
  await exec(
    db,
    `insert or replace into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
     values (?, ?, 'mania', ?, ?, ?, ?, 1000, ?, '', ?, ?)`,
    [
      map.beatmapId,
      map.beatmapsetId,
      map.status ?? "ranked",
      map.cs ?? 4,
      map.stars ?? 4.5,
      map.bpm ?? 180,
      map.version ?? "Normal",
      json({
        mode: map.mode ?? "mania",
        playcount: map.playcount ?? 1000,
        passcount: 100,
        count_sliders: 50,
        total_length: map.totalLength ?? 120,
        status: map.status ?? "ranked",
        convert: map.convert ?? false,
      }),
      now,
    ],
  );
  await exec(
    db,
    `insert or replace into beatmap_skill_vectors (beatmap_id, analysis_version, status, skills_json, computed_at, updated_at)
     values (?, ?, 'ready', ?, ?, ?)`,
    [map.beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION, json({ primary: map.primary, patterns: map.patterns }), now, now],
  );
}

async function buildAll(db: Db): Promise<void> {
  let cursor = 0;
  for (;;) {
    const result = await buildMapSearchIndexBatch(db, cursor, 100);
    cursor = result.nextCursor;
    if (result.done) break;
  }
}

describe("map search index", () => {
  it("indexes ready skill vectors and filters by primary pattern + key", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 4, primary: "stream", patterns: { stream: 1, jack: 0.3 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, cs: 7, primary: "jack", patterns: { jack: 1, stream: 0.2 } });
    await buildAll(db);

    const all = await getMapSearchPage(db, baseQuery());
    expect(all.total).toBe(2);

    const streamKeyed = await getMapSearchPage(db, { ...baseQuery(), keys: ["4k"], patterns: ["stream"] });
    expect(streamKeyed.total).toBe(1);
    expect(streamKeyed.items[0].beatmapId).toBe(1);
    expect(streamKeyed.items[0].primaryPattern).toBe("stream");
    expect(streamKeyed.items[0].patterns.stream).toBe(1);
  });

  it("excludes converted maps from the pool", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "stream", patterns: { stream: 1 } });
    // A std map whose scores were played as a mania convert: its native mode is osu,
    // so it must never enter the pool even though it has a ready skill vector. The
    // `convert` flag is absent on such rows, so the native mode is the only reliable tell.
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, mode: "osu", primary: "jack", patterns: { jack: 1 } });
    // Some API responses use mode=mania plus convert=true for the same class of
    // map. Kimi no Sei looked like this in the local DB, so reject this too.
    await seedMap(db, { beatmapId: 3, beatmapsetId: 30, mode: "mania", convert: true, primary: "tech", patterns: { tech: 1 } });
    await buildAll(db);

    const all = await getMapSearchPage(db, baseQuery());
    expect(all.total).toBe(1);
    expect(all.items[0].beatmapId).toBe(1);
  });

  it("indexes the map's real length and filters/sorts by it", async () => {
    const db = await makeDb();
    // Regression: libsql rows are array-like, so selecting the column as bare
    // `length` read the row's column count (19) for every map instead.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, totalLength: 95, primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, totalLength: 240, primary: "jack", patterns: { jack: 1 } });
    await buildAll(db);

    const all = await getMapSearchPage(db, baseQuery());
    expect(all.items.find((item) => item.beatmapId === 1)?.length).toBe(95);

    const short = await getMapSearchPage(db, { ...baseQuery(), lenMax: 120 });
    expect(short.total).toBe(1);
    expect(short.items[0].beatmapId).toBe(1);

    const bounded = await getMapSearchPage(db, { ...baseQuery(), lenMin: 120, lenMax: 300, sort: "length", dir: "asc" });
    expect(bounded.items.map((item) => item.beatmapId)).toEqual([2]);
  });

  it("multi-selects patterns (union) and filters by star range", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, stars: 3.0, primary: "tech", patterns: { tech: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, stars: 5.0, primary: "jack", patterns: { jack: 1 } });
    await seedMap(db, { beatmapId: 3, beatmapsetId: 30, stars: 7.0, primary: "stream", patterns: { stream: 1 } });
    await buildAll(db);

    const techOrJack = await getMapSearchPage(db, { ...baseQuery(), patterns: ["tech", "jack"], sort: "stars", dir: "asc" });
    expect(techOrJack.items.map((item) => item.beatmapId)).toEqual([1, 2]);

    const ranged = await getMapSearchPage(db, { ...baseQuery(), starMin: 4, starMax: 6, sort: "stars", dir: "asc" });
    expect(ranged.items.map((item) => item.beatmapId)).toEqual([2]);
  });

  it("text search matches title/artist/creator/version", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, title: "Banger", artist: "Camellia", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, title: "Calm", artist: "Other", primary: "ln", patterns: { ln: 1 } });
    await buildAll(db);

    const hit = await getMapSearchPage(db, { ...baseQuery(), q: "camellia" });
    expect(hit.total).toBe(1);
    expect(hit.items[0].beatmapId).toBe(1);
  });

  it("parses osu!-style tokens in the free-text query", async () => {
    const db = await makeDb();
    await seedMap(db, {
      beatmapId: 1, beatmapsetId: 10, cs: 4, stars: 4.2, bpm: 150, totalLength: 95,
      title: "Banger", creator: "Nanahira Fan", version: "Hard", primary: "stream", patterns: { stream: 1 },
    });
    await seedMap(db, {
      beatmapId: 2, beatmapsetId: 20, cs: 7, stars: 6.1, bpm: 220, totalLength: 200, status: "loved",
      title: "Calm", creator: "OtherMapper", version: "7K Insane", rankedDate: "2022-05-10T00:00:00Z",
      primary: "jack", patterns: { jack: 1 },
    });
    await seedMap(db, {
      beatmapId: 3, beatmapsetId: 30, cs: 6, stars: 5.0, bpm: 180, status: "graveyard",
      title: "Third", primary: "tech", patterns: { tech: 1 },
    });
    await buildAll(db);

    const ids = async (q: string) => {
      const page = await getMapSearchPage(db, { ...baseQuery(), q });
      return page.items.map((item) => item.beatmapId).sort();
    };

    // Numeric fields with comparison ops; equality buckets to the literal's precision.
    expect(await ids("keys=7")).toEqual([2]);
    expect(await ids("key=6")).toEqual([3]);
    expect(await ids("cs=4")).toEqual([1]);
    expect(await ids("keys=7k")).toEqual([2]);
    expect(await ids("stars>5 bpm>200")).toEqual([2]);
    expect(await ids("stars=4")).toEqual([1]);
    expect(await ids("star>=5")).toEqual([2, 3]);
    expect(await ids("bpm<180")).toEqual([1]);
    // Length in seconds, with s/m suffixes and m:ss.
    expect(await ids("length<100")).toEqual([1]);
    expect(await ids("length<2m")).toEqual([1]);
    expect(await ids("length>=1:40")).toEqual([2, 3]);
    // Status equality and negation.
    expect(await ids("status=ranked")).toEqual([1]);
    expect(await ids("status=loved")).toEqual([2]);
    expect(await ids("status!=graveyard")).toEqual([1, 2]);
    // Text columns, quoted values, and aliases.
    expect(await ids("creator=nanahira")).toEqual([1]);
    expect(await ids('creator="nanahira fan"')).toEqual([1]);
    expect(await ids("mapper=other")).toEqual([2]);
    expect(await ids("diff=insane")).toEqual([2]);
    expect(await ids("title=third")).toEqual([3]);
    expect(await ids("artist!=artist")).toEqual([]);
    // Ranked date at year/month precision (seeds default to 2020-01-01).
    expect(await ids("ranked>=2022")).toEqual([2]);
    expect(await ids("ranked=2020")).toEqual([1, 3]);
    expect(await ids("ranked=2022-05")).toEqual([2]);
    expect(await ids("ranked<2021")).toEqual([1, 3]);
    // Tokens combine with plain terms; the `:` op works like `=`.
    expect(await ids("banger keys:4")).toEqual([1]);
    // Half-typed or invalid values drop the token instead of blanking results.
    expect(await ids("status=")).toEqual([1, 2, 3]);
    expect(await ids("status=asdf keys=")).toEqual([1, 2, 3]);
    // Unknown keys stay plain text search.
    expect(await ids("zzz=1")).toEqual([]);
  });

  it("filters by dan tokens with facet semantics (±0.5, vibro excluded)", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "stream", patterns: { stream: 1 } });
    await seedAnalysis(db, 1, { rawDan: 9.6, label: "10--" });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, primary: "jack", patterns: { jack: 1 } });
    await seedAnalysis(db, 2, { rawDan: 10.2, label: "10", vibro: true });
    await buildAll(db);

    const ids = async (q: string) => {
      const page = await getMapSearchPage(db, { ...baseQuery(), q });
      return page.items.map((item) => item.beatmapId).sort();
    };

    expect(await ids("dan=10")).toEqual([1]);
    expect(await ids("dan>=10")).toEqual([1]);
    expect(await ids("dan=9")).toEqual([]);
    expect(await ids("dan>=11")).toEqual([]);
    expect(await ids("dan<10")).toEqual([]);
  });

  it("groups results by beatmapset with matching diffs attached", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, stars: 4.2, playcount: 500, version: "Hard", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 10, stars: 5.4, playcount: 900, version: "Insane", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 3, beatmapsetId: 20, stars: 3.1, playcount: 700, version: "Normal", primary: "jack", patterns: { jack: 1 } });
    await buildAll(db);

    // One row per set; the most-played diff represents under the playcount sort.
    const byPlays = await getMapSearchPage(db, baseQuery());
    expect(byPlays.total).toBe(2);
    expect(byPlays.items.map((item) => item.beatmapId)).toEqual([2, 3]);
    expect(byPlays.items[0].diffCount).toBe(2);
    expect(byPlays.items[0].diffs.map((diff) => diff.beatmapId)).toEqual([1, 2]);
    expect(byPlays.items[1].diffCount).toBe(1);

    // Under stars asc the easiest diff represents the set instead.
    const byStars = await getMapSearchPage(db, { ...baseQuery(), sort: "stars", dir: "asc" });
    expect(byStars.items.map((item) => item.beatmapId)).toEqual([3, 1]);

    // Filters narrow the attached diffs too: only the 5★+ diff of set 10 matches.
    const hardOnly = await getMapSearchPage(db, { ...baseQuery(), starMin: 5 });
    expect(hardOnly.total).toBe(1);
    expect(hardOnly.items[0].beatmapId).toBe(2);
    expect(hardOnly.items[0].diffCount).toBe(1);
    expect(hardOnly.items[0].diffs.map((diff) => diff.beatmapId)).toEqual([2]);
  });

  it("re-seeds the build even when a previous build left done jobs on the same cursors", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    // Regression: a completed build leaves done jobs keyed build_map_search_index:<cursor>.
    // A later rebuild (e.g. a BUILD_REVISION bump) reuses cursor 0, and without
    // replaceDone the enqueue silently no-ops against that done row.
    await queue.enqueue(MAP_SEARCH_BUILD_JOB, `${MAP_SEARCH_BUILD_JOB}:0`, { cursor: 0 });
    const [job] = await queue.claim("test-worker", 1);
    expect(job.type).toBe(MAP_SEARCH_BUILD_JOB);
    await queue.complete(job.id);

    await ensureMapSearchIndexSeeded(db, queue);
    const row = (await exec(
      db,
      "select status from jobs where dedupe_key = ? limit 1",
      [`${MAP_SEARCH_BUILD_JOB}:0`],
    )).rows[0];
    expect(String(row?.status)).toBe("queued");
  });

  it("builds dan and MSD bucket collections deduped by beatmapset", async () => {
    const db = await makeDb();
    // Six stream-primary 4K sets in the 7-8 dan / 18-22 MSD buckets; set 10 has
    // two diffs to prove the dedupe. Analysis rows carry rawDan + MSD overall.
    for (let i = 0; i < 6; i++) {
      const beatmapId = i + 1;
      await seedMap(db, { beatmapId, beatmapsetId: (i + 1) * 10, cs: 4, primary: "stream", patterns: { stream: 0.8 + i * 0.01 } });
      await seedAnalysis(db, beatmapId, { rawDan: 7 + i * 0.2, label: "7", msdValues: { Overall: 19 + i * 0.3 } });
    }
    await seedMap(db, { beatmapId: 7, beatmapsetId: 10, cs: 4, primary: "stream", patterns: { stream: 0.99 } });
    await seedAnalysis(db, 7, { rawDan: 7.1, label: "7", msdValues: { Overall: 19.1 } });
    // Out-of-bucket (10th dan) and vibro charts must stay out of the 7-8 pack.
    await seedMap(db, { beatmapId: 8, beatmapsetId: 80, cs: 4, primary: "stream", patterns: { stream: 0.9 } });
    await seedAnalysis(db, 8, { rawDan: 10, label: "10", msdValues: { Overall: 26 } });
    await seedMap(db, { beatmapId: 9, beatmapsetId: 90, cs: 4, primary: "stream", patterns: { stream: 0.9 } });
    await seedAnalysis(db, 9, { rawDan: 7.5, label: "7+", vibro: true, msdValues: { Overall: 20 } });
    await buildAll(db);
    await rebuildMapCollections(db);

    const collections = await getMapCollections(db);
    const dan78 = collections.find((c) => c.id === "pattern:stream:4k:dan:d7-8");
    expect(dan78).toBeTruthy();
    expect(dan78!.memberCount).toBe(6);
    expect(dan78!.axis).toBe("dan");
    expect(dan78!.bucketLo).toBe(7);
    expect(dan78!.bucketHi).toBe(8);
    expect(dan78!.coverSetIds.length).toBeGreaterThan(0);

    const detail = await getMapCollection(db, "pattern:stream:4k:dan:d7-8");
    expect(detail).toBeTruthy();
    expect(detail!.items.length).toBe(6);
    // Set 10 contributes exactly one diff, and neither the 10th-dan chart nor
    // the vibro chart leaks in.
    const setIds = detail!.items.map((item) => item.beatmapsetId);
    expect(new Set(setIds).size).toBe(setIds.length);
    const ids = detail!.items.map((item) => item.beatmapId);
    expect(ids).not.toContain(8);
    expect(ids).not.toContain(9);
    // Easiest-first ordering on the axis value.
    const dans = detail!.items.map((item) => item.dan!.rawDan);
    expect([...dans].sort((a, b) => a - b)).toEqual(dans);

    const msd = collections.find((c) => c.id === "pattern:stream:4k:msd:m18-22");
    expect(msd).toBeTruthy();
    expect(msd!.axis).toBe("msd");
    expect(msd!.memberCount).toBe(6);
  }, 30000);

  it("rotates membership per rebuild while retaining added_at, and drops stale recipes", async () => {
    // Only fake Date: the rebuild yields on setImmediate between recipes, which
    // a full fake-timer install would park forever.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
      const db = await makeDb();
      for (let i = 0; i < 6; i++) {
        const beatmapId = i + 1;
        await seedMap(db, { beatmapId, beatmapsetId: (i + 1) * 10, cs: 4, primary: "jack", patterns: { jack: 0.9 } });
        await seedAnalysis(db, beatmapId, { rawDan: 9.2 + i * 0.1, label: "9" });
      }
      await buildAll(db);
      // A leftover pack from the retired star-bucket scheme must vanish.
      await exec(
        db,
        `insert into map_collections (id, recipe_id, kind, title, key_count, sort_order, member_count, refreshed_at, updated_at)
         values ('pattern:jack:4k:4-5', 'pattern:jack:4k', 'pattern', 'old', 4, 0, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      );
      await rebuildMapCollections(db);

      const first = await getMapCollection(db, "pattern:jack:4k:dan:d9-10");
      expect(first).toBeTruthy();
      // Fresh pack: every member is part of the first rotation.
      expect(first!.newBeatmapIds.length).toBe(first!.items.length);
      const stale = await getMapCollection(db, "pattern:jack:4k:4-5");
      expect(stale).toBeNull();

      vi.setSystemTime(new Date("2026-07-04T00:00:00Z"));
      await rebuildMapCollections(db);
      const second = await getMapCollection(db, "pattern:jack:4k:dan:d9-10");
      expect(second).toBeTruthy();
      expect(second!.refreshedAt).not.toBe(first!.refreshedAt);
      // The pool has only these six sets, so every member is retained and none
      // counts as new on the second rotation.
      expect(second!.items.length).toBe(6);
      expect(second!.newBeatmapIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});

describe("map search + collections HTTP", () => {
  it("serves /api/snapshots/maps-search globally and /map-collection", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 4, stars: 4.2, primary: "stream", patterns: { stream: 0.95 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, cs: 7, stars: 5.0, primary: "jack", patterns: { jack: 1 } });
    // Enough chordjack maps to publish a pack (MIN_MEMBERS); chordjack so the
    // stream search assertion above stays at one hit.
    for (let i = 0; i < 5; i++) {
      const beatmapId = 100 + i;
      await seedMap(db, { beatmapId, beatmapsetId: 1000 + i * 10, cs: 4, primary: "chordjack", patterns: { chordjack: 0.9 } });
      await seedAnalysis(db, beatmapId, { rawDan: 7.2 + i * 0.1, label: "7" });
    }
    await buildAll(db);
    await rebuildMapCollections(db);

    const ctx = {
      db,
      queue: new JobQueue(db),
      events: new LiveEventLog(db),
      config: httpConfig(),
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0, byCaller: [], byPath: [] }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never;

    const search = mockRes();
    await routeHttp(mockReq("GET", "/api/snapshots/maps-search?keys=4k&patterns=stream"), search.res, ctx);
    const searchBody = JSON.parse(search.writes.join(""));
    expect(searchBody.total).toBe(1);
    expect(searchBody.items[0].beatmapId).toBe(1);

    const list = mockRes();
    await routeHttp(mockReq("GET", "/api/snapshots/map-collections"), list.res, ctx);
    const listBody = JSON.parse(list.writes.join(""));
    expect(Array.isArray(listBody.collections)).toBe(true);
    const first = listBody.collections[0];
    expect(first.memberCount).toBeGreaterThan(0);
    expect(listBody.rotation.refreshedAt).toBeTruthy();
    expect(listBody.rotation.nextRefreshAt).toBeTruthy();

    const detail = mockRes();
    await routeHttp(mockReq("GET", `/api/snapshots/map-collection?id=${encodeURIComponent(first.id)}`), detail.res, ctx);
    const detailBody = JSON.parse(detail.writes.join(""));
    expect(detailBody.collection.id).toBe(first.id);
    expect(detailBody.collection.items.length).toBe(first.memberCount);

    const missing = mockRes();
    await routeHttp(mockReq("GET", "/api/snapshots/map-collection?id=does-not-exist"), missing.res, ctx);
    expect(missing.res.statusCode).toBe(404);
  }, 30000);
});

function httpConfig() {
  return {
    nodeEnv: "production",
    allowedOrigins: ["http://localhost:3000"],
    trackedCountries: ["CR"],
    trustProxyHeaders: true,
    publicApiRatePerMinute: 120,
    publicCostlyRatePerMinute: 30,
    mapCollectionsRefreshIntervalMs: 3 * 24 * 60 * 60 * 1000,
  };
}

function mockReq(method: string, url: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost" };
  return req;
}

function mockRes() {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  let res: ServerResponse & { statusCode: number };
  const partial = {
    statusCode: 200,
    setHeader: vi.fn((key: string, value: number | string | readonly string[]) => {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
      return res;
    }),
    getHeader: vi.fn((key: string) => headers[key.toLowerCase()]),
    writeHead: vi.fn((status: number) => {
      res.statusCode = status;
      return res;
    }),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn((chunk?: string | Buffer) => {
      if (chunk != null) writes.push(String(chunk));
    }),
  };
  res = partial as unknown as ServerResponse & { statusCode: number };
  return { res, writes, headers };
}

function baseQuery(): MapSearchQuery {
  return {
    q: "",
    keys: [],
    statuses: [],
    patterns: [],
    starMin: null,
    starMax: null,
    bpmMin: null,
    bpmMax: null,
    lenMin: null,
    lenMax: null,
    danMin: null,
    danMax: null,
    country: null,
    sort: "playcount",
    dir: "desc",
    page: 0,
    pageSize: 50,
  };
}

async function seedAnalysis(
  db: Db,
  beatmapId: number,
  options: {
    msdValues?: Record<string, number>;
    lnRatio?: number;
    vibro?: boolean;
    rawDan?: number;
    label?: string;
    family?: string;
  },
): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  await exec(
    db,
    `insert or replace into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, msd_overall,
        classification_json, msd_json, computed_at, updated_at)
     values (?, ?, 'ready', 4, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      options.label ?? "10",
      options.family ?? "dan",
      options.rawDan ?? 10,
      options.msdValues?.Overall ?? null,
      json({ lnRatio: options.lnRatio ?? 0.1, vibro: options.vibro ?? false, patterns: [] }),
      options.msdValues ? json({ etternaVersion: "0.72.3", values: options.msdValues }) : null,
      now,
      now,
    ],
  );
}

describe("map search primary derivation", () => {
  it("prefers MinaCalc skillsets over the in-house profile on 4K", async () => {
    const db = await makeDb();
    // Planet Shaper shape: the in-house scorer called it handstream (capped to
    // 1.0), MinaCalc says stamina; the index must side with MinaCalc.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "handstream", patterns: { handstream: 1, chordjack: 0.86, tech: 0.92 } });
    await seedAnalysis(db, 1, {
      msdValues: { Overall: 23.86, Stream: 16.18, Jumpstream: 23.0, Handstream: 18.5, Stamina: 23.16, JackSpeed: 12.34, Chordjack: 18.66, Technical: 23.06 },
      lnRatio: 0.11,
    });
    await buildAll(db);

    const all = await getMapSearchPage(db, baseQuery());
    expect(all.items[0].primaryPattern).toBe("stamina");
    expect(all.items[0].patterns.stamina).toBe(1);
    expect(all.items[0].patterns.handstream).toBeCloseTo(18.5 / 23.16, 3);

    const handstream = await getMapSearchPage(db, { ...baseQuery(), patterns: ["handstream"] });
    expect(handstream.total).toBe(0);
    const stamina = await getMapSearchPage(db, { ...baseQuery(), patterns: ["stamina"] });
    expect(stamina.total).toBe(1);
  });

  it("routes LN primaries by the classifier lnRatio", async () => {
    const db = await makeDb();
    // Holds-heavy hybrid the activity path promoted to LN, but the classifier
    // routed RC (lnRatio < 0.5): demote to the best non-LN family.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "ln", patterns: { ln: 1, chordjack: 0.7, tech: 0.6 } });
    await seedAnalysis(db, 1, { lnRatio: 0.47 });
    // Majority-holds chart that the skills profile called tech: promote to LN.
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, primary: "tech", patterns: { tech: 1, ln: 0.4 } });
    await seedAnalysis(db, 2, { lnRatio: 0.74, family: "ln" });
    // No chart analysis: the skills primary stands.
    await seedMap(db, { beatmapId: 3, beatmapsetId: 30, primary: "ln", patterns: { ln: 1 } });
    await buildAll(db);

    const all = await getMapSearchPage(db, baseQuery());
    const byId = new Map(all.items.flatMap((item) => item.diffs.length ? item.diffs.map((d) => [d.beatmapId, d] as const) : [[item.beatmapId, item] as const]));
    expect(byId.get(1)?.primaryPattern).toBe("chordjack");
    expect(byId.get(2)?.primaryPattern).toBe("ln");
    expect(byId.get(3)?.primaryPattern).toBe("ln");

    const lnOnly = await getMapSearchPage(db, { ...baseQuery(), patterns: ["ln"] });
    expect(lnOnly.items.map((item) => item.beatmapId).sort()).toEqual([2, 3]);
  });

  it("excludes vibro charts from dan-filtered searches only", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "ln", patterns: { ln: 1 } });
    await seedAnalysis(db, 1, { lnRatio: 0.9, vibro: true, rawDan: 10.2, label: "10+", family: "ln" });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, primary: "ln", patterns: { ln: 1 } });
    await seedAnalysis(db, 2, { lnRatio: 0.8, rawDan: 10, label: "10", family: "ln" });
    await buildAll(db);

    const unfiltered = await getMapSearchPage(db, baseQuery());
    expect(unfiltered.total).toBe(2);
    expect(unfiltered.items.find((item) => item.beatmapId === 1)?.vibro).toBe(true);
    expect(unfiltered.items.find((item) => item.beatmapId === 2)?.vibro).toBe(false);

    const danScoped = await getMapSearchPage(db, { ...baseQuery(), danMin: 10, danMax: 10 });
    expect(danScoped.items.map((item) => item.beatmapId)).toEqual([2]);
  });
});

describe("map search chart-analysis join", () => {
  it("carries dan/msd into entries and filters by dan range and subfamily tags", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 9101, beatmapsetId: 8101, primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 9102, beatmapsetId: 8102, primary: "jack", patterns: { jack: 1 } });

    const now = "2026-01-01T00:00:00Z";
    await exec(
      db,
      `insert into beatmap_chart_analysis
         (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, msd_overall,
          classification_json, msd_json, computed_at, updated_at)
       values (?, ?, 'ready', 4, ?, 'dan', ?, ?, ?, ?, ?, ?)`,
      [
        9101,
        CHART_ANALYSIS_VERSION,
        "10--",
        9.6,
        27.89,
        json({ patterns: [{ id: "stream", label: "Stream", score: 0.9, confidence: 0.8 }, { id: "dumpstream", label: "Dumpstream", score: 0.6, confidence: 0.5 }] }),
        json({ etternaVersion: "0.72.3", values: { Overall: 27.89, Stream: 27.64 } }),
        now,
        now,
      ],
    );

    await buildMapSearchIndexBatch(db, 0, 100);

    const all = await getMapSearchPage(db, baseQuery());
    const analyzed = all.items.find((item) => item.beatmapId === 9101);
    const unanalyzed = all.items.find((item) => item.beatmapId === 9102);
    expect(analyzed?.dan).toEqual({ label: "10--", family: "dan", rawDan: 9.6 });
    expect(analyzed?.msd?.Overall).toBeCloseTo(27.89, 5);
    expect(unanalyzed?.dan).toBeNull();
    expect(unanalyzed?.msd).toBeNull();

    const danFiltered = await getMapSearchPage(db, { ...baseQuery(), danMin: 9, danMax: 11 });
    expect(danFiltered.items.map((item) => item.beatmapId)).toEqual([9101]);
    const danExcluded = await getMapSearchPage(db, { ...baseQuery(), danMin: 11, danMax: null });
    expect(danExcluded.items).toEqual([]);
    // Single-dan select: bounds widen half a step, so a "10--" chart (raw 9.6)
    // counts as 10th dan but not as 9th.
    const danExact = await getMapSearchPage(db, { ...baseQuery(), danMin: 10, danMax: 10 });
    expect(danExact.items.map((item) => item.beatmapId)).toEqual([9101]);
    const danExactMiss = await getMapSearchPage(db, { ...baseQuery(), danMin: 9, danMax: 9 });
    expect(danExactMiss.items).toEqual([]);

    const subFiltered = await getMapSearchPage(db, { ...baseQuery(), patterns: ["dumpstream"] });
    expect(subFiltered.items.map((item) => item.beatmapId)).toEqual([9101]);
    const subMiss = await getMapSearchPage(db, { ...baseQuery(), patterns: ["lnrelease"] });
    expect(subMiss.items).toEqual([]);
    // family + sub mix ORs within the facet
    const mixed = await getMapSearchPage(db, { ...baseQuery(), patterns: ["jack", "dumpstream"] });
    expect(mixed.items.map((item) => item.beatmapId).sort()).toEqual([9101, 9102]);
  });
});
