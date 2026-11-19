import { blankCanvas, cloneCanvas, DOC_CENTRE, DOC_SIZE, type Layer } from "./doc";
import { layerMatrix } from "./render";

/* The frame editor's pixel tools: the brush and eraser (stamped along the
   pointer's path into a stroke buffer, mirrored by the symmetry setting, put
   on the layer at the stroke's opacity), the paint bucket and magic wand
   (a flood from the clicked pixel), and the selection mask that clips them. */

export type SymmetryMode = "none" | "x" | "y" | "xy" | "radial";
export interface Symmetry {
  mode: SymmetryMode;
  /* radial: copies around the avatar's centre */
  count: number;
  /* radial: also mirror each copy */
  mirror: boolean;
}

export type BrushTip = "round" | "square" | "flat" | "chalk" | "scatter";

export interface BrushSettings {
  tip?: BrushTip;
  size: number;
  /* 0 soft .. 1 hard */
  hardness: number;
  opacity: number;
  flow: number;
  /* a share of the size between stamps */
  spacing: number;
  pressure: boolean;
  smoothing: number;
}

/* --- Matrices between the document and a layer's own pixels ---------------------- */

/* Document point to the layer's pixel canvas (paint layers keep their centre at the canvas centre). */
export function docToLayerMatrix(layer: Layer): DOMMatrix {
  return new DOMMatrix().translateSelf(DOC_CENTRE, DOC_CENTRE).multiplySelf(layerMatrix(layer.transform).inverse());
}

export function symmetryPoints(x: number, y: number, symmetry: Symmetry): [number, number][] {
  const dx = x - DOC_CENTRE;
  const dy = y - DOC_CENTRE;
  switch (symmetry.mode) {
    case "none":
      return [[x, y]];
    case "x":
      return [[x, y], [DOC_CENTRE - dx, y]];
    case "y":
      return [[x, y], [x, DOC_CENTRE - dy]];
    case "xy":
      return [[x, y], [DOC_CENTRE - dx, y], [x, DOC_CENTRE - dy], [DOC_CENTRE - dx, DOC_CENTRE - dy]];
    case "radial": {
      const count = Math.max(2, Math.min(32, Math.round(symmetry.count)));
      const out: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        out.push([DOC_CENTRE + dx * cos - dy * sin, DOC_CENTRE + dx * sin + dy * cos]);
        if (symmetry.mirror) out.push([DOC_CENTRE - dx * cos - dy * sin, DOC_CENTRE - dx * sin + dy * cos]);
      }
      return out;
    }
  }
}

/* --- The brush ------------------------------------------------------------------- */

const TIP_SIZE = 256;
const tips = new Map<string, HTMLCanvasElement>();

/* One dab, drawn large and scaled down per stamp. */
function brushTip(hardness: number, color: string, tip: BrushTip = "round"): HTMLCanvasElement {
  const key = `${hardness.toFixed(2)}|${color}|${tip}`;
  const known = tips.get(key);
  if (known) return known;
  const canvas = blankCanvas(TIP_SIZE);
  const ctx = canvas.getContext("2d")!;
  const r = TIP_SIZE / 2;
  const hard = Math.min(0.98, Math.max(0, hardness));
  if (tip === "square") {
    const soft = (1 - hard) * r * 0.5;
    ctx.fillStyle = color;
    ctx.filter = soft > 0.5 ? `blur(${soft}px)` : "none";
    ctx.fillRect(soft * 1.5, soft * 1.5, TIP_SIZE - soft * 3, TIP_SIZE - soft * 3);
  } else {
    const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
    gradient.addColorStop(0, color);
    gradient.addColorStop(hard, color);
    gradient.addColorStop(1, `${color}00`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    if (tip === "flat") ctx.ellipse(r, r, r, r * 0.22, -Math.PI / 4, 0, Math.PI * 2);
    else ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
    if (tip === "chalk") {
      // a grainy dab: speckled holes through the colour
      const image = ctx.getImageData(0, 0, TIP_SIZE, TIP_SIZE);
      let seed = 7;
      const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      // grain in cells big enough to survive the dab being scaled down
      const cell = 22;
      const cells = Math.ceil(TIP_SIZE / cell);
      const grain = Array.from({ length: cells * cells }, () => (random() < 0.4 ? 0.1 : 0.75 + random() * 0.25));
      for (let y = 0; y < TIP_SIZE; y++) {
        for (let x = 0; x < TIP_SIZE; x++) {
          const i = (y * TIP_SIZE + x) * 4 + 3;
          image.data[i] = Math.round(image.data[i] * grain[Math.floor(y / cell) * cells + Math.floor(x / cell)]);
        }
      }
      ctx.putImageData(image, 0, 0);
    }
  }
  if (tips.size > 64) tips.clear();
  tips.set(key, canvas);
  return canvas;
}

export class Stroke {
  readonly buffer: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private last: { x: number; y: number; pressure: number } | null = null;
  private carry = 0;
  private readonly tip: HTMLCanvasElement;
  private readonly matrix: DOMMatrix;
  private readonly layerScale: number;

  constructor(
    private readonly settings: BrushSettings,
    color: string,
    layer: Layer,
    private readonly symmetry: Symmetry,
  ) {
    this.buffer = blankCanvas();
    this.ctx = this.buffer.getContext("2d")!;
    this.tip = brushTip(settings.hardness, color, settings.tip);
    this.matrix = docToLayerMatrix(layer);
    this.layerScale = Math.sqrt(Math.abs(layer.transform.scaleX * layer.transform.scaleY)) || 1;
  }

  private stamp(x: number, y: number, pressure: number) {
    const size = Math.max(0.5, (this.settings.size * (this.settings.pressure ? Math.max(0.05, pressure) : 1)) / this.layerScale);
    this.ctx.globalAlpha = this.settings.flow;
    const tip = this.settings.tip ?? "round";
    for (const [px, py] of symmetryPoints(x, y, this.symmetry)) {
      const point = this.matrix.transformPoint(new DOMPoint(px, py));
      if (tip === "scatter") {
        // a few small dots thrown round the pointer
        for (let i = 0; i < 4; i++) {
          const angle = Math.random() * Math.PI * 2;
          const reach = Math.sqrt(Math.random()) * size * 0.6;
          const dot = size * (0.12 + Math.random() * 0.2);
          this.ctx.drawImage(this.tip, point.x + Math.cos(angle) * reach - dot / 2, point.y + Math.sin(angle) * reach - dot / 2, dot, dot);
        }
      } else if (tip === "chalk") {
        // turned at random so the grain never repeats
        this.ctx.save();
        this.ctx.translate(point.x, point.y);
        this.ctx.rotate(Math.random() * Math.PI * 2);
        this.ctx.drawImage(this.tip, -size / 2, -size / 2, size, size);
        this.ctx.restore();
      } else {
        this.ctx.drawImage(this.tip, point.x - size / 2, point.y - size / 2, size, size);
      }
    }
  }

  /* A document point the pointer passed, with its pen pressure (0..1; a mouse sends 0.5). */
  add(x: number, y: number, pressure: number) {
    const p = pressure > 0 ? pressure : 0.5;
    if (!this.last) {
      this.stamp(x, y, p);
      this.last = { x, y, pressure: p };
      return;
    }
    const from = this.last;
    const distance = Math.hypot(x - from.x, y - from.y);
    const step = Math.max(0.5, this.settings.size * this.settings.spacing);
    let travelled = step - this.carry;
    while (travelled <= distance) {
      const t = travelled / distance;
      this.stamp(from.x + (x - from.x) * t, from.y + (y - from.y) * t, from.pressure + (p - from.pressure) * t);
      travelled += step;
    }
    this.carry = distance - (travelled - step);
    this.last = { x, y, pressure: p };
  }

  get started(): boolean {
    return this.last !== null;
  }
}

/* The layer's pixels with the stroke on them, masked by the selection: a fresh canvas. */
export function applyStroke(base: HTMLCanvasElement | undefined, stroke: HTMLCanvasElement, opacity: number, erase: boolean, selection: HTMLCanvasElement | null, layer: Layer, into?: HTMLCanvasElement): HTMLCanvasElement {
  const out = into ?? blankCanvas();
  const ctx = out.getContext("2d")!;
  ctx.globalCompositeOperation = "copy";
  if (base) ctx.drawImage(base, 0, 0);
  else ctx.clearRect(0, 0, DOC_SIZE, DOC_SIZE);
  ctx.globalCompositeOperation = "source-over";
  let paint = stroke;
  if (selection) {
    paint = cloneCanvas(stroke);
    maskInLayerSpace(paint, selection, layer);
  }
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.drawImage(paint, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return out;
}

/* Keeps only what lies inside a document-space mask, for a canvas in the layer's own space. */
export function maskInLayerSpace(target: HTMLCanvasElement, mask: HTMLCanvasElement, layer: Layer) {
  const ctx = target.getContext("2d")!;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  const m = docToLayerMatrix(layer);
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

/* Draws a document-space canvas into the layer's own space. */
export function drawInLayerSpace(target: HTMLCanvasElement, source: HTMLCanvasElement, layer: Layer, operation: GlobalCompositeOperation = "source-over") {
  const ctx = target.getContext("2d")!;
  ctx.save();
  ctx.globalCompositeOperation = operation;
  const m = docToLayerMatrix(layer);
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

/* --- Flood fill and the magic wand ------------------------------------------------- */

/* The pixels connected to (x, y) whose colour is within `tolerance` (0..255)
   of it; with `contiguous` off, every such pixel. As a 0/1 grid. */
export function floodRegion(data: Uint8ClampedArray, size: number, x: number, y: number, tolerance: number, contiguous: boolean): Uint8Array {
  const out = new Uint8Array(size * size);
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= size || sy >= size) return out;
  const seed = (sy * size + sx) * 4;
  const r = data[seed], g = data[seed + 1], b = data[seed + 2], a = data[seed + 3];
  const near = (i: number) => {
    const o = i * 4;
    const alpha = data[o + 3];
    // fully clear pixels match each other whatever colour they hold
    if (a < 8 && alpha < 8) return true;
    return Math.max(Math.abs(data[o] - r), Math.abs(data[o + 1] - g), Math.abs(data[o + 2] - b), Math.abs(alpha - a)) <= tolerance;
  };
  if (!contiguous) {
    for (let i = 0; i < size * size; i++) if (near(i)) out[i] = 1;
    return out;
  }
  const stack = [sx, sy];
  while (stack.length) {
    const py = stack.pop()!;
    const px = stack.pop()!;
    let left = px;
    const row = py * size;
    while (left >= 0 && !out[row + left] && near(row + left)) left--;
    left++;
    let upOpen = false;
    let downOpen = false;
    for (let cx = left; cx < size && !out[row + cx] && near(row + cx); cx++) {
      out[row + cx] = 1;
      if (py > 0) {
        const up = row - size + cx;
        const open = !out[up] && near(up);
        if (open && !upOpen) stack.push(cx, py - 1);
        upOpen = open;
      }
      if (py < size - 1) {
        const down = row + size + cx;
        const open = !out[down] && near(down);
        if (open && !downOpen) stack.push(cx, py + 1);
        downOpen = open;
      }
    }
  }
  return out;
}

/* A 0/1 grid as a white mask canvas, grown by `grow` px so fills cover antialiased edges. */
export function regionToMask(region: Uint8Array, size: number, grow = 0): HTMLCanvasElement {
  let cells = region;
  for (let pass = 0; pass < grow; pass++) {
    const next = new Uint8Array(cells);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (cells[i]) continue;
        if ((x > 0 && cells[i - 1]) || (x < size - 1 && cells[i + 1]) || (y > 0 && cells[i - size]) || (y < size - 1 && cells[i + size])) next[i] = 1;
      }
    }
    cells = next;
  }
  const canvas = blankCanvas(size);
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    if (!cells[i]) continue;
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 255;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/* A mask filled with one colour. */
export function tint(mask: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const out = cloneCanvas(mask);
  const ctx = out.getContext("2d")!;
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);
  return out;
}

/* --- Selections ------------------------------------------------------------------- */

export type SelectMode = "replace" | "add" | "subtract" | "intersect";

export interface Selection {
  mask: HTMLCanvasElement;
  /* the outline's SVG path, for drawing over the stage */
  d: string;
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

/* Combines a new shape into the selection. `draw` paints the shape white on a mask. */
export function combineSelection(current: Selection | null, mode: SelectMode, draw: (ctx: CanvasRenderingContext2D) => void): Selection | null {
  const shape = blankCanvas();
  const shapeCtx = shape.getContext("2d")!;
  shapeCtx.fillStyle = "#fff";
  shapeCtx.strokeStyle = "#fff";
  draw(shapeCtx);
  let mask: HTMLCanvasElement;
  if (!current || mode === "replace") mask = shape;
  else {
    mask = cloneCanvas(current.mask);
    const ctx = mask.getContext("2d")!;
    ctx.globalCompositeOperation = mode === "add" ? "source-over" : mode === "subtract" ? "destination-out" : "destination-in";
    ctx.drawImage(shape, 0, 0);
  }
  return selectionFromMask(mask);
}

export function invertSelection(current: Selection | null): Selection | null {
  const mask = blankCanvas();
  const ctx = mask.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, DOC_SIZE, DOC_SIZE);
  if (current) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(current.mask, 0, 0);
  }
  return selectionFromMask(mask);
}

export function selectAll(): Selection {
  return invertSelection(null)!;
}

/* The selection's outline as runs of pixel edges, merged along rows and
   columns so the path stays short. Null when nothing is selected. */
export function selectionFromMask(mask: HTMLCanvasElement): Selection | null {
  const size = mask.width;
  const data = mask.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, size, size).data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && data[(y * size + x) * 4 + 3] >= 128;
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  const parts: string[] = [];
  // horizontal edges: between row y-1 and y
  for (let y = 0; y <= size; y++) {
    let start = -1;
    for (let x = 0; x <= size; x++) {
      const edge = x < size && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) {
        parts.push(`M${start} ${y}H${x}`);
        start = -1;
      }
    }
  }
  for (let x = 0; x <= size; x++) {
    let start = -1;
    for (let y = 0; y <= size; y++) {
      const edge = y < size && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) {
        parts.push(`M${x} ${start}V${y}`);
        start = -1;
      }
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!on(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { mask, d: parts.join(""), bounds: { x0, y0, x1: x1 + 1, y1: y1 + 1 } };
}

/* --- Retouching: smudge, blur, lighten, darken --------------------------------------- */

export type RetouchMode = "smudge" | "blur" | "lighten" | "darken";

/* Works straight on a copy of a paint layer's pixels, dab by dab along the
   pointer's path, each symmetry copy with its own smudge pickup. */
export class Retouch {
  private last: [number, number] | null = null;
  private carry = 0;
  private readonly matrix: DOMMatrix;
  private readonly layerScale: number;
  private readonly pickups = new Map<number, HTMLCanvasElement>();
  private readonly soft: HTMLCanvasElement;
  readonly working: HTMLCanvasElement;

  constructor(
    base: HTMLCanvasElement | undefined,
    layer: Layer,
    private readonly mode: RetouchMode,
    private readonly size: number,
    private readonly strength: number,
    private readonly symmetry: Symmetry,
  ) {
    this.working = base ? cloneCanvas(base) : blankCanvas();
    this.matrix = docToLayerMatrix(layer);
    this.layerScale = Math.sqrt(Math.abs(layer.transform.scaleX * layer.transform.scaleY)) || 1;
    this.soft = brushTip(0.3, "#ffffff");
  }

  private dab(copy: number, x: number, y: number) {
    const size = Math.max(2, this.size / this.layerScale);
    const sx = Math.round(x - size / 2);
    const sy = Math.round(y - size / 2);
    const side = Math.ceil(size);
    const ctx = this.working.getContext("2d")!;
    const patch = blankCanvas(side);
    const pctx = patch.getContext("2d")!;
    if (this.mode === "smudge") {
      let pickup = this.pickups.get(copy);
      if (!pickup) {
        pickup = blankCanvas(side);
        pickup.getContext("2d")!.drawImage(this.working, sx, sy, side, side, 0, 0, side, side);
        this.pickups.set(copy, pickup);
        return;
      }
      pctx.drawImage(pickup, 0, 0, side, side);
      // the pickup takes on some of what it passes over
      const pick = pickup.getContext("2d")!;
      pick.globalAlpha = 1 - this.strength * 0.9;
      pick.drawImage(this.working, sx, sy, side, side, 0, 0, pickup.width, pickup.height);
      pick.globalAlpha = 1;
    } else if (this.mode === "blur") {
      pctx.filter = `blur(${Math.max(0.5, side * 0.08 * this.strength)}px)`;
      pctx.drawImage(this.working, sx - side, sy - side, side * 3, side * 3, -side, -side, side * 3, side * 3);
      pctx.filter = "none";
    } else {
      pctx.drawImage(this.working, sx, sy, side, side, 0, 0, side, side);
      pctx.globalCompositeOperation = "source-atop";
      pctx.globalAlpha = this.strength * 0.25;
      pctx.fillStyle = this.mode === "lighten" ? "#ffffff" : "#000000";
      pctx.fillRect(0, 0, side, side);
      pctx.globalAlpha = 1;
    }
    // blend the dab in: the old pixels where the dab is thin, the new where it is full
    const amount = this.mode === "smudge" ? this.strength : 1;
    const weight = blankCanvas(side);
    const wctx = weight.getContext("2d")!;
    wctx.globalAlpha = amount;
    wctx.drawImage(this.soft, 0, 0, side, side);
    pctx.globalCompositeOperation = "destination-in";
    pctx.drawImage(weight, 0, 0);
    const blended = blankCanvas(side);
    const bctx = blended.getContext("2d")!;
    bctx.drawImage(this.working, sx, sy, side, side, 0, 0, side, side);
    bctx.globalCompositeOperation = "destination-out";
    bctx.drawImage(weight, 0, 0);
    bctx.globalCompositeOperation = "lighter";
    bctx.drawImage(patch, 0, 0);
    ctx.clearRect(sx, sy, side, side);
    ctx.drawImage(blended, sx, sy);
  }

  add(x: number, y: number) {
    const step = Math.max(1, this.size * 0.15);
    const points: [number, number][] = [];
    if (!this.last) points.push([x, y]);
    else {
      const [lx, ly] = this.last;
      const distance = Math.hypot(x - lx, y - ly);
      let travelled = step - this.carry;
      while (travelled <= distance) {
        const t = travelled / distance;
        points.push([lx + (x - lx) * t, ly + (y - ly) * t]);
        travelled += step;
      }
      this.carry = distance - (travelled - step);
    }
    this.last = [x, y];
    for (const [px, py] of points) {
      symmetryPoints(px, py, this.symmetry).forEach(([sx, sy], copy) => {
        const point = this.matrix.transformPoint(new DOMPoint(sx, sy));
        this.dab(copy, point.x, point.y);
      });
    }
  }
}

/* The edit kept inside the selection: the original outside it, the edited pixels within. */
export function keepInSelection(base: HTMLCanvasElement | undefined, edited: HTMLCanvasElement, selection: HTMLCanvasElement | null, layer: Layer): HTMLCanvasElement {
  if (!selection) return edited;
  const inside = cloneCanvas(edited);
  maskInLayerSpace(inside, selection, layer);
  const outside = base ? cloneCanvas(base) : blankCanvas();
  drawInLayerSpace(outside, selection, layer, "destination-out");
  outside.getContext("2d")!.drawImage(inside, 0, 0);
  return outside;
}
