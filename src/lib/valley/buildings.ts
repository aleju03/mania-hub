// Procedural buildings in a 3/4 top-down farm-sim style: shingled roofs seen
// from the front, textured walls, framed windows with shutters and flower
// boxes, doors with a stone stoop, a stone foundation, and one dark outline
// around the silhouette. Geometry (door, windows, chimney, footprint) is pure
// data so the map can line roads up with real door positions; painting only
// happens when the sprite atlas is built.

import { hexToRgb, shade, mulberry32, type Ctx, type Sprite } from "./core";
import { drawText, textWidth } from "./font";
import { OUTLINE, bayer, disk, ellipse, hash2, line, newSprite, outlineSprite, poly, rect } from "./paint";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BuildingSpec {
  w: number;
  h: number;
  base: number; // y of the ground line inside the sprite (sort baseline)
  door: Rect | null; // the door opening, sprite-relative
  windows: Rect[]; // glass areas, for the night glow
  chimney: { x: number; y: number } | null; // smoke emitter
  foot: Rect; // solid footprint, sprite-relative
  gauge?: Rect; // silo fill window
  hub?: { x: number; y: number }; // windmill blade hub
}

export interface BuildingSprite extends Sprite {
  windows: Rect[];
  chimney: { x: number; y: number } | null;
}

type RoofKind = "shingle" | "scallop" | "slate" | "thatch" | "tin";
type WallKind = "plaster" | "planks" | "logs" | "stone" | "brick" | "timber";

export interface HouseStyle {
  w: number; // wall width
  wallH: number;
  roofH: number;
  roof: { kind: RoofKind; color: string };
  wall: { kind: WallKind; color: string };
  trim: string;
  door: { x: number; w?: number; h?: number; color: string; arched?: boolean };
  windows: Array<{ x: number; y: number; w: number; h: number; shutters?: string; box?: string }>;
  chimney?: { x: number; kind: "stone" | "brick" };
  dormer?: { x: number; w: number; window?: "round" | "square" };
  porch?: { x: number; w: number };
  awning?: { a: string; b: string; x: number; w: number };
  sign?: { text: string; color: string };
  seed: number;
}

// --- pixel buffer ------------------------------------------------------------

const rgbCache = new Map<string, [number, number, number]>();
function rgbOf(hex: string): [number, number, number] {
  let v = rgbCache.get(hex);
  if (!v) {
    v = hexToRgb(hex);
    rgbCache.set(hex, v);
  }
  return v;
}

class PixBuf {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  set(x: number, y: number, hex: string): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b] = rgbOf(hex);
    const i = (y * this.w + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = 255;
  }
  flush(ctx: Ctx): void {
    const img = ctx.createImageData(this.w, this.h);
    img.data.set(this.data);
    ctx.putImageData(img, 0, 0);
  }
}

// --- material patterns --------------------------------------------------------

function ramp(c: string) {
  return {
    l2: shade(c, 0.3),
    l1: shade(c, 0.15),
    m: c,
    d1: shade(c, -0.16),
    d2: shade(c, -0.32),
    d3: shade(c, -0.5),
  };
}

// colour of roof pixel (x, row r of roofH), x in sprite space
function roofPixel(kind: RoofKind, color: string, x: number, r: number, roofH: number, seed: number): string {
  const p = ramp(color);
  const t = r / Math.max(1, roofH - 1);
  if (kind === "thatch") {
    const band = Math.floor(r / 6);
    const k = hash2(x, band, seed);
    const k2 = hash2(x >> 1, r, seed + 3);
    if (r % 6 === 5 && k2 < 0.7) return p.d2;
    if (k < 0.18) return p.d1;
    if (k > 0.82) return p.l1;
    if (t < 0.15) return p.l1;
    return t > 0.8 ? p.d1 : p.m;
  }
  if (kind === "tin") {
    const m = x % 4;
    if (r % 12 === 11) return p.d2;
    const base = m === 0 ? p.l1 : m === 3 ? p.d1 : p.m;
    return t > 0.85 && m !== 0 ? p.d1 : base;
  }
  if (kind === "slate") {
    const row = Math.floor(r / 3);
    const yy = r % 3;
    const off = (row % 2) * 3;
    const xx = (x + off) % 6;
    if (yy === 2) return p.d2;
    if (xx === 0) return p.d1;
    const k = hash2(Math.floor((x + off) / 6), row, seed);
    const tone = k < 0.25 ? p.l1 : k > 0.8 ? p.d1 : p.m;
    return yy === 0 && xx === 1 ? p.l2 : tone;
  }
  // shingle / scallop: 4px rows, 6px shingles, staggered
  const row = Math.floor(r / 4);
  const yy = r % 4;
  const off = (row % 2) * 3;
  const xx = (x + off) % 6;
  const k = hash2(Math.floor((x + off) / 6), row, seed);
  let tone = k < 0.2 ? p.l1 : k > 0.85 ? p.d1 : p.m;
  if (t < 0.12) tone = p.l1;
  else if (t > 0.82 && tone === p.m) tone = p.d1;
  if (kind === "scallop") {
    if (yy === 3) return xx === 0 || xx === 5 ? p.d3 : p.d1;
    if (yy === 2 && (xx === 0 || xx === 5)) return p.d2;
    if (yy === 0 && xx === 2) return p.l2;
    return tone;
  }
  if (yy === 3) return p.d2;
  if (xx === 0) return p.d1;
  if (yy === 0 && xx === 1) return p.l2;
  return tone;
}

function wallPixel(kind: WallKind, color: string, x: number, y: number, seed: number): string {
  const p = ramp(color);
  switch (kind) {
    case "planks": {
      const yy = y % 4;
      const board = Math.floor(y / 4);
      if (yy === 3) return p.d2;
      const seamAt = 7 + Math.floor(hash2(board, 1, seed) * 20);
      if ((x + board * 13) % 26 === seamAt % 26) return p.d1;
      if (yy === 0) return p.l1;
      return hash2(x, y, seed) < 0.05 ? p.d1 : p.m;
    }
    case "logs": {
      const yy = y % 5;
      if (yy === 0) return p.l1;
      if (yy === 4) return p.d2;
      if (yy === 3) return p.d1;
      return hash2(x, y, seed) < 0.06 ? p.d1 : p.m;
    }
    case "stone": {
      const row = Math.floor(y / 5);
      const yy = y % 5;
      if (yy === 4) return shade(color, -0.42);
      // stone boundaries: jittered per row
      const off = Math.floor(hash2(row, 7, seed) * 7);
      const cell = Math.floor((x + off) / 7);
      const xx = (x + off) % 7;
      const edge = xx === 0;
      if (edge) return shade(color, -0.42);
      const k = hash2(cell, row, seed);
      const tone = k < 0.3 ? p.l1 : k > 0.75 ? p.d1 : p.m;
      if (yy === 0 && xx === 1) return p.l2;
      if (yy === 3) return p.d1;
      return tone;
    }
    case "brick": {
      const row = Math.floor(y / 3);
      const yy = y % 3;
      const off = (row % 2) * 4;
      const xx = (x + off) % 8;
      if (yy === 2 || xx === 0) return "#cbbfae";
      const k = hash2(Math.floor((x + off) / 8), row, seed);
      return k < 0.25 ? p.d1 : k > 0.8 ? p.l1 : p.m;
    }
    case "timber":
    case "plaster":
    default: {
      const k = hash2(x, y, seed);
      if (k < 0.05) return p.d1;
      if (k > 0.97) return p.l1;
      return p.m;
    }
  }
}

function foundationPixel(x: number, y: number, seed: number): string {
  const yy = y % 4;
  const row = Math.floor(y / 4);
  const off = (row % 2) * 4;
  if (yy === 3 || (x + off) % 8 === 0) return "#4e4a52";
  const k = hash2(Math.floor((x + off) / 8), row, seed);
  if (yy === 0) return "#b3aeb0";
  return k < 0.4 ? "#8c878d" : "#9d989c";
}

// --- detail painters ------------------------------------------------------------

function paintWindow(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  trim: string,
  shutters?: string,
  box?: string,
  seed = 1,
): Rect {
  const frame = shade(trim, -0.08);
  if (shutters) {
    const sd = shade(shutters, -0.25);
    rect(ctx, x - 4, y - 1, 3, h + 2, shutters);
    rect(ctx, x + w + 1, y - 1, 3, h + 2, shutters);
    for (let yy = y; yy < y + h + 1; yy += 2) {
      rect(ctx, x - 4, yy, 3, 1, sd);
      rect(ctx, x + w + 1, yy, 3, 1, sd);
    }
  }
  rect(ctx, x - 1, y - 1, w + 2, h + 2, frame);
  // glass: dark sky with a diagonal reflection
  rect(ctx, x, y, w, h, "#33466a");
  rect(ctx, x, y, w, 1, "#4a6390");
  for (let i = 0; i < Math.min(w, h); i++) {
    const px2 = x + 1 + i;
    const py2 = y + h - 2 - i;
    if (px2 < x + w && py2 >= y && i % 5 < 2) rect(ctx, px2, py2, 1, 1, "#7fa6cf");
  }
  rect(ctx, x + 1, y + 1, 2, 1, "#9fc2e2");
  // mullions
  if (w >= 6) rect(ctx, x + Math.floor(w / 2), y, 1, h, frame);
  if (h >= 6) rect(ctx, x, y + Math.floor(h / 2), w, 1, frame);
  // sill
  rect(ctx, x - 2, y + h + 1, w + 4, 1, shade(trim, 0.1));
  rect(ctx, x - 2, y + h + 2, w + 4, 1, shade(trim, -0.3));
  if (box) {
    const rng = mulberry32(seed);
    rect(ctx, x - 1, y + h + 3, w + 2, 3, "#7a4a2a");
    rect(ctx, x - 1, y + h + 3, w + 2, 1, "#9a6438");
    for (let i = 0; i < w + 2; i++) {
      const c = rng() < 0.5 ? "#4f8a3c" : "#6aa84a";
      rect(ctx, x - 1 + i, y + h + 2 - (rng() < 0.4 ? 1 : 0), 1, 1, c);
      if (rng() < 0.45) rect(ctx, x - 1 + i, y + h + 1 - Math.floor(rng() * 2), 1, 1, rng() < 0.5 ? box : shade(box, 0.3));
    }
  }
  return { x, y, w, h };
}

function paintDoor(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, trim: string, arched = false): void {
  const p = ramp(color);
  const frame = shade(trim, -0.1);
  rect(ctx, x - 1, y - 1, w + 2, h + 1, frame);
  if (arched) {
    rect(ctx, x, y + 1, w, h - 1, p.m);
    rect(ctx, x + 1, y, w - 2, 1, p.m);
    rect(ctx, x - 1, y - 1, 1, 2, "rgba(0,0,0,0)");
  } else {
    rect(ctx, x, y, w, h, p.m);
  }
  for (let xx = x + 2; xx < x + w - 1; xx += 3) rect(ctx, xx, y + 1, 1, h - 1, p.d1);
  rect(ctx, x, y + (arched ? 1 : 0), 1, h, p.l1);
  rect(ctx, x + w - 1, y, 1, h, p.d2);
  rect(ctx, x + 1, y + 2, w - 2, 1, p.d1);
  rect(ctx, x + 1, y + h - 4, w - 2, 1, p.d1);
  // small window in the door
  if (h >= 14 && w >= 7) {
    rect(ctx, x + Math.floor(w / 2) - 2, y + 4, 4, 3, "#33466a");
    rect(ctx, x + Math.floor(w / 2) - 2, y + 4, 1, 1, "#7fa6cf");
  }
  rect(ctx, x + w - 3, y + Math.floor(h * 0.55), 2, 1, "#f2cf4f");
  // stone stoop
  rect(ctx, x - 2, y + h, w + 4, 2, "#a6a0a4");
  rect(ctx, x - 2, y + h, w + 4, 1, "#c8c2c4");
  rect(ctx, x - 2, y + h + 2, w + 4, 1, "#5a555c");
}

function paintChimney(ctx: Ctx, x: number, top: number, bottom: number, kind: "stone" | "brick", seed: number): void {
  const w = 7;
  for (let y = top; y < bottom; y++) {
    for (let xx = 0; xx < w; xx++) {
      const c =
        kind === "brick"
          ? wallPixel("brick", "#a8503e", xx, y - top, seed)
          : wallPixel("stone", "#8d8a90", xx + 3, y - top, seed);
      rect(ctx, x + xx, y, 1, 1, c);
    }
  }
  rect(ctx, x + w - 1, top, 1, bottom - top, "rgba(20,10,20,0.3)");
  rect(ctx, x - 1, top, w + 2, 2, kind === "brick" ? "#7e3a2e" : "#6b6870");
  rect(ctx, x - 1, top, w + 2, 1, kind === "brick" ? "#b8604a" : "#aaa6ac");
  rect(ctx, x + 1, top - 1, w - 2, 1, "#2a2226");
}

// --- houses -------------------------------------------------------------------------

const EAVE = 3;
const PAD = 2;

export function houseSpec(st: HouseStyle): BuildingSpec {
  const top = st.chimney ? 8 : 2;
  const ox = PAD + EAVE;
  const wallTop = top + st.roofH;
  const base = wallTop + st.wallH;
  const w = st.w + 2 * (EAVE + PAD);
  const h = base + 4;
  const dw = st.door.w ?? 10;
  const dh = st.door.h ?? 16;
  const door: Rect = { x: ox + st.door.x, y: base - dh, w: dw, h: dh };
  const windows = st.windows.map((win) => ({ x: ox + win.x, y: wallTop + win.y, w: win.w, h: win.h }));
  if (st.dormer?.window) {
    const cx = ox + st.dormer.x;
    windows.push({ x: cx - 3, y: top + st.roofH - 13, w: 6, h: 6 });
  }
  const chimney = st.chimney ? { x: ox + st.chimney.x + 3, y: 1 } : null;
  return {
    w,
    h,
    base,
    door,
    windows,
    chimney,
    foot: { x: ox - 1, y: base - Math.round(st.wallH * 0.55), w: st.w + 2, h: Math.round(st.wallH * 0.55) },
  };
}

export function paintHouse(st: HouseStyle): BuildingSprite {
  const spec = houseSpec(st);
  const { w, h, base } = spec;
  const { sprite, ctx } = newSprite(w, h);
  const top = st.chimney ? 8 : 2;
  const ox = PAD + EAVE;
  const wallTop = top + st.roofH;
  const buf = new PixBuf(w, h);

  // walls
  for (let y = wallTop; y < base; y++) {
    for (let x = ox; x < ox + st.w; x++) {
      const fromBottom = base - 1 - y;
      const c = fromBottom < 4 ? foundationPixel(x, fromBottom, st.seed) : wallPixel(st.wall.kind, st.wall.color, x - ox, y - wallTop, st.seed);
      buf.set(x, y, c);
    }
  }
  // roof: a gentle hip trapezoid with eaves overhanging the walls
  const inset = Math.min(7, Math.round(st.roofH * 0.28));
  for (let r = 0; r < st.roofH; r++) {
    const k = 1 - r / Math.max(1, st.roofH - 1);
    const x0 = Math.round(ox - EAVE + inset * k);
    const x1 = Math.round(ox + st.w + EAVE - inset * k);
    for (let x = x0; x < x1; x++) {
      let c = roofPixel(st.roof.kind, st.roof.color, x, r, st.roofH, st.seed);
      if (r === st.roofH - 1) c = shade(st.roof.color, -0.45); // fascia
      else if (x === x0 || x === x0 + 1) c = shade(c, 0.08);
      else if (x >= x1 - 2) c = shade(c, -0.12);
      buf.set(x, top + r, c);
    }
  }
  // ridge cap
  {
    const x0 = Math.round(ox - EAVE + inset);
    const x1 = Math.round(ox + st.w + EAVE - inset);
    for (let x = x0; x < x1; x++) {
      buf.set(x, top, shade(st.roof.color, -0.3));
      buf.set(x, top + 1, shade(st.roof.color, 0.22));
    }
  }
  // front dormer / cross gable
  if (st.dormer) {
    const cx = ox + st.dormer.x;
    const half = st.dormer.w / 2;
    const apexY = top + 2;
    const baseY = wallTop;
    for (let y = apexY; y < baseY; y++) {
      const t = (y - apexY) / (baseY - apexY);
      const outer = (half + 3) * t + 1;
      const innerT = (y - (apexY + 5)) / (baseY - (apexY + 5));
      const inner = innerT >= 0 ? (half - 1) * innerT : -1;
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        const d = Math.abs(x + 0.5 - cx);
        if (d > outer) continue;
        if (inner >= 0 && d <= inner) {
          buf.set(x, y, wallPixel(st.wall.kind === "logs" ? "planks" : st.wall.kind, st.wall.color, x - ox, y, st.seed));
        } else {
          const left = x + 0.5 < cx;
          const edgeRow = d > outer - 1.2;
          buf.set(x, y, edgeRow ? shade(st.roof.color, -0.45) : left ? shade(st.roof.color, 0.12) : shade(st.roof.color, -0.1));
        }
      }
    }
  }
  buf.flush(ctx);

  // shadow under the eaves
  ctx.fillStyle = "rgba(24,14,20,0.32)";
  ctx.fillRect(ox, wallTop, st.w, 3);
  ctx.fillStyle = "rgba(24,14,20,0.16)";
  ctx.fillRect(ox, wallTop + 3, st.w, 2);

  // timber framing
  if (st.wall.kind === "timber") {
    const beam = "#5a3a24";
    const bl = "#6e4a2e";
    const bottom = base - 4;
    rect(ctx, ox, wallTop + 1, st.w, 2, beam);
    rect(ctx, ox, bottom - 2, st.w, 2, beam);
    rect(ctx, ox, wallTop, 2, bottom - wallTop, beam);
    rect(ctx, ox + st.w - 2, wallTop, 2, bottom - wallTop, beam);
    const mid = wallTop + Math.round((bottom - wallTop) * 0.45);
    rect(ctx, ox, mid, st.w, 2, beam);
    for (let x = ox + 14; x < ox + st.w - 6; x += 14) {
      rect(ctx, x, wallTop, 2, bottom - wallTop, beam);
      line(ctx, x + 2, mid - 1, x + 12, wallTop + 3, bl);
    }
  }
  // log ends poking out at the corners
  if (st.wall.kind === "logs") {
    for (let y = wallTop + 2; y < base - 5; y += 5) {
      for (const x of [ox - 2, ox + st.w - 1]) {
        rect(ctx, x, y, 3, 4, shade(st.wall.color, 0.1));
        rect(ctx, x + 1, y + 1, 1, 2, shade(st.wall.color, -0.3));
      }
    }
  }
  // corner posts on plaster + planks
  if (st.wall.kind === "plaster" || st.wall.kind === "planks") {
    rect(ctx, ox, wallTop, 2, st.wallH - 4, shade(st.trim, -0.05));
    rect(ctx, ox + st.w - 2, wallTop, 2, st.wallH - 4, shade(st.trim, -0.25));
  }

  if (st.chimney) {
    const cx = ox + st.chimney.x;
    paintChimney(ctx, cx, 2, top + Math.round(st.roofH * 0.55), st.chimney.kind, st.seed);
  }

  for (let i = 0; i < st.windows.length; i++) {
    const win = st.windows[i];
    paintWindow(ctx, ox + win.x, wallTop + win.y, win.w, win.h, st.trim, win.shutters, win.box, st.seed + i * 7);
  }
  if (st.dormer?.window) {
    const cx = ox + st.dormer.x;
    const wy = top + st.roofH - 13;
    if (st.dormer.window === "round") {
      disk(ctx, cx, wy + 3, 4, shade(st.trim, -0.1));
      disk(ctx, cx, wy + 3, 3, "#33466a");
      rect(ctx, cx - 1, wy + 1, 1, 1, "#9fc2e2");
      rect(ctx, cx, wy, 1, 7, shade(st.trim, -0.1));
      rect(ctx, cx - 3, wy + 3, 7, 1, shade(st.trim, -0.1));
    } else {
      paintWindow(ctx, cx - 3, wy, 6, 6, st.trim);
    }
  }

  if (st.awning) {
    const a = st.awning;
    const ay = wallTop + 3;
    for (let x = 0; x < a.w; x++) {
      const stripe = Math.floor(x / 4) % 2 === 0 ? a.a : a.b;
      for (let y = 0; y < 8; y++) {
        let c = stripe;
        if (y === 0) c = shade(stripe, 0.18);
        if (y >= 5) c = shade(stripe, -0.14);
        rect(ctx, ox + a.x + x, ay + y, 1, 1, c);
      }
      if (x % 4 === 1 || x % 4 === 2) rect(ctx, ox + a.x + x, ay + 8, 1, 1, shade(stripe, -0.14));
    }
    ctx.fillStyle = "rgba(24,14,20,0.25)";
    ctx.fillRect(ox + a.x, ay + 9, a.w, 2);
  }
  if (st.sign) {
    const tw = textWidth(st.sign.text) + 8;
    const sx = ox + Math.round(st.w / 2 - tw / 2);
    const sy = wallTop - 6;
    rect(ctx, sx - 1, sy - 1, tw + 2, 13, "#3a2416");
    rect(ctx, sx, sy, tw, 11, "#7a5030");
    rect(ctx, sx, sy, tw, 1, "#9a6a3e");
    drawText(ctx, st.sign.text, sx + 4, sy + 2, st.sign.color);
  }

  const dw = st.door.w ?? 10;
  const dh = st.door.h ?? 16;
  paintDoor(ctx, ox + st.door.x, base - dh, dw, dh, st.door.color, st.trim, st.door.arched);

  if (st.porch) {
    const pr = st.porch;
    const py = base - dh - 7;
    const rc = shade(st.roof.color, -0.05);
    for (let x = -2; x < pr.w + 2; x++) {
      for (let y = 0; y < 5; y++) {
        const c = y === 4 ? shade(rc, -0.4) : y === 0 ? shade(rc, 0.2) : (x + y * 3) % 6 === 0 ? shade(rc, -0.18) : rc;
        rect(ctx, ox + pr.x + x, py + y, 1, 1, c);
      }
    }
    ctx.fillStyle = "rgba(24,14,20,0.25)";
    ctx.fillRect(ox + pr.x, py + 5, pr.w, 2);
    for (const px2 of [ox + pr.x, ox + pr.x + pr.w - 2]) {
      rect(ctx, px2, py + 5, 2, base - py - 5, st.trim);
      rect(ctx, px2 + 1, py + 5, 1, base - py - 5, shade(st.trim, -0.2));
    }
  }

  outlineSprite(ctx, w, h, OUTLINE);
  return { canvas: sprite.canvas, w, h, windows: spec.windows, chimney: spec.chimney };
}

// --- barn (front gable, gambrel) ----------------------------------------------------

export const BARN_SPEC: BuildingSpec = {
  w: 108,
  h: 96,
  base: 90,
  door: { x: 37, y: 52, w: 34, h: 38 },
  windows: [
    { x: 14, y: 58, w: 10, h: 8 },
    { x: 84, y: 58, w: 10, h: 8 },
  ],
  chimney: null,
  foot: { x: 5, y: 60, w: 98, h: 30 },
};

export function paintBarn(): BuildingSprite {
  const { w, h, base } = BARN_SPEC;
  const { sprite, ctx } = newSprite(w, h);
  const red = "#b0443a";
  const white = "#ece2cf";
  const roof = "#5d5a66";
  const face: Array<[number, number]> = [
    [6, 48],
    [18, 28],
    [54, 10],
    [90, 28],
    [102, 48],
    [102, base],
    [6, base],
  ];
  const outer: Array<[number, number]> = [
    [1, 50],
    [13, 25],
    [54, 3],
    [95, 25],
    [107, 50],
    [101, 50],
    [90, 30],
    [54, 12],
    [18, 30],
    [7, 50],
  ];
  // face boards
  const buf = new PixBuf(w, h);
  for (let y = 0; y < base; y++) {
    for (let x = 0; x < w; x++) {
      const fromBottom = base - 1 - y;
      const c =
        fromBottom < 4
          ? foundationPixel(x, fromBottom, 3)
          : (x % 5 === 0 ? shade(red, -0.25) : hash2(x, y >> 2, 9) < 0.08 ? shade(red, -0.12) : x % 5 === 1 ? shade(red, 0.08) : red);
      buf.set(x, y, c);
    }
  }
  const tmp = newSprite(w, h);
  buf.flush(tmp.ctx);
  // clip boards to the gambrel face
  ctx.save();
  ctx.beginPath();
  face.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(tmp.sprite.canvas, 0, 0);
  ctx.restore();
  // re-square the clipped edge (clip can anti-alias): repaint the face polygon's
  // outer ring as board colour so the outline pass sees hard pixels
  const imgd = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < imgd.data.length; i += 4) imgd.data[i] = imgd.data[i] > 100 ? 255 : 0;
  ctx.putImageData(imgd, 0, 0);

  // roof band along the gambrel
  poly(ctx, outer, roof);
  {
    const band = ctx.getImageData(0, 0, w, 52).data;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < 52; y++) {
        const i = (y * w + x) * 4;
        if (band[i] === 0x5d && band[i + 1] === 0x5a && band[i + 2] === 0x66 && (x + y) % 4 === 0) rect(ctx, x, y, 1, 1, shade(roof, -0.2));
      }
    }
  }
  line(ctx, 13, 25, 54, 3, shade(roof, 0.3));
  line(ctx, 1, 50, 13, 25, shade(roof, 0.2));
  // shadow under the roof band
  ctx.fillStyle = "rgba(24,14,20,0.3)";
  for (let x = 7; x < 101; x++) {
    const yEdge = x < 18 ? 48 - ((x - 6) / 12) * 20 : x < 54 ? 28 - ((x - 18) / 36) * 18 : x < 90 ? 10 + ((x - 54) / 36) * 18 : 28 + ((x - 90) / 12) * 20;
    ctx.fillRect(x, Math.round(yEdge) + 1, 1, 3);
  }
  // white trim: corners and belt
  rect(ctx, 6, 48, 3, base - 52, white);
  rect(ctx, 99, 48, 3, base - 52, shade(white, -0.15));
  rect(ctx, 6, 47, 96, 2, white);
  rect(ctx, 6, 49, 96, 1, shade(white, -0.3));
  // hayloft door
  rect(ctx, 44, 22, 20, 18, white);
  rect(ctx, 46, 24, 16, 14, "#5a2a22");
  line(ctx, 46, 24, 61, 37, white);
  line(ctx, 61, 24, 46, 37, white);
  rect(ctx, 52, 16, 4, 6, "#4a4550");
  rect(ctx, 53, 18, 2, 6, "#6a6570");
  // main doors
  const d = BARN_SPEC.door!;
  rect(ctx, d.x - 2, d.y - 2, d.w + 4, d.h + 2, white);
  for (const lx of [d.x, d.x + d.w / 2 + 1]) {
    const lw = d.w / 2 - 1;
    rect(ctx, lx, d.y, lw, d.h, "#8e3a30");
    for (let x = lx + 2; x < lx + lw; x += 3) rect(ctx, x, d.y, 1, d.h, "#722c25");
    rect(ctx, lx, d.y, lw, 2, white);
    rect(ctx, lx, d.y + d.h - 2, lw, 2, white);
    rect(ctx, lx, d.y, 2, d.h, white);
    rect(ctx, lx + lw - 2, d.y, 2, d.h, white);
    line(ctx, lx + 1, d.y + 1, lx + lw - 2, d.y + d.h - 2, white);
    line(ctx, lx + lw - 2, d.y + 1, lx + 1, d.y + d.h - 2, white);
  }
  rect(ctx, d.x - 4, d.y - 5, d.w + 8, 3, "#4a4550");
  for (const win of BARN_SPEC.windows) paintWindow(ctx, win.x, win.y, win.w, win.h, white);
  // dirt ramp in front of the doors
  rect(ctx, d.x - 3, base, d.w + 6, 3, "#8a6a44");
  rect(ctx, d.x - 3, base, d.w + 6, 1, "#a8845a");
  outlineSprite(ctx, w, h, OUTLINE);
  return { canvas: sprite.canvas, w, h, windows: BARN_SPEC.windows, chimney: null };
}

// --- silo ---------------------------------------------------------------------------

export const SILO_SPEC: BuildingSpec = {
  w: 34,
  h: 92,
  base: 88,
  door: { x: 11, y: 72, w: 11, h: 16 },
  windows: [],
  chimney: null,
  foot: { x: 4, y: 76, w: 26, h: 12 },
  gauge: { x: 13, y: 30, w: 6, h: 34 },
};

export function paintSilo(): BuildingSprite {
  const { w, h, base } = SILO_SPEC;
  const { sprite, ctx } = newSprite(w, h);
  const cols = ["#dcd8d2", "#cfcac3", "#c2bdb6", "#b4afa8", "#a39e98", "#8f8a85"];
  for (let x = 4; x < 30; x++) {
    const t = (x - 4) / 25;
    const c = cols[Math.min(cols.length - 1, Math.floor(Math.abs(t - 0.22) * 1.6 * cols.length))];
    rect(ctx, x, 22, 1, base - 22, c);
  }
  for (let y = 30; y < base - 4; y += 11) {
    for (let x = 4; x < 30; x++) {
      rect(ctx, x, y, 1, 1, "#7b7672");
      rect(ctx, x, y + 1, 1, 1, "#e6e2dc");
    }
  }
  for (let y = base - 4; y < base; y++) {
    for (let x = 3; x < 31; x++) rect(ctx, x, y, 1, 1, foundationPixel(x, base - 1 - y, 5));
  }
  // dome (upper half only)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, 23);
  ctx.clip();
  ellipse(ctx, 17, 22, 13, 13, "#8a3a34");
  ellipse(ctx, 16, 21, 12, 12, "#b0463e");
  ellipse(ctx, 14, 18, 8, 8, "#c85a4c");
  ellipse(ctx, 11, 14, 3, 3, "#e0806a");
  ctx.restore();
  rect(ctx, 3, 22, 28, 2, "#6e2e28");
  rect(ctx, 16, 8, 2, 3, "#6e2e28");
  // gauge slot (filled live by the renderer)
  const g = SILO_SPEC.gauge!;
  rect(ctx, g.x - 1, g.y - 1, g.w + 2, g.h + 2, "#5a5652");
  rect(ctx, g.x, g.y, g.w, g.h, "#2c2a2e");
  // ladder
  for (let y = 26; y < base - 4; y++) {
    rect(ctx, 24, y, 1, 1, "#6a6560");
    rect(ctx, 27, y, 1, 1, "#6a6560");
    if (y % 3 === 0) rect(ctx, 24, y, 4, 1, "#7a7570");
  }
  const sd = SILO_SPEC.door!;
  paintDoor(ctx, sd.x, sd.y, sd.w, sd.h, "#6a4a3a", "#8f8a85", true);
  outlineSprite(ctx, w, h, OUTLINE);
  return { canvas: sprite.canvas, w, h, windows: [], chimney: null };
}

// --- windmill -----------------------------------------------------------------------

export const WINDMILL_SPEC: BuildingSpec = {
  w: 56,
  h: 104,
  base: 100,
  door: { x: 22, y: 82, w: 12, h: 18 },
  windows: [
    { x: 25, y: 62, w: 6, h: 8 },
    { x: 25, y: 44, w: 5, h: 6 },
  ],
  chimney: null,
  foot: { x: 8, y: 80, w: 40, h: 20 },
  hub: { x: 28, y: 30 },
};

export function paintWindmill(): BuildingSprite {
  const { w, h, base } = WINDMILL_SPEC;
  const { sprite, ctx } = newSprite(w, h);
  const cx = 28;
  const topY = 28;
  const shingle = "#9a6a42";
  // tapered, shingled tower with cylindrical shading
  for (let y = topY; y < base; y++) {
    const t = (y - topY) / (base - topY);
    const half = Math.round(11 + t * 9);
    for (let x = cx - half; x < cx + half; x++) {
      const u = (x - (cx - half)) / (2 * half);
      const fromBottom = base - 1 - y;
      let c: string;
      if (fromBottom < 12) {
        c = foundationPixel(x, fromBottom, 21);
      } else {
        const r = y - topY;
        c = roofPixel("shingle", shingle, x, r, 100, 5);
        if (u < 0.2) c = shade(c, 0.12);
        else if (u > 0.8) c = shade(c, -0.28);
        else if (u > 0.62) c = shade(c, -0.12);
      }
      rect(ctx, x, y, 1, 1, c);
    }
  }
  rect(ctx, cx - 20, base - 13, 40, 1, "#c8c2c4");
  // cap: domed wooden roof sitting on a ring
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, topY + 1);
  ctx.clip();
  const cap = "#6e4a8a";
  ellipse(ctx, cx, topY + 1, 15, 17, shade(cap, -0.3));
  ellipse(ctx, cx - 1, topY + 1, 14, 16, cap);
  ellipse(ctx, cx - 4, topY - 3, 8, 10, shade(cap, 0.14));
  ellipse(ctx, cx - 6, topY - 8, 3, 4, shade(cap, 0.32));
  ctx.restore();
  {
    const capPx = ctx.getImageData(0, 0, w, topY).data;
    for (let y = topY - 14; y < topY; y += 4) {
      for (let x = cx - 15; x <= cx + 15; x++) {
        if (capPx[(y * w + x) * 4 + 3] > 0 && (x + y) % 6 !== 0) rect(ctx, x, y, 1, 1, shade(cap, -0.22));
      }
    }
  }
  rect(ctx, cx, topY - 19, 1, 4, "#4a3a2a");
  rect(ctx, cx - 1, topY - 19, 3, 1, "#4a3a2a");
  rect(ctx, cx - 16, topY, 32, 3, "#5a3920");
  rect(ctx, cx - 16, topY, 32, 1, "#7a5030");
  ctx.fillStyle = "rgba(24,14,20,0.3)";
  ctx.fillRect(cx - 11, topY + 3, 22, 2);
  for (const win of WINDMILL_SPEC.windows) paintWindow(ctx, win.x, win.y, win.w, win.h, "#e8dcc0");
  const d = WINDMILL_SPEC.door!;
  paintDoor(ctx, d.x, d.y, d.w, d.h, "#6a3a24", "#e8dcc0", true);
  outlineSprite(ctx, w, h, OUTLINE);
  return { canvas: sprite.canvas, w, h, windows: WINDMILL_SPEC.windows, chimney: null };
}

// Rotating sails, rasterised per frame by inverse rotation so every frame stays
// hard-edged. 4-fold symmetric, so `frames` cover a quarter turn.
export function paintWindmillSails(frames: number): Sprite[] {
  const size = 84;
  const c = size / 2;
  const out: Sprite[] = [];
  const cloth = "#f2e8d0";
  const clothD = "#d8caa8";
  const wood = "#6b4426";
  const woodL = "#8a5a33";
  const bladeAt = (u: number, v: number): string | null => {
    // u: distance along the arm, v: across (spar at 0, sail on +v side)
    if (u < 3 || u > 35) return null;
    if (v >= -1 && v <= 0.5) return u > 33 ? wood : woodL;
    if (u >= 10 && u <= 34 && v > 0.5 && v <= 8.5) {
      const edge = v > 7.5 || u < 11 || u > 33;
      if (edge) return wood;
      if (Math.floor(u) % 5 === 0) return wood;
      return v > 5.5 ? clothD : cloth;
    }
    return null;
  };
  for (let f = 0; f < frames; f++) {
    const theta = (f / frames) * (Math.PI / 2);
    const { sprite, ctx } = newSprite(size, size);
    const buf = new PixBuf(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - c;
        const dy = y + 0.5 - c;
        let col: string | null = null;
        for (let k = 0; k < 4 && !col; k++) {
          const a = theta + (k * Math.PI) / 2;
          const u = dx * Math.cos(a) + dy * Math.sin(a);
          const v = -dx * Math.sin(a) + dy * Math.cos(a);
          col = bladeAt(u, v);
        }
        if (col) buf.set(x, y, col);
      }
    }
    buf.flush(ctx);
    disk(ctx, c, c, 4, "#4a2a20");
    disk(ctx, c, c, 3, "#8a5a33");
    rect(ctx, c - 1, c - 1, 1, 1, "#c89060");
    outlineSprite(ctx, size, size, OUTLINE);
    out.push(sprite);
  }
  return out;
}

// --- well -------------------------------------------------------------------------------

export const WELL_SPEC: BuildingSpec = {
  w: 36,
  h: 44,
  base: 41,
  door: null,
  windows: [],
  chimney: null,
  foot: { x: 5, y: 30, w: 26, h: 11 },
};

export function paintWell(): BuildingSprite {
  const { w, h } = WELL_SPEC;
  const { sprite, ctx } = newSprite(w, h);
  // posts
  rect(ctx, 5, 10, 3, 22, "#6b4426");
  rect(ctx, 28, 10, 3, 22, "#5a3920");
  rect(ctx, 6, 10, 1, 22, "#8a5a33");
  // crank bar + rope + bucket
  rect(ctx, 7, 15, 22, 2, "#5a3920");
  rect(ctx, 30, 14, 3, 1, "#8a5a33");
  rect(ctx, 32, 14, 1, 4, "#8a5a33");
  rect(ctx, 17, 17, 1, 7, "#d8c188");
  rect(ctx, 14, 23, 7, 5, "#7a5030");
  rect(ctx, 14, 23, 7, 1, "#9a6a3e");
  rect(ctx, 14, 25, 7, 1, "#4e4a52");
  // stone ring
  ellipse(ctx, 18, 30, 14, 6, "#8d8a90");
  rect(ctx, 4, 30, 29, 9, "#8d8a90");
  for (let y = 30; y < 39; y++) {
    for (let x = 4; x < 33; x++) {
      const c = wallPixel("stone", "#9a969c", x, y + 2, 12);
      rect(ctx, x, y, 1, 1, c);
    }
  }
  ellipse(ctx, 18, 30, 11, 4, "#b3aeb0");
  ellipse(ctx, 18, 30, 9, 3, "#1a2438");
  rect(ctx, 13, 30, 6, 1, "#3e6aa0");
  ellipse(ctx, 18, 39, 14, 2, "#6e6a70");
  // roof
  const roofC = "#4a6fb0";
  for (let r = 0; r < 10; r++) {
    const half = 9 + r;
    for (let x = 18 - half; x < 18 + half; x++) {
      rect(ctx, x, 1 + r, 1, 1, r === 9 ? shade(roofC, -0.45) : roofPixel("shingle", roofC, x, r, 10, 4));
    }
  }
  outlineSprite(ctx, w, h, OUTLINE);
  return { canvas: sprite.canvas, w, h, windows: [], chimney: null };
}

// --- greenhouse ---------------------------------------------------------------------

export const GREENHOUSE_SPEC: BuildingSpec = {
  w: 100,
  h: 84,
  base: 80,
  door: { x: 43, y: 56, w: 14, h: 24 },
  windows: [],
  chimney: null,
  foot: { x: 4, y: 58, w: 92, h: 22 },
};

export function paintGreenhouse(): BuildingSprite {
  const { w, h, base } = GREENHOUSE_SPEC;
  const { sprite, ctx } = newSprite(w, h);
  const frame = "#e9eee9";
  const frameD = "#aeb8b4";
  const face: Array<[number, number]> = [
    [4, 40],
    [50, 6],
    [96, 40],
    [96, base],
    [4, base],
  ];
  poly(ctx, face, "#8cc7cf");
  // plants inside, seen through the glass
  const rng = mulberry32(77);
  for (let i = 0; i < 40; i++) {
    const x = 8 + rng() * 84;
    const y = 50 + rng() * 22;
    ellipse(ctx, x, y, 3 + rng() * 4, 2 + rng() * 3, rng() < 0.5 ? "#4f8f63" : "#62a36b");
    if (rng() < 0.35) rect(ctx, x, y - 1, 1, 1, rng() < 0.5 ? "#e86a6a" : "#f2cf4f");
  }
  ctx.save();
  ctx.globalAlpha = 0.45;
  poly(ctx, face, "#a7dbe0");
  ctx.restore();
  // reflections
  for (let i = 0; i < 8; i++) {
    const x0 = 8 + i * 11;
    line(ctx, x0, 76, x0 + 8, 44, "#d8f2f2");
  }
  // mullions and gable frame
  for (let x = 4; x <= 96; x += 11) {
    const topY = x < 50 ? 40 - ((x - 4) / 46) * 34 : 6 + ((x - 50) / 46) * 34;
    rect(ctx, x, Math.round(topY), 2, base - Math.round(topY), frame);
    rect(ctx, x + 1, Math.round(topY), 1, base - Math.round(topY), frameD);
  }
  rect(ctx, 4, 40, 92, 2, frame);
  rect(ctx, 4, 58, 92, 2, frame);
  line(ctx, 3, 40, 50, 5, frame);
  line(ctx, 4, 41, 50, 6, frame);
  line(ctx, 50, 5, 97, 40, frameD);
  line(ctx, 50, 6, 96, 41, frame);
  for (let y = base - 4; y < base; y++) {
    for (let x = 4; x < 96; x++) rect(ctx, x, y, 1, 1, foundationPixel(x, base - 1 - y, 8));
  }
  const d = GREENHOUSE_SPEC.door!;
  rect(ctx, d.x - 1, d.y - 1, d.w + 2, d.h + 1, frame);
  rect(ctx, d.x, d.y, d.w, d.h, "#7fbac2");
  rect(ctx, d.x + d.w / 2, d.y, 1, d.h, frame);
  line(ctx, d.x + 1, d.y + d.h - 3, d.x + 5, d.y + 3, "#d8f2f2");
  rect(ctx, d.x - 2, d.y + d.h, d.w + 4, 2, "#a6a0a4");
  outlineSprite(ctx, w, h, OUTLINE);
  return { canvas: sprite.canvas, w, h, windows: [], chimney: null };
}

// --- fountain ----------------------------------------------------------------------

export const FOUNTAIN_SPEC: BuildingSpec = {
  w: 60,
  h: 44,
  base: 38,
  door: null,
  windows: [],
  chimney: null,
  foot: { x: 4, y: 20, w: 52, h: 18 },
};

export function paintFountain(): BuildingSprite {
  const { w, h } = FOUNTAIN_SPEC;
  const { sprite, ctx } = newSprite(w, h);
  // basin wall
  ellipse(ctx, 30, 34, 27, 8, "#6e6a70");
  rect(ctx, 3, 26, 54, 8, "#8d8a90");
  for (let y = 26; y < 34; y++) for (let x = 3; x < 57; x++) rect(ctx, x, y, 1, 1, wallPixel("stone", "#a39ea4", x, y, 30));
  ellipse(ctx, 30, 26, 27, 9, "#c8c2c4");
  ellipse(ctx, 30, 26, 24, 7, "#9d989c");
  ellipse(ctx, 30, 26, 22, 6, "#3f7fb8");
  ellipse(ctx, 30, 27, 18, 4, "#4f94cc");
  // pedestal + bowl
  rect(ctx, 27, 10, 6, 17, "#a39ea4");
  rect(ctx, 27, 10, 2, 17, "#c8c2c4");
  rect(ctx, 32, 10, 1, 17, "#6e6a70");
  ellipse(ctx, 30, 11, 9, 3, "#c8c2c4");
  ellipse(ctx, 30, 11, 7, 2, "#4f94cc");
  rect(ctx, 29, 5, 2, 6, "#a39ea4");
  disk(ctx, 30, 5, 2, "#c8c2c4");
  outlineSprite(ctx, w, h, OUTLINE);
  return { canvas: sprite.canvas, w, h, windows: [], chimney: null };
}

// --- styles ---------------------------------------------------------------------------

const FLOWERS = ["#e0507a", "#f2cf4f", "#f08a4b", "#b77ee0", "#f2f2ea"];

export const FARMHOUSE_STYLE: HouseStyle = {
  w: 104,
  wallH: 40,
  roofH: 36,
  roof: { kind: "scallop", color: "#b8483c" },
  wall: { kind: "planks", color: "#d2a068" },
  trim: "#efe6d2",
  door: { x: 47, w: 12, h: 18, color: "#7a3e26" },
  windows: [
    { x: 14, y: 11, w: 12, h: 10, shutters: "#4f7a4a", box: FLOWERS[0] },
    { x: 78, y: 11, w: 12, h: 10, shutters: "#4f7a4a", box: FLOWERS[1] },
  ],
  chimney: { x: 80, kind: "stone" },
  dormer: { x: 53, w: 26, window: "round" },
  porch: { x: 39, w: 28 },
  seed: 3,
};

export const COOP_STYLE: HouseStyle = {
  w: 60,
  wallH: 26,
  roofH: 20,
  roof: { kind: "shingle", color: "#5f8f4a" },
  wall: { kind: "planks", color: "#b88a55" },
  trim: "#e0d4b8",
  door: { x: 8, w: 10, h: 16, color: "#6b4426" },
  windows: [{ x: 38, y: 6, w: 8, h: 7 }],
  seed: 9,
};

export const STORE_STYLE: HouseStyle = {
  w: 92,
  wallH: 38,
  roofH: 30,
  roof: { kind: "slate", color: "#4d5f7a" },
  wall: { kind: "planks", color: "#8fb0c2" },
  trim: "#f2ece0",
  door: { x: 41, w: 12, h: 18, color: "#6a3a28" },
  windows: [
    { x: 10, y: 16, w: 18, h: 11 },
    { x: 64, y: 16, w: 18, h: 11 },
  ],
  chimney: { x: 12, kind: "brick" },
  awning: { a: "#c9483c", b: "#f2ece0", x: 4, w: 84 },
  sign: { text: "STORE", color: "#f2e0b0" },
  seed: 41,
};

// Village houses: one per tracked country slot. Varied materials so the
// village never reads as copy-paste.
export const HOUSE_STYLES: HouseStyle[] = [
  {
    w: 60, wallH: 30, roofH: 26, roof: { kind: "shingle", color: "#4a6fb0" }, wall: { kind: "plaster", color: "#efe3c6" },
    trim: "#f6f0e2", door: { x: 10, color: "#6a3a28" }, windows: [{ x: 34, y: 8, w: 10, h: 9, shutters: "#3d5a8f", box: FLOWERS[0] }],
    chimney: { x: 44, kind: "brick" }, seed: 101,
  },
  {
    w: 64, wallH: 30, roofH: 28, roof: { kind: "scallop", color: "#b5453a" }, wall: { kind: "planks", color: "#9fbf8a" },
    trim: "#f2ecd8", door: { x: 27, color: "#7a4a2a" }, windows: [{ x: 8, y: 9, w: 10, h: 8, box: FLOWERS[1] }, { x: 46, y: 9, w: 10, h: 8, box: FLOWERS[4] }],
    dormer: { x: 32, w: 20, window: "square" }, seed: 102,
  },
  {
    w: 58, wallH: 30, roofH: 26, roof: { kind: "slate", color: "#5a6478" }, wall: { kind: "stone", color: "#a8a2a0" },
    trim: "#d8d0c4", door: { x: 8, color: "#5a3a26", arched: true }, windows: [{ x: 34, y: 9, w: 10, h: 9, shutters: "#8a4a3a" }],
    chimney: { x: 40, kind: "stone" }, seed: 103,
  },
  {
    w: 62, wallH: 30, roofH: 26, roof: { kind: "thatch", color: "#d4ad58" }, wall: { kind: "logs", color: "#9a6a3e" },
    trim: "#caa878", door: { x: 26, color: "#5a3920" }, windows: [{ x: 8, y: 9, w: 9, h: 8, box: FLOWERS[2] }, { x: 45, y: 9, w: 9, h: 8, box: FLOWERS[0] }],
    seed: 104,
  },
  {
    w: 66, wallH: 32, roofH: 26, roof: { kind: "shingle", color: "#3f7a4a" }, wall: { kind: "brick", color: "#b5634a" },
    trim: "#efe6d2", door: { x: 28, color: "#3d4a6a" }, windows: [{ x: 8, y: 9, w: 10, h: 9 }, { x: 48, y: 9, w: 10, h: 9 }],
    porch: { x: 22, w: 22 }, chimney: { x: 10, kind: "brick" }, seed: 105,
  },
  {
    w: 60, wallH: 30, roofH: 28, roof: { kind: "scallop", color: "#d0763a" }, wall: { kind: "timber", color: "#efe6cf" },
    trim: "#efe6d2", door: { x: 38, color: "#6a3a28" }, windows: [{ x: 12, y: 9, w: 10, h: 9, box: FLOWERS[3] }],
    dormer: { x: 20, w: 18, window: "round" }, seed: 106,
  },
  {
    w: 56, wallH: 28, roofH: 24, roof: { kind: "slate", color: "#7a5a9a" }, wall: { kind: "plaster", color: "#f0c8c0" },
    trim: "#fbf2ea", door: { x: 9, color: "#5a4a7a" }, windows: [{ x: 32, y: 8, w: 10, h: 9, shutters: "#8a6aa8", box: FLOWERS[4] }],
    chimney: { x: 38, kind: "brick" }, seed: 107,
  },
  {
    w: 64, wallH: 30, roofH: 28, roof: { kind: "shingle", color: "#2f8a8a" }, wall: { kind: "planks", color: "#eeeae0" },
    trim: "#f6f2ea", door: { x: 27, color: "#2f6a6a" }, windows: [{ x: 8, y: 9, w: 10, h: 9, shutters: "#2f7a7a" }, { x: 46, y: 9, w: 10, h: 9, shutters: "#2f7a7a" }],
    dormer: { x: 32, w: 20, window: "round" }, seed: 108,
  },
  {
    w: 62, wallH: 30, roofH: 26, roof: { kind: "shingle", color: "#a83a3a" }, wall: { kind: "stone", color: "#b8ae9e" },
    trim: "#e8e0d0", door: { x: 26, color: "#6a4a2a" }, windows: [{ x: 8, y: 9, w: 9, h: 8, box: FLOWERS[1] }, { x: 45, y: 9, w: 9, h: 8, box: FLOWERS[0] }],
    porch: { x: 20, w: 22 }, seed: 109,
  },
  {
    w: 58, wallH: 28, roofH: 26, roof: { kind: "tin", color: "#6a8a6a" }, wall: { kind: "logs", color: "#8a5a36" },
    trim: "#c8a070", door: { x: 8, color: "#4a3020" }, windows: [{ x: 34, y: 8, w: 10, h: 9, box: FLOWERS[2] }],
    chimney: { x: 42, kind: "stone" }, seed: 110,
  },
  {
    w: 66, wallH: 32, roofH: 26, roof: { kind: "slate", color: "#4a5268" }, wall: { kind: "brick", color: "#9a4a3c" },
    trim: "#efe6d2", door: { x: 28, color: "#2e3a5a", arched: true }, windows: [{ x: 8, y: 9, w: 10, h: 10, shutters: "#2e3a5a" }, { x: 48, y: 9, w: 10, h: 10, shutters: "#2e3a5a" }],
    seed: 111,
  },
  {
    w: 60, wallH: 30, roofH: 28, roof: { kind: "scallop", color: "#3f68a8" }, wall: { kind: "plaster", color: "#f2dc8a" },
    trim: "#fbf4e2", door: { x: 38, color: "#6a3a28" }, windows: [{ x: 10, y: 9, w: 10, h: 9, box: FLOWERS[0] }],
    dormer: { x: 20, w: 18, window: "square" }, chimney: { x: 44, kind: "brick" }, seed: 112,
  },
  {
    w: 62, wallH: 30, roofH: 26, roof: { kind: "shingle", color: "#7a5236" }, wall: { kind: "planks", color: "#6f93b8" },
    trim: "#f2ece0", door: { x: 26, color: "#f2ece0" }, windows: [{ x: 8, y: 9, w: 9, h: 8, shutters: "#f2ece0" }, { x: 46, y: 9, w: 9, h: 8, shutters: "#f2ece0" }],
    seed: 113,
  },
  {
    w: 58, wallH: 30, roofH: 28, roof: { kind: "thatch", color: "#c89a4a" }, wall: { kind: "timber", color: "#f0e8d4" },
    trim: "#efe6d2", door: { x: 8, color: "#5a3920", arched: true }, windows: [{ x: 34, y: 9, w: 10, h: 9, box: FLOWERS[3] }],
    chimney: { x: 40, kind: "stone" }, seed: 114,
  },
];

// every building the map can place, by id
export function buildingSpec(id: string): BuildingSpec {
  switch (id) {
    case "farmhouse":
      return houseSpec(FARMHOUSE_STYLE);
    case "coop":
      return houseSpec(COOP_STYLE);
    case "store":
      return houseSpec(STORE_STYLE);
    case "barn":
      return BARN_SPEC;
    case "silo":
      return SILO_SPEC;
    case "windmill":
      return WINDMILL_SPEC;
    case "well":
      return WELL_SPEC;
    case "greenhouse":
      return GREENHOUSE_SPEC;
    case "fountain":
      return FOUNTAIN_SPEC;
    default: {
      const idx = Number(id.replace("house", ""));
      return houseSpec(HOUSE_STYLES[idx % HOUSE_STYLES.length]);
    }
  }
}

export function paintBuilding(id: string): BuildingSprite {
  switch (id) {
    case "farmhouse":
      return paintHouse(FARMHOUSE_STYLE);
    case "coop":
      return paintHouse(COOP_STYLE);
    case "store":
      return paintHouse(STORE_STYLE);
    case "barn":
      return paintBarn();
    case "silo":
      return paintSilo();
    case "windmill":
      return paintWindmill();
    case "well":
      return paintWell();
    case "greenhouse":
      return paintGreenhouse();
    case "fountain":
      return paintFountain();
    default: {
      const idx = Number(id.replace("house", ""));
      return paintHouse(HOUSE_STYLES[idx % HOUSE_STYLES.length]);
    }
  }
}

// a checker dither helper for soft ground shadows (exported for the renderer)
export function ditherAlpha(x: number, y: number, a: number): boolean {
  return bayer(x, y) < a;
}
