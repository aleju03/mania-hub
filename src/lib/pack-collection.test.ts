import { describe, expect, it } from "vitest";
import {
  applyCardMint,
  collectedCardTier,
  createEmptyWallet,
  duplicateShardTotal,
  MAX_PACK_CHARGES,
  mergeWallets,
  msUntilNextCharge,
  ownedCards,
  PACK_CHARGE_REGEN_MS,
  packCardKey,
  parsePackCardKey,
  PACK_OPEN_SHARD_REWARD,
  reconcileWallets,
  recordPull,
  recycleAllCopies,
  recycleAllDuplicates,
  recycleDuplicates,
  sanitizeWallet,
  settleCharges,
  shardValueForTier,
  duplicateShardValueForTier,
  wholeCardShardValue,
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
    expect(duplicateShardTotal(wallet)).toBe(3 * duplicateShardValueForTier("elite"));

    const result = recycleDuplicates(wallet, "7");
    expect(result.gained).toBe(3 * duplicateShardValueForTier("elite"));
    expect(result.wallet.cards["7"].copies).toBe(1);
    expect(result.wallet.shards).toBe(result.gained);
    expect(recycleDuplicates(result.wallet, "7").gained).toBe(0);
  });

  it("recycles every duplicate at once", () => {
    let wallet = createEmptyWallet(T0);
    wallet = recordPull(wallet, pull(1, "common"), T0).wallet;
    wallet = recordPull(wallet, pull(1, "common"), T0).wallet;
    wallet = recordPull(wallet, pull(2, "rare"), T0).wallet;
    wallet = recordPull(wallet, pull(2, "rare"), T0).wallet;
    wallet = recordPull(wallet, pull(2, "rare"), T0).wallet;
    const result = recycleAllDuplicates(wallet);
    expect(result.gained).toBe(duplicateShardValueForTier("common") + 2 * duplicateShardValueForTier("rare"));
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
    const result = recycleAllCopies(wallet, "7");
    expect(result.gained).toBe(shardValueForTier("rare"));
    expect(result.wallet.cards["7"].copies).toBe(0);
    expect(ownedCards(result.wallet)).toHaveLength(0);
    expect(recycleAllCopies(result.wallet, "7").gained).toBe(0);

    const repull = recordPull(result.wallet, pull(7, "rare"), T0 + 1000);
    expect(repull.isNew).toBe(true);
    expect(repull.wallet.cards["7"].copies).toBe(1);
  });

  it("prices a duplicate below the copy you keep", () => {
    // The whole reason the pack economy runs the right way round: a pack is
    // bought with shards, and a finished collection deals nothing but
    // duplicates, so duplicates recycling at full tier value would make
    // opening one an income source rather than a purchase.
    for (const tier of ["rare", "elite", "worldClass", "goat"] as const) {
      expect(duplicateShardValueForTier(tier)).toBeLessThan(shardValueForTier(tier));
    }
    // Nothing recycles for nothing, however cheap the tier.
    expect(duplicateShardValueForTier("common")).toBeGreaterThan(0);
  });

  it("pays the same for a card whichever way it is recycled", () => {
    // Recycling everything has to price the duplicates the same way the
    // duplicates-only button does, or "recycle all" would be a strictly better
    // way to cash duplicates in than the button that exists for it.
    let wallet = createEmptyWallet(T0);
    for (let i = 0; i < 4; i += 1) wallet = recordPull(wallet, pull(7, "elite"), T0 + i).wallet;

    const wholeGo = recycleAllCopies(wallet, "7");
    expect(wholeGo.gained).toBe(shardValueForTier("elite") + 3 * duplicateShardValueForTier("elite"));
    expect(wholeGo.gained).toBe(wholeCardShardValue(wallet.cards["7"]));

    const dupesFirst = recycleDuplicates(wallet, "7");
    const thenTheRest = recycleAllCopies(dupesFirst.wallet, "7");
    expect(dupesFirst.gained + thenTheRest.gained).toBe(wholeGo.gained);
  });

  it("keeps fully recycled cards gone after reconciling with a stale device", () => {
    const base = recordPull(createEmptyWallet(T0), pull(7), T0).wallet;
    const deviceA = recycleAllCopies(base, "7").wallet;
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
    const backfilled = applyCardMint(wallet, "7", { skills, tier: "elite", tierLabel: "Elite" });
    expect(backfilled).not.toBeNull();
    expect(backfilled!.cards["7"].skills).toEqual(skills);
    expect(backfilled!.cards["7"].tier).toBe("elite");

    // With a snapshot in place, equal or lower tiers are refused...
    expect(applyCardMint(backfilled!, "7", { skills, tier: "rare", tierLabel: "Rare" })).toBeNull();
    // ...and higher tiers upgrade.
    const upgraded = applyCardMint(backfilled!, "7", { skills, tier: "mythic", tierLabel: "Mythic" });
    expect(upgraded!.cards["7"].tier).toBe("mythic");
    // Unknown or fully recycled cards are untouched.
    expect(applyCardMint(backfilled!, "999", { skills, tier: "rare", tierLabel: "Rare" })).toBeNull();
  });
});

describe("cross-device reconcile", () => {
  it("is idempotent: reconciling a wallet with a stale copy of itself changes nothing", () => {
    let wallet = createEmptyWallet(T0);
    wallet = recordPull(wallet, pull(7, "rare"), T0).wallet;
    wallet = recordPull(wallet, pull(7, "rare"), T0 + 1).wallet;
    wallet = recycleDuplicates(wallet, "7").wallet;
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

    const deviceA = recycleDuplicates(base, "7").wallet;
    const merged = reconcileWallets(deviceA, base, T0 + 5000);
    expect(merged.cards["7"].copies).toBe(1);
    expect(merged.cards["7"].recycledCopies).toBe(2);
    expect(merged.shards).toBe(2 * duplicateShardValueForTier("elite"));
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

/* Several honorary players are live ranked players too, so their card was
   pullable from the ranked pool before they joined the roster. Those copies
   are World Class cards and must keep reading as World Class everywhere -
   badge, thumbnail, inspect view and the 40-shard recycle value - instead of
   inheriting the GOAT their player carries today. */
describe("collected card tier", () => {
  const BOJII = 10083439; // on the honorary roster, and #4 in the ranked pool

  it("keeps the tier a card was minted at, even for a player who is now honorary", () => {
    expect(collectedCardTier({ tier: "worldClass", skills: null })).toBe("worldClass");
  });

  it("does not promote a stored tier to the player's honorary tier", () => {
    const card = { userId: BOJII, tier: "worldClass" as const, skills: null };
    expect(collectedCardTier(card)).not.toBe("goat");
  });

  it("still reads a genuine GOAT pull as GOAT", () => {
    expect(collectedCardTier({ tier: "goat", skills: null })).toBe("goat");
  });

  it("falls back to card power when the mint left no tier behind", () => {
    expect(collectedCardTier({ tier: null, skills: { cardPower: 720 } as never })).toBe("worldClass");
    expect(collectedCardTier({ tier: null, skills: null })).toBe("common");
  });
});

/* GOAT is awarded by honorary-roster membership rather than card power, and
   several roster members are live ranked players, so one player can be held
   both as the card the ranked pool dealt and as the GOAT the honorary slot
   dealt. Those are two cards: pulling the GOAT must not overwrite (or absorb)
   the ordinary one, and each recycles on its own. */
describe("GOAT cards alongside their player's ordinary card", () => {
  const BOJII = 10083439;

  function goatPull(userId: number): PulledCard {
    return { ...pull(userId, "goat"), tierLabel: "GOAT" };
  }

  it("keys only the GOAT variant apart, leaving every existing key untouched", () => {
    expect(packCardKey(BOJII, "worldClass")).toBe(String(BOJII));
    expect(packCardKey(BOJII, null)).toBe(String(BOJII));
    expect(packCardKey(BOJII, "goat")).toBe(`${BOJII}:goat`);
    expect(parsePackCardKey(`${BOJII}:goat`)).toEqual({ userId: BOJII, goat: true });
    expect(parsePackCardKey(String(BOJII))).toEqual({ userId: BOJII, goat: false });
    expect(parsePackCardKey("nonsense")).toBeNull();
  });

  it("holds both cards at once, counting the GOAT as a new card", () => {
    let wallet = recordPull(createEmptyWallet(T0), pull(BOJII, "worldClass"), T0).wallet;
    const goat = recordPull(wallet, goatPull(BOJII), T0 + 1000);
    wallet = goat.wallet;

    expect(goat.isNew).toBe(true);
    expect(ownedCards(wallet)).toHaveLength(2);
    expect(wallet.cards[String(BOJII)].tier).toBe("worldClass");
    expect(wallet.cards[`${BOJII}:goat`].tier).toBe("goat");
    expect(wallet.cards[String(BOJII)].copies).toBe(1);
    expect(wallet.cards[`${BOJII}:goat`].copies).toBe(1);
  });

  it("recycles each of them separately, at its own tier's rate", () => {
    let wallet = recordPull(createEmptyWallet(T0), pull(BOJII, "worldClass"), T0).wallet;
    wallet = recordPull(wallet, goatPull(BOJII), T0 + 1000).wallet;

    const ordinary = recycleAllCopies(wallet, String(BOJII));
    expect(ordinary.gained).toBe(shardValueForTier("worldClass"));
    // The GOAT is untouched by the ordinary card leaving the collection.
    expect(ownedCards(ordinary.wallet)).toHaveLength(1);
    expect(ownedCards(ordinary.wallet)[0].tier).toBe("goat");

    const goat = recycleAllCopies(ordinary.wallet, `${BOJII}:goat`);
    expect(goat.gained).toBe(shardValueForTier("goat"));
    expect(ownedCards(goat.wallet)).toHaveLength(0);
  });

  it("moves a wallet written before the split onto the new key", () => {
    const legacy = {
      cards: {
        [String(BOJII)]: {
          userId: BOJII,
          username: "bojii",
          avatarUrl: "",
          countryCode: "PH",
          tier: "goat",
          tierLabel: "GOAT",
          skills: null,
          pp: 27107,
          globalRank: 4,
          copies: 1,
          recycledCopies: 0,
          firstPulledAt: T0,
          lastPulledAt: T0,
        },
      },
      shards: 0,
      shardsSpent: 0,
      charges: MAX_PACK_CHARGES,
      lastRefillAt: T0,
      openedPacks: 0,
      poolTotal: null,
    };
    const wallet = sanitizeWallet(legacy, T0)!;
    expect(Object.keys(wallet.cards)).toEqual([`${BOJII}:goat`]);
    expect(wallet.cards[`${BOJII}:goat`].copies).toBe(1);
  });

  it("moves a mint that lands on GOAT onto the GOAT key", () => {
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
    } as never;
    // A legacy card with no tier at all, whose player turns out to be honorary.
    const wallet = recordPull(createEmptyWallet(T0), pull(BOJII, null), T0).wallet;
    const minted = applyCardMint(wallet, String(BOJII), { skills, tier: "goat", tierLabel: "GOAT" })!;
    expect(Object.keys(minted.cards)).toEqual([`${BOJII}:goat`]);
    expect(minted.cards[`${BOJII}:goat`].tier).toBe("goat");
  });
});
