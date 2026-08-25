import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import { getPackPoolMembership } from "./global-rankings.js";
import {
  readCardAggregates,
  readCollectorAggregates,
  readPackCommunityHeadlineCounts,
  reconcilePackCommunityRollupsQuietly,
} from "./pack-community-rollups.js";
import {
  getPackCommunitySnapshotThread,
  PackCommunitySnapshotBuildError,
  type PackCommunitySnapshotKind,
} from "./pack-community-thread.js";
import { getOrdinaryPackPoolMembership, getPackShowcase, HONORARY_USER_IDS, listShowcasedCards, type StoredPackCard } from "./pack-wallets.js";

/* The community read of the pack economy, behind /packs/collections.
 *
 * Everything here reads the same durable projections the private surfaces use
 * (pack_collection_cards, pack_wallets, pack_card_serials), grouped by
 * collector instead of filtered to one. Serving a request writes nothing; the
 * only writes in here are the roll-up the build keeps level, and they happen on
 * the worker thread's own connection.
 *
 * The shape of this module is set by one number: pack_collection_cards is
 * millions of rows. The first cut asked SQL each question separately - a query
 * per board, each re-grouping the whole table, with correlated subqueries per
 * collector for the name and the first-find count - and took 28 seconds against
 * the production snapshot. So every board, the directory and one collector's
 * rank are derived in JS from one snapshot of every collector, which is a
 * couple of thousand entries.
 *
 * Building that snapshot used to be two full scans, and that turned out to be
 * the more expensive mistake. Local libsql runs every query synchronously on
 * the calling thread, so a scan does not just make this page slow, it stops the
 * whole process: on 2026-08-18 a cold read after a deploy took 25 seconds, and
 * the two-minute refresh behind it was still freezing unrelated requests for
 * seconds at a time long after anyone had stopped looking at the page. Three
 * things answer that, and all three are about where the work happens rather
 * than how the boards are shaped:
 *
 *  - the counts are maintained instead of regrouped (pack-community-rollups.ts,
 *    ~280ms of summary reads in place of ~6s of scans);
 *  - a build runs on a worker thread with its own connection, so the seconds it
 *    does cost are not seconds the event loop is stopped for;
 *  - the last good snapshot is written next to the database, so a restart
 *    starts warm rather than making its first visitor pay for a cold one.
 *
 * The one query still measured in whole rows is the per-owner pool ratio, and
 * it is asked backwards for that reason: see the off-pool note in
 * buildPackCollectorSnapshotWire.
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

/* Two lifetimes, because the halves move at very different speeds. A
   collection changes whenever somebody opens a pack; which players almost
   nobody holds is not a thing that changes between two visits. So the
   collectors refresh on a couple of minutes and the cards on half an hour.

   This used to be a cost split as well - both halves were full scans, and the
   card one was the dearer of the two - but the maintained roll-up took the
   scans out of both, so what is left is only about how stale each half is
   allowed to get. */
const COLLECTOR_TTL_MS = 2 * 60_000;
const CARD_TTL_MS = 30 * 60_000;

/* The third read, and the one people actually watch.
 *
 * The header's totals are not the expensive part of this page: every one of
 * them is a sum or a count over the maintained roll-up, under 5ms together,
 * where the boards under them need the whole sorted snapshot. Tying the two
 * together meant the packs-opened number was as old as the boards, so somebody
 * who watched it tick up live saw it drop back on reload. So the totals refresh
 * on their own short clock and the boards keep theirs. */
const TOTALS_TTL_MS = 20_000;

export type PackCollectorSort = "cards" | "copies" | "packs" | "goats";

/* One comparator per sort, used by both the directory and the boards so a
   collector's position is the same wherever they are printed. */
const COMPARATORS: Record<PackCollectorSort, (a: PackCollectorSummary, b: PackCollectorSummary) => number> = {
  cards: (a, b) => b.cards - a.cards || b.copies - a.copies || a.joinedAt - b.joinedAt,
  copies: (a, b) => b.copies - a.copies || b.cards - a.cards || a.joinedAt - b.joinedAt,
  packs: (a, b) => (b.packsOpened ?? -1) - (a.packsOpened ?? -1) || b.cards - a.cards || a.joinedAt - b.joinedAt,
  goats: (a, b) => b.goats - a.goats || b.cards - a.cards || a.joinedAt - b.joinedAt,
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

/* What a build produces, and the only shape that crosses the worker-thread
   boundary or lands in the disk cache: plain JSON, no Maps and no reliance on
   shared object identity. The sorted views are derived from it on arrival
   rather than carried, so the payload holds only one copy of each collector. */
export interface PackCollectorSnapshotWire {
  collectors: PackCollectorSummary[];
  packsOpenedTotal: number;
  tierCopies: Record<string, number>;
  poolTotal: number;
  computedAt: number;
}

interface CollectorSnapshot extends PackCollectorSnapshotWire {
  byUserId: Map<number, PackCollectorSummary>;
  /* Pre-sorted once so the directory, the boards and a collector's rank all
     read the same order without re-sorting per request. */
  ordered: Record<PackCollectorSort, PackCollectorSummary[]>;
}

export interface PackCardSnapshot {
  playersCarded: number;
  oneOfAKind: number;
  rarestCards: PackCommunityCard[];
  mostOwnedCards: PackCommunityCard[];
  computedAt: number;
}

/* The header's numbers on their own clock. `totals` is null where the roll-up
   is not usable: the totals then stay whatever the cached snapshot computed,
   because the only other way to answer is the scans this page exists to
   avoid. */
export interface PackCommunityTotalsSnapshot {
  totals: PackCommunityTotals | null;
  computedAt: number;
}

export async function buildPackCommunityTotals(db: Db, now: number): Promise<PackCommunityTotalsSnapshot> {
  const counts = await readPackCommunityHeadlineCounts(db);
  if (!counts) return { totals: null, computedAt: now };
  const [openedRows, pool] = await Promise.all([
    /* Opened packs is banked on the wallet rather than counted off holdings,
       so it does not come from the roll-up. It is 2k rows and always current,
       which is what makes this the one total that is exact the moment it is
       read. */
    exec(db, "select coalesce(sum(json_extract(payload, '$.openedPacks')), 0) as opened from pack_wallets"),
    getPackPoolMembership(db).then(getOrdinaryPackPoolMembership).catch(() => null),
  ]);
  return {
    computedAt: now,
    totals: {
      collectors: counts.collectors,
      packsOpened: Number(openedRows.rows[0]?.opened) || 0,
      cardsMinted: counts.cardsMinted,
      distinctHoldings: counts.distinctHoldings,
      playersCarded: counts.playersCarded,
      goatCardsMinted: counts.tierCopies.goat ?? 0,
      cardsRecycled: counts.cardsRecycled,
      poolTotal: pool?.total ?? 0,
      goatRosterSize: HONORARY_USER_IDS.size,
      firstPullAt: counts.firstPullAt,
      tierCopies: counts.tierCopies,
      oneOfAKind: counts.oneOfAKind,
    },
  };
}

export async function buildPackCollectorSnapshotWire(db: Db, now: number): Promise<PackCollectorSnapshotWire> {
  /* A pool board that cannot build right now must not take the page down with
     it: the completion numbers go to zero and everything else still answers. */
  const pool = await getPackPoolMembership(db).then(getOrdinaryPackPoolMembership).catch(() => null);

  /* Which carded players are outside the draw pool, read off the card catalog
     (one row per variant, thousands of rows) rather than off the ownership
     table (millions). This is the small half of the split: almost every carded
     player is still pullable, so asking "how many of your cards are NOT in the
     pool" touches a fraction of the rows that asking the other way around
     does. The counts below subtract it from the collector's distinct players.
     Reading it from the catalog can only over-list, naming a player whose last
     copy was recycled, and an id nobody holds matches nothing. */
  const offPoolIds = new Set<number>();
  const variantPoolIds = new Set<number>();
  if (pool && pool.total > 0) {
    const catalog = (await exec(db, "select distinct card_user_id, card_key from pack_cards")).rows;
    for (const row of catalog) {
      const cardUserId = Number(row.card_user_id);
      if (cardUserId <= 0) continue;
      if (!pool.userIds.has(cardUserId)) offPoolIds.add(cardUserId);
      else if (String(row.card_key) !== String(cardUserId)) variantPoolIds.add(cardUserId);
    }
  }

  /* The two group-bys that used to be full scans of the ownership table come
     from the maintained roll-up (pack-community-rollups.ts) whenever it is
     level with it, and from the scans themselves when it is not. Everything
     else here reads thousands of rows at most. */
  const [aggregates, firstFindRows, walletRows, offPoolRows, variantOnlyRows] = await Promise.all([
    readCollectorAggregates(db),
    // Serial 1 is whoever found the card first, anywhere.
    exec(db, "select owner_user_id, count(*) as finds from pack_card_serials where serial = 1 group by owner_user_id"),
    exec(db, "select user_id, owner_username, json_extract(payload, '$.openedPacks') as opened from pack_wallets"),
    offPoolIds.size > 0
      ? exec(db, `
          select owner_user_id, count(distinct card_user_id) as off_pool
          from pack_collection_cards
          where copies > 0 and card_user_id in (${idListSql(offPoolIds)})
          group by owner_user_id`)
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
    /* A variant-only holding of an otherwise drawable player cannot satisfy
       that player's ordinary slot. Start from the small catalog set of player
       ids with variants so the card_user_id index avoids scanning millions of
       ordinary ownership rows; the correlated ordinary lookup then hits the
       ownership primary key. */
    variantPoolIds.size > 0
      ? exec(db, `
          select distinct variant.owner_user_id, variant.card_user_id
          from pack_collection_cards variant
          where variant.copies > 0
            and variant.card_user_id in (${idListSql(variantPoolIds)})
            and variant.card_key != cast(variant.card_user_id as text)
            and not exists (
              select 1 from pack_collection_cards ordinary
              where ordinary.owner_user_id = variant.owner_user_id
                and ordinary.card_user_id = variant.card_user_id
                and ordinary.card_key = cast(variant.card_user_id as text)
                and ordinary.copies > 0
            )`)
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
  ]);

  const firstFinds = new Map<number, number>();
  for (const row of firstFindRows.rows) firstFinds.set(Number(row.owner_user_id), Number(row.finds) || 0);

  const offPool = new Map<number, number>();
  for (const row of offPoolRows.rows) offPool.set(Number(row.owner_user_id), Number(row.off_pool) || 0);

  const variantOnlyInPool = new Map<number, number>();
  for (const row of variantOnlyRows.rows) {
    const ownerUserId = Number(row.owner_user_id);
    variantOnlyInPool.set(ownerUserId, (variantOnlyInPool.get(ownerUserId) ?? 0) + 1);
  }

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

  const identities = await readOwnerIdentities(db, aggregates.owners.map((owner) => owner.ownerUserId));

  const collectors: PackCollectorSummary[] = aggregates.owners.map((owner) => {
    const userId = owner.ownerUserId;
    const identity = identities.get(userId);
    return {
      userId,
      username: identity?.username ?? frozenNames.get(userId) ?? `user ${userId}`,
      countryCode: identity?.countryCode ?? null,
      // An untracked collector has no stored avatar; osu! serves one for any id.
      avatarUrl: identity?.avatarUrl ?? `https://a.ppy.sh/${userId}`,
      tracked: Boolean(identity),
      cards: owner.cards,
      players: owner.players,
      copies: owner.copies,
      goats: owner.goats,
      duplicates: owner.duplicates,
      recycled: owner.recycled,
      firstFinds: firstFinds.get(userId) ?? 0,
      packsOpened: openedPacks.get(userId) ?? null,
      joinedAt: owner.joinedAt,
      lastPulledAt: owner.lastPulledAt,
      completion: {
        poolTotal: pool?.total ?? 0,
        // Everything owned, less players outside the pool and players held
        // only as an Eternal/admin variant rather than their ordinary card.
        poolOwnedCount: pool && pool.total > 0
          ? Math.max(0, owner.players - (offPool.get(userId) ?? 0) - (variantOnlyInPool.get(userId) ?? 0))
          : 0,
        goatsOwned: owner.goats,
        goatsTotal: HONORARY_USER_IDS.size,
      },
    };
  });

  return {
    collectors,
    packsOpenedTotal,
    tierCopies: aggregates.tierCopies,
    poolTotal: pool?.total ?? 0,
    computedAt: now,
  };
}

/* The lookup and the five orderings every read wants, built once per snapshot.
   Cheap next to the scans that produced the array (a couple of thousand
   entries), which is why the wire shape carries neither. */
function indexCollectorSnapshot(wire: PackCollectorSnapshotWire): CollectorSnapshot {
  const { collectors } = wire;
  return {
    ...wire,
    byUserId: new Map(collectors.map((collector) => [collector.userId, collector])),
    ordered: {
      cards: [...collectors].sort(COMPARATORS.cards),
      copies: [...collectors].sort(COMPARATORS.copies),
      packs: [...collectors].sort(COMPARATORS.packs),
      goats: [...collectors].sort(COMPARATORS.goats),
    },
  };
}

export async function buildPackCardSnapshot(db: Db, now: number): Promise<PackCardSnapshot> {
  const cards = (await readCardAggregates(db)).cards.map((card) => ({
    userId: card.cardUserId,
    owners: card.owners,
    copies: card.copies,
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

/* ---------------------------------------------------------------------------
   The snapshot store.

   Two things make this more than a memoized promise. The scans are seconds
   long, and local libsql runs every query synchronously on the calling thread:
   a build started on the event loop stops the whole process for its duration,
   which is how a page nobody was looking at came to stall unrelated requests
   every two minutes. And the previous shape called build() before it could
   hand back the stale value, so even the stale-while-revalidate path paid the
   freeze in full.

   So: builds run on a worker thread with its own connection, a reader is only
   ever handed the value already in hand, and the last good snapshot is written
   next to the database so a restart starts warm instead of making the first
   visitor wait out a cold scan. The inline path stays for environments where
   the thread cannot start (vitest, source-mode dev), and there it is at least
   deferred past the current turn so the response that triggered it goes out
   first.
   --------------------------------------------------------------------------- */

const gzipAsync = promisify(gzipCallback);
const gunzipAsync = promisify(gunzipCallback);

/* In the filename, so a shape change simply misses its cache instead of
   parsing an old file into the new type. Bump on any change to what
   PackCollectorSnapshotWire or PackCardSnapshot carry. */
const SNAPSHOT_CACHE_VERSION = 1;

/* Where the snapshot in hand came from, for the admin status readout. "disk"
   is a restart that started warm; "inline" means the thread is not running
   here. */
export type PackCommunitySnapshotSource = "none" | "disk" | "thread" | "inline";

interface SnapshotSlot<T extends { computedAt: number }> {
  value: T | null;
  building: Promise<T> | null;
  restore: Promise<void> | null;
  source: PackCommunitySnapshotSource;
  builds: number;
  lastBuildMs: number | null;
  lastBuildAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

interface PackCommunityStore {
  collector: SnapshotSlot<CollectorSnapshot>;
  card: SnapshotSlot<PackCardSnapshot>;
  /* Not disk-backed like the other two: it rebuilds in single-digit
     milliseconds, so a restart is warm without any help. */
  totals: SnapshotSlot<PackCommunityTotalsSnapshot>;
  /* Directory the disk cache lives in, or null when nothing registered one
     (tests, and any caller that has not opted in): then there is no restore
     and no persist, and this is a plain in-memory cache. */
  cacheDir: string | null;
  threadConfig: { databaseUrl: string; sqliteBusyTimeoutMs?: number; sqliteSynchronous?: string } | null;
  refreshTimer: NodeJS.Timeout | null;
}

function emptySlot<T extends { computedAt: number }>(): SnapshotSlot<T> {
  return {
    value: null,
    building: null,
    restore: null,
    source: "none",
    builds: 0,
    lastBuildMs: null,
    lastBuildAt: null,
    lastError: null,
    lastErrorAt: null,
  };
}

const stores = new WeakMap<Db, PackCommunityStore>();

function storeFor(db: Db): PackCommunityStore {
  let store = stores.get(db);
  if (!store) {
    store = {
      collector: emptySlot<CollectorSnapshot>(),
      card: emptySlot<PackCardSnapshot>(),
      totals: emptySlot<PackCommunityTotalsSnapshot>(),
      cacheDir: null,
      threadConfig: null,
      refreshTimer: null,
    };
    stores.set(db, store);
  }
  return store;
}

/* Opts a connection into the worker thread and the disk cache. Without this
   the store still works, it just builds on the calling thread and forgets
   everything on restart, which is what tests want. */
export function registerPackCommunitySnapshots(
  db: Db,
  config: { databaseUrl?: string; sqliteBusyTimeoutMs?: number; sqliteSynchronous?: string },
): void {
  const store = storeFor(db);
  if (!config.databaseUrl) return;
  store.threadConfig = {
    databaseUrl: config.databaseUrl,
    sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs,
    sqliteSynchronous: config.sqliteSynchronous,
  };
  if (config.databaseUrl.startsWith("file:")) {
    store.cacheDir = dirname(resolve(config.databaseUrl.slice("file:".length)));
  }
}

function cachePath(cacheDir: string, kind: PackCommunitySnapshotKind): string {
  return join(cacheDir, `pack-community-${kind}-v${SNAPSHOT_CACHE_VERSION}.json.gz`);
}

/* A parsed cache file or thread payload is only adopted if it still looks like
   the snapshot it claims to be: a truncated or half-written file must not
   become the boards. */
function readCollectorWire(value: unknown): PackCollectorSnapshotWire | null {
  const wire = value as PackCollectorSnapshotWire | null;
  return wire && Array.isArray(wire.collectors) && typeof wire.computedAt === "number" ? wire : null;
}

function readTotalsSnapshot(value: unknown): PackCommunityTotalsSnapshot | null {
  const snapshot = value as PackCommunityTotalsSnapshot | null;
  if (!snapshot || typeof snapshot.computedAt !== "number") return null;
  // A null `totals` is a real answer (the roll-up is not usable), not a
  // truncated payload.
  return snapshot.totals === null || typeof snapshot.totals === "object" ? snapshot : null;
}

function readCardSnapshot(value: unknown): PackCardSnapshot | null {
  const snapshot = value as PackCardSnapshot | null;
  return snapshot
    && Array.isArray(snapshot.rarestCards)
    && Array.isArray(snapshot.mostOwnedCards)
    && typeof snapshot.computedAt === "number"
    ? snapshot
    : null;
}

/* Restores the last good snapshot from disk, once per slot per process. The
   restored value is served straight away even though it is certainly past its
   TTL: it is the same answer a visitor two minutes before the restart got, and
   the alternative is making this one wait out a cold scan. The refresh it
   triggers replaces it in the background. */
function restoreSlot<T extends { computedAt: number }>(
  store: PackCommunityStore,
  slot: SnapshotSlot<T>,
  kind: PackCommunitySnapshotKind,
  parse: (value: unknown) => T | null,
): Promise<void> {
  if (slot.restore) return slot.restore;
  const restore = (async () => {
    if (!store.cacheDir) return;
    const path = cachePath(store.cacheDir, kind);
    try {
      const snapshot = parse(JSON.parse((await gunzipAsync(await readFile(path))).toString("utf8")) as unknown);
      if (!snapshot) {
        logWarn("pack_community_snapshot_cache_rejected", { kind, path });
        return;
      }
      if (!slot.value) {
        slot.value = snapshot;
        slot.source = "disk";
        logInfo("pack_community_snapshot_restored", {
          kind,
          ageMs: Date.now() - snapshot.computedAt,
          detail: "serving the snapshot this box wrote before the restart while a fresh one builds",
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logWarn("pack_community_snapshot_cache_unreadable", { kind, path, ...errorContext(error) });
      }
    }
  })();
  slot.restore = restore;
  return restore;
}

async function persistSnapshot(store: PackCommunityStore, kind: PackCommunitySnapshotKind, json: Buffer): Promise<void> {
  if (!store.cacheDir) return;
  const path = cachePath(store.cacheDir, kind);
  try {
    // Written aside and renamed: a process killed mid-write must not leave a
    // half-written file for the next boot to adopt.
    const temp = `${path}.tmp`;
    await writeFile(temp, await gzipAsync(json));
    await rename(temp, path);
  } catch (error) {
    logWarn("pack_community_snapshot_cache_write_failed", { kind, path, ...errorContext(error) });
  }
}

function yieldTurn(): Promise<void> {
  return new Promise((done) => {
    setImmediate(done);
  });
}

/* Runs the build on the worker thread when one can run here. Null means the
   thread genuinely cannot (not a file database, disabled, or it never managed
   to spawn - e.g. under vitest) and the caller should build inline. Anything
   that went wrong after the thread has been online throws instead: re-running
   a scan this heavy on the event loop is the stall the thread exists to
   prevent, and the last good snapshot keeps serving meanwhile. */
async function buildOnThread(
  store: PackCommunityStore,
  kind: PackCommunitySnapshotKind,
  now: number,
): Promise<Buffer | null> {
  if (!store.threadConfig) return null;
  const thread = getPackCommunitySnapshotThread(store.threadConfig);
  if (!thread) return null;
  if (!thread.available()) {
    if (thread.inlineFallbackAllowed()) return null;
    throw new PackCommunitySnapshotBuildError("pack community snapshot thread cooling down");
  }
  try {
    return await thread.build(kind, now);
  } catch (error) {
    if (error instanceof PackCommunitySnapshotBuildError) throw error;
    logWarn("pack_community_snapshot_thread_inline_fallback", errorContext(error));
    return null;
  }
}

interface BuiltSnapshot<T> {
  snapshot: T;
  source: PackCommunitySnapshotSource;
}

async function runCollectorBuild(db: Db, store: PackCommunityStore, now: number): Promise<BuiltSnapshot<CollectorSnapshot>> {
  const json = await buildOnThread(store, "collector", now);
  if (json) {
    const wire = readCollectorWire(JSON.parse(json.toString("utf8")) as unknown);
    if (!wire) throw new Error("pack community collector snapshot came back malformed");
    void persistSnapshot(store, "collector", json);
    return { snapshot: indexCollectorSnapshot(wire), source: "thread" };
  }
  /* Inline. One turn of the loop first, so whatever response asked for this
     has already been written before the scan takes the thread. */
  await yieldTurn();
  /* The thread is where the roll-up is normally kept level, so an inline build
     has to do it too - otherwise a process running without the thread (source
     mode dev, a box where it never spawned) would keep reading stored counts
     that nothing was updating. */
  await reconcilePackCommunityRollupsQuietly(db, now);
  const wire = await buildPackCollectorSnapshotWire(db, now);
  void persistSnapshot(store, "collector", Buffer.from(JSON.stringify(wire), "utf8"));
  return { snapshot: indexCollectorSnapshot(wire), source: "inline" };
}

async function runCardBuild(db: Db, store: PackCommunityStore, now: number): Promise<BuiltSnapshot<PackCardSnapshot>> {
  const json = await buildOnThread(store, "card", now);
  if (json) {
    const snapshot = readCardSnapshot(JSON.parse(json.toString("utf8")) as unknown);
    if (!snapshot) throw new Error("pack community card snapshot came back malformed");
    void persistSnapshot(store, "card", json);
    return { snapshot, source: "thread" };
  }
  await yieldTurn();
  await reconcilePackCommunityRollupsQuietly(db, now);
  const snapshot = await buildPackCardSnapshot(db, now);
  void persistSnapshot(store, "card", Buffer.from(JSON.stringify(snapshot), "utf8"));
  return { snapshot, source: "inline" };
}

async function runTotalsBuild(db: Db, store: PackCommunityStore, now: number): Promise<BuiltSnapshot<PackCommunityTotalsSnapshot>> {
  const json = await buildOnThread(store, "totals", now);
  if (json) {
    const snapshot = readTotalsSnapshot(JSON.parse(json.toString("utf8")) as unknown);
    if (!snapshot) throw new Error("pack community totals came back malformed");
    return { snapshot, source: "thread" };
  }
  /* No yieldTurn and no reconcile here. This build is a handful of small
     aggregates, and it runs often enough that reconciling on it would put a
     write on the serving loop every twenty seconds in the environments where
     the thread cannot start. Whatever the roll-up is behind by, the snapshot
     builds correct on their own clock. */
  return { snapshot: await buildPackCommunityTotals(db, now), source: "inline" };
}

/* Starts a build if one is not already running, and resolves to the new
   snapshot. A build that fails while a snapshot is in hand resolves to that
   one instead of rejecting: a failed refresh must not turn into a 500 on a
   page that has an answer to give. */
function ensureBuild<T extends { computedAt: number }>(
  slot: SnapshotSlot<T>,
  kind: PackCommunitySnapshotKind,
  build: () => Promise<BuiltSnapshot<T>>,
): Promise<T> {
  if (slot.building) return slot.building;
  const startedAt = Date.now();
  const building = build()
    .then(({ snapshot, source }) => {
      slot.value = snapshot;
      slot.source = source;
      slot.builds += 1;
      slot.lastBuildMs = Date.now() - startedAt;
      slot.lastBuildAt = Date.now();
      slot.lastError = null;
      return snapshot;
    })
    .catch((error: unknown) => {
      slot.lastError = error instanceof Error ? error.message : String(error);
      slot.lastErrorAt = Date.now();
      logWarn("pack_community_snapshot_build_failed", { kind, ...errorContext(error) });
      if (slot.value) return slot.value;
      throw error;
    })
    .finally(() => {
      slot.building = null;
    });
  slot.building = building;
  return building;
}

async function getCollectorSnapshot(db: Db, now: number): Promise<CollectorSnapshot> {
  const store = storeFor(db);
  const slot = store.collector;
  await restoreSlot(store, slot, "collector", (value) => {
    const wire = readCollectorWire(value);
    return wire ? indexCollectorSnapshot(wire) : null;
  });
  if (slot.value && now - slot.value.computedAt < COLLECTOR_TTL_MS) return slot.value;
  const building = ensureBuild(slot, "collector", () => runCollectorBuild(db, store, now));
  return slot.value ?? building;
}

async function getCardSnapshot(db: Db, now: number): Promise<PackCardSnapshot> {
  const store = storeFor(db);
  const slot = store.card;
  await restoreSlot(store, slot, "card", readCardSnapshot);
  if (slot.value && now - slot.value.computedAt < CARD_TTL_MS) return slot.value;
  const building = ensureBuild(slot, "card", () => runCardBuild(db, store, now));
  return slot.value ?? building;
}

async function getTotalsSnapshot(db: Db, now: number): Promise<PackCommunityTotalsSnapshot> {
  const store = storeFor(db);
  const slot = store.totals;
  if (slot.value && now - slot.value.computedAt < TOTALS_TTL_MS) return slot.value;
  const building = ensureBuild(slot, "totals", () => runTotalsBuild(db, store, now));
  return slot.value ?? building;
}

/* How long after boot the first refresh runs. Late enough that a restarting
   process is done migrating and answering its first requests before the thread
   opens a second connection and starts scanning. */
const SNAPSHOT_WARMUP_DELAY_MS = 20_000;
/* The refresh clock. Each read keeps its own lifetime; ticking on the shortest
   one just means the two snapshot halves decline most ticks. */
const SNAPSHOT_REFRESH_INTERVAL_MS = TOTALS_TTL_MS;

/* Keeps both halves warm without a visitor. This is what makes the page's cost
   independent of who is looking at it: the scans happen on this clock, on the
   worker thread, and a request only ever reads what they left behind. */
export function startPackCommunitySnapshotRefresh(db: Db): void {
  const store = storeFor(db);
  if (store.refreshTimer) return;
  const tick = (): void => {
    const now = Date.now();
    void getCollectorSnapshot(db, now).catch(() => undefined);
    void getCardSnapshot(db, now).catch(() => undefined);
    void getTotalsSnapshot(db, now).catch(() => undefined);
  };
  const start = setTimeout(() => {
    tick();
    const timer = setInterval(tick, SNAPSHOT_REFRESH_INTERVAL_MS);
    timer.unref();
    store.refreshTimer = timer;
  }, SNAPSHOT_WARMUP_DELAY_MS);
  start.unref();
  // Held so a second call is a no-op even before the interval exists.
  store.refreshTimer = start;
}

export interface PackCommunitySnapshotSlotStatus {
  source: PackCommunitySnapshotSource;
  computedAt: string | null;
  ageMs: number | null;
  ttlMs: number;
  building: boolean;
  builds: number;
  lastBuildMs: number | null;
  lastBuildAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

function slotStatus(slot: SnapshotSlot<{ computedAt: number }>, ttlMs: number): PackCommunitySnapshotSlotStatus {
  return {
    source: slot.source,
    computedAt: slot.value ? new Date(slot.value.computedAt).toISOString() : null,
    ageMs: slot.value ? Date.now() - slot.value.computedAt : null,
    ttlMs,
    building: slot.building != null,
    builds: slot.builds,
    lastBuildMs: slot.lastBuildMs,
    lastBuildAt: slot.lastBuildAt == null ? null : new Date(slot.lastBuildAt).toISOString(),
    lastError: slot.lastError,
    lastErrorAt: slot.lastErrorAt == null ? null : new Date(slot.lastErrorAt).toISOString(),
  };
}

export interface PackCommunitySnapshotStatus {
  collector: PackCommunitySnapshotSlotStatus;
  card: PackCommunitySnapshotSlotStatus;
  totals: PackCommunitySnapshotSlotStatus;
  diskCache: boolean;
}

export function packCommunitySnapshotStatus(db: Db): PackCommunitySnapshotStatus {
  const store = storeFor(db);
  return {
    collector: slotStatus(store.collector, COLLECTOR_TTL_MS),
    card: slotStatus(store.card, CARD_TTL_MS),
    totals: slotStatus(store.totals, TOTALS_TTL_MS),
    diskCache: store.cacheDir != null,
  };
}

export async function getPackCommunityStats(db: Db, now = Date.now()): Promise<PackCommunityStats> {
  const [collectors, cards, fresh] = await Promise.all([
    getCollectorSnapshot(db, now),
    getCardSnapshot(db, now),
    getTotalsSnapshot(db, now),
  ]);
  /* What the two snapshots between them worked out, which is what the totals
     were before they had a clock of their own. Still the answer wherever the
     roll-up cannot be trusted. */
  const snapshotTotals: PackCommunityTotals = {
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

  /* One clock for the numbers, and it is the totals' own.
   *
   * The page adds the pulls it has seen since `computedAt` on top of these, so
   * this has to be the moment the totals were true and nothing older. Taking
   * the oldest of the two snapshots instead meant the half-hourly card half
   * pinned it, and every pull already folded into a refreshed collector
   * snapshot got counted a second time by whoever had it in their buffer. */
  return {
    totals: fresh.totals ?? snapshotTotals,
    boards,
    computedAt: fresh.totals ? fresh.computedAt : Math.min(collectors.computedAt, cards.computedAt),
  };
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

/* The showcase wall: the cards people chose to show, one tile each, most
   recently chosen first.

   Paged over cards rather than over collectors. Grouping them by owner made
   the name the headline and the card the footnote, and gave whoever last
   edited their shelf the whole top of the page; the wall is meant to be a
   gallery you browse, where whose card it is is something you find out by
   inspecting it. The owner still comes down with every tile, because the
   spotlight names them.

   Deliberately not part of the cached snapshot: a showcase is the one thing on
   this page a collector edits and then immediately wants to look at, so it is
   read live. It is cheap, `pack_showcase_cards` holds at most five rows per
   collector. */
export interface PackShowcaseWallCard {
  card: StoredPackCard;
  collector: PackShowcaseCollector;
  showcasedAt: number;
}

export async function listPackShowcaseWall(
  db: Db,
  options: { page: number; pageSize: number },
): Promise<{ cards: PackShowcaseWallCard[]; total: number }> {
  const { cards, total } = await listShowcasedCards(db, options);
  if (cards.length === 0) return { cards: [], total };
  const collectors = await readShowcaseCollectors(db, [...new Set(cards.map((entry) => entry.ownerUserId))]);
  const wall = cards.flatMap((entry) => {
    const collector = collectors.get(entry.ownerUserId);
    return collector ? [{ card: entry.card, collector, showcasedAt: entry.showcasedAt }] : [];
  });
  return { cards: wall, total };
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
