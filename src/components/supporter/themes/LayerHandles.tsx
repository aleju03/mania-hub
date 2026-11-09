import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { Layer, LayerDoc } from "../../../lib/custom-theme-layers";

/* Handles over the layer editor's preview, to work on the picture itself:
   click an image to pick it and drag it about, pull its corner to size it
   and its top knob to turn it; drag a glow's centre and its ring; point the
   particles' arrow; drag a picture background to pan it. Positions are the
   generator's: canvas heights from the middle, y up. */

type Patch = (id: string, patch: Partial<Layer>) => void;

function useBox(ref: React.RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

const aspects = new Map<string, number>();
function useAspect(url: string | null): number {
  const [aspect, setAspect] = useState(() => (url ? aspects.get(url) ?? 1 : 1));
  useEffect(() => {
    if (!url) return;
    const known = aspects.get(url);
    if (known) {
      setAspect(known);
      return;
    }
    const image = new Image();
    image.onload = () => {
      const value = image.naturalWidth / Math.max(1, image.naturalHeight);
      aspects.set(url, value);
      setAspect(value);
    };
    image.src = url;
  }, [url]);
  return aspect;
}

/* A drag that reports the pointer in the overlay's own pixels. */
/* Modifier keys held during a drag, read on every move so pressing one
   mid-drag takes effect: Shift constrains (one axis, 15° turns), Alt resizes
   from the opposite corner instead of the centre. */
type DragKeys = { shift: boolean; alt: boolean };

function startDrag(event: ReactPointerEvent, host: HTMLElement, onMove: (x: number, y: number, keys: DragKeys) => void) {
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget as HTMLElement;
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    /* synthetic events */
  }
  const move = (moveEvent: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    onMove(moveEvent.clientX - rect.left, moveEvent.clientY - rect.top, { shift: moveEvent.shiftKey, alt: moveEvent.altKey });
  };
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

export function LayerHandles({ doc, selected, onSelect, onPatch, onMenu }: {
  doc: LayerDoc;
  selected: string | null;
  onSelect: (id: string) => void;
  onPatch: Patch;
  /* Right-click on a picture: the layer menu at the pointer. */
  onMenu?: (id: string, x: number, y: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const box = useBox(hostRef);
  const current = doc.layers.find((layer) => layer.id === selected && !layer.hidden) ?? null;
  const toPx = (x: number, y: number) => [box.width / 2 + x * box.height, box.height / 2 - y * box.height] as const;
  const toP = (px: number, py: number) => [(px - box.width / 2) / box.height, (box.height / 2 - py) / box.height] as const;
  const panning = current?.kind === "background" && current.fill === "image";

  return (
    <div
      ref={hostRef}
      className={`absolute inset-0 ${panning ? "cursor-move" : "pointer-events-none"}`}
      onPointerDown={(event) => {
        if (!panning || !hostRef.current || current?.kind !== "background") return;
        const start = { px: event.clientX, py: event.clientY, x: current.x, y: current.y };
        const rect = hostRef.current.getBoundingClientRect();
        startDrag(event, hostRef.current, (px, py) => {
          const scale = box.height * 0.3 / current.zoom;
          onPatch(current.id, {
            x: Math.max(-1, Math.min(1, start.x - (px + rect.left - start.px) / scale)),
            y: Math.max(-1, Math.min(1, start.y + (py + rect.top - start.py) / scale)),
          });
        });
      }}
    >
      {box.height > 0
        ? doc.layers.map((layer) => (layer.kind === "image" && layer.image && !layer.hidden ? (
          <ImageHandle key={layer.id} layer={layer} picked={layer.id === selected} host={hostRef} toPx={toPx} toP={toP} height={box.height} onSelect={onSelect} onPatch={onPatch} onMenu={onMenu} />
        ) : null))
        : null}
      {current?.kind === "glow" && box.height > 0 ? <GlowHandle layer={current} host={hostRef} toPx={toPx} toP={toP} height={box.height} onPatch={onPatch} /> : null}
      {current?.kind === "particles" && box.height > 0 ? <DirectionHandle layer={current} host={hostRef} box={box} onPatch={onPatch} /> : null}
    </div>
  );
}

type Convert = (x: number, y: number) => readonly [number, number];

function ImageHandle({ layer, picked, host, toPx, toP, height, onSelect, onPatch, onMenu }: {
  layer: Extract<Layer, { kind: "image" }>;
  picked: boolean;
  host: React.RefObject<HTMLDivElement | null>;
  toPx: Convert;
  toP: Convert;
  height: number;
  onSelect: (id: string) => void;
  onPatch: Patch;
  onMenu?: (id: string, x: number, y: number) => void;
}) {
  const { t } = useLingui();
  const aspect = useAspect(layer.image);
  const [cx, cy] = toPx(layer.x, layer.y);
  const h = layer.size * height;
  const w = h * aspect;
  return (
    <div
      title={picked ? t`Hold Shift to move along one axis` : undefined}
      className={`pointer-events-auto absolute cursor-move ${picked ? "outline outline-1 outline-white/90" : "hover:outline hover:outline-1 hover:outline-white/40"}`}
      style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${-layer.angle}deg)` }}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect(layer.id);
        onMenu?.(layer.id, event.clientX, event.clientY);
      }}
      onPointerDown={(event) => {
        if (!host.current) return;
        onSelect(layer.id);
        // only the main button drags; a right-click opens the menu
        if (event.button !== 0) return;
        const rect = host.current.getBoundingClientRect();
        const [startX, startY] = toP(event.clientX - rect.left, event.clientY - rect.top);
        const from = { x: layer.x, y: layer.y };
        startDrag(event, host.current, (px, py, keys) => {
          const [x, y] = toP(px, py);
          let dx = x - startX;
          let dy = y - startY;
          // Shift keeps the move on whichever axis it has gone further along
          if (keys.shift) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          onPatch(layer.id, { x: from.x + dx, y: from.y + dy });
        });
      }}
    >
      {picked ? (
        <>
          <span
            role="slider"
            aria-label={t`Size`}
            title={t`Hold Alt to resize from the opposite corner`}
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-[2px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            onPointerDown={(event) => {
              if (!host.current) return;
              const perDiagonal = height * Math.sqrt(aspect * aspect + 1);
              const clampSize = (size: number) => Math.max(0.02, Math.min(3, size));
              // the corners at the drag's start, turned with the picture
              const turn = (-layer.angle * Math.PI) / 180;
              const corner = (x: number, y: number) => [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)] as const;
              const [offX, offY] = corner(-w / 2, -h / 2);
              const anchorX = cx + offX;
              const anchorY = cy + offY;
              const diagonal = Math.hypot(w, h) || 1;
              const alongX = -2 * offX / diagonal;
              const alongY = -2 * offY / diagonal;
              startDrag(event, host.current, (px, py, keys) => {
                if (!keys.alt) {
                  onPatch(layer.id, { size: clampSize((2 * Math.hypot(px - cx, py - cy)) / perDiagonal) });
                  return;
                }
                // Alt: the opposite corner stays put and the centre follows
                const size = clampSize(((px - anchorX) * alongX + (py - anchorY) * alongY) / perDiagonal);
                const reach = size * perDiagonal;
                const [x, y] = toP(anchorX + alongX * reach / 2, anchorY + alongY * reach / 2);
                onPatch(layer.id, { size, x, y });
              });
            }}
          />
          <span className="absolute -top-6 left-1/2 h-5 w-px -translate-x-1/2 bg-white/70" />
          <span
            role="slider"
            aria-label={t`Turn`}
            title={t`Hold Shift to turn in 15° steps`}
            className="absolute -top-8 left-1/2 h-3.5 w-3.5 -translate-x-1/2 cursor-grab rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            onPointerDown={(event) => {
              if (!host.current) return;
              startDrag(event, host.current, (px, py, keys) => {
                let angle = (Math.atan2(cy - py, px - cx) * 180) / Math.PI - 90;
                if (angle < -180) angle += 360;
                // Shift turns in 15° steps; otherwise it settles on the quarter turns
                if (keys.shift) {
                  onPatch(layer.id, { angle: Math.round(angle / 15) * 15 });
                  return;
                }
                const snapped = Math.round(angle / 90) * 90;
                onPatch(layer.id, { angle: Math.abs(angle - snapped) < 4 ? snapped : Math.round(angle) });
              });
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function GlowHandle({ layer, host, toPx, toP, height, onPatch }: {
  layer: Extract<Layer, { kind: "glow" }>;
  host: React.RefObject<HTMLDivElement | null>;
  toPx: Convert;
  toP: Convert;
  height: number;
  onPatch: Patch;
}) {
  const { t } = useLingui();
  const [cx, cy] = toPx(layer.x, layer.y);
  const ring = layer.radius * 3 * height;
  return (
    <>
      <span
        role="slider"
        aria-label={t`Glow size`}
        className="pointer-events-auto absolute cursor-ew-resize rounded-full border border-dashed border-white/60"
        style={{ left: cx - ring, top: cy - ring, width: ring * 2, height: ring * 2 }}
        onPointerDown={(event) => {
          if (!host.current) return;
          startDrag(event, host.current, (px, py) => onPatch(layer.id, { radius: Math.max(0.01, Math.min(1, Math.hypot(px - cx, py - cy) / (3 * height))) }));
        }}
      />
      <span
        role="slider"
        aria-label={t`Glow position`}
        className="pointer-events-auto absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2 border-white bg-black/40"
        style={{ left: cx, top: cy }}
        onPointerDown={(event) => {
          if (!host.current) return;
          startDrag(event, host.current, (px, py) => {
            const [x, y] = toP(px, py);
            onPatch(layer.id, { x, y });
          });
        }}
      />
    </>
  );
}

function DirectionHandle({ layer, host, box, onPatch }: {
  layer: Extract<Layer, { kind: "particles" }>;
  host: React.RefObject<HTMLDivElement | null>;
  box: { width: number; height: number };
  onPatch: Patch;
}) {
  const { t } = useLingui();
  const cx = box.width / 2;
  const cy = box.height / 2;
  const length = 56;
  const radians = (layer.direction * Math.PI) / 180;
  const tipX = cx + Math.cos(radians) * length;
  const tipY = cy - Math.sin(radians) * length;
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        <line x1={cx} y1={cy} x2={tipX} y2={tipY} stroke="white" strokeWidth="2" strokeDasharray="4 3" />
        <circle cx={cx} cy={cy} r="3" fill="white" />
      </svg>
      <span
        role="slider"
        aria-label={t`Direction`}
        className="pointer-events-auto absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-osu-pink"
        style={{ left: tipX, top: tipY }}
        onPointerDown={(event) => {
          if (!host.current) return;
          startDrag(event, host.current, (px, py) => {
            const angle = ((Math.atan2(cy - py, px - cx) * 180) / Math.PI + 360) % 360;
            onPatch(layer.id, { direction: Math.round(angle) });
          });
        }}
      />
    </>
  );
}
