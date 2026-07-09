// Static world layout: terrain grid, building placements, walk graph,
// crop plots and interactive hotspots. Deterministic (seeded) so the map
// looks identical on every visit.

import { MAP_W, MAP_H, TILE, mulberry32 } from "./core";
import type { Rect } from "./sprites";

export enum T {
  GRASS = 0,
  PATH = 1,
  WATER = 2,
  SOIL = 3,
  BRIDGE = 4,
}

export interface Placement {
  kind:
    | "farmhouse"
    | "barn"
    | "silo"
    | "coop"
    | "windmill"
    | "well"
    | "house"
    | "oak"
    | "pine"
    | "bush"
    | "flower"
    | "tuft"
    | "rock"
    | "stump"
    | "signpost"
    | "mailbox"
    | "lamp"
    | "boat"
    | "hay";
  x: number; // px, top-left
  y: number;
  variant: number;
}

export interface Hotspot {
  id: string;
  rect: Rect;
  label: string;
}

export interface WalkGraph {
  nodes: Array<{ x: number; y: number }>; // px centers
  edges: number[][]; // adjacency by node index
}

export interface ValleyMap {
  terrain: Uint8Array; // MAP_W * MAP_H
  placements: Placement[];
  hotspots: Hotspot[];
  graph: WalkGraph;
  fieldRect: Rect; // px, fenced field
  fieldPlots: Array<{ x: number; y: number }>; // px, crop anchor points
  seedbedRect: Rect; // px, deferred-jobs nursery
  seedbedPlots: Array<{ x: number; y: number }>;
  penRect: Rect; // px, chicken pen interior
  villageHouses: Array<{ x: number; y: number; variant: number }>;
  riverCenter: (yTile: number) => number; // tile x of river center
  bridgeRect: Rect; // px
  fences: Array<{ x: number; y: number; kind: "h" | "v" | "post" }>; // px anchors
  solidTiles: Uint8Array; // water + fences
  solidRects: Rect[]; // building footprints, tree trunks
}

export function isSolidAt(map: ValleyMap, x: number, y: number): boolean {
  if (x < 2 || y < 2 || x >= MAP_W * TILE - 2 || y >= MAP_H * TILE - 2) return true;
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (map.solidTiles[ty * MAP_W + tx]) return true;
  for (const r of map.solidRects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

export function tileAt(terrain: Uint8Array, tx: number, ty: number): T {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T.GRASS;
  return terrain[ty * MAP_W + tx] as T;
}

const RIVER_HALF = 2;

function riverCenter(yTile: number): number {
  return 32 + 1.8 * Math.sin(yTile * 0.42 + 1.2);
}

export function buildMap(): ValleyMap {
  const rng = mulberry32(20260709);
  const terrain = new Uint8Array(MAP_W * MAP_H).fill(T.GRASS);
  const set = (tx: number, ty: number, t: T) => {
    if (tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H) terrain[ty * MAP_W + tx] = t;
  };

  // --- river ---
  for (let ty = 0; ty < MAP_H; ty++) {
    const cx = riverCenter(ty);
    for (let tx = Math.floor(cx - RIVER_HALF); tx <= Math.ceil(cx + RIVER_HALF); tx++) {
      if (Math.abs(tx - cx) <= RIVER_HALF) set(tx, ty, T.WATER);
    }
  }

  // --- paths (2 tiles wide) ---
  const stampH = (x0: number, x1: number, y: number) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (tileAt(terrain, x, y) !== T.WATER) set(x, y, T.PATH);
      if (tileAt(terrain, x, y + 1) !== T.WATER) set(x, y + 1, T.PATH);
    }
  };
  const stampV = (y0: number, y1: number, x: number) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      if (tileAt(terrain, x, y) !== T.WATER) set(x, y, T.PATH);
      if (tileAt(terrain, x + 1, y) !== T.WATER) set(x + 1, y, T.PATH);
    }
  };

  stampV(6, 8, 5); // farmhouse door down
  stampH(4, 46, 8); // main east-west road
  stampV(4, 8, 25); // windmill spur
  stampV(8, 22, 12); // west farm lane
  stampH(6, 12, 14); // barn branch
  stampH(6, 12, 20); // coop branch
  stampV(8, 13, 42); // village spur
  stampV(8, 10, 15); // field gate

  // --- bridge over river on the main road ---
  const bridgeCx = riverCenter(8.5);
  const bx0 = Math.floor(bridgeCx - RIVER_HALF) - 1;
  const bx1 = Math.ceil(bridgeCx + RIVER_HALF) + 1;
  for (let x = bx0; x <= bx1; x++) {
    set(x, 8, T.BRIDGE);
    set(x, 9, T.BRIDGE);
  }
  const bridgeRect: Rect = { x: bx0 * TILE, y: 8 * TILE - 4, w: (bx1 - bx0 + 1) * TILE, h: 2 * TILE + 8 };

  // --- field (fenced, tilled) ---
  // x0 = 14 keeps the west fence one tile clear of the farm lane (x 12-13),
  // so lane walkers never overlap the fence posts
  const fieldTiles = { x0: 14, y0: 10, x1: 28, y1: 17 };
  for (let ty = fieldTiles.y0 + 1; ty < fieldTiles.y1; ty++) {
    for (let tx = fieldTiles.x0 + 1; tx < fieldTiles.x1; tx++) {
      set(tx, ty, T.SOIL);
    }
  }
  const fieldRect: Rect = {
    x: fieldTiles.x0 * TILE,
    y: fieldTiles.y0 * TILE,
    w: (fieldTiles.x1 - fieldTiles.x0 + 1) * TILE,
    h: (fieldTiles.y1 - fieldTiles.y0 + 1) * TILE,
  };

  // crop plots: 12 cols x 5 rows inside the field
  const fieldPlots: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 12; col++) {
      fieldPlots.push({
        x: (fieldTiles.x0 + 1) * TILE + 8 + col * 18 + Math.floor(rng() * 2),
        y: (fieldTiles.y0 + 1) * TILE + 10 + row * 19 + Math.floor(rng() * 2),
      });
    }
  }

  // --- seedbed (deferred jobs nursery) ---
  const seedTiles = { x0: 15, y0: 19, x1: 21, y1: 22 };
  for (let ty = seedTiles.y0; ty <= seedTiles.y1; ty++) {
    for (let tx = seedTiles.x0; tx <= seedTiles.x1; tx++) {
      set(tx, ty, T.SOIL);
    }
  }
  const seedbedRect: Rect = {
    x: seedTiles.x0 * TILE,
    y: seedTiles.y0 * TILE,
    w: (seedTiles.x1 - seedTiles.x0 + 1) * TILE,
    h: (seedTiles.y1 - seedTiles.y0 + 1) * TILE,
  };
  const seedbedPlots: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 8; col++) {
      seedbedPlots.push({
        x: seedTiles.x0 * TILE + 6 + col * 13 + Math.floor(rng() * 2),
        y: seedTiles.y0 * TILE + 6 + row * 15 + Math.floor(rng() * 2),
      });
    }
  }

  // --- chicken pen ---
  const penTiles = { x0: 2, y0: 22, x1: 9, y1: 25 };
  const penRect: Rect = {
    x: penTiles.x0 * TILE + 6,
    y: penTiles.y0 * TILE + 6,
    w: (penTiles.x1 - penTiles.x0 + 1) * TILE - 12,
    h: (penTiles.y1 - penTiles.y0 + 1) * TILE - 12,
  };

  // --- fences (field + pen perimeters, with gates) ---
  const fences: ValleyMap["fences"] = [];
  // Every piece is a post; "h"/"v" additionally carry a rail toward the next
  // post. A piece whose neighbor is missing (run end or gate opening) is a
  // bare "post", so rails never dangle past a corner or into a gate.
  const fenceRun = (x0: number, y0: number, x1: number, y1: number, gate?: { x: number; y: number; span: number }) => {
    if (y0 === y1) {
      const inGate = (x: number) => !!gate && y0 === gate.y && x >= gate.x && x < gate.x + gate.span;
      for (let x = x0; x <= x1; x++) {
        if (inGate(x)) continue;
        const hasNext = x < x1 && !inGate(x + 1);
        fences.push({ x: x * TILE, y: y0 * TILE, kind: hasNext ? "h" : "post" });
      }
    } else {
      const inGate = (y: number) => !!gate && x0 === gate.x && y >= gate.y && y < gate.y + gate.span;
      for (let y = y0; y <= y1; y++) {
        if (inGate(y)) continue;
        const hasNext = y < y1 && !inGate(y + 1);
        fences.push({ x: x0 * TILE, y: y * TILE, kind: hasNext ? "v" : "post" });
      }
    }
  };
  fenceRun(fieldTiles.x0, fieldTiles.y0, fieldTiles.x1, fieldTiles.y0, { x: 15, y: fieldTiles.y0, span: 2 });
  fenceRun(fieldTiles.x0, fieldTiles.y1, fieldTiles.x1, fieldTiles.y1);
  fenceRun(fieldTiles.x0, fieldTiles.y0, fieldTiles.x0, fieldTiles.y1);
  fenceRun(fieldTiles.x1, fieldTiles.y0, fieldTiles.x1, fieldTiles.y1);
  fenceRun(penTiles.x0, penTiles.y0, penTiles.x1, penTiles.y0, { x: 6, y: penTiles.y0, span: 1 });
  fenceRun(penTiles.x0, penTiles.y1, penTiles.x1, penTiles.y1);
  fenceRun(penTiles.x0, penTiles.y0, penTiles.x0, penTiles.y1);
  fenceRun(penTiles.x1, penTiles.y0, penTiles.x1, penTiles.y1);

  // --- buildings ---
  const placements: Placement[] = [];
  const villageHouses = [
    { x: 584, y: 66, variant: 0 },
    { x: 636, y: 52, variant: 1 },
    { x: 692, y: 66, variant: 2 },
    { x: 592, y: 172, variant: 2 },
    { x: 628, y: 224, variant: 0 },
    { x: 704, y: 172, variant: 1 },
  ];

  placements.push(
    { kind: "farmhouse", x: 44, y: 32, variant: 0 },
    { kind: "mailbox", x: 136, y: 80, variant: 0 },
    { kind: "windmill", x: 384, y: 12, variant: 0 },
    { kind: "barn", x: 18, y: 168, variant: 0 },
    { kind: "silo", x: 92, y: 160, variant: 0 },
    { kind: "hay", x: 116, y: 208, variant: 0 },
    { kind: "well", x: 178, y: 130, variant: 0 },
    { kind: "coop", x: 30, y: 296, variant: 0 },
    { kind: "signpost", x: 678, y: 228, variant: 0 },
    { kind: "boat", x: 500, y: 386, variant: 0 },
    ...villageHouses.map((h) => ({ kind: "house" as const, x: h.x, y: h.y, variant: h.variant })),
  );

  // lamps along the road
  for (const [lx, ly] of [
    [150, 116],
    [330, 116],
    [560, 116],
    [740, 116],
    [180, 300],
    [716, 236],
  ] as const) {
    placements.push({ kind: "lamp", x: lx, y: ly, variant: 0 });
  }

  // --- decorative nature, avoiding water/paths/soil/buildings ---
  const blocked: Rect[] = [
    { x: 30, y: 20, w: 130, h: 90 }, // farmhouse
    { x: 380, y: 8, w: 60, h: 70 }, // windmill
    { x: 10, y: 160, w: 130, h: 70 }, // barn+silo
    { x: 170, y: 124, w: 40, h: 36 }, // well
    { x: 24, y: 290, w: 60, h: 48 }, // coop
    { x: fieldRect.x - 8, y: fieldRect.y - 8, w: fieldRect.w + 16, h: fieldRect.h + 16 },
    { x: seedbedRect.x - 8, y: seedbedRect.y - 8, w: seedbedRect.w + 16, h: seedbedRect.h + 16 },
    { x: penRect.x - 10, y: penRect.y - 10, w: penRect.w + 20, h: penRect.h + 20 },
    { x: 495, y: 380, w: 40, h: 24 }, // boat
    ...villageHouses.map((h) => ({ x: h.x - 6, y: h.y - 6, w: 46, h: 44 })),
  ];
  const isBlocked = (x: number, y: number, w: number, h: number): boolean => {
    for (const b of blocked) {
      if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) return true;
    }
    // keep off water/path/soil tiles (check corners + center)
    for (const [px2, py2] of [
      [x + 2, y + h - 2],
      [x + w - 2, y + h - 2],
      [x + w / 2, y + h / 2],
    ] as const) {
      const t = tileAt(terrain, Math.floor(px2 / TILE), Math.floor(py2 / TILE));
      if (t !== T.GRASS) return true;
    }
    return false;
  };

  // treeline top and edges
  for (let tx = 0; tx < MAP_W; tx += 1) {
    if (rng() < 0.72) {
      const x = tx * TILE + Math.floor(rng() * 8) - 4;
      const y = -14 + Math.floor(rng() * 10);
      if (!isBlocked(x, y + 14, 20, 16)) {
        placements.push({ kind: rng() < 0.6 ? "oak" : "pine", x, y, variant: Math.floor(rng() * 3) });
      }
    }
  }
  for (let ty = 1; ty < MAP_H; ty += 1) {
    for (const ex of [0, MAP_W - 1]) {
      if (rng() < 0.5) {
        const x = ex * TILE + (ex === 0 ? -6 : -2) + Math.floor(rng() * 6);
        const y = ty * TILE - 16 + Math.floor(rng() * 8);
        if (!isBlocked(x, y + 12, 20, 18)) {
          placements.push({ kind: rng() < 0.55 ? "pine" : "oak", x, y, variant: Math.floor(rng() * 3) });
        }
      }
    }
  }
  for (let tx = 1; tx < MAP_W - 1; tx += 1) {
    if (rng() < 0.4) {
      const x = tx * TILE + Math.floor(rng() * 10) - 5;
      const y = (MAP_H - 1) * TILE - 10 + Math.floor(rng() * 10);
      if (!isBlocked(x, y, 20, 26)) {
        placements.push({ kind: rng() < 0.6 ? "oak" : "pine", x, y, variant: Math.floor(rng() * 3) });
      }
    }
  }

  // scattered interior decor
  const scatter: Array<[Placement["kind"], number, number]> = [
    ["bush", 14, 11],
    ["flower", 5, 7],
    ["tuft", 7, 6],
    ["rock", 11, 8],
  ];
  for (let i = 0; i < 210; i++) {
    const [kind, w, h] = scatter[Math.floor(rng() * scatter.length)];
    const x = Math.floor(rng() * (MAP_W * TILE - 24)) + 8;
    const y = Math.floor(rng() * (MAP_H * TILE - 60)) + 36;
    if (isBlocked(x, y, w, h)) continue;
    placements.push({ kind, x, y, variant: Math.floor(rng() * 3) });
  }
  // a couple of stumps near the treeline
  placements.push({ kind: "stump", x: 240, y: 44, variant: 0 }, { kind: "stump", x: 470, y: 330, variant: 0 });

  // --- walk graph (px centers of path nodes) ---
  const N = (tx: number, ty: number) => ({ x: tx * TILE + TILE, y: ty * TILE + TILE });
  const nodes = [
    N(5, 6), // 0 farmhouse door
    N(5, 8), // 1
    N(12, 8), // 2 west junction
    N(15, 8), // 3 field gate (top)
    N(25, 8), // 4 windmill junction
    N(25, 5), // 5 windmill door
    N(29, 8), // 6 bridge west
    N(36, 8), // 7 bridge east
    N(42, 8), // 8 village crossroads
    N(46, 8), // 9 east end
    N(42, 13), // 10 village plaza
    N(12, 14), // 11 barn junction
    N(6, 14), // 12 barn door
    N(12, 20), // 13 coop junction
    N(6, 20), // 14 coop door
    N(12, 22), // 15 south end
    N(38, 8), // 16 village west
  ];
  const edges: number[][] = nodes.map(() => []);
  const link = (a: number, b: number) => {
    edges[a].push(b);
    edges[b].push(a);
  };
  link(0, 1);
  link(1, 2);
  link(2, 3);
  link(3, 4);
  link(4, 5);
  link(4, 6);
  link(6, 7);
  link(7, 16);
  link(16, 8);
  link(8, 9);
  link(8, 10);
  link(2, 11);
  link(11, 12);
  link(11, 13);
  link(13, 14);
  link(13, 15);

  // --- hotspots ---
  const hotspots: Hotspot[] = [
    { id: "farmhouse", rect: { x: 44, y: 32, w: 84, h: 60 }, label: "FARMHOUSE" },
    { id: "windmill", rect: { x: 384, y: 12, w: 50, h: 58 }, label: "WINDMILL" },
    { id: "barn", rect: { x: 18, y: 168, w: 68, h: 52 }, label: "BARN" },
    { id: "silo", rect: { x: 92, y: 160, w: 20, h: 62 }, label: "SILO" },
    { id: "well", rect: { x: 178, y: 130, w: 20, h: 24 }, label: "WELL" },
    { id: "field", rect: fieldRect, label: "CROP FIELD" },
    { id: "seedbed", rect: seedbedRect, label: "SEEDBED" },
    { id: "coop", rect: { x: 30, y: 296, w: 44, h: 34 }, label: "COOP" },
    { id: "pen", rect: penRect, label: "CHICKEN PEN" },
    { id: "river", rect: bridgeRect, label: "RIVER" },
    { id: "signpost", rect: { x: 674, y: 224, w: 22, h: 22 }, label: "VILLAGE SIGN" },
    ...villageHouses.map((h, i) => ({
      id: `house-${i}`,
      rect: { x: h.x, y: h.y, w: 34, h: 31 },
      label: "VILLAGE HOUSE",
    })),
  ];

  // --- collision (player) ---
  const solidTiles = new Uint8Array(MAP_W * MAP_H);
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (tileAt(terrain, tx, ty) === T.WATER) solidTiles[ty * MAP_W + tx] = 1;
    }
  }
  for (const f of fences) {
    const tx = Math.floor(f.x / TILE);
    const ty = Math.floor(f.y / TILE);
    if (tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H) solidTiles[ty * MAP_W + tx] = 1;
  }

  const solidRects: Rect[] = [];
  const foot = (x: number, y: number, w: number, h: number, frac = 0.62) => {
    solidRects.push({ x, y: y + h * (1 - frac), w, h: h * frac });
  };
  for (const p of placements) {
    switch (p.kind) {
      case "farmhouse":
        foot(p.x, p.y, 84, 60);
        break;
      case "barn":
        foot(p.x, p.y, 68, 52);
        break;
      case "silo":
        foot(p.x, p.y, 20, 62, 0.3);
        break;
      case "coop":
        foot(p.x, p.y, 44, 34);
        break;
      case "windmill":
        foot(p.x, p.y, 34, 58, 0.45);
        break;
      case "well":
        foot(p.x, p.y, 20, 24, 0.6);
        break;
      case "house":
        foot(p.x, p.y, 34, 31);
        break;
      case "oak":
        solidRects.push({ x: p.x + 6, y: p.y + 21, w: 10, h: 8 });
        break;
      case "pine":
        solidRects.push({ x: p.x + 5, y: p.y + 22, w: 8, h: 7 });
        break;
      case "hay":
        solidRects.push({ x: p.x, y: p.y, w: 30, h: 12 });
        break;
      case "signpost":
        solidRects.push({ x: p.x + 4, y: p.y + 8, w: 6, h: 7 });
        break;
      default:
        break;
    }
  }

  return {
    terrain,
    placements,
    hotspots,
    graph: { nodes, edges },
    fieldRect,
    fieldPlots,
    seedbedRect,
    seedbedPlots,
    penRect,
    villageHouses,
    riverCenter,
    bridgeRect,
    fences,
    solidTiles,
    solidRects,
  };
}
