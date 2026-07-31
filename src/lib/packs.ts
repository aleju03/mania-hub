import {
  fetchLiveGlobalRankings,
  fetchLivePackCardSnapshotDirect,
  fetchLivePlayerProfileSnapshotDirect,
  isLiveBackendConfigured,
  type LiveGlobalRankingEntry,
} from "./live-backend";
import { getRankings, getUserScoresBestWindow } from "./osu";
import type { LeanRankingEntry, OsuScore } from "./types";

/* Default cards per pack; pack types override via cardCount. */
export const PACK_SIZE = 5;

// Packs draw from the server's tracked-player pool (the global
// rankings snapshot, ~6k players whose data the backend already stores), so
// opening a pack costs local DB reads instead of osu! API calls. The direct
// osu! rankings path further down is the fallback when no server is
// configured or the pool draw fails.

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
export type PackTypeId = "standard" | "wild" | "elite" | "legend";

export type PackCost = { kind: "charge" } | { kind: "shards"; amount: number };

export interface PackTypeDef {
  id: PackTypeId;
  name: string;
  /* Subtitle line on the foil art, e.g. "ELITE PACK". */
  artSubtitle: string;
  cost: PackCost;
  /* Slice of the pool this pack draws from (1 = the whole pool). */
  topFraction: number;
  /* Cards dealt per pack. */
  cardCount: number;
  /* Replaces owned pulls with unowned cards from the same slice when possible. */
  guaranteesNew?: boolean;
  blurb: string;
  accent: { r: number; g: number; b: number };
}

export const PACK_TYPES: PackTypeDef[] = [
  {
    id: "standard",
    name: "Standard",
    artSubtitle: "BOOSTER PACK",
    cost: { kind: "charge" },
    topFraction: 1,
    cardCount: PACK_SIZE,
    blurb: "Every tracked player, same odds",
    accent: { r: 167, g: 139, b: 250 },
  },
  {
    id: "wild",
    name: "Wild",
    artSubtitle: "WILD PACK",
    // The volume pack: double the cards, priced under 2x the old 5-card
    // rate so bulk stays the draw.
    cost: { kind: "shards", amount: 14 },
    topFraction: 1,
    cardCount: 10,
    guaranteesNew: true,
    blurb: "Whole pool, new cards first",
    accent: { r: 52, g: 211, b: 153 },
  },
  {
    id: "elite",
    name: "Elite",
    artSubtitle: "ELITE PACK",
    // Premium tiers are deliberately steep: shards flow constantly from
    // opened packs and recycling, so cheap top-slice packs made the whole
    // ladder trivial to skip.
    cost: { kind: "shards", amount: 100 },
    topFraction: 0.1,
    cardCount: 7,
    guaranteesNew: true,
    blurb: "Top 10%, new cards first",
    accent: { r: 251, g: 191, b: 36 },
  },
  {
    id: "legend",
    name: "Legend",
    artSubtitle: "LEGEND PACK",
    cost: { kind: "shards", amount: 250 },
    topFraction: 0.02,
    cardCount: PACK_SIZE,
    guaranteesNew: true,
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

const defaultPoolPageFetcher: PoolPageFetcher = async (page) => {
  const snapshot = await fetchLiveGlobalRankings({
    page,
    pageSize: RANKINGS_PAGE_SIZE,
    sort: "rank",
    dir: "desc",
  });
  return { ranking: snapshot.ranking, total: snapshot.total };
};

export interface PackDrawOptions {
  /* Draw from the pool's top slice instead of the whole pool (1 = all). */
  topFraction?: number;
  /* Cards to draw (defaults to PACK_SIZE). */
  count?: number;
  /* Collected card ids. When set, every owned slot is replaced with an
     unowned player from the same draw slice when one exists. Near-complete
     collections keep only the repeats that have no unowned replacement. */
  ownedUserIds?: ReadonlySet<number>;
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
  );
  for (const page of missingPages) {
    if (replacements.length >= ownedIndexes.length) break;
    const response = page === 1 ? head : await fetchPage(page);
    pagesByNumber.set(page, response.ranking);
    replacements.push(
      ...pickUnownedPoolEntries(
        [response.ranking],
        drawTotal,
        ownedUserIds,
        used,
        ownedIndexes.length - replacements.length,
        rng,
      ),
    );
  }

  for (let replacementIndex = 0; replacementIndex < replacements.length; replacementIndex += 1) {
    entries[ownedIndexes[replacementIndex]] = replacements[replacementIndex];
  }
}

export interface PackDraw {
  players: PackPlayer[];
  poolTotal: number | null;
}

/* Primary draw: the server's tracked-player pool. Free of osu! API
   calls - the global rankings snapshot is a local DB read on the backend.
   Draws uniformly over the whole pool, or over its top slice for the
   shard-bought pack types. */
export async function drawPackPlayersFromPool(
  rng: () => number = Math.random,
  fetchPage: PoolPageFetcher = defaultPoolPageFetcher,
  options: PackDrawOptions = {},
): Promise<PackDraw> {
  const head = await fetchPage(1);
  const total = Math.max(head.total, head.ranking.length);
  if (total < 100) throw new Error("Tracked player pool is too small for packs.");
  const drawTotal = poolSliceSize(total, options.topFraction ?? 1);
  const positions = rollUniformPositions(drawTotal, options.count ?? PACK_SIZE, rng);
  const pages = [...new Set(positions.map(rankToPage))];
  const responses = await Promise.all(
    pages.map(async (page) => (page === 1 ? head : await fetchPage(page))),
  );
  const pagesByNumber = new Map(pages.map((page, index) => [page, responses[index]?.ranking ?? []]));
  const entries = pickPackEntries(positions, pagesByNumber, rng);
  if (entries.length === 0) throw new Error("No players available for this pack.");

  if (options.ownedUserIds && options.ownedUserIds.size > 0) {
    await replaceOwnedPoolEntries(entries, pagesByNumber, head, fetchPage, drawTotal, options.ownedUserIds, rng);
  }

  return { players: sortIntoRevealOrder(entries.map(liveEntryToPackPlayer)), poolTotal: total };
}

export async function drawPackPlayers(
  rng: () => number = Math.random,
  options: PackDrawOptions = {},
): Promise<PackDraw> {
  const needsDuplicateProtection = Boolean(options.ownedUserIds && options.ownedUserIds.size > 0);
  if (isLiveBackendConfigured()) {
    try {
      return await drawPackPlayersFromPool(rng, defaultPoolPageFetcher, options);
    } catch {
      if (needsDuplicateProtection) throw new Error("Duplicate-protected packs require the tracked player pool.");
      // Backend hiccup: degrade to the direct osu! rankings draw below.
    }
  }
  if (needsDuplicateProtection) throw new Error("Duplicate-protected packs require the tracked player pool.");
  return { players: await drawPackPlayersFromOsuApi(rng, options.count ?? PACK_SIZE), poolTotal: null };
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

export async function fetchPackPlayerScores(userId: number): Promise<OsuScore[]> {
  if (isLiveBackendConfigured()) {
    try {
      // Stored best scores (profile snapshot or the user_top_scores
      // projection): a pure DB read on the backend, so a card flips
      // instantly for any player the backend has ever fetched. Staleness is
      // fine for minting a card, and the deal-time warm refreshes cold or
      // expired players in the background anyway. The card view trims each
      // score to the fields the maniacard reads, roughly a tenth of the
      // full snapshot payload.
      const cached = await fetchLivePackCardSnapshotDirect(String(userId));
      if (cached && Array.isArray(cached.bestScores) && cached.bestScores.length > 0) {
        return cached.bestScores;
      }
    } catch {
      // Fall through to the blocking snapshot fetch below.
    }
    try {
      // Truly cold player: this waits on the backend's live osu! fetch, but
      // coalesces with the deal-time warm's in-flight request for the same
      // player. An EMPTY bestScores list falls through to the direct osu!
      // window - it usually means the player's plays were never fetched, and
      // returning it would mint a blank card.
      const snapshot = await fetchLivePlayerProfileSnapshotDirect(String(userId));
      if (snapshot && Array.isArray(snapshot.bestScores) && snapshot.bestScores.length > 0) {
        return snapshot.bestScores;
      }
    } catch {
      // Backend hiccup: degrade to the direct osu! API window below.
    }
  }
  return getUserScoresBestWindow({ data: { userId, totalLimit: 200, parallel: true } });
}

/* How many pack card prefetches run at once. Warm players cost one backend DB
   read each, but a truly cold player falls through to the blocking /snapshot
   endpoint and direct osu! fetches, and the cached endpoint can itself kick
   off a background warm, so the fan-out stays bounded to protect the osu! API
   budget instead of going fully parallel. */
export const PACK_SCORE_PREFETCH_CONCURRENCY = 4;

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
