import { AVATAR_INSET, AVATAR_SIZE, blankCanvas, cloneCanvas, DOC_CENTRE, DOC_SIZE, type Layer, type PathLayer, type PathPoint, type Pixels } from "./doc";
import { docBox } from "./ops";
import { docToLayerMatrix, drawInLayerSpace } from "./paint";
import { toDoc } from "./render";

/* Helpers behind the frame editor's gradient tool, pen tool, smart guides
   and moving selected pixels. */

/* --- Gradient tool ------------------------------------------------------------------ */

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) || 0);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* A gradient dragged from `start` to `end`, over the whole document, kept inside the selection. */
export function gradientCanvas(kind: "linear" | "radial" | "conic", start: [number, number], end: [number, number], from: string, to: string | null, opacity: number, selection: HTMLCanvasElement | null): HTMLCanvasElement {
  const canvas = blankCanvas();
  const ctx = canvas.getContext("2d")!;
  const second = to ?? withAlpha(from, 0);
  let gradient: CanvasGradient;
  if (kind === "radial") {
    gradient = ctx.createRadialGradient(start[0], start[1], 0, start[0], start[1], Math.max(1, Math.hypot(end[0] - start[0], end[1] - start[1])));
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, second);
  } else if (kind === "conic" && typeof ctx.createConicGradient === "function") {
    gradient = ctx.createConicGradient(Math.atan2(end[1] - start[1], end[0] - start[0]), start[0], start[1]);
    gradient.addColorStop(0, from);
    gradient.addColorStop(0.5, second);
    gradient.addColorStop(1, from);
  } else {
    gradient = ctx.createLinearGradient(start[0], start[1], end[0], end[1]);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, second);
  }
  ctx.globalAlpha = opacity;
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, DOC_SIZE, DOC_SIZE);
  if (selection) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(selection, 0, 0);
  }
  return canvas;
}

/* --- Smart guides ---------------------------------------------------------------------- */

export interface SnapTargets {
  xs: number[];
  ys: number[];
}

/* Where a moved layer can snap: the canvas, the avatar, its centre, and the other layers' edges and centres. */
export function snapTargets(layers: readonly Layer[], skip: string, pixels: Pixels): SnapTargets {
  const xs = [0, DOC_SIZE, DOC_CENTRE, AVATAR_INSET, AVATAR_INSET + AVATAR_SIZE];
  const ys = [...xs];
  for (const layer of layers) {
    if (layer.id === skip || !layer.visible) continue;
    const box = docBox(layer, pixels);
    if (!box) continue;
    const bounds = cornersBounds(box.corners);
    xs.push(bounds.x0, (bounds.x0 + bounds.x1) / 2, bounds.x1);
    ys.push(bounds.y0, (bounds.y0 + bounds.y1) / 2, bounds.y1);
  }
  return { xs, ys };
}

export function cornersBounds(corners: [number, number][]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/* How far to nudge a box so one of its edges or its centre meets a target, and the lines that met. */
export function snap(bounds: { x0: number; y0: number; x1: number; y1: number }, targets: SnapTargets, reach: number): { dx: number; dy: number; x: number | null; y: number | null } {
  const pick = (values: number[], candidates: number[]) => {
    let best: { delta: number; at: number } | null = null;
    for (const value of values) {
      for (const candidate of candidates) {
        const delta = candidate - value;
        if (Math.abs(delta) <= reach && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: candidate };
      }
    }
    return best;
  };
  const x = pick([bounds.x0, (bounds.x0 + bounds.x1) / 2, bounds.x1], targets.xs);
  const y = pick([bounds.y0, (bounds.y0 + bounds.y1) / 2, bounds.y1], targets.ys);
  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, x: x?.at ?? null, y: y?.at ?? null };
}

/* --- Pen tool ---------------------------------------------------------------------------- */

export type PenPart = "anchor" | "in" | "out";

/* The anchor or handle of a path under a document point. Handles are only live on the active anchor and its neighbours. */
export function penHit(layer: PathLayer, x: number, y: number, radius: number, active: number | null): { index: number; part: PenPart } | null {
  let best: { index: number; part: PenPart; distance: number } | null = null;
  layer.points.forEach((point, index) => {
    const near = active !== null && Math.abs(index - active) <= 1;
    const parts: [PenPart, number, number][] = [["anchor", point.x, point.y]];
    if (near) parts.push(["in", point.ix, point.iy], ["out", point.ox, point.oy]);
    for (const [part, px, py] of parts) {
      if (part !== "anchor" && px === point.x && py === point.y) continue;
      const [dx, dy] = toDoc(layer, px, py);
      const distance = Math.hypot(dx - x, dy - y);
      if (distance <= radius && (!best || distance < best.distance)) best = { index, part, distance };
    }
  });
  return best ? { index: (best as { index: number }).index, part: (best as { part: PenPart }).part } : null;
}

/* A point with its handles pulled out to (hx, hy), the other handle mirrored. */
export function pullHandles(point: PathPoint, hx: number, hy: number): PathPoint {
  return { ...point, ox: hx, oy: hy, ix: point.x * 2 - hx, iy: point.y * 2 - hy };
}

/* Moves one handle; the other turns with it to keep the curve smooth, keeping its own length, unless `free`. */
export function moveHandle(point: PathPoint, part: "in" | "out", hx: number, hy: number, free: boolean): PathPoint {
  const next = part === "in" ? { ...point, ix: hx, iy: hy } : { ...point, ox: hx, oy: hy };
  if (free) return next;
  const [ox, oy] = part === "in" ? [point.ox, point.oy] : [point.ix, point.iy];
  const length = Math.hypot(ox - point.x, oy - point.y);
  if (length < 0.5) return next;
  const dx = hx - point.x;
  const dy = hy - point.y;
  const pulled = Math.hypot(dx, dy) || 1;
  const mx = point.x - (dx / pulled) * length;
  const my = point.y - (dy / pulled) * length;
  return part === "in" ? { ...next, ox: mx, oy: my } : { ...next, ix: mx, iy: my };
}

export function moveAnchor(point: PathPoint, dx: number, dy: number): PathPoint {
  return { x: point.x + dx, y: point.y + dy, ix: point.ix + dx, iy: point.iy + dy, ox: point.ox + dx, oy: point.oy + dy };
}

/* The path's outline, anchors and handles in document space, for drawing over the stage. */
export function pathOverlay(layer: PathLayer): { d: string; anchors: [number, number][]; handles: { index: number; part: "in" | "out"; from: [number, number]; to: [number, number] }[] } {
  const doc = (x: number, y: number) => toDoc(layer, x, y);
  const points = layer.points;
  let d = "";
  if (points.length) {
    const first = doc(points[0].x, points[0].y);
    d = `M${first[0]} ${first[1]}`;
    const segment = (a: PathPoint, b: PathPoint) => {
      const c1 = doc(a.ox, a.oy);
      const c2 = doc(b.ix, b.iy);
      const end = doc(b.x, b.y);
      d += `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${end[0]} ${end[1]}`;
    };
    for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
    if (layer.closed && points.length > 2) segment(points[points.length - 1], points[0]);
  }
  const handles: { index: number; part: "in" | "out"; from: [number, number]; to: [number, number] }[] = [];
  points.forEach((point, index) => {
    for (const part of ["in", "out"] as const) {
      const [hx, hy] = part === "in" ? [point.ix, point.iy] : [point.ox, point.oy];
      if (hx === point.x && hy === point.y) continue;
      handles.push({ index, part, from: doc(point.x, point.y), to: doc(hx, hy) });
    }
  });
  return { d, anchors: points.map((point) => doc(point.x, point.y)), handles };
}

/* --- Moving selected pixels ----------------------------------------------------------------- */

/* Splits a paint layer's pixels into what the selection holds and what stays. */
export function liftSelection(layer: Layer, pixels: HTMLCanvasElement | undefined, selection: HTMLCanvasElement): { lifted: HTMLCanvasElement; rest: HTMLCanvasElement } {
  const mask = blankCanvas();
  drawInLayerSpace(mask, selection, layer);
  const source = pixels ?? blankCanvas();
  const lifted = cloneCanvas(source);
  const liftedCtx = lifted.getContext("2d")!;
  liftedCtx.globalCompositeOperation = "destination-in";
  liftedCtx.drawImage(mask, 0, 0);
  const rest = cloneCanvas(source);
  const restCtx = rest.getContext("2d")!;
  restCtx.globalCompositeOperation = "destination-out";
  restCtx.drawImage(mask, 0, 0);
  return { lifted, rest };
}

/* A document move in the layer's own pixels. */
export function layerDelta(layer: Layer, dx: number, dy: number): [number, number] {
  const m = docToLayerMatrix(layer);
  const a = m.transformPoint(new DOMPoint(0, 0));
  const b = m.transformPoint(new DOMPoint(dx, dy));
  return [b.x - a.x, b.y - a.y];
}

export function shiftedMask(mask: HTMLCanvasElement, dx: number, dy: number): HTMLCanvasElement {
  const out = blankCanvas();
  out.getContext("2d")!.drawImage(mask, dx, dy);
  return out;
}
