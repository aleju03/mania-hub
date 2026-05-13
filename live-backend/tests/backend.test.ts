import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { getSnipesSnapshot } from "../src/features/snipes.js";
import { enqueueMapsRefreshIfDue, getMapsSnapshot } from "../src/features/maps.js";
import { confirmTopPlay } from "../src/features/top-plays.js";
import { getTrackerSnapshot } from "../src/features/tracker.js";
import { routeHttp } from "../src/http/snapshots.js";
import { handleSse } from "../src/live/sse.js";
import { OscBackfill } from "../src/osc/backfill.js";
import { ScoreIngestor } from "../src/ingest/score-ingestor.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { TokenBucketLimiter } from "../src/osu/client.js";
import { WorkerRunner } from "../src/workers.js";
import type { OscScore } from "../src/shared/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

let dir = "";

async function setup(trackedCountries = ["CR"]) {
  dir = await mkdtemp(join(tmpdir(), "mania-live-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  const queue = new JobQueue(db);
  const events = new LiveEventLog(db);
  const ingestor = new ScoreIngestor(db, queue, events, {
    topPlayMarginPp: 5,
    trackedCountries,
    countryWarmTtlMs: 24 * 60 * 60 * 1000,
    osuClientId: "test-client",
    osuClientSecret: "test-secret",
  });
  return { db, queue, events, ingestor };
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("live backend", () => {
  it("migrates a fresh DB and ingests mocked oSC idempotently", async () => {
    const { db, queue, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    expect(await ingestor.ingestBatch(scores)).toEqual({ inserted: 1, skipped: 1 });
    expect(await ingestor.ingestBatch(scores)).toEqual({ inserted: 0, skipped: 2 });
    expect(Number((await exec(db, "select count(*) as count from score_events")).rows[0].count)).toBe(1);
    expect(await queue.depth()).toBeGreaterThanOrEqual(1);
  });

  it("creates enrichment jobs for unknown metadata on known tracked roster users", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values ('CR', 202, 2, 'test', 1, ?)`,
      [new Date().toISOString()],
    );
    expect(await ingestor.ingestBatch([scores[1]])).toEqual({ inserted: 1, skipped: 0 });
    const jobs = (await exec(db, "select type, count(*) as count from jobs group by type order by type")).rows;
    expect(jobs.map((row) => row.type)).toContain("enrich_user");
    expect(jobs.map((row) => row.type)).toContain("enrich_beatmap");
  });

  it("queues active-user recent reconciliation from oSC ingestion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const rows = (await exec(db, "select type, dedupe_key from jobs where type = 'reconcile_user_recent_scores'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe("recent:user:101");
  });

  it("reconciles id-zero graveyard recent scores once and fans them out by tracked country", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
    const { db, queue, events, ingestor } = await setup(["CR", "US"]);
    await exec(db, "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', 101, 1, 'test', 1, ?)", [new Date().toISOString()]);
    await exec(db, "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('US', 101, 1, 'test', 1, ?)", [new Date().toISOString()]);
    await queue.enqueue("reconcile_user_recent_scores", "recent:user:101", { userId: 101 }, { priority: 100 });

    const recentScore: OscScore = {
      id: 0,
      user_id: 101,
      ruleset_id: 3,
      accuracy: 0.925,
      beatmap_id: 777,
      mods: [],
      score: 765432,
      total_score: 765432,
      max_combo: 777,
      passed: true,
      rank: "A",
      statistics: { count_geki: 700, count_300: 200, count_katu: 30, count_100: 10, count_50: 0, count_miss: 0 },
      pp: null,
      beatmap: { id: 777, beatmapset_id: 70, difficulty_rating: 4.8, mode: "mania", status: "graveyard", cs: 4, bpm: 180, max_combo: 777, version: "[4K] practice", url: "https://osu.ppy.sh/beatmaps/777" },
      beatmapset: { id: 70, title: "Practice Pack", artist: "Mapper", creator: "mapper", covers: { cover: "https://assets.example/cover.jpg" }, status: "graveyard" },
      user: { id: 101, username: "Sniper", avatar_url: "https://assets.example/sniper.png", country_code: "CR" },
      created_at: "2026-05-12T00:04:00.000Z",
      ended_at: "2026-05-12T00:04:00.000Z",
      has_replay: false,
      type: "solo_score",
    };
    const failedRecentScore: OscScore = {
      ...recentScore,
      id: 0,
      rank: "F",
      passed: false,
      ended_at: "2026-05-12T00:04:30.000Z",
      created_at: "2026-05-12T00:04:30.000Z",
    };
    const osu = { getUserRecentScores: vi.fn(async () => [failedRecentScore, recentScore]) };
    const worker = new WorkerRunner(db, queue, events, osu as never, ingestor, "test-worker");

    await worker.runOnce();
    await queue.enqueue("reconcile_user_recent_scores", "recent:user:101:manual", { userId: 101 }, { priority: 100 });
    await worker.runOnce();

    expect(osu.getUserRecentScores).toHaveBeenCalledTimes(2);
    expect(Number((await exec(db, "select count(*) as count from score_events")).rows[0].count)).toBe(2);
    expect(Number((await exec(db, "select count(*) as count from top_play_events")).rows[0].count)).toBe(0);
    expect(Number((await exec(db, "select count(*) as count from snipe_events")).rows[0].count)).toBe(0);
    const countries = (await exec(db, "select country, count(*) as count from score_events group by country order by country")).rows;
    expect(countries.map((row) => `${row.country}:${row.count}`)).toEqual(["CR:1", "US:1"]);
    expect((await events.replay("CR", 0)).some((event) => event.type === "tracker_score")).toBe(true);
    expect((await events.replay("US", 0)).some((event) => event.type === "tracker_score")).toBe(true);
  });

  it("dedupes reconciled stable scores against oSC legacy score ids", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const oscScore = { ...scores[0], legacy_score_id: 4444 };
    const recentScore = { ...scores[0], id: 4444, legacy_score_id: undefined };
    expect(await ingestor.ingestBatch([oscScore], "osc_socket")).toEqual({ inserted: 1, skipped: 0 });
    expect(await ingestor.ingestBatch([recentScore], "osu_recent", { enqueueRecentReconcile: false, processLeaderboardFeatures: false })).toEqual({ inserted: 0, skipped: 1 });
    expect(Number((await exec(db, "select count(*) as count from score_events")).rows[0].count)).toBe(1);
  });

  it("updates the oSC cursor for metadata-light tracked scores", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values ('CR', 202, 2, 'test', 1, ?)`,
      [new Date().toISOString()],
    );
    await ingestor.ingestBatch([scores[1]], "osc_json");
    const cursor = Number(JSON.parse(String((await exec(db, "select value_json from live_meta where key = 'osc_last_seen_ms'")).rows[0].value_json)));
    expect(cursor).toBe(new Date("2026-05-12T00:03:00.000Z").getTime());
  });

  it("runs queued oSC backfill one page at a time and schedules the next page", async () => {
    const { db, queue, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values ('CR', 202, 2, 'test', 1, ?)`,
      [new Date().toISOString()],
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scores, meta: { newest: "2026-05-12T00:03:00.000Z" } }), { status: 200 }));
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 2,
    }, fetchMock as never);
    const result = await backfill.runPage(db, queue, ingestor, { after: new Date("2026-05-11T00:00:00.000Z").getTime(), pagesRemaining: 2 });
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = (await exec(db, "select type, status, payload_json from jobs where type = 'osc_backfill'")).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0].payload_json)).pagesRemaining).toBe(1);
  });

  it("returns tracker snapshots and replayable SSE event rows", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const snapshot = await getTrackerSnapshot(db, "CR", 10);
    expect(snapshot.scores).toHaveLength(1);
    expect(snapshot.scores[0].user.username).toBe("Sniper");
    const missed = await events.replay("CR", 0);
    expect(missed.some((event) => event.type === "tracker_score")).toBe(true);
  });

  it("emits top play only after best-score confirmation", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    expect(Number((await exec(db, "select count(*) as count from top_play_events")).rows[0].count)).toBe(0);
    const best = await fixture<OscScore[]>("top-best.json");
    const osu = {
      getBeatmapUserScoresAll: async (_beatmapId: number, _userId: number, _caller?: string) => [],
      getUserBestScores: async (_userId: number, _caller?: string) => best,
    };
    const emitted = await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" });
    expect(emitted).toBe(true);
    expect(Number((await exec(db, "select count(*) as count from top_play_events")).rows[0].count)).toBe(1);
    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).toBe(false);
  });

  it("calculates top-play pp gain from the previous same-beatmap best", async () => {
    const { db, events } = await setup();
    const baseBest = (await fixture<OscScore[]>("top-best.json"))[0];
    const current = { ...baseBest, id: 9001, beatmap_id: 501, pp: 223.538, ended_at: "2026-05-12T07:06:51.000Z", created_at: "2026-05-12T07:06:51.000Z" };
    const best: OscScore[] = [
      { ...baseBest, id: 8001, beatmap_id: 601, pp: 243.68 },
      current,
      { ...baseBest, id: 8002, beatmap_id: 602, pp: 222.453 },
      { ...baseBest, id: 8003, beatmap_id: 603, pp: 145 },
    ];
    const previousSameMap = {
      ...baseBest,
      id: 7001,
      beatmap_id: 501,
      pp: 200,
      ended_at: "2026-05-11T07:06:51.000Z",
      created_at: "2026-05-11T07:06:51.000Z",
    };
    const osu = {
      getBeatmapUserScoresAll: vi.fn(async (_beatmapId: number, _userId: number, _caller?: string) => [current, previousSameMap]),
      getUserBestScores: async (_userId: number, _caller?: string) => best,
    };

    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).toBe(true);

    const row = (await exec(db, "select pp_gain from top_play_events where score_id = ?", [9001])).rows[0];
    expect(Number(row.pp_gain)).toBeCloseTo(21.2946, 4);
    expect(Number(row.pp_gain)).not.toBeCloseTo(1.0308, 3);
    expect(osu.getBeatmapUserScoresAll).toHaveBeenCalledWith(501, 101, "job:refresh_user_top_scores:pp_gain");
  });

  it("stores one snipe event from a durable country board", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (303, 'Victim', 'https://assets.example/victim.png', 'CR', ?)`,
      [new Date().toISOString()],
    );
    await exec(
      db,
      `insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
       values ('CR', 501, 'normal:lazer', 303, 7000, 900000, 200, 0.97, 'S', '[]', 1, 1, '2026-05-11T00:00:00.000Z', ?)`,
      [new Date().toISOString()],
    );
    await ingestor.ingestBatch([scores[0]]);
    const snipes = await getSnipesSnapshot(db, "CR", 10);
    expect(snipes.events).toHaveLength(1);
    expect(snipes.events[0].victim.id).toBe(303);
    expect(Number((await exec(db, "select count(*) as count from snipe_events")).rows[0].count)).toBe(1);
  });

  it("proves the osu! limiter hard cap", async () => {
    vi.useFakeTimers();
    const limiter = new TokenBucketLimiter(2, 10_000);
    const calls: number[] = [];
    const tasks = [0, 1, 2].map(() => limiter.schedule("test", "/test", async () => {
      calls.push(Date.now());
      return true;
    }));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_001);
    await Promise.all(tasks);
    expect(calls).toHaveLength(3);
    expect(calls[2] - calls[0]).toBeGreaterThanOrEqual(60_000);
  });

  it("queues stale maps snapshots without duplicating active refresh jobs", async () => {
    const { db, queue } = await setup();
    const snapshot = await getMapsSnapshot(db, queue, "CR", 7 * 24 * 60 * 60 * 1000);
    expect(snapshot.value).toBeNull();
    expect(snapshot.isStale).toBe(true);
    expect(snapshot.refreshQueued).toBe(true);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_country_maps'")).rows[0].count)).toBe(1);

    expect(await enqueueMapsRefreshIfDue(db, queue, "CR", 7 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_country_maps'")).rows[0].count)).toBe(1);
  });

  it("queues maps refreshes from the maps snapshot HTTP endpoint", async () => {
    const { db, queue, events } = await setup();
    const writes: string[] = [];
    const req = new EventEmitter() as IncomingMessage;
    req.method = "GET";
    req.url = "/api/snapshots/maps?country=CR";
    req.headers = { host: "localhost" };
    const res = {
      setHeader: vi.fn(),
      end: (chunk: string) => {
        writes.push(chunk);
      },
    } as unknown as ServerResponse;

    expect(await routeHttp(req, res, {
      db,
      queue,
      events,
      config: {
        allowedOrigins: ["http://localhost:3000"],
        trackedCountries: ["CR"],
        rosterRefreshIntervalMs: 24 * 60 * 60 * 1000,
        mapsRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
      },
      osu: {},
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never)).toBe(true);

    expect(JSON.parse(writes.join(""))).toMatchObject({ value: null, isStale: true, refreshQueued: true });
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_country_maps'")).rows[0].count)).toBe(1);
  });

  it("streams SSE hello, heartbeat, and Last-Event-ID replay", async () => {
    vi.useFakeTimers();
    const { db, queue, events } = await setup();
    await events.append("tracker_score", "CR", { id: 123 }, "test:tracker:123");
    const writes: string[] = [];
    const req = new EventEmitter() as IncomingMessage;
    req.url = "/api/live?country=CR";
    req.headers = { host: "localhost", "last-event-id": "0" };
    const res = {
      writeHead: vi.fn(),
      setHeader: vi.fn(),
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: vi.fn(),
    } as unknown as ServerResponse;
    const handled = await handleSse(req, res, {
      db,
      queue,
      events,
      config: {
        allowedOrigins: ["http://localhost:3000"],
        trackedCountries: ["CR"],
      },
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);
    expect(handled).toBe(true);
    expect(writes.join("")).toContain("event: hello");
    expect(writes.join("")).toContain("event: tracker_score");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(writes.join("")).toContain("event: heartbeat");
    req.emit("close");
  });

  it("does not replay cross-country SSE events", async () => {
    const { db, queue, events } = await setup();
    await events.append("tracker_score", "CR", { id: "cr" }, "test:cr");
    await events.append("tracker_score", "US", { id: "us" }, "test:us");
    const writes: string[] = [];
    const req = new EventEmitter() as IncomingMessage;
    req.url = "/api/live?country=CR";
    req.headers = { host: "localhost", "last-event-id": "0" };
    const res = {
      writeHead: vi.fn(),
      setHeader: vi.fn(),
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: vi.fn(),
    } as unknown as ServerResponse;
    await handleSse(req, res, {
      db,
      queue,
      events,
      config: {
        allowedOrigins: ["http://localhost:3000"],
        trackedCountries: ["CR"],
      },
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0, byCaller: [], byPath: [] }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);
    const output = writes.join("");
    expect(output).toContain('"id":"cr"');
    expect(output).not.toContain('"id":"us"');
    req.emit("close");
  });
});
