import { createFileRoute, Link, notFound, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, Check, ChevronDown, Layers, Lock, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
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
import { useBodyScrollLock } from "../lib/use-body-scroll-lock";
import { useScrollRestoreRef } from "../lib/use-scroll-restore";
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
// date option renames itself, because "oldest" is the word for it; the others
// are nouns that read the same either way and let the arrow say which.
const SORT_OPTIONS: Array<{ key: string; label: ReturnType<typeof msg>; ascLabel?: ReturnType<typeof msg>; desc: SkinsSort; asc: SkinsSort }> = [
  { key: "newest", label: msg`newest`, ascLabel: msg`oldest`, desc: "newest", asc: "oldest" },
  { key: "downloads", label: msg`downloads`, desc: "downloads", asc: "downloads-asc" },
  { key: "views", label: msg`views`, desc: "views", asc: "views-asc" },
  { key: "size", label: msg`size`, desc: "size", asc: "size-asc" },
];

// Every filter in the rail back at its default; search text and sort stay.
const CLEARED_FILTERS = {
  k: 0, special: false, mine: false, cover: false, stage: false, shots: false,
  lazer: false, stable: false, shape: "" as const, res: "",
};

// The note-shape chips, labelled by what the notes are called in the wild.
// "other" is everything the classifier could not call a circle, arrow or bar.
const NOTE_SHAPE_FILTERS: Array<{ label: ReturnType<typeof msg>; shape: SkinNoteShape }> = [
  { label: msg`circles`, shape: "circle" },
  { label: msg`arrows`, shape: "arrow" },
  { label: msg`bars`, shape: "bar" },
  { label: msg`other`, shape: "other" },
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

// Every page of the unfiltered newest catalogue is crawlable. Filtered and
// sorted views stay client-fetched and noindexed to avoid duplicate listings.
export function isSkinsBrowseView(search: SkinsSearch): boolean {
  return !search.q && !search.k && !search.mine
    && !search.cover && !search.stage && !search.shots && !search.lazer && !search.stable
    && !search.shape && !search.res
    && (search.sort ?? "newest") === "newest";
}

export const Route = createFileRoute("/skins")({
  loaderDeps: ({ search }) => ({ isBrowse: isSkinsBrowseView(search), page: search.page ?? 0 }),
  loader: async ({ deps }): Promise<SkinsListResult | null> => {
    // SSR only: on client navigations the effect below owns the data, so the
    // loader skipping keeps navigation instant and avoids a duplicate fetch.
    if (typeof document !== "undefined") return null;
    if (!deps.isBrowse) return null;
    // Both the skins and the next-page link ship in HTML before any JS runs.
    const list = await fetchSkinsListSsr(deps.page);
    if (list && deps.page > 0 && deps.page * list.pageSize >= list.total) {
      throw notFound();
    }
    return list;
  },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`osu!mania skins`),
      description: i18n._(msg`Browse and download osu!mania skins with previews rendered from each skin's own notes, or publish a skin from an .osk file.`),
      path: match.search.page ? `/skins?page=${match.search.page}` : "/skins",
      origin: match.context.origin,
      imageKind: "skins",
      imageTitle: "osu!mania skins",
      noindex: !isSkinsBrowseView(match.search),
    });
  },
  search: {
    middlewares: [stripSearchParams(DEFAULT_SKINS_SEARCH)],
  },
  validateSearch: parseSkinsSearch,
  component: SkinsPage,
});

// The skins page filter rail: one section per axis, a micro-label over its
// options, hairlines between sections and nothing boxed.
function RailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-white/[0.07] pt-3">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1">{label}</div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

// A pick-one option marks itself with a dot; a `check` option is one of
// several independent toggles and marks itself with a box.
function RailOption({
  active,
  check = false,
  onClick,
  children,
}: {
  active: boolean;
  check?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group flex items-center gap-2.5 py-[3px] text-left pointer-coarse:py-2 text-[13.5px] transition-colors cursor-pointer ${
        active ? "font-bold text-white" : "font-medium text-osu-f1 hover:text-osu-pink-light"
      }`}
    >
      {check ? (
        <span
          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] ${
            active ? "bg-osu-pink" : "border border-osu-f1/40 group-hover:border-osu-pink-light"
          }`}
          aria-hidden="true"
        >
          {active && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3.5} />}
        </span>
      ) : (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
          <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-osu-pink" : "bg-transparent"}`} />
        </span>
      )}
      {children}
    </button>
  );
}

// Short pick-one values (keymodes, resolutions) sit as a block of cells, the
// active one filled.
function RailTile({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-1 py-1 text-center text-[12.5px] pointer-coarse:py-2 tabular-nums transition cursor-pointer ${
        active ? "bg-osu-pink font-bold text-white hover:brightness-110" : "font-medium text-osu-f1 hover:bg-white/[0.04] hover:text-osu-pink-light"
      }`}
    >
      {children}
    </button>
  );
}

// The sort options above the grid. The active one is white and underlined,
// with an arrow for the direction it is ordered in.
function SortTab({
  direction,
  onClick,
  children,
}: {
  direction?: "asc" | "desc";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const active = direction != null;
  const Arrow = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 border-b-2 py-1 text-[14px] pointer-coarse:py-2 transition-colors cursor-pointer ${
        active ? "border-osu-pink font-bold text-white" : "border-transparent font-medium text-osu-f1 hover:text-osu-pink-light"
      }`}
    >
      {children}
      {active && (
        <>
          <Arrow className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">{direction === "desc" ? <Trans>descending</Trans> : <Trans>ascending</Trans>}</span>
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
  const { t, i18n } = useLingui();
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

  // Each unfiltered catalogue page can seed its grid on a cold load.
  const ssrList = Route.useLoaderData();
  const isBrowse = isSkinsBrowseView({ q, sort, k, mine, cover, stage, shots, lazer, stable, shape, res });
  const ssrSeeded = ssrList != null && ssrList.page === page && isBrowse;

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
  // The filter rail is always out from lg up; below that it is a drawer.
  const [filtersOpen, setFiltersOpen] = useState(false);
  useBodyScrollLock(filtersOpen);
  // Escape closes the drawer, and so does widening the window into the
  // rail layout, where the drawer has nothing left to do.
  useEffect(() => {
    if (!filtersOpen) return;
    const wide = window.matchMedia("(min-width: 64rem)");
    const close = () => setFiltersOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onWide = () => {
      if (wide.matches) close();
    };
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [filtersOpen]);
  const activeFilterCount = traitFilterCount + (k ? 1 : 0) + (mineActive ? 1 : 0);

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
        <Trans>Upload skin</Trans>
      </button>
    </div>
  ) : auth.loginAvailable ? (
    <a
      href={loginHref}
      className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-osu-pink/45 bg-osu-pink/15 px-4 py-1.5 text-[12.5px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white sm:w-auto"
      title={t`Log in with osu! to upload a skin`}
    >
      <OsuLogo className="h-3.5 w-3.5" />
      <Trans>Log in to upload</Trans>
    </a>
  ) : null;

  // The filter sections, once: in the rail from lg up, in the slide-in drawer
  // below it.
  const railSections = (
    <>
      <RailSection label={t`keys`}>
        <div className="grid grid-cols-3 gap-1">
          <RailTile active={k === 0} onClick={() => applySearch({ k: 0, special: false })}>
            <Trans context="key count">any</Trans>
          </RailTile>
          {KEYMODE_FILTERS.map((option) => {
            const active = k === option.k && special === option.special;
            return (
              <RailTile
                key={option.label}
                active={active}
                onClick={() => applySearch(active ? { k: 0, special: false } : { k: option.k, special: option.special })}
              >
                {option.label}
              </RailTile>
            );
          })}
        </div>
      </RailSection>
      {/* What the tap notes are, classified from each skin's own
          note art. One shape at a time; picking the active one
          clears it. */}
      <RailSection label={t`notes`}>
        <RailOption active={!shape} onClick={() => applySearch({ shape: "" })}>
          <Trans>any</Trans>
        </RailOption>
        {NOTE_SHAPE_FILTERS.map((option) => (
          <RailOption
            key={option.shape}
            active={shape === option.shape}
            onClick={() => applySearch({ shape: shape === option.shape ? "" : option.shape })}
          >
            {i18n._(option.label)}
          </RailOption>
        ))}
      </RailSection>
      {/* Client compatibility is a pick-one axis, not something
          the archive "includes". */}
      <RailSection label={t`client`}>
        <RailOption active={!stable && !lazer} onClick={() => applySearch({ stable: false, lazer: false })}>
          <Trans>any</Trans>
        </RailOption>
        <RailOption active={stable} onClick={() => applySearch({ stable: !stable, lazer: false })}>
          <Trans>stable</Trans>
        </RailOption>
        <RailOption active={lazer} onClick={() => applySearch({ lazer: !lazer, stable: false })}>
          <Trans>lazer</Trans>
        </RailOption>
      </RailSection>
      {/* Independent checkboxes: each one narrows to skins that
          ship the thing, so they wear a box, not a dot. */}
      <RailSection label={t`includes`}>
        <RailOption check active={cover} onClick={() => applySearch({ cover: !cover })}>
          <Trans>lane cover</Trans>
        </RailOption>
        <RailOption check active={stage} onClick={() => applySearch({ stage: !stage })}>
          <Trans>mania stage</Trans>
        </RailOption>
        <RailOption check active={shots} onClick={() => applySearch({ shots: !shots })}>
          <Trans>screenshots</Trans>
        </RailOption>
      </RailSection>
      {/* The resolution the uploader said the skin is made for,
          offered as the ones uploaders have actually answered.
          Nobody has answered yet, no section. */}
      {resolutionOptions.length > 0 && (
        <RailSection label={t`display`}>
          <div className="grid grid-cols-2 gap-1">
            <RailTile active={!res} onClick={() => applySearch({ res: "" })}>
              <Trans>any</Trans>
            </RailTile>
            {resolutionOptions.map((option) => (
              <RailTile
                key={option}
                active={res === option}
                onClick={() => applySearch({ res: res === option ? "" : option })}
              >
                {option}
              </RailTile>
            ))}
          </div>
        </RailSection>
      )}
      {/* Only worth a section to someone who has an account to
          filter by; signed out there is no "you". */}
      {auth.viewer && (
        <RailSection label={t`uploader`}>
          <RailOption active={!mineActive} onClick={() => applySearch({ mine: false })}>
            <Trans>anyone</Trans>
          </RailOption>
          <RailOption active={mineActive} onClick={() => applySearch({ mine: true })}>
            <Trans>you</Trans>
          </RailOption>
        </RailSection>
      )}
    </>
  );

  // Stepping back from a skin would otherwise paint the grid at the top for a
  // frame before the router puts it back where it was left.
  const scrollRestoreRef = useScrollRestoreRef();

  return (
    <div ref={scrollRestoreRef} className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip">
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/skins.svg" title={t`osu!mania skins`} right={headerAction} />

          <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-4 sm:px-5 lg:max-w-[1408px] min-[102.5rem]:max-w-none">
            {/* Once the window has room for the rail on both sides, the grid
                takes the middle column at the header's width and the rail
                hangs in the left margin, so the skins stay centered under
                the page header the way they were before the rail. */}
            <div className="lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-x-8 lg:gap-y-5 min-[102.5rem]:grid-cols-[minmax(176px,1fr)_minmax(0,1160px)_minmax(176px,1fr)]">
            {/* Search and sort share one bar over the grid, level with the
                top of the rail. No surface of its own, so the falling notes
                show through. */}
            <div className="mb-5 flex flex-wrap items-center gap-x-8 gap-y-3 lg:col-start-2 lg:row-start-1 lg:mb-0">
              <div className="relative min-w-0 flex-1 basis-[300px]">
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
                  placeholder={t`Search skin, creator, or uploader`}
                  aria-label={t`Search skins`}
                  className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 py-2.5 pl-10 pr-3 text-[14px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1" role="group" aria-label={t`sort by`}>
                {SORT_OPTIONS.map((option) => {
                  const direction = sort === option.desc ? "desc" as const : sort === option.asc ? "asc" as const : undefined;
                  return (
                    <SortTab
                      key={option.key}
                      direction={direction}
                      onClick={() => applySearch({ sort: direction === "desc" ? option.asc : option.desc })}
                    >
                      {i18n._(direction === "asc" ? option.ascLabel ?? option.label : option.label)}
                    </SortTab>
                  );
                })}
              </div>
            </div>

            {/* Once the window has room for the rail on both sides, the grid
                takes the middle column at the header's width and the rail
                hangs in the left margin, so the skins stay centered under
                the page header the way they were before the rail. */}
              <aside className="scrollbar-hide mb-5 lg:col-start-1 lg:row-span-2 lg:row-start-1 min-[102.5rem]:w-[176px] min-[102.5rem]:justify-self-end lg:sticky lg:top-[76px] lg:mb-0 lg:max-h-[calc(100svh_-_92px)] lg:self-start lg:overflow-y-auto lg:pb-4">
                <div className="flex items-baseline gap-3 lg:min-h-[42px] lg:items-center">
                  <span
                    className={`text-[22px] font-bold leading-none text-white tabular-nums transition-opacity ${loading ? "opacity-45" : ""}`}
                    role="status"
                    aria-live="polite"
                  >
                    {data ? <Plural value={data.total} one="# skin" other="# skins" /> : <Skeleton className="h-5 w-24" />}
                  </span>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => applySearch(CLEARED_FILTERS)}
                      className="text-[12px] font-medium text-osu-f1 transition-colors cursor-pointer hover:text-osu-pink-light"
                    >
                      <Trans>clear</Trans>
                    </button>
                  )}
                  {/* Below lg the rail has no column of its own, so it slides
                      in over the page instead of pushing the grid down. */}
                  <button
                    type="button"
                    onClick={() => setFiltersOpen((open) => !open)}
                    aria-expanded={filtersOpen}
                    className="-my-2 ml-auto inline-flex items-center gap-1 py-2 text-[13px] font-medium text-osu-f1 transition-colors cursor-pointer hover:text-osu-pink-light lg:hidden"
                  >
                    <Trans>filters</Trans>
                    {activeFilterCount > 0 && <span className="tabular-nums text-white">{activeFilterCount}</span>}
                    <ChevronDown className="h-3 w-3 -rotate-90 self-center" aria-hidden="true" />
                  </button>
                </div>

                <div className="mt-4 hidden flex-col gap-y-4 lg:flex">{railSections}</div>
              </aside>

              <div className="min-w-0 lg:col-start-2 lg:row-start-2">
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
                          {admin ? "Private skins" : <Trans>Your private skins</Trans>}
                        </span>
                        {privateSkins.length > 0 && (
                          <span className="text-[11px] text-osu-f1 tabular-nums">
                            {admin
                              ? privateTotal > privateSkins.length
                                ? `${privateSkins.length} of ${privateTotal.toLocaleString("en-US")}, every uploader`
                                : `${privateTotal.toLocaleString("en-US")} across every uploader`
                              : <Trans>only you can open these</Trans>}
                          </span>
                        )}
                        <ChevronDown
                          className={`h-3.5 w-3.5 shrink-0 text-osu-f1/55 transition-[transform,color] group-hover:text-osu-pink-light ${privateOpen ? "" : "-rotate-90"}`}
                          aria-hidden="true"
                        />
                      </button>
                    </h2>
                    {privateOpen && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {privateSkins.length > 0
                          ? privateSkins.map((skin) => <SkinCard key={skin.id} skin={skin} showUploader={admin} />)
                          : Array.from({ length: privatePending }, (_, index) => <SkinCardSkeleton key={index} />)}
                      </div>
                    )}
                  </div>
                )}
                {loading && !data ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {Array.from({ length: 9 }, (_, index) => (
                      <SkinCardSkeleton key={index} />
                    ))}
                  </div>
                ) : failed ? (
                  <div className="mx-auto max-w-md px-4 py-16 text-center">
                    <div className="text-sm font-bold text-white"><Trans>Skins are unavailable right now</Trans></div>
                    <p className="mt-2 text-[12px] leading-relaxed text-osu-f1"><Trans>The skins list could not be loaded.</Trans></p>
                    <button
                      type="button"
                      onClick={() => setReloadTick((tick) => tick + 1)}
                      className="mt-4 rounded-full bg-osu-pink px-5 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110"
                    >
                      <Trans>Retry</Trans>
                    </button>
                  </div>
                ) : skins.length === 0 ? (
                  <div className="mx-auto max-w-md px-4 py-16 text-center">
                    <div className="text-sm font-bold text-white">
                      {mineActive && !q && !k && !traitFiltersActive
                        ? <Trans>You have not published a skin yet</Trans>
                        : q || k || mineActive || traitFiltersActive ? <Trans>No skins match</Trans> : <Trans>No skins yet</Trans>}
                    </div>
                    <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
                      {mineActive && !q && !k && !traitFiltersActive
                        ? privateSkins.length > 0
                          ? <Trans>Your private skins are on the shelf above; anything you publish lands here.</Trans>
                          : <Trans>Upload a skin and it lands here.</Trans>
                        : q || k || mineActive || traitFiltersActive
                          ? <Trans>Clear the filters, or upload the skin yourself.</Trans>
                          : <Trans>The first uploaded skin lands here.</Trans>}
                    </p>
                  </div>
                ) : (
                  <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {skins.map((skin) => (
                        // An explicit keymode fronts its own render (7K+1 is the
                        // 8K one). Without one, SkinCard uses the note-shape
                        // proof keymode returned for mixed skins by the backend.
                        <SkinCard key={skin.id} skin={skin} previewKeys={k >= 1 ? k : undefined} preferScreenshot={shots} />
                      ))}
                    </div>
                    <Pagination
                      page={page}
                      totalPages={totalPages}
                      onPageChange={(next) => applySearch({ page: next })}
                      renderPageLink={isBrowse ? (next, props) => (
                        <Link {...props} to="/skins" search={{ page: next }} replace />
                      ) : undefined}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {filtersOpen && (
          <div className="lg:hidden">
            <motion.div
              className="fixed inset-0 z-[60] bg-black/55"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setFiltersOpen(false)}
              aria-hidden="true"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={t`filters`}
              className="fixed left-0 top-0 z-[61] flex h-dvh w-[min(288px,85vw)] flex-col gap-y-4 overflow-y-auto overscroll-contain bg-osu-b5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-4 pt-[max(1rem,env(safe-area-inset-top))] shadow-[8px_0_32px_rgba(0,0,0,0.45)]"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "tween", duration: 0.2, ease: "easeOut" }}
            >
              <div className="flex items-baseline gap-3">
                <span className={`text-[22px] font-bold leading-none text-white tabular-nums transition-opacity ${loading ? "opacity-45" : ""}`}>
                  {data ? <Plural value={data.total} one="# skin" other="# skins" /> : null}
                </span>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={() => applySearch(CLEARED_FILTERS)}
                    className="text-[12px] font-medium text-osu-f1 transition-colors cursor-pointer hover:text-osu-pink-light"
                  >
                    <Trans>clear</Trans>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFiltersOpen(false)}
                  aria-label={t`Close`}
                  className="-m-2 ml-auto self-center p-2 text-osu-f1 transition-colors cursor-pointer hover:text-osu-pink-light"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {railSections}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

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
