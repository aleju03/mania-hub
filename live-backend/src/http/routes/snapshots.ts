import { FarmHelperBuildError } from "../../features/farm-helper-thread.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isGlobalCountry, resolveCountryScope } from "../../countries.js";
import { FARM_HELPER_DEFAULT_LIMIT, FARM_HELPER_MAX_LIMIT, FarmHelperUserNotFoundError, getFarmHelperFarmers, getFarmHelperNeighbors, getFarmHelperSnapshot, resolveKnownFarmHelperSubject } from "../../features/farm-helper.js";
import { FarmHelperTimings, timeStage } from "../../features/farm-helper-timing.js";
import { enrichPayloadAvatarAccents } from "../../features/avatar-accents.js";
import { enqueueGlobalRankingStatRepairs, getCountryRankingsSnapshot, getGlobalRankingsSnapshot, getRegionRankingsSnapshot } from "../../features/global-rankings.js";
import { getMapCollection, getMapCollections, getMapCollectionsRotation } from "../../features/map-collections.js";
import { getMapSearchPage, getMapSearchSetEntry } from "../../features/map-search.js";
import { getMapsPageSnapshot, getMapsPlayersSnapshot, getMapsRandomBeatmapsets, getMapsRandomDraw, getMapsRefreshProgress, getMapsSnapshotMeta, MAPS_PLAYERS_MAX_PAGE_SIZE, type MapsPageQuery, type MapsPlayersPageQuery } from "../../features/maps.js";
import { getDanLeaderboard, getSkillLeaderboard, isDanLeaderboardKeyCount, isSkillLeaderboardKeyCount } from "../../features/skill-leaderboards.js";
import { getRankDeltaSnapshot } from "../../features/rank-snapshots.js";
import { getSnipeBoardSnapshot, getSnipesSnapshot } from "../../features/snipes.js";
import { getTrackerSnapshot, TRACKER_MAX_OFFSET } from "../../features/tracker.js";
import { getBoardLaneKey } from "../../shared/score.js";
import type { HttpContext, TimedRequest } from "../context.js";
import { REQUEST_FARM_HELPER_TIMINGS } from "../context.js";
import { activatePublicCountry, isObserveCountryRequest } from "../country-activation.js";
import { buildGlobalMapsResponseOnThread, buildMapSearchResponseOnThread, enforceCompressedLargeBody, getMapsResponseCacheState, MAP_SEARCH_RESPONSE_CACHE_TTL_MS, MAPS_GLOBAL_STALE_SERVE_MS, MAPS_PAGE_RESPONSE_CACHE_TTL_MS, MAPS_REFRESHING_RESPONSE_CACHE_TTL_MS, pruneMapsResponseCache, serveMapsResponseCached } from "../maps-response-cache.js";
import { prepareJsonResponse } from "../prepared-json.js";
import { MapsSnapshotBuildError } from "../maps-snapshot-thread.js";
import { sendTopPlaysSnapshot } from "../top-plays-response-cache.js";
import { clampInteger, clampLimit, isBridge, parseModAcronyms, parseUserIds } from "../request.js";
import { checkRate, negotiateEncoding, sendAccentEnrichedJson, sendJson } from "../respond.js";
import { parseDanLeaderboardQuery, parseFarmHelperKeyMode, parseFarmHelperSpeedBucket, parseFarmHelperView, parseGlobalRankingsQuery, parseSkillLeaderboardQuery, parseMapsPageQuery, parseMapsPlayersKind, parseMapsRandomDrawQuery, parseMapSearchQuery, parseTopPlaysSnapshotQuery, parseTrackerSnapshotFilters, parseTrackerSnapshotSort, parseTrackerSnapshotSortDirection } from "../snapshot-queries.js";

// The maps surfaces are the one place GLOBAL is a materialized projection
// rather than a read-time filter, and regions must never grow one (see the
// regions module). Until a region maps view exists as a pure read, these
// routes reject region scopes outright instead of serving a garbage lookup
// against a nonexistent `country_maps_snapshots` row.
function rejectRegionMapsScope(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, country: string): boolean {
  if (resolveCountryScope(country).kind !== "region") return false;
  sendJson(req, res, ctx, 400, { error: "region_not_supported" });
  return true;
}

export async function handleSnapshotRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL, country: string): Promise<boolean> {
  if (url.pathname === "/api/snapshots/tracker") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const global = isGlobalCountry(country);
    // Global is always windowed (min 1h): an unwindowed query would scan every
    // tracked country's score_events on each request.
    const windowHours = global ? clampInteger(url.searchParams.get("hours"), 1, 24 * 30, 1) : 0;
    const limit = clampLimit(url.searchParams.get("limit"), 100, 500);
    // Global used to be unbounded here, which made every distinct offset a
    // cache miss into a synchronous deep-offset scan on the serving loop.
    const offset = clampInteger(url.searchParams.get("offset"), 0, global ? TRACKER_MAX_OFFSET : 500, 0);
    const filters = parseTrackerSnapshotFilters(url.searchParams);
    const sort = parseTrackerSnapshotSort(url.searchParams);
    const sortDirection = parseTrackerSnapshotSortDirection(url.searchParams);
    const userIds = parseUserIds(url.searchParams.get("userIds"));
    const produceSnapshot = () => getTrackerSnapshot(ctx.db, country, limit, offset, {
      since: windowHours > 0 ? new Date(Math.floor(Date.now() / 5_000) * 5_000 - windowHours * 60 * 60 * 1000).toISOString() : undefined,
      filters,
      sort,
      sortDirection,
      userIds,
    });
    const snapshot = await produceSnapshot();
    await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/top-plays") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    await sendTopPlaysSnapshot(req, res, ctx, country, url.searchParams.get("window") ?? "7d", parseTopPlaysSnapshotQuery(url.searchParams));
    return true;
  }
  if (url.pathname === "/api/snapshots/snipes") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    await sendAccentEnrichedJson(req, res, ctx, 200, await getSnipesSnapshot(ctx.db, country, clampLimit(url.searchParams.get("limit"), 500, 1000)));
    return true;
  }
  if (url.pathname === "/api/snapshots/snipe-board") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const beatmapId = clampInteger(url.searchParams.get("beatmap"), 1, Number.MAX_SAFE_INTEGER, 0);
    if (beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap" });
      return true;
    }
    // The lane is derived here rather than passed as a key, so the caller only
    // has to send what a snipe event already carries and the lane format stays
    // owned by the projection.
    const laneKey = getBoardLaneKey(parseModAcronyms(url.searchParams.get("mods")), url.searchParams.get("lazer") === "1");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    await sendAccentEnrichedJson(req, res, ctx, 200, await getSnipeBoardSnapshot(ctx.db, country, beatmapId, laneKey, clampLimit(url.searchParams.get("limit"), 50, 100)));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-progress") {
    if (rejectRegionMapsScope(req, res, ctx, country)) return true;
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    sendJson(req, res, ctx, 200, await getMapsRefreshProgress(ctx.db, country));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-page") {
    if (rejectRegionMapsScope(req, res, ctx, country)) return true;
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    await handleMapsPageSnapshot(req, res, ctx, country, parseMapsPageQuery(url.searchParams));
    return true;
  }
  if (url.pathname === "/api/snapshots/maps-random-draw") {
    if (rejectRegionMapsScope(req, res, ctx, country)) return true;
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
    if (rejectRegionMapsScope(req, res, ctx, country)) return true;
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
    // Costly bucket: free-text shapes that miss the trigram index (short terms)
    // still fall back to search_text scans.
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const query = parseMapSearchQuery(url.searchParams);
    const cacheState = getMapsResponseCacheState(ctx.db);
    pruneMapsResponseCache(cacheState.searchResponses, Date.now());
    const encoding = negotiateEncoding(req);
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    // The parsed (clamped, deduped) query is the entire input, so its JSON is
    // a canonical key; single-flighted so a burst of one hot query runs once.
    await serveMapsResponseCached(req, res, ctx, {
      cache: cacheState.searchResponses,
      inflight: cacheState.searchInflight,
      key: `${JSON.stringify(query)}|${encoding ?? "identity"}`,
      freshnessKey: "",
      staleServeMs: 0,
      build: async () => {
        const prepared = await buildMapSearchResponseOnThread(ctx, { kind: "maps-search", query, encoding })
          ?? await prepareJsonResponse(200, await getMapSearchPage(ctx.db, query), encoding);
        return { prepared, cacheTtlMs: MAP_SEARCH_RESPONSE_CACHE_TTL_MS };
      },
    }).catch((error: unknown) => {
      if (!(error instanceof MapsSnapshotBuildError)) throw error;
      res.setHeader("cache-control", "no-store");
      res.setHeader("retry-after", "5");
      sendJson(req, res, ctx, 503, { error: "maps_search_unavailable" });
    });
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
    if (resolveCountryScope(country).kind === "region") {
      // Served as a filtered view of the cached global board; no activation,
      // registry row, or stat-repair churn (the GLOBAL branch already covers
      // repairs for the same underlying board).
      res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      await sendAccentEnrichedJson(req, res, ctx, 200, await getRegionRankingsSnapshot(ctx.db, country, parseGlobalRankingsQuery(url.searchParams)));
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
  /* Skill and dan leaderboards. Public reads: the board is one global
     projection the scope filters, so the response caches for the board's own
     5-minute rebuild rather than being recomputed per visitor. Activation runs
     like every other country-scoped snapshot, so landing straight on ?tab=skills
     for a cold country starts warming it instead of showing an empty board. */
  if (url.pathname === "/api/snapshots/skill-leaderboard") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const query = parseSkillLeaderboardQuery(url.searchParams);
    if (!isSkillLeaderboardKeyCount(query.keyCount)) {
      sendJson(req, res, ctx, 400, { error: "unsupported_keymode" });
      return true;
    }
    if (!query.axis) {
      sendJson(req, res, ctx, 400, { error: "unknown_axis" });
      return true;
    }
    const snapshot = await getSkillLeaderboard(ctx.db, {
      country,
      keyCount: query.keyCount,
      axis: query.axis,
      page: query.page,
      pageSize: query.pageSize,
    });
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=600");
    await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/dan-leaderboard") {
    if (!isObserveCountryRequest(url) && !await activatePublicCountry(req, res, ctx, country)) return true;
    const query = parseDanLeaderboardQuery(url.searchParams);
    if (!isDanLeaderboardKeyCount(query.keyCount)) {
      sendJson(req, res, ctx, 400, { error: "unsupported_keymode" });
      return true;
    }
    const snapshot = await getDanLeaderboard(ctx.db, {
      country,
      keyCount: query.keyCount,
      side: query.side,
      skillset: query.skillset,
      page: query.page,
      pageSize: query.pageSize,
    });
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=600");
    await sendAccentEnrichedJson(req, res, ctx, 200, snapshot);
    return true;
  }
  if (url.pathname === "/api/snapshots/farm-helper") {
    // Global tool: no country activation. A roster-only subject may still need
    // a cold best-scores mint, so it shares the costly bucket; arbitrary
    // subjects are rejected by the local known-subject gate below.
    const userKey = (url.searchParams.get("user") ?? "").trim();
    if (!userKey) {
      sendJson(req, res, ctx, 400, { error: "missing_user" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const viewerUserId = isBridge(req, ctx)
      ? clampInteger(url.searchParams.get("viewerUserId"), 0, Number.MAX_SAFE_INTEGER, 0)
      : 0;
    // The bridge may cold-mint only the verified viewer's own numeric id. Every
    // public/other subject must already be a roster member or have a stored
    // profile, otherwise arbitrary names would spend up to three osu! calls.
    const ownerColdMint = viewerUserId > 0 && userKey === String(viewerUserId);
    const knownSubject = ownerColdMint
      ? { lookupMode: "userId" as const }
      : await resolveKnownFarmHelperSubject(ctx.db, userKey);
    if (!knownSubject) {
      sendJson(req, res, ctx, 404, { error: "user_not_found" });
      return true;
    }
    // Stage timings: which part of a slow build actually cost the time. Kept on
    // the request so setServerTiming and the slow log can both read it.
    const timings = new FarmHelperTimings();
    (req as TimedRequest)[REQUEST_FARM_HELPER_TIMINGS] = timings;
    // The subject's feedback marks are private, so they only ride the snapshot
    // when the request proved who is asking - which only the server-to-server
    // bridge can do, by attaching the token and the osu!-verified viewer id
    // (the frontend server fn does this for the player's own board). A browser
    // reading this endpoint directly is anonymous and gets the public build.
    try {
      const snapshot = await getFarmHelperSnapshot(ctx.db, ctx.osu, userKey, {
        keyMode: parseFarmHelperKeyMode(url.searchParams.get("key")),
        view: parseFarmHelperView(url.searchParams.get("view")),
        limit: clampInteger(url.searchParams.get("limit"), 1, FARM_HELPER_MAX_LIMIT, FARM_HELPER_DEFAULT_LIMIT),
        viewerUserId,
        // The build's read-time feedback reconcile writes; keep those writes
        // off the read connection that serves page loads (the serveWriteDb
        // invariant, same as the feedback mutation endpoints below).
      }, ctx.queue, {
        writeDb: ctx.serveWriteDb ?? ctx.db,
        timings,
        profileLookupMode: knownSubject.lookupMode,
      });
      // An owner-scoped board carries that player's own marks, so it must not
      // sit in any shared cache on the way back.
      res.setHeader(
        "cache-control",
        viewerUserId > 0 ? "private, no-store" : "public, max-age=60, stale-while-revalidate=300",
      );
      await timeStage(timings, "fh_accents", () => enrichPayloadAvatarAccents(ctx.db, ctx.queue ?? null, snapshot));
      sendJson(req, res, ctx, 200, snapshot);
    } catch (error) {
      if (error instanceof FarmHelperBuildError) {
        res.setHeader("retry-after", "30");
        res.setHeader("cache-control", "no-store");
        sendJson(req, res, ctx, 503, { error: "farm_helper_temporarily_unavailable", retryable: true });
        return true;
      }
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
    const knownSubject = await resolveKnownFarmHelperSubject(ctx.db, userKey);
    if (!knownSubject) {
      sendJson(req, res, ctx, 404, { error: "user_not_found" });
      return true;
    }
    try {
      const result = await getFarmHelperFarmers(
        ctx.db,
        ctx.osu,
        userKey,
        beatmapId,
        parseFarmHelperSpeedBucket(url.searchParams.get("speed")),
        parseFarmHelperKeyMode(url.searchParams.get("key")),
        ctx.serveWriteQueue ?? ctx.queue,
        knownSubject.lookupMode,
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
    const knownSubject = await resolveKnownFarmHelperSubject(ctx.db, userKey);
    if (!knownSubject) {
      sendJson(req, res, ctx, 404, { error: "user_not_found" });
      return true;
    }
    try {
      const result = await getFarmHelperNeighbors(
        ctx.db,
        ctx.osu,
        userKey,
        parseFarmHelperKeyMode(url.searchParams.get("key")),
        ctx.serveWriteQueue ?? ctx.queue,
        knownSubject.lookupMode,
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
  return false;
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
