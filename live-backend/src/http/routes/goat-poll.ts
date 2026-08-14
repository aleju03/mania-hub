import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  castGoatPollVote,
  countGoatPollNominees,
  getGoatPollNominee,
  goatPollWindow,
  listGoatPollBoard,
  listGoatPollVotesForUser,
  nominateGoatPollPlayer,
} from "../../features/goat-poll.js";
import { logWarn } from "../../logger.js";
import type { HttpContext } from "../context.js";
import { isBridge, readBody } from "../request.js";
import { sendJson } from "../respond.js";

/* The temporary GOAT nomination poll (features/goat-poll.ts).
 *
 * The board read is public and browser-direct on purpose: it refreshes every
 * ~20s in every open /packs tab, and routing that through a frontend server fn
 * would put the whole poll's read traffic on the node process for nothing. It
 * carries no per-viewer data, so there is nothing to protect, and the general
 * publicApi per-IP gate in snapshots.ts already covers it.
 *
 * The three write/identity endpoints take the goals/pack-wallet bridge: admin
 * token from the frontend server fn plus the osu!-verified viewer id in the
 * body, so a browser can never vote or nominate as somebody else.
 */
/* Every write puts the row it touched on the shared live stream, so a board
   open in someone else's browser moves the moment a vote lands instead of on
   its 20-second poll. Country-less, like pack_pull: the poll is one board for
   the whole site, not a per-country surface.

   The row rather than the board, because a board is up to 150 KiB at 500
   nominees and this would otherwise send every viewer a copy of it per click.
   Delivery is best effort — the poll backstop carries anything a dropped frame
   or a closed stream misses, so a failure here must never fail the write. */
async function publishGoatPollChange(ctx: HttpContext, pollId: string, nomineeId: string): Promise<void> {
  try {
    const nominee = await getGoatPollNominee(ctx.db, pollId, nomineeId);
    if (!nominee) return;
    await ctx.events.append("goat_poll", null, { pollId, nominee }, undefined, ctx.serveWriteDb ?? undefined);
  } catch (error) {
    logWarn("goat_poll_event_failed", { pollId, nomineeId, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleGoatPollRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/goat-poll")) return false;

  const window = goatPollWindow();
  if (!window) {
    // The poll is retired (GOAT_POLL.enabled is false in features/goat-poll.ts).
    // 404 rather than an empty board, so the widget hides itself instead of
    // rendering a poll nobody can enter.
    sendJson(req, res, ctx, 404, { error: "poll_not_configured" });
    return true;
  }

  if (url.pathname === "/api/goat-poll") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    // While the poll is admin-only the board stops being public: it answers only
    // a caller carrying the bridge token, which means the frontend server fn,
    // which reads the viewer's admin status off the signed login cookie first.
    // The refusal is the retired-poll 404 rather than a 401, so a browser cannot
    // tell an unreleased poll from one that does not exist.
    if (window.adminOnly && !isBridge(req, ctx)) {
      sendJson(req, res, ctx, 404, { error: "poll_not_configured" });
      return true;
    }
    // The widget asks for as many rows as it is showing and pages up by "show
    // more" clicks, so the 20-second refresh in every open tab carries eight
    // rows instead of the whole board. No limit param means everything, which
    // is also what a frontend from before the param existed gets.
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : undefined;
    sendJson(req, res, ctx, 200, {
      pollId: window.pollId,
      opensAt: window.opensAt,
      closesAt: window.closesAt,
      adminOnly: window.adminOnly,
      // The clock the countdown is drawn against. Browsers time the poll by the
      // offset between this and their own clock rather than by Date.now(), so a
      // machine set to the wrong day still shows the deadline everyone else is
      // voting to — and the one this process enforces.
      serverNow: Date.now(),
      nominees: await listGoatPollBoard(ctx.db, window.pollId, limit),
      // The whole board's size, however few rows this answer carries: it is
      // what tells a capped reader whether "show more" has anything left.
      totalNominees: await countGoatPollNominees(ctx.db, window.pollId),
    });
    return true;
  }

  if (url.pathname === "/api/goat-poll/mine" || url.pathname === "/api/goat-poll/vote" || url.pathname === "/api/goat-poll/nominate") {
    if (!isBridge(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }

    /* The shared token only says "this came from our frontend" — every bridged
       endpoint on the site carries it for ordinary signed-in users. So while the
       poll is admin-only, the frontend also forwards whether the viewer behind
       the request is an admin, read from the same verified login cookie that
       supplied their userId, and a request that does not vouch for one is
       refused as if the poll were not there. A browser cannot set either field:
       the server fn overwrites both. */
    const vouchedForAdmin = (claim: boolean): boolean => !window.adminOnly || claim;
    const refuseAsMissing = (): true => {
      sendJson(req, res, ctx, 404, { error: "poll_not_configured" });
      return true;
    };

    if (url.pathname === "/api/goat-poll/mine") {
      if (req.method !== "GET") {
        sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
        return true;
      }
      const userId = Number(url.searchParams.get("userId"));
      if (!Number.isInteger(userId) || userId <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
        return true;
      }
      if (!vouchedForAdmin(url.searchParams.get("admin") === "1")) return refuseAsMissing();
      sendJson(req, res, ctx, 200, { votes: await listGoatPollVotesForUser(ctx.db, window.pollId, userId) });
      return true;
    }

    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{
      userId?: unknown;
      nomineeId?: unknown;
      value?: unknown;
      osuUserId?: unknown;
      username?: unknown;
      countryCode?: unknown;
      avatarUrl?: unknown;
      banned?: unknown;
      proofUrl?: unknown;
      viewerIsAdmin?: unknown;
    }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (!vouchedForAdmin(body.viewerIsAdmin === true)) return refuseAsMissing();
    const writeDb = ctx.serveWriteDb ?? ctx.db;

    if (url.pathname === "/api/goat-poll/vote") {
      const nomineeId = typeof body.nomineeId === "string" ? body.nomineeId : "";
      const value = Number(body.value);
      if (!nomineeId) {
        sendJson(req, res, ctx, 400, { error: "invalid_nominee_id" });
        return true;
      }
      if (value !== 1 && value !== -1 && value !== 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_value" });
        return true;
      }
      const result = await castGoatPollVote(writeDb, window, nomineeId, userId, value);
      if (result.ok) await publishGoatPollChange(ctx, window.pollId, nomineeId);
      sendJson(req, res, ctx, result.ok ? 200 : 409, {
        ...result,
        nominees: await listGoatPollBoard(ctx.db, window.pollId),
        votes: await listGoatPollVotesForUser(ctx.db, window.pollId, userId),
      });
      return true;
    }

    const result = await nominateGoatPollPlayer(writeDb, window, {
      userId,
      osuUserId: Number.isInteger(Number(body.osuUserId)) && Number(body.osuUserId) > 0 ? Number(body.osuUserId) : null,
      username: typeof body.username === "string" ? body.username : "",
      countryCode: typeof body.countryCode === "string" ? body.countryCode : null,
      avatarUrl: typeof body.avatarUrl === "string" ? body.avatarUrl : null,
      banned: body.banned === true,
      proofUrl: typeof body.proofUrl === "string" ? body.proofUrl : null,
    });
    // An already-nominated player is reported with the board attached and a 200:
    // it is a reasonable thing for a user to try, and the client's job is to
    // scroll them to the existing row rather than show a failure.
    if (result.ok && result.nomineeId) await publishGoatPollChange(ctx, window.pollId, result.nomineeId);
    const status = result.ok || result.status === "already_nominated" ? 200 : 409;
    sendJson(req, res, ctx, status, {
      ...result,
      nominees: await listGoatPollBoard(ctx.db, window.pollId),
      votes: await listGoatPollVotesForUser(ctx.db, window.pollId, userId),
    });
    return true;
  }

  sendJson(req, res, ctx, 404, { error: "not_found" });
  return true;
}
