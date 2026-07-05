import { createFileRoute, Link, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, Users, Target, TrendingUp, History, ArrowRight, X, Search, LayoutGrid, List } from "lucide-react";
import {
  fetchLiveFarmHelperSnapshot,
  isLiveBackendConfigured,
  type LiveFarmHelperKeyMode,
  type LiveFarmHelperRec,
  type LiveFarmHelperSnapshot,
  type LiveFarmHelperView,
} from "../lib/live-backend";
import { searchUsers } from "../lib/osu";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { FarmersList } from "../components/farm-helper/FarmersList";
import { SearchInput } from "../components/ui/SearchInput";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { Pagination } from "../components/ui/Pagination";
import { ModBadge } from "../components/ui/ModBadge";
import { StarRatingBadge } from "../components/maps/SearchCard";
import { UsernameText } from "../components/ui/UsernameText";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";

const PAGE_SIZE = 10;
const GRID_PAGE_SIZE = 12;
// Ask for the server max so the reason filters ("missing", "old") see the full
// ranked list instead of whatever cracked the overall top of a shorter slice.
const SNAPSHOT_LIMIT = 200;
const FARM_HELPER_KEY_MODES = ["any", "4k", "7k"] as const;
const FARM_HELPER_VIEWS = ["gain", "popular"] as const;

type ReasonFilter = "all" | "missing" | "improve" | "stale";
type SortMode = "gain" | "popularity" | "players" | "difficulty" | "recent";
type SortDirection = "asc" | "desc";
type LayoutMode = "list" | "grid";

interface FarmHelperSearch {
  user?: string;
  key?: LiveFarmHelperKeyMode;
  view?: LiveFarmHelperView;
  layout?: LayoutMode;
  reason?: ReasonFilter;
  sort?: SortMode;
  dir?: SortDirection;
  page?: number;
}

function parseKeyMode(value: unknown): LiveFarmHelperKeyMode | undefined {
  return value === "4k" || value === "7k" || value === "any" ? value : undefined;
}

function parseView(value: unknown): LiveFarmHelperView | undefined {
  return value === "popular" ? "popular" : value === "gain" ? "gain" : undefined;
}

function parseLayout(value: unknown): LayoutMode | undefined {
  return value === "grid" ? "grid" : value === "list" ? "list" : undefined;
}

// Popular browse suits the card grid (and matches the maps page); the personalized
// gain view defaults to the dense list. An explicit ?layout= overrides either.
function defaultLayoutForView(view: LiveFarmHelperView): LayoutMode {
  return view === "popular" ? "grid" : "list";
}

function defaultSortForView(view: LiveFarmHelperView): SortMode {
  return view === "popular" ? "popularity" : "gain";
}

function parseReasonFilter(value: unknown): ReasonFilter {
  return value === "missing" || value === "improve" || value === "stale" ? value : "all";
}

function parseSortMode(value: unknown): SortMode | undefined {
  return value === "gain" || value === "popularity" || value === "players" || value === "difficulty" || value === "recent"
    ? value
    : undefined;
}

function parseSortDirection(value: unknown): SortDirection {
  return value === "asc" ? "asc" : "desc";
}

function parsePage(value: unknown): number {
  const page = Math.floor(Number(value));
  return Number.isFinite(page) && page > 0 ? page : 0;
}

function buildFarmHelperSearch({
  user,
  key,
  view,
  layout,
  reason,
  sort,
  dir,
  page,
}: {
  user?: string | null;
  key?: LiveFarmHelperKeyMode;
  view?: LiveFarmHelperView;
  layout?: LayoutMode | null;
  reason?: ReasonFilter;
  sort?: SortMode;
  dir?: SortDirection;
  page?: number;
}): FarmHelperSearch {
  const effectiveView = view ?? "gain";
  const defaultSort = defaultSortForView(effectiveView);
  return {
    user: user ?? undefined,
    key: key && key !== "any" ? key : undefined,
    view: effectiveView !== "gain" ? effectiveView : undefined,
    layout: layout ?? undefined,
    reason: reason && reason !== "all" ? reason : undefined,
    sort: sort && sort !== defaultSort ? sort : undefined,
    dir: dir && dir !== "desc" ? dir : undefined,
    page: page && page > 0 ? Math.floor(page) : undefined,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function farmHelperRequestKey(subjectKey: string | null, keyMode: LiveFarmHelperKeyMode, view: LiveFarmHelperView): string {
  return `${subjectKey?.trim().toLowerCase() ?? ""}\u0000${keyMode}\u0000${view}`;
}

function orderedUnique<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getFarmHelperShellSnapshot(
  snapshots: Map<string, LiveFarmHelperSnapshot>,
  subjectKey: string | null,
  keyMode: LiveFarmHelperKeyMode,
  view: LiveFarmHelperView,
): LiveFarmHelperSnapshot | null {
  const keyModes = orderedUnique([keyMode, ...FARM_HELPER_KEY_MODES]);
  const views = orderedUnique([view, ...FARM_HELPER_VIEWS]);
  for (const candidateKeyMode of keyModes) {
    for (const candidateView of views) {
      const snapshot = snapshots.get(farmHelperRequestKey(subjectKey, candidateKeyMode, candidateView));
      if (snapshot) return snapshot;
    }
  }
  return null;
}

const searchPlayers = async (q: string) => {
  const res = await searchUsers({ data: { query: q } });
  return (res.user?.data ?? [])
    .slice(0, 6)
    .map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id,
      username: u.username,
      avatar_url: u.avatar_url,
      country_code: u.country_code,
    }));
};

export const Route = createFileRoute("/farm-helper")({
  validateSearch: (search: Record<string, unknown>): FarmHelperSearch => buildFarmHelperSearch({
    user: typeof search.user === "string" && search.user.trim() ? search.user.trim().slice(0, 60) : undefined,
    key: parseKeyMode(search.key),
    view: parseView(search.view),
    layout: parseLayout(search.layout),
    reason: parseReasonFilter(search.reason),
    sort: parseSortMode(search.sort),
    dir: parseSortDirection(search.dir),
    page: parsePage(search.page),
  }),
  head: ({ match }) => pageSeo({
    title: "Farm Helper",
    description: "Find osu!mania farm maps worth playing, based on nearby players, missing clears, improvable scores, and old PBs.",
    path: "/farm-helper",
    origin: match.context.origin,
    imageKind: "farm-helper",
  }),
  component: FarmHelperLayout,
});

const REASON_META: Record<LiveFarmHelperRec["reason"], { label: string; accent: string; text: string }> = {
  missing: { label: "missing", accent: "bg-osu-blue", text: "text-osu-blue" },
  improve: { label: "improve", accent: "bg-osu-green-light", text: "text-osu-green-light" },
  stale: { label: "old pb", accent: "bg-osu-yellow", text: "text-osu-yellow" },
  owned: { label: "cleared", accent: "bg-osu-pink", text: "text-osu-pink" },
};

const FARM_MAP_CONTEXT_KEY_PREFIX = "mania-hub-farm-helper-map-context-v1:";

function FarmHelperLayout() {
  const matches = useMatches();
  const hasChildRoute = matches.some((match) => match.routeId === "/farm-helper/map/$beatmapId");
  if (hasChildRoute) return <Outlet />;
  return <FarmHelperPage />;
}

function FarmHelperPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const auth = useAuth();
  const liveEnabled = isLiveBackendConfigured();

  const [snapshotsByRequestKey, setSnapshotsByRequestKey] = useState<Map<string, LiveFarmHelperSnapshot>>(() => new Map());
  const [error, setError] = useState<string | null>(null);

  const subjectKey = search.user ?? null;
  const keyMode: LiveFarmHelperKeyMode = search.key ?? "any";
  const view: LiveFarmHelperView = search.view ?? "gain";
  const layout: LayoutMode = search.layout ?? defaultLayoutForView(view);
  const reasonFilter: ReasonFilter = view === "gain" ? (search.reason ?? "all") : "all";
  const sortMode: SortMode = search.sort ?? defaultSortForView(view);
  const sortDir: SortDirection = search.dir ?? "desc";
  const page = search.page ?? 0;
  const [query, setQuery] = useState("");
  const requestKey = farmHelperRequestKey(subjectKey, keyMode, view);
  const visibleSnapshot = snapshotsByRequestKey.get(requestKey) ?? null;
  const shellSnapshot = visibleSnapshot ?? getFarmHelperShellSnapshot(snapshotsByRequestKey, subjectKey, keyMode, view);
  const waitingForCurrentSnapshot = liveEnabled && !!subjectKey && !visibleSnapshot && !error;
  const waitingForInitialSnapshot = waitingForCurrentSnapshot && !shellSnapshot;

  const navigateFarmHelper = (
    patch: {
      user?: string | null;
      key?: LiveFarmHelperKeyMode;
      view?: LiveFarmHelperView;
      layout?: LayoutMode | null;
      reason?: ReasonFilter;
      sort?: SortMode;
      dir?: SortDirection;
      page?: number;
      replace?: boolean;
    } = {},
  ) => {
    const { replace = true, ...changes } = patch;
    // Spread merges onto the raw search params, so an explicit `undefined`
    // (e.g. sort) clears that param rather than falling back to its current value.
    const next = {
      user: subjectKey,
      key: keyMode,
      view: search.view,
      layout: search.layout ?? undefined,
      reason: reasonFilter,
      sort: search.sort,
      dir: sortDir,
      page,
      ...changes,
    };
    navigate({
      to: "/farm-helper",
      search: buildFarmHelperSearch(next),
      replace,
      resetScroll: false,
    });
  };

  const setSubject = (key: string | null) => {
    navigateFarmHelper({ user: key, page: 0, replace: false });
  };

  const setKeyMode = (next: LiveFarmHelperKeyMode) => {
    navigateFarmHelper({ key: next, page: 0 });
  };

  const setView = (next: LiveFarmHelperView) => {
    // Reset the sort so each mode lands on its natural default ordering.
    navigateFarmHelper({ view: next, reason: undefined, sort: undefined, page: 0 });
  };

  const setLayout = (next: LayoutMode) => {
    navigateFarmHelper({ layout: next });
  };

  useEffect(() => {
    if (!liveEnabled || !subjectKey) {
      setSnapshotsByRequestKey(new Map());
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setError(null);
    fetchLiveFarmHelperSnapshot(subjectKey, {
      keyMode,
      view,
      limit: SNAPSHOT_LIMIT,
      signal: controller.signal,
    })
      .then((data) => {
        if (cancelled) return;
        setSnapshotsByRequestKey((current) => {
          const next = new Map(current);
          next.set(requestKey, data);
          return next;
        });
        recordRecentPlayer({ userId: data.userId, username: data.username, avatarUrl: data.avatarUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message.includes("404") ? "not-found" : "failed");
      })
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [liveEnabled, subjectKey, keyMode, view, requestKey]);

  const [farmersFor, setFarmersFor] = useState<{ rec: LiveFarmHelperRec; keyMode: LiveFarmHelperKeyMode } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recs = useMemo(() => {
    if (!visibleSnapshot) return [];
    const q = query.trim().toLowerCase();
    const matchesQuery = (rec: LiveFarmHelperRec) =>
      !q
      || rec.title.toLowerCase().includes(q)
      || rec.artist.toLowerCase().includes(q)
      || rec.creator.toLowerCase().includes(q)
      || rec.version.toLowerCase().includes(q);
    const filtered = visibleSnapshot.recs.filter(
      (rec) => (reasonFilter === "all" || rec.reason === reasonFilter) && matchesQuery(rec),
    );
    const sorted = [...filtered];
    const direction = sortDir === "desc" ? 1 : -1;
    sorted.sort((a, b) => {
      const byGain = b.estimatedPpGain - a.estimatedPpGain;
      const byFit = b.peerFraction - a.peerFraction;
      const byPlayers = b.peerCount - a.peerCount;
      const byStars = b.stars - a.stars;
      const byRecent = timestampMs(b.peerRecencyPlayedAt) - timestampMs(a.peerRecencyPlayedAt);
      const bySelected =
        sortMode === "gain" ? byGain
          : sortMode === "popularity" ? byFit
            : sortMode === "players" ? byPlayers
              : sortMode === "recent" ? byRecent
                : byStars;
      return (bySelected || byGain || byFit || byPlayers || byStars) * direction;
    });
    return sorted;
  }, [visibleSnapshot, query, reasonFilter, sortMode, sortDir]);

  // Only meaningful when no client-side filter narrows the list; then recs is
  // exactly the server's (possibly truncated) slice and "X of Y" is honest.
  const isClientFiltered = reasonFilter !== "all" || query.trim().length > 0;
  const totalQualifying = visibleSnapshot?.totalQualifying ?? 0;
  const serverTruncated = !isClientFiltered && totalQualifying > (visibleSnapshot?.recs.length ?? 0);

  const pageSize = layout === "grid" ? GRID_PAGE_SIZE : PAGE_SIZE;
  const pageCount = Math.ceil(recs.length / pageSize);
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const pageRecs = recs.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const goToPage = (next: number) => {
    navigateFarmHelper({ page: next });
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
        <PageHeader
          iconSrc="/images/icons/rankings.svg"
          title="Global mania farm helper"
        />

        <div className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-5 sm:px-5">
          {!liveEnabled ? (
            <EmptyNotice
              eyebrow="unavailable"
              title="Farm Helper needs the server"
              body="This tool reads cross-country farm data from the server, which isn't configured in this environment."
            />
          ) : !subjectKey ? (
            <PlayerPicker viewer={auth.viewer} onPick={setSubject} />
          ) : waitingForInitialSnapshot ? (
            <LoadingState />
          ) : error === "not-found" && !shellSnapshot ? (
            <EmptyNotice
              eyebrow="not found"
              title={`Couldn't find "${subjectKey}"`}
              body="Check the spelling, or search for the player again."
              action={<ChangeSubjectButton onPick={setSubject} />}
            />
          ) : error && !shellSnapshot ? (
            <EmptyNotice
              eyebrow="error"
              title="Couldn't build recommendations"
              body="Something went wrong loading this player's farm data. Try again in a moment."
              action={<ChangeSubjectButton onPick={setSubject} />}
            />
          ) : shellSnapshot ? (
            <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
              <TargetPanel
                snapshot={shellSnapshot}
                refreshing={waitingForCurrentSnapshot}
                onChangePlayer={() => setSubject(null)}
              />

              <div ref={listRef} className="min-w-0 scroll-mt-4">
                <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
                  <div className="border-b border-osu-b3/20 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">
                          {view === "popular" ? "popular at your level" : "recommendations"}
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-osu-c1">
                          {visibleSnapshot ? (
                            <>
                              {serverTruncated
                                ? `${formatPp(recs.length)} of ${formatPp(totalQualifying)} maps`
                                : `${formatPp(recs.length)} map${recs.length === 1 ? "" : "s"}`}
                              {view === "popular" ? (
                                <span className="font-normal text-osu-f1"> · what nearby players farm</span>
                              ) : (
                                <span className="font-normal text-osu-f1"> · +{formatPp(totalGain(recs))}pp on the table</span>
                              )}
                            </>
                          ) : error ? (
                            <span className="font-normal text-osu-f1">couldn't load maps</span>
                          ) : (
                            <div className="inline-flex items-center gap-2 align-middle">
                              <Skeleton className="h-4 w-16" />
                              <span className="font-normal text-osu-f1">
                                {view === "popular" ? "what nearby players farm" : "checking pp on the table"}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                      <ViewModeToggle view={view} onView={setView} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <ResultsSearch value={query} onChange={setQuery} />
                      <div className="flex items-center gap-2">
                        <KeyModeControl requestedKeyMode={keyMode} onKeyMode={setKeyMode} />
                        <LayoutToggle layout={layout} onLayout={setLayout} />
                      </div>
                      <Filters
                        showReason={view === "gain"}
                        reasonFilter={reasonFilter}
                        onReason={(next) => navigateFarmHelper({ reason: next, page: 0 })}
                        sortMode={sortMode}
                        sortDir={sortDir}
                        onSort={(next) => {
                          navigateFarmHelper({
                            sort: next,
                            dir: sortMode === next ? (sortDir === "desc" ? "asc" : "desc") : "desc",
                            page: 0,
                          });
                        }}
                        counts={countReasons(visibleSnapshot?.recs ?? [])}
                      />
                    </div>
                  </div>

                  {!visibleSnapshot ? (
                    error ? (
                      <EmptyNotice
                        eyebrow={error === "not-found" ? "not found" : "error"}
                        title={error === "not-found" ? "Couldn't load this view" : "Couldn't build recommendations"}
                        body={
                          error === "not-found"
                            ? "The saved player panel can stay here, but this view did not return fresh map data."
                            : "Something went wrong loading these maps. Try the toggle again in a moment."
                        }
                      />
                    ) : (
                      <RecommendationsSkeleton layout={layout} />
                    )
                  ) : recs.length === 0 ? (
                    <EmptyNotice
                      eyebrow={query ? "no matches" : "all caught up"}
                      title={
                        query
                          ? "No maps match your search"
                          : view === "popular"
                            ? "No popular maps at your level yet"
                            : "Nothing left to farm at your level"
                      }
                      body={
                        query
                          ? "Try a different title, artist, or difficulty name."
                          : view === "popular"
                            ? "No nearby players have farm data here yet. Try a different key mode."
                            : "Try the popular view to browse every farm map around your fit, or widen the key mode."
                      }
                    />
                  ) : layout === "grid" ? (
                    <div className="grid grid-cols-2 gap-2.5 bg-osu-b5 p-2.5 sm:grid-cols-3 xl:grid-cols-4">
                      {pageRecs.map((rec) => (
                        <RecCard
                          key={`${rec.beatmapId}:${rec.speedBucket}`}
                          rec={rec}
                          userKey={String(visibleSnapshot.userId)}
                          userName={visibleSnapshot.username}
                          keyMode={visibleSnapshot.keyMode}
                          onShowFarmers={() => setFarmersFor({ rec, keyMode: visibleSnapshot.keyMode })}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="divide-y divide-osu-b3/20">
                      {pageRecs.map((rec) => (
                        <RecRow
                          key={`${rec.beatmapId}:${rec.speedBucket}`}
                          rec={rec}
                          userKey={String(visibleSnapshot.userId)}
                          userName={visibleSnapshot.username}
                          keyMode={visibleSnapshot.keyMode}
                          onShowFarmers={() => setFarmersFor({ rec, keyMode: visibleSnapshot.keyMode })}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {visibleSnapshot && pageCount > 1 ? (
                  <div
                    className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-osu-b3/30 bg-osu-b5/90 px-4 py-2 backdrop-blur-sm after:absolute after:left-0 after:right-0 after:top-full after:h-4 after:bg-osu-b5/90 after:backdrop-blur-sm after:content-[''] sm:-mx-5 sm:px-5 [&>div]:!mt-0 relative"
                    style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
                  >
                    <Pagination page={safePage} totalPages={pageCount} onPageChange={goToPage} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        </div>
      </div>

      <FarmersModal
        rec={farmersFor?.rec ?? null}
        userKey={shellSnapshot ? String(shellSnapshot.userId) : null}
        keyMode={farmersFor?.keyMode ?? keyMode}
        onClose={() => setFarmersFor(null)}
      />
    </div>
  );
}

function PlayerPicker({ viewer, onPick }: { viewer: ReturnType<typeof useAuth>["viewer"]; onPick: (key: string) => void }) {
  const [recents, setRecents] = useState<RecentPlayer[]>([]);
  const viewerId = viewer?.id;

  useLayoutEffect(() => {
    const list = readRecentPlayers();
    setRecents(viewerId ? list.filter((p) => p.userId !== viewerId) : list);
  }, [viewerId]);

  const removeRecent = (userId: number) => {
    removeRecentPlayer(userId);
    setRecents((prev) => prev.filter((p) => p.userId !== userId));
  };

  return (
    <div className="mx-auto grid min-h-[70vh] w-full max-w-5xl content-center gap-10 py-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-14">
      <div className="text-center lg:text-left">
        {viewer ? (
          <div>
            <div className="text-3xl font-black leading-tight text-osu-c1">
              <div>maps worth farming</div>
              <div className="mt-3 flex items-center justify-center gap-3 lg:justify-start">
                <span>for</span>
                <button
                  type="button"
                  onClick={() => onPick(String(viewer.id))}
                  aria-label={`Find farm maps for ${viewer.username}`}
                  className="group inline-flex items-center gap-2.5 rounded-xl border border-osu-b3/30 bg-osu-b4 py-1.5 pl-2 pr-3 text-lg font-bold text-osu-c1 transition-colors duration-150 hover:border-osu-pink/60 hover:bg-osu-b3"
                >
                  <Avatar url={viewer.avatarUrl} userId={viewer.id} size={30} />
                  <span className="max-w-44 truncate">{viewer.username}</span>
                  {viewer.countryCode ? <CountryFlag code={viewer.countryCode} size="sm" decorative /> : null}
                  <ArrowRight className="h-4 w-4 shrink-0 text-osu-pink transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            </div>

            <div className="mt-7 flex w-full items-center gap-3">
              <span className="h-px flex-1 bg-osu-b3/30" />
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-osu-f1">
                or someone else
              </span>
              <span className="h-px flex-1 bg-osu-b3/30" />
            </div>
          </div>
        ) : (
          <div className="text-3xl font-black leading-tight text-osu-c1">
            <div>maps worth farming</div>
            <div className="mt-3 flex items-center justify-center gap-3 lg:justify-start">
              <span>for</span>
              <SearchInput
                onSearch={searchPlayers}
                onSelect={(user) => onPick(user.username)}
                placeholder="username..."
                className="w-full max-w-60 font-normal"
              />
            </div>
          </div>
        )}

        {viewer ? (
          <div className="mx-auto mt-4 w-full max-w-md lg:mx-0">
            <SearchInput onSearch={searchPlayers} onSelect={(user) => onPick(user.username)} placeholder="username..." />
          </div>
        ) : null}

        {recents.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1">recent</div>
            <div className="flex flex-wrap justify-center gap-1.5 lg:justify-start">
              {recents.map((player) => (
                <div
                  key={player.userId}
                  className="flex items-center rounded-lg border border-osu-b3/30 bg-osu-b4 pl-1.5 pr-1 transition-colors duration-150 hover:border-osu-pink/40 hover:bg-osu-b3"
                >
                  <button
                    type="button"
                    onClick={() => onPick(player.username)}
                    className="flex items-center gap-2 py-1.5 pr-1"
                  >
                    <Avatar url={player.avatarUrl} userId={player.userId} size={24} />
                    <span className="max-w-[120px] truncate text-[13px] font-medium text-osu-c1">{player.username}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRecent(player.userId)}
                    aria-label={`Remove ${player.username} from recent`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center text-osu-f1 transition-colors hover:text-osu-c1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mx-auto mt-9 w-fit space-y-2 text-left lg:mx-0">
          <p className="mb-2.5 text-xs text-osu-f1">
            based on what players near the same pp are farming:
          </p>
          <PickerLegend
            icon={<Target className="h-3.5 w-3.5 shrink-0 text-osu-blue" />}
            label="missing"
            body="popular nearby, you haven't played it"
          />
          <PickerLegend
            icon={<TrendingUp className="h-3.5 w-3.5 shrink-0 text-osu-green-light" />}
            label="improve"
            body="nearby players outscore you"
          />
          <PickerLegend
            icon={<History className="h-3.5 w-3.5 shrink-0 text-osu-yellow" />}
            label="old pb"
            body="an old score a fresh run would beat"
          />
        </div>
      </div>

      <PickerPreviewCard />
    </div>
  );
}

function PickerLegend({ icon, label, body }: { icon: ReactNode; label: string; body: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {icon}
      <span className="w-16 shrink-0 font-bold uppercase tracking-wide text-osu-c1">{label}</span>
      <span className="text-osu-f1">{body}</span>
    </div>
  );
}

interface PreviewRec {
  reason: LiveFarmHelperRec["reason"];
  title: string;
  version: string;
  artist: string;
  creator: string;
  stars: number;
  cover: string;
  gain: number;
  barLeft: string;
  barRight: string;
  pct: number;
}

// Lifted from a real snapshot for a ~4,250pp 4K player so the numbers are plausible.
const PREVIEW_RECS: PreviewRec[] = [
  {
    reason: "missing",
    title: "Galaxy Collapse",
    version: "4K Ayase vs Ferdi's Galactic Annihilation",
    artist: "Kurokotei",
    creator: "SuzumeAyase",
    stars: 5.84,
    cover: "https://assets.ppy.sh/beatmaps/2474975/covers/list.jpg",
    gain: 71,
    barLeft: "32% of sampled nearby players farm this",
    barRight: "median 274pp",
    pct: 32,
  },
  {
    reason: "improve",
    title: "Triumph & Regret",
    version: "4K Regret",
    artist: "typeMARS",
    creator: "[ A v a l o n ]",
    stars: 5.48,
    cover: "https://assets.ppy.sh/beatmaps/347650/covers/list.jpg",
    gain: 30,
    barLeft: "your 232pp",
    barRight: "median 274pp",
    pct: 85,
  },
  {
    reason: "stale",
    title: "MALIGNANT",
    version: "4K Proboscidea",
    artist: "a crowd of rebellion",
    creator: "Nathalia-",
    stars: 4.95,
    cover: "https://assets.ppy.sh/beatmaps/1556170/covers/list.jpg",
    gain: 18,
    barLeft: "your 204pp · 16mo old",
    barRight: "top 25% 225pp",
    pct: 91,
  },
];

function PickerPreviewCard() {
  const totalPreviewGain = PREVIEW_RECS.reduce((sum, rec) => sum + rec.gain, 0);
  return (
    <div aria-hidden="true" className="pointer-events-none select-none">
      <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 shadow-xl shadow-black/25">
        <div className="flex items-center justify-between gap-3 border-b border-osu-b3/20 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">recommendations</div>
            <div className="mt-0.5 text-sm font-semibold text-osu-c1">
              {PREVIEW_RECS.length} maps
              <span className="font-normal text-osu-f1"> · +{totalPreviewGain}pp on the table</span>
            </div>
          </div>
          <span className="shrink-0 rounded-md border border-osu-b3/30 bg-osu-b5/60 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-osu-f1">
            example
          </span>
        </div>
        <div className="divide-y divide-osu-b3/20">
          {PREVIEW_RECS.map((rec) => (
            <PreviewRecRow key={rec.title} rec={rec} />
          ))}
        </div>
      </div>
      <p className="mt-2.5 text-center text-[11px] text-osu-f1 lg:text-right">
        what it finds for a 4,200pp player
      </p>
    </div>
  );
}

function PreviewRecRow({ rec }: { rec: PreviewRec }) {
  const meta = REASON_META[rec.reason];
  return (
    <div className="relative bg-osu-b4">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.accent}`} />
      <div className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 p-3 pl-4">
        <div className="h-11 w-11 overflow-hidden rounded-md bg-osu-b6">
          <img src={rec.cover} alt="" loading="lazy" className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold text-osu-c1">
            {rec.title}
            <span className="font-medium text-osu-f1"> [{rec.version}]</span>
          </div>
          <div className="flex items-center gap-x-2 text-[11px] leading-tight">
            <span className={`whitespace-nowrap font-bold uppercase tracking-wide ${meta.text}`}>{meta.label}</span>
            <span className="tabular-nums text-osu-yellow">★{rec.stars.toFixed(2)}</span>
            <span className="min-w-0 truncate text-osu-f1">
              {rec.artist} · {rec.creator}
            </span>
          </div>
          <div className="mt-1.5">
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="truncate text-osu-l2">{rec.barLeft}</span>
              <span className="shrink-0 text-osu-f1">{rec.barRight}</span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-osu-b6">
              <div className={`h-full rounded-full ${meta.accent}`} style={{ width: `${rec.pct}%` }} />
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-black leading-none tabular-nums text-osu-pink">
            +{rec.gain}
            <span className="text-[11px] font-bold text-osu-pink/70">pp</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RecentPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
}

const RECENT_KEY = "mania-hub-farm-helper-recent-v1";
const RECENT_MAX = 8;

function readRecentPlayers(): RecentPlayer[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is RecentPlayer =>
          !!p && typeof p === "object" && Number.isFinite(p.userId) && typeof p.username === "string" && p.username.length > 0,
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function recordRecentPlayer(player: RecentPlayer): void {
  if (typeof window === "undefined" || !player.username) return;
  try {
    const existing = readRecentPlayers().filter((p) => p.userId !== player.userId);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([player, ...existing].slice(0, RECENT_MAX)));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function removeRecentPlayer(userId: number): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readRecentPlayers().filter((p) => p.userId !== userId);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(existing));
  } catch {
    /* ignore */
  }
}

function TargetPanel({
  snapshot,
  refreshing = false,
  onChangePlayer,
}: {
  snapshot: LiveFarmHelperSnapshot;
  refreshing?: boolean;
  onChangePlayer: () => void;
}) {
  const mapCount = snapshot.recs.length;
  const biggest = maxGain(snapshot.recs);
  return (
    <aside className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
        <div className="relative overflow-hidden">
          {snapshot.coverUrl ? (
            <>
              <div
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url(${snapshot.coverUrl})` }}
                aria-hidden="true"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-osu-b4 via-osu-b4/85 to-osu-b4/55" aria-hidden="true" />
            </>
          ) : null}
          <div className="relative flex items-center gap-3 p-4">
            <span className="inline-flex shrink-0 rounded-full ring-2 ring-white/10">
              <Avatar url={snapshot.avatarUrl} userId={snapshot.userId} size={52} />
            </span>
            <div className="min-w-0">
              <Link
                to="/player/$username"
                params={{ username: snapshot.username }}
                className="block truncate text-base font-bold text-osu-pink hover:brightness-110"
              >
                <UsernameText username={snapshot.username} avatarUrl={snapshot.avatarUrl} />
              </Link>
              <div className="text-[12px] font-semibold tabular-nums text-osu-c1">{formatPp(snapshot.pp)}pp</div>
              {refreshing ? (
                <Skeleton className="mt-1 h-2.5 w-28 max-w-full" />
              ) : (
                <div className="text-[11px] text-osu-f1">{peerBandRangeLabel(snapshot)}</div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-osu-b3/20 px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">potential pp gain</div>
          {refreshing ? (
            <div className="mt-2 space-y-2">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-2.5 w-44 max-w-full" />
            </div>
          ) : (
            <>
              <div className="mt-1 text-3xl font-black leading-none tabular-nums text-osu-pink">
                +{formatPp(snapshot.totalPotentialPp)}
                <span className="ml-1 text-base font-bold text-osu-pink/70">pp</span>
              </div>
              {mapCount > 0 ? (
                <div className="mt-2 text-[11px] text-osu-f1">
                  across {formatPp(mapCount)} map{mapCount === 1 ? "" : "s"}
                  {biggest > 0 ? ` · biggest +${formatPp(biggest)}pp` : ""}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onChangePlayer}
        className="w-full rounded-xl border border-osu-b3/20 bg-osu-b4 px-3 py-2.5 text-xs font-medium text-osu-l2 transition-colors hover:bg-osu-b3"
      >
        change player
      </button>
    </aside>
  );
}

function maxGain(recs: LiveFarmHelperRec[]): number {
  return recs.reduce((max, rec) => Math.max(max, rec.estimatedPpGain), 0);
}

function totalGain(recs: LiveFarmHelperRec[]): number {
  return recs.reduce((sum, rec) => sum + Math.max(0, rec.estimatedPpGain), 0);
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function peerBandRangeLabel(snapshot: LiveFarmHelperSnapshot): string {
  const { count, minPp, maxPp } = snapshot.peerBand;
  if (count <= 0 || minPp <= 0 || maxPp <= 0) return "no pp range";
  if (Math.round(minPp) === Math.round(maxPp)) return `compared to ${formatCompactPp(minPp)} pp`;
  return `compared to ${formatCompactPp(minPp)}-${formatCompactPp(maxPp)} pp`;
}

function ChangeSubjectButton({ onPick }: { onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (open) {
    return (
      <div ref={ref} className="w-full">
        <SearchInput onSearch={searchPlayers} onSelect={(user) => onPick(user.username)} placeholder="search a player..." />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="w-full rounded-lg bg-osu-b3/60 px-3 py-2 text-xs font-medium text-osu-l2 transition-colors hover:bg-osu-b3"
    >
      change player
    </button>
  );
}

function Filters({
  showReason,
  reasonFilter,
  onReason,
  sortMode,
  sortDir,
  onSort,
  counts,
}: {
  showReason: boolean;
  reasonFilter: ReasonFilter;
  onReason: (next: ReasonFilter) => void;
  sortMode: SortMode;
  sortDir: SortDirection;
  onSort: (next: SortMode) => void;
  counts: Record<ReasonFilter, number>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {showReason ? (
        <ChipGroup label="show">
          <SegmentedControl>
            {(["all", "missing", "improve", "stale"] as const).map((reason) => (
              <SegmentButton key={reason} active={reasonFilter === reason} onClick={() => onReason(reason)}>
                {reason === "stale" ? "old" : reason}
                <span className={`tabular-nums ${reasonFilter === reason ? "text-osu-pink-light/70" : "text-osu-f1/70"}`}>
                  {counts[reason]}
                </span>
              </SegmentButton>
            ))}
          </SegmentedControl>
        </ChipGroup>
      ) : null}
      <ChipGroup label="sort">
        <SegmentedControl>
          {(
            [
              ["gain", "gain"],
              ["popularity", "fit"],
              ["recent", "recent"],
              ["players", "players"],
              ["difficulty", "stars"],
            ] as const
          ).map(([value, label]) => (
            <SegmentButton
              key={value}
              active={sortMode === value}
              onClick={() => onSort(value)}
              title={sortMode === value ? (sortDir === "desc" ? "Click to sort ascending" : "Click to sort descending") : undefined}
            >
              {label}
              {sortMode === value ? (
                <span aria-hidden className="text-[10px] leading-none opacity-90">
                  {sortDir === "desc" ? "↓" : "↑"}
                </span>
              ) : null}
            </SegmentButton>
          ))}
        </SegmentedControl>
      </ChipGroup>
    </div>
  );
}

function KeyModeControl({
  requestedKeyMode,
  onKeyMode,
}: {
  requestedKeyMode: LiveFarmHelperKeyMode;
  onKeyMode: (next: LiveFarmHelperKeyMode) => void;
}) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-osu-b3/30" role="group" aria-label="Key mode">
      {(["any", "4k", "7k"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onKeyMode(mode)}
          aria-pressed={requestedKeyMode === mode}
          className={`px-2.5 py-1.5 text-[11px] font-medium uppercase tabular-nums transition-colors duration-[120ms] ${
            requestedKeyMode === mode
              ? "bg-osu-b3 text-osu-l2"
              : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
          }`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function ViewModeToggle({ view, onView }: { view: LiveFarmHelperView; onView: (next: LiveFarmHelperView) => void }) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-osu-b3/30" role="group" aria-label="View mode">
      {([["gain", "for you"], ["popular", "popular"]] as const).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onView(value)}
          aria-pressed={view === value}
          className={`px-2.5 py-1.5 text-[11px] font-semibold transition-colors duration-[120ms] ${
            view === value ? "bg-osu-pink/15 text-osu-pink-light" : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function LayoutToggle({ layout, onLayout }: { layout: LayoutMode; onLayout: (next: LayoutMode) => void }) {
  const options = [
    { value: "list", Icon: List },
    { value: "grid", Icon: LayoutGrid },
  ] as const;
  return (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-osu-b3/30" role="group" aria-label="Layout">
      {options.map(({ value, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => onLayout(value)}
          aria-pressed={layout === value}
          aria-label={`${value} layout`}
          title={`${value} layout`}
          className={`px-2 py-1.5 transition-colors duration-[120ms] ${
            layout === value ? "bg-osu-b3 text-osu-l2" : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function ResultsSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="relative min-w-[150px] flex-1 sm:max-w-[260px]">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="filter by title or artist..."
        aria-label="Filter maps"
        className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4/50 py-1.5 pl-8 pr-7 text-[11px] text-osu-c1 placeholder:text-osu-f1 transition-colors focus:border-osu-h1/40 focus:outline-none"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-osu-f1 transition-colors hover:text-osu-l2"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] font-bold uppercase tracking-wider text-osu-f1/70">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function SegmentedControl({ children }: { children: ReactNode }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/50">
      {children}
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`inline-flex items-center gap-1 border-r border-osu-b3/25 px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-[120ms] last:border-r-0 ${
        active
          ? "bg-osu-pink/15 text-osu-pink-light"
          : "text-osu-f1 hover:bg-osu-b3/70 hover:text-osu-l2"
      }`}
    >
      {children}
    </button>
  );
}

function RecRow({
  rec,
  userKey,
  userName,
  keyMode,
  onShowFarmers,
}: {
  rec: LiveFarmHelperRec;
  userKey: string;
  userName: string;
  keyMode: LiveFarmHelperKeyMode;
  onShowFarmers: () => void;
}) {
  const meta = REASON_META[rec.reason];
  const bar = comparisonBar(rec);
  const fit = confidence(rec);
  const desktopCover = rec.listCover || rec.cover;
  const openDetails = useOpenFarmMapDetail(rec, userKey, userName, keyMode);
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={openDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDetails();
        }
      }}
      aria-label={`Open details for ${rec.title} [${rec.version}]`}
      className="group relative cursor-pointer bg-osu-b4 transition-colors hover:bg-osu-b3/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/60"
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.accent}`} />
      <div className="grid gap-3 p-2.5 pl-4 md:grid-cols-[56px_minmax(0,1fr)_118px] md:items-center md:gap-3.5 md:p-3 md:pl-5">
        <div className="h-14 w-full overflow-hidden rounded-md bg-osu-b6 md:h-[56px]">
          {rec.cover ? (
            <picture className="block h-full w-full">
              {desktopCover ? <source media="(min-width: 768px)" srcSet={desktopCover} /> : null}
              <img src={rec.cover} alt="" loading="lazy" className="h-full w-full object-cover" />
            </picture>
          ) : null}
        </div>

        <div className="min-w-0">
          <div className="flex min-w-0 items-center justify-start gap-1.5">
            <div className="min-w-0 max-w-full truncate text-[14px] font-bold text-osu-c1">
              {rec.title}
              <span className="font-medium text-osu-f1"> [{rec.version}]</span>
            </div>
            <ModList mods={rec.recommendedMods ?? []} size={0.62} className="max-w-[120px]" />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] leading-tight">
            <span className={`font-bold uppercase tracking-wide ${meta.text}`}>{farmStatusLabel(rec)}</span>
            <span className="tabular-nums text-osu-yellow">★{rec.stars.toFixed(2)}</span>
            <span className="tabular-nums text-osu-green-light">{fit}% fit</span>
            <span className="min-w-0 truncate text-osu-f1">
              {rec.artist} · {rec.creator}
              {rec.bpm ? ` · ${Math.round(rec.bpm)} bpm` : ""}
              {rec.lengthSec ? ` · ${formatLength(rec.lengthSec)}` : ""}
            </span>
          </div>

          <div className="mt-1.5 flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-osu-l2">{bar.left}</span>
                <span className="shrink-0 text-osu-f1">{bar.right}</span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-osu-b6">
                <div className={`h-full rounded-full ${meta.accent}`} style={{ width: `${bar.pct}%` }} />
              </div>
            </div>
            <PeerList rec={rec} onShowFarmers={onShowFarmers} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 md:flex-col md:items-end md:justify-center md:gap-1.5">
          <div className="md:text-right">
            <div className="text-xl font-black leading-none tabular-nums text-osu-pink">
              +{formatPp(rec.estimatedPpGain)}
              <span className="text-xs font-bold text-osu-pink/70">pp</span>
            </div>
            <div className="mt-1 text-[10px] text-osu-f1">if you get {formatPp(rec.benchmarkPp)}pp</div>
          </div>
          <a
            href={rec.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-osu-b6/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-osu-c1"
            aria-label="Open map"
            title="Open map"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

// Grid-layout card mirroring the maps page's farmed-map card, driven by farm-helper
// rec data: cover with key/star/gain badges, peer-popularity stats, farmer avatars.
function RecCard({
  rec,
  userKey,
  userName,
  keyMode,
  onShowFarmers,
}: {
  rec: LiveFarmHelperRec;
  userKey: string;
  userName: string;
  keyMode: LiveFarmHelperKeyMode;
  onShowFarmers: () => void;
}) {
  const openDetails = useOpenFarmMapDetail(rec, userKey, userName, keyMode);
  const cover = rec.listCover || rec.cover;
  const gain = Math.max(0, rec.estimatedPpGain);
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 transition-colors hover:border-osu-pink/30">
      <button
        type="button"
        onClick={openDetails}
        className="relative block w-full cursor-pointer overflow-hidden text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/60"
        aria-label={`Open details for ${rec.title} [${rec.version}]`}
      >
        {cover ? (
          <img src={cover} alt="" loading="lazy" className="h-[90px] w-full object-cover" />
        ) : (
          <div className="h-[90px] w-full bg-osu-b6" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" aria-hidden="true" />
        <span className="absolute left-1.5 top-1.5 inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">{rec.keys}K</span>
        <StarRatingBadge stars={rec.stars} className="absolute right-1.5 top-1.5" />
        {gain >= 1 ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-osu-pink/90 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-white">
            +{formatPp(gain)}pp
          </span>
        ) : null}
        <div className="absolute inset-x-0 bottom-0 px-2.5 pb-1.5">
          <div className="truncate text-[12px] font-semibold leading-tight text-white drop-shadow-lg">{rec.title}</div>
          <div className="truncate text-[10px] leading-tight text-white/70 drop-shadow-lg">{rec.artist}</div>
        </div>
      </button>

      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-[10px] text-osu-l2">[{rec.version}]</span>
          <ModList mods={rec.recommendedMods ?? []} size={0.5} className="max-w-[72px]" />
          <span className="shrink-0 text-[9px] text-osu-f1">{formatLength(rec.lengthSec)}</span>
        </div>

        <div className="mt-1.5 flex items-center gap-3">
          <CardStat value={formatPp(rec.peerCount)} label={rec.peerCount === 1 ? "player" : "players"} color="text-osu-blue" />
          <CardStat value={`~${formatPp(rec.peerPpMedian)}`} label="avg pp" color="text-osu-pink" />
          {rec.subjectPp != null ? <CardStat value={formatPp(rec.subjectPp)} label="you" color="text-osu-green-light" /> : null}
        </div>

        <CardFarmerAvatars rec={rec} onShowFarmers={onShowFarmers} />
      </div>
    </div>
  );
}

function CardStat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className={`text-[11px] font-bold tabular-nums ${color}`}>{value}</span>
      <span className="text-[8px] uppercase text-osu-f1">{label}</span>
    </div>
  );
}

function CardFarmerAvatars({ rec, onShowFarmers }: { rec: LiveFarmHelperRec; onShowFarmers: () => void }) {
  const shown = rec.topPeers.slice(0, 4);
  if (shown.length === 0) return null;
  const overflow = Math.max(0, rec.peerCount - shown.length);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onShowFarmers();
      }}
      className="mt-1.5 flex w-full items-center gap-0.5 rounded-lg py-0.5 text-left transition-opacity hover:opacity-80"
      title="See everyone who farmed this"
    >
      {shown.map((peer) => (
        <span key={peer.userId} className="inline-flex rounded-full ring-2 ring-osu-b4">
          <Avatar url={peer.avatarUrl} userId={peer.userId} size={18} />
        </span>
      ))}
      {overflow > 0 ? <span className="ml-1 text-[8px] uppercase text-osu-f1">+{formatPp(overflow)}</span> : null}
    </button>
  );
}

function writeFarmMapContext(beatmapId: number, context: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${FARM_MAP_CONTEXT_KEY_PREFIX}${beatmapId}`, JSON.stringify(context));
  } catch {
    /* ignore storage errors */
  }
}

function buildFarmMapDetailContext(
  rec: LiveFarmHelperRec,
  userKey: string,
  userName: string,
  keyMode: LiveFarmHelperKeyMode,
): Record<string, unknown> {
  return {
    beatmapsetId: rec.beatmapsetId,
    title: rec.title,
    artist: rec.artist,
    creator: rec.creator,
    version: rec.version,
    cover: rec.cover,
    status: rec.status,
    stars: rec.stars,
    keys: rec.keys,
    bpm: rec.bpm,
    lengthSec: rec.lengthSec,
    mapUrl: rec.mapUrl,
    userKey,
    userName,
    keyMode,
    speed: rec.speedBucket,
    reason: rec.reason,
    gain: Math.round(rec.estimatedPpGain * 10) / 10,
    benchmark: Math.round(rec.benchmarkPp * 10) / 10,
    subjectPp: rec.subjectPp == null ? undefined : Math.round(rec.subjectPp * 10) / 10,
    peerCount: rec.peerCount,
    peerSampleSize: rec.peerSampleSize,
    peerFraction: Math.round(rec.peerFraction * 1000) / 1000,
    median: Math.round(rec.peerPpMedian * 10) / 10,
    p75: Math.round(rec.peerPpP75 * 10) / 10,
    playedAt: rec.subjectPlayedAt ?? undefined,
  };
}

// Shared by the list row and the grid card: stash the rec context, then open the
// dedicated map detail page (which rehydrates the context for its farm verdict).
function useOpenFarmMapDetail(
  rec: LiveFarmHelperRec,
  userKey: string,
  userName: string,
  keyMode: LiveFarmHelperKeyMode,
): () => void {
  const navigate = useNavigate();
  return () => {
    writeFarmMapContext(rec.beatmapId, buildFarmMapDetailContext(rec, userKey, userName, keyMode));
    void navigate({
      to: "/farm-helper/map/$beatmapId",
      params: { beatmapId: String(rec.beatmapId) },
      search: {
        user: userKey,
        key: keyMode,
        speed: rec.speedBucket,
      },
    });
  };
}

function PeerList({ rec, onShowFarmers }: { rec: LiveFarmHelperRec; onShowFarmers: () => void }) {
  const shown = rec.topPeers.slice(0, 3);
  if (shown.length === 0) return null;
  const overflow = Math.max(0, rec.peerCount - shown.length);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onShowFarmers();
      }}
      className="group/farmers flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-osu-b3/50"
      title="See everyone who farmed this"
    >
      <Users className="h-3.5 w-3.5 shrink-0 text-osu-f1" />
      <div className="flex shrink-0 -space-x-1.5">
        {shown.map((peer) => (
          <span key={peer.userId} className="inline-flex rounded-full ring-2 ring-osu-b4">
            <Avatar url={peer.avatarUrl} userId={peer.userId} size={18} />
          </span>
        ))}
      </div>
      <span className="shrink-0 text-[11px] font-semibold text-osu-l2">
        {rec.peerCount}
        {overflow > 0 ? <span className="text-osu-f1"> players</span> : null}
      </span>
    </button>
  );
}

function farmStatusLabel(rec: LiveFarmHelperRec): string {
  if (rec.reason === "owned") return "cleared";
  if (rec.reason === "missing") return rec.peerFraction >= 0.45 ? "common pick" : "missing";
  if (rec.reason === "stale") return "old pb";
  if (rec.estimatedPpGain >= 70) return "large gap";
  return "improve";
}

function confidence(rec: LiveFarmHelperRec): number {
  // Prefer the real shape match (patternFit): "how much this chart is your kind
  // of chart". Older backends without patternFit fall back to the peer-popularity
  // heuristic so the card still shows something sensible.
  if (rec.patternFit != null) return Math.round(clampPct(rec.patternFit * 100));
  const peerScore = clampPct(rec.peerFraction * 100);
  const reasonBoost = rec.reason === "missing" ? 14 : rec.reason === "improve" ? 7 : 0;
  const difficultyPenalty = Math.max(0, rec.stars - 6) * 5;
  return Math.round(clampPct(peerScore + reasonBoost - difficultyPenalty));
}

function LoadingState() {
  return (
    <div className="grid w-full gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
          <div className="relative overflow-hidden">
            <Skeleton className="absolute inset-0 rounded-none opacity-50" />
            <div className="absolute inset-0 bg-gradient-to-t from-osu-b4 via-osu-b4/85 to-osu-b4/55" aria-hidden="true" />
            <div className="relative flex items-center gap-3 p-4">
              <Skeleton className="h-[52px] w-[52px] shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-24 max-w-full" />
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-2.5 w-28 max-w-full" />
              </div>
            </div>
          </div>
          <div className="space-y-2 border-t border-osu-b3/20 px-4 py-4">
            <Skeleton className="h-2.5 w-28" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-2.5 w-44 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-[38px] w-full rounded-xl" />
      </aside>

      <div className="min-w-0">
        <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
          <div className="border-b border-osu-b3/20 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-2.5 w-24" />
                <Skeleton className="h-4 w-64 max-w-full" />
              </div>
              <div className="flex overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/50">
                <Skeleton className="h-7 w-12 rounded-none border-r border-osu-b3/25" />
                <Skeleton className="h-7 w-10 rounded-none border-r border-osu-b3/25" />
                <Skeleton className="h-7 w-10 rounded-none" />
              </div>
            </div>
            <div className="mt-3 hidden flex-wrap items-center gap-x-3 gap-y-2 sm:flex">
              <FilterGroupSkeleton labelWidth="w-8" buttonWidths={["w-14", "w-20", "w-20", "w-14"]} />
              <FilterGroupSkeleton labelWidth="w-7" buttonWidths={["w-14", "w-10", "w-16", "w-12"]} />
            </div>
          </div>
          <div className="divide-y divide-osu-b3/20">
            {Array.from({ length: 6 }).map((_, i) => (
              <RecRowSkeleton key={i} index={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RecommendationsSkeleton({ layout }: { layout: LayoutMode }) {
  if (layout === "grid") {
    return (
      <div className="grid grid-cols-2 gap-2.5 bg-osu-b5 p-2.5 sm:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: GRID_PAGE_SIZE }).map((_, i) => (
          <RecCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="divide-y divide-osu-b3/20">
      {Array.from({ length: 6 }).map((_, i) => (
        <RecRowSkeleton key={i} index={i} />
      ))}
    </div>
  );
}

function FilterGroupSkeleton({ labelWidth, buttonWidths }: { labelWidth: string; buttonWidths: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      <Skeleton className={`h-2.5 ${labelWidth}`} />
      <div className="flex overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/50">
        {buttonWidths.map((width, index) => (
          <Skeleton key={index} className={`h-7 ${width} rounded-none border-r border-osu-b3/25 last:border-r-0`} />
        ))}
      </div>
    </div>
  );
}

function RecCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      <Skeleton className="h-[90px] w-full rounded-none" />
      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-3 w-24 min-w-0 flex-1" />
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-10" />
        </div>
        <div className="mt-2 flex items-center gap-1">
          <Skeleton className="h-[18px] w-[18px] rounded-full" />
          <Skeleton className="h-[18px] w-[18px] rounded-full" />
          <Skeleton className="h-[18px] w-[18px] rounded-full" />
          <Skeleton className="ml-1 h-2.5 w-8" />
        </div>
      </div>
    </div>
  );
}

function RecRowSkeleton({ index }: { index: number }) {
  const accents = ["bg-osu-yellow", "bg-osu-green-light", "bg-osu-blue"];
  return (
    <div className="relative bg-osu-b4">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${accents[index % accents.length]}`} />
      <div className="grid gap-3 p-2.5 pl-4 md:grid-cols-[56px_minmax(0,1fr)_118px] md:items-center md:gap-3.5 md:p-3 md:pl-5">
        <Skeleton className="h-14 w-full rounded-md md:h-[56px]" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <Skeleton className="h-3.5 w-80 max-w-[70%]" />
            <Skeleton className="h-4 w-6 rounded" />
          </div>
          <Skeleton className="mt-1.5 h-3 w-[460px] max-w-[80%]" />
          <div className="mt-1.5 flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-2.5 w-24" />
                <Skeleton className="h-2.5 w-28" />
              </div>
              <Skeleton className="mt-1 h-1 w-full rounded-full" />
            </div>
            <div className="hidden items-center gap-1.5 md:flex">
              <Skeleton className="h-3.5 w-3.5 rounded" />
              <div className="flex -space-x-1.5">
                <Skeleton className="h-[18px] w-[18px] rounded-full" />
                <Skeleton className="h-[18px] w-[18px] rounded-full" />
                <Skeleton className="h-[18px] w-[18px] rounded-full" />
              </div>
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 md:flex-col md:items-end md:justify-center md:gap-1.5">
          <div className="space-y-1.5 md:flex md:flex-col md:items-end">
            <Skeleton className="h-5 w-14" />
            <Skeleton className="h-2.5 w-20" />
          </div>
          <Skeleton className="h-7 w-7 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

function EmptyNotice({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1">{eyebrow}</div>
      <h2 className="mt-1 text-lg font-bold text-osu-c1">{title}</h2>
      <p className="mt-2 text-sm text-osu-f1">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

function FarmersModal({
  rec,
  userKey,
  keyMode,
  onClose,
}: {
  rec: LiveFarmHelperRec | null;
  userKey: string | null;
  keyMode: LiveFarmHelperKeyMode;
  onClose: () => void;
}) {
  const open = rec != null && userKey != null;
  const [scrollLocked, setScrollLocked] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    setScrollLocked(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!scrollLocked) return;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const prevScrollbarCompensation = document.documentElement.style.getPropertyValue("--modal-scrollbar-compensation");
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const hasStableScrollbarGutter =
      typeof CSS !== "undefined" && CSS.supports?.("scrollbar-gutter", "stable");
    document.body.style.overflow = "hidden";
    if (scrollbar > 0 && !hasStableScrollbarGutter) {
      const current = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${current + scrollbar}px`;
      document.documentElement.style.setProperty("--modal-scrollbar-compensation", `${scrollbar}px`);
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      if (prevScrollbarCompensation) {
        document.documentElement.style.setProperty("--modal-scrollbar-compensation", prevScrollbarCompensation);
      } else {
        document.documentElement.style.removeProperty("--modal-scrollbar-compensation");
      }
    };
  }, [scrollLocked]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setScrollLocked(false)}>
      {open && rec ? (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-6 sm:pl-6 sm:pr-[calc(1.5rem+var(--modal-scrollbar-compensation,0px))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/80" onClick={onClose} />
          <motion.div
            className="relative z-10 flex h-[min(34rem,calc(100dvh-1.5rem))] w-full max-w-[360px] flex-col overflow-hidden rounded-xl bg-osu-b5 shadow-2xl ring-1 ring-white/10 sm:h-[min(34rem,calc(100dvh-3rem))]"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative shrink-0 overflow-hidden border-b border-osu-b3/30 px-3 py-3">
              {rec.cover ? (
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-[0.12]"
                  style={{ backgroundImage: `url(${rec.cover})` }}
                  aria-hidden="true"
                />
              ) : null}
              <div className="relative flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">who farms this</div>
                  <div className="mt-0.5 truncate text-[13px] font-bold text-osu-c1">{rec.title}</div>
                  <div className="truncate text-[11px] text-osu-f1">
                    [{rec.version}] · {rec.keys}K · {rec.stars.toFixed(2)}★
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="shrink-0 rounded-lg bg-osu-b3/60 px-2 py-1 text-[11px] text-osu-l2 transition-colors hover:bg-osu-b3"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            {userKey ? (
              <FarmersList
                userKey={userKey}
                beatmapId={rec.beatmapId}
                speedBucket={rec.speedBucket}
                keyMode={keyMode}
                className="min-h-0 flex-1"
              />
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function ModList({ mods, size = 0.58, className = "" }: { mods: string[]; size?: number; className?: string }) {
  if (mods.length === 0) return null;
  return (
    <div className={`flex shrink-0 items-center justify-end gap-0.5 overflow-hidden ${className}`}>
      {mods.map((mod) => (
        <ModBadge key={mod} mod={mod} size={size} />
      ))}
    </div>
  );
}

function comparisonBar(rec: LiveFarmHelperRec): { left: string; right: string; pct: number } {
  if (rec.reason === "missing") {
    const pct = Math.round(rec.peerFraction * 100);
    return {
      left: `${pct}% of sampled nearby players farm this`,
      right: `median ${formatPp(rec.peerPpMedian)}pp`,
      pct: clampPct(pct),
    };
  }
  const subjectPp = rec.subjectPp ?? 0;
  const target = rec.reason === "stale" ? rec.peerPpP75 : rec.peerPpMedian;
  const pct = target > 0 ? clampPct(Math.round((subjectPp / target) * 100)) : 4;
  if (rec.reason === "stale") {
    return {
      left: `your ${formatPp(subjectPp)}pp · ${formatAge(rec.subjectPlayedAt)} old`,
      right: `top 25% ${formatPp(target)}pp`,
      pct,
    };
  }
  return {
    left: `your ${formatPp(subjectPp)}pp`,
    right: `median ${formatPp(target)}pp`,
    pct,
  };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(4, Math.min(100, value));
}

function countReasons(recs: LiveFarmHelperRec[]): Record<ReasonFilter, number> {
  const counts: Record<ReasonFilter, number> = { all: recs.length, missing: 0, improve: 0, stale: 0 };
  // "owned" only appears in the popular view, where the reason filter is hidden.
  for (const rec of recs) {
    if (rec.reason !== "owned") counts[rec.reason] += 1;
  }
  return counts;
}

function formatPp(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCompactPp(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")}k`;
  return formatPp(value);
}

function formatLength(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatAge(iso: string | null): string {
  if (!iso) return "a while";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return "a while";
  const months = Math.floor(ms / (30 * 86_400_000));
  if (months >= 12) return `${Math.floor(months / 12)}y`;
  if (months >= 1) return `${months}mo`;
  const days = Math.max(1, Math.floor(ms / 86_400_000));
  return `${days}d`;
}
