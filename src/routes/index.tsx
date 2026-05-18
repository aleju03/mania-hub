import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { getHomePopoffs, getHomeRecentScores, getRankings } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { parseCountrySearchParam, withSearchParams } from "../lib/country-search";
import { formatNumber, formatAccuracy, formatTimeAgo, formatPP } from "../lib/format";
import { getModDisplayList, getScoreDisplayValues, getScoreTimestamp } from "../lib/score";
import { fetchLiveTopPlaysSnapshot, fetchLiveTrackerSnapshot, isLiveBackendConfigured } from "../lib/live-backend";
import { CountryWarming } from "../components/CountryWarming";
import { LiveDataEmptyState } from "../components/LiveDataEmptyState";
import { useCountryWarming } from "../lib/use-country-warming";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { RankingRowSkeleton, ScoreRowSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import { ManiaRain } from "../components/home/ManiaRain";
import { UsernameText } from "../components/ui/UsernameText";
import type { RankingsResponse, LeanHomeScore, LeanHomePopoff, LeanTrackerScore, CountryTopPlay } from "../lib/types";
import { useAppStore, useHasHydrated, useSelectedCountry } from "../store";
import { DEFAULT_DESCRIPTION, pageSeo, SITE_NAME } from "../lib/seo";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    country: parseCountrySearchParam(search.country),
  }),
  head: ({ match }) => {
    const country = match.search.country;
    const countryName = country ? getCountryName(country) : null;
    return pageSeo({
      title: SITE_NAME,
      description: countryName
        ? `Top osu!mania players and scores in ${countryName}`
        : DEFAULT_DESCRIPTION,
      path: withSearchParams("/", { country }),
      origin: match.context.origin,
      imageCountry: country,
      imageKind: country ? "home" : undefined,
      social: true,
    });
  },
  component: HomePage,
});

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

const EMPTY_SCORES: LeanHomeScore[] = [];
const EMPTY_TRACKER_SCORES: LeanTrackerScore[] = [];
const EMPTY_POPOFFS: LeanHomePopoff[] = [];
const HOME_RANKING_SKELETON_MOBILE_COUNT = 5;
const HOME_RANKING_SKELETON_DESKTOP_COUNT = 10;
const HOME_RECENT_SCORES_SKELETON_COUNT = 2;
const HOME_RECENT_SCORES_PLAYER_COUNT = 50;
const HOME_POPOFFS_PLAYER_COUNT = 10;

function getHomeScoreTimeMs(score: LeanHomeScore): number {
  return new Date(score.timestamp).getTime() || 0;
}

function trackerScoreToHomeScore(score: LeanTrackerScore): LeanHomeScore {
  const display = getScoreDisplayValues(score);
  return {
    id: score.id,
    pp: score.pp,
    displayAcc: display.accuracy,
    displayRank: display.rank,
    isLazer: display.isLazer,
    mods: getModDisplayList(score.mods),
    timestamp: getScoreTimestamp(score),
    title: score.beatmapset.title,
    version: score.beatmap.version,
    keyCount: Number(score.beatmap.cs) || 0,
    beatmapsetId: score.beatmapset.id,
    user: {
      id: score.user.id,
      username: score.user.username,
      avatar_url: score.user.avatar_url,
    },
  };
}

function countryTopPlayToHomePopoff(play: CountryTopPlay): LeanHomePopoff | null {
  const score = play.score;
  if (!score?.beatmap || !score.beatmapset) return null;
  const display = getScoreDisplayValues(score);
  return {
    user: {
      username: play.user.username,
      avatar_url: play.user.avatar_url,
    },
    score: {
      id: score.id,
      pp: score.pp ?? play.pp ?? null,
      displayAcc: display.accuracy,
      displayRank: display.rank,
      isLazer: display.isLazer,
      mods: getModDisplayList(score.mods),
      timestamp: getScoreTimestamp(score) || play.time,
      title: score.beatmapset.title,
      version: score.beatmap.version,
      keyCount: Number(score.beatmap.cs) || 0,
      beatmapsetId: score.beatmapset.id,
      user: {
        id: play.user.id,
        username: play.user.username,
        avatar_url: play.user.avatar_url,
      },
    },
  };
}

function mergeHomeRecentScores(
  homeScores: LeanHomeScore[],
  trackerScores: LeanTrackerScore[],
  limit = 5,
): LeanHomeScore[] {
  const trackerHomeScores = trackerScores
    .filter((score) => getScoreDisplayValues(score).passed)
    .map((score) => trackerScoreToHomeScore(score));
  const seenUsers = new Set<number>();

  return [...trackerHomeScores, ...homeScores]
    .sort((a, b) => getHomeScoreTimeMs(b) - getHomeScoreTimeMs(a))
    .filter((score) => {
      if (seenUsers.has(score.user.id)) return false;
      seenUsers.add(score.user.id);
      return true;
    })
    .slice(0, limit);
}

function getHomePopoffChartKey(popoff: LeanHomePopoff): string {
  const score = popoff.score;
  const modsKey = score.mods
    .map((mod) => `${mod.acronym}:${mod.rate ?? ""}`)
    .join(",");
  return [
    score.user.id,
    score.beatmapsetId ?? score.title,
    score.version,
    score.keyCount,
    modsKey,
  ].join("|");
}

function dedupeHomePopoffs(popoffs: LeanHomePopoff[]): LeanHomePopoff[] {
  const seenCharts = new Set<string>();
  return popoffs.filter((popoff) => {
    const key = getHomePopoffChartKey(popoff);
    if (seenCharts.has(key)) return false;
    seenCharts.add(key);
    return true;
  });
}

function getHomePopoffUserKey(popoff: LeanHomePopoff): string {
  return String(popoff.score.user.id || popoff.user.username);
}

function selectFeaturedHomePopoffs(popoffs: LeanHomePopoff[], limit = 3): LeanHomePopoff[] {
  const chartDeduped = dedupeHomePopoffs(popoffs);
  const selected: LeanHomePopoff[] = [];
  const selectedKeys = new Set<string>();
  const seenUsers = new Set<string>();

  for (const popoff of chartDeduped) {
    const userKey = getHomePopoffUserKey(popoff);
    if (seenUsers.has(userKey)) continue;
    selected.push(popoff);
    selectedKeys.add(String(popoff.score.id));
    seenUsers.add(userKey);
    if (selected.length >= limit) return selected;
  }

  for (const popoff of chartDeduped) {
    const scoreKey = String(popoff.score.id);
    if (selectedKeys.has(scoreKey)) continue;
    selected.push(popoff);
    if (selected.length >= limit) return selected;
  }

  return selected;
}

function HomePage() {
  const navigate = useNavigate();
  const { country } = Route.useSearch();
  const fallbackCountry = useSelectedCountry();
  const selectedCountry = country ?? fallbackCountry;
  const rankings = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const recentScores = useAppStore((state) => state.homeRecentScoresByCountry[selectedCountry]) ?? EMPTY_SCORES;
  const recentScoresFetchedAt = useAppStore((state) => state.homeRecentScoresFetchedAtByCountry[selectedCountry]) ?? null;
  const trackerFeedScores = useAppStore((state) => state.feedScoresByCountry[selectedCountry]) ?? EMPTY_TRACKER_SCORES;
  const popoffs = useAppStore((state) => state.homePopoffsByCountry[selectedCountry]) ?? EMPTY_POPOFFS;
  const popoffsFetchedAt = useAppStore((state) => state.homePopoffsFetchedAtByCountry[selectedCountry]) ?? null;
  const topPlaysRange = useAppStore((state) => state.topPlaysRangeByCountry[selectedCountry] ?? "7d");
  const liveBackendEnabled = isLiveBackendConfigured();
  const { warming } = useCountryWarming(selectedCountry);
  const hydrated = useHasHydrated();
  const setRankings = useAppStore((state) => state.setRankings);
  const setHomeRecentScores = useAppStore((state) => state.setHomeRecentScores);
  const setHomePopoffs = useAppStore((state) => state.setHomePopoffs);
  const addFeedScores = useAppStore((state) => state.addFeedScores);
  const markFeedScoresFetched = useAppStore((state) => state.markFeedScoresFetched);
  const [rankingsError, setRankingsError] = useState<string | null>(null);
  const [loadingScores, setLoadingScores] = useState(recentScores.length === 0);
  const [loadingPopoffs, setLoadingPopoffs] = useState(popoffs.length === 0);
  const countryName = getCountryName(selectedCountry);
  const homeActivePlayers = rankings?.ranking
    .filter((entry) => entry.user.is_active !== false)
    .map((entry) => ({
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
    })) ?? [];
  const homeRecentPlayers = homeActivePlayers.slice(0, HOME_RECENT_SCORES_PLAYER_COUNT);
  const homePopoffPlayers = homeActivePlayers.slice(0, HOME_POPOFFS_PLAYER_COUNT);
  const homeRecentUserIds = homeRecentPlayers.map((player) => player.id);
  const homeRecentPlayerIdsKey = homeRecentUserIds.join(",");
  const homePopoffPlayersKey = homePopoffPlayers
    .map((player) => `${player.id}:${player.username}:${player.avatar_url}`)
    .join("|");
  const homeRecentEffectPlayerIdsKey = liveBackendEnabled ? "" : homeRecentPlayerIdsKey;
  const homePopoffsEffectPlayersKey = liveBackendEnabled ? "" : homePopoffPlayersKey;
  const homeEffectsRankingsError = liveBackendEnabled ? null : rankingsError;

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

    if (liveBackendEnabled) {
      setLoadingScores(recentScores.length === 0);
      fetchLiveTrackerSnapshot(selectedCountry, 100)
        .then((snapshot) => {
          if (cancelled) return;
          const passedScores = snapshot.scores.filter((score) => getScoreDisplayValues(score).passed);
          setHomeRecentScores(selectedCountry, passedScores.map(trackerScoreToHomeScore));
          if (passedScores.length > 0) addFeedScores(selectedCountry, passedScores);
          else markFeedScoresFetched(selectedCountry);
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
    }

    if (homeRecentUserIds.length === 0) {
      setLoadingScores(recentScores.length === 0 && !rankingsError);
      return () => {
        cancelled = true;
      };
    }

    setLoadingScores(recentScores.length === 0);

    getHomeRecentScores({ data: { userIds: homeRecentUserIds } })
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
    homeRecentEffectPlayerIdsKey,
    homeEffectsRankingsError,
    selectedCountry,
    setHomeRecentScores,
    addFeedScores,
    markFeedScoresFetched,
    liveBackendEnabled,
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

    if (liveBackendEnabled) {
      setLoadingPopoffs(popoffs.length === 0);
      fetchLiveTopPlaysSnapshot(selectedCountry, "7d")
        .then((snapshot) => {
          if (cancelled) return;
          setHomePopoffs(
            selectedCountry,
            dedupeHomePopoffs(
              snapshot.popoffs
                .map(countryTopPlayToHomePopoff)
                .filter((play): play is LeanHomePopoff => play !== null),
            ),
          );
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
    }

    if (homePopoffPlayers.length === 0) {
      setLoadingPopoffs(popoffs.length === 0 && !rankingsError);
      return () => {
        cancelled = true;
      };
    }

    setLoadingPopoffs(popoffs.length === 0);

    getHomePopoffs({ data: { players: homePopoffPlayers } })
      .then((data) => {
        if (cancelled) return;
        setHomePopoffs(selectedCountry, dedupeHomePopoffs(data));
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
    homePopoffsEffectPlayersKey,
    homeEffectsRankingsError,
    selectedCountry,
    setHomePopoffs,
    liveBackendEnabled,
  ]);

  const topPlayersMobile = rankings?.ranking.slice(0, 5) ?? [];
  const topPlayersDesktop = rankings?.ranking.slice(0, 10) ?? [];
  const featuredPopoffs = useMemo(() => selectFeaturedHomePopoffs(popoffs), [popoffs]);
  const displayedRecentScores = useMemo(
    () => mergeHomeRecentScores(recentScores, trackerFeedScores),
    [recentScores, trackerFeedScores],
  );

  return (
    <div className="flex-1 relative overflow-hidden min-h-[calc(100vh-60px)]">
      <div className="absolute inset-0 pointer-events-none">
        <img
          src="/images/layout/nav2-background-hue0.webp"
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-15"
          style={{ filter: "hue-rotate(calc(var(--theme-hue) * 1deg)) saturate(calc(0.6 * var(--theme-sat)))", transform: "scale(2.5)", transformOrigin: "center" }}
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

      {warming && <CountryWarming country={selectedCountry} />}

      {!warming && (
      <div className="relative max-w-[1200px] mx-auto px-4 sm:px-5 pb-8 grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
        {/* CR Top 5 */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Rankings</h2>
            <Link to="/rankings" search={{ page: 1, country: selectedCountry }} className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
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

        <div className="flex flex-col gap-4">
        {/* Recent Top Plays - featured */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Recent Top Plays</h2>
            <Link
              to="/top-plays"
              search={{ range: hydrated ? topPlaysRange : "7d", country: selectedCountry }}
              className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors"
            >
              view all
            </Link>
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
                  className={`group bg-osu-b4 min-h-[180px] p-5 cursor-pointer text-center flex flex-col items-center justify-center relative isolate overflow-hidden ${getFeaturedPopoffSpanClass(i, featuredPopoffs.length)}`}
                  onClick={() => navigate({ to: "/player/$username", params: { username: p.user.username } })}>
                  {p.score.beatmapsetId && (
                    <>
                      <img
                        src={`https://assets.ppy.sh/beatmaps/${p.score.beatmapsetId}/covers/cover.jpg`}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover opacity-[0.12] group-hover:opacity-[0.25] transition-opacity duration-200 -z-20 pointer-events-none"
                      />
                      <div
                        className="absolute inset-0 -z-20 pointer-events-none"
                        style={{ background: "radial-gradient(ellipse at center, var(--color-osu-b4) 0%, transparent 75%)" }}
                      />
                    </>
                  )}
                  <div className="text-3xl font-bold text-osu-pink leading-none" style={{ fontFamily: "Torus" }}>
                    {Math.round(p.score.pp ?? 0)}pp
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-2 max-w-full">
                    <GradeImg grade={p.score.displayRank} size={18} />
                    <Avatar url={p.user.avatar_url} size={24} />
                    <UsernameText
                      username={p.user.username}
                      avatarUrl={p.user.avatar_url}
                      className="text-xs font-medium max-w-[14ch] truncate"
                    />
                  </div>
                  <div className="mt-3 w-full max-w-[26ch] space-y-1">
                    <div className="text-[11px] text-osu-f1 leading-relaxed line-clamp-2">
                      {p.score.title}
                    </div>
                    <div className="text-[10px] text-osu-f1/80 leading-relaxed line-clamp-2">
                      [{p.score.version}]
                    </div>
                  </div>
                  {p.score.mods.length > 0 && (
                    <div className="mt-3 flex items-center justify-center gap-1 flex-wrap max-w-[26ch]">
                      {p.score.mods.map((m) => (
                        <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.8} />
                      ))}
                    </div>
                  )}
                  <div className="mt-3 text-[10px] text-osu-f1/60">{formatTimeAgo(p.score.timestamp)}</div>
                </motion.div>
              ))}
            </div>
          ) : (
            liveBackendEnabled && rankings ? (
              <LiveDataEmptyState country={selectedCountry} kind="top-plays" compact />
            ) : (
              <div className="px-4 py-6 text-center text-xs text-osu-f1">No recent top plays</div>
            )
          )}
        </section>

        {/* Recent Scores */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:flex-1">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Recent Scores</h2>
            <Link to="/tracker" search={{ country: selectedCountry, page: undefined }} className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
          </div>
          <div className="divide-y divide-osu-b3/15">
            {loadingScores && displayedRecentScores.length === 0 ? (
              Array.from({ length: HOME_RECENT_SCORES_SKELETON_COUNT }).map((_, i) => (
                <div key={i} className="px-4 py-2">
                  <ScoreRowSkeleton />
                </div>
              ))
            ) : displayedRecentScores.length > 0 ? (
              displayedRecentScores.map((s: LeanHomeScore, i: number) => (
                <motion.div key={s.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                  onClick={() => navigate({ to: "/player/$username", params: { username: s.user.username } })}>
                    <GradeImg grade={s.displayRank} size={22} />
                  <Avatar url={s.user.avatar_url} size={26} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate">
                      <UsernameText
                        username={s.user.username}
                        avatarUrl={s.user.avatar_url}
                        className="font-medium"
                      />{" "}
                      <span className="text-osu-f1">on</span> {s.title}
                    </div>
                    <div className="mt-0.5 text-[10px] text-osu-f1 min-w-0 truncate">
                        [{s.version}] {s.keyCount > 0 && `${s.keyCount}K`} &middot; {formatTimeAgo(s.timestamp)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {s.mods.length > 0 && (
                      <div className="flex items-center gap-0.5">
                        {s.mods.map((m) => (
                          <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.8} />
                        ))}
                      </div>
                    )}
                    <span className={`text-xs ${s.isLazer ? "text-osu-pink-light" : "text-osu-l2"}`}>{formatAccuracy(s.displayAcc)}</span>
                    <span className="text-xs font-bold">{formatPP(s.pp)}</span>
                  </div>
                </motion.div>
              ))
            ) : (
              liveBackendEnabled && rankings ? (
                <LiveDataEmptyState country={selectedCountry} kind="scores" compact />
              ) : (
                <div className="px-4 py-6 text-center text-xs text-osu-f1">No recent scores</div>
              )
            )}
          </div>
        </section>
        </div>
      </div>
      )}
    </div>
  );
}
