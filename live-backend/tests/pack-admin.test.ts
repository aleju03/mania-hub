import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  getAdminPackCollectionOverview,
  grantAdminPackCard,
  removeAdminPackCard,
  resolveAdminPackUser,
  setAdminPackWalletEconomy,
  type AdminPackUser,
} from "../src/features/pack-admin.js";
import { getSharedPackCard } from "../src/features/pack-pulls.js";
import {
  getPackCollectionCard,
  getPackWallet,
  MAX_PACK_CHARGES,
  packWalletEconomy,
} from "../src/features/pack-wallets.js";
import { readStoredCard, seedCollectionCard } from "./helpers/pack-cards.js";

let dir = "";
let db: Db;

const OWNER_ID = 14600698;
const CARD_USER_ID = 2531335;

const owner: AdminPackUser = { userId: OWNER_ID, username: "collector", countryCode: "CR", tracked: true };

async function seedUser(userId: number, username: string, countryCode = "CR"): Promise<void> {
  await exec(
    db,
    "insert into users (user_id, username, country_code, avatar_url, updated_at) values (?, ?, ?, ?, ?)",
    [userId, username, countryCode, `https://a.ppy.sh/${userId}`, 1000],
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-admin-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("resolveAdminPackUser", () => {
  it("resolves an id the backend has never seen, flagged untracked", async () => {
    expect(await resolveAdminPackUser(db, { userId: 999_001 })).toEqual({
      userId: 999_001,
      username: null,
      countryCode: null,
      tracked: false,
    });
  });

  it("resolves a username off the users projection", async () => {
    await seedUser(CARD_USER_ID, "Fullerene-", "JP");
    expect(await resolveAdminPackUser(db, { username: "fullerene-" })).toEqual({
      userId: CARD_USER_ID,
      username: "Fullerene-",
      countryCode: "JP",
      tracked: true,
    });
  });

  it("refuses a username nothing has stored", async () => {
    expect(await resolveAdminPackUser(db, { username: "nobody at all" })).toBeNull();
  });
});

describe("granting a card", () => {
  it("mints a holding carrying every field it was given", async () => {
    const skills = { cardPower: 812, speed: 91, accuracy: 88, archetype: "Technician" };
    const outcome = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "worldClass",
      tierLabel: "World Class",
      copies: 3,
      recycledCopies: 2,
      pp: 12_345.5,
      globalRank: 7,
      skills,
      firstPulledAt: 1_700_000_000_000,
      lastPulledAt: 1_700_000_500_000,
      username: "Fullerene-",
      avatarUrl: "https://a.ppy.sh/2531335",
      countryCode: "jp",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.created).toBe(true);
    // A typed badge is a card of its own, so the desk minted it a key rather
    // than writing over the player's ordinary card.
    expect(outcome.result.cardKey).toBe(`${CARD_USER_ID}:v1`);
    expect(outcome.result.card).toMatchObject({
      tier: "worldClass",
      tierLabel: "World Class",
      copies: 3,
      recycledCopies: 2,
      pp: 12_345.5,
      globalRank: 7,
      username: "Fullerene-",
      countryCode: "JP",
      firstPulledAt: 1_700_000_000_000,
      lastPulledAt: 1_700_000_500_000,
    });
    expect(outcome.result.card?.skills).toEqual(skills);
  });

  it("adds copies by default and replaces them in set mode", async () => {
    await seedCollectionCard(db, OWNER_ID, CARD_USER_ID, { copies: 4, tier: "rare" });

    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", copies: 3 });
    expect(Number((await readStoredCard(db, OWNER_ID, String(CARD_USER_ID)))?.copies)).toBe(7);

    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", copies: 2, copiesMode: "set" });
    expect(Number((await readStoredCard(db, OWNER_ID, String(CARD_USER_ID)))?.copies)).toBe(2);
  });

  it("takes copies back with a negative add, flooring at zero", async () => {
    await seedCollectionCard(db, OWNER_ID, CARD_USER_ID, { copies: 2, tier: "rare" });
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", copies: -5 });
    expect(Number((await readStoredCard(db, OWNER_ID, String(CARD_USER_ID)))?.copies)).toBe(0);
  });

  it("keeps a GOAT card on its own key rather than folding it into the ranked one", async () => {
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "worldClass" });
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "goat" });

    const rows = (await exec(
      db,
      "select card_key, tier from pack_collection_cards where owner_user_id = ? order by card_key",
      [OWNER_ID],
    )).rows;
    expect(rows.map((row) => String(row.card_key))).toEqual([`${CARD_USER_ID}`, `${CARD_USER_ID}:goat`]);
  });

  it("grants GOAT to a player off the honorary roster, which the sync path refuses", async () => {
    const outcome = await grantAdminPackCard(db, owner, { cardUserId: 4_242_424, tier: "goat" });
    expect(outcome.ok).toBe(true);
    expect(Number((await readStoredCard(db, OWNER_ID, "4242424:goat"))?.copies)).toBe(1);
  });

  it("downgrades a tier, which the mint path cannot", async () => {
    await seedCollectionCard(db, OWNER_ID, CARD_USER_ID, { tier: "legendary" });
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: null, copies: 0 });
    expect((await readStoredCard(db, OWNER_ID, String(CARD_USER_ID)))?.tier).toBeNull();
  });

  it("refuses a tier that is not one of the stored ten", async () => {
    expect(await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "cosmic" })).toEqual({
      ok: false,
      error: "bad_tier",
    });
    expect(await grantAdminPackCard(db, owner, { cardUserId: 0, tier: "rare" })).toEqual({
      ok: false,
      error: "bad_card_user",
    });
  });

  it("refuses a skills blob past the share card's size cap", async () => {
    expect(
      await grantAdminPackCard(db, owner, {
        cardUserId: CARD_USER_ID,
        tier: "rare",
        skills: { archetype: "x".repeat(2_500) },
      }),
    ).toEqual({ ok: false, error: "bad_skills" });
  });

  it("interns one snapshot rather than storing a copy per collector", async () => {
    const skills = { cardPower: 500, speed: 60 };
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "mythic", skills });
    await grantAdminPackCard(db, { ...owner, userId: OWNER_ID + 1 }, { cardUserId: CARD_USER_ID, tier: "mythic", skills });
    expect(Number((await exec(db, "select count(*) as n from pack_card_skills")).rows[0]?.n)).toBe(1);
  });
});

describe("granted cards as their own collectible", () => {
  /* The desk is the only writer that can mint a card key, and what it mints on
     is the card it is describing: its own tier, its own badge, its own art.
     Same card to a second collector, same key; anything different, a new one. */
  it("mints a key for a customized grant and leaves the ordinary card alone", async () => {
    await seedCollectionCard(db, OWNER_ID, CARD_USER_ID, { tier: "rare", copies: 2 });

    const outcome = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "eternal", copies: 1 });
    expect(outcome.ok && outcome.result.cardKey).toBe(`${CARD_USER_ID}:v1`);
    expect(outcome.ok && outcome.result.created).toBe(true);
    // Their pulled card is untouched, and both are theirs.
    expect((await getPackCollectionCard(db, OWNER_ID, String(CARD_USER_ID)))?.copies).toBe(2);
    expect((await getPackCollectionCard(db, OWNER_ID, `${CARD_USER_ID}:v1`))?.tier).toBe("eternal");
  });

  it("marks a granted holding as given rather than pulled, and dates it", async () => {
    /* A grant mints a serial like a pull does, so without this the only thing
       left to say about the card was that its holder was the Nth person to
       pull it. They were not; nobody pulled it. */
    const outcome = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "eternal", copies: 1 });
    const key = outcome.ok ? outcome.result.cardKey : "";
    const granted = await getPackCollectionCard(db, OWNER_ID, key);
    expect(granted?.grantedAt).toBeGreaterThan(0);
    // Dated by the pull stamp it stands in for, so backdating a grant backdates both.
    expect(granted?.grantedAt).toBe(granted?.firstPulledAt);
  });

  it("leaves a pulled card unmarked, even after the desk edits it", async () => {
    await seedCollectionCard(db, OWNER_ID, CARD_USER_ID, { tier: "rare", copies: 2 });

    await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      cardKey: String(CARD_USER_ID),
      tier: "rare",
      copies: 5,
      copiesMode: "set",
    });

    const edited = await getPackCollectionCard(db, OWNER_ID, String(CARD_USER_ID));
    expect(edited?.copies).toBe(5);
    // Editing somebody's pulled card does not turn it into a card they were given.
    expect(edited?.grantedAt ?? null).toBeNull();
  });

  it("backdates the marker with the grant", async () => {
    const backdated = 1_600_000_000_000;
    const outcome = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "eternal",
      firstPulledAt: backdated,
    });
    const key = outcome.ok ? outcome.result.cardKey : "";
    expect((await getPackCollectionCard(db, OWNER_ID, key))?.grantedAt).toBe(backdated);
  });

  it("puts a second collector handed the same card on the same key", async () => {
    const motif = { url: "https://example.com/a.png" };
    const first = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "eternal", tierLabel: "Mano", motif });
    const second = await grantAdminPackCard(db, { ...owner, userId: OWNER_ID + 1 }, {
      cardUserId: CARD_USER_ID,
      tier: "eternal",
      tierLabel: "Mano",
      motif,
    });
    expect(first.ok && second.ok && second.result.cardKey).toBe(first.ok ? first.result.cardKey : "");
    expect(second.ok && second.result.created).toBe(true);
  });

  it("mints another key when the tier, the badge or the art differs", async () => {
    const base = { cardUserId: CARD_USER_ID, tier: "eternal", tierLabel: "Mano" } as const;
    const first = await grantAdminPackCard(db, owner, { ...base });
    const label = await grantAdminPackCard(db, owner, { ...base, tierLabel: "Duo" });
    const art = await grantAdminPackCard(db, owner, { ...base, motif: { url: "https://example.com/a.png" } });
    const tier = await grantAdminPackCard(db, owner, { ...base, tier: "goat" });
    const keys = [first, label, art, tier].map((outcome) => (outcome.ok ? outcome.result.cardKey : ""));
    expect(keys).toEqual([
      `${CARD_USER_ID}:v1`,
      `${CARD_USER_ID}:v2`,
      `${CARD_USER_ID}:v3`,
      `${CARD_USER_ID}:v4`,
    ]);
    expect(new Set(keys).size).toBe(4);
  });

  it("edits the card it was pointed at rather than minting beside it", async () => {
    const first = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "eternal", tierLabel: "Mano" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const fixed = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      cardKey: first.result.cardKey,
      tier: "eternal",
      tierLabel: "Manolo",
    });
    expect(fixed.ok && fixed.result.cardKey).toBe(first.result.cardKey);
    expect(fixed.ok && fixed.result.created).toBe(false);
    expect((await getPackCollectionCard(db, OWNER_ID, first.result.cardKey))?.customLabel).toBe("Manolo");
    // No stray left behind at the number the second grant would have minted.
    expect(await getPackCollectionCard(db, OWNER_ID, `${CARD_USER_ID}:v2`)).toBeNull();
  });

  it("refuses a key belonging to another player", async () => {
    const outcome = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      cardKey: `${CARD_USER_ID + 1}:v1`,
      tier: "eternal",
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBe("bad_card_key");
  });

  it("keeps an uncustomized grant on the player's ordinary card", async () => {
    const outcome = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "worldClass", copies: 1 });
    expect(outcome.ok && outcome.result.cardKey).toBe(String(CARD_USER_ID));
  });

  it("gives each granted card its own mint order", async () => {
    const first = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "eternal",
      tierLabel: "Mano",
      serialMode: "mint",
    });
    const second = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "eternal",
      tierLabel: "Duo",
      serialMode: "mint",
    });
    // Two cards, each minting its own #1, rather than one card minting #2.
    expect(first.ok && first.result.card?.serial).toBe(1);
    expect(second.ok && second.result.card?.serial).toBe(1);
  });
});

describe("granted card identity", () => {
  it("prefers the users row over whatever the form typed", async () => {
    await seedUser(CARD_USER_ID, "Fullerene-", "JP");
    await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "rare",
      username: "not their name",
      countryCode: "US",
    });
    const row = (await exec(db, "select username, country_code from pack_cards where card_key = ?", [String(CARD_USER_ID)])).rows[0];
    expect(String(row?.username)).toBe("Fullerene-");
    expect(String(row?.country_code)).toBe("JP");
  });

  it("leaves an existing face alone unless the overwrite is asked for", async () => {
    await seedCollectionCard(db, OWNER_ID + 1, CARD_USER_ID, { tier: "rare", username: "original" });

    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", username: "renamed" });
    expect(String((await exec(db, "select username from pack_cards where card_key = ?", [String(CARD_USER_ID)])).rows[0]?.username))
      .toBe("original");

    await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "rare",
      username: "renamed",
      overwriteIdentity: true,
    });
    expect(String((await exec(db, "select username from pack_cards where card_key = ?", [String(CARD_USER_ID)])).rows[0]?.username))
      .toBe("renamed");
  });

  it("keeps a custom label to the one collector who was given it", async () => {
    // The case this exists for: one person's GOAT card reading "manolo" while
    // every other holder's still reads GOAT.
    await seedCollectionCard(db, OWNER_ID + 1, CARD_USER_ID, { tier: "goat", tierLabel: "GOAT" });

    const outcome = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "goat",
      tierLabel: "manolo",
    });
    expect(outcome.ok && outcome.result.card?.tierLabel).toBe("manolo");
    // customLabel is the field the card art reads, so it must carry only a
    // label somebody chose, never the tier's own name.
    expect(outcome.ok && outcome.result.card?.customLabel).toBe("manolo");
    // The shared face, and so everyone else's copy, is untouched.
    expect(String((await exec(db, "select tier_label from pack_cards where card_key = ?", [`${CARD_USER_ID}:goat`])).rows[0]?.tier_label))
      .toBe("GOAT");
    const theirs = await getPackCollectionCard(db, OWNER_ID + 1, `${CARD_USER_ID}:goat`);
    expect(theirs?.tierLabel).toBe("GOAT");
    expect(theirs?.customLabel).toBeNull();
  });

  it("takes a label even when the shared row already reads the same", async () => {
    // The card art reads customLabel and nothing else, so a label matching the
    // variant's still has to land per owner or it would never be printed.
    await seedCollectionCard(db, OWNER_ID + 1, CARD_USER_ID, { tier: "goat", tierLabel: "Mano" });
    const outcome = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "goat", tierLabel: "Mano" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((await getPackCollectionCard(db, OWNER_ID, outcome.result.cardKey))?.customLabel).toBe("Mano");
  });

  it("stores no override for a card that was given no label of its own", async () => {
    // The form sends null rather than the tier's name for an untouched box, so
    // the badge keeps falling back to the tier (and, for a roster member, to
    // their own honorary label) at render time.
    await seedCollectionCard(db, OWNER_ID + 1, CARD_USER_ID, { tier: "rare", tierLabel: "Rare" });
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", tierLabel: null });
    expect((await readStoredCard(db, OWNER_ID, String(CARD_USER_ID)))?.owner_tier_label).toBeNull();
  });

  it("clears a label that was there before when the box is emptied", async () => {
    const first = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", tierLabel: "Handmade" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Editing that card, named by its key: without one the grant would be
    // about the player's ordinary card and leave this badge where it is.
    await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      cardKey: first.result.cardKey,
      tier: "rare",
      tierLabel: null,
    });
    expect((await getPackCollectionCard(db, OWNER_ID, first.result.cardKey))?.customLabel).toBeNull();
  });

  it("keeps a label the grant did not mention", async () => {
    const first = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", tierLabel: "Handmade" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      cardKey: first.result.cardKey,
      tier: "rare",
      copies: 1,
    });
    expect((await getPackCollectionCard(db, OWNER_ID, first.result.cardKey))?.customLabel).toBe("Handmade");
  });

  it("repaints the shared label instead when the overwrite is asked for", async () => {
    await seedCollectionCard(db, OWNER_ID + 1, CARD_USER_ID, { tier: "rare", tierLabel: "Rare" });
    await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "rare",
      tierLabel: "Handmade",
      overwriteIdentity: true,
    });
    expect(String((await exec(db, "select tier_label from pack_cards where card_key = ?", [String(CARD_USER_ID)])).rows[0]?.tier_label))
      .toBe("Handmade");
    expect((await getPackCollectionCard(db, OWNER_ID + 1, String(CARD_USER_ID)))?.tierLabel).toBe("Handmade");
  });

  it("carries a custom label onto the share payload", async () => {
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "goat", tierLabel: "manolo" });
    await grantAdminPackCard(db, { ...owner, userId: OWNER_ID + 1 }, { cardUserId: CARD_USER_ID, tier: "goat" });
    expect((await getSharedPackCard(db, OWNER_ID, CARD_USER_ID))?.card.tierLabel).toBe("manolo");
    expect((await getSharedPackCard(db, OWNER_ID + 1, CARD_USER_ID))?.card.tierLabel).toBeNull();
  });

  it("leaves a variant it creates unlabelled, so a later pull names the tier", async () => {
    // Nothing here can tell a label describing the tier from one describing
    // this collector, so the shared row stays blank and the first real pull's
    // mint pass fills the tier's own name in.
    const outcome = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", tierLabel: "Handmade" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const row = (await exec(db, "select tier_label from pack_cards where card_key = ?", [outcome.result.cardKey])).rows[0];
    expect(row?.tier_label).toBeNull();
    expect((await getPackCollectionCard(db, OWNER_ID, outcome.result.cardKey))?.tierLabel).toBe("Handmade");
  });

  it("borrows the face from another variant of the same player", async () => {
    await seedCollectionCard(db, OWNER_ID, CARD_USER_ID, { tier: "worldClass", username: "Shoegazer" });
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "goat" });
    const row = (await exec(db, "select username from pack_cards where card_key = ?", [`${CARD_USER_ID}:goat`])).rows[0];
    expect(String(row?.username)).toBe("Shoegazer");
  });

  it("drops an avatar URL that is not https", async () => {
    await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "rare",
      avatarUrl: "javascript:alert(1)",
    });
    expect(String((await exec(db, "select avatar_url from pack_cards where card_key = ?", [String(CARD_USER_ID)])).rows[0]?.avatar_url))
      .toBe("");
  });
});

describe("granted serials", () => {
  it("mints the next serial for the card and leaves an existing one alone", async () => {
    await grantAdminPackCard(db, { ...owner, userId: OWNER_ID + 1 }, {
      cardUserId: CARD_USER_ID,
      tier: "rare",
      serialMode: "mint",
    });
    const second = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", serialMode: "mint" });
    expect(second.ok && second.result.card?.serial).toBe(2);
    expect(second.ok && second.result.card?.mintedTotal).toBe(2);

    const again = await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", serialMode: "mint" });
    expect(again.ok && again.result.card?.serial).toBe(2);
  });

  it("writes an exact serial when one is asked for", async () => {
    const outcome = await grantAdminPackCard(db, owner, {
      cardUserId: CARD_USER_ID,
      tier: "rare",
      serialMode: "set",
      serial: 1,
    });
    expect(outcome.ok && outcome.result.card?.serial).toBe(1);
  });
});

describe("wallet grants", () => {
  it("adds shards to a collector who has never had a wallet", async () => {
    const economy = await setAdminPackWalletEconomy(db, owner, { shardsDelta: 500 });
    expect(economy.shards).toBe(500);
    expect(await getPackWallet(db, OWNER_ID)).not.toBeNull();
  });

  it("takes shards away and floors at zero", async () => {
    await setAdminPackWalletEconomy(db, owner, { shards: 40 });
    expect((await setAdminPackWalletEconomy(db, owner, { shardsDelta: -100 })).shards).toBe(0);
  });

  it("sets charges and restarts the regen clock so the settle does not undo it", async () => {
    const now = 1_700_000_000_000;
    await setAdminPackWalletEconomy(db, owner, { charges: 1 }, now);
    const wallet = await getPackWallet(db, OWNER_ID);
    // Read a minute later: one charge back, not a full bar off a stale stamp.
    const economy = packWalletEconomy(wallet?.payload ?? null, now + 60_000);
    expect(economy.charges).toBe(1);
    expect(economy.lastRefillAt).toBe(now);
  });

  it("clamps charges to the bar's size and leaves untouched fields alone", async () => {
    await setAdminPackWalletEconomy(db, owner, { shards: 90, openedPacks: 12 });
    const economy = await setAdminPackWalletEconomy(db, owner, { charges: 99 });
    expect(economy.charges).toBe(MAX_PACK_CHARGES);
    expect(economy.shards).toBe(90);
    expect(economy.openedPacks).toBe(12);
  });

  it("names the wallet after a collector with no users row of their own", async () => {
    await setAdminPackWalletEconomy(db, { ...owner, tracked: false }, { shardsDelta: 10 });
    const row = (await exec(db, "select owner_username from pack_wallets where user_id = ?", [OWNER_ID])).rows[0];
    expect(String(row?.owner_username)).toBe("collector");
  });
});

describe("removing a granted card", () => {
  it("drops the holding, its showcase pin, and optionally its serial", async () => {
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", serialMode: "mint" });
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, 1)",
      [OWNER_ID, String(CARD_USER_ID)],
    );

    expect(await removeAdminPackCard(db, OWNER_ID, String(CARD_USER_ID), { dropSerial: true })).toEqual({
      removed: true,
      serialRemoved: true,
    });
    expect(await readStoredCard(db, OWNER_ID, String(CARD_USER_ID))).toBeUndefined();
    expect((await exec(db, "select 1 from pack_showcase_cards where owner_user_id = ?", [OWNER_ID])).rows).toHaveLength(0);
    expect((await exec(db, "select 1 from pack_card_serials where owner_user_id = ?", [OWNER_ID])).rows).toHaveLength(0);
  });

  it("keeps the serial when the removal does not ask for it", async () => {
    await grantAdminPackCard(db, owner, { cardUserId: CARD_USER_ID, tier: "rare", serialMode: "mint" });
    expect(await removeAdminPackCard(db, OWNER_ID, String(CARD_USER_ID))).toEqual({
      removed: true,
      serialRemoved: false,
    });
    expect((await exec(db, "select 1 from pack_card_serials where owner_user_id = ?", [OWNER_ID])).rows).toHaveLength(1);
  });

  it("refuses a key that is not a card key", async () => {
    expect(await removeAdminPackCard(db, OWNER_ID, "not-a-card")).toEqual({ removed: false, serialRemoved: false });
  });
});

describe("the overview the page reads", () => {
  it("reports the wallet, the totals and the first page of cards together", async () => {
    await seedCollectionCard(db, OWNER_ID, CARD_USER_ID, { copies: 3, tier: "legendary" });
    await seedCollectionCard(db, OWNER_ID, 1_190_879, { copies: 1, tier: "common" });
    await setAdminPackWalletEconomy(db, owner, { shards: 250 });

    const overview = await getAdminPackCollectionOverview(db, owner, { pageSize: 10 });
    expect(overview.economy.shards).toBe(250);
    expect(overview.hasWallet).toBe(true);
    expect(overview.distinctCards).toBe(2);
    expect(overview.totalCopies).toBe(4);
    expect(overview.collection.cards).toHaveLength(2);
    expect(overview.collection.tierCounts).toMatchObject({ legendary: 1, common: 1 });
  });

  it("answers for a collector with nothing at all", async () => {
    const overview = await getAdminPackCollectionOverview(db, { ...owner, tracked: false });
    expect(overview.hasWallet).toBe(false);
    expect(overview.economy.shards).toBe(0);
    expect(overview.distinctCards).toBe(0);
    expect(overview.collection.cards).toHaveLength(0);
  });
});
