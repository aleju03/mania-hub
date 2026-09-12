import type { IncomingMessage, ServerResponse } from "node:http";
import { checkWriteGateOverloaded, parseJson } from "../../db.js";
import { enqueueLeaderboardImport, getLeaderboardImportStatuses } from "../../features/leaderboard-import.js";
import { enqueueScoreImport, getScoreImportStatuses, parseScoreLink } from "../../features/score-submissions.js";
import type { HttpContext } from "../context.js";
import { isAdmin, normalizeIdList, readBody } from "../request.js";
import { checkRate, sendJson, sendRateLimited, sendWritePressureShed } from "../respond.js";

/**
 * The open write behind the profile page's "Add a missing score" dialog.
 * Deliberately unauthenticated: the proof of ownership is the score itself
 * (fetched from the osu! API and matched to the target player), not who
 * pastes it, so a friend can fill in someone else's missing play.
 */
export async function handleScoreSubmissionRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/admin/leaderboard-imports") return handleLeaderboardImport(req, res, ctx, url);
  if (url.pathname !== "/api/score-submissions") return false;
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET") {
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const ids = normalizeIdList((url.searchParams.get("ids") ?? "").split(",")).slice(0, 50);
    sendJson(req, res, ctx, 200, { statuses: await getScoreImportStatuses(ctx.db, userId, ids) });
    return true;
  }
  if (req.method !== "POST") {
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!checkRate(req, res, ctx, "publicCostly")) return true;
  const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
  const userId = Number(body.userId);
  const link = typeof body.link === "string" ? body.link : "";
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
    return true;
  }
  const parsedLink = parseScoreLink(link);
  if (parsedLink === "wrong_mode") {
    sendJson(req, res, ctx, 400, { error: "not_mania" });
    return true;
  }
  if (!parsedLink) {
    sendJson(req, res, ctx, 400, { error: "invalid_link" });
    return true;
  }
  // No dedicated write connection means this process serves read-only (tests,
  // worker role) and cannot ingest anything.
  const queue = ctx.serveWriteQueue ?? ctx.queue;
  if (!ctx.serveWriteDb || !queue) {
    sendJson(req, res, ctx, 503, { error: "submissions_unavailable" });
    return true;
  }
  // Shed overloaded admission writes before accepting responsibility for a job.
  const shed = checkWriteGateOverloaded(ctx.serveWriteDb);
  if (shed) {
    sendWritePressureShed(req, res, ctx, "score-submissions", shed.retryAfterMs);
    return true;
  }
  // Reserve the submission budget at admission, before background API work.
  // Cached scores and duplicate pending jobs skip these buckets.
  const beforeEnqueue = () => {
    if (!ctx.abuse || isAdmin(req, ctx)) return { allowed: true } as const;
    const perIp = ctx.abuse.check(req, ctx.config, "scoreSubmit");
    if (!perIp.allowed) return perIp;
    return ctx.abuse.checkGlobal(ctx.config, "scoreSubmitGlobal");
  };
  const result = await enqueueScoreImport(ctx.serveWriteDb, queue, userId, link, beforeEnqueue);
  if (!result.ok) {
    if (result.reason === "rate_limited") {
      sendRateLimited(req, res, ctx, result.rate);
      return true;
    }
    const status = result.reason === "score_not_found" || result.reason === "player_not_found" ? 404 : 400;
    sendJson(req, res, ctx, status, {
      error: result.reason,
      ...("owner" in result && result.owner ? { owner: result.owner } : {}),
    });
    return true;
  }
  sendJson(req, res, ctx, "queued" in result ? 202 : 200, result);
  return true;
}

/**
 * The admin-only sibling: one chart's global leaderboard (osu!'s top 50)
 * through the same ingest, as a queued job. POST takes one id or a list
 * (a whole set) and answers at once; GET ?ids= reports each job's state and how many rows the chart has
 * from imports, which is what the dialog polls. Admin because each run is two
 * osu! requests and up to fifty rows, so it sits behind the admin token
 * rather than the submission buckets; the frontend's server function checks
 * the session before adding that token.
 */
async function handleLeaderboardImport(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (!isAdmin(req, ctx)) {
    sendJson(req, res, ctx, 401, { error: "unauthorized" });
    return true;
  }
  if (req.method === "GET") {
    const ids = normalizeIdList((url.searchParams.get("ids") ?? "").split(",")).slice(0, 200);
    sendJson(req, res, ctx, 200, { ok: true, statuses: await getLeaderboardImportStatuses(ctx.db, ids, ctx.journalDb ?? ctx.db) });
    return true;
  }
  if (req.method !== "POST") {
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
  // One request per set, not per chart: the dialog's "Add all" used to fire a
  // server-function call per chart and tripped the frontend's per-visitor
  // bucket halfway through a set. A single id still works.
  const rawIds = Array.isArray(body.beatmapIds) ? body.beatmapIds : [body.beatmapId];
  const beatmapIds = [...new Set(normalizeIdList(rawIds))].slice(0, 200);
  if (beatmapIds.length === 0) {
    sendJson(req, res, ctx, 400, { error: "invalid_beatmap_id" });
    return true;
  }
  const queue = ctx.serveWriteQueue ?? ctx.queue;
  if (!ctx.serveWriteDb || !queue) {
    sendJson(req, res, ctx, 503, { error: "submissions_unavailable" });
    return true;
  }
  const enqueueDb = ctx.serveWriteDb ?? ctx.db;
  const queuedBeatmapIds: number[] = [];
  const recentBeatmapIds: number[] = [];
  for (const beatmapId of beatmapIds) {
    const result = await enqueueLeaderboardImport(enqueueDb, queue, beatmapId);
    (result === "queued" ? queuedBeatmapIds : recentBeatmapIds).push(beatmapId);
  }
  const statuses = await getLeaderboardImportStatuses(enqueueDb, beatmapIds, ctx.journalDb ?? enqueueDb);
  sendJson(req, res, ctx, queuedBeatmapIds.length > 0 ? 202 : 200, {
    ok: true,
    queued: queuedBeatmapIds.length > 0,
    beatmapIds,
    queuedBeatmapIds,
    recentBeatmapIds,
    statuses,
  });
  return true;
}
