import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, BarChart3, Clock3, ExternalLink, Gauge, Keyboard, Music2, Star, Target } from "lucide-react";
import { getBeatmapsetForBeatmap } from "../../../lib/osu";
import type { MapsFavouriteBeatmapset, OsuBeatmap, OsuBeatmapset } from "../../../lib/types";
import { detectManiaPatterns, MANIA_PATTERN_LABELS } from "../../../lib/mania-patterns";
import { formatDuration, formatNumber } from "../../../lib/format";
import { PageHeader } from "../../../components/layout/PageHeader";
import { Skeleton } from "../../../components/ui/LoadingSkeleton";
import { ChartPreviewPanel } from "../../../components/maps/ChartPreviewPanel";
import { FarmersList } from "../../../components/farm-helper/FarmersList";
import { fetchLiveMapSearchEntry, type LiveFarmHelperKeyMode, type LiveFarmHelperReason, type LiveFarmHelperSpeedBucket, type LiveMapSearchEntry } from "../../../lib/live-backend";
import { danBareLabel, getDanImageSrc } from "../../../lib/dan-images";
import { pageSeo } from "../../../lib/seo";

type FarmMapContext = {
  beatmapsetId?: number;
  title?: string;
  artist?: string;
  creator?: string;
  version?: string;
  cover?: string;
  status?: string;
  stars?: number;
  keys?: number;
  bpm?: number;
  lengthSec?: number;
  mapUrl?: string;
  userKey?: string;
  userName?: string;
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

type FarmMapSearch = {
  user?: string;
  key?: LiveFarmHelperKeyMode;
  speed?: LiveFarmHelperSpeedBucket;
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

// The chart's shape data from the live backend catalog (map_search_index):
// the same 8-family pattern mix + MSD the farm-helper engine scores against,
// already cached server-side, so no .osu download happens here.
type AnalysisState =
  | { status: "idle"; entry: null }
  | { status: "loading"; entry: null }
  | { status: "ready"; entry: LiveMapSearchEntry }
  | { status: "failed"; entry: null };

const REASON_LABELS: Record<LiveFarmHelperReason, string> = {
  missing: "missing",
  improve: "improve",
  stale: "old pb",
  owned: "cleared",
};

const SPEED_LABELS: Record<LiveFarmHelperSpeedBucket, string> = {
  ht: "HT",
  normal: "NM",
  dt: "DT",
};

const SPEED_RATES: Record<LiveFarmHelperSpeedBucket, number> = {
  ht: 0.75,
  normal: 1,
  dt: 1.5,
};

const FARM_MAP_CONTEXT_KEY_PREFIX = "mania-hub-farm-helper-map-context-v1:";

export const Route = createFileRoute("/farm-helper/map/$beatmapId")({
  validateSearch: (search: Record<string, unknown>): FarmMapSearch => ({
    user: typeof search.user === "string" && search.user.trim() ? search.user.trim().slice(0, 80) : undefined,
    key: parseFarmKeyMode(search.key),
    speed: parseFarmSpeed(search.speed),
  }),
  head: ({ match }) => pageSeo({
    title: "Farm Map Detail",
    description: "osu!mania farm map detail with difficulty metrics, radar chart, density timeline, and chart preview.",
    path: `/farm-helper/map/${match.params.beatmapId}`,
    origin: match.context.origin,
    imageKind: "farm-helper",
  }),
  component: FarmMapDetailPage,
});

function FarmMapDetailPage() {
  const { beatmapId: beatmapIdRaw } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const beatmapId = Number.parseInt(beatmapIdRaw, 10);
  const [beatmapset, setBeatmapset] = useState<DetailBeatmapset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBeatmapId, setSelectedBeatmapId] = useState<number | null>(Number.isFinite(beatmapId) ? beatmapId : null);
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ status: "idle", entry: null });
  const [farmContext, setFarmContext] = useState<FarmMapContext | null>(() => readFarmMapContext(beatmapId, search));

  useEffect(() => {
    setFarmContext(readFarmMapContext(beatmapId, search));
  }, [beatmapId, search.user, search.key, search.speed]);

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
  const farmRate = getFarmSpeedRate(farmContext?.speed);
  const displayedBpm = Math.round((selectedBeatmap?.bpm ?? beatmapset?.bpm ?? 0) * farmRate);
  const displayedLength = selectedBeatmap ? Math.max(1, Math.round(selectedBeatmap.totalLength / farmRate)) : 0;

  useEffect(() => {
    if (!selectedBeatmap) {
      setAnalysisState({ status: "idle", entry: null });
      return;
    }

    let cancelled = false;
    setAnalysisState({ status: "loading", entry: null });
    fetchLiveMapSearchEntry(selectedBeatmap.id)
      .then((entry) => {
        if (cancelled) return;
        setAnalysisState(entry ? { status: "ready", entry } : { status: "failed", entry: null });
      })
      .catch(() => {
        if (!cancelled) setAnalysisState({ status: "failed", entry: null });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBeatmap]);

  const metrics = useMemo(
    () => buildMapMetrics(selectedBeatmap, analysisState.status === "ready" ? analysisState.entry : null, farmRate),
    [analysisState, farmRate, selectedBeatmap],
  );
  const radarReady = analysisState.status === "ready" && metrics.radar.some((axis) => axis.value > 0);
  const osuUrl = selectedBeatmap?.url ?? (beatmapset ? `https://osu.ppy.sh/beatmapsets/${beatmapset.id}#mania/${selectedBeatmapId ?? beatmapId}` : `https://osu.ppy.sh/beatmaps/${beatmapId}`);
  const coverUrl = beatmapset?.covers["cover@2x"] ?? beatmapset?.covers.cover ?? beatmapset?.covers.card ?? "";
  const cardUrl = beatmapset?.covers.card ?? beatmapset?.covers.list ?? coverUrl;
  const heroImageUrl = farmContext?.cover ?? cardUrl;
  const heroBackdropUrl = coverUrl || farmContext?.cover || cardUrl;
  const hasFarmContext = Boolean(farmContext && (
    farmContext.gain != null ||
    farmContext.benchmark != null ||
    farmContext.subjectPp != null ||
    farmContext.peerCount != null ||
    farmContext.peerFraction != null ||
    farmContext.median != null
  ));

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

      <main className="mx-auto w-full max-w-[1680px] px-3 py-4 sm:px-5">
        {loading ? (
          <DetailSkeleton farmContext={farmContext} farmRate={farmRate} />
        ) : error ? (
          <div className="mx-auto max-w-md py-16 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1">map unavailable</div>
            <h2 className="mt-1 text-lg font-bold text-osu-c1">{error}</h2>
          </div>
        ) : beatmapset && selectedBeatmap ? (
          <div className="space-y-4">
            <section className="relative overflow-hidden rounded-lg border border-osu-b3/25 bg-osu-b4">
              {heroBackdropUrl ? (
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-20"
                  style={{ backgroundImage: `url("${heroBackdropUrl.replace(/"/g, '\\"')}")` }}
                  aria-hidden="true"
                />
              ) : null}
              <div className="absolute inset-0 bg-gradient-to-r from-osu-b4 via-osu-b4/92 to-osu-b5/78" aria-hidden="true" />
              <div className="relative grid gap-4 p-4 lg:grid-cols-[180px_minmax(0,1fr)_240px] lg:p-5">
                <div className="h-32 overflow-hidden rounded-md bg-osu-b6 lg:h-44">
                  {heroImageUrl ? <img src={heroImageUrl} alt="" className="h-full w-full object-cover" /> : null}
                </div>
                <div className="min-w-0 self-center">
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
                    <span>{displayedBpm} BPM</span>
                    <span>{formatDuration(displayedLength)}</span>
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
                  {beatmapset.maniaBeatmaps.length > 1 ? (
                    <DifficultyStrip
                      beatmaps={beatmapset.maniaBeatmaps}
                      selectedBeatmapId={selectedBeatmap.id}
                      speedRate={farmRate}
                      onSelect={setSelectedBeatmapId}
                    />
                  ) : null}
                </div>
                <div className="grid content-center gap-2">
                  <a
                    href={osuUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-md bg-osu-pink px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-osu-pink-light"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>view on osu! web</span>
                  </a>
                  <a
                    href={`osu://dl/${beatmapset.id}`}
                    className="hidden items-center justify-center gap-2 rounded-md bg-osu-b6/80 px-3 py-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white lg:inline-flex"
                  >
                    <Music2 className="h-3.5 w-3.5" />
                    <span>open in osu! client</span>
                  </a>
                </div>
              </div>
            </section>

            <div className={`grid gap-4 ${hasFarmContext || farmContext?.userKey ? "xl:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
              <div className="min-w-0 space-y-4">
                <ChartPreviewPanel
                  beatmapset={beatmapset}
                  selectedBeatmapId={selectedBeatmap.id}
                  playbackRate={farmRate}
                  className="h-[360px] rounded-lg sm:h-[400px] xl:h-[460px]"
                  flatBackdrop
                />

                <section className="rounded-lg border border-osu-b3/25 bg-osu-b4 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">analysis</div>
                      <h2 className="mt-0.5 text-base font-bold text-osu-c1">Map shape</h2>
                    </div>
                    <BarChart3 className="h-4 w-4 text-osu-pink" />
                  </div>
                  <div className="mt-2 grid gap-4 sm:grid-cols-[minmax(0,300px)_minmax(0,1fr)] sm:items-center">
                    <div className="mx-auto w-full max-w-[340px]">
                      {radarReady ? (
                        <RadarChart axes={metrics.radar} />
                      ) : analysisState.status === "loading" || analysisState.status === "idle" ? (
                        <AnalysisLoadingState />
                      ) : (
                        <AnalysisUnavailableState />
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <MetricTile icon={<Keyboard className="h-3.5 w-3.5" />} label="objects" value={formatNumber(metrics.objects)} />
                      <MetricTile icon={<Activity className="h-3.5 w-3.5" />} label="avg nps" value={metrics.avgNps.toFixed(1)} />
                      <MetricTile icon={<Target className="h-3.5 w-3.5" />} label="OD" value={metrics.od.toFixed(1)} />
                      <MetricTile icon={<Clock3 className="h-3.5 w-3.5" />} label="long notes" value={`${Math.round(metrics.lnFraction * 100)}%`} />
                      {metrics.msdOverall != null ? (
                        <MetricTile
                          icon={<Gauge className="h-3.5 w-3.5" />}
                          label="msd"
                          value={metrics.msdOverall.toFixed(2)}
                          detail={metrics.vibro ? "vibro chart, estimate unreliable" : metrics.msdTopSkillset}
                        />
                      ) : null}
                      {metrics.dan ? (
                        <MetricTile
                          icon={<Star className="h-3.5 w-3.5" />}
                          label={metrics.dan.family === "ln" ? "LN dan est." : "dan est."}
                          value={
                            metrics.danImage ? (
                              // The logo IS the number; the +/- tier suffix rides top-right like an exponent.
                              <span className="flex items-start gap-[2px] leading-none">
                                <img src={metrics.danImage} alt={metrics.dan.label} className="h-10 w-10 object-contain" />
                                {danSuffix(metrics.dan.label) ? (
                                  <span className="mt-0.5 text-[13px] font-bold leading-none">{danSuffix(metrics.dan.label)}</span>
                                ) : null}
                              </span>
                            ) : (
                              metrics.dan.label
                            )
                          }
                        />
                      ) : null}
                    </div>
                  </div>
                </section>
              </div>

              {hasFarmContext || farmContext?.userKey ? (
                <aside className="flex flex-col gap-4 xl:sticky xl:top-4">
                  {hasFarmContext ? (
                    <section className="shrink-0 rounded-lg border border-osu-b3/25 bg-osu-b4 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">farm verdict</div>
                          <div className="mt-1 text-2xl font-black tabular-nums text-osu-pink">
                            {farmContext?.gain != null ? `+${formatPp(farmContext.gain)}pp` : "unknown"}
                          </div>
                        </div>
                        <div className="grid min-w-[150px] gap-1.5">
                          <CompactRow label="your score" value={farmContext?.subjectPp != null ? `${formatPp(farmContext.subjectPp)}pp` : "not played"} />
                          <CompactRow label="target" value={farmContext?.benchmark != null ? `${formatPp(farmContext.benchmark)}pp` : "unknown"} />
                          <CompactRow label="peers farming" value={farmContext?.peerFraction != null ? `${Math.round(farmContext.peerFraction * 100)}%` : "unknown"} />
                        </div>
                      </div>
                    </section>
                  ) : null}

                  {farmContext?.userKey ? (
                    <section className="flex max-h-[640px] min-h-[360px] flex-col overflow-hidden rounded-lg border border-osu-b3/25 bg-osu-b4">
                      <div className="shrink-0 border-b border-osu-b3/20 p-3">
                        <h2 className="text-base font-bold text-osu-c1">Who farms this</h2>
                      </div>
                      <FarmersList
                        userKey={farmContext.userKey}
                        beatmapId={selectedBeatmap.id}
                        speedBucket={selectedBeatmap.id === beatmapId ? farmContext.speed : undefined}
                        keyMode={farmContext.keyMode ?? "any"}
                        className="min-h-0 flex-1"
                      />
                    </section>
                  ) : null}
                </aside>
              ) : null}
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

// The 8-family pattern mix stored in the backend catalog, in the same order
// the /maps PatternRadar uses. Values are already normalized to the chart's
// dominant family (max = 1).
const RADAR_AXES: Array<{ id: string; label: string }> = [
  { id: "jack", label: "Jack" },
  { id: "stream", label: "Stream" },
  { id: "jumpstream", label: "Jumpstream" },
  { id: "handstream", label: "Handstream" },
  { id: "stamina", label: "Stamina" },
  { id: "chordjack", label: "Chordjack" },
  { id: "tech", label: "Tech" },
  { id: "ln", label: "LN" },
];

const MSD_SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];

function buildMapMetrics(selected: DetailBeatmap | null, entry: LiveMapSearchEntry | null, rate = 1) {
  const normalizedRate = Math.max(0.1, rate);
  const lengthSec = Math.max(1, (selected?.totalLength ?? 0) / normalizedRate);
  const objects = (selected?.countCircles ?? 0) + (selected?.countSliders ?? 0);
  const holdCount = selected?.countSliders ?? 0;
  // Under a DT farm context (1.5x), show the rate-adjusted dan/MSD once the DT
  // sweep has covered this chart; otherwise fall back to the stored 1.0x values.
  const preferDt = normalizedRate >= 1.5;
  // At 1.0x the LN-adjusted (tail-aware) MSD simply IS the msd shown: it is
  // what the skill-rating engine credits a play here. No LN x DT cross-sweep
  // exists, so the DT context stays on the DT values.
  const msd = (preferDt && entry?.msdDt ? entry.msdDt : entry?.msdLn ?? entry?.msd) ?? null;
  const dan = (preferDt && entry?.danDt ? entry.danDt : entry?.dan) ?? null;
  const msdOverall = Number(msd?.Overall ?? NaN);
  // Same readout as the /maps modal: the sub-1 values the 6K/7K calc engine
  // emits for skillsets it does not rate are noise, not data.
  const msdTopSkillset = msd
    ? MSD_SKILLSETS
        .map((name) => ({ name, value: Number(msd[name] ?? 0) }))
        .filter(({ value }) => value >= 1)
        .sort((a, b) => b.value - a.value)
        .map(({ name }) => (name === "JackSpeed" ? "Jackspeed" : name))[0] ?? null
    : null;

  return {
    objects,
    holdCount,
    avgNps: objects / lengthSec,
    od: selected?.accuracy ?? 8,
    lnFraction: objects > 0 ? holdCount / objects : 0,
    msdOverall: Number.isFinite(msdOverall) && msdOverall > 0 ? msdOverall : null,
    msdTopSkillset,
    vibro: entry?.vibro === true,
    dan,
    danImage: dan
      ? getDanImageSrc(danBareLabel(dan.label), dan.family === "ln" ? "ln" : undefined, entry?.keyCount ?? 4)
      : null,
    radar: entry
      ? RADAR_AXES.map((axis) => ({ label: axis.label, value: clamp01(entry.patterns[axis.id] ?? 0) }))
      : [],
  };
}

function getFarmSpeedRate(speed: LiveFarmHelperSpeedBucket | undefined): number {
  return speed ? SPEED_RATES[speed] : 1;
}

/** The +/- tier suffix of a dan verdict ("2--" -> "--"), which badge art can't show. */
function danSuffix(label: string): string {
  return label.match(/[+-]+$/)?.[0] ?? "";
}

function RadarChart({ axes }: { axes: Array<{ label: string; value: number }> }) {
  const size = 380;
  const center = size / 2;
  const maxRadius = 112;
  const labelRadius = 150;
  const points = axes.map((axis, index) => {
    const angle = (-Math.PI / 2) + (index / axes.length) * Math.PI * 2;
    const radius = maxRadius * clamp01(axis.value);
    return {
      label: axis.label,
      labelLines: splitRadarLabel(axis.label),
      value: axis.value,
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
      labelX: center + Math.cos(angle) * labelRadius,
      labelY: center + Math.sin(angle) * labelRadius,
      axisX: center + Math.cos(angle) * maxRadius,
      axisY: center + Math.sin(angle) * maxRadius,
    };
  });
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");
  const rings = [0.33, 0.66, 1];

  return (
    <div className="mt-2 flex justify-center">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-[300px] w-full max-w-[350px] text-osu-pink" role="img" aria-label="Difficulty radar chart">
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
        <polygon points={polygon} fill="currentColor" fillOpacity="0.24" stroke="currentColor" strokeWidth="2" />
        {points.map((point) => (
          <g key={point.label}>
            <circle cx={point.x} cy={point.y} r="3" fill="currentColor" />
            <text
              x={point.labelX}
              y={point.labelY - (point.labelLines.length > 1 ? 5 : 0)}
              textAnchor={point.labelX < center - 4 ? "end" : point.labelX > center + 4 ? "start" : "middle"}
              dominantBaseline="middle"
              className="fill-osu-f1 text-[11px] font-black uppercase"
            >
              {point.labelLines.map((line, index) => (
                <tspan key={line} x={point.labelX} dy={index === 0 ? 0 : 13}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function splitRadarLabel(label: string): string[] {
  const normalized = label.toLowerCase();
  if (normalized === "chordstream") return ["Chord", "stream"];
  if (normalized === "chordjack") return ["Chord", "jack"];
  if (normalized === "jumpstream") return ["Jump", "stream"];
  if (normalized === "handstream") return ["Hand", "stream"];
  if (normalized === "dumpstream") return ["Dump", "stream"];
  return [label];
}

function AnalysisLoadingState() {
  return (
    <div className="mt-2 flex justify-center">
      <svg viewBox="0 0 380 380" className="h-[300px] w-full max-w-[350px]" role="img" aria-label="Loading map shape analysis">
        {[0.33, 0.66, 1].map((ring) => (
          <polygon
            key={ring}
            points={radarLoadingPolygonPoints(190, 112 * ring, 8)}
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="1"
          />
        ))}
        {Array.from({ length: 8 }, (_, index) => {
          const angle = (-Math.PI / 2) + (index / 8) * Math.PI * 2;
          return (
            <line
              key={index}
              x1="190"
              y1="190"
              x2={190 + Math.cos(angle) * 112}
              y2={190 + Math.sin(angle) * 112}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
          );
        })}
        <polygon
          points={radarLoadingPolygonPoints(190, 70, 8)}
          fill="rgba(255,102,171,0.12)"
          stroke="rgba(255,102,171,0.45)"
          strokeWidth="2"
          className="animate-pulse"
        />
        {Array.from({ length: 8 }, (_, index) => {
          const angle = (-Math.PI / 2) + (index / 8) * Math.PI * 2;
          const x = 190 + Math.cos(angle) * 150;
          const y = 190 + Math.sin(angle) * 150;
          return <circle key={index} cx={x} cy={y} r="12" className="fill-osu-b3/45 animate-pulse" />;
        })}
      </svg>
    </div>
  );
}

function AnalysisUnavailableState() {
  return (
    <div className="mt-4 rounded-md border border-osu-b3/20 bg-osu-b5/35 px-3 py-10 text-center">
      <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">analysis unavailable</div>
      <div className="mt-1 text-[12px] font-semibold text-osu-l2">This chart isn't analyzed yet.</div>
    </div>
  );
}

function radarLoadingPolygonPoints(center: number, radius: number, count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const angle = (-Math.PI / 2) + (index / count) * Math.PI * 2;
    return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`;
  }).join(" ");
}

function CompactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-osu-b5/40 px-2 py-1.5 text-[11px]">
      <span className="font-bold uppercase tracking-wide text-osu-f1">{label}</span>
      <span className="font-black tabular-nums text-osu-l2">{value}</span>
    </div>
  );
}

function DifficultyStrip({
  beatmaps,
  selectedBeatmapId,
  speedRate,
  onSelect,
}: {
  beatmaps: DetailBeatmap[];
  selectedBeatmapId: number;
  speedRate: number;
  onSelect: (beatmapId: number) => void;
}) {
  return (
    <div className="mt-4 border-t border-osu-b3/20 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">difficulty</div>
        </div>
        <Star className="h-4 w-4 text-osu-yellow" />
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {beatmaps.map((beatmap) => {
          const selected = beatmap.id === selectedBeatmapId;
          return (
            <button
              key={beatmap.id}
              type="button"
              onClick={() => onSelect(beatmap.id)}
              className={`min-w-[180px] rounded-md border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-osu-pink/60 bg-osu-pink/15"
                  : "border-osu-b3/20 bg-osu-b5/45 hover:border-osu-b3/50 hover:bg-osu-b5/80"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-bold text-osu-c1">[{beatmap.version}]</span>
                <span className="shrink-0 text-[11px] font-black tabular-nums text-osu-yellow">
                  {beatmap.difficultyRating.toFixed(2)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] font-semibold uppercase text-osu-f1">
                <span>{Math.round(beatmap.cs)}K</span>
                <span>{Math.round((beatmap.bpm ?? 0) * speedRate)} BPM</span>
                <span>{formatDuration(Math.max(1, Math.round(beatmap.totalLength / Math.max(0.1, speedRate))))}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MetricTile({
  icon,
  label,
  value,
  detail,
  className = "",
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-md border border-osu-b3/20 bg-osu-b5/45 px-3 py-2 ${className}`}>
      <div className="flex items-center gap-1.5 text-osu-f1">
        {icon}
        <span className="text-[9px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-1 text-lg font-black tabular-nums text-osu-c1">{value}</div>
      {detail ? <div className="mt-1 text-[10px] font-semibold tabular-nums text-osu-f1">{detail}</div> : null}
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

function DetailSkeleton({ farmContext, farmRate }: { farmContext: FarmMapContext | null; farmRate: number }) {
  const hasKnownMap = Boolean(farmContext?.title);
  const displayedBpm = farmContext?.bpm != null ? Math.round(farmContext.bpm * farmRate) : null;
  const displayedLength = farmContext?.lengthSec != null
    ? formatDuration(Math.max(1, Math.round(farmContext.lengthSec / Math.max(0.1, farmRate))))
    : null;

  return (
    <div className="space-y-4">
      {hasKnownMap ? (
        <section className="relative overflow-hidden rounded-lg border border-osu-b3/25 bg-osu-b4">
          {farmContext?.cover ? (
            <div
              className="absolute inset-0 bg-cover bg-center opacity-20"
              style={{ backgroundImage: `url("${farmContext.cover.replace(/"/g, '\\"')}")` }}
              aria-hidden="true"
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-r from-osu-b4 via-osu-b4/92 to-osu-b5/78" aria-hidden="true" />
          <div className="relative grid gap-4 p-4 lg:grid-cols-[180px_minmax(0,1fr)_240px] lg:p-5">
            <div className="h-32 overflow-hidden rounded-md bg-osu-b6 lg:h-44">
              {farmContext?.cover ? <img src={farmContext.cover} alt="" className="h-full w-full object-cover" /> : null}
            </div>
            <div className="min-w-0 self-center">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {farmContext?.status ? <StatusBadge status={farmContext.status} /> : null}
                {farmContext?.reason ? <ContextBadge>{REASON_LABELS[farmContext.reason]}</ContextBadge> : null}
                {farmContext?.speed ? <ContextBadge>{SPEED_LABELS[farmContext.speed]}</ContextBadge> : null}
                {farmContext?.keyMode ? <ContextBadge>{farmContext.keyMode.toUpperCase()}</ContextBadge> : null}
              </div>
              <h1 className="truncate text-2xl font-black text-osu-c1 sm:text-3xl">
                {farmContext?.title}
              </h1>
              <div className="mt-1 truncate text-sm font-medium text-osu-f1">
                {farmContext?.artist ?? "unknown artist"} / mapped by {farmContext?.creator ?? "unknown"}
              </div>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-osu-f1">
                {farmContext?.version ? <span className="truncate font-semibold text-osu-l2">[{farmContext.version}]</span> : null}
                {farmContext?.stars != null ? <span className="tabular-nums text-osu-yellow">{farmContext.stars.toFixed(2)} stars</span> : null}
                {farmContext?.keys != null ? <span>{Math.round(farmContext.keys)}K</span> : null}
                {displayedBpm != null ? <span>{displayedBpm} BPM</span> : null}
                {displayedLength ? <span>{displayedLength}</span> : null}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            </div>
            <div className="grid content-center gap-2">
              {farmContext?.mapUrl ? (
                <a
                  href={farmContext.mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-osu-pink px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-osu-pink-light"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>view on osu! web</span>
                </a>
              ) : (
                <Skeleton className="h-9 w-full rounded-md" />
              )}
              {farmContext?.beatmapsetId ? (
                <a
                  href={`osu://dl/${farmContext.beatmapsetId}`}
                  className="hidden items-center justify-center gap-2 rounded-md bg-osu-b6/80 px-3 py-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white lg:inline-flex"
                >
                  <Music2 className="h-3.5 w-3.5" />
                  <span>open in osu! client</span>
                </a>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        <Skeleton className="h-56 w-full rounded-lg" />
      )}
      <div className={`grid gap-4 ${farmContext ? "xl:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
        <div className="min-w-0 space-y-4">
          <Skeleton className="h-[360px] w-full rounded-lg sm:h-[400px] xl:h-[460px]" />
          <div className="rounded-lg border border-osu-b3/25 bg-osu-b4 p-4">
            <div className="space-y-1.5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-28" />
            </div>
            <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,300px)_minmax(0,1fr)] sm:items-center">
              <div className="mx-auto flex w-full max-w-[340px] justify-center">
                <Skeleton className="h-[240px] w-[240px] rounded-full" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-[60px] rounded-md" />
                ))}
                <Skeleton className="col-span-2 h-[60px] rounded-md" />
              </div>
            </div>
          </div>
        </div>

        {farmContext ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-osu-b3/25 bg-osu-b4 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1.5">
                  <Skeleton className="h-2.5 w-20" />
                  <Skeleton className="h-7 w-24" />
                </div>
                <div className="grid min-w-[150px] gap-1.5">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            </div>
            <div className="flex h-[480px] flex-col overflow-hidden rounded-lg border border-osu-b3/25 bg-osu-b4">
              <div className="border-b border-osu-b3/20 p-3">
                <Skeleton className="h-5 w-32" />
              </div>
              <div className="px-3 pt-2.5">
                <Skeleton className="h-7 w-full rounded-lg" />
              </div>
              <div className="flex-1 space-y-1.5 p-2.5">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 rounded-lg" />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatPp(value: number): string {
  return value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function readFarmMapContext(beatmapId: number, search: FarmMapSearch): FarmMapContext | null {
  const stored = readStoredFarmContext(beatmapId);
  if (!stored && !search.user && !search.key && !search.speed) return null;
  return {
    ...(stored ?? {}),
    userKey: search.user ?? stored?.userKey,
    keyMode: search.key ?? stored?.keyMode,
    speed: search.speed ?? stored?.speed,
  };
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
      beatmapsetId: finiteNumber(data.beatmapsetId),
      title: finiteString(data.title),
      artist: finiteString(data.artist),
      creator: finiteString(data.creator),
      version: finiteString(data.version),
      cover: finiteString(data.cover),
      status: finiteString(data.status),
      stars: finiteNumber(data.stars),
      keys: finiteNumber(data.keys),
      bpm: finiteNumber(data.bpm),
      lengthSec: finiteNumber(data.lengthSec),
      mapUrl: finiteString(data.mapUrl),
      userKey: typeof data.userKey === "string" ? data.userKey : undefined,
      userName: finiteString(data.userName),
      keyMode: data.keyMode === "4k" || data.keyMode === "7k" || data.keyMode === "any" ? data.keyMode : undefined,
      speed: data.speed === "ht" || data.speed === "normal" || data.speed === "dt" ? data.speed : undefined,
      reason:
        data.reason === "missing" || data.reason === "improve" || data.reason === "stale" || data.reason === "owned"
          ? data.reason
          : undefined,
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

function parseFarmKeyMode(value: unknown): LiveFarmHelperKeyMode | undefined {
  return value === "4k" || value === "7k" || value === "any" ? value : undefined;
}

function parseFarmSpeed(value: unknown): LiveFarmHelperSpeedBucket | undefined {
  return value === "ht" || value === "normal" || value === "dt" ? value : undefined;
}

function finiteString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
