import { describe, expect, it } from "vitest";
import { applyChainAction, chainSharedTraits, makeChainChartCard, makeFixturePool, type ChainCard } from "#/lib/chain-run";
import { dealTutorial } from "./chainTutorialDeal";

/* The fixture pool with dans on its players and a few charts, like the
   server's guest slice. */
function slice() {
  const pool = makeFixturePool(3);
  const cards: ChainCard[] = pool.cards.map((card) => ({ ...card, dan: String(1 + (card.id % 6)) }));
  const charts = [
    makeChainChartCard({ beatmapId: 101, setId: 1, title: "A", version: "[4K] A", stars: 4.5, key: 4, skill: cards.find((card) => card.key === 4)!.skill }),
    makeChainChartCard({ beatmapId: 102, setId: 2, title: "B", version: "[7K] B", stars: 5.1, key: 7, skill: cards.find((card) => card.key === 7)!.skill }),
  ].filter((card): card is ChainCard => card !== null);
  return { cards, goats: [...pool.goats], charts };
}

const traits = (left: ChainCard, right: ChainCard) => chainSharedTraits(left, right).map((entry) => entry.trait);

describe("dealTutorial", () => {
  const dealt = dealTutorial(slice())!;

  it("deals round 1 so the guide's words hold", () => {
    expect(dealt).not.toBeNull();
    const { state, uids } = dealt.deal.round1(dealt.start);
    const card = (uid: number) => state.hand.find((entry) => entry.uid === uid)!.card;
    expect(traits(card(uids.a), card(uids.b))).toContain("cc");
    expect(traits(card(uids.b), card(uids.c))).toEqual(expect.arrayContaining(["skill", "dan"]));
    expect(state.phase).toBe("play");
    expect(state.roundChart).toBeNull();
  });

  it("sets round 1's target past the lesson row alone", () => {
    const { state, uids } = dealt.deal.round1(dealt.start);
    const played = applyChainAction(state, { kind: "playRow", uids: [uids.a, uids.b, uids.c] }, { pool: dealt.deal.pool, seed: 1, now: 0 });
    expect(played.ok && played.state.phase).toBe("play");
  });

  it("brings two map cards in for the two redrawn ones in round 2", () => {
    const { state, uids } = dealt.deal.round2(dealt.deal.round1(dealt.start).state);
    const chart = state.roundChart!;
    expect(chart).not.toBeNull();
    for (const uid of uids.swap) expect(state.hand.find((entry) => entry.uid === uid)!.card.key).not.toBe(chart.key);
    const redrawn = applyChainAction(state, { kind: "redraw", uids: uids.swap }, { pool: dealt.deal.pool, seed: 2, now: 0 });
    expect(redrawn.ok).toBe(true);
    if (!redrawn.ok) return;
    const incoming = redrawn.state.hand.filter((entry) => uids.incoming.includes(entry.uid));
    expect(incoming).toHaveLength(2);
    for (const entry of incoming) expect([entry.card.key, entry.card.skill]).toEqual([chart.key, chart.skill]);
  });
});
