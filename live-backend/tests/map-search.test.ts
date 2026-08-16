import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDb, exec, execBatch, json, migrate, type Db, type DbStatement } from "../src/db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { buildMapSearchIndexBatch, buildMapStatusPropagationStatement, cleanupBogusLnPatternTags, ensureMapSearchIndexSeeded, getMapSearchPage, getMapSearchSetEntry, MAP_SEARCH_BUILD_JOB, MAP_SEARCH_COUNT_CAP, reconcileMapSearchIndexPlayCounts, reconcileMapSearchIndexStatuses, type MapSearchQuery } from "../src/features/map-search.js";
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
  lnCount?: number;
  totalLength?: number;
  rankedDate?: string;
  mode?: string;
  convert?: boolean;
  covers?: Record<string, string>;
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
      json(map.covers ?? { card: `https://example/${map.beatmapsetId}.jpg` }),
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
        count_sliders: map.lnCount ?? 50,
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

  it("excludes key, status, and pattern facets", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 4, status: "ranked", primary: "tech", patterns: { tech: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, cs: 7, status: "loved", primary: "jack", patterns: { jack: 1 } });
    await seedMap(db, { beatmapId: 3, beatmapsetId: 30, cs: 6, status: "graveyard", primary: "stream", patterns: { stream: 1 } });
    // Regression from the UI: Stream is a visible secondary chip (>= 0.5) on
    // this Chordjack-primary chart, so excluding Stream must remove it too.
    await seedMap(db, { beatmapId: 4, beatmapsetId: 40, cs: 4, status: "ranked", primary: "chordjack", patterns: { chordjack: 1, stream: 0.7 } });
    await buildAll(db);

    const ids = async (patch: Partial<MapSearchQuery>) => {
      const page = await getMapSearchPage(db, { ...baseQuery(), ...patch, sort: "stars", dir: "asc" });
      return page.items.map((item) => item.beatmapId).sort();
    };

    expect(await ids({ keysExclude: ["4k"] })).toEqual([2, 3]);
    expect(await ids({ statusesExclude: ["loved"] })).toEqual([1, 3, 4]);
    expect(await ids({ patternsExclude: ["jack"] })).toEqual([1, 3, 4]);
    expect(await ids({ patternsExclude: ["stream"] })).toEqual([1, 2]);
    expect(await ids({ patterns: ["chordjack"], patternsExclude: ["stream"] })).toEqual([]);
    expect(await ids({ keys: ["4k", "7k"], keysExclude: ["7k"] })).toEqual([1, 4]);
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

  it("treats qualified as its own status facet, split out of pending", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, stars: 4.2, status: "ranked", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, stars: 4.5, status: "qualified", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 3, beatmapsetId: 30, stars: 3.8, status: "pending", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 4, beatmapsetId: 40, stars: 5.1, status: "loved", primary: "stream", patterns: { stream: 1 } });
    await buildAll(db);

    const facet = async (statuses: string[]) => {
      const page = await getMapSearchPage(db, { ...baseQuery(), statuses });
      return page.items.map((item) => item.beatmapId).sort();
    };

    expect(await facet(["qualified"])).toEqual([2]);
    // Pending (the "other" facet) no longer sweeps in qualified.
    expect(await facet(["other"])).toEqual([3]);
    // Facets OR within themselves.
    expect(await facet(["ranked", "qualified"])).toEqual([1, 2]);
    expect(await facet(["loved"])).toEqual([4]);
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

  it("excludes vibro charts from pattern-facet searches", async () => {
    const db = await makeDb();
    // A mash chart classifies as ln-primary by density alone; the pattern
    // facet must not surface it, but it stays reachable without the facet.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "ln", patterns: { ln: 1 } });
    await seedAnalysis(db, 1, { rawDan: 12.0, label: "12", vibro: true });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, primary: "ln", patterns: { ln: 0.9 } });
    await seedAnalysis(db, 2, { rawDan: 8.0, label: "8" });
    await buildAll(db);

    const lnOnly = await getMapSearchPage(db, { ...baseQuery(), patterns: ["ln"] });
    expect(lnOnly.items.map((item) => item.beatmapId)).toEqual([2]);

    const all = await getMapSearchPage(db, baseQuery());
    expect(all.total).toBe(2);
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
    // Five legit low-MSD charts form the under-14 pack; the meme chart's 0.0
    // MSD is MinaCalc's own "junk file" refusal and must not join them.
    for (let i = 0; i < 5; i++) {
      const beatmapId = 11 + i;
      await seedMap(db, { beatmapId, beatmapsetId: beatmapId * 10, cs: 4, primary: "stream", patterns: { stream: 0.7 } });
      await seedAnalysis(db, beatmapId, { rawDan: 3, label: "3", msdValues: { Overall: 10 + i * 0.3, Stream: 10 + i * 0.3 } });
    }
    await seedMap(db, { beatmapId: 16, beatmapsetId: 160, cs: 4, primary: "stream", patterns: { stream: 0.9 } });
    await seedAnalysis(db, 16, { rawDan: 3, label: "3", msdValues: { Overall: 0, Stream: 0 } });
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

    const m14 = await getMapCollection(db, "pattern:stream:4k:msd:m14minus");
    expect(m14).toBeTruthy();
    const m14Ids = m14!.items.map((item) => item.beatmapId);
    expect(m14Ids).toEqual([11, 12, 13, 14, 15]);
    expect(m14Ids).not.toContain(16);
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

  it("keeps sub-minute joke charts out of every pool", async () => {
    const db = await makeDb();
    // Five playable-length charts publish the pack; an 11-second scream map in
    // the same bucket must not enter it even though its scores qualify.
    for (let i = 0; i < 5; i++) {
      const beatmapId = i + 1;
      await seedMap(db, { beatmapId, beatmapsetId: (i + 1) * 10, cs: 4, primary: "jack", patterns: { jack: 0.9 } });
      await seedAnalysis(db, beatmapId, { rawDan: 9.2 + i * 0.1, label: "9" });
    }
    await seedMap(db, { beatmapId: 6, beatmapsetId: 60, cs: 4, totalLength: 11, primary: "jack", patterns: { jack: 0.99 } });
    await seedAnalysis(db, 6, { rawDan: 9.5, label: "9" });
    await buildAll(db);
    await rebuildMapCollections(db);

    const detail = await getMapCollection(db, "pattern:jack:4k:dan:d9-10");
    expect(detail).toBeTruthy();
    expect(detail!.items.map((item) => item.beatmapId)).not.toContain(6);
    expect(detail!.items.length).toBe(5);
  }, 30000);

  it("keeps never-uploaded (?0) covers out of the collage", async () => {
    const db = await makeDb();
    // osu! constructs cover URLs for every set; a "?0" version means no
    // background was ever uploaded and the asset 404s. Only set 10 has a real
    // cover, so it must be the only collage candidate.
    for (let i = 0; i < 5; i++) {
      const beatmapId = i + 1;
      const beatmapsetId = (i + 1) * 10;
      await seedMap(db, {
        beatmapId,
        beatmapsetId,
        cs: 4,
        primary: "jack",
        patterns: { jack: 0.9 },
        covers: {
          card: `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/card.jpg?${i === 0 ? 1662071433 : 0}`,
          list: `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list.jpg?${i === 0 ? 1662071433 : 0}`,
        },
      });
      await seedAnalysis(db, beatmapId, { rawDan: 9.2 + i * 0.1, label: "9" });
    }
    await buildAll(db);
    await rebuildMapCollections(db);

    const collections = await getMapCollections(db);
    const pack = collections.find((c) => c.id === "pattern:jack:4k:dan:d9-10");
    expect(pack).toBeTruthy();
    expect(pack!.memberCount).toBe(5);
    expect(pack!.coverSetIds).toEqual([10]);
    expect(pack!.coverSetId).toBe(10);
  }, 30000);

  it("folds chordjack charts into the jack group and retires chordjack packs", async () => {
    const db = await makeDb();
    // Three jack-primary and three chordjack-primary sets in one bucket. The
    // merged Jack shelf draws from both (neither family alone reaches
    // MIN_MEMBERS), and no chordjack shelf publishes anymore.
    for (let i = 0; i < 3; i++) {
      const beatmapId = i + 1;
      await seedMap(db, { beatmapId, beatmapsetId: (i + 1) * 10, cs: 4, primary: "jack", patterns: { jack: 0.9 } });
      await seedAnalysis(db, beatmapId, { rawDan: 9.2 + i * 0.1, label: "9" });
    }
    for (let i = 0; i < 3; i++) {
      const beatmapId = i + 4;
      await seedMap(db, { beatmapId, beatmapsetId: (i + 4) * 10, cs: 4, primary: "chordjack", patterns: { chordjack: 0.9 } });
      await seedAnalysis(db, beatmapId, { rawDan: 9.5 + i * 0.1, label: "9" });
    }
    await buildAll(db);
    await rebuildMapCollections(db);

    const detail = await getMapCollection(db, "pattern:jack:4k:dan:d9-10");
    expect(detail).toBeTruthy();
    expect(detail!.items.map((item) => item.beatmapId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const collections = await getMapCollections(db);
    expect(collections.some((collection) => collection.id.startsWith("pattern:chordjack:"))).toBe(false);
  }, 30000);

  it("keeps blocklisted uploads (vibro packs, FNF rips) out of every pack", async () => {
    const db = await makeDb();
    for (let i = 0; i < 5; i++) {
      const beatmapId = i + 1;
      await seedMap(db, { beatmapId, beatmapsetId: (i + 1) * 10, cs: 4, primary: "jack", patterns: { jack: 0.9 } });
      await seedAnalysis(db, beatmapId, { rawDan: 9.2 + i * 0.1, label: "9" });
    }
    // These pass every numeric filter (unflagged jumptrill-vibro measures
    // clean) and must still stay out on their metadata alone.
    const junk: Array<Partial<SeedMap> & { beatmapId: number; beatmapsetId: number }> = [
      { beatmapId: 6, beatmapsetId: 60, title: "4k Vibro Pack 99", artist: "Various Artists" },
      { beatmapId: 7, beatmapsetId: 70, title: "V.S. AGOTI (Insane) FULL WEEK", artist: "AGOTI" },
      { beatmapId: 8, beatmapsetId: 80, title: "Friday Night Funkin vs AFLAC", artist: "By Aflac" },
    ];
    for (const map of junk) {
      await seedMap(db, { ...map, cs: 4, primary: "jack", patterns: { jack: 0.99 } });
      await seedAnalysis(db, map.beatmapId, { rawDan: 9.5, label: "9" });
    }
    await buildAll(db);
    await rebuildMapCollections(db);

    const detail = await getMapCollection(db, "pattern:jack:4k:dan:d9-10");
    expect(detail).toBeTruthy();
    expect(detail!.items.map((item) => item.beatmapId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  }, 30000);

  it("keeps one chart per song across different uploads of the same track", async () => {
    const db = await makeDb();
    for (let i = 0; i < 4; i++) {
      const beatmapId = i + 1;
      await seedMap(db, { beatmapId, beatmapsetId: (i + 1) * 10, cs: 4, primary: "jack", patterns: { jack: 0.9 } });
      await seedAnalysis(db, beatmapId, { rawDan: 9.2 + i * 0.1, label: "9" });
    }
    // Three separate beatmapsets of the same song (one a cut version); only
    // the strongest chart survives, so the set dedupe alone is not enough.
    await seedMap(db, { beatmapId: 5, beatmapsetId: 50, cs: 4, title: "MAID OF FIRE", primary: "jack", patterns: { jack: 0.99 } });
    await seedAnalysis(db, 5, { rawDan: 9.5, label: "9" });
    await seedMap(db, { beatmapId: 6, beatmapsetId: 60, cs: 4, title: "MAID OF FIRE", primary: "jack", patterns: { jack: 0.95 } });
    await seedAnalysis(db, 6, { rawDan: 9.5, label: "9" });
    await seedMap(db, { beatmapId: 7, beatmapsetId: 70, cs: 4, title: "Maid of Fire (Cut Ver.)", primary: "jack", patterns: { jack: 0.93 } });
    await seedAnalysis(db, 7, { rawDan: 9.5, label: "9" });
    await buildAll(db);
    await rebuildMapCollections(db);

    const detail = await getMapCollection(db, "pattern:jack:4k:dan:d9-10");
    expect(detail).toBeTruthy();
    const ids = detail!.items.map((item) => item.beatmapId).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
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
    await routeHttp(mockReq("GET", "/api/snapshots/maps-search?keys=4k&patterns=stream&statusesExclude=loved"), search.res, ctx);
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
    keysExclude: [],
    statuses: [],
    statusesExclude: [],
    patterns: [],
    patternsExclude: [],
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
    /** Raw tail-aware calc values (stored unblended, as the sweep writes them). */
    msdLnValues?: Record<string, number>;
    lnRatio?: number;
    vibro?: boolean;
    rawDan?: number;
    label?: string;
    family?: string;
    clusterCategory?: string;
    patterns?: Array<{ id: string; label?: string; score: number; confidence?: number }>;
  },
): Promise<void> {
  const now = "2026-01-01T00:00:00Z";
  await exec(
    db,
    `insert or replace into beatmap_chart_analysis
       (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, msd_overall,
        classification_json, msd_json, msd_ln_json, computed_at, updated_at)
     values (?, ?, 'ready', 4, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      beatmapId,
      CHART_ANALYSIS_VERSION,
      options.label ?? "10",
      options.family ?? "dan",
      options.rawDan ?? 10,
      options.msdValues?.Overall ?? null,
      json({
        lnRatio: options.lnRatio ?? 0.1,
        vibro: options.vibro ?? false,
        patterns: (options.patterns ?? []).map((hit) => ({
          id: hit.id,
          label: hit.label ?? hit.id,
          score: hit.score,
          confidence: hit.confidence ?? hit.score,
        })),
        clusterCategory: options.clusterCategory ?? null,
      }),
      options.msdValues ? json({ etternaVersion: "0.72.3", values: options.msdValues }) : null,
      options.msdLnValues ? json({ etternaVersion: "0.72.3", values: options.msdLnValues }) : null,
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

  it("drops MinaCalc's artifact jack primaries on split-trill charts", async () => {
    const db = await makeDb();
    // gdmem shape (beatmap 3814262): a pure split trill - each column repeats
    // every second row, never twice in a row. MinaCalc reads that repetition
    // as JackSpeed (tops Overall with it) and the in-house profile calls it
    // chordjack; the cluster analysis is the one source that names it.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "chordjack", patterns: { chordjack: 1, jack: 0.61, jumpstream: 0.44 } });
    await seedAnalysis(db, 1, {
      msdValues: { Overall: 15.36, Stream: 7.22, Jumpstream: 10.82, Handstream: 6.18, Stamina: 9.14, JackSpeed: 15.36, Chordjack: 8.98, Technical: 10.34 },
      lnRatio: 0.04,
      clusterCategory: "Split Trill",
    });
    await buildAll(db);

    const all = await getMapSearchPage(db, baseQuery());
    expect(all.items[0].primaryPattern).toBe("jumpstream");
    // Zeroed jack-family chips drop out of the entry's patterns record.
    expect(all.items[0].patterns.jack).toBeUndefined();
    expect(all.items[0].patterns.chordjack).toBeUndefined();
    expect(all.items[0].patterns.tech).toBeCloseTo(10.34 / 10.82, 3);

    const jackScoped = await getMapSearchPage(db, { ...baseQuery(), patterns: ["jack"] });
    expect(jackScoped.total).toBe(0);
    const jsScoped = await getMapSearchPage(db, { ...baseQuery(), patterns: ["jumpstream"] });
    expect(jsScoped.total).toBe(1);
  });

  it("reroutes split-trill jack primaries on non-4K charts from the in-house profile", async () => {
    const db = await makeDb();
    // 7K has no MSD reroute: the in-house chordjack primary falls to the
    // strongest non-jack family instead.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 7, primary: "chordjack", patterns: { chordjack: 1, stream: 0.6, jack: 0.5 } });
    await seedAnalysis(db, 1, { lnRatio: 0.05, clusterCategory: "Split Trill Tech" });
    await buildAll(db);

    const all = await getMapSearchPage(db, { ...baseQuery(), keys: ["7k"] });
    expect(all.items[0].primaryPattern).toBe("stream");
    expect(all.items[0].patterns.jack).toBeUndefined();
    expect(all.items[0].patterns.chordjack).toBeUndefined();
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

  it("demotes non-4K chordjack primaries the chart analyzer does not corroborate", async () => {
    const db = await makeDb();
    // ALL*NIGHTER shape (5603945): holds-heavy 7K chart whose activity primary
    // was lnGeneral; the lnRatio-0.46 de-route used to land on the force-capped
    // phantom chordjack=1.0 even though the analyzer never detected chordjack.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 7, primary: "lnGeneral", patterns: { chordjack: 1, tech: 0.98, stream: 0.96, ln: 0.99 } });
    await seedAnalysis(db, 1, {
      lnRatio: 0.46,
      patterns: [{ id: "ln", score: 0.62 }, { id: "lngeneral", score: 0.28 }, { id: "chordstream", score: 0.23 }],
    });
    // Bracket/jumpstream 7K file (5700185 shape) the in-house chooser called
    // chordjack outright: falls to its strongest remaining family instead.
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, cs: 7, primary: "chordjack", patterns: { chordjack: 1, tech: 0.91, stream: 0.46 } });
    await seedAnalysis(db, 2, {
      lnRatio: 0.005,
      patterns: [{ id: "tech", score: 0.76 }, { id: "chordstream", score: 0.54 }, { id: "chordjack", score: 0.48 }],
    });
    await buildAll(db);

    const all = await getMapSearchPage(db, { ...baseQuery(), keys: ["7k"] });
    const byId = new Map(all.items.flatMap((item) => item.diffs.length ? item.diffs.map((d) => [d.beatmapId, d] as const) : [[item.beatmapId, item] as const]));
    expect(byId.get(1)?.primaryPattern).toBe("ln");
    expect(byId.get(2)?.primaryPattern).toBe("tech");
    // The phantom 1.0 chip clamps to the analyzer's measured score: gone when
    // chordjack was never detected, sub-facet-bar when it was marginal.
    expect(byId.get(1)?.patterns.chordjack).toBeUndefined();
    expect(byId.get(2)?.patterns.chordjack).toBeCloseTo(0.48, 3);

    const cjScoped = await getMapSearchPage(db, { ...baseQuery(), keys: ["7k"], patterns: ["chordjack"] });
    expect(cjScoped.total).toBe(0);
  });

  it("keeps analyzer-corroborated chordjack primaries, including LN de-routes", async () => {
    const db = await makeDb();
    // Genuinely chordjack 32%-holds 7K chart (4893442 shape): the LN de-route
    // lands on chordjack and the analyzer agrees, so the primary stands.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, cs: 7, primary: "lnTech", patterns: { chordjack: 1, ln: 0.93, stream: 0.76 } });
    await seedAnalysis(db, 1, {
      lnRatio: 0.32,
      patterns: [{ id: "lntech", score: 0.91 }, { id: "ln", score: 0.62 }, { id: "chordjack", score: 0.55 }],
    });
    // No chart analysis yet: nothing to corroborate against, the primary stands
    // until the analysis lands and the row re-upserts.
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, cs: 7, primary: "chordjack", patterns: { chordjack: 1, stamina: 0.92 } });
    await buildAll(db);

    const cjScoped = await getMapSearchPage(db, { ...baseQuery(), keys: ["7k"], patterns: ["chordjack"] });
    expect(cjScoped.items.map((item) => item.beatmapId).sort()).toEqual([1, 2]);
    const byId = new Map(cjScoped.items.map((item) => [item.beatmapId, item] as const));
    expect(byId.get(1)?.patterns.chordjack).toBe(1);
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

describe("map search LN-adjusted MSD", () => {
  it("carries the blended msdLn on bulk rows and diffs, so detail surfaces never flicker", async () => {
    const db = await makeDb();
    // Hold-bearing 4K chart: the sweep stored the raw tail-aware calc, the
    // entry must carry the keymode-blended (0.1 for 4K) display values.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "stream", patterns: { stream: 1 } });
    await seedAnalysis(db, 1, {
      lnRatio: 0.3,
      msdValues: { Overall: 20, Stream: 18 },
      msdLnValues: { Overall: 24, Stream: 22 },
    });
    // Rice chart: no tail calc, msdLn stays null.
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, primary: "jack", patterns: { jack: 1 } });
    await seedAnalysis(db, 2, { lnRatio: 0.01, msdValues: { Overall: 15, JackSpeed: 15 } });
    // Tail calc present but identical to base (holds too sparse to matter):
    // blending changes nothing, so the redundant readout is suppressed.
    await seedMap(db, { beatmapId: 3, beatmapsetId: 30, primary: "tech", patterns: { tech: 1 } });
    await seedAnalysis(db, 3, {
      lnRatio: 0.05,
      msdValues: { Overall: 17, Technical: 17 },
      msdLnValues: { Overall: 17, Technical: 17 },
    });
    await buildAll(db);

    const all = await getMapSearchPage(db, baseQuery());
    const byId = new Map(all.items.map((item) => [item.beatmapId, item]));
    expect(byId.get(1)?.msdLn?.Overall).toBeCloseTo(20.4, 5);
    expect(byId.get(1)?.msdLn?.Stream).toBeCloseTo(18.4, 5);
    expect(byId.get(1)?.diffs[0]?.msdLn?.Overall).toBeCloseTo(20.4, 5);
    expect(byId.get(2)?.msdLn).toBeNull();
    expect(byId.get(3)?.msdLn).toBeNull();

    // The single-map detail entry agrees with the bulk row.
    const detail = await getMapSearchSetEntry(db, 1);
    expect(detail?.msdLn?.Overall).toBeCloseTo(20.4, 5);
  });

  it("serves a sweep-updated tail calc on the detail entry before the index copy refreshes", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, primary: "stream", patterns: { stream: 1 } });
    await seedAnalysis(db, 1, { lnRatio: 0.3, msdValues: { Overall: 20, Stream: 18 } });
    await buildAll(db);
    expect((await getMapSearchSetEntry(db, 1))?.msdLn).toBeNull();

    // The LN sweep updates the analysis row in place, index row untouched.
    await exec(
      db,
      "update beatmap_chart_analysis set msd_ln_json = json(?) where beatmap_id = 1",
      [json({ etternaVersion: "0.72.3", values: { Overall: 24, Stream: 22 } })],
    );
    expect((await getMapSearchSetEntry(db, 1))?.msdLn?.Overall).toBeCloseTo(20.4, 5);
  });
});

describe("map search status reconciliation", () => {
  it("heals a stale qualified index row from the fresh ranked column, no rebuild", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, status: "qualified", primary: "stream", patterns: { stream: 1 } });
    await buildAll(db);
    expect((await getMapSearchSetEntry(db, 1))?.status).toBe("qualified");

    // The farmed path refreshes only the beatmaps.status *column* while
    // metadata_json still says qualified, exactly as the live pipeline does.
    await exec(db, "update beatmaps set status = 'ranked' where beatmap_id = 1");

    expect(await reconcileMapSearchIndexStatuses(db)).toBe(1);
    expect((await getMapSearchSetEntry(db, 1))?.status).toBe("ranked");
    // Idempotent: a second sweep changes nothing.
    expect(await reconcileMapSearchIndexStatuses(db)).toBe(0);
  });

  it("never downgrades a settled index row from a stale column", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, status: "ranked", primary: "stream", patterns: { stream: 1 } });
    await buildAll(db);
    // A stale/incorrect column must not revert a genuinely-ranked index row.
    await exec(db, "update beatmaps set status = 'qualified' where beatmap_id = 1");
    expect(await reconcileMapSearchIndexStatuses(db)).toBe(0);
    expect((await getMapSearchSetEntry(db, 1))?.status).toBe("ranked");
  });

  it("propagates a fresh ranked status across every in-flux diff of the set", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, status: "qualified", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 10, status: "qualified", primary: "jack", patterns: { jack: 1 } });
    await buildAll(db);

    const stmt = buildMapStatusPropagationStatement(10, "ranked", "2026-07-06T00:00:00Z");
    expect(stmt).not.toBeNull();
    await exec(db, stmt!.sql, stmt!.args);
    expect((await getMapSearchSetEntry(db, 1))?.status).toBe("ranked");
    expect((await getMapSearchSetEntry(db, 2))?.status).toBe("ranked");

    // A non-settled or empty payload is a no-op, and a settled payload never
    // overwrites a row that has already settled.
    expect(buildMapStatusPropagationStatement(10, "pending", "t")).toBeNull();
    expect(buildMapStatusPropagationStatement(10, "", "t")).toBeNull();
    const loved = buildMapStatusPropagationStatement(10, "loved", "2026-07-06T00:00:00Z")!;
    await exec(db, loved.sql, loved.args);
    expect((await getMapSearchSetEntry(db, 1))?.status).toBe("ranked");
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

  it("exposes subfamily tags on entries and never writes zero-score ids", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, lnCount: 0, primary: "stream", patterns: { stream: 1 } });
    // Pre-fix analyzer shape: a legitimately detected family + subfamily plus
    // the force-appended score-0 ln candidate on a zero-LN chart.
    await seedAnalysis(db, 1, {
      patterns: [
        { id: "stream", score: 0.9 },
        { id: "dumpstream", score: 0.6 },
        { id: "ln", score: 0 },
      ],
    });
    await buildAll(db);

    const tagsRow = (await exec(db, "select pattern_tags from map_search_index where beatmap_id = 1")).rows[0];
    expect(String(tagsRow?.pattern_tags)).toBe(" stream dumpstream ");

    // Entries carry only the subfamily vocabulary; families already ride in
    // patterns/primaryPattern.
    const entry = await getMapSearchSetEntry(db, 1);
    expect(entry?.patternTags).toEqual(["dumpstream"]);
    expect(entry?.diffs?.[0]?.patternTags).toEqual(["dumpstream"]);
    const page = await getMapSearchPage(db, baseQuery());
    expect(page.items[0]?.patternTags).toEqual(["dumpstream"]);
  });
});

describe("map search play count reconciliation", () => {
  it("copies fresher metadata playcounts into the index without a rebuild", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, playcount: 77, primary: "stream", patterns: { stream: 1 } });
    await buildAll(db);
    expect((await getMapSearchSetEntry(db, 1))?.playCount).toBe(77);

    // Ingest / enrich_beatmap refresh metadata_json with no index write, the
    // exact staleness the sweep exists to heal.
    await exec(db, "update beatmaps set metadata_json = json_set(metadata_json, '$.playcount', 320, '$.passcount', 45) where beatmap_id = 1");
    expect(await reconcileMapSearchIndexPlayCounts(db)).toBe(1);
    expect((await getMapSearchSetEntry(db, 1))?.playCount).toBe(320);
    const row = (await exec(db, "select pass_count from map_search_index where beatmap_id = 1")).rows[0];
    expect(Number(row?.pass_count)).toBe(45);

    // Idempotent: a second sweep changes nothing.
    expect(await reconcileMapSearchIndexPlayCounts(db)).toBe(0);
  });

  it("never zeroes counts from metadata that lacks a playcount", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, playcount: 500, primary: "stream", patterns: { stream: 1 } });
    await buildAll(db);
    await exec(db, "update beatmaps set metadata_json = json_remove(metadata_json, '$.playcount') where beatmap_id = 1");
    expect(await reconcileMapSearchIndexPlayCounts(db)).toBe(0);
    expect((await getMapSearchSetEntry(db, 1))?.playCount).toBe(500);
  });
});

describe("bogus ln pattern tag cleanup", () => {
  it("strips the stale ln tag only where the chart's LN signal is zero", async () => {
    const db = await makeDb();
    // Rice chart (0 LN notes, no LN share): carries the pre-fix bogus tag.
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, lnCount: 0, primary: "stream", patterns: { stream: 1 } });
    // Real LN chart: its ln tag is a genuine detection and must survive.
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, lnCount: 400, primary: "ln", patterns: { ln: 1 } });
    // Rice chart whose only tag was the bogus ln: collapses to empty.
    await seedMap(db, { beatmapId: 3, beatmapsetId: 30, lnCount: 0, primary: "jack", patterns: { jack: 1 } });
    await buildAll(db);
    await exec(db, "update map_search_index set pattern_tags = ' stream ln ' where beatmap_id = 1");
    await exec(db, "update map_search_index set pattern_tags = ' lngeneral ln ' where beatmap_id = 2");
    await exec(db, "update map_search_index set pattern_tags = ' ln ' where beatmap_id = 3");

    expect(await cleanupBogusLnPatternTags(db)).toBe(2);
    const tags = async (beatmapId: number) => String(
      (await exec(db, "select pattern_tags from map_search_index where beatmap_id = ?", [beatmapId])).rows[0]?.pattern_tags,
    );
    expect(await tags(1)).toBe(" stream ");
    expect(await tags(2)).toBe(" lngeneral ln ");
    expect(await tags(3)).toBe("");

    // Idempotent: a second pass finds nothing left to heal.
    expect(await cleanupBogusLnPatternTags(db)).toBe(0);
  });
});

describe("map search trigram FTS", () => {
  it("keeps the FTS mirror in sync and matches substrings through it", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, title: "Freedom Dive", artist: "xi", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, title: "Calm", artist: "Other", primary: "ln", patterns: { ln: 1 } });
    await buildAll(db);

    // The external-content mirror carries one row per index row.
    const ftsCount = Number((await exec(db, "select count(*) as c from map_search_fts")).rows[0]?.c);
    const indexCount = Number((await exec(db, "select count(*) as c from map_search_index")).rows[0]?.c);
    expect(ftsCount).toBe(indexCount);

    // %substring% semantics survive the trigram routing (3+ char term).
    const hit = await getMapSearchPage(db, { ...baseQuery(), q: "eedom" });
    expect(hit.total).toBe(1);
    expect(hit.items[0].beatmapId).toBe(1);

    // Deletes propagate through the trigger.
    await exec(db, "delete from map_search_index where beatmap_id = 1");
    const afterDelete = await getMapSearchPage(db, { ...baseQuery(), q: "eedom" });
    expect(afterDelete.total).toBe(0);
  });

  it("drops lone ASCII characters as noise and keeps two-character terms on LIKE", async () => {
    const db = await makeDb();
    await seedMap(db, { beatmapId: 1, beatmapsetId: 10, title: "Banger", artist: "xi", primary: "stream", patterns: { stream: 1 } });
    await seedMap(db, { beatmapId: 2, beatmapsetId: 20, title: "Calm", artist: "Other", primary: "ln", patterns: { ln: 1 } });
    await buildAll(db);

    // A lone ASCII character is ignored outright (dropping it only widens).
    const noise = await getMapSearchPage(db, { ...baseQuery(), q: "x" });
    expect(noise.total).toBe(2);
    // Two-character terms still filter (the "xi" artist case).
    const xi = await getMapSearchPage(db, { ...baseQuery(), q: "xi" });
    expect(xi.total).toBe(1);
    expect(xi.items[0].beatmapId).toBe(1);
  });

  it("caps the counted total and short-circuits offsets past the cap", async () => {
    const db = await makeDb();
    const now = "2026-01-01T00:00:00Z";
    const statements: DbStatement[] = [];
    for (let i = 1; i <= MAP_SEARCH_COUNT_CAP + 1; i += 1) {
      statements.push({
        sql: `insert into map_search_index
           (beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version, search_text, key_count, stars, bpm, length, status, primary_pattern, updated_at)
         values (?, ?, ?, ?, 'a', 'c', 'v', ?, 4, 5, 180, 120, 'ranked', 'stream', ?)`,
        args: [i, i, ACTIVITY_SKILL_ANALYSIS_VERSION, `Map ${i}`, `map ${i} a c v`, now],
      });
    }
    await execBatch(db, statements);

    const page = await getMapSearchPage(db, baseQuery());
    expect(page.total).toBe(MAP_SEARCH_COUNT_CAP);
    expect(page.totalCapped).toBe(true);
    expect(page.items.length).toBe(50);

    // Offset past the cap: no page walk, empty items, same capped total.
    const deep = await getMapSearchPage(db, { ...baseQuery(), page: 200 });
    expect(deep.items).toEqual([]);
    expect(deep.total).toBe(MAP_SEARCH_COUNT_CAP);
    expect(deep.totalCapped).toBe(true);
  });
});
