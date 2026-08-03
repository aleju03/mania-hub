import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { HONORARY_USER_IDS, recyclePackCollectionCards, savePackWallet } from "../src/features/pack-wallets.js";

// Collection cards are client-supplied and their tier is otherwise trusted.
// GOAT recycles for 1000 shards, so a forged `tier: "goat"` would mint shards
// on demand. Only the honorary roster may hold it.

let dir = "";
let db: Db;

const OWNER = 4242;
const HONORARY_ID = 259972; // Jakads
const ORDINARY_ID = 999001;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-goat-guard-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function card(userId: number, tier: string) {
  return {
    userId,
    username: `player${userId}`,
    avatarUrl: "",
    countryCode: "KR",
    tier,
    tierLabel: tier === "goat" ? "GOAT" : tier,
    skills: null,
    pp: 1000,
    globalRank: 1,
    copies: 3,
    recycledCopies: 0,
    firstPulledAt: 1,
    lastPulledAt: 1,
  };
}

async function storedTier(userId: number): Promise<string | null> {
  const row = (await exec(
    db,
    "select tier from pack_collection_cards where owner_user_id = ? and card_user_id = ?",
    [OWNER, userId],
  )).rows[0];
  return row && typeof row.tier === "string" ? row.tier : null;
}

describe("GOAT tier claims", () => {
  it("mirrors the frontend roster exactly", async () => {
    // The list here is a copy, so a player added to the roster but not to it
    // would have their genuine GOAT card stripped on sync.
    const source = await readFile(new URL("../../src/lib/honorary-players.ts", import.meta.url), "utf8");
    const ids = [...source.matchAll(/^\s+id: (\d+),$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(0);
    expect([...HONORARY_USER_IDS].sort()).toEqual(ids.sort());
  });

  it("strips a forged GOAT tier from a player who is not on the roster", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [ORDINARY_ID]: card(ORDINARY_ID, "goat") }, shards: 0 }), 0);
    expect(await storedTier(ORDINARY_ID)).toBeNull();
  });

  it("keeps the GOAT tier for an honorary player", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);
    expect(await storedTier(HONORARY_ID)).toBe("goat");
  });

  it("does not pay out GOAT shards for a forged card", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [ORDINARY_ID]: card(ORDINARY_ID, "goat") }, shards: 0 }), 0);
    const { gained } = await recyclePackCollectionCards(db, OWNER, { mode: "duplicates", cardUserId: ORDINARY_ID });
    // Two duplicates at the unrated rate (1 each), not 2 x 1000.
    expect(gained).toBeLessThanOrEqual(2);
  });

  it("leaves ordinary tiers untouched", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [ORDINARY_ID]: card(ORDINARY_ID, "worldClass") }, shards: 0 }), 0);
    expect(await storedTier(ORDINARY_ID)).toBe("worldClass");
  });
});
