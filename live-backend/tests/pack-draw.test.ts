import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import type { GlobalRankingEntry } from "../src/features/global-rankings.js";
import { drawPackHand, ETERNAL_PULL_CHANCE, PACK_DRAW_TYPES, PackPoolUnavailableError, type PackDrawDeps, type PackDrawSlot } from "../src/features/pack-draw.js";
import { HONORARY_USER_IDS } from "../src/features/pack-wallets.js";

// The deps carry every read the draw performs, so no database is stood up.
const db = null as unknown as Db;

function entry(userId: number, rank: number): GlobalRankingEntry {
  return {
    rank,
    user: {
      id: userId,
      username: `p${userId}`,
      avatar_url: `https://a.ppy.sh/${userId}`,
      cover_url: "",
      country_code: "CR",
    },
    pp: 10_000 - rank,
    global_rank: rank,
    country_rank: rank,
    hit_accuracy: null,
    play_count: null,
    ranked_score: null,
    grade_counts: null,
    global_change: null,
    country_change: null,
  };
}

/* Pool of `size` players at ranks 1..size. Ids offset well clear of the
   honorary roster's real osu! ids. */
function pool(size: number, honoraryAtRank?: { id: number; rank: number }): GlobalRankingEntry[] {
  const entries = Array.from({ length: size }, (_, index) => entry(100_000 + index + 1, index + 1));
  if (honoraryAtRank) entries[honoraryAtRank.rank - 1] = entry(honoraryAtRank.id, honoraryAtRank.rank);
  return entries;
}

/* Returns queued values in order, then the fallback forever. The fallback is
   chosen to miss every honorary roll and keep shuffles deterministic without
   the test caring about their order. */
function rngQueue(values: number[], fallback = 0.7): () => number {
  const queue = [...values];
  return () => (queue.length > 0 ? (queue.shift() as number) : fallback);
}

function makeDeps(entries: GlobalRankingEntry[], overrides: Partial<PackDrawDeps> = {}): PackDrawDeps {
  return {
    getPoolEntries: async () => entries,
    listOwnedCardKeys: async () => [],
    selectReadyUserIds: async (_db, ids) => [...ids],
    listEternalCards: async () => [],
    rollWishlist: async () => ({ userId: 0, counted: false }),
    rng: rngQueue([]),
    ...overrides,
  };
}

function rankedIds(players: PackDrawSlot[]): number[] {
  return players.filter((slot) => !slot.honorary).map((slot) => slot.userId);
}

describe("drawPackHand", () => {
  it("keeps the server's premium prices aligned with the client economy", () => {
    expect(PACK_DRAW_TYPES.get("elite")?.cost).toEqual({ kind: "shards", amount: 115 });
    expect(PACK_DRAW_TYPES.get("legend")?.cost).toEqual({ kind: "shards", amount: 200 });
  });

  it("refuses an unknown pack type", async () => {
    const hand = await drawPackHand(db, { packType: "mystery", ownerUserId: 1 }, makeDeps(pool(200)));
    expect(hand).toBeNull();
  });

  it("refuses a pool thinner than the floor", async () => {
    await expect(
      drawPackHand(db, { packType: "standard", ownerUserId: 1 }, makeDeps(pool(50))),
    ).rejects.toBeInstanceOf(PackPoolUnavailableError);
  });

  it("deals distinct players in reveal order (weakest first)", async () => {
    const hand = await drawPackHand(db, { packType: "standard", ownerUserId: 1 }, makeDeps(pool(200)));
    expect(hand).not.toBeNull();
    expect(hand?.poolTotal).toBe(200);
    expect(hand?.players).toHaveLength(5);
    const ids = rankedIds(hand?.players ?? []);
    expect(new Set(ids).size).toBe(5);
    const ranks = (hand?.players ?? []).map((slot) => (slot.honorary || slot.eternal ? 0 : slot.globalRank ?? 0));
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it("walks over honorary members instead of dealing them from the ranked pool", async () => {
    const jakads = [...HONORARY_USER_IDS][0];
    const entries = pool(200, { id: jakads, rank: 1 });
    // Every position roll lands on rank 1 (the honorary), and the miss value
    // skips the honorary-slot roll, so the walk-forward is all that keeps the
    // roster out of the hand.
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(entries, { rng: rngQueue([0, 0, 0, 0, 0]) }),
    );
    const ids = rankedIds(hand?.players ?? []);
    expect(hand?.poolTotal).toBe(199);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain(jakads);
  });

  it("keeps a sliced draw inside its top slice", async () => {
    // Elite is the top 10% of a 200-player pool, floored at 50: every dealt
    // pool rank must sit inside those 50 even when a roll lands on the edge.
    const hand = await drawPackHand(
      db,
      { packType: "elite", ownerUserId: 1 },
      makeDeps(pool(200), { rng: rngQueue([0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]) }),
    );
    expect(hand?.players).toHaveLength(7);
    for (const slot of hand?.players ?? []) {
      if (slot.honorary || slot.eternal) continue;
      expect(slot.poolRank).toBeLessThanOrEqual(50);
    }
  });

  it("trades owned players for unowned ones from the same slice", async () => {
    const entries = pool(200);
    // The opener owns the whole first half; every roll lands there.
    const ownedKeys = entries.slice(0, 100).map((row) => String(row.user.id));
    const rolls = Array.from({ length: 10 }, (_, index) => index * 0.05);
    const hand = await drawPackHand(
      db,
      { packType: "wild", ownerUserId: 1 },
      makeDeps(entries, {
        listOwnedCardKeys: async () => ownedKeys,
        rng: rngQueue(rolls),
      }),
    );
    const owned = new Set(entries.slice(0, 100).map((row) => row.user.id));
    const ids = rankedIds(hand?.players ?? []);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    for (const id of ids) expect(owned.has(id)).toBe(false);
  });

  it("does not let an Eternal variant block its player's ordinary card", async () => {
    const entries = pool(200);
    const eternalPlayerId = entries[0].user.id;
    const rolls = Array.from({ length: 10 }, (_, index) => index * 0.05);
    const hand = await drawPackHand(
      db,
      { packType: "wild", ownerUserId: 1 },
      makeDeps(entries, {
        listOwnedCardKeys: async () => [`${eternalPlayerId}:eternal`],
        rng: rngQueue(rolls),
      }),
    );

    expect(rankedIds(hand?.players ?? [])).toContain(eternalPlayerId);
  });

  it("treats excludeCardKeys like owned cards", async () => {
    const entries = pool(200);
    const excluded = entries.slice(0, 100).map((row) => String(row.user.id));
    const rolls = Array.from({ length: 10 }, (_, index) => index * 0.05);
    const hand = await drawPackHand(
      db,
      { packType: "wild", ownerUserId: 1, excludeCardKeys: excluded },
      makeDeps(entries, { rng: rngQueue(rolls) }),
    );
    const shunned = new Set(entries.slice(0, 100).map((row) => row.user.id));
    for (const id of rankedIds(hand?.players ?? [])) expect(shunned.has(id)).toBe(false);
  });

  it("replaces not-ready players with ready ones and reports the originals for warming", async () => {
    const entries = pool(200);
    const coldId = entries[0].user.id;
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(entries, {
        rng: rngQueue([0, 0.1, 0.2, 0.3, 0.4]),
        selectReadyUserIds: async (_db, ids) => ids.filter((id) => id !== coldId),
      }),
    );
    const ids = rankedIds(hand?.players ?? []);
    expect(ids).not.toContain(coldId);
    expect(ids).toHaveLength(5);
    expect(hand?.notReadyUserIds).toEqual([coldId]);
  });

  it("deals not-ready players anyway when the slice has no ready replacement, still warming them", async () => {
    const entries = pool(200);
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(entries, { selectReadyUserIds: async () => [] }),
    );
    const ids = rankedIds(hand?.players ?? []);
    expect(ids).toHaveLength(5);
    expect(new Set(hand?.notReadyUserIds)).toEqual(new Set(ids));
  });

  it("fills honorary hits backwards from the climax and cascades until it misses", async () => {
    // rng 0 forever: hit the honorary roll, then win every cascade, so the
    // whole hand turns honorary with no repeats.
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(pool(200), { rng: () => 0 }),
    );
    const players = hand?.players ?? [];
    expect(players).toHaveLength(5);
    expect(players.every((slot) => slot.honorary)).toBe(true);
    const ids = players.map((slot) => slot.userId);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(HONORARY_USER_IDS.has(id)).toBe(true);
  });

  it("never cascades a Legend pack past its single honorary slot", async () => {
    const hand = await drawPackHand(
      db,
      { packType: "legend", ownerUserId: 1 },
      makeDeps(pool(200), { rng: () => 0 }),
    );
    const players = hand?.players ?? [];
    expect(players).toHaveLength(5);
    expect(players.filter((slot) => slot.honorary)).toHaveLength(1);
    expect(players[players.length - 1]?.honorary).toBe(true);
  });

  it("prefers an honorary the opener does not hold as a GOAT", async () => {
    const roster = [...HONORARY_USER_IDS];
    const hand = await drawPackHand(
      db,
      // Owning the roster head's GOAT pushes the pick to the next member;
      // owning only their ordinary card would not (two different cards).
      { packType: "legend", ownerUserId: 1, excludeCardKeys: [`${roster[0]}:goat`] },
      makeDeps(pool(200), { rng: () => 0 }),
    );
    const goat = (hand?.players ?? []).find((slot) => slot.honorary);
    expect(goat?.userId).toBe(roster[1]);
  });
});

describe("the wishlist's pity slot", () => {
  it("takes the hand's weakest slot and marks itself", async () => {
    const entries = pool(200);
    const wishedId = entries[199].user.id;
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(entries, { rollWishlist: async () => ({ userId: wishedId, counted: true }) }),
    );
    const players = hand?.players ?? [];
    expect(players).toHaveLength(5);
    // Reveal order is weakest first, and the wished player is the weakest
    // entry in the pool, so they open the hand.
    expect(players[0]?.userId).toBe(wishedId);
    expect(players[0]?.wished).toBe(true);
    expect(players.filter((slot) => slot.wished)).toHaveLength(1);
    expect(new Set(players.map((slot) => slot.userId)).size).toBe(5);
  });

  it("is asked only about players the pack could actually deal", async () => {
    const entries = pool(200);
    let seen: ReadonlySet<number> | null = null;
    const hand = await drawPackHand(
      db,
      { packType: "legend", ownerUserId: 1 },
      makeDeps(entries, {
        rollWishlist: async (_db, _owner, sliceUserIds) => {
          seen = sliceUserIds;
          return { userId: 0, counted: false };
        },
      }),
    );
    /* Legend draws the top 2%, floored at 50 players, and the five the hand
       already holds are taken out: a wished player the ordinary roll dealt is
       not a pity case, and the settle pass takes them off the list without
       spending the counter. */
    expect(seen).not.toBeNull();
    expect((seen as unknown as Set<number>).size).toBe(45);
    expect((seen as unknown as Set<number>).has(entries[199].user.id)).toBe(false);
    const dealt = new Set(rankedIds(hand?.players ?? []));
    for (const id of dealt) expect((seen as unknown as Set<number>).has(id)).toBe(false);
    // Everything else in the slice is still on the table.
    expect([...(seen as unknown as Set<number>)].every((id) => !dealt.has(id))).toBe(true);
  });

  it("is never taken back by a GOAT cascade", async () => {
    const entries = pool(200);
    const wishedId = entries[150].user.id;
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      // rng 0: the honorary roll hits and every cascade wins, which without
      // the guard would overwrite the wished slot too.
      makeDeps(entries, { rng: () => 0, rollWishlist: async () => ({ userId: wishedId, counted: true }) }),
    );
    const players = hand?.players ?? [];
    expect(players[0]?.userId).toBe(wishedId);
    expect(players[0]?.wished).toBe(true);
    expect(players[0]?.honorary).toBeUndefined();
    expect(players.filter((slot) => slot.honorary)).toHaveLength(4);
  });

  it("keeps a cold wished player instead of swapping them for a warm one", async () => {
    const entries = pool(200);
    const wishedId = entries[199].user.id;
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(entries, {
        rollWishlist: async () => ({ userId: wishedId, counted: true }),
        selectReadyUserIds: async (_db, ids) => ids.filter((id) => id !== wishedId),
      }),
    );
    const ids = rankedIds(hand?.players ?? []);
    expect(ids).toContain(wishedId);
    // Still warmed, so the reveal's cold path joins an in-flight fetch.
    expect(hand?.notReadyUserIds).toContain(wishedId);
  });

  it("deals the ordinary hand when the wishlist read fails", async () => {
    const entries = pool(200);
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(entries, {
        rollWishlist: async () => {
          throw new Error("wishlist unavailable");
        },
      }),
    );
    expect(hand?.players).toHaveLength(5);
    expect((hand?.players ?? []).some((slot) => slot.wished)).toBe(false);
  });
});

describe("the eternal pull slot", () => {
  /* The roll is the last thing drawPackHand asks the rng for, so a queue that
     ends in a miss covers the whole draw and a queue that ends in a hit needs
     the pick right behind it. */
  const eternals = [
    { userId: 501, owned: true },
    { userId: 502, owned: false },
    { userId: 503, owned: false },
  ];

  it("misses on an ordinary open and deals no eternal", async () => {
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(pool(200), { listEternalCards: async () => eternals }),
    );
    expect(hand?.eternalPullUserId).toBe(0);
    expect((hand?.players ?? []).some((slot) => slot.eternal)).toBe(false);
  });

  it("hits inside the published chance and picks a card the opener lacks", async () => {
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      // 0 misses nothing, so the honorary roll fires too; the eternal roll is
      // the last one and takes the queued values.
      makeDeps(pool(200), {
        listEternalCards: async () => eternals,
        rng: rngQueue([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, ETERNAL_PULL_CHANCE / 2, 0.99], 0.9),
      }),
    );
    // 0.99 over the two unowned entries lands on the last one.
    expect(hand?.eternalPullUserId).toBe(503);
  });

  it("falls back to a duplicate when the opener already holds every eternal", async () => {
    const hand = await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(pool(200), {
        listEternalCards: async () => [{ userId: 501, owned: true }],
        rng: rngQueue([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0, 0], 0.9),
      }),
    );
    expect(hand?.eternalPullUserId).toBe(501);
  });

  it("deals nothing when no eternal exists yet, and survives a failed read", async () => {
    const hit = rngQueue([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0, 0], 0.9);
    expect((await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(pool(200), { listEternalCards: async () => [], rng: hit }),
    ))?.eternalPullUserId).toBe(0);
    expect((await drawPackHand(
      db,
      { packType: "standard", ownerUserId: 1 },
      makeDeps(pool(200), {
        listEternalCards: async () => {
          throw new Error("catalog unavailable");
        },
        rng: rngQueue([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0, 0], 0.9),
      }),
    ))?.eternalPullUserId).toBe(0);
  });

  it("is the same chance on every pack type", async () => {
    for (const packType of [...PACK_DRAW_TYPES.keys()]) {
      const hand = await drawPackHand(
        db,
        { packType, ownerUserId: 1 },
        makeDeps(pool(200), {
          listEternalCards: async () => [{ userId: 777, owned: false }],
          // Never enough to miss the eternal roll, and a valid [0, 1) draw so
          // the pick lands on the roster's only entry.
          rng: () => ETERNAL_PULL_CHANCE / 2,
        }),
      );
      expect(hand?.eternalPullUserId).toBe(777);
    }
  });
});
