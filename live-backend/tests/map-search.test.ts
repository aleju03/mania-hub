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
