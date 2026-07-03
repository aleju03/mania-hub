import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import type { LiveMapSearchEntry } from "../../lib/live-backend";
import type { MapsFavouriteBeatmapset } from "../../lib/types";
import { formatDuration, formatNumber } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { ChartPreviewPanel } from "./ChartPreviewPanel";
import { PatternRadar } from "./PatternRadar";
import {
  PATTERN_COLOR,
  entryDiffs,
  mapCoverUrl,
  osuBeatmapUrl,
  osuDirectUrl,
  oszDownloadUrl,
  patternLabel,
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

export function MapDetailModal({ entry, onClose }: { entry: LiveMapSearchEntry | null; onClose: () => void }) {
  // Which diff of the set is in focus; defaults to the entry's representative.
  const [selectedDiffId, setSelectedDiffId] = useState<number | null>(null);

  useEffect(() => {
    setSelectedDiffId(entry ? entry.beatmapId : null);
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
                <img src={mapCoverUrl(entry)} alt="" className="absolute inset-0 h-full w-full object-cover" />
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
                    <span className="rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white">{active.keyCount}K</span>
                    <span className="rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-osu-yellow">★{active.stars.toFixed(2)}</span>
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

                {/* Pattern profile: radar + the raw numbers */}
                {patterns.length > 0 && (
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
