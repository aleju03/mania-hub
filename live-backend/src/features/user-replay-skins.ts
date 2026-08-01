import type { Db } from "../db.js";
import { exec } from "../db.js";
import { nowIso } from "../shared/score.js";

// Per-user replay skin choice: which published community skin (skins table)
// viewers see on this player's replays, plus the player's customized settings
// stored as opaque JSON. The payload only ever references assets by path
// inside the chosen .osk - the HTTP layer rejects embedded data: URLs and
// enforces the size cap below. Whether the linked skin is still published is
// also the HTTP layer's call (it already speaks to the skins module), so a
// hidden or deleted skin simply reads back as "no replay skin" there.

export const USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS = 1_000_000;

export interface UserReplaySkinRow {
  userId: number;
  skinId: string;
  payloadJson: string;
  updatedAt: string;
}

export async function getUserReplaySkin(db: Db, userId: number): Promise<UserReplaySkinRow | null> {
  const row = (await exec(db, "select * from user_replay_skins where user_id = ?", [userId])).rows[0];
  if (!row) return null;
  return {
    userId: Number(row.user_id),
    skinId: String(row.skin_id ?? ""),
    payloadJson: String(row.payload_json ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

// One choice per user: picking again (same skin with new settings, or a
// different skin) replaces the previous row outright.
export async function setUserReplaySkin(db: Db, userId: number, skinId: string, payloadJson: string): Promise<void> {
  await exec(
    db,
    `insert into user_replay_skins (user_id, skin_id, payload_json, updated_at)
     values (?, ?, ?, ?)
     on conflict(user_id) do update set
       skin_id = excluded.skin_id,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
    [userId, skinId, payloadJson, nowIso()],
  );
}

export async function clearUserReplaySkin(db: Db, userId: number): Promise<void> {
  await exec(db, "delete from user_replay_skins where user_id = ?", [userId]);
}
