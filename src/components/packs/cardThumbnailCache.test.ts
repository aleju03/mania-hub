/* Building a thumbnail key rebuilds the card's render data, extracts the
   front texture inputs and hashes them. The
   album asks for the same cards' keys twice on every render -- once for the
   spread signature, once per slot -- so the answer is cached per card object.
   The collection is copy-on-write, which is what makes that safe. */
import { describe, expect, it } from "vitest";
import type { CollectedCard } from "#/lib/pack-collection";
import {
  COLLECTION_CARD_THUMB_WIDTH,
  cardThumbnailKeyForData,
  cardThumbnailKeyForCollectionCard,
} from "./cardThumbnailCache";
import { buildManiaCardRenderDataFromSkills } from "../player/maniacard3d/renderData";

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
  it("uses the v2 renderer namespace", () => {
    expect(cardThumbnailKeyForCollectionCard(makeCard())).toMatch(/^v2-w240-u4242-[a-f0-9]{16}$/);
  });

  it("keeps the address a card without background art already has in the pool", () => {
    /* Pinned, not derived: the R2 pool holds ~68k of these, addressed by this
       hash. Any field added to the signature for all cards re-addresses every
       one of them, and the whole pool is re-rendered and re-uploaded to
       produce the same bytes. If this line has to change, that is the price,
       and it should be a deliberate answer rather than a surprise. */
    expect(cardThumbnailKeyForCollectionCard(makeCard())).toBe("v2-w240-u4242-18417ef331be097d");
  });

  it("gives a card its own address once it floats background art", () => {
    // The pool is keyed on the card, not the holder, so two owners of the same
    // player at the same snapshot share an object. Only this keeps the one who
    // was granted art and the one who was not off each other's thumbnail.
    const plain = cardThumbnailKeyForCollectionCard(makeCard());
    const withArt = cardThumbnailKeyForCollectionCard(
      makeCard({ motif: { url: "https://e.com/a.png", scale: 1, opacity: 1 } }),
    );
    const rescaled = cardThumbnailKeyForCollectionCard(
      makeCard({ motif: { url: "https://e.com/a.png", scale: 2, opacity: 1 } }),
    );
    expect(new Set([plain, withArt, rescaled]).size).toBe(3);
  });

  it("answers from the cache for a card object it has already seen", () => {
    const card = makeCard();
    const first = cardThumbnailKeyForCollectionCard(card);
    expect(first).toBeTruthy();

    /* Mutating in place is the only way to observe the cache from outside --
       and nothing in the collection does it, which is exactly why caching on
       the object identity is sound. */
    card.avatarUrl = "https://a.ppy.sh/4242?9999";
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

  it("ignores card data that the front texture does not draw", () => {
    const card = makeCard();
    const changed = makeCard({
      countryCode: "JP",
      pp: 9_999,
      globalRank: 7,
      skills: {
        ...card.skills!,
        stamina: card.skills!.stamina + 10,
        versatility: card.skills!.versatility + 10,
        peak: card.skills!.peak + 1,
        cardPower: card.skills!.cardPower + 1,
        mainKeyMode: 7,
        sampleSize: card.skills!.sampleSize + 50,
      },
    });

    expect(cardThumbnailKeyForCollectionCard(changed)).toBe(cardThumbnailKeyForCollectionCard(card));
  });

  it("changes when a front-texture input changes", () => {
    const card = makeCard();
    expect(cardThumbnailKeyForCollectionCard(makeCard({ username: "renamed" }))).not.toBe(
      cardThumbnailKeyForCollectionCard(card),
    );
    expect(cardThumbnailKeyForCollectionCard(makeCard({ avatarUrl: "https://a.ppy.sh/4242?new" }))).not.toBe(
      cardThumbnailKeyForCollectionCard(card),
    );
    expect(cardThumbnailKeyForCollectionCard(makeCard({
      skills: { ...card.skills!, fingerControl: card.skills!.fingerControl + 1 },
    }))).not.toBe(cardThumbnailKeyForCollectionCard(card));
  });

  it("does not invalidate a thumbnail when only next-tier UI changes", () => {
    const card = makeCard();
    const data = buildManiaCardRenderDataFromSkills({
      user: {
        id: card.userId,
        username: card.username,
        avatar_url: card.avatarUrl,
        country_code: card.countryCode,
        statistics: { global_rank: card.globalRank, pp: card.pp },
      },
      skills: card.skills!,
      tierOverride: "rare",
    });

    expect(cardThumbnailKeyForData({ ...data, nextTier: null })).toBe(
      cardThumbnailKeyForData({
        ...data,
        nextTier: {
          tier: "elite",
          label: "Elite",
          currentTier: "rare",
          currentLabel: "Rare",
          threshold: 80,
          remaining: 10,
          progress: 0.5,
        },
      }),
    );
  });
});
