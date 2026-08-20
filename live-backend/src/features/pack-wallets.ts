import type { InValue } from "@libsql/client";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch, parseJson } from "../db.js";
import { parseCardMotif, type CardMotif } from "./card-motif.js";
import { logInfo } from "../logger.js";
import { mintPackCardSerialStatement } from "./pack-serials.js";

// Synced maniacard pack wallets now keep economy metadata in pack_wallets and
// collection cards in pack_collection_cards. The legacy blob shape is still
// accepted: cards are imported into rows, then stripped out of the stored blob.

export interface StoredPackWallet {
  payload: string;
  rev: number;
  updatedAt: number;
}

export type SavePackWalletResult =
  | { ok: true; rev: number }
  | { ok: false; current: StoredPackWallet };

export interface StoredPackCard {
  userId: number;
  /* Wallet key of this card ("<id>" or "<id>:goat"); see packCardKey. */
  cardKey?: string;
  username: string;
  avatarUrl: string;
  countryCode: string;
  tier: string | null;
  tierLabel: string | null;
  /* This holding's own badge text, when it was given one. Separate from
     tierLabel (which coalesces to the variant's shared label, and for an
     ordinary card is just the tier's name) because only this one is a
     deliberate choice: it is what the card art prints in place of the tier,
     the slot the honorary roster's cardTierLabel already uses. */
  customLabel?: string | null;
  /* The image this holding floats in its card background in place of the
     tier's triangle flecks or starfield. Granted from /admin/collections and
     nowhere else; see card-motif.ts. */
  motif?: CardMotif | null;
  skills: unknown | null;
  pp: number;
  globalRank: number;
  copies: number;
  recycledCopies: number;
  firstPulledAt: number;
  lastPulledAt: number;
  /* When /admin/collections handed this holding out, null for one that was
     pulled. A granted card is minted a serial like any other, so this is the
     only thing that stops a surface saying its holder was the Nth person to
     pull it, which they were not. */
  grantedAt?: number | null;
  /* Mint order for this owner (#1 pulled the card first, anywhere), and how
     many serials the card has ever handed out. Modern signed-in holdings mint
     this transactionally with the card; null is only a legacy/directly seeded
     row that predates the invariant. See pack_card_serials in pack-pulls.ts. */
  serial?: number | null;
  mintedTotal?: number;
}

export interface PackCollectionPage {
  cards: StoredPackCard[];
  total: number;
  tierCounts: Record<string, number>;
  duplicateShardTotal: number;
  filteredShardTotal: number;
}

/* Collection progress measured against the current draw pool. Owned players
   split three ways: still in the pool (the numerator; this includes honorary
   members who are also live ranked players), honorary GOATs outside the pool
   (the GOAT chip tracks those), and retired players who fell off the rankings
   after being pulled. The header used to divide all owned rows by the live
   pool size, and retired cards pushed it past 100%. */
export interface PackCollectionPoolProgress {
  poolTotal: number;
  poolOwnedCount: number;
  retiredOwnedCount: number;
  /* The retired players themselves, so the "not tracked" collection filter
     shows exactly the cards the count describes. Never serialized to clients;
     the collection endpoint strips it. */
  offPoolUserIds: number[];
}

export async function getPackCollectionPoolProgress(
  db: Db,
  userId: number,
  pool: { userIds: Set<number>; total: number },
): Promise<PackCollectionPoolProgress> {
  const rows = (await exec(
    db,
    "select distinct card_user_id from pack_collection_cards where owner_user_id = ? and copies > 0",
    [userId],
  )).rows;
  let poolOwnedCount = 0;
  const offPoolUserIds: number[] = [];
  for (const row of rows) {
    const ownedId = Number(row.card_user_id);
    if (pool.userIds.has(ownedId)) poolOwnedCount += 1;
    else if (!HONORARY_USER_IDS.has(ownedId)) offPoolUserIds.push(ownedId);
  }
  return { poolTotal: pool.total, poolOwnedCount, retiredOwnedCount: offPoolUserIds.length, offPoolUserIds };
}

/* One pullable player as the pool board holds them. Structural rather than
   imported from global-rankings, like the membership set above: this module
   knows collections, the caller knows where a pool comes from. */
export interface PackPoolRosterEntry {
  rank: number;
  user: { id: number; username: string; avatar_url: string; country_code: string };
  pp: number;
  global_rank: number | null;
}

export interface PackCollectionMissingPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  pp: number;
  globalRank: number | null;
  poolRank: number;
}

export interface PackCollectionMissingPage {
  players: PackCollectionMissingPlayer[];
  total: number;
}

/* The other side of the progress header: which pullable players this
   collection does not hold yet. Owned means the player, not the card key - a
   GOAT of someone still ranked already fills their pool slot, exactly as
   getPackCollectionPoolProgress counts it, so the missing count and the
   header's "owned / pool" always agree.

   Paged in JS over the pool board rather than in SQL: the pool is a cached
   in-memory list a few thousand entries long, and it carries the live names
   and pool ranks that a collection row (which only knows the players you
   pulled) cannot. */
export async function listPackCollectionMissingPlayers(
  db: Db,
  userId: number,
  poolEntries: readonly PackPoolRosterEntry[],
  options: { page: number; pageSize: number; query?: string | null },
): Promise<PackCollectionMissingPage> {
  const pageSize = Math.min(PACK_COLLECTION_MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize)));
  const page = Math.max(0, Math.floor(options.page));
  const ownedRows = (await exec(
    db,
    "select distinct card_user_id from pack_collection_cards where owner_user_id = ? and copies > 0",
    [userId],
  )).rows;
  const owned = new Set(ownedRows.map((row) => Number(row.card_user_id)));
  // Same ceiling the recycle path puts on a client-sent query: nothing here
  // is injectable, but a name to match is a name-sized string.
  const query = options.query?.trim().toLowerCase().slice(0, 120) ?? "";
  const start = page * pageSize;
  const end = start + pageSize;
  // Pool entries already run in pool order, so one pass in that order counts
  // the whole set and materializes only the page being asked for; a collector
  // at the start of the game is missing thousands of players.
  const players: PackCollectionMissingPlayer[] = [];
  let total = 0;
  for (const entry of poolEntries) {
    if (owned.has(entry.user.id)) continue;
    if (query && !entry.user.username.toLowerCase().includes(query)) continue;
    const index = total;
    total += 1;
    if (index < start || index >= end) continue;
    players.push({
      userId: entry.user.id,
      username: entry.user.username,
      avatarUrl: entry.user.avatar_url,
      countryCode: entry.user.country_code,
      pp: entry.pp,
      globalRank: entry.global_rank,
      poolRank: entry.rank,
    });
  }
  return { players, total };
}

/* How many GOAT cards this collection still lacks. Separate from the list
   above because a GOAT is not a pool slot: most of the honorary roster sits
   outside the draw pool entirely (banned or deleted accounts have no roster
   row), and the ones still ranked have their pool slot filled by the ordinary
   card. So a missing GOAT shows up in neither the header's owned/pool ratio
   nor the missing list, and the album is where it gets looked at. */
export async function countMissingGoatCards(db: Db, userId: number): Promise<number> {
  const honorary = [...HONORARY_USER_IDS].join(",");
  const row = (await exec(
    db,
    `select count(distinct card_user_id) as owned from pack_collection_cards
     where owner_user_id = ? and copies > 0 and card_key like '%:goat'
       and card_user_id in (${honorary})`,
    [userId],
  )).rows[0];
  return Math.max(0, HONORARY_USER_IDS.size - Number(row?.owned ?? 0));
}

/* Restricts a card query to specific players. The ids are validated integers
   inlined into the SQL (not bound parameters) so a large retired set can never
   trip the parameter limit; an empty restriction matches nothing. */
function cardUserIdRestrictionSql(userIds: readonly number[]): string {
  const safe = userIds.filter((id) => Number.isInteger(id) && id > 0);
  if (safe.length === 0) return "1 = 0";
  return `pack_collection_cards.card_user_id in (${safe.join(",")})`;
}

/* The album needs the whole collection, and it walks pages to get there, so a
   small ceiling turns one browse into a dozen round trips. Cards are a few
   hundred bytes each, so a wide page is still a small response. */
export const PACK_COLLECTION_MAX_PAGE_SIZE = 250;

export type PackRecycleMode = "duplicates" | "whole" | "all_duplicates" | "whole_matching" | "copies";
export type PackWalletCardImportMode = "snapshot" | "delta";

export interface PackRecycleResult {
  gained: number;
  wallet: StoredPackWallet;
}

interface WalletCardPayload extends StoredPackCard {
  avatar_url?: string;
  country_code?: string;
  global_rank?: number;
  recycled_copies?: number;
  first_pulled_at?: number;
  last_pulled_at?: number;
}

interface WalletPayload {
  cards?: Record<string, unknown>;
  shards?: unknown;
  shardsSpent?: unknown;
  charges?: unknown;
  lastRefillAt?: unknown;
  openedPacks?: unknown;
  poolTotal?: unknown;
  /* Set once by mergeImportedPackWallet: the moment this account's local
     (pre-login) wallet history was folded in. Its presence closes the merge
     door for good. */
  importedAt?: unknown;
}

const TIER_SHARD_VALUES: Record<string, number> = {
  common: 2,
  rare: 4,
  elite: 7,
  superRare: 10,
  ultraRare: 14,
  legendary: 20,
  mythic: 27,
  ascendant: 36,
  worldClass: 48,
  // Hand-granted only, so it is not priced against pack odds; half a GOAT.
  eternal: 250,
  // Mirrors the frontend's table in src/lib/pack-collection.ts. GOAT came down
  // from 1000, which bought several Legend packs for a card the honorary slot
  // hands out for free once the roster is complete.
  goat: 500,
  unrated: 1,
};

/* What a duplicate copy recycles for: half the tier value, floored at one
   shard. See DUPLICATE_RECYCLE_RATE in src/lib/pack-collection.ts for why the
   second copy is worth less than the first - in short, duplicates at full
   value made a finished collection an infinite shard loop, because every pack
   bought with shards paid back more shards than it cost. */
export const DUPLICATE_RECYCLE_RATE = 0.5;

const TIER_DUPLICATE_SHARD_VALUES: Record<string, number> = Object.fromEntries(
  Object.entries(TIER_SHARD_VALUES).map(([tier, value]) => [
    tier,
    Math.max(1, Math.floor(value * DUPLICATE_RECYCLE_RATE)),
  ]),
);

/* Tier strength, mirroring tierRank in the frontend's pack-collection.
   Anything unknown (including a tierless legacy card) ranks below every real
   tier, so a mint always wins over "unrated". */
const TIER_RANKS: Record<string, number> = {
  common: 0,
  rare: 1,
  elite: 2,
  superRare: 3,
  ultraRare: 4,
  legendary: 5,
  mythic: 6,
  ascendant: 7,
  worldClass: 8,
  eternal: 9,
  goat: 10,
};

/* hasOwnProperty, not `TIER_RANKS[tier] ?? -1`: an inherited key ("constructor",
   "toString", "__proto__") would otherwise resolve to a function and make every
   rank comparison against it false, opening the "only a better tier overwrites"
   guard. Card tiers arrive from clients, so they reach this lookup. */
export function tierRank(tier: string | null): number {
  return tier !== null && Object.prototype.hasOwnProperty.call(TIER_RANKS, tier) ? TIER_RANKS[tier] : -1;
}

/* Tiers a card is given rather than rated into, mirroring AWARDED_TIERS in
   src/lib/maniacard.ts. No pass over a player's plays can produce one, so a
   mint that recomputed a card is not a better answer for these and may not
   talk one down. */
const AWARDED_TIERS = new Set(["eternal", "goat"]);

/* Of those two, the one no pack can deal: the honorary slot deals GOAT, while
   "eternal" only ever comes off the grant desk. So a holding at one of these
   is by construction a card somebody was given rather than pulled, which is
   what makes it its own collectible. Mirrors VALID_TIERS in pack-pulls.ts (the
   list a pull may claim); pack-wallets.test.ts holds the two to being exact
   complements so neither can drift. */
export const GRANT_ONLY_TIERS: ReadonlySet<string> = new Set(["eternal"]);

/* The three fields the grant desk can give one holding, and the whole of what
   separates one granted card from another. Read off an ownership row. */
export interface PackCardCustomization {
  tier: string | null;
  tierLabel: string | null;
  motif: string | null;
}

/* Whether a holding is a granted card rather than a pulled one. Its own tier,
   its own badge or its own background art each make it one. */
export function isCustomizedPackCard(card: PackCardCustomization): boolean {
  if (card.tier !== null && GRANT_ONLY_TIERS.has(card.tier)) return true;
  return Boolean(card.tierLabel) || Boolean(card.motif);
}

/* The only tiers that may be stored. Everything else is a card the server
   treats as unrated. */
export function isKnownTier(tier: unknown): tier is string {
  return typeof tier === "string" && Object.prototype.hasOwnProperty.call(TIER_RANKS, tier);
}

// Generated from TIER_RANKS so the SQL and JS orderings cannot drift apart.
// The tier names are module constants, never caller input.
export function tierRankSql(alias = "tier") {
  const cases = Object.entries(TIER_RANKS).map(([tier, rank]) => `    when '${tier}' then ${rank}`);
  return `case ${alias}\n${cases.join("\n")}\n    else -1\n  end`;
}

// Both value expressions are generated from the tables above for the same
// reason tierRankSql is generated from TIER_RANKS: a hand-written copy of a
// shard table is a copy that silently disagrees with the JS one the next time
// a tier is repriced. The tier names are module constants, never caller input.
function valueCaseSql(values: Record<string, number>, alias: string) {
  const cases = Object.entries(values).map(([tier, value]) => `    when '${tier}' then ${value}`);
  return `case ${alias}\n${cases.join("\n")}\n    else 1\n  end`;
}

function shardValueSql(alias = "tier") {
  return valueCaseSql(TIER_SHARD_VALUES, alias);
}

function duplicateShardValueSql(alias = "tier") {
  return valueCaseSql(TIER_DUPLICATE_SHARD_VALUES, alias);
}

/* Letting a whole card go: the kept copy at full tier value plus the rest at
   the duplicate rate, mirroring wholeCardShardValue on the frontend. Every
   caller already filters to copies > 0, but a held card is the only thing this
   is meaningful for, so the guard is written down rather than assumed. */
function wholeCardShardValueSql(alias = "tier", copiesAlias = "copies") {
  return `case when ${copiesAlias} > 0
    then (${shardValueSql(alias)}) + (${copiesAlias} - 1) * (${duplicateShardValueSql(alias)})
    else 0
  end`;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

/* Card rows freeze identity at pull time, but avatars and usernames move on
   (a.ppy.sh serves the current image either way; only the URL's cache-buster
   changes, and thumbnail caches key off that string). Reads overlay the
   current identity from users so a new pfp or rename shows up without a
   repull. */
function liveUserFieldSql(field: "username" | "avatar_url" | "country_code"): string {
  return `(select u.${field} from users u where u.user_id = pack_collection_cards.card_user_id)`;
}

/* One identity field for the variant an ownership row points at, as a
   correlated subquery so it works in WHERE clauses as well as joined SELECTs. */
function catalogFieldSql(field: "username" | "avatar_url" | "country_code" | "tier_label"): string {
  return `(select pc.${field} from pack_cards pc
     where pc.card_key = pack_collection_cards.card_key
       and pc.tier = coalesce(pack_collection_cards.tier, ''))`;
}

/* The joined shape cardFromRow expects: the ownership row's own columns plus
   the variant's identity and the interned snapshot, under the names they had
   when every one of them sat on pack_collection_cards itself.

   The label is the one field both rows can carry, so the catalog's is aliased
   out of the way rather than shadowing `pack_collection_cards.*`: a collector
   whose copy was given its own name reads that, everyone else reads the
   variant's. */
const CARD_SELECT_SQL = `select pack_collection_cards.*,
       pc.username as username,
       pc.avatar_url as avatar_url,
       pc.country_code as country_code,
       pc.tier_label as catalog_tier_label,
       sk.skills_json as skills_json`;

const CARD_CATALOG_JOIN_SQL = `left join pack_cards pc
       on pc.card_key = pack_collection_cards.card_key
       and pc.tier = coalesce(pack_collection_cards.tier, '')
     left join pack_card_skills sk on sk.id = pack_collection_cards.skills_id`;

const displayUsernameSql = `coalesce(nullif(${liveUserFieldSql("username")}, ''), ${catalogFieldSql("username")})`;

/* The honorary roster, mirrored from src/lib/honorary-players.ts. Only these
   players can hold the GOAT tier.

   Collection cards arrive from the client and their tier is otherwise taken on
   trust, which was harmless when the rarest card recycled for 48 shards. GOAT
   recycles for 500 (TIER_SHARD_VALUES in src/lib/pack-collection.ts), so an
   unchecked `tier: "goat"` on any player is a shard printer: sync a forged
   card, recycle it, repeat. Membership is a fixed list of ids, so the check is
   exact and needs no tier index. */
export const HONORARY_USER_IDS = new Set([
  259972, 1190879, 140148, 8474029, 86188, 5610085, 3360737, 2531335, 2520707, 4140104,
  19970192, 10072733, 903155, 12253636, 2288363, 10083439, 1089335,
  9530019, 1824775, 15806513, 3817144, 4477497, 13601876, 758406,
]);

/* A card's identity, mirroring packCardKey in the frontend's pack-collection.
   GOAT is awarded by roster membership rather than card power, and several
   roster members are live ranked players, so one player can be held both as
   the card the ranked pool dealt and as the GOAT the honorary slot dealt.
   Only the GOAT variant is suffixed, so every key already in a wallet stays
   exactly as it was. */
export function packCardKey(cardUserId: number, tier: string | null): string {
  return tier === "goat" ? `${cardUserId}:goat` : String(cardUserId);
}

/* The third key form, and the only one no tier can be derived from.
 *
 * A ":v<n>" key addresses one hand-granted card of a player: a tier no pack
 * deals, a badge, a background art, or any combination the grant desk chose.
 * The number is the player's, not the collector's, so the same card handed to
 * three people is one collectible three collections hold - which is the whole
 * point of giving it a key of its own instead of matching on its columns.
 *
 * No pack, mint or wallet sync may produce one: every one of those derives its
 * key from a tier, and only /admin/collections mints a variant number. That is
 * what keeps a forged wallet from inventing a card nobody granted. */
const VARIANT_KEY_PATTERN = /^(\d+):v(\d+)$/;

export function packCardVariantKey(cardUserId: number, variant: number): string {
  return `${cardUserId}:v${variant}`;
}

export function isPackCardVariantKey(key: string): boolean {
  return VARIANT_KEY_PATTERN.test(key);
}

/* The player a key belongs to, 0 for anything that is not a key. Every form
   starts with the player id, which is what lets a route take a key where it
   used to take an id. */
export function packCardKeyUserId(key: string): number {
  const userId = Math.floor(Number(key.split(":")[0]));
  return Number.isInteger(userId) && userId > 0 ? userId : 0;
}

/* The variant number in a key, or 0 for the two derived forms. */
export function packCardVariantNumber(key: string): number {
  const match = VARIANT_KEY_PATTERN.exec(key);
  return match ? Number(match[2]) : 0;
}

/* Accepts a client-supplied key, rejecting anything that is not a player id
   with an optional ":goat" or ":v<n>" suffix. Bounded digits on the variant so
   a key stays a key: the routes that take one address a row, and an unbounded
   number is just a long string to store and compare. */
export function normalizePackCardKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)(:goat|:v\d{1,6})?$/.exec(value.trim());
  if (!match) return null;
  const userId = Math.floor(Number(match[1]));
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!match[2]) return String(userId);
  if (match[2] === ":goat") return `${userId}:goat`;
  const variant = Math.floor(Number(match[2].slice(2)));
  return variant > 0 ? packCardVariantKey(userId, variant) : null;
}

/* References owned by one holding follow it when its key changes. The serial
   insert-before-delete form also handles a destination the owner already
   holds: that card's existing serial wins, while the obsolete source serial
   is removed. A showcase likewise keeps at most one pin for the destination. */
export function movePackCardKeyReferencesStatements(
  ownerUserId: number,
  oldKey: string,
  newKey: string,
): DbStatement[] {
  if (oldKey === newKey) return [];
  return [
    {
      sql: `insert or ignore into pack_card_serials (
              card_key, card_user_id, owner_user_id, serial, minted_at, pull_report_pending
            )
            select ?, card_user_id, owner_user_id, serial, minted_at, pull_report_pending
            from pack_card_serials where card_key = ? and owner_user_id = ?`,
      args: [newKey, oldKey, ownerUserId],
    },
    {
      sql: "delete from pack_card_serials where card_key = ? and owner_user_id = ?",
      args: [oldKey, ownerUserId],
    },
    {
      sql: `delete from pack_showcase_cards
            where owner_user_id = ? and card_key = ?
              and exists (
                select 1 from pack_showcase_cards target
                where target.owner_user_id = ? and target.card_key = ?
              )`,
      args: [ownerUserId, oldKey, ownerUserId, newKey],
    },
    {
      sql: "update pack_showcase_cards set card_key = ? where owner_user_id = ? and card_key = ?",
      args: [newKey, ownerUserId, oldKey],
    },
  ];
}

function claimedTier(raw: { tier?: unknown }, userId: number): string | null {
  // A rejected claim falls back to unrated (1 shard) rather than erroring, so a
  // stale or hand-edited local wallet still syncs. Anything outside the real
  // tier list is rejected here so no invented tier string ever reaches a rank
  // or shard-value lookup.
  if (!isKnownTier(raw.tier)) return null;
  if (raw.tier === "goat" && !HONORARY_USER_IDS.has(userId)) return null;
  // Eternal is hand-granted and nothing else: no pack deals it, so a wallet
  // claiming one is either stale (it read a card an admin minted, which is
  // fine - see below) or forged. Refusing every claim covers both, because the
  // ownership upsert only ever lets a *better* tier overwrite the stored one:
  // a real Eternal card outranks the unrated claim and survives the sync
  // untouched, while a forged one never becomes a 250-shard recycle.
  if (raw.tier === "eternal") return null;
  return raw.tier;
}

/* Bounds for the client-authored card fields.

   These rows are not merely private bookkeeping: username, avatarUrl, tierLabel
   and skills are read back out by the public share card (getSharedPackCard) and
   painted into the /pull/... OG image on this site's own domain. Unbounded, a
   hand-written wallet could mint a shareable card carrying an arbitrary name,
   an arbitrary image URL and a megabyte of "skills". The caps below are the
   same ones the mint route already applied - this path simply never got them.

   None of this makes the economy honest (the shard balance is client-authored
   by design, so a forged tier was never the cheap way to print shards); it
   bounds what a forged row can *display*. */
export const PACK_CARD_USERNAME_MAX_CHARS = 40;
export const PACK_CARD_TIER_LABEL_MAX_CHARS = 60;
export const PACK_CARD_AVATAR_URL_MAX_CHARS = 300;
/* Absurdity ceilings, not play limits: real collections sit orders of
   magnitude below these, and past them a row is only a rendering problem. */
export const PACK_CARD_MAX_COPIES = 100_000;
export const PACK_CARD_MAX_PP = 1_000_000;

/* Keeps a stored avatar to an https URL. Anything else - a javascript: or
   data: URI, a bare string - degrades to empty, and the read path then falls
   back to the users row (which is where a tracked player's avatar comes from
   anyway). */
export function normalizeAvatarUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > PACK_CARD_AVATAR_URL_MAX_CHARS) return "";
  try {
    return new URL(value).protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

function normalizeCard(value: unknown, now: number): StoredPackCard | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WalletCardPayload>;
  const userId = toFiniteNumber(raw.userId, 0);
  if (!Number.isInteger(userId) || userId <= 0 || typeof raw.username !== "string") return null;
  const tier = claimedTier(raw, userId);
  // Oversized skills are dropped rather than rejecting the card: the blob is a
  // render detail, and losing it costs a stat bar, not the card.
  let skills: unknown | null = raw.skills && typeof raw.skills === "object" ? raw.skills : null;
  if (skills !== null && JSON.stringify(skills).length > PACK_CARD_SKILLS_MAX_CHARS) skills = null;
  // A pull cannot have happened in the future; a clock-skewed or hand-edited
  // stamp would otherwise sort ahead of every real pull forever.
  const clampStamp = (input: unknown) => Math.min(now, Math.max(0, Math.floor(toFiniteNumber(input, 0))));
  return {
    userId,
    username: raw.username.slice(0, PACK_CARD_USERNAME_MAX_CHARS),
    avatarUrl: normalizeAvatarUrl(typeof raw.avatarUrl === "string" ? raw.avatarUrl : raw.avatar_url),
    countryCode: normalizeCountryCode(
      typeof raw.countryCode === "string" ? raw.countryCode : typeof raw.country_code === "string" ? raw.country_code : "",
    ),
    tier,
    tierLabel:
      tier === null ? null : (typeof raw.tierLabel === "string" ? raw.tierLabel.slice(0, PACK_CARD_TIER_LABEL_MAX_CHARS) : null),
    skills,
    pp: Math.min(PACK_CARD_MAX_PP, Math.max(0, toFiniteNumber(raw.pp, 0))),
    globalRank: Math.max(0, Math.floor(toFiniteNumber(raw.globalRank ?? raw.global_rank, 0))),
    copies: Math.min(PACK_CARD_MAX_COPIES, Math.max(0, Math.floor(toFiniteNumber(raw.copies, 1)))),
    recycledCopies: Math.min(
      PACK_CARD_MAX_COPIES,
      Math.max(0, Math.floor(toFiniteNumber(raw.recycledCopies ?? raw.recycled_copies, 0))),
    ),
    firstPulledAt: clampStamp(raw.firstPulledAt ?? raw.first_pulled_at),
    lastPulledAt: clampStamp(raw.lastPulledAt ?? raw.last_pulled_at),
  };
}

/* Two letters or nothing: the value is rendered as a flag. */
export function normalizeCountryCode(value: string): string {
  const code = value.slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function stripCardsFromPayload(payload: string): string {
  const parsed = parseJson<WalletPayload | null>(payload, null);
  if (!parsed || typeof parsed !== "object") return payload;
  if (!Object.prototype.hasOwnProperty.call(parsed, "cards")) return payload;
  return JSON.stringify({ ...parsed, cards: {} });
}

function defaultWalletPayload(now: number): string {
  return JSON.stringify({
    cards: {},
    shards: 0,
    shardsSpent: 0,
    charges: 5,
    lastRefillAt: now,
    openedPacks: 0,
    poolTotal: null,
  });
}

export async function getOrCreatePackWallet(db: Db, userId: number, now: number): Promise<StoredPackWallet> {
  const existing = await getPackWallet(db, userId);
  if (existing) return existing;
  await exec(
    db,
    "insert into pack_wallets (user_id, payload, rev, updated_at) values (?, ?, 1, ?) on conflict(user_id) do nothing",
    [userId, defaultWalletPayload(now), now],
  );
  return (await getPackWallet(db, userId)) ?? { payload: defaultWalletPayload(now), rev: 1, updatedAt: now };
}

/* Exported for the arcade, which pays shards for a streak run and needs the
   same single writer every other grant goes through. */
export async function addWalletShards(db: Db, userId: number, gained: number, now: number): Promise<StoredPackWallet> {
  const wallet = await getOrCreatePackWallet(db, userId, now);
  if (gained <= 0) return wallet;
  const parsed = parseJson<WalletPayload | null>(wallet.payload, null) ?? {};
  const nextPayload = JSON.stringify({
    ...parsed,
    cards: {},
    shards: Math.max(0, Math.floor(toFiniteNumber(parsed.shards, 0))) + gained,
  });
  const nextRev = wallet.rev + 1;
  await exec(
    db,
    "update pack_wallets set payload = ?, rev = ?, updated_at = ? where user_id = ?",
    [nextPayload, nextRev, now, userId],
  );
  return { payload: nextPayload, rev: nextRev, updatedAt: now };
}

/* ---- Server-owned economy ----------------------------------------------
   The wallet's numbers (charges, shards, opened packs) used to be whatever
   the client last pushed; the server merely stored the blob. They are now
   written only here: the draw route spends through spendPackOpen, recycling
   and the arcade grant through addWalletShards, the admin grant page through
   setPackWalletEconomy, and a client push can no longer change any of it. The
   constants mirror src/lib/pack-collection.ts, which still runs the same math
   for anonymous (browser-local) wallets and for the signed-in regen countdown
   display. */

export const MAX_PACK_CHARGES = 5;
export const PACK_CHARGE_REGEN_MS = 20_000;
/* Every opened pack banks a few shards, so the shard packs are reachable by
   just playing. */
export const PACK_OPEN_SHARD_REWARD = 2;

export type PackOpenCost = { kind: "charge" } | { kind: "shards"; amount: number };

export interface PackWalletEconomy {
  shards: number;
  shardsSpent: number;
  charges: number;
  lastRefillAt: number;
  openedPacks: number;
  poolTotal: number | null;
}

/* The stored economy, clamped to sane values. lastRefillAt is capped at now
   because pre-refactor payloads were client-authored: a future-dated stamp
   would stall regeneration until the clock caught up with the lie. */
function economyFromParsedPayload(parsed: WalletPayload, now: number): PackWalletEconomy {
  const poolTotal = Math.floor(toFiniteNumber(parsed.poolTotal, 0));
  return {
    shards: Math.max(0, Math.floor(toFiniteNumber(parsed.shards, 0))),
    shardsSpent: Math.max(0, Math.floor(toFiniteNumber(parsed.shardsSpent, 0))),
    charges: Math.min(MAX_PACK_CHARGES, Math.max(0, Math.floor(toFiniteNumber(parsed.charges, MAX_PACK_CHARGES)))),
    lastRefillAt: Math.min(now, Math.max(0, Math.floor(toFiniteNumber(parsed.lastRefillAt, now)))),
    openedPacks: Math.max(0, Math.floor(toFiniteNumber(parsed.openedPacks, 0))),
    poolTotal: poolTotal > 0 ? poolTotal : null,
  };
}

export function packWalletEconomy(payload: string | null, now: number): PackWalletEconomy {
  const parsed = payload ? parseJson<WalletPayload | null>(payload, null) : null;
  return economyFromParsedPayload(parsed ?? {}, now);
}

/* Charge regeneration since lastRefillAt; the same function as the
   frontend's settleCharges, run against the server's clock. */
export function settlePackWalletCharges(economy: PackWalletEconomy, now: number): PackWalletEconomy {
  if (economy.charges >= MAX_PACK_CHARGES) return economy;
  const elapsed = now - economy.lastRefillAt;
  if (elapsed < PACK_CHARGE_REGEN_MS) return economy;
  const gained = Math.floor(elapsed / PACK_CHARGE_REGEN_MS);
  const charges = Math.min(MAX_PACK_CHARGES, economy.charges + gained);
  return {
    ...economy,
    charges,
    lastRefillAt: charges >= MAX_PACK_CHARGES ? now : economy.lastRefillAt + gained * PACK_CHARGE_REGEN_MS,
  };
}

/* The owner's hand on the wallet, from /admin/collections. Every field is
   optional and every one of them is a straight write, because that is the
   whole point: this is the one path that is allowed to hand out shards nobody
   earned. `shardsDelta` is applied on top of whatever `shards` resolved to and
   exists so "give 500" is one call rather than a read the browser can lose a
   race with; a negative delta takes shards away and floors at zero. */
export interface PackWalletEconomyPatch {
  shards?: number;
  shardsDelta?: number;
  shardsSpent?: number;
  charges?: number;
  openedPacks?: number;
}

export async function setPackWalletEconomy(
  db: Db,
  userId: number,
  patch: PackWalletEconomyPatch,
  now = Date.now(),
): Promise<StoredPackWallet> {
  const clampInt = (value: number, max: number) => Math.min(max, Math.max(0, Math.floor(toFiniteNumber(value, 0))));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wallet = await getOrCreatePackWallet(db, userId, now);
    const parsed = parseJson<WalletPayload | null>(wallet.payload, null) ?? {};
    // Settle first, so a grant does not quietly swallow the charges the player
    // regenerated while the page was open.
    const settled = settlePackWalletCharges(economyFromParsedPayload(parsed, now), now);
    const shardsBase = patch.shards != null ? clampInt(patch.shards, WALLET_MAX_SHARDS) : settled.shards;
    const next: PackWalletEconomy = {
      ...settled,
      shards: Math.min(
        WALLET_MAX_SHARDS,
        Math.max(0, shardsBase + Math.floor(toFiniteNumber(patch.shardsDelta ?? 0, 0))),
      ),
      shardsSpent: patch.shardsSpent != null ? clampInt(patch.shardsSpent, WALLET_MAX_SHARDS) : settled.shardsSpent,
      charges: patch.charges != null ? clampInt(patch.charges, MAX_PACK_CHARGES) : settled.charges,
      openedPacks: patch.openedPacks != null ? clampInt(patch.openedPacks, WALLET_MAX_OPENED_PACKS) : settled.openedPacks,
    };
    // Handing someone a part-full bar has to start its clock now, or the
    // settle above would top it straight back up off the old stamp.
    if (next.charges !== settled.charges && next.charges < MAX_PACK_CHARGES) next.lastRefillAt = now;
    const nextPayload = JSON.stringify({ ...parsed, cards: {}, ...next });
    const updated = await exec(
      db,
      "update pack_wallets set payload = ?, rev = ?, updated_at = ? where user_id = ? and rev = ?",
      [nextPayload, wallet.rev + 1, now, userId, wallet.rev],
    );
    if (Number(updated.rowsAffected ?? 0) > 0) {
      return { payload: nextPayload, rev: wallet.rev + 1, updatedAt: now };
    }
  }
  throw new Error(`Pack wallet write kept conflicting for user ${userId}.`);
}

/* Ceilings for the admin writer above. Not a play balance - a hand-typed
   number reaches this straight from a form, and these keep a slipped keystroke
   from storing a shard count that overflows the display (or the JSON). */
const WALLET_MAX_SHARDS = 100_000_000;
const WALLET_MAX_OPENED_PACKS = 10_000_000;

export type PackOpenSpendResult =
  | { ok: true; wallet: StoredPackWallet }
  | { ok: false; reason: "charges" | "shards"; wallet: StoredPackWallet };

/* The purchase half of opening a pack: settle regeneration, take the cost,
   bank the open reward. Refusal returns the stored wallet so the client can
   adopt the true balance instead of its stale display.

   The write is a compare-and-set on the rev with a short retry: all writes
   run on the single serving process, so a conflict only means two draws for
   the same account interleaved at an await point. */
export async function spendPackOpen(
  db: Db,
  userId: number,
  cost: PackOpenCost,
  now = Date.now(),
  poolTotal?: number | null,
): Promise<PackOpenSpendResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wallet = await getOrCreatePackWallet(db, userId, now);
    const parsed = parseJson<WalletPayload | null>(wallet.payload, null) ?? {};
    const settled = settlePackWalletCharges(economyFromParsedPayload(parsed, now), now);
    let next: PackWalletEconomy;
    if (cost.kind === "charge") {
      if (settled.charges <= 0) return { ok: false, reason: "charges", wallet };
      next = {
        ...settled,
        charges: settled.charges - 1,
        // Spending from a full wallet starts the regen clock fresh.
        lastRefillAt: settled.charges >= MAX_PACK_CHARGES ? now : settled.lastRefillAt,
      };
    } else {
      if (settled.shards < cost.amount) return { ok: false, reason: "shards", wallet };
      next = { ...settled, shards: settled.shards - cost.amount, shardsSpent: settled.shardsSpent + cost.amount };
    }
    next = {
      ...next,
      shards: next.shards + PACK_OPEN_SHARD_REWARD,
      openedPacks: next.openedPacks + 1,
      poolTotal: typeof poolTotal === "number" && poolTotal > 0 ? Math.floor(poolTotal) : next.poolTotal,
    };
    const nextPayload = JSON.stringify({ ...parsed, cards: {}, ...next });
    const updated = await exec(
      db,
      "update pack_wallets set payload = ?, rev = ?, updated_at = ? where user_id = ? and rev = ?",
      [nextPayload, wallet.rev + 1, now, userId, wallet.rev],
    );
    if (Number(updated.rowsAffected ?? 0) > 0) {
      return { ok: true, wallet: { payload: nextPayload, rev: wallet.rev + 1, updatedAt: now } };
    }
  }
  throw new Error(`Pack wallet spend kept conflicting for user ${userId}.`);
}

async function importCardsFromPayload(
  db: Db,
  userId: number,
  payload: string,
  now: number,
  mode: PackWalletCardImportMode,
): Promise<void> {
  const parsed = parseJson<WalletPayload | null>(payload, null);
  if (!parsed?.cards || typeof parsed.cards !== "object") return;

  /* A wallet is keyed by card key, so the browser says which holding each card
     is - including the granted ones, whose ":v<n>" key no tier can be derived
     from. Believed only for a key this collector already holds: the desk mints
     those, and a browser that could name a new one could mint itself a card
     nobody granted. Everything else keeps deriving its key from the tier, so a
     forged key falls back to the player's ordinary card rather than being
     refused (a wallet edited by hand still syncs, exactly as before). */
  const entries = Object.entries(parsed.cards)
    .map(([key, value]) => ({ claimed: normalizePackCardKey(key), card: normalizeCard(value, now) }))
    .filter((entry): entry is { claimed: string | null; card: StoredPackCard } => entry.card !== null);
  const granted = entries.some((entry) => entry.claimed !== null && isPackCardVariantKey(entry.claimed));
  const held = granted ? await listOwnedVariantKeys(db, userId) : new Set<string>();
  const cards = entries.map(({ claimed, card }) =>
    claimed !== null && held.has(claimed) ? { ...card, cardKey: claimed } : card,
  );
  if (cards.length === 0) return;
  // Interning happens first because the ownership rows need the ids it hands
  // back; the rest goes down as one batch, so an import costs one write-lock
  // acquisition instead of one per card.
  const skillsIds = await internPackCardSkills(
    db,
    cards.filter((card) => card.skills != null).map((card) => JSON.stringify(card.skills)),
  );
  await writeImportedPackCards(db, userId, cards, now, mode, skillsIds);
}

/* The granted cards this collector holds, by key. Only the ":v<n>" ones: the
   two derived forms need no lookup, since a tier produces them. */
async function listOwnedVariantKeys(db: Db, ownerUserId: number): Promise<Set<string>> {
  const rows = (await exec(
    db,
    "select card_key from pack_collection_cards where owner_user_id = ? and card_key like '%:v%'",
    [ownerUserId],
  )).rows;
  const keys = new Set<string>();
  for (const row of rows) {
    const key = typeof row.card_key === "string" ? row.card_key : "";
    if (isPackCardVariantKey(key)) keys.add(key);
  }
  return keys;
}

/* Maps each skills snapshot to its interned id, minting rows for snapshots
   never seen before. Snapshots are immutable and shared, so an existing row is
   always reused: the same numbers minted for a hundred collectors cost one
   copy of the JSON, not a hundred. */
export async function internPackCardSkills(db: Db, rawPayloads: string[]): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  const payloads = [...new Set(rawPayloads)];
  if (payloads.length === 0) return ids;
  for (const batch of chunked(payloads)) {
    const rows = (await exec(
      db,
      `select id, skills_json from pack_card_skills where skills_json in (${batch.map(() => "?").join(", ")})`,
      batch as InValue[],
    )).rows;
    for (const row of rows) ids.set(String(row.skills_json), Number(row.id));
  }
  const missing = payloads.filter((payload) => !ids.has(payload));
  if (missing.length === 0) return ids;
  await execBatch(
    db,
    missing.map((payload) => ({
      sql: "insert or ignore into pack_card_skills (skills_json) values (?)",
      args: [payload] as InValue[],
    })),
  );
  for (const batch of chunked(missing)) {
    const rows = (await exec(
      db,
      `select id, skills_json from pack_card_skills where skills_json in (${batch.map(() => "?").join(", ")})`,
      batch as InValue[],
    )).rows;
    for (const row of rows) ids.set(String(row.skills_json), Number(row.id));
  }
  return ids;
}

/* The interned id for one card's snapshot, or null when it carries none. */
function skillsIdFor(card: StoredPackCard, skillsIds: Map<string, number>): number | null {
  if (card.skills == null) return null;
  return skillsIds.get(JSON.stringify(card.skills)) ?? null;
}

/* The variant slot a card occupies in pack_cards. The catalog's tier column is
   part of its primary key, so an unrated card stores '' rather than null. */
export function packCardTierSlot(tier: string | null): string {
  return tier ?? "";
}

/* Where a card is stored: the key it already sits on when the caller resolved
   one, else the key its tier derives. Only the wallet import resolves one, and
   only for a granted card the collector is known to hold. */
function storedCardKey(card: StoredPackCard): string {
  return card.cardKey ?? packCardKey(card.userId, card.tier);
}

const IN_CHUNK = 500;

function chunked<T>(values: T[], size = IN_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/* Catalog writes for a batch of client cards.

   First write wins: a name and avatar reach the public share card and its OG
   image, so a later forged wallet sync must not repaint a card every other
   collector already holds. Identity comes from the users row when the backend
   knows the player, so a first-writer only ever names players the server
   cannot vouch for (honoraries and the like), exactly like the pull log.

   Reads happen first, so a steady-state sync (every variant already known)
   contributes nothing to the write batch at all. */
async function packCardIdentityStatements(db: Db, cards: StoredPackCard[], now: number): Promise<DbStatement[]> {
  const byVariant = new Map<string, StoredPackCard>();
  for (const card of cards) {
    byVariant.set(`${storedCardKey(card)}|${packCardTierSlot(card.tier)}`, card);
  }

  const known = new Set<string>();
  const cardKeys = [...new Set([...byVariant.values()].map(storedCardKey))];
  for (const keys of chunked(cardKeys)) {
    const rows = (await exec(
      db,
      `select card_key, tier from pack_cards where card_key in (${keys.map(() => "?").join(", ")})`,
      keys as InValue[],
    )).rows;
    for (const row of rows) known.add(`${String(row.card_key)}|${String(row.tier)}`);
  }

  const missing = [...byVariant.entries()].filter(([variant]) => !known.has(variant)).map(([, card]) => card);
  if (missing.length === 0) return [];

  const identities = new Map<number, { username: string; avatarUrl: string; countryCode: string }>();
  const missingIds = [...new Set(missing.map((card) => card.userId))];
  for (const ids of chunked(missingIds)) {
    const rows = (await exec(
      db,
      `select user_id, username, avatar_url, country_code from users where user_id in (${ids.map(() => "?").join(", ")})`,
      ids as InValue[],
    )).rows;
    for (const row of rows) {
      identities.set(Number(row.user_id), {
        username: String(row.username ?? "").slice(0, PACK_CARD_USERNAME_MAX_CHARS),
        avatarUrl: String(row.avatar_url ?? "").slice(0, PACK_CARD_AVATAR_URL_MAX_CHARS),
        countryCode: normalizeCountryCode(String(row.country_code ?? "")),
      });
    }
  }

  return missing.map((card) => {
    const vouched = identities.get(card.userId);
    return {
      sql: `insert or ignore into pack_cards (
         card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        storedCardKey(card),
        packCardTierSlot(card.tier),
        card.userId,
        vouched?.username || card.username,
        vouched?.avatarUrl || card.avatarUrl,
        vouched?.countryCode || card.countryCode,
        card.tierLabel,
        now,
      ] as InValue[],
    };
  });
}

/* This owner's ownership row for one card: copies, recycle balance, pull
   stamps, current pp/rank, the tier they hold it at, and the snapshot their
   mint froze. Only a better tier overwrites the tier or the snapshot, which is
   the rule the fat row carried before the split. */
function packOwnershipUpsertStatement(
  ownerUserId: number,
  card: StoredPackCard,
  now: number,
  mode: PackWalletCardImportMode,
  skillsIds: Map<string, number>,
): DbStatement {
  const copiesSql =
    mode === "delta"
      ? "max(0, pack_collection_cards.copies + excluded.copies)"
      : `max(
          0,
          max(
            pack_collection_cards.copies + pack_collection_cards.recycled_copies,
            excluded.copies + excluded.recycled_copies
          ) - max(pack_collection_cards.recycled_copies, excluded.recycled_copies)
        )`;
  const recycledCopiesSql =
    mode === "delta"
      ? "max(0, pack_collection_cards.recycled_copies + excluded.recycled_copies)"
      : "max(pack_collection_cards.recycled_copies, excluded.recycled_copies)";
  return {
    sql: `insert into pack_collection_cards (
       owner_user_id, card_user_id, card_key, tier, skills_id, pp, global_rank,
       copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(owner_user_id, card_key) do update set
       tier = case
         when ${tierRankSql("pack_collection_cards.tier")} > ${tierRankSql("excluded.tier")}
         then pack_collection_cards.tier
         else excluded.tier
       end,
       skills_id = case
         when ${tierRankSql("pack_collection_cards.tier")} > ${tierRankSql("excluded.tier")}
         then coalesce(pack_collection_cards.skills_id, excluded.skills_id)
         else coalesce(excluded.skills_id, pack_collection_cards.skills_id)
       end,
       pp = excluded.pp,
       global_rank = excluded.global_rank,
       copies = ${copiesSql},
       recycled_copies = ${recycledCopiesSql},
       first_pulled_at = min(pack_collection_cards.first_pulled_at, excluded.first_pulled_at),
       last_pulled_at = max(pack_collection_cards.last_pulled_at, excluded.last_pulled_at),
       updated_at = excluded.updated_at`,
    args: [
      ownerUserId,
      card.userId,
      storedCardKey(card),
      card.tier,
      skillsIdFor(card, skillsIds),
      card.pp,
      card.globalRank,
      card.copies,
      card.recycledCopies,
      card.firstPulledAt,
      card.lastPulledAt,
      now,
    ],
  };
}

/* Imports can carry thousands of cards, while db.ts deliberately caps one
   libsql batch at 500 statements. Keep each ownership insert beside its serial
   insert inside a bounded transaction so even a crash between chunks cannot
   create the gap the old boot sweep repaired. Identity may add one statement
   per card, hence 150 rather than the generic 500-row read chunk. */
async function writeImportedPackCards(
  db: Db,
  ownerUserId: number,
  cards: StoredPackCard[],
  now: number,
  mode: PackWalletCardImportMode,
  skillsIds: Map<string, number>,
): Promise<void> {
  for (const batch of chunked(cards, 150)) {
    const ownershipAndSerials = batch.flatMap((card) => [
      packOwnershipUpsertStatement(ownerUserId, card, now, mode, skillsIds),
      ...(card.copies > 0
        ? [mintPackCardSerialStatement(
            storedCardKey(card),
            card.userId,
            ownerUserId,
            card.firstPulledAt > 0 ? card.firstPulledAt : now,
          )]
        : []),
    ]);
    await execBatch(db, [
      ...(await packCardIdentityStatements(db, batch, now)),
      ...ownershipAndSerials,
    ]);
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cardFromRow(row: Record<string, unknown>): StoredPackCard {
  return {
    userId: Number(row.card_user_id),
    cardKey: typeof row.card_key === "string" ? row.card_key : packCardKey(Number(row.card_user_id), typeof row.tier === "string" ? row.tier : null),
    username: nonEmptyString(row.live_username) ?? String(row.username ?? ""),
    avatarUrl: nonEmptyString(row.live_avatar_url) ?? String(row.avatar_url ?? ""),
    countryCode: nonEmptyString(row.live_country_code) ?? String(row.country_code ?? ""),
    tier: typeof row.tier === "string" ? row.tier : null,
    tierLabel: nonEmptyString(row.tier_label) ?? nonEmptyString(row.catalog_tier_label),
    customLabel: nonEmptyString(row.tier_label),
    motif: parseCardMotif(row.motif),
    skills: row.skills_json ? parseJson<unknown | null>(String(row.skills_json), null) : null,
    pp: Number(row.pp) || 0,
    globalRank: Number(row.global_rank) || 0,
    copies: Number(row.copies) || 0,
    recycledCopies: Number(row.recycled_copies) || 0,
    firstPulledAt: Number(row.first_pulled_at) || 0,
    lastPulledAt: Number(row.last_pulled_at) || 0,
    grantedAt: Number(row.granted_at) > 0 ? Number(row.granted_at) : null,
    serial: Number(row.serial) > 0 ? Number(row.serial) : null,
    mintedTotal: Number(row.minted_total) || 0,
  };
}

/* Every motif URL any holding currently floats, deduped.

   Read by the frontend's /api/card-motif proxy, which refuses to fetch a URL
   that is not on this list. That is the whole reason the endpoint exists: the
   proxy has to serve the image with CORS headers for the card canvas, and
   without an allowlist it would be an open image proxy on our own domain.
   Grants are the only writer and there are a handful of them, so the list is
   tiny and the proxy can hold it in memory. */
export async function listPackCardMotifUrls(db: Db): Promise<string[]> {
  const rows = (await exec(
    db,
    "select distinct motif from pack_collection_cards where motif is not null and motif != ''",
  )).rows;
  const urls = new Set<string>();
  for (const row of rows) {
    const motif = parseCardMotif(row.motif);
    if (motif) urls.add(motif.url);
  }
  return [...urls];
}

export async function getPackWallet(db: Db, userId: number): Promise<StoredPackWallet | null> {
  const row = (await exec(db, "select payload, rev, updated_at from pack_wallets where user_id = ?", [userId])).rows[0];
  if (!row) return null;
  const payload = String(row.payload);
  const stripped = stripCardsFromPayload(payload);
  if (stripped !== payload) {
    const updatedAt = Date.now();
    await importCardsFromPayload(db, userId, payload, updatedAt, "snapshot");
    await exec(db, "update pack_wallets set payload = ?, updated_at = ? where user_id = ?", [stripped, updatedAt, userId]);
  }
  return { payload: stripped, rev: Number(row.rev), updatedAt: Number(row.updated_at) };
}

export async function savePackWallet(
  db: Db,
  userId: number,
  payload: string,
  baseRev: number,
  now = Date.now(),
  cardImportMode: PackWalletCardImportMode = "snapshot",
): Promise<SavePackWalletResult> {
  const strippedPayload = stripCardsFromPayload(payload);
  const existing = await getPackWallet(db, userId);
  if (!existing) {
    const inserted = await exec(
      db,
      "insert into pack_wallets (user_id, payload, rev, updated_at) values (?, ?, 1, ?) on conflict(user_id) do nothing",
      [userId, strippedPayload, now],
    );
    if (Number(inserted.rowsAffected ?? 0) > 0) {
      await importCardsFromPayload(db, userId, payload, now, cardImportMode);
      return { ok: true, rev: 1 };
    }
    const current = await getPackWallet(db, userId);
    return current ? { ok: false, current } : { ok: true, rev: 1 };
  }
  const nextRev = existing.rev + 1;
  const updated = await exec(
    db,
    "update pack_wallets set payload = ?, rev = ?, updated_at = ? where user_id = ? and rev = ?",
    [strippedPayload, nextRev, now, userId, baseRev],
  );
  if (Number(updated.rowsAffected ?? 0) > 0) {
    await importCardsFromPayload(db, userId, payload, now, cardImportMode);
    return { ok: true, rev: nextRev };
  }
  const current = await getPackWallet(db, userId);
  return { ok: false, current: current ?? existing };
}

export async function listPackCollectionCards(
  db: Db,
  userId: number,
  options: {
    page: number;
    pageSize: number;
    tier?: string | null;
    query?: string | null;
    /* "newest" orders by when the card first joined the collection (a
       duplicate pull does not resurface an old card); anything else is the
       default rarity order. Legacy cards without a timestamp sink to the end,
       still in rarity order among themselves. */
    sort?: "newest" | null;
    /* When set, only cards of these players are listed (the "not tracked"
       filter). Empty means match nothing. */
    restrictToCardUserIds?: readonly number[];
  },
): Promise<PackCollectionPage> {
  const pageSize = Math.min(PACK_COLLECTION_MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize)));
  const page = Math.max(0, Math.floor(options.page));
  // Table-qualified because the paged read joins the serial registry, which
  // carries an owner_user_id of its own; the unjoined count queries below take
  // the qualified form just as happily.
  const where = ["pack_collection_cards.owner_user_id = ?", "pack_collection_cards.copies > 0"];
  const args: InValue[] = [userId];
  const query = options.query?.trim().toLowerCase() ?? "";
  if (query) {
    where.push(`lower(${displayUsernameSql}) like ?`);
    args.push(`%${query}%`);
  }
  if (options.restrictToCardUserIds) {
    where.push(cardUserIdRestrictionSql(options.restrictToCardUserIds));
  }
  if (options.tier && options.tier !== "all") {
    if (options.tier === "unrated") where.push("pack_collection_cards.tier is null");
    else {
      where.push("pack_collection_cards.tier = ?");
      args.push(options.tier);
    }
  }
  const whereSql = where.join(" and ");
  const totalRow = (await exec(db, `select count(*) as total from pack_collection_cards where ${whereSql}`, args)).rows[0];
  const rows = (await exec(
    db,
    `${CARD_SELECT_SQL},
       ${liveUserFieldSql("username")} as live_username,
       ${liveUserFieldSql("avatar_url")} as live_avatar_url,
       ${liveUserFieldSql("country_code")} as live_country_code,
       serials.serial as serial,
       (select max(other.serial) from pack_card_serials other
         where other.card_key = pack_collection_cards.card_key) as minted_total
     from pack_collection_cards
     ${CARD_CATALOG_JOIN_SQL}
     left join pack_card_serials serials
       on serials.card_key = pack_collection_cards.card_key
       and serials.owner_user_id = pack_collection_cards.owner_user_id
     where ${whereSql}
     order by ${
       options.sort === "newest" ? "pack_collection_cards.first_pulled_at desc, " : ""
     }${tierRankSql("pack_collection_cards.tier")} desc, pack_collection_cards.pp desc,
       pack_collection_cards.global_rank asc, pc.username collate nocase asc
     limit ? offset ?`,
    [...args, pageSize, page * pageSize],
  )).rows;
  const tierRows = (await exec(
    db,
    `select coalesce(tier, 'unrated') as tier, count(*) as count
     from pack_collection_cards
     where owner_user_id = ? and copies > 0
     group by coalesce(tier, 'unrated')`,
    [userId],
  )).rows;
  const duplicateRow = (await exec(
    db,
    `select coalesce(sum(max(copies - 1, 0) * ${duplicateShardValueSql("tier")}), 0) as total
     from pack_collection_cards
     where owner_user_id = ? and copies > 0`,
    [userId],
  )).rows[0];
  const filteredShardRow = (await exec(
    db,
    `select coalesce(sum(${wholeCardShardValueSql("tier")}), 0) as total
     from pack_collection_cards
     where ${whereSql}`,
    args,
  )).rows[0];
  return {
    cards: rows.map((row) => cardFromRow(row as Record<string, unknown>)),
    total: Number(totalRow?.total) || 0,
    tierCounts: Object.fromEntries(tierRows.map((row) => [String(row.tier), Number(row.count) || 0])),
    duplicateShardTotal: Number(duplicateRow?.total) || 0,
    filteredShardTotal: Number(filteredShardRow?.total) || 0,
  };
}

/* One holding, in the exact shape the paged read hands back - identity
   overlay, interned snapshot and serial included. Written as its own query
   rather than a filter over listPackCollectionCards so reading a single card
   back does not also compute that owner's tier counts and shard totals. Unlike
   the paged read it does not require copies > 0, since the caller that wants
   one card by key (the admin grant desk) wants to see a zeroed row too. */
export async function getPackCollectionCard(
  db: Db,
  ownerUserId: number,
  cardKey: string,
): Promise<StoredPackCard | null> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return null;
  const row = (await exec(
    db,
    `${CARD_SELECT_SQL},
       ${liveUserFieldSql("username")} as live_username,
       ${liveUserFieldSql("avatar_url")} as live_avatar_url,
       ${liveUserFieldSql("country_code")} as live_country_code,
       serials.serial as serial,
       (select max(other.serial) from pack_card_serials other
         where other.card_key = pack_collection_cards.card_key) as minted_total
     from pack_collection_cards
     ${CARD_CATALOG_JOIN_SQL}
     left join pack_card_serials serials
       on serials.card_key = pack_collection_cards.card_key
       and serials.owner_user_id = pack_collection_cards.owner_user_id
     where pack_collection_cards.owner_user_id = ? and pack_collection_cards.card_key = ?
     limit 1`,
    [ownerUserId, cardKey],
  )).rows[0];
  return row ? cardFromRow(row as Record<string, unknown>) : null;
}

/* The showcase shelf: up to five cards a collector pins to their public
   profile page. Reads join the collection on (owner, card_key, copies > 0),
   so a pinned card that gets fully recycled falls off the shelf on its own
   and a pin can never show a card the owner does not hold. */
export const PACK_SHOWCASE_MAX_CARDS = 5;

export async function getPackShowcase(db: Db, ownerUserId: number): Promise<StoredPackCard[]> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return [];
  const rows = (await exec(
    db,
    `${CARD_SELECT_SQL},
       ${liveUserFieldSql("username")} as live_username,
       ${liveUserFieldSql("avatar_url")} as live_avatar_url,
       ${liveUserFieldSql("country_code")} as live_country_code,
       serials.serial as serial,
       (select max(other.serial) from pack_card_serials other
         where other.card_key = pack_collection_cards.card_key) as minted_total
     from pack_showcase_cards
     join pack_collection_cards
       on pack_collection_cards.owner_user_id = pack_showcase_cards.owner_user_id
       and pack_collection_cards.card_key = pack_showcase_cards.card_key
       and pack_collection_cards.copies > 0
     ${CARD_CATALOG_JOIN_SQL}
     left join pack_card_serials serials
       on serials.card_key = pack_collection_cards.card_key
       and serials.owner_user_id = pack_collection_cards.owner_user_id
     where pack_showcase_cards.owner_user_id = ?
     order by pack_showcase_cards.position asc
     limit ${PACK_SHOWCASE_MAX_CARDS}`,
    [ownerUserId],
  )).rows;
  return rows.map((row) => cardFromRow(row as Record<string, unknown>));
}

/* Replaces the shelf with the given keys, in order. Unknown, malformed, and
   unowned keys are dropped rather than rejected, so a stale client (say, one
   holding a card that was recycled in another tab) converges instead of
   erroring. Returns the keys that actually landed. */
export async function setPackShowcase(db: Db, ownerUserId: number, cardKeys: unknown): Promise<string[]> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return [];
  // Unowned keys drop before the cap so a stale pin can't evict a valid one;
  // the pre-cap bound just keeps the ownership lookup small.
  const requested = Array.isArray(cardKeys)
    ? [...new Set(cardKeys.map(normalizePackCardKey).filter((key): key is string => key !== null))].slice(0, PACK_SHOWCASE_MAX_CARDS * 10)
    : [];
  let kept: string[] = [];
  if (requested.length > 0) {
    const placeholders = requested.map(() => "?").join(", ");
    const ownedRows = (await exec(
      db,
      `select card_key from pack_collection_cards
       where owner_user_id = ? and copies > 0 and card_key in (${placeholders})`,
      [ownerUserId, ...requested],
    )).rows;
    const owned = new Set(ownedRows.map((row) => String(row.card_key)));
    kept = requested.filter((key) => owned.has(key)).slice(0, PACK_SHOWCASE_MAX_CARDS);
  }
  const now = Date.now();
  /* A card that was already on the shelf keeps the stamp it went up with. The
     wall is ordered by it, so it has to mean "when this card was chosen": if
     the whole shelf were restamped, reordering your five would refloat all
     five, and dropping one card would drag the other four back to the front
     with it. */
  const stampedAt = new Map(
    (await exec(
      db,
      "select card_key, updated_at from pack_showcase_cards where owner_user_id = ?",
      [ownerUserId],
    )).rows.map((row) => [String(row.card_key), Number(row.updated_at) || now]),
  );
  await execBatch(db, [
    { sql: "delete from pack_showcase_cards where owner_user_id = ?", args: [ownerUserId] },
    ...kept.map((key, position) => ({
      sql: "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, ?, ?, ?)",
      args: [ownerUserId, position, key, stampedAt.get(key) ?? now] as InValue[],
    })),
  ]);
  return kept;
}

/* The showcase wall, one row per chosen card rather than one per collector.
   Most recently chosen first, which with the stamp above means the card that
   most recently went up, not the shelf most recently touched.

   Paged over the cards because that is what the page shows: a gallery you
   browse, where whose card it is comes out of inspecting it. The table holds
   at most five rows per collector, so the sort is over thousands of rows even
   with every collector on the site taking part. */
export interface ShowcasedCard {
  ownerUserId: number;
  showcasedAt: number;
  card: StoredPackCard;
}

export async function listShowcasedCards(
  db: Db,
  options: { page: number; pageSize: number },
): Promise<{ cards: ShowcasedCard[]; total: number }> {
  const pageSize = Math.min(60, Math.max(1, Math.floor(options.pageSize) || 1));
  const page = Math.max(0, Math.floor(options.page) || 0);
  // Pins whose card has since been fully recycled draw nothing, so they are
  // not counted either; otherwise the last page could come back empty.
  const joinSql = `from pack_showcase_cards
     join pack_collection_cards
       on pack_collection_cards.owner_user_id = pack_showcase_cards.owner_user_id
       and pack_collection_cards.card_key = pack_showcase_cards.card_key
       and pack_collection_cards.copies > 0`;
  const total = Number((await exec(db, `select count(*) as total ${joinSql}`)).rows[0]?.total) || 0;
  if (total === 0) return { cards: [], total: 0 };
  const rows = (await exec(
    db,
    `${CARD_SELECT_SQL},
       ${liveUserFieldSql("username")} as live_username,
       ${liveUserFieldSql("avatar_url")} as live_avatar_url,
       ${liveUserFieldSql("country_code")} as live_country_code,
       serials.serial as serial,
       (select max(other.serial) from pack_card_serials other
         where other.card_key = pack_collection_cards.card_key) as minted_total,
       pack_showcase_cards.updated_at as showcased_at
     ${joinSql}
     ${CARD_CATALOG_JOIN_SQL}
     left join pack_card_serials serials
       on serials.card_key = pack_collection_cards.card_key
       and serials.owner_user_id = pack_collection_cards.owner_user_id
     order by pack_showcase_cards.updated_at desc,
       pack_showcase_cards.owner_user_id asc, pack_showcase_cards.position asc
     limit ? offset ?`,
    [pageSize, page * pageSize],
  )).rows;
  return {
    cards: rows.map((row) => ({
      ownerUserId: Number(row.owner_user_id),
      showcasedAt: Number(row.showcased_at) || 0,
      card: cardFromRow(row as Record<string, unknown>),
    })),
    total,
  };
}

/**
 * Persists a re-mint of one collected card: the skills snapshot (and the tier
 * it implies) for a card collected before snapshots existed, or one whose mint
 * failed at pull time.
 *
 * A synced wallet keeps no cards in its blob — they live in these rows — so the
 * client cannot repair such a card by writing to its own wallet and pushing.
 * Without this the same card refetched its player's plays once per session,
 * every session, and threw the result away.
 *
 * Mirrors applyCardMint in the frontend's pack-collection, including the two
 * rules that matter: a card that already has skills is only overwritten by a
 * strictly better tier, and a tierless card that mints as GOAT changes key, so
 * it merges into any GOAT of that player the owner already holds.
 */
export async function applyPackCollectionCardMint(
  db: Db,
  ownerUserId: number,
  rawCardKey: unknown,
  /* pp/globalRank are the card's face numbers, sent by the post-draw mint
     pass: a server-dealt GOAT lands with no real numbers (the roster's peaks
     live in the frontend mirror), so the mint that labels it fills them in.
     Display-only, bounded, and never applied to a card whose mint is being
     refused. */
  mint: { tier?: unknown; tierLabel?: unknown; skills?: unknown; pp?: unknown; globalRank?: unknown },
  now = Date.now(),
): Promise<{ applied: boolean; cardKey: string | null }> {
  const cardKey = normalizePackCardKey(rawCardKey);
  if (!cardKey || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return { applied: false, cardKey: null };
  const skills = mint.skills && typeof mint.skills === "object" && !Array.isArray(mint.skills) ? mint.skills : null;
  if (!skills) return { applied: false, cardKey: null };
  const row = (await exec(
    db,
    `select card_user_id, tier, skills_id, pp, global_rank
     from pack_collection_cards
     where owner_user_id = ? and card_key = ? and copies > 0`,
    [ownerUserId, cardKey],
  )).rows[0];
  if (!row) return { applied: false, cardKey: null };

  const cardUserId = Number(row.card_user_id);
  if (!Number.isInteger(cardUserId) || cardUserId <= 0) return { applied: false, cardKey: null };
  // Same GOAT guard the wallet import applies: a claimed tier is otherwise
  // taken on trust, and GOAT recycles for 500 shards.
  const claimed = claimedTier(mint, cardUserId);
  const currentTier = typeof row.tier === "string" ? row.tier : null;
  const outranksClaim = tierRank(currentTier) >= tierRank(claimed);
  if (row.skills_id != null && outranksClaim) return { applied: false, cardKey };
  /* A row with no snapshot otherwise takes the mint whole, lower tier and all,
     since the freshly computed version is the only one that can actually be
     drawn. Two exceptions, and both are about a claim that says nothing useful
     rather than something lower:

     - an AWARDED tier, which nothing recomputed from a player's plays can
       arrive at. A granted Eternal lands with no snapshot, the collection's
       repair pass mints one, and claimedTier refuses the "eternal" it sends
       back, so folding the snapshot and the tier into one decision gave that
       card its stat bars and took its rarity away in the same write;
     - a claim of nothing at all, whether the mint sent no tier or sent one
       this route refuses. A mint may relabel a card; it may not un-label one. */
  const keepsCurrentTier =
    outranksClaim && currentTier !== null && (claimed === null || AWARDED_TIERS.has(currentTier));
  const tier = keepsCurrentTier ? currentTier : claimed;
  // The label describes the tier the mint claimed, so it only travels with it.
  const tierLabel =
    tier !== null && tier === claimed ? (typeof mint.tierLabel === "string" ? mint.tierLabel.slice(0, 60) : null) : null;
  const skillsJson = JSON.stringify(skills);
  if (skillsJson.length > PACK_CARD_SKILLS_MAX_CHARS) return { applied: false, cardKey };
  const mintPp = Math.min(PACK_CARD_MAX_PP, Math.max(0, toFiniteNumber(mint.pp, 0)));
  const mintGlobalRank = Math.max(0, Math.floor(toFiniteNumber(mint.globalRank, 0)));
  // Only fills a row that has no numbers yet (a freshly dealt GOAT); a card
  // minted from the ranked pool already carries the pool board's figures.
  const faceNumberStatement = (targetKey: string): DbStatement[] =>
    mintPp > 0
      ? [{
          sql: `update pack_collection_cards set pp = ?, global_rank = ?, updated_at = ?
                where owner_user_id = ? and card_key = ? and pp <= 0`,
          args: [mintPp, mintGlobalRank, now, ownerUserId, targetKey],
        }]
      : [];

  /* A granted card stays on its own key. Every other row's key is derived from
     its tier, so a mint that changes the tier moves the row; a variant number
     is not derivable, and following that rule here would fold a hand-granted
     card into the player's ordinary one the first time the collection's repair
     pass minted it a snapshot. */
  const nextKey = isPackCardVariantKey(cardKey) ? cardKey : packCardKey(cardUserId, tier);
  const tierSlot = packCardTierSlot(tier);
  const skillsId = (await internPackCardSkills(db, [skillsJson])).get(skillsJson) ?? null;
  const statements: DbStatement[] = [
    // The variant this mint lands on, seeded if the catalog never saw it.
    // Identity comes from the users row when there is one, else from whatever
    // variant of this card the catalog already holds, since this route carries
    // no identity of its own.
    {
      sql: `insert or ignore into pack_cards (
              card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
            )
            select ?, ?, ?,
              coalesce((select u.username from users u where u.user_id = ?),
                (select pc.username from pack_cards pc where pc.card_user_id = ? and pc.username != '' limit 1), ''),
              coalesce((select u.avatar_url from users u where u.user_id = ?),
                (select pc.avatar_url from pack_cards pc where pc.card_user_id = ? and pc.avatar_url != '' limit 1), ''),
              coalesce((select u.country_code from users u where u.user_id = ?),
                (select pc.country_code from pack_cards pc where pc.card_user_id = ? and pc.country_code != '' limit 1), ''),
              ?, ?`,
      args: [
        nextKey, tierSlot, cardUserId,
        cardUserId, cardUserId,
        cardUserId, cardUserId,
        cardUserId, cardUserId,
        tierLabel,
        now,
      ],
    },
    // A variant seeded before this mint may have no label yet; the mint's is
    // the first one that describes it.
    {
      sql: "update pack_cards set tier_label = coalesce(tier_label, ?), updated_at = ? where card_key = ? and tier = ?",
      args: [tierLabel, now, nextKey, tierSlot],
    },
  ];

  if (nextKey === cardKey) {
    statements.push({
      sql: `update pack_collection_cards
            set tier = ?, skills_id = ?, updated_at = ?
            where owner_user_id = ? and card_key = ?`,
      args: [tier, skillsId, now, ownerUserId, cardKey],
    });
    statements.push(...faceNumberStatement(cardKey));
    await execBatch(db, statements);
    return { applied: true, cardKey };
  }

  // Key move: fold this card's copies into the destination key, then drop the
  // old row. One batch so a crash can never leave the copies duplicated across
  // both keys (or lost from both).
  statements.push(
    {
      sql: `insert into pack_collection_cards (
              owner_user_id, card_user_id, card_key, tier, skills_id, pp, global_rank,
              copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
            )
            select owner_user_id, card_user_id, ?, ?, ?, pp, global_rank, copies, recycled_copies,
              first_pulled_at, last_pulled_at, ?
            from pack_collection_cards
            where owner_user_id = ? and card_key = ?
            on conflict(owner_user_id, card_key) do update set
              tier = excluded.tier,
              skills_id = excluded.skills_id,
              copies = pack_collection_cards.copies + excluded.copies,
              recycled_copies = pack_collection_cards.recycled_copies + excluded.recycled_copies,
              first_pulled_at = min(pack_collection_cards.first_pulled_at, excluded.first_pulled_at),
              last_pulled_at = max(pack_collection_cards.last_pulled_at, excluded.last_pulled_at),
              updated_at = excluded.updated_at`,
      args: [nextKey, tier, skillsId, now, ownerUserId, cardKey],
    },
    {
      sql: "delete from pack_collection_cards where owner_user_id = ? and card_key = ?",
      args: [ownerUserId, cardKey],
    },
    ...movePackCardKeyReferencesStatements(ownerUserId, cardKey, nextKey),
    ...faceNumberStatement(nextKey),
  );
  await execBatch(db, statements);
  return { applied: true, cardKey: nextKey };
}

/* The key a granted card should live under, given what the desk is granting.
 *
 * A customization the player already has a variant for reuses that variant's
 * number, wherever it is held: handing the same card to a second collector has
 * to put them both in the same collectible, or "in N collections" is back to
 * counting nothing. Anything new mints the next number for that player.
 *
 * Matching is on the three granted fields exactly, nulls included, which is
 * why it compares the stored text rather than a parsed motif: two grants are
 * the same card when the desk wrote the same thing. */
export async function resolvePackCardVariantKey(
  db: Db,
  cardUserId: number,
  customization: PackCardCustomization,
): Promise<string> {
  const prefix = `${cardUserId}:v`;
  const match = (await exec(
    db,
    `select card_key from pack_collection_cards
     where card_user_id = ? and card_key like ?
       and tier is ? and tier_label is ? and motif is ?
     order by card_key asc limit 1`,
    [cardUserId, `${prefix}%`, customization.tier, customization.tierLabel, customization.motif],
  )).rows[0];
  const existing = typeof match?.card_key === "string" ? match.card_key : null;
  if (existing && isPackCardVariantKey(existing)) return existing;
  return packCardVariantKey(cardUserId, await nextPackCardVariantNumber(db, cardUserId));
}

/* One past the highest variant number this player has ever had, counting the
   catalog as well as the collections: a variant whose only holder recycled it
   away keeps its number rather than handing it to a different card. */
async function nextPackCardVariantNumber(db: Db, cardUserId: number): Promise<number> {
  const prefix = `${cardUserId}:v`;
  const rows = (await exec(
    db,
    `select card_key from pack_collection_cards where card_user_id = ? and card_key like ?
     union
     select card_key from pack_cards where card_user_id = ? and card_key like ?`,
    [cardUserId, `${prefix}%`, cardUserId, `${prefix}%`],
  )).rows;
  let highest = 0;
  for (const row of rows) {
    const key = typeof row.card_key === "string" ? row.card_key : "";
    highest = Math.max(highest, packCardVariantNumber(key));
  }
  return highest + 1;
}

/* A skills snapshot is a handful of named numbers; anything larger is not one. */
const PACK_CARD_SKILLS_MAX_CHARS = 2_000;

/* Card keys rather than player ids: holding an ordinary card of a roster
   member is not holding their GOAT, and duplicate protection has to tell
   those apart. */
export async function listPackCollectionOwnedCardKeys(db: Db, userId: number): Promise<string[]> {
  const rows = (await exec(
    db,
    `select card_key
     from pack_collection_cards
     where owner_user_id = ? and copies > 0
     order by card_key asc`,
    [userId],
  )).rows;
  return rows
    .map((row) => (typeof row.card_key === "string" ? row.card_key : null))
    .filter((key): key is string => key !== null);
}

/* One slot of a server-dealt hand, as the draw route hands it over: ranked
   slots carry the pool board's identity, honorary slots carry tier "goat" and
   whatever identity the roster mirror has (usually none - deleted accounts). */
export interface DealtPackCardSlot {
  userId: number;
  tier: "goat" | null;
  username: string;
  avatarUrl: string;
  countryCode: string;
  pp: number;
  globalRank: number;
}

/* Writes a dealt hand into the collection at draw time. This is what makes
   copy counts server-owned: the only things that add copies to a signed-in
   collection are this (one per dealt slot) and the one-time first-sync merge,
   so a pushed wallet can no longer claim cards into existence. The client
   still reports each card's minted tier and skills afterwards (the maniacard
   rating runs in the browser), but applyPackCollectionCardMint only labels a
   row that already exists - it never adds one.

   A ranked slot lands with tier null and mints properly moments later; the
   tier-upgrade rule in the upsert means the label pass can never downgrade a
   card, and a goat slot's tier is set right here since roster membership is
   the server's to award. Returns whether each card key was new to this
   collection (no held copies before this hand), which is the reveal's NEW
   badge. */
export async function mintDealtPackCards(
  db: Db,
  ownerUserId: number,
  slots: readonly DealtPackCardSlot[],
  now = Date.now(),
): Promise<Map<string, boolean>> {
  const isNewByCardKey = new Map<string, boolean>();
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0 || slots.length === 0) return isNewByCardKey;

  const cards: StoredPackCard[] = slots
    .filter((slot) => Number.isInteger(slot.userId) && slot.userId > 0)
    .map((slot) => ({
      userId: slot.userId,
      username: slot.username.slice(0, PACK_CARD_USERNAME_MAX_CHARS),
      avatarUrl: normalizeAvatarUrl(slot.avatarUrl),
      countryCode: normalizeCountryCode(slot.countryCode),
      tier: slot.tier === "goat" && HONORARY_USER_IDS.has(slot.userId) ? "goat" : null,
      // The label belongs to the client's mint pass, like the skills.
      tierLabel: null,
      skills: null,
      pp: Math.min(PACK_CARD_MAX_PP, Math.max(0, slot.pp)),
      globalRank: Math.max(0, Math.floor(slot.globalRank)),
      copies: 1,
      recycledCopies: 0,
      firstPulledAt: now,
      lastPulledAt: now,
    }));
  if (cards.length === 0) return isNewByCardKey;

  const keys = [...new Set(cards.map((card) => packCardKey(card.userId, card.tier)))];
  const ownedRows = (await exec(
    db,
    `select card_key from pack_collection_cards
     where owner_user_id = ? and copies > 0 and card_key in (${keys.map(() => "?").join(", ")})`,
    [ownerUserId, ...keys],
  )).rows;
  const owned = new Set(ownedRows.map((row) => String(row.card_key)));
  for (const key of keys) isNewByCardKey.set(key, !owned.has(key));

  /* Ranked slots seed catalog identity from the pool board (or the users row,
     which packCardIdentityStatements prefers when it exists). Honorary slots
     carry no identity of their own, so their variant borrows from the users
     row or any variant of that player the catalog already holds - the same
     fallback the mint route uses. */
  const ranked = cards.filter((card) => card.tier !== "goat");
  const honorary = cards.filter((card) => card.tier === "goat");
  const honoraryIdentityStatement = (card: StoredPackCard): DbStatement => ({
    sql: `insert or ignore into pack_cards (
            card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
          )
          select ?, 'goat', ?,
            coalesce((select u.username from users u where u.user_id = ?),
              (select pc.username from pack_cards pc where pc.card_user_id = ? and pc.username != '' limit 1), ''),
            coalesce((select u.avatar_url from users u where u.user_id = ?),
              (select pc.avatar_url from pack_cards pc where pc.card_user_id = ? and pc.avatar_url != '' limit 1), ''),
            coalesce((select u.country_code from users u where u.user_id = ?),
              (select pc.country_code from pack_cards pc where pc.card_user_id = ? and pc.country_code != '' limit 1), ''),
            null, ?`,
    args: [
      packCardKey(card.userId, card.tier), card.userId,
      card.userId, card.userId,
      card.userId, card.userId,
      card.userId, card.userId,
      now,
    ],
  });
  /* A goat slot arrives with no real numbers (the roster's peak pp/rank live
     in the frontend mirror), so its upsert only counts the copy: an existing
     holding keeps the pp, tier and skills its mint froze, and a new row gets
     its face numbers from the client's mint pass moments later. */
  const goatOwnershipStatement = (card: StoredPackCard): DbStatement => ({
    sql: `insert into pack_collection_cards (
            owner_user_id, card_user_id, card_key, tier, skills_id, pp, global_rank,
            copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
          ) values (?, ?, ?, 'goat', null, ?, ?, 1, 0, ?, ?, ?)
          on conflict(owner_user_id, card_key) do update set
            copies = pack_collection_cards.copies + 1,
            first_pulled_at = min(pack_collection_cards.first_pulled_at, excluded.first_pulled_at),
            last_pulled_at = max(pack_collection_cards.last_pulled_at, excluded.last_pulled_at),
            updated_at = excluded.updated_at`,
    args: [ownerUserId, card.userId, packCardKey(card.userId, "goat"), card.pp, card.globalRank, now, now, now],
  });
  await execBatch(db, [
    ...(await packCardIdentityStatements(db, ranked, now)),
    ...honorary.map(honoraryIdentityStatement),
    ...ranked.map((card) => packOwnershipUpsertStatement(ownerUserId, card, now, "delta", new Map())),
    ...honorary.map(goatOwnershipStatement),
    // The serial is part of accepting the hand, not of the browser's later
    // community report. The pending bit preserves first-global until that
    // report lands and is settled in pack-pulls.ts.
    ...cards.map((card) => mintPackCardSerialStatement(
      packCardKey(card.userId, card.tier),
      card.userId,
      ownerUserId,
      now,
      { pullReportPending: true },
    )),
  ]);
  return isNewByCardKey;
}

/* Bounds for the one first-sync import below. Honest anonymous wallets fit
   comfortably (per-card copies rarely reach double digits, duplicates in the
   hundreds mean hundreds of packs opened logged-out); what the caps bound is
   a hand-written localStorage wallet, whose one shot at the server is this
   call. Everything here inflates only the importer's own account - shards and
   cards are not transferable - so the caps are about keeping that inflation
   small, not about protecting anyone else's collection. */
const WALLET_IMPORT_MAX_DISTINCT_CARDS = 8_000;
const WALLET_IMPORT_MAX_COPIES_PER_CARD = 100;
const WALLET_IMPORT_DUPLICATE_BUDGET = 1_000;
const WALLET_IMPORT_MAX_SHARDS = 2_000;
const WALLET_IMPORT_MAX_OPENED_PACKS = 100_000;

export interface PackWalletMergeResult {
  merged: boolean;
  wallet: StoredPackWallet;
  /* What actually came in, for the route's log line. Null when not merged. */
  imported: { cards: number; copies: number; shards: number; droppedCards: number } | null;
}

/* Folds a browser-local wallet (the anonymous history from before this
   account's first sign-in) into the server wallet, once per account ever.

   The gate is "this account never really played server-side": no banked or
   spent shards, no opened packs, no collection rows, and no earlier import.
   That is the only moment a client-authored economy is believed at all, and
   it is exactly the moment the pre-server-economy sync flow trusted too - the
   difference is that it now happens once, capped, instead of on every push.
   An account that already has history keeps it untouched and the local copy
   is simply superseded (a second device's never-synced leftovers are
   forfeited rather than merged; by this point in the feature's life those are
   stale mirrors, not history).

   Cards must name players the server can vouch for (a users row or the
   honorary roster) - an invented user id will never render a card face and
   would exist only to be recycled. Every distinct card keeps at least one
   copy so a big honest collection imports whole; the duplicate budget is what
   bounds the recycle value a forged import could mint. */
export async function mergeImportedPackWallet(
  db: Db,
  userId: number,
  claimedPayload: string,
  now = Date.now(),
): Promise<PackWalletMergeResult> {
  const wallet = await getOrCreatePackWallet(db, userId, now);
  const parsed = parseJson<WalletPayload | null>(wallet.payload, null) ?? {};
  const economy = economyFromParsedPayload(parsed, now);
  const hasEconomyHistory =
    Boolean(parsed.importedAt) || economy.shards > 0 || economy.shardsSpent > 0 || economy.openedPacks > 0;
  if (hasEconomyHistory) return { merged: false, wallet, imported: null };
  const heldRow = (await exec(
    db,
    "select count(*) as held from pack_collection_cards where owner_user_id = ? and copies > 0",
    [userId],
  )).rows[0];
  if (Number(heldRow?.held ?? 0) > 0) return { merged: false, wallet, imported: null };

  const claimed = parseJson<WalletPayload | null>(claimedPayload, null) ?? {};
  const rawCards = claimed.cards && typeof claimed.cards === "object" ? Object.values(claimed.cards) : [];
  let normalized = rawCards
    .map((card) => normalizeCard(card, now))
    .filter((card): card is StoredPackCard => card !== null && card.copies > 0);

  // Only players the server can vouch for.
  const unknownIds = [...new Set(normalized.map((card) => card.userId))].filter((id) => !HONORARY_USER_IDS.has(id));
  const known = new Set<number>(HONORARY_USER_IDS);
  for (const batch of chunked(unknownIds)) {
    const rows = (await exec(
      db,
      `select user_id from users where user_id in (${batch.map(() => "?").join(", ")})`,
      batch as InValue[],
    )).rows;
    for (const row of rows) known.add(Number(row.user_id));
  }
  const vouched = normalized.filter((card) => known.has(card.userId));
  const droppedCards = normalized.length - vouched.length + Math.max(0, vouched.length - WALLET_IMPORT_MAX_DISTINCT_CARDS);
  normalized = vouched.slice(0, WALLET_IMPORT_MAX_DISTINCT_CARDS);

  let duplicateBudget = WALLET_IMPORT_DUPLICATE_BUDGET;
  let importedCopies = 0;
  const cards = normalized.map((card) => {
    const copies = Math.min(card.copies, WALLET_IMPORT_MAX_COPIES_PER_CARD);
    const extras = Math.min(Math.max(0, copies - 1), duplicateBudget);
    duplicateBudget -= extras;
    importedCopies += 1 + extras;
    return {
      ...card,
      copies: 1 + extras,
      recycledCopies: Math.min(card.recycledCopies, WALLET_IMPORT_MAX_COPIES_PER_CARD),
    };
  });

  if (cards.length > 0) {
    const skillsIds = await internPackCardSkills(
      db,
      cards.filter((card) => card.skills != null).map((card) => JSON.stringify(card.skills)),
    );
    // Snapshot mode, so a retried merge (crash between a card chunk and the
    // wallet write below) converges instead of double-counting copies. Each
    // ownership row and serial are atomic within their bounded chunk.
    await writeImportedPackCards(db, userId, cards, now, "snapshot", skillsIds);
  }

  const grantedShards = Math.min(Math.max(0, Math.floor(toFiniteNumber(claimed.shards, 0))), WALLET_IMPORT_MAX_SHARDS);
  const claimedOpened = Math.min(
    Math.max(0, Math.floor(toFiniteNumber(claimed.openedPacks, 0))),
    WALLET_IMPORT_MAX_OPENED_PACKS,
  );
  const claimedPoolTotal = Math.floor(toFiniteNumber(claimed.poolTotal, 0));
  const nextPayload = JSON.stringify({
    ...parsed,
    cards: {},
    shards: economy.shards + grantedShards,
    shardsSpent: economy.shardsSpent,
    charges: economy.charges,
    lastRefillAt: economy.lastRefillAt,
    openedPacks: Math.max(economy.openedPacks, claimedOpened),
    poolTotal: economy.poolTotal ?? (claimedPoolTotal > 0 ? claimedPoolTotal : null),
    importedAt: now,
  });
  const nextRev = wallet.rev + 1;
  await exec(
    db,
    "update pack_wallets set payload = ?, rev = ?, updated_at = ? where user_id = ?",
    [nextPayload, nextRev, now, userId],
  );
  return {
    merged: true,
    wallet: { payload: nextPayload, rev: nextRev, updatedAt: now },
    imported: { cards: cards.length, copies: importedCopies, shards: grantedShards, droppedCards },
  };
}

/* pack_collection_cards used to be keyed (owner, player), one row per player.
   GOAT cards now stand apart from their player's ordinary card, so the key is
   (owner, card_key) instead. SQLite cannot alter a primary key, so a database
   created before this rebuilds the table once, deriving each row's key from
   the tier it already stores. Existing rows are all distinct by (owner,
   player), so no row can collide on the way in.

   Guarded on the column rather than a marker: the check is a pragma read, and
   tying it to the schema means a restored or hand-repaired database can never
   skip a rebuild it actually needs. */
/* Granted cards predate variant keys, so the ones already handed out sit on
   the player's ordinary key, where they are indistinguishable from a pulled
   card by anything but their columns. Moves each onto a variant key once, with
   its serial and its showcase slot, so every surface can address a card by key
   from here on and nothing has to match on tier, badge and art to guess.
 *
 * Grouped by what was granted, not by holder: two collectors handed the same
 * card land on one variant, which is the same rule the desk mints under.
 *
 * Legacy-only now: /admin/collections moves a named derived holding and all of
 * its references in the same transaction when an edit customizes it. Neither
 * predicate below can use an index, so server.ts runs this once for rows that
 * predate that invariant and records a permanent completion marker. */
export async function ensurePackCardVariantKeys(db: Db): Promise<number> {
  const grantOnly = [...GRANT_ONLY_TIERS].map((tier) => `'${tier}'`).join(", ") || "''";
  /* Two repairs in one scan, since neither predicate has an index and the
     table is millions of rows: the holdings still on a plain key, and the ones
     already moved but granted before there was a column saying so. */
  const rows = (await exec(
    db,
    `select owner_user_id, card_user_id, card_key, tier, tier_label, motif, first_pulled_at
     from pack_collection_cards
     where (card_key not like '%:%'
             and (tier_label is not null or motif is not null or tier in (${grantOnly})))
        or (card_key like '%:v%' and granted_at is null)
     order by card_user_id asc, owner_user_id asc`,
  )).rows;
  if (rows.length === 0) return 0;

  const statements: DbStatement[] = [];
  const now = Date.now();
  /* Numbers handed out inside this pass, so two holders of the same grant get
     the same key and two different grants of one player do not collide. */
  const assigned = new Map<string, string>();
  const nextByPlayer = new Map<number, number>();
  for (const row of rows) {
    const cardUserId = Number(row.card_user_id);
    const ownerUserId = Number(row.owner_user_id);
    const oldKey = String(row.card_key);
    const tier = typeof row.tier === "string" ? row.tier : null;
    const tierLabel = typeof row.tier_label === "string" ? row.tier_label : null;
    const motif = typeof row.motif === "string" ? row.motif : null;
    /* A card only the desk can have handed out, dated by the pull it stands
       in for, so nothing downstream says its holder pulled it. */
    const grantedAt = Number(row.first_pulled_at) || now;
    if (isPackCardVariantKey(oldKey)) {
      statements.push({
        sql: "update pack_collection_cards set granted_at = ? where owner_user_id = ? and card_key = ? and granted_at is null",
        args: [grantedAt, ownerUserId, oldKey],
      });
      continue;
    }
    const signature = `${cardUserId}|${tier ?? ""}|${tierLabel ?? ""}|${motif ?? ""}`;
    let newKey = assigned.get(signature);
    if (!newKey) {
      let next = nextByPlayer.get(cardUserId);
      if (next === undefined) next = await nextPackCardVariantNumber(db, cardUserId);
      newKey = packCardVariantKey(cardUserId, next);
      nextByPlayer.set(cardUserId, next + 1);
      assigned.set(signature, newKey);
      statements.push({
        // The variant's face, copied off the key it is leaving rather than
        // invented: the ordinary key's catalog row stays where it is, since
        // every collector who pulled this player still reads it.
        sql: `insert or ignore into pack_cards (
                card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
              )
              select ?, tier, card_user_id, username, avatar_url, country_code, tier_label, ?
              from pack_cards where card_key = ? and tier = ?`,
        args: [newKey, now, oldKey, packCardTierSlot(tier)],
      });
    }
    statements.push(
      {
        sql: `update pack_collection_cards set card_key = ?, updated_at = ?, granted_at = coalesce(granted_at, ?)
              where owner_user_id = ? and card_key = ?`,
        args: [newKey, now, grantedAt, ownerUserId, oldKey],
      },
      {
        // The mint order follows the card, not the key it used to sit on.
        sql: "update pack_card_serials set card_key = ? where card_key = ? and owner_user_id = ?",
        args: [newKey, oldKey, ownerUserId],
      },
      {
        sql: "update pack_showcase_cards set card_key = ? where owner_user_id = ? and card_key = ?",
        args: [newKey, ownerUserId, oldKey],
      },
    );
  }
  await execBatch(db, statements);
  logInfo("pack_card_variant_keys_backfilled", {
    holdings: rows.length,
    variants: assigned.size,
    detail: "moved hand-granted holdings onto their own card keys",
  });
  return rows.length;
}

export async function ensurePackCollectionCardKeys(db: Db): Promise<boolean> {
  const columns = (await exec(db, "pragma table_info(pack_collection_cards)")).rows;
  if (columns.length === 0) return false;
  if (columns.some((column) => String(column.name) === "card_key")) return false;

  await exec(db, "drop table if exists pack_collection_cards_rekey");
  await exec(
    db,
    `create table pack_collection_cards_rekey (
       owner_user_id integer not null,
       card_user_id integer not null,
       card_key text not null,
       username text not null,
       avatar_url text not null,
       country_code text not null,
       tier text,
       tier_label text,
       skills_json text,
       pp real not null,
       global_rank integer not null,
       copies integer not null,
       recycled_copies integer not null,
       first_pulled_at integer not null,
       last_pulled_at integer not null,
       updated_at integer not null,
       primary key(owner_user_id, card_key)
     )`,
  );
  await exec(
    db,
    `insert into pack_collection_cards_rekey
       (owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label,
        skills_json, pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at)
     select owner_user_id, card_user_id,
       case when tier = 'goat' then card_user_id || ':goat' else cast(card_user_id as text) end,
       username, avatar_url, country_code, tier, tier_label, skills_json, pp, global_rank, copies,
       recycled_copies, first_pulled_at, last_pulled_at, updated_at
     from pack_collection_cards`,
  );
  await exec(db, "drop table pack_collection_cards");
  await exec(db, "alter table pack_collection_cards_rekey rename to pack_collection_cards");
  // The indexes went with the old table.
  await exec(
    db,
    "create index if not exists idx_pack_collection_owner_rank on pack_collection_cards(owner_user_id, copies, global_rank)",
  );
  await exec(
    db,
    "create index if not exists idx_pack_collection_owner_tier on pack_collection_cards(owner_user_id, tier, copies, pp desc)",
  );
  await exec(
    db,
    "create index if not exists idx_pack_collection_owner_username on pack_collection_cards(owner_user_id, username)",
  );
  return true;
}

/* pack_collection_cards used to carry each card's name, avatar, country, tier
   label and skills snapshot on every ownership row. At a million-plus rows
   those columns were most of the table, and the identity ones were the same
   string over and over for every owner of a card.

   Identity moves to one row per variant in pack_cards. The snapshot does not
   collapse that way - it is frozen per owner at the pull that minted it, and
   owners who pulled the same player weeks apart genuinely hold different
   numbers - so it is interned instead: one pack_card_skills row per distinct
   snapshot, referenced by id. Every owner keeps exactly the snapshot they had,
   which is the difference between this and merging them.

   Guarded on the column rather than a marker, for the rekey's reason: a
   restored or hand-repaired database can never skip a rebuild it needs. Runs
   after ensurePackCollectionCardKeys, which guarantees card_key exists. */
export async function ensurePackCardCatalog(db: Db): Promise<boolean> {
  const columns = (await exec(db, "pragma table_info(pack_collection_cards)")).rows;
  if (columns.length === 0) return false;
  if (!columns.some((column) => String(column.name) === "username")) return false;

  // Identity per variant: the most recently written row wins, so a rename or
  // new avatar that reached any holding is the one the catalog keeps.
  await exec(
    db,
    `insert or ignore into pack_cards (
       card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
     )
     select card_key, coalesce(tier, ''), card_user_id, username, avatar_url, country_code,
       tier_label, updated_at
     from (
       select *, row_number() over (
         partition by card_key, coalesce(tier, '')
         order by updated_at desc, owner_user_id asc
       ) as rn
       from pack_collection_cards
     )
     where rn = 1`,
  );
  await exec(
    db,
    `insert or ignore into pack_card_skills (skills_json)
     select distinct skills_json from pack_collection_cards where skills_json is not null`,
  );

  await exec(db, "drop table if exists pack_collection_cards_slim");
  await exec(
    db,
    /* tier_label is declared here and filled with nothing on purpose. The fat
       row's label was the variant's own name for every owner, and the catalog
       has just taken it; the column on this side exists only for the per-owner
       override /admin/collections writes. Declaring it matters because this
       rebuild renames its table over pack_collection_cards, and the boot
       migration that adds the column has already run by then. */
    `create table pack_collection_cards_slim (
       owner_user_id integer not null,
       card_user_id integer not null,
       card_key text not null,
       tier text,
       tier_label text,
       skills_id integer,
       pp real not null,
       global_rank integer not null,
       copies integer not null,
       recycled_copies integer not null,
       first_pulled_at integer not null,
       last_pulled_at integer not null,
       updated_at integer not null,
       primary key(owner_user_id, card_key)
     )`,
  );
  await exec(
    db,
    `insert into pack_collection_cards_slim
       (owner_user_id, card_user_id, card_key, tier, skills_id, pp, global_rank, copies,
        recycled_copies, first_pulled_at, last_pulled_at, updated_at)
     select c.owner_user_id, c.card_user_id, c.card_key, c.tier, sk.id, c.pp, c.global_rank, c.copies,
       c.recycled_copies, c.first_pulled_at, c.last_pulled_at, c.updated_at
     from pack_collection_cards c
     left join pack_card_skills sk on sk.skills_json = c.skills_json`,
  );
  await exec(db, "drop table pack_collection_cards");
  await exec(db, "alter table pack_collection_cards_slim rename to pack_collection_cards");
  await exec(
    db,
    "create index if not exists idx_pack_collection_owner_tier on pack_collection_cards(owner_user_id, tier, copies, pp desc)",
  );
  await exec(
    db,
    "create index if not exists idx_pack_collection_card_pulled on pack_collection_cards(card_user_id, first_pulled_at)",
  );
  return true;
}

export function shardValueForStoredTier(tier: string | null): number {
  const key = tier ?? "unrated";
  // Own-property check for the same reason tierRank uses one: an inherited key
  // would return a function, and `copies * fn` is NaN — which walks straight
  // past addWalletShards' `gained <= 0` bail and writes a NaN shard balance.
  return Object.prototype.hasOwnProperty.call(TIER_SHARD_VALUES, key) ? TIER_SHARD_VALUES[key] : 1;
}

/* What one duplicate copy of a stored tier recycles for. Own-property checked
   for the same reason as above: an inherited key would make the shard total
   NaN rather than throw. */
export function duplicateShardValueForStoredTier(tier: string | null): number {
  const key = tier ?? "unrated";
  return Object.prototype.hasOwnProperty.call(TIER_DUPLICATE_SHARD_VALUES, key)
    ? TIER_DUPLICATE_SHARD_VALUES[key]
    : 1;
}

export async function recyclePackCollectionCards(
  db: Db,
  userId: number,
  options: {
    mode: PackRecycleMode;
    cardKey?: string;
    cardKeys?: string[];
    /* For "copies": how many copies of each card to hand back, rather than
       all of them. The pull summary recycles a pack this way, so a duplicate
       gives up the copy that pack added and nothing collected before it. */
    cardCopies?: Array<{ cardKey: string; copies: number }>;
    tier?: string | null;
    query?: string | null;
    /* Same restriction listPackCollectionCards takes, so "recycle everything
       shown" under the "not tracked" filter recycles exactly what it showed. */
    restrictToCardUserIds?: readonly number[];
  },
  now = Date.now(),
): Promise<PackRecycleResult> {
  let gained = 0;

  if (options.mode === "whole_matching") {
    const where = ["owner_user_id = ?", "copies > 0"];
    const args: InValue[] = [userId];
    const tier = options.tier ?? "all";
    const query = options.query?.trim().toLowerCase() ?? "";
    if (query) {
      // Must match by the same display name listPackCollectionCards filters
      // on, or "recycle everything matching" would miss renamed players.
      where.push(`lower(${displayUsernameSql}) like ?`);
      args.push(`%${query}%`);
    }
    if (options.restrictToCardUserIds) {
      where.push(cardUserIdRestrictionSql(options.restrictToCardUserIds));
    }
    if (tier && tier !== "all") {
      if (tier === "unrated") where.push("tier is null");
      else {
        where.push("tier = ?");
        args.push(tier);
      }
    }
    const whereSql = where.join(" and ");
    const row = (await exec(
      db,
      `select coalesce(sum(${wholeCardShardValueSql("tier")}), 0) as gained
       from pack_collection_cards
       where ${whereSql}`,
      args,
    )).rows[0];
    gained = Number(row?.gained) || 0;
    if (gained > 0) {
      await exec(
        db,
        `update pack_collection_cards
         set recycled_copies = recycled_copies + copies,
             copies = 0,
             updated_at = ?
         where ${whereSql}`,
        [now, ...args],
      );
    }
    return { gained, wallet: await addWalletShards(db, userId, gained, now) };
  }

  if (options.mode === "whole" && options.cardKeys && options.cardKeys.length > 0) {
    const keys = [...new Set(options.cardKeys.map(normalizePackCardKey).filter((key): key is string => key !== null))];
    if (keys.length === 0) return { gained: 0, wallet: await getOrCreatePackWallet(db, userId, now) };
    const placeholders = keys.map(() => "?").join(", ");
    const row = (await exec(
      db,
      `select coalesce(sum(${wholeCardShardValueSql("tier")}), 0) as gained
       from pack_collection_cards
       where owner_user_id = ? and card_key in (${placeholders}) and copies > 0`,
      [userId, ...keys],
    )).rows[0];
    gained = Number(row?.gained) || 0;
    if (gained > 0) {
      await exec(
        db,
        `update pack_collection_cards
         set recycled_copies = recycled_copies + copies,
             copies = 0,
             updated_at = ?
         where owner_user_id = ? and card_key in (${placeholders}) and copies > 0`,
        [now, userId, ...keys],
      );
    }
    return { gained, wallet: await addWalletShards(db, userId, gained, now) };
  }

  if (options.mode === "copies") {
    /* How many copies of each card to hand back. Repeats add up rather than
       overwrite: one pack can deal the same card twice. */
    const wanted = new Map<string, number>();
    for (const entry of options.cardCopies ?? []) {
      const key = normalizePackCardKey(entry?.cardKey);
      const copies = Math.max(0, Math.floor(Number(entry?.copies) || 0));
      if (!key || copies <= 0) continue;
      wanted.set(key, (wanted.get(key) ?? 0) + copies);
    }
    const keys = [...wanted.keys()];
    if (keys.length === 0) return { gained: 0, wallet: await getOrCreatePackWallet(db, userId, now) };
    const placeholders = keys.map(() => "?").join(", ");
    const rows = (await exec(
      db,
      `select card_key, copies, tier from pack_collection_cards
       where owner_user_id = ? and card_key in (${placeholders}) and copies > 0`,
      [userId, ...keys],
    )).rows;
    const updates: DbStatement[] = [];
    for (const row of rows) {
      const key = typeof row.card_key === "string" ? row.card_key : String(row.card_key ?? "");
      const held = Math.max(0, Math.floor(Number(row.copies) || 0));
      const taken = Math.min(wanted.get(key) ?? 0, held);
      if (taken <= 0) continue;
      const tier = typeof row.tier === "string" ? row.tier : null;
      const duplicateValue = duplicateShardValueForStoredTier(tier);
      // The last copy to leave is worth the full tier value and every copy
      // above it the duplicate rate, which is how whole-recycling prices the
      // same cards: giving a card up a copy at a time cannot pay more.
      gained += taken >= held
        ? shardValueForStoredTier(tier) + (taken - 1) * duplicateValue
        : taken * duplicateValue;
      updates.push({
        sql: `update pack_collection_cards
              set recycled_copies = recycled_copies + ?,
                  copies = copies - ?,
                  updated_at = ?
              where owner_user_id = ? and card_key = ? and copies >= ?`,
        args: [taken, taken, now, userId, key, taken],
      });
    }
    if (updates.length > 0) await execBatch(db, updates);
    return { gained, wallet: await addWalletShards(db, userId, gained, now) };
  }

  if (options.mode === "all_duplicates") {
    const row = (await exec(
      db,
      `select coalesce(sum(max(copies - 1, 0) * ${duplicateShardValueSql("tier")}), 0) as gained
       from pack_collection_cards
       where owner_user_id = ? and copies > 1`,
      [userId],
    )).rows[0];
    gained = Number(row?.gained) || 0;
    if (gained > 0) {
      await exec(
        db,
        `update pack_collection_cards
         set recycled_copies = recycled_copies + copies - 1,
             copies = 1,
             updated_at = ?
         where owner_user_id = ? and copies > 1`,
        [now, userId],
      );
    }
    return { gained, wallet: await addWalletShards(db, userId, gained, now) };
  }

  const cardKey = normalizePackCardKey(options.cardKey);
  if (!cardKey) return { gained: 0, wallet: await getOrCreatePackWallet(db, userId, now) };
  const card = (await exec(
    db,
    "select copies, tier from pack_collection_cards where owner_user_id = ? and card_key = ? and copies > 0",
    [userId, cardKey],
  )).rows[0];
  if (!card) return { gained: 0, wallet: await getOrCreatePackWallet(db, userId, now) };

  const copies = Math.max(0, Math.floor(Number(card.copies) || 0));
  const tier = typeof card.tier === "string" ? card.tier : null;
  const shardValue = shardValueForStoredTier(tier);
  const duplicateValue = duplicateShardValueForStoredTier(tier);
  if (options.mode === "duplicates") {
    const recycled = Math.max(0, copies - 1);
    gained = recycled * duplicateValue;
    if (recycled > 0) {
      await exec(
        db,
        `update pack_collection_cards
         set recycled_copies = recycled_copies + ?,
             copies = 1,
             updated_at = ?
         where owner_user_id = ? and card_key = ?`,
        [recycled, now, userId, cardKey],
      );
    }
  } else {
    // The kept copy at full value, every extra one at the duplicate rate.
    gained = copies > 0 ? shardValue + (copies - 1) * duplicateValue : 0;
    await exec(
      db,
      `update pack_collection_cards
       set recycled_copies = recycled_copies + copies,
           copies = 0,
           updated_at = ?
       where owner_user_id = ? and card_key = ?`,
      [now, userId, cardKey],
    );
  }

  return { gained, wallet: await addWalletShards(db, userId, gained, now) };
}
