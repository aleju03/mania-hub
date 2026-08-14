import { createFileRoute, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronDown, Layers, Lock, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ManiaRain } from "../components/home/ManiaRain";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { SkinCard } from "../components/skins/SkinCard";
import { SkinBulkUploadModal } from "../components/skins/SkinBulkUploadModal";
import { SkinUploadModal } from "../components/skins/SkinUploadModal";
import { Pagination } from "../components/ui/Pagination";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { OsuLogo } from "../components/ui/OsuLogo";
import { useAuth } from "../lib/auth-context";
import { isAdmin } from "../lib/auth-shared";
import { isLiveBackendConfigured } from "../lib/live-backend";
import {
  fetchPrivateSkinsShelf,
  fetchSkinsListDirect,
  fetchSkinsListSsr,
  isSkinNoteShape,
  isSkinsSort,
  normalizeSkinResolution,
  readCachedPrivateShelf,
  readCachedSkinsList,
  readPrivateShelfOpen,
  readRememberedPrivateShelfSize,
  skinsListCacheKey,
  SKINS_PAGE_SIZE,
  writeCachedPrivateShelf,
  writeCachedSkinsList,
  writePrivateShelfOpen,
  type SkinNoteShape,
  type SkinsListResult,
  type SkinsSort,
  type SkinSummary,
} from "../lib/skins";
import { pageSeo } from "../lib/seo";

// All fields optional at the type level so links can target /skins without a
// search object; validateSearch still normalizes every field on read.
interface SkinsSearch {
  q?: string;
  page?: number;
  sort?: SkinsSort;
  k?: number;
  // The 7K+1 refinement of k=8: true narrows to skins whose eighth column is
  // a scratch lane; false makes 8K mean actual 8K. Meaningless off k=8.
  special?: boolean;
  // "uploader: you": the grid narrows to the signed-in viewer's own uploads.
  // Nobody's id is in the URL, so the filter travels as a plain flag and means
  // whoever is signed in when the link is opened; signed out it means nothing.
  mine?: boolean;
  // The trait filters, each narrowing to skins the backend's archive analysis
  // said yes about: ships a lane cover, ships its own mania stage art, has
  // screenshots attached.
  cover?: boolean;
  stage?: boolean;
  shots?: boolean;
  // Which client the skin is for. The UI presents one axis: any, stable, or
  // lazer. The two booleans keep the existing compact URL shape.
  lazer?: boolean;
  stable?: boolean;
  // What the tap notes are; "" is any.
  shape?: SkinNoteShape | "";
  // Recommended resolution, normalized "1920x1080"; "" is any.
  res?: string;
}

const DEFAULT_SKINS_SEARCH = {
  q: "",
  page: 0,
  sort: "newest" as SkinsSort,
  k: 0,
  special: false,
  mine: false,
  cover: false,
  stage: false,
  shots: false,
  lazer: false,
  stable: false,
  shape: "" as SkinNoteShape | "",
  res: "",
};

// One entry per sort option, each holding both of its directions: picking an
// option sorts it descending, clicking it again flips to ascending. Only the
// date option renames itself, because "oldest" is the word for it; the other
// two are nouns that read the same either way and let the arrow say which.
const SORT_OPTIONS: Array<{ label: string; ascLabel?: string; desc: SkinsSort; asc: SkinsSort }> = [
  { label: "newest", ascLabel: "oldest", desc: "newest", asc: "oldest" },
  { label: "downloads", desc: "downloads", asc: "downloads-asc" },
  { label: "size", desc: "size", asc: "size-asc" },
];

// The note-shape chips, labelled by what the notes are called in the wild.
// "other" is everything the classifier could not call a circle, arrow or bar.
const NOTE_SHAPE_FILTERS: Array<{ label: string; shape: SkinNoteShape }> = [
  { label: "circles", shape: "circle" },
  { label: "arrows", shape: "arrow" },
  { label: "bars", shape: "bar" },
  { label: "other", shape: "other" },
];

// 0 means no keymode filter; the options cover the keymodes skins realistically
// declare. 8K splits into 7K+1 (scratch-lane layouts) and actual 8K.
const KEYMODE_FILTERS: Array<{ label: string; k: number; special: boolean }> = [
  { label: "4K", k: 4, special: false },
  { label: "5K", k: 5, special: false },
  { label: "6K", k: 6, special: false },
  { label: "7K", k: 7, special: false },
  { label: "7K+1", k: 8, special: true },
  { label: "8K", k: 8, special: false },
  { label: "9K", k: 9, special: false },
  { label: "10K", k: 10, special: false },
];

// The truthy forms a boolean search param arrives in from a typed URL.
function searchFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function parseSkinsSearch(search: Record<string, unknown>): SkinsSearch {
  const q = typeof search.q === "string" ? search.q.slice(0, 80) : DEFAULT_SKINS_SEARCH.q;
  const page = Number(search.page);
  const rawK = Number(search.k);
  const k = Number.isInteger(rawK) && rawK >= 1 && rawK <= 10 ? rawK : DEFAULT_SKINS_SEARCH.k;
  const rawLazer = searchFlag(search.lazer);
  const rawStable = searchFlag(search.stable);
  return {
    q,
    page: Number.isInteger(page) && page > 0 ? page : DEFAULT_SKINS_SEARCH.page,
    sort: isSkinsSort(search.sort) ? search.sort : DEFAULT_SKINS_SEARCH.sort,
    k,
    special: k === 8 && searchFlag(search.special),
    mine: searchFlag(search.mine),
    cover: searchFlag(search.cover),
    stage: searchFlag(search.stage),
    shots: searchFlag(search.shots),
    // Old links may carry both flags. That always meant no backend filter, so
    // normalize it to the explicit "any" state instead of showing ambiguity.
    lazer: rawLazer && !rawStable,
    stable: rawStable && !rawLazer,
    shape: isSkinNoteShape(search.shape) ? search.shape : DEFAULT_SKINS_SEARCH.shape,
    res: typeof search.res === "string" ? (normalizeSkinResolution(search.res) ?? DEFAULT_SKINS_SEARCH.res) : DEFAULT_SKINS_SEARCH.res,
  };
}

// Whether a /skins URL is the plain browse view the loader server-renders.
// Anything filtered, paged or sorted paints from the effect the way it always
// has: those URLs are not in the sitemap and no crawler lands on one.
export function isDefaultSkinsView(search: SkinsSearch): boolean {
  return !search.q && !search.page && !search.k && !search.mine
    && !search.cover && !search.stage && !search.shots && !search.lazer && !search.stable
    && !search.shape && !search.res
    && (search.sort ?? "newest") === "newest";
}

export const Route = createFileRoute("/skins")({
  loaderDeps: ({ search }) => ({ isDefault: isDefaultSkinsView(search) }),
  loader: async ({ deps }): Promise<SkinsListResult | null> => {
    // SSR only: on client navigations the effect below owns the data, so the
    // loader skipping keeps navigation instant and avoids a duplicate fetch.
    if (typeof document !== "undefined") return null;
    if (!deps.isDefault) return null;
    // The grid ships inside the HTML so the page has its skins, and 24 links
    // into their pages, before any JS runs. A null here is the old behaviour:
    // skeletons until the effect lands.
    return await fetchSkinsListSsr();
  },
  head: ({ match }) => pageSeo({
    title: "osu!mania skins",
    description: "Browse and download osu!mania skins with previews rendered from each skin's own notes, or publish a skin from an .osk file.",
    path: "/skins",
    origin: match.context.origin,
    imageKind: "skins",
  }),
  search: {
    middlewares: [stripSearchParams(DEFAULT_SKINS_SEARCH)],
  },
  validateSearch: parseSkinsSearch,
  component: SkinsPage,
});

// osu-web beatmapsets-listing filter row: micro-label on the left, options as
// plain text links, the active one white.
function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="w-14 shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/45">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3.5 gap-y-1">{children}</div>
    </div>
  );
}

function FilterOption({
  active,
  onClick,
  direction,
  children,
}: {
  active: boolean;
  onClick: () => void;
  // A sort option carries the direction it is currently ordered in; the arrow
  // only shows while the option is active, so the row still reads as plain text
  // apart from the one sort in force.
  direction?: "asc" | "desc";
  children: React.ReactNode;
}) {
  const Arrow = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-baseline gap-0.5 text-[12.5px] tabular-nums transition-colors cursor-pointer ${
        active ? "font-bold text-white" : "font-medium text-osu-f1/75 hover:text-osu-pink-light"
      }`}
    >
      {children}
      {active && direction && (
        <>
          <Arrow className="h-3 w-3 self-center" aria-hidden="true" />
          <span className="sr-only">{direction === "desc" ? "descending" : "ascending"}</span>
        </>
      )}
    </button>
  );
}

function SkinCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-1.5 px-2.5 py-2">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

function SkinsPage() {
  const {
    q = "", page = 0, sort = "newest", k = 0, special = false, mine = false,
    cover = false, stage = false, shots = false, lazer = false, stable = false, shape = "", res = "",
  } = Route.useSearch();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const admin = isAdmin(auth);
  const viewerId = auth.viewer?.id ?? null;

  // Only an 8K filter carries a layout refinement: "special" is the 7K+1 chip,
  // "regular" keeps actual-8K skins ahead of the 7K+1 ones sharing the keymode.
  const variant = k === 8 ? (special ? "special" as const : "regular" as const) : undefined;
  // The list stays the public one, so this is the viewer's public uploads; the
  // private ones are on the shelf above the grid either way. Signed out the
  // flag has nobody to point at, so it filters nothing.
  const owner = mine ? viewerId : null;
  const mineActive = owner != null;
  // Whether anything beyond the plain browse view is narrowing the grid, for
  // the empty state's wording and for where a fresh publish may land.
  const traitFilterCount = [cover, stage, shots, lazer !== stable, Boolean(shape), Boolean(res)].filter(Boolean).length;
  const traitFiltersActive = traitFilterCount > 0;
  // One client axis: only a lone flag narrows anything. Neither is every skin,
  // and parseSkinsSearch normalizes legacy links carrying both back to neither.
  const client = lazer !== stable ? (lazer ? "lazer" as const : "stable" as const) : undefined;
  const shapeParam = shape || undefined;
  const resParam = res || undefined;

  // The server-rendered grid, present only on a cold load of the plain browse
  // view; every other URL, and every client navigation, gets null here.
  const ssrList = Route.useLoaderData();
  const ssrSeeded = ssrList != null && isDefaultSkinsView({ q, page, sort, k, mine, cover, stage, shots, lazer, stable, shape, res });

  // Seeded from the in-memory list cache so walking back from a skin page
  // paints the same grid it left, not a screen of skeletons. Failing that, the
  // server-rendered page starts on its own skins rather than on skeletons it
  // would replace a moment later.
  const [data, setData] = useState<SkinsListResult | null>(
    () => readCachedSkinsList(skinsListCacheKey({ q, page, sort, k, variant, owner, cover, stage, shots, client, shape: shapeParam, res: resParam }))
      ?? (ssrSeeded ? ssrList : null),
  );
  const [loading, setLoading] = useState(!ssrSeeded);
  // Consumed by the first run of the list effect, which the server render has
  // already satisfied. A ref, not state, so spending it never re-renders.
  const ssrHandled = useRef(ssrSeeded);
  const [failed, setFailed] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [showBulkUploader, setShowBulkUploader] = useState(false);
  // Private skins are absent from the list everyone else reads, so their
  // uploader gets them on a shelf of their own above the grid; without it
  // there would be no way back to their pages. An admin's shelf is every
  // uploader's private skins, for moderation.
  const [privateSkins, setPrivateSkins] = useState<SkinSummary[]>([]);
  const [privateTotal, setPrivateTotal] = useState(0);
  // Cards the shelf is expected to hold while its fetch is in flight, taken
  // from what it held last visit, so the grid below keeps its place.
  const [privatePending, setPrivatePending] = useState(0);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(q);
  const [reloadTick, setReloadTick] = useState(0);
  // The trait rows (notes, includes, display) fold away, so the browse view
  // keeps the two short rows it always had and the rest is one click down.
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(traitFiltersActive);

  // The resolutions worth offering are the ones the catalog answers to, which
  // the list ships as a facet. A filter already in the URL joins them either
  // way, so it can always be seen and cleared.
  const resolutionOptions = (() => {
    const options = data?.resolutions ?? [];
    return res && !options.includes(res) ? [...options, res] : options;
  })();

  const applySearch = useCallback(
    (patch: SkinsSearch) => {
      void navigate({
        to: "/skins",
        search: { q, sort, k, special, mine, cover, stage, shots, lazer, stable, shape, res, page: 0, ...patch },
        replace: true,
      });
    },
    [navigate, q, sort, k, special, mine, cover, stage, shots, lazer, stable, shape, res],
  );

  // A link into a filtered URL opens the drawer, so nothing narrows the grid
  // from behind a fold. Collapsing it again is left alone: the toggle counts
  // what is still on.
  useEffect(() => {
    if (traitFiltersActive) setMoreFiltersOpen(true);
  }, [traitFiltersActive]);

  // Debounced text search: typing updates local state, the URL follows.
  useEffect(() => {
    setSearchInput(q);
  }, [q]);
  useEffect(() => {
    if (searchInput === q) return;
    const timer = setTimeout(() => applySearch({ q: searchInput }), 350);
    return () => clearTimeout(timer);
  }, [searchInput, q, applySearch]);

  useEffect(() => {
    if (!isLiveBackendConfigured()) {
      setLoading(false);
      setFailed(true);
      return;
    }
    const cacheKey = skinsListCacheKey({ q, page, sort, k, variant, owner, cover, stage, shots, client, shape: shapeParam, res: resParam });
    // The server-rendered grid is already on screen and was fetched for this
    // very request, so the first pass has nothing to do: fetching here would
    // pull the same 24 rows a second time, once in the HTML and once over the
    // wire. It still enters the memory cache, so coming back from a skin page
    // repaints from it. Any later pass (a filter, a retry) fetches normally.
    if (ssrHandled.current) {
      ssrHandled.current = false;
      if (ssrList) writeCachedSkinsList(cacheKey, ssrList);
      setLoading(false);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    // A cached page shows immediately and the fetch behind it only swaps the
    // data in; without one this is a cold load and the skeletons are honest.
    const cached = readCachedSkinsList(cacheKey);
    if (cached) setData(cached);
    setLoading(!cached);
    setFailed(false);
    // One list for everyone, straight from the backend and cacheable there.
    fetchSkinsListDirect({ q, page, sort, k, variant, owner, cover, stage, shots, client, shape: shapeParam, res: resParam }, { signal: controller.signal })
      .then((result) => {
        writeCachedSkinsList(cacheKey, result);
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        // With a cached page on screen, a failed revalidation stays silent.
        if (!cached) setFailed(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [q, page, sort, k, variant, owner, cover, stage, shots, client, shapeParam, resParam, reloadTick, ssrList]);

  useEffect(() => {
    if (!viewerId || !isLiveBackendConfigured()) {
      setPrivateSkins([]);
      setPrivateTotal(0);
      setPrivatePending(0);
      return;
    }
    setPrivateOpen(readPrivateShelfOpen() ?? !admin);
    // Same trick the grid plays: a cached shelf shows at once and the fetch
    // only swaps it, and failing that its remembered size stands in.
    const cached = readCachedPrivateShelf(viewerId);
    if (cached) {
      setPrivateSkins(cached.skins);
      setPrivateTotal(cached.total);
    }
    setPrivatePending(cached ? 0 : readRememberedPrivateShelfSize(viewerId));
    let cancelled = false;
    void fetchPrivateSkinsShelf()
      .then((shelf) => {
        writeCachedPrivateShelf(viewerId, shelf);
        if (cancelled) return;
        setPrivateSkins(shelf.skins);
        setPrivateTotal(shelf.total);
        setPrivatePending(0);
      })
      .catch(() => {
        if (!cancelled) setPrivatePending(0);
      });
    return () => {
      cancelled = true;
    };
  }, [viewerId, admin, reloadTick]);

  const togglePrivateShelf = useCallback(() => {
    const next = !privateOpen;
    setPrivateOpen(next);
    writePrivateShelfOpen(next);
  }, [privateOpen]);

  const handlePublished = useCallback((skin: SkinSummary) => {
    if (skin.visibility === "private") {
      // It will never show up in the grid below, so the shelf is where the
      // uploader sees that it landed, open whether or not they left it shut.
      setPrivateSkins((previous) => [skin, ...previous.filter((entry) => entry.id !== skin.id)]);
      setPrivateTotal((previous) => previous + 1);
      setPrivateOpen(true);
      return;
    }
    // Land the fresh skin at the top of an unfiltered first page.
    setData((previous) =>
      previous && page === 0 && !q && !k && !traitFiltersActive
        ? { ...previous, total: previous.total + 1, skins: [skin, ...previous.skins].slice(0, SKINS_PAGE_SIZE) }
        : previous,
    );
  }, [page, q, k, traitFiltersActive]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;
  const skins = data?.skins ?? [];

  const headerAction = auth.viewer ? (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      {/* Seeding the site is an owner job, so the bulk queue is admin-only. */}
      {admin && (
        <button
          type="button"
          onClick={() => setShowBulkUploader(true)}
          title="Publish a whole folder of .osk files in one run"
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-osu-pink/45 bg-osu-pink/10 px-3.5 py-1.5 text-[12.5px] font-bold text-osu-pink-light transition-colors cursor-pointer hover:bg-osu-pink/20 hover:text-white"
        >
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          Bulk
        </button>
      )}
      <button
        type="button"
        onClick={() => setShowUploader(true)}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-osu-pink px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 sm:w-auto"
      >
        <Upload className="h-3.5 w-3.5" aria-hidden="true" />
        Upload skin
      </button>
    </div>
  ) : auth.loginAvailable ? (
    <a
      href={loginHref}
      className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-osu-pink/45 bg-osu-pink/15 px-4 py-1.5 text-[12.5px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white sm:w-auto"
      title="Log in with osu! to upload a skin"
    >
      <OsuLogo className="h-3.5 w-3.5" />
      Log in to upload
    </a>
  ) : null;

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        {/* The home page's falling notes; skins are about notes, after all. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <ManiaRain />
        </div>
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/skins.svg" title="osu!mania skins" right={headerAction} />

          {/* Search strip, the beatmapsets-listing pattern: big search box with
              filter rows as plain text options below it. No surface of its own
              so the falling notes show through, like the home hero. */}
          <div className="border-b border-osu-b3/30">
            <div className="mx-auto w-full max-w-[1200px] px-4 py-3.5 sm:px-5">
              <div className="relative">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-osu-f1/50"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search skin, creator, or uploader"
                  aria-label="Search skins"
                  className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 py-2.5 pl-10 pr-3 text-[14px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none"
                />
              </div>

              <div className="mt-3.5 flex flex-col gap-2">
                <FilterRow label="keys">
                  <FilterOption active={k === 0} onClick={() => applySearch({ k: 0, special: false })}>
                    any
                  </FilterOption>
                  {KEYMODE_FILTERS.map((option) => {
                    const active = k === option.k && special === option.special;
                    return (
                      <FilterOption
                        key={option.label}
                        active={active}
                        onClick={() => applySearch(active ? { k: 0, special: false } : { k: option.k, special: option.special })}
                      >
                        {option.label}
                      </FilterOption>
                    );
                  })}
                  {/* The trait rows sit behind this, at the end of the first
                      row rather than on a line of its own: they are the ones
                      you go looking for, not the ones you browse past. */}
                  <button
                    type="button"
                    onClick={() => setMoreFiltersOpen((open) => !open)}
                    aria-expanded={moreFiltersOpen}
                    className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-osu-f1/75 transition-colors cursor-pointer hover:text-osu-pink-light"
                  >
                    {moreFiltersOpen ? "fewer filters" : "more filters"}
                    {!moreFiltersOpen && traitFilterCount > 0 && (
                      <span className="tabular-nums text-white">{traitFilterCount}</span>
                    )}
                    <ChevronDown
                      className={`h-3 w-3 self-center transition-transform ${moreFiltersOpen ? "" : "-rotate-90"}`}
                      aria-hidden="true"
                    />
                  </button>
                </FilterRow>
                {moreFiltersOpen && (
                  /* Two columns rather than four more stacked rows: the extra
                     axes read as one banded group off to the side of the ones
                     that are always on, instead of extending the same column
                     of grey words further down the page. */
                  <div className="mt-1 grid gap-x-12 gap-y-2 border-y border-osu-b3/25 py-2.5 sm:grid-cols-2">
                    {/* What the tap notes are, classified from each skin's own
                        note art. One shape at a time; picking the active one
                        clears it. */}
                    <FilterRow label="notes">
                      <FilterOption active={!shape} onClick={() => applySearch({ shape: "" })}>
                        any
                      </FilterOption>
                      {NOTE_SHAPE_FILTERS.map((option) => (
                        <FilterOption
                          key={option.shape}
                          active={shape === option.shape}
                          onClick={() => applySearch({ shape: shape === option.shape ? "" : option.shape })}
                        >
                          {option.label}
                        </FilterOption>
                      ))}
                    </FilterRow>
                    {/* Independent checkboxes: each chip narrows to skins that
                        ship the thing. */}
                    <FilterRow label="includes">
                      <FilterOption active={cover} onClick={() => applySearch({ cover: !cover })}>
                        lane cover
                      </FilterOption>
                      <FilterOption active={stage} onClick={() => applySearch({ stage: !stage })}>
                        mania stage
                      </FilterOption>
                      <FilterOption active={shots} onClick={() => applySearch({ shots: !shots })}>
                        screenshots
                      </FilterOption>
                    </FilterRow>
                    {/* Client compatibility is a pick-one axis, not something
                        the archive "includes". */}
                    <FilterRow label="client">
                      <FilterOption
                        active={!stable && !lazer}
                        onClick={() => applySearch({ stable: false, lazer: false })}
                      >
                        any
                      </FilterOption>
                      <FilterOption
                        active={stable}
                        onClick={() => applySearch({ stable: !stable, lazer: false })}
                      >
                        stable
                      </FilterOption>
                      <FilterOption
                        active={lazer}
                        onClick={() => applySearch({ lazer: !lazer, stable: false })}
                      >
                        lazer
                      </FilterOption>
                    </FilterRow>
                    {/* The resolution the uploader said the skin is made for,
                        offered as the ones uploaders have actually answered.
                        Nobody has answered yet, no row. */}
                    {resolutionOptions.length > 0 && (
                      <FilterRow label="display">
                        <FilterOption active={!res} onClick={() => applySearch({ res: "" })}>
                          any
                        </FilterOption>
                        {resolutionOptions.map((option) => (
                          <FilterOption
                            key={option}
                            active={res === option}
                            onClick={() => applySearch({ res: res === option ? "" : option })}
                          >
                            {option}
                          </FilterOption>
                        ))}
                      </FilterRow>
                    )}
                  </div>
                )}
                {/* Only worth a row to someone who has an account to filter
                    by; signed out there is no "you". */}
                {auth.viewer && (
                  <FilterRow label="uploader">
                    <FilterOption active={!mineActive} onClick={() => applySearch({ mine: false })}>
                      anyone
                    </FilterOption>
                    <FilterOption active={mineActive} onClick={() => applySearch({ mine: true })}>
                      you
                    </FilterOption>
                  </FilterRow>
                )}
                <FilterRow label="sort by">
                  {SORT_OPTIONS.map((option) => {
                    const direction = sort === option.desc ? "desc" as const : sort === option.asc ? "asc" as const : undefined;
                    return (
                      <FilterOption
                        key={option.label}
                        active={direction != null}
                        direction={direction}
                        onClick={() => applySearch({ sort: direction === "desc" ? option.asc : option.desc })}
                      >
                        {direction === "asc" ? option.ascLabel ?? option.label : option.label}
                      </FilterOption>
                    );
                  })}
                  {data && (
                    <span
                      className={`ml-auto text-[12px] text-osu-f1 tabular-nums transition-opacity ${loading ? "opacity-45" : ""}`}
                      role="status"
                      aria-live="polite"
                    >
                      {data.total.toLocaleString()} {data.total === 1 ? "skin" : "skins"}
                    </span>
                  )}
                </FilterRow>
              </div>
            </div>
          </div>

          <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 sm:px-5">
            {(privateSkins.length > 0 || privatePending > 0) && (
              <div className="mb-6">
                <h2 className="mb-2">
                  <button
                    type="button"
                    onClick={togglePrivateShelf}
                    aria-expanded={privateOpen}
                    className="group inline-flex items-center gap-2 text-left cursor-pointer"
                  >
                    <Lock className="h-3.5 w-3.5 shrink-0 text-osu-f1/55" aria-hidden="true" />
                    {/* An admin's shelf carries every uploader's private skins,
                        so it says so rather than claiming they are theirs. */}
                    <span className="text-[13px] font-bold text-white transition-colors group-hover:text-osu-pink-light">
                      {admin ? "Private skins" : "Your private skins"}
                    </span>
                    {privateSkins.length > 0 && (
                      <span className="text-[11px] text-osu-f1 tabular-nums">
                        {admin
                          ? privateTotal > privateSkins.length
                            ? `${privateSkins.length} of ${privateTotal.toLocaleString()}, every uploader`
                            : `${privateTotal.toLocaleString()} across every uploader`
                          : "only you can open these"}
                      </span>
                    )}
                    <ChevronDown
                      className={`h-3.5 w-3.5 shrink-0 text-osu-f1/55 transition-[transform,color] group-hover:text-osu-pink-light ${privateOpen ? "" : "-rotate-90"}`}
                      aria-hidden="true"
                    />
                  </button>
                </h2>
                {privateOpen && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {privateSkins.length > 0
                      ? privateSkins.map((skin) => <SkinCard key={skin.id} skin={skin} showUploader={admin} />)
                      : Array.from({ length: privatePending }, (_, index) => <SkinCardSkeleton key={index} />)}
                  </div>
                )}
              </div>
            )}
            {loading && !data ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 9 }, (_, index) => (
                  <SkinCardSkeleton key={index} />
                ))}
              </div>
            ) : failed ? (
              <div className="mx-auto max-w-md px-4 py-16 text-center">
                <div className="text-sm font-bold text-white">Skins are unavailable right now</div>
                <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">The skins list could not be loaded.</p>
                <button
                  type="button"
                  onClick={() => setReloadTick((tick) => tick + 1)}
                  className="mt-4 rounded-full bg-osu-pink px-5 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110"
                >
                  Retry
                </button>
              </div>
            ) : skins.length === 0 ? (
              <div className="mx-auto max-w-md px-4 py-16 text-center">
                <div className="text-sm font-bold text-white">
                  {mineActive && !q && !k && !traitFiltersActive
                    ? "You have not published a skin yet"
                    : q || k || mineActive || traitFiltersActive ? "No skins match" : "No skins yet"}
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
                  {mineActive && !q && !k && !traitFiltersActive
                    ? privateSkins.length > 0
                      ? "Your private skins are on the shelf above; anything you publish lands here."
                      : "Upload a skin and it lands here."
                    : q || k || mineActive || traitFiltersActive
                      ? "Clear the filters, or upload the skin yourself."
                      : "The first uploaded skin lands here."}
                </p>
              </div>
            ) : (
              <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {skins.map((skin) => (
                    // An explicit keymode fronts its own render (7K+1 is the
                    // 8K one). Without one, SkinCard uses the note-shape
                    // proof keymode returned for mixed skins by the backend.
                    <SkinCard key={skin.id} skin={skin} previewKeys={k >= 1 ? k : undefined} />
                  ))}
                </div>
                <Pagination page={page} totalPages={totalPages} onPageChange={(next) => applySearch({ page: next })} />
              </div>
            )}
          </div>
        </div>
      </div>

      <SkinUploadModal
        open={showUploader && !!auth.viewer}
        onClose={() => setShowUploader(false)}
        onPublished={handlePublished}
      />
      <SkinBulkUploadModal
        open={showBulkUploader && admin}
        onClose={() => setShowBulkUploader(false)}
        onPublished={handlePublished}
      />
    </div>
  );
}
