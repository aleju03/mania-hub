import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import type { MouseEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { getRankings } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { displayCountryName, isGlobalScope } from "../lib/country";
import { useLocale } from "../lib/locale-context";
import { isRegionScope } from "../lib/regions";
import { parseCountrySearchParam, withSearchParams } from "../lib/country-search";
import { formatNumber, formatAccuracy } from "../lib/format";
import { compareRankDeltaValues } from "../lib/rankings";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { PageHeader } from "../components/layout/PageHeader";
import { CountryWarming } from "../components/CountryWarming";
import { Pagination } from "../components/ui/Pagination";
import { useCountryWarming } from "../lib/use-country-warming";
import { RankingRowSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import { UsernameText } from "../components/ui/UsernameText";
import type { RankingsResponse } from "../lib/types";
import { useAppStore, useHiddenUserIds, useSelectedCountry } from "../store";
import { pageSeo } from "../lib/seo";
import { fetchLiveGlobalRankings, fetchLiveRankDeltas, fetchLiveRankingsSnapshot, type LiveGlobalRankingEntry, type LiveRankDelta } from "../lib/live-backend";
import { seedPlayerShellFromRankingEntry, seedPlayerShellsFromRankingEntries } from "../lib/player-shell-cache";
import { writeGlobalTopPlayersCache } from "../lib/global-top-players-cache";

type SortField = "rank" | "player" | "7d" | "cr7d" | "accuracy" | "playcount" | "pp" | "ss" | "s" | "a";
const GLOBAL_RANKINGS_PAGE_SIZE = 50;

// Both 7d columns render the same dash whether the player did not move or the
// backend has no week-old snapshot for them, so the hover carries the
// difference. A country only starts answering once it has been tracked for a
// week, and a player added to a roster mid-week waits out the rest of it.
const NO_DELTA_TITLE = msg`No rank data from 7 days ago yet`;
const NO_CHANGE_TITLE = msg`No change in the last 7 days`;

// Without stripping the default page, page=1 gets serialized into the URL
// and /rankings 307-redirects to /rankings?page=1, which breaks crawling
// (the sitemap lists /rankings and page 1's canonical points back to it).
// `page` must be optional in the schema for stripSearchParams to accept it.
type RankingsSearch = { page?: number; country: string | undefined };
const RANKINGS_SEARCH_DEFAULTS: Pick<RankingsSearch, "page"> = { page: 1 };

function parseRankingsPage(value: unknown): number {
  const page = Number(value ?? 1);
  return Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1;
}

function getPlayerPath(username: string): string {
  return `/player/${encodeURIComponent(username)}`;
}

type LiveGlobalGradeCounts = NonNullable<LiveGlobalRankingEntry["grade_counts"]>;

function formatKnownAccuracy(percent: number | null | undefined): string {
  if (percent == null) return "-";
  return Number.isFinite(percent) && percent > 0 ? formatAccuracy(percent / 100) : "-";
}

function formatKnownCount(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? formatNumber(value) : "-";
}

function getGlobalGradeTotal(
  counts: LiveGlobalRankingEntry["grade_counts"],
  keys: Array<keyof LiveGlobalGradeCounts>,
): number | null {
  if (!counts) return null;
  return keys.reduce((sum, key) => sum + counts[key], 0);
}

function handlePlayerAuxClick(event: MouseEvent<HTMLElement>, username: string): void {
  if (event.button !== 1) return;
  if ((event.target as Element | null)?.closest("a")) return;

  window.open(getPlayerPath(username), "_blank", "noopener,noreferrer");
}

export const Route = createFileRoute("/rankings")({
  validateSearch: (search: Record<string, unknown>): RankingsSearch => ({
    page: parseRankingsPage(search.page),
    country: parseCountrySearchParam(search.country),
  }),
  search: {
    middlewares: [stripSearchParams(RANKINGS_SEARCH_DEFAULTS)],
  },
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? displayCountryName(country, match.context.locale) : null;
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: countryName ? i18n._(msg`${countryName} mania rankings`) : i18n._(msg`Country mania rankings`),
      description: countryName
        ? i18n._(msg`Top osu!mania players in ${countryName}`)
        : i18n._(msg`osu!mania country rankings`),
      path: withSearchParams("/rankings", { page: (match.search.page ?? 1) > 1 ? match.search.page : undefined, country }),
      origin: match.context.origin,
      imageCountry: country,
      imageKind: "rankings",
      imageTitle: countryName ? `${countryName} mania rankings` : "Country mania rankings",
    });
  },
  component: RankingsPage,
});

function RankingsPage() {
  const { t, i18n } = useLingui();
  const { page = 1, country } = Route.useSearch();
  const navigate = useNavigate();
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = country ?? fallbackCountry;
  const cachedPageOneData = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((state) => state.setRankings);
  const hiddenUserIds = useHiddenUserIds();
  const [pageTwoData, setPageTwoData] = useState<RankingsResponse | null>(null);
  const [pageTwoFetchedAt, setPageTwoFetchedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortField>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [liveRankDeltas, setLiveRankDeltas] = useState<Record<number, LiveRankDelta>>({});
  const [rankDeltasReady, setRankDeltasReady] = useState(false);
  const pageData = page === 1 ? cachedPageOneData : pageTwoData;
  const [rankingsLoading, setRankingsLoading] = useState(!(page === 1 ? cachedPageOneData : pageTwoData));
  const [deltasLoading, setDeltasLoading] = useState(false);
  const locale = useLocale();
  const countryName = displayCountryName(selectedCountry, locale);
  const totalPlayers = cachedPageOneData?.total ?? pageData?.total ?? 0;
  const hasNextPage = totalPlayers > 50;
  const { warming } = useCountryWarming(selectedCountry);
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  const selectedIsRegion = isRegionScope(selectedCountry);
  // Global and regions share the live-backend board UI (the osu! API has no
  // leaderboard for either); only the fetcher differs.
  const boardScope = selectedIsGlobal || selectedIsRegion;
  const [globalRankings, setGlobalRankings] = useState<LiveGlobalRankingEntry[] | null>(null);
  const [globalRankingsTotal, setGlobalRankingsTotal] = useState(0);
  const [globalRankingsLoading, setGlobalRankingsLoading] = useState(false);
  const globalTotalPages = Math.max(1, Math.ceil(globalRankingsTotal / GLOBAL_RANKINGS_PAGE_SIZE));

  useEffect(() => {
    if (!boardScope) return;
    let cancelled = false;
    setGlobalRankings(null);
    setGlobalRankingsLoading(true);
    const params = {
      page,
      pageSize: GLOBAL_RANKINGS_PAGE_SIZE,
      sort: sortBy === "pp" ? ("rank" as const) : sortBy,
      dir: sortDir,
    };
    (selectedIsGlobal ? fetchLiveGlobalRankings(params) : fetchLiveRankingsSnapshot(selectedCountry, params))
      .then((snapshot) => {
        if (cancelled) return;
        if (selectedIsGlobal && page === 1 && sortBy === "rank" && sortDir === "desc") {
          writeGlobalTopPlayersCache(snapshot.ranking, snapshot.fetchedAt);
        }
        setGlobalRankings(snapshot.ranking);
        setGlobalRankingsTotal(snapshot.total);
      })
      .catch(() => {
        if (!cancelled) setGlobalRankings([]);
      })
      .finally(() => {
        if (!cancelled) setGlobalRankingsLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardScope, page, selectedCountry, selectedIsGlobal, sortBy, sortDir]);

  useEffect(() => {
    setPageTwoData(null);
    setPageTwoFetchedAt(null);
    setLiveRankDeltas({});
    setRankDeltasReady(false);
    setError(null);
  }, [selectedCountry]);

  useEffect(() => {
    if (!boardScope || sortBy !== "pp") return;
    setSortBy("rank");
    setSortDir("desc");
  }, [boardScope, sortBy]);

  useEffect(() => {
    if (!boardScope || globalRankingsTotal === 0 || page <= globalTotalPages) return;
    navigate({ to: "/rankings", search: { page: globalTotalPages, country: selectedCountry }, replace: true });
  }, [boardScope, globalRankingsTotal, globalTotalPages, navigate, page, selectedCountry]);

  useEffect(() => {
    if (page === 2 && totalPlayers > 0 && !hasNextPage) {
      navigate({ to: "/rankings", search: { page: 1, country: selectedCountry }, replace: true });
    }
  }, [hasNextPage, navigate, page, selectedCountry, totalPlayers]);

  useEffect(() => {
    if (boardScope || page <= 2) return;
    navigate({ to: "/rankings", search: { page: 2, country: selectedCountry }, replace: true });
  }, [boardScope, navigate, page, selectedCountry]);

  useEffect(() => {
    if (!pageData) return;
    seedPlayerShellsFromRankingEntries(pageData.ranking.slice(0, 50), (page - 1) * 50 + 1);
  }, [page, pageData]);

  useEffect(() => {
    let cancelled = false;
    // Global and regions have no single-country leaderboard to fetch from the
    // osu! API; the board effect above owns them.
    if (isGlobalScope(selectedCountry) || isRegionScope(selectedCountry)) {
      setRankingsLoading(false);
      return () => { cancelled = true; };
    }
    const knownTotal = cachedPageOneData?.total ?? null;

    if (page === 2 && knownTotal !== null && knownTotal <= 50) {
      setRankingsLoading(false);
      return () => { cancelled = true; };
    }

    const cachedData = page === 1 ? cachedPageOneData : pageTwoData;
    const fetchedAt = page === 1 ? rankingsFetchedAt : pageTwoFetchedAt;
    const shouldRefresh = !cachedData || isCacheStale(fetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefresh) {
      setRankingsLoading(false);
      setError(null);
      return () => { cancelled = true; };
    }

    setRankingsLoading(!pageData);

    getRankings({ data: { type: "performance", page, country: selectedCountry } })
      .then((result) => {
        if (cancelled) return;
        if (page === 1) setRankings(selectedCountry, result);
        else {
          setPageTwoData(result);
          setPageTwoFetchedAt(Date.now());
        }
        setError(null);
      })
      .catch(() => {
        if (cancelled || pageData) return;
        setError(t`Couldn't load the ${countryName} rankings right now.`);
      })
      .finally(() => {
        if (cancelled) return;
        setRankingsLoading(false);
      });

    return () => { cancelled = true; };
  }, [cachedPageOneData, page, pageData, pageTwoData, pageTwoFetchedAt, rankingsFetchedAt, selectedCountry, setRankings, countryName]);

  useEffect(() => {
    if (!pageData) return;
    let cancelled = false;
    const userIds = pageData.ranking.slice(0, 50).map((e) => e.user.id);

    // The live backend is the only source for these. There is deliberately no
    // osu! fallback: rank_history only exists on the single-user endpoint, so
    // covering a 50-row page from osu! costs 50 calls, in the interactive
    // limiter lane that skips the shared spacing gate, so they arrive as a
    // burst. Browsing to a country the backend has no week-old snapshot for
    // did that on every view: five such pages produced 292 of 315
    // rank-history calls in one 6h window and helped push the budget to 84/min
    // against a 55 target (2026-08-06). A row with no delta shows "-" instead,
    // with the reason on hover.
    const loadRankDeltas = async () => {
      setRankDeltasReady(false);
      const missingIds = userIds.filter((userId) => !liveRankDeltas[userId]);
      if (missingIds.length === 0) {
        setDeltasLoading(false);
        setRankDeltasReady(true);
        return;
      }
      setDeltasLoading(true);
      try {
        const snapshot = await fetchLiveRankDeltas(selectedCountry, missingIds);
        if (cancelled) return;
        if (Object.keys(snapshot.deltas).length > 0) {
          setLiveRankDeltas((current) => ({ ...current, ...snapshot.deltas }));
        }
      } catch {
        // Leaves the rows at "-"; a transient backend failure reads the same as
        // no snapshot yet, and the next page entry retries.
      } finally {
        if (!cancelled) {
          setDeltasLoading(false);
          setRankDeltasReady(true);
        }
      }
    };

    void loadRankDeltas();

    return () => { cancelled = true; };
    // liveRankDeltas is read to skip rows already covered, but is deliberately
    // not a dep: re-running on every delta arrival would re-request the rows
    // the backend just told us it has no snapshot for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageData, selectedCountry]);

  const liveCountryRankChanges = useMemo(() => (
    Object.fromEntries(
      Object.entries(liveRankDeltas)
        .filter(([, delta]) => delta.countryChange !== null)
        .map(([userId, delta]) => [Number(userId), delta.countryChange as number]),
    )
  ), [liveRankDeltas]);

  const sortedRankings = useMemo(() => {
    if (!pageData) return [];
    const startRank = (page - 1) * 50;
    // originalRank is taken from the unfiltered index so hiding a player
    // leaves a gap (e.g. #4 then #6) rather than renumbering the leaderboard.
    const entries = pageData.ranking
      .slice(0, 50)
      .map((entry, i) => ({ entry, originalRank: startRank + i + 1 }))
      .filter(({ entry }) => !hiddenUserIds.has(entry.user.id));
    if (sortBy === "rank") return sortDir === "desc" ? entries : [...entries].reverse();

    return [...entries].sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      switch (sortBy) {
        case "player":
          aVal = a.entry.user.username.toLowerCase();
          bVal = b.entry.user.username.toLowerCase();
          return sortDir === "asc"
            ? (aVal as string).localeCompare(bVal as string)
            : (bVal as string).localeCompare(aVal as string);
        case "7d": {
          const aDelta = liveRankDeltas[a.entry.user.id]?.globalChange ?? null;
          const bDelta = liveRankDeltas[b.entry.user.id]?.globalChange ?? null;
          return compareRankDeltaValues(aDelta, bDelta, sortDir) || a.originalRank - b.originalRank;
        }
        case "cr7d": {
          const aDelta = liveCountryRankChanges[a.entry.user.id];
          const bDelta = liveCountryRankChanges[b.entry.user.id];
          return compareRankDeltaValues(aDelta, bDelta, sortDir) || a.originalRank - b.originalRank;
        }
        case "accuracy":
          aVal = a.entry.hit_accuracy;
          bVal = b.entry.hit_accuracy;
          break;
        case "playcount":
          aVal = a.entry.play_count;
          bVal = b.entry.play_count;
          break;
        case "pp":
          aVal = a.entry.pp;
          bVal = b.entry.pp;
          break;
        case "ss":
          aVal = a.entry.grade_counts.ss + a.entry.grade_counts.ssh;
          bVal = b.entry.grade_counts.ss + b.entry.grade_counts.ssh;
          break;
        case "s":
          aVal = a.entry.grade_counts.s + a.entry.grade_counts.sh;
          bVal = b.entry.grade_counts.s + b.entry.grade_counts.sh;
          break;
        case "a":
          aVal = a.entry.grade_counts.a;
          bVal = b.entry.grade_counts.a;
          break;
      }
      return sortDir === "desc" ? (bVal as number) - (aVal as number) : (aVal as number) - (bVal as number);
    });
  }, [pageData, page, sortBy, sortDir, liveRankDeltas, liveCountryRankChanges, hiddenUserIds]);

  const visibleGlobalRankings = useMemo(
    () => (globalRankings ?? [])
      .map((entry) => ({ entry, originalRank: entry.rank }))
      .filter(({ entry }) => !hiddenUserIds.has(entry.user.id)),
    [globalRankings, hiddenUserIds],
  );

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      if (sortDir === "desc") setSortDir("asc");
      else { setSortBy("rank"); setSortDir("desc"); }
    } else {
      setSortBy(field);
      setSortDir("desc");
    }
    if (boardScope && page !== 1) {
      navigate({ to: "/rankings", search: { page: 1, country: selectedCountry }, replace: true });
    }
  };

  if (boardScope) {
    return (
      <div className="flex-1">
        <PageHeader
          iconSrc="/images/icons/rankings.svg"
          title={selectedIsGlobal ? t`Global mania rankings` : t`${countryName} mania rankings`}
          right={
            globalRankingsTotal > 0 ? (
              <span className="text-[10px] text-osu-f1"><Trans>{formatNumber(globalRankingsTotal)} tracked players</Trans></span>
            ) : null
          }
        />
        <div className="bg-osu-b5">
          <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5">
            <div className="sm:hidden">
            <div className="flex items-center gap-1.5 pb-3 overflow-x-auto scrollbar-hide">
              {([
                { field: "rank" as SortField, label: "#" },
                { field: "player" as SortField, label: t`Player` },
                { field: "7d" as SortField, label: t`7d` },
                { field: "cr7d" as SortField, label: t`7d Country` },
                { field: "accuracy" as SortField, label: t`Acc` },
                { field: "playcount" as SortField, label: t`Plays` },
              ]).map(({ field, label }) => {
                const active = sortBy === field;
                return (
                  <button
                    key={field}
                    onClick={() => handleSort(field)}
                    className={`flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                      active
                        ? "bg-osu-pink/20 text-osu-pink-light"
                        : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b4"
                    }`}
                  >
                    {label}
                    {active && <span className="ml-0.5 text-[8px]">{sortDir === "desc" ? "▼" : "▲"}</span>}
                  </button>
                );
              })}
              {([
                { field: "ss" as SortField, img: "/images/badges/score-ranks-v2019/GradeSmall-SS.svg", alt: "SS" },
                { field: "s" as SortField, img: "/images/badges/score-ranks-v2019/GradeSmall-S.svg", alt: "S" },
                { field: "a" as SortField, img: "/images/badges/score-ranks-v2019/GradeSmall-A.svg", alt: "A" },
              ]).map(({ field, img, alt }) => {
                const active = sortBy === field;
                return (
                  <button
                    key={field}
                    onClick={() => handleSort(field)}
                    className={`flex-shrink-0 px-2 py-1 rounded-md transition-colors cursor-pointer ${
                      active
                        ? "bg-osu-pink/20"
                        : "bg-osu-b4/60 hover:bg-osu-b4"
                    }`}
                  >
                    <div className="flex items-center gap-0.5">
                      <img src={img} alt={alt} width={18} height={18} className={`transition-opacity ${active ? "opacity-100" : "opacity-60"}`} />
                      {active && <span className="text-osu-pink text-[8px]">{sortDir === "desc" ? "▼" : "▲"}</span>}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="space-y-2">
              {(globalRankings == null || globalRankingsLoading) && visibleGlobalRankings.length === 0 ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="space-y-2 rounded-lg bg-osu-b4/50 p-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="w-8 h-4" />
                      <Skeleton className="w-9 h-9 rounded-full" />
                      <Skeleton className="h-4 flex-1" />
                    </div>
                    <div className="flex gap-2">
                      <Skeleton className="h-3 flex-1" />
                      <Skeleton className="h-3 w-14" />
                    </div>
                  </div>
                ))
              ) : visibleGlobalRankings.length > 0 ? (
                visibleGlobalRankings.map(({ entry, originalRank }) => {
                  const sortedValue = (() => {
                    switch (sortBy) {
                      case "playcount": {
                        const plays = formatKnownCount(entry.play_count);
                        return plays === "-" ? <>{plays}</> : <Trans>{plays} plays</Trans>;
                      }
                      case "accuracy":
                        return <>{formatKnownAccuracy(entry.hit_accuracy)}</>;
                      case "ss":
                        return <div className="flex items-center gap-1">
                          <img src="/images/badges/score-ranks-v2019/GradeSmall-SS.svg" alt="SS" width={16} height={16} />
                          <span>{formatKnownCount(getGlobalGradeTotal(entry.grade_counts, ["ss", "ssh"]))}</span>
                        </div>;
                      case "s":
                        return <div className="flex items-center gap-1">
                          <img src="/images/badges/score-ranks-v2019/GradeSmall-S.svg" alt="S" width={16} height={16} />
                          <span>{formatKnownCount(getGlobalGradeTotal(entry.grade_counts, ["s", "sh"]))}</span>
                        </div>;
                      case "a":
                        return <div className="flex items-center gap-1">
                          <img src="/images/badges/score-ranks-v2019/GradeSmall-A.svg" alt="A" width={16} height={16} />
                          <span>{formatKnownCount(getGlobalGradeTotal(entry.grade_counts, ["a"]))}</span>
                        </div>;
                      default:
                        return <>{formatNumber(Math.round(entry.pp))}pp</>;
                    }
                  })();

                  return (
                    <Link
                      key={entry.user.id}
                      to="/player/$username"
                      params={{ username: entry.user.username }}
                      className="block rounded-lg bg-osu-b4/50 p-3 cursor-pointer hover:bg-osu-b4 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-osu-f1 w-8">#{originalRank}</span>
                        <Avatar url={entry.user.avatar_url} userId={entry.user.id} size={36} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <UsernameText
                              username={entry.user.username}
                              avatarUrl={entry.user.avatar_url}
                              className="text-sm font-semibold truncate"
                            />
                            <CountryFlag code={entry.user.country_code} size="sm" />
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-osu-f1">
                            <span>{formatKnownAccuracy(entry.hit_accuracy)}</span>
                            <RankDeltaLabel label={t`7d`} change={entry.global_change} />
                            <RankDeltaLabel label={entry.user.country_code} change={entry.country_change} />
                          </div>
                        </div>
                        <span className="text-sm font-bold text-right flex-shrink-0">{sortedValue}</span>
                      </div>
                    </Link>
                  );
                })
              ) : (
                <div className="px-4 py-10 text-center text-xs text-osu-f1"><Trans>No ranked players yet.</Trans></div>
              )}
            </div>
            </div>

            <div className="hidden sm:block rounded-xl overflow-hidden border border-osu-b3/30">
              <table className="w-full table-fixed">
                <colgroup>
                  <col className="w-[5%]" />
                  <col />
                  <col className="w-[11%]" />
                  <col className="w-[9%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                  <col className="w-[7%]" />
                  <col className="w-[5%]" />
                  <col className="w-[5%]" />
                  <col className="w-[5%]" />
                </colgroup>
                <thead>
                  <tr className="bg-osu-b4 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
                    <th className="py-2.5 px-3 text-left w-12">#</th>
                    <SortableHeader field="player" label={t`Player`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="left" />
                    <SortableHeader field="7d" label={t`7d Global`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-32" />
                    <SortableHeader field="cr7d" label={t`7d Country`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-24" />
                    <SortableHeader field="accuracy" label={t`Accuracy`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                    <SortableHeader field="playcount" label={t`Play Count`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                    <th className="py-2.5 px-3 text-right">PP</th>
                    <SortableGradeHeader field="ss" activeSort={sortBy} sortDir={sortDir} onSort={handleSort}
                      img="/images/badges/score-ranks-v2019/GradeSmall-SS.svg" alt="SS" />
                    <SortableGradeHeader field="s" activeSort={sortBy} sortDir={sortDir} onSort={handleSort}
                      img="/images/badges/score-ranks-v2019/GradeSmall-S.svg" alt="S" />
                    <SortableGradeHeader field="a" activeSort={sortBy} sortDir={sortDir} onSort={handleSort}
                      img="/images/badges/score-ranks-v2019/GradeSmall-A.svg" alt="A" />
                  </tr>
                </thead>
                <tbody>
                  {(globalRankings == null || globalRankingsLoading) && visibleGlobalRankings.length === 0 ? (
                    Array.from({ length: 10 }).map((_, i) => (
                      <tr key={i} className="border-t border-osu-b3/20">
                        <td colSpan={10} className="px-3 py-1.5">
                          <RankingRowSkeleton />
                        </td>
                      </tr>
                    ))
                  ) : visibleGlobalRankings.length > 0 ? (
                    visibleGlobalRankings.map(({ entry, originalRank }, i) => (
                      <tr
                        key={entry.user.id}
                        className="border-t border-osu-b3/20 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
                        style={{ background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent" }}
                        onClick={() => navigate({ to: "/player/$username", params: { username: entry.user.username } })}
                        onAuxClick={(event) => handlePlayerAuxClick(event, entry.user.username)}
                      >
                        <td className="py-2.5 px-3 text-sm font-bold text-osu-f1">#{originalRank}</td>
                        <td className="py-2.5 px-3">
                          <Link
                            to="/player/$username"
                            params={{ username: entry.user.username }}
                            className="flex items-center gap-3 min-w-0"
                          >
                            <Avatar url={entry.user.avatar_url} userId={entry.user.id} size={30} />
                            <UsernameText
                              username={entry.user.username}
                              avatarUrl={entry.user.avatar_url}
                              className="text-sm font-medium truncate min-w-0"
                            />
                            <CountryFlag code={entry.user.country_code} size="sm" />
                          </Link>
                        </td>
                        <td className="py-2.5 px-3">
                          <GlobalRankCell rankChange={entry.global_change} loaded />
                        </td>
                        <td className="py-2.5 px-3">
                          <CRRankCell change={entry.country_change} loaded />
                        </td>
                        <td className="py-2.5 px-3 text-sm text-osu-l2 text-right">{formatKnownAccuracy(entry.hit_accuracy)}</td>
                        <td className="py-2.5 px-3 text-sm text-osu-f1 text-right">{formatKnownCount(entry.play_count)}</td>
                        <td className="py-2.5 px-3 text-sm font-bold text-right">{formatNumber(Math.round(entry.pp))}</td>
                        <td className={`py-2.5 px-3 text-xs text-center ${sortBy === "ss" ? "text-white font-semibold" : "text-osu-f1"}`}>
                          {formatKnownCount(getGlobalGradeTotal(entry.grade_counts, ["ss", "ssh"]))}
                        </td>
                        <td className={`py-2.5 px-3 text-xs text-center ${sortBy === "s" ? "text-white font-semibold" : "text-osu-f1"}`}>
                          {formatKnownCount(getGlobalGradeTotal(entry.grade_counts, ["s", "sh"]))}
                        </td>
                        <td className={`py-2.5 px-3 text-xs text-center ${sortBy === "a" ? "text-white font-semibold" : "text-osu-f1"}`}>
                          {formatKnownCount(getGlobalGradeTotal(entry.grade_counts, ["a"]))}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={10} className="px-4 py-10 text-center text-xs text-osu-f1"><Trans>No ranked players yet.</Trans></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {globalTotalPages > 1 && (
              <Pagination
                page={Math.min(Math.max(page, 1), globalTotalPages) - 1}
                totalPages={globalTotalPages}
                onPageChange={(nextPage) => {
                  if (globalRankingsLoading) return;
                  navigate({ to: "/rankings", search: { page: nextPage + 1, country: selectedCountry } });
                }}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title={t`${countryName} mania rankings`}
        right={
          <>
            {!pageData && rankingsLoading && !error && <span className="text-[10px] text-osu-f1"><Trans>Loading rankings...</Trans></span>}
            {pageData && deltasLoading && (
              <span className="text-[10px] text-osu-f1"><Trans>Checking 7d changes...</Trans></span>
            )}
          </>
        }
      />

      {warming && <CountryWarming country={selectedCountry} />}

      {!warming && (
      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5">
          <div className="sm:hidden">
          {/* Mobile sort bar */}
          <div className="flex items-center gap-1.5 pb-3 overflow-x-auto scrollbar-hide">
            {([
              { field: "rank" as SortField, label: "#" },
              { field: "player" as SortField, label: t`Player` },
              { field: "pp" as SortField, label: "PP" },
              { field: "accuracy" as SortField, label: t`Acc` },
              { field: "7d" as SortField, label: t`7d` },
              { field: "cr7d" as SortField, label: selectedCountry },
              { field: "playcount" as SortField, label: t`Plays` },
            ]).map(({ field, label }) => {
              const active = sortBy === field;
              return (
                <button
                  key={field}
                  onClick={() => handleSort(field)}
                  className={`flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                    active
                      ? "bg-osu-pink/20 text-osu-pink-light"
                      : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b4"
                  }`}
                >
                  {label}
                  {active && <span className="ml-0.5 text-[8px]">{sortDir === "desc" ? "▼" : "▲"}</span>}
                </button>
              );
            })}
            {([
              { field: "ss" as SortField, img: "/images/badges/score-ranks-v2019/GradeSmall-SS.svg", alt: "SS" },
              { field: "s" as SortField, img: "/images/badges/score-ranks-v2019/GradeSmall-S.svg", alt: "S" },
              { field: "a" as SortField, img: "/images/badges/score-ranks-v2019/GradeSmall-A.svg", alt: "A" },
            ]).map(({ field, img, alt }) => {
              const active = sortBy === field;
              return (
                <button
                  key={field}
                  onClick={() => handleSort(field)}
                  className={`flex-shrink-0 px-2 py-1 rounded-md transition-colors cursor-pointer ${
                    active
                      ? "bg-osu-pink/20"
                      : "bg-osu-b4/60 hover:bg-osu-b4"
                  }`}
                >
                  <div className="flex items-center gap-0.5">
                    <img src={img} alt={alt} width={18} height={18} className={`transition-opacity ${active ? "opacity-100" : "opacity-60"}`} />
                    {active && <span className="text-osu-pink text-[8px]">{sortDir === "desc" ? "▼" : "▲"}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Mobile card layout */}
          <div className="space-y-2">
            {error ? (
              <div className="px-4 py-8 text-center text-sm text-osu-f1">{error}</div>
            ) : pageData ? (
              sortedRankings.map(({ entry, originalRank }) => {
                const liveDelta = liveRankDeltas[entry.user.id];
                const globalChange = liveDelta?.globalChange ?? null;
                const crChange = liveDelta?.countryChange ?? null;

                // Show the value for the active sort field on the right side
                const sortedValue = (() => {
                  switch (sortBy) {
                    case "playcount":
                      return <Trans>{formatNumber(entry.play_count)} plays</Trans>;
                    case "accuracy":
                      return <>{formatAccuracy(entry.hit_accuracy / 100)}</>;
                    case "ss":
                      return <div className="flex items-center gap-1">
                        <img src="/images/badges/score-ranks-v2019/GradeSmall-SS.svg" alt="SS" width={16} height={16} />
                        <span>{entry.grade_counts.ss + entry.grade_counts.ssh}</span>
                      </div>;
                    case "s":
                      return <div className="flex items-center gap-1">
                        <img src="/images/badges/score-ranks-v2019/GradeSmall-S.svg" alt="S" width={16} height={16} />
                        <span>{entry.grade_counts.s + entry.grade_counts.sh}</span>
                      </div>;
                    case "a":
                      return <div className="flex items-center gap-1">
                        <img src="/images/badges/score-ranks-v2019/GradeSmall-A.svg" alt="A" width={16} height={16} />
                        <span>{entry.grade_counts.a}</span>
                      </div>;
                    default:
                      return <>{formatNumber(Math.round(entry.pp))}pp</>;
                  }
                })();

                // Show contextual subtitle based on sort
                const subtitle = (() => {
                  if (sortBy === "7d" || sortBy === "cr7d") {
                    return (
                      <div className="flex items-center gap-2">
                        {sortBy === "7d" && (globalChange !== null || rankDeltasReady) && (
                          globalChange !== null && globalChange !== 0 ? (
                            <span className={`font-semibold ${globalChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
                              {globalChange > 0 ? `+${formatNumber(globalChange)}` : formatNumber(globalChange)}
                            </span>
                          ) : (
                            <span title={globalChange === null ? i18n._(NO_DELTA_TITLE) : i18n._(NO_CHANGE_TITLE)}><Trans>7d -</Trans></span>
                          )
                        )}
                        {sortBy === "cr7d" && (
                          crChange !== null && crChange !== 0 ? (
                            <span className={`font-semibold ${crChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
                              {selectedCountry} {crChange > 0 ? `+${crChange}` : crChange}
                            </span>
                          ) : (
                            <span title={crChange === null ? i18n._(NO_DELTA_TITLE) : i18n._(NO_CHANGE_TITLE)}>{selectedCountry} -</span>
                          )
                        )}
                      </div>
                    );
                  }
                  // Default: accuracy, plus the 7d move when there is one
                  return (
                    <>
                      <span>{formatAccuracy(entry.hit_accuracy / 100)}</span>
                      {globalChange !== null && globalChange !== 0 && (
                        <span className={`font-semibold ${globalChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
                          {globalChange > 0 ? `+${formatNumber(globalChange)}` : formatNumber(globalChange)}
                        </span>
                      )}
                    </>
                  );
                })();

                return (
                  <Link
                    key={entry.user.id}
                    to="/player/$username"
                    params={{ username: entry.user.username }}
                    onClick={() => seedPlayerShellFromRankingEntry(entry, originalRank)}
                    className="block rounded-lg bg-osu-b4/50 p-3 cursor-pointer hover:bg-osu-b4 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-osu-f1 w-8">#{originalRank}</span>
                      <Avatar url={entry.user.avatar_url} userId={entry.user.id} size={36} online={entry.user.is_online} />
                      <div className="flex-1 min-w-0">
                        <UsernameText
                          username={entry.user.username}
                          avatarUrl={entry.user.avatar_url}
                          className="text-sm font-semibold"
                        />
                        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-osu-f1">
                          {subtitle}
                        </div>
                      </div>
                      <span className="text-sm font-bold text-right flex-shrink-0">{sortedValue}</span>
                    </div>
                  </Link>
                );
              })
            ) : (
              Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="space-y-2 rounded-lg bg-osu-b4/50 p-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="w-8 h-4" />
                    <Skeleton className="w-9 h-9 rounded-full" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                  <div className="flex gap-2">
                    <Skeleton className="h-3 flex-1" />
                    <Skeleton className="h-3 w-14" />
                  </div>
                </div>
              ))
            )}
          </div>
          </div>

          <div className="hidden sm:block rounded-xl overflow-hidden border border-osu-b3/30">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-[5%]" />
                <col />
                <col className="w-[11%]" />
                <col className="w-[7%]" />
                <col className="w-[10%]" />
                <col className="w-[11%]" />
                <col className="w-[7%]" />
                <col className="w-[5%]" />
                <col className="w-[5%]" />
                <col className="w-[5%]" />
              </colgroup>
              <thead>
                <tr className="bg-osu-b4 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
                  <th className="py-2.5 px-3 text-left w-12">#</th>
                  <SortableHeader field="player" label={t`Player`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="left" />
                  <SortableHeader field="7d" label={t`7d Global`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-32" />
                  <SortableHeader field="cr7d" label={t`7d ${selectedCountry}`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-16" />
                  <SortableHeader field="accuracy" label={t`Accuracy`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                  <SortableHeader field="playcount" label={t`Play Count`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                  <SortableHeader field="pp" label="PP" activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                  <SortableGradeHeader field="ss" activeSort={sortBy} sortDir={sortDir} onSort={handleSort}
                    img="/images/badges/score-ranks-v2019/GradeSmall-SS.svg" alt="SS" />
                  <SortableGradeHeader field="s" activeSort={sortBy} sortDir={sortDir} onSort={handleSort}
                    img="/images/badges/score-ranks-v2019/GradeSmall-S.svg" alt="S" />
                  <SortableGradeHeader field="a" activeSort={sortBy} sortDir={sortDir} onSort={handleSort}
                    img="/images/badges/score-ranks-v2019/GradeSmall-A.svg" alt="A" />
                </tr>
              </thead>
              <tbody>
                {error ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-sm text-osu-f1">
                      {error}
                    </td>
                  </tr>
                ) : pageData ? (
                  sortedRankings.map(({ entry, originalRank }, i: number) => {
                    const liveDelta = liveRankDeltas[entry.user.id];
                    const globalChange = liveDelta?.globalChange ?? null;
                    const crChange = liveDelta?.countryChange ?? null;
                    const deltasLoaded = rankDeltasReady || !!liveDelta;

                    return (
                      <tr
                        key={entry.user.id}
                        className="border-t border-osu-b3/20 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
                        style={{ background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent" }}
                        onClick={() => {
                          seedPlayerShellFromRankingEntry(entry, originalRank);
                          navigate({ to: "/player/$username", params: { username: entry.user.username } });
                        }}
                        onAuxClick={(event) => {
                          seedPlayerShellFromRankingEntry(entry, originalRank);
                          handlePlayerAuxClick(event, entry.user.username);
                        }}
                      >
                        <td className="py-2.5 px-3 text-sm font-bold text-osu-f1">#{originalRank}</td>
                        <td className="py-2.5 px-3">
                          <Link
                            to="/player/$username"
                            params={{ username: entry.user.username }}
                            onClick={() => seedPlayerShellFromRankingEntry(entry, originalRank)}
                            className="flex items-center gap-3 min-w-0"
                          >
                            <Avatar url={entry.user.avatar_url} userId={entry.user.id} size={30} online={entry.user.is_online} />
                            <UsernameText
                              username={entry.user.username}
                              avatarUrl={entry.user.avatar_url}
                              className="text-sm font-medium truncate min-w-0"
                            />
                          </Link>
                        </td>
                        <td className="py-2.5 px-3">
                          <GlobalRankCell rankChange={globalChange} loaded={deltasLoaded} />
                        </td>
                        <td className="py-2.5 px-3">
                          <CRRankCell change={crChange} loaded={deltasLoaded} />
                        </td>
                        <td className="py-2.5 px-3 text-sm text-osu-l2 text-right">{formatAccuracy(entry.hit_accuracy / 100)}</td>
                        <td className="py-2.5 px-3 text-sm text-osu-f1 text-right">{formatNumber(entry.play_count)}</td>
                        <td className="py-2.5 px-3 text-sm font-bold text-right">{formatNumber(Math.round(entry.pp))}</td>
                        <td className={`py-2.5 px-3 text-xs text-center ${sortBy === "ss" ? "text-white font-semibold" : "text-osu-f1"}`}>
                          {entry.grade_counts.ss + entry.grade_counts.ssh}
                        </td>
                        <td className={`py-2.5 px-3 text-xs text-center ${sortBy === "s" ? "text-white font-semibold" : "text-osu-f1"}`}>
                          {entry.grade_counts.s + entry.grade_counts.sh}
                        </td>
                        <td className={`py-2.5 px-3 text-xs text-center ${sortBy === "a" ? "text-white font-semibold" : "text-osu-f1"}`}>
                          {entry.grade_counts.a}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-t border-osu-b3/20">
                      <td colSpan={10} className="px-3 py-1.5">
                        <RankingRowSkeleton />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {hasNextPage && (
            <div className="flex items-center justify-center gap-3 pt-4">
              <button
                onClick={() => navigate({ to: "/rankings", search: { page: 1, country: selectedCountry } })}
                disabled={page === 1}
                className="px-4 py-2 rounded-lg bg-osu-b4 text-xs font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <Trans>Page 1</Trans>
              </button>
              <button
                onClick={() => navigate({ to: "/rankings", search: { page: 2, country: selectedCountry } })}
                disabled={page === 2}
                className="px-4 py-2 rounded-lg bg-osu-b4 text-xs font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <Trans>Next Page</Trans>
              </button>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function GlobalRankCell({ rankChange, loaded }: { rankChange: number | null; loaded: boolean }) {
  const { i18n } = useLingui();
  if (!loaded) {
    return <div className="flex items-center justify-center"><Skeleton className="w-20 h-4" /></div>;
  }
  return (
    <div className="flex items-center justify-center gap-2">
      {rankChange !== null && rankChange !== 0 ? (
        <span className={`text-[11px] font-semibold ${rankChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
          {rankChange > 0 ? `+${formatNumber(rankChange)}` : formatNumber(rankChange)}
        </span>
      ) : (
        <span className="text-[11px] text-osu-f1" title={rankChange === null ? i18n._(NO_DELTA_TITLE) : i18n._(NO_CHANGE_TITLE)}>-</span>
      )}
    </div>
  );
}

function CRRankCell({ change, loaded }: { change: number | null; loaded: boolean }) {
  const { i18n } = useLingui();
  if (!loaded) {
    return <div className="flex items-center justify-center"><Skeleton className="w-8 h-4" /></div>;
  }
  if (change === null || change === 0) {
    return (
      <div className="text-center text-[11px] text-osu-f1" title={change === null ? i18n._(NO_DELTA_TITLE) : i18n._(NO_CHANGE_TITLE)}>-</div>
    );
  }
  return (
    <div className={`text-center text-[11px] font-semibold ${change > 0 ? "text-osu-green" : "text-osu-red"}`}>
      {change > 0 ? `+${change}` : change}
    </div>
  );
}

function RankDeltaLabel({ label, change }: { label: string; change: number | null }) {
  const { i18n } = useLingui();
  if (change === null || change === 0) {
    return <span title={change === null ? i18n._(NO_DELTA_TITLE) : i18n._(NO_CHANGE_TITLE)}>{label} -</span>;
  }
  return (
    <span className={`font-semibold ${change > 0 ? "text-osu-green" : "text-osu-red"}`}>
      {label} {change > 0 ? `+${formatNumber(change)}` : formatNumber(change)}
    </span>
  );
}

function SortableHeader({ field, label, activeSort, sortDir, onSort, align, className }: {
  field: SortField;
  label: string;
  activeSort: SortField;
  sortDir: "asc" | "desc";
  onSort: (f: SortField) => void;
  align: "left" | "center" | "right";
  className?: string;
}) {
  const active = activeSort === field;
  return (
    <th
      className={`py-2.5 px-3 text-${align} cursor-pointer select-none transition-colors ${active ? "bg-osu-pink/15 text-osu-pink-light" : "hover:bg-osu-b3/30"} ${className ?? ""}`}
      onClick={() => onSort(field)}
    >
      {label}
      {active && <span className="ml-1 text-osu-pink text-[8px]">{sortDir === "desc" ? "\u25BC" : "\u25B2"}</span>}
    </th>
  );
}

function SortableGradeHeader({ field, activeSort, sortDir, onSort, img, alt }: {
  field: SortField;
  activeSort: SortField;
  sortDir: "asc" | "desc";
  onSort: (f: SortField) => void;
  img: string;
  alt: string;
}) {
  const active = activeSort === field;
  return (
    <th
      className={`py-2.5 px-3 text-center w-12 cursor-pointer select-none transition-colors ${active ? "bg-osu-pink/15" : "hover:bg-osu-b3/30"}`}
      onClick={() => onSort(field)}
    >
      <div className="flex items-center justify-center gap-1">
        <img src={img} alt={alt} width={22} height={22} className={`inline transition-opacity ${active ? "opacity-100" : "opacity-70"}`} />
        {active && <span className="text-osu-pink text-[8px]">{sortDir === "desc" ? "\u25BC" : "\u25B2"}</span>}
      </div>
    </th>
  );
}
