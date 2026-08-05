import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Config } from "../config.js";
import { handleBeatmapAudioRequest, handleBeatmapHitsoundsRequest, handleBeatmapStoryboardRequest, handlePreviewAudioRequest } from "../audio/http.js";
import { activateCountry, deleteCountryData, getCountryRegistry, getCountryRegistryRow, GLOBAL_COUNTRY_CODE, isCountryFeatureAtLeast, isGlobalCountry, setCountryFeatureTier, setCountryPaused, setCountryStatus, type CountryFeatureTier, type CountryRegistryStatus } from "../countries.js";
import type { Db } from "../db.js";
import { dbHealth, exec, getSqliteBusyRetryStats, parseJson, readSchemaMigrationState, SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS } from "../db.js";
import { lnAdjustedMsd } from "../dan/msd.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION, getPlayerActivityAvailability, getPlayerActivityDayDetail, getPlayerActivitySnapshot } from "../features/activity.js";
import { clearDoneAdminTodos, createAdminTodo, deleteAdminTodo, listAdminTodos, updateAdminTodo, type CreateTodoInput, type UpdateTodoInput } from "../features/admin-todos.js";
import { cancelBeatmapOsuFileBackfill, getBeatmapOsuFileBackfillStatus, startBeatmapOsuFileBackfill } from "../features/beatmap-osu-file-backfill.js";
import { CHART_ANALYSIS_VERSION, cancelChartAnalysisBackfill, enqueueChartAnalysisBackfill, startChartAnalysisBackfill } from "../features/chart-analysis.js";
import { getDanEstimateBatch } from "../features/dan-estimates.js";
import { importDanBenchmark, isDanBenchmarkFamily, listDanBenchmarkHiddenDiffs, listDanBenchmarkLabels, setDanBenchmarkHiddenDiff, setDanBenchmarkLabel } from "../features/dan-benchmark.js";
import { enrichPayloadAvatarAccents, lookupAvatarAccents } from "../features/avatar-accents.js";
import { getOsuJsonWithProxyCache, normalizeOsuProxyCacheHints } from "../features/osu-proxy-cache.js";
import { GOAL_KINDS, GOAL_MAP_KINDS, GOAL_SPEED_BUCKETS, GOAL_TARGET_GRADES, createUserGoal, deleteUserGoal, getUserGoal, listUserGoalsWithProgress, reconcileGoalsForUser, updateUserGoal, type GoalKind, type GoalSpeedBucket, type UserGoalInput, type UserGoalTargetPatch } from "../features/goals.js";
import { getMyDataSummary, getUserTopPlaysFeed, getUserTrackedFeed, type MyDataTopPlaysQuery, type MyDataTrackedFeedQuery } from "../features/my-data.js";
import { getPlayerSkillBreakdown } from "../features/player-skills.js";
import { decoratePlayerSkillBreakdown } from "../features/skill-baseline.js";
import { FARM_HELPER_DEFAULT_LIMIT, FARM_HELPER_MAX_LIMIT, FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperNeighbors, getFarmHelperSnapshot, invalidateFarmHelperCacheForUser, type FarmHelperKeyMode, type FarmHelperView } from "../features/farm-helper.js";
import { clearFarmHelperFeedback, listFarmHelperFeedback, normalizeFarmHelperFeedbackSpeedBucket, normalizeFarmHelperFeedbackVerdict, setFarmHelperFeedback } from "../features/farm-helper-feedback.js";
import { FarmHelperTimings, timeStage } from "../features/farm-helper-timing.js";
import type { ScoreSpeedBucket } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";
import { enqueueGlobalRankingStatRepairs, getCountryRankingsSnapshot, getGlobalRankingsSnapshot, getPackPoolMembership, type GlobalRankingsSort } from "../features/global-rankings.js";
import { enqueueGlobalMapsRefresh, enqueueGlobalMapsRefreshIfDue, enqueueMapsRefresh, enqueueMapsRefreshIfDue, getMapsPageSnapshot, getMapsPlayersSnapshot, getMapsRandomBeatmapsets, getMapsRandomDraw, getMapsRefreshProgress, getMapsSnapshotMeta, MAPS_PLAYERS_MAX_PAGE_SIZE, MAPS_RANDOM_DRAW_DEFAULT_COUNT, MAPS_RANDOM_DRAW_EXCLUDE_SETS_MAX, MAPS_RANDOM_DRAW_EXCLUDE_USERS_MAX, MAPS_RANDOM_DRAW_HIDE_USERS_MAX, MAPS_RANDOM_DRAW_MAX_COUNT, MAPS_RANDOM_DRAW_STAR_MAX, MAPS_RANDOM_KEY_BUCKETS, MAPS_RANDOM_PATTERN_NAMES, MAPS_RANDOM_STATUS_BUCKETS, type MapsPageQuery, type MapsPlayersKind, type MapsPlayersPageQuery, type MapsRandomDrawQuery } from "../features/maps.js";
import { getMapSearchPage, getMapSearchSetEntry, MAP_SEARCH_PATTERNS, MAP_SEARCH_SUB_PATTERNS, type MapSearchQuery, type MapSearchSort } from "../features/map-search.js";
import { getMapCollection, getMapCollections, getMapCollectionsRotation, rebuildMapCollections } from "../features/map-collections.js";
import { applyPackCollectionCardMint, getPackCollectionPoolProgress, getPackWallet, HONORARY_USER_IDS, listPackCollectionCards,
  listPackCollectionOwnedCardKeys, normalizePackCardKey, PACK_COLLECTION_MAX_PAGE_SIZE, recyclePackCollectionCards, savePackWallet } from "../features/pack-wallets.js";
import { getHonoraryPullsReport, getPackCardCollectors, getPackCardStats, getPackPulledStats, getSharedPackCard, listPackPullsByIds, listRecentPackPulls, PACK_PULL_MAX_CARDS_PER_EVENT, recordPackPullEvents } from "../features/pack-pulls.js";
import { createPackDuel, getPackDuel, joinPackDuel, pickPackDuelStat, redactDuelFor } from "../features/pack-duels.js";
import {
  getPackGameAllowance,
  getStreakPlayerMetrics,
  grantPackGameShards,
  STREAK_METRICS_MAX_IDS,
  streakShardReward,
} from "../features/pack-games.js";
import { getCachedPackCardSnapshot, getCachedPackCardSnapshots, PACK_CARD_SNAPSHOT_MAX_IDS, getCachedPlayerProfileSnapshot, getPlayerAbout, getPlayerProfileSnapshot, getPlayerRecentScores, getPlayerRecentScoresFromOsu, warmProfileSnapshots } from "../features/player-profiles.js";
import { getRankDeltaSnapshot } from "../features/rank-snapshots.js";
import { getSnipesSnapshot } from "../features/snipes.js";
import { getSweepReports } from "../features/sweeps-status.js";
import { getTopPlaysSnapshot, type TopPlaysSnapshotOptions } from "../features/top-plays.js";
import { getTrackerSnapshot, type TrackerSnapshotFilters } from "../features/tracker.js";
import { searchUsers as searchStoredUsers, USER_SEARCH_DEFAULT_LIMIT, USER_SEARCH_MAX_LIMIT } from "../features/user-search.js";
import { type AbuseBucket, type AbuseGuard, normalizeCountryParam, type RateLimitResult } from "./abuse-guard.js";
import type { JobQueue } from "../jobs/queue.js";
import type { CountryClientTracker } from "../live/country-clients.js";
import type { LiveEventLog } from "../live/event-log.js";
// Type-only: live/ghost.ts imports helpers from this module, so a value import
// here would close the cycle.
import type { GhostHub } from "../live/ghost.js";
import { readJobMemoryMetric, readRuntimeStatus, setWorkersPaused, type RuntimeStatusSnapshot } from "../live/runtime-status.js";
import type { OscStatus } from "../osc/client.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getCachedBeatmapFile, normalizeBeatmapFileChecksum } from "../osu/beatmap-file-cache.js";
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
import { appendSkinScreenshot, attachSkinOsk, attachSkinPreview, createPendingSkin, deleteSkin, findPublishedSkinByOskSha256, finishSkin, finishSkinEdit, getSkin, getSkinByRef, getSkinForEdit, getSkinForUpload, listSkins, moveSkinOskKey, privateSkinSecretMatches, recordSkinDownload, renameSkin, replaceSkinOsk, setSkinAccent, setSkinCoverKeymode, setSkinHidden, setSkinSpecialKeymodes, setSkinVisibility, SKIN_MAX_SCREENSHOTS, startSkinEdit, toSkinSummary, upsertSkinKeymodePreview, type SkinRow } from "../features/skins.js";
import { clearUserReplaySkin, getUserReplaySkin, setUserReplaySkin, USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS } from "../features/user-replay-skins.js";
import { copySkinObject, deleteSkinObjects, getSkinObject, isPrivateSkinKey, isSkinStorageConfigured, nextSkinOskRevision, nextSkinPreviewRevision, oskFilename, privateSkinKey, skinKeymodePreviewKey, skinOskKey, skinPreviewKey, skinScreenshotKey, uploadSkinObject } from "../skins/r2.js";
import { readCachedSkinImage } from "../skins/image-cache.js";
import { getReplaySkinBundle, replaySkinBundleVersion } from "../skins/replay-bundle.js";
import { sniffImage, validateOskBuffer } from "../skins/validate-osk.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import { COMPRESSIBLE_MIN_BYTES, prepareJsonResponse, type PreparedJsonResponse } from "./prepared-json.js";
import { getMapsSnapshotThread, mapsSnapshotThreadStatus, MapsSnapshotBuildError, type MapsSnapshotThreadBuildRequest } from "./maps-snapshot-thread.js";
import { addManualRosterMember, enqueueRosterRefreshes, removeManualRosterMember } from "../rosters/country-rosters.js";
import { getDbDiskUsage, getLocalDbStorage, getStorageBreakdownSnapshot, getStorageFootprint, getTablePreview, runRetention } from "../retention.js";
import { readProcessMemory, type ProcessMemorySample } from "../shared/process-memory.js";
import { setUserActive, wipeUserProjections } from "../users.js";
import { getDiscordPublicInfo, type DiscordRuntime } from "../discord/index.js";
import { getDiscordShowcase } from "../discord/showcase.js";
import { listAllSubscriptions, removeSubscriptionById } from "../discord/subscriptions.js";
import { countUserLinks } from "../discord/identity.js";
import { OSU_API_BOUND_JOB_TYPES } from "../workers.js";
import { MAX_VIEWER_EVENT_ROWS, MAX_VIEWER_ROWS, type AnalyticsStore } from "../features/analytics.js";
import {
  attachViewerRanks,
  normalizeAnalyticsViewerSort,
  sortRankedViewers,
} from "../features/analytics-viewer-ranks.js";

const HIDDEN_ADMIN_WORKER_LANE_NAMES = new Set([
  "dan-estimates",
  "replay-video-render",
  "replay-video-finalize",
]);

// Admin-only viewer roster responses; see the /api/admin/analytics/viewers
// handler. Process-wide is fine: one serving process owns the analytics store.
const ANALYTICS_VIEWERS_CACHE_TTL_MS = 15_000;
const analyticsViewersCache = new Map<string, { at: number; payload: unknown }>();

export interface HttpContext {
  db: Db;
  queue: JobQueue;
  // Dedicated write connection + queue for the page-serving path's best-effort
  // bookkeeping (country touch + refresh scheduling). Kept off `db` so those
  // writes never share the connection that serves a page-load read: a stuck
  // write on the serving connection would otherwise queue behind it and freeze
  // every read (the whole-site freeze this fixes). Absent in tests / worker role,
  // in which case the serving path stays read-only and skips the bookkeeping.
  serveWriteDb?: Db;
  serveWriteQueue?: JobQueue;
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
  analytics?: AnalyticsStore;
  // Admin ghost overlay sessions and viewer streams (serving process only).
  ghost?: GhostHub;
}

const REQUEST_STARTED_AT = Symbol("maniaHubRequestStartedAt");
// Stage-level Farm Helper timings, stashed on the request so both the response
// header and the slow-request log in routeHttp's finally can read them without
// threading a collector through every send helper.
const REQUEST_FARM_HELPER_TIMINGS = Symbol("maniaHubFarmHelperTimings");
type TimedRequest = IncomingMessage & {
  [REQUEST_STARTED_AT]?: number;
  [REQUEST_FARM_HELPER_TIMINGS]?: FarmHelperTimings;
};

// Local libsql runs queries synchronously on the event loop, so one slow
// handler stalls every other request on the process. Log anything slow so the
// offender names itself instead of needing a live stall hunt. Streaming
// endpoints are exempt: their handlers legitimately stay open for as long as
// the client keeps reading.
const SLOW_HTTP_LOG_MS = 2_000;
const SLOW_HTTP_LOG_EXEMPT = new Set(["/api/live", "/api/audio", "/api/hitsounds", "/api/preview-audio", "/api/storyboard"]);

// Beatmap media: served before the general public gate, rate-limited on their
// own window (see the dispatch block for why).
const MEDIA_PATHS = new Set(["/api/audio", "/api/hitsounds", "/api/preview-audio", "/api/storyboard"]);
const MEDIA_RATE_SUFFIX = "media";

export async function routeHttp(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  const startedAt = performance.now();
  (req as TimedRequest)[REQUEST_STARTED_AT] = startedAt;
  try {
    return await routeHttpUnsafe(req, res, ctx);
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(req, res, ctx, error.status, { error: error.code, message: error.message });
      return true;
    }
    throw error;
  } finally {
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_HTTP_LOG_MS) {
      const pathname = (req.url ?? "/").split("?")[0];
      if (!SLOW_HTTP_LOG_EXEMPT.has(pathname)) {
        logWarn("slow_http_request", {
          path: pathname,
          method: req.method ?? "",
          status: res.statusCode,
          country: /[?&]country=([A-Za-z]{2,6})/.exec(req.url ?? "")?.[1]?.toUpperCase() ?? null,
          // One path can serve very different work (cached-snapshot's card vs
          // full view, a lookup by id vs username). Without these, a stall hunt
          // can only guess which caller is behind the slow path.
          view: /[?&]view=([A-Za-z]{1,16})/.exec(req.url ?? "")?.[1] ?? null,
          lookup: /[?&]lookup=([A-Za-z]{1,16})/.exec(req.url ?? "")?.[1] ?? null,
          duration_ms: Math.round(durationMs),
          // Farm Helper only: which stage spent the time, plus the peer/row
          // counts behind it. No profile payloads or score data.
          ...((req as TimedRequest)[REQUEST_FARM_HELPER_TIMINGS]?.toLogFields() ?? {}),
        });
      }
    }
  }
}

// sendJson for the surfaces that render player names: attaches avatar accents next to every
// avatar URL in the payload (and queues extraction for unseen avatars). Additive only; an
// enrichment failure still sends the plain payload.
async function sendAccentEnrichedJson(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, status: number, body: unknown): Promise<void> {
  await enrichPayloadAvatarAccents(ctx.db, ctx.queue ?? null, body);
  sendJson(req, res, ctx, status, body);
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
  // Media stays ahead of the publicApi gate on purpose: an <audio> element
  // issues several Range requests for one track, and those must not spend the
  // page's general API budget. They are not free, though — a cold hit pulls an
  // up-to-120 MiB .osz, spawns ffmpeg and uploads to R2 — so they get the
  // costly ceiling on their own window (MEDIA_RATE_SUFFIX). A shared window
  // with the costly JSON endpoints would break real pages: the maps Random tab
  // spends the same budget on maps-random-draw with every reroll.
  if (MEDIA_PATHS.has(url.pathname)) {
    if (!checkRate(req, res, ctx, "publicCostly", MEDIA_RATE_SUFFIX)) return true;
    if (url.pathname === "/api/audio") await handleBeatmapAudioRequest(req, res, ctx.config, url);
    else if (url.pathname === "/api/hitsounds") await handleBeatmapHitsoundsRequest(req, res, ctx.config, url);
    else if (url.pathname === "/api/storyboard") await handleBeatmapStoryboardRequest(req, res, ctx.config, url);
    else await handlePreviewAudioRequest(req, res, ctx.config, url);
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
    sendJson(req, res, ctx, 200, healthBody(ctx));
    return true;
  }
  if (url.pathname === "/readyz") {
    const ok = await dbHealth(ctx.db);
    sendJson(req, res, ctx, ok ? 200 : 503, healthBody(ctx, { db: ok }));
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
  // Player search off the stored users table. The site's search boxes call this
  // per typed query, so it must never cost an osu! API call: the ~45/min budget
  // in osu/client.ts is shared with ingest and would be spent on typing alone.
  if (url.pathname === "/api/users/search") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const query = url.searchParams.get("q") ?? "";
    const limit = clampInteger(url.searchParams.get("limit"), 1, USER_SEARCH_MAX_LIMIT, USER_SEARCH_DEFAULT_LIMIT);
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    await sendAccentEnrichedJson(req, res, ctx, 200, { users: await searchStoredUsers(ctx.db, query, limit) });
    return true;
  }
  if (url.pathname === "/api/discord/info") {
    res.setHeader("cache-control", "public, max-age=60");
    sendJson(req, res, ctx, 200, getDiscordPublicInfo(ctx.config));
    return true;
  }
  // Real-data backing for the /discord command showcase. Costly (it reads
  // profiles, boards, maps and dan), so it lives behind the costly rate bucket
  // and is cached server-side per country; `fresh=1` bypasses the cache for the
  // page's manual refresh. It only ever surfaces public top-board players, so it
  // takes no user id (no arbitrary-user lookups).
  if (url.pathname === "/api/discord/showcase") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const fresh = url.searchParams.get("fresh") === "1";
    res.setHeader("cache-control", "public, max-age=300");
    sendJson(req, res, ctx, 200, await getDiscordShowcase(ctx, country, fresh));
    return true;
  }
  const profileRoute = parseProfileRoute(url.pathname);
  if (profileRoute) {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (profileRoute.kind === "cached-snapshot") {
      await handleCachedProfileSnapshot(req, res, ctx, url, profileRoute.key);
      return true;
    }
    if (profileRoute.kind === "snapshot") {
      if (!checkRate(req, res, ctx, "publicCostly")) return true;
      const lookupMode = url.searchParams.get("lookup") === "id" ? "userId" : "auto";
      // refresh=0 opts out of the read's background refresh. Only the pack card
      // path passes it: a card already accepts a stale profile, and a hand whose
      // batch probe was rejected used to fan out into one priority-80 refresh
      // per card (4k parked jobs on prod, 2026-08-03). The profile page and the
      // farm helper must keep the default -- the queue is the only way a stored
      // profile ever gets refreshed.
      const wantsRefresh = url.searchParams.get("refresh") !== "0";
      await sendAccentEnrichedJson(req, res, ctx, 200, await getPlayerProfileSnapshot(
        ctx.serveWriteDb ?? ctx.db,
        ctx.osu,
        profileRoute.key,
        { queue: wantsRefresh ? ctx.serveWriteQueue ?? ctx.queue : null, lookupMode },
      ));
      return true;
    }
    const userId = Number(profileRoute.key);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (profileRoute.kind === "recent") {
      const source = url.searchParams.get("source") ?? "tracked";
      if (source !== "tracked" && source !== "osu") {
        sendJson(req, res, ctx, 400, { error: "invalid_recent_source" });
        return true;
      }
      if (source === "osu") {
        if (!checkRate(req, res, ctx, "publicCostly")) return true;
        sendJson(req, res, ctx, 200, await getPlayerRecentScoresFromOsu(
          ctx.serveWriteDb ?? ctx.db,
          ctx.osu,
          userId,
          { onFreshScores: (scores) => void ingestProfileRecentScores(ctx, userId, scores) },
        ));
        return true;
      }
      sendJson(req, res, ctx, 200, await getPlayerRecentScores(ctx.serveWriteDb ?? ctx.db, userId));
      return true;
    }
    if (profileRoute.kind === "activity") {
      sendJson(req, res, ctx, 200, await getPlayerActivitySnapshot(
        ctx.serveWriteDb ?? ctx.db,
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
        ctx.serveWriteDb ?? ctx.db,
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
    if (profileRoute.kind === "skills") {
      if (!checkRate(req, res, ctx, "publicCostly")) return true;
      // Reads always serve; compute enqueueing is reserved for players the
      // backend already knows (tracked roster members or players with a
      // stored profile snapshot), so anonymous visitors cannot flood the
      // MinaCalc lane with arbitrary user ids.
      const known = (await exec(ctx.db, "select 1 from country_rosters where user_id = ? limit 1", [userId])).rows[0]
        ?? (await exec(ctx.db, "select 1 from profile_snapshots where user_id = ? limit 1", [userId])).rows[0];
      const breakdown = await getPlayerSkillBreakdown(ctx.db, ctx.queue, userId, { allowEnqueue: !!known });
      res.setHeader("cache-control", "public, max-age=60");
      sendJson(req, res, ctx, 200, await decoratePlayerSkillBreakdown(ctx.db, userId, breakdown));
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    sendJson(req, res, ctx, 200, await getPlayerAbout(ctx.serveWriteDb ?? ctx.db, ctx.osu, userId));
    return true;
  }
  // In-house analytics capture: the frontend /api/sync proxy posts every tracked
  // event here (server-to-server, bearer-token gated — the browser never talks
  // to this endpoint directly).
  if (url.pathname === "/api/analytics/capture") {
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ payload?: unknown; geo_country?: unknown; is_bot?: unknown; client_key?: unknown }>((await readBody(req)) || "{}", {});
    const accepted = ctx.analytics.capture(body.payload, {
      geoCountry: typeof body.geo_country === "string" ? body.geo_country : null,
      isBot: body.is_bot === true,
      clientKey: typeof body.client_key === "string" ? body.client_key.slice(0, 64) : null,
    });
    sendJson(req, res, ctx, 202, { accepted });
    return true;
  }
  if (url.pathname === "/api/admin/analytics/monitor") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    sendJson(req, res, ctx, 200, await ctx.analytics.getMonitorData({
      rangeHours: Number(url.searchParams.get("rangeHours")) || 24,
      recentCountry: url.searchParams.get("recentCountry"),
      recentLimit: Number(url.searchParams.get("recentLimit")) || undefined,
    }));
    return true;
  }
  if (url.pathname === "/api/admin/analytics/valley") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    sendJson(req, res, ctx, 200, await ctx.analytics.getValleyVisitors());
    return true;
  }
  // The signed-in roster: not range-scoped, so it gets its own endpoint rather
  // than riding along on every 5s monitor poll.
  if (url.pathname === "/api/admin/analytics/viewers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    const requested = Number(url.searchParams.get("limit") ?? 500);
    const limit = Number.isFinite(requested) ? Math.min(2000, Math.max(1, Math.round(requested))) : 500;
    const sort = normalizeAnalyticsViewerSort(url.searchParams.get("sort"));
    // Where these players browsed from, which is the country their row already
    // shows. GLOBAL is a scope name here, not a place anyone signs in from.
    const requestedCountry = normalizeCountryParam(url.searchParams.get("country"));
    const viewerCountry = requestedCountry && requestedCountry !== "GLOBAL" ? requestedCountry : null;
    // The roster changes on the minutes scale but the rank attachment reads
    // the main DB on the serving loop, so a short cache keeps tab switches and
    // the two frontend instances from re-paying it back to back.
    const viewersCacheKey = `${sort}:${limit}:${viewerCountry ?? "all"}`;
    const cachedViewers = analyticsViewersCache.get(viewersCacheKey);
    if (cachedViewers && Date.now() - cachedViewers.at < ANALYTICS_VIEWERS_CACHE_TTL_MS) {
      sendJson(req, res, ctx, 200, cachedViewers.payload);
      return true;
    }
    // "Best players on the site" has to mean best of everyone who signed in, so
    // pp and rank read the whole roster and cut it down after sorting. Recent
    // needs no such scan: the roster comes back in that order already.
    const scanned = await ctx.analytics.getViewers(sort === "recent" ? limit : MAX_VIEWER_ROWS, viewerCountry);
    const ranked = sortRankedViewers(await attachViewerRanks(ctx.db, scanned), sort);
    const viewersTotal = await ctx.analytics.countViewers();
    const viewersPayload = {
      total: viewersTotal,
      // How many the filter matches at all, which is what the page in hand is
      // cut from. Equal to the total when no country is asked for.
      matched: viewerCountry ? await ctx.analytics.countViewers(viewerCountry) : viewersTotal,
      country: viewerCountry,
      countries: await ctx.analytics.getViewerCountries(),
      sort,
      viewers: ranked.slice(0, limit),
    };
    if (analyticsViewersCache.size > 16) analyticsViewersCache.clear();
    analyticsViewersCache.set(viewersCacheKey, { at: Date.now(), payload: viewersPayload });
    sendJson(req, res, ctx, 200, viewersPayload);
    return true;
  }
  // One signed-in player's recent trail, asked for from the roster card. Read
  // on demand rather than folded into the roster: nobody needs 756 trails.
  if (url.pathname === "/api/admin/analytics/viewer-events") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    const viewerId = Number(url.searchParams.get("viewerId"));
    if (!Number.isFinite(viewerId) || viewerId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_viewer_id" });
      return true;
    }
    const requestedEvents = Number(url.searchParams.get("limit") ?? MAX_VIEWER_EVENT_ROWS);
    const eventLimit = Number.isFinite(requestedEvents)
      ? Math.min(MAX_VIEWER_EVENT_ROWS, Math.max(1, Math.round(requestedEvents)))
      : MAX_VIEWER_EVENT_ROWS;
    sendJson(req, res, ctx, 200, { viewerId, events: await ctx.analytics.getViewerEvents(viewerId, eventLimit) });
    return true;
  }
  // Short-lived ticket for the admin browser's live SSE stream: EventSource
  // can't send Authorization headers, and baking the real admin token into a
  // URL would leak it into history/proxy logs.
  if (url.pathname === "/api/admin/analytics/live-ticket") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    sendJson(req, res, ctx, 200, ctx.analytics.issueLiveTicket());
    return true;
  }
  // Realtime admin feed: pushes every accepted capture (post feed-visibility
  // filters) the moment it arrives, ~1s ahead of it being queryable.
  if (url.pathname === "/api/admin/analytics/live") {
    if (!ctx.analytics) {
      sendJson(req, res, ctx, 404, { error: "analytics_disabled" });
      return true;
    }
    const store = ctx.analytics;
    if (!isAdmin(req, ctx) && !store.consumeLiveTicket(url.searchParams.get("ticket"))) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendCors(req, res, ctx);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ status: "connected" })}\n\n`);
    const unsubscribe = store.subscribe((record) => {
      if (!store.feedFilterAccepts(record)) return;
      res.write(`event: analytics_event\ndata: ${JSON.stringify(store.buildFeedEvent(record))}\n\n`);
    });
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    }, 15_000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
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
  if (url.pathname === "/api/admin/honorary-pulls") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // The roster comes from the same allowlist that guards the GOAT tier on
    // sync, so this reports on exactly the ids that can hold it.
    sendJson(req, res, ctx, 200, await getHonoraryPullsReport(ctx.db, HONORARY_USER_IDS));
    return true;
  }
  if (url.pathname === "/api/admin/storage-breakdown") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // Per-table bytes answer "what is in the database"; disk + per-path answer
    // "what else is on the volume", which is the half that decides whether the
    // box runs out of room. The storage modal is the only place either belongs.
    const [breakdown, disk, storagePaths] = await Promise.all([
      getStorageBreakdownSnapshot(ctx.db, ctx.config),
      getDbDiskUsage(ctx.config),
      getStorageFootprint(ctx.config),
    ]);
    sendJson(req, res, ctx, 200, { ...breakdown, disk, storagePaths });
    return true;
  }
  if (url.pathname === "/api/admin/table-rows") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const table = url.searchParams.get("table") ?? "";
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const search = url.searchParams.get("search") ?? "";
    const preview = await getTablePreview(ctx.db, table, limit, offset, search);
    if (!preview) {
      sendJson(req, res, ctx, 404, { error: "unknown_table" });
      return true;
    }
    sendJson(req, res, ctx, 200, preview);
    return true;
  }
  if (url.pathname === "/api/admin/set-user-active") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; username?: unknown; active?: unknown }>((await readBody(req)) || "{}", {});
    const active = body.active === true || body.active === 1 || body.active === "1";
    let userId = Number(body.userId);
    let userRow = Number.isInteger(userId) && userId > 0
      ? (await exec(ctx.db, "select user_id, username from users where user_id = ? limit 1", [userId])).rows[0]
      : undefined;
    if (!userRow) {
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (username) {
        userRow = (await exec(ctx.db, "select user_id, username from users where lower(username) = lower(?) limit 1", [username])).rows[0];
        if (userRow) userId = Number(userRow.user_id);
      }
    }
    if (!userRow || !Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 404, { error: "user_not_found" });
      return true;
    }
    const result = await setUserActive(ctx.serveWriteDb ?? ctx.db, userId, active, "admin: manual toggle");
    sendJson(req, res, ctx, 200, { ok: true, ...result });
    return true;
  }
  if (url.pathname === "/api/admin/wipe-user-data") {
    // Heavier sibling of set-user-active: deactivates AND permanently deletes
    // the player's public projection rows (boards, farmed scores, key stats,
    // skill ratings). The users row survives as the inactive tombstone.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; username?: unknown }>((await readBody(req)) || "{}", {});
    let userId = Number(body.userId);
    let userRow = Number.isInteger(userId) && userId > 0
      ? (await exec(ctx.db, "select user_id, username from users where user_id = ? limit 1", [userId])).rows[0]
      : undefined;
    if (!userRow) {
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (username) {
        userRow = (await exec(ctx.db, "select user_id, username from users where lower(username) = lower(?) limit 1", [username])).rows[0];
        if (userRow) userId = Number(userRow.user_id);
      }
    }
    if (!userRow || !Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 404, { error: "user_not_found" });
      return true;
    }
    const username = userRow.username == null ? null : String(userRow.username);
    const result = await wipeUserProjections(ctx.serveWriteDb ?? ctx.db, userId);
    logInfo("admin_wipe_user_data", { userId, username, deleted: result.deleted, untrackedRosters: result.untrackedRosters, deletedJobs: result.deletedJobs });
    sendJson(req, res, ctx, 200, {
      ok: true,
      userId,
      username,
      untrackedRosters: result.untrackedRosters,
      deletedJobs: result.deletedJobs,
      deleted: result.deleted,
    });
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
      ? await removeManualRosterMember(ctx.serveWriteDb ?? ctx.db, memberCountry, memberUserId)
      : await addManualRosterMember(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.config, memberCountry, memberUserId);
    sendJson(req, res, ctx, result.ok ? 200 : 409, result);
    return true;
  }
  if (url.pathname === "/api/goals" || url.pathname === "/api/goals/create" || url.pathname === "/api/goals/update" || url.pathname === "/api/goals/delete") {
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
      await reconcileGoalsForUser(ctx.serveWriteDb ?? ctx.db, ctx.events, userId).catch(() => {});
      sendJson(req, res, ctx, 200, { goals: await listUserGoalsWithProgress(ctx.db, userId) });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; id?: unknown; kind?: unknown; country?: unknown; beatmapId?: unknown; beatmapsetId?: unknown; beatmapLabel?: unknown; targetValue?: unknown; targetCount?: unknown; targetGrade?: unknown; speedBucket?: unknown; note?: unknown }>((await readBody(req)) || "{}", {});
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
      const ok = await deleteUserGoal(ctx.serveWriteDb ?? ctx.db, userId, id);
      sendJson(req, res, ctx, ok ? 200 : 404, { ok });
      return true;
    }
    if (url.pathname === "/api/goals/update") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        sendJson(req, res, ctx, 400, { error: "invalid_goal" });
        return true;
      }
      const existing = await getUserGoal(ctx.db, id);
      if (!existing || existing.userId !== userId || existing.status !== "open") {
        sendJson(req, res, ctx, 404, { ok: false, error: "goal_not_editable" });
        return true;
      }
      const targets = parseGoalTargets(existing.kind, body);
      if ("error" in targets) {
        sendJson(req, res, ctx, 400, { error: targets.error });
        return true;
      }
      const updated = await updateUserGoal(ctx.serveWriteDb ?? ctx.db, userId, id, targets.fields);
      if (!updated) {
        sendJson(req, res, ctx, 404, { ok: false, error: "goal_not_editable" });
        return true;
      }
      // A lowered target may already be satisfied by stored projections; settle it right away.
      await reconcileGoalsForUser(ctx.serveWriteDb ?? ctx.db, ctx.events, userId, [existing.kind]).catch(() => {});
      sendJson(req, res, ctx, 200, { ok: true, goal: (await getUserGoal(ctx.db, id)) ?? updated });
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
    const targets = parseGoalTargets(kind, body);
    if ("error" in targets) {
      sendJson(req, res, ctx, 400, { error: targets.error });
      return true;
    }
    Object.assign(input, targets.fields);
    if (typeof body.note === "string") input.note = body.note;
    const created = await createUserGoal(ctx.serveWriteDb ?? ctx.db, ctx.queue, input);
    // A just-created goal may already be satisfied by the player's stored tracker/top-play data.
    await reconcileGoalsForUser(ctx.serveWriteDb ?? ctx.db, ctx.events, userId, [kind]).catch(() => {});
    sendJson(req, res, ctx, 200, { ok: true, goal: (await getUserGoal(ctx.db, created.id)) ?? created });
    return true;
  }
  if (url.pathname === "/api/farm-helper/feedback" || url.pathname === "/api/farm-helper/feedback/set" || url.pathname === "/api/farm-helper/feedback/clear") {
    // Same trust contract as the goals endpoints above: admin-token gated and
    // called server-to-server, with the frontend server fn injecting the
    // osu!-verified viewer id, so a user only ever touches their own marks.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (url.pathname === "/api/farm-helper/feedback") {
      if (req.method !== "GET") {
        sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
        return true;
      }
      const userId = Number(url.searchParams.get("userId"));
      if (!Number.isInteger(userId) || userId <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
        return true;
      }
      sendJson(req, res, ctx, 200, { marks: await listFarmHelperFeedback(ctx.db, userId) });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; beatmapId?: unknown; speedBucket?: unknown; verdict?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const beatmapId = Number(body.beatmapId);
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap" });
      return true;
    }
    const speedBucket = normalizeFarmHelperFeedbackSpeedBucket(body.speedBucket);
    if (!speedBucket) {
      sendJson(req, res, ctx, 400, { error: "invalid_speed_bucket" });
      return true;
    }
    if (url.pathname === "/api/farm-helper/feedback/clear") {
      await clearFarmHelperFeedback(ctx.serveWriteDb ?? ctx.db, userId, beatmapId, speedBucket);
      // Evict the per-subject snapshot cache on the serving Db: snapshots are
      // built and cached against ctx.db, not the write connection.
      invalidateFarmHelperCacheForUser(ctx.db, userId);
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    const verdict = normalizeFarmHelperFeedbackVerdict(body.verdict);
    if (!verdict) {
      sendJson(req, res, ctx, 400, { error: "invalid_verdict" });
      return true;
    }
    const result = await setFarmHelperFeedback(ctx.serveWriteDb ?? ctx.db, { userId, beatmapId, speedBucket, verdict });
    if (!result.ok) {
      // Active-mark cap: the module refuses NEW lanes past the cap (updates
      // and reactivations stay exempt); surface that as a client error.
      sendJson(req, res, ctx, 400, { error: result.reason });
      return true;
    }
    const { ok: _ok, ...mark } = result;
    void _ok;
    invalidateFarmHelperCacheForUser(ctx.db, userId);
    sendJson(req, res, ctx, 200, { ok: true, mark });
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
    const summary = await getMyDataSummary(ctx.db, userId);
    const emptyTrackedPage = { items: [], total: 0, limit, offset: trackedOffset };
    const emptyTopPlayPage = { items: [], total: 0, limit, offset: topOffset };
    if (!summary.tracked) {
      sendJson(req, res, ctx, 200, { summary, trackedPage: emptyTrackedPage, topPlayPage: emptyTopPlayPage, skills: null });
      return true;
    }
    const [trackedPage, topPlayPage, skills] = await Promise.all([
      getUserTrackedFeed(ctx.db, userId, limit, trackedOffset),
      getUserTopPlaysFeed(ctx.db, userId, limit, topOffset),
      getPlayerSkillBreakdown(ctx.db, ctx.queue, userId)
        .then((breakdown) => decoratePlayerSkillBreakdown(ctx.db, userId, breakdown))
        .catch(() => null),
    ]);
    sendJson(req, res, ctx, 200, { summary, trackedPage, topPlayPage, skills });
    return true;
  }
  if (url.pathname === "/api/my-data/skills") {
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
    const breakdown = await getPlayerSkillBreakdown(ctx.db, ctx.queue, userId);
    sendJson(req, res, ctx, 200, await decoratePlayerSkillBreakdown(ctx.db, userId, breakdown));
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
    const page = await getUserTrackedFeed(ctx.db, userId, limit, offset, readMyDataTrackedQuery(url.searchParams));
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
    const page = await getUserTopPlaysFeed(ctx.db, userId, limit, offset, readMyDataTopPlaysQuery(url.searchParams));
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
    const userIds = parseUserIds(url.searchParams.get("userIds"));
    const produceSnapshot = () => getTrackerSnapshot(ctx.db, country, limit, offset, {
      since: windowHours > 0 ? new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString() : undefined,
      filters,
      sort,
      sortDirection,
      userIds,
    });
    const snapshot = global
      ? await getCachedGlobalTrackerSnapshot(
          [windowHours, limit, offset, filters.score ?? "", filters.grade ?? "", filters.key ?? "", filters.miss ?? "", sort, sortDirection, userIds.join(",")].join("|"),
          produceSnapshot,
        )
      : await produceSnapshot();
    await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/top-plays") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    await sendAccentEnrichedJson(req, res, ctx, 200, await getTopPlaysSnapshot(ctx.db, country, url.searchParams.get("window") ?? "7d", parseTopPlaysSnapshotQuery(url.searchParams)));
    return true;
  }
  if (url.pathname === "/api/snapshots/snipes") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    await sendAccentEnrichedJson(req, res, ctx, 200, await getSnipesSnapshot(ctx.db, country, clampLimit(url.searchParams.get("limit"), 500, 1000)));
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
  if (url.pathname === "/api/snapshots/maps-random-draw") {
    // A draw is uncacheable by construction (it samples), so it is the one maps
    // route that can be made to do real work on every request — hence the
    // costly bucket on top of the blanket public gate.
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    res.setHeader("cache-control", "no-store");
    const draw = await getMapsRandomDraw(ctx.db, ctx.queue, country, ctx.config.mapsRefreshIntervalMs, parseMapsRandomDrawQuery(url.searchParams));
    // 202 while the country's first maps build is still running, matching the
    // pool endpoint it replaces; the client polls on a null value either way.
    await sendAccentEnrichedJson(req, res, ctx, draw.value ? 200 : 202, draw);
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
    await sendAccentEnrichedJson(req, res, ctx, 200, await getMapsPlayersSnapshot(ctx.db, country, kind, id, playersQuery));
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
  if (url.pathname === "/api/snapshots/maps-search") {
    // Global catalog search over every chart-analyzed map. No country activation;
    // an optional ?country= intersects with that roster's farmed/played maps.
    const snapshot = await getMapSearchPage(ctx.db, parseMapSearchQuery(url.searchParams));
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    sendJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/map-search-entry") {
    // Single shareable entry for /maps?map=<beatmapId> links; no country
    // activation, same global catalog as maps-search.
    const beatmapId = clampInteger(url.searchParams.get("beatmapId"), 1, Number.MAX_SAFE_INTEGER, 0);
    if (beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap_id" });
      return true;
    }
    const entry = await getMapSearchSetEntry(ctx.db, beatmapId);
    if (!entry) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=900");
    sendJson(req, res, ctx, 200, { entry });
    return true;
  }
  if (url.pathname === "/api/snapshots/map-collections") {
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=900");
    sendJson(req, res, ctx, 200, {
      collections: await getMapCollections(ctx.db),
      rotation: await getMapCollectionsRotation(ctx.db, ctx.config.mapCollectionsRefreshIntervalMs),
    });
    return true;
  }
  if (url.pathname === "/api/snapshots/map-collection") {
    const id = (url.searchParams.get("id") ?? "").trim();
    if (!id) {
      sendJson(req, res, ctx, 400, { error: "missing_id" });
      return true;
    }
    const collection = await getMapCollection(ctx.db, id);
    if (!collection) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=900");
    sendJson(req, res, ctx, 200, { collection });
    return true;
  }
  if (url.pathname === "/api/snapshots/rankings") {
    if (isGlobalCountry(country)) {
      const query = parseGlobalRankingsQuery(url.searchParams);
      const snapshot = await getGlobalRankingsSnapshot(ctx.db, query);
      // Detached: repairs are background work and their queue writes must not
      // delay the response under write contention. Pack-pool reads skip them:
      // the repairs feed leaderboard stat columns packs never show, and a
      // manual member with a thin profile would re-enqueue their country's
      // roster refresh on every pack open without ever gaining a rank.
      if (query.pool !== "packs") {
        void enqueueGlobalRankingStatRepairs(ctx.queue, snapshot.ranking).catch((error) => {
          console.warn("[global-rankings] failed to queue stat repair", error);
        });
      }
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
      return true;
    }
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const snapshot = await getCountryRankingsSnapshot(ctx.db, country, parseGlobalRankingsQuery(url.searchParams));
    // Detached: repairs are background work and their queue writes must not
    // delay the response under write contention.
    void enqueueGlobalRankingStatRepairs(ctx.queue, snapshot.ranking).catch((error) => {
      console.warn("[country-rankings] failed to queue stat repair", error);
    });
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/global-rankings") {
    const query = parseGlobalRankingsQuery(url.searchParams);
    const snapshot = await getGlobalRankingsSnapshot(ctx.db, query);
    // Detached: repairs are background work and their queue writes must not
    // delay the response under write contention. Pack-pool reads skip them
    // (see the /api/snapshots/rankings GLOBAL branch).
    if (query.pool !== "packs") {
      void enqueueGlobalRankingStatRepairs(ctx.queue, snapshot.ranking).catch((error) => {
        console.warn("[global-rankings] failed to queue stat repair", error);
      });
    }
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
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
    // Stage timings: which part of a slow build actually cost the time. Kept on
    // the request so setServerTiming and the slow log can both read it.
    const timings = new FarmHelperTimings();
    (req as TimedRequest)[REQUEST_FARM_HELPER_TIMINGS] = timings;
    try {
      const snapshot = await getFarmHelperSnapshot(ctx.db, ctx.osu, userKey, {
        keyMode: parseFarmHelperKeyMode(url.searchParams.get("key")),
        view: parseFarmHelperView(url.searchParams.get("view")),
        limit: clampInteger(url.searchParams.get("limit"), 1, FARM_HELPER_MAX_LIMIT, FARM_HELPER_DEFAULT_LIMIT),
        // The build's read-time feedback reconcile writes; keep those writes
        // off the read connection that serves page loads (the serveWriteDb
        // invariant, same as the feedback mutation endpoints below).
      }, ctx.queue, { writeDb: ctx.serveWriteDb ?? ctx.db, timings });
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      await timeStage(timings, "fh_accents", () => enrichPayloadAvatarAccents(ctx.db, ctx.queue ?? null, snapshot));
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
        ctx.serveWriteQueue ?? ctx.queue,
      );
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      await sendAccentEnrichedJson(req, res, ctx, 200, result);
    } catch (error) {
      if (error instanceof FarmHelperUserNotFoundError) {
        sendJson(req, res, ctx, 404, { error: "user_not_found" });
        return true;
      }
      throw error;
    }
    return true;
  }
  if (url.pathname === "/api/snapshots/farm-helper-neighbors") {
    const userKey = (url.searchParams.get("user") ?? "").trim();
    if (!userKey) {
      sendJson(req, res, ctx, 400, { error: "missing_user" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    try {
      const result = await getFarmHelperNeighbors(
        ctx.db,
        ctx.osu,
        userKey,
        parseFarmHelperKeyMode(url.searchParams.get("key")),
        ctx.serveWriteQueue ?? ctx.queue,
      );
      res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=600");
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
  if (url.pathname === "/api/avatar-accents") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    sendJson(req, res, ctx, 200, { accents: await lookupAvatarAccents(ctx.db, ctx.queue ?? null, body.urls) });
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
    sendJson(req, res, ctx, 200, await getDanEstimateBatch(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.osu, items, {
      computeMissing: body.computeMissing !== false,
    }));
    return true;
  }
  if (url.pathname === "/api/chart-analysis") {
    // The stored lean classification for one beatmap: detected pattern hits in
    // the in-house vocabulary plus the LeoBlack cluster readout. Feeds the map
    // detail modal's keymode-honest pattern strip (MSD skillset names are 4K
    // vocabulary). Single-PK read; the global publicApi limiter covers it.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const beatmapId = Number(url.searchParams.get("beatmapId"));
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap_id" });
      return true;
    }
    const row = (await exec(
      ctx.db,
      `select status, key_count, classification_json, msd_json, msd_ln_json from beatmap_chart_analysis
       where beatmap_id = ? and analysis_version = ? limit 1`,
      [beatmapId, CHART_ANALYSIS_VERSION],
    )).rows[0];
    const classification = row?.status === "ready"
      ? parseJson<Record<string, unknown> | null>(String(row.classification_json ?? ""), null)
      : null;
    const readMsdValues = (raw: unknown): Record<string, number> | null => {
      if (raw == null) return null;
      const parsed = parseJson<{ values?: Record<string, number> } | null>(String(raw), null);
      return parsed && parsed.values && typeof parsed.values === "object" ? parsed.values : null;
    };
    const msdLn = row?.status === "ready"
      ? lnAdjustedMsd(readMsdValues(row.msd_json), readMsdValues(row.msd_ln_json), Number(row.key_count ?? 0))
      : null;
    sendJson(req, res, ctx, 200, {
      beatmapId,
      status: row ? String(row.status) : "missing",
      keyCount: row?.key_count == null ? null : Number(row.key_count),
      patterns: Array.isArray(classification?.patterns) ? classification.patterns : [],
      clusters: Array.isArray(classification?.clusters) ? classification.clusters : [],
      clusterCategory: typeof classification?.clusterCategory === "string" ? classification.clusterCategory : null,
      modeTag: typeof classification?.modeTag === "string" ? classification.modeTag : null,
      verdictText: typeof classification?.verdictText === "string" ? classification.verdictText : null,
      lnRatio: Number.isFinite(Number(classification?.lnRatio)) ? Number(classification?.lnRatio) : null,
      // LN-adjusted (tail-aware, keymode-blended) MSD; null for rice charts or
      // until the LN MSD sweep covers this chart.
      msdLn,
    });
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
      if (body.body !== undefined) {
        sendJson(req, res, ctx, 200, await ctx.osu.postJson(path, normalizeOsuApiBody(body.body), caller));
      } else {
        const cacheHints = normalizeOsuProxyCacheHints(body);
        if (cacheHints) {
          const cached = await getOsuJsonWithProxyCache(ctx.db, ctx.serveWriteDb ?? ctx.db, ctx.osu, path, caller, cacheHints);
          res.setHeader("x-osu-proxy-cache", cached.cache);
          sendJson(req, res, ctx, 200, cached.payload);
        } else {
          sendJson(req, res, ctx, 200, await ctx.osu.getJson(path, caller));
        }
      }
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
    sendJson(req, res, ctx, 202, await warmProfileSnapshots(ctx.serveWriteDb ?? ctx.db, ctx.osu, userIds));
    return true;
  }
  if (url.pathname === "/api/packs/cards") {
    // One hand of cards in one read. The per-player alternative is ten
    // concurrent cached-snapshot?view=card requests, which on a single-writer
    // SQLite process is ten interleaved reads that share no beatmap work and
    // spend ten trips through the rate limiter (see getCachedPackCardSnapshots).
    // Its own bucket rather than the shared costly one: a hand covers up to ten
    // players, and when pack bursts and ordinary browsing drew on the same
    // budget, a few Wild packs in a row left the rest of the site 429ing for the
    // remainder of the minute. No honest client opens 30 packs a minute either
    // way, and the blanket publicApi bucket still applies on top.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "packCards")) return true;
    const userIds = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((raw) => Math.floor(Number(raw) || 0))
      .filter((id) => id > 0)
      .slice(0, PACK_CARD_SNAPSHOT_MAX_IDS);
    if (userIds.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=15");
    // Uncached players are simply absent; the client's cold path mints them.
    await sendAccentEnrichedJson(req, res, ctx, 200, { cards: await getCachedPackCardSnapshots(ctx.db, userIds) });
    return true;
  }
  if (url.pathname === "/api/packs/pulls") {
    // Server-to-server only, like the wallet sync: the frontend's server
    // function authenticates the osu! login cookie and forwards the verified
    // viewer identity, so an event can only ever be logged as yourself.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const ownerUserId = Math.floor(Number(body.userId) || 0);
    const ownerUsername = typeof body.username === "string" ? body.username : "";
    if (ownerUserId <= 0 || !ownerUsername) {
      sendJson(req, res, ctx, 400, { error: "invalid_pull_owner" });
      return true;
    }
    const pullResult = await recordPackPullEvents(ctx.serveWriteDb ?? ctx.db, ownerUserId, ownerUsername, body.packType, body.cards);
    // Fan the new pulls out on the live stream: a null country reaches every
    // /api/live client, which is what makes the packs rail tick in real time
    // instead of on its next poll. Same feed-entry shape as recent-pulls, so
    // the client treats both sources identically. Best-effort: the pull log
    // is already durable, and a failed publish only costs immediacy (the
    // rail's poll backstop still picks the pull up).
    if (pullResult.eventIds.length > 0) {
      try {
        for (const entry of await listPackPullsByIds(ctx.db, pullResult.eventIds)) {
          await ctx.events.append("pack_pull", null, entry, `pack_pull:${entry.id}`, ctx.serveWriteDb);
        }
      } catch {
        // Covered by the poll backstop.
      }
    }
    sendJson(req, res, ctx, 202, { recorded: pullResult.recorded, mints: pullResult.mints });
    return true;
  }
  if (url.pathname === "/api/packs/card-stats") {
    // Community ownership counts for a hand of revealed cards. Public and
    // cheap (one grouped indexed count over pack_collection_cards).
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((raw) => Math.floor(Number(raw) || 0))
      .filter((id) => id > 0)
      .slice(0, PACK_PULL_MAX_CARDS_PER_EVENT);
    if (ids.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    sendJson(req, res, ctx, 200, { cards: await getPackCardStats(ctx.db, ids) });
    return true;
  }
  if (url.pathname === "/api/packs/streak-metrics") {
    // The streak game's question numbers for one page of the pool. Public
    // data (it all shows on osu! profiles), read entirely from local
    // projections: no osu! call, no job, and slow-moving enough that the
    // browser is told to keep a page of it for an hour on top of the
    // feature's own in-memory cache.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((raw) => Math.floor(Number(raw) || 0))
      .filter((id) => id > 0)
      .slice(0, STREAK_METRICS_MAX_IDS);
    if (ids.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=3600");
    sendJson(req, res, ctx, 200, { players: await getStreakPlayerMetrics(ctx.db, ids) });
    return true;
  }
  const packPulledStatsMatch = url.pathname.match(/^\/api\/packs\/pulled-stats\/(\d+)$/);
  if (packPulledStatsMatch) {
    // How the community holds one player's card ("your card got pulled").
    // Public aggregate counts, nothing per-viewer in the response.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const cardUserId = Number(packPulledStatsMatch[1]);
    if (!Number.isInteger(cardUserId) || cardUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getPackPulledStats(ctx.db, cardUserId));
    return true;
  }
  const packPulledByMatch = url.pathname.match(/^\/api\/packs\/pulled-by\/(\d+)$/);
  if (packPulledByMatch) {
    // Who holds one player's card, by name. Server-to-server only, like the
    // wallet sync: the frontend's server function resolves the id from the
    // osu! login cookie, so you can only ever list the collectors of your own
    // card. The public endpoint next to it stays a count.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const cardUserId = Number(packPulledByMatch[1]);
    if (!Number.isInteger(cardUserId) || cardUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getPackCardCollectors(ctx.db, cardUserId));
    return true;
  }
  const packPulledCardMatch = url.pathname.match(/^\/api\/packs\/pulled-card\/(\d+)\/(\d+)$/);
  if (packPulledCardMatch) {
    // One owned card as a shareable artifact: backs the /pull/{owner}/{card}
    // permalink page and its OG image. Public; reads the durable collection
    // row so the link outlives pull-event retention.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const shared = await getSharedPackCard(ctx.db, Number(packPulledCardMatch[1]), Number(packPulledCardMatch[2]));
    if (!shared) {
      sendJson(req, res, ctx, 404, { error: "pulled_card_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, shared);
    return true;
  }
  if (url.pathname === "/api/packs/recent-pulls") {
    // The public pull feed: notable-only by default (high mints and
    // first-ever pulls); ?all=1 includes every pull for the live ticker.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const limit = Number(url.searchParams.get("limit")) || 20;
    const notableOnly = url.searchParams.get("all") !== "1";
    sendJson(req, res, ctx, 200, { pulls: await listRecentPackPulls(ctx.db, limit, notableOnly) });
    return true;
  }
  if (url.pathname === "/api/packs/duels" && req.method === "POST") {
    // Opening a duel. Server-to-server like the pull log: the frontend's
    // server function authenticates the osu! cookie and forwards the verified
    // viewer, so a duel can only ever be opened as yourself.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const userId = Math.floor(Number(body.userId) || 0);
    const username = typeof body.username === "string" ? body.username : "";
    if (userId <= 0 || !username) {
      sendJson(req, res, ctx, 400, { error: "invalid_duel_challenger" });
      return true;
    }
    const created = await createPackDuel(ctx.serveWriteDb ?? ctx.db, userId, username, {
      packType: body.packType,
      cards: body.cards,
    });
    if (!created.ok) {
      sendJson(req, res, ctx, created.error === "rate_limited" ? 429 : 400, { error: created.error });
      return true;
    }
    sendJson(req, res, ctx, 201, created.duel);
    return true;
  }
  const packDuelActionMatch = url.pathname.match(/^\/api\/packs\/duels\/([a-z0-9]{6,16})\/(join|pick|view)$/);
  if (packDuelActionMatch) {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const userId = Math.floor(Number(body.userId) || 0);
    const username = typeof body.username === "string" ? body.username : "";
    if (userId <= 0 || !username) {
      sendJson(req, res, ctx, 400, { error: "invalid_duel_player" });
      return true;
    }
    const duelId = packDuelActionMatch[1];
    const writeDb = ctx.serveWriteDb ?? ctx.db;
    // Dev-only: one osu! account is enough to play both sides locally. Never
    // granted in production, where duelling yourself stays refused.
    const allowSelfDuel = ctx.config.nodeEnv !== "production";
    const action = packDuelActionMatch[2];
    if (action === "view") {
      // The signed-in read: your own hand is visible to you, and of theirs
      // only the cards already played.
      const duel = await getPackDuel(ctx.db, duelId);
      if (!duel) {
        sendJson(req, res, ctx, 404, { error: "duel_not_found" });
        return true;
      }
      sendJson(req, res, ctx, 200, redactDuelFor(duel, userId));
      return true;
    }
    const result = action === "pick"
      ? await pickPackDuelStat(writeDb, duelId, userId, body.round, body.stat)
      : await joinPackDuel(writeDb, duelId, userId, username, body.cards, Date.now(), { allowSelfDuel });
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : 409;
      sendJson(req, res, ctx, status, { error: result.error });
      return true;
    }
    // The player who just moved sees their own hand; the rest of the other
    // side stays face down until it is played.
    sendJson(req, res, ctx, 200, redactDuelFor(result.duel, userId));
    return true;
  }
  const packGameMatch = url.pathname.match(/^\/api\/packs\/games\/(streak|allowance)$/);
  if (packGameMatch) {
    // The arcade's till. Server-to-server like the pull log and the wallet:
    // the frontend's server function authenticates the osu! cookie and
    // forwards the verified viewer, so a run can only ever be claimed as
    // yourself. What stops a scripted run claiming all day is the daily
    // allowance inside grantPackGameShards, not this route.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const userId = Math.floor(Number(body.userId) || 0);
    if (userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_game_player" });
      return true;
    }
    if (packGameMatch[1] === "allowance") {
      sendJson(req, res, ctx, 200, await getPackGameAllowance(ctx.db, userId));
      return true;
    }
    const streak = Math.max(0, Math.floor(Number(body.streak) || 0));
    const result = await grantPackGameShards(
      ctx.serveWriteDb ?? ctx.db,
      userId,
      "streak",
      streakShardReward(streak),
    );
    sendJson(req, res, ctx, 200, result);
    return true;
  }
  const packDuelMatch = url.pathname.match(/^\/api\/packs\/duels\/([a-z0-9]{6,16})$/);
  if (packDuelMatch) {
    // Public read: a duel link is meant to be opened by whoever it was sent
    // to, and the page shows nothing but two hands of cards.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const duel = await getPackDuel(ctx.db, packDuelMatch[1]);
    if (!duel) {
      sendJson(req, res, ctx, 404, { error: "duel_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, redactDuelFor(duel, null));
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
      // getPackWallet can lazily rewrite legacy payloads, so it needs the write connection too.
      const wallet = await getPackWallet(ctx.serveWriteDb ?? ctx.db, walletUserId);
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
      const result = await savePackWallet(ctx.serveWriteDb ?? ctx.db, walletUserId, payload, Math.floor(baseRev), Date.now(), cardImportMode);
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
      // Repairing a card's missing skills snapshot: no economy change, so it
      // returns the card key rather than a wallet, and never bumps the rev.
      if (body.mode === "mint") {
        const result = await applyPackCollectionCardMint(
          ctx.serveWriteDb ?? ctx.db,
          walletUserId,
          body.cardKey,
          {
            tier: body.tier,
            tierLabel: body.tierLabel,
            skills: body.skills,
          },
        );
        sendJson(req, res, ctx, 200, result);
        return true;
      }
      const mode =
        body.mode === "duplicates" ||
        body.mode === "whole" ||
        body.mode === "all_duplicates" ||
        body.mode === "whole_matching"
        ? body.mode
        : null;
      // Cards are addressed by wallet key ("<id>" or "<id>:goat"), so a GOAT
      // and an ordinary card of the same player recycle independently.
      const cardKey = normalizePackCardKey(body.cardKey);
      const cardKeys = mode === "whole" && Array.isArray(body.cardKeys)
        ? body.cardKeys
            .slice(0, 500)
            .map(normalizePackCardKey)
            .filter((key): key is string => key !== null)
        : null;
      const hasBulkKeys = cardKeys !== null && cardKeys.length > 0;
      if (!mode || (mode !== "all_duplicates" && mode !== "whole_matching" && !hasBulkKeys && !cardKey)) {
        sendJson(req, res, ctx, 400, { error: "invalid_recycle_request" });
        return true;
      }
      const recycleTier = typeof body.tier === "string" ? body.tier : "all";
      // The "not tracked" filter recycles by player restriction, not by tier.
      // If the pool can't be read the restriction stays empty and nothing is
      // recycled; the alternative would recycle the whole collection.
      const recycleUntracked = mode === "whole_matching" && recycleTier === "untracked";
      const untrackedIds = recycleUntracked
        ? await getPackPoolMembership(ctx.db)
            .then((pool) => getPackCollectionPoolProgress(ctx.db, walletUserId, pool))
            .then((progress) => progress.offPoolUserIds)
            .catch(() => [] as number[])
        : undefined;
      const result = await recyclePackCollectionCards(ctx.serveWriteDb ?? ctx.db, walletUserId, {
        mode,
        cardKey: cardKey ?? undefined,
        cardKeys: hasBulkKeys ? cardKeys : undefined,
        tier: recycleUntracked ? "all" : recycleTier,
        query: typeof body.query === "string" ? body.query.slice(0, 120) : "",
        restrictToCardUserIds: untrackedIds,
      });
      sendJson(req, res, ctx, 200, { gained: result.gained, payload: result.wallet.payload, rev: result.wallet.rev });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (url.searchParams.get("ownedIds") === "1") {
      sendJson(req, res, ctx, 200, { cardKeys: await listPackCollectionOwnedCardKeys(ctx.db, walletUserId) });
      return true;
    }
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
    const pageSize = Math.min(
      PACK_COLLECTION_MAX_PAGE_SIZE,
      Math.max(1, Math.floor(Number(url.searchParams.get("pageSize")) || 15)),
    );
    const tier = url.searchParams.get("tier");
    const query = url.searchParams.get("q");
    // Progress is a garnish on the header; a pool board that cannot build
    // right now must not take the collection page down with it.
    const progress = await getPackPoolMembership(ctx.db)
      .then((pool) => getPackCollectionPoolProgress(ctx.db, walletUserId, pool))
      .catch(() => null);
    // "untracked" is not a tier: it lists the owned players who left the draw
    // pool. With no pool to compare against the filter honestly shows nothing.
    const untracked = tier === "untracked";
    const collectionPage = await listPackCollectionCards(ctx.db, walletUserId, {
      page,
      pageSize,
      tier: untracked ? "all" : tier,
      query,
      restrictToCardUserIds: untracked ? progress?.offPoolUserIds ?? [] : undefined,
    });
    sendJson(req, res, ctx, 200, {
      ...collectionPage,
      poolProgress: progress
        ? { poolTotal: progress.poolTotal, poolOwnedCount: progress.poolOwnedCount, retiredOwnedCount: progress.retiredOwnedCount }
        : null,
    });
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
    const rawChecksum = url.searchParams.get("checksum");
    const expectedChecksum = normalizeBeatmapFileChecksum(rawChecksum);
    if (rawChecksum && !expectedChecksum) {
      sendJson(req, res, ctx, 400, { error: "invalid_checksum" });
      return true;
    }
    try {
      // cachedOnly=1 serves from beatmap_osu_files / stored archives without ever
      // calling the osu! API; callers opt back into the network with a plain request.
      const cachedOnly = url.searchParams.get("cachedOnly") === "1";
      const content = await getCachedBeatmapFile(
        ctx.serveWriteDb ?? ctx.db,
        ctx.osu,
        Math.floor(beatmapId),
        normalizeCaller(url.searchParams.get("caller")),
        cachedOnly ? { allowArchive: true, allowDirect: false, expectedChecksum } : { expectedChecksum },
      );
      sendCors(req, res, ctx);
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(content);
    } catch (error) {
      if (url.searchParams.get("cachedOnly") === "1") {
        sendJson(req, res, ctx, 404, { error: "not_cached" });
        return true;
      }
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
    if (!ctx.config.enableReplayVideo) {
      // The whole feature is off (production default): behave as if the
      // endpoint were never registered, before auth or rate accounting.
      sendJson(req, res, ctx, 404, { error: "replay_video_disabled" });
      return true;
    }
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
      const job = await createReplayVideoExport(ctx.serveWriteDb ?? ctx.db, ctx.config, parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {}));
      sendJson(req, res, ctx, 200, { id: job.id });
      return true;
    }
    if (action === "server-render") {
      const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
      const job = await createServerReplayVideoExport(ctx.serveWriteDb ?? ctx.db, ctx.config, body);
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
      const job = await writeReplayVideoUpload(ctx.serveWriteDb ?? ctx.db, ctx.config, id, buffer);
      sendJson(req, res, ctx, 200, replayVideoExportResponse(job));
      return true;
    }
    if (action === "finish") {
      const job = await markReplayVideoQueued(ctx.serveWriteDb ?? ctx.db, id);
      await ctx.queue.enqueue("replay_video_export", `replay-video:${id}`, { id }, { priority: 80 });
      sendJson(req, res, ctx, 202, replayVideoExportResponse(job));
      return true;
    }
    if (action === "cancel") {
      await cancelReplayVideoExport(ctx.serveWriteDb ?? ctx.db, ctx.config, id);
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    sendJson(req, res, ctx, 400, { error: "Unknown replay video job action." });
    return true;
  }
  if (url.pathname === "/api/skins/list") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const scope = skinViewerScope(req, ctx, url);
    const includeHidden = url.searchParams.get("includeHidden") === "1" && scope.asAdmin;
    const keymode = Number(url.searchParams.get("k"));
    const page = Number(url.searchParams.get("page") ?? 0);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 24);
    // An admin list can carry hidden skins, and an owner-scoped one carries
    // that viewer's private skins, so neither may land in a shared cache.
    if (scope.tokened) res.setHeader("cache-control", "private, no-store");
    else res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    const variant = url.searchParams.get("variant");
    const list = await listSkins(ctx.db, {
      q: (url.searchParams.get("q") ?? "").slice(0, 80),
      keymode: Number.isInteger(keymode) && keymode >= 1 && keymode <= 10 ? keymode : null,
      // "special" is the 7K+1 filter (keymode 8 whose layout is really 7+1);
      // "regular" makes the plain keymode filter mean actual 8K.
      keymodeVariant: variant === "special" || variant === "regular" ? variant : null,
      page: Number.isFinite(page) ? page : 0,
      pageSize: Number.isFinite(pageSize) ? pageSize : 24,
      includeHidden,
      sort: url.searchParams.get("sort") === "downloads" ? "downloads" : "newest",
      // Only an admin-token request carries a vouched-for viewer, so a browser
      // cannot ask for someone else's private shelf by guessing an id.
      privateOwnerUserId: scope.viewerUserId,
      onlyPrivate: url.searchParams.get("visibility") === "private",
      // The moderation shelf: every uploader's private skins, and only for a
      // request that proved it is a true admin.
      adminAllPrivate: scope.asAdmin && url.searchParams.get("allPrivate") === "1",
    });
    sendJson(req, res, ctx, 200, list);
    return true;
  }
  if (url.pathname === "/api/skins/get") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    // Accepts the slug from a pretty URL or a raw row id from a pre-slug link.
    const skin = id ? await getSkinByRef(ctx.db, id) : null;
    const scope = skinViewerScope(req, ctx, url);
    // Hidden is a moderation state: only an admin reads one back, its own
    // uploader included.
    if (!skin || (!scope.asAdmin && skin.status !== "published")) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    // A private skin has a page for exactly one person. Admins keep their read
    // (a skin nobody can report still has to be moderatable), everyone else
    // gets the same 404 a deleted skin gives.
    const isOwner = scope.viewerUserId != null && scope.viewerUserId === skin.ownerUserId;
    if (skin.visibility === "private" && !isOwner && !scope.asAdmin) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    if (scope.tokened) res.setHeader("cache-control", "private, no-store");
    else res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    sendJson(req, res, ctx, 200, { skin: toSkinSummary(skin, { asOwner: isOwner || scope.asAdmin }) });
    return true;
  }
  if (url.pathname === "/api/skins/download") {
    // Redirect-through download so each grab counts, then the R2 public URL
    // serves the actual bytes with ContentDisposition: attachment.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    const target = id ? await recordSkinDownload(ctx.serveWriteDb ?? ctx.db, id) : null;
    if (!target) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    sendCors(req, res, ctx);
    res.statusCode = 302;
    res.setHeader("location", target);
    res.setHeader("cache-control", "no-store");
    res.end();
    return true;
  }
  if (url.pathname.startsWith("/api/skins/file/")) {
    // Streams a skin's stored objects (.osk, preview, screenshots) from R2
    // when no public bucket URL is configured. Only keys recorded on the
    // skin row are reachable, so the shared bucket stays private.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const parts = url.pathname.split("/").filter(Boolean);
    const id = decodeURIComponent(parts[3] ?? "");
    const filename = decodeURIComponent(parts[4] ?? "");
    const skin = id && filename ? await getSkin(ctx.db, id) : null;
    // A private skin's objects answer only to the ?t= capability its owner-
    // scoped reads carry. Nothing else about the request identifies anyone:
    // these URLs are what an <img> and the asset explorer fetch straight from
    // the browser, with no cookie and no admin token to check.
    const unlocked = !skin || privateSkinSecretMatches(skin, url.searchParams.get("t"));
    const visible = skin && unlocked && (skin.status === "published" || isAdmin(req, ctx));
    const key = visible
      ? [skin.oskKey, skin.previewKey, ...skin.previews.map((preview) => preview.key), ...skin.screenshots.map((shot) => shot.key)]
          .find((candidate): candidate is string => Boolean(candidate && candidate.split("/").pop() === filename))
      : undefined;
    // Private objects are cached by the one browser allowed to hold them, never
    // by a shared cache that would then serve them without the capability.
    const cacheControl = skin?.visibility === "private"
      ? "private, max-age=86400"
      : "public, max-age=86400, s-maxage=31536000, immutable";
    if (key && !key.toLowerCase().endsWith(".osk")) {
      // Images (previews, screenshots) serve from the in-memory tier: their
      // keys are immutable and the row check above already authorized this
      // request, so a cached buffer is as safe as the R2 read it replaces and
      // saves the grid a >1s round trip per card.
      const image = await readCachedSkinImage(key, () => getSkinObject(ctx.config, key));
      if (!image) {
        sendJson(req, res, ctx, 404, { error: "not_found" });
        return true;
      }
      sendCors(req, res, ctx);
      res.statusCode = 200;
      res.setHeader("content-type", image.contentType);
      res.setHeader("content-length", String(image.buffer.length));
      if (image.contentDisposition) res.setHeader("content-disposition", image.contentDisposition);
      res.setHeader("cache-control", cacheControl);
      res.end(image.buffer);
      return true;
    }
    const object = key ? await getSkinObject(ctx.config, key) : null;
    if (!object) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    sendCors(req, res, ctx);
    res.statusCode = 200;
    res.setHeader("content-type", object.contentType);
    if (object.contentLength != null) res.setHeader("content-length", String(object.contentLength));
    if (object.contentDisposition) res.setHeader("content-disposition", object.contentDisposition);
    res.setHeader("cache-control", cacheControl);
    object.body.on("error", () => res.destroy());
    object.body.pipe(res);
    return true;
  }
  if (url.pathname === "/api/replay-skin") {
    // Which community skin (and settings) viewers see on this player's
    // replays. Public by osu! user id: anyone watching a replay resolves it.
    // "No choice", "hidden skin", and "deleted skin" all read back as the same
    // null so a moderation state never leaks through here - the viewer just
    // falls back to its default skin.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user" });
      return true;
    }
    // Nothing viewer-specific in the response, but the owner changes this
    // interactively and expects a refreshed replay to pick it up immediately.
    // It may be stored by shared caches, but must be revalidated before use.
    res.setHeader("cache-control", "public, no-cache");
    const row = await getUserReplaySkin(ctx.db, userId);
    const skin = row ? await getSkin(ctx.db, row.skinId) : null;
    // A private skin fronts its owner's replays and nobody else's. Someone who
    // picked it while it was public keeps the stored row, but it reads back as
    // "no skin" from the moment it turned private - otherwise turning a skin
    // private would leave its art flowing through a stranger's replays.
    if (!row || !skin || skin.status !== "published"
      || (skin.visibility === "private" && skin.ownerUserId !== userId)) {
      sendJson(req, res, ctx, 200, { replaySkin: null });
      return true;
    }
    // A private skin still fronts its owner's replays; what travels is the
    // redacted summary (no .osk, no page to open) plus the pointer to the
    // filtered bundle the viewer draws from instead.
    const isPrivate = skin.visibility === "private";
    sendJson(req, res, ctx, 200, {
      replaySkin: {
        skin: toSkinSummary(skin),
        settings: parseJson<unknown>(row.payloadJson, null),
        updatedAt: row.updatedAt,
        ...(isPrivate
          ? {
              private: true,
              bundleVersion: replaySkinBundleVersion({
                oskKey: skin.oskKey,
                oskSha256: skin.oskSha256,
                settingsUpdatedAt: row.updatedAt,
              }),
            }
          : null),
      },
    });
    return true;
  }
  if (url.pathname === "/api/replay-skin/bundle") {
    // The only way a private skin's art reaches anyone but its owner: a zip of
    // just the assets this player's stored settings draw, built from the .osk
    // server-side. Public by osu! user id like /api/replay-skin itself, since
    // any visitor watching the replay needs it.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user" });
      return true;
    }
    const row = await getUserReplaySkin(ctx.db, userId);
    const skin = row ? await getSkin(ctx.db, row.skinId) : null;
    // Public skins keep serving their whole .osk through /api/skins/file; only
    // a private one has anything to filter, and only for the player who owns
    // it (same rule as the pointer endpoint above).
    if (!row || !skin || skin.status !== "published" || skin.visibility !== "private"
      || skin.ownerUserId !== userId || !skin.oskKey) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    const version = replaySkinBundleVersion({
      oskKey: skin.oskKey,
      oskSha256: skin.oskSha256,
      settingsUpdatedAt: row.updatedAt,
    });
    const bundle = await getReplaySkinBundle(ctx.config, {
      skinId: skin.id,
      oskKey: skin.oskKey,
      version,
      payload: parseJson<unknown>(row.payloadJson, null),
      oskMaxBytes: ctx.config.skinOskMaxBytes,
    });
    if (!bundle) {
      sendJson(req, res, ctx, 503, { error: "bundle_unavailable" });
      return true;
    }
    sendCors(req, res, ctx);
    res.statusCode = 200;
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-length", String(bundle.length));
    // Inline: this is art a page draws, not a file to save. The version is in
    // the URL the client asks for, so a stale copy can only be a stale URL.
    res.setHeader("content-disposition", "inline");
    res.setHeader("cache-control", "public, max-age=86400");
    res.end(bundle);
    return true;
  }
  if (url.pathname === "/api/replay-skin/set" || url.pathname === "/api/replay-skin/clear") {
    // Same trust contract as the goals endpoints: admin-token gated and called
    // server-to-server, with the frontend server fn injecting the osu!-verified
    // viewer id, so a user only ever points their own replays at a skin.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; skinId?: unknown; settings?: unknown }>(
      (await readBodyBuffer(req, REPLAY_SKIN_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
      {},
    );
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user" });
      return true;
    }
    if (url.pathname === "/api/replay-skin/clear") {
      await clearUserReplaySkin(ctx.serveWriteDb ?? ctx.db, userId);
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    // A skin id longer than any real one can never resolve, so it fails the
    // same way an unknown id does instead of earning its own error shape.
    const skinId = typeof body.skinId === "string" ? body.skinId : "";
    const skin = skinId && skinId.length <= 64 ? await getSkin(ctx.db, skinId) : null;
    // Someone else's private skin is not a skin you can point your replays at:
    // that would publish its art through your own replay bundle.
    if (!skin || skin.status !== "published" || (skin.visibility === "private" && skin.ownerUserId !== userId)) {
      sendJson(req, res, ctx, 404, { error: "skin_not_found" });
      return true;
    }
    const payloadJson = JSON.stringify(body.settings ?? {});
    if (payloadJson.length > USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS) {
      sendJson(req, res, ctx, 413, { error: "payload_too_large" });
      return true;
    }
    // Settings must reference assets by path inside the .osk; a payload that
    // smuggles the images or sounds themselves would turn this table into a
    // second, unmoderated skin store.
    if (payloadJson.includes("data:image/") || payloadJson.includes("data:audio/")) {
      sendJson(req, res, ctx, 400, { error: "embedded_data_url" });
      return true;
    }
    await setUserReplaySkin(ctx.serveWriteDb ?? ctx.db, userId, skin.id, payloadJson);
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/skins/start") {
    // Admin-token gated: the frontend server fn forwards the osu!-verified viewer id with the
    // shared admin token (the goals/pack-wallet bridge), so uploads are always attributed to
    // the logged-in user. The browser then talks to /api/skins/upload with the minted ticket.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!isSkinStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "skin_storage_not_configured" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; username?: unknown; name?: unknown; author?: unknown; description?: unknown; oskSha256?: unknown; bypassLimits?: unknown; visibility?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const oskSha256 = typeof body.oskSha256 === "string" && /^[0-9a-f]{64}$/i.test(body.oskSha256)
      ? body.oskSha256.toLowerCase()
      : null;
    const result = await createPendingSkin(ctx.serveWriteDb ?? ctx.db, {
      ownerUserId: userId,
      ownerUsername: typeof body.username === "string" ? body.username : "",
      name: typeof body.name === "string" ? body.name : "",
      author: typeof body.author === "string" ? body.author : null,
      description: typeof body.description === "string" ? body.description : null,
      oskSha256,
      // Only the admin bulk uploader asks for this, through a server fn that
      // verifies a true admin before forwarding it on this token-gated route.
      bypassLimits: body.bypassLimits === true,
      visibility: body.visibility === "private" ? "private" : "public",
    });
    if (!result.ok) {
      if (result.error === "duplicate") {
        logInfo("skin_upload_duplicate", { ownerUserId: userId, stage: "start", existingId: result.duplicate.id });
        sendJson(req, res, ctx, 409, { ok: false, error: "duplicate", duplicate: result.duplicate });
        return true;
      }
      sendJson(req, res, ctx, result.error === "invalid_name" ? 400 : 429, { ok: false, error: result.error });
      return true;
    }
    logInfo("skin_upload_start", { id: result.id, ownerUserId: userId });
    sendJson(req, res, ctx, 200, { ok: true, id: result.id, token: result.token, expiresAt: result.expiresAt });
    return true;
  }
  if (url.pathname === "/api/skins/upload" || url.pathname === "/api/skins/finish" || url.pathname === "/api/skins/edit-finish") {
    // Ticket-authenticated: the token minted by /api/skins/start is the credential, so the
    // browser can POST the 65MB .osk directly here instead of transiting the frontend server.
    // /api/skins/edit-start mints the same kind of ticket against a published skin, which
    // only unlocks preview re-uploads (see the part guard below).
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "skinUpload")) return true;
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    if (!isSkinStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "skin_storage_not_configured" });
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname === "/api/skins/finish") {
      const result = await finishSkin(ctx.serveWriteDb ?? ctx.db, id, token);
      if (!result.ok) {
        const status = result.error === "not_found" ? 403 : 400;
        sendJson(req, res, ctx, status, { ok: false, error: result.error === "not_found" ? "invalid_ticket" : result.error });
        return true;
      }
      logInfo("skin_upload_finish", { id, ownerUserId: result.skin.ownerUserId, keymodes: result.skin.keymodes });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    if (url.pathname === "/api/skins/edit-finish") {
      const result = await finishSkinEdit(ctx.serveWriteDb ?? ctx.db, id, token);
      if (!result.ok) {
        sendJson(req, res, ctx, 403, { ok: false, error: "invalid_ticket" });
        return true;
      }
      // Previews for keymodes a replacement .osk no longer ships: the row has
      // already let go of them, so the objects go too.
      if (result.staleKeys.length > 0) {
        await deleteSkinObjects(ctx.config, result.staleKeys).catch((error) => {
          logWarn("skin_preview_stale_cleanup_failed", { id, ...errorContext(error) });
        });
      }
      logInfo("skin_previews_edited", { id, ownerUserId: result.skin.ownerUserId, droppedPreviews: result.staleKeys.length });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    const pending = id && token ? await getSkinForUpload(ctx.db, id, token) : null;
    // A published skin whose owner is re-rendering its previews or shipping a
    // newer .osk. The row keeps its status, so nothing else about it can be
    // touched through this ticket.
    const editing = pending ? null : (id && token ? await getSkinForEdit(ctx.db, id, token) : null);
    const skin = pending ?? editing;
    if (!skin) {
      sendJson(req, res, ctx, 403, { ok: false, error: "invalid_ticket" });
      return true;
    }
    // Private skins write every object under a folder named by their secret, so
    // the bucket's public base URL cannot be derived from the skin id alone.
    const storageKey = (key: string) => (
      skin.visibility === "private" && skin.privateSecret ? privateSkinKey(key, skin.privateSecret) : key
    );
    const part = url.searchParams.get("part") ?? "";
    if (editing && !(part === "preview" || (part === "osk" && editing.tokenScope === "replace"))) {
      // A previews ticket swaps renders and nothing else; a replace ticket also
      // takes the .osk. Screenshots of a published skin stay as uploaded either
      // way.
      sendJson(req, res, ctx, 400, { ok: false, error: "invalid_part" });
      return true;
    }
    if (part === "osk") {
      const buffer = await readBodyBuffer(req, ctx.config.skinOskMaxBytes);
      const validation = await validateOskBuffer(buffer);
      if (!validation.ok) {
        sendJson(req, res, ctx, 400, { ok: false, error: "invalid_osk", reason: validation.error });
        return true;
      }
      // Server-side duplicate check on the hash we computed ourselves: the one
      // at /api/skins/start trusts a client-sent hash, and the file can differ
      // from the one that minted the ticket. Runs before the R2 write, so a
      // rejected duplicate leaves no object behind. Private uploads skip it for
      // the same reason createPendingSkin does: a personal copy of a catalog
      // skin is the point, and the answer would name a stranger's skin.
      const duplicate = skin.visibility === "private"
        ? null
        : await findPublishedSkinByOskSha256(ctx.db, validation.info.sha256, skin.id);
      if (duplicate) {
        logInfo("skin_upload_duplicate", { ownerUserId: skin.ownerUserId, stage: "osk", existingId: duplicate.id });
        sendJson(req, res, ctx, 409, { ok: false, error: "duplicate", duplicate });
        return true;
      }
      if (editing) {
        // An update lands on a fresh key (the published object is cached
        // immutably) but keeps the skin's own download filename. The old build
        // goes once the row points at the new one.
        const key = storageKey(skinOskKey(skin.id, skin.name, nextSkinOskRevision(skin.oskKey)));
        const uploaded = await uploadSkinObject(ctx.config, key, buffer, "application/octet-stream", "attachment", oskFilename(skin.name));
        await replaceSkinOsk(ctx.serveWriteDb ?? ctx.db, skin, {
          key,
          url: uploaded.url,
          sizeBytes: uploaded.sizeBytes,
          sha256: validation.info.sha256,
          keymodes: validation.info.keymodes,
          specialKeymodes: validation.info.specialKeymodes,
          iniAuthor: validation.info.author,
        });
        if (skin.oskKey && skin.oskKey !== key) {
          await deleteSkinObjects(ctx.config, [skin.oskKey]).catch((error) => {
            logWarn("skin_osk_stale_cleanup_failed", { id: skin.id, ...errorContext(error) });
          });
        }
        logInfo("skin_osk_replaced", { id: skin.id, ownerUserId: skin.ownerUserId, sizeBytes: uploaded.sizeBytes, keymodes: validation.info.keymodes });
        sendJson(req, res, ctx, 200, { ok: true, keymodes: validation.info.keymodes });
        return true;
      }
      const key = storageKey(skinOskKey(skin.id, skin.name));
      const uploaded = await uploadSkinObject(ctx.config, key, buffer, "application/octet-stream", "attachment");
      await attachSkinOsk(ctx.serveWriteDb ?? ctx.db, skin, {
        key,
        url: uploaded.url,
        sizeBytes: uploaded.sizeBytes,
        sha256: validation.info.sha256,
        keymodes: validation.info.keymodes,
        specialKeymodes: validation.info.specialKeymodes,
        accentColor: validation.info.accentColor,
        iniAuthor: validation.info.author,
      });
      logInfo("skin_upload_osk", { id: skin.id, ownerUserId: skin.ownerUserId, sizeBytes: uploaded.sizeBytes, keymodes: validation.info.keymodes });
      sendJson(req, res, ctx, 200, { ok: true, keymodes: validation.info.keymodes });
      return true;
    }
    if (part === "preview" || part === "screenshot") {
      if (part === "screenshot" && skin.screenshots.length >= SKIN_MAX_SCREENSHOTS) {
        sendJson(req, res, ctx, 400, { ok: false, error: "screenshot_limit" });
        return true;
      }
      const buffer = await readBodyBuffer(req, ctx.config.skinImageMaxBytes);
      const sniffed = sniffImage(buffer);
      if (!sniffed) {
        sendJson(req, res, ctx, 400, { ok: false, error: "invalid_image" });
        return true;
      }
      const width = parseImageDimension(url.searchParams.get("w"));
      const height = parseImageDimension(url.searchParams.get("h"));
      if (part === "preview") {
        // The renderer samples the accent from the note art itself, which is
        // more faithful than the skin.ini colours the .osk validation reads.
        const accent = url.searchParams.get("accent");
        if (accent && /^#[0-9a-f]{6}$/i.test(accent)) await setSkinAccent(ctx.serveWriteDb ?? ctx.db, skin.id, accent);
        // With keys=N the render is stored as that keymode's preview (one per
        // keymode, replace on repeat); cover=1 also makes it the card cover.
        // Without keys it degrades to the single-cover flow.
        const keysParam = Math.round(Number(url.searchParams.get("keys")));
        const keys = Number.isInteger(keysParam) && keysParam >= 1 && keysParam <= 10 ? keysParam : null;
        if (keys != null) {
          // Preview objects are cached immutably, so a re-render has to land on
          // a new key; the displaced object is deleted once the row points at
          // the fresh one.
          const previous = skin.previews.find((preview) => preview.keys === keys) ?? null;
          const key = previous
            ? storageKey(skinKeymodePreviewKey(skin.id, keys, sniffed.ext, nextSkinPreviewRevision(previous.key)))
            : storageKey(skinKeymodePreviewKey(skin.id, keys, sniffed.ext));
          const uploaded = await uploadSkinObject(ctx.config, key, buffer, sniffed.mime, "inline");
          const isCover = url.searchParams.get("cover") === "1";
          const upserted = await upsertSkinKeymodePreview(
            ctx.serveWriteDb ?? ctx.db,
            skin.id,
            { keys, key, url: uploaded.url, width, height },
            isCover,
          );
          if (!upserted.ok) {
            await deleteSkinObjects(ctx.config, [key]).catch(() => {});
            sendJson(req, res, ctx, 400, { ok: false, error: upserted.error });
            return true;
          }
          // What the row no longer points at: the displaced render, plus the
          // standalone cover object of a pre-keymode skin whose card this
          // render just took over.
          const stillReferenced = new Set(
            skin.previews.filter((preview) => preview.keys !== keys).map((preview) => preview.key),
          );
          stillReferenced.add(key);
          // The cover columns follow a re-render of the keymode they point at,
          // so that key counts as referenced only while it stays the cover.
          if (!isCover && skin.previewKey && skin.previewKey !== upserted.replaced?.key) {
            stillReferenced.add(skin.previewKey);
          }
          const staleKeys = [upserted.replaced?.key, isCover ? skin.previewKey : null]
            .filter((candidate): candidate is string => !!candidate && !stillReferenced.has(candidate));
          if (staleKeys.length > 0) {
            await deleteSkinObjects(ctx.config, [...new Set(staleKeys)]).catch((error) => {
              logWarn("skin_preview_stale_cleanup_failed", { id: skin.id, keys, ...errorContext(error) });
            });
          }
        } else {
          const key = storageKey(skinPreviewKey(skin.id, sniffed.ext));
          const uploaded = await uploadSkinObject(ctx.config, key, buffer, sniffed.mime, "inline");
          await attachSkinPreview(ctx.serveWriteDb ?? ctx.db, skin.id, { key, url: uploaded.url, width, height });
        }
      } else {
        const key = storageKey(skinScreenshotKey(skin.id, skin.screenshots.length, sniffed.ext));
        const uploaded = await uploadSkinObject(ctx.config, key, buffer, sniffed.mime, "inline");
        const appended = await appendSkinScreenshot(ctx.serveWriteDb ?? ctx.db, skin.id, { key, url: uploaded.url, width, height });
        if (!appended.ok) {
          await deleteSkinObjects(ctx.config, [key]).catch(() => {});
          sendJson(req, res, ctx, 400, { ok: false, error: appended.error });
          return true;
        }
      }
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    sendJson(req, res, ctx, 400, { ok: false, error: "invalid_part" });
    return true;
  }
  if (url.pathname === "/api/skins/edit-start" || url.pathname === "/api/skins/cover" || url.pathname === "/api/skins/rename" || url.pathname === "/api/skins/visibility" || url.pathname === "/api/skins/special-keymodes") {
    // Admin-token gated like /api/skins/delete: the frontend server fn forwards the
    // osu!-verified viewer id, and the ownership check below keeps a user off anyone
    // else's skin. asAdmin is set only by the server fn that verified a true admin;
    // asKeymodeModerator only by the special-keymodes server fn after matching the
    // viewer against its hardcoded trusted-corrector list, and no other action
    // honours it.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (url.pathname === "/api/skins/edit-start" && !isSkinStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "skin_storage_not_configured" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; id?: unknown; keys?: unknown; name?: unknown; asAdmin?: unknown; asKeymodeModerator?: unknown; scope?: unknown; visibility?: unknown; specialKeymodes?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    const id = typeof body.id === "string" ? body.id : "";
    if (!Number.isInteger(userId) || userId <= 0 || !id) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const ownerUserId = body.asAdmin === true ? null : userId;
    if (url.pathname === "/api/skins/rename") {
      const result = await renameSkin(
        ctx.serveWriteDb ?? ctx.db,
        id,
        typeof body.name === "string" ? body.name : "",
        ownerUserId,
      );
      if (!result.ok) {
        const status = result.error === "forbidden" ? 403 : result.error === "invalid_name" ? 400 : 404;
        sendJson(req, res, ctx, status, { ok: false, error: result.error });
        return true;
      }
      logInfo("skin_renamed", { id, by: ownerUserId == null ? "admin" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    if (url.pathname === "/api/skins/visibility") {
      const visibility = body.visibility === "private" ? "private" : "public";
      const result = await setSkinVisibility(ctx.serveWriteDb ?? ctx.db, id, visibility, ownerUserId);
      if (!result.ok) {
        sendJson(req, res, ctx, result.error === "forbidden" ? 403 : 404, { ok: false, error: result.error });
        return true;
      }
      const moved = result.changed ? await moveSkinOskForVisibility(ctx, result.skin) : result.skin;
      logInfo("skin_visibility_changed", { id, visibility, by: ownerUserId == null ? "admin" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: toSkinSummary(moved, { asOwner: true }) });
      return true;
    }
    if (url.pathname === "/api/skins/special-keymodes") {
      // The owner's word on which keymodes are really (N-1)+1; the values must
      // be keymodes the skin ships, which the feature checks against the row.
      const specialKeymodes = Array.isArray(body.specialKeymodes)
        ? body.specialKeymodes.map((entry) => Math.round(Number(entry)))
        : null;
      if (!specialKeymodes || specialKeymodes.length > 10 || specialKeymodes.some((keys) => !Number.isInteger(keys) || keys < 1 || keys > 10)) {
        sendJson(req, res, ctx, 400, { error: "invalid_request" });
        return true;
      }
      const keymodeModerator = ownerUserId != null && body.asKeymodeModerator === true;
      const result = await setSkinSpecialKeymodes(
        ctx.serveWriteDb ?? ctx.db,
        id,
        specialKeymodes,
        keymodeModerator ? null : ownerUserId,
        { keymodeModerator },
      );
      if (!result.ok) {
        const status = result.error === "forbidden" ? 403 : result.error === "invalid_keymodes" ? 400 : 404;
        sendJson(req, res, ctx, status, { ok: false, error: result.error });
        return true;
      }
      logInfo("skin_special_keymodes_changed", { id, specialKeymodes, by: ownerUserId == null ? "admin" : keymodeModerator ? "keymode_moderator" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    if (url.pathname === "/api/skins/cover") {
      const keys = Math.round(Number(body.keys));
      if (!Number.isInteger(keys) || keys < 1 || keys > 10) {
        sendJson(req, res, ctx, 400, { error: "invalid_request" });
        return true;
      }
      const result = await setSkinCoverKeymode(ctx.serveWriteDb ?? ctx.db, id, keys, ownerUserId);
      if (!result.ok) {
        sendJson(req, res, ctx, result.error === "forbidden" ? 403 : 404, { ok: false, error: result.error });
        return true;
      }
      logInfo("skin_cover_changed", { id, keys, by: ownerUserId == null ? "admin" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    // "replace" also unlocks a new .osk on the ticket, which is how an
    // uploader ships an updated build of a skin that is already published.
    const scope = body.scope === "replace" ? "replace" : "previews";
    const started = await startSkinEdit(ctx.serveWriteDb ?? ctx.db, id, ownerUserId, scope);
    if (!started.ok) {
      sendJson(req, res, ctx, started.error === "forbidden" ? 403 : 404, { ok: false, error: started.error });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, id: started.id, token: started.token, expiresAt: started.expiresAt, scope: started.scope });
    return true;
  }
  if (url.pathname === "/api/skins/delete") {
    // Admin-token gated owner delete: the frontend server fn forwards the osu!-verified viewer
    // id, and the ownership check below keeps a user from deleting anyone else's skin.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; id?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    const id = typeof body.id === "string" ? body.id : "";
    if (!Number.isInteger(userId) || userId <= 0 || !id) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const skin = await getSkin(ctx.db, id);
    if (!skin || skin.ownerUserId !== userId) {
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }
    const deleted = await deleteSkin(ctx.serveWriteDb ?? ctx.db, id);
    if (deleted) {
      await deleteSkinObjects(ctx.config, deleted.keys).catch((error) => {
        logWarn("skin_delete_r2_failed", { id, ...errorContext(error) });
      });
    }
    logInfo("skin_deleted", { id, ownerUserId: userId, by: "owner" });
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/skins/moderate") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ id?: unknown; action?: unknown }>((await readBody(req)) || "{}", {});
    const id = typeof body.id === "string" ? body.id : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!id || !["hide", "unhide", "delete"].includes(action)) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    if (action === "delete") {
      const deleted = await deleteSkin(ctx.serveWriteDb ?? ctx.db, id);
      if (deleted) {
        await deleteSkinObjects(ctx.config, deleted.keys).catch((error) => {
          logWarn("skin_delete_r2_failed", { id, ...errorContext(error) });
        });
        logInfo("skin_deleted", { id, by: "admin" });
      }
      sendJson(req, res, ctx, deleted ? 200 : 404, { ok: Boolean(deleted) });
      return true;
    }
    const ok = await setSkinHidden(ctx.serveWriteDb ?? ctx.db, id, action === "hide");
    if (ok) logInfo("skin_moderated", { id, action });
    sendJson(req, res, ctx, ok ? 200 : 404, { ok });
    return true;
  }
  if (url.pathname === "/api/admin/ingest-fixture") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const rows = parseJson<unknown[]>((await readBody(req)) || "[]", []);
    const { ScoreIngestor } = await import("../ingest/score-ingestor.js");
    const ingestor = new ScoreIngestor(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.events, ctx.config);
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
    sendJson(req, res, ctx, 200, { ok: true, country: await setCountryPaused(ctx.serveWriteDb ?? ctx.db, ctx.config, country, paused) });
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
    sendJson(req, res, ctx, 200, { ok: true, country: await setCountryStatus(ctx.serveWriteDb ?? ctx.db, ctx.config, country, status) });
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
    const updated = await setCountryFeatureTier(ctx.serveWriteDb ?? ctx.db, ctx.config, country, tier);
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
    const added = await activateCountry(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.config, country);
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
    const writeDb = ctx.serveWriteDb ?? ctx.db;
    const writeQueue = ctx.serveWriteQueue ?? ctx.queue;
    const deleted = await deleteCountryData(writeDb, country);
    await enqueueGlobalMapsRefresh(writeQueue, { priority: 90, replaceDone: true });
    sendJson(req, res, ctx, 200, { ok: true, country, deleted });
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
  if (url.pathname === "/api/admin/rebuild-collections") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // Run inline (local index pass, no osu! API) so the response only returns
    // once the packs are freshly rotated; the admin button can then refetch and
    // immediately show the new sample instead of waiting on the queue.
    await rebuildMapCollections(ctx.serveWriteDb ?? ctx.db);
    sendJson(req, res, ctx, 200, { ok: true });
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
    await setCountryStatus(ctx.serveWriteDb ?? ctx.db, ctx.config, country, "active");
    await enqueueRosterRefreshes(ctx.queue, [country]);
    const queued = await enqueueOscCountryCatchup(ctx.queue, ctx.serveWriteDb ?? ctx.db, ctx.config, country);
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
    sendJson(req, res, ctx, 200, { ok: true, ...await cancelOscCountryCatchup(ctx.serveWriteDb ?? ctx.db, country) });
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
    await setWorkersPaused(ctx.serveWriteDb ?? ctx.db, true);
    sendJson(req, res, ctx, 200, { ok: true, worker: ctx.workerStatus?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/admin/resume-workers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    ctx.resumeWorkers?.();
    await setWorkersPaused(ctx.serveWriteDb ?? ctx.db, false);
    sendJson(req, res, ctx, 200, { ok: true, worker: ctx.workerStatus?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/admin/run-retention") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, deleted: await runRetention(ctx.serveWriteDb ?? ctx.db, ctx.config) });
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
    await enqueueOscBackfill(ctx.queue, ctx.serveWriteDb ?? ctx.db, ctx.config);
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/dan-classifier/files") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ ids?: unknown }>((await readBody(req)) || "{}", {});
    const ids = [...new Set(normalizeIdList(body.ids))].slice(0, 50);
    if (!ids.length) {
      sendJson(req, res, ctx, 400, { error: "invalid_ids" });
      return true;
    }
    const files: Array<{ beatmapId: number; content: string }> = [];
    const missing: number[] = [];
    for (const beatmapId of ids) {
      try {
        // cached-only: an archive fallback here can stall the whole batch for
        // minutes on one uncached chart (full .osz download from mirrors, which
        // may be stale and not even contain the diff). Uncached charts come back
        // as missing and go through the explicit fetch-missing path instead.
        const content = await getCachedBeatmapFile(ctx.serveWriteDb ?? ctx.db, ctx.osu, beatmapId, "dan_classifier_admin", {
          allowArchive: false,
          allowDirect: false,
        });
        files.push({ beatmapId, content });
      } catch {
        missing.push(beatmapId);
      }
    }
    sendJson(req, res, ctx, 200, { files, missing });
    return true;
  }
  if (url.pathname === "/api/admin/dan-classifier/sets") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ beatmapsetIds?: unknown; beatmapIds?: unknown }>((await readBody(req)) || "{}", {});
    const beatmapsetIds = [...new Set(normalizeIdList(body.beatmapsetIds))].slice(0, 100);
    const beatmapIds = [...new Set(normalizeIdList(body.beatmapIds))].slice(0, 400);
    if (!beatmapsetIds.length && !beatmapIds.length) {
      sendJson(req, res, ctx, 400, { error: "invalid_ids" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getDanClassifierSets(ctx.db, beatmapsetIds, beatmapIds));
    return true;
  }
  if (url.pathname === "/api/admin/sweeps") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // Read-only status over the done-key/self-chaining background sweeps
    // (registry in features/sweeps-status.ts).
    sendJson(req, res, ctx, 200, { sweeps: await getSweepReports(ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/chart-analysis/backfill") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const limit = Number(url.searchParams.get("limit") ?? "");
    const enqueued = await enqueueChartAnalysisBackfill(
      ctx.serveWriteDb ?? ctx.db,
      ctx.queue,
      Number.isFinite(limit) && limit > 0 ? limit : undefined,
      { includeFailed: true },
    );
    sendJson(req, res, ctx, 200, { ok: true, enqueued });
    return true;
  }
  if (url.pathname === "/api/admin/chart-analysis/start") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await startChartAnalysisBackfill(ctx.serveWriteDb ?? ctx.db, ctx.queue) });
    return true;
  }
  if (url.pathname === "/api/admin/chart-analysis/cancel") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await cancelChartAnalysisBackfill(ctx.serveWriteDb ?? ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/osu-file-backfill/start") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.config.enableOsuApiJobs) {
      sendJson(req, res, ctx, 409, { error: "osu_api_jobs_disabled" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await startBeatmapOsuFileBackfill(ctx.serveWriteDb ?? ctx.db, ctx.queue) });
    return true;
  }
  if (url.pathname === "/api/admin/osu-file-backfill/cancel") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await cancelBeatmapOsuFileBackfill(ctx.serveWriteDb ?? ctx.db) });
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
  if (url.pathname === "/api/admin/discord/register-emojis") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.discord) {
      sendJson(req, res, ctx, 400, { error: "discord_not_configured" });
      return true;
    }
    try {
      const force = url.searchParams.get("force") === "1";
      const result = await ctx.discord.registerEmojis(force);
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
    const removed = await removeSubscriptionById(ctx.serveWriteDb ?? ctx.db, id);
    if (removed) ctx.discord?.notifySubscriptionsChanged();
    sendJson(req, res, ctx, 200, { ok: true, removed });
    return true;
  }
  if (url.pathname === "/api/admin/todos") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { todos: await listAdminTodos(ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/todos/create") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<CreateTodoInput>((await readBody(req)) || "{}", {});
    const todo = await createAdminTodo(ctx.serveWriteDb ?? ctx.db, body);
    if (!todo) {
      sendJson(req, res, ctx, 400, { error: "invalid_title" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, todo });
    return true;
  }
  if (url.pathname === "/api/admin/todos/update") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<UpdateTodoInput>((await readBody(req)) || "{}", {});
    const todo = await updateAdminTodo(ctx.serveWriteDb ?? ctx.db, body);
    if (!todo) {
      sendJson(req, res, ctx, 404, { error: "todo_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, todo });
    return true;
  }
  if (url.pathname === "/api/admin/todos/delete") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ id?: unknown }>((await readBody(req)) || "{}", {});
    const removed = await deleteAdminTodo(ctx.serveWriteDb ?? ctx.db, typeof body.id === "string" ? body.id : "");
    if (!removed) {
      sendJson(req, res, ctx, 404, { error: "todo_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/todos/clear-done") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, cleared: await clearDoneAdminTodos(ctx.serveWriteDb ?? ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/dan-benchmark/labels" || url.pathname === "/api/admin/dan-benchmark/hidden") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const family = url.searchParams.get("family");
    if (!isDanBenchmarkFamily(family)) {
      sendJson(req, res, ctx, 400, { error: "invalid_family" });
      return true;
    }
    if (url.pathname.endsWith("/labels")) {
      sendJson(req, res, ctx, 200, { labels: await listDanBenchmarkLabels(ctx.db, family) });
    } else {
      sendJson(req, res, ctx, 200, { hidden: await listDanBenchmarkHiddenDiffs(ctx.db, family) });
    }
    return true;
  }
  if (url.pathname === "/api/admin/dan-benchmark/set-label" || url.pathname === "/api/admin/dan-benchmark/set-hidden") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const ok = url.pathname.endsWith("/set-label")
      ? await setDanBenchmarkLabel(ctx.serveWriteDb ?? ctx.db, body)
      : await setDanBenchmarkHiddenDiff(ctx.serveWriteDb ?? ctx.db, body);
    if (!ok) {
      sendJson(req, res, ctx, 400, { error: "invalid_payload" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/dan-benchmark/import") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ labels?: []; hidden?: [] }>((await readBody(req)) || "{}", {});
    sendJson(req, res, ctx, 200, { ok: true, ...(await importDanBenchmark(ctx.serveWriteDb ?? ctx.db, body)) });
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
      "country_beatmap_score_pbs",
      "country_beatmap_score_pb_state",
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
      deleted[table] = Number((await exec(ctx.serveWriteDb ?? ctx.db, `delete from ${table}`)).rowsAffected ?? 0);
    }
    sendJson(req, res, ctx, 200, { ok: true, deleted });
    return true;
  }
  return false;
}

/** Per-kind goal target validation shared by /api/goals/create and /api/goals/update. */
function parseGoalTargets(
  kind: GoalKind,
  body: { targetValue?: unknown; targetCount?: unknown; targetGrade?: unknown; speedBucket?: unknown },
): { error: string } | { fields: UserGoalTargetPatch } {
  const fields: UserGoalTargetPatch = {};
  if (GOAL_MAP_KINDS.includes(kind)) {
    const speedBucket = typeof body.speedBucket === "string" ? body.speedBucket.trim().toLowerCase() : "normal";
    if (!GOAL_SPEED_BUCKETS.includes(speedBucket as GoalSpeedBucket)) return { error: "invalid_speed_bucket" };
    fields.speedBucket = speedBucket as GoalSpeedBucket;
  }
  if (kind === "accuracy") {
    let target = Number(body.targetValue);
    // Accept either a fraction (0.96) or a percent (96); normalise to a 0-1 fraction.
    if (target > 1 && target <= 100) target = target / 100;
    if (!(target > 0 && target <= 1)) return { error: "invalid_target" };
    fields.targetValue = target;
  } else if (kind === "grade") {
    const grade = String(body.targetGrade ?? "").toUpperCase();
    if (!GOAL_TARGET_GRADES.includes(grade)) return { error: "invalid_grade" };
    fields.targetGrade = grade;
  } else if (kind === "play_pp_count") {
    const target = Number(body.targetValue);
    const count = Number(body.targetCount);
    if (!(target > 0) || !(Number.isInteger(count) && count > 0)) return { error: "invalid_target" };
    fields.targetValue = target;
    fields.targetCount = count;
  } else if (kind === "play_pp" || kind === "reach_pp") {
    const target = Number(body.targetValue);
    if (!(target > 0)) return { error: "invalid_target" };
    fields.targetValue = target;
  } else if (kind === "reach_rank") {
    const target = Number(body.targetValue);
    if (!(Number.isInteger(target) && target > 0)) return { error: "invalid_target" };
    fields.targetValue = target;
    // Scope (global vs country leaderboard) rides in target_grade, since a rank goal has no grade.
    fields.targetGrade = String(body.targetGrade ?? "global").toLowerCase() === "country" ? "country" : "global";
  }
  return { fields };
}

// Stale-while-revalidate cache over the assembled status body. A request that
// lands in a write-lock window (retention delete pass, WAL checkpoint) or
// behind a slow rebuild would otherwise wait out the whole build and trip the
// frontend's 30s abort; serving the last resolved body instantly keeps the
// admin page loading in milliseconds while a single-flight rebuild (started at
// most once per fresh window) refreshes it in the background. A body older
// than the stale budget is no longer served — those requests wait on (and
// coalesce onto) the rebuild, so the data can't lag unboundedly. Keyed by ctx
// (one long-lived object per server boot) so test contexts don't share entries.
const STATUS_BODY_FRESH_MS = 5_000;
const STATUS_BODY_STALE_SERVE_MS = 120_000;

interface StatusBodyCacheEntry {
  startedAt: number;
  settled: boolean;
  promise: Promise<Record<string, unknown>>;
  body: Record<string, unknown> | null;
  bodyAt: number;
}

const statusBodyCacheByCtx = new WeakMap<HttpContext, Map<string, StatusBodyCacheEntry>>();

// Fire-and-forget warm-up for the status body and the expensive count caches
// underneath it (osu-file / chart-analysis backfill counts), so the first
// status request after a boot never pays the cold build in the foreground.
export function warmStatusBodyCache(ctx: HttpContext): void {
  void statusBody(ctx, {}).catch(() => undefined);
}

// The first GLOBAL farmed request after a restart packs the durable player
// projection (maps.ts patches later revisions by beatmap). Build it shortly after
// boot so a user never fronts that cost. Runs on the maps snapshot thread; if
// the thread is unavailable (memory DB, MAPS_SNAPSHOT_THREAD=0, vitest) this
// deliberately does nothing rather than stall the main event loop.
//
// The build is a pure read (it never takes the write lock), but packing a
// production-sized player corpus still pegs a core, so landing it on top of a
// deploy's schema migration on a 2-vCPU / 3.7GB box starves the writer of CPU
// and page cache. No constant can separate the two: migrate() may now spend up
// to SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS purely waiting out a concurrent writer,
// so a delay big enough for the contended case would penalize every ordinary
// restart (where the migration is done in seconds) with minutes of cold board.
// So observe it instead — migrate() publishes its start/finish in live_meta —
// and keep the floor at the boot-burst settle time it always was.
const MAPS_GLOBAL_FARMED_WARMUP_DELAY_MS = 15_000;
// Poll only while a migration is actually in flight, and never longer than the
// window in which one could still be making progress: past that the worker has
// either finished, died (systemd restarts it), or left a stale in-flight marker
// behind, and none of those is a reason to leave the board cold forever.
const MAPS_GLOBAL_FARMED_WARMUP_POLL_MS = 5_000;
const MAPS_GLOBAL_FARMED_WARMUP_MAX_WAIT_MS = SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS + 60_000;

/**
 * Feed a profile's "Load osu! recents" payload into the score pipeline.
 *
 * That button fetches exactly what the recent-score reconcile job fetches, so
 * ingesting it here costs no extra osu! API budget and lets a profile view top
 * up the tracker while that player's own reconcile is still parked behind queue
 * pressure. Strictly opportunistic: it only fires when someone actually opens a
 * profile, so the queued job stays the real path. Runs detached from the
 * response, on the serving write connection, and never fails the request.
 */
async function ingestProfileRecentScores(ctx: HttpContext, userId: number, scores: OscScore[]): Promise<void> {
  // No dedicated write connection means this process serves read-only (tests,
  // worker role); the reconcile job covers those.
  if (!ctx.serveWriteDb) return;
  const passed = scores
    .filter((score) => score.passed)
    .map((score) => ({ ...score, ruleset_id: score.ruleset_id ?? 3 }));
  if (passed.length === 0) return;
  try {
    const { ScoreIngestor } = await import("../ingest/score-ingestor.js");
    const ingestor = new ScoreIngestor(ctx.serveWriteDb, ctx.serveWriteQueue ?? ctx.queue, ctx.events, ctx.config);
    // Both flags match what reconcileUserRecentScores passes. They are set
    // explicitly rather than left to default, because the ingestor infers them
    // from the source string and only "osu_recent" gets the cheap behaviour.
    const result = await ingestor.ingestBatch(passed, "profile_recent", {
      enqueueRecentReconcile: false,
      processLeaderboardFeatures: false,
    });
    if (result.inserted > 0) {
      logInfo("profile_recent_scores_ingested", { user_id: userId, inserted: result.inserted, skipped: result.skipped });
    }
  } catch (error) {
    logWarn("profile_recent_scores_ingest_failed", { user_id: userId, ...errorContext(error) });
  }
}

export function warmGlobalMapsFarmedBoard(ctx: HttpContext): void {
  void (async () => {
    await unrefDelay(MAPS_GLOBAL_FARMED_WARMUP_DELAY_MS);
    await waitForQuietSchema(ctx.db);
    const meta = await getMapsSnapshotMeta(ctx.db, GLOBAL_COUNTRY_CODE);
    if (!meta.refreshedAt) return;
    await buildGlobalMapsResponseOnThread(ctx, {
      kind: "maps-page",
      country: GLOBAL_COUNTRY_CODE,
      // Any pp > 0 routes through the filtered path and builds the shared
      // board; the specific filter values do not matter.
      query: { tab: "farmed", page: 0, pageSize: 48, key: "all", beatmapSort: "players", farmedSort: "players", dir: "desc", status: "all", pp: 1, mod: "all", q: "" },
      encoding: null,
      maxAgeMs: ctx.config.mapsRefreshIntervalMs,
    });
  })().catch((error) => logWarn("maps_global_farmed_board_warmup_failed", errorContext(error)));
}

// Blocks while a worker/all-role process is inside migrate(). By the time this
// first runs the floor above has elapsed, which is far longer than a restarting
// worker needs to reach its in-flight marker (written right after the initial
// schema), so "no marker in flight" here really does mean nobody is migrating.
async function waitForQuietSchema(db: Db): Promise<void> {
  const startedAt = Date.now();
  let polls = 0;
  for (;;) {
    const state = await readSchemaMigrationState(db);
    if (!state || state.completedAt) {
      if (polls > 0) {
        logInfo("maps_global_farmed_board_warmup_waited", {
          detail: "deferred the global farmed board build until the schema migration finished",
          waited_ms: Date.now() - startedAt,
        });
      }
      return;
    }
    const migrationAgeMs = Date.now() - Date.parse(state.startedAt);
    const stale = !Number.isFinite(migrationAgeMs) || migrationAgeMs > MAPS_GLOBAL_FARMED_WARMUP_MAX_WAIT_MS;
    if (stale || Date.now() - startedAt >= MAPS_GLOBAL_FARMED_WARMUP_MAX_WAIT_MS) {
      logWarn("maps_global_farmed_board_warmup_impatient", {
        detail: "schema migration still marked in flight; building the global farmed board anyway",
        migration_started_at: state.startedAt,
        waited_ms: Date.now() - startedAt,
      });
      return;
    }
    polls += 1;
    await unrefDelay(MAPS_GLOBAL_FARMED_WARMUP_POLL_MS);
  }
}

// unref'd so a pending warm-up never holds the process open (the headless worker
// role and every test rely on the event loop draining on its own).
function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function statusBody(ctx: HttpContext, options: { includeWorkerActivity?: boolean; snapshotCountry?: string } = {}) {
  let cache = statusBodyCacheByCtx.get(ctx);
  if (!cache) {
    cache = new Map();
    statusBodyCacheByCtx.set(ctx, cache);
  }
  const key = `${options.includeWorkerActivity ? "admin" : "public"}:${options.snapshotCountry ?? ""}`;
  const entry = cache.get(key);
  const now = Date.now();
  if (entry?.body) {
    const bodyAge = now - entry.bodyAt;
    if (bodyAge < STATUS_BODY_FRESH_MS) return entry.body;
    if (bodyAge < STATUS_BODY_STALE_SERVE_MS) {
      if (entry.settled && now - entry.startedAt >= STATUS_BODY_FRESH_MS) {
        void startStatusBodyBuild(ctx, options, entry).catch(() => undefined);
      }
      return entry.body;
    }
  }
  // No servable body: wait on the in-flight build if there is one, else build.
  if (entry && !entry.settled) return entry.promise;
  const next: StatusBodyCacheEntry = entry ?? {
    startedAt: now,
    settled: true,
    promise: Promise.resolve({}),
    body: null,
    bodyAt: 0,
  };
  cache.set(key, next);
  return startStatusBodyBuild(ctx, options, next);
}

function startStatusBodyBuild(
  ctx: HttpContext,
  options: { includeWorkerActivity?: boolean; snapshotCountry?: string },
  entry: StatusBodyCacheEntry,
): Promise<Record<string, unknown>> {
  entry.startedAt = Date.now();
  entry.settled = false;
  entry.promise = buildStatusBody(ctx, options)
    .then((body) => {
      entry.body = body;
      entry.bodyAt = Date.now();
      return body;
    })
    .finally(() => {
      entry.settled = true;
    });
  return entry.promise;
}

async function buildStatusBody(ctx: HttpContext, options: { includeWorkerActivity?: boolean; snapshotCountry?: string }): Promise<Record<string, unknown>> {
  // In a split deployment the worker runs in another process, so its live
  // status (lanes, OSC feed, osu! limiter) is mirrored to the DB. Prefer that
  // mirror in server-only mode; fall back to in-process state for "all" mode.
  const mirror = ctx.config.role === "server" ? await readRuntimeStatus(ctx.db) : null;
  // Written by the worker process, read here: it is the only way the serving
  // process can see how much memory a GLOBAL maps refresh actually took. A
  // read failure must degrade to "not reported" rather than take the whole
  // admin body down with it, since this is observability, not state.
  const globalMapsRefresh = options.includeWorkerActivity
    ? await readJobMemoryMetric(ctx.db, "refresh_global_maps").catch(() => null)
    : null;
  // The reads are independent, so they run concurrently: latency is the slowest
  // query, and a write-lock window is waited out once rather than once per
  // query down a sequential chain.
  const [
    db,
    lastEvent,
    storage,
    queueDepth,
    queuePressure,
    queueSummary,
    roster,
    analysis,
    osuFileBackfill,
    scoresFallback,
    apiCalls,
    countries,
    catchup,
    snapshotStats,
    sharedRate,
    disk,
    storagePaths,
  ] = await Promise.all([
    dbHealth(ctx.db),
    exec(ctx.db, "select created_at from live_event_log order by sequence desc limit 1"),
    getLocalDbStorage(ctx.config),
    ctx.queue.depth(),
    ctx.queue.pressure(),
    ctx.queue.summary(),
    rosterSummary(ctx.db),
    analysisStats(ctx.db),
    getBeatmapOsuFileBackfillStatus(ctx.db, { cacheCounts: true }),
    scoresFallbackStatus(ctx, mirror),
    apiCallHistory(ctx.db),
    countryRegistryStatus(ctx),
    countryCatchupStatus(ctx),
    options.snapshotCountry ? adminSnapshotStats(ctx.db, options.snapshotCountry) : Promise.resolve(undefined),
    sharedRateBreakdown(ctx.db),
    // Filesystem pressure and where the disk went. Admin-only, and only paid
    // for on an admin build: statfs is cheap, and the per-path walk behind
    // getStorageFootprint carries its own memo.
    options.includeWorkerActivity ? getDbDiskUsage(ctx.config) : Promise.resolve(undefined),
    options.includeWorkerActivity ? getStorageFootprint(ctx.config) : Promise.resolve(undefined),
  ]);
  const worker = (mirror?.worker as WorkerStatus | null | undefined) ?? ctx.workerStatus?.() ?? null;
  const osc = (mirror?.osc as OscStatus | undefined) ?? ctx.oscStatus();
  // The in-process limiter (or the worker's mirrored copy) only sees its own
  // process's calls; the shared reservation table spans server + worker +
  // scores-fallback, so its last-minute view wins when available.
  const rateBase = mirror?.osuRate ?? ctx.osu.limiter.state();
  const rate = sharedRate ? { ...(rateBase as object), ...sharedRate } : rateBase;
  const sqliteBusy = {
    server: getSqliteBusyRetryStats(),
    worker: mirror?.sqliteBusy ?? (ctx.config.role === "server" ? null : getSqliteBusyRetryStats()),
  };
  // Same server/worker shape as sqliteBusy. The worker's copy rides the
  // live_meta mirror; a worker still running code that does not write it leaves
  // the field undefined, which must read as "unknown", not as a crash. In the
  // "all" role both sides are the same process, hence the pid in the sample.
  const memory = options.includeWorkerActivity
    ? {
      server: readProcessMemory(ctx.config.role ?? "all"),
      worker: (mirror?.memory as ProcessMemorySample | undefined)
        ?? (ctx.config.role === "server" ? null : readProcessMemory(ctx.config.role ?? "all")),
    }
    : undefined;
  // filePath is an absolute path on the server's filesystem and nothing public
  // renders it, so the public body gets everything except that.
  const publicStorage = {
    bytes: storage.bytes,
    walBytes: storage.walBytes,
    maxBytes: storage.maxBytes,
    targetBytes: storage.targetBytes,
    overLimit: storage.overLimit,
  };
  return {
    ok: db,
    db,
    storage: options.includeWorkerActivity ? storage : publicStorage,
    osc,
    lastEventAt: lastEvent.rows[0]?.created_at ?? null,
    queueDepth,
    queuePressure,
    queueSummary: queueSummary.map((row) => ({ ...row, osuApi: OSU_API_BOUND_JOB_TYPES.has(row.type) })),
    roster,
    analysis,
    osuFileBackfill,
    rate,
    sqliteBusy,
    scoresFallback,
    abuse: ctx.abuse?.state() ?? null,
    apiCallHistory: apiCalls,
    countries,
    catchup,
    worker: options.includeWorkerActivity ? adminWorkerStatus(worker) : publicWorkerStatus(worker),
    ...(snapshotStats ? { snapshotStats } : {}),
    ...(memory ? { memory } : {}),
    ...(options.includeWorkerActivity
      ? {
        // Asking for the thread's status must never be what constructs it.
        mapsSnapshotThread: mapsSnapshotThreadStatus(ctx.config),
        responseCaches: mapsResponseCacheMetrics(ctx.db),
        disk: disk ?? null,
        storagePaths: storagePaths ?? null,
        globalMapsRefresh,
      }
      : {}),
  };
}

// Entry count and body bytes for the maps-page prepared-response cache, surfaced
// in /api/admin/status so the byte budgets are observable in production.
function mapsResponseCacheMetrics(db: Db) {
  const state = getMapsResponseCacheState(db);
  const describe = (cache: MapsResponseCache) => ({
    entries: cache.entries.size,
    bytes: cache.totalBytes,
    maxEntries: cache.maxEntries,
    maxBytes: cache.maxBytes,
    maxEntryBytes: cache.maxEntryBytes,
  });
  return {
    mapsPage: describe(state.pageResponses),
  };
}

function healthBody(ctx: HttpContext, options: { db?: boolean } = {}) {
  const db = options.db;
  return {
    ok: db ?? true,
    ...(db == null ? {} : { db }),
    role: ctx.config.role ?? "all",
    at: new Date().toISOString(),
  };
}

// Beatmap chart-analysis progress: how many maps have a ready skill vector at the
// current analysis version (the pool that powers pattern search + collections),
// plus what is still in flight, failed, or un-analyzable, and how many are indexed.
async function analysisStats(db: Db) {
  const [vectors, indexed] = await Promise.all([
    exec(
      db,
      "select status, count(*) as count from beatmap_skill_vectors where analysis_version = ? group by status",
      [ACTIVITY_SKILL_ANALYSIS_VERSION],
    ),
    exec(db, "select count(*) as count from map_search_index"),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of vectors.rows) byStatus[String(row.status)] = Number(row.count ?? 0);
  return {
    version: ACTIVITY_SKILL_ANALYSIS_VERSION,
    analyzed: byStatus.ready ?? 0,
    running: byStatus.running ?? 0,
    failed: byStatus.failed ?? 0,
    unavailable: byStatus.unavailable ?? 0,
    searchIndexed: Number(indexed.rows[0]?.count ?? 0),
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
  const countries = await getCountryRegistry(ctx.db, ctx.config, { ensure: false });
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
  const countries = await getCountryRegistry(ctx.db, ctx.config, { ensure: false });
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

// Cross-process last-minute osu! rate view from the shared limiter's
// reservation log: unlike the per-process limiter state, this covers server
// interactive calls, worker jobs, and the scores-fallback poller together.
async function sharedRateBreakdown(db: Db): Promise<{
  usedLastMinute: number;
  byCaller: Array<{ caller: string; count: number }>;
  byPath: Array<{ path: string; count: number }>;
  byLane: Array<{ lane: string; count: number }>;
} | null> {
  try {
    const rows = (await exec(
      db,
      "select caller, path, lane from api_rate_limit_reservations where provider = 'osu' and started_at_ms > ?",
      [Date.now() - 60_000],
    )).rows;
    const tally = (key: "caller" | "path" | "lane") => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = String(row[key] ?? "unknown");
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      usedLastMinute: rows.length,
      byCaller: tally("caller").map(([caller, count]) => ({ caller, count })),
      byPath: tally("path").slice(0, 10).map(([path, count]) => ({ path, count })),
      byLane: tally("lane").map(([lane, count]) => ({ lane, count })),
    };
  } catch {
    return null;
  }
}

async function apiCallHistory(db: Db) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const [byCaller, byPath] = await Promise.all([
    exec(
      db,
      `select coalesce(t.caller, l.caller) as caller, count(*) as count,
              round(avg(l.duration_ms)) as avg_ms, max(l.duration_ms) as max_ms,
              sum(case when l.status >= 400 then 1 else 0 end) as errors
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
      `select coalesce(t.path, l.path) as path, count(*) as count,
              round(avg(l.duration_ms)) as avg_ms, max(l.duration_ms) as max_ms,
              sum(case when l.status >= 400 then 1 else 0 end) as errors
       from api_call_log l
       left join api_call_targets t on t.id = l.target_id
       where l.provider = 'osu' and l.started_at >= ?
       group by coalesce(t.path, l.path)
       order by count desc
       limit 20`,
      [since],
    ),
  ]);
  const stats = (row: Record<string, unknown>) => ({
    count: Number(row.count),
    avgMs: row.avg_ms == null ? null : Number(row.avg_ms),
    maxMs: row.max_ms == null ? null : Number(row.max_ms),
    errors: Number(row.errors ?? 0),
  });
  return {
    windowMinutes: 15,
    byCaller: byCaller.rows.map((row) => ({ caller: String(row.caller), ...stats(row) })),
    byPath: byPath.rows.map((row) => ({ path: String(row.path), ...stats(row) })),
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
    // never build a roster or registry row for it. Scheduled off the serving
    // connection, throttled and fire-and-forget (see scheduleGlobalMapsRefresh).
    scheduleGlobalMapsRefresh(ctx);
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
  // Hot path: an already-registered country is served entirely from a READ of
  // the registry on the serving connection. The write-side bookkeeping
  // (last_requested_at touch + roster/maps refresh scheduling) is pushed to a
  // dedicated write connection, throttled and fire-and-forget. This is the
  // invariant that keeps a busy single WAL writer (a long worker job holding the
  // lock) from ever blocking or 500ing a page load: the serving connection does
  // no writes, so a stuck write can't queue in front of the reads and freeze the
  // site. The earlier WAL-size brake only bounded the symptom (file growth); this
  // removes the cause.
  if (registered && ctx.serveWriteDb) {
    const row = await getCountryRegistryRow(ctx.db, country, ctx.config);
    if (row) {
      scheduleCountryServeBookkeeping(ctx, country);
      return row;
    }
    // Registry row lost a race between the check and the read: fall through and
    // (re)activate synchronously below.
  }
  // Cold country (first ever request), or the lost-row race above. Activate
  // synchronously so the caller can serve, but route the write to the dedicated
  // write connection when we have one so even this rare activation can't stall
  // reads on the serving connection.
  const activationDb = ctx.serveWriteDb ?? ctx.db;
  const activationQueue = ctx.serveWriteQueue ?? ctx.queue;
  const activated = await activateCountry(activationDb, activationQueue, ctx.config, country);
  if (ctx.config.enableOsuApiJobs && isCountryFeatureAtLeast(activated.featureTier, "maps_warm")) {
    await enqueueMapsRefreshIfDue(activationDb, activationQueue, activated.country, ctx.config.mapsRefreshIntervalMs, { priority: 15 });
  }
  return activated;
}

// Serving-path bookkeeping is throttled per country: last_requested_at only has
// to advance often enough to keep a country "warm" (warm TTL is minutes-to-hours),
// not on every request. Bounded set of countries, so this map never needs eviction.
const COUNTRY_SERVE_BOOKKEEPING_THROTTLE_MS = 30_000;
const lastCountryServeBookkeepingAt = new Map<string, number>();

// Fire-and-forget the per-request registry bookkeeping onto the dedicated write
// connection. Never awaited by (and never able to fail) the request that triggers
// it, and skipped entirely when the writer is contended — the throttle lets the
// next request retry. Reuses the exact activate/refresh logic, just isolated from
// the serving connection.
function scheduleCountryServeBookkeeping(ctx: HttpContext, country: string): void {
  const writeDb = ctx.serveWriteDb;
  const queue = ctx.serveWriteQueue;
  if (!writeDb || !queue) return;
  const key = country.trim().toUpperCase();
  const now = Date.now();
  if (now - (lastCountryServeBookkeepingAt.get(key) ?? 0) < COUNTRY_SERVE_BOOKKEEPING_THROTTLE_MS) return;
  lastCountryServeBookkeepingAt.set(key, now);
  void (async () => {
    const activated = await activateCountry(writeDb, queue, ctx.config, key);
    if (ctx.config.enableOsuApiJobs && isCountryFeatureAtLeast(activated.featureTier, "maps_warm")) {
      await enqueueMapsRefreshIfDue(writeDb, queue, activated.country, ctx.config.mapsRefreshIntervalMs, { priority: 15 });
    }
  })().catch(() => {
    // Best-effort: a busy writer just means this cycle is skipped; a page load
    // must never depend on, wait for, or fail because of this bookkeeping.
  });
}

const GLOBAL_MAPS_REFRESH_THROTTLE_MS = 30_000;
let lastGlobalMapsRefreshScheduleAt = 0;

// GLOBAL is served from an in-memory cache; keep its merged maps snapshot fresh
// without ever writing on the serving connection.
function scheduleGlobalMapsRefresh(ctx: HttpContext): void {
  const writeDb = ctx.serveWriteDb;
  const queue = ctx.serveWriteQueue;
  if (!writeDb || !queue) return;
  const now = Date.now();
  if (now - lastGlobalMapsRefreshScheduleAt < GLOBAL_MAPS_REFRESH_THROTTLE_MS) return;
  lastGlobalMapsRefreshScheduleAt = now;
  void enqueueGlobalMapsRefreshIfDue(writeDb, queue, ctx.config.mapsRefreshIntervalMs, { priority: 15 }).catch(() => undefined);
}

async function isCountryRegistered(db: Db, country: string): Promise<boolean> {
  const row = (await exec(db, "select 1 from country_registry where country = ? limit 1", [country])).rows[0];
  return !!row;
}

// `suffix` splits a bucket's limit into an independent per-IP window without
// inventing a new bucket (and a new env var) for it. Used where two groups of
// endpoints deserve the same ceiling but must not spend each other's budget.
function checkRate(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, bucket: AbuseBucket, suffix = ""): boolean {
  if (!ctx.abuse || isAdmin(req, ctx)) return true;
  const result = ctx.abuse.check(req, ctx.config, bucket, suffix);
  if (result.allowed) return true;
  sendRateLimited(req, res, ctx, result);
  return false;
}

// Rejections used to be silent, which is why the 2026-08-03 pack-probe fan-out
// had to be reconstructed from queue rows: nothing recorded whether those hand
// probes were 429ed, timed out, or died at the edge. One line per bucket+route
// per interval, carrying the count suppressed since the last one, so a cascade
// is visible without the log becoming the flood.
const RATE_LIMIT_LOG_INTERVAL_MS = 10_000;
const RATE_LIMIT_LOG_STATE_MAX = 256;
const rateLimitLogState = new Map<string, { lastLoggedAtMs: number; suppressed: number }>();

// Collapses the dynamic segment of the per-player routes so the state map holds
// one entry per route shape, not one per player.
function rateLimitRouteKey(rawUrl: string | undefined): string {
  const pathname = (rawUrl ?? "").split("?")[0];
  return pathname.replace(/^\/api\/profiles\/[^/]+\//, "/api/profiles/*/").slice(0, 120);
}

function logRateLimited(req: IncomingMessage, result: Exclude<RateLimitResult, { allowed: true }>): void {
  const route = rateLimitRouteKey(req.url);
  const key = `${result.bucket}:${route}`;
  const nowMs = Date.now();
  const state = rateLimitLogState.get(key);
  if (state != null && nowMs - state.lastLoggedAtMs < RATE_LIMIT_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    return;
  }
  if (rateLimitLogState.size >= RATE_LIMIT_LOG_STATE_MAX) rateLimitLogState.clear();
  rateLimitLogState.set(key, { lastLoggedAtMs: nowMs, suppressed: 0 });
  logWarn("rate_limited", {
    bucket: result.bucket,
    route,
    limit: result.limit,
    retry_after_ms: result.retryAfterMs,
    suppressed_since_last: state?.suppressed ?? 0,
  });
}

export function sendRateLimited(req: IncomingMessage, res: ServerResponse, ctx: Pick<HttpContext, "config">, result: Exclude<RateLimitResult, { allowed: true }>): void {
  res.setHeader("retry-after", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
  logRateLimited(req, result);
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
  // Farm Helper stages append to the app total rather than replacing it, so
  // the header still reads as one request with a breakdown underneath.
  const stages = (req as TimedRequest)[REQUEST_FARM_HELPER_TIMINGS];
  res.setHeader("server-timing", stages
    ? `app;dur=${durationMs.toFixed(1)}, ${stages.toServerTiming()}`
    : `app;dur=${durationMs.toFixed(1)}`);
}

// Prepared /maps-page responses are cached already serialized and compressed.
// The shorter TTL while a country refresh is running bounds how long volatile
// refresh-state flags can lag; generation markers invalidate settled entries.
const MAPS_PAGE_RESPONSE_CACHE_TTL_MS = 10 * 60_000;
const MAPS_PAGE_RESPONSE_CACHE_MAX_ENTRIES = 128;
const MAPS_REFRESHING_RESPONSE_CACHE_TTL_MS = 30_000;
// Byte budgets (Phase 7). Entry counts alone can't bound memory: one entry may
// hold a large body. Maps-page bodies are normally <= ~64 KiB, so this budget
// is a safety ceiling rather than a tuning knob.
const MAPS_PAGE_RESPONSE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
// No single body may occupy a meaningful slice of a cache budget. Larger
// bodies are still served, just never retained.
const MAPS_RESPONSE_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
// A 200 body above this size is only served compressed: clients that accept
// neither br nor gzip get a cached 406 instead. This keeps very large identity
// bodies out of the cache without opening a rebuild-per-request path for
// Accept-Encoding-less clients — the tiny 406 is cached under the identity
// key. Every browser and standard HTTP library sends Accept-Encoding.
const MAPS_IDENTITY_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
// How long past its TTL a GLOBAL entry may still be served while a background
// rebuild replaces it. GLOBAL page builds can be expensive, so requests get
// the previous generation instantly and the rebuild runs once off the request
// path. Country entries don't opt in (staleServeMs 0).
const MAPS_GLOBAL_STALE_SERVE_MS = 45 * 60_000;

export interface MapsResponseCacheEntry extends PreparedJsonResponse {
  storedAt: number;
  ttlMs: number;
  staleServeMs: number;
  freshnessKey: string;
}

// A prepared-response cache bounded by body bytes as well as entry count.
// totalBytes is maintained incrementally by the set/delete helpers below; all
// mutations must go through them.
export interface MapsResponseCache {
  entries: Map<string, MapsResponseCacheEntry>;
  totalBytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
}

// Per-Db cache state so entries never leak across databases (one process holds
// a single Db in production; tests spin up a fresh Db each). This matters now
// that GLOBAL keys are stable across generations instead of embedding
// refreshed_at.
interface MapsResponseCacheState {
  pageResponses: MapsResponseCache;
  pageInflight: Map<string, Promise<PreparedJsonResponse>>;
}

const mapsResponseCacheByDb = new WeakMap<Db, MapsResponseCacheState>();

export function createMapsResponseCache(
  maxEntries: number,
  maxBytes: number,
  maxEntryBytes = MAPS_RESPONSE_CACHE_MAX_ENTRY_BYTES,
): MapsResponseCache {
  return { entries: new Map(), totalBytes: 0, maxEntries, maxBytes, maxEntryBytes };
}

function getMapsResponseCacheState(db: Db): MapsResponseCacheState {
  let state = mapsResponseCacheByDb.get(db);
  if (!state) {
    state = {
      pageResponses: createMapsResponseCache(MAPS_PAGE_RESPONSE_CACHE_MAX_ENTRIES, MAPS_PAGE_RESPONSE_CACHE_MAX_BYTES),
      pageInflight: new Map(),
    };
    mapsResponseCacheByDb.set(db, state);
  }
  return state;
}

export function mapsResponseCacheDelete(cache: MapsResponseCache, key: string): void {
  const existing = cache.entries.get(key);
  if (!existing) return;
  cache.entries.delete(key);
  cache.totalBytes -= existing.body.length;
}

export function mapsResponseCacheSet(cache: MapsResponseCache, key: string, entry: MapsResponseCacheEntry): void {
  // Oversized bodies are served but never retained: a single entry must not
  // occupy a meaningful slice of the cache budget.
  if (entry.body.length > cache.maxEntryBytes) {
    mapsResponseCacheDelete(cache, key);
    return;
  }
  // Delete-then-set keeps Map insertion order meaningful for the oldest-first
  // eviction below.
  mapsResponseCacheDelete(cache, key);
  cache.entries.set(key, entry);
  cache.totalBytes += entry.body.length;
  evictMapsResponseCacheOverflow(cache);
}

function evictMapsResponseCacheOverflow(cache: MapsResponseCache): void {
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (cache.entries.size > cache.maxEntries || cache.totalBytes > cache.maxBytes) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    mapsResponseCacheDelete(cache, oldest);
  }
}

export function pruneMapsResponseCache(cache: MapsResponseCache, now: number): void {
  for (const [key, entry] of cache.entries) {
    if (now - entry.storedAt > entry.ttlMs + entry.staleServeMs) mapsResponseCacheDelete(cache, key);
  }
  evictMapsResponseCacheOverflow(cache);
}

// A 200 body too large for identity transfer becomes a tiny cacheable 406:
// see MAPS_IDENTITY_RESPONSE_MAX_BYTES. vary is set because the outcome
// depends on Accept-Encoding even though this body itself is uncompressed.
function enforceCompressedLargeBody(
  result: { prepared: PreparedJsonResponse; cacheTtlMs: number | null },
  encoding: "br" | "gzip" | null,
): { prepared: PreparedJsonResponse; cacheTtlMs: number | null } {
  const { prepared } = result;
  if (encoding !== null || prepared.status !== 200 || prepared.body.length <= MAPS_IDENTITY_RESPONSE_MAX_BYTES) {
    return result;
  }
  const body = Buffer.from(JSON.stringify({
    error: "compression_required",
    message: "This response is only served compressed. Repeat the request with Accept-Encoding: br or gzip.",
  }), "utf8");
  return { prepared: { status: 406, encoding: null, vary: true, body }, cacheTtlMs: result.cacheTtlMs };
}

// Try to run a GLOBAL maps-page build on the snapshot worker thread, where its
// synchronous libsql reads and multi-second hydrate can't stall the server's
// event loop. Null means the thread genuinely can't run here (disabled, or it
// never managed to spawn — e.g. under vitest) and the caller should build
// inline. Anything that went wrong after the thread has been online (build
// failure, timeout, crash, cooldown) throws MapsSnapshotBuildError instead:
// re-running a build that heavy inline on the loop is exactly the stall the
// thread exists to prevent, and the stale cache keeps serving meanwhile.
async function buildGlobalMapsResponseOnThread(
  ctx: HttpContext,
  request: MapsSnapshotThreadBuildRequest,
): Promise<PreparedJsonResponse | null> {
  const thread = getMapsSnapshotThread(ctx.config);
  if (!thread) return null;
  if (!thread.available()) {
    if (thread.inlineFallbackAllowed()) return null;
    throw new MapsSnapshotBuildError("maps snapshot thread cooling down");
  }
  try {
    return await thread.build(request);
  } catch (error) {
    if (error instanceof MapsSnapshotBuildError) throw error;
    logWarn("maps_snapshot_thread_inline_fallback", errorContext(error));
    return null;
  }
}

interface MapsResponseCachedServeOptions {
  cache: MapsResponseCache;
  inflight: Map<string, Promise<PreparedJsonResponse>>;
  /** Stable cache key; null disables caching (no snapshot row yet). */
  key: string | null;
  /**
   * Generation marker checked against the stored entry. When the key itself
   * carries every input (country entries), pass a constant "".
   */
  freshnessKey: string;
  /** 0 = never serve a stale/mismatched entry; rebuild in the foreground. */
  staleServeMs: number;
  build: () => Promise<{ prepared: PreparedJsonResponse; cacheTtlMs: number | null }>;
}

async function serveMapsResponseCached(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  options: MapsResponseCachedServeOptions,
): Promise<void> {
  const { cache, inflight, key, freshnessKey, staleServeMs, build } = options;
  if (!key) {
    writePreparedJson(req, res, ctx, (await build()).prepared);
    return;
  }
  const now = Date.now();
  const entry = cache.entries.get(key);
  if (entry) {
    const age = now - entry.storedAt;
    if (entry.freshnessKey === freshnessKey && age < entry.ttlMs) {
      writePreparedJson(req, res, ctx, entry);
      return;
    }
    if (staleServeMs > 0 && age < entry.ttlMs + staleServeMs) {
      // Serve the previous generation immediately; replace it in the
      // background, single-flight per key so a burst can't stack rebuilds.
      if (!inflight.has(key)) {
        void startMapsResponseBuild(options).catch(() => undefined);
      }
      writePreparedJson(req, res, ctx, entry);
      return;
    }
  }
  // Coalesce concurrent misses: a burst of visitors right after a rebuild
  // (or restart) must run the multi-second hydrate once, not once each.
  const pending = inflight.get(key) ?? startMapsResponseBuild(options);
  writePreparedJson(req, res, ctx, await pending);
}

function startMapsResponseBuild(options: MapsResponseCachedServeOptions): Promise<PreparedJsonResponse> {
  const { cache, inflight, key, freshnessKey, staleServeMs, build } = options;
  if (!key) return build().then(({ prepared }) => prepared);
  const promise = build()
    .then(({ prepared, cacheTtlMs }) => {
      if (cacheTtlMs != null) {
        mapsResponseCacheSet(cache, key, { ...prepared, storedAt: Date.now(), ttlMs: cacheTtlMs, staleServeMs, freshnessKey });
      }
      return prepared;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
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

// Serving a cached profile snapshot is a pure DB read, but every hit still
// pays gunzip of two compressed columns, display-metadata hydration, the
// top-play projection and a fresh stringify + compress of an up-to-700KB
// body. Pack opening fetches several profiles back to back and retries on
// card flip, so a short prepared-response memo (keyed by profile key, view
// and encoding) makes repeat hits free. The TTL stays short because profiles
// update live from the score pipeline; the byte budget stays small because
// the VPS has no memory to spare.
const PROFILE_SNAPSHOT_RESPONSE_CACHE_TTL_MS = 20_000;
const PROFILE_SNAPSHOT_RESPONSE_CACHE_MAX_ENTRIES = 64;
const PROFILE_SNAPSHOT_RESPONSE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const PROFILE_SNAPSHOT_RESPONSE_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;

interface ProfileSnapshotResponseState {
  responses: MapsResponseCache;
  inflight: Map<string, Promise<PreparedJsonResponse>>;
}

// Per-Db so entries never leak across databases (tests spin up a fresh Db
// each; production holds one per process).
const profileSnapshotResponseStateByDb = new WeakMap<Db, ProfileSnapshotResponseState>();

function getProfileSnapshotResponseState(db: Db): ProfileSnapshotResponseState {
  let state = profileSnapshotResponseStateByDb.get(db);
  if (!state) {
    state = {
      responses: createMapsResponseCache(
        PROFILE_SNAPSHOT_RESPONSE_CACHE_MAX_ENTRIES,
        PROFILE_SNAPSHOT_RESPONSE_CACHE_MAX_BYTES,
        PROFILE_SNAPSHOT_RESPONSE_CACHE_MAX_ENTRY_BYTES,
      ),
      inflight: new Map(),
    };
    profileSnapshotResponseStateByDb.set(db, state);
  }
  return state;
}

async function handleCachedProfileSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
  key: string,
): Promise<void> {
  // view=card serves the slim pack-card projection; the default stays the
  // full snapshot the profile page consumes.
  const view = url.searchParams.get("view") === "card" ? "card" : "full";
  const lookupMode = url.searchParams.get("lookup") === "id" ? "userId" : "auto";
  // A pure read belongs on the read connection. serveWriteDb is the tiny
  // write-only side connection (2 MiB cache, no mmap) for the serving path's
  // bookkeeping writes; this handler deliberately warms nothing, and running
  // its reads there gave a sweep across distinct players no page cache to hit.
  const db = ctx.db;
  const encoding = negotiateEncoding(req);
  const state = getProfileSnapshotResponseState(db);
  pruneMapsResponseCache(state.responses, Date.now());
  res.setHeader("cache-control", "public, max-age=15, stale-while-revalidate=60");
  await serveMapsResponseCached(req, res, ctx, {
    cache: state.responses,
    inflight: state.inflight,
    key: [lookupMode, key.toLowerCase(), view, encoding ?? "identity"].join("|"),
    freshnessKey: "",
    staleServeMs: 0,
    build: async () => {
      // Deliberately never warms a cold profile. Both callers follow an empty
      // response with /snapshot milliseconds later (the profile page's client
      // after its SSR read, the pack card when bestScores comes back empty),
      // and that mints the player inline. Kicking off a warm here would race
      // that mint from another lane and pay for the whole profile twice.
      // The card view never builds a profile: it reads the stored rows and
      // projects them (see getCachedPackCardSnapshot).
      const body = view === "card"
        ? await getCachedPackCardSnapshot(db, key, { lookupMode })
        : await getCachedPlayerProfileSnapshot(db, key, { lookupMode });
      if (!body) {
        return {
          prepared: await prepareJsonResponse(404, { error: "not_cached" }, encoding),
          cacheTtlMs: PROFILE_SNAPSHOT_RESPONSE_CACHE_TTL_MS,
        };
      }
      await enrichPayloadAvatarAccents(ctx.db, ctx.queue ?? null, body);
      return {
        prepared: await prepareJsonResponse(200, body, encoding),
        cacheTtlMs: PROFILE_SNAPSHOT_RESPONSE_CACHE_TTL_MS,
      };
    },
  });
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

// Every list is validated against a closed vocabulary and every id list is
// capped, so a hand-written query string can't grow the draw's SQL. Garbage
// values are dropped rather than 400'd, like the sibling maps routes.
function parseMapsRandomDrawQuery(params: URLSearchParams): MapsRandomDrawQuery {
  const idList = (key: string, max: number): number[] => parseUserIds(params.get(key)).slice(0, max);
  return {
    weight: params.get("weight") === "players" ? "players" : "favourites",
    count: clampInteger(params.get("count"), 0, MAPS_RANDOM_DRAW_MAX_COUNT, MAPS_RANDOM_DRAW_DEFAULT_COUNT),
    status: parseCsvSubset(params.get("status"), MAPS_RANDOM_STATUS_BUCKETS),
    statusExclude: parseCsvSubset(params.get("statusExclude"), MAPS_RANDOM_STATUS_BUCKETS),
    keys: parseCsvSubset(params.get("keys"), MAPS_RANDOM_KEY_BUCKETS),
    keysExclude: parseCsvSubset(params.get("keysExclude"), MAPS_RANDOM_KEY_BUCKETS),
    patterns: parseCsvSubset(params.get("patterns"), MAPS_RANDOM_PATTERN_NAMES),
    patternsExclude: parseCsvSubset(params.get("patternsExclude"), MAPS_RANDOM_PATTERN_NAMES),
    starMin: optionalBoundedNumber(params.get("starMin"), 0, MAPS_RANDOM_DRAW_STAR_MAX) ?? 0,
    starMax: optionalBoundedNumber(params.get("starMax"), 0, MAPS_RANDOM_DRAW_STAR_MAX) ?? 0,
    excludeUsers: idList("excludeUsers", MAPS_RANDOM_DRAW_EXCLUDE_USERS_MAX),
    excludeSets: idList("excludeSets", MAPS_RANDOM_DRAW_EXCLUDE_SETS_MAX),
    hideUsers: idList("hideUsers", MAPS_RANDOM_DRAW_HIDE_USERS_MAX),
  };
}

function parseMapSearchQuery(params: URLSearchParams): MapSearchQuery {
  const rawSort = params.get("sort");
  const sort: MapSearchSort =
    rawSort === "stars" || rawSort === "bpm" || rawSort === "length" || rawSort === "playcount" || rawSort === "date" || rawSort === "relevance"
      ? rawSort
      : "playcount";
  const stars = parseSearchRange(params, "starMin", "starMax", 0, 20);
  const bpm = parseSearchRange(params, "bpmMin", "bpmMax", 0, 2000);
  const length = parseSearchRange(params, "lenMin", "lenMax", 0, 100_000);
  const dan = parseSearchRange(params, "danMin", "danMax", -2, 21);
  const rawCountry = (params.get("country") ?? "").trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null;
  return {
    q: (params.get("q") ?? "").trim().slice(0, 120),
    keys: parseCsvSubset(params.get("keys"), ["4k", "7k", "other"]),
    keysExclude: parseCsvSubset(params.get("keysExclude"), ["4k", "7k", "other"]),
    statuses: parseCsvSubset(params.get("statuses"), ["ranked", "qualified", "loved", "graveyard", "other"]),
    statusesExclude: parseCsvSubset(params.get("statusesExclude"), ["ranked", "qualified", "loved", "graveyard", "other"]),
    patterns: parseCsvSubset(params.get("patterns"), [...MAP_SEARCH_PATTERNS, ...MAP_SEARCH_SUB_PATTERNS]),
    patternsExclude: parseCsvSubset(params.get("patternsExclude"), [...MAP_SEARCH_PATTERNS, ...MAP_SEARCH_SUB_PATTERNS]),
    starMin: stars.min,
    starMax: stars.max,
    bpmMin: bpm.min,
    bpmMax: bpm.max,
    lenMin: length.min,
    lenMax: length.max,
    danMin: dan.min,
    danMax: dan.max,
    country,
    sort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    page: clampInteger(params.get("page"), 0, 10_000, 0),
    pageSize: clampInteger(params.get("pageSize"), 1, 48, 24),
  };
}

function parseCsvSubset(raw: string | null, allowed: string[]): string[] {
  if (!raw) return [];
  const allowedSet = new Set(allowed);
  return [...new Set(raw.toLowerCase().split(",").map((value) => value.trim()).filter((value) => allowedSet.has(value)))];
}

function parseSearchRange(params: URLSearchParams, minKey: string, maxKey: string, lo: number, hi: number): { min: number | null; max: number | null } {
  let min = optionalBoundedNumber(params.get(minKey), lo, hi);
  let max = optionalBoundedNumber(params.get(maxKey), lo, hi);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min, max };
}

function optionalBoundedNumber(raw: string | null, lo: number, hi: number): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(lo, Math.min(hi, value));
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
  pool?: "packs";
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
    ...(params.get("pool") === "packs" ? { pool: "packs" as const } : {}),
  };
}

async function handleMapsPageSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  country: string,
  query: MapsPageQuery,
): Promise<void> {
  const cacheState = getMapsResponseCacheState(ctx.db);
  pruneMapsResponseCache(cacheState.pageResponses, Date.now());
  const encoding = negotiateEncoding(req);
  const normalized = country.toUpperCase();
  const global = isGlobalCountry(normalized);

  const meta = await getMapsSnapshotMeta(ctx.db, country);
  // On GLOBAL the source/overlay stamps churn with every ingested score but
  // never reach the response body (the farmed overlay is only applied to
  // per-country snapshots), so keying on them made every GLOBAL request a
  // cache miss that re-paid the full payload hydrate — a multi-second
  // event-loop stall each time. GLOBAL keys therefore carry only the stable
  // parts, with the row's own refreshed_at (bumped by the periodic global
  // rebuild) as the entry's generation marker, replaced via stale-serve.
  // Country responses do depend on the overlay, so their key keeps every
  // stamp and invalidates the moment one changes, exactly as before.
  const farmedOverlayKey = query.tab === "farmed" ? meta.farmedOverlayUpdatedAt ?? "" : "";
  const sourceRefreshKey = meta.sourceRefreshedAt ?? "";
  const queryKey = [
    normalized,
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
    encoding ?? "identity",
  ].join("|");
  const cacheKey = meta.refreshedAt
    ? global
      ? queryKey
      : `${queryKey}|${meta.refreshedAt}|${sourceRefreshKey}|${farmedOverlayKey}`
    : null;

  await serveMapsResponseCached(req, res, ctx, {
    cache: cacheState.pageResponses,
    inflight: cacheState.pageInflight,
    key: cacheKey,
    freshnessKey: global ? meta.refreshedAt ?? "" : "",
    staleServeMs: global ? MAPS_GLOBAL_STALE_SERVE_MS : 0,
    build: async () => {
      if (global) {
        const prepared = await buildGlobalMapsResponseOnThread(ctx, {
          kind: "maps-page",
          country,
          query,
          encoding,
          maxAgeMs: ctx.config.mapsRefreshIntervalMs,
        });
        if (prepared) {
          return enforceCompressedLargeBody(
            { prepared, cacheTtlMs: prepared.status === 200 ? MAPS_PAGE_RESPONSE_CACHE_TTL_MS : null },
            encoding,
          );
        }
      }
      const snapshot = await getMapsPageSnapshot(ctx.db, ctx.queue, country, ctx.config.mapsRefreshIntervalMs, query);
      const status = snapshot.value ? 200 : 202;
      const prepared = await prepareJsonResponse(status, snapshot, encoding);
      // Only cache populated 200s — never the cold "still building" 202/null
      // state. GLOBAL skips the short mid-refresh TTL: it is permanently
      // "behind sources", so that TTL would degenerate into near-constant
      // rebuilds; its generation marker invalidates entries instead.
      const cacheTtlMs = status !== 200 || snapshot.value == null
        ? null
        : !global && snapshot.refreshQueued
          ? MAPS_REFRESHING_RESPONSE_CACHE_TTL_MS
          : MAPS_PAGE_RESPONSE_CACHE_TTL_MS;
      return enforceCompressedLargeBody({ prepared, cacheTtlMs }, encoding);
    },
  });
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

function readMyDataTrackedQuery(params: URLSearchParams): MyDataTrackedFeedQuery {
  return {
    search: params.get("q"),
    key: params.get("key"),
    mods: params.get("mods"),
    archive: params.get("archive"),
    sort: params.get("sort"),
  };
}

function readMyDataTopPlaysQuery(params: URLSearchParams): MyDataTopPlaysQuery {
  return {
    search: params.get("q"),
    key: params.get("key"),
    mods: params.get("mods"),
    sort: params.get("sort"),
  };
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

function parseProfileRoute(pathname: string): { kind: "cached-snapshot" | "snapshot" | "recent" | "about" | "activity" | "activity-day" | "activity-availability" | "skills"; key: string } | null {
  const match = /^\/api\/profiles\/([^/]+)\/(cached-snapshot|snapshot|recent|about|activity|activity-day|activity-availability|skills)$/.exec(pathname);
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return {
    key,
    kind: match[2] as "cached-snapshot" | "snapshot" | "recent" | "about" | "activity" | "activity-day" | "activity-availability" | "skills",
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

// Forwarded verbatim as the JSON body of a POST-only osu! v2 read (e.g.
// /beatmaps/{id}/attributes); size-capped so the proxy can't relay junk.
function normalizeOsuApiBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid osu! API body.");
  }
  if (JSON.stringify(raw).length > 2000) throw new Error("Invalid osu! API body.");
  return raw as Record<string, unknown>;
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
  // Fail closed: no configured token means no admin access in any NODE_ENV.
  const token = ctx.config.liveAdminToken;
  if (!token) return false;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function normalizeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const id = Math.floor(Number(entry));
    if (Number.isFinite(id) && id > 0) out.push(id);
  }
  return out;
}

interface DanClassifierDiff {
  beatmapId: number;
  beatmapsetId: number;
  version: string;
  starRating: number | null;
  keyCount: number | null;
  mode: string;
  cached: boolean;
}

// Set/diff metadata for the dan-classifier admin page, resolved purely from the
// local beatmaps/beatmapsets/beatmap_osu_files projections (no osu! API).
async function getDanClassifierSets(
  db: Db,
  beatmapsetIds: number[],
  beatmapIds: number[],
): Promise<{
  sets: Array<{ beatmapsetId: number; title: string | null; artist: string | null; diffs: DanClassifierDiff[] }>;
  missingBeatmapsetIds: number[];
  missingBeatmapIds: number[];
}> {
  const missingBeatmapIds: number[] = [];
  const setIds = new Set<number>(beatmapsetIds);

  if (beatmapIds.length) {
    const placeholders = beatmapIds.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, beatmapset_id from beatmaps where beatmap_id in (${placeholders})`,
      beatmapIds,
    )).rows;
    const found = new Map<number, number>();
    for (const row of rows) {
      found.set(Number(row.beatmap_id), Number(row.beatmapset_id));
    }
    for (const beatmapId of beatmapIds) {
      const setId = found.get(beatmapId);
      if (setId && setId > 0) setIds.add(setId);
      else missingBeatmapIds.push(beatmapId);
    }
  }

  const requestedSetIds = [...setIds];
  const diffsBySet = new Map<number, DanClassifierDiff[]>();
  if (requestedSetIds.length) {
    const placeholders = requestedSetIds.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select b.beatmap_id, b.beatmapset_id, b.version, b.difficulty_rating, b.cs, b.mode,
              case when f.beatmap_id is not null and (f.content_blob is not null or f.content != '') then 1 else 0 end as has_file
       from beatmaps b
       left join beatmap_osu_files f on f.beatmap_id = b.beatmap_id
       where b.beatmapset_id in (${placeholders}) and b.mode = 'mania'
       order by b.beatmapset_id, b.difficulty_rating`,
      requestedSetIds,
    )).rows;
    for (const row of rows) {
      const setId = Number(row.beatmapset_id);
      const diffs = diffsBySet.get(setId) ?? [];
      diffs.push({
        beatmapId: Number(row.beatmap_id),
        beatmapsetId: setId,
        version: row.version == null ? "" : String(row.version),
        starRating: row.difficulty_rating == null ? null : Number(row.difficulty_rating),
        keyCount: row.cs == null ? null : Number(row.cs),
        mode: String(row.mode ?? "mania"),
        cached: Number(row.has_file) === 1,
      });
      diffsBySet.set(setId, diffs);
    }
  }

  const meta = new Map<number, { title: string | null; artist: string | null }>();
  const setIdsWithDiffs = [...diffsBySet.keys()];
  if (setIdsWithDiffs.length) {
    const placeholders = setIdsWithDiffs.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmapset_id, title, artist from beatmapsets where beatmapset_id in (${placeholders})`,
      setIdsWithDiffs,
    )).rows;
    for (const row of rows) {
      meta.set(Number(row.beatmapset_id), {
        title: row.title == null ? null : String(row.title),
        artist: row.artist == null ? null : String(row.artist),
      });
    }
  }

  return {
    sets: setIdsWithDiffs.map((setId) => ({
      beatmapsetId: setId,
      title: meta.get(setId)?.title ?? null,
      artist: meta.get(setId)?.artist ?? null,
      diffs: diffsBySet.get(setId) ?? [],
    })),
    missingBeatmapsetIds: requestedSetIds.filter((setId) => !diffsBySet.has(setId)),
    missingBeatmapIds,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString("utf8");
}

function parseImageDimension(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 8192 ? parsed : null;
}

// Moves a skin's .osk to the key its new visibility calls for, in both
// directions.
//
// Going private, the file has to leave the key anyone could already have: the
// bucket has a public base URL and the row's own osk_url pointed straight at
// it. Going public it moves back out of the secret folder, so the download
// takes the CDN again instead of streaming 65MB through this process for the
// rest of the skin's life. The return trip lands on a fresh revision rather
// than the original key, which an edge cache may have a 404 stored against
// from the private spell.
//
// Only the .osk moves. The preview and screenshot objects keep the keys they
// were written under: a preview shows no more than watching a replay does, the
// streaming endpoint serves them either way (it is the only mode when no
// public bucket is configured at all), and re-keying a dozen images per toggle
// buys nothing for it.
//
// A copy that fails leaves the row on the old key. That is the safe direction
// in both cases - the row's visibility has already changed, so the gate in
// front of the bytes is already right - so it is logged, not rolled back.
async function moveSkinOskForVisibility(ctx: HttpContext, skin: SkinRow): Promise<SkinRow> {
  if (!skin.oskKey) return skin;
  const nextKey = skin.visibility === "private"
    ? (skin.privateSecret ? privateSkinKey(skin.oskKey, skin.privateSecret) : skin.oskKey)
    : (isPrivateSkinKey(skin.oskKey)
      ? skinOskKey(skin.id, skin.name, nextSkinOskRevision(skin.oskKey))
      : skin.oskKey);
  if (nextKey === skin.oskKey) return skin;
  // Local development runs against the production bucket (there is only one,
  // and the local DB is usually a snapshot of the live one), so a toggle here
  // would copy a real skin's file and delete the original out from under the
  // row production is still reading. The visibility flip itself is local and
  // harmless; only the storage move is held back.
  if (ctx.config.nodeEnv !== "production") {
    logWarn("skin_osk_move_skipped_outside_production", { id: skin.id, visibility: skin.visibility });
    return skin;
  }
  const copied = await copySkinObject(
    ctx.config,
    skin.oskKey,
    nextKey,
    "application/octet-stream",
    oskFilename(skin.name),
  ).catch(() => null);
  if (!copied) {
    logWarn("skin_osk_visibility_move_failed", { id: skin.id, visibility: skin.visibility });
    return skin;
  }
  await moveSkinOskKey(ctx.serveWriteDb ?? ctx.db, skin.id, { key: nextKey, url: copied.url });
  await deleteSkinObjects(ctx.config, [skin.oskKey]).catch((error) => {
    logWarn("skin_osk_visibility_cleanup_failed", { id: skin.id, ...errorContext(error) });
  });
  return { ...skin, oskKey: nextKey, oskUrl: copied.url };
}

// Who is asking for skin data, for the endpoints that can hand back hidden
// skins. Only a true admin reads a hidden row, so the request has to carry an
// identity the frontend server fn vouched for with the admin token (the goals
// bridge).
//
// A tokened request with no viewer attached is the admin dashboard calling
// server to server, which keeps the full view it has always had.
function skinViewerScope(
  req: IncomingMessage,
  ctx: HttpContext,
  url: URL,
): { tokened: boolean; asAdmin: boolean; viewerUserId: number | null } {
  const tokened = isAdmin(req, ctx);
  const viewerUserId = tokened ? Number(url.searchParams.get("viewerUserId")) : Number.NaN;
  const viewer = Number.isInteger(viewerUserId) && viewerUserId > 0 ? viewerUserId : null;
  const asAdmin = tokened && (viewer == null || url.searchParams.get("asAdmin") === "1");
  return { tokened, asAdmin, viewerUserId: viewer };
}

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

// A wallet holding the full ~6k tracked-player pool serializes to ~1.5MB,
// so pack wallet pushes get more headroom than the default body limit.
const PACK_WALLET_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const PACK_WALLET_PAYLOAD_MAX_CHARS = 3_500_000;

// The replay-skin settings payload caps at USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS,
// so the body read gets that plus headroom for the JSON envelope around it;
// the default 1MB limit would 413 a maximal payload before it could be judged.
const REPLAY_SKIN_BODY_LIMIT_BYTES = 1_100_000;

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
