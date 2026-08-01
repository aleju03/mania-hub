import { useState } from "react";
import type { LiveMapSearchEntry } from "../../lib/live-backend";
import { oszDownloadUrl } from "../../lib/beatmap-mirrors";
import { formatDuration, formatNumber } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { MapPreviewButton, type MapPreviewAudio } from "./MapPreviewAudio";

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
  // subfamilies from the pattern analyzer (filterable via detected tags)
  speedjack: "Speedjack",
  handjack: "Handjack",
  dumpstream: "Dumpstream",
  quadstream: "Quadstream",
  chordstream: "Chordstream",
  delay: "Delay",
  bracket: "Bracket",
  lngeneral: "LN General",
  lnrelease: "LN Release",
  lninverse: "LN Inverse",
  lntech: "LN Tech",
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
  // subfamilies inherit their family's color
  speedjack: "#ec6a9c",
  handjack: "#ec6a9c",
  dumpstream: "#5ab2f2",
  quadstream: "#5ab2f2",
  chordstream: "#5ab2f2",
  delay: "#5ab2f2",
  bracket: "#5ab2f2",
  lngeneral: "#f07474",
  lnrelease: "#f07474",
  lninverse: "#f07474",
  lntech: "#f07474",
};

export function patternLabel(pattern: string): string {
  return PATTERN_LABEL[pattern] ?? pattern;
}

// osu-web's difficulty colour spectrum, interpolated between the official
// stops with gamma-2.2 RGB (d3 interpolateRgb.gamma(2.2), same as osu-web)
// so diff dots read the same as on the osu! site.
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
    const GAMMA = 2.2;
    const mix = (a: number, b: number) =>
      Math.round(Math.pow(Math.pow(a, GAMMA) + (Math.pow(b, GAMMA) - Math.pow(a, GAMMA)) * t, 1 / GAMMA));
    return `rgb(${mix(lr, hr)}, ${mix(lg, hg)}, ${mix(lb, hb)})`;
  }
  return `rgb(${last[1]}, ${last[2]}, ${last[3]})`;
}

// CSS gradient of the spectrum across [lo, hi] stars, for painting slider
// tracks. Stops past the last defined star (9.0) stay black, like osu-web.
// `position` maps a star value to its 0..1 spot in the gradient, for tracks
// that don't lay stars out linearly (defaults to linear).
export function starSpectrumGradient(lo: number, hi: number, position?: (stars: number) => number): string {
  const span = hi - lo || 1;
  const pos = position ?? ((stars: number) => (stars - lo) / span);
  const stops = [`${starRatingColor(lo)} 0%`];
  for (const [stars] of STAR_COLOR_STOPS) {
    if (stars <= lo || stars >= hi) continue;
    stops.push(`${starRatingColor(stars)} ${(pos(stars) * 100).toFixed(2)}%`);
  }
  stops.push(`${starRatingColor(hi)} 100%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

// osu-web's difficulty-badge: pill filled with the spectrum colour, dark text
// that flips to the expert-plus yellow at 6.5★ and above.
export function StarRatingBadge({ stars, label, className = "" }: { stars: number; label?: string; className?: string }) {
  const textColor = stars >= 6.5 ? "hsl(45, 100%, 70%)" : "hsl(200, 10%, 10%)";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums ${className}`}
      style={{ background: starRatingColor(stars), color: textColor }}
    >
      <svg viewBox="0 0 24 24" className="h-[9px] w-[9px]" fill="currentColor" aria-hidden="true">
        <path d="M12 1.7l3.1 6.9 7.2.8-5.4 5 1.5 7.2L12 17.9l-6.4 3.7 1.5-7.2-5.4-5 7.2-.8L12 1.7z" />
      </svg>
      {label ?? stars.toFixed(2)}
    </span>
  );
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

// .osz download via /api/osz, which probes the mirror list server-side and
// 302s to a healthy one; the archive bytes still flow mirror-to-browser.
export { oszDownloadUrl } from "../../lib/beatmap-mirrors";

function statusPill(status: string): { label: string; className: string } | null {
  const s = status.toLowerCase();
  if (s === "ranked" || s === "approved") return { label: "ranked", className: "bg-[#6cf27f] text-black" };
  if (s === "loved") return { label: "loved", className: "bg-[#f26fa6] text-black" };
  if (s === "qualified") return { label: "qualified", className: "bg-[#66ccff] text-black" };
  if (s === "graveyard") return { label: "graveyard", className: "bg-[#4a4a52] text-white" };
  if (s === "pending" || s === "wip") return { label: "pending", className: "bg-[#f2b56c] text-black" };
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

const MAX_CARD_SUB_TAGS = 2;

// Detected subfamily tags (bracket, speedjack, lngeneral, ...) for the card:
// an attribute strip after the family chips. Works for both card shapes: a
// single-diff card passes [entry], a multi-diff card unions the set's tags,
// most common first. The vocabularies are disjoint by construction, but the
// tags are still deduped against the family chips so an overlap can't render
// a chip twice.
export function subPatternTags(diffs: LiveMapSearchEntry[], familyTags: string[], max = MAX_CARD_SUB_TAGS): string[] {
  const counts = new Map<string, number>();
  for (const diff of diffs) {
    for (const tag of diff.patternTags ?? []) {
      if (!PATTERN_LABEL[tag] || familyTags.includes(tag)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([tag]) => tag);
}

// Subfamily chip: outlined rather than filled, so detected subpattern tags
// read as attributes of the chart, distinct from the filled family chips that
// state its identity. py compensates for the border to match chip heights.
export function SubPatternChip({ pattern }: { pattern: string }) {
  return (
    <span className="px-2 py-[3px] rounded border border-osu-b3/60 text-osu-f1 text-[10px] leading-none">
      {patternLabel(pattern)}
    </span>
  );
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
  const [coverFailed, setCoverFailed] = useState(false);
  const diffs = entryDiffs(entry);
  const multi = diffs.length > 1;
  const starLo = Math.min(...diffs.map((diff) => diff.stars));
  const starHi = Math.max(...diffs.map((diff) => diff.stars));
  const familyTags = multi ? setPatterns(diffs) : [entry.primaryPattern, ...secondaryPatterns(entry)];
  const subTags = subPatternTags(diffs, familyTags);
  const vibro = diffs.some((diff) => diff.vibro) || entry.vibro === true;
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
      <div className="relative h-[100px] rounded-t-xl overflow-hidden">
        <div className="absolute inset-0 bg-osu-b3/40" />
        {coverFailed && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span
              className="text-[13px] text-osu-f1/45"
              style={{ fontFamily: '"Comic Sans MS", "Comic Neue", ui-rounded, cursive', fontStyle: "italic" }}
            >
              no bg
            </span>
          </div>
        )}
        <img
          src={mapCoverUrl(entry)}
          alt=""
          className={`relative w-full h-[100px] object-cover ${coverFailed ? "invisible" : ""}`}
          loading="lazy"
          onError={() => setCoverFailed(true)}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        <span className="absolute top-2 left-2 inline-flex items-center gap-1">
          <span className="inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">
            {keyModeLabel(diffs)}
          </span>
        </span>
        <StarRatingBadge
          stars={multi ? starHi : entry.stars}
          label={multi && starHi - starLo >= 0.05 ? `${starLo.toFixed(1)}–${starHi.toFixed(1)}` : undefined}
          className="absolute top-2 right-2"
        />
        {pill && (
          <span className={`absolute bottom-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase leading-none ${pill.className}`}>
            {pill.label}
          </span>
        )}
        <div className="absolute bottom-0 left-0 right-0 px-3 pb-2 pr-20">
          <div className="text-[13px] font-semibold text-white truncate leading-tight drop-shadow-lg">{entry.title}</div>
          <div className="text-[11px] text-white/70 truncate leading-tight drop-shadow-lg">{entry.artist}</div>
        </div>
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
          {familyTags.map((pattern, index) => (
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
          {subTags.map((pattern) => (
            <SubPatternChip key={pattern} pattern={pattern} />
          ))}
          {vibro && (
            <span
              className="px-2 py-1 rounded bg-[#ffb02e]/15 text-[#ffcf70] text-[10px] font-semibold leading-none"
              title="Vibro chart: difficulty estimates are unreliable"
            >
              Vibro
            </span>
          )}
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
