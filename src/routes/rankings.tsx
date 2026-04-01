import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { getRankings } from "../lib/osu";
import { formatNumber, formatAccuracy } from "../lib/format";
import { Avatar } from "../components/ui/Avatar";
import { RankingRowSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import type { RankingsResponse } from "../lib/types";

export const Route = createFileRoute("/rankings")({
  component: RankingsPage,
});

function RankingsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof getRankings>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't load the Costa Rica rankings right now.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1200px] mx-auto px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/images/icons/rankings.svg" alt="" width={28} height={28} className="opacity-60" />
            <h2 className="text-[15px] font-medium text-osu-c2">Costa Rica mania top 50</h2>
            <span className="mode-icon text-osu-pink ml-1">{"\ue802"}</span>
          </div>
          <span className="text-[10px] text-osu-f1">
            {data ? `${formatNumber(data.total)} ranked players` : "Loading rankings..."}
          </span>
        </div>
      </div>

      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-5">
          <div className="rounded-xl overflow-hidden border border-osu-b3/30">
            <table className="w-full">
              <thead>
                <tr className="bg-osu-b4 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
                  <th className="py-2.5 px-3 text-left w-12">#</th>
                  <th className="py-2.5 px-3 text-left">Player</th>
                  <th className="py-2.5 px-3 text-right">Accuracy</th>
                  <th className="py-2.5 px-3 text-right">Play Count</th>
                  <th className="py-2.5 px-3 text-right">PP</th>
                  <th className="py-2.5 px-3 text-center w-12">
                    <img src="/images/badges/score-ranks-v2019/GradeSmall-SS.svg" alt="SS" width={22} height={22} className="inline" />
                  </th>
                  <th className="py-2.5 px-3 text-center w-12">
                    <img src="/images/badges/score-ranks-v2019/GradeSmall-S.svg" alt="S" width={22} height={22} className="inline" />
                  </th>
                  <th className="py-2.5 px-3 text-center w-12">
                    <img src="/images/badges/score-ranks-v2019/GradeSmall-A.svg" alt="A" width={22} height={22} className="inline" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {error ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-osu-f1">
                      {error}
                    </td>
                  </tr>
                ) : data ? (
                  data.ranking.slice(0, 50).map((entry: RankingsResponse["ranking"][number], i: number) => (
                    <motion.tr
                      key={entry.user.id}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.12, delay: i * 0.015 }}
                      className="border-t border-osu-b3/20 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
                      style={{ background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent" }}
                      onClick={() =>
                        navigate({ to: "/player/$username", params: { username: entry.user.username } })
                      }
                    >
                      <td className="py-2.5 px-3 text-sm font-bold text-osu-f1">#{i + 1}</td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-3">
                          <Avatar url={entry.user.avatar_url} size={30} />
                          <span className="text-sm font-medium text-white">{entry.user.username}</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-sm text-osu-l2 text-right">{formatAccuracy(entry.hit_accuracy / 100)}</td>
                      <td className="py-2.5 px-3 text-sm text-osu-f1 text-right">{formatNumber(entry.play_count)}</td>
                      <td className="py-2.5 px-3 text-sm font-bold text-right">{formatNumber(Math.round(entry.pp))}</td>
                      <td className="py-2.5 px-3 text-xs text-osu-f1 text-center">{entry.grade_counts.ss + entry.grade_counts.ssh}</td>
                      <td className="py-2.5 px-3 text-xs text-osu-f1 text-center">{entry.grade_counts.s + entry.grade_counts.sh}</td>
                      <td className="py-2.5 px-3 text-xs text-osu-f1 text-center">{entry.grade_counts.a}</td>
                    </motion.tr>
                  ))
                ) : (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-t border-osu-b3/20">
                      <td colSpan={8} className="px-3 py-1.5">
                        <div className="hidden sm:block">
                          <RankingRowSkeleton />
                        </div>
                        <div className="sm:hidden space-y-2 rounded-lg bg-osu-b4/50 p-3">
                          <div className="flex items-center gap-3">
                            <Skeleton className="w-8 h-4" />
                            <Skeleton className="w-8 h-8 rounded-full" />
                            <Skeleton className="h-4 flex-1" />
                          </div>
                          <div className="flex gap-2">
                            <Skeleton className="h-3 flex-1" />
                            <Skeleton className="h-3 w-14" />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
