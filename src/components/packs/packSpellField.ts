/* What a blade's easter egg (PackStage) does to the pack: Ember's char or
   Frost's ice, painted into the 3D pack's own texture, a frame at a time,
   so it tilts, shakes and tears with the pack and never swaps from one
   drawing to another. A radial field around where the blade rested, broken
   up by noise, is cut at one level into what has burnt or frozen and just
   under it into a thin bright line: the front. Growing the field's radius
   moves the front out over the pack. The flames and frost glints are
   particles thrown off that front (packBlades emberBurn, frostFreeze).

   The noise comes from the browser's own feTurbulence, rasterized once when
   the spell starts; every frame after that is arithmetic on its pixels. */

export type PackSpellKind = "burn" | "freeze";

export interface SpellField {
  /* The layer for a front grown `radius` px of the pack's on-screen width
     out from the origin, at the field's size; laid over the art in
     source-atop. */
  draw(radius: number): HTMLCanvasElement;
  /* The px the visible front sits at for a given radius (the cut level):
     where 1.6 x gradient + 0.8 x noise - 0.65 crosses 0.6 of the heat on
     average noise, with the gradient flat to half the radius and falling to
     nothing at it. */
  frontAt(radius: number): number;
  /* Ember's only: thin cracks still glowing in what has burnt, as of the
     last draw, for PackStage to lay over the char in "lighter" while it
     breathes them brighter and dimmer. Null for Frost. */
  cracks: HTMLCanvasElement | null;
}

/* Half the art's 600 x 1000: soft enough to pass for the art's own grain,
   cheap enough to redo every frame. */
const FIELD_W = 300;
const FIELD_H = 500;

async function noiseImage(type: "fractalNoise" | "turbulence", frequency: string, octaves: number, seed: number): Promise<Uint8ClampedArray | null> {
  // RGB kept, alpha forced opaque so nothing is premultiplied away
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${FIELD_W}" height="${FIELD_H}"><filter id="n" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="${type}" baseFrequency="${frequency}" numOctaves="${octaves}" seed="${seed}"/><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = FIELD_W;
  canvas.height = FIELD_H;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, FIELD_W, FIELD_H).data;
}

const frequencies = (scale: number, x: number, y = x) => `${(x * scale).toFixed(4)} ${(y * scale).toFixed(4)}`;

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/* `origin` in fractions of the pack (0..1 across and down); `packWidth` its
   on-screen width in px, which the noise's grain and the reaches of the
   spikes were tuned in. Null when the browser cannot draw the noise. */
export async function createSpellField(kind: PackSpellKind, origin: { u: number; v: number }, packWidth: number): Promise<SpellField | null> {
  const seed = () => Math.floor(Math.random() * 1000);
  // the field's px per on-screen px of the pack, and the grain per field px
  const s = FIELD_W / Math.max(1, packWidth);
  const grain = 1 / s;
  const [noise, crystal, creases] = await Promise.all([
    noiseImage("fractalNoise", frequencies(grain, 0.022, 0.018), 5, seed()),
    kind === "freeze" ? noiseImage("turbulence", frequencies(grain, 0.05), 3, seed()) : Promise.resolve(null),
    // Frost's long veins, or Ember's finer cracks in the char: both are where
    // a smooth noise crosses its middle, which wanders like a crack (the low
    // points of a turbulence sit on a lattice and come out as a grid of dots)
    kind === "freeze"
      ? noiseImage("fractalNoise", frequencies(grain, 0.007, 0.009), 2, seed())
      : noiseImage("fractalNoise", frequencies(grain, 0.01, 0.013), 3, seed()),
  ]);
  if (!noise || !creases || (kind === "freeze" && !crystal)) return null;
  const count = FIELD_W * FIELD_H;
  const lum = (data: Uint8ClampedArray, i: number) => (0.2125 * data[i * 4] + 0.7154 * data[i * 4 + 1] + 0.0721 * data[i * 4 + 2]) / 255;
  const noiseL = new Float32Array(count);
  for (let i = 0; i < count; i += 1) noiseL[i] = lum(noise, i);

  // Frost's still parts: the spikes' offsets, the veins, the banked rime
  let offsetX: Float32Array | null = null;
  let offsetY: Float32Array | null = null;
  let veins: Float32Array | null = null;
  let bank: Float32Array | null = null;
  if (kind === "freeze" && crystal && creases) {
    offsetX = new Float32Array(count);
    offsetY = new Float32Array(count);
    veins = new Float32Array(count);
    bank = new Float32Array(count);
    // a blurred rectangle, as the pouch's own alpha blurred 26px would be
    const soft = (distance: number) => 0.5 + 0.5 * Math.tanh(distance / (26 * s));
    const insetAt = (x: number, y: number) =>
      x < 0 || y < 0 || x >= FIELD_W || y >= FIELD_H ? 0 : soft(Math.min(x, FIELD_W - x)) * soft(Math.min(y, FIELD_H - y));
    for (let i = 0; i < count; i += 1) {
      const x = i % FIELD_W;
      const y = (i - x) / FIELD_W;
      const r = crystal[i * 4] / 255;
      const g = crystal[i * 4 + 1] / 255;
      offsetX[i] = (r - 0.5) * 34 * s;
      offsetY[i] = (g - 0.5) * 34 * s;
      const crease = Math.abs(lum(creases, i) - 0.5);
      // in patches, not a net over the whole pack
      const patch = noiseL[i] > 0.5 ? 1 : 0;
      veins[i] = patch * (crease < 0.004 ? 1 : crease < 0.01 ? 0.25 : 0);
      const inset = insetAt(x + (g - 0.5) * 40 * s, y + (r - 0.5) * 40 * s);
      bank[i] = inset < 0.35 ? 1 : inset < 0.4 ? 0.85 : inset < 0.45 ? 0.4 : 0;
    }
  }

  // Ember's cracks: the creases of a sharp noise, a bright core in a dimmer rim
  let crackMask: Float32Array | null = null;
  if (kind === "burn") {
    crackMask = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const crease = Math.abs(lum(creases, i) - 0.5);
      // in patches, fading out at their edges, not a net over the whole pack
      const patch = Math.min(1, Math.max(0, (noiseL[i] - 0.47) / 0.08));
      crackMask[i] = patch * (crease < 0.005 ? 1 : crease < 0.012 ? 0.4 : 0);
    }
  }

  const ox = origin.u * FIELD_W;
  const oy = origin.v * FIELD_H;
  // heat at a point for a field of radius r (field px), 0..1
  const heatAt = (x: number, y: number, r: number) => {
    const xi = Math.min(FIELD_W - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(FIELD_H - 1, Math.max(0, Math.round(y)));
    const dx = x - ox;
    const dy = y - oy;
    // not Math.hypot, which is several times slower in this loop
    const d = Math.sqrt(dx * dx + dy * dy);
    const g = d <= r * 0.5 ? 1 : Math.max(0, 1 - (d - r * 0.5) / (r * 0.5));
    return Math.min(1, Math.max(0, 1.6 * g + 0.8 * noiseL[yi * FIELD_W + xi] - 0.65));
  };
  // feFuncA's discrete table: which of n steps a value falls in
  const step = (value: number, n: number) => Math.min(n - 1, Math.floor(value * n));

  const layer = document.createElement("canvas");
  layer.width = FIELD_W;
  layer.height = FIELD_H;
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = FIELD_W;
  glowCanvas.height = FIELD_H;
  const lineCanvas = document.createElement("canvas");
  lineCanvas.width = FIELD_W;
  lineCanvas.height = FIELD_H;
  const layerContext = layer.getContext("2d");
  const glowContext = glowCanvas.getContext("2d");
  const lineContext = lineCanvas.getContext("2d");
  const cracks = kind === "burn" ? document.createElement("canvas") : null;
  const crackSharp = kind === "burn" ? document.createElement("canvas") : null;
  for (const canvas of [cracks, crackSharp]) {
    if (!canvas) continue;
    canvas.width = FIELD_W;
    canvas.height = FIELD_H;
  }
  const crackPixels = kind === "burn" ? new ImageData(FIELD_W, FIELD_H) : null;
  const crackCore = rgb("#ffc061");
  const crackRim = rgb("#ff5a12");
  const pixels = new ImageData(FIELD_W, FIELD_H);
  const glowPixels = new ImageData(FIELD_W, FIELD_H);
  const linePixels = new ImageData(FIELD_W, FIELD_H);

  const burn = { soot: rgb("#120703"), scorch: rgb("#3a1606"), glow: rgb("#ff8a2a"), hot: rgb("#ffe2a0") };
  const ice = { haze: rgb("#bfe6ff"), glaze: rgb("#d4ecff"), rime: rgb("#f2faff"), vein: rgb("#ffffff"), bank: rgb("#f4fbff"), glow: rgb("#7cc8ff"), line: rgb("#ffffff") };

  // colour and alpha of one pixel, its layers laid over one another bottom first
  const acc = new Float64Array(4);
  const over = (color: [number, number, number], alpha: number) => {
    if (alpha <= 0) return;
    const below = acc[3] * (1 - alpha);
    const total = alpha + below;
    acc[0] = (color[0] * alpha + acc[0] * below) / total;
    acc[1] = (color[1] * alpha + acc[1] * below) / total;
    acc[2] = (color[2] * alpha + acc[2] * below) / total;
    acc[3] = total;
  };

  return {
    frontAt: (radius) => radius * 0.72,
    cracks,
    draw(radius) {
      const r = Math.max(1, radius * s);
      // Only a band around the front changes from frame to frame: well
      // outside it nothing has happened yet, and well inside the heat is past
      // every level whatever the noise and the spikes do.
      const reach = 26 * s + 2;
      const outside = r + reach;
      const inside = r * 0.5 - reach;
      const out = pixels.data;
      const glow = glowPixels.data;
      const line = linePixels.data;
      for (let i = 0; i < count; i += 1) {
        const x = i % FIELD_W;
        const y = (i - x) / FIELD_W;
        acc[0] = 0;
        acc[1] = 0;
        acc[2] = 0;
        acc[3] = 0;
        let front = false;
        const d = Math.sqrt((x - ox) * (x - ox) + (y - oy) * (y - oy));
        const settled = d > outside ? 0 : d < inside ? 9 : -1;
        if (kind === "burn") {
          const level = settled >= 0 ? settled : step(heatAt(x, y, r), 10);
          if (level === 5) over(burn.scorch, 0.35);
          if (level >= 7) over(burn.soot, 0.9);
          front = level === 6;
          // cracks only where it has burnt right through
          const crack = level >= 8 ? crackMask![i] : 0;
          const c = crackPixels!.data;
          const tone = crack > 0.5 ? crackCore : crackRim;
          c[i * 4] = tone[0];
          c[i * 4 + 1] = tone[1];
          c[i * 4 + 2] = tone[2];
          c[i * 4 + 3] = crack * 255;
        } else {
          const spiky = settled >= 0 ? settled : step(heatAt(x + offsetX![i], y + offsetY![i], r), 10);
          const core = settled >= 0 ? settled === 9 : step(heatAt(x, y, r), 10) >= 8;
          const frozen = spiky >= 7 || core;
          if (spiky === 5) over(ice.haze, 0.18);
          if (frozen) {
            over(ice.glaze, 0.3);
            over(ice.rime, spiky === 7 ? 0.4 : spiky === 8 ? 0.18 : 0);
            over(ice.vein, veins![i] * 0.7);
            over(ice.bank, bank![i] * 0.88);
          }
          front = spiky === 6;
        }
        const k = i * 4;
        out[k] = acc[0];
        out[k + 1] = acc[1];
        out[k + 2] = acc[2];
        out[k + 3] = acc[3] * 255;
        const lit = kind === "burn" ? burn.glow : ice.glow;
        const hot = kind === "burn" ? burn.hot : ice.line;
        glow[k] = lit[0];
        glow[k + 1] = lit[1];
        glow[k + 2] = lit[2];
        glow[k + 3] = front ? 255 : 0;
        line[k] = hot[0];
        line[k + 1] = hot[1];
        line[k + 2] = hot[2];
        line[k + 3] = front ? 255 : 0;
      }
      if (layerContext && glowContext && lineContext) {
        layerContext.clearRect(0, 0, FIELD_W, FIELD_H);
        layerContext.putImageData(pixels, 0, 0);
        glowContext.putImageData(glowPixels, 0, 0);
        lineContext.putImageData(linePixels, 0, 0);
        // the front's glow, twice, under its bright line
        layerContext.filter = `blur(${(kind === "burn" ? 2.2 : 2.4) * s}px)`;
        layerContext.drawImage(glowCanvas, 0, 0);
        layerContext.drawImage(glowCanvas, 0, 0);
        layerContext.filter = "none";
        layerContext.drawImage(lineCanvas, 0, 0);
      }
      const crackContext = cracks?.getContext("2d");
      const sharpContext = crackSharp?.getContext("2d");
      if (cracks && crackSharp && crackPixels && crackContext && sharpContext) {
        sharpContext.putImageData(crackPixels, 0, 0);
        crackContext.clearRect(0, 0, FIELD_W, FIELD_H);
        // a soft glow round each crack, then the crack itself
        crackContext.filter = `blur(${1.6 * s}px)`;
        crackContext.drawImage(crackSharp, 0, 0);
        crackContext.filter = "none";
        crackContext.drawImage(crackSharp, 0, 0);
      }
      return layer;
    },
  };
}
