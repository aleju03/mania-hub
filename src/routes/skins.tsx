import { createFileRoute, notFound, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { Layers, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { canUseDevFeatures, isAdmin } from "../lib/auth-shared";
import { isLiveBackendConfigured } from "../lib/live-backend";
import { fetchSkinsListAsAdmin, fetchSkinsListDirect, SKINS_PAGE_SIZE, type SkinsListResult, type SkinsSort, type SkinSummary } from "../lib/skins";
import { pageSeo } from "../lib/seo";

// All fields optional at the type level so links can target /skins without a
// search object; validateSearch still normalizes every field on read.
interface SkinsSearch {
  q?: string;
  page?: number;
  sort?: SkinsSort;
  k?: number;
}

const DEFAULT_SKINS_SEARCH = {
  q: "",
  page: 0,
  sort: "newest" as SkinsSort,
  k: 0,
};

// 0 means no keymode filter; the options cover the keymodes skins realistically declare.
const KEYMODE_FILTERS = [4, 5, 6, 7, 8, 9, 10];

export function parseSkinsSearch(search: Record<string, unknown>): SkinsSearch {
  const q = typeof search.q === "string" ? search.q.slice(0, 80) : DEFAULT_SKINS_SEARCH.q;
  const page = Number(search.page);
  const k = Number(search.k);
  return {
    q,
    page: Number.isInteger(page) && page > 0 ? page : DEFAULT_SKINS_SEARCH.page,
    sort: search.sort === "downloads" ? "downloads" : DEFAULT_SKINS_SEARCH.sort,
    k: Number.isInteger(k) && k >= 1 && k <= 10 ? k : DEFAULT_SKINS_SEARCH.k,
  };
}

export const Route = createFileRoute("/skins")({
  head: ({ match }) => pageSeo({
    title: "osu!mania skins",
    description: "Browse and download osu!mania skins with previews rendered from each skin's own notes, or publish a skin from an .osk file.",
    path: "/skins",
    origin: match.context.origin,
    noindex: true,
  }),
  // Dev-gated while unfinished (the /discord pattern): visible in local dev
  // and to dev users on the preview host, a 404 in production. Drop this
  // beforeLoad, the noindex above, and re-add the sitemap entry to ship it.
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
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
      <span className="w-14 shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3.5 gap-y-1">{children}</div>
    </div>
  );
}

function FilterOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-[12.5px] font-semibold tabular-nums transition-colors cursor-pointer ${
        active ? "text-white" : "text-osu-f1 hover:text-osu-pink-light"
      }`}
    >
      {children}
    </button>
  );
}

function SkinsPage() {
  const { q = "", page = 0, sort = "newest", k = 0 } = Route.useSearch();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const admin = isAdmin(auth);

  const [data, setData] = useState<SkinsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [showBulkUploader, setShowBulkUploader] = useState(false);
  const [searchInput, setSearchInput] = useState(q);
  const [reloadTick, setReloadTick] = useState(0);

  const applySearch = useCallback(
    (patch: SkinsSearch) => {
      void navigate({
        to: "/skins",
        search: { q, sort, k, page: 0, ...patch },
        replace: true,
      });
    },
    [navigate, q, sort, k],
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
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    // Admins take the server-fn route: it forwards the admin token, which is
    // what makes the backend send download counts back. Everyone else (and an
    // admin whose session just lapsed) reads the public list straight from the
    // backend, counts omitted.
    const load = admin
      ? fetchSkinsListAsAdmin({ data: { q, page, sort, k } })
          .catch(() => fetchSkinsListDirect({ q, page, sort, k }, { signal: controller.signal }))
      : fetchSkinsListDirect({ q, page, sort, k }, { signal: controller.signal });
    load
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setFailed(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [q, page, sort, k, reloadTick, admin]);

  const handlePublished = useCallback((skin: SkinSummary) => {
    // Land the fresh skin at the top of an unfiltered first page.
    setData((previous) =>
      previous && page === 0 && !q && !k
        ? { ...previous, total: previous.total + 1, skins: [skin, ...previous.skins].slice(0, SKINS_PAGE_SIZE) }
        : previous,
    );
  }, [page, q, k]);

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

              <div className="mt-3 flex flex-col gap-1.5">
                <FilterRow label="keys">
                  <FilterOption active={k === 0} onClick={() => applySearch({ k: 0 })}>
                    any
                  </FilterOption>
                  {KEYMODE_FILTERS.map((keys) => (
                    <FilterOption key={keys} active={k === keys} onClick={() => applySearch({ k: k === keys ? 0 : keys })}>
                      {keys}K
                    </FilterOption>
                  ))}
                </FilterRow>
                <FilterRow label="sort by">
                  <FilterOption active={sort === "newest"} onClick={() => applySearch({ sort: "newest" })}>
                    newest
                  </FilterOption>
                  <FilterOption active={sort === "downloads"} onClick={() => applySearch({ sort: "downloads" })}>
                    most downloaded
                  </FilterOption>
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
            {loading && !data ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 9 }, (_, index) => (
                  <div key={index} className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="space-y-1.5 px-2.5 py-2">
                      <Skeleton className="h-3.5 w-36" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
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
                <div className="text-sm font-bold text-white">{q || k ? "No skins match" : "No skins yet"}</div>
                <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
                  {q || k ? "Clear the filters, or upload the skin yourself." : "The first uploaded skin lands here."}
                </p>
              </div>
            ) : (
              <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {skins.map((skin) => (
                    <SkinCard key={skin.id} skin={skin} />
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
