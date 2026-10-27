import { useLingui } from "@lingui/react/macro";
import { useRef } from "react";

import { rowCrop, type RowFraming } from "../../../lib/custom-theme-editor-gl";
import { Slider } from "./EditorControls";

const ZOOM_MAX = 4;

/* Frames the banner row on a frame of the theme: drag the box to move it,
   drag a corner to size it (the opposite corner stays put), or scroll over
   it or use the slider to zoom. The outside dims, so what the row will show
   reads at a glance. */
export function RowFramer({ source, framing, onChange, aspect }: {
  source: { url: string; width: number; height: number } | null;
  framing: RowFraming;
  onChange: (framing: RowFraming) => void;
  /** The row's own shape, width over height. */
  aspect: number;
}) {
  const { t } = useLingui();
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; framing: RowFraming } | null>(null);
  const crop = source ? rowCrop(source.width, source.height, framing, aspect) : null;
  const zoom = (next: number) => onChange({ ...framing, zoom: Math.min(ZOOM_MAX, Math.max(1, next)) });
  const resize = useRef<{ corner: [0 | 1, 0 | 1] } | null>(null);

  /* A corner dragged to (px, py), in fractions of the frame: the box keeps
     its shape and the opposite corner, within the frame and the zoom range. */
  const resizeTo = (corner: [0 | 1, 0 | 1], px: number, py: number) => {
    if (!source || !crop) return;
    const full = rowCrop(source.width, source.height, { zoom: 1, x: 0.5, y: 0.5 }, aspect).width;
    const ratio = crop.height / crop.width;
    const ax = corner[0] === 0 ? crop.left + crop.width : crop.left;
    const ay = corner[1] === 0 ? crop.top + crop.height : crop.top;
    const room = Math.min(full, corner[0] === 0 ? ax : 1 - ax, (corner[1] === 0 ? ay : 1 - ay) / ratio);
    const wanted = Math.max(Math.abs(px - ax), Math.abs(py - ay) / ratio);
    const width = Math.max(full / ZOOM_MAX, Math.min(room, wanted));
    const height = width * ratio;
    const left = corner[0] === 0 ? ax - width : ax;
    const top = corner[1] === 0 ? ay - height : ay;
    onChange({
      zoom: Math.min(ZOOM_MAX, Math.max(1, full / width)),
      x: 1 - width > 1e-6 ? Math.min(1, Math.max(0, left / (1 - width))) : 0.5,
      y: 1 - height > 1e-6 ? Math.min(1, Math.max(0, top / (1 - height))) : 0.5,
    });
  };

  return (
    <div>
      <div
        ref={boxRef}
        className="relative w-full touch-none select-none overflow-hidden rounded-lg bg-osu-b6 ring-1 ring-white/[0.07]"
        style={{ aspectRatio: source ? `${source.width} / ${source.height}` : "16 / 10" }}
        onWheel={(event) => {
          if (!source) return;
          event.preventDefault();
          zoom(framing.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
        }}
      >
        {source ? <img src={source.url} alt="" draggable={false} className="absolute inset-0 h-full w-full" /> : null}
        {crop ? (
          <div
            role="slider"
            aria-label={t`Banner row framing`}
            tabIndex={0}
            className="absolute cursor-grab rounded-[3px] outline outline-2 outline-white active:cursor-grabbing"
            style={{
              left: `${crop.left * 100}%`,
              top: `${crop.top * 100}%`,
              width: `${crop.width * 100}%`,
              height: `${crop.height * 100}%`,
              boxShadow: "0 0 0 9999px rgba(10,6,14,0.62)",
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, framing };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              const box = boxRef.current?.getBoundingClientRect();
              if (!box || !crop) return;
              if (resize.current) {
                resizeTo(resize.current.corner, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
                return;
              }
              if (!start) return;
              const freeX = (1 - crop.width) * box.width;
              const freeY = (1 - crop.height) * box.height;
              onChange({
                ...start.framing,
                x: freeX > 0 ? Math.min(1, Math.max(0, start.framing.x + (event.clientX - start.x) / freeX)) : start.framing.x,
                y: freeY > 0 ? Math.min(1, Math.max(0, start.framing.y + (event.clientY - start.y) / freeY)) : start.framing.y,
              });
            }}
            onPointerUp={() => {
              drag.current = null;
              resize.current = null;
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.1 : 0.02;
              const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              const move = moves[event.key];
              if (!move) return;
              event.preventDefault();
              onChange({ ...framing, x: Math.min(1, Math.max(0, framing.x + move[0])), y: Math.min(1, Math.max(0, framing.y + move[1])) });
            }}
          >
            <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/25" />
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/25" />
            {([[0, 0], [1, 0], [0, 1], [1, 1]] as const).map(([cx, cy]) => (
              <span
                key={`${cx}${cy}`}
                aria-hidden
                className="absolute h-3 w-3 rounded-[2px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{
                  left: cx === 0 ? -6 : undefined,
                  right: cx === 1 ? -6 : undefined,
                  top: cy === 0 ? -6 : undefined,
                  bottom: cy === 1 ? -6 : undefined,
                  cursor: cx === cy ? "nwse-resize" : "nesw-resize",
                }}
                onPointerDown={() => {
                  resize.current = { corner: [cx, cy] };
                }}
              />
            ))}
          </div>
        ) : (
          <span className="absolute inset-0 grid place-items-center text-[11.5px] text-osu-f1">{t`Waiting for the theme`}</span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11.5px] text-osu-f1">
        <span className="w-10">{t`Zoom`}</span>
        <Slider value={framing.zoom} min={1} max={ZOOM_MAX} step={0.01} onChange={zoom} label={t`Zoom`} format={(value) => `${value.toFixed(1)}x`} />
      </div>
    </div>
  );
}
