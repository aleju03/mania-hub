import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, BarChart3, Clock3, ExternalLink, Gauge, Keyboard, Music2, Target } from "lucide-react";
import { getBeatmapFile, getBeatmapsetForBeatmap } from "../../../lib/osu";
import { parseCachedManiaBeatmap } from "../../../lib/parsed-beatmap-cache";
import type { ManiaBeatmap } from "../../../lib/beatmap-parser";
import type { MapsFavouriteBeatmapset, OsuBeatmap, OsuBeatmapset } from "../../../lib/types";
import { detectManiaPatterns, MANIA_PATTERN_LABELS } from "../../../lib/mania-patterns";
import { formatDuration, formatNumber } from "../../../lib/format";
import { canUseDevFeatures } from "../../../lib/auth-shared";
import { PageHeader } from "../../../components/layout/PageHeader";
import { Skeleton } from "../../../components/ui/LoadingSkeleton";
import { ChartPreviewPanel } from "../../../components/maps/ChartPreviewPanel";
import type { LiveFarmHelperKeyMode, LiveFarmHelperReason, LiveFarmHelperSpeedBucket } from "../../../lib/live-backend";

type FarmMapContext = {
  userKey?: string;
  keyMode?: LiveFarmHelperKeyMode;
  speed?: LiveFarmHelperSpeedBucket;
  reason?: LiveFarmHelperReason;
  gain?: number;
  benchmark?: number;
  subjectPp?: number;
  peerCount?: number;
  peerSampleSize?: number;
  peerFraction?: number;
  median?: number;
  p75?: number;
  playedAt?: string;
};

type DetailBeatmap = MapsFavouriteBeatmapset["maniaBeatmaps"][number] & {
  accuracy?: number;
  drain?: number;
  bpm?: number;
  countCircles?: number;
  countSliders?: number;
  maxCombo?: number;
  status?: string;
  url?: string;
};

type DetailBeatmapset = Omit<MapsFavouriteBeatmapset, "maniaBeatmaps"> & {
  submittedDate?: string;
  rankedDate?: string | null;
  lastUpdated?: string;
  tags?: string;
  maniaBeatmaps: DetailBeatmap[];
};

type ParsedState =
  | { status: "idle"; beatmap: null; error: null }
  | { status: "loading"; beatmap: null; error: null }
  | { status: "ready"; beatmap: ManiaBeatmap; error: null }
  | { status: "failed"; beatmap: null; error: string };

const REASON_LABELS: Record<LiveFarmHelperReason, string> = {
  missing: "missing",
  improve: "improve",
  stale: "old pb",
};

const SPEED_LABELS: Record<LiveFarmHelperSpeedBucket, string> = {
  ht: "HT",
  normal: "NM",
  dt: "DT",
};

const FARM_MAP_CONTEXT_KEY_PREFIX = "mania-hub-farm-helper-map-context-v1:";

export const Route = createFileRoute("/farm-helper/map/$beatmapId")({
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) throw notFound();
  },
  head: () => ({
    meta: [
      { title: "Farm map detail - Mania Hub" },
      {
        name: "description",
        content: "osu!mania farm map detail with difficulty metrics, radar chart, density timeline, and chart preview.",
      },
    ],
  }),
  component: FarmMapDetailPage,
});

function FarmMapDetailPage() {
  const { beatmapId: beatmapIdRaw } = Route.useParams();
  const navigate = useNavigate();
  const beatmapId = Number.parseInt(beatmapIdRaw, 10);
  const [beatmapset, setBeatmapset] = useState<DetailBeatmapset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBeatmapId, setSelectedBeatmapId] = useState<number | null>(Number.isFinite(beatmapId) ? beatmapId : null);
  const [parsedState, setParsedState] = useState<ParsedState>({ status: "idle", beatmap: null, error: null });
  const [farmContext, setFarmContext] = useState<FarmMapContext | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.location.search) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.hash}`);
  }, []);

  useEffect(() => {
    setFarmContext(readStoredFarmContext(beatmapId));
  }, [beatmapId]);

  useEffect(() => {
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) {
      setLoading(false);
      setError("Invalid beatmap id.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    getBeatmapsetForBeatmap({ data: { beatmapId } })
      .then((data) => {
        if (cancelled) return;
        const detail = normalizeBeatmapset(data);
        setBeatmapset(detail);
        const selected = detail.maniaBeatmaps.find((map) => map.id === beatmapId) ?? detail.maniaBeatmaps[0] ?? null;
        setSelectedBeatmapId(selected?.id ?? beatmapId);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this beatmapset.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [beatmapId]);

  const selectedBeatmap = beatmapset?.maniaBeatmaps.find((map) => map.id === selectedBeatmapId) ?? beatmapset?.maniaBeatmaps[0] ?? null;
  const selectedBeatmapsetId = selectedBeatmap?.beatmapsetId ?? beatmapset?.id;

  useEffect(() => {
    if (!selectedBeatmap || !selectedBeatmapsetId) {
      setParsedState({ status: "idle", beatmap: null, error: null });
      return;
    }

    let cancelled = false;
    setParsedState({ status: "loading", beatmap: null, error: null });
    getBeatmapFile({ data: { beatmapId: selectedBeatmap.id, beatmapsetId: selectedBeatmapsetId } })
      .then((result) => {
        if (cancelled) return;
        const parsed = parseCachedManiaBeatmap(selectedBeatmap.id, result.content);
        setParsedState({ status: "ready", beatmap: parsed, error: null });
      })
      .catch(() => {
        if (!cancelled) setParsedState({ status: "failed", beatmap: null, error: "Couldn't read chart data." });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBeatmap, selectedBeatmapsetId]);

  const metrics = useMemo(
    () => buildMapMetrics(selectedBeatmap, parsedState.beatmap),
    [parsedState.beatmap, selectedBeatmap],
  );
  const osuUrl = selectedBeatmap?.url ?? (beatmapset ? `https://osu.ppy.sh/beatmapsets/${beatmapset.id}#mania/${selectedBeatmapId ?? beatmapId}` : `https://osu.ppy.sh/beatmaps/${beatmapId}`);
  const coverUrl = beatmapset?.covers["cover@2x"] ?? beatmapset?.covers.cover ?? beatmapset?.covers.card ?? "";
  const cardUrl = beatmapset?.covers.card ?? beatmapset?.covers.list ?? coverUrl;

  return (
    <div className="relative flex min-h-screen flex-col bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title="Farm map detail"
        right={
          <button
            type="button"
            onClick={() => {
              if (typeof window !== "undefined" && window.history.length > 1) {
                window.history.back();
              } else {
                void navigate({ to: "/farm-helper" });
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-osu-b4 px-2.5 py-1.5 text-[11px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>farm helper</span>
          </button>
        }
      />

      <main className="mx-auto w-full max-w-[1280px] px-4 py-5 sm:px-5">
        {loading ? (
          <DetailSkeleton />
        ) : error ? (
          <div className="mx-auto max-w-md py-16 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1">map unavailable</div>
            <h2 className="mt-1 text-lg font-bold text-osu-c1">{error}</h2>
          </div>
        ) : beatmapset && selectedBeatmap ? (
          <div className="space-y-4">
            <section className="relative overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4">
              {coverUrl ? (
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-20"
                  style={{ backgroundImage: `url("${coverUrl.replace(/"/g, '\\"')}")` }}
                  aria-hidden="true"
                />
              ) : null}
              <div className="absolute inset-0 bg-gradient-to-r from-osu-b4 via-osu-b4/88 to-osu-b4/70" aria-hidden="true" />
              <div className="relative grid gap-4 p-4 md:grid-cols-[160px_minmax(0,1fr)_220px] md:p-5">
                <div className="h-28 overflow-hidden rounded-lg bg-osu-b6 md:h-40">
                  {cardUrl ? <img src={cardUrl} alt="" className="h-full w-full object-cover" /> : null}
                </div>
                <div className="min-w-0 self-end">
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={selectedBeatmap.status ?? beatmapset.status} />
                    {farmContext?.reason ? <ContextBadge>{REASON_LABELS[farmContext.reason]}</ContextBadge> : null}
                    {farmContext?.speed ? <ContextBadge>{SPEED_LABELS[farmContext.speed]}</ContextBadge> : null}
                    {farmContext?.keyMode ? <ContextBadge>{farmContext.keyMode.toUpperCase()}</ContextBadge> : null}
                  </div>
                  <h1 className="truncate text-2xl font-black text-osu-c1 sm:text-3xl">
                    {beatmapset.title}
                  </h1>
                  <div className="mt-1 truncate text-sm font-medium text-osu-f1">
                    {beatmapset.artist} / mapped by {beatmapset.creator}
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-osu-f1">
                    <span className="truncate font-semibold text-osu-l2">[{selectedBeatmap.version}]</span>
                    <span className="tabular-nums text-osu-yellow">{selectedBeatmap.difficultyRating.toFixed(2)} stars</span>
                    <span>{Math.round(selectedBeatmap.cs)}K</span>
                    <span>{Math.round(selectedBeatmap.bpm ?? beatmapset.bpm)} BPM</span>
                    <span>{formatDuration(selectedBeatmap.totalLength)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {beatmapset.patterns.slice(0, 8).map((pattern) => (
                      <span
                        key={pattern}
                        className="rounded-full border border-osu-pink/25 bg-osu-pink/15 px-2 py-0.5 text-[10px] font-semibold text-osu-pink-light"
                      >
                        {MANIA_PATTERN_LABELS[pattern] ?? pattern}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="grid content-end gap-2">
                  <a
                    href={osuUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-osu-pink px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-osu-pink-light"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>view on osu! web</span>
                  </a>
                  <a
                    href={`osu://dl/${beatmapset.id}`}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-osu-b6/80 px-3 py-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white"
                  >
                    <Music2 className="h-3.5 w-3.5" />
                    <span>open in osu! client</span>
                  </a>
                </div>
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 space-y-4">
                <ChartPreviewPanel
                  beatmapset={beatmapset}
                  selectedBeatmapId={selectedBeatmap.id}
                  className="min-h-[520px]"
                />
              </div>

              <aside className="space-y-4">
                <section className="rounded-xl border border-osu-b3/25 bg-osu-b4 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">difficulty shape</div>
                      <h2 className="mt-0.5 text-base font-bold text-osu-c1">Radar</h2>
                    </div>
                    <BarChart3 className="h-4 w-4 text-osu-pink" />
                  </div>
                  <RadarChart axes={metrics.radar} />
                </section>

                <section className="rounded-xl border border-osu-b3/25 bg-osu-b4 p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">chart data</div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <MetricTile icon={<Keyboard className="h-3.5 w-3.5" />} label="objects" value={formatNumber(metrics.objects)} />
                    <MetricTile icon={<Gauge className="h-3.5 w-3.5" />} label="peak nps" value={metrics.peakNps.toFixed(1)} />
                    <MetricTile icon={<Activity className="h-3.5 w-3.5" />} label="avg nps" value={metrics.avgNps.toFixed(1)} />
                    <MetricTile icon={<Target className="h-3.5 w-3.5" />} label="OD" value={metrics.od.toFixed(1)} />
                    <MetricTile icon={<Clock3 className="h-3.5 w-3.5" />} label="breaks" value={String(metrics.breaks)} />
                    <MetricTile icon={<BarChart3 className="h-3.5 w-3.5" />} label="SVs" value={String(metrics.svCount)} />
                  </div>
                </section>

                <section className="rounded-xl border border-osu-b3/25 bg-osu-b4 p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">farm context</div>
                  <div className="mt-3 space-y-2">
                    <ContextRow label="estimated gain" value={farmContext?.gain != null ? `+${formatPp(farmContext.gain)}pp` : "unknown"} />
                    <ContextRow label="benchmark" value={farmContext?.benchmark != null ? `${formatPp(farmContext.benchmark)}pp` : "unknown"} />
                    <ContextRow label="your score" value={farmContext?.subjectPp != null ? `${formatPp(farmContext.subjectPp)}pp` : "not played"} />
                    <ContextRow label="nearby farmers" value={farmContext?.peerCount != null ? String(farmContext.peerCount) : "unknown"} />
                    <ContextRow label="sample fit" value={farmContext?.peerFraction != null ? `${Math.round(farmContext.peerFraction * 100)}%` : "unknown"} />
                    <ContextRow label="sample median" value={farmContext?.median != null ? `${formatPp(farmContext.median)}pp` : "unknown"} />
                  </div>
                </section>

                <section className="rounded-xl border border-osu-b3/25 bg-osu-b4 p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">global data</div>
                  <div className="mt-3 space-y-2">
                    <ContextRow label="plays" value={formatNumber(beatmapset.globalPlayCount)} />
                    <ContextRow label="favourites" value={formatNumber(beatmapset.globalFavouriteCount)} />
                    <ContextRow label="submitted" value={formatDate(beatmapset.submittedDate)} />
                    <ContextRow label="ranked" value={formatDate(beatmapset.rankedDate)} />
                    <ContextRow label="updated" value={formatDate(beatmapset.lastUpdated)} />
                  </div>
                </section>
              </aside>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function normalizeBeatmapset(set: OsuBeatmapset): DetailBeatmapset {
  const maniaBeatmaps = (set.beatmaps ?? [])
    .filter((beatmap) => beatmap.mode === "mania")
    .map(normalizeBeatmap)
    .sort((a, b) => b.difficultyRating - a.difficultyRating);
  const starValues = maniaBeatmaps.map((beatmap) => beatmap.difficultyRating).filter((value) => Number.isFinite(value));
  const maniaKeys = [...new Set(maniaBeatmaps.map((beatmap) => Math.round(beatmap.cs)).filter((key) => Number.isFinite(key) && key > 0))].sort((a, b) => a - b);
  const patterns = detectManiaPatterns(set.tags ?? "", maniaBeatmaps.map((beatmap) => beatmap.version), set.title);

  return {
    id: set.id,
    title: set.title,
    artist: set.artist,
    creator: set.creator,
    covers: set.covers,
    status: set.status,
    globalPlayCount: set.play_count,
    globalFavouriteCount: set.favourite_count,
    previewUrl: set.preview_url,
    maniaKeys,
    maniaBeatmaps,
    starMin: starValues.length ? Math.min(...starValues) : 0,
    starMax: starValues.length ? Math.max(...starValues) : 0,
    bpm: set.bpm,
    patterns,
    submittedDate: set.submitted_date,
    rankedDate: set.ranked_date,
    lastUpdated: set.last_updated,
    tags: set.tags,
  };
}

function normalizeBeatmap(beatmap: OsuBeatmap): DetailBeatmap {
  return {
    id: beatmap.id,
    beatmapsetId: beatmap.beatmapset_id,
    version: beatmap.version,
    difficultyRating: beatmap.difficulty_rating,
    totalLength: beatmap.total_length,
    cs: beatmap.cs,
    accuracy: beatmap.accuracy,
    drain: beatmap.drain,
    bpm: beatmap.bpm,
    countCircles: beatmap.count_circles,
    countSliders: beatmap.count_sliders,
    maxCombo: beatmap.max_combo,
    status: beatmap.status,
    url: beatmap.url,
  };
}

function buildMapMetrics(selected: DetailBeatmap | null, parsed: ManiaBeatmap | null) {
  const lengthSec = Math.max(1, selected?.totalLength ?? (parsed?.totalLength ? parsed.totalLength / 1000 : 0));
  const notes = parsed?.notes ?? [];
  const objects = notes.length || ((selected?.countCircles ?? 0) + (selected?.countSliders ?? 0));
  const holdCount = notes.length ? notes.filter((note) => note.isHold).length : selected?.countSliders ?? 0;
  const avgNps = objects / lengthSec;
  const peakNps = notes.length ? getPeakNps(notes) : avgNps;
  const chordStats = notes.length ? getChordStats(notes) : { chordRatio: 0, avgChordSize: 1 };
  const od = parsed?.od ?? selected?.accuracy ?? 8;
  const svCount = parsed?.scrollVelocities?.filter((sv) => Math.abs(sv.multiplier - 1) > 0.001).length ?? 0;
  const breaks = parsed?.breakPeriods.length ?? 0;
  const holdRatio = objects > 0 ? holdCount / objects : 0;
  const star = selected?.difficultyRating ?? 0;

  return {
    objects,
    holdCount,
    avgNps,
    peakNps,
    od,
    svCount,
    breaks,
    radar: [
      { label: "stars", value: clamp01(star / 10) },
      { label: "speed", value: clamp01(peakNps / 28) },
      { label: "density", value: clamp01(avgNps / 12) },
      { label: "chords", value: clamp01((chordStats.chordRatio * 1.8) + ((chordStats.avgChordSize - 1) / 5)) },
      { label: "LN", value: clamp01(holdRatio * 2.6) },
      { label: "tech", value: clamp01((svCount / 42) + (od / 10) * 0.35) },
    ],
  };
}

function getPeakNps(notes: ManiaBeatmap["notes"]): number {
  if (!notes.length) return 0;
  const times = notes.map((note) => note.time).sort((a, b) => a - b);
  let best = 0;
  let left = 0;
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > 1000) left++;
    best = Math.max(best, right - left + 1);
  }
  return best;
}

function getChordStats(notes: ManiaBeatmap["notes"]): { chordRatio: number; avgChordSize: number } {
  const groups = new Map<number, number>();
  for (const note of notes) {
    const key = Math.round(note.time / 8) * 8;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const values = [...groups.values()];
  if (!values.length) return { chordRatio: 0, avgChordSize: 1 };
  const chordGroups = values.filter((value) => value >= 2);
  const avgChordSize = chordGroups.length
    ? chordGroups.reduce((total, value) => total + value, 0) / chordGroups.length
    : 1;
  return {
    chordRatio: chordGroups.length / values.length,
    avgChordSize,
  };
}

function RadarChart({ axes }: { axes: Array<{ label: string; value: number }> }) {
  const size = 260;
  const center = size / 2;
  const maxRadius = 96;
  const points = axes.map((axis, index) => {
    const angle = (-Math.PI / 2) + (index / axes.length) * Math.PI * 2;
    const radius = maxRadius * clamp01(axis.value);
    return {
      label: axis.label,
      value: axis.value,
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
      labelX: center + Math.cos(angle) * (maxRadius + 22),
      labelY: center + Math.sin(angle) * (maxRadius + 22),
      axisX: center + Math.cos(angle) * maxRadius,
      axisY: center + Math.sin(angle) * maxRadius,
    };
  });
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");
  const rings = [0.33, 0.66, 1];

  return (
    <div className="mt-3 flex justify-center">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-[260px] w-full max-w-[300px]" role="img" aria-label="Difficulty radar chart">
        {rings.map((ring) => {
          const ringPoints = axes.map((_, index) => {
            const angle = (-Math.PI / 2) + (index / axes.length) * Math.PI * 2;
            const radius = maxRadius * ring;
            return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`;
          }).join(" ");
          return <polygon key={ring} points={ringPoints} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />;
        })}
        {points.map((point) => (
          <line key={point.label} x1={center} y1={center} x2={point.axisX} y2={point.axisY} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
        ))}
        <polygon points={polygon} fill="rgba(255,102,171,0.24)" stroke="rgb(255,102,171)" strokeWidth="2" />
        {points.map((point) => (
          <g key={point.label}>
            <circle cx={point.x} cy={point.y} r="3" fill="rgb(255,102,171)" />
            <text
              x={point.labelX}
              y={point.labelY}
              textAnchor={point.labelX < center - 4 ? "end" : point.labelX > center + 4 ? "start" : "middle"}
              dominantBaseline="middle"
              className="fill-osu-f1 text-[10px] font-bold uppercase tracking-wider"
            >
              {point.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function MetricTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-osu-b3/20 bg-osu-b5/45 px-3 py-2">
      <div className="flex items-center gap-1.5 text-osu-f1">
        {icon}
        <span className="text-[9px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-1 text-lg font-black tabular-nums text-osu-c1">{value}</div>
    </div>
  );
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-osu-b5/35 px-3 py-2 text-[12px]">
      <span className="text-osu-f1">{label}</span>
      <span className="font-bold tabular-nums text-osu-l2">{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const cls = normalized === "ranked" || normalized === "approved"
    ? "bg-[#6cf27f]"
    : normalized === "loved"
    ? "bg-[#f26fa6]"
    : normalized === "graveyard"
    ? "bg-[#b3b3b3]"
    : "bg-[#ffd36b]";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase leading-none text-black ${cls}`}>
      {status}
    </span>
  );
}

function ContextBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-full border border-osu-b3/40 bg-osu-b5/70 px-2.5 py-1 text-[10px] font-bold uppercase leading-none text-osu-l2">
      {children}
    </span>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-52 w-full rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Skeleton className="h-[520px] w-full rounded-xl" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-[340px] w-full rounded-xl" />
          <Skeleton className="h-52 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

function formatPp(value: number): string {
  return value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function readStoredFarmContext(beatmapId: number): FarmMapContext | null {
  if (typeof window === "undefined" || !Number.isSafeInteger(beatmapId)) return null;
  try {
    const raw = window.sessionStorage.getItem(`${FARM_MAP_CONTEXT_KEY_PREFIX}${beatmapId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const data = parsed as Record<string, unknown>;
    return {
      userKey: typeof data.userKey === "string" ? data.userKey : undefined,
      keyMode: data.keyMode === "4k" || data.keyMode === "7k" || data.keyMode === "any" ? data.keyMode : undefined,
      speed: data.speed === "ht" || data.speed === "normal" || data.speed === "dt" ? data.speed : undefined,
      reason: data.reason === "missing" || data.reason === "improve" || data.reason === "stale" ? data.reason : undefined,
      gain: finiteNumber(data.gain),
      benchmark: finiteNumber(data.benchmark),
      subjectPp: finiteNumber(data.subjectPp),
      peerCount: finiteNumber(data.peerCount),
      peerSampleSize: finiteNumber(data.peerSampleSize),
      peerFraction: finiteNumber(data.peerFraction),
      median: finiteNumber(data.median),
      p75: finiteNumber(data.p75),
      playedAt: typeof data.playedAt === "string" ? data.playedAt : undefined,
    };
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
