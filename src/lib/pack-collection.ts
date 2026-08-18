import { getManiaCardTier, type ManiaCardTier, type ManiaSkills } from "./maniacard";

// Pack economy: charges regenerate over time (one every 20 seconds, capped
// at 5), duplicate cards recycle into shards, and shards buy the paid pack
// types (see PACK_TYPES in packs.ts). Everything lives in localStorage, one
// wallet per viewer scope; the anonymous wallet is merged into the account
// wallet on login.

export const MAX_PACK_CHARGES = 5;
export const PACK_CHARGE_REGEN_MS = 20_000;
/* Every opened pack banks a few shards, so the shard packs are reachable by
   just playing - duplicates only speed it up. */
export const PACK_OPEN_SHARD_REWARD = 2;

export interface CollectedCard {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
  /* Badge text given to this one holding from /admin/collections, printed on
     the card art in place of the tier's name (the slot honorary players'
     cardTierLabel uses). Only ever set on a synced collection, so sanitizeCard
     drops it for the same reason it drops serial. */
  customLabel?: string | null;
  /* Skills snapshot from the pull, enough to redraw the real card front
     offline (the texture pipeline needs no scores). Null for failed mints
     and cards collected before snapshots existed. */
  skills: ManiaSkills | null;
  pp: number;
  globalRank: number;
  copies: number;
  /* Copies ever recycled - monotonic, so wallets from two devices can be
     reconciled without recycled duplicates coming back. */
  recycledCopies: number;
  firstPulledAt: number;
  lastPulledAt: number;
  /* Mint order: #1 is whoever pulled this card first, anywhere, and
     mintedTotal is how many serials it has handed out. Both come from the
     server's mint registry, so they are only present on a synced collection;
     sanitizeCard deliberately drops them rather than persisting a server fact
     into localStorage. */
  serial?: number | null;
  mintedTotal?: number;
}

export interface PackWallet {
  cards: Record<string, CollectedCard>;
  shards: number;
  /* Shards ever spent - monotonic, mirrors recycledCopies for reconciles. */
  shardsSpent: number;
  charges: number;
  lastRefillAt: number;
  openedPacks: number;
  poolTotal: number | null;
}

export interface PulledCard {
  userId: number;
  username: string;
  avatarUrl: string;
  countryCode: string;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
  skills: ManiaSkills | null;
  pp: number;
  globalRank: number;
}

const TIER_ORDER: ManiaCardTier[] = [
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
];

/* The ladder is deliberately compressed at the bottom rather than starting at
   one shard. Common and Rare are 61% of the pool, so they are what an ordinary
   pack actually deals, and at 1 and 2 shards the modal pack paid back almost
   nothing: a duplicate of either recycled for exactly 1 shard, since
   DUPLICATE_RECYCLE_RATE floors there and cannot go lower. Raising the rate
   could never fix that (half of 2 still floors to 1); only the base values
   move it, which is why the bottom four rungs carry the buff and the top three
   barely moved. */
const TIER_SHARD_VALUES: Record<ManiaCardTier, number> = {
  common: 2,
  rare: 4,
  elite: 7,
  superRare: 10,
  ultraRare: 14,
  legendary: 20,
  mythic: 27,
  ascendant: 36,
  worldClass: 48,
  // A GOAT card is one of a tiny honorary roster; recycling one should be a
  // real decision, not a rounding error next to World Class's 48. It used to
  // be 1000, enough to buy several Legend packs for a card the honorary slot
  // hands you for free once you hold the roster - see DUPLICATE_RECYCLE_RATE
  // for why that mattered.
  goat: 500,
};

/* What a second copy is worth next to the first. A card you do not own yet is
   worth its tier value; a copy of one you already hold is worth half, rounded
   down and floored at one shard.

   This is what keeps the shard economy from running backwards. A pack is only
   ever bought with shards, and once a collection is complete every card it
   deals is a duplicate - so if duplicates recycled at full tier value, the
   expected recycle return on a pack would have to beat its price for the pack
   to be worth opening, and beating its price is exactly what made opening one
   an income source rather than a purchase. Halving the duplicate closes that
   loop: every pack type still returns less in shards than it costs (roughly
   84% for Wild, 85% for Elite, 61% for Legend against the current pool), so
   shards flow in from charges and the arcade and drain out through packs,
   which is the direction the economy is supposed to run.

   Those margins are thinner than they were, because the ladder's bottom rungs
   were raised to make an ordinary pack worth recycling. Elite is the one with
   no room left: its slice is the pool's top 10%, so it deals nothing below
   ultraRare and its return tracks the ladder's upper half almost exactly. If
   the ladder is ever buffed again, reprice Elite in the same commit or it
   becomes the printer this rate exists to prevent. */
export const DUPLICATE_RECYCLE_RATE = 0.5;

const TIER_DUPLICATE_SHARD_VALUES: Record<ManiaCardTier, number> = Object.fromEntries(
  Object.entries(TIER_SHARD_VALUES).map(([tier, value]) => [
    tier,
    Math.max(1, Math.floor(value * DUPLICATE_RECYCLE_RATE)),
  ]),
) as Record<ManiaCardTier, number>;

export function tierRank(tier: ManiaCardTier | null): number {
  return tier ? TIER_ORDER.indexOf(tier) : -1;
}

export function shardValueForTier(tier: ManiaCardTier | null): number {
  return tier ? TIER_SHARD_VALUES[tier] : 1;
}

/* What one duplicate copy of this tier recycles for. */
export function duplicateShardValueForTier(tier: ManiaCardTier | null): number {
  return tier ? TIER_DUPLICATE_SHARD_VALUES[tier] : 1;
}

/* The tier a collected card shows, which is the tier it was minted at rather
   than the tier its player carries today. The two diverge for the honorary
   roster: several of them are live ranked players, so a card pulled out of the
   ranked pool before they joined the roster is a World Class card of that
   player and stays one, art and shard value included. Only a card that was
   actually dealt as a GOAT is a GOAT.

   Everything that draws a collected card resolves its tier through here, so
   the badge, the thumbnail, the inspect view and the recycle value can never
   disagree about what a card is. */
export function collectedCardTier(card: {
  tier?: ManiaCardTier | null;
  skills?: ManiaSkills | null;
}): ManiaCardTier {
  if (card.tier) return card.tier;
  if (card.skills && Number.isFinite(card.skills.cardPower)) return getManiaCardTier(card.skills.cardPower);
  return "common";
}

/* A collected card's identity, and the key it lives under in `wallet.cards`.

   A player is normally one card: pull them again and the copy count goes up,
   and if their card power has climbed since, the card upgrades in place. GOAT
   is the exception. It is awarded by roster membership rather than by card
   power, and several roster members are live ranked players, so the same
   player can legitimately be held both as the card they were dealt from the
   ranked pool and as the GOAT the honorary slot deals. Those are two different
   cards and must not collapse into one, or a GOAT pull would silently destroy
   a World Class card its owner may want to keep (or recycle separately).

   Only the GOAT variant takes a suffix, so every key an existing wallet has
   already written stays byte-identical and nothing has to be migrated. */
export function packCardKey(userId: number, tier: ManiaCardTier | null): string {
  return tier === "goat" ? `${userId}:goat` : String(userId);
}

export function packCardKeyOf(card: { userId: number; tier: ManiaCardTier | null }): string {
  return packCardKey(card.userId, card.tier);
}

export function parsePackCardKey(key: string): { userId: number; goat: boolean } | null {
  const goat = key.endsWith(":goat");
  const userId = Number(goat ? key.slice(0, -":goat".length) : key);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return { userId, goat };
}

export function createEmptyWallet(now: number): PackWallet {
  return {
    cards: {},
    shards: 0,
    shardsSpent: 0,
    charges: MAX_PACK_CHARGES,
    lastRefillAt: now,
    openedPacks: 0,
    poolTotal: null,
  };
}

/* Applies regeneration since lastRefillAt. Returns the same object when
   nothing changed so callers can identity-check before re-rendering. */
export function settleCharges(wallet: PackWallet, now: number): PackWallet {
  if (wallet.charges >= MAX_PACK_CHARGES) return wallet;
  const elapsed = now - wallet.lastRefillAt;
  if (elapsed < PACK_CHARGE_REGEN_MS) return wallet;
  const gained = Math.floor(elapsed / PACK_CHARGE_REGEN_MS);
  const charges = Math.min(MAX_PACK_CHARGES, wallet.charges + gained);
  return {
    ...wallet,
    charges,
    lastRefillAt:
      charges >= MAX_PACK_CHARGES ? now : wallet.lastRefillAt + gained * PACK_CHARGE_REGEN_MS,
  };
}

export function msUntilNextCharge(wallet: PackWallet, now: number): number | null {
  const settled = settleCharges(wallet, now);
  if (settled.charges >= MAX_PACK_CHARGES) return null;
  return Math.max(0, settled.lastRefillAt + PACK_CHARGE_REGEN_MS - now);
}

export function spendCharge(wallet: PackWallet, now: number): PackWallet | null {
  const settled = settleCharges(wallet, now);
  if (settled.charges <= 0) return null;
  return {
    ...settled,
    charges: settled.charges - 1,
    // Spending from a full wallet starts the regen clock fresh.
    lastRefillAt: settled.charges >= MAX_PACK_CHARGES ? now : settled.lastRefillAt,
    shards: settled.shards + PACK_OPEN_SHARD_REWARD,
    openedPacks: settled.openedPacks + 1,
  };
}

export function spendShards(wallet: PackWallet, cost: number): PackWallet | null {
  if (wallet.shards < cost) return null;
  return {
    ...wallet,
    shards: wallet.shards - cost + PACK_OPEN_SHARD_REWARD,
    shardsSpent: wallet.shardsSpent + cost,
    openedPacks: wallet.openedPacks + 1,
  };
}

export function recordPull(
  wallet: PackWallet,
  pull: PulledCard,
  now: number,
): { wallet: PackWallet; isNew: boolean } {
  const key = packCardKey(pull.userId, pull.tier);
  const existing = wallet.cards[key];
  if (!existing) {
    const card: CollectedCard = { ...pull, copies: 1, recycledCopies: 0, firstPulledAt: now, lastPulledAt: now };
    return { wallet: { ...wallet, cards: { ...wallet.cards, [key]: card } }, isNew: true };
  }
  // A fully recycled card left a tombstone (copies 0); repulling it counts
  // as new for the collection display.
  const isNew = existing.copies === 0;
  // A repulled player keeps the best tier it has ever minted at; the rest of
  // the metadata follows the latest pull.
  const keepExistingTier = tierRank(existing.tier) > tierRank(pull.tier);
  const card: CollectedCard = {
    ...existing,
    username: pull.username,
    avatarUrl: pull.avatarUrl,
    countryCode: pull.countryCode,
    pp: pull.pp,
    globalRank: pull.globalRank,
    tier: keepExistingTier ? existing.tier : pull.tier,
    tierLabel: keepExistingTier ? existing.tierLabel : pull.tierLabel,
    // The skills snapshot follows the tier the card shows.
    skills: keepExistingTier ? existing.skills ?? pull.skills : pull.skills ?? existing.skills,
    copies: existing.copies + 1,
    lastPulledAt: now,
  };
  return { wallet: { ...wallet, cards: { ...wallet.cards, [key]: card } }, isNew };
}

/* Cards actually held (tombstones from fully recycled cards excluded). */
export function ownedCards(wallet: PackWallet): CollectedCard[] {
  return Object.values(wallet.cards).filter((card) => card.copies > 0);
}

/* Backfills a freshly computed mint onto an owned card. Cards without a
   skills snapshot (legacy pulls, failed mints) adopt it wholesale; cards
   that already have one only ever upgrade to a higher tier. Returns null
   when nothing should change. */
export function applyCardMint(
  wallet: PackWallet,
  key: string,
  mint: { skills: ManiaSkills; tier: ManiaCardTier | null; tierLabel: string | null },
): PackWallet | null {
  const card = wallet.cards[key];
  if (!card || card.copies <= 0) return null;
  if (card.skills && tierRank(card.tier) >= tierRank(mint.tier)) return null;
  const minted: CollectedCard = { ...card, skills: mint.skills, tier: mint.tier, tierLabel: mint.tierLabel };
  const mintedKey = packCardKeyOf(minted);
  // A tierless legacy card whose player is on the roster mints as a GOAT, which
  // belongs under the GOAT key. Merge rather than overwrite: the owner may
  // already hold a GOAT of that player.
  if (mintedKey !== key) {
    const cards = { ...wallet.cards };
    delete cards[key];
    const existing = cards[mintedKey];
    cards[mintedKey] = existing
      ? {
          ...minted,
          copies: existing.copies + minted.copies,
          recycledCopies: existing.recycledCopies + minted.recycledCopies,
          firstPulledAt: Math.min(existing.firstPulledAt, minted.firstPulledAt),
          lastPulledAt: Math.max(existing.lastPulledAt, minted.lastPulledAt),
        }
      : minted;
    return { ...wallet, cards };
  }
  return { ...wallet, cards: { ...wallet.cards, [key]: minted } };
}

export function duplicateShardValue(card: CollectedCard): number {
  return Math.max(0, card.copies - 1) * duplicateShardValueForTier(card.tier);
}

/* What letting the whole card go pays: the copy you were keeping at full tier
   value, plus every copy beyond it at the duplicate rate. Recycling everything
   has to price the duplicates the same way recycling only the duplicates does,
   or "recycle all" would be a strictly better way to cash in duplicates than
   the button that exists for it. */
export function wholeCardShardValue(card: CollectedCard): number {
  if (card.copies <= 0) return 0;
  return shardValueForTier(card.tier) + duplicateShardValue(card);
}

export function duplicateShardTotal(wallet: PackWallet): number {
  return Object.values(wallet.cards).reduce((sum, card) => sum + duplicateShardValue(card), 0);
}

export function recycleDuplicates(
  wallet: PackWallet,
  key: string,
): { wallet: PackWallet; gained: number } {
  const card = wallet.cards[key];
  if (!card || card.copies <= 1) return { wallet, gained: 0 };
  const gained = duplicateShardValue(card);
  return {
    wallet: {
      ...wallet,
      shards: wallet.shards + gained,
      cards: {
        ...wallet.cards,
        [key]: { ...card, copies: 1, recycledCopies: card.recycledCopies + card.copies - 1 },
      },
    },
    gained,
  };
}

/* Recycles every copy, including the last one: the card leaves the
   collection (a zero-copy tombstone stays behind so reconciles with stale
   devices cannot resurrect it). */
export function recycleAllCopies(
  wallet: PackWallet,
  key: string,
): { wallet: PackWallet; gained: number } {
  const card = wallet.cards[key];
  if (!card || card.copies <= 0) return { wallet, gained: 0 };
  const gained = wholeCardShardValue(card);
  return {
    wallet: {
      ...wallet,
      shards: wallet.shards + gained,
      cards: {
        ...wallet.cards,
        [key]: { ...card, copies: 0, recycledCopies: card.recycledCopies + card.copies },
      },
    },
    gained,
  };
}

/* What handing back `copies` copies pays when the collector holds
   `heldCopies` of that card: the last copy to leave is worth the full tier
   value, every copy above it the duplicate rate. That is the same split
   recycleAllCopies uses, so cashing a card in one copy at a time can never
   pay more than cashing it in at once. */
export function copiesShardValue(
  tier: ManiaCardTier | null,
  copies: number,
  heldCopies: number,
): number {
  const held = Math.max(0, Math.floor(heldCopies));
  const taken = Math.min(Math.max(0, Math.floor(copies)), held);
  if (taken <= 0) return 0;
  const duplicateValue = duplicateShardValueForTier(tier);
  return taken >= held
    ? shardValueForTier(tier) + (taken - 1) * duplicateValue
    : taken * duplicateValue;
}

/* Recycles a set number of copies, keeping the rest. What the pull summary
   hands a freshly opened pack back with: a card the pack was the first copy
   of leaves the collection, while a duplicate gives up only the copy this
   pack added and the copies collected before it stay put. */
export function recycleCopies(
  wallet: PackWallet,
  key: string,
  copies: number,
): { wallet: PackWallet; gained: number } {
  const card = wallet.cards[key];
  if (!card || card.copies <= 0) return { wallet, gained: 0 };
  const taken = Math.min(Math.max(0, Math.floor(copies)), card.copies);
  if (taken <= 0) return { wallet, gained: 0 };
  const gained = copiesShardValue(card.tier, taken, card.copies);
  return {
    wallet: {
      ...wallet,
      shards: wallet.shards + gained,
      cards: {
        ...wallet.cards,
        [key]: { ...card, copies: card.copies - taken, recycledCopies: card.recycledCopies + taken },
      },
    },
    gained,
  };
}

export function recycleAllDuplicates(wallet: PackWallet): { wallet: PackWallet; gained: number } {
  let gained = 0;
  const cards: Record<string, CollectedCard> = {};
  for (const [key, card] of Object.entries(wallet.cards)) {
    gained += duplicateShardValue(card);
    cards[key] =
      card.copies > 1
        ? { ...card, copies: 1, recycledCopies: card.recycledCopies + card.copies - 1 }
        : card;
  }
  if (gained === 0) return { wallet, gained: 0 };
  return { wallet: { ...wallet, shards: wallet.shards + gained, cards }, gained };
}

export function mergeWallets(base: PackWallet, incoming: PackWallet): PackWallet {
  const cards: Record<string, CollectedCard> = { ...base.cards };
  for (const [key, card] of Object.entries(incoming.cards)) {
    const existing = cards[key];
    if (!existing) {
      cards[key] = card;
      continue;
    }
    const latest = card.lastPulledAt >= existing.lastPulledAt ? card : existing;
    const best = tierRank(existing.tier) >= tierRank(card.tier) ? existing : card;
    cards[key] = {
      ...latest,
      tier: best.tier,
      tierLabel: best.tierLabel,
      skills: best.skills ?? latest.skills,
      copies: existing.copies + card.copies,
      recycledCopies: existing.recycledCopies + card.recycledCopies,
      firstPulledAt: Math.min(existing.firstPulledAt, card.firstPulledAt),
      lastPulledAt: Math.max(existing.lastPulledAt, card.lastPulledAt),
    };
  }
  return {
    cards,
    shards: base.shards + incoming.shards,
    shardsSpent: base.shardsSpent + incoming.shardsSpent,
    charges: Math.min(MAX_PACK_CHARGES, Math.max(base.charges, incoming.charges)),
    lastRefillAt: Math.max(base.lastRefillAt, incoming.lastRefillAt),
    openedPacks: base.openedPacks + incoming.openedPacks,
    poolTotal: base.poolTotal ?? incoming.poolTotal,
  };
}

/* Cross-device reconcile. Unlike mergeWallets (which sums two genuinely
   distinct histories exactly once), this can safely run any number of times
   against stale copies of the same history: every progress field is treated
   as a monotonic counter and merged with max, so re-reconciling never
   double-counts pulls or shards, and recycled duplicates never come back. */
export function reconcileWallets(a: PackWallet, b: PackWallet, now: number): PackWallet {
  const cards: Record<string, CollectedCard> = {};
  const keys = new Set([...Object.keys(a.cards), ...Object.keys(b.cards)]);
  for (const key of keys) {
    const left = a.cards[key];
    const right = b.cards[key];
    if (!left || !right) {
      cards[key] = (left ?? right)!;
      continue;
    }
    const latest = right.lastPulledAt >= left.lastPulledAt ? right : left;
    const best = tierRank(left.tier) >= tierRank(right.tier) ? left : right;
    const pulled = Math.max(left.copies + left.recycledCopies, right.copies + right.recycledCopies);
    const recycled = Math.max(left.recycledCopies, right.recycledCopies);
    cards[key] = {
      ...latest,
      tier: best.tier,
      tierLabel: best.tierLabel,
      skills: best.skills ?? latest.skills,
      copies: Math.max(0, pulled - recycled),
      recycledCopies: recycled,
      firstPulledAt: Math.min(left.firstPulledAt, right.firstPulledAt),
      lastPulledAt: Math.max(left.lastPulledAt, right.lastPulledAt),
    };
  }
  const earned = Math.max(a.shards + a.shardsSpent, b.shards + b.shardsSpent);
  const spent = Math.max(a.shardsSpent, b.shardsSpent);
  const settledA = settleCharges(a, now);
  const settledB = settleCharges(b, now);
  return {
    cards,
    shards: Math.max(0, earned - spent),
    shardsSpent: spent,
    // The stingier charge state wins so charges can't be duped across devices.
    charges: Math.min(settledA.charges, settledB.charges),
    lastRefillAt: Math.max(settledA.lastRefillAt, settledB.lastRefillAt),
    openedPacks: Math.max(a.openedPacks, b.openedPacks),
    poolTotal:
      a.poolTotal !== null && b.poolTotal !== null
        ? Math.max(a.poolTotal, b.poolTotal)
        : a.poolTotal ?? b.poolTotal,
  };
}

// --- localStorage IO ---

export const PACK_WALLET_STORAGE_PREFIX = "mania-hub-packs-v1";

export function packWalletStorageKey(viewerId: number | null): string {
  return viewerId ? `${PACK_WALLET_STORAGE_PREFIX}:user-${viewerId}` : `${PACK_WALLET_STORAGE_PREFIX}:anon`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const SKILL_NUMBER_FIELDS = [
  "starAvg",
  "fingerControl",
  "speed",
  "accuracy",
  "stamina",
  "versatility",
  "peak",
  "cardPower",
  "mainKeyMode",
  "sampleSize",
] as const;

function sanitizeSkills(value: unknown): ManiaSkills | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const skills = { archetype: typeof raw.archetype === "string" ? raw.archetype : "" } as ManiaSkills;
  for (const field of SKILL_NUMBER_FIELDS) {
    const num = raw[field];
    if (!isFiniteNumber(num)) return null;
    skills[field] = num;
  }
  return skills;
}

function sanitizeCard(value: unknown): CollectedCard | null {
  if (!value || typeof value !== "object") return null;
  const card = value as Partial<CollectedCard>;
  if (!isFiniteNumber(card.userId) || typeof card.username !== "string") return null;
  return {
    userId: card.userId,
    username: card.username,
    avatarUrl: typeof card.avatarUrl === "string" ? card.avatarUrl : "",
    countryCode: typeof card.countryCode === "string" ? card.countryCode : "",
    tier: tierRank((card.tier as ManiaCardTier) ?? null) >= 0 ? (card.tier as ManiaCardTier) : null,
    tierLabel: typeof card.tierLabel === "string" ? card.tierLabel : null,
    skills: sanitizeSkills(card.skills),
    pp: isFiniteNumber(card.pp) ? card.pp : 0,
    globalRank: isFiniteNumber(card.globalRank) ? card.globalRank : 0,
    copies: isFiniteNumber(card.copies) ? Math.max(0, Math.floor(card.copies)) : 1,
    recycledCopies: isFiniteNumber(card.recycledCopies) ? Math.max(0, Math.floor(card.recycledCopies)) : 0,
    firstPulledAt: isFiniteNumber(card.firstPulledAt) ? card.firstPulledAt : 0,
    lastPulledAt: isFiniteNumber(card.lastPulledAt) ? card.lastPulledAt : 0,
  };
}

export function sanitizeWallet(value: unknown, now: number): PackWallet | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PackWallet>;
  const cards: Record<string, CollectedCard> = {};
  if (raw.cards && typeof raw.cards === "object") {
    for (const entry of Object.values(raw.cards)) {
      const card = sanitizeCard(entry);
      // Re-keyed from the card itself, so a wallet written before GOAT cards
      // split off from their player's ordinary card moves to the new key here,
      // with no separate migration step.
      if (card) cards[packCardKeyOf(card)] = card;
    }
  }
  return {
    cards,
    shards: isFiniteNumber(raw.shards) ? Math.max(0, Math.floor(raw.shards)) : 0,
    shardsSpent: isFiniteNumber(raw.shardsSpent) ? Math.max(0, Math.floor(raw.shardsSpent)) : 0,
    charges: isFiniteNumber(raw.charges)
      ? Math.min(MAX_PACK_CHARGES, Math.max(0, Math.floor(raw.charges)))
      : MAX_PACK_CHARGES,
    lastRefillAt: isFiniteNumber(raw.lastRefillAt) ? Math.min(raw.lastRefillAt, now) : now,
    openedPacks: isFiniteNumber(raw.openedPacks) ? Math.max(0, Math.floor(raw.openedPacks)) : 0,
    poolTotal: isFiniteNumber(raw.poolTotal) ? raw.poolTotal : null,
  };
}

export function readPackWallet(key: string, now: number): PackWallet | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return sanitizeWallet(JSON.parse(raw), now);
  } catch {
    return null;
  }
}

export function writePackWallet(key: string, wallet: PackWallet): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(wallet));
  } catch {
    // Quota or privacy mode: the in-memory wallet still works this session.
  }
}

/* Loads the wallet for the current viewer. A logged-in viewer adopts any
   anonymous wallet left behind in this browser (merged once, then removed)
   so pulls made before logging in are not lost. */
export function loadWalletForViewer(viewerId: number | null, now: number): PackWallet {
  const key = packWalletStorageKey(viewerId);
  let wallet = readPackWallet(key, now) ?? createEmptyWallet(now);
  if (viewerId) {
    const anonKey = packWalletStorageKey(null);
    const anonWallet = readPackWallet(anonKey, now);
    if (anonWallet && (Object.keys(anonWallet.cards).length > 0 || anonWallet.shards > 0)) {
      wallet = mergeWallets(wallet, anonWallet);
      writePackWallet(key, wallet);
      try {
        localStorage.removeItem(anonKey);
      } catch {
        // Best effort; a stale anon wallet only risks a double merge of the
        // same cards, never data loss.
      }
    }
  }
  return settleCharges(wallet, now);
}
