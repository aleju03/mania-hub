import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getRankings, getCountryRecentScores } from "../lib/osu";
import { formatAccuracy, formatTimeAgo, formatPP } from "../lib/format";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { ScoreRowSkeleton } from "../components/ui/LoadingSkeleton";
import { useAppStore } from "../store";
import type { OsuScore } from "../lib/types";

export const Route = createFileRoute("/scores")({
  component: ScoresPage,
});

type ScoreFilter = "all" | "ranked" | "passed" | "failed";

function ScoresPage() {
  const { feedScores, addFeedScores, setTrackedUserIds, pollIndex, nextPollIndex } = useAppStore();
  const [userIds, setUserIds] = useState<number[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [filter, setFilter] = useState<ScoreFilter>("all");
  const [initialLoaded, setInitialLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((rankings) => {
        if (cancelled) return;

        const ids = rankings.ranking.map((entry: { user: { id: number } }) => entry.user.id);
        setUserIds(ids);
        setTrackedUserIds(ids);
        setPlayersError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setPlayersError("Couldn't load the tracked player pool.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPlayers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [setTrackedUserIds]);

  // Initial fetch client-side (non-blocking)
  useEffect(() => {
    if (!initialLoaded && userIds.length > 0) {
      getCountryRecentScores({ data: { userIds, batchSize: 15, batchIndex: 0 } })
        .then((scores) => { if (scores.length > 0) addFeedScores(scores); })
        .finally(() => setInitialLoaded(true));
    }
  }, [userIds, initialLoaded, addFeedScores]);

  const poll = useCallback(async () => {
    if (!isPolling || userIds.length === 0) return;
    try {
      const scores = await getCountryRecentScores({
        data: { userIds, batchSize: 5, batchIndex: pollIndex },
      });
      if (scores.length > 0) addFeedScores(scores);
      nextPollIndex();
    } catch { /* silently continue */ }
  }, [isPolling, userIds, pollIndex, addFeedScores, nextPollIndex]);

  useEffect(() => {
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [poll]);

  const filtered = feedScores.filter((s: OsuScore) => {
    switch (filter) {
      case "ranked": return s.pp != null && s.pp > 0;
      case "passed": return s.passed;
      case "failed": return !s.passed;
      default: return true;
    }
  });

  const filters: { id: ScoreFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ranked", label: "Ranked (PP)" },
    { id: "passed", label: "Passed" },
    { id: "failed", label: "Failed" },
  ];

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1200px] mx-auto px-5 py-3 flex items-center gap-3">
          <img src="/images/icons/news.svg" alt="" width={28} height={28} className="opacity-60" />
          <h2 className="text-[15px] font-medium text-osu-c2">CR mania scores</h2>
          <span className="mode-icon text-osu-pink ml-1">{"\ue802"}</span>
          <div className="ml-auto flex items-center gap-2">
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
        </div>
      </div>

      {/* Filters */}
      <div className="bg-osu-d5 border-b border-osu-b3/30">
        <div className="max-w-[1200px] mx-auto px-5 flex">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 ${
                filter === f.id
                  ? "text-osu-c1 border-osu-h1"
                  : "text-osu-f1 border-transparent hover:text-osu-l2"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-5">
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
              <AnimatePresence mode="popLayout">
                {filtered.map((score: OsuScore) => (
                  <ScoreFeedItem key={score.id} score={score} />
                ))}
              </AnimatePresence>
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
  );
}

function ScoreFeedItem({ score }: { score: OsuScore }) {
  const keys = score.beatmap?.cs;
  const navigate = useNavigate();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="flex items-center gap-3 py-3 px-4 mb-2 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors duration-[120ms] cursor-pointer border border-osu-b3/20"
      onClick={() => navigate({ to: "/player/$username", params: { username: score.user?.username } })}
    >
      <GradeImg grade={score.rank} size={32} />
      <Avatar url={score.user?.avatar_url} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-osu-blue">{score.user?.username}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-white truncate">{score.beatmapset?.title}</span>
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
        <span className="text-xs text-osu-l2">{formatAccuracy(score.accuracy)}</span>
        <span className="text-sm font-bold">{formatPP(score.pp)}</span>
        {score.replay && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.location.href = `/replay?scoreId=${score.id}&mode=mania`;
            }}
            className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors"
            title="Watch replay"
          >
            ▶ Replay
          </button>
        )}
        <span className="text-[10px] text-osu-f1 w-12 text-right">
          {formatTimeAgo(score.ended_at || score.created_at)}
        </span>
      </div>
    </motion.div>
  );
}
