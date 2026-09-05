import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, execBatch } from "../db.js";
import { listOwnedPackCardsForKeys, normalizePackCardKey, type StoredPackCard } from "./pack-wallets.js";
import { BINDER_MAX_CARDS, BINDER_MAX_PER_COLLECTOR, BINDER_NAME_MAX_CHARS } from "./pack-binder-limits.js";
export { BINDER_MAX_CARDS, BINDER_MAX_PER_COLLECTOR, BINDER_NAME_MAX_CHARS } from "./pack-binder-limits.js";

/* Player-made binders: named groups of a collector's own cards, kept in
   pack_binders / pack_binder_cards. The storage model is the showcase's,
   generalized: a binder holds card keys, and every read joins them back onto
   pack_collection_cards with copies > 0, so a card the owner recycled away
   falls out of its binder without anything having to clean up after it.
   A binder can be marked showcased, which is the only thing that puts it on
   the owner's public shelf and the grouped Showcase gallery. */

export type PackBinderErrorCode = "binder_limit" | "invalid_name" | "unknown_binder" | "binder_full";

export class PackBinderError extends Error {
  constructor(public readonly code: PackBinderErrorCode) {
    super(code);
    this.name = "PackBinderError";
  }
}

export interface PackBinder {
  id: number;
  name: string;
  position: number;
  showcased: boolean;
  createdAt: number;
  updatedAt: number;
  cards: StoredPackCard[];
}

/* Trimmed, whitespace-collapsed and stripped of control characters, since a
   binder name is a heading on a public shelf and nothing else. Null for
   anything that is empty once that is done. */
export function normalizePackBinderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, BINDER_NAME_MAX_CHARS);
}

function normalizeId(value: unknown): number {
  const id = Math.floor(Number(value));
  return Number.isInteger(id) && id > 0 ? id : 0;
}

async function attachCards(db: Db, ownerUserId: number, rows: Record<string, unknown>[]): Promise<PackBinder[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => Number(row.id));
  const placeholders = ids.map(() => "?").join(", ");
  const cardRows = (await exec(
    db,
    `select binder_id, card_key from pack_binder_cards
     where binder_id in (${placeholders})
     order by binder_id asc, position asc`,
    ids,
  )).rows;
  const keysByBinder = new Map<number, string[]>();
  for (const row of cardRows) {
    const binderId = Number(row.binder_id);
    const list = keysByBinder.get(binderId) ?? [];
    list.push(String(row.card_key));
    keysByBinder.set(binderId, list);
  }
  const binders: PackBinder[] = [];
  const allKeys = [...new Set([...keysByBinder.values()].flat())];
  const ownedCards = await listOwnedPackCardsForKeys(db, ownerUserId, allKeys);
  const cardsByKey = new Map(ownedCards.map((card) => [card.cardKey, card]));
  for (const row of rows) {
    const id = Number(row.id);
    binders.push({
      id,
      name: String(row.name ?? ""),
      position: Number(row.position) || 0,
      showcased: Number(row.showcased) === 1,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      cards: (keysByBinder.get(id) ?? []).flatMap((key) => cardsByKey.has(key) ? [cardsByKey.get(key)!] : []),
    });
  }
  return binders;
}

export async function listPackBinders(db: Db, ownerUserId: number): Promise<PackBinder[]> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return [];
  const rows = (await exec(
    db,
    `select id, name, position, showcased, created_at, updated_at
     from pack_binders where owner_user_id = ?
     order by position asc, id asc`,
    [ownerUserId],
  )).rows as unknown as Record<string, unknown>[];
  return attachCards(db, ownerUserId, rows);
}

/* The public half: only the binders their owner chose to show. */
export async function listShowcasedPackBinders(db: Db, ownerUserId: number): Promise<PackBinder[]> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return [];
  const rows = (await exec(
    db,
    `select id, name, position, showcased, created_at, updated_at
     from pack_binders where owner_user_id = ? and showcased = 1
       and (select count(*) from pack_binder_cards where binder_id = pack_binders.id) <= ${BINDER_MAX_CARDS}
     order by position asc, id asc`,
    [ownerUserId],
  )).rows as unknown as Record<string, unknown>[];
  return attachCards(db, ownerUserId, rows);
}

async function requireOwnedBinder(db: Db, ownerUserId: number, binderId: number): Promise<number> {
  const id = normalizeId(binderId);
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0 || id <= 0) throw new PackBinderError("unknown_binder");
  const row = (await exec(
    db,
    "select id from pack_binders where id = ? and owner_user_id = ? limit 1",
    [id, ownerUserId],
  )).rows[0];
  if (!row) throw new PackBinderError("unknown_binder");
  return id;
}

export async function createPackBinder(db: Db, ownerUserId: number, name: unknown): Promise<number> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) throw new PackBinderError("unknown_binder");
  const cleanName = normalizePackBinderName(name);
  if (!cleanName) throw new PackBinderError("invalid_name");
  const now = Date.now();
  const inserted = await exec(
    db,
    `insert into pack_binders (owner_user_id, name, position, showcased, created_at, updated_at)
     select ?, ?, coalesce(max(position), -1) + 1, 0, ?, ?
     from pack_binders where owner_user_id = ?
     having count(*) < ?`,
    [ownerUserId, cleanName, now, now, ownerUserId, BINDER_MAX_PER_COLLECTOR],
  );
  if (inserted.rowsAffected === 0) throw new PackBinderError("binder_limit");
  return Number(inserted.lastInsertRowid ?? 0);
}

export async function renamePackBinder(db: Db, ownerUserId: number, binderId: number, name: unknown): Promise<void> {
  const id = await requireOwnedBinder(db, ownerUserId, binderId);
  const cleanName = normalizePackBinderName(name);
  if (!cleanName) throw new PackBinderError("invalid_name");
  await exec(
    db,
    "update pack_binders set name = ?, updated_at = ? where id = ? and owner_user_id = ?",
    [cleanName, Date.now(), id, ownerUserId],
  );
}

export async function deletePackBinder(db: Db, ownerUserId: number, binderId: number): Promise<void> {
  const id = await requireOwnedBinder(db, ownerUserId, binderId);
  await execBatch(db, [
    { sql: "delete from pack_binder_cards where binder_id = ?", args: [id] },
    { sql: "delete from pack_binders where id = ? and owner_user_id = ?", args: [id, ownerUserId] },
  ]);
}

export async function setPackBinderShowcased(
  db: Db,
  ownerUserId: number,
  binderId: number,
  showcased: boolean,
): Promise<void> {
  const id = await requireOwnedBinder(db, ownerUserId, binderId);
  if (showcased) {
    const count = Number((await exec(db, "select count(*) as n from pack_binder_cards where binder_id = ?", [id])).rows[0]?.n ?? 0);
    if (count > BINDER_MAX_CARDS) throw new PackBinderError("binder_full");
  }
  await exec(
    db,
    "update pack_binders set showcased = ?, updated_at = ? where id = ? and owner_user_id = ?",
    [showcased ? 1 : 0, Date.now(), id, ownerUserId],
  );
}

/* Replaces a binder's cards with the given keys, in order. Malformed and
   unowned keys are dropped rather than rejected, the way the showcase does
   it, so a client holding a stale collection converges instead of erroring.
   A card already in the binder keeps the stamp it went in with. Returns the
   keys that actually landed. */
export async function setPackBinderCards(
  db: Db,
  ownerUserId: number,
  binderId: number,
  cardKeys: unknown,
): Promise<string[]> {
  const id = await requireOwnedBinder(db, ownerUserId, binderId);
  const requested = Array.isArray(cardKeys)
    ? [...new Set(cardKeys.map(normalizePackCardKey).filter((key): key is string => key !== null))]
    : [];
  if (requested.length > BINDER_MAX_CARDS) throw new PackBinderError("binder_full");
  let kept: string[] = [];
  if (requested.length > 0) {
    const placeholders = requested.map(() => "?").join(", ");
    const ownedRows = (await exec(
      db,
      `select card_key from pack_collection_cards
       where owner_user_id = ? and copies > 0 and card_key in (${placeholders})`,
      [ownerUserId, ...requested],
    )).rows;
    const owned = new Set(ownedRows.map((row) => String(row.card_key)));
    kept = requested.filter((key) => owned.has(key));
  }
  const now = Date.now();
  const stampedAt = new Map(
    (await exec(
      db,
      "select card_key, added_at from pack_binder_cards where binder_id = ?",
      [id],
    )).rows.map((row) => [String(row.card_key), Number(row.added_at) || now]),
  );
  await execBatch(db, [
    { sql: "delete from pack_binder_cards where binder_id = ?", args: [id] },
    ...kept.map((key, position) => ({
      sql: "insert into pack_binder_cards (binder_id, card_key, position, added_at) values (?, ?, ?, ?)",
      args: [id, key, position, stampedAt.get(key) ?? now] as InValue[],
    })),
    {
      sql: "update pack_binders set updated_at = ? where id = ? and owner_user_id = ?",
      args: [now, id, ownerUserId] as InValue[],
    },
  ]);
  return kept;
}

/* Append the entire selection in one statement. Both the additions and the
   capacity are materialized before inserting, so overlapping selections and
   concurrent requests cannot partially land or exceed the limit. Existing
   members keep their order and stamps; recycled/unowned cards are ignored. */
export async function addPackBinderCards(
  db: Db,
  ownerUserId: number,
  binderId: number,
  cardKeys: unknown,
): Promise<void> {
  const id = await requireOwnedBinder(db, ownerUserId, binderId);
  const requested = Array.isArray(cardKeys)
    ? [...new Set(cardKeys.map(normalizePackCardKey).filter((key): key is string => key !== null))]
    : [];
  if (requested.length > BINDER_MAX_CARDS) throw new PackBinderError("binder_full");
  if (requested.length === 0) return;
  const now = Date.now();
  const inserted = await exec(db,
    `with requested(card_key, position) as (values ${requested.map((_, index) => `(?, ${index})`).join(", ")}),
     additions as materialized (
       select r.card_key, r.position from requested r
       join pack_collection_cards c on c.owner_user_id = ? and c.card_key = r.card_key and c.copies > 0
       where not exists (select 1 from pack_binder_cards bc where bc.binder_id = ? and bc.card_key = r.card_key)
     ), capacity as materialized (
       select count(*) as total, coalesce(max(position), -1) as last_position from pack_binder_cards where binder_id = ?
     )
     insert into pack_binder_cards (binder_id, card_key, position, added_at)
     select ?, a.card_key, capacity.last_position + 1 + a.position, ? from additions a cross join capacity
     where capacity.total + (select count(*) from additions) <= ?
       and exists (select 1 from pack_binders where id = ? and owner_user_id = ?)`,
    [...requested, ownerUserId, id, id, id, now, BINDER_MAX_CARDS, id, ownerUserId],
  );
  if (inserted.rowsAffected === 0) {
    // No additions is a successful no-op when all held cards already belong.
    const missing = (await exec(db,
      `select 1 from pack_collection_cards c where c.owner_user_id = ? and c.copies > 0
       and c.card_key in (${requested.map(() => "?").join(", ")})
       and not exists (select 1 from pack_binder_cards bc where bc.binder_id = ? and bc.card_key = c.card_key) limit 1`,
      [ownerUserId, ...requested, id],
    )).rows.length > 0;
    if (missing) throw new PackBinderError("binder_full");
    return;
  }
  await exec(db, "update pack_binders set updated_at = ? where id = ? and owner_user_id = ?", [now, id, ownerUserId]);
}

/* Compatibility for older clients that still send add_card. */
export async function addPackBinderCard(db: Db, ownerUserId: number, binderId: number, cardKey: unknown): Promise<boolean> {
  await addPackBinderCards(db, ownerUserId, binderId, [cardKey]);
  const key = normalizePackCardKey(cardKey);
  if (!key) return false;
  return (await exec(db, "select 1 from pack_binder_cards where binder_id = ? and card_key = ?", [binderId, key])).rows.length > 0;
}

/* Reorders the owner's binders to the given order. Ids that are not theirs
   are ignored, and any binder the list leaves out keeps its place after the
   ones it names. */
export async function reorderPackBinders(db: Db, ownerUserId: number, ids: unknown): Promise<void> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) throw new PackBinderError("unknown_binder");
  const requested = Array.isArray(ids)
    ? [...new Set(ids.map(normalizeId).filter((id) => id > 0))].slice(0, BINDER_MAX_PER_COLLECTOR * 4)
    : [];
  const existing = (await exec(
    db,
    "select id from pack_binders where owner_user_id = ? order by position asc, id asc",
    [ownerUserId],
  )).rows.map((row) => Number(row.id));
  const owned = new Set(existing);
  const ordered = [...requested.filter((id) => owned.has(id))];
  for (const id of existing) if (!ordered.includes(id)) ordered.push(id);
  if (ordered.length === 0) return;
  const now = Date.now();
  await execBatch(
    db,
    ordered.map((id, position) => ({
      sql: "update pack_binders set position = ?, updated_at = ? where id = ? and owner_user_id = ?",
      args: [position, now, id, ownerUserId] as InValue[],
    })),
  );
}
