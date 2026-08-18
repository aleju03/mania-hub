import type { Db } from "../db.js";
import { exec } from "../db.js";
import { getPackPoolMembership } from "./global-rankings.js";
import { getPackShowcase, HONORARY_USER_IDS, type StoredPackCard } from "./pack-wallets.js";

/* The community read of the pack economy, behind /packs/collections.
 *
 * Everything here reads the same durable projections the private surfaces use
 * (pack_collection_cards, pack_wallets, pack_card_serials), grouped by
 * collector instead of filtered to one. Nothing writes, so every call runs on
 * ctx.db.
 *
 * The shape of this module is set by one number: pack_collection_cards is
 * millions of rows, and grouping it is a full scan. So the scans happen on a
 * timer, into a snapshot of every collector, and the boards, the directory and
 * one collector's ranks are all derived from that array in JS. The first cut
 * asked SQL each question separately - a query per board, each re-grouping the
 * whole table, with correlated subqueries per collector for the name and the
 * first-find count - and took 28 seconds against the production snapshot.
 * Reading the table a few times and sorting an array of a couple of thousand
 * entries is the same answer for a fraction of the work.
 *
 * The one query that still costs is the per-owner pool ratio, and it is asked
 * backwards for that reason: see the off-pool note in buildCollectorSnapshot.
 *
 * A collector's own cards stay in SQL (listPackCollectionCards), since that is
 * a paged read of one collector at a time. */

/* A collector as every board and the directory names them. `tracked` is
   whether the backend has a users row: an untracked collector still holds
   cards (the wallet's frozen name carries them), they just have no country and
   no live avatar. */
export interface PackCollectorIdentity {
  userId: number;
  username: string;
  countryCode: string | null;
  avatarUrl: string;
  tracked: boolean;
}

/* How far a collector is through the two sets that can actually be completed:
   the live draw pool and the honorary roster. Everything else in a collection
   is unbounded. */
export interface PackCollectorCompletion {
  poolTotal: number;
  poolOwnedCount: number;
  goatsOwned: number;
  goatsTotal: number;
}

export interface PackCollectorSummary extends PackCollectorIdentity {
  /* Cards is holdings (a player's GOAT and their ordinary card are two), while
     players is the distinct people on the shelf. The pool ratio is measured in
     players, so both are kept rather than derived from each other. */
  cards: number;
  players: number;
  copies: number;
  goats: number;
  duplicates: number;
  recycled: number;
  firstFinds: number;
  /* Null on a wallet that predates the banked open count, which is not the
     same as zero and must not be shown as one. */
  packsOpened: number | null;
  joinedAt: number;
  lastPulledAt: number;
  completion: PackCollectorCompletion;
}

export interface PackCommunityCard {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  owners: number;
  copies: number;
  /* How many collectors have ever held this card, from the mint registry.
     Unlike `owners` this survives recycling, so it is what "hard to find"
     is measured on. */
  mintedTotal: number;
}

export interface PackCommunityTotals {
  collectors: number;
  packsOpened: number;
  cardsMinted: number;
  distinctHoldings: number;
  playersCarded: number;
  goatCardsMinted: number;
  cardsRecycled: number;
  poolTotal: number;
  goatRosterSize: number;
  /* When the oldest surviving holding was pulled: how long the game has been
     running, as the collection rows remember it. */
  firstPullAt: number | null;
  /* Copies in circulation per tier, keyed by the stored tier name ("unrated"
     for a holding that was never labelled). How thin the top of the rarity
     table really is, which is the one thing a collector cannot work out from
     their own shelf. */
  tierCopies: Record<string, number>;
  /* Players exactly one collection holds. */
  oneOfAKind: number;
}

export interface PackCommunityBoards {
  packsOpened: PackCollectorSummary[];
  biggestCollections: PackCollectorSummary[];
  goatHolders: PackCollectorSummary[];
  firstFinds: PackCollectorSummary[];
  longestStanding: PackCollectorSummary[];
  completion: PackCollectorSummary[];
  rarestCards: PackCommunityCard[];
  mostOwnedCards: PackCommunityCard[];
}

export interface PackCommunityStats {
  totals: PackCommunityTotals;
  boards: PackCommunityBoards;
  computedAt: number;
}

export interface PackCollectorDirectoryPage {
  collectors: PackCollectorSummary[];
  total: number;
}

export interface PackCollectorProfile {
  collector: PackCollectorSummary;
  completion: PackCollectorCompletion;
  showcase: StoredPackCard[];
  /* Where this collector stands on the two boards people ask about. Read off
     the same ordering the boards use, so a printed rank and a board position
     cannot disagree. */
  ranks: { cards: number; packsOpened: number | null };
}

export const PACK_COMMUNITY_BOARD_SIZE = 10;
export const PACK_COLLECTOR_PAGE_MAX_SIZE = 60;

/* Two lifetimes, because the reads behind them cost very different amounts.
   The collector roll-up runs off a covering index and takes about two seconds
   against the production snapshot; the per-card owner counts cannot use one
   (owner_user_id is not in the card index, so every row is a lookup) and take
   about three. The card facts also move far more slowly than a collection
   does: which players almost nobody holds is not a thing that changes between
   two visits. So the collectors refresh on a couple of minutes and the cards
   on half an hour, rather than paying both bills on the same clock. */
const COLLECTOR_TTL_MS = 2 * 60_000;
const CARD_TTL_MS = 30 * 60_000;

export type PackCollectorSort = "cards" | "copies" | "packs" | "goats" | "recent";

/* One comparator per sort, used by both the directory and the boards so a
   collector's position is the same wherever they are printed. */
const COMPARATORS: Record<PackCollectorSort, (a: PackCollectorSummary, b: PackCollectorSummary) => number> = {
  cards: (a, b) => b.cards - a.cards || b.copies - a.copies || a.joinedAt - b.joinedAt,
  copies: (a, b) => b.copies - a.copies || b.cards - a.cards || a.joinedAt - b.joinedAt,
  packs: (a, b) => (b.packsOpened ?? -1) - (a.packsOpened ?? -1) || b.cards - a.cards || a.joinedAt - b.joinedAt,
  goats: (a, b) => b.goats - a.goats || b.cards - a.cards || a.joinedAt - b.joinedAt,
  recent: (a, b) => b.lastPulledAt - a.lastPulledAt || b.cards - a.cards,
};

/* hasOwn, not `raw in COMPARATORS`: an inherited key ("toString",
   "constructor") would otherwise pass the check and hand a function to the
   sort. Same trap TIER_RANKS documents in pack-wallets. */
export function normalizePackCollectorSort(raw: unknown): PackCollectorSort {
  return typeof raw === "string" && Object.hasOwn(COMPARATORS, raw) ? (raw as PackCollectorSort) : "cards";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/* Ids inlined rather than bound, the way cardUserIdRestrictionSql does it in
   pack-wallets: these lists run to thousands of entries and would trip the
   bound parameter limit. Every id is a validated integer, so there is nothing
   here for a caller to inject even if one could reach it. */
function idListSql(ids: Iterable<number>): string {
  const safe = [...ids].filter((id) => Number.isInteger(id) && id > 0);
  return safe.length > 0 ? safe.join(",") : "-1";
}

const HONORARY_ID_LIST = idListSql(HONORARY_USER_IDS);

interface CollectorSnapshot {
  collectors: PackCollectorSummary[];
  byUserId: Map<number, PackCollectorSummary>;
  /* Pre-sorted once so the directory, the boards and a collector's rank all
     read the same order without re-sorting per request. */
  ordered: Record<PackCollectorSort, PackCollectorSummary[]>;
  packsOpenedTotal: number;
  tierCopies: Record<string, number>;
  poolTotal: number;
  computedAt: number;
}

interface CardSnapshot {
  playersCarded: number;
  oneOfAKind: number;
  rarestCards: PackCommunityCard[];
  mostOwnedCards: PackCommunityCard[];
  computedAt: number;
}

async function buildCollectorSnapshot(db: Db, now: number): Promise<CollectorSnapshot> {
  /* A pool board that cannot build right now must not take the page down with
     it: the completion numbers go to zero and everything else still answers. */
  const pool = await getPackPoolMembership(db).catch(() => null);

  /* Which carded players are outside the draw pool, read off the card catalog
     (one row per variant, thousands of rows) rather than off the ownership
     table (millions). This is the small half of the split: almost every carded
     player is still pullable, so asking "how many of your cards are NOT in the
     pool" touches a fraction of the rows that asking the other way around
     does. The counts below subtract it from the collector's distinct players.
     Reading it from the catalog can only over-list, naming a player whose last
     copy was recycled, and an id nobody holds matches nothing. */
  const offPoolIds: number[] = [];
  if (pool && pool.total > 0) {
    const catalog = (await exec(db, "select distinct card_user_id from pack_cards")).rows;
    for (const row of catalog) {
      const cardUserId = Number(row.card_user_id);
      if (cardUserId > 0 && !pool.userIds.has(cardUserId)) offPoolIds.push(cardUserId);
    }
  }

  const [holdingRows, firstFindRows, walletRows, tierRows, offPoolRows] = await Promise.all([
    exec(db, `
      select owner_user_id,
        count(*) as cards,
        count(distinct card_user_id) as players,
        coalesce(sum(copies), 0) as copies,
        coalesce(sum(case when copies > 1 then copies - 1 else 0 end), 0) as duplicates,
        coalesce(sum(recycled_copies), 0) as recycled,
        sum(case when card_key like '%:goat' and card_user_id in (${HONORARY_ID_LIST}) then 1 else 0 end) as goats,
        min(case when first_pulled_at > 0 then first_pulled_at else null end) as joined_at,
        max(last_pulled_at) as last_pulled_at
      from pack_collection_cards
      where copies > 0
      group by owner_user_id`),
    // Serial 1 is whoever found the card first, anywhere.
    exec(db, "select owner_user_id, count(*) as finds from pack_card_serials where serial = 1 group by owner_user_id"),
    exec(db, "select user_id, owner_username, json_extract(payload, '$.openedPacks') as opened from pack_wallets"),
    exec(db, `
      select coalesce(nullif(tier, ''), 'unrated') as tier, coalesce(sum(copies), 0) as copies
      from pack_collection_cards where copies > 0 group by coalesce(nullif(tier, ''), 'unrated')`),
    offPoolIds.length > 0
      ? exec(db, `
          select owner_user_id, count(distinct card_user_id) as off_pool
          from pack_collection_cards
          where copies > 0 and card_user_id in (${idListSql(offPoolIds)})
          group by owner_user_id`)
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
  ]);

  const firstFinds = new Map<number, number>();
  for (const row of firstFindRows.rows) firstFinds.set(Number(row.owner_user_id), Number(row.finds) || 0);

  const offPool = new Map<number, number>();
  for (const row of offPoolRows.rows) offPool.set(Number(row.owner_user_id), Number(row.off_pool) || 0);

  const frozenNames = new Map<number, string>();
  const openedPacks = new Map<number, number | null>();
  let packsOpenedTotal = 0;
  for (const row of walletRows.rows) {
    const userId = Number(row.user_id);
    const frozen = nonEmptyString(row.owner_username);
    if (frozen) frozenNames.set(userId, frozen);
    const opened = row.opened === null || row.opened === undefined
      ? null
      : Math.max(0, Math.floor(Number(row.opened) || 0));
    openedPacks.set(userId, opened);
    packsOpenedTotal += opened ?? 0;
  }

  const identities = await readOwnerIdentities(db, holdingRows.rows.map((row) => Number(row.owner_user_id)));

  const collectors: PackCollectorSummary[] = holdingRows.rows.map((row) => {
    const userId = Number(row.owner_user_id);
    const identity = identities.get(userId);
    const players = Number(row.players) || 0;
    const goats = Number(row.goats) || 0;
    return {
      userId,
      username: identity?.username ?? frozenNames.get(userId) ?? `user ${userId}`,
      countryCode: identity?.countryCode ?? null,
      // An untracked collector has no stored avatar; osu! serves one for any id.
      avatarUrl: identity?.avatarUrl ?? `https://a.ppy.sh/${userId}`,
      tracked: Boolean(identity),
      cards: Number(row.cards) || 0,
      players,
      copies: Number(row.copies) || 0,
      goats,
      duplicates: Number(row.duplicates) || 0,
      recycled: Number(row.recycled) || 0,
      firstFinds: firstFinds.get(userId) ?? 0,
      packsOpened: openedPacks.get(userId) ?? null,
      joinedAt: Number(row.joined_at) || 0,
      lastPulledAt: Number(row.last_pulled_at) || 0,
      completion: {
        poolTotal: pool?.total ?? 0,
        // Everything owned, less the part of it that fell out of the pool.
        poolOwnedCount: pool && pool.total > 0 ? Math.max(0, players - (offPool.get(userId) ?? 0)) : 0,
        goatsOwned: goats,
        goatsTotal: HONORARY_USER_IDS.size,
      },
    };
  });

  const tierCopies: Record<string, number> = {};
  for (const row of tierRows.rows) tierCopies[String(row.tier)] = Number(row.copies) || 0;

  return {
    collectors,
    byUserId: new Map(collectors.map((collector) => [collector.userId, collector])),
    ordered: {
      cards: [...collectors].sort(COMPARATORS.cards),
      copies: [...collectors].sort(COMPARATORS.copies),
      packs: [...collectors].sort(COMPARATORS.packs),
      goats: [...collectors].sort(COMPARATORS.goats),
      recent: [...collectors].sort(COMPARATORS.recent),
    },
    packsOpenedTotal,
    tierCopies,
    poolTotal: pool?.total ?? 0,
    computedAt: now,
  };
}

async function buildCardSnapshot(db: Db, now: number): Promise<CardSnapshot> {
  const rows = (await exec(db, `
    select card_user_id, count(distinct owner_user_id) as owners, coalesce(sum(copies), 0) as copies
    from pack_collection_cards where copies > 0 group by card_user_id`)).rows;
  const cards = rows.map((row) => ({
    userId: Number(row.card_user_id),
    owners: Number(row.owners) || 0,
    copies: Number(row.copies) || 0,
  }));

  /* Hardest to find is partly the mint registry's question, not the shelf
     count's: `owners` drops when somebody recycles, while a serial is never
     given back. So the shortlist is taken on how few collections hold a card
     and then ordered on how few have ever held it, which puts cards nobody has
     found above cards people found and threw away. Names and mint totals are
     fetched for the two printed slices only. */
  const shortlist = [...cards]
    .sort((a, b) => a.owners - b.owners || a.userId - b.userId)
    .slice(0, PACK_COMMUNITY_BOARD_SIZE * 4);
  const mostOwned = [...cards]
    .sort((a, b) => b.owners - a.owners || b.copies - a.copies)
    .slice(0, PACK_COMMUNITY_BOARD_SIZE);
  const mintedTotals = await readMintedTotals(db, [...shortlist, ...mostOwned].map((card) => card.userId));
  const rarest = shortlist
    .sort((a, b) =>
      a.owners - b.owners ||
      (mintedTotals.get(a.userId) ?? 0) - (mintedTotals.get(b.userId) ?? 0) ||
      a.userId - b.userId)
    .slice(0, PACK_COMMUNITY_BOARD_SIZE);

  return {
    playersCarded: cards.length,
    oneOfAKind: cards.reduce((count, card) => (card.owners === 1 ? count + 1 : count), 0),
    rarestCards: await hydrateCards(db, rarest, mintedTotals),
    mostOwnedCards: await hydrateCards(db, mostOwned, mintedTotals),
    computedAt: now,
  };
}

/* Closest to holding every pullable player first, then the GOAT roster as the
   tie-break, then whoever got there earliest. */
export function orderByCompletion<T extends { completion: PackCollectorCompletion; joinedAt: number }>(
  measured: readonly T[],
): T[] {
  return [...measured].sort((a, b) =>
    b.completion.poolOwnedCount - a.completion.poolOwnedCount ||
    b.completion.goatsOwned - a.completion.goatsOwned ||
    a.joinedAt - b.joinedAt);
}

/* Collector names and faces, in one read per source instead of three
   correlated subqueries per row. The users projection first, then the pull
   log for anyone off every tracked roster; the wallet's frozen name is the
   last fallback and is merged by the caller, which already holds it. */
async function readOwnerIdentities(
  db: Db,
  ownerIds: readonly number[],
): Promise<Map<number, { username: string; countryCode: string | null; avatarUrl: string }>> {
  const identities = new Map<number, { username: string; countryCode: string | null; avatarUrl: string }>();
  if (ownerIds.length === 0) return identities;
  const rows = (await exec(
    db,
    `select user_id, username, avatar_url, country_code from users where user_id in (${idListSql(ownerIds)})`,
  )).rows;
  for (const row of rows) {
    const username = nonEmptyString(row.username);
    if (!username) continue;
    identities.set(Number(row.user_id), {
      username,
      countryCode: nonEmptyString(row.country_code)?.toUpperCase() ?? null,
      avatarUrl: nonEmptyString(row.avatar_url) ?? `https://a.ppy.sh/${Number(row.user_id)}`,
    });
  }
  return identities;
}

async function readMintedTotals(db: Db, cardUserIds: readonly number[]): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  if (cardUserIds.length === 0) return totals;
  const rows = (await exec(
    db,
    `select card_user_id, max(serial) as minted from pack_card_serials
     where card_user_id in (${idListSql(cardUserIds)}) group by card_user_id`,
  )).rows;
  for (const row of rows) totals.set(Number(row.card_user_id), Number(row.minted) || 0);
  return totals;
}

/* The card's face for a board row. Taken from the users projection where the
   player is tracked and from the shared pack_cards catalog otherwise, which is
   the only place a deleted or banned player's card still has a name. */
async function hydrateCards(
  db: Db,
  cards: ReadonlyArray<{ userId: number; owners: number; copies: number }>,
  mintedTotals: Map<number, number>,
): Promise<PackCommunityCard[]> {
  if (cards.length === 0) return [];
  const ids = idListSql(cards.map((card) => card.userId));
  const rows = (await exec(
    db,
    `select card_user_id,
       coalesce(
         (select u.username from users u where u.user_id = faces.card_user_id),
         max(username)
       ) as username,
       coalesce(
         (select u.avatar_url from users u where u.user_id = faces.card_user_id),
         max(avatar_url)
       ) as avatar_url,
       coalesce(
         (select u.country_code from users u where u.user_id = faces.card_user_id),
         max(country_code)
       ) as country_code
     from pack_cards faces
     where card_user_id in (${ids})
     group by card_user_id`,
  )).rows;
  const faces = new Map(rows.map((row) => [Number(row.card_user_id), row]));
  return cards.map((card) => {
    const face = faces.get(card.userId);
    return {
      userId: card.userId,
      username: nonEmptyString(face?.username) ?? `user ${card.userId}`,
      avatarUrl: nonEmptyString(face?.avatar_url) ?? `https://a.ppy.sh/${card.userId}`,
      countryCode: nonEmptyString(face?.country_code)?.toUpperCase() ?? "",
      owners: card.owners,
      copies: card.copies,
      mintedTotal: mintedTotals.get(card.userId) ?? 0,
    };
  });
}

/* One cache per lifetime, each shared by concurrent callers. A stale snapshot
   is served while the next one builds rather than making a second reader wait
   on the scan: this page is a readout of a slow game, and a two-minute-old
   count of somebody's cards is the same answer. Only the very first caller
   after a restart waits for the real thing. */
function cachedSnapshot<T extends { computedAt: number }>(
  build: (db: Db, now: number) => Promise<T>,
  ttlMs: number,
) {
  const cache = new WeakMap<Db, T>();
  const builds = new WeakMap<Db, Promise<T>>();
  return async (db: Db, now: number): Promise<T> => {
    const cached = cache.get(db);
    if (cached && now - cached.computedAt < ttlMs) return cached;
    const inFlight = builds.get(db);
    if (inFlight) return cached ?? inFlight;
    const tracked = build(db, now)
      .then((snapshot) => {
        cache.set(db, snapshot);
        return snapshot;
      })
      .finally(() => {
        builds.delete(db);
      });
    builds.set(db, tracked);
    return cached ?? tracked;
  };
}

const getCollectorSnapshot = cachedSnapshot(buildCollectorSnapshot, COLLECTOR_TTL_MS);
const getCardSnapshot = cachedSnapshot(buildCardSnapshot, CARD_TTL_MS);

export async function getPackCommunityStats(db: Db, now = Date.now()): Promise<PackCommunityStats> {
  const [collectors, cards] = await Promise.all([getCollectorSnapshot(db, now), getCardSnapshot(db, now)]);
  const totals: PackCommunityTotals = {
    collectors: collectors.collectors.length,
    packsOpened: collectors.packsOpenedTotal,
    cardsMinted: collectors.collectors.reduce((sum, collector) => sum + collector.copies, 0),
    distinctHoldings: collectors.collectors.reduce((sum, collector) => sum + collector.cards, 0),
    playersCarded: cards.playersCarded,
    goatCardsMinted: collectors.tierCopies.goat ?? 0,
    cardsRecycled: collectors.collectors.reduce((sum, collector) => sum + collector.recycled, 0),
    poolTotal: collectors.poolTotal,
    goatRosterSize: HONORARY_USER_IDS.size,
    firstPullAt: collectors.collectors.reduce<number | null>(
      (oldest, collector) =>
        collector.joinedAt > 0 && (oldest === null || collector.joinedAt < oldest) ? collector.joinedAt : oldest,
      null,
    ),
    tierCopies: collectors.tierCopies,
    oneOfAKind: cards.oneOfAKind,
  };

  const boards: PackCommunityBoards = {
    biggestCollections: collectors.ordered.cards.slice(0, PACK_COMMUNITY_BOARD_SIZE),
    packsOpened: collectors.ordered.packs
      .filter((collector) => collector.packsOpened !== null)
      .slice(0, PACK_COMMUNITY_BOARD_SIZE),
    goatHolders: collectors.ordered.goats
      .filter((collector) => collector.goats > 0)
      .slice(0, PACK_COMMUNITY_BOARD_SIZE),
    firstFinds: collectors.collectors
      .filter((collector) => collector.firstFinds > 0)
      .sort((a, b) => b.firstFinds - a.firstFinds || b.cards - a.cards || a.joinedAt - b.joinedAt)
      .slice(0, PACK_COMMUNITY_BOARD_SIZE),
    longestStanding: collectors.collectors
      .filter((collector) => collector.joinedAt > 0)
      .sort((a, b) => a.joinedAt - b.joinedAt || b.cards - a.cards)
      .slice(0, PACK_COMMUNITY_BOARD_SIZE),
    completion:
      collectors.poolTotal > 0
        ? orderByCompletion(collectors.collectors).slice(0, PACK_COMMUNITY_BOARD_SIZE)
        : [],
    rarestCards: cards.rarestCards,
    mostOwnedCards: cards.mostOwnedCards,
  };

  return { totals, boards, computedAt: Math.min(collectors.computedAt, cards.computedAt) };
}

/* Every collector, searchable by name. Filtered and paged over the snapshot:
   the whole directory is a couple of thousand entries, and paging it in SQL
   would mean re-grouping the collection table per keystroke. */
export async function listPackCollectors(
  db: Db,
  options: { page: number; pageSize: number; query?: string | null; sort?: PackCollectorSort },
  now = Date.now(),
): Promise<PackCollectorDirectoryPage> {
  const snapshot = await getCollectorSnapshot(db, now);
  const pageSize = Math.min(PACK_COLLECTOR_PAGE_MAX_SIZE, Math.max(1, Math.floor(options.pageSize) || 1));
  const page = Math.max(0, Math.floor(options.page) || 0);
  const query = options.query?.trim().slice(0, 120).toLowerCase() ?? "";
  const ordered = snapshot.ordered[normalizePackCollectorSort(options.sort)];
  const matched = query ? ordered.filter((collector) => collector.username.toLowerCase().includes(query)) : ordered;
  return {
    collectors: matched.slice(page * pageSize, page * pageSize + pageSize),
    total: matched.length,
  };
}

/* One collector by osu! id, or null if they hold no cards. A collector is
   whoever has an ownership row: there is nothing to show for an account that
   has never opened a pack, and saying so is a 404 rather than an empty shelf. */
export async function getPackCollector(db: Db, userId: number, now = Date.now()): Promise<PackCollectorSummary | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return (await getCollectorSnapshot(db, now)).byUserId.get(userId) ?? null;
}

/* Name to collector, for the shareable ?collector=<name> link. The users
   projection first, then the name the wallet froze, so a collector the backend
   does not track is still reachable by the name their cards are labelled
   with. */
export async function resolvePackCollector(
  db: Db,
  spec: { userId?: unknown; username?: unknown },
): Promise<number | null> {
  const userId = Math.floor(Number(spec.userId));
  if (Number.isInteger(userId) && userId > 0) return userId;
  const username = typeof spec.username === "string" ? spec.username.trim().slice(0, 120) : "";
  if (!username) return null;
  const tracked = (await exec(
    db,
    "select user_id from users where lower(username) = lower(?) limit 1",
    [username],
  )).rows[0];
  if (tracked) return Number(tracked.user_id);
  const frozen = (await exec(
    db,
    "select user_id from pack_wallets where lower(owner_username) = lower(?) limit 1",
    [username],
  )).rows[0];
  return frozen ? Number(frozen.user_id) : null;
}

/* Who a showcase belongs to. Deliberately narrower than PackCollectorSummary:
   the wall prints a name and a card count, and computing the rest would mean
   the full economy roll-up. */
export interface PackShowcaseCollector extends PackCollectorIdentity {
  cards: number;
  goats: number;
}

/* Summaries for a named handful of collectors, grouped over their rows only.
   This is what keeps the showcase off the cached snapshot: the wall shows a
   dozen people, and scanning the whole ownership table to describe twelve of
   them was costing a cold page three and a half seconds. */
async function readShowcaseCollectors(
  db: Db,
  ownerIds: readonly number[],
): Promise<Map<number, PackShowcaseCollector>> {
  const collectors = new Map<number, PackShowcaseCollector>();
  if (ownerIds.length === 0) return collectors;
  const ids = idListSql(ownerIds);
  const [rows, identities, walletRows] = await Promise.all([
    exec(db, `
      select owner_user_id, count(*) as cards,
        sum(case when card_key like '%:goat' and card_user_id in (${HONORARY_ID_LIST}) then 1 else 0 end) as goats
      from pack_collection_cards
      where copies > 0 and owner_user_id in (${ids})
      group by owner_user_id`),
    readOwnerIdentities(db, ownerIds),
    exec(db, `select user_id, owner_username from pack_wallets where user_id in (${ids})`),
  ]);
  const frozenNames = new Map<number, string>();
  for (const row of walletRows.rows) {
    const frozen = nonEmptyString(row.owner_username);
    if (frozen) frozenNames.set(Number(row.user_id), frozen);
  }
  for (const row of rows.rows) {
    const userId = Number(row.owner_user_id);
    const identity = identities.get(userId);
    collectors.set(userId, {
      userId,
      username: identity?.username ?? frozenNames.get(userId) ?? `user ${userId}`,
      countryCode: identity?.countryCode ?? null,
      avatarUrl: identity?.avatarUrl ?? `https://a.ppy.sh/${userId}`,
      tracked: Boolean(identity),
      cards: Number(row.cards) || 0,
      goats: Number(row.goats) || 0,
    });
  }
  return collectors;
}

/* One collector's chosen cards on their own, for the viewer reading back their
   own row. No summary and no snapshot: the cards are the whole answer. */
export async function getPackShowcaseCards(db: Db, userId: number): Promise<StoredPackCard[]> {
  return getPackShowcase(db, userId);
}

/* The showcase wall: collectors who have chosen cards to show, most recently
   changed first, with the cards themselves. Paged over the owners rather than
   over the cards, since a showcase is read as one person's row of five.

   Deliberately not part of the cached snapshot: a showcase is the one thing on
   this page a collector edits and then immediately wants to look at, so it is
   read live. It is cheap, `pack_showcase_cards` holds at most five rows per
   collector. */
export interface PackShowcaseEntry {
  collector: PackShowcaseCollector;
  cards: StoredPackCard[];
  updatedAt: number;
}

export async function listPackShowcases(
  db: Db,
  options: { page: number; pageSize: number },
): Promise<{ showcases: PackShowcaseEntry[]; total: number }> {
  const pageSize = Math.min(24, Math.max(1, Math.floor(options.pageSize) || 1));
  const page = Math.max(0, Math.floor(options.page) || 0);
  const total = Number(
    (await exec(db, "select count(distinct owner_user_id) as total from pack_showcase_cards")).rows[0]?.total,
  ) || 0;
  if (total === 0) return { showcases: [], total: 0 };

  const owners = (await exec(
    db,
    `select owner_user_id, max(updated_at) as updated_at
     from pack_showcase_cards
     group by owner_user_id
     order by updated_at desc, owner_user_id asc
     limit ? offset ?`,
    [pageSize, page * pageSize],
  )).rows;

  const ownerIds = owners.map((row) => Number(row.owner_user_id));
  const collectors = await readShowcaseCollectors(db, ownerIds);
  const entries = await Promise.all(owners.map(async (row) => {
    const userId = Number(row.owner_user_id);
    const collector = collectors.get(userId);
    if (!collector) return null;
    const cards = await getPackShowcase(db, userId);
    return cards.length > 0 ? { collector, cards, updatedAt: Number(row.updated_at) || 0 } : null;
  }));
  return { showcases: entries.filter((entry): entry is PackShowcaseEntry => entry !== null), total };
}

/* A collector's page: their holdings, how far they are through both
   completable sets, the cards they chose to show, and where they stand. */
export async function getPackCollectorProfile(
  db: Db,
  userId: number,
  now = Date.now(),
): Promise<PackCollectorProfile | null> {
  const snapshot = await getCollectorSnapshot(db, now);
  const collector = snapshot.byUserId.get(userId);
  if (!collector) return null;
  return {
    collector,
    completion: collector.completion,
    showcase: await getPackShowcase(db, userId),
    ranks: {
      cards: snapshot.ordered.cards.indexOf(collector) + 1,
      packsOpened: collector.packsOpened === null ? null : snapshot.ordered.packs.indexOf(collector) + 1,
    },
  };
}
