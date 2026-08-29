import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb, exec, migrate, type Db } from "../src/db.js";
import { createUserGoal } from "../src/features/goals.js";
import { parseScoreLink } from "../src/features/score-submissions.js";
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
  dir = await mkdtemp(join(tmpdir(), "mania-score-submit-http-"));
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

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const req = body === undefined
    ? new EventEmitter() as IncomingMessage
    : Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost" };
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

function notFound(): OsuApiError {
  return new OsuApiError(404, "/scores/9001");
}

function context(getScoreById: (scoreId: number, space: "solo" | "legacy") => Promise<Record<string, unknown>>) {
  return {
    db,
    serveWriteDb: db,
    queue,
    serveWriteQueue: queue,
    events,
    abuse: new AbuseGuard(),
    osu: { getScoreById: vi.fn(getScoreById) },
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

async function call(ctx: never, body: unknown) {
  const output = response();
  await routeHttp(request("POST", "/api/score-submissions", body), output.res, ctx);
  const raw = output.writes.join("");
  return {
    status: output.res.statusCode,
    body: raw ? JSON.parse(raw) as Record<string, unknown> : null,
  };
}

describe("score submission HTTP route", () => {
  it("rejects a link that is not an osu! score URL", async () => {
    const ctx = context(async () => {
      throw new Error("should not fetch");
    });
    const result = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/beatmapsets/12345" });
    expect(result.status).toBe(400);
    expect(result.body?.error).toBe("invalid_link");
  });

  it("404s when neither id space knows the score", async () => {
    const ctx = context(async () => {
      throw notFound();
    });
    const result = await call(ctx, { userId: 101, link: "9001" });
    expect(result.status).toBe(404);
    expect(result.body?.error).toBe("score_not_found");
  });

  it("refuses a score owned by someone else, naming the owner", async () => {
    const score = await fixtureScore();
    if (!score.user) throw new Error("fixture score is missing user data");
    const foreign = { ...score, user_id: 999, user: { ...score.user, id: 999, username: "Someone Else" } };
    const ctx = context(async () => foreign as unknown as Record<string, unknown>);
    const result = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" });
    expect(result.status).toBe(400);
    expect(result.body?.error).toBe("not_owned");
    expect(result.body?.owner).toBe("Someone Else");
  });

  it("asks only the legacy space for a /scores/mania/ link and names a wrong-mode score", async () => {
    const score = await fixtureScore();
    const getScoreById = vi.fn(async () => ({ ...score, ruleset_id: 0 } as unknown as Record<string, unknown>));
    const ctx = context(getScoreById);
    const result = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/mania/9001" });
    expect(result.status).toBe(400);
    expect(result.body?.error).toBe("not_mania");
    const osu = (ctx as { osu: { getScoreById: typeof getScoreById } }).osu;
    expect(osu.getScoreById).toHaveBeenCalledTimes(1);
    expect(osu.getScoreById).toHaveBeenCalledWith(9001, "legacy", expect.any(String));
  });

  it("refuses a failed score", async () => {
    const score = await fixtureScore();
    const ctx = context(async () => ({ ...score, passed: false } as unknown as Record<string, unknown>));
    const result = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" });
    expect(result.status).toBe(400);
    expect(result.body?.error).toBe("not_passed");
  });

  it("refuses a verified score whose player resolves to no tracked country", async () => {
    const score = await fixtureScore();
    if (!score.user) throw new Error("fixture score is missing user data");
    const ctx = context(async () => ({ ...score, user: { ...score.user, country_code: "XX" } } as unknown as Record<string, unknown>));
    const result = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" });
    expect(result.status).toBe(400);
    expect(result.body?.error).toBe("player_untracked");
    expect(Number((await exec(db, "select count(*) as cnt from score_events")).rows[0].cnt)).toBe(0);
  });

  it("ingests a verified score like a tracked one and queues the skills recompute", async () => {
    const score = await fixtureScore();
    const ctx = context(async () => score as unknown as Record<string, unknown>);
    const result = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" });
    expect(result.status).toBe(200);
    expect(result.body?.ok).toBe(true);
    expect(result.body?.alreadyTracked).toBe(false);
    expect(result.body?.countries).toEqual(["CR"]);

    const row = (await exec(db, "select country, source, passed from score_events where score_id = 9001")).rows[0];
    expect(row?.country).toBe("CR");
    expect(row?.source).toBe("manual_submit");
    expect(Number(row?.passed)).toBe(1);
    const skillJobs = (await exec(db, "select count(*) as cnt from jobs where dedupe_key like 'player-skills:%'")).rows[0];
    expect(Number(skillJobs.cnt)).toBe(1);

    // A resubmission answers from the stored row without re-ingesting, and
    // without spending another osu! API call: the pre-check matches the pasted
    // id against the stored id columns before any fetch.
    const again = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" });
    expect(again.status).toBe(200);
    expect(again.body?.alreadyTracked).toBe(true);
    expect((again.body?.countries as string[])).toEqual(["CR"]);
    expect(Number((await exec(db, "select count(*) as cnt from score_events")).rows[0].cnt)).toBe(1);
    const osu = (ctx as { osu: { getScoreById: ReturnType<typeof vi.fn> } }).osu;
    expect(osu.getScoreById).toHaveBeenCalledTimes(1);

    // The same integer as an explicit legacy URL is a DIFFERENT id space, so
    // the pre-check must not answer from the solo column: this one fetches
    // (the identity check is what dedupes it).
    const legacyProbe = await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/mania/9001" });
    expect(legacyProbe.status).toBe(200);
    expect(legacyProbe.body?.alreadyTracked).toBe(true);
    expect(osu.getScoreById).toHaveBeenCalledTimes(2);
    expect(osu.getScoreById).toHaveBeenLastCalledWith(9001, "legacy", expect.any(String));
  });

  it("charges the submission buckets only when the osu! API is about to be spent", async () => {
    const score = await fixtureScore();
    const ctx = context(async () => score as unknown as Record<string, unknown>);
    const cfg = (ctx as { config: Record<string, unknown> }).config;
    cfg.scoreSubmitPerHour = 1;
    cfg.scoreSubmitGlobalRatePerMinute = 1;
    // Malformed spam up to the per-window limit and beyond...
    for (let i = 0; i < 3; i++) {
      expect((await call(ctx, { userId: 101, link: "nonsense" })).status).toBe(400);
    }
    expect((await call(ctx, { link: "https://osu.ppy.sh/scores/9001" })).status).toBe(400);
    // ...leaves the shared window untouched for the first real submission.
    expect((await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" })).status).toBe(200);
    // An already-tracked repeat answers from the DB and charges nothing...
    expect((await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" })).status).toBe(200);
    // ...so it is the next NEW id that finds the window spent.
    expect((await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9002" })).status).toBe(429);
  });

  it("corrects the snipe board silently and completes no goals and no top-play fanout", async () => {
    const score = await fixtureScore();
    const now = new Date().toISOString();
    // A ranked roster member with a lower victim on the board: a live ingest of
    // this score would emit a snipe event and enqueue a top-play confirmation.
    await exec(db, "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', 101, 1, 'osu_rankings', 1, ?)", [now]);
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (303, 'Runner Up', 'https://assets.example/runner-up.png', 'CR', ?)",
      [now],
    );
    await exec(
      db,
      `insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
       values ('CR', 501, 'normal:lazer', 303, 7000, 824000, 680, 0.95, 'S', '[]', 1, 1, '2026-05-06T00:00:00.000Z', ?)`,
      [now],
    );
    await createUserGoal(db, queue, { userId: 101, country: "CR", kind: "pass", beatmapId: 501 });
    // A real ingest row, seeded BEFORE the submission so the manual row gets
    // the higher rowid: the heartbeat freshness readout must keep answering
    // with this timestamp, not the manual row's current received_at.
    const realIngestAt = "2026-08-20T00:00:00.000Z";
    await exec(
      db,
      `insert into score_events (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (7000, 'official:7000', 303, 'CR', 501, 3, '{}', 200, 900000, 0.97, 'S', 1, 1, 1, 0, ?, ?, 'osc_socket')`,
      [realIngestAt, realIngestAt],
    );

    const ctx = context(async () => score as unknown as Record<string, unknown>);
    expect((await call(ctx, { userId: 101, link: "https://osu.ppy.sh/scores/9001" })).status).toBe(200);

    // The board row corrects (all-time surface), but nothing presents the old
    // play as news: no snipe event, no completed goal, no top-play refresh.
    const boardRow = (await exec(
      db,
      "select total_score from country_beatmap_scores where country = 'CR' and beatmap_id = 501 and user_id = 101",
    )).rows[0];
    expect(Number(boardRow?.total_score)).toBeGreaterThan(824000);
    expect(Number((await exec(db, "select count(*) as cnt from snipe_events")).rows[0].cnt)).toBe(0);
    expect(String((await exec(db, "select status from user_goals where user_id = 101")).rows[0].status)).toBe("open");
    expect(Number((await exec(db, "select count(*) as cnt from jobs where type = 'refresh_user_top_scores'")).rows[0].cnt)).toBe(0);
    // No tracker news either: no SSE card in the event log, and no country
    // liveness touch that would make the ingest heartbeat look fresh.
    expect(Number((await exec(db, "select count(*) as cnt from live_event_log where type = 'tracker_score'")).rows[0].cnt)).toBe(0);
    expect((await exec(db, "select last_score_at from country_registry where country = 'CR'")).rows[0]?.last_score_at ?? null).toBeNull();
    // The manual row is the newest by rowid, but the ingest heartbeat must
    // still report the last REAL ingest, or a wedged feed would look healthy.
    expect(await getLastIngestAtMs(db)).toBe(Date.parse(realIngestAt));
  });
});

describe("parseScoreLink", () => {
  it("reads both URL shapes, bare ids and rejects other modes", () => {
    expect(parseScoreLink("https://osu.ppy.sh/scores/1234567890")).toEqual({ scoreId: 1234567890, spaces: ["solo"], explicitSpace: true });
    expect(parseScoreLink("osu.ppy.sh/scores/mania/661735936/")).toEqual({ scoreId: 661735936, spaces: ["legacy"], explicitSpace: true });
    expect(parseScoreLink("661735936")).toEqual({ scoreId: 661735936, spaces: ["legacy", "solo"], explicitSpace: false });
    expect(parseScoreLink("6800000000")).toEqual({ scoreId: 6800000000, spaces: ["solo", "legacy"], explicitSpace: false });
    expect(parseScoreLink("https://osu.ppy.sh/scores/osu/12345")).toBe("wrong_mode");
    expect(parseScoreLink("https://example.com/scores/12345")).toBeNull();
    expect(parseScoreLink("not a link")).toBeNull();
  });
});
