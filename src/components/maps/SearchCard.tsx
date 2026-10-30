import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { usesPrism } from "#dan/prism/switch";
import { HoverTip } from "../ui/HoverTip";
import { resolveShownMsd } from "../../lib/shown-msd";
import { ensureMapPlaceholderFont } from "../../lib/replay-fonts";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { LiveMapSearchEntry } from "../../lib/live-backend";
import { oszDownloadUrl } from "../../lib/beatmap-mirrors";
import { formatDuration } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { BeatmapStatusBadge } from "../ui/BeatmapStatusBadge";
import { Skeleton } from "../ui/LoadingSkeleton";
import { MapPreviewButton, type MapPreviewAudio, type MapPreviewTrack } from "./MapPreviewAudio";
import { starRatingColor, starSpectrumGradient, starTextColor, StarRatingBadge } from "../ui/StarRating";
import { DAN_SKILLSET_META, msdSkillsetMeta } from "../../lib/skill-axes";

// Shared presentation for a single chart-analyzed map across the global Search
// results and inside Collection detail. Country-agnostic: no player avatars,
// just the chart's identity, pattern mix, and download/open actions.

// Pattern presentation now lives in lib/pattern-labels (see the note there);
// re-exported here because the maps surfaces import it from the card.
import { PATTERN_COLOR, PATTERN_LABEL, usePatternLabel } from "../../lib/pattern-labels";
export { PATTERN_COLOR, PATTERN_LABEL, PATTERN_LABEL_MSG, patternLabel, usePatternLabel } from "../../lib/pattern-labels";

// The star spectrum and its badge moved to ui/StarRating so score panels can
// use them without this file's audio-preview dependencies; re-exported here
// for the map surfaces that already import them from the card.
export { starRatingColor, starSpectrumGradient, starTextColor, StarRatingBadge };

// The matching diffs of a search entry's set, easiest first. Collection items
// and older payloads carry no diff list, so the entry stands alone.
// A diff's stars at a speed mod or on Sunny's scale, falling back to osu!'s
// nomod value where the chart has none.
export function starsAtRate(entry: LiveMapSearchEntry, rate: "ht" | "dt" | "" | undefined, scale?: "sunny" | ""): number {
  const atRate = scale === "sunny"
    ? rate === "ht" ? entry.sunnyHt : rate === "dt" ? entry.sunnyDt : entry.sunnyStars
    : rate === "ht" ? entry.starsHt : rate === "dt" ? entry.starsDt : null;
  return atRate != null && atRate > 0 ? atRate : entry.stars;
}

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

// Family identity chips for one diff: the primary first, then up to two
// other families at the "has this pattern" bar. Shared by the card and the
// detail modal so the two never disagree on what a chart is.
export function familyPatternTags(entry: LiveMapSearchEntry): string[] {
  return [entry.primaryPattern, ...secondaryPatterns(entry)];
}

// Filled family chip: the primary reads as the chart's identity, the rest as
// families it also carries. Outlined SubPatternChip is for attributes.
export function FamilyPatternChip({ pattern, primary }: { pattern: string; primary: boolean }) {
  const label = usePatternLabel();
  return (
    <span
      className={
        primary
          ? "px-2 py-1 rounded bg-osu-pink/20 text-osu-pink-light text-[10px] font-semibold leading-none"
          : "px-2 py-1 rounded bg-osu-b3/50 text-osu-f1 text-[10px] leading-none"
      }
    >
      {label(pattern)}
    </span>
  );
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
export function setPatterns(diffs: LiveMapSearchEntry[]): string[] {
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

// The rice dan tiles a card files under, merged across the set's diffs into
// one list: the tile most diffs lead with first, then the rest by how many
// diffs carry them ("tech speed" reads Tech/Speed).
export function skillTiles(diffs: LiveMapSearchEntry[]): string[] {
  const leads = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const diff of diffs) {
    const tiles = (diff.danTiles ?? []).filter((tile) => DAN_SKILLSET_META[tile]);
    if (tiles.length === 0) continue;
    leads.set(tiles[0], (leads.get(tiles[0]) ?? 0) + 1);
    for (const tile of tiles) counts.set(tile, (counts.get(tile) ?? 0) + 1);
  }
  return [...counts.keys()].sort((a, b) =>
    (leads.get(b) ?? 0) - (leads.get(a) ?? 0) || (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}

// osu! diff names often lead with their keymode ("[4K] Hard", "7K Another");
// where a badge or row label already says it, the prefix is noise. A name that
// is only the keymode stays as it is.
export function stripKeymodePrefix(version: string): string {
  const stripped = version.replace(/^\s*[[(]?\d{1,2}\s?K[\])]?(?:\s*[-:|]\s*|\s+)/i, "");
  return stripped.trim() ? stripped : version;
}

export function keyModeLabel(diffs: LiveMapSearchEntry[]): string {
  const modes = [...new Set(diffs.map((diff) => diff.keyCount))].sort((a, b) => a - b);
  if (modes.length > 2) return `${modes[0]}K–${modes[modes.length - 1]}K`;
  return modes.map((keys) => `${keys}K`).join(" ");
}

export function Hairline({ className = "bg-white/15" }: { className?: string }) {
  return <span aria-hidden="true" className={`h-3 w-px shrink-0 ${className}`} />;
}

function useCardModel(entry: LiveMapSearchEntry, rate?: "ht" | "dt" | "", starScale?: "sunny" | "") {
  const diffs = entryDiffs(entry);
  const multi = diffs.length > 1;
  const starsOf = (diff: LiveMapSearchEntry) => starsAtRate(diff, rate, starScale);
  const byStars = [...diffs].sort((a, b) => starsOf(a) - starsOf(b));
  const starLo = starsOf(byStars[0]);
  const starHi = starsOf(byStars[byStars.length - 1]);
  // Two tiles at most: a third starts reading as noise.
  const tiles = skillTiles(diffs).slice(0, 2);
  const familyTags = (multi ? setPatterns(diffs) : familyPatternTags(entry)).filter((pattern) => !tiles.includes(pattern));
  const subTags = subPatternTags(diffs, familyTags, 1);
  const vibro = diffs.some((diff) => diff.vibro) || entry.vibro === true;
  return { diffs, byStars, multi, starLo, starHi, tiles, familyTags, subTags, vibro, hardest: byStars[byStars.length - 1] };
}

type CardModel = ReturnType<typeof useCardModel>;

function CoverImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (failed) ensureMapPlaceholderFont();
  }, [failed]);
  return (
    <div className="absolute inset-0 overflow-hidden bg-osu-b3/50">
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center">
          {/* Stays English: the osu! "no bg" placeholder joke, in a font with no CJK glyphs. */}
          <span
            className="text-[13px] text-osu-f1/45"
            style={{ fontFamily: '"Comic Sans MS", "Comic Neue", ui-rounded, cursive', fontStyle: "italic" }}
          >
            <Trans>no bg</Trans>
          </span>
        </div>
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
        />
      )}
    </div>
  );
}

// "Tech / Speed" in each tile's colour, then one pattern word in plain text.
function SkillLine({ model, className = "" }: { model: CardModel; className?: string }) {
  const { i18n, t } = useLingui();
  const label = usePatternLabel();
  const extra = model.tiles.length > 0 ? [...model.familyTags, ...model.subTags][0] : model.subTags[0];
  return (
    <span className={`flex min-w-0 items-center gap-1.5 truncate text-[12px] font-bold leading-none ${className}`}>
      {model.tiles.length > 0
        ? model.tiles.map((tile, index) => (
          <span key={tile} className="inline-flex items-center gap-1.5">
            {index > 0 && <span className="font-normal text-white/35">/</span>}
            <span style={{ color: DAN_SKILLSET_META[tile].color }}>{i18n._(DAN_SKILLSET_META[tile].labelMsg)}</span>
          </span>
        ))
        : model.familyTags.slice(0, 1).map((pattern) => (
          <span key={pattern} style={{ color: PATTERN_COLOR[pattern] ?? "#cfcfe6" }}>{label(pattern)}</span>
        ))}
      {extra ? <span className="truncate font-medium text-osu-l2/80">{label(extra)}</span> : null}
      {model.vibro ? (
        <span
          className="rounded bg-[#ffb02e]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#ffcf70]"
          title={t`Vibro chart: difficulty estimates are unreliable`}
        >
          {t`Vibro`}
        </span>
      ) : null}
    </span>
  );
}

function stop(e: React.SyntheticEvent) {
  e.stopPropagation();
}

export function OsuDirectButton({ beatmapsetId }: { beatmapsetId: number }) {
  const { t } = useLingui();
  return (
    <a
      href={osuDirectUrl(beatmapsetId)}
      onClick={stop}
      title={t`Open in osu! client`}
      aria-label={t`Open in osu! client`}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-osu-l1 transition-colors hover:text-white bg-white/[0.07] hover:bg-white/[0.12]`}
    >
      <OsuLogo className="h-4 w-4" />
    </a>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M12 3v10" />
      <path d="m7 10 5 4 5-4" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function OszButton({ beatmapsetId }: { beatmapsetId: number }) {
  const { t } = useLingui();
  return (
    <a
      href={oszDownloadUrl(beatmapsetId)}
      onClick={stop}
      title={t`Download .osz`}
      aria-label={t`Download .osz`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-osu-pink text-white shadow-[0_2px_10px_-2px] shadow-osu-pink/50 transition-colors hover:bg-osu-pink-light"
    >
      <DownloadIcon />
    </a>
  );
}


type CardProps = {
  entry: LiveMapSearchEntry;
  /** Speed mod the stars are shown at. */
  rate?: "ht" | "dt" | "";
  /** "sunny" shows Sunny's Star Rating Rebirth instead of osu!'s. */
  starScale?: "sunny" | "";
  onOpen?: (entry: LiveMapSearchEntry) => void;
  preview?: MapPreviewAudio;
};

// Short names under the bars, by axis key. Prism (6K-8K) files its skillsets in
// MinaCalc's slots under other names, so the same key reads differently there.
const SKILLSET_ABBR: Record<string, MessageDescriptor> = {
  Stream: msg({ message: "STR", comment: "Short label under a skillset bar: Stream" }),
  Jumpstream: msg({ message: "JS", comment: "Short label under a skillset bar: Jumpstream" }),
  Handstream: msg({ message: "HS", comment: "Short label under a skillset bar: Handstream" }),
  Stamina: msg({ message: "STA", comment: "Short label under a skillset bar: Stamina" }),
  JackSpeed: msg({ message: "JSP", comment: "Short label under a skillset bar: Jackspeed" }),
  Chordjack: msg({ message: "CJ", comment: "Short label under a skillset bar: Chordjack" }),
  Technical: msg({ message: "TEC", comment: "Short label under a skillset bar: Technical" }),
};
const PRISM_SKILLSET_ABBR: Record<string, MessageDescriptor> = {
  Jumpstream: msg({ message: "CS", comment: "Short label under a skillset bar: Chordstream (6K-8K)" }),
  Handstream: msg({ message: "BRK", comment: "Short label under a skillset bar: Bracket (6K-8K)" }),
  Chordjack: msg({ message: "JK", comment: "Short label under a skillset bar: Jack (6K-8K)" }),
  Speed: msg({ message: "DLY", comment: "Short label under a skillset bar: Delay (6K-8K)" }),
};

function SkillsetBars({ diff }: { diff: LiveMapSearchEntry }) {
  const { i18n } = useLingui();
  const msd = diff.msdLn ?? diff.msd;
  const prism = usesPrism(diff.keyCount);
  const bars = msd
    ? msdSkillsetMeta(diff.keyCount)
      .map((meta) => ({ meta, value: Number(msd[meta.key] ?? 0) }))
      .filter(({ value }) => value >= 1)
    : [];
  if (bars.length === 0) return null;
  const max = Math.max(...bars.map((bar) => bar.value));
  // The big number is the chart's Overall, the same value the map modal's
  // rating panel headlines; the bars stay the skillset breakdown.
  const overall = resolveShownMsd({ entry: diff }).overall;
  const floor = Math.min(...bars.map((bar) => bar.value)) * 0.7;
  const top = bars.reduce((best, bar) => (bar.value > best.value ? bar : best), bars[0]);
  return (
    <div className="flex items-end gap-3">
      <span className="shrink-0 pb-[14px] text-[22px] font-extrabold leading-none tabular-nums text-white">{(overall ?? max).toFixed(1)}</span>
      <div className="flex flex-1 gap-[3px]">
        {bars.map(({ meta, value }) => {
          const isTop = meta.key === top.meta.key;
          const abbr = (prism ? PRISM_SKILLSET_ABBR[meta.key] : undefined) ?? SKILLSET_ABBR[meta.key];
          return (
            <HoverTip
              key={meta.key}
              className="flex min-w-0 flex-1 flex-col items-stretch gap-[3px]"
              tip={(
                <span className="whitespace-nowrap">
                  <span className="font-semibold" style={{ color: meta.color }}>{i18n._(meta.labelMsg)}</span>
                  <span className="ml-2 font-bold tabular-nums text-white">{value.toFixed(2)}</span>
                </span>
              )}
            >
              <span className="flex h-[30px] items-end" aria-label={`${i18n._(meta.labelMsg)} ${value.toFixed(2)}`}>
                <span
                  className="w-full rounded-t-[3px]"
                  style={{
                    height: `${Math.max(10, ((value - floor) / (max - floor || 1)) * 100)}%`,
                    background: meta.color,
                    // The main skillset reads first: full and a touch brighter, the rest dimmed.
                    opacity: isTop ? 1 : 0.4,
                    filter: isTop ? "brightness(1.15) saturate(1.1)" : undefined,
                  }}
                />
              </span>
              <span
                aria-hidden="true"
                className={`truncate text-center text-[9px] font-bold uppercase leading-none tracking-[0.06em] ${isTop ? "text-osu-l1" : "text-osu-f1/60"}`}
              >
                {abbr ? i18n._(abbr) : meta.label.slice(0, 3)}
              </span>
            </HoverTip>
          );
        })}
      </div>
    </div>
  );
}

// The backend's sampled cover colour (entry.coverColor, #rrggbb) pulled into
// a band that reads as a tint on the dark body whatever the cover: mid
// lightness, capped saturation. Shared by the card and the map detail modal.
export function coverTintColor(hex: string): string | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = d === 0 ? 0 : max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${Math.round(h * 60)} ${Math.round(Math.min(0.7, s) * 100)}% 50%)`;
}

// The map card: cover with the key count and status, the hardest diff's
// skillset ratings as a bar strip, the skill tiles, then the set's star range
// and actions. Country-agnostic, so the same card serves search and collections.
export function SearchCard({ entry, onOpen, preview, rate, starScale }: CardProps) {
  const model = useCardModel(entry, rate, starScale);
  const hasBars = !!(model.hardest.msdLn ?? model.hardest.msd);
  return (
    <MapCardFrame
      coverUrl={mapCoverUrl(entry)}
      coverColor={entry.coverColor}
      keyLabel={keyModeLabel(model.diffs)}
      status={entry.status}
      title={entry.title}
      artist={entry.artist}
      // Opens on the diff the card summarises (its hardest), so the modal's
      // header and rating panel start on the number the card shows.
      onOpen={onOpen ? () => onOpen(model.hardest === entry || !entry.diffs?.length ? entry : {
        ...model.hardest,
        covers: entry.covers,
        coverColor: entry.coverColor,
        diffCount: entry.diffCount,
        diffs: entry.diffs,
      }) : undefined}
    >
      {hasBars ? <SkillsetBars diff={model.hardest} /> : null}
      <SkillLine model={model} />
      <MapCardFooter>
        <span className="flex min-w-0 flex-1 items-center gap-2.5 text-[11.5px] text-osu-l2/75">
          <StarRatingBadge stars={model.starHi} range={[model.starLo, model.starHi]} large className="shrink-0" />
          <Hairline />
          <span className="truncate"><Plural value={model.diffs.length} one="# diff" other="# diffs" /></span>
          <Hairline />
          <span className="tabular-nums">{formatDuration(entry.length)}</span>
        </span>
        {preview ? <MapPreviewButton beatmapsetId={entry.beatmapsetId} preview={preview} /> : null}
        <OsuDirectButton beatmapsetId={entry.beatmapsetId} />
        <OszButton beatmapsetId={entry.beatmapsetId} />
      </MapCardFooter>
    </MapCardFrame>
  );
}

// The map card's frame, shared by search and the other /maps tabs: the cover
// with the keymode and status in its corners and the title over it, fading
// into a body washed with the set's cover colour (coverColor from the backend).
export function MapCardFrame({
  coverUrl,
  coverColor,
  keyLabel,
  status,
  title,
  artist,
  coverOverlay,
  onOpen,
  children,
}: {
  coverUrl: string;
  coverColor?: string;
  keyLabel?: string | null;
  status?: string | null;
  title: string;
  artist: string;
  /** Drawn over the art, under the corner badges (the farmed tab's mod glyph). */
  coverOverlay?: ReactNode;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const tint = coverColor ? coverTintColor(coverColor) : null;
  const clickable = !!onOpen;
  return (
    <div
      className={`group relative isolate flex flex-col overflow-hidden rounded-2xl bg-osu-b4 ring-1 transition-shadow ${
        tint ? "ring-[color-mix(in_srgb,var(--tint)_14%,transparent)] hover:ring-[color-mix(in_srgb,var(--tint)_55%,transparent)]" : "ring-white/5 hover:ring-white/20"
      } ${clickable ? "cursor-pointer" : ""}`}
      style={tint ? ({ "--tint": tint } as CSSProperties) : undefined}
      onClick={onOpen}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={onOpen ? (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      } : undefined}
      title={clickable ? t`View details` : undefined}
    >
      {tint ? (
        // The cover's colour washed over the body, strongest under the art.
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          aria-hidden="true"
          style={{ background: "linear-gradient(to bottom, color-mix(in srgb, var(--tint) 30%, transparent), color-mix(in srgb, var(--tint) 10%, transparent))" }}
        />
      ) : null}
      <div className="relative h-[118px] shrink-0">
        {/* The cover dissolves into the body. The title's shade sits inside the
            mask too, so it fades with the art and the box edge never shows. */}
        <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_40%,transparent)]">
          <CoverImage src={coverUrl} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-black/15" />
        </div>
        {coverOverlay}
        <div className="absolute left-3 right-3 top-2.5 flex items-center justify-between gap-2">
          {keyLabel ? (
            <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-white backdrop-blur-sm">
              {keyLabel}
            </span>
          ) : <span />}
          {status ? <BeatmapStatusBadge status={status} /> : null}
        </div>
        <div className="absolute bottom-1 left-3.5 right-3.5">
          <div className="truncate text-[16px] font-extrabold leading-tight text-white drop-shadow-md">{title}</div>
          <div className="truncate text-[12px] leading-tight text-white/70">{artist}</div>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-3.5 pb-3 pt-2.5">{children}</div>
    </div>
  );
}

// The card's last row: a hairline above, stats on the left, buttons on the right.
export function MapCardFooter({ children }: { children: ReactNode }) {
  return <div className="mt-auto flex items-center gap-2 border-t border-white/5 pt-2.5">{children}</div>;
}

const SEARCH_CARD_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

export function SearchCardGrid({
  items,
  preview,
  onOpen,
  rate,
  starScale,
}: {
  items: LiveMapSearchEntry[];
  preview?: MapPreviewAudio;
  onOpen?: (entry: LiveMapSearchEntry) => void;
  rate?: "ht" | "dt" | "";
  starScale?: "sunny" | "";
}) {
  return (
    <div className={SEARCH_CARD_GRID}>
      {items.map((entry) => (
        <SearchCard key={entry.beatmapId} entry={entry} preview={preview} onOpen={onOpen} rate={rate} starScale={starScale} />
      ))}
    </div>
  );
}

// The card's frame while results load, in its own shape so nothing jumps.
function SearchCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-osu-b4 ring-1 ring-white/5">
      <Skeleton className="h-[118px] w-full rounded-none" />
      <div className="flex flex-col gap-3 px-3.5 pb-3 pt-2.5">
        <div className="flex items-end gap-3">
          <Skeleton className="h-5 w-10" />
          <Skeleton className="h-[38px] flex-1 rounded" />
        </div>
        <Skeleton className="h-3 w-2/5" />
        <div className="flex items-center gap-2 border-t border-white/5 pt-2.5">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-3 w-16" />
          <span className="flex-1" />
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

export function SearchCardGridSkeleton({ count }: { count: number }) {
  return (
    <div className={SEARCH_CARD_GRID} aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <SearchCardSkeleton key={index} />
      ))}
    </div>
  );
}
