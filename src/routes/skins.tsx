import { createFileRoute, notFound, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { SkinCard } from "../components/skins/SkinCard";
import { SkinUploadPanel } from "../components/skins/SkinUploadPanel";
import { Pagination } from "../components/ui/Pagination";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { OsuLogo } from "../components/ui/OsuLogo";
import { useAuth } from "../lib/auth-context";
import { canUseDevFeatures } from "../lib/auth-shared";
import { isLiveBackendConfigured } from "../lib/live-backend";
import { fetchSkinsListDirect, SKINS_PAGE_SIZE, type SkinsListResult, type SkinSummary } from "../lib/skins";
import { pageSeo } from "../lib/seo";

// All fields optional at the type level so links can target /skins without a
// search object; validateSearch still normalizes every field on read.
interface SkinsSearch {
  q?: string;
  page?: number;
}

const DEFAULT_SKINS_SEARCH = {
  q: "",
  page: 0,
};

export function parseSkinsSearch(search: Record<string, unknown>): SkinsSearch {
  const q = typeof search.q === "string" ? search.q.slice(0, 80) : DEFAULT_SKINS_SEARCH.q;
  const page = Number(search.page);
  return {
    q,
    page: Number.isInteger(page) && page > 0 ? page : DEFAULT_SKINS_SEARCH.page,
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

function SkinsPage() {
  const { q = "", page = 0 } = Route.useSearch();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();

  const [data, setData] = useState<SkinsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [searchInput, setSearchInput] = useState(q);
  const [reloadTick, setReloadTick] = useState(0);

  const applySearch = useCallback(
    (patch: SkinsSearch) => {
      void navigate({
        to: "/skins",
        search: { q, page: 0, ...patch },
        replace: true,
      });
    },
    [navigate, q],
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
    fetchSkinsListDirect({ q, page }, { signal: controller.signal })
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setFailed(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [q, page, reloadTick]);

  const handlePublished = useCallback((skin: SkinSummary) => {
    // Land the fresh skin at the top of an unfiltered first page.
    setData((previous) =>
      previous && page === 0 && !q
        ? { ...previous, total: previous.total + 1, skins: [skin, ...previous.skins].slice(0, SKINS_PAGE_SIZE) }
        : previous,
    );
  }, [page, q]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;
  const skins = data?.skins ?? [];

  const headerAction = auth.viewer ? (
    <button
      type="button"
      onClick={() => setShowUploader((open) => !open)}
      aria-expanded={showUploader}
      className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-osu-pink px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 sm:w-auto"
    >
      <Upload className="h-3.5 w-3.5" aria-hidden="true" />
      Publish a skin
    </button>
  ) : auth.loginAvailable ? (
    <a
      href={loginHref}
      className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-osu-pink/45 bg-osu-pink/15 px-4 py-1.5 text-[12.5px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white sm:w-auto"
      title="Log in with osu! to publish a skin"
    >
      <OsuLogo className="h-3.5 w-3.5" />
      Log in to publish
    </a>
  ) : null;

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/skins.svg" title="Skins" right={headerAction} />

          <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 sm:px-5">
            {showUploader && auth.viewer && (
              <div className="mb-5">
                <SkinUploadPanel onPublished={handlePublished} onClose={() => setShowUploader(false)} />
              </div>
            )}

            <div className="mb-4 flex items-center gap-3">
              <div className="relative flex-1">
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
                  placeholder="Search skin or uploader"
                  aria-label="Search skins"
                  className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 py-2.5 pl-10 pr-3 text-[14px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none"
                />
              </div>
              {data && !loading && (
                <span className="shrink-0 text-[12px] text-osu-f1 tabular-nums" role="status" aria-live="polite">
                  {data.total.toLocaleString()} {data.total === 1 ? "skin" : "skins"}
                </span>
              )}
            </div>

            {loading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b4">
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="space-y-1.5 px-3 py-2.5">
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
                <div className="text-sm font-bold text-white">{q ? "No skins match" : "No skins yet"}</div>
                <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
                  {q ? "Clear the search, or publish the skin yourself." : "The first published skin lands here."}
                </p>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {skins.map((skin) => (
                    <SkinCard key={skin.id} skin={skin} />
                  ))}
                </div>
                <Pagination page={page} totalPages={totalPages} onPageChange={(next) => applySearch({ page: next })} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
