import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { grantAdminPackCard } from "../src/features/pack-admin.js";
import {
  applyPackCollectionCardMint,
  getPackCollectionCard,
  listPackCardMotifUrls,
  savePackWallet,
  tierRank,
} from "../src/features/pack-wallets.js";
import { getSharedPackCard } from "../src/features/pack-pulls.js";

/* Eternal is hand-granted: /admin/collections is the only writer, and it
   recycles for 250 shards. A wallet sync must therefore never be able to claim
   it - and, just as importantly, must never be able to knock one off a card an
   admin really did grant.
 *
 * The motif rides the same rule: an image on a card is an admin's choice, so a
 * sync can neither set one nor clear one. */

let dir = "";
let db: Db;

const OWNER = 7311;
const CARD_USER = 990210;
const OTHER_CARD_USER = 990211;
const MOTIF = { url: "https://example.com/heart.png", scale: 1.5, opacity: 0.8 };

const ADMIN_OWNER = { userId: OWNER, username: "collector", countryCode: "CR", tracked: true };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-eternal-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function walletCard(userId: number, tier: string, extra: Record<string, unknown> = {}) {
  return {
    userId,
    username: `player${userId}`,
    avatarUrl: "",
    countryCode: "KR",
    tier,
    tierLabel: tier,
    skills: null,
    pp: 1000,
    globalRank: 1,
    copies: 2,
    recycledCopies: 0,
    firstPulledAt: 1,
    lastPulledAt: 1,
    ...extra,
  };
}

async function sync(cards: Record<string, unknown>, rev: number) {
  await savePackWallet(db, OWNER, JSON.stringify({ cards, shards: 0 }), rev);
}

async function storedRow(userId: number) {
  return (await exec(
    db,
    "select tier, motif from pack_collection_cards where owner_user_id = ? and card_user_id = ?",
    [OWNER, userId],
  )).rows[0];
}

/* The key a grant landed on. Anything customized - its own tier, a badge, an
   image - is a card of its own, so the desk mints it a ":v<n>" key rather than
   writing over the player's ordinary card. */
async function grant(cardUserId: number, fields: Record<string, unknown>): Promise<string> {
  const outcome = await grantAdminPackCard(db, ADMIN_OWNER, { cardUserId, ...fields } as never);
  expect(outcome.ok).toBe(true);
  return outcome.ok ? outcome.result.cardKey : "";
}

async function storedRowByKey(cardKey: string) {
  return (await exec(
    db,
    "select tier, motif from pack_collection_cards where owner_user_id = ? and card_key = ?",
    [OWNER, cardKey],
  )).rows[0];
}

describe("the Eternal tier", () => {
  it("ranks above World Class and below GOAT", () => {
    expect(tierRank("eternal")).toBeGreaterThan(tierRank("worldClass"));
    expect(tierRank("eternal")).toBeLessThan(tierRank("goat"));
  });

  it("strips a client-claimed Eternal, whoever the card is of", async () => {
    await sync({ [CARD_USER]: walletCard(CARD_USER, "eternal") }, 0);
    expect((await storedRow(CARD_USER))?.tier).toBeNull();
  });

  it("pays out an unrated recycle for the forged card, not 250 shards", async () => {
    await sync({ [CARD_USER]: walletCard(CARD_USER, "eternal") }, 0);
    const { recyclePackCollectionCards } = await import("../src/features/pack-wallets.js");
    const { gained } = await recyclePackCollectionCards(db, OWNER, { mode: "duplicates", cardKey: String(CARD_USER) });
    expect(gained).toBeLessThanOrEqual(1);
  });

  it("keeps a granted Eternal through a sync that reports it as unrated", async () => {
    const key = await grant(CARD_USER, { tier: "eternal", copies: 1 });
    expect((await storedRowByKey(key))?.tier).toBe("eternal");

    /* The browser round-trips the card back under the key it was given, with
       its tier refused on the way in - which is the whole reason the ownership
       upsert only ever lets a better tier win: an unrated claim cannot outrank
       what is stored. */
    await sync({ [key]: walletCard(CARD_USER, "eternal") }, 1);
    expect((await storedRowByKey(key))?.tier).toBe("eternal");

    /* And a key nobody was granted is not a way to reach the card: a wallet
       claiming one falls back to the player's ordinary card, which is not
       this one. */
    await sync({ [`${CARD_USER}:v99`]: walletCard(CARD_USER, "eternal") }, 2);
    expect((await storedRowByKey(`${CARD_USER}:v99`))).toBeUndefined();
    expect((await storedRowByKey(key))?.tier).toBe("eternal");
  });

  it("survives the repair pass that fills in the snapshot it was granted without", async () => {
    /* The exact shape of the 2026-08-18 report: a hand-granted Eternal with no
       skills lands in the collection, the panel notices the missing snapshot
       and re-mints it from the player's plays, and the tier the browser sends
       back is one no client may claim. The mint has to take the snapshot and
       leave the tier alone. */
    const key = await grant(CARD_USER, { tier: "eternal", copies: 2 });
    expect((await storedRowByKey(key))?.tier).toBe("eternal");

    const result = await applyPackCollectionCardMint(db, OWNER, key, {
      tier: "eternal",
      tierLabel: "Eternal",
      skills: { cardPower: 300, fingerControl: 641, speed: 769, accuracy: 525 },
    });
    expect(result.applied).toBe(true);
    // On its own key still: a mint moves a card whose key its tier derives,
    // and a granted card's key is not derivable from anything.
    expect(result.cardKey).toBe(key);

    const card = await getPackCollectionCard(db, OWNER, key);
    expect(card?.tier).toBe("eternal");
    expect(card?.skills).not.toBeNull();
  });

  it("still refuses to raise a card to Eternal on a client's word", async () => {
    await grantAdminPackCard(db, ADMIN_OWNER, { cardUserId: OTHER_CARD_USER, tier: "rare", copies: 1 });
    await applyPackCollectionCardMint(db, OWNER, String(OTHER_CARD_USER), {
      tier: "eternal",
      skills: { cardPower: 900 },
    });
    // The claim is dropped, and "rare" outranks what is left, so it stands.
    expect((await storedRow(OTHER_CARD_USER))?.tier).toBe("rare");
  });

  it("does not let a snapshotless Eternal be talked down to a lesser tier", async () => {
    const key = await grant(CARD_USER, { tier: "eternal", copies: 1 });
    await applyPackCollectionCardMint(db, OWNER, key, {
      tier: "common",
      tierLabel: "Common",
      skills: { cardPower: 100 },
    });
    const card = await getPackCollectionCard(db, OWNER, key);
    expect(card?.tier).toBe("eternal");
    expect(card?.skills).not.toBeNull();
    // The label belonged to the refused claim, so it did not travel either.
    expect(card?.customLabel ?? null).toBeNull();
  });

  it("still lets an ordinary snapshotless card take a mint whole, tier and all", async () => {
    /* The legacy-repair rule the awarded tiers are the exception to: a rated
       tier with no snapshot behind it can be wrong, and the freshly computed
       card is the only one that can actually be drawn. */
    await grantAdminPackCard(db, ADMIN_OWNER, { cardUserId: OTHER_CARD_USER, tier: "legendary", copies: 1 });
    await applyPackCollectionCardMint(db, OWNER, String(OTHER_CARD_USER), {
      tier: "elite",
      skills: { cardPower: 250 },
    });
    expect((await storedRow(OTHER_CARD_USER))?.tier).toBe("elite");
  });
});

describe("granted background art", () => {
  it("stores a motif from the grant desk and reads it back on the card", async () => {
    const key = await grant(CARD_USER, { tier: "eternal", copies: 1, motif: MOTIF });
    const card = await getPackCollectionCard(db, OWNER, key);
    expect(card?.motif).toEqual(MOTIF);
  });

  it("bounds what the grant may store", async () => {
    const bounded = await grant(CARD_USER, {
      tier: "rare",
      copies: 1,
      motif: { url: "https://example.com/a.png", scale: 99, opacity: -4 },
    });
    expect((await getPackCollectionCard(db, OWNER, bounded))?.motif).toEqual({
      url: "https://example.com/a.png",
      scale: 4,
      opacity: 0.05,
    });

    // An http URL is no motif at all rather than a stored one that never
    // loads, so that grant customizes nothing and stays on the ordinary card.
    const refused = await grant(OTHER_CARD_USER, {
      tier: "rare",
      copies: 1,
      motif: { url: "http://example.com/a.png" },
    });
    expect(refused).toBe(String(OTHER_CARD_USER));
    expect((await getPackCollectionCard(db, OWNER, refused))?.motif).toBeNull();
  });

  it("keeps the art when a later grant edits that card, and clears it only when told to", async () => {
    const key = await grant(CARD_USER, { tier: "rare", copies: 1, motif: MOTIF });
    // Editing the card the desk listed: the key says which holding is meant,
    // so a grant that mentions no art leaves the art alone.
    await grant(CARD_USER, { cardKey: key, tier: "rare", copies: 1 });
    expect((await getPackCollectionCard(db, OWNER, key))?.motif).toEqual(MOTIF);

    await grant(CARD_USER, { cardKey: key, tier: "rare", copies: 0, motif: null });
    expect((await getPackCollectionCard(db, OWNER, key))?.motif).toBeNull();
  });

  it("cannot be set or cleared by a wallet sync", async () => {
    const key = await grant(CARD_USER, { tier: "rare", copies: 1, motif: MOTIF });
    await sync(
      {
        [key]: walletCard(CARD_USER, "rare", { motif: null }),
        [OTHER_CARD_USER]: walletCard(OTHER_CARD_USER, "rare", { motif: { url: "https://evil.example/a.png" } }),
      },
      1,
    );
    expect((await getPackCollectionCard(db, OWNER, key))?.motif).toEqual(MOTIF);
    expect((await storedRow(OTHER_CARD_USER))?.motif).toBeNull();
  });

  it("follows the card onto its share page", async () => {
    const key = await grant(CARD_USER, { tier: "eternal", copies: 1, motif: MOTIF });
    const shared = await getSharedPackCard(db, OWNER, key);
    expect(shared?.card.tier).toBe("eternal");
    expect(shared?.card.motif).toEqual(MOTIF);
  });

  it("lists every granted image once, for the proxy's allowlist", async () => {
    await grantAdminPackCard(db, ADMIN_OWNER, { cardUserId: CARD_USER, tier: "rare", copies: 1, motif: MOTIF });
    await grantAdminPackCard(db, ADMIN_OWNER, { cardUserId: OTHER_CARD_USER, tier: "rare", copies: 1, motif: MOTIF });
    await grantAdminPackCard(db, { ...ADMIN_OWNER, userId: OWNER + 1 }, {
      cardUserId: CARD_USER,
      tier: "rare",
      copies: 1,
      motif: { url: "https://example.com/star.png" },
    });
    expect((await listPackCardMotifUrls(db)).sort()).toEqual([
      "https://example.com/heart.png",
      "https://example.com/star.png",
    ]);
  });
});
