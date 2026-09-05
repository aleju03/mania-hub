import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { acknowledgePackGifts, listPackGiftInbox, PACK_GIFT_DAILY_CAP, searchGiftCollectors, sendPackGift } from "../src/features/pack-gifts.js";
import { getPackCollectionCard, isPackWalletEternalPending } from "../src/features/pack-wallets.js";
let dir: string;
let db: Db;
const SENDER = 101, RECIPIENT = 102, NOW = 1_780_000_000_000;
const motif = JSON.stringify({ url: "https://mania-tracker.com/images/card-finishes/aurora.svg", scale: 0.75, opacity: 0.65, palette: "aurora" });
const gift = (requestId = "gift-request-00000001", recipientUserId = RECIPIENT, cardKey = "77") => ({ recipientUserId, cardKey, requestId });
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
  expect(await sendPackGift(db, SENDER, gift(), NOW)).toMatchObject({ ok: true, remainingCopies: 2, replayed: false });
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
  await sendPackGift(db, SENDER, gift(), NOW);
  expect((await exec(db, "select * from pack_collection_cards where owner_user_id=?", [RECIPIENT])).rows[0]).toEqual({ ...before, copies: 2, updated_at: NOW });
  expect((await getPackCollectionCard(db, RECIPIENT, "77"))?.serial).toBe(5);
});
it("refuses last copies, self-gifts and unknown recipients", async () => {
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000002", SENDER), NOW)).toEqual({ ok:false, error:"self_gift" });
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000002", 999), NOW)).toEqual({ ok:false, error:"recipient_not_found" });
  await exec(db, "update pack_collection_cards set copies=1 where owner_user_id=?", [SENDER]);
  expect(await sendPackGift(db, SENDER, gift(), NOW)).toEqual({ ok:false, error:"no_spare" });
  expect(await copies(SENDER)).toBe(1); expect(await copies(RECIPIENT)).toBe(0);
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
  expect(await copies(SENDER)).toBe(2); expect(await copies(RECIPIENT)).toBe(1);
  await wallet(103,"Other");
  expect(await sendPackGift(db, SENDER, gift("gift-request-00000001",103), NOW)).toEqual({ ok:false, error:"invalid_request" });
});
it("serializes simultaneous gifts without consuming the last copy", async () => {
  await exec(db, "update pack_collection_cards set copies=2 where owner_user_id=?", [SENDER]);
  const results = await Promise.all([sendPackGift(db, SENDER, gift(), NOW), sendPackGift(db, SENDER, gift("gift-request-00000002"), NOW)]);
  expect(results.filter(r=>r.ok)).toHaveLength(1);
  expect(await copies(SENDER)).toBe(1); expect(await copies(RECIPIENT)).toBe(1);
});
it("handles duplicate simultaneous requests as one gift", async () => {
  const results = await Promise.all([sendPackGift(db, SENDER, gift(), NOW), sendPackGift(db, SENDER, gift(), NOW)]);
  expect(results.every(r=>r.ok)).toBe(true);
  expect(await copies(SENDER)).toBe(2); expect(await copies(RECIPIENT)).toBe(1);
});
it("rolls back the receipt and both holdings if debiting fails", async () => {
  await exec(db, `create trigger stop_gift before update of copies on pack_collection_cards when old.owner_user_id=101 begin select raise(abort,'test transfer failure'); end`);
  await expect(sendPackGift(db, SENDER, gift(), NOW)).rejects.toThrow("test transfer failure");
  expect(await copies(SENDER)).toBe(3); expect(await copies(RECIPIENT)).toBe(0);
  expect((await exec(db,"select * from pack_gifts")).rows).toHaveLength(0);
  expect((await exec(db,"select * from pack_card_serials")).rows).toHaveLength(0);
});
it("keeps GOATs and granted variants distinct without creating an Eternal reward", async () => {
  await seedCard(SENDER,"77:goat","goat"); await seedCard(SENDER,"77:v2","legendary"); await seedCard(SENDER,"77:eternal","eternal");
  expect((await sendPackGift(db, SENDER, gift("gift-request-00000002",RECIPIENT,"77:goat"), NOW)).ok).toBe(true);
  expect((await sendPackGift(db, SENDER, gift("gift-request-00000003",RECIPIENT,"77:v2"), NOW)).ok).toBe(true);
  expect((await getPackCollectionCard(db, RECIPIENT,"77:goat"))?.tier).toBe("goat");
  expect((await getPackCollectionCard(db, RECIPIENT,"77:v2"))?.tier).toBe("legendary");
  expect((await sendPackGift(db, SENDER, gift("gift-request-00000004",RECIPIENT,"77:eternal"), NOW)).ok).toBe(true);
  expect(await isPackWalletEternalPending(db, RECIPIENT)).toBe(true);
  expect((await exec(db,"select * from pack_eternal_rewards")).rows).toHaveLength(0);
});
it("fulfills wishes and scopes receipt reads and dismissal to the recipient", async () => {
  await exec(db,"insert into pack_wishlist (owner_user_id,card_user_id,added_at) values (?,77,1)",[RECIPIENT]);
  await sendPackGift(db,SENDER,gift(),NOW);
  expect((await exec(db,"select * from pack_wishlist")).rows).toHaveLength(0);
  const inbox=await listPackGiftInbox(db,RECIPIENT);
  expect(inbox.total).toBe(1); expect(inbox.gifts[0].sender.username).toBe("Sender");
  expect((await listPackGiftInbox(db,SENDER)).total).toBe(0);
  await acknowledgePackGifts(db,SENDER,[inbox.gifts[0].id],NOW);
  expect((await listPackGiftInbox(db,RECIPIENT)).total).toBe(1);
  await acknowledgePackGifts(db,RECIPIENT,[inbox.gifts[0].id],NOW);
  expect((await listPackGiftInbox(db,RECIPIENT)).total).toBe(0); expect(await copies(RECIPIENT)).toBe(1);
});
it("enforces a rolling send limit", async () => {
  await exec(db,"update pack_collection_cards set copies=30 where owner_user_id=?",[SENDER]);
  for(let i=0;i<PACK_GIFT_DAILY_CAP;i++) expect((await sendPackGift(db,SENDER,gift(`gift-request-${String(i).padStart(8,'0')}`),NOW)).ok).toBe(true);
  expect(await sendPackGift(db,SENDER,gift("gift-request-99999999"),NOW)).toEqual({ok:false,error:"daily_limit"});
  expect((await sendPackGift(db,SENDER,gift("gift-request-99999999"),NOW+86400000)).ok).toBe(true);
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
