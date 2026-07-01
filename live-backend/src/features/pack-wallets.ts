import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";

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
}

export interface PackCollectionPage {
  cards: StoredPackCard[];
  total: number;
  tierCounts: Record<string, number>;
  duplicateShardTotal: number;
  filteredShardTotal: number;
}

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
  unrated: 1,
};

function tierRankSql(alias = "tier") {
  return `case ${alias}
    when 'worldClass' then 8
    when 'ascendant' then 7
    when 'mythic' then 6
    when 'legendary' then 5
    when 'ultraRare' then 4
    when 'superRare' then 3
    when 'elite' then 2
    when 'rare' then 1
    when 'common' then 0
    else -1
  end`;
}

function shardValueSql(alias = "tier") {
  return `case ${alias}
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
    tier: typeof raw.tier === "string" ? raw.tier : null,
    tierLabel: typeof raw.tierLabel === "string" ? raw.tierLabel : null,
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

async function addWalletShards(db: Db, userId: number, gained: number, now: number): Promise<StoredPackWallet> {
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
       owner_user_id, card_user_id, username, avatar_url, country_code, tier, tier_label, skills_json,
       pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(owner_user_id, card_user_id) do update set
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

function cardFromRow(row: Record<string, unknown>): StoredPackCard {
  return {
    userId: Number(row.card_user_id),
    username: String(row.username ?? ""),
    avatarUrl: String(row.avatar_url ?? ""),
    countryCode: String(row.country_code ?? ""),
    tier: typeof row.tier === "string" ? row.tier : null,
    tierLabel: typeof row.tier_label === "string" ? row.tier_label : null,
    skills: row.skills_json ? parseJson<unknown | null>(String(row.skills_json), null) : null,
    pp: Number(row.pp) || 0,
    globalRank: Number(row.global_rank) || 0,
    copies: Number(row.copies) || 0,
    recycledCopies: Number(row.recycled_copies) || 0,
    firstPulledAt: Number(row.first_pulled_at) || 0,
    lastPulledAt: Number(row.last_pulled_at) || 0,
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
  const pageSize = Math.min(60, Math.max(1, Math.floor(options.pageSize)));
  const page = Math.max(0, Math.floor(options.page));
  const where = ["owner_user_id = ?", "copies > 0"];
  const args: InValue[] = [userId];
  const query = options.query?.trim().toLowerCase() ?? "";
  if (query) {
    where.push("lower(username) like ?");
    args.push(`%${query}%`);
  }
  if (options.tier && options.tier !== "all") {
    if (options.tier === "unrated") where.push("tier is null");
    else {
      where.push("tier = ?");
      args.push(options.tier);
    }
  }
  const whereSql = where.join(" and ");
  const totalRow = (await exec(db, `select count(*) as total from pack_collection_cards where ${whereSql}`, args)).rows[0];
  const rows = (await exec(
    db,
    `select * from pack_collection_cards
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

export async function listPackCollectionOwnedUserIds(db: Db, userId: number): Promise<number[]> {
  const rows = (await exec(
    db,
    `select card_user_id
     from pack_collection_cards
     where owner_user_id = ? and copies > 0
     order by card_user_id asc`,
    [userId],
  )).rows;
  return rows
    .map((row) => Number(row.card_user_id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export function shardValueForStoredTier(tier: string | null): number {
  return TIER_SHARD_VALUES[tier ?? "unrated"] ?? 1;
}

export async function recyclePackCollectionCards(
  db: Db,
  userId: number,
  options: { mode: PackRecycleMode; cardUserId?: number; cardUserIds?: number[]; tier?: string | null; query?: string | null },
  now = Date.now(),
): Promise<PackRecycleResult> {
  let gained = 0;

  if (options.mode === "whole_matching") {
    const where = ["owner_user_id = ?", "copies > 0"];
    const args: InValue[] = [userId];
    const tier = options.tier ?? "all";
    const query = options.query?.trim().toLowerCase() ?? "";
    if (query) {
      where.push("lower(username) like ?");
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

  if (options.mode === "whole" && options.cardUserIds && options.cardUserIds.length > 0) {
    const ids = [...new Set(options.cardUserIds.map((id) => Math.floor(Number(id) || 0)).filter((id) => id > 0))];
    if (ids.length === 0) return { gained: 0, wallet: await getOrCreatePackWallet(db, userId, now) };
    const placeholders = ids.map(() => "?").join(", ");
    const row = (await exec(
      db,
      `select coalesce(sum(copies * ${shardValueSql("tier")}), 0) as gained
       from pack_collection_cards
       where owner_user_id = ? and card_user_id in (${placeholders}) and copies > 0`,
      [userId, ...ids],
    )).rows[0];
    gained = Number(row?.gained) || 0;
    if (gained > 0) {
      await exec(
        db,
        `update pack_collection_cards
         set recycled_copies = recycled_copies + copies,
             copies = 0,
             updated_at = ?
         where owner_user_id = ? and card_user_id in (${placeholders}) and copies > 0`,
        [now, userId, ...ids],
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

  const cardUserId = Math.floor(Number(options.cardUserId) || 0);
  if (cardUserId <= 0) return { gained: 0, wallet: await getOrCreatePackWallet(db, userId, now) };
  const card = (await exec(
    db,
    "select copies, tier from pack_collection_cards where owner_user_id = ? and card_user_id = ? and copies > 0",
    [userId, cardUserId],
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
         where owner_user_id = ? and card_user_id = ?`,
        [recycled, now, userId, cardUserId],
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
       where owner_user_id = ? and card_user_id = ?`,
      [now, userId, cardUserId],
    );
  }

  return { gained, wallet: await addWalletShards(db, userId, gained, now) };
}
