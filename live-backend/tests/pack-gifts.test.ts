import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { acceptPackGift, acknowledgePackGifts, declinePackGift, listPackGiftInbox, normalizePackGiftMessage, searchGiftCollectors, sendPackGift } from "../src/features/pack-gifts.js";
import { getPackCollectionCard, isPackWalletEternalPending } from "../src/features/pack-wallets.js";
let dir: string;
let db: Db;
const SENDER = 101, RECIPIENT = 102, NOW = 1_780_000_000_000;
const motif = JSON.stringify({ url: "https://mania-tracker.com/images/card-finishes/aurora.svg", scale: 0.75, opacity: 0.65, palette: "aurora" });
const gift = (requestId = "gift-request-00000001", recipientUserId = RECIPIENT, cardKey = "77", message?: string) => ({ recipientUserId, cardKey, requestId, message });
/* The whole handover: an offer nobody answers moves nothing, so every test
   about the transfer itself sends and then accepts. */
async function deliver(requestId = "gift-request-00000001", recipientUserId = RECIPIENT, cardKey = "77", message?: string) {
  const sent = await sendPackGift(db, SENDER, gift(requestId, recipientUserId, cardKey, message), NOW);
  if (!sent.ok) return sent;
  const accepted = await acceptPackGift(db, recipientUserId, sent.giftId, NOW);
  return accepted.ok ? sent : accepted;
}
async function wallet(id: number, name: string) {
  await exec(db, "insert into pack_wallets (user_id,payload,rev,updated_at,owner_username) values (?, ?, 1, ?, ?)", [id, JSON.stringify({ cards: {}, shards: 100, openedPacks: 20 }), NOW, name]);
}
async function seedCard(owner = SENDER, key = "77", tier = "rare", copies = 3) {
  await exec(db, "insert or ignore into pack_cards (card_key,tier,card_user_id,username,avatar_url,country_code,updated_at) values (?, ?, 77, 'Friend', 'https://a.ppy.sh/77', 'CR', ?)", [key, tier, NOW]);
  await exec(db, `insert into pack_collection_cards (owner_user_id,card_user_id,card_key,tier,skills_id,pp,global_rank,copies,recycled_copies,first_pulled_at,last_pulled_at,updated_at,motif)
    values (?,77,?,?,1,1234,50,?,0,100,200,300,?)`, [owner, key, tier, copies, motif]);
}
async function copies(owner: number, key = "77") { return Number((await exec(db, "select copies from pack_collection_cards where owner_user_id=? and card_key=?", [owner, key])).rows[0]?.copies ?? 0); }
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-gifts-"));
  db = await createDb({ databaseUrl: `file:${join(dir,"test.db")}` }); await migrate(db);
  await wallet(SENDER, "Sender"); await wallet(RECIPIENT, "Recipient");
  await exec(db, "insert into pack_card_skills (id,skills_json) values (1, ?)", [JSON.stringify({ cardPower: 200, speed: 50, sampleSize: 20 })]);
  await seedCard();
});
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
it("transfers one frozen copy with distinct serials and no shard or public pull reward", async () => {
  const wallets = (await exec(db, "select payload from pack_wallets order by user_id")).rows;
  expect(await deliver()).toMatchObject({ ok: true, remainingCopies: 3, replayed: false });
  expect(await copies(SENDER)).toBe(2); expect(await copies(RECIPIENT)).toBe(1);
  expect(await getPackCollectionCard(db, RECIPIENT, "77")).toMatchObject({ username: "Friend", tier: "rare", pp: 1234, globalRank: 50, skills: { cardPower: 200 }, motif: JSON.parse(motif), grantedAt: NOW, serial: 2 });
  expect((await getPackCollectionCard(db, SENDER, "77"))?.serial).toBe(1);
  expect((await exec(db, "select * from pack_pull_events")).rows).toHaveLength(0);
  expect((await exec(db, "select payload from pack_wallets order by user_id")).rows).toEqual(wallets);
  expect((await exec(db, "select recycled_copies from pack_collection_cards where owner_user_id=?", [SENDER])).rows[0].recycled_copies).toBe(0);
  expect((await exec(db, "select pull_report_pending from pack_card_serials where owner_user_id=?", [RECIPIENT])).rows[0].pull_report_pending).toBe(0);
});
it("keeps the recipient's existing snapshot, label, serial and dates", async () => {
  await seedCard(RECIPIENT, "77", "legendary", 1);
  await exec(db, "update pack_collection_cards set pp=9999, tier_label='My card', motif=null where owner_user_id=?", [RECIPIENT]);
  await exec(db, "insert into pack_card_serials (card_key,card_user_id,owner_user_id,serial,minted_at,pull_report_pending) values ('77',77,?,5,100,1)", [RECIPIENT]);
  const before = (await exec(db, "select * from pack_collection_cards where owner_user_id=?", [RECIPIENT])).rows[0];
  await deliver();
  expect((await exec(db, "select * from pack_collection_cards where owner_user_id=?", [RECIPIENT])).rows[0]).toEqual({ ...before, copies: 2, updated_at: NOW });
  expect((await getPackCollectionCard(db, RECIPIENT, "77"))?.serial).toBe(5);
});
it("refuses self-gifts and unknown recipients", async () => {
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000002", SENDER), NOW)).toEqual({ ok:false, error:"self_gift" });
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000002", 999), NOW)).toEqual({ ok:false, error:"recipient_not_found" });
  expect(await copies(SENDER)).toBe(3); expect(await copies(RECIPIENT)).toBe(0);
});
it("gives away an only copy and leaves the tombstone a full recycle would", async () => {
  await exec(db, "update pack_collection_cards set copies=1 where owner_user_id=?", [SENDER]);
  expect((await deliver()).ok).toBe(true);
  expect(await copies(SENDER)).toBe(0); expect(await copies(RECIPIENT)).toBe(1);
  expect((await exec(db, "select recycled_copies from pack_collection_cards where owner_user_id=?", [SENDER])).rows[0].recycled_copies).toBe(0);
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000002"), NOW)).toEqual({ ok:false, error:"no_spare" });
});
it("promises no copy twice: offers already out are counted against the collection", async () => {
  await exec(db, "update pack_collection_cards set copies=1 where owner_user_id=?", [SENDER]);
  expect((await sendPackGift(db, SENDER, gift(), NOW)).ok).toBe(true);
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000002"), NOW)).toEqual({ ok:false, error:"no_spare" });
  expect(await copies(SENDER)).toBe(1);
});
it("cannot send another collector's card or an unverified import", async () => {
  await wallet(103,"Other");
  expect(await sendPackGift(db, 103, gift(), NOW)).toEqual({ ok:false, error:"no_spare" });
  await exec(db, "update pack_collection_cards set completion_eligible=0 where owner_user_id=?", [SENDER]);
  expect(await sendPackGift(db, SENDER, gift(), NOW)).toEqual({ ok:false, error:"unverified_card" });
  expect(await copies(SENDER)).toBe(3);
});
it("retries the same gift without a second transfer and rejects changed request contents", async () => {
  const first = await sendPackGift(db, SENDER, gift(), NOW), second = await sendPackGift(db, SENDER, gift(), NOW);
  expect(first.ok && second.ok && first.giftId === second.giftId).toBe(true);
  expect(second).toMatchObject({ ok: true, replayed: true });
  expect(first.ok && await acceptPackGift(db, RECIPIENT, first.giftId, NOW)).toMatchObject({ ok: true, status: "accepted" });
  expect(first.ok && await acceptPackGift(db, RECIPIENT, first.giftId, NOW)).toMatchObject({ ok: true, status: "accepted" });
  expect(await copies(SENDER)).toBe(2); expect(await copies(RECIPIENT)).toBe(1);
  await wallet(103,"Other");
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000001",103), NOW)).toEqual({ ok:false, error:"invalid_request" });
});
it("serializes simultaneous offers of the same single copy", async () => {
  await exec(db, "update pack_collection_cards set copies=1 where owner_user_id=?", [SENDER]);
  const results = await Promise.all([sendPackGift(db, SENDER, gift(), NOW), sendPackGift(db, SENDER, gift("gift-request-00000002"), NOW)]);
  expect(results.filter(r=>r.ok)).toHaveLength(1);
  expect(await copies(SENDER)).toBe(1); expect(await copies(RECIPIENT)).toBe(0);
});
it("delivers one copy for simultaneous acceptances of the same offer", async () => {
  const sent = await sendPackGift(db, SENDER, gift(), NOW);
  if (!sent.ok) throw new Error("offer failed");
  await Promise.all([acceptPackGift(db, RECIPIENT, sent.giftId, NOW), acceptPackGift(db, RECIPIENT, sent.giftId, NOW)]);
  expect(await copies(SENDER)).toBe(2); expect(await copies(RECIPIENT)).toBe(1);
});
it("handles duplicate simultaneous requests as one gift", async () => {
  const results = await Promise.all([sendPackGift(db, SENDER, gift(), NOW), sendPackGift(db, SENDER, gift(), NOW)]);
  expect(results.every(r=>r.ok)).toBe(true);
  const giftId = results[0].ok ? results[0].giftId : 0;
  expect((await acceptPackGift(db, RECIPIENT, giftId, NOW)).ok).toBe(true);
  expect(await copies(SENDER)).toBe(2); expect(await copies(RECIPIENT)).toBe(1);
});
it("rolls back the acceptance and both holdings if debiting fails", async () => {
  const sent = await sendPackGift(db, SENDER, gift(), NOW);
  if (!sent.ok) throw new Error("offer failed");
  await exec(db, `create trigger stop_gift before update of copies on pack_collection_cards when old.owner_user_id=101 begin select raise(abort,'test transfer failure'); end`);
  await expect(acceptPackGift(db, RECIPIENT, sent.giftId, NOW)).rejects.toThrow("test transfer failure");
  expect(await copies(SENDER)).toBe(3); expect(await copies(RECIPIENT)).toBe(0);
  expect((await exec(db,"select status from pack_gifts")).rows[0].status).toBe("pending");
  expect((await exec(db,"select * from pack_card_serials")).rows).toHaveLength(0);
});
it("carries a short message, trimmed of anything the receipt cannot show", async () => {
  expect(normalizePackGiftMessage("  hey\n\nthere  ")).toBe("hey there");
  expect(normalizePackGiftMessage("   ")).toBeNull();
  expect(normalizePackGiftMessage("x".repeat(300))).toHaveLength(140);
  expect(normalizePackGiftMessage(42)).toBeNull();
  await deliver("gift-request-00000001", RECIPIENT, "77", " enjoy\tit ");
  expect((await listPackGiftInbox(db, RECIPIENT)).gifts[0].message).toBe("enjoy it");
});
it("moves nothing until the offer is accepted, and nothing at all when it is declined", async () => {
  const sent = await sendPackGift(db, SENDER, gift(), NOW);
  if (!sent.ok) throw new Error("offer failed");
  expect(await copies(SENDER)).toBe(3); expect(await copies(RECIPIENT)).toBe(0);
  const pending = await listPackGiftInbox(db, RECIPIENT);
  expect(pending.total).toBe(1);
  expect(pending.gifts[0]).toMatchObject({ status: "pending", card: { username: "Friend", tier: "rare", copies: 0, serial: null } });
  // A pending offer is not a receipt to close.
  await acknowledgePackGifts(db, RECIPIENT, [sent.giftId], NOW);
  expect((await listPackGiftInbox(db, RECIPIENT)).total).toBe(1);
  expect(await declinePackGift(db, RECIPIENT, sent.giftId, NOW)).toMatchObject({ ok: true, status: "declined" });
  expect(await copies(SENDER)).toBe(3); expect(await copies(RECIPIENT)).toBe(0);
  expect((await listPackGiftInbox(db, RECIPIENT)).total).toBe(0);
  expect((await exec(db, "select * from pack_card_serials")).rows).toHaveLength(0);
  // Answering twice keeps the first answer.
  expect(await acceptPackGift(db, RECIPIENT, sent.giftId, NOW)).toMatchObject({ ok: true, status: "declined" });
  expect(await copies(RECIPIENT)).toBe(0);
});
it("refuses an acceptance the sender can no longer pay for, and keeps it answerable", async () => {
  const sent = await sendPackGift(db, SENDER, gift(), NOW);
  if (!sent.ok) throw new Error("offer failed");
  await exec(db, "update pack_collection_cards set copies=0 where owner_user_id=?", [SENDER]);
  expect(await acceptPackGift(db, RECIPIENT, sent.giftId, NOW)).toEqual({ ok: false, error: "no_spare" });
  expect((await exec(db, "select status from pack_gifts")).rows[0].status).toBe("pending");
  expect(await copies(RECIPIENT)).toBe(0);
  expect(await acceptPackGift(db, 999, sent.giftId, NOW)).toEqual({ ok: false, error: "gift_not_found" });
});
it("keeps GOATs and granted variants distinct without creating an Eternal reward", async () => {
  await seedCard(SENDER,"77:goat","goat"); await seedCard(SENDER,"77:v2","legendary"); await seedCard(SENDER,"77:eternal","eternal");
  expect((await deliver("gift-request-00000002",RECIPIENT,"77:goat")).ok).toBe(true);
  expect((await deliver("gift-request-00000003",RECIPIENT,"77:v2")).ok).toBe(true);
  expect((await getPackCollectionCard(db, RECIPIENT,"77:goat"))?.tier).toBe("goat");
  expect((await getPackCollectionCard(db, RECIPIENT,"77:v2"))?.tier).toBe("legendary");
  expect((await deliver("gift-request-00000004",RECIPIENT,"77:eternal")).ok).toBe(true);
  expect(await isPackWalletEternalPending(db, RECIPIENT)).toBe(true);
  expect((await exec(db,"select * from pack_eternal_rewards")).rows).toHaveLength(0);
});
it("fulfills wishes and scopes receipt reads and dismissal to the recipient", async () => {
  await exec(db,"insert into pack_wishlist (owner_user_id,card_user_id,added_at) values (?,77,1)",[RECIPIENT]);
  await deliver();
  expect((await exec(db,"select * from pack_wishlist")).rows).toHaveLength(0);
  const inbox=await listPackGiftInbox(db,RECIPIENT);
  expect(inbox.total).toBe(1); expect(inbox.gifts[0].sender.username).toBe("Sender");
  expect((await listPackGiftInbox(db,SENDER)).total).toBe(0);
  await acknowledgePackGifts(db,SENDER,[inbox.gifts[0].id],NOW);
  expect((await listPackGiftInbox(db,RECIPIENT)).total).toBe(1);
  await acknowledgePackGifts(db,RECIPIENT,[inbox.gifts[0].id],NOW);
  expect((await listPackGiftInbox(db,RECIPIENT)).total).toBe(0); expect(await copies(RECIPIENT)).toBe(1);
});
it("allows more than ten gifts in one day, up to the copies actually held", async () => {
  await exec(db, "update pack_collection_cards set copies=30 where owner_user_id=?", [SENDER]);
  for (let index = 0; index < 30; index++) {
    const request = gift(`gift-request-${String(index).padStart(8, '0')}`);
    expect(await deliver(request.requestId)).toMatchObject({ ok: true, remainingCopies: 30 - index });
  }
  expect(await copies(SENDER)).toBe(0);
  expect(await copies(RECIPIENT)).toBe(30);
  expect(await sendPackGift(db, SENDER, gift("gift-request-99999999"), NOW)).toEqual({ ok: false, error: "no_spare" });
  const inbox = await listPackGiftInbox(db, RECIPIENT);
  expect(inbox.total).toBe(30);
  expect(inbox.gifts).toHaveLength(20);
});
it("searches existing collectors by name or id and treats wildcards literally", async () => {
  expect((await searchGiftCollectors(db,SENDER,"Reci")).map(c=>c.userId)).toEqual([RECIPIENT]);
  expect((await searchGiftCollectors(db,SENDER,String(RECIPIENT))).map(c=>c.userId)).toEqual([RECIPIENT]);
  expect(await searchGiftCollectors(db,SENDER,"Sender")).toEqual([]);
  expect(await searchGiftCollectors(db,SENDER,"%_")).toEqual([]);
});

it("does not transfer award-style Eternals that would retire someone else's completion reward", async () => {
  await seedCard(SENDER,"77:v2","eternal");
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000002",RECIPIENT,"77:v2"), NOW)).toEqual({ok:false,error:"special_card"});
  expect(await copies(SENDER,"77:v2")).toBe(3);
  expect(await copies(RECIPIENT,"77:v2")).toBe(0);
  expect(await isPackWalletEternalPending(db, RECIPIENT)).toBe(true);
});

it("pages past pending offers and clamps the page after its last offer is declined", async () => {
  await exec(db, "update pack_collection_cards set copies=21 where owner_user_id=?", [SENDER]);
  const first = await sendPackGift(db, SENDER, gift(), NOW);
  if (!first.ok) throw new Error("offer failed");
  for (let i = 1; i <= 20; i++) await sendPackGift(db, SENDER, gift(`paged-request-${String(i).padStart(8, '0')}`), NOW + i);
  const firstPage = await listPackGiftInbox(db, RECIPIENT);
  const secondPage = await listPackGiftInbox(db, RECIPIENT, 1);
  expect(firstPage).toMatchObject({ total: 21, page: 0 });
  expect(firstPage.gifts).toHaveLength(20);
  expect(secondPage).toMatchObject({ total: 21, page: 1, gifts: [{ id: first.giftId, status: "pending" }] });
  expect(secondPage.gifts).toHaveLength(1);
  expect(await copies(SENDER)).toBe(21);
  expect((await listPackGiftInbox(db, SENDER, 1)).gifts).toEqual([]);
  expect((await listPackGiftInbox(db, RECIPIENT, -1)).page).toBe(0);
  expect((await listPackGiftInbox(db, RECIPIENT, "NaN")).page).toBe(0);
  await declinePackGift(db, RECIPIENT, first.giftId, NOW + 30);
  const remaining = await listPackGiftInbox(db, RECIPIENT, 1);
  expect(remaining).toMatchObject({ total: 20, page: 0 });
  expect(remaining.gifts).toHaveLength(20);
  expect(remaining.gifts.every(g => g.status === "pending")).toBe(true);
});
