import {
  AVATAR_INSET,
  AVATAR_SIZE,
  DOC_CENTRE,
  DOC_SIZE,
  maskKey,
  type Assets,
  type Effects,
  type Fill,
  type Layer,
  type Motion,
  type PathLayer,
  type Pixels,
  type ShapeLayer,
  type TextLayer,
  type Transform,
} from "./doc";

/* Draws the frame editor's layers: each layer's content under its transform,
   motion and repeat, then its effects (shadow, glow, stroke, overlay,
   adjustments), then the stack composited with opacity, blend modes and
   clipping masks. Everything is in document pixels; `size` renders the same
   at another resolution (the 384px export, a thumbnail). A layer's finished
   picture is cached on the layer object itself, which edits replace, so a
   redraw only repaints what changed. */

export interface RenderInput {
  pixels: Pixels;
  assets: Assets;
  /* 0..1 through the loop */
  time?: number;
  size?: number;
  /* paint layers drawn from a canvas that is still changing (a stroke in progress) */
  live?: ReadonlySet<string>;
}

/* --- Motion --------------------------------------------------------------- */

export interface MotionPose {
  dx: number;
  dy: number;
  rotation: number;
  orbit: number;
  scale: number;
  alpha: number;
  hue: number;
  shimmer: number | null;
}

const REST: MotionPose = { dx: 0, dy: 0, rotation: 0, orbit: 0, scale: 1, alpha: 1, hue: 0, shimmer: null };

/* The layer's pose between its keyframes, looping from the last back to the first. */
function keyPose(motion: Motion, time: number): MotionPose {
  const keys = [...(motion.keys ?? [])].sort((a, b) => a.t - b.t);
  if (!keys.length) return REST;
  const pose = (key: (typeof keys)[number]): MotionPose => ({ ...REST, dx: key.dx, dy: key.dy, rotation: key.rotation, scale: key.scale, alpha: key.opacity });
  if (keys.length === 1) return pose(keys[0]);
  let after = keys.findIndex((key) => key.t > time);
  if (after < 0) after = 0;
  const before = (after - 1 + keys.length) % keys.length;
  const a = keys[before];
  const b = keys[after];
  const span = (b.t - a.t + 1) % 1 || 1;
  let t = ((time - a.t + 1) % 1) / span;
  if (b.ease === "smooth") t = t * t * (3 - 2 * t);
  const mix = (x: number, y: number) => x + (y - x) * t;
  return { ...REST, dx: mix(a.dx, b.dx), dy: mix(a.dy, b.dy), rotation: mix(a.rotation, b.rotation), scale: mix(a.scale, b.scale), alpha: Math.max(0, Math.min(1, mix(a.opacity, b.opacity))) };
}

export function motionPose(motion: Motion, time: number): MotionPose {
  if (motion.kind === "none") return REST;
  if (motion.kind === "keys") return keyPose(motion, time);
  const turn = (motion.speed * time + motion.phase) % 1;
  const wave = Math.sin(turn * Math.PI * 2);
  switch (motion.kind) {
    case "spin":
      return { ...REST, rotation: turn * 360 * Math.sign(motion.speed || 1) };
    case "orbit":
      return { ...REST, orbit: turn * 360 * Math.sign(motion.speed || 1) };
    case "pulse":
      return { ...REST, scale: 1 + motion.amount * 0.25 * wave };
    case "bob":
      return { ...REST, dy: motion.amount * 24 * wave };
    case "sway":
      return { ...REST, rotation: motion.amount * 25 * wave };
    case "blink":
      return { ...REST, alpha: 1 - motion.amount * (0.5 - 0.5 * Math.cos(turn * Math.PI * 2)) };
    case "hue":
      return { ...REST, hue: turn * 360 };
    case "shimmer":
      return { ...REST, shimmer: turn };
  }
}

export function isAnimated(layers: readonly Layer[]): boolean {
  return layers.some((layer) => layer.visible && (layer.motion.kind !== "none" || (layer.kind === "group" && isAnimated(layer.children))));
}

/* --- Paint styles ------------------------------------------------------------ */

export function fillStyle(ctx: CanvasRenderingContext2D, fill: Fill, width: number, height: number): string | CanvasGradient {
  if (fill.kind === "solid") return fill.color;
  const rad = (fill.angle * Math.PI) / 180;
  if (fill.kind === "linear") {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const reach = (Math.abs(width * cos) + Math.abs(height * sin)) / 2 || 1;
    const gradient = ctx.createLinearGradient(-cos * reach, -sin * reach, cos * reach, sin * reach);
    gradient.addColorStop(0, fill.color);
    gradient.addColorStop(1, fill.color2);
    return gradient;
  }
  if (fill.kind === "radial") {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(width, height) / 2 || 1);
    gradient.addColorStop(0, fill.color);
    gradient.addColorStop(1, fill.color2);
    return gradient;
  }
  if (typeof ctx.createConicGradient !== "function") return fill.color;
  const gradient = ctx.createConicGradient(rad, 0, 0);
  gradient.addColorStop(0, fill.color);
  gradient.addColorStop(0.5, fill.color2);
  gradient.addColorStop(1, fill.color);
  return gradient;
}

/* --- Shapes and text ----------------------------------------------------------- */

export function shapePath(layer: ShapeLayer): Path2D {
  const path = new Path2D();
  const w = layer.width / 2;
  const h = layer.height / 2;
  switch (layer.shape) {
    case "rect": {
      const radius = Math.max(0, Math.min(layer.radius, w, h));
      path.roundRect(-w, -h, w * 2, h * 2, radius);
      break;
    }
    case "ellipse":
      path.ellipse(0, 0, Math.max(0.5, w), Math.max(0.5, h), 0, 0, Math.PI * 2);
      break;
    case "polygon":
    case "star": {
      const corners = Math.max(3, Math.round(layer.sides));
      const points = layer.shape === "star" ? corners * 2 : corners;
      for (let i = 0; i < points; i++) {
        const angle = -Math.PI / 2 + (i / points) * Math.PI * 2;
        const reach = layer.shape === "star" && i % 2 === 1 ? layer.inner : 1;
        const x = Math.cos(angle) * w * reach;
        const y = Math.sin(angle) * h * reach;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      break;
    }
    case "line":
      path.moveTo(-w, 0);
      path.lineTo(w, 0);
      break;
    case "arc": {
      const half = (Math.max(1, Math.min(360, layer.sweep)) * Math.PI) / 360;
      path.ellipse(0, 0, Math.max(0.5, w), Math.max(0.5, h), 0, -Math.PI / 2 - half, -Math.PI / 2 + half);
      break;
    }
  }
  return path;
}

function drawShape(ctx: CanvasRenderingContext2D, layer: ShapeLayer) {
  const path = shapePath(layer);
  const style = fillStyle(ctx, layer.fill, layer.width, layer.height);
  const stroked = layer.style === "outline" || layer.shape === "line" || layer.shape === "arc";
  if (stroked) {
    ctx.lineWidth = layer.lineWidth;
    ctx.strokeStyle = style;
    ctx.lineCap = layer.cap;
    ctx.lineJoin = layer.cap === "round" ? "round" : "miter";
    ctx.setLineDash(layer.dash > 0 ? [layer.dash, Math.max(0, layer.gap)] : []);
    ctx.stroke(path);
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = style;
    ctx.fill(path);
  }
}

export function pathPath(layer: PathLayer): Path2D {
  const path = new Path2D();
  const points = layer.points;
  if (!points.length) return path;
  path.moveTo(points[0].x, points[0].y);
  const segment = (a: PathLayer["points"][number], b: PathLayer["points"][number]) => path.bezierCurveTo(a.ox, a.oy, b.ix, b.iy, b.x, b.y);
  for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
  if (layer.closed && points.length > 2) {
    segment(points[points.length - 1], points[0]);
    path.closePath();
  }
  return path;
}

function drawPath(ctx: CanvasRenderingContext2D, layer: PathLayer) {
  if (!layer.points.length) return;
  const box = pathBounds(layer);
  const path = pathPath(layer);
  const style = fillStyle(ctx, layer.fill, Math.max(1, box.x1 - box.x0), Math.max(1, box.y1 - box.y0));
  if (layer.style === "fill" && layer.closed) {
    ctx.fillStyle = style;
    ctx.fill(path);
    return;
  }
  ctx.lineWidth = layer.lineWidth;
  ctx.strokeStyle = style;
  ctx.lineCap = layer.cap;
  ctx.lineJoin = layer.cap === "round" ? "round" : "miter";
  ctx.setLineDash(layer.dash > 0 ? [layer.dash, Math.max(0, layer.gap)] : []);
  ctx.stroke(path);
  ctx.setLineDash([]);
}

/* A path's anchors and handles, which hold the curve inside them. */
export function pathBounds(layer: PathLayer): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of layer.points) {
    for (const [x, y] of [[p.x, p.y], [p.ix, p.iy], [p.ox, p.oy]]) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

export function fontString(layer: TextLayer): string {
  return `${layer.italic ? "italic " : ""}${layer.weight} ${layer.size}px "${layer.font}", "Torus", sans-serif`;
}

const measureCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;

interface TextMetricsBox {
  lines: { text: string; glyphs: { char: string; width: number }[]; width: number }[];
  width: number;
  height: number;
  lineHeight: number;
}

/* Lines and glyph widths, measured one character at a time so spacing and arcs place each one. */
export function measureText(layer: TextLayer): TextMetricsBox {
  const ctx = measureCanvas?.getContext("2d");
  const lineHeight = layer.size * 1.15;
  const lines = layer.text.split("\n").map((text) => {
    const glyphs = [...text].map((char) => ({ char, width: (ctx ? (ctx.font = fontString(layer), ctx.measureText(char).width) : layer.size * 0.6) + layer.spacing }));
    const width = glyphs.reduce((sum, glyph) => sum + glyph.width, 0) - (glyphs.length ? layer.spacing : 0);
    return { text, glyphs, width };
  });
  return { lines, width: Math.max(1, ...lines.map((line) => line.width)), height: Math.max(1, lines.length * lineHeight), lineHeight };
}

function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer) {
  const box = measureText(layer);
  ctx.font = fontString(layer);
  ctx.fillStyle = fillStyle(ctx, layer.fill, layer.arc > 0 ? layer.arc * 2 + layer.size * 2 : box.width, layer.arc > 0 ? layer.arc * 2 + layer.size * 2 : box.height);
  if (layer.arc > 0) {
    // one line round the circle; extra lines go on smaller circles inside it
    box.lines.forEach((line, index) => {
      const radius = Math.max(4, layer.arc - index * box.lineHeight * (layer.arcBelow ? -1 : 1));
      const total = line.width / radius;
      let angle = layer.arcBelow ? Math.PI / 2 + total / 2 : -Math.PI / 2 - total / 2;
      ctx.textBaseline = layer.arcBelow ? "top" : "alphabetic";
      for (const glyph of line.glyphs) {
        const step = glyph.width / radius;
        const middle = layer.arcBelow ? angle - (glyph.width - layer.spacing) / radius / 2 : angle + (glyph.width - layer.spacing) / radius / 2;
        ctx.save();
        ctx.translate(Math.cos(middle) * radius, Math.sin(middle) * radius);
        ctx.rotate(layer.arcBelow ? middle - Math.PI / 2 : middle + Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText(glyph.char, 0, 0);
        ctx.restore();
        angle += layer.arcBelow ? -step : step;
      }
    });
    return;
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  box.lines.forEach((line, index) => {
    let x = -line.width / 2;
    const y = -box.height / 2 + box.lineHeight * (index + 0.5);
    for (const glyph of line.glyphs) {
      ctx.fillText(glyph.char, x, y);
      x += glyph.width;
    }
  });
}

/* --- Bounds ------------------------------------------------------------------- */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const alphaBoundsCache = new WeakMap<HTMLCanvasElement, Box | null>();

/* The painted part of a canvas, in its own pixels; null when it is empty. */
export function alphaBounds(canvas: HTMLCanvasElement, fresh = false): Box | null {
  if (!fresh && alphaBoundsCache.has(canvas)) return alphaBoundsCache.get(canvas)!;
  const { width, height } = canvas;
  const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const box = x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  alphaBoundsCache.set(canvas, box);
  return box;
}

/* A layer's content box around its own centre, before its transform. */
export function localBox(layer: Layer, pixels: Pixels): Box | null {
  if (layer.kind === "group") {
    // the children's boxes in the document, round the group's own centre
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const child of layer.children) {
      if (!child.visible) continue;
      const box = localBox(child, pixels);
      if (!box) continue;
      for (const [px, py] of [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]) {
        const [dx, dy] = toLocal(layer, ...toDoc(child, px, py));
        x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy);
      }
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }
  if (layer.distort) {
    const xs = layer.distort.to.map((point) => point[0]);
    const ys = layer.distort.to.map((point) => point[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
  switch (layer.kind) {
    case "paint": {
      const canvas = pixels[layer.id];
      const box = canvas ? alphaBounds(canvas) : null;
      return box ? { x0: box.x0 - DOC_CENTRE, y0: box.y0 - DOC_CENTRE, x1: box.x1 - DOC_CENTRE, y1: box.y1 - DOC_CENTRE } : null;
    }
    case "image":
      return { x0: -layer.width / 2, y0: -layer.height / 2, x1: layer.width / 2, y1: layer.height / 2 };
    case "shape": {
      const pad = layer.style === "outline" || layer.shape === "line" || layer.shape === "arc" ? layer.lineWidth / 2 : 0;
      const h = layer.shape === "line" ? 0 : layer.height / 2;
      return { x0: -layer.width / 2 - pad, y0: -h - pad, x1: layer.width / 2 + pad, y1: h + pad };
    }
    case "path": {
      if (!layer.points.length) return null;
      const box = pathBounds(layer);
      const pad = layer.style === "fill" && layer.closed ? 0 : layer.lineWidth / 2;
      return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
    }
    case "text": {
      if (layer.arc > 0) {
        const reach = layer.arc + layer.size * 1.2;
        return { x0: -reach, y0: -reach, x1: reach, y1: reach };
      }
      const box = measureText(layer);
      return { x0: -box.width / 2, y0: -box.height / 2, x1: box.width / 2, y1: box.height / 2 };
    }
  }
}

/* Where a local point lands in the document under the layer's transform (no motion, no repeat). */
/* The layer's own space to the document: move, turn, slant, then scale. */
export function layerMatrix(t: Transform): DOMMatrix {
  const m = new DOMMatrix().translateSelf(t.x, t.y).rotateSelf(t.rotation);
  if (t.skewX) m.skewXSelf(t.skewX);
  if (t.skewY) m.skewYSelf(t.skewY);
  return m.scaleSelf(t.scaleX || 1e-6, t.scaleY || 1e-6);
}

export function toDoc(layer: Layer, x: number, y: number): [number, number] {
  const point = layerMatrix(layer.transform).transformPoint(new DOMPoint(x, y));
  return [point.x, point.y];
}

/* The inverse: a document point in the layer's own space. */
export function toLocal(layer: Layer, x: number, y: number): [number, number] {
  const point = layerMatrix(layer.transform).inverse().transformPoint(new DOMPoint(x, y));
  return [point.x, point.y];
}

/* --- Perspective and distort ------------------------------------------------------- */

/* The projective map from the unit square onto a four-cornered shape (Heckbert). */
export function squareToQuad(quad: [number, number][]): (u: number, v: number) => [number, number] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let a: number, b: number, c: number, d: number, e: number, f: number, g = 0, h = 0;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = x1 - x0; b = x3 - x0; c = x0; d = y1 - y0; e = y3 - y0; f = y0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return (u, v) => {
    const w = g * u + h * v + 1 || 1e-9;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

/* Draws the part of `image` in triangle s onto triangle d of the context. */
function drawTriangle(ctx: CanvasRenderingContext2D, image: HTMLCanvasElement, s: [number, number][], d: [number, number][]) {
  const [[ax, ay], [bx, by], [cx, cy]] = s;
  const det = ax * (by - cy) - bx * (ay - cy) + cx * (ay - by);
  if (Math.abs(det) < 1e-9) return;
  // the inverse of [[ax bx cx][ay by cy][1 1 1]]
  const inv = [
    [(by - cy) / det, (cx - bx) / det, (bx * cy - cx * by) / det],
    [(cy - ay) / det, (ax - cx) / det, (cx * ay - ax * cy) / det],
    [(ay - by) / det, (bx - ax) / det, (ax * by - bx * ay) / det],
  ];
  const row = (values: number[]) => [0, 1, 2].map((col) => values[0] * inv[0][col] + values[1] * inv[1][col] + values[2] * inv[2][col]);
  const [ma, mc, me] = row([d[0][0], d[1][0], d[2][0]]);
  const [mb, md, mf] = row([d[0][1], d[1][1], d[2][1]]);
  // grown a touch past its edges so neighbouring triangles leave no hairline seam
  const centre = [(d[0][0] + d[1][0] + d[2][0]) / 3, (d[0][1] + d[1][1] + d[2][1]) / 3];
  ctx.save();
  ctx.beginPath();
  d.forEach(([x, y], index) => {
    const dx = x - centre[0];
    const dy = y - centre[1];
    const length = Math.hypot(dx, dy) || 1;
    const px = x + (dx / length) * 0.8;
    const py = y + (dy / length) * 0.8;
    if (index) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.closePath();
  ctx.clip();
  ctx.transform(ma, mb, mc, md, me, mf);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

const DISTORT_GRID = 10;

function drawDistorted(ctx: CanvasRenderingContext2D, layer: Layer, input: RenderInput) {
  const { from, to } = layer.distort!;
  const w = Math.max(1, from.x1 - from.x0);
  const h = Math.max(1, from.y1 - from.y0);
  const m = ctx.getTransform();
  const k = Math.max(0.5, Math.min(3, Math.hypot(m.a, m.b)));
  const source = makeCanvas(1);
  source.width = Math.max(1, Math.ceil(w * k));
  source.height = Math.max(1, Math.ceil(h * k));
  const sctx = context(source);
  sctx.filter = ctx.filter;
  sctx.scale(k, k);
  sctx.translate(-from.x0, -from.y0);
  drawLocal(sctx, { ...layer, distort: null }, input);
  const map = squareToQuad(to);
  const filter = ctx.filter;
  ctx.filter = "none";
  for (let j = 0; j < DISTORT_GRID; j++) {
    for (let i = 0; i < DISTORT_GRID; i++) {
      const u0 = i / DISTORT_GRID, u1 = (i + 1) / DISTORT_GRID, v0 = j / DISTORT_GRID, v1 = (j + 1) / DISTORT_GRID;
      const s = (u: number, v: number): [number, number] => [u * source.width, v * source.height];
      drawTriangle(ctx, source, [s(u0, v0), s(u1, v0), s(u1, v1)], [map(u0, v0), map(u1, v0), map(u1, v1)]);
      drawTriangle(ctx, source, [s(u0, v0), s(u1, v1), s(u0, v1)], [map(u0, v0), map(u1, v1), map(u0, v1)]);
    }
  }
  ctx.filter = filter;
}

/* --- Drawing one layer ----------------------------------------------------------- */

function drawLocal(ctx: CanvasRenderingContext2D, layer: Layer, input: RenderInput) {
  if (layer.distort) {
    drawDistorted(ctx, layer, input);
    return;
  }
  switch (layer.kind) {
    case "paint": {
      const canvas = input.pixels[layer.id];
      if (canvas) ctx.drawImage(canvas, -DOC_CENTRE, -DOC_CENTRE);
      return;
    }
    case "image": {
      const asset = input.assets[layer.asset];
      if (asset) ctx.drawImage(asset, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
      return;
    }
    case "shape":
      drawShape(ctx, layer);
      return;
    case "text":
      drawText(ctx, layer);
      return;
    case "path":
      drawPath(ctx, layer);
      return;
    case "group": {
      // the layers inside, composited in the document, drawn as one picture
      const picture = makeCanvas(DOC_SIZE);
      composite(context(picture), layer.children, { ...input, size: DOC_SIZE });
      ctx.drawImage(picture, -DOC_CENTRE, -DOC_CENTRE);
      return;
    }
  }
}

/* What a layer's picture depends on beyond the layer object: its pixels, picture and mask, and those of everything inside it. */
function sourceKey(layer: Layer, input: RenderInput): string {
  const own = `${canvasId(layer.kind === "paint" ? input.pixels[layer.id] : layer.kind === "image" ? input.assets[layer.asset] : undefined)}.${canvasId(layer.mask ? input.pixels[maskKey(layer.id)] : undefined)}`;
  return layer.kind === "group" ? `${own}(${layer.children.map((child) => sourceKey(child, input)).join(",")})` : own;
}

function isLive(layer: Layer, live: ReadonlySet<string> | undefined): boolean {
  if (!live) return false;
  if (live.has(layer.id) || live.has(maskKey(layer.id))) return true;
  return layer.kind === "group" && layer.children.some((child) => isLive(child, live));
}

function movesDeep(layer: Layer): boolean {
  return layer.motion.kind !== "none" || (layer.kind === "group" && layer.children.some(movesDeep));
}

function adjustFilter(effects: Effects, hue: number, scale: number): string {
  const a = effects.adjust;
  const parts: string[] = [];
  const turn = (a.hue + hue) % 360;
  if (turn) parts.push(`hue-rotate(${turn}deg)`);
  if (a.saturation !== 100) parts.push(`saturate(${a.saturation}%)`);
  if (a.brightness !== 100) parts.push(`brightness(${a.brightness}%)`);
  if (a.contrast !== 100) parts.push(`contrast(${a.contrast}%)`);
  if (a.blur > 0) parts.push(`blur(${a.blur * scale}px)`);
  return parts.length ? parts.join(" ") : "none";
}

/* The layer's content, every repeat of it, at `size`. No effects. */
/* Runs `draw` once per copy of the layer (its repeats round the avatar), with
   the context set to the layer's own space under its transform and motion. */
function forEachCopy(ctx: CanvasRenderingContext2D, layer: Layer, scale: number, pose: MotionPose, draw: () => void) {
  const { count, mirror } = layer.effects.repeat;
  const copies = Math.max(1, Math.min(36, Math.round(count)));
  const t = layer.transform;
  for (let flip = 0; flip < (mirror ? 2 : 1); flip++) {
    for (let index = 0; index < copies; index++) {
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.translate(DOC_CENTRE, DOC_CENTRE);
      ctx.rotate(((index * 360) / copies + pose.orbit) * (Math.PI / 180));
      if (flip) ctx.scale(-1, 1);
      ctx.translate(-DOC_CENTRE, -DOC_CENTRE);
      ctx.translate(t.x + pose.dx, t.y + pose.dy);
      ctx.rotate(((t.rotation + pose.rotation) * Math.PI) / 180);
      if (t.skewX) ctx.transform(1, 0, Math.tan((t.skewX * Math.PI) / 180), 1, 0, 0);
      if (t.skewY) ctx.transform(1, Math.tan((t.skewY * Math.PI) / 180), 0, 1, 0, 0);
      ctx.scale(t.scaleX * pose.scale, t.scaleY * pose.scale);
      draw();
      ctx.restore();
    }
  }
}

/* The layer's content, every repeat of it, at `size`. No effects. */
export function drawContent(ctx: CanvasRenderingContext2D, layer: Layer, input: RenderInput, pose: MotionPose) {
  const scale = (input.size ?? DOC_SIZE) / DOC_SIZE;
  ctx.save();
  ctx.globalAlpha = pose.alpha;
  ctx.filter = adjustFilter(layer.effects, pose.hue, scale);
  forEachCopy(ctx, layer, scale, pose, () => drawLocal(ctx, layer, input));
  ctx.restore();
}

/* Hides what the layer's mask hides, the mask following the layer and each repeat of it. */
export function applyMask(target: HTMLCanvasElement, layer: Layer, input: RenderInput, pose: MotionPose) {
  const mask = layer.mask?.enabled ? input.pixels[maskKey(layer.id)] : undefined;
  if (!mask) return;
  const size = target.width;
  const docMask = makeCanvas(size);
  const maskCtx = context(docMask);
  forEachCopy(maskCtx, layer, size / DOC_SIZE, pose, () => maskCtx.drawImage(mask, -DOC_CENTRE, -DOC_CENTRE));
  const ctx = context(target);
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(docMask, 0, 0);
  ctx.restore();
}

/* --- Effects --------------------------------------------------------------------- */

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return canvas.getContext("2d", { willReadFrequently: false })!;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#000000";
  return [1, 3, 5].map((at) => parseInt(clean.slice(at, at + 2), 16)) as [number, number, number];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/* One-dimensional squared distance transform (Felzenszwalb and Huttenlocher). */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/* The outline round a picture's painted part, `width` px thick, as an exact
   distance field from its edge; antialiased over a pixel. */
function outline(source: HTMLCanvasElement, width: number, color: string, opacity: number): HTMLCanvasElement {
  const size = source.width;
  const data = context(source).getImageData(0, 0, size, size).data;
  const grid = new Float32Array(size * size);
  const INF = 1e20;
  for (let i = 0; i < size * size; i++) grid[i] = data[i * 4 + 3] >= 128 ? 0 : INF;
  const f = new Float32Array(size);
  const d = new Float32Array(size);
  const v = new Int32Array(size);
  const z = new Float32Array(size + 1);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) f[y] = grid[y * size + x];
    edt1d(f, size, d, v, z);
    for (let y = 0; y < size; y++) grid[y * size + x] = d[y];
  }
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) f[x] = grid[row + x];
    edt1d(f, size, d, v, z);
    for (let x = 0; x < size; x++) grid[row + x] = d[x];
  }
  const out = makeCanvas(size);
  const ctx = context(out);
  const image = ctx.createImageData(size, size);
  const [r, g, b] = hexToRgb(color);
  for (let i = 0; i < size * size; i++) {
    const distance = Math.sqrt(grid[i]);
    const alpha = Math.max(0, Math.min(1, width - distance + 0.5));
    if (alpha <= 0) continue;
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = Math.round(alpha * opacity * 255);
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/* A soft copy of the picture's shape (shadow, glow), drawn far off the canvas
   so only its shadow lands. */
function drawShadowOf(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, color: string, blur: number, dx: number, dy: number, times = 1) {
  const far = source.width * 2 + 200;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = far + dx;
  ctx.shadowOffsetY = dy;
  for (let i = 0; i < times; i++) ctx.drawImage(source, -far, 0);
  ctx.restore();
}

function overlay(ctx: CanvasRenderingContext2D, effects: Effects, size: number, shimmer: number | null) {
  const scale = size / DOC_SIZE;
  if (effects.overlay.on) {
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = effects.overlay.opacity;
    ctx.setTransform(scale, 0, 0, scale, DOC_CENTRE * scale, DOC_CENTRE * scale);
    ctx.fillStyle = fillStyle(ctx, effects.overlay.fill, DOC_SIZE, DOC_SIZE);
    ctx.fillRect(-DOC_CENTRE, -DOC_CENTRE, DOC_SIZE, DOC_SIZE);
    ctx.restore();
  }
  if (shimmer !== null) {
    // a pale band sweeping across, corner to corner
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    const travel = -0.4 + shimmer * 1.8;
    const from = travel * size;
    const gradient = ctx.createLinearGradient(from - size * 0.25, from - size * 0.25, from + size * 0.25, from + size * 0.25);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.5, "rgba(255,255,255,0.75)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }
}

/* --- One layer, finished ----------------------------------------------------------- */

interface Cached {
  key: string;
  canvas: HTMLCanvasElement;
}

/* A few pictures per layer: the stage, the export and a moment of the loop can all stay. */
const finished = new WeakMap<Layer, Cached[]>();
const CACHE_PER_LAYER = 4;
const canvasIds = new WeakMap<HTMLCanvasElement, number>();
let nextCanvasId = 1;
function canvasId(canvas: HTMLCanvasElement | undefined): number {
  if (!canvas) return 0;
  let id = canvasIds.get(canvas);
  if (!id) {
    id = nextCanvasId++;
    canvasIds.set(canvas, id);
  }
  return id;
}

/* The layer with its effects, at full opacity and normal blend. */
export function renderLayer(layer: Layer, input: RenderInput): HTMLCanvasElement {
  const size = input.size ?? DOC_SIZE;
  const time = movesDeep(layer) ? input.time ?? 0 : 0;
  const live = isLive(layer, input.live);
  const key = `${size}|${time}|${sourceKey(layer, input)}`;
  const entries = finished.get(layer) ?? [];
  const hit = live ? undefined : entries.find((entry) => entry.key === key);
  if (hit) return hit.canvas;

  const pose = motionPose(layer.motion, time);
  const effects = layer.effects;
  const needsFx = effects.stroke.on || effects.glow.on || effects.shadow.on;
  const base = makeCanvas(size);
  const target = needsFx ? makeCanvas(size) : base;
  const ctx = context(target);
  const baseCtx = context(base);
  drawContent(baseCtx, layer, input, pose);
  overlay(baseCtx, effects, size, pose.shimmer);
  applyMask(base, layer, input, pose);
  if (needsFx) {
    const scale = size / DOC_SIZE;
    if (effects.shadow.on) {
      const rad = (effects.shadow.angle * Math.PI) / 180;
      drawShadowOf(ctx, base, rgba(effects.shadow.color, effects.shadow.opacity), effects.shadow.blur * scale, Math.cos(rad) * effects.shadow.distance * scale, Math.sin(rad) * effects.shadow.distance * scale);
    }
    if (effects.glow.on) {
      drawShadowOf(ctx, base, rgba(effects.glow.color, effects.glow.opacity), effects.glow.size * scale, 0, 0, Math.max(1, Math.min(4, Math.round(effects.glow.strength))));
    }
    if (effects.stroke.on && effects.stroke.width > 0) {
      ctx.drawImage(outline(base, effects.stroke.width * scale, effects.stroke.color, effects.stroke.opacity), 0, 0);
    }
    ctx.drawImage(base, 0, 0);
  }
  if (!live) finished.set(layer, [{ key, canvas: target }, ...entries.filter((entry) => entry.key !== key)].slice(0, CACHE_PER_LAYER));
  return target;
}

/* --- The stack ---------------------------------------------------------------------- */

/* Draws a board's layers, bottom first, onto `ctx` (sized `input.size`). */
export function composite(ctx: CanvasRenderingContext2D, layers: readonly Layer[], input: RenderInput) {
  const size = input.size ?? DOC_SIZE;
  for (let i = 0; i < layers.length; i++) {
    const base = layers[i];
    const clipped: Layer[] = [];
    while (i + 1 < layers.length && layers[i + 1].clip) clipped.push(layers[++i]);
    if (!base.visible) continue;
    let picture = renderLayer(base, input);
    const shown = clipped.filter((layer) => layer.visible);
    if (shown.length) {
      const group = makeCanvas(size);
      const groupCtx = context(group);
      groupCtx.drawImage(picture, 0, 0);
      for (const layer of shown) {
        groupCtx.globalAlpha = layer.opacity;
        groupCtx.globalCompositeOperation = layer.blend;
        groupCtx.drawImage(renderLayer(layer, input), 0, 0);
      }
      groupCtx.globalAlpha = 1;
      groupCtx.globalCompositeOperation = "destination-in";
      groupCtx.drawImage(picture, 0, 0);
      picture = group;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = base.opacity;
    ctx.globalCompositeOperation = base.blend;
    ctx.drawImage(picture, 0, 0);
    ctx.restore();
  }
}

export function renderBoard(layers: readonly Layer[], input: RenderInput): HTMLCanvasElement {
  const size = input.size ?? DOC_SIZE;
  const canvas = makeCanvas(size);
  composite(context(canvas), layers, input);
  return canvas;
}

/* The topmost visible layer with paint under a document point. */
/* The topmost visible layer with paint under a document point; with `deep`, the layer inside a group rather than the group. */
export function hitTest(layers: readonly Layer[], input: RenderInput, x: number, y: number, deep = false): Layer | null {
  if (x < 0 || y < 0 || x >= DOC_SIZE || y >= DOC_SIZE) return null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer.visible) continue;
    const picture = renderLayer(layer, { ...input, size: DOC_SIZE });
    const alpha = picture.getContext("2d")!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
    if (alpha > 24) return deep && layer.kind === "group" ? hitTest(layer.children, input, x, y, true) ?? layer : layer;
  }
  return null;
}

/* --- Checks the upload makes too ----------------------------------------------------- */

/* How much of the avatar the art leaves see-through (the upload refuses under
   60%), and whether there is any art at all. */
export function avatarClearance(canvas: HTMLCanvasElement, round: boolean): { clear: number; empty: boolean } {
  const size = canvas.width;
  const scale = size / DOC_SIZE;
  const inset = AVATAR_INSET * scale;
  const avatar = AVATAR_SIZE * scale;
  const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, size, size).data;
  const centre = inset + avatar / 2;
  const radius2 = (avatar / 2) ** 2;
  let covered = 0;
  let any = false;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = data[(y * size + x) * 4 + 3];
      if (alpha < 16) continue;
      any = true;
      const inside = round ? (x + 0.5 - centre) ** 2 + (y + 0.5 - centre) ** 2 <= radius2 : x >= inset && x < inset + avatar && y >= inset && y < inset + avatar;
      if (alpha > 200 && inside) covered++;
    }
  }
  const area = round ? Math.PI * radius2 : avatar * avatar;
  return { clear: 1 - covered / area, empty: !any };
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the picture."))), type, quality));
}
