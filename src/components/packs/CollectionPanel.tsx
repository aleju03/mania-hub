import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ImageOff, Loader2, LogIn, Recycle, Search, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import { MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "#/lib/maniacard";
import {
  collectedCardTier,
  duplicateShardTotal,
  duplicateShardValue,
  ownedCards,
  packCardKeyOf,
  shardValueForTier,
  tierRank,
  wholeCardShardValue,
  type CollectedCard,
  type PackWallet,
} from "#/lib/pack-collection";
import { HONORARY_PLAYERS } from "#/lib/honorary-players";
import {
  fetchOwnPackShowcase,
  fetchServerPackCollectionPage,
  PACK_SHOWCASE_MAX_CARDS,
  saveOwnPackShowcase,
  type ServerPackCollectionPage,
} from "#/lib/pack-wallet-sync";
import { fetchPackPlayerScores } from "#/lib/packs";
import {
  buildManiaCardRenderData,
  buildManiaCardRenderDataFromSkills,
} from "../player/maniacard3d/renderData";
import { CardSpotlight, type CardSpotlightTarget } from "./CardSpotlight";
import { renderCardSkeletonThumbnail, renderCardThumbnailBlob } from "./cardSnapshot";
import {
  cardThumbnailKeyForCollectionCard,
  cardThumbnailKeyForData,
  claimCardThumbnailErrorFallback,
  COLLECTION_CARD_THUMB_WIDTH,
  forgetRemoteCardThumbnail,
  getMemoryCardThumbnail,
  loadPersistedCardThumbnail,
  loadR2CardThumbnails,
  rememberCardThumbnailBlob,
} from "./cardThumbnailCache";
import { playRecycleClink } from "./packSfx";

export interface CardMint {
  skills: ManiaSkills;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
}

/* "untracked" is the pseudo-filter for owned players who left the draw pool;
   like "unrated" it rides the tier param, but the server resolves it by pool
   membership rather than by tier. Server collections only: a local wallet has
   no idea who is still in the pool. */
type CollectionTierFilter = ManiaCardTier | "all" | "unrated" | "untracked";

/* "newest" orders by when the card first joined the collection (dup pulls do
   not resurface a card); "rarity" is the classic tier-then-pp order. */
type CollectionSortMode = "rarity" | "newest";

const COLLECTION_SORTS: Array<{ id: CollectionSortMode; label: string; hint: string }> = [
  { id: "rarity", label: "Rarity", hint: "Highest tier first, then pp" },
  { id: "newest", label: "Newest", hint: "When each card first joined your collection" },
];

/* How you read your own collection is a standing preference, not a transient
   lens like the rarity chips, so it survives a reload. On its own key rather
   than in the packs cache, like the maps search sort: a cache-version bump or
   a quota eviction must not take it with them. */
const COLLECTION_SORT_STORAGE_KEY = "mania-hub-collection-sort-v1";

function readStoredCollectionSort(): CollectionSortMode {
  if (typeof window === "undefined") return "rarity";
  try {
    return window.localStorage.getItem(COLLECTION_SORT_STORAGE_KEY) === "newest" ? "newest" : "rarity";
  } catch {
    return "rarity";
  }
}

function writeStoredCollectionSort(mode: CollectionSortMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLECTION_SORT_STORAGE_KEY, mode);
  } catch {
    // Private mode or a full quota: the choice just lasts this session.
  }
}

interface CollectionPanelProps {
  wallet: PackWallet | null;
  showLoginNudge: boolean;
  syncStatus: "local" | "syncing" | "synced";
  /* Recycle callbacks return the shards gained so the panel can play the
     clink and spawn the "+N" burst at the click point. */
  onRecycleCard: (cardKey: string) => number | Promise<number>;
  onRecycleWhole: (cardKey: string) => number | Promise<number>;
  onRecycleWholeMany: (cardKeys: string[]) => number | Promise<number>;
  onRecycleWholeMatching: (filter: { tier: CollectionTierFilter; query: string }) => number | Promise<number>;
  onRecycleAll: () => number | Promise<number>;
  /* Resolves true when the repair actually landed (locally or server-side). */
  onApplyMint: (cardKey: string, mint: CardMint) => boolean | Promise<boolean>;
}

interface LoadedServerCollectionPage {
  cacheKey: string;
  filterKey: string;
  page: ServerPackCollectionPage;
}

const COLLECTION_PAGE_SIZE = 15;
const skeletonThumbnailCache = new Map<ManiaCardTier | "neutral", string>();
const serverCollectionPageCache = new Map<string, ServerPackCollectionPage>();
const COLLECTION_TIER_ORDER: ManiaCardTier[] = [
  "goat",
  "worldClass",
  "ascendant",
  "mythic",
  "legendary",
  "ultraRare",
  "superRare",
  "elite",
  "rare",
  "common",
];

let activeRenders = 0;
const renderQueue: Array<() => void> = [];
async function throttleRender<T>(task: () => Promise<T>): Promise<T> {
  if (activeRenders >= 2) await new Promise<void>((resolve) => renderQueue.push(resolve));
  activeRenders += 1;
  try {
    return await task();
  } finally {
    activeRenders -= 1;
    const next = renderQueue.shift();
    if (next) {
      /* Resolving here keeps the whole visible page in one microtask chain:
         each canvas mint hands the main thread straight to the next before a
         queued click can run. A task boundary preserves the two-wide render
         bound while letting input and the streak-game handoff go first. */
      window.setTimeout(next, 0);
    }
  }
}

function thumbnailKey(card: CollectedCard): string {
  return cardThumbnailKeyForCollectionCard(card) ?? `${card.userId}:${card.tier ?? "unrated"}:plain`;
}

function cardUserForRender(card: CollectedCard) {
  return {
    id: card.userId,
    username: card.username,
    avatar_url: card.avatarUrl,
    country_code: card.countryCode,
    statistics: { global_rank: card.globalRank, pp: card.pp },
  };
}

async function renderCollectionThumbnail(card: CollectedCard): Promise<{ key: string; url: string } | null> {
  if (!card.skills) return null;
  const data = buildManiaCardRenderDataFromSkills({
    user: cardUserForRender(card),
    skills: card.skills,
    tierOverride: collectedCardTier(card),
  });
  const key = cardThumbnailKeyForData(data, COLLECTION_CARD_THUMB_WIDTH);
  const blob = await throttleRender(() => renderCardThumbnailBlob(data, COLLECTION_CARD_THUMB_WIDTH));
  return { key, url: await rememberCardThumbnailBlob(key, blob) };
}

function pageSignature(cards: CollectedCard[]) {
  return cards.map(thumbnailKey).join("|");
}

function resolveCollectionCardTier(card?: CollectedCard): ManiaCardTier {
  return card ? collectedCardTier(card) : "common";
}

function placeholderTiersForPage({
  count,
  pageStart,
  tierFilter,
  tierCounts,
}: {
  count: number;
  pageStart: number;
  tierFilter: CollectionTierFilter;
  tierCounts: Record<string, number>;
}): ManiaCardTier[] {
  if (tierFilter !== "all") {
    // Unrated and untracked cards have no single rarity; commons are the
    // neutral skeleton face.
    const tier = tierFilter === "unrated" || tierFilter === "untracked" ? "common" : tierFilter;
    return Array.from({ length: count }, () => tier);
  }

  // Counts are filter-independent, so on "all" we lay the skeletons out in the
  // real rarity order the loaded cards will follow.
  const tiers: ManiaCardTier[] = [];
  let remainingBeforePage = pageStart;
  for (const tier of COLLECTION_TIER_ORDER) {
    const tierCount = Math.max(0, Math.floor(Number(tierCounts[tier]) || 0));
    if (tierCount <= 0) continue;
    if (remainingBeforePage >= tierCount) {
      remainingBeforePage -= tierCount;
      continue;
    }
    const visibleFromTier = Math.min(tierCount - remainingBeforePage, count - tiers.length);
    tiers.push(...Array.from({ length: visibleFromTier }, () => tier));
    remainingBeforePage = 0;
    if (tiers.length >= count) break;
  }

  while (tiers.length < count) tiers.push("common");
  return tiers;
}

function serverCollectionCacheKey({
  page,
  pageSize,
  tier,
  query,
  sort,
}: {
  page: number;
  pageSize: number;
  tier: CollectionTierFilter;
  query: string;
  sort: CollectionSortMode;
}) {
  return `${page}:${pageSize}:${tier}:${sort}:${query}`;
}

/* Which rows the filter selects, not the order they come back in: totals,
   rarity counts, shard sums and pool progress are all order-independent, so a
   page loaded under the other sort still carries them. That keeps the pager
   and the chips on screen while a sort switch loads instead of collapsing to
   "0 cards" for a beat. */
function serverCollectionFilterKey({
  pageSize,
  tier,
  query,
}: {
  pageSize: number;
  tier: CollectionTierFilter;
  query: string;
}) {
  return `${pageSize}:${tier}:${query}`;
}

function CollectionPager({
  page,
  totalPages,
  pageStart,
  pageEnd,
  total,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  pageStart: number;
  pageEnd: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState("");

  const submitJump = () => {
    const parsed = Number.parseInt(jumpValue, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalPages) onPageChange(parsed - 1);
    setJumpOpen(false);
    setJumpValue("");
  };

  const navButton =
    "grid h-7 w-7 place-items-center rounded-lg border border-osu-b3/40 bg-osu-b4/40 text-osu-f1 transition-colors hover:bg-osu-b4/70 hover:text-white disabled:cursor-default disabled:opacity-40 cursor-pointer";

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-osu-f1">
      <button
        type="button"
        onClick={() => onPageChange(0)}
        disabled={page <= 0}
        className={navButton}
        aria-label="First collection page"
      >
        <ChevronsLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onPageChange(Math.max(0, page - 1))}
        disabled={page <= 0}
        className={navButton}
        aria-label="Previous collection page"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {jumpOpen ? (
        <form
          className="flex min-w-[132px] items-center justify-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            submitJump();
          }}
        >
          <span>Page</span>
          <input
            type="number"
            min={1}
            max={totalPages}
            value={jumpValue}
            onChange={(event) => setJumpValue(event.target.value)}
            onBlur={submitJump}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setJumpValue("");
              setJumpOpen(false);
            }}
            autoFocus
            placeholder={String(page + 1)}
            className="w-12 rounded-md border border-osu-b3/60 bg-osu-b5/70 px-1.5 py-0.5 text-center tabular-nums text-white outline-none focus:border-osu-pink/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            aria-label={`Page number, 1 to ${totalPages}`}
          />
          <span>of {totalPages}</span>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setJumpValue("");
            setJumpOpen(true);
          }}
          className="min-w-[132px] rounded-md px-2 py-0.5 text-center tabular-nums transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer"
          title="Jump to a page"
        >
          {total === 0
            ? "No cards"
            : `${pageStart + 1}–${pageEnd} of ${total.toLocaleString("en-US")} cards`}
        </button>
      )}
      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
        disabled={page >= totalPages - 1}
        className={navButton}
        aria-label="Next collection page"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onPageChange(totalPages - 1)}
        disabled={page >= totalPages - 1}
        className={navButton}
        aria-label="Last collection page"
      >
        <ChevronsRight className="h-4 w-4" />
      </button>
    </div>
  );
}

/* Legacy cards (collected before skills snapshots existed) and failed mints
   re-mint themselves when scrolled into view: fetch the player's plays once,
   compute the skills, store them in the wallet. One attempt per session per
   card, two in flight at a time. */
const attemptedBackfills = new Set<string>();
let activeBackfills = 0;
const backfillQueue: Array<() => void> = [];
async function throttleBackfill<T>(task: () => Promise<T>): Promise<T> {
  if (activeBackfills >= 2) await new Promise<void>((resolve) => backfillQueue.push(resolve));
  activeBackfills += 1;
  try {
    return await task();
  } finally {
    activeBackfills -= 1;
    backfillQueue.shift()?.();
  }
}

async function backfillCardMint(
  card: CollectedCard,
  onApplyMint: (cardKey: string, mint: CardMint) => boolean | Promise<boolean>,
) {
  const cardKey = packCardKeyOf(card);
  if (attemptedBackfills.has(cardKey)) return;
  attemptedBackfills.add(cardKey);
  try {
    const scores = await throttleBackfill(() => fetchPackPlayerScores(card.userId));
    const data = buildManiaCardRenderData({
      user: {
        id: card.userId,
        username: card.username,
        avatar_url: card.avatarUrl,
        country_code: card.countryCode,
        statistics: { global_rank: card.globalRank, pp: card.pp },
      },
      scores,
      // A card that already knows what it was minted at keeps that tier: the
      // backfill is here to recover a missing skills snapshot, not to re-tier
      // a card because its player has since joined the honorary roster.
      tierOverride: card.tier ?? undefined,
    });
    if (data.status !== "ready") return;
    await onApplyMint(cardKey, { skills: data.skills, tier: data.tier, tierLabel: data.tierStyle.label });
  } catch {
    // The sketch tile remains; another session can retry.
    attemptedBackfills.delete(cardKey);
  }
}

/* The vivid rgb triplet of a tier's palette (from its badge halo), used to
   tint the filter chips so they read as the tier instead of white pills. */
function tierChipRgb(tier: ManiaCardTier): string {
  const match = MANIA_TIER_STYLES[tier].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}

function CollectionCardTile({
  card,
  thumbnail,
  canBackfill,
  onApplyMint,
  onThumbnailError,
}: {
  card: CollectedCard;
  thumbnail: string | null;
  canBackfill: boolean;
  onApplyMint: (cardKey: string, mint: CardMint) => boolean | Promise<boolean>;
  onThumbnailError: (card: CollectedCard) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousThumbnailRef = useRef<string | null>(thumbnail);
  const animateThumbnail = Boolean(thumbnail && !previousThumbnailRef.current);

  useEffect(() => {
    // Mid-sync the wallet does not yet know whether the repair belongs in
    // localStorage or in the server rows, and a backfill only gets one attempt
    // per card per session — so wait for the answer rather than burn it.
    if (card.skills || !canBackfill) return;
    let cancelled = false;
    const work = () => {
      if (!cancelled) void backfillCardMint(card, onApplyMint);
    };
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver !== "function") {
      work();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void work();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.userId, card.skills, canBackfill]);

  useEffect(() => {
    previousThumbnailRef.current = thumbnail;
  }, [thumbnail]);

  return (
    <div ref={hostRef} className="relative" style={{ aspectRatio: "5 / 7" }}>
      <CollectionCardFacePlaceholder card={card} />
      {thumbnail && (
        <motion.img
          key={thumbnail}
          src={thumbnail}
          alt={`${card.username} maniacard`}
          className="absolute inset-0 h-full w-full rounded-[10px] object-cover"
          initial={animateThumbnail ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={animateThumbnail ? { duration: 0.14, ease: "easeOut" } : { duration: 0 }}
          draggable={false}
          onError={(event) => {
            /* Only a remote pool URL can 404 (local renders are blob/data
               URLs); fall back to rendering this card locally. */
            if (/^https?:/.test(event.currentTarget.src)) onThumbnailError(card);
          }}
        />
      )}
      {card.copies > 1 && (
        <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1 py-px text-[10px] font-bold text-white tabular-nums">
          x{card.copies}
        </span>
      )}
    </div>
  );
}

function CollectionCardFacePlaceholder({ card, tier: forcedTier }: { card?: CollectedCard; tier?: ManiaCardTier | null }) {
  // A null forcedTier is the rarity-less face; only an absent one falls back to
  // the card's own tier.
  const tier = forcedTier !== undefined ? forcedTier : resolveCollectionCardTier(card);
  let thumbnail = skeletonThumbnailCache.get(tier ?? "neutral") ?? null;
  if (!thumbnail) {
    thumbnail = renderCardSkeletonThumbnail(tier, COLLECTION_CARD_THUMB_WIDTH);
    if (thumbnail) skeletonThumbnailCache.set(tier ?? "neutral", thumbnail);
  }
  if (thumbnail) {
    return (
      <img
        src={thumbnail}
        alt=""
        className="h-full w-full rounded-[10px] object-cover"
        draggable={false}
      />
    );
  }

  const style = tier ? MANIA_TIER_STYLES[tier] : null;
  return (
    <div
      className={`relative overflow-hidden rounded-[10px] border bg-gradient-to-br ${
        style ? `${style.background} ${style.border}` : "from-osu-b3 via-osu-b4 to-osu-b5 border-osu-b3/40"
      }`}
      style={{ aspectRatio: "5 / 7" }}
    >
      <div className="absolute inset-0 bg-black/12" />
    </div>
  );
}

function CollectionCardPlaceholder({ tier }: { tier: ManiaCardTier | null }) {
  return (
    <div>
      <div className="relative" style={{ aspectRatio: "5 / 7" }}>
        <CollectionCardFacePlaceholder tier={tier} />
      </div>
      <div className="mx-auto mt-1.5 h-4 w-10 rounded bg-osu-b4/40" />
    </div>
  );
}

export function CollectionPanel({
  wallet,
  showLoginNudge,
  syncStatus,
  onRecycleCard,
  onRecycleWhole,
  onRecycleWholeMany,
  onRecycleWholeMatching,
  onRecycleAll,
  onApplyMint,
}: CollectionPanelProps) {
  const [query, setQuery] = useState("");
  // Searching a synced collection is a server round trip per distinct query, so
  // it waits for a pause in typing instead of firing a request per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<CollectionTierFilter>("all");
  // Safe to read storage in the initializer: the panel renders null until the
  // wallet hydrates, so its first real render is already client-side.
  const [sortMode, setSortMode] = useState<CollectionSortMode>(readStoredCollectionSort);
  // Recycling the last copy removes the card from the collection, so it
  // takes a second tap to confirm.
  const [confirmCardKey, setConfirmCardKey] = useState<string | null>(null);
  // Right-click menu on a card tile; whole-recycle inside it confirms on a
  // second click too.
  const [menu, setMenu] = useState<{ card: CollectedCard; x: number; y: number } | null>(null);
  const [menuConfirm, setMenuConfirm] = useState(false);
  // Clicking a tile lifts the card to center stage instead of navigating;
  // the spotlight offers the profile link.
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  // The lifted card's grid tile stays hidden past close (spotlight becoming
  // null) until the return flight lands back in the slot, so the card never
  // shows twice.
  const [liftedCardId, setLiftedCardId] = useState<number | null>(null);
  // Select mode: tiles toggle instead of navigating, and the floating bar
  // recycles every selected card at once (all copies, second click confirms).
  const [selecting, setSelecting] = useState(false);
  // Keyed by wallet card key, not player: a GOAT and an ordinary card of the
  // same player are two tiles and select, confirm and recycle independently.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionScope, setSelectionScope] = useState<"manual" | "all">("manual");
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [collectionPage, setCollectionPage] = useState(0);
  /* Dev-only skeleton sim. "cards" blanks the thumbnails on real tiles (the
     face fallback while a thumbnail renders); "page" holds the placeholder
     grid a pending page shows, which locally loads too fast to look at. */
  const [skeletonSim, setSkeletonSim] = useState<"off" | "cards" | "page">("off");
  const collectionControlsRef = useRef<HTMLDivElement | null>(null);
  const [, setThumbnailRevision] = useState(0);
  /* A tile's remote thumbnail 404ed (pool URLs carry no existence check, so a
     lifecycle-expired object surfaces here): evict the dead URL so the tile
     shows its placeholder, render the card locally, and let
     rememberCardThumbnailBlob re-upload it for the next viewer. One attempt
     per key per session; a failed render leaves the placeholder. */
  const handleThumbnailError = useCallback((card: CollectedCard) => {
    const key = cardThumbnailKeyForCollectionCard(card);
    if (!key || !claimCardThumbnailErrorFallback(key)) return;
    forgetRemoteCardThumbnail(key);
    setThumbnailRevision((revision) => revision + 1);
    renderCollectionThumbnail(card)
      .then((thumbnail) => {
        if (thumbnail) setThumbnailRevision((revision) => revision + 1);
      })
      .catch(() => {});
  }, []);
  const [serverPage, setServerPage] = useState<LoadedServerCollectionPage | null>(() => {
    const initialRequest = {
      page: 0,
      pageSize: COLLECTION_PAGE_SIZE,
      tier: "all" as const,
      query: "",
      // The stored sort, so a remembered order still hits the page cache on
      // the way back to /packs instead of always missing it.
      sort: readStoredCollectionSort(),
    };
    const cacheKey = serverCollectionCacheKey(initialRequest);
    const page = serverCollectionPageCache.get(cacheKey) ?? null;
    return page
      ? {
          cacheKey,
          filterKey: serverCollectionFilterKey(initialRequest),
          page,
        }
      : null;
  });
  const [serverLoading, setServerLoading] = useState(false);
  const [serverMissingKey, setServerMissingKey] = useState<string | null>(null);
  const [serverRefreshKey, setServerRefreshKey] = useState(0);
  // One-shot "+N" shard floats spawned at the click point of a recycle.
  const [shardBursts, setShardBursts] = useState<Array<{ id: number; x: number; y: number; amount: number }>>([]);
  const burstIdRef = useRef(0);

  /* Quick feedback when a recycle lands: shard clink plus a short "+N"
     float with a few flying slivers, anchored to the clicked control. */
  const celebrateRecycle = (gained: number, anchor: Element | null) => {
    if (gained <= 0) return;
    playRecycleClink(gained);
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const rect = anchor?.getBoundingClientRect();
    if (!rect) return;
    burstIdRef.current += 1;
    const id = burstIdRef.current;
    setShardBursts((current) => [
      ...current.slice(-5),
      { id, x: rect.left + rect.width / 2, y: rect.top, amount: gained },
    ]);
    window.setTimeout(() => {
      setShardBursts((current) => current.filter((burst) => burst.id !== id));
    }, 800);
  };
  const runRecycle = (action: () => number | Promise<number>, anchor: Element | null) => {
    void Promise.resolve(action()).then((gained) => {
      celebrateRecycle(gained, anchor);
      if (gained > 0 && useServerCollection) setServerRefreshKey((key) => key + 1);
    });
  };
  /* A synced collection renders server rows, so a repaired card only shows its
     real face once the page is re-read. Tiles repair one at a time, so the
     re-read is coalesced into a single fetch. */
  const mintRefreshTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (mintRefreshTimerRef.current !== null) window.clearTimeout(mintRefreshTimerRef.current);
  }, []);
  const applyMintAndRefresh = (cardKey: string, mint: CardMint) => {
    const result = onApplyMint(cardKey, mint);
    if (typeof result === "boolean") return result;
    return result.then((applied) => {
      if (applied && mintRefreshTimerRef.current === null) {
        mintRefreshTimerRef.current = window.setTimeout(() => {
          mintRefreshTimerRef.current = null;
          setServerRefreshKey((key) => key + 1);
        }, 1500);
      }
      return applied;
    });
  };
  useEffect(() => {
    if (confirmCardKey === null) return;
    const timer = setTimeout(() => setConfirmCardKey(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmCardKey]);
  useEffect(() => {
    if (!confirmBulk) return;
    const timer = setTimeout(() => setConfirmBulk(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmBulk]);
  useEffect(() => {
    if (!menu && !selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu) {
        setMenu(null);
        return;
      }
      setSelecting(false);
      setSelected(new Set());
      setSelectionScope("manual");
      setConfirmBulk(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, selecting]);

  // The one place the order changes, so remembering it lives here rather than
  // in an effect that would rewrite storage on every mount.
  const applySortMode = (mode: CollectionSortMode) => {
    setSortMode(mode);
    writeStoredCollectionSort(mode);
  };

  const toggleSelected = (cardKey: string) => {
    if (selectionScope === "all") {
      setSelectionScope("manual");
      setSelected(new Set(pageCards.map(packCardKeyOf).filter((key) => key !== cardKey)));
      setConfirmBulk(false);
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(cardKey)) next.delete(cardKey);
      else next.add(cardKey);
      return next;
    });
    setConfirmBulk(false);
  };

  const applySelect = (cardKey: string, on: boolean) => {
    if (selectionScope === "all") {
      const next = new Set(pageCards.map(packCardKeyOf));
      if (on) next.add(cardKey);
      else next.delete(cardKey);
      setSelectionScope("manual");
      setSelected(next);
      setConfirmBulk(false);
      return;
    }
    setSelected((previous) => {
      if (on === previous.has(cardKey)) return previous;
      const next = new Set(previous);
      if (on) next.add(cardKey);
      else next.delete(cardKey);
      return next;
    });
    setConfirmBulk(false);
  };

  const exitSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setSelectionScope("manual");
    setConfirmBulk(false);
  };

  // Mouse drag-select: pressing on a tile picks add-or-remove from that
  // card's state, sweeping extends it. The click that follows the press is
  // suppressed so the first card isn't toggled twice.
  const dragRef = useRef<{ mode: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (!selecting) return;
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current || !(event.target instanceof Element)) return;
      const tile = event.target.closest("[data-card-id]");
      const cardKey = tile?.getAttribute("data-card-id");
      if (cardKey) applySelect(cardKey, dragRef.current.mode);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    // Clicking empty space (anything not marked as part of the selection UI)
    // leaves select mode.
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-select-keep]")) return;
      exitSelecting();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("pointerdown", onDown);
      dragRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting]);

  const walletReady = wallet !== null;
  const useServerCollection = walletReady && syncStatus !== "local";
  // Only the server path pays for a keystroke; a local wallet filters in
  // memory, so it keeps searching as you type.
  const activeQuery = useServerCollection ? debouncedQuery : query;
  const serverRequest = {
    page: collectionPage,
    pageSize: COLLECTION_PAGE_SIZE,
    tier: tierFilter,
    query: activeQuery.trim().toLowerCase(),
    sort: sortMode,
  };
  const serverCacheKey = serverCollectionCacheKey(serverRequest);
  const serverFilterKey = serverCollectionFilterKey(serverRequest);
  const cachedServerPage = useServerCollection ? serverCollectionPageCache.get(serverCacheKey) ?? null : null;
  const activeServerPage = useServerCollection
    ? cachedServerPage ?? (serverPage?.cacheKey === serverCacheKey ? serverPage.page : null)
    : null;
  const serverMetaPage = useServerCollection
    ? activeServerPage ?? (serverPage?.filterKey === serverFilterKey ? serverPage.page : null)
    : null;
  const localCards = wallet
    ? ownedCards(wallet).sort((a, b) =>
        sortMode === "newest"
          ? b.firstPulledAt - a.firstPulledAt || tierRank(b.tier) - tierRank(a.tier) || b.pp - a.pp
          : tierRank(b.tier) - tierRank(a.tier) || b.pp - a.pp,
      )
    : [];
  const cards = useServerCollection ? (activeServerPage?.cards as CollectedCard[] | undefined) ?? [] : localCards;
  // tierCounts describe the whole collection (the server computes them without
  // the tier/query filter), so the last page loaded under any filter still
  // carries them. Keeping them across filter switches stops the rarity chips
  // from flashing and lets the loading skeletons match the real per-rarity counts.
  const serverTierCounts = serverMetaPage?.tierCounts ?? serverPage?.page.tierCounts ?? {};
  // Like tierCounts, pool progress describes the whole collection, so any
  // loaded page's copy is current enough to keep the header from flashing.
  const serverPoolProgress = useServerCollection
    ? serverMetaPage?.poolProgress ?? serverPage?.page.poolProgress ?? null
    : null;
  // The chip this filter lives on disappears when its count reaches zero
  // (recycled away, or the players came back); don't strand the view there.
  useEffect(() => {
    if (tierFilter !== "untracked") return;
    if (!useServerCollection || (serverPoolProgress !== null && serverPoolProgress.retiredOwnedCount === 0)) {
      setTierFilter("all");
    }
  }, [tierFilter, useServerCollection, serverPoolProgress]);
  // The profile showcase: which card keys this collector has pinned. Null
  // until loaded; the pin menu item stays hidden until then. Synced wallets
  // only, since the server validates pins against the server-side collection.
  // Admin-gated for now, while the shelf design is still being judged.
  const canUseShowcase = useAuth().canUseAdminFeatures;
  const [showcaseKeys, setShowcaseKeys] = useState<string[] | null>(null);
  useEffect(() => {
    if (!useServerCollection || !canUseShowcase) {
      setShowcaseKeys(null);
      return;
    }
    let cancelled = false;
    fetchOwnPackShowcase()
      .then((keys) => {
        if (!cancelled && keys) setShowcaseKeys(keys);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [useServerCollection, canUseShowcase]);
  const toggleShowcasePin = (cardKey: string) => {
    const current = showcaseKeys ?? [];
    const next = current.includes(cardKey) ? current.filter((key) => key !== cardKey) : [...current, cardKey];
    void saveOwnPackShowcase({ data: { cardKeys: next } })
      .then((saved) => {
        if (saved) setShowcaseKeys(saved);
      })
      .catch(() => {});
  };
  const serverCollectionTotal = Object.values(serverTierCounts).reduce((sum, count) => sum + count, 0);
  const ownedTiers: Array<ManiaCardTier | null> = useServerCollection
    ? Object.keys(serverTierCounts)
        .map((tier) => (tier === "unrated" ? null : tier as ManiaCardTier))
        .sort((a, b) => tierRank(b) - tierRank(a))
    : [...new Set(localCards.map((card) => card.tier))].sort((a, b) => tierRank(b) - tierRank(a));
  const tierCounts = new Map<ManiaCardTier | "unrated", number>();
  if (useServerCollection) {
    for (const [tier, count] of Object.entries(serverTierCounts)) {
      tierCounts.set(tier === "unrated" ? "unrated" : tier as ManiaCardTier, count);
    }
  } else {
    for (const card of localCards) {
      const key = card.tier ?? "unrated";
      tierCounts.set(key, (tierCounts.get(key) ?? 0) + 1);
    }
  }
  const trimmedQuery = serverRequest.query;
  const visibleCards = useServerCollection ? cards : cards.filter((card) => {
    if (trimmedQuery && !card.username.toLowerCase().includes(trimmedQuery)) return false;
    if (tierFilter === "all") return true;
    if (tierFilter === "unrated") return card.tier === null;
    // Pool membership is server knowledge; the chip never renders locally.
    if (tierFilter === "untracked") return false;
    return card.tier === tierFilter;
  });
  const filteredTotal = useServerCollection ? serverMetaPage?.total ?? 0 : visibleCards.length;
  const collectionTotal = useServerCollection ? serverCollectionTotal : localCards.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / COLLECTION_PAGE_SIZE));
  const currentPage = Math.min(collectionPage, totalPages - 1);
  const pageStart = currentPage * COLLECTION_PAGE_SIZE;
  const pageEnd = Math.min(filteredTotal, pageStart + COLLECTION_PAGE_SIZE);
  const pageCards = useServerCollection ? cards : visibleCards.slice(pageStart, pageEnd);
  const currentPageSignature = pageSignature(pageCards);
  const serverPagePending = useServerCollection && !activeServerPage && serverMissingKey !== serverCacheKey;
  const showPagePlaceholders = serverPagePending || (serverLoading && pageCards.length === 0);
  // On the very first sync nothing has loaded yet, so we don't know the
  // rarities or the size; a search is just as unpredictable. In those cases show
  // a "Loading collection..." line instead of guessing a grid of cards.
  const knownCollectionShape = Object.keys(serverTierCounts).length > 0;
  const showLoadingMessage = showPagePlaceholders && (!knownCollectionShape || Boolean(trimmedQuery));
  const showSkeletonGrid = skeletonSim === "page" || (showPagePlaceholders && !showLoadingMessage);
  // Skeletons mirror what the current filter will return. tierCounts are
  // filter-independent, so a rarity filter (without a search) resolves to
  // exactly that rarity's count rather than a full page of placeholders.
  const expectedFilterTotal =
    filteredTotal > 0
      ? filteredTotal
      : tierFilter === "all"
        ? collectionTotal
        : tierFilter === "untracked"
          ? serverPoolProgress?.retiredOwnedCount ?? 0
          : Math.max(0, Math.floor(Number(serverTierCounts[tierFilter === "unrated" ? "unrated" : tierFilter]) || 0));
  const placeholderCount = Math.max(1, Math.min(COLLECTION_PAGE_SIZE, expectedFilterTotal - pageStart));
  const placeholderTiers: Array<ManiaCardTier | null> = showSkeletonGrid
    ? sortMode === "newest" && tierFilter === "all"
      // Sorted by pull date the page mixes rarities unpredictably, so the
      // skeletons take a rarity-less face rather than claiming a page of
      // commons that the loaded cards then contradict.
      ? Array.from({ length: placeholderCount }, () => null)
      : placeholderTiersForPage({
          count: placeholderCount,
          pageStart,
          tierFilter,
          tierCounts: serverTierCounts,
        })
    : [];
  const recyclable = useServerCollection ? serverMetaPage?.duplicateShardTotal ?? 0 : wallet ? duplicateShardTotal(wallet) : 0;
  const selectedShardTotal = cards
    .filter((card) => selected.has(packCardKeyOf(card)))
    .reduce((sum, card) => sum + wholeCardShardValue(card), 0);
  const filteredShardTotal = useServerCollection
    ? serverMetaPage?.filteredShardTotal ?? 0
    : visibleCards.reduce((sum, card) => sum + wholeCardShardValue(card), 0);
  const selectedCount = selectionScope === "all" ? filteredTotal : selected.size;
  const bulkShardTotal = selectionScope === "all" ? filteredShardTotal : selectedShardTotal;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setCollectionPage(0);
    setSelected(new Set());
    setSelectionScope("manual");
    setConfirmBulk(false);
  }, [trimmedQuery, tierFilter, sortMode]);

  useEffect(() => {
    if (selectionScope !== "all") setSelected(new Set());
    setConfirmBulk(false);
  }, [currentPage, selectionScope]);

  useEffect(() => {
    if (collectionPage <= totalPages - 1) return;
    setCollectionPage(Math.max(0, totalPages - 1));
  }, [collectionPage, totalPages]);

  useEffect(() => {
    if (!walletReady || !useServerCollection) {
      setServerPage(null);
      setServerLoading(false);
      setServerMissingKey(null);
      return;
    }
    let cancelled = false;
    const cachedPage = serverCollectionPageCache.get(serverCacheKey) ?? null;
    setServerMissingKey((key) => (key === serverCacheKey ? null : key));
    if (cachedPage) {
      setServerPage({ cacheKey: serverCacheKey, filterKey: serverFilterKey, page: cachedPage });
    }
    setServerLoading(!cachedPage);
    void fetchServerPackCollectionPage({
      data: {
        page: collectionPage,
        pageSize: COLLECTION_PAGE_SIZE,
        tier: tierFilter,
        query: trimmedQuery,
        sort: sortMode,
      },
    })
      .then((page) => {
        if (cancelled) return;
        if (page) serverCollectionPageCache.set(serverCacheKey, page);
        const nextPage = page ?? cachedPage;
        if (nextPage) setServerPage({ cacheKey: serverCacheKey, filterKey: serverFilterKey, page: nextPage });
        else setServerMissingKey(serverCacheKey);
      })
      .catch(() => {
        if (!cancelled && !cachedPage) {
          setServerMissingKey(serverCacheKey);
          setServerPage((current) => (current?.cacheKey === serverCacheKey ? null : current));
        }
      })
      .finally(() => {
        if (!cancelled) setServerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [walletReady, useServerCollection, collectionPage, tierFilter, trimmedQuery, sortMode, serverCacheKey, serverFilterKey, serverRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    const cardsForPage = pageCards;
    const signature = currentPageSignature;

    if (!signature) {
      return;
    }

    const missing = cardsForPage
      .map((card) => ({ card, key: cardThumbnailKeyForCollectionCard(card) }))
      .filter((entry): entry is { card: CollectedCard; key: string } =>
        Boolean(entry.key && entry.card.skills && !getMemoryCardThumbnail(entry.key)),
      );
    if (missing.length === 0) return;

    const run = async () => {
      const remoteCandidates: Array<{ card: CollectedCard; key: string }> = [];
      await Promise.all(missing.map(async ({ card, key }) => {
        const cached = await loadPersistedCardThumbnail(key);
        if (cancelled) return;
        if (cached) setThumbnailRevision((revision) => revision + 1);
        else remoteCandidates.push({ card, key });
      }));
      if (cancelled || remoteCandidates.length === 0) return;

      const remoteUrls = await loadR2CardThumbnails(remoteCandidates.map((entry) => entry.key));
      if (cancelled) return;
      const toRender = remoteCandidates
        .filter(({ key }) => {
          if (!remoteUrls[key]) return true;
          setThumbnailRevision((revision) => revision + 1);
          return false;
        })
        .map(({ card }) => card);
      if (toRender.length === 0) return;

      await Promise.all(toRender.map(async (card) => {
        try {
          const thumbnail = await renderCollectionThumbnail(card);
          if (cancelled || !thumbnail) return;
          setThumbnailRevision((revision) => revision + 1);
        } catch {
          // The DOM fallback remains for this card.
        }
      }));
    };
    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPageSignature]);

  if (!wallet) return null;

  // Progress is measured against the current draw pool when the server knows
  // it: owned players still in the pool over the pool size, so players who
  // fell off the rankings can no longer push the header past 100%. They show
  // as a separate retired count instead. A local wallet only knows the pool
  // size from its last draw, so it keeps the old ratio, clamped.
  const progressOwned = serverPoolProgress ? serverPoolProgress.poolOwnedCount : collectionTotal;
  const progressPool = serverPoolProgress ? serverPoolProgress.poolTotal : wallet.poolTotal;
  const retiredOwned = serverPoolProgress?.retiredOwnedCount ?? 0;
  const progressPercent =
    progressPool !== null && progressPool > 0 ? Math.min(100, (progressOwned / progressPool) * 100) : null;

  return (
    <section className="mx-auto w-full max-w-[820px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-bold text-white">Collection</h2>
            <span className="text-[12px] text-osu-f1 tabular-nums">
              {progressOwned.toLocaleString()}
              {progressPool ? ` / ${progressPool.toLocaleString()}` : ""} players
            </span>
          </div>
          {progressPercent !== null && collectionTotal > 0 && (
            <div className="mt-1 flex items-center gap-1.5">
              <div className="h-1 w-[140px] overflow-hidden rounded-full bg-osu-b3/40">
                <div
                  className="h-full rounded-full bg-osu-pink/70 transition-[width] duration-500"
                  style={{ width: `${Math.max(1, progressPercent)}%` }}
                />
              </div>
              <span className="text-[10px] text-osu-f1 tabular-nums">
                {progressPercent.toFixed(1)}%
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3" data-select-keep="">
          <span className="flex items-center gap-1.5 text-[12px] text-osu-f1">
            <Recycle className="h-3.5 w-3.5" />
            {/* Keyed on the value so each shard change replays a small pop */}
            <motion.span
              key={wallet.shards}
              className="inline-block font-semibold text-white tabular-nums"
              initial={{ scale: 1.25 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              {wallet.shards.toLocaleString()}
            </motion.span>
            shards
          </span>
          {recyclable > 0 && !selecting && (
            <button
              type="button"
              onClick={(event) => runRecycle(() => onRecycleAll(), event.currentTarget)}
              className="rounded-lg border border-osu-pink/30 bg-osu-pink/10 px-2.5 py-1 text-[11px] font-semibold text-osu-pink-light transition-colors hover:border-osu-pink/50 hover:bg-osu-pink/20 hover:text-white cursor-pointer"
            >
              Recycle duplicates +{recyclable}
            </button>
          )}
          {collectionTotal > 0 && (
            <button
              type="button"
              onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                selecting
                  ? "border-osu-pink/50 bg-osu-pink/15 text-white"
                  : "border-osu-b3/40 bg-osu-b4/40 text-osu-f1 hover:bg-osu-b4/70 hover:text-white"
              }`}
              aria-pressed={selecting}
            >
              {selecting ? "Done" : "Select"}
            </button>
          )}
        </div>
      </div>

      {showLoginNudge ? (
        <div className="mt-2 text-[11px] text-osu-f1">
          Saved in this browser only.{" "}
          <a
            href={`/api/auth/osu?next=${encodeURIComponent("/packs")}`}
            className="inline-flex items-center gap-1 font-semibold text-osu-pink-light hover:text-white hover:underline underline-offset-2"
          >
            <LogIn className="h-3 w-3" />
            Log in with osu!
          </a>{" "}
          to sync your collection across devices.
        </div>
      ) : syncStatus !== "local" ? (
        <div className="mt-2 text-[11px] text-osu-f1">
          {syncStatus === "synced" ? "Synced to your osu! account." : "Syncing to your osu! account..."}
        </div>
      ) : null}

      {collectionTotal > 0 && (
        <>
        <div
          ref={collectionControlsRef}
          className="mt-4 flex scroll-mt-[76px] flex-wrap items-center gap-x-3 gap-y-2"
          data-select-keep=""
        >
          <div className="relative w-[220px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="find a card..."
              className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/40 py-1.5 pl-8 pr-3 text-[12px] text-white placeholder:text-osu-f1/70 outline-none transition-colors focus:border-osu-pink/40"
            />
          </div>
          {ownedTiers.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(["all", ...ownedTiers] as Array<ManiaCardTier | "all" | null>).map((tier) => {
                const value = tier === null ? "unrated" : tier;
                const selected = tierFilter === value;
                const label = tier === "all" ? "All" : tier === null ? "Unrated" : MANIA_TIER_STYLES[tier].label;
                const count = tier === "all" ? collectionTotal : tierCounts.get(tier ?? "unrated") ?? 0;
                const rgb = tier === "all" || tier === null ? null : tierChipRgb(tier);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTierFilter(selected ? "all" : (value as CollectionTierFilter))}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-[filter] cursor-pointer ${
                      rgb
                        ? selected
                          ? ""
                          : "hover:brightness-125"
                        : selected
                          ? "border-osu-pink/50 bg-osu-b4 text-white"
                          : "border-osu-b3/30 bg-osu-b4/30 text-osu-f1 hover:bg-osu-b4/70"
                    }`}
                    style={
                      rgb
                        ? {
                            color: `rgb(${rgb})`,
                            borderColor: `rgba(${rgb}, ${selected ? 0.65 : 0.22})`,
                            backgroundColor: `rgba(${rgb}, ${selected ? 0.14 : 0.05})`,
                          }
                        : undefined
                    }
                    aria-pressed={selected}
                  >
                    {label}
                    {/* GOAT is a fixed, finite set, so the count reads as
                        progress against the roster rather than a bare total. */}
                    <span className="font-semibold tabular-nums opacity-65">
                      {tier === "goat" ? `${count}/${HONORARY_PLAYERS.length}` : count}
                    </span>
                  </button>
                );
              })}
              {useServerCollection && retiredOwned > 0 && (
                <button
                  type="button"
                  onClick={() => setTierFilter(tierFilter === "untracked" ? "all" : "untracked")}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-[filter] cursor-pointer ${
                    tierFilter === "untracked"
                      ? "border-osu-pink/50 bg-osu-b4 text-white"
                      : "border-osu-b3/30 bg-osu-b4/30 text-osu-f1 hover:bg-osu-b4/70"
                  }`}
                  title="Players you own whose card left the draw pool: out of every tracked top 100 and not opted in. They rejoin the pool, and the completion count, if they come back."
                  aria-pressed={tierFilter === "untracked"}
                >
                  Not tracked
                  <span className="font-semibold tabular-nums opacity-65">{retiredOwned}</span>
                </button>
              )}
            </div>
          )}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() =>
                setSkeletonSim((mode) => (mode === "off" ? "cards" : mode === "cards" ? "page" : "off"))
              }
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                skeletonSim !== "off"
                  ? "border-osu-pink/50 bg-osu-pink/15 text-white"
                  : "border-osu-b3/40 bg-osu-b4/40 text-osu-f1 hover:bg-osu-b4/70 hover:text-white"
              }`}
              aria-pressed={skeletonSim !== "off"}
              title="Dev only: cycle card skeletons, then the pending-page grid"
            >
              <ImageOff className="h-3.5 w-3.5" />
              {skeletonSim === "off" ? "Skeletons" : skeletonSim === "cards" ? "Skeletons: cards" : "Skeletons: page"}
            </button>
          )}
        </div>

        {/* Ordering and paging, kept off the chip row above: chips change what
            is in the set, these change how it is presented. Plain text rather
            than pills, like the /maps and /skins listings, so a sort never
            reads as one more filter. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-5 gap-y-2" data-select-keep="">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Sort by</span>
            {COLLECTION_SORTS.map((option) => {
              const isActive = sortMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => applySortMode(option.id)}
                  aria-pressed={isActive}
                  title={option.hint}
                  className={`text-[12.5px] font-semibold transition-colors cursor-pointer ${
                    isActive ? "text-white" : "text-osu-f1 hover:text-osu-pink-light"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {totalPages > 1 && (
            <CollectionPager
              page={currentPage}
              totalPages={totalPages}
              pageStart={pageStart}
              pageEnd={pageEnd}
              total={filteredTotal}
              onPageChange={setCollectionPage}
            />
          )}
        </div>
        </>
      )}

      {collectionTotal === 0 && !serverLoading && !serverPagePending ? (
        <div className="mt-6 rounded-xl border border-osu-b3/40 bg-osu-b4/40 px-6 py-8 text-center text-[12px] text-osu-f1">
          No cards yet. Open a pack to start your collection.
        </div>
      ) : showLoadingMessage ? (
        <div className="mt-4 flex min-h-[240px] items-center justify-center gap-2 rounded-xl border border-osu-b3/40 bg-osu-b4/40 text-[12px] text-osu-f1">
          <Loader2 className="h-4 w-4 animate-spin text-osu-pink" />
          Loading collection...
        </div>
      ) : filteredTotal === 0 && !serverLoading && !serverPagePending ? (
        <div className="mt-6 rounded-xl border border-osu-b3/40 bg-osu-b4/40 px-6 py-8 text-center text-[12px] text-osu-f1">
          {/* Quotes the query the results actually came from, not what is in
              the box right now, so the count and the text agree while a
              debounced search is still settling. */}
          No cards match{trimmedQuery ? ` "${activeQuery.trim()}"` : " the selected rarity"}.
        </div>
      ) : (
        <div className={`mt-4 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 ${selecting ? "select-none" : ""}`}>
          {showSkeletonGrid
            ? placeholderTiers.map((tier, index) => <CollectionCardPlaceholder key={`placeholder-${index}`} tier={tier} />)
            : pageCards.map((card) => {
            const cardKey = packCardKeyOf(card);
            const dupValue = duplicateShardValue(card);
            const lastCopyValue = shardValueForTier(card.tier);
            const confirming = confirmCardKey === cardKey;
            const thumbnail = skeletonSim === "cards" ? null : getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card));
            const cardSelected = selectionScope === "all" || selected.has(cardKey);
            return (
              <div
                key={cardKey}
                data-card-id={cardKey}
                data-select-keep=""
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenuConfirm(false);
                  setMenu({
                    card,
                    x: Math.min(event.clientX, window.innerWidth - 208),
                    y: Math.min(event.clientY, window.innerHeight - 176),
                  });
                }}
              >
                {selecting ? (
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      if (event.pointerType !== "mouse") {
                        suppressClickRef.current = false;
                        return;
                      }
                      if (event.button !== 0) return;
                      // Native drag/text selection would hijack the sweep.
                      event.preventDefault();
                      suppressClickRef.current = true;
                      dragRef.current = { mode: !cardSelected };
                      applySelect(cardKey, dragRef.current.mode);
                    }}
                    onClick={() => {
                      // Touch taps and keyboard activation; mouse was already
                      // handled on pointer down.
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      toggleSelected(cardKey);
                    }}
                    className="relative block w-full cursor-pointer"
                    aria-pressed={cardSelected}
                    aria-label={`${cardSelected ? "Deselect" : "Select"} ${card.username}`}
                  >
                    <CollectionCardTile card={card} thumbnail={thumbnail} canBackfill={syncStatus !== "syncing"} onApplyMint={applyMintAndRefresh} onThumbnailError={handleThumbnailError} />
                    <span
                      className={`pointer-events-none absolute inset-0 rounded-[10px] ${
                        cardSelected ? "ring-2 ring-osu-pink" : "bg-black/45"
                      }`}
                    />
                    {cardSelected && (
                      <span className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-osu-pink text-white">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setSpotlight({
                        card,
                        thumbnail,
                        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                      });
                      setLiftedCardId(card.userId);
                    }}
                    className="block w-full transition-transform duration-150 hover:-translate-y-1 cursor-pointer"
                    style={liftedCardId === card.userId ? { visibility: "hidden" } : undefined}
                    aria-label={`View ${card.username}'s card`}
                  >
                    <CollectionCardTile card={card} thumbnail={thumbnail} canBackfill={syncStatus !== "syncing"} onApplyMint={applyMintAndRefresh} onThumbnailError={handleThumbnailError} />
                  </button>
                )}
                {selecting ? null : card.copies > 1 ? (
                  <button
                    type="button"
                    onClick={(event) => runRecycle(() => onRecycleCard(cardKey), event.currentTarget)}
                    className="mx-auto mt-1.5 flex items-center gap-1 text-[10px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
                    title={`Recycle ${card.copies - 1} duplicate ${card.copies - 1 === 1 ? "copy" : "copies"}`}
                  >
                    <Recycle className="h-3 w-3" />
                    +{dupValue}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      if (!confirming) {
                        setConfirmCardKey(cardKey);
                        return;
                      }
                      setConfirmCardKey(null);
                      runRecycle(() => onRecycleWhole(cardKey), event.currentTarget);
                    }}
                    className={`mx-auto mt-1.5 flex items-center gap-1 text-[10px] transition-colors cursor-pointer ${
                      confirming ? "font-bold text-osu-pink-light" : "text-osu-f1/70 hover:text-white"
                    }`}
                    title="Recycle this card (removes it from your collection)"
                  >
                    <Recycle className="h-3 w-3" />
                    {confirming ? `sure? +${lastCopyValue}` : `+${lastCopyValue}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {totalPages > 1 && filteredTotal > 0 && (
        <div className="mt-5 flex justify-center" data-select-keep="">
          <CollectionPager
            page={currentPage}
            totalPages={totalPages}
            pageStart={pageStart}
            pageEnd={pageEnd}
            total={filteredTotal}
            onPageChange={(page) => {
              setCollectionPage(page);
              collectionControlsRef.current?.scrollIntoView({ block: "start" });
            }}
          />
        </div>
      )}

      {selecting && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <div
            className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-full border border-osu-b3/50 bg-osu-b5 px-5 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
            data-select-keep=""
          >
            <span className="text-[12px] text-osu-f1 tabular-nums">
              <span className="font-bold text-white">{selectedCount}</span> selected
            </span>
            <button
              type="button"
              onClick={() => {
                setSelectionScope("manual");
                setSelected(new Set(pageCards.map(packCardKeyOf)));
                setConfirmBulk(false);
              }}
              className="text-[12px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
            >
              select page
            </button>
            {filteredTotal > pageCards.length && (
              <button
                type="button"
                onClick={() => {
                  setSelectionScope("all");
                  setSelected(new Set());
                  setConfirmBulk(false);
                }}
                className={`text-[12px] transition-colors cursor-pointer ${
                  selectionScope === "all" ? "font-bold text-white" : "text-osu-f1 hover:text-white"
                }`}
              >
                select all
              </button>
            )}
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelected(new Set());
                  setSelectionScope("manual");
                  setConfirmBulk(false);
                }}
                className="text-[12px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
              >
                clear
              </button>
            )}
            <button
              type="button"
              disabled={selectedCount === 0 || bulkBusy}
              onClick={(event) => {
                if (!confirmBulk) {
                  setConfirmBulk(true);
                  return;
                }
                const anchor = event.currentTarget;
                setBulkBusy(true);
                void (async () => {
                  try {
                    const gained = selectionScope === "all"
                      ? await onRecycleWholeMatching({ tier: tierFilter, query: trimmedQuery })
                      : await onRecycleWholeMany(Array.from(selected));
                    celebrateRecycle(gained, anchor);
                    if (gained > 0 && useServerCollection) setServerRefreshKey((key) => key + 1);
                    exitSelecting();
                  } finally {
                    setBulkBusy(false);
                  }
                })();
              }}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-bold text-white transition cursor-pointer disabled:cursor-default disabled:opacity-40 ${
                confirmBulk ? "bg-osu-pink brightness-110" : "bg-osu-pink hover:brightness-110"
              }`}
            >
              <Recycle className={`h-3.5 w-3.5 ${bulkBusy ? "animate-spin" : ""}`} />
              {bulkBusy
                ? "Recycling..."
                : confirmBulk
                  ? `Sure? ${selectedCount} ${selectedCount === 1 ? "card leaves" : "cards leave"} the collection`
                  : `Recycle +${bulkShardTotal}`}
            </button>
          </div>
        </div>
      )}

      {shardBursts.map((burst) => (
        <div
          key={burst.id}
          className="pointer-events-none fixed z-50"
          style={{ left: burst.x, top: burst.y }}
          aria-hidden="true"
        >
          <motion.div
            className="flex -translate-x-1/2 items-center gap-1 text-[12px] font-bold text-osu-pink-light"
            style={{ textShadow: "0 1px 6px rgba(0,0,0,0.7)" }}
            initial={{ y: 2, opacity: 0, scale: 0.7 }}
            animate={{ y: -26, opacity: [0, 1, 1, 0], scale: 1 }}
            transition={{ duration: 0.65, ease: "easeOut" }}
          >
            <Recycle className="h-3.5 w-3.5" />
            +{burst.amount}
          </motion.div>
          {[-1, 0, 1].map((spread) => (
            <motion.span
              key={spread}
              className="absolute left-0 top-0 h-1.5 w-1.5 rounded-full bg-osu-pink"
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{ x: spread * 22, y: -34 - Math.abs(spread) * 8, opacity: 0, scale: 0.4 }}
              transition={{ duration: 0.55, ease: "easeOut" }}
            />
          ))}
        </div>
      ))}

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            data-select-keep=""
            onPointerDown={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-50 w-[200px] rounded-lg border border-osu-b3/50 bg-osu-b5 py-1 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
            data-select-keep=""
          >
            <div className="flex items-center gap-2 px-3 py-1.5">
              <img src={menu.card.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" draggable={false} />
              <span className="truncate text-[12px] font-bold text-white">{menu.card.username}</span>
            </div>
            <div className="mx-2 my-1 h-px bg-osu-b3/40" />
            <Link
              to="/player/$username"
              params={{ username: menu.card.username }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white"
              role="menuitem"
              onClick={() => setMenu(null)}
            >
              Open profile
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSelecting(true);
                setSelected(new Set([packCardKeyOf(menu.card)]));
                setConfirmBulk(false);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer"
            >
              <Check className="h-3 w-3" />
              Select cards...
            </button>
            {showcaseKeys !== null && (() => {
              const cardKey = packCardKeyOf(menu.card);
              const pinned = showcaseKeys.includes(cardKey);
              const full = !pinned && showcaseKeys.length >= PACK_SHOWCASE_MAX_CARDS;
              return (
                <button
                  type="button"
                  role="menuitem"
                  disabled={full}
                  onClick={() => {
                    toggleShowcasePin(cardKey);
                    setMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer disabled:cursor-default disabled:opacity-40"
                >
                  <Star className={`h-3 w-3 ${pinned ? "fill-current" : ""}`} />
                  {pinned
                    ? "Unpin from profile showcase"
                    : full
                      ? `Showcase is full (${PACK_SHOWCASE_MAX_CARDS})`
                      : "Pin to profile showcase"}
                </button>
              );
            })()}
            {menu.card.copies > 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  runRecycle(() => onRecycleCard(packCardKeyOf(menu.card)), event.currentTarget);
                  setMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer"
              >
                <Recycle className="h-3 w-3" />
                Recycle duplicates +{duplicateShardValue(menu.card)}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={(event) => {
                if (!menuConfirm) {
                  setMenuConfirm(true);
                  return;
                }
                runRecycle(() => onRecycleWhole(packCardKeyOf(menu.card)), event.currentTarget);
                setMenu(null);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-osu-b4/60 cursor-pointer ${
                menuConfirm ? "font-bold text-osu-pink-light" : "text-osu-f1 hover:text-white"
              }`}
            >
              <Recycle className="h-3 w-3" />
              {menuConfirm
                ? "Sure? The card leaves the collection"
                : `${menu.card.copies > 1 ? "Recycle all copies" : "Recycle card"} +${
                    wholeCardShardValue(menu.card)
                  }`}
            </button>
          </div>
        </>
      )}

      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedCardId(null)}
      />
    </section>
  );
}
