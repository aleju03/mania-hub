import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft } from "lucide-react";
import {
  fetchLiveMapCollection,
  fetchLiveMapCollections,
  runLiveBackendAdminAction,
  type LiveMapCollectionDetail,
  type LiveMapCollectionsRotation,
  type LiveMapCollectionSummary,
  type LiveMapSearchEntry,
} from "../../lib/live-backend";
import { useAuth } from "../../lib/auth-context";
import { rememberMapsCollection } from "../../lib/analytics-maps";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import { useLocale } from "../../lib/locale-context";
import { danScaleImage, danScaleLabel, type DanScaleContext } from "../../lib/dan-images";
import { CoverStrip } from "./CollectionCovers";
import { UserCollectionsSection } from "./UserCollectionsSection";
import { MapDetailModal } from "./MapDetailModal";
import { MapPreviewPlayerBar, useMapPreviewAudio } from "./MapPreviewAudio";
import { PATTERN_COLOR, SearchCard, patternLabel, toPreviewTrack } from "./SearchCard";
import { useNoDans } from "../../store";

// Auto-rotating map packs grouped by pattern, keymode, and difficulty bucket.
// Two difficulty axes cover both vocabularies players actually use: dan
// estimates (course ladders) and MSD overall (MinaCalc). Packs resample from
// their bucket pool on every backend rotation, so the grid changes every few
// days instead of pinning the same top-40 forever.

export type CollectionSource = "auto" | "community";

interface Props {
  /** Which half of the tab is showing: the auto packs or the posted ones. */
  source: CollectionSource;
  onSourceChange: (source: CollectionSource) => void;
  selectedCollectionId: string;
  onSelect: (id: string) => void;
  // Both pickers live in the route's search params: opening a pack unmounts
  // the browse grid, so local state here reset to 4K + dan on the way back.
  keyFilter: number;
  axis: Axis;
  onKeyFilterChange: (keys: number) => void;
  onAxisChange: (axis: Axis) => void;
  liveBackendEnabled: boolean;
}

const PATTERN_DESCRIPTION: Record<string, MessageDescriptor> = {
  jack: msg`Repeated notes hammered on the same columns.`,
  stream: msg`Fast single-note runs flowing across the keys.`,
  jumpstream: msg`Streams broken up by two-note jumps.`,
  handstream: msg`Streams thickened with three-note hand chords.`,
  stamina: msg`Long, dense charts that test endurance.`,
  tech: msg`Shifting, irregular patterns that punish bad reading.`,
  ln: msg`Long-note and hold-heavy charts.`,
};

type Axis = "dan" | "msd";

// Which dan ladder names a pack's levels: 7K packs use the JinJin courses, 4K
// LN packs the LN ladder, everything else 4K reform.
function danContext(summary: Pick<LiveMapCollectionSummary, "keyCount" | "pattern">): DanScaleContext {
  if (summary.keyCount === 7) return summary.pattern === "ln" ? "7k-ln" : "7k";
  return summary.pattern === "ln" ? "ln" : "reform";
}

// "7–8 dan", "Alpha–Gamma", "Delta+", "up to 3 dan" / "18–22 MSD", "30+ MSD".
function bucketLabel(summary: LiveMapCollectionSummary): string {
  const { axis, bucketLo: lo, bucketHi: hi } = summary;
  if (axis === "dan") {
    const context = danContext(summary);
    const greek = (level: number) => /[a-z]/i.test(danScaleLabel(level, context));
    const name = (level: number) => danScaleLabel(level, context);
    const suffix = (level: number) => (greek(level) ? "" : " dan");
    if (lo == null && hi != null) return `up to ${name(hi)}${suffix(hi)}`;
    if (lo != null && hi == null) return `${name(lo)}+${suffix(lo)}`;
    if (lo != null && hi != null) return `${name(lo)}–${name(hi)}${suffix(hi)}`;
    return "dan";
  }
  if (lo == null && hi != null) return `under ${hi} MSD`;
  if (lo != null && hi == null) return `${lo}+ MSD`;
  if (lo != null && hi != null) return `${lo}–${hi} MSD`;
  return "MSD";
}

// Where a ladder starts, for buckets left open at the bottom: "up to 3 dan"
// runs from the first course of its ladder.
function ladderFloor(context: DanScaleContext): number {
  return context === "reform" || context === "ln" ? 1 : 0;
}

/** The badges for a dan bucket: the course logo of every level it spans. */
function bucketBadgeSrcs(summary: LiveMapCollectionSummary): string[] {
  if (summary.axis !== "dan") return [];
  const context = danContext(summary);
  const lo = summary.bucketLo ?? ladderFloor(context);
  // An open top ("Delta+") shows its floor alone: the ladder runs on to kappa
  // and no pack reaches anywhere near that far.
  const hi = summary.bucketHi ?? summary.bucketLo;
  if (hi == null) return [];
  const srcs: string[] = [];
  for (let level = lo; level <= hi; level += 1) {
    const src = danScaleImage(level, context);
    // The scale clamps past the ends of a ladder, so a bucket that overshoots
    // one would otherwise repeat its last badge.
    if (src && !srcs.includes(src)) srcs.push(src);
  }
  return srcs;
}

// 4K reform tops out at 10 and the 4K LN ladder at 16; both draw those
// two-digit badges at a smaller font than the single-digit ones, since two
// glyphs have to fit the same square. Left alone, "9 10" reads as a step down in
// size, so the two-digit box grows to bring the numeral back to its neighbours'
// height. The 7K badges are circles of one radius and need no such thing.
function isTwoDigitBadge(src: string): boolean {
  return /\/dans\/(reform|ln)\/1[0-6]\.svg$/.test(src);
}

function DanBadges({ srcs, size, className = "" }: { srcs: string[]; size: number; className?: string }) {
  return (
    <div className={`flex flex-shrink-0 items-center gap-1 ${className}`}>
      {srcs.map((src) => {
        const px = isTwoDigitBadge(src) ? Math.round(size * 1.4) : size;
        return (
          <img
            key={src}
            src={src}
            alt=""
            style={{ width: px, height: px }}
            // No CSS drop-shadow: every badge asset draws its own feDropShadow,
            // and a second one would put a filtered layer on each of the ~100
            // badges a page of packs renders.
            className="object-contain"
            loading="lazy"
          />
        );
      })}
    </div>
  );
}

function collectionCovers(summary: LiveMapCollectionSummary): number[] {
  if (summary.coverSetIds.length > 0) return summary.coverSetIds.slice(0, 3);
  return summary.coverSetId ? [summary.coverSetId] : [];
}

// "2d 4h" until the next rotation; empty once it is due (the rebuild queues on
// the backend's next staleness check).
function rotationCountdown(rotation: LiveMapCollectionsRotation | null, i18n: I18n): string | null {
  if (!rotation?.nextRefreshAt) return null;
  const remaining = Date.parse(rotation.nextRefreshAt) - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return i18n._(msg`any moment now`);
  const hours = Math.floor(remaining / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    const restHours = hours % 24;
    return i18n._(msg`in ${days}d ${restHours}h`);
  }
  if (hours > 0) return i18n._(msg`in ${hours}h`);
  const minutes = Math.max(1, Math.floor(remaining / 60_000));
  return i18n._(msg`in ${minutes}m`);
}

function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  render,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  render: (option: T) => string;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-osu-b4/70 p-1">
      {options.map((option) => (
        <button
          key={String(option)}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`rounded-md px-4 py-1.5 text-[13px] font-bold transition-colors cursor-pointer ${
            value === option ? "bg-osu-pink/25 text-osu-pink-light" : "text-osu-f1 hover:text-osu-l2"
          }`}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

function CollectionTile({ summary, onClick }: { summary: LiveMapCollectionSummary; onClick: () => void }) {
  const badges = bucketBadgeSrcs(summary);
  const label = bucketLabel(summary);
  const accent = PATTERN_COLOR[summary.pattern ?? ""] ?? "#cfcfe6";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ "--tile-accent": accent } as CSSProperties}
      className="group relative flex flex-col rounded-xl border border-osu-b3/20 bg-osu-b4 text-left focus:outline-none cursor-pointer"
    >
      {/* The course logos are stamped on the artwork rather than set beside the
          title: a four-level range beside it left the title truncating, and the
          badges carry their own outline and shadow, so they read over a cover.
          Centred, not against one edge - sat over the leftmost cover they read
          as that map's rating instead of the pack's range. */}
      <div className="relative overflow-hidden rounded-t-[11px]">
        <CoverStrip setIds={collectionCovers(summary)} className="h-16 w-full" />
        {badges.length > 0 && (
          <>
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.85)_0%,rgba(0,0,0,0.55)_45%,rgba(0,0,0,0.1)_100%)]" />
            <DanBadges srcs={badges} size={32} className="absolute inset-0 justify-center" />
          </>
        )}
      </div>
      <div className="min-w-0 px-3 py-2.5">
        <div className="truncate text-[14px] font-extrabold leading-tight text-osu-l1">{label}</div>
        <div className="mt-0.5 text-[10.5px] text-osu-f1"><Plural value={summary.memberCount} one="# map" other="# maps" /></div>
      </div>
      {/* The accent edge fades in as an overlay's opacity, not as the button's
          own border-color: opacity animates on the compositor, while a
          border-color transition repaints the whole tile - three covers and the
          scrim with them - on every frame of the fade, for every tile a pointer
          crosses on its way across the row. */}
      <div className="pointer-events-none absolute -inset-px rounded-xl border border-(--tile-accent) opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
    </button>
  );
}

function CollectionsBrowse({ onSelect, keyFilter, axis, onKeyFilterChange, onAxisChange, liveBackendEnabled }: Pick<Props, "onSelect" | "keyFilter" | "axis" | "onKeyFilterChange" | "onAxisChange" | "liveBackendEnabled">) {
  const [collections, setCollections] = useState<LiveMapCollectionSummary[] | null>(null);
  const [rotation, setRotation] = useState<LiveMapCollectionsRotation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const canRebuild = useAuth().canUseAdminFeatures;
  const { t, i18n } = useLingui();
  const noDans = useNoDans();

  useEffect(() => {
    if (!liveBackendEnabled) {
      setError(t`Collections are unavailable right now. Try again in a bit.`);
      return;
    }
    let cancelled = false;
    fetchLiveMapCollections()
      .then((data) => {
        if (cancelled) return;
        setCollections(data.collections);
        setRotation(data.rotation);
      })
      .catch(() => {
        if (!cancelled) setError(t`Couldn't load collections.`);
      });
    return () => {
      cancelled = true;
    };
  }, [liveBackendEnabled]);

  // Admin-only: force a fresh rotation now instead of waiting for the scheduled
  // rebuild. The backend runs the pass inline, so the refetch (cache-bypassed)
  // shows the new sample right away.
  const handleRebuild = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      await runLiveBackendAdminAction({ data: { path: "/api/admin/rebuild-collections" } });
      const data = await fetchLiveMapCollections({ fresh: true });
      setCollections(data.collections);
      setRotation(data.rotation);
      setError(null);
    } catch {
      setError(t`Rebuild failed.`);
    } finally {
      setRebuilding(false);
    }
  };

  // Rows from a backend that has not rebuilt in the dan/MSD format yet carry no
  // axis; they cannot render as difficulty buckets, so they don't render at all.
  const usable = useMemo(
    () => (collections ?? []).filter((collection) => collection.axis === "msd" || (!noDans && collection.axis === "dan")),
    [collections, noDans],
  );

  const availableKeys = useMemo(() => {
    const keys = new Set<number>();
    for (const collection of usable) if (collection.keyCount != null) keys.add(collection.keyCount);
    return [...keys].sort((a, b) => a - b);
  }, [usable]);

  const groups = useMemo(() => {
    const map = new Map<string, LiveMapCollectionSummary[]>();
    for (const collection of usable) {
      if (collection.keyCount !== keyFilter) continue;
      if (collection.axis !== axis) continue;
      const key = collection.pattern ?? "other";
      const list = map.get(key) ?? [];
      list.push(collection);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [usable, keyFilter, axis]);

  const countdown = rotationCountdown(rotation, i18n);

  if (error) return <div className="py-16 text-center text-[13px] text-osu-f1">{error}</div>;
  if (!collections) return <div className="py-16 text-center text-[13px] text-osu-f1">{t`Loading collections...`}</div>;
  if (usable.length === 0) {
    return <div className="py-16 text-center text-[13px] text-osu-f1">{t`Collections are being rebuilt. Check back in a few minutes.`}</div>;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Keymode + difficulty-axis switchers; the rotation note explains why the grid changes. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            options={availableKeys.length > 0 ? availableKeys : [4, 7]}
            value={keyFilter}
            onChange={onKeyFilterChange}
            render={(key) => `${key}K`}
          />
          {!noDans ? (
            <SegmentedControl<Axis>
              options={["dan", "msd"]}
              value={axis}
              onChange={onAxisChange}
              render={(option) => (option === "dan" ? t`Dan est.` : t`MSD`)}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-2.5">
          <p className="text-[12px] text-osu-f1">
            {t`Every pack is a random sample of its difficulty bucket`}
            {countdown ? (
              <Trans>
                {" · "}next rotation <span className="font-semibold text-osu-l2">{countdown}</span>
              </Trans>
            ) : null}
          </p>
          {canRebuild && (
            <button
              onClick={handleRebuild}
              disabled={rebuilding}
              className="shrink-0 rounded-lg border border-osu-red/30 bg-osu-red/20 px-2 py-1 text-[10px] font-semibold text-osu-red transition-colors hover:bg-osu-red/30 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
              title={t`Force a fresh collection rotation now (admin only)`}
            >
              {rebuilding ? t`Rebuilding...` : t`Rebuild now`}
            </button>
          )}
        </div>
      </div>
      {groups.length === 0 && <div className="py-12 text-center text-[13px] text-osu-f1"><Trans>No {keyFilter}K collections yet.</Trans></div>}
      {groups.map(([pattern, list]) => (
        <section key={pattern} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 border-b border-osu-b3/25 pb-2.5">
            <div className="flex items-baseline gap-2.5">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 translate-y-[1px] rounded-sm"
                style={{ background: PATTERN_COLOR[pattern] ?? "#cfcfe6" }}
              />
              <h2 className="text-[22px] font-extrabold tracking-tight text-osu-l1">{patternLabel(pattern)}</h2>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-osu-pink-light/80"><Plural value={list.length} one="# pack" other="# packs" /></span>
            </div>
            <p className="text-[12.5px] text-osu-f1">{PATTERN_DESCRIPTION[pattern] ? i18n._(PATTERN_DESCRIPTION[pattern]) : ""}</p>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            {list.map((summary) => (
              <CollectionTile
                key={summary.id}
                summary={summary}
                onClick={() => {
                  // Collection ids are opaque, so hand the pack's name to the
                  // pageview the navigation is about to fire.
                  rememberMapsCollection(summary.id, summary.title);
                  onSelect(summary.id);
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CollectionDetail({ id, onBack, liveBackendEnabled }: { id: string; onBack: () => void; liveBackendEnabled: boolean }) {
  const [detail, setDetail] = useState<LiveMapCollectionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapEntry, setMapEntry] = useState<LiveMapSearchEntry | null>(null);
  const loadedId = useRef<string | null>(null);
  const preview = useMapPreviewAudio();
  const { t } = useLingui();
  const locale = useLocale();
  const noDans = useNoDans();
  const { stop: stopPreview } = preview;

  useEffect(() => () => stopPreview(), [stopPreview]);

  useEffect(() => {
    if (!liveBackendEnabled) {
      setError(t`Collections are unavailable right now. Try again in a bit.`);
      return;
    }
    let cancelled = false;
    if (loadedId.current !== id) setDetail(null);
    setError(null);
    fetchLiveMapCollection(id)
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setError(t`Collection not found.`);
          return;
        }
        setDetail(data);
        loadedId.current = id;
      })
      .catch(() => {
        if (!cancelled) setError(t`Couldn't load this collection.`);
      });
    return () => {
      cancelled = true;
    };
  }, [id, liveBackendEnabled]);

  useEffect(() => {
    if (noDans && detail?.axis === "dan") onBack();
  }, [detail?.axis, noDans, onBack]);

  // Skip order for the preview player: the pack as listed.
  const previewTracks = useMemo(() => (detail?.items ?? []).map(toPreviewTrack), [detail]);

  const badges = detail ? bucketBadgeSrcs(detail) : [];
  // Rotation newcomers are a header stat only: each rotation re-samples most of
  // the pack (40 from a pool that is often ~4x that), so a per-card "new" badge
  // was lit on the majority of cards and read as "newly ranked map". A pack
  // where every member is new is simply fresh; saying so adds nothing.
  const newCount = detail && detail.newBeatmapIds.length < detail.items.length ? detail.newBeatmapIds.length : 0;

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="group self-start inline-flex items-center gap-1.5 rounded-lg bg-osu-b4 px-2.5 py-1.5 text-[11px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-white"
      >
        <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" aria-hidden="true" />
        <span>{t`All collections`}</span>
      </button>

      {error ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">{error}</div>
      ) : !detail || (noDans && detail.axis === "dan") ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">{t`Loading collection...`}</div>
      ) : (
        <>
          <div className="flex items-center gap-3.5 border-b border-osu-b3/25 pb-3">
            {badges.length > 0 && <DanBadges srcs={badges} size={48} />}
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-baseline gap-x-2.5 text-[22px] font-extrabold tracking-tight text-osu-l1">
                {patternLabel(detail.pattern ?? "")} · {detail.keyCount ?? "?"}K · {bucketLabel(detail)}
              </h1>
              <p className="mt-0.5 text-[11px] text-osu-f1/70">
                <Trans>{formatNumber(detail.items.length)} maps · rotated {formatTimeAgo(detail.refreshedAt, locale)}</Trans>
                {newCount > 0 ? ` · ${t`${newCount} new this rotation`}` : ""}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {detail.items.map((entry) => (
              <SearchCard
                key={entry.beatmapId}
                entry={entry}
                onOpen={(opened) => {
                  // The detail modal has its own chart-preview audio; don't
                  // leave the card's song preview playing over it.
                  stopPreview();
                  setMapEntry(opened);
                }}
                preview={preview}
              />
            ))}
          </div>
        </>
      )}
      <MapDetailModal entry={mapEntry} onClose={() => setMapEntry(null)} />
      <MapPreviewPlayerBar preview={preview} tracks={previewTracks} />
    </div>
  );
}

export function MapCollectionsSection({
  source,
  onSourceChange,
  selectedCollectionId,
  onSelect,
  keyFilter,
  axis,
  onKeyFilterChange,
  onAxisChange,
  liveBackendEnabled,
}: Props) {
  const { t } = useLingui();
  const noDans = useNoDans();

  useEffect(() => {
    if (noDans && axis === "dan") onAxisChange("msd");
  }, [axis, noDans, onAxisChange]);
  // The switch belongs to the two browse grids, not to a pack that is open:
  // each detail view already has its own way back, and a source switch beside
  // it would read as a filter on the thing being looked at.
  const showSwitch = source === "community" || !selectedCollectionId;
  return (
    <div className="bg-osu-b5 min-h-[60vh]">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-4 flex flex-col gap-4">
        {showSwitch && (
          <div className="flex">
            <SegmentedControl<CollectionSource>
              options={["auto", "community"]}
              value={source}
              onChange={onSourceChange}
              render={(option) => (option === "auto" ? t`Auto packs` : t`Community`)}
            />
          </div>
        )}
        {source === "community" ? (
          <UserCollectionsSection liveBackendEnabled={liveBackendEnabled} />
        ) : selectedCollectionId ? (
          <CollectionDetail id={selectedCollectionId} onBack={() => onSelect("")} liveBackendEnabled={liveBackendEnabled} />
        ) : (
          <CollectionsBrowse
            onSelect={onSelect}
            keyFilter={keyFilter}
            axis={axis}
            onKeyFilterChange={onKeyFilterChange}
            onAxisChange={onAxisChange}
            liveBackendEnabled={liveBackendEnabled}
          />
        )}
      </div>
    </div>
  );
}
