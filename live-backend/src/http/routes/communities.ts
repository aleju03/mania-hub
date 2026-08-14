import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  communityAllowsCountry,
  communityImageHash,
  createCommunity,
  deleteCommunity,
  discordGuildImageUrl,
  getCommunityById,
  getCommunityByGuild,
  communityHasOpenReports,
  hasOpenCommunityReport,
  invitePreview,
  listCommunities,
  listCommunitiesForOwner,
  listReviewQueue,
  normalizeSort,
  reportCommunity,
  resolveCommunityReports,
  reviewCommunity,
  toCommunitySummary,
  updateCommunity,
  type CommunityImageKind,
  type CommunityReviewAction,
  type CommunityRow,
} from "../../features/communities.js";
import { fetchWidgetInviteCode, resolveDiscordInvite } from "../../discord/invites.js";
import { logInfo } from "../../logger.js";
import type { HttpContext } from "../context.js";
import { isBridge, readBody } from "../request.js";
import { sendJson } from "../respond.js";

/*
 * /communities routes.
 *
 * Every one of these is bridge-token gated, including the reads, even though the
 * directory itself is open to anyone: the frontend server functions are the
 * only callers, and they forward the osu!-verified viewer id and country
 * alongside the shared token (the same bridge skins and goat-poll writes use).
 * That is what keeps the country deciding a restricted listing's invite off the
 * browser, where it would just be a querystring anyone could type. A signed-out
 * reader is forwarded as no id and no country, which reads here as a stranger.
 *
 * The shared token cannot tell "a moderator reviewing" from "a user's own
 * mutation forwarded by the frontend", so scope comes from fields the frontend
 * vouches for per request: viewerUserId is who is acting, and asAdmin=1 says the
 * frontend checked they may act on somebody else's listing.
 *
 * The review routes are deliberately NOT under /api/admin. Reviewing here is a
 * per-feature moderator list the owner keeps by hand
 * (COMMUNITY_MODERATOR_USER_IDS), reached from the directory itself, and those
 * people are not site admins: moderating servers must never imply admin access
 * to anything else.
 */

interface CommunityScope {
  tokened: boolean;
  viewerUserId: number | null;
  asAdmin: boolean;
  // The viewer's own country, which decides which restricted listings they see
  // and which invites they are given. Same trust as viewerUserId: it comes off
  // the osu!-verified profile on the frontend, never from the browser.
  viewerCountry: string | null;
}

/*
 * Whether this listing exists as far as this viewer is concerned.
 *
 * Approved and resolving is what a stranger may read. Its owner reads theirs in
 * any state (that is how a pending listing has a page at all), and a moderator
 * reads anyone's, which is what the review page's links open. A listing that
 * hides itself outside its own places is nothing to everyone else, or its page
 * would be the way around being left off the directory - the locked-but-visible
 * kind is a different thing, and toCommunitySummary is what decides how much of
 * it a viewer gets.
 *
 * Shared by the page and its pictures so the two cannot drift into disagreeing
 * about who may see the listing.
 */
function communityVisibleTo(
  row: CommunityRow,
  isOwner: boolean,
  scope: Pick<CommunityScope, "asAdmin" | "viewerCountry">,
): boolean {
  if (isOwner || scope.asAdmin) return true;
  if (row.status !== "approved" || !row.inviteOk) return false;
  return !row.accessHidden || communityAllowsCountry(row.accessScopes, scope.viewerCountry);
}

function communityScope(req: IncomingMessage, ctx: HttpContext, url: URL, body?: Record<string, unknown>): CommunityScope {
  const tokened = isBridge(req, ctx);
  const raw = body?.userId ?? url.searchParams.get("viewerUserId");
  const viewerUserId = tokened && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  const asAdmin = tokened && (body?.asAdmin === true || url.searchParams.get("asAdmin") === "1");
  const rawCountry = body?.viewerCountry ?? url.searchParams.get("viewerCountry");
  const country = typeof rawCountry === "string" ? rawCountry.trim().toUpperCase() : "";
  return {
    tokened,
    viewerUserId,
    asAdmin,
    viewerCountry: tokened && /^[A-Z]{2}$/.test(country) ? country : null,
  };
}

export async function handleCommunitiesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/communities")) return false;

  if (url.pathname === "/api/communities/list") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    const scope = communityScope(req, ctx, url);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    // Every answer here is scoped to whoever asked - their own listings, and
    // which restricted ones they may join - so none of it may land in a shared
    // cache and be handed to the next reader.
    res.setHeader("cache-control", "private, no-store");
    const page = Number(url.searchParams.get("page") ?? 0);
    const list = await listCommunities(ctx.db, {
      q: (url.searchParams.get("q") ?? "").slice(0, 80),
      page: Number.isFinite(page) ? page : 0,
      sort: normalizeSort(url.searchParams.get("sort")),
      country: url.searchParams.get("country") ?? undefined,
      language: url.searchParams.get("lang") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      viewerCountry: scope.viewerCountry,
    });
    sendJson(req, res, ctx, 200, list);
    return true;
  }

  /*
   * Where one listing's icon or banner actually lives, for the frontend route
   * that serves it (src/routes/api/community-image.ts).
   *
   * Only the CDN link comes back, not the bytes: the caller holds the admin
   * token, so it is the site itself rather than a browser, and it is going to
   * fetch and pipe the picture anyway. What this route is for is the check in
   * front of it - the same visibility the page gets, so a listing nobody may see
   * has no pictures either, and the guild id inside the link never reaches a
   * browser that was not going to be given it.
   *
   * 404 for a listing this viewer cannot see, for one with no art of that kind,
   * and for a bad id alike: none of them are worth telling apart out here.
   */
  if (url.pathname === "/api/communities/image-url") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    const scope = communityScope(req, ctx, url);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    res.setHeader("cache-control", "private, no-store");
    const kind: CommunityImageKind = url.searchParams.get("kind") === "banner" ? "banner" : "icon";
    const row = await getCommunityById(ctx.db, url.searchParams.get("id") ?? "");
    const isOwner = row != null && scope.viewerUserId != null && row.ownerUserId === scope.viewerUserId;
    const hash = row == null ? null : communityImageHash(row, kind);
    if (row == null || hash == null || hash === "" || !communityVisibleTo(row, isOwner, scope)) {
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, url: discordGuildImageUrl(row.guildId, kind, hash) });
    return true;
  }

  /*
   * One listing, for its own page. Every case communityVisibleTo turns down
   * answers 404 rather than 403: whether a listing exists at all is not
   * something to confirm to someone who cannot see it.
   */
  if (url.pathname === "/api/communities/get") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    const scope = communityScope(req, ctx, url);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    res.setHeader("cache-control", "private, no-store");
    const row = await getCommunityById(ctx.db, url.searchParams.get("id") ?? "");
    const isOwner = row != null && scope.viewerUserId != null && row.ownerUserId === scope.viewerUserId;
    if (!row || !communityVisibleTo(row, isOwner, scope)) {
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, {
      ok: true,
      community: toCommunitySummary(row, {
        asOwner: isOwner,
        asAdmin: scope.asAdmin,
        viewerCountry: scope.viewerCountry,
        // So the page can say "reported" rather than offer the button again.
        // Only ever about the person asking; one indexed lookup.
        viewerReported:
          scope.viewerUserId != null && (await hasOpenCommunityReport(ctx.db, row.id, scope.viewerUserId)),
        // A flagged listing is back in a moderator's hands, so their page for it
        // matches the review card: they can open the server they are judging,
        // even one that named places they are not in. Asked only for them.
        underReview: scope.asAdmin && (await communityHasOpenReports(ctx.db, row.id)),
      }),
    });
    return true;
  }

  /*
   * Flagging a listing, from its own page. Anyone the directory is open to may
   * send one, which is the point: after approval, the people reading it are the
   * only thing watching it.
   *
   * A refusal answers 200 with ok:false - "that is your own listing" is an
   * answer, not a broken request - except for the not-a-listing case, which
   * really is one.
   */
  if (url.pathname === "/api/communities/report") {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const scope = communityScope(req, ctx, url, body);
    const id = typeof body.id === "string" ? body.id : "";
    if (!id || scope.viewerUserId == null) return badRequest(req, res, ctx);
    const result = await reportCommunity(ctx.serveWriteDb ?? ctx.db, {
      communityId: id,
      reporterUserId: scope.viewerUserId,
      reporterUsername: typeof body.username === "string" ? body.username : String(scope.viewerUserId),
      reason: body.reason,
      details: body.details,
    });
    if (result.ok) {
      // Not logged with the text: the reason is a moderator's to read on the
      // review page, and log lines go somewhere else entirely.
      logInfo("community_reported", { id, by: scope.viewerUserId });
    }
    sendJson(req, res, ctx, result.ok || result.error !== "not_found" ? 200 : 404, result);
    return true;
  }

  if (url.pathname === "/api/communities/mine") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    const scope = communityScope(req, ctx, url);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    res.setHeader("cache-control", "private, no-store");
    const communities = scope.viewerUserId == null ? [] : await listCommunitiesForOwner(ctx.db, scope.viewerUserId);
    sendJson(req, res, ctx, 200, { communities });
    return true;
  }

  /*
   * Resolves an invite without writing anything, so the submit form can show
   * the server it is about to post - the real name, icon and counts, straight
   * from Discord - and refuse an expiring or mismatched link while it is still
   * being typed rather than after the pitch has been written.
   *
   * A refusal answers 200 with ok:false: "that invite expires" is an answer to
   * the question, not a failure of the request.
   */
  if (url.pathname === "/api/communities/preview") {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const guildId = typeof body.guildId === "string" && body.guildId !== "" ? body.guildId : undefined;
    res.setHeader("cache-control", "private, no-store");

    /*
     * With no invite typed yet, try to find the server's own. Only a server that
     * turned its widget on has one to find, and asking for it is how the form
     * fills itself in for the servers where that is possible at all - an OAuth
     * app cannot create an invite, only a bot inside the server can.
     */
    let inviteInput = typeof body.invite === "string" ? body.invite.slice(0, 200).trim() : "";
    if (inviteInput === "") {
      if (!guildId) return badRequest(req, res, ctx);
      const widgetCode = await fetchWidgetInviteCode(guildId);
      if (widgetCode == null) {
        sendJson(req, res, ctx, 200, { ok: false, error: "no_auto_invite" });
        return true;
      }
      inviteInput = widgetCode;
    }

    const resolved = await resolveDiscordInvite(inviteInput, guildId);
    if (!resolved.ok) {
      sendJson(req, res, ctx, 200, { ok: false, error: resolved.error });
      return true;
    }
    // The listing being edited is allowed to match itself; anything else already
    // on the directory is a dead end worth saying before the form is filled in.
    const existing = await getCommunityByGuild(ctx.db, resolved.invite.guildId);
    const editingId = typeof body.id === "string" ? body.id : "";
    if (existing && existing.id !== editingId) {
      sendJson(req, res, ctx, 200, { ok: false, error: "already_listed" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, invite: invitePreview(resolved.invite) });
    return true;
  }

  if (url.pathname === "/api/communities/submit") {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const scope = communityScope(req, ctx, url, body);
    if (scope.viewerUserId == null) return badRequest(req, res, ctx);

    // The guild the submitter proved they manage, and the Discord identity that
    // proved it. Both were verified on the frontend against Discord's OAuth, so
    // they arrive here already vouched for; the invite is checked against the
    // guild id so the proof and the link cannot describe different servers.
    const guildId = typeof body.guildId === "string" ? body.guildId : "";
    const discordUserId = typeof body.discordUserId === "string" ? body.discordUserId : "";
    const inviteInput = typeof body.invite === "string" ? body.invite : "";
    if (!guildId || !discordUserId || !inviteInput) return badRequest(req, res, ctx);

    const existing = await getCommunityByGuild(ctx.db, guildId);
    if (existing) {
      sendJson(req, res, ctx, 409, { ok: false, error: "already_listed" });
      return true;
    }

    const resolved = await resolveDiscordInvite(inviteInput, guildId);
    if (!resolved.ok) {
      sendJson(req, res, ctx, 400, { ok: false, error: resolved.error });
      return true;
    }

    const result = await createCommunity(ctx.serveWriteDb ?? ctx.db, {
      invite: resolved.invite,
      ownerUserId: scope.viewerUserId,
      ownerUsername: typeof body.username === "string" ? body.username : String(scope.viewerUserId),
      discordUserId,
      discordUsername: typeof body.discordUsername === "string" ? body.discordUsername : "",
      isGuildOwner: body.isGuildOwner === true,
      pitch: body.pitch,
      countryCode: body.countryCode,
      language: body.language,
      tags: body.tags,
      accessScopes: body.accessScopes,
      accessHidden: body.accessHidden,
    });
    if (result.ok) {
      logInfo("community_submitted", {
        id: result.community.id,
        guildId: resolved.invite.guildId,
        ownerUserId: scope.viewerUserId,
      });
    }
    sendJson(req, res, ctx, result.ok ? 200 : statusForWriteError(result.error), result);
    return true;
  }

  if (url.pathname === "/api/communities/update") {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const scope = communityScope(req, ctx, url, body);
    const id = typeof body.id === "string" ? body.id : "";
    if (!id || (scope.viewerUserId == null && !scope.asAdmin)) return badRequest(req, res, ctx);

    const row = await getCommunityById(ctx.db, id);
    if (!row) {
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }
    const ownerUserId = scope.asAdmin ? null : scope.viewerUserId;
    if (ownerUserId != null && row.ownerUserId !== ownerUserId) {
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }

    // A replacement invite still has to point at the guild this listing already
    // is, so a fresh link can never quietly turn one listing into another server.
    let invite;
    if (typeof body.invite === "string" && body.invite.trim() !== "") {
      const resolved = await resolveDiscordInvite(body.invite, row.guildId);
      if (!resolved.ok) {
        sendJson(req, res, ctx, 400, { ok: false, error: resolved.error });
        return true;
      }
      invite = resolved.invite;
    }

    const result = await updateCommunity(ctx.serveWriteDb ?? ctx.db, id, ownerUserId, {
      invite,
      pitch: body.pitch,
      countryCode: body.countryCode,
      language: body.language,
      tags: body.tags,
      accessScopes: body.accessScopes,
      accessHidden: body.accessHidden,
    });
    sendJson(req, res, ctx, result.ok ? 200 : statusForWriteError(result.error), result);
    return true;
  }

  if (url.pathname === "/api/communities/delete") {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const scope = communityScope(req, ctx, url, body);
    const id = typeof body.id === "string" ? body.id : "";
    if (!id || (scope.viewerUserId == null && !scope.asAdmin)) return badRequest(req, res, ctx);
    const deleted = await deleteCommunity(ctx.serveWriteDb ?? ctx.db, id, scope.asAdmin ? null : scope.viewerUserId);
    if (deleted) logInfo("community_deleted", { id, by: scope.asAdmin ? "admin" : "owner" });
    sendJson(req, res, ctx, deleted ? 200 : 404, { ok: deleted });
    return true;
  }

  if (url.pathname === "/api/communities/queue") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    res.setHeader("cache-control", "private, no-store");
    sendJson(req, res, ctx, 200, await listReviewQueue(ctx.db));
    return true;
  }

  if (url.pathname === "/api/communities/review") {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const id = typeof body.id === "string" ? body.id : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!id || !["approve", "reject", "hide", "unhide", "delete"].includes(action)) {
      return badRequest(req, res, ctx);
    }
    // Which moderator made the call. The shared token cannot say, so the
    // frontend forwards the osu!-verified viewer it already checked against the
    // moderator list, and every decision is attributable in the logs.
    const scope = communityScope(req, ctx, url, body);
    if (action === "delete") {
      const deleted = await deleteCommunity(ctx.serveWriteDb ?? ctx.db, id, null);
      if (deleted) logInfo("community_reviewed", { id, action, by: scope.viewerUserId });
      sendJson(req, res, ctx, deleted ? 200 : 404, { ok: deleted });
      return true;
    }
    const result = await reviewCommunity(
      ctx.serveWriteDb ?? ctx.db,
      id,
      action as CommunityReviewAction,
      typeof body.reason === "string" ? body.reason : undefined,
    );
    if (result.ok) {
      // Whatever was decided is the answer to whoever flagged it, including
      // "looks fine": approving a reported listing is how a moderator says so.
      await resolveCommunityReports(ctx.serveWriteDb ?? ctx.db, id, scope.viewerUserId);
      logInfo("community_reviewed", { id, action, by: scope.viewerUserId });
    }
    sendJson(req, res, ctx, result.ok ? 200 : 404, result);
    return true;
  }

  // A manual "check the invites now" button on the review page, so a dead
  // listing does not have to wait out the sweep interval to be confirmed.
  if (url.pathname === "/api/communities/refresh") {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    if (!isBridge(req, ctx)) return unauthorized(req, res, ctx);
    const { refreshCommunityInvites } = await import("../../communities/refresh.js");
    const checked = await refreshCommunityInvites(ctx.serveWriteDb ?? ctx.db, ctx.config, { force: true });
    sendJson(req, res, ctx, 200, { ok: true, ...checked });
    return true;
  }

  // Nothing else under the prefix exists. Claimed rather than fallen through, so
  // a typo reads as 404 here instead of reaching an unrelated handler.
  sendJson(req, res, ctx, 404, { error: "not_found" });
  return true;
}

function statusForWriteError(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "already_listed") return 409;
  if (error === "limit_reached") return 429;
  return 400;
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): true {
  sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
  return true;
}

function unauthorized(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): true {
  sendJson(req, res, ctx, 401, { error: "unauthorized" });
  return true;
}

function badRequest(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): true {
  sendJson(req, res, ctx, 400, { error: "invalid_request" });
  return true;
}
