import type { Db } from "./db.js";
import { exec, execBatch, json, type DbStatement } from "./db.js";
import { clearFarmHelperCache } from "./features/farm-helper.js";
import { clearFarmHelperKeyStatsCaches } from "./features/farm-helper-key-stats.js";
import { purgeUserFromMapsSnapshots, syncGlobalMapsFarmedUserBeatmaps } from "./features/maps.js";
import { clearPackCommunitySnapshots } from "./features/pack-community.js";
import { nowIso } from "./shared/score.js";
export { isUserKnownInactive } from "./user-status.js";

const USER_SCOPED_JOB_TYPES = [
  "enrich_user",
  "refresh_user_top_scores",
  "reconcile_user_recent_scores",
  "refresh_user_maps_farmed_scores",
  "refresh_profile_user",
  "refresh_profile_snapshot",
  "compute_player_skills",
];

const PERMANENT_WIPE_REASON = "admin: wipe banned tracked user";

export class PermanentlyWipedUserError extends Error {
  constructor(readonly userId: number) {
    super("Permanently wiped users cannot be reactivated");
    this.name = "PermanentlyWipedUserError";
  }
}

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
       profile_json = case
         when json_valid(users.profile_json)
          and json_extract(users.profile_json, '$.reason') = '${PERMANENT_WIPE_REASON}'
         then users.profile_json else excluded.profile_json end,
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

// Inverse of markUserMissing: flip the user back to active and re-track the
// roster rows we untracked. We do NOT null-restore ranks or re-enrich here (a
// roster refresh does that, and auto-re-enriching a genuinely banned user would
// just 404 and flip them straight back to inactive).
export async function reactivateUser(db: Db, userId: number): Promise<{ retrackedRosters: number }> {
  const safeUserId = Math.floor(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) throw new Error("Invalid user id");
  const existing = (await exec(db, "select profile_json from users where user_id = ? limit 1", [safeUserId])).rows[0];
  if (existing?.profile_json != null) {
    try {
      const profile = JSON.parse(String(existing.profile_json)) as { reason?: unknown };
      if (profile.reason === PERMANENT_WIPE_REASON) throw new PermanentlyWipedUserError(safeUserId);
    } catch (error) {
      if (error instanceof PermanentlyWipedUserError) throw error;
    }
  }
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
  updated: Record<string, number>;
}

export interface UserWipePreview {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string | null;
  active: boolean;
  impact: {
    trackerScores: number;
    snipeEvents: number;
    mapRows: number;
    packHoldings: number;
    packOwners: number;
    packCopies: number;
    accountDataRows: number;
  };
  canWipe: boolean;
}

export class UserWipeLookupError extends Error {
  constructor(readonly code: "user_not_found" | "ambiguous_username" | "user_has_account_data") {
    super(code);
    this.name = "UserWipeLookupError";
  }
}

/**
 * Human input resolves as a username first, even when it is all digits (valid
 * on osu!). Prefix a numeric id with # or `id:` to force id lookup. Returning a
 * preview instead of mutating is what lets the UI show the immutable id before
 * it offers the destructive confirmation.
 */
export async function previewUserWipe(db: Db, rawQuery: string): Promise<UserWipePreview> {
  const query = rawQuery.trim();
  if (!query) throw new UserWipeLookupError("user_not_found");
  const forcedIdMatch = /^(?:#|id:)(\d+)$/i.exec(query);
  let row: Record<string, unknown> | undefined;
  if (forcedIdMatch) {
    const userId = Number(forcedIdMatch[1]);
    if (Number.isSafeInteger(userId) && userId > 0) {
      row = (await exec(db, "select user_id, username, avatar_url, country_code, is_active from users where user_id = ? limit 1", [userId])).rows[0];
    }
  } else {
    const usernameRows = (await exec(
      db,
      "select user_id, username, avatar_url, country_code, is_active from users where lower(username) = lower(?) order by user_id limit 2",
      [query],
    )).rows;
    if (usernameRows.length > 1) throw new UserWipeLookupError("ambiguous_username");
    row = usernameRows[0];
    if (!row && /^\d+$/.test(query)) {
      const userId = Number(query);
      if (Number.isSafeInteger(userId) && userId > 0) {
        row = (await exec(db, "select user_id, username, avatar_url, country_code, is_active from users where user_id = ? limit 1", [userId])).rows[0];
      }
    }
  }
  if (!row) throw new UserWipeLookupError("user_not_found");
  return getUserWipePreview(db, Number(row.user_id), row);
}

export async function getUserWipePreview(
  db: Db,
  userId: number,
  knownRow?: Record<string, unknown>,
): Promise<UserWipePreview> {
  const safeUserId = Math.floor(Number(userId));
  if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) throw new UserWipeLookupError("user_not_found");
  const row = knownRow ?? (await exec(
    db,
    "select user_id, username, avatar_url, country_code, is_active from users where user_id = ? limit 1",
    [safeUserId],
  )).rows[0];
  if (!row) throw new UserWipeLookupError("user_not_found");

  const counts = (await exec(
    db,
    `select
       (select count(*) from score_events where user_id = ?) as tracker_scores,
       (select count(*) from snipe_events where sniper_id = ? or victim_id = ?) as snipe_events,
       ((select count(*) from country_maps_farmed_scores where user_id = ?)
        + (select count(*) from global_maps_farmed_scores where user_id = ?)
        + (select count(*) from country_maps_most_played where user_id = ?)
        + (select count(*) from country_maps_favourite_sets where user_id = ?)) as map_rows,
       (select count(*) from pack_collection_cards where card_user_id = ?) as pack_holdings,
       (select count(distinct owner_user_id) from pack_collection_cards where card_user_id = ?) as pack_owners,
       (select coalesce(sum(copies), 0) from pack_collection_cards where card_user_id = ?) as pack_copies,
       ((select count(*) from user_goals where user_id = ?)
        + (select count(*) from pack_wallets where user_id = ?)
        + (select count(*) from pack_collection_cards where owner_user_id = ?)
        + (select count(*) from skins where owner_user_id = ?)
        + (select count(*) from uploaded_replays where owner_user_id = ?)
        + (select count(*) from user_replay_skins where user_id = ?)
        + (select count(*) from user_signatures where user_id = ?)
        + (select count(*) from user_map_collections where owner_user_id = ?)
        + (select count(*) from user_map_collection_favourites where user_id = ?)
        + (select count(*) from discord_user_links where osu_user_id = ?)
        + (select count(*) from discord_communities where owner_user_id = ?)
        + (select count(*) from discord_community_reports where reporter_user_id = ?)
        + (select count(*) from goat_poll_votes where voter_user_id = ?)
        + (select count(*) from translation_reports where user_id = ?)
        + (select count(*) from bug_reports where user_id = ?)) as account_data_rows`,
    Array(25).fill(safeUserId),
  )).rows[0] ?? {};
  const accountDataRows = Number(counts.account_data_rows ?? 0);
  return {
    userId: safeUserId,
    username: String(row.username ?? `User ${safeUserId}`),
    avatarUrl: String(row.avatar_url ?? ""),
    countryCode: row.country_code == null ? null : String(row.country_code),
    active: Number(row.is_active ?? 1) !== 0,
    impact: {
      trackerScores: Number(counts.tracker_scores ?? 0),
      snipeEvents: Number(counts.snipe_events ?? 0),
      mapRows: Number(counts.map_rows ?? 0),
      packHoldings: Number(counts.pack_holdings ?? 0),
      packOwners: Number(counts.pack_owners ?? 0),
      packCopies: Number(counts.pack_copies ?? 0),
      accountDataRows,
    },
    canWipe: accountDataRows === 0,
  };
}

// Permanent suppression for a tracked-only banned/deleted osu! account. The
// inactive users row is retained as the durable deny-list tombstone; every
// tracking-derived row and public history reference is removed. Independent
// account-owned data is never guessed away: the preview detects it and this
// function refuses the wipe if any appeared between preview and confirmation.
// `journalDb` is the journal database (journal.ts), where live_event_log
// lives; tests that keep every table in one file leave it defaulted.
export async function wipeUserProjections(db: Db, userId: number, journalDb: Db = db): Promise<WipeUserProjectionsResult> {
  const safeUserId = Math.floor(userId);
  if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) throw new Error("Invalid user id");
  const preview = await getUserWipePreview(db, safeUserId);
  if (!preview.canWipe) throw new UserWipeLookupError("user_has_account_data");

  // The event journal lives in its own database, so the references it needs
  // (score identities, pack pull ids) are read here first and its delete goes
  // down ahead of the main transaction; a 7-day SSE replay log is the one
  // table whose purge is allowed to land separately.
  const scoreIdentities = (await exec(db, "select score_identity from score_events where user_id = ?", [safeUserId])).rows
    .map((row) => String(row.score_identity));
  const packPullIds = (await exec(db, "select id from pack_pull_events where card_user_id = ?", [safeUserId])).rows
    .map((row) => Number(row.id));
  const deletedLiveEvents = await deleteUserLiveEvents(journalDb, safeUserId, scoreIdentities, packPullIds);

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

  const now = nowIso();
  const setup: DbStatement[] = [
    {
      sql: `update users set is_active = 0, profile_json = ?, updated_at = ? where user_id = ?`,
      args: [json({ missing: true, reason: PERMANENT_WIPE_REASON, missingAt: now }), now, safeUserId],
    },
    {
      sql: "update country_rosters set rank = null, is_tracked = 0, refreshed_at = ? where user_id = ? and is_tracked = 1",
      args: [now, safeUserId],
    },
    // A card of the banned player can be held by otherwise unrelated users.
    // Mark those owners for a roll-up rebuild before deleting the holdings;
    // installations without the normal triggers therefore remain correct too.
    {
      sql: `insert or ignore into pack_community_dirty_owners (owner_user_id)
            select distinct owner_user_id from pack_collection_cards where card_user_id = ?`,
      args: [safeUserId],
    },
    { sql: "insert or ignore into pack_community_dirty_cards (card_user_id) values (?)", args: [safeUserId] },
  ];
  const deletions: Array<{ name: string; statement: DbStatement }> = [
    { name: "score_events", statement: { sql: "delete from score_events where user_id = ?", args: [safeUserId] } },
    { name: "country_rank_snapshots", statement: { sql: "delete from country_rank_snapshots where user_id = ?", args: [safeUserId] } },
    { name: "country_beatmap_scores", statement: { sql: "delete from country_beatmap_scores where user_id = ?", args: [safeUserId] } },
    { name: "country_beatmap_score_pbs", statement: { sql: "delete from country_beatmap_score_pbs where user_id = ?", args: [safeUserId] } },
    { name: "country_beatmap_score_pb_state", statement: { sql: "delete from country_beatmap_score_pb_state where user_id = ?", args: [safeUserId] } },
    { name: "country_maps_farmed_scores", statement: { sql: "delete from country_maps_farmed_scores where user_id = ?", args: [safeUserId] } },
    { name: "global_maps_farmed_scores", statement: { sql: "delete from global_maps_farmed_scores where user_id = ?", args: [safeUserId] } },
    { name: "country_maps_most_played", statement: { sql: "delete from country_maps_most_played where user_id = ?", args: [safeUserId] } },
    { name: "country_maps_favourite_sets", statement: { sql: "delete from country_maps_favourite_sets where user_id = ?", args: [safeUserId] } },
    { name: "farm_helper_user_key_stats", statement: { sql: "delete from farm_helper_user_key_stats where user_id = ?", args: [safeUserId] } },
    { name: "farm_helper_feedback", statement: { sql: "delete from farm_helper_feedback where user_id = ?", args: [safeUserId] } },
    { name: "farm_helper_push_targets", statement: { sql: "delete from farm_helper_push_targets where user_id = ?", args: [safeUserId] } },
    { name: "user_top_scores", statement: { sql: "delete from user_top_scores where user_id = ?", args: [safeUserId] } },
    { name: "top_play_events", statement: { sql: "delete from top_play_events where user_id = ?", args: [safeUserId] } },
    { name: "snipe_events", statement: { sql: "delete from snipe_events where sniper_id = ? or victim_id = ?", args: [safeUserId, safeUserId] } },
    { name: "player_skill_history", statement: { sql: "delete from player_skill_history where user_id = ?", args: [safeUserId] } },
    { name: "player_skill_ratings", statement: { sql: "delete from player_skill_ratings where user_id = ?", args: [safeUserId] } },
    { name: "player_skill_baseline", statement: { sql: "delete from player_skill_baseline where user_id = ?", args: [safeUserId] } },
    { name: "profile_snapshots", statement: { sql: "delete from profile_snapshots where user_id = ?", args: [safeUserId] } },
    { name: "profile_section_cache", statement: { sql: "delete from profile_section_cache where user_id = ?", args: [safeUserId] } },
    { name: "player_activity_days", statement: { sql: "delete from player_activity_days where user_id = ?", args: [safeUserId] } },
    { name: "player_activity_maps", statement: { sql: "delete from player_activity_maps where user_id = ?", args: [safeUserId] } },
    { name: "player_activity_score_refs", statement: { sql: "delete from player_activity_score_refs where user_id = ?", args: [safeUserId] } },
    { name: "player_activity_backfill_cursors", statement: { sql: "delete from player_activity_backfill_cursors where user_id = ?", args: [safeUserId] } },
    { name: "activity_mods_backfill_queue", statement: { sql: "delete from activity_mods_backfill_queue where user_id = ?", args: [safeUserId] } },
    { name: "activity_combo_backfill_queue", statement: { sql: "delete from activity_combo_backfill_queue where user_id = ?", args: [safeUserId] } },
    { name: "activity_play_detail_misses", statement: { sql: "delete from activity_play_detail_misses where user_id = ?", args: [safeUserId] } },
    {
      name: "pack_showcase_cards",
      statement: {
        sql: `delete from pack_showcase_cards
              where exists (select 1 from pack_collection_cards c
                            where c.owner_user_id = pack_showcase_cards.owner_user_id
                              and c.card_key = pack_showcase_cards.card_key
                              and c.card_user_id = ?)`,
        args: [safeUserId],
      },
    },
    { name: "pack_collection_cards", statement: { sql: "delete from pack_collection_cards where card_user_id = ?", args: [safeUserId] } },
    { name: "pack_card_serials", statement: { sql: "delete from pack_card_serials where card_user_id = ?", args: [safeUserId] } },
    { name: "pack_pull_events", statement: { sql: "delete from pack_pull_events where card_user_id = ?", args: [safeUserId] } },
    { name: "pack_cards", statement: { sql: "delete from pack_cards where card_user_id = ?", args: [safeUserId] } },
    { name: "pack_community_card_stats", statement: { sql: "delete from pack_community_card_stats where card_user_id = ?", args: [safeUserId] } },
    {
      name: "jobs",
      statement: {
        sql: `delete from jobs
              where json_valid(payload_json)
                and cast(json_extract(payload_json, '$.userId') as integer) = ?`,
        args: [safeUserId],
      },
    },
  ];
  const results = await execBatch(db, [...setup, ...deletions.map((entry) => entry.statement)]);
  // results[1] is the country_rosters untrack, the second setup statement.
  const untrackedRosters = Number(results[1]?.rowsAffected ?? 0);
  const deleted: Record<string, number> = {
    live_event_log: deletedLiveEvents,
    ...Object.fromEntries(deletions.map((entry, index) => [
      entry.name,
      Number(results[setup.length + index]?.rowsAffected ?? 0),
    ])),
  };

  // The target rows are already gone atomically. These follow-up rebuilds only
  // repair shared derivatives and publish their revisions; they never delete a
  // bystander's normalized score or holding.
  await syncGlobalMapsFarmedUserBeatmaps(db, safeUserId, [...beatmapIds], nowIso());
  const mapsSnapshots = await purgeUserFromMapsSnapshots(db, safeUserId);

  // In-process caches may still hold the user inside other subjects' snapshots
  // and cohort pools; wipes are rare, so a wholesale clear is fine. (Sibling
  // processes converge via the 5-minute TTLs.)
  clearFarmHelperCache(db);
  clearFarmHelperKeyStatsCaches(db);
  clearPackCommunitySnapshots(db);

  return {
    userId: safeUserId,
    untrackedRosters,
    deletedJobs: deleted.jobs ?? 0,
    deleted,
    updated: { country_maps_snapshots: mapsSnapshots },
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

// SQLite takes a bounded number of bound parameters per statement, so the
// identity lists go down in slices.
const LIVE_EVENT_WIPE_CHUNK = 500;

async function deleteUserLiveEvents(journalDb: Db, userId: number, scoreIdentities: string[], packPullIds: number[]): Promise<number> {
  let deleted = 0;
  const byUser = await exec(
    journalDb,
    `delete from live_event_log
     where (type = 'tracker_score' and (cast(json_extract(payload_json, '$.user_id') as integer) = ?
                                        or cast(json_extract(payload_json, '$.user.id') as integer) = ?))
        or (type = 'top_play' and (cast(json_extract(payload_json, '$.user.id') as integer) = ?
                                    or cast(json_extract(payload_json, '$.score.user_id') as integer) = ?))
        or (type = 'snipe' and (cast(json_extract(payload_json, '$.sniper.id') as integer) = ?
                                or cast(json_extract(payload_json, '$.victim.id') as integer) = ?))
        or (type = 'maps_farmed_update' and cast(json_extract(payload_json, '$.userId') as integer) = ?)
        or (type = 'goal_completed' and cast(json_extract(payload_json, '$.userId') as integer) = ?)`,
    Array(8).fill(userId),
  );
  deleted += Number(byUser.rowsAffected ?? 0);
  for (let index = 0; index < scoreIdentities.length; index += LIVE_EVENT_WIPE_CHUNK) {
    const chunk = scoreIdentities.slice(index, index + LIVE_EVENT_WIPE_CHUNK);
    const result = await exec(
      journalDb,
      `delete from live_event_log
       where type = 'tracker_score'
         and json_extract(payload_json, '$.ref') = 'tracker_score'
         and json_extract(payload_json, '$.scoreIdentity') in (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
    deleted += Number(result.rowsAffected ?? 0);
  }
  for (let index = 0; index < packPullIds.length; index += LIVE_EVENT_WIPE_CHUNK) {
    const chunk = packPullIds.slice(index, index + LIVE_EVENT_WIPE_CHUNK);
    const result = await exec(
      journalDb,
      `delete from live_event_log
       where type = 'pack_pull'
         and cast(json_extract(payload_json, '$.id') as integer) in (${chunk.map(() => "?").join(", ")})`,
      chunk,
    );
    deleted += Number(result.rowsAffected ?? 0);
  }
  return deleted;
}
