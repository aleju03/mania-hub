import type { Db } from "./db.js";
import { exec, json } from "./db.js";
import { nowIso } from "./shared/score.js";

const USER_SCOPED_JOB_TYPES = [
  "enrich_user",
  "refresh_user_top_scores",
  "reconcile_user_recent_scores",
  "refresh_user_maps_farmed_scores",
];

export async function markUserMissing(db: Db, userId: number, reason: string): Promise<{ untrackedRosters: number; deletedJobs: number }> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) throw new Error("Invalid user id");
  const now = nowIso();
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, is_active, profile_json, updated_at)
     values (?, ?, '', null, 0, ?, ?)
     on conflict(user_id) do update set
       is_active = 0,
       profile_json = excluded.profile_json,
       updated_at = excluded.updated_at`,
    [safeUserId, `User ${safeUserId}`, json({ missing: true, reason, missingAt: now }), now],
  );
  const rosterResult = await exec(
    db,
    "update country_rosters set is_tracked = 0, refreshed_at = ? where user_id = ? and is_tracked = 1",
    [now, safeUserId],
  );
  const jobResult = await exec(
    db,
    `delete from jobs
     where status in ('queued', 'failed', 'deferred_pressure')
       and type in (${USER_SCOPED_JOB_TYPES.map(() => "?").join(", ")})
       and json_valid(payload_json)
       and cast(json_extract(payload_json, '$.userId') as integer) = ?`,
    [...USER_SCOPED_JOB_TYPES, safeUserId],
  );
  return {
    untrackedRosters: Number(rosterResult.rowsAffected ?? 0),
    deletedJobs: Number(jobResult.rowsAffected ?? 0),
  };
}

export async function isUserKnownInactive(db: Db, userId: number): Promise<boolean> {
  const row = (await exec(db, "select is_active from users where user_id = ? limit 1", [userId])).rows[0];
  return row != null && Number(row.is_active ?? 1) === 0;
}
