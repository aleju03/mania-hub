import type { IncomingMessage, ServerResponse } from "node:http";
import { exec } from "../../db.js";
import { getPlayerActivityAvailability, getPlayerActivityDayDetail, getPlayerActivitySnapshot } from "../../features/activity.js";
import { enrichPayloadAvatarAccents } from "../../features/avatar-accents.js";
import { getCachedPackCardSnapshot, getCachedPlayerProfileSnapshot, getPlayerAbout, getPlayerProfileSnapshot, getPlayerRecentScores, getPlayerRecentScoresFromOsu, getPlayerReplayScores, ProfileUserSuppressedError } from "../../features/player-profiles.js";
import { getPlayerKeymodePpKeyCounts, getPlayerKeymodePpTail } from "../../features/keymode-pp.js";
import { enqueueMissingPlayDetails } from "../../features/activity-detail-on-demand.js";
import { DAN_EVIDENCE_PAGE_MAX_CLEARS, getPlayerSkillBreakdown, getPlayerSkillDanEvidence, getPlayerSkillPlays, isPlayerSkillAxis } from "../../features/player-skills.js";
import { decoratePlayerSkillBreakdown } from "../../features/skill-baseline.js";
import { errorContext, logInfo, logWarn } from "../../logger.js";
import { OsuApiError } from "../../osu/client.js";
import { isUserKnownInactive } from "../../user-status.js";
import type { OscScore } from "../../shared/types.js";
import type { Db } from "../../db.js";
import type { HttpContext } from "../context.js";
import { createMapsResponseCache, pruneMapsResponseCache, serveMapsResponseCached, type MapsResponseCache } from "../maps-response-cache.js";
import { prepareJsonResponse, type PreparedJsonResponse } from "../prepared-json.js";
import { clampInteger, clampLimit } from "../request.js";
import { checkRate, negotiateEncoding, sendAccentEnrichedJson, sendJson } from "../respond.js";

export async function handleProfileRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL, country: string): Promise<boolean> {
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
      let snapshot;
      try {
        snapshot = await getPlayerProfileSnapshot(
          ctx.serveWriteDb ?? ctx.db,
          ctx.osu,
          profileRoute.key,
          { queue: wantsRefresh ? ctx.serveWriteQueue ?? ctx.queue : null, lookupMode },
        );
      } catch (error) {
        // A profile nobody has stored is minted inline from the osu! API, so a
        // key naming no live account (deleted, renamed, a typo in the URL)
        // surfaces here as a 404 OsuApiError. That is a miss, not a fault: it
        // used to fall through to the server's catch-all as a 500 plus an
        // http_unhandled_error warn.
        if (!isOsuNotFound(error) && !(error instanceof ProfileUserSuppressedError)) throw error;
        sendJson(req, res, ctx, 404, { error: "profile_not_found" });
        return true;
      }
      await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
      return true;
    }
    const userId = Number(profileRoute.key);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (await isUserKnownInactive(ctx.db, userId)) {
      sendJson(req, res, ctx, 404, { error: "profile_not_found" });
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
    if (profileRoute.kind === "replay-scores") {
      const limit = clampLimit(url.searchParams.get("limit"), 100, 200);
      const offset = clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0);
      res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=60");
      sendJson(req, res, ctx, 200, await getPlayerReplayScores(ctx.db, userId, limit, offset));
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
    if (profileRoute.kind === "skill-plays") {
      if (!checkRate(req, res, ctx, "publicCostly")) return true;
      const axis = url.searchParams.get("axis") ?? "";
      const keyCount = clampInteger(url.searchParams.get("keys"), 1, 18, 0);
      if (!isPlayerSkillAxis(axis) || keyCount <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_skill_axis" });
        return true;
      }
      const page = await getPlayerSkillPlays(ctx.db, userId, keyCount, axis, {
        limit: clampInteger(url.searchParams.get("limit"), 1, 50, 50),
        offset: clampInteger(url.searchParams.get("offset"), 0, 5_000, 0),
      });
      res.setHeader("cache-control", "public, max-age=60");
      sendJson(req, res, ctx, 200, page);
      return true;
    }
    if (profileRoute.kind === "keymode-pp") {
      if (!checkRate(req, res, ctx, "publicCostly")) return true;
      /* The keymode chips are drawn on every profile view, so they ask for the
         key counts alone. No plays, and no detail backfill either: nobody has
         opened a list yet. */
      if (url.searchParams.get("view") === "keys") {
        res.setHeader("cache-control", "public, max-age=300");
        sendJson(req, res, ctx, 200, await getPlayerKeymodePpKeyCounts(ctx.db, userId));
        return true;
      }
      // Read-only and index-scoped, but it is the profile page's per-view call,
      // so it caches like the other derived reads rather than re-running for
      // every tab someone opens.
      res.setHeader("cache-control", "public, max-age=300");
      sendJson(req, res, ctx, 200, await getPlayerKeymodePpTail(ctx.db, userId));
      /* Somebody is reading this profile's per-keymode lists, so any play on
         them still missing its combo, score and replay button is worth one
         osu! call. Queued after the response, on the bookkeeping connection,
         and skipped entirely when this process has none: it must never make a
         page load wait, and it must never touch the serving connection. */
      if (ctx.serveWriteDb && ctx.serveWriteQueue) {
        void enqueueMissingPlayDetails(ctx.serveWriteDb, ctx.serveWriteQueue, userId)
          .catch((error) => logWarn("activity_detail_on_demand_enqueue_failed", { user_id: userId, ...errorContext(error) }));
      }
      return true;
    }
    if (profileRoute.kind === "dan-evidence") {
      if (!checkRate(req, res, ctx, "publicCostly")) return true;
      const side = url.searchParams.get("side") === "ln" ? "ln" : "rc";
      const keyCount = clampInteger(url.searchParams.get("keys"), 1, 18, 0);
      if (keyCount <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_key_count" });
        return true;
      }
      // `limit`/`offset` page the "all clears" list past the default window
      // (the modal's "load more"); the feature clamps both to its own ceilings.
      const limit = clampInteger(url.searchParams.get("limit"), 1, DAN_EVIDENCE_PAGE_MAX_CLEARS, 0);
      const offset = clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0);
      const evidence = await getPlayerSkillDanEvidence(
        ctx.db,
        userId,
        keyCount,
        side,
        ctx.serveWriteQueue ?? ctx.queue,
        { ...(limit > 0 ? { maxClears: limit } : {}), clearsOffset: offset },
      );
      if (!evidence) {
        sendJson(req, res, ctx, 404, { error: "dan_evidence_not_ready" });
        return true;
      }
      res.setHeader("cache-control", "public, max-age=60");
      sendJson(req, res, ctx, 200, evidence);
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    let about;
    try {
      about = await getPlayerAbout(ctx.serveWriteDb ?? ctx.db, ctx.osu, userId);
    } catch (error) {
      if (!isOsuNotFound(error)) throw error;
      sendJson(req, res, ctx, 404, { error: "profile_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, about);
    return true;
  }
  return false;
}

/** An osu! account that does not exist (or no longer does) behind an inline fetch. */
function isOsuNotFound(error: unknown): boolean {
  return error instanceof OsuApiError && error.status === 404;
}

function parseProfileRoute(pathname: string): { kind: "cached-snapshot" | "snapshot" | "recent" | "replay-scores" | "about" | "activity" | "activity-day" | "activity-availability" | "skills" | "skill-plays" | "dan-evidence" | "keymode-pp"; key: string } | null {
  const match = /^\/api\/profiles\/([^/]+)\/(cached-snapshot|snapshot|recent|replay-scores|about|activity|activity-day|activity-availability|skills|skill-plays|dan-evidence|keymode-pp)$/.exec(pathname);
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return {
    key,
    kind: match[2] as "cached-snapshot" | "snapshot" | "recent" | "replay-scores" | "about" | "activity" | "activity-day" | "activity-availability" | "skills" | "skill-plays" | "keymode-pp",
  };
}

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
    const { ScoreIngestor } = await import("../../ingest/score-ingestor.js");
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
