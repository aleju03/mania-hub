import { describe, expect, it } from "vitest";
import {
  applyCardMint,
  createEmptyWallet,
  duplicateShardTotal,
  MAX_PACK_CHARGES,
  mergeWallets,
  msUntilNextCharge,
  ownedCards,
  PACK_CHARGE_REGEN_MS,
  PACK_OPEN_SHARD_REWARD,
  reconcileWallets,
  recordPull,
  recycleAllCopies,
  recycleAllDuplicates,
  recycleDuplicates,
  sanitizeWallet,
  settleCharges,
  shardValueForTier,
  spendCharge,
  spendShards,
  tierRank,
  type PulledCard,
} from "./pack-collection";

const T0 = 1_700_000_000_000;

function pull(userId: number, tier: PulledCard["tier"] = "common"): PulledCard {
  return {
    userId,
    username: `player${userId}`,
    avatarUrl: `https://a.ppy.sh/${userId}`,
    countryCode: "CR",
    tier,
    tierLabel: tier,
    skills: null,
    pp: 5000,
    globalRank: 1200,
  };
}

describe("charges", () => {
  it("starts full and regenerates one charge per interval after spending", () => {
    let wallet = createEmptyWallet(T0);
    expect(wallet.charges).toBe(MAX_PACK_CHARGES);

    wallet = spendCharge(wallet, T0)!;
    expect(wallet.charges).toBe(MAX_PACK_CHARGES - 1);
    expect(wallet.openedPacks).toBe(1);

    expect(settleCharges(wallet, T0 + PACK_CHARGE_REGEN_MS - 1).charges).toBe(MAX_PACK_CHARGES - 1);
    expect(settleCharges(wallet, T0 + PACK_CHARGE_REGEN_MS).charges).toBe(MAX_PACK_CHARGES);
  });

  it("caps regeneration at the maximum after a long absence", () => {
    let wallet = createEmptyWallet(T0);
    for (let i = 0; i < MAX_PACK_CHARGES; i += 1) wallet = spendCharge(wallet, T0)!;
    expect(wallet.charges).toBe(0);
    expect(spendCharge(wallet, T0)).toBeNull();

    const later = settleCharges(wallet, T0 + 60 * 60 * 1000);
    expect(later.charges).toBe(MAX_PACK_CHARGES);
  });

  it("keeps partial regen progress when settling between intervals", () => {
    let wallet = createEmptyWallet(T0);
    for (let i = 0; i < 3; i += 1) wallet = spendCharge(wallet, T0)!;
    const at = T0 + PACK_CHARGE_REGEN_MS * 1.5;
    const settled = settleCharges(wallet, at);
    expect(settled.charges).toBe(MAX_PACK_CHARGES - 2);
    // Half an interval of progress remains banked.
    expect(msUntilNextCharge(settled, at)).toBe(PACK_CHARGE_REGEN_MS / 2);
  });

  it("returns the same object when nothing changed", () => {
    const wallet = createEmptyWallet(T0);
    expect(settleCharges(wallet, T0 + 5000)).toBe(wallet);
    expect(msUntilNextCharge(wallet, T0)).toBeNull();
  });
});

describe("pulls and recycling", () => {
  it("records a first pull as new and a repull as a duplicate copy", () => {
    let wallet = createEmptyWallet(T0);
    const first = recordPull(wallet, pull(7), T0);
    expect(first.isNew).toBe(true);
    wallet = first.wallet;

    const second = recordPull(wallet, pull(7), T0 + 1000);
    expect(second.isNew).toBe(false);
    expect(second.wallet.cards["7"].copies).toBe(2);
    expect(second.wallet.cards["7"].firstPulledAt).toBe(T0);
    expect(second.wallet.cards["7"].lastPulledAt).toBe(T0 + 1000);
  });

  it("keeps the best tier a player has ever minted at", () => {
    let wallet = recordPull(createEmptyWallet(T0), pull(7, "legendary"), T0).wallet;
    wallet = recordPull(wallet, pull(7, "rare"), T0 + 1000).wallet;
    expect(wallet.cards["7"].tier).toBe("legendary");
    expect(tierRank("legendary")).toBeGreaterThan(tierRank("rare"));
  });

  it("recycles duplicate copies into shards, keeping one copy", () => {
    let wallet = createEmptyWallet(T0);
    for (let i = 0; i < 4; i += 1) wallet = recordPull(wallet, pull(7, "elite"), T0 + i).wallet;
    expect(duplicateShardTotal(wallet)).toBe(3 * shardValueForTier("elite"));

    const result = recycleDuplicates(wallet, 7);
    expect(result.gained).toBe(3 * shardValueForTier("elite"));
    expect(result.wallet.cards["7"].copies).toBe(1);
    expect(result.wallet.shards).toBe(result.gained);
    expect(recycleDuplicates(result.wallet, 7).gained).toBe(0);
  });

  it("recycles every duplicate at once", () => {
    let wallet = createEmptyWallet(T0);
    wallet = recordPull(wallet, pull(1, "common"), T0).wallet;
    wallet = recordPull(wallet, pull(1, "common"), T0).wallet;
    wallet = recordPull(wallet, pull(2, "rare"), T0).wallet;
    wallet = recordPull(wallet, pull(2, "rare"), T0).wallet;
    wallet = recordPull(wallet, pull(2, "rare"), T0).wallet;
    const result = recycleAllDuplicates(wallet);
    expect(result.gained).toBe(shardValueForTier("common") + 2 * shardValueForTier("rare"));
    expect(Object.values(result.wallet.cards).every((card) => card.copies === 1)).toBe(true);
  });

  it("values a tierless card at one shard and spends shards atomically", () => {
    expect(shardValueForTier(null)).toBe(1);
    let wallet = { ...createEmptyWallet(T0), shards: 5 };
    expect(spendShards(wallet, 6)).toBeNull();
    wallet = spendShards(wallet, 5)!;
    expect(wallet.shards).toBe(PACK_OPEN_SHARD_REWARD);
    expect(wallet.shardsSpent).toBe(5);
    expect(wallet.openedPacks).toBe(1);
  });

  it("banks shards on every pack opened, charge or shard bought", () => {
    const charged = spendCharge(createEmptyWallet(T0), T0)!;
    expect(charged.shards).toBe(PACK_OPEN_SHARD_REWARD);
  });

  it("recycles a card entirely, leaving a tombstone that a repull revives as new", () => {
    let wallet = recordPull(createEmptyWallet(T0), pull(7, "rare"), T0).wallet;
    const result = recycleAllCopies(wallet, 7);
    expect(result.gained).toBe(shardValueForTier("rare"));
    expect(result.wallet.cards["7"].copies).toBe(0);
    expect(ownedCards(result.wallet)).toHaveLength(0);
    expect(recycleAllCopies(result.wallet, 7).gained).toBe(0);

    const repull = recordPull(result.wallet, pull(7, "rare"), T0 + 1000);
    expect(repull.isNew).toBe(true);
    expect(repull.wallet.cards["7"].copies).toBe(1);
  });

  it("keeps fully recycled cards gone after reconciling with a stale device", () => {
    const base = recordPull(createEmptyWallet(T0), pull(7), T0).wallet;
    const deviceA = recycleAllCopies(base, 7).wallet;
    const merged = reconcileWallets(deviceA, base, T0 + 5000);
    expect(merged.cards["7"].copies).toBe(0);
    expect(ownedCards(merged)).toHaveLength(0);
  });
});

describe("mint backfills", () => {
  const skills = {
    starAvg: 5,
    fingerControl: 400,
    speed: 420,
    accuracy: 380,
    stamina: 300,
    versatility: 310,
    peak: 350,
    cardPower: 250,
    mainKeyMode: 4,
    archetype: "all-rounder",
    sampleSize: 80,
  };

  it("adopts a mint wholesale on skill-less cards, then only upgrades", () => {
    const wallet = recordPull(createEmptyWallet(T0), pull(7, "legendary"), T0).wallet;
    expect(wallet.cards["7"].skills).toBeNull();

    // Legacy card: fresh mint wins even at a lower tier (it is the only
    // version that can actually be drawn).
    const backfilled = applyCardMint(wallet, 7, { skills, tier: "elite", tierLabel: "Elite" });
    expect(backfilled).not.toBeNull();
    expect(backfilled!.cards["7"].skills).toEqual(skills);
    expect(backfilled!.cards["7"].tier).toBe("elite");

    // With a snapshot in place, equal or lower tiers are refused...
    expect(applyCardMint(backfilled!, 7, { skills, tier: "rare", tierLabel: "Rare" })).toBeNull();
    // ...and higher tiers upgrade.
    const upgraded = applyCardMint(backfilled!, 7, { skills, tier: "mythic", tierLabel: "Mythic" });
    expect(upgraded!.cards["7"].tier).toBe("mythic");
    // Unknown or fully recycled cards are untouched.
    expect(applyCardMint(backfilled!, 999, { skills, tier: "rare", tierLabel: "Rare" })).toBeNull();
  });
});

describe("cross-device reconcile", () => {
  it("is idempotent: reconciling a wallet with a stale copy of itself changes nothing", () => {
    let wallet = createEmptyWallet(T0);
    wallet = recordPull(wallet, pull(7, "rare"), T0).wallet;
    wallet = recordPull(wallet, pull(7, "rare"), T0 + 1).wallet;
    wallet = recycleDuplicates(wallet, 7).wallet;
    wallet = spendShards({ ...wallet, shards: wallet.shards + 10 }, 8)!;

    const reconciled = reconcileWallets(wallet, wallet, T0 + 5000);
    expect(reconciled.cards).toEqual(wallet.cards);
    expect(reconciled.shards).toBe(wallet.shards);
    expect(reconciled.shardsSpent).toBe(wallet.shardsSpent);
  });

  it("takes the max progress per card instead of summing stale copies", () => {
    const base = recordPull(createEmptyWallet(T0), pull(7), T0).wallet;
    // Device A pulled the player once more; device B still has the old state
    // plus a different new card.
    const deviceA = recordPull(base, pull(7), T0 + 100).wallet;
    const deviceB = recordPull(base, pull(8), T0 + 200).wallet;

    const merged = reconcileWallets(deviceA, deviceB, T0 + 5000);
    expect(merged.cards["7"].copies).toBe(2);
    expect(merged.cards["8"].copies).toBe(1);
  });

  it("never resurrects recycled duplicates from a stale device", () => {
    let base = createEmptyWallet(T0);
    for (let i = 0; i < 3; i += 1) base = recordPull(base, pull(7, "elite"), T0 + i).wallet;

    const deviceA = recycleDuplicates(base, 7).wallet;
    const merged = reconcileWallets(deviceA, base, T0 + 5000);
    expect(merged.cards["7"].copies).toBe(1);
    expect(merged.cards["7"].recycledCopies).toBe(2);
    expect(merged.shards).toBe(2 * shardValueForTier("elite"));
  });

  it("never refunds spent shards from a stale device", () => {
    const base = { ...createEmptyWallet(T0), shards: 10 };
    const deviceA = spendShards(base, 8)!;
    const merged = reconcileWallets(deviceA, base, T0 + 5000);
    expect(merged.shards).toBe(2 + PACK_OPEN_SHARD_REWARD);
    expect(merged.shardsSpent).toBe(8);
  });

  it("takes the stingier charge state so charges cannot be duped", () => {
    let deviceA = createEmptyWallet(T0);
    for (let i = 0; i < 3; i += 1) deviceA = spendCharge(deviceA, T0)!;
    const deviceB = createEmptyWallet(T0);

    const merged = reconcileWallets(deviceA, deviceB, T0 + 1000);
    expect(merged.charges).toBe(MAX_PACK_CHARGES - 3);
  });
});

describe("wallet merge and sanitize", () => {
  it("merges an anonymous wallet into the account wallet without losing copies", () => {
    let anon = createEmptyWallet(T0);
    anon = recordPull(anon, pull(7, "rare"), T0).wallet;
    anon = recordPull(anon, pull(8, "common"), T0).wallet;
    anon = { ...anon, shards: 3 };

    let account = createEmptyWallet(T0 + 500);
    account = recordPull(account, pull(7, "legendary"), T0 + 500).wallet;
    account = { ...account, shards: 4, openedPacks: 2 };

    const merged = mergeWallets(account, anon);
    expect(merged.cards["7"].copies).toBe(2);
    expect(merged.cards["7"].tier).toBe("legendary");
    expect(merged.cards["8"].copies).toBe(1);
    expect(merged.shards).toBe(7);
    expect(merged.openedPacks).toBe(2);
  });

  it("sanitizes malformed persisted wallets into a safe shape", () => {
    const wallet = sanitizeWallet(
      {
        cards: {
          a: { userId: 7, username: "p7", copies: "lots", tier: "notATier" },
          b: { username: "missing-id" },
        },
        shards: -5,
        charges: 99,
        lastRefillAt: T0 + 10 ** 12,
        openedPacks: Number.NaN,
      },
      T0,
    );
    expect(wallet).not.toBeNull();
    expect(wallet!.cards["7"].copies).toBe(1);
    expect(wallet!.cards["7"].tier).toBeNull();
    expect(Object.keys(wallet!.cards)).toEqual(["7"]);
    expect(wallet!.shards).toBe(0);
    expect(wallet!.charges).toBe(MAX_PACK_CHARGES);
    expect(wallet!.lastRefillAt).toBe(T0);
    expect(wallet!.openedPacks).toBe(0);
    expect(sanitizeWallet("junk", T0)).toBeNull();
  });
});
