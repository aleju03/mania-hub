import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { getModAcronyms, getScoreSpeedBucket, nowIso, type ScoreSpeedBucket } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

// Per-player farm-helper feedback: a player marks one recommendation lane
// (beatmap + speed bucket) as "too hard" or "too easy", and the rec builder
// trusts that over its own models (farm-helper.ts threads the active marks
// through scoring). A mark retires ("resolves") the moment a real score lands
// on the lane after it was set: the play is better evidence than the label.
// The owner is always the osu!-verified viewer id forwarded from the login
// cookie (the goals/pack-wallet trust contract); the browser never names a
// different user. This module owns only the table; the snapshot-cache eviction
// lives in farm-helper.ts (which owns the cache) and is called by the HTTP
// handlers and the ingest hook alongside these writes.

export type FarmHelperFeedbackVerdict = "too_hard" | "too_easy";

export const FARM_HELPER_FEEDBACK_VERDICTS: readonly FarmHelperFeedbackVerdict[] = ["too_hard", "too_easy"];
// The farm helper's real lane buckets: recs carry ScoreSpeedBucket values
// (see farmHelperLaneKey / FarmHelperRec.speedBucket in farm-helper.ts).
export const FARM_HELPER_FEEDBACK_SPEED_BUCKETS: readonly ScoreSpeedBucket[] = ["normal", "ht", "dt"];

const FEEDBACK_LIST_LIMIT = 500;
// Hard ceiling on one user's active (unresolved) marks: a new mark past the cap
// is refused instead of written, so a scripted client cannot grow the table
// (and the rec builder's per-user scan) without bound. Updates, verdict flips
// and reactivations of existing rows are exempt because they add no rows.
export const FARM_HELPER_FEEDBACK_ACTIVE_MARK_CAP = 500;
const FEEDBACK_INDEX_VERSION_KEY = "farm_helper_feedback_changed_at";

export interface FarmHelperFeedbackMark {
  beatmapId: number;
  speedBucket: ScoreSpeedBucket;
  verdict: FarmHelperFeedbackVerdict;
  createdAt: number;
  resolvedAt: number | null;
  resolvedPp: number | null;
}

// An active (unresolved) mark as the rec builder consumes it.
export interface ActiveFarmHelperFeedbackMark {
  beatmapId: number;
  speedBucket: ScoreSpeedBucket;
  verdict: FarmHelperFeedbackVerdict;
  createdAt: number;
}

export interface FarmHelperFeedbackInput {
  userId: number;
  beatmapId: number;
  speedBucket: ScoreSpeedBucket;
  verdict: FarmHelperFeedbackVerdict;
}

export function normalizeFarmHelperFeedbackVerdict(value: unknown): FarmHelperFeedbackVerdict | null {
  return FARM_HELPER_FEEDBACK_VERDICTS.includes(value as FarmHelperFeedbackVerdict)
    ? value as FarmHelperFeedbackVerdict
    : null;
}

export function normalizeFarmHelperFeedbackSpeedBucket(value: unknown): ScoreSpeedBucket | null {
  return FARM_HELPER_FEEDBACK_SPEED_BUCKETS.includes(value as ScoreSpeedBucket)
    ? value as ScoreSpeedBucket
    : null;
}

function rowToMark(row: Record<string, unknown>): FarmHelperFeedbackMark {
  return {
    beatmapId: Number(row.beatmap_id),
    speedBucket: String(row.speed_bucket) as ScoreSpeedBucket,
    verdict: String(row.verdict) as FarmHelperFeedbackVerdict,
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    resolvedPp: row.resolved_pp == null ? null : Number(row.resolved_pp),
  };
}

// Negative cache so the ingest hot path skips a table lookup for the
// overwhelming majority of players with no marks. Same shape as the goals
// index: `null` = not loaded yet (fall back to querying), a live_meta version
// marker plus a periodic refresh cover split server/worker mutations.
let feedbackUserIds: Set<number> | null = null;
let feedbackIndexVersion: string | null = null;

async function readFeedbackIndexVersion(db: Db): Promise<string | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [FEEDBACK_INDEX_VERSION_KEY])).rows[0];
  return row?.value_json == null ? null : String(row.value_json);
}

export async function bumpFarmHelperFeedbackVersion(db: Db): Promise<void> {
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [FEEDBACK_INDEX_VERSION_KEY, JSON.stringify({ at: Date.now(), nonce: randomUUID() }), nowIso()],
  );
}

export async function refreshFarmHelperFeedbackUserIndex(db: Db): Promise<void> {
  const rows = (await exec(db, "select distinct user_id from farm_helper_feedback where resolved_at is null")).rows;
  feedbackUserIds = new Set(rows.map((r) => Number(r.user_id)));
  feedbackIndexVersion = await readFeedbackIndexVersion(db);
}

export function noteFarmHelperFeedbackUserActive(userId: number): void {
  if (feedbackUserIds) feedbackUserIds.add(userId);
}

async function syncFeedbackUserIndexIfChanged(db: Db): Promise<void> {
  if (feedbackUserIds === null) return;
  const version = await readFeedbackIndexVersion(db);
  if (version !== feedbackIndexVersion) {
    await refreshFarmHelperFeedbackUserIndex(db);
  }
}

async function userMightHaveFeedback(db: Db, userId: number): Promise<boolean> {
  await syncFeedbackUserIndexIfChanged(db);
  return feedbackUserIds === null || feedbackUserIds.has(userId);
}

export function startFarmHelperFeedbackUserIndexRefresh(db: Db, intervalMs = 30_000): () => void {
  void refreshFarmHelperFeedbackUserIndex(db).catch(() => {});
  const timer = setInterval(() => {
    void refreshFarmHelperFeedbackUserIndex(db).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

async function dropFromIndexIfDone(db: Db, userId: number): Promise<void> {
  if (!feedbackUserIds) return;
  const remaining = (await exec(db, "select 1 from farm_helper_feedback where user_id = ? and resolved_at is null limit 1", [userId])).rows[0];
  if (!remaining) feedbackUserIds.delete(userId);
}

/** Every mark for one user: active first, newest first, capped. */
export async function listFarmHelperFeedback(db: Db, userId: number): Promise<FarmHelperFeedbackMark[]> {
  const rows = (await exec(
    db,
    `select * from farm_helper_feedback where user_id = ?
     order by case when resolved_at is null then 0 else 1 end, created_at desc
     limit ${FEEDBACK_LIST_LIMIT}`,
    [userId],
  )).rows;
  return rows.map((row) => rowToMark(row as Record<string, unknown>));
}

/** The active (unresolved) marks the rec builder applies. */
export async function loadActiveFarmHelperFeedback(db: Db, userId: number): Promise<ActiveFarmHelperFeedbackMark[]> {
  const rows = (await exec(
    db,
    "select beatmap_id, speed_bucket, verdict, created_at from farm_helper_feedback where user_id = ? and resolved_at is null",
    [userId],
  )).rows;
  return rows.map((row) => ({
    beatmapId: Number(row.beatmap_id),
    speedBucket: String(row.speed_bucket) as ScoreSpeedBucket,
    verdict: String(row.verdict) as FarmHelperFeedbackVerdict,
    createdAt: Number(row.created_at),
  }));
}

/** One user's active (unresolved) mark count, as the insert cap consumes it. */
export async function countActiveFarmHelperFeedback(db: Db, userId: number): Promise<number> {
  const row = (await exec(
    db,
    "select count(*) as n from farm_helper_feedback where user_id = ? and resolved_at is null",
    [userId],
  )).rows[0];
  return Number(row?.n ?? 0);
}

// Discriminated result so the compiler forces every caller to handle the cap
// refusal before touching mark fields. The success arm keeps the full mark
// shape (spread, not nested) so pass-through consumers keep the data they had;
// the HTTP layer maps `ok: false` to a 400 with code "too_many_marks".
export type SetFarmHelperFeedbackResult =
  | ({ ok: true } & FarmHelperFeedbackMark)
  | { ok: false; reason: "too_many_marks" };

/**
 * Upsert one lane's mark. Re-marking a resolved lane reactivates it (clears
 * resolvedAt/resolvedPp) and refreshes createdAt; so does a verdict change on
 * an active mark. The createdAt refresh is what keeps a reactivated mark alive:
 * auto-resolution only retires marks older than the score, so a mark that kept
 * its pre-resolution createdAt would be re-resolved by the very score that
 * retired it. Re-posting an unchanged active mark is idempotent. A NEW mark is
 * refused with `{ ok: false, reason: "too_many_marks" }` once the user already
 * holds FARM_HELPER_FEEDBACK_ACTIVE_MARK_CAP active marks; writes to existing
 * rows are exempt.
 */
export async function setFarmHelperFeedback(db: Db, input: FarmHelperFeedbackInput): Promise<SetFarmHelperFeedbackResult> {
  const now = Date.now();
  const existing = (await exec(
    db,
    "select verdict, created_at, resolved_at from farm_helper_feedback where user_id = ? and beatmap_id = ? and speed_bucket = ?",
    [input.userId, input.beatmapId, input.speedBucket],
  )).rows[0];
  if (!existing) {
    if (await countActiveFarmHelperFeedback(db, input.userId) >= FARM_HELPER_FEEDBACK_ACTIVE_MARK_CAP) {
      return { ok: false, reason: "too_many_marks" };
    }
    await exec(
      db,
      `insert into farm_helper_feedback (user_id, beatmap_id, speed_bucket, verdict, created_at, updated_at, resolved_at, resolved_pp)
       values (?, ?, ?, ?, ?, ?, null, null)`,
      [input.userId, input.beatmapId, input.speedBucket, input.verdict, now, now],
    );
  } else {
    const wasResolved = existing.resolved_at != null;
    const verdictChanged = String(existing.verdict) !== input.verdict;
    const createdAt = wasResolved || verdictChanged ? now : Number(existing.created_at);
    await exec(
      db,
      `update farm_helper_feedback
       set verdict = ?, created_at = ?, updated_at = ?, resolved_at = null, resolved_pp = null
       where user_id = ? and beatmap_id = ? and speed_bucket = ?`,
      [input.verdict, createdAt, now, input.userId, input.beatmapId, input.speedBucket],
    );
  }
  noteFarmHelperFeedbackUserActive(input.userId);
  await bumpFarmHelperFeedbackVersion(db).catch(() => {});
  const row = (await exec(
    db,
    "select * from farm_helper_feedback where user_id = ? and beatmap_id = ? and speed_bucket = ?",
    [input.userId, input.beatmapId, input.speedBucket],
  )).rows[0];
  if (!row) throw new Error("failed to read back farm helper feedback mark");
  return { ok: true, ...rowToMark(row as Record<string, unknown>) };
}

export async function clearFarmHelperFeedback(db: Db, userId: number, beatmapId: number, speedBucket: ScoreSpeedBucket): Promise<boolean> {
  const res = await exec(
    db,
    "delete from farm_helper_feedback where user_id = ? and beatmap_id = ? and speed_bucket = ?",
    [userId, beatmapId, speedBucket],
  );
  const ok = res.rowsAffected > 0;
  if (ok) {
    await bumpFarmHelperFeedbackVersion(db).catch(() => {});
    await dropFromIndexIfDone(db, userId);
  }
  return ok;
}

/**
 * Ingest auto-resolution: a genuinely new score on a marked lane retires every
 * active mark older than the score, stamping the score's pp. The lane bucket is
 * derived from the score's mods exactly as the farm helper derives a rec's
 * speedBucket. Returns the number of marks resolved so the caller (the ingest
 * hook) can evict the snapshot cache only when something changed.
 */
export async function resolveFarmHelperFeedbackForScore(db: Db, score: OscScore): Promise<number> {
  // A mark (either verdict) is contradicted only by the player actually
  // setting a score on the lane; dying mid-map proves nothing, and resolving
  // on a fail would un-hide the exact map the player reported as too hard.
  // Single choke point on purpose: every caller inherits the gate.
  if (!score.passed) return 0;
  const userId = Number(score.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return 0;
  if (!await userMightHaveFeedback(db, userId)) return 0;
  const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
  if (!Number.isInteger(beatmapId) || beatmapId <= 0) return 0;
  const speedBucket = getScoreSpeedBucket(getModAcronyms(score.mods));
  const scoreTimeRaw = Date.parse(score.ended_at ?? score.created_at ?? "");
  const scoreTimeMs = Number.isFinite(scoreTimeRaw) ? scoreTimeRaw : Date.now();
  const pp = typeof score.pp === "number" && Number.isFinite(score.pp) && score.pp > 0 ? score.pp : null;
  const now = Date.now();
  const res = await exec(
    db,
    `update farm_helper_feedback
     set resolved_at = ?, resolved_pp = ?, updated_at = ?
     where user_id = ? and beatmap_id = ? and speed_bucket = ?
       and resolved_at is null and created_at < ?`,
    [now, pp, now, userId, beatmapId, speedBucket, scoreTimeMs],
  );
  const resolved = Number(res.rowsAffected ?? 0);
  if (resolved > 0) await dropFromIndexIfDone(db, userId);
  return resolved;
}
