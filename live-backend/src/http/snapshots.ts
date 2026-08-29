import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { handleBeatmapAudioRequest, handleBeatmapHitsoundsRequest, handleBeatmapStoryboardRequest, handlePreviewAudioRequest } from "../audio/http.js";
import { logWarn } from "../logger.js";
import { REQUEST_FARM_HELPER_TIMINGS, REQUEST_STARTED_AT, type HttpContext, type TimedRequest } from "./context.js";
import { countryFromUrl, hasInvalidCountryParam, routeUsesCountry } from "./country-activation.js";
import { HttpRequestError, isAdmin } from "./request.js";
import { checkRate, isDisallowedOrigin, sendCors, sendJson } from "./respond.js";
import { handleAdminRoutes } from "./routes/admin.js";
import { handleAnalysisRoutes } from "./routes/analysis.js";
import { handleAnalyticsRoutes } from "./routes/analytics.js";
import { handleBugReportRoutes } from "./routes/bug-reports.js";
import { handleGoatPollRoutes } from "./routes/goat-poll.js";
import { handleOsuProxyRoutes } from "./routes/osu-proxy.js";
import { handlePacksRoutes } from "./routes/packs.js";
import { handleProfileRoutes } from "./routes/profiles.js";
import { handleReplayVideoRoutes } from "./routes/replay-video.js";
import { handleScoreSubmissionRoutes } from "./routes/score-submissions.js";
import { handleSkinsRoutes } from "./routes/skins.js";
import { handleUploadedReplayRoutes } from "./routes/uploaded-replays.js";
import { handleCommunitiesRoutes } from "./routes/communities.js";
import { handleUserMapCollectionRoutes } from "./routes/user-map-collections.js";
import { handleSnapshotRoutes } from "./routes/snapshots.js";
import { handleSystemRoutes } from "./routes/system.js";
import { handleUserDataRoutes } from "./routes/user-data.js";
import { handleSignatureRoutes } from "./routes/signatures.js";

// Compatibility façade: this file was once the whole HTTP layer, and the server,
// the live/SSE modules and the tests still import its public surface from here.
export type { HttpContext } from "./context.js";
export { sendJson, sendNotFound, sendRateLimited } from "./respond.js";
export { activatePublicCountry } from "./country-activation.js";
export { warmStatusBodyCache } from "./status-report.js";
export {
  createMapsResponseCache,
  mapsResponseCacheDelete,
  mapsResponseCacheSet,
  pruneMapsResponseCache,
  warmGlobalMapsFarmedBoard,
  type MapsResponseCache,
  type MapsResponseCacheEntry,
} from "./maps-response-cache.js";

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
const SKIN_FILES_RATE_SUFFIX = "skin-files";

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
          country: /[?&]country=([A-Za-z-]{2,12})/.exec(req.url ?? "")?.[1]?.toUpperCase() ?? null,
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
  // The pack draw's pool page reads get their own bucket instead of the
  // blanket publicApi budget. On 2026-08-07 a run of spammed opens drained
  // publicApi with card probes and warms, and every 429ed pool read here made
  // the client degrade to its direct osu! rankings draw — the abuse guard was
  // rerouting the spam onto the far pricier osu! API (~50 rankings calls/min).
  // The draw must stay answerable while the rest of a spammer's page budget
  // runs dry; its own window still caps it. A full bucket rather than a
  // borrowed ceiling because one legitimate open can cost ~40 of these reads
  // (see packPoolRatePerMinute in config.ts).
  const isPackPoolDraw = url.pathname === "/api/snapshots/global-rankings"
    && url.searchParams.get("pool") === "packs";
  // Skin asset files spend the publicApi ceiling on their own window, same
  // reasoning as MEDIA_PATHS: one detail view fans out ~25 <img> fetches
  // (previews per keymode + screenshots), which used to spend the page's JSON
  // budget — twice, in fact, since the handler also charged publicApi — and
  // on 2026-08-07 one visitor's gallery browse 429ed their next packs
  // requests. The gate is the only charge now; the handler no longer re-bills.
  const isSkinFileRead = url.pathname.startsWith("/api/skins/file/");
  if (url.pathname.startsWith("/api/") && !isAdmin(req, ctx)) {
    const allowed = isPackPoolDraw
      ? checkRate(req, res, ctx, "packPool")
      : checkRate(req, res, ctx, "publicApi", isSkinFileRead ? SKIN_FILES_RATE_SUFFIX : "");
    if (!allowed) return true;
  }
  if (await handleSystemRoutes(req, res, ctx, url, country)) return true;
  if (await handleProfileRoutes(req, res, ctx, url, country)) return true;
  if (await handleAnalyticsRoutes(req, res, ctx, url)) return true;
  if (await handleAdminRoutes(req, res, ctx, url, country)) return true;
  if (await handleUserDataRoutes(req, res, ctx, url)) return true;
  if (await handleBugReportRoutes(req, res, ctx, url)) return true;
  if (await handleSignatureRoutes(req, res, ctx, url)) return true;
  if (await handleSnapshotRoutes(req, res, ctx, url, country)) return true;
  if (await handleAnalysisRoutes(req, res, ctx, url)) return true;
  if (await handleScoreSubmissionRoutes(req, res, ctx, url)) return true;
  if (await handleOsuProxyRoutes(req, res, ctx, url)) return true;
  if (await handlePacksRoutes(req, res, ctx, url)) return true;
  if (await handleGoatPollRoutes(req, res, ctx, url)) return true;
  if (await handleReplayVideoRoutes(req, res, ctx, url)) return true;
  if (await handleSkinsRoutes(req, res, ctx, url)) return true;
  if (await handleUploadedReplayRoutes(req, res, ctx, url)) return true;
  if (await handleCommunitiesRoutes(req, res, ctx, url)) return true;
  if (await handleUserMapCollectionRoutes(req, res, ctx, url)) return true;
  return false;
}
