// Stills of the shader name styles for the pictures /api/og makes. On the site
// these names run a WebGL shader over the big name of a profile
// (name-tag-shaders.ts) and a picker tile shows a still of it; a server has no
// GPU, so the same shaders are worked out here per pixel. The maths follows
// name-tag-shaders.ts line for line (and Paper's Liquid Metal for chrome and
// molten gold, @paper-design/shaders 0.0.81, Apache-2.0): a look changed there
// has to be changed here too.
//
// As there, a shader reads a mask of the name laid out in its box, `uv` runs
// 0..1 over the box with y down, and `p` measures both axes in box heights.
// The still is the busiest of the same few moments the site tries.

import type { ShaderNameStyle } from "./supporter-name-styles";

/* The styles drawn here: the site's SHADER_NAME_STYLES, listed again so a
   picture's code loads none of the site's label strings (og-name-tag.test.ts
   holds the two lists together). */
export const OG_SHADER_NAME_STYLES: readonly ShaderNameStyle[] = [
  "chrome", "ethereal", "aurora", "glitch", "molten-gold", "pearl", "galaxy", "heatmap",
  "note-rain", "plasma", "ink", "caustics", "lava", "dither", "mesh", "inferno", "hellfire",
];

export function isOgShaderNameStyle(value: string | null): value is ShaderNameStyle {
  return value !== null && (OG_SHADER_NAME_STYLES as readonly string[]).includes(value);
}

/** The name's glyph coverage over its box, 0..1 a pixel, rows from the top. */
export interface NameMask {
  alpha: Float32Array;
  width: number;
  height: number;
}

/** Premultiplied RGBA, 0..1 a channel, the mask's size. */
export type ShadedName = Float32Array;

// ---------------------------------------------------------------------------
// GLSL's built-ins, and the shaders' shared prelude.

type Vec3 = [number, number, number];

const f = Math.fround;
const fract = (x: number) => x - Math.floor(x);
const clamp = (x: number, low: number, high: number) => Math.min(high, Math.max(low, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const step = (edge: number, x: number) => (x < edge ? 0 : 1);
function smoothstep(from: number, to: number, x: number): number {
  const t = clamp((x - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// The hash is all rounding: a GPU works it in 32-bit floats, and so does this.
const K1 = f(123.34);
const K2 = f(456.21);
const K3 = f(45.32);
function hash(x: number, y: number): number {
  let px = f(f(x) * K1);
  let py = f(f(y) * K2);
  px = f(px - Math.floor(px));
  py = f(py - Math.floor(py));
  const d = f(f(px * f(px + K3)) + f(py * f(py + K3)));
  px = f(px + d);
  py = f(py + d);
  const product = f(px * py);
  return f(product - Math.floor(product));
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash(ix, iy), hash(ix + 1, iy), fx), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), fx), fy);
}

function fbm(x: number, y: number): number {
  let value = 0;
  let amplitude = 0.5;
  for (let octave = 0; octave < 4; octave++) {
    value += amplitude * noise(x, y);
    x = x * 2.03 + 7.1;
    y = y * 2.03 + 7.1;
    amplitude *= 0.5;
  }
  return value;
}

/** A texture read: bilinear, clamped at the edges, as the GPU filters the mask. */
function sample(data: Float32Array, width: number, height: number, u: number, v: number): number {
  const x = clamp(u * width - 0.5, 0, width - 1);
  const y = clamp(v * height - 0.5, 0, height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const top = data[y0 * width + x0]! * (1 - tx) + data[y0 * width + x1]! * tx;
  const bottom = data[y1 * width + x0]! * (1 - tx) + data[y1 * width + x1]! * tx;
  return top * (1 - ty) + bottom * ty;
}

interface Pixel {
  /** The glyph's coverage anywhere in the box, 0 past it. */
  glyph: (u: number, v: number) => number;
  /** The mask read as a texture, clamped at the box's edges. */
  texture: (u: number, v: number) => number;
  u: number;
  v: number;
  /** `uv` with x in box heights. */
  px: number;
  py: number;
  aspect: number;
  t: number;
  /** gl_FragCoord: pixel centres, y from the bottom. */
  fragX: number;
  fragY: number;
}

function depthAt(pixel: Pixel, u: number, v: number): number {
  let depth = 0;
  for (let index = 0; index < 8; index++) {
    const angle = index * 0.785398;
    depth += pixel.glyph(u + (Math.cos(angle) * 0.05) / pixel.aspect, v + Math.sin(angle) * 0.07);
  }
  return depth / 8;
}

// ---------------------------------------------------------------------------
// The letter shaders: each colours a pixel inside the letters.

interface Inside extends Pixel {
  depth: number;
  /** 1 on the letters' edges. */
  rim: number;
}

type LetterStyle = Exclude<ShaderNameStyle, "chrome" | "molten-gold" | "glitch" | "inferno" | "hellfire">;

const HEAT_RAMP: Vec3[] = [[0.07, 0.13, 0.42], [0.12, 0.23, 0.64], [0.18, 0.39, 0.91], [0.42, 0.84, 1], [1, 0.9, 0.47], [1, 0.6, 0.12], [1, 0.3, 0]];
const MESH_COLOURS: Vec3[] = [[1, 0.55, 0.75], [0.45, 0.62, 1], [0.72, 0.48, 1], [1, 0.78, 0.55]];

const LETTER_SHADERS: Record<LetterStyle, (at: Inside) => Vec3> = {
  heatmap: ({ px, py, t, depth }) => {
    const heat = depth * 0.4 + 0.62 * fbm(px * 2.2, py * 2.2 + t * 0.55) + 0.14 * Math.sin(px * 4 - t * 1.4) + 0.1;
    const x = clamp(heat, 0, 0.999) * 6;
    const index = Math.floor(x);
    return mix3(HEAT_RAMP[index]!, HEAT_RAMP[Math.min(index + 1, 6)]!, fract(x));
  },

  ethereal: ({ px, py, t, depth }) => {
    const w = fbm(px * 2.6 + t * 0.45, py * 2.6 - t * 0.18);
    const heat = smoothstep(0.32, 0.6, w) * (0.65 + 0.35 * smoothstep(0.1, 0.6, depth));
    let warm = mix3([1, 0.47, 0.78], [1, 0.62, 0.3], smoothstep(0.45, 0.7, w));
    warm = mix3(warm, [1, 0.93, 0.6], smoothstep(0.55, 0.75, w) * (0.5 + 0.5 * depth));
    const color = mix3([0.43, 0.48, 1], warm, heat);
    const cellX = px * 7;
    const cellY = py * 10;
    const idX = Math.floor(cellX);
    const idY = Math.floor(cellY);
    const h = hash(idX, idY);
    const dx = fract(cellX) - 0.5 - (hash(idX + 3.1, idY + 3.1) - 0.5) * 0.5;
    const dy = fract(cellY) - 0.5 - (hash(idX + 7.7, idY + 7.7) - 0.5) * 0.5;
    const dash = smoothstep(0.3, 0, Math.abs(dx)) * smoothstep(0.11, 0, Math.abs(dy));
    const twinkle = Math.pow(Math.max(0, Math.sin(t * (2 + 2 * h) + h * 40)), 6);
    return mix3(color, [1, 1, 1], dash * twinkle * step(0.4, h));
  },

  pearl: ({ px, py, t, depth }) => {
    const qx = px * 1.6;
    const qy = py * 1.6;
    const inner = fbm(qx * 1.3 - t * 0.1, qy * 1.3 - t * 0.1);
    const n = fbm(qx + t * 0.12 + inner, qy - t * 0.08 + inner);
    const film = n * 1.8 + depth * 0.6 + px * 0.22 + t * 0.04;
    const lift = 0.3 * Math.pow(smoothstep(0.55, 0.95, depth), 3);
    const shade = mix(0.8, 1, smoothstep(0, 0.45, depth));
    const channel = (offset: number, base: number) => (mix(base, 0.55 + 0.45 * Math.cos(6.2831 * (film + offset)), 0.55) + lift) * shade;
    return [channel(0, 0.94), channel(0.33, 0.93), channel(0.67, 0.98)];
  },

  galaxy: ({ px, py, t, rim }) => {
    const qx = px * 1.4 + t * 0.12;
    const qy = py * 1.4 + t * 0.03;
    const inner = fbm(qx * 2 + t * 0.18, qy * 2 - t * 0.1);
    const n1 = fbm(qx * 1.5 + inner, qy * 1.5 + inner);
    let nebula = mix3([0.45, 0.2, 0.8], [0.98, 0.38, 0.72], smoothstep(0.4, 0.8, n1));
    nebula = mix3(nebula, [0.3, 0.58, 1], smoothstep(0.55, 0.9, fbm(qx * 2.3 - t * 0.15, qy * 2.3 - t * 0.05)));
    const color = mix3([0.3, 0.2, 0.6], [nebula[0] * 1.2, nebula[1] * 1.2, nebula[2] * 1.2], smoothstep(0.18, 0.58, n1));
    const star = twinkleStar(px, py, t, 12, 12, 0.6);
    return mix3([color[0] + star, color[1] + star, color[2] + star], [0.86, 0.8, 1], rim * 0.85);
  },

  aurora: ({ px, v, t, rim }) => {
    const x = px * 2.2 + fbm(px * 1.5, t * 0.15) * 1.6;
    let curtain = 0;
    for (let index = 0; index < 3; index++) {
      curtain += smoothstep(0, 0.9, Math.sin(x * (1 + index * 0.7) + t * (0.4 + index * 0.2) + index * 2)) * (1 - index * 0.25);
    }
    curtain = clamp(curtain / 1.8, 0, 1) * (0.55 + 0.45 * fbm(px * 3, v * 2 - t * 0.3));
    let light = mix3([0.62, 0.4, 1], [0.3, 1, 0.62], smoothstep(0.15, 0.75, v));
    light = mix3(light, [0.25, 0.9, 0.95], smoothstep(0.45, 0.9, v) * 0.5);
    return mix3(mix3([0.08, 0.3, 0.34], light, 0.25 + 0.75 * curtain), [0.6, 1, 0.82], rim * 0.55);
  },

  plasma: ({ px, py, t, rim }) => {
    const qx = px * 2;
    const qy = py * 2;
    const n = fbm(qx + t * 0.3, qy + t * 0.2);
    const n2 = fbm(qx * 1.7 - t * 0.25 + n, qy * 1.7 + t * 0.15 + n);
    const vein = Math.pow(1 - Math.abs(n2 * 2 - 1), 12) * 1.4;
    const vein2 = Math.pow(1 - Math.abs(fbm(qx * 3 + t * 0.5, qy * 3 + t * 0.5) * 2 - 1), 18) * 1.2;
    const flicker = 0.86 + 0.14 * noise(t * 18, 0);
    return mix3(
      [(0.14 + 0.3 * vein + 0.9 * vein2) * flicker, (0.32 + 0.7 * vein + 0.95 * vein2) * flicker, (0.84 + vein + vein2) * flicker],
      [0.62, 0.86, 1],
      rim * 0.85,
    );
  },

  ink: ({ px, py, t }) => {
    const qx = px * 1.3;
    const qy = py * 1.3;
    const w1x = fbm(qx, qy + t * 0.06);
    const w1y = fbm(qx + 5.2 - t * 0.05, qy + 1.3 - t * 0.05);
    const w2x = fbm(qx + 3 * w1x + 1.7, qy + 3 * w1y + 9.2);
    const w2y = fbm(qx + 3 * w1x + 8.3 + t * 0.04, qy + 3 * w1y + 2.8 + t * 0.04);
    const bands = Math.sin(fbm(qx + 3 * w2x, qy + 3 * w2y) * 14) * 0.5 + 0.5;
    const ink = mix3([0.1, 0.1, 0.2], [0.24, 0.26, 0.62], smoothstep(0.3, 0.7, w2x));
    const color = mix3([0.96, 0.94, 0.89], ink, smoothstep(0.42, 0.58, bands) * 0.92);
    return mix3(color, [0.96, 0.76, 0.32], smoothstep(0.965, 1, bands) * 0.85);
  },

  caustics: ({ px, py, t, rim }) => {
    const qx = px * 4.5;
    const qy = py * 4.5;
    const idX = Math.floor(qx);
    const idY = Math.floor(qy);
    const fx = fract(qx);
    const fy = fract(qy);
    let f1 = 8;
    let f2 = 8;
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        const pointX = x + 0.5 + 0.42 * Math.sin(t * 0.9 + 6.2831 * hash(idX + x, idY + y));
        const pointY = y + 0.5 + 0.42 * Math.sin(t * 0.9 + 6.2831 * hash(idX + x + 9.1, idY + y + 9.1));
        const distance = Math.hypot(pointX - fx, pointY - fy);
        if (distance < f1) {
          f2 = f1;
          f1 = distance;
        } else if (distance < f2) {
          f2 = distance;
        }
      }
    }
    const net = Math.pow(1 - smoothstep(0, 0.22, f2 - f1), 2) * 0.9;
    const base = mix3([0.02, 0.38, 0.5], [0.08, 0.62, 0.72], fbm(px * 3 + t * 0.2, py * 3 + t * 0.2));
    return mix3([base[0] + 0.7 * net, base[1] + net, base[2] + 0.98 * net], [0.7, 1, 0.98], rim * 0.35);
  },

  lava: ({ px, py, v, t, aspect, rim }) => {
    let field = 0;
    for (let index = 0; index < 7; index++) {
      const h = hash(index, 3.1);
      const cx = fract(h * 7.3 + index * 0.37) * aspect + 0.15 * Math.sin(t * 0.4 + index);
      const cy = 1.3 - fract(t * 0.06 * (0.6 + h) + h) * 1.6;
      const radius = 0.2 + 0.12 * h;
      field += (radius * radius) / Math.max((px - cx) * (px - cx) + (py - cy) * (py - cy), 0.0005);
    }
    const base = mix3([0.66, 0.12, 0.42], [0.9, 0.2, 0.22], v);
    const hot = mix3([1, 0.45, 0.12], [1, 0.88, 0.45], smoothstep(1.2, 3, field));
    return mix3(mix3(base, hot, smoothstep(0.85, 1.15, field)), [1, 0.6, 0.5], rim * 0.4);
  },

  "note-rain": ({ px, v, t, rim }) => {
    const lane = 0.15;
    const column = Math.floor(px / lane);
    const cx = fract(px / lane);
    const speed = 0.55 + 0.25 * hash(column, 1);
    const ny = v - t * speed + hash(column, 4);
    const fy = fract(ny * 3.2);
    const has = step(0.35, hash(column, Math.floor(ny * 3.2)));
    const note = has * smoothstep(0.05, 0.14, cx) * smoothstep(0.95, 0.86, cx) * smoothstep(0, 0.06, fy) * smoothstep(0.34, 0.28, fy);
    const laneColor: Vec3 = ((column % 2) + 2) % 2 < 1 ? [0.92, 0.94, 1] : [1, 0.45, 0.76];
    const lit = 0.05 * smoothstep(0.02, 0, Math.abs(cx - 0.02));
    const base = mix3([0.32, 0.24, 0.62], [0.46, 0.34, 0.78], v);
    const color = mix3([base[0] + lit, base[1] + lit, base[2] + lit], laneColor, note);
    const hitY = 0.74;
    const hny = hitY - t * speed + hash(column, 4);
    const hfy = fract(hny * 3.2);
    const hit = step(0.35, hash(column, Math.floor(hny * 3.2))) * smoothstep(0, 0.06, hfy) * smoothstep(0.34, 0.28, hfy) * smoothstep(0.16, 0, Math.abs(v - hitY)) * 0.7;
    return mix3([color[0] + laneColor[0] * hit, color[1] + laneColor[1] * hit, color[2] + laneColor[2] * hit], [0.86, 0.82, 1], rim * 0.5);
  },

  dither: ({ px, py, t, depth, rim, fragX, fragY }) => {
    const bx = ((Math.floor(fragX / 3) % 4) + 4) % 4;
    const by = ((Math.floor(fragY / 3) % 4) + 4) % 4;
    const m = (bx % 2) * 2 + (by % 2) * 3 - 4 * (bx % 2) * (by % 2);
    const m2 = Math.floor(bx / 2) * 2 + Math.floor(by / 2) * 3 - 4 * Math.floor(bx / 2) * Math.floor(by / 2);
    const bayer = (m * 4 + m2 + 0.5) / 16;
    const value = fbm(px * 1.8 + t * 0.25, py * 1.8) * 0.7 + depth * 0.45 + 0.12 * Math.sin(px * 3 - t * 1.2) - 0.05;
    const level = clamp(Math.floor(value * 3 + bayer), 0, 3);
    const lightest: Vec3 = [0.78, 0.86, 0.38];
    const color: Vec3 = level < 0.5 ? [0.19, 0.38, 0.19] : level < 1.5 ? [0.36, 0.56, 0.2] : level < 2.5 ? [0.55, 0.67, 0.06] : lightest;
    return mix3(color, lightest, rim * 0.35);
  },

  mesh: ({ px, py, t, aspect, rim }) => {
    let qx = px * 0.9;
    let qy = py * 0.9;
    const warpX = fbm(qx + t * 0.1, qy + t * 0.1);
    const warpY = fbm(qx - t * 0.1 + 3, qy - t * 0.1 + 3);
    qx += 0.3 * warpX;
    qy += 0.3 * warpY;
    const sum: Vec3 = [0, 0, 0];
    let weights = 0;
    for (let index = 0; index < 4; index++) {
      const cx = fract(0.23 + index * 0.31) * aspect + 0.4 * aspect * Math.sin(t * 0.17 + index * 1.7);
      const cy = 0.5 + 0.45 * Math.sin(t * 0.23 + index * 2.3);
      const weight = 1 / (0.02 + Math.pow(Math.hypot(qx - cx * 0.9, qy - cy * 0.9), 2.2));
      const colour = MESH_COLOURS[index]!;
      sum[0] += colour[0] * weight;
      sum[1] += colour[1] * weight;
      sum[2] += colour[2] * weight;
      weights += weight;
    }
    return mix3([sum[0] / weights, sum[1] / weights, sum[2] / weights], [1, 1, 1], rim * 0.2);
  },
};

function twinkleStar(px: number, py: number, t: number, scaleX: number, scaleY: number, threshold: number): number {
  const cellX = px * scaleX;
  const cellY = py * scaleY;
  const idX = Math.floor(cellX);
  const idY = Math.floor(cellY);
  const h = hash(idX, idY);
  const atX = (hash(idX + 1.3, idY + 1.3) - 0.5) * 0.6;
  const atY = (hash(idX + 2.7, idY + 2.7) - 0.5) * 0.6;
  const twinkle = 0.5 + 0.5 * Math.sin(t * (1.5 + 3 * h) + h * 30);
  return smoothstep(0.13, 0, Math.hypot(fract(cellX) - 0.5 - atX, fract(cellY) - 0.5 - atY)) * step(threshold, h) * twinkle;
}

function shadeLetters(style: LetterStyle, pixel: Pixel, out: Float32Array, at: number): void {
  const body = pixel.glyph(pixel.u, pixel.v);
  if (body < 0.002) return;
  const depth = depthAt(pixel, pixel.u, pixel.v) * body;
  const rim = body * (1 - smoothstep(0.2, 0.65, depth));
  const color = LETTER_SHADERS[style]({ ...pixel, depth, rim });
  out[at] = color[0] * body;
  out[at + 1] = color[1] * body;
  out[at + 2] = color[2] * body;
  out[at + 3] = body;
}

// ---------------------------------------------------------------------------
// Glitch: the name torn into shifted slices with an RGB split, in bursts.

function shadeGlitch(pixel: Pixel, out: Float32Array, at: number): void {
  const { u, v, t, aspect, glyph } = pixel;
  const step12 = Math.floor(t * 12);
  const burst = step(0.78, hash(Math.floor(t * 2.5), 1));
  const band = Math.floor(v * 12);
  const shift = (hash(band, step12) - 0.5) * 0.18 * burst * step(0.45, hash(band, step12 + 3));
  const gu = u + shift / aspect;
  const split = (0.012 + 0.03 * burst) / aspect;
  const r = glyph(gu + split, v);
  const g = glyph(gu, v);
  const b = glyph(gu - split, v);
  const alpha = Math.max(g, r, b);
  let color = mix3([r, g, b], [1, 1, 1], g * 0.6);
  const flip = burst * step(0.9, hash(Math.floor(u * 8) + step12, Math.floor(v * 4) + step12));
  color = mix3(color, [0.3, 1, 0.95], flip * g);
  const lines = 0.88 + 0.12 * Math.sin(v * 160);
  out[at] = color[0] * lines * alpha;
  out[at + 1] = color[1] * lines * alpha;
  out[at + 2] = color[2] * lines * alpha;
  out[at + 3] = alpha;
}

// ---------------------------------------------------------------------------
// Inferno and Hellfire: burning letters behind a dark edge, flames rising off them.

type FireStyle = "inferno" | "hellfire";

const FIRE_EDGES: Record<FireStyle, Vec3> = { inferno: [0.07, 0.01, 0], hellfire: [0.04, 0, 0.08] };

function fireRamp(style: FireStyle, value: number): Vec3 {
  const h = clamp(value, 0, 1);
  if (style === "inferno") {
    let c = mix3([0.22, 0.01, 0], [0.85, 0.12, 0.02], smoothstep(0, 0.3, h));
    c = mix3(c, [1, 0.42, 0.04], smoothstep(0.25, 0.55, h));
    c = mix3(c, [1, 0.78, 0.25], smoothstep(0.5, 0.8, h));
    return mix3(c, [1, 0.97, 0.85], smoothstep(0.8, 1, h));
  }
  let c = mix3([0.08, 0, 0.14], [0.38, 0.06, 0.7], smoothstep(0, 0.32, h));
  c = mix3(c, [0.42, 0.38, 1], smoothstep(0.28, 0.58, h));
  c = mix3(c, [0.4, 0.82, 1], smoothstep(0.55, 0.82, h));
  return mix3(c, [0.92, 0.98, 1], smoothstep(0.82, 1, h));
}

/** The mask box-filtered down to `width` by `height`, as a canvas draws an image smaller. */
function shrink(mask: NameMask, width: number, height: number): NameMask {
  const alpha = new Float32Array(width * height);
  const scaleX = mask.width / width;
  const scaleY = mask.height / height;
  for (let y = 0; y < height; y++) {
    const fromY = y * scaleY;
    const toY = Math.min(mask.height, (y + 1) * scaleY);
    for (let x = 0; x < width; x++) {
      const fromX = x * scaleX;
      const toX = Math.min(mask.width, (x + 1) * scaleX);
      let sum = 0;
      let area = 0;
      for (let sy = Math.floor(fromY); sy < toY; sy++) {
        const rows = Math.min(toY, sy + 1) - Math.max(fromY, sy);
        for (let sx = Math.floor(fromX); sx < toX; sx++) {
          const weight = rows * (Math.min(toX, sx + 1) - Math.max(fromX, sx));
          sum += mask.alpha[sy * mask.width + sx]! * weight;
          area += weight;
        }
      }
      alpha[y * width + x] = area > 0 ? sum / area : 0;
    }
  }
  return { alpha, width, height };
}

/** The fire's fuel: the mask halved down to 1/8 and to about 1/23 (fireBlurs). */
function fireBlurs(mask: NameMask): [NameMask, NameMask] {
  const halve = (source: NameMask, factor: number) => shrink(source, Math.max(1, Math.round(source.width / factor)), Math.max(1, Math.round(source.height / factor)));
  const level3 = halve(halve(halve(mask, 2), 2), 2);
  return [level3, halve(halve(level3, 2), Math.SQRT2)];
}

function shadeFire(style: FireStyle, pixel: Pixel, blur: NameMask, blurWide: NameMask, out: Float32Array, at: number): void {
  const { u, v, px, py, t, aspect, glyph } = pixel;
  const blurred = (source: NameMask, su: number, sv: number) => sample(source.alpha, source.width, source.height, su, sv);
  const dilate = (du: number, dv: number, radius: number) => {
    let most = 0;
    for (let index = 0; index < 12; index++) {
      const angle = index * 0.5236;
      most = Math.max(most, glyph(du + (Math.cos(angle) * radius) / aspect, dv + Math.sin(angle) * radius));
    }
    return most;
  };
  const body = glyph(u, v);

  let qx = px * 3;
  const qy = py * 2.2 + t * 2;
  qx += (fbm(qx * 0.6 + 3.1, qy * 0.6 + 3.1) - 0.5) * 1.4;
  const tongue = fbm(qx, qy);
  const lick = noise(px * 9, py * 6 + t * 4);

  const reach = 0.05;
  const bend = ((tongue - 0.5) * 0.1) / aspect;
  let fuel = 0;
  for (let k = 0; k < 7; k++) {
    const au = u + bend * k * 0.45;
    const av = v + k * reach;
    const wide = clamp((k * 0.4 - 0.8) / 1.5, 0, 1);
    const g = au < 0 || av < 0 || au > 1 || av > 1 ? 0 : mix(blurred(blur, au, av), blurred(blurWide, au, av), wide);
    fuel = Math.max(fuel, g * (1 - k / 8));
  }
  const above = 1 - clamp(fuel * 1.7, 0, 1);
  const fuelValue = tongue * 1.3 + lick * 0.22 - 0.12;
  let flame = clamp((fuelValue - above * 1.05) * 3.2, 0, 1) * step(above, 0.99);
  flame *= 1 - above * 0.35;
  let overhead = 0;
  for (let index = 1; index <= 3; index++) {
    const av = v - index * 0.07;
    // a texture read, not glyph(): past the sides it holds the edge's coverage
    if (av >= 0) overhead = Math.max(overhead, pixel.texture(u, av));
  }
  flame *= 1 - smoothstep(0.1, 0.5, overhead);

  const sx = px * 7;
  const sy = py * 7 + t * 2.6;
  const sidX = Math.floor(sx);
  const sidY = Math.floor(sy);
  const sparkX = fract(sx) - 0.5 - (hash(sidX + 1.7, sidY + 1.7) - 0.5) * 0.6;
  const sparkY = fract(sy) - 0.5 - (hash(sidX + 4.1, sidY + 4.1) - 0.5) * 0.6;
  let spark = smoothstep(0.09, 0, Math.hypot(sparkX, sparkY)) * step(0.9, hash(sidX, sidY));
  spark *= smoothstep(0.02, 0.2, dilate(u, v + 0.2, 0.12)) * 0.35;

  const edge = dilate(u, v, 0.038) * (1 - body);

  const depth = depthAt(pixel, u, v) * body;
  const heat = 0.58 + 0.3 * depth + 0.14 * v + 0.12 * (tongue - 0.5) + 0.1 * (lick - 0.5);
  let bodyColor = fireRamp(style, heat);
  const top = body * smoothstep(0, 0.2, blurred(blur, u, v) - blurred(blur, u, v - 0.14));
  const front = top * smoothstep(0.62, 0.95, fuelValue);
  bodyColor = mix3(bodyColor, fireRamp(style, 0.5 + 0.3 * tongue), front * 0.75);

  let color = fireRamp(style, flame * 0.95);
  let alpha = smoothstep(0.04, 0.35, flame) * 0.96 * (1 - body);
  color = mix3(color, fireRamp(style, 0.92), spark * (1 - body));
  alpha = Math.max(alpha, spark * (1 - body));
  const edgeAlpha = edge * 0.88;
  color = mix3(color, FIRE_EDGES[style], edgeAlpha);
  alpha = Math.max(alpha, edgeAlpha);
  color = mix3(color, bodyColor, body);
  alpha = Math.max(alpha, body);
  const rimX = 0.05 / aspect;
  alpha *= smoothstep(0, rimX, u) * smoothstep(0, rimX, 1 - u) * smoothstep(0, 0.05, v) * smoothstep(0, 0.05, 1 - v);
  out[at] = color[0] * alpha;
  out[at + 1] = color[1] * alpha;
  out[at + 2] = color[2] * alpha;
  out[at + 3] = alpha;
}

// ---------------------------------------------------------------------------
// Chrome and molten gold: Paper's Liquid Metal over the name.

/** Paper's `toProcessedLiquidMetal`: how deep inside the letters each pixel is, by a Poisson solve. */
function liquidMetalEdges(mask: NameMask): { edge: Float32Array; opacity: Float32Array } {
  // Solved with the box's short side at 512, as Paper does.
  const scale = 512 / Math.min(mask.width, mask.height);
  const width = Math.round(mask.width * scale);
  const height = Math.round(mask.height * scale);
  const shape = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      shape[y * width + x] = sample(mask.alpha, mask.width, mask.height, (x + 0.5) / width, (y + 0.5) / height) > 0.002 ? 1 : 0;
    }
  }
  // Interior pixels, the even ("red") ones first: the solve relaxes each colour in turn.
  const interior = new Int32Array(width * height);
  let redCount = 0;
  let count = 0;
  for (const parity of [0, 1]) {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1 + ((y + 1 + parity) % 2); x < width - 1; x += 2) {
        const index = y * width + x;
        if (!shape[index] || !shape[index - 1] || !shape[index + 1] || !shape[index - width] || !shape[index + width]
          || !shape[index - width - 1] || !shape[index - width + 1] || !shape[index + width - 1] || !shape[index + width + 1]) continue;
        interior[count++] = index;
      }
    }
    if (parity === 0) redCount = count;
  }
  const solved = new Float32Array(width * height);
  const relax = (from: number, to: number) => {
    for (let at = from; at < to; at++) {
      const index = interior[at]!;
      // Every neighbour of an interior pixel is inside the shape.
      const sum = solved[index + 1]! + solved[index - 1]! + solved[index - width]! + solved[index + width]!;
      solved[index] = 1.9 * ((0.01 + sum) / 4) - 0.9 * solved[index]!;
    }
  };
  for (let iteration = 0; iteration < 40; iteration++) {
    relax(0, redCount);
    relax(redCount, count);
  }
  let most = 0;
  for (let at = 0; at < count; at++) most = Math.max(most, solved[interior[at]!]!);
  // Grey where the letters are (white at their edges, dark deep inside), clear elsewhere.
  const grey = new Float32Array(width * height);
  const cover = new Float32Array(width * height);
  for (let index = 0; index < grey.length; index++) {
    if (!shape[index]) continue;
    grey[index] = most > 0 ? 1 - solved[index]! / most : 1;
    cover[index] = 1;
  }
  // Back at the mask's size: the red channel is the edge field, the green the glyph's coverage.
  const edge = new Float32Array(mask.width * mask.height);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const index = y * mask.width + x;
      if (mask.alpha[index]! <= 0) {
        edge[index] = 1;
        continue;
      }
      const u = (x + 0.5) / mask.width;
      const v = (y + 0.5) / mask.height;
      const covered = sample(cover, width, height, u, v);
      // The canvas scales premultiplied: the grey comes back divided by its coverage.
      edge[index] = covered > 0 ? clamp(sample(grey, width, height, u, v) / covered, 0, 1) : 0;
    }
  }
  return { edge, opacity: mask.alpha };
}

function permute(x: number): number {
  const value = (x * 34 + 1) * x;
  return value - 289 * Math.floor(value / 289);
}

function simplex(vx: number, vy: number): number {
  const C0 = 0.211324865405187;
  const C1 = 0.366025403784439;
  const C2 = -0.577350269189626;
  const C3 = 0.024390243902439;
  const skew = (vx + vy) * C1;
  let ix = Math.floor(vx + skew);
  let iy = Math.floor(vy + skew);
  const unskew = (ix + iy) * C0;
  const x0x = vx - ix + unskew;
  const x0y = vy - iy + unskew;
  const i1x = x0x > x0y ? 1 : 0;
  const i1y = 1 - i1x;
  const x1x = x0x + C0 - i1x;
  const x1y = x0y + C0 - i1y;
  const x2x = x0x + C2;
  const x2y = x0y + C2;
  ix -= 289 * Math.floor(ix / 289);
  iy -= 289 * Math.floor(iy / 289);
  const corner = (offsetX: number, offsetY: number) => permute(permute(iy + offsetY) + ix + offsetX);
  const perms = [corner(0, 0), corner(i1x, i1y), corner(1, 1)];
  const points: Array<[number, number]> = [[x0x, x0y], [x1x, x1y], [x2x, x2y]];
  let total = 0;
  for (let index = 0; index < 3; index++) {
    const [dx, dy] = points[index]!;
    let m = Math.max(0.5 - (dx * dx + dy * dy), 0);
    m *= m;
    m *= m;
    const x = 2 * fract(perms[index]! * C3) - 1;
    const h = Math.abs(x) - 0.5;
    const a0 = x - Math.floor(x + 0.5);
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    total += m * (a0 * dx + h * dy);
  }
  return 130 * total;
}

interface MetalLook {
  tint: Vec3;
  distortion: number;
  softness: number;
  shiftRed: number;
  shiftBlue: number;
}

const METAL_LOOKS: Record<"chrome" | "molten-gold", MetalLook> = {
  chrome: { tint: [1, 1, 1], distortion: 0.1, softness: 0.15, shiftRed: 0.3, shiftBlue: 0.3 },
  // #ffbf47
  "molten-gold": { tint: [1, 191 / 255, 71 / 255], distortion: 0.18, softness: 0.3, shiftRed: 0.15, shiftBlue: 0.15 },
};

/** What Liquid Metal works out at a pixel before its stripes are coloured. */
interface MetalPoint {
  stripes: [number, number, number];
  w: Vec3;
  blur: number;
  redBlur: number;
  greenBlur: number;
  bump: number;
  color2Blue: number;
  opacity: number;
}

function metalPoint(look: MetalLook, edges: { edge: Float32Array; opacity: Float32Array }, mask: NameMask, u: number, v: number, time: number, repetition: number): MetalPoint {
  const t = 0.3 * (time + 2.8);
  const read = (data: Float32Array, su: number, sv: number) => sample(data, mask.width, mask.height, su, sv);
  const angle = ((-90 + 70) * Math.PI) / 180;
  const rotatedX = (u - 0.5) * Math.cos(angle) - (v - 0.5) * Math.sin(angle) + 0.5;
  const rotatedY = (u - 0.5) * Math.sin(angle) + (v - 0.5) * Math.cos(angle) + 0.5;

  // blurEdge3x3 at a radius of 6 texels; u_contour .5 leaves the edge at full strength.
  const rx = 6 / mask.width;
  const ry = 6 / mask.height;
  let edge = 4 * read(edges.edge, u, v);
  edge += 2 * (read(edges.edge, u, v - ry) + read(edges.edge, u, v + ry) + read(edges.edge, u - rx, v) + read(edges.edge, u + rx, v));
  edge += read(edges.edge, u - rx, v - ry) + read(edges.edge, u + rx, v - ry) + read(edges.edge, u - rx, v + ry) + read(edges.edge, u + rx, v + ry);
  edge = Math.pow(edge / 16, 1.6);

  const opacity = read(edges.opacity, u, v);
  const diagBLtoTR = rotatedX - rotatedY;
  const diagTLtoBR = rotatedX + rotatedY;
  // Lifted from Paper's near black to gunmetal, as the site's shader is.
  const color2Blue = 0.35 + 0.08 * smoothstep(0.7, 1.3, diagTLtoBR);

  let gradX = u - 0.5;
  let gradY = v - 0.5;
  const distance = Math.hypot(gradX, gradY + 0.2 * diagBLtoTR);
  const turn = (0.25 - 0.2 * diagBLtoTR) * Math.PI;
  // rotate(): mat2(cos, sin, -sin, cos) * uv
  [gradX, gradY] = [Math.cos(turn) * gradX - Math.sin(turn) * gradY, Math.sin(turn) * gradX + Math.cos(turn) * gradY];
  let direction = gradX;

  let bump = 1 - Math.pow(1.8 * distance, 1.2);
  bump *= Math.pow(v, 0.3);

  const thin1 = (0.12 / repetition) * (1 - 0.4 * bump);
  const thin2 = (0.07 / repetition) * (1 + 0.4 * bump);
  const wide = 1 - thin1 - thin2;

  const wobble = simplex(u - t, v - t);
  edge += (1 - edge) * look.distortion * wobble;

  direction += diagBLtoTR;
  direction -= 2 * wobble * diagBLtoTR * (smoothstep(0, 1, edge) * (1 - smoothstep(0, 1, edge)));
  // u_contour .5: its second range is off but for its last, small term.
  direction += 0.2 * Math.pow(0.5, 4) * (1 - smoothstep(0, 1, edge));

  bump *= clamp(Math.pow(v, 0.1), 0.3, 1);
  direction *= 0.1 + (1.1 - edge) * bump;
  direction *= 0.4 + 0.6 * (1 - smoothstep(0.5, 1, edge));
  direction += 0.18 * (smoothstep(0.1, 0.2, v) * (1 - smoothstep(0.2, 0.4, v)));
  direction += 0.03 * (smoothstep(0.1, 0.2, 1 - v) * (1 - smoothstep(0.2, 0.4, 1 - v)));
  direction *= 0.5 + 0.5 * v * v;
  direction *= repetition;
  direction -= t;

  let dispersionRed = clamp(1 - bump, 0, 1);
  let dispersionBlue = dispersionRed * 1.3;
  dispersionRed += 0.03 * bump * wobble;
  dispersionRed += 5 * (smoothstep(-0.1, 0.2, v) * (1 - smoothstep(0.1, 0.5, v))) * (smoothstep(0.4, 0.6, bump) * (1 - smoothstep(0.4, 1, bump)));
  dispersionRed -= diagBLtoTR;
  dispersionBlue += smoothstep(0, 0.4, v) * (1 - smoothstep(0.1, 0.8, v)) * (smoothstep(0.4, 0.6, bump) * (1 - smoothstep(0.4, 0.8, bump)));
  dispersionBlue -= 0.2 * edge;
  dispersionRed *= look.shiftRed / 20;
  dispersionBlue *= look.shiftBlue / 20;

  const softness = 0.05 * look.softness;
  // u_repetition stays under 10, so only the small-canvas term adds to the softness.
  const smallCanvas = 1 - smoothstep(100, 500, Math.min(mask.width, mask.height));
  const blur = softness + smallCanvas * smoothstep(0, 1, edge);
  return {
    stripes: [fract(direction + dispersionRed), fract(direction), fract(direction - dispersionBlue)],
    w: [repetition * thin1, repetition * thin2 - 0.02 * smoothstep(0, 1, edge + bump), wide],
    blur,
    redBlur: softness * (0.05 + 0.1 * (look.shiftRed / 20) * bump),
    greenBlur: (softness * 0.05) / Math.max(0.001, Math.abs(1 - diagBLtoTR)),
    bump,
    color2Blue,
    opacity,
  };
}

function metalChannel(c1: number, c2: number, stripe: number, w: Vec3, blur: number, bumpIn: number, tint: number): number {
  let ch = mix(c2, c1, smoothstep(0, 2 * blur, stripe));
  let border = w[0];
  ch = mix(ch, c2, smoothstep(border, border + 2 * blur, stripe));
  const bump = smoothstep(0.2, 0.8, bumpIn);
  border = w[0] + 0.4 * (1 - bump) * w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2 * blur, stripe));
  border = w[0] + 0.5 * (1 - bump) * w[1];
  ch = mix(ch, c2, smoothstep(border, border + 2 * blur, stripe));
  border = w[0] + w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2 * blur, stripe));
  const gradient = mix(c1, c2, smoothstep(0, 1, (stripe - w[0] - w[1]) / w[2]));
  ch = mix(ch, gradient, smoothstep(border, border + 0.5 * blur, stripe));
  // The tint is a colour burn, at the tint's full alpha.
  return 1 - Math.min(1, (1 - ch) / Math.max(tint, 0.0001));
}

type MetalEdges = { edge: Float32Array; opacity: Float32Array };

// The solve is the costly part and the same at every moment: kept by mask.
const metalEdges = new WeakMap<NameMask, MetalEdges>();

function shadeMetal(style: "chrome" | "molten-gold", mask: NameMask, aspect: number, time: number, out: Float32Array): void {
  const look = METAL_LOOKS[style];
  let edges = metalEdges.get(mask);
  if (!edges) {
    edges = liquidMetalEdges(mask);
    metalEdges.set(mask, edges);
  }
  const repetition = Math.min(4, Math.max(2.5, aspect * 0.6));
  const { width, height } = mask;
  const points: Array<MetalPoint | null> = new Array(width * height).fill(null);
  const pointAt = (x: number, y: number): MetalPoint => {
    const cx = clamp(x, 0, width - 1);
    const cy = clamp(y, 0, height - 1);
    const index = cy * width + cx;
    return (points[index] ??= metalPoint(look, edges, mask, (cx + 0.5) / width, (cy + 0.5) / height, time, repetition));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask.alpha[y * width + x]! <= 0) continue;
      const point = pointAt(x, y);
      // fwidth(): how fast a stripe changes to the next pixel, across and down.
      const right = pointAt(x + 1, y);
      const below = pointAt(x, y + 1);
      const width1 = (channel: 0 | 1 | 2) => Math.abs(right.stripes[channel] - point.stripes[channel]) + Math.abs(below.stripes[channel] - point.stripes[channel]);
      const r = metalChannel(0.98, 0.3, point.stripes[0], point.w, point.blur + width1(0) + point.redBlur, point.bump, look.tint[0]);
      const g = metalChannel(0.98, 0.31, point.stripes[1], point.w, point.blur + width1(1) + point.greenBlur, point.bump, look.tint[1]);
      const b = metalChannel(1, point.color2Blue, point.stripes[2], point.w, point.blur + width1(2), point.bump, look.tint[2]);
      const at = (y * width + x) * 4;
      out[at] = r * point.opacity;
      out[at + 1] = g * point.opacity;
      out[at + 2] = b * point.opacity;
      out[at + 3] = point.opacity;
    }
  }
}

// ---------------------------------------------------------------------------

/** One frame of a shader style over the mask, `time` seconds into its animation. */
export function shadeName(style: ShaderNameStyle, mask: NameMask, time: number): ShadedName {
  const { width, height } = mask;
  const out = new Float32Array(width * height * 4);
  const aspect = width / height;
  if (style === "chrome" || style === "molten-gold") {
    shadeMetal(style, mask, aspect, time, out);
    return out;
  }
  const texture = (u: number, v: number) => sample(mask.alpha, width, height, u, v);
  const glyph = (u: number, v: number) => (u < 0 || v < 0 || u > 1 || v > 1 ? 0 : texture(u, v));
  const fire = style === "inferno" || style === "hellfire" ? fireBlurs(mask) : null;
  const pixel: Pixel = { glyph, texture, u: 0, v: 0, px: 0, py: 0, aspect, t: time, fragX: 0, fragY: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixel.u = (x + 0.5) / width;
      pixel.v = (y + 0.5) / height;
      pixel.px = pixel.u * aspect;
      pixel.py = pixel.v;
      pixel.fragX = x + 0.5;
      pixel.fragY = height - y - 0.5;
      const at = (y * width + x) * 4;
      if (style === "glitch") shadeGlitch(pixel, out, at);
      else if (fire) shadeFire(style as FireStyle, pixel, fire[0], fire[1], out, at);
      else shadeLetters(style as LetterStyle, pixel, out, at);
    }
  }
  return out;
}

/* The moments the site takes a still from, in seconds (STILL_FRAMES). */
const STILL_TIMES = [0.9, 2.3, 3.7, 5.1, 6.5, 7.9, 9.3, 10.7];

// The site's measure of a frame: its cover, weighted up by how colourful it is.
function busyness(shaded: ShadedName): number {
  let score = 0;
  for (let at = 0; at < shaded.length; at += 16) {
    const alpha = shaded[at + 3]!;
    if (alpha < 24 / 255) continue;
    // The site scores the picture as a canvas holds it, not premultiplied.
    const r = shaded[at]! / alpha;
    const g = shaded[at + 1]! / alpha;
    const b = shaded[at + 2]! / alpha;
    score += alpha * 255 * (1 + ((Math.max(r, g, b) - Math.min(r, g, b)) * 255) / 128);
  }
  return score;
}

/**
 * The still of a shader style: the busiest of the site's moments. The moment
 * is picked on `preview` (the mask at a lower resolution, quicker to shade),
 * then drawn on `mask`.
 */
export function shadeNameStill(style: ShaderNameStyle, mask: NameMask, preview: NameMask = mask): ShadedName {
  if (style === "chrome" || style === "molten-gold") {
    // The preview reads the full mask's solve, shrunk, so it is solved once.
    shadeName(style, mask, STILL_TIMES[0]!);
    const full = metalEdges.get(mask)!;
    const small = (data: Float32Array) => shrink({ alpha: data, width: mask.width, height: mask.height }, preview.width, preview.height).alpha;
    if (preview !== mask) metalEdges.set(preview, { edge: small(full.edge), opacity: preview.alpha });
  }
  let best = STILL_TIMES[0]!;
  let bestScore = -1;
  for (const time of STILL_TIMES) {
    const score = busyness(shadeName(style, preview, time));
    if (score > bestScore) {
      bestScore = score;
      best = time;
    }
  }
  return shadeName(style, mask, best);
}

/** The same mask at a fraction of its size, for picking the still's moment. */
export function previewMask(mask: NameMask, factor: number): NameMask {
  return shrink(mask, Math.max(1, Math.round(mask.width / factor)), Math.max(1, Math.round(mask.height / factor)));
}
