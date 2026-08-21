import { useCallback, useState } from "react";
import { Plural, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { LiveMapSearchEntry } from "../../lib/live-backend";
import { oszDownloadUrl } from "../../lib/beatmap-mirrors";
import { formatDuration, formatNumber } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { MapPreviewButton, type MapPreviewAudio, type MapPreviewTrack } from "./MapPreviewAudio";
import { starRatingColor, starSpectrumGradient, StarRatingBadge } from "../ui/StarRating";

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

// Same table as PATTERN_LABEL, in descriptor form: `PATTERN_LABEL` stays the
// English one for membership checks and non-React callers, `PATTERN_LABEL_MSG`
// is what the DOM renders through an i18n instance.
export const PATTERN_LABEL_MSG: Record<string, MessageDescriptor> = {
  jack: msg`Jack`,
  stream: msg`Stream`,
  jumpstream: msg`Jumpstream`,
  handstream: msg`Handstream`,
  stamina: msg`Stamina`,
  chordjack: msg`Chordjack`,
  tech: msg`Tech`,
  ln: msg`LN`,
  speedjack: msg`Speedjack`,
  handjack: msg`Handjack`,
  dumpstream: msg`Dumpstream`,
  quadstream: msg`Quadstream`,
  chordstream: msg`Chordstream`,
  delay: msg`Delay`,
  bracket: msg`Bracket`,
  lngeneral: msg`LN General`,
  lnrelease: msg`LN Release`,
  lninverse: msg`LN Inverse`,
  lntech: msg`LN Tech`,
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

// Localized pattern label for DOM consumers. Unknown ids (an older payload, a
// shared URL) fall through to the raw id, exactly like patternLabel().
export function usePatternLabel(): (pattern: string) => string {
  const { i18n } = useLingui();
  return useCallback(
    (pattern: string) => {
      const descriptor = PATTERN_LABEL_MSG[pattern];
      return descriptor ? i18n._(descriptor) : pattern;
    },
    [i18n],
  );
}

// The star spectrum and its badge moved to ui/StarRating so score panels can
// use them without this file's audio-preview dependencies; re-exported here
// for the map surfaces that already import them from the card.
export { starRatingColor, starSpectrumGradient, StarRatingBadge };

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

// What the preview player bar shows and skips through, in grid order. The
// list cover is enough: it renders at 36px.
export function toPreviewTrack(entry: LiveMapSearchEntry): MapPreviewTrack {
  return {
    beatmapsetId: entry.beatmapsetId,
    title: entry.title,
    artist: entry.artist,
    coverUrl: entry.covers?.["list@2x"] ?? entry.covers?.list ?? mapCoverUrl(entry),
  };
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

function statusPill(status: string): { label: MessageDescriptor; className: string } | null {
  const s = status.toLowerCase();
  if (s === "ranked" || s === "approved") return { label: msg`ranked`, className: "bg-[#6cf27f] text-black" };
  if (s === "loved") return { label: msg`loved`, className: "bg-[#f26fa6] text-black" };
  if (s === "qualified") return { label: msg`qualified`, className: "bg-[#66ccff] text-black" };
  if (s === "graveyard") return { label: msg`graveyard`, className: "bg-[#4a4a52] text-white" };
  if (s === "pending" || s === "wip") return { label: msg`pending`, className: "bg-[#f2b56c] text-black" };
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
  const label = usePatternLabel();
  return (
    <span className="px-2 py-[3px] rounded border border-osu-b3/60 text-osu-f1 text-[10px] leading-none">
      {label(pattern)}
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
  const { t, i18n } = useLingui();
  const patternName = usePatternLabel();
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
      title={clickable ? t`View details` : undefined}
    >
      <div className="relative h-[100px] rounded-t-xl overflow-hidden">
        <div className="absolute inset-0 bg-osu-b3/40" />
        {coverFailed && (
          <div className="absolute inset-0 flex items-center justify-center">
            {/* Stays English: the osu! "no bg" placeholder joke, in a font with no CJK glyphs. */}
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
            {i18n._(pill.label)}
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
              <span className="truncate text-[11px] text-osu-l2">
                <Plural value={diffs.length} one="# diff" other="# diffs" />
              </span>
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
              {patternName(pattern)}
            </span>
          ))}
          {subTags.map((pattern) => (
            <SubPatternChip key={pattern} pattern={pattern} />
          ))}
          {vibro && (
            <span
              className="px-2 py-1 rounded bg-[#ffb02e]/15 text-[#ffcf70] text-[10px] font-semibold leading-none"
              title={t`Vibro chart: difficulty estimates are unreliable`}
            >
              {t`Vibro`}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {preview && <MapPreviewButton beatmapsetId={entry.beatmapsetId} preview={preview} />}
            <span
              className="text-[10px] text-osu-f1 truncate"
              title={entry.creator
                ? t`mapped by ${entry.creator} · ${formatNumber(entry.playCount)} plays`
                : t`${formatNumber(entry.playCount)} plays`}
            >
              {t`${formatNumber(entry.playCount)} plays`}
            </span>
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <a
              href={osuDirectUrl(entry.beatmapsetId)}
              onClick={(e) => e.stopPropagation()}
              className="hidden items-center gap-1 px-2 py-1 rounded bg-osu-b3/50 text-osu-l2 text-[10px] hover:bg-osu-b3 transition-colors sm:inline-flex"
              title={t`Open in osu! client`}
            >
              <OsuLogo className="h-3 w-3" />
              osu!
            </a>
            <a
              href={oszDownloadUrl(entry.beatmapsetId)}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-osu-pink/20 text-osu-pink-light text-[10px] font-semibold hover:bg-osu-pink/30 transition-colors"
              title={t`Download .osz`}
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
