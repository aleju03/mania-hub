import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Config } from "../config.js";
import { handleBeatmapAudioRequest } from "../audio/http.js";
import { activateCountry, deleteCountryData, getCountryRegistry, GLOBAL_COUNTRY_CODE, isCountryFeatureAtLeast, isGlobalCountry, setCountryFeatureTier, setCountryPaused, setCountryStatus, type CountryFeatureTier, type CountryRegistryStatus } from "../countries.js";
import type { Db } from "../db.js";
import { dbHealth, exec, getSqliteBusyRetryStats, parseJson } from "../db.js";
import { getPlayerActivityAvailability, getPlayerActivityDayDetail, getPlayerActivitySnapshot } from "../features/activity.js";
import { getDanEstimateBatch } from "../features/dan-estimates.js";
import { GOAL_KINDS, GOAL_MAP_KINDS, GOAL_TARGET_GRADES, createUserGoal, deleteUserGoal, getUserGoal, listUserGoalsWithProgress, reconcileGoalsForUser, type GoalKind, type UserGoalInput } from "../features/goals.js";
import { getMyDataSummary, getUserTopPlaysFeed, getUserTrackedFeed } from "../features/my-data.js";
import { FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperSnapshot, type FarmHelperKeyMode, type FarmHelperView } from "../features/farm-helper.js";
import type { ScoreSpeedBucket } from "../shared/score.js";
import { enqueueGlobalRankingStatRepairs, getCountryRankingsSnapshot, getGlobalRankingsSnapshot, type GlobalRankingsSort } from "../features/global-rankings.js";
import { enqueueGlobalMapsRefreshIfDue, enqueueMapsRefresh, enqueueMapsRefreshIfDue, getMapsPageSnapshot, getMapsPlayersSnapshot, getMapsRandomBeatmapsets, getMapsRefreshProgress, getMapsSnapshot, getMapsSnapshotMeta, MAPS_PLAYERS_MAX_PAGE_SIZE, type MapsPageQuery, type MapsPlayersKind, type MapsPlayersPageQuery } from "../features/maps.js";
import { getPackWallet, listPackCollectionCards, recyclePackCollectionCards, savePackWallet } from "../features/pack-wallets.js";
import { getCachedPlayerProfileSnapshot, getPlayerAbout, getPlayerProfileSnapshot, getPlayerRecentScores, warmProfileSnapshots } from "../features/player-profiles.js";
import { getRankDeltaSnapshot } from "../features/rank-snapshots.js";
import { getSnipesSnapshot } from "../features/snipes.js";
import { getTopPlaysSnapshot, type TopPlaysSnapshotOptions } from "../features/top-plays.js";
import { getTrackerSnapshot, type TrackerSnapshotFilters } from "../features/tracker.js";
import { type AbuseBucket, type AbuseGuard, normalizeCountryParam, type RateLimitResult } from "./abuse-guard.js";
import type { JobQueue } from "../jobs/queue.js";
import type { CountryClientTracker } from "../live/country-clients.js";
import type { LiveEventLog } from "../live/event-log.js";
import { readRuntimeStatus, setWorkersPaused, type RuntimeStatusSnapshot } from "../live/runtime-status.js";
import type { OscStatus } from "../osc/client.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { cancelOscCountryCatchup, enqueueOscBackfill, enqueueOscCountryCatchup } from "../osc/backfill.js";
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
import { addManualRosterMember, enqueueRosterRefreshes, removeManualRosterMember } from "../rosters/country-rosters.js";
import { getLocalDbStorage, runRetention } from "../retention.js";
import { getDiscordPublicInfo, type DiscordRuntime } from "../discord/index.js";
import { listAllSubscriptions, removeSubscriptionById } from "../discord/subscriptions.js";
import { listAllUserTrackers } from "../discord/trackers.js";
import { countUserLinks } from "../discord/identity.js";

const HIDDEN_ADMIN_WORKER_LANE_NAMES = new Set([
  "dan-estimates",
  "replay-video-render",
  "replay-video-finalize",
]);

export interface HttpContext {
  db: Db;
  queue: JobQueue;
  events: LiveEventLog;
  config: Config;
  abuse?: AbuseGuard;
  countryClients?: CountryClientTracker;
  osu: OsuApiClient;
  // Separate osu! client (and limiter) the scores fallback poller runs on, so
  // its own rate bucket can be surfaced. Optional: not every context wires it.
  scoresFallbackOsu?: OsuApiClient;
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
  discord?: DiscordRuntime;
}

const REQUEST_STARTED_AT = Symbol("maniaHubRequestStartedAt");
type TimedRequest = IncomingMessage & { [REQUEST_STARTED_AT]?: number };

export async function routeHttp(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  (req as TimedRequest)[REQUEST_STARTED_AT] = performance.now();
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
  // Discord posts interactions server-to-server (no Origin header, bursty). It
  // sits before the public rate gate because Ed25519 signature verification —
  // not IP rate limiting — is what protects this endpoint; an unsigned request
  // is rejected fast inside handleInteraction.
  if (url.pathname === "/api/discord/interactions") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!ctx.discord) {
      sendJson(req, res, ctx, 404, { error: "discord_not_configured" });
      return true;
    }
    return ctx.discord.handleInteraction(req, res);
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
  if (url.pathname === "/api/discord/info") {
    res.setHeader("cache-control", "public, max-age=60");
    sendJson(req, res, ctx, 200, getDiscordPublicInfo(ctx.config));
    return true;
  }
  const profileRoute = parseProfileRoute(url.pathname);
  if (profileRoute) {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (profileRoute.kind === "cached-snapshot") {
      const snapshot = await getCachedPlayerProfileSnapshot(ctx.db, profileRoute.key, ctx.osu);
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
    if (profileRoute.kind === "activity") {
      sendJson(req, res, ctx, 200, await getPlayerActivitySnapshot(
        ctx.db,
        ctx.queue,
        userId,
        url.searchParams.get("country") ?? country,
        clampInteger(url.searchParams.get("year"), 2007, new Date().getUTCFullYear() + 1, new Date().getUTCFullYear()),
      ));
      return true;
    }
    if (profileRoute.kind === "activity-day") {
      const day = url.searchParams.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        sendJson(req, res, ctx, 400, { error: "invalid_activity_day" });
        return true;
      }
      const detail = await getPlayerActivityDayDetail(
        ctx.db,
        ctx.queue,
        userId,
        url.searchParams.get("country") ?? country,
        day,
      );
      if (!detail) {
        sendJson(req, res, ctx, 404, { error: "activity_day_not_found" });
        return true;
      }
      sendJson(req, res, ctx, 200, detail);
      return true;
    }
    if (profileRoute.kind === "activity-availability") {
      sendJson(req, res, ctx, 200, await getPlayerActivityAvailability(
        ctx.db,
        userId,
        url.searchParams.get("country") ?? country,
      ));
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
    sendJson(req, res, ctx, 200, await statusBody(ctx, { includeWorkerActivity: true, snapshotCountry: country }));
    return true;
  }
  if (url.pathname === "/api/roster/self-add" || url.pathname === "/api/roster/self-remove") {
    // Admin-token gated: the frontend server fn forwards the osu!-verified viewer id with the
    // shared admin token (the pack-wallet pattern), so a user can only ever opt themselves in.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; country?: unknown }>((await readBody(req)) || "{}", {});
    const memberUserId = Number(body.userId);
    const memberCountry = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
    if (!Number.isInteger(memberUserId) || memberUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (!/^[A-Z]{2}$/.test(memberCountry) || isGlobalCountry(memberCountry)) {
      sendJson(req, res, ctx, 400, { error: "invalid_country" });
      return true;
    }
    const result = url.pathname === "/api/roster/self-remove"
      ? await removeManualRosterMember(ctx.db, memberCountry, memberUserId)
      : await addManualRosterMember(ctx.db, ctx.queue, ctx.config, memberCountry, memberUserId);
    sendJson(req, res, ctx, result.ok ? 200 : 409, result);
    return true;
  }
  if (url.pathname === "/api/goals" || url.pathname === "/api/goals/create" || url.pathname === "/api/goals/delete") {
    // All goal endpoints are admin-token gated: the frontend server fn injects the osu!-verified
    // viewer id (the roster/pack-wallet bridge), so a user only ever reads or mutates their own
    // goals. The browser can never name a different user id here.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (url.pathname === "/api/goals") {
      if (req.method !== "GET") {
        sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
        return true;
      }
      const userId = Number(url.searchParams.get("userId"));
      if (!Number.isInteger(userId) || userId <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
        return true;
      }
      // Settle goals against stored projections before listing, so goals that were already satisfied
      // before creation (or while a split worker's in-memory goal index was stale) do not linger open.
      await reconcileGoalsForUser(ctx.db, ctx.events, userId).catch(() => {});
      sendJson(req, res, ctx, 200, { goals: await listUserGoalsWithProgress(ctx.db, userId) });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; id?: unknown; kind?: unknown; country?: unknown; beatmapId?: unknown; beatmapsetId?: unknown; beatmapLabel?: unknown; targetValue?: unknown; targetGrade?: unknown; note?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (url.pathname === "/api/goals/delete") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        sendJson(req, res, ctx, 400, { error: "invalid_goal" });
        return true;
      }
      const ok = await deleteUserGoal(ctx.db, userId, id);
      sendJson(req, res, ctx, ok ? 200 : 404, { ok });
      return true;
    }
    // create
    const kind = String(body.kind ?? "") as GoalKind;
    if (!GOAL_KINDS.includes(kind)) {
      sendJson(req, res, ctx, 400, { error: "invalid_kind" });
      return true;
    }
    const rawCountry = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
    const input: UserGoalInput = { userId, country: /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null, kind };
    if (GOAL_MAP_KINDS.includes(kind)) {
      const beatmapId = Number(body.beatmapId);
      if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_beatmap" });
        return true;
      }
      input.beatmapId = beatmapId;
      const beatmapsetId = Number(body.beatmapsetId);
      input.beatmapsetId = Number.isInteger(beatmapsetId) && beatmapsetId > 0 ? beatmapsetId : null;
      input.beatmapLabel = typeof body.beatmapLabel === "string" ? body.beatmapLabel : null;
    }
    if (kind === "accuracy") {
      let target = Number(body.targetValue);
      // Accept either a fraction (0.96) or a percent (96); normalise to a 0-1 fraction.
      if (target > 1 && target <= 100) target = target / 100;
      if (!(target > 0 && target <= 1)) {
        sendJson(req, res, ctx, 400, { error: "invalid_target" });
        return true;
      }
      input.targetValue = target;
    } else if (kind === "grade") {
      const grade = String(body.targetGrade ?? "").toUpperCase();
      if (!GOAL_TARGET_GRADES.includes(grade)) {
        sendJson(req, res, ctx, 400, { error: "invalid_grade" });
        return true;
      }
      input.targetGrade = grade;
    } else if (kind === "play_pp" || kind === "reach_pp") {
      const target = Number(body.targetValue);
      if (!(target > 0)) {
        sendJson(req, res, ctx, 400, { error: "invalid_target" });
        return true;
      }
      input.targetValue = target;
    }
    if (typeof body.note === "string") input.note = body.note;
    const created = await createUserGoal(ctx.db, ctx.queue, input);
    // A just-created goal may already be satisfied by the player's stored tracker/top-play data.
    await reconcileGoalsForUser(ctx.db, ctx.events, userId, [kind]).catch(() => {});
    sendJson(req, res, ctx, 200, { ok: true, goal: (await getUserGoal(ctx.db, created.id)) ?? created });
    return true;
  }
  if (url.pathname === "/api/my-data/summary") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getMyDataSummary(ctx.db, userId));
    return true;
  }
  if (url.pathname === "/api/my-data/dashboard") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const limit = clampLimit(url.searchParams.get("limit"), 12, 60);
    const trackedOffset = clampInteger(url.searchParams.get("trackedOffset"), 0, 1_000_000, 0);
    const topOffset = clampInteger(url.searchParams.get("topOffset"), 0, 1_000_000, 0);
    const year = clampInteger(url.searchParams.get("year"), 2007, 2100, new Date().getFullYear());
    const summary = await getMyDataSummary(ctx.db, userId);
    const emptyTrackedPage = { items: [], total: 0, limit, offset: trackedOffset };
    const emptyTopPlayPage = { items: [], total: 0, limit, offset: topOffset };
    if (!summary.tracked) {
      sendJson(req, res, ctx, 200, { summary, trackedPage: emptyTrackedPage, topPlayPage: emptyTopPlayPage, activity: null });
      return true;
    }
    const activityCountry = summary.countryCode ?? summary.trackedCountries[0] ?? GLOBAL_COUNTRY_CODE;
    const [trackedPage, topPlayPage, activity] = await Promise.all([
      getUserTrackedFeed(ctx.db, userId, limit, trackedOffset),
      getUserTopPlaysFeed(ctx.db, userId, limit, topOffset),
      getPlayerActivitySnapshot(ctx.db, ctx.queue, userId, activityCountry, year).catch(() => null),
    ]);
    sendJson(req, res, ctx, 200, { summary, trackedPage, topPlayPage, activity });
    return true;
  }
  if (url.pathname === "/api/my-data/feed") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const limit = clampLimit(url.searchParams.get("limit"), 12, 60);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0);
    const page = await getUserTrackedFeed(ctx.db, userId, limit, offset);
    sendJson(req, res, ctx, 200, { scores: page.items, total: page.total, limit: page.limit, offset: page.offset });
    return true;
  }
  if (url.pathname === "/api/my-data/top-plays") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const limit = clampLimit(url.searchParams.get("limit"), 12, 60);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0);
    const page = await getUserTopPlaysFeed(ctx.db, userId, limit, offset);
    sendJson(req, res, ctx, 200, { plays: page.items, total: page.total, limit: page.limit, offset: page.offset });
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
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const global = isGlobalCountry(country);
    // Global is always windowed (min 1h): an unwindowed query would scan every
    // tracked country's score_events on each request.
    const windowHours = global ? clampInteger(url.searchParams.get("hours"), 1, 24 * 30, 1) : 0;
    const limit = clampLimit(url.searchParams.get("limit"), 100, 500);
    const offset = clampInteger(url.searchParams.get("offset"), 0, global ? Number.MAX_SAFE_INTEGER : 500, 0);
    const filters = parseTrackerSnapshotFilters(url.searchParams);
    const sort = parseTrackerSnapshotSort(url.searchParams);
    const sortDirection = parseTrackerSnapshotSortDirection(url.searchParams);
    const produceSnapshot = () => getTrackerSnapshot(ctx.db, country, limit, offset, {
      since: windowHours > 0 ? new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString() : undefined,
      filters,
      sort,
      sortDirection,
    });
    const snapshot = global
      ? await getCachedGlobalTrackerSnapshot(
          [windowHours, limit, offset, filters.score ?? "", filters.grade ?? "", filters.key ?? "", filters.miss ?? "", sort, sortDirection].join("|"),
          produceSnapshot,
        )
      : await produceSnapshot();
    sendJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/top-plays") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getTopPlaysSnapshot(ctx.db, country, url.searchParams.get("window") ?? "7d", parseTopPlaysSnapshotQuery(url.searchParams)));
    return true;
  }
  if (url.pathname === "/api/snapshots/snipes") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getSnipesSnapshot(ctx.db, country, clampLimit(url.searchParams.get("limit"), 500, 1000)));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-progress") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getMapsRefreshProgress(ctx.db, country));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-page") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    await handleMapsPageSnapshot(req, res, ctx, country, parseMapsPageQuery(url.searchParams));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const section = url.searchParams.get("section") === "random" ? "random" : "core";
    await handleMapsSnapshot(req, res, ctx, country, section);
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-players") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const kind = parseMapsPlayersKind(url.searchParams.get("kind"));
    const id = clampInteger(url.searchParams.get("id"), 1, Number.MAX_SAFE_INTEGER, 0);
    if (!kind || id <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_maps_players_request" });
      return true;
    }
    const playersQuery: MapsPlayersPageQuery = {
      page: clampInteger(url.searchParams.get("page"), 0, 100_000, 0),
      pageSize: clampInteger(url.searchParams.get("pageSize"), 1, MAPS_PLAYERS_MAX_PAGE_SIZE, MAPS_PLAYERS_MAX_PAGE_SIZE),
      q: (url.searchParams.get("q") ?? "").slice(0, 100),
    };
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    sendJson(req, res, ctx, 200, await getMapsPlayersSnapshot(ctx.db, country, kind, id, playersQuery));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-set") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const ids = parseUserIds(url.searchParams.get("ids"));
    // Set metadata only changes on the (roughly weekly) maps rebuild, so it can
    // cache far longer than the live tabs.
    res.setHeader("cache-control", "public, max-age=600, stale-while-revalidate=1800");
    sendJson(req, res, ctx, 200, { beatmapsets: await getMapsRandomBeatmapsets(ctx.db, ids) });
    return true;
  }
  if (url.pathname === "/api/snapshots/rankings") {
    if (isGlobalCountry(country)) {
      const snapshot = await getGlobalRankingsSnapshot(ctx.db, parseGlobalRankingsQuery(url.searchParams));
      try {
        await enqueueGlobalRankingStatRepairs(ctx.queue, snapshot.ranking);
      } catch (error) {
        console.warn("[global-rankings] failed to queue stat repair", error);
      }
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      sendJson(req, res, ctx, 200, snapshot);
      return true;
    }
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const snapshot = await getCountryRankingsSnapshot(ctx.db, country, parseGlobalRankingsQuery(url.searchParams));
    try {
      await enqueueGlobalRankingStatRepairs(ctx.queue, snapshot.ranking);
    } catch (error) {
      console.warn("[country-rankings] failed to queue stat repair", error);
    }
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    sendJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/global-rankings") {
    const snapshot = await getGlobalRankingsSnapshot(ctx.db, parseGlobalRankingsQuery(url.searchParams));
    try {
      await enqueueGlobalRankingStatRepairs(ctx.queue, snapshot.ranking);
    } catch (error) {
      console.warn("[global-rankings] failed to queue stat repair", error);
    }
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    sendJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/farm-helper") {
    // Global tool: no country activation. The osu! best-scores fetch for an
    // unknown subject is the costly part, so it shares the costly bucket.
    const userKey = (url.searchParams.get("user") ?? "").trim();
    if (!userKey) {
      sendJson(req, res, ctx, 400, { error: "missing_user" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    try {
      const snapshot = await getFarmHelperSnapshot(ctx.db, ctx.osu, userKey, {
        keyMode: parseFarmHelperKeyMode(url.searchParams.get("key")),
        view: parseFarmHelperView(url.searchParams.get("view")),
        limit: clampInteger(url.searchParams.get("limit"), 1, 100, 60),
      });
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      sendJson(req, res, ctx, 200, snapshot);
    } catch (error) {
      if (error instanceof FarmHelperUserNotFoundError) {
        sendJson(req, res, ctx, 404, { error: "user_not_found" });
        return true;
      }
      throw error;
    }
    return true;
  }
  if (url.pathname === "/api/snapshots/farm-helper-farmers") {
    const userKey = (url.searchParams.get("user") ?? "").trim();
    const beatmapId = clampInteger(url.searchParams.get("beatmap"), 1, 2_000_000_000, 0);
    if (!userKey) {
      sendJson(req, res, ctx, 400, { error: "missing_user" });
      return true;
    }
    if (!beatmapId) {
      sendJson(req, res, ctx, 400, { error: "missing_beatmap" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    try {
      const result = await getFarmHelperFarmers(
        ctx.db,
        ctx.osu,
        userKey,
        beatmapId,
        parseFarmHelperSpeedBucket(url.searchParams.get("speed")),
        parseFarmHelperKeyMode(url.searchParams.get("key")),
      );
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      sendJson(req, res, ctx, 200, result);
    } catch (error) {
      if (error instanceof FarmHelperUserNotFoundError) {
        sendJson(req, res, ctx, 404, { error: "user_not_found" });
        return true;
      }
      throw error;
    }
    return true;
  }
  if (url.pathname === "/api/snapshots/rank-deltas") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
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
  if (url.pathname === "/api/packs/warm") {
    // Pack deals send the drawn user ids here so cold players' profile
    // snapshots start fetching before their card is ever flipped. Responds
    // immediately; the osu! API work runs in the background.
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const userIds = [...new Set(
      (Array.isArray(body.userIds) ? body.userIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    )].slice(0, 10);
    if (userIds.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    sendJson(req, res, ctx, 202, await warmProfileSnapshots(ctx.db, ctx.osu, userIds));
    return true;
  }
  const packWalletMatch = url.pathname.match(/^\/api\/pack-wallet\/(\d+)$/);
  if (packWalletMatch) {
    // Server-to-server only: the frontend's server functions authenticate
    // the osu! login cookie and forward the viewer's own wallet with the
    // admin bearer token. Browsers never call this directly.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const walletUserId = Number(packWalletMatch[1]);
    if (!Number.isFinite(walletUserId) || walletUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (req.method === "GET") {
      const wallet = await getPackWallet(ctx.db, walletUserId);
      sendJson(req, res, ctx, 200, wallet ? { payload: wallet.payload, rev: wallet.rev } : { payload: null, rev: 0 });
      return true;
    }
    if (req.method === "POST") {
      const body = parseJson<Record<string, unknown>>(
        (await readBodyBuffer(req, PACK_WALLET_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
        {},
      );
      const payload = typeof body.payload === "string" ? body.payload : "";
      const baseRev = Number(body.baseRev);
      const cardImportMode = body.cardsMode === "delta" ? "delta" : "snapshot";
      if (!payload || payload.length > PACK_WALLET_PAYLOAD_MAX_CHARS || !Number.isFinite(baseRev) || baseRev < 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_wallet_payload" });
        return true;
      }
      const result = await savePackWallet(ctx.db, walletUserId, payload, Math.floor(baseRev), Date.now(), cardImportMode);
      if (!result.ok) {
        sendJson(req, res, ctx, 409, { error: "wallet_conflict", payload: result.current.payload, rev: result.current.rev });
        return true;
      }
      sendJson(req, res, ctx, 200, { rev: result.rev });
      return true;
    }
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  const packCollectionMatch = url.pathname.match(/^\/api\/pack-collection\/(\d+)$/);
  if (packCollectionMatch) {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const walletUserId = Number(packCollectionMatch[1]);
    if (!Number.isFinite(walletUserId) || walletUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (req.method === "POST") {
      const body = parseJson<Record<string, unknown>>(
        (await readBodyBuffer(req, DEFAULT_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
        {},
      );
      const mode =
        body.mode === "duplicates" ||
        body.mode === "whole" ||
        body.mode === "all_duplicates" ||
        body.mode === "whole_matching"
        ? body.mode
        : null;
      const cardUserId = Number(body.cardUserId);
      const cardUserIds = mode === "whole" && Array.isArray(body.cardUserIds)
        ? body.cardUserIds
            .slice(0, 500)
            .map((id) => Math.floor(Number(id) || 0))
            .filter((id) => id > 0)
        : null;
      const hasBulkIds = cardUserIds !== null && cardUserIds.length > 0;
      if (
        !mode ||
        (mode !== "all_duplicates" &&
          mode !== "whole_matching" &&
          !hasBulkIds &&
          (!Number.isFinite(cardUserId) || cardUserId <= 0))
      ) {
        sendJson(req, res, ctx, 400, { error: "invalid_recycle_request" });
        return true;
      }
      const result = await recyclePackCollectionCards(ctx.db, walletUserId, {
        mode,
        cardUserId: Number.isFinite(cardUserId) ? Math.floor(cardUserId) : undefined,
        cardUserIds: hasBulkIds ? cardUserIds : undefined,
        tier: typeof body.tier === "string" ? body.tier : "all",
        query: typeof body.query === "string" ? body.query.slice(0, 120) : "",
      });
      sendJson(req, res, ctx, 200, { gained: result.gained, payload: result.wallet.payload, rev: result.wallet.rev });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
    const pageSize = Math.min(60, Math.max(1, Math.floor(Number(url.searchParams.get("pageSize")) || 15)));
    const tier = url.searchParams.get("tier");
    const query = url.searchParams.get("q");
    sendJson(req, res, ctx, 200, await listPackCollectionCards(ctx.db, walletUserId, { page, pageSize, tier, query }));
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
    sendJson(req, res, ctx, 200, { events: await ctx.events.replay(isGlobalCountry(country) ? null : country, Number.isFinite(since) ? since : 0, 500) });
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
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
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
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const paused = url.pathname === "/api/admin/pause-country";
    sendJson(req, res, ctx, 200, { ok: true, country: await setCountryPaused(ctx.db, ctx.config, country, paused) });
    return true;
  }
  if (url.pathname === "/api/admin/set-country-status") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const status = parseCountryStatusParam(url.searchParams.get("status"));
    if (!status) {
      sendJson(req, res, ctx, 400, { error: "invalid_status" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, country: await setCountryStatus(ctx.db, ctx.config, country, status) });
    return true;
  }
  if (url.pathname === "/api/admin/set-country-tier") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const tier = parseCountryFeatureTierParam(url.searchParams.get("tier"));
    if (!tier) {
      sendJson(req, res, ctx, 400, { error: "invalid_tier" });
      return true;
    }
    const updated = await setCountryFeatureTier(ctx.db, ctx.config, country, tier);
    if (ctx.config.enableOsuApiJobs) {
      await enqueueRosterRefreshes(ctx.queue, [updated.country]);
    }
    if (ctx.config.enableOsuApiJobs && isCountryFeatureAtLeast(updated.featureTier, "maps_warm")) {
      await enqueueMapsRefreshIfDue(ctx.db, ctx.queue, updated.country, ctx.config.mapsRefreshIntervalMs, { priority: 90 });
    }
    sendJson(req, res, ctx, 200, { ok: true, country: updated });
    return true;
  }
  if (url.pathname === "/api/admin/add-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const added = await activateCountry(ctx.db, ctx.queue, ctx.config, country);
    if (ctx.config.enableOsuApiJobs && isCountryFeatureAtLeast(added.featureTier, "maps_warm")) {
      await enqueueMapsRefreshIfDue(ctx.db, ctx.queue, added.country, ctx.config.mapsRefreshIntervalMs, { priority: 15 });
    }
    sendJson(req, res, ctx, 200, { ok: true, country: added });
    return true;
  }
  if (url.pathname === "/api/admin/delete-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
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
    if (!ctx.config.enableOsuApiJobs) {
      sendJson(req, res, ctx, 409, { error: "osu_api_jobs_disabled" });
      return true;
    }
    await enqueueMapsRefresh(ctx.queue, country, { priority: 90, replaceDone: true });
    sendJson(req, res, ctx, 200, { ok: true, country });
    return true;
  }
  if (url.pathname === "/api/admin/catch-up-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    await setCountryStatus(ctx.db, ctx.config, country, "active");
    await enqueueRosterRefreshes(ctx.queue, [country]);
    const queued = await enqueueOscCountryCatchup(ctx.queue, ctx.db, ctx.config, country);
    sendJson(req, res, ctx, 200, { ok: true, ...queued });
    return true;
  }
  if (url.pathname === "/api/admin/cancel-catch-up-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, ...await cancelOscCountryCatchup(ctx.db, country) });
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
    // Cross-process flag the worker polls, so pause works when workers run elsewhere.
    await setWorkersPaused(ctx.db, true);
    sendJson(req, res, ctx, 200, { ok: true, worker: ctx.workerStatus?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/admin/resume-workers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    ctx.resumeWorkers?.();
    await setWorkersPaused(ctx.db, false);
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
  if (url.pathname === "/api/admin/discord/status") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, {
      ok: true,
      discord: ctx.discord?.status() ?? { enabled: false },
      subscriptions: await listAllSubscriptions(ctx.db),
      trackers: await listAllUserTrackers(ctx.db),
      linkCount: await countUserLinks(ctx.db),
    });
    return true;
  }
  if (url.pathname === "/api/admin/discord/register-commands") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.discord) {
      sendJson(req, res, ctx, 400, { error: "discord_not_configured" });
      return true;
    }
    try {
      const result = await ctx.discord.registerCommands();
      sendJson(req, res, ctx, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(req, res, ctx, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (url.pathname === "/api/admin/discord/guilds") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.discord) {
      sendJson(req, res, ctx, 400, { error: "discord_not_configured" });
      return true;
    }
    try {
      const guilds = await ctx.discord.listGuilds();
      sendJson(req, res, ctx, 200, { ok: true, count: guilds.length, guilds });
    } catch (error) {
      sendJson(req, res, ctx, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (url.pathname === "/api/admin/discord/remove-subscription") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const id = Number(url.searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_id" });
      return true;
    }
    const removed = await removeSubscriptionById(ctx.db, id);
    if (removed) ctx.discord?.notifySubscriptionsChanged();
    sendJson(req, res, ctx, 200, { ok: true, removed });
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
      "farm_helper_user_key_stats",
      "replay_video_exports",
      "dan_estimates",
      "beatmap_skill_vectors",
      "player_activity_score_refs",
      "player_activity_days",
      "player_activity_maps",
      "player_activity_backfill_cursors",
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

async function statusBody(ctx: HttpContext, options: { includeWorkerActivity?: boolean; snapshotCountry?: string } = {}) {
  const db = await dbHealth(ctx.db);
  const last = (await exec(ctx.db, "select max(created_at) as created_at from live_event_log")).rows[0]?.created_at ?? null;
  // In a split deployment the worker runs in another process, so its live
  // status (lanes, OSC feed, osu! limiter) is mirrored to the DB. Prefer that
  // mirror in server-only mode; fall back to in-process state for "all" mode.
  const mirror = ctx.config.role === "server" ? await readRuntimeStatus(ctx.db) : null;
  const worker = (mirror?.worker as WorkerStatus | null | undefined) ?? ctx.workerStatus?.() ?? null;
  const osc = (mirror?.osc as OscStatus | undefined) ?? ctx.oscStatus();
  const rate = mirror?.osuRate ?? ctx.osu.limiter.state();
  const sqliteBusy = {
    server: getSqliteBusyRetryStats(),
    worker: mirror?.sqliteBusy ?? (ctx.config.role === "server" ? null : getSqliteBusyRetryStats()),
  };
  const snapshotStats = options.snapshotCountry
    ? await adminSnapshotStats(ctx.db, options.snapshotCountry)
    : undefined;
  return {
    ok: db,
    db,
    storage: await getLocalDbStorage(ctx.config),
    osc,
    lastEventAt: last,
    queueDepth: await ctx.queue.depth(),
    queuePressure: await ctx.queue.pressure(),
    queueSummary: await ctx.queue.summary(),
    roster: await rosterSummary(ctx.db),
    rate,
    sqliteBusy,
    scoresFallback: await scoresFallbackStatus(ctx, mirror),
    abuse: ctx.abuse?.state() ?? null,
    apiCallHistory: await apiCallHistory(ctx.db),
    countries: await countryRegistryStatus(ctx),
    catchup: await countryCatchupStatus(ctx),
    worker: options.includeWorkerActivity ? adminWorkerStatus(worker) : publicWorkerStatus(worker),
    ...(snapshotStats ? { snapshotStats } : {}),
  };
}

async function adminSnapshotStats(db: Db, country: string) {
  const normalized = country.toUpperCase();
  const global = isGlobalCountry(normalized);
  const now = Date.now();
  const topPlaysCutoff = new Date(now - 7 * 24 * 60 * 60_000).toISOString();
  const [tracker, topPlays, snipes] = await Promise.all([
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from score_events
         where ${global ? "" : "country = ? and "}passed = 1
         order by ended_at desc
         limit 100
       )`,
      global ? [] : [normalized],
    ),
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from top_play_events
         where ${global ? "" : "country = ? and "}detected_at >= ?
         order by pp desc, detected_at desc
         limit 200
       )`,
      global ? [topPlaysCutoff] : [normalized, topPlaysCutoff],
    ),
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from snipe_events
         where ${global ? "1 = 1" : "country = ?"}
         order by detected_at desc
         limit 500
       )`,
      global ? [] : [normalized],
    ),
  ]);

  return {
    trackerScores: Number(tracker.rows[0]?.count ?? 0),
    trackerFetchedAt: now,
    topPlays: Number(topPlays.rows[0]?.count ?? 0),
    topPlaysFetchedAt: now,
    snipes: Number(snipes.rows[0]?.count ?? 0),
    snipesFetchedAt: now,
  };
}

async function scoresFallbackStatus(ctx: HttpContext, mirror?: RuntimeStatusSnapshot | null) {
  const resultRow = (await exec(ctx.db, "select value_json, updated_at from live_meta where key = 'osu_scores_fallback_last_result'")).rows[0];
  const cursorRow = (await exec(ctx.db, "select value_json, updated_at from live_meta where key = 'osu_scores_fallback_cursor_string'")).rows[0];
  // The fallback poller runs on its own osu! client, so its limiter is a bucket
  // separate from the main one shown in `rate`. Surface used/target/pending here
  // so the admin panel can show the fallback's real polling rate. In split mode
  // the poller lives in the worker process, so prefer its mirrored limiter state.
  const limiterState = (mirror?.scoresFallbackRate as ReturnType<NonNullable<HttpContext["scoresFallbackOsu"]>["limiter"]["state"]> | undefined)
    ?? ctx.scoresFallbackOsu?.limiter.state();
  return {
    enabled: ctx.config.enableOsuScoresFallback,
    intervalMs: ctx.config.osuScoresFallbackIntervalMs,
    updatedAt: resultRow?.updated_at == null ? null : String(resultRow.updated_at),
    result: parseJson(resultRow?.value_json, null),
    cursorUpdatedAt: cursorRow?.updated_at == null ? null : String(cursorRow.updated_at),
    hasCursor: cursorRow?.value_json != null,
    rate: limiterState
      ? {
          usedLastMinute: limiterState.usedLastMinute,
          targetPerMinute: limiterState.targetPerMinute,
          hardPerMinute: limiterState.hardPerMinute,
          pending: limiterState.pending,
        }
      : null,
  };
}

interface CountryCatchupResult {
  fetched: number;
  inserted: number;
  skipped: number;
  after: number;
  nextAfter: number | null;
  hasMore: boolean;
}

interface CountryCatchupState {
  pending: number;
  running: number;
  failed: number;
  lastError: string | null;
  lastRunAt: string | null;
  cursorMs: number | null;
  lastResult: CountryCatchupResult | null;
}

async function countryCatchupStatus(ctx: HttpContext): Promise<Record<string, CountryCatchupState>> {
  const meta = (await exec(
    ctx.db,
    "select key, value_json, updated_at from live_meta where key like 'osc_country_catchup_last_result:%' or key like 'osc_country_catchup_cursor_ms:%'",
  )).rows;
  const jobs = (await exec(
    ctx.db,
    "select status, payload_json, last_error from jobs where type = 'osc_country_catchup' and status in ('queued', 'running', 'failed')",
  )).rows;
  const byCountry = new Map<string, CountryCatchupState>();
  const ensure = (country: string): CountryCatchupState => {
    let state = byCountry.get(country);
    if (!state) {
      state = { pending: 0, running: 0, failed: 0, lastError: null, lastRunAt: null, cursorMs: null, lastResult: null };
      byCountry.set(country, state);
    }
    return state;
  };
  for (const row of meta) {
    const key = String(row.key);
    const country = key.split(":")[1]?.toUpperCase();
    if (!country) continue;
    const state = ensure(country);
    if (key.startsWith("osc_country_catchup_last_result:")) {
      state.lastResult = parseJson<CountryCatchupResult | null>(row.value_json, null);
      state.lastRunAt = row.updated_at == null ? null : String(row.updated_at);
    } else {
      const cursor = parseJson<number>(row.value_json, Number.NaN);
      state.cursorMs = Number.isFinite(cursor) ? cursor : null;
    }
  }
  for (const row of jobs) {
    const payload = parseJson<{ country?: string }>(row.payload_json, {});
    const country = typeof payload.country === "string" ? payload.country.toUpperCase() : null;
    if (!country) continue;
    const state = ensure(country);
    const status = String(row.status);
    if (status === "running") state.running += 1;
    else if (status === "queued") state.pending += 1;
    else if (status === "failed") {
      state.failed += 1;
      if (row.last_error != null) state.lastError = String(row.last_error);
    }
  }
  return Object.fromEntries(byCountry);
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

type WorkerStatus = ReturnType<NonNullable<HttpContext["workerStatus"]>>;

function visibleWorkerLanes(worker: WorkerStatus | null) {
  return worker?.lanes?.filter((lane) => !HIDDEN_ADMIN_WORKER_LANE_NAMES.has(lane.name));
}

function adminWorkerStatus(worker: WorkerStatus | null) {
  if (!worker) return null;
  return {
    paused: worker.paused,
    stopped: worker.stopped,
    workerId: worker.workerId,
    lanes: visibleWorkerLanes(worker)?.map((lane) => ({
      name: lane.name,
      claimLimit: lane.claimLimit,
      intervalMs: lane.intervalMs,
      jobTypes: lane.jobTypes,
      activeJobs: lane.activeJobs,
    })),
  };
}

function publicWorkerStatus(worker: WorkerStatus | null) {
  if (!worker) return null;
  return {
    paused: worker.paused,
    stopped: worker.stopped,
    workerId: worker.workerId,
    lanes: visibleWorkerLanes(worker)?.map((lane) => ({
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
  if (isGlobalCountry(country)) {
    // Global is a synthetic aggregate: keep its merged maps snapshot fresh but
    // never build a roster or registry row for it.
    await enqueueGlobalMapsRefreshIfDue(ctx.db, ctx.queue, ctx.config.mapsRefreshIntervalMs, { priority: 15 });
    const now = new Date().toISOString();
    return {
      country: GLOBAL_COUNTRY_CODE,
      status: "active",
      featureTier: "maps_warm",
      pinned: true,
      keepWarm: true,
      firstRequestedAt: now,
      lastRequestedAt: now,
      lastRosterRefreshAt: now,
      lastScoreAt: null,
      activeUsers: 0,
      lastActiveAt: now,
      isWarm: true,
    };
  }
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
  if (ctx.config.enableOsuApiJobs && isCountryFeatureAtLeast(activated.featureTier, "maps_warm")) {
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

function isObserveCountryRequest(url: URL): boolean {
  return url.searchParams.get("observe") === "1";
}

function routeUsesCountry(pathname: string): boolean {
  return pathname === "/api/countries/activate"
    || pathname === "/api/events"
    || pathname.startsWith("/api/snapshots/")
    || pathname === "/api/admin/refresh-roster"
    || pathname === "/api/admin/refresh-maps"
    || pathname === "/api/admin/pause-country"
    || pathname === "/api/admin/resume-country"
    || pathname === "/api/admin/catch-up-country"
    || pathname === "/api/admin/cancel-catch-up-country"
    || pathname === "/api/admin/add-country"
    || pathname === "/api/admin/delete-country"
    || pathname === "/api/admin/set-country-status"
    || pathname === "/api/admin/set-country-tier";
}

function parseCountryStatusParam(value: string | null): CountryRegistryStatus | null {
  return value === "active" || value === "warm" || value === "paused"
    ? value
    : null;
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
  setServerTiming(req, res);
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
  setServerTiming(req, res);
  if (prepared.vary) appendVary(res, "accept-encoding");
  if (prepared.encoding) res.setHeader("content-encoding", prepared.encoding);
  res.end(prepared.body);
}

function setServerTiming(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent) return;
  const startedAt = (req as TimedRequest)[REQUEST_STARTED_AT];
  if (startedAt == null) return;
  const durationMs = Math.max(0, performance.now() - startedAt);
  res.setHeader("server-timing", `app;dur=${durationMs.toFixed(1)}`);
}

// /api/snapshots/maps serves a multi-MB payload (a whole country roster's
// farmed + favourite maps). The stored snapshot only changes when the maps
// refresh job rewrites the row, yet every visit otherwise re-parses,
// re-slices and re-compresses it from scratch. We cache the finished
// (already-compressed) response body keyed on the row's refreshed_at: that key
// IS the real cache lifetime — it stays valid until the next rebuild, then
// changes on its own. The TTL is just a periodic re-check so the volatile
// isStale / refreshQueued flags in the body can't stay wrong indefinitely if
// a rebuild stalls; the refresh itself is enqueued on cache misses (inside
// getMapsSnapshot) and on the activatePublicCountry path.
//
// The two sections cache differently. "core" only caches settled responses
// (no refresh in flight) because its body flips when the rebuild lands.
// "random" caches even mid-refresh: its pool is identical for a given
// refreshed_at regardless of staleness flags, and GLOBAL is permanently
// "behind sources" (any country refresh or ingested score re-stales it), so
// requiring a settled state would keep GLOBAL — a ~10s hydrate of ~45k sets —
// uncached forever, which is exactly what made the Random tab crawl.
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

// A global tracker snapshot is identical for every visitor but its query spans
// every tracked country's score_events, so cache results briefly per parameter
// set. Entries hold the promise itself rather than the resolved value: a burst
// of identical requests (page loads, SSE reconnects after a deploy) runs the
// query once and every caller awaits the same computation.
const TRACKER_GLOBAL_SNAPSHOT_CACHE_TTL_MS = 5_000;
const TRACKER_GLOBAL_SNAPSHOT_CACHE_MAX_ENTRIES = 64;

type TrackerSnapshotResult = Awaited<ReturnType<typeof getTrackerSnapshot>>;

const trackerGlobalSnapshotCache = new Map<string, { storedAt: number; snapshot: Promise<TrackerSnapshotResult> }>();

function getCachedGlobalTrackerSnapshot(key: string, produce: () => Promise<TrackerSnapshotResult>): Promise<TrackerSnapshotResult> {
  const now = Date.now();
  for (const [entryKey, entry] of trackerGlobalSnapshotCache) {
    if (now - entry.storedAt > TRACKER_GLOBAL_SNAPSHOT_CACHE_TTL_MS) trackerGlobalSnapshotCache.delete(entryKey);
  }
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (trackerGlobalSnapshotCache.size > TRACKER_GLOBAL_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = trackerGlobalSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    trackerGlobalSnapshotCache.delete(oldest);
  }
  const cached = trackerGlobalSnapshotCache.get(key);
  if (cached) return cached.snapshot;
  const snapshot = produce();
  trackerGlobalSnapshotCache.set(key, { storedAt: now, snapshot });
  // Failures are never cached; the next request retries. The identity check
  // keeps a late rejection from evicting a newer entry under the same key.
  snapshot.catch(() => {
    if (trackerGlobalSnapshotCache.get(key)?.snapshot === snapshot) trackerGlobalSnapshotCache.delete(key);
  });
  return snapshot;
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

function parseMapsPlayersKind(raw: string | null): MapsPlayersKind | null {
  return raw === "farmed" || raw === "popular" || raw === "favourite" ? raw : null;
}

function parseFarmHelperKeyMode(raw: string | null): FarmHelperKeyMode | undefined {
  return raw === "4k" || raw === "7k" || raw === "any" ? raw : undefined;
}

function parseFarmHelperView(raw: string | null): FarmHelperView | undefined {
  return raw === "gain" || raw === "popular" ? raw : undefined;
}

function parseFarmHelperSpeedBucket(raw: string | null): ScoreSpeedBucket | undefined {
  return raw === "ht" || raw === "normal" || raw === "dt" ? raw : undefined;
}

function parseTopPlaysSnapshotQuery(params: URLSearchParams): TopPlaysSnapshotOptions {
  const rawSort = params.get("sort");
  const rawKeys = params.get("keys");
  return {
    sort: rawSort === "recent" || rawSort === "pp" || rawSort === "gain" ? rawSort : undefined,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    keys: rawKeys === "4k" || rawKeys === "other" ? rawKeys : "all",
    page: clampInteger(params.get("page"), 1, 10_000, 1),
    pageSize: clampInteger(params.get("pageSize") ?? params.get("limit"), 1, 200, 200),
    includePpGains: params.get("includePpGains") === "1",
    userIds: parseUserIds(params.get("userIds")),
  };
}

function parseGlobalRankingsQuery(params: URLSearchParams): {
  page: number;
  pageSize: number;
  sort: GlobalRankingsSort;
  dir: "asc" | "desc";
} {
  const rawSort = params.get("sort");
  const sort: GlobalRankingsSort =
    rawSort === "player" ||
    rawSort === "7d" ||
    rawSort === "cr7d" ||
    rawSort === "accuracy" ||
    rawSort === "playcount" ||
    rawSort === "pp" ||
    rawSort === "ss" ||
    rawSort === "s" ||
    rawSort === "a"
      ? rawSort
      : "rank";
  return {
    page: clampInteger(params.get("page"), 1, 10_000, 1),
    pageSize: clampInteger(params.get("pageSize") ?? params.get("limit"), 1, 50, 50),
    sort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
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
  const encoding = negotiateEncoding(req);

  const meta = await getMapsSnapshotMeta(ctx.db, country);
  const farmedOverlayKey = query.tab === "farmed" ? meta.farmedOverlayUpdatedAt ?? "" : "";
  const sourceRefreshKey = meta.sourceRefreshedAt ?? "";
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
        sourceRefreshKey,
        farmedOverlayKey,
        encoding ?? "identity",
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
  const prepared = await prepareJsonResponse(status, snapshot, encoding);
  writePreparedJson(req, res, ctx, prepared);

  if (cacheKey && status === 200 && snapshot.value && !snapshot.refreshQueued) {
    mapsPageResponseCache.set(cacheKey, { ...prepared, storedAt: now });
  }
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
  // The random slice depends only on this row's pool ids plus beatmapset
  // metadata, so its key is just refreshed_at. The cross-country source and
  // farmed-overlay timestamps that key "core" churn with every ingested score
  // on GLOBAL and would keep the random entry permanently cold.
  const cacheKey = meta.refreshedAt
    ? section === "random"
      ? `${country.toUpperCase()}|random|${encoding ?? "identity"}|${meta.refreshedAt}`
      : `${country.toUpperCase()}|core|${encoding ?? "identity"}|${meta.refreshedAt}|${meta.sourceRefreshedAt ?? ""}|${meta.farmedOverlayUpdatedAt ?? ""}`
    : null;

  if (cacheKey) {
    const cached = mapsResponseCache.get(cacheKey);
    if (cached && now - cached.storedAt <= MAPS_RESPONSE_CACHE_TTL_MS) {
      writePreparedJson(req, res, ctx, cached);
      return;
    }
    // Coalesce concurrent misses: a burst of visitors right after a rebuild
    // (or restart) must run the multi-second hydrate once, not once each.
    const inflight = mapsSnapshotInflight.get(cacheKey);
    if (inflight) {
      writePreparedJson(req, res, ctx, await inflight);
      return;
    }
    const build = buildMapsSnapshotResponse(ctx, country, section, encoding, cacheKey, now);
    mapsSnapshotInflight.set(cacheKey, build);
    try {
      writePreparedJson(req, res, ctx, await build);
    } finally {
      mapsSnapshotInflight.delete(cacheKey);
    }
    return;
  }

  writePreparedJson(req, res, ctx, await buildMapsSnapshotResponse(ctx, country, section, encoding, null, now));
}

const mapsSnapshotInflight = new Map<string, Promise<PreparedJsonResponse>>();

async function buildMapsSnapshotResponse(
  ctx: HttpContext,
  country: string,
  section: "core" | "random",
  encoding: "br" | "gzip" | null,
  cacheKey: string | null,
  now: number,
): Promise<PreparedJsonResponse> {
  const snapshot = await getMapsSnapshot(ctx.db, ctx.queue, country, ctx.config.mapsRefreshIntervalMs, section);
  const status = snapshot.value ? 200 : 202;
  const prepared = await prepareJsonResponse(status, snapshot, encoding);

  // Only cache populated 200s — never the cold "still building" 202/null state,
  // whose body changes the moment the first real snapshot lands. "core" also
  // waits for a settled refresh; "random" must not (see the cache comment).
  const cacheable = section === "random"
    ? status === 200 && snapshot.value != null
    : status === 200 && snapshot.value != null && !snapshot.refreshQueued;
  if (cacheKey && cacheable) {
    mapsResponseCache.set(cacheKey, { ...prepared, storedAt: now });
  }
  return prepared;
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

function parseTrackerSnapshotFilters(params: URLSearchParams): TrackerSnapshotFilters {
  const score = params.get("scoreFilter");
  const grade = params.get("grade");
  const key = params.get("key");
  const miss = params.get("miss");
  return {
    score: score === "ranked" ? "ranked" : undefined,
    grade: grade === "SS" || grade === "S" || grade === "A" || grade === "B" ? grade : undefined,
    key: key === "4k" || key === "other" ? key : undefined,
    miss: miss === "fc" || miss === "fc_choke" ? miss : undefined,
  };
}

function parseTrackerSnapshotSort(params: URLSearchParams): "recent" | "stars" {
  return params.get("sort") === "stars" ? "stars" : "recent";
}

function parseTrackerSnapshotSortDirection(params: URLSearchParams): "asc" | "desc" {
  return params.get("sortDirection") === "asc" ? "asc" : "desc";
}

function parseUserIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 100);
}

function parseProfileRoute(pathname: string): { kind: "cached-snapshot" | "snapshot" | "recent" | "about" | "activity" | "activity-day" | "activity-availability"; key: string } | null {
  const match = /^\/api\/profiles\/([^/]+)\/(cached-snapshot|snapshot|recent|about|activity|activity-day|activity-availability)$/.exec(pathname);
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return {
    key,
    kind: match[2] as "cached-snapshot" | "snapshot" | "recent" | "about" | "activity" | "activity-day" | "activity-availability",
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

// A wallet holding the full ~6k tracked-player pool serializes to ~1.5MB,
// so pack wallet pushes get more headroom than the default body limit.
const PACK_WALLET_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const PACK_WALLET_PAYLOAD_MAX_CHARS = 3_500_000;

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
