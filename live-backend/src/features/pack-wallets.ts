import type { Db } from "../db.js";
import { exec } from "../db.js";

// Synced maniacard pack collections. The wallet is an opaque JSON blob owned
// by the frontend (it merges device copies itself with monotonic counters);
// this module only stores it with optimistic concurrency so two devices
// pushing stale state get a 409 plus the current blob to reconcile against.

export interface StoredPackWallet {
  payload: string;
  rev: number;
  updatedAt: number;
}

export type SavePackWalletResult =
  | { ok: true; rev: number }
  | { ok: false; current: StoredPackWallet };

export async function getPackWallet(db: Db, userId: number): Promise<StoredPackWallet | null> {
  const row = (await exec(db, "select payload, rev, updated_at from pack_wallets where user_id = ?", [userId])).rows[0];
  if (!row) return null;
  return { payload: String(row.payload), rev: Number(row.rev), updatedAt: Number(row.updated_at) };
}

export async function savePackWallet(
  db: Db,
  userId: number,
  payload: string,
  baseRev: number,
  now = Date.now(),
): Promise<SavePackWalletResult> {
  const existing = await getPackWallet(db, userId);
  if (!existing) {
    const inserted = await exec(
      db,
      "insert into pack_wallets (user_id, payload, rev, updated_at) values (?, ?, 1, ?) on conflict(user_id) do nothing",
      [userId, payload, now],
    );
    if (Number(inserted.rowsAffected ?? 0) > 0) return { ok: true, rev: 1 };
    // Lost an insert race; report the winner as a conflict.
    const current = await getPackWallet(db, userId);
    return current ? { ok: false, current } : { ok: true, rev: 1 };
  }
  const nextRev = existing.rev + 1;
  const updated = await exec(
    db,
    "update pack_wallets set payload = ?, rev = ?, updated_at = ? where user_id = ? and rev = ?",
    [payload, nextRev, now, userId, baseRev],
  );
  if (Number(updated.rowsAffected ?? 0) > 0) return { ok: true, rev: nextRev };
  const current = await getPackWallet(db, userId);
  return { ok: false, current: current ?? existing };
}
