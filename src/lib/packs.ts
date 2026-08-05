import {
  fetchLiveGlobalRankings,
  fetchLivePackCardSnapshotDirect,
  fetchLivePackCardSnapshotsDirect,
  fetchLivePlayerProfileSnapshotDirect,
  isLiveBackendConfigured,
  LiveBackendRequestError,
  type LiveGlobalRankingEntry,
} from "./live-backend";
import { HONORARY_PACK_POOL, type HonoraryPlayer } from "./honorary-players";
import { getRankings, getUserScoresBestWindow } from "./osu";
import type { LeanRankingEntry, OsuScore } from "./types";

/* Default cards per pack; pack types override via cardCount. */
export const PACK_SIZE = 5;

// Packs draw from the server's tracked-player pool (the global
// rankings snapshot, ~6k players whose data the backend already stores), so
// opening a pack costs local DB reads instead of osu! API calls. The pool=packs
// variant additionally merges in manual roster opt-ins - a player who adds
// themselves to their country's roster becomes a pullable card, even though
// they stay off the ranking surfaces. The direct osu! rankings path further
// down is the fallback when no server is configured or the pool draw fails.

// Global mania performance rankings expose pages 1..200 of 50 rows (deeper
// pages silently clamp to 200), so exact-rank picks stop at 10,000.
export const RANKINGS_PAGE_SIZE = 50;
export const MAX_PACK_RANK = 10_000;

// Ranks past the global cap are reachable through country leaderboards:
// their entries carry each player's global_rank, so deep pages of
// mania-dense countries cover the 10k-50k range.
export const DEEP_MIN_RANK = MAX_PACK_RANK + 1;
export const DEEP_MAX_RANK = 50_000;

export interface DeepCountryWindow {
  country: string;
  minPage: number;
  maxPage: number;
  weight: number;
}

// Country pages whose mania entries land inside the deep band. Calibrated
// against the live API on 2026-06-10 by fitting global_rank against country
// page (targeting global ranks ~11k-45k, inside the band so playerbase
// growth keeps them valid). Drift only lowers hit rate; the global_rank
// filter in drawDeepPackEntry keeps picks honest regardless. Weight is the
// window width, a proxy for how many in-band players the country holds.
export const DEEP_COUNTRY_POOL: DeepCountryWindow[] = [
  { country: "US", minPage: 28, maxPage: 133, weight: 106 },
  { country: "CN", minPage: 37, maxPage: 122, weight: 86 },
  { country: "KR", minPage: 24, maxPage: 75, weight: 52 },
  { country: "JP", minPage: 10, maxPage: 39, weight: 30 },
  { country: "PH", minPage: 9, maxPage: 36, weight: 28 },
  { country: "ID", minPage: 7, maxPage: 30, weight: 24 },
  { country: "RU", minPage: 9, maxPage: 31, weight: 23 },
  { country: "VN", minPage: 10, maxPage: 31, weight: 22 },
  { country: "CL", minPage: 6, maxPage: 25, weight: 20 },
  { country: "MX", minPage: 6, maxPage: 25, weight: 20 },
  { country: "BR", minPage: 7, maxPage: 25, weight: 19 },
  { country: "AR", minPage: 5, maxPage: 21, weight: 17 },
  { country: "TW", minPage: 5, maxPage: 20, weight: 16 },
  { country: "CA", minPage: 6, maxPage: 21, weight: 16 },
  { country: "GB", minPage: 6, maxPage: 20, weight: 15 },
  { country: "TH", minPage: 6, maxPage: 19, weight: 14 },
  { country: "MY", minPage: 5, maxPage: 16, weight: 12 },
  { country: "FR", minPage: 3, maxPage: 13, weight: 11 },
  { country: "PL", minPage: 3, maxPage: 12, weight: 10 },
  { country: "HK", minPage: 4, maxPage: 13, weight: 10 },
  { country: "AU", minPage: 3, maxPage: 12, weight: 10 },
  { country: "DE", minPage: 3, maxPage: 11, weight: 9 },
  { country: "ES", minPage: 3, maxPage: 11, weight: 9 },
  { country: "SG", minPage: 4, maxPage: 10, weight: 7 },
];

export interface PackRankBand {
  minRank: number;
  maxRank: number;
  weight: number;
}

// Fallback-only (no server): one entry per card slot, in reveal order.
// Early slots draw from deep ranks (bands past MAX_PACK_RANK resolve through
// the country pool), the last slot is the pack's "hit" with a small chance
// at the very top. Card tiers are still computed from the player's real
// scores - these bands only shape which players land in a pack.
export const PACK_SLOT_BANDS: PackRankBand[][] = [
  [{ minRank: DEEP_MIN_RANK, maxRank: DEEP_MAX_RANK, weight: 1 }],
  [
    { minRank: DEEP_MIN_RANK, maxRank: DEEP_MAX_RANK, weight: 3 },
    { minRank: 2001, maxRank: MAX_PACK_RANK, weight: 2 },
  ],
  [
    { minRank: 1001, maxRank: 6000, weight: 4 },
    { minRank: 501, maxRank: 1000, weight: 1 },
  ],
  [
    { minRank: 301, maxRank: 1500, weight: 7 },
    { minRank: 101, maxRank: 300, weight: 3 },
  ],
  [
    { minRank: 76, maxRank: 300, weight: 50 },
    { minRank: 21, maxRank: 75, weight: 30 },
    { minRank: 4, maxRank: 20, weight: 16 },
    { minRank: 1, maxRank: 3, weight: 4 },
  ],
];

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
}

export function pickPackBand(bands: PackRankBand[], rng: () => number): PackRankBand {
  const totalWeight = bands.reduce((sum, band) => sum + band.weight, 0);
  let roll = rng() * totalWeight;
  for (const band of bands) {
    roll -= band.weight;
    if (roll < 0) return band;
  }
  return bands[bands.length - 1];
}

export function rollRanksFromBands(slotBands: PackRankBand[][], rng: () => number = Math.random): number[] {
  return slotBands.map((bands) => {
    const band = pickPackBand(bands, rng);
    const span = band.maxRank - band.minRank + 1;
    return band.minRank + Math.min(span - 1, Math.floor(rng() * span));
  });
}

/* Slot bands for an arbitrary pack size. Smaller packs keep the later
   (stronger) slots; larger packs pad with extra copies of the deepest slot,
   so the reveal still builds toward the same single hit at the end. */
export function packSlotBandsForCount(count: number): PackRankBand[][] {
  const size = Math.max(1, Math.round(count));
  if (size === PACK_SLOT_BANDS.length) return PACK_SLOT_BANDS;
  if (size < PACK_SLOT_BANDS.length) return PACK_SLOT_BANDS.slice(PACK_SLOT_BANDS.length - size);
  const extra = size - PACK_SLOT_BANDS.length;
  return [...Array.from({ length: extra }, () => PACK_SLOT_BANDS[0]), ...PACK_SLOT_BANDS];
}

export function rollPackRanks(rng: () => number = Math.random, count: number = PACK_SIZE): number[] {
  return rollRanksFromBands(packSlotBandsForCount(count), rng);
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
     on the server (the packs pool with ?keys=), so these packs never degrade
     to the direct osu! rankings draw, which cannot tell mains apart. */
  keys?: 4 | 7;
  /* Cards dealt per pack. */
  cardCount: number;
  /* Replaces owned pulls with unowned cards from the same slice when possible. */
  guaranteesNew?: boolean;
  /* Probability (0-1) that one slot in the pack is replaced by a random
     honorary player. They are absent from the ranked pool by design (see
     honorary-players.ts), so this is the only way to pull them. */
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
  // top slice, priced between Wild and Elite because what they sell is
  // targeting, not card quality - within their pool every player still has
  // identical odds and rarity still comes from real scores.
  {
    id: "4k",
    name: "4K",
    cost: { kind: "shards", amount: 60 },
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
    cost: { kind: "shards", amount: 100 },
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
    cost: { kind: "shards", amount: 250 },
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

export function isDeepRank(rank: number): boolean {
  return rank > MAX_PACK_RANK;
}

export function pickDeepCountry(
  rng: () => number = Math.random,
  pool: DeepCountryWindow[] = DEEP_COUNTRY_POOL,
): DeepCountryWindow {
  const totalWeight = pool.reduce((sum, window) => sum + window.weight, 0);
  let roll = rng() * totalWeight;
  for (const window of pool) {
    roll -= window.weight;
    if (roll < 0) return window;
  }
  return pool[pool.length - 1];
}

export type RankingsFetcher = (page: number, country?: string) => Promise<LeanRankingEntry[]>;

const fetchRankingEntries: RankingsFetcher = async (page, country) => {
  const response = await getRankings({ data: { type: "performance", page, country } });
  return response?.ranking ?? [];
};

/* Draws one player from the deep band (10k-50k global) via a random page of
   a random country leaderboard. Picks only rows whose actual global_rank is
   in band, so window drift or API surprises can't leak out-of-band players;
   a dry pool returns null and the caller falls back to a top-10k roll. */
export async function drawDeepPackEntry(
  rng: () => number,
  usedUserIds: Set<number>,
  fetcher: RankingsFetcher = fetchRankingEntries,
  attempts = 3,
): Promise<LeanRankingEntry | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const window = pickDeepCountry(rng);
    const page = window.minPage + Math.floor(rng() * (window.maxPage - window.minPage + 1));
    let rows: LeanRankingEntry[];
    try {
      rows = await fetcher(page, window.country);
    } catch {
      continue;
    }
    const candidates = rows.filter(
      (entry) =>
        entry.global_rank >= DEEP_MIN_RANK &&
        entry.global_rank <= DEEP_MAX_RANK &&
        !usedUserIds.has(entry.user.id),
    );
    if (candidates.length === 0) continue;
    const pick = candidates[Math.floor(rng() * candidates.length)];
    usedUserIds.add(pick.user.id);
    return pick;
  }
  return null;
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

export function toPackPlayer(entry: LeanRankingEntry): PackPlayer {
  return {
    user: {
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
      country_code: entry.user.country_code,
      statistics: { global_rank: entry.global_rank, pp: entry.pp },
    },
    globalRank: entry.global_rank,
    pp: entry.pp,
  };
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

export interface PackDrawOptions {
  /* Draw from the pool's top slice instead of the whole pool (1 = all). */
  topFraction?: number;
  /* Draw only players whose main keymode this is (server-filtered pool).
     Implies poolOnly: the direct osu! rankings fallback cannot honour it. */
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
  /* Fail instead of degrading to the direct osu! rankings draw when the
     tracked pool is unavailable.

     The fallback is right for a pack (the viewer paid a charge and is owed
     cards), but it is not free: for a draw bigger than PACK_SLOT_BANDS it pads
     with deep-rank slots, and every deep rank spends osu! API calls on country
     ranking pages. Callers dealing throwaway cards - a duel deck, which never
     enters a collection - would rather show an error than spend the budget. */
  poolOnly?: boolean;
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
    globalRank: player.peakRank ?? MAX_PACK_RANK,
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
  const fetchPoolPage = fetchPage ?? poolPageFetcherFor(options.keys);
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

export async function drawPackPlayers(
  rng: () => number = Math.random,
  options: PackDrawOptions = {},
): Promise<PackDraw> {
  const needsDuplicateProtection = Boolean(options.ownedUserIds && options.ownedUserIds.size > 0);
  // A keymode draw is pool-only whether asked or not: the fallback would deal
  // players of any keymode into a pack that promised one.
  const poolOnly = Boolean(options.poolOnly) || options.keys != null;
  if (isLiveBackendConfigured()) {
    try {
      return await drawPackPlayersFromPool(rng, undefined, options);
    } catch (error) {
      if (needsDuplicateProtection) throw new Error("Duplicate-protected packs require the tracked player pool.");
      if (poolOnly) throw error;
      // Backend hiccup: degrade to the direct osu! rankings draw below.
    }
  }
  if (needsDuplicateProtection) throw new Error("Duplicate-protected packs require the tracked player pool.");
  if (poolOnly) throw new Error("This draw requires the tracked player pool.");
  const players = await drawPackPlayersFromOsuApi(rng, options.count ?? PACK_SIZE);
  return {
    players: applyHonoraryHit(
      players,
      rng,
      options.honoraryChance ?? 0,
      options.ownedGoatUserIds,
      options.honoraryCascadeChance ?? 0,
    ),
    poolTotal: null,
  };
}

export async function drawPackPlayersFromOsuApi(
  rng: () => number = Math.random,
  count: number = PACK_SIZE,
): Promise<PackPlayer[]> {
  const ranks = rollPackRanks(rng, count);
  const usedUserIds = new Set<number>();
  const deepEntries: LeanRankingEntry[] = [];
  const normalRanks: number[] = [];
  for (const rank of ranks) {
    if (!isDeepRank(rank)) {
      normalRanks.push(rank);
      continue;
    }
    const entry = await drawDeepPackEntry(rng, usedUserIds);
    if (entry) deepEntries.push(entry);
    // Deep pool came up dry (API hiccup or drifted windows): trade the slot
    // for a top-10k roll instead of failing the pack.
    else normalRanks.push(2001 + Math.floor(rng() * (MAX_PACK_RANK - 2000)));
  }
  const pages = [...new Set(normalRanks.map(rankToPage))];
  const responses = await Promise.all(
    pages.map((page) => getRankings({ data: { type: "performance", page } })),
  );
  const pagesByNumber = new Map(pages.map((page, index) => [page, responses[index]?.ranking ?? []]));
  const entries = [...deepEntries, ...pickPackEntries(normalRanks, pagesByNumber, rng, usedUserIds)];
  if (entries.length === 0) throw new Error("No players available for this pack.");
  return sortIntoRevealOrder(entries.map(toPackPlayer));
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
