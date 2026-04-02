import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getUser, getUserScoresBest, getUserScoresRecent } from "../../lib/osu";
import {
  formatNumber,
  formatAccuracy,
  formatPlayTime,
  formatTimeAgo,
  formatDate,
  formatPP,
} from "../../lib/format";
import { getScoreIdentity, getScoreTimestamp, getScoreUrl } from "../../lib/score";
import { Avatar } from "../../components/ui/Avatar";
import { GradeImg } from "../../components/ui/GradeImg";
import { ModBadge } from "../../components/ui/ModBadge";
import { ScoreRowSkeleton, Skeleton } from "../../components/ui/LoadingSkeleton";
import { UsernameText } from "../../components/ui/UsernameText";
import type { OsuScore, OsuUser } from "../../lib/types";

const userRequestCache = new Map<string, Promise<OsuUser>>();
const userScoresRequestCache = new Map<number, Promise<[OsuScore[], OsuScore[]]>>();
const INITIAL_SCORE_BATCH_SIZE = 5;
const SHOW_MORE_BATCH_SIZE = 50;
type ScoreTab = "best" | "recent";

export const Route = createFileRoute("/player/$username")({
  component: PlayerPage,
});

type KeyFilter = "all" | "4k" | "6k" | "7k";

function matchesKeyFilter(score: OsuScore, keyFilter: KeyFilter): boolean {
  if (keyFilter === "all") return true;
  if (keyFilter === "4k") return score.beatmap?.cs === 4;
  if (keyFilter === "6k") return score.beatmap?.cs === 6;
  if (keyFilter === "7k") return score.beatmap?.cs === 7;
  return true;
}

function loadUserCached(username: string): Promise<OsuUser> {
  const cached = userRequestCache.get(username);
  if (cached) return cached;

  const request = getUser({ data: { key: username } }).finally(() => {
    userRequestCache.delete(username);
  });

  userRequestCache.set(username, request);
  return request;
}

function loadUserScoresCached(userId: number): Promise<[OsuScore[], OsuScore[]]> {
  const cached = userScoresRequestCache.get(userId);
  if (cached) return cached;

  const request = Promise.all([
    getUserScoresBest({ data: { userId, limit: INITIAL_SCORE_BATCH_SIZE, offset: 0 } }),
    getUserScoresRecent({ data: { userId, limit: INITIAL_SCORE_BATCH_SIZE, offset: 0, include_fails: true } }),
  ]).finally(() => {
    userScoresRequestCache.delete(userId);
  });

  userScoresRequestCache.set(userId, request);
  return request;
}

function PlayerPage() {
  const { username } = Route.useParams();
  const [user, setUser] = useState<OsuUser | null>(null);
  const [best, setBest] = useState<OsuScore[]>([]);
  const [recent, setRecent] = useState<OsuScore[]>([]);
  const [loadingUser, setLoadingUser] = useState(true);
  const [loadingScores, setLoadingScores] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);
  const [scoresError, setScoresError] = useState<string | null>(null);
  const [tab, setTab] = useState<ScoreTab>("best");
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [bestHasMore, setBestHasMore] = useState(true);
  const [recentHasMore, setRecentHasMore] = useState(true);
  const [loadingMoreTab, setLoadingMoreTab] = useState<ScoreTab | null>(null);
  const [bestVisibleCount, setBestVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);
  const [recentVisibleCount, setRecentVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);

  useEffect(() => {
    if (!avatarOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAvatarOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [avatarOpen]);

  useEffect(() => {
    let cancelled = false;

    setUser(null);
    setBest([]);
    setRecent([]);
    setTab("best");
    setKeyFilter("all");
    setUserError(null);
    setScoresError(null);
    setLoadingUser(true);
    setLoadingScores(true);
    setBestHasMore(true);
    setRecentHasMore(true);
    setLoadingMoreTab(null);
    setBestVisibleCount(INITIAL_SCORE_BATCH_SIZE);
    setRecentVisibleCount(INITIAL_SCORE_BATCH_SIZE);

    loadUserCached(username)
      .then((result) => {
        if (cancelled) return;
        setUser(result);
        setUserError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setUserError("Couldn't load this player right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingUser(false);
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    setLoadingScores(true);

    loadUserScoresCached(user.id)
      .then(([bestScores, recentScores]) => {
        if (cancelled) return;
        setBest(bestScores);
        setRecent(recentScores);
        setBestHasMore(bestScores.length === INITIAL_SCORE_BATCH_SIZE);
        setRecentHasMore(recentScores.length === INITIAL_SCORE_BATCH_SIZE);
        setScoresError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setScoresError("Couldn't load this player's scores right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingScores(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const fetchMoreScores = useCallback(async (targetTab: ScoreTab) => {
    if (!user || loadingMoreTab) return;

    const currentScores = targetTab === "best" ? best : recent;
    setLoadingMoreTab(targetTab);

    try {
      const nextScores = targetTab === "best"
        ? await getUserScoresBest({
          data: { userId: user.id, limit: SHOW_MORE_BATCH_SIZE, offset: currentScores.length },
        })
        : await getUserScoresRecent({
          data: {
            userId: user.id,
            limit: SHOW_MORE_BATCH_SIZE,
            offset: currentScores.length,
            include_fails: true,
          },
        });

      if (targetTab === "best") {
        setBest((prev) => [...prev, ...nextScores]);
        setBestHasMore(nextScores.length === SHOW_MORE_BATCH_SIZE);
      } else {
        setRecent((prev) => [...prev, ...nextScores]);
        setRecentHasMore(nextScores.length === SHOW_MORE_BATCH_SIZE);
      }
    } catch {
      setScoresError("Couldn't load more scores right now.");
    } finally {
      setLoadingMoreTab(null);
    }
  }, [best, loadingMoreTab, recent, user]);

  useEffect(() => {
    setBestVisibleCount(INITIAL_SCORE_BATCH_SIZE);
    setRecentVisibleCount(INITIAL_SCORE_BATCH_SIZE);
  }, [keyFilter]);

  const handleShowMore = useCallback(() => {
    if (tab === "best") {
      setBestVisibleCount((count) => count + SHOW_MORE_BATCH_SIZE);
      return;
    }

    setRecentVisibleCount((count) => count + SHOW_MORE_BATCH_SIZE);
  }, [tab]);

  useEffect(() => {
    const currentScores = tab === "best" ? best : recent;
    const currentVisibleCount = tab === "best" ? bestVisibleCount : recentVisibleCount;
    const filteredScores = currentScores.filter((score) => matchesKeyFilter(score, keyFilter));
    const currentHasMore = tab === "best" ? bestHasMore : recentHasMore;

    if (loadingScores || scoresError || loadingMoreTab) return;
    if (filteredScores.length >= currentVisibleCount) return;
    if (!currentHasMore) return;

    void fetchMoreScores(tab);
  }, [
    best,
    bestHasMore,
    bestVisibleCount,
    fetchMoreScores,
    keyFilter,
    loadingMoreTab,
    loadingScores,
    recent,
    recentHasMore,
    recentVisibleCount,
    scoresError,
    tab,
  ]);

  if (loadingUser && !user) {
    return <PlayerPageSkeleton />;
  }

  if (userError || !user) {
    return (
      <div className="flex-1 bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-16 text-center text-sm text-osu-f1">
          {userError ?? "Player not found."}
        </div>
      </div>
    );
  }

  const stats = user.statistics;
  const currentScores = tab === "best" ? best : recent;
  const currentVisibleCount = tab === "best" ? bestVisibleCount : recentVisibleCount;
  const filteredScores = currentScores.filter((score) => matchesKeyFilter(score, keyFilter));
  const visibleScores = filteredScores.slice(0, currentVisibleCount);
  const currentHasMore = tab === "best" ? bestHasMore : recentHasMore;
  const isLoadingMoreCurrentTab = loadingMoreTab === tab;
  const canShowMore = filteredScores.length > visibleScores.length || currentHasMore;
  const isSettlingInitialFilteredView =
    !loadingScores &&
    currentVisibleCount === INITIAL_SCORE_BATCH_SIZE &&
    filteredScores.length < INITIAL_SCORE_BATCH_SIZE &&
    currentHasMore;
  const scoreListState = loadingScores
    ? "loading"
    : isSettlingInitialFilteredView
      ? "settling"
      : scoresError
        ? "error"
        : visibleScores.length > 0
          ? "loaded"
          : "empty";

  return (
    <div className="flex-1">
      {/* Avatar modal */}
      <AnimatePresence>
        {avatarOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center backdrop-blur-sm bg-black/75 cursor-pointer"
            onClick={() => setAvatarOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.img
              src={user.avatar_url}
              alt={`${user.username}'s avatar`}
              className="w-[300px] h-[300px] rounded-2xl shadow-[0_12px_60px_rgba(0,0,0,0.7)] object-cover"
              onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.85, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 500 }}
            />
            <motion.div
              className="mt-4 flex flex-col items-center gap-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15, delay: 0.05 }}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-white font-bold text-lg">{user.username}</span>
              <a
                href={`https://osu.ppy.sh/users/${user.id}/mania`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-osu-f1 hover:text-osu-l2 transition-colors"
              >
                View osu! profile
              </a>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cover + Avatar */}
      <div className="relative h-[280px] overflow-hidden bg-osu-b4">
        <img
          src={user.cover?.url || user.cover_url}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ filter: "brightness(0.4) blur(1px)" }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-osu-b5" />
        <div className="absolute bottom-0 left-0 right-0">
          <div className="max-w-[1200px] mx-auto px-5 pb-5 flex items-end gap-5">
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              className="w-[110px] h-[110px] rounded-2xl overflow-hidden border-2 border-osu-b3/60 shadow-[0_4px_20px_rgba(0,0,0,0.5)] translate-y-4 flex-shrink-0 cursor-pointer hover:border-osu-l2/60 transition-colors duration-150"
            >
              <Avatar url={user.avatar_url} size={110} shape="square" />
            </button>
            <div className="pb-1 flex-1 min-w-0">
              <h1 className="text-3xl font-bold text-white truncate">
                <UsernameText username={user.username} avatarUrl={user.avatar_url} className="text-[34px] font-black text-white" />
              </h1>
              <div className="flex items-center gap-3 mt-1">
                <span
                  className="text-xs text-osu-l2"
                  style={{ textShadow: "0 1px 3px rgba(0,0,0,0.75)" }}
                >
                  {user.country?.name || user.country_code}
                </span>
                {user.is_supporter && (
                  <span className="inline-flex items-center justify-center h-5 px-1.5 rounded-full bg-osu-pink" title="osu! Supporter">
                    <img src="/images/icons/supporter.svg" alt="Supporter" className="w-3 h-3 brightness-0 invert" />
                  </span>
                )}
                {user.is_online && (
                  <span className="w-2 h-2 rounded-full bg-osu-green" title="Online" />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 pt-8 pb-4">
          {/* Main stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
            <StatBox label="Global Rank" value={stats.global_rank ? `#${formatNumber(stats.global_rank)}` : "-"} accent />
            <StatBox label="Country Rank" value={stats.country_rank ? `#${formatNumber(stats.country_rank)}` : "-"} accent />
            <StatBox label="PP" value={formatNumber(Math.round(stats.pp))} />
            <StatBox label="Accuracy" value={formatAccuracy(stats.hit_accuracy / 100)} />
            <StatBox label="Play Count" value={formatNumber(stats.play_count)} />
            <StatBox label="Play Time" value={formatPlayTime(stats.play_time)} />
          </div>

          {/* Rank history chart */}
          {user.rank_history?.data && user.rank_history.data.length > 0 && (
            <RankChart data={user.rank_history.data} />
          )}

          {/* Secondary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <StatBox label="Ranked Score" value={formatNumber(stats.ranked_score)} small />
            <StatBox label="Total Score" value={formatNumber(stats.total_score)} small />
            <StatBox label="Total Hits" value={formatNumber(stats.total_hits)} small />
            <StatBox label="Max Combo" value={formatNumber(stats.maximum_combo)} small />
          </div>

          {/* Grades */}
          <div className="mt-5 pt-4 border-t border-osu-b3/30 flex flex-wrap items-center gap-4">
            {([
              ["SSH", stats.grade_counts.ssh],
              ["SS", stats.grade_counts.ss],
              ["SH", stats.grade_counts.sh],
              ["S", stats.grade_counts.s],
              ["A", stats.grade_counts.a],
            ] as [string, number][]).map(([grade, count]) => (
              <div key={grade} className="flex items-center gap-1.5">
                <GradeImg grade={grade} size={28} />
                <span className="text-xs text-osu-f1 font-medium">{formatNumber(count)}</span>
              </div>
            ))}
            <div className="ml-auto text-[11px] text-osu-f1 space-x-4">
              <span>
                Joined <strong className="text-osu-l2">{formatDate(user.join_date)}</strong>
              </span>
              {user.playstyle && (
                <span>
                  Plays with{" "}
                  <strong className="text-osu-l2">{user.playstyle.join(", ")}</strong>
                </span>
              )}
            </div>
          </div>

          {/* Score tabs */}
          <div className="mt-5 pt-1 border-t border-osu-b3/30 flex flex-wrap items-center justify-between gap-3">
            <div className="flex">
              {(["best", "recent"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] capitalize ${
                    tab === t
                      ? "text-osu-c1 border-b-2 border-osu-h1"
                      : "text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  {t === "best" ? "Best Performance" : "Recent Plays"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-1">
              {([
                ["all", "All"],
                ["4k", "4K"],
                ["6k", "6K"],
                ["7k", "7K"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setKeyFilter(value)}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                    keyFilter === value
                      ? "bg-osu-pink/15 text-osu-pink-light"
                      : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Scores list */}
      <div className="bg-osu-b5 border-t border-osu-b3/20">
        <div className="max-w-[1200px] mx-auto px-5 py-5 space-y-1.5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={scoreListState}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
              className="space-y-1.5"
            >
              {scoreListState === "loading" ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <ScoreRowSkeleton key={i} />
                ))
              ) : scoreListState === "settling" ? (
                Array.from({ length: INITIAL_SCORE_BATCH_SIZE }).map((_, i) => (
                  <PlayerScoreRowSkeleton key={`settling-${i}`} />
                ))
              ) : scoreListState === "error" ? (
                <div className="text-center py-8 text-osu-f1 text-sm">{scoresError}</div>
              ) : scoreListState === "loaded" ? (
                visibleScores.map((s: OsuScore, i: number) => (
                  <ScoreRow key={getScoreIdentity(s)} score={s} position={i + 1} />
                ))
              ) : (
                <div className="text-center py-8 text-osu-f1 text-sm">No scores found</div>
              )}
            </motion.div>
          </AnimatePresence>

          {!loadingScores && !scoresError && canShowMore && (
            <div className="pt-3 flex justify-center">
              <button
                type="button"
                onClick={handleShowMore}
                disabled={isLoadingMoreCurrentTab}
                className="px-4 py-2 rounded-lg bg-osu-b4 text-[12px] font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors cursor-pointer disabled:cursor-default disabled:opacity-60"
              >
                {isLoadingMoreCurrentTab ? "Loading..." : "Show more"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerPageSkeleton() {
  return (
    <div className="flex-1 bg-osu-b5">
      <div className="relative h-[280px] overflow-hidden bg-osu-b4">
        <div className="absolute inset-0 bg-gradient-to-b from-osu-d5 to-osu-b5" />
        <div className="absolute bottom-0 left-0 right-0">
          <div className="max-w-[1200px] mx-auto px-5 pb-5 flex items-end gap-5">
            <Skeleton className="w-[110px] h-[110px] rounded-2xl translate-y-4 flex-shrink-0" />
            <div className="pb-1 flex-1 min-w-0 space-y-2">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-4 w-28" />
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-5 pt-8 pb-5 space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-osu-b4 rounded-xl p-3 border border-osu-b3/20 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>

        <div className="bg-osu-b4 rounded-xl p-3 border border-osu-b3/20 space-y-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-14" />
          </div>
          <Skeleton className="h-16 w-full" />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-osu-b4 rounded-xl p-3 border border-osu-b3/20 space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>

        <div className="space-y-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <ScoreRowSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div className="bg-osu-b4 rounded-xl p-3 border border-osu-b3/20">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div
        className={`font-bold mt-0.5 ${small ? "text-sm" : "text-xl"} ${accent ? "text-osu-yellow" : "text-white"}`}
      >
        {value}
      </div>
    </div>
  );
}

function RankChart({ data }: { data: number[] }) {
  const valid = data.filter((d) => d > 0);
  if (valid.length < 2) return null;
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const range = max - min || 1;
  const w = 800;
  const h = 60;
  const points = valid
    .map((v, i) => {
      const x = (i / (valid.length - 1)) * w;
      const y = ((v - min) / range) * (h - 4) + 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="bg-osu-b4 rounded-xl p-3 border border-osu-b3/20 overflow-hidden">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
          Rank History (90 days)
        </span>
        <span className="text-[10px] text-osu-f1">
          #{formatNumber(valid[valid.length - 1])}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16">
        <defs>
          <linearGradient id="rankGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(333,100%,70%)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="hsl(333,100%,70%)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points={`0,${h} ${points} ${w},${h}`}
          fill="url(#rankGrad)"
        />
        <polyline
          points={points}
          fill="none"
          stroke="hsl(333,100%,70%)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

function PlayerScoreRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 min-h-[63px]">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Skeleton className="w-7 h-7 rounded-full flex-shrink-0" />
        <Skeleton className="w-12 h-8 rounded flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-64 max-w-[55%]" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-5 rounded" />
          </div>
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="flex gap-0.5 justify-end w-24">
          <Skeleton className="h-5 w-14 rounded" />
        </div>
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-10" />
        <Skeleton className="h-5 w-16" />
      </div>
    </div>
  );
}

function ScoreRow({ score, position }: { score: OsuScore; position: number }) {
  const keys = score.beatmap?.cs;
  const scoreUrl = getScoreUrl(score);

  if (!scoreUrl) {
    return null;
  }

  return (
    <div className="relative group/score">
      <div
        className="pointer-events-none absolute -left-14 top-1/2 -translate-y-1/2 w-10 text-right text-white/90 opacity-0 translate-x-2 transition-all duration-150 ease-out group-hover/score:opacity-100 group-hover/score:translate-x-0"
        style={{ fontFamily: "Venera" }}
      >
        <span className="block text-[24px] leading-none">{position}</span>
      </div>
      <a
        href={scoreUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms] cursor-pointer"
      >
        <GradeImg grade={score.rank} size={28} />
        {score.beatmapset?.covers?.list && (
          <img
            src={score.beatmapset.covers.list}
            alt=""
            className="w-12 h-8 rounded object-cover flex-shrink-0"
            loading="lazy"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">
              {score.beatmapset?.title || "Unknown"}
            </span>
            <span className="text-[10px] text-osu-f1 truncate">
              [{score.beatmap?.version}]
            </span>
            {keys && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {keys}K
              </span>
            )}
          </div>
          <span className="text-[10px] text-osu-f1">
            {score.beatmapset?.artist} &middot; {formatTimeAgo(getScoreTimestamp(score))}
          </span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex gap-0.5 justify-end w-24">
            {(score.mods ?? [])
              .filter((m) => m?.acronym && m.acronym !== "CL")
              .map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} />
              ))}
          </div>
          <span className="text-xs text-osu-l2">{formatAccuracy(score.accuracy)}</span>
          <span className="text-xs text-osu-f1">{formatNumber(score.max_combo)}x</span>
          <span className="text-sm font-bold w-16 text-right">{formatPP(score.pp)}</span>
        </div>
      </a>
    </div>
  );
}
