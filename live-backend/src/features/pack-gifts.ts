import { randomUUID } from "node:crypto";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch } from "../db.js";
import { logInfo } from "../logger.js";
import { getPackCollectionCard, normalizePackCardKey, type StoredPackCard } from "./pack-wallets.js";
import { mintPackCardSerialStatement } from "./pack-serials.js";

const REQUEST_ID = /^[a-zA-Z0-9_-]{16,80}$/;
export const GIFT_MESSAGE_MAX_CHARS = 140;
/* A note the recipient reads on the receipt and nowhere else. Trimmed, stripped
   of control characters and capped, with line breaks collapsed to spaces since
   the receipt is one paragraph. Null for anything empty once that is done. */
export function normalizePackGiftMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, GIFT_MESSAGE_MAX_CHARS).trim() : null;
}
export interface GiftCollector { userId: number; username: string; avatarUrl: string; countryCode: string | null }
export type PackGiftError = "invalid_request" | "self_gift" | "recipient_not_found" | "no_spare" | "card_not_ready" | "unverified_card" | "special_card" | "collection_changed" | "gift_not_found";
export type PackGiftStatus = "pending" | "accepted" | "declined";
export type PackGiftResult = { ok: true; giftId: number; recipient: GiftCollector; remainingCopies: number; replayed: boolean } | { ok: false; error: PackGiftError };
export type PackGiftDecision = { ok: true; giftId: number; status: PackGiftStatus } | { ok: false; error: PackGiftError };
export interface PackGiftReceipt { id: number; sender: GiftCollector; card: StoredPackCard | null; message: string | null; status: PackGiftStatus }

/* What the sender's holding must still look like for its offer to be worth a
   copy: held, verified, with a settled snapshot, and not an award Eternal. A
   collector may give away their only copy, exactly as they may recycle it, so
   this asks for a copy rather than a spare. The same predicate guards the offer
   and, at the other end, the acceptance. */
const GIFTABLE_SQL = `c.copies > 0 and c.completion_eligible = 1 and c.tier is not null and c.skills_id is not null
  and (c.tier != 'eternal' or c.card_key = cast(c.card_user_id as text) || ':eternal')`;

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

/** Sending is an offer, not the transfer: the copy stays in the sender's
 * collection until the recipient accepts it (acceptPackGift), and a declined
 * offer moves nothing at all. The row is idempotent on this request's id, so a
 * duplicate HTTP request cannot offer a second copy.
 * `remainingCopies` is what the sender holds right now, which a pending offer
 * does not change.
 */
export async function sendPackGift(db: Db, senderUserId: number, input: { recipientUserId: number; cardKey: string; requestId: string; message?: unknown }, now = Date.now()): Promise<PackGiftResult> {
  const key = normalizePackCardKey(input?.cardKey);
  const message = normalizePackGiftMessage(input?.message);
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
  if (!source || Number(source.copies) < 1) return refuse("no_spare");
  // Unsynced imports cannot be exported as verified gifts. A normal server
  // deal establishes eligibility; descriptions/stats must have finished minting.
  if (Number(source.completion_eligible) !== 1) return refuse("unverified_card");
  if (!source.tier || source.skills_id == null) return refuse("card_not_ready");
  // Award-style Eternal variants are interpreted as a collector's own ending.
  // Passing one on would retire the recipient's completion reward by mistake.
  // Circulating <player>:eternal cards remain giftable as ordinary spare pulls.
  if (source.tier === "eternal" && key !== `${source.card_user_id}:eternal`) return refuse("special_card");
  // An offer promises a copy without moving it. Count the ones already out so
  // a collector cannot promise the same copy twice; the card stays theirs, and
  // theirs to recycle, until someone accepts.
  const pending = Number((await exec(db, "select count(*) as n from pack_gifts where sender_user_id = ? and card_key = ? and status = 'pending'", [senderUserId, key])).rows[0]?.n ?? 0);
  if (Number(source.copies) - pending < 1) return refuse("no_spare");
  const statements: DbStatement[] = [{
    sql: `insert or ignore into pack_gifts (sender_user_id, recipient_user_id, request_id, claim_token, sender_username, recipient_username, card_key, card_user_id, message, status, sent_at)
      select ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ? where
      exists (select 1 from pack_collection_cards c where c.owner_user_id = ? and c.card_key = ? and ${GIFTABLE_SQL}
        and c.copies - (select count(*) from pack_gifts g where g.sender_user_id = c.owner_user_id and g.card_key = c.card_key and g.status = 'pending') > 0)
      and exists (select 1 from pack_wallets where user_id = ?)`,
    args: [senderUserId, recipientId, input.requestId, randomUUID(), sender.username, recipient.username, key, Number(source.card_user_id), message, now,
      senderUserId, key, recipientId],
  }];
  const applied = await execBatch(db, statements);
  const saved = (await exec(db, "select id, recipient_user_id, card_key from pack_gifts where sender_user_id = ? and request_id = ?", [senderUserId, input.requestId])).rows[0];
  if (!saved) return { ok: false, error: "collection_changed" };
  if (Number(saved.recipient_user_id) !== recipientId || String(saved.card_key) !== key) return { ok: false, error: "invalid_request" };
  const remaining = Number((await exec(db, "select copies from pack_collection_cards where owner_user_id = ? and card_key = ?", [senderUserId, key])).rows[0]?.copies ?? 0);
  const replayed = Number(applied[0]?.rowsAffected ?? 0) === 0;
  if (!replayed) logInfo("pack_gift_sent", { senderUserId, recipientUserId: recipientId, cardKey: key, giftId: Number(saved.id) });
  return { ok: true, giftId: Number(saved.id), recipient, remainingCopies: remaining, replayed };
}

/** Accepting is the transfer the offer only promised: both holdings, both
 * serials and the gift row commit together, gated on this acceptance's winning
 * claim token, so a double-tap or a second tab cannot deliver two copies. The
 * sender's spare is checked here rather than at send time, since they kept it
 * in the meantime and may have recycled or gifted it away.
 */
export async function acceptPackGift(db: Db, recipientUserId: number, giftId: unknown, now = Date.now()): Promise<PackGiftDecision> {
  const gift = await pendingGift(db, recipientUserId, giftId);
  if ("error" in gift) return gift;
  if (gift.status !== "pending") return { ok: true, giftId: gift.id, status: gift.status };
  const senderUserId = gift.senderUserId, key = gift.cardKey;
  const source = (await exec(db, "select * from pack_collection_cards where owner_user_id = ? and card_key = ?", [senderUserId, key])).rows[0];
  if (!source || Number(source.copies) < 1) return { ok: false, error: "no_spare" };
  if (Number(source.completion_eligible) !== 1) return { ok: false, error: "unverified_card" };
  if (!source.tier || source.skills_id == null) return { ok: false, error: "card_not_ready" };
  const token = randomUUID();
  const gate = "exists (select 1 from pack_gifts where id = ? and claim_token = ? and status = 'accepted')";
  const gateArgs = [gift.id, token];
  const statements: DbStatement[] = [{
    // The claim and the sender's spare are one condition: a gift that cannot be
    // paid for stays pending, rather than reading as accepted with nothing sent.
    sql: `update pack_gifts set status = 'accepted', resolved_at = ?, claim_token = ? where id = ? and recipient_user_id = ? and status = 'pending'
      and exists (select 1 from pack_collection_cards c where c.owner_user_id = pack_gifts.sender_user_id and c.card_key = pack_gifts.card_key and ${GIFTABLE_SQL})`,
    args: [now, token, gift.id, recipientUserId],
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
    args: [recipientUserId, now, now, now, now, senderUserId, key, ...gateArgs],
  }, {
    // Down to zero when it was their only copy: a zero-copy row is the same
    // tombstone recycling every copy leaves, and reads as no longer held.
    sql: `update pack_collection_cards set copies = copies - 1, updated_at = ? where owner_user_id = ? and card_key = ? and ${gate}`,
    args: [now, senderUserId, key, ...gateArgs],
  }];
  // Keep the sender's serial and allocate the recipient's own serial, settled:
  // neither a fresh pull-feed report nor first-find credit comes from a gift.
  for (const [owner, at] of [[senderUserId, Number(source.first_pulled_at) || now], [recipientUserId, now]]) {
    const mint = mintPackCardSerialStatement(key, Number(source.card_user_id), owner, at);
    statements.push({ sql: `${mint.sql} where ${gate}`, args: [...(mint.args ?? []), ...gateArgs] });
  }
  // Wishes are for missing ordinary cards; a gift can fulfill one too.
  statements.push({
    sql: `delete from pack_wishlist where owner_user_id = ? and cast(card_user_id as text) = ? and ${gate}`,
    args: [recipientUserId, key, ...gateArgs],
  });
  await execBatch(db, statements);
  const status = await giftStatus(db, gift.id);
  if (status !== "accepted") return { ok: false, error: "no_spare" };
  logInfo("pack_gift_accepted", { senderUserId, recipientUserId, cardKey: key, giftId: gift.id });
  return { ok: true, giftId: gift.id, status: "accepted" };
}

/** Declining moves nothing: the copy never left the sender, so the row is
 * closed and the receipt is marked read in the same write. */
export async function declinePackGift(db: Db, recipientUserId: number, giftId: unknown, now = Date.now()): Promise<PackGiftDecision> {
  const gift = await pendingGift(db, recipientUserId, giftId);
  if ("error" in gift) return gift;
  if (gift.status !== "pending") return { ok: true, giftId: gift.id, status: gift.status };
  await exec(db, "update pack_gifts set status = 'declined', resolved_at = ?, seen_at = ? where id = ? and recipient_user_id = ? and status = 'pending'", [now, now, gift.id, recipientUserId]);
  const status = await giftStatus(db, gift.id);
  if (status === "declined") logInfo("pack_gift_declined", { senderUserId: gift.senderUserId, recipientUserId, cardKey: gift.cardKey, giftId: gift.id });
  return { ok: true, giftId: gift.id, status: status ?? "declined" };
}

async function pendingGift(db: Db, recipientUserId: number, giftId: unknown): Promise<{ id: number; senderUserId: number; cardKey: string; status: PackGiftStatus } | { ok: false; error: PackGiftError }> {
  const id = Math.floor(Number(giftId));
  if (!Number.isSafeInteger(recipientUserId) || recipientUserId <= 0 || !Number.isSafeInteger(id) || id <= 0) return { ok: false, error: "invalid_request" };
  const row = (await exec(db, "select id, sender_user_id, card_key, status from pack_gifts where id = ? and recipient_user_id = ?", [id, recipientUserId])).rows[0];
  if (!row) return { ok: false, error: "gift_not_found" };
  return { id: Number(row.id), senderUserId: Number(row.sender_user_id), cardKey: String(row.card_key), status: String(row.status) as PackGiftStatus };
}
async function giftStatus(db: Db, giftId: number): Promise<PackGiftStatus | null> {
  const row = (await exec(db, "select status from pack_gifts where id = ?", [giftId])).rows[0];
  return row ? (String(row.status) as PackGiftStatus) : null;
}

/* Everything waiting on this collector: offers to answer, plus the cards they
   accepted and have not closed the receipt on yet. A declined offer is closed
   as it is declined and never comes back. A pending offer shows the sender's
   own holding as its face, with that holding's owner-specific numbers replaced
   by the reader's, since the card is not theirs yet. */
const INBOX_WHERE = "recipient_user_id = ? and seen_at is null and status != 'declined'";
export async function listPackGiftInbox(db: Db, ownerUserId: number, requestedPage: unknown = 0): Promise<{ gifts: PackGiftReceipt[]; total: number; page: number }> {
  const total = Number((await exec(db, `select count(*) as n from pack_gifts where ${INBOX_WHERE}`, [ownerUserId])).rows[0]?.n ?? 0);
  const parsedPage = Number(requestedPage);
  const page = Math.min(Number.isSafeInteger(parsedPage) && parsedPage >= 0 ? parsedPage : 0, Math.max(0, Math.ceil(total / 20) - 1));
  const rows = (await exec(db, `select id, sender_user_id, sender_username, card_key, message, status from pack_gifts where ${INBOX_WHERE} order by sent_at desc, id desc limit 20 offset ?`, [ownerUserId, page * 20])).rows;
  const gifts: PackGiftReceipt[] = [];
  for (const row of rows) {
    const sender = await giftCollector(db, Number(row.sender_user_id));
    const key = String(row.card_key);
    const status = String(row.status) as PackGiftStatus;
    gifts.push({
      id: Number(row.id),
      sender: sender ?? { userId: Number(row.sender_user_id), username: String(row.sender_username), avatarUrl: `https://a.ppy.sh/${row.sender_user_id}`, countryCode: null },
      card: status === "pending" ? await offeredCard(db, Number(row.sender_user_id), ownerUserId, key) : await getPackCollectionCard(db, ownerUserId, key),
      message: row.message ? String(row.message) : null,
      status,
    });
  }
  return { gifts, total, page };
}
async function offeredCard(db: Db, senderUserId: number, ownerUserId: number, cardKey: string): Promise<StoredPackCard | null> {
  const offered = await getPackCollectionCard(db, senderUserId, cardKey);
  if (!offered) return null;
  const own = Number((await exec(db, "select copies from pack_collection_cards where owner_user_id = ? and card_key = ?", [ownerUserId, cardKey])).rows[0]?.copies ?? 0);
  return { ...offered, copies: own, recycledCopies: 0, serial: null, grantedAt: null };
}
/* Closing a receipt, not answering an offer: a pending gift stays in the inbox
   until it is accepted or declined. */
export async function acknowledgePackGifts(db: Db, ownerUserId: number, ids: unknown, now = Date.now()): Promise<void> {
  const safe = Array.isArray(ids) ? [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 20) : [];
  if (safe.length === 0) return;
  await exec(db, `update pack_gifts set seen_at = ? where recipient_user_id = ? and id in (${safe.map(() => "?").join(',')}) and seen_at is null and status != 'pending'`, [now, ownerUserId, ...safe]);
}
