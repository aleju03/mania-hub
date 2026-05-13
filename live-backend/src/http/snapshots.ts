import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { activateCountry, getCountryRegistry } from "../countries.js";
import type { Db } from "../db.js";
import { dbHealth, exec, parseJson } from "../db.js";
import { enqueueMapsRefresh, getMapsSnapshot } from "../features/maps.js";
import { getSnipesSnapshot } from "../features/snipes.js";
import { getTopPlaysSnapshot } from "../features/top-plays.js";
import { getTrackerSnapshot } from "../features/tracker.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveEventLog } from "../live/event-log.js";
import type { OscStatus } from "../osc/client.js";
import type { OsuApiClient } from "../osu/client.js";
import { enqueueOscBackfill } from "../osc/backfill.js";
import {
  cancelReplayVideoExport,
  createReplayVideoExport,
  createServerReplayVideoExport,
  getRecentReplayVideoExport,
  getReplayVideoExport,
  markReplayVideoQueued,
  replayVideoExportResponse,
  writeReplayVideoUpload,
} from "../replay-video/exports.js";
import { isReplayVideoStorageConfigured } from "../replay-video/r2.js";
import { enqueueRosterRefreshes } from "../rosters/country-rosters.js";
import { getLocalDbStorage, runRetention } from "../retention.js";

export interface HttpContext {
  db: Db;
  queue: JobQueue;
  events: LiveEventLog;
  config: Config;
  osu: OsuApiClient;
  oscStatus: () => OscStatus;
  workerStatus?: () => {
    paused: boolean;
    stopped: boolean;
    workerId: string;
    lanes?: Array<{
      name: string;
      claimLimit: number;
      intervalMs: number;
      jobTypes: string[] | null;
      activeJobs: Array<{
        id: number;
        type: string;
        dedupeKey: string;
        attempts: number;
        startedAt: string;
        payload: unknown;
      }>;
    }>;
  };
  pauseWorkers?: () => void;
  resumeWorkers?: () => void;
}

export async function routeHttp(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const country = (url.searchParams.get("country") ?? ctx.config.trackedCountries[0] ?? "CR").toUpperCase();
  if (req.method === "OPTIONS") {
    sendCors(req, res, ctx);
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (url.pathname === "/healthz") {
    sendJson(req, res, ctx, 200, await statusBody(ctx));
    return true;
  }
  if (url.pathname === "/readyz") {
    const ok = await dbHealth(ctx.db);
    sendJson(req, res, ctx, ok ? 200 : 503, await statusBody(ctx));
    return true;
  }
  if (url.pathname === "/api/status") {
    sendJson(req, res, ctx, 200, await statusBody(ctx));
    return true;
  }
  if (url.pathname === "/api/admin/status") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, await statusBody(ctx, { includeWorkerActivity: true }));
    return true;
  }
  if (url.pathname === "/api/countries/activate") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, country: await activateCountry(ctx.db, ctx.queue, ctx.config, country) });
    return true;
  }
  if (url.pathname === "/api/snapshots/tracker") {
    await activateCountry(ctx.db, ctx.queue, ctx.config, country);
    sendJson(req, res, ctx, 200, await getTrackerSnapshot(ctx.db, country, clampLimit(url.searchParams.get("limit"), 100, 500)));
    return true;
  }
  if (url.pathname === "/api/snapshots/top-plays") {
    await activateCountry(ctx.db, ctx.queue, ctx.config, country);
    sendJson(req, res, ctx, 200, await getTopPlaysSnapshot(ctx.db, country, url.searchParams.get("window") ?? "7d"));
    return true;
  }
  if (url.pathname === "/api/snapshots/snipes") {
    await activateCountry(ctx.db, ctx.queue, ctx.config, country);
    sendJson(req, res, ctx, 200, await getSnipesSnapshot(ctx.db, country, clampLimit(url.searchParams.get("limit"), 500, 1000)));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps") {
    await activateCountry(ctx.db, ctx.queue, ctx.config, country);
    const snapshot = await getMapsSnapshot(ctx.db, ctx.queue, country, ctx.config.mapsRefreshIntervalMs);
    sendJson(req, res, ctx, snapshot.value ? 200 : 202, snapshot);
    return true;
  }
  if (url.pathname === "/api/events") {
    await activateCountry(ctx.db, ctx.queue, ctx.config, country);
    const since = Number(url.searchParams.get("since") ?? 0);
    sendJson(req, res, ctx, 200, { events: await ctx.events.replay(country, Number.isFinite(since) ? since : 0, 500) });
    return true;
  }
  if (url.pathname === "/api/replay-video-job") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!isReplayVideoStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "R2 is not configured for replay video uploads." });
      return true;
    }
    const action = url.searchParams.get("action");
    if (action === "start") {
      const job = await createReplayVideoExport(ctx.db, ctx.config, parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {}));
      sendJson(req, res, ctx, 200, { id: job.id });
      return true;
    }
    if (action === "server-render") {
      const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
      const job = await createServerReplayVideoExport(ctx.db, ctx.config, body);
      await ctx.queue.enqueue("replay_video_server_render", `replay-video-server:${job.id}`, { id: job.id, request: body }, { priority: 85 });
      sendJson(req, res, ctx, 202, replayVideoExportResponse(job));
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    if (action === "status") {
      const job = await getReplayVideoExport(ctx.db, id);
      sendJson(req, res, ctx, job ? 200 : 404, job ? replayVideoExportResponse(job) : { error: "Unknown replay video job." });
      return true;
    }
    if (action === "recent") {
      const scoreId = Number(url.searchParams.get("scoreId"));
      if (!Number.isFinite(scoreId) || scoreId <= 0) {
        sendJson(req, res, ctx, 400, { error: "Invalid scoreId." });
        return true;
      }
      const job = await getRecentReplayVideoExport(ctx.db, Math.floor(scoreId));
      sendJson(req, res, ctx, 200, job ? replayVideoExportResponse(job) : { url: null });
      return true;
    }
    if (action === "upload-video") {
      const buffer = await readBodyBuffer(req);
      const job = await writeReplayVideoUpload(ctx.db, ctx.config, id, buffer);
      sendJson(req, res, ctx, 200, replayVideoExportResponse(job));
      return true;
    }
    if (action === "finish") {
      const job = await markReplayVideoQueued(ctx.db, id);
      await ctx.queue.enqueue("replay_video_export", `replay-video:${id}`, { id }, { priority: 80 });
      sendJson(req, res, ctx, 202, replayVideoExportResponse(job));
      return true;
    }
    if (action === "cancel") {
      await cancelReplayVideoExport(ctx.db, ctx.config, id);
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    sendJson(req, res, ctx, 400, { error: "Unknown replay video job action." });
    return true;
  }
  if (url.pathname === "/api/admin/ingest-fixture") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const rows = parseJson<unknown[]>((await readBody(req)) || "[]", []);
    const { ScoreIngestor } = await import("../ingest/score-ingestor.js");
    const ingestor = new ScoreIngestor(ctx.db, ctx.queue, ctx.events, ctx.config);
    sendJson(req, res, ctx, 200, await ingestor.ingestBatch(rows as never[], "admin_fixture"));
    return true;
  }
  if (url.pathname === "/api/admin/refresh-roster") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    await enqueueRosterRefreshes(ctx.queue, [country]);
    sendJson(req, res, ctx, 200, { ok: true, country });
    return true;
  }
  if (url.pathname === "/api/admin/refresh-maps") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    await enqueueMapsRefresh(ctx.queue, country, { priority: 90, replaceDone: true });
    sendJson(req, res, ctx, 200, { ok: true, country });
    return true;
  }
  if (url.pathname === "/api/admin/clear-failed-jobs") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const type = url.searchParams.get("type") ?? undefined;
    sendJson(req, res, ctx, 200, { ok: true, deleted: await ctx.queue.clearFailed(type) });
    return true;
  }
  if (url.pathname === "/api/admin/pause-workers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    ctx.pauseWorkers?.();
    sendJson(req, res, ctx, 200, { ok: true, worker: ctx.workerStatus?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/admin/resume-workers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    ctx.resumeWorkers?.();
    sendJson(req, res, ctx, 200, { ok: true, worker: ctx.workerStatus?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/admin/run-retention") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, deleted: await runRetention(ctx.db, ctx.config) });
    return true;
  }
  if (url.pathname === "/api/admin/osc-smoke") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const smokeUrl = new URL("/api/scores", ctx.config.oscBaseUrl);
    smokeUrl.searchParams.set("mode", "mania");
    smokeUrl.searchParams.set("limit", "10");
    const response = await fetch(smokeUrl);
    if (!response.ok) throw new Error(`oSC smoke failed (${response.status})`);
    const body = await response.json() as { scores?: Array<{ ruleset_id?: number }> } | Array<{ ruleset_id?: number }>;
    const scores = Array.isArray(body) ? body : body.scores ?? [];
    sendJson(req, res, ctx, 200, {
      ok: true,
      count: scores.length,
      maniaCount: scores.filter((score) => score.ruleset_id === 3 || score.ruleset_id == null).length,
    });
    return true;
  }
  if (url.pathname === "/api/admin/run-osc-backfill") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    await enqueueOscBackfill(ctx.queue, ctx.db, ctx.config);
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/reset-local-db") {
    if (ctx.config.nodeEnv === "production") {
      sendJson(req, res, ctx, 403, { error: "disabled_in_production" });
      return true;
    }
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const tables = [
      "jobs",
      "score_events",
      "country_beatmap_scores",
      "user_top_scores",
      "top_play_events",
      "snipe_events",
      "country_maps_snapshots",
      "replay_video_exports",
      "live_event_log",
      "api_call_log",
      "live_meta",
      "country_rosters",
      "users",
      "beatmaps",
      "beatmapsets",
    ];
    const deleted: Record<string, number> = {};
    for (const table of tables) {
      deleted[table] = Number((await exec(ctx.db, `delete from ${table}`)).rowsAffected ?? 0);
    }
    sendJson(req, res, ctx, 200, { ok: true, deleted });
    return true;
  }
  return false;
}

async function statusBody(ctx: HttpContext, options: { includeWorkerActivity?: boolean } = {}) {
  const db = await dbHealth(ctx.db);
  const last = (await exec(ctx.db, "select max(created_at) as created_at from live_event_log")).rows[0]?.created_at ?? null;
  const worker = ctx.workerStatus?.() ?? null;
  return {
    ok: db,
    db,
    storage: await getLocalDbStorage(ctx.config),
    osc: ctx.oscStatus(),
    lastEventAt: last,
    queueDepth: await ctx.queue.depth(),
    queueSummary: await ctx.queue.summary(),
    roster: await rosterSummary(ctx.db),
    rate: ctx.osu.limiter.state(),
    apiCallHistory: await apiCallHistory(ctx.db),
    countries: await getCountryRegistry(ctx.db, ctx.config),
    worker: options.includeWorkerActivity ? worker : publicWorkerStatus(worker),
  };
}

function publicWorkerStatus(worker: ReturnType<NonNullable<HttpContext["workerStatus"]>> | null) {
  if (!worker) return null;
  return {
    paused: worker.paused,
    stopped: worker.stopped,
    workerId: worker.workerId,
    lanes: worker.lanes?.map((lane) => ({
      name: lane.name,
      claimLimit: lane.claimLimit,
      intervalMs: lane.intervalMs,
      jobTypes: lane.jobTypes,
      activeJobCount: lane.activeJobs.length,
    })),
  };
}

async function rosterSummary(db: Db) {
  const rows = (await exec(
    db,
    `select country, count(*) as users, max(refreshed_at) as refreshed_at
     from country_rosters
     where is_tracked = 1
     group by country
     order by country asc`,
  )).rows;
  return rows.map((row) => ({
    country: String(row.country),
    users: Number(row.users),
    refreshedAt: row.refreshed_at == null ? null : String(row.refreshed_at),
  }));
}

async function apiCallHistory(db: Db) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const [byCaller, byPath] = await Promise.all([
    exec(
      db,
      `select caller, count(*) as count
       from api_call_log
       where provider = 'osu' and started_at >= ?
       group by caller
       order by count desc
       limit 20`,
      [since],
    ),
    exec(
      db,
      `select path, count(*) as count
       from api_call_log
       where provider = 'osu' and started_at >= ?
       group by path
       order by count desc
       limit 20`,
      [since],
    ),
  ]);
  return {
    windowMinutes: 15,
    byCaller: byCaller.rows.map((row) => ({ caller: String(row.caller), count: Number(row.count) })),
    byPath: byPath.rows.map((row) => ({ path: String(row.path), count: Number(row.count) })),
  };
}

export function sendJson(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">, status: number, body: unknown): void {
  sendCors(req, res, ctx);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendCors(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">): void {
  const origin = req.headers.origin;
  if (origin && ctx.config.allowedOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization");
    res.setHeader("access-control-max-age", "600");
  }
}

export function sendNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "not_found" }));
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}

function isAdmin(req: IncomingMessage, ctx: HttpContext): boolean {
  if (!ctx.config.liveAdminToken) return ctx.config.nodeEnv !== "production";
  return req.headers.authorization === `Bearer ${ctx.config.liveAdminToken}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString("utf8");
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
