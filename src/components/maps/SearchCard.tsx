import { useEffect, useState, type ReactNode } from "react";
import { ensureMapPlaceholderFont } from "../../lib/replay-fonts";
import { Trans, useLingui } from "@lingui/react/macro";
import type { LiveMapSearchEntry } from "../../lib/live-backend";
import { oszDownloadUrl } from "../../lib/beatmap-mirrors";
import { formatCompactCount, formatDuration } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { BeatmapStatusBadge } from "../ui/BeatmapStatusBadge";
import { Skeleton } from "../ui/LoadingSkeleton";
import { MapPreviewButton, type MapPreviewAudio, type MapPreviewTrack } from "./MapPreviewAudio";
import { starRatingColor, starSpectrumGradient, starTextColor, StarRatingBadge } from "../ui/StarRating";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";

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
export function FamilyPatternChip({ pattern, primary, text }: { pattern: string; primary: boolean; text?: string }) {
  const label = usePatternLabel();
  return (
    <span
      className={
        primary
          ? "px-2 py-1 rounded bg-osu-pink/20 text-osu-pink-light text-[10px] font-semibold leading-none"
          : "px-2 py-1 rounded bg-osu-b3/50 text-osu-f1 text-[10px] leading-none"
      }
    >
      {text ?? label(pattern)}
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

// The LN skillsets an LN chart files under, from its detected tags (strongest
// first): 4K's course stages, 7K's General/Release/Inverse/Tech. LN charts
// carry no rice tiles, so these stand in their place.
const LN_SKILLSET_TAGS = new Set(["lnhybrid", "lntechnical", "lnwalls", "lnspeed", "lngeneral", "lnrelease", "lninverse", "lntech"]);

export function isLnSkillsetTag(tag: string): boolean {
  return LN_SKILLSET_TAGS.has(tag);
}

export function lnSkillTiles(entry: LiveMapSearchEntry): string[] {
  if (entry.dan?.family !== "ln") return [];
  return (entry.patternTags ?? []).filter(isLnSkillsetTag);
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
  const hardest = byStars[byStars.length - 1];
  const vibro = diffs.some((diff) => diff.vibro) || entry.vibro === true;
  return { diffs, byStars, multi, starsOf, starLo, starHi, vibro, hardest, mix: patternMix(hardest) };
}

const MIX_FAMILIES = ["stream", "jumpstream", "handstream", "stamina", "jack", "chordjack", "tech"];

/* What a chart is made of, as shares that add up to one, for the card's
   pattern bar. The analyzer scores each family against the chart's strongest
   (1 is the strongest); below 0.6 a family is background, so the scores are
   cut there and squared apart until the bar reads like a mix rather than
   seven equal slices. Holds join as LN once they are 15% of the notes. The
   primary pattern always leads, so the bar never disagrees with the chips
   and filters that name the chart. */
export function patternMix(entry: LiveMapSearchEntry): Array<{ pattern: string; share: number }> {
  const weights = new Map<string, number>();
  for (const family of MIX_FAMILIES) {
    const weight = Math.max(0, ((entry.patterns?.[family] ?? 0) - 0.6) / 0.4) ** 2.2;
    if (weight > 0.03) weights.set(family, weight);
  }
  const lnShare = entry.lnShare ?? 0;
  if (lnShare >= 0.15) weights.set("ln", lnShare * 1.2);
  const primary = entry.primaryPattern;
  if (PATTERN_LABEL[primary]) {
    const top = Math.max(0, ...weights.values());
    weights.set(primary, Math.max(weights.get(primary) ?? 0, top || 1));
  }
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return [];
  return [...weights.entries()]
    .map(([pattern, weight]) => ({ pattern, share: weight / total }))
    .sort((a, b) => b.share - a.share || (a.pattern === primary ? -1 : b.pattern === primary ? 1 : 0));
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

// The mix's three biggest patterns by name and share, the lead one bold.
function MixLine({ model }: { model: CardModel }) {
  const { t } = useLingui();
  const label = usePatternLabel();
  return (
    <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[12.5px] font-semibold leading-none">
      {model.mix.slice(0, 3).map(({ pattern, share }, index) => (
        <span key={pattern} className="inline-flex items-center gap-2">
          {index > 0 ? <Hairline /> : null}
          <span className={`inline-flex items-baseline gap-1 ${index === 0 ? "font-extrabold" : ""}`}>
            <span style={{ color: PATTERN_COLOR[pattern] ?? "#cfcfe6" }}>{label(pattern)}</span>
            <span className="text-[11px] font-semibold tabular-nums text-osu-f1/80">{Math.round(share * 100)}%</span>
          </span>
        </span>
      ))}
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

// The mix as the line where the cover ends.
function MixSeam({ model }: { model: CardModel }) {
  return (
    <div aria-hidden="true" className="flex h-1">
      {model.mix.map(({ pattern, share }) => (
        <span key={pattern} style={{ flex: share, background: PATTERN_COLOR[pattern] ?? "#cfcfe6" }} />
      ))}
    </div>
  );
}

// Play counts run into the tens of millions, where "12835k" stops reading.
function formatPlays(count: number): string {
  if (count < 1_000_000) return formatCompactCount(count);
  return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
}

// The set's star range on the spectrum, then how many diffs it holds.
function DiffStarPill({ model }: { model: CardModel }) {
  const { t } = useLingui();
  const count = model.byStars.length;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" title={count === 1 ? t`1 diff` : t`${count} diffs`}>
      <StarRatingBadge stars={model.starHi} range={[model.starLo, model.starHi]} large />
      {count > 1 ? <span className="whitespace-nowrap tabular-nums"><Trans><span className="font-bold text-osu-l1">{count}</span> diffs</Trans></span> : null}
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

// The map card: cover with the key count, status and title, the hardest
// diff's pattern mix as the seam under it and by name, then the star range
// with the diff count, length, plays and actions. Country-agnostic, so the same card serves search
// and collections.
export function SearchCard({ entry, onOpen, preview, rate, starScale }: CardProps) {
  const model = useCardModel(entry, rate, starScale);
  const { t } = useLingui();
  return (
    <MapCardFrame
      coverUrl={mapCoverUrl(entry)}
      keyLabel={keyModeLabel(model.diffs)}
      status={entry.status}
      title={entry.title}
      artist={entry.artist}
      seam={model.mix.length > 0 ? <MixSeam model={model} /> : undefined}
      // Opens on the diff the card summarises (its hardest), so the modal's
      // header and rating panel start on the number the card shows.
      onOpen={onOpen ? () => onOpen(model.hardest === entry || !entry.diffs?.length ? entry : {
        ...model.hardest,
        covers: entry.covers,
        diffCount: entry.diffCount,
        diffs: entry.diffs,
      }) : undefined}
    >
      {model.mix.length > 0 || model.vibro ? <MixLine model={model} /> : null}
      <MapCardFooter>
        {preview ? <MapPreviewButton beatmapsetId={entry.beatmapsetId} preview={preview} /> : null}
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[11.5px] text-osu-l2/75">
          <DiffStarPill model={model} />
          <Hairline />
          <span className="tabular-nums">{formatDuration(entry.length)}</span>
          <Hairline />
          <span className="truncate tabular-nums">{t`${formatPlays(entry.playCount)} plays`}</span>
        </span>
        <OsuDirectButton beatmapsetId={entry.beatmapsetId} />
        <OszButton beatmapsetId={entry.beatmapsetId} />
      </MapCardFooter>
    </MapCardFrame>
  );
}

// The map card's frame, shared by search and the other /maps tabs: the cover
// with the keymode and status in its corners and the title over it, fading
// into the body.
export function MapCardFrame({
  coverUrl,
  keyLabel,
  status,
  title,
  artist,
  coverOverlay,
  seam,
  onOpen,
  children,
}: {
  coverUrl: string;
  keyLabel?: string | null;
  status?: string | null;
  title: string;
  artist: string;
  /** Drawn over the art, under the corner badges (the farmed tab's mod glyph). */
  coverOverlay?: ReactNode;
  /** A strip along the cover's bottom edge; the art then ends there instead of dissolving into the body. */
  seam?: ReactNode;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const clickable = !!onOpen;
  return (
    <div
      className={`group relative isolate flex flex-col overflow-hidden rounded-2xl bg-osu-b4 ring-1 ring-white/5 transition-shadow hover:ring-white/20 ${clickable ? "cursor-pointer" : ""}`}
      onClick={onOpen}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={onOpen ? (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      } : undefined}
      title={clickable ? t`View details` : undefined}
    >
      <div className={`relative shrink-0 ${seam ? "h-[124px]" : "h-[118px]"}`}>
        {seam ? (
          // A hard edge with the seam under it, the title on a shade.
          <div className="absolute inset-0">
            <CoverImage src={coverUrl} />
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-black/20" />
          </div>
        ) : (
          // The cover dissolves into the body. The title's shade sits inside the
          // mask too, so it fades with the art and the box edge never shows.
          <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_40%,transparent)]">
            <CoverImage src={coverUrl} />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-black/15" />
          </div>
        )}
        {coverOverlay}
        <div className="absolute left-3 right-3 top-2.5 flex items-center justify-between gap-2">
          {keyLabel ? (
            <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-white backdrop-blur-sm">
              {keyLabel}
            </span>
          ) : <span />}
          {status ? <BeatmapStatusBadge status={status} /> : null}
        </div>
        <div className={`absolute left-3.5 right-3.5 ${seam ? "bottom-2.5" : "bottom-1"}`}>
          <div className="truncate text-[16px] font-extrabold leading-tight text-white drop-shadow-md">{title}</div>
          <div className="truncate text-[12px] leading-tight text-white/70">{artist}</div>
        </div>
      </div>
      {seam}
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
      <Skeleton className="h-[128px] w-full rounded-none" />
      <div className="flex flex-col gap-3 px-3.5 pb-3 pt-2.5">
        <Skeleton className="h-3 w-3/5" />
        <div className="flex items-center gap-2 border-t border-white/5 pt-2.5">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-3 w-32" />
          <span className="flex-1" />
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
