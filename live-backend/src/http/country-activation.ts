import type { IncomingMessage, ServerResponse } from "node:http";
import { activateCountry, getCountryRegistryRow, GLOBAL_COUNTRY_CODE, isCountryFeatureAtLeast, isGlobalCountry, type CountryFeatureTier, type CountryRegistryStatus } from "../countries.js";
import { exec, type Db } from "../db.js";
import { enqueueGlobalMapsRefreshIfDue, enqueueMapsRefreshIfDue } from "../features/maps.js";
import { normalizeCountryParam } from "./abuse-guard.js";
import type { HttpContext } from "./context.js";
import { isAdmin } from "./request.js";
import { sendRateLimited } from "./respond.js";

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

export function countryFromUrl(url: URL, ctx: HttpContext): string {
  return normalizeCountryParam(url.searchParams.get("country"))
    ?? normalizeCountryParam(ctx.config.trackedCountries?.[0])
    ?? "CR";
}

export function hasInvalidCountryParam(url: URL): boolean {
  const raw = url.searchParams.get("country");
  return raw != null && !normalizeCountryParam(raw);
}

export function isObserveCountryRequest(url: URL): boolean {
  return url.searchParams.get("observe") === "1";
}

export function routeUsesCountry(pathname: string): boolean {
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

export function parseCountryStatusParam(value: string | null): CountryRegistryStatus | null {
  return value === "active" || value === "warm" || value === "paused"
    ? value
    : null;
}

export function parseCountryFeatureTierParam(value: string | null): CountryFeatureTier | null {
  return value === "indexed" || value === "maps_warm" || value === "live" || value === "snipes"
    ? value
    : null;
}
