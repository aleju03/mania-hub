import { Fragment, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { LiveMapSearchEntry } from "../../lib/live-backend";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { BeatmapStatusBadge } from "../ui/BeatmapStatusBadge";
import { Skeleton } from "../ui/LoadingSkeleton";
import { StarRatingBadge, starTextColor, stripKeymodePrefix } from "./SearchCard";
import { formatDuration } from "../../lib/format";

// The map detail modal's header, diff tabs and stats line.

export type DetailStars = { value: number; dim: boolean } | "pending" | null;

export interface MapDetailHeaderProps {
  entry: LiveMapSearchEntry;
  active: LiveMapSearchEntry;
  /** The banner image layer (fades in on load), or null when the set has no art. */
  cover: ReactNode;
  stars: DetailStars;
  /** The osu! status, when known. */
  status: string | null;
  tiles: string[];
  /** The chart's Overall, the rating panel's headline value. */
  rating: number | null;
  onClose: () => void;
}

function Hairline({ className = "bg-white/20" }: { className?: string }) {
  return <span aria-hidden="true" className={`h-3 w-px shrink-0 ${className}`} />;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t`Close`}
      className="absolute top-2.5 right-2.5 z-10 grid h-8 w-8 place-items-center rounded-lg bg-black/45 text-white/80 backdrop-blur-sm hover:bg-black/70 hover:text-white transition-colors cursor-pointer"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-4 w-4">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

function Tiles({ tiles }: { tiles: string[] }) {
  const { i18n } = useLingui();
  if (tiles.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-bold">
      {tiles.map((tile, index) => (
        <Fragment key={tile}>
          {index > 0 ? <span className="font-normal text-white/35">/</span> : null}
          <span style={{ color: DAN_SKILLSET_META[tile].color }}>{i18n._(DAN_SKILLSET_META[tile].labelMsg)}</span>
        </Fragment>
      ))}
    </span>
  );
}

// The active diff's star badge; a dark pill holds its place while the number
// is in flight (a skeleton's tint vanishes on cover art).
function StarSlot({ stars }: { stars: DetailStars }) {
  if (stars === "pending") return <span className="inline-flex h-[20px] w-[62px] shrink-0 rounded-full bg-black/50" aria-hidden="true" />;
  if (!stars) return null;
  return <StarRatingBadge stars={stars.value} large className={`shrink-0 transition-opacity ${stars.dim ? "opacity-50" : ""}`} />;
}

// The modal's header, matching the map card: the cover with the key count and
// status in its corner, the chart's strongest skillset rating bottom-right.
export function MapDetailHeader({ entry, active, cover, stars, status, tiles, rating, onClose }: MapDetailHeaderProps) {
  return (
    <div className="relative h-[188px] shrink-0">
      {/* The cover dissolves into the (tinted) panel; the title's shade fades
          with the art inside the mask, so no edge shows. */}
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black_35%,transparent)]">
        {cover}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-black/20" />
      </div>
      <div className="absolute left-4 right-14 top-3.5 flex items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-extrabold leading-none tabular-nums text-white">{active.keyCount}K</span>
        {status ? <BeatmapStatusBadge status={status} /> : null}
      </div>
      <CloseButton onClose={onClose} />
      <div className="absolute inset-x-0 bottom-0 flex items-end gap-4 px-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[24px] font-extrabold leading-tight text-white drop-shadow-md">{entry.title}</h2>
          <p className="flex min-w-0 items-center gap-2.5 text-[13px] leading-tight text-white/75">
            <span className="truncate">{entry.artist}</span>
            {entry.creator ? (
              <>
                <Hairline />
                <span className="min-w-0 truncate text-white/55"><Trans>mapped by {entry.creator}</Trans></span>
              </>
            ) : null}
          </p>
          <div className="mt-2.5 flex min-w-0 items-center gap-2.5 text-[12.5px] text-white/70">
            <StarSlot stars={stars} />
            <Tiles tiles={tiles} />
          </div>
        </div>
        {rating != null && rating > 0 ? (
          <span className="shrink-0 pb-0.5 text-[34px] font-extrabold leading-none tabular-nums text-white drop-shadow-md">{rating.toFixed(1)}</span>
        ) : null}
      </div>
    </div>
  );
}

/** What a diff tab needs; map search entries fit as they are. */
export interface DiffTabItem {
  beatmapId: number;
  stars: number;
  version: string;
  keyCount: number;
  /** Seconds; shown in the expanded list. */
  length?: number;
}

// Up to this many diffs in a keymode, every tab shows. Past it the row shows
// the first few by stars (plus the selected one) and a "+N more" tab.
const DIFF_TABS_ALL_MAX = 8;
const DIFF_TABS_COLLAPSED = 6;

// Tabs with no panel: each diff's star number in its colour, the selected one
// underlined in that colour. A set that spans keymodes gets one row per
// keymode, led by a muted "4K" label in the PATTERNS / TAGS style; the keymode
// prefix osu! diff names carry ("[4K] Hard") is dropped since the row label or
// the header badge already says it. A keymode with many diffs collapses to a
// few tabs and "+N more", which opens the whole list as a short scroll.
export function DiffTabs({
  diffs,
  activeId,
  mixedKeys,
  onSelect,
}: {
  diffs: DiffTabItem[];
  activeId: number;
  mixedKeys: boolean;
  onSelect: (beatmapId: number) => void;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const modes = [...new Set(diffs.map((diff) => diff.keyCount))].sort((a, b) => a - b);

  const tab = (diff: DiffTabItem) => {
    const isActive = diff.beatmapId === activeId;
    const color = starTextColor(diff.stars);
    return (
      <button
        key={diff.beatmapId}
        type="button"
        onClick={() => onSelect(diff.beatmapId)}
        aria-pressed={isActive}
        title={`[${diff.version}] ★${diff.stars.toFixed(2)}`}
        className={`flex min-w-0 cursor-pointer items-baseline gap-1.5 border-b-2 px-2.5 pb-1.5 pt-1 text-[12px] font-semibold transition-colors ${
          isActive ? "text-white" : "border-transparent text-osu-l2/65 hover:text-osu-l1"
        }`}
        style={isActive ? { borderColor: color } : undefined}
      >
        <span className="shrink-0 font-extrabold tabular-nums" style={{ color }}>{diff.stars.toFixed(2)}</span>
        <span className="max-w-[220px] truncate">{stripKeymodePrefix(diff.version)}</span>
      </button>
    );
  };

  const row = (keys: number, shown: DiffTabItem[]) => {
    const byStars = [...shown].sort((a, b) => a.stars - b.stars || a.beatmapId - b.beatmapId);
    if (byStars.length <= DIFF_TABS_ALL_MAX) {
      return <div className="flex min-w-0 flex-1 flex-wrap items-end gap-x-1">{byStars.map(tab)}</div>;
    }
    const open = expanded.has(keys);
    const toggle = () => setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(keys)) next.delete(keys);
      else next.add(keys);
      return next;
    });
    if (open) {
      return (
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* The whole keymode as one column, full names, a short scroll with
              the bottom edge fading out. */}
          <div className="max-h-[188px] overflow-y-auto overscroll-contain pb-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)] [scrollbar-width:thin]">
            {byStars.map((diff) => {
              const isActive = diff.beatmapId === activeId;
              return (
                <button
                  key={diff.beatmapId}
                  type="button"
                  onClick={() => onSelect(diff.beatmapId)}
                  aria-pressed={isActive}
                  className={`flex w-full cursor-pointer items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                    isActive ? "bg-white/[0.08] text-white" : "text-osu-l2/75 hover:bg-white/[0.05] hover:text-osu-l1"
                  }`}
                >
                  <span className="w-9 shrink-0 font-extrabold tabular-nums" style={{ color: starTextColor(diff.stars) }}>{diff.stars.toFixed(2)}</span>
                  <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{stripKeymodePrefix(diff.version)}</span>
                  {diff.length ? <span className="shrink-0 tabular-nums text-osu-f1/70">{formatDuration(diff.length)}</span> : null}
                </button>
              );
            })}
          </div>
          <button type="button" onClick={toggle} className="self-start cursor-pointer px-2.5 pb-1 text-[11.5px] font-semibold text-osu-f1 hover:text-osu-l1">
            {t`Show fewer`}
          </button>
        </div>
      );
    }
    const first = byStars.slice(0, DIFF_TABS_COLLAPSED);
    const selected = byStars.find((diff) => diff.beatmapId === activeId);
    const visible = selected && !first.includes(selected) ? [...first, selected] : first;
    const hidden = byStars.length - visible.length;
    return (
      <div className="flex min-w-0 flex-1 flex-wrap items-end gap-x-1">
        {visible.map(tab)}
        <button
          type="button"
          onClick={toggle}
          className="cursor-pointer border-b-2 border-transparent px-2.5 pb-1.5 pt-1 text-[12px] font-semibold text-osu-f1 hover:text-osu-l1"
        >
          {t`+${hidden} more`}
        </button>
      </div>
    );
  };

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-white/[0.07] pb-1">
      {modes.map((keys) => mixedKeys ? (
        <div key={keys} className="flex items-baseline gap-2">
          <span className="w-7 shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] tabular-nums text-osu-f1/55">{keys}K</span>
          {row(keys, diffs.filter((diff) => diff.keyCount === keys))}
        </div>
      ) : (
        <Fragment key={keys}>{row(keys, diffs)}</Fragment>
      ))}
    </div>
  );
}

// ─── Stats line ─────────────────────────────────────────────────────────────

export interface InlineStat {
  key: string;
  /** null while the number is in flight. */
  value: string | null;
  label?: string;
  /** "OD 7" reads label-first. */
  labelFirst?: boolean;
}

// The stats as one plain line split by hairlines, instead of a boxed grid.
export function InlineStats({ stats, note }: { stats: InlineStat[]; note?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-osu-l2/70">
        {stats.map((stat, index) => (
          <Fragment key={stat.key}>
            {index > 0 ? <Hairline className="bg-white/15" /> : null}
            <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
              {stat.labelFirst && stat.label ? <span>{stat.label}</span> : null}
              {stat.value == null ? (
                <Skeleton className="h-3.5 w-8 self-center" />
              ) : (
                <span className="font-bold tabular-nums text-white">{stat.value}</span>
              )}
              {!stat.labelFirst && stat.label ? <span>{stat.label}</span> : null}
            </span>
          </Fragment>
        ))}
      </div>
      {note ? <span className="text-[11px] text-osu-f1/70">{note}</span> : null}
    </div>
  );
}
