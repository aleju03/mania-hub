import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ImageOff, Loader2, LogIn, Recycle, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getManiaCardTier, MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "#/lib/maniacard";
import {
  duplicateShardTotal,
  duplicateShardValue,
  ownedCards,
  shardValueForTier,
  tierRank,
  type CollectedCard,
  type PackWallet,
} from "#/lib/pack-collection";
import { fetchServerPackCollectionPage, type ServerPackCollectionPage } from "#/lib/pack-wallet-sync";
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
  COLLECTION_CARD_THUMB_WIDTH,
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

interface CollectionPanelProps {
  wallet: PackWallet | null;
  showLoginNudge: boolean;
  syncStatus: "local" | "syncing" | "synced";
  /* Recycle callbacks return the shards gained so the panel can play the
     clink and spawn the "+N" burst at the click point. */
  onRecycleCard: (userId: number) => number | Promise<number>;
  onRecycleWhole: (userId: number) => number | Promise<number>;
  onRecycleWholeMany: (userIds: number[]) => number | Promise<number>;
  onRecycleWholeMatching: (filter: { tier: ManiaCardTier | "all" | "unrated"; query: string }) => number | Promise<number>;
  onRecycleAll: () => number | Promise<number>;
  onApplyMint: (userId: number, mint: CardMint) => boolean;
}

interface LoadedServerCollectionPage {
  cacheKey: string;
  filterKey: string;
  page: ServerPackCollectionPage;
}

const COLLECTION_PAGE_SIZE = 15;
const skeletonThumbnailCache = new Map<ManiaCardTier, string>();
const serverCollectionPageCache = new Map<string, ServerPackCollectionPage>();
const COLLECTION_TIER_ORDER: ManiaCardTier[] = [
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
    renderQueue.shift()?.();
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
  });
  const key = cardThumbnailKeyForData(data, COLLECTION_CARD_THUMB_WIDTH);
  const blob = await throttleRender(() => renderCardThumbnailBlob(data, COLLECTION_CARD_THUMB_WIDTH));
  return { key, url: await rememberCardThumbnailBlob(key, blob) };
}

function pageSignature(cards: CollectedCard[]) {
  return cards.map(thumbnailKey).join("|");
}

function resolveCollectionCardTier(card?: CollectedCard): ManiaCardTier {
  if (card?.tier) return card.tier;
  if (card?.skills && Number.isFinite(card.skills.cardPower)) {
    return getManiaCardTier(card.skills.cardPower);
  }
  return "common";
}

function placeholderTiersForPage({
  count,
  pageStart,
  tierFilter,
  tierCounts,
}: {
  count: number;
  pageStart: number;
  tierFilter: ManiaCardTier | "all" | "unrated";
  tierCounts: Record<string, number>;
}): ManiaCardTier[] {
  if (tierFilter !== "all") {
    const tier = tierFilter === "unrated" ? "common" : tierFilter;
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
}: {
  page: number;
  pageSize: number;
  tier: ManiaCardTier | "all" | "unrated";
  query: string;
}) {
  return `${page}:${pageSize}:${tier}:${query}`;
}

function serverCollectionFilterKey({
  pageSize,
  tier,
  query,
}: {
  pageSize: number;
  tier: ManiaCardTier | "all" | "unrated";
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
          className="flex min-w-[118px] items-center justify-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            submitJump();
          }}
        >
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
          />
          <span>/ {totalPages}</span>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setJumpValue("");
            setJumpOpen(true);
          }}
          className="min-w-[118px] rounded-md px-2 py-0.5 text-center tabular-nums transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer"
          title="Jump to a page"
        >
          {total === 0 ? "0" : `${pageStart + 1}-${pageEnd}`} / {total}
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
const attemptedBackfills = new Set<number>();
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

async function backfillCardMint(card: CollectedCard, onApplyMint: (userId: number, mint: CardMint) => boolean) {
  if (attemptedBackfills.has(card.userId)) return;
  attemptedBackfills.add(card.userId);
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
    });
    if (data.status !== "ready") return;
    onApplyMint(card.userId, { skills: data.skills, tier: data.tier, tierLabel: data.tierStyle.label });
  } catch {
    // The sketch tile remains; another session can retry.
    attemptedBackfills.delete(card.userId);
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
  onApplyMint,
}: {
  card: CollectedCard;
  thumbnail: string | null;
  onApplyMint: (userId: number, mint: CardMint) => boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousThumbnailRef = useRef<string | null>(thumbnail);
  const animateThumbnail = Boolean(thumbnail && !previousThumbnailRef.current);

  useEffect(() => {
    if (card.skills) return;
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
  }, [card.userId, card.skills]);

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

function CollectionCardFacePlaceholder({ card, tier: forcedTier }: { card?: CollectedCard; tier?: ManiaCardTier }) {
  const tier = forcedTier ?? resolveCollectionCardTier(card);
  let thumbnail = skeletonThumbnailCache.get(tier) ?? null;
  if (!thumbnail) {
    thumbnail = renderCardSkeletonThumbnail(tier, COLLECTION_CARD_THUMB_WIDTH);
    if (thumbnail) skeletonThumbnailCache.set(tier, thumbnail);
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

  const style = MANIA_TIER_STYLES[tier];
  return (
    <div
      className={`relative overflow-hidden rounded-[10px] border bg-gradient-to-br ${style.background} ${style.border}`}
      style={{ aspectRatio: "5 / 7" }}
    >
      <div className="absolute inset-0 bg-black/12" />
    </div>
  );
}

function CollectionCardPlaceholder({ tier }: { tier: ManiaCardTier }) {
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
  const [tierFilter, setTierFilter] = useState<ManiaCardTier | "all" | "unrated">("all");
  // Recycling the last copy removes the card from the collection, so it
  // takes a second tap to confirm.
  const [confirmUserId, setConfirmUserId] = useState<number | null>(null);
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionScope, setSelectionScope] = useState<"manual" | "all">("manual");
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [collectionPage, setCollectionPage] = useState(0);
  const [simulateSkeletons, setSimulateSkeletons] = useState(false);
  const collectionControlsRef = useRef<HTMLDivElement | null>(null);
  const [, setThumbnailRevision] = useState(0);
  const [serverPage, setServerPage] = useState<LoadedServerCollectionPage | null>(() => {
    const initialRequest = {
      page: 0,
      pageSize: COLLECTION_PAGE_SIZE,
      tier: "all" as const,
      query: "",
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
  useEffect(() => {
    if (confirmUserId === null) return;
    const timer = setTimeout(() => setConfirmUserId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmUserId]);
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

  const toggleSelected = (userId: number) => {
    if (selectionScope === "all") {
      setSelectionScope("manual");
      setSelected(new Set(pageCards.filter((card) => card.userId !== userId).map((card) => card.userId)));
      setConfirmBulk(false);
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
    setConfirmBulk(false);
  };

  const applySelect = (userId: number, on: boolean) => {
    if (selectionScope === "all") {
      const next = new Set(pageCards.map((card) => card.userId));
      if (on) next.add(userId);
      else next.delete(userId);
      setSelectionScope("manual");
      setSelected(next);
      setConfirmBulk(false);
      return;
    }
    setSelected((previous) => {
      if (on === previous.has(userId)) return previous;
      const next = new Set(previous);
      if (on) next.add(userId);
      else next.delete(userId);
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
      const userId = tile ? Number(tile.getAttribute("data-card-id")) : Number.NaN;
      if (Number.isFinite(userId)) applySelect(userId, dragRef.current.mode);
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
    ? ownedCards(wallet).sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.pp - a.pp)
    : [];
  const cards = useServerCollection ? (activeServerPage?.cards as CollectedCard[] | undefined) ?? [] : localCards;
  // tierCounts describe the whole collection (the server computes them without
  // the tier/query filter), so the last page loaded under any filter still
  // carries them. Keeping them across filter switches stops the rarity chips
  // from flashing and lets the loading skeletons match the real per-rarity counts.
  const serverTierCounts = serverMetaPage?.tierCounts ?? serverPage?.page.tierCounts ?? {};
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
  const showSkeletonGrid = showPagePlaceholders && !showLoadingMessage;
  // Skeletons mirror what the current filter will return. tierCounts are
  // filter-independent, so a rarity filter (without a search) resolves to
  // exactly that rarity's count rather than a full page of placeholders.
  const expectedFilterTotal =
    filteredTotal > 0
      ? filteredTotal
      : tierFilter === "all"
        ? collectionTotal
        : Math.max(0, Math.floor(Number(serverTierCounts[tierFilter === "unrated" ? "unrated" : tierFilter]) || 0));
  const placeholderCount = Math.max(1, Math.min(COLLECTION_PAGE_SIZE, expectedFilterTotal - pageStart));
  const placeholderTiers = showSkeletonGrid
    ? placeholderTiersForPage({
        count: placeholderCount,
        pageStart,
        tierFilter,
        tierCounts: serverTierCounts,
      })
    : [];
  const recyclable = useServerCollection ? serverMetaPage?.duplicateShardTotal ?? 0 : wallet ? duplicateShardTotal(wallet) : 0;
  const selectedShardTotal = cards
    .filter((card) => selected.has(card.userId))
    .reduce((sum, card) => sum + duplicateShardValue(card) + shardValueForTier(card.tier), 0);
  const filteredShardTotal = useServerCollection
    ? serverMetaPage?.filteredShardTotal ?? 0
    : visibleCards.reduce((sum, card) => sum + card.copies * shardValueForTier(card.tier), 0);
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
  }, [trimmedQuery, tierFilter]);

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
  }, [walletReady, useServerCollection, collectionPage, tierFilter, trimmedQuery, serverCacheKey, serverFilterKey, serverRefreshKey]);

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

  return (
    <section className="mx-auto w-full max-w-[820px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-bold text-white">Collection</h2>
            <span className="text-[12px] text-osu-f1 tabular-nums">
              {collectionTotal}
              {wallet.poolTotal ? ` / ${wallet.poolTotal.toLocaleString()}` : ""} players
            </span>
          </div>
          {wallet.poolTotal !== null && wallet.poolTotal > 0 && collectionTotal > 0 && (
            <div className="mt-1 flex items-center gap-1.5">
              <div className="h-1 w-[140px] overflow-hidden rounded-full bg-osu-b3/40">
                <div
                  className="h-full rounded-full bg-osu-pink/70 transition-[width] duration-500"
                  style={{ width: `${Math.max(1, Math.min(100, (collectionTotal / wallet.poolTotal) * 100))}%` }}
                />
              </div>
              <span className="text-[10px] text-osu-f1 tabular-nums">
                {((collectionTotal / wallet.poolTotal) * 100).toFixed(1)}%
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
                    onClick={() => setTierFilter(selected ? "all" : (value as ManiaCardTier | "all" | "unrated"))}
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
                    <span className="font-semibold tabular-nums opacity-65">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
          {totalPages > 1 && (
            <div className="ml-auto">
              <CollectionPager
                page={currentPage}
                totalPages={totalPages}
                pageStart={pageStart}
                pageEnd={pageEnd}
                total={filteredTotal}
                onPageChange={setCollectionPage}
              />
            </div>
          )}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => setSimulateSkeletons((active) => !active)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                simulateSkeletons
                  ? "border-osu-pink/50 bg-osu-pink/15 text-white"
                  : "border-osu-b3/40 bg-osu-b4/40 text-osu-f1 hover:bg-osu-b4/70 hover:text-white"
              }`}
              aria-pressed={simulateSkeletons}
              title="Dev only: show collection card skeletons"
            >
              <ImageOff className="h-3.5 w-3.5" />
              Skeletons
            </button>
          )}
        </div>
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
            const dupValue = duplicateShardValue(card);
            const lastCopyValue = shardValueForTier(card.tier);
            const confirming = confirmUserId === card.userId;
            const thumbnail = simulateSkeletons ? null : getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card));
            const cardSelected = selectionScope === "all" || selected.has(card.userId);
            return (
              <div
                key={card.userId}
                data-card-id={card.userId}
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
                      applySelect(card.userId, dragRef.current.mode);
                    }}
                    onClick={() => {
                      // Touch taps and keyboard activation; mouse was already
                      // handled on pointer down.
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      toggleSelected(card.userId);
                    }}
                    className="relative block w-full cursor-pointer"
                    aria-pressed={cardSelected}
                    aria-label={`${cardSelected ? "Deselect" : "Select"} ${card.username}`}
                  >
                    <CollectionCardTile card={card} thumbnail={thumbnail} onApplyMint={onApplyMint} />
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
                    <CollectionCardTile card={card} thumbnail={thumbnail} onApplyMint={onApplyMint} />
                  </button>
                )}
                {selecting ? null : card.copies > 1 ? (
                  <button
                    type="button"
                    onClick={(event) => runRecycle(() => onRecycleCard(card.userId), event.currentTarget)}
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
                        setConfirmUserId(card.userId);
                        return;
                      }
                      setConfirmUserId(null);
                      runRecycle(() => onRecycleWhole(card.userId), event.currentTarget);
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
                setSelected(new Set(pageCards.map((card) => card.userId)));
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
                setSelected(new Set([menu.card.userId]));
                setConfirmBulk(false);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer"
            >
              <Check className="h-3 w-3" />
              Select cards...
            </button>
            {menu.card.copies > 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  runRecycle(() => onRecycleCard(menu.card.userId), event.currentTarget);
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
                runRecycle(() => onRecycleWhole(menu.card.userId), event.currentTarget);
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
                    duplicateShardValue(menu.card) + shardValueForTier(menu.card.tier)
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
