import { createContext, useContext, useEffect, useRef, useState } from "react";
import { prefetchLiveMapSearchEntry } from "../../lib/live-backend";

/*
 * Chart rows shared by the Prism article and its Updates tab: a cover and
 * title that open the chart's map info, and a labelled rating.
 */

// Sets with no list cover on osu!.
const FALLBACK_COVER = "/images/headers/generic.jpg";

function coverUrl(beatmapsetId: number): string {
  return `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list.jpg`;
}

function Cover({ beatmapsetId }: { beatmapsetId: number }) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  // A cover that 404s during the server render fails before onError is attached.
  useEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  return (
    <img
      ref={ref}
      src={failed ? FALLBACK_COVER : coverUrl(beatmapsetId)}
      alt=""
      width={48}
      height={48}
      onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded object-cover"
    />
  );
}

/** Opens a chart's map info over the article. */
export const OpenChartContext = createContext<(beatmapId: number) => void>(() => {});

export function ChartTitle({ chart }: { chart: { beatmapId: number; beatmapsetId: number; title: string; version: string } }) {
  const openChart = useContext(OpenChartContext);
  return (
    <button
      type="button"
      onClick={() => openChart(chart.beatmapId)}
      onPointerEnter={() => prefetchLiveMapSearchEntry(chart.beatmapId)}
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 text-left transition hover:brightness-110"
    >
      <Cover beatmapsetId={chart.beatmapsetId} />
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold text-white">{chart.title}</div>
        <div className="truncate text-[12px] text-osu-f1">{chart.version}</div>
      </div>
    </button>
  );
}

export function Rating({ engine, value, strong }: { engine: string; value: string; strong?: boolean }) {
  return (
    <div className="w-[68px] shrink-0 text-right">
      <div className="text-[11px] text-osu-f1">{engine}</div>
      <div className={strong ? "text-[20px] font-semibold tabular-nums text-white" : "text-[20px] tabular-nums text-osu-f1"}>{value}</div>
    </div>
  );
}

