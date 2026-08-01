import { useMemo, useState } from "react";
import { formatNumber } from "../../../lib/format";
import {
  buildAnalyticsTimelineTicks,
  formatAnalyticsRangeLabel,
  type AnalyticsMonitorData,
  type AnalyticsRange,
} from "../../../lib/analytics-monitor";

/* The strip at the top of the analytics tab: who is here this second, the
   totals behind them, and the shape of traffic across the range. */

function formatClock(ts: number, spanMs: number): string {
  const date = new Date(ts);
  // Anything past a day reads better as a date than as a time of day.
  if (spanMs > 36 * 60 * 60_000) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AnalyticsPulse({
  data,
  range,
  onlineCountries,
}: {
  data: AnalyticsMonitorData;
  range: AnalyticsRange;
  onlineCountries: number;
}) {
  const hint = formatAnalyticsRangeLabel(range).toLowerCase();
  const bouncePct = data.bounce.landers > 0
    ? Math.round((data.bounce.bounced / data.bounce.landers) * 100)
    : null;
  const timeline = data.timeline ?? [];
  const peak = useMemo(() => timeline.reduce((max, bucket) => Math.max(max, bucket.events), 0), [timeline]);
  const spanMs = (data.bucketMs || 0) * Math.max(1, timeline.length);
  const live = data.activeVisitors > 0;
  const [hovered, setHovered] = useState<number | null>(null);
  const startTs = timeline.length > 0 ? timeline[0].ts : 0;
  const ticks = useMemo(
    () => (timeline.length > 0 ? buildAnalyticsTimelineTicks(startTs, startTs + spanMs) : []),
    [timeline.length, startTs, spanMs],
  );
  const hoveredBucket = hovered != null ? timeline[hovered] : undefined;
  const bucketWidth = formatBucketWidth(data.bucketMs);

  return (
    <div className="rounded-xl border border-osu-b3/30 bg-gradient-to-b from-osu-b4/50 to-osu-b4/20 overflow-hidden">
      {/* Phones get a 2-up grid: five stacked full-width tiles pushed the feed
          most of a screen down. */}
      <div className="grid grid-cols-2 gap-px bg-osu-b3/20 sm:flex sm:flex-row">
        <div className={`col-span-2 flex items-center gap-3 px-4 py-3 sm:flex-1 ${live ? "bg-osu-pink/10" : "bg-osu-b4/40"}`}>
          <span className="relative flex h-3 w-3 flex-shrink-0" aria-hidden="true">
            <span className={`absolute inline-flex h-full w-full rounded-full ${live ? "bg-osu-pink" : "bg-osu-b2"}`} />
            {live ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-osu-pink opacity-60" /> : null}
          </span>
          <div className="min-w-0">
            <div className={`text-3xl font-bold leading-none ${live ? "text-osu-pink-light" : "text-osu-f1"}`}>
              {formatNumber(data.activeVisitors)}
            </div>
            <div className="mt-1 truncate text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
              here now
              {onlineCountries > 0 ? (
                <span className="ml-1.5 normal-case tracking-normal text-osu-l2/70">
                  from {onlineCountries} {onlineCountries === 1 ? "country" : "countries"}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <PulseStat label="Visitors" value={formatNumber(data.uniqueVisitorsInRange)} hint={hint} />
        <PulseStat label="Pageviews" value={formatNumber(data.pageviewsInRange)} hint={hint} />
        <PulseStat label="Events" value={formatNumber(data.eventsInRange)} hint={hint} />
        <PulseStat
          label="Bounce"
          value={bouncePct == null ? "—" : `${bouncePct}%`}
          hint={data.bounce.landers > 0
            ? `${formatNumber(data.bounce.bounced)} of ${formatNumber(data.bounce.landers)} landers`
            : `no landers ${hint}`}
        />
      </div>

      <div className="border-t border-osu-b3/20 px-4 pb-3 pt-2.5">
        {/* The legend rides with the title so the axis row underneath is nothing
            but clock labels. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[10px]">
          <span className="uppercase tracking-wider text-osu-f1 font-semibold">Traffic</span>
          <span className="flex items-center gap-2 text-osu-l2/70">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[1px] bg-osu-pink" />pageviews</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[1px] bg-osu-pink/35" />other events</span>
          </span>
          {/* Reading out the hovered bucket here beats waiting on a native
              tooltip, and it never covers the bars it describes. */}
          <span className={`ml-auto truncate ${hoveredBucket ? "text-osu-l2" : "text-osu-f1"}`}>
            {hoveredBucket
              ? `${formatClock(hoveredBucket.ts, spanMs)} · ${formatNumber(hoveredBucket.events)} events · ${formatNumber(hoveredBucket.pageviews)} pageviews · ${formatNumber(hoveredBucket.visitors)} visitor${hoveredBucket.visitors === 1 ? "" : "s"}`
              : peak > 0
                ? `peak ${formatNumber(peak)} events per ${bucketWidth}`
                : "no traffic in range"}
          </span>
        </div>
        <div className="relative mt-2 h-16" onMouseLeave={() => setHovered(null)}>
          <div className="flex h-full items-end gap-px" role="img" aria-label={`Traffic over the ${hint}`}>
            {timeline.map((bucket, index) => {
              const height = peak > 0 ? Math.max(bucket.events > 0 ? 4 : 1, Math.round((bucket.events / peak) * 100)) : 1;
              const pageviewShare = bucket.events > 0 ? Math.min(1, bucket.pageviews / bucket.events) : 0;
              return (
                <div
                  key={bucket.ts}
                  onMouseEnter={() => setHovered(index)}
                  className={`group relative h-full flex-1 rounded-sm transition-colors duration-[120ms] ${
                    hovered === index ? "bg-osu-b3/50" : "bg-osu-b3/25"
                  }`}
                  title={`${formatClock(bucket.ts, spanMs)} · ${formatNumber(bucket.events)} events · ${formatNumber(bucket.pageviews)} pageviews · ${formatNumber(bucket.visitors)} visitors`}
                >
                  <div
                    className="absolute inset-x-0 bottom-0 rounded-sm bg-osu-pink/35"
                    style={{ height: `${height}%` }}
                  >
                    <div
                      className="absolute inset-x-0 bottom-0 rounded-sm bg-osu-pink"
                      style={{ height: `${Math.round(pageviewShare * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {ticks.map((tick) => (
            <span
              key={tick.ts}
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 hidden w-px bg-white/10 sm:block"
              style={{ left: `${tick.position * 100}%` }}
            />
          ))}
        </div>
        {/* Ticks land on round clock times (:15, :30, the hour, midnight), so a
            spike can be placed without hovering it. */}
        <div className="relative mt-1.5 h-3 text-[9px] font-mono text-osu-f1">
          <span className="absolute left-0 top-0">{timeline.length > 0 ? formatClock(startTs, spanMs) : ""}</span>
          {ticks.map((tick) => (
            <span
              key={tick.ts}
              className="absolute top-0 hidden -translate-x-1/2 whitespace-nowrap sm:block"
              style={{ left: `${tick.position * 100}%` }}
            >
              {formatClock(tick.ts, spanMs)}
            </span>
          ))}
          <span className="absolute right-0 top-0">now</span>
        </div>
      </div>
    </div>
  );
}

function formatBucketWidth(bucketMs: number): string {
  const minutes = Math.round((bucketMs || 0) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function PulseStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col justify-center bg-osu-b4/40 px-4 py-2.5 sm:flex-1 sm:py-3">
      <div className="text-2xl font-bold leading-none text-white">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div className="mt-0.5 truncate text-[10px] text-osu-l2/60" title={hint}>{hint}</div>
    </div>
  );
}
