import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  applyPackCollectionCardMint,
  ensurePackCollectionCardKeys,
  getPackWallet,
  listPackCollectionCards,
  listPackCollectionOwnedCardKeys,
  recyclePackCollectionCards,
  savePackWallet,
} from "../src/features/pack-wallets.js";

let dir = "";
let db: Db;

const USER_ID = 14600698;

function cardPayload(copies: number, recycledCopies = 0): string {
  return JSON.stringify({
    cards: {
      "42": {
        userId: 42,
        username: "delta",
        avatarUrl: "https://a.ppy.sh/42",
        countryCode: "CR",
        tier: "rare",
        tierLabel: "Rare",
        skills: null,
        pp: 1234,
        globalRank: 5678,
        copies,
        recycledCopies,
        firstPulledAt: 100,
        lastPulledAt: 200,
      },
    },
    shards: 0,
    shardsSpent: 0,
    charges: 5,
    lastRefillAt: 1000,
    openedPacks: 1,
    poolTotal: null,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-wallets-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("pack wallets", () => {
  it("returns null for a user without a wallet", async () => {
    expect(await getPackWallet(db, USER_ID)).toBeNull();
  });

  it("creates a wallet at rev 1 and bumps the rev on matching saves", async () => {
    const first = await savePackWallet(db, USER_ID, '{"shards":0}', 0, 1000);
    expect(first).toEqual({ ok: true, rev: 1 });

    const second = await savePackWallet(db, USER_ID, '{"shards":5}', 1, 2000);
    expect(second).toEqual({ ok: true, rev: 2 });

    const stored = await getPackWallet(db, USER_ID);
    expect(stored).toEqual({ payload: '{"shards":5}', rev: 2, updatedAt: 2000 });
  });

  it("rejects a stale base rev with the current wallet so the client can reconcile", async () => {
    await savePackWallet(db, USER_ID, '{"shards":0}', 0, 1000);
    await savePackWallet(db, USER_ID, '{"shards":5}', 1, 2000);

    const stale = await savePackWallet(db, USER_ID, '{"shards":1}', 1, 3000);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.current.payload).toBe('{"shards":5}');
      expect(stale.current.rev).toBe(2);
    }
    // The stale write must not have clobbered anything.
    expect((await getPackWallet(db, USER_ID))?.payload).toBe('{"shards":5}');
  });

  it("keeps wallets per user", async () => {
    await savePackWallet(db, USER_ID, '{"shards":1}', 0, 1000);
    await savePackWallet(db, 777, '{"shards":2}', 0, 1000);
    expect((await getPackWallet(db, USER_ID))?.payload).toBe('{"shards":1}');
    expect((await getPackWallet(db, 777))?.payload).toBe('{"shards":2}');
  });

  it("strips imported cards from the wallet blob and lists them from card rows", async () => {
    const saved = await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    expect(saved).toEqual({ ok: true, rev: 1 });

    const wallet = await getPackWallet(db, USER_ID);
    expect(wallet?.payload).toContain('"cards":{}');

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.total).toBe(1);
    expect(page.cards[0]).toMatchObject({ userId: 42, username: "delta", copies: 2, recycledCopies: 0 });
    expect(await listPackCollectionOwnedCardKeys(db, USER_ID)).toEqual(["42"]);
  });

  it("treats full wallet imports as snapshots and post-strip imports as deltas", async () => {
    await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    await savePackWallet(db, USER_ID, cardPayload(1), 1, 2000, "snapshot");
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0].copies).toBe(2);

    await savePackWallet(db, USER_ID, cardPayload(1), 2, 3000, "delta");
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0].copies).toBe(3);
  });

  it("overlays the current identity from users onto listed cards", async () => {
    await savePackWallet(db, USER_ID, cardPayload(1), 0, 1000);
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, ?, ?)",
      [42, "delta_renamed", "https://a.ppy.sh/42?999", "ES", new Date(2000).toISOString()],
    );

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.cards[0]).toMatchObject({
      userId: 42,
      username: "delta_renamed",
      avatarUrl: "https://a.ppy.sh/42?999",
      countryCode: "ES",
      // The pull snapshot stays authoritative for everything non-identity.
      pp: 1234,
      copies: 1,
    });

    // Search matches the displayed (current) name, not the pull-time one.
    const byCurrentName = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15, query: "renamed" });
    expect(byCurrentName.total).toBe(1);
    const byOldName = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15, query: "delta" });
    expect(byOldName.total).toBe(1);
  });

  it("keeps the stored identity for cards without a users row", async () => {
    await savePackWallet(db, USER_ID, cardPayload(1), 0, 1000);
    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.cards[0]).toMatchObject({ username: "delta", avatarUrl: "https://a.ppy.sh/42", countryCode: "CR" });
  });

  it("recycles by the same display name the listing filters on", async () => {
    await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, ?, ?)",
      [42, "delta_renamed", "https://a.ppy.sh/42?999", "ES", new Date(2000).toISOString()],
    );

    const result = await recyclePackCollectionCards(db, USER_ID, { mode: "whole_matching", query: "renamed" }, 3000);
    // Two rare copies: the kept one at full value, the duplicate at half.
    expect(result.gained).toBe(2 + 1);
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).total).toBe(0);
  });

  it("does not import card rows from stale wallet revisions", async () => {
    await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    await savePackWallet(db, USER_ID, '{"shards":5}', 1, 2000);

    const stale = await savePackWallet(db, USER_ID, cardPayload(10), 1, 3000, "delta");
    expect(stale.ok).toBe(false);

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.cards[0].copies).toBe(2);
  });
});

/* A collection card is (player, GOAT-or-not), not just player. Several
   honorary players are live ranked players, so their ordinary card and their
   GOAT are two collectibles that must survive alongside each other through a
   sync and recycle independently. */
describe("GOAT cards alongside their player's ordinary card", () => {
  const BOJII = 10083439; // on the honorary roster and in the ranked pool

  function bothCardsPayload(): string {
    const card = (tier: string, copies: number) => ({
      userId: BOJII,
      username: "bojii",
      avatarUrl: "https://a.ppy.sh/10083439",
      countryCode: "PH",
      tier,
      tierLabel: tier,
      skills: null,
      pp: 27107,
      globalRank: 4,
      copies,
      recycledCopies: 0,
      firstPulledAt: 100,
      lastPulledAt: 200,
    });
    return JSON.stringify({
      cards: { [String(BOJII)]: card("worldClass", 2), [`${BOJII}:goat`]: card("goat", 1) },
      shards: 0,
      shardsSpent: 0,
      charges: 5,
      lastRefillAt: 0,
      openedPacks: 0,
      poolTotal: null,
    });
  }

  it("stores both as separate rows instead of collapsing them", async () => {
    await savePackWallet(db, USER_ID, bothCardsPayload(), 0, 1000);
    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.total).toBe(2);
    expect(page.cards.map((card) => card.tier).sort()).toEqual(["goat", "worldClass"]);
    expect(await listPackCollectionOwnedCardKeys(db, USER_ID)).toEqual([String(BOJII), `${BOJII}:goat`]);
  });

  it("recycles one without touching the other, each at its own rate", async () => {
    await savePackWallet(db, USER_ID, bothCardsPayload(), 0, 1000);

    const ordinary = await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKey: String(BOJII) });
    expect(ordinary.gained).toBe(40 + 20);

    const remaining = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(remaining.total).toBe(1);
    expect(remaining.cards[0].tier).toBe("goat");

    const goat = await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKey: `${BOJII}:goat` });
    expect(goat.gained).toBe(400);
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).total).toBe(0);
  });
});

/* Databases created before GOAT cards split off key pack_collection_cards by
   (owner, player). SQLite cannot alter a primary key, so the table is rebuilt
   once on boot; getting that wrong would drop every collection in prod. */
describe("pack collection rekey", () => {
  async function createLegacyTable(): Promise<void> {
    await exec(db, "drop table if exists pack_collection_cards");
    await exec(
      db,
      `create table pack_collection_cards (
         owner_user_id integer not null,
         card_user_id integer not null,
         username text not null,
         avatar_url text not null,
         country_code text not null,
         tier text,
         tier_label text,
         skills_json text,
         pp real not null,
         global_rank integer not null,
         copies integer not null,
         recycled_copies integer not null,
         first_pulled_at integer not null,
         last_pulled_at integer not null,
         updated_at integer not null,
         primary key(owner_user_id, card_user_id)
       )`,
    );
  }

  async function seedLegacyCard(cardUserId: number, tier: string | null): Promise<void> {
    await exec(
      db,
      `insert into pack_collection_cards (
         owner_user_id, card_user_id, username, avatar_url, country_code, tier, tier_label, skills_json,
         pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
       ) values (?, ?, ?, '', 'CR', ?, ?, null, 1000, 500, 2, 1, 100, 200, 300)`,
      [USER_ID, cardUserId, `player${cardUserId}`, tier, tier],
    );
  }

  it("derives each row's key from its tier, keeping every card and its counts", async () => {
    await createLegacyTable();
    await seedLegacyCard(42, "rare");
    await seedLegacyCard(7, "goat");
    await seedLegacyCard(9, null);

    expect(await ensurePackCollectionCardKeys(db)).toBe(true);

    const rows = (await exec(db, "select card_user_id, card_key, copies, recycled_copies from pack_collection_cards order by card_user_id")).rows;
    expect(rows.map((row) => [Number(row.card_user_id), String(row.card_key)])).toEqual([
      [7, "7:goat"],
      [9, "9"],
      [42, "42"],
    ]);
    // Copy counts are the economy; a rebuild that resets them would hand out
    // free recycles.
    expect(rows.every((row) => Number(row.copies) === 2 && Number(row.recycled_copies) === 1)).toBe(true);
  });

  it("is a no-op once the table already carries keys", async () => {
    await createLegacyTable();
    await seedLegacyCard(42, "rare");
    expect(await ensurePackCollectionCardKeys(db)).toBe(true);
    expect(await ensurePackCollectionCardKeys(db)).toBe(false);
    expect((await exec(db, "select count(*) as c from pack_collection_cards")).rows[0]?.c).toBe(1);
  });

  it("leaves a rebuilt table writable through the normal sync path", async () => {
    await createLegacyTable();
    await seedLegacyCard(42, "rare");
    await ensurePackCollectionCardKeys(db);

    await savePackWallet(db, USER_ID, cardPayload(3), 0, 1000);
    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.total).toBe(1);
    // Snapshot reconcile against the rebuilt row: 3 pulled ever, 1 already
    // recycled, so 2 held. The conflict target resolved, which is the point.
    expect(page.cards[0]).toMatchObject({ userId: 42, copies: 2, recycledCopies: 1 });
  });
});

/* Legacy cards (collected before skills snapshots existed) repair themselves
   when the owner scrolls past them. A synced wallet keeps no cards in its
   pushed blob, so unless the repair lands in these rows it is simply lost and
   refetched next session. */
describe("collection card mints", () => {
  const BOJII = 10083439; // on the honorary roster, so eligible for GOAT
  const skills = { stream: 60, jack: 50, ln: 40, speed: 55, stamina: 45, precision: 35 };

  function legacyPayload(userId: number, tier: string | null, copies = 1): string {
    return JSON.stringify({
      cards: {
        [String(userId)]: {
          userId,
          username: "legacy",
          avatarUrl: "https://a.ppy.sh/1",
          countryCode: "CR",
          tier,
          tierLabel: tier,
          skills: null,
          pp: 5000,
          globalRank: 900,
          copies,
          recycledCopies: 0,
          firstPulledAt: 100,
          lastPulledAt: 200,
        },
      },
      shards: 0,
      shardsSpent: 0,
      charges: 5,
      lastRefillAt: 0,
      openedPacks: 0,
      poolTotal: null,
    });
  }

  it("writes the skills snapshot and tier onto the stored card", async () => {
    await savePackWallet(db, USER_ID, legacyPayload(42, null), 0, 1000);

    const result = await applyPackCollectionCardMint(db, USER_ID, "42", { tier: "elite", tierLabel: "Elite", skills });

    expect(result).toEqual({ applied: true, cardKey: "42" });
    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card.tier).toBe("elite");
    expect(card.tierLabel).toBe("Elite");
    expect(card.skills).toEqual(skills);
  });

  it("leaves a card that already minted at a better tier alone", async () => {
    await savePackWallet(db, USER_ID, legacyPayload(42, "mythic"), 0, 1000);
    await applyPackCollectionCardMint(db, USER_ID, "42", { tier: "mythic", tierLabel: "Mythic", skills });

    const again = await applyPackCollectionCardMint(db, USER_ID, "42", { tier: "rare", tierLabel: "Rare", skills });

    expect(again.applied).toBe(false);
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0].tier).toBe("mythic");
  });

  it("merges into the GOAT key when a tierless card mints as GOAT", async () => {
    await savePackWallet(db, USER_ID, legacyPayload(BOJII, null, 2), 0, 1000);
    // The owner already holds a GOAT of that player, pulled from the honorary slot.
    await exec(
      db,
      `insert into pack_collection_cards
       (owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label, skills_json,
        pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at)
       values (?, ?, ?, 'bojii', '', 'PH', 'goat', 'GOAT', null, 27107, 4, 1, 3, 50, 300, 1000)`,
      [USER_ID, BOJII, `${BOJII}:goat`],
    );

    const result = await applyPackCollectionCardMint(db, USER_ID, String(BOJII), { tier: "goat", tierLabel: "GOAT", skills });

    expect(result).toEqual({ applied: true, cardKey: `${BOJII}:goat` });
    expect(await listPackCollectionOwnedCardKeys(db, USER_ID)).toEqual([`${BOJII}:goat`]);
    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card.copies).toBe(3);
    expect(card.recycledCopies).toBe(3);
    expect(card.firstPulledAt).toBe(50);
    expect(card.lastPulledAt).toBe(300);
    expect(card.skills).toEqual(skills);
  });

  it("refuses a GOAT claim for a player who is not on the honorary roster", async () => {
    await savePackWallet(db, USER_ID, legacyPayload(42, null), 0, 1000);

    const result = await applyPackCollectionCardMint(db, USER_ID, "42", { tier: "goat", tierLabel: "GOAT", skills });

    // The mint still lands, just unrated: a forged tier can never print shards.
    expect(result).toEqual({ applied: true, cardKey: "42" });
    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card.tier).toBeNull();
    expect(card.skills).toEqual(skills);
  });

  it("refuses an invented tier, including inherited object keys", async () => {
    await savePackWallet(db, USER_ID, legacyPayload(BOJII, "mythic"), 0, 1000);
    await applyPackCollectionCardMint(db, USER_ID, String(BOJII), { tier: "mythic", tierLabel: "Mythic", skills });

    // "constructor" resolves on any object literal, so a rank lookup that is
    // not an own-property check would compare a number against a function
    // (always false) and let this overwrite an already-minted better tier.
    const result = await applyPackCollectionCardMint(db, USER_ID, String(BOJII), {
      tier: "constructor",
      tierLabel: "x",
      skills: { stream: 1 },
    });

    expect(result.applied).toBe(false);
    expect(await listPackCollectionOwnedCardKeys(db, USER_ID)).toEqual([String(BOJII)]);
    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card.tier).toBe("mythic");
    expect(card.skills).toEqual(skills);
    // A recycle of that card still values it as a real tier, never NaN.
    expect((await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKey: String(BOJII) })).gained).toBe(20);
  });

  it("ignores a mint for a card the owner does not hold", async () => {
    await savePackWallet(db, USER_ID, legacyPayload(42, null), 0, 1000);

    expect(await applyPackCollectionCardMint(db, USER_ID, "77", { tier: "rare", tierLabel: "Rare", skills }))
      .toEqual({ applied: false, cardKey: null });
    expect(await applyPackCollectionCardMint(db, USER_ID, "42", { tier: "rare", tierLabel: "Rare", skills: null }))
      .toEqual({ applied: false, cardKey: null });
  });
});
