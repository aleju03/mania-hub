import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { tierRankSql } from "./pack-wallets.js";

// Append-only log of pack pulls, the community layer on top of the per-owner
// pack_collection_cards projection. Rows are self-reported by the client
// (the draw and mint both happen browser-side), so everything derived here is
// social flavor, never economy: the feed, "owned by N collectors" counts and
// "your card got pulled" stats. The wallet itself stays untouched.

export const PACK_PULL_MAX_CARDS_PER_EVENT = 10;
// A generous ceiling on how fast a single account can append events: five
// charge packs per regen cycle plus shard packs lands well under this. Past
// the cap the batch is dropped silently; the wallet sync is unaffected.
export const PACK_PULL_OWNER_HOURLY_CAP = 600;
export const PACK_PULL_FEED_MAX_LIMIT = 50;

// The feed only carries pulls worth broadcasting: high mints and cards nobody
// had ever pulled before.
const NOTABLE_TIERS = new Set([
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
  "goat",
]);

const VALID_TIERS = new Set([
  "common",
  "rare",
  "elite",
  "superRare",
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
  "goat",
]);

export interface PackPullCardInput {
  userId: number;
  username: string;
  countryCode: string;
  tier: string | null;
  isNew: boolean;
}

export interface PackPullFeedEntry {
  id: number;
  ownerUserId: number;
  ownerUsername: string;
  cardUserId: number;
  cardUsername: string;
  cardCountryCode: string;
  cardAvatarUrl: string | null;
  tier: string | null;
  packType: string;
  isNew: boolean;
  isFirstGlobal: boolean;
  pulledAt: number;
}

export interface PackCardStats {
  userId: number;
  owners: number;
  copies: number;
}

export interface PackPulledStats {
  userId: number;
  owners: number;
  copies: number;
  pullEvents7d: number;
  lastPulledAt: number | null;
}

function normalizePackType(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_]{1,24}$/.test(value) ? value : null;
}

function normalizePullCard(value: unknown): PackPullCardInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const userId = Math.floor(Number(raw.userId) || 0);
  if (userId <= 0 || typeof raw.username !== "string" || raw.username.length === 0) return null;
  const tier = typeof raw.tier === "string" && VALID_TIERS.has(raw.tier) ? raw.tier : null;
  return {
    userId,
    username: raw.username.slice(0, 40),
    countryCode: typeof raw.countryCode === "string" ? raw.countryCode.slice(0, 2).toUpperCase() : "",
    tier,
    isNew: raw.isNew === true,
  };
}

/* Live identity overlay, same idea as pack-wallets: rows freeze the name at
   pull time, reads prefer the current users row so renames show up. */
function liveUserFieldSql(idColumn: string, field: "username" | "avatar_url"): string {
  return `(select u.${field} from users u where u.user_id = pack_pull_events.${idColumn})`;
}

export async function recordPackPullEvents(
  db: Db,
  ownerUserId: number,
  ownerUsername: string,
  packType: unknown,
  cards: unknown,
  now = Date.now(),
): Promise<{ recorded: number }> {
  const type = normalizePackType(packType);
  if (!type || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return { recorded: 0 };
  const normalized = (Array.isArray(cards) ? cards : [])
    .map(normalizePullCard)
    .filter((card): card is PackPullCardInput => Boolean(card))
    .slice(0, PACK_PULL_MAX_CARDS_PER_EVENT);
  if (normalized.length === 0) return { recorded: 0 };

  const hourAgo = now - 60 * 60 * 1000;
  const recent = (await exec(
    db,
    "select count(*) as n from pack_pull_events where owner_user_id = ? and pulled_at > ?",
    [ownerUserId, hourAgo],
  )).rows[0];
  if ((Number(recent?.n) || 0) + normalized.length > PACK_PULL_OWNER_HOURLY_CAP) return { recorded: 0 };

  let recorded = 0;
  for (const card of normalized) {
    // First-global means nobody, anywhere, holds or ever pulled this card:
    // no prior event and no other owner's collection row (the caller's own
    // row may already exist when the wallet sync raced this call).
    const priorEvent = (await exec(
      db,
      "select 1 from pack_pull_events where card_user_id = ? limit 1",
      [card.userId],
    )).rows[0];
    const otherOwner = priorEvent
      ? undefined
      : (await exec(
          db,
          "select 1 from pack_collection_cards where card_user_id = ? and owner_user_id != ? limit 1",
          [card.userId, ownerUserId],
        )).rows[0];
    const isFirstGlobal = !priorEvent && !otherOwner;
    const notable = isFirstGlobal || (card.tier !== null && NOTABLE_TIERS.has(card.tier));
    await exec(
      db,
      `insert into pack_pull_events (
         owner_user_id, owner_username, card_user_id, card_username, card_country_code,
         tier, pack_type, is_new, is_first_global, notable, pulled_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ownerUserId,
        ownerUsername.slice(0, 40),
        card.userId,
        card.username,
        card.countryCode,
        card.tier,
        type,
        card.isNew ? 1 : 0,
        isFirstGlobal ? 1 : 0,
        notable ? 1 : 0,
        now,
      ],
    );
    recorded += 1;
  }
  return { recorded };
}

/* Community ownership counts for a hand of cards ("owned by N collectors").
   Reads only the durable collection projection, so counts are right even for
   cards pulled before the event log existed. */
export async function getPackCardStats(db: Db, cardUserIds: number[]): Promise<PackCardStats[]> {
  const ids = [...new Set(cardUserIds.map((id) => Math.floor(Number(id) || 0)).filter((id) => id > 0))]
    .slice(0, PACK_PULL_MAX_CARDS_PER_EVENT);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select card_user_id, count(distinct owner_user_id) as owners, coalesce(sum(copies), 0) as copies
     from pack_collection_cards
     where card_user_id in (${placeholders}) and copies > 0
     group by card_user_id`,
    ids as InValue[],
  )).rows;
  const byId = new Map(rows.map((row) => [Number(row.card_user_id), row]));
  return ids.map((userId) => {
    const row = byId.get(userId);
    return {
      userId,
      owners: Number(row?.owners) || 0,
      copies: Number(row?.copies) || 0,
    };
  });
}

/* "You got pulled": how the community holds this player's card. Durable
   counts come from the collection projection; the 7-day figure comes from
   the event log so it reflects recency the projection cannot express. */
export async function getPackPulledStats(db: Db, cardUserId: number): Promise<PackPulledStats> {
  const collectionRow = (await exec(
    db,
    `select count(distinct owner_user_id) as owners, coalesce(sum(copies), 0) as copies, max(last_pulled_at) as last_pulled_at
     from pack_collection_cards
     where card_user_id = ? and copies > 0`,
    [cardUserId],
  )).rows[0];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const eventRow = (await exec(
    db,
    `select count(*) as recent, max(pulled_at) as last_pulled_at
     from pack_pull_events
     where card_user_id = ? and pulled_at > ?`,
    [cardUserId, weekAgo],
  )).rows[0];
  const lastFromCollection = Number(collectionRow?.last_pulled_at) || 0;
  const lastFromEvents = Number(eventRow?.last_pulled_at) || 0;
  const lastPulledAt = Math.max(lastFromCollection, lastFromEvents);
  return {
    userId: cardUserId,
    owners: Number(collectionRow?.owners) || 0,
    copies: Number(collectionRow?.copies) || 0,
    pullEvents7d: Number(eventRow?.recent) || 0,
    lastPulledAt: lastPulledAt > 0 ? lastPulledAt : null,
  };
}

export interface SharedPackCard {
  owner: { userId: number; username: string };
  card: {
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
    firstPulledAt: number;
  };
  owners: number;
  /* Set only when the pull log recorded this card arriving at the GOAT tier,
     which is the one case where the pack it came from is worth naming. Absent
     for a card pulled out of the ranked pool before the player joined the
     honorary roster, and for pulls older than the log. */
  goatPull: { packType: string; pulledAt: number } | null;
}

/* One owned card as a shareable artifact ("aleju pulled this"), backing the
   /pull/{owner}/{card} permalink and its OG image. Reads the durable
   collection row (with the minted tier and skills snapshot), so share links
   outlive pull-event retention; they only die if the card is fully
   recycled. */
/* The permalink addresses a player, not a card key, so an owner holding both
   a player's ordinary card and their GOAT resolves to the GOAT: it is the
   rarer pull and the one worth sharing. */
export async function getSharedPackCard(
  db: Db,
  ownerUserId: number,
  cardUserId: number,
): Promise<SharedPackCard | null> {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) return null;
  if (!Number.isInteger(cardUserId) || cardUserId <= 0) return null;
  const row = (await exec(
    db,
    `select pack_collection_cards.*,
       (select u.username from users u where u.user_id = pack_collection_cards.card_user_id) as live_username,
       (select u.avatar_url from users u where u.user_id = pack_collection_cards.card_user_id) as live_avatar_url,
       (select u.country_code from users u where u.user_id = pack_collection_cards.card_user_id) as live_country_code,
       (select u.username from users u where u.user_id = pack_collection_cards.owner_user_id) as live_owner_username
     from pack_collection_cards
     where owner_user_id = ? and card_user_id = ? and copies > 0
     order by ${tierRankSql("tier")} desc
     limit 1`,
    [ownerUserId, cardUserId],
  )).rows[0];
  if (!row) return null;
  // The owner may not be a tracked player (no users row); the pull log then
  // remembers the name their pulls were recorded under.
  let ownerUsername = nonEmptyString(row.live_owner_username);
  if (!ownerUsername) {
    const eventRow = (await exec(
      db,
      "select owner_username from pack_pull_events where owner_user_id = ? order by pulled_at desc limit 1",
      [ownerUserId],
    )).rows[0];
    ownerUsername = nonEmptyString(eventRow?.owner_username);
  }
  const ownersRow = (await exec(
    db,
    "select count(distinct owner_user_id) as owners from pack_collection_cards where card_user_id = ? and copies > 0",
    [cardUserId],
  )).rows[0];
  // The first time this owner pulled this card as a GOAT. Earliest rather than
  // latest: a later duplicate says nothing the first one didn't.
  const goatRow = (await exec(
    db,
    `select pack_type, pulled_at from pack_pull_events
     where owner_user_id = ? and card_user_id = ? and tier = 'goat'
     order by pulled_at asc limit 1`,
    [ownerUserId, cardUserId],
  )).rows[0];
  let skills: unknown | null = null;
  if (typeof row.skills_json === "string" && row.skills_json) {
    try {
      skills = JSON.parse(row.skills_json);
    } catch {
      skills = null;
    }
  }
  return {
    owner: { userId: ownerUserId, username: ownerUsername ?? "a collector" },
    card: {
      userId: cardUserId,
      username: nonEmptyString(row.live_username) ?? String(row.username ?? ""),
      avatarUrl: nonEmptyString(row.live_avatar_url) ?? String(row.avatar_url ?? ""),
      countryCode: nonEmptyString(row.live_country_code) ?? String(row.country_code ?? ""),
      tier: typeof row.tier === "string" ? row.tier : null,
      tierLabel: typeof row.tier_label === "string" ? row.tier_label : null,
      skills,
      pp: Number(row.pp) || 0,
      globalRank: Number(row.global_rank) || 0,
      copies: Number(row.copies) || 0,
      firstPulledAt: Number(row.first_pulled_at) || 0,
    },
    owners: Number(ownersRow?.owners) || 0,
    goatPull: goatRow
      ? { packType: String(goatRow.pack_type ?? ""), pulledAt: Number(goatRow.pulled_at) || 0 }
      : null,
  };
}

/* The pull feed. notableOnly keeps it to high mints and first-ever pulls
   (the shareable moments); the packs page's ambient live ticker asks for
   everything, since the point there is the constant pulse of packs being
   ripped open. */
export async function listRecentPackPulls(db: Db, limit: number, notableOnly = true): Promise<PackPullFeedEntry[]> {
  const cappedLimit = Math.min(PACK_PULL_FEED_MAX_LIMIT, Math.max(1, Math.floor(limit) || 1));
  const rows = (await exec(
    db,
    `select id, owner_user_id, owner_username, card_user_id, card_username, card_country_code,
       tier, pack_type, is_new, is_first_global, pulled_at,
       ${liveUserFieldSql("owner_user_id", "username")} as live_owner_username,
       ${liveUserFieldSql("card_user_id", "username")} as live_card_username,
       ${liveUserFieldSql("card_user_id", "avatar_url")} as card_avatar_url
     from pack_pull_events
     ${notableOnly ? "where notable = 1" : ""}
     order by pulled_at desc, id desc
     limit ?`,
    [cappedLimit],
  )).rows;
  return rows.map((row) => ({
    id: Number(row.id),
    ownerUserId: Number(row.owner_user_id),
    ownerUsername: nonEmptyString(row.live_owner_username) ?? String(row.owner_username ?? ""),
    cardUserId: Number(row.card_user_id),
    cardUsername: nonEmptyString(row.live_card_username) ?? String(row.card_username ?? ""),
    cardCountryCode: String(row.card_country_code ?? ""),
    cardAvatarUrl: nonEmptyString(row.card_avatar_url),
    tier: typeof row.tier === "string" ? row.tier : null,
    packType: String(row.pack_type ?? ""),
    isNew: Number(row.is_new) === 1,
    isFirstGlobal: Number(row.is_first_global) === 1,
    pulledAt: Number(row.pulled_at) || 0,
  }));
}

export interface HonoraryCardOwner {
  userId: number;
  username: string;
  copies: number;
  firstPulledAt: number;
  lastPulledAt: number;
}

export interface HonoraryCardPulls {
  cardUserId: number;
  cardUsername: string | null;
  owners: HonoraryCardOwner[];
  /* Every owner holding at least one copy, even when `owners` is truncated. */
  ownerCount: number;
  copies: number;
  firstPulledAt: number | null;
  lastPulledAt: number | null;
}

/* A collector's whole GOAT haul, counted across every card rather than per
   card, so "who has the most" is answerable without walking the roster. */
export interface HonoraryCollector {
  userId: number;
  username: string;
  cards: number;
  copies: number;
  lastPulledAt: number;
}

/* The newest GOAT in anyone's collection: the first question the readout gets
   asked, and the one the per-card list buries. */
export interface HonoraryLatestPull {
  ownerUserId: number;
  ownerUsername: string;
  cardUserId: number;
  cardUsername: string | null;
  pulledAt: number;
}

export interface HonoraryPullsReport {
  rosterSize: number;
  pulledCards: number;
  distinctOwners: number;
  totalCopies: number;
  cards: HonoraryCardPulls[];
  collectors: HonoraryCollector[];
  collectorsListed: number;
  latest: HonoraryLatestPull | null;
  ownersPerCard: number;
  capturedAt: number;
}

/* The leaderboard is a summary, not a browse: past a couple of dozen names it
   is scroll rather than signal. distinctOwners still reports the true total. */
const HONORARY_COLLECTORS_LISTED = 25;

/* How the GOAT roster has actually landed: per card, who holds it and since
   when. Admin-only.

   Counts come from pack_collection_cards, not the pull log: the projection is
   the durable record and covers cards pulled before the log existed. The owner
   name is the live users row where there is one, falling back to the name the
   pull log froze, since an owner outside a tracked roster has no users row.

   Only GOAT-keyed rows count. Several roster members are live ranked players
   whose ordinary card is a separate collectible, and a World Class bojii is
   not a GOAT holding. */
export async function getHonoraryPullsReport(
  db: Db,
  cardUserIds: Iterable<number>,
  ownersPerCard = 100,
): Promise<HonoraryPullsReport> {
  const ids = [...new Set([...cardUserIds].map((id) => Math.floor(Number(id) || 0)).filter((id) => id > 0))];
  const capturedAt = Date.now();
  const empty: HonoraryPullsReport = {
    rosterSize: ids.length,
    pulledCards: 0,
    distinctOwners: 0,
    totalCopies: 0,
    cards: [],
    collectors: [],
    collectorsListed: HONORARY_COLLECTORS_LISTED,
    latest: null,
    ownersPerCard,
    capturedAt,
  };
  if (ids.length === 0) return empty;

  const placeholders = ids.map(() => "?").join(", ");
  const args = ids as InValue[];
  const rows = (await exec(
    db,
    `select card_user_id, owner_user_id, copies, first_pulled_at, last_pulled_at, username as card_username,
       coalesce(
         (select u.username from users u where u.user_id = c.owner_user_id),
         (select e.owner_username from pack_pull_events e
           where e.owner_user_id = c.owner_user_id order by e.pulled_at desc limit 1)
       ) as owner_username
     from pack_collection_cards c
     where card_user_id in (${placeholders}) and copies > 0 and tier = 'goat'
     order by card_user_id, first_pulled_at, owner_user_id`,
    args,
  )).rows;

  const byCard = new Map<number, HonoraryCardPulls>();
  // Every row is here, so both of these are exact: only the per-card `owners`
  // array is ever truncated.
  const byCollector = new Map<number, HonoraryCollector>();
  let latest: HonoraryLatestPull | null = null;
  const owners = new Set<number>();
  let totalCopies = 0;

  for (const row of rows) {
    const cardUserId = Number(row.card_user_id);
    const ownerUserId = Number(row.owner_user_id);
    const copies = Number(row.copies) || 0;
    const firstPulledAt = Number(row.first_pulled_at) || 0;
    const lastPulledAt = Number(row.last_pulled_at) || 0;
    let card = byCard.get(cardUserId);
    if (!card) {
      card = {
        cardUserId,
        cardUsername: nonEmptyString(row.card_username),
        owners: [],
        ownerCount: 0,
        copies: 0,
        firstPulledAt: null,
        lastPulledAt: null,
      };
      byCard.set(cardUserId, card);
    }
    card.ownerCount += 1;
    card.copies += copies;
    if (firstPulledAt > 0 && (card.firstPulledAt === null || firstPulledAt < card.firstPulledAt)) {
      card.firstPulledAt = firstPulledAt;
    }
    if (lastPulledAt > (card.lastPulledAt ?? 0)) card.lastPulledAt = lastPulledAt;
    // Rows arrive oldest-first per card, so a truncated list keeps the earliest
    // owners: who got there first is the part worth seeing.
    if (card.owners.length < ownersPerCard) {
      card.owners.push({
        userId: ownerUserId,
        username: nonEmptyString(row.owner_username) ?? `user ${ownerUserId}`,
        copies,
        firstPulledAt,
        lastPulledAt,
      });
    }
    const ownerUsername = nonEmptyString(row.owner_username) ?? `user ${ownerUserId}`;
    const collector = byCollector.get(ownerUserId);
    if (collector) {
      collector.cards += 1;
      collector.copies += copies;
      collector.lastPulledAt = Math.max(collector.lastPulledAt, lastPulledAt);
    } else {
      byCollector.set(ownerUserId, { userId: ownerUserId, username: ownerUsername, cards: 1, copies, lastPulledAt });
    }
    if (lastPulledAt > 0 && lastPulledAt > (latest?.pulledAt ?? 0)) {
      latest = {
        ownerUserId,
        ownerUsername,
        cardUserId,
        cardUsername: nonEmptyString(row.card_username),
        pulledAt: lastPulledAt,
      };
    }

    owners.add(ownerUserId);
    totalCopies += copies;
  }

  return {
    rosterSize: ids.length,
    pulledCards: byCard.size,
    distinctOwners: owners.size,
    totalCopies,
    cards: [...byCard.values()].sort((a, b) => b.ownerCount - a.ownerCount || a.cardUserId - b.cardUserId),
    collectors: [...byCollector.values()]
      .sort((a, b) => b.cards - a.cards || b.copies - a.copies || b.lastPulledAt - a.lastPulledAt)
      .slice(0, HONORARY_COLLECTORS_LISTED),
    collectorsListed: HONORARY_COLLECTORS_LISTED,
    latest,
    ownersPerCard,
    capturedAt,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
