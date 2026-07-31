import type { Db } from "./db.js";
import { exec, json } from "./db.js";
import { clearFarmHelperCache } from "./features/farm-helper.js";
import { clearFarmHelperKeyStatsCaches } from "./features/farm-helper-key-stats.js";
import { syncGlobalMapsFarmedUserBeatmaps } from "./features/maps.js";
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
    "update country_rosters set rank = null, is_tracked = 0, refreshed_at = ? where user_id = ? and is_tracked = 1",
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

// Inverse of markUserMissing: flip the user back to active and re-track the
// roster rows we untracked. We do NOT null-restore ranks or re-enrich here (a
// roster refresh does that, and auto-re-enriching a genuinely banned user would
// just 404 and flip them straight back to inactive).
export async function reactivateUser(db: Db, userId: number): Promise<{ retrackedRosters: number }> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) throw new Error("Invalid user id");
  const now = nowIso();
  await exec(db, "update users set is_active = 1, updated_at = ? where user_id = ?", [now, safeUserId]);
  const rosterResult = await exec(
    db,
    "update country_rosters set is_tracked = 1, refreshed_at = ? where user_id = ? and is_tracked = 0",
    [now, safeUserId],
  );
  return { retrackedRosters: Number(rosterResult.rowsAffected ?? 0) };
}

export interface WipeUserProjectionsResult {
  userId: number;
  untrackedRosters: number;
  deletedJobs: number;
  deleted: Record<string, number>;
}

// Hard purge for permanent cases (cheaters, ban-evasion accounts). Runs the
// same soft-deactivate ban detection uses (untrack + inactive + queued jobs
// dropped), then deletes the user's rows from the public projection tables so
// they vanish from boards immediately instead of merely stopping updates.
// Deliberately preserved:
// - the users row itself (the inactive tombstone read-time exclusion keys on),
// - score_events / live_event_log (retention prunes them) and snipe_events /
//   top_play_events (historical records, not projections of the player),
// - goals, pack wallets, skins (personal data, not public boards).
// Irreversible: re-tracking the user later rebuilds only from future fetches.
export async function wipeUserProjections(db: Db, userId: number): Promise<WipeUserProjectionsResult> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) throw new Error("Invalid user id");
  const missing = await markUserMissing(db, safeUserId, "admin: wipe user data");

  // Collect the touched beatmaps BEFORE deleting so the global farmed
  // projection can be reconciled per beatmap instead of forcing a full reseed.
  const beatmapIds = new Set<number>();
  for (const table of ["country_maps_farmed_scores", "global_maps_farmed_scores"]) {
    const rows = (await exec(db, `select distinct beatmap_id from ${table} where user_id = ?`, [safeUserId])).rows;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      if (Number.isSafeInteger(beatmapId) && beatmapId > 0) beatmapIds.add(beatmapId);
    }
  }

  const deleted: Record<string, number> = {};
  const deleteFrom = async (table: string) => {
    deleted[table] = Number((await exec(db, `delete from ${table} where user_id = ?`, [safeUserId])).rowsAffected ?? 0);
  };
  await deleteFrom("country_maps_farmed_scores");
  // The global rows are counted up front but deleted inside the reconcile: with
  // every country row gone, syncGlobalMapsFarmedUserBeatmaps drops the user's
  // global rows in the same batches that rebuild the per-beatmap aggregates and
  // publish the revision + change rows the packed board catch-up consumes.
  deleted.global_maps_farmed_scores = Number(
    (await exec(db, "select count(*) as n from global_maps_farmed_scores where user_id = ?", [safeUserId])).rows[0]?.n ?? 0,
  );
  await syncGlobalMapsFarmedUserBeatmaps(db, safeUserId, [...beatmapIds], nowIso());
  await deleteFrom("farm_helper_user_key_stats");
  await deleteFrom("user_top_scores");
  await deleteFrom("country_beatmap_scores");
  await deleteFrom("farm_helper_feedback");
  await deleteFrom("player_skill_ratings");
  await deleteFrom("player_skill_baseline");

  // In-process caches may still hold the user inside other subjects' snapshots
  // and cohort pools; wipes are rare, so a wholesale clear is fine. (Sibling
  // processes converge via the 5-minute TTLs.)
  clearFarmHelperCache(db);
  clearFarmHelperKeyStatsCaches(db);

  return {
    userId: safeUserId,
    untrackedRosters: missing.untrackedRosters,
    deletedJobs: missing.deletedJobs,
    deleted,
  };
}

export interface UserActiveResult {
  userId: number;
  username: string | null;
  active: boolean;
  untrackedRosters?: number;
  deletedJobs?: number;
  retrackedRosters?: number;
}

// Admin toggle behind the "deactivate user" button: reuse the same soft-delete
// the ban-detection path uses (markUserMissing) so a manual deactivate behaves
// exactly like an automatic one, and is fully reversible via reactivateUser.
export async function setUserActive(db: Db, userId: number, active: boolean, reason: string): Promise<UserActiveResult> {
  const row = (await exec(db, "select username from users where user_id = ? limit 1", [userId])).rows[0];
  const username = row?.username == null ? null : String(row.username);
  if (!active) {
    const result = await markUserMissing(db, userId, reason);
    return { userId, username, active: false, ...result };
  }
  const result = await reactivateUser(db, userId);
  return { userId, username, active: true, ...result };
}
