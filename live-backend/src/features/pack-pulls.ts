import type { InValue } from "@libsql/client";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch } from "../db.js";
import { HONORARY_USER_IDS, packCardKey, tierRank, tierRankSql } from "./pack-wallets.js";

// Append-only log of pack pulls, the community layer on top of the per-owner
// pack_collection_cards projection. What was pulled is self-reported by the
// client (the draw and mint both happen browser-side), so everything derived
// here is social flavor, never economy: the feed, "owned by N collectors"
// counts and "your card got pulled" stats. The wallet itself stays untouched.
//
// Who it was pulled *of* is not taken on trust, because it is published: a
// card's player must be one this backend already knows (or an honorary), and
// the name and country on the row are read from the users table rather than
// from the browser. See resolvePullCardIdentities.

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

/* What a logged pull minted: the serial this owner now holds the card at, and
   how many serials that card has ever handed out. Returned so a just-opened
   pack can print "#7 of 132" without a second round trip. */
export interface PackPullMint {
  userId: number;
  cardKey: string;
  serial: number;
  mintedTotal: number;
  isFirstGlobal: boolean;
}

export interface PackPulledStats {
  userId: number;
  owners: number;
  copies: number;
  pullEvents7d: number;
  lastPulledAt: number | null;
}

function normalizePackType(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_]{1,24}$/.test(value) ? value : null;
}

function normalizePullCard(value: unknown): PackPullCardInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const userId = Math.floor(Number(raw.userId) || 0);
  if (userId <= 0 || typeof raw.username !== "string" || raw.username.length === 0) return null;
  // GOAT is the honorary roster's tier and nothing else. The wallet path has
  // always checked this (claimedTier in pack-wallets); the log did not, so a
  // hand-written pull could put "pulled GOAT <anyone>" on the public feed, the
  // live SSE stream and the share page's goatPull banner.
  const claimed = typeof raw.tier === "string" && VALID_TIERS.has(raw.tier) ? raw.tier : null;
  const tier = claimed === "goat" && !HONORARY_USER_IDS.has(userId) ? null : claimed;
  return {
    userId,
    username: raw.username.slice(0, 40),
    countryCode: typeof raw.countryCode === "string" ? raw.countryCode.slice(0, 2).toUpperCase() : "",
    tier,
    isNew: raw.isNew === true,
  };
}

/* The pulled players the backend can actually vouch for, with their real names.

   A pull row is client-authored, and its card_username / card_country_code are
   rendered straight onto the public feed, the /pull/... permalink and that
   page's OG image - on this site's own domain. Taking those strings on trust
   meant a fabricated player (any unused id, any name) could be published as if
   it had been drawn. Every honestly drawn card comes off the pool board, which
   is built from this table, so requiring a users row costs a real pull nothing
   and is the cheapest available proof that the player exists.

   Honorary ids are allowlisted alongside: that roster is 23 hardcoded entries
   of mostly retired accounts, some of which the ingest has no reason to hold,
   and being on the list is itself the proof. */
async function resolvePullCardIdentities(
  db: Db,
  userIds: number[],
): Promise<Map<number, { username: string; countryCode: string }>> {
  const resolved = new Map<number, { username: string; countryCode: string }>();
  if (userIds.length === 0) return resolved;
  const rows = (await exec(
    db,
    `select user_id, username, country_code from users where user_id in (${userIds.map(() => "?").join(", ")})`,
    userIds as InValue[],
  )).rows;
  for (const row of rows) {
    resolved.set(Number(row.user_id), {
      username: String(row.username ?? "").slice(0, 40),
      countryCode: String(row.country_code ?? "").slice(0, 2).toUpperCase(),
    });
  }
  return resolved;
}

/* Live identity overlay, same idea as pack-wallets: rows freeze the name at
   pull time, reads prefer the current users row so renames show up. */
function liveUserFieldSql(idColumn: string, field: "username" | "avatar_url"): string {
  return `(select u.${field} from users u where u.user_id = pack_pull_events.${idColumn})`;
}

/* Hands this owner their serial for a card, or leaves the one they already
   hold, as a statement so a pull can batch it with its event insert. The
   number is computed inside the insert rather than read first and written
   after, so two pulls landing together cannot claim the same serial, and the
   (card, owner) primary key makes a repeat pull a no-op: a duplicate never
   renumbers you, and neither does recycling and repulling. The registry keeps
   a row for every serial ever handed out, recycled ones included, which is
   what makes max(serial) the honest denominator for "#7 of 132". */
function packCardSerialInsertStatement(
  cardKey: string,
  cardUserId: number,
  ownerUserId: number,
  now: number,
): DbStatement {
  return {
    sql: `insert or ignore into pack_card_serials (card_key, card_user_id, owner_user_id, serial, minted_at)
     select ?, ?, ?, coalesce((select max(serial) from pack_card_serials where card_key = ?), 0) + 1, ?`,
    args: [cardKey, cardUserId, ownerUserId, cardKey, now],
  };
}

/* Seeds the mint registry from the collections that already exist.

   Serials were added long after people started collecting, and an empty
   registry makes every pull read as a first mint, which is worthless as a flex
   and wrong as a fact. pack_collection_cards is the durable record of who
   holds what and when they first pulled it, so mint order can be recovered
   exactly: per card, order the owners by first_pulled_at and hand out 1..N.
   Ties (two owners with the same stamp, or a zero stamp from an old row) fall
   back to owner id, which is arbitrary but stable across reruns.

   Safe to run on every boot: only owners with no serial yet are numbered, and
   they start after the card's highest serial so far, so a rerun can only ever
   append. On the first run against a registry that is still empty that is
   simply 1..N in historical order. Returns how many serials it wrote. */
export async function backfillPackCardSerials(db: Db, now = Date.now()): Promise<number> {
  const before = Number((await exec(db, "select count(*) as n from pack_card_serials")).rows[0]?.n) || 0;
  await exec(
    db,
    `insert or ignore into pack_card_serials (card_key, card_user_id, owner_user_id, serial, minted_at)
     select c.card_key, c.card_user_id, c.owner_user_id,
       coalesce((select max(s.serial) from pack_card_serials s where s.card_key = c.card_key), 0)
         + row_number() over (partition by c.card_key order by c.first_pulled_at asc, c.owner_user_id asc),
       case when c.first_pulled_at > 0 then c.first_pulled_at else ? end
     from pack_collection_cards c
     where c.copies > 0
       and not exists (
         select 1 from pack_card_serials mine
         where mine.card_key = c.card_key and mine.owner_user_id = c.owner_user_id
       )`,
    [now],
  );
  const after = Number((await exec(db, "select count(*) as n from pack_card_serials")).rows[0]?.n) || 0;
  return Math.max(0, after - before);
}

/* The serials one owner holds, keyed by card key, for a hand of cards. */
export async function getPackCardSerials(
  db: Db,
  ownerUserId: number,
  cardKeys: string[],
): Promise<Map<string, { serial: number; mintedTotal: number }>> {
  const keys = [...new Set(cardKeys)].slice(0, 500);
  const result = new Map<string, { serial: number; mintedTotal: number }>();
  if (keys.length === 0 || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return result;
  const placeholders = keys.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select mine.card_key as card_key, mine.serial as serial,
       (select max(other.serial) from pack_card_serials other where other.card_key = mine.card_key) as minted_total
     from pack_card_serials mine
     where mine.owner_user_id = ? and mine.card_key in (${placeholders})`,
    [ownerUserId, ...keys] as InValue[],
  )).rows;
  for (const row of rows) {
    result.set(String(row.card_key), {
      serial: Number(row.serial) || 0,
      mintedTotal: Number(row.minted_total) || 0,
    });
  }
  return result;
}

export async function recordPackPullEvents(
  db: Db,
  ownerUserId: number,
  ownerUsername: string,
  packType: unknown,
  cards: unknown,
  now = Date.now(),
): Promise<{ recorded: number; mints: PackPullMint[]; eventIds: number[] }> {
  const type = normalizePackType(packType);
  if (!type || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return { recorded: 0, mints: [], eventIds: [] };
  const claimed = (Array.isArray(cards) ? cards : [])
    .map(normalizePullCard)
    .filter((card): card is PackPullCardInput => Boolean(card))
    .slice(0, PACK_PULL_MAX_CARDS_PER_EVENT);
  if (claimed.length === 0) return { recorded: 0, mints: [], eventIds: [] };

  // Drop cards for players this backend has never heard of, and let the users
  // table - not the browser - name the ones it knows. What reaches the public
  // feed is then a real player under their current name, whatever the client
  // sent. Honoraries keep the client's string, since they are an allowlist and
  // may legitimately have no users row.
  const identities = await resolvePullCardIdentities(db, [...new Set(claimed.map((card) => card.userId))]);
  const normalized = claimed
    .map((card) => {
      const identity = identities.get(card.userId);
      if (identity) return { ...card, username: identity.username || card.username, countryCode: identity.countryCode || card.countryCode };
      return HONORARY_USER_IDS.has(card.userId) ? card : null;
    })
    .filter((card): card is PackPullCardInput => card !== null);
  if (normalized.length === 0) return { recorded: 0, mints: [], eventIds: [] };

  const hourAgo = now - 60 * 60 * 1000;
  const recent = (await exec(
    db,
    "select count(*) as n from pack_pull_events where owner_user_id = ? and pulled_at > ?",
    [ownerUserId, hourAgo],
  )).rows[0];
  if ((Number(recent?.n) || 0) + normalized.length > PACK_PULL_OWNER_HOURLY_CAP) {
    return { recorded: 0, mints: [], eventIds: [] };
  }

  // First-global means nobody, anywhere, holds or ever pulled this card: no
  // prior event and no other owner's collection row (the caller's own row may
  // already exist when the wallet sync raced this call). Both facts are read
  // set-based here so every write below can travel in one batch; `seenInPull`
  // stands in for the read-after-write the old per-card loop got for free, so
  // the same card twice in one pack is still only first-global once. Two
  // owners racing over a brand-new card can still both read "first" — the
  // reads sat outside any transaction before the batch too, and the flag is
  // social flavor, never economy.
  const cardUserIds = [...new Set(normalized.map((card) => card.userId))];
  const withPriorEvents = new Set(
    (await exec(
      db,
      `select distinct card_user_id from pack_pull_events
       where card_user_id in (${cardUserIds.map(() => "?").join(", ")})`,
      cardUserIds as InValue[],
    )).rows.map((row) => Number(row.card_user_id)),
  );
  const unproven = cardUserIds.filter((id) => !withPriorEvents.has(id));
  const withOtherOwners = new Set(
    unproven.length === 0
      ? []
      : (await exec(
          db,
          `select distinct card_user_id from pack_collection_cards
           where card_user_id in (${unproven.map(() => "?").join(", ")}) and owner_user_id != ?`,
          [...unproven, ownerUserId] as InValue[],
        )).rows.map((row) => Number(row.card_user_id)),
  );

  // Every insert goes down in one execBatch: a pull costs one write-lock
  // acquisition instead of two per card (each separate statement is a separate
  // chance to eat the busy budget when another writer holds the lock), and a
  // pull is logged wholly or not at all.
  const statements: DbStatement[] = [];
  const pending: { card: PackPullCardInput; cardKey: string; isFirstGlobal: boolean; eventIndex: number }[] = [];
  const seenInPull = new Set<number>();
  for (const card of normalized) {
    const isFirstGlobal =
      !withPriorEvents.has(card.userId) && !withOtherOwners.has(card.userId) && !seenInPull.has(card.userId);
    seenInPull.add(card.userId);
    const notable = isFirstGlobal || (card.tier !== null && NOTABLE_TIERS.has(card.tier));
    const cardKey = packCardKey(card.userId, card.tier);
    pending.push({ card, cardKey, isFirstGlobal, eventIndex: statements.length });
    statements.push({
      sql: `insert into pack_pull_events (
         owner_user_id, owner_username, card_user_id, card_username, card_country_code,
         tier, pack_type, is_new, is_first_global, notable, pulled_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
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
    });
    // Serials are only handed out here, so they exist for signed-in collectors
    // (the only ones whose pulls are logged). An anonymous wallet's cards are
    // unserialled until that browser logs in and pulls them again.
    statements.push(packCardSerialInsertStatement(cardKey, card.userId, ownerUserId, now));
  }
  const results = await execBatch(db, statements);

  const eventIds: number[] = [];
  for (const entry of pending) {
    const insertedId = Number(results[entry.eventIndex]?.lastInsertRowid ?? 0);
    if (insertedId > 0) eventIds.push(insertedId);
  }
  const serials = await getPackCardSerials(db, ownerUserId, pending.map((entry) => entry.cardKey));
  const mints = pending.map((entry) => ({
    userId: entry.card.userId,
    cardKey: entry.cardKey,
    isFirstGlobal: entry.isFirstGlobal,
    ...(serials.get(entry.cardKey) ?? { serial: 0, mintedTotal: 0 }),
  }));
  return { recorded: pending.length, mints, eventIds };
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

/* One collector holding a given player's card. Copies are summed across the
   card keys they hold it under (an ordinary card and a GOAT are separate
   collectibles of the same player), and the tier and serial are the ones from
   the best of those keys, since that is the holding worth naming. */
export interface PackCardCollector {
  userId: number;
  username: string;
  copies: number;
  tier: string | null;
  /* Mint order under the tier above. Null for a holding that predates the
     serial registry and was never backfilled, or an anonymous pull. */
  serial: number | null;
  firstPulledAt: number;
  lastPulledAt: number;
}

export interface PackCardCollectors {
  userId: number;
  /* True totals across every holder, even when the list below is truncated. */
  owners: number;
  copies: number;
  collectors: PackCardCollector[];
  /* The cap applied to the list, so the client can say "first N of M". */
  listed: number;
}

/* High enough that a real card's whole holder list fits (the site's entire
   collector population is a few hundred people), because the client filters
   the list by name and a truncated one would answer "who has my card" with a
   silent no. The counts above the list stay exact either way. */
export const PACK_CARD_COLLECTORS_LISTED = 500;
/* Rows read before grouping. A collector holds at most one row per card key,
   so this covers the listed cap with room for everyone holding both an
   ordinary card and a GOAT. */
const COLLECTOR_ROW_SCAN = PACK_CARD_COLLECTORS_LISTED * 3;

/* "Who has my card": the collectors behind the owners count, oldest holding
   first, so the list reads as mint order and a truncated one keeps the people
   who got there first.

   Same source as the counts (pack_collection_cards, the durable projection),
   so it covers cards pulled before the pull log existed. The name is the live
   users row where there is one, falling back to the name the pull log froze,
   since a collector outside a tracked roster has no users row. */
export async function getPackCardCollectors(
  db: Db,
  cardUserId: number,
  listed = PACK_CARD_COLLECTORS_LISTED,
): Promise<PackCardCollectors> {
  const limit = Math.min(PACK_CARD_COLLECTORS_LISTED, Math.max(1, Math.floor(listed) || 1));
  const empty: PackCardCollectors = { userId: cardUserId, owners: 0, copies: 0, collectors: [], listed: limit };
  if (!Number.isInteger(cardUserId) || cardUserId <= 0) return empty;
  const totals = (await exec(
    db,
    `select count(distinct owner_user_id) as owners, coalesce(sum(copies), 0) as copies
     from pack_collection_cards
     where card_user_id = ? and copies > 0`,
    [cardUserId],
  )).rows[0];
  const owners = Number(totals?.owners) || 0;
  if (owners === 0) return empty;

  const rows = (await exec(
    db,
    `select c.owner_user_id as owner_user_id, c.copies as copies, c.tier as tier,
       c.first_pulled_at as first_pulled_at, c.last_pulled_at as last_pulled_at,
       (select s.serial from pack_card_serials s
         where s.card_key = c.card_key and s.owner_user_id = c.owner_user_id) as serial,
       coalesce(
         (select u.username from users u where u.user_id = c.owner_user_id),
         (select e.owner_username from pack_pull_events e
           where e.owner_user_id = c.owner_user_id order by e.pulled_at desc limit 1)
       ) as owner_username
     from pack_collection_cards c
     where c.card_user_id = ? and c.copies > 0
     order by c.first_pulled_at asc, c.owner_user_id asc
     limit ?`,
    [cardUserId, COLLECTOR_ROW_SCAN],
  )).rows;

  const byOwner = new Map<number, PackCardCollector>();
  for (const row of rows) {
    const ownerUserId = Number(row.owner_user_id);
    const tier = typeof row.tier === "string" ? row.tier : null;
    const serial = Number(row.serial) || 0;
    const copies = Number(row.copies) || 0;
    const firstPulledAt = Number(row.first_pulled_at) || 0;
    const lastPulledAt = Number(row.last_pulled_at) || 0;
    const existing = byOwner.get(ownerUserId);
    if (!existing) {
      if (byOwner.size >= limit) continue;
      byOwner.set(ownerUserId, {
        userId: ownerUserId,
        username: nonEmptyString(row.owner_username) ?? `user ${ownerUserId}`,
        copies,
        tier,
        serial: serial > 0 ? serial : null,
        firstPulledAt,
        lastPulledAt,
      });
      continue;
    }
    existing.copies += copies;
    if (firstPulledAt > 0 && (existing.firstPulledAt === 0 || firstPulledAt < existing.firstPulledAt)) {
      existing.firstPulledAt = firstPulledAt;
    }
    if (lastPulledAt > existing.lastPulledAt) existing.lastPulledAt = lastPulledAt;
    if (tierRank(tier) > tierRank(existing.tier)) {
      existing.tier = tier;
      existing.serial = serial > 0 ? serial : null;
    }
  }

  return {
    userId: cardUserId,
    owners,
    copies: Number(totals?.copies) || 0,
    collectors: [...byOwner.values()],
    listed: limit,
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
  /* Where this owner sits in the card's mint order (#1 pulled it first,
     anywhere). Null for a card whose owner never had a pull logged, which is
     every pull from before the registry existed. */
  serial: number | null;
  /* Serials this card has ever handed out, recycled ones included. */
  mintedTotal: number;
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
  // latest: a later duplicate says nothing the first one didn't. The honorary
  // check is repeated here rather than left to the write path, so rows logged
  // before that path enforced it cannot still raise the banner.
  const goatRow = HONORARY_USER_IDS.has(cardUserId)
    ? (await exec(
        db,
        `select pack_type, pulled_at from pack_pull_events
         where owner_user_id = ? and card_user_id = ? and tier = 'goat'
         order by pulled_at asc limit 1`,
        [ownerUserId, cardUserId],
      )).rows[0]
    : undefined;
  // The permalink resolved a player to whichever card key the owner holds at
  // the higher tier, so the serial has to be looked up under that same key.
  const cardKey = typeof row.card_key === "string" && row.card_key
    ? row.card_key
    : packCardKey(cardUserId, typeof row.tier === "string" ? row.tier : null);
  const mintRow = (await exec(
    db,
    `select
       (select serial from pack_card_serials where card_key = ? and owner_user_id = ?) as serial,
       (select max(serial) from pack_card_serials where card_key = ?) as minted_total`,
    [cardKey, ownerUserId, cardKey],
  )).rows[0];
  const serial = Number(mintRow?.serial) || 0;
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
    serial: serial > 0 ? serial : null,
    mintedTotal: Number(mintRow?.minted_total) || 0,
    goatPull: goatRow
      ? { packType: String(goatRow.pack_type ?? ""), pulledAt: Number(goatRow.pulled_at) || 0 }
      : null,
  };
}

const FEED_ENTRY_SELECT_SQL = `select id, owner_user_id, owner_username, card_user_id, card_username, card_country_code,
    tier, pack_type, is_new, is_first_global, pulled_at,
    ${liveUserFieldSql("owner_user_id", "username")} as live_owner_username,
    ${liveUserFieldSql("card_user_id", "username")} as live_card_username,
    ${liveUserFieldSql("card_user_id", "avatar_url")} as card_avatar_url
  from pack_pull_events`;

function rowToFeedEntry(row: Record<string, unknown>): PackPullFeedEntry {
  return {
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
    `${FEED_ENTRY_SELECT_SQL}
     ${notableOnly ? "where notable = 1" : ""}
     order by pulled_at desc, id desc
     limit ?`,
    [cappedLimit],
  )).rows;
  return rows.map(rowToFeedEntry);
}

/* Just-recorded rows as feed entries (live identity overlay applied), for
   publishing onto the live event stream right after recordPackPullEvents.
   Ascending id, so a batch is emitted oldest-first, the order the rail's
   drip queue expects. */
export async function listPackPullsByIds(db: Db, ids: number[]): Promise<PackPullFeedEntry[]> {
  const valid = [...new Set(ids.map((id) => Math.floor(Number(id) || 0)).filter((id) => id > 0))]
    .slice(0, PACK_PULL_MAX_CARDS_PER_EVENT);
  if (valid.length === 0) return [];
  const placeholders = valid.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `${FEED_ENTRY_SELECT_SQL} where id in (${placeholders}) order by id asc`,
    valid as InValue[],
  )).rows;
  return rows.map(rowToFeedEntry);
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
