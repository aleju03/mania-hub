import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Config } from "../config.js";
import { handleBeatmapAudioRequest } from "../audio/http.js";
import { activateCountry, deleteCountryData, getCountryRegistry, isCountryFeatureAtLeast, setCountryFeatureTier, setCountryPaused, type CountryFeatureTier } from "../countries.js";
import type { Db } from "../db.js";
import { dbHealth, exec, parseJson } from "../db.js";
import { getDanEstimateBatch } from "../features/dan-estimates.js";
import { enqueueMapsRefresh, enqueueMapsRefreshIfDue, getMapsPageSnapshot, getMapsSnapshot, getMapsSnapshotMeta, type MapsPageQuery } from "../features/maps.js";
import { getCachedPlayerProfileSnapshot, getPlayerAbout, getPlayerProfileSnapshot, getPlayerRecentScores } from "../features/player-profiles.js";
import { getRankDeltaSnapshot } from "../features/rank-snapshots.js";
import { getSnipesSnapshot } from "../features/snipes.js";
import { getTopPlaysSnapshot } from "../features/top-plays.js";
import { getTrackerSnapshot } from "../features/tracker.js";
import { type AbuseBucket, type AbuseGuard, normalizeCountryParam, type RateLimitResult } from "./abuse-guard.js";
import type { JobQueue } from "../jobs/queue.js";
import type { CountryClientTracker } from "../live/country-clients.js";
import type { LiveEventLog } from "../live/event-log.js";
import type { OscStatus } from "../osc/client.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
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
  abuse?: AbuseGuard;
  countryClients?: CountryClientTracker;
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
  try {
    return await routeHttpUnsafe(req, res, ctx);
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(req, res, ctx, error.status, { error: error.code, message: error.message });
      return true;
    }
    throw error;
  }
}

async function routeHttpUnsafe(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const country = countryFromUrl(url, ctx);
  if (hasInvalidCountryParam(url) && routeUsesCountry(url.pathname)) {
    sendJson(req, res, ctx, 400, { error: "invalid_country" });
    return true;
  }
  if (url.pathname.startsWith("/api/") && isDisallowedOrigin(req, ctx)) {
    sendJson(req, res, ctx, 403, { error: "forbidden_origin" });
    return true;
  }
  if (req.method === "OPTIONS") {
    sendCors(req, res, ctx);
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (url.pathname === "/api/audio") {
    await handleBeatmapAudioRequest(req, res, ctx.config, url);
    return true;
  }
  if (url.pathname.startsWith("/api/") && !isAdmin(req, ctx) && !checkRate(req, res, ctx, "publicApi")) {
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
  if (url.pathname === "/api/countries/features") {
    res.setHeader("cache-control", "public, max-age=30");
    sendJson(req, res, ctx, 200, await countryFeaturesBody(ctx));
    return true;
  }
  const profileRoute = parseProfileRoute(url.pathname);
  if (profileRoute) {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (profileRoute.kind === "cached-snapshot") {
      const snapshot = await getCachedPlayerProfileSnapshot(ctx.db, profileRoute.key);
      if (!snapshot) {
        sendJson(req, res, ctx, 404, { error: "not_cached" });
        return true;
      }
      res.setHeader("cache-control", "public, max-age=15, stale-while-revalidate=60");
      sendJson(req, res, ctx, 200, snapshot);
      return true;
    }
    if (profileRoute.kind === "snapshot") {
      if (!checkRate(req, res, ctx, "publicCostly")) return true;
      sendJson(req, res, ctx, 200, await getPlayerProfileSnapshot(ctx.db, ctx.osu, profileRoute.key));
      return true;
    }
    const userId = Number(profileRoute.key);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (profileRoute.kind === "recent") {
      if (!checkRate(req, res, ctx, "publicCostly")) return true;
      sendJson(req, res, ctx, 200, await getPlayerRecentScores(ctx.db, ctx.osu, userId));
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    sendJson(req, res, ctx, 200, await getPlayerAbout(ctx.db, ctx.osu, userId));
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
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const activated = await activatePublicCountry(req, res, ctx, country);
    if (!activated) return true;
    sendJson(req, res, ctx, 200, {
      ok: true,
      country: activated,
      // Cold country: no roster projection yet, so every country surface is empty until warmup runs.
      warming: activated.lastRosterRefreshAt == null,
      // Feature tier caps what the backend does for this country (snipes is the gated one).
      featureTier: activated.featureTier,
    });
    return true;
  }
  if (url.pathname === "/api/snapshots/tracker") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getTrackerSnapshot(ctx.db, country, clampLimit(url.searchParams.get("limit"), 100, 500)));
    return true;
  }
  if (url.pathname === "/api/snapshots/top-plays") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getTopPlaysSnapshot(ctx.db, country, url.searchParams.get("window") ?? "7d"));
    return true;
  }
  if (url.pathname === "/api/snapshots/snipes") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getSnipesSnapshot(ctx.db, country, clampLimit(url.searchParams.get("limit"), 500, 1000)));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-page") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    await handleMapsPageSnapshot(req, res, ctx, country, parseMapsPageQuery(url.searchParams));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    const section = url.searchParams.get("section") === "random" ? "random" : "core";
    await handleMapsSnapshot(req, res, ctx, country, section);
    return true;
  }
  if (url.pathname === "/api/snapshots/rank-deltas") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getRankDeltaSnapshot(ctx.db, country, parseUserIds(url.searchParams.get("userIds"))));
    return true;
  }
  if (url.pathname === "/api/dan-estimates") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    if (!checkRate(req, res, ctx, "danEstimate")) return true;
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const items = Array.isArray(body.items) ? body.items : [];
    sendJson(req, res, ctx, 200, await getDanEstimateBatch(ctx.db, ctx.queue, ctx.osu, items, {
      computeMissing: body.computeMissing !== false,
    }));
    return true;
  }
  if (url.pathname === "/api/osu/v2") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const path = normalizeOsuApiPath(body.path, body.params);
    const caller = normalizeCaller(body.caller);
    try {
      if (body.kind === "binary") {
        const buffer = Buffer.from(await ctx.osu.getBinary(path, caller));
        sendCors(req, res, ctx);
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.end(buffer);
        return true;
      }
      sendJson(req, res, ctx, 200, await ctx.osu.getJson(path, caller));
    } catch (error) {
      sendOsuError(req, res, ctx, error);
    }
    return true;
  }
  if (url.pathname === "/api/osu/beatmap-file") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const beatmapId = Number(url.searchParams.get("beatmapId"));
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap_id" });
      return true;
    }
    try {
      const content = await ctx.osu.getBeatmapFile(Math.floor(beatmapId), normalizeCaller(url.searchParams.get("caller")));
      sendCors(req, res, ctx);
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(content);
    } catch (error) {
      sendOsuError(req, res, ctx, error);
    }
    return true;
  }
  if (url.pathname === "/api/events") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    const since = Number(url.searchParams.get("since") ?? 0);
    sendJson(req, res, ctx, 200, { events: await ctx.events.replay(country, Number.isFinite(since) ? since : 0, 500) });
    return true;
  }
  if (url.pathname === "/api/replay-video-job") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!ctx.config.replayVideoPublicEnabled && !isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!isAdmin(req, ctx) && !checkRate(req, res, ctx, "replayVideo")) return true;
    if (!isAdmin(req, ctx) && !checkRate(req, res, ctx, "publicCostly")) return true;
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
      const buffer = await readBodyBuffer(req, ctx.config.replayVideoUploadMaxBytes);
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
  if (url.pathname === "/api/admin/pause-country" || url.pathname === "/api/admin/resume-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const paused = url.pathname === "/api/admin/pause-country";
    sendJson(req, res, ctx, 200, { ok: true, country: await setCountryPaused(ctx.db, ctx.config, country, paused) });
    return true;
  }
  if (url.pathname === "/api/admin/set-country-tier") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const tier = parseCountryFeatureTierParam(url.searchParams.get("tier"));
    if (!tier) {
      sendJson(req, res, ctx, 400, { error: "invalid_tier" });
      return true;
    }
    const updated = await setCountryFeatureTier(ctx.db, ctx.config, country, tier);
    await enqueueRosterRefreshes(ctx.queue, [updated.country]);
    if (isCountryFeatureAtLeast(updated.featureTier, "maps_warm")) {
      await enqueueMapsRefreshIfDue(ctx.db, ctx.queue, updated.country, ctx.config.mapsRefreshIntervalMs, { priority: 90 });
    }
    sendJson(req, res, ctx, 200, { ok: true, country: updated });
    return true;
  }
  if (url.pathname === "/api/admin/delete-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, country, deleted: await deleteCountryData(ctx.db, country) });
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
      "dan_estimates",
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
    abuse: ctx.abuse?.state() ?? null,
    apiCallHistory: await apiCallHistory(ctx.db),
    countries: await countryRegistryStatus(ctx),
    worker: options.includeWorkerActivity ? worker : publicWorkerStatus(worker),
  };
}

async function countryFeaturesBody(ctx: HttpContext) {
  const countries = await getCountryRegistry(ctx.db, ctx.config);
  return {
    generatedAt: new Date().toISOString(),
    countries: countries.map((entry) => ({
      country: entry.country,
      featureTier: entry.featureTier,
    })),
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

async function countryRegistryStatus(ctx: HttpContext) {
  const countries = await getCountryRegistry(ctx.db, ctx.config);
  const clients = new Map((ctx.countryClients?.snapshot() ?? []).map((entry) => [entry.country, entry]));
  return countries.map((entry) => {
    const client = clients.get(entry.country);
    return {
      ...entry,
      activeUsers: client?.activeUsers ?? 0,
      lastActiveAt: client?.lastActiveAt ?? entry.lastRequestedAt,
    };
  });
}

async function apiCallHistory(db: Db) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const [byCaller, byPath] = await Promise.all([
    exec(
      db,
      `select coalesce(t.caller, l.caller) as caller, count(*) as count
       from api_call_log l
       left join api_call_targets t on t.id = l.target_id
       where l.provider = 'osu' and l.started_at >= ?
       group by coalesce(t.caller, l.caller)
       order by count desc
       limit 20`,
      [since],
    ),
    exec(
      db,
      `select coalesce(t.path, l.path) as path, count(*) as count
       from api_call_log l
       left join api_call_targets t on t.id = l.target_id
       where l.provider = 'osu' and l.started_at >= ?
       group by coalesce(t.path, l.path)
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

export async function activatePublicCountry(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  country: string,
): Promise<Awaited<ReturnType<typeof activateCountry>> | null> {
  const registered = await isCountryRegistered(ctx.db, country);
  if (!isAdmin(req, ctx) && ctx.abuse && !registered) {
    const minute = ctx.abuse.check(req, ctx.config, "countryActivate");
    if (!minute.allowed) {
      sendRateLimited(req, res, ctx, minute);
      return null;
    }
    const hourly = ctx.abuse.check(req, ctx.config, "countryActivateNew");
    if (!hourly.allowed) {
      sendRateLimited(req, res, ctx, hourly);
      return null;
    }
    const global = ctx.abuse.checkGlobal(ctx.config, "countryActivateGlobal");
    if (!global.allowed) {
      sendRateLimited(req, res, ctx, global);
      return null;
    }
  }
  const activated = await activateCountry(ctx.db, ctx.queue, ctx.config, country);
  if (isCountryFeatureAtLeast(activated.featureTier, "maps_warm")) {
    await enqueueMapsRefreshIfDue(ctx.db, ctx.queue, activated.country, ctx.config.mapsRefreshIntervalMs, { priority: 15 });
  }
  return activated;
}

async function isCountryRegistered(db: Db, country: string): Promise<boolean> {
  const row = (await exec(db, "select 1 from country_registry where country = ? limit 1", [country])).rows[0];
  return !!row;
}

function checkRate(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, bucket: AbuseBucket): boolean {
  if (!ctx.abuse || isAdmin(req, ctx)) return true;
  const result = ctx.abuse.check(req, ctx.config, bucket);
  if (result.allowed) return true;
  sendRateLimited(req, res, ctx, result);
  return false;
}

export function sendRateLimited(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">, result: Exclude<RateLimitResult, { allowed: true }>): void {
  res.setHeader("retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
  sendJson(req, res, ctx, 429, {
    error: "rate_limited",
    bucket: result.bucket,
    limit: result.limit,
    retryAfterMs: result.retryAfterMs,
  });
}

function countryFromUrl(url: URL, ctx: HttpContext): string {
  return normalizeCountryParam(url.searchParams.get("country"))
    ?? normalizeCountryParam(ctx.config.trackedCountries?.[0])
    ?? "CR";
}

function hasInvalidCountryParam(url: URL): boolean {
  const raw = url.searchParams.get("country");
  return raw != null && !normalizeCountryParam(raw);
}

function routeUsesCountry(pathname: string): boolean {
  return pathname === "/api/countries/activate"
    || pathname === "/api/events"
    || pathname.startsWith("/api/snapshots/")
    || pathname === "/api/admin/refresh-roster"
    || pathname === "/api/admin/refresh-maps"
    || pathname === "/api/admin/set-country-tier";
}

function parseCountryFeatureTierParam(value: string | null): CountryFeatureTier | null {
  return value === "indexed" || value === "maps_warm" || value === "live" || value === "snipes"
    ? value
    : null;
}

function isDisallowedOrigin(req: IncomingMessage, ctx: Pick<HttpContext, "config">): boolean {
  const origin = req.headers.origin;
  return !!origin && !ctx.config.allowedOrigins.includes("*") && !ctx.config.allowedOrigins.includes(origin);
}

// Below this size compression costs more than it saves (sub-MTU payloads).
const COMPRESSIBLE_MIN_BYTES = 1400;

export function sendJson(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">, status: number, body: unknown): void {
  sendCors(req, res, ctx);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  const json = Buffer.from(JSON.stringify(body), "utf8");
  if (json.length < COMPRESSIBLE_MIN_BYTES) {
    res.end(json);
    return;
  }

  appendVary(res, "accept-encoding");
  const encoding = negotiateEncoding(req);
  if (!encoding) {
    res.end(json);
    return;
  }

  const finish = (error: Error | null, compressed: Buffer): void => {
    if (res.writableEnded || res.destroyed) return;
    try {
      if (error) {
        res.end(json);
      } else {
        res.setHeader("content-encoding", encoding);
        res.end(compressed);
      }
    } catch {
      // Connection torn down mid-flight; nothing left to send.
    }
  };
  if (encoding === "br") {
    brotliCompress(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }, finish);
  } else {
    gzip(json, { level: 6 }, finish);
  }
}

// A JSON response that has already been serialized (and possibly compressed),
// so it can be stored and replayed without redoing that work.
interface PreparedJsonResponse {
  status: number;
  encoding: "br" | "gzip" | null;
  vary: boolean;
  body: Buffer;
}

function compressJsonBuffer(encoding: "br" | "gzip", json: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const finish = (error: Error | null, compressed: Buffer): void => {
      resolve(error ? null : compressed);
    };
    if (encoding === "br") {
      brotliCompress(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }, finish);
    } else {
      gzip(json, { level: 6 }, finish);
    }
  });
}

async function prepareJsonResponse(
  status: number,
  body: unknown,
  encoding: "br" | "gzip" | null,
): Promise<PreparedJsonResponse> {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  if (json.length < COMPRESSIBLE_MIN_BYTES) {
    return { status, encoding: null, vary: false, body: json };
  }
  if (!encoding) {
    return { status, encoding: null, vary: true, body: json };
  }
  const compressed = await compressJsonBuffer(encoding, json);
  return compressed
    ? { status, encoding, vary: true, body: compressed }
    : { status, encoding: null, vary: true, body: json };
}

function writePreparedJson(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Pick<HttpContext, "config">,
  prepared: PreparedJsonResponse,
): void {
  sendCors(req, res, ctx);
  res.statusCode = prepared.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (prepared.vary) appendVary(res, "accept-encoding");
  if (prepared.encoding) res.setHeader("content-encoding", prepared.encoding);
  res.end(prepared.body);
}

// /api/snapshots/maps serves a multi-MB payload (a whole country roster's
// farmed + favourite maps). The stored snapshot only changes when the weekly
// maps refresh job rewrites the row, yet every visit otherwise re-parses,
// re-slices and re-compresses it from scratch. We cache the finished
// (already-compressed) response body keyed on the row's refreshed_at: that key
// IS the real cache lifetime — it stays valid until the next rebuild, then
// changes on its own, so a populated snapshot is effectively cached for the
// whole week between refreshes regardless of traffic. The TTL is just a
// periodic re-check so the volatile isStale / refreshQueued flags in the body
// can't stay wrong indefinitely if a rebuild stalls; the weekly refresh is
// enqueued on the activatePublicCountry path, independent of this cache.
const MAPS_RESPONSE_CACHE_TTL_MS = 60 * 60_000;
const MAPS_RESPONSE_CACHE_MAX_ENTRIES = 32;
const MAPS_PAGE_RESPONSE_CACHE_TTL_MS = 10 * 60_000;
const MAPS_PAGE_RESPONSE_CACHE_MAX_ENTRIES = 128;

interface MapsResponseCacheEntry extends PreparedJsonResponse {
  storedAt: number;
}

const mapsResponseCache = new Map<string, MapsResponseCacheEntry>();
const mapsPageResponseCache = new Map<string, MapsResponseCacheEntry>();

function pruneMapsResponseCache(now: number): void {
  for (const [key, entry] of mapsResponseCache) {
    if (now - entry.storedAt > MAPS_RESPONSE_CACHE_TTL_MS) mapsResponseCache.delete(key);
  }
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (mapsResponseCache.size > MAPS_RESPONSE_CACHE_MAX_ENTRIES) {
    const oldest = mapsResponseCache.keys().next().value;
    if (oldest === undefined) break;
    mapsResponseCache.delete(oldest);
  }
}

function pruneMapsPageResponseCache(now: number): void {
  for (const [key, entry] of mapsPageResponseCache) {
    if (now - entry.storedAt > MAPS_PAGE_RESPONSE_CACHE_TTL_MS) mapsPageResponseCache.delete(key);
  }
  while (mapsPageResponseCache.size > MAPS_PAGE_RESPONSE_CACHE_MAX_ENTRIES) {
    const oldest = mapsPageResponseCache.keys().next().value;
    if (oldest === undefined) break;
    mapsPageResponseCache.delete(oldest);
  }
}

function parseMapsPageQuery(params: URLSearchParams): MapsPageQuery {
  const rawTab = params.get("tab");
  const tab = rawTab === "popular" || rawTab === "favourites" ? rawTab : "farmed";
  const rawKey = params.get("key");
  const key = rawKey === "4k" || rawKey === "7k" || rawKey === "other" ? rawKey : "all";
  const rawBeatmapSort = params.get("beatmapSort");
  const beatmapSort =
    rawBeatmapSort === "plays" ||
    rawBeatmapSort === "stars" ||
    rawBeatmapSort === "length"
      ? rawBeatmapSort
      : "players";
  const rawFarmedSort = params.get("farmedSort");
  const farmedSort =
    rawFarmedSort === "avg-pp" ||
    rawFarmedSort === "max-pp" ||
    rawFarmedSort === "stars" ||
    rawFarmedSort === "recent"
      ? rawFarmedSort
      : "players";
  const rawDir = params.get("dir");
  const dir = rawDir === "asc" ? "asc" : "desc";
  const rawStatus = params.get("status");
  const status = rawStatus === "ranked" || rawStatus === "loved" || rawStatus === "graveyard" || rawStatus === "other"
    ? rawStatus
    : "all";
  const rawMod = params.get("mod");
  const mod = rawMod === "dt" || rawMod === "ht" || rawMod === "nm" ? rawMod : "all";
  const page = clampInteger(params.get("page"), 0, 10_000, 0);
  const pageSize = clampInteger(params.get("pageSize"), 1, 48, 24);
  const rawPp = Number(params.get("pp") ?? 0);
  const pp = Number.isFinite(rawPp) && rawPp > 0
    ? Math.round(Math.min(Math.max(rawPp, 200), 1000) / 25) * 25
    : 0;

  return {
    tab,
    page,
    pageSize,
    key,
    beatmapSort,
    farmedSort,
    dir,
    status,
    pp,
    mod,
    q: (params.get("q") ?? "").trim().slice(0, 120),
  };
}

async function handleMapsPageSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  country: string,
  query: MapsPageQuery,
): Promise<void> {
  const now = Date.now();
  pruneMapsPageResponseCache(now);

  const meta = await getMapsSnapshotMeta(ctx.db, country);
  const farmedOverlayKey = query.tab === "farmed" ? meta.farmedOverlayUpdatedAt ?? "" : "";
  const cacheKey = meta.refreshedAt
    ? [
        country.toUpperCase(),
        query.tab,
        query.page,
        query.pageSize,
        query.key,
        query.beatmapSort,
        query.farmedSort,
        query.dir,
        query.status,
        query.pp,
        query.mod,
        query.q,
        meta.refreshedAt,
        farmedOverlayKey,
      ].join("|")
    : null;

  if (cacheKey) {
    const cached = mapsPageResponseCache.get(cacheKey);
    if (cached && now - cached.storedAt <= MAPS_PAGE_RESPONSE_CACHE_TTL_MS) {
      writePreparedJson(req, res, ctx, cached);
      return;
    }
  }

  const snapshot = await getMapsPageSnapshot(ctx.db, ctx.queue, country, ctx.config.mapsRefreshIntervalMs, query);
  const status = snapshot.value ? 200 : 202;
  const prepared = prepareIdentityJsonResponse(status, snapshot);
  writePreparedJson(req, res, ctx, prepared);

  if (cacheKey && status === 200 && snapshot.value) {
    mapsPageResponseCache.set(cacheKey, { ...prepared, storedAt: now });
  }
}

function prepareIdentityJsonResponse(status: number, body: unknown): PreparedJsonResponse {
  return {
    status,
    encoding: null,
    vary: false,
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

async function handleMapsSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  country: string,
  section: "core" | "random",
): Promise<void> {
  const now = Date.now();
  pruneMapsResponseCache(now);

  const encoding = negotiateEncoding(req);
  // Cheap timestamp-only read first: a cache hit must avoid getMapsSnapshot(),
  // which is itself the expensive payload_json parse/hydrate/slice path.
  const meta = await getMapsSnapshotMeta(ctx.db, country);
  const farmedOverlayKey = section === "core" ? meta.farmedOverlayUpdatedAt ?? "" : "";
  const cacheKey = meta.refreshedAt
    ? `${country.toUpperCase()}|${section}|${encoding ?? "identity"}|${meta.refreshedAt}|${farmedOverlayKey}`
    : null;

  if (cacheKey) {
    const cached = mapsResponseCache.get(cacheKey);
    if (cached && now - cached.storedAt <= MAPS_RESPONSE_CACHE_TTL_MS) {
      writePreparedJson(req, res, ctx, cached);
      return;
    }
  }

  const snapshot = await getMapsSnapshot(ctx.db, ctx.queue, country, ctx.config.mapsRefreshIntervalMs, section);
  const status = snapshot.value ? 200 : 202;
  const prepared = await prepareJsonResponse(status, snapshot, encoding);
  writePreparedJson(req, res, ctx, prepared);

  // Only cache populated 200s — never the cold "still building" 202/null state,
  // whose body changes the moment the first real snapshot lands.
  if (cacheKey && status === 200 && snapshot.value) {
    mapsResponseCache.set(cacheKey, { ...prepared, storedAt: now });
  }
}

function negotiateEncoding(req: IncomingMessage): "br" | "gzip" | null {
  const raw = req.headers["accept-encoding"];
  const accepted = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  let brQ = 0;
  let gzipQ = 0;
  for (const item of accepted.split(",")) {
    const [namePart, ...params] = item.trim().split(";");
    const name = namePart.trim().toLowerCase();
    if (name !== "br" && name !== "gzip") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) q = parsed;
    }
    if (name === "br") brQ = Math.max(brQ, q);
    if (name === "gzip") gzipQ = Math.max(gzipQ, q);
  }
  if (brQ <= 0 && gzipQ <= 0) return null;
  if (brQ >= gzipQ) return "br";
  if (gzipQ > 0) return "gzip";
  return null;
}

function appendVary(res: ServerResponse, field: string): void {
  const existing = res.getHeader("vary");
  if (existing == null) {
    res.setHeader("vary", field);
    return;
  }
  const current = String(existing);
  if (current.toLowerCase().split(/\s*,\s*/).includes(field.toLowerCase())) return;
  res.setHeader("vary", `${current}, ${field}`);
}

function sendCors(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">): void {
  const origin = req.headers.origin;
  if (origin && (ctx.config.allowedOrigins.includes("*") || ctx.config.allowedOrigins.includes(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization,range");
    res.setHeader(
      "access-control-expose-headers",
      "accept-ranges,content-length,content-range,content-type,x-audio-mp3-in-mp4,x-audio-size-bytes",
    );
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

function clampInteger(raw: string | null, min: number, max: number, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function parseUserIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 100);
}

function parseProfileRoute(pathname: string): { kind: "cached-snapshot" | "snapshot" | "recent" | "about"; key: string } | null {
  const match = /^\/api\/profiles\/([^/]+)\/(cached-snapshot|snapshot|recent|about)$/.exec(pathname);
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return {
    key,
    kind: match[2] as "cached-snapshot" | "snapshot" | "recent" | "about",
  };
}

function normalizeOsuApiPath(rawPath: unknown, rawParams: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length > 500 || !rawPath.startsWith("/")) {
    throw new Error("Invalid osu! API path.");
  }
  const url = new URL(rawPath, "https://osu.ppy.sh");
  if (url.origin !== "https://osu.ppy.sh" || url.pathname.startsWith("/oauth/")) {
    throw new Error("Invalid osu! API path.");
  }
  if (rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)) {
    for (const [key, value] of Object.entries(rawParams)) {
      if (value === undefined || value === null) continue;
      if (!/^[A-Za-z0-9_[\]-]+$/.test(key)) throw new Error("Invalid osu! API param.");
      if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("Invalid osu! API param.");
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

function normalizeCaller(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "frontend";
  return raw.trim().replace(/[^\w:.-]/g, "_").slice(0, 120);
}

function sendOsuError(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, error: unknown): void {
  if (error instanceof OsuApiError) {
    sendJson(req, res, ctx, error.status, {
      error: "osu_api_error",
      status: error.status,
      path: error.path,
      retryAfterMs: error.retryAfterMs,
    });
    return;
  }
  sendJson(req, res, ctx, 502, { error: error instanceof Error ? error.message : String(error) });
}

function isAdmin(req: IncomingMessage, ctx: HttpContext): boolean {
  if (!ctx.config.liveAdminToken) return ctx.config.nodeEnv !== "production";
  return req.headers.authorization === `Bearer ${ctx.config.liveAdminToken}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString("utf8");
}

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

class HttpRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function readBodyBuffer(req: IncomingMessage, limitBytes = DEFAULT_BODY_LIMIT_BYTES): Promise<Buffer> {
  const limit = Math.max(1, Math.floor(limitBytes));
  const rawLength = Array.isArray(req.headers["content-length"]) ? req.headers["content-length"][0] : req.headers["content-length"];
  if (rawLength != null) {
    const length = Number(rawLength);
    if (!Number.isFinite(length) || length < 0) {
      throw new HttpRequestError(400, "invalid_content_length", "Invalid Content-Length header.");
    }
    if (length > limit) {
      throw new HttpRequestError(413, "payload_too_large", "Request body is too large.");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw new HttpRequestError(413, "payload_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}
