import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  applyPackCollectionCardMint,
  countMissingGoatCards,
  ensurePackCardCatalog,
  ensurePackCardVariantKeys,
  ensurePackCollectionCardKeys,
  GRANT_ONLY_TIERS,
  isPackCardVariantKey,
  normalizePackCardKey,
  packCardVariantKey,
  getPackCollectionPoolProgress,
  getPackShowcase,
  HONORARY_USER_IDS,
  getPackWallet,
  listPackCollectionCards,
  listPackCollectionMissingPlayers,
  listPackCollectionOwnedCardKeys,
  listMissingGoatCardUserIds,
  recyclePackCollectionCards,
  savePackWallet,
  setPackShowcase,
} from "../src/features/pack-wallets.js";
import { VALID_TIERS as PULLABLE_TIERS } from "../src/features/pack-pulls.js";
import { seedCollectionCard } from "./helpers/pack-cards.js";

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
    expect(result.gained).toBe(4 + 2);
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).total).toBe(0);
  });

  it("recycles only the copies named, leaving the rest of the holding alone", async () => {
    await savePackWallet(db, USER_ID, cardPayload(3), 0, 1000);

    // What the pull summary hands a pack back with: one copy of a card the
    // collector already had, priced as the duplicate it is.
    const one = await recyclePackCollectionCards(
      db,
      USER_ID,
      { mode: "copies", cardCopies: [{ cardKey: "42", copies: 1 }] },
      2000,
    );
    expect(one.gained).toBe(2);
    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.cards[0]).toMatchObject({ copies: 2, recycledCopies: 1 });

    // Asking for more copies than are held takes the card out of the
    // collection and pays exactly what whole-recycling it would.
    const rest = await recyclePackCollectionCards(
      db,
      USER_ID,
      { mode: "copies", cardCopies: [{ cardKey: "42", copies: 5 }] },
      3000,
    );
    expect(rest.gained).toBe(4 + 2);
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
    expect(ordinary.gained).toBe(48 + 24);

    const remaining = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(remaining.total).toBe(1);
    expect(remaining.cards[0].tier).toBe("goat");

    const goat = await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKey: `${BOJII}:goat` });
    expect(goat.gained).toBe(500);
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).total).toBe(0);
  });
});

/* The header's completion ratio: owned ordinary players still drawable over
   that pool's size. Retired players report separately instead of inflating the
   ratio past 100%, and honorary roster members count only as GOAT variants. */
describe("pack collection pool progress", () => {
  const BOJII = 10083439; // honorary roster

  function progressCard(userId: number, tier: string) {
    return {
      userId,
      username: `player${userId}`,
      avatarUrl: `https://a.ppy.sh/${userId}`,
      countryCode: "CR",
      tier,
      tierLabel: tier,
      skills: null,
      pp: 1000,
      globalRank: 10,
      copies: 1,
      recycledCopies: 0,
      firstPulledAt: 100,
      lastPulledAt: 200,
    };
  }

  function progressPayload(cards: Record<string, unknown>): string {
    return JSON.stringify({
      cards,
      shards: 0,
      shardsSpent: 0,
      charges: 5,
      lastRefillAt: 0,
      openedPacks: 0,
      poolTotal: null,
    });
  }

  it("splits owned players into in-pool, retired, and off-pool honorary", async () => {
    const payload = progressPayload({
      "42": progressCard(42, "rare"),
      "43": progressCard(43, "rare"),
      [`${BOJII}:goat`]: progressCard(BOJII, "goat"),
    });
    await savePackWallet(db, USER_ID, payload, 0, 1000);

    // 42 is still in the pool, 43 has fallen off the rankings, and BOJII's
    // GOAT sits outside the pool here, so only the first two register.
    const progress = await getPackCollectionPoolProgress(db, USER_ID, {
      userIds: new Set([42, 77, 78]),
      total: 3,
    });
    expect(progress).toEqual({ poolTotal: 3, poolOwnedCount: 1, retiredOwnedCount: 1, offPoolUserIds: [43] });
  });

  it("lists and recycles only the restricted players under the untracked filter", async () => {
    const payload = progressPayload({
      "42": progressCard(42, "rare"),
      "43": progressCard(43, "rare"),
      [`${BOJII}:goat`]: progressCard(BOJII, "goat"),
    });
    await savePackWallet(db, USER_ID, payload, 0, 1000);

    const filtered = await listPackCollectionCards(db, USER_ID, {
      page: 0,
      pageSize: 15,
      restrictToCardUserIds: [43],
    });
    expect(filtered.total).toBe(1);
    expect(filtered.cards[0].userId).toBe(43);

    // An empty restriction means the pool was unreadable; it must match
    // nothing rather than fall open to the whole collection.
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15, restrictToCardUserIds: [] })).total).toBe(0);

    const recycled = await recyclePackCollectionCards(db, USER_ID, {
      mode: "whole_matching",
      tier: "all",
      query: "",
      restrictToCardUserIds: [43],
    });
    expect(recycled.gained).toBe(4);
    const remaining = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(remaining.total).toBe(2);
    expect(remaining.cards.map((card) => card.userId).sort()).toEqual([BOJII, 42].sort());
  });

  it("keeps a ranked honorary player out of the ordinary completion pool", async () => {
    const payload = progressPayload({
      [String(BOJII)]: progressCard(BOJII, "worldClass"),
      [`${BOJII}:goat`]: progressCard(BOJII, "goat"),
    });
    await savePackWallet(db, USER_ID, payload, 0, 1000);

    const progress = await getPackCollectionPoolProgress(db, USER_ID, {
      userIds: new Set([BOJII]),
      total: 1,
    });
    expect(progress).toEqual({ poolTotal: 0, poolOwnedCount: 0, retiredOwnedCount: 0, offPoolUserIds: [] });
  });

  /* The complement of that ratio: the pullable players with no card in this
     collection, which is what the "N missing" list on /packs shows. */
  describe("missing players", () => {
    function poolEntry(userId: number, rank: number) {
      return {
        rank,
        user: {
          id: userId,
          username: `player${userId}`,
          avatar_url: `https://a.ppy.sh/${userId}`,
          country_code: "CR",
        },
        pp: 10_000 - rank,
        global_rank: rank,
      };
    }

    it("lists the pool players this collection has no card of, in pool order", async () => {
      await savePackWallet(db, USER_ID, progressPayload({ "43": progressCard(43, "rare") }), 0, 1000);

      const missing = await listPackCollectionMissingPlayers(
        db,
        USER_ID,
        [poolEntry(42, 1), poolEntry(43, 2), poolEntry(44, 3)],
        { page: 0, pageSize: 15 },
      );
      expect(missing.total).toBe(2);
      expect(missing.players.map((player) => player.userId)).toEqual([42, 44]);
      expect(missing.players[0]).toMatchObject({ username: "player42", poolRank: 1, globalRank: 1 });
    });

    it("does not list a ranked honorary member as an ordinary missing card", async () => {
      await savePackWallet(db, USER_ID, progressPayload({}), 0, 1000);

      const missing = await listPackCollectionMissingPlayers(db, USER_ID, [poolEntry(BOJII, 1), poolEntry(42, 2)], {
        page: 0,
        pageSize: 15,
      });
      expect(missing.total).toBe(1);
      expect(missing.players.map((player) => player.userId)).toEqual([42]);
    });

    it("does not let an Eternal variant fill its player's ordinary slot", async () => {
      await seedCollectionCard(db, USER_ID, 42, { tier: "eternal" });
      const pool = { userIds: new Set([42]), total: 1 };

      expect(await getPackCollectionPoolProgress(db, USER_ID, pool)).toMatchObject({
        poolTotal: 1,
        poolOwnedCount: 0,
      });
      expect(
        (await listPackCollectionMissingPlayers(db, USER_ID, [poolEntry(42, 1)], { page: 0, pageSize: 15 }))
          .players.map((player) => player.userId),
      ).toEqual([42]);

      await seedCollectionCard(db, USER_ID, 42, { tier: "rare" });
      expect(await getPackCollectionPoolProgress(db, USER_ID, pool)).toMatchObject({ poolOwnedCount: 1 });
      expect(
        (await listPackCollectionMissingPlayers(db, USER_ID, [poolEntry(42, 1)], { page: 0, pageSize: 15 })).total,
      ).toBe(0);
    });

    it("searches by username and pages the matches", async () => {
      await savePackWallet(db, USER_ID, progressPayload({}), 0, 1000);
      const pool = [poolEntry(42, 1), poolEntry(430, 2), poolEntry(431, 3)];

      const searched = await listPackCollectionMissingPlayers(db, USER_ID, pool, {
        page: 0,
        pageSize: 15,
        query: "PLAYER43",
      });
      expect(searched.total).toBe(2);
      expect(searched.players.map((player) => player.userId)).toEqual([430, 431]);

      const secondPage = await listPackCollectionMissingPlayers(db, USER_ID, pool, { page: 1, pageSize: 2 });
      expect(secondPage.total).toBe(3);
      expect(secondPage.players.map((player) => player.userId)).toEqual([431]);
    });

    it("lists and counts missing GOAT variants, and an ordinary card is not one", async () => {
      await savePackWallet(db, USER_ID, progressPayload({}), 0, 1000);
      expect(await countMissingGoatCards(db, USER_ID)).toBe(HONORARY_USER_IDS.size);
      expect(await listMissingGoatCardUserIds(db, USER_ID)).toEqual([...HONORARY_USER_IDS]);

      // BOJII is on the honorary roster and in the ranked board, but his plain
      // legacy card still is not the GOAT variant completion requires.
      await savePackWallet(db, USER_ID, progressPayload({ [String(BOJII)]: progressCard(BOJII, "worldClass") }), 1, 1000);
      expect(await countMissingGoatCards(db, USER_ID)).toBe(HONORARY_USER_IDS.size);

      await savePackWallet(
        db,
        USER_ID,
        progressPayload({ [String(BOJII)]: progressCard(BOJII, "worldClass"), [`${BOJII}:goat`]: progressCard(BOJII, "goat") }),
        2,
        1000,
      );
      expect(await countMissingGoatCards(db, USER_ID)).toBe(HONORARY_USER_IDS.size - 1);
      const missingGoatIds = await listMissingGoatCardUserIds(db, USER_ID);
      expect(missingGoatIds).toHaveLength(HONORARY_USER_IDS.size - 1);
      expect(missingGoatIds).not.toContain(BOJII);
    });
  });
});

/* The profile showcase shelf: pins reference collection rows, so the server
   only ever accepts and serves cards the owner actually holds. */
describe("pack showcase", () => {
  function showcaseCard(userId: number, tier: string) {
    return {
      userId,
      username: `player${userId}`,
      avatarUrl: `https://a.ppy.sh/${userId}`,
      countryCode: "CR",
      tier,
      tierLabel: tier,
      skills: null,
      pp: 1000 + userId,
      globalRank: 10,
      copies: 1,
      recycledCopies: 0,
      firstPulledAt: 100,
      lastPulledAt: 200,
    };
  }

  async function seedCollection(userIds: number[]): Promise<void> {
    const payload = JSON.stringify({
      cards: Object.fromEntries(userIds.map((id) => [String(id), showcaseCard(id, "rare")])),
      shards: 0,
      shardsSpent: 0,
      charges: 5,
      lastRefillAt: 0,
      openedPacks: 0,
      poolTotal: null,
    });
    await savePackWallet(db, USER_ID, payload, 0, 1000);
  }

  it("stores pinned keys in order and serves the matching cards", async () => {
    await seedCollection([41, 42, 43]);
    const kept = await setPackShowcase(db, USER_ID, ["43", "41"]);
    expect(kept).toEqual(["43", "41"]);
    const shelf = await getPackShowcase(db, USER_ID);
    expect(shelf.map((card) => card.userId)).toEqual([43, 41]);
    expect(shelf.map((card) => card.cardKey)).toEqual(["43", "41"]);
  });

  it("drops unowned and malformed keys and caps the shelf at five", async () => {
    await seedCollection([1, 2, 3, 4, 5, 6, 7]);
    const kept = await setPackShowcase(db, USER_ID, ["1", "999", "nonsense", "2", "3", "4", "5", "6"]);
    expect(kept).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("replaces the shelf wholesale and lets a recycled card fall off", async () => {
    await seedCollection([41, 42]);
    await setPackShowcase(db, USER_ID, ["41", "42"]);
    expect(await setPackShowcase(db, USER_ID, ["42"])).toEqual(["42"]);
    expect((await getPackShowcase(db, USER_ID)).map((card) => card.userId)).toEqual([42]);

    await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKey: "42" });
    expect(await getPackShowcase(db, USER_ID)).toEqual([]);
  });

  it("keeps shelves per owner", async () => {
    await seedCollection([41]);
    await setPackShowcase(db, USER_ID, ["41"]);
    expect(await getPackShowcase(db, 777)).toEqual([]);
    expect(await setPackShowcase(db, 777, ["41"])).toEqual([]);
  });

  it("keeps the stamp a card went up with, and only stamps the ones that are new", async () => {
    /* The wall sorts on this, so it has to mean "when this card was chosen".
       Restamping the whole shelf on every save would refloat five cards for
       one change, and reordering the shelf would refloat them for none. */
    await seedCollection([41, 42, 43]);
    await setPackShowcase(db, USER_ID, ["41", "42"]);
    const first = await stamps();
    expect(new Set(Object.values(first)).size).toBe(1);

    await setPackShowcase(db, USER_ID, ["42", "43", "41"]);
    const second = await stamps();

    // 41 and 42 were already up, in either order; only 43 is new.
    expect(second["41"]).toBe(first["41"]);
    expect(second["42"]).toBe(first["42"]);
    expect(second["43"]).toBeGreaterThanOrEqual(first["41"]);
  });

  async function stamps(): Promise<Record<string, number>> {
    const rows = (await exec(
      db,
      "select card_key, updated_at from pack_showcase_cards where owner_user_id = ?",
      [USER_ID],
    )).rows;
    return Object.fromEntries(rows.map((row) => [String(row.card_key), Number(row.updated_at)]));
  }
});

/* Snapshots are shared between collections but owned by neither: two players
   holding the same mint point at one row, and what one of them does to their
   card must not reach through it to the other. */
describe("interned skills snapshots", () => {
  const walletWithSkills = (userId: number, skills: unknown, pp = 1000): string =>
    JSON.stringify({
      cards: {
        [String(userId)]: {
          userId,
          username: `player${userId}`,
          avatarUrl: "https://a.ppy.sh/1",
          countryCode: "CR",
          tier: "rare",
          tierLabel: "Rare",
          skills,
          pp,
          globalRank: 500,
          copies: 1,
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

  it("stores one row for a snapshot two collectors share, and keeps differing ones apart", async () => {
    const shared = { stream: 60, jack: 50 };
    await savePackWallet(db, USER_ID, walletWithSkills(42, shared), 0, 1000);
    await savePackWallet(db, USER_ID + 1, walletWithSkills(42, shared), 0, 1000);
    await savePackWallet(db, USER_ID + 2, walletWithSkills(42, { stream: 71, jack: 44 }), 0, 1000);

    expect((await exec(db, "select count(*) n from pack_card_skills")).rows[0].n).toBe(2);
    const ids = (await exec(
      db,
      "select owner_user_id, skills_id from pack_collection_cards order by owner_user_id",
    )).rows.map((row) => Number(row.skills_id));
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);

    // And each collector still reads back the numbers their own pull minted.
    const read = async (owner: number) =>
      (await listPackCollectionCards(db, owner, { page: 0, pageSize: 15 })).cards[0].skills;
    expect(await read(USER_ID)).toEqual(shared);
    expect(await read(USER_ID + 1)).toEqual(shared);
    expect(await read(USER_ID + 2)).toEqual({ stream: 71, jack: 44 });
  });

  it("leaves a sharer's card alone when the other recycles theirs", async () => {
    const shared = { stream: 60, jack: 50 };
    await savePackWallet(db, USER_ID, walletWithSkills(42, shared), 0, 1000);
    await savePackWallet(db, USER_ID + 1, walletWithSkills(42, shared), 0, 1000);

    await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKeys: ["42"] });

    const survivor = (await listPackCollectionCards(db, USER_ID + 1, { page: 0, pageSize: 15 })).cards[0];
    expect(survivor.skills).toEqual(shared);
    expect(survivor.copies).toBe(1);
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
    // Both rebuilds, in the order boot runs them.
    await ensurePackCollectionCardKeys(db);
    await ensurePackCardCatalog(db);

    await savePackWallet(db, USER_ID, cardPayload(3), 0, 1000);
    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.total).toBe(1);
    // Snapshot reconcile against the rebuilt row: 3 pulled ever, 1 already
    // recycled, so 2 held. The conflict target resolved, which is the point.
    expect(page.cards[0]).toMatchObject({ userId: 42, copies: 2, recycledCopies: 1 });
  });

  /* The catalog split moved each card's face (name, avatar, tier label, skills
     snapshot, mint stats) off every ownership row and into one row per card
     variant. The rebuild runs over every collection in prod, so losing a face
     or an ownership row here is losing it there. */
  describe("card catalog split", () => {
    it("seeds one catalog row per variant and keeps every holding", async () => {
      await createLegacyTable();
      await seedLegacyCard(42, "rare");
      await seedLegacyCard(7, "goat");
      await ensurePackCollectionCardKeys(db);
      // A second owner of the same card: the face is shared, the holdings are not.
      await exec(
        db,
        `insert into pack_collection_cards
           (owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label,
            skills_json, pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at)
         values (?, 42, '42', 'player42', '', 'CR', 'rare', 'rare', null, 1000, 500, 5, 0, 100, 200, 300)`,
        [USER_ID + 1],
      );

      expect(await ensurePackCardCatalog(db)).toBe(true);

      const catalog = (await exec(db, "select * from pack_cards order by card_key")).rows;
      expect(catalog).toHaveLength(2);
      expect(catalog.map((row) => [String(row.card_key), String(row.tier)])).toEqual([
        ["42", "rare"],
        ["7:goat", "goat"],
      ]);
      expect(String(catalog[0].username)).toBe("player42");

      const held = (await exec(
        db,
        "select owner_user_id, card_key, copies, recycled_copies from pack_collection_cards order by owner_user_id, card_key",
      )).rows;
      expect(held).toHaveLength(3);
      expect(held.map((row) => [Number(row.owner_user_id), String(row.card_key), Number(row.copies)])).toEqual([
        [USER_ID, "42", 2],
        [USER_ID, "7:goat", 2],
        [USER_ID + 1, "42", 5],
      ]);
      // The fat columns are gone, which is the point of the rebuild.
      const columns = (await exec(db, "pragma table_info(pack_collection_cards)")).rows.map((row) => String(row.name));
      expect(columns).not.toContain("username");
      expect(columns).not.toContain("skills_json");
    });

    /* The snapshot is what each owner's pull froze, so two collectors of the
       same card can hold different numbers. Interning has to keep both; the
       whole point of not merging them into one card face. */
    it("keeps each owner's own skills snapshot, storing each distinct one once", async () => {
      await createLegacyTable();
      await ensurePackCollectionCardKeys(db);
      const insertFat = async (owner: number, skillsJson: string | null, pp: number) => {
        await exec(
          db,
          `insert into pack_collection_cards
             (owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label,
              skills_json, pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at)
           values (?, 42, '42', 'player42', '', 'CR', 'rare', 'Rare', ?, ?, 500, 1, 0, 1, 1, 1)`,
          [owner, skillsJson, pp],
        );
      };
      await insertFat(USER_ID, '{"stream":60}', 1000);
      await insertFat(USER_ID + 1, '{"stream":72}', 1100);
      await insertFat(USER_ID + 2, '{"stream":60}', 1200);
      await insertFat(USER_ID + 3, null, 1300);

      await ensurePackCardCatalog(db);

      // Three owners carried two distinct snapshots, so two rows are stored.
      const snapshots = (await exec(db, "select id, skills_json from pack_card_skills order by id")).rows;
      expect(snapshots.map((row) => String(row.skills_json))).toEqual(['{"stream":60}', '{"stream":72}']);

      const held = (await exec(
        db,
        `select c.owner_user_id, c.pp, sk.skills_json
         from pack_collection_cards c
         left join pack_card_skills sk on sk.id = c.skills_id
         order by c.owner_user_id`,
      )).rows;
      expect(held.map((row) => [Number(row.owner_user_id), Number(row.pp), row.skills_json ?? null])).toEqual([
        [USER_ID, 1000, '{"stream":60}'],
        [USER_ID + 1, 1100, '{"stream":72}'],
        [USER_ID + 2, 1200, '{"stream":60}'],
        [USER_ID + 3, 1300, null],
      ]);
      // The two owners on the same snapshot share one row rather than copying it.
      const shared = (await exec(
        db,
        "select distinct skills_id from pack_collection_cards where owner_user_id in (?, ?)",
        [USER_ID, USER_ID + 2],
      )).rows;
      expect(shared).toHaveLength(1);
    });

    it("is a no-op once the table is already split", async () => {
      await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
      expect(await ensurePackCardCatalog(db)).toBe(false);
      const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
      expect(page.cards[0]).toMatchObject({ userId: 42, copies: 2 });
    });
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
    await seedCollectionCard(db, USER_ID, BOJII, {
      tier: "goat",
      tierLabel: "GOAT",
      username: "bojii",
      countryCode: "PH",
      pp: 27107,
      globalRank: 4,
      copies: 1,
      recycledCopies: 3,
      firstPulledAt: 50,
      lastPulledAt: 300,
      updatedAt: 1000,
    });

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
    expect((await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKey: String(BOJII) })).gained).toBe(27);
  });

  it("ignores a mint for a card the owner does not hold", async () => {
    await savePackWallet(db, USER_ID, legacyPayload(42, null), 0, 1000);

    expect(await applyPackCollectionCardMint(db, USER_ID, "77", { tier: "rare", tierLabel: "Rare", skills }))
      .toEqual({ applied: false, cardKey: null });
    expect(await applyPackCollectionCardMint(db, USER_ID, "42", { tier: "rare", tierLabel: "Rare", skills: null }))
      .toEqual({ applied: false, cardKey: null });
  });
});

/* A wallet is client-authored, and these fields are read back out by the public
   share card and painted into its OG image on this site's own domain. The caps
   do not make the economy honest - the shard balance is the client's to write -
   they bound what a hand-edited wallet can put on a public page. */
describe("wallet card field bounds", () => {
  function hostilePayload(overrides: Record<string, unknown>): string {
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
          copies: 1,
          recycledCopies: 0,
          firstPulledAt: 100,
          lastPulledAt: 200,
          ...overrides,
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

  async function storedCard(): Promise<Record<string, unknown>> {
    // The card's face lives in the catalog now, so the assertions below read
    // the ownership row joined to its variant.
    return (await exec(
      db,
      // Both tables carry a tier_label now, and a duplicate result column
      // resolves to the first, so the effective one is coalesced by hand.
      `select pack_collection_cards.*,
         pc.username as username, pc.avatar_url as avatar_url, pc.country_code as country_code,
         coalesce(pack_collection_cards.tier_label, pc.tier_label) as effective_tier_label,
         sk.skills_json as skills_json
       from pack_collection_cards
       left join pack_cards pc
         on pc.card_key = pack_collection_cards.card_key
         and pc.tier = coalesce(pack_collection_cards.tier, '')
       left join pack_card_skills sk on sk.id = pack_collection_cards.skills_id
       where pack_collection_cards.owner_user_id = ?`,
      [USER_ID],
    )).rows[0] as never;
  }

  it("keeps a non-https avatar out of the stored card", async () => {
    await savePackWallet(db, USER_ID, hostilePayload({ avatarUrl: "javascript:alert(1)" }), 0, 5000);
    expect((await storedCard()).avatar_url).toBe("");
  });

  it("truncates an oversized username and tier label", async () => {
    await savePackWallet(db, USER_ID, hostilePayload({ username: "n".repeat(500), tierLabel: "L".repeat(500) }), 0, 5000);
    const card = await storedCard();
    expect(String(card.username)).toHaveLength(40);
    expect(String(card.effective_tier_label)).toHaveLength(60);
  });

  it("drops a country code that is not two letters", async () => {
    // The value is rendered as a flag, so anything that is not a plain pair of
    // letters degrades to empty rather than to a broken flag.
    await savePackWallet(db, USER_ID, hostilePayload({ countryCode: "x9" }), 0, 5000);
    expect((await storedCard()).country_code).toBe("");
    await savePackWallet(db, USER_ID, hostilePayload({ countryCode: "" }), 1, 5000);
    expect((await storedCard()).country_code).toBe("");
  });

  it("drops an oversized skills blob rather than the card", async () => {
    const bloat: Record<string, number> = {};
    for (let i = 0; i < 500; i += 1) bloat[`skill${i}`] = i;
    await savePackWallet(db, USER_ID, hostilePayload({ skills: bloat }), 0, 5000);
    const card = await storedCard();
    expect(card.skills_json).toBeNull();
    expect(card.card_user_id).toBe(42);
  });

  it("refuses a pull stamped in the future", async () => {
    const now = 5000;
    await savePackWallet(db, USER_ID, hostilePayload({ firstPulledAt: 9e15, lastPulledAt: 9e15 }), 0, now);
    const card = await storedCard();
    expect(Number(card.first_pulled_at)).toBe(now);
    expect(Number(card.last_pulled_at)).toBe(now);
  });

  it("caps an absurd copy count", async () => {
    await savePackWallet(db, USER_ID, hostilePayload({ copies: 5_000_000 }), 0, 5000);
    expect(Number((await storedCard()).copies)).toBe(100_000);
  });
});


describe("granted card keys", () => {
  /* Every card a collector holds is addressable on its own: the player's
     ordinary card, their GOAT, and each one the grant desk handed out. Only
     the first two are derived from a tier, which is what a browser can compute
     and therefore what a browser may claim. */
  it("accepts the three key forms and nothing else", () => {
    expect(normalizePackCardKey("42")).toBe("42");
    expect(normalizePackCardKey("42:goat")).toBe("42:goat");
    expect(normalizePackCardKey("42:v3")).toBe("42:v3");
    // Leading zeros normalize, so one card cannot be addressed two ways.
    expect(normalizePackCardKey("042:v03")).toBe("42:v3");
    for (const bad of ["42:v0", "42:v", "42:vx", "42:v1234567", "42:goat:v1", "42:V1", ":v1", "42:"]) {
      expect(normalizePackCardKey(bad)).toBeNull();
    }
  });

  it("tells a granted key from a derived one", () => {
    expect(isPackCardVariantKey(packCardVariantKey(42, 2))).toBe(true);
    expect(isPackCardVariantKey("42")).toBe(false);
    expect(isPackCardVariantKey("42:goat")).toBe(false);
  });

  it("names only tiers no roll can produce", () => {
    /* "eternal" sits in both sets since the completion reward: a pull may
       claim it, but only under pack-pulls' guard (the reporter's own card,
       backed by a held ":eternal" row that only the draw route's one-time
       completion deal writes). What still holds unconditionally is that no
       client computation reaches the tier - claimedTier refuses it outright,
       so a forged wallet or mint can never talk a card up to it. */
    expect(PULLABLE_TIERS.has("eternal")).toBe(true);
    expect([...GRANT_ONLY_TIERS]).toEqual(["eternal"]);
  });

  it("moves cards granted before keys existed onto their own", async () => {
    /* The state the backfill exists for: an Eternal and a badge sitting on the
       player's ordinary key, indistinguishable from a pulled card except by
       its columns, with a serial and a showcase slot pointing at that key. */
    await seedCollectionCard(db, USER_ID, 42, { tier: "eternal", copies: 1 });
    // A second collector was handed the same card.
    await seedCollectionCard(db, USER_ID + 1, 42, { tier: "eternal", copies: 1 });
    /* The helper now derives ":eternal" for the tier; these fixtures model
       rows from before derived eternal keys existed, sitting on the plain
       key, so put them (and the catalog face) back where the backfill finds
       them. */
    await exec(db, "update pack_collection_cards set card_key = '42' where card_key = '42:eternal'");
    await exec(db, "update or ignore pack_cards set card_key = '42' where card_key = '42:eternal'");
    await exec(
      db,
      "update pack_collection_cards set tier_label = 'Mano', motif = '{\"url\":\"https://x.test/a.png\"}' where owner_user_id in (?, ?) and card_key = '42'",
      [USER_ID, USER_ID + 1],
    );
    await exec(
      db,
      "insert into pack_card_serials (card_key, card_user_id, owner_user_id, serial, minted_at) values ('42', 42, ?, 1, 1000)",
      [USER_ID],
    );
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, '42', 1000)",
      [USER_ID],
    );
    // And a third collector pulled the ordinary card.
    await seedCollectionCard(db, USER_ID + 2, 42, { tier: "rare", copies: 2 });

    expect(await ensurePackCardVariantKeys(db)).toBe(2);

    // One key for the one card, both holders on it.
    const granted = (await exec(
      db,
      "select owner_user_id from pack_collection_cards where card_key = '42:v1' order by owner_user_id asc",
    )).rows;
    expect(granted.map((row) => Number(row.owner_user_id))).toEqual([USER_ID, USER_ID + 1]);
    // The pulled card stays where it is.
    expect(Number((await exec(db, "select count(*) as held from pack_collection_cards where card_key = '42'")).rows[0]?.held)).toBe(1);
    // And the mint order and the showcase slot followed the card.
    expect(Number((await exec(db, "select serial from pack_card_serials where card_key = '42:v1' and owner_user_id = ?", [USER_ID])).rows[0]?.serial)).toBe(1);
    expect(String((await exec(db, "select card_key from pack_showcase_cards where owner_user_id = ?", [USER_ID])).rows[0]?.card_key)).toBe("42:v1");
    // The variant has a face of its own, copied off the key it left.
    expect(Number((await exec(db, "select count(*) as faces from pack_cards where card_key = '42:v1'")).rows[0]?.faces)).toBe(1);

    // Nothing left to move.
    expect(await ensurePackCardVariantKeys(db)).toBe(0);
  });

  it("marks the cards it moves as given, and the ones already moved too", async () => {
    /* Both halves of the same scan: a grant still on a plain key, and one
       already on a variant key from before the column existed. Neither was
       pulled, and both are minted serials, so without the stamp every surface
       would go on calling their holders the Nth to pull them. */
    await exec(db, `insert into pack_collection_cards (
        owner_user_id, card_user_id, card_key, tier, tier_label, motif, skills_id,
        pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, 'eternal', 'Mano', null, null, 0, 0, 1, 0, 4000, 4000, 4000)`,
      [USER_ID, 900, "900"]);
    await exec(db, `insert into pack_collection_cards (
        owner_user_id, card_user_id, card_key, tier, tier_label, motif, skills_id,
        pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, 'eternal', null, null, null, 0, 0, 1, 0, 7000, 7000, 7000)`,
      [USER_ID, 901, "901:v1"]);

    await ensurePackCardVariantKeys(db);

    const rows = (await exec(
      db,
      "select card_key, granted_at from pack_collection_cards where owner_user_id = ? order by card_user_id",
      [USER_ID],
    )).rows;
    expect(rows.map((row) => [String(row.card_key), Number(row.granted_at)])).toEqual([
      ["900:v1", 4000],
      ["901:v1", 7000],
    ]);
  });

  it("lets the holder recycle a granted card like any other", async () => {
    await seedCollectionCard(db, USER_ID, 42, { tier: "eternal", copies: 1 });
    await exec(db, "update pack_collection_cards set card_key = '42:v1', tier_label = 'Mano' where owner_user_id = ?", [USER_ID]);
    const recycled = await recyclePackCollectionCards(db, USER_ID, { mode: "whole", cardKey: "42:v1" });
    // Eternal's own shard value, not the unrated floor an unreachable key pays.
    expect(recycled.gained).toBe(250);
    expect(Number((await exec(db, "select copies from pack_collection_cards where owner_user_id = ? and card_key = '42:v1'", [USER_ID])).rows[0]?.copies)).toBe(0);
  });
});
