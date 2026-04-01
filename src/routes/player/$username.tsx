import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { getUser, getUserScoresBest, getUserScoresRecent } from "../../lib/osu";
import {
  formatNumber,
  formatAccuracy,
  formatPlayTime,
  formatTimeAgo,
  formatDate,
  formatPP,
} from "../../lib/format";
import { getScoreTimestamp } from "../../lib/score";
import { Avatar } from "../../components/ui/Avatar";
import { GradeImg } from "../../components/ui/GradeImg";
import { ModBadge } from "../../components/ui/ModBadge";
import { ScoreRowSkeleton, Skeleton } from "../../components/ui/LoadingSkeleton";
import type { OsuScore, OsuUser } from "../../lib/types";

export const Route = createFileRoute("/player/$username")({
  component: PlayerPage,
});

function PlayerPage() {
  const { username } = Route.useParams();
  const [user, setUser] = useState<OsuUser | null>(null);
  const [best, setBest] = useState<OsuScore[]>([]);
  const [recent, setRecent] = useState<OsuScore[]>([]);
  const [loadingUser, setLoadingUser] = useState(true);
  const [loadingScores, setLoadingScores] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);
  const [scoresError, setScoresError] = useState<string | null>(null);
  const [tab, setTab] = useState<"best" | "recent">("best");

  useEffect(() => {
    let cancelled = false;

    setUser(null);
    setBest([]);
    setRecent([]);
    setTab("best");
    setUserError(null);
    setScoresError(null);
    setLoadingUser(true);
    setLoadingScores(true);

    getUser({ data: { key: username } })
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

    Promise.all([
      getUserScoresBest({ data: { userId: user.id, limit: 30 } }),
      getUserScoresRecent({ data: { userId: user.id, limit: 15, include_fails: true } }),
    ])
      .then(([bestScores, recentScores]) => {
        if (cancelled) return;
        setBest(bestScores);
        setRecent(recentScores);
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
  const visibleScores = tab === "best" ? best : recent;

  return (
    <div className="flex-1">
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
            <div className="w-[110px] h-[110px] rounded-2xl overflow-hidden border-2 border-osu-b3/60 shadow-[0_4px_20px_rgba(0,0,0,0.5)] translate-y-4 flex-shrink-0">
              <Avatar url={user.avatar_url} size={110} />
            </div>
            <div className="pb-1 flex-1 min-w-0">
              <h1
                className="text-3xl font-bold text-white truncate"
                style={{ textShadow: "0 2px 6px rgba(0,0,0,0.75)" }}
              >
                {user.username}
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
          <div className="mt-5 pt-1 border-t border-osu-b3/30 flex">
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
        </div>
      </div>

      {/* Scores list */}
      <div className="bg-osu-b5 border-t border-osu-b3/20">
        <div className="max-w-[1200px] mx-auto px-5 py-5 space-y-1.5">
          {loadingScores ? (
            Array.from({ length: 6 }).map((_, i) => (
              <ScoreRowSkeleton key={i} />
            ))
          ) : scoresError ? (
            <div className="text-center py-8 text-osu-f1 text-sm">{scoresError}</div>
          ) : visibleScores.length > 0 ? (
            visibleScores.map((s: OsuScore, i: number) => (
              <ScoreRow key={s.id} score={s} index={i} />
            ))
          ) : (
            <div className="text-center py-8 text-osu-f1 text-sm">No scores found</div>
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
      const y = h - ((v - min) / range) * (h - 4) - 2;
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

function ScoreRow({ score, index }: { score: OsuScore; index: number }) {
  const keys = score.beatmap?.cs;
  return (
    <motion.a
      href={`https://osu.ppy.sh/scores/${score.id}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms] cursor-pointer"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.12, delay: index * 0.025 }}
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
        <div className="flex gap-0.5">
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
    </motion.a>
  );
}
