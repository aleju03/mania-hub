import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getRankings, getUserScoresBestWindow } from "../lib/osu";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { formatNumber, formatAccuracy, formatTimeAgo } from "../lib/format";
import { calculateApproxPpGainMap, getBeatmapUrl, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getModAcronyms, getScoreTimeMs, getScoreTimestamp, getScoreUrl, isLazerScore, scoreHasReplay } from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";
import { PageTabs } from "../components/layout/PageTabs";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { LazerBadge } from "../components/ui/LazerBadge";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { UsernameText } from "../components/ui/UsernameText";
import { Pagination } from "../components/ui/Pagination";
import type { OsuScore, RankingsResponse } from "../lib/types";
import { useAppStore } from "../store";

interface PopOff {
  user: { id: number; username: string; avatar_url: string };
  score: OsuScore;
  pp: number;
  weightedPP: number;
  ppGain: number;
  time: string;
}

type TimeRange = "24h" | "3d" | "7d" | "30d";
type SortMode = "recent" | "pp";
const RANGE_MS: Record<TimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const PAGE_SIZE = 15;

export const Route = createFileRoute("/top-plays")({
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
  const [loadedCount, setLoadedCount] = useState(0);
  const [range, setRange] = useState<TimeRange>("7d");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const players = useMemo(() =>
    rankings?.ranking.slice(0, 30).map((entry: RankingsResponse["ranking"][number]) => ({
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
    })) ?? []
  , [rankings]);

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
        setPlayersError("Couldn't load the player list for top plays.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPlayers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rankings, rankingsFetchedAt, setCrRankings]);

  // Fetch scores for all players, show results once complete
  const fetchingRef = useRef(false);
  const fetchAll = useCallback(async () => {
    if (players.length === 0 || fetchingRef.current) {
      if (players.length === 0) setLoading(false);
      return;
    }

    const hasCachedPopoffs = popoffs.length > 0;
    const shouldRefresh = !hasCachedPopoffs || isCacheStale(popoffsFetchedAt, CLIENT_CACHE_TTL.popoffs);

    if (!shouldRefresh) {
      setLoadedCount(players.length);
      setLoading(false);
      return;
    }

    fetchingRef.current = true;
    setLoading(!hasCachedPopoffs);
    setLoadedCount(0);
    setPage(0);

    const all: PopOff[] = [];

    for (let i = 0; i < players.length; i += 5) {
      const batch = players.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (player: { id: number; username: string; avatar_url: string }) => {
          const scores = await getUserScoresBestWindow({ data: { userId: player.id, totalLimit: 200 } });
          const gainMap = calculateApproxPpGainMap(scores);
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
              ppGain: gainMap[s.id] ?? 0,
              time: getScoreTimestamp(s),
            }));
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") all.push(...r.value);
      }

      setLoadedCount(Math.min(i + 5, players.length));
    }

    setCachedPopoffs([...all]);
    setLoading(false);
    fetchingRef.current = false;
  }, [players, popoffs.length, popoffsFetchedAt, setCachedPopoffs]);

  useEffect(() => {
    if (loadingPlayers || playersError) return;
    fetchAll();
  }, [fetchAll, loadingPlayers, playersError]);

  // Filter by time range
  const filtered = useMemo(() => {
    const withinRange = popoffs.filter((popoff) => {
      const age = Date.now() - new Date(popoff.time).getTime();
      return age < RANGE_MS[range];
    });

    return [...withinRange].sort((a, b) => {
      if (sortMode === "pp") {
        if (b.pp !== a.pp) return b.pp - a.pp;
      }

      return new Date(b.time).getTime() - new Date(a.time).getTime();
    });
  }, [popoffs, range, sortMode]);

  const playerPpGains = useMemo(() => {
    const byUser = new Map<number, { username: string; avatar_url: string; totalGain: number }>();
    for (const p of filtered) {
      if (!p.ppGain) continue;
      const existing = byUser.get(p.user.id);
      if (existing) {
        existing.totalGain += p.ppGain;
      } else {
        byUser.set(p.user.id, {
          username: p.user.username,
          avatar_url: p.user.avatar_url,
          totalGain: p.ppGain,
        });
      }
    }
    return [...byUser.entries()]
      .filter(([, info]) => Math.round(info.totalGain) > 0)
      .sort((a, b) => b[1].totalGain - a[1].totalGain)
      .map(([id, info]) => ({ id, ...info }));
  }, [filtered]);

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
        title="CR mania top plays"
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
                {filtered.length} top plays found
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

      <div className="bg-osu-d5 border-b border-osu-b3/20">
        <div className="max-w-[1200px] mx-auto px-5 py-2 flex items-center justify-end gap-2">
          <button
            onClick={() => {
              setSortMode("recent");
              setPage(0);
            }}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
              sortMode === "recent"
                ? "bg-osu-pink/15 text-osu-pink-light"
                : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3"
            }`}
          >
            Most Recent
          </button>
          <button
            onClick={() => {
              setSortMode("pp");
              setPage(0);
            }}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
              sortMode === "pp"
                ? "bg-osu-pink/15 text-osu-pink-light"
                : "bg-osu-b4 text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3"
            }`}
          >
            Highest PP
          </button>
        </div>
      </div>

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-6 flex flex-col lg:flex-row gap-4 lg:gap-5">
          {playerPpGains.length > 0 && (
            <>
              {/* Mobile: horizontal row */}
              <div className="lg:hidden flex items-start gap-3 overflow-x-auto scrollbar-hide py-1">
                <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold flex-shrink-0 pt-2">PP Gained</span>
                {playerPpGains.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => navigate({ to: "/player/$username", params: { username: player.username } })}
                    className="cursor-pointer group relative flex-shrink-0 flex flex-col items-center gap-0.5"
                    title={`${player.username}: +${formatNumber(Math.round(player.totalGain))}pp`}
                  >
                    <div className="ring-2 ring-inset ring-osu-pink/40 rounded-full group-hover:ring-osu-pink transition-all">
                      <Avatar url={player.avatar_url} size={32} />
                    </div>
                    <span className="text-[9px] font-semibold text-osu-green">
                      +{formatNumber(Math.round(player.totalGain))}
                    </span>
                  </button>
                ))}
              </div>
              {/* Desktop: vertical sidebar */}
              <div className="hidden lg:flex flex-shrink-0 pt-1 gap-3">
                {(() => {
                  const maxPerCol = 8;
                  const numCols = Math.ceil(playerPpGains.length / maxPerCol);
                  const perCol = Math.ceil(playerPpGains.length / numCols);
                  const cols: typeof playerPpGains[] = [];
                  for (let i = 0; i < playerPpGains.length; i += perCol) {
                    cols.push(playerPpGains.slice(i, i + perCol));
                  }
                  return cols.map((col, ci) => (
                    <div key={ci} className="flex flex-col items-center gap-2">
                      {ci === 0 && (
                        <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-1">PP Gained</span>
                      )}
                      {ci > 0 && <div className="mb-1 h-[14px]" />}
                      {col.map((player) => (
                        <button
                          key={player.id}
                          onClick={() => navigate({ to: "/player/$username", params: { username: player.username } })}
                          className="cursor-pointer group relative flex flex-col items-center gap-0.5"
                          title={`${player.username}: +${formatNumber(Math.round(player.totalGain))}pp`}
                        >
                          <div className="ring-2 ring-osu-pink/40 rounded-full group-hover:ring-osu-pink transition-all">
                            <Avatar url={player.avatar_url} size={32} />
                          </div>
                          <span className="text-[9px] font-semibold text-osu-green">
                            +{formatNumber(Math.round(player.totalGain))}
                          </span>
                        </button>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            </>
          )}
          <div className="flex-1 min-w-0">
          {playersError && (
            <div className="text-center py-16 text-osu-f1 text-sm">
              {playersError}
            </div>
          )}

          {/* Loading skeletons on initial load */}
          {!playersError && (loadingPlayers || loading) && (
            <div className="space-y-2">
              {!loadingPlayers && players.length > 0 && (
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1 h-1 rounded-full bg-osu-b3/40 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-osu-pink transition-all duration-500 ease-out"
                      style={{ width: `${Math.round((loadedCount / players.length) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[11px] text-osu-f1 tabular-nums flex-shrink-0">
                    {loadedCount}/{players.length} players
                  </span>
                </div>
              )}
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
              <AnimatePresence initial={false}>
                {paginated.map((p: PopOff) => (
                  <motion.div
                    key={`${p.user.id}-${p.score.id}`}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="rounded-xl bg-osu-b4 border border-osu-b3/20 overflow-hidden"
                  >
                    <div
                      className="flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4 hover:bg-osu-b3 transition-colors duration-[120ms] cursor-pointer"
                      onClick={() => setExpandedId(expandedId === p.score.id ? null : p.score.id)}
                    >
                      <div className="flex-shrink-0 w-12 sm:w-16 text-center">
                        <div className="text-base sm:text-lg font-bold text-osu-pink" style={{ fontFamily: "Torus" }}>
                          {Math.round(p.pp)}
                        </div>
                        <div className="text-[8px] uppercase tracking-wider text-osu-f1 font-semibold">pp</div>
                        {p.ppGain > 0 && (
                          <div
                            className="text-[10px] font-semibold text-osu-green"
                            title="Approximate pp gain from this play"
                          >
                            +{formatNumber(Math.round(p.ppGain))}
                          </div>
                        )}
                      </div>

                      <GradeImg grade={getDisplayedRank(p.score)} size={30} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate({ to: "/player/$username", params: { username: p.user.username } });
                        }}
                        className="cursor-pointer"
                        title={`Open ${p.user.username}'s profile`}
                      >
                        <Avatar url={p.user.avatar_url} size={36} />
                      </button>

                      <div className="flex-1 min-w-0">
                        {/* Row 1: Username + time (mobile) */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate({ to: "/player/$username", params: { username: p.user.username } });
                              }}
                              className="cursor-pointer"
                            >
                              <UsernameText
                                username={p.user.username}
                                avatarUrl={p.user.avatar_url}
                                className="text-sm font-semibold"
                              />
                            </button>
                          </div>
                          <span className="text-[10px] text-osu-f1 flex-shrink-0 sm:hidden">{formatTimeAgo(p.time)}</span>
                        </div>
                        {/* Row 2: Beatmap title */}
                        <div className="flex items-center gap-2 mt-0.5">
                          {getBeatmapUrl(p.score) ? (
                            <a
                              href={getBeatmapUrl(p.score)!}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs text-osu-l2 truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                              title="Open beatmap on osu!"
                            >
                              {p.score.beatmapset?.title}
                            </a>
                          ) : (
                            <span className="text-xs text-osu-l2 truncate">
                              {p.score.beatmapset?.title}
                            </span>
                          )}
                          <span className="text-[10px] text-osu-f1 truncate">
                            [{p.score.beatmap?.version}]
                          </span>
                        </div>
                        {/* Row 3 (mobile): Mods left, accuracy right */}
                        <div className="flex items-center justify-between gap-2 mt-1 sm:hidden">
                          <div className="flex items-center gap-1">
                            {getModAcronyms(p.score.mods).map((acronym) => (
                              <ModBadge key={acronym} mod={acronym} />
                            ))}
                            {isLazerScore(p.score) && <LazerBadge />}
                          </div>
                          <span className="text-xs text-osu-l2 flex-shrink-0">{formatAccuracy(getDisplayedAccuracy(p.score))}</span>
                        </div>
                      </div>

                      {/* Desktop metadata */}
                      <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
                        <div className="flex gap-0.5">
                          {getModAcronyms(p.score.mods).map((acronym) => (
                            <ModBadge key={acronym} mod={acronym} />
                          ))}
                        </div>
                        {isLazerScore(p.score) && (
                          <LazerBadge />
                        )}
                        <span className="text-xs text-osu-l2">
                          {formatAccuracy(getDisplayedAccuracy(p.score))}
                        </span>
                        <span className="text-xs text-osu-f1">
                          {formatNumber(p.score.max_combo)}x
                        </span>
                        {scoreHasReplay(p.score) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              window.location.href = `/replay?scoreId=${p.score.id}&mode=mania&beatmapsetId=${p.score.beatmapset?.id}`;
                            }}
                            className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold hover:bg-osu-pink/30 transition-colors cursor-pointer"
                          >
                            ▶ Replay
                          </button>
                        )}
                        <span className="text-[10px] text-osu-f1 w-14 text-right">
                          {formatTimeAgo(p.time)}
                        </span>
                      </div>
                    </div>

                    <ExpandableDetail expanded={expandedId === p.score.id}>
                      <div className="px-4 pb-3 pt-1 border-t border-osu-b3/20">
                            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-center">
                              <StatCell label="Score" value={getDisplayedTotalScore(p.score) != null ? formatNumber(getDisplayedTotalScore(p.score)!) : "-"} />
                              <StatCell label="Combo" value={`${formatNumber(p.score.max_combo)}x`} />
                              <StatCell label="MAX" value={formatNumber(p.score.statistics.count_geki ?? p.score.statistics.perfect ?? 0)} color="text-osu-blue" />
                              <StatCell label="300" value={formatNumber(p.score.statistics.count_300 ?? p.score.statistics.great ?? 0)} color="text-osu-yellow" />
                              <StatCell label="200" value={formatNumber(p.score.statistics.count_katu ?? p.score.statistics.good ?? 0)} color="text-osu-green" />
                              <StatCell label="100" value={formatNumber(p.score.statistics.count_100 ?? p.score.statistics.ok ?? 0)} color="text-osu-purple" />
                              <StatCell label="50" value={formatNumber(p.score.statistics.count_50 ?? p.score.statistics.meh ?? 0)} color="text-osu-orange" />
                              <StatCell label="Miss" value={formatNumber(p.score.statistics.count_miss ?? p.score.statistics.miss ?? 0)} color="text-osu-red" />
                              <StatCell label="PP" value={`${Math.round(p.pp)}pp`} color="text-osu-pink" />
                              {p.score.beatmap?.difficulty_rating != null && (
                                <StatCell label="Stars" value={p.score.beatmap.difficulty_rating.toFixed(2)} />
                              )}
                              {p.score.beatmap?.bpm != null && (
                                <StatCell label="BPM" value={String(Math.round(p.score.beatmap.bpm))} />
                              )}
                              {p.score.max_combo > 0 && p.score.beatmap?.max_combo && p.score.beatmap.max_combo > 0 && (
                                <StatCell label="Combo %" value={`${Math.round((p.score.max_combo / p.score.beatmap.max_combo) * 100)}%`} />
                              )}
                            </div>
                            {getScoreUrl(p.score) && (
                              <div className="mt-2 text-right">
                                <a
                                  href={getScoreUrl(p.score)!}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[10px] text-osu-f1 hover:text-osu-pink-light underline-offset-2 hover:underline transition-colors"
                                >
                                  View on osu! →
                                </a>
                              </div>
                            )}
                      </div>
                    </ExpandableDetail>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}

          {!playersError && !loadingPlayers && !loading && filtered.length === 0 && (
            <div className="text-center py-16 text-osu-f1 text-sm">
              No top plays in this time range
            </div>
          )}

          {/* Pagination */}
          {!playersError && (
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExpandableDetail({ expanded, children }: { expanded: boolean; children: React.ReactNode }) {
  const [rendered, setRendered] = useState(expanded);
  useEffect(() => { if (expanded) setRendered(true); }, [expanded]);
  if (!rendered) return null;
  return (
    <div
      className={expanded ? "detail-enter" : "detail-exit"}
      onAnimationEnd={() => { if (!expanded) setRendered(false); }}
    >
      {children}
    </div>
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
