import { useCallback, useEffect, useRef, useState } from "react";
import { Shuffle } from "lucide-react";
import {
  drawSkinPreviewBackdrops,
  type BackdropScope,
  type PreviewBackdrop,
  type SkinBackdropCandidate,
} from "../../lib/skin-preview-backdrops";
import { loadSkinPreviewBackgroundForSet, skinPreviewBackgroundThumbUrl } from "../../lib/skin-preview-render";

// The row of map covers offered as the backdrop behind rendered skin previews,
// plus the pool it draws from. Shared by the surfaces that render previews so
// a pick, a shuffle and a dead cover behave the same everywhere.

export interface SkinBackdropPool {
  candidates: SkinBackdropCandidate[];
  drawing: boolean;
  // Draws a fresh set, skipping whatever is on offer right now.
  shuffle: () => Promise<SkinBackdropCandidate[]>;
  // Drops a cover whose art turned out to be missing.
  drop: (setId: number) => void;
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

  return { candidates, drawing, shuffle, drop, image, decoded: imagesRef.current };
}

export function SkinBackdropPicker({
  pool,
  // The backdrop behind the keymode on screen; null while nothing has been
  // picked, which is how an edit starts out (the published renders stay).
  selected,
  onPick,
  scope,
  onScopeChange,
  keymodeLabel,
  hint,
  disabled,
}: {
  pool: SkinBackdropPool;
  selected: PreviewBackdrop | null;
  onPick: (choice: PreviewBackdrop) => void;
  scope: BackdropScope;
  onScopeChange: (scope: BackdropScope) => void;
  // The keymode a "this one only" pick would apply to, e.g. "4K".
  keymodeLabel: string;
  hint?: React.ReactNode;
  disabled: boolean;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Preview backdrop</span>
        {/* Scope of a pick: every keymode, or just the one on screen. Picking
            on "all" also clears the per-keymode choices, so it is the way back
            to a single shared backdrop. */}
        <div className="flex overflow-hidden rounded border border-osu-b3/40">
          {(["all", "keymode"] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => onScopeChange(option)}
              aria-pressed={scope === option}
              title={option === "all"
                ? "Apply picks to every keymode preview"
                : `Apply picks to the ${keymodeLabel} preview only`}
              className={`px-1.5 py-0.5 text-[10px] font-bold transition-colors cursor-pointer disabled:cursor-default ${
                scope === option ? "bg-osu-pink text-white" : "bg-osu-b5 text-osu-l2 hover:text-osu-l1"
              }`}
            >
              {option === "all" ? "all keymodes" : `${keymodeLabel} only`}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={disabled || pool.drawing}
          onClick={() => void pool.shuffle()}
          title="Draw a different set of map covers"
          className="flex items-center gap-1 rounded border border-osu-b3/40 bg-osu-b5 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2 transition-colors cursor-pointer hover:border-osu-f1/40 disabled:cursor-default disabled:opacity-50"
        >
          <Shuffle size={11} aria-hidden="true" />
          {pool.drawing ? "drawing" : "shuffle"}
        </button>
        {hint}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick("flat")}
          aria-pressed={selected === "flat"}
          title="Flat backdrop tinted with the skin's accent"
          className={`grid h-8 w-[52px] place-items-center rounded border text-[10px] font-bold text-osu-l2 transition-colors cursor-pointer disabled:cursor-default ${
            selected === "flat" ? "border-osu-pink bg-osu-b5" : "border-osu-b3/40 bg-osu-b5 hover:border-osu-f1/40"
          }`}
        >
          flat
        </button>
        {pool.candidates.map((candidate) => (
          <button
            key={candidate.setId}
            type="button"
            disabled={disabled}
            onClick={() => onPick(candidate.setId)}
            onPointerEnter={() => void pool.image(candidate.setId)}
            onFocus={() => void pool.image(candidate.setId)}
            aria-pressed={selected === candidate.setId}
            aria-label={`Use ${candidate.label || `map cover ${candidate.setId}`} as the backdrop`}
            title={candidate.label || undefined}
            className={`h-8 w-[52px] overflow-hidden rounded border transition-colors cursor-pointer disabled:cursor-default ${
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
          <span className="text-[10px] text-osu-f1/50">drawing covers</span>
        )}
      </div>
    </div>
  );
}
