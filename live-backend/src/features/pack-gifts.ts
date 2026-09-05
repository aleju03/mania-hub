import { randomUUID } from "node:crypto";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch } from "../db.js";
import { logInfo } from "../logger.js";
import { getPackCollectionCard, normalizePackCardKey, type StoredPackCard } from "./pack-wallets.js";
import { mintPackCardSerialStatement } from "./pack-serials.js";

export const PACK_GIFT_DAILY_CAP = 10;
const GIFT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUEST_ID = /^[a-zA-Z0-9_-]{16,80}$/;
export interface GiftCollector { userId: number; username: string; avatarUrl: string; countryCode: string | null }
export type PackGiftError = "invalid_request" | "self_gift" | "recipient_not_found" | "no_spare" | "card_not_ready" | "unverified_card" | "special_card" | "daily_limit" | "collection_changed";
export type PackGiftResult = { ok: true; giftId: number; recipient: GiftCollector; remainingCopies: number; replayed: boolean } | { ok: false; error: PackGiftError };
export interface PackGiftReceipt { id: number; sender: GiftCollector; card: StoredPackCard | null }

const COLLECTOR_SELECT = `select w.user_id,
  coalesce(nullif(u.username, ''), nullif(w.owner_username, ''), 'user ' || w.user_id) as username,
  coalesce(nullif(u.avatar_url, ''), 'https://a.ppy.sh/' || w.user_id) as avatar_url,
  u.country_code from pack_wallets w left join users u on u.user_id = w.user_id`;
function collectorFromRow(row: Record<string, unknown>): GiftCollector {
  return { userId: Number(row.user_id), username: String(row.username), avatarUrl: String(row.avatar_url), countryCode: row.country_code ? String(row.country_code) : null };
}
async function giftCollector(db: Db, userId: number): Promise<GiftCollector | null> {
  const row = (await exec(db, `${COLLECTOR_SELECT} where w.user_id = ?`, [userId])).rows[0];
  return row ? collectorFromRow(row as Record<string, unknown>) : null;
}
export async function searchGiftCollectors(db: Db, senderUserId: number, rawQuery: string): Promise<GiftCollector[]> {
  const query = rawQuery.trim().slice(0, 32);
  if (query.length < 2) return [];
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const id = /^\d+$/.test(query) ? Number(query) : 0;
  const rows = (await exec(db, `${COLLECTOR_SELECT} where w.user_id != ? and
    (w.user_id = ? or coalesce(nullif(u.username, ''), w.owner_username, '') like ? escape '\\')
    order by case when w.user_id = ? then 0 else 1 end, username collate nocase, w.user_id limit 8`,
    [senderUserId, id, pattern, id])).rows;
  return rows.map((row) => collectorFromRow(row as Record<string, unknown>));
}

/** A gift is a transfer, not a mint or recycle reward. The event and both
 * holdings are committed together, and all statements require this request's
 * winning claim token. A duplicate HTTP request cannot send a second copy.
 */
export async function sendPackGift(db: Db, senderUserId: number, input: { recipientUserId: number; cardKey: string; requestId: string }, now = Date.now()): Promise<PackGiftResult> {
  const key = normalizePackCardKey(input?.cardKey);
  if (!Number.isSafeInteger(senderUserId) || senderUserId <= 0 || !Number.isSafeInteger(input?.recipientUserId) || input.recipientUserId <= 0 || !key || !REQUEST_ID.test(input?.requestId ?? "")) return { ok: false, error: "invalid_request" };
  const recipientId = input.recipientUserId;
  if (senderUserId === recipientId) return { ok: false, error: "self_gift" };
  const prior = (await exec(db, "select id, recipient_user_id, card_key from pack_gifts where sender_user_id = ? and request_id = ?", [senderUserId, input.requestId])).rows[0];
  if (prior && (Number(prior.recipient_user_id) !== recipientId || String(prior.card_key) !== key)) return { ok: false, error: "invalid_request" };
  const recipient = await giftCollector(db, recipientId);
  const sender = await giftCollector(db, senderUserId);
  if (!recipient) return { ok: false, error: "recipient_not_found" };
  if (!sender) return { ok: false, error: "invalid_request" };
  const source = (await exec(db, "select * from pack_collection_cards where owner_user_id = ? and card_key = ?", [senderUserId, key])).rows[0];
  if (prior) return { ok: true, giftId: Number(prior.id), recipient, remainingCopies: Number(source?.copies ?? 0), replayed: true };
  // A matching request may have committed while this one resolved names or
  // checked its balance. Successful delivery takes priority over a stale refusal.
  const refuse = async (error: PackGiftError): Promise<PackGiftResult> => {
    const completed = (await exec(db, "select id, recipient_user_id, card_key from pack_gifts where sender_user_id = ? and request_id = ?", [senderUserId, input.requestId])).rows[0];
    if (!completed) return { ok: false, error };
    if (Number(completed.recipient_user_id) !== recipientId || String(completed.card_key) !== key) return { ok: false, error: "invalid_request" };
    const remaining = Number((await exec(db, "select copies from pack_collection_cards where owner_user_id = ? and card_key = ?", [senderUserId, key])).rows[0]?.copies ?? 0);
    return { ok: true, giftId: Number(completed.id), recipient, remainingCopies: remaining, replayed: true };
  };
  if (!source || Number(source.copies) < 2) return refuse("no_spare");
  // Unsynced imports cannot be exported as verified gifts. A normal server
  // deal establishes eligibility; descriptions/stats must have finished minting.
  if (Number(source.completion_eligible) !== 1) return refuse("unverified_card");
  if (!source.tier || source.skills_id == null) return refuse("card_not_ready");
  // Award-style Eternal variants are interpreted as a collector's own ending.
  // Passing one on would retire the recipient's completion reward by mistake.
  // Circulating <player>:eternal cards remain giftable as ordinary spare pulls.
  if (source.tier === "eternal" && key !== `${source.card_user_id}:eternal`) return refuse("special_card");
  const used = Number((await exec(db, "select count(*) as n from pack_gifts where sender_user_id = ? and sent_at > ?", [senderUserId, now - GIFT_WINDOW_MS])).rows[0]?.n ?? 0);
  if (used >= PACK_GIFT_DAILY_CAP) return refuse("daily_limit");
  const token = randomUUID();
  const gate = "exists (select 1 from pack_gifts where sender_user_id = ? and request_id = ? and claim_token = ?)";
  const gateArgs = [senderUserId, input.requestId, token];
  const statements: DbStatement[] = [{
    sql: `insert or ignore into pack_gifts (sender_user_id, recipient_user_id, request_id, claim_token, sender_username, recipient_username, card_key, card_user_id, sent_at)
      select ?, ?, ?, ?, ?, ?, ?, ?, ? where
      exists (select 1 from pack_collection_cards where owner_user_id = ? and card_key = ? and copies > 1
        and completion_eligible = 1 and tier is not null and skills_id is not null
        and (tier != 'eternal' or card_key = cast(card_user_id as text) || ':eternal'))
      and exists (select 1 from pack_wallets where user_id = ?)
      and (select count(*) from pack_gifts where sender_user_id = ? and sent_at > ?) < ?`,
    args: [senderUserId, recipientId, input.requestId, token, sender.username, recipient.username, key, Number(source.card_user_id), now,
      senderUserId, key, recipientId, senderUserId, now - GIFT_WINDOW_MS, PACK_GIFT_DAILY_CAP],
  }, {
    // New holdings inherit the sender's frozen appearance. Someone who already
    // holds this key keeps their own snapshot; a gift cannot repaint their card.
    sql: `insert into pack_collection_cards (owner_user_id, card_user_id, card_key, tier, skills_id, pp, global_rank,
      copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at, tier_label, motif, granted_at, completion_eligible)
      select ?, s.card_user_id, s.card_key, s.tier, s.skills_id, s.pp, s.global_rank,
        1, 0, ?, ?, ?, s.tier_label, s.motif, ?, s.completion_eligible
      from pack_collection_cards s where s.owner_user_id = ? and s.card_key = ? and ${gate}
      on conflict(owner_user_id, card_key) do update set copies = pack_collection_cards.copies + 1,
        updated_at = excluded.updated_at,
        completion_eligible = max(pack_collection_cards.completion_eligible, excluded.completion_eligible)`,
    args: [recipientId, now, now, now, now, senderUserId, key, ...gateArgs],
  }, {
    sql: `update pack_collection_cards set copies = copies - 1, updated_at = ? where owner_user_id = ? and card_key = ? and ${gate}`,
    args: [now, senderUserId, key, ...gateArgs],
  }];
  // Keep the sender's serial and allocate the recipient's own serial, settled:
  // neither a fresh pull-feed report nor first-find credit comes from a gift.
  for (const [owner, at] of [[senderUserId, Number(source.first_pulled_at) || now], [recipientId, now]]) {
    const mint = mintPackCardSerialStatement(key, Number(source.card_user_id), owner, at);
    statements.push({ sql: `${mint.sql} where ${gate}`, args: [...(mint.args ?? []), ...gateArgs] });
  }
  // Wishes are for missing ordinary cards; a gift can fulfill one too.
  statements.push({
    sql: `delete from pack_wishlist where owner_user_id = ? and cast(card_user_id as text) = ? and ${gate}`,
    args: [recipientId, key, ...gateArgs],
  });
  const applied = await execBatch(db, statements);
  const saved = (await exec(db, "select id, recipient_user_id, card_key from pack_gifts where sender_user_id = ? and request_id = ?", [senderUserId, input.requestId])).rows[0];
  if (!saved) return { ok: false, error: "collection_changed" };
  if (Number(saved.recipient_user_id) !== recipientId || String(saved.card_key) !== key) return { ok: false, error: "invalid_request" };
  const remaining = Number((await exec(db, "select copies from pack_collection_cards where owner_user_id = ? and card_key = ?", [senderUserId, key])).rows[0]?.copies ?? 0);
  const replayed = Number(applied[0]?.rowsAffected ?? 0) === 0;
  if (!replayed) logInfo("pack_gift_sent", { senderUserId, recipientUserId: recipientId, cardKey: key, giftId: Number(saved.id) });
  return { ok: true, giftId: Number(saved.id), recipient, remainingCopies: remaining, replayed };
}

export async function listPackGiftInbox(db: Db, ownerUserId: number): Promise<{ gifts: PackGiftReceipt[]; total: number }> {
  const rows = (await exec(db, "select id, sender_user_id, sender_username, card_key from pack_gifts where recipient_user_id = ? and seen_at is null order by sent_at desc, id desc limit 20", [ownerUserId])).rows;
  const total = Number((await exec(db, "select count(*) as n from pack_gifts where recipient_user_id = ? and seen_at is null", [ownerUserId])).rows[0]?.n ?? 0);
  const gifts: PackGiftReceipt[] = [];
  for (const row of rows) {
    const sender = await giftCollector(db, Number(row.sender_user_id));
    gifts.push({ id: Number(row.id), sender: sender ?? { userId: Number(row.sender_user_id), username: String(row.sender_username), avatarUrl: `https://a.ppy.sh/${row.sender_user_id}`, countryCode: null }, card: await getPackCollectionCard(db, ownerUserId, String(row.card_key)) });
  }
  return { gifts, total };
}
export async function acknowledgePackGifts(db: Db, ownerUserId: number, ids: unknown, now = Date.now()): Promise<void> {
  const safe = Array.isArray(ids) ? [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 20) : [];
  if (safe.length === 0) return;
  await exec(db, `update pack_gifts set seen_at = ? where recipient_user_id = ? and id in (${safe.map(() => "?").join(',')}) and seen_at is null`, [now, ownerUserId, ...safe]);
}
