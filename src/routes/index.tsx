import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { getRankings, getCountryRecentScores, getUserScoresBestWindow } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { formatNumber, formatAccuracy, formatTimeAgo, formatPP } from "../lib/format";
import { getDisplayedAccuracy, getDisplayedRank, getScoreTimeMs, getScoreTimestamp, isDisplayedPassed } from "../lib/score";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { PlayerCardSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import { ManiaRain } from "../components/home/ManiaRain";
import { UsernameText } from "../components/ui/UsernameText";
import type { RankingsResponse, OsuScore } from "../lib/types";
import { useAppStore } from "../store";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function isPassedScore(score: OsuScore) {
  return isDisplayedPassed(score);
}

function HomePage() {
  const navigate = useNavigate();
  const rankings = useAppStore((state) => state.crRankings);
  const rankingsFetchedAt = useAppStore((state) => state.crRankingsFetchedAt);
  const recentScores = useAppStore((state) => state.homeRecentScores);
  const recentScoresFetchedAt = useAppStore((state) => state.homeRecentScoresFetchedAt);
  const popoffs = useAppStore((state) => state.homePopoffs);
  const popoffsFetchedAt = useAppStore((state) => state.homePopoffsFetchedAt);
  const setCrRankings = useAppStore((state) => state.setCrRankings);
  const setHomeRecentScores = useAppStore((state) => state.setHomeRecentScores);
  const setHomePopoffs = useAppStore((state) => state.setHomePopoffs);
  const [rankingsError, setRankingsError] = useState<string | null>(null);
  const [loadingScores, setLoadingScores] = useState(recentScores.length === 0);
  const [loadingPopoffs, setLoadingPopoffs] = useState(popoffs.length === 0);

  useEffect(() => {
    let cancelled = false;
    const shouldRefresh = !rankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefresh) {
      setRankingsError(null);
      return () => {
        cancelled = true;
      };
    }

    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((data) => {
        if (cancelled) return;
        setCrRankings(data);
        setRankingsError(null);
      })
      .catch(() => {
        if (cancelled || rankings) return;
        setRankingsError("Couldn't load the Costa Rica rankings right now.");
      });

    return () => {
      cancelled = true;
    };
  }, [rankings, rankingsFetchedAt, setCrRankings]);

  useEffect(() => {
    if (!rankings) return;

    let cancelled = false;
    const userIds = rankings.ranking.map((entry: RankingsResponse["ranking"][number]) => entry.user.id);
    const shouldRefreshScores =
      recentScores.length === 0 || isCacheStale(recentScoresFetchedAt, CLIENT_CACHE_TTL.homeRecentScores);

    if (!shouldRefreshScores) {
      setLoadingScores(false);
    } else {
      setLoadingScores(recentScores.length === 0);

      getCountryRecentScores({ data: { userIds, batchSize: 10, batchIndex: 0 } })
        .then((scores) => {
          if (cancelled) return;
          const seenUsers = new Set<number>();
          const previewScores = scores
            .filter(isPassedScore)
            .sort((a, b) => getScoreTimeMs(b) - getScoreTimeMs(a))
            .filter((score) => {
              if (seenUsers.has(score.user_id)) return false;
              seenUsers.add(score.user_id);
              return true;
            })
            .slice(0, 5);

          setHomeRecentScores(previewScores);
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingScores(false);
        });
    }

    const topPlayersForPopoffs = rankings.ranking.slice(0, 30);
    const shouldRefreshPopoffs =
      popoffs.length === 0 || isCacheStale(popoffsFetchedAt, CLIENT_CACHE_TTL.homePopoffs);

    if (!shouldRefreshPopoffs) {
      setLoadingPopoffs(false);
    } else {
      setLoadingPopoffs(popoffs.length === 0);

      Promise.allSettled(
        topPlayersForPopoffs.map(async (entry: RankingsResponse["ranking"][number]) => {
          const scores = await getUserScoresBestWindow({ data: { userId: entry.user.id, totalLimit: 100 } });
          return scores
            .filter((s: OsuScore) => {
              const age = Date.now() - getScoreTimeMs(s);
              return age < 7 * 24 * 60 * 60 * 1000 && s.pp && s.pp > 0;
            })
            .map((s: OsuScore) => ({
              user: { username: entry.user.username, avatar_url: entry.user.avatar_url },
              score: s,
            }));
        }),
      )
        .then((results) => {
          if (cancelled) return;

          const all = results
            .filter((r): r is PromiseFulfilledResult<{ user: { username: string; avatar_url: string }; score: OsuScore }[]> => r.status === "fulfilled")
            .flatMap((r) => r.value)
            .sort((a, b) => {
              const ppDiff = (b.score.pp ?? 0) - (a.score.pp ?? 0);
              if (ppDiff !== 0) return ppDiff;
              return getScoreTimeMs(b.score) - getScoreTimeMs(a.score);
            })
            .slice(0, 5);

          setHomePopoffs(all);
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingPopoffs(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    rankings,
    popoffs.length,
    popoffsFetchedAt,
    recentScores.length,
    recentScoresFetchedAt,
    setHomePopoffs,
    setHomeRecentScores,
  ]);

  const topPlayersMobile = rankings?.ranking.slice(0, 5) ?? [];
  const topPlayersDesktop = rankings?.ranking.slice(0, 9) ?? [];

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
      <section className="relative py-14 px-5">
        <div className="max-w-[1200px] mx-auto text-center">
          <div className="flex items-center justify-center gap-3">
            <span className="mode-icon text-osu-pink text-5xl">{"\ue802"}</span>
            <h1 className="text-5xl font-black text-white tracking-tight" style={{ fontFamily: "Torus" }}>mania <span className="text-osu-pink">CR</span></h1>
          </div>
        </div>
      </section>

      <div className="relative max-w-[1200px] mx-auto px-5 pb-8 grid grid-cols-1 lg:grid-cols-[1fr_1fr_1fr] gap-4">
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
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-3 py-1">
                  <PlayerCardSkeleton />
                </div>
              ))
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-osu-b3/15">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-osu-b4 p-4 space-y-3">
                  <Skeleton className="h-8 w-16 mx-auto" />
                  <Skeleton className="h-8 w-8 rounded-full mx-auto" />
                  <Skeleton className="h-3 w-24 mx-auto" />
                  <Skeleton className="h-2.5 w-32 mx-auto" />
                </div>
              ))}
            </div>
          ) : popoffs.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-osu-b3/15">
              {popoffs.slice(0, 3).map((p, i) => (
                <motion.div key={p.score.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
                  className="bg-osu-b4 p-4 hover:bg-osu-b3/50 transition-colors cursor-pointer text-center"
                  onClick={() => navigate({ to: "/player/$username", params: { username: p.user.username } })}>
                  <div className="text-2xl font-bold text-osu-pink mb-1" style={{ fontFamily: "Torus" }}>{Math.round(p.score.pp ?? 0)}pp</div>
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <GradeImg grade={getDisplayedRank(p.score)} size={18} />
                    <Avatar url={p.user.avatar_url} size={24} />
                    <UsernameText
                      username={p.user.username}
                      avatarUrl={p.user.avatar_url}
                      className="text-xs font-medium"
                    />
                  </div>
                  <div className="text-[10px] text-osu-f1 truncate">{p.score.beatmapset?.title}</div>
                  <div className="text-[10px] text-osu-f1 truncate">[{p.score.beatmap?.version}]</div>
                  <div className="text-[9px] text-osu-f1/60 mt-1">{formatTimeAgo(getScoreTimestamp(p.score))}</div>
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
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <Skeleton className="w-6 h-6 rounded" />
                  <Skeleton className="w-7 h-7 rounded-full" />
                  <div className="flex-1 space-y-1"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-2.5 w-48" /></div>
                  <Skeleton className="h-3.5 w-12" />
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
