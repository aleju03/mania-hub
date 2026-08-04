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
  goat: 1000,
  unrated: 1,
};

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

function shardValueSql(alias = "tier") {
  return `case ${alias}
    when 'goat' then 1000
    when 'worldClass' then 40
    when 'ascendant' then 28
    when 'mythic' then 20
    when 'legendary' then 14
    when 'ultraRare' then 9
    when 'superRare' then 6
    when 'elite' then 4
    when 'rare' then 2
    when 'common' then 1
    else 1
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
   recycles for 1000, so an unchecked `tier: "goat"` on any player is a shard
   printer: sync a forged card, recycle it, repeat. Membership is a fixed list
   of ids, so the check is exact and needs no tier index. */
export const HONORARY_USER_IDS = new Set([
  259972, 1190879, 140148, 8474029, 86188, 5610085, 3360737, 2531335, 2520707, 4140104,
  19970192, 10072733, 903155, 9452257, 12253636, 2288363, 10083439, 1089335,
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

function normalizeCard(value: unknown): StoredPackCard | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WalletCardPayload>;
  const userId = toFiniteNumber(raw.userId, 0);
  if (!Number.isInteger(userId) || userId <= 0 || typeof raw.username !== "string") return null;
  return {
    userId,
    username: raw.username,
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : typeof raw.avatar_url === "string" ? raw.avatar_url : "",
    countryCode:
      typeof raw.countryCode === "string" ? raw.countryCode : typeof raw.country_code === "string" ? raw.country_code : "",
    tier: claimedTier(raw, userId),
    tierLabel: claimedTier(raw, userId) === null ? null : (typeof raw.tierLabel === "string" ? raw.tierLabel : null),
    skills: raw.skills && typeof raw.skills === "object" ? raw.skills : null,
    pp: toFiniteNumber(raw.pp, 0),
    globalRank: Math.floor(toFiniteNumber(raw.globalRank ?? raw.global_rank, 0)),
    copies: Math.max(0, Math.floor(toFiniteNumber(raw.copies, 1))),
    recycledCopies: Math.max(0, Math.floor(toFiniteNumber(raw.recycledCopies ?? raw.recycled_copies, 0))),
    firstPulledAt: Math.floor(toFiniteNumber(raw.firstPulledAt ?? raw.first_pulled_at, 0)),
    lastPulledAt: Math.floor(toFiniteNumber(raw.lastPulledAt ?? raw.last_pulled_at, 0)),
  };
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
    .map(normalizeCard)
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
  options: { page: number; pageSize: number; tier?: string | null; query?: string | null },
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
     order by ${tierRankSql("tier")} desc, pp desc, global_rank asc, username collate nocase asc
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
    `select coalesce(sum(max(copies - 1, 0) * ${shardValueSql("tier")}), 0) as total
     from pack_collection_cards
     where owner_user_id = ? and copies > 0`,
    [userId],
  )).rows[0];
  const filteredShardRow = (await exec(
    db,
    `select coalesce(sum(copies * ${shardValueSql("tier")}), 0) as total
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
  // taken on trust, and GOAT recycles for 1000 shards.
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

export async function recyclePackCollectionCards(
  db: Db,
  userId: number,
  options: { mode: PackRecycleMode; cardKey?: string; cardKeys?: string[]; tier?: string | null; query?: string | null },
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
      `select coalesce(sum(copies * ${shardValueSql("tier")}), 0) as gained
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
      `select coalesce(sum(copies * ${shardValueSql("tier")}), 0) as gained
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
      `select coalesce(sum(max(copies - 1, 0) * ${shardValueSql("tier")}), 0) as gained
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
  const shardValue = shardValueForStoredTier(typeof card.tier === "string" ? card.tier : null);
  if (options.mode === "duplicates") {
    const recycled = Math.max(0, copies - 1);
    gained = recycled * shardValue;
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
    gained = copies * shardValue;
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
