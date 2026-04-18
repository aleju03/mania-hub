import { useEffect, useState } from "react";
import { getOsuRateStats } from "../../lib/api";

type Stats = {
  perMin: number;
  remaining: number | null;
  limit: number | null;
  updatedAgoMs: number | null;
};

export function DevRateLimitBadge() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = (await getOsuRateStats()) as Stats;
        if (!cancelled) setStats(res);
      } catch {
        // ignore; dev HUD is best-effort
      }
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!stats) return null;

  const { perMin, remaining, limit } = stats;
  const cap = limit ?? 1200;
  const low = remaining != null && remaining < cap * 0.2;
  const hot = perMin >= 60;

  const leftText = remaining != null ? `${remaining}/${cap}` : "-/-";
  const ageText =
    stats.updatedAgoMs != null ? `${Math.round(stats.updatedAgoMs / 1000)}s ago` : "idle";

  return (
    <div
      className={`fixed bottom-3 left-3 z-50 rounded-md px-2.5 py-1.5 font-mono text-[10px] leading-tight shadow-lg backdrop-blur-sm pointer-events-none select-none ${
        low ? "bg-red-900/80 text-red-100" : "bg-black/70 text-white/80"
      }`}
      title={`osu! API rate-limit tracker (dev only) · last header ${ageText}`}
    >
      <div>
        osu: <span className="text-white">{leftText}</span> left
      </div>
      <div className={hot ? "text-yellow-300" : ""}>{perMin}/min</div>
    </div>
  );
}
