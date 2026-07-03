import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveEventLog } from "../live/event-log.js";
import { getDisplayedAccuracy, getDisplayedRank, getModAcronyms, getScoreIdentity, getScoreSpeedBucket, isFullCombo, nowIso } from "../shared/score.js";
import type { ScoreSpeedBucket } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

// User goals: a logged-in player sets a target ("96% on map X", "reach 5000pp", "pass map Y",
// "land a 300pp play", "have 50 600pp+ plays") and it auto-completes the moment ingest sees a
// matching play or a stored projection already satisfies a "have" goal. Detection hooks straight
// into the score pipeline, so the magic is real-time. The owner is always the osu!-verified viewer
// id forwarded from the login cookie (see roster-self-track bridge); the browser never names a
// different user.

export type GoalKind = "reach_pp" | "play_pp" | "play_pp_count" | "accuracy" | "pass" | "grade" | "fc" | "reach_rank";
export type GoalStatus = "open" | "completed";
export type GoalSpeedBucket = ScoreSpeedBucket;

export const GOAL_KINDS: readonly GoalKind[] = ["reach_pp", "play_pp", "play_pp_count", "accuracy", "pass", "grade", "fc", "reach_rank"];
export const GOAL_MAP_KINDS: readonly GoalKind[] = ["accuracy", "pass", "grade", "fc"];
export const GOAL_TARGET_GRADES: readonly string[] = ["A", "S", "SS"];
export const GOAL_SPEED_BUCKETS: readonly GoalSpeedBucket[] = ["normal", "ht", "dt"];

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

function normalizeGoalSpeedBucket(value: unknown): GoalSpeedBucket | null {
  return GOAL_SPEED_BUCKETS.includes(value as GoalSpeedBucket) ? value as GoalSpeedBucket : null;
}

function goalSpeedBucket(goal: Pick<UserGoal | UserGoalInput, "speedBucket">): GoalSpeedBucket {
  return normalizeGoalSpeedBucket(goal.speedBucket) ?? "normal";
}

function scoreSpeedBucket(score: Pick<OscScore, "mods">): GoalSpeedBucket {
  return getScoreSpeedBucket(getModAcronyms(score.mods));
}

export interface UserGoalInput {
  userId: number;
  country: string | null;
  kind: GoalKind;
  beatmapId?: number | null;
  beatmapsetId?: number | null;
  beatmapLabel?: string | null;
  targetValue?: number | null;
  targetCount?: number | null;
  targetGrade?: string | null;
  speedBucket?: GoalSpeedBucket | null;
  note?: string | null;
}

export interface GoalProgress {
  /** Current value in the goal's own unit (pp, accuracy fraction, or grade ordinal). */
  current: number | null;
  target: number | null;
  /** 0-100 for a progress bar, or null when a bar doesn't apply (e.g. pass / grade goals). */
  pct: number | null;
  /** Human hint, e.g. "best 94.20%", "best A", "played 3x". */
  detail: string | null;
  /** Best grade letter so far on a grade goal's map (A/S/SS), for a best-vs-target badge row. */
  currentGrade?: string | null;
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
  targetCount: number | null;
  targetGrade: string | null;
  speedBucket: GoalSpeedBucket | null;
  /** Player's value in the goal's unit at the moment it was set; progress is measured from here. */
  startValue: number | null;
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
    targetCount: num(row.target_count),
    targetGrade: row.target_grade == null ? null : String(row.target_grade),
    speedBucket: normalizeGoalSpeedBucket(row.speed_bucket),
    startValue: num(row.start_value),
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

async function reopenInvalidMapGoalCompletions(db: Db, userId: number): Promise<boolean> {
  const rows = (await exec(
    db,
    `select g.id as goal_id, g.speed_bucket, se.score_json
     from user_goals g
     join score_events se
       on se.user_id = g.user_id
      and se.score_identity = g.completed_score_id
     where g.user_id = ?
       and g.status = 'completed'
       and g.kind in ('accuracy', 'pass', 'grade', 'fc')
       and g.completed_score_id is not null`,
    [userId],
  )).rows;
  const invalidGoalIds = new Set<string>();
  for (const row of rows) {
    const score = parseJson<OscScore | null>(row.score_json, null);
    const targetSpeed = normalizeGoalSpeedBucket(row.speed_bucket) ?? "normal";
    if (score && scoreSpeedBucket(score) !== targetSpeed) invalidGoalIds.add(String(row.goal_id));
  }
  if (invalidGoalIds.size === 0) return false;

  const now = Date.now();
  let reopened = false;
  for (const goalId of invalidGoalIds) {
    const res = await exec(
      db,
      `update user_goals
       set status = 'open',
           completed_at = null,
           completed_value = null,
           completed_score_id = null,
           completed_beatmap_id = null,
           updated_at = ?
       where id = ? and user_id = ? and status = 'completed'`,
      [now, goalId, userId],
    );
    if (res.rowsAffected > 0) reopened = true;
  }
  if (reopened) {
    noteGoalUserActive(userId);
    await bumpGoalIndexVersion(db).catch(() => {});
  }
  return reopened;
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
  /** First full-combo pass found; only resolvable from rows that still carry score_json. */
  fcContext: BeatmapHistoryContext | null;
}

/** The player's best passed result so far on one beatmap, with activity fallback for old rows. */
async function bestPassedOnBeatmap(db: Db, userId: number, beatmapId: number, speedBucket: GoalSpeedBucket = "normal"): Promise<BeatmapHistory> {
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
    fcContext: null,
  };

  const scoreRows = (await exec(
    db,
    `select score_identity, country, beatmap_id, score_json
     from score_events
     where user_id = ? and beatmap_id = ? and passed = 1
     order by ended_at desc
     limit 500`,
    [userId, beatmapId],
  )).rows;
  for (const row of scoreRows) {
    const score = parseJson<OscScore | null>(row.score_json, null);
    if (!score || scoreSpeedBucket(score) !== speedBucket) continue;
    const accuracy = getDisplayedAccuracy(score);
    const rank = getDisplayedRank(score);
    const rankValue = gradeRank(rank);
    const context = {
      value: null,
      scoreIdentity: row.score_identity == null ? null : String(row.score_identity),
      beatmapId: Number(row.beatmap_id ?? beatmapId),
      country: row.country == null ? null : String(row.country),
    };
    if (!history.passContext) history.passContext = { ...context, value: 1 };
    if (score && !history.fcContext && isFullCombo(score)) history.fcContext = { ...context, value: 1 };
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

  // score_events is retained short-term; player_activity_maps keeps older per-map play counts.
  // Activity rows are useful for "played" hints, but they are mod-blind. Do not let them prove
  // completion of base-rate map goals, because rate-changed scores would be indistinguishable.

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

  // profile_snapshots holds the cached best-100 from the player's profile, which can include a PB
  // that predates live tracking and isn't in user_top_scores yet. Without this source the "best so
  // far" hint on a play_pp goal would only reflect recently-seen plays (e.g. 798pp instead of 927).
  const snapshotRow = (await exec(db, "select best_scores_json from profile_snapshots where user_id = ?", [userId])).rows[0];
  for (const score of parseJson<OscScore[]>(snapshotRow?.best_scores_json, [])) {
    const pp = positivePp(score.pp);
    if (pp == null) continue;
    candidates.push({
      pp,
      scoreIdentity: officialScoreKey(score),
      beatmapId: score.beatmap_id ?? score.beatmap?.id ?? null,
      country: score.user?.country_code ?? null,
    });
  }

  return candidates
    .filter((candidate) => Number.isFinite(candidate.pp) && candidate.pp > 0)
    .sort((a, b) => b.pp - a.pp)[0] ?? null;
}

interface PpPlayCountSummary {
  count: number;
  bestPp: number | null;
  bestContext: GoalCompletionContext | null;
}

function officialScoreKey(score: Partial<Pick<OscScore, "id" | "legacy_score_id">>): string | null {
  const id = Number(score.legacy_score_id ?? score.id);
  return Number.isFinite(id) && id > 0 ? `official:${id}` : null;
}

function scoreKey(score: OscScore, fallback: string): string {
  return officialScoreKey(score) ?? fallback;
}

function positivePp(value: unknown): number | null {
  const pp = Number(value);
  return Number.isFinite(pp) && pp > 0 ? pp : null;
}

async function ppPlayCountSummary(db: Db, userId: number, threshold: number, extra?: { score: OscScore; country: string | null }): Promise<PpPlayCountSummary> {
  const seen = new Set<string>();
  let bestPp: number | null = null;
  let bestContext: GoalCompletionContext | null = null;

  const add = (key: string, pp: number | null, context: GoalCompletionContext): void => {
    if (pp == null || pp < threshold || seen.has(key)) return;
    seen.add(key);
    if (bestPp == null || pp > bestPp) {
      bestPp = pp;
      bestContext = context;
    }
  };

  const topRows = (await exec(
    db,
    "select score_id, pp, score_json from user_top_scores where user_id = ? and pp is not null and pp >= ?",
    [userId, threshold],
  )).rows;
  topRows.forEach((row, index) => {
    const pp = positivePp(row.pp);
    const score = parseJson<OscScore | null>(row.score_json, null);
    const scoreId = Number(row.score_id);
    const key = score
      ? scoreKey(score, Number.isFinite(scoreId) && scoreId > 0 ? `official:${scoreId}` : `top:${userId}:${index}`)
      : Number.isFinite(scoreId) && scoreId > 0 ? `official:${scoreId}` : `top:${userId}:${index}`;
    add(key, pp, {
      value: null,
      scoreIdentity: key.startsWith("official:") ? key : null,
      beatmapId: score?.beatmap_id ?? score?.beatmap?.id ?? null,
      country: score?.user?.country_code ?? null,
    });
  });

  const snapshotRow = (await exec(db, "select best_scores_json from profile_snapshots where user_id = ?", [userId])).rows[0];
  const snapshotScores = parseJson<OscScore[]>(snapshotRow?.best_scores_json, []);
  snapshotScores.forEach((score, index) => {
    const pp = positivePp(score.pp);
    const key = scoreKey(score, `profile:${userId}:${index}`);
    add(key, pp, {
      value: null,
      scoreIdentity: officialScoreKey(score),
      beatmapId: score.beatmap_id ?? score.beatmap?.id ?? null,
      country: score.user?.country_code ?? null,
    });
  });

  const eventRows = (await exec(
    db,
    "select pp, score_identity, beatmap_id, country, score_json from score_events where user_id = ? and pp is not null and pp >= ?",
    [userId, threshold],
  )).rows;
  eventRows.forEach((row, index) => {
    const pp = positivePp(row.pp);
    const score = parseJson<OscScore | null>(row.score_json, null);
    const storedIdentity = row.score_identity == null ? null : String(row.score_identity);
    const key = storedIdentity ?? (score ? scoreKey(score, `event:${userId}:${index}`) : `event:${userId}:${index}`);
    add(key, pp, {
      value: null,
      scoreIdentity: storedIdentity ?? officialScoreKey(score ?? {}),
      beatmapId: row.beatmap_id == null ? score?.beatmap_id ?? score?.beatmap?.id ?? null : Number(row.beatmap_id),
      country: row.country == null ? score?.user?.country_code ?? null : String(row.country),
    });
  });

  if (extra?.score) {
    const pp = positivePp(extra.score.pp);
    const identity = getScoreIdentity(extra.score);
    add(identity, pp, {
      value: null,
      scoreIdentity: identity,
      beatmapId: extra.score.beatmap_id ?? extra.score.beatmap?.id ?? null,
      country: extra.country ?? extra.score.user?.country_code ?? null,
    });
  }

  return { count: seen.size, bestPp, bestContext };
}

async function getUserPpAndCountry(db: Db, userId: number): Promise<{ pp: number; country: string | null }> {
  const row = (await exec(db, "select pp, country_code from users where user_id = ?", [userId])).rows[0];
  return {
    pp: Number(row?.pp ?? 0),
    country: row?.country_code ? String(row.country_code).toUpperCase() : null,
  };
}

// reach_rank carries its scope (global vs country leaderboard) in target_grade, since a rank goal
// never has a real grade. A null/other value means global.
function rankScopeOf(targetGrade: string | null): "global" | "country" {
  return targetGrade === "country" ? "country" : "global";
}

/** Player's current standing on the chosen leaderboard, or null when not yet tracked. */
async function getUserRank(db: Db, userId: number, scope: "global" | "country"): Promise<number | null> {
  const column = scope === "country" ? "country_rank" : "global_rank";
  const row = (await exec(db, `select ${column} as rank from users where user_id = ?`, [userId])).rows[0];
  const rank = row?.rank == null ? null : Number(row.rank);
  return rank != null && Number.isFinite(rank) && rank > 0 ? rank : null;
}

/** The player's best result so far on one beatmap, aggregated across their tracked days. */
async function bestOnBeatmap(db: Db, userId: number, beatmapId: number, speedBucket: GoalSpeedBucket = "normal"): Promise<{ acc: number | null; gradeRank: number; bestRank: string | null; plays: number }> {
  const history = await bestPassedOnBeatmap(db, userId, beatmapId, speedBucket);
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
    case "reach_rank": {
      const rank = await getUserRank(db, goal.userId, rankScopeOf(goal.targetGrade));
      if (goal.targetValue != null && rank != null && rank <= goal.targetValue) {
        const user = await getUserPpAndCountry(db, goal.userId);
        return { value: rank, scoreIdentity: null, beatmapId: null, country: user.country ?? goal.country };
      }
      return null;
    }
    case "play_pp": {
      // A single-play PP goal means "land another play worth this much from now", not "have ever
      // landed one". Historical PP milestones live in play_pp_count instead.
      return null;
    }
    case "play_pp_count": {
      if (goal.targetValue == null || goal.targetCount == null) return null;
      const summary = await ppPlayCountSummary(db, goal.userId, goal.targetValue);
      if (summary.count >= goal.targetCount) {
        return {
          value: summary.count,
          scoreIdentity: summary.bestContext?.scoreIdentity ?? null,
          beatmapId: summary.bestContext?.beatmapId ?? null,
          country: summary.bestContext?.country ?? goal.country,
        };
      }
      return null;
    }
    case "pass": {
      if (!goal.beatmapId) return null;
      const history = await bestPassedOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
      return history.passContext
        ? { ...history.passContext, country: history.passContext.country ?? goal.country }
        : null;
    }
    case "fc": {
      if (!goal.beatmapId) return null;
      const history = await bestPassedOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
      return history.fcContext
        ? { ...history.fcContext, country: history.fcContext.country ?? goal.country }
        : null;
    }
    case "accuracy": {
      if (!goal.beatmapId || goal.targetValue == null) return null;
      const history = await bestPassedOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
      return history.accuracyContext && history.bestAccuracy != null && history.bestAccuracy >= goal.targetValue
        ? { ...history.accuracyContext, country: history.accuracyContext.country ?? goal.country }
        : null;
    }
    case "grade": {
      if (!goal.beatmapId) return null;
      const history = await bestPassedOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
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
  if (kinds.some((kind) => GOAL_MAP_KINDS.includes(kind))) {
    await reopenInvalidMapGoalCompletions(db, userId).catch(() => {});
  }
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

/**
 * Progress from the baseline captured when the goal was set toward its target, as 0-99. Measuring
 * from the start (not absolute zero) means a "reach 15.5k" goal set at 15.1k begins near 0 instead
 * of 97%, and accuracy bars (which would otherwise cluster at ~99%) spread across the real gap.
 * Capped at 99: an open goal is by definition not yet complete, so it must never read 100.
 */
function pctTowards(start: number | null, current: number | null, target: number | null): number | null {
  if (current == null || target == null || target <= 0) return null;
  const base = start != null && start < target ? start : 0;
  if (target <= base) return null;
  const raw = ((current - base) / (target - base)) * 100;
  return Math.max(0, Math.min(99, Math.floor(raw)));
}

/** Like pctTowards but for ranks, where lower is better: climb from the start rank down to target. */
function pctTowardsRank(start: number | null, current: number | null, target: number | null): number | null {
  if (current == null || target == null || target <= 0) return null;
  if (start == null || start <= target) return null;
  const raw = ((start - current) / (start - target)) * 100;
  return Math.max(0, Math.min(99, Math.floor(raw)));
}

/** How close the player currently is to an open goal, for a progress bar + hint. Best-effort. */
export async function computeGoalProgress(db: Db, goal: UserGoal): Promise<GoalProgress> {
  switch (goal.kind) {
    case "reach_pp": {
      const pp = Number((await exec(db, "select pp from users where user_id = ?", [goal.userId])).rows[0]?.pp ?? 0);
      const target = goal.targetValue ?? 0;
      return { current: pp || null, target: target || null, pct: pctTowards(goal.startValue, pp || null, target || null), detail: pp ? `now ${Math.round(pp).toLocaleString()}pp` : null };
    }
    case "reach_rank": {
      const rank = await getUserRank(db, goal.userId, rankScopeOf(goal.targetGrade));
      const target = goal.targetValue ?? 0;
      return {
        current: rank,
        target: target || null,
        pct: pctTowardsRank(goal.startValue, rank, target || null),
        detail: rank != null ? `now #${Math.round(rank).toLocaleString()}` : "rank not tracked yet",
      };
    }
    case "play_pp": {
      const best = await bestSinglePpPlay(db, goal.userId);
      const bestPp = best?.pp ?? 0;
      const target = goal.targetValue ?? 0;
      return { current: bestPp || null, target: target || null, pct: null, detail: bestPp ? `best ${Math.round(bestPp)}pp` : null };
    }
    case "play_pp_count": {
      const targetPp = goal.targetValue ?? 0;
      const targetCount = goal.targetCount ?? 0;
      if (!(targetPp > 0) || !(targetCount > 0)) return { current: null, target: targetCount || null, pct: null, detail: null };
      const summary = await ppPlayCountSummary(db, goal.userId, targetPp);
      const pct = Math.max(0, Math.min(99, Math.floor((summary.count / targetCount) * 100)));
      return {
        current: summary.count,
        target: targetCount,
        pct,
        detail: `${Math.round(summary.bestPp ?? targetPp)}pp best`,
      };
    }
    case "accuracy": {
      if (!goal.beatmapId) return { current: null, target: goal.targetValue, pct: null, detail: null };
      const b = await bestOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
      const target = goal.targetValue ?? 0;
      // No baseline (older goal, or never played at creation) -> show the best-so-far hint with no
      // misleading bar rather than a near-full one, since raw acc/target always sits around 99%.
      return {
        current: b.acc,
        target: target || null,
        pct: goal.startValue != null ? pctTowards(goal.startValue, b.acc, target || null) : null,
        detail: b.acc != null ? `best ${(b.acc * 100).toFixed(2)}%` : b.plays ? `played ${b.plays}x` : "not played yet",
      };
    }
    case "grade": {
      if (!goal.beatmapId) return { current: null, target: null, pct: null, detail: null };
      const b = await bestOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
      const target = gradeRank(goal.targetGrade);
      // Grade is categorical: a percentage (A is 3/4 of S) reads as accuracy and confuses. Surface
      // the current best grade as the hint and let the card show best-vs-target badges instead.
      return {
        current: b.gradeRank >= 0 ? b.gradeRank : null,
        target: target >= 0 ? target : null,
        pct: null,
        detail: b.bestRank ? `best ${b.bestRank}` : b.plays ? `played ${b.plays}x` : "not played yet",
        currentGrade: b.bestRank,
      };
    }
    case "pass": {
      if (!goal.beatmapId) return { current: null, target: null, pct: null, detail: null };
      const b = await bestOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
      return { current: b.plays || null, target: null, pct: null, detail: b.plays ? `played ${b.plays}x, not passed` : "not played yet" };
    }
    case "fc": {
      if (!goal.beatmapId) return { current: null, target: null, pct: null, detail: null };
      const b = await bestOnBeatmap(db, goal.userId, goal.beatmapId, goalSpeedBucket(goal));
      return { current: b.plays || null, target: null, pct: null, detail: b.plays ? `played ${b.plays}x, no FC yet` : "not played yet" };
    }
    default:
      return { current: null, target: null, pct: null, detail: null };
  }
}

/** Goals list with per-open-goal progress attached (completed goals carry no progress). */
export async function listUserGoalsWithProgress(db: Db, userId: number): Promise<UserGoal[]> {
  await reopenInvalidMapGoalCompletions(db, userId).catch(() => {});
  const goals = await listUserGoals(db, userId);
  return Promise.all(goals.map(async (goal) => (goal.status === "open" ? { ...goal, progress: await computeGoalProgress(db, goal) } : goal)));
}

/** The player's current value in the goal's unit, captured so the progress bar climbs from here. */
async function goalStartValue(db: Db, input: UserGoalInput): Promise<number | null> {
  switch (input.kind) {
    case "reach_pp": {
      const { pp } = await getUserPpAndCountry(db, input.userId);
      return pp > 0 ? pp : null;
    }
    case "play_pp": {
      return null;
    }
    case "play_pp_count": {
      const target = input.targetValue ?? 0;
      if (!(target > 0)) return null;
      return (await ppPlayCountSummary(db, input.userId, target)).count;
    }
    case "accuracy": {
      if (!input.beatmapId) return null;
      return (await bestOnBeatmap(db, input.userId, input.beatmapId, goalSpeedBucket(input))).acc;
    }
    case "reach_rank":
      return getUserRank(db, input.userId, rankScopeOf(input.targetGrade ?? null));
    default:
      return null;
  }
}

export async function createUserGoal(db: Db, queue: JobQueue, input: UserGoalInput): Promise<UserGoal> {
  const id = randomUUID();
  const now = Date.now();
  const label = input.beatmapLabel ? input.beatmapLabel.slice(0, BEATMAP_LABEL_MAX) : null;
  const note = input.note ? input.note.slice(0, NOTE_MAX) : null;
  const startValue = await goalStartValue(db, input);
  await exec(
    db,
    `insert into user_goals
       (id, user_id, country, kind, beatmap_id, beatmapset_id, beatmap_label, target_value, target_count, target_grade, speed_bucket, start_value, note, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      id,
      input.userId,
      input.country,
      input.kind,
      input.beatmapId ?? null,
      input.beatmapsetId ?? null,
      label,
      input.targetValue ?? null,
      input.targetCount ?? null,
      input.targetGrade ?? null,
      GOAL_MAP_KINDS.includes(input.kind) ? goalSpeedBucket(input) : null,
      startValue,
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

export type UserGoalTargetPatch = Pick<UserGoalInput, "targetValue" | "targetCount" | "targetGrade" | "speedBucket">;

/**
 * Edit an open goal's targets in place, keeping its identity (kind, map) and creation history.
 * The progress baseline is preserved unless the edit changes what the baseline was measured
 * against (speed bucket on an accuracy goal, leaderboard scope on a rank goal, pp threshold on a
 * count goal) - in those cases it is recomputed so the bar doesn't climb from a stale reference.
 */
export async function updateUserGoal(db: Db, userId: number, goalId: string, patch: UserGoalTargetPatch): Promise<UserGoal | null> {
  const goal = await getUserGoal(db, goalId);
  if (!goal || goal.userId !== userId || goal.status !== "open") return null;
  const nextSpeed = GOAL_MAP_KINDS.includes(goal.kind) ? goalSpeedBucket(patch) : null;
  const next: UserGoalInput = {
    userId: goal.userId,
    country: goal.country,
    kind: goal.kind,
    beatmapId: goal.beatmapId,
    beatmapsetId: goal.beatmapsetId,
    beatmapLabel: goal.beatmapLabel,
    targetValue: patch.targetValue ?? null,
    targetCount: patch.targetCount ?? null,
    targetGrade: patch.targetGrade ?? null,
    speedBucket: nextSpeed,
  };
  const baselineChanged =
    (goal.kind === "accuracy" && goalSpeedBucket(goal) !== goalSpeedBucket(next)) ||
    (goal.kind === "reach_rank" && rankScopeOf(goal.targetGrade) !== rankScopeOf(next.targetGrade ?? null)) ||
    (goal.kind === "play_pp_count" && goal.targetValue !== next.targetValue);
  const startValue = baselineChanged ? await goalStartValue(db, next) : goal.startValue;
  const res = await exec(
    db,
    `update user_goals
     set target_value = ?, target_count = ?, target_grade = ?, speed_bucket = ?, start_value = ?, updated_at = ?
     where id = ? and user_id = ? and status = 'open'`,
    [next.targetValue ?? null, next.targetCount ?? null, next.targetGrade ?? null, nextSpeed, startValue, Date.now(), goalId, userId],
  );
  if (res.rowsAffected === 0) return null;
  return getUserGoal(db, goalId);
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
          targetCount: goal.targetCount,
          targetGrade: goal.targetGrade,
          speedBucket: goal.speedBucket,
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
 * play-shaped goals (pass / accuracy / grade on a specific map, "land an X pp play", or count a
 * stack of Xpp+ plays). Total-pp goals are handled separately because overall pp is not known at
 * ingest time. Map/accuracy/grade goals require a passed score, so a mid-map fail with
 * momentarily-high accuracy never counts.
 */
export async function evaluateScoreGoals(db: Db, events: LiveEventLog, score: OscScore, countries: string[]): Promise<void> {
  const userId = Number(score.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return;
  if (!await userMightHaveGoals(db, userId)) return;
  const rows = (await exec(db, "select * from user_goals where user_id = ? and status = 'open'", [userId])).rows;
  if (rows.length === 0) return;

  const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
  const passed = Boolean(score.passed);
  const speedBucket = scoreSpeedBucket(score);
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
    const speedMatched = speedBucket === goalSpeedBucket(goal);
    switch (goal.kind) {
      case "pass":
        if (speedMatched && goal.beatmapId === beatmapId && passed) {
          matched = true;
          value = 1;
        }
        break;
      case "fc":
        if (speedMatched && goal.beatmapId === beatmapId && isFullCombo(score)) {
          matched = true;
          value = 1;
        }
        break;
      case "accuracy":
        if (speedMatched && goal.beatmapId === beatmapId && passed && goal.targetValue != null && accuracy >= goal.targetValue) {
          matched = true;
          value = accuracy;
        }
        break;
      case "grade":
        if (speedMatched && goal.beatmapId === beatmapId && passed && achievedGrade >= gradeRank(goal.targetGrade)) {
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
      case "play_pp_count":
        if (pp != null && goal.targetValue != null && goal.targetCount != null && pp >= goal.targetValue) {
          const summary = await ppPlayCountSummary(db, userId, goal.targetValue, { score, country });
          if (summary.count >= goal.targetCount) {
            matched = true;
            value = summary.count;
          }
        }
        break;
      case "reach_pp":
        // total-pp goals are evaluated by evaluatePpGoals, not from a single score.
        break;
      case "reach_rank":
        // rank goals settle from stored user projections.
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

/**
 * Roster-refresh follow-up: the roster refresh is what lands fresh pp / rank projections for a
 * country's players, so it is the natural moment to settle their stat-shaped goals. Without this,
 * a "reach N total pp" goal whose crossing the top-play path missed (bonus pp is not in the
 * weighted top-200 total, and the stored pp may be stale at confirmation time) stays open until
 * the player happens to open the goals page.
 */
export async function reconcileStatGoalsForCountry(db: Db, events: LiveEventLog, country: string): Promise<void> {
  const rows = (await exec(
    db,
    `select distinct g.user_id as goal_user_id
     from user_goals g
     join country_rosters r on r.user_id = g.user_id and r.country = ?
     where g.status = 'open' and g.kind in ('reach_pp', 'reach_rank')`,
    [country.toUpperCase()],
  )).rows;
  for (const row of rows) {
    await reconcileGoalsForUser(db, events, Number(row.goal_user_id), ["reach_pp", "reach_rank"]).catch(() => {});
  }
}
