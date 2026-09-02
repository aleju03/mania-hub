import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  fetchLiveGlobalRankings,
  fetchLivePackCardSnapshotDirect,
  fetchLivePackCardSnapshotsDirect,
  fetchLivePlayerProfileSnapshotDirect,
  isLiveBackendConfigured,
  fetchLivePackPlayersReady,
  LiveBackendRequestError,
  warmLivePackPlayers,
  type LiveGlobalRankingEntry,
} from "./live-backend";
import { harvestAvatarAccents } from "./avatar-accent-harvest";
import { parseCardMotif, type CardMotif } from "./card-motif";
import { parsePackCardKey } from "./pack-collection";
import { HONORARY_PACK_POOL, honoraryPlayerById, isHonoraryPlayer, type HonoraryPlayer } from "./honorary-players";
import { getUserScoresBestWindow } from "./osu";
import { drawServerPack, type ServerPackDrawResult, type ServerWalletState } from "./pack-draw";
import type { OsuScore } from "./types";

/* Default cards per pack; pack types override via cardCount. */
export const PACK_SIZE = 5;

// Packs draw from the server's tracked-player pool (the global
// rankings snapshot, ~6k players whose data the backend already stores), so
// opening a pack costs local DB reads instead of osu! API calls. The pool=packs
// variant additionally merges in rankless tracked members, whether they opted
// in manually or were discovered from a score. They become pullable cards but
// stay off the ranking surfaces. There is deliberately no direct osu!
// rankings fallback: it used to exist, and on 2026-08-07 a run of spammed
// opens got its pool reads 429ed by the backend's abuse guard, which routed
// every one of those draws onto random deep osu! rankings pages (~50 real
// osu! API calls a minute). A draw the pool cannot serve fails instead.
//
// Signed-in opens no longer roll here at all: drawPackPlayersFromServer asks
// the backend to deal (POST /api/packs/draw, live-backend/src/features/
// pack-draw.ts), which enforces the slice, the odds and duplicate protection
// where the pool lives and returns the hand with its cards in one response.
// The paging, dup-replacement and honorary machinery below is the
// browser-local draw for anonymous wallets, which are never synced or logged.

// Pool pages mirror the osu! rankings shape: 50 rows per page.
export const RANKINGS_PAGE_SIZE = 50;

export interface PackPlayer {
  user: {
    id: number;
    username: string;
    avatar_url: string;
    country_code: string;
    statistics: { global_rank: number | null; pp: number };
  };
  globalRank: number;
  pp: number;
  /* An Eternal slot: this card reveals at the Eternal tier, whether it is
     the opener's own completion reward or another collector's card on the
     0.0025% pull. Display-only on this side - the server dealt the ":eternal"
     row and refuses the tier from any client claim, so forging this flag
     paints a card only on the forger's own screen. */
  eternal?: boolean;
  /* A milestone card (the foil, or the golden card, which is also an Eternal
     slot). The server dealt it on a variant key it names here, with the
     badge text and motif the face is drawn with; the mint pass and the pull
     report address the holding by that key. Display-only on this side like
     the Eternal flag: the key is only believed server-side for a holding the
     collector already has. */
  foil?: boolean;
  milestone?: boolean;
  cardKey?: string;
  customLabel?: string | null;
  motif?: CardMotif | null;
}

/* The variant fields a server slot may carry, bounded: a key that is not a
   variant of this player is dropped, and a motif that does not parse is no
   motif. */
export function packPlayerVariantFields(slot: {
  userId: number;
  foil?: boolean;
  milestone?: boolean;
  cardKey?: string;
  customLabel?: string | null;
  motif?: CardMotif | null;
}): Pick<PackPlayer, "foil" | "milestone" | "cardKey" | "customLabel" | "motif"> {
  const parsed = typeof slot.cardKey === "string" ? parsePackCardKey(slot.cardKey) : null;
  const cardKey = parsed && parsed.userId === slot.userId && parsed.variant > 0 ? slot.cardKey : undefined;
  if (!cardKey) return {};
  const customLabel = typeof slot.customLabel === "string" && slot.customLabel.trim() ? slot.customLabel.slice(0, 60) : null;
  return {
    cardKey,
    customLabel,
    motif: parseCardMotif(slot.motif ?? null),
    ...(slot.foil === true ? { foil: true as const } : {}),
    ...(slot.milestone === true ? { milestone: true as const } : {}),
  };
}

// The booster lineup. Standard burns a regenerating pack charge; the rest
// are bought with shards recycled from duplicate cards and draw from
// progressively tighter top slices of the tracked pool. Within a pack's
// slice every player has identical odds - rarity always comes from the
// player's real scores, never from the draw.
export type PackTypeId = "standard" | "wild" | "4k" | "7k" | "elite" | "legend";

export type PackCost = { kind: "charge" } | { kind: "shards"; amount: number };

export interface PackTypeDef {
  id: PackTypeId;
  name: string;
  cost: PackCost;
  /* Slice of the pool this pack draws from (1 = the whole pool). */
  topFraction: number;
  /* Narrows the draw to players whose main keymode this is. The filter lives
     on the server (the packs pool with ?keys=). */
  keys?: 4 | 7;
  /* Cards dealt per pack. */
  cardCount: number;
  /* Replaces owned pulls with unowned cards from the same slice when possible. */
  guaranteesNew?: boolean;
  /* Probability (0-1) that one slot in the pack is replaced by a random
     honorary player. The ranked pool is stripped of them on the way in (see
     withoutHonoraryMembers), so this is the only way to pull them, and the
     roster is drawn from uniformly here, so it is the same way for each. */
  honoraryChance: number;
  /* Probability (0-1) that a pack which already hit rolls *another* honorary
     into the slot before it, re-rolled after each one, so a hot pack can keep
     going until it runs out of slots or roster.

     This deliberately does not touch how often a pack contains a GOAT at all:
     the first hit is still honoraryChance and nothing else, and this only ever
     asks what happens after one has already landed. A double is therefore
     honoraryChance * this, which on a Standard pack is about one in four
     thousand - rare enough to stay a story, common enough that the story
     eventually happens to someone. Zero disables it entirely. */
  honoraryCascadeChance: number;
  blurb: string;
  accent: { r: number; g: number; b: number };
}

/* How likely a pack that already dealt an honorary deals another one. Shared
   by every pack that can cascade, so "can this double" is a per-pack decision
   and "how hot does a hot pack run" is one number for the whole game. */
export const HONORARY_CASCADE_CHANCE = 0.1;

export const PACK_TYPES: PackTypeDef[] = [
  {
    id: "standard",
    name: "Standard",
    cost: { kind: "charge" },
    topFraction: 1,
    cardCount: PACK_SIZE,
    honoraryChance: 0.0025,
    honoraryCascadeChance: HONORARY_CASCADE_CHANCE,
    blurb: "Every tracked player, same odds",
    accent: { r: 167, g: 139, b: 250 },
  },
  {
    id: "wild",
    name: "Wild",
    // The volume pack: double the cards, priced so bulk is a convenience
    // rather than the cheapest route to a full collection. 30 was below the
    // pool's own average card value, which made it the cheapest route to
    // shards as well: ten whole-pool cards recycle for more than that once a
    // collection is finished and every card it deals is a duplicate.
    cost: { kind: "shards", amount: 45 },
    topFraction: 1,
    cardCount: 10,
    guaranteesNew: true,
    honoraryChance: 0.0075,
    honoraryCascadeChance: HONORARY_CASCADE_CHANCE,
    blurb: "Whole pool, new cards first",
    accent: { r: 52, g: 211, b: 153 },
  },
  // The keymode pair: the whole pool cut to one main keymode rather than a
  // top slice. What they sell is targeting, not card quality - within their
  // pool every player still has identical odds and rarity still comes from
  // real scores.
  //
  // They are priced apart because their pools are not comparable. 4K mains are
  // ~89% of the tracked pool and skew low (27% common, 0.1% World Class),
  // while the 988 7K mains are top-heavy (15% World Class), so a 7K card is
  // worth about four and a half times a 4K one. At a shared 60 that made 4K
  // the worst deal in the game by a wide margin - a fifth of its price back on
  // a finished collection, against 7K's two thirds - for the same feature.
  {
    id: "4k",
    name: "4K",
    cost: { kind: "shards", amount: 40 },
    topFraction: 1,
    keys: 4,
    cardCount: PACK_SIZE,
    guaranteesNew: true,
    honoraryChance: 0.005,
    honoraryCascadeChance: HONORARY_CASCADE_CHANCE,
    blurb: "Main 4K players only",
    accent: { r: 56, g: 189, b: 248 },
  },
  {
    id: "7k",
    name: "7K",
    cost: { kind: "shards", amount: 60 },
    topFraction: 1,
    keys: 7,
    cardCount: PACK_SIZE,
    guaranteesNew: true,
    honoraryChance: 0.005,
    honoraryCascadeChance: HONORARY_CASCADE_CHANCE,
    blurb: "Main 7K players only",
    accent: { r: 248, g: 113, b: 113 },
  },
  {
    id: "elite",
    name: "Elite",
    // Premium tiers are deliberately steep: shards flow constantly from
    // opened packs and recycling, so cheap top-slice packs made the whole
    // ladder trivial to skip.
    //
    // 100 -> 115 came with the shard-ladder buff, not from this pack getting
    // better. Seven cards out of the pool's top 10% are worth more in shards
    // than any other pack deals, so Elite is the first one a richer ladder
    // pushes past its own price; at 100 it would have returned ~96% of its
    // cost on a finished collection, which is the infinite loop the duplicate
    // rate exists to close. See TIER_SHARD_VALUES in pack-collection.ts.
    cost: { kind: "shards", amount: 115 },
    topFraction: 0.1,
    cardCount: 7,
    guaranteesNew: true,
    honoraryChance: 0.01,
    honoraryCascadeChance: HONORARY_CASCADE_CHANCE,
    blurb: "Top 10%, new cards first",
    accent: { r: 251, g: 191, b: 36 },
  },
  {
    id: "legend",
    name: "Legend",
    cost: { kind: "shards", amount: 200 },
    topFraction: 0.02,
    cardCount: PACK_SIZE,
    guaranteesNew: true,
    honoraryChance: 0.03,
    // The one pack that cannot double. At 3% its honorary slot already hits
    // twelve times as often as Standard's, and that rate is the whole reason
    // to buy it; stacking a cascade on top would make the pack that is already
    // the fastest route to the roster the only way anyone finishes it.
    honoraryCascadeChance: 0,
    blurb: "Top 2%, new cards first",
    accent: { r: 244, g: 114, b: 182 },
  },
];

export function packTypeById(id: PackTypeId): PackTypeDef {
  return PACK_TYPES.find((type) => type.id === id) ?? PACK_TYPES[0];
}

/* Translatable shelf copy per pack type, resolved at render with i18n._.
   The `name`/`blurb` fields on PACK_TYPES stay English on purpose: the canvas
   foil art (packArt.ts) prints `name` straight onto the pack texture, and
   rendered artifacts keep the one English form. */
export const PACK_TYPE_NAME_LABELS: Record<PackTypeId, MessageDescriptor> = {
  standard: msg`Standard`,
  wild: msg`Wild`,
  "4k": msg`4K`,
  "7k": msg`7K`,
  elite: msg`Elite`,
  legend: msg`Legend`,
};

export const PACK_TYPE_BLURB_LABELS: Record<PackTypeId, MessageDescriptor> = {
  standard: msg`Every tracked player, same odds`,
  wild: msg`Whole pool, new cards first`,
  "4k": msg`Main 4K players only`,
  "7k": msg`Main 7K players only`,
  elite: msg`Top 10%, new cards first`,
  legend: msg`Top 2%, new cards first`,
};

// Tiny pools widen a sliced draw to a sane floor instead of repeating the
// same handful of players every pack.
export const POOL_SLICE_MIN_PLAYERS = 50;

export function poolSliceSize(total: number, topFraction: number): number {
  if (topFraction >= 1) return total;
  return Math.max(Math.min(total, POOL_SLICE_MIN_PLAYERS), Math.round(total * topFraction));
}

export function rollUniformPositions(total: number, count: number, rng: () => number): number[] {
  return Array.from({ length: count }, () => 1 + Math.min(total - 1, Math.floor(rng() * total)));
}

export function rankToPage(rank: number): number {
  return Math.max(1, Math.ceil(rank / RANKINGS_PAGE_SIZE));
}

export function rankIndexInPage(rank: number): number {
  return (rank - 1) % RANKINGS_PAGE_SIZE;
}

/* Resolves rolled ranks against fetched rankings pages. Prefers the exact
   rank's row; on a duplicate player (two ranks landing on the same row) or a
   short page it walks the page from a rng-chosen offset for the first unused
   row, then falls back to any unused row across all fetched pages. */
export function pickPackEntries<T extends { user: { id: number } }>(
  ranks: number[],
  pagesByNumber: Map<number, T[]>,
  rng: () => number = Math.random,
  usedUserIds: Set<number> = new Set<number>(),
): T[] {
  const picked: T[] = [];

  const takeFromPage = (page: T[], preferredIndex: number): T | null => {
    if (page.length === 0) return null;
    const preferred = page[preferredIndex];
    if (preferred && !usedUserIds.has(preferred.user.id)) return preferred;
    const start = Math.floor(rng() * page.length);
    for (let step = 0; step < page.length; step += 1) {
      const candidate = page[(start + step) % page.length];
      if (candidate && !usedUserIds.has(candidate.user.id)) return candidate;
    }
    return null;
  };

  for (const rank of ranks) {
    const page = pagesByNumber.get(rankToPage(rank)) ?? [];
    let entry = takeFromPage(page, rankIndexInPage(rank));
    if (!entry) {
      for (const otherPage of pagesByNumber.values()) {
        entry = takeFromPage(otherPage, 0);
        if (entry) break;
      }
    }
    if (!entry) continue;
    usedUserIds.add(entry.user.id);
    picked.push(entry);
  }

  return picked;
}

// Weakest pull first so the reveal builds toward the pack's best card.
export function sortIntoRevealOrder(players: PackPlayer[]): PackPlayer[] {
  return [...players].sort((a, b) => b.globalRank - a.globalRank);
}

export function liveEntryToPackPlayer(entry: LiveGlobalRankingEntry): PackPlayer {
  return {
    user: {
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
      country_code: entry.user.country_code,
      statistics: { global_rank: entry.global_rank ?? null, pp: entry.pp },
    },
    // Tracked players carry their osu! global rank; the pool position is the
    // emergency stand-in so sorting and captions never break.
    globalRank: entry.global_rank ?? entry.rank,
    pp: entry.pp,
  };
}

export type PoolPageFetcher = (page: number) => Promise<{ ranking: LiveGlobalRankingEntry[]; total: number }>;

/* Pages of the server's pack pool, optionally narrowed to one main keymode.
   Every page of a draw must come from the same pool, so the keymode is bound
   here once rather than threaded through each fetch. */
function poolPageFetcherFor(keys?: 4 | 7): PoolPageFetcher {
  return async (page) => {
    const snapshot = await fetchLiveGlobalRankings({
      page,
      pageSize: RANKINGS_PAGE_SIZE,
      sort: "rank",
      dir: "desc",
      pool: "packs",
      ...(keys ? { keys } : {}),
    });
    return { ranking: snapshot.ranking, total: snapshot.total };
  };
}

/* Strips the honorary roster out of every pool page a draw reads.
 *
 * The honorary slot is meant to be the only way a GOAT is dealt, at a flat
 * per-pack chance and then uniformly across the roster. But the tier is awarded
 * by user id (see maniacard.ts), not by card power, so a roster member dealt by
 * the ordinary pool mints as a GOAT just the same, and several of them are live
 * ranked players sitting in the pool board. The two paths added up in favour of
 * whoever ranks highest: the top of the roster was pulled roughly fourteen
 * times as often as its deleted accounts, because a top-ranked player is inside
 * every pack's rank slice while a deleted one is inside none.
 *
 * Filtering at the page level rather than at the pick catches all of it at once:
 * the first pick, the owned and not-ready re-rolls, and the extra pages a re-roll
 * loads, since they all read the pool through this fetcher. `total` is left
 * alone so pool size, the rank slices and the collection denominators do not
 * shift under an edit to the roster.
 */
function withoutHonoraryMembers(fetchPage: PoolPageFetcher): PoolPageFetcher {
  return async (page) => {
    const response = await fetchPage(page);
    const ranking = response.ranking.filter((entry) => !isHonoraryPlayer(entry.user.id));
    return ranking.length === response.ranking.length ? response : { ...response, ranking };
  };
}

export interface PackDrawOptions {
  /* Draw from the pool's top slice instead of the whole pool (1 = all). */
  topFraction?: number;
  /* Draw only players whose main keymode this is (server-filtered pool). */
  keys?: 4 | 7;
  /* Cards to draw (defaults to PACK_SIZE). */
  count?: number;
  /* Chance (0-1) that one slot becomes a random honorary player. */
  honoraryChance?: number;
  /* Chance (0-1) that a pack which already hit rolls another honorary into the
     slot before it, re-rolled after each one. Omitted or 0 means one at most. */
  honoraryCascadeChance?: number;
  /* Collected card ids. When set, every owned slot is replaced with an
     unowned player from the same draw slice when one exists. Near-complete
     collections keep only the repeats that have no unowned replacement. */
  ownedUserIds?: ReadonlySet<number>;
  /* Players already held *as a GOAT*. Distinct from ownedUserIds because the
     ordinary card and the GOAT card of a roster member are two cards. */
  ownedGoatUserIds?: ReadonlySet<number>;
}

function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(rng() * (index + 1));
    [items[index], items[swapWith]] = [items[swapWith], items[index]];
  }
  return items;
}

/* Picks random players from the given pool pages who are inside the draw
   slice and outside both the owned set and the current pack. */
export function pickUnownedPoolEntries(
  pages: Iterable<LiveGlobalRankingEntry[]>,
  drawTotal: number,
  ownedUserIds: ReadonlySet<number>,
  usedUserIds: Set<number>,
  count: number,
  rng: () => number,
): LiveGlobalRankingEntry[] {
  const candidates: LiveGlobalRankingEntry[] = [];
  for (const page of pages) {
    for (const entry of page) {
      if (entry.rank <= drawTotal && !ownedUserIds.has(entry.user.id) && !usedUserIds.has(entry.user.id)) {
        candidates.push(entry);
      }
    }
  }
  shuffleInPlace(candidates, rng);
  const picked: LiveGlobalRankingEntry[] = [];
  for (const candidate of candidates) {
    if (picked.length >= count) break;
    if (usedUserIds.has(candidate.user.id)) continue;
    usedUserIds.add(candidate.user.id);
    picked.push(candidate);
  }
  return picked;
}

/* Back-compat helper for tests and small callers that only need one entry. */
export function pickUnownedPoolEntry(
  pages: Iterable<LiveGlobalRankingEntry[]>,
  drawTotal: number,
  ownedUserIds: ReadonlySet<number>,
  usedUserIds: ReadonlySet<number>,
  rng: () => number,
): LiveGlobalRankingEntry | null {
  const used = new Set(usedUserIds);
  return pickUnownedPoolEntries(pages, drawTotal, ownedUserIds, used, 1, rng)[0] ?? null;
}

function rankOfLiveEntry(entry: LiveGlobalRankingEntry): number {
  return entry.global_rank ?? entry.rank;
}

/* How far a duplicate-protected draw will hunt for unowned players beyond the
   pages it already loaded, and how many of those pages it reads at once.

   Uncapped, this walked every page in the slice. A finished collection can
   never find a replacement, so the loop never broke early: a Wild pack (the
   whole pool, ~180 pages at this pool size) fired ~179 sequential reads per
   open straight from the browser, blew through the backend's per-IP minute
   limit, and the 429'd page turned the whole draw into "couldn't deal a pack".

   `guaranteesNew` promises new cards where possible, so a bounded search is
   the honest reading: with 1% of the pool unowned, sixteen 50-player pages
   still turn up a new card better than 99 times in 100, and a collector who
   owns everything simply gets duplicates instead of an error. */
const POOL_REPLACEMENT_MAX_EXTRA_PAGES = 16;
const POOL_REPLACEMENT_PAGE_BATCH = 4;

/* How many times a draw re-rolls players the backend has never fetched. Each
   round costs one batched probe; two is enough to clear a hand in practice and
   bounds what a draw can spend when the pool is genuinely cold. */
const POOL_READINESS_REROLL_ROUNDS = 2;

/* Which of these players have no stored best-score window, so their card
   cannot be built from the local DB. Fails open: a backend hiccup deals the
   hand exactly as it would have before this existed. */
async function findNotReadyPackPlayers(userIds: readonly number[]): Promise<Set<number>> {
  if (!isLiveBackendConfigured() || userIds.length === 0) return new Set();
  try {
    // A readiness-only read: no card is built, and no retry-and-wait is carried
    // over from the reveal path, which belongs to a card someone is staring at
    // rather than to a draw that can simply deal the hand it already has.
    const ready = await fetchLivePackPlayersReady(userIds);
    return new Set(userIds.filter((userId) => !ready.has(userId)));
  } catch {
    return new Set();
  }
}

/* Keeps players whose card is not built yet out of the hand.
 *
 * Dealing one used to mint their profile inline at reveal time, on the
 * interactive osu! lane, three calls a card - which is how a pack burst over
 * two freshly activated countries pinned the API budget at its hard ceiling
 * for six minutes on 2026-08-06. A not-ready player is treated exactly like an
 * already-owned one (same re-roll, so pool size and collection-progress
 * denominators are untouched) and handed to the paced warm instead, which
 * makes them dealable on their own time. */
async function replaceNotReadyPoolEntries(
  entries: LiveGlobalRankingEntry[],
  pagesByNumber: Map<number, LiveGlobalRankingEntry[]>,
  head: { ranking: LiveGlobalRankingEntry[]; total: number },
  fetchPage: PoolPageFetcher,
  drawTotal: number,
  ownedUserIds: ReadonlySet<number> | undefined,
  rng: () => number,
): Promise<void> {
  const warmed = new Set<number>();
  for (let round = 0; round < POOL_READINESS_REROLL_ROUNDS; round += 1) {
    const notReady = await findNotReadyPackPlayers(entries.map((entry) => entry.user.id));
    if (notReady.size === 0) return;
    // Fire-and-forget: the warm is for the next person who draws them, not
    // this hand, and it runs on the bulk lane so it cannot outrun the budget.
    const fresh = [...notReady].filter((userId) => !warmed.has(userId));
    if (fresh.length > 0) {
      fresh.forEach((userId) => warmed.add(userId));
      void warmLivePackPlayers(fresh).catch(() => {});
    } else {
      // Nothing moved last round: the pool has no ready replacement to offer,
      // so another probe would ask the same question and get the same answer.
      return;
    }
    // The union is both the slot list and the candidate filter, so a re-roll
    // can never hand back a duplicate to a duplicate-protected pack.
    const unavailable = new Set<number>([...(ownedUserIds ?? []), ...notReady]);
    await replaceOwnedPoolEntries(entries, pagesByNumber, head, fetchPage, drawTotal, unavailable, rng);
  }
}

async function replaceOwnedPoolEntries(
  entries: LiveGlobalRankingEntry[],
  pagesByNumber: Map<number, LiveGlobalRankingEntry[]>,
  head: { ranking: LiveGlobalRankingEntry[]; total: number },
  fetchPage: PoolPageFetcher,
  drawTotal: number,
  ownedUserIds: ReadonlySet<number>,
  rng: () => number,
) {
  const ownedIndexes = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => ownedUserIds.has(entry.user.id))
    // Replace the weakest duplicates first, so scarce new cards preserve the pack's hit.
    .sort((a, b) => rankOfLiveEntry(b.entry) - rankOfLiveEntry(a.entry))
    .map(({ index }) => index);
  if (ownedIndexes.length === 0) return;

  const used = new Set(entries.map((entry) => entry.user.id));
  const replacements = pickUnownedPoolEntries(
    pagesByNumber.values(),
    drawTotal,
    ownedUserIds,
    used,
    ownedIndexes.length,
    rng,
  );

  const maxPage = rankToPage(drawTotal);
  const missingPages = shuffleInPlace(
    Array.from({ length: maxPage }, (_, index) => index + 1).filter((page) => !pagesByNumber.has(page)),
    rng,
  ).slice(0, POOL_REPLACEMENT_MAX_EXTRA_PAGES);

  for (let start = 0; start < missingPages.length; start += POOL_REPLACEMENT_PAGE_BATCH) {
    if (replacements.length >= ownedIndexes.length) break;
    const batch = missingPages.slice(start, start + POOL_REPLACEMENT_PAGE_BATCH);
    const responses = await Promise.all(
      batch.map(async (page) => {
        try {
          return { page, response: page === 1 ? head : await fetchPage(page) };
        } catch {
          // A page that will not load costs this draw one replacement, not the
          // whole pack. The entry it would have replaced stays put and deals as
          // a duplicate, which is what an exhausted search does anyway.
          return null;
        }
      }),
    );
    for (const loaded of responses) {
      if (!loaded) continue;
      pagesByNumber.set(loaded.page, loaded.response.ranking);
      if (replacements.length >= ownedIndexes.length) continue;
      replacements.push(
        ...pickUnownedPoolEntries(
          [loaded.response.ranking],
          drawTotal,
          ownedUserIds,
          used,
          ownedIndexes.length - replacements.length,
          rng,
        ),
      );
    }
  }

  for (let replacementIndex = 0; replacementIndex < replacements.length; replacementIndex += 1) {
    entries[ownedIndexes[replacementIndex]] = replacements[replacementIndex];
  }
}

export interface PackDraw {
  players: PackPlayer[];
  poolTotal: number | null;
}

// Sort-to-back sentinel for honoraries with no recorded peak rank.
const UNKNOWN_HONORARY_PEAK_RANK = 10_000;

export function honoraryToPackPlayer(player: HonoraryPlayer): PackPlayer {
  return {
    user: {
      id: player.id,
      username: player.username,
      avatar_url: player.avatarUrl,
      country_code: player.countryCode,
      statistics: { global_rank: player.peakRank, pp: player.peakPp },
    },
    // Peak rank is the honest figure for this roster: most of them are
    // unranked or deleted today. Unknown peaks sort to the back.
    globalRank: player.peakRank ?? UNKNOWN_HONORARY_PEAK_RANK,
    pp: player.peakPp,
  };
}

/* Rolls the pack's honorary chance and, on a hit, replaces the final slot (the
   pack's reveal climax) with a random honorary player. Skips players the opener
   already owns when the pack guarantees new cards, and never duplicates a
   player already dealt in this pack.

   A pack that hits then re-rolls cascadeChance for another honorary in the slot
   before it, and keeps re-rolling after each one until it misses, runs out of
   slots, or runs out of roster. They fill backwards from the end so a double
   lands as two GOATs in a row at the climax rather than one buried mid-reveal.

   The cascade is strictly a bonus on top of a hit that already happened: the
   first roll is untouched, so how often a pack contains a GOAT at all is still
   honoraryChance and nothing else. Passing 0 (which Legend does) is exactly the
   single-slot behaviour, right down to the number of rng draws it spends. */
export function applyHonoraryHit(
  players: PackPlayer[],
  rng: () => number,
  chance: number,
  ownedGoatUserIds?: ReadonlySet<number>,
  cascadeChance = 0,
): PackPlayer[] {
  if (!(chance > 0) || players.length === 0) return players;
  if (rng() >= chance) return players;

  const dealt = new Set(players.map((player) => player.user.id));
  const next = [...players];

  for (let slot = next.length - 1; slot >= 0; slot -= 1) {
    const candidates = HONORARY_PACK_POOL.filter((player) => !dealt.has(player.id));
    const unowned = ownedGoatUserIds ? candidates.filter((player) => !ownedGoatUserIds.has(player.id)) : [];
    // Prefer one they don't have; fall back to the whole roster rather than
    // silently dropping the hit once the set is complete.
    const pool = unowned.length > 0 ? unowned : candidates;
    if (pool.length === 0) break;

    const chosen = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
    next[slot] = honoraryToPackPlayer(chosen);
    // Kept out of `candidates` for the next turn of the cascade, so a pack
    // cannot deal the same honorary twice.
    dealt.add(chosen.id);

    if (!(cascadeChance > 0) || rng() >= cascadeChance) break;
  }
  return next;
}

/* Primary draw: the server's tracked-player pool. Free of osu! API
   calls - the global rankings snapshot is a local DB read on the backend.
   Draws uniformly over the whole pool, or over its top slice for the
   shard-bought pack types. */
export async function drawPackPlayersFromPool(
  rng: () => number = Math.random,
  fetchPage?: PoolPageFetcher,
  options: PackDrawOptions = {},
): Promise<PackDraw> {
  const fetchPoolPage = withoutHonoraryMembers(fetchPage ?? poolPageFetcherFor(options.keys));
  const head = await fetchPoolPage(1);
  const total = Math.max(head.total, head.ranking.length);
  if (total < 100) throw new Error("Tracked player pool is too small for packs.");
  const drawTotal = poolSliceSize(total, options.topFraction ?? 1);
  const positions = rollUniformPositions(drawTotal, options.count ?? PACK_SIZE, rng);
  const pages = [...new Set(positions.map(rankToPage))];
  const responses = await Promise.all(
    pages.map(async (page) => (page === 1 ? head : await fetchPoolPage(page))),
  );
  const pagesByNumber = new Map(pages.map((page, index) => [page, responses[index]?.ranking ?? []]));
  const entries = pickPackEntries(positions, pagesByNumber, rng);
  if (entries.length === 0) throw new Error("No players available for this pack.");

  if (options.ownedUserIds && options.ownedUserIds.size > 0) {
    await replaceOwnedPoolEntries(entries, pagesByNumber, head, fetchPoolPage, drawTotal, options.ownedUserIds, rng);
  }

  await replaceNotReadyPoolEntries(entries, pagesByNumber, head, fetchPoolPage, drawTotal, options.ownedUserIds, rng);

  const players = sortIntoRevealOrder(entries.map(liveEntryToPackPlayer));
  return {
    players: applyHonoraryHit(
      players,
      rng,
      options.honoraryChance ?? 0,
      options.ownedGoatUserIds,
      options.honoraryCascadeChance ?? 0,
    ),
    poolTotal: total,
  };
}

/* A pool read the backend 429ed is retried once when the asked-for wait is
   short; a longer wait (or any other failure) surfaces as a failed deal for
   the page to show. The same reveal-stall rule as the card probes: see
   PACK_PROBE_RETRY_MAX_WAIT_MS. */
const PACK_DRAW_RETRY_MAX_WAIT_MS = 1_500;

export async function drawPackPlayers(
  rng: () => number = Math.random,
  options: PackDrawOptions = {},
): Promise<PackDraw> {
  if (!isLiveBackendConfigured()) throw new Error("Packs require the tracked player pool.");
  try {
    return await drawPackPlayersFromPool(rng, undefined, options);
  } catch (error) {
    // Only a rate-limited read that is about to clear is worth a second try.
    // Everything else fails the deal: degrading to a direct osu! rankings
    // draw here is what turned the 2026-08-07 pack spam into an osu! API
    // flood, because the 429 fires precisely when someone is hammering opens.
    if (
      error instanceof LiveBackendRequestError &&
      error.status === 429 &&
      error.retryAfterMs != null &&
      error.retryAfterMs <= PACK_DRAW_RETRY_MAX_WAIT_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs ?? 0));
      return drawPackPlayersFromPool(rng, undefined, options);
    }
    throw error;
  }
}

export interface ServerPackDeal {
  draw: PackDraw;
  /* Stored best-score windows the draw response carried, keyed by player id.
     Players absent here mint through the existing cold path. */
  scoresByUserId: Map<number, OsuScore[]>;
  /* The server's word on which dealt cards are first copies, keyed by wallet
     card key. The synced collection lives server-side, so this - not the
     local wallet - is what the reveal's NEW badge should show. */
  isNewByCardKey: Map<string, boolean>;
  /* The wallet after the spend (the draw is the purchase); null only if the
     backend response somehow lacked one. */
  wallet: ServerWalletState | null;
}

/* Maps the backend's dealt hand into the shapes the reveal renders. Honorary
   slots arrive as bare ids and hydrate from the local roster, which stays the
   one source of a GOAT card's face; an id this build's roster cannot render
   (deploy skew) is dropped rather than dealt as a broken card. */
export function mapServerPackDraw(result: ServerPackDrawResult): ServerPackDeal {
  const players: PackPlayer[] = [];
  const isNewByCardKey = new Map<string, boolean>();
  const snapshotsByUserId = new Map(
    result.cards.flatMap((card) => {
      const userId = Math.floor(Number(card?.user?.id) || 0);
      return userId > 0 && card.user ? [[userId, card.user] as const] : [];
    }),
  );
  for (const slot of result.players) {
    const variant = packPlayerVariantFields(slot);
    if (typeof slot.isNew === "boolean") {
      isNewByCardKey.set(
        variant.cardKey ?? (slot.honorary ? `${slot.userId}:goat` : slot.eternal ? `${slot.userId}:eternal` : String(slot.userId)),
        slot.isNew,
      );
    }
    if (slot.honorary) {
      const member = honoraryPlayerById(slot.userId);
      if (member?.cardReady) players.push(honoraryToPackPlayer(member));
      continue;
    }
    if (slot.eternal) {
      // The opener's own card, or the collector's whose Eternal this pack
      // pulled. The claimed slot normally carries the frozen identity numbers
      // itself; the inlined card snapshot is an additional authoritative
      // fallback across deploy skew.
      const snapshot = snapshotsByUserId.get(slot.userId);
      const pp = slot.pp ?? snapshot?.statistics?.pp ?? 0;
      const globalRank = slot.globalRank ?? snapshot?.statistics?.global_rank ?? null;
      players.push({
        eternal: true,
        ...variant,
        user: {
          id: slot.userId,
          username: slot.username || snapshot?.username || `User ${slot.userId}`,
          avatar_url: slot.avatarUrl || snapshot?.avatar_url || "",
          country_code: slot.countryCode || snapshot?.country_code || "",
          statistics: { global_rank: globalRank, pp },
        },
        globalRank: globalRank ?? UNKNOWN_HONORARY_PEAK_RANK,
        pp,
      });
      continue;
    }
    players.push({
      ...variant,
      user: {
        id: slot.userId,
        username: slot.username ?? `User ${slot.userId}`,
        avatar_url: slot.avatarUrl ?? "",
        country_code: slot.countryCode ?? "",
        statistics: { global_rank: slot.globalRank ?? null, pp: slot.pp ?? 0 },
      },
      globalRank: slot.globalRank ?? slot.poolRank ?? UNKNOWN_HONORARY_PEAK_RANK,
      pp: slot.pp ?? 0,
    });
  }
  const scoresByUserId = new Map<number, OsuScore[]>();
  for (const card of result.cards) {
    const userId = Math.floor(Number(card?.user?.id) || 0);
    // An empty stored window means the player's plays were never fetched;
    // seeding it would mint a blank card, so leave them to the cold path.
    if (userId > 0 && Array.isArray(card?.bestScores) && card.bestScores.length > 0) {
      scoresByUserId.set(userId, card.bestScores);
    }
  }
  return {
    draw: { players, poolTotal: result.poolTotal > 0 ? result.poolTotal : null },
    scoresByUserId,
    isNewByCardKey,
    wallet: result.wallet,
  };
}

export type ServerPackDealOutcome =
  | { kind: "dealt"; deal: ServerPackDeal }
  /* The server wallet could not pay; `wallet` is the true balance to adopt. */
  | { kind: "insufficient"; reason: "charges" | "shards"; wallet: ServerWalletState | null }
  /* Logged out server-side or no backend configured: the caller falls back
     to the browser-local draw and economy. */
  | { kind: "unavailable" };

/* The signed-in deal: one request that says "open a pack", pays for it out
   of the server wallet, and comes back with the hand, its cards, and the
   spent balance. Failures other than the outcomes above throw into the
   page's "couldn't deal" retry. */
export async function drawPackPlayersFromServer(packTypeId: PackTypeId): Promise<ServerPackDealOutcome> {
  const outcome = await drawServerPack({ data: { packType: packTypeId } });
  if (!outcome) return { kind: "unavailable" };
  if (outcome.status === "insufficient") {
    return { kind: "insufficient", reason: outcome.reason, wallet: outcome.wallet };
  }
  // The backend enriches avatar accents into the payload like every other
  // player-listing response; collect them before the shapes are rebuilt.
  harvestAvatarAccents(outcome.result);
  return { kind: "dealt", deal: mapServerPackDraw(outcome.result) };
}

/* Cheap first half of a card mint. Kept separate from the cold fallback so a
   whole dealt hand can probe the local backend cache at once without letting
   cold players consume every one of the limited osu! fetch slots. */
export async function fetchCachedPackPlayerScores(userId: number): Promise<OsuScore[] | null> {
  if (isLiveBackendConfigured()) {
    try {
      // Stored best scores (profile snapshot or the user_top_scores
      // projection): a pure DB read on the backend, so a card flips
      // instantly for any player the backend has ever fetched. Staleness is
      // fine for minting a card, and the deal-time warm refreshes cold or
      // never-seen players in the background anyway. The card view trims each
      // score to the fields the maniacard reads, roughly a tenth of the
      // full snapshot payload.
      const cached = await fetchLivePackCardSnapshotDirect(String(userId));
      if (cached && Array.isArray(cached.bestScores) && cached.bestScores.length > 0) {
        return cached.bestScores;
      }
    } catch {
      // A cache miss and an unavailable cache both use the bounded cold path.
    }
  }
  return null;
}

/* The hand-wide form of fetchCachedPackPlayerScores. Never rejects: an
   unavailable cache is just an empty map, and every player falls through to
   the bounded cold lane.

   Retried once, because a rejected probe is not the same answer as "nothing
   stored". On 2026-08-03 a run of pack opens tripped the shared per-IP costly
   limiter, and every rejected hand probe pushed five players down the cold
   lane -- players who all had stored windows -- which is how 4k profile
   refreshes ended up queued. A 429 asking for longer than
   PACK_PROBE_RETRY_MAX_WAIT_MS is not worth stalling a reveal for: the cold
   lane reads the same stored rows anyway, and no longer schedules anything. */
const PACK_PROBE_RETRY_DELAY_MS = 250;
const PACK_PROBE_RETRY_MAX_WAIT_MS = 1_500;

async function fetchCachedPackPlayerScoresBatch(userIds: readonly number[]): Promise<Map<number, OsuScore[]>> {
  const scoresByUserId = new Map<number, OsuScore[]>();
  if (!isLiveBackendConfigured()) return scoresByUserId;
  for (let attempt = 0; ; attempt += 1) {
    try {
      for (const [userId, card] of await fetchLivePackCardSnapshotsDirect(userIds)) {
        // An empty stored window means the player's plays were never fetched;
        // returning it would mint a blank card, so treat it as a miss.
        if (Array.isArray(card.bestScores) && card.bestScores.length > 0) {
          scoresByUserId.set(userId, card.bestScores);
        }
      }
      return scoresByUserId;
    } catch (error) {
      const waitMs = attempt === 0 ? probeRetryWaitMs(error) : null;
      // Out of retries (or told to wait too long): the bounded cold path owns it.
      if (waitMs == null) return scoresByUserId;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/* How long to hold a rejected hand probe before its one retry, or null for
   "don't retry". A 429 sets the pace itself when it asks for a short wait. */
function probeRetryWaitMs(error: unknown): number | null {
  const retryAfterMs = error instanceof LiveBackendRequestError ? error.retryAfterMs : null;
  if (retryAfterMs == null) return PACK_PROBE_RETRY_DELAY_MS;
  return retryAfterMs <= PACK_PROBE_RETRY_MAX_WAIT_MS ? retryAfterMs : null;
}

async function fetchColdPackPlayerScores(userId: number): Promise<OsuScore[]> {
  if (isLiveBackendConfigured()) {
    try {
      // Truly cold player: this waits on the backend's live osu! fetch, but
      // coalesces with the deal-time warm's in-flight request for the same
      // player. An EMPTY bestScores list falls through to the direct osu!
      // window - it usually means the player's plays were never fetched, and
      // returning it would mint a blank card.
      // refresh: false because a card renders happily off a stale profile. The
      // reader that DOES want freshness (the profile page) keeps the default;
      // here it only meant a rejected hand probe queued five interactive
      // re-mints for players whose stored rows were perfectly usable.
      const snapshot = await fetchLivePlayerProfileSnapshotDirect(String(userId), { lookup: "id", refresh: false });
      if (snapshot && Array.isArray(snapshot.bestScores) && snapshot.bestScores.length > 0) {
        return snapshot.bestScores;
      }
    } catch {
      // Backend hiccup: degrade to the direct osu! API window below.
    }
  }
  return getUserScoresBestWindow({ data: { userId, totalLimit: 200, parallel: true } });
}

export async function fetchPackPlayerScores(userId: number): Promise<OsuScore[]> {
  return (await fetchCachedPackPlayerScores(userId)) ?? fetchColdPackPlayerScores(userId);
}

/* How many cold pack-card fetches run at once. Cached DB probes are allowed to
   cover the whole hand immediately; only the blocking /snapshot endpoint and
   direct osu! fallback use this bound. */
export const PACK_SCORE_PREFETCH_CONCURRENCY = 4;

/* On-demand semaphore for the expensive half of card fetching. Unlike
   startBoundedPrefetches, tasks only enter this queue after their cheap cache
   probe misses. That distinction matters for a ten-card hand: one run of four
   cold players must not prevent the other six from even checking whether
   their cards are already in the local DB. */
function createBoundedTaskRunner(concurrency: number) {
  const limit = Math.max(1, Math.floor(concurrency));
  const queued: Array<() => void> = [];
  let active = 0;

  const drain = () => {
    while (active < limit) {
      const start = queued.shift();
      if (!start) return;
      start();
    }
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queued.push(() => {
        active += 1;
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      });
      drain();
    });
}

/* Probes the complete hand's cache in ONE request, then admits only genuine
   misses to the four-wide cold lane. Results stay indexed to the dealt order
   even though hot cards settle together, ahead of the cold ones.

   One request, not one per player: the backend reads these rows off a single
   synchronous SQLite connection, so ten parallel probes only interleave there
   while costing ten rate-limiter slots and ten overlapping beatmap reads. */
export function prefetchPackPlayerScores(userIds: readonly number[]): Array<Promise<OsuScore[] | null>> {
  const cachedHand = fetchCachedPackPlayerScoresBatch(userIds);
  const runCold = createBoundedTaskRunner(PACK_SCORE_PREFETCH_CONCURRENCY);
  return userIds.map(async (userId) => {
    const cached = (await cachedHand).get(userId);
    if (cached) return cached;
    return runCold(() => fetchColdPackPlayerScores(userId)).catch(() => null);
  });
}

/* Starts `run` for every item with at most `concurrency` calls in flight,
   dispatching in item order, and returns one promise per item (same order).
   A failed run resolves to null so one bad fetch never poisons the batch. */
export function startBoundedPrefetches<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  concurrency: number,
): Array<Promise<R | null>> {
  const resolvers: Array<(value: R | null) => void> = [];
  const results = items.map((_, index) =>
    new Promise<R | null>((resolve) => {
      resolvers[index] = resolve;
    }),
  );
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        resolvers[index](await run(items[index]));
      } catch {
        resolvers[index](null);
      }
    }
  };
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), Math.max(1, items.length));
  for (let slot = 0; slot < workerCount; slot += 1) void worker();
  return results;
}
