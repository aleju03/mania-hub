/* Server-side pack deals.

   The draw used to run in the browser: the client paged the pool over HTTP,
   rolled Math.random, and told the server what it pulled. That made the pool
   and the odds advisory - the request sequence for an open never contained
   "open a pack", only "here are the ids I picked". Signed-in opens now come
   through POST /api/packs/draw and this module rolls the dice, so the slice,
   the uniform odds, the duplicate protection and the honorary chance are
   enforced where the pool lives. Anonymous wallets keep the client-side draw:
   they are browser-local, never synced and never logged, so there is nothing
   for the server to protect.

   The economy rides the same request: the route spends the pack's cost
   through spendPackOpen (pack-wallets.ts) before anything is minted, and the
   dealt hand is written into the collection right there, so the wallet's
   numbers and the copies in a collection are no longer the client's word. */
import type { Db } from "../db.js";
import { getPackPoolEntries, type GlobalRankingEntry, type PackPoolKeymode } from "./global-rankings.js";
import { HONORARY_USER_IDS, listPackCollectionOwnedCardKeys, normalizePackCardKey, type PackOpenCost } from "./pack-wallets.js";
import { selectReadyPackCardUserIds } from "./player-profiles.js";

/* Draw parameters and price per pack type, mirrored from PACK_TYPES in
   src/lib/packs.ts. Keep the two in step: a pack type missing here cannot be
   opened by a signed-in user at all, and the cost here is the one that is
   actually charged - the client's copy only decides what the shelf greys
   out. */
export interface PackDrawTypeDef {
  id: string;
  cost: PackOpenCost;
  topFraction: number;
  keys?: PackPoolKeymode;
  cardCount: number;
  guaranteesNew: boolean;
  honoraryChance: number;
  honoraryCascadeChance: number;
}

const HONORARY_CASCADE_CHANCE = 0.1;

export const PACK_DRAW_TYPES: ReadonlyMap<string, PackDrawTypeDef> = new Map(
  (
    [
      { id: "standard", cost: { kind: "charge" }, topFraction: 1, cardCount: 5, guaranteesNew: false, honoraryChance: 0.0025, honoraryCascadeChance: HONORARY_CASCADE_CHANCE },
      { id: "wild", cost: { kind: "shards", amount: 45 }, topFraction: 1, cardCount: 10, guaranteesNew: true, honoraryChance: 0.0075, honoraryCascadeChance: HONORARY_CASCADE_CHANCE },
      { id: "4k", cost: { kind: "shards", amount: 40 }, topFraction: 1, keys: 4, cardCount: 5, guaranteesNew: true, honoraryChance: 0.005, honoraryCascadeChance: HONORARY_CASCADE_CHANCE },
      { id: "7k", cost: { kind: "shards", amount: 60 }, topFraction: 1, keys: 7, cardCount: 5, guaranteesNew: true, honoraryChance: 0.005, honoraryCascadeChance: HONORARY_CASCADE_CHANCE },
      { id: "elite", cost: { kind: "shards", amount: 115 }, topFraction: 0.1, cardCount: 7, guaranteesNew: true, honoraryChance: 0.01, honoraryCascadeChance: HONORARY_CASCADE_CHANCE },
      { id: "legend", cost: { kind: "shards", amount: 250 }, topFraction: 0.02, cardCount: 5, guaranteesNew: true, honoraryChance: 0.03, honoraryCascadeChance: 0 },
    ] satisfies PackDrawTypeDef[]
  ).map((type) => [type.id, type]),
);

/* Mirrors the frontend's pool math (poolSliceSize / the 100-player floor in
   drawPackPlayersFromPool), so a pool the client would have refused to draw
   from is refused here too. */
export const PACK_POOL_MIN_TOTAL = 100;
const POOL_SLICE_MIN_PLAYERS = 50;

function poolSliceSize(total: number, topFraction: number): number {
  if (topFraction >= 1) return total;
  return Math.max(Math.min(total, POOL_SLICE_MIN_PLAYERS), Math.round(total * topFraction));
}

/* The honorary ids a deal may place in the honorary slot. Today that is the
   whole mirrored roster; if the frontend roster ever gains a member with
   cardReady: false (no renderable card yet), exclude them here as well - the
   client drops slots its roster cannot render, so dealing one only shrinks
   the hand. */
const HONORARY_DRAW_POOL: readonly number[] = [...HONORARY_USER_IDS];

/* Thrown when the pool cannot serve a draw at all (board unavailable or
   thinner than the floor); the route answers 503 and the client shows its
   "couldn't deal" retry. */
export class PackPoolUnavailableError extends Error {
  constructor() {
    super("Pack pool unavailable.");
    this.name = "PackPoolUnavailableError";
  }
}

export type PackDrawSlot =
  | { honorary: true; userId: number }
  | {
      honorary?: false;
      userId: number;
      username: string;
      avatarUrl: string;
      countryCode: string;
      globalRank: number | null;
      poolRank: number;
      pp: number;
    };

export interface PackDrawHand {
  poolTotal: number;
  /* Reveal order: weakest first, honorary hits at the tail (the climax). */
  players: PackDrawSlot[];
  /* Dealt ids with no stored score window (only when the slice had no ready
     replacement left); the route warms them so the client's cold path is a
     coalesced wait, not a fresh mint. */
  notReadyUserIds: number[];
}

export interface PackDrawOptions {
  packType: string;
  /* Whose collection backs duplicate protection; 0 skips it (a pack type
     without guaranteesNew never reads the collection either way). */
  ownerUserId: number;
  /* Cards pulled moments ago that the debounced wallet push may not have
     landed yet, so back-to-back opens stay duplicate-protected. A hint, and
     deliberately capped small at the route: a handful of exclusions cannot
     steer a draw over a pool this size. */
  excludeCardKeys?: readonly string[];
}

/* Injectable reads so the draw logic is testable against a synthetic pool
   without standing up the whole rankings board. */
export interface PackDrawDeps {
  getPoolEntries: (db: Db, keys?: PackPoolKeymode) => Promise<readonly GlobalRankingEntry[]>;
  listOwnedCardKeys: (db: Db, userId: number) => Promise<string[]>;
  selectReadyUserIds: (db: Db, userIds: readonly number[]) => Promise<number[]>;
  rng: () => number;
}

const defaultDeps: PackDrawDeps = {
  getPoolEntries: getPackPoolEntries,
  listOwnedCardKeys: listPackCollectionOwnedCardKeys,
  selectReadyUserIds: selectReadyPackCardUserIds,
  rng: Math.random,
};

/* Same two-set reading the client's duplicate protection used: holding any
   card of a player keeps the ranked pool from dealing them again, but only
   holding the GOAT itself counts against the honorary slot - those are two
   different cards. */
function cardKeySets(keys: Iterable<string>): { ownedUserIds: Set<number>; ownedGoatUserIds: Set<number> } {
  const ownedUserIds = new Set<number>();
  const ownedGoatUserIds = new Set<number>();
  for (const raw of keys) {
    const key = normalizePackCardKey(raw);
    if (!key) continue;
    const [idPart, goat] = key.split(":");
    const userId = Number(idPart);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    ownedUserIds.add(userId);
    if (goat === "goat") ownedGoatUserIds.add(userId);
  }
  return { ownedUserIds, ownedGoatUserIds };
}

function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(rng() * (index + 1));
    [items[index], items[swapWith]] = [items[swapWith], items[index]];
  }
  return items;
}

/* Slice entries that could still be dealt: inside the draw slice, not an
   honorary member, not already in the hand, and (when a set is given) not
   owned. */
function collectCandidates(
  entries: readonly GlobalRankingEntry[],
  drawTotal: number,
  used: ReadonlySet<number>,
  ownedUserIds: ReadonlySet<number> | null,
): GlobalRankingEntry[] {
  const candidates: GlobalRankingEntry[] = [];
  for (let index = 0; index < drawTotal; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const id = entry.user.id;
    if (HONORARY_USER_IDS.has(id) || used.has(id)) continue;
    if (ownedUserIds?.has(id)) continue;
    candidates.push(entry);
  }
  return candidates;
}

function revealSortRank(entry: GlobalRankingEntry): number {
  return entry.global_rank ?? entry.rank;
}

export async function drawPackHand(
  db: Db,
  options: PackDrawOptions,
  deps: PackDrawDeps = defaultDeps,
): Promise<PackDrawHand | null> {
  const type = PACK_DRAW_TYPES.get(options.packType);
  if (!type) return null;
  const { rng } = deps;

  let entries: readonly GlobalRankingEntry[];
  try {
    entries = await deps.getPoolEntries(db, type.keys);
  } catch {
    throw new PackPoolUnavailableError();
  }
  const poolTotal = entries.length;
  if (poolTotal < PACK_POOL_MIN_TOTAL) throw new PackPoolUnavailableError();
  const drawTotal = poolSliceSize(poolTotal, type.topFraction);

  const { ownedUserIds, ownedGoatUserIds } = cardKeySets([
    ...(type.guaranteesNew && options.ownerUserId > 0
      ? await deps.listOwnedCardKeys(db, options.ownerUserId)
      : []),
    ...(options.excludeCardKeys ?? []),
  ]);

  /* Uniform positions over the slice; a roll landing on an honorary member or
     a player already in the hand walks forward to the next free slot, which
     keeps the distribution effectively uniform without re-rolling forever on
     a small slice. */
  const used = new Set<number>();
  const hand: GlobalRankingEntry[] = [];
  for (let card = 0; card < type.cardCount; card += 1) {
    const roll = Math.min(drawTotal - 1, Math.floor(rng() * drawTotal));
    for (let step = 0; step < drawTotal; step += 1) {
      const entry = entries[(roll + step) % drawTotal];
      if (!entry) continue;
      const id = entry.user.id;
      if (HONORARY_USER_IDS.has(id) || used.has(id)) continue;
      used.add(id);
      hand.push(entry);
      break;
    }
  }
  if (hand.length === 0) throw new PackPoolUnavailableError();

  /* Duplicate protection: owned slots trade for unowned players from the same
     slice, weakest duplicates first so a scarce new card preserves the pack's
     best hit. With the whole board in memory there is no page walk to bound:
     the candidate set is exact, and a collector who owns the slice simply
     keeps their duplicates. */
  if (type.guaranteesNew && ownedUserIds.size > 0) {
    const ownedSlots = hand
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => ownedUserIds.has(entry.user.id))
      .sort((a, b) => revealSortRank(b.entry) - revealSortRank(a.entry))
      .map(({ index }) => index);
    if (ownedSlots.length > 0) {
      const replacements = shuffleInPlace(collectCandidates(entries, drawTotal, used, ownedUserIds), rng)
        .slice(0, ownedSlots.length);
      for (let at = 0; at < replacements.length; at += 1) {
        used.add(replacements[at].user.id);
        hand[ownedSlots[at]] = replacements[at];
      }
    }
  }

  /* Readiness: a player with no stored score window would mint over the live
     osu! lane at reveal time, so trade them for pre-verified ready players
     and warm the originals instead (the route fires the warm). Candidates are
     readiness-checked in one batch before use; if the slice honestly has no
     ready player left, the not-ready ones deal anyway and the client's cold
     path owns them. */
  const readyInHand = new Set(await deps.selectReadyUserIds(db, hand.map((entry) => entry.user.id)));
  const notReadySlots = hand
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !readyInHand.has(entry.user.id));
  /* Every originally-not-ready player gets warmed: a replaced one for the
     next person who draws them, an unreplaced one for the reveal it is about
     to be cold in. */
  const notReadyUserIds = notReadySlots.map(({ entry }) => entry.user.id);
  if (notReadySlots.length > 0) {
    const guarded = type.guaranteesNew ? ownedUserIds : null;
    const sampled = shuffleInPlace(collectCandidates(entries, drawTotal, used, guarded), rng)
      .slice(0, Math.max(notReadySlots.length * 8, 24));
    const readyCandidateIds = new Set(await deps.selectReadyUserIds(db, sampled.map((entry) => entry.user.id)));
    const readyCandidates = sampled.filter((entry) => readyCandidateIds.has(entry.user.id));
    for (const { index } of notReadySlots) {
      const replacement = readyCandidates.shift();
      if (!replacement) break;
      used.add(replacement.user.id);
      hand[index] = replacement;
    }
  }

  // Weakest pull first, so the reveal builds toward the pack's best card.
  hand.sort((a, b) => revealSortRank(b) - revealSortRank(a));

  const players: PackDrawSlot[] = hand.map((entry) => ({
    userId: entry.user.id,
    username: entry.user.username,
    avatarUrl: entry.user.avatar_url,
    countryCode: entry.user.country_code,
    globalRank: entry.global_rank,
    poolRank: entry.rank,
    pp: entry.pp,
  }));

  /* The honorary slot, mirrored from applyHonoraryHit: one roll decides
     whether the pack contains a GOAT at all; on a hit the final slot becomes
     a random roster member (preferring one the opener's collection lacks as a
     GOAT), and cascadeChance keeps filling backwards from the end until it
     misses, runs out of slots, or runs out of roster. */
  if (type.honoraryChance > 0 && players.length > 0 && rng() < type.honoraryChance) {
    const dealt = new Set<number>();
    for (let slot = players.length - 1; slot >= 0; slot -= 1) {
      const candidates = HONORARY_DRAW_POOL.filter((id) => !dealt.has(id));
      const unowned = candidates.filter((id) => !ownedGoatUserIds.has(id));
      const pool = unowned.length > 0 ? unowned : candidates;
      if (pool.length === 0) break;
      const chosen = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
      players[slot] = { honorary: true, userId: chosen };
      dealt.add(chosen);
      if (!(type.honoraryCascadeChance > 0) || rng() >= type.honoraryCascadeChance) break;
    }
  }

  return { poolTotal, players, notReadyUserIds };
}
