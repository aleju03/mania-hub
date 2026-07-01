import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { buildMapSearchIndexBatch, getMapSearchPage, type MapSearchQuery } from "../src/features/map-search.js";
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
      json({ ranked_date: "2020-01-01T00:00:00Z" }),
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

  it("builds pattern collections deduped by beatmapset", async () => {
    const db = await makeDb();
    // Two diffs of set 10 + one diff of set 20, all stream-primary 4K in the 4-5 bucket.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 4, stars: 4.2, primary: "stream", patterns: { stream: 0.9 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 10, cs: 4, stars: 4.5, primary: "stream", patterns: { stream: 0.95 } });
    await seedMap(db, { beatmapId: 3, beatmapsetId: 20, cs: 4, stars: 4.8, primary: "stream", patterns: { stream: 0.85 } });
    await buildAll(db);
    await rebuildMapCollections(db);

    const collections = await getMapCollections(db);
    const stream45 = collections.find((c) => c.id === "pattern:stream:4k:4-5");
    expect(stream45).toBeTruthy();
    expect(stream45!.memberCount).toBe(2);

    const detail = await getMapCollection(db, "pattern:stream:4k:4-5");
    expect(detail).toBeTruthy();
    expect(detail!.items.map((item) => item.beatmapsetId)).toEqual([10, 20]);
    // Highest-metric diff kept for the deduped set.
    expect(detail!.items[0].beatmapId).toBe(2);
  });
});

describe("map search + collections HTTP", () => {
  it("serves /api/snapshots/maps-search globally and /map-collection", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 4, stars: 4.2, primary: "stream", patterns: { stream: 0.95 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, cs: 7, stars: 5.0, primary: "jack", patterns: { jack: 1 } });
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

    const detail = mockRes();
    await routeHttp(mockReq("GET", `/api/snapshots/map-collection?id=${encodeURIComponent(first.id)}`), detail.res, ctx);
    const detailBody = JSON.parse(detail.writes.join(""));
    expect(detailBody.collection.id).toBe(first.id);
    expect(detailBody.collection.items.length).toBe(first.memberCount);

    const missing = mockRes();
    await routeHttp(mockReq("GET", "/api/snapshots/map-collection?id=does-not-exist"), missing.res, ctx);
    expect(missing.res.statusCode).toBe(404);
  });
});

function httpConfig() {
  return {
    nodeEnv: "production",
    allowedOrigins: ["http://localhost:3000"],
    trackedCountries: ["CR"],
    trustProxyHeaders: true,
    publicApiRatePerMinute: 120,
    publicCostlyRatePerMinute: 30,
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
    country: null,
    sort: "playcount",
    dir: "desc",
    page: 0,
    pageSize: 50,
  };
}
