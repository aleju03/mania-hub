import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import { bugReportEmbed } from "../../discord/embeds.js";
import {
  attachBugReportScreenshot,
  authorizeBugReportScreenshot,
  createBugReport,
  getBugReport,
  listBugReportsForUser,
  type BugReport,
} from "../../features/bug-reports.js";
import { errorContext, logWarn } from "../../logger.js";
import type { HttpContext } from "../context.js";
import { isAdmin, isBridge, readBody } from "../request.js";
import { sendJson, sendRateLimited } from "../respond.js";

/**
 * The open write side of the bug report feature (features/bug-reports.ts owns
 * the rules, routes/admin.ts owns triage).
 *
 * Everything here is bridge-gated like any frontend-originated write, but
 * unlike most of them a report needs no viewer: whoever hit the bug is the
 * person worth hearing from, signed in or not. When `userId` is present the
 * frontend has already verified it against the login cookie.
 */
export async function handleBugReportRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/bug-reports/")) return false;
  if (!isBridge(req, ctx)) {
    sendJson(req, res, ctx, 401, { error: "unauthorized" });
    return true;
  }

  if (url.pathname === "/api/bug-reports/submit") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    // Deliberately not checkRate(): that re-buckets bridge traffic into the
    // site-wide `bridge` budget, which for an open write is no limit at all.
    // The frontend forwards the visitor's address, so the guard keys on the
    // reporter (falling back to one shared window where the deployment does
    // not trust proxy headers, same as every other per-IP bucket).
    if (ctx.abuse && !isAdmin(req, ctx)) {
      const rate = ctx.abuse.check(req, ctx.config, "bugReport");
      if (!rate.allowed) {
        sendRateLimited(req, res, ctx, rate);
        return true;
      }
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const result = await createBugReport(ctx.serveWriteDb ?? ctx.db, body);
    if (!result.ok) {
      sendJson(req, res, ctx, 400, { error: result.reason });
      return true;
    }
    // Answer first, ping second: a Discord outage must not turn into a failed
    // report. A duplicate is a double-clicked submit, and the owner has
    // already been pinged for it.
    if (!result.duplicate) void pingOwner(ctx, result.report, Number(body.screenshotCount) || 0);
    sendJson(req, res, ctx, 200, {
      ok: true,
      id: result.report.id,
      duplicate: result.duplicate,
      uploadToken: result.uploadToken,
    });
    return true;
  }

  if (url.pathname === "/api/bug-reports/attach") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const result = await attachBugReportScreenshot(ctx.serveWriteDb ?? ctx.db, body);
    if (!result.ok) {
      sendJson(req, res, ctx, result.reason === "report_not_found" ? 404 : 400, { error: result.reason });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, screenshotKeys: result.screenshotKeys });
    return true;
  }

  if (url.pathname === "/api/bug-reports/authorize-screenshot") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const result = await authorizeBugReportScreenshot(ctx.serveWriteDb ?? ctx.db, body);
    if (!result.ok) {
      sendJson(req, res, ctx, result.reason === "report_not_found" ? 404 : 400, { error: result.reason });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, alreadyAttached: result.alreadyAttached });
    return true;
  }

  if (url.pathname === "/api/bug-reports/screenshots") {
    // A reporter reading back the images on their own report. The match is on
    // the stored user id, so an anonymous report answers to nobody here and an
    // account cannot ask for somebody else's.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    const report = await getBugReport(ctx.db, url.searchParams.get("id") ?? "");
    if (!report || !Number.isInteger(userId) || userId <= 0 || report.userId !== userId) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, { screenshotKeys: report.screenshotKeys });
    return true;
  }

  if (url.pathname === "/api/bug-reports/mine") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, { reports: await listBugReportsForUser(ctx.db, userId) });
    return true;
  }

  sendJson(req, res, ctx, 404, { error: "not_found" });
  return true;
}

// `declaredScreenshots` is what the client said it is about to upload: the
// images land on their own requests after this row exists, so the row itself
// still has none at ping time.
async function pingOwner(ctx: HttpContext, report: BugReport, declaredScreenshots: number): Promise<void> {
  if (!ctx.discord) return;
  try {
    await ctx.discord.postOwnerNotice(bugReportEmbed(
      {
        id: report.id,
        body: report.body,
        pagePath: report.pagePath,
        username: report.username,
        userId: report.userId,
        screenshotCount: report.screenshotKeys.length || Math.max(0, declaredScreenshots),
        context: report.context,
      },
      ctx.config.discordSiteOrigin,
    ));
  } catch (error) {
    logWarn("bug_report_discord_ping_failed", { id: report.id, ...errorContext(error) });
  }
}
