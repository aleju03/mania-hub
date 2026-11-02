import { useLingui } from "@lingui/react/macro";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EXTENT, REGION, regionOrigin, type BoardEngine } from "./boardEngine";

/* The whole board in a corner: where cards are (brighter for more), where
   the viewer's own are (pink), and a box for what is on screen. Clicking or
   dragging on it moves the view there. Drawn on request (the host calls
   draw() when the view or the cards change), never on a loop. */

export interface BoardMinimapHandle {
  draw: () => void;
}

/* Side in CSS pixels: smaller on a phone, where the board itself is small. */
const SIZE = 132;
const SMALL_SIZE = 76;

export const BoardMinimap = forwardRef<BoardMinimapHandle, {
  engine: BoardEngine | null;
  /* Regions with cards and how many: [id, count]. */
  regions: () => [number, number][];
  /* The regions the viewer's own cards are in. */
  mine: () => Iterable<number>;
}>(function BoardMinimap({ engine, regions, mine }, ref) {
  const { t } = useLingui();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(SIZE);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 640px)");
    const pick = () => setSize(wide.matches ? SIZE : SMALL_SIZE);
    pick();
    wide.addEventListener("change", pick);
    return () => wide.removeEventListener("change", pick);
  }, []);

  const draw = useCallback(() => {
    const node = canvas.current;
    if (!node || !engine) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (node.width !== size * dpr) {
      node.width = size * dpr;
      node.height = size * dpr;
    }
    const g = node.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.fillStyle = "rgba(20,18,24,0.85)";
    g.fillRect(0, 0, size, size);
    const scale = size / (EXTENT * 2);
    const cell = REGION * scale;
    const at = (x: number, y: number): [number, number] => [(x + EXTENT) * scale, (y + EXTENT) * scale];
    for (const [id, count] of regions()) {
      const [x, y] = at(...regionOrigin(id));
      g.fillStyle = `rgba(255,255,255,${Math.min(0.75, 0.18 + count / 600)})`;
      g.fillRect(x, y, cell, cell);
    }
    g.fillStyle = "#ff66ab";
    for (const id of new Set(mine())) {
      const [x, y] = at(...regionOrigin(id));
      g.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    }
    // what is on screen, at least a few pixels so it can always be found
    const { width, height } = engine.viewSize;
    const [cx, cy] = at(engine.cam.x, engine.cam.y);
    const w = Math.max(4, (width / engine.cam.z) * scale);
    const h = Math.max(4, (height / engine.cam.z) * scale);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 1.25;
    g.strokeRect(cx - w / 2, cy - h / 2, w, h);
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, size - 1, size - 1);
  }, [engine, regions, mine, size]);

  // redrawn at its new size
  useEffect(() => draw(), [draw]);

  useImperativeHandle(ref, () => ({ draw }), [draw]);

  const jump = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!engine) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * EXTENT * 2 - EXTENT;
    const y = ((event.clientY - box.top) / box.height) * EXTENT * 2 - EXTENT;
    engine.goTo(x, y);
  };

  return (
    <canvas
      ref={canvas}
      aria-label={t`Board map`}
      title={t`Board map`}
      style={{ width: size, height: size }}
      className="absolute bottom-7 right-3 cursor-pointer rounded-md shadow-lg"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        jump(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons) jump(event);
      }}
    />
  );
});
