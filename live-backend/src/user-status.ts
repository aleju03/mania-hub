import type { Db } from "./db.js";
import { exec } from "./db.js";

/**
 * An inactive users row is a durable suppression tombstone. It is deliberately
 * tiny and dependency-free because ingest, roster refreshes, profile reads and
 * workers all need to consult it without importing the much heavier purge
 * module (users.ts imports several feature modules itself).
 */
export async function isUserKnownInactive(db: Db, userId: number): Promise<boolean> {
  const safeUserId = Math.floor(Number(userId));
  if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0) return false;
  const row = (await exec(db, "select is_active from users where user_id = ? limit 1", [safeUserId])).rows[0];
  return row != null && Number(row.is_active ?? 1) === 0;
}

