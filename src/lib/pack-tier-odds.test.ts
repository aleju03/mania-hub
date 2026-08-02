import { describe, expect, it } from "vitest";
import { CARD_DRAW_TIERS, PACK_TYPES, packTypeById, rollDrawTier, type CardDrawTier } from "./packs";

// The pack's rarity odds are configured weights, not whatever the player pool
// happens to contain. These guard the property the whole change exists for: a
// rarer tier must never be likelier than a commoner one.

function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("pack tier weights", () => {
  it("defines a weight for every tier on every pack", () => {
    for (const type of PACK_TYPES) {
      for (const tier of CARD_DRAW_TIERS) {
        expect(type.tierWeights[tier], `${type.id}.${tier}`).toBeGreaterThan(0);
      }
    }
  });

  it("is non-increasing from common up to World Class on every pack", () => {
    for (const type of PACK_TYPES) {
      let previous = Infinity;
      for (const tier of CARD_DRAW_TIERS) {
        const weight = type.tierWeights[tier];
        expect(weight, `${type.id} ${tier} must not exceed the tier below it`).toBeLessThanOrEqual(previous);
        previous = weight;
      }
    }
  });

  it("sums to 100 so weights read directly as percentages", () => {
    for (const type of PACK_TYPES) {
      const total = CARD_DRAW_TIERS.reduce((sum, tier) => sum + type.tierWeights[tier], 0);
      // Fractional weights are fine; float addition is not exact.
      expect(total, type.id).toBeCloseTo(100, 6);
    }
  });

  it("gives premium packs strictly better odds at the top of the ladder", () => {
    const standard = packTypeById("standard").tierWeights;
    const elite = packTypeById("elite").tierWeights;
    const legend = packTypeById("legend").tierWeights;
    expect(elite.worldClass).toBeGreaterThan(standard.worldClass);
    expect(legend.worldClass).toBeGreaterThan(elite.worldClass);
    expect(legend.mythic).toBeGreaterThan(standard.mythic);
    // ...and correspondingly fewer commons.
    expect(elite.common).toBeLessThan(standard.common);
    expect(legend.common).toBeLessThan(elite.common);
  });
});

describe("rollDrawTier", () => {
  it("reproduces the configured weights over many rolls", () => {
    const weights = packTypeById("standard").tierWeights;
    const rng = lcg(987654321);
    const counts = new Map<CardDrawTier, number>();
    const runs = 200_000;
    for (let run = 0; run < runs; run += 1) {
      const tier = rollDrawTier(weights, rng);
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }
    for (const tier of CARD_DRAW_TIERS) {
      const observed = (counts.get(tier) ?? 0) / runs * 100;
      // Weights are percentages, so observed should land within a point of them.
      expect(Math.abs(observed - weights[tier]), `${tier}: ${observed.toFixed(2)}%`).toBeLessThan(1);
    }
  });

  it("produces a monotonically rarer ladder in practice, not just on paper", () => {
    const rng = lcg(24680);
    const counts = new Map<CardDrawTier, number>();
    for (let run = 0; run < 200_000; run += 1) {
      const tier = rollDrawTier(packTypeById("standard").tierWeights, rng);
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }
    let previous = Infinity;
    for (const tier of CARD_DRAW_TIERS) {
      const n = counts.get(tier) ?? 0;
      expect(n, `${tier} should not out-draw the tier below it`).toBeLessThanOrEqual(previous);
      previous = n;
    }
  });

  it("falls back to common rather than throwing on an empty weight table", () => {
    const empty = Object.fromEntries(CARD_DRAW_TIERS.map((tier) => [tier, 0])) as Record<CardDrawTier, number>;
    expect(rollDrawTier(empty, () => 0.5)).toBe("common");
  });

  it("never returns a tier outside the ladder", () => {
    const rng = lcg(13579);
    for (let run = 0; run < 5_000; run += 1) {
      expect(CARD_DRAW_TIERS).toContain(rollDrawTier(packTypeById("legend").tierWeights, rng));
    }
  });
});
