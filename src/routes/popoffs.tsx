import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getRankings, getUserApproxPpGains, getUserScoresBest } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { formatNumber, formatAccuracy, formatTimeAgo } from "../lib/format";
import { getScoreTimeMs, getScoreTimestamp, scoreHasReplay } from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";
import { PageTabs } from "../components/layout/PageTabs";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import type { OsuScore, RankingsResponse } from "../lib/types";
import { useAppStore } from "../store";

interface PopOff {
  user: { id: number; username: string; avatar_url: string };
  score: OsuScore;
  pp: number;
  weightedPP: number;
  time: string;
}

type TimeRange = "24h" | "3d" | "7d" | "30d";
const RANGE_MS: Record<TimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const PAGE_SIZE = 15;

export const Route = createFileRoute("/popoffs")({
  component: PopOffsPage,
});

function PopOffsPage() {
  const navigate = useNavigate();
  const rankings = useAppStore((state) => state.crRankings);
  const rankingsFetchedAt = useAppStore((state) => state.crRankingsFetchedAt);
  const popoffs = useAppStore((state) => state.popoffs);
  const popoffsFetchedAt = useAppStore((state) => state.popoffsFetchedAt);
  const setCrRankings = useAppStore((state) => state.setCrRankings);
  const setCachedPopoffs = useAppStore((state) => state.setPopoffs);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [loadingPlayers, setLoadingPlayers] = useState(!rankings);
  const [loading, setLoading] = useState(popoffs.length === 0);
  const [progressivePopoffs, setProgressivePopoffs] = useState<PopOff[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [range, setRange] = useState<TimeRange>("7d");
  const [page, setPage] = useState(0);
  const [ppGainByScoreId, setPpGainByScoreId] = useState<Record<number, number>>({});
  const [ppGainFetchedByUserId, setPpGainFetchedByUserId] = useState<Record<number, true>>({});

  const players = rankings?.ranking.slice(0, 30).map((entry: RankingsResponse["ranking"][number]) => ({
    id: entry.user.id,
    username: entry.user.username,
    avatar_url: entry.user.avatar_url,
  })) ?? [];

  useEffect(() => {
    let cancelled = false;
    const shouldRefresh = !rankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefresh) {
      setLoadingPlayers(false);
      setPlayersError(null);
      return () => {
        cancelled = true;
      };
    }

    setLoadingPlayers(!rankings);

    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((rankings) => {
        if (cancelled) return;
        setCrRankings(rankings);
        setPlayersError(null);
      })
      .catch(() => {
        if (cancelled || rankings) return;
        setPlayersError("Couldn't load the player list for pop-offs.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPlayers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rankings, rankingsFetchedAt, setCrRankings]);

  // Progressively fetch scores for each player
  const fetchAll = useCallback(async () => {
    if (players.length === 0) {
      setLoading(false);
      return;
    }

    const hasCachedPopoffs = popoffs.length > 0;
    const shouldRefresh = !hasCachedPopoffs || isCacheStale(popoffsFetchedAt, CLIENT_CACHE_TTL.popoffs);

    if (!shouldRefresh) {
      setLoadedCount(players.length);
      setLoading(false);
      return;
    }

    setLoading(!hasCachedPopoffs);
    setLoadedCount(0);
    setPage(0);

    const all: PopOff[] = [];

    for (let i = 0; i < players.length; i += 5) {
      const batch = players.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (player: { id: number; username: string; avatar_url: string }) => {
          const scores = await getUserScoresBest({ data: { userId: player.id, limit: 15 } });
          return scores
            .filter((s: OsuScore) => {
              const age = Date.now() - getScoreTimeMs(s);
              return age < RANGE_MS["30d"] && s.pp && s.pp > 0;
            })
            .map((s: OsuScore) => ({
              user: player,
              score: s,
              pp: s.pp ?? 0,
              weightedPP: s.weight?.pp ?? 0,
              time: getScoreTimestamp(s),
            }));
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") all.push(...r.value);
      }

      // Sort and update progressively
      all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      if (!hasCachedPopoffs) {
        setProgressivePopoffs([...all]);
      }
      setLoadedCount(Math.min(i + 5, players.length));
    }

    if (!hasCachedPopoffs) {
      setProgressivePopoffs([]);
    }
    setCachedPopoffs([...all]);
    setLoading(false);
  }, [players, popoffs.length, popoffsFetchedAt, setCachedPopoffs]);

  useEffect(() => {
    if (loadingPlayers || playersError) return;
    fetchAll();
  }, [fetchAll, loadingPlayers, playersError]);

  // Filter by time range
  const visiblePopoffs = popoffs.length > 0 ? popoffs : progressivePopoffs;
  const filtered = visiblePopoffs.filter((p) => {
    const age = Date.now() - new Date(p.time).getTime();
    return age < RANGE_MS[range];
  });

  useEffect(() => {
    const usersToFetch = [...new Set(
      visiblePopoffs
        .filter((entry) => !ppGainFetchedByUserId[entry.user.id])
        .map((entry) => entry.user.id),
    )];

    if (usersToFetch.length === 0) return;

    let cancelled = false;

    Promise.allSettled(
      usersToFetch.map(async (userId) => ({
        userId,
        gains: await getUserApproxPpGains({ data: { userId } }),
      })),
    ).then((results) => {
      if (cancelled) return;

      const nextGains: Record<number, number> = {};
      const fetchedUsers: Record<number, true> = {};

      results.forEach((result) => {
        if (result.status !== "fulfilled") return;
        fetchedUsers[result.value.userId] = true;
        Object.assign(nextGains, result.value.gains);
      });

      setPpGainByScoreId((prev) => ({ ...prev, ...nextGains }));
      setPpGainFetchedByUserId((prev) => ({ ...prev, ...fetchedUsers }));
    });

    return () => {
      cancelled = true;
    };
  }, [visiblePopoffs, ppGainFetchedByUserId]);

  // Paginate
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const ranges: { id: TimeRange; label: string }[] = [
    { id: "24h", label: "24 hours" },
    { id: "3d", label: "3 days" },
    { id: "7d", label: "7 days" },
    { id: "30d", label: "30 days" },
  ];

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title="CR mania pop-offs"
        right={
          <div className="flex items-center gap-2">
            {(loadingPlayers || loading) && !playersError && (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <span className="text-[10px] text-osu-f1">
                  {loadingPlayers
                    ? "Loading player list..."
                    : `Loading ${loadedCount}/${players.length} players...`}
                </span>
              </div>
            )}
            {!loadingPlayers && !loading && !playersError && (
              <span className="text-[10px] text-osu-f1">
                {filtered.length} pop-offs found
              </span>
            )}
          </div>
        }
      />

      <PageTabs
        items={ranges}
        value={range}
        onChange={(nextRange) => {
          setRange(nextRange);
          setPage(0);
        }}
      />

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-6">
          {playersError && (
            <div className="text-center py-16 text-osu-f1 text-sm">
              {playersError}
            </div>
          )}

          {/* Loading skeletons on initial load */}
          {!playersError && (loadingPlayers || (loading && visiblePopoffs.length === 0)) && (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-3 px-4 rounded-xl bg-osu-b4 border border-osu-b3/20">
                  <Skeleton className="w-16 h-10" />
                  <Skeleton className="w-8 h-8 rounded-full" />
                  <Skeleton className="w-9 h-9 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          )}

          {/* Results */}
          {!playersError && paginated.length > 0 && (
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {paginated.map((p: PopOff, i: number) => (
                  <motion.div
                    key={`${p.user.id}-${p.score.id}`}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12, delay: i * 0.02 }}
                    className="flex items-center gap-3 py-3 px-4 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors duration-[120ms] cursor-pointer border border-osu-b3/20"
                    onClick={() =>
                      navigate({ to: "/player/$username", params: { username: p.user.username } })
                    }
                  >
                    {/* PP badge */}
                    <div className="flex-shrink-0 w-16 text-center">
                      <div className="text-lg font-bold text-osu-pink" style={{ fontFamily: "Torus" }}>
                        {Math.round(p.pp)}
                      </div>
                      <div className="text-[8px] uppercase tracking-wider text-osu-f1 font-semibold">pp</div>
                      {ppGainByScoreId[p.score.id] != null && (
                        <div
                          className="text-[10px] font-semibold text-osu-green"
                          title="Approximate pp gain from removing this play from the current best-score stack"
                        >
                          +{formatNumber(Math.round(ppGainByScoreId[p.score.id]))}
                        </div>
                      )}
                    </div>

                    <GradeImg grade={p.score.rank} size={30} />
                    <Avatar url={p.user.avatar_url} size={36} />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">{p.user.username}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-osu-pink/15 text-osu-pink-light font-semibold">
                          New best
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-osu-l2 truncate">
                          {p.score.beatmapset?.title}
                        </span>
                        <span className="text-[10px] text-osu-f1 truncate">
                          [{p.score.beatmap?.version}]
                        </span>
                        {p.score.beatmap?.cs && (
                          <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                            {p.score.beatmap.cs}K
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="flex gap-0.5">
                        {(p.score.mods ?? [])
                          .filter((m) => m?.acronym && m.acronym !== "CL")
                          .map((m) => (
                            <ModBadge key={m.acronym} mod={m.acronym} />
                          ))}
                      </div>
                      <span className="text-xs text-osu-l2">
                        {formatAccuracy(p.score.accuracy)}
                      </span>
                      <span className="text-xs text-osu-f1">
                        {formatNumber(p.score.max_combo)}x
                      </span>
                      {scoreHasReplay(p.score) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            window.location.href = `/replay?scoreId=${p.score.id}&mode=mania`;
                          }}
                          className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors"
                        >
                          ▶ Replay
                        </button>
                      )}
                      <span className="text-[10px] text-osu-f1 w-14 text-right">
                        {formatTimeAgo(p.time)}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}

          {!playersError && !loadingPlayers && !loading && filtered.length === 0 && (
            <div className="text-center py-16 text-osu-f1 text-sm">
              No pop-offs in this time range
            </div>
          )}

          {/* Pagination */}
          {!playersError && totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              {page > 0 && (
                <button
                  onClick={() => setPage(page - 1)}
                  className="px-4 py-2 rounded-lg bg-osu-b4 text-xs text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer"
                >
                  &larr; Prev
                </button>
              )}
              <span className="text-xs text-osu-f1 px-3">
                Page {page + 1} of {totalPages}
              </span>
              {page < totalPages - 1 && (
                <button
                  onClick={() => setPage(page + 1)}
                  className="px-4 py-2 rounded-lg bg-osu-b4 text-xs text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer"
                >
                  Next &rarr;
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
