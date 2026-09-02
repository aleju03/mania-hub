/* The pack-count milestone event: what happens when the site's opened-packs
   total crosses a round number.

   Two things are dealt, both from the draw route and nowhere else:

   - The golden card. The signed-in open that finds the site-wide sum at or
     past the target gets its opener's own card at the Eternal tier, on a
     variant key of its own with the milestone's badge text and motif. One
     collector, one card, ever: claimPackMilestoneOnce races a claim token
     into pack_milestones exactly the way the completion reward does, so two
     opens landing on the number together have one winner and the loser's
     statements are all no-ops. An anonymous open still counts toward the
     total (its wallet is browser-local and never reaches pack_wallets, so it
     never did) but can never claim: the sum is read off pack_wallets, which
     only signed-in accounts have rows in, and the claim needs an owner.

   - The foil. For PACK_MILESTONE.foilWindowMs after the golden card lands,
     every open of every type rolls PACK_MILESTONE.foilChance for a
     commemorative variant of a random player from the pack's slice, appended
     as a bonus slot so a hit never costs the hand a card. One variant per
     player, registered in pack_milestone_cards, so every collector who pulls
     a player's foil holds the same collectible and "in N collections" counts
     them together. The card mints tierless like any dealt slot and the
     reveal's mint pass labels it; its per-holding tier_label and motif are
     what make it a foil, and applyPackCollectionCardMint leaves both alone.

   A milestone card is never the completion reward (OWN_ETERNAL_CLAIM_SQL in
   pack-wallets.ts excludes every key in pack_milestone_cards) and never rides
   the 0.0025% Eternal pull (which deals ':eternal' keys only), so the golden
   card stays one of one.

   Nothing announces any of this. There is no counter, no countdown and no
   public route: the golden card and the foils are the announcement, and the
   opened total already sits on /packs/collections for anyone counting.

   PACK_MILESTONE is hardcoded like GOAT_POLL: an event ships with a deploy
   rather than a VPS .env edit. The two env overrides exist for local testing
   only - a local database is hundreds of thousands of packs short of the
   number, and a 2% foil is slow to see by hand. */
import { randomUUID } from "node:crypto";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch } from "../db.js";
import { serializeCardMotif, type CardMotif } from "./card-motif.js";
import { mintPackCardSerialStatement } from "./pack-serials.js";
import {
  nextPackCardVariantNumber,
  normalizeAvatarUrl,
  normalizeCountryCode,
  PACK_CARD_MAX_PP,
  PACK_CARD_USERNAME_MAX_CHARS,
  packCardTierSlot,
  packCardVariantKey,
  type PackUserIdentity,
} from "./pack-wallets.js";

function envNumber(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const GOLDEN_MOTIF: CardMotif = {
  url: "https://mania-tracker.com/images/packs/milestone-1m.png",
  scale: 1.35,
  opacity: 0.9,
  /* The whole card goes gold with the emblem, not just the emblem. */
  palette: "gold",
};

const FOIL_MOTIF: CardMotif = {
  url: "https://mania-tracker.com/images/packs/milestone-1m.png",
  scale: 1,
  opacity: 0.55,
};

export const PACK_MILESTONE = {
  enabled: true,
  /* Scopes the tables; a later milestone (10M) is a new id. */
  id: "1m",
  /* Site-wide opened packs, summed over pack_wallets. */
  target: envNumber("PACK_MILESTONE_TARGET") ?? 1_000_000,
  goldenLabel: "1,000,000th pack",
  goldenMotif: GOLDEN_MOTIF,
  /* Per open, any pack type, while the foil window is open. */
  foilChance: envNumber("PACK_MILESTONE_FOIL_CHANCE") ?? 0.02,
  foilWindowMs: 7 * 24 * 60 * 60 * 1000,
  foilLabel: "1M",
  foilMotif: FOIL_MOTIF,
} as const;

export type PackMilestoneCardKind = "golden" | "foil";

export interface PackMilestoneClaim {
  ownerUserId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  cardKey: string;
  packsOpened: number;
  dealtAt: number;
}

export interface PackMilestoneStatus {
  id: string;
  target: number;
  /* The sum as of this read; the frontend counts live pulls on top of it. */
  opened: number;
  claim: PackMilestoneClaim | null;
  /* The foil window, once the milestone has landed; null before it. */
  foilOpensAt: number | null;
  foilClosesAt: number | null;
  foilChance: number;
  serverNow: number;
}

const OPENED_PACKS_SQL = "select coalesce(sum(json_extract(payload, '$.openedPacks')), 0) as opened from pack_wallets";

export async function countPacksOpened(db: Db): Promise<number> {
  const row = (await exec(db, OPENED_PACKS_SQL)).rows[0];
  return Math.max(0, Math.floor(Number(row?.opened) || 0));
}

function claimFromRow(row: Record<string, unknown> | undefined): PackMilestoneClaim | null {
  if (!row) return null;
  const ownerUserId = Math.floor(Number(row.owner_user_id) || 0);
  if (ownerUserId <= 0) return null;
  return {
    ownerUserId,
    username: String(row.username ?? ""),
    avatarUrl: normalizeAvatarUrl(row.avatar_url),
    countryCode: normalizeCountryCode(String(row.country_code ?? "")),
    cardKey: String(row.card_key ?? ""),
    packsOpened: Math.max(0, Math.floor(Number(row.packs_opened) || 0)),
    dealtAt: Math.max(0, Math.floor(Number(row.dealt_at) || 0)),
  };
}

/* The claim, with the winner's current name and avatar off the users row
   (the card catalog is the fallback for a collector the ingest never saw). */
export async function getPackMilestoneClaim(db: Db, milestoneId: string = PACK_MILESTONE.id): Promise<PackMilestoneClaim | null> {
  const row = (await exec(
    db,
    `select m.owner_user_id, m.card_key, m.packs_opened, m.dealt_at,
       coalesce(u.username, pc.username, '') as username,
       coalesce(u.avatar_url, pc.avatar_url, '') as avatar_url,
       coalesce(u.country_code, pc.country_code, '') as country_code
     from pack_milestones m
     left join users u on u.user_id = m.owner_user_id
     left join pack_cards pc on pc.card_key = m.card_key and pc.tier = 'eternal'
     where m.milestone_id = ?`,
    [milestoneId],
  )).rows[0];
  return claimFromRow(row as Record<string, unknown> | undefined);
}

/* The event's state in one read. Deliberately not on any public route: the
   event is a surprise, and the opened total is already on /packs/collections
   for anyone who wants to count. Cached briefly for whatever admin surface
   reads it, since the sum runs on the serving loop. */
let statusCache: { value: PackMilestoneStatus; expiresAt: number } | null = null;
const STATUS_CACHE_MS = 10_000;

export async function getPackMilestoneStatus(db: Db, now = Date.now()): Promise<PackMilestoneStatus | null> {
  if (!PACK_MILESTONE.enabled) return null;
  if (statusCache && statusCache.expiresAt > now) return { ...statusCache.value, serverNow: now };
  const [claim, opened] = await Promise.all([getPackMilestoneClaim(db), countPacksOpened(db)]);
  const value: PackMilestoneStatus = {
    id: PACK_MILESTONE.id,
    target: PACK_MILESTONE.target,
    opened,
    claim,
    foilOpensAt: claim ? claim.dealtAt : null,
    foilClosesAt: claim ? claim.dealtAt + PACK_MILESTONE.foilWindowMs : null,
    foilChance: PACK_MILESTONE.foilChance,
    serverNow: now,
  };
  statusCache = { value, expiresAt: now + STATUS_CACHE_MS };
  return value;
}

/* Whether a foil may be dealt right now: the milestone has landed and its
   window is still open. Read on a hit only, so an event that has not
   happened yet (or is long over) costs the draw nothing. */
export async function isPackMilestoneFoilWindowOpen(db: Db, now = Date.now()): Promise<boolean> {
  if (!PACK_MILESTONE.enabled) return false;
  const row = (await exec(db, "select dealt_at from pack_milestones where milestone_id = ?", [PACK_MILESTONE.id])).rows[0];
  const dealtAt = Number(row?.dealt_at);
  if (!Number.isFinite(dealtAt) || dealtAt <= 0) return false;
  return now >= dealtAt && now < dealtAt + PACK_MILESTONE.foilWindowMs;
}

function clampPp(value: number): number {
  return Math.min(PACK_CARD_MAX_PP, Math.max(0, Number.isFinite(value) ? value : 0));
}

function clampRank(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

export interface PackMilestoneDeal {
  dealt: boolean;
  cardKey: string | null;
  isNew: boolean;
  packsOpened: number;
}

/* Claims the milestone for this open if the site-wide total has reached the
   target, minting the golden card in the same transaction.

   The sum is read after the opener's own spend, so the pack that makes the
   number is the pack that wins it. Whoever reads the number first past the
   target wins the primary key; the card, its catalog face, the registry row
   and the serial are all conditional on the claim row carrying this
   attempt's token, so a losing attempt writes nothing and a failed
   transaction leaves the milestone unclaimed for the next open. The variant
   number is resolved before the batch and may be computed by both racers;
   only the winner's statements run, so the loser cannot burn it. */
export async function claimPackMilestoneOnce(
  db: Db,
  ownerUserId: number,
  /* Called only once this open is at the number and the milestone is
     unclaimed: resolving the opener's face can cost an osu! call. */
  resolveIdentity: () => Promise<PackUserIdentity>,
  now = Date.now(),
): Promise<PackMilestoneDeal> {
  const none: PackMilestoneDeal = { dealt: false, cardKey: null, isNew: false, packsOpened: 0 };
  if (!PACK_MILESTONE.enabled) return none;
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return none;
  const claimed = (await exec(db, "select 1 from pack_milestones where milestone_id = ?", [PACK_MILESTONE.id])).rows.length > 0;
  if (claimed) return none;
  const packsOpened = await countPacksOpened(db);
  if (packsOpened < PACK_MILESTONE.target) return { ...none, packsOpened };
  const identity = await resolveIdentity();

  const cardKey = packCardVariantKey(ownerUserId, await nextPackCardVariantNumber(db, ownerUserId));
  const claimToken = randomUUID();
  const claimMatchSql = "exists (select 1 from pack_milestones where milestone_id = ? and claim_token = ?)";
  const claimArgs = [PACK_MILESTONE.id, claimToken];
  const results = await execBatch(db, [
    {
      sql: `insert or ignore into pack_milestones (
              milestone_id, target, owner_user_id, claim_token, card_key, packs_opened, dealt_at
            ) values (?, ?, ?, ?, ?, ?, ?)`,
      args: [PACK_MILESTONE.id, PACK_MILESTONE.target, ownerUserId, claimToken, cardKey, packsOpened, now],
    },
    {
      sql: `insert or ignore into pack_milestone_cards (milestone_id, card_user_id, kind, card_key, created_at)
            select ?, ?, 'golden', ?, ? where ${claimMatchSql}`,
      args: [PACK_MILESTONE.id, ownerUserId, cardKey, now, ...claimArgs],
    },
    {
      sql: `insert or ignore into pack_cards (
              card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
            )
            select ?, 'eternal', ?, ?, ?, ?, ?, ? where ${claimMatchSql}`,
      args: [
        cardKey,
        ownerUserId,
        identity.username.slice(0, PACK_CARD_USERNAME_MAX_CHARS),
        normalizeAvatarUrl(identity.avatarUrl),
        normalizeCountryCode(identity.countryCode),
        PACK_MILESTONE.goldenLabel,
        now,
        ...claimArgs,
      ],
    },
    {
      sql: `insert or ignore into pack_collection_cards (
              owner_user_id, card_user_id, card_key, tier, tier_label, motif, skills_id, pp, global_rank,
              copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at, completion_eligible
            )
            select ?, ?, ?, 'eternal', ?, ?, null, ?, ?, 1, 0, ?, ?, ?, 1 where ${claimMatchSql}`,
      args: [
        ownerUserId,
        ownerUserId,
        cardKey,
        PACK_MILESTONE.goldenLabel,
        serializeCardMotif(PACK_MILESTONE.goldenMotif),
        clampPp(identity.pp),
        clampRank(identity.globalRank),
        now,
        now,
        now,
        ...claimArgs,
      ],
    },
    {
      sql: `insert or ignore into pack_card_serials (
              card_key, card_user_id, owner_user_id, serial, minted_at, pull_report_pending
            )
            select ?, ?, ?, 1, ?, 1 where ${claimMatchSql}`,
      args: [cardKey, ownerUserId, ownerUserId, now, ...claimArgs],
    },
  ]);
  const dealt = Number(results[0]?.rowsAffected ?? 0) > 0;
  if (dealt) statusCache = null;
  return { dealt, cardKey: dealt ? cardKey : null, isNew: dealt, packsOpened };
}

/* The foil variant key for one player, minted on first use. Two concurrent
   first pulls of the same player both compute the next number and both
   insert-or-ignore; the read-back is the one that won. */
async function resolvePackMilestoneFoilKey(db: Db, cardUserId: number, now: number): Promise<string> {
  const read = async () => {
    const row = (await exec(
      db,
      "select card_key from pack_milestone_cards where milestone_id = ? and card_user_id = ? and kind = 'foil'",
      [PACK_MILESTONE.id, cardUserId],
    )).rows[0];
    return typeof row?.card_key === "string" ? row.card_key : null;
  };
  const existing = await read();
  if (existing) return existing;
  const candidate = packCardVariantKey(cardUserId, await nextPackCardVariantNumber(db, cardUserId));
  await exec(
    db,
    "insert or ignore into pack_milestone_cards (milestone_id, card_user_id, kind, card_key, created_at) values (?, ?, 'foil', ?, ?)",
    [PACK_MILESTONE.id, cardUserId, candidate, now],
  );
  return (await read()) ?? candidate;
}

export interface PackMilestoneFoilDeal {
  cardKey: string;
  isNew: boolean;
  customLabel: string;
  motif: CardMotif;
}

/* Writes a dealt foil into the collection: one more copy of that player's
   foil variant, tierless like every dealt slot (the reveal's mint pass labels
   it), with the badge text and motif that make it a foil on the holding
   itself. Same serial rule as the Eternal pull: the serial mints once and a
   repeat re-arms the pending bit, so each deal buys one feed line. */
export async function mintPackMilestoneFoilCard(
  db: Db,
  ownerUserId: number,
  cardUserId: number,
  identity: PackUserIdentity,
  now = Date.now(),
): Promise<PackMilestoneFoilDeal> {
  const cardKey = await resolvePackMilestoneFoilKey(db, cardUserId, now);
  const owned = (await exec(
    db,
    "select 1 from pack_collection_cards where owner_user_id = ? and card_key = ? and copies > 0",
    [ownerUserId, cardKey],
  )).rows.length > 0;
  const statements: DbStatement[] = [
    {
      sql: `insert or ignore into pack_cards (
              card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        cardKey,
        packCardTierSlot(null),
        cardUserId,
        identity.username.slice(0, PACK_CARD_USERNAME_MAX_CHARS),
        normalizeAvatarUrl(identity.avatarUrl),
        normalizeCountryCode(identity.countryCode),
        PACK_MILESTONE.foilLabel,
        now,
      ],
    },
    {
      sql: `insert into pack_collection_cards (
              owner_user_id, card_user_id, card_key, tier, tier_label, motif, skills_id, pp, global_rank,
              copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at, completion_eligible
            ) values (?, ?, ?, null, ?, ?, null, ?, ?, 1, 0, ?, ?, ?, 1)
            on conflict(owner_user_id, card_key) do update set
              tier_label = coalesce(pack_collection_cards.tier_label, excluded.tier_label),
              motif = coalesce(pack_collection_cards.motif, excluded.motif),
              pp = case when excluded.pp > 0 then excluded.pp else pack_collection_cards.pp end,
              global_rank = case when excluded.global_rank > 0 then excluded.global_rank else pack_collection_cards.global_rank end,
              copies = pack_collection_cards.copies + 1,
              first_pulled_at = min(pack_collection_cards.first_pulled_at, excluded.first_pulled_at),
              last_pulled_at = max(pack_collection_cards.last_pulled_at, excluded.last_pulled_at),
              updated_at = excluded.updated_at,
              completion_eligible = 1`,
      args: [
        ownerUserId,
        cardUserId,
        cardKey,
        PACK_MILESTONE.foilLabel,
        serializeCardMotif(PACK_MILESTONE.foilMotif),
        clampPp(identity.pp),
        clampRank(identity.globalRank),
        now,
        now,
        now,
      ],
    },
    mintPackCardSerialStatement(cardKey, cardUserId, ownerUserId, now, { pullReportPending: true }),
    {
      sql: "update pack_card_serials set pull_report_pending = 1 where card_key = ? and owner_user_id = ?",
      args: [cardKey, ownerUserId],
    },
  ];
  await execBatch(db, statements);
  return { cardKey, isNew: !owned, customLabel: PACK_MILESTONE.foilLabel, motif: PACK_MILESTONE.foilMotif };
}

/* The milestone keys this collector holds that a client may name in a pull
   report or a mint, so pack-pulls.ts can believe a variant key it would
   otherwise have no way to derive. */
export async function listHeldPackMilestoneCardKeys(db: Db, ownerUserId: number, cardKeys: readonly string[]): Promise<Set<string>> {
  if (cardKeys.length === 0) return new Set();
  const rows = (await exec(
    db,
    `select c.card_key from pack_collection_cards c
     join pack_milestone_cards m on m.card_key = c.card_key
     where c.owner_user_id = ? and c.copies > 0 and c.card_key in (${cardKeys.map(() => "?").join(", ")})`,
    [ownerUserId, ...cardKeys],
  )).rows;
  return new Set(rows.map((row) => String(row.card_key)));
}

/* Test seam: the status cache would otherwise outlive a test's database. */
export function resetPackMilestoneStatusCache(): void {
  statusCache = null;
}
