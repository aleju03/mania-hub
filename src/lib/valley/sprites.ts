// Pixel-art sprite atlas for the valley monitor. Small characters are
// hand-drawn string grids; buildings and nature are drawn procedurally in the
// same palette so everything reads as one tileset. Built once at game init.

import { C, createCanvas, ctx2d, mulberry32, spriteFromGrid, flipSprite, type Ctx, type Sprite } from "./core";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BuildingSprite extends Sprite {
  windows: Rect[]; // relative to sprite, used for night window glow
  chimney: { x: number; y: number } | null; // smoke emitter, relative
}

function newSprite(w: number, h: number): { sprite: Sprite; ctx: Ctx } {
  const canvas = createCanvas(w, h);
  return { sprite: { canvas, w, h }, ctx: ctx2d(canvas) };
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function disk(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) {
    const y = Math.round(cy + dy);
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const x0 = Math.round(cx - half);
    ctx.fillRect(x0, y, Math.max(1, Math.round(half * 2)), 1);
  }
}

function speckle(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, count: number, rng: () => number): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.fillRect(x + Math.floor(rng() * w), y + Math.floor(rng() * h), 1, 1);
  }
}

// ---------------------------------------------------------------------------
// People: chunky outlined chibi characters, 12x17. Heads come in styles
// (short hair, long hair, cap, straw hat), bodies in normal / overalls /
// dress; back views are derived by hiding the face under hair.

export type CharStyle = "short" | "long" | "cap" | "farmer";

export interface CharPalette {
  hair: string;
  shirt: string;
  pants: string;
  dress?: string;
  cap?: string; // cap/hat color for "cap" and "farmer" styles
}

// front/back frames: 0 = stand, 1 = left step, 2 = right step
// side frames (authored facing left): 0 = stand, 1 = stride
export interface CharacterSprites {
  front: [Sprite, Sprite, Sprite];
  back: [Sprite, Sprite, Sprite];
  side: [Sprite, Sprite];
  frontFlip: [Sprite, Sprite, Sprite];
  backFlip: [Sprite, Sprite, Sprite];
  sideFlip: [Sprite, Sprite];
}

const HEAD_SHORT = [
  "..OOOOOOOO..",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OHSSSSSSHO.",
  ".OSESSSSESO.",
  ".OSESSSSESO.",
  ".OSRSSSSRSO.",
  "..OSSSSSSO..",
];

const HEAD_LONG = [
  "..OOOOOOOO..",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OHSSSSSSHO.",
  ".OHESSSSEHO.",
  ".OHESSSSEHO.",
  ".OHRSSSSRHO.",
  ".OHHSSSSHHO.",
];

const HEAD_CAP = [
  "..OOOOOOOO..",
  ".OKKKKKKKKO.",
  ".OKKKKKKKKO.",
  "OKKKKKKKKKKO",
  ".OHSSSSSSHO.",
  ".OSESSSSESO.",
  ".OSESSSSESO.",
  ".OSRSSSSRSO.",
  "..OSSSSSSO..",
];

const HEAD_FARMER = [
  "...OOOOOO...",
  "..OKKKKKKO..",
  ".OKKKKKKKKO.",
  "OKKKKKKKKKKO",
  ".OHSSSSSSHO.",
  ".OSESSSSESO.",
  ".OSESSSSESO.",
  ".OSRSSSSRSO.",
  "..OSSSSSSO..",
];

// side-view heads, facing left: face at the front (left), hair mass behind
const SIDE_HEAD_SHORT = [
  "..OOOOOOOO..",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OSSSSHHHHO.",
  ".OSESSHHHHO.",
  ".OSESSHHHHO.",
  ".OSRSSHHHHO.",
  "..OSSSSHHO..",
];

const SIDE_HEAD_LONG = [
  "..OOOOOOOO..",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OHHHHHHHHO.",
  ".OSSSSHHHHO.",
  ".OSESSHHHHO.",
  ".OSESSHHHHO.",
  ".OSRSSHHHHO.",
  ".OSSSSHHHHO.",
];

const SIDE_HEAD_CAP = [
  "..OOOOOOOO..",
  ".OKKKKKKKKO.",
  ".OKKKKKKKKO.",
  "OKKKKKKKKKO.",
  ".OSSSSHHHHO.",
  ".OSESSHHHHO.",
  ".OSESSHHHHO.",
  ".OSRSSHHHHO.",
  "..OSSSSHHO..",
];

const SIDE_HEAD_FARMER = [
  "...OOOOOO...",
  "..OKKKKKKO..",
  ".OKKKKKKKKO.",
  "OKKKKKKKKKKO",
  ".OSSSSHHHHO.",
  ".OSESSHHHHO.",
  ".OSESSHHHHO.",
  ".OSRSSHHHHO.",
  "..OSSSSHHO..",
];

const TORSO_NORMAL = [
  "..OCCCCCCO..",
  ".OCCCCCCCCO.",
  ".OSCCCCCCSO.",
  "..OCCCCCCO..",
];

const TORSO_OVERALLS = [
  "..OCPCCPCO..",
  ".OCPPPPPPCO.",
  ".OSPPPPPPSO.",
  "..OPPPPPPO..",
];

const LEGS_STAND = [
  "..OPPPPPPO..",
  "..OPP..PPO..",
  "..OPP..PPO..",
  "..OBB..BBO..",
];

// left leg lifted mid-step, right leg planted
const LEGS_STEP_L = [
  "..OPPPPPPO..",
  "..OPP..PPO..",
  "..OBB..PPO..",
  ".......BB...",
];

// right leg lifted mid-step, left leg planted
const LEGS_STEP_R = [
  "..OPPPPPPO..",
  "..OPP..PPO..",
  "..OPP..BBO..",
  "...BB.......",
];

const DRESS_STAND = [
  "..OAAAAAAO..",
  ".OAAAAAAAAO.",
  ".OAAAAAAAAO.",
  "..OBB..BBO..",
];

// boots peek out alternately under the hem
const DRESS_STEP_L = [
  "..OAAAAAAO..",
  ".OAAAAAAAAO.",
  ".OAAAAAAAAO.",
  ".......BB...",
];

const DRESS_STEP_R = [
  "..OAAAAAAO..",
  ".OAAAAAAAAO.",
  ".OAAAAAAAAO.",
  "...BB.......",
];

// side view: legs overlap into one column when standing, scissor when striding
const SIDE_LEGS_STAND = [
  "..OPPPPPPO..",
  "...OPPPPO...",
  "....PPPP....",
  "....BBBB....",
];

const SIDE_LEGS_STRIDE = [
  "..OPPPPPPO..",
  "...PPPPPP...",
  "..PPP..PPP..",
  ".BBB....BBB.",
];

const SIDE_DRESS_STAND = [
  "..OAAAAAAO..",
  ".OAAAAAAAAO.",
  ".OAAAAAAAAO.",
  "....BBBB....",
];

const SIDE_DRESS_STRIDE = [
  "..OAAAAAAO..",
  ".OAAAAAAAAO.",
  ".OAAAAAAAAO.",
  "..BB....BB..",
];

type CharDir = "front" | "back" | "side";

function charGrid(style: CharStyle, frame: number, dir: CharDir): string[] {
  const torso = style === "farmer" ? TORSO_OVERALLS : TORSO_NORMAL;
  if (dir === "side") {
    const head =
      style === "long"
        ? SIDE_HEAD_LONG
        : style === "cap"
          ? SIDE_HEAD_CAP
          : style === "farmer"
            ? SIDE_HEAD_FARMER
            : SIDE_HEAD_SHORT;
    const legSet = style === "long" ? [SIDE_DRESS_STAND, SIDE_DRESS_STRIDE] : [SIDE_LEGS_STAND, SIDE_LEGS_STRIDE];
    return [...head, ...torso, ...legSet[frame]];
  }
  const head =
    style === "long" ? HEAD_LONG : style === "cap" ? HEAD_CAP : style === "farmer" ? HEAD_FARMER : HEAD_SHORT;
  const legSet =
    style === "long"
      ? [DRESS_STAND, DRESS_STEP_L, DRESS_STEP_R]
      : [LEGS_STAND, LEGS_STEP_L, LEGS_STEP_R];
  const headRows = dir === "back" ? head.map((row) => row.replace(/[SER]/g, "H")) : head;
  return [...headRows, ...torso, ...legSet[frame]];
}

function buildCharacter(style: CharStyle, pal: CharPalette): CharacterSprites {
  const map = {
    O: C.outline,
    H: pal.hair,
    S: C.skin,
    E: C.outline,
    R: "#efb0a0",
    C: pal.shirt,
    P: pal.pants,
    A: pal.dress ?? pal.shirt,
    K: pal.cap ?? pal.hair,
    B: "#5a4030",
  };
  const make = (frame: number, dir: CharDir) => spriteFromGrid(charGrid(style, frame, dir), map);
  const front: [Sprite, Sprite, Sprite] = [make(0, "front"), make(1, "front"), make(2, "front")];
  const back: [Sprite, Sprite, Sprite] = [make(0, "back"), make(1, "back"), make(2, "back")];
  const side: [Sprite, Sprite] = [make(0, "side"), make(1, "side")];
  return {
    front,
    back,
    side,
    frontFlip: [flipSprite(front[0]), flipSprite(front[1]), flipSprite(front[2])],
    backFlip: [flipSprite(back[0]), flipSprite(back[1]), flipSprite(back[2])],
    sideFlip: [flipSprite(side[0]), flipSprite(side[1])],
  };
}

// ---------------------------------------------------------------------------
// Animals

const CHICKEN_A = [
  "...R......",
  "..RWW.....",
  ".OWEWW....",
  "..WWWWWW..",
  ".WWWWWWWW.",
  ".WWWWWWWW.",
  "..WWWWWW..",
  "....O..O..",
  "...OO..OO.",
];

const CHICKEN_B = [
  "...R......",
  "..RWW.....",
  ".OWEWW....",
  "..WWWWWW..",
  ".WWWWWWWW.",
  ".WWWWWWWW.",
  "..WWWWWW..",
  "...O..O...",
  "..OO..OO..",
];

const CHICKEN_PECK = [
  "..........",
  "..........",
  "...WWWWW..",
  ".WWWWWWWW.",
  ".RWWWWWWW.",
  "OWEWWWWW..",
  "..WWWWW...",
  "....O..O..",
  "...OO..OO.",
];

function chickenSprites(): Sprite[] {
  const map = { R: "#d8443a", W: "#f4efe4", E: C.outline, O: "#d9932f" };
  return [spriteFromGrid(CHICKEN_A, map), spriteFromGrid(CHICKEN_B, map), spriteFromGrid(CHICKEN_PECK, map)];
}

const BUTTERFLY_A = ["#..#", "####", ".##.", "#..#"];
const BUTTERFLY_B = [".##.", "####", ".##.", ".##."];

const BIRD_A = ["#.....#", ".#...#.", "..###..", "...#..."];
const BIRD_B = ["...#...", "..###..", ".#...#.", "#.....#"];

// ---------------------------------------------------------------------------
// Crops

export type CropStage = 0 | 1 | 2 | 3; // sprout, growing, tall, ready

function cropSprite(stage: CropStage, fruit: string): Sprite {
  const { sprite, ctx } = newSprite(10, 12);
  const cx = 5;
  if (stage === 0) {
    rect(ctx, cx - 1, 9, 1, 2, C.leaf);
    rect(ctx, cx, 8, 1, 2, C.leafLight);
  } else if (stage === 1) {
    rect(ctx, cx - 1, 7, 1, 4, C.leaf);
    rect(ctx, cx - 3, 8, 2, 1, C.leafLight);
    rect(ctx, cx + 1, 7, 2, 1, C.leafLight);
    rect(ctx, cx - 2, 10, 3, 1, C.leafDark);
  } else if (stage === 2) {
    rect(ctx, cx - 1, 4, 1, 7, C.leaf);
    rect(ctx, cx - 3, 6, 2, 1, C.leafLight);
    rect(ctx, cx + 1, 5, 3, 1, C.leafLight);
    rect(ctx, cx - 4, 8, 3, 1, C.leaf);
    rect(ctx, cx + 1, 8, 3, 1, C.leafDark);
    rect(ctx, cx - 2, 10, 4, 1, C.leafDark);
  } else {
    rect(ctx, cx - 1, 3, 1, 8, C.leaf);
    rect(ctx, cx - 4, 5, 3, 1, C.leafLight);
    rect(ctx, cx + 1, 4, 3, 1, C.leafLight);
    rect(ctx, cx - 4, 8, 3, 1, C.leaf);
    rect(ctx, cx + 2, 7, 3, 1, C.leafDark);
    rect(ctx, cx - 2, 10, 5, 1, C.leafDark);
    // fruit cluster
    rect(ctx, cx - 3, 2, 2, 2, fruit);
    rect(ctx, cx + 1, 1, 2, 2, fruit);
    rect(ctx, cx - 1, 0, 2, 2, fruit);
    ctx.fillStyle = "#ffffff55";
    ctx.fillRect(cx - 1, 0, 1, 1);
  }
  return sprite;
}

function seedlingSprite(): Sprite {
  const { sprite, ctx } = newSprite(8, 8);
  rect(ctx, 3, 5, 1, 2, "#8a9a4a");
  rect(ctx, 4, 4, 1, 2, "#9aa855");
  rect(ctx, 2, 6, 4, 1, C.soilDark);
  return sprite;
}

// ---------------------------------------------------------------------------
// Nature

function oakTree(rng: () => number): Sprite {
  const { sprite, ctx } = newSprite(22, 30);
  // trunk
  rect(ctx, 9, 20, 4, 9, C.trunk);
  rect(ctx, 9, 20, 1, 9, C.trunkDark);
  rect(ctx, 8, 28, 6, 1, C.trunkDark);
  // canopy
  disk(ctx, 11, 11, 9, C.leafDark);
  disk(ctx, 10, 9, 7.4, C.leaf);
  disk(ctx, 8.6, 7.4, 5, C.leafLight);
  speckle(ctx, 3, 2, 16, 14, C.leafLighter, 14, rng);
  speckle(ctx, 5, 10, 14, 9, C.leafDark, 10, rng);
  return sprite;
}

function pineTree(rng: () => number): Sprite {
  const { sprite, ctx } = newSprite(18, 30);
  rect(ctx, 8, 24, 3, 5, C.trunk);
  rect(ctx, 8, 24, 1, 5, C.trunkDark);
  const layers: Array<[number, number, number]> = [
    [24, 8, 0],
    [19, 7, 0],
    [14, 6, 0],
    [9, 4.5, 0],
  ];
  for (const [baseY, halfW] of layers) {
    for (let i = 0; i < 6; i++) {
      const w = Math.max(1, Math.round(halfW * (1 - i / 6) * 2));
      const x = Math.round(9 - w / 2);
      rect(ctx, x, baseY - i, w, 1, i > 3 ? C.pineLight : C.pine);
    }
  }
  rect(ctx, 8, 3, 2, 2, C.pineLight);
  speckle(ctx, 4, 8, 11, 16, C.pineDark, 12, rng);
  return sprite;
}

function bush(rng: () => number, berries: string | null): Sprite {
  const { sprite, ctx } = newSprite(15, 11);
  disk(ctx, 7, 7, 4, C.leafDark);
  disk(ctx, 5, 6, 3.2, C.leaf);
  disk(ctx, 9.6, 5.6, 3, C.leaf);
  disk(ctx, 6.6, 4.6, 2.4, C.leafLight);
  speckle(ctx, 2, 2, 11, 7, C.leafLighter, 5, rng);
  if (berries) {
    speckle(ctx, 3, 3, 9, 5, berries, 4, rng);
  }
  return sprite;
}

function flower(color: string): Sprite {
  const { sprite, ctx } = newSprite(5, 7);
  rect(ctx, 2, 4, 1, 3, C.leaf);
  rect(ctx, 1, 1, 3, 3, color);
  rect(ctx, 2, 0, 1, 1, color);
  rect(ctx, 0, 2, 1, 1, color);
  rect(ctx, 4, 2, 1, 1, color);
  rect(ctx, 2, 2, 1, 1, "#fff6d8");
  return sprite;
}

function grassTuft(): Sprite {
  const { sprite, ctx } = newSprite(7, 6);
  rect(ctx, 1, 2, 1, 4, C.grassDarker);
  rect(ctx, 3, 0, 1, 6, C.grassDark);
  rect(ctx, 5, 2, 1, 4, C.grassDarker);
  rect(ctx, 2, 3, 1, 3, C.grassLight);
  rect(ctx, 4, 2, 1, 4, C.grassLight);
  return sprite;
}

function rock(rng: () => number): Sprite {
  const { sprite, ctx } = newSprite(11, 8);
  disk(ctx, 5, 5.4, 4.4, C.stoneDark);
  disk(ctx, 5, 4.4, 3.8, C.stone);
  rect(ctx, 3, 2, 3, 2, C.stoneLight);
  speckle(ctx, 2, 3, 7, 4, C.stoneDark, 4, rng);
  return sprite;
}

function stump(): Sprite {
  const { sprite, ctx } = newSprite(10, 8);
  rect(ctx, 1, 2, 8, 5, C.trunk);
  rect(ctx, 1, 2, 1, 5, C.trunkDark);
  rect(ctx, 1, 1, 8, 3, C.woodLight);
  rect(ctx, 3, 2, 4, 1, C.wood);
  rect(ctx, 1, 7, 8, 1, C.trunkDark);
  return sprite;
}

function hayBale(): Sprite {
  const { sprite, ctx } = newSprite(14, 11);
  rect(ctx, 0, 1, 14, 9, C.hay);
  rect(ctx, 0, 1, 14, 1, "#e8c95e");
  rect(ctx, 0, 8, 14, 2, C.hayDark);
  rect(ctx, 4, 1, 1, 9, C.hayDark);
  rect(ctx, 9, 1, 1, 9, C.hayDark);
  rect(ctx, 0, 10, 14, 1, "#8a6d2a");
  return sprite;
}

// ---------------------------------------------------------------------------
// Structures

interface HouseOpts {
  w: number;
  wallH: number;
  roofH: number;
  roof: [string, string, string]; // dark, mid, light
  wall: [string, string]; // base, shade
  beams?: boolean;
  windows: Rect[]; // in wall coordinates (y from wall top)
  door: { x: number; w: number; h: number } | null;
  chimney?: number | null; // x offset on roof, null = none
  bigDoor?: boolean; // barn style
  seed?: number;
}

function makeHouse(o: HouseOpts): BuildingSprite {
  const rng = mulberry32(o.seed ?? 7);
  const w = o.w;
  const h = o.roofH + o.wallH;
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);

  // walls
  const wallY = o.roofH;
  rect(ctx, 2, wallY, w - 4, o.wallH, o.wall[0]);
  rect(ctx, 2, wallY, w - 4, 1, o.wall[1]);
  rect(ctx, 2, wallY + o.wallH - 1, w - 4, 1, o.wall[1]);
  // subtle vertical seams
  for (let x = 8; x < w - 6; x += 7) {
    if (rng() < 0.8) rect(ctx, x, wallY + 1, 1, o.wallH - 2, `${o.wall[1]}88`);
  }
  if (o.beams) {
    rect(ctx, 2, wallY, 2, o.wallH, C.woodDark);
    rect(ctx, w - 4, wallY, 2, o.wallH, C.woodDark);
    rect(ctx, 2, wallY, w - 4, 2, C.woodDark);
  }
  // outline base
  rect(ctx, 2, wallY + o.wallH - 1, w - 4, 1, C.woodDarker);

  // roof: stepped peak
  const ridge = Math.floor(w / 2);
  for (let r = 0; r < o.roofH; r++) {
    const t = r / Math.max(1, o.roofH - 1);
    const half = Math.round((w / 2 - 1) * (0.24 + 0.76 * t));
    const color = r < 2 ? o.roof[2] : r >= o.roofH - 2 ? o.roof[0] : o.roof[1];
    rect(ctx, ridge - half, r, half * 2, 1, color);
  }
  // eaves overhang line
  rect(ctx, 0, o.roofH - 2, w, 2, o.roof[0]);
  // roof texture streaks
  for (let i = 0; i < w / 5; i++) {
    const x = 3 + Math.floor(rng() * (w - 6));
    const y = 3 + Math.floor(rng() * Math.max(1, o.roofH - 6));
    rect(ctx, x, y, 1, 2, o.roof[0]);
  }

  const windows: Rect[] = [];
  for (const win of o.windows) {
    const wx = win.x;
    const wy = wallY + win.y;
    rect(ctx, wx - 1, wy - 1, win.w + 2, win.h + 2, C.woodDark);
    rect(ctx, wx, wy, win.w, win.h, C.windowDark);
    rect(ctx, wx, wy, win.w, 1, "#46587a");
    if (win.w >= 5) rect(ctx, wx + Math.floor(win.w / 2), wy, 1, win.h, C.woodDark);
    if (win.h >= 5) rect(ctx, wx, wy + Math.floor(win.h / 2), win.w, 1, C.woodDark);
    // sill
    rect(ctx, wx - 1, wy + win.h + 1, win.w + 2, 1, C.woodLight);
    windows.push({ x: wx, y: wy, w: win.w, h: win.h });
  }

  if (o.door) {
    const dh = o.door.h;
    const dy = wallY + o.wallH - dh;
    rect(ctx, o.door.x - 1, dy - 1, o.door.w + 2, dh + 1, C.woodDarker);
    rect(ctx, o.door.x, dy, o.door.w, dh, C.wood);
    rect(ctx, o.door.x, dy, o.door.w, 1, C.woodLight);
    rect(ctx, o.door.x + o.door.w - 2, dy + Math.floor(dh / 2), 1, 1, C.hay);
    if (o.bigDoor) {
      // barn cross braces
      const dx = o.door.x;
      for (let i = 0; i < dh; i++) {
        const t = Math.round((i / dh) * (o.door.w - 1));
        rect(ctx, dx + t, dy + i, 1, 1, C.woodDark);
        rect(ctx, dx + o.door.w - 1 - t, dy + i, 1, 1, C.woodDark);
      }
    }
  }

  let chimney: { x: number; y: number } | null = null;
  if (o.chimney != null) {
    // seated on the roof slope, poking above it
    const cx = o.chimney;
    const top = Math.max(2, o.roofH - 20);
    rect(ctx, cx, top, 6, o.roofH - top - 2, C.stoneDark);
    rect(ctx, cx + 1, top + 1, 3, o.roofH - top - 4, C.stone);
    rect(ctx, cx - 1, top, 8, 2, C.stoneLight);
    rect(ctx, cx + 1, top, 4, 1, "#3a3a3a");
    chimney = { x: cx + 3, y: top };
  }

  return { canvas, w, h, windows, chimney };
}

function makeSilo(): BuildingSprite {
  const w = 20;
  const h = 62;
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  const rng = mulberry32(11);
  // dome
  disk(ctx, 10, 8, 8.6, C.roofRedDark);
  disk(ctx, 9, 7, 7, C.roofRed);
  rect(ctx, 5, 2, 5, 2, C.roofRedLight);
  // body
  rect(ctx, 2, 9, 16, 52, C.stone);
  rect(ctx, 2, 9, 2, 52, C.stoneLight);
  rect(ctx, 15, 9, 3, 52, C.stoneDark);
  for (let y = 14; y < 60; y += 8) rect(ctx, 2, y, 16, 1, C.stoneDark);
  speckle(ctx, 3, 10, 14, 50, "#88888866", 30, rng);
  rect(ctx, 2, 60, 16, 1, "#4c4c4c");
  // level hatch column (fill drawn dynamically by the renderer)
  rect(ctx, 8, 16, 4, 38, "#3a3a3a");
  rect(ctx, 7, 15, 6, 1, C.stoneDark);
  rect(ctx, 7, 54, 6, 1, C.stoneDark);
  return { canvas, w, h, windows: [], chimney: null };
}

function makeWindmillTower(): BuildingSprite {
  const w = 34;
  const h = 58;
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  const rng = mulberry32(23);
  // tapered stone tower
  for (let y = 12; y < h; y++) {
    const t = (y - 12) / (h - 12);
    const half = Math.round(8 + t * 7);
    rect(ctx, 17 - half, y, half * 2, 1, C.wallCream);
    rect(ctx, 17 - half, y, 2, 1, "#f0e0bc");
    rect(ctx, 17 + half - 3, y, 3, 1, C.wallCreamDark);
  }
  speckle(ctx, 6, 16, 24, 38, `${C.wallCreamDark}aa`, 26, rng);
  // cap
  disk(ctx, 17, 10, 9, C.roofRedDark);
  disk(ctx, 16, 9, 7.4, C.roofRed);
  rect(ctx, 12, 4, 5, 2, C.roofRedLight);
  // window + door
  rect(ctx, 14, 24, 7, 8, C.woodDark);
  rect(ctx, 15, 25, 5, 6, C.windowDark);
  rect(ctx, 15, 25, 5, 1, "#46587a");
  rect(ctx, 11, 46, 12, 12, C.woodDarker);
  rect(ctx, 12, 47, 10, 11, C.wood);
  rect(ctx, 12, 47, 10, 1, C.woodLight);
  rect(ctx, 6, 57, 22, 1, "#5a4326");
  return { canvas, w, h, windows: [{ x: 15, y: 25, w: 5, h: 6 }], chimney: null };
}

function makeBlades(diagonal: boolean): Sprite {
  const size = 50;
  const { sprite, ctx } = newSprite(size, size);
  const c = size / 2;
  const cell = (x: number, y: number, edge: boolean) => {
    rect(ctx, Math.round(x), Math.round(y), 1, 1, edge ? C.woodDarker : C.wallCream);
  };
  if (!diagonal) {
    // + shape: 4 axis-aligned arms, 4px thick, lattice holes inside
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      for (let i = 4; i <= 21; i++) {
        for (let t = -2; t <= 1; t++) {
          const x = c + dx * i + (dx === 0 ? t : 0);
          const y = c + dy * i + (dy === 0 ? t : 0);
          const edge = t === -2 || t === 1 || i === 21 || i === 4;
          const hole = !edge && i % 4 === 1;
          if (!hole) cell(x, y, edge);
        }
      }
    }
  } else {
    // x shape: 4 diagonal arms, 3px thick
    for (const [dx, dy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      for (let i = 3; i <= 15; i++) {
        const bx = c + dx * i;
        const by = c + dy * i;
        for (let t = -1; t <= 1; t++) {
          // perpendicular to the diagonal
          const x = bx + t * dx;
          const y = by - t * dy;
          const edge = t !== 0 || i === 15 || i === 3;
          const hole = !edge && i % 3 === 1;
          if (!hole) cell(x, y, edge);
        }
      }
    }
  }
  disk(ctx, c, c, 3.4, C.woodDarker);
  disk(ctx, c, c, 2.2, C.wood);
  return sprite;
}

function makeWell(): BuildingSprite {
  const w = 20;
  const h = 24;
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  // roof
  for (let r = 0; r < 6; r++) {
    const half = 3 + r;
    rect(ctx, 10 - half, r, half * 2, 1, r < 2 ? C.roofBlueLight : r < 4 ? C.roofBlue : C.roofBlueDark);
  }
  // posts
  rect(ctx, 2, 6, 2, 11, C.woodDark);
  rect(ctx, 16, 6, 2, 11, C.woodDark);
  rect(ctx, 3, 6, 1, 11, C.woodLight);
  // rope + bucket hanging over the mouth
  rect(ctx, 9, 6, 1, 5, "#d8c188");
  rect(ctx, 7, 11, 4, 3, C.wood);
  rect(ctx, 7, 11, 4, 1, C.woodLight);
  // stone ring with the shaft visible inside its mouth
  rect(ctx, 2, 16, 16, 6, C.stone);
  rect(ctx, 2, 16, 16, 1, C.stoneLight);
  rect(ctx, 2, 21, 16, 1, C.stoneDark);
  rect(ctx, 3, 18, 2, 2, C.stoneLight);
  rect(ctx, 15, 18, 2, 2, C.stoneDark);
  rect(ctx, 5, 17, 10, 3, "#10182a");
  rect(ctx, 6, 18, 8, 2, "#1e2c40");
  rect(ctx, 7, 18, 3, 1, "#3e77c8");
  return { canvas, w, h, windows: [], chimney: null };
}

function makeScarecrow(): Sprite {
  const { sprite, ctx } = newSprite(15, 22);
  // pole + arms
  rect(ctx, 7, 6, 2, 15, C.woodDark);
  rect(ctx, 1, 8, 13, 2, C.wood);
  // sleeves
  rect(ctx, 1, 7, 3, 3, "#7a5a9a");
  rect(ctx, 11, 7, 3, 3, "#7a5a9a");
  // body
  rect(ctx, 5, 10, 6, 6, "#8a66aa");
  rect(ctx, 5, 10, 6, 1, "#9d7cc0");
  // head
  disk(ctx, 8, 4.6, 3.2, C.sand);
  rect(ctx, 6, 4, 1, 1, C.outline);
  rect(ctx, 9, 4, 1, 1, C.outline);
  // hat
  rect(ctx, 4, 1, 8, 2, C.hayDark);
  rect(ctx, 5, 0, 6, 1, C.hay);
  rect(ctx, 3, 2, 10, 1, C.hay);
  // straw feet
  rect(ctx, 6, 20, 4, 2, C.hay);
  return sprite;
}

function makeSignpost(): Sprite {
  const { sprite, ctx } = newSprite(14, 15);
  rect(ctx, 6, 4, 2, 11, C.woodDark);
  rect(ctx, 1, 1, 12, 6, C.wood);
  rect(ctx, 1, 1, 12, 1, C.woodLight);
  rect(ctx, 1, 6, 12, 1, C.woodDarker);
  rect(ctx, 3, 3, 8, 1, C.woodDarker);
  rect(ctx, 3, 5, 5, 1, C.woodDarker);
  return sprite;
}

function makeMailbox(): Sprite {
  const { sprite, ctx } = newSprite(9, 14);
  rect(ctx, 4, 6, 2, 8, C.woodDark);
  rect(ctx, 1, 1, 7, 5, "#4a6fb0");
  rect(ctx, 1, 1, 7, 1, "#6389c9");
  rect(ctx, 1, 5, 7, 1, "#39588f");
  rect(ctx, 7, 2, 1, 2, "#e8442f");
  return sprite;
}

function makeLampPost(): Sprite {
  const { sprite, ctx } = newSprite(9, 22);
  rect(ctx, 4, 6, 2, 16, C.woodDarker);
  rect(ctx, 2, 21, 6, 1, C.woodDarker);
  rect(ctx, 2, 1, 6, 6, C.woodDarker);
  rect(ctx, 3, 2, 4, 4, C.windowGlow);
  rect(ctx, 3, 2, 4, 1, "#fff0b8");
  rect(ctx, 4, 0, 2, 1, C.woodDarker);
  return sprite;
}

// Dithered blobby cloud shadow, drawn pixel-checkered so it stays pixel-art.
function makeCloudShadow(seed: number): Sprite {
  const rng = mulberry32(seed);
  const w = 84 + Math.floor(rng() * 50);
  const h = 38 + Math.floor(rng() * 16);
  const { sprite, ctx } = newSprite(w, h);
  const blobs: Array<[number, number, number]> = [];
  const count = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    blobs.push([
      w * 0.2 + rng() * w * 0.6,
      h * 0.35 + rng() * h * 0.35,
      h * 0.3 + rng() * h * 0.28,
    ]);
  }
  ctx.fillStyle = "#141a2c";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((x + y) % 2 !== 0) continue; // checkerboard dither
      for (const [bx, by, r] of blobs) {
        const dx = x - bx;
        const dy = (y - by) * 1.7; // squash vertically
        if (dx * dx + dy * dy <= r * r) {
          ctx.fillRect(x, y, 1, 1);
          break;
        }
      }
    }
  }
  return sprite;
}

function makeBoat(): Sprite {
  const { sprite, ctx } = newSprite(20, 9);
  rect(ctx, 1, 3, 18, 4, C.wood);
  rect(ctx, 0, 3, 2, 3, C.woodDark);
  rect(ctx, 18, 3, 2, 3, C.woodDark);
  rect(ctx, 1, 3, 18, 1, C.woodLight);
  rect(ctx, 3, 6, 14, 1, C.woodDarker);
  rect(ctx, 9, 0, 1, 4, C.woodDark);
  return sprite;
}

// ---------------------------------------------------------------------------
// Weather / HUD icons (9x9)

const ICON_SUN = [
  "....#....",
  ".#..#..#.",
  "..#####..",
  ".##...##.",
  "###...###",
  ".##...##.",
  "..#####..",
  ".#..#..#.",
  "....#....",
];

const ICON_CLOUD = [
  ".........",
  "...###...",
  "..#####..",
  ".#######.",
  "#########",
  "#########",
  ".#######.",
  ".........",
  ".........",
];

const ICON_RAIN = [
  "...###...",
  "..#####..",
  ".#######.",
  "#########",
  ".#######.",
  ".........",
  ".#..#..#.",
  "#..#..#..",
  ".........",
];

const ICON_STORM = [
  "...###...",
  "..#####..",
  ".#######.",
  "#########",
  ".#######.",
  "....##...",
  "...##....",
  "..###....",
  "...#.....",
];

const ICON_MOON = [
  "...###...",
  "..##.....",
  ".##......",
  ".##......",
  ".##......",
  ".##......",
  "..##.....",
  "...####..",
  ".....##..",
];

// ---------------------------------------------------------------------------
// Atlas

export interface ValleySprites {
  player: CharacterSprites;
  farmer: CharacterSprites;
  villagers: CharacterSprites[];
  chicken: Sprite[];
  chickenFlip: Sprite[];
  butterfly: [Sprite, Sprite];
  bird: [Sprite, Sprite];
  crops: Record<string, Sprite[]>; // fruit color key -> stages
  seedling: Sprite;
  oaks: Sprite[];
  pines: Sprite[];
  bushes: Sprite[];
  flowers: Sprite[];
  grassTuft: Sprite;
  rocks: Sprite[];
  stump: Sprite;
  hayBale: Sprite;
  farmhouse: BuildingSprite;
  barn: BuildingSprite;
  silo: BuildingSprite;
  coop: BuildingSprite;
  houses: BuildingSprite[]; // village house variants
  windmill: BuildingSprite;
  blades: [Sprite, Sprite];
  well: BuildingSprite;
  scarecrow: Sprite;
  signpost: Sprite;
  mailbox: Sprite;
  lampPost: Sprite;
  boat: Sprite;
  clouds: Sprite[];
  icons: { sun: Sprite; cloud: Sprite; rain: Sprite; storm: Sprite; moon: Sprite };
}

export const CROP_COLORS: Record<string, string> = {
  orange: "#e8913a",
  red: "#d8443a",
  purple: "#9a5fc9",
  blue: "#4a8fd8",
  yellow: "#e8c93a",
  pink: "#e884b6",
};

const VILLAGERS: Array<{ style: CharStyle; pal: CharPalette }> = [
  { style: "short", pal: { hair: "#5a3a1e", shirt: "#4a6fb0", pants: "#3a4a68" } },
  { style: "long", pal: { hair: "#2b2118", shirt: "#c9564a", pants: "#5c4632", dress: "#c9564a" } },
  { style: "cap", pal: { hair: "#5a3a1e", cap: "#5f9e56", shirt: "#e8e0d0", pants: "#4a4a5e" } },
  { style: "short", pal: { hair: "#8a4a2a", shirt: "#9a5fc9", pants: "#3f3a50" } },
  { style: "long", pal: { hair: "#d87c9c", shirt: "#e8c93a", pants: "#4a5a6e", dress: "#e8c93a" } },
  { style: "cap", pal: { hair: "#2b2118", cap: "#4a4a4a", shirt: "#e07838", pants: "#3a5a4a" } },
];

export function buildSprites(): ValleySprites {
  const rng = mulberry32(1337);

  const villagers = VILLAGERS.map((v) => buildCharacter(v.style, v.pal));
  const chicken = chickenSprites();

  const crops: Record<string, Sprite[]> = {};
  for (const [key, color] of Object.entries(CROP_COLORS)) {
    crops[key] = [cropSprite(0, color), cropSprite(1, color), cropSprite(2, color), cropSprite(3, color)];
  }

  const farmhouse = makeHouse({
    w: 84,
    wallH: 34,
    roofH: 26,
    roof: [C.roofRedDark, C.roofRed, C.roofRedLight],
    wall: [C.wallCream, C.wallCreamDark],
    beams: true,
    windows: [
      { x: 12, y: 10, w: 10, h: 9 },
      { x: 62, y: 10, w: 10, h: 9 },
      { x: 37, y: 6, w: 8, h: 7 },
    ],
    door: { x: 36, w: 12, h: 17 },
    chimney: 54,
    seed: 3,
  });

  const barn = makeHouse({
    w: 68,
    wallH: 30,
    roofH: 22,
    roof: [C.stoneDark, C.stone, C.stoneLight],
    wall: ["#a04438", "#7e332a"],
    windows: [{ x: 10, y: 6, w: 8, h: 7 }],
    door: { x: 24, w: 20, h: 22 },
    bigDoor: true,
    chimney: null,
    seed: 5,
  });

  const coop = makeHouse({
    w: 44,
    wallH: 20,
    roofH: 14,
    roof: [C.roofGreenDark, C.roofGreen, C.roofGreenLight],
    wall: [C.plank, C.woodDark],
    windows: [{ x: 28, y: 5, w: 7, h: 6 }],
    door: { x: 8, w: 9, h: 11 },
    chimney: null,
    seed: 9,
  });

  const houseVariants: BuildingSprite[] = [
    [C.roofBlueDark, C.roofBlue, C.roofBlueLight] as [string, string, string],
    [C.roofRedDark, C.roofRed, C.roofRedLight] as [string, string, string],
    [C.roofGreenDark, C.roofGreen, C.roofGreenLight] as [string, string, string],
  ].map((roof, i) =>
    makeHouse({
      w: 34,
      wallH: 18,
      roofH: 13,
      roof,
      wall: i === 1 ? [C.plank, C.woodDark] : [C.wallCream, C.wallCreamDark],
      windows: [{ x: 22, y: 5, w: 6, h: 6 }],
      door: { x: 7, w: 8, h: 11 },
      chimney: i === 0 ? 24 : null,
      seed: 20 + i,
    }),
  );

  const farmer = buildCharacter("farmer", { hair: "#6b4a2a", cap: C.hay, shirt: "#5f9e56", pants: "#4a5a8a" });
  const player = buildCharacter("cap", { hair: "#7a5230", cap: "#4a86d8", shirt: "#f4f0e6", pants: "#3a4a68" });

  return {
    player,
    farmer,
    villagers,
    chicken,
    chickenFlip: chicken.map(flipSprite),
    butterfly: [
      spriteFromGrid(BUTTERFLY_A, { "#": "#e8c93a" }),
      spriteFromGrid(BUTTERFLY_B, { "#": "#e8c93a" }),
    ],
    bird: [spriteFromGrid(BIRD_A, { "#": "#3a3a4a" }), spriteFromGrid(BIRD_B, { "#": "#3a3a4a" })],
    crops,
    seedling: seedlingSprite(),
    oaks: [oakTree(rng), oakTree(rng), oakTree(rng)],
    pines: [pineTree(rng), pineTree(rng)],
    bushes: [bush(rng, null), bush(rng, "#d8443a"), bush(rng, null)],
    flowers: [flower(C.flowerPink), flower(C.flowerYellow), flower(C.flowerWhite)],
    grassTuft: grassTuft(),
    rocks: [rock(rng), rock(rng)],
    stump: stump(),
    hayBale: hayBale(),
    farmhouse,
    barn,
    silo: makeSilo(),
    coop,
    houses: houseVariants,
    windmill: makeWindmillTower(),
    blades: [makeBlades(false), makeBlades(true)],
    well: makeWell(),
    scarecrow: makeScarecrow(),
    signpost: makeSignpost(),
    mailbox: makeMailbox(),
    lampPost: makeLampPost(),
    boat: makeBoat(),
    clouds: [makeCloudShadow(31), makeCloudShadow(47), makeCloudShadow(83)],
    icons: {
      sun: spriteFromGrid(ICON_SUN, { "#": "#ffd554" }),
      cloud: spriteFromGrid(ICON_CLOUD, { "#": "#c9c9d4" }),
      rain: spriteFromGrid(ICON_RAIN, { "#": "#8fb6e8" }),
      storm: spriteFromGrid(ICON_STORM, { "#": "#ffd554" }),
      moon: spriteFromGrid(ICON_MOON, { "#": "#e8e4d4" }),
    },
  };
}
