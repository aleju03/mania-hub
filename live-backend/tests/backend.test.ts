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
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { handleSse } from "../src/live/sse.js";
import { OscBackfill } from "../src/osc/backfill.js";
import { refreshCountryRoster } from "../src/rosters/country-rosters.js";
import { ScoreIngestor } from "../src/ingest/score-ingestor.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { OsuApiClient, TokenBucketLimiter } from "../src/osu/client.js";
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

function mockReq(method: string, url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
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
    writeHead: vi.fn((status: number, value?: Record<string, string>) => {
      res.statusCode = status;
      for (const [key, headerValue] of Object.entries(value ?? {})) headers[key.toLowerCase()] = String(headerValue);
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

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    nodeEnv: "production",
    allowedOrigins: ["http://localhost:3000"],
    trackedCountries: ["CR"],
    trustProxyHeaders: true,
    countryWarmTtlMs: 24 * 60 * 60 * 1000,
    rosterRefreshIntervalMs: 24 * 60 * 60 * 1000,
    publicApiRatePerMinute: 120,
    publicCostlyRatePerMinute: 30,
    countryActivateRatePerMinute: 10,
    countryActivateGlobalRatePerMinute: 120,
    countryActivateNewPerHour: 12,
    danEstimateRatePerMinute: 20,
    sseConnectRatePerMinute: 30,
    sseMaxConnectionsPerIp: 6,
    sseMaxConnectionsTotal: 500,
    replayVideoRatePerMinute: 2,
    replayVideoPublicEnabled: false,
    replayVideoUploadMaxBytes: 600 * 1024 * 1024,
    mapsRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
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

  it("clears stale job errors when a retry succeeds", async () => {
    const { db, queue } = await setup();
    await queue.enqueue("refresh_user_top_scores", "top:test", { userId: 101, scoreId: 9001, country: "CR" });
    const job = (await queue.claim("test-worker"))[0];
    await queue.fail(job.id, new Error("temporary failure"), 1);
    await queue.complete(job.id);

    const row = (await exec(db, "select status, last_error from jobs where id = ?", [job.id])).rows[0];
    expect(row.status).toBe("done");
    expect(row.last_error).toBeNull();
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
    expect(await ingestor.ingestBatch([{ ...scores[1], ranked: true }])).toEqual({ inserted: 1, skipped: 0 });
    const jobs = (await exec(db, "select type, count(*) as count from jobs group by type order by type")).rows;
    expect(jobs.map((row) => row.type)).toContain("enrich_user");
    expect(jobs.map((row) => row.type)).toContain("enrich_beatmap");
    expect(jobs.map((row) => row.type)).toContain("refresh_user_top_scores");
  });

  it("refreshes country rosters as the current top ranked users", async () => {
    const { db } = await setup();
    const now = new Date().toISOString();
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values
         ('CR', 111, 1, 'osu_rankings', 1, ?),
         ('CR', 222, 2, 'osu_rankings', 1, ?),
         ('CR', 444, null, 'score', 1, ?)`,
      [now, now, now],
    );
    const ranking = [
      { user: { id: 222, username: "Still In", avatar_url: "https://assets.example/222.png", country_code: "CR", statistics: { pp: 1234, global_rank: 1000, country_rank: 1 } } },
      { user: { id: 333, username: "New In", avatar_url: "https://assets.example/333.png", country_code: "CR", statistics: { pp: 1200, global_rank: 1100, country_rank: 2 } } },
    ];
    const osu = {
      getRanking: vi.fn(async (_country: string, page: number) => ({ ranking: page === 1 ? ranking : [] })),
    };

    await expect(refreshCountryRoster(db, osu as never, "CR", "test")).resolves.toBe(2);

    const rows = (await exec(
      db,
      "select user_id, rank, is_tracked from country_rosters where country = 'CR' order by user_id",
    )).rows;
    expect(rows.map((row) => `${row.user_id}:${row.rank ?? "null"}:${row.is_tracked}`)).toEqual([
      "111:1:0",
      "222:1:1",
      "333:2:1",
      "444:null:0",
    ]);
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

  it("resolves id-zero API recent scores from the osu! web recent endpoint", async () => {
    const { db, ingestor } = await setup();
    const apiScore: OscScore = {
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
      type: "score_mania",
    };
    const webScore: OscScore = {
      ...apiScore,
      id: 123456,
      type: "solo_score",
      legacy_score_id: 0,
      legacy_total_score: 765432,
      total_score: 0,
      score: 0,
      accuracy: 0,
      rank: "D",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://osu.ppy.sh/oauth/token") {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/api/v2/users/101/scores/recent")) {
        return new Response(JSON.stringify([apiScore]), { status: 200 });
      }
      if (url.includes("/users/101/scores/recent")) {
        return new Response(JSON.stringify([webScore]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const osu = new OsuApiClient({
      osuClientId: "test-client",
      osuClientSecret: "test-secret",
      osuApiHardPerMinute: 60_000,
      osuApiTargetPerMinute: 60_000,
    }, fetchMock as never);

    const scores = await osu.getUserRecentScores(101, "test:recent-web-fallback");

    expect(scores[0].id).toBe(123456);
    expect(scores[0].type).toBe("solo_score");
    expect(scores[0].rank).toBe("A");
    expect(scores[0].legacy_total_score).toBe(765432);
    await ingestor.ingestBatch([apiScore], "osu_recent", { enqueueRecentReconcile: false, processLeaderboardFeatures: false });
    await ingestor.ingestBatch(scores, "osu_recent", { enqueueRecentReconcile: false, processLeaderboardFeatures: false });
    const rows = (await exec(db, "select score_id, score_identity from score_events")).rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.score_id).toBe(123456);
    expect(row.score_identity).toBe("official:123456");
  });

  it("dedupes reconciled stable scores against oSC legacy score ids", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const oscScore = { ...scores[0], legacy_score_id: 4444, mods: ["NC"] as never };
    const recentScore = {
      ...scores[0],
      id: 4444,
      legacy_score_id: undefined,
      mods: [{ acronym: "NC", settings: { speed_change: 1.3 } }],
    };
    expect(await ingestor.ingestBatch([oscScore], "osc_socket")).toEqual({ inserted: 1, skipped: 0 });
    expect(await ingestor.ingestBatch([recentScore], "osu_recent", { enqueueRecentReconcile: false, processLeaderboardFeatures: false })).toEqual({ inserted: 1, skipped: 0 });
    expect(Number((await exec(db, "select count(*) as count from score_events")).rows[0].count)).toBe(1);
    const storedScore = JSON.parse(String((await exec(db, "select score_json from score_events")).rows[0].score_json)) as OscScore;
    expect(storedScore.mods).toEqual([{ acronym: "NC", settings: { speed_change: 1.3 } }]);
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

  it("seeds and replays snipe detection after metadata-light scores are hydrated", async () => {
    const { db, queue, events, ingestor } = await setup();
    const score = (await fixture<OscScore[]>("scores.json"))[1];
    const now = new Date().toISOString();
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values
         ('CR', 202, 2, 'test', 1, ?),
         ('CR', 303, 3, 'test', 1, ?)`,
      [now, now],
    );
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (303, 'Victim', 'https://assets.example/victim.png', 'CR', ?)`,
      [now],
    );

    await ingestor.ingestBatch([score], "osc_socket");
    expect(Number((await exec(db, "select count(*) as count from snipe_events")).rows[0].count)).toBe(0);

    const osu = {
      getUser: vi.fn(async () => ({ id: 202, username: "Hydrated Sniper", avatar_url: "https://assets.example/sniper.png", country_code: "CR" })),
      getBeatmap: vi.fn(async () => ({
        id: 502,
        beatmapset_id: 50,
        difficulty_rating: 5.6,
        mode: "mania",
        status: "ranked",
        cs: 4,
        bpm: 180,
        max_combo: 999,
        version: "Hydrated Another",
        url: "https://osu.ppy.sh/beatmaps/502",
        beatmapset: {
          id: 50,
          title: "Fixture Song",
          artist: "Fixture Artist",
          creator: "mapper",
          covers: { cover: "https://assets.example/cover.jpg", card: "https://assets.example/card.jpg" },
          status: "ranked",
        },
      })),
      getBeatmapUserScoresAll: vi.fn(async (_beatmapId: number, userId: number) => userId === 303
        ? [{
          ...score,
          id: 7000,
          user_id: 303,
          score: 800000,
          total_score: 800000,
          pp: 190,
          accuracy: 0.97,
          ended_at: "2026-05-11T00:00:00.000Z",
          created_at: "2026-05-11T00:00:00.000Z",
        }]
        : []),
    };
    const worker = new WorkerRunner(db, queue, events, osu as never, ingestor, "test-worker");

    await worker.runOnce();
    expect(Number((await exec(db, "select count(*) as count from snipe_events")).rows[0].count)).toBe(0);
    await worker.runOnce();

    const snipes = await getSnipesSnapshot(db, "CR", 10);
    expect(snipes.events).toHaveLength(1);
    expect(snipes.events[0].score_id).toBe(9002);
    expect(snipes.events[0].victim.id).toBe(303);
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

  it("requeues completed oSC backfill cursor jobs on a new catch-up chain", async () => {
    const { db, queue, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const nextAfter = new Date("2026-05-12T00:03:00.000Z").getTime() + 1;
    await queue.enqueue("osc_backfill", `osc-backfill:${nextAfter}`, { after: nextAfter, pagesRemaining: 99 }, { priority: 5 });
    const existing = (await exec(db, "select id from jobs where dedupe_key = ?", [`osc-backfill:${nextAfter}`])).rows[0];
    await queue.complete(Number(existing.id));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scores, meta: { newest: "2026-05-12T00:03:00.000Z" } }), { status: 200 }));
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 2,
    }, fetchMock as never);

    await backfill.runPage(db, queue, ingestor, { after: new Date("2026-05-11T00:00:00.000Z").getTime(), pagesRemaining: 2 });

    const row = (await exec(db, "select status, attempts, payload_json from jobs where dedupe_key = ?", [`osc-backfill:${nextAfter}`])).rows[0];
    expect(row.status).toBe("queued");
    expect(Number(row.attempts)).toBe(0);
    expect(JSON.parse(String(row.payload_json)).pagesRemaining).toBe(1);
  });

  it("resumes startup oSC backfill from an unfinished backfill cursor instead of latest live score", async () => {
    const { db, queue } = await setup();
    const oldGapCursor = Date.now() - 60 * 60_000;
    const liveSocketCursor = Date.now() - 1_000;
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osc_last_seen_ms', ?, ?)", [
      JSON.stringify(liveSocketCursor),
      new Date().toISOString(),
    ]);
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osc_backfill_last_result', ?, ?)", [
      JSON.stringify({ fetched: 2, inserted: 1, skipped: 1, after: oldGapCursor - 1, nextAfter: oldGapCursor, hasMore: true }),
      new Date().toISOString(),
    ]);
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 2,
    });

    await backfill.enqueueStartup(queue, db);

    const row = (await exec(db, "select payload_json from jobs where dedupe_key = 'osc-backfill:startup'")).rows[0];
    expect(JSON.parse(String(row.payload_json)).after).toBe(oldGapCursor);
  });

  it("stores a contiguous oSC backfill cursor after each page", async () => {
    const { db, queue, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const nextAfter = new Date("2026-05-12T00:03:00.000Z").getTime() + 1;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scores, meta: { newest: "2026-05-12T00:03:00.000Z" } }), { status: 200 }));
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 2,
    }, fetchMock as never);

    await backfill.runPage(db, queue, ingestor, { after: new Date("2026-05-11T00:00:00.000Z").getTime(), pagesRemaining: 2 });

    const row = (await exec(db, "select value_json from live_meta where key = 'osc_backfill_cursor_ms'")).rows[0];
    expect(JSON.parse(String(row.value_json))).toBe(nextAfter);
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

  it("deduplicates repeated best-score ids during top-play confirmation", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const best = await fixture<OscScore[]>("top-best.json");
    const osu = {
      getBeatmapUserScoresAll: async (_beatmapId: number, _userId: number, _caller?: string) => [],
      getUserBestScores: async (_userId: number, _caller?: string) => [best[0], { ...best[0] }, { ...best[0], id: 9002, pp: 200 }],
    };

    await expect(confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).resolves.toBe(true);

    const row = (await exec(db, "select count(*) as count from user_top_scores where user_id = 101 and score_id = 9001")).rows[0];
    expect(Number(row.count)).toBe(1);
  });

  it("confirms oSC top plays by legacy score id when osu! best scores use the stable id", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const oscScore = { ...scores[0], id: 99001, legacy_score_id: 9001 };

    await ingestor.ingestBatch([oscScore], "osc_socket");

    const job = (await exec(db, "select dedupe_key, payload_json from jobs where type = 'refresh_user_top_scores'")).rows[0];
    expect(job.dedupe_key).toBe("top:101:9001");
    expect(JSON.parse(String(job.payload_json)).scoreId).toBe(9001);

    const best = await fixture<OscScore[]>("top-best.json");
    const osu = {
      getBeatmapUserScoresAll: async (_beatmapId: number, _userId: number, _caller?: string) => [],
      getUserBestScores: async (_userId: number, _caller?: string) => best,
    };

    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 99001, country: "CR" })).toBe(true);
    expect(Number((await exec(db, "select count(*) as count from top_play_events where score_id = 9001")).rows[0].count)).toBe(1);
  });

  it("confirms reconciled top plays by the score id stored in score_json", async () => {
    const { db, events } = await setup();
    const best = await fixture<OscScore[]>("top-best.json");
    const score = best[0];
    await exec(
      db,
      `insert into score_events
       (score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (?, ?, null, ?, 'CR', ?, 3, ?, ?, ?, ?, ?, 1, 0, 0, 0, ?, ?, 'osu_recent')`,
      [99001, "official:9001", score.user_id, score.beatmap_id ?? score.beatmap?.id ?? 501, JSON.stringify(score), score.pp, score.total_score ?? score.score, score.accuracy, score.rank, score.ended_at ?? score.created_at ?? "", new Date().toISOString()],
    );
    const osu = {
      getBeatmapUserScoresAll: async (_beatmapId: number, _userId: number, _caller?: string) => [],
      getUserBestScores: async (_userId: number, _caller?: string) => best,
    };

    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 99001, country: "CR" })).toBe(true);
    expect(Number((await exec(db, "select count(*) as count from top_play_events where score_id = 9001")).rows[0].count)).toBe(1);
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

  it("detects the triggering snipe after first-time board seeding", async () => {
    const { db, queue, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const now = new Date().toISOString();
    const current = { ...scores[0], pp: null, total_score: 1000, score: 1000 };
    const previousSelf = {
      ...current,
      id: 8001,
      total_score: 800,
      score: 800,
      ended_at: "2026-05-11T00:02:00.000Z",
      created_at: "2026-05-11T00:02:00.000Z",
    };
    const victim = {
      ...current,
      id: 7001,
      user_id: 303,
      total_score: 900,
      score: 900,
      ended_at: "2026-05-10T00:02:00.000Z",
      created_at: "2026-05-10T00:02:00.000Z",
      user: {
        id: 303,
        username: "Victim",
        avatar_url: "https://assets.example/victim.png",
        country_code: "CR",
      },
    };
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (303, 'Victim', 'https://assets.example/victim.png', 'CR', ?)`,
      [now],
    );
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values
         ('CR', 101, 1, 'osu_rankings', 1, ?),
         ('CR', 303, 2, 'osu_rankings', 1, ?)`,
      [now, now],
    );

    await ingestor.ingestBatch([current], "osc_socket", { enqueueRecentReconcile: false });
    const osu = {
      getBeatmapUserScoresAll: vi.fn(async (_beatmapId: number, userId: number) => {
        if (userId === 101) return [current, previousSelf];
        if (userId === 303) return [victim];
        return [];
      }),
    };
    const worker = new WorkerRunner(db, queue, events, osu as never, ingestor, "test-worker");

    await worker.runOnce();

    const snipes = await getSnipesSnapshot(db, "CR", 10);
    expect(snipes.events).toHaveLength(1);
    expect(snipes.events[0].score_id).toBe(current.id);
    expect(snipes.events[0].victim.id).toBe(303);
    expect(snipes.events[0].victimTotalScore).toBe(900);
  });

  it("does not count improving an already leading score as a snipe", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (303, 'Runner Up', 'https://assets.example/runner-up.png', 'CR', ?)`,
      [new Date().toISOString()],
    );
    await exec(
      db,
      `insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
       values
         ('CR', 501, 'normal:lazer', 101, 7001, 950000, 210, 0.98, 'S', '[]', 1, 1, '2026-05-11T00:00:00.000Z', ?),
         ('CR', 501, 'normal:lazer', 303, 7000, 900000, 200, 0.97, 'S', '[]', 1, 1, '2026-05-11T00:00:00.000Z', ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );

    await ingestor.ingestBatch([scores[0]]);

    const snipes = await getSnipesSnapshot(db, "CR", 10);
    expect(snipes.events).toHaveLength(0);
    expect(Number((await exec(db, "select count(*) as count from snipe_events")).rows[0].count)).toBe(0);
    const updatedLeader = (await exec(
      db,
      "select total_score from country_beatmap_scores where country = 'CR' and beatmap_id = 501 and lane_key = 'normal:lazer' and user_id = 101",
    )).rows[0];
    expect(Number(updatedLeader.total_score)).toBe(987654);
  });

  it("seeds snipe boards from ranked current roster rows only", async () => {
    const { db, queue, events, ingestor } = await setup();
    const now = new Date().toISOString();
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values
         ('CR', 101, 1, 'osu_rankings', 1, ?),
         ('CR', 202, null, 'score', 1, ?),
         ('CR', 303, 2, 'osu_rankings', 0, ?)`,
      [now, now, now],
    );
    await queue.enqueue("seed_snipe_board", "test:snipe-seed", { country: "CR", beatmapId: 501, laneKey: "normal:lazer" }, { priority: 100 });
    const osu = { getBeatmapUserScoresAll: vi.fn(async () => []) };
    const worker = new WorkerRunner(db, queue, events, osu as never, ingestor, "test-worker");

    await worker.runOnce();

    expect(osu.getBeatmapUserScoresAll).toHaveBeenCalledTimes(1);
    expect(osu.getBeatmapUserScoresAll).toHaveBeenCalledWith(501, 101, "job:seed_snipe_board");
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

  it("prioritizes interactive osu! calls ahead of queued bulk work", async () => {
    vi.useFakeTimers();
    const limiter = new TokenBucketLimiter(100, 60_000);
    const calls: string[] = [];

    const tasks = [
      limiter.schedule("job:seed_snipe_board", "/beatmaps/1/scores/users/1/all", async () => {
        calls.push("bulk-1");
        return true;
      }),
      limiter.schedule("job:seed_snipe_board", "/beatmaps/1/scores/users/2/all", async () => {
        calls.push("bulk-2");
        return true;
      }),
      limiter.schedule("getUser", "/users/123/mania", async () => {
        calls.push("interactive");
        return true;
      }),
    ];

    await vi.advanceTimersByTimeAsync(3);
    await Promise.all(tasks);

    expect(calls).toEqual(["bulk-1", "interactive", "bulk-2"]);
  });

  it("allows a small burst for interactive osu! profile calls", async () => {
    vi.useFakeTimers();
    const limiter = new TokenBucketLimiter(60, 45, undefined, { interactiveBurstCapacity: 4 });
    const calls: number[] = [];

    const tasks = [0, 1, 2, 3].map((index) =>
      limiter.schedule("getUser", `/users/${index}/mania`, async () => {
        calls.push(Date.now());
        return true;
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(tasks);

    expect(calls).toHaveLength(4);
    expect(Math.max(...calls) - Math.min(...calls)).toBeLessThan(100);
  });

  it("keeps non-interactive osu! work on the normal pace", async () => {
    vi.useFakeTimers();
    const limiter = new TokenBucketLimiter(60, 60, undefined, { interactiveBurstCapacity: 4 });
    const calls: number[] = [];

    const tasks = [1, 2].map((userId) =>
      limiter.schedule("job:seed_snipe_board", `/beatmaps/1/scores/users/${userId}/all`, async () => {
        calls.push(Date.now());
        return true;
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(tasks);

    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1_000);
  });

  it("coalesces identical in-flight osu! API calls", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      return Response.json({ id: 123, username: "Coalesced" });
    });
    const osu = new OsuApiClient({
      osuClientId: "test-client",
      osuClientSecret: "test-secret",
      osuApiHardPerMinute: 60,
      osuApiTargetPerMinute: 60,
    }, fetchImpl as typeof fetch);

    const [first, second] = await Promise.all([
      osu.getJson("/users/123/mania", "getUser"),
      osu.getJson("/users/123/mania", "getUser"),
    ]);

    expect(first).toEqual(second);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes("/api/v2/users/123/mania"))).toHaveLength(1);
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

  it("rejects disallowed browser origins before public API work", async () => {
    const { res, writes } = mockRes();
    const handled = await routeHttp(mockReq("GET", "/api/osu/v2", { origin: "https://evil.example" }), res, {
      config: baseConfig(),
    } as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(writes.join(""))).toMatchObject({ error: "forbidden_origin" });
  });

  it("rate-limits no-origin public API requests by IP", async () => {
    const abuse = new AbuseGuard();
    const config = baseConfig({ publicApiRatePerMinute: 1 });
    const first = mockRes();
    const second = mockRes();

    await routeHttp(mockReq("GET", "/api/osu/v2", { "x-real-ip": "203.0.113.10" }), first.res, {
      config,
      abuse,
    } as never);
    await routeHttp(mockReq("GET", "/api/osu/v2", { "x-real-ip": "203.0.113.10" }), second.res, {
      config,
      abuse,
    } as never);

    expect(first.res.statusCode).toBe(401);
    expect(second.res.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
  });

  it("keeps dynamic countries but throttles new-country activation", async () => {
    const { db, queue, events } = await setup();
    const abuse = new AbuseGuard();
    const config = baseConfig({ countryActivateRatePerMinute: 1, countryActivateNewPerHour: 20 });
    const first = mockRes();
    const second = mockRes();

    await routeHttp(mockReq("GET", "/api/snapshots/tracker?country=CO", { "x-real-ip": "203.0.113.20" }), first.res, {
      db,
      queue,
      events,
      config,
      abuse,
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);
    await routeHttp(mockReq("GET", "/api/snapshots/tracker?country=MX", { "x-real-ip": "203.0.113.20" }), second.res, {
      db,
      queue,
      events,
      config,
      abuse,
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);

    expect(first.res.statusCode).toBe(200);
    expect(JSON.parse(first.writes.join(""))).toMatchObject({ country: "CO" });
    expect(second.res.statusCode).toBe(429);
    expect(JSON.parse(second.writes.join(""))).toMatchObject({ error: "rate_limited", bucket: "countryActivate" });
  });

  it("keeps replay video uploads admin-only unless public exports are enabled", async () => {
    const { db, queue, events } = await setup();
    const config = baseConfig({
      liveAdminToken: "secret",
      replayVideoPublicEnabled: false,
      r2Endpoint: "https://r2.example",
      r2AccessKeyId: "key",
      r2SecretAccessKey: "secret",
      r2Bucket: "mania-hub-replay-cache",
    });
    const publicRes = mockRes();
    const adminRes = mockRes();

    await routeHttp(mockReq("POST", "/api/replay-video-job?action=status&id=missing"), publicRes.res, {
      db,
      queue,
      events,
      config,
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);
    await routeHttp(mockReq("POST", "/api/replay-video-job?action=status&id=missing", { authorization: "Bearer secret" }), adminRes.res, {
      db,
      queue,
      events,
      config,
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);

    expect(publicRes.res.statusCode).toBe(401);
    expect(adminRes.res.statusCode).toBe(404);
  });

  it("rejects replay video uploads before buffering oversized bodies", async () => {
    const config = baseConfig({
      replayVideoPublicEnabled: true,
      replayVideoUploadMaxBytes: 4,
      r2Endpoint: "https://r2.example",
      r2AccessKeyId: "key",
      r2SecretAccessKey: "secret",
      r2Bucket: "mania-hub-replay-cache",
    });
    const { res, writes } = mockRes();

    await routeHttp(mockReq("POST", "/api/replay-video-job?action=upload-video&id=test", {
      "content-length": "5",
      "x-real-ip": "203.0.113.30",
    }), res, {
      config,
      abuse: new AbuseGuard(),
    } as never);

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(writes.join(""))).toMatchObject({ error: "payload_too_large" });
  });

  it("caps concurrent SSE connections per IP and releases them on close", async () => {
    const { db, queue, events } = await setup();
    const abuse = new AbuseGuard();
    const config = baseConfig({ sseMaxConnectionsPerIp: 1, sseMaxConnectionsTotal: 10 });
    const firstReq = mockReq("GET", "/api/live?country=CR", { "x-real-ip": "203.0.113.40" });
    const thirdReq = mockReq("GET", "/api/live?country=CR", { "x-real-ip": "203.0.113.40" });
    const first = mockRes();
    const second = mockRes();
    const third = mockRes();
    const ctx = {
      db,
      queue,
      events,
      config,
      abuse,
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never;

    await handleSse(firstReq, first.res, ctx);
    await handleSse(mockReq("GET", "/api/live?country=CR", { "x-real-ip": "203.0.113.40" }), second.res, ctx);
    firstReq.emit("close");
    await handleSse(thirdReq, third.res, ctx);

    expect(first.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "content-type": "text/event-stream; charset=utf-8" }));
    expect(second.res.statusCode).toBe(429);
    expect(JSON.parse(second.writes.join(""))).toMatchObject({ error: "rate_limited", bucket: "sseConnect" });
    expect(third.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "content-type": "text/event-stream; charset=utf-8" }));
    thirdReq.emit("close");
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
