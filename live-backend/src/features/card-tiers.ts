/* Maniacard tier index, so packs can draw by rarity.

   Pack odds used to be whatever the pool happened to contain: the draw picked a
   uniformly random player and the card's tier fell out of that player's real
   scores. That made the ladder non-monotonic (Legendary landed more often than
   Ultra Rare) with no knob to fix it, because the draw never knew a candidate's
   tier before choosing them.

   This table is that knob. It caches each tracked player's tier so a pack can
   roll a tier by configured weight and then pick a random player who has it.
   Crucially it does NOT decide what tier a card is: the card still renders from
   the player's real scores at reveal time. A stale row only means the draw
   aimed at one tier and the card landed on a neighbouring one, which self-heals
   on the next recompute.

   The tier algorithm itself lives in the frontend's src/lib/maniacard.ts and is
   deliberately not duplicated here - scripts/compute-pack-card-tiers.ts runs it
   over the pool and writes results back through /api/admin/card-tiers.
*/
import type { Db } from "../db.js";
import { exec } from "../db.js";

export const CARD_TIERS = [
  "common",
  "rare",
  "elite",
  "superRare",
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
] as const;

export type CardTier = (typeof CARD_TIERS)[number];

const VALID_TIERS = new Set<string>(CARD_TIERS);

export interface CardTierInput {
  userId: number;
  tier: string;
  cardPower: number;
}

export function normalizeCardTierInput(value: unknown): CardTierInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const userId = Math.floor(Number(raw.userId) || 0);
  const cardPower = Number(raw.cardPower);
  if (userId <= 0 || typeof raw.tier !== "string" || !VALID_TIERS.has(raw.tier)) return null;
  if (!Number.isFinite(cardPower)) return null;
  return { userId, tier: raw.tier, cardPower };
}

export async function writeCardTiers(db: Db, entries: CardTierInput[], now = new Date().toISOString()): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    const result = await exec(
      db,
      "update users set card_tier = ?, card_power = ?, card_tier_computed_at = ? where user_id = ?",
      [entry.tier, entry.cardPower, now, entry.userId],
    );
    // Players outside the tracked set have no users row; skipping them is
    // correct, they can't be drawn anyway.
    if ((result.rowsAffected ?? 0) > 0) written += 1;
  }
  return written;
}

export interface CardTierCount {
  tier: string;
  players: number;
}

/* How many drawable players sit in each tier. Backs the odds readout and lets
   the draw fall back when a tier is empty. */
export async function getCardTierCounts(db: Db): Promise<CardTierCount[]> {
  const rows = (await exec(
    db,
    `select u.card_tier as tier, count(distinct u.user_id) as players
     from country_rosters ro
     join users u on u.user_id = ro.user_id
     where ro.is_tracked = 1 and ro.rank is not null and u.pp is not null and u.card_tier is not null
     group by u.card_tier`,
  )).rows;
  return rows.map((row) => ({ tier: String(row.tier), players: Number(row.players) || 0 }));
}

export interface DrawnPoolPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  pp: number;
  globalRank: number | null;
  cardTier: string | null;
}

/* Random tracked players of a given tier.
   `excludeUserIds` keeps a single pack from dealing the same player twice, and
   `topFraction` honours the premium packs' top-slice rule: a Legend pack asking
   for a Rare should still get one from the top 2% of the pool, not the tail. */
export async function drawPlayersByTier(
  db: Db,
  options: { tier: string; count: number; excludeUserIds?: number[]; topFraction?: number },
): Promise<DrawnPoolPlayer[]> {
  const count = Math.max(1, Math.min(20, Math.floor(options.count) || 1));
  if (!VALID_TIERS.has(options.tier)) return [];

  const exclude = (options.excludeUserIds ?? []).filter((id) => Number.isInteger(id) && id > 0).slice(0, 50);
  const excludeSql = exclude.length > 0 ? `and u.user_id not in (${exclude.map(() => "?").join(",")})` : "";

  const topFraction = Math.max(0, Math.min(1, options.topFraction ?? 1));
  // A slice is expressed as a pp floor: take the pp of the player standing at
  // the slice boundary of the whole tracked pool.
  let ppFloor: number | null = null;
  if (topFraction < 1) {
    const total = Number((await exec(
      db,
      `select count(distinct u.user_id) as n
       from country_rosters ro join users u on u.user_id = ro.user_id
       where ro.is_tracked = 1 and ro.rank is not null and u.pp is not null`,
    )).rows[0]?.n) || 0;
    const offset = Math.max(0, Math.min(total - 1, Math.round(total * topFraction) - 1));
    const row = (await exec(
      db,
      `select u.pp as pp
       from country_rosters ro join users u on u.user_id = ro.user_id
       where ro.is_tracked = 1 and ro.rank is not null and u.pp is not null
       group by u.user_id order by u.pp desc limit 1 offset ?`,
      [offset],
    )).rows[0];
    ppFloor = row ? Number(row.pp) : null;
  }

  const rows = (await exec(
    db,
    `select u.user_id, u.username, u.avatar_url, u.country_code, u.pp, u.global_rank, u.card_tier
     from country_rosters ro
     join users u on u.user_id = ro.user_id
     where ro.is_tracked = 1 and ro.rank is not null and u.pp is not null
       and u.card_tier = ?
       ${ppFloor !== null ? "and u.pp >= ?" : ""}
       ${excludeSql}
     group by u.user_id
     order by random()
     limit ?`,
    [options.tier, ...(ppFloor !== null ? [ppFloor] : []), ...exclude, count],
  )).rows;

  return rows.map((row) => ({
    userId: Number(row.user_id),
    username: String(row.username),
    avatarUrl: String(row.avatar_url),
    countryCode: String(row.country_code ?? ""),
    pp: Number(row.pp) || 0,
    globalRank: row.global_rank == null ? null : Number(row.global_rank),
    cardTier: row.card_tier == null ? null : String(row.card_tier),
  }));
}
