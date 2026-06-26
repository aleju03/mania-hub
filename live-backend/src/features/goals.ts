import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveEventLog } from "../live/event-log.js";
import { getDisplayedAccuracy, getDisplayedRank, getScoreIdentity, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

// User goals: a logged-in player sets a target ("96% on map X", "reach 5000pp", "pass map Y",
// "land a 300pp play") and it auto-completes the moment ingest sees a matching play. Detection
// hooks straight into the score pipeline, so the magic is real-time. The owner is always the
// osu!-verified viewer id forwarded from the login cookie (see roster-self-track bridge); the
// browser never names a different user.

export type GoalKind = "reach_pp" | "play_pp" | "accuracy" | "pass" | "grade";
export type GoalStatus = "open" | "completed";

export const GOAL_KINDS: readonly GoalKind[] = ["reach_pp", "play_pp", "accuracy", "pass", "grade"];
export const GOAL_MAP_KINDS: readonly GoalKind[] = ["accuracy", "pass", "grade"];
export const GOAL_TARGET_GRADES: readonly string[] = ["A", "S", "SS"];

const BEATMAP_LABEL_MAX = 200;
const NOTE_MAX = 280;
const GOAL_INDEX_VERSION_KEY = "user_goals_changed_at";

// osu! grade letters mapped to an ordinal so "reach grade S" is satisfied by anything >= S.
// Silver variants (SH/XH) rank with their base letter; SS is the top.
const GRADE_RANK: Record<string, number> = { F: -1, D: 0, C: 1, B: 2, A: 3, S: 4, SH: 4, X: 5, XH: 5, SS: 5 };

function gradeRank(grade: string | null | undefined): number {
  if (!grade) return -1;
  return GRADE_RANK[grade.toUpperCase()] ?? -1;
}

export interface UserGoalInput {
  userId: number;
  country: string | null;
  kind: GoalKind;
  beatmapId?: number | null;
  beatmapsetId?: number | null;
  beatmapLabel?: string | null;
  targetValue?: number | null;
  targetGrade?: string | null;
  note?: string | null;
}

export interface GoalProgress {
  /** Current value in the goal's own unit (pp, accuracy fraction, or grade ordinal). */
  current: number | null;
  target: number | null;
  /** 0-100 for a progress bar, or null when a bar doesn't apply (e.g. pass goals). */
  pct: number | null;
  /** Human hint, e.g. "best 94.20%", "best A", "played 3x". */
  detail: string | null;
}

export interface UserGoal {
  id: string;
  userId: number;
  country: string | null;
  kind: GoalKind;
  beatmapId: number | null;
  beatmapsetId: number | null;
  beatmapLabel: string | null;
  targetValue: number | null;
  targetGrade: string | null;
  note: string | null;
  status: GoalStatus;
  createdAt: number;
  completedAt: number | null;
  completedValue: number | null;
  completedScoreId: string | null;
  completedBeatmapId: number | null;
  /** Present on open goals from the progress-aware list; how close the player currently is. */
  progress?: GoalProgress;
}

interface GoalCompletionContext {
  value: number | null;
  scoreIdentity: string | null;
  beatmapId: number | null;
  country: string | null;
}

function rowToGoal(row: Record<string, unknown>): UserGoal {
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    country: row.country == null ? null : String(row.country),
    kind: String(row.kind) as GoalKind,
    beatmapId: num(row.beatmap_id),
    beatmapsetId: num(row.beatmapset_id),
    beatmapLabel: row.beatmap_label == null ? null : String(row.beatmap_label),
    targetValue: num(row.target_value),
    targetGrade: row.target_grade == null ? null : String(row.target_grade),
    note: row.note == null ? null : String(row.note),
    status: String(row.status) as GoalStatus,
    createdAt: Number(row.created_at),
    completedAt: num(row.completed_at),
    completedValue: num(row.completed_value),
    completedScoreId: row.completed_score_id == null ? null : String(row.completed_score_id),
    completedBeatmapId: num(row.completed_beatmap_id),
  };
}

// Negative cache so the ingest hot path skips loading goal rows for the overwhelming majority of
// players who have no goals. `null` = not loaded yet (fall back to querying). Split server/worker
// topology learns about cross-process mutations through a live_meta version marker plus a periodic
// refresh as a backup.
let goalUserIds: Set<number> | null = null;
let goalIndexVersion: string | null = null;

async function readGoalIndexVersion(db: Db): Promise<string | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [GOAL_INDEX_VERSION_KEY])).rows[0];
  return row?.value_json == null ? null : String(row.value_json);
}

async function bumpGoalIndexVersion(db: Db): Promise<void> {
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [GOAL_INDEX_VERSION_KEY, JSON.stringify({ at: Date.now(), nonce: randomUUID() }), nowIso()],
  );
}

export async function refreshGoalUserIndex(db: Db): Promise<void> {
  const rows = (await exec(db, "select distinct user_id from user_goals where status = 'open'")).rows;
  goalUserIds = new Set(rows.map((r) => Number(r.user_id)));
  goalIndexVersion = await readGoalIndexVersion(db);
}

export function noteGoalUserActive(userId: number): void {
  if (goalUserIds) goalUserIds.add(userId);
}

async function syncGoalUserIndexIfChanged(db: Db): Promise<void> {
  if (goalUserIds === null) return;
  const version = await readGoalIndexVersion(db);
  if (version !== goalIndexVersion) {
    await refreshGoalUserIndex(db);
  }
}

async function userMightHaveGoals(db: Db, userId: number): Promise<boolean> {
  await syncGoalUserIndexIfChanged(db);
  return goalUserIds === null || goalUserIds.has(userId);
}

export function startGoalUserIndexRefresh(db: Db, intervalMs = 30_000): () => void {
  void refreshGoalUserIndex(db).catch(() => {});
  const timer = setInterval(() => {
    void refreshGoalUserIndex(db).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

async function dropFromIndexIfDone(db: Db, userId: number): Promise<void> {
  if (!goalUserIds) return;
  const remaining = (await exec(db, "select 1 from user_goals where user_id = ? and status = 'open' limit 1", [userId])).rows[0];
  if (!remaining) goalUserIds.delete(userId);
}

export async function getUserGoal(db: Db, goalId: string): Promise<UserGoal | null> {
  const row = (await exec(db, "select * from user_goals where id = ?", [goalId])).rows[0];
  return row ? rowToGoal(row as Record<string, unknown>) : null;
}

export async function listUserGoals(db: Db, userId: number): Promise<UserGoal[]> {
  const rows = (await exec(
    db,
    `select * from user_goals where user_id = ?
     order by case when status = 'open' then 0 else 1 end, coalesce(completed_at, created_at) desc`,
    [userId],
  )).rows;
  return rows.map((r) => rowToGoal(r as Record<string, unknown>));
}

interface BeatmapHistoryContext {
  value: number | null;
  scoreIdentity: string | null;
  beatmapId: number;
  country: string | null;
}

interface BeatmapHistory {
  plays: number;
  bestAccuracy: number | null;
  bestRank: string | null;
  bestGradeRank: number;
  passContext: BeatmapHistoryContext | null;
  accuracyContext: BeatmapHistoryContext | null;
  gradeContext: BeatmapHistoryContext | null;
}

/** The player's best passed result so far on one beatmap, with activity fallback for old rows. */
async function bestPassedOnBeatmap(db: Db, userId: number, beatmapId: number): Promise<BeatmapHistory> {
  const activityRows = (await exec(
    db,
    "select best_accuracy, best_rank, play_count, country from player_activity_maps where user_id = ? and beatmap_id = ?",
    [userId, beatmapId],
  )).rows;
  const plays = activityRows.reduce((sum, row) => sum + Number(row.play_count ?? 0), 0);
  const history: BeatmapHistory = {
    plays,
    bestAccuracy: null,
    bestRank: null,
    bestGradeRank: -1,
    passContext: null,
    accuracyContext: null,
    gradeContext: null,
  };

  const scoreRows = (await exec(
    db,
    `select score_identity, country, beatmap_id, accuracy, rank, score_json
     from score_events
     where user_id = ? and beatmap_id = ? and passed = 1
     order by ended_at desc
     limit 500`,
    [userId, beatmapId],
  )).rows;
  for (const row of scoreRows) {
    const score = parseJson<OscScore | null>(row.score_json, null);
    const accuracy = score ? getDisplayedAccuracy(score) : Number(row.accuracy ?? 0);
    const rank = score ? getDisplayedRank(score) : String(row.rank ?? "");
    const rankValue = gradeRank(rank);
    const context = {
      value: null,
      scoreIdentity: row.score_identity == null ? null : String(row.score_identity),
      beatmapId: Number(row.beatmap_id ?? beatmapId),
      country: row.country == null ? null : String(row.country),
    };
    if (!history.passContext) history.passContext = { ...context, value: 1 };
    if (Number.isFinite(accuracy) && (history.bestAccuracy == null || accuracy > history.bestAccuracy)) {
      history.bestAccuracy = accuracy;
      history.accuracyContext = { ...context, value: accuracy };
    }
    if (rankValue > history.bestGradeRank) {
      history.bestGradeRank = rankValue;
      history.bestRank = rank;
      history.gradeContext = { ...context, value: rankValue };
    }
  }

  // score_events is retained short-term; player_activity_maps keeps older per-map bests.
  for (const row of activityRows) {
    const rank = row.best_rank == null ? null : String(row.best_rank);
    const rankValue = gradeRank(rank);
    if (rankValue < 0) continue;
    const country = row.country == null ? null : String(row.country);
    const accuracy = row.best_accuracy == null ? null : Number(row.best_accuracy);
    if (!history.passContext) history.passContext = { value: 1, scoreIdentity: null, beatmapId, country };
    if (accuracy != null && Number.isFinite(accuracy) && (history.bestAccuracy == null || accuracy > history.bestAccuracy)) {
      history.bestAccuracy = accuracy;
      history.accuracyContext = { value: accuracy, scoreIdentity: null, beatmapId, country };
    }
    if (rankValue > history.bestGradeRank) {
      history.bestGradeRank = rankValue;
      history.bestRank = rank;
      history.gradeContext = { value: rankValue, scoreIdentity: null, beatmapId, country };
    }
  }

  return history;
}

async function bestSinglePpPlay(db: Db, userId: number): Promise<{ pp: number; scoreIdentity: string | null; beatmapId: number | null; country: string | null } | null> {
  const trackedRow = (await exec(
    db,
    `select pp, score_identity, beatmap_id, country
     from score_events
     where user_id = ? and pp is not null
     order by pp desc
     limit 1`,
    [userId],
  )).rows[0];
  const topRow = (await exec(
    db,
    "select pp, score_id, score_json from user_top_scores where user_id = ? and pp is not null order by pp desc limit 1",
    [userId],
  )).rows[0];

  const candidates: Array<{ pp: number; scoreIdentity: string | null; beatmapId: number | null; country: string | null }> = [];
  if (trackedRow) {
    candidates.push({
      pp: Number(trackedRow.pp),
      scoreIdentity: trackedRow.score_identity == null ? null : String(trackedRow.score_identity),
      beatmapId: trackedRow.beatmap_id == null ? null : Number(trackedRow.beatmap_id),
      country: trackedRow.country == null ? null : String(trackedRow.country),
    });
  }
  if (topRow) {
    const score = parseJson<OscScore | null>(topRow.score_json, null);
    const scoreId = Number(topRow.score_id);
    candidates.push({
      pp: Number(topRow.pp),
      scoreIdentity: Number.isFinite(scoreId) && scoreId > 0 ? `official:${scoreId}` : null,
      beatmapId: score?.beatmap_id ?? score?.beatmap?.id ?? null,
      country: score?.user?.country_code ?? null,
    });
  }

  return candidates
    .filter((candidate) => Number.isFinite(candidate.pp) && candidate.pp > 0)
    .sort((a, b) => b.pp - a.pp)[0] ?? null;
}

async function getUserPpAndCountry(db: Db, userId: number): Promise<{ pp: number; country: string | null }> {
  const row = (await exec(db, "select pp, country_code from users where user_id = ?", [userId])).rows[0];
  return {
    pp: Number(row?.pp ?? 0),
    country: row?.country_code ? String(row.country_code).toUpperCase() : null,
  };
}

/** The player's best result so far on one beatmap, aggregated across their tracked days. */
async function bestOnBeatmap(db: Db, userId: number, beatmapId: number): Promise<{ acc: number | null; gradeRank: number; bestRank: string | null; plays: number }> {
  const history = await bestPassedOnBeatmap(db, userId, beatmapId);
  return {
    acc: history.bestAccuracy,
    gradeRank: history.bestGradeRank,
    bestRank: history.bestRank,
    plays: history.plays,
  };
}

async function historicalCompletionForGoal(db: Db, goal: UserGoal): Promise<GoalCompletionContext | null> {
  switch (goal.kind) {
    case "reach_pp": {
      const user = await getUserPpAndCountry(db, goal.userId);
      if (goal.targetValue != null && user.pp > 0 && user.pp >= goal.targetValue) {
        return { value: user.pp, scoreIdentity: null, beatmapId: null, country: user.country ?? goal.country };
      }
      return null;
    }
    case "play_pp": {
      const best = await bestSinglePpPlay(db, goal.userId);
      if (best && goal.targetValue != null && best.pp >= goal.targetValue) {
        return { value: best.pp, scoreIdentity: best.scoreIdentity, beatmapId: best.beatmapId, country: best.country ?? goal.country };
      }
      return null;
    }
    case "pass": {
      if (!goal.beatmapId) return null;
      const history = await bestPassedOnBeatmap(db, goal.userId, goal.beatmapId);
      return history.passContext
        ? { ...history.passContext, country: history.passContext.country ?? goal.country }
        : null;
    }
    case "accuracy": {
      if (!goal.beatmapId || goal.targetValue == null) return null;
      const history = await bestPassedOnBeatmap(db, goal.userId, goal.beatmapId);
      return history.accuracyContext && history.bestAccuracy != null && history.bestAccuracy >= goal.targetValue
        ? { ...history.accuracyContext, country: history.accuracyContext.country ?? goal.country }
        : null;
    }
    case "grade": {
      if (!goal.beatmapId) return null;
      const history = await bestPassedOnBeatmap(db, goal.userId, goal.beatmapId);
      const target = gradeRank(goal.targetGrade);
      return target >= 0 && history.gradeContext && history.bestGradeRank >= target
        ? { ...history.gradeContext, country: history.gradeContext.country ?? goal.country }
        : null;
    }
    default:
      return null;
  }
}

export async function reconcileGoalsForUser(db: Db, events: LiveEventLog, userId: number, kinds: readonly GoalKind[] = GOAL_KINDS): Promise<void> {
  if (!await userMightHaveGoals(db, userId)) return;
  const placeholders = kinds.map(() => "?").join(",") || "null";
  const rows = (await exec(
    db,
    `select * from user_goals where user_id = ? and status = 'open' and kind in (${placeholders})`,
    [userId, ...kinds],
  )).rows;
  if (rows.length === 0) return;

  let anyCompleted = false;
  for (const raw of rows) {
    const goal = rowToGoal(raw as Record<string, unknown>);
    const ctx = await historicalCompletionForGoal(db, goal);
    if (ctx && await completeGoal(db, events, goal, ctx)) anyCompleted = true;
  }
  if (anyCompleted) await dropFromIndexIfDone(db, userId);
}

function pctOf(current: number, target: number): number | null {
  return target > 0 ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : null;
}

/** How close the player currently is to an open goal, for a progress bar + hint. Best-effort. */
export async function computeGoalProgress(db: Db, goal: UserGoal): Promise<GoalProgress> {
  switch (goal.kind) {
    case "reach_pp": {
      const pp = Number((await exec(db, "select pp from users where user_id = ?", [goal.userId])).rows[0]?.pp ?? 0);
      const target = goal.targetValue ?? 0;
      return { current: pp || null, target: target || null, pct: pp && target ? pctOf(pp, target) : null, detail: pp ? `now ${Math.round(pp).toLocaleString()}pp` : null };
    }
    case "play_pp": {
      const best = Number((await exec(db, "select max(pp) as pp from user_top_scores where user_id = ?", [goal.userId])).rows[0]?.pp ?? 0);
      const target = goal.targetValue ?? 0;
      return { current: best || null, target: target || null, pct: best && target ? pctOf(best, target) : null, detail: best ? `best ${Math.round(best)}pp` : null };
    }
    case "accuracy": {
      if (!goal.beatmapId) return { current: null, target: goal.targetValue, pct: null, detail: null };
      const b = await bestOnBeatmap(db, goal.userId, goal.beatmapId);
      const target = goal.targetValue ?? 0;
      return {
        current: b.acc,
        target: target || null,
        pct: b.acc != null && target ? pctOf(b.acc, target) : b.plays ? 0 : null,
        detail: b.acc != null ? `best ${(b.acc * 100).toFixed(2)}%` : b.plays ? `played ${b.plays}x` : "not played yet",
      };
    }
    case "grade": {
      if (!goal.beatmapId) return { current: null, target: null, pct: null, detail: null };
      const b = await bestOnBeatmap(db, goal.userId, goal.beatmapId);
      const target = gradeRank(goal.targetGrade);
      return {
        current: b.gradeRank >= 0 ? b.gradeRank : null,
        target: target >= 0 ? target : null,
        pct: b.gradeRank >= 0 && target > 0 ? pctOf(b.gradeRank, target) : b.plays ? 0 : null,
        detail: b.bestRank ? `best ${b.bestRank}` : b.plays ? `played ${b.plays}x` : "not played yet",
      };
    }
    case "pass": {
      if (!goal.beatmapId) return { current: null, target: null, pct: null, detail: null };
      const b = await bestOnBeatmap(db, goal.userId, goal.beatmapId);
      return { current: b.plays || null, target: null, pct: null, detail: b.plays ? `played ${b.plays}x, not passed` : "not played yet" };
    }
    default:
      return { current: null, target: null, pct: null, detail: null };
  }
}

/** Goals list with per-open-goal progress attached (completed goals carry no progress). */
export async function listUserGoalsWithProgress(db: Db, userId: number): Promise<UserGoal[]> {
  const goals = await listUserGoals(db, userId);
  return Promise.all(goals.map(async (goal) => (goal.status === "open" ? { ...goal, progress: await computeGoalProgress(db, goal) } : goal)));
}

export async function createUserGoal(db: Db, queue: JobQueue, input: UserGoalInput): Promise<UserGoal> {
  const id = randomUUID();
  const now = Date.now();
  const label = input.beatmapLabel ? input.beatmapLabel.slice(0, BEATMAP_LABEL_MAX) : null;
  const note = input.note ? input.note.slice(0, NOTE_MAX) : null;
  await exec(
    db,
    `insert into user_goals
       (id, user_id, country, kind, beatmap_id, beatmapset_id, beatmap_label, target_value, target_grade, note, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      id,
      input.userId,
      input.country,
      input.kind,
      input.beatmapId ?? null,
      input.beatmapsetId ?? null,
      label,
      input.targetValue ?? null,
      input.targetGrade ?? null,
      note,
      now,
      now,
    ],
  );
  noteGoalUserActive(input.userId);
  // Map-scoped goals match by beatmap id, but enriching the map keeps display metadata fresh and
  // is cheap (dedupes on its key). Best-effort: a goal is fully functional without it.
  if (GOAL_MAP_KINDS.includes(input.kind) && input.beatmapId) {
    await queue.enqueue("enrich_beatmap", `beatmap:${input.beatmapId}`, { beatmapId: input.beatmapId }, { priority: 80 }).catch(() => {});
  }
  await bumpGoalIndexVersion(db).catch(() => {});
  const goal = await getUserGoal(db, id);
  if (!goal) throw new Error("failed to read back created goal");
  return goal;
}

export async function deleteUserGoal(db: Db, userId: number, goalId: string): Promise<boolean> {
  const res = await exec(db, "delete from user_goals where id = ? and user_id = ?", [goalId, userId]);
  const ok = res.rowsAffected > 0;
  if (ok) {
    await bumpGoalIndexVersion(db).catch(() => {});
    await dropFromIndexIfDone(db, userId);
  }
  return ok;
}

async function completeGoal(db: Db, events: LiveEventLog, goal: UserGoal, ctx: GoalCompletionContext): Promise<boolean> {
  const now = Date.now();
  // Guard on status = 'open' so two concurrent ingest paths can't double-complete / double-emit.
  const res = await exec(
    db,
    `update user_goals
       set status = 'completed', completed_at = ?, completed_value = ?, completed_score_id = ?, completed_beatmap_id = ?, updated_at = ?
     where id = ? and status = 'open'`,
    [now, ctx.value, ctx.scoreIdentity, ctx.beatmapId, now, goal.id],
  );
  if (res.rowsAffected === 0) return false;
  if (ctx.country) {
    await events
      .append(
        "goal_completed",
        ctx.country,
        {
          userId: goal.userId,
          goalId: goal.id,
          kind: goal.kind,
          beatmapId: ctx.beatmapId,
          beatmapLabel: goal.beatmapLabel,
          targetValue: goal.targetValue,
          targetGrade: goal.targetGrade,
          value: ctx.value,
          completedAt: now,
        },
        `goal_completed:${goal.id}`,
      )
      .catch(() => {});
  }
  return true;
}

/**
 * Score-triggered evaluation: called from ingest for every inserted score. Completes the
 * play-shaped goals (pass / accuracy / grade on a specific map, or "land an X pp play"). Total-pp
 * goals are handled separately because overall pp is not known at ingest time. Map/accuracy/grade
 * goals require a passed score, so a mid-map fail with momentarily-high accuracy never counts.
 */
export async function evaluateScoreGoals(db: Db, events: LiveEventLog, score: OscScore, countries: string[]): Promise<void> {
  const userId = Number(score.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return;
  if (!await userMightHaveGoals(db, userId)) return;
  const rows = (await exec(db, "select * from user_goals where user_id = ? and status = 'open'", [userId])).rows;
  if (rows.length === 0) return;

  const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
  const passed = Boolean(score.passed);
  const accuracy = getDisplayedAccuracy(score);
  const achievedGrade = gradeRank(getDisplayedRank(score));
  const pp = score.pp ?? null;
  const country = countries[0] ?? score.user?.country_code ?? null;
  const scoreIdentity = getScoreIdentity(score);

  let anyCompleted = false;
  for (const raw of rows) {
    const goal = rowToGoal(raw as Record<string, unknown>);
    let matched = false;
    let value: number | null = null;
    switch (goal.kind) {
      case "pass":
        if (goal.beatmapId === beatmapId && passed) {
          matched = true;
          value = 1;
        }
        break;
      case "accuracy":
        if (goal.beatmapId === beatmapId && passed && goal.targetValue != null && accuracy >= goal.targetValue) {
          matched = true;
          value = accuracy;
        }
        break;
      case "grade":
        if (goal.beatmapId === beatmapId && passed && achievedGrade >= gradeRank(goal.targetGrade)) {
          matched = true;
          value = achievedGrade;
        }
        break;
      case "play_pp":
        if (pp != null && goal.targetValue != null && pp >= goal.targetValue) {
          matched = true;
          value = pp;
        }
        break;
      case "reach_pp":
        // total-pp goals are evaluated by evaluatePpGoals, not from a single score.
        break;
    }
    if (matched && (await completeGoal(db, events, goal, { value, scoreIdentity, beatmapId: goal.beatmapId ?? beatmapId, country }))) {
      anyCompleted = true;
    }
  }
  if (anyCompleted) await dropFromIndexIfDone(db, userId);
}

/**
 * Total-pp evaluation: complete "reach N pp" goals when the player's observed overall pp crosses
 * the target. Driven from top-play confirmation (a fresh top play is what moves overall pp) using
 * the weighted top-200 total, and lazily from the goals read endpoint against the stored pp.
 */
export async function evaluatePpGoals(db: Db, events: LiveEventLog, userId: number, observedPp: number, country: string | null): Promise<void> {
  if (!Number.isInteger(userId) || userId <= 0) return;
  if (!Number.isFinite(observedPp) || observedPp <= 0) return;
  if (!await userMightHaveGoals(db, userId)) return;
  const rows = (await exec(db, "select * from user_goals where user_id = ? and status = 'open' and kind = 'reach_pp'", [userId])).rows;
  if (rows.length === 0) return;
  let anyCompleted = false;
  for (const raw of rows) {
    const goal = rowToGoal(raw as Record<string, unknown>);
    if (goal.targetValue != null && observedPp >= goal.targetValue) {
      if (await completeGoal(db, events, goal, { value: observedPp, scoreIdentity: null, beatmapId: null, country: country ?? goal.country })) {
        anyCompleted = true;
      }
    }
  }
  if (anyCompleted) await dropFromIndexIfDone(db, userId);
}

/** Lazy safety-net: reconcile reach_pp goals against the stored overall pp (e.g. opened the page). */
export async function reconcilePpGoalsForUser(db: Db, events: LiveEventLog, userId: number): Promise<void> {
  await reconcileGoalsForUser(db, events, userId, ["reach_pp"]);
}
