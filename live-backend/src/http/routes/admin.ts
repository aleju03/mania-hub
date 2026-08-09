import type { IncomingMessage, ServerResponse } from "node:http";
import { activateCountry, deleteCountryData, isCountryFeatureAtLeast, isGlobalCountry, setCountryFeatureTier, setCountryPaused, setCountryStatus } from "../../countries.js";
import { exec, parseJson, type Db } from "../../db.js";
import { countUserLinks } from "../../discord/identity.js";
import { listAllSubscriptions, removeSubscriptionById } from "../../discord/subscriptions.js";
import { clearDoneAdminTodos, createAdminTodo, deleteAdminTodo, listAdminTodos, updateAdminTodo, type CreateTodoInput, type UpdateTodoInput } from "../../features/admin-todos.js";
import { cancelBeatmapOsuFileBackfill, startBeatmapOsuFileBackfill } from "../../features/beatmap-osu-file-backfill.js";
import { cancelChartAnalysisBackfill, enqueueChartAnalysisBackfill, startChartAnalysisBackfill } from "../../features/chart-analysis.js";
import { importDanBenchmark, isDanBenchmarkFamily, listDanBenchmarkHiddenDiffs, listDanBenchmarkLabels, setDanBenchmarkHiddenDiff, setDanBenchmarkLabel } from "../../features/dan-benchmark.js";
import { goatPollWindow, listGoatPollBoard, removeGoatPollNominee } from "../../features/goat-poll.js";
import { enqueueGlobalMapsRefresh, enqueueMapsRefresh, enqueueMapsRefreshIfDue } from "../../features/maps.js";
import { rebuildMapCollections } from "../../features/map-collections.js";
import { getHonoraryPullsReport } from "../../features/pack-pulls.js";
import { HONORARY_USER_IDS } from "../../features/pack-wallets.js";
import { normalizeStreakPool, removeStreakBest } from "../../features/pack-streak.js";
import { deleteSkin, setSkinHidden } from "../../features/skins.js";
import { getSweepReports } from "../../features/sweeps-status.js";
import { errorContext, logInfo, logWarn } from "../../logger.js";
import { setWorkersPaused } from "../../live/runtime-status.js";
import { cancelOscCountryCatchup, enqueueOscBackfill, enqueueOscCountryCatchup } from "../../osc/backfill.js";
import { getCachedBeatmapFile } from "../../osu/beatmap-file-cache.js";
import { getDbDiskUsage, getStorageBreakdownSnapshot, getStorageFootprint, getTablePreview, runRetention } from "../../retention.js";
import { enqueueRosterRefreshes } from "../../rosters/country-rosters.js";
import { deleteSkinObjects } from "../../skins/r2.js";
import { setUserActive, wipeUserProjections } from "../../users.js";
import type { HttpContext } from "../context.js";
import { parseCountryFeatureTierParam, parseCountryStatusParam } from "../country-activation.js";
import { isAdmin, normalizeIdList, readBody } from "../request.js";
import { sendJson } from "../respond.js";
import { statusBody } from "../status-report.js";

export async function handleAdminRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL, country: string): Promise<boolean> {
  if (url.pathname === "/api/admin/status") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, await statusBody(ctx, { includeWorkerActivity: true, snapshotCountry: country }));
    return true;
  }
  if (url.pathname === "/api/admin/honorary-pulls") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // The roster comes from the same allowlist that guards the GOAT tier on
    // sync, so this reports on exactly the ids that can hold it.
    sendJson(req, res, ctx, 200, await getHonoraryPullsReport(ctx.db, HONORARY_USER_IDS));
    return true;
  }
  if (url.pathname === "/api/admin/storage-breakdown") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // Per-table bytes answer "what is in the database"; disk + per-path answer
    // "what else is on the volume", which is the half that decides whether the
    // box runs out of room. The storage modal is the only place either belongs.
    const [breakdown, disk, storagePaths] = await Promise.all([
      getStorageBreakdownSnapshot(ctx.db, ctx.config),
      getDbDiskUsage(ctx.config),
      getStorageFootprint(ctx.config),
    ]);
    sendJson(req, res, ctx, 200, { ...breakdown, disk, storagePaths });
    return true;
  }
  if (url.pathname === "/api/admin/table-rows") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const table = url.searchParams.get("table") ?? "";
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const search = url.searchParams.get("search") ?? "";
    const preview = await getTablePreview(ctx.db, table, limit, offset, search);
    if (!preview) {
      sendJson(req, res, ctx, 404, { error: "unknown_table" });
      return true;
    }
    sendJson(req, res, ctx, 200, preview);
    return true;
  }
  if (url.pathname === "/api/admin/set-user-active") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; username?: unknown; active?: unknown }>((await readBody(req)) || "{}", {});
    const active = body.active === true || body.active === 1 || body.active === "1";
    let userId = Number(body.userId);
    let userRow = Number.isInteger(userId) && userId > 0
      ? (await exec(ctx.db, "select user_id, username from users where user_id = ? limit 1", [userId])).rows[0]
      : undefined;
    if (!userRow) {
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (username) {
        userRow = (await exec(ctx.db, "select user_id, username from users where lower(username) = lower(?) limit 1", [username])).rows[0];
        if (userRow) userId = Number(userRow.user_id);
      }
    }
    if (!userRow || !Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 404, { error: "user_not_found" });
      return true;
    }
    const result = await setUserActive(ctx.serveWriteDb ?? ctx.db, userId, active, "admin: manual toggle");
    sendJson(req, res, ctx, 200, { ok: true, ...result });
    return true;
  }
  if (url.pathname === "/api/admin/wipe-user-data") {
    // Heavier sibling of set-user-active: deactivates AND permanently deletes
    // the player's public projection rows (boards, farmed scores, key stats,
    // skill ratings). The users row survives as the inactive tombstone.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; username?: unknown }>((await readBody(req)) || "{}", {});
    let userId = Number(body.userId);
    let userRow = Number.isInteger(userId) && userId > 0
      ? (await exec(ctx.db, "select user_id, username from users where user_id = ? limit 1", [userId])).rows[0]
      : undefined;
    if (!userRow) {
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (username) {
        userRow = (await exec(ctx.db, "select user_id, username from users where lower(username) = lower(?) limit 1", [username])).rows[0];
        if (userRow) userId = Number(userRow.user_id);
      }
    }
    if (!userRow || !Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 404, { error: "user_not_found" });
      return true;
    }
    const username = userRow.username == null ? null : String(userRow.username);
    const result = await wipeUserProjections(ctx.serveWriteDb ?? ctx.db, userId);
    logInfo("admin_wipe_user_data", { userId, username, deleted: result.deleted, untrackedRosters: result.untrackedRosters, deletedJobs: result.deletedJobs });
    sendJson(req, res, ctx, 200, {
      ok: true,
      userId,
      username,
      untrackedRosters: result.untrackedRosters,
      deletedJobs: result.deletedJobs,
      deleted: result.deleted,
    });
    return true;
  }
  if (url.pathname === "/api/admin/skins/moderate") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ id?: unknown; action?: unknown }>((await readBody(req)) || "{}", {});
    const id = typeof body.id === "string" ? body.id : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!id || !["hide", "unhide", "delete"].includes(action)) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    if (action === "delete") {
      const deleted = await deleteSkin(ctx.serveWriteDb ?? ctx.db, id);
      if (deleted) {
        await deleteSkinObjects(ctx.config, deleted.keys).catch((error) => {
          logWarn("skin_delete_r2_failed", { id, ...errorContext(error) });
        });
        logInfo("skin_deleted", { id, by: "admin" });
      }
      sendJson(req, res, ctx, deleted ? 200 : 404, { ok: Boolean(deleted) });
      return true;
    }
    const ok = await setSkinHidden(ctx.serveWriteDb ?? ctx.db, id, action === "hide");
    if (ok) logInfo("skin_moderated", { id, action });
    sendJson(req, res, ctx, ok ? 200 : 404, { ok });
    return true;
  }
  if (url.pathname === "/api/admin/packs/streak/remove") {
    /* Take one streak off the board. Not a ban and not a wipe: the account is
       untouched and free to set another one, which is the whole moderation
       model here (a streak nobody can explain is worth removing; deciding the
       person behind it may never play again is not the same call). */
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; pool?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Math.floor(Number(body.userId) || 0);
    if (userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const pool = normalizeStreakPool(body.pool);
    const result = await removeStreakBest(ctx.serveWriteDb ?? ctx.db, { userId, pool });
    if (result.removed) {
      logInfo("streak_best_removed", {
        userId,
        pool,
        streak: result.entry?.streak ?? 0,
        runsDeleted: result.runsDeleted,
      });
    }
    sendJson(req, res, ctx, result.removed ? 200 : 404, { ok: result.removed, ...result });
    return true;
  }
  if (url.pathname === "/api/admin/goat-poll/remove") {
    /* Take one nominee off the poll, with their votes. The board is public and
       anyone signed in can put a name up, so this is the answer to a joke or an
       abusive nomination — a delete key, not a ban: the nominator keeps their
       other nominations and the player can be nominated again. */
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const window = goatPollWindow();
    if (!window) {
      sendJson(req, res, ctx, 404, { error: "poll_not_configured" });
      return true;
    }
    const body = parseJson<{ nomineeId?: unknown }>((await readBody(req)) || "{}", {});
    const nomineeId = typeof body.nomineeId === "string" ? body.nomineeId : "";
    if (!nomineeId) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const result = await removeGoatPollNominee(ctx.serveWriteDb ?? ctx.db, window.pollId, nomineeId);
    if (result.removed) {
      // The same live event a vote emits, as a tombstone: boards open elsewhere
      // drop the row now rather than keeping a removed nomination on screen
      // until their next poll.
      await ctx.events
        .append("goat_poll", null, { pollId: window.pollId, removedId: nomineeId }, undefined, ctx.serveWriteDb ?? undefined)
        .catch((error) => logWarn("goat_poll_event_failed", { nomineeId, ...errorContext(error) }));
      logInfo("goat_poll_nominee_removed", {
        pollId: window.pollId,
        nomineeId,
        username: result.username,
        votesDeleted: result.votesDeleted,
      });
    }
    sendJson(req, res, ctx, result.removed ? 200 : 404, {
      ok: result.removed,
      ...result,
      nominees: await listGoatPollBoard(ctx.db, window.pollId),
    });
    return true;
  }
  if (url.pathname === "/api/admin/ingest-fixture") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const rows = parseJson<unknown[]>((await readBody(req)) || "[]", []);
    const { ScoreIngestor } = await import("../../ingest/score-ingestor.js");
    const ingestor = new ScoreIngestor(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.events, ctx.config);
    sendJson(req, res, ctx, 200, await ingestor.ingestBatch(rows as never[], "admin_fixture"));
    return true;
  }
  if (url.pathname === "/api/admin/refresh-roster") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    await enqueueRosterRefreshes(ctx.queue, [country]);
    sendJson(req, res, ctx, 200, { ok: true, country });
    return true;
  }
  if (url.pathname === "/api/admin/pause-country" || url.pathname === "/api/admin/resume-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const paused = url.pathname === "/api/admin/pause-country";
    sendJson(req, res, ctx, 200, { ok: true, country: await setCountryPaused(ctx.serveWriteDb ?? ctx.db, ctx.config, country, paused) });
    return true;
  }
  if (url.pathname === "/api/admin/set-country-status") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const status = parseCountryStatusParam(url.searchParams.get("status"));
    if (!status) {
      sendJson(req, res, ctx, 400, { error: "invalid_status" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, country: await setCountryStatus(ctx.serveWriteDb ?? ctx.db, ctx.config, country, status) });
    return true;
  }
  if (url.pathname === "/api/admin/set-country-tier") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const tier = parseCountryFeatureTierParam(url.searchParams.get("tier"));
    if (!tier) {
      sendJson(req, res, ctx, 400, { error: "invalid_tier" });
      return true;
    }
    const updated = await setCountryFeatureTier(ctx.serveWriteDb ?? ctx.db, ctx.config, country, tier);
    if (ctx.config.enableOsuApiJobs) {
      await enqueueRosterRefreshes(ctx.queue, [updated.country]);
    }
    if (ctx.config.enableOsuApiJobs && isCountryFeatureAtLeast(updated.featureTier, "maps_warm")) {
      await enqueueMapsRefreshIfDue(ctx.db, ctx.queue, updated.country, ctx.config.mapsRefreshIntervalMs, { priority: 90 });
    }
    sendJson(req, res, ctx, 200, { ok: true, country: updated });
    return true;
  }
  if (url.pathname === "/api/admin/add-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const added = await activateCountry(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.config, country);
    if (ctx.config.enableOsuApiJobs && isCountryFeatureAtLeast(added.featureTier, "maps_warm")) {
      await enqueueMapsRefreshIfDue(ctx.db, ctx.queue, added.country, ctx.config.mapsRefreshIntervalMs, { priority: 15 });
    }
    sendJson(req, res, ctx, 200, { ok: true, country: added });
    return true;
  }
  if (url.pathname === "/api/admin/delete-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    const writeDb = ctx.serveWriteDb ?? ctx.db;
    const writeQueue = ctx.serveWriteQueue ?? ctx.queue;
    const deleted = await deleteCountryData(writeDb, country);
    await enqueueGlobalMapsRefresh(writeQueue, { priority: 90, replaceDone: true });
    sendJson(req, res, ctx, 200, { ok: true, country, deleted });
    return true;
  }
  if (url.pathname === "/api/admin/refresh-maps") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.config.enableOsuApiJobs) {
      sendJson(req, res, ctx, 409, { error: "osu_api_jobs_disabled" });
      return true;
    }
    await enqueueMapsRefresh(ctx.queue, country, { priority: 90, replaceDone: true });
    sendJson(req, res, ctx, 200, { ok: true, country });
    return true;
  }
  if (url.pathname === "/api/admin/rebuild-collections") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // Run inline (local index pass, no osu! API) so the response only returns
    // once the packs are freshly rotated; the admin button can then refetch and
    // immediately show the new sample instead of waiting on the queue.
    await rebuildMapCollections(ctx.serveWriteDb ?? ctx.db);
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/catch-up-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    await setCountryStatus(ctx.serveWriteDb ?? ctx.db, ctx.config, country, "active");
    await enqueueRosterRefreshes(ctx.queue, [country]);
    const queued = await enqueueOscCountryCatchup(ctx.queue, ctx.serveWriteDb ?? ctx.db, ctx.config, country);
    sendJson(req, res, ctx, 200, { ok: true, ...queued });
    return true;
  }
  if (url.pathname === "/api/admin/cancel-catch-up-country") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (isGlobalCountry(country)) {
      sendJson(req, res, ctx, 400, { error: "global_is_not_country" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, ...await cancelOscCountryCatchup(ctx.serveWriteDb ?? ctx.db, country) });
    return true;
  }
  if (url.pathname === "/api/admin/clear-failed-jobs") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const type = url.searchParams.get("type") ?? undefined;
    sendJson(req, res, ctx, 200, { ok: true, deleted: await ctx.queue.clearFailed(type) });
    return true;
  }
  if (url.pathname === "/api/admin/pause-workers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    ctx.pauseWorkers?.();
    // Cross-process flag the worker polls, so pause works when workers run elsewhere.
    await setWorkersPaused(ctx.serveWriteDb ?? ctx.db, true);
    sendJson(req, res, ctx, 200, { ok: true, worker: ctx.workerStatus?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/admin/resume-workers") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    ctx.resumeWorkers?.();
    await setWorkersPaused(ctx.serveWriteDb ?? ctx.db, false);
    sendJson(req, res, ctx, 200, { ok: true, worker: ctx.workerStatus?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/admin/run-retention") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, deleted: await runRetention(ctx.serveWriteDb ?? ctx.db, ctx.config) });
    return true;
  }
  if (url.pathname === "/api/admin/osc-smoke") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const smokeUrl = new URL("/api/scores", ctx.config.oscBaseUrl);
    smokeUrl.searchParams.set("mode", "mania");
    smokeUrl.searchParams.set("limit", "10");
    const response = await fetch(smokeUrl);
    if (!response.ok) throw new Error(`oSC smoke failed (${response.status})`);
    const body = await response.json() as { scores?: Array<{ ruleset_id?: number }> } | Array<{ ruleset_id?: number }>;
    const scores = Array.isArray(body) ? body : body.scores ?? [];
    sendJson(req, res, ctx, 200, {
      ok: true,
      count: scores.length,
      maniaCount: scores.filter((score) => score.ruleset_id === 3 || score.ruleset_id == null).length,
    });
    return true;
  }
  if (url.pathname === "/api/admin/run-osc-backfill") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    await enqueueOscBackfill(ctx.queue, ctx.serveWriteDb ?? ctx.db, ctx.config);
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/dan-classifier/files") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ ids?: unknown }>((await readBody(req)) || "{}", {});
    const ids = [...new Set(normalizeIdList(body.ids))].slice(0, 50);
    if (!ids.length) {
      sendJson(req, res, ctx, 400, { error: "invalid_ids" });
      return true;
    }
    const files: Array<{ beatmapId: number; content: string }> = [];
    const missing: number[] = [];
    for (const beatmapId of ids) {
      try {
        // cached-only: an archive fallback here can stall the whole batch for
        // minutes on one uncached chart (full .osz download from mirrors, which
        // may be stale and not even contain the diff). Uncached charts come back
        // as missing and go through the explicit fetch-missing path instead.
        const content = await getCachedBeatmapFile(ctx.serveWriteDb ?? ctx.db, ctx.osu, beatmapId, "dan_classifier_admin", {
          allowArchive: false,
          allowDirect: false,
        });
        files.push({ beatmapId, content });
      } catch {
        missing.push(beatmapId);
      }
    }
    sendJson(req, res, ctx, 200, { files, missing });
    return true;
  }
  if (url.pathname === "/api/admin/dan-classifier/sets") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ beatmapsetIds?: unknown; beatmapIds?: unknown }>((await readBody(req)) || "{}", {});
    const beatmapsetIds = [...new Set(normalizeIdList(body.beatmapsetIds))].slice(0, 100);
    const beatmapIds = [...new Set(normalizeIdList(body.beatmapIds))].slice(0, 400);
    if (!beatmapsetIds.length && !beatmapIds.length) {
      sendJson(req, res, ctx, 400, { error: "invalid_ids" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getDanClassifierSets(ctx.db, beatmapsetIds, beatmapIds));
    return true;
  }
  if (url.pathname === "/api/admin/sweeps") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    // Read-only status over the done-key/self-chaining background sweeps
    // (registry in features/sweeps-status.ts).
    sendJson(req, res, ctx, 200, { sweeps: await getSweepReports(ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/chart-analysis/backfill") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const limit = Number(url.searchParams.get("limit") ?? "");
    const enqueued = await enqueueChartAnalysisBackfill(
      ctx.serveWriteDb ?? ctx.db,
      ctx.queue,
      Number.isFinite(limit) && limit > 0 ? limit : undefined,
      { includeFailed: true },
    );
    sendJson(req, res, ctx, 200, { ok: true, enqueued });
    return true;
  }
  if (url.pathname === "/api/admin/chart-analysis/start") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await startChartAnalysisBackfill(ctx.serveWriteDb ?? ctx.db, ctx.queue) });
    return true;
  }
  if (url.pathname === "/api/admin/chart-analysis/cancel") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await cancelChartAnalysisBackfill(ctx.serveWriteDb ?? ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/osu-file-backfill/start") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.config.enableOsuApiJobs) {
      sendJson(req, res, ctx, 409, { error: "osu_api_jobs_disabled" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await startBeatmapOsuFileBackfill(ctx.serveWriteDb ?? ctx.db, ctx.queue) });
    return true;
  }
  if (url.pathname === "/api/admin/osu-file-backfill/cancel") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, backfill: await cancelBeatmapOsuFileBackfill(ctx.serveWriteDb ?? ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/discord/status") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, {
      ok: true,
      discord: ctx.discord?.status() ?? { enabled: false },
      subscriptions: await listAllSubscriptions(ctx.db),
      linkCount: await countUserLinks(ctx.db),
    });
    return true;
  }
  if (url.pathname === "/api/admin/discord/register-commands") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.discord) {
      sendJson(req, res, ctx, 400, { error: "discord_not_configured" });
      return true;
    }
    try {
      const result = await ctx.discord.registerCommands();
      sendJson(req, res, ctx, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(req, res, ctx, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (url.pathname === "/api/admin/discord/register-emojis") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.discord) {
      sendJson(req, res, ctx, 400, { error: "discord_not_configured" });
      return true;
    }
    try {
      const force = url.searchParams.get("force") === "1";
      const result = await ctx.discord.registerEmojis(force);
      sendJson(req, res, ctx, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(req, res, ctx, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (url.pathname === "/api/admin/discord/guilds") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!ctx.discord) {
      sendJson(req, res, ctx, 400, { error: "discord_not_configured" });
      return true;
    }
    try {
      const guilds = await ctx.discord.listGuilds();
      sendJson(req, res, ctx, 200, { ok: true, count: guilds.length, guilds });
    } catch (error) {
      sendJson(req, res, ctx, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (url.pathname === "/api/admin/discord/remove-subscription") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const id = Number(url.searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_id" });
      return true;
    }
    const removed = await removeSubscriptionById(ctx.serveWriteDb ?? ctx.db, id);
    if (removed) ctx.discord?.notifySubscriptionsChanged();
    sendJson(req, res, ctx, 200, { ok: true, removed });
    return true;
  }
  if (url.pathname === "/api/admin/todos") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { todos: await listAdminTodos(ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/todos/create") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<CreateTodoInput>((await readBody(req)) || "{}", {});
    const todo = await createAdminTodo(ctx.serveWriteDb ?? ctx.db, body);
    if (!todo) {
      sendJson(req, res, ctx, 400, { error: "invalid_title" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, todo });
    return true;
  }
  if (url.pathname === "/api/admin/todos/update") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<UpdateTodoInput>((await readBody(req)) || "{}", {});
    const todo = await updateAdminTodo(ctx.serveWriteDb ?? ctx.db, body);
    if (!todo) {
      sendJson(req, res, ctx, 404, { error: "todo_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, todo });
    return true;
  }
  if (url.pathname === "/api/admin/todos/delete") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ id?: unknown }>((await readBody(req)) || "{}", {});
    const removed = await deleteAdminTodo(ctx.serveWriteDb ?? ctx.db, typeof body.id === "string" ? body.id : "");
    if (!removed) {
      sendJson(req, res, ctx, 404, { error: "todo_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/todos/clear-done") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, cleared: await clearDoneAdminTodos(ctx.serveWriteDb ?? ctx.db) });
    return true;
  }
  if (url.pathname === "/api/admin/dan-benchmark/labels" || url.pathname === "/api/admin/dan-benchmark/hidden") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const family = url.searchParams.get("family");
    if (!isDanBenchmarkFamily(family)) {
      sendJson(req, res, ctx, 400, { error: "invalid_family" });
      return true;
    }
    if (url.pathname.endsWith("/labels")) {
      sendJson(req, res, ctx, 200, { labels: await listDanBenchmarkLabels(ctx.db, family) });
    } else {
      sendJson(req, res, ctx, 200, { hidden: await listDanBenchmarkHiddenDiffs(ctx.db, family) });
    }
    return true;
  }
  if (url.pathname === "/api/admin/dan-benchmark/set-label" || url.pathname === "/api/admin/dan-benchmark/set-hidden") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const ok = url.pathname.endsWith("/set-label")
      ? await setDanBenchmarkLabel(ctx.serveWriteDb ?? ctx.db, body)
      : await setDanBenchmarkHiddenDiff(ctx.serveWriteDb ?? ctx.db, body);
    if (!ok) {
      sendJson(req, res, ctx, 400, { error: "invalid_payload" });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/dan-benchmark/import") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ labels?: []; hidden?: [] }>((await readBody(req)) || "{}", {});
    sendJson(req, res, ctx, 200, { ok: true, ...(await importDanBenchmark(ctx.serveWriteDb ?? ctx.db, body)) });
    return true;
  }
  if (url.pathname === "/api/admin/reset-local-db") {
    if (ctx.config.nodeEnv === "production") {
      sendJson(req, res, ctx, 403, { error: "disabled_in_production" });
      return true;
    }
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const tables = [
      "jobs",
      "score_events",
      "country_beatmap_scores",
      "country_beatmap_score_pbs",
      "country_beatmap_score_pb_state",
      "user_top_scores",
      "top_play_events",
      "snipe_events",
      "country_maps_snapshots",
      "farm_helper_user_key_stats",
      "replay_video_exports",
      "dan_estimates",
      "beatmap_skill_vectors",
      "player_activity_score_refs",
      "player_activity_days",
      "player_activity_maps",
      "player_activity_backfill_cursors",
      "live_event_log",
      "api_call_log",
      "live_meta",
      "country_rosters",
      "users",
      "beatmaps",
      "beatmapsets",
    ];
    const deleted: Record<string, number> = {};
    for (const table of tables) {
      deleted[table] = Number((await exec(ctx.serveWriteDb ?? ctx.db, `delete from ${table}`)).rowsAffected ?? 0);
    }
    sendJson(req, res, ctx, 200, { ok: true, deleted });
    return true;
  }
  return false;
}

interface DanClassifierDiff {
  beatmapId: number;
  beatmapsetId: number;
  version: string;
  starRating: number | null;
  keyCount: number | null;
  mode: string;
  cached: boolean;
}

// Set/diff metadata for the dan-classifier admin page, resolved purely from the
// local beatmaps/beatmapsets/beatmap_osu_files projections (no osu! API).
async function getDanClassifierSets(
  db: Db,
  beatmapsetIds: number[],
  beatmapIds: number[],
): Promise<{
  sets: Array<{ beatmapsetId: number; title: string | null; artist: string | null; diffs: DanClassifierDiff[] }>;
  missingBeatmapsetIds: number[];
  missingBeatmapIds: number[];
}> {
  const missingBeatmapIds: number[] = [];
  const setIds = new Set<number>(beatmapsetIds);

  if (beatmapIds.length) {
    const placeholders = beatmapIds.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmap_id, beatmapset_id from beatmaps where beatmap_id in (${placeholders})`,
      beatmapIds,
    )).rows;
    const found = new Map<number, number>();
    for (const row of rows) {
      found.set(Number(row.beatmap_id), Number(row.beatmapset_id));
    }
    for (const beatmapId of beatmapIds) {
      const setId = found.get(beatmapId);
      if (setId && setId > 0) setIds.add(setId);
      else missingBeatmapIds.push(beatmapId);
    }
  }

  const requestedSetIds = [...setIds];
  const diffsBySet = new Map<number, DanClassifierDiff[]>();
  if (requestedSetIds.length) {
    const placeholders = requestedSetIds.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select b.beatmap_id, b.beatmapset_id, b.version, b.difficulty_rating, b.cs, b.mode,
              case when f.beatmap_id is not null and (f.content_blob is not null or f.content != '') then 1 else 0 end as has_file
       from beatmaps b
       left join beatmap_osu_files f on f.beatmap_id = b.beatmap_id
       where b.beatmapset_id in (${placeholders}) and b.mode = 'mania'
       order by b.beatmapset_id, b.difficulty_rating`,
      requestedSetIds,
    )).rows;
    for (const row of rows) {
      const setId = Number(row.beatmapset_id);
      const diffs = diffsBySet.get(setId) ?? [];
      diffs.push({
        beatmapId: Number(row.beatmap_id),
        beatmapsetId: setId,
        version: row.version == null ? "" : String(row.version),
        starRating: row.difficulty_rating == null ? null : Number(row.difficulty_rating),
        keyCount: row.cs == null ? null : Number(row.cs),
        mode: String(row.mode ?? "mania"),
        cached: Number(row.has_file) === 1,
      });
      diffsBySet.set(setId, diffs);
    }
  }

  const meta = new Map<number, { title: string | null; artist: string | null }>();
  const setIdsWithDiffs = [...diffsBySet.keys()];
  if (setIdsWithDiffs.length) {
    const placeholders = setIdsWithDiffs.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select beatmapset_id, title, artist from beatmapsets where beatmapset_id in (${placeholders})`,
      setIdsWithDiffs,
    )).rows;
    for (const row of rows) {
      meta.set(Number(row.beatmapset_id), {
        title: row.title == null ? null : String(row.title),
        artist: row.artist == null ? null : String(row.artist),
      });
    }
  }

  return {
    sets: setIdsWithDiffs.map((setId) => ({
      beatmapsetId: setId,
      title: meta.get(setId)?.title ?? null,
      artist: meta.get(setId)?.artist ?? null,
      diffs: diffsBySet.get(setId) ?? [],
    })),
    missingBeatmapsetIds: requestedSetIds.filter((setId) => !diffsBySet.has(setId)),
    missingBeatmapIds,
  };
}
