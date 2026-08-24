import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { grantAdminPackCard, type AdminPackUser } from "../src/features/pack-admin.js";
import { shouldDealEternalSelfCard, type EternalSelfDeps } from "../src/features/pack-draw.js";
import {
  applyPackCollectionCardMint,
  countMissingEternalGoatCards,
  getPackCollectionEternalProgress,
  HONORARY_USER_IDS,
  isPackWalletEternalPending,
  mergeImportedPackWallet,
  mintDealtPackCards,
  mintEternalSelfCardOnce,
  normalizePackCardKey,
  packCardKey,
  recyclePackCollectionCards,
  spendPackOpen,
} from "../src/features/pack-wallets.js";
import { recordPackPullEvents } from "../src/features/pack-pulls.js";

/* The one-time 100%-completion reward: the opener's own card at the Eternal
   tier. Everything about it is server-decided (the unique claim, authoritative
   completion count, and the ":eternal" row), so these tests are the cheat-proofing:
   nothing a client reports may create, repeat or repaint one. */

let dir = "";
let db: Db;

const OWNER = 14600698;
const ADMIN_OWNER: AdminPackUser = { userId: OWNER, username: "completionist", countryCode: "CR", tracked: true };
const SELF_IDENTITY = {
  username: "completionist",
  avatarUrl: "https://a.ppy.sh/u/14600698",
  countryCode: "CR",
  pp: 12_345,
  globalRank: 42,
};

async function seedUser(userId: number, username = `player${userId}`): Promise<void> {
  await exec(
    db,
    "insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, 'https://a.ppy.sh/u', 'CR', '2026-01-01')",
    [userId, username],
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-eternal-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("eternal card keys", () => {
  it("derives and normalizes the :eternal form", () => {
    expect(packCardKey(OWNER, "eternal")).toBe(`${OWNER}:eternal`);
    expect(normalizePackCardKey(`${OWNER}:eternal`)).toBe(`${OWNER}:eternal`);
    expect(normalizePackCardKey(` 042:eternal `)).toBe("42:eternal");
    for (const bad of ["42:eternal:v1", "42:ETERNAL", ":eternal", "42:eterna"]) {
      expect(normalizePackCardKey(bad)).toBeNull();
    }
  });
});

describe("shouldDealEternalSelfCard", () => {
  const deps = (over: Partial<EternalSelfDeps>): EternalSelfDeps => ({
    isEternalPending: async () => true,
    countMissingGoats: async () => 0,
    getPoolMembership: async () => ({ userIds: new Set([1, 2, 3]), total: 200 }),
    getPoolProgress: async () => ({ poolTotal: 200, poolOwnedCount: 200 }),
    ...over,
  });

  it("deals once: pending, every GOAT held, and 100% of the pool owned", async () => {
    expect(await shouldDealEternalSelfCard(db, OWNER, deps({}))).toBe(true);
  });

  it("requires the whole GOAT roster, not just the pool", async () => {
    expect(await shouldDealEternalSelfCard(db, OWNER, deps({ countMissingGoats: async () => 1 }))).toBe(false);
  });

  it("never deals again once the durable reward is claimed", async () => {
    expect(await shouldDealEternalSelfCard(db, OWNER, deps({ isEternalPending: async () => false }))).toBe(false);
  });

  it("requires the whole pool, not most of it", async () => {
    expect(
      await shouldDealEternalSelfCard(db, OWNER, deps({ getPoolProgress: async () => ({ poolTotal: 200, poolOwnedCount: 199 }) })),
    ).toBe(false);
  });

  it("refuses a pool below the draw floor or one that cannot be read", async () => {
    expect(
      await shouldDealEternalSelfCard(db, OWNER, deps({ getPoolMembership: async () => ({ userIds: new Set(), total: 3 }) })),
    ).toBe(false);
    expect(
      await shouldDealEternalSelfCard(db, OWNER, deps({
        getPoolMembership: async () => {
          throw new Error("board unavailable");
        },
      })),
    ).toBe(false);
  });
});

describe("durable reward claim", () => {
  it("is not pending for a collector with no wallet", async () => {
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
  });

  it("is pending until dealt, and the claim survives later spends", async () => {
    await spendPackOpen(db, OWNER, { kind: "charge" }, 1_000);
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(true);

    expect((await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 2_000)).dealt).toBe(true);
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);

    // Economy writes spread the parsed payload forward, so the stamp rides
    // through every later purchase.
    const spend = await spendPackOpen(db, OWNER, { kind: "charge" }, 60_000);
    expect(spend.ok).toBe(true);
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
  });

  it("lets exactly one concurrent claim mint exactly one copy", async () => {
    await spendPackOpen(db, OWNER, { kind: "charge" }, 1_000);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 2_000 + index)),
    );
    expect(results.filter((result) => result.dealt)).toHaveLength(1);
    const row = (await exec(
      db,
      "select copies from pack_collection_cards where owner_user_id = ? and card_key = ?",
      [OWNER, `${OWNER}:eternal`],
    )).rows[0];
    expect(Number(row?.copies)).toBe(1);
    expect(Number((await exec(db, "select count(*) as n from pack_eternal_rewards")).rows[0]?.n)).toBe(1);
  });

  it("does not reopen the claim after the Eternal card is recycled", async () => {
    await spendPackOpen(db, OWNER, { kind: "charge" }, 1_000);
    await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 2_000);
    await recyclePackCollectionCards(db, OWNER, { mode: "whole", cardKeys: [`${OWNER}:eternal`] });
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
    expect(await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 3_000)).toEqual({ dealt: false, isNew: false });
  });

  it("backfills the claim registry from a previously dealt Eternal serial", async () => {
    await spendPackOpen(db, OWNER, { kind: "charge" }, 1_000);
    await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 2_000);
    await exec(db, "delete from pack_eternal_rewards where owner_user_id = ?", [OWNER]);
    expect(Number((await exec(db, "select count(*) as n from pack_eternal_rewards")).rows[0]?.n)).toBe(0);
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
    await migrate(db);
    expect(Number((await exec(db, "select count(*) as n from pack_eternal_rewards")).rows[0]?.n)).toBe(1);
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
  });

  it("backfills manually granted Eternal variants from before the reward system", async () => {
    await grantAdminPackCard(db, ADMIN_OWNER, { cardUserId: 42, tier: "eternal", copies: 1 }, 2_000);
    // Future grants retire the completion reward immediately.
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
    // Removing that modern claim recreates the pre-reward database shape; the
    // migration must discover the variant holding and seed it again.
    await exec(db, "delete from pack_eternal_rewards where owner_user_id = ?", [OWNER]);
    const variant = (await exec(
      db,
      "select card_key from pack_collection_cards where owner_user_id = ? and tier = 'eternal'",
      [OWNER],
    )).rows[0];
    expect(String(variant?.card_key)).toMatch(/:v\d+$/);
    expect(Number((await exec(db, "select count(*) as n from pack_eternal_rewards")).rows[0]?.n)).toBe(0);
    // The claimant itself also refuses any existing Eternal tier, even before
    // the migration has had a chance to seed the registry.
    expect(await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 2_500)).toEqual({ dealt: false, isNew: false });
    await migrate(db);
    expect(Number((await exec(db, "select count(*) as n from pack_eternal_rewards")).rows[0]?.n)).toBe(1);
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
    expect(await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 3_000)).toEqual({ dealt: false, isNew: false });
  });
});

describe("dealing and minting the eternal card", () => {
  it("mints the opener's own :eternal row at the eternal tier", async () => {
    await seedUser(OWNER, "completionist");
    const dealt = await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 5_000);
    expect(dealt).toEqual({ dealt: true, isNew: true });

    const row = (await exec(
      db,
      "select tier, copies, card_user_id, pp, global_rank from pack_collection_cards where owner_user_id = ? and card_key = ?",
      [OWNER, `${OWNER}:eternal`],
    )).rows[0];
    expect(row?.tier).toBe("eternal");
    expect(Number(row?.copies)).toBe(1);
    expect(Number(row?.card_user_id)).toBe(OWNER);
    expect(Number(row?.pp)).toBe(SELF_IDENTITY.pp);
    expect(Number(row?.global_rank)).toBe(SELF_IDENTITY.globalRank);

    const face = (await exec(db, "select tier, username from pack_cards where card_key = ?", [`${OWNER}:eternal`])).rows[0];
    expect(face?.tier).toBe("eternal");
    expect(face?.username).toBe("completionist");
  });

  it("a later claim is a no-op rather than a duplicate copy", async () => {
    await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 5_000);
    expect(await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 6_000)).toEqual({ dealt: false, isNew: false });
    const rows = (await exec(
      db,
      "select copies from pack_collection_cards where owner_user_id = ? and card_user_id = ?",
      [OWNER, OWNER],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].copies)).toBe(1);
  });

  it("the label pass fills skills and face numbers but cannot move or demote the card", async () => {
    await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 5_000);
    // The reveal computes a real tier from the opener's plays; the claim is
    // refused (claimedTier) and the awarded tier stays, on its own key.
    const result = await applyPackCollectionCardMint(db, OWNER, `${OWNER}:eternal`, {
      tier: "worldClass",
      tierLabel: "World Class",
      skills: { cardPower: 700 },
      pp: 12_345,
      globalRank: 42,
    }, 6_000);
    expect(result.applied).toBe(true);
    expect(result.cardKey).toBe(`${OWNER}:eternal`);
    const row = (await exec(
      db,
      "select tier, skills_id, pp from pack_collection_cards where owner_user_id = ? and card_key = ?",
      [OWNER, `${OWNER}:eternal`],
    )).rows[0];
    expect(row?.tier).toBe("eternal");
    expect(row?.skills_id).not.toBeNull();
    expect(Number(row?.pp)).toBe(12_345);
    // Nothing folded into the ordinary key.
    const ordinary = (await exec(
      db,
      "select 1 from pack_collection_cards where owner_user_id = ? and card_key = ?",
      [OWNER, String(OWNER)],
    )).rows;
    expect(ordinary).toHaveLength(0);
  });
});

describe("authoritative completion provenance", () => {
  it("does not count localStorage imports until those cards are server-dealt", async () => {
    const poolIds = [41, 42, 43];
    const honorary = [...HONORARY_USER_IDS][0];
    for (const userId of [...poolIds, honorary]) await seedUser(userId);
    const localCard = (userId: number, tier: string | null) => ({
      userId,
      username: `player${userId}`,
      avatarUrl: `https://a.ppy.sh/u/${userId}`,
      countryCode: "CR",
      tier,
      tierLabel: tier,
      skills: null,
      pp: 1_000,
      globalRank: 500,
      copies: 1,
      recycledCopies: 0,
      firstPulledAt: 100,
      lastPulledAt: 200,
    });
    const cards = Object.fromEntries([
      ...poolIds.map((userId) => [String(userId), localCard(userId, "rare")] as const),
      [`${honorary}:goat`, localCard(honorary, "goat")] as const,
    ]);
    const merged = await mergeImportedPackWallet(db, OWNER, JSON.stringify({
      cards,
      shards: 0,
      shardsSpent: 0,
      charges: 5,
      lastRefillAt: 0,
      openedPacks: 0,
      poolTotal: poolIds.length,
    }), 1_000);
    expect(merged.merged).toBe(true);

    const pool = { userIds: new Set(poolIds), total: poolIds.length };
    expect((await getPackCollectionEternalProgress(db, OWNER, pool)).poolOwnedCount).toBe(0);
    expect(await countMissingEternalGoatCards(db, OWNER)).toBe(HONORARY_USER_IDS.size);

    await mintDealtPackCards(db, OWNER, [
      ...poolIds.map((userId) => ({
        userId,
        tier: null,
        username: `player${userId}`,
        avatarUrl: "",
        countryCode: "CR",
        pp: 1_000,
        globalRank: 500,
      })),
      { userId: honorary, tier: "goat", username: "", avatarUrl: "", countryCode: "", pp: 0, globalRank: 0 },
    ], 2_000);
    expect((await getPackCollectionEternalProgress(db, OWNER, pool)).poolOwnedCount).toBe(poolIds.length);
    expect(await countMissingEternalGoatCards(db, OWNER)).toBe(HONORARY_USER_IDS.size - 1);
  });
});

describe("eternal pulls on the community feed", () => {
  it("accepts the tier only for the reporter's own held :eternal card", async () => {
    await seedUser(OWNER, "completionist");
    await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 5_000);
    const result = await recordPackPullEvents(db, OWNER, "completionist", "standard", [
      { userId: OWNER, username: "completionist", countryCode: "CR", tier: "eternal", isNew: true },
    ], 10_000);
    expect(result.recorded).toBe(1);
    const row = (await exec(db, "select tier, notable from pack_pull_events")).rows[0];
    expect(row?.tier).toBe("eternal");
    expect(Number(row?.notable)).toBe(1);
  });

  it("demotes a forged eternal claim to an unrated pull", async () => {
    // No :eternal row exists, so the claim cannot stand - and it must not
    // mint a serial under the :eternal key either.
    await seedUser(OWNER, "completionist");
    const result = await recordPackPullEvents(db, OWNER, "completionist", "standard", [
      { userId: OWNER, username: "completionist", countryCode: "CR", tier: "eternal", isNew: true },
    ], 10_000);
    expect(result.recorded).toBe(1);
    expect((await exec(db, "select tier from pack_pull_events")).rows[0]?.tier).toBeNull();
    const serials = (await exec(db, "select card_key from pack_card_serials")).rows.map((row) => String(row.card_key));
    expect(serials).not.toContain(`${OWNER}:eternal`);
  });

  it("demotes an eternal claim about somebody else's card even when the reporter holds their own", async () => {
    await seedUser(OWNER, "completionist");
    await seedUser(42, "bystander");
    await mintEternalSelfCardOnce(db, OWNER, SELF_IDENTITY, 5_000);
    const result = await recordPackPullEvents(db, OWNER, "completionist", "standard", [
      { userId: 42, username: "bystander", countryCode: "CR", tier: "eternal", isNew: true },
    ], 10_000);
    expect(result.recorded).toBe(1);
    expect((await exec(db, "select tier from pack_pull_events")).rows[0]?.tier).toBeNull();
  });
});
