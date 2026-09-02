import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, exec, migrate, type Db } from "../src/db.js";
import { importBeatmapLeaderboard, leaderboardImportDedupeKey } from "../src/features/leaderboard-import.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { getLastIngestAtMs } from "../src/live/sse.js";
import { OsuApiError } from "../src/osu/client.js";
import type { OscScore } from "../src/shared/types.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-leaderboard-import-http-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function fixtureScore(): Promise<OscScore> {
  const scores = JSON.parse(await readFile(new URL("../fixtures/scores.json", import.meta.url), "utf8")) as OscScore[];
  return scores[0];
}

/* What /beatmaps/{id}/scores hands back: the score with its user, minus the
   beatmap and beatmapset the /scores/{id} shape carries. */
function boardEntry(score: OscScore, overrides: Partial<OscScore> & { user?: OscScore["user"] } = {}): OscScore {
  const { beatmap: _beatmap, beatmapset: _beatmapset, ...lean } = score;
  return { ...lean, ...overrides } as OscScore;
}

function request(method: string, url: string, body?: unknown, admin = true): IncomingMessage {
  const req = body === undefined
    ? new EventEmitter() as IncomingMessage
    : Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...(admin ? { authorization: "Bearer admin-secret" } : {}) };
  return req;
}

function response() {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (key: string, value: number | string | readonly string[]) => {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    writeHead: (status: number) => {
      res.statusCode = status;
      return res;
    },
    write: (chunk: string | Buffer) => {
      writes.push(String(chunk));
      return true;
    },
    destroy: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk != null) writes.push(String(chunk));
    },
  }) as unknown as ServerResponse & { statusCode: number };
  return { res, writes };
}

function context(osu: { getBeatmap: (id: number) => Promise<Record<string, unknown>>; getBeatmapScores: (id: number) => Promise<OscScore[]> }) {
  return {
    db,
    serveWriteDb: db,
    queue,
    serveWriteQueue: queue,
    events,
    abuse: new AbuseGuard(),
    osu: { getBeatmap: vi.fn(osu.getBeatmap), getBeatmapScores: vi.fn(osu.getBeatmapScores) },
    config: {
      nodeEnv: "test",
      liveAdminToken: "admin-secret",
      allowedOrigins: ["*"],
      trackedCountries: ["CR"],
      trustProxyHeaders: false,
      topPlayMarginPp: 5,
      countryWarmTtlMs: 24 * 60 * 60 * 1000,
      osuClientId: "test-client",
      osuClientSecret: "test-secret",
      publicApiRatePerMinute: 100,
      publicCostlyRatePerMinute: 100,
      scoreSubmitPerHour: 50,
      scoreSubmitGlobalRatePerMinute: 50,
    },
  } as never;
}

async function call(ctx: never, body: unknown, admin = true, method = "POST", path = "/api/admin/leaderboard-imports") {
  const output = response();
  await routeHttp(request(method, path, body, admin), output.res, ctx);
  const raw = output.writes.join("");
  return {
    status: output.res.statusCode,
    body: raw ? JSON.parse(raw) as Record<string, unknown> : null,
  };
}

async function rankedBeatmap(): Promise<Record<string, unknown>> {
  const score = await fixtureScore();
  return { ...score.beatmap, beatmapset: score.beatmapset } as unknown as Record<string, unknown>;
}

function ctxOsu(ctx: never): { db: Db; queue: JobQueue; events: LiveEventLog; config: never; osu: never } {
  return ctx as never;
}

async function runImport(ctx: never, beatmapId: number) {
  const c = ctxOsu(ctx);
  return importBeatmapLeaderboard(c.db, c.queue, c.events, c.config, c.osu, beatmapId);
}

describe("leaderboard import HTTP route", () => {
  it("is closed without the admin token", async () => {
    const ctx = context({
      getBeatmap: async () => { throw new Error("should not fetch"); },
      getBeatmapScores: async () => { throw new Error("should not fetch"); },
    });
    const result = await call(ctx, { beatmapId: 501 }, false);
    expect(result.status).toBe(401);
    expect(result.body?.error).toBe("unauthorized");
    expect(Number((await exec(db, "select count(*) as cnt from jobs")).rows[0].cnt)).toBe(0);
  });

  it("queues one job per chart without touching osu!, and reports it on GET", async () => {
    const getBeatmap = vi.fn(async () => { throw new Error("should not fetch"); });
    const ctx = context({ getBeatmap, getBeatmapScores: async () => [] });
    const result = await call(ctx, { beatmapId: 501 });
    expect(result.status).toBe(202);
    expect(result.body?.queued).toBe(true);
    expect(getBeatmap).not.toHaveBeenCalled();
    const job = (await exec(db, "select type, status, priority from jobs where dedupe_key = ?", [leaderboardImportDedupeKey(501)])).rows[0];
    expect(job?.type).toBe("import_beatmap_leaderboard");
    expect(job?.status).toBe("queued");

    const status = await call(ctx, undefined, true, "GET", "/api/admin/leaderboard-imports?ids=501,502");
    expect(status.status).toBe(200);
    expect(status.body?.statuses).toEqual([
      { beatmapId: 501, status: "queued", error: null, stored: 0, lastImportedAt: null, retryAt: null, recent: false },
      { beatmapId: 502, status: "none", error: null, stored: 0, lastImportedAt: null, retryAt: null, recent: false },
    ]);

    // A successful done job is itself enough rollout history to prevent an
    // immediate repeat, even before a durable receipt exists.
    await exec(db, "update jobs set status = 'done' where dedupe_key = ?", [leaderboardImportDedupeKey(501)]);
    const recent = await call(ctx, { beatmapId: 501 });
    expect(recent.status).toBe(200);
    expect(recent.body?.queued).toBe(false);
    expect(recent.body?.recentBeatmapIds).toEqual([501]);
    expect((await exec(db, "select status from jobs where dedupe_key = ?", [leaderboardImportDedupeKey(501)])).rows[0]?.status).toBe("done");

    // Once the receipt is older than seven days, replaceDone makes the same
    // dedupe row runnable again.
    await exec(db, "update jobs set updated_at = ? where dedupe_key = ?", [new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(), leaderboardImportDedupeKey(501)]);
    const stale = await call(ctx, { beatmapId: 501 });
    expect(stale.status).toBe(202);
    const again = (await exec(db, "select status from jobs where dedupe_key = ?", [leaderboardImportDedupeKey(501)])).rows[0];
    expect(again?.status).toBe("queued");
  });

  it("queues a whole set from one request, ignoring junk and repeats", async () => {
    const ctx = context({ getBeatmap: async () => ({}), getBeatmapScores: async () => [] });
    const result = await call(ctx, { beatmapIds: [601, "602", 601, "x", -1] });
    expect(result.status).toBe(202);
    expect(result.body?.beatmapIds).toEqual([601, 602]);
    const rows = (await exec(db, "select dedupe_key from jobs where type = 'import_beatmap_leaderboard' and dedupe_key in (?, ?)", [leaderboardImportDedupeKey(601), leaderboardImportDedupeKey(602)])).rows;
    expect(rows.length).toBe(2);
  });

  it("recognizes a recent pre-history import that stored no score rows", async () => {
    const path = "/beatmaps/701/scores?mode=mania";
    await exec(db, "insert into api_call_targets (provider, caller, path) values ('osu', 'leaderboard-import', ?)", [path]);
    const target = (await exec(db, "select id from api_call_targets where provider = 'osu' and caller = 'leaderboard-import' and path = ?", [path])).rows[0];
    await exec(
      db,
      "insert into api_call_log (provider, caller, path, target_id, started_at, duration_ms, status) values ('osu', '', '', ?, ?, 1, 200)",
      [Number(target?.id), new Date().toISOString()],
    );
    const ctx = context({
      getBeatmap: async () => { throw new Error("should not fetch"); },
      getBeatmapScores: async () => { throw new Error("should not fetch"); },
    });

    const status = await call(ctx, undefined, true, "GET", "/api/admin/leaderboard-imports?ids=701");
    expect(status.body?.statuses).toEqual([
      expect.objectContaining({ beatmapId: 701, status: "none", stored: 0, recent: true, lastImportedAt: expect.any(String) }),
    ]);
    const guarded = await call(ctx, { beatmapId: 701 });
    expect(guarded.status).toBe(200);
    expect(guarded.body?.recentBeatmapIds).toEqual([701]);
    expect((await exec(db, "select 1 from jobs where dedupe_key = ?", [leaderboardImportDedupeKey(701)])).rows).toHaveLength(0);
  });

  it("rejects a malformed chart id", async () => {
    const ctx = context({ getBeatmap: async () => ({}), getBeatmapScores: async () => [] });
    const result = await call(ctx, { beatmapId: "x" });
    expect(result.status).toBe(400);
    expect(result.body?.error).toBe("invalid_beatmap_id");
  });
});

describe("importBeatmapLeaderboard (the job)", () => {
  it("refuses a chart osu! does not know", async () => {
    const ctx = context({
      getBeatmap: async () => { throw new OsuApiError(404, "/beatmaps/501"); },
      getBeatmapScores: async () => [],
    });
    expect(await runImport(ctx, 501)).toEqual({ ok: false, reason: "beatmap_not_found" });
  });

  it("refuses a chart without a leaderboard before asking for its scores", async () => {
    const beatmap = await rankedBeatmap();
    const getBeatmapScores = vi.fn(async () => []);
    const ctx = context({ getBeatmap: async () => ({ ...beatmap, status: "graveyard" }), getBeatmapScores });
    expect(await runImport(ctx, 501)).toEqual({ ok: false, reason: "no_leaderboard" });
    expect(getBeatmapScores).not.toHaveBeenCalled();
  });

  it("refuses a chart from another mode", async () => {
    const beatmap = await rankedBeatmap();
    const ctx = context({ getBeatmap: async () => ({ ...beatmap, mode: "osu", mode_int: 0 }), getBeatmapScores: async () => [] });
    expect(await runImport(ctx, 501)).toEqual({ ok: false, reason: "not_mania" });
  });

  it("stores the board's tracked players, reports the rest, and skips what is already stored", async () => {
    const score = await fixtureScore();
    if (!score.user) throw new Error("fixture score is missing user data");
    const beatmap = await rankedBeatmap();
    const foreign = boardEntry(score, {
      id: 9002,
      user_id: 202,
      user: { ...score.user, id: 202, username: "Abroad", country_code: "XX" },
    });
    const failed = boardEntry(score, { id: 9003, passed: false });
    const ctx = context({
      getBeatmap: async () => beatmap,
      getBeatmapScores: async () => [boardEntry(score), foreign, failed],
    });
    const before = await getLastIngestAtMs(db);
    const result = await runImport(ctx, 501);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.fetched).toBe(2);
    expect(result.stored).toBe(1);
    expect(result.untracked).toBe(1);
    expect(result.alreadyTracked).toBe(0);
    expect(result.chart.title).toBe("Fixture Song");
    expect(result.players).toEqual([
      expect.objectContaining({ userId: 101, outcome: "stored", country: "CR" }),
      expect.objectContaining({ userId: 202, outcome: "untracked", country: "XX" }),
    ]);

    const row = (await exec(db, "select country, source, passed from score_events where score_id = 9001")).rows[0];
    expect(row?.country).toBe("CR");
    expect(row?.source).toBe("leaderboard_import");
    expect(Number(row?.passed)).toBe(1);
    // The chart the board was attached to is in the catalog, so the stored
    // play reads with its labels.
    const meta = (await exec(db, "select version from beatmaps where beatmap_id = 501")).rows[0];
    expect(meta?.version).toBe("Another");
    // Historical rows must not make a stalled feed look fresh.
    expect(await getLastIngestAtMs(db)).toBe(before);

    const again = await runImport(ctx, 501);
    if (!again.ok) throw new Error(`refused: ${again.reason}`);
    expect(again.stored).toBe(0);
    expect(again.alreadyTracked).toBe(1);
    expect(again.untracked).toBe(1);
    expect(Number((await exec(db, "select count(*) as cnt from score_events")).rows[0].cnt)).toBe(1);

    // The status readout counts the chart's imported rows and keeps a durable
    // receipt after the short-lived queue row is gone.
    const status = await call(ctx, undefined, true, "GET", "/api/admin/leaderboard-imports?ids=501");
    expect(status.body?.statuses).toEqual([
      expect.objectContaining({
        beatmapId: 501,
        status: "none",
        error: null,
        stored: 1,
        recent: true,
        lastImportedAt: expect.any(String),
        retryAt: expect.any(String),
      }),
    ]);

    await exec(db, "delete from score_events where beatmap_id = ?", [501]);
    const guarded = await call(ctx, { beatmapId: 501 });
    expect(guarded.status).toBe(200);
    expect(guarded.body?.queued).toBe(false);
    expect(guarded.body?.recentBeatmapIds).toEqual([501]);
    expect((await exec(db, "select 1 from jobs where dedupe_key = ?", [leaderboardImportDedupeKey(501)])).rows).toHaveLength(0);
  });
});
