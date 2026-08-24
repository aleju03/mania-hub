import type { InValue } from "@libsql/client";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch } from "../db.js";
import { parseCardMotif, serializeCardMotif } from "./card-motif.js";
import {
  getOrCreatePackWallet,
  getPackCollectionCard,
  internPackCardSkills,
  isCustomizedPackCard,
  isKnownTier,
  isPackCardVariantKey,
  listPackCollectionCards,
  movePackCardKeyReferencesStatements,
  normalizeAvatarUrl,
  normalizeCountryCode,
  normalizePackCardKey,
  packCardKey,
  packCardKeyUserId,
  packCardTierSlot,
  resolvePackCardVariantKey,
  packWalletEconomy,
  settlePackWalletCharges,
  setPackWalletEconomy,
  type PackCollectionPage,
  type PackWalletEconomy,
  type PackWalletEconomyPatch,
  type StoredPackCard,
  PACK_CARD_AVATAR_URL_MAX_CHARS,
  PACK_CARD_MAX_COPIES,
  PACK_CARD_MAX_PP,
  PACK_CARD_TIER_LABEL_MAX_CHARS,
  PACK_CARD_USERNAME_MAX_CHARS,
} from "./pack-wallets.js";
import { mintPackCardSerialStatement } from "./pack-serials.js";

/* The owner's grant desk behind /admin/collections: hand anyone shards, or
   mint them a card with every field on it chosen by hand.
 *
 * Everything the ordinary economy refuses is allowed here on purpose. The
 * client-facing paths are built so a browser cannot claim a card into
 * existence (only pack-draw's mintDealtPackCards adds copies, and the mint
 * pass may only ever describe a row it did not create), the GOAT tier is
 * gated on a fixed roster because it recycles for 500 shards, and identity is
 * first-write-wins so one forged sync cannot repaint a card a thousand people
 * hold. None of those rules are about the owner: they exist because the other
 * side of the wire is a stranger. This module is the one caller that is not,
 * so it writes the row it is told to write and the UI carries the warnings
 * instead - the GOAT roster and the shared card face are both called out
 * where they are chosen.
 *
 * Two things it deliberately does NOT do. It writes no pack_pull_events: the
 * pull log is the community feed, and a granted card announcing itself as a
 * pull would be a lie told to everybody else. And it pays no arcade ledger
 * row (pack_game_rewards), so a grant never eats into anyone's daily cap. */

export interface AdminPackUser {
  userId: number;
  username: string | null;
  countryCode: string | null;
  tracked: boolean;
}

/* Resolves the recipient (or the card's face) from whatever the form had:
   an osu! id, or a username off the users projection. An id the backend has
   never ingested still resolves - untracked players can hold cards, and half
   the honorary roster is deleted accounts - it just comes back with a null
   username and tracked false, which the page says out loud. A username that
   matches nothing cannot resolve, since a name is only an id if something
   stored the pair. */
export async function resolveAdminPackUser(
  db: Db,
  spec: { userId?: unknown; username?: unknown },
): Promise<AdminPackUser | null> {
  const userId = Math.floor(Number(spec.userId));
  const username = typeof spec.username === "string" ? spec.username.trim() : "";

  if (Number.isInteger(userId) && userId > 0) {
    const row = (await exec(
      db,
      "select user_id, username, country_code from users where user_id = ? limit 1",
      [userId],
    )).rows[0];
    return {
      userId,
      username: row ? String(row.username ?? "") || null : null,
      countryCode: row ? normalizeCountryCode(String(row.country_code ?? "")) || null : null,
      tracked: Boolean(row),
    };
  }
  if (!username) return null;
  const row = (await exec(
    db,
    "select user_id, username, country_code from users where lower(username) = lower(?) limit 1",
    [username],
  )).rows[0];
  if (!row) return null;
  return {
    userId: Number(row.user_id),
    username: String(row.username ?? "") || null,
    countryCode: normalizeCountryCode(String(row.country_code ?? "")) || null,
    tracked: true,
  };
}

export interface AdminPackCollectionOverview {
  user: AdminPackUser;
  /* Charges shown as they stand right now rather than as last written, so the
     page agrees with what /packs would deal. */
  economy: PackWalletEconomy;
  walletRev: number;
  walletUpdatedAt: number | null;
  hasWallet: boolean;
  distinctCards: number;
  totalCopies: number;
  collection: PackCollectionPage;
}

export async function getAdminPackCollectionOverview(
  db: Db,
  user: AdminPackUser,
  options: { page?: number; pageSize?: number; tier?: string | null; query?: string | null; sort?: "newest" | null } = {},
  now = Date.now(),
): Promise<AdminPackCollectionOverview> {
  const walletRow = (await exec(
    db,
    "select payload, rev, updated_at from pack_wallets where user_id = ?",
    [user.userId],
  )).rows[0];
  const totals = (await exec(
    db,
    "select count(*) as cards, coalesce(sum(copies), 0) as copies from pack_collection_cards where owner_user_id = ? and copies > 0",
    [user.userId],
  )).rows[0];
  const collection = await listPackCollectionCards(db, user.userId, {
    page: Math.max(0, Math.floor(options.page ?? 0)),
    pageSize: Math.max(1, Math.floor(options.pageSize ?? 30)),
    tier: options.tier ?? null,
    query: options.query ?? null,
    sort: options.sort ?? null,
  });
  return {
    user,
    economy: settlePackWalletCharges(packWalletEconomy(walletRow ? String(walletRow.payload) : null, now), now),
    walletRev: walletRow ? Number(walletRow.rev) : 0,
    walletUpdatedAt: walletRow ? Number(walletRow.updated_at) : null,
    hasWallet: Boolean(walletRow),
    distinctCards: Number(totals?.cards) || 0,
    totalCopies: Number(totals?.copies) || 0,
    collection,
  };
}

export async function setAdminPackWalletEconomy(
  db: Db,
  user: AdminPackUser,
  patch: PackWalletEconomyPatch,
  now = Date.now(),
): Promise<PackWalletEconomy> {
  const wallet = await setPackWalletEconomy(db, user.userId, patch, now);
  await stampWalletOwnerUsername(db, user, now);
  return settlePackWalletCharges(packWalletEconomy(wallet.payload, now), now);
}

/* Every field of one holding, as the grant form hands it over. Anything left
   undefined keeps whatever the row already had (or takes a sane default on a
   row that is being created). */
export interface AdminPackCardGrant {
  cardUserId: number;
  /* The holding this grant edits, when the desk listed it. Absent grants
     against the player: an ordinary card writes their ordinary key, and
     anything customized mints or reuses a variant key of its own. */
  cardKey?: string;
  /* One of the eleven stored tiers, or null for an unrated card. Unlike the
     sync path, "goat" is accepted for any player (the roster guard exists to
     stop a stranger minting a 500-shard card, and this caller is the person
     who owns the roster) and so is "eternal", which no other writer may set at
     all: this desk is the only way onto a card and the only way back off. */
  tier: string | null;
  tierLabel?: string | null;
  copies?: number;
  copiesMode?: "add" | "set";
  recycledCopies?: number;
  pp?: number;
  globalRank?: number;
  /* The mint's skills snapshot, the numbers the card front draws. Passing null
     with clearSkills leaves the card unrated-looking (a stat-less front); not
     passing it at all keeps whatever snapshot the row already froze. */
  skills?: Record<string, unknown> | null;
  clearSkills?: boolean;
  firstPulledAt?: number;
  lastPulledAt?: number;
  /* "keep" preserves an existing number (and auto-mints one for a positive
     holding missing it), "mint" explicitly asks for the next serial, and
     "set" writes an exact one. */
  serialMode?: "keep" | "mint" | "set";
  serial?: number;
  /* The card's face. Only consulted for a variant the catalog has never seen,
     unless overwriteIdentity is set - the face is shared by every collector of
     that variant, so repainting it repaints theirs too. A player with a users
     row takes their identity from it either way. */
  username?: string;
  avatarUrl?: string;
  countryCode?: string;
  /* The image this holding's card floats in place of its tier's triangle
     flecks or starfield. Absent leaves whatever the row had, null clears it,
     an object sets it - the same three states the label takes, and for the
     same reason: editing one field of a card must not wipe another. */
  motif?: unknown;
  overwriteIdentity?: boolean;
}

export interface AdminPackCardGrantResult {
  cardKey: string;
  created: boolean;
  card: StoredPackCard | null;
}

export type AdminPackCardGrantOutcome =
  | { ok: true; result: AdminPackCardGrantResult }
  | { ok: false; error: "bad_card_user" | "bad_tier" | "bad_skills" | "bad_card_key" };

/* A skills snapshot is a handful of named numbers; the sync path caps the same
   blob at 2000 chars and so does this one, because both end up on a public
   share card. */
const PACK_CARD_SKILLS_MAX_CHARS = 2_000;
const PACK_CARD_MAX_SERIAL = 10_000_000;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* The row a grant is about to write over, or nothing when it is minting one. */
async function readGrantHolding(db: Db, ownerUserId: number, cardKey: string) {
  return (await exec(
    db,
    `select tier, tier_label, motif, skills_id, pp, global_rank, copies, recycled_copies,
       first_pulled_at, last_pulled_at, granted_at
     from pack_collection_cards where owner_user_id = ? and card_key = ?`,
    [ownerUserId, cardKey],
  )).rows[0];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const next = Math.floor(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

export async function grantAdminPackCard(
  db: Db,
  owner: AdminPackUser,
  grant: AdminPackCardGrant,
  now = Date.now(),
): Promise<AdminPackCardGrantOutcome> {
  const cardUserId = Math.floor(Number(grant.cardUserId));
  if (!Number.isInteger(cardUserId) || cardUserId <= 0) return { ok: false, error: "bad_card_user" };
  if (grant.tier !== null && !isKnownTier(grant.tier)) return { ok: false, error: "bad_tier" };
  const tier = grant.tier;
  const tierSlot = packCardTierSlot(tier);
  /* The holding to write, when the desk is editing one it already listed
     rather than granting against a player. Without it a grant that customizes
     anything mints a card instead of editing one, so this is what makes a typo
     in a badge fixable. */
  const requestedKey = grant.cardKey === undefined ? null : normalizePackCardKey(grant.cardKey);
  if (grant.cardKey !== undefined && (requestedKey === null || packCardKeyUserId(requestedKey) !== cardUserId)) {
    return { ok: false, error: "bad_card_key" };
  }

  let skillsJson: string | null = null;
  if (grant.skills != null) {
    if (typeof grant.skills !== "object" || Array.isArray(grant.skills)) return { ok: false, error: "bad_skills" };
    skillsJson = JSON.stringify(grant.skills);
    if (skillsJson.length > PACK_CARD_SKILLS_MAX_CHARS) return { ok: false, error: "bad_skills" };
  }

  const initialKey = requestedKey ?? packCardKey(cardUserId, tier);
  const initialHolding = await readGrantHolding(db, owner.userId, initialKey);
  const tierLabel =
    grant.tierLabel === undefined
      ? undefined
      : typeof grant.tierLabel === "string" && grant.tierLabel.trim().length > 0
        ? grant.tierLabel.trim().slice(0, PACK_CARD_TIER_LABEL_MAX_CHARS)
        : null;
  /* A typed label belongs to this collector, not to the card: naming one
     person's GOAT card "manolo" must not rename it on every other GOAT
     holder's shelf. It lands on the ownership row, which reads prefer over the
     catalog's, and which is the field the card art itself prints.

     Callers only ever send a label somebody actually typed - the tier's own
     name is applied at render time, not stored - so there is nothing to
     second-guess here: a label means an override, an empty one clears it, and
     an absent one leaves whatever the holding had. The exception is a repaint,
     which was asked for outright and so goes to the shared row instead. */
  /* Unlike the label, a motif is never inherited from anywhere else: there is
     no catalog-wide fallback, so "keep" means literally the text already in
     the row, re-parsed so a value stored under older bounds cannot survive an
     edit that touches the card. */
  const motif =
    grant.motif === undefined
      ? serializeCardMotif(parseCardMotif(initialHolding?.motif))
      : serializeCardMotif(parseCardMotif(grant.motif));
  const heldLabel = nonEmptyString(initialHolding?.tier_label);
  const ownerTierLabel =
    tierLabel === undefined
      ? heldLabel
      : tierLabel !== null && !grant.overwriteIdentity
        ? tierLabel
        : null;

  /* What the desk is handing over, as the card it makes: its own tier, its own
     badge, its own art. Anything customized is a collectible of its own rather
     than a copy of the player's ordinary card, so it lands on a variant key -
     the one an identical grant already minted, wherever it is held, or a fresh
     number. Granting the same card to a second collector therefore puts them
     both in the one collectible, and changing any of the three makes another.

     An edit of an existing variant keeps that variant's identity: fixing its
     badge must not mint a sibling. An edit of a derived ordinary/GOAT holding
     is different: once it gains a custom badge, motif or grant-only tier it
     no longer is that shared card, so the holding and its references move to
     the resolved variant in this same transaction. */
  const customization = { tier, tierLabel: ownerTierLabel, motif };
  let cardKey = initialKey;
  if (isCustomizedPackCard(customization) && (requestedKey === null || !isPackCardVariantKey(initialKey))) {
    cardKey = await resolvePackCardVariantKey(db, cardUserId, customization);
  }
  const targetHolding = cardKey === initialKey
    ? initialHolding
    : await readGrantHolding(db, owner.userId, cardKey);
  const moveFromKey = requestedKey !== null && Boolean(initialHolding) && cardKey !== initialKey ? initialKey : null;
  const existing = moveFromKey ? initialHolding : targetHolding;
  const created = !existing;

  const heldCopies = Number(existing?.copies) || 0;
  const copiesInput = grant.copies == null ? (created ? 1 : 0) : clampInt(grant.copies, -PACK_CARD_MAX_COPIES, PACK_CARD_MAX_COPIES, 0);
  const copies =
    grant.copiesMode === "set"
      ? clampInt(copiesInput, 0, PACK_CARD_MAX_COPIES, heldCopies)
      : clampInt(heldCopies + copiesInput, 0, PACK_CARD_MAX_COPIES, heldCopies);
  const recycledCopies =
    grant.recycledCopies == null
      ? Number(existing?.recycled_copies) || 0
      : clampInt(grant.recycledCopies, 0, PACK_CARD_MAX_COPIES, 0);
  const pp = grant.pp == null ? Number(existing?.pp) || 0 : Math.min(PACK_CARD_MAX_PP, Math.max(0, Number(grant.pp) || 0));
  const globalRank =
    grant.globalRank == null ? Number(existing?.global_rank) || 0 : clampInt(grant.globalRank, 0, Number.MAX_SAFE_INTEGER, 0);
  // A pull cannot have happened in the future: sorting and the "newest" view
  // both read these, and one future stamp pins a card to the top forever.
  const clampStamp = (value: unknown, fallback: number) => clampInt(value, 0, now, fallback);
  const firstPulledAt = clampStamp(grant.firstPulledAt, Number(existing?.first_pulled_at) || now);
  const lastPulledAt = clampStamp(grant.lastPulledAt, Number(existing?.last_pulled_at) || now);

  let skillsId: number | null = existing ? (existing.skills_id == null ? null : Number(existing.skills_id)) : null;
  if (skillsJson !== null) skillsId = (await internPackCardSkills(db, [skillsJson])).get(skillsJson) ?? null;
  else if (grant.clearSkills) skillsId = null;

  /* A move can converge onto a variant this collector already holds. Merge
     the two holdings rather than dropping either one's copies. The explicit
     form values describe the edited source; an empty source face falls back
     to the destination's already-frozen one in the conflict clause below. */
  const movingHolding = moveFromKey !== null;
  const retiresCompletionReward =
    (tier === "eternal" && copies > 0) ||
    (existing?.tier === "eternal" && heldCopies > 0);
  const ownershipConflictSql = movingHolding
    ? `card_user_id = excluded.card_user_id,
       tier = excluded.tier,
       tier_label = excluded.tier_label,
       motif = excluded.motif,
       skills_id = coalesce(excluded.skills_id, pack_collection_cards.skills_id),
       pp = case when excluded.pp > 0 then excluded.pp else pack_collection_cards.pp end,
       global_rank = case when excluded.global_rank > 0 then excluded.global_rank else pack_collection_cards.global_rank end,
       copies = min(${PACK_CARD_MAX_COPIES}, pack_collection_cards.copies + excluded.copies),
       recycled_copies = min(${PACK_CARD_MAX_COPIES}, pack_collection_cards.recycled_copies + excluded.recycled_copies),
       first_pulled_at = min(pack_collection_cards.first_pulled_at, excluded.first_pulled_at),
       last_pulled_at = max(pack_collection_cards.last_pulled_at, excluded.last_pulled_at),
       updated_at = excluded.updated_at,
       completion_eligible = 1,
       granted_at = coalesce(pack_collection_cards.granted_at, excluded.granted_at)`
    : `card_user_id = excluded.card_user_id,
       tier = excluded.tier,
       tier_label = excluded.tier_label,
       motif = excluded.motif,
       skills_id = excluded.skills_id,
       pp = excluded.pp,
       global_rank = excluded.global_rank,
       copies = excluded.copies,
       recycled_copies = excluded.recycled_copies,
       first_pulled_at = excluded.first_pulled_at,
       last_pulled_at = excluded.last_pulled_at,
       updated_at = excluded.updated_at,
       completion_eligible = 1,
       /* Only ever set, never cleared: editing a card the desk granted leaves
          it granted, and editing one somebody pulled leaves the column null
          rather than claiming it was handed to them. */
       granted_at = coalesce(pack_collection_cards.granted_at, excluded.granted_at)`;

  const statements: DbStatement[] = [
    ...(await cardIdentityStatements(db, {
      cardKey,
      tierSlot,
      cardUserId,
      username: grant.username,
      avatarUrl: grant.avatarUrl,
      countryCode: grant.countryCode,
      tierLabel,
      overwrite: grant.overwriteIdentity === true,
      now,
    })),
    {
      /* Written flat rather than through packOwnershipUpsertStatement: that
         one only ever upgrades a tier and only fills an empty snapshot, which
         is right for a mint arriving from a browser and wrong for a form whose
         entire job is to say what the row should read. */
      sql: `insert into pack_collection_cards (
         owner_user_id, card_user_id, card_key, tier, tier_label, motif, skills_id, pp, global_rank,
         copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at, granted_at, completion_eligible
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       on conflict(owner_user_id, card_key) do update set
         ${ownershipConflictSql}`,
      args: [
        owner.userId,
        cardUserId,
        cardKey,
        tier,
        ownerTierLabel,
        motif,
        skillsId,
        pp,
        globalRank,
        copies,
        recycledCopies,
        firstPulledAt,
        lastPulledAt,
        now,
        /* Only a grant that creates the holding claims it was given. Editing a
           card somebody pulled passes the internal known-pulled sentinel; the
           conflict clause means neither direction can rewrite what happened:
           an edit cannot turn a pull into a gift, and it cannot turn a gift
           back into a pull. Dated like the pull stamp it stands in for, so an
           admin backdating a grant backdates both. */
        movingHolding
          // Readers expose 0 as null, but the concurrent final legacy scan
          // only stamps SQL null and therefore cannot misclassify this move.
          ? (Number(existing?.granted_at) > 0 ? Number(existing?.granted_at) : 0)
          : created ? firstPulledAt : null,
      ],
    },
    ...(moveFromKey ? movePackCardKeyReferencesStatements(owner.userId, moveFromKey, cardKey) : []),
    ...(moveFromKey ? [{
      sql: "delete from pack_collection_cards where owner_user_id = ? and card_key = ?",
      args: [owner.userId, moveFromKey],
    } satisfies DbStatement] : []),
    ...(retiresCompletionReward ? [{
      /* A manually granted Eternal is already this collector's one Eternal.
         Retire the automatic completion reward in the same transaction so a
         grant and a concurrent pack open can never produce two cards. */
      sql: `insert or ignore into pack_eternal_rewards (owner_user_id, claim_token, dealt_at)
            values (?, ?, ?)`,
      args: [owner.userId, `admin:${cardKey}`, now],
    } satisfies DbStatement] : []),
    ...serialStatements(cardKey, cardUserId, owner.userId, grant, now, copies > 0),
  ];
  await execBatch(db, statements);
  await getOrCreatePackWallet(db, owner.userId, now);
  await stampWalletOwnerUsername(db, owner, now);

  return { ok: true, result: { cardKey, created, card: await getPackCollectionCard(db, owner.userId, cardKey) } };
}

/* The catalog row for the variant this grant lands on.

   Identity is per variant and shared by everyone holding it, so the default is
   the same insert-or-ignore the mint path uses: a face is only written when
   nobody has one yet, and a player the backend tracks takes theirs from the
   users row regardless of what was typed. `overwrite` is the escape hatch for
   the case the ordinary rules cannot serve - a deleted account whose stored
   name is wrong - and it repaints the card for every collector of that
   variant, which is why it is off unless asked for. */
async function cardIdentityStatements(
  db: Db,
  spec: {
    cardKey: string;
    tierSlot: string;
    cardUserId: number;
    username?: string;
    avatarUrl?: string;
    countryCode?: string;
    tierLabel?: string | null;
    overwrite: boolean;
    now: number;
  },
): Promise<DbStatement[]> {
  const tracked = (await exec(
    db,
    "select username, avatar_url, country_code from users where user_id = ? limit 1",
    [spec.cardUserId],
  )).rows[0];
  const username = (typeof spec.username === "string" ? spec.username.trim() : "").slice(0, PACK_CARD_USERNAME_MAX_CHARS);
  const avatarUrl = normalizeAvatarUrl(
    typeof spec.avatarUrl === "string" ? spec.avatarUrl.trim().slice(0, PACK_CARD_AVATAR_URL_MAX_CHARS) : "",
  );
  const countryCode = normalizeCountryCode(typeof spec.countryCode === "string" ? spec.countryCode : "");
  const identity = {
    username: tracked ? String(tracked.username ?? "").slice(0, PACK_CARD_USERNAME_MAX_CHARS) : username,
    avatarUrl: tracked ? normalizeAvatarUrl(String(tracked.avatar_url ?? "")) : avatarUrl,
    countryCode: tracked ? normalizeCountryCode(String(tracked.country_code ?? "")) : countryCode,
  };

  const statements: DbStatement[] = [
    {
      /* Falls back to any variant of this player the catalog already holds, so
         granting a GOAT of someone whose ordinary card exists inherits their
         face instead of minting a nameless one. */
      sql: `insert or ignore into pack_cards (
              card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
            )
            select ?, ?, ?,
              coalesce(nullif(?, ''), (select pc.username from pack_cards pc where pc.card_user_id = ? and pc.username != '' limit 1), ''),
              coalesce(nullif(?, ''), (select pc.avatar_url from pack_cards pc where pc.card_user_id = ? and pc.avatar_url != '' limit 1), ''),
              coalesce(nullif(?, ''), (select pc.country_code from pack_cards pc where pc.card_user_id = ? and pc.country_code != '' limit 1), ''),
              ?, ?`,
      args: [
        spec.cardKey, spec.tierSlot, spec.cardUserId,
        identity.username, spec.cardUserId,
        identity.avatarUrl, spec.cardUserId,
        identity.countryCode, spec.cardUserId,
        // Labelless on purpose: see grantAdminPackCard. A typed label rides the
        // ownership row, and a variant only gains a shared one from a real
        // mint or from an explicit repaint below.
        null,
        spec.now,
      ] as InValue[],
    },
  ];
  if (spec.overwrite) {
    // Blank fields are left alone even here: an emptied box means "no opinion",
    // not "erase the name every collector of this variant reads".
    statements.push({
      sql: `update pack_cards set
              username = case when ? != '' then ? else username end,
              avatar_url = case when ? != '' then ? else avatar_url end,
              country_code = case when ? != '' then ? else country_code end,
              tier_label = ?,
              updated_at = ?
            where card_key = ? and tier = ?`,
      args: [
        username, username,
        avatarUrl, avatarUrl,
        countryCode, countryCode,
        spec.tierLabel ?? null,
        spec.now, spec.cardKey, spec.tierSlot,
      ] as InValue[],
    });
  }
  return statements;
}

function serialStatements(
  cardKey: string,
  cardUserId: number,
  ownerUserId: number,
  grant: AdminPackCardGrant,
  now: number,
  ensureSerial: boolean,
): DbStatement[] {
  if (grant.serialMode === "set") {
    const serial = clampInt(grant.serial, 1, PACK_CARD_MAX_SERIAL, 1);
    return [{
      sql: `insert into pack_card_serials (
              card_key, card_user_id, owner_user_id, serial, minted_at, pull_report_pending
            ) values (?, ?, ?, ?, ?, 0)
            on conflict(card_key, owner_user_id) do update set
              serial = excluded.serial,
              minted_at = excluded.minted_at,
              pull_report_pending = 0`,
      args: [cardKey, cardUserId, ownerUserId, serial, now],
    }];
  }
  // "Leave alone" means preserve an existing number. A positive holding may
  // not remain unserialled, so a create (or a legacy row the desk touches)
  // still gets the next one; insert-or-ignore keeps an existing one verbatim.
  if (grant.serialMode === "mint" || ensureSerial) {
    return [mintPackCardSerialStatement(cardKey, cardUserId, ownerUserId, now)];
  }
  return [];
}

export interface AdminPackCardRemoval {
  removed: boolean;
  serialRemoved: boolean;
}

/* Undo for a grant that named the wrong person. Drops the holding outright
   rather than zeroing its copies, because a zero-copy row still shadows a
   later pull's first_pulled_at. The catalog face and the interned snapshot are
   left alone: both are shared, and neither means anything on its own. */
export async function removeAdminPackCard(
  db: Db,
  ownerUserId: number,
  rawCardKey: unknown,
  options: { dropSerial?: boolean } = {},
): Promise<AdminPackCardRemoval> {
  const cardKey = normalizePackCardKey(rawCardKey);
  if (!cardKey || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return { removed: false, serialRemoved: false };
  const holding = (await exec(
    db,
    "select tier from pack_collection_cards where owner_user_id = ? and card_key = ?",
    [ownerUserId, cardKey],
  )).rows[0];
  if (!holding) return { removed: false, serialRemoved: false };

  const statements: DbStatement[] = [{
    sql: "delete from pack_collection_cards where owner_user_id = ? and card_key = ?",
    args: [ownerUserId, cardKey],
  }];
  let serialIndex = -1;
  if (options.dropSerial) {
    serialIndex = statements.length;
    statements.push({
      sql: "delete from pack_card_serials where owner_user_id = ? and card_key = ?",
      args: [ownerUserId, cardKey],
    });
  }
  // A pinned showcase slot pointing at a card nobody holds renders as nothing,
  // but leaving it means the next grant of the same card silently reappears on
  // the shelf, which is not what "removed" should mean.
  statements.push({
    sql: "delete from pack_showcase_cards where owner_user_id = ? and card_key = ?",
    args: [ownerUserId, cardKey],
  });
  if (holding.tier === "eternal") {
    statements.push({
      /* Admin removal is the one intentional reset. Recycling never touches
         this registry, but removing the collector's last Eternal means the
         current-completion reward may restore it on a later pack. Keep the
         claim while any other Eternal variant remains. */
      sql: `delete from pack_eternal_rewards
            where owner_user_id = ?
              and not exists (
                select 1 from pack_collection_cards
                where owner_user_id = ? and tier = 'eternal'
              )`,
      args: [ownerUserId, ownerUserId],
    });
  }
  const results = await execBatch(db, statements);
  return {
    removed: Number(results[0]?.rowsAffected ?? 0) > 0,
    serialRemoved: serialIndex >= 0 && Number(results[serialIndex]?.rowsAffected ?? 0) > 0,
  };
}

/* The durable name fallback for a collector with no users row. Only ever
   fills a blank: the pull log owns this column and writes the name the pull
   was made under. */
async function stampWalletOwnerUsername(db: Db, user: AdminPackUser, now: number): Promise<void> {
  if (!user.username) return;
  await exec(
    db,
    "update pack_wallets set owner_username = coalesce(nullif(owner_username, ''), ?), updated_at = ? where user_id = ?",
    [user.username, now, user.userId],
  );
}
