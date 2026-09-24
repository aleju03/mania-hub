// Pixel-painting toolkit shared by the procedural sprites: hard-edged shapes,
// an auto-outline pass (the dark silhouette line that makes everything read
// as one tileset), value noise and ordered dithering. No anti-aliasing
// anywhere: every helper writes whole pixels.

import { createCanvas, ctx2d, hexToRgb, type Ctx, type Sprite } from "./core";

export const OUTLINE = "#2a1d18";

export function newSprite(w: number, h: number): { sprite: Sprite; ctx: Ctx } {
  const canvas = createCanvas(w, h);
  return { sprite: { canvas, w, h }, ctx: ctx2d(canvas) };
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function dot(ctx: Ctx, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

// filled ellipse, scanline by scanline
export function ellipse(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, color: string): void {
  ctx.fillStyle = color;
  const r0 = Math.ceil(ry);
  for (let dy = -r0; dy <= r0; dy++) {
    const t = dy / ry;
    if (Math.abs(t) > 1) continue;
    const half = rx * Math.sqrt(1 - t * t);
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    if (x1 > x0) ctx.fillRect(x0, Math.round(cy + dy), x1 - x0, 1);
  }
}

export function disk(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ellipse(ctx, cx, cy, r, r, color);
}

// 1px line (Bresenham)
export function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string): void {
  ctx.fillStyle = color;
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// filled convex/concave polygon by even-odd scanlines, pixel centers
export function poly(ctx: Ctx, pts: Array<[number, number]>, color: string): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  ctx.fillStyle = color;
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
        xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.round(xs[i]);
      const x1 = Math.round(xs[i + 1]);
      if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, 1);
    }
  }
}

export function speckle(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, count: number, rng: () => number): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.fillRect(Math.round(x + rng() * (w - 1)), Math.round(y + rng() * (h - 1)), 1, 1);
  }
}

// Paints a 1px outline on every transparent pixel that touches an opaque one
// (4-neighbourhood). Sprites need a 1px empty margin for the line to fit.
export function outlineSprite(ctx: Ctx, w: number, h: number, color: string = OUTLINE, alphaCut = 128): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [r, g, b] = hexToRgb(color);
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3] >= alphaCut ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (solid[i]) continue;
      const n =
        (x > 0 && solid[i - 1]) ||
        (x < w - 1 && solid[i + 1]) ||
        (y > 0 && solid[i - w]) ||
        (y < h - 1 && solid[i + w]);
      if (n) {
        d[i * 4] = r;
        d[i * 4 + 1] = g;
        d[i * 4 + 2] = b;
        d[i * 4 + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Darkens opaque pixels whose neighbour in direction (dx, dy) is empty: a
// cheap rim shade that gives blobs (canopies, bushes, rocks) volume.
export function rimShade(ctx: Ctx, w: number, h: number, dx: number, dy: number, color: string): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [r, g, b] = hexToRgb(color);
  const src = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) src[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!src[i]) continue;
      const nx = x + dx;
      const ny = y + dy;
      const empty = nx < 0 || ny < 0 || nx >= w || ny >= h || !src[ny * w + nx];
      if (empty) {
        d[i * 4] = r;
        d[i * 4 + 1] = g;
        d[i * 4 + 2] = b;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// --- noise ------------------------------------------------------------------

export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

export function fbm(x: number, y: number, seed = 0, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// 4x4 Bayer matrix, normalised to (0, 1)
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export function bayer(x: number, y: number): number {
  return (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
}
