import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { motion } from "framer-motion";
import { getRankings, getUsersRankHistory } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { formatNumber, formatAccuracy } from "../lib/format";
import { getCrRankChanges, getGlobalRankChange } from "../lib/rankings";
import { Avatar } from "../components/ui/Avatar";
import { PageHeader } from "../components/layout/PageHeader";
import { RankingRowSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import { UsernameText } from "../components/ui/UsernameText";
import type { RankingsResponse } from "../lib/types";
import { useAppStore } from "../store";

type SortField = "rank" | "player" | "7d" | "cr7d" | "accuracy" | "playcount" | "pp" | "ss" | "s" | "a";

export const Route = createFileRoute("/rankings")({
  validateSearch: (search: Record<string, unknown>) => ({
    page: search.page === 2 || search.page === "2" ? 2 : 1,
  }),
  component: RankingsPage,
});

function RankingsPage() {
  const { page } = Route.useSearch();
  const navigate = useNavigate();
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const cachedPageOneData = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const rankHistories = useAppStore((state) => state.rankHistories);
  const rankHistoriesFetchedAt = useAppStore((state) => state.rankHistoriesFetchedAt);
  const setRankings = useAppStore((state) => state.setRankings);
  const setRankHistories = useAppStore((state) => state.setRankHistories);
  const [pageTwoData, setPageTwoData] = useState<RankingsResponse | null>(null);
  const [pageTwoFetchedAt, setPageTwoFetchedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortField>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const pageData = page === 1 ? cachedPageOneData : pageTwoData;
  const [rankingsLoading, setRankingsLoading] = useState(!(page === 1 ? cachedPageOneData : pageTwoData));
  const [rankHistoriesLoading, setRankHistoriesLoading] = useState(false);
  const countryName = getCountryName(selectedCountry);
  const totalPlayers = cachedPageOneData?.total ?? pageData?.total ?? 0;
  const hasNextPage = totalPlayers > 50;

  useEffect(() => {
    setPageTwoData(null);
    setPageTwoFetchedAt(null);
    setError(null);
  }, [selectedCountry]);

  useEffect(() => {
    if (page === 2 && totalPlayers > 0 && !hasNextPage) {
      navigate({ to: "/rankings", search: { page: 1 }, replace: true });
    }
  }, [hasNextPage, navigate, page, totalPlayers]);

  useEffect(() => {
    let cancelled = false;
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
        setError(`Couldn't load the ${countryName} rankings right now.`);
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
    const userIdsToFetch = userIds.filter(
      (userId) =>
        !rankHistories[userId] ||
        isCacheStale(rankHistoriesFetchedAt[userId], CLIENT_CACHE_TTL.rankHistories),
    );
    const hasAllHistories = userIdsToFetch.length === 0;
    const shouldRefresh = userIdsToFetch.length > 0;

    if (!shouldRefresh) {
      setRankHistoriesLoading(false);
      return () => { cancelled = true; };
    }

    setRankHistoriesLoading(!hasAllHistories);

    getUsersRankHistory({ data: { userIds: userIdsToFetch } })
      .then((histories) => {
        if (cancelled) return;
        setRankHistories(histories);
      })
      .finally(() => {
        if (cancelled) return;
        setRankHistoriesLoading(false);
      });

    return () => { cancelled = true; };
  }, [pageData, rankHistories, rankHistoriesFetchedAt, setRankHistories]);

  // Compare current country positions vs 7 days ago.
  const countryRankChanges = useMemo(() => {
    if (!pageData || Object.keys(rankHistories).length === 0) return {};
    return getCrRankChanges(pageData.ranking, rankHistories);
  }, [pageData, rankHistories]);

  const sortedRankings = useMemo(() => {
    if (!pageData) return [];
    const startRank = (page - 1) * 50;
    const entries = pageData.ranking.slice(0, 50).map((entry, i) => ({ entry, originalRank: startRank + i + 1 }));
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
          const aH = rankHistories[a.entry.user.id];
          const bH = rankHistories[b.entry.user.id];
          aVal = getGlobalRankChange(aH) ?? -99999;
          bVal = getGlobalRankChange(bH) ?? -99999;
          break;
        }
        case "cr7d":
          aVal = countryRankChanges[a.entry.user.id] ?? -99999;
          bVal = countryRankChanges[b.entry.user.id] ?? -99999;
          break;
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
  }, [pageData, page, sortBy, sortDir, rankHistories, countryRankChanges]);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      if (sortDir === "desc") setSortDir("asc");
      else { setSortBy("rank"); setSortDir("desc"); }
    } else {
      setSortBy(field);
      setSortDir("desc");
    }
  };

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title={`${countryName} mania rankings`}
        right={
          <>
            {!pageData && rankingsLoading && !error && <span className="text-[10px] text-osu-f1">Loading rankings...</span>}
            {pageData && rankHistoriesLoading && <span className="text-[10px] text-osu-f1">Loading 7d changes...</span>}
          </>
        }
      />

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5">
          {/* Mobile sort bar */}
          <div className="sm:hidden flex items-center gap-1.5 pb-3 overflow-x-auto scrollbar-hide">
            {([
              { field: "rank" as SortField, label: "#" },
              { field: "player" as SortField, label: "Player" },
              { field: "pp" as SortField, label: "PP" },
              { field: "accuracy" as SortField, label: "Acc" },
              { field: "7d" as SortField, label: "7d" },
              { field: "cr7d" as SortField, label: selectedCountry },
              { field: "playcount" as SortField, label: "Plays" },
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
          <div className="sm:hidden space-y-2">
            {error ? (
              <div className="px-4 py-8 text-center text-sm text-osu-f1">{error}</div>
            ) : pageData ? (
              sortedRankings.map(({ entry, originalRank }, i: number) => {
                const history = rankHistories[entry.user.id];
                const globalChange = getGlobalRankChange(history);
                const crChange = countryRankChanges[entry.user.id] ?? null;

                // Show the value for the active sort field on the right side
                const sortedValue = (() => {
                  switch (sortBy) {
                    case "playcount":
                      return <>{formatNumber(entry.play_count)} plays</>;
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
                        {sortBy === "7d" && history && (
                          <>
                            <MiniSparkline data={history} />
                            {globalChange !== null && globalChange !== 0 && (
                              <span className={`font-semibold ${globalChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
                                {globalChange > 0 ? `+${formatNumber(globalChange)}` : formatNumber(globalChange)}
                              </span>
                            )}
                          </>
                        )}
                        {sortBy === "cr7d" && (
                          crChange !== null && crChange !== 0 ? (
                            <span className={`font-semibold ${crChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
                              {selectedCountry} {crChange > 0 ? `+${crChange}` : crChange}
                            </span>
                          ) : (
                            <span>{selectedCountry} -</span>
                          )
                        )}
                      </div>
                    );
                  }
                  // Default: accuracy + sparkline
                  return (
                    <>
                      <span>{formatAccuracy(entry.hit_accuracy / 100)}</span>
                      {history && (
                        <div className="flex items-center gap-1">
                          <MiniSparkline data={history} />
                          {globalChange !== null && globalChange !== 0 && (
                            <span className={`font-semibold ${globalChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
                              {globalChange > 0 ? `+${formatNumber(globalChange)}` : formatNumber(globalChange)}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  );
                })();

                return (
                  <motion.div
                    key={entry.user.id}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.12, delay: i * 0.015 }}
                    className="rounded-lg bg-osu-b4/50 p-3 cursor-pointer hover:bg-osu-b4 transition-colors"
                    onClick={() => navigate({ to: "/player/$username", params: { username: entry.user.username } })}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-osu-f1 w-8">#{originalRank}</span>
                      <Avatar url={entry.user.avatar_url} size={36} />
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
                  </motion.div>
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

          {/* Desktop table */}
          <div className="hidden sm:block rounded-xl overflow-hidden border border-osu-b3/30">
            <table className="w-full">
              <thead>
                <tr className="bg-osu-b4 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
                  <th className="py-2.5 px-3 text-left w-12">#</th>
                  <SortableHeader field="player" label="Player" activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="left" />
                  <SortableHeader field="7d" label="7d Global" activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-32" />
                  <SortableHeader field="cr7d" label={`7d ${selectedCountry}`} activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="center" className="w-16" />
                  <SortableHeader field="accuracy" label="Accuracy" activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                  <SortableHeader field="playcount" label="Play Count" activeSort={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
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
                    const history = rankHistories[entry.user.id];
                    const globalChange = getGlobalRankChange(history);
                    const crChange = countryRankChanges[entry.user.id] ?? null;

                    return (
                      <motion.tr
                        key={entry.user.id}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.12, delay: i * 0.015 }}
                        className="border-t border-osu-b3/20 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
                        style={{ background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent" }}
                        onClick={() =>
                          navigate({ to: "/player/$username", params: { username: entry.user.username } })
                        }
                      >
                        <td className="py-2.5 px-3 text-sm font-bold text-osu-f1">#{originalRank}</td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-3">
                            <Avatar url={entry.user.avatar_url} size={30} />
                            <UsernameText
                              username={entry.user.username}
                              avatarUrl={entry.user.avatar_url}
                              className="text-sm font-medium"
                            />
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <GlobalRankCell history={history} rankChange={globalChange} />
                        </td>
                        <td className="py-2.5 px-3">
                          <CRRankCell change={crChange} loaded={!!history} />
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
                      </motion.tr>
                    );
                  })
                ) : (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-t border-osu-b3/20">
                      <td colSpan={10} className="px-3 py-1.5">
                        <div className="hidden sm:block">
                          <RankingRowSkeleton />
                        </div>
                        <div className="sm:hidden space-y-2 rounded-lg bg-osu-b4/50 p-3">
                          <div className="flex items-center gap-3">
                            <Skeleton className="w-8 h-4" />
                            <Skeleton className="w-8 h-8 rounded-full" />
                            <Skeleton className="h-4 flex-1" />
                          </div>
                          <div className="flex gap-2">
                            <Skeleton className="h-3 flex-1" />
                            <Skeleton className="h-3 w-14" />
                          </div>
                        </div>
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
                onClick={() => navigate({ to: "/rankings", search: { page: 1 } })}
                disabled={page === 1}
                className="px-4 py-2 rounded-lg bg-osu-b4 text-xs font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Page 1
              </button>
              <button
                onClick={() => navigate({ to: "/rankings", search: { page: 2 } })}
                disabled={page === 2}
                className="px-4 py-2 rounded-lg bg-osu-b4 text-xs font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Next Page
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniSparkline({ data }: { data: number[] }) {
  const slice = data.slice(-7);
  if (slice.length < 2) return null;

  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const range = max - min || 1;
  const w = 44;
  const h = 16;
  const pad = 1;

  const points = slice.map((v, i) => {
    const x = pad + (i / (slice.length - 1)) * (w - pad * 2);
    const y = pad + ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");

  const improved = slice[slice.length - 1] < slice[0];
  const same = slice[slice.length - 1] === slice[0];
  const color = same ? "hsl(333,10%,50%)" : improved ? "hsl(100,60%,50%)" : "hsl(0,70%,55%)";

  return (
    <svg width={w} height={h} className="inline-block align-middle flex-shrink-0">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlobalRankCell({ history, rankChange }: { history: number[] | undefined; rankChange: number | null }) {
  if (!history) {
    return <div className="flex items-center justify-center"><Skeleton className="w-20 h-4" /></div>;
  }
  return (
    <div className="flex items-center justify-center gap-2">
      <MiniSparkline data={history} />
      {rankChange !== null && rankChange !== 0 ? (
        <span className={`text-[11px] font-semibold ${rankChange > 0 ? "text-osu-green" : "text-osu-red"}`}>
          {rankChange > 0 ? `+${formatNumber(rankChange)}` : formatNumber(rankChange)}
        </span>
      ) : (
        <span className="text-[11px] text-osu-f1">-</span>
      )}
    </div>
  );
}

function CRRankCell({ change, loaded }: { change: number | null; loaded: boolean }) {
  if (!loaded) {
    return <div className="flex items-center justify-center"><Skeleton className="w-8 h-4" /></div>;
  }
  if (change === null || change === 0) {
    return <div className="text-center text-[11px] text-osu-f1">-</div>;
  }
  return (
    <div className={`text-center text-[11px] font-semibold ${change > 0 ? "text-osu-green" : "text-osu-red"}`}>
      {change > 0 ? `+${change}` : change}
    </div>
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
