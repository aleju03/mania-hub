import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Crown, Globe, Info } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg, plural } from "@lingui/core/macro";
import type { getI18n } from "#/lib/i18n";
import type { HonoraryPlayer } from "#/lib/honorary-players";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import {
  collectedCardTier,
  ownedCards,
  packCardKeyOf,
  parsePackCardKey,
  type CollectedCard,
  type PackWallet,
} from "#/lib/pack-collection";
import {
  fetchServerPackCollectionOwnedKeys,
  fetchServerPackCollectionPage,
  PACK_COLLECTION_MAX_PAGE_SIZE,
} from "#/lib/pack-wallet-sync";
import {
  fetchLiveGlobalRankings,
  fetchLiveRankingsSnapshot,
  isLiveBackendConfigured,
  type LiveGlobalRankingEntry,
} from "#/lib/live-backend";
import {
  getCountryFlagLargeUrl,
  getCountryFlagUrl,
  GLOBAL_SCOPE_CODE,
  isGlobalScope,
} from "#/lib/country";
import { buildManiaCardRenderDataFromSkills } from "../../player/maniacard3d/renderData";
import { CountryFlag } from "../../ui/CountryFlag";
import { CardSpotlight, type CardSpotlightTarget } from "../CardSpotlight";
import { renderCardSkeletonThumbnail, renderCardThumbnailBlob } from "../cardSnapshot";
import {
  cardThumbnailKeyForCollectionCard,
  cardThumbnailKeyForData,
  claimCardThumbnailErrorFallback,
  COLLECTION_CARD_THUMB_WIDTH,
  forgetRemoteCardThumbnail,
  getMemoryCardThumbnail,
  loadPersistedCardThumbnail,
  loadR2CardThumbnails,
  noteCardThumbnailStored,
  rememberCardThumbnailBlob,
} from "../cardThumbnailCache";
import { getCachedCardBackDataUrl } from "../packArt";
import { playPageTurn, warmPackAudio } from "../packSfx";
import {
  ALBUM_SLOTS_PER_PAGE,
  albumPageCount,
  albumRosterLimit,
  buildAlbumSections,
  chunkForSlot,
  GLOBAL_ALBUM_CAP,
  GOAT_ALBUM_CODE,
  GOAT_ALBUM_ROSTER,
  isGoatAlbum,
  isPinnedAlbum,
  orderShelfSections,
  ROSTER_CHUNK_SIZE,
  slotOffsetForPage,
  slotPagesForRoster,
  type AlbumSection,
} from "./albumModel";
import { FlipBook, type FlipBookApi } from "./FlipBook";

const PAGE_WIDTH = 380;
const PAGE_HEIGHT = 560;
const MIN_PAGE_WIDTH = 260;
const MAX_PAGE_WIDTH = 440;
const SHELF_COVER_WIDTH = 180;
const GOLD = "#e8c56a";
const ALBUM_SEASON = new Date().getFullYear();

interface RosterData {
  total: number | null;
  entries: Record<number, LiveGlobalRankingEntry>;
  chunks: Record<number, boolean>;
  error: boolean;
}

/* Last-known roster size per album, persisted so reopening an album can show
   the collection progress bar (and mount the book at the right page count)
   immediately instead of waiting for the first roster chunk. The fresh
   snapshot still overwrites it, so a drifted size only costs one book
   remount. */
const ROSTER_TOTAL_CACHE_KEY = "mania-hub-album-roster-totals-v1";

function readRosterTotalCache(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ROSTER_TOTAL_CACHE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const totals: Record<string, number> = {};
    for (const [code, total] of Object.entries(parsed)) {
      if (typeof total === "number" && Number.isFinite(total) && total > 0) totals[code] = total;
    }
    return totals;
  } catch {
    return {};
  }
}

function writeRosterTotalCache(code: string, total: number): void {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(total) || total <= 0) return;
  try {
    const totals = readRosterTotalCache();
    if (totals[code] === total) return;
    totals[code] = total;
    window.localStorage.setItem(ROSTER_TOTAL_CACHE_KEY, JSON.stringify(totals));
  } catch {
    // Best-effort cache; the roster fetch is the source of truth.
  }
}

/* Last-known per-album card counts for a synced viewer. A synced wallet
   keeps its cards server-side, so on the shelf's first mount every count is
   zero until the collection fetch lands, and every cover would read "0 cards"
   (with the most-cards order, if picked, re-sorting the covers under the
   cursor a beat later). Seeding the counts from this cache lets the shelf
   mount already labeled; the fresh fetch still takes over, so a drift only
   costs one repaint. */
const SHELF_COUNT_CACHE_KEY = "mania-hub-album-shelf-counts-v1";

function readShelfCountCache(viewerId: number | null): Map<string, number> | null {
  if (typeof window === "undefined" || !viewerId) return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SHELF_COUNT_CACHE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || parsed.viewerId !== viewerId) return null;
    const counts = new Map<string, number>();
    for (const [code, count] of Object.entries(parsed.counts ?? {})) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) counts.set(code, count);
    }
    return counts.size > 0 ? counts : null;
  } catch {
    return null;
  }
}

function writeShelfCountCache(viewerId: number | null, counts: ReadonlyMap<string, number>): void {
  if (typeof window === "undefined" || !viewerId) return;
  try {
    const record: Record<string, number> = {};
    for (const [code, count] of counts) {
      if (count > 0) record[code] = count;
    }
    window.localStorage.setItem(SHELF_COUNT_CACHE_KEY, JSON.stringify({ viewerId, counts: record }));
  } catch {
    // Best-effort cache; the server collection is the source of truth.
  }
}

/* Shelf order is a preference, not derived state: the shelf lists countries
   alphabetically unless the reader asks for their biggest collections first,
   and that choice survives leaving the page. */
export type ShelfSort = "az" | "cards";
const SHELF_SORT_KEY = "mania-hub-album-shelf-sort-v1";

function readShelfSort(): ShelfSort {
  if (typeof window === "undefined") return "az";
  try {
    return window.localStorage.getItem(SHELF_SORT_KEY) === "cards" ? "cards" : "az";
  } catch {
    return "az";
  }
}

function writeShelfSort(sort: ShelfSort): void {
  try {
    window.localStorage.setItem(SHELF_SORT_KEY, sort);
  } catch {
    // Best-effort preference; the shelf just reopens on the default order.
  }
}

const skeletonThumbCache = new Map<ManiaCardTier, string | null>();

function tierSkeletonThumb(tier: ManiaCardTier): string | null {
  if (!skeletonThumbCache.has(tier)) {
    skeletonThumbCache.set(tier, renderCardSkeletonThumbnail(tier, COLLECTION_CARD_THUMB_WIDTH));
  }
  return skeletonThumbCache.get(tier) ?? null;
}

function cardTier(card: CollectedCard): ManiaCardTier {
  return collectedCardTier(card);
}

/* Same two-at-a-time cap the collection grid uses for on-device card renders. */
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

async function renderAlbumThumbnail(card: CollectedCard): Promise<string | null> {
  if (!card.skills) return null;
  const data = buildManiaCardRenderDataFromSkills({
    user: {
      id: card.userId,
      username: card.username,
      avatar_url: card.avatarUrl,
      country_code: card.countryCode,
      statistics: { global_rank: card.globalRank, pp: card.pp },
    },
    skills: card.skills,
    tierOverride: collectedCardTier(card),
    labelOverride: card.customLabel,
    motifOverride: card.motif,
  });
  const key = cardThumbnailKeyForData(data, COLLECTION_CARD_THUMB_WIDTH);
  const blob = await throttleRender(() => renderCardThumbnailBlob(data, COLLECTION_CARD_THUMB_WIDTH));
  return rememberCardThumbnailBlob(key, blob);
}

/* A synced account keeps its collection server-side (the local wallet's
   cards map is intentionally stripped), so the album pages the full server
   collection once and merges it with any local pulls. Cached per session:
   the album only reads it. */
const SERVER_COLLECTION_TTL_MS = 120_000;
let serverCollectionCache: { at: number; cards: CollectedCard[] } | null = null;
let serverCollectionPromise: Promise<CollectedCard[] | null> | null = null;

async function loadFullServerCollection(): Promise<CollectedCard[] | null> {
  if (serverCollectionCache && Date.now() - serverCollectionCache.at < SERVER_COLLECTION_TTL_MS) {
    return serverCollectionCache.cards;
  }
  if (serverCollectionPromise) return serverCollectionPromise;
  serverCollectionPromise = (async () => {
    try {
      const pageSize = PACK_COLLECTION_MAX_PAGE_SIZE;
      const first = await fetchServerPackCollectionPage({ data: { page: 0, pageSize, tier: "all", query: "" } });
      if (!first) return null;
      const cards: CollectedCard[] = [...first.cards];
      // The backend clamps to its own ceiling, which can be lower than what we
      // asked for while a deploy is only half rolled out. Paging by the width
      // it actually returned keeps the walk from striding past whole pages.
      const effectivePageSize = first.cards.length || pageSize;
      const totalPages = Math.ceil(first.total / effectivePageSize);
      for (let page = 1; page < totalPages; page += 1) {
        const next = await fetchServerPackCollectionPage({ data: { page, pageSize, tier: "all", query: "" } });
        if (!next) break;
        cards.push(...next.cards);
      }
      serverCollectionCache = { at: Date.now(), cards };
      return cards;
    } finally {
      serverCollectionPromise = null;
    }
  })();
  return serverCollectionPromise;
}

/* The cover backdrop follows lazer's Triangles drawable (the same field the
   skin-upload dropzone ports): equilateral triangles with normally
   distributed sizes, large behind small, here as a translucent white
   texture over each country's colour wash. Seeded so the server and client
   emit identical SVG, split into three speed layers (big drifts fastest,
   lazer's rule) and drawn twice vertically so the CSS scroll wraps
   seamlessly. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CoverTriangle {
  x: number;
  y: number;
  size: number;
  shade: number;
}

const TRIANGLE_LAYERS: Array<{ duration: number; triangles: CoverTriangle[] }> = (() => {
  const rand = mulberry32(730317);
  const randomNormal = () => {
    const u1 = 1 - rand();
    const u2 = 1 - rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
  };
  const field: CoverTriangle[] = [];
  for (let index = 0; index < 44; index += 1) {
    const scale = Math.max(1.6 * (0.5 + 0.16 * randomNormal()), 0.4);
    field.push({
      x: rand() * PAGE_WIDTH,
      y: rand() * PAGE_HEIGHT,
      size: 100 * scale,
      shade: rand(),
    });
  }
  field.sort((a, b) => b.size - a.size);
  return [
    { duration: 26, triangles: field.slice(0, 15) },
    { duration: 40, triangles: field.slice(15, 30) },
    { duration: 58, triangles: field.slice(30) },
  ];
})();

/* The board surface sits between the b5 and b4 tokens; triangles are opaque
   tonal shades just above it, exactly the dropzone's resting palette idea. */
const COVER_BOARD_BACKGROUND = "hsl(var(--theme-hue), calc(10% * var(--theme-sat)), 16.5%)";

function coverTriangleFill(shade: number): string {
  const saturation = (11 + 4 * shade).toFixed(1);
  const lightness = (19 + 8.5 * shade).toFixed(1);
  return `hsl(var(--theme-hue), calc(${saturation}% * var(--theme-sat)), ${lightness}%)`;
}

/* Every cover shares the same seeded field, so the polygons exist once in
   this hidden defs block and each cover stamps them with <use>. Without the
   sharing the shelf mounts ~7,500 polygons (85 covers x 3 layers x 44
   triangles x 2 wrap copies) and the Album tab takes most of a second to
   appear. The fills' theme vars still resolve inside the <use> shadow tree
   because custom properties inherit through it. */
function CoverTriangleDefs() {
  return (
    <svg width={0} height={0} className="absolute" aria-hidden="true" focusable="false">
      <defs>
        {TRIANGLE_LAYERS.map((layer, layerIndex) => (
          <g key={layerIndex} id={`album-tri-layer-${layerIndex}`}>
            {layer.triangles.flatMap((triangle, index) => {
              const height = triangle.size * 0.866;
              return [0, PAGE_HEIGHT].map((offsetY) => (
                <polygon
                  key={`${index}-${offsetY}`}
                  points={`${triangle.x},${triangle.y + offsetY} ${triangle.x - triangle.size / 2},${triangle.y + offsetY + height} ${triangle.x + triangle.size / 2},${triangle.y + offsetY + height}`}
                  style={{ fill: coverTriangleFill(triangle.shade) }}
                />
              ));
            })}
          </g>
        ))}
      </defs>
    </svg>
  );
}

/* Memoized: it takes no props, so this is a total barrier. Without one, every
   AlbumView state change -- a page turn, a roster chunk, each thumbnail that
   resolves -- walked this svg for every mounted cover (the hidden shelf's
   included) and rewrote three inline styles on each. */
export const CoverTriangles = memo(function CoverTriangles() {
  /* Wall-clock phase lock: a negative delay equal to this instance's own mount
     time keeps its drift at the shared global phase for as long as it lives
     (progress = elapsed + mount time, congruent to now for every layer
     period), so when the open album swaps the static stand-in cover for the
     book's cover face the field carries on instead of visibly restarting.

     Stamped once at mount and never again on a re-render: animation-delay is
     effect timing, not a start time, so restamping it on a live animation
     shifts that animation's local time by the whole render-to-render gap and
     the field visibly jumps -- the exact opposite of a phase lock. AlbumView
     only renders once the wallet has loaded out of localStorage, so this never
     runs on the server and the clock read cannot reach SSR markup. */
  const [mountSeconds] = useState(() => Date.now() / 1000);
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {TRIANGLE_LAYERS.map((layer, layerIndex) => (
        <g
          key={layerIndex}
          className="album-tri-layer"
          style={{
            "--drift-dur": `${layer.duration}s`,
            animationDelay: `${(-(mountSeconds % layer.duration)).toFixed(2)}s`,
          } as CSSProperties}
        >
          <use href={`#album-tri-layer-${layerIndex}`} />
        </g>
      ))}
    </svg>
  );
});

/* Each cover's tilt is hashed from its country code so the shelf looks
   hand-assembled but every render (and both book faces) agree. Kept off
   zero so the sticker never looks accidentally almost-straight. */
function stickerTilt(code: string): number {
  let hash = 0;
  for (let index = 0; index < code.length; index += 1) hash = (hash * 31 + code.charCodeAt(index)) | 0;
  const magnitude = 2 + (Math.abs(hash) % 30) / 10;
  return (Math.abs(hash >> 7) % 2 === 0 ? 1 : -1) * magnitude;
}

/* The cover art is itself a sticker: the country's flag blown up on a white
   die-cut border, slapped onto the board at that country's tilt. flagcdn
   carries the large raster (osu!'s own flags are 70x47); the osu! flag
   stays as the fallback. The Global album has no flag, so its sticker is
   the pink globe the flag component uses for that scope, and the GOATs album
   wears the gold of the tier badge its cards carry. */
function FlagSticker({ code, width }: { code: string; width: number }) {
  const global = isGlobalScope(code);
  const goat = isGoatAlbum(code);
  return (
    <div
      className="album-flag-sticker rounded-[10px] bg-white p-[7px] shadow-[0_14px_30px_rgba(0,0,0,0.55)]"
      style={{ width, "--sticker-tilt": `${stickerTilt(code)}deg` } as CSSProperties}
    >
      <div className="relative w-full overflow-hidden rounded-[4px]" style={{ aspectRatio: "3 / 2" }}>
        {goat ? (
          <span
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: MANIA_TIER_STYLES.goat.badgeGradient }}
          >
            <Crown className="h-3/5 w-3/5 text-white" strokeWidth={1.5} aria-hidden="true" />
          </span>
        ) : global ? (
          <span className="absolute inset-0 flex items-center justify-center bg-osu-pink">
            <Globe className="h-3/5 w-3/5 text-white" strokeWidth={1.5} aria-hidden="true" />
          </span>
        ) : (
          <img
            src={getCountryFlagLargeUrl(code)}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            draggable={false}
            onError={(event) => {
              const fallback = getCountryFlagUrl(code);
              if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
            }}
          />
        )}
      </div>
    </div>
  );
}

/* The album cover: a gold-framed dark board under the drifting triangle
   field, the series masthead up top, the flag sticker as the hero, and the
   country code + name and owned-card count under it. The footer is the same
   whether the cover sits on the shelf or fronts the open book -- collection
   progress lives below the book instead, so opening an album never repaints
   the cover. */
function AlbumCoverFace({
  section,
  collectedText,
  subtitle,
}: {
  section: AlbumSection;
  collectedText: string;
  subtitle: string;
}) {
  const global = isGlobalScope(section.code);
  const goat = isGoatAlbum(section.code);
  /* Both wordmark albums print their name instead of a country code, so they
     share the smaller size and skip the country line under it. */
  const wordmark = global || goat;
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: COVER_BOARD_BACKGROUND }}>
      <CoverTriangles />
      <span
        className="pointer-events-none absolute inset-3 z-[5] rounded-[5px] border"
        style={{ borderColor: "rgba(232, 197, 106, 0.32)" }}
      />
      <div className="absolute inset-x-6 top-7 z-[3] text-center">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.3em]" style={{ color: GOLD }}>
          maniacards
        </div>
        <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.3em] text-white/40">
          <Trans>{ALBUM_SEASON} series</Trans>
        </div>
      </div>
      <div className="absolute inset-x-5 bottom-[76px] top-[64px] z-[3] flex flex-col items-center justify-center">
        <FlagSticker code={section.code} width={wordmark ? 176 : 208} />
        <div
          className={`mt-8 font-black italic leading-none ${goat ? "" : "text-osu-pink"}`}
          style={{ fontSize: wordmark ? 60 : 88, letterSpacing: "-0.02em", color: goat ? GOLD : undefined }}
        >
          {global ? "GLOBAL" : goat ? "GOATS" : section.code}
        </div>
        {!wordmark && (
          <div className="mt-2 text-center text-[18px] font-extrabold uppercase leading-[1.15] tracking-[0.06em] text-white">
            {section.name}
          </div>
        )}
      </div>
      <div className="absolute inset-x-6 bottom-[26px] z-[3]">
        {/* mb-2 keeps the row at the exact height it had when a progress bar
            used to follow it, so pre-existing covers do not shift. */}
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.24em] text-[#e8c56a]">{subtitle}</span>
          <span className="text-[11px] font-bold text-white/80 tabular-nums">{collectedText}</span>
        </div>
      </div>
    </div>
  );
}

function AlbumBackFace({ section }: { section: AlbumSection }) {
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: COVER_BOARD_BACKGROUND }}>
      <CoverTriangles />
      <span
        className="pointer-events-none absolute inset-3 rounded-[5px] border"
        style={{ borderColor: "rgba(232, 197, 106, 0.32)" }}
      />
      <div className="relative z-[2] flex h-full flex-col items-center justify-center">
        <FlagSticker code={section.code} width={120} />
        <span className="mt-6 text-[10px] font-extrabold uppercase tracking-[0.24em] text-white/85">
          maniacards
        </span>
        <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.24em] text-white/40">
          <Trans>{ALBUM_SEASON} series</Trans>
        </span>
      </div>
    </div>
  );
}

/* Renders the fixed-size cover art scaled down to an arbitrary width. */
function ScaledCover({ width, children }: { width: number; children: ReactNode }) {
  const scale = width / PAGE_WIDTH;
  return (
    <div style={{ width, height: Math.round(PAGE_HEIGHT * scale) }} className="pointer-events-none">
      <div
        style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})`, transformOrigin: "top left" }}
        className="overflow-hidden rounded-[10px]"
      >
        {children}
      </div>
    </div>
  );
}

/* A re-render pulse, coalesced to at most one per frame. The album's thumbnails
   resolve one at a time out of CacheStorage, the shared R2 pool and the local
   canvas renderer, each completion landing in its own task, so React cannot
   batch them: a chunk of collected cards used to fire one full AlbumView render
   per thumbnail, arriving on top of whatever page turn was running. The slots
   read the module cache during render, so one pulse per frame delivers the
   whole batch just as fast. */
export function useFramePulse(): () => void {
  const [, setRevision] = useState(0);
  const frameRef = useRef(0);
  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
  return useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setRevision((revision) => revision + 1);
    });
  }, []);
}

/* The shelf cover and the open book's cover face carry the same two captions,
   so they live out here rather than in either one. Both take the caller's i18n
   instance: the covers are drawn from two different components and neither
   caption belongs to either one. */
export function albumCountText(
  counts: ReadonlyMap<string, number>,
  code: string,
  i18n: ReturnType<typeof getI18n>,
): string {
  const count = counts.get(code) ?? 0;
  return i18n._(msg`${plural(count, { one: "# card", other: "# cards" })}`);
}

export function albumSubtitle(code: string, i18n: ReturnType<typeof getI18n>): string {
  if (isGlobalScope(code)) return i18n._(msg`Top ${GLOBAL_ALBUM_CAP} players`);
  if (isGoatAlbum(code)) return i18n._(msg`Honorary roster`);
  return i18n._(msg`Card collection`);
}

/* The little mark beside an album's name. Every album but the GOATs one is a
   scope the flag component already knows how to draw. */
function AlbumMark({ code }: { code: string }) {
  if (!isGoatAlbum(code)) return <CountryFlag code={code} size="sm" decorative />;
  return (
    <span
      className="inline-flex h-[12px] w-[18px] shrink-0 items-center justify-center rounded-[1px] align-middle"
      style={{ background: "rgba(232, 197, 106, 0.22)", color: GOLD }}
    >
      <Crown className="h-[10px] w-[10px]" strokeWidth={2.4} aria-hidden="true" />
    </span>
  );
}

/* Memoized, and it owns its search box and sort choice. The shelf stays
   mounted (just hidden) behind an open album and React has no idea about
   display:none, so without a boundary here every page turn, roster chunk and
   thumbnail arrival re-rendered every cover on the shelf -- the bulk of the
   work in an AlbumView render, none of it on screen. Both data props are
   memoized upstream and onOpen is identity-stable, so this now re-renders only
   when the collection itself changes. The query moved in for the same reason:
   left in AlbumView it would re-render the open book on every keystroke, and
   the filtered array it produces would defeat the memo anyway. */
export const AlbumShelf = memo(function AlbumShelf({
  sections,
  counts,
  onOpen,
}: {
  sections: AlbumSection[];
  counts: ReadonlyMap<string, number>;
  onOpen: (code: string) => void;
}) {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ShelfSort>(readShelfSort);
  const ordered = useMemo(
    () => (sort === "cards" ? orderShelfSections(sections, counts) : sections),
    [sort, sections, counts],
  );
  const trimmed = query.trim().toLowerCase();
  const visible = trimmed
    ? ordered.filter(
        (section) =>
          section.code.toLowerCase().includes(trimmed) ||
          section.name.toLowerCase().includes(trimmed),
      )
    : ordered;

  const pickSort = (next: ShelfSort) => {
    setSort(next);
    writeShelfSort(next);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold text-white"><Trans>Card albums</Trans></h2>
        <span className="text-[12px] text-osu-f1 tabular-nums">
          {trimmed ? (
            <Trans>{visible.length} of {sections.length} albums</Trans>
          ) : (
            <Trans>{sections.length} albums</Trans>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {([
            { mode: "az", label: msg`A-Z` },
            { mode: "cards", label: msg`Most cards` },
          ] as const).map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              onClick={() => pickSort(mode)}
              aria-pressed={sort === mode}
              className={`h-7 cursor-pointer rounded-full border px-2.5 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                sort === mode
                  ? "border-osu-pink/50 bg-osu-b4 text-white"
                  : "border-osu-b3/30 bg-osu-b4/30 text-osu-f1 hover:bg-osu-b4/70"
              }`}
            >
              {i18n._(label)}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`find an album`}
          aria-label={t`Find an album`}
          className="h-7 w-[180px] select-text rounded-full border border-osu-b3/40 bg-osu-b4/40 px-3 text-[12px] text-white outline-none placeholder:text-osu-f1/70 focus:border-osu-pink/50"
        />
      </div>
      {visible.length === 0 && (
        <div className="py-10 text-center text-[12px] text-osu-f1">
          <Trans>No album matches "{query.trim()}".</Trans>
        </div>
      )}
      <div className="grid grid-cols-2 justify-items-center gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4">
        {visible.map((section) => (
          <button
            key={section.code}
            type="button"
            onClick={() => onOpen(section.code)}
            className="album-cover-hover cursor-pointer rounded-[10px] shadow-[0_10px_24px_rgba(0,0,0,0.4)] transition-transform duration-150 hover:-translate-y-1"
            /* Covers below the fold skip layout/paint until scrolled to; the
               intrinsic size matches ScaledCover so nothing shifts. */
            style={{
              contentVisibility: "auto",
              containIntrinsicSize: `${SHELF_COVER_WIDTH}px ${Math.round((PAGE_HEIGHT / PAGE_WIDTH) * SHELF_COVER_WIDTH)}px`,
            }}
            aria-label={t`Open the ${section.name} album`}
          >
            <ScaledCover width={SHELF_COVER_WIDTH}>
              <AlbumCoverFace
                section={section}
                collectedText={albumCountText(counts, section.code, i18n)}
                subtitle={albumSubtitle(section.code, i18n)}
              />
            </ScaledCover>
          </button>
        ))}
      </div>
    </>
  );
});

interface PlayerPeekTarget {
  entry: LiveGlobalRankingEntry;
  owned: boolean;
}

function PeekStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-osu-b4/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-osu-f1">{label}</div>
      <div className="text-[12px] font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}

/* The scouting card behind an album slot: everything the tracker already knows
   about the player from the rankings roster, plus the way to their profile. */
function PlayerPeek({ target, onClose }: { target: PlayerPeekTarget | null; onClose: () => void }) {
  const { t } = useLingui();
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target || typeof document === "undefined") return null;
  const { entry, owned } = target;
  const grades = entry.grade_counts;
  const revealBanner = (banner: HTMLImageElement | null) => {
    if (banner?.complete && banner.naturalWidth > 0) banner.style.opacity = "0.7";
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
      role="dialog"
      aria-label={t`${entry.user.username} details`}
    >
      <div
        className="w-full max-w-[330px] overflow-hidden rounded-xl border border-osu-b3/60 bg-osu-b5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative h-[84px] bg-osu-b4">
          {entry.user.cover_url && (
            <img
              src={entry.user.cover_url}
              alt=""
              ref={revealBanner}
              onLoad={(event) => {
                event.currentTarget.style.opacity = "0.7";
              }}
              className="h-full w-full object-cover opacity-0 transition-opacity duration-300"
              draggable={false}
            />
          )}
          <div className="absolute inset-0 bg-black/25" />
          <img
            src={entry.user.avatar_url}
            alt=""
            className="absolute -bottom-6 left-4 h-14 w-14 rounded-[10px] border-2 border-osu-b5 bg-osu-b4 object-cover"
            draggable={false}
          />
        </div>
        <div className="px-4 pb-4 pt-8">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-bold text-white">{entry.user.username}</span>
            <CountryFlag code={entry.user.country_code} size="sm" decorative />
          </div>
          <div className="mt-0.5 text-[11px] text-osu-f1 tabular-nums">
            {entry.global_rank ? (
              <Trans>#{entry.global_rank.toLocaleString("en-US")} global</Trans>
            ) : (
              <Trans>unranked</Trans>
            )}
            {entry.country_rank ? <> &middot; #{entry.country_rank.toLocaleString("en-US")} {entry.user.country_code}</> : null}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            <PeekStat label="pp" value={Math.round(entry.pp).toLocaleString("en-US")} />
            <PeekStat
              label={t`accuracy`}
              value={entry.hit_accuracy != null ? `${entry.hit_accuracy.toFixed(2)}%` : "?"}
            />
            <PeekStat label={t`plays`} value={entry.play_count != null ? entry.play_count.toLocaleString("en-US") : "?"} />
            {grades && (
              <>
                <PeekStat label="SS" value={(grades.ssh + grades.ss).toLocaleString("en-US")} />
                <PeekStat label="S" value={(grades.sh + grades.s).toLocaleString("en-US")} />
                <PeekStat label="A" value={grades.a.toLocaleString("en-US")} />
              </>
            )}
          </div>
          {entry.ranked_score != null && (
            <div className="mt-2 text-[11px] text-osu-f1 tabular-nums">
              <Trans>Ranked score {entry.ranked_score.toLocaleString("en-US")}</Trans>
            </div>
          )}
          <div className="mt-2 text-[11px] text-osu-f1">
            {owned ? <Trans>In your collection.</Trans> : <Trans>Missing from your collection.</Trans>}
          </div>
          <Link
            to="/player/$username"
            params={{ username: entry.user.username }}
            className="mt-3 block w-full rounded-full bg-osu-pink px-4 py-1.5 text-center text-[12px] font-bold text-white transition hover:brightness-110"
          >
            <Trans>View profile</Trans>
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* The collected card filling a slot: its thumbnail (or the tier skeleton
   until one resolves) opening the spotlight. Shared by the country and GOAT
   slots, which differ only in what they put around it. */
function CollectedCardFace({
  card,
  thumbnail,
  onSpotlight,
  onThumbnailError,
}: {
  card: CollectedCard;
  thumbnail: string | null;
  onSpotlight: (card: CollectedCard, thumbnail: string | null, rect: DOMRect) => void;
  onThumbnailError: (card: CollectedCard) => void;
}) {
  const { t } = useLingui();
  const skeleton = thumbnail ? null : tierSkeletonThumb(cardTier(card));
  return (
    <button
      type="button"
      className="absolute inset-0 cursor-pointer overflow-hidden rounded-[7px]"
      onClick={(event) => onSpotlight(card, thumbnail, event.currentTarget.getBoundingClientRect())}
      title={card.username}
    >
      {(thumbnail ?? skeleton) ? (
        <img
          src={thumbnail ?? skeleton ?? undefined}
          alt={t`${card.username} maniacard`}
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
          onLoad={(event) => noteCardThumbnailStored(card, event.currentTarget.src)}
          onError={(event) => {
            /* Only a remote pool URL can 404 (skeletons and local renders
               are data/blob URLs); fall back to rendering this card. */
            if (/^https?:/.test(event.currentTarget.src)) onThumbnailError(card);
          }}
        />
      ) : (
        <span className="absolute inset-0 bg-osu-b3" />
      )}
      {card.copies > 1 && (
        <span className="absolute right-1 top-1 rounded bg-black/70 px-1 py-px text-[9px] font-bold text-white tabular-nums">
          x{card.copies}
        </span>
      )}
    </button>
  );
}

/* Memoized: every album page re-renders on any AlbumView state change
   (page turns, roster chunks, thumbnail arrivals), and a big country is
   ~500 slots. All props are identity-stable, so slots only re-render when
   their own data lands -- keeping React work off the flip animation. */
const AlbumSlot = memo(function AlbumSlot({
  entry,
  card,
  serverOwned,
  thumbnail,
  lifted,
  onSpotlight,
  onPeek,
  onThumbnailError,
}: {
  entry: LiveGlobalRankingEntry | null;
  card: CollectedCard | null;
  serverOwned: boolean;
  thumbnail: string | null;
  /* This slot's card is the one currently up in the spotlight, so the slot
     holds its place empty until the card flies back into it. */
  lifted: boolean;
  onSpotlight: (card: CollectedCard, thumbnail: string | null, rect: DOMRect) => void;
  onPeek: (entry: LiveGlobalRankingEntry, owned: boolean) => void;
  onThumbnailError: (card: CollectedCard) => void;
}) {
  const { t } = useLingui();
  if (!entry) {
    return <div className="rounded-[7px] bg-osu-b4/25" style={{ aspectRatio: "5 / 7" }} />;
  }

  if (card) {
    return (
      <div
        className="relative w-full"
        style={{ aspectRatio: "5 / 7", visibility: lifted ? "hidden" : undefined }}
      >
        <CollectedCardFace
          card={card}
          thumbnail={thumbnail}
          onSpotlight={onSpotlight}
          onThumbnailError={onThumbnailError}
        />
        {/* The card click shows the card; this keeps the scouting modal
            reachable for collected players too. Bottom-right: the card art
            wears the mania logo in its top-left corner. */}
        <button
          type="button"
          className="absolute bottom-1 right-1 z-[2] flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white/85 hover:bg-black/80 hover:text-white"
          onClick={() => onPeek(entry, true)}
          aria-label={t`${entry.user.username} details`}
          title={t`Player details`}
        >
          <Info className="h-3 w-3" />
        </button>
      </div>
    );
  }

  if (serverOwned) {
    /* Owned by the synced account, full card data not loaded (yet): the
       card is slotted in, just without its art. */
    return (
      <button
        type="button"
        className="relative flex w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[7px] border border-white/20 bg-osu-b4/70 px-1"
        style={{ aspectRatio: "5 / 7" }}
        onClick={() => onPeek(entry, true)}
        title={entry.user.username}
      >
        <img
          src={entry.user.avatar_url}
          alt=""
          className="h-1/2 w-auto rounded-full object-cover"
          loading="lazy"
          draggable={false}
        />
        <span className="mt-1.5 w-full truncate text-center text-[9px] font-semibold text-white">
          {entry.user.username}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="relative flex w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[7px] border border-dashed border-white/12 bg-black/20 px-1 hover:bg-black/30"
      style={{ aspectRatio: "5 / 7" }}
      onClick={() => onPeek(entry, false)}
      title={entry.user.username}
    >
      <span className="absolute left-1 top-1 text-[9px] text-osu-f1/60 tabular-nums">#{entry.rank}</span>
      <img
        src={entry.user.avatar_url}
        alt=""
        className="h-1/2 w-auto rounded-full object-cover opacity-30 grayscale"
        loading="lazy"
        draggable={false}
      />
      <span className="mt-1.5 w-full truncate text-center text-[9px] text-osu-f1/80">
        {entry.user.username}
      </span>
    </button>
  );
});

/* The same face-down back the shuffle and the reveal stack deal, drawn once
   per session. Canvas-less environments (SSR, jsdom) get the plain slot. */
let cardBackUrl: string | null | undefined;
function goatSlotBack(): string | null {
  if (cardBackUrl === undefined) {
    try {
      cardBackUrl = getCachedCardBackDataUrl();
    } catch {
      cardBackUrl = null;
    }
  }
  return cardBackUrl;
}

/* A GOATs album slot. The honorary roster is the one thing in the game you
   are meant to meet by pulling it, so a member you have not pulled stays
   face-down: the album says how many are still out there and nothing about
   who they are. Names, faces and the card itself arrive with the pull.

   Members already held show even before the collection finishes loading (the
   owned-keys set lands first), on the roster's own name and avatar - it is
   the reader's own card, so there is nothing left to keep from them. */
export const GoatSlot = memo(function GoatSlot({
  player,
  card,
  owned,
  thumbnail,
  lifted,
  onSpotlight,
  onThumbnailError,
}: {
  player: HonoraryPlayer;
  card: CollectedCard | null;
  owned: boolean;
  thumbnail: string | null;
  lifted: boolean;
  onSpotlight: (card: CollectedCard, thumbnail: string | null, rect: DOMRect) => void;
  onThumbnailError: (card: CollectedCard) => void;
}) {
  const { t } = useLingui();
  if (card) {
    return (
      <div
        className="relative w-full"
        style={{ aspectRatio: "5 / 7", visibility: lifted ? "hidden" : undefined }}
      >
        <CollectedCardFace
          card={card}
          thumbnail={thumbnail}
          onSpotlight={onSpotlight}
          onThumbnailError={onThumbnailError}
        />
      </div>
    );
  }

  const name = player.cardName ?? player.username;
  if (owned) {
    return (
      <div
        className="relative flex w-full flex-col items-center justify-center overflow-hidden rounded-[7px] border border-white/20 bg-osu-b4/70 px-1"
        style={{ aspectRatio: "5 / 7" }}
        title={name}
      >
        <img
          src={player.avatarUrl}
          alt=""
          className="h-1/2 w-auto rounded-full object-cover"
          loading="lazy"
          draggable={false}
        />
        <span className="mt-1.5 w-full truncate text-center text-[9px] font-semibold text-white">{name}</span>
      </div>
    );
  }

  const back = goatSlotBack();
  return (
    <div
      className="overflow-hidden rounded-[7px] bg-osu-b5"
      style={{ aspectRatio: "5 / 7" }}
      role="img"
      aria-label={t`Uncollected GOAT`}
      title={t`Not in your collection`}
    >
      {back && (
        <img src={back} alt="" className="h-full w-full object-cover opacity-80" draggable={false} />
      )}
    </div>
  );
});

/* Runs a router navigation after the next paint. Opening or closing an album
   swaps a large subtree, and navigate() re-matches the route and re-renders it
   synchronously: called straight from the handler, React batches the swap into
   that long task and the paint waits for both. rAF lands just before the
   paint, the timeout just after. Same shape, and the same reason, as the
   Grid/Album swap in routes/packs.tsx. */
function deferUrl(run: () => void) {
  window.requestAnimationFrame(() => {
    window.setTimeout(run, 0);
  });
}

export function AlbumView({
  wallet,
  syncStatus,
  trackedCountries,
  viewerId,
  openAlbumCode = null,
  scrollLinkedAlbumIntoView,
}: {
  wallet: PackWallet;
  syncStatus: "local" | "syncing" | "synced";
  trackedCountries: string[] | null;
  viewerId: number | null;
  /** Album the URL asks for, so one can be linked to rather than only reached
      by tapping the shelf. Null is the shelf. */
  openAlbumCode?: string | null;
  /** False when the packs page is restoring this subtree below a completed
      reveal. The album code is still in the URL then, but it is not a new
      navigation and must not pull the viewport away from the pack summary. */
  scrollLinkedAlbumIntoView: boolean;
}) {
  const { t, i18n } = useLingui();
  const sections = useMemo(() => buildAlbumSections(trackedCountries ?? []), [trackedCountries]);
  const linkedCode = openAlbumCode && sections.some((section) => section.code === openAlbumCode) ? openAlbumCode : null;
  /* Seeded from the URL when the shelf already knows the album, which is the
     warm case: no frame of shelf before the book. A cold bootstrap has no
     tracked countries yet, so the effect below opens it once they land. */
  const [openCode, setOpenCode] = useState<string | null>(linkedCode);
  const navigate = useNavigate();
  /* The album code this component last agreed with the URL about, in either
     direction. Not state: it only ever guards the sync effect below. */
  const urlAlbumRef = useRef<string | null>(openCode);
  /* Set only by the two URL-driven opens, never by a tap on the shelf: a
     reader who tapped is already looking at the right part of the page. */
  const scrollToAlbumRef = useRef(Boolean(linkedCode) && scrollLinkedAlbumIntoView);
  const rootRef = useRef<HTMLElement | null>(null);
  const [rosters, setRosters] = useState<Record<string, RosterData>>(() => {
    const seeded: Record<string, RosterData> = {};
    for (const [code, total] of Object.entries(readRosterTotalCache())) {
      seeded[code] = { total, entries: {}, chunks: {}, error: false };
    }
    return seeded;
  });
  const inflightRosters = useRef(new Set<string>());
  const [currentPage, setCurrentPage] = useState(0);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");
  const [bookReady, setBookReady] = useState(false);
  const [bookSettled, setBookSettled] = useState(false);
  const lastFlipAtRef = useRef(0);
  const bumpThumbnails = useFramePulse();
  const [serverOwned, setServerOwned] = useState<Set<number> | null>(null);
  const [serverOwnedGoats, setServerOwnedGoats] = useState<Set<number> | null>(null);
  /* A still-fresh session cache seeds the very first render, so remounting
     the album (tab away and back, route re-entry) never flashes the
     zero-count alphabetical shelf. Client-only: the cache can only be
     populated after hydration, so SSR and first client render agree. */
  const [serverCards, setServerCards] = useState<CollectedCard[] | null>(() =>
    serverCollectionCache && Date.now() - serverCollectionCache.at < SERVER_COLLECTION_TTL_MS
      ? serverCollectionCache.cards
      : null,
  );
  /* Read once per mount: only bridges the gap until the collection fetch
     lands. */
  const [seededShelfCounts] = useState(() => readShelfCountCache(viewerId));
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  /* The slot whose card is up in the spotlight. It stays hidden past close
     (spotlight becoming null) until the return flight lands, so the card is
     never on screen twice. Keyed by wallet card key, not player: a GOAT and
     an ordinary card of the same player are two cards, and in the GOATs
     album the slot holding one must not blank the other. */
  const [liftedCardKey, setLiftedCardKey] = useState<string | null>(null);
  const [peek, setPeek] = useState<PlayerPeekTarget | null>(null);
  const apiRef = useRef<FlipBookApi | null>(null);

  /* Local pulls layered over the server collection; local wins on overlap
     because it reflects this session's pulls immediately. */
  const collectedById = useMemo(() => {
    const map = new Map<number, CollectedCard>();
    for (const card of serverCards ?? []) map.set(card.userId, card);
    for (const card of ownedCards(wallet)) map.set(card.userId, card);
    return map;
  }, [wallet, serverCards]);

  /* The GOATs album collects the GOAT card specifically, not its player: a
     roster member who is still ranked can also be held as the ordinary card
     the pool dealt before they joined the roster, and that card is not the
     one this album is about. Same layering as above, local over server. */
  const goatCards = useMemo(() => {
    const map = new Map<number, CollectedCard>();
    for (const card of serverCards ?? []) {
      if (collectedCardTier(card) === "goat") map.set(card.userId, card);
    }
    for (const card of ownedCards(wallet)) {
      if (collectedCardTier(card) === "goat") map.set(card.userId, card);
    }
    return map;
  }, [wallet, serverCards]);

  const walletCountByCode = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const card of collectedById.values()) {
      const code = card.countryCode?.toUpperCase() ?? "";
      counts.set(code, (counts.get(code) ?? 0) + 1);
      total += 1;
    }
    counts.set(GLOBAL_SCOPE_CODE, total);
    counts.set(GOAT_ALBUM_CODE, goatCards.size);
    /* While the server collection is still loading, the live counts only
       see this session's local pulls; fill in the last-known counts (max
       per album: local pulls may not be in the persisted snapshot yet). */
    if (!serverCards && seededShelfCounts) {
      for (const [code, count] of seededShelfCounts) {
        if ((counts.get(code) ?? 0) < count) counts.set(code, count);
      }
    }
    return counts;
  }, [collectedById, goatCards, serverCards, seededShelfCounts]);

  /* Warm the flip engine chunk while the shelf is browsed, so opening an
     album doesn't wait on a dynamic import. */
  useEffect(() => {
    void import("page-flip").catch(() => {});
  }, []);

  /* The centering-shift transition switches on a couple of frames after the
     book reveals, so nothing about the reveal itself can animate. */
  useEffect(() => {
    if (!bookReady) {
      setBookSettled(false);
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setBookSettled(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [bookReady]);

  /* A synced account keeps its cards server-side; pull the full collection
     for real per-country counts and card art, with the owned-ids set as a
     fast first signal while pages stream in. */
  useEffect(() => {
    if (syncStatus === "local") return;
    let cancelled = false;
    void fetchServerPackCollectionOwnedKeys()
      .then((keys) => {
        if (cancelled || !keys) return;
        const parsed = keys.map(parsePackCardKey).filter((entry) => entry !== null);
        // A country album has one page per player, so a GOAT and an ordinary
        // card of the same player both just mean "owned" there. The GOATs
        // album only counts the GOAT itself, so it keeps its own set.
        setServerOwned(new Set(parsed.map((entry) => entry.userId)));
        setServerOwnedGoats(new Set(parsed.filter((entry) => entry.goat).map((entry) => entry.userId)));
      })
      .catch(() => {});
    void loadFullServerCollection()
      .then((cards) => {
        if (!cancelled && cards) setServerCards(cards);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [syncStatus]);

  /* Only full-collection counts are worth persisting; the seeded/local-only
     interim would just overwrite good data with zeros. */
  useEffect(() => {
    if (!serverCards) return;
    writeShelfCountCache(viewerId, walletCountByCode);
  }, [viewerId, serverCards, walletCountByCode]);

  const openSection = openCode ? sections.find((section) => section.code === openCode) ?? null : null;

  /* Arrow keys turn pages; Escape shelves the open album (unless an overlay
     is up, whose own Escape handler wins). The album stays mounted behind
     the Grid tab, so a hidden book must let these keys through: offsetParent
     goes null under a display:none ancestor. */
  useEffect(() => {
    if (!openSection) return;
    const onKey = (event: KeyboardEvent) => {
      if (rootRef.current?.offsetParent == null) return;
      if (event.key === "Escape") {
        if (!peek && !spotlight) setOpenCode(null);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.key === "ArrowLeft") apiRef.current?.flipPrev();
      else apiRef.current?.flipNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSection, peek, spotlight]);

  /* Load roster chunks for the open spread and its neighbors; the first
     chunk also reveals the roster size, which fixes the page count. The
     GOATs album has its roster checked in, so it needs none of this. */
  useEffect(() => {
    if (!openCode || isGoatAlbum(openCode) || !isLiveBackendConfigured()) return;
    const data = rosters[openCode];
    const wantedChunks = new Set<number>();
    if (!data || data.total === null) {
      if (data?.error) return;
      wantedChunks.add(1);
    } else {
      const limit = albumRosterLimit(openCode, data.total);
      if (limit === 0) return;
      const pages = slotPagesForRoster(limit);
      const maxChunk = chunkForSlot(limit - 1);
      for (let page = currentPage - 2; page <= currentPage + 3; page += 1) {
        if (page < 1 || page > pages) continue;
        const start = slotOffsetForPage(page);
        const end = Math.min(start + ALBUM_SLOTS_PER_PAGE - 1, limit - 1);
        if (end < start) continue;
        wantedChunks.add(Math.min(chunkForSlot(start), maxChunk));
        wantedChunks.add(Math.min(chunkForSlot(end), maxChunk));
      }
    }
    for (const chunk of wantedChunks) {
      if (data?.chunks[chunk]) continue;
      const key = `${openCode}:${chunk}`;
      if (inflightRosters.current.has(key)) continue;
      inflightRosters.current.add(key);
      const code = openCode;
      const fetchPage = isGlobalScope(code)
        ? fetchLiveGlobalRankings({ page: chunk, pageSize: ROSTER_CHUNK_SIZE })
        : fetchLiveRankingsSnapshot(code, { page: chunk, pageSize: ROSTER_CHUNK_SIZE });
      void fetchPage
        .then((snapshot) => {
          writeRosterTotalCache(code, snapshot.total);
          setRosters((prev) => {
            const current = prev[code] ?? { total: null, entries: {}, chunks: {}, error: false };
            const entries = { ...current.entries };
            snapshot.ranking.forEach((entry, index) => {
              entries[(chunk - 1) * ROSTER_CHUNK_SIZE + index] = entry;
            });
            return {
              ...prev,
              [code]: {
                total: snapshot.total,
                entries,
                chunks: { ...current.chunks, [chunk]: true },
                error: false,
              },
            };
          });
        })
        .catch(() => {
          setRosters((prev) => {
            const current = prev[code];
            // Partial data stays usable; only a failed first load blocks the
            // album. A total seeded from the persisted cache without any
            // fetched chunk does not count as data: drop it so the retry UI
            // shows instead of a book of placeholders that will never fill.
            if (current?.total != null && Object.keys(current.chunks).length > 0) return prev;
            return { ...prev, [code]: { total: null, entries: {}, chunks: {}, error: true } };
          });
        })
        .finally(() => {
          inflightRosters.current.delete(key);
        });
    }
  }, [openCode, currentPage, rosters]);

  /* Resolve card art for the loaded roster's collected cards: persisted
     cache, then the shared R2 pool, then a local render. */
  const goatOpen = isGoatAlbum(openCode);
  const openData = openCode ? rosters[openCode] : undefined;
  const spreadCards = useMemo(() => {
    // The whole GOATs album is two dozen slots, so its cards resolve as one set.
    if (goatOpen) return [...goatCards.values()].filter((card) => card.skills);
    if (!openData) return [] as CollectedCard[];
    return Object.values(openData.entries)
      .map((entry) => collectedById.get(entry.user.id))
      .filter((card): card is CollectedCard => Boolean(card?.skills));
  }, [goatOpen, goatCards, openData, collectedById]);

  const spreadSignature = spreadCards.map((card) => cardThumbnailKeyForCollectionCard(card)).join("|");

  useEffect(() => {
    if (spreadCards.length === 0) return;
    let cancelled = false;
    const missing = spreadCards
      .map((card) => ({ card, key: cardThumbnailKeyForCollectionCard(card) }))
      .filter((item): item is { card: CollectedCard; key: string } =>
        Boolean(item.key && !getMemoryCardThumbnail(item.key)),
      );
    if (missing.length === 0) return;

    void (async () => {
      const remote: Array<{ card: CollectedCard; key: string }> = [];
      await Promise.all(missing.map(async ({ card, key }) => {
        const cached = await loadPersistedCardThumbnail(key);
        if (cancelled) return;
        if (cached) bumpThumbnails();
        else remote.push({ card, key });
      }));
      if (cancelled || remote.length === 0) return;

      const urls = await loadR2CardThumbnails(remote.map((item) => item.key));
      if (cancelled) return;
      const toRender = remote.filter(({ key }) => {
        if (!urls[key]) return true;
        bumpThumbnails();
        return false;
      });
      await Promise.all(toRender.map(async ({ card }) => {
        try {
          const url = await renderAlbumThumbnail(card);
          if (!cancelled && url) bumpThumbnails();
        } catch {
          // The tier skeleton stays on this slot.
        }
      }));
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spreadSignature, bumpThumbnails]);

  /* A slot's remote thumbnail 404ed (the pool URL is built without an
     existence check, so a lifecycle-expired object surfaces here): evict the
     dead URL so the slot shows its skeleton, render the card locally, and let
     rememberCardThumbnailBlob re-upload it for the next viewer. One attempt
     per key per session; a failed render leaves the skeleton. */
  const onThumbnailError = useCallback((card: CollectedCard) => {
    const key = cardThumbnailKeyForCollectionCard(card);
    if (!key || !claimCardThumbnailErrorFallback(key)) return;
    forgetRemoteCardThumbnail(key);
    bumpThumbnails();
    renderAlbumThumbnail(card)
      .then((url) => {
        if (url) bumpThumbnails();
      })
      .catch(() => {});
  }, [bumpThumbnails]);

  /* Identity-stable so the memoized slots don't re-render on unrelated
     state changes. */
  const openSpotlight = useCallback((card: CollectedCard, thumbnail: string | null, rect: DOMRect) => {
    setSpotlight({
      card,
      thumbnail,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
    setLiftedCardKey(packCardKeyOf(card));
  }, []);
  const openPeek = useCallback((entry: LiveGlobalRankingEntry, owned: boolean) => {
    setPeek({ entry, owned });
  }, []);

  /* Identity-stable for the same reason, and declared up here because it is a
     prop of the memoized shelf and hooks cannot live below the early return. */
  const openAlbum = useCallback((code: string) => {
    /* Built inside the tap that opens an album, so the audio graph is warm by
       the first page turn instead of being constructed inside the flip
       engine's animation-end callback -- and still under a user gesture, so
       autoplay policy is satisfied. */
    warmPackAudio();
    urlAlbumRef.current = code;
    setOpenCode(code);
    setCurrentPage(0);
    setBookReady(false);
    /* The book opens in the tap's own render; the address bar catches up
       after, which is all it has to do to make the album linkable. An open
       album is its own view, so it drops `view` rather than carrying both. */
    deferUrl(() => navigate({
      to: "/packs",
      search: (prev) => ({ ...prev, view: undefined, album: code.toLowerCase() }),
      replace: true,
      resetScroll: false,
    }));
  }, [navigate]);

  /* A link arriving at an already-mounted album view, and the cold bootstrap
     the seed above could not cover. Keyed off the last code this component
     put in the URL (or took from it) so a shelf rebuild, which is a new
     `sections` identity, cannot reopen an album the reader just closed. */
  useEffect(() => {
    if (!openAlbumCode || urlAlbumRef.current === openAlbumCode) return;
    if (!sections.some((section) => section.code === openAlbumCode)) return;
    urlAlbumRef.current = openAlbumCode;
    scrollToAlbumRef.current = scrollLinkedAlbumIntoView;
    setOpenCode(openAlbumCode);
    setCurrentPage(0);
    setBookReady(false);
  }, [openAlbumCode, scrollLinkedAlbumIntoView, sections]);

  /* The album sits well below the pack opener, so a link to one has to bring
     it into frame or it lands the reader at the top of the page with nothing
     of what they clicked for on screen. One frame later, once the book has
     laid out and the section is its full height. */
  useEffect(() => {
    if (!openCode || !scrollToAlbumRef.current) return;
    scrollToAlbumRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openCode]);

  /* Nothing tracked means the shelf would be the two pinned albums and no
     country at all, which is the backend still waking up rather than a shelf. */
  if (
    !isLiveBackendConfigured() ||
    !trackedCountries ||
    !sections.some((section) => !isPinnedAlbum(section.code))
  ) {
    return (
      <div className="py-10 text-center text-[12px] text-osu-f1">
        <Trans>The album is unavailable right now. Try again in a bit.</Trans>
      </div>
    );
  }

  const closeAlbum = () => {
    urlAlbumRef.current = null;
    deferUrl(() => navigate({
      to: "/packs",
      search: (prev) => ({ ...prev, view: "album", album: undefined }),
      replace: true,
      resetScroll: false,
    }));
    setOpenCode(null);
    setPeek(null);
    setSpotlight(null);
  };

  /* The shelf stays mounted (just hidden) while an album is open, so going
     back to it costs nothing. The wrapper stays out here so toggling the class
     never re-renders the shelf itself. */
  const shelfView = (
    <div className={openSection ? "hidden" : undefined}>
      <AlbumShelf sections={sections} counts={walletCountByCode} onOpen={openAlbum} />
    </div>
  );

  const renderOpenAlbum = (openSection: AlbumSection) => {
  const global = isGlobalScope(openSection.code);
  const goat = isGoatAlbum(openSection.code);
  /* The GOATs roster is checked in, so its size is known before the book
     mounts and nothing about this album can fail to load. */
  const limit = goat
    ? GOAT_ALBUM_ROSTER.length
    : openData?.total != null
      ? albumRosterLimit(openSection.code, openData.total)
      : null;
  const slotPages = limit != null ? slotPagesForRoster(limit) : 2;
  const walletCount = walletCountByCode.get(openSection.code) ?? 0;
  const collectedShown = limit != null ? Math.min(walletCount, limit) : walletCount;
  /* The open book fronts the same cover the shelf shows: constant text, no
     progress. Anything roster-dependent would repaint the cover the moment the
     lookup lands; collection progress renders below the book instead. */
  const coverText = albumCountText(walletCountByCode, openSection.code, i18n);
  const coverSubtitle = albumSubtitle(openSection.code, i18n);
  const headerRight = global ? t`Top ${GLOBAL_ALBUM_CAP}` : limit != null ? `${collectedShown}/${limit}` : "";
  const rosterFailed = !goat && Boolean(openData?.error && openData.total === null);

  const albumPage = (pageIndex: number) => {
    const offset = slotOffsetForPage(pageIndex);
    return (
      <div
        key={`page-${pageIndex}`}
        data-album-page
        className="overflow-hidden rounded-[6px] border border-osu-b3/60 bg-osu-b4"
      >
        <div className="flex h-full flex-col px-3 pb-3 pt-2.5">
          <div className="mb-2 flex items-center gap-1.5">
            <AlbumMark code={openSection.code} />
            <span className="truncate text-[12px] font-bold text-white">{openSection.name}</span>
            <span className="ml-auto text-[10px] text-osu-f1 tabular-nums">{headerRight}</span>
          </div>
          <div className="grid grid-cols-3 content-start gap-1.5">
            {Array.from({ length: ALBUM_SLOTS_PER_PAGE }, (_, position) => {
              const slotIndex = offset + position;
              if (limit != null && slotIndex >= limit) {
                return (
                  <div key={position} className="rounded-[7px] bg-osu-b4/25" style={{ aspectRatio: "5 / 7" }} />
                );
              }
              if (goat) {
                const player = GOAT_ALBUM_ROSTER[slotIndex];
                const goatCard = goatCards.get(player.id) ?? null;
                return (
                  <GoatSlot
                    key={position}
                    player={player}
                    card={goatCard}
                    owned={Boolean(goatCard) || Boolean(serverOwnedGoats?.has(player.id))}
                    thumbnail={getMemoryCardThumbnail(
                      goatCard ? cardThumbnailKeyForCollectionCard(goatCard) : null,
                    )}
                    lifted={goatCard != null && packCardKeyOf(goatCard) === liftedCardKey}
                    onSpotlight={openSpotlight}
                    onThumbnailError={onThumbnailError}
                  />
                );
              }
              const entry = openData?.entries[slotIndex] ?? null;
              if (!entry) {
                return (
                  <div
                    key={position}
                    className="animate-pulse rounded-[7px] bg-osu-b3/40"
                    style={{ aspectRatio: "5 / 7" }}
                  />
                );
              }
              const card = collectedById.get(entry.user.id) ?? null;
              const key = card ? cardThumbnailKeyForCollectionCard(card) : null;
              return (
                <AlbumSlot
                  key={position}
                  entry={entry}
                  card={card}
                  serverOwned={Boolean(serverOwned?.has(entry.user.id))}
                  thumbnail={getMemoryCardThumbnail(key)}
                  lifted={card != null && packCardKeyOf(card) === liftedCardKey}
                  onSpotlight={openSpotlight}
                  onPeek={openPeek}
                  onThumbnailError={onThumbnailError}
                />
              );
            })}
          </div>
          <div className="mt-auto pt-1 text-right text-[9px] text-osu-f1/50 tabular-nums">{pageIndex}</div>
        </div>
      </div>
    );
  };

  const lastPageIndex = albumPageCount(slotPages) - 1;
  /* A closed book only occupies one half of the two-page block, so nudge the
     whole block sideways to keep the visible cover centered; the shift eases
     back as the book opens. */
  const bookShift = orientation === "landscape"
    ? currentPage === 0
      ? "-25%"
      : currentPage >= lastPageIndex
        ? "25%"
        : "0%"
    : "0%";

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={closeAlbum}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-full border border-osu-b3/40 bg-osu-b4/40 pl-1.5 pr-3 text-[12px] text-osu-f1 hover:bg-osu-b4/70 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" />
          <Trans>Albums</Trans>
        </button>
        <span className="flex items-center gap-1.5 text-[12px] font-bold text-white">
          <AlbumMark code={openSection.code} />
          {openSection.name}
        </span>
      </div>

      {/* album-book-stage/-standin size the waiting cover with the flip
          engine's own rule (portrait below 520px, landscape above), so the
          live book swaps in at exactly the stand-in's size on phones too. */}
      <div className="album-book-stage relative">
        {!bookReady && (
          <div className="album-cover-live album-book-standin mx-auto">
            <div className="overflow-hidden rounded-[6px]" style={{ aspectRatio: `${PAGE_WIDTH} / ${PAGE_HEIGHT}` }}>
              <AlbumCoverFace
                section={openSection}
                collectedText={coverText}
                subtitle={coverSubtitle}
              />
            </div>
          </div>
        )}
        {/* The book mounts once the roster size (and so the page count) is
            known; the static cover above covers the wait, so the swap-in is
            invisible and the page list never changes mid-mount. */}
        {/* The transform is applied while still hidden and the transition
            class only arrives a couple of frames after the reveal, so the
            book can never be seen gliding into its centered position. */}
        {/* The shift percentages are fractions of THIS element, so its width
            must equal the engine's block (100% capped at maxWidth * 2, here
            centered) or the -25% overshoots and the revealed cover lands a
            few pixels off the static stand-in. */}
        {limit != null && (
        <div
          className={`mx-auto ${bookSettled ? "transition-transform duration-500 ease-in-out " : ""}${
            bookReady ? "" : "pointer-events-none absolute inset-x-0 top-0 opacity-0"
          }`}
          style={{ transform: `translateX(${bookShift})`, maxWidth: MAX_PAGE_WIDTH * 2 }}
        >
          <FlipBook
            key={`${openSection.code}:${slotPages}`}
            pageWidth={PAGE_WIDTH}
            pageHeight={PAGE_HEIGHT}
            minPageWidth={MIN_PAGE_WIDTH}
            maxPageWidth={MAX_PAGE_WIDTH}
            onPageChange={(page) => {
              lastFlipAtRef.current = Date.now();
              setCurrentPage(page);
              playPageTurn();
            }}
            onOrientationChange={setOrientation}
            onReady={() => setBookReady(true)}
            apiRef={apiRef}
          >
            <div data-album-page data-density="hard" className="album-cover-live overflow-hidden rounded-[6px]">
              {/* Not a <button>: buttons are fenced off from the engine's
                  mouse handlers, and the cover must stay grabbable so a drag
                  can peel it open. A corner click makes the engine flip on
                  its own, so the click handler stands down right after any
                  flip to avoid turning two pages. */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (Date.now() - lastFlipAtRef.current > 350) apiRef.current?.flipNext();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") apiRef.current?.flipNext();
                }}
                className="block h-full w-full cursor-pointer text-left"
                aria-label={t`Open the album`}
              >
                <AlbumCoverFace
                  section={openSection}
                  collectedText={coverText}
                  subtitle={coverSubtitle}
                />
              </div>
            </div>
            {Array.from({ length: slotPages }, (_, index) => albumPage(index + 1))}
            <div data-album-page data-density="hard" className="album-cover-live overflow-hidden rounded-[6px]">
              <AlbumBackFace section={openSection} />
            </div>
          </FlipBook>
        </div>
        )}
        {rosterFailed && (
          <div className="mt-4 text-center text-[12px] text-osu-f1">
            <Trans>The rankings lookup failed.</Trans>{" "}
            <button
              type="button"
              onClick={() => {
                setRosters((prev) => {
                  const next = { ...prev };
                  delete next[openSection.code];
                  return next;
                });
              }}
              className="cursor-pointer font-semibold text-osu-pink-light hover:text-white"
            >
              <Trans>Retry</Trans>
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => apiRef.current?.flipPrev()}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-osu-b3/40 bg-osu-b4/40 text-osu-f1 hover:bg-osu-b4/70 hover:text-white"
          aria-label={t`Previous album page`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-[11px] text-osu-f1"><Trans>Drag a page or swipe to flip</Trans></span>
        <button
          type="button"
          onClick={() => apiRef.current?.flipNext()}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-osu-b3/40 bg-osu-b4/40 text-osu-f1 hover:bg-osu-b4/70 hover:text-white"
          aria-label={t`Next album page`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Collection progress, moved off the cover so it can arrive with the
          roster lookup without repainting the book. The block occupies its
          full height from the first frame (invisible while the roster size
          is unknown) so its arrival never pushes the page around. */}
      {!global && limit !== 0 && (
        <div className={`mx-auto mt-4 w-[min(60%,320px)]${limit == null ? " invisible" : ""}`}>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.24em] text-[#e8c56a]">
              {goat ? <Trans>{limit ?? 0} goats</Trans> : <Trans>{limit ?? 0} players</Trans>}
            </span>
            <span className="text-[11px] font-bold text-white/80 tabular-nums">
              <Trans>{collectedShown}/{limit ?? 0} collected</Trans>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-[3px] bg-white/10">
            <div
              className="h-full rounded-[3px]"
              style={{
                width: limit == null ? "0%" : `${Math.max(2, Math.min(100, (collectedShown / limit) * 100))}%`,
                background: GOLD,
              }}
            />
          </div>
        </div>
      )}

    </div>
  );
  };

  return (
    /* select-none: a page drag that leaves the book must not sweep a text
       selection across the whole album (the filter input opts back in). */
    <section ref={rootRef} className="mx-auto w-full max-w-[900px] select-none">
      <CoverTriangleDefs />
      {shelfView}
      {openSection && renderOpenAlbum(openSection)}
      <PlayerPeek target={peek} onClose={() => setPeek(null)} />
      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedCardKey(null)}
      />
    </section>
  );
}
