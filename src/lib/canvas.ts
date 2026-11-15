/* CanvasRenderingContext2D.roundRect does not exist on Safari < 16 or
   Chrome < 99, and those browsers are still real in the analytics (the packs
   page threw "e.roundRect is not a function" for them). Same subpath, drawn
   with arcTo where the native call is missing. Only the single-radius form,
   which is all this codebase uses; the native call gets it as a one-element
   sequence because early implementations (still live in CN/VN mobile
   browsers) reject a bare number with "cannot be converted to a sequence". */
export function pathRoundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, [radius]);
    return;
  }
  const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

/* CanvasRenderingContext2D.filter: Safari has long shipped without it, and
   where WebKit has it, a canvas that is not in the document keeps it at
   "none", which is every canvas these helpers are used on. So it is tested by
   drawing on such a canvas, and where it does nothing the filter is run by
   hand on the pixels: the colour functions as the Filter Effects spec writes
   them (in sRGB, as browsers run the shorthands) and blur as three box blurs,
   which is what browsers approximate a Gaussian with too. */
let canvasFilterSupport: boolean | null = null;

export function canvasFilterWorks(): boolean {
  if (canvasFilterSupport != null) return canvasFilterSupport;
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !("filter" in context)) return (canvasFilterSupport = false);
  context.filter = "invert(1)";
  context.fillStyle = "#000";
  context.fillRect(0, 0, 1, 1);
  canvasFilterSupport = context.getImageData(0, 0, 1, 1).data[0] > 127;
  return canvasFilterSupport;
}

type FilterStep =
  | { kind: "blur"; radius: number }
  | { kind: "color"; apply: (r: number, g: number, b: number) => [number, number, number] };

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function matrixStep(m: readonly number[]): FilterStep {
  return {
    kind: "color",
    apply: (r, g, b) => [
      clamp01(m[0] * r + m[1] * g + m[2] * b),
      clamp01(m[3] * r + m[4] * g + m[5] * b),
      clamp01(m[6] * r + m[7] * g + m[8] * b),
    ],
  };
}

function linearStep(slope: number, intercept: number): FilterStep {
  return { kind: "color", apply: (r, g, b) => [clamp01(r * slope + intercept), clamp01(g * slope + intercept), clamp01(b * slope + intercept)] };
}

/** The filter string's functions, in order. Only those this codebase uses;
    anything else is left out rather than guessed at. */
export function parseCanvasFilter(filter: string): FilterStep[] {
  const steps: FilterStep[] = [];
  for (const [, name, raw] of filter.matchAll(/([a-z-]+)\(\s*([^)]*?)\s*\)/g)) {
    const number = raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
    if (name === "blur") {
      const radius = Number.parseFloat(raw);
      if (radius > 0) steps.push({ kind: "blur", radius });
      continue;
    }
    if (!Number.isFinite(number)) continue;
    const a = clamp01(number);
    const k = 1 - a;
    if (name === "brightness") steps.push(linearStep(Math.max(0, number), 0));
    else if (name === "contrast") steps.push(linearStep(Math.max(0, number), 0.5 - 0.5 * Math.max(0, number)));
    else if (name === "invert") steps.push(linearStep(1 - 2 * a, a));
    else if (name === "grayscale") steps.push(matrixStep([0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k]));
    else if (name === "sepia") steps.push(matrixStep([0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]));
    else if (name === "saturate") {
      const s = Math.max(0, number);
      steps.push(matrixStep([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]));
    }
  }
  return steps;
}

/* Box sizes whose three passes come closest to a Gaussian of this sigma. */
function gaussBoxes(sigma: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  return [0, 1, 2].map((i) => (i < m ? lower : upper));
}

function boxPass(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, horizontal: boolean) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const stride = horizontal ? 4 : width * 4;
  const scale = 1 / (radius * 2 + 1);
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * width * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      // edges read as transparent, as a filter on a canvas does
      for (let i = 0; i <= radius && i < length; i++) sum += src[start + i * stride + c];
      for (let i = 0; i < length; i++) {
        dst[start + i * stride + c] = sum * scale;
        const add = i + radius + 1;
        const drop = i - radius;
        if (add < length) sum += src[start + add * stride + c];
        if (drop >= 0) sum -= src[start + drop * stride + c];
      }
    }
  }
}

function blurPixels(data: Uint8ClampedArray, width: number, height: number, sigma: number) {
  // blurred premultiplied, so transparent pixels do not darken the edges
  const a = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    a[i] = data[i] * alpha;
    a[i + 1] = data[i + 1] * alpha;
    a[i + 2] = data[i + 2] * alpha;
    a[i + 3] = data[i + 3];
  }
  const b = new Float32Array(data.length);
  for (const size of gaussBoxes(sigma)) {
    const radius = (size - 1) / 2;
    if (radius < 1) continue;
    boxPass(a, b, width, height, radius, true);
    boxPass(b, a, width, height, radius, false);
  }
  for (let i = 0; i < data.length; i += 4) {
    const alpha = a[i + 3];
    const unpremultiply = alpha > 0 ? 255 / alpha : 0;
    data[i] = a[i] * unpremultiply;
    data[i + 1] = a[i + 1] * unpremultiply;
    data[i + 2] = a[i + 2] * unpremultiply;
    data[i + 3] = alpha;
  }
}

/** Runs a parsed filter over pixels in place. */
export function filterPixels(image: ImageData, steps: readonly FilterStep[]) {
  const { data, width, height } = image;
  for (const step of steps) {
    if (step.kind === "blur") {
      blurPixels(data, width, height, step.radius);
      continue;
    }
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const [r, g, b] = step.apply(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      data[i] = r * 255;
      data[i + 1] = g * 255;
      data[i + 2] = b * 255;
    }
  }
}

let scratch: HTMLCanvasElement | null = null;

/** Draws what `paint` draws with `filter` on, whether or not the browser runs
    canvas filters. `paint` gets a context with the target's transform, font,
    text settings, line settings and fill and stroke; globalAlpha, the
    composite mode, the clip and the shadow stay on the target and apply to
    the filtered result, as they do to a natively filtered draw. */
export function drawFiltered(context: CanvasRenderingContext2D, filter: string, paint: (context: CanvasRenderingContext2D) => void): void {
  if (canvasFilterWorks()) {
    const before = context.filter;
    context.filter = filter;
    paint(context);
    context.filter = before;
    return;
  }
  const steps = parseCanvasFilter(filter);
  const { width, height } = context.canvas;
  if (steps.length === 0 || width < 1 || height < 1) {
    paint(context);
    return;
  }
  scratch ??= document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const layer = scratch.getContext("2d", { willReadFrequently: true });
  if (!layer) {
    paint(context);
    return;
  }
  layer.setTransform(context.getTransform());
  layer.font = context.font;
  layer.textAlign = context.textAlign;
  layer.textBaseline = context.textBaseline;
  layer.direction = context.direction;
  if ("letterSpacing" in context) layer.letterSpacing = context.letterSpacing;
  layer.lineWidth = context.lineWidth;
  layer.lineJoin = context.lineJoin;
  layer.lineCap = context.lineCap;
  layer.miterLimit = context.miterLimit;
  layer.fillStyle = context.fillStyle;
  layer.strokeStyle = context.strokeStyle;
  layer.imageSmoothingEnabled = context.imageSmoothingEnabled;
  layer.imageSmoothingQuality = context.imageSmoothingQuality;
  paint(layer);
  try {
    const pixels = layer.getImageData(0, 0, width, height);
    filterPixels(pixels, steps);
    layer.putImageData(pixels, 0, 0);
  } catch {
    // a cross-origin image without CORS taints the layer: draw it unfiltered
  }
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(scratch, 0, 0);
  context.restore();
}

/** A copy of `source` with `filter` run over it, into `into` (made if
    missing), for a filtered image drawn more than once. */
export function filteredCanvas(source: HTMLCanvasElement, filter: string, into: HTMLCanvasElement | null = null): HTMLCanvasElement {
  const out = into ?? document.createElement("canvas");
  if (out.width !== source.width) out.width = source.width;
  if (out.height !== source.height) out.height = source.height;
  const context = out.getContext("2d", { willReadFrequently: !canvasFilterWorks() });
  if (!context) return source;
  context.clearRect(0, 0, out.width, out.height);
  drawFiltered(context, filter, (layer) => layer.drawImage(source, 0, 0));
  return out;
}
