// Enterable building interiors. Each room is a small self-contained scene in
// the same outlined, top-lit pixel style as the outdoors: a tall back wall
// with wallpaper, windows and decor, a textured floor, and furniture painted
// once as outlined sprites. Props that mirror backend status (fire, crates,
// hay, roosting chickens, eggs, millstone, flour sacks, grain, plants, the
// resident) are drawn live on top. Rooms live in their own VIEW-sized scene;
// the world-side door definitions live here too.

import { C, TILE, VIEW_W, VIEW_H, clamp, mulberry32, shade, type Ctx, type Sprite } from "./core";
import { drawText, textWidth } from "./font";
import { OUTLINE, disk, ellipse, hash2, line, newSprite, outlineSprite, rect } from "./paint";
import type { Rect, ValleySprites } from "./sprites";
import type { Hotspot, ValleyMap } from "./map";
import type { ValleySim } from "./sim";

export const WALL_H = 42; // back-wall face height
const SIDE = 6; // side/bottom wall thickness seen from above
const VOID = "#07060a";

export interface InteriorDrawable {
  baseline: number;
  draw: (ctx: Ctx) => void;
}

export interface DoorDef {
  id: string; // matches the interior id
  rect: Rect; // clickable door area (world px)
  trigger: Rect; // feet zone that starts the enter transition
  outside: { x: number; y: number }; // where the player reappears on exit
}

interface Glow {
  x: number;
  y: number;
  r: number;
  color: string;
  a: number;
}

export interface Interior {
  id: string;
  label: string;
  floor: Rect; // walkable area
  exit: Rect; // mat that leads back outside
  spawn: { x: number; y: number };
  hotspots: Hotspot[];
  solids: Rect[];
  dynamicHotspots?: (sim: ValleySim) => Hotspot[];
  drawBase: (ctx: Ctx, sim: ValleySim, s: ValleySprites, hour: number) => void;
  drawables: (sim: ValleySim, s: ValleySprites) => InteriorDrawable[];
  drawOverlay: (ctx: Ctx, sim: ValleySim, s: ValleySprites, hour: number) => void;
}

// ---------------------------------------------------------------------------
// Doors (world side), taken from each building's painted door geometry. Every
// building with a door has a room behind it.

export function buildDoors(map: ValleyMap): DoorDef[] {
  const doors: DoorDef[] = [];
  for (const b of map.buildings) {
    const d = b.spec.door;
    if (!d) continue;
    const ground = b.y + b.spec.base;
    doors.push({
      id: b.key,
      rect: { x: b.x + d.x - 1, y: b.y + d.y - 2, w: d.w + 2, h: d.h + 8 },
      trigger: { x: b.x + d.x, y: ground + 1, w: d.w, h: 6 },
      outside: { x: b.x + d.x + d.w / 2, y: ground + 10 },
    });
  }
  return doors;
}

export function interiorSolidAt(int: Interior, x: number, y: number): boolean {
  const f = int.floor;
  if (x < f.x + 3 || x > f.x + f.w - 3 || y < f.y + 3 || y > f.y + f.h - 2) return true;
  for (const r of int.solids) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Geometry helpers

function roomRect(wTiles: number, hTiles: number): Rect {
  const w = wTiles * TILE;
  const h = hTiles * TILE;
  return { x: Math.round((VIEW_W - w) / 2), y: Math.round((VIEW_H - h + WALL_H) / 2), w, h };
}

function exitFor(f: Rect): Rect {
  return { x: f.x + f.w / 2 - 11, y: f.y + f.h - 8, w: 22, h: 8 };
}

function spawnFor(f: Rect): { x: number; y: number } {
  return { x: f.x + f.w / 2, y: f.y + f.h - 16 };
}

// 0 = day, 1 = night; roughly tracks the outdoor sky tint keyframes.
function nightAmount(hour: number): number {
  if (hour >= 21 || hour < 5) return 1;
  if (hour >= 18.5) return (hour - 18.5) / 2.5;
  if (hour < 6.7) return 1 - (hour - 5) / 1.7;
  return 0;
}

// ---------------------------------------------------------------------------
// Furniture kit: painted once, outlined like every outdoor sprite

interface Kit {
  bed: Sprite[]; // by blanket colour
  bookshelf: Sprite[];
  fireplace: Sprite;
  table: Sprite;
  smallTable: Sprite;
  chair: Sprite;
  chairSide: Sprite;
  dresser: Sprite;
  plant: Sprite;
  tallPlant: Sprite;
  crate: Sprite;
  barrel: Sprite;
  sack: Sprite;
  trough: Sprite;
  nestRow: Sprite;
  stall: Sprite;
  toolRack: Sprite;
  stove: Sprite;
  hopper: Sprite;
  stairs: Sprite;
  cat: Sprite[];
  counter: Sprite;
  goodsShelf: Sprite[];
  planter: Sprite;
  seedling: Sprite[]; // healthy growth stages + wilted
  wateringCan: Sprite;
}

const BLANKETS = ["#4a6fb0", "#b5453a", "#4f8a4a", "#8a5aa8", "#d0763a", "#2f8a8a"];
let kitCache: Kit | null = null;

function woodBox(ctx: Ctx, x: number, y: number, w: number, h: number, base: string): void {
  rect(ctx, x, y, w, h, base);
  rect(ctx, x, y, w, 1, shade(base, 0.22));
  rect(ctx, x + w - 1, y, 1, h, shade(base, -0.25));
  rect(ctx, x, y + h - 1, w, 1, shade(base, -0.35));
}

function paintBed(blanket: string): Sprite {
  const { sprite, ctx } = newSprite(28, 42);
  woodBox(ctx, 1, 1, 26, 10, "#7a4a2a");
  rect(ctx, 4, 3, 20, 5, "#8e5a34");
  rect(ctx, 4, 3, 20, 1, "#a8703f");
  rect(ctx, 1, 1, 3, 13, "#6a3e22");
  rect(ctx, 24, 1, 3, 13, "#5a3420");
  rect(ctx, 3, 10, 22, 28, "#f2ece0");
  rect(ctx, 5, 12, 18, 7, "#fbf8f2");
  rect(ctx, 5, 18, 18, 1, "#d8d0c0");
  rect(ctx, 6, 13, 6, 1, "#ffffff");
  rect(ctx, 3, 21, 22, 17, blanket);
  rect(ctx, 3, 21, 22, 2, shade(blanket, 0.25));
  for (let y = 24; y < 37; y += 4) {
    for (let x = 4 + ((y / 4) % 2) * 4; x < 24; x += 8) rect(ctx, x, y, 4, 4, shade(blanket, 0.14));
  }
  rect(ctx, 3, 36, 22, 2, shade(blanket, -0.25));
  rect(ctx, 24, 21, 1, 17, shade(blanket, -0.3));
  woodBox(ctx, 1, 37, 26, 4, "#6a3e22");
  outlineSprite(ctx, 28, 42, OUTLINE);
  return sprite;
}

function paintBookshelf(seed: number): Sprite {
  const { sprite, ctx } = newSprite(32, 42);
  const rng = mulberry32(seed);
  woodBox(ctx, 1, 1, 30, 40, "#6a4226");
  rect(ctx, 3, 3, 26, 36, "#3a2416");
  const spines = ["#b5453a", "#4a6fb0", "#4f8a4a", "#d8b44a", "#8a5aa8", "#e0d4bc", "#2f8a8a", "#c8643a"];
  for (let row = 0; row < 3; row++) {
    const sy = 3 + row * 12;
    let bx = 4;
    while (bx < 27) {
      const bw = 2 + Math.floor(rng() * 2);
      const bh = 7 + Math.floor(rng() * 3);
      const col = spines[Math.floor(rng() * spines.length)];
      if (rng() < 0.12 && bx < 22) {
        line(ctx, bx, sy + 10, bx + 3, sy + 10 - bh + 1, col);
        line(ctx, bx + 1, sy + 10, bx + 4, sy + 10 - bh + 1, shade(col, -0.2));
        bx += 5;
        continue;
      }
      rect(ctx, bx, sy + 10 - bh, bw, bh, col);
      rect(ctx, bx, sy + 10 - bh, 1, bh, shade(col, 0.2));
      rect(ctx, bx, sy + 12 - bh, bw, 1, shade(col, -0.3));
      bx += bw;
      if (rng() < 0.15) bx += 2;
    }
    woodBox(ctx, 2, sy + 10, 28, 2, "#8a5a33");
  }
  outlineSprite(ctx, 32, 42, OUTLINE);
  return sprite;
}

function stonePixel(x: number, y: number, seed: number, base = "#8c878d"): string {
  const row = Math.floor(y / 5);
  const off = (row % 2) * 4;
  const edge = y % 5 === 4 || (x + off) % 8 === 0;
  const k = hash2(Math.floor((x + off) / 8), row, seed);
  if (edge) return shade(base, -0.4);
  if (y % 5 === 0) return shade(base, 0.22);
  return k < 0.3 ? shade(base, 0.1) : k > 0.75 ? shade(base, -0.1) : base;
}

function paintFireplace(): Sprite {
  const { sprite, ctx } = newSprite(40, 50);
  for (let y = 1; y < 49; y++) for (let x = 1; x < 39; x++) rect(ctx, x, y, 1, 1, stonePixel(x, y, 17));
  woodBox(ctx, 0, 14, 40, 4, "#6a3e22");
  rect(ctx, 9, 23, 22, 22, "#1a1210");
  rect(ctx, 11, 21, 18, 2, "#1a1210");
  rect(ctx, 9, 23, 22, 2, "#2a1c16");
  rect(ctx, 5, 45, 30, 4, "#b3aeb0");
  rect(ctx, 5, 45, 30, 1, "#d0cccd");
  rect(ctx, 12, 40, 16, 3, "#6b4426");
  rect(ctx, 14, 38, 12, 2, "#8a5a33");
  rect(ctx, 12, 40, 2, 3, "#c89a64");
  outlineSprite(ctx, 40, 50, OUTLINE);
  return sprite;
}

function paintTable(w: number, h: number, cloth: string | null): Sprite {
  const { sprite, ctx } = newSprite(w + 2, h + 8);
  for (const x of [2, w - 3]) {
    rect(ctx, x, h, 2, 6, "#5a3920");
    rect(ctx, x, h, 1, 6, "#7a5030");
  }
  woodBox(ctx, 1, 1, w, h, "#9a6a3e");
  for (let y = 4; y < h - 3; y += 4) rect(ctx, 2, y, w - 2, 1, "#8a5a33");
  rect(ctx, 1, h - 3, w, 3, "#7a5030");
  if (cloth) {
    rect(ctx, 5, 1, w - 8, h - 1, cloth);
    rect(ctx, 5, 1, w - 8, 1, shade(cloth, 0.25));
    for (let x = 6; x < w - 4; x += 4) rect(ctx, x, h - 1, 2, 2, cloth);
    for (let y = 3; y < h - 2; y += 4) for (let x = 7; x < w - 4; x += 4) rect(ctx, x, y, 2, 2, shade(cloth, 0.3));
  }
  outlineSprite(ctx, w + 2, h + 8, OUTLINE);
  return sprite;
}

function paintChair(side: boolean): Sprite {
  const { sprite, ctx } = newSprite(14, 20);
  if (side) {
    rect(ctx, 9, 1, 3, 12, "#7a4a2a");
    rect(ctx, 9, 1, 1, 12, "#9a6a3e");
    woodBox(ctx, 2, 9, 10, 3, "#9a6a3e");
    rect(ctx, 2, 12, 2, 6, "#6a3e22");
    rect(ctx, 10, 12, 2, 6, "#5a3420");
  } else {
    woodBox(ctx, 1, 1, 12, 7, "#7a4a2a");
    for (let x = 3; x < 12; x += 3) rect(ctx, x, 2, 1, 5, "#5a3420");
    woodBox(ctx, 1, 8, 12, 4, "#9a6a3e");
    rect(ctx, 2, 12, 2, 6, "#6a3e22");
    rect(ctx, 10, 12, 2, 6, "#5a3420");
  }
  outlineSprite(ctx, 14, 20, OUTLINE);
  return sprite;
}

function paintDresser(): Sprite {
  const { sprite, ctx } = newSprite(30, 28);
  woodBox(ctx, 1, 5, 28, 20, "#8a5a33");
  for (let i = 0; i < 3; i++) {
    const y = 9 + i * 5;
    rect(ctx, 3, y, 24, 4, "#9a6a3e");
    rect(ctx, 3, y + 3, 24, 1, "#6a4426");
    rect(ctx, 14, y + 1, 2, 1, "#e8c93a");
  }
  rect(ctx, 3, 25, 3, 2, "#5a3920");
  rect(ctx, 24, 25, 3, 2, "#5a3920");
  rect(ctx, 5, 1, 4, 4, "#4a6fb0");
  rect(ctx, 6, 0, 2, 1, "#4f8a3c");
  rect(ctx, 18, 1, 7, 4, "#e8c93a");
  rect(ctx, 19, 2, 5, 2, "#8fc3e8");
  outlineSprite(ctx, 30, 28, OUTLINE);
  return sprite;
}

function paintPlant(tall: boolean): Sprite {
  const h = tall ? 30 : 20;
  const { sprite, ctx } = newSprite(18, h);
  rect(ctx, 5, h - 8, 8, 7, "#b8603a");
  rect(ctx, 4, h - 9, 10, 2, "#d0784a");
  rect(ctx, 11, h - 7, 2, 6, "#8a4428");
  const leaves: Array<[number, number, number]> = tall
    ? [[9, 6, 4], [5, 10, 4], [13, 11, 4], [8, 15, 4], [11, 4, 3]]
    : [[9, 6, 4], [5, 8, 3], [13, 9, 3]];
  for (const [x, y, r] of leaves) disk(ctx, x, y, r, "#3f8a3a");
  for (const [x, y, r] of leaves) disk(ctx, x - 1, y - 1, r - 1.5, "#5aa84a");
  outlineSprite(ctx, 18, h, "#1c3a1e");
  return sprite;
}

function paintCrate(): Sprite {
  const { sprite, ctx } = newSprite(18, 17);
  woodBox(ctx, 1, 1, 16, 15, "#9a6a3e");
  rect(ctx, 1, 1, 16, 2, "#c89a64");
  line(ctx, 2, 3, 15, 14, "#6a4426");
  line(ctx, 15, 3, 2, 14, "#6a4426");
  rect(ctx, 1, 8, 16, 1, "#6a4426");
  outlineSprite(ctx, 18, 17, OUTLINE);
  return sprite;
}

function paintBarrel(): Sprite {
  const { sprite, ctx } = newSprite(15, 19);
  rect(ctx, 2, 3, 11, 14, "#8a5a33");
  rect(ctx, 1, 5, 13, 10, "#8a5a33");
  rect(ctx, 3, 3, 2, 14, "#a8743f");
  rect(ctx, 11, 3, 2, 14, "#6a4426");
  rect(ctx, 1, 6, 13, 1, "#5a5460");
  rect(ctx, 1, 13, 13, 1, "#5a5460");
  ellipse(ctx, 7.5, 3, 5.5, 2, "#b8854f");
  ellipse(ctx, 7.5, 3, 3.5, 1, "#9a6a3e");
  outlineSprite(ctx, 15, 19, OUTLINE);
  return sprite;
}

function paintSack(): Sprite {
  const { sprite, ctx } = newSprite(14, 16);
  ellipse(ctx, 7, 10, 6, 5, "#d8c188");
  rect(ctx, 2, 6, 10, 6, "#d8c188");
  rect(ctx, 4, 2, 6, 5, "#c9b077");
  rect(ctx, 5, 1, 4, 1, "#8a6a44");
  rect(ctx, 3, 12, 8, 2, "#b8a06a");
  rect(ctx, 4, 8, 2, 2, "#f0e0b0");
  rect(ctx, 6, 9, 3, 2, "#b8603a");
  outlineSprite(ctx, 14, 16, OUTLINE);
  return sprite;
}

function paintTrough(): Sprite {
  const { sprite, ctx } = newSprite(40, 14);
  woodBox(ctx, 1, 3, 38, 9, "#7a5030");
  rect(ctx, 3, 4, 34, 4, "#b8933a");
  for (let x = 4; x < 36; x += 3) rect(ctx, x, 3, 2, 2, "#dcb850");
  rect(ctx, 2, 12, 2, 1, "#5a3920");
  rect(ctx, 36, 12, 2, 1, "#5a3920");
  outlineSprite(ctx, 40, 14, OUTLINE);
  return sprite;
}

function paintNestRow(): Sprite {
  const { sprite, ctx } = newSprite(56, 22);
  woodBox(ctx, 1, 1, 54, 20, "#8a5a33");
  for (let i = 0; i < 3; i++) {
    const x = 3 + i * 18;
    rect(ctx, x, 4, 14, 13, "#3a2416");
    rect(ctx, x, 11, 14, 6, "#b8933a");
    rect(ctx, x + 1, 10, 12, 2, "#dcb850");
  }
  rect(ctx, 1, 18, 54, 3, "#6a4426");
  outlineSprite(ctx, 56, 22, OUTLINE);
  return sprite;
}

function paintStall(): Sprite {
  const { sprite, ctx } = newSprite(8, 40);
  woodBox(ctx, 2, 1, 4, 38, "#8a5a33");
  for (let y = 6; y < 36; y += 9) rect(ctx, 1, y, 6, 3, "#9a6a3e");
  outlineSprite(ctx, 8, 40, OUTLINE);
  return sprite;
}

function paintToolRack(): Sprite {
  const { sprite, ctx } = newSprite(34, 30);
  woodBox(ctx, 1, 4, 32, 3, "#6a4426");
  rect(ctx, 6, 6, 2, 22, "#9a6a3e");
  rect(ctx, 3, 2, 8, 1, "#8a8a92");
  for (const x of [3, 6, 9]) rect(ctx, x, 0, 1, 3, "#8a8a92");
  rect(ctx, 16, 6, 2, 16, "#9a6a3e");
  rect(ctx, 14, 21, 6, 7, "#8a8a92");
  rect(ctx, 14, 21, 6, 1, "#b0b0b8");
  disk(ctx, 27, 14, 4, "#c9a86a");
  disk(ctx, 27, 14, 2, "#8a6a44");
  outlineSprite(ctx, 34, 30, OUTLINE);
  return sprite;
}

function paintStove(): Sprite {
  const { sprite, ctx } = newSprite(18, 24);
  rect(ctx, 7, 0, 4, 8, "#3a3a44");
  rect(ctx, 2, 8, 14, 13, "#3a3a44");
  rect(ctx, 2, 8, 14, 1, "#5a5a66");
  rect(ctx, 5, 12, 8, 5, "#1a1210");
  rect(ctx, 3, 21, 2, 2, "#2a2a30");
  rect(ctx, 13, 21, 2, 2, "#2a2a30");
  outlineSprite(ctx, 18, 24, OUTLINE);
  return sprite;
}

function paintHopper(): Sprite {
  const { sprite, ctx } = newSprite(26, 20);
  for (let y = 1; y < 14; y++) {
    const half = 12 - y * 0.6;
    rect(ctx, 13 - half, y, half * 2, 1, y < 3 ? "#b8854f" : "#9a6a3e");
  }
  rect(ctx, 11, 14, 4, 5, "#7a5030");
  rect(ctx, 2, 1, 22, 2, "#c89a64");
  rect(ctx, 4, 3, 18, 2, "#e8dcc0");
  outlineSprite(ctx, 26, 20, OUTLINE);
  return sprite;
}

function paintStairs(): Sprite {
  const { sprite, ctx } = newSprite(30, 46);
  for (let i = 0; i < 7; i++) {
    const y = 1 + i * 6;
    const x = 1 + (6 - i) * 2;
    woodBox(ctx, x, y, 28 - (6 - i) * 2, 6, i % 2 ? "#9a6a3e" : "#a8743f");
  }
  rect(ctx, 26, 1, 3, 44, "#6a4426");
  outlineSprite(ctx, 30, 46, OUTLINE);
  return sprite;
}

function paintCat(frame: number): Sprite {
  const { sprite, ctx } = newSprite(18, 12);
  ellipse(ctx, 10, 7 - frame * 0.5, 6.5, 3.6, "#b06a2c");
  ellipse(ctx, 10, 6 - frame * 0.5, 5.5, 3, "#d98c3f");
  rect(ctx, 8, 4 - frame, 3, 1, "#b06a2c");
  disk(ctx, 4, 6, 3, "#d98c3f");
  rect(ctx, 2, 2, 1, 2, "#d98c3f");
  rect(ctx, 5, 2, 1, 2, "#d98c3f");
  rect(ctx, 3, 6, 2, 1, "#5a3a1e");
  rect(ctx, 10, 10, 7, 1, "#b06a2c");
  outlineSprite(ctx, 18, 12, OUTLINE);
  return sprite;
}

function paintCounter(): Sprite {
  const { sprite, ctx } = newSprite(98, 26);
  woodBox(ctx, 1, 1, 96, 6, "#b8854f");
  rect(ctx, 1, 7, 96, 16, "#8a5a33");
  for (let x = 4; x < 94; x += 16) {
    rect(ctx, x, 10, 12, 10, "#7a4e2c");
    rect(ctx, x, 10, 12, 1, "#6a4426");
    rect(ctx, x, 19, 12, 1, "#9a6a3e");
  }
  rect(ctx, 1, 22, 96, 2, "#5a3920");
  // register + scale on top
  rect(ctx, 68, -1 + 1, 16, 6, "#4a4a54");
  rect(ctx, 69, 1, 14, 2, "#6a6a74");
  rect(ctx, 71, 3, 3, 1, "#e8c93a");
  rect(ctx, 14, 2, 10, 3, "#c8a040");
  outlineSprite(ctx, 98, 26, OUTLINE);
  return sprite;
}

function paintGoodsShelf(seed: number): Sprite {
  const { sprite, ctx } = newSprite(40, 42);
  const rng = mulberry32(seed);
  woodBox(ctx, 1, 1, 38, 40, "#7a4a2a");
  rect(ctx, 3, 3, 34, 36, "#3a2416");
  const goods = ["#e8913a", "#d8443a", "#f2cf3a", "#4a7fd8", "#8a4fc0", "#6aa84a", "#e8e0d0"];
  for (let row = 0; row < 3; row++) {
    const sy = 3 + row * 12;
    let x = 4;
    while (x < 34) {
      const kind = rng();
      const c = goods[Math.floor(rng() * goods.length)];
      if (kind < 0.45) {
        // jar with a lid
        rect(ctx, x, sy + 4, 4, 6, "#cfe6ec");
        rect(ctx, x, sy + 6, 4, 4, c);
        rect(ctx, x, sy + 3, 4, 1, "#8a6a44");
        x += 5;
      } else if (kind < 0.75) {
        // produce pile
        disk(ctx, x + 3, sy + 8, 2.5, c);
        disk(ctx, x + 6, sy + 8, 2.5, shade(c, -0.1));
        rect(ctx, x + 3, sy + 6, 1, 1, shade(c, 0.4));
        x += 9;
      } else {
        // boxed goods
        rect(ctx, x, sy + 3, 6, 7, c);
        rect(ctx, x, sy + 3, 6, 1, shade(c, 0.3));
        rect(ctx, x + 1, sy + 5, 4, 2, "#f4f0e6");
        x += 7;
      }
    }
    woodBox(ctx, 2, sy + 10, 36, 2, "#8a5a33");
  }
  outlineSprite(ctx, 40, 42, OUTLINE);
  return sprite;
}

function paintPlanter(): Sprite {
  const { sprite, ctx } = newSprite(92, 20);
  woodBox(ctx, 1, 4, 90, 14, "#8a5a33");
  rect(ctx, 3, 5, 86, 7, "#4a2f1e");
  for (let x = 4; x < 88; x += 3) rect(ctx, x, 6 + (x % 2), 1, 1, "#6e4a2e");
  rect(ctx, 1, 12, 90, 1, "#6a4426");
  outlineSprite(ctx, 92, 20, OUTLINE);
  return sprite;
}

function paintSeedlings(): Sprite[] {
  const make = (stage: number, wilted: boolean): Sprite => {
    const { sprite, ctx } = newSprite(12, 16);
    const leaf = wilted ? "#9a8a4a" : "#4f9a3c";
    const leafL = wilted ? "#b8a860" : "#72b85a";
    const top = 14 - (stage + 1) * 3;
    rect(ctx, 6, top, 1, 15 - top, wilted ? "#7a6a3a" : "#357a2c");
    for (let y = top + 1; y < 14; y += 3) {
      if (wilted) {
        rect(ctx, 3, y + 1, 3, 1, leaf);
        rect(ctx, 7, y + 2, 3, 1, leafL);
      } else {
        ellipse(ctx, 4, y, 2.2, 1.1, leaf);
        ellipse(ctx, 8.5, y - 1, 2.2, 1.1, leafL);
      }
    }
    if (stage === 2 && !wilted) {
      disk(ctx, 6, top - 1, 2, ["#ef7fae", "#f2cf3a", "#e8913a"][Math.floor(Math.random() * 3)]);
      rect(ctx, 6, top - 1, 1, 1, "#fff6c8");
    }
    outlineSprite(ctx, 12, 16, "#1c3a1e");
    return sprite;
  };
  return [make(0, false), make(1, false), make(2, false), make(1, true)];
}

function paintWateringCan(): Sprite {
  const { sprite, ctx } = newSprite(18, 12);
  rect(ctx, 4, 3, 8, 7, "#6a8aa8");
  rect(ctx, 4, 3, 8, 1, "#8aa8c4");
  line(ctx, 12, 6, 16, 2, "#6a8aa8");
  rect(ctx, 15, 1, 2, 2, "#8aa8c4");
  rect(ctx, 2, 4, 2, 4, "#4a6a88");
  outlineSprite(ctx, 18, 12, OUTLINE);
  return sprite;
}

function kit(): Kit {
  if (kitCache) return kitCache;
  kitCache = {
    bed: BLANKETS.map(paintBed),
    bookshelf: [paintBookshelf(31), paintBookshelf(47), paintBookshelf(83)],
    fireplace: paintFireplace(),
    table: paintTable(44, 22, "#e8e0d0"),
    smallTable: paintTable(30, 16, null),
    chair: paintChair(false),
    chairSide: paintChair(true),
    dresser: paintDresser(),
    plant: paintPlant(false),
    tallPlant: paintPlant(true),
    crate: paintCrate(),
    barrel: paintBarrel(),
    sack: paintSack(),
    trough: paintTrough(),
    nestRow: paintNestRow(),
    stall: paintStall(),
    toolRack: paintToolRack(),
    stove: paintStove(),
    hopper: paintHopper(),
    stairs: paintStairs(),
    cat: [paintCat(0), paintCat(1)],
    counter: paintCounter(),
    goodsShelf: [paintGoodsShelf(5), paintGoodsShelf(9), paintGoodsShelf(13)],
    planter: paintPlanter(),
    seedling: paintSeedlings(),
    wateringCan: paintWateringCan(),
  };
  return kitCache;
}

// ---------------------------------------------------------------------------
// Room shell: wallpaper, trim, windows, floors

type Paper = "stripes" | "diamonds" | "planks" | "stone" | "barn" | "glass";

function drawShell(ctx: Ctx, f: Rect, paper: Paper, base: string, hour = 12): void {
  const top = f.y - WALL_H;
  const wx = f.x - SIDE;
  const ww = f.w + SIDE * 2;
  rect(ctx, wx - 3, top - 5, ww + 6, WALL_H + f.h + SIDE + 8, VOID);
  const n = nightAmount(hour);
  for (let y = top; y < f.y; y++) {
    for (let x = wx; x < wx + ww; x++) {
      const lx = x - wx;
      const ly = y - top;
      let c = base;
      if (paper === "stripes") c = lx % 8 < 4 ? base : shade(base, -0.07);
      else if (paper === "diamonds") {
        const dx = Math.abs(((lx + 4) % 10) - 5);
        const dy = Math.abs(((ly + 3) % 10) - 5);
        c = dx + dy === 4 ? shade(base, -0.12) : dx + dy === 0 ? shade(base, 0.12) : base;
      } else if (paper === "planks" || paper === "barn") {
        const vertical = paper === "barn";
        const k = vertical ? lx % 6 : ly % 5;
        c = k === 0 ? shade(base, -0.22) : k === 1 ? shade(base, 0.1) : base;
        if (hash2(vertical ? Math.floor(lx / 6) : lx >> 3, vertical ? ly >> 3 : Math.floor(ly / 5), 5) < 0.1) c = shade(c, -0.08);
      } else if (paper === "glass") {
        // panes showing the sky, with white mullions and a reflection streak
        const mull = lx % 14 === 0 || ly % 14 === 0;
        const sky = n > 0.75 ? "#23335e" : n > 0.25 ? "#e0a070" : ly > 28 ? "#a8dcc8" : "#9fd0ea";
        c = mull ? "#e9eee9" : (lx + ly) % 14 === 5 || (lx + ly) % 14 === 6 ? shade(sky, 0.25) : sky;
      } else {
        c = stonePixel(lx, ly, 9, base);
      }
      rect(ctx, x, y, 1, 1, c);
    }
  }
  rect(ctx, wx, top, ww, 3, paper === "glass" ? "#c8d0cc" : "#5a3920");
  rect(ctx, wx, top + 3, ww, 1, paper === "glass" ? "#e9eee9" : "#8a5a33");
  rect(ctx, wx, top + 4, ww, 1, "rgba(20,10,10,0.25)");
  if (paper === "stripes" || paper === "diamonds") {
    const wy = f.y - 14;
    rect(ctx, wx, wy, ww, 14, "#8a5a33");
    rect(ctx, wx, wy, ww, 2, "#b8854f");
    rect(ctx, wx, wy + 2, ww, 1, "#5a3920");
    for (let x = wx + 5; x < wx + ww - 12; x += 16) {
      rect(ctx, x, wy + 5, 12, 6, "#7a4e2c");
      rect(ctx, x, wy + 5, 12, 1, "#6a4426");
      rect(ctx, x, wy + 10, 12, 1, "#9a6a3e");
    }
  }
  if (paper === "glass") {
    rect(ctx, wx, f.y - 8, ww, 8, "#8c878d");
    rect(ctx, wx, f.y - 8, ww, 1, "#b3aeb0");
  }
  rect(ctx, wx, f.y - 2, ww, 2, "#3a2416");
  const capC = paper === "glass" ? "#9aa4a0" : "#4a3428";
  const capL = paper === "glass" ? "#d8e0dc" : "#6a4e3e";
  rect(ctx, wx, f.y, SIDE, f.h + SIDE, capC);
  rect(ctx, f.x + f.w, f.y, SIDE, f.h + SIDE, capC);
  rect(ctx, wx, f.y + f.h, ww, SIDE, capC);
  rect(ctx, wx + 1, f.y, 1, f.h + SIDE - 1, capL);
  rect(ctx, f.x + f.w + SIDE - 2, f.y, 1, f.h + SIDE - 1, capL);
  rect(ctx, wx + 1, f.y + f.h + SIDE - 2, ww - 2, 1, capL);
}

function wallShadow(ctx: Ctx, f: Rect): void {
  ctx.fillStyle = "rgba(20,10,10,0.3)";
  ctx.fillRect(f.x, f.y, f.w, 4);
  ctx.fillRect(f.x, f.y, 3, f.h);
  ctx.fillStyle = "rgba(20,10,10,0.14)";
  ctx.fillRect(f.x, f.y + 4, f.w, 3);
  ctx.fillRect(f.x + 3, f.y, 2, f.h);
}

function drawExitDoor(ctx: Ctx, f: Rect, exit: Rect): void {
  rect(ctx, exit.x - 2, f.y + f.h, exit.w + 4, SIDE, VOID);
  rect(ctx, exit.x - 3, f.y + f.h, 1, SIDE, "#6a4e3e");
  rect(ctx, exit.x + exit.w + 2, f.y + f.h, 1, SIDE, "#6a4e3e");
  rect(ctx, exit.x, exit.y - 1, exit.w, exit.h + 1, "#8e332c");
  rect(ctx, exit.x + 1, exit.y, exit.w - 2, exit.h - 1, "#b3543f");
  for (let x = exit.x + 3; x < exit.x + exit.w - 3; x += 3) rect(ctx, x, exit.y + 2, 1, exit.h - 4, "#c9694f");
}

function woodFloor(ctx: Ctx, f: Rect, seed: number, tint = 0): void {
  const rng = mulberry32(seed);
  const tones = ["#b8834e", "#c08b55", "#ae7a47", "#c4925c"].map((c) => shade(c, tint));
  for (let y = 0; y < f.h; y += 7) {
    let x = -Math.floor(rng() * 30);
    while (x < f.w) {
      const len = 28 + Math.floor(rng() * 34);
      const x0 = Math.max(0, x);
      const x1 = Math.min(f.w, x + len);
      const hgt = Math.min(7, f.h - y);
      rect(ctx, f.x + x0, f.y + y, x1 - x0, hgt, tones[Math.floor(rng() * tones.length)]);
      rect(ctx, f.x + x0, f.y + y, x1 - x0, 1, shade(tones[0], 0.18));
      if (x1 < f.w) rect(ctx, f.x + x1 - 1, f.y + y, 1, hgt, shade(tones[0], -0.35));
      for (let k = 0; k < len / 10; k++) {
        const gx = x0 + Math.floor(rng() * Math.max(1, x1 - x0 - 4));
        rect(ctx, f.x + gx, f.y + y + 2 + Math.floor(rng() * 3), 3, 1, shade(tones[2], -0.08));
      }
      x += len;
    }
    rect(ctx, f.x, f.y + Math.min(f.h - 1, y + 6), f.w, 1, shade(tones[0], -0.35));
  }
}

function tileFloor(ctx: Ctx, f: Rect, seed: number, base = "#9a9492"): void {
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const k = hash2(Math.floor(x / 12), Math.floor(y / 12), seed);
      const lx = x % 12;
      const ly = y % 12;
      let c = k < 0.3 ? shade(base, 0.08) : k > 0.8 ? shade(base, -0.08) : base;
      if (lx === 0 || ly === 0) c = shade(base, -0.32);
      else if (lx === 1 || ly === 1) c = shade(c, 0.12);
      rect(ctx, f.x + x, f.y + y, 1, 1, c);
    }
  }
}

function strawFloor(ctx: Ctx, f: Rect, seed: number, straw: number): void {
  const rng = mulberry32(seed);
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const k = hash2(x >> 1, y >> 1, seed);
      rect(ctx, f.x + x, f.y + y, 1, 1, k < 0.2 ? "#6e4a2e" : k > 0.85 ? "#8a6040" : "#7a5536");
    }
  }
  for (let i = 0; i < straw; i++) {
    const x = f.x + Math.floor(rng() * (f.w - 4));
    const y = f.y + Math.floor(rng() * f.h);
    line(ctx, x, y, x + 2 + Math.floor(rng() * 3), y + (rng() < 0.5 ? 1 : 0), rng() < 0.5 ? "#dcb850" : "#b8933a");
  }
}

function drawWindow(ctx: Ctx, x: number, y: number, w: number, h: number, hour: number, curtain: string | null): void {
  const n = nightAmount(hour);
  rect(ctx, x - 2, y - 2, w + 4, h + 4, OUTLINE);
  rect(ctx, x - 1, y - 1, w + 2, h + 2, "#e8dcc0");
  const sky = n > 0.75 ? "#1d2b52" : n > 0.25 ? "#d98850" : "#8fc3e8";
  const skyLo = n > 0.75 ? "#26386a" : n > 0.25 ? "#e8a868" : "#b8dcf2";
  rect(ctx, x, y, w, h, sky);
  rect(ctx, x, y + Math.floor(h * 0.6), w, h - Math.floor(h * 0.6), skyLo);
  if (n > 0.75) {
    rect(ctx, x + 2, y + 2, 1, 1, "#f4f0e0");
    rect(ctx, x + w - 3, y + 4, 1, 1, "#f4f0e0");
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ellipse(ctx, x + w * 0.3, y + h + 2, w * 0.5, 4, n > 0.25 ? "#6a7a3a" : "#5aa84a");
    ctx.restore();
    rect(ctx, x + 2, y + 2, 4, 1, "#ffffff");
  }
  rect(ctx, x + Math.floor(w / 2), y, 1, h, "#e8dcc0");
  rect(ctx, x, y + Math.floor(h / 2), w, 1, "#e8dcc0");
  rect(ctx, x - 3, y + h + 2, w + 6, 2, "#9a6a3e");
  rect(ctx, x - 3, y + h + 2, w + 6, 1, "#c89a64");
  if (curtain) {
    const cd = shade(curtain, -0.25);
    for (const cx of [x - 4, x + w]) {
      rect(ctx, cx, y - 3, 4, h + 5, curtain);
      rect(ctx, cx + 1, y - 3, 1, h + 5, shade(curtain, 0.2));
      rect(ctx, cx + 3, y - 3, 1, h + 5, cd);
    }
    rect(ctx, x - 6, y - 4, w + 12, 2, "#5a3920");
  }
}

function drawPainting(ctx: Ctx, x: number, y: number, w: number, h: number, seed: number): void {
  const rng = mulberry32(seed);
  rect(ctx, x - 2, y - 2, w + 4, h + 4, OUTLINE);
  rect(ctx, x - 1, y - 1, w + 2, h + 2, "#c8a040");
  rect(ctx, x - 1, y - 1, w + 2, 1, "#e8c860");
  rect(ctx, x, y, w, h, ["#8fc3e8", "#f0b878", "#b8a8d8"][Math.floor(rng() * 3)]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ellipse(ctx, x + w * 0.35, y + h, w * 0.55, h * 0.45, "#4f8a4a");
  ellipse(ctx, x + w * 0.8, y + h, w * 0.4, h * 0.3, "#3f7a3a");
  ctx.restore();
  disk(ctx, x + w * 0.75, y + h * 0.3, 1.5, "#fff0b0");
}

function drawClock(ctx: Ctx, x: number, y: number, hour: number): void {
  disk(ctx, x, y, 6, OUTLINE);
  disk(ctx, x, y, 5, "#8a5a33");
  disk(ctx, x, y, 4, "#f2ece0");
  const a = ((hour % 12) / 12) * Math.PI * 2 - Math.PI / 2;
  const m = (hour % 1) * Math.PI * 2 - Math.PI / 2;
  line(ctx, x, y, x + Math.cos(a) * 2, y + Math.sin(a) * 2, OUTLINE);
  line(ctx, x, y, x + Math.cos(m) * 3, y + Math.sin(m) * 3, "#5a3920");
}

function drawRug(ctx: Ctx, x: number, y: number, w: number, h: number, base: string, accent: string): void {
  ctx.fillStyle = "#efe3c6";
  for (let i = x + 2; i < x + w - 2; i += 2) {
    ctx.fillRect(i, y - 2, 1, 2);
    ctx.fillRect(i, y + h, 1, 2);
  }
  rect(ctx, x, y, w, h, shade(base, -0.28));
  rect(ctx, x + 2, y + 2, w - 4, h - 4, base);
  rect(ctx, x + 4, y + 4, w - 8, 1, accent);
  rect(ctx, x + 4, y + h - 5, w - 8, 1, accent);
  rect(ctx, x + 4, y + 4, 1, h - 8, accent);
  rect(ctx, x + w - 5, y + 4, 1, h - 8, accent);
  const cx = x + Math.floor(w / 2);
  const cy = y + Math.floor(h / 2);
  const r = Math.min(w, h) / 2 - 8;
  ctx.fillStyle = shade(base, 0.2);
  for (let dy = -r; dy <= r; dy++) {
    const half = r - Math.abs(dy);
    ctx.fillRect(Math.round(cx - half), Math.round(cy + dy), Math.round(half * 2) + 1, 1);
  }
  for (const dx of [-r - 5, r + 5]) rect(ctx, cx + dx - 1, cy - 1, 3, 3, accent);
  rect(ctx, cx - 1, cy - 1, 3, 3, accent);
}

function drawFlame(ctx: Ctx, cx: number, baseY: number, t: number): void {
  const fl = Math.floor(t * 8) % 3;
  rect(ctx, cx - 6, baseY - 5, 12, 5, "#c8401f");
  rect(ctx, cx - 5 + fl, baseY - 9, 5, 4, "#e8642f");
  rect(ctx, cx + 1 - fl, baseY - 11, 4, 6, "#e8642f");
  rect(ctx, cx - 3, baseY - 6, 6, 4, "#f2a23a");
  rect(ctx, cx - 1 + (fl % 2), baseY - 8, 2, 3, "#ffd554");
  rect(ctx, cx - 1, baseY - 3, 2, 2, "#fff6c8");
}

function drawCandle(ctx: Ctx, x: number, y: number, t: number): void {
  rect(ctx, x - 2, y + 4, 6, 2, "#c8a040");
  rect(ctx, x, y, 2, 5, "#f4f0e6");
  rect(ctx, x + 1, y, 1, 5, "#d8d0c0");
  ctx.fillStyle = Math.floor(t * 8) % 2 === 0 ? "#ffd554" : "#ffb03a";
  ctx.fillRect(x, y - 3, 2, 3);
  rect(ctx, x, y - 1, 2, 1, "#fff6c8");
}

function drawLantern(ctx: Ctx, x: number, y: number, t: number): void {
  rect(ctx, x + 2, y - 3, 2, 3, "#3a3a44");
  rect(ctx, x - 1, y - 1, 8, 12, OUTLINE);
  rect(ctx, x, y, 6, 10, "#3a3a44");
  ctx.fillStyle = Math.floor(t * 6) % 2 === 0 ? C.windowGlow : "#ffcf66";
  ctx.fillRect(x + 1, y + 2, 4, 6);
  rect(ctx, x + 1, y + 2, 1, 2, "#fff6c8");
}

function drawChalkboard(ctx: Ctx, x: number, y: number, lines: string[]): void {
  rect(ctx, x - 3, y - 3, 82, 32, OUTLINE);
  rect(ctx, x - 2, y - 2, 80, 30, "#8a5a33");
  rect(ctx, x - 2, y - 2, 80, 1, "#b8854f");
  rect(ctx, x, y, 76, 26, "#2a3e30");
  rect(ctx, x + 2, y + 2, 20, 1, "#3a5040");
  lines.forEach((ln, i) => drawText(ctx, ln, x + 5, y + 5 + i * 10, "#dcecd8"));
  rect(ctx, x + 60, y + 27, 8, 2, "#f4f0e6");
}

function drawBanner(ctx: Ctx, x: number, y: number, color: string): void {
  rect(ctx, x - 2, y - 1, 18, 2, "#5a3920");
  rect(ctx, x - 1, y + 1, 16, 14, OUTLINE);
  rect(ctx, x, y + 1, 14, 13, color);
  rect(ctx, x, y + 1, 14, 1, shade(color, 0.25));
  rect(ctx, x, y + 14, 5, 3, color);
  rect(ctx, x + 9, y + 14, 5, 3, color);
  rect(ctx, x + 5, y + 5, 4, 4, shade(color, 0.35));
}

function drawCobweb(ctx: Ctx, x: number, y: number, flip: boolean): void {
  ctx.fillStyle = "rgba(228,228,228,0.35)";
  for (let i = 0; i < 9; i++) {
    const px = flip ? x - i : x + i;
    ctx.fillRect(px, y + i, 1, 1);
    ctx.fillRect(flip ? x - 8 : x + 8, y + i, 1, 1);
    ctx.fillRect(px, y + 8, 1, 1);
  }
}

function spr(ctx: Ctx, s: Sprite, x: number, y: number): void {
  ctx.drawImage(s.canvas, Math.round(x), Math.round(y));
}

function roomOverlay(ctx: Ctx, f: Rect, hour: number, glows: Glow[]): void {
  const n = nightAmount(hour);
  if (n <= 0.02) return;
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = 0.5 * n;
  ctx.fillStyle = "rgb(64,70,116)";
  ctx.fillRect(f.x - SIDE, f.y - WALL_H, f.w + SIDE * 2, f.h + WALL_H + SIDE);
  ctx.globalCompositeOperation = "lighter";
  for (const g of glows) {
    const grad = ctx.createRadialGradient(g.x, g.y, 1, g.x, g.y, g.r);
    grad.addColorStop(0, g.color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = g.a * n;
    ctx.fillStyle = grad;
    ctx.fillRect(g.x - g.r, g.y - g.r, g.r * 2, g.r * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// a standing person (shopkeeper, resident)
function personDrawable(s: ValleySprites, look: number, x: number, y: number): InteriorDrawable {
  return {
    baseline: y + 1,
    draw: (ctx) => {
      const sp = s.villagers[look % s.villagers.length].down[0];
      ctx.fillStyle = "rgba(20,24,16,0.28)";
      ctx.fillRect(Math.round(x - 5), Math.round(y - 1), 10, 2);
      ctx.drawImage(sp.canvas, Math.round(x - sp.w / 2), Math.round(y - sp.h + 2));
    },
  };
}

// ---------------------------------------------------------------------------
// Farmhouse: the server's home. The hearth burns while the server is healthy.

function farmhouseInterior(): Interior {
  const f = roomRect(17, 9);
  const exit = exitFor(f);
  const bed = { x: f.x + 8, y: f.y - 8 };
  const shelf = { x: f.x + 44, y: f.y - 34 };
  const fire = { x: f.x + f.w - 78, y: f.y - 42 };
  const table = { x: f.x + 104, y: f.y + 66 };
  const cat = { x: fire.x + 2, y: f.y + 14 };
  const dresser = { x: f.x + f.w - 34, y: f.y - 20 };

  return {
    id: "farmhouse",
    label: "FARMHOUSE",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-bed", rect: { x: bed.x, y: bed.y, w: 28, h: 42 }, label: "BED" },
      { id: "int-hearth", rect: { x: fire.x, y: fire.y, w: 40, h: 50 }, label: "HEARTH" },
      { id: "int-journal", rect: { x: table.x, y: table.y - 2, w: 46, h: 30 }, label: "JOURNAL" },
      { id: "int-cat", rect: { x: cat.x, y: cat.y - 2, w: 18, h: 14 }, label: "CAT" },
    ],
    solids: [
      { x: bed.x, y: f.y, w: 28, h: bed.y + 40 - f.y },
      { x: shelf.x, y: f.y, w: 32, h: 6 },
      { x: fire.x, y: f.y, w: 40, h: 8 },
      { x: dresser.x, y: f.y, w: 30, h: 6 },
      { x: table.x, y: table.y + 6, w: 46, h: 20 },
    ],
    drawBase: (ctx, sim, _s, hour) => {
      const k = kit();
      drawShell(ctx, f, "stripes", "#e8d8b0");
      woodFloor(ctx, f, 71);
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + 90, f.y - 34, 18, 14, hour, "#c9564a");
      drawWindow(ctx, f.x + 142, f.y - 34, 18, 14, hour, "#c9564a");
      drawPainting(ctx, f.x + 118, f.y - 33, 14, 10, 7);
      drawClock(ctx, f.x + 21, f.y - 30, hour);
      drawRug(ctx, f.x + 88, f.y + 52, 78, 50, "#a04438", "#e0b060");
      spr(ctx, k.bookshelf[0], shelf.x, shelf.y);
      spr(ctx, k.fireplace, fire.x, fire.y);
      if (sim.serverOk) drawFlame(ctx, fire.x + 20, fire.y + 42, sim.t);
      else rect(ctx, fire.x + 13, fire.y + 41, 14, 1, "#5a5a5a");
      drawCandle(ctx, fire.x + 6, fire.y + 7, sim.t);
      rect(ctx, fire.x + 26, fire.y + 8, 6, 6, "#4a6fb0");
      spr(ctx, k.dresser, dresser.x, dresser.y);
      spr(ctx, k.bed[0], bed.x, bed.y);
    },
    drawables: (sim) => {
      const k = kit();
      return [
        {
          baseline: table.y + 28,
          draw: (ctx) => {
            spr(ctx, k.table, table.x, table.y);
            rect(ctx, table.x + 10, table.y + 6, 14, 10, OUTLINE);
            rect(ctx, table.x + 11, table.y + 7, 12, 8, "#f4f0e6");
            rect(ctx, table.x + 17, table.y + 7, 1, 8, "#c9c2b2");
            for (const yy of [9, 11, 13]) {
              rect(ctx, table.x + 12, table.y + yy, 4, 1, "#8a8272");
              rect(ctx, table.x + 19, table.y + yy, 3, 1, "#8a8272");
            }
            drawCandle(ctx, table.x + 32, table.y + 6, sim.t);
          },
        },
        { baseline: table.y + 18, draw: (ctx) => spr(ctx, k.chairSide, table.x - 14, table.y + 2) },
        { baseline: table.y + 40, draw: (ctx) => spr(ctx, k.chair, table.x + 16, table.y + 20) },
        { baseline: f.y + f.h - 6, draw: (ctx) => spr(ctx, k.tallPlant, f.x + 4, f.y + f.h - 32) },
        { baseline: f.y + f.h - 6, draw: (ctx) => spr(ctx, k.plant, f.x + f.w - 20, f.y + f.h - 22) },
        { baseline: cat.y + 10, draw: (ctx) => spr(ctx, k.cat[Math.sin(sim.t * 2.2) > 0 ? 1 : 0], cat.x, cat.y) },
      ];
    },
    drawOverlay: (ctx, sim, _s, hour) => {
      const glows: Glow[] = [{ x: table.x + 33, y: table.y + 4, r: 22, color: "rgba(255,214,120,0.55)", a: 0.85 }];
      if (sim.serverOk) glows.push({ x: fire.x + 20, y: fire.y + 36, r: 48, color: "rgba(255,150,70,0.6)", a: 0.95 });
      roomOverlay(ctx, f, hour, glows);
    },
  };
}

// ---------------------------------------------------------------------------
// Barn: the SQLite storeroom. Crates mirror the queue depth, the hay pile
// mirrors the WAL, the chalkboard tallies live numbers.

function barnInterior(): Interior {
  const f = roomRect(17, 9);
  const exit = exitFor(f);
  const shelf = { x: f.x + 8, w: 150 };
  const board = { x: f.x + 172, y: f.y - 36 };
  const hay = { x: f.x + f.w - 58, y: f.y + f.h - 44 };
  const stallX = f.x + 8;

  return {
    id: "barn",
    label: "BARN",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-crates", rect: { x: shelf.x, y: f.y - 40, w: shelf.w, h: 50 }, label: "CRATES" },
      { id: "int-board", rect: { x: board.x - 3, y: board.y - 3, w: 82, h: 32 }, label: "CHALKBOARD" },
      { id: "int-hay", rect: { x: hay.x - 4, y: hay.y - 14, w: 50, h: 44 }, label: "HAY PILE" },
    ],
    solids: [
      { x: shelf.x, y: f.y, w: shelf.w, h: 10 },
      { x: hay.x - 2, y: hay.y, w: 48, h: 26 },
      { x: stallX, y: f.y + 60, w: 92, h: 12 },
      { x: f.x + f.w - 52, y: f.y + 24, w: 46, h: 14 },
      { x: f.x + 60, y: f.y + f.h - 30, w: 50, h: 14 },
    ],
    drawBase: (ctx, sim) => {
      const k = kit();
      drawShell(ctx, f, "barn", "#a04438");
      strawFloor(ctx, f, 55, 260);
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
      spr(ctx, k.toolRack, f.x + f.w - 40, f.y - 34);
      drawLantern(ctx, board.x - 14, f.y - 32, sim.t);
      rect(ctx, shelf.x - 1, f.y - 5, shelf.w + 2, 12, OUTLINE);
      rect(ctx, shelf.x, f.y - 4, shelf.w, 10, "#8a5a33");
      for (let x = shelf.x + 5; x < shelf.x + shelf.w; x += 10) rect(ctx, x, f.y - 4, 1, 10, "#6a4426");
      rect(ctx, shelf.x, f.y - 4, shelf.w, 1, "#b8854f");
      const qd = sim.status?.queueDepth ?? 0;
      const dLabel = sim.status ? String(Math.min(sim.status.deferred, 99999)) : "?";
      const qLabel = sim.status ? String(Math.min(qd, 99999)) : "?";
      drawChalkboard(ctx, board.x, board.y, [`QUEUE ${qLabel}`, `DEFER ${dLabel}`]);
      const crates = clamp(Math.ceil(qd / 4), qd > 0 ? 1 : 0, 17);
      for (let i = 0; i < crates; i++) {
        if (i < 9) spr(ctx, k.crate, shelf.x + 2 + i * 16, f.y - 18);
        else spr(ctx, k.crate, shelf.x + 10 + (i - 9) * 16, f.y - 32);
      }
    },
    drawables: (sim, s) => {
      const k = kit();
      return [
        {
          baseline: hay.y + 26,
          draw: (ctx) => {
            const bales = clamp(sim.hayBales, 1, 4);
            for (let i = 0; i < bales; i++) {
              const col = i % 3;
              const row = i >= 3 ? 1 : 0;
              spr(ctx, s.hayBale, hay.x + col * 14 + row * 7, hay.y + 12 - row * 10);
            }
            for (let i = 0; i < 10; i++) rect(ctx, hay.x + ((i * 7) % 44), hay.y + 25 + (i % 3), 3, 1, "#dcb850");
          },
        },
        { baseline: f.y + 72, draw: (ctx) => spr(ctx, k.stall, stallX, f.y + 34) },
        { baseline: f.y + 72, draw: (ctx) => spr(ctx, k.stall, stallX + 44, f.y + 34) },
        { baseline: f.y + 70, draw: (ctx) => spr(ctx, k.trough, stallX + 5, f.y + 58) },
        { baseline: f.y + f.h - 16, draw: (ctx) => spr(ctx, k.barrel, f.x + 60, f.y + f.h - 34) },
        { baseline: f.y + f.h - 14, draw: (ctx) => spr(ctx, k.barrel, f.x + 76, f.y + f.h - 32) },
        { baseline: f.y + f.h - 17, draw: (ctx) => spr(ctx, k.sack, f.x + 94, f.y + f.h - 32) },
        { baseline: f.y + 72, draw: (ctx) => spr(ctx, k.stall, stallX + 88, f.y + 34) },
        { baseline: f.y + 70, draw: (ctx) => spr(ctx, k.trough, stallX + 49, f.y + 58) },
        {
          baseline: f.y + 40,
          draw: (ctx) => {
            for (let i = 0; i < 3; i++) spr(ctx, s.hayBale, f.x + f.w - 50 + i * 14, f.y + 24);
            spr(ctx, s.hayBale, f.x + f.w - 43, f.y + 14);
          },
        },
      ];
    },
    drawOverlay: (ctx, _sim, _s, hour) => {
      roomOverlay(ctx, f, hour, [{ x: board.x - 11, y: f.y - 26, r: 42, color: "rgba(255,214,120,0.5)", a: 0.9 }]);
    },
  };
}

// ---------------------------------------------------------------------------
// Coop: SSE streams roost here. Eggs in the nest boxes are distinct IPs.

function coopInterior(): Interior {
  const f = roomRect(12, 7);
  const exit = exitFor(f);
  const nests = { x: f.x + f.w - 62, y: f.y - 16 };
  const perch = { x: f.x + 6, y: f.y - 8 };

  return {
    id: "coop",
    label: "COOP",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-roost", rect: { x: perch.x, y: f.y - 40, w: 94, h: 44 }, label: "ROOST" },
      { id: "int-nest", rect: { x: nests.x, y: nests.y, w: 56, h: 22 }, label: "NEST BOXES" },
    ],
    solids: [
      { x: nests.x, y: f.y, w: 56, h: 8 },
      { x: f.x + 20, y: f.y + 50, w: 40, h: 10 },
      { x: f.x + f.w - 26, y: f.y + 44, w: 18, h: 12 },
    ],
    drawBase: (ctx, sim, s, hour) => {
      const k = kit();
      drawShell(ctx, f, "planks", "#b88a55");
      strawFloor(ctx, f, 77, 320);
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + 112, f.y - 34, 14, 11, hour, null);
      const total = sim.status?.sseTotal ?? 0;
      // two perch bars; roosting birds sit on them
      const bars = [
        { y: perch.y - 18, x: perch.x + 10, n: clamp(total - 5, 0, 4), dx: 20 },
        { y: perch.y, x: perch.x, n: Math.min(total, 5), dx: 18 },
      ];
      rect(ctx, perch.x + 1, perch.y - 18, 3, 24, "#6a4426");
      rect(ctx, perch.x + 86, perch.y - 18, 3, 24, "#6a4426");
      for (const bar of bars) {
        for (let i = 0; i < bar.n; i++) {
          const sp = (i % 2 === 0 ? s.chicken : s.chickenFlip)[0];
          ctx.drawImage(sp.canvas, bar.x + 4 + i * bar.dx, bar.y - sp.h + 5);
        }
        rect(ctx, perch.x - 1, bar.y + 2, 92, 4, OUTLINE);
        rect(ctx, perch.x, bar.y + 3, 90, 2, "#9a6a3e");
        rect(ctx, perch.x, bar.y + 3, 90, 1, "#c89a64");
      }
      spr(ctx, k.nestRow, nests.x, nests.y);
      const ips = sim.status?.sseIps ?? 0;
      for (let b = 0; b < 3; b++) {
        const eggs = clamp(ips - b * 2, 0, 2);
        for (let e = 0; e < eggs; e++) {
          const ex = nests.x + 7 + b * 18 + e * 5;
          rect(ctx, ex - 1, nests.y + 8, 5, 5, OUTLINE);
          rect(ctx, ex, nests.y + 9, 3, 3, "#f4efe4");
          rect(ctx, ex, nests.y + 9, 1, 1, "#ffffff");
        }
      }
    },
    drawables: (sim, s) => {
      const k = kit();
      const out: InteriorDrawable[] = [
        { baseline: f.y + 60, draw: (ctx) => spr(ctx, k.trough, f.x + 20, f.y + 47) },
        { baseline: f.y + 56, draw: (ctx) => spr(ctx, k.stove, f.x + f.w - 26, f.y + 32) },
      ];
      if ((sim.status?.sseTotal ?? 0) > 0) {
        out.push({
          baseline: f.y + 72,
          draw: (ctx) => {
            const peck = Math.floor(sim.t * 2.4) % 3 === 0;
            const sp = s.chicken[peck ? 2 : Math.floor(sim.t * 4) % 2];
            ctx.drawImage(sp.canvas, f.x + 52, f.y + 72 - sp.h + 3);
          },
        });
      }
      return out;
    },
    drawOverlay: (ctx, _sim, _s, hour) => {
      roomOverlay(ctx, f, hour, [{ x: f.x + f.w - 17, y: f.y + 46, r: 30, color: "rgba(255,150,70,0.5)", a: 0.8 }]);
    },
  };
}

// ---------------------------------------------------------------------------
// Windmill: the millstone grinds osu! API calls; sacks are the minute budget.

function windmillInterior(): Interior {
  const f = roomRect(13, 9);
  const exit = exitFor(f);
  const cx = f.x + Math.floor(f.w / 2) - 6;
  const cy = f.y + 58;

  return {
    id: "windmill",
    label: "WINDMILL",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-mill", rect: { x: cx - 28, y: cy - 30, w: 56, h: 50 }, label: "MILLSTONE" },
      { id: "int-sacks", rect: { x: f.x + f.w - 30, y: f.y + 4, w: 30, h: 110 }, label: "FLOUR SACKS" },
    ],
    solids: [
      { x: cx - 26, y: cy - 12, w: 52, h: 24 },
      { x: f.x + f.w - 24, y: f.y + 6, w: 24, h: 104 },
      { x: f.x, y: f.y, w: 30, h: 40 },
    ],
    drawBase: (ctx, sim, _s, hour) => {
      const k = kit();
      drawShell(ctx, f, "stone", "#b8b0a8");
      tileFloor(ctx, f, 88);
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + 44, f.y - 32, 12, 14, hour, null);
      drawLantern(ctx, f.x + f.w - 44, f.y - 30, sim.t);
      spr(ctx, k.stairs, f.x + 1, f.y - 8);
      rect(ctx, cx - 3, f.y - WALL_H, 6, WALL_H + (cy - f.y) - 20, OUTLINE);
      rect(ctx, cx - 2, f.y - WALL_H, 4, WALL_H + (cy - f.y) - 20, "#7a5030");
      rect(ctx, cx - 2, f.y - WALL_H, 1, WALL_H + (cy - f.y) - 20, "#9a6a3e");
      const ang = sim.t * (0.5 + sim.windmillSpeed * 3);
      const gy = f.y - 20;
      disk(ctx, cx, gy, 12, OUTLINE);
      disk(ctx, cx, gy, 11, "#6a4426");
      disk(ctx, cx, gy, 8, "#8a5a33");
      ctx.fillStyle = "#5a3920";
      for (let i = 0; i < 8; i++) {
        const a = ang + (i * Math.PI) / 4;
        ctx.fillRect(Math.round(cx + Math.cos(a) * 11) - 1, Math.round(gy + Math.sin(a) * 11) - 1, 3, 3);
      }
      line(ctx, cx + Math.cos(ang) * 7, gy + Math.sin(ang) * 7, cx - Math.cos(ang) * 7, gy - Math.sin(ang) * 7, "#5a3920");
      disk(ctx, cx, gy, 2, "#3a2416");
      rect(ctx, f.x + f.w - 23, f.y + 7, 21, 102, OUTLINE);
      rect(ctx, f.x + f.w - 22, f.y + 8, 19, 100, "#8a5a33");
      for (let y = f.y + 12; y < f.y + 108; y += 6) rect(ctx, f.x + f.w - 22, y, 19, 1, "#6a4426");
    },
    drawables: (sim) => {
      const k = kit();
      const out: InteriorDrawable[] = [
        {
          baseline: cy + 14,
          draw: (ctx) => {
            const ang = sim.t * (0.5 + sim.windmillSpeed * 3);
            ellipse(ctx, cx, cy + 5, 27, 12, OUTLINE);
            ellipse(ctx, cx, cy + 4, 26, 11, "#5f5a60");
            ellipse(ctx, cx, cy, 26, 11, OUTLINE);
            ellipse(ctx, cx, cy - 1, 25, 10, "#9d989c");
            ellipse(ctx, cx, cy - 2, 21, 8, "#b3aeb0");
            ctx.fillStyle = "#7a767e";
            for (let rr = 6; rr <= 20; rr++) {
              for (let q = 0; q < 4; q++) {
                const a = ang + (q * Math.PI) / 2;
                ctx.fillRect(Math.round(cx + Math.cos(a) * rr), Math.round(cy - 2 + Math.sin(a) * rr * 0.4), 2, 1);
              }
            }
            disk(ctx, cx, cy - 2, 3, "#5f5a60");
            if (sim.windmillSpeed > 0.12) {
              ctx.fillStyle = "#f4efe4";
              const d = Math.floor(sim.t * 6) % 4;
              ctx.fillRect(cx - 22 + d * 2, cy + 8, 1, 1);
              ctx.fillRect(cx + 18 - d, cy + 9, 1, 1);
              ctx.fillRect(cx - 10 + d * 3, cy + 11, 1, 1);
            }
          },
        },
        { baseline: cy - 12, draw: (ctx) => spr(ctx, k.hopper, cx - 13, cy - 30) },
      ];
      const r = sim.status?.rate;
      const n = r ? clamp(Math.round((r.usedLastMinute / Math.max(1, r.targetPerMinute)) * 6), r.usedLastMinute > 0 ? 1 : 0, 6) : 0;
      for (let i = 0; i < n; i++) {
        const sy = f.y + 8 + i * 16;
        out.push({ baseline: sy + 15, draw: (ctx) => spr(ctx, k.sack, f.x + f.w - 19, sy) });
      }
      return out;
    },
    drawOverlay: (ctx, _sim, _s, hour) => {
      roomOverlay(ctx, f, hour, [{ x: f.x + f.w - 41, y: f.y - 24, r: 40, color: "rgba(255,214,120,0.5)", a: 0.9 }]);
    },
  };
}

// ---------------------------------------------------------------------------
// Silo: one round storage room. The grain heap grows with database storage.

function siloInterior(): Interior {
  const f = roomRect(8, 7);
  const exit = exitFor(f);
  const heap = { x: f.x + f.w / 2, y: f.y + 44 };

  return {
    id: "silo",
    label: "SILO",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [{ id: "silo", rect: { x: f.x + 8, y: f.y - 20, w: f.w - 16, h: 80 }, label: "GRAIN" }],
    solids: [
      { x: heap.x - 40, y: heap.y - 18, w: 80, h: 26 },
      { x: f.x, y: f.y + f.h - 30, w: 34, h: 14 },
    ],
    drawBase: (ctx) => {
      drawShell(ctx, f, "stone", "#c2bdb6");
      tileFloor(ctx, f, 21, "#a8a29c");
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
      // ladder up the wall + fill marks
      for (let y = f.y - WALL_H + 4; y < f.y; y++) {
        rect(ctx, f.x + f.w - 18, y, 1, 1, "#6a6560");
        rect(ctx, f.x + f.w - 12, y, 1, 1, "#6a6560");
        if (y % 4 === 0) rect(ctx, f.x + f.w - 18, y, 7, 1, "#8a8580");
      }
      for (let i = 1; i < 4; i++) rect(ctx, f.x + 4, f.y - 6 - i * 9, 8, 1, "#6a6560");
    },
    drawables: (sim) => [
      {
        baseline: heap.y + 8,
        draw: (ctx) => {
          const fill = clamp(sim.siloFill, 0, 1);
          const rx = 16 + fill * 30;
          const ry = 5 + fill * 16;
          const full = fill > 0.85;
          const grain = full ? "#e0a050" : "#e2c060";
          ellipse(ctx, heap.x, heap.y + 1, rx + 1, ry * 0.5 + 1, OUTLINE);
          // the heap: a squashed dome with a lit left flank
          for (let dy = 0; dy <= ry; dy++) {
            const t = dy / Math.max(1, ry);
            const half = rx * Math.sqrt(1 - t * t);
            rect(ctx, heap.x - half, heap.y - dy, half * 2, 1, dy === Math.round(ry) ? shade(grain, 0.3) : grain);
            rect(ctx, heap.x - half, heap.y - dy, Math.max(1, half * 0.5), 1, shade(grain, 0.15));
            rect(ctx, heap.x + half * 0.6, heap.y - dy, half * 0.4, 1, shade(grain, -0.15));
          }
          ellipse(ctx, heap.x, heap.y + 1, rx, ry * 0.5, shade(grain, -0.1));
          const rng = mulberry32(3);
          for (let i = 0; i < 20 * fill; i++) rect(ctx, heap.x - rx * 0.8 + rng() * rx * 1.6, heap.y - rng() * ry * 0.8, 1, 1, shade(grain, -0.3));
          // grain trickling from the chute when writes are busy
          if (sim.hayBales > 1) {
            ctx.fillStyle = grain;
            for (let i = 0; i < 6; i++) ctx.fillRect(heap.x, f.y - WALL_H + ((sim.t * 60 + i * 11) % (heap.y - ry - f.y + WALL_H)), 1, 2);
          }
          rect(ctx, heap.x - 4, f.y - WALL_H, 8, 4, "#5a5652");
        },
      },
      { baseline: f.y + f.h - 16, draw: (ctx) => spr(ctx, kit().sack, f.x + 4, f.y + f.h - 32) },
      { baseline: f.y + f.h - 14, draw: (ctx) => spr(ctx, kit().sack, f.x + 16, f.y + f.h - 30) },
    ],
    drawOverlay: (ctx, _sim, _s, hour) => roomOverlay(ctx, f, hour, []),
  };
}

// ---------------------------------------------------------------------------
// General store: the shopkeeper logs every pageview on the ledger.

function storeInterior(): Interior {
  const f = roomRect(16, 8);
  const exit = exitFor(f);
  const counter = { x: f.x + 30, y: f.y + 30 };
  const keeper = { x: counter.x + 60, y: counter.y - 2 };

  return {
    id: "store",
    label: "GENERAL STORE",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "store", rect: { x: counter.x, y: counter.y - 24, w: 98, h: 50 }, label: "COUNTER" },
      { id: "int-goods", rect: { x: f.x + 4, y: f.y - 36, w: f.w - 8, h: 40 }, label: "SHELVES" },
    ],
    solids: [
      { x: counter.x, y: counter.y + 4, w: 98, h: 18 },
      { x: f.x, y: f.y, w: f.w, h: 8 },
      { x: f.x + 4, y: f.y + f.h - 30, w: 36, h: 14 },
      { x: f.x + f.w - 40, y: f.y + f.h - 30, w: 36, h: 14 },
    ],
    drawBase: (ctx, _sim, _s, hour) => {
      const k = kit();
      drawShell(ctx, f, "diamonds", "#d8e4d0");
      woodFloor(ctx, f, 301, 0.04);
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
      for (let i = 0; i < 5; i++) {
        if (i === 2) {
          drawWindow(ctx, f.x + 18 + i * 44 + 6, f.y - 34, 22, 14, hour, "#c9483c");
          continue;
        }
        spr(ctx, k.goodsShelf[i % 3], f.x + 10 + i * 44, f.y - 36);
      }
      drawRug(ctx, f.x + f.w / 2 - 30, f.y + f.h - 40, 60, 30, "#2f7a7a", "#efe3c6");
    },
    drawables: (sim, s) => {
      const k = kit();
      const recent = sim.visitors?.recent.length ?? 0;
      return [
        personDrawable(s, 3, keeper.x, keeper.y),
        {
          baseline: counter.y + 24,
          draw: (ctx) => {
            spr(ctx, k.counter, counter.x, counter.y);
            // the ledger: one inked line per recent pageview
            rect(ctx, counter.x + 34, counter.y - 1, 22, 8, OUTLINE);
            rect(ctx, counter.x + 35, counter.y, 20, 6, "#f4f0e6");
            rect(ctx, counter.x + 45, counter.y, 1, 6, "#c9c2b2");
            for (let i = 0; i < Math.min(recent, 6); i++) rect(ctx, counter.x + 36 + (i >= 3 ? 10 : 0), counter.y + 1 + (i % 3) * 2, 7, 1, "#5a5a8a");
          },
        },
        { baseline: f.y + f.h - 14, draw: (ctx) => spr(ctx, k.barrel, f.x + 6, f.y + f.h - 32) },
        { baseline: f.y + f.h - 14, draw: (ctx) => spr(ctx, k.crate, f.x + 22, f.y + f.h - 30) },
        { baseline: f.y + f.h - 14, draw: (ctx) => spr(ctx, k.sack, f.x + f.w - 38, f.y + f.h - 30) },
        { baseline: f.y + f.h - 14, draw: (ctx) => spr(ctx, k.barrel, f.x + f.w - 22, f.y + f.h - 32) },
      ];
    },
    drawOverlay: (ctx, _sim, _s, hour) => {
      roomOverlay(ctx, f, hour, [{ x: f.x + f.w / 2, y: f.y + 20, r: 60, color: "rgba(255,214,120,0.45)", a: 0.8 }]);
    },
  };
}

// ---------------------------------------------------------------------------
// Greenhouse: every seedling is a chart the pattern analyzer has read; failed
// analyses wilt.

function greenhouseInterior(): Interior {
  const f = roomRect(16, 8);
  const exit = exitFor(f);
  const beds = [
    { x: f.x + 14, y: f.y + 16 },
    { x: f.x + f.w - 108, y: f.y + 16 },
    { x: f.x + 14, y: f.y + 62 },
    { x: f.x + f.w - 108, y: f.y + 62 },
  ];

  return {
    id: "greenhouse",
    label: "GREENHOUSE",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: beds.map((b) => ({ id: "greenhouse", rect: { x: b.x, y: b.y - 14, w: 92, h: 34 }, label: "PLANTER" })),
    solids: beds.map((b) => ({ x: b.x, y: b.y + 6, w: 92, h: 12 })),
    drawBase: (ctx, _sim, _s, hour) => {
      drawShell(ctx, f, "glass", "#9fd0ea", hour);
      tileFloor(ctx, f, 41, "#a8a8a0");
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
    },
    drawables: (sim) => {
      const k = kit();
      const a = sim.status?.analysis;
      const total = a ? a.analyzed + a.failed : 0;
      const wiltShare = total > 0 ? (a!.failed / total) : 0;
      const out: InteriorDrawable[] = [];
      beds.forEach((b, bi) => {
        out.push({
          baseline: b.y + 18,
          draw: (ctx) => {
            spr(ctx, k.planter, b.x, b.y);
            for (let i = 0; i < 9; i++) {
              const slot = bi * 9 + i;
              const wilted = hash2(slot, 1, 7) < wiltShare;
              const stage = a && a.analyzed > 0 ? 2 - (slot % 3 === 0 ? 1 : 0) : 0;
              const sp = wilted ? k.seedling[3] : k.seedling[stage];
              spr(ctx, sp, b.x + 4 + i * 10, b.y - 7);
            }
          },
        });
      });
      out.push({ baseline: f.y + f.h - 10, draw: (ctx) => spr(ctx, k.wateringCan, f.x + f.w - 30, f.y + f.h - 22) });
      out.push({ baseline: f.y + f.h - 6, draw: (ctx) => spr(ctx, k.tallPlant, f.x + 4, f.y + f.h - 34) });
      // sprinkler drops while analyses are running
      if (a && a.running > 0) {
        out.push({
          baseline: f.y + f.h,
          draw: (ctx) => {
            ctx.fillStyle = "#bfe6f5";
            for (let i = 0; i < 18; i++) {
              const b = beds[i % beds.length];
              const ph = (sim.t * 1.4 + i * 0.37) % 1;
              ctx.fillRect(Math.round(b.x + 8 + ((i * 29) % 80)), Math.round(b.y - 26 + ph * 20), 1, 2);
            }
          },
        });
      }
      return out;
    },
    drawOverlay: (ctx, _sim, _s, hour) => roomOverlay(ctx, f, hour, []),
  };
}

// ---------------------------------------------------------------------------
// Village cottages: one per top country. The resident matches the house.

const COTTAGE_PAPER: Array<{ paper: Paper; color: string }> = [
  { paper: "stripes", color: "#dfe6ee" },
  { paper: "diamonds", color: "#e8d8c0" },
  { paper: "planks", color: "#b88a55" },
  { paper: "stripes", color: "#e8e0b8" },
  { paper: "diamonds", color: "#d8e4d0" },
  { paper: "stone", color: "#b8b0a8" },
  { paper: "stripes", color: "#f0dcd8" },
];
const RUGS = ["#4f7a4a", "#4a6fb0", "#a04438", "#7a5a9a", "#c8803a", "#2f7a7a"];

function cottageInterior(index: number, variant: number): Interior {
  const f = roomRect(12, 7);
  const exit = exitFor(f);
  const bed = { x: f.x + 6, y: f.y - 10 };
  const table = { x: f.x + 84, y: f.y + 40 };
  const shelf = { x: f.x + f.w - 38, y: f.y - 34 };
  const resident = { x: f.x + 150, y: f.y + 78 };
  const look = COTTAGE_PAPER[variant % COTTAGE_PAPER.length];
  const blanket = variant % BLANKETS.length;

  return {
    id: `house-${index}`,
    label: "VILLAGE HOUSE",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "cottage-bed", rect: { x: bed.x, y: bed.y, w: 28, h: 42 }, label: "BED" },
      { id: `house-${index}`, rect: { x: f.x + 40, y: f.y - 36, w: 60, h: 26 }, label: "BANNER" },
    ],
    solids: [
      { x: bed.x, y: f.y, w: 28, h: bed.y + 40 - f.y },
      { x: shelf.x, y: f.y, w: 32, h: 6 },
      { x: table.x, y: table.y + 4, w: 32, h: 16 },
    ],
    dynamicHotspots: (sim) =>
      sim.housesRanked[index]
        ? [{ id: `resident-${index}`, rect: { x: resident.x - 9, y: resident.y - 26, w: 18, h: 28 }, label: "RESIDENT" }]
        : [],
    drawBase: (ctx, sim, _s, hour) => {
      const k = kit();
      const c = sim.housesRanked[index] ?? null;
      drawShell(ctx, f, look.paper, look.color);
      woodFloor(ctx, f, 140 + index * 13, (variant % 3) * -0.06);
      wallShadow(ctx, f);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + 108, f.y - 34, 16, 13, hour, RUGS[(variant + 2) % RUGS.length]);
      drawBanner(ctx, f.x + 46, f.y - 36, RUGS[variant % RUGS.length]);
      const code = c ? c.country : "";
      const pw = Math.max(18, textWidth(code) + 8);
      rect(ctx, f.x + 67, f.y - 33, pw + 2, 13, OUTLINE);
      rect(ctx, f.x + 68, f.y - 32, pw, 11, "#7a5030");
      rect(ctx, f.x + 68, f.y - 32, pw, 1, "#9a6a3e");
      if (code) drawText(ctx, code, f.x + 72, f.y - 30, "#f4f0e6");
      drawPainting(ctx, f.x + 142, f.y - 32, 12, 9, 11 + index);
      drawRug(ctx, f.x + 70, f.y + 30, 60, 40, RUGS[variant % RUGS.length], "#efe3c6");
      spr(ctx, k.bookshelf[index % 3], shelf.x, shelf.y);
      spr(ctx, k.bed[blanket], bed.x, bed.y);
      if (!c) {
        drawCobweb(ctx, f.x + f.w + SIDE - 2, f.y - WALL_H + 3, true);
        drawCobweb(ctx, f.x - SIDE + 1, f.y - WALL_H + 3, false);
      }
    },
    drawables: (sim, s) => {
      const k = kit();
      const c = sim.housesRanked[index] ?? null;
      const out: InteriorDrawable[] = [
        {
          baseline: table.y + 22,
          draw: (ctx) => {
            spr(ctx, k.smallTable, table.x, table.y);
            if (c) drawCandle(ctx, table.x + 14, table.y + 5, sim.t);
            else rect(ctx, table.x + 13, table.y + 7, 4, 2, "#8a8272");
          },
        },
        { baseline: table.y + 36, draw: (ctx) => spr(ctx, k.chair, table.x + 8, table.y + 16) },
        { baseline: f.y + f.h - 6, draw: (ctx) => spr(ctx, k.plant, f.x + f.w - 20, f.y + f.h - 22) },
      ];
      if (c) out.push(personDrawable(s, index, resident.x, resident.y));
      return out;
    },
    drawOverlay: (ctx, sim, _s, hour) => {
      const glows: Glow[] = sim.housesRanked[index]
        ? [{ x: table.x + 15, y: table.y + 3, r: 30, color: "rgba(255,214,120,0.55)", a: 0.9 }]
        : [];
      roomOverlay(ctx, f, hour, glows);
    },
  };
}

// ---------------------------------------------------------------------------

export function buildInteriors(map: ValleyMap): Record<string, Interior> {
  const interiors: Record<string, Interior> = {
    farmhouse: farmhouseInterior(),
    barn: barnInterior(),
    coop: coopInterior(),
    windmill: windmillInterior(),
    silo: siloInterior(),
    store: storeInterior(),
    greenhouse: greenhouseInterior(),
  };
  map.villageHouses.forEach((h, i) => {
    interiors[`house-${i}`] = cottageInterior(i, h.variant);
  });
  return interiors;
}
