// Shared primitives for the valley monitor: palette, seeded RNG, canvas helpers.
// Everything here must run both in the browser and under the offline
// @napi-rs/canvas harness (no window/OffscreenCanvas at module scope).

export const TILE = 16;
export const MAP_W = 48;
export const MAP_H = 27;
export const VIEW_W = MAP_W * TILE; // 768
export const VIEW_H = MAP_H * TILE; // 432

export type Ctx = CanvasRenderingContext2D;

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function ctx2d(canvas: HTMLCanvasElement): Ctx {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

// Deterministic RNG so decorations land in the same spot every visit.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const C = {
  // terrain
  grass: "#4e9a48",
  grassDark: "#41863c",
  grassDarker: "#356f31",
  grassLight: "#5cab53",
  path: "#c9a266",
  pathDark: "#b18a51",
  pathEdge: "#8f6f42",
  pebble: "#a3805249",
  soil: "#7a5233",
  soilDark: "#644128",
  soilRow: "#8a6039",
  water: "#3e77c8",
  waterDeep: "#3465ae",
  waterLight: "#5e9be0",
  waterSparkle: "#cfe8fa",
  waterMurk: "#7d8752",
  waterMurkDeep: "#6a7444",
  dryBed: "#b59a6a",
  dryCrack: "#93794d",
  bank: "#3c6b36",
  sand: "#d8c188",

  // structures
  wood: "#8a5a33",
  woodDark: "#6d4426",
  woodDarker: "#553419",
  woodLight: "#a9743f",
  plank: "#9c6a3b",
  roofRed: "#b5453a",
  roofRedDark: "#8e332c",
  roofRedLight: "#cf5f4b",
  roofBlue: "#4a6fb0",
  roofBlueDark: "#39588f",
  roofBlueLight: "#6389c9",
  roofGreen: "#4f8a4a",
  roofGreenDark: "#3d6f3a",
  roofGreenLight: "#66a35e",
  stone: "#9b9b9b",
  stoneDark: "#767676",
  stoneLight: "#bdbdbd",
  wallCream: "#e4cfa4",
  wallCreamDark: "#c9b087",
  windowGlow: "#ffd977",
  windowDark: "#2c3a55",
  windowNight: "#ffe9a8",

  // nature
  trunk: "#6b4a2a",
  trunkDark: "#523719",
  leaf: "#3c7f38",
  leafDark: "#2f6a2d",
  leafLight: "#57a04b",
  leafLighter: "#6fb75d",
  pine: "#2f6e46",
  pineDark: "#255a39",
  pineLight: "#3f8a58",
  flowerPink: "#e884b6",
  flowerYellow: "#f2cf4f",
  flowerWhite: "#f2f2ea",
  hay: "#d9b545",
  hayDark: "#b8933a",

  // characters
  skin: "#f2c79b",
  skinDark: "#d9a677",
  outline: "#2b2118",

  // ui
  uiBg: "#151221",
  uiBorder: "#f4f0e6",
  uiText: "#f4f0e6",
  uiDim: "#a89e8f",
  uiYellow: "#ffd554",
  uiGreen: "#7ce069",
  uiRed: "#ff7b6b",
  uiBlue: "#7db6ff",
  uiPink: "#ff9ad5",
} as const;

export type ColorKey = keyof typeof C;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Draw a single "pixel" (1x1 rect) - kept as a helper so intent is obvious.
export function px(ctx: Ctx, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x | 0, y | 0, 1, 1);
}

export interface Sprite {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

// Decode string-grid pixel art into an offscreen canvas. Rows may have
// different lengths; '.' and ' ' are transparent.
export function spriteFromGrid(rows: string[], pal: Record<string, string>): Sprite {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === "." || ch === " ") continue;
      const color = pal[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return { canvas, w, h };
}

export function flipSprite(sprite: Sprite): Sprite {
  const canvas = createCanvas(sprite.w, sprite.h);
  const ctx = ctx2d(canvas);
  ctx.translate(sprite.w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(sprite.canvas, 0, 0);
  return { canvas, w: sprite.w, h: sprite.h };
}
