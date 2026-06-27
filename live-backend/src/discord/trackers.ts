import type { Db } from "../db.js";
import { exec } from "../db.js";
import { nowIso } from "../shared/score.js";

// Personal alerts a user sets up for themselves, delivered to their DMs.
//  - "user": watch one osu! player. Always fires on a new top play (a real pp
//    gain); also fires on any ranked score at or above minPp when minPp > 0.
//  - "maps": fires when a newly ranked map shows multi-player PP-gain activity.
export type TrackerKind = "user" | "maps";

// "maps" trackers have no target player; this sentinel lets the unique
// (subscriber_id, kind, target) key collapse duplicate maps watches per user.
export const MAPS_TRACKER_TARGET = 0;

export interface DiscordUserTracker {
  id: number;
  subscriberId: string;
  kind: TrackerKind;
  targetOsuUserId: number;
  targetUsername: string | null;
  minPp: number;
  createdAt: string;
}

function rowToTracker(row: Record<string, unknown>): DiscordUserTracker {
  return {
    id: Number(row.id),
    subscriberId: String(row.subscriber_id),
    kind: String(row.kind) as TrackerKind,
    targetOsuUserId: Number(row.target_osu_user_id ?? 0),
    targetUsername: row.target_username == null ? null : String(row.target_username),
    minPp: Number(row.min_pp ?? 0),
    createdAt: String(row.created_at),
  };
}

export async function addUserTracker(
  db: Db,
  params: { subscriberId: string; kind: TrackerKind; targetOsuUserId: number; targetUsername: string | null; minPp: number },
): Promise<void> {
  await exec(
    db,
    `insert into discord_user_trackers (subscriber_id, kind, target_osu_user_id, target_username, min_pp, created_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(subscriber_id, kind, target_osu_user_id)
     do update set target_username = excluded.target_username, min_pp = excluded.min_pp`,
    [params.subscriberId, params.kind, params.targetOsuUserId, params.targetUsername, Math.max(0, params.minPp), nowIso()],
  );
}

export async function removeUserTracker(
  db: Db,
  params: { subscriberId: string; kind: TrackerKind; targetOsuUserId: number },
): Promise<boolean> {
  const result = await exec(
    db,
    "delete from discord_user_trackers where subscriber_id = ? and kind = ? and target_osu_user_id = ?",
    [params.subscriberId, params.kind, params.targetOsuUserId],
  );
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function listUserTrackers(db: Db, subscriberId: string): Promise<DiscordUserTracker[]> {
  const result = await exec(
    db,
    "select * from discord_user_trackers where subscriber_id = ? order by kind, target_username",
    [subscriberId],
  );
  return result.rows.map(rowToTracker);
}

// All "user" trackers watching a given osu! player (one per subscriber).
export async function listTrackersForOsuUser(db: Db, osuUserId: number): Promise<DiscordUserTracker[]> {
  const result = await exec(
    db,
    "select * from discord_user_trackers where kind = 'user' and target_osu_user_id = ?",
    [osuUserId],
  );
  return result.rows.map(rowToTracker);
}

export async function listMapTrackers(db: Db): Promise<DiscordUserTracker[]> {
  const result = await exec(db, "select * from discord_user_trackers where kind = 'maps'");
  return result.rows.map(rowToTracker);
}

// The distinct set of osu! user ids any "user" tracker is watching. The runtime
// caches this so the per-score hot path can skip the DB entirely for the common
// case where the scoring player is not tracked by anyone.
export async function getTrackedOsuUserIds(db: Db): Promise<Set<number>> {
  const result = await exec(db, "select distinct target_osu_user_id from discord_user_trackers where kind = 'user'");
  return new Set(result.rows.map((row) => Number(row.target_osu_user_id)));
}

export async function countMapTrackers(db: Db): Promise<number> {
  const result = await exec(db, "select count(*) as n from discord_user_trackers where kind = 'maps'");
  return Number(result.rows[0]?.n ?? 0);
}

// Removes every tracker owned by a subscriber whose DM channel is unreachable,
// so a user who blocked the bot or closed DMs stops generating failed sends.
export async function removeTrackersForSubscriber(db: Db, subscriberId: string): Promise<number> {
  const result = await exec(db, "delete from discord_user_trackers where subscriber_id = ?", [subscriberId]);
  return Number(result.rowsAffected ?? 0);
}

// All trackers across all subscribers, for the admin dashboard.
export async function listAllUserTrackers(db: Db): Promise<DiscordUserTracker[]> {
  const result = await exec(db, "select * from discord_user_trackers order by kind, subscriber_id");
  return result.rows.map(rowToTracker);
}
