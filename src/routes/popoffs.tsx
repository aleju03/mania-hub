import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getRankings, getUserScoresBest } from "../lib/osu";
import { formatNumber, formatAccuracy, formatTimeAgo } from "../lib/format";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import type { OsuScore, RankingsResponse } from "../lib/types";

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
  const [players, setPlayers] = useState<PopOff["user"][]>([]);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [popoffs, setPopoffs] = useState<PopOff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedCount, setLoadedCount] = useState(0);
  const [range, setRange] = useState<TimeRange>("7d");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((rankings) => {
        if (cancelled) return;

        setPlayers(
          rankings.ranking.slice(0, 30).map((entry: RankingsResponse["ranking"][number]) => ({
            id: entry.user.id,
            username: entry.user.username,
            avatar_url: entry.user.avatar_url,
          })),
        );
        setPlayersError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setPlayersError("Couldn't load the player list for pop-offs.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPlayers(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Progressively fetch scores for each player
  const fetchAll = useCallback(async () => {
    if (players.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setPopoffs([]);
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
              const age = Date.now() - new Date(s.created_at).getTime();
              return age < RANGE_MS["30d"] && s.pp && s.pp > 0;
            })
            .map((s: OsuScore) => ({
              user: player,
              score: s,
              pp: s.pp ?? 0,
              weightedPP: s.weight?.pp ?? 0,
              time: s.created_at,
            }));
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") all.push(...r.value);
      }

      // Sort and update progressively
      all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      setPopoffs([...all]);
      setLoadedCount(Math.min(i + 5, players.length));
    }

    setLoading(false);
  }, [players]);

  useEffect(() => {
    if (loadingPlayers || playersError) return;
    fetchAll();
  }, [fetchAll, loadingPlayers, playersError]);

  // Filter by time range
  const filtered = popoffs.filter((p) => {
    const age = Date.now() - new Date(p.time).getTime();
    return age < RANGE_MS[range];
  });

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
      {/* Header */}
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1200px] mx-auto px-5 py-3 flex items-center gap-3">
          <img src="/images/icons/rankings.svg" alt="" width={28} height={28} className="opacity-60" />
          <h2 className="text-[15px] font-medium text-osu-c2">CR mania pop-offs</h2>
          <span className="mode-icon text-osu-pink ml-1">{"\ue802"}</span>
          <div className="ml-auto flex items-center gap-2">
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
        </div>
      </div>

      {/* Time range filter */}
      <div className="bg-osu-d5 border-b border-osu-b3/30">
        <div className="max-w-[1200px] mx-auto px-5 flex">
          {ranges.map((r) => (
            <button
              key={r.id}
              onClick={() => { setRange(r.id); setPage(0); }}
              className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 ${
                range === r.id
                  ? "text-osu-c1 border-osu-h1"
                  : "text-osu-f1 border-transparent hover:text-osu-l2"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-6">
          {playersError && (
            <div className="text-center py-16 text-osu-f1 text-sm">
              {playersError}
            </div>
          )}

          {/* Loading skeletons on initial load */}
          {!playersError && (loadingPlayers || (loading && popoffs.length === 0)) && (
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
                      {p.score.replay && (
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
