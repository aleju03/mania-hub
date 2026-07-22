/* Building a thumbnail key rebuilds the card's whole render data, parses two
   CSS colours and a gradient, serializes a long signature and hashes it. The
   album asks for the same cards' keys twice on every render -- once for the
   spread signature, once per slot -- so the answer is cached per card object.
   The collection is copy-on-write, which is what makes that safe. */
import { describe, expect, it } from "vitest";
import type { CollectedCard } from "#/lib/pack-collection";
import {
  COLLECTION_CARD_THUMB_WIDTH,
  cardThumbnailKeyForCollectionCard,
} from "./cardThumbnailCache";

function makeCard(overrides: Partial<CollectedCard> = {}): CollectedCard {
  return {
    userId: 4_242,
    username: "someone",
    avatarUrl: "https://a.ppy.sh/4242",
    countryCode: "CR",
    tier: "rare",
    tierLabel: "Rare",
    skills: {
      starAvg: 5.5,
      fingerControl: 62,
      speed: 71,
      accuracy: 88,
      stamina: 55,
      versatility: 44,
      peak: 6.2,
      cardPower: 70,
      mainKeyMode: 4,
      archetype: "speed",
      sampleSize: 40,
    },
    pp: 4_200,
    globalRank: 1_234,
    copies: 1,
    recycledCopies: 0,
    firstPulledAt: 0,
    lastPulledAt: 0,
    ...overrides,
  };
}

describe("cardThumbnailKeyForCollectionCard", () => {
  it("answers from the cache for a card object it has already seen", () => {
    const card = makeCard();
    const first = cardThumbnailKeyForCollectionCard(card);
    expect(first).toBeTruthy();

    /* Mutating in place is the only way to observe the cache from outside --
       and nothing in the collection does it, which is exactly why caching on
       the object identity is sound. */
    card.avatarUrl = "https://a.ppy.sh/9999";
    expect(cardThumbnailKeyForCollectionCard(card)).toBe(first);

    // The copy-on-write update the wallet really performs gets a fresh key.
    expect(cardThumbnailKeyForCollectionCard({ ...card })).not.toBe(first);
  });

  it("never hands a cached key to a different width", () => {
    const card = makeCard();
    const base = cardThumbnailKeyForCollectionCard(card, COLLECTION_CARD_THUMB_WIDTH);
    const wide = cardThumbnailKeyForCollectionCard(card, 480);
    expect(base).toBeTruthy();
    expect(wide).not.toBe(base);
    expect(cardThumbnailKeyForCollectionCard(card, COLLECTION_CARD_THUMB_WIDTH)).toBe(base);
  });

  it("caches the null answer for a card minted without a skills snapshot", () => {
    const bare = makeCard({ skills: null });
    expect(cardThumbnailKeyForCollectionCard(bare)).toBeNull();
    expect(cardThumbnailKeyForCollectionCard(bare)).toBeNull();
  });

  it("gives two different cards two different keys", () => {
    expect(cardThumbnailKeyForCollectionCard(makeCard())).not.toBe(
      cardThumbnailKeyForCollectionCard(makeCard({ userId: 7 })),
    );
  });
});
