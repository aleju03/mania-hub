import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { seedCollectionCard } from "./helpers/pack-cards.js";
import {
  backfillPackCardSerials,
  getPackCardSerials,
  getSharedPackCard,
  recordPackPullEvents,
} from "../src/features/pack-pulls.js";

let dir = "";
let db: Db;

const OWNER = 100;
const OTHER_OWNER = 200;
const THIRD_OWNER = 300;
/* An honorary id, so the same player can be pulled both ordinarily and as a
   GOAT (the log only accepts that tier for the honorary roster). */
const CARD = 259972;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-serials-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  // The pull log publishes pulls for players it can vouch for; a dealt card
  // always has a users row behind it.
  await exec(
    db,
    "insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, '', 'CR', '2026-01-01')",
    [CARD, `player${CARD}`],
  );
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function card(userId: number, tier: string | null) {
  return { userId, username: `player${userId}`, countryCode: "CR", tier, isNew: true };
}

async function pull(ownerUserId: number, tier: string | null, now = Date.now()) {
  return recordPackPullEvents(db, ownerUserId, `owner${ownerUserId}`, "standard", [card(CARD, tier)], now);
}

describe("pack card serials", () => {
  it("hands out mint order in the order cards are first pulled", async () => {
    const first = await pull(OWNER, "rare");
    const second = await pull(OTHER_OWNER, "rare");
    const third = await pull(THIRD_OWNER, "rare");

    expect(first.mints[0]).toMatchObject({ userId: CARD, cardKey: String(CARD), serial: 1, mintedTotal: 1 });
    expect(second.mints[0]).toMatchObject({ serial: 2, mintedTotal: 2 });
    expect(third.mints[0]).toMatchObject({ serial: 3, mintedTotal: 3 });
  });

  it("keeps an owner's serial across duplicate pulls", async () => {
    await pull(OWNER, "rare");
    await pull(OTHER_OWNER, "rare");
    const duplicate = await pull(OWNER, "rare");

    expect(duplicate.mints[0].serial).toBe(1);
    // The duplicate handed out no new serial, so the denominator holds.
    expect(duplicate.mints[0].mintedTotal).toBe(2);
  });

  it("serials a GOAT separately from the same player's ordinary card", async () => {
    const ordinary = await pull(OWNER, "worldClass");
    const goat = await pull(OWNER, "goat");

    expect(ordinary.mints[0]).toMatchObject({ cardKey: String(CARD), serial: 1 });
    expect(goat.mints[0]).toMatchObject({ cardKey: `${CARD}:goat`, serial: 1 });

    const serials = await getPackCardSerials(db, OWNER, [String(CARD), `${CARD}:goat`]);
    expect(serials.get(String(CARD))?.serial).toBe(1);
    expect(serials.get(`${CARD}:goat`)?.serial).toBe(1);
  });

  it("survives the card being recycled and pulled again", async () => {
    await pull(OWNER, "rare");
    await pull(OTHER_OWNER, "rare");
    // Recycling clears the collection row; the mint registry is not touched.
    const repull = await pull(OWNER, "rare");
    expect(repull.mints[0].serial).toBe(1);
  });

  it("reports the owner's serial on the share payload", async () => {
    await pull(OTHER_OWNER, "rare");
    await pull(OWNER, "rare");
    await seedCollectionCard(db, OWNER, CARD, {
      tier: "rare",
      tierLabel: "Rare",
      username: "player7",
      firstPulledAt: 1,
      lastPulledAt: 1,
      updatedAt: 1,
    });

    const shared = await getSharedPackCard(db, OWNER, CARD);
    expect(shared?.serial).toBe(2);
    expect(shared?.mintedTotal).toBe(2);
  });

  it("leaves unlogged cards without a serial", async () => {
    await seedCollectionCard(db, OWNER, CARD, {
      tier: "rare",
      tierLabel: "Rare",
      username: "player7",
      firstPulledAt: 1,
      lastPulledAt: 1,
      updatedAt: 1,
    });

    const shared = await getSharedPackCard(db, OWNER, CARD);
    expect(shared?.serial).toBeNull();
    expect(shared?.mintedTotal).toBe(0);
  });

});

describe("backfillPackCardSerials", () => {
  async function seedOwnedCard(
    ownerUserId: number,
    cardUserId: number,
    firstPulledAt: number,
    tier: string | null = "rare",
  ) {
    await seedCollectionCard(db, ownerUserId, cardUserId, {
      tier,
      firstPulledAt,
      lastPulledAt: firstPulledAt,
      updatedAt: firstPulledAt,
    });
  }

  it("numbers existing collections in the order they were first pulled", async () => {
    await seedOwnedCard(THIRD_OWNER, CARD, 3000);
    await seedOwnedCard(OWNER, CARD, 1000);
    await seedOwnedCard(OTHER_OWNER, CARD, 2000);

    expect(await backfillPackCardSerials(db)).toBe(3);
    const serials = await getPackCardSerials(db, OWNER, [String(CARD)]);
    expect(serials.get(String(CARD))).toEqual({ serial: 1, mintedTotal: 3 });
    expect((await getPackCardSerials(db, OTHER_OWNER, [String(CARD)])).get(String(CARD))?.serial).toBe(2);
    expect((await getPackCardSerials(db, THIRD_OWNER, [String(CARD)])).get(String(CARD))?.serial).toBe(3);
  });

  it("keeps a GOAT card on its own numbering", async () => {
    await seedOwnedCard(OWNER, CARD, 1000, "worldClass");
    await seedOwnedCard(OWNER, CARD, 2000, "goat");
    await seedOwnedCard(OTHER_OWNER, CARD, 3000, "goat");

    await backfillPackCardSerials(db);
    const mine = await getPackCardSerials(db, OWNER, [String(CARD), `${CARD}:goat`]);
    expect(mine.get(String(CARD))?.serial).toBe(1);
    expect(mine.get(`${CARD}:goat`)?.serial).toBe(1);
    expect((await getPackCardSerials(db, OTHER_OWNER, [`${CARD}:goat`])).get(`${CARD}:goat`)?.serial).toBe(2);
  });

  it("writes nothing on a second run and never hands out a serial twice", async () => {
    await seedOwnedCard(OWNER, CARD, 1000);
    await seedOwnedCard(OTHER_OWNER, CARD, 2000);
    await backfillPackCardSerials(db);
    expect(await backfillPackCardSerials(db)).toBe(0);

    // A pull after the backfill continues the sequence, and the next boot's
    // rerun leaves every existing number alone.
    const fresh = await recordPackPullEvents(db, THIRD_OWNER, "third", "standard", [card(CARD, "rare")], 4000);
    expect(fresh.mints[0].serial).toBe(3);
    await seedOwnedCard(THIRD_OWNER, CARD, 4000);
    expect(await backfillPackCardSerials(db)).toBe(0);

    const rows = (await exec(db, "select serial from pack_card_serials where card_key = ?", [String(CARD)])).rows;
    const serials = rows.map((row) => Number(row.serial)).sort((a, b) => a - b);
    expect(serials).toEqual([1, 2, 3]);
  });

  it("skips cards the owner has fully recycled", async () => {
    await seedOwnedCard(OWNER, CARD, 1000);
    await exec(db, "update pack_collection_cards set copies = 0 where owner_user_id = ?", [OWNER]);
    expect(await backfillPackCardSerials(db)).toBe(0);
  });
});
