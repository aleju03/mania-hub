import type { LiveMapSearchEntry } from "../../lib/live-backend";
import { formatDuration, formatNumber } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { MapPreviewButton, MapPreviewProgressBar, type MapPreviewAudio } from "./MapPreviewAudio";

// Shared presentation for a single chart-analyzed map across the global Search
// results and inside Collection detail. Country-agnostic: no player avatars,
// just the chart's identity, pattern mix, and download/open actions.

export const PATTERN_LABEL: Record<string, string> = {
  jack: "Jack",
  stream: "Stream",
  jumpstream: "Jumpstream",
  handstream: "Handstream",
  stamina: "Stamina",
  chordjack: "Chordjack",
  tech: "Tech",
  ln: "LN",
};

export const PATTERN_COLOR: Record<string, string> = {
  jack: "#ec6a9c",
  stream: "#5ab2f2",
  jumpstream: "#46c7b8",
  handstream: "#f3c24a",
  stamina: "#ef9a4d",
  chordjack: "#b483f0",
  tech: "#83cf6b",
  ln: "#f07474",
};

export function patternLabel(pattern: string): string {
  return PATTERN_LABEL[pattern] ?? pattern;
}

// osu-web's difficulty colour spectrum, interpolated linearly between the
// official stops so diff dots read the same as on the osu! site.
const STAR_COLOR_STOPS: Array<[number, number, number, number]> = [
  [0.1, 0x42, 0x90, 0xfb],
  [1.25, 0x4f, 0xc0, 0xff],
  [2.0, 0x4f, 0xff, 0xd5],
  [2.5, 0x7c, 0xff, 0x4f],
  [3.3, 0xf6, 0xf0, 0x5c],
  [4.2, 0xff, 0x80, 0x68],
  [4.9, 0xff, 0x4e, 0x6f],
  [5.8, 0xc6, 0x45, 0xb8],
  [6.7, 0x65, 0x63, 0xde],
  [7.7, 0x18, 0x15, 0x8e],
  [9.0, 0x00, 0x00, 0x00],
];

export function starRatingColor(stars: number): string {
  const first = STAR_COLOR_STOPS[0];
  const last = STAR_COLOR_STOPS[STAR_COLOR_STOPS.length - 1];
  if (!Number.isFinite(stars) || stars <= first[0]) return `rgb(${first[1]}, ${first[2]}, ${first[3]})`;
  if (stars >= last[0]) return `rgb(${last[1]}, ${last[2]}, ${last[3]})`;
  for (let i = 1; i < STAR_COLOR_STOPS.length; i++) {
    const [hiStars, hr, hg, hb] = STAR_COLOR_STOPS[i];
    if (stars > hiStars) continue;
    const [loStars, lr, lg, lb] = STAR_COLOR_STOPS[i - 1];
    const t = (stars - loStars) / (hiStars - loStars);
    const r = Math.round(lr + (hr - lr) * t);
    const g = Math.round(lg + (hg - lg) * t);
    const b = Math.round(lb + (hb - lb) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return `rgb(${last[1]}, ${last[2]}, ${last[3]})`;
}

// The matching diffs of a search entry's set, easiest first. Collection items
// and older payloads carry no diff list, so the entry stands alone.
export function entryDiffs(entry: LiveMapSearchEntry): LiveMapSearchEntry[] {
  if (!entry.diffs || entry.diffs.length === 0) return [entry];
  return [...entry.diffs].sort((a, b) => a.keyCount - b.keyCount || a.stars - b.stars || a.beatmapId - b.beatmapId);
}

export function mapCoverUrl(entry: Pick<LiveMapSearchEntry, "covers" | "beatmapsetId">): string {
  return (
    entry.covers?.["card@2x"] ??
    entry.covers?.card ??
    entry.covers?.list ??
    entry.covers?.cover ??
    `https://assets.ppy.sh/beatmaps/${entry.beatmapsetId}/covers/card@2x.jpg`
  );
}

export function osuBeatmapUrl(entry: Pick<LiveMapSearchEntry, "beatmapId" | "beatmapsetId">): string {
  return `https://osu.ppy.sh/beatmapsets/${entry.beatmapsetId}#mania/${entry.beatmapId}`;
}

// osu!direct scheme: opens the set in the osu! client (matches the random tab).
export function osuDirectUrl(beatmapsetId: number): string {
  return `osu://dl/${beatmapsetId}`;
}

// Direct .osz download via a mirror (no server proxy). catboy.best mirrors the
// same hosts the backend's archive layer uses.
export function oszDownloadUrl(beatmapsetId: number): string {
  return `https://catboy.best/d/${beatmapsetId}`;
}

function statusPill(status: string): { label: string; className: string } | null {
  const s = status.toLowerCase();
  if (s === "ranked" || s === "approved") return { label: "ranked", className: "bg-[#6cf27f] text-black" };
  if (s === "loved") return { label: "loved", className: "bg-[#f26fa6] text-black" };
  if (s === "qualified") return { label: "qualified", className: "bg-[#66ccff] text-black" };
  return null;
}

function secondaryPatterns(entry: LiveMapSearchEntry): string[] {
  return Object.entries(entry.patterns)
    .filter(([key, value]) => key !== entry.primaryPattern && value >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key]) => key);
}

// For a multi-diff card the tags describe the set: each distinct dominant
// pattern across the matching diffs, most common first.
function setPatterns(diffs: LiveMapSearchEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const diff of diffs) {
    if (!PATTERN_LABEL[diff.primaryPattern]) continue;
    counts.set(diff.primaryPattern, (counts.get(diff.primaryPattern) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key]) => key);
}

function keyModeLabel(diffs: LiveMapSearchEntry[]): string {
  const modes = [...new Set(diffs.map((diff) => diff.keyCount))].sort((a, b) => a - b);
  if (modes.length > 2) return `${modes[0]}K–${modes[modes.length - 1]}K`;
  return modes.map((keys) => `${keys}K`).join("·");
}

const MAX_DIFF_DOTS = 10;

export function SearchCard({
  entry,
  onOpen,
  preview,
}: {
  entry: LiveMapSearchEntry;
  onOpen?: (entry: LiveMapSearchEntry) => void;
  preview?: MapPreviewAudio;
}) {
  const pill = statusPill(entry.status);
  const diffs = entryDiffs(entry);
  const multi = diffs.length > 1;
  const starLo = Math.min(...diffs.map((diff) => diff.stars));
  const starHi = Math.max(...diffs.map((diff) => diff.stars));
  const patternTags = multi ? setPatterns(diffs) : [entry.primaryPattern, ...secondaryPatterns(entry)];
  const clickable = !!onOpen;

  return (
    <div
      className={`rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/40 transition-colors flex flex-col ${clickable ? "cursor-pointer" : ""}`}
      onClick={clickable ? () => onOpen(entry) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(entry); } } : undefined}
      title={clickable ? "View details" : undefined}
    >
      <div className="relative rounded-t-xl overflow-hidden">
        <img src={mapCoverUrl(entry)} alt="" className="w-full h-[100px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-[10px] font-bold text-white">
          {keyModeLabel(diffs)}
        </span>
        <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/60 text-[10px] font-bold text-osu-yellow">
          {multi && starHi - starLo >= 0.05
            ? `★${starLo.toFixed(1)}–${starHi.toFixed(1)}`
            : `★${entry.stars.toFixed(2)}`}
        </span>
        {pill && (
          <span className={`absolute bottom-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase leading-none ${pill.className}`}>
            {pill.label}
          </span>
        )}
        <div className="absolute bottom-0 left-0 right-0 px-3 pb-2 pr-20">
          <div className="text-[13px] font-semibold text-white truncate leading-tight drop-shadow-lg">{entry.title}</div>
          <div className="text-[11px] text-white/70 truncate leading-tight drop-shadow-lg">{entry.artist}</div>
        </div>
        {preview && preview.playingSetId === entry.beatmapsetId && <MapPreviewProgressBar preview={preview} />}
      </div>

      <div className="px-3 py-2.5 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-1.5">
          {multi ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="flex items-center gap-[3px]">
                {diffs.slice(0, MAX_DIFF_DOTS).map((diff) => (
                  <span
                    key={diff.beatmapId}
                    className="h-2.5 w-2.5 rounded-full ring-1 ring-white/15"
                    style={{ background: starRatingColor(diff.stars) }}
                    title={`[${diff.version}] ★${diff.stars.toFixed(2)}`}
                  />
                ))}
              </span>
              <span className="truncate text-[11px] text-osu-l2">{diffs.length} diffs</span>
            </span>
          ) : (
            <span className="text-[11px] text-osu-l2 truncate flex-1">[{entry.version}]</span>
          )}
          <span className="text-[10px] text-osu-f1 flex-shrink-0">{formatDuration(entry.length)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {patternTags.map((pattern, index) => (
            <span
              key={pattern}
              className={
                index === 0
                  ? "px-2 py-1 rounded bg-osu-pink/20 text-osu-pink-light text-[10px] font-semibold leading-none"
                  : "px-2 py-1 rounded bg-osu-b3/50 text-osu-f1 text-[10px] leading-none"
              }
            >
              {patternLabel(pattern)}
            </span>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {preview && <MapPreviewButton beatmapsetId={entry.beatmapsetId} preview={preview} />}
            <span className="text-[10px] text-osu-f1 truncate" title={`${entry.creator ? `mapped by ${entry.creator} · ` : ""}${formatNumber(entry.playCount)} plays`}>
              {formatNumber(entry.playCount)} plays
            </span>
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <a
              href={osuDirectUrl(entry.beatmapsetId)}
              onClick={(e) => e.stopPropagation()}
              className="hidden items-center gap-1 px-2 py-1 rounded bg-osu-b3/50 text-osu-l2 text-[10px] hover:bg-osu-b3 transition-colors sm:inline-flex"
              title="Open in osu! client"
            >
              <OsuLogo className="h-3 w-3" />
              osu!
            </a>
            <a
              href={oszDownloadUrl(entry.beatmapsetId)}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-osu-pink/20 text-osu-pink-light text-[10px] font-semibold hover:bg-osu-pink/30 transition-colors"
              title="Download .osz"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                <path d="M12 3v10" />
                <path d="m7 10 5 4 5-4" />
                <path d="M5 20h14" />
              </svg>
              osz
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
