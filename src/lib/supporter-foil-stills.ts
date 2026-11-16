import type { SupporterFoilId } from "./supporter-foils";

/* Still frames of the supporter foils, for the pictures of a card that have no
   shader behind them (the share images, satori in maniacard-art.ts). Each is
   the foil's own light from the overlay shader (cardShaders.ts, the
   `uFoilStyle` branches), worked out per pixel with the light at rest and the
   clock stopped, and laid over the card the way the overlay is: its colour at
   its alpha. The holo lattice keeps its vector still (supporter-foil-art.ts).

   The maths follows the shader line for line, in its own space: uv runs 0..1
   with v up, so a pixel row counts from the top and v from the bottom. A foil
   missing here falls back to the lattice still. */

/* The frame each still stops the clock at, in the shader's seconds. */
const STILL_TIME = 20;
/* uIntensity, and the overlay's alpha ceiling for a supporter's card. */
const INTENSITY = 0.88;
const ALPHA_CEILING = 0.6;

type Rgb = [number, number, number];
/* One point of the card, with what the shader's main() has worked out by the
   time it reaches the foil branches. */
interface FoilPoint {
  u: number;
  v: number;
  /* 0.12 to 1 across the main beam. */
  sheen: number;
  /* The fine pastel spectrum, and the paler light of the foils that are not one. */
  spectrum: Rgb;
  pale: Rgb;
  fineHue: number;
  /* The still's height in pixels, for a pattern that has to land on whole rows. */
  rows: number;
}
/* A foil's light at one point: the shader's supporterFoil and supporterAlpha
   before the sheen every non-lattice foil shares. */
type FoilLight = (point: FoilPoint) => { color: Rgb; alpha: number };

const TAU = 6.28318;
const PHASES = [0, 0.33, 0.67] as const;
/* uTextureSize: the foils count their cells in the card texture's pixels. */
const TEXTURE_W = 1000;
const TEXTURE_H = 1400;
/* The light at rest is (0.5, 0.5); the terms the shader builds from it are
   written out as their value there. */

function mod(value: number, by: number): number {
  return value - by * Math.floor(value / by);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

function random(x: number, y: number): number {
  return fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
}

function hue(at: number, towards: number, by: number): Rgb {
  return PHASES.map((phase) => towards + (0.5 + 0.5 * Math.cos(TAU * (phase + at)) - towards) * by) as Rgb;
}

function scaled(color: Rgb, gain: number, add = 0): Rgb {
  return [color[0] * gain + add, color[1] * gain + add, color[2] * gain + add];
}

/* Where each shard of the cracked ice sits, kept per cell: every pixel asks
   for its nine neighbours' and the card has only a few hundred cells. */
const shardPoints = new Map<number, [number, number]>();
function shardPoint(cellX: number, cellY: number): [number, number] {
  const key = cellX * 1024 + cellY;
  let point = shardPoints.get(key);
  if (!point) {
    point = [cellX + 0.15 + 0.7 * random(cellX, cellY), cellY + 0.15 + 0.7 * random(cellX + 4.1, cellY + 1.7)];
    shardPoints.set(key, point);
  }
  return point;
}

/* Cracked ice: shards that each flash at their own tilt, with a thin line of
   light in the cracks. Returns [flash, edge, shard hue]. */
function crackedIce(u: number, v: number): Rgb {
  const px = (u * TEXTURE_W) / 110;
  const py = (v * TEXTURE_H) / 110;
  const idX = Math.floor(px);
  const idY = Math.floor(py);
  let f1 = 8;
  let f2 = 8;
  let bestX = idX;
  let bestY = idY;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const cellX = idX + dx;
      const cellY = idY + dy;
      const shard = shardPoint(cellX, cellY);
      const d = Math.hypot(px - shard[0], py - shard[1]);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        bestX = cellX;
        bestY = cellY;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  const tilt = random(bestX + 9.3, bestY + 2.2) * TAU;
  const flash = Math.pow(Math.max(0, Math.cos(tilt + 1)), 5);
  const edge = 1 - smoothstep(0, 0.06, f2 - f1);
  return [flash, edge, random(bestX + 1.3, bestY + 6.6)];
}

/* Glitter: a flake per 7px cell, the ones facing the light flaring. */
function glitter(u: number, v: number, time: number): number {
  const px = (u * TEXTURE_W) / 7;
  const py = (v * TEXTURE_H) / 7;
  const idX = Math.floor(px);
  const idY = Math.floor(py);
  const angle = random(idX, idY) * TAU;
  const facing = Math.cos(angle + 1 + Math.sin(time * 0.6 + random(idX + 3.3, idY + 3.3) * 6.28) * 0.35);
  const flare = smoothstep(0.94, 1, facing);
  const point = 1 - smoothstep(0.1, 0.48, Math.hypot(fract(px) - 0.5, fract(py) - 0.5));
  return flare * point * (random(idX + 7.7, idY + 0.4) >= 0.25 ? 1 : 0);
}

/* Sunburst: rays fanning out from under the middle of the card. Returns [rays, angle]. */
function sunburst(u: number, v: number, time: number): [number, number] {
  const relX = u - 0.5;
  const relY = (v - (0.64 + (0.5 - 0.64) * 0.55)) * 1.4;
  const angle = Math.atan2(relY, relX);
  const rays = Math.pow(0.5 + 0.5 * Math.cos(angle * 18 + time * 0.25 + 1), 5);
  const fine = Math.pow(0.5 + 0.5 * Math.cos(angle * 46 - time * 0.4), 9) * 0.5;
  return [(rays + fine) * Math.exp(-Math.hypot(relX, relY) * 1.9), angle];
}

/* Caustics: the rippling light at the bottom of a pool. */
function caustics(u: number, v: number, time: number): number {
  const px = mod(u * TAU * 1.1, TAU) - 250;
  const py = mod(v * 1.4 * TAU * 1.1, TAU) - 250;
  let ix = px;
  let iy = py;
  let c = 1;
  for (let n = 0; n < 4; n += 1) {
    const t = time * 0.32 * (1 - 3.5 / (n + 1));
    const nextX = px + Math.cos(t - ix) + Math.sin(t + iy);
    const nextY = py + Math.sin(t - iy) + Math.cos(t + ix);
    ix = nextX;
    iy = nextY;
    c += 1 / Math.hypot(px / (Math.sin(ix + t) / 0.005), py / (Math.cos(iy + t) / 0.005));
  }
  c = 1.17 - Math.pow(c / 4, 1.4);
  return Math.min(1, Math.max(0, Math.pow(Math.abs(c), 8)));
}

/* Note rain: notes down seven lanes. Returns [note, lane rail]. */
function noteRain(u: number, v: number, time: number): [number, number] {
  const px = u * 7;
  const lane = Math.floor(px);
  const py = v * 9 + time * (0.55 + random(lane, 3) * 0.5);
  const on = random(lane + 2.4, Math.floor(py) + 8.1) >= 0.6 ? 1 : 0;
  const qx = Math.abs(fract(px) - 0.5) - 0.36 + 0.06;
  const qy = Math.abs(fract(py) - 0.5) - 0.11 + 0.06;
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.06;
  const across = fract(px);
  return [(1 - smoothstep(0, 0.03, d)) * on, 1 - smoothstep(0, 0.025, Math.min(across, 1 - across))];
}

/* Scanline: fine CRT lines and a bright band across the card, a slice of it
   slipped sideways. The shader's lines are 4 texture px apart; a still draws
   them on whole rows of its own height, or they beat against the pixel grid. */
function scanline(point: FoilPoint, time: number): { color: Rgb; alpha: number } {
  const period = Math.max(2, Math.round((4 * point.rows) / TEXTURE_H));
  const line = (v: number) => 0.5 + 0.5 * Math.sin((v * point.rows * TAU) / period);
  const lines = line(point.v);
  const head = 1 - fract(time * 0.11);
  const band = Math.exp(-Math.pow((point.v - head) * 9, 2)) + Math.exp(-Math.pow((point.v - head + 1) * 9, 2));
  const slip = (random(Math.floor(point.v * 46), Math.floor(time * 7)) >= 0.965 ? 1 : 0) * band;
  const split = band * 0.012 + slip * 0.03;
  const fringe: Rgb = [line(point.v + split), lines, line(point.v - split)];
  const lit = lines * (0.45 + 0.55 * point.sheen);
  const gain = lit * 0.35 + band * 0.7 + slip * 0.8;
  return {
    color: fringe.map((channel) => (1 + (channel - 1) * 0.6) * gain) as Rgb,
    alpha: lit * 0.09 + band * 0.22 + slip * 0.3,
  };
}

/* Aurora: curtains hanging from the top of the card, streaked along each fold. */
function aurora(u: number, v: number, time: number): number {
  const x = u * 3 + Math.sin(v * 2.2 + time * 0.22) * 0.55;
  const folds = 0.5 + 0.5 * Math.sin(x * 3.1 + time * 0.31) * Math.sin(x * 1.7 - time * 0.17 + 1.3);
  const streaks = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(x * 38 + Math.sin(v * 4 + time * 0.5) * 2.5), 2);
  return smoothstep(0.4, 0.95, folds) * streaks * smoothstep(0.02, 0.8, v);
}

const FOIL_LIGHTS: Partial<Record<SupporterFoilId, FoilLight>> = {
  "cracked-ice": ({ u, v, sheen, fineHue }) => {
    const [flash, edge, shard] = crackedIce(u, v);
    const lit = flash * (0.45 + 0.55 * sheen);
    return {
      color: scaled(hue(shard + fineHue * 0.35, 0.95, 0.5), lit * 0.9, edge * (0.4 + 0.6 * sheen) * 0.8),
      alpha: lit * 0.32 + edge * (0.3 + 0.7 * sheen) * 0.22,
    };
  },
  glitter: ({ u, v, sheen, spectrum }) => {
    const flake = glitter(u, v, STILL_TIME);
    return { color: spectrum.map((channel) => (1 + (channel - 1) * 0.45) * flake * 1.4) as Rgb, alpha: flake * (0.55 + 0.45 * sheen) };
  },
  sunburst: ({ u, v }) => {
    const [rays, angle] = sunburst(u, v, STILL_TIME);
    return { color: scaled(hue(angle * 0.32 + STILL_TIME * 0.02, 0.96, 0.4), rays * 1.1), alpha: rays * 0.42 };
  },
  caustics: ({ u, v, sheen, pale }) => {
    const ripple = caustics(u, v, STILL_TIME);
    return { color: scaled(pale, ripple * (0.8 + 0.5 * sheen)), alpha: ripple * (0.3 + 0.2 * sheen) };
  },
  "note-rain": ({ u, v, sheen, spectrum, pale }) => {
    const [note, rail] = noteRain(u, v, STILL_TIME);
    const lit = note * (0.45 + 0.55 * sheen);
    return {
      color: pale.map((channel, index) => (channel + (spectrum[index]! - channel) * 0.5) * lit * 1.1 + rail * 0.3) as Rgb,
      alpha: lit * 0.42 + rail * 0.06,
    };
  },
  scanline: (point) => scanline(point, STILL_TIME),
  aurora: ({ u, v, sheen }) => {
    const veil = aurora(u, v, STILL_TIME);
    return { color: scaled(hue(u * 0.6 + v * 0.25 + STILL_TIME * 0.015, 1, 0.55), veil * (0.9 + 0.4 * sheen)), alpha: veil * (0.34 + 0.14 * sheen) };
  },
};

export function hasSupporterFoilStill(foil: SupporterFoilId): boolean {
  return foil in FOIL_LIGHTS;
}

/* The foil as straight-alpha RGBA rows from the top, or null for a foil with no still here. */
export function supporterFoilStillPixels(foil: SupporterFoilId, width: number, height: number): Uint8ClampedArray | null {
  const light = FOIL_LIGHTS[foil];
  if (!light) return null;
  const pixels = new Uint8ClampedArray(width * height * 4);
  // The main beam's axis and the one crossing it, as in the shader's main().
  const axisLength = Math.hypot(0.3, 1);
  const ax = 0.3 / axisLength;
  const ay = 1 / axisLength;
  const crossLength = Math.hypot(1, -0.55);
  const bx = 1 / crossLength;
  const by = -0.55 / crossLength;
  // its resting place plus the idle drift at the still's frame
  const centerA = 0.5 * (ax + ay) + Math.sin(STILL_TIME * 0.35) * 0.18;
  const point: FoilPoint = { u: 0, v: 0, sheen: 0, spectrum: [0, 0, 0], pale: [0, 0, 0], fineHue: 0, rows: height };
  for (let row = 0; row < height; row += 1) {
    point.v = 1 - (row + 0.5) / height;
    for (let col = 0; col < width; col += 1) {
      point.u = (col + 0.5) / width;
      const coordA = point.u * ax + point.v * ay;
      const coordB = point.u * bx + point.v * by;
      const d = coordA - centerA;
      const glow = Math.exp(-d * d * 1.4);
      point.sheen = 0.12 + 0.88 * glow;
      // light.x * 1.5 - light.y * 1.1 at rest is 0.2
      point.fineHue = coordA * 4.2 - coordB * 1.6 + 0.2 + STILL_TIME * 0.03;
      for (let channel = 0; channel < 3; channel += 1) {
        const pure = 0.5 + 0.5 * Math.cos(TAU * (PHASES[channel]! + point.fineHue));
        point.spectrum[channel] = 0.94 + (pure - 0.94) * 0.62;
        point.pale[channel] = 1 + (point.spectrum[channel]! - 1) * 0.35;
      }
      const { color, alpha } = light(point);
      // the soft pale sheen every foil but the lattice gets, edge to edge
      const at = (row * width + col) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[at + channel] = (color[channel]! + (1 + (point.spectrum[channel]! - 1) * 0.5) * glow * 0.35) * 255;
      }
      pixels[at + 3] = Math.min(ALPHA_CEILING, (alpha + glow * 0.07) * INTENSITY) * 255;
    }
  }
  return pixels;
}

/* Foils that are soft light with no fine edge: worked out at half the size in
   each direction, a quarter of the pixels, and stretched by whoever draws it.
   Working one out holds the server for a few hundred ms the first time. */
const SOFT_FOILS: ReadonlySet<SupporterFoilId> = new Set(["caustics", "sunburst", "aurora"]);

const stillCache = new Map<string, Promise<string | null>>();

/* The still as a PNG data URL for a card of the size given, drawn once per
   process. A soft foil's picture is half that size; draw it stretched over the card. */
export function supporterFoilStillDataUrl(foil: SupporterFoilId, cardWidth: number, cardHeight: number): Promise<string | null> {
  const shrink = SOFT_FOILS.has(foil) ? 2 : 1;
  const width = Math.round(cardWidth / shrink);
  const height = Math.round(cardHeight / shrink);
  const key = `${foil}:${width}x${height}`;
  const cached = stillCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const pixels = supporterFoilStillPixels(foil, width, height);
    if (!pixels) return null;
    const { default: sharp } = await import("sharp");
    const png = await sharp(Buffer.from(pixels.buffer), { raw: { width, height, channels: 4 } }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  })().catch(() => null);
  stillCache.set(key, pending);
  return pending;
}
