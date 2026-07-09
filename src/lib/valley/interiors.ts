// Enterable building interiors. Each room is a small self-contained scene
// (shell, floor, furniture, dynamic props driven by backend status) laid out
// in world-canvas coordinates, so the outdoor camera/zoom pipeline frames it
// unchanged. The world-side door definitions live here too, keeping map.ts
// purely about the outdoor layout.

import { C, TILE, VIEW_W, VIEW_H, clamp, mulberry32, type Ctx } from "./core";
import { drawText, textWidth } from "./font";
import type { Rect, ValleySprites } from "./sprites";
import type { Hotspot, ValleyMap } from "./map";
import type { ValleySim } from "./sim";

const WALL_H = 26; // back-wall face height
const VOID = "#050508";

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
// Doors (world side). Offsets mirror the door geometry baked into sprites.ts.

export function buildDoors(map: ValleyMap): DoorDef[] {
  const doors: DoorDef[] = [];
  const add = (id: string, x: number, base: number, doorX: number, doorW: number, doorH: number) => {
    doors.push({
      id,
      rect: { x: x + doorX - 1, y: base - doorH - 2, w: doorW + 2, h: doorH + 8 },
      trigger: { x: x + doorX, y: base + 1, w: doorW, h: 6 },
      outside: { x: x + doorX + doorW / 2, y: base + 9 },
    });
  };
  for (const p of map.placements) {
    if (p.kind === "farmhouse") add("farmhouse", p.x, p.y + 60, 36, 12, 17);
    else if (p.kind === "barn") add("barn", p.x, p.y + 52, 24, 20, 22);
    else if (p.kind === "coop") add("coop", p.x, p.y + 34, 8, 9, 11);
    else if (p.kind === "windmill") add("windmill", p.x, p.y + 58, 11, 12, 12);
  }
  map.villageHouses.forEach((h, i) => add(`house-${i}`, h.x, h.y + 31, 7, 8, 11));
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
// Shared geometry + furniture kit

function roomRect(wTiles: number, hTiles: number): Rect {
  const w = wTiles * TILE;
  const h = hTiles * TILE;
  return { x: Math.round((VIEW_W - w) / 2), y: Math.round((VIEW_H - h) / 2) + 10, w, h };
}

function exitFor(f: Rect): Rect {
  return { x: f.x + f.w / 2 - 10, y: f.y + f.h - 8, w: 20, h: 8 };
}

function spawnFor(f: Rect): { x: number; y: number } {
  return { x: f.x + f.w / 2, y: f.y + f.h - 18 };
}

// 0 = day, 1 = night; roughly tracks the outdoor sky tint keyframes.
function nightAmount(hour: number): number {
  if (hour >= 21 || hour < 5) return 1;
  if (hour >= 18.5) return (hour - 18.5) / 2.5;
  if (hour < 6.7) return 1 - (hour - 5) / 1.7;
  return 0;
}

function rct(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function diskAt(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  for (let dy = -Math.round(r); dy <= Math.round(r); dy++) {
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    ctx.fillRect(Math.round(cx - half), Math.round(cy + dy), Math.max(1, Math.round(half * 2)), 1);
  }
}

function flatDisk(ctx: Ctx, cx: number, cy: number, r: number, squash: number, color: string): void {
  ctx.fillStyle = color;
  const ry = Math.max(1, Math.round(r * squash));
  for (let dy = -ry; dy <= ry; dy++) {
    const t = dy / ry;
    const half = r * Math.sqrt(Math.max(0, 1 - t * t));
    ctx.fillRect(Math.round(cx - half), Math.round(cy + dy), Math.max(1, Math.round(half * 2)), 1);
  }
}

function drawShell(ctx: Ctx, f: Rect, wall: [string, string]): void {
  rct(ctx, f.x - 8, f.y - WALL_H - 8, f.w + 16, f.h + WALL_H + 16, VOID);
  // back wall face
  rct(ctx, f.x - 5, f.y - WALL_H - 5, f.w + 10, WALL_H + 5, wall[0]);
  rct(ctx, f.x - 5, f.y - WALL_H - 5, f.w + 10, 2, wall[1]);
  rct(ctx, f.x - 5, f.y - 3, f.w + 10, 3, wall[1]);
  // side + bottom frame
  rct(ctx, f.x - 5, f.y, 5, f.h + 5, wall[1]);
  rct(ctx, f.x + f.w, f.y, 5, f.h + 5, wall[1]);
  rct(ctx, f.x - 5, f.y + f.h, f.w + 10, 5, wall[1]);
}

function drawExitDoor(ctx: Ctx, f: Rect, exit: Rect): void {
  // opening through the bottom frame + welcome mat
  rct(ctx, exit.x, f.y + f.h, exit.w, 7, VOID);
  rct(ctx, exit.x + 1, exit.y, exit.w - 2, exit.h, "#b3543f");
  rct(ctx, exit.x + 1, exit.y, exit.w - 2, 1, "#8e332c");
  rct(ctx, exit.x + 1, exit.y + exit.h - 1, exit.w - 2, 1, "#8e332c");
  rct(ctx, exit.x + 4, exit.y + 2, exit.w - 8, exit.h - 4, "#c9694f");
}

function woodFloor(ctx: Ctx, f: Rect, seed: number): void {
  const rng = mulberry32(seed);
  rct(ctx, f.x, f.y, f.w, f.h, C.woodLight);
  // long planks: low-contrast seams, sparse staggered joints
  ctx.fillStyle = "#96683a";
  for (let y = 0; y < f.h; y += 7) {
    ctx.fillRect(f.x, f.y + y, f.w, 1);
  }
  for (let y = 0; y < f.h; y += 7) {
    const off = 10 + (Math.floor(y / 7) % 3) * 18;
    for (let x = off; x < f.w; x += 54) {
      ctx.fillRect(f.x + x, f.y + y, 1, 7);
    }
  }
  ctx.fillStyle = "#b8845055";
  for (let i = 0; i < (f.w * f.h) / 130; i++) {
    ctx.fillRect(f.x + Math.floor(rng() * (f.w - 3)), f.y + Math.floor(rng() * f.h), 3, 1);
  }
}

function stoneFloor(ctx: Ctx, f: Rect, seed: number): void {
  const rng = mulberry32(seed);
  rct(ctx, f.x, f.y, f.w, f.h, C.stone);
  for (let ty = 0; ty < f.h; ty += TILE) {
    for (let tx = 0; tx < f.w; tx += TILE) {
      const r = rng();
      if (r < 0.18) rct(ctx, f.x + tx, f.y + ty, TILE, TILE, C.stoneLight);
      else if (r < 0.32) rct(ctx, f.x + tx, f.y + ty, TILE, TILE, "#8d8d8d");
      ctx.fillStyle = C.stoneDark;
      ctx.fillRect(f.x + tx, f.y + ty, f.w - tx < TILE ? f.w - tx : TILE, 1);
      ctx.fillRect(f.x + tx, f.y + ty, 1, f.h - ty < TILE ? f.h - ty : TILE);
    }
  }
}

function dirtFloor(ctx: Ctx, f: Rect, seed: number, straw: number): void {
  const rng = mulberry32(seed);
  rct(ctx, f.x, f.y, f.w, f.h, C.soil);
  ctx.fillStyle = C.soilDark;
  for (let i = 0; i < (f.w * f.h) / 60; i++) {
    ctx.fillRect(f.x + Math.floor(rng() * f.w), f.y + Math.floor(rng() * f.h), 2, 1);
  }
  ctx.fillStyle = C.soilRow;
  for (let i = 0; i < (f.w * f.h) / 90; i++) {
    ctx.fillRect(f.x + Math.floor(rng() * f.w), f.y + Math.floor(rng() * f.h), 1, 1);
  }
  ctx.fillStyle = C.hay;
  for (let i = 0; i < straw; i++) {
    ctx.fillRect(f.x + Math.floor(rng() * (f.w - 3)), f.y + Math.floor(rng() * f.h), 2 + Math.floor(rng() * 2), 1);
  }
}

function drawWindow(ctx: Ctx, x: number, y: number, w: number, h: number, hour: number): void {
  const n = nightAmount(hour);
  rct(ctx, x - 1, y - 1, w + 2, h + 2, C.woodDark);
  const sky = n > 0.75 ? "#1d2b52" : n > 0.25 ? "#c98550" : "#8fc3e8";
  rct(ctx, x, y, w, h, sky);
  if (n > 0.75) {
    rct(ctx, x + 2, y + 2, 1, 1, "#e8e4d4");
    rct(ctx, x + w - 3, y + 3, 1, 1, "#e8e4d4");
  } else if (n <= 0.25) {
    rct(ctx, x + 1, y + 1, 3, 1, "#ffffff70");
  }
  rct(ctx, x + Math.floor(w / 2), y, 1, h, C.woodDark);
  rct(ctx, x, y + Math.floor(h / 2), w, 1, C.woodDark);
  rct(ctx, x - 1, y + h + 1, w + 2, 1, C.woodLight);
}

function drawFlame(ctx: Ctx, cx: number, baseY: number, t: number): void {
  const fl = Math.floor(t * 7) % 2;
  rct(ctx, cx - 3, baseY - 4, 6, 4, "#e8642f");
  rct(ctx, cx - 2, baseY - 6 + fl, 4, 2, "#e8642f");
  rct(ctx, cx - 1 - fl, baseY - 4, 2, 3, "#ffd554");
  rct(ctx, cx - (1 - fl), baseY - 2, 1, 1, "#fff6c8");
}

function drawFireplace(ctx: Ctx, x: number, y: number, lit: boolean, t: number): void {
  const rng = mulberry32(17);
  rct(ctx, x, y, 26, WALL_H + 6, C.stoneDark);
  rct(ctx, x + 1, y + 1, 24, WALL_H + 4, C.stone);
  ctx.fillStyle = C.stoneDark;
  for (let i = 0; i < 12; i++) {
    ctx.fillRect(x + 2 + Math.floor(rng() * 22), y + 2 + Math.floor(rng() * (WALL_H + 2)), 2, 1);
  }
  rct(ctx, x - 1, y + 7, 28, 2, C.woodDark); // mantle
  rct(ctx, x + 5, y + 10, 16, 15, "#120c08"); // opening
  rct(ctx, x + 7, y + 21, 12, 2, C.trunk); // logs
  rct(ctx, x + 9, y + 19, 8, 2, C.trunkDark);
  if (lit) drawFlame(ctx, x + 13, y + 21, t);
  else rct(ctx, x + 10, y + 20, 6, 1, "#4a4a4a"); // cold ashes
}

function drawBed(ctx: Ctx, x: number, y: number, w: number, h: number, blanket: string): void {
  rct(ctx, x, y, w, h, C.woodDarker);
  rct(ctx, x + 1, y + 1, w - 2, h - 2, C.wood);
  rct(ctx, x + 3, y + 3, w - 6, 7, "#f4f0e6");
  rct(ctx, x + 3, y + 8, w - 6, 2, "#cfc9bd");
  rct(ctx, x + 2, y + 11, w - 4, h - 14, blanket);
  rct(ctx, x + 2, y + 11, w - 4, 2, "rgba(0,0,0,0.18)");
  rct(ctx, x + 4, y + 16, w - 8, 2, "rgba(255,255,255,0.14)");
  rct(ctx, x, y + h - 2, w, 2, C.woodDarker);
}

function drawShelfBooks(ctx: Ctx, x: number, y: number, seed: number): void {
  const rng = mulberry32(seed);
  rct(ctx, x, y, 26, 30, C.woodDarker);
  rct(ctx, x + 2, y + 2, 22, 26, C.wood);
  const spines = [C.roofRed, C.roofBlue, C.roofGreen, C.hay, C.flowerPink, C.wallCream];
  for (let row = 0; row < 3; row++) {
    const sy = y + 3 + row * 9;
    rct(ctx, x + 2, sy, 22, 7, "#3a2a1c");
    let bx = x + 3;
    while (bx < x + 21) {
      const bw = 2 + Math.floor(rng() * 2);
      rct(ctx, bx, sy + 1 + Math.floor(rng() * 2), bw, 6, spines[Math.floor(rng() * spines.length)]);
      bx += bw + 1;
      if (rng() < 0.18) bx += 2;
    }
    rct(ctx, x + 2, sy + 7, 22, 2, C.woodDarker);
  }
}

function drawTable(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  rct(ctx, x + 2, y + h, 3, 5, C.woodDark);
  rct(ctx, x + w - 5, y + h, 3, 5, C.woodDark);
  rct(ctx, x, y, w, h, C.woodDarker);
  rct(ctx, x + 1, y + 1, w - 2, h - 4, C.woodLight);
  rct(ctx, x + 1, y + h - 3, w - 2, 2, C.wood);
}

function drawChair(ctx: Ctx, x: number, y: number): void {
  rct(ctx, x, y, 10, 3, C.woodDark);
  rct(ctx, x, y + 3, 10, 6, C.wood);
  rct(ctx, x + 1, y + 9, 2, 4, C.woodDark);
  rct(ctx, x + 7, y + 9, 2, 4, C.woodDark);
}

function drawCandle(ctx: Ctx, x: number, y: number, t: number): void {
  rct(ctx, x - 1, y + 4, 4, 1, C.woodDarker);
  rct(ctx, x, y, 2, 4, "#f4f0e6");
  ctx.fillStyle = Math.floor(t * 8) % 2 === 0 ? "#ffd554" : "#ffb03a";
  ctx.fillRect(x, y - 2, 2, 2);
}

function drawLantern(ctx: Ctx, x: number, y: number, t: number): void {
  rct(ctx, x + 2, y, 2, 2, C.woodDarker);
  rct(ctx, x, y + 2, 6, 8, C.woodDarker);
  ctx.fillStyle = Math.floor(t * 6) % 2 === 0 ? C.windowGlow : "#ffcf66";
  ctx.fillRect(x + 1, y + 3, 4, 6);
  rct(ctx, x + 1, y + 10, 4, 1, C.woodDarker);
}

function drawCrate(ctx: Ctx, x: number, y: number): void {
  rct(ctx, x, y, 14, 12, C.woodDark);
  rct(ctx, x + 1, y + 1, 12, 10, C.plank);
  ctx.fillStyle = C.woodDark;
  for (let i = 0; i < 9; i++) {
    ctx.fillRect(x + 2 + i, y + 1 + i, 1, 1);
    ctx.fillRect(x + 11 - i, y + 1 + i, 1, 1);
  }
  rct(ctx, x + 1, y + 1, 12, 1, C.woodLight);
}

function drawBarrel(ctx: Ctx, x: number, y: number): void {
  rct(ctx, x, y, 12, 14, C.woodDark);
  rct(ctx, x + 1, y + 1, 10, 12, C.wood);
  rct(ctx, x, y + 3, 12, 1, C.stoneDark);
  rct(ctx, x, y + 9, 12, 1, C.stoneDark);
  rct(ctx, x + 2, y + 1, 2, 12, C.woodLight);
}

function drawSack(ctx: Ctx, x: number, y: number): void {
  rct(ctx, x + 1, y + 3, 8, 9, "#d8c188");
  rct(ctx, x + 1, y + 10, 8, 2, "#b8a06a");
  rct(ctx, x + 2, y + 1, 6, 3, "#c9b077");
  rct(ctx, x + 3, y, 4, 1, C.woodDarker);
  rct(ctx, x + 2, y + 5, 2, 1, "#ffffff40");
}

function drawChalkboard(ctx: Ctx, x: number, y: number, lines: string[]): void {
  rct(ctx, x - 2, y - 2, 80, 30, C.woodDark);
  rct(ctx, x, y, 76, 26, "#233428");
  lines.forEach((ln, i) => drawText(ctx, ln, x + 4, y + 4 + i * 10, "#cfe3d2"));
}

function drawNestBox(ctx: Ctx, x: number, y: number, eggs: number): void {
  rct(ctx, x, y, 18, 14, C.woodDark);
  rct(ctx, x + 1, y + 1, 16, 12, C.wood);
  rct(ctx, x + 2, y + 6, 14, 6, C.hayDark);
  rct(ctx, x + 3, y + 7, 12, 4, C.hay);
  for (let i = 0; i < Math.min(eggs, 3); i++) {
    rct(ctx, x + 3 + i * 4, y + 7, 3, 3, "#f4efe4");
    rct(ctx, x + 3 + i * 4, y + 7, 1, 1, "#ffffff");
  }
}

function drawTrough(ctx: Ctx, x: number, y: number): void {
  rct(ctx, x, y, 26, 8, C.woodDark);
  rct(ctx, x + 1, y + 1, 24, 6, C.wood);
  rct(ctx, x + 2, y + 2, 22, 3, C.hayDark);
  rct(ctx, x + 3, y + 2, 20, 2, C.hay);
}

function drawBanner(ctx: Ctx, x: number, y: number, color: string): void {
  rct(ctx, x - 1, y, 14, 1, C.woodDark);
  rct(ctx, x, y + 1, 12, 9, color);
  rct(ctx, x, y + 10, 4, 3, color);
  rct(ctx, x + 8, y + 10, 4, 3, color);
  rct(ctx, x, y + 1, 12, 1, "#ffffff30");
}

function drawCobweb(ctx: Ctx, x: number, y: number): void {
  ctx.fillStyle = "rgba(228,228,228,0.3)";
  for (let i = 0; i < 7; i++) {
    ctx.fillRect(x + i, y + i, 1, 1);
    ctx.fillRect(x + 7, y + i, 1, 1);
    ctx.fillRect(x + i, y + 7, 1, 1);
  }
}

function drawCat(ctx: Ctx, x: number, y: number, t: number): void {
  const breathe = Math.sin(t * 2.2) > 0 ? 1 : 0;
  // curled sleeping cat
  flatDisk(ctx, x + 6, y + 3 - breathe, 6, 0.6, "#b06a2c");
  flatDisk(ctx, x + 6, y + 2 - breathe, 5, 0.6, "#d98c3f");
  rct(ctx, x + 3, y + 1 - breathe, 2, 1, "#b06a2c");
  rct(ctx, x + 7, y - breathe, 2, 1, "#b06a2c");
  // head + ears
  diskAt(ctx, x + 2, y + 2, 2.4, "#d98c3f");
  rct(ctx, x, y - 1, 1, 2, "#d98c3f");
  rct(ctx, x + 3, y - 1, 1, 2, "#d98c3f");
  // closed eye + tail
  rct(ctx, x + 1, y + 2, 2, 1, "#5a3a1e");
  rct(ctx, x + 4, y + 5, 7, 1, "#b06a2c");
}

function roomOverlay(ctx: Ctx, f: Rect, hour: number, glows: Glow[]): void {
  const n = nightAmount(hour);
  if (n <= 0.02) return;
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = 0.45 * n;
  ctx.fillStyle = "rgb(64,70,116)";
  ctx.fillRect(f.x - 8, f.y - WALL_H - 8, f.w + 16, f.h + WALL_H + 16);
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

// ---------------------------------------------------------------------------
// Farmhouse: the server's home. Fire burns while the server is healthy.

function farmhouseInterior(): Interior {
  const f = roomRect(14, 8);
  const exit = exitFor(f);
  const bed = { x: f.x + 10, y: f.y + 6, w: 22, h: 34 };
  const shelf = { x: f.x + 60, y: f.y - 16 };
  const fire = { x: f.x + 150, y: f.y - WALL_H };
  const table = { x: f.x + 96, y: f.y + 58, w: 40, h: 22 };
  const cat = { x: f.x + 168, y: f.y + 96 };

  return {
    id: "farmhouse",
    label: "FARMHOUSE",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-bed", rect: { x: f.x + 8, y: f.y + 2, w: 26, h: 40 }, label: "BED" },
      { id: "int-hearth", rect: { x: fire.x - 2, y: fire.y - 2, w: 30, h: WALL_H + 10 }, label: "HEARTH" },
      { id: "int-journal", rect: { x: table.x - 2, y: table.y - 4, w: table.w + 4, h: table.h + 10 }, label: "JOURNAL" },
      { id: "int-cat", rect: { x: cat.x - 3, y: cat.y - 4, w: 18, h: 13 }, label: "CAT" },
    ],
    solids: [
      { x: bed.x, y: f.y + 2, w: bed.w, h: bed.y + bed.h - 6 - f.y },
      { x: shelf.x, y: f.y, w: 26, h: 12 },
      { x: fire.x + 2, y: f.y, w: 22, h: 5 },
      { x: table.x, y: table.y + 4, w: table.w, h: table.h - 2 },
    ],
    drawBase: (ctx, sim, _s, hour) => {
      drawShell(ctx, f, [C.wallCream, C.wallCreamDark]);
      woodFloor(ctx, f, 71);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + 20, f.y - 21, 12, 11, hour);
      drawWindow(ctx, f.x + 110, f.y - 21, 12, 11, hour);
      drawShelfBooks(ctx, shelf.x, shelf.y, 31);
      drawFireplace(ctx, fire.x, fire.y, sim.serverOk, sim.t);
      // rug
      rct(ctx, f.x + 78, f.y + 46, 80, 46, "#8e332c");
      rct(ctx, f.x + 80, f.y + 48, 76, 42, "#b3543f");
      rct(ctx, f.x + 84, f.y + 52, 68, 34, "#a04438");
      drawBed(ctx, bed.x, bed.y, bed.w, bed.h, C.roofBlue);
    },
    drawables: (sim) => [
      {
        baseline: table.y + table.h + 5,
        draw: (ctx) => {
          drawTable(ctx, table.x, table.y, table.w, table.h);
          // open journal on the table
          rct(ctx, table.x + 6, table.y + 6, 12, 9, "#f4f0e6");
          rct(ctx, table.x + 12, table.y + 6, 1, 9, "#c9c2b2");
          rct(ctx, table.x + 8, table.y + 8, 3, 1, "#8a8272");
          rct(ctx, table.x + 8, table.y + 10, 3, 1, "#8a8272");
          rct(ctx, table.x + 14, table.y + 9, 3, 1, "#8a8272");
          drawCandle(ctx, table.x + 30, table.y + 8, sim.t);
        },
      },
      {
        baseline: table.y + 20,
        draw: (ctx) => drawChair(ctx, table.x - 15, table.y + 4),
      },
      {
        baseline: cat.y + 9,
        draw: (ctx) => drawCat(ctx, cat.x, cat.y, sim.t),
      },
    ],
    drawOverlay: (ctx, sim, _s, hour) => {
      const glows: Glow[] = [{ x: table.x + 31, y: table.y + 6, r: 16, color: "rgba(255,214,120,0.55)", a: 0.8 }];
      if (sim.serverOk) glows.push({ x: fire.x + 13, y: f.y - 5, r: 34, color: "rgba(255,150,70,0.6)", a: 0.9 });
      roomOverlay(ctx, f, hour, glows);
    },
  };
}

// ---------------------------------------------------------------------------
// Barn: the SQLite storeroom. Crates on the shelf mirror the queue depth,
// the hay pile mirrors the WAL, the chalkboard tallies live numbers.

function barnInterior(): Interior {
  const f = roomRect(15, 9);
  const exit = exitFor(f);
  const shelfSolid = { x: f.x + 8, y: f.y, w: 132, h: 10 };
  const hay = { x: f.x + f.w - 56, y: f.y + f.h - 40 };
  const board = { x: f.x + 156, y: f.y - 25 };

  return {
    id: "barn",
    label: "BARN",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-crates", rect: { x: f.x + 6, y: f.y - 20, w: 136, h: 32 }, label: "CRATES" },
      { id: "int-board", rect: { x: board.x - 4, y: board.y - 3, w: 84, h: 32 }, label: "CHALKBOARD" },
      { id: "int-hay", rect: { x: hay.x - 4, y: hay.y - 10, w: 40, h: 36 }, label: "HAY PILE" },
    ],
    solids: [
      shelfSolid,
      { x: hay.x - 2, y: hay.y - 4, w: 36, h: 24 },
      { x: f.x + 11, y: f.y + f.h - 32, w: 12, h: 10 },
      { x: f.x + 27, y: f.y + f.h - 26, w: 12, h: 10 },
    ],
    drawBase: (ctx, sim, _s, _hour) => {
      drawShell(ctx, f, ["#a04438", "#7e332a"]);
      dirtFloor(ctx, f, 55, 90);
      drawExitDoor(ctx, f, exit);
      // crate shelf: rough plank pallet along the back wall
      rct(ctx, f.x + 8, f.y - 2, 132, 10, C.woodDark);
      rct(ctx, f.x + 9, f.y - 1, 130, 8, C.plank);
      ctx.fillStyle = C.woodDark;
      for (let x = f.x + 16; x < f.x + 138; x += 12) ctx.fillRect(x, f.y - 1, 1, 8);
      const qd = sim.status?.queueDepth ?? 0;
      const crates = clamp(Math.ceil(qd / 4), qd > 0 ? 1 : 0, 15);
      for (let i = 0; i < crates; i++) {
        if (i < 8) drawCrate(ctx, f.x + 10 + i * 16, f.y - 8);
        else drawCrate(ctx, f.x + 18 + (i - 8) * 16, f.y - 19);
      }
      const dLabel = sim.status ? String(Math.min(sim.status.deferred, 9999)) : "?";
      const qLabel = sim.status ? String(Math.min(qd, 9999)) : "?";
      drawChalkboard(ctx, board.x, board.y, [`QUEUE ${qLabel}`, `DEFER ${dLabel}`]);
      drawLantern(ctx, f.x + 144, f.y - 20, sim.t);
    },
    drawables: (sim, s) => [
      {
        baseline: hay.y + 24,
        draw: (ctx) => {
          for (let i = 0; i < clamp(sim.hayBales, 1, 4); i++) {
            const col = i % 2;
            const row = Math.floor(i / 2);
            ctx.drawImage(s.hayBale.canvas, hay.x + col * 15, hay.y + 10 - row * 9);
          }
          ctx.fillStyle = C.hayDark;
          ctx.fillRect(hay.x + 4, hay.y + 22, 24, 1);
        },
      },
      { baseline: f.y + f.h - 18, draw: (ctx) => drawBarrel(ctx, f.x + 12, f.y + f.h - 32) },
      { baseline: f.y + f.h - 12, draw: (ctx) => drawBarrel(ctx, f.x + 28, f.y + f.h - 26) },
    ],
    drawOverlay: (ctx, _sim, _s, hour) => {
      roomOverlay(ctx, f, hour, [{ x: f.x + 147, y: f.y - 14, r: 30, color: "rgba(255,214,120,0.5)", a: 0.85 }]);
    },
  };
}

// ---------------------------------------------------------------------------
// Coop: SSE streams roost here. Eggs in the nest boxes are distinct IPs.

function coopInterior(): Interior {
  const f = roomRect(10, 6);
  const exit = exitFor(f);
  const nests = { x: f.x + f.w - 42, y: f.y - 6 };

  return {
    id: "coop",
    label: "COOP",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-roost", rect: { x: f.x + 6, y: f.y - 26, w: 100, h: 32 }, label: "ROOST" },
      { id: "int-nest", rect: { x: nests.x - 2, y: nests.y - 4, w: 42, h: 20 }, label: "NEST BOXES" },
    ],
    solids: [{ x: nests.x - 2, y: f.y, w: 42, h: 10 }],
    drawBase: (ctx, sim, s, hour) => {
      drawShell(ctx, f, [C.plank, C.woodDark]);
      dirtFloor(ctx, f, 77, 160);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + f.w - 74, f.y - 20, 10, 9, hour);
      const total = sim.status?.sseTotal ?? 0;
      // roosting chickens sit on the perch, legs hidden behind the bar
      const r1 = Math.min(total, 5);
      for (let i = 0; i < r1; i++) {
        const spr = (i % 2 === 0 ? s.chicken : s.chickenFlip)[Math.floor(sim.t * 2 + i) % 2];
        ctx.drawImage(spr.canvas, f.x + 12 + i * 17, f.y - 16);
      }
      rct(ctx, f.x + 8, f.y - 8, 96, 2, C.woodDark);
      rct(ctx, f.x + 10, f.y - 6, 2, 8, C.woodDarker);
      rct(ctx, f.x + 100, f.y - 6, 2, 8, C.woodDarker);
      const r2 = Math.min(Math.max(total - 5, 0), 3);
      for (let i = 0; i < r2; i++) {
        const spr = (i % 2 === 0 ? s.chickenFlip : s.chicken)[Math.floor(sim.t * 2 + i) % 2];
        ctx.drawImage(spr.canvas, f.x + 26 + i * 22, f.y - 27);
      }
      if (r2 > 0) rct(ctx, f.x + 22, f.y - 19, 60, 2, C.woodDark);
      const ips = sim.status?.sseIps ?? 0;
      drawNestBox(ctx, nests.x, nests.y, Math.min(ips, 3));
      drawNestBox(ctx, nests.x + 20, nests.y, Math.max(0, Math.min(ips - 3, 3)));
    },
    drawables: (sim, s) => {
      const out: InteriorDrawable[] = [
        { baseline: f.y + 54, draw: (ctx) => drawTrough(ctx, f.x + 18, f.y + 46) },
      ];
      if ((sim.status?.sseTotal ?? 0) > 0) {
        out.push({
          baseline: f.y + 62,
          draw: (ctx) => {
            const peck = Math.floor(sim.t * 2.4) % 3 === 0;
            const spr = s.chicken[peck ? 2 : Math.floor(sim.t * 4) % 2];
            ctx.drawImage(spr.canvas, f.x + 48, f.y + 50 - spr.h + 3);
          },
        });
      }
      return out;
    },
    drawOverlay: (ctx, _sim, _s, hour) => {
      roomOverlay(ctx, f, hour, []);
    },
  };
}

// ---------------------------------------------------------------------------
// Windmill: the millstone grinds osu! API calls; sacks are the minute budget.

function windmillInterior(): Interior {
  const f = roomRect(11, 8);
  const exit = exitFor(f);
  const cx = f.x + Math.floor(f.w / 2);
  const cy = f.y + 44;

  return {
    id: "windmill",
    label: "WINDMILL",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "int-mill", rect: { x: cx - 24, y: cy - 22, w: 48, h: 42 }, label: "MILLSTONE" },
      { id: "int-sacks", rect: { x: f.x + f.w - 26, y: f.y + 6, w: 26, h: 104 }, label: "FLOUR SACKS" },
    ],
    solids: [
      { x: cx - 22, y: cy - 10, w: 44, h: 22 },
      { x: f.x + f.w - 20, y: f.y + 8, w: 20, h: 100 },
    ],
    drawBase: (ctx, sim, _s, hour) => {
      drawShell(ctx, f, [C.wallCream, C.wallCreamDark]);
      stoneFloor(ctx, f, 88);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + 24, f.y - 21, 12, 11, hour);
      drawLantern(ctx, f.x + 8, f.y - 18, sim.t);
      // drive shaft from the cap above down to the stone, with a wall gear
      rct(ctx, cx - 2, f.y - WALL_H - 5, 4, WALL_H + 5 + (cy - f.y) - 12, C.woodDark);
      rct(ctx, cx - 2, f.y - WALL_H - 5, 1, WALL_H + 5 + (cy - f.y) - 12, C.woodDarker);
      const ang = sim.t * (0.5 + sim.windmillSpeed * 3);
      diskAt(ctx, cx, f.y - 12, 9, C.woodDark);
      diskAt(ctx, cx, f.y - 12, 6, C.wood);
      ctx.fillStyle = C.woodDarker;
      for (let k = 0; k < 6; k++) {
        const a = ang + (k * Math.PI) / 3;
        ctx.fillRect(Math.round(cx + Math.cos(a) * 8) - 1, Math.round(f.y - 12 + Math.sin(a) * 8) - 1, 3, 3);
      }
      diskAt(ctx, cx, f.y - 12, 2, C.woodDarker);
      // sack pallet along the right wall
      rct(ctx, f.x + f.w - 18, f.y + 10, 16, 98, C.woodDark);
      rct(ctx, f.x + f.w - 17, f.y + 11, 14, 96, C.plank);
    },
    drawables: (sim) => {
      const out: InteriorDrawable[] = [
        {
          baseline: cy + 15,
          draw: (ctx) => {
            const ang = sim.t * (0.5 + sim.windmillSpeed * 3);
            flatDisk(ctx, cx, cy + 3, 22, 0.55, "#5f5f5f");
            flatDisk(ctx, cx, cy, 22, 0.55, C.stone);
            flatDisk(ctx, cx, cy - 1, 19, 0.55, C.stoneLight);
            ctx.fillStyle = C.stoneDark;
            for (let rr = 5; rr <= 17; rr++) {
              for (const base of [ang, ang + Math.PI / 2]) {
                for (const sgn of [1, -1] as const) {
                  ctx.fillRect(
                    Math.round(cx + Math.cos(base) * rr * sgn),
                    Math.round(cy - 1 + Math.sin(base) * rr * sgn * 0.55),
                    2,
                    1,
                  );
                }
              }
            }
            diskAt(ctx, cx, cy - 1, 3, C.stoneDark);
            // flour dust while grinding
            if (sim.windmillSpeed > 0.12) {
              ctx.fillStyle = "#f4efe4";
              const d = Math.floor(sim.t * 5) % 3;
              ctx.fillRect(cx - 14 + d * 2, cy + 10, 1, 1);
              ctx.fillRect(cx + 12 - d, cy + 11, 1, 1);
            }
          },
        },
      ];
      const r = sim.status?.rate;
      const n = r ? clamp(Math.round((r.usedLastMinute / Math.max(1, r.targetPerMinute)) * 6), r.usedLastMinute > 0 ? 1 : 0, 6) : 0;
      for (let i = 0; i < n; i++) {
        const sy = f.y + 12 + i * 15;
        out.push({ baseline: sy + 13, draw: (ctx) => drawSack(ctx, f.x + f.w - 15, sy) });
      }
      return out;
    },
    drawOverlay: (ctx, _sim, _s, hour) => {
      roomOverlay(ctx, f, hour, [{ x: f.x + 11, y: f.y - 12, r: 30, color: "rgba(255,214,120,0.5)", a: 0.85 }]);
    },
  };
}

// ---------------------------------------------------------------------------
// Village cottages: one per top country. The resident matches the house.

const COTTAGE_BLANKETS = [C.roofBlue, C.roofRed, C.roofGreen];

function cottageInterior(index: number, variant: number): Interior {
  const f = roomRect(10, 6);
  const exit = exitFor(f);
  const bed = { x: f.x + 8, y: f.y + 4, w: 18, h: 28 };
  const table = { x: f.x + 62, y: f.y + 40, w: 28, h: 16 };
  const shelf = { x: f.x + 116, y: f.y - 14 };
  const resident = { x: f.x + 118, y: f.y + 62 };
  const wall: [string, string] = variant === 1 ? [C.plank, C.woodDark] : [C.wallCream, C.wallCreamDark];

  return {
    id: `house-${index}`,
    label: "VILLAGE HOUSE",
    floor: f,
    exit,
    spawn: spawnFor(f),
    hotspots: [
      { id: "cottage-bed", rect: { x: bed.x - 2, y: f.y, w: bed.w + 4, h: 34 }, label: "BED" },
      { id: `house-${index}`, rect: { x: f.x + 30, y: f.y - 26, w: 40, h: 22 }, label: "BANNER" },
    ],
    solids: [
      { x: bed.x, y: f.y + 2, w: bed.w, h: bed.y + bed.h - 8 - f.y },
      { x: shelf.x, y: f.y, w: 26, h: 12 },
      { x: table.x, y: table.y + 4, w: table.w, h: table.h - 2 },
    ],
    dynamicHotspots: (sim) =>
      sim.housesRanked[index]
        ? [{ id: `resident-${index}`, rect: { x: resident.x - 9, y: resident.y - 20, w: 18, h: 24 }, label: "RESIDENT" }]
        : [],
    drawBase: (ctx, sim, _s, hour) => {
      const c = sim.housesRanked[index] ?? null;
      drawShell(ctx, f, wall);
      woodFloor(ctx, f, 140 + index * 13);
      drawExitDoor(ctx, f, exit);
      drawWindow(ctx, f.x + 86, f.y - 20, 10, 9, hour);
      drawShelfBooks(ctx, shelf.x, shelf.y, 200 + index * 7);
      drawBanner(ctx, f.x + 32, f.y - 24, COTTAGE_BLANKETS[variant % COTTAGE_BLANKETS.length]);
      // country plaque next to the banner
      const code = c ? c.country : "";
      const pw = Math.max(14, textWidth(code) + 6);
      rct(ctx, f.x + 50, f.y - 21, pw, 11, C.woodDark);
      rct(ctx, f.x + 51, f.y - 20, pw - 2, 9, C.wood);
      if (code) drawText(ctx, code, f.x + 53, f.y - 19, "#f4f0e6");
      // small rug
      rct(ctx, f.x + 56, f.y + 34, 44, 30, "#3d6f3a");
      rct(ctx, f.x + 58, f.y + 36, 40, 26, "#4f8a4a");
      drawBed(ctx, bed.x, bed.y, bed.w, bed.h, COTTAGE_BLANKETS[variant % COTTAGE_BLANKETS.length]);
      if (!c) {
        drawCobweb(ctx, f.x + f.w - 12, f.y - WALL_H - 2);
        drawCobweb(ctx, f.x - 3, f.y - WALL_H - 2);
      }
    },
    drawables: (sim, s) => {
      const c = sim.housesRanked[index] ?? null;
      const out: InteriorDrawable[] = [
        {
          baseline: table.y + table.h + 5,
          draw: (ctx) => {
            drawTable(ctx, table.x, table.y, table.w, table.h);
            if (c) drawCandle(ctx, table.x + 13, table.y + 7, sim.t);
            else rct(ctx, table.x + 12, table.y + 7, 4, 2, "#8a8272"); // dusty unlit stub
          },
        },
      ];
      if (c) {
        out.push({
          baseline: resident.y + 1,
          draw: (ctx) => {
            const chars = s.villagers[index % s.villagers.length];
            const spr = chars.front[0];
            ctx.fillStyle = "rgba(20,24,16,0.25)";
            ctx.fillRect(Math.round(resident.x - 5), Math.round(resident.y - 2), 10, 3);
            ctx.drawImage(spr.canvas, Math.round(resident.x - spr.w / 2), Math.round(resident.y - spr.h));
          },
        });
      }
      return out;
    },
    drawOverlay: (ctx, sim, _s, hour) => {
      const glows: Glow[] = sim.housesRanked[index]
        ? [{ x: table.x + 14, y: table.y + 5, r: 22, color: "rgba(255,214,120,0.55)", a: 0.85 }]
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
  };
  map.villageHouses.forEach((h, i) => {
    interiors[`house-${i}`] = cottageInterior(i, h.variant);
  });
  return interiors;
}
