import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  addPackWishlistPlayer,
  listPackWishlist,
  PackWishlistError,
  PITY_BASE,
  PITY_MAX,
  PITY_STEP,
  removePackWishlistPlayer,
  commitPackWishlistRoll,
  rollPackWishlistPity,
  settlePackWishlistOwned,
  WISHLIST_MAX,
  wishlistChance,
} from "../src/features/pack-wishlist.js";
import { HONORARY_USER_IDS } from "../src/features/pack-wallets.js";

/* The wishlist and its pity counter: five named players, a chance that grows
   only on packs that could have paid out, and a list that retires a row the
   moment its card is held. */

let dir = "";
let db: Db;

const OWNER = 14600698;
const HONORARY = [...HONORARY_USER_IDS][0];
const NOW = 1_760_000_000_000;
// Ids well clear of the honorary roster's real osu! ids.
const POOL_IDS = Array.from({ length: 8 }, (_, index) => 500_100 + index);
const OFF_POOL = 999_111;

async function seedUser(userId: number, pp: number): Promise<void> {
  await exec(
    db,
    `insert or replace into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, updated_at)
     values (?, ?, 'https://a.ppy.sh/u', 'CR', ?, ?, ?, '2026-01-01')`,
    [userId, `player${userId}`, pp, Math.max(1, 10_000 - Math.round(pp)), 1],
  );
}

/* A tracked, ranked roster member is what the pack pool is built from. */
async function seedPoolMember(userId: number, pp: number, rank: number): Promise<void> {
  await seedUser(userId, pp);
  await exec(
    db,
    "insert or replace into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', ?, ?, 'test', 1, '2026-01-01')",
    [userId, rank],
  );
}

async function ownOrdinaryCard(ownerUserId: number, cardUserId: number): Promise<void> {
  await exec(
    db,
    `insert or replace into pack_collection_cards
       (owner_user_id, card_user_id, card_key, tier, pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at)
     values (?, ?, ?, 'rare', 0, 0, 1, 0, ?, ?, ?)`,
    [ownerUserId, cardUserId, String(cardUserId), NOW, NOW, NOW],
  );
}

async function wish(cardUserId: number): Promise<void> {
  await exec(
    db,
    "insert or replace into pack_wishlist (owner_user_id, card_user_id, added_at) values (?, ?, ?)",
    [OWNER, cardUserId, NOW],
  );
}

async function readState(): Promise<{ misses: number; hits: number; lastHitAt: number | null }> {
  const row = (await exec(db, "select misses, hits, last_hit_at from pack_wishlist_state where owner_user_id = ?", [OWNER])).rows[0];
  if (!row) return { misses: 0, hits: 0, lastHitAt: null };
  return {
    misses: Number(row.misses),
    hits: Number(row.hits),
    lastHitAt: row.last_hit_at === null ? null : Number(row.last_hit_at),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-wishlist-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  await seedUser(OWNER, 9000);
  await seedUser(OFF_POOL, 4000);
  await seedUser(HONORARY, 12_000);
  for (let index = 0; index < POOL_IDS.length; index += 1) {
    await seedPoolMember(POOL_IDS[index], 8000 - index * 10, index + 1);
  }
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("wishlistChance", () => {
  it("starts at the base and climbs a step per miss", () => {
    expect(wishlistChance(0)).toBeCloseTo(PITY_BASE, 10);
    expect(wishlistChance(1)).toBeCloseTo(PITY_BASE + PITY_STEP, 10);
    expect(wishlistChance(5)).toBeCloseTo(PITY_BASE + 5 * PITY_STEP, 10);
  });

  it("stops at the ceiling", () => {
    expect(wishlistChance(22)).toBeCloseTo(PITY_MAX, 10);
    expect(wishlistChance(500)).toBeCloseTo(PITY_MAX, 10);
  });
});

describe("the wishlist itself", () => {
  it("adds pool players and reports the next pack's chance", async () => {
    const list = await addPackWishlistPlayer(db, OWNER, POOL_IDS[0], NOW);
    expect(list.players.map((player) => player.userId)).toEqual([POOL_IDS[0]]);
    expect(list.players[0].inPool).toBe(true);
    expect(list.state).toEqual({ misses: 0, hits: 0, chance: PITY_BASE });
  });

  it("refuses a player no ordinary pack can deal", async () => {
    await expect(addPackWishlistPlayer(db, OWNER, OFF_POOL, NOW)).rejects.toMatchObject({ code: "not_pullable" });
    await expect(addPackWishlistPlayer(db, OWNER, HONORARY, NOW)).rejects.toBeInstanceOf(PackWishlistError);
  });

  it("refuses a player already in the collection", async () => {
    await ownOrdinaryCard(OWNER, POOL_IDS[1]);
    await expect(addPackWishlistPlayer(db, OWNER, POOL_IDS[1], NOW)).rejects.toMatchObject({ code: "already_owned" });
  });

  it("caps the list at five", async () => {
    for (let index = 0; index < WISHLIST_MAX; index += 1) {
      await addPackWishlistPlayer(db, OWNER, POOL_IDS[index], NOW + index);
    }
    await expect(addPackWishlistPlayer(db, OWNER, POOL_IDS[WISHLIST_MAX], NOW)).rejects.toMatchObject({
      code: "wishlist_full",
    });
    const list = await removePackWishlistPlayer(db, OWNER, POOL_IDS[0]);
    expect(list.players).toHaveLength(WISHLIST_MAX - 1);
    await expect(addPackWishlistPlayer(db, OWNER, POOL_IDS[WISHLIST_MAX], NOW)).resolves.toMatchObject({
      players: expect.any(Array),
    });
  });

  it("retires a row whose card the collection now holds", async () => {
    await wish(POOL_IDS[0]);
    await wish(POOL_IDS[1]);
    await ownOrdinaryCard(OWNER, POOL_IDS[0]);
    await settlePackWishlistOwned(db, OWNER);
    const list = await listPackWishlist(db, OWNER);
    expect(list.players.map((player) => player.userId)).toEqual([POOL_IDS[1]]);
  });

  it("hides an owned row on read without writing from the read path", async () => {
    await wish(POOL_IDS[2]);
    await ownOrdinaryCard(OWNER, POOL_IDS[2]);
    // The line never claims a card the collector already has...
    expect((await listPackWishlist(db, OWNER)).players).toHaveLength(0);
    // ...but the read does not delete it: listPackWishlist runs on the
    // serving connection, and the draw's settle pass owns that write.
    expect((await exec(db, "select 1 from pack_wishlist where owner_user_id = ?", [OWNER])).rows).toHaveLength(1);
    await settlePackWishlistOwned(db, OWNER);
    expect((await exec(db, "select 1 from pack_wishlist where owner_user_id = ?", [OWNER])).rows).toHaveLength(0);
  });
});

describe("rollPackWishlistPity", () => {
  /* The draw rolls before the pack is paid for and the route commits the roll
     after, so a test that wants the counter moved does both. */
  async function rollAndCommit(
    slice: ReadonlySet<number>,
    rng: () => number,
    now = NOW,
  ): Promise<number> {
    const roll = await rollPackWishlistPity(db, OWNER, slice, rng);
    await commitPackWishlistRoll(db, OWNER, roll, now);
    return roll.userId;
  }

  it("does not count a miss when the pack could not have paid out", async () => {
    await wish(POOL_IDS[0]);
    // The wished player is outside this pack's slice.
    expect(await rollAndCommit(new Set([POOL_IDS[3]]), () => 0)).toBe(0);
    expect(await readState()).toEqual({ misses: 0, hits: 0, lastHitAt: null });
  });

  it("does not count a miss when every wished card is already held", async () => {
    await wish(POOL_IDS[0]);
    await ownOrdinaryCard(OWNER, POOL_IDS[0]);
    expect(await rollAndCommit(new Set([POOL_IDS[0]]), () => 0)).toBe(0);
    expect(await readState()).toEqual({ misses: 0, hits: 0, lastHitAt: null });
  });

  it("writes nothing until the roll is committed, so an unpaid pack costs no pity", async () => {
    await wish(POOL_IDS[0]);
    const slice = new Set([POOL_IDS[0]]);
    // A hit, decided and then thrown away the way a refused wallet throws it.
    const roll = await rollPackWishlistPity(db, OWNER, slice, () => 0.001);
    expect(roll).toEqual({ userId: POOL_IDS[0], counted: true });
    expect(await readState()).toEqual({ misses: 0, hits: 0, lastHitAt: null });
    expect((await listPackWishlist(db, OWNER)).players).toHaveLength(1);
    // And a miss the same way.
    await rollPackWishlistPity(db, OWNER, slice, () => 0.99);
    expect(await readState()).toEqual({ misses: 0, hits: 0, lastHitAt: null });
  });

  it("counts a miss and grows the chance", async () => {
    await wish(POOL_IDS[0]);
    const slice = new Set([POOL_IDS[0], POOL_IDS[1]]);
    expect(await rollAndCommit(slice, () => 0.99)).toBe(0);
    expect(await readState()).toMatchObject({ misses: 1, hits: 0 });
    expect((await listPackWishlist(db, OWNER)).state.chance).toBeCloseTo(PITY_BASE + PITY_STEP, 10);
    expect(await rollAndCommit(slice, () => 0.99)).toBe(0);
    expect((await listPackWishlist(db, OWNER)).state.chance).toBeCloseTo(PITY_BASE + 2 * PITY_STEP, 10);
  });

  it("pays out inside the chance, resets the counter and spends the wish", async () => {
    await wish(POOL_IDS[0]);
    const slice = new Set([POOL_IDS[0]]);
    await rollAndCommit(slice, () => 0.99);
    await rollAndCommit(slice, () => 0.99);
    expect(await readState()).toMatchObject({ misses: 2 });
    expect(await rollAndCommit(slice, () => 0.001)).toBe(POOL_IDS[0]);
    expect(await readState()).toEqual({ misses: 0, hits: 1, lastHitAt: NOW });
    expect((await listPackWishlist(db, OWNER)).players).toHaveLength(0);
  });

  it("never rolls above the raised chance", async () => {
    await wish(POOL_IDS[0]);
    const slice = new Set([POOL_IDS[0]]);
    // One miss in, the chance is 4%: a 0.05 roll must still miss.
    await rollAndCommit(slice, () => 0.99);
    expect(await rollAndCommit(slice, () => 0.05)).toBe(0);
    expect(await readState()).toMatchObject({ misses: 2 });
    expect(await rollAndCommit(slice, () => 0.049)).toBe(POOL_IDS[0]);
  });
});
