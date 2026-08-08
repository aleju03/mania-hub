import type { IncomingMessage, ServerResponse } from "node:http";
import { isGlobalCountry } from "../../countries.js";
import { parseJson } from "../../db.js";
import { clearFarmHelperFeedback, listFarmHelperFeedback, normalizeFarmHelperFeedbackSpeedBucket, normalizeFarmHelperFeedbackVerdict, setFarmHelperFeedback } from "../../features/farm-helper-feedback.js";
import { invalidateFarmHelperCacheForUser } from "../../features/farm-helper.js";
import { GOAL_KINDS, GOAL_MAP_KINDS, GOAL_SPEED_BUCKETS, GOAL_TARGET_GRADES, createUserGoal, deleteUserGoal, getUserGoal, listUserGoalsWithProgress, reconcileGoalsForUser, updateUserGoal, type GoalKind, type GoalSpeedBucket, type UserGoalInput, type UserGoalTargetPatch } from "../../features/goals.js";
import { getMyDataSummary, getUserTopPlaysFeed, getUserTrackedFeed } from "../../features/my-data.js";
import { getPlayerSkillBreakdown } from "../../features/player-skills.js";
import { decoratePlayerSkillBreakdown } from "../../features/skill-baseline.js";
import { addManualRosterMember, removeManualRosterMember } from "../../rosters/country-rosters.js";
import type { HttpContext } from "../context.js";
import { clampInteger, clampLimit, isAdmin, readBody } from "../request.js";
import { sendJson } from "../respond.js";
import { readMyDataTopPlaysQuery, readMyDataTrackedQuery } from "../snapshot-queries.js";

export async function handleUserDataRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/roster/self-add" || url.pathname === "/api/roster/self-remove") {
    // Admin-token gated: the frontend server fn forwards the osu!-verified viewer id with the
    // shared admin token (the pack-wallet pattern), so a user can only ever opt themselves in.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; country?: unknown }>((await readBody(req)) || "{}", {});
    const memberUserId = Number(body.userId);
    const memberCountry = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
    if (!Number.isInteger(memberUserId) || memberUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (!/^[A-Z]{2}$/.test(memberCountry) || isGlobalCountry(memberCountry)) {
      sendJson(req, res, ctx, 400, { error: "invalid_country" });
      return true;
    }
    const result = url.pathname === "/api/roster/self-remove"
      ? await removeManualRosterMember(ctx.serveWriteDb ?? ctx.db, memberCountry, memberUserId)
      : await addManualRosterMember(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.config, memberCountry, memberUserId);
    sendJson(req, res, ctx, result.ok ? 200 : 409, result);
    return true;
  }
  if (url.pathname === "/api/goals" || url.pathname === "/api/goals/create" || url.pathname === "/api/goals/update" || url.pathname === "/api/goals/delete") {
    // All goal endpoints are admin-token gated: the frontend server fn injects the osu!-verified
    // viewer id (the roster/pack-wallet bridge), so a user only ever reads or mutates their own
    // goals. The browser can never name a different user id here.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (url.pathname === "/api/goals") {
      if (req.method !== "GET") {
        sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
        return true;
      }
      const userId = Number(url.searchParams.get("userId"));
      if (!Number.isInteger(userId) || userId <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
        return true;
      }
      // Settle goals against stored projections before listing, so goals that were already satisfied
      // before creation (or while a split worker's in-memory goal index was stale) do not linger open.
      await reconcileGoalsForUser(ctx.serveWriteDb ?? ctx.db, ctx.events, userId).catch(() => {});
      sendJson(req, res, ctx, 200, { goals: await listUserGoalsWithProgress(ctx.db, userId) });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; id?: unknown; kind?: unknown; country?: unknown; beatmapId?: unknown; beatmapsetId?: unknown; beatmapLabel?: unknown; targetValue?: unknown; targetCount?: unknown; targetGrade?: unknown; speedBucket?: unknown; note?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (url.pathname === "/api/goals/delete") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        sendJson(req, res, ctx, 400, { error: "invalid_goal" });
        return true;
      }
      const ok = await deleteUserGoal(ctx.serveWriteDb ?? ctx.db, userId, id);
      sendJson(req, res, ctx, ok ? 200 : 404, { ok });
      return true;
    }
    if (url.pathname === "/api/goals/update") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        sendJson(req, res, ctx, 400, { error: "invalid_goal" });
        return true;
      }
      const existing = await getUserGoal(ctx.db, id);
      if (!existing || existing.userId !== userId || existing.status !== "open") {
        sendJson(req, res, ctx, 404, { ok: false, error: "goal_not_editable" });
        return true;
      }
      const targets = parseGoalTargets(existing.kind, body);
      if ("error" in targets) {
        sendJson(req, res, ctx, 400, { error: targets.error });
        return true;
      }
      const updated = await updateUserGoal(ctx.serveWriteDb ?? ctx.db, userId, id, targets.fields);
      if (!updated) {
        sendJson(req, res, ctx, 404, { ok: false, error: "goal_not_editable" });
        return true;
      }
      // A lowered target may already be satisfied by stored projections; settle it right away.
      await reconcileGoalsForUser(ctx.serveWriteDb ?? ctx.db, ctx.events, userId, [existing.kind]).catch(() => {});
      sendJson(req, res, ctx, 200, { ok: true, goal: (await getUserGoal(ctx.db, id)) ?? updated });
      return true;
    }
    // create
    const kind = String(body.kind ?? "") as GoalKind;
    if (!GOAL_KINDS.includes(kind)) {
      sendJson(req, res, ctx, 400, { error: "invalid_kind" });
      return true;
    }
    const rawCountry = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
    const input: UserGoalInput = { userId, country: /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null, kind };
    if (GOAL_MAP_KINDS.includes(kind)) {
      const beatmapId = Number(body.beatmapId);
      if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_beatmap" });
        return true;
      }
      input.beatmapId = beatmapId;
      const beatmapsetId = Number(body.beatmapsetId);
      input.beatmapsetId = Number.isInteger(beatmapsetId) && beatmapsetId > 0 ? beatmapsetId : null;
      input.beatmapLabel = typeof body.beatmapLabel === "string" ? body.beatmapLabel : null;
    }
    const targets = parseGoalTargets(kind, body);
    if ("error" in targets) {
      sendJson(req, res, ctx, 400, { error: targets.error });
      return true;
    }
    Object.assign(input, targets.fields);
    if (typeof body.note === "string") input.note = body.note;
    const created = await createUserGoal(ctx.serveWriteDb ?? ctx.db, ctx.queue, input);
    // A just-created goal may already be satisfied by the player's stored tracker/top-play data.
    await reconcileGoalsForUser(ctx.serveWriteDb ?? ctx.db, ctx.events, userId, [kind]).catch(() => {});
    sendJson(req, res, ctx, 200, { ok: true, goal: (await getUserGoal(ctx.db, created.id)) ?? created });
    return true;
  }
  if (url.pathname === "/api/farm-helper/feedback" || url.pathname === "/api/farm-helper/feedback/set" || url.pathname === "/api/farm-helper/feedback/clear") {
    // Same trust contract as the goals endpoints above: admin-token gated and
    // called server-to-server, with the frontend server fn injecting the
    // osu!-verified viewer id, so a user only ever touches their own marks.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (url.pathname === "/api/farm-helper/feedback") {
      if (req.method !== "GET") {
        sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
        return true;
      }
      const userId = Number(url.searchParams.get("userId"));
      if (!Number.isInteger(userId) || userId <= 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
        return true;
      }
      sendJson(req, res, ctx, 200, { marks: await listFarmHelperFeedback(ctx.db, userId) });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; beatmapId?: unknown; speedBucket?: unknown; verdict?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const beatmapId = Number(body.beatmapId);
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap" });
      return true;
    }
    const speedBucket = normalizeFarmHelperFeedbackSpeedBucket(body.speedBucket);
    if (!speedBucket) {
      sendJson(req, res, ctx, 400, { error: "invalid_speed_bucket" });
      return true;
    }
    if (url.pathname === "/api/farm-helper/feedback/clear") {
      await clearFarmHelperFeedback(ctx.serveWriteDb ?? ctx.db, userId, beatmapId, speedBucket);
      // Evict the per-subject snapshot cache on the serving Db: snapshots are
      // built and cached against ctx.db, not the write connection.
      invalidateFarmHelperCacheForUser(ctx.db, userId);
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    const verdict = normalizeFarmHelperFeedbackVerdict(body.verdict);
    if (!verdict) {
      sendJson(req, res, ctx, 400, { error: "invalid_verdict" });
      return true;
    }
    const result = await setFarmHelperFeedback(ctx.serveWriteDb ?? ctx.db, { userId, beatmapId, speedBucket, verdict });
    if (!result.ok) {
      // Active-mark cap: the module refuses NEW lanes past the cap (updates
      // and reactivations stay exempt); surface that as a client error.
      sendJson(req, res, ctx, 400, { error: result.reason });
      return true;
    }
    const { ok: _ok, ...mark } = result;
    void _ok;
    invalidateFarmHelperCacheForUser(ctx.db, userId);
    sendJson(req, res, ctx, 200, { ok: true, mark });
    return true;
  }
  if (url.pathname === "/api/my-data/summary") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getMyDataSummary(ctx.db, userId));
    return true;
  }
  if (url.pathname === "/api/my-data/dashboard") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const limit = clampLimit(url.searchParams.get("limit"), 12, 60);
    const trackedOffset = clampInteger(url.searchParams.get("trackedOffset"), 0, 1_000_000, 0);
    const topOffset = clampInteger(url.searchParams.get("topOffset"), 0, 1_000_000, 0);
    const summary = await getMyDataSummary(ctx.db, userId);
    const emptyTrackedPage = { items: [], total: 0, limit, offset: trackedOffset };
    const emptyTopPlayPage = { items: [], total: 0, limit, offset: topOffset };
    if (!summary.tracked) {
      sendJson(req, res, ctx, 200, { summary, trackedPage: emptyTrackedPage, topPlayPage: emptyTopPlayPage, skills: null });
      return true;
    }
    const [trackedPage, topPlayPage, skills] = await Promise.all([
      getUserTrackedFeed(ctx.db, userId, limit, trackedOffset),
      getUserTopPlaysFeed(ctx.db, userId, limit, topOffset),
      getPlayerSkillBreakdown(ctx.db, ctx.queue, userId)
        .then((breakdown) => decoratePlayerSkillBreakdown(ctx.db, userId, breakdown))
        .catch(() => null),
    ]);
    sendJson(req, res, ctx, 200, { summary, trackedPage, topPlayPage, skills });
    return true;
  }
  if (url.pathname === "/api/my-data/skills") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const breakdown = await getPlayerSkillBreakdown(ctx.db, ctx.queue, userId);
    sendJson(req, res, ctx, 200, await decoratePlayerSkillBreakdown(ctx.db, userId, breakdown));
    return true;
  }
  if (url.pathname === "/api/my-data/feed") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const limit = clampLimit(url.searchParams.get("limit"), 12, 60);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0);
    const page = await getUserTrackedFeed(ctx.db, userId, limit, offset, readMyDataTrackedQuery(url.searchParams));
    sendJson(req, res, ctx, 200, { scores: page.items, total: page.total, limit: page.limit, offset: page.offset });
    return true;
  }
  if (url.pathname === "/api/my-data/top-plays") {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const limit = clampLimit(url.searchParams.get("limit"), 12, 60);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0);
    const page = await getUserTopPlaysFeed(ctx.db, userId, limit, offset, readMyDataTopPlaysQuery(url.searchParams));
    sendJson(req, res, ctx, 200, { plays: page.items, total: page.total, limit: page.limit, offset: page.offset });
    return true;
  }
  return false;
}

/** Per-kind goal target validation shared by /api/goals/create and /api/goals/update. */
function parseGoalTargets(
  kind: GoalKind,
  body: { targetValue?: unknown; targetCount?: unknown; targetGrade?: unknown; speedBucket?: unknown },
): { error: string } | { fields: UserGoalTargetPatch } {
  const fields: UserGoalTargetPatch = {};
  if (GOAL_MAP_KINDS.includes(kind)) {
    const speedBucket = typeof body.speedBucket === "string" ? body.speedBucket.trim().toLowerCase() : "normal";
    if (!GOAL_SPEED_BUCKETS.includes(speedBucket as GoalSpeedBucket)) return { error: "invalid_speed_bucket" };
    fields.speedBucket = speedBucket as GoalSpeedBucket;
  }
  if (kind === "accuracy") {
    let target = Number(body.targetValue);
    // Accept either a fraction (0.96) or a percent (96); normalise to a 0-1 fraction.
    if (target > 1 && target <= 100) target = target / 100;
    if (!(target > 0 && target <= 1)) return { error: "invalid_target" };
    fields.targetValue = target;
  } else if (kind === "grade") {
    const grade = String(body.targetGrade ?? "").toUpperCase();
    if (!GOAL_TARGET_GRADES.includes(grade)) return { error: "invalid_grade" };
    fields.targetGrade = grade;
  } else if (kind === "play_pp_count") {
    const target = Number(body.targetValue);
    const count = Number(body.targetCount);
    if (!(target > 0) || !(Number.isInteger(count) && count > 0)) return { error: "invalid_target" };
    fields.targetValue = target;
    fields.targetCount = count;
  } else if (kind === "play_pp" || kind === "reach_pp") {
    const target = Number(body.targetValue);
    if (!(target > 0)) return { error: "invalid_target" };
    fields.targetValue = target;
  } else if (kind === "reach_rank") {
    const target = Number(body.targetValue);
    if (!(Number.isInteger(target) && target > 0)) return { error: "invalid_target" };
    fields.targetValue = target;
    // Scope (global vs country leaderboard) rides in target_grade, since a rank goal has no grade.
    fields.targetGrade = String(body.targetGrade ?? "global").toLowerCase() === "country" ? "country" : "global";
  }
  return { fields };
}
