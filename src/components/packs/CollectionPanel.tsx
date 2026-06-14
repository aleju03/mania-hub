import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ImageOff, LogIn, Recycle, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "#/lib/maniacard";
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
import { renderCardSkeletonThumbnail, renderCardThumbnailBlob } from "./cardSnapshot";
import {
  cardThumbnailKeyForCollectionCard,
  cardThumbnailKeyForData,
  COLLECTION_CARD_THUMB_WIDTH,
  getMemoryCardThumbnail,
  loadPersistedCardThumbnail,
  loadR2CardThumbnail,
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
  onRecycleAll: () => number | Promise<number>;
  onApplyMint: (userId: number, mint: CardMint) => boolean;
}

const COLLECTION_PAGE_SIZE = 15;
const skeletonThumbnailCache = new Map<ManiaCardTier, string>();
const serverCollectionPageCache = new Map<string, ServerPackCollectionPage>();

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

  return (
    <div ref={hostRef} className="relative" style={{ aspectRatio: "5 / 7" }}>
      <CollectionCardFacePlaceholder card={card} />
      {thumbnail && (
        <motion.img
          key={thumbnail}
          src={thumbnail}
          alt={`${card.username} maniacard`}
          className="absolute inset-0 h-full w-full rounded-[10px] object-cover"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
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

function CollectionCardFacePlaceholder({ card }: { card?: CollectedCard }) {
  const tier = card?.tier ?? "common";
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

function CollectionCardPlaceholder() {
  return (
    <div>
      <CollectionCardFacePlaceholder />
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
  onRecycleAll,
  onApplyMint,
}: CollectionPanelProps) {
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<ManiaCardTier | "all" | "unrated">("all");
  // Recycling the last copy removes the card from the collection, so it
  // takes a second tap to confirm.
  const [confirmUserId, setConfirmUserId] = useState<number | null>(null);
  // Right-click menu on a card tile; whole-recycle inside it confirms on a
  // second click too.
  const [menu, setMenu] = useState<{ card: CollectedCard; x: number; y: number } | null>(null);
  const [menuConfirm, setMenuConfirm] = useState(false);
  // Select mode: tiles toggle instead of navigating, and the floating bar
  // recycles every selected card at once (all copies, second click confirms).
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [collectionPage, setCollectionPage] = useState(0);
  const [simulateSkeletons, setSimulateSkeletons] = useState(false);
  const collectionControlsRef = useRef<HTMLDivElement | null>(null);
  const [, setThumbnailRevision] = useState(0);
  const [serverPage, setServerPage] = useState<ServerPackCollectionPage | null>(() =>
    serverCollectionPageCache.get(serverCollectionCacheKey({
      page: 0,
      pageSize: COLLECTION_PAGE_SIZE,
      tier: "all",
      query: "",
    })) ?? null,
  );
  const [serverLoading, setServerLoading] = useState(false);
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
      setConfirmBulk(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, selecting]);

  const toggleSelected = (userId: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
    setConfirmBulk(false);
  };

  const applySelect = (userId: number, on: boolean) => {
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
  const localCards = wallet
    ? ownedCards(wallet).sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.pp - a.pp)
    : [];
  const cards = useServerCollection ? (serverPage?.cards as CollectedCard[] | undefined) ?? [] : localCards;
  const serverTierCounts = serverPage?.tierCounts ?? {};
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
  const trimmedQuery = query.trim().toLowerCase();
  const visibleCards = useServerCollection ? cards : cards.filter((card) => {
    if (trimmedQuery && !card.username.toLowerCase().includes(trimmedQuery)) return false;
    if (tierFilter === "all") return true;
    if (tierFilter === "unrated") return card.tier === null;
    return card.tier === tierFilter;
  });
  const filteredTotal = useServerCollection ? serverPage?.total ?? 0 : visibleCards.length;
  const collectionTotal = useServerCollection ? serverCollectionTotal : localCards.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / COLLECTION_PAGE_SIZE));
  const currentPage = Math.min(collectionPage, totalPages - 1);
  const pageStart = currentPage * COLLECTION_PAGE_SIZE;
  const pageEnd = Math.min(filteredTotal, pageStart + COLLECTION_PAGE_SIZE);
  const pageCards = useServerCollection ? cards : visibleCards.slice(pageStart, pageEnd);
  const currentPageSignature = pageSignature(pageCards);
  const showPagePlaceholders = serverLoading && pageCards.length === 0;
  const placeholderCount = Math.min(COLLECTION_PAGE_SIZE, Math.max(1, pageCards.length || filteredTotal || COLLECTION_PAGE_SIZE));
  const recyclable = useServerCollection ? serverPage?.duplicateShardTotal ?? 0 : wallet ? duplicateShardTotal(wallet) : 0;
  const selectedShardTotal = cards
    .filter((card) => selected.has(card.userId))
    .reduce((sum, card) => sum + duplicateShardValue(card) + shardValueForTier(card.tier), 0);

  useEffect(() => {
    setCollectionPage(0);
    setSelected(new Set());
    setConfirmBulk(false);
  }, [trimmedQuery, tierFilter]);

  useEffect(() => {
    setSelected(new Set());
    setConfirmBulk(false);
  }, [currentPage]);

  useEffect(() => {
    if (collectionPage <= totalPages - 1) return;
    setCollectionPage(Math.max(0, totalPages - 1));
  }, [collectionPage, totalPages]);

  useEffect(() => {
    if (!walletReady || !useServerCollection) {
      setServerPage(null);
      setServerLoading(false);
      return;
    }
    let cancelled = false;
    const cacheKey = serverCollectionCacheKey({
      page: collectionPage,
      pageSize: COLLECTION_PAGE_SIZE,
      tier: tierFilter,
      query: trimmedQuery,
    });
    const cachedPage = serverCollectionPageCache.get(cacheKey) ?? null;
    if (cachedPage) setServerPage(cachedPage);
    setServerLoading(true);
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
        if (page) serverCollectionPageCache.set(cacheKey, page);
        setServerPage(page ?? cachedPage);
      })
      .catch(() => {
        if (!cancelled && !cachedPage) setServerPage(null);
      })
      .finally(() => {
        if (!cancelled) setServerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [walletReady, useServerCollection, collectionPage, tierFilter, trimmedQuery, serverRefreshKey]);

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
      const toRender: CollectedCard[] = [];
      await Promise.all(missing.map(async ({ card, key }) => {
        const cached = await loadPersistedCardThumbnail(key);
        if (cancelled) return;
        if (cached) setThumbnailRevision((revision) => revision + 1);
        else {
          const remote = await loadR2CardThumbnail(key);
          if (cancelled) return;
          if (remote) setThumbnailRevision((revision) => revision + 1);
          else toRender.push(card);
        }
      }));
      if (cancelled || toRender.length === 0) return;

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
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-bold text-white">Collection</h2>
          <span className="text-[12px] text-osu-f1 tabular-nums">
            {collectionTotal}
            {wallet.poolTotal ? ` / ${wallet.poolTotal.toLocaleString()}` : ""} players
          </span>
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

      {collectionTotal === 0 && !serverLoading ? (
        <div className="mt-6 rounded-xl border border-osu-b3/40 bg-osu-b4/40 px-6 py-8 text-center text-[12px] text-osu-f1">
          No cards yet. Open a pack to start your collection.
        </div>
      ) : filteredTotal === 0 && !serverLoading ? (
        <div className="mt-6 rounded-xl border border-osu-b3/40 bg-osu-b4/40 px-6 py-8 text-center text-[12px] text-osu-f1">
          No cards match{trimmedQuery ? ` "${query.trim()}"` : " the selected rarity"}.
        </div>
      ) : (
        <div className={`mt-4 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 ${selecting ? "select-none" : ""}`}>
          {showPagePlaceholders
            ? Array.from({ length: placeholderCount }, (_, index) => <CollectionCardPlaceholder key={`placeholder-${index}`} />)
            : pageCards.map((card) => {
            const dupValue = duplicateShardValue(card);
            const lastCopyValue = shardValueForTier(card.tier);
            const confirming = confirmUserId === card.userId;
            const thumbnail = simulateSkeletons ? null : getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card));
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
                      dragRef.current = { mode: !selected.has(card.userId) };
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
                    aria-pressed={selected.has(card.userId)}
                    aria-label={`${selected.has(card.userId) ? "Deselect" : "Select"} ${card.username}`}
                  >
                    <CollectionCardTile card={card} thumbnail={thumbnail} onApplyMint={onApplyMint} />
                    <span
                      className={`pointer-events-none absolute inset-0 rounded-[10px] ${
                        selected.has(card.userId) ? "ring-2 ring-osu-pink" : "bg-black/45"
                      }`}
                    />
                    {selected.has(card.userId) && (
                      <span className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-osu-pink text-white">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </button>
                ) : (
                  <Link
                    to="/player/$username"
                    params={{ username: card.username }}
                    className="block transition-transform duration-150 hover:-translate-y-1"
                    aria-label={`Open ${card.username}'s profile`}
                  >
                    <CollectionCardTile card={card} thumbnail={thumbnail} onApplyMint={onApplyMint} />
                  </Link>
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
              <span className="font-bold text-white">{selected.size}</span> selected
            </span>
            <button
              type="button"
              onClick={() => {
                setSelected(new Set(pageCards.map((card) => card.userId)));
                setConfirmBulk(false);
              }}
              className="text-[12px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
            >
              select page
            </button>
            {selected.size > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelected(new Set());
                  setConfirmBulk(false);
                }}
                className="text-[12px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
              >
                clear
              </button>
            )}
            <button
              type="button"
              disabled={selected.size === 0 || bulkBusy}
              onClick={(event) => {
                if (!confirmBulk) {
                  setConfirmBulk(true);
                  return;
                }
                const anchor = event.currentTarget;
                setBulkBusy(true);
                void (async () => {
                  try {
                    const gained = await onRecycleWholeMany(Array.from(selected));
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
                  ? `Sure? ${selected.size} ${selected.size === 1 ? "card leaves" : "cards leave"} the collection`
                  : `Recycle +${selectedShardTotal}`}
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
    </section>
  );
}
