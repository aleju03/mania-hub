import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getRankings, getCountryRecentScores, getUsersApproxPpGains } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { formatAccuracy, formatTimeAgo, formatPP, formatNumber } from "../lib/format";
import {
  getBeatmapUrl,
  getDisplayedAccuracy,
  getDisplayedRank,
  getDisplayedTotalScore,
  getScoreIdentity,
  getScoreTimeMs,
  getScoreTimestamp,
  isDisplayedPassed,
  scoreHasReplay,
} from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";

import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { ScoreRowSkeleton } from "../components/ui/LoadingSkeleton";
import { UsernameText } from "../components/ui/UsernameText";
import { useAppStore } from "../store";
import type { OsuScore } from "../lib/types";

export const Route = createFileRoute("/scores")({
  component: ScoresPage,
});

type ScoreFilter = "all" | "ranked" | "passed";
type GradeFilter = "all" | "SS" | "S" | "A" | "B";
type FailedFilter = "hide" | "show" | "only";
const PP_GAIN_BATCH_SIZE = 4;

function ScoresPage() {
  const {
    crRankings,
    crRankingsFetchedAt,
    feedScores,
    feedScoresFetchedAt,
    trackedUserIds,
    addFeedScores,
    markFeedScoresFetched,
    setCrRankings,
    setTrackedUserIds,
    pollIndex,
    nextPollIndex,
  } = useAppStore();
  const [userIds, setUserIds] = useState<number[]>(trackedUserIds);
  const [loadingPlayers, setLoadingPlayers] = useState(trackedUserIds.length === 0 && !crRankings);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [filter, setFilter] = useState<ScoreFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [failedFilter, setFailedFilter] = useState<FailedFilter>("hide");
  const [initialLoaded, setInitialLoaded] = useState(feedScores.length > 0 || !!feedScoresFetchedAt);
  const [initialRefreshDone, setInitialRefreshDone] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [ppGainByScoreId, setPpGainByScoreId] = useState<Record<number, number>>({});
  const [ppGainFetchedByUserId, setPpGainFetchedByUserId] = useState<Record<number, true>>({});

  useEffect(() => {
    let cancelled = false;
    const cachedIds = crRankings?.ranking.map((entry: { user: { id: number } }) => entry.user.id) ?? trackedUserIds;

    if (cachedIds.length > 0) {
      setUserIds(cachedIds);
      setLoadingPlayers(false);
      setPlayersError(null);
    }

    const shouldRefresh = !crRankings || isCacheStale(crRankingsFetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefresh) {
      return () => {
        cancelled = true;
      };
    }

    setLoadingPlayers(cachedIds.length === 0);

    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((rankings) => {
        if (cancelled) return;

        const ids = rankings.ranking.map((entry: { user: { id: number } }) => entry.user.id);
        setCrRankings(rankings);
        setUserIds(ids);
        setTrackedUserIds(ids);
        setPlayersError(null);
      })
      .catch(() => {
        if (cancelled || cachedIds.length > 0) return;
        setPlayersError("Couldn't load the tracked player pool.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPlayers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [crRankings, crRankingsFetchedAt, setCrRankings, setTrackedUserIds, trackedUserIds]);

  useEffect(() => {
    if (initialLoaded || feedScores.length > 0) {
      setInitialLoaded(true);
    }
  }, [feedScores.length, initialLoaded]);

  useEffect(() => {
    if (userIds.length === 0 || initialRefreshDone) return;

    const shouldRefresh =
      feedScores.length === 0 || isCacheStale(feedScoresFetchedAt, CLIENT_CACHE_TTL.scoresFeed);

    if (!shouldRefresh) {
      setInitialLoaded(true);
      setInitialRefreshDone(true);
      return;
    }

    if (feedScores.length > 0) {
      setInitialLoaded(true);
    }

    getCountryRecentScores({ data: { userIds, batchSize: userIds.length, batchIndex: 0, recentLimit: 20 } })
      .then((scores) => {
        if (scores.length > 0) addFeedScores(scores);
      })
      .finally(() => {
        markFeedScoresFetched();
        setInitialLoaded(true);
        setInitialRefreshDone(true);
      });
  }, [userIds, initialRefreshDone, feedScores.length, feedScoresFetchedAt, addFeedScores, markFeedScoresFetched]);

  const poll = useCallback(async () => {
    if (!isPolling || userIds.length === 0) return;
    try {
      const scores = await getCountryRecentScores({
        data: { userIds, batchSize: 10, batchIndex: pollIndex, recentLimit: 20 },
      });
      if (scores.length > 0) addFeedScores(scores);
      else markFeedScoresFetched();
      nextPollIndex();
    } catch { /* silently continue */ }
  }, [isPolling, userIds, pollIndex, addFeedScores, markFeedScoresFetched, nextPollIndex]);

  useEffect(() => {
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    setExpandedKey(null);
  }, [filter, gradeFilter, failedFilter]);

  const filtered = useMemo(() => {
    return feedScores.filter((score: OsuScore) => {
      const passed = isDisplayedPassed(score);
      if (failedFilter === "hide" && !passed) return false;
      if (failedFilter === "only" && passed) return false;
      switch (filter) {
        case "ranked":
          return score.pp != null && score.pp > 0;
        case "passed":
          return passed;
        default:
          break;
      }
      if (gradeFilter !== "all") {
        const rank = getDisplayedRank(score);
        // SS includes XH/X/SS/SSH, S includes SH/S
        if (gradeFilter === "SS") return ["SS", "SSH", "X", "XH"].includes(rank);
        if (gradeFilter === "S") return ["S", "SH"].includes(rank);
        return rank === gradeFilter;
      }
      return true;
    });
  }, [feedScores, filter, gradeFilter, failedFilter]);

  const activePlayers = useMemo(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const seen = new Map<number, { username: string; avatar_url: string; latestTime: number }>();
    for (const score of feedScores) {
      const timeMs = getScoreTimeMs(score);
      if (timeMs < oneHourAgo || !score.user) continue;
      const existing = seen.get(score.user_id);
      if (!existing || timeMs > existing.latestTime) {
        seen.set(score.user_id, {
          username: score.user.username,
          avatar_url: score.user.avatar_url,
          latestTime: timeMs,
        });
      }
    }
    return [...seen.entries()]
      .sort((a, b) => b[1].latestTime - a[1].latestTime)
      .map(([id, info]) => ({ id, ...info }));
  }, [feedScores]);

  useEffect(() => {
    const rankedUsersToFetch = [...new Set(
      filtered
        .filter((score) => score.pp != null && score.pp > 0 && !ppGainFetchedByUserId[score.user_id])
        .map((score) => score.user_id),
    )].slice(0, 12);

    if (rankedUsersToFetch.length === 0) return;

    let cancelled = false;
    const run = async () => {
      for (let i = 0; i < rankedUsersToFetch.length; i += PP_GAIN_BATCH_SIZE) {
        const batch = rankedUsersToFetch.slice(i, i + PP_GAIN_BATCH_SIZE);
        const gains = await getUsersApproxPpGains({ data: { userIds: batch } });
        if (cancelled) return;
        const fetchedUsers = Object.fromEntries(batch.map((userId) => [userId, true])) as Record<number, true>;
        setPpGainByScoreId((prev) => ({ ...prev, ...gains }));
        setPpGainFetchedByUserId((prev) => ({ ...prev, ...fetchedUsers }));
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [filtered, ppGainFetchedByUserId]);

  const filters: { id: ScoreFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ranked", label: "Ranked (PP)" },
    { id: "passed", label: "Passed" },
  ];
  const grades: { id: GradeFilter; label: string }[] = [
    { id: "all", label: "Any" },
    { id: "SS", label: "SS" },
    { id: "S", label: "S" },
    { id: "A", label: "A" },
    { id: "B", label: "B" },
  ];
  const failedOptions: { id: FailedFilter; label: string }[] = [
    { id: "hide", label: "Hide failed" },
    { id: "show", label: "Show failed" },
    { id: "only", label: "Only failed" },
  ];
  const listKey = `${filter}:${gradeFilter}:${failedFilter}`;

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/news.svg"
        title="CR mania tracker"
        right={
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isPolling ? "bg-osu-green animate-pulse" : "bg-osu-f1"}`} />
            <span className="text-[10px] text-osu-f1">
              {loadingPlayers
                ? "Loading tracked players..."
                : `${isPolling ? "Live" : "Paused"} \u00b7 ${feedScores.length} scores`}
            </span>
            <button
              onClick={() => setIsPolling(!isPolling)}
              className="px-2.5 py-1 rounded-lg bg-osu-b4 text-[10px] text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/30"
              disabled={loadingPlayers || !!playersError}
            >
              {isPolling ? "Pause" : "Resume"}
            </button>
          </div>
        }
      />

      <div className="bg-osu-d5 border-b border-osu-b3/30">
        <div className="max-w-[1200px] mx-auto px-5 flex items-center justify-between">
          <div className="flex items-center gap-0">
            {filters.map((item) => (
              <button
                key={item.id}
                onClick={() => { setFilter(item.id); if (item.id !== "all") setGradeFilter("all"); }}
                className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 ${
                  filter === item.id
                    ? "text-osu-c1 border-osu-h1"
                    : "text-osu-f1 border-transparent hover:text-osu-l2"
                }`}
              >
                {item.label}
              </button>
            ))}
            <div className="w-px h-5 bg-osu-b3/40 mx-2" />
            {grades.map((item) => (
              <button
                key={item.id}
                onClick={() => { setGradeFilter(item.id); if (item.id !== "all") setFilter("all"); }}
                className={`px-2.5 py-2.5 text-[11px] font-semibold cursor-pointer transition-colors duration-[120ms] border-b-2 ${
                  gradeFilter === item.id
                    ? "text-osu-c1 border-osu-h1"
                    : "text-osu-f1 border-transparent hover:text-osu-l2"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg overflow-hidden border border-osu-b3/30">
            {failedOptions.map((item) => (
              <button
                key={item.id}
                onClick={() => setFailedFilter(item.id)}
                className={`px-2.5 py-1.5 text-[10px] font-medium cursor-pointer transition-colors duration-[120ms] ${
                  failedFilter === item.id
                    ? "bg-osu-b3 text-osu-l2"
                    : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-5 flex gap-5">
          {activePlayers.length > 0 && (
            <div className="hidden lg:flex flex-col items-center gap-2 flex-shrink-0 pt-1">
              <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-1">Playing</span>
              {activePlayers.map((player) => (
                <button
                  key={player.id}
                  onClick={() => {
                    window.location.href = `/player/${encodeURIComponent(player.username)}`;
                  }}
                  className="cursor-pointer group relative"
                  title={player.username}
                >
                  <div className="ring-2 ring-osu-green/50 rounded-full group-hover:ring-osu-green transition-all">
                    <Avatar url={player.avatar_url} size={32} />
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="flex-1 min-w-0">
            {playersError ? (
              <div className="text-center py-16 text-osu-f1 text-sm">
                {playersError}
              </div>
            ) : loadingPlayers || (!initialLoaded && feedScores.length === 0) ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <ScoreRowSkeleton key={i} />
                ))}
              </div>
            ) : (
              <>
                <div key={listKey} className="space-y-2">
                  <AnimatePresence initial={false}>
                    {filtered.map((score: OsuScore) => {
                      const scoreKey = getScoreIdentity(score);

                      return (
                        <ScoreFeedItem
                          key={scoreKey}
                          score={score}
                          approxPpGain={ppGainByScoreId[score.id] ?? null}
                          expanded={expandedKey === scoreKey}
                          onToggle={() => setExpandedKey((current) => (current === scoreKey ? null : scoreKey))}
                        />
                      );
                    })}
                  </AnimatePresence>
                </div>
                {filtered.length === 0 && (
                  <div className="text-center py-16 text-osu-f1 text-sm">
                    {feedScores.length === 0
                      ? "No recent scores yet."
                      : "No scores match this filter"}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreFeedItem({
  score,
  approxPpGain,
  expanded,
  onToggle,
}: {
  score: OsuScore;
  approxPpGain: number | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const keys = score.beatmap?.cs;
  const stats = score.statistics;
  const totalScore = getDisplayedTotalScore(score);
  const beatmapUrl = getBeatmapUrl(score);
  const countMax = stats?.count_geki ?? stats?.perfect ?? 0;
  const count300 = stats?.count_300 ?? stats?.great ?? 0;
  const count200 = stats?.count_katu ?? stats?.good ?? 0;
  const count100 = stats?.count_100 ?? stats?.ok ?? 0;
  const count50 = stats?.count_50 ?? stats?.meh ?? 0;
  const countMiss = stats?.count_miss ?? stats?.miss ?? 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden"
    >
      <div
        className="flex items-center gap-3 py-3 px-4 hover:bg-osu-b3/50 transition-colors duration-[120ms] cursor-pointer"
        onClick={onToggle}
      >
        <GradeImg grade={getDisplayedRank(score)} size={32} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!score.user?.username) return;
            window.location.href = `/player/${encodeURIComponent(score.user.username)}`;
          }}
          className="cursor-pointer"
          title={score.user?.username ? `Open ${score.user.username}'s profile` : undefined}
        >
          <Avatar url={score.user?.avatar_url} size={36} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {score.user?.username ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = `/player/${encodeURIComponent(score.user.username)}`;
                }}
                className="cursor-pointer"
              >
                <UsernameText
                  username={score.user.username}
                  avatarUrl={score.user?.avatar_url}
                  className="text-sm font-semibold"
                />
              </button>
            ) : (
              <UsernameText
                username="Unknown"
                avatarUrl={score.user?.avatar_url}
                className="text-sm font-semibold"
              />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {beatmapUrl ? (
              <a
                href={beatmapUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                title="Open beatmap on osu!"
              >
                {score.beatmapset?.title}
              </a>
            ) : (
              <span className="text-xs text-white truncate">{score.beatmapset?.title}</span>
            )}
            <span className="text-[10px] text-osu-f1 truncate">[{score.beatmap?.version}]</span>
            {keys && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {keys}K
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex gap-0.5">
            {(score.mods ?? []).filter((m) => m?.acronym && m.acronym !== "CL").map((m) => (
              <ModBadge key={m.acronym} mod={m.acronym} />
            ))}
          </div>
          <span className="text-xs text-osu-l2">{formatAccuracy(getDisplayedAccuracy(score))}</span>
          <span className="text-sm font-bold">
            {formatPP(score.pp)}
            {approxPpGain != null && (
              <span
                className="ml-1 text-[11px] font-semibold text-osu-green"
                title="Approximate pp gain from removing this play from the current best-score stack"
              >
                (+{formatNumber(Math.round(approxPpGain))})
              </span>
            )}
          </span>
          {scoreHasReplay(score) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                window.location.href = `/replay?scoreId=${score.id}&mode=mania&beatmapsetId=${score.beatmapset?.id}`;
              }}
              className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
              title="Watch replay"
            >
              &#9654; Replay
            </button>
          )}
          <span className="text-[10px] text-osu-f1 w-12 text-right">
            {formatTimeAgo(getScoreTimestamp(score))}
          </span>
        </div>
      </div>

      {/* Expanded score details */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 pt-1 border-t border-osu-b3/20">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-center">
                <StatCell label="Score" value={totalScore != null ? formatNumber(totalScore) : "-"} />
                <StatCell label="Combo" value={`${formatNumber(score.max_combo)}x`} />
                <StatCell label="MAX" value={formatNumber(countMax)} color="text-osu-blue" />
                <StatCell label="300" value={formatNumber(count300)} color="text-osu-yellow" />
                <StatCell label="200" value={formatNumber(count200)} color="text-osu-green" />
                <StatCell label="100" value={formatNumber(count100)} color="text-osu-purple" />
                <StatCell label="50" value={formatNumber(count50)} color="text-osu-orange" />
                <StatCell label="Miss" value={formatNumber(countMiss)} color="text-osu-red" />
                {score.pp != null && score.pp > 0 && (
                  <StatCell label="PP" value={`${Math.round(score.pp)}pp`} color="text-osu-pink" />
                )}
                {score.beatmap?.difficulty_rating != null && (
                  <StatCell label="Stars" value={score.beatmap.difficulty_rating.toFixed(2)} />
                )}
                {score.beatmap?.bpm != null && (
                  <StatCell label="BPM" value={String(Math.round(score.beatmap.bpm))} />
                )}
                {score.max_combo > 0 && score.beatmap?.max_combo && score.beatmap.max_combo > 0 && (
                  <StatCell label="Combo %" value={`${Math.round((score.max_combo / score.beatmap.max_combo) * 100)}%`} />
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}
