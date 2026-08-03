import { describe, expect, it } from "vitest";
import type { ManiaSkills } from "#/lib/maniacard";
import { duelCardsFromRevealed } from "./duelMint";
import type { RevealedCard } from "./RevealStage";

function skills(cardPower: number): ManiaSkills {
  return {
    archetype: "balanced",
    starAvg: 5,
    fingerControl: 400,
    speed: 400,
    accuracy: 400,
    stamina: 400,
    versatility: 400,
    peak: 400,
    cardPower,
    mainKeyMode: 4,
    sampleSize: 50,
  };
}

function revealed(userId: number, cardPower: number | null): RevealedCard {
  return {
    player: {
      user: {
        id: userId,
        username: `player${userId}`,
        avatar_url: "",
        country_code: "CR",
        statistics: { global_rank: 100, pp: 5000 },
      },
      globalRank: 100,
      pp: 5000,
    },
    tier: "rare",
    tierLabel: "Rare",
    glowColor: null,
    thumbnail: null,
    skills: cardPower === null ? null : skills(cardPower),
    isNew: true,
  };
}

describe("duelCardsFromRevealed", () => {
  it("carries the mint's card power onto the duel card", () => {
    const cards = duelCardsFromRevealed([revealed(1, 640), revealed(2, 880)]);
    expect(cards.map((card) => card.cardPower)).toEqual([640, 880]);
    expect(cards[0]).toMatchObject({ userId: 1, username: "player1", tier: "rare", tierLabel: "Rare" });
  });

  it("drops cards that never minted rather than duelling with a zero", () => {
    const cards = duelCardsFromRevealed([revealed(1, 640), revealed(2, null)]);
    expect(cards).toHaveLength(1);
    expect(cards[0].userId).toBe(1);
  });
});
