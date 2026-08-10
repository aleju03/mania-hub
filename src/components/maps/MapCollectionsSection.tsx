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
import { danScaleImage, danScaleLabel, type DanScaleContext } from "../../lib/dan-images";
import { MapDetailModal } from "./MapDetailModal";
import { MapPreviewPlayerBar, useMapPreviewAudio } from "./MapPreviewAudio";
import { PATTERN_COLOR, SearchCard, patternLabel, toPreviewTrack } from "./SearchCard";

// Auto-rotating map packs grouped by pattern, keymode, and difficulty bucket.
// Two difficulty axes cover both vocabularies players actually use: dan
// estimates (course ladders) and MSD overall (MinaCalc). Packs resample from
// their bucket pool on every backend rotation, so the grid changes every few
// days instead of pinning the same top-40 forever.

interface Props {
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

const PATTERN_DESCRIPTION: Record<string, string> = {
  jack: "Repeated notes hammered on the same columns.",
  stream: "Fast single-note runs flowing across the keys.",
  jumpstream: "Streams broken up by two-note jumps.",
  handstream: "Streams thickened with three-note hand chords.",
  stamina: "Long, dense charts that test endurance.",
  tech: "Shifting, irregular patterns that punish bad reading.",
  ln: "Long-note and hold-heavy charts.",
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

/** The badge that represents a dan bucket: its hardest level's course logo. */
function bucketBadgeSrc(summary: LiveMapCollectionSummary): string | null {
  if (summary.axis !== "dan") return null;
  const level = summary.bucketHi ?? summary.bucketLo;
  if (level == null) return null;
  return danScaleImage(level, danContext(summary));
}

function collectionCovers(summary: LiveMapCollectionSummary): number[] {
  if (summary.coverSetIds.length > 0) return summary.coverSetIds.slice(0, 3);
  return summary.coverSetId ? [summary.coverSetId] : [];
}

// "2d 4h" until the next rotation; empty once it is due (the rebuild queues on
// the backend's next staleness check).
function rotationCountdown(rotation: LiveMapCollectionsRotation | null): string | null {
  if (!rotation?.nextRefreshAt) return null;
  const remaining = Date.parse(rotation.nextRefreshAt) - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "any moment now";
  const hours = Math.floor(remaining / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h`;
  return `in ${Math.max(1, Math.floor(remaining / 60_000))}m`;
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

// Covers that 404ed this session, shared across tiles: axis/keymode switches
// remount every tile, and per-instance state would retry known-dead covers on
// each switch, flashing a 3-slot collage that collapses back to 2.
const failedCoverSetIds = new Set<number>();

function CoverStrip({ setIds, className = "" }: { setIds: number[]; className?: string }) {
  // Covers can 404 even for sets the backend vetted (backgrounds removed after
  // upload, e.g. DMCA). Dropping the failed image and re-flowing the collage
  // beats leaving a blank cell.
  const [, bumpFailures] = useState(0);
  const visible = setIds.filter((setId) => !failedCoverSetIds.has(setId));
  if (visible.length === 0) return <div className={`bg-osu-b3/40 ${className}`} />;
  return (
    <div className={`grid ${visible.length >= 3 ? "grid-cols-3" : visible.length === 2 ? "grid-cols-2" : "grid-cols-1"} gap-px ${className}`}>
      {visible.map((setId) => (
        <img
          key={setId}
          src={`https://assets.ppy.sh/beatmaps/${setId}/covers/card.jpg`}
          alt=""
          className="h-full w-full object-cover opacity-80"
          loading="lazy"
          onError={() => {
            failedCoverSetIds.add(setId);
            bumpFailures((count) => count + 1);
          }}
        />
      ))}
    </div>
  );
}

function CollectionTile({ summary, onClick }: { summary: LiveMapCollectionSummary; onClick: () => void }) {
  const badge = bucketBadgeSrc(summary);
  const label = bucketLabel(summary);
  const accent = PATTERN_COLOR[summary.pattern ?? ""] ?? "#cfcfe6";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ "--tile-accent": accent } as CSSProperties}
      className="group flex flex-col overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 text-left transition-colors hover:border-(--tile-accent) focus:outline-none cursor-pointer"
    >
      <CoverStrip setIds={collectionCovers(summary)} className="h-14 w-full" />
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {badge ? (
          <img src={badge} alt="" className="h-9 w-9 flex-shrink-0 object-contain" loading="lazy" />
        ) : (
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-osu-b3/50 text-[9px] font-extrabold uppercase tracking-wide text-osu-f1">
            msd
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-[14px] font-extrabold leading-tight text-osu-l1">{label}</div>
          <div className="mt-0.5 text-[10.5px] text-osu-f1">{summary.memberCount} maps</div>
        </div>
      </div>
    </button>
  );
}

function CollectionsBrowse({ onSelect, keyFilter, axis, onKeyFilterChange, onAxisChange, liveBackendEnabled }: Omit<Props, "selectedCollectionId">) {
  const [collections, setCollections] = useState<LiveMapCollectionSummary[] | null>(null);
  const [rotation, setRotation] = useState<LiveMapCollectionsRotation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const canRebuild = useAuth().canUseAdminFeatures;

  useEffect(() => {
    if (!liveBackendEnabled) {
      setError("Collections are unavailable right now. Try again in a bit.");
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
        if (!cancelled) setError("Couldn't load collections.");
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
      setError("Rebuild failed.");
    } finally {
      setRebuilding(false);
    }
  };

  // Rows from a backend that has not rebuilt in the dan/MSD format yet carry no
  // axis; they cannot render as difficulty buckets, so they don't render at all.
  const usable = useMemo(
    () => (collections ?? []).filter((collection) => collection.axis === "dan" || collection.axis === "msd"),
    [collections],
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

  const countdown = rotationCountdown(rotation);

  if (error) return <div className="py-16 text-center text-[13px] text-osu-f1">{error}</div>;
  if (!collections) return <div className="py-16 text-center text-[13px] text-osu-f1">Loading collections...</div>;
  if (usable.length === 0) {
    return <div className="py-16 text-center text-[13px] text-osu-f1">Collections are being rebuilt. Check back in a few minutes.</div>;
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
          <SegmentedControl<Axis>
            options={["dan", "msd"]}
            value={axis}
            onChange={onAxisChange}
            render={(option) => (option === "dan" ? "Dan est." : "MSD")}
          />
        </div>
        <div className="flex items-center gap-2.5">
          <p className="text-[12px] text-osu-f1">
            Every pack is a random sample of its difficulty bucket
            {countdown ? (
              <>
                {" · "}next rotation <span className="font-semibold text-osu-l2">{countdown}</span>
              </>
            ) : null}
          </p>
          {canRebuild && (
            <button
              onClick={handleRebuild}
              disabled={rebuilding}
              className="shrink-0 rounded-lg border border-osu-red/30 bg-osu-red/20 px-2 py-1 text-[10px] font-semibold text-osu-red transition-colors hover:bg-osu-red/30 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
              title="Force a fresh collection rotation now (admin only)"
            >
              {rebuilding ? "Rebuilding..." : "Rebuild now"}
            </button>
          )}
        </div>
      </div>
      {groups.length === 0 && <div className="py-12 text-center text-[13px] text-osu-f1">No {keyFilter}K collections yet.</div>}
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
              <span className="text-[11px] font-semibold uppercase tracking-wider text-osu-pink-light/80">{list.length} packs</span>
            </div>
            <p className="text-[12.5px] text-osu-f1">{PATTERN_DESCRIPTION[pattern] ?? ""}</p>
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
  const { stop: stopPreview } = preview;

  useEffect(() => () => stopPreview(), [stopPreview]);

  useEffect(() => {
    if (!liveBackendEnabled) {
      setError("Collections are unavailable right now. Try again in a bit.");
      return;
    }
    let cancelled = false;
    if (loadedId.current !== id) setDetail(null);
    setError(null);
    fetchLiveMapCollection(id)
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setError("Collection not found.");
          return;
        }
        setDetail(data);
        loadedId.current = id;
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this collection.");
      });
    return () => {
      cancelled = true;
    };
  }, [id, liveBackendEnabled]);

  // Skip order for the preview player: the pack as listed.
  const previewTracks = useMemo(() => (detail?.items ?? []).map(toPreviewTrack), [detail]);

  const badge = detail ? bucketBadgeSrc(detail) : null;
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
        <span>All collections</span>
      </button>

      {error ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">{error}</div>
      ) : !detail ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">Loading collection...</div>
      ) : (
        <>
          <div className="flex items-center gap-3.5 border-b border-osu-b3/25 pb-3">
            {badge && <img src={badge} alt="" className="h-12 w-12 flex-shrink-0 object-contain" loading="lazy" />}
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-baseline gap-x-2.5 text-[22px] font-extrabold tracking-tight text-osu-l1">
                {patternLabel(detail.pattern ?? "")} · {detail.keyCount ?? "?"}K · {bucketLabel(detail)}
              </h1>
              <p className="mt-0.5 text-[11px] text-osu-f1/70">
                {formatNumber(detail.items.length)} maps · rotated {formatTimeAgo(detail.refreshedAt)}
                {newCount > 0 ? ` · ${newCount} new this rotation` : ""}
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

export function MapCollectionsSection({ selectedCollectionId, onSelect, keyFilter, axis, onKeyFilterChange, onAxisChange, liveBackendEnabled }: Props) {
  return (
    <div className="bg-osu-b5 min-h-[60vh]">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-4">
        {selectedCollectionId ? (
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
