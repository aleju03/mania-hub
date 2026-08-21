import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { drawSkinPreviewPatterns, type SkinPreviewChartSnippet } from "../../lib/skin-preview-patterns";
import {
  buildChartPreviewPattern,
  buildSkinPreviewPattern,
  SKIN_PREVIEW_HEIGHT,
  type SkinPreviewPattern,
} from "../../lib/skin-preview-render";

// The row of chart snippets offered as the notes on a rendered skin preview,
// plus the pool it draws from. Shared by the surfaces that render previews so a
// pick and a shuffle behave the same everywhere; SkinPreviewPickers lays the
// row out, tabbed against the backdrop row.
//
// A snippet is cut from a chart of one keymode and only fits that keymode, so
// unlike the backdrop picker there is no "apply to all keymodes" scope: the
// pool, the pick and the shuffle all belong to the keymode on screen.

// The geometry the thumbnails lay a snippet out at: the card's own, so what the
// row shows is what the render will show, only smaller.
const THUMB_NOTE_HEIGHT = 44;
const THUMB_WIDTH = 52;
const THUMB_HEIGHT = 32;

export interface SkinPatternPool {
  // The snippets on offer for the keymode this pool is following.
  candidates: SkinPreviewChartSnippet[];
  keys: number;
  drawing: boolean;
  // Draws a fresh set for the keymode on screen, skipping what is on offer now.
  shuffle: () => Promise<SkinPreviewChartSnippet[]>;
  // The pool for any keymode, drawn if this is the first ask. What a surface
  // that renders several keymodes at once (an upload ships every keymode the
  // .osk has) uses to deal each one a pattern of its own.
  ensure: (keys: number) => Promise<SkinPreviewChartSnippet[]>;
}

// Keeps one pool per keymode for as long as `active` stays true, drawing a
// keymode's pool the first time it is asked for. Going inactive clears
// everything, so the next session gets different charts.
export function useSkinPatternPool(active: boolean, keys: number): SkinPatternPool {
  const [candidates, setCandidates] = useState<SkinPreviewChartSnippet[]>([]);
  const [drawing, setDrawing] = useState(false);
  const poolsRef = useRef<Map<number, SkinPreviewChartSnippet[]>>(new Map());
  // Draws in flight, so a second ask for a keymode waits on the first one
  // rather than firing its own request or reading back an empty pool.
  const pendingRef = useRef<Map<number, Promise<SkinPreviewChartSnippet[]>>>(new Map());
  // Which keymode the state above belongs to, so a draw that lands after the
  // uploader moved on does not show up under the wrong keymode.
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const draw = useCallback((target: number, exclude: number[]): Promise<SkinPreviewChartSnippet[]> => {
    const inFlight = pendingRef.current.get(target);
    if (inFlight) return inFlight;
    if (keysRef.current === target) setDrawing(true);
    const drawing = drawSkinPreviewPatterns({ keys: target, exclude })
      .then((pool) => {
        poolsRef.current.set(target, pool);
        if (keysRef.current === target) setCandidates(pool);
        return pool;
      })
      .finally(() => {
        pendingRef.current.delete(target);
        if (keysRef.current === target) setDrawing(false);
      });
    pendingRef.current.set(target, drawing);
    return drawing;
  }, []);

  useEffect(() => {
    if (!active) {
      poolsRef.current.clear();
      pendingRef.current.clear();
      setCandidates([]);
      return;
    }
    const cached = poolsRef.current.get(keys);
    if (cached) {
      setCandidates(cached);
      return;
    }
    setCandidates([]);
    void draw(keys, []);
  }, [active, keys, draw]);

  const shuffle = useCallback(
    () => draw(keys, (poolsRef.current.get(keys) ?? []).map((snippet) => snippet.beatmapId)),
    [draw, keys],
  );

  const ensure = useCallback(
    async (target: number) => poolsRef.current.get(target) ?? (await draw(target, [])),
    [draw],
  );

  return { candidates, keys, drawing, shuffle, ensure };
}

export function SkinPatternRow({
  pool,
  // The snippet the keymode on screen is set to render with; null is the
  // built-in layout, which is what a skin published before the picker existed
  // was drawn with. Undefined is an older flattened preview whose pattern was
  // never recorded, so the row truthfully leaves every choice unselected.
  selected,
  onPick,
  disabled,
}: {
  pool: SkinPatternPool;
  selected: SkinPreviewChartSnippet | null | undefined;
  onPick: (choice: SkinPreviewChartSnippet | null) => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const builtIn = useMemo(() => patternFor(null, pool.keys), [pool.keys]);
  return (
    <>
      <PatternButton
        pattern={builtIn}
        keys={pool.keys}
        label={t`Built-in layout`}
        selected={selected === null}
        disabled={disabled}
        onPick={() => onPick(null)}
      />
      {pool.candidates.map((snippet) => (
        <PatternButton
          key={snippet.beatmapId}
          pattern={patternFor(snippet, pool.keys)}
          keys={snippet.keys}
          label={snippet.stars ? t`${snippet.label} (${snippet.stars.toFixed(2)} stars)` : snippet.label}
          selected={selected?.beatmapId === snippet.beatmapId}
          disabled={disabled}
          onPick={() => onPick(snippet)}
        />
      ))}
      {pool.candidates.length === 0 && (
        <span className="text-[10px] text-osu-f1/50">
          {pool.drawing ? "drawing charts" : `no ${pool.keys}K charts to cut from`}
        </span>
      )}
    </>
  );
}

function PatternButton({
  pattern,
  keys,
  label,
  selected,
  disabled,
  onPick,
}: {
  pattern: SkinPreviewPattern;
  keys: number;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      aria-pressed={selected}
      aria-label={`Use the notes from ${label}`}
      title={label}
      className={`shrink-0 overflow-hidden rounded border bg-osu-b4 transition-colors cursor-pointer disabled:cursor-default ${
        selected ? "border-osu-pink" : "border-osu-b3/40 hover:border-osu-f1/40"
      }`}
    >
      <PatternThumbnail pattern={pattern} keys={keys} />
    </button>
  );
}

// The snippet drawn at the card's proportions and scaled down, so a thumbnail
// shows the notes the render will actually put on the field.
function patternFor(snippet: SkinPreviewChartSnippet | null, keys: number): SkinPreviewPattern {
  const options = { canvasHeight: SKIN_PREVIEW_HEIGHT, noteHeight: THUMB_NOTE_HEIGHT };
  return snippet ? buildChartPreviewPattern(snippet, options) : buildSkinPreviewPattern(keys, options);
}

function PatternThumbnail({ pattern, keys }: { pattern: SkinPreviewPattern; keys: number }) {
  const laneWidth = THUMB_WIDTH / Math.max(1, keys);
  const scale = THUMB_HEIGHT / SKIN_PREVIEW_HEIGHT;
  // Notes are a couple of pixels tall at this size whatever the card does with
  // them; any less and a 4K frame reads as noise.
  const noteHeight = 2.2;
  const lineY = SKIN_PREVIEW_HEIGHT * 0.9 * scale;
  return (
    <svg
      width={THUMB_WIDTH}
      height={THUMB_HEIGHT}
      viewBox={`0 0 ${THUMB_WIDTH} ${THUMB_HEIGHT}`}
      aria-hidden="true"
      className="block"
    >
      {pattern.longNotes.map((ln, index) => {
        const head = ln.headY * scale;
        const tail = ln.tailY * scale;
        return (
          <rect
            key={`ln-${index}`}
            x={ln.column * laneWidth + laneWidth * 0.3}
            y={Math.min(head, tail)}
            width={laneWidth * 0.4}
            height={Math.max(noteHeight, Math.abs(head - tail))}
            className="fill-osu-l2/45"
          />
        );
      })}
      {pattern.longNotes.map((ln, index) => (
        <rect
          key={`ln-head-${index}`}
          x={ln.column * laneWidth + laneWidth * 0.14}
          y={ln.headY * scale - noteHeight}
          width={laneWidth * 0.72}
          height={noteHeight}
          className="fill-osu-l1/85"
        />
      ))}
      {pattern.taps.map((tap, index) => (
        <rect
          key={`tap-${index}`}
          x={tap.column * laneWidth + laneWidth * 0.14}
          y={tap.y * scale - noteHeight}
          width={laneWidth * 0.72}
          height={noteHeight}
          className="fill-osu-l1/85"
        />
      ))}
      {Array.from({ length: keys }, (_, column) => (
        <rect
          key={`key-${column}`}
          x={column * laneWidth + laneWidth * 0.1}
          y={lineY + 0.6}
          width={laneWidth * 0.8}
          height={THUMB_HEIGHT - lineY - 1.2}
          className={pattern.pressed.includes(column) ? "fill-osu-pink" : "fill-osu-f1/35"}
        />
      ))}
    </svg>
  );
}
