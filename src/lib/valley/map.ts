// Static world layout: roads as polylines (so every road ends on a real
// door), the river and pond as smooth shapes, buildings placed from their
// geometry specs, fields, fences, decor, the villager walk graph and the
// collision masks. Deterministic (seeded), identical on every visit.

import { MAP_W, MAP_H, TILE, WORLD_W, WORLD_H, mulberry32 } from "./core";
import { buildingSpec, HOUSE_STYLES, type BuildingSpec, type Rect } from "./buildings";
import { fbm } from "./paint";

export type { Rect };

export type DecorKind =
  | "oak"
  | "pine"
  | "birch"
  | "fruit"
  | "blossom"
  | "bush"
  | "berrybush"
  | "flowerbush"
  | "rock"
  | "mossrock"
  | "stump"
  | "log"
  | "tallgrass"
  | "reeds"
  | "lilypad"
  | "lamp"
  | "bench"
  | "barrel"
  | "crates"
  | "mailbox"
  | "signpost"
  | "noticeboard"
  | "hay"
  | "pot"
  | "cart"
  | "woodpile"
  | "boat"
  | "dock"
  | "scarecrowpost";

export interface Placement {
  kind: "building" | DecorKind;
  id: string; // building id ("farmhouse", "house3", ...) or decor kind
  x: number; // px, sprite top-left
  y: number;
  variant: number;
}

export interface Building {
  id: string; // sprite id
  key: string; // hotspot/interior id ("farmhouse", "house-3", ...)
  label: string;
  x: number;
  y: number;
  spec: BuildingSpec;
}

export interface Hotspot {
  id: string;
  rect: Rect;
  label: string;
}

export interface WalkGraph {
  nodes: Array<{ x: number; y: number }>;
  edges: number[][];
}

export interface Road {
  pts: Array<[number, number]>;
  width: number;
  kind: "dirt" | "cobble";
}

export interface ValleyMap {
  placements: Placement[];
  buildings: Building[];
  hotspots: Hotspot[];
  roads: Road[];
  plaza: { x: number; y: number; r: number };
  graph: WalkGraph;
  fieldRect: Rect; // px, fenced crop field
  fieldPlots: Array<{ x: number; y: number }>;
  seedbedRect: Rect;
  seedbedPlots: Array<{ x: number; y: number }>;
  penRect: Rect; // chicken pen interior
  pondRect: Rect;
  scarecrowAt: { x: number; y: number };
  villageHouses: Array<{ x: number; y: number; variant: number }>;
  riverCenter: (y: number) => number; // px x of the river center at px y
  riverHalf: (y: number) => number;
  bridges: Rect[]; // px decks
  fences: Array<{ x: number; y: number; kind: "h" | "v" | "post" }>; // px anchors
  water: Uint8Array; // per pixel: 0 land, 1 river, 2 pond
  soil: Uint8Array; // per tile
  solidRects: Rect[];
  wellAt: { x: number; y: number };
  fountainAt: { x: number; y: number };
}

// --- river + pond --------------------------------------------------------------

export function riverCenterAt(y: number): number {
  return 700 + 36 * Math.sin(y / 150 + 0.6) + 16 * Math.sin(y / 61 + 2.0);
}

export function riverHalfAt(y: number): number {
  return 23 + 4 * Math.sin(y / 97 + 1.3);
}

const POND = { cx: 1150, cy: 742, rx: 92, ry: 50 };

// signed distance to the water edge (negative inside), with a little noise so
// banks never read as perfect curves
export function waterSignedDist(x: number, y: number): { d: number; kind: 0 | 1 | 2 } {
  const wob = (fbm(x / 22, y / 22, 5) - 0.5) * 5;
  const dr = Math.abs(x - riverCenterAt(y)) - riverHalfAt(y) + wob;
  const ex = (x - POND.cx) / POND.rx;
  const ey = (y - POND.cy) / POND.ry;
  const dp = (Math.sqrt(ex * ex + ey * ey) - 1) * Math.min(POND.rx, POND.ry) + wob;
  if (dr < dp) return { d: dr, kind: dr < 0 ? 1 : 0 };
  return { d: dp, kind: dp < 0 ? 2 : 0 };
}

export function isSolidAt(map: ValleyMap, x: number, y: number): boolean {
  if (x < 4 || y < 4 || x >= WORLD_W - 4 || y >= WORLD_H - 4) return true;
  const xi = x | 0;
  const yi = y | 0;
  if (map.water[yi * WORLD_W + xi]) {
    let onBridge = false;
    for (const b of map.bridges) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y + 3 && y <= b.y + b.h - 2) {
        onBridge = true;
        break;
      }
    }
    if (!onBridge) return true;
  }
  for (const r of map.solidRects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

// point-to-segment distance
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function roadDist(roads: Road[], x: number, y: number, kind?: Road["kind"]): number {
  let best = Infinity;
  for (const r of roads) {
    if (kind && r.kind !== kind) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, ay] = r.pts[i];
      const [bx, by] = r.pts[i + 1];
      const d = segDist(x, y, ax, ay, bx, by) - r.width / 2;
      if (d < best) best = d;
    }
  }
  return best;
}

export function buildMap(): ValleyMap {
  const rng = mulberry32(20260924);

  // ---- buildings ---------------------------------------------------------------
  const buildings: Building[] = [];
  // place a building so its door centre lands on (doorX, groundY)
  const placeByDoor = (id: string, key: string, label: string, doorX: number, groundY: number): Building => {
    const spec = buildingSpec(id);
    const dc = spec.door ? spec.door.x + spec.door.w / 2 : spec.w / 2;
    const b = { id, key, label, x: Math.round(doorX - dc), y: Math.round(groundY - spec.base), spec };
    buildings.push(b);
    return b;
  };
  const placeAt = (id: string, key: string, label: string, x: number, y: number): Building => {
    const b = { id, key, label, x, y, spec: buildingSpec(id) };
    buildings.push(b);
    return b;
  };
  const doorOf = (b: Building): [number, number] => {
    const d = b.spec.door!;
    return [b.x + d.x + d.w / 2, b.y + b.spec.base + 3];
  };

  // farm (west of the river)
  const ROAD_Y = 212; // main east-west road centre
  const LANE_X = 204; // farm lane (north-south) centre
  const SOUTH_Y = 736; // southern road
  const farmhouse = placeByDoor("farmhouse", "farmhouse", "FARMHOUSE", 120, 168);
  const windmill = placeByDoor("windmill", "windmill", "WINDMILL", 452, 150);
  const well = placeAt("well", "well", "WELL", 292, 120);
  const barn = placeByDoor("barn", "barn", "BARN", 90, 382);
  const silo = placeAt("silo", "silo", "SILO", 146, 296);
  const coop = placeByDoor("coop", "coop", "COOP", 70, 520);
  const greenhouse = placeByDoor("greenhouse", "greenhouse", "GREENHOUSE", 352, 700);

  // village (east of the river)
  const PLAZA = { x: 1016, y: 336, r: 64 };
  const STREET2_Y = 468;
  const STREET3_Y = 628;
  // house centres + ground line; each gets a spur from its door to the street
  const houseSlots: Array<[number, number]> = [
    [842, ROAD_Y - 22],
    [928, ROAD_Y - 22],
    [1118, ROAD_Y - 22],
    [1204, ROAD_Y - 22],
    [842, STREET2_Y - 22],
    [924, STREET2_Y - 22],
    [1106, STREET2_Y - 22],
    [1188, STREET2_Y - 22],
    [838, STREET3_Y - 22],
    [924, STREET3_Y - 22],
    [1098, STREET3_Y - 22],
    [1184, STREET3_Y - 22],
    [868, SOUTH_Y - 22],
    [950, SOUTH_Y - 22],
  ];
  const store = placeByDoor("store", "store", "GENERAL STORE", 1020, ROAD_Y - 22);
  const villageHouses: ValleyMap["villageHouses"] = [];
  const houseBuildings: Building[] = houseSlots.map(([dx, gy], i) => {
    const variant = i % HOUSE_STYLES.length;
    const spec = buildingSpec(`house${variant}`);
    const b = placeAt(`house${variant}`, `house-${i}`, "VILLAGE HOUSE", Math.round(dx - spec.w / 2), gy - spec.base);
    villageHouses.push({ x: b.x, y: b.y, variant });
    return b;
  });
  const fountain = placeAt("fountain", "fountain", "FOUNTAIN", PLAZA.x - 30, PLAZA.y - 24);

  // ---- roads -------------------------------------------------------------------
  const roads: Road[] = [];
  const road = (pts: Array<[number, number]>, width = 26, kind: Road["kind"] = "dirt") => roads.push({ pts, width, kind });
  const spur = (b: Building, toY: number, width = 16) => {
    const [x, y] = doorOf(b);
    road(
      [
        [x, y - 4],
        [x, toY],
      ],
      width,
    );
  };

  const riverAtRoad = riverCenterAt(ROAD_Y);
  road([
    [30, ROAD_Y],
    [LANE_X, ROAD_Y],
    [452, ROAD_Y],
    [riverAtRoad - 60, ROAD_Y],
    [riverAtRoad + 60, ROAD_Y],
    [1020, ROAD_Y],
    [1250, ROAD_Y],
  ]);
  road([
    [LANE_X, ROAD_Y],
    [LANE_X, 382 + 22],
    [LANE_X, 520 + 22],
    [LANE_X, SOUTH_Y],
  ], 22);
  const riverAtSouth = riverCenterAt(SOUTH_Y);
  road([
    [LANE_X, SOUTH_Y],
    [352, SOUTH_Y],
    [riverAtSouth - 56, SOUTH_Y],
    [riverAtSouth + 56, SOUTH_Y],
    [868, SOUTH_Y],
    [1016, SOUTH_Y],
  ], 22);
  // village streets
  road([
    [1016, ROAD_Y],
    [1016, PLAZA.y],
    [1016, STREET2_Y],
    [1016, STREET3_Y],
    [1016, SOUTH_Y],
  ], 24);
  road([
    [790, STREET2_Y],
    [1016, STREET2_Y],
    [1240, STREET2_Y],
  ], 22);
  road([
    [790, STREET3_Y],
    [1016, STREET3_Y],
    [1240, STREET3_Y],
  ], 22);
  road([
    [1240, ROAD_Y],
    [1240, STREET2_Y],
    [1240, STREET3_Y],
  ], 20);
  // door spurs
  spur(farmhouse, ROAD_Y);
  spur(windmill, ROAD_Y);
  const [barnX, barnY] = doorOf(barn);
  road([
    [barnX, barnY - 4],
    [barnX, barnY + 20],
    [LANE_X, barnY + 20],
  ], 22);
  const [coopX, coopY] = doorOf(coop);
  road([
    [coopX, coopY - 4],
    [coopX, coopY + 20],
    [LANE_X, coopY + 20],
  ], 16);
  spur(greenhouse, SOUTH_Y);
  {
    const [sx, sy] = doorOf(silo);
    road([
      [sx, sy - 4],
      [sx, barnY + 20],
    ], 14);
  }
  spur(store, ROAD_Y, 20);
  for (const b of houseBuildings) {
    const [, gy] = doorOf(b);
    spur(b, gy + 16, 14);
  }
  // plaza ring
  road([[PLAZA.x, PLAZA.y], [PLAZA.x + 0.1, PLAZA.y]], PLAZA.r * 2, "cobble");

  // ---- water mask ----------------------------------------------------------------
  const water = new Uint8Array(WORLD_W * WORLD_H);
  for (let y = 0; y < WORLD_H; y++) {
    const cx = riverCenterAt(y);
    const hw = riverHalfAt(y) + 6;
    for (let x = Math.max(0, Math.floor(cx - hw)); x <= Math.min(WORLD_W - 1, Math.ceil(cx + hw)); x++) {
      const w = waterSignedDist(x, y);
      if (w.kind) water[y * WORLD_W + x] = w.kind;
    }
  }
  for (let y = POND.cy - POND.ry - 6; y <= POND.cy + POND.ry + 6; y++) {
    for (let x = POND.cx - POND.rx - 6; x <= POND.cx + POND.rx + 6; x++) {
      if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) continue;
      const w = waterSignedDist(x, y);
      if (w.kind) water[y * WORLD_W + x] = w.kind;
    }
  }
  const bridges: Rect[] = [
    { x: Math.round(riverAtRoad - 44), y: ROAD_Y - 17, w: 88, h: 34 },
    { x: Math.round(riverAtSouth - 42), y: SOUTH_Y - 15, w: 84, h: 30 },
  ];
  const pondRect: Rect = { x: POND.cx - POND.rx, y: POND.cy - POND.ry, w: POND.rx * 2, h: POND.ry * 2 };

  // ---- field, seedbed, pen -------------------------------------------------------
  const soil = new Uint8Array(MAP_W * MAP_H);
  const fieldTiles = { x0: 16, y0: 16, x1: 34, y1: 29 }; // fence ring, inclusive
  for (let ty = fieldTiles.y0 + 1; ty < fieldTiles.y1; ty++) {
    for (let tx = fieldTiles.x0 + 1; tx < fieldTiles.x1; tx++) soil[ty * MAP_W + tx] = 1;
  }
  const fieldRect: Rect = {
    x: fieldTiles.x0 * TILE,
    y: fieldTiles.y0 * TILE,
    w: (fieldTiles.x1 - fieldTiles.x0 + 1) * TILE,
    h: (fieldTiles.y1 - fieldTiles.y0 + 1) * TILE,
  };
  const fieldPlots: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 14; col++) {
      if (row >= 4 && col >= 11) continue; // scarecrow corner
      fieldPlots.push({
        x: (fieldTiles.x0 + 1) * TILE + 10 + col * 19,
        y: (fieldTiles.y0 + 1) * TILE + 20 + row * 31,
      });
    }
  }
  const scarecrowAt = { x: (fieldTiles.x1 - 2) * TILE, y: (fieldTiles.y1 - 3) * TILE };

  const seedTiles = { x0: 17, y0: 32, x1: 26, y1: 35 };
  for (let ty = seedTiles.y0; ty <= seedTiles.y1; ty++) {
    for (let tx = seedTiles.x0; tx <= seedTiles.x1; tx++) soil[ty * MAP_W + tx] = 2;
  }
  const seedbedRect: Rect = {
    x: seedTiles.x0 * TILE,
    y: seedTiles.y0 * TILE,
    w: (seedTiles.x1 - seedTiles.x0 + 1) * TILE,
    h: (seedTiles.y1 - seedTiles.y0 + 1) * TILE,
  };
  const seedbedPlots: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 12; col++) {
      seedbedPlots.push({ x: seedbedRect.x + 8 + col * 13, y: seedbedRect.y + 10 + row * 15 });
    }
  }

  const penTiles = { x0: 2, y0: 36, x1: 10, y1: 42 };
  const penRect: Rect = {
    x: penTiles.x0 * TILE + 8,
    y: penTiles.y0 * TILE + 10,
    w: (penTiles.x1 - penTiles.x0) * TILE - 12,
    h: (penTiles.y1 - penTiles.y0) * TILE - 14,
  };

  // ---- fences -------------------------------------------------------------------
  const fences: ValleyMap["fences"] = [];
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
  fenceRun(fieldTiles.x0, fieldTiles.y0, fieldTiles.x1, fieldTiles.y0, { x: 24, y: fieldTiles.y0, span: 3 });
  fenceRun(fieldTiles.x0, fieldTiles.y1, fieldTiles.x1, fieldTiles.y1);
  fenceRun(fieldTiles.x0, fieldTiles.y0, fieldTiles.x0, fieldTiles.y1);
  fenceRun(fieldTiles.x1, fieldTiles.y0, fieldTiles.x1, fieldTiles.y1);
  fenceRun(penTiles.x0, penTiles.y0, penTiles.x1, penTiles.y0, { x: 7, y: penTiles.y0, span: 2 });
  fenceRun(penTiles.x0, penTiles.y1, penTiles.x1, penTiles.y1);
  fenceRun(penTiles.x0, penTiles.y0, penTiles.x0, penTiles.y1);
  fenceRun(penTiles.x1, penTiles.y0, penTiles.x1, penTiles.y1);
  // field gate path
  road([
    [25 * TILE + 8, ROAD_Y],
    [25 * TILE + 8, fieldTiles.y0 * TILE + 12],
  ], 26);
  // pen gate path
  road([
    [8 * TILE, coopY + 20],
    [8 * TILE, penTiles.y0 * TILE + 8],
  ], 18);

  // ---- placements -----------------------------------------------------------------
  const placements: Placement[] = buildings.map((b) => ({ kind: "building" as const, id: b.id, x: b.x, y: b.y, variant: 0 }));
  const deco = (kind: DecorKind, x: number, y: number, variant = 0) => placements.push({ kind, id: kind, x, y, variant });

  // hand-placed props
  const [fdx, fdy] = doorOf(farmhouse);
  deco("mailbox", fdx - 30, ROAD_Y - 32);
  deco("pot", fdx - 26, fdy - 12, 0);
  deco("pot", fdx + 18, fdy - 12, 1);
  deco("woodpile", farmhouse.x + farmhouse.spec.w + 4, farmhouse.y + farmhouse.spec.base - 16);
  deco("barrel", barn.x - 2, barn.y + barn.spec.base - 16);
  deco("barrel", barn.x + 10, barn.y + barn.spec.base - 12);
  deco("hay", barn.x + barn.spec.w + 2, barn.y + barn.spec.base - 30);
  deco("cart", windmill.x + windmill.spec.w + 4, windmill.y + windmill.spec.base - 20);
  deco("crates", windmill.x - 20, windmill.y + windmill.spec.base - 16);
  deco("scarecrowpost", scarecrowAt.x, scarecrowAt.y);
  deco("signpost", riverAtRoad + 64, ROAD_Y - 34);
  deco("noticeboard", PLAZA.x + PLAZA.r - 6, PLAZA.y - PLAZA.r + 10);
  deco("bench", PLAZA.x - 44, PLAZA.y + 30);
  deco("bench", PLAZA.x + 24, PLAZA.y + 30);
  deco("bench", PLAZA.x - 58, PLAZA.y - 20);
  deco("blossom", PLAZA.x - PLAZA.r - 24, PLAZA.y - 50);
  deco("blossom", PLAZA.x + PLAZA.r - 4, PLAZA.y + 6);
  deco("crates", store.x + store.spec.w + 2, store.y + store.spec.base - 14);
  deco("barrel", store.x - 12, store.y + store.spec.base - 16);
  deco("dock", POND.cx - 24, POND.cy - POND.ry - 10);
  deco("boat", POND.cx + 2, POND.cy - 18);
  for (let i = 0; i < 9; i++) {
    deco("lilypad", POND.cx - 70 + rng() * 140, POND.cy - 30 + rng() * 60, Math.floor(rng() * 3));
  }

  // lamps along the roads
  const lamps: Array<[number, number]> = [
    [150, ROAD_Y - 36],
    [330, ROAD_Y - 36],
    [560, ROAD_Y - 36],
    [riverAtRoad + 64, ROAD_Y + 18],
    [880, ROAD_Y + 18],
    [1150, ROAD_Y + 18],
    [LANE_X + 16, 470],
    [LANE_X + 16, 640],
    [PLAZA.x - 44, PLAZA.y - 58],
    [PLAZA.x + 36, PLAZA.y - 58],
    [960, STREET2_Y + 16],
    [1160, STREET2_Y + 16],
    [900, STREET3_Y + 16],
    [1140, STREET3_Y + 16],
    [riverAtSouth + 60, SOUTH_Y - 36],
    [500, SOUTH_Y - 36],
  ];
  for (const [lx, ly] of lamps) deco("lamp", Math.round(lx), Math.round(ly));

  // orchard south of the seedbed
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      deco("fruit", 468 + col * 34 + (row % 2) * 12, 552 + row * 44, (row + col) % 3);
    }
  }

  // ---- blocked areas for scattered decor ----------------------------------------------
  const blocked: Rect[] = [];
  for (const b of buildings) blocked.push({ x: b.x - 6, y: b.y - 4, w: b.spec.w + 12, h: b.spec.h + 14 });
  for (const p of placements) {
    if (p.kind === "building") continue;
    blocked.push({ x: p.x - 6, y: p.y - 6, w: 30, h: 30 });
  }
  blocked.push(
    { x: fieldRect.x - 10, y: fieldRect.y - 10, w: fieldRect.w + 20, h: fieldRect.h + 20 },
    { x: seedbedRect.x - 10, y: seedbedRect.y - 10, w: seedbedRect.w + 20, h: seedbedRect.h + 20 },
    { x: penTiles.x0 * TILE - 10, y: penTiles.y0 * TILE - 10, w: (penTiles.x1 - penTiles.x0 + 1) * TILE + 20, h: (penTiles.y1 - penTiles.y0 + 1) * TILE + 20 },
    { x: PLAZA.x - PLAZA.r - 8, y: PLAZA.y - PLAZA.r - 8, w: PLAZA.r * 2 + 16, h: PLAZA.r * 2 + 16 },
  );
  const clear = (x: number, y: number, w: number, h: number, roadMargin = 4, waterMargin = 6): boolean => {
    if (x < 0 || y < 0 || x + w > WORLD_W || y + h > WORLD_H) return false;
    for (const b of blocked) {
      if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) return false;
    }
    for (const [px, py] of [
      [x + w / 2, y + h],
      [x, y + h],
      [x + w, y + h],
      [x + w / 2, y + h / 2],
    ] as const) {
      if (roadDist(roads, px, py) < roadMargin) return false;
      if (waterSignedDist(px, py).d < waterMargin) return false;
      const t = soil[Math.floor(py / TILE) * MAP_W + Math.floor(px / TILE)];
      if (t) return false;
    }
    return true;
  };
  const TREES = new Set<DecorKind>(["oak", "pine", "birch", "fruit", "blossom"]);
  const tryDeco = (kind: DecorKind, x: number, y: number, w: number, h: number, variant: number, roadMargin = 4): boolean => {
    x = Math.round(x);
    y = Math.round(y);
    // trees only test (and reserve) their trunk base, so canopies can overlap
    // into a proper forest edge
    const probe = TREES.has(kind) ? { x: x + 8, y: y + h - 14, w: w - 16, h: 14 } : { x, y, w, h };
    if (!clear(probe.x, probe.y, probe.w, probe.h, roadMargin)) return false;
    deco(kind, x, y, variant);
    blocked.push(TREES.has(kind) ? { x: x + 10, y: y + h - 12, w: w - 20, h: 10 } : { x: x + 2, y: y + h * 0.4, w: w - 4, h: h * 0.6 });
    return true;
  };

  // forest border: dense trees along every edge, thinning inward
  const edgeTree = (x: number, y: number) => {
    const r = rng();
    const kind: DecorKind = r < 0.42 ? "pine" : r < 0.85 ? "oak" : "birch";
    tryDeco(kind, x, y, 34, 50, Math.floor(rng() * 3), 10);
  };
  for (let pass = 0; pass < 3; pass++) {
    const thin = pass === 2 ? 0.45 : 1; // the innermost row is patchy
    for (let x = -18; x < WORLD_W; x += 14 + rng() * 8) if (rng() < thin) edgeTree(x, -36 + pass * 15 + rng() * 8);
    for (let x = -18; x < WORLD_W; x += 14 + rng() * 8) if (rng() < thin) edgeTree(x, WORLD_H - 46 - pass * 14 + rng() * 6);
    for (let y = -20; y < WORLD_H; y += 14 + rng() * 8) if (rng() < thin) edgeTree(-20 + pass * 14 + rng() * 6, y);
    for (let y = -20; y < WORLD_H; y += 14 + rng() * 8) if (rng() < thin) edgeTree(WORLD_W - 16 - pass * 14 + rng() * 6, y);
  }
  // groves
  const grove = (cx: number, cy: number, r: number, n: number, kinds: DecorKind[]) => {
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * r;
      tryDeco(kinds[Math.floor(rng() * kinds.length)], cx + Math.cos(a) * d - 16, cy + Math.sin(a) * d * 0.7 - 40, 34, 50, Math.floor(rng() * 3), 8);
    }
  };
  grove(560, 110, 60, 8, ["oak", "birch"]);
  grove(620, 420, 50, 7, ["oak", "pine"]);
  grove(560, 660, 60, 8, ["pine", "oak"]);
  grove(860, 90, 30, 3, ["oak", "birch"]);
  grove(1230, 560, 30, 4, ["pine", "oak"]);
  grove(780, 540, 30, 4, ["oak", "birch"]);
  grove(80, 660, 60, 8, ["pine", "oak", "birch"]);
  grove(360, 440 + 330, 30, 3, ["oak"]);

  // riverbanks: reeds and rocks right at the water's edge
  for (let y = 10; y < WORLD_H - 10; y += 6) {
    for (const side of [-1, 1]) {
      if (rng() > 0.17) continue;
      const x = riverCenterAt(y) + side * (riverHalfAt(y) + 5 + rng() * 5);
      if (bridges.some((b) => y > b.y - 16 && y < b.y + b.h + 8)) continue;
      const kind: DecorKind = rng() < 0.75 ? "reeds" : "mossrock";
      if (roadDist(roads, x, y) < 6) continue;
      deco(kind, Math.round(x - 6), Math.round(y - 12), Math.floor(rng() * 3));
    }
  }
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const x = POND.cx + Math.cos(a) * (POND.rx + 6);
    const y = POND.cy + Math.sin(a) * (POND.ry + 6);
    if (y < POND.cy - POND.ry * 0.6 && Math.abs(x - POND.cx) < 40) continue; // dock
    deco(rng() < 0.7 ? "reeds" : "mossrock", Math.round(x - 6), Math.round(y - 12), Math.floor(rng() * 3));
  }

  // scattered small decor over the grass
  const smalls: Array<[DecorKind, number, number, number]> = [
    ["bush", 20, 16, 4],
    ["berrybush", 20, 16, 1],
    ["flowerbush", 20, 16, 3],
    ["rock", 14, 10, 0.8],
    ["tallgrass", 12, 12, 12],
    ["stump", 14, 12, 0.3],
    ["log", 24, 12, 0.3],
  ];
  const totalW = smalls.reduce((a, s) => a + s[3], 0);
  // tall grass comes in clumps
  for (let i = 0; i < 70; i++) {
    const cx = 40 + rng() * (WORLD_W - 80);
    const cy = 40 + rng() * (WORLD_H - 80);
    for (let k = 0; k < 6; k++) tryDeco("tallgrass", cx + (rng() - 0.5) * 34, cy + (rng() - 0.5) * 22, 12, 12, Math.floor(rng() * 3));
  }
  for (let i = 0; i < 700; i++) {
    let r = rng() * totalW;
    let pick = smalls[0];
    for (const s of smalls) {
      r -= s[3];
      if (r <= 0) {
        pick = s;
        break;
      }
    }
    const [kind, w, h] = pick;
    tryDeco(kind, 20 + rng() * (WORLD_W - 40), 20 + rng() * (WORLD_H - 40), w, h, Math.floor(rng() * 3));
  }
  // flower beds along house fronts
  for (const b of houseBuildings) {
    const [dx] = doorOf(b);
    const gy = b.y + b.spec.base;
    const left = b.x + 8;
    const right = b.x + b.spec.w - 22;
    for (const x of [left, right]) {
      if (Math.abs(x + 7 - dx) < 16) continue;
      tryDeco("flowerbush", x, gy - 8, 16, 12, Math.floor(rng() * 3), 1);
    }
  }

  // ---- walk graph (from the road polylines) ---------------------------------------
  const graph = buildGraph(roads.filter((r) => r.kind === "dirt"));

  // ---- hotspots ------------------------------------------------------------------------
  const hotspots: Hotspot[] = [];
  for (const b of buildings) {
    hotspots.push({ id: b.key, rect: { x: b.x + 2, y: b.y + 2, w: b.spec.w - 4, h: b.spec.base - 2 }, label: b.label });
  }
  hotspots.push(
    { id: "field", rect: fieldRect, label: "CROP FIELD" },
    { id: "seedbed", rect: seedbedRect, label: "SEEDBED" },
    { id: "pen", rect: { x: penTiles.x0 * TILE, y: penTiles.y0 * TILE, w: (penTiles.x1 - penTiles.x0 + 1) * TILE, h: (penTiles.y1 - penTiles.y0 + 1) * TILE }, label: "CHICKEN PEN" },
    { id: "signpost", rect: { x: riverAtRoad + 60, y: ROAD_Y - 38, w: 24, h: 26 }, label: "VILLAGE SIGN" },
    { id: "noticeboard", rect: { x: PLAZA.x + PLAZA.r - 8, y: PLAZA.y - PLAZA.r + 6, w: 28, h: 28 }, label: "NOTICE BOARD" },
  );

  // ---- collision -------------------------------------------------------------------------
  const solidRects: Rect[] = [];
  for (const b of buildings) {
    const f = b.spec.foot;
    solidRects.push({ x: b.x + f.x, y: b.y + f.y, w: f.w, h: f.h });
  }
  for (const f of fences) solidRects.push({ x: f.x - 1, y: f.y - 2, w: f.kind === "h" ? TILE + 2 : 4, h: f.kind === "v" ? TILE + 3 : 5 });
  for (const p of placements) {
    switch (p.kind) {
      case "oak":
      case "birch":
      case "blossom":
        solidRects.push({ x: p.x + 13, y: p.y + 40, w: 9, h: 6 });
        break;
      case "fruit":
        solidRects.push({ x: p.x + 11, y: p.y + 32, w: 7, h: 5 });
        break;
      case "pine":
        solidRects.push({ x: p.x + 12, y: p.y + 42, w: 9, h: 5 });
        break;
      case "rock":
      case "mossrock":
      case "stump":
        solidRects.push({ x: p.x + 2, y: p.y + 4, w: 10, h: 5 });
        break;
      case "lamp":
        solidRects.push({ x: p.x + 3, y: p.y + 26, w: 5, h: 3 });
        break;
      case "bench":
        solidRects.push({ x: p.x + 1, y: p.y + 6, w: 20, h: 5 });
        break;
      case "barrel":
      case "pot":
      case "mailbox":
        solidRects.push({ x: p.x + 1, y: p.y + 8, w: 10, h: 5 });
        break;
      case "crates":
      case "woodpile":
      case "cart":
      case "hay":
        solidRects.push({ x: p.x + 1, y: p.y + 8, w: 22, h: 8 });
        break;
      case "signpost":
      case "noticeboard":
        solidRects.push({ x: p.x + 4, y: p.y + 18, w: 14, h: 5 });
        break;
      default:
        break;
    }
  }

  return {
    placements,
    buildings,
    hotspots,
    roads,
    plaza: PLAZA,
    graph,
    fieldRect,
    fieldPlots,
    seedbedRect,
    seedbedPlots,
    penRect,
    pondRect,
    scarecrowAt,
    villageHouses,
    riverCenter: riverCenterAt,
    riverHalf: riverHalfAt,
    bridges,
    fences,
    water,
    soil,
    solidRects,
    wellAt: { x: well.x + 18, y: well.y + 30 },
    fountainAt: { x: fountain.x + 30, y: fountain.y + 26 },
  };
}

// Graph over road polylines: vertices become nodes, shared vertices merge, and
// endpoints landing on another road's segment split it into a T-junction.
function buildGraph(roads: Road[]): WalkGraph {
  const lines = roads.map((r) => r.pts.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]));
  const ends: Array<[number, number]> = [];
  for (const l of lines) ends.push(l[0], l[l.length - 1]);
  for (const l of lines) {
    for (let i = 0; i + 1 < l.length; i++) {
      const [ax, ay] = l[i];
      const [bx, by] = l[i + 1];
      for (const [ex, ey] of ends) {
        if ((ex === ax && ey === ay) || (ex === bx && ey === by)) continue;
        if (segDist(ex, ey, ax, ay, bx, by) < 1.5) {
          l.splice(i + 1, 0, [ex, ey]);
          break;
        }
      }
    }
  }
  const nodes: Array<{ x: number; y: number }> = [];
  const index = new Map<string, number>();
  const nodeAt = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let i = index.get(key);
    if (i === undefined) {
      i = nodes.length;
      nodes.push({ x, y });
      index.set(key, i);
    }
    return i;
  };
  const edges: number[][] = [];
  const link = (a: number, b: number) => {
    while (edges.length <= Math.max(a, b)) edges.push([]);
    if (a === b || edges[a].includes(b)) return;
    edges[a].push(b);
    edges[b].push(a);
  };
  for (const l of lines) {
    for (let i = 0; i + 1 < l.length; i++) link(nodeAt(l[i][0], l[i][1]), nodeAt(l[i + 1][0], l[i + 1][1]));
  }
  while (edges.length < nodes.length) edges.push([]);
  return { nodes, edges };
}
