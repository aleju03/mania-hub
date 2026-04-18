import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { getRankings, getCountryRecentScores } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { formatAccuracy, formatTimeAgo, formatPP, formatNumber } from "../lib/format";
import {
  getBeatmapUrl,
  getDisplayedAccuracy,
  getDisplayedRank,
  getDisplayedTotalScore,
  getModDisplayList,
  getScoreIdentity,
  getScoreTimeMs,
  getScoreTimestamp,
  getScoreUrl,
  isDisplayedPassed,
  isLazerScore,
  scoreHasReplay,
} from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";

import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { TrackerRowSkeleton } from "../components/ui/LoadingSkeleton";
import { UsernameText } from "../components/ui/UsernameText";
import { TRACKER_PP_GAIN_CLIENT_TTL, useAppStore, useSelectedCountry } from "../store";
import type { OsuScore } from "../lib/types";

export const Route = createFileRoute("/tracker")({
  component: ScoresPage,
});

type ScoreFilter = "all" | "ranked" | "passed";
type GradeFilter = "all" | "SS" | "S" | "A" | "B";
type FailedFilter = "hide" | "show" | "only";
const EMPTY_IDS: number[] = [];
const EMPTY_SCORES: OsuScore[] = [];
const EMPTY_SCORE_GAINS: Record<number, { fetchedAt: number; value: number }> = {};

function ScoresPage() {
  const selectedCountry = useSelectedCountry();
  const rankings = useAppStore((state) => state.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((state) => state.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const feedScores = useAppStore((state) => state.feedScoresByCountry[selectedCountry]) ?? EMPTY_SCORES;
  const feedScoresFetchedAt = useAppStore((state) => state.feedScoresFetchedAtByCountry[selectedCountry]) ?? null;
  const trackedUserIds = useAppStore((state) => state.trackedUserIdsByCountry[selectedCountry]) ?? EMPTY_IDS;
  const addFeedScores = useAppStore((state) => state.addFeedScores);
  const markFeedScoresFetched = useAppStore((state) => state.markFeedScoresFetched);
  const setRankings = useAppStore((state) => state.setRankings);
  const setTrackedUserIds = useAppStore((state) => state.setTrackedUserIds);
  const pollIndex = useAppStore((state) => state.pollIndexByCountry[selectedCountry] ?? 0);
  const nextPollIndex = useAppStore((state) => state.nextPollIndex);
  const resetPollIndex = useAppStore((state) => state.resetPollIndex);
  const [userIds, setUserIds] = useState<number[]>(trackedUserIds);
  const [loadingPlayers, setLoadingPlayers] = useState<boolean>(trackedUserIds.length === 0 && !rankings);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [filter, setFilter] = useState<ScoreFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [failedFilter, setFailedFilter] = useState<FailedFilter>("hide");
  const [initialLoaded, setInitialLoaded] = useState(feedScores.length > 0 || !!feedScoresFetchedAt);
  const [initialRefreshDone, setInitialRefreshDone] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const handleToggleExpand = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  }, []);
  const trackerPpGainEntries = useAppStore((state) => state.trackerPpGainsByCountry[selectedCountry] ?? EMPTY_SCORE_GAINS);
  const setTrackerPpGains = useAppStore((state) => state.setTrackerPpGains);
  const countryName = getCountryName(selectedCountry);

  useEffect(() => {
    setUserIds(trackedUserIds);
    setLoadingPlayers(trackedUserIds.length === 0 && !rankings);
    setPlayersError(null);
    setInitialLoaded(feedScores.length > 0 || !!feedScoresFetchedAt);
    setInitialRefreshDone(false);
    setExpandedKey(null);
    resetPollIndex(selectedCountry);
  }, [selectedCountry]);

  useEffect(() => {
    let cancelled = false;
    const cachedIds = rankings?.ranking
      .filter((entry: { user: { is_active?: boolean } }) => entry.user.is_active !== false)
      .map((entry: { user: { id: number } }) => entry.user.id) ?? trackedUserIds;

    if (cachedIds.length > 0) {
      setUserIds(cachedIds);
      setLoadingPlayers(false);
      setPlayersError(null);
    }

    const shouldRefresh = !rankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);

    if (!shouldRefresh) {
      return () => {
        cancelled = true;
      };
    }

    setLoadingPlayers(cachedIds.length === 0);

    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((rankings) => {
        if (cancelled) return;

        const ids = rankings.ranking
          .filter((entry: { user: { is_active?: boolean } }) => entry.user.is_active !== false)
          .map((entry: { user: { id: number } }) => entry.user.id);
        setRankings(selectedCountry, rankings);
        setUserIds(ids);
        setTrackedUserIds(selectedCountry, ids);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rankings, rankingsFetchedAt, selectedCountry]);

  useEffect(() => {
    if (initialLoaded || feedScores.length > 0) {
      setInitialLoaded(true);
    }
  }, [feedScores.length, initialLoaded]);

  useEffect(() => {
    if (userIds.length === 0 || initialRefreshDone) return;

    const shouldRefresh =
      !feedScoresFetchedAt || isCacheStale(feedScoresFetchedAt, CLIENT_CACHE_TTL.scoresFeed);

    if (!shouldRefresh) {
      setInitialLoaded(true);
      setInitialRefreshDone(true);
      return;
    }

    if (feedScores.length > 0) {
      setInitialLoaded(true);
    }

    let cancelled = false;
    const BATCH = 10;

    (async () => {
      const totalBatches = Math.ceil(userIds.length / BATCH);
      for (let b = 0; b < totalBatches; b++) {
        if (cancelled) return;
        try {
          const result = await getCountryRecentScores({
            data: { userIds, batchSize: BATCH, batchIndex: b, recentLimit: 20 },
          });
          if (cancelled) return;
          if (result.scores.length > 0) addFeedScores(selectedCountry, result.scores);
          if (Object.keys(result.gains).length > 0) setTrackerPpGains(selectedCountry, result.gains);
          setInitialLoaded(true);
        } catch { /* continue */ }
      }
      if (!cancelled) {
        markFeedScoresFetched(selectedCountry);
        setInitialRefreshDone(true);
      }
    })();

    return () => { cancelled = true; };
  }, [userIds, initialRefreshDone, feedScores.length, feedScoresFetchedAt, addFeedScores, markFeedScoresFetched, selectedCountry]);

  const poll = useCallback(async () => {
    if (!isPolling || userIds.length === 0) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    try {
      const result = await getCountryRecentScores({
        data: { userIds, batchSize: 10, batchIndex: pollIndex, recentLimit: 20 },
      });
      if (result.scores.length > 0) addFeedScores(selectedCountry, result.scores);
      if (Object.keys(result.gains).length > 0) setTrackerPpGains(selectedCountry, result.gains);
      else markFeedScoresFetched(selectedCountry);
      nextPollIndex(selectedCountry);
    } catch { /* silently continue */ }
  }, [isPolling, userIds, pollIndex, addFeedScores, markFeedScoresFetched, nextPollIndex, selectedCountry, setTrackerPpGains]);

  useEffect(() => {
    if (!isPolling) return;
    const id = setInterval(poll, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll, isPolling]);

  useEffect(() => {
    setExpandedKey(null);
  }, [filter, gradeFilter, failedFilter]);

  const ppGainByScoreId = useMemo(
    () => Object.fromEntries(
      Object.entries(trackerPpGainEntries)
        .filter(([, entry]) => Date.now() - entry.fetchedAt < TRACKER_PP_GAIN_CLIENT_TTL)
        .map(([scoreId, entry]) => [Number(scoreId), entry.value]),
    ) as Record<number, number>,
    [trackerPpGainEntries],
  );

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
        title={`${countryName} mania tracker`}
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
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-0">
          {/* Desktop: single row with all filters */}
          <div className="hidden sm:flex items-center gap-0 w-auto">
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
                className={`px-2.5 py-2 cursor-pointer transition-all duration-[120ms] border-b-2 flex items-center ${
                  gradeFilter === item.id
                    ? "border-osu-h1 opacity-100"
                    : "border-transparent opacity-50 hover:opacity-80"
                }`}
              >
                {item.id === "all" ? (
                  <span className="text-[11px] font-semibold text-osu-f1">Any</span>
                ) : (
                  <GradeImg grade={item.id} size={20} />
                )}
              </button>
            ))}
          </div>
          {/* Mobile: compact single row */}
          <div className="sm:hidden w-full py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex rounded-lg overflow-hidden border border-osu-b3/30 flex-shrink-0">
                {filters.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setFilter(item.id); if (item.id !== "all") setGradeFilter("all"); }}
                    className={`px-2.5 py-1.5 text-[11px] font-medium cursor-pointer transition-colors duration-[120ms] ${
                      filter === item.id && gradeFilter === "all"
                        ? "bg-osu-b3 text-osu-l2"
                        : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
                    }`}
                  >
                    {item.id === "all" ? "All" : item.id === "ranked" ? "PP" : "Pass"}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                {grades.filter((g) => g.id !== "all").map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (gradeFilter === item.id) { setGradeFilter("all"); }
                      else { setGradeFilter(item.id); setFilter("all"); }
                    }}
                    className={`cursor-pointer transition-all duration-[120ms] ${
                      gradeFilter === item.id
                        ? "opacity-100 scale-110"
                        : gradeFilter === "all"
                          ? "opacity-60"
                          : "opacity-30"
                    }`}
                  >
                    <GradeImg grade={item.id} size={32} />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex rounded-lg overflow-hidden border border-osu-b3/30 self-end sm:self-auto">
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
        <div className="max-w-[1200px] mx-auto px-5 py-5 flex flex-col lg:flex-row gap-4 lg:gap-5">
          {activePlayers.length > 0 && (
            <>
              {/* Mobile: horizontal row */}
              <div className="lg:hidden flex items-center gap-3 overflow-x-auto scrollbar-hide py-1">
                <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold flex-shrink-0">Playing</span>
                {activePlayers.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => {
                      window.location.href = `/player/${encodeURIComponent(player.username)}`;
                    }}
                    className="cursor-pointer group relative flex-shrink-0"
                    title={player.username}
                  >
                    <div className="ring-2 ring-inset ring-osu-green/50 rounded-full group-hover:ring-osu-green transition-all">
                      <Avatar url={player.avatar_url} size={32} />
                    </div>
                  </button>
                ))}
              </div>
              {/* Desktop: vertical sidebar */}
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
            </>
          )}
          <div className="flex-1 min-w-0">
            {playersError ? (
              <div className="text-center py-16 text-osu-f1 text-sm">
                {playersError}
              </div>
            ) : loadingPlayers || (!initialLoaded && feedScores.length === 0) ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <TrackerRowSkeleton key={i} />
                ))}
              </div>
            ) : (
              <>
                <VirtualScoreList
                  listKey={listKey}
                  scores={filtered}
                  expandedKey={expandedKey}
                  onToggle={handleToggleExpand}
                  ppGainByScoreId={ppGainByScoreId}
                />
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

// Window-virtualized score list. Only mounts the items currently in the
// viewport (plus a small overscan), so mount cost stays roughly constant
// regardless of how many scores are in the feed.
//
// scrollMargin is set to the list container's offsetTop so the virtualizer
// knows where the list starts relative to the window scroll. measureElement
// handles variable item heights (collapsed vs expanded). The outer div gets
// position: relative and a fixed total height so the page scrollbar reflects
// the full list even though only a few items are rendered.
const ESTIMATED_ROW_HEIGHT = 80;

function VirtualScoreList({
  listKey,
  scores,
  expandedKey,
  onToggle,
  ppGainByScoreId,
}: {
  listKey: string;
  scores: OsuScore[];
  expandedKey: string | null;
  onToggle: (key: string) => void;
  ppGainByScoreId: Record<number, number>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollMargin = parentRef.current?.offsetTop ?? 0;

  const virtualizer = useWindowVirtualizer({
    count: scores.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 4,
    scrollMargin,
    // Include the 8px gap (space-y-2) in the item's measured size via a
    // wrapper padding, so the virtualizer's offsets stay correct.
    getItemKey: (index) => getScoreIdentity(scores[index]),
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      key={listKey}
      ref={parentRef}
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        position: "relative",
        width: "100%",
      }}
    >
      {items.map((vi) => {
        const score = scores[vi.index];
        const scoreKey = getScoreIdentity(score);
        return (
          <div
            key={scoreKey}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              paddingBottom: 8,
            }}
          >
            <ScoreFeedItem
              score={score}
              scoreKey={scoreKey}
              approxPpGain={ppGainByScoreId[score.id] ?? null}
              expanded={expandedKey === scoreKey}
              onToggle={onToggle}
            />
          </div>
        );
      })}
    </div>
  );
}

const ScoreFeedItem = memo(function ScoreFeedItem({
  score,
  scoreKey,
  approxPpGain,
  expanded,
  onToggle,
}: {
  score: OsuScore;
  scoreKey: string;
  approxPpGain: number | null;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const [rendered, setRendered] = useState(expanded);
  useEffect(() => { if (expanded) setRendered(true); }, [expanded]);

  const keys = score.beatmap?.cs;
  const stats = score.statistics;
  const totalScore = getDisplayedTotalScore(score);
  const beatmapUrl = getBeatmapUrl(score);
  const scoreUrl = getScoreUrl(score);
  const countMax = stats?.count_geki ?? stats?.perfect ?? 0;
  const count300 = stats?.count_300 ?? stats?.great ?? 0;
  const count200 = stats?.count_katu ?? stats?.good ?? 0;
  const count100 = stats?.count_100 ?? stats?.ok ?? 0;
  const count50 = stats?.count_50 ?? stats?.meh ?? 0;
  const countMiss = stats?.count_miss ?? stats?.miss ?? 0;
  const lazer = isLazerScore(score);
  const accColorClass = lazer ? "text-osu-pink-light" : "text-osu-l2";

  return (
    <div className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden">
      <div
        className="flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4 hover:bg-osu-b3/50 transition-colors duration-[120ms] cursor-pointer"
        onClick={() => onToggle(scoreKey)}
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
          {/* Row 1: Username + time (mobile) */}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
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
            <span className="text-[10px] text-osu-f1 flex-shrink-0 sm:hidden">{formatTimeAgo(getScoreTimestamp(score))}</span>
          </div>
          {/* Row 2: Beatmap title + keys */}
          <div className="flex items-center justify-between sm:justify-start gap-2 mt-0.5">
            <div className="flex items-center gap-2 min-w-0">
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
            </div>
            {keys && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {keys}K
              </span>
            )}
          </div>
          {/* Row 3 (mobile): Mods left, stats right */}
          <div className="flex items-center justify-between gap-2 mt-1 sm:hidden">
            <div className="flex items-center gap-1">
              {getModDisplayList(score.mods).map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
              ))}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`text-xs ${accColorClass}`}>{formatAccuracy(getDisplayedAccuracy(score))}</span>
              <span className="text-sm font-bold">{formatPP(score.pp)}</span>
              {approxPpGain != null && (
                <span className="text-[10px] font-semibold text-osu-green">+{formatNumber(Math.round(approxPpGain))}</span>
              )}
              {scoreHasReplay(score) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    window.location.href = `/replay?scoreId=${score.id}&beatmapsetId=${score.beatmapset?.id}`;
                  }}
                  className="px-1.5 py-0.5 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
                  title="Watch replay"
                  aria-label="Watch replay"
                >
                  &#9654;
                </button>
              )}
            </div>
          </div>
        </div>
        {/* Desktop metadata */}
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          <div className="flex gap-0.5">
            {getModDisplayList(score.mods).map((m) => (
              <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
            ))}
          </div>
          <span className={`text-xs ${accColorClass}`}>{formatAccuracy(getDisplayedAccuracy(score))}</span>
          <span className="text-sm font-bold">
            {formatPP(score.pp)}
            {approxPpGain != null && (
              <span
                className="ml-1 text-[11px] font-semibold text-osu-green"
                title="Estimated pp gain from replacing your previous best score on this map"
              >
                (+{formatNumber(Math.round(approxPpGain))})
              </span>
            )}
          </span>
          {scoreHasReplay(score) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                window.location.href = `/replay?scoreId=${score.id}&beatmapsetId=${score.beatmapset?.id}`;
              }}
              className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
              title="Watch replay"
            >
              &#9654; Watch
            </button>
          )}
          <span className="text-[10px] text-osu-f1 w-12 text-right">
            {formatTimeAgo(getScoreTimestamp(score))}
          </span>
        </div>
      </div>

      {/* Expanded score details */}
      {rendered && (
        <div
          className={`relative overflow-hidden px-4 pb-3 pt-1 border-t border-osu-b3/20 ${expanded ? "detail-enter" : "detail-exit"}`}
          onAnimationEnd={() => { if (!expanded) setRendered(false); }}
        >
              {(score.beatmapset?.covers?.["cover@2x"] || score.beatmapset?.covers?.cover) && (
                <div
                  className="absolute inset-0 opacity-[0.07] bg-cover bg-center pointer-events-none"
                  style={{ backgroundImage: `url(${score.beatmapset.covers["cover@2x"] || score.beatmapset.covers.cover})` }}
                />
              )}
              <div className="relative grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-center">
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
              <div className="relative mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-osu-f1">
                  Played on: <span className={lazer ? "text-osu-pink-light" : "text-osu-l2"}>{lazer ? "Lazer" : "Stable"}</span>
                </span>
                {scoreUrl ? (
                  <a
                    href={scoreUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-osu-f1 hover:text-osu-pink-light underline-offset-2 hover:underline transition-colors"
                  >
                    View on osu! →
                  </a>
                ) : <span />}
              </div>
        </div>
      )}
    </div>
  );
});

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}
