// Sprite atlas for the valley, built once at game init. Characters and
// buildings come from their own painters; this file draws the nature and
// props (trees with separate canopies so they can sway, bushes, rocks,
// reeds, lamps, crops...) in the same outlined, top-left-lit style.

import { C, flipSprite, mulberry32, shade, spriteFromGrid, type Ctx, type Sprite } from "./core";
import { OUTLINE, disk, ellipse, line, newSprite, outlineSprite, poly, rect, rimShade, speckle } from "./paint";
import { paintBuilding, paintWindmillSails, HOUSE_STYLES, type BuildingSprite, type Rect } from "./buildings";
import {
  buildCharacter,
  chickenSprites,
  duckSprites,
  villagerLooks,
  FARMER_LOOK,
  PLAYER_LOOK,
  type CharacterSprites,
} from "./characters";
import type { DecorKind } from "./map";

export type { Rect, BuildingSprite, CharacterSprites };

export interface TreeSprite {
  trunk: Sprite;
  canopy: Sprite; // drawn at the same origin as the trunk, sways
}

export interface ValleySprites {
  player: CharacterSprites;
  farmer: CharacterSprites;
  villagers: CharacterSprites[];
  chicken: Sprite[];
  chickenFlip: Sprite[];
  chickenBrown: Sprite[];
  chickenBrownFlip: Sprite[];
  duck: Sprite[];
  duckFlip: Sprite[];
  butterfly: [Sprite, Sprite];
  bird: [Sprite, Sprite];
  crops: Record<string, Sprite[]>;
  seedling: Sprite;
  trees: Record<"oak" | "pine" | "birch" | "fruit" | "blossom", TreeSprite[]>;
  decor: Partial<Record<DecorKind, Sprite[]>>;
  buildings: Record<string, BuildingSprite>;
  sails: Sprite[];
  hayBale: Sprite;
  fence: { h: Sprite; v: Sprite; post: Sprite };
  // dialog portraits / legacy names
  farmhouse: BuildingSprite;
  barn: BuildingSprite;
  silo: BuildingSprite;
  coop: BuildingSprite;
  windmill: BuildingSprite;
  well: BuildingSprite;
  houses: BuildingSprite[];
  scarecrow: Sprite;
  signpost: Sprite;
  boat: Sprite;
  clouds: Sprite[];
  icons: { sun: Sprite; cloud: Sprite; rain: Sprite; storm: Sprite; moon: Sprite };
}

export const CROP_COLORS: Record<string, string> = {
  orange: "#e8913a",
  red: "#d8443a",
  purple: "#8a4fc0",
  blue: "#4a7fd8",
  yellow: "#f2cf3a",
  pink: "#ef7fae",
};

// --- trees ---------------------------------------------------------------------

function canopy(
  w: number,
  h: number,
  blobs: Array<[number, number, number]>,
  pal: { d: string; m: string; l: string; ll: string; o: string },
  rng: () => number,
): Sprite {
  const { sprite, ctx } = newSprite(w, h);
  for (const [x, y, r] of blobs) disk(ctx, x, y, r, pal.d);
  for (const [x, y, r] of blobs) disk(ctx, x - 1, y - 2, r - 2, pal.m);
  // light clumps toward the top-left
  for (const [x, y, r] of blobs) {
    if (r < 5) continue;
    disk(ctx, x - r * 0.35, y - r * 0.45, r * 0.45, pal.l);
    disk(ctx, x - r * 0.45, y - r * 0.6, r * 0.2, pal.ll);
  }
  // leaf texture: small darker arcs scattered through the mid tone
  const img = ctx.getImageData(0, 0, w, h).data;
  const isMid = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return img[i + 3] > 0;
  };
  for (let i = 0; i < (w * h) / 22; i++) {
    const x = 2 + Math.floor(rng() * (w - 5));
    const y = 2 + Math.floor(rng() * (h - 5));
    if (!isMid(x, y) || !isMid(x + 2, y + 1)) continue;
    const c = rng() < 0.6 ? pal.d : pal.l;
    rect(ctx, x, y + 1, 1, 1, c);
    rect(ctx, x + 1, y, 1, 1, c);
    rect(ctx, x + 2, y + 1, 1, 1, c);
  }
  rimShade(ctx, w, h, 1, 1, shade(pal.d, -0.15));
  outlineSprite(ctx, w, h, pal.o);
  return sprite;
}

function trunkSprite(w: number, h: number, x: number, top: number, tw: number, bark: string, birch = false): Sprite {
  const { sprite, ctx } = newSprite(w, h);
  const bot = h - 4;
  rect(ctx, x, top, tw, bot - top, bark);
  rect(ctx, x, top, 1, bot - top, shade(bark, 0.15));
  rect(ctx, x + tw - 2, top, 2, bot - top, shade(bark, -0.25));
  // root flare
  rect(ctx, x - 2, bot - 3, tw + 4, 3, bark);
  rect(ctx, x - 3, bot - 1, 2, 1, bark);
  rect(ctx, x + tw + 1, bot - 1, 2, 1, shade(bark, -0.25));
  rect(ctx, x + tw, bot - 3, 2, 3, shade(bark, -0.25));
  if (birch) {
    for (let y = top + 2; y < bot - 2; y += 4) rect(ctx, x + ((y * 3) % (tw - 2)), y, 2, 1, "#3a3a3a");
  } else {
    for (let y = top + 3; y < bot - 3; y += 5) rect(ctx, x + 2, y, 1, 3, shade(bark, -0.3));
  }
  outlineSprite(ctx, w, h, OUTLINE);
  return sprite;
}

function oak(rng: () => number, pal: { d: string; m: string; l: string; ll: string; o: string }, fruit?: string): TreeSprite {
  const W = 34;
  const H = 50;
  const j = () => Math.round((rng() - 0.5) * 3);
  const blobs: Array<[number, number, number]> = [
    [17 + j(), 18, 14],
    [9 + j(), 23, 8],
    [25 + j(), 23, 8],
    [17, 9 + j(), 10],
    [10, 13, 7],
    [24, 13, 7],
    [17, 27, 8],
  ];
  const cano = canopy(W, 40, blobs, pal, rng);
  if (fruit) {
    const ctx = cano.canvas.getContext("2d") as Ctx;
    for (let i = 0; i < 9; i++) {
      const x = 7 + Math.floor(rng() * 20);
      const y = 8 + Math.floor(rng() * 20);
      rect(ctx, x, y, 2, 2, fruit);
      rect(ctx, x, y, 1, 1, shade(fruit, 0.35));
    }
  }
  return { trunk: trunkSprite(W, H, 13, 28, 8, "#7a5234"), canopy: cano };
}

function fruitTree(rng: () => number, fruit: string): TreeSprite {
  const W = 30;
  const blobs: Array<[number, number, number]> = [
    [15, 15, 10],
    [9, 18, 6],
    [21, 18, 6],
    [15, 8, 7],
  ];
  const pal = { d: "#2f6a2d", m: "#3f8a3a", l: "#5aa84a", ll: "#7cc45e", o: "#1c3a1e" };
  const cano = canopy(W, 30, blobs, pal, rng);
  const ctx = cano.canvas.getContext("2d") as Ctx;
  for (let i = 0; i < 7; i++) {
    const x = 7 + Math.floor(rng() * 16);
    const y = 7 + Math.floor(rng() * 14);
    rect(ctx, x, y, 2, 2, fruit);
    rect(ctx, x, y, 1, 1, shade(fruit, 0.35));
  }
  return { trunk: trunkSprite(W, 42, 12, 22, 6, "#7a5234"), canopy: cano };
}

function pine(rng: () => number, dark: boolean): TreeSprite {
  const W = 34;
  const H = 52;
  const { sprite, ctx } = newSprite(W, 46);
  const pal = dark ? ["#1f4a33", "#2a5e40", "#3a7650", "#4f9062"] : ["#24553a", "#2f6a46", "#428556", "#5aa06a"];
  const tiers: Array<[number, number, number]> = [
    [44, 15, 16],
    [34, 13, 14],
    [24, 10, 12],
    [15, 7, 10],
  ];
  for (const [by, half, th] of tiers) {
    const pts: Array<[number, number]> = [
      [17 - half, by],
      [17, by - th],
      [17 + half, by],
    ];
    poly(ctx, pts, pal[1]);
    // jagged hem
    for (let x = 17 - half + 1; x < 17 + half - 1; x += 3) rect(ctx, x, by, 2, 1, pal[0]);
    // lit left flank
    const lpts: Array<[number, number]> = [
      [17 - half + 2, by - 1],
      [17, by - th + 1],
      [17 - 1, by - 2],
    ];
    poly(ctx, lpts, pal[2]);
    for (let i = 0; i < 6; i++) {
      const y = by - Math.floor(rng() * (th - 2)) - 1;
      const x = 17 - Math.floor(rng() * (half - 3));
      rect(ctx, x, y, 1, 1, pal[3]);
    }
  }
  rect(ctx, 16, 2, 2, 3, pal[2]);
  rimShade(ctx, W, 46, 1, 0, pal[0]);
  outlineSprite(ctx, W, 46, "#16301f");
  return { trunk: trunkSprite(W, H, 14, 38, 6, "#6a4630"), canopy: sprite };
}

// --- small decor -----------------------------------------------------------------

function blobSprite(w: number, h: number, blobs: Array<[number, number, number]>, pal: string[], dots?: string[], rng?: () => number): Sprite {
  const { sprite, ctx } = newSprite(w, h);
  for (const [x, y, r] of blobs) disk(ctx, x, y, r, pal[0]);
  for (const [x, y, r] of blobs) disk(ctx, x - 0.5, y - 1, r - 1.2, pal[1]);
  for (const [x, y, r] of blobs) disk(ctx, x - r * 0.35, y - r * 0.5, r * 0.4, pal[2]);
  if (dots && rng) {
    for (let i = 0; i < 7; i++) {
      const [bx, by, br] = blobs[Math.floor(rng() * blobs.length)];
      const x = bx + (rng() - 0.5) * br * 1.3;
      const y = by + (rng() - 0.6) * br * 1.1;
      const c = dots[Math.floor(rng() * dots.length)];
      rect(ctx, x, y, 2, 2, c);
      rect(ctx, x, y, 1, 1, shade(c, 0.35));
    }
  }
  rimShade(ctx, w, h, 1, 1, shade(pal[0], -0.15));
  outlineSprite(ctx, w, h, "#1c3a1e");
  return sprite;
}

function rockSprite(mossy: boolean, rng: () => number): Sprite {
  const { sprite, ctx } = newSprite(16, 12);
  ellipse(ctx, 8, 7, 6, 4, "#6e6a76");
  ellipse(ctx, 7.5, 6, 5, 3.4, "#8f8a96");
  ellipse(ctx, 6, 5, 2.6, 1.6, "#b3aeb8");
  speckle(ctx, 3, 5, 10, 4, "#6e6a76", 3, rng);
  if (mossy) {
    ellipse(ctx, 7, 3.5, 4, 1.6, "#5a8a3a");
    rect(ctx, 5, 3, 2, 1, "#7aa84a");
  }
  outlineSprite(ctx, 16, 12, OUTLINE);
  return sprite;
}

function stumpSprite(): Sprite {
  const { sprite, ctx } = newSprite(16, 14);
  rect(ctx, 2, 5, 12, 6, "#7a5234");
  rect(ctx, 11, 5, 3, 6, "#5a3a24");
  ellipse(ctx, 8, 5, 6, 2.5, "#c89a64");
  ellipse(ctx, 8, 5, 3, 1.2, "#a87a4a");
  rect(ctx, 1, 10, 3, 2, "#7a5234");
  rect(ctx, 12, 10, 3, 2, "#5a3a24");
  outlineSprite(ctx, 16, 14, OUTLINE);
  return sprite;
}

function logSprite(): Sprite {
  const { sprite, ctx } = newSprite(26, 12);
  rect(ctx, 4, 3, 18, 7, "#7a5234");
  rect(ctx, 4, 3, 18, 1, "#9a6a44");
  rect(ctx, 4, 8, 18, 2, "#5a3a24");
  for (let x = 7; x < 20; x += 5) rect(ctx, x, 5, 3, 1, "#5a3a24");
  ellipse(ctx, 4, 6.5, 2.4, 3.4, "#c89a64");
  rect(ctx, 4, 6, 1, 1, "#8a6a44");
  outlineSprite(ctx, 26, 12, OUTLINE);
  return sprite;
}

function tallGrass(rng: () => number): Sprite {
  const { sprite, ctx } = newSprite(12, 12);
  const cols = ["#3b7338", "#4a8a40", "#69b252", "#80c35e"];
  for (let i = 0; i < 7; i++) {
    const x = 1 + Math.floor(rng() * 9);
    const hgt = 5 + Math.floor(rng() * 6);
    const c = cols[Math.floor(rng() * cols.length)];
    line(ctx, x, 11, x + (rng() < 0.5 ? -1 : 1), 11 - hgt, c);
  }
  return sprite;
}

function reeds(rng: () => number): Sprite {
  const { sprite, ctx } = newSprite(14, 18);
  for (let i = 0; i < 5; i++) {
    const x = 2 + i * 2 + Math.floor(rng() * 2);
    const hgt = 8 + Math.floor(rng() * 7);
    line(ctx, x, 17, x + (i % 2 ? 1 : -1), 17 - hgt, i % 2 ? "#4f8a3c" : "#6aa84a");
    if (rng() < 0.6) rect(ctx, x + (i % 2 ? 1 : -1), 17 - hgt - 1, 2, 4, "#7a4a2a");
  }
  outlineSprite(ctx, 14, 18, "#1c3a1e");
  return sprite;
}

function lilyPad(flower: string | null): Sprite {
  const { sprite, ctx } = newSprite(12, 8);
  ellipse(ctx, 6, 4, 5, 2.6, "#3f8a3a");
  ellipse(ctx, 5.5, 3.5, 3.6, 1.6, "#5aa84a");
  rect(ctx, 6, 2, 3, 2, "rgba(0,0,0,0)");
  ctx.clearRect(6, 2, 3, 2);
  if (flower) {
    rect(ctx, 4, 2, 3, 2, flower);
    rect(ctx, 5, 1, 1, 1, shade(flower, 0.3));
  }
  outlineSprite(ctx, 12, 8, "#1f4a33");
  return sprite;
}

function lampSprite(): Sprite {
  const { sprite, ctx } = newSprite(11, 31);
  rect(ctx, 4, 8, 3, 21, "#2e2a36");
  rect(ctx, 4, 8, 1, 21, "#4a4656");
  rect(ctx, 2, 27, 7, 2, "#2e2a36");
  rect(ctx, 2, 1, 7, 2, "#2e2a36");
  rect(ctx, 3, 3, 5, 5, "#ffd977");
  rect(ctx, 3, 3, 2, 2, "#fff4c8");
  rect(ctx, 2, 3, 1, 5, "#2e2a36");
  rect(ctx, 8, 3, 1, 5, "#2e2a36");
  rect(ctx, 2, 8, 7, 1, "#2e2a36");
  rect(ctx, 5, 0, 1, 1, "#2e2a36");
  outlineSprite(ctx, 11, 31, OUTLINE);
  return sprite;
}

function benchSprite(): Sprite {
  const { sprite, ctx } = newSprite(24, 14);
  rect(ctx, 2, 2, 20, 3, "#9a6a3e");
  rect(ctx, 2, 2, 20, 1, "#b8854f");
  rect(ctx, 2, 6, 20, 3, "#8a5a33");
  rect(ctx, 2, 6, 20, 1, "#b8854f");
  rect(ctx, 3, 9, 2, 4, "#2e2a36");
  rect(ctx, 19, 9, 2, 4, "#2e2a36");
  rect(ctx, 3, 5, 1, 1, "#2e2a36");
  rect(ctx, 20, 5, 1, 1, "#2e2a36");
  outlineSprite(ctx, 24, 14, OUTLINE);
  return sprite;
}

function barrelSprite(): Sprite {
  const { sprite, ctx } = newSprite(13, 16);
  rect(ctx, 2, 2, 9, 12, "#8a5a33");
  rect(ctx, 1, 4, 11, 8, "#8a5a33");
  rect(ctx, 3, 2, 2, 12, "#a8743f");
  rect(ctx, 9, 2, 2, 12, "#6a4426");
  rect(ctx, 1, 4, 11, 1, "#5a5460");
  rect(ctx, 1, 11, 11, 1, "#5a5460");
  ellipse(ctx, 6.5, 2.5, 4.5, 1.5, "#b8854f");
  outlineSprite(ctx, 13, 16, OUTLINE);
  return sprite;
}

function crateSprite(): Sprite {
  const { sprite, ctx } = newSprite(26, 20);
  const box = (x: number, y: number, s: number) => {
    rect(ctx, x, y, s, s, "#9a6a3e");
    rect(ctx, x, y, s, 2, "#c89a64");
    rect(ctx, x + s - 2, y, 2, s, "#6a4426");
    line(ctx, x + 1, y + 2, x + s - 2, y + s - 1, "#6a4426");
    rect(ctx, x, y + s - 1, s, 1, "#5a3920");
  };
  box(1, 7, 12);
  box(12, 9, 10);
  box(5, 1, 9);
  outlineSprite(ctx, 26, 20, OUTLINE);
  return sprite;
}

function mailboxSprite(): Sprite {
  const { sprite, ctx } = newSprite(12, 18);
  rect(ctx, 5, 8, 2, 9, "#6a4426");
  rect(ctx, 2, 2, 8, 6, "#c9483c");
  rect(ctx, 2, 2, 8, 1, "#e0685a");
  rect(ctx, 3, 1, 6, 1, "#c9483c");
  rect(ctx, 2, 7, 8, 1, "#8e2e26");
  rect(ctx, 9, 2, 1, 3, "#f2cf4f");
  outlineSprite(ctx, 12, 18, OUTLINE);
  return sprite;
}

function signpostSprite(): Sprite {
  const { sprite, ctx } = newSprite(24, 26);
  rect(ctx, 11, 6, 3, 19, "#6a4426");
  rect(ctx, 11, 6, 1, 19, "#8a5a33");
  poly(ctx, [[2, 4], [18, 4], [22, 7.5], [18, 11], [2, 11]], "#9a6a3e");
  rect(ctx, 2, 4, 16, 1, "#b8854f");
  rect(ctx, 5, 7, 10, 1, "#5a3920");
  poly(ctx, [[6, 13], [21, 13], [21, 19], [6, 19], [2, 16]], "#8a5a33");
  rect(ctx, 8, 16, 10, 1, "#5a3920");
  outlineSprite(ctx, 24, 26, OUTLINE);
  return sprite;
}

function noticeboardSprite(): Sprite {
  const { sprite, ctx } = newSprite(28, 30);
  rect(ctx, 3, 12, 2, 16, "#6a4426");
  rect(ctx, 23, 12, 2, 16, "#5a3920");
  rect(ctx, 1, 2, 26, 16, "#7a5030");
  rect(ctx, 3, 4, 22, 12, "#c8a878");
  rect(ctx, 0, 1, 28, 2, "#5a3920");
  const notes = ["#f4f0e6", "#f2e6a0", "#e8f0f4", "#f4d8d8"];
  [[4, 5, 6, 7], [11, 6, 5, 6], [17, 5, 6, 8], [6, 11, 7, 4]].forEach(([x, y, w, h], i) => {
    rect(ctx, x, y, w, h, notes[i]);
    rect(ctx, x + 1, y + 2, w - 2, 1, "#8a8272");
    rect(ctx, x + w / 2, y, 1, 1, "#c9483c");
  });
  outlineSprite(ctx, 28, 30, OUTLINE);
  return sprite;
}

function hayBaleSprite(): Sprite {
  const { sprite, ctx } = newSprite(16, 13);
  rect(ctx, 1, 1, 14, 10, "#dcb850");
  rect(ctx, 1, 1, 14, 2, "#ecd070");
  rect(ctx, 1, 9, 14, 2, "#b8933a");
  rect(ctx, 5, 1, 1, 10, "#a8832a");
  rect(ctx, 10, 1, 1, 10, "#a8832a");
  speckle(ctx, 1, 3, 14, 6, "#c8a040", 8, mulberry32(3));
  outlineSprite(ctx, 16, 13, OUTLINE);
  return sprite;
}

function haySprite(): Sprite {
  const { sprite, ctx } = newSprite(28, 22);
  const b = hayBaleSprite();
  ctx.drawImage(b.canvas, 0, 8);
  ctx.drawImage(b.canvas, 12, 8);
  ctx.drawImage(b.canvas, 6, 0);
  return sprite;
}

function potSprite(flower: string): Sprite {
  const { sprite, ctx } = newSprite(12, 16);
  rect(ctx, 2, 8, 8, 7, "#b8603a");
  rect(ctx, 1, 8, 10, 2, "#d0784a");
  rect(ctx, 8, 10, 2, 5, "#8a4428");
  disk(ctx, 6, 5, 4, "#4f8a3c");
  disk(ctx, 5, 4, 2, "#6aa84a");
  for (const [x, y] of [[3, 3], [7, 2], [8, 6], [4, 6]]) rect(ctx, x, y, 2, 2, flower);
  outlineSprite(ctx, 12, 16, OUTLINE);
  return sprite;
}

function cartSprite(): Sprite {
  const { sprite, ctx } = newSprite(28, 20);
  rect(ctx, 2, 4, 20, 9, "#9a6a3e");
  rect(ctx, 2, 4, 20, 2, "#c89a64");
  for (let x = 6; x < 22; x += 5) rect(ctx, x, 6, 1, 7, "#6a4426");
  rect(ctx, 21, 8, 6, 2, "#6a4426");
  // pumpkins in the cart
  disk(ctx, 8, 4, 3, "#e8913a");
  disk(ctx, 14, 3, 3, "#e8913a");
  rect(ctx, 8, 0, 1, 2, "#4f8a3c");
  disk(ctx, 8, 15, 4, "#5a3920");
  disk(ctx, 8, 15, 2, "#9a6a3e");
  outlineSprite(ctx, 28, 20, OUTLINE);
  return sprite;
}

function woodpileSprite(): Sprite {
  const { sprite, ctx } = newSprite(26, 18);
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 4 - row; i++) {
      const x = 3 + i * 5 + row * 2.5;
      const y = 12 - row * 4;
      disk(ctx, x + 2, y + 2, 2.6, "#c89a64");
      rect(ctx, x + 2, y + 2, 1, 1, "#8a6a44");
    }
  }
  outlineSprite(ctx, 26, 18, OUTLINE);
  return sprite;
}

function boatSprite(): Sprite {
  const { sprite, ctx } = newSprite(30, 13);
  poly(ctx, [[1, 4], [29, 4], [25, 11], [5, 11]], "#8a5a33");
  rect(ctx, 2, 4, 26, 2, "#b8854f");
  rect(ctx, 5, 6, 20, 3, "#6a4426");
  rect(ctx, 13, 6, 3, 3, "#9a6a3e");
  line(ctx, 18, 3, 26, 0, "#5a3920");
  outlineSprite(ctx, 30, 13, OUTLINE);
  return sprite;
}

function dockSprite(): Sprite {
  const { sprite, ctx } = newSprite(50, 36);
  for (let y = 2; y < 30; y += 4) {
    rect(ctx, 2, y, 46, 3, "#a8743f");
    rect(ctx, 2, y, 46, 1, "#c89a64");
    rect(ctx, 2, y + 3, 46, 1, "#5a3920");
  }
  for (const x of [2, 45]) {
    rect(ctx, x, 0, 3, 34, "#6a4426");
    rect(ctx, x, 0, 3, 1, "#9a6a3e");
  }
  outlineSprite(ctx, 50, 36, OUTLINE);
  return sprite;
}

function scarecrowSprite(): Sprite {
  const { sprite, ctx } = newSprite(20, 30);
  rect(ctx, 9, 8, 2, 21, "#6a4426");
  rect(ctx, 2, 12, 16, 2, "#8a5a33");
  rect(ctx, 2, 11, 4, 4, "#6a5a9a");
  rect(ctx, 14, 11, 4, 4, "#6a5a9a");
  rect(ctx, 6, 13, 8, 8, "#8a66aa");
  rect(ctx, 6, 13, 8, 1, "#a888c8");
  rect(ctx, 9, 15, 2, 2, "#e8c93a");
  disk(ctx, 10, 7, 4, "#e0c890");
  rect(ctx, 8, 6, 1, 1, OUTLINE);
  rect(ctx, 11, 6, 1, 1, OUTLINE);
  rect(ctx, 8, 9, 4, 1, "#a87a4a");
  rect(ctx, 4, 3, 12, 2, "#b8933a");
  rect(ctx, 6, 0, 8, 3, "#dcb850");
  rect(ctx, 6, 2, 8, 1, "#c9483c");
  rect(ctx, 5, 20, 2, 2, "#dcb850");
  rect(ctx, 13, 20, 2, 2, "#dcb850");
  outlineSprite(ctx, 20, 30, OUTLINE);
  return sprite;
}

// fences: posts every tile with two rails
function fenceSprites(): { h: Sprite; v: Sprite; post: Sprite } {
  const post = (ctx: Ctx, x: number) => {
    rect(ctx, x, 1, 4, 12, "#9a6a3e");
    rect(ctx, x, 1, 1, 12, "#c89a64");
    rect(ctx, x + 3, 1, 1, 12, "#6a4426");
    rect(ctx, x, 1, 4, 1, "#d6ae78");
  };
  const h = newSprite(22, 15);
  rect(h.ctx, 3, 3, 17, 2, "#b8854f");
  rect(h.ctx, 3, 5, 17, 1, "#6a4426");
  rect(h.ctx, 3, 8, 17, 2, "#b8854f");
  rect(h.ctx, 3, 10, 17, 1, "#6a4426");
  post(h.ctx, 1);
  outlineSprite(h.ctx, 22, 15, OUTLINE);
  const v = newSprite(8, 30);
  rect(v.ctx, 3, 8, 2, 20, "#9a6a3e");
  rect(v.ctx, 4, 8, 1, 20, "#6a4426");
  post(v.ctx, 1);
  outlineSprite(v.ctx, 8, 30, OUTLINE);
  const p = newSprite(8, 15);
  post(p.ctx, 1);
  outlineSprite(p.ctx, 8, 15, OUTLINE);
  return { h: h.sprite, v: v.sprite, post: p.sprite };
}

// --- crops --------------------------------------------------------------------------

function cropSprite(stage: number, key: string): Sprite {
  const { sprite, ctx } = newSprite(16, 20);
  const fruit = CROP_COLORS[key];
  const leaf = "#4f9a3c";
  const leafL = "#72b85a";
  const leafD = "#357a2c";
  const cx = 8;
  const gy = 17;
  // soil mound
  ellipse(ctx, cx, gy + 0.5, 4, 1.5, "#5c3b25");
  if (stage === 0) {
    rect(ctx, cx, gy - 3, 1, 3, leaf);
    rect(ctx, cx - 2, gy - 4, 2, 1, leafL);
    rect(ctx, cx + 1, gy - 4, 2, 1, leafL);
    return sprite;
  }
  if (stage === 1) {
    rect(ctx, cx, gy - 5, 1, 5, leafD);
    ellipse(ctx, cx - 2.5, gy - 4, 2.4, 1.3, leaf);
    ellipse(ctx, cx + 3, gy - 5, 2.4, 1.3, leafL);
    ellipse(ctx, cx - 2, gy - 1.5, 2, 1, leafD);
    outlineSprite(ctx, 16, 20, "#1c3a1e");
    return sprite;
  }
  const tall = key === "yellow" || key === "purple" || key === "red";
  const top = tall ? gy - 12 : gy - 8;
  rect(ctx, cx, top, 1, gy - top, leafD);
  for (let y = top + 1; y < gy - 1; y += 3) {
    ellipse(ctx, cx - 2.5, y + 1, 2.6, 1.3, y % 2 ? leaf : leafL);
    ellipse(ctx, cx + 3, y, 2.6, 1.3, y % 2 ? leafL : leaf);
  }
  if (stage === 3) {
    if (key === "orange") {
      ellipse(ctx, cx, gy - 2, 5, 3.5, fruit);
      rect(ctx, cx - 2, gy - 5, 1, 5, shade(fruit, -0.2));
      rect(ctx, cx + 2, gy - 5, 1, 5, shade(fruit, -0.2));
      rect(ctx, cx - 3, gy - 4, 2, 1, shade(fruit, 0.3));
      rect(ctx, cx, gy - 6, 1, 2, leafD);
    } else if (key === "yellow") {
      disk(ctx, cx, top - 1, 4, fruit);
      disk(ctx, cx, top - 1, 2, "#8a5a24");
      rect(ctx, cx - 1, top - 2, 1, 1, "#b87a34");
    } else if (key === "blue") {
      for (const [x, y] of [[-3, -5], [2, -7], [-1, -9], [3, -3], [-4, -2]]) disk(ctx, cx + x, gy + y, 1.6, fruit);
      rect(ctx, cx - 3, gy - 6, 1, 1, shade(fruit, 0.4));
    } else if (key === "purple") {
      ellipse(ctx, cx - 3, top + 7, 1.8, 3, fruit);
      ellipse(ctx, cx + 3, top + 4, 1.8, 3, fruit);
      rect(ctx, cx - 4, top + 5, 1, 1, shade(fruit, 0.4));
    } else {
      for (const [x, y] of [[-3, -6], [3, -8], [0, -11], [2, -4]]) {
        disk(ctx, cx + x, gy + y, key === "pink" ? 1.5 : 1.8, fruit);
        rect(ctx, cx + x - 1, gy + y - 1, 1, 1, shade(fruit, 0.4));
      }
    }
  } else {
    // budding
    rect(ctx, cx - 1, top - 1, 3, 2, shade(fruit, 0.35));
  }
  outlineSprite(ctx, 16, 20, "#1c3a1e");
  return sprite;
}

function seedlingSprite(): Sprite {
  const { sprite, ctx } = newSprite(9, 9);
  rect(ctx, 4, 4, 1, 3, "#5a8a3a");
  rect(ctx, 2, 3, 2, 1, "#7aa84a");
  rect(ctx, 5, 2, 2, 1, "#7aa84a");
  ellipse(ctx, 4.5, 7, 3, 1, "#3f2718");
  return sprite;
}

// --- weather icons + clouds -----------------------------------------------------------

const ICON_SUN = ["....#....", ".#..#..#.", "..#####..", ".##...##.", "###...###", ".##...##.", "..#####..", ".#..#..#.", "....#...."];
const ICON_CLOUD = [".........", "...###...", "..#####..", ".#######.", "#########", "#########", ".#######.", ".........", "........."];
const ICON_RAIN = ["...###...", "..#####..", ".#######.", "#########", ".#######.", ".........", ".#..#..#.", "#..#..#..", "........."];
const ICON_STORM = ["...###...", "..#####..", ".#######.", "#########", ".#######.", "....##...", "...##....", "..###....", "...#....."];
const ICON_MOON = ["...###...", "..##.....", ".##......", ".##......", ".##......", ".##......", "..##.....", "...####..", ".....##.."];
const BUTTERFLY_A = ["#..#", "####", ".##.", "#..#"];
const BUTTERFLY_B = [".##.", "####", ".##.", ".##."];
const BIRD_A = ["#.....#", ".#...#.", "..###..", "...#..."];
const BIRD_B = ["...#...", "..###..", ".#...#.", "#.....#"];

function cloudShadow(seed: number): Sprite {
  const rng = mulberry32(seed);
  const w = 120 + Math.floor(rng() * 70);
  const h = 54 + Math.floor(rng() * 20);
  const { sprite, ctx } = newSprite(w, h);
  const blobs: Array<[number, number, number]> = [];
  for (let i = 0; i < 5; i++) blobs.push([w * 0.2 + rng() * w * 0.6, h * 0.35 + rng() * h * 0.3, h * 0.28 + rng() * h * 0.22]);
  ctx.fillStyle = "#141a2c";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (const [bx, by, r] of blobs) {
        const dx = x - bx;
        const dy = (y - by) * 1.7;
        if (dx * dx + dy * dy <= r * r) {
          ctx.fillRect(x, y, 1, 1);
          break;
        }
      }
    }
  }
  return sprite;
}

// --- atlas --------------------------------------------------------------------------------

export function buildSprites(): ValleySprites {
  const rng = mulberry32(1337);
  const looks = villagerLooks(16);
  const villagers = looks.map(buildCharacter);
  const chicken = chickenSprites("#f4efe4", "#d8d0c0");
  const chickenBrown = chickenSprites("#c8844a", "#9a5a2e");
  const duck = duckSprites();

  const crops: Record<string, Sprite[]> = {};
  for (const key of Object.keys(CROP_COLORS)) crops[key] = [0, 1, 2, 3].map((s) => cropSprite(s, key));

  const oakPal = { d: "#2f6a2d", m: "#3f8a3a", l: "#5aa84a", ll: "#7cc45e", o: "#1c3a1e" };
  const oakPal2 = { d: "#346a2a", m: "#4a8a34", l: "#6aa844", ll: "#8cc45a", o: "#1c3a1e" };
  const birchPal = { d: "#4a7a2a", m: "#6a9a3a", l: "#8ab84e", ll: "#a8d06a", o: "#243a18" };
  const blossomPal = { d: "#c05a8a", m: "#e07aa8", l: "#f0a0c4", ll: "#fcd0e2", o: "#5a2a44" };
  const trees: ValleySprites["trees"] = {
    oak: [oak(rng, oakPal), oak(rng, oakPal2), oak(rng, oakPal)],
    pine: [pine(rng, false), pine(rng, true), pine(rng, false)],
    birch: [0, 1, 2].map(() => {
      const t = oak(rng, birchPal);
      return { trunk: trunkSprite(34, 50, 14, 28, 6, "#e8e4dc", true), canopy: t.canopy };
    }),
    fruit: [fruitTree(rng, "#d8443a"), fruitTree(rng, "#e8913a"), fruitTree(rng, "#f2cf3a")],
    blossom: [oak(rng, blossomPal), oak(rng, blossomPal)],
  };

  const bushPal = ["#2f6a2d", "#3f8a3a", "#6aa84a"];
  const bushBlobs: Array<[number, number, number]> = [
    [10, 10, 6],
    [6, 11, 4],
    [14, 11, 4],
    [10, 7, 4],
  ];
  const decor: ValleySprites["decor"] = {
    bush: [0, 1, 2].map(() => blobSprite(20, 16, bushBlobs, bushPal)),
    berrybush: [0, 1, 2].map(() => blobSprite(20, 16, bushBlobs, bushPal, ["#c9304a", "#3a4ab8"], rng)),
    flowerbush: [
      blobSprite(20, 16, bushBlobs, bushPal, ["#ef7fae", "#f4f0e6"], rng),
      blobSprite(20, 16, bushBlobs, bushPal, ["#f2cf3a", "#f08a4b"], rng),
      blobSprite(20, 16, bushBlobs, bushPal, ["#9ab8f2", "#b77ee0"], rng),
    ],
    rock: [rockSprite(false, rng), rockSprite(false, rng), rockSprite(false, rng)],
    mossrock: [rockSprite(true, rng), rockSprite(true, rng)],
    stump: [stumpSprite()],
    log: [logSprite()],
    tallgrass: [tallGrass(rng), tallGrass(rng), tallGrass(rng)],
    reeds: [reeds(rng), reeds(rng), reeds(rng)],
    lilypad: [lilyPad(null), lilyPad("#f4b8d0"), lilyPad(null)],
    lamp: [lampSprite()],
    bench: [benchSprite()],
    barrel: [barrelSprite()],
    crates: [crateSprite()],
    mailbox: [mailboxSprite()],
    signpost: [signpostSprite()],
    noticeboard: [noticeboardSprite()],
    hay: [haySprite()],
    pot: [potSprite("#e0507a"), potSprite("#f2cf4f")],
    cart: [cartSprite()],
    woodpile: [woodpileSprite()],
    boat: [boatSprite()],
    dock: [dockSprite()],
    scarecrowpost: [scarecrowSprite()],
  };

  const ids = ["farmhouse", "barn", "silo", "coop", "windmill", "well", "store", "greenhouse", "fountain", ...HOUSE_STYLES.map((_, i) => `house${i}`)];
  const buildings: Record<string, BuildingSprite> = {};
  for (const id of ids) buildings[id] = paintBuilding(id);

  return {
    player: buildCharacter(PLAYER_LOOK),
    farmer: buildCharacter(FARMER_LOOK),
    villagers,
    chicken,
    chickenFlip: chicken.map(flipSprite),
    chickenBrown,
    chickenBrownFlip: chickenBrown.map(flipSprite),
    duck,
    duckFlip: duck.map(flipSprite),
    butterfly: [spriteFromGrid(BUTTERFLY_A, { "#": "#f2cf3a" }), spriteFromGrid(BUTTERFLY_B, { "#": "#f2cf3a" })],
    bird: [spriteFromGrid(BIRD_A, { "#": "#3a3a4a" }), spriteFromGrid(BIRD_B, { "#": "#3a3a4a" })],
    crops,
    seedling: seedlingSprite(),
    trees,
    decor,
    buildings,
    sails: paintWindmillSails(12),
    hayBale: hayBaleSprite(),
    fence: fenceSprites(),
    farmhouse: buildings.farmhouse,
    barn: buildings.barn,
    silo: buildings.silo,
    coop: buildings.coop,
    windmill: buildings.windmill,
    well: buildings.well,
    houses: HOUSE_STYLES.map((_, i) => buildings[`house${i}`]),
    scarecrow: decor.scarecrowpost![0],
    signpost: decor.signpost![0],
    boat: decor.boat![0],
    clouds: [cloudShadow(31), cloudShadow(47), cloudShadow(83)],
    icons: {
      sun: spriteFromGrid(ICON_SUN, { "#": "#ffd554" }),
      cloud: spriteFromGrid(ICON_CLOUD, { "#": "#c9c9d4" }),
      rain: spriteFromGrid(ICON_RAIN, { "#": "#8fb6e8" }),
      storm: spriteFromGrid(ICON_STORM, { "#": "#ffd554" }),
      moon: spriteFromGrid(ICON_MOON, { "#": "#e8e4d4" }),
    },
  };
}

// Bridge deck (walked on) and front railing (drawn over whoever crosses).
export function paintBridge(w: number, h: number): { deck: Sprite; backRail: Sprite; frontRail: Sprite } {
  const deck = newSprite(w, h);
  const c = deck.ctx;
  for (let x = 0; x < w; x += 5) {
    rect(c, x, 3, 5, h - 6, (x / 5) % 2 ? "#a8743f" : "#b8854f");
    rect(c, x, 3, 1, h - 6, "#6a4426");
    rect(c, x + 1, 3, 3, 1, "#d6ae78");
  }
  rect(c, 0, h - 4, w, 2, "#5a3920");
  rect(c, 0, 2, w, 1, "#5a3920");
  // posts into the water
  for (const x of [2, w - 6]) {
    rect(c, x, h - 3, 4, 3, "#4a2e1a");
  }
  const railFor = (): Sprite => {
    const r = newSprite(w, 12);
    for (let x = 0; x < w; x += 12) {
      rect(r.ctx, Math.min(x, w - 4), 1, 3, 10, "#8a5a33");
      rect(r.ctx, Math.min(x, w - 4), 1, 1, 10, "#b8854f");
    }
    rect(r.ctx, 0, 2, w, 2, "#b8854f");
    rect(r.ctx, 0, 4, w, 1, "#6a4426");
    rect(r.ctx, 0, 7, w, 1, "#9a6a3e");
    outlineSprite(r.ctx, w, 12, OUTLINE);
    return r.sprite;
  };
  return { deck: deck.sprite, backRail: railFor(), frontRail: railFor() };
}

export { C };
