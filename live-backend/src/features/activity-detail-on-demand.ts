/**
 * View-driven completion of archived play details.
 *
 * The capped sweep beside this one (`activity-combo-backfill.ts`) can only
 * afford a few hundred players, chosen blind by pp. This covers the rest the
 * cheap way: when somebody actually opens a profile's per-keymode lists, any
 * play on them that is still missing its combo, score and replay button gets
 * queued for one osu! call, quietly, after the response has already gone out.
 *
 * So the profiles that get looked at complete themselves, and the ones nobody
 * opens cost nothing. The queue is the pacing: these jobs sit in the same lane
 * as the blind sweep (one at a time, ever) at a priority just above it, and
 * every request goes through the shared limiter's job lane, which yields to
 * page loads.
 *
 * Rows the sweep has already queued are skipped, so the two never spend two
 * calls on one row, and a score osu! cannot serve is remembered rather than
 * asked for again on the next view.
 */
import type { Db } from "../db.js";
import { exec } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo, logWarn, errorContext } from "../logger.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";
import {
  ACTIVITY_PLAY_DETAIL_SET_SQL,
  fetchVerifiedRowScore,
  readPlayDetailArgs,
} from "./activity-mods-backfill.js";
import { clearSupersededPlayDetails } from "./activity.js";
import { activityMapBestRowOrder } from "./keymode-pp.js";

export const ACTIVITY_DETAIL_ON_DEMAND_JOB = "backfill_activity_detail_on_demand";
/** Above the blind sweep, below everything that serves a request. A profile
    somebody is reading outranks one nobody has opened. */
const ON_DEMAND_JOB_PRIORITY = -22;
/** Rows per link. A player with more chains rather than bursting. */
const ON_DEMAND_CHUNK = 20;
const ON_DEMAND_CHAIN_DELAY_MS = 60_000;

/* Each link gets its own dedupe key.
   The queue's conflict clause only updates a row that is queued, failed or
   deferred, so a job enqueuing its own continuation under the key it is
   running as writes nothing: the chain died after one chunk, and the `done`
   row it left behind then blocked the next profile view for the two days
   before retention swept it. Both self-chaining sweeps beside this one vary
   the key by cursor for exactly that reason. Link 0 is the key a profile view
   uses, so a profile open during a live chain does not start a second one. */
function jobKey(userId: number, link: number): string {
  return `${ACTIVITY_DETAIL_ON_DEMAND_JOB}:${userId}:${link}`;
}

/* Every candidate row for one player: the play each map's list actually
   quotes, missing its details, with a keymode to be listed under, not already
   on the blind sweep's work list, and not one osu! has already refused. */
const CANDIDATE_SQL = `
  with win as (
    -- Materialised once for the player rather than tested per candidate row:
    -- the beatmap id lives inside the stored payload, and a correlated
    -- json_extract over their whole window costs 770ms on a heavy profile
    -- where this costs 1ms.
    select json_extract(u.score_json, '$.beatmap_id') beatmap_id
    from user_top_scores u where u.user_id = ?
  ),
  per_map as (
    select m.country, m.user_id, m.day, m.beatmap_id, m.best_score_id score_id, m.best_pp pp,
           m.best_max_combo combo,
           row_number() over (partition by m.beatmap_id order by ${activityMapBestRowOrder("m")}) day_rn
    from player_activity_maps m
    where m.user_id = ? and m.best_pp > 0 and m.best_score_id is not null and m.best_score_id > 0
  )
  select p.country, p.user_id, p.day, p.beatmap_id, p.score_id, p.pp
  from per_map p
  left join maps_beatmaps mb on mb.beatmap_id = p.beatmap_id
  left join map_search_index si on si.beatmap_id = p.beatmap_id
  -- day_rn first, combo second: filtering on the combo before the ranking
  -- would promote an older day of a map whose best day is already complete,
  -- and spend a call on a row no list quotes.
  where p.day_rn = 1
    and p.combo is null
    and coalesce(mb.cs, si.key_count) is not null
    -- A play inside the osu! window renders from osu!'s own payload, so its
    -- details are never this table's problem.
    and p.beatmap_id not in (select beatmap_id from win)
    and not exists (
      select 1 from activity_combo_backfill_queue q
      where q.user_id = p.user_id and q.beatmap_id = p.beatmap_id and q.day = p.day
    )
    and not exists (
      select 1 from activity_play_detail_misses x
      where x.user_id = p.user_id and x.beatmap_id = p.beatmap_id and x.day = p.day
    )
  order by p.pp desc
  limit ?`;

export interface OnDemandDetailRow {
  country: string;
  userId: number;
  day: string;
  beatmapId: number;
  scoreId: number;
  pp: number;
}

export async function selectOnDemandDetailRows(db: Db, userId: number, limit: number): Promise<OnDemandDetailRow[]> {
  const rows = (await exec(db, CANDIDATE_SQL, [userId, userId, Math.max(1, Math.floor(limit))])).rows;
  return rows.map((row) => ({
    country: String(row.country),
    userId: Number(row.user_id),
    day: String(row.day),
    beatmapId: Number(row.beatmap_id),
    scoreId: Number(row.score_id),
    pp: Number(row.pp),
  }));
}

/**
 * Called from the serving path once a profile's per-keymode lists are read.
 *
 * Best-effort in every direction: it never blocks the response, it enqueues
 * nothing when the profile is already complete, and nothing while a link of
 * that player's chain is still in flight, so a profile being refreshed in ten
 * tabs is still one job.
 */
export async function enqueueMissingPlayDetails(db: Db, queue: JobQueue, userId: number): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  if (await hasPendingOnDemandJob(db, userId)) return false;
  const candidates = await selectOnDemandDetailRows(db, userId, 1);
  if (candidates.length === 0) return false;
  await queue.enqueue(
    ACTIVITY_DETAIL_ON_DEMAND_JOB,
    jobKey(userId, 0),
    { userId, link: 0 },
    // replaceDone: a finished link 0 from a chain that died mid-way would
    // otherwise block this player for the two days a done row survives.
    { priority: ON_DEMAND_JOB_PRIORITY, replaceDone: true },
  );
  return true;
}

/** Statuses that mean this player's chain will get there on its own. */
const PENDING_JOB_STATUSES = new Set(["queued", "running", "failed", "deferred_pressure"]);

/* Any link of this player's chain still in flight, checked before the
   candidate query because it is the cheaper of the two and answers the common
   case: a profile refreshed in ten tabs while its chain is running.

   The range rides the unique index on dedupe_key (\uffff sorts above every
   digit), and the statuses are matched here rather than in the WHERE because
   adding them sent the planner to idx_jobs_status_type instead, which walks
   every queued job in the service to find one player's links. */
async function hasPendingOnDemandJob(db: Db, userId: number): Promise<boolean> {
  const prefix = `${ACTIVITY_DETAIL_ON_DEMAND_JOB}:${userId}:`;
  const rows = (await exec(
    db,
    "select status from jobs where dedupe_key >= ? and dedupe_key < ?",
    [prefix, `${prefix}\uffff`],
  )).rows;
  return rows.some((row) => PENDING_JOB_STATUSES.has(String(row.status)));
}

/** Remember a row osu! could not answer for, so the next view does not ask
    again. A pruned score never comes back. */
async function recordMiss(db: Db, row: OnDemandDetailRow, reason: "missing" | "mismatched"): Promise<void> {
  await exec(
    db,
    `insert into activity_play_detail_misses (user_id, beatmap_id, day, reason, checked_at)
     values (?, ?, ?, ?, ?)
     on conflict(user_id, beatmap_id, day) do update set reason = excluded.reason, checked_at = excluded.checked_at`,
    [row.userId, row.beatmapId, row.day, reason, nowIso()],
  );
}

export interface OnDemandDetailResult {
  processed: number;
  filled: number;
  missing: number;
  mismatched: number;
  more: boolean;
}

export async function runOnDemandDetailChunk(
  db: Db,
  osu: Pick<OsuApiClient, "getScoreById">,
  userId: number,
  limit = ON_DEMAND_CHUNK,
): Promise<OnDemandDetailResult> {
  const rows = await selectOnDemandDetailRows(db, userId, limit);
  let filled = 0;
  let missing = 0;
  let mismatched = 0;
  let processed = 0;
  for (const row of rows) {
    let found: Awaited<ReturnType<typeof fetchVerifiedRowScore>>;
    try {
      found = await fetchVerifiedRowScore(osu, row, `job:${ACTIVITY_DETAIL_ON_DEMAND_JOB}`);
    } catch (error) {
      // Transient: leave the rest for the retry rather than burning them.
      logWarn("activity_detail_on_demand_row_failed", {
        user_id: row.userId,
        beatmap_id: row.beatmapId,
        ...errorContext(error),
      });
      throw error;
    }
    processed += 1;
    if (found.outcome !== "filled") {
      if (found.outcome === "missing") missing += 1;
      else mismatched += 1;
      await recordMiss(db, row, found.outcome);
      continue;
    }
    const details = readPlayDetailArgs(found.score);
    if (details[0] == null) {
      mismatched += 1;
      await recordMiss(db, row, "mismatched");
      continue;
    }
    await exec(
      db,
      `update player_activity_maps
       set ${ACTIVITY_PLAY_DETAIL_SET_SQL}, updated_at = ?
       where country = ? and user_id = ? and day = ? and beatmap_id = ?`,
      [...details, nowIso(), row.country, row.userId, row.day, row.beatmapId],
    );
    // A chunk is 20 osu! calls spread over as many seconds, so a better play
    // can land on one of these maps between selecting the row and writing it.
    await clearSupersededPlayDetails(db, row.userId, row.beatmapId);
    filled += 1;
  }
  return { processed, filled, missing, mismatched, more: rows.length >= limit };
}

/** One chain link for one player, re-queued while that player still has rows. */
export async function runActivityDetailOnDemandJob(
  db: Db,
  queue: JobQueue,
  osu: Pick<OsuApiClient, "getScoreById">,
  payload: { userId?: number; link?: number } | undefined,
): Promise<void> {
  const userId = Number(payload?.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  const rawLink = Number(payload?.link);
  const link = Number.isSafeInteger(rawLink) && rawLink > 0 ? rawLink : 0;
  const result = await runOnDemandDetailChunk(db, osu, userId);
  logInfo("activity_detail_on_demand_chunk", { user_id: userId, link, ...result });
  if (!result.more) return;
  const next = link + 1;
  await queue.enqueue(
    ACTIVITY_DETAIL_ON_DEMAND_JOB,
    jobKey(userId, next),
    { userId, link: next },
    { priority: ON_DEMAND_JOB_PRIORITY, runAfter: new Date(Date.now() + ON_DEMAND_CHAIN_DELAY_MS), replaceDone: true },
  );
}
