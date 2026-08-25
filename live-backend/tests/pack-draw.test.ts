import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import type { GlobalRankingEntry } from "../src/features/global-rankings.js";
import { drawPackHand, PACK_DRAW_TYPES, PackPoolUnavailableError, type PackDrawDeps, type PackDrawSlot } from "../src/features/pack-draw.js";
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
