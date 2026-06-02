import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { getSnipesSnapshot } from "../src/features/snipes.js";
import { deferMapsRefreshesWaitingForRoster, enqueueMapsRefreshIfDue, getMapsPageSnapshot, getMapsPlayersSnapshot, getMapsRandomBeatmapsets, getMapsSnapshot, recordMapsFarmedScore, refreshCountryMaps, refreshGlobalMaps, refreshUserMapsFarmedScores } from "../src/features/maps.js";
import { getCachedPlayerProfileSnapshot, getPlayerAbout, getPlayerProfileSnapshot, getPlayerRecentScores } from "../src/features/player-profiles.js";
import { getRankDeltaSnapshot } from "../src/features/rank-snapshots.js";
import { confirmTopPlay, getTopPlaysSnapshot, TopPlayConfirmationPendingError } from "../src/features/top-plays.js";
import { getTrackerSnapshot } from "../src/features/tracker.js";
import { getGlobalRankingsSnapshot } from "../src/features/global-rankings.js";
import { routeHttp, sendJson } from "../src/http/snapshots.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { handleSse } from "../src/live/sse.js";
import { cancelOscCountryCatchup, enqueueOscCountryCatchup, OscBackfill } from "../src/osc/backfill.js";
import { runScoresFallbackPage, shouldRunScoresFallback } from "../src/osc/scores-fallback.js";
import { refreshCountryRoster } from "../src/rosters/country-rosters.js";
import { activateCountry, canSeedSnipesForCountry, deleteCountryData, getActiveCountryCodes, getIndexedCountryCodes, getMapsWarmCountryCodes, setCountryFeatureTier, setCountryPaused, setCountryStatus, touchCountryRequest } from "../src/countries.js";
import { CountryClientTracker } from "../src/live/country-clients.js";
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
    getHeader: vi.fn((key: string) => headers[key.toLowerCase()]),
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
  vi.useRealTimers();
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

  it("keeps paused countries out of ingestion even when they are pinned", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");

    await setCountryPaused(db, { trackedCountries: ["CR"], countryWarmTtlMs: 24 * 60 * 60 * 1000 }, "CR", true);

    expect(await getActiveCountryCodes(db, { trackedCountries: ["CR"], countryWarmTtlMs: 24 * 60 * 60 * 1000 })).toEqual([]);
    expect(await ingestor.ingestBatch([scores[0]])).toEqual({ inserted: 0, skipped: 1 });

    await setCountryPaused(db, { trackedCountries: ["CR"], countryWarmTtlMs: 24 * 60 * 60 * 1000 }, "CR", false);

    expect(await getActiveCountryCodes(db, { trackedCountries: ["CR"], countryWarmTtlMs: 24 * 60 * 60 * 1000 })).toEqual(["CR"]);
    expect(await ingestor.ingestBatch([scores[0]])).toEqual({ inserted: 1, skipped: 0 });
    expect(Number((await exec(db, "select count(*) as count from score_events")).rows[0].count)).toBe(1);
  });

  it("keeps manually active configured countries active after registry reseeding", async () => {
    const { db } = await setup(["CR"]);
    const config = { trackedCountries: ["CR"], countryWarmTtlMs: 24 * 60 * 60 * 1000 };

    await setCountryStatus(db, config, "CR", "active");

    expect(await getActiveCountryCodes(db, config)).toEqual(["CR"]);
    expect(String((await exec(db, "select status from country_registry where country = 'CR'")).rows[0].status)).toBe("active");

    await setCountryStatus(db, config, "CR", "warm");
    await activateCountry(db, new JobQueue(db), { ...config, rosterRefreshIntervalMs: 24 * 60 * 60 * 1000 }, "CR");

    expect(String((await exec(db, "select status from country_registry where country = 'CR'")).rows[0].status)).toBe("warm");
  });

  it("keeps manually warm countries warm after the passive request TTL", async () => {
    const { db, queue } = await setup(["CR"]);
    const config = {
      trackedCountries: ["CR"],
      countryWarmTtlMs: 60 * 60 * 1000,
      rosterRefreshIntervalMs: 24 * 60 * 60 * 1000,
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));

    await activateCountry(db, queue, config, "MX");
    await setCountryStatus(db, config, "MX", "warm");
    vi.setSystemTime(new Date("2026-05-30T02:00:00.000Z"));

    expect(await getActiveCountryCodes(db, config)).toEqual(expect.arrayContaining(["MX"]));
    const row = (await exec(db, "select status, keep_warm from country_registry where country = 'MX'")).rows[0];
    expect(String(row.status)).toBe("warm");
    expect(Number(row.keep_warm)).toBe(1);
  });

  it("lets passively warmed countries expire by TTL", async () => {
    const { db } = await setup(["CR"]);
    const config = { trackedCountries: ["CR"], countryWarmTtlMs: 60 * 60 * 1000 };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));

    await touchCountryRequest(db, "MX");
    expect(await getIndexedCountryCodes(db, config)).toEqual(expect.arrayContaining(["MX"]));
    vi.setSystemTime(new Date("2026-05-30T02:00:00.000Z"));

    expect(await getIndexedCountryCodes(db, config)).not.toContain("MX");
    expect(Number((await exec(db, "select keep_warm from country_registry where country = 'MX'")).rows[0].keep_warm)).toBe(0);
  });

  it("keeps prewarmed countries below live and snipes until they are requested", async () => {
    const { db, queue } = await setup(["CR"]);
    const config = {
      trackedCountries: ["CR"],
      prewarmCountries: ["MX"],
      mapsWarmCountries: ["BR"],
      countryWarmTtlMs: 24 * 60 * 60 * 1000,
      rosterRefreshIntervalMs: 24 * 60 * 60 * 1000,
    };

    expect(await getIndexedCountryCodes(db, config)).toEqual(expect.arrayContaining(["CR", "MX", "BR"]));
    expect(await getMapsWarmCountryCodes(db, config)).toEqual(expect.arrayContaining(["CR", "BR"]));
    expect(await getActiveCountryCodes(db, config)).toEqual(["CR"]);
    expect(await canSeedSnipesForCountry(db, config, "MX")).toBe(false);

    const activated = await activateCountry(db, queue, config, "MX");

    expect(activated.featureTier).toBe("live");
    expect(await getActiveCountryCodes(db, config)).toEqual(expect.arrayContaining(["CR", "MX"]));
    expect(await canSeedSnipesForCountry(db, config, "MX")).toBe(false);
  });

  it("lets admins promote and demote a country from the snipes tier", async () => {
    const { db, queue } = await setup(["CR"]);
    const config = {
      trackedCountries: ["CR"],
      prewarmCountries: ["MX"],
      mapsWarmCountries: [],
      countryWarmTtlMs: 24 * 60 * 60 * 1000,
      rosterRefreshIntervalMs: 24 * 60 * 60 * 1000,
    };

    await activateCountry(db, queue, config, "MX");
    expect(await canSeedSnipesForCountry(db, config, "MX")).toBe(false);

    const promoted = await setCountryFeatureTier(db, config, "MX", "snipes");
    expect(promoted).toMatchObject({ country: "MX", featureTier: "snipes", pinned: true });
    expect(await canSeedSnipesForCountry(db, config, "MX")).toBe(true);

    const demoted = await setCountryFeatureTier(db, config, "MX", "live");
    expect(demoted).toMatchObject({ country: "MX", featureTier: "live", pinned: false });
    expect(await canSeedSnipesForCountry(db, config, "MX")).toBe(false);

    const demotedPinned = await setCountryFeatureTier(db, config, "CR", "live");
    expect(demotedPinned).toMatchObject({ country: "CR", featureTier: "live", pinned: true });
    expect(await canSeedSnipesForCountry(db, config, "CR")).toBe(false);
    expect((await activateCountry(db, queue, config, "CR")).featureTier).toBe("live");
  });

  it("deletes one country's registry and country-scoped projections", async () => {
    const { db, queue, events, ingestor } = await setup(["CR", "US"]);
    const scores = await fixture<OscScore[]>("scores.json");

    await ingestor.ingestBatch([scores[0]]);
    await exec(db, "insert or ignore into country_registry (country, status, pinned, first_requested_at, last_requested_at, updated_at) values ('US', 'active', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    await exec(db, "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('US', 202, 1, 'test', 1, '2026-01-01T00:00:00.000Z')");
    await exec(db, "insert into country_rank_snapshots (country, user_id, country_rank, global_rank, pp, captured_at) values ('CR', 101, 1, 10, 1000, '2026-01-01T00:00:00.000Z')");
    await exec(db, "insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at) values ('CR', 501, '4K:NM', 101, 9001, 999999, 100, 0.99, 'S', '[]', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    await exec(db, "insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at) values ('CR', 9001, 101, 100, 95, 20, '{}', '2026-01-01T00:00:00.000Z')");
    await exec(db, "insert into snipe_events (country, beatmap_id, lane_key, score_id, sniper_id, victim_id, board_rank, payload_json, detected_at) values ('CR', 501, '4K:NM', 9001, 101, 202, 1, '{}', '2026-01-01T00:00:00.000Z')");
    await exec(db, "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values ('CR', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    await events.append("status", "CR", { ok: true }, "delete-test:CR");
    await queue.enqueue("refresh_country_roster", "roster:CR", { country: "CR" });

    const deleted = await deleteCountryData(db, "CR");

    expect(deleted.country_registry).toBe(1);
    for (const table of ["country_registry", "country_rosters", "country_rank_snapshots", "score_events", "country_beatmap_scores", "top_play_events", "snipe_events", "country_maps_snapshots", "country_maps_farmed_scores", "live_event_log"]) {
      expect(Number((await exec(db, `select count(*) as count from ${table} where country = 'CR'`)).rows[0].count)).toBe(0);
    }
    expect(Number((await exec(db, "select count(*) as count from country_rosters where country = 'US'")).rows[0].count)).toBe(1);
    expect(Number((await exec(db, "select count(*) as count from jobs where dedupe_key = 'roster:CR'")).rows[0].count)).toBe(0);
  });

  it("reports connected page users on country registry status rows", async () => {
    const { db, queue, events } = await setup();
    const countryClients = new CountryClientTracker();
    const release = countryClients.open("CR");
    const first = mockRes();

    await routeHttp(mockReq("GET", "/api/status"), first.res, {
      db,
      queue,
      events,
      config: baseConfig({
        databaseUrl: `file:${join(dir, "test.db")}`,
        maxLocalDbBytes: 1024 * 1024,
        targetLocalDbBytes: 512 * 1024,
      }),
      countryClients,
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0, byCaller: [], byPath: [] }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);

    const cr = (JSON.parse(first.writes.join("")).countries as Array<{ country: string; activeUsers: number; lastActiveAt: string | null }>)
      .find((entry) => entry.country === "CR");
    expect(cr).toMatchObject({ country: "CR", activeUsers: 1 });
    expect(cr?.lastActiveAt).toEqual(expect.any(String));

    release();
    const second = mockRes();
    await routeHttp(mockReq("GET", "/api/status"), second.res, {
      db,
      queue,
      events,
      config: baseConfig({
        databaseUrl: `file:${join(dir, "test.db")}`,
        maxLocalDbBytes: 1024 * 1024,
        targetLocalDbBytes: 512 * 1024,
      }),
      countryClients,
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0, byCaller: [], byPath: [] }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);
    const inactiveCr = (JSON.parse(second.writes.join("")).countries as Array<{ country: string; activeUsers: number; lastActiveAt: string | null }>)
      .find((entry) => entry.country === "CR");
    expect(inactiveCr).toMatchObject({ country: "CR", activeUsers: 0 });
    expect(inactiveCr?.lastActiveAt).toEqual(expect.any(String));
  });

  it("returns public country feature tiers without the full status payload", async () => {
    const { db, queue, events } = await setup(["CR"]);
    const response = mockRes();

    await routeHttp(mockReq("GET", "/api/countries/features"), response.res, {
      db,
      queue,
      events,
      config: baseConfig({
        trackedCountries: ["CR"],
        prewarmCountries: ["MX"],
        mapsWarmCountries: ["BR"],
      }),
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0, byCaller: [], byPath: [] }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);

    const body = JSON.parse(response.writes.join(""));
    expect(response.res.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=30");
    expect(body.countries).toEqual(expect.arrayContaining([
      { country: "CR", featureTier: "snipes" },
      { country: "MX", featureTier: "indexed" },
      { country: "BR", featureTier: "maps_warm" },
    ]));
    expect(body.queueDepth).toBeUndefined();
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

  it("omits historical completed job errors from queue summaries", async () => {
    const { db, queue } = await setup();
    await queue.enqueue("refresh_user_top_scores", "top:done", { userId: 101, scoreId: 9001, country: "CR" });
    const doneJob = (await queue.claim("test-worker"))[0];
    await queue.fail(doneJob.id, new Error("old completed failure"), 1);
    await exec(db, "update jobs set status = 'done', locked_by = null, locked_until = null where id = ?", [doneJob.id]);

    await queue.enqueue("refresh_user_top_scores", "top:failed", { userId: 102, scoreId: 9002, country: "CR" });
    const failedJob = (await queue.claim("test-worker"))[0];
    await queue.fail(failedJob.id, new Error("current failure"), 1);

    const summary = await queue.summary();
    const doneRow = summary.find((row) => row.status === "done" && row.type === "refresh_user_top_scores");
    const failedRow = summary.find((row) => row.status === "failed" && row.type === "refresh_user_top_scores");

    expect(doneRow?.newestError).toBeNull();
    expect(failedRow?.newestError).toBe("current failure");
  });

  it("parks sheddable jobs when queue pressure is high", async () => {
    const { db, queue } = await setup();
    for (let index = 0; index < 80; index += 1) {
      await queue.enqueue("refresh_user_top_scores", `top:pressure:${index}`, { userId: index + 1, scoreId: 10_000 + index, country: "CR" });
    }

    await queue.enqueue("refresh_user_maps_farmed_scores", "maps-farmed:CR:101", { country: "CR", userId: 101 });

    const parked = (await exec(db, "select status from jobs where type = 'refresh_user_maps_farmed_scores'")).rows[0];
    expect(parked.status).toBe("deferred_pressure");
    expect(await queue.depth()).toBe(80);
  });

  it("parks queued low-priority work when critical jobs arrive above target depth", async () => {
    const { db, queue } = await setup();
    const now = new Date().toISOString();
    for (let index = 0; index < 120; index += 1) {
      await exec(
        db,
        `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at)
         values ('refresh_user_maps_farmed_scores', ?, 'queued', 35, ?, 0, '{}', ?, ?)`,
        [`maps-farmed:CR:${index}`, now, now, now],
      );
    }

    await queue.enqueue("enrich_user", "user:101", { userId: 101 }, { priority: 100 });

    expect(await queue.depth()).toBe(100);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'enrich_user'")).rows[0].count)).toBe(1);
    expect(Number((await exec(db, "select count(*) as count from jobs where status = 'deferred_pressure'")).rows[0].count)).toBe(21);
  });

  it("parks excess noisy top-play and recent-reconcile backlogs during emergency pressure", async () => {
    const { db, queue } = await setup();
    const now = new Date().toISOString();
    for (let index = 0; index < 120; index += 1) {
      await exec(
        db,
        `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at)
         values ('refresh_user_top_scores', ?, 'queued', 50, ?, 0, '{}', ?, ?)`,
        [`top:pressure:${index}`, now, now, now],
      );
    }
    for (let index = 0; index < 30; index += 1) {
      await exec(
        db,
        `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at)
         values ('reconcile_user_recent_scores', ?, 'queued', 70, ?, 0, '{}', ?, ?)`,
        [`recent:user:${index}`, now, now, now],
      );
    }

    await queue.shedPressure();

    expect(await queue.depth()).toBe(90);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_user_top_scores' and status in ('queued', 'failed', 'running')")).rows[0].count)).toBe(80);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'reconcile_user_recent_scores' and status in ('queued', 'failed', 'running')")).rows[0].count)).toBe(10);
    expect(Number((await exec(db, "select count(*) as count from jobs where status = 'deferred_pressure'")).rows[0].count)).toBe(60);
  });

  it("reactivates parked pressure jobs when active queue is calm", async () => {
    const { db, queue } = await setup();
    const now = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) {
      await exec(
        db,
        `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at)
         values ('refresh_user_maps_farmed_scores', ?, 'deferred_pressure', 35, ?, 0, '{}', ?, ?)`,
        [`maps-farmed:CR:${index}`, now, now, now],
      );
    }

    await queue.shedPressure();

    expect(await queue.depth()).toBe(5);
    expect(Number((await exec(db, "select count(*) as count from jobs where status = 'deferred_pressure'")).rows[0].count)).toBe(0);
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
      {
        pp: 1234,
        global_rank: 1000,
        country_rank: 1,
        hit_accuracy: 98.76,
        play_count: 42,
        ranked_score: 987654321,
        grade_counts: { ss: 2, ssh: 1, s: 8, sh: 3, a: 13 },
        user: { id: 222, username: "Still In", avatar_url: "https://assets.example/222.png", country_code: "CR" },
      },
      {
        pp: 1200,
        global_rank: 1100,
        country_rank: 2,
        hit_accuracy: 97.5,
        play_count: 24,
        ranked_score: 123456789,
        grade_counts: { ss: 0, ssh: 0, s: 5, sh: 2, a: 9 },
        user: { id: 333, username: "New In", avatar_url: "https://assets.example/333.png", country_code: "CR" },
      },
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

    const users = (await exec(
      db,
      "select user_id, pp, global_rank, country_rank from users order by user_id",
    )).rows;
    expect(users.map((row) => `${row.user_id}:${row.pp}:${row.global_rank}:${row.country_rank}`)).toEqual([
      "222:1234:1000:1",
      "333:1200:1100:2",
    ]);

    const cached = await getCachedPlayerProfileSnapshot(db, "Still In");
    expect(cached?.user.statistics).toMatchObject({
      pp: 1234,
      global_rank: 1000,
      country_rank: 1,
      hit_accuracy: 98.76,
      play_count: 42,
      ranked_score: 987654321,
      grade_counts: { ss: 2, ssh: 1, s: 8, sh: 3, a: 13 },
    });

    const snapshots = (await exec(
      db,
      "select user_id, country_rank, global_rank, pp from country_rank_snapshots where country = 'CR' order by user_id",
    )).rows;
    expect(snapshots.map((row) => `${row.user_id}:${row.country_rank}:${row.global_rank}:${row.pp}`)).toEqual([
      "222:1:1000:1234",
      "333:2:1100:1200",
    ]);
  });

  it("computes country rank deltas from the current roster projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T12:00:00.000Z"));
    const { db } = await setup();

    await exec(
      db,
      `insert into country_rank_snapshots (country, user_id, country_rank, global_rank, pp, captured_at)
       values ('CR', 101, 3, 100, 1000, '2026-05-10T12:00:00.000Z')`,
    );
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values ('CR', 101, 1, 'osu_rankings', 1, '2026-05-17T12:00:00.000Z')`,
    );
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, is_active, pp, global_rank, country_rank, profile_json, updated_at)
       values (101, 'Player', 'https://assets.example/101.png', 'CR', 1, 1100, 90, null, '{}', '2026-05-17T12:00:00.000Z')`,
    );

    const snapshot = await getRankDeltaSnapshot(db, "CR", [101]);

    expect(snapshot.deltas[101]).toMatchObject({
      globalChange: 10,
      countryChange: 2,
      oldGlobalRank: 100,
      oldCountryRank: 3,
      capturedAt: "2026-05-10T12:00:00.000Z",
    });
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

  it("only runs the direct osu scores fallback when oSC intake is stale", () => {
    const now = new Date("2026-05-30T12:00:00.000Z").getTime();
    const staleMs = 90_000;

    expect(shouldRunScoresFallback({
      connected: true,
      lastBatchAt: "2026-05-30T11:58:45.000Z",
      lastError: null,
      stale: false,
    }, staleMs, now)).toBe(false);
    expect(shouldRunScoresFallback({
      connected: true,
      lastBatchAt: "2026-05-30T11:58:29.000Z",
      lastError: null,
      stale: false,
    }, staleMs, now)).toBe(true);
    expect(shouldRunScoresFallback({
      connected: true,
      lastBatchAt: "2026-05-30T11:59:00.000Z",
      lastError: null,
      stale: true,
    }, staleMs, now)).toBe(true);
  });

  it("ingests the global mania osu scores fallback and stores its cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const { db, ingestor } = await setup(["CR"]);
    const scores = await fixture<OscScore[]>("scores.json");
    const now = Date.now();
    const config = {
      oscSocketStaleMs: 10 * 60_000,
      enableOsuScoresFallback: true,
      osuScoresFallbackIntervalMs: 5_000,
      trackedCountries: ["CR"],
      prewarmCountries: [],
      mapsWarmCountries: [],
      countryWarmTtlMs: 24 * 60 * 60 * 1000,
    };
    await exec(
      db,
      "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', 202, 2, 'test', 1, ?)",
      [new Date(now).toISOString()],
    );
    const osu = {
      getScores: vi.fn(async (ruleset: string, cursorString: string | null, caller: string) => {
        expect(ruleset).toBe("mania");
        expect(cursorString).toBeNull();
        expect(caller).toBe("osu_scores_fallback");
        return { scores, cursor_string: "cursor:next" };
      }),
    };

    const result = await runScoresFallbackPage(db, config, osu, ingestor, {
      now,
      oscStatus: {
        connected: true,
        lastBatchAt: "2026-05-30T11:00:00.000Z",
        lastError: null,
        stale: true,
      },
    });

    expect(result).toMatchObject({ ran: true, fetched: 2, candidates: 2, inserted: 2, skipped: 0, nextCursorString: "cursor:next" });
    expect(JSON.parse(String((await exec(db, "select value_json from live_meta where key = 'osu_scores_fallback_cursor_string'")).rows[0].value_json))).toBe("cursor:next");
    expect(JSON.parse(String((await exec(db, "select value_json from live_meta where key = 'osu_scores_fallback_candidate_seen_until_ms'")).rows[0].value_json))).toBe(new Date("2026-05-12T00:03:00.000Z").getTime());
    expect(Number((await exec(db, "select count(*) as count from score_events where source = 'osu_scores_fallback'")).rows[0].count)).toBe(2);
  });

  it("fans osu scores fallback rows into per-user recent polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const { db, ingestor } = await setup(["CR"]);
    const [baseScore] = await fixture<OscScore[]>("scores.json");
    const score = {
      ...baseScore,
      created_at: "2026-05-30T11:59:00.000Z",
      ended_at: "2026-05-30T11:59:00.000Z",
    };
    const config = {
      oscSocketStaleMs: 10 * 60_000,
      enableOsuScoresFallback: true,
      osuScoresFallbackIntervalMs: 10_000,
      trackedCountries: ["CR"],
      prewarmCountries: [],
      mapsWarmCountries: [],
      countryWarmTtlMs: 24 * 60 * 60 * 1000,
    };
    const osu = {
      getScores: vi.fn(async () => ({ scores: [score], cursor_string: "cursor:fresh" })),
    };

    const result = await runScoresFallbackPage(db, config, osu, ingestor, {
      now: Date.now(),
      oscStatus: {
        connected: true,
        lastBatchAt: "2026-05-30T11:00:00.000Z",
        lastError: null,
        stale: true,
      },
    });

    expect(result).toMatchObject({ ran: true, fetched: 1, candidates: 1, inserted: 1 });
    const rows = (await exec(db, "select dedupe_key from jobs where type = 'reconcile_user_recent_scores'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe("recent:user:101");
  });

  it("fans osu scores fallback rows into leaderboard feature jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const { db, ingestor } = await setup(["CR"]);
    const [score] = await fixture<OscScore[]>("scores.json");
    const config = {
      oscSocketStaleMs: 10 * 60_000,
      enableOsuScoresFallback: true,
      osuScoresFallbackIntervalMs: 10_000,
      trackedCountries: ["CR"],
      prewarmCountries: [],
      mapsWarmCountries: [],
      countryWarmTtlMs: 24 * 60 * 60 * 1000,
    };
    const osu = {
      getScores: vi.fn(async () => ({ scores: [score], cursor_string: "cursor:fresh" })),
    };

    const result = await runScoresFallbackPage(db, config, osu, ingestor, {
      now: Date.now(),
      oscStatus: {
        connected: true,
        lastBatchAt: "2026-05-30T11:00:00.000Z",
        lastError: null,
        stale: true,
      },
    });

    expect(result).toMatchObject({ ran: true, fetched: 1, candidates: 1, inserted: 1 });
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_user_top_scores'")).rows[0].count)).toBe(1);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'refresh_user_maps_farmed_scores'")).rows[0].count)).toBe(1);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'seed_snipe_board'")).rows[0].count)).toBe(1);
    expect(Number((await exec(db, "select count(*) as count from jobs where type = 'reconcile_user_recent_scores'")).rows[0].count)).toBe(0);
  });

  it("dedupes maps-farmed refresh jobs per country user", async () => {
    const { db, ingestor } = await setup(["CR"]);
    const [baseScore] = await fixture<OscScore[]>("scores.json");
    const secondScore: OscScore = {
      ...baseScore,
      id: 9003,
      beatmap_id: 503,
      beatmap: {
        ...baseScore.beatmap!,
        id: 503,
        beatmapset_id: 53,
      },
      beatmapset: {
        ...baseScore.beatmapset!,
        id: 53,
      },
    };

    await ingestor.ingestBatch([baseScore, secondScore], "osc_socket", { enqueueRecentReconcile: false });

    const rows = (await exec(db, "select dedupe_key, payload_json from jobs where type = 'refresh_user_maps_farmed_scores'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe("maps-farmed:CR:101");
    expect(JSON.parse(String(rows[0].payload_json)).scoreId).toBe("9003");
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

  it("does not keep recent polling alive from osu recent rows alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
    const { db, queue, events, ingestor } = await setup(["CR"]);
    const [recentScore] = await fixture<OscScore[]>("scores.json");
    await queue.enqueue("reconcile_user_recent_scores", "recent:user:101", { userId: 101 }, { priority: 100 });
    const osu = { getUserRecentScores: vi.fn(async () => [{ ...recentScore, ended_at: "2026-05-12T00:04:00.000Z", created_at: "2026-05-12T00:04:00.000Z" }]) };
    const worker = new WorkerRunner(db, queue, events, osu as never, ingestor, "test-worker");

    await worker.runOnce();

    expect(Number((await exec(db, "select count(*) as count from jobs where dedupe_key like 'recent:user:101:next:%'")).rows[0].count)).toBe(0);
  });

  it("keeps recent polling alive while raw oSC rows are active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
    const { db, queue, events, ingestor } = await setup(["CR"]);
    const [score] = await fixture<OscScore[]>("scores.json");
    await exec(
      db,
      `insert into score_events
       (score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (?, ?, null, ?, 'CR', ?, 3, ?, ?, ?, ?, ?, 1, 0, 0, 0, ?, ?, 'osc_socket')`,
      [score.id, "official:9001", score.user_id, score.beatmap_id ?? score.beatmap?.id ?? 501, JSON.stringify(score), score.pp, score.total_score ?? score.score, score.accuracy, score.rank, "2026-05-12T00:04:00.000Z", new Date().toISOString()],
    );
    await queue.enqueue("reconcile_user_recent_scores", "recent:user:101", { userId: 101 }, { priority: 100 });
    const osu = { getUserRecentScores: vi.fn(async () => []) };
    const worker = new WorkerRunner(db, queue, events, osu as never, ingestor, "test-worker");

    await worker.runOnce();

    expect(Number((await exec(db, "select count(*) as count from jobs where dedupe_key like 'recent:user:101:next:%'")).rows[0].count)).toBe(1);
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
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

  it("starts oSC backfill from the fallback-covered score time when fallback handled the gap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const { db, queue } = await setup();
    const oldBackfillCursor = new Date("2026-05-30T02:00:00.000Z").getTime();
    const fallbackCoveredUntil = new Date("2026-05-30T11:55:00.000Z").getTime();
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osc_backfill_cursor_ms', ?, ?)", [
      JSON.stringify(oldBackfillCursor),
      "2026-05-30T02:00:00.000Z",
    ]);
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osu_scores_fallback_candidate_seen_until_ms', ?, ?)", [
      JSON.stringify(fallbackCoveredUntil),
      "2026-05-30T11:55:00.000Z",
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
    expect(JSON.parse(String(row.payload_json))).toMatchObject({ after: fallbackCoveredUntil, freshStart: true });
  });

  it("re-resolves queued startup oSC backfill jobs against fallback progress when they run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const { db, queue, ingestor } = await setup();
    const queuedBeforeFallback = new Date("2026-05-30T02:00:00.000Z").getTime();
    const fallbackCoveredUntil = new Date("2026-05-30T11:55:00.000Z").getTime();
    let requestedAfter = "";
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osu_scores_fallback_candidate_seen_until_ms', ?, ?)", [
      JSON.stringify(fallbackCoveredUntil),
      "2026-05-30T11:55:00.000Z",
    ]);
    const fetchMock = vi.fn(async (url: URL) => {
      requestedAfter = url.searchParams.get("after") ?? "";
      return new Response(JSON.stringify({ scores: [], meta: { has_more: false } }), { status: 200 });
    });
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 2,
    }, fetchMock as never);

    await backfill.runPage(db, queue, ingestor, { after: queuedBeforeFallback, pagesRemaining: 1, freshStart: true });

    expect(Number(requestedAfter)).toBe(fallbackCoveredUntil);
  });

  it("bounds stale oSC backfill payloads to the configured max age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const { db, queue, ingestor } = await setup();
    let requestedAfter = "";
    const fetchMock = vi.fn(async (url: URL) => {
      requestedAfter = url.searchParams.get("after") ?? "";
      return new Response(JSON.stringify({ scores: [], meta: { has_more: false } }), { status: 200 });
    });
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 2,
    }, fetchMock as never);

    await backfill.runPage(db, queue, ingestor, { after: new Date("2026-05-27T12:00:00.000Z").getTime(), pagesRemaining: 1 });

    expect(Number(requestedAfter)).toBe(new Date("2026-05-30T11:00:00.000Z").getTime());
  });

  it("stores a contiguous oSC backfill cursor after each page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
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

  it("queues country catch-up from that country's last stored score", async () => {
    const { db, queue, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);

    const queued = await enqueueOscCountryCatchup(queue, db, {
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillMaxPages: 200,
    } as never, "cr");

    expect(queued).toEqual({
      country: "CR",
      after: new Date("2026-05-12T00:02:00.000Z").getTime() - 5 * 60_000,
    });
    const row = (await exec(db, "select type, payload_json from jobs where dedupe_key = ?", [`osc-country-catchup:CR:${queued.after}`])).rows[0];
    expect(row.type).toBe("osc_country_catchup");
    expect(JSON.parse(String(row.payload_json))).toMatchObject({ country: "CR", after: queued.after, pagesRemaining: 200 });
  });

  it("cancels a country catch-up chain and stops an in-flight page from re-enqueuing", async () => {
    const { db, queue, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const config = { oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000, oscBackfillMaxPages: 200 } as never;

    const queued = await enqueueOscCountryCatchup(queue, db, config, "cr");
    const payload = JSON.parse(
      String((await exec(db, "select payload_json from jobs where dedupe_key = ?", [`osc-country-catchup:CR:${queued.after}`])).rows[0].payload_json),
    ) as { epoch: number; after: number; pagesRemaining: number };

    const cancelled = await cancelOscCountryCatchup(db, "cr");
    expect(cancelled).toMatchObject({ country: "CR", cancelled: 1 });
    expect((await exec(db, "select id from jobs where type = 'osc_country_catchup'")).rows).toHaveLength(0);

    // A page still holding the pre-cancel epoch must no-op and not re-enqueue.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scores }), { status: 200 }));
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 200,
    }, fetchMock as never);
    const result = await backfill.runPage(db, queue, ingestor, { country: "CR", after: payload.after, pagesRemaining: 200, epoch: payload.epoch });
    expect(result).toMatchObject({ fetched: 0, inserted: 0, hasMore: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await exec(db, "select id from jobs where type = 'osc_country_catchup'")).rows).toHaveLength(0);
  });

  it("runs country catch-up without inserting other active countries or rewinding the global cursor", async () => {
    const { db, queue, ingestor } = await setup(["CR", "US"]);
    const scores = await fixture<OscScore[]>("scores.json");
    const existingCursor = new Date("2026-05-13T00:00:00.000Z").getTime();
    await exec(db, "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('US', 101, 1, 'test', 1, ?)", [new Date().toISOString()]);
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osc_backfill_cursor_ms', ?, ?)", [
      JSON.stringify(existingCursor),
      new Date().toISOString(),
    ]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scores: [scores[0]], meta: { newest: "2026-05-12T00:02:00.000Z", has_more: false } }), { status: 200 }));
    const backfill = new OscBackfill({
      oscBaseUrl: "https://osc.example",
      oscJsonTargetPerMinute: 60,
      oscBackfillMaxAgeMs: 24 * 60 * 60 * 1000,
      oscBackfillPageLimit: 2,
      oscBackfillMaxPages: 2,
    }, fetchMock as never);

    const result = await backfill.runPage(db, queue, ingestor, { country: "CR", after: new Date("2026-05-11T00:00:00.000Z").getTime(), pagesRemaining: 2 });

    expect(result).toMatchObject({ country: "CR", fetched: 1, inserted: 1 });
    expect(Number((await exec(db, "select count(*) as count from score_events where country = 'CR'")).rows[0].count)).toBe(1);
    expect(Number((await exec(db, "select count(*) as count from score_events where country = 'US'")).rows[0].count)).toBe(0);
    expect(JSON.parse(String((await exec(db, "select value_json from live_meta where key = 'osc_backfill_cursor_ms'")).rows[0].value_json))).toBe(existingCursor);
    expect((await exec(db, "select value_json from live_meta where key = 'osc_country_catchup_last_result:CR'")).rows).toHaveLength(1);
  });

  it("returns tracker snapshots and replayable SSE event rows", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const snapshot = await getTrackerSnapshot(db, "CR", 10);
    expect(snapshot.scores).toHaveLength(1);
    expect(snapshot.scores[0].user.username).toBe("Sniper");
    expect(Object.keys(snapshot.scores[0].beatmapset.covers)).toEqual(["cover"]);
    expect(snapshot.scores[0].replay).toBeUndefined();
    const missed = await events.replay("CR", 0);
    expect(missed.some((event) => event.type === "tracker_score")).toBe(true);
  });

  it("serves admin snapshot counts without downloading snapshot bodies", async () => {
    const { db, queue, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    await exec(
      db,
      `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
       values ('CR', 8001, 101, 100, 95, 20, '{}', ?)`,
      [new Date().toISOString()],
    );
    await exec(
      db,
      `insert into snipe_events (country, beatmap_id, lane_key, score_id, sniper_id, victim_id, board_rank, payload_json, detected_at)
       values ('CR', 1, 'classic:nm', 9001, 101, 102, 1, '{}', ?)`,
      [new Date().toISOString()],
    );

    const response = mockRes();
    await routeHttp(mockReq("GET", "/api/admin/status?country=CR"), response.res, {
      db,
      queue,
      events,
      config: baseConfig({ nodeEnv: "development", databaseUrl: `file:${join(dir, "test.db")}` }),
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);

    const body = JSON.parse(response.writes.join("")) as { snapshotStats?: Record<string, number> };
    expect(response.res.statusCode).toBe(200);
    expect(body.snapshotStats).toMatchObject({
      trackerScores: 1,
      topPlays: 1,
      snipes: 1,
    });
  });

  it("aggregates tracker and top-play snapshots across countries for Global", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    // Clone the CR score into a second country so the Global union has >1 row.
    await exec(
      db,
      `insert into score_events (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       select 9100, 'global-us', user_id, 'US', beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source
       from score_events where country = 'CR' limit 1`,
    );

    expect((await getTrackerSnapshot(db, "CR", 10)).scores).toHaveLength(1);
    expect((await getTrackerSnapshot(db, "GLOBAL", 10)).scores).toHaveLength(2);

    const detectedAt = new Date().toISOString();
    for (const [country, scoreId] of [["CR", 8001], ["US", 8002]] as const) {
      await exec(
        db,
        `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
         values (?, ?, 101, 100, 95, 20, '{}', ?)`,
        [country, scoreId, detectedAt],
      );
    }
    expect((await getTopPlaysSnapshot(db, "CR", "7d")).popoffs).toHaveLength(1);
    expect((await getTopPlaysSnapshot(db, "GLOBAL", "7d")).popoffs).toHaveLength(2);
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
    expect(Number((await exec(db, "select count(*) as count from country_maps_farmed_scores where country = 'CR' and user_id = 101")).rows[0].count)).toBe(1);
    await exec(db, "update users set avatar_url = 'https://assets.example/fresh-top.png' where user_id = 101");
    const snapshot = await getTopPlaysSnapshot(db, "CR", "7d");
    expect(snapshot.popoffs[0].user.avatar_url).toBe("https://assets.example/fresh-top.png");
    expect(snapshot.popoffs[0].score.user?.avatar_url).toBe("https://assets.example/fresh-top.png");
    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).toBe(false);
  });

  it("caches player profile snapshots and serves subsequent visits without osu calls", async () => {
    const { db } = await setup();
    const best = await fixture<OscScore[]>("top-best.json");
    const getUserByKey = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: { pp: 1234, global_rank: 100, country_rank: 1 },
      page: { html: "<b>about</b>", raw: "about" },
    }));
    const getUser = vi.fn(async () => {
      throw new Error("fresh profile users should not refresh within the short user TTL");
    });
    const getUserBestScoresWindow = vi.fn(async () => best);

    const first = await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");
    const second = await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "sniper");

    expect(first.user).toMatchObject({ id: 101, username: "Sniper", page: null });
    expect(first.bestScores).toHaveLength(best.length);
    expect(first.userFetchedAt).toBe(first.fetchedAt);
    expect(second.bestScores[0].id).toBe(first.bestScores[0].id);
    expect(getUserByKey).toHaveBeenCalledTimes(1);
    expect(getUser).not.toHaveBeenCalled();
    expect(getUserBestScoresWindow).toHaveBeenCalledTimes(1);
  });

  it("serves cached player profile snapshots from local storage without an osu client", async () => {
    const { db } = await setup();
    const best = await fixture<OscScore[]>("top-best.json");
    const getUserByKey = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: { pp: 1234, global_rank: 100, country_rank: 1 },
      page: null,
    }));
    const getUser = vi.fn(async () => {
      throw new Error("cached lookup should not refresh users");
    });
    const getUserBestScoresWindow = vi.fn(async () => best);

    await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");
    const cached = await getCachedPlayerProfileSnapshot(db, "sniper");

    expect(cached?.user).toMatchObject({ id: 101, username: "Sniper", page: null });
    expect(cached?.bestScores).toHaveLength(best.length);
    expect(cached?.isStale).toBe(false);
    expect(getUserByKey).toHaveBeenCalledTimes(1);
    expect(getUser).not.toHaveBeenCalled();
    expect(getUserBestScoresWindow).toHaveBeenCalledTimes(1);
  });

  it("builds a cached player shell from the live users table when no profile snapshot exists", async () => {
    const { db } = await setup();
    const updatedAt = new Date().toISOString();
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, is_active, pp, global_rank, country_rank, profile_json, updated_at)
       values (101, 'Sniper', 'https://assets.example/sniper.png', 'CR', 1, 1234, 100, 1, ?, ?)`,
      [JSON.stringify({ id: 101, username: "Sniper", avatar_url: "https://assets.example/sniper.png", country_code: "CR" }), updatedAt],
    );

    const cached = await getCachedPlayerProfileSnapshot(db, "sniper");

    expect(cached?.user).toMatchObject({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: expect.objectContaining({ pp: 1234, global_rank: 100, country_rank: 1 }),
    });
    expect(cached?.bestScores).toEqual([]);
    expect(cached?.isStale).toBe(true);
  });

  it("serves stale profile user stats immediately and refreshes them in the background", async () => {
    const { db } = await setup();
    const best = await fixture<OscScore[]>("top-best.json");
    const getUserByKey = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: { pp: 1000, global_rank: 100, country_rank: 1, play_count: 10 },
      page: null,
    }));
    const getUser = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper-new.png",
      country_code: "CR",
      statistics: { pp: 1100, global_rank: 90, country_rank: 1, play_count: 20 },
      page: { html: "<b>fresh but stripped</b>" },
    }));
    const getUserBestScoresWindow = vi.fn(async () => best);

    await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");
    await exec(db, "update profile_snapshots set user_fetched_at = ? where user_id = 101", [
      new Date(Date.now() - 11 * 60_000).toISOString(),
    ]);

    const snapshot = await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");

    expect(snapshot.user).toMatchObject({
      avatar_url: "https://assets.example/sniper.png",
      page: null,
      statistics: expect.objectContaining({ global_rank: 100, play_count: 10 }),
    });
    expect(getUserByKey).toHaveBeenCalledTimes(1);
    expect(getUserBestScoresWindow).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(getUser).toHaveBeenCalledTimes(1));
    const refreshed = await getCachedPlayerProfileSnapshot(db, "Sniper");
    expect(refreshed?.user).toMatchObject({
      avatar_url: "https://assets.example/sniper-new.png",
      page: null,
      statistics: expect.objectContaining({ global_rank: 90, play_count: 20 }),
    });
    expect(refreshed?.fetchedAt).not.toBe(refreshed?.userFetchedAt);
  });

  it("projects confirmed live top plays into cached player snapshots without same-map duplicates", async () => {
    const { db } = await setup();
    const base = (await fixture<OscScore[]>("top-best.json"))[0];
    const oldSameMap: OscScore = {
      ...base,
      id: 7001,
      pp: 200,
      beatmap_id: base.beatmap_id ?? base.beatmap?.id,
      ended_at: "2026-05-10T00:00:00.000Z",
      created_at: "2026-05-10T00:00:00.000Z",
    };
    const liveTop: OscScore = {
      ...base,
      id: 9001,
      pp: 250,
      ended_at: "2026-05-12T00:00:00.000Z",
      created_at: "2026-05-12T00:00:00.000Z",
    };
    const getUserByKey = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: { pp: 1000, global_rank: 100, country_rank: 1 },
      page: null,
    }));
    const getUser = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: { pp: 1000, global_rank: 100, country_rank: 1 },
      page: null,
    }));
    const getUserBestScoresWindow = vi.fn(async () => [oldSameMap, { ...base, id: 8002, beatmap_id: 999, pp: 150 }]);

    const baseSnapshot = await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");
    const staleTop = { ...base, id: 6601, beatmap_id: 6601, pp: 999 };
    await exec(
      db,
      `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
       values ('CR', ?, 101, ?, ?, 50, ?, ?)`,
      [staleTop.id, staleTop.pp, staleTop.pp, JSON.stringify({ user: { id: 101, username: "Sniper", avatar_url: "https://assets.example/sniper.png" }, score: staleTop, pp: staleTop.pp, weightedPP: staleTop.pp, ppGain: 50, time: staleTop.ended_at }), new Date(Date.parse(baseSnapshot.fetchedAt) - 1000).toISOString()],
    );
    await exec(
      db,
      `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
       values ('CR', ?, 101, ?, ?, 50, ?, ?)`,
      [liveTop.id, liveTop.pp, liveTop.pp, JSON.stringify({ user: { id: 101, username: "Sniper", avatar_url: "https://assets.example/sniper.png" }, score: liveTop, pp: liveTop.pp, weightedPP: liveTop.pp, ppGain: 50, time: liveTop.ended_at }), new Date().toISOString()],
    );

    const snapshot = await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");
    const scoreIds = snapshot.bestScores.map((score) => score.id);

    expect(scoreIds).toContain(9001);
    expect(scoreIds).not.toContain(6601);
    expect(scoreIds).not.toContain(7001);
    expect(snapshot.projection.appliedTopPlayEvents).toBe(1);
    expect(snapshot.projection.provenanceByScoreId[9001]).toBe("live_top_play_event");
    expect(Number((snapshot.user.statistics as { pp?: number }).pp)).toBeGreaterThan(1000);
  });

  it("does not add live top-play projection again after official profile pp refreshes", async () => {
    const { db } = await setup();
    const base = (await fixture<OscScore[]>("top-best.json"))[0];
    const oldSameMap: OscScore = {
      ...base,
      id: 7001,
      pp: 200,
      beatmap_id: base.beatmap_id ?? base.beatmap?.id,
      ended_at: "2026-05-10T00:00:00.000Z",
      created_at: "2026-05-10T00:00:00.000Z",
    };
    const liveTop: OscScore = {
      ...base,
      id: 9001,
      pp: 250,
      ended_at: "2026-05-12T00:00:00.000Z",
      created_at: "2026-05-12T00:00:00.000Z",
    };
    const getUserByKey = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: { pp: 1000, global_rank: 100, country_rank: 1 },
      page: null,
    }));
    const getUser = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      avatar_url: "https://assets.example/sniper.png",
      country_code: "CR",
      statistics: { pp: 1100, global_rank: 90, country_rank: 1 },
      page: null,
    }));
    const getUserBestScoresWindow = vi.fn(async () => [oldSameMap, { ...base, id: 8002, beatmap_id: 999, pp: 150 }]);

    await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");
    const snapshotFetchedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const eventDetectedAt = new Date(Date.parse(snapshotFetchedAt) + 60_000).toISOString();
    await exec(db, "update profile_snapshots set fetched_at = ?, user_fetched_at = ? where user_id = 101", [
      snapshotFetchedAt,
      snapshotFetchedAt,
    ]);
    await exec(
      db,
      `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
       values ('CR', ?, 101, ?, ?, 50, ?, ?)`,
      [liveTop.id, liveTop.pp, liveTop.pp, JSON.stringify({ user: { id: 101, username: "Sniper", avatar_url: "https://assets.example/sniper.png" }, score: liveTop, pp: liveTop.pp, weightedPP: liveTop.pp, ppGain: 50, time: liveTop.ended_at }), eventDetectedAt],
    );

    const firstServed = await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");
    expect(firstServed.bestScores.map((score) => score.id)).toContain(9001);
    expect(firstServed.projection.appliedTopPlayEvents).toBe(1);

    await vi.waitFor(() => expect(getUser).toHaveBeenCalledTimes(1));
    const snapshot = await getPlayerProfileSnapshot(db, { getUser, getUserByKey, getUserBestScoresWindow }, "Sniper");

    expect(snapshot.bestScores.map((score) => score.id)).toContain(9001);
    expect(snapshot.projection.appliedTopPlayEvents).toBe(1);
    expect(snapshot.projection.projectedPp).toBe(1100);
    expect((snapshot.user.statistics as { pp?: number }).pp).toBe(1100);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getUserBestScoresWindow).toHaveBeenCalledTimes(1);
  });

  it("caches lazy player recent and about sections separately from the snapshot", async () => {
    const { db } = await setup();
    const best = await fixture<OscScore[]>("top-best.json");
    const getUserRecentScores = vi.fn(async () => [best[0], { ...best[0], id: 9902 }]);
    const getUser = vi.fn(async () => ({
      id: 101,
      username: "Sniper",
      page: { html: "<script>alert(1)</script><b>hi</b>" },
    }));

    const recent = await getPlayerRecentScores(db, { getUserRecentScores }, 101);
    const recentAgain = await getPlayerRecentScores(db, { getUserRecentScores }, 101);
    const about = await getPlayerAbout(db, { getUser }, 101);
    const aboutAgain = await getPlayerAbout(db, { getUser }, 101);

    expect(recent.payload).toHaveLength(2);
    expect(recentAgain.payload).toHaveLength(2);
    expect(getUserRecentScores).toHaveBeenCalledTimes(1);
    expect(about.payload).toMatchObject({ html: "<b>hi</b>" });
    expect(aboutAgain.payload).toMatchObject({ html: "<b>hi</b>" });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated best-score ids without storing top-score rows", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const best = await fixture<OscScore[]>("top-best.json");
    const osu = {
      getBeatmapUserScoresAll: async (_beatmapId: number, _userId: number, _caller?: string) => [],
      getUserBestScores: async (_userId: number, _caller?: string) => [best[0], { ...best[0] }, { ...best[0], id: 9002, pp: 200 }],
    };

    await expect(confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).resolves.toBe(true);

    const cached = (await exec(db, "select count(*) as count from user_top_scores where user_id = 101")).rows[0];
    expect(Number(cached.count)).toBe(0);
    const user = (await exec(db, "select top_play_min_pp, top_scores_refreshed_at from users where user_id = 101")).rows[0];
    expect(Number(user.top_play_min_pp)).toBe(0);
    expect(String(user.top_scores_refreshed_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("updates the lightweight top-play threshold during confirmation", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const best = await fixture<OscScore[]>("top-best.json");
    const bestScores = Array.from(
      { length: 100 },
      (_, index): OscScore => ({
        ...best[0],
        id: index === 0 ? 9001 : 10_000 + index,
        pp: 300 - index,
      }),
    );
    const osu = {
      getBeatmapUserScoresAll: async (_beatmapId: number, _userId: number, _caller?: string) => [],
      getUserBestScores: async (_userId: number, _caller?: string) => bestScores,
    };

    await expect(confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).resolves.toBe(true);

    const user = (await exec(db, "select top_play_min_pp, top_scores_refreshed_at from users where user_id = 101")).rows[0];
    expect(Number(user.top_play_min_pp)).toBe(201);
    expect(String(user.top_scores_refreshed_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const cached = (await exec(db, "select count(*) as count from user_top_scores where user_id = 101")).rows[0];
    expect(Number(cached.count)).toBe(0);
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

  it("retries fresh top-play confirmations while osu! best scores catch up", async () => {
    const { db, events, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    await ingestor.ingestBatch([scores[0]]);
    const osu = {
      getBeatmapUserScoresAll: async (_beatmapId: number, _userId: number, _caller?: string) => [],
      getUserBestScores: async (_userId: number, _caller?: string) => [],
    };

    await expect(confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" }))
      .rejects.toBeInstanceOf(TopPlayConfirmationPendingError);
    expect(Number((await exec(db, "select count(*) as count from top_play_events")).rows[0].count)).toBe(0);
  });

  it("backs off pending top-play confirmation jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:05:00.000Z"));
    const { db, queue, events, ingestor } = await setup();
    const [score] = await fixture<OscScore[]>("scores.json");
    await exec(
      db,
      `insert into score_events
       (score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (?, ?, null, ?, 'CR', ?, 3, ?, ?, ?, ?, ?, 1, 0, 0, 0, ?, ?, 'osc_socket')`,
      [score.id, "official:9001", score.user_id, score.beatmap_id ?? score.beatmap?.id ?? 501, JSON.stringify(score), score.pp, score.total_score ?? score.score, score.accuracy, score.rank, score.ended_at ?? score.created_at ?? "", new Date().toISOString()],
    );
    await queue.enqueue("refresh_user_top_scores", "top:test:pending", { userId: 101, scoreId: 9001, country: "CR" }, { priority: 100 });
    const osu = {
      getUserBestScoresWindow: vi.fn(async () => []),
    };
    const worker = new WorkerRunner(db, queue, events, osu as never, ingestor, "test-worker");

    await worker.runOnce();

    const row = (await exec(db, "select status, run_after from jobs where dedupe_key = 'top:test:pending'")).rows[0];
    expect(row.status).toBe("failed");
    expect(new Date(String(row.run_after)).getTime() - Date.now()).toBe(2 * 60_000);
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

  it("uses the displaced 101st best score for top-play pp gain", async () => {
    const { db, events } = await setup();
    const baseBest = (await fixture<OscScore[]>("top-best.json"))[0];
    const higherScores = Array.from({ length: 99 }, (_, index) => ({
      ...baseBest,
      id: 8000 + index,
      beatmap_id: 6000 + index,
      pp: 700 - index,
    }));
    const current = { ...baseBest, id: 9001, beatmap_id: 501, pp: 600, ended_at: "2026-05-12T07:06:51.000Z", created_at: "2026-05-12T07:06:51.000Z" };
    const displaced = { ...baseBest, id: 7901, beatmap_id: 7901, pp: 300 };
    const best = [...higherScores, current, displaced];
    const osu = {
      getBeatmapUserScoresAll: vi.fn(async (_beatmapId: number, _userId: number, _caller?: string) => [current]),
      getUserBestScores: vi.fn(async (_userId: number, _caller?: string) => best.slice(0, 100)),
      getUserBestScoresWindow: vi.fn(async (_userId: number, _limit: number, _caller?: string) => best),
    };

    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).toBe(true);

    const row = (await exec(db, "select pp_gain from top_play_events where score_id = ?", [9001])).rows[0];
    expect(Number(row.pp_gain)).toBeCloseTo((600 - 300) * 0.95 ** 99, 6);
    expect(osu.getUserBestScoresWindow).toHaveBeenCalledWith(101, 200, "job:refresh_user_top_scores");
    expect(osu.getUserBestScores).not.toHaveBeenCalled();
  });

  it("stores one snipe event from a durable country board", async () => {
    const { db, ingestor } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const current = { ...scores[0], rank: "A", type: "score_mania" };
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (303, 'Victim', 'https://assets.example/victim.png', 'CR', ?)`,
      [new Date().toISOString()],
    );
    await exec(
      db,
      `insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
       values ('CR', 501, 'normal:stable', 303, 7000, 900000, 200, 0.97, 'S', '[]', 0, 1, '2026-05-11T00:00:00.000Z', ?)`,
      [new Date().toISOString()],
    );
    await ingestor.ingestBatch([current]);
    const snipes = await getSnipesSnapshot(db, "CR", 10);
    expect(snipes.events).toHaveLength(1);
    expect(snipes.events[0].victim.id).toBe(303);
    expect(snipes.events[0].rank).toBe("S");
    await exec(db, "update users set avatar_url = 'https://assets.example/fresh-victim.png' where user_id = 303");
    const refreshedSnipes = await getSnipesSnapshot(db, "CR", 10);
    expect(refreshedSnipes.events[0].victim.avatar_url).toBe("https://assets.example/fresh-victim.png");
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

  it("rejects osu! calls when the limiter queue is full", async () => {
    vi.useFakeTimers();
    const limiter = new TokenBucketLimiter(1, 1, undefined, { maxPendingCalls: 1 });
    const calls: string[] = [];

    const running = limiter.schedule("test", "/running", async () => {
      calls.push("running");
      return true;
    });
    const queued = limiter.schedule("test", "/queued", async () => {
      calls.push("queued");
      return true;
    });

    await expect(limiter.schedule("test", "/rejected", async () => true)).rejects.toThrow("queue is full");
    expect(limiter.state().pending).toBe(1);
    expect(limiter.state().maxPending).toBe(1);

    await vi.advanceTimersByTimeAsync(60_001);
    await Promise.all([running, queued]);
    expect(calls).toEqual(["running", "queued"]);
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

  it("hydrates cached maps snapshot avatars from current user metadata", async () => {
    const { db, queue } = await setup();
    const now = new Date().toISOString();
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (101, 'Fresh Maps User', 'https://assets.example/fresh-maps.png', 'CR', ?)`,
      [now],
    );
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [
        JSON.stringify({
          farmed: [],
          mostPlayed: [],
          favourites: [],
          favouritesByPlayer: [{
            id: 101,
            username: "Old Maps User",
            avatarUrl: "https://assets.example/old-maps.png",
            beatmapsetIds: [1],
          }],
          beatmapsetsPool: {},
          generatedAt: now,
          farmedGeneratedAt: now,
          favouritesGeneratedAt: now,
        }),
        now,
        now,
      ],
    );

    const snapshot = await getMapsSnapshot(db, queue, "CR", 7 * 24 * 60 * 60 * 1000);

    expect(snapshot.value?.favouritesByPlayer[0]).toMatchObject({
      username: "Fresh Maps User",
      avatarUrl: "https://assets.example/fresh-maps.png",
    });
    expect(snapshot.refreshQueued).toBe(false);
  });

  it("merges live farmed overlay scores into maps snapshots", async () => {
    const { db, queue } = await setup();
    const scores = await fixture<OscScore[]>("scores.json");
    const refreshedAt = "2026-05-12T00:01:00.000Z";
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [
        JSON.stringify({
          farmed: [{
            beatmapId: 501,
            version: "Another",
            difficultyRating: 5.6,
            totalLength: 0,
            cs: 4,
            bpm: 180,
            beatmapsetId: 50,
            title: "Fixture Song",
            artist: "Fixture Artist",
            creator: "mapper",
            covers: { cover: "https://assets.example/cover.jpg", card: "https://assets.example/card.jpg" },
            status: "ranked",
            playerCount: 1,
            players: [{
              id: 101,
              username: "Sniper",
              avatarUrl: "https://assets.example/sniper.png",
              mods: [],
              pp: 252.4,
              scoreUrl: "https://osu.ppy.sh/scores/9001",
              playedAt: "2026-05-12T00:02:00.000Z",
            }],
            avgPp: 252.4,
            maxPp: 252.4,
          }],
          mostPlayed: [],
          favourites: [],
          favouritesByPlayer: [],
          beatmapsetsPool: {},
          generatedAt: refreshedAt,
          farmedGeneratedAt: refreshedAt,
          favouritesGeneratedAt: refreshedAt,
        }),
        refreshedAt,
        refreshedAt,
      ],
    );
    const overlayScore: OscScore = {
      ...scores[0],
      id: 9002,
      user_id: 202,
      pp: 300,
      user: { id: 202, username: "Farmer", avatar_url: "https://assets.example/farmer.png", country_code: "CR" },
      ended_at: "2026-05-12T00:04:00.000Z",
      created_at: "2026-05-12T00:04:00.000Z",
    };
    await recordMapsFarmedScore(db, "CR", overlayScore, "2026-05-12T00:05:00.000Z");

    const snapshot = await getMapsSnapshot(db, queue, "CR", 7 * 24 * 60 * 60 * 1000);

    expect(snapshot.value?.farmed[0]).toMatchObject({
      beatmapId: 501,
      playerCount: 2,
      maxPp: 300,
    });
    expect(snapshot.value?.farmed[0].players.map((player) => player.id)).toEqual([202, 101]);
    expect(snapshot.value?.farmedGeneratedAt).toBe("2026-05-12T00:05:00.000Z");
  });

  it("invalidates the maps HTTP response cache when farmed overlay updates", async () => {
    const { db, queue, events } = await setup();
    const refreshedAt = "2026-05-12T10:00:00.000Z";
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [
        JSON.stringify({
          farmed: [],
          mostPlayed: [],
          favourites: [],
          favouritesByPlayer: [{
            id: 101,
            username: "Player",
            avatarUrl: "https://assets.example/player.png",
            beatmapsetIds: [1],
          }],
          beatmapsetsPool: {},
          generatedAt: refreshedAt,
          farmedGeneratedAt: refreshedAt,
          favouritesGeneratedAt: refreshedAt,
        }),
        refreshedAt,
        refreshedAt,
      ],
    );
    const ctx = {
      db,
      queue,
      events,
      config: baseConfig(),
      osu: {},
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never;
    const request = async () => {
      const { res, writes } = mockRes();
      await routeHttp(mockReq("GET", "/api/snapshots/maps?country=CR"), res, ctx);
      return JSON.parse(writes.join("")) as { value: { farmed: unknown[] } | null };
    };

    expect((await request()).value?.farmed).toHaveLength(0);

    const score = { ...(await fixture<OscScore[]>("scores.json"))[0], pp: 550 };
    await recordMapsFarmedScore(db, "CR", score, "2026-05-12T10:05:00.000Z");

    expect((await request()).value?.farmed).toHaveLength(1);
  });

  it("refreshes a player's farmed overlay from their top-200 best-score window", async () => {
    const { db } = await setup();
    const [baseScore] = await fixture<OscScore[]>("scores.json");
    const now = "2026-05-12T11:00:00.000Z";
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (101, 'Sniper', 'https://assets.example/sniper.png', 'CR', ?)`,
      [now],
    );
    const bestScores = Array.from({ length: 200 }, (_, index): OscScore => ({
      ...baseScore,
      id: 20_000 + index,
      beatmap_id: 10_000 + index,
      pp: 400 - index,
      beatmap: {
        ...baseScore.beatmap!,
        id: 10_000 + index,
        beatmapset_id: 30_000 + index,
      },
      beatmapset: {
        ...baseScore.beatmapset!,
        id: 30_000 + index,
      },
    }));
    const osu = {
      getUserBestScoresWindow: vi.fn(async (_userId: number, _limit: number, _caller: string) => bestScores),
    };

    const result = await refreshUserMapsFarmedScores(db, osu, { country: "CR", userId: 101 });

    expect(result.scoreCount).toBe(200);
    expect(osu.getUserBestScoresWindow).toHaveBeenCalledWith(101, 200, "job:refresh_user_maps_farmed_scores");
    expect(Number((await exec(db, "select count(*) as count from country_maps_farmed_scores where country = 'CR' and user_id = 101")).rows[0].count)).toBe(200);
    const user = (await exec(db, "select maps_farmed_min_pp, maps_farmed_scores_refreshed_at from users where user_id = 101")).rows[0];
    expect(Number(user.maps_farmed_min_pp)).toBe(201);
    expect(String(user.maps_farmed_scores_refreshed_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("builds country maps from the configured roster size", async () => {
    const { db } = await setup();
    const [baseScore] = await fixture<OscScore[]>("scores.json");
    const previousRosterSize = process.env.ROSTER_SIZE;
    process.env.ROSTER_SIZE = "100";
    try {
      const now = "2026-05-12T11:30:00.000Z";
      for (let rank = 1; rank <= 100; rank++) {
        const userId = 10_000 + rank;
        await exec(
          db,
          `insert into users (user_id, username, avatar_url, country_code, updated_at)
           values (?, ?, ?, 'CR', ?)`,
          [userId, `Player ${rank}`, `https://assets.example/${userId}.png`, now],
        );
        await exec(
          db,
          `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
           values ('CR', ?, ?, 'test', 1, ?)`,
          [userId, rank, now],
        );
      }
      const osu = {
        getUserBestScoresWindow: vi.fn(async (userId: number): Promise<OscScore[]> => userId === 10_100
          ? [{
              ...baseScore,
              id: 50_000,
              user_id: userId,
              beatmap_id: 60_000,
              pp: 650,
              beatmap: {
                ...baseScore.beatmap!,
                id: 60_000,
                beatmapset_id: 70_000,
              },
              beatmapset: {
                ...baseScore.beatmapset!,
                id: 70_000,
                status: "ranked",
              },
            }]
          : []),
        getUserMostPlayed: vi.fn(async () => []),
        getUserFavourites: vi.fn(async () => []),
      };

      const snapshot = await refreshCountryMaps(db, osu, { country: "CR" });

      expect(osu.getUserBestScoresWindow).toHaveBeenCalledTimes(100);
      expect(osu.getUserBestScoresWindow).toHaveBeenCalledWith(10_100, 200, "job:refresh_country_maps:farmed");
      expect(snapshot.farmed.some((entry) => entry.players.some((player) => player.id === 10_100))).toBe(true);
    } finally {
      if (previousRosterSize == null) delete process.env.ROSTER_SIZE;
      else process.env.ROSTER_SIZE = previousRosterSize;
    }
  });

  it("splits maps snapshots into core and random sections", async () => {
    const { db, queue } = await setup();
    const now = new Date().toISOString();
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [
        JSON.stringify({
          farmed: [{ beatmapId: 1, players: [] }],
          mostPlayed: [{ beatmapId: 2, players: [] }],
          favourites: [{
            beatmapsetId: 10,
            title: "Favourite",
            artist: "Artist",
            creator: "Mapper",
            covers: {},
            status: "ranked",
            globalPlayCount: 1,
            globalFavouriteCount: 1,
            playerCount: 1,
            players: [{ id: 101, username: "Player", avatarUrl: "https://assets.example/player.png" }],
          }],
          favouritesByPlayer: [{
            id: 101,
            username: "Player",
            avatarUrl: "https://assets.example/player.png",
            beatmapsetIds: [10],
          }],
          beatmapsetsPool: {
            10: {
              id: 10,
              title: "Favourite",
              artist: "Artist",
              creator: "Mapper",
              covers: {},
              status: "ranked",
              globalPlayCount: 1,
              globalFavouriteCount: 1,
              previewUrl: "",
              maniaKeys: [4],
              maniaBeatmaps: [],
              starMin: 5,
              starMax: 5,
              bpm: 180,
              patterns: ["stream"],
            },
          },
          generatedAt: now,
          farmedGeneratedAt: now,
          favouritesGeneratedAt: now,
        }),
        now,
        now,
      ],
    );

    const core = await getMapsSnapshot(db, queue, "CR", 7 * 24 * 60 * 60 * 1000);
    const random = await getMapsSnapshot(db, queue, "CR", 7 * 24 * 60 * 60 * 1000, "random");

    expect(core.value?.farmed).toHaveLength(1);
    expect(core.value?.mostPlayed).toHaveLength(1);
    expect(core.value?.favourites).toHaveLength(1);
    expect(core.value?.favouritesByPlayer).toHaveLength(1);
    expect(core.value?.beatmapsetsPool).toEqual({});

    expect(random.value?.farmed).toEqual([]);
    expect(random.value?.mostPlayed).toEqual([]);
    expect(random.value?.favourites).toEqual([]);
    expect(random.value?.beatmapsetsPool[10]?.title).toBe("Favourite");
  });

  it("ranks all tracked rosters together for the Global leaderboard", async () => {
    const { db } = await setup();
    const now = new Date().toISOString();
    const seed = async (id: number, name: string, country: string, pp: number, globalRank: number) => {
      await exec(
        db,
        `insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, updated_at)
         values (?, ?, ?, ?, ?, ?, 1, ?)`,
        [id, name, `https://assets.example/${id}.png`, country, pp, globalRank, now],
      );
      await exec(
        db,
        `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
         values (?, ?, 1, 'test', 1, ?)`,
        [country, id, now],
      );
    };
    await seed(1, "Kalkai", "KR", 29000, 1);
    await seed(2, "butanic", "JP", 27000, 3);
    await seed(3, "bojii", "PH", 26000, 4);
    // Untracked roster member is excluded from the global board.
    await exec(db, "insert into users (user_id, username, avatar_url, country_code, pp, global_rank, updated_at) values (9, 'Bench', '', 'CR', 5000, 900, ?)", [now]);
    await exec(db, "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', 9, 50, 'test', 0, ?)", [now]);

    const snapshot = await getGlobalRankingsSnapshot(db, { pageSize: 50 });
    expect(snapshot.total).toBe(3);
    expect(snapshot.ranking.map((r) => r.user.username)).toEqual(["Kalkai", "butanic", "bojii"]);
    expect(snapshot.ranking[0]).toMatchObject({ rank: 1, pp: 29000, global_rank: 1 });
    expect(snapshot.ranking[0].user.country_code).toBe("KR");
  });

  it("merges per-country maps snapshots into the Global aggregate", async () => {
    const { db, queue } = await setup();
    const now = "2026-05-12T12:00:00.000Z";
    for (const [id, name, country] of [
      [101, "Alpha", "CR"],
      [102, "Bravo", "CR"],
      [201, "Carmen", "MX"],
      [202, "Diego", "MX"],
    ] as const) {
      await exec(
        db,
        `insert into users (user_id, username, avatar_url, country_code, updated_at)
         values (?, ?, ?, ?, ?)`,
        [id, name, `https://assets.example/${id}.png`, country, now],
      );
    }
    for (const id of [10, 20, 30]) {
      await exec(
        db,
        `insert into maps_beatmapsets
           (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
         values (?, ?, 'Artist', 'Mapper', 'ranked', '{}', 1, 1, '', 180, '[4]', '[]', ?)`,
        [id, `Set ${id}`, now],
      );
      await exec(
        db,
        `insert into maps_beatmaps
           (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
         values (?, ?, 'mania', 'ranked', 4, ?, 180, ?, ?, ?, ?)`,
        [id + 1, id, id / 10 + 4, id * 10, `[4K] ${id}`, `https://osu.ppy.sh/beatmaps/${id + 1}`, now],
      );
    }

    const insertSnapshot = (country: string, payload: object) =>
      exec(
        db,
        `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
         values (?, ?, ?, ?)`,
        [country, JSON.stringify({ schemaVersion: 2, generatedAt: now, farmedGeneratedAt: now, favouritesGeneratedAt: now, ...payload }), now, now],
      );

    await insertSnapshot("CR", {
      farmed: [
        { beatmapId: 11, playerCount: 2, avgPp: 315, maxPp: 330, players: [{ id: 101, mods: [], pp: 330, scoreUrl: null, playedAt: now }, { id: 102, mods: [], pp: 300, scoreUrl: null, playedAt: now }] },
        { beatmapId: 21, playerCount: 1, avgPp: 520, maxPp: 520, players: [{ id: 101, mods: [], pp: 520, scoreUrl: null, playedAt: now }] },
      ],
      mostPlayed: [{ beatmapId: 11, totalPlays: 8, playerCount: 2, players: [{ id: 101, count: 5 }, { id: 102, count: 3 }] }],
      favourites: [{ beatmapsetId: 10, playerCount: 1, players: [{ id: 101 }] }],
      favouritesByPlayer: [{ id: 101, beatmapsetIds: [10] }],
      beatmapsetsPool: [10],
    });
    await insertSnapshot("MX", {
      farmed: [
        { beatmapId: 11, playerCount: 1, avgPp: 310, maxPp: 310, players: [{ id: 201, mods: [], pp: 310, scoreUrl: null, playedAt: now }] },
        { beatmapId: 31, playerCount: 2, avgPp: 590, maxPp: 600, players: [{ id: 201, mods: [], pp: 600, scoreUrl: null, playedAt: now }, { id: 202, mods: [], pp: 580, scoreUrl: null, playedAt: now }] },
      ],
      mostPlayed: [{ beatmapId: 11, totalPlays: 4, playerCount: 1, players: [{ id: 201, count: 4 }] }],
      favourites: [{ beatmapsetId: 10, playerCount: 1, players: [{ id: 201 }] }],
      favouritesByPlayer: [{ id: 201, beatmapsetIds: [10, 30] }],
      beatmapsetsPool: [10, 30],
    });

    await refreshGlobalMaps(db);

    const farmed = await getMapsPageSnapshot(db, queue, "GLOBAL", 7 * 24 * 60 * 60 * 1000, {
      tab: "farmed", page: 0, pageSize: 24, key: "all", beatmapSort: "players", farmedSort: "players", dir: "desc", status: "all", pp: 0, mod: "all", q: "",
    });
    // bm11 (3 farmers across CR+MX), bm31 (2), bm21 (1, kept on >=500pp).
    expect(farmed.value?.total).toBe(3);
    const farmedTop = farmed.value?.items[0] as { beatmapId: number; playerCount: number; players: unknown[] };
    expect(farmedTop.beatmapId).toBe(11);
    expect(farmedTop.playerCount).toBe(3);
    expect(farmedTop.players).toHaveLength(3);

    const popular = await getMapsPageSnapshot(db, queue, "GLOBAL", 7 * 24 * 60 * 60 * 1000, {
      tab: "popular", page: 0, pageSize: 24, key: "all", beatmapSort: "plays", farmedSort: "players", dir: "desc", status: "all", pp: 0, mod: "all", q: "",
    });
    const popularTop = popular.value?.items[0] as { beatmapId: number; totalPlays: number; playerCount: number };
    expect(popularTop.beatmapId).toBe(11);
    expect(popularTop.totalPlays).toBe(12);
    expect(popularTop.playerCount).toBe(3);

    const favourites = await getMapsPageSnapshot(db, queue, "GLOBAL", 7 * 24 * 60 * 60 * 1000, {
      tab: "favourites", page: 0, pageSize: 24, key: "all", beatmapSort: "players", farmedSort: "players", dir: "desc", status: "all", pp: 0, mod: "all", q: "",
    });
    const favTop = favourites.value?.items[0] as { beatmapsetId: number; playerCount: number };
    expect(favTop.beatmapsetId).toBe(10);
    expect(favTop.playerCount).toBe(2);
  });

  it("preserves truncated global farmed counts when applying live overlay rows", async () => {
    const { db, queue } = await setup();
    const refreshedAt = "2026-05-12T12:00:00.000Z";
    const overlayAt = "2026-05-12T12:05:00.000Z";
    const previewPlayers = Array.from({ length: 80 }, (_, index) => ({
      id: 10_000 + index,
      mods: [],
      pp: 500 - index,
      scoreUrl: null,
      playedAt: refreshedAt,
    }));
    const covers = JSON.stringify({ card: "https://assets.example/card.jpg", cover: "https://assets.example/cover.jpg" });
    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (10, 'Global Set', 'Artist', 'Mapper', 'ranked', ?, 1, 1, '', 180, '[4]', '[]', ?)`,
      [covers, refreshedAt],
    );
    await exec(
      db,
      `insert into maps_beatmaps
         (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
       values (11, 10, 'mania', 'ranked', 4, 5.5, 180, 120, '[4K] Global', 'https://osu.ppy.sh/beatmaps/11', ?)`,
      [refreshedAt],
    );
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, updated_at)
       values (999, 'Overlay Player', 'https://assets.example/999.png', 'CR', ?)`,
      [overlayAt],
    );
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('GLOBAL', ?, ?, ?)`,
      [
        JSON.stringify({
          schemaVersion: 2,
          farmed: [{ beatmapId: 11, playerCount: 300, avgPp: 360, maxPp: 500, players: previewPlayers }],
          mostPlayed: [],
          favourites: [],
          favouritesByPlayer: [],
          beatmapsetsPool: [],
          generatedAt: refreshedAt,
          farmedGeneratedAt: refreshedAt,
          favouritesGeneratedAt: refreshedAt,
        }),
        refreshedAt,
        refreshedAt,
      ],
    );
    await exec(
      db,
      `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
       values ('CR', 999, 11, 9001, 550, ?, '[]', 'https://osu.ppy.sh/scores/9001', ?, ?, ?)`,
      [
        JSON.stringify({
          id: 9001,
          user_id: 999,
          ruleset_id: 3,
          pp: 550,
          mods: [],
          passed: true,
          beatmap_id: 11,
          beatmap: { id: 11, beatmapset_id: 10, mode: "mania", status: "ranked", cs: 4, difficulty_rating: 5.5, bpm: 180, total_length: 120, version: "[4K] Global", url: "https://osu.ppy.sh/beatmaps/11" },
          beatmapset: { id: 10, title: "Global Set", artist: "Artist", creator: "Mapper", status: "ranked", covers: JSON.parse(covers) },
          user: { id: 999, username: "Overlay Player", avatar_url: "https://assets.example/999.png", country_code: "CR" },
          ended_at: overlayAt,
          created_at: overlayAt,
        }),
        overlayAt,
        overlayAt,
        overlayAt,
      ],
    );

    const page = await getMapsPageSnapshot(db, queue, "GLOBAL", 7 * 24 * 60 * 60 * 1000, {
      tab: "farmed", page: 0, pageSize: 24, key: "all", beatmapSort: "players", farmedSort: "players", dir: "desc", status: "all", pp: 0, mod: "all", q: "",
    });

    const item = page.value?.items[0] as { beatmapId: number; playerCount: number; players: Array<{ id: number }>; avgPp: number; maxPp: number };
    expect(item.beatmapId).toBe(11);
    expect(item.playerCount).toBe(300);
    expect(item.players).toHaveLength(8);
    expect(item.players[0]).toMatchObject({ id: 999 });
    expect(item.avgPp).toBe(360);
    expect(item.maxPp).toBe(550);
  });

  it("stores global map preview player lists while keeping aggregate counts", async () => {
    const { db } = await setup();
    const now = "2026-05-12T12:10:00.000Z";
    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (10, 'Preview Set', 'Artist', 'Mapper', 'ranked', '{}', 1, 1, '', 180, '[4]', '[]', ?)`,
      [now],
    );
    await exec(
      db,
      `insert into maps_beatmaps
         (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
       values (11, 10, 'mania', 'ranked', 4, 5.5, 180, 120, '[4K] Preview', 'https://osu.ppy.sh/beatmaps/11', ?)`,
      [now],
    );
    const players = Array.from({ length: 90 }, (_, index) => ({
      id: 20_000 + index,
      mods: [],
      pp: 500 - index,
      scoreUrl: null,
      playedAt: now,
    }));
    const insertSnapshot = async (country: string, slice: typeof players) => {
      await exec(
        db,
        `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
         values (?, ?, ?, ?)`,
        [
          country,
          JSON.stringify({
            schemaVersion: 2,
            farmed: [{ beatmapId: 11, playerCount: slice.length, avgPp: 400, maxPp: 500, players: slice }],
            mostPlayed: [{ beatmapId: 11, totalPlays: slice.length, playerCount: slice.length, players: slice.map((player) => ({ id: player.id, count: 1 })) }],
            favourites: [{ beatmapsetId: 10, playerCount: slice.length, players: slice.map((player) => ({ id: player.id })) }],
            favouritesByPlayer: [],
            beatmapsetsPool: [10],
            generatedAt: now,
            farmedGeneratedAt: now,
            favouritesGeneratedAt: now,
          }),
          now,
          now,
        ],
      );
    };
    await insertSnapshot("CR", players.slice(0, 45));
    await insertSnapshot("MX", players.slice(45));

    await refreshGlobalMaps(db);

    const row = (await exec(db, "select payload_json from country_maps_snapshots where country = 'GLOBAL'")).rows[0];
    const payload = JSON.parse(String(row.payload_json)) as {
      farmed: Array<{ playerCount: number; players: unknown[] }>;
      mostPlayed: Array<{ playerCount: number; players: unknown[] }>;
      favourites: Array<{ playerCount: number; players: unknown[] }>;
    };
    expect(payload.farmed[0].playerCount).toBe(90);
    expect(payload.farmed[0].players).toHaveLength(80);
    expect(payload.mostPlayed[0].playerCount).toBe(90);
    expect(payload.mostPlayed[0].players).toHaveLength(80);
    expect(payload.favourites[0].playerCount).toBe(90);
    expect(payload.favourites[0].players).toHaveLength(80);
  });

  it("paginates and searches the map detail player list", async () => {
    const { db } = await setup();
    const now = "2026-05-12T12:00:00.000Z";

    const players: Array<{ id: number; count: number }> = [];
    for (let i = 1; i <= 60; i++) {
      const userId = 1000 + i;
      await exec(
        db,
        `insert into users (user_id, username, avatar_url, country_code, updated_at)
         values (?, ?, ?, 'CR', ?)`,
        [userId, `Player${i}`, `https://assets.example/${userId}.png`, now],
      );
      players.push({ id: userId, count: 100 - i });
    }
    // One distinctive name so the server-side search has a single target.
    await exec(db, "update users set username = 'Needle' where user_id = ?", [1037]);

    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [
        JSON.stringify({
          schemaVersion: 2,
          farmed: [],
          mostPlayed: [{ beatmapId: 555, totalPlays: 1000, playerCount: players.length, players }],
          favourites: [],
          favouritesByPlayer: [],
          beatmapsetsPool: [],
          generatedAt: now,
          farmedGeneratedAt: now,
          favouritesGeneratedAt: now,
        }),
        now,
        now,
      ],
    );

    const firstPage = await getMapsPlayersSnapshot(db, "CR", "popular", 555, { page: 0, pageSize: 50, q: "" });
    expect(firstPage.total).toBe(60);
    expect(firstPage.matched).toBe(60);
    expect(firstPage.players).toHaveLength(50);
    // Sorted by play count desc, so Player1 (count 99) leads.
    expect(firstPage.players[0]).toMatchObject({ username: "Player1", count: 99 });

    const secondPage = await getMapsPlayersSnapshot(db, "CR", "popular", 555, { page: 1, pageSize: 50, q: "" });
    expect(secondPage.total).toBe(60);
    expect(secondPage.players).toHaveLength(10);
    expect(secondPage.players[0].id).not.toBe(firstPage.players[0].id);

    // Oversized page sizes are clamped to the 50 cap.
    const clamped = await getMapsPlayersSnapshot(db, "CR", "popular", 555, { page: 0, pageSize: 9999, q: "" });
    expect(clamped.pageSize).toBe(50);
    expect(clamped.players).toHaveLength(50);

    const searched = await getMapsPlayersSnapshot(db, "CR", "popular", 555, { page: 0, pageSize: 50, q: "needle" });
    expect(searched.total).toBe(60);
    expect(searched.matched).toBe(1);
    expect(searched.players).toHaveLength(1);
    // Needle is the 37th player by play count, so the search keeps its true
    // board rank rather than collapsing to 1 within the single match.
    expect(searched.players[0]).toMatchObject({ username: "Needle", rank: 37 });
    // First page carries contiguous ranks from the top of the board.
    expect(firstPage.players[0].rank).toBe(1);
    expect(secondPage.players[0].rank).toBe(51);
  });

  it("ships a lean random pool and serves full set records on demand", async () => {
    const { db, queue } = await setup();
    const now = "2026-05-12T12:00:00.000Z";

    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (?, ?, ?, ?, 'ranked', ?, 1000, 50, ?, 180, '[4,7]', '["stream"]', ?)`,
      [
        7000,
        "Pool Song",
        "Pool Artist",
        "Pool Mapper",
        JSON.stringify({
          cover: "https://img/cover.jpg",
          "cover@2x": "https://img/cover@2x.jpg",
          card: "https://img/card.jpg",
          "card@2x": "https://img/card@2x.jpg",
          list: "https://img/list.jpg",
          "list@2x": "https://img/list@2x.jpg",
          slimcover: "https://img/slim.jpg",
          "slimcover@2x": "https://img/slim@2x.jpg",
        }),
        "https://img/preview.mp3",
        now,
      ],
    );
    for (const [beatmapId, version, stars, keys] of [
      [7001, "[4K] Normal", 3.2, 4],
      [7002, "[7K] Insane", 5.6, 7],
    ] as const) {
      await exec(
        db,
        `insert into maps_beatmaps
           (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
         values (?, 7000, 'mania', 'ranked', ?, ?, 180, 120, ?, ?, ?)`,
        [beatmapId, keys, stars, version, `https://osu.ppy.sh/beatmaps/${beatmapId}`, now],
      );
    }

    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [
        JSON.stringify({
          schemaVersion: 2,
          farmed: [],
          mostPlayed: [],
          favourites: [],
          favouritesByPlayer: [{ id: 101, beatmapsetIds: [7000] }],
          beatmapsetsPool: [7000],
          generatedAt: now,
          farmedGeneratedAt: now,
          favouritesGeneratedAt: now,
        }),
        now,
        now,
      ],
    );

    // The random pool keeps filter/label fields but drops the heavy media.
    const snapshot = await getMapsSnapshot(db, queue, "CR", 7 * 24 * 60 * 60 * 1000, "random");
    const poolSet = snapshot.value?.beatmapsetsPool[7000];
    expect(poolSet?.title).toBe("Pool Song");
    expect(poolSet?.maniaKeys).toEqual([4, 7]);
    expect(poolSet?.patterns).toEqual(["stream"]);
    expect(poolSet?.starMin).toBeCloseTo(3.2);
    expect(poolSet?.starMax).toBeCloseTo(5.6);
    expect(poolSet?.covers).toEqual({});
    expect(poolSet?.maniaBeatmaps).toEqual([]);
    expect(poolSet?.previewUrl).toBe("");

    // The on-demand per-set record carries the full difficulty list, but only
    // the three cover variants the card actually renders.
    const [full] = await getMapsRandomBeatmapsets(db, [7000]);
    expect(full.id).toBe(7000);
    expect(full.maniaBeatmaps).toHaveLength(2);
    expect(full.previewUrl).toBe("https://img/preview.mp3");
    expect(Object.keys(full.covers).sort()).toEqual(["card", "cover", "list"]);
    expect(full.covers["cover@2x"]).toBeUndefined();
    expect(full.covers.slimcover).toBeUndefined();
  });

  it("serves maps browse tabs as paginated lightweight pages", async () => {
    const { db, queue, events } = await setup();
    const now = "2026-05-12T12:00:00.000Z";
    const users: Array<[number, string]> = Array.from({ length: 12 }, (_, index) => [
      101 + index,
      ["Alpha", "Bravo", "Charlie"][index] ?? `User ${index + 1}`,
    ]);
    const farmedPlayers = users.map(([id], index) => ({
      id,
      mods: index < 7 ? ["DT"] : [],
      pp: 500 - index,
      scoreUrl: null,
      playedAt: now,
    }));
    for (const user of users) {
      await exec(
        db,
        `insert into users (user_id, username, avatar_url, country_code, updated_at)
         values (?, ?, ?, 'CR', ?)`,
        [user[0], user[1], `https://assets.example/${user[0]}.png`, now],
      );
    }
    for (const id of [10, 20, 30]) {
      await exec(
        db,
        `insert into maps_beatmapsets
           (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
         values (?, ?, 'Artist', 'Mapper', 'ranked', '{}', 1, 1, '', 180, '[4]', '[]', ?)`,
        [id, `Set ${id}`, now],
      );
      await exec(
        db,
        `insert into maps_beatmaps
           (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
         values (?, ?, 'mania', 'ranked', 4, ?, 180, ?, ?, ?, ?)`,
        [id + 1, id, id / 10 + 4, id * 10, `[4K] ${id}`, `https://osu.ppy.sh/beatmaps/${id + 1}`, now],
      );
    }
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [
        JSON.stringify({
          schemaVersion: 2,
          farmed: [
            { beatmapId: 11, playerCount: farmedPlayers.length, avgPp: 494.5, maxPp: 500, players: farmedPlayers },
            { beatmapId: 21, playerCount: 2, avgPp: 410, maxPp: 420, players: [{ id: 101, mods: [], pp: 420, scoreUrl: null, playedAt: now }, { id: 102, mods: [], pp: 400, scoreUrl: null, playedAt: now }] },
            { beatmapId: 31, playerCount: 1, avgPp: 550, maxPp: 550, players: [{ id: 103, mods: ["DT"], pp: 550, scoreUrl: null, playedAt: now }] },
          ],
          mostPlayed: [],
          favourites: [],
          favouritesByPlayer: [],
          beatmapsetsPool: [],
          generatedAt: now,
          farmedGeneratedAt: now,
          favouritesGeneratedAt: now,
        }),
        now,
        now,
      ],
    );

    const page = await getMapsPageSnapshot(db, queue, "CR", 7 * 24 * 60 * 60 * 1000, {
      tab: "farmed",
      page: 1,
      pageSize: 2,
      key: "all",
      beatmapSort: "players",
      farmedSort: "players",
      dir: "desc",
      status: "all",
      pp: 0,
      mod: "all",
      q: "",
    });

    expect(page.value?.total).toBe(3);
    expect(page.value?.items).toHaveLength(1);
    expect(page.value?.items[0]).toMatchObject({ beatmapId: 31, title: "Set 30" });
    expect(page.value?.items[0].players[0]).toMatchObject({ username: "Charlie" });

    const response = mockRes();
    await routeHttp(
      mockReq("GET", "/api/snapshots/maps-page?country=CR&tab=farmed&page=0&pageSize=2"),
      response.res,
      {
        db,
        queue,
        events,
        config: baseConfig(),
        osu: {},
        oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
      } as never,
    );

    const body = JSON.parse(response.writes.join("")) as { value: { total: number; items: unknown[] } };
    expect(response.res.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(body.value.total).toBe(3);
    expect(body.value.items).toHaveLength(2);
    const firstItem = body.value.items[0] as { playerCount: number; players: unknown[]; dominantMod?: string | null };
    expect(firstItem.playerCount).toBe(12);
    expect(firstItem.players).toHaveLength(8);
    expect(firstItem.dominantMod).toBe("DT");
    const details = await getMapsPlayersSnapshot(db, "CR", "farmed", 11);
    expect(details.total).toBe(12);
    expect(details.players).toHaveLength(12);
  });

  it("defers maps refreshes without marking them failed while the roster is missing", async () => {
    const { db, queue, events, ingestor } = await setup();
    await enqueueMapsRefreshIfDue(db, queue, "AU", 7 * 24 * 60 * 60 * 1000);
    const worker = new WorkerRunner(db, queue, events, {} as never, ingestor, "test-worker");

    await worker.runOnce();

    const job = (await exec(db, "select status, last_error, run_after from jobs where type = 'refresh_country_maps' and dedupe_key = 'maps:AU'")).rows[0];
    expect(job).toMatchObject({ status: "queued", last_error: null });
    expect(new Date(String(job.run_after)).getTime()).toBeGreaterThan(Date.now());
  });

  it("cleans up old maps roster-missing failures as deferred jobs", async () => {
    const { db, queue } = await setup();
    await queue.enqueue("refresh_country_maps", "maps:AU", { country: "AU" });
    const job = (await queue.claim("test-worker"))[0];
    await queue.fail(job.id, new Error("No tracked roster users available for AU"), 60 * 60_000);

    expect(await deferMapsRefreshesWaitingForRoster(db)).toBe(1);

    const row = (await exec(db, "select status, last_error, run_after from jobs where id = ?", [job.id])).rows[0];
    expect(row).toMatchObject({ status: "queued", last_error: null });
    expect(new Date(String(row.run_after)).getTime()).toBeGreaterThan(Date.now());
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

  it("caches the maps snapshot HTTP response until the row's refreshed_at changes", async () => {
    const { db, queue, events } = await setup();
    const refreshedAt = new Date().toISOString();
    const writePayload = () =>
      JSON.stringify({
        farmed: [],
        mostPlayed: [],
        favourites: [],
        favouritesByPlayer: [{
          id: 101,
          username: "Player",
          avatarUrl: "https://assets.example/player.png",
          beatmapsetIds: [1],
        }],
        beatmapsetsPool: {},
        generatedAt: refreshedAt,
        farmedGeneratedAt: refreshedAt,
        favouritesGeneratedAt: refreshedAt,
      });
    await exec(
      db,
      `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
       values ('CR', ?, ?, ?)`,
      [writePayload(), refreshedAt, refreshedAt],
    );

    const ctx = {
      db,
      queue,
      events,
      config: baseConfig(),
      osu: {},
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never;
    const request = async () => {
      const { res, writes } = mockRes();
      await routeHttp(mockReq("GET", "/api/snapshots/maps?country=CR"), res, ctx);
      return { status: res.statusCode, body: JSON.parse(writes.join("")) as { value: unknown } };
    };

    const first = await request();
    expect(first.status).toBe(200);
    expect(first.body.value).toBeTruthy();

    // Corrupt the stored payload but keep refreshed_at: a fresh build would now
    // fail to parse, so a still-good response proves it came from the cache.
    await exec(db, "update country_maps_snapshots set payload_json = ? where country = 'CR'", ["{not json"]);
    const cached = await request();
    expect(cached.status).toBe(200);
    expect(cached.body.value).toBeTruthy();

    // Bumping refreshed_at changes the cache key, so the next request misses
    // and sees the corrupt payload.
    await exec(
      db,
      "update country_maps_snapshots set refreshed_at = ? where country = 'CR'",
      [new Date(Date.now() + 1000).toISOString()],
    );
    const afterRefresh = await request();
    expect(afterRefresh.status).toBe(202);
    expect(afterRefresh.body.value).toBeNull();
  });

  it("marks large JSON responses as varying by accept-encoding", () => {
    const { res, writes, headers } = mockRes();

    sendJson(mockReq("GET", "/api/test"), res, { config: baseConfig() } as never, 200, {
      data: "x".repeat(2000),
    });

    expect(res.statusCode).toBe(200);
    expect(headers.vary).toBe("accept-encoding");
    expect(headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(writes.join("")).data).toHaveLength(2000);
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

  it("opens Global SSE without activating synthetic country work", async () => {
    const { db, queue, events } = await setup();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const req = mockReq("GET", "/api/live?country=GLOBAL", { "x-real-ip": "203.0.113.41" });
    const res = mockRes();

    await handleSse(req, res.res, {
      db,
      queue,
      events,
      config: baseConfig(),
      osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
      oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
    } as never);

    expect(res.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "content-type": "text/event-stream; charset=utf-8" }));
    expect(enqueueSpy).not.toHaveBeenCalled();
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
