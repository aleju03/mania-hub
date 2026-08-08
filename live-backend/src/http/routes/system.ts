import type { IncomingMessage, ServerResponse } from "node:http";
import { isGlobalCountry } from "../../countries.js";
import { dbHealth } from "../../db.js";
import { getDiscordPublicInfo } from "../../discord/index.js";
import { getDiscordShowcase } from "../../discord/showcase.js";
import { searchUsers as searchStoredUsers, USER_SEARCH_DEFAULT_LIMIT, USER_SEARCH_MAX_LIMIT } from "../../features/user-search.js";
import type { HttpContext } from "../context.js";
import { activatePublicCountry } from "../country-activation.js";
import { clampInteger } from "../request.js";
import { checkRate, sendAccentEnrichedJson, sendJson } from "../respond.js";
import { countryFeaturesBody, healthBody, statusBody } from "../status-report.js";

export async function handleSystemRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL, country: string): Promise<boolean> {
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
  if (url.pathname === "/api/events") {
    if (!await activatePublicCountry(req, res, ctx, country)) return true;
    const since = Number(url.searchParams.get("since") ?? 0);
    sendJson(req, res, ctx, 200, { events: await ctx.events.replay(isGlobalCountry(country) ? null : country, Number.isFinite(since) ? since : 0, 500) });
    return true;
  }
  return false;
}
