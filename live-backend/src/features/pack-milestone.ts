/* The pack-count milestone events: what happens when the site's opened-packs
   total crosses each round number.

   The ladder runs 1M through 9M. Every million has its own golden card, its
   own emblem and its own collector: the signed-in open that finds the
   site-wide sum at or past the next unclaimed target gets its opener's own
   card at the Eternal tier, on a variant key of its own with that milestone's
   badge text and motif. One collector, one card, per number, ever:
   claimPackMilestoneOnce races a claim token into pack_milestones exactly the
   way the completion reward does, scoped by milestone id, so two opens
   landing on the same number together have one winner and the loser's
   statements are all no-ops. An anonymous open never counts toward the total
   (its wallet is browser-local and never reaches pack_wallets) and can never
   claim: the sum is read off pack_wallets, which only signed-in accounts have
   rows in, and the claim needs an owner. One open deals at most one card, so
   a site already past several numbers hands them out one pack at a time.

   A milestone card is never the completion reward (OWN_ETERNAL_CLAIM_SQL in
   pack-wallets.ts excludes every key in pack_milestone_cards) and never rides
   the 0.0025% Eternal pull (which deals ':eternal' keys only), so each golden
   card stays one of one.

   Nothing announces this. There is no counter, no countdown and no public
   route: the golden card is the announcement, and the opened total already
   sits on /packs/collections for anyone counting.

   PACK_MILESTONES is hardcoded like GOAT_POLL: the ladder ships with a deploy
   rather than a VPS .env edit. The step env override exists for local testing
   only because a local database is hundreds of thousands of packs short of
   the first number. */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, execBatch } from "../db.js";
import { serializeCardMotif, type CardMotif } from "./card-motif.js";
import {
  nextPackCardVariantNumber,
  normalizeAvatarUrl,
  normalizeCountryCode,
  PACK_CARD_MAX_PP,
  PACK_CARD_USERNAME_MAX_CHARS,
  packCardVariantKey,
  type PackUserIdentity,
} from "./pack-wallets.js";

function envNumber(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface PackMilestone {
  /* Scopes the tables; every rung of the ladder is its own event. */
  id: string;
  /* Site-wide opened packs, summed over pack_wallets. */
  target: number;
  goldenLabel: string;
  goldenMotif: CardMotif;
}

export const PACK_MILESTONES_ENABLED = true;

/* Local testing puts the whole ladder within reach of a small database; the
   badge text still names the real number, since that is the event's name. */
const MILESTONE_STEP = envNumber("PACK_MILESTONE_TARGET") ?? 1_000_000;
const MILESTONE_RUNGS = 9;

export const PACK_MILESTONES: readonly PackMilestone[] = Array.from({ length: MILESTONE_RUNGS }, (_, index) => {
  const rung = index + 1;
  return {
    id: `${rung}m`,
    target: MILESTONE_STEP * rung,
    goldenLabel: `${rung},000,000th pack`,
    goldenMotif: {
      /* One emblem per number, all on our own domain (siteAssetMotifPath). */
      url: `https://mania-tracker.com/images/packs/milestone-${rung}m.png`,
      scale: 1.35,
      opacity: 0.9,
      /* The whole card goes gold with the emblem, not just the emblem. */
      palette: "gold",
    },
  };
});

export interface PackMilestoneClaim {
  milestoneId: string;
  ownerUserId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  cardKey: string;
  packsOpened: number;
  dealtAt: number;
}

export interface PackMilestoneStatus {
  /* The number the site is working toward, null once all nine are gone. */
  pending: PackMilestone | null;
  /* The sum as of this read; the frontend counts live pulls on top of it. */
  opened: number;
  /* Every golden card dealt so far, in ladder order. */
  claims: PackMilestoneClaim[];
  serverNow: number;
}

const OPENED_PACKS_SQL = "select coalesce(sum(json_extract(payload, '$.openedPacks')), 0) as opened from pack_wallets";

export async function countPacksOpened(db: Db): Promise<number> {
  const row = (await exec(db, OPENED_PACKS_SQL)).rows[0];
  return Math.max(0, Math.floor(Number(row?.opened) || 0));
}

/* The milestones already dealt. The registry holds nine rows at most, but the
   hot path is every pack open for as long as any rung is unclaimed, so it is
   cached: a claim in this process drops the cache, another process's claim is
   picked up within the TTL, and a stale read is harmless because the claim
   itself re-reads the registry and the insert is atomic either way. */
const CLAIMED_TTL_MS = 30_000;
let claimedCache: { ids: Set<string>; expiresAt: number } | null = null;

async function readClaimedIds(db: Db): Promise<Set<string>> {
  const rows = (await exec(db, "select milestone_id from pack_milestones")).rows;
  claimedCache = { ids: new Set(rows.map((row) => String(row.milestone_id))), expiresAt: Date.now() + CLAIMED_TTL_MS };
  return claimedCache.ids;
}

async function claimedIds(db: Db, now: number): Promise<Set<string>> {
  if (claimedCache && claimedCache.expiresAt > now) return claimedCache.ids;
  return readClaimedIds(db);
}

export function nextPackMilestone(claimed: ReadonlySet<string>): PackMilestone | null {
  return PACK_MILESTONES.find((milestone) => !claimed.has(milestone.id)) ?? null;
}

/* The site-wide sum is the same 1-2ms query the community totals run, and with
   a ladder there is an unclaimed number on nearly every open rather than only
   until the first one falls, so it cannot ride every open forever. The floor
   is a recent sum plus the opens this process has seen since it was taken;
   while that estimate is further than APPROACH_PACKS from the next number the
   claim trusts it, and inside that window every open pays for the exact sum.
   The estimate only ever runs behind (another process's opens are missing from
   it), so the window is what guarantees the pack that makes the number is
   still the pack that wins it: crossing it would take 5,000 opens inside one
   TTL, which is two orders of magnitude past what the site does. */
const FLOOR_TTL_MS = 30_000;
const APPROACH_PACKS = 5_000;
let openedFloor: { value: number; expiresAt: number; seen: number } | null = null;

async function packsOpenedForClaim(db: Db, target: number, now: number): Promise<number> {
  const floor = openedFloor;
  if (floor && floor.expiresAt > now) {
    floor.seen += 1;
    const estimate = floor.value + floor.seen;
    if (estimate < target - APPROACH_PACKS) return estimate;
  }
  const opened = await countPacksOpened(db);
  openedFloor = { value: opened, expiresAt: now + FLOOR_TTL_MS, seen: 0 };
  return opened;
}

function claimFromRow(row: Record<string, unknown> | undefined): PackMilestoneClaim | null {
  if (!row) return null;
  const ownerUserId = Math.floor(Number(row.owner_user_id) || 0);
  if (ownerUserId <= 0) return null;
  return {
    milestoneId: String(row.milestone_id ?? ""),
    ownerUserId,
    username: String(row.username ?? ""),
    avatarUrl: normalizeAvatarUrl(row.avatar_url),
    countryCode: normalizeCountryCode(String(row.country_code ?? "")),
    cardKey: String(row.card_key ?? ""),
    packsOpened: Math.max(0, Math.floor(Number(row.packs_opened) || 0)),
    dealtAt: Math.max(0, Math.floor(Number(row.dealt_at) || 0)),
  };
}

/* The claims, each with its winner's current name and avatar off the users row
   (the card catalog is the fallback for a collector the ingest never saw). */
export async function listPackMilestoneClaims(db: Db): Promise<PackMilestoneClaim[]> {
  const rows = (await exec(
    db,
    `select m.milestone_id, m.owner_user_id, m.card_key, m.packs_opened, m.dealt_at,
       coalesce(u.username, pc.username, '') as username,
       coalesce(u.avatar_url, pc.avatar_url, '') as avatar_url,
       coalesce(u.country_code, pc.country_code, '') as country_code
     from pack_milestones m
     left join users u on u.user_id = m.owner_user_id
     left join pack_cards pc on pc.card_key = m.card_key and pc.tier = 'eternal'
     order by m.target`,
  )).rows;
  return rows.map((row) => claimFromRow(row as Record<string, unknown>)).filter((claim): claim is PackMilestoneClaim => claim !== null);
}

/* The ladder's state in one read. Deliberately not on any public route: the
   events are a surprise, and the opened total is already on /packs/collections
   for anyone who wants to count. Cached briefly for whatever admin surface
   reads it, since the sum runs on the serving loop. */
let statusCache: { value: PackMilestoneStatus; expiresAt: number } | null = null;
const STATUS_CACHE_MS = 10_000;

export async function getPackMilestoneStatus(db: Db, now = Date.now()): Promise<PackMilestoneStatus | null> {
  if (!PACK_MILESTONES_ENABLED) return null;
  if (statusCache && statusCache.expiresAt > now) return { ...statusCache.value, serverNow: now };
  const [claims, opened] = await Promise.all([listPackMilestoneClaims(db), countPacksOpened(db)]);
  const value: PackMilestoneStatus = {
    pending: nextPackMilestone(new Set(claims.map((claim) => claim.milestoneId))),
    opened,
    claims,
    serverNow: now,
  };
  statusCache = { value, expiresAt: now + STATUS_CACHE_MS };
  return value;
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
  /* The number this card was dealt for, so the route labels the slot with the
     event that was actually claimed rather than with a fixed one. */
  milestone: PackMilestone | null;
}

/* Claims the next unclaimed milestone for this open if the site-wide total has
   reached its target, minting the golden card in the same transaction.

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
  /* Called only once this open is at a number and that milestone is
     unclaimed: resolving the opener's face can cost an osu! call. */
  resolveIdentity: () => Promise<PackUserIdentity>,
  now = Date.now(),
): Promise<PackMilestoneDeal> {
  const none: PackMilestoneDeal = { dealt: false, cardKey: null, isNew: false, packsOpened: 0, milestone: null };
  if (!PACK_MILESTONES_ENABLED) return none;
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return none;
  const pending = nextPackMilestone(await claimedIds(db, now));
  if (!pending) return none;
  const packsOpened = await packsOpenedForClaim(db, pending.target, now);
  if (packsOpened < pending.target) return { ...none, packsOpened };
  /* At the number: re-read the registry rather than trust the cache, so a rung
     another process just took is not paid an identity call for. */
  const milestone = nextPackMilestone(await readClaimedIds(db));
  if (!milestone || packsOpened < milestone.target) return { ...none, packsOpened };
  const identity = await resolveIdentity();

  const cardKey = packCardVariantKey(ownerUserId, await nextPackCardVariantNumber(db, ownerUserId));
  const claimToken = randomUUID();
  const claimMatchSql = "exists (select 1 from pack_milestones where milestone_id = ? and claim_token = ?)";
  const claimArgs = [milestone.id, claimToken];
  const results = await execBatch(db, [
    {
      sql: `insert or ignore into pack_milestones (
              milestone_id, target, owner_user_id, claim_token, card_key, packs_opened, dealt_at
            ) values (?, ?, ?, ?, ?, ?, ?)`,
      args: [milestone.id, milestone.target, ownerUserId, claimToken, cardKey, packsOpened, now],
    },
    {
      sql: `insert or ignore into pack_milestone_cards (milestone_id, card_user_id, kind, card_key, created_at)
            select ?, ?, 'golden', ?, ? where ${claimMatchSql}`,
      args: [milestone.id, ownerUserId, cardKey, now, ...claimArgs],
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
        milestone.goldenLabel,
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
        milestone.goldenLabel,
        serializeCardMotif(milestone.goldenMotif),
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
  if (dealt) {
    statusCache = null;
    claimedCache = null;
    openedFloor = null;
  }
  return { dealt, cardKey: dealt ? cardKey : null, isNew: dealt, packsOpened, milestone: dealt ? milestone : null };
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

/* Test seam: the caches would otherwise outlive a test's database. */
export function resetPackMilestoneStatusCache(): void {
  statusCache = null;
  claimedCache = null;
  openedFloor = null;
}
