import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import { parseScoreLink, submitMissingScore } from "../../features/score-submissions.js";
import { errorContext, logWarn } from "../../logger.js";
import { OsuApiError } from "../../osu/client.js";
import type { HttpContext } from "../context.js";
import { isAdmin, readBody } from "../request.js";
import { checkRate, sendJson, sendRateLimited } from "../respond.js";

/**
 * The open write behind the profile page's "Add a missing score" dialog.
 * Deliberately unauthenticated: the proof of ownership is the score itself
 * (fetched from the osu! API and matched to the target player), not who
 * pastes it, so a friend can fill in someone else's missing play.
 */
export async function handleScoreSubmissionRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/score-submissions") return false;
  if (req.method !== "POST") {
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!checkRate(req, res, ctx, "publicCostly")) return true;
  const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
  const userId = Number(body.userId);
  const link = typeof body.link === "string" ? body.link : "";
  if (!Number.isInteger(userId) || userId <= 0) {
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
  // The submission buckets exist to bound osu! API spend (a per-IP hourly cap
  // plus a site-wide backstop, the layered country-activation treatment), so
  // they are charged exactly when that spend is about to happen: after local
  // validation, and not at all for a submission the stored rows can answer.
  // Malformed spam and already-tracked repeats therefore cannot drain the
  // shared window for everyone else. publicCostly above stays unconditional:
  // it is per-IP, so a flood there only starves its own sender.
  const beforeOsuFetch = () => {
    if (!ctx.abuse || isAdmin(req, ctx)) return { allowed: true } as const;
    const perIp = ctx.abuse.check(req, ctx.config, "scoreSubmit");
    if (!perIp.allowed) return perIp;
    return ctx.abuse.checkGlobal(ctx.config, "scoreSubmitGlobal");
  };
  let result;
  try {
    result = await submitMissingScore(ctx.serveWriteDb, queue, ctx.events, ctx.config, ctx.osu, userId, link, { beforeOsuFetch });
  } catch (error) {
    // Non-404 osu! API trouble (outage, rate pressure) is transient and not
    // the submitter's fault; anything else belongs to the catch-all.
    if (error instanceof OsuApiError) {
      logWarn("score_submission_osu_failed", { user_id: userId, ...errorContext(error) });
      sendJson(req, res, ctx, 503, { error: "osu_unavailable" });
      return true;
    }
    throw error;
  }
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
  sendJson(req, res, ctx, 200, result);
  return true;
}
