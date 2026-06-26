import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  fetchLiveFarmHelperFarmers,
  type LiveFarmHelperFarmer,
  type LiveFarmHelperKeyMode,
  type LiveFarmHelperSpeedBucket,
} from "../../lib/live-backend";
import { Avatar } from "../ui/Avatar";
import { ModBadge } from "../ui/ModBadge";
import { Skeleton } from "../ui/LoadingSkeleton";

const PAGE = 50;

// Ranked "who farms this map" list for a single beatmap, scoped to the subject's
// same-pp peer cohort. Shared by the farm-helper list modal and the map detail page.
// The full cohort (up to a few hundred) arrives in one fetch; rows are revealed a
// page at a time as the list scrolls, so the DOM stays light for popular maps.
export function FarmersList({
  userKey,
  beatmapId,
  speedBucket,
  keyMode,
  className = "",
}: {
  userKey: string;
  beatmapId: number;
  speedBucket?: LiveFarmHelperSpeedBucket;
  keyMode: LiveFarmHelperKeyMode;
  className?: string;
}) {
  const [farmers, setFarmers] = useState<LiveFarmHelperFarmer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setFarmers([]);
    setTotal(0);
    setQuery("");
    fetchLiveFarmHelperFarmers(userKey, beatmapId, speedBucket, { keyMode, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setFarmers(data.farmers);
        setTotal(data.total);
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [userKey, beatmapId, speedBucket, keyMode]);

  const q = query.trim().toLowerCase();
  const visible = q ? farmers.filter((farmer) => farmer.username.toLowerCase().includes(q)) : farmers;
  const displayed = visible.slice(0, visibleCount);
  const hasMore = visible.length > displayed.length;

  // Restart the reveal window whenever the data set or the search query changes.
  useEffect(() => {
    setVisibleCount(PAGE);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [farmers, q]);

  // Reveal the next page when the sentinel scrolls into view.
  useEffect(() => {
    if (!hasMore) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisibleCount((count) => count + PAGE);
      },
      { root, rootMargin: "160px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, displayed.length]);

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      {loading || total > 8 ? (
        <div className="shrink-0 px-3 pt-2.5">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search player..."
            disabled={loading}
            className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4 px-3 py-1.5 text-[11px] text-osu-c1 placeholder:text-osu-f1 transition-colors focus:border-osu-h1/40 focus:outline-none"
          />
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {loading ? (
          <div className="space-y-1.5">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-9 rounded-lg" />
            ))}
          </div>
        ) : failed ? (
          <div className="py-10 text-center text-sm text-osu-f1">Couldn't load the farmer list. Try again.</div>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center text-sm text-osu-f1">
            {q ? "No players match." : "No nearby players have farmed this yet."}
          </div>
        ) : (
          <div className="space-y-1">
            {displayed.map((farmer) => {
              const rank = farmers.findIndex((candidate) => candidate.userId === farmer.userId) + 1;
              const mods = farmer.mods ?? [];
              return (
                <Link
                  key={farmer.userId}
                  to="/player/$username"
                  params={{ username: farmer.username || String(farmer.userId) }}
                  className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-osu-b3/50"
                >
                  <span className="w-6 shrink-0 text-right text-[11px] font-semibold tabular-nums text-osu-f1">
                    #{rank}
                  </span>
                  <Avatar url={farmer.avatarUrl} userId={farmer.userId} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-osu-c1">
                    {farmer.username || `#${farmer.userId}`}
                  </span>
                  {mods.length ? (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {mods.map((mod) => (
                        <ModBadge key={mod} mod={mod} size={0.58} />
                      ))}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[11px] font-semibold tabular-nums text-osu-l2">
                    {Math.round(farmer.pp).toLocaleString("en-US")}pp
                  </span>
                </Link>
              );
            })}
            {hasMore ? <div ref={sentinelRef} className="h-1" aria-hidden="true" /> : null}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-osu-b3/30 px-3 py-2 text-[10px] text-osu-f1">
        {loading
          ? "loading..."
          : `${total.toLocaleString("en-US")} player${total === 1 ? "" : "s"} farmed this${
              farmers.length < total ? ` · top ${farmers.length.toLocaleString("en-US")} shown` : ""
            }`}
      </div>
    </div>
  );
}
