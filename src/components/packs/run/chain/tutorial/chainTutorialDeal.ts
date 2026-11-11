import {
  applyChainAction,
  buildChainPool,
  chainSharedTraits,
  scoreChainRowFor,
  CHAIN_RULES,
  type ChainCard,
  type ChainCardInstance,
  type ChainPool,
  type ChainRunState,
} from "#/lib/chain-run";

/* The tutorial's two rounds, dealt from real cards (the guest pool) chosen
   so each lesson is true of the cards on the table:

   Round 1: A and B share a country; B and C share a skillset and a dan.
   The player lays A, B, C as told and plays it, then builds a row of their
   own to reach the target.
   Round 2 is set on a map. Two hand cards miss its keymode; redrawing them
   brings two that fit it (and so share a skillset with each other). */

export interface TutorialRound1 {
  a: number;
  b: number;
  c: number;
}

export interface TutorialRound2 {
  /* The two hand cards to redraw, and the two that come in for them. */
  swap: [number, number];
  incoming: [number, number];
}

export interface TutorialDeal {
  pool: ChainPool;
  round1: (state: ChainRunState) => { state: ChainRunState; uids: TutorialRound1 };
  round2: (state: ChainRunState) => { state: ChainRunState; uids: TutorialRound2 };
}

const SEED = 7_270_727;
/* How much of the best greedy row a round's target asks for on top of the
   row the guide lays out (a first try fell 2% short of half). */
const TARGET_SHARE = 0.3;

const byId = (left: ChainCard, right: ChainCard) => left.id - right.id;
const shares = (left: ChainCard, right: ChainCard, trait: string) => chainSharedTraits(left, right).some((entry) => entry.trait === trait);

/* Cards worth a decent number, so the lesson's rows score like a real run's. */
function playable(cards: readonly ChainCard[]): ChainCard[] {
  return cards.filter((card) => !card.goat && !card.chart && !card.variant && card.base >= 8 && card.base <= 60).sort(byId);
}

function pick(cards: readonly ChainCard[], used: Set<number>, test: (card: ChainCard) => boolean): ChainCard | null {
  for (const card of cards) {
    if (used.has(card.id) || !test(card)) continue;
    used.add(card.id);
    return card;
  }
  return null;
}

/* Fresh instances for the state, numbered on from its counter. */
function instances(state: ChainRunState, cards: readonly ChainCard[], pack: boolean): ChainCardInstance[] {
  return cards.map((card) => {
    const uid = state.nextUid;
    state.nextUid += 1;
    return { uid, card, pack };
  });
}

/* The best row a greedy player lays from a hand: start anywhere, then add
   the card sharing the most with the last one. */
function greedyRow(state: ChainRunState, uids: readonly number[]): number {
  let best = 0;
  const cards = state.hand.filter((entry) => uids.includes(entry.uid));
  for (const first of cards) {
    const row = [first];
    while (row.length < CHAIN_RULES.rowMax) {
      const last = row[row.length - 1]!.card;
      let next: ChainCardInstance | null = null;
      let most = 0;
      for (const entry of cards) {
        if (row.includes(entry)) continue;
        const count = chainSharedTraits(last, entry.card).length;
        if (count > most) {
          most = count;
          next = entry;
        }
      }
      if (!next) break;
      row.push(next);
    }
    const score = scoreChainRowFor(state, row.map((entry) => entry.uid))?.total ?? 0;
    best = Math.max(best, score);
  }
  return best;
}

const roundTo10 = (value: number) => Math.max(10, Math.round(value / 10) * 10);

/* A run started on the pool, through its starting packs, in round 1. */
function freshRun(pool: ChainPool): ChainRunState | null {
  let out = applyChainAction(null, { kind: "start" }, { pool, seed: SEED, now: Date.now() });
  for (let step = 0; out.ok && out.state.phase === "pack" && step < 12; step += 1) {
    const pack = out.state.pack!;
    const action = pack.sealed
      ? ({ kind: "openPack" } as const)
      : ({ kind: "keep", ids: pack.cards.filter((card) => !card.eternal).slice(0, pack.keep).map((card) => card.id) } as const);
    out = applyChainAction(out.state, action, { pool, seed: SEED + step, now: Date.now() });
  }
  return out.ok && out.state.phase === "play" ? out.state : null;
}

export function dealTutorial(slice: { cards: ChainCard[]; goats: ChainCard[]; charts: ChainCard[] }): { deal: TutorialDeal; start: ChainRunState } | null {
  const cards = playable(slice.cards);
  const used = new Set<number>();

  /* Round 1's lesson: B and C share a skillset and a dan, not a country;
     A shares B's country, not its skillset or dan. */
  let a: ChainCard | null = null;
  let b: ChainCard | null = null;
  let c: ChainCard | null = null;
  for (const left of cards) {
    const right = cards.find((card) => card.id !== left.id && card.key === left.key && card.skill === left.skill && card.dan && card.dan === left.dan && card.cc !== left.cc);
    if (!right) continue;
    const first = cards.find((card) => card.id !== left.id && card.id !== right.id && card.cc === left.cc && card.skill !== left.skill && card.dan !== left.dan && !shares(card, right, "cc"));
    if (!first) continue;
    [a, b, c] = [first, left, right];
    break;
  }
  if (!a || !b || !c) return null;
  for (const card of [a, b, c]) used.add(card.id);

  /* Round 2's map: one with plenty of cards to fit it. */
  const charts = [...slice.charts].filter((card) => card.chart).sort(byId);
  const chart = charts.find((card) => cards.filter((other) => !used.has(other.id) && other.key === card.key && other.skill === card.skill).length >= 6);
  if (!chart) return null;
  const fits = (card: ChainCard) => card.key === chart.key && card.skill === chart.skill;
  const otherKey = (card: ChainCard) => card.key !== chart.key;

  /* The rest of round 1's hand: pairs that share a country, so a row of
     the player's own has links to find. */
  const fill1: ChainCard[] = [];
  while (fill1.length < 6) {
    const first = pick(cards, used, (card) => !fits(card));
    if (!first) return null;
    fill1.push(first);
    const second = pick(cards, used, (card) => !fits(card) && card.cc === first.cc);
    if (second) fill1.push(second);
  }
  const hand1 = [a, b, c, ...fill1.slice(0, 6)];

  /* Round 2's hand: one card fitting the map, two missing its keymode (the
     redraw), the rest sharing countries. The deck holds the two that fit. */
  const fitHeld = pick(cards, used, fits);
  const swapA = pick(cards, used, otherKey);
  const swapB = pick(cards, used, (card) => otherKey(card) && card.cc !== swapA?.cc && card.skill !== swapA?.skill && card.dan !== swapA?.dan);
  const inA = pick(cards, used, fits);
  const inB = pick(cards, used, fits);
  if (!fitHeld || !swapA || !swapB || !inA || !inB) return null;
  const fill2: ChainCard[] = [];
  while (fill2.length < 6) {
    const first = pick(cards, used, (card) => !fits(card));
    if (!first) return null;
    fill2.push(first);
    const second = pick(cards, used, (card) => !fits(card) && card.cc === first.cc);
    if (second) fill2.push(second);
  }
  const hand2 = [fill2[0]!, swapA, fill2[1]!, fitHeld, fill2[2]!, swapB, ...fill2.slice(3, 6)];
  /* Draws: what refills the hand after a row, and the two that fit last. */
  const draws = [...cards.filter((card) => !used.has(card.id)).slice(0, 10)];
  for (const card of draws) used.add(card.id);

  const pool = buildChainPool([...cards], slice.goats, slice.charts);
  const start = freshRun(pool);
  if (!start) return null;

  const round1 = (input: ChainRunState) => {
    const state = structuredClone(input);
    state.deck = instances(state, [...draws, inA, inB], false);
    state.hand = instances(state, hand1, true);
    state.roundPack = state.hand.map((entry) => entry.card);
    // Drawn from the end: round 1 never reaches the two map cards.
    state.drawPile = state.deck.filter((entry) => entry.card.id !== inA.id && entry.card.id !== inB.id).map((entry) => entry.uid);
    state.played = [];
    state.roundChart = null;
    state.rowsLeft = CHAIN_RULES.rows;
    state.redrawsLeft = CHAIN_RULES.redraws;
    state.roundScore = 0;
    const uid = (card: ChainCard) => state.hand.find((entry) => entry.card.id === card.id)!.uid;
    const uids = { a: uid(a!), b: uid(b!), c: uid(c!) };
    const lesson = scoreChainRowFor(state, [uids.a, uids.b, uids.c])?.total ?? 0;
    const rest = state.hand.filter((entry) => ![uids.a, uids.b, uids.c].includes(entry.uid)).map((entry) => entry.uid);
    // The lesson row alone falls short; a third of a good row of their own
    // clears it, so two plain rows of a first try are plenty.
    state.target = roundTo10(lesson + greedyRow(state, rest) * TARGET_SHARE);
    return { state, uids };
  };

  const round2 = (input: ChainRunState) => {
    const state = structuredClone(input);
    state.hand = instances(state, hand2, true);
    state.roundPack = state.hand.map((entry) => entry.card);
    const incoming = [inA, inB].map((card) => state.deck.find((entry) => entry.card.id === card.id)!.uid) as [number, number];
    state.drawPile = [...state.deck.map((entry) => entry.uid).filter((uid) => !incoming.includes(uid)), incoming[1], incoming[0]];
    state.played = [];
    state.roundChart = { ...chart };
    state.lastChartId = chart.id;
    state.rowsLeft = CHAIN_RULES.rows;
    state.redrawsLeft = CHAIN_RULES.redraws;
    state.roundScore = 0;
    const swap = [swapA, swapB].map((card) => state.hand.find((entry) => entry.card.id === card.id)!.uid) as [number, number];
    // The map row the redraw makes: the held fit and the two coming in.
    const after = structuredClone(state);
    after.hand = [...after.hand.filter((entry) => !swap.includes(entry.uid)), ...after.deck.filter((entry) => incoming.includes(entry.uid))];
    const held = after.hand.find((entry) => entry.card.id === fitHeld.id)!.uid;
    const mapRow = scoreChainRowFor(after, [held, ...incoming])?.total ?? 0;
    const rest = after.hand.filter((entry) => ![held, ...incoming].includes(entry.uid)).map((entry) => entry.uid);
    state.target = roundTo10(mapRow + greedyRow(after, rest) * TARGET_SHARE);
    return { state, uids: { swap, incoming } };
  };

  return { deal: { pool, round1, round2 }, start };
}
