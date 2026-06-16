import {
  fetchLiveGlobalRankings,
  fetchLivePlayerProfileSnapshotDirect,
  isLiveBackendConfigured,
  type LiveGlobalRankingEntry,
} from "./live-backend";
import { getRankings, getUserScoresBestWindow } from "./osu";
import type { LeanRankingEntry, OsuScore } from "./types";

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

export function rollPackRanks(rng: () => number = Math.random): number[] {
  return rollRanksFromBands(PACK_SLOT_BANDS, rng);
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
  /* Re-rolls the draw so at least one card is outside the collection. */
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
    blurb: "Every tracked player, same odds",
    accent: { r: 167, g: 139, b: 250 },
  },
  {
    id: "wild",
    name: "Wild",
    artSubtitle: "WILD PACK",
    cost: { kind: "shards", amount: 8 },
    topFraction: 1,
    guaranteesNew: true,
    blurb: "Whole pool, at least one card you don't own",
    accent: { r: 52, g: 211, b: 153 },
  },
  {
    id: "elite",
    name: "Elite",
    artSubtitle: "ELITE PACK",
    cost: { kind: "shards", amount: 25 },
    topFraction: 0.1,
    blurb: "Top 10% of the pool",
    accent: { r: 251, g: 191, b: 36 },
  },
  {
    id: "legend",
    name: "Legend",
    artSubtitle: "LEGEND PACK",
    cost: { kind: "shards", amount: 60 },
    topFraction: 0.02,
    blurb: "Top 2% of the pool",
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
  /* Collected card ids. When set, a draw made up entirely of owned players
     swaps its weakest slot for an unowned one (the wild pack's guarantee).
     Best-effort: a near-complete collection can exhaust the re-roll budget. */
  ownedUserIds?: ReadonlySet<number>;
}

/* Extra page rolls allowed while hunting an unowned player for the wild
   guarantee, after the already-fetched pages come up empty. */
export const UNOWNED_DRAW_ATTEMPTS = 6;

/* Picks a random player from the given pool pages who is inside the draw
   slice and outside both the owned set and the current pack. */
export function pickUnownedPoolEntry(
  pages: Iterable<LiveGlobalRankingEntry[]>,
  drawTotal: number,
  ownedUserIds: ReadonlySet<number>,
  usedUserIds: ReadonlySet<number>,
  rng: () => number,
): LiveGlobalRankingEntry | null {
  const candidates: LiveGlobalRankingEntry[] = [];
  for (const page of pages) {
    for (const entry of page) {
      if (entry.rank <= drawTotal && !ownedUserIds.has(entry.user.id) && !usedUserIds.has(entry.user.id)) {
        candidates.push(entry);
      }
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
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
  const positions = rollUniformPositions(drawTotal, PACK_SIZE, rng);
  const pages = [...new Set(positions.map(rankToPage))];
  const responses = await Promise.all(
    pages.map(async (page) => (page === 1 ? head : await fetchPage(page))),
  );
  const pagesByNumber = new Map(pages.map((page, index) => [page, responses[index]?.ranking ?? []]));
  const entries = pickPackEntries(positions, pagesByNumber, rng);
  if (entries.length === 0) throw new Error("No players available for this pack.");

  const owned = options.ownedUserIds;
  if (owned && owned.size > 0 && entries.every((entry) => owned.has(entry.user.id))) {
    const used = new Set(entries.map((entry) => entry.user.id));
    let replacement = pickUnownedPoolEntry(pagesByNumber.values(), drawTotal, owned, used, rng);
    for (let attempt = 0; !replacement && attempt < UNOWNED_DRAW_ATTEMPTS; attempt += 1) {
      const page = rankToPage(rollUniformPositions(drawTotal, 1, rng)[0]);
      if (pagesByNumber.has(page)) continue;
      const response = page === 1 ? head : await fetchPage(page);
      pagesByNumber.set(page, response.ranking);
      replacement = pickUnownedPoolEntry([response.ranking], drawTotal, owned, used, rng);
    }
    if (replacement) {
      // Swap out the weakest pull so the guarantee never costs the pack's hit.
      const rankOf = (entry: LiveGlobalRankingEntry) => entry.global_rank ?? entry.rank;
      let weakest = 0;
      for (let index = 1; index < entries.length; index += 1) {
        if (rankOf(entries[index]) > rankOf(entries[weakest])) weakest = index;
      }
      entries[weakest] = replacement;
    }
  }

  return { players: sortIntoRevealOrder(entries.map(liveEntryToPackPlayer)), poolTotal: total };
}

export async function drawPackPlayers(
  rng: () => number = Math.random,
  options: PackDrawOptions = {},
): Promise<PackDraw> {
  if (isLiveBackendConfigured()) {
    try {
      return await drawPackPlayersFromPool(rng, defaultPoolPageFetcher, options);
    } catch {
      // Backend hiccup: degrade to the direct osu! rankings draw below.
    }
  }
  return { players: await drawPackPlayersFromOsuApi(rng), poolTotal: null };
}

export async function drawPackPlayersFromOsuApi(rng: () => number = Math.random): Promise<PackPlayer[]> {
  const ranks = rollPackRanks(rng);
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
      // Best scores from the backend's profile snapshot (24h cache); the
      // same data the profile maniacard tab renders from. An EMPTY cached
      // list falls through to the live window - it usually means the
      // snapshot was computed before the player's plays were fetched, and
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
