import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  applyPackCollectionCardMint,
  getPackWallet,
  HONORARY_USER_IDS,
  listPackCollectionCards,
  MAX_PACK_CHARGES,
  mergeImportedPackWallet,
  mintDealtPackCards,
  PACK_CHARGE_REGEN_MS,
  PACK_OPEN_SHARD_REWARD,
  packCardKey,
  packWalletEconomy,
  spendPackOpen,
  type DealtPackCardSlot,
} from "../src/features/pack-wallets.js";
import { seedCollectionCard } from "./helpers/pack-cards.js";

let dir = "";
let db: Db;

const USER_ID = 14600698;
const T0 = 1_700_000_000_000;

async function seedWallet(userId: number, economy: Record<string, unknown>, now = T0): Promise<void> {
  const payload = JSON.stringify({
    cards: {},
    shards: 0,
    shardsSpent: 0,
    charges: MAX_PACK_CHARGES,
    lastRefillAt: now,
    openedPacks: 0,
    poolTotal: null,
    ...economy,
  });
  await exec(
    db,
    `insert into pack_wallets (user_id, payload, rev, updated_at) values (?, ?, 1, ?)
     on conflict(user_id) do update set payload = excluded.payload, updated_at = excluded.updated_at`,
    [userId, payload, now],
  );
}

async function economyOf(userId: number, now = T0) {
  const wallet = await getPackWallet(db, userId);
  return packWalletEconomy(wallet?.payload ?? null, now);
}

function rankedSlot(userId: number, overrides: Partial<DealtPackCardSlot> = {}): DealtPackCardSlot {
  return {
    userId,
    tier: null,
    username: `p${userId}`,
    avatarUrl: `https://a.ppy.sh/${userId}`,
    countryCode: "CR",
    pp: 9000,
    globalRank: 123,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-economy-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("spendPackOpen", () => {
  it("creates a wallet and spends a charge, banking the open reward", async () => {
    const result = await spendPackOpen(db, USER_ID, { kind: "charge" }, T0, 6000);
    expect(result.ok).toBe(true);
    const economy = await economyOf(USER_ID);
    expect(economy.charges).toBe(MAX_PACK_CHARGES - 1);
    expect(economy.shards).toBe(PACK_OPEN_SHARD_REWARD);
    expect(economy.openedPacks).toBe(1);
    expect(economy.poolTotal).toBe(6000);
    // Spending from a full wallet starts the regen clock at the spend.
    expect(economy.lastRefillAt).toBe(T0);
  });

  it("regenerates charges from elapsed time before deciding affordability", async () => {
    await seedWallet(USER_ID, { charges: 0, lastRefillAt: T0 });
    const later = T0 + 2 * PACK_CHARGE_REGEN_MS;
    const result = await spendPackOpen(db, USER_ID, { kind: "charge" }, later);
    expect(result.ok).toBe(true);
    // Two regenerated, one spent.
    expect((await economyOf(USER_ID, later)).charges).toBe(1);
  });

  it("refuses an empty wallet without writing anything", async () => {
    await seedWallet(USER_ID, { charges: 0, lastRefillAt: T0 });
    const before = await getPackWallet(db, USER_ID);
    const result = await spendPackOpen(db, USER_ID, { kind: "charge" }, T0 + 1000);
    expect(result).toMatchObject({ ok: false, reason: "charges" });
    expect((await getPackWallet(db, USER_ID))?.rev).toBe(before?.rev);
  });

  it("spends shards for the paid packs and refuses a short balance", async () => {
    await seedWallet(USER_ID, { shards: 50 });
    const bought = await spendPackOpen(db, USER_ID, { kind: "shards", amount: 45 }, T0);
    expect(bought.ok).toBe(true);
    const economy = await economyOf(USER_ID);
    expect(economy.shards).toBe(50 - 45 + PACK_OPEN_SHARD_REWARD);
    expect(economy.shardsSpent).toBe(45);
    expect(economy.openedPacks).toBe(1);

    const refused = await spendPackOpen(db, USER_ID, { kind: "shards", amount: 45 }, T0);
    expect(refused).toMatchObject({ ok: false, reason: "shards" });
  });

  it("bumps the rev on every spend so concurrent spends cannot double-take", async () => {
    await spendPackOpen(db, USER_ID, { kind: "charge" }, T0);
    await spendPackOpen(db, USER_ID, { kind: "charge" }, T0 + 1);
    const wallet = await getPackWallet(db, USER_ID);
    expect(wallet?.rev).toBe(3); // create at 1, then two spends
    expect((await economyOf(USER_ID)).openedPacks).toBe(2);
  });
});

describe("mintDealtPackCards", () => {
  it("mints a dealt hand into the collection and reports first copies as new", async () => {
    const isNew = await mintDealtPackCards(db, USER_ID, [rankedSlot(42), rankedSlot(43)], T0);
    expect(isNew.get("42")).toBe(true);
    expect(isNew.get("43")).toBe(true);

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.total).toBe(2);
    expect(page.cards.find((card) => card.userId === 42)).toMatchObject({
      copies: 1,
      tier: null,
      username: "p42",
      pp: 9000,
      globalRank: 123,
    });
  });

  it("counts a repulled card as a duplicate and refreshes its numbers", async () => {
    await mintDealtPackCards(db, USER_ID, [rankedSlot(42)], T0);
    const isNew = await mintDealtPackCards(db, USER_ID, [rankedSlot(42, { pp: 9500, globalRank: 90 })], T0 + 1000);
    expect(isNew.get("42")).toBe(false);
    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card).toMatchObject({ copies: 2, pp: 9500, globalRank: 90, firstPulledAt: T0, lastPulledAt: T0 + 1000 });
  });

  it("never downgrades a tier the client's mint pass already wrote", async () => {
    await seedCollectionCard(db, USER_ID, 42, { tier: "elite", copies: 1 });
    const isNew = await mintDealtPackCards(db, USER_ID, [rankedSlot(42)], T0);
    expect(isNew.get("42")).toBe(false);
    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card.tier).toBe("elite");
    expect(card.copies).toBe(2);
  });

  it("mints a goat slot under the goat key without touching an existing holding's face", async () => {
    const goatId = [...HONORARY_USER_IDS][0];
    const goatSlot: DealtPackCardSlot = { userId: goatId, tier: "goat", username: "", avatarUrl: "", countryCode: "", pp: 0, globalRank: 0 };

    const first = await mintDealtPackCards(db, USER_ID, [goatSlot], T0);
    expect(first.get(`${goatId}:goat`)).toBe(true);

    // The client mint pass fills the face; a later duplicate must not blank it.
    await applyPackCollectionCardMint(
      db,
      USER_ID,
      packCardKey(goatId, "goat"),
      { tier: "goat", tierLabel: "GOAT", skills: { stream: 60 }, pp: 21000, globalRank: 3 },
      T0 + 1,
    );
    const again = await mintDealtPackCards(db, USER_ID, [goatSlot], T0 + 2000);
    expect(again.get(`${goatId}:goat`)).toBe(false);

    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card).toMatchObject({ tier: "goat", copies: 2, pp: 21000, globalRank: 3 });
    expect(card.skills).toEqual({ stream: 60 });
  });

  it("only fills face numbers on a card that has none", async () => {
    await seedCollectionCard(db, USER_ID, 42, { tier: null, tierLabel: null, pp: 8000, globalRank: 200 });
    await applyPackCollectionCardMint(db, USER_ID, "42", { tier: "rare", tierLabel: "Rare", skills: { stream: 1 }, pp: 1, globalRank: 1 }, T0);
    const card = (await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0];
    expect(card).toMatchObject({ tier: "rare", pp: 8000, globalRank: 200 });
  });
});

describe("mergeImportedPackWallet", () => {
  const HONORARY = [...HONORARY_USER_IDS][0];

  function localCard(userId: number, copies: number, tier: string | null = "rare") {
    return {
      userId,
      username: `p${userId}`,
      avatarUrl: `https://a.ppy.sh/${userId}`,
      countryCode: "CR",
      tier,
      tierLabel: tier,
      skills: null,
      pp: 1000,
      globalRank: 500,
      copies,
      recycledCopies: 0,
      firstPulledAt: 100,
      lastPulledAt: 200,
    };
  }

  function localPayload(cards: Record<string, unknown>, economy: Record<string, unknown> = {}): string {
    return JSON.stringify({
      cards,
      shards: 0,
      shardsSpent: 0,
      charges: 5,
      lastRefillAt: 0,
      openedPacks: 0,
      poolTotal: null,
      ...economy,
    });
  }

  async function seedUsersRow(userId: number): Promise<void> {
    await exec(
      db,
      "insert or ignore into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, '', 'CR', ?)",
      [userId, `p${userId}`, new Date(T0).toISOString()],
    );
  }

  it("folds a never-played account's local history in once, dropping unvouched players", async () => {
    await seedUsersRow(42);
    const payload = localPayload(
      {
        "42": localCard(42, 3),
        [`${HONORARY}:goat`]: localCard(HONORARY, 1, "goat"),
        "99999901": localCard(99999901, 5), // no users row, not honorary
      },
      { shards: 120, openedPacks: 7 },
    );

    const result = await mergeImportedPackWallet(db, USER_ID, payload, T0);
    expect(result.merged).toBe(true);
    expect(result.imported).toMatchObject({ cards: 2, copies: 4, shards: 120, droppedCards: 1 });

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.total).toBe(2);
    expect(page.cards.map((card) => card.userId).sort()).toEqual([42, HONORARY].sort());

    const economy = await economyOf(USER_ID);
    expect(economy.shards).toBe(120);
    expect(economy.openedPacks).toBe(7);

    // The door closes behind the first merge.
    const again = await mergeImportedPackWallet(db, USER_ID, payload, T0 + 1000);
    expect(again.merged).toBe(false);
    expect((await economyOf(USER_ID)).shards).toBe(120);
  });

  it("refuses an account that has played server-side", async () => {
    await spendPackOpen(db, USER_ID, { kind: "charge" }, T0);
    const result = await mergeImportedPackWallet(db, USER_ID, localPayload({}, { shards: 500 }), T0);
    expect(result.merged).toBe(false);
    expect((await economyOf(USER_ID)).shards).toBe(PACK_OPEN_SHARD_REWARD);
  });

  it("refuses an account that already holds collection rows", async () => {
    await seedCollectionCard(db, USER_ID, 42);
    const result = await mergeImportedPackWallet(db, USER_ID, localPayload({}, { shards: 500 }), T0);
    expect(result.merged).toBe(false);
  });

  it("caps claimed shards and per-card copies, and budgets duplicates", async () => {
    const cardIds = Array.from({ length: 12 }, (_, index) => 4200 + index);
    for (const id of cardIds) await seedUsersRow(id);
    const cards = Object.fromEntries(cardIds.map((id) => [String(id), localCard(id, 500)]));

    const result = await mergeImportedPackWallet(db, USER_ID, localPayload(cards, { shards: 999_999 }), T0);
    expect(result.merged).toBe(true);
    // Every distinct card keeps at least one copy; duplicates stop at the budget.
    expect(result.imported?.cards).toBe(12);
    expect(result.imported?.copies).toBe(12 + 1000);
    expect(result.imported?.shards).toBe(2000);

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 50 });
    const totalCopies = page.cards.reduce((sum, card) => sum + card.copies, 0);
    expect(page.total).toBe(12);
    expect(totalCopies).toBe(12 + 1000);
    expect(page.cards.every((card) => card.copies <= 100)).toBe(true);
  });
});
