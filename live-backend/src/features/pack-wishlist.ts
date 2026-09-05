/* The wishlist and its pity counter.

   A collector names up to five players they are still missing, and every pack
   they open afterwards carries a small, growing chance to deal one of them.
   The chance starts at 3%, climbs a point per pack that could have hit and
   did not, stops at 25%, and drops back to the base the moment a wished card
   is dealt.

   A pack only counts against the counter when it could honestly have paid
   out: if none of the wished players sits inside the slice this pack draws
   from (a Legend pack only reaches the top 2%), or the collector has since
   pulled all of them anyway, the roll never happens and the counter does not
   move. Without that rule a collector could park a rank-4000 player on the
   list, open Legend packs all evening, and arrive at the 25% ceiling on a
   list the draw was never going to reach.

   The wishlist is a list of missing players, so a row retires itself the
   moment its card is held: the pity roll deletes the row it paid out, the
   draw route settles the rest after minting, and the read drops any that
   slipped through. */
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch } from "../db.js";
import { getPackPoolMembership } from "./global-rankings.js";
import { getOrdinaryPackPoolMembership, HONORARY_USER_IDS } from "./pack-wallets.js";

/* Five is the whole ceiling: it is a list of the players you actually want,
   not a second collection, and a longer list would make the pity roll a
   near-certain payout on the ordinary pool. */
export const WISHLIST_MAX = 5;

/* The pity curve: 3% on the next pack, a point more per pack that could have
   hit and did not, capped at 25%. A nudge rather than a guarantee, which is
   the point of the ceiling: at 25% a wished card is still the exception, and
   the rest of the hand is still the ordinary draw. */
export const PITY_BASE = 0.03;
export const PITY_STEP = 0.01;
export const PITY_MAX = 0.25;

export function wishlistChance(misses: number): number {
  const steps = Math.max(0, Math.floor(misses));
  return Math.min(PITY_MAX, PITY_BASE + steps * PITY_STEP);
}

export interface PackWishlistPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  pp: number;
  globalRank: number | null;
  /* Whether the ordinary draw pool still contains them. A player who fell off
     the rankings stays on the list (nothing else would explain why they never
     turn up), but no pack can deal them. */
  inPool: boolean;
}

export interface PackWishlistState {
  misses: number;
  hits: number;
  chance: number;
}

export interface PackWishlist {
  players: PackWishlistPlayer[];
  state: PackWishlistState;
}

export type PackWishlistRefusal = "wishlist_full" | "not_pullable" | "already_owned";

export class PackWishlistError extends Error {
  readonly code: PackWishlistRefusal;

  constructor(code: PackWishlistRefusal) {
    super(code);
    this.name = "PackWishlistError";
    this.code = code;
  }
}

function validOwner(ownerUserId: number): boolean {
  return Number.isInteger(ownerUserId) && ownerUserId > 0;
}

/* Which of these players' ordinary cards the collector already holds. The
   ordinary key only: a GOAT or a granted variant of the same player is a
   different collectible and does not satisfy a wish. */
async function selectOwnedOrdinary(db: Db, ownerUserId: number, cardUserIds: readonly number[]): Promise<Set<number>> {
  if (cardUserIds.length === 0) return new Set();
  const placeholders = cardUserIds.map(() => "?").join(",");
  const rows = (await exec(
    db,
    `select card_user_id from pack_collection_cards
     where owner_user_id = ? and copies > 0 and card_key = cast(card_user_id as text)
       and card_user_id in (${placeholders})`,
    [ownerUserId, ...cardUserIds],
  )).rows;
  return new Set(rows.map((row) => Number(row.card_user_id)));
}

async function readWishlistState(db: Db, ownerUserId: number): Promise<{ misses: number; hits: number }> {
  const row = (await exec(
    db,
    "select misses, hits from pack_wishlist_state where owner_user_id = ?",
    [ownerUserId],
  )).rows[0];
  return {
    misses: Math.max(0, Math.floor(Number(row?.misses ?? 0) || 0)),
    hits: Math.max(0, Math.floor(Number(row?.hits ?? 0) || 0)),
  };
}

/* The list as the collector's own page reads it. Identity comes from the
   users projection rather than from whatever the browser typed, and rows
   whose card has since been pulled are dropped here as well as by the draw
   route, so a stale row can never survive a page load. */
export async function listPackWishlist(db: Db, ownerUserId: number): Promise<PackWishlist> {
  if (!validOwner(ownerUserId)) return { players: [], state: { misses: 0, hits: 0, chance: wishlistChance(0) } };
  const rows = (await exec(
    db,
    `select w.card_user_id, u.username, u.avatar_url, u.country_code, u.pp, u.global_rank
     from pack_wishlist w
     left join users u on u.user_id = w.card_user_id
     where w.owner_user_id = ?
     order by w.added_at asc`,
    [ownerUserId],
  )).rows;
  const state = await readWishlistState(db, ownerUserId);
  if (rows.length === 0) {
    return { players: [], state: { ...state, chance: wishlistChance(state.misses) } };
  }
  const cardUserIds = rows.map((row) => Number(row.card_user_id));
  /* An owned row is hidden here and deleted by the draw's settle pass: this
     is a read, on the read connection, and it stays one. */
  const owned = await selectOwnedOrdinary(db, ownerUserId, cardUserIds);
  let poolUserIds: ReadonlySet<number> | null = null;
  try {
    poolUserIds = getOrdinaryPackPoolMembership(await getPackPoolMembership(db)).userIds;
  } catch {
    // A pool the board cannot read says nothing about these players; the line
    // simply does not claim any of them fell out.
    poolUserIds = null;
  }
  const players: PackWishlistPlayer[] = [];
  for (const row of rows) {
    const userId = Number(row.card_user_id);
    if (!Number.isInteger(userId) || userId <= 0 || owned.has(userId)) continue;
    const globalRank = Math.floor(Number(row.global_rank ?? 0) || 0);
    players.push({
      userId,
      username: String(row.username ?? `User ${userId}`),
      avatarUrl: String(row.avatar_url ?? ""),
      countryCode: String(row.country_code ?? ""),
      pp: Math.max(0, Number(row.pp ?? 0) || 0),
      globalRank: globalRank > 0 ? globalRank : null,
      inPool: poolUserIds ? poolUserIds.has(userId) : true,
    });
  }
  return { players, state: { ...state, chance: wishlistChance(state.misses) } };
}

/* Adds one player, after checking the three things a wish has to be: a player
   an ordinary pack can actually deal, one the collector does not already
   hold, and the sixth one is refused. */
export async function addPackWishlistPlayer(
  db: Db,
  ownerUserId: number,
  cardUserId: number,
  now = Date.now(),
): Promise<PackWishlist> {
  if (!validOwner(ownerUserId) || !Number.isInteger(cardUserId) || cardUserId <= 0) {
    throw new PackWishlistError("not_pullable");
  }
  if (HONORARY_USER_IDS.has(cardUserId)) throw new PackWishlistError("not_pullable");
  const pool = getOrdinaryPackPoolMembership(await getPackPoolMembership(db));
  if (!pool.userIds.has(cardUserId)) throw new PackWishlistError("not_pullable");
  if ((await selectOwnedOrdinary(db, ownerUserId, [cardUserId])).size > 0) {
    throw new PackWishlistError("already_owned");
  }
  const existing = (await exec(
    db,
    "select card_user_id from pack_wishlist where owner_user_id = ?",
    [ownerUserId],
  )).rows.map((row) => Number(row.card_user_id));
  if (!existing.includes(cardUserId) && existing.length >= WISHLIST_MAX) {
    throw new PackWishlistError("wishlist_full");
  }
  await exec(
    db,
    "insert or ignore into pack_wishlist (owner_user_id, card_user_id, added_at) values (?, ?, ?)",
    [ownerUserId, cardUserId, now],
  );
  return listPackWishlist(db, ownerUserId);
}

export async function removePackWishlistPlayer(db: Db, ownerUserId: number, cardUserId: number): Promise<PackWishlist> {
  if (!validOwner(ownerUserId)) return listPackWishlist(db, ownerUserId);
  await exec(
    db,
    "delete from pack_wishlist where owner_user_id = ? and card_user_id = ?",
    [ownerUserId, Math.floor(cardUserId) || 0],
  );
  return listPackWishlist(db, ownerUserId);
}

/* Retires every wished player whose card the collection now holds, in one
   statement. Called by the draw route after the hand is minted. */
export async function settlePackWishlistOwned(db: Db, ownerUserId: number): Promise<void> {
  if (!validOwner(ownerUserId)) return;
  await exec(
    db,
    `delete from pack_wishlist
     where owner_user_id = ?
       and card_user_id in (
         select card_user_id from pack_collection_cards
         where owner_user_id = ? and copies > 0 and card_key = cast(card_user_id as text)
       )`,
    [ownerUserId, ownerUserId],
  );
}

export async function hasPackWishlistRows(db: Db, ownerUserId: number): Promise<boolean> {
  if (!validOwner(ownerUserId)) return false;
  return (await exec(
    db,
    "select 1 from pack_wishlist where owner_user_id = ? limit 1",
    [ownerUserId],
  )).rows.length > 0;
}

/* The pity roll, run once per signed-in open from inside drawPackHand.

   `sliceUserIds` is the set of players this particular pack could have dealt,
   so the counter only advances on a pack that had a candidate to pay out. The
   winner's row is deleted here rather than left to the settle pass: the card
   is about to be minted, and a wish is spent the moment it is granted.

   Returns the userId to deal, or 0. */
export interface PackWishlistRoll {
  /* The wished player this pack pays out, or 0. */
  userId: number;
  /* Whether this roll moves the pity counter at all: false when nothing on
     the list could have been dealt, which is neither a hit nor a miss. */
  counted: boolean;
}

/* The decision only. Nothing is written here, because the draw rolls before
   the pack is paid for: a refused wallet or a failed deal must leave the
   wishlist and the counter exactly as they were. The route commits the roll
   with commitPackWishlistRoll once the spend has gone through. */
export async function rollPackWishlistPity(
  db: Db,
  ownerUserId: number,
  sliceUserIds: ReadonlySet<number>,
  rng: () => number = Math.random,
): Promise<PackWishlistRoll> {
  const none: PackWishlistRoll = { userId: 0, counted: false };
  if (!validOwner(ownerUserId) || sliceUserIds.size === 0) return none;
  const rows = (await exec(
    db,
    "select card_user_id from pack_wishlist where owner_user_id = ?",
    [ownerUserId],
  )).rows;
  const wished = rows
    .map((row) => Number(row.card_user_id))
    .filter((userId) => Number.isInteger(userId) && userId > 0 && sliceUserIds.has(userId));
  if (wished.length === 0) return none;
  const owned = await selectOwnedOrdinary(db, ownerUserId, wished);
  const candidates = wished.filter((userId) => !owned.has(userId));
  // No candidate means no roll: this pack could not have paid out, so it does
  // not count as a miss either.
  if (candidates.length === 0) return none;

  const state = await readWishlistState(db, ownerUserId);
  const hit = rng() < wishlistChance(state.misses);
  const chosen = hit ? candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))] : 0;
  return { userId: chosen, counted: true };
}

/* Writes a roll down: a hit resets the counter and spends the wish, a miss
   grows it. Called by the draw route after the pack is paid for, on the write
   connection, and never for a roll that was not counted. */
export async function commitPackWishlistRoll(
  db: Db,
  ownerUserId: number,
  roll: PackWishlistRoll,
  now = Date.now(),
): Promise<void> {
  if (!validOwner(ownerUserId) || !roll.counted) return;
  const hit = roll.userId > 0;
  const state = await readWishlistState(db, ownerUserId);
  const statements: DbStatement[] = [
    {
      sql: `insert into pack_wishlist_state (owner_user_id, misses, hits, last_hit_at, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict(owner_user_id) do update set
              misses = excluded.misses,
              hits = excluded.hits,
              last_hit_at = coalesce(excluded.last_hit_at, pack_wishlist_state.last_hit_at),
              updated_at = excluded.updated_at`,
      args: [ownerUserId, hit ? 0 : state.misses + 1, hit ? state.hits + 1 : state.hits, hit ? now : null, now],
    },
  ];
  if (hit) {
    statements.push({
      sql: "delete from pack_wishlist where owner_user_id = ? and card_user_id = ?",
      args: [ownerUserId, roll.userId],
    });
  }
  await execBatch(db, statements);
}
