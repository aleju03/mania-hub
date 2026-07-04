import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchLiveMapCollection,
  fetchLiveMapCollections,
  type LiveMapCollectionDetail,
  type LiveMapCollectionSummary,
  type LiveMapSearchEntry,
} from "../../lib/live-backend";
import { formatNumber } from "../../lib/format";
import { MapDetailModal } from "./MapDetailModal";
import { SearchCard, patternLabel } from "./SearchCard";

interface Props {
  selectedCollectionId: string;
  onSelect: (id: string) => void;
  liveBackendEnabled: boolean;
}

const PATTERN_DESCRIPTION: Record<string, string> = {
  jack: "Repeated notes hammered in the same column.",
  stream: "Fast single-note runs flowing across the keys.",
  jumpstream: "Streams broken up by two-note jumps.",
  handstream: "Streams thickened with three-note hand chords.",
  stamina: "Long, dense charts that test endurance.",
  chordjack: "Chords jackhammered across multiple columns.",
  tech: "Shifting, irregular patterns that punish bad reading.",
  ln: "Long-note and hold-heavy charts.",
};

// Difficulty-tier accent so each star bucket reads at a glance, osu-style.
const BUCKET_COLOR: Record<string, string> = {
  "2-3": "#7ed957",
  "3-4": "#56b4ff",
  "4-5": "#ffd24a",
  "5-6": "#ff7eb6",
  "6plus": "#c98bff",
};

function collectionCoverUrl(coverSetId: number | null): string | null {
  return coverSetId ? `https://assets.ppy.sh/beatmaps/${coverSetId}/covers/card.jpg` : null;
}

function bucketOf(summary: LiveMapCollectionSummary): { id: string; label: string; color: string } {
  const bucketId = summary.id.split(":")[3] ?? "";
  const label = bucketId === "6plus" ? "6★+" : `${bucketId}★`;
  return { id: bucketId, label, color: BUCKET_COLOR[bucketId] ?? "#cfcfe6" };
}

function CollectionTile({ summary, onClick }: { summary: LiveMapCollectionSummary; onClick: () => void }) {
  const cover = collectionCoverUrl(summary.coverSetId);
  const bucket = bucketOf(summary);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative rounded-xl overflow-hidden bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/40 transition-colors text-left aspect-[3/2] focus:outline-none"
    >
      {cover ? (
        <img src={cover} alt="" className="absolute inset-0 w-full h-full object-cover opacity-65 group-hover:opacity-90 transition-opacity" loading="lazy" />
      ) : (
        <div className="absolute inset-0 bg-osu-b3/40" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-black/10" />
      <div className="absolute inset-x-0 bottom-0 p-2.5 flex items-end justify-between gap-2">
        <div>
          <div className="text-[18px] font-extrabold leading-none drop-shadow" style={{ color: bucket.color }}>{bucket.label}</div>
          <div className="text-[10px] text-white/65 mt-1">{summary.memberCount} maps</div>
        </div>
        <span className="text-[9px] font-semibold uppercase tracking-wide text-white/0 group-hover:text-white/80 transition-colors">Open →</span>
      </div>
    </button>
  );
}

function CollectionsBrowse({ onSelect, liveBackendEnabled }: { onSelect: (id: string) => void; liveBackendEnabled: boolean }) {
  const [collections, setCollections] = useState<LiveMapCollectionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyFilter, setKeyFilter] = useState(4);

  useEffect(() => {
    if (!liveBackendEnabled) {
      setError("Collections need the live backend running.");
      return;
    }
    let cancelled = false;
    fetchLiveMapCollections()
      .then((data) => {
        if (!cancelled) setCollections(data);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load collections.");
      });
    return () => {
      cancelled = true;
    };
  }, [liveBackendEnabled]);

  const availableKeys = useMemo(() => {
    const keys = new Set<number>();
    for (const collection of collections ?? []) if (collection.keyCount != null) keys.add(collection.keyCount);
    return [...keys].sort((a, b) => a - b);
  }, [collections]);

  const groups = useMemo(() => {
    const map = new Map<string, LiveMapCollectionSummary[]>();
    for (const collection of collections ?? []) {
      if (collection.keyCount !== keyFilter) continue;
      const key = collection.pattern ?? "other";
      const list = map.get(key) ?? [];
      list.push(collection);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [collections, keyFilter]);

  if (error) return <div className="py-16 text-center text-[13px] text-osu-f1">{error}</div>;
  if (!collections) return <div className="py-16 text-center text-[13px] text-osu-f1">Loading collections...</div>;
  if (collections.length === 0) {
    return <div className="py-16 text-center text-[13px] text-osu-f1">Collections are still being built. Check back shortly.</div>;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Key-mode switcher: the headline distinction, so 4K vs 7K is never ambiguous. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg bg-osu-b4/70 p-1">
          {(availableKeys.length > 0 ? availableKeys : [4, 7]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setKeyFilter(key)}
              aria-pressed={keyFilter === key}
              className={`rounded-md px-4 py-1.5 text-[13px] font-bold transition-colors cursor-pointer ${
                keyFilter === key ? "bg-osu-pink/25 text-osu-pink-light" : "text-osu-f1 hover:text-osu-l2"
              }`}
            >
              {key}K
            </button>
          ))}
        </div>
        <p className="text-[12px] text-osu-f1">Packs grouped by pattern and difficulty. Open one to browse and grab its maps.</p>
      </div>
      {groups.length === 0 && <div className="py-12 text-center text-[13px] text-osu-f1">No {keyFilter}K collections yet.</div>}
      {groups.map(([pattern, list]) => (
        <section key={pattern} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 border-b border-osu-b3/25 pb-2.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[22px] font-extrabold tracking-tight text-osu-l1">{patternLabel(pattern)}</h2>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-osu-pink-light/80">{list.length} packs</span>
            </div>
            <p className="text-[12.5px] text-osu-f1">{PATTERN_DESCRIPTION[pattern] ?? ""}</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
            {list.map((summary) => (
              <CollectionTile key={summary.id} summary={summary} onClick={() => onSelect(summary.id)} />
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

  useEffect(() => {
    if (!liveBackendEnabled) {
      setError("Collections need the live backend running.");
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

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="self-start text-[12px] text-osu-f1 hover:text-osu-pink-light transition-colors cursor-pointer">
        ← All collections
      </button>

      {error ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">{error}</div>
      ) : !detail ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">Loading collection...</div>
      ) : (
        <>
          <div className="border-b border-osu-b3/25 pb-3">
            <h1 className="text-[22px] font-extrabold tracking-tight text-osu-l1">{detail.title}</h1>
            {detail.description && <p className="text-[12.5px] text-osu-f1 mt-0.5">{detail.description}</p>}
            <p className="text-[11px] text-osu-f1/70 mt-1">
              {formatNumber(detail.items.length)} maps · open any to preview, or grab its .osz
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {detail.items.map((entry) => (
              <SearchCard key={entry.beatmapId} entry={entry} onOpen={setMapEntry} />
            ))}
          </div>
        </>
      )}
      <MapDetailModal entry={mapEntry} onClose={() => setMapEntry(null)} />
    </div>
  );
}

export function MapCollectionsSection({ selectedCollectionId, onSelect, liveBackendEnabled }: Props) {
  return (
    <div className="bg-osu-b5 min-h-[60vh]">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-4">
        {selectedCollectionId ? (
          <CollectionDetail id={selectedCollectionId} onBack={() => onSelect("")} liveBackendEnabled={liveBackendEnabled} />
        ) : (
          <CollectionsBrowse onSelect={onSelect} liveBackendEnabled={liveBackendEnabled} />
        )}
      </div>
    </div>
  );
}
