import type { ManiaCardTier, ManiaSkills } from "./maniacard";

// Pack economy: charges regenerate over time (one every 30 seconds, capped
// at 5), duplicate cards recycle into shards, and shards buy the paid pack
// types (see PACK_TYPES in packs.ts). Everything lives in localStorage, one
// wallet per viewer scope; the anonymous wallet is merged into the account
// wallet on login.

export const MAX_PACK_CHARGES = 5;
export const PACK_CHARGE_REGEN_MS = 30_000;
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

const TIER_SHARD_VALUES: Record<ManiaCardTier, number> = {
  common: 1,
  rare: 2,
  elite: 4,
  superRare: 6,
  ultraRare: 9,
  legendary: 14,
  mythic: 20,
  ascendant: 28,
  worldClass: 40,
  // A GOAT card is one of ten in the game; recycling one should be a real
  // decision, not a rounding error next to World Class's 40.
  goat: 1000,
};

export function tierRank(tier: ManiaCardTier | null): number {
  return tier ? TIER_ORDER.indexOf(tier) : -1;
}

export function shardValueForTier(tier: ManiaCardTier | null): number {
  return tier ? TIER_SHARD_VALUES[tier] : 1;
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
  const key = String(pull.userId);
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
  userId: number,
  mint: { skills: ManiaSkills; tier: ManiaCardTier | null; tierLabel: string | null },
): PackWallet | null {
  const key = String(userId);
  const card = wallet.cards[key];
  if (!card || card.copies <= 0) return null;
  if (card.skills && tierRank(card.tier) >= tierRank(mint.tier)) return null;
  return {
    ...wallet,
    cards: {
      ...wallet.cards,
      [key]: { ...card, skills: mint.skills, tier: mint.tier, tierLabel: mint.tierLabel },
    },
  };
}

export function duplicateShardValue(card: CollectedCard): number {
  return Math.max(0, card.copies - 1) * shardValueForTier(card.tier);
}

export function duplicateShardTotal(wallet: PackWallet): number {
  return Object.values(wallet.cards).reduce((sum, card) => sum + duplicateShardValue(card), 0);
}

export function recycleDuplicates(
  wallet: PackWallet,
  userId: number,
): { wallet: PackWallet; gained: number } {
  const key = String(userId);
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
  userId: number,
): { wallet: PackWallet; gained: number } {
  const key = String(userId);
  const card = wallet.cards[key];
  if (!card || card.copies <= 0) return { wallet, gained: 0 };
  const gained = card.copies * shardValueForTier(card.tier);
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
      if (card) cards[String(card.userId)] = card;
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
