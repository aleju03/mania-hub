import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  drawSkinPreviewBackdrops,
  searchSkinPreviewBackdrops,
  type BackdropScope,
  type PreviewBackdrop,
  type SkinBackdropCandidate,
} from "../../lib/skin-preview-backdrops";
import { loadSkinPreviewBackgroundForSet, skinPreviewBackgroundThumbUrl } from "../../lib/skin-preview-render";

// The row of map covers offered as the backdrop behind rendered skin previews,
// plus the pool it draws from. Shared by the surfaces that render previews so
// a pick, a shuffle and a dead cover behave the same everywhere. The row and
// its scope toggle are laid out by SkinPreviewPickers, which tabs between this
// and the pattern row.

// What the row itself needs, which is all a surface keeping its own backdrop
// state has to hand over.
export interface SkinBackdropRowPool {
  candidates: SkinBackdropCandidate[];
  drawing: boolean;
  // Draws a fresh set, skipping whatever is on offer right now.
  shuffle: () => void;
  // Drops a cover whose art turned out to be missing.
  drop: (setId: number) => void;
  // Warms a cover on hover so picking it usually renders straight away.
  prefetch: (setId: number) => void;
}

export interface SkinBackdropPool extends SkinBackdropRowPool {
  shuffle: () => Promise<SkinBackdropCandidate[]>;
  // Decodes a cover for the canvas, memoized for the pool's lifetime.
  image: (setId: number) => Promise<HTMLImageElement | null>;
  // The covers already decoded, for renders that must not wait on a download.
  decoded: Map<number, HTMLImageElement | null>;
}

// Keeps one pool of covers for as long as `active` stays true, drawing the
// first set as soon as it flips on so the covers are usually warm before
// anyone looks at them. Going inactive clears it, so the next session draws
// different covers.
export function useSkinBackdropPool(active: boolean): SkinBackdropPool {
  const [candidates, setCandidates] = useState<SkinBackdropCandidate[]>([]);
  const candidatesRef = useRef<SkinBackdropCandidate[]>([]);
  const [drawing, setDrawing] = useState(false);
  const drawInFlightRef = useRef(false);
  const imagesRef = useRef<Map<number, HTMLImageElement | null>>(new Map());
  const decodingRef = useRef<Map<number, Promise<HTMLImageElement | null>>>(new Map());

  const draw = useCallback(async (exclude: number[]): Promise<SkinBackdropCandidate[]> => {
    setDrawing(true);
    try {
      const pool = await drawSkinPreviewBackdrops({ exclude });
      candidatesRef.current = pool;
      setCandidates(pool);
      return pool;
    } finally {
      setDrawing(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      candidatesRef.current = [];
      setCandidates([]);
      imagesRef.current.clear();
      decodingRef.current.clear();
      return;
    }
    if (candidatesRef.current.length > 0 || drawInFlightRef.current) return;
    drawInFlightRef.current = true;
    void draw([]).finally(() => {
      drawInFlightRef.current = false;
    });
  }, [active, draw]);

  const shuffle = useCallback(
    () => draw(candidatesRef.current.map((candidate) => candidate.setId)),
    [draw],
  );

  const drop = useCallback((setId: number) => {
    const remaining = candidatesRef.current.filter((candidate) => candidate.setId !== setId);
    if (remaining.length === candidatesRef.current.length) return;
    candidatesRef.current = remaining;
    setCandidates(remaining);
  }, []);

  // One decode per cover, shared by everything waiting on it: picking a cover
  // while it is still downloading must not start a second download.
  const image = useCallback((setId: number): Promise<HTMLImageElement | null> => {
    if (imagesRef.current.has(setId)) return Promise.resolve(imagesRef.current.get(setId) ?? null);
    const pending = decodingRef.current.get(setId);
    if (pending) return pending;
    const decoding = loadSkinPreviewBackgroundForSet(setId)
      .then((image) => {
        imagesRef.current.set(setId, image);
        return image;
      })
      .finally(() => decodingRef.current.delete(setId));
    decodingRef.current.set(setId, decoding);
    return decoding;
  }, []);

  const prefetch = useCallback((setId: number) => void image(setId), [image]);

  return { candidates, drawing, shuffle, drop, prefetch, image, decoded: imagesRef.current };
}

// A typed title, artist or mapper swaps the drawn covers for the maps that
// match it, for someone who has one map's art in mind and would otherwise
// shuffle until it happened to come up. The search sits in front of whatever
// pool the surface keeps: the results borrow its prefetch (any set id loads
// the same way) and only the results themselves are held here, so clearing
// the box lands back on the covers that were drawn before.
export interface SkinBackdropSearch {
  query: string;
  setQuery: (query: string) => void;
  // The row to show instead of the pool while a query is typed; null when the
  // box is empty.
  row: SkinBackdropRowPool | null;
  // Whether the last search could not reach the catalog.
  failed: boolean;
}

const SEARCH_DEBOUNCE_MS = 300;

export function useSkinBackdropSearch(pool: SkinBackdropRowPool): SkinBackdropSearch {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkinBackdropCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    requestRef.current += 1;
    const request = requestRef.current;
    if (!q) {
      setResults([]);
      setSearching(false);
      setFailed(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      searchSkinPreviewBackdrops(q)
        .then((found) => {
          if (requestRef.current !== request) return;
          setResults(found);
          setFailed(false);
        })
        .catch(() => {
          if (requestRef.current !== request) return;
          setResults([]);
          setFailed(true);
        })
        .finally(() => {
          if (requestRef.current === request) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const drop = useCallback((setId: number) => {
    setResults((current) => current.filter((candidate) => candidate.setId !== setId));
  }, []);

  const row = useMemo<SkinBackdropRowPool | null>(() => {
    if (!query.trim()) return null;
    return {
      candidates: results,
      drawing: searching,
      // A shuffle while searching is handled by the header, which clears the
      // query first; the row itself never draws.
      shuffle: () => {},
      drop,
      prefetch: pool.prefetch,
    };
  }, [query, results, searching, drop, pool.prefetch]);

  return { query, setQuery, row, failed };
}

export function SkinBackdropSearchBox({
  search,
  disabled,
}: {
  search: SkinBackdropSearch;
  disabled: boolean;
}) {
  const { t } = useLingui();
  return (
    <label
      className={`flex h-[22px] items-center gap-1 rounded border border-osu-b3/40 bg-osu-b5 px-1.5 text-[10px] text-osu-l2 transition-colors focus-within:border-osu-pink/60 ${
        disabled ? "opacity-50" : "hover:border-osu-f1/40"
      }`}
    >
      <Search size={11} aria-hidden="true" className="shrink-0 text-osu-f1/55" />
      <input
        type="search"
        value={search.query}
        disabled={disabled}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && search.query) {
            event.preventDefault();
            search.setQuery("");
          }
        }}
        placeholder={t`find a map`}
        aria-label={t`Search maps for a backdrop`}
        autoComplete="off"
        spellCheck={false}
        className="w-24 bg-transparent font-bold text-osu-l1 outline-none transition-[width] placeholder:font-normal placeholder:text-osu-f1/45 focus:w-36 disabled:cursor-default [&::-webkit-search-cancel-button]:hidden"
      />
      {search.query && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => search.setQuery("")}
          aria-label={t`Clear map search`}
          className="shrink-0 text-osu-f1/55 transition-colors cursor-pointer hover:text-osu-l1 disabled:cursor-default"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </label>
  );
}

// Scope of a pick: every keymode, or just the one on screen. Picking on "all"
// also clears the per-keymode choices, so it is the way back to a single
// shared backdrop.
export function SkinBackdropScopeToggle({
  scope,
  onScopeChange,
  // The keymode a "this one only" pick would apply to, e.g. "4K".
  keymodeLabel,
  disabled,
}: {
  scope: BackdropScope;
  onScopeChange: (scope: BackdropScope) => void;
  keymodeLabel: string;
  disabled: boolean;
}) {
  const { t } = useLingui();
  return (
    <div className="flex overflow-hidden rounded border border-osu-b3/40">
      {(["all", "keymode"] as const).map((option) => (
        <button
          key={option}
          type="button"
          disabled={disabled}
          onClick={() => onScopeChange(option)}
          aria-pressed={scope === option}
          title={option === "all"
            ? t`Apply picks to every keymode preview`
            : t`Apply picks to the ${keymodeLabel} preview only`}
          className={`px-1.5 py-0.5 text-[10px] font-bold transition-colors cursor-pointer disabled:cursor-default ${
            scope === option ? "bg-osu-pink text-white" : "bg-osu-b5 text-osu-l2 hover:text-osu-l1"
          }`}
        >
          {option === "all" ? t`all keymodes` : t`${keymodeLabel} only`}
        </button>
      ))}
    </div>
  );
}

export function SkinBackdropRow({
  pool,
  // The backdrop behind the keymode on screen; null while nothing has been
  // picked, which is how an edit starts out (the published renders stay).
  selected,
  onPick,
  disabled,
  // What to say when the row comes up empty and nothing is being drawn:
  // a search that matched no map, or one that could not reach the catalog.
  // The drawn pool says nothing, since a failed draw falls back to baked
  // covers instead of an empty row.
  emptyNotice,
  // What the row says while it is empty and still loading; the drawn pool's
  // wording by default.
  busyNotice,
}: {
  pool: SkinBackdropRowPool;
  selected: PreviewBackdrop | null;
  onPick: (choice: PreviewBackdrop) => void;
  disabled: boolean;
  emptyNotice?: React.ReactNode;
  busyNotice?: React.ReactNode;
}) {
  const { t } = useLingui();
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick("flat")}
        aria-pressed={selected === "flat"}
        title={t`Flat backdrop tinted with the skin's accent`}
        className={`grid h-8 w-[52px] shrink-0 place-items-center rounded border text-[10px] font-bold text-osu-l2 transition-colors cursor-pointer disabled:cursor-default ${
          selected === "flat" ? "border-osu-pink bg-osu-b5" : "border-osu-b3/40 bg-osu-b5 hover:border-osu-f1/40"
        }`}
      >
        <Trans>flat</Trans>
      </button>
      {pool.candidates.map((candidate) => (
        <button
          key={candidate.setId}
          type="button"
          disabled={disabled}
          onClick={() => onPick(candidate.setId)}
          onPointerEnter={() => pool.prefetch(candidate.setId)}
          onFocus={() => pool.prefetch(candidate.setId)}
          aria-pressed={selected === candidate.setId}
          aria-label={candidate.label
            ? t`Use ${candidate.label} as the backdrop`
            : t`Use map cover ${candidate.setId} as the backdrop`}
          title={candidate.label || undefined}
          className={`h-8 w-[52px] shrink-0 overflow-hidden rounded border transition-colors cursor-pointer disabled:cursor-default ${
            selected === candidate.setId ? "border-osu-pink" : "border-osu-b3/40 hover:border-osu-f1/40"
          }`}
        >
          <img
            src={skinPreviewBackgroundThumbUrl(candidate.setId)}
            alt=""
            loading="lazy"
            onError={() => pool.drop(candidate.setId)}
            className="h-full w-full object-cover"
          />
        </button>
      ))}
      {pool.candidates.length === 0 && pool.drawing && (
        <span className="text-[10px] text-osu-f1/50">{busyNotice ?? <Trans>drawing covers</Trans>}</span>
      )}
      {pool.candidates.length === 0 && !pool.drawing && emptyNotice && (
        <span className="text-[10px] text-osu-f1/50">{emptyNotice}</span>
      )}
    </>
  );
}
