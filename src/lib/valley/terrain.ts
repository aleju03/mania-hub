// Bakes the static ground once at init, per pixel: dithered grass patches
// with blade marks and baked flowers, organic dirt roads with a dark rim,
// a cobbled plaza, tilled soil, muddy banks and depth-banded water. The
// river's live states (flowing shimmer, murky, dry bed) are separate small
// layers over the river's bounding box so switching costs one drawImage.

import { MAP_W, TILE, WORLD_W, WORLD_H, createCanvas, ctx2d, hexToRgb } from "./core";
import { bayer, fbm, hash2 } from "./paint";
import { riverCenterAt, riverHalfAt, waterSignedDist, type Rect, type ValleyMap } from "./map";

export interface WaterLayer {
  box: Rect;
  shimmer: HTMLCanvasElement[]; // animated sparkle + shore foam frames
  dry: HTMLCanvasElement | null; // cracked bed when the feed stops
  murk: HTMLCanvasElement | null; // stagnant tint when the feed is stale
}

export interface Terrain {
  ground: HTMLCanvasElement;
  river: WaterLayer;
  pond: WaterLayer;
}

type RGB = [number, number, number];
const P = (hex: string): RGB => hexToRgb(hex);

const GRASS: RGB[] = [P("#2f5f33"), P("#3b7338"), P("#4a8a40"), P("#58a049"), P("#69b252"), P("#80c35e")];
const PATH: RGB[] = [P("#7d5a3a"), P("#9a7248"), P("#b68a58"), P("#c89c66"), P("#d8b27a")];
const COBBLE: RGB[] = [P("#5e5a62"), P("#7f7a80"), P("#948f94"), P("#a9a4a8"), P("#bdb8ba")];
const SOIL: RGB[] = [P("#4a2f1e"), P("#5c3b25"), P("#6e4a2e"), P("#835a38")];
const WET: RGB[] = [P("#3f3222"), P("#5a4630"), P("#6e5a3e")];
const WATER: RGB[] = [P("#6ec0e2"), P("#56a8d6"), P("#4692c8"), P("#3b80b9"), P("#3270a8")];
const MURK: RGB[] = [P("#93a66e"), P("#7f9660"), P("#6f8654"), P("#63784c"), P("#5a6e46")];
const DRY: RGB[] = [P("#c2a676"), P("#b09466"), P("#9c8056"), P("#7d6444")];
const FLOWERS: RGB[] = [P("#f4f0e0"), P("#f2cf4f"), P("#ef8fb6"), P("#9ab8f2"), P("#f08a5b")];

// Signed distance field to the dirt roads and the cobbled plaza, rasterised
// segment by segment inside each segment's padded bounding box.
function roadFields(map: ValleyMap): { dirt: Float32Array; cobble: Float32Array } {
  const dirt = new Float32Array(WORLD_W * WORLD_H).fill(1e9);
  const cobble = new Float32Array(WORLD_W * WORLD_H).fill(1e9);
  for (const r of map.roads) {
    const field = r.kind === "cobble" ? cobble : dirt;
    const half = r.width / 2;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, ay] = r.pts[i];
      const [bx, by] = r.pts[i + 1];
      const pad = half + 6;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad));
      const x1 = Math.min(WORLD_W - 1, Math.ceil(Math.max(ax, bx) + pad));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad));
      const y1 = Math.min(WORLD_H - 1, Math.ceil(Math.max(ay, by) + pad));
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
          const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - half;
          const i2 = y * WORLD_W + x;
          if (d < field[i2]) field[i2] = d;
        }
      }
    }
  }
  return { dirt, cobble };
}

function waterRGB(pal: RGB[], depth: number, x: number, y: number): RGB {
  const v = depth + (bayer(x, y) - 0.5) * 3;
  const idx = v < 2 ? 0 : v < 5 ? 1 : v < 10 ? 2 : v < 16 ? 3 : 4;
  return pal[idx];
}

export function bakeTerrain(map: ValleyMap): Terrain {
  const W = WORLD_W;
  const H = WORLD_H;
  const ground = createCanvas(W, H);
  const gctx = ctx2d(ground);
  const img = gctx.createImageData(W, H);
  const d = img.data;
  const kind = new Uint8Array(W * H); // 0 grass, 1 road, 2 cobble, 3 soil, 4 water, 5 bank
  const depth = new Float32Array(W * H);
  const { dirt, cobble } = roadFields(map);

  const put = (i: number, c: RGB) => {
    d[i * 4] = c[0];
    d[i * 4 + 1] = c[1];
    d[i * 4 + 2] = c[2];
    d[i * 4 + 3] = 255;
  };

  // water distance only matters near water; skip the expensive call elsewhere
  const pond = map.pondRect;
  const rc = new Float32Array(H);
  const rh = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    rc[y] = riverCenterAt(y);
    rh[y] = riverHalfAt(y);
  }
  const nearWater = (x: number, y: number): boolean => {
    if (Math.abs(x - rc[y]) < rh[y] + 14) return true;
    return x > pond.x - 14 && x < pond.x + pond.w + 14 && y > pond.y - 14 && y < pond.y + pond.h + 14;
  };

  // the grass patch noise is low frequency: sample it on a 4px grid and
  // interpolate instead of evaluating fbm for every pixel
  const STEP = 4;
  const gw = Math.ceil(W / STEP) + 1;
  const gh = Math.ceil(H / STEP) + 1;
  const patch = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) patch[gy * gw + gx] = fbm((gx * STEP) / 46, (gy * STEP) / 46, 1, 3);
  }
  const patchAt = (x: number, y: number): number => {
    const fx = x / STEP;
    const fy = y / STEP;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = patch[y0 * gw + x0];
    const b = patch[y0 * gw + x0 + 1];
    const c = patch[(y0 + 1) * gw + x0];
    const e = patch[(y0 + 1) * gw + x0 + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const wd = nearWater(x, y) ? waterSignedDist(x + 0.5, y + 0.5).d : 99;
      const nearEdge = Math.abs(dirt[i]) < 8 || Math.abs(cobble[i]) < 8;
      const edgeNoise = nearEdge ? (fbm(x / 7, y / 7, 11, 2) - 0.5) * 3.2 : 0;
      const rd = dirt[i] + edgeNoise;
      const cd = cobble[i] + edgeNoise * 0.6;
      const tile = map.soil[Math.floor(y / TILE) * MAP_W + Math.floor(x / TILE)];

      if (wd < 0) {
        kind[i] = 4;
        depth[i] = -wd;
        put(i, waterRGB(WATER, -wd, x, y));
        continue;
      }
      if (wd < 3.5) {
        kind[i] = 5;
        // muddy bank: darker right at the waterline
        const c = wd < 1.2 ? WET[0] : wd < 2.4 ? WET[1] : WET[2];
        put(i, hash2(x, y, 3) < 0.08 ? WET[2] : c);
        continue;
      }
      if (cd < 0) {
        kind[i] = 2;
        // pavers: jittered 7x5 stones with dark grout
        const row = Math.floor(y / 5);
        const off = (row % 2) * 3;
        const xx = (x + off) % 7;
        const yy = y % 5;
        let c: RGB;
        if (cd > -1.2) c = COBBLE[0];
        else if (xx === 0 || yy === 4) c = COBBLE[1];
        else {
          const k = hash2(Math.floor((x + off) / 7), row, 5);
          c = k < 0.3 ? COBBLE[2] : k > 0.8 ? COBBLE[4] : COBBLE[3];
          if (yy === 0 && xx === 1) c = COBBLE[4];
        }
        put(i, c);
        continue;
      }
      if (rd < 0) {
        kind[i] = 1;
        let c: RGB;
        if (rd > -1.3) c = PATH[0];
        else if (rd > -2.6) c = PATH[1];
        else {
          const n = fbm(x / 14, y / 14, 23, 2) + (bayer(x, y) - 0.5) * 0.14;
          c = n < 0.42 ? PATH[2] : n < 0.62 ? PATH[3] : PATH[4];
          const h = hash2(x, y, 7);
          if (h < 0.012) c = PATH[1];
          else if (h > 0.992) c = PATH[4];
        }
        put(i, c);
        continue;
      }
      if (tile) {
        kind[i] = 3;
        const lx = x % TILE;
        const ly = y % TILE;
        let c: RGB;
        if (tile === 2) {
          c = ly % 5 === 0 ? SOIL[1] : ly % 5 === 4 ? SOIL[0] : SOIL[1];
          if (hash2(x, y, 8) < 0.06) c = SOIL[2];
        } else {
          const r = ly % 4;
          c = r === 0 ? SOIL[3] : r === 3 ? SOIL[0] : SOIL[2];
          if (hash2(x, y, 9) < 0.05) c = SOIL[1];
          if (lx === 0 && hash2(Math.floor(x / TILE), Math.floor(y / 4), 2) < 0.2) c = SOIL[1];
        }
        put(i, c);
        continue;
      }
      // grass: soft dithered patches
      kind[i] = 0;
      const n = patchAt(x, y) + (bayer(x, y) - 0.5) * 0.1;
      let gi = n < 0.4 ? 2 : n < 0.6 ? 3 : 4;
      const h = hash2(x, y, 4);
      if (h < 0.035) gi = Math.max(1, gi - 1);
      else if (h > 0.985) gi = Math.min(5, gi + 1);
      // grass lip over road and bank edges
      if (rd < 1.6 || cd < 1.6 || wd < 5) gi = 1;
      else if (rd < 3 || cd < 3 || wd < 6.5) gi = Math.min(gi, 2);
      put(i, GRASS[gi]);
    }
  }

  // blade marks: tiny darker "^" strokes over the grass
  for (let cy = 0; cy < H; cy += 5) {
    for (let cx = 0; cx < W; cx += 5) {
      const h = hash2(cx, cy, 31);
      if (h > 0.34) continue;
      const x = cx + Math.floor(hash2(cx, cy, 32) * 3);
      const y = cy + Math.floor(hash2(cx, cy, 33) * 3);
      const pts: Array<[number, number]> = [
        [x, y + 1],
        [x + 1, y],
        [x + 2, y + 1],
      ];
      if (!pts.every(([px, py]) => px < W && py < H && kind[py * W + px] === 0)) continue;
      const base = y * W + x + 1;
      const r = d[base * 4];
      const darker: RGB = r > GRASS[3][0] ? GRASS[3] : r > GRASS[2][0] ? GRASS[2] : GRASS[1];
      for (const [px, py] of pts) put(py * W + px, darker);
      if (h < 0.06 && y > 0) put((y - 1) * W + x + 1, GRASS[5]);
    }
  }

  // baked flowers
  for (let k = 0; k < 900; k++) {
    const x = 2 + Math.floor(hash2(k, 1, 41) * (W - 4));
    const y = 2 + Math.floor(hash2(k, 2, 41) * (H - 4));
    if (kind[y * W + x] !== 0 || kind[(y + 1) * W + x] !== 0) continue;
    const c = FLOWERS[Math.floor(hash2(k, 3, 41) * FLOWERS.length)];
    put(y * W + x, c);
    if (hash2(k, 4, 41) < 0.6) {
      put(y * W + x - 1, c);
      put(y * W + x + 1, c);
      put((y - 1) * W + x, c);
      put(y * W + x, P("#f2cf4f"));
    }
    put((y + 1) * W + x, GRASS[1]);
  }

  // pebbles on the roads
  for (let k = 0; k < 1400; k++) {
    const x = 1 + Math.floor(hash2(k, 5, 43) * (W - 3));
    const y = 1 + Math.floor(hash2(k, 6, 43) * (H - 3));
    if (kind[y * W + x] !== 1 || kind[y * W + x + 1] !== 1) continue;
    put(y * W + x, PATH[4]);
    put(y * W + x + 1, PATH[3]);
    if (kind[(y + 1) * W + x] === 1) put((y + 1) * W + x, PATH[1]);
  }

  // soft contact shadows under buildings, fences and trees (multiply)
  const darken = (x: number, y: number, k: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    d[i] = d[i] * k;
    d[i + 1] = d[i + 1] * k;
    d[i + 2] = Math.min(255, d[i + 2] * k + 6);
  };
  const shadowEllipse = (cx: number, cy: number, rx: number, ry: number, k: number) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (e <= 1 && (e < 0.6 || bayer(x, y) > 0.5)) darken(x, y, k);
      }
    }
  };
  for (const b of map.buildings) {
    const gy = b.y + b.spec.base;
    const f = b.spec.foot;
    for (let y = gy - 2; y < gy + 5; y++) {
      for (let x = b.x + f.x - 2; x < b.x + f.x + f.w + 5; x++) {
        const fade = (y - (gy - 2)) / 7;
        if (bayer(x, y) > fade * 0.9) darken(x, y, 0.72);
      }
    }
  }
  for (const p of map.placements) {
    switch (p.kind) {
      case "oak":
      case "birch":
      case "blossom":
        shadowEllipse(p.x + 17, p.y + 45, 15, 5, 0.72);
        break;
      case "fruit":
        shadowEllipse(p.x + 14, p.y + 36, 11, 4, 0.72);
        break;
      case "pine":
        shadowEllipse(p.x + 16, p.y + 46, 12, 4, 0.72);
        break;
      case "bush":
      case "berrybush":
      case "flowerbush":
        shadowEllipse(p.x + 10, p.y + 14, 9, 3, 0.78);
        break;
      case "rock":
      case "mossrock":
      case "stump":
        shadowEllipse(p.x + 7, p.y + 10, 7, 2, 0.78);
        break;
      default:
        break;
    }
  }
  for (const f of map.fences) {
    for (let x = f.x; x < f.x + (f.kind === "h" ? TILE : 4); x++) darken(x, f.y + 9, 0.8);
  }

  gctx.putImageData(img, 0, 0);

  const riverBox: Rect = { x: 600, y: 0, w: 200, h: H };
  const river: WaterLayer = {
    box: riverBox,
    shimmer: shimmerFrames(riverBox, kind, depth, 4, true),
    dry: riverOverlay(riverBox, kind, depth, map, "dry"),
    murk: riverOverlay(riverBox, kind, depth, map, "murk"),
  };
  const pondBox: Rect = { x: pond.x - 4, y: pond.y - 4, w: pond.w + 8, h: pond.h + 8 };
  const pondLayer: WaterLayer = {
    box: pondBox,
    shimmer: shimmerFrames(pondBox, kind, depth, 4, false),
    dry: null,
    murk: null,
  };
  return { ground, river, pond: pondLayer };
}

function inBoxWater(box: Rect, kind: Uint8Array, cb: (x: number, y: number, lx: number, ly: number, i: number) => void): void {
  for (let ly = 0; ly < box.h; ly++) {
    const y = box.y + ly;
    if (y < 0 || y >= WORLD_H) continue;
    for (let lx = 0; lx < box.w; lx++) {
      const x = box.x + lx;
      if (x < 0 || x >= WORLD_W) continue;
      const i = y * WORLD_W + x;
      if (kind[i] === 4) cb(x, y, lx, ly, i);
    }
  }
}

function shimmerFrames(box: Rect, kind: Uint8Array, depth: Float32Array, n: number, river: boolean): HTMLCanvasElement[] {
  const frames: HTMLCanvasElement[] = [];
  for (let f = 0; f < n; f++) {
    const c = createCanvas(box.w, box.h);
    const ctx = ctx2d(c);
    const img = ctx.createImageData(box.w, box.h);
    const d = img.data;
    const put = (lx: number, ly: number, rgb: RGB, a = 255) => {
      if (lx < 0 || ly < 0 || lx >= box.w || ly >= box.h) return;
      const i = (ly * box.w + lx) * 4;
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
      d[i + 3] = a;
    };
    const foam = P("#d4eef8");
    const glint = P("#eefaff");
    const soft = P("#8cc8e6");
    inBoxWater(box, kind, (x, y, lx, ly, i) => {
      const dep = depth[i];
      // lapping foam along the shore, shifting each frame
      if (dep < 1.4) {
        if (hash2(x, y + f * 3, 51) < 0.5) put(lx, ly, foam, 230);
        return;
      }
      if (dep < 2.6 && hash2(x >> 1, y, 52 + f) < 0.25) {
        put(lx, ly, soft, 200);
        return;
      }
      // sparkles
      if (dep > 3 && hash2(x >> 1, y >> 1, 60 + f) < (river ? 0.012 : 0.018)) {
        put(lx, ly, glint);
        put(lx + 1, ly, glint, 200);
      }
    });
    ctx.putImageData(img, 0, 0);
    frames.push(c);
  }
  return frames;
}

function riverOverlay(box: Rect, kind: Uint8Array, depth: Float32Array, map: ValleyMap, mode: "dry" | "murk"): HTMLCanvasElement {
  const c = createCanvas(box.w, box.h);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(box.w, box.h);
  const d = img.data;
  const pond = map.pondRect;
  inBoxWater(box, kind, (x, y, lx, ly, i) => {
    // the pond keeps its water; only the river channel changes
    if (x > pond.x - 6 && y > pond.y - 6 && y < pond.y + pond.h + 6) return;
    const dep = depth[i];
    let rgb: RGB;
    if (mode === "murk") {
      rgb = waterRGB(MURK, dep, x, y);
    } else {
      const n = fbm(x / 9, y / 9, 71, 2);
      const crack = Math.abs(((n * 7) % 1) - 0.5) < 0.06;
      rgb = dep < 2.5 ? DRY[3] : dep < 7 ? DRY[1] : DRY[0];
      if (crack && dep > 2.5) rgb = DRY[3];
      else if (hash2(x, y, 72) < 0.03) rgb = DRY[2];
      if (dep > 13 && fbm(x / 16, y / 16, 73, 2) > 0.62) rgb = P("#5f86a8");
    }
    const o = (ly * box.w + lx) * 4;
    d[o] = rgb[0];
    d[o + 1] = rgb[1];
    d[o + 2] = rgb[2];
    d[o + 3] = 255;
  });
  ctx.putImageData(img, 0, 0);
  return c;
}
