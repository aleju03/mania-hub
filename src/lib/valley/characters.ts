// Procedural 16x24 characters: facing down / up / left (right is a mirror),
// four walk frames each (stand, stride, stand, other stride), with hair,
// hat, outfit and skin variety. Painted in parts and closed with the shared
// outline pass so they sit in the same style as the buildings.

import { flipSprite, mulberry32, shade, type Ctx, type Sprite } from "./core";
import { OUTLINE, newSprite, outlineSprite, ellipse } from "./paint";

export type HairStyle = "short" | "long" | "ponytail" | "bun" | "spiky" | "cap" | "straw" | "beanie";
export type Outfit = "shirt" | "overalls" | "dress" | "jacket";

export interface Look {
  hair: HairStyle;
  hairColor: string;
  hatColor?: string;
  skin: string;
  top: string;
  bottom: string;
  shoes: string;
  outfit: Outfit;
}

export interface CharacterSprites {
  down: Sprite[]; // 4 frames
  up: Sprite[];
  left: Sprite[];
  right: Sprite[];
  // legacy views used by interiors / dialog portraits
  front: Sprite[];
}

export const CHAR_W = 18; // incl. 1px outline margin
export const CHAR_H = 26;

type Dir = "down" | "up" | "left";

function painter(ctx: Ctx) {
  return (x: number, y: number, w: number, h: number, c: string) => {
    if (w <= 0 || h <= 0) return;
    ctx.fillStyle = c;
    ctx.fillRect(x + 1, y + 1, w, h);
  };
}

function paintCharacter(look: Look, dir: Dir, frame: number): Sprite {
  const { sprite, ctx } = newSprite(CHAR_W, CHAR_H);
  const r = painter(ctx);
  const skin = look.skin;
  const skinD = shade(skin, -0.16);
  const hair = look.hairColor;
  const hairD = shade(hair, -0.25);
  const hairL = shade(hair, 0.22);
  const top = look.top;
  const topD = shade(top, -0.22);
  const topL = shade(top, 0.16);
  const bot = look.bottom;
  const botD = shade(bot, -0.22);
  const shoes = look.shoes;
  const hat = look.hatColor ?? hair;
  const hatD = shade(hat, -0.25);
  const hatL = shade(hat, 0.2);
  const stride = frame === 1 || frame === 3;
  const bob = stride ? 0 : 0; // body stays level; legs carry the motion
  const b = bob;
  const isDress = look.outfit === "dress";
  const longHair = look.hair === "long";

  // -- long hair behind the body
  if (longHair && dir !== "up") {
    if (dir === "down") {
      r(2, 6 + b, 2, 8, hairD);
      r(12, 6 + b, 2, 8, hairD);
    } else {
      r(9, 6 + b, 4, 8, hairD);
    }
  }

  // -- legs + shoes
  if (dir === "left") {
    if (stride) {
      // near leg steps forward (left), far leg pushes off behind; the two
      // strides swap which leg is in front
      const nearFwd = frame === 1;
      const fwdC = nearFwd ? bot : botD;
      const backC = nearFwd ? botD : bot;
      r(8, 18, 3, 3, backC);
      r(9, 21, 3, 2, shade(shoes, -0.2));
      r(5, 18, 3, 4, fwdC);
      r(4, 22, 4, 2, shoes);
      r(6, 18, 4, 1, bot);
    } else {
      r(6, 18, 4, 4, bot);
      r(8, 18, 2, 4, botD);
      r(5, 22, 5, 2, shoes);
    }
  } else {
    const liftL = frame === 1;
    const liftR = frame === 3;
    const legTop = isDress ? 20 : 18;
    r(5, legTop, 3, 22 - legTop - (liftL ? 1 : 0), bot);
    r(8, legTop, 3, 22 - legTop - (liftR ? 1 : 0), botD);
    r(5, 22 - (liftL ? 1 : 0), 3, 2, shoes);
    r(8, 22 - (liftR ? 1 : 0), 3, 2, shade(shoes, -0.15));
  }

  // -- torso
  const tx = dir === "left" ? 4 : 4;
  const tw = dir === "left" ? 7 : 8;
  r(tx, 12 + b, tw, 6, top);
  r(tx, 12 + b, tw, 1, topL);
  r(tx + tw - 1, 12 + b, 1, 6, topD);
  r(tx, 17 + b, tw, 1, topD);
  if (look.outfit === "overalls") {
    r(tx + 1, 14 + b, tw - 2, 4, bot);
    r(tx + tw - 2, 14 + b, 1, 4, botD);
    if (dir !== "left") {
      r(tx + 1, 12 + b, 1, 2, bot);
      r(tx + tw - 2, 12 + b, 1, 2, bot);
      if (dir === "down") r(tx + 3, 15 + b, 2, 1, shade(bot, 0.2));
    } else {
      // bib on the chest (front = left), strap over the shoulder
      r(tx, 13 + b, 3, 2, bot);
      r(tx + 1, 12 + b, 1, 1, bot);
    }
  } else if (look.outfit === "jacket" && dir !== "up") {
    if (dir === "down") {
      r(tx + 3, 12 + b, 2, 6, shade(top, 0.35));
      r(tx + 3, 12 + b, 2, 1, "#f4f0e6");
    } else {
      r(tx, 12 + b, 1, 6, shade(top, 0.35));
    }
  } else if (look.outfit === "shirt") {
    r(tx, 17 + b, tw, 1, shade(bot, -0.3)); // belt
  }
  if (isDress) {
    const skirt = top;
    if (dir === "left") {
      r(3, 16, 9, 4, skirt);
      r(10, 16, 2, 4, topD);
      r(3, 19, 9, 1, topD);
    } else {
      r(3, 16, 10, 4, skirt);
      r(3, 16, 10, 1, topL);
      r(11, 16, 2, 4, topD);
      r(3, 19, 10, 1, topD);
    }
  }

  // -- arms
  const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  if (dir === "left") {
    const ax = swing === 1 ? 5 : swing === -1 ? 8 : 6;
    r(ax, 12 + b, 3, 3, top);
    r(ax + 2, 12 + b, 1, 3, topD);
    r(ax, 12 + b, 3, 1, topL);
    r(ax + (swing === 1 ? 0 : 1), 15 + b, 2, 2, skin);
  } else {
    r(3, 12 + b + swing, 1, 3, topD);
    r(3, 15 + b + swing, 1, 2, skin);
    r(12, 12 + b - swing, 1, 3, topD);
    r(12, 15 + b - swing, 1, 2, skinD);
  }

  // -- head
  const hy = 1 + b;
  if (dir === "down") {
    r(4, hy + 3, 8, 7, skin);
    r(5, hy + 10, 6, 1, skin);
    r(11, hy + 4, 1, 6, skinD);
    r(3, hy + 6, 1, 2, skin); // ears
    r(12, hy + 6, 1, 2, skinD);
    r(6, hy + 6, 1, 2, "#2a1d18");
    r(9, hy + 6, 1, 2, "#2a1d18");
    r(5, hy + 8, 1, 1, shade(skin, -0.05) === skin ? "#f0a8a0" : "#eba49a");
    r(10, hy + 8, 1, 1, "#eba49a");
  } else if (dir === "up") {
    r(4, hy + 3, 8, 7, skin);
    r(5, hy + 10, 6, 1, skinD);
    r(3, hy + 6, 1, 2, skin);
    r(12, hy + 6, 1, 2, skinD);
  } else {
    r(3, hy + 3, 9, 7, skin);
    r(4, hy + 10, 6, 1, skin);
    r(10, hy + 4, 2, 6, skinD);
    r(2, hy + 7, 1, 1, skin); // nose
    r(4, hy + 6, 1, 2, "#2a1d18");
    r(8, hy + 6, 1, 2, skinD); // ear
    r(4, hy + 8, 1, 1, "#eba49a");
  }

  // -- hair / hats
  const hairCap = (withFringe: boolean) => {
    if (dir === "down") {
      r(5, hy, 6, 1, hair);
      r(4, hy + 1, 8, 2, hair);
      r(3, hy + 2, 10, 2, hair);
      r(3, hy + 4, 1, 2, hair);
      r(12, hy + 4, 1, 2, hairD);
      if (withFringe) {
        r(4, hy + 4, 3, 1, hair);
        r(8, hy + 4, 2, 1, hair);
        r(4, hy + 3, 1, 1, hairD);
      }
      r(5, hy + 1, 2, 1, hairL);
      r(11, hy + 2, 2, 2, hairD);
    } else if (dir === "up") {
      r(5, hy, 6, 1, hair);
      r(4, hy + 1, 8, 2, hair);
      r(3, hy + 2, 10, 7, hair);
      r(4, hy + 9, 8, 1, hairD);
      r(5, hy + 1, 3, 1, hairL);
      r(11, hy + 2, 2, 7, hairD);
    } else {
      r(5, hy, 6, 1, hair);
      r(4, hy + 1, 8, 2, hair);
      r(3, hy + 2, 10, 2, hair);
      r(8, hy + 4, 5, 5, hair);
      r(10, hy + 9, 2, 1, hairD);
      if (withFringe) {
        // bangs swept forward over the forehead, as in the front view
        r(3, hy + 4, 6, 1, hair);
        r(3, hy + 5, 2, 1, hair);
        r(6, hy + 5, 2, 1, hair);
        r(4, hy + 5, 1, 1, hairD);
      }
      r(5, hy + 1, 3, 1, hairL);
      r(12, hy + 3, 1, 6, hairD);
      r(8, hy + 6, 1, 2, skinD); // ear in front of the hair
    }
  };

  switch (look.hair) {
    case "short":
    case "ponytail":
    case "bun":
      hairCap(true);
      if (look.hair === "ponytail") {
        if (dir === "up") {
          r(7, hy + 8, 2, 5, hair);
          r(8, hy + 8, 1, 5, hairD);
        } else if (dir === "left") {
          r(13, hy + 4, 1, 6, hairD);
          r(12, hy + 5, 1, 5, hair);
        } else {
          r(13, hy + 4, 1, 4, hairD);
        }
      }
      if (look.hair === "bun") {
        r(6, hy - 1, 4, 2, hair);
        r(7, hy - 1, 2, 1, hairL);
      }
      break;
    case "long":
      hairCap(true);
      if (dir === "down") {
        r(3, hy + 4, 1, 7, hair);
        r(12, hy + 4, 1, 7, hairD);
      } else if (dir === "up") {
        r(3, hy + 9, 10, 4, hair);
        r(11, hy + 9, 2, 4, hairD);
      } else {
        r(9, hy + 8, 4, 5, hair);
        r(11, hy + 8, 2, 5, hairD);
      }
      break;
    case "spiky":
      hairCap(false);
      if (dir !== "left") {
        r(4, hy - 1, 1, 1, hair);
        r(7, hy - 1, 1, 1, hair);
        r(10, hy - 1, 1, 1, hair);
        if (dir === "down") {
          r(4, hy + 4, 1, 1, hair);
          r(6, hy + 4, 1, 1, hair);
          r(9, hy + 4, 1, 1, hair);
          r(11, hy + 4, 1, 1, hair);
        }
      } else {
        r(5, hy - 1, 1, 1, hair);
        r(8, hy - 1, 1, 1, hair);
        r(11, hy - 1, 1, 1, hair);
        r(3, hy + 4, 1, 1, hair);
        r(5, hy + 4, 1, 1, hair);
      }
      break;
    case "cap":
      hairCap(false);
      if (dir === "down") {
        r(4, hy, 8, 1, hat);
        r(3, hy + 1, 10, 3, hat);
        r(5, hy + 1, 3, 1, hatL);
        r(3, hy + 4, 10, 1, hatD);
        r(7, hy + 2, 2, 1, "#f4f0e6");
      } else if (dir === "up") {
        r(4, hy, 8, 1, hat);
        r(3, hy + 1, 10, 3, hat);
        r(11, hy + 1, 2, 3, hatD);
        r(6, hy + 4, 4, 1, hatD);
      } else {
        r(5, hy, 7, 1, hat);
        r(3, hy + 1, 10, 3, hat);
        r(0, hy + 4, 7, 1, hatD);
        r(5, hy + 1, 2, 1, hatL);
        r(12, hy + 1, 1, 3, hatD);
      }
      break;
    case "straw": {
      hairCap(false);
      const straw = look.hatColor ?? "#e2c070";
      const strawD = shade(straw, -0.22);
      if (dir === "left") {
        r(4, hy - 1, 7, 4, straw);
        r(5, hy - 1, 3, 1, shade(straw, 0.2));
        r(4, hy + 2, 7, 1, "#b84a3a");
        r(0, hy + 3, 14, 1, straw);
        r(0, hy + 4, 14, 1, strawD);
      } else {
        r(5, hy - 1, 6, 4, straw);
        r(6, hy - 1, 3, 1, shade(straw, 0.2));
        r(5, hy + 2, 6, 1, "#b84a3a");
        r(1, hy + 3, 14, 1, straw);
        r(1, hy + 4, 14, 1, strawD);
      }
      break;
    }
    case "beanie": {
      hairCap(false);
      const k = hat;
      r(4, hy - 1, 8, 1, k);
      r(3, hy, 10, 3, k);
      r(3, hy + 3, 10, 2, shade(k, 0.25));
      r(7, hy - 2, 2, 1, "#f4f0e6");
      if (dir === "down") r(5, hy, 2, 1, shade(k, 0.2));
      break;
    }
  }

  outlineSprite(ctx, CHAR_W, CHAR_H, OUTLINE);
  return sprite;
}

export function buildCharacter(look: Look): CharacterSprites {
  const down = [0, 1, 2, 3].map((f) => paintCharacter(look, "down", f));
  const up = [0, 1, 2, 3].map((f) => paintCharacter(look, "up", f));
  const left = [0, 1, 2, 3].map((f) => paintCharacter(look, "left", f));
  const right = left.map(flipSprite);
  return { down, up, left, right, front: down };
}

const SKINS = ["#f7d7b8", "#efc39c", "#d9a077", "#b87a52", "#8e5a3a", "#6a4230"];
const HAIRS = ["#3a2a1e", "#6b4226", "#a8683a", "#e0c070", "#2a2a36", "#c85a3a", "#7a5aa8", "#e8e4dc", "#d87aa0", "#4a7ab8"];
const TOPS = ["#4a6fb0", "#c9564a", "#5f9e56", "#e8c93a", "#9a5fc9", "#e07838", "#3aa0a0", "#e8e0d0", "#d86a9a", "#6a7a8a"];
const BOTTOMS = ["#3a4a68", "#5c4632", "#4a4a5e", "#3f3a50", "#4a5a6e", "#3a5a4a", "#6a5a4a"];
const STYLES: HairStyle[] = ["short", "long", "ponytail", "bun", "spiky", "cap", "beanie", "short", "long"];
const OUTFITS: Outfit[] = ["shirt", "shirt", "dress", "jacket", "overalls", "shirt", "jacket"];

// n distinct-looking villagers, deterministic
export function villagerLooks(n: number, seed = 5): Look[] {
  const rng = mulberry32(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const out: Look[] = [];
  for (let i = 0; i < n; i++) {
    const hair = STYLES[i % STYLES.length];
    out.push({
      hair,
      hairColor: pick(HAIRS),
      hatColor: pick(TOPS),
      skin: SKINS[(i * 5 + Math.floor(rng() * 2)) % SKINS.length],
      top: TOPS[(i * 3 + 1) % TOPS.length],
      bottom: pick(BOTTOMS),
      shoes: rng() < 0.5 ? "#4a3226" : "#2e2a30",
      outfit: OUTFITS[(i * 2 + Math.floor(rng() * 3)) % OUTFITS.length],
    });
  }
  return out;
}

export const PLAYER_LOOK: Look = {
  hair: "short",
  hairColor: "#7a4a2a",
  skin: "#efc39c",
  top: "#5f9ed8",
  bottom: "#3a4a68",
  shoes: "#4a3226",
  outfit: "overalls",
};

export const FARMER_LOOK: Look = {
  hair: "straw",
  hairColor: "#6b4226",
  hatColor: "#e2c070",
  skin: "#d9a077",
  top: "#c9564a",
  bottom: "#4a5a8a",
  shoes: "#4a3226",
  outfit: "overalls",
};

// --- animals ----------------------------------------------------------------

export function chickenSprites(body: string, dark: string): Sprite[] {
  const make = (pose: "a" | "b" | "peck"): Sprite => {
    const { sprite, ctx } = newSprite(16, 15);
    const r = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(x, y, w, h);
    };
    const headDown = pose === "peck";
    // tail
    r(11, 4, 2, 3, body);
    r(12, 3, 2, 2, dark);
    // body
    ellipse(ctx, 8, 8, 5, 3.6, body);
    r(6, 9, 6, 2, shade(body, -0.12));
    r(8, 7, 3, 1, dark); // wing
    r(8, 8, 4, 1, shade(body, -0.2));
    // legs
    const legY = 12;
    if (pose === "a") {
      r(6, legY, 1, 2, "#d9932f");
      r(9, legY, 1, 2, "#d9932f");
    } else if (pose === "b") {
      r(7, legY, 1, 2, "#d9932f");
      r(8, legY, 1, 2, "#d9932f");
    } else {
      r(7, legY, 1, 2, "#d9932f");
      r(9, legY, 1, 2, "#d9932f");
    }
    // head
    const hx = headDown ? 3 : 4;
    const hy = headDown ? 8 : 2;
    r(hx, hy, 4, 4, body);
    r(hx + 1, hy - 1, 2, 1, "#d8443a");
    r(hx - 1, hy + 2, 1, 1, "#e8a23a");
    r(hx + 1, hy + 1, 1, 1, "#2a1d18");
    r(hx, hy + 3, 1, 1, "#d8443a");
    if (!headDown) r(hx + 2, hy + 4, 2, 2, body);
    outlineSprite(ctx, 16, 15, OUTLINE);
    return sprite;
  };
  return [make("a"), make("b"), make("peck")];
}

export function duckSprites(): Sprite[] {
  const make = (bob: number): Sprite => {
    const { sprite, ctx } = newSprite(16, 12);
    const r = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(x, y, w, h);
    };
    ellipse(ctx, 9, 7 + bob, 5, 2.6, "#f2eee4");
    r(6, 8 + bob, 8, 1, "#d8d2c4");
    r(12, 5 + bob, 2, 2, "#f2eee4");
    r(9, 6 + bob, 3, 1, "#d8d2c4");
    r(3, 2 + bob, 3, 4, "#f2eee4");
    r(1, 4 + bob, 2, 1, "#e8a23a");
    r(4, 3 + bob, 1, 1, "#2a1d18");
    outlineSprite(ctx, 16, 12, OUTLINE);
    return sprite;
  };
  return [make(0), make(1)];
}
