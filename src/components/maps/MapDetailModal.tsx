import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { fetchLiveChartAnalysis, type LiveChartAnalysisCluster, type LiveChartAnalysisDetail, type LiveMapSearchEntry } from "../../lib/live-backend";
import type { MapsFavouriteBeatmapset } from "../../lib/types";
import { formatDuration, formatNumber } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { ChartPreviewPanel } from "./ChartPreviewPanel";
import { PatternRadar } from "./PatternRadar";
import { danBareLabel, getDanImageSrc } from "../../lib/dan-images";
import {
  PATTERN_COLOR,
  SubPatternChip,
  entryDiffs,
  mapCoverUrl,
  osuBeatmapUrl,
  osuDirectUrl,
  oszDownloadUrl,
  patternLabel,
  subPatternTags,
  StarRatingBadge,
  starRatingColor,
} from "./SearchCard";

// A minimal beatmapset built from the search entry alone, enough for the chart
// preview: the .osu loads from mirrors and the audio preview URL is derivable, so
// opening the modal costs zero osu! API calls. All matching diffs of the set ride
// along so the preview can switch between them.
function buildPreviewBeatmapset(entry: LiveMapSearchEntry, diffs: LiveMapSearchEntry[]): MapsFavouriteBeatmapset {
  return {
    id: entry.beatmapsetId,
    title: entry.title,
    artist: entry.artist,
    creator: entry.creator,
    covers: (entry.covers ?? {}) as unknown as MapsFavouriteBeatmapset["covers"],
    status: entry.status,
    globalPlayCount: entry.playCount,
    globalFavouriteCount: 0,
    previewUrl: `https://b.ppy.sh/preview/${entry.beatmapsetId}.mp3`,
    maniaKeys: [...new Set(diffs.map((diff) => diff.keyCount))],
    maniaBeatmaps: diffs.map((diff) => ({
      id: diff.beatmapId,
      beatmapsetId: diff.beatmapsetId,
      version: diff.version,
      difficultyRating: diff.stars,
      totalLength: diff.length,
      cs: diff.keyCount,
    })),
    starMin: Math.min(...diffs.map((diff) => diff.stars)),
    starMax: Math.max(...diffs.map((diff) => diff.stars)),
    bpm: entry.bpm,
    patterns: [entry.primaryPattern],
  };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[16px] font-bold text-osu-l1 tabular-nums leading-none">{value}</span>
      <span className="text-[9px] uppercase tracking-wide text-osu-f1/70 mt-1">{label}</span>
    </div>
  );
}

// Skillset order used when every value ties (never in practice); display sorts
// by value, Overall stays the headline.
const MSD_SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];

/** The +/- tier suffix of a dan verdict ("2--" -> "--"), which badge art can't show. */
function danSuffix(label: string): string {
  return label.match(/[+-]+$/)?.[0] ?? "";
}

// MSD skillset breakdown + the classifier's dan verdict, as a compact stat
// strip in the same value-over-label language as the BPM/LENGTH/PLAYS row.
// Sorted by value with the top skillset tinted; no bars, the numbers carry it.
// The skillset names are MinaCalc's 4K taxonomy for every keymode; the
// ClustersBlock below is where charts speak their own keymode's language.
function MsdBlock({ entry, msdLn }: { entry: LiveMapSearchEntry; msdLn?: Record<string, number> | null }) {
  // The LN-adjusted (tail-aware) values simply ARE the msd shown when the
  // chart has holds: they match what the skill-rating engine credits a play
  // here. Lands with the lazily fetched analysis; base values show meanwhile.
  const msd = msdLn ?? entry.msd ?? null;
  if (!msd) return null;
  const skillsets = MSD_SKILLSETS
    .map((name) => ({ name, value: Number(msd[name] ?? 0) }))
    // The 6K/7K calc engine returns ~0 for skillsets it does not rate
    // (Technical); a 0.18 next to real values reads as data, so drop it.
    .filter(({ value }) => value >= 1)
    .sort((a, b) => b.value - a.value);
  const overall = Number(msd.Overall ?? 0);
  const topName = skillsets[0]?.name;

  const dan = entry.dan ?? null;
  const danImage = dan
    ? getDanImageSrc(danBareLabel(dan.label), dan.family === "ln" ? "ln" : undefined, entry.keyCount)
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">MSD</span>
        {entry.vibro && (
          <span className="text-[9.5px] font-semibold text-[#ffcf70]">vibro chart, estimates unreliable</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg bg-osu-b4/40 px-3.5 py-2.5">
        {/* Verdict group: dan badge + Overall, split from the skillset grid.
            min-h keeps the row the badge's height even on diffs that have no
            dan verdict, so switching diffs doesn't resize the MSD box. */}
        <div className="flex min-h-10 items-center gap-4 sm:border-r sm:border-white/10 sm:pr-5">
          {dan && (
            <div className="flex flex-col items-center">
              {/* The logo IS the number; the +/- tier suffix rides top-right like an exponent. */}
              <span className="flex items-start gap-[2px] leading-none">
                {danImage ? (
                  <img src={danImage} alt={dan.label} className="h-10 w-10 object-contain" />
                ) : (
                  <span className="text-[16px] font-bold leading-none text-osu-l1">{dan.label}</span>
                )}
                {danImage && danSuffix(dan.label) ? (
                  <span className="mt-0.5 text-[13px] font-bold leading-none text-osu-l1">{danSuffix(dan.label)}</span>
                ) : null}
              </span>
              <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/70">
                {dan.family === "ln" ? "LN dan est." : "dan est."}
              </span>
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-[18px] font-bold tabular-nums leading-none text-osu-l1">{overall.toFixed(2)}</span>
            <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/70">Overall</span>
          </div>
        </div>
        {/* Even columns keep the values aligned no matter how long the labels run. */}
        <div className="grid min-w-0 flex-1 basis-[260px] grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-x-3 gap-y-2.5">
          {skillsets.map(({ name, value }) => (
            <div key={name} className="flex flex-col">
              <span
                className={`text-[14px] font-semibold tabular-nums leading-none ${
                  name === topName ? "text-osu-pink-light" : value < 1 ? "text-osu-f1/45" : "text-osu-l2"
                }`}
              >
                {value.toFixed(2)}
              </span>
              <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/55">
                {name === "JackSpeed" ? "Jackspeed" : name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// A cluster label is "~87BPM Mixed Light Chordstream"; the BPM becomes the
// value (~ marks a mixed-BPM cluster), the rest is the pattern name.
function clusterPatternName(cluster: LiveChartAnalysisCluster): string {
  const stripped = cluster.label.replace(/^~?\d+\s*BPM\s+/i, "").replace(/^Mixed\s+/i, "").trim();
  return stripped || cluster.pattern;
}

// LeoBlack clusters are keyed by (pattern, BPM), so a chart with dense
// chordstream sections at three speeds yields three clusters. One pattern name
// per strip is enough: same-named clusters merge into a BPM range.
interface ClusterGroup {
  name: string;
  bpmMin: number;
  bpmMax: number;
  mixed: boolean;
}

function groupClusters(clusters: LiveChartAnalysisCluster[]): ClusterGroup[] {
  const groups = new Map<string, ClusterGroup>();
  for (const cluster of clusters) {
    const name = clusterPatternName(cluster);
    const bpm = Math.round(cluster.bpm);
    const existing = groups.get(name);
    if (existing) {
      existing.bpmMin = Math.min(existing.bpmMin, bpm);
      existing.bpmMax = Math.max(existing.bpmMax, bpm);
      existing.mixed = existing.mixed || cluster.mixed;
    } else {
      groups.set(name, { name, bpmMin: bpm, bpmMax: bpm, mixed: cluster.mixed });
    }
  }
  return [...groups.values()].slice(0, 4);
}

// The LeoBlack pattern clusters: what the chart is made of, in the analyzer's
// own per-keymode vocabulary (7K says Light Chordstream / Brackets / Shield /
// Jacky WC, 4K says Jumpstream / Rolls / ...). These are composition, not
// difficulty, so the value per pattern is the BPM it runs at. One inline row,
// importance-ordered with the dominant pattern tinted; no box of its own.
function ClustersBlock({ analysis, pending }: { analysis: LiveChartAnalysisDetail | null; pending: boolean }) {
  const groups =
    analysis && analysis.status === "ready" && analysis.clusters.length > 0 ? groupClusters(analysis.clusters) : [];
  // Done loading and genuinely nothing to show: collapse the row entirely.
  if (!pending && groups.length === 0) return null;
  // Fixed single-line height on desktop so the async result landing (or a diff
  // with more/wider pattern groups) can't grow this row and re-center the whole
  // centered modal. The pending "analyzing" state and the loaded state share the
  // exact height, so switching to an un-cached diff no longer jumps. On mobile
  // the card already sits at max-height (its scroll area absorbs changes), so we
  // let the strip wrap there instead of clipping pattern info.
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 overflow-hidden sm:h-[22px] sm:flex-nowrap">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Patterns</span>
      {groups.map((group, index) => (
        <span key={group.name} className="flex shrink-0 items-baseline gap-1.5">
          <span
            className={`text-[12.5px] font-semibold tabular-nums leading-none ${
              index === 0 ? "text-osu-pink-light" : "text-osu-l2"
            }`}
          >
            {group.bpmMin === group.bpmMax ? `${group.mixed ? "~" : ""}${group.bpmMin}` : `${group.bpmMin}-${group.bpmMax}`}
            <span className="ml-0.5 text-[9px] font-normal text-osu-f1/55">bpm</span>
          </span>
          <span className="text-[9px] uppercase tracking-wide text-osu-f1/55">{group.name}</span>
        </span>
      ))}
      {pending && groups.length === 0 && (
        <span className="text-[9px] uppercase tracking-wide text-osu-f1/35">analyzing…</span>
      )}
    </div>
  );
}

export function MapDetailModal({ entry, onClose }: { entry: LiveMapSearchEntry | null; onClose: () => void }) {
  // Which diff of the set is in focus; defaults to the entry's representative.
  const [selectedDiffId, setSelectedDiffId] = useState<number | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    setSelectedDiffId(entry ? entry.beatmapId : null);
    setShareCopied(false);
  }, [entry]);

  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [entry, onClose]);

  const diffs = useMemo(() => (entry ? entryDiffs(entry) : []), [entry]);
  const mixedKeys = useMemo(() => new Set(diffs.map((diff) => diff.keyCount)).size > 1, [diffs]);
  const active = diffs.find((diff) => diff.beatmapId === selectedDiffId) ?? entry;

  const previewSet = useMemo(
    () => (entry && diffs.length > 0 ? buildPreviewBeatmapset(entry, diffs) : null),
    [entry, diffs],
  );

  const patterns = useMemo(
    () => (active ? Object.entries(active.patterns).sort((a, b) => b[1] - a[1]) : []),
    [active],
  );

  // The active diff's detected subfamily tags (bracket, speedjack, ...), all
  // of them: the modal is the exhaustive view, unlike the cards' capped strip.
  const subTags = useMemo(
    () => (active ? subPatternTags([active], [active.primaryPattern], Infinity) : []),
    [active],
  );

  // Chart-analysis detail per diff, fetched lazily so the modal can show the
  // LeoBlack cluster readout (the chart's own keymode vocabulary). Keyed by
  // beatmap id: switching diffs and reopening the modal stay warm.
  const [analysisByBeatmap, setAnalysisByBeatmap] = useState<Record<number, LiveChartAnalysisDetail | null>>({});
  const activeBeatmapId = active?.beatmapId ?? null;
  useEffect(() => {
    if (activeBeatmapId == null) return;
    if (analysisByBeatmap[activeBeatmapId] !== undefined) return;
    let cancelled = false;
    void fetchLiveChartAnalysis(activeBeatmapId).then((detail) => {
      if (cancelled) return;
      setAnalysisByBeatmap((prev) => ({ ...prev, [activeBeatmapId]: detail }));
    });
    return () => {
      cancelled = true;
    };
  }, [activeBeatmapId, analysisByBeatmap]);
  const activeAnalysis = activeBeatmapId != null ? analysisByBeatmap[activeBeatmapId] ?? null : null;
  // True while a freshly selected diff's analysis is still being fetched (its
  // slot is `undefined`, not `null`). Used to hold the Patterns row's height so
  // the async result landing can't grow the card and re-center the modal.
  const analysisPending = activeBeatmapId != null && analysisByBeatmap[activeBeatmapId] === undefined;

  if (typeof document === "undefined") return null;

  // Same enter/exit recipe as the maps tabs' details modal: quick opacity
  // fades, but the panel is its own composited layer (modal-card-mobile-safe:
  // translateZ(0) + contain: paint) with an opaque in-layer backdrop, so a
  // dropped frame on phones can't paint the content see-through mid-fade.
  return createPortal(
    <AnimatePresence>
      {entry && active && previewSet && (
        <motion.div
          key="map-detail"
          className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/85" onClick={onClose} />
          <motion.div
            className="modal-card-mobile-safe relative isolate z-10 w-full max-w-[760px] max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-3rem)] overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl flex flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
          >
            <div className="pointer-events-none absolute inset-0 bg-osu-b5" aria-hidden="true" />
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              {/* Header banner */}
              <div className="relative h-[92px] shrink-0">
                <img
                  src={mapCoverUrl(entry)}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-osu-b5 via-osu-b5/70 to-black/40" />
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="absolute top-2.5 right-2.5 z-10 grid h-7 w-7 place-items-center rounded-full bg-black/50 text-white/80 hover:bg-black/70 hover:text-white transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-4 w-4">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
                <div className="absolute inset-x-0 bottom-0 p-3.5 pr-12">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">{active.keyCount}K</span>
                    <StarRatingBadge stars={active.stars} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-white/70">{active.status}</span>
                  </div>
                  <h2 className="mt-1 text-[17px] font-bold text-white leading-tight truncate drop-shadow">{entry.title}</h2>
                  <p className="text-[11px] text-white/75 truncate">
                    {entry.artist}
                    {entry.creator ? <span className="text-white/50"> · mapped by {entry.creator}</span> : null}
                    <span className="text-white/50"> · [{active.version}]</span>
                  </p>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
                {/* Diff picker: every matching diff of the set, easiest first */}
                {diffs.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {diffs.map((diff) => {
                      const isActive = diff.beatmapId === active.beatmapId;
                      return (
                        <button
                          key={diff.beatmapId}
                          type="button"
                          onClick={() => setSelectedDiffId(diff.beatmapId)}
                          aria-pressed={isActive}
                          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] font-semibold cursor-pointer transition-colors ${
                            isActive ? "bg-osu-b3 text-white" : "bg-osu-b4/60 text-osu-l2 hover:bg-osu-b4 hover:text-osu-l1"
                          }`}
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full ring-1 ring-white/15"
                            style={{ background: starRatingColor(diff.stars) }}
                          />
                          {mixedKeys && <span className="text-osu-f1">{diff.keyCount}K</span>}
                          <span className="max-w-[180px] truncate">{diff.version}</span>
                          <span className="tabular-nums text-osu-yellow">★{diff.stars.toFixed(2)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Stats */}
                <div className="grid grid-cols-4 gap-2 rounded-lg bg-osu-b4/50 px-4 py-2.5">
                  <Stat label="BPM" value={String(Math.round(active.bpm))} />
                  <Stat label="Length" value={formatDuration(active.length)} />
                  <Stat label="Plays" value={formatNumber(active.playCount)} />
                  <Stat label="LN notes" value={formatNumber(active.lnCount)} />
                </div>

                {/* MSD skillsets when the chart analysis has landed; the old
                    relative pattern mix stays as the fallback until then. */}
                {active.msd ? <MsdBlock entry={active} msdLn={activeAnalysis?.msdLn ?? null} /> : null}
                <ClustersBlock analysis={activeAnalysis} pending={analysisPending} />

                {/* Detected subfamily tags from the in-house analyzer: chart
                    attributes (bracket, speedjack, ...), distinct from the
                    family identity chips and the BPM cluster readout above. */}
                {subTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                    <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Tags</span>
                    {subTags.map((pattern) => (
                      <SubPatternChip key={pattern} pattern={pattern} />
                    ))}
                  </div>
                )}

                {/* Pattern profile: radar + the raw numbers */}
                {!active.msd && patterns.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Pattern profile</span>
                    <div className="grid items-center gap-3 rounded-lg bg-osu-b4/40 p-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
                      <div className="flex justify-center">
                        <PatternRadar patterns={active.patterns} />
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {patterns.map(([pattern, value]) => {
                          const color = PATTERN_COLOR[pattern] ?? "#cfcfe6";
                          const isPrimary = pattern === active.primaryPattern;
                          return (
                            <div key={pattern} className="flex items-center justify-between gap-2">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                                <span className={`truncate text-[11.5px] ${isPrimary ? "font-bold text-osu-l1" : "text-osu-l2"}`}>
                                  {patternLabel(pattern)}
                                </span>
                              </span>
                              <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-osu-l1">
                                {(value * active.stars * 10).toFixed(1)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Chart preview */}
                <ChartPreviewPanel
                  beatmapset={previewSet}
                  selectedBeatmapId={active.beatmapId}
                  className="h-[300px] rounded-lg"
                  flatBackdrop
                />

                {/* Actions */}
                <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
                  <a
                    href={osuBeatmapUrl(active)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-pink px-3 py-2 text-[12px] font-bold text-white hover:bg-osu-pink-light transition-colors sm:justify-start sm:px-3"
                  >
                    osu! web
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                  <a
                    href={oszDownloadUrl(entry.beatmapsetId)}
                    className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors sm:justify-start sm:px-3"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                      <path d="M12 3v10" />
                      <path d="m7 10 5 4 5-4" />
                      <path d="M5 20h14" />
                    </svg>
                    Download .osz
                  </a>
                  <a
                    href={osuDirectUrl(entry.beatmapsetId)}
                    className="hidden items-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors sm:inline-flex"
                  >
                    <OsuLogo className="h-3.5 w-3.5" />
                    Open in osu!
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      // /maps?map=<id> reopens this modal for whoever gets the
                      // link; the selected diff rides along in the id.
                      const url = `${window.location.origin}/maps?map=${active.beatmapId}`;
                      void navigator.clipboard?.writeText(url).then(() => {
                        setShareCopied(true);
                        window.setTimeout(() => setShareCopied(false), 1600);
                      }).catch(() => {});
                    }}
                    className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors cursor-pointer sm:justify-start sm:px-3"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    {shareCopied ? "Link copied!" : "Share"}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
