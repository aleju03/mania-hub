import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, execBatch, parseJson } from "../db.js";

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
  skills: unknown | null;
  pp: number;
  globalRank: number;
  copies: number;
  recycledCopies: number;
  firstPulledAt: number;
  lastPulledAt: number;
  /* Mint order for this owner (#1 pulled the card first, anywhere), and how
     many serials the card has ever handed out. Null on cards whose pulls were
     never logged: anonymous wallets, and everything from before the registry.
     See pack_card_serials in pack-pulls.ts. */
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

export type PackRecycleMode = "duplicates" | "whole" | "all_duplicates" | "whole_matching";
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
}

const TIER_SHARD_VALUES: Record<string, number> = {
  common: 1,
  rare: 2,
  elite: 4,
  superRare: 6,
  ultraRare: 9,
  legendary: 14,
  mythic: 20,
  ascendant: 28,
  worldClass: 40,
  // Mirrors the frontend's table in src/lib/pack-collection.ts. GOAT came down
  // from 1000, which was four Legend packs for a card the honorary slot hands
  // out for free once the roster is complete.
  goat: 400,
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
  goat: 9,
};

/* hasOwnProperty, not `TIER_RANKS[tier] ?? -1`: an inherited key ("constructor",
   "toString", "__proto__") would otherwise resolve to a function and make every
   rank comparison against it false, opening the "only a better tier overwrites"
   guard. Card tiers arrive from clients, so they reach this lookup. */
export function tierRank(tier: string | null): number {
  return tier !== null && Object.prototype.hasOwnProperty.call(TIER_RANKS, tier) ? TIER_RANKS[tier] : -1;
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

const displayUsernameSql = `coalesce(nullif(${liveUserFieldSql("username")}, ''), username)`;

/* The honorary roster, mirrored from src/lib/honorary-players.ts. Only these
   players can hold the GOAT tier.

   Collection cards arrive from the client and their tier is otherwise taken on
   trust, which was harmless when the rarest card recycled for 40 shards. GOAT
   recycles for 400 (TIER_SHARD_VALUES in src/lib/pack-collection.ts), so an
   unchecked `tier: "goat"` on any player is a shard printer: sync a forged
   card, recycle it, repeat. Membership is a fixed list of ids, so the check is
   exact and needs no tier index. */
export const HONORARY_USER_IDS = new Set([
  259972, 1190879, 140148, 8474029, 86188, 5610085, 3360737, 2531335, 2520707, 4140104,
  19970192, 10072733, 903155, 12253636, 2288363, 10083439, 1089335,
  9530019, 1824775, 15806513, 3817144, 4477497, 13601876,
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

/* Accepts a client-supplied key, rejecting anything that is not a player id
   with an optional ":goat" suffix. */
export function normalizePackCardKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)(:goat)?$/.exec(value.trim());
  if (!match) return null;
  const userId = Math.floor(Number(match[1]));
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return match[2] ? `${userId}:goat` : String(userId);
}

function claimedTier(raw: { tier?: unknown }, userId: number): string | null {
  // A rejected claim falls back to unrated (1 shard) rather than erroring, so a
  // stale or hand-edited local wallet still syncs. Anything outside the real
  // tier list is rejected here so no invented tier string ever reaches a rank
  // or shard-value lookup.
  if (!isKnownTier(raw.tier)) return null;
  if (raw.tier === "goat" && !HONORARY_USER_IDS.has(userId)) return null;
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
const PACK_CARD_USERNAME_MAX_CHARS = 40;
const PACK_CARD_TIER_LABEL_MAX_CHARS = 60;
const PACK_CARD_AVATAR_URL_MAX_CHARS = 300;
/* Absurdity ceilings, not play limits: real collections sit orders of
   magnitude below these, and past them a row is only a rendering problem. */
const PACK_CARD_MAX_COPIES = 100_000;
const PACK_CARD_MAX_PP = 1_000_000;

/* Keeps a stored avatar to an https URL. Anything else - a javascript: or
   data: URI, a bare string - degrades to empty, and the read path then falls
   back to the users row (which is where a tracked player's avatar comes from
   anyway). */
function normalizeAvatarUrl(value: unknown): string {
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
function normalizeCountryCode(value: string): string {
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

async function getOrCreatePackWallet(db: Db, userId: number, now: number): Promise<StoredPackWallet> {
  const existing = await getPackWallet(db, userId);
  if (existing) return existing;
  await exec(
    db,
    "insert into pack_wallets (user_id, payload, rev, updated_at) values (?, ?, 1, ?) on conflict(user_id) do nothing",
    [userId, defaultWalletPayload(now), now],
  );
  return (await getPackWallet(db, userId)) ?? { payload: defaultWalletPayload(now), rev: 1, updatedAt: now };
}

/* Exported for the arcade, which pays shards for a duel win or a streak run
   and needs the same single writer every other grant goes through. */
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

async function importCardsFromPayload(
  db: Db,
  userId: number,
  payload: string,
  now: number,
  mode: PackWalletCardImportMode,
): Promise<void> {
  const parsed = parseJson<WalletPayload | null>(payload, null);
  if (!parsed?.cards || typeof parsed.cards !== "object") return;

  const cards = Object.values(parsed.cards)
    .map((card) => normalizeCard(card, now))
    .filter((card): card is StoredPackCard => Boolean(card));
  for (const card of cards) {
    await upsertPackCard(db, userId, card, now, mode);
  }
}

async function upsertPackCard(
  db: Db,
  ownerUserId: number,
  card: StoredPackCard,
  now: number,
  mode: PackWalletCardImportMode,
): Promise<void> {
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
  await exec(
    db,
    `insert into pack_collection_cards (
       owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label, skills_json,
       pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(owner_user_id, card_key) do update set
       username = excluded.username,
       avatar_url = excluded.avatar_url,
       country_code = excluded.country_code,
       tier = case
         when ${tierRankSql("pack_collection_cards.tier")} > ${tierRankSql("excluded.tier")}
         then pack_collection_cards.tier
         else excluded.tier
       end,
       tier_label = case
         when ${tierRankSql("pack_collection_cards.tier")} > ${tierRankSql("excluded.tier")}
         then pack_collection_cards.tier_label
         else excluded.tier_label
       end,
       skills_json = case
         when ${tierRankSql("pack_collection_cards.tier")} > ${tierRankSql("excluded.tier")}
         then coalesce(pack_collection_cards.skills_json, excluded.skills_json)
         else coalesce(excluded.skills_json, pack_collection_cards.skills_json)
       end,
       pp = excluded.pp,
       global_rank = excluded.global_rank,
       copies = ${copiesSql},
       recycled_copies = ${recycledCopiesSql},
       first_pulled_at = min(pack_collection_cards.first_pulled_at, excluded.first_pulled_at),
       last_pulled_at = max(pack_collection_cards.last_pulled_at, excluded.last_pulled_at),
       updated_at = excluded.updated_at`,
    [
      ownerUserId,
      card.userId,
      packCardKey(card.userId, card.tier),
      card.username,
      card.avatarUrl,
      card.countryCode,
      card.tier,
      card.tierLabel,
      card.skills ? JSON.stringify(card.skills) : null,
      card.pp,
      card.globalRank,
      card.copies,
      card.recycledCopies,
      card.firstPulledAt,
      card.lastPulledAt,
      now,
    ],
  );
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
    tierLabel: typeof row.tier_label === "string" ? row.tier_label : null,
    skills: row.skills_json ? parseJson<unknown | null>(String(row.skills_json), null) : null,
    pp: Number(row.pp) || 0,
    globalRank: Number(row.global_rank) || 0,
    copies: Number(row.copies) || 0,
    recycledCopies: Number(row.recycled_copies) || 0,
    firstPulledAt: Number(row.first_pulled_at) || 0,
    lastPulledAt: Number(row.last_pulled_at) || 0,
    serial: Number(row.serial) > 0 ? Number(row.serial) : null,
    mintedTotal: Number(row.minted_total) || 0,
  };
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
    `select pack_collection_cards.*,
       ${liveUserFieldSql("username")} as live_username,
       ${liveUserFieldSql("avatar_url")} as live_avatar_url,
       ${liveUserFieldSql("country_code")} as live_country_code,
       serials.serial as serial,
       (select max(other.serial) from pack_card_serials other
         where other.card_key = pack_collection_cards.card_key) as minted_total
     from pack_collection_cards
     left join pack_card_serials serials
       on serials.card_key = pack_collection_cards.card_key
       and serials.owner_user_id = pack_collection_cards.owner_user_id
     where ${whereSql}
     order by ${
       options.sort === "newest" ? "pack_collection_cards.first_pulled_at desc, " : ""
     }${tierRankSql("tier")} desc, pp desc, global_rank asc, username collate nocase asc
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

/* The showcase shelf: up to five cards a collector pins to their public
   profile page. Reads join the collection on (owner, card_key, copies > 0),
   so a pinned card that gets fully recycled falls off the shelf on its own
   and a pin can never show a card the owner does not hold. */
export const PACK_SHOWCASE_MAX_CARDS = 5;

export async function getPackShowcase(db: Db, ownerUserId: number): Promise<StoredPackCard[]> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return [];
  const rows = (await exec(
    db,
    `select pack_collection_cards.*,
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
  await execBatch(db, [
    { sql: "delete from pack_showcase_cards where owner_user_id = ?", args: [ownerUserId] },
    ...kept.map((key, position) => ({
      sql: "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, ?, ?, ?)",
      args: [ownerUserId, position, key, now] as InValue[],
    })),
  ]);
  return kept;
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
  mint: { tier?: unknown; tierLabel?: unknown; skills?: unknown },
  now = Date.now(),
): Promise<{ applied: boolean; cardKey: string | null }> {
  const cardKey = normalizePackCardKey(rawCardKey);
  if (!cardKey || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return { applied: false, cardKey: null };
  const skills = mint.skills && typeof mint.skills === "object" && !Array.isArray(mint.skills) ? mint.skills : null;
  if (!skills) return { applied: false, cardKey: null };
  const row = (await exec(
    db,
    `select card_user_id, tier, skills_json, copies, recycled_copies, first_pulled_at, last_pulled_at
     from pack_collection_cards
     where owner_user_id = ? and card_key = ? and copies > 0`,
    [ownerUserId, cardKey],
  )).rows[0];
  if (!row) return { applied: false, cardKey: null };

  const cardUserId = Number(row.card_user_id);
  if (!Number.isInteger(cardUserId) || cardUserId <= 0) return { applied: false, cardKey: null };
  // Same GOAT guard the wallet import applies: a claimed tier is otherwise
  // taken on trust, and GOAT recycles for 400 shards.
  const tier = claimedTier(mint, cardUserId);
  const currentTier = typeof row.tier === "string" ? row.tier : null;
  if (row.skills_json != null && tierRank(currentTier) >= tierRank(tier)) return { applied: false, cardKey };
  const tierLabel = tier === null ? null : (typeof mint.tierLabel === "string" ? mint.tierLabel.slice(0, 60) : null);
  const skillsJson = JSON.stringify(skills);
  if (skillsJson.length > PACK_CARD_SKILLS_MAX_CHARS) return { applied: false, cardKey };

  const nextKey = packCardKey(cardUserId, tier);
  if (nextKey === cardKey) {
    await exec(
      db,
      `update pack_collection_cards
       set tier = ?, tier_label = ?, skills_json = ?, updated_at = ?
       where owner_user_id = ? and card_key = ?`,
      [tier, tierLabel, skillsJson, now, ownerUserId, cardKey],
    );
    return { applied: true, cardKey };
  }

  // Key move: fold this card's copies into the destination key, then drop the
  // old row. One batch so a crash can never leave the copies duplicated across
  // both keys (or lost from both).
  await execBatch(db, [
    {
      sql: `insert into pack_collection_cards (
              owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label, skills_json,
              pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
            )
            select owner_user_id, card_user_id, ?, username, avatar_url, country_code, ?, ?, ?,
              pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, ?
            from pack_collection_cards
            where owner_user_id = ? and card_key = ?
            on conflict(owner_user_id, card_key) do update set
              tier = excluded.tier,
              tier_label = excluded.tier_label,
              skills_json = excluded.skills_json,
              copies = pack_collection_cards.copies + excluded.copies,
              recycled_copies = pack_collection_cards.recycled_copies + excluded.recycled_copies,
              first_pulled_at = min(pack_collection_cards.first_pulled_at, excluded.first_pulled_at),
              last_pulled_at = max(pack_collection_cards.last_pulled_at, excluded.last_pulled_at),
              updated_at = excluded.updated_at`,
      args: [nextKey, tier, tierLabel, skillsJson, now, ownerUserId, cardKey],
    },
    {
      sql: "delete from pack_collection_cards where owner_user_id = ? and card_key = ?",
      args: [ownerUserId, cardKey],
    },
  ]);
  return { applied: true, cardKey: nextKey };
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

/* pack_collection_cards used to be keyed (owner, player), one row per player.
   GOAT cards now stand apart from their player's ordinary card, so the key is
   (owner, card_key) instead. SQLite cannot alter a primary key, so a database
   created before this rebuilds the table once, deriving each row's key from
   the tier it already stores. Existing rows are all distinct by (owner,
   player), so no row can collide on the way in.

   Guarded on the column rather than a marker: the check is a pragma read, and
   tying it to the schema means a restored or hand-repaired database can never
   skip a rebuild it actually needs. */
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

/* Which of these cards an account actually holds a copy of right now.

   Duels stake real cards, so a hand is no longer a claim the server takes on
   trust the way the pull log is: what you put up has to be in your collection
   when you put it up. */
export async function heldPackCollectionCardKeys(
  db: Db,
  ownerUserId: number,
  cardKeys: readonly string[],
): Promise<Set<string>> {
  const keys = [...new Set(cardKeys.map(normalizePackCardKey).filter((key): key is string => key !== null))];
  if (keys.length === 0 || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return new Set();
  const rows = (await exec(
    db,
    `select card_key from pack_collection_cards
     where owner_user_id = ? and copies > 0 and card_key in (${keys.map(() => "?").join(", ")})`,
    [ownerUserId, ...keys],
  )).rows;
  return new Set(rows.map((row) => String(row.card_key)));
}

export interface PackCardTransfer {
  cardKey: string;
  username: string;
  tier: string | null;
  tierLabel: string | null;
  /* A card the loser no longer holds (recycled since they staked it) moves as
     its shard value instead, so getting rid of your stake mid-duel is not a
     way to keep it. */
  shards: number;
}

/* Moves one copy of each card from one collection to another.

   Serials deliberately do not travel: `pack_card_serials` records who pulled a
   card first, and a card you won is not a card you pulled. The loser keeps the
   serial they earned even after the copy leaves them, exactly as it survives
   recycling. */
export async function transferPackCollectionCards(
  db: Db,
  fromUserId: number,
  toUserId: number,
  cardKeys: readonly string[],
  now = Date.now(),
): Promise<{ moved: PackCardTransfer[]; shards: number }> {
  const keys = [...new Set(cardKeys.map(normalizePackCardKey).filter((key): key is string => key !== null))];
  const moved: PackCardTransfer[] = [];
  let shards = 0;
  if (keys.length === 0 || fromUserId === toUserId) return { moved, shards };
  if (!Number.isInteger(fromUserId) || fromUserId <= 0 || !Number.isInteger(toUserId) || toUserId <= 0) {
    return { moved, shards };
  }

  for (const cardKey of keys) {
    const row = (await exec(
      db,
      `select card_user_id, username, avatar_url, country_code, tier, tier_label, skills_json, pp, global_rank,
              copies, first_pulled_at, last_pulled_at
       from pack_collection_cards
       where owner_user_id = ? and card_key = ?`,
      [fromUserId, cardKey],
    )).rows[0];
    if (!row) continue;
    const tier = typeof row.tier === "string" ? row.tier : null;
    const username = String(row.username ?? "");
    const tierLabel = typeof row.tier_label === "string" ? row.tier_label : null;
    // Staked and then recycled: the copy is gone, so the winner is paid what
    // the loser got for it.
    if ((Number(row.copies) || 0) <= 0) {
      const value = shardValueForStoredTier(tier);
      shards += value;
      moved.push({ cardKey, username, tier, tierLabel, shards: value });
      continue;
    }

    const taken = (await exec(
      db,
      `update pack_collection_cards
       set copies = copies - 1, updated_at = ?
       where owner_user_id = ? and card_key = ? and copies > 0`,
      [now, fromUserId, cardKey],
    )).rowsAffected;
    // Lost a race with a recycle: the shard fallback covers it next read.
    if (taken === 0) continue;

    await upsertPackCard(
      db,
      toUserId,
      {
        userId: Number(row.card_user_id) || 0,
        cardKey,
        username,
        avatarUrl: String(row.avatar_url ?? ""),
        countryCode: String(row.country_code ?? ""),
        tier,
        tierLabel,
        skills: row.skills_json ? parseJson<unknown | null>(String(row.skills_json), null) : null,
        pp: Number(row.pp) || 0,
        globalRank: Number(row.global_rank) || 0,
        copies: 1,
        recycledCopies: 0,
        // A won card is new to this collection today, but it was first pulled
        // when the loser pulled it, and the album sorts on that.
        firstPulledAt: Number(row.first_pulled_at) || now,
        lastPulledAt: now,
      },
      now,
      "delta",
    );
    moved.push({ cardKey, username, tier, tierLabel, shards: 0 });
  }

  if (shards > 0) await addWalletShards(db, toUserId, shards, now);
  return { moved, shards };
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
