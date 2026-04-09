import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { getHomePopoffs, getHomeRecentScores, getRankings } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { formatNumber, formatAccuracy, formatTimeAgo, formatPP } from "../lib/format";
import { getDisplayedAccuracy, getDisplayedRank, getScoreTimeMs, getScoreTimestamp, isDisplayedPassed } from "../lib/score";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { RankingRowSkeleton, ScoreRowSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import { ManiaRain } from "../components/home/ManiaRain";
import { UsernameText } from "../components/ui/UsernameText";
import type { RankingsResponse, OsuScore } from "../lib/types";
import { useAppStore, type CachedHomePopoff } from "../store";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function isPassedScore(score: OsuScore) {
  return isDisplayedPassed(score);
}

function getFeaturedPopoffSpanClass(index: number, total: number): string {
  if (total === 1) {
    return "md:col-span-2 xl:col-span-3";
  }

  if (total === 3 && index === 2) {
    return "md:col-span-2 xl:col-span-1";
  }

  return "";
}

function getFeaturedPopoffGridClass(total: number): string {
  if (total === 1) {
    return "grid grid-cols-1 gap-px bg-osu-b3/15";
  }

  if (total === 2) {
    return "grid grid-cols-1 md:grid-cols-2 gap-px bg-osu-b3/15";
  }

  return "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-osu-b3/15";
}

const EMPTY_SCORES: OsuScore[] = [];
const EMPTY_POPOFFS: CachedHomePopoff[] = [];
const HOME_RANKING_SKELETON_MOBILE_COUNT = 5;
const HOME_RANKING_SKELETON_DESKTOP_COUNT = 10;
const HOME_RECENT_SCORES_SKELETON_COUNT = 2;

function HomePage() {
  const navigate = useNavigate();
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const rankings = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const recentScores = useAppStore((state) => state.homeRecentScoresByCountry[selectedCountry]) ?? EMPTY_SCORES;
  const recentScoresFetchedAt = useAppStore((state) => state.homeRecentScoresFetchedAtByCountry[selectedCountry]) ?? null;
  const popoffs = useAppStore((state) => state.homePopoffsByCountry[selectedCountry]) ?? EMPTY_POPOFFS;
  const popoffsFetchedAt = useAppStore((state) => state.homePopoffsFetchedAtByCountry[selectedCountry]) ?? null;
  const setRankings = useAppStore((state) => state.setRankings);
  const setHomeRecentScores = useAppStore((state) => state.setHomeRecentScores);
  const setHomePopoffs = useAppStore((state) => state.setHomePopoffs);
  const [rankingsError, setRankingsError] = useState<string | null>(null);
  const [loadingScores, setLoadingScores] = useState(recentScores.length === 0);
  const [loadingPopoffs, setLoadingPopoffs] = useState(popoffs.length === 0);
  const countryName = getCountryName(selectedCountry);
  const homePreviewPlayers = rankings?.ranking.slice(0, 10).map((entry) => ({
    id: entry.user.id,
    username: entry.user.username,
    avatar_url: entry.user.avatar_url,
  })) ?? [];
  const homePreviewUserIds = homePreviewPlayers.map((player) => player.id);
  const homePreviewPlayerIdsKey = homePreviewUserIds.join(",");
  const homePreviewPlayersKey = homePreviewPlayers
    .map((player) => `${player.id}:${player.username}:${player.avatar_url}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;
    const shouldRefreshRankings = !rankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefreshRankings) {
      setRankingsError(null);
      return () => {
        cancelled = true;
      };
    }

    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((data) => {
        if (cancelled) return;
        setRankings(selectedCountry, data);
        setRankingsError(null);
      })
      .catch(() => {
        if (cancelled || rankings) return;
        setRankingsError(`Couldn't load the ${countryName} rankings right now.`);
        setLoadingScores(false);
        setLoadingPopoffs(false);
      });

    return () => {
      cancelled = true;
    };
  // Only depend on lengths and timestamps, never on array/object references.
  // The effect only needs to know *whether* data exists and *how stale* it is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rankings,
    rankingsFetchedAt,
    selectedCountry,
    countryName,
    setRankings,
  ]);

  useEffect(() => {
    let cancelled = false;
    const shouldRefreshScores =
      !recentScoresFetchedAt || isCacheStale(recentScoresFetchedAt, CLIENT_CACHE_TTL.homeRecentScores);

    if (!shouldRefreshScores) {
      setLoadingScores(false);
      return () => {
        cancelled = true;
      };
    }

    if (homePreviewUserIds.length === 0) {
      setLoadingScores(recentScores.length === 0 && !rankingsError);
      return () => {
        cancelled = true;
      };
    }

    setLoadingScores(recentScores.length === 0);

    getHomeRecentScores({ data: { userIds: homePreviewUserIds } })
      .then((data) => {
        if (cancelled) return;
        setHomeRecentScores(selectedCountry, data);
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingScores(false);
      });

    return () => {
      cancelled = true;
    };
  // Only depend on lengths and timestamps, never on array/object references.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    recentScores.length,
    recentScoresFetchedAt,
    homePreviewPlayerIdsKey,
    rankingsError,
    selectedCountry,
    setHomeRecentScores,
  ]);

  useEffect(() => {
    let cancelled = false;
    const shouldRefreshPopoffs =
      !popoffsFetchedAt || isCacheStale(popoffsFetchedAt, CLIENT_CACHE_TTL.homePopoffs);

    if (!shouldRefreshPopoffs) {
      setLoadingPopoffs(false);
      return () => {
        cancelled = true;
      };
    }

    if (homePreviewPlayers.length === 0) {
      setLoadingPopoffs(popoffs.length === 0 && !rankingsError);
      return () => {
        cancelled = true;
      };
    }

    setLoadingPopoffs(popoffs.length === 0);

    getHomePopoffs({ data: { players: homePreviewPlayers } })
      .then((data) => {
        if (cancelled) return;
        setHomePopoffs(selectedCountry, data);
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPopoffs(false);
      });

    return () => {
      cancelled = true;
    };
  // Only depend on lengths and timestamps, never on array/object references.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    popoffs.length,
    popoffsFetchedAt,
    homePreviewPlayersKey,
    rankingsError,
    selectedCountry,
    setHomePopoffs,
  ]);

  const topPlayersMobile = rankings?.ranking.slice(0, 5) ?? [];
  const topPlayersDesktop = rankings?.ranking.slice(0, 10) ?? [];
  const featuredPopoffs = popoffs.slice(0, 3);

  return (
    <div className="flex-1 relative overflow-hidden min-h-[calc(100vh-60px)]">
      <div className="absolute inset-0 pointer-events-none">
        <img
          src="/images/layout/nav2-background-hue0.png"
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-15"
          style={{ filter: "hue-rotate(333deg) saturate(0.6)", transform: "scale(2.5)", transformOrigin: "center" }}
        />
        <ManiaRain />
      </div>

      {/* Hero */}
      <section className="relative py-8 sm:py-14 px-4 sm:px-5">
        <div className="max-w-[1200px] mx-auto text-center">
          <div className="flex items-center justify-center gap-3">
            <span className="mode-icon text-osu-pink text-3xl sm:text-5xl">{"\ue802"}</span>
            <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight" style={{ fontFamily: "Torus" }}>mania <span className="text-osu-pink">{selectedCountry}</span></h1>
          </div>
        </div>
      </section>

      <div className="relative max-w-[1200px] mx-auto px-4 sm:px-5 pb-8 grid grid-cols-1 lg:grid-cols-[1fr_1fr_1fr] gap-4">
        {/* CR Top 5 */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:row-span-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Rankings</h2>
            <Link to="/rankings" className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
          </div>
          <div className="divide-y divide-osu-b3/15">
            {rankingsError ? (
              <div className="px-4 py-6 text-center text-xs text-osu-f1">{rankingsError}</div>
            ) : topPlayersMobile.length > 0 ? (
              <>
                <div className="lg:hidden">
                  {topPlayersMobile.map((entry: RankingsResponse["ranking"][number], i: number) => (
                    <motion.div key={entry.user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                      onClick={() => navigate({ to: "/player/$username", params: { username: entry.user.username } })}>
                      <span className="text-sm font-bold text-osu-f1 w-6 text-center">#{i + 1}</span>
                      <Avatar url={entry.user.avatar_url} size={30} />
                      <UsernameText
                        username={entry.user.username}
                        avatarUrl={entry.user.avatar_url}
                        className="text-sm font-medium flex-1 truncate"
                      />
                      <span className="text-xs font-bold text-right">{formatNumber(Math.round(entry.pp))}pp</span>
                    </motion.div>
                  ))}
                </div>
                <div className="hidden lg:block">
                  {topPlayersDesktop.map((entry: RankingsResponse["ranking"][number], i: number) => (
                    <motion.div key={entry.user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.035 }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                      onClick={() => navigate({ to: "/player/$username", params: { username: entry.user.username } })}>
                      <span className="text-sm font-bold text-osu-f1 w-6 text-center">#{i + 1}</span>
                      <Avatar url={entry.user.avatar_url} size={30} />
                      <UsernameText
                        username={entry.user.username}
                        avatarUrl={entry.user.avatar_url}
                        className="text-sm font-medium flex-1 truncate"
                      />
                      <span className="text-xs font-bold text-right">{formatNumber(Math.round(entry.pp))}pp</span>
                    </motion.div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="lg:hidden">
                  {Array.from({ length: HOME_RANKING_SKELETON_MOBILE_COUNT }).map((_, i) => (
                    <RankingRowSkeleton key={i} />
                  ))}
                </div>
                <div className="hidden lg:block">
                  {Array.from({ length: HOME_RANKING_SKELETON_DESKTOP_COUNT }).map((_, i) => (
                    <RankingRowSkeleton key={i} />
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        {/* Recent Top Plays - featured */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Recent Top Plays</h2>
            <Link to="/top-plays" className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
          </div>
          {loadingPopoffs ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-osu-b3/15">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className={`bg-osu-b4 min-h-[180px] p-5 flex flex-col items-center justify-center space-y-3 ${getFeaturedPopoffSpanClass(i, 3)}`}
                >
                  <Skeleton className="h-8 w-20 mx-auto" />
                  <Skeleton className="h-8 w-24 mx-auto" />
                  <Skeleton className="h-3 w-32 mx-auto" />
                  <Skeleton className="h-2.5 w-40 mx-auto" />
                </div>
              ))}
            </div>
          ) : featuredPopoffs.length > 0 ? (
            <div className={getFeaturedPopoffGridClass(featuredPopoffs.length)}>
              {featuredPopoffs.map((p, i) => (
                <motion.div
                  key={p.score.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06 }}
                  className={`bg-osu-b4 min-h-[180px] p-5 hover:bg-osu-b3/50 transition-colors cursor-pointer text-center flex flex-col items-center justify-center ${getFeaturedPopoffSpanClass(i, featuredPopoffs.length)}`}
                  onClick={() => navigate({ to: "/player/$username", params: { username: p.user.username } })}>
                  <div className="text-3xl font-bold text-osu-pink leading-none" style={{ fontFamily: "Torus" }}>
                    {Math.round(p.score.pp ?? 0)}pp
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-2 max-w-full">
                    <GradeImg grade={getDisplayedRank(p.score)} size={18} />
                    <Avatar url={p.user.avatar_url} size={24} />
                    <UsernameText
                      username={p.user.username}
                      avatarUrl={p.user.avatar_url}
                      className="text-xs font-medium max-w-[14ch] truncate"
                    />
                  </div>
                  <div className="mt-3 w-full max-w-[26ch] space-y-1">
                    <div className="text-[11px] text-osu-f1 leading-relaxed line-clamp-2">
                      {p.score.beatmapset?.title}
                    </div>
                    <div className="text-[10px] text-osu-f1/80 leading-relaxed line-clamp-2">
                      [{p.score.beatmap?.version}]
                    </div>
                  </div>
                  <div className="mt-3 text-[10px] text-osu-f1/60">{formatTimeAgo(getScoreTimestamp(p.score))}</div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-center text-xs text-osu-f1">No recent top plays</div>
          )}
        </section>

        {/* Recent Scores */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Recent Scores</h2>
            <Link to="/tracker" className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
          </div>
          <div className="divide-y divide-osu-b3/15">
            {loadingScores ? (
              Array.from({ length: HOME_RECENT_SCORES_SKELETON_COUNT }).map((_, i) => (
                <div key={i} className="px-4 py-2">
                  <ScoreRowSkeleton />
                </div>
              ))
            ) : recentScores.length > 0 ? (
              recentScores.map((s: OsuScore, i: number) => (
                <motion.div key={s.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                  onClick={() => navigate({ to: "/player/$username", params: { username: s.user?.username } })}>
                    <GradeImg grade={getDisplayedRank(s)} size={22} />
                  <Avatar url={s.user?.avatar_url} size={26} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate">
                      <UsernameText
                        username={s.user?.username ?? "Unknown"}
                        avatarUrl={s.user?.avatar_url}
                        className="font-medium"
                      />{" "}
                      <span className="text-osu-f1">on</span> {s.beatmapset?.title}
                    </div>
                    <div className="text-[10px] text-osu-f1">
                      [{s.beatmap?.version}] {s.beatmap?.cs && `${s.beatmap.cs}K`} &middot; {formatTimeAgo(getScoreTimestamp(s))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-osu-l2">{formatAccuracy(getDisplayedAccuracy(s))}</span>
                    <span className="text-xs font-bold">{formatPP(s.pp)}</span>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="px-4 py-6 text-center text-xs text-osu-f1">No recent scores</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
