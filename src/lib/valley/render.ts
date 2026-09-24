// Frame renderer: a follow camera over the baked ground, layered water with
// a visible downstream current, y-sorted world objects (culled to the view),
// weather, day/night lighting and the Deltarune-style dialog UI. Pure
// canvas-2d + bitmap font, so it also runs under the offline harness.

import { C, clamp, createCanvas, ctx2d, lerp, VIEW_W, VIEW_H, WORLD_W, WORLD_H, type Ctx, type Sprite } from "./core";
import { drawText, textWidth, FONT_H } from "./font";
import type { ValleyMap, Placement } from "./map";
import { WALL_H, type Interior } from "./interiors";
import type { ValleySim, Npc, Player, Face } from "./sim";
import { paintBridge, type Rect, type ValleySprites, type BuildingSprite, type CharacterSprites } from "./sprites";
import { bakeTerrain, type Terrain, type WaterLayer } from "./terrain";

export interface DialogState {
  id: string;
  title: string;
  lines: string[];
  revealed: number; // characters revealed so far (typewriter)
  portrait: Sprite | null;
  accent: string;
}

export interface RenderInput {
  hour: number; // local time as float hours
  dt: number;
  zoom: number; // integer world scale
  wide: boolean; // wide camera mode (for the button label)
  ui: number; // integer HUD scale
  portrait: boolean;
  muted: boolean;
  audioUnlocked: boolean;
  mouse: { x: number; y: number } | null; // screen space (canvas px)
  hover: { id: string; label: string } | null;
  dialog: DialogState | null;
  mapOpen?: boolean;
}

interface Drawable {
  baseline: number;
  draw: (ctx: Ctx) => void;
}

interface StaticItem {
  p: Placement;
  bounds: Rect; // world rect for culling
  baseline: number;
}

function skyTint(hour: number): { color: string; a: number } {
  // keyframes: [hour, r,g,b, alpha]
  const keys: Array<[number, number, number, number, number]> = [
    [0, 22, 36, 79, 0.6],
    [5, 22, 36, 79, 0.6],
    [6.7, 122, 74, 51, 0.26],
    [8, 0, 0, 0, 0],
    [16.5, 0, 0, 0, 0],
    [18.2, 138, 74, 47, 0.2],
    [19.8, 58, 43, 82, 0.42],
    [21, 22, 36, 79, 0.6],
    [24, 22, 36, 79, 0.6],
  ];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (hour >= a[0] && hour <= b[0]) {
      const t = (hour - a[0]) / Math.max(0.0001, b[0] - a[0]);
      const r = Math.round(lerp(a[1], b[1], t));
      const g = Math.round(lerp(a[2], b[2], t));
      const bl = Math.round(lerp(a[3], b[3], t));
      return { color: `rgb(${r},${g},${bl})`, a: lerp(a[4], b[4], t) };
    }
  }
  return { color: "#000000", a: 0 };
}

export function nightFactor(hour: number): number {
  return skyTint(hour).a / 0.6;
}

// Size of each decor sprite's footprint, for culling and sorting.
function decorBounds(p: Placement, s: ValleySprites): { w: number; h: number; base: number } {
  if (p.kind === "building") {
    const b = s.buildings[p.id];
    const extra = p.id === "windmill" ? 44 : 0;
    return { w: b.w + extra, h: b.h + extra, base: b.h };
  }
  if (p.kind === "oak" || p.kind === "birch" || p.kind === "blossom") return { w: 34, h: 50, base: 46 };
  if (p.kind === "pine") return { w: 34, h: 52, base: 47 };
  if (p.kind === "fruit") return { w: 30, h: 42, base: 37 };
  const spr = s.decor[p.kind as keyof ValleySprites["decor"]]?.[0];
  if (!spr) return { w: 16, h: 16, base: 14 };
  const base = p.kind === "lilypad" || p.kind === "dock" ? -1000 : spr.h - 2;
  return { w: spr.w, h: spr.h, base };
}

export class ValleyRenderer {
  private map: ValleyMap;
  private s: ValleySprites;
  private terrain: Terrain;
  private bridges: Array<{ rect: Rect; deck: Sprite; backRail: Sprite; frontRail: Sprite }>;
  private statics: StaticItem[];
  private flats: StaticItem[]; // lily pads, dock: drawn flat before sorting
  private vignette: HTMLCanvasElement;
  private viewCanvas: HTMLCanvasElement;
  private vctx: Ctx;
  private room: HTMLCanvasElement; // interiors draw into a fixed VIEW-sized scene
  private rctx: Ctx;
  private lightningUntil = 0;
  private litWindows: Array<{ x: number; y: number; w: number; h: number }> = [];
  private streaks: Array<{ y: number; u: number; len: number; speed: number; phase: number }> = [];
  readonly cam = { x: 0, y: 0 };
  private sw = VIEW_W;
  private sh = VIEW_H;
  private u = 1;
  private portrait = false;
  private view = { k: 2, ox: 0, oy: 0 };
  private viewRect: Rect = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

  constructor(map: ValleyMap, sprites: ValleySprites) {
    this.map = map;
    this.s = sprites;
    this.terrain = bakeTerrain(map);
    this.bridges = map.bridges.map((rect) => ({ rect, ...paintBridge(rect.w, rect.h) }));
    this.statics = [];
    this.flats = [];
    for (const p of map.placements) {
      const b = decorBounds(p, sprites);
      const ox = p.id === "windmill" ? -22 : 0;
      const oy = p.id === "windmill" ? -22 : 0;
      const item = { p, bounds: { x: p.x + ox, y: p.y + oy, w: b.w, h: b.h }, baseline: p.y + b.base };
      if (p.kind === "lilypad" || p.kind === "dock" || p.kind === "boat") this.flats.push(item);
      else this.statics.push(item);
    }
    this.vignette = this.renderVignette();
    this.viewCanvas = createCanvas(VIEW_W, VIEW_H);
    this.vctx = ctx2d(this.viewCanvas);
    this.room = createCanvas(VIEW_W, VIEW_H);
    this.rctx = ctx2d(this.room);
    for (let i = 0; i < 140; i++) {
      this.streaks.push({
        y: Math.random() * WORLD_H,
        u: (Math.random() - 0.5) * 1.5,
        len: 3 + Math.floor(Math.random() * 5),
        speed: 0.75 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  flashLightning(simT: number): void {
    this.lightningUntil = simT + 0.18;
  }

  private renderVignette(): HTMLCanvasElement {
    const canvas = createCanvas(VIEW_W, VIEW_H);
    const ctx = ctx2d(canvas);
    const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.55, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.95);
    g.addColorStop(0, "rgba(10,8,20,0)");
    g.addColorStop(1, "rgba(10,8,20,0.24)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    return canvas;
  }

  private visible(r: Rect, pad = 8): boolean {
    const v = this.viewRect;
    return r.x < v.x + v.w + pad && r.x + r.w > v.x - pad && r.y < v.y + v.h + pad && r.y + r.h > v.y - pad;
  }

  // ---------------------------------------------------------------- water

  private drawLayer(ctx: Ctx, layer: WaterLayer, img: HTMLCanvasElement, alpha = 1): void {
    const b = layer.box;
    const v = this.viewRect;
    const x0 = Math.max(b.x, v.x);
    const y0 = Math.max(b.y, v.y);
    const x1 = Math.min(b.x + b.w, v.x + v.w);
    const y1 = Math.min(b.y + b.h, v.y + v.h);
    if (x1 <= x0 || y1 <= y0) return;
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(img, x0 - b.x, y0 - b.y, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    if (alpha < 1) ctx.globalAlpha = 1;
  }

  private drawWater(ctx: Ctx, sim: ValleySim): void {
    const { river, pond } = this.terrain;
    const t = sim.t;
    const state = sim.riverState;
    const frame = Math.floor(t * 3.2) % 4;
    // pond always has water
    this.drawLayer(ctx, pond, pond.shimmer[frame]);
    if (state === "dry") {
      if (river.dry) this.drawLayer(ctx, river, river.dry);
      return;
    }
    if (state === "stale" && river.murk) this.drawLayer(ctx, river, river.murk);
    this.drawLayer(ctx, river, river.shimmer[state === "stale" ? Math.floor(t * 1.2) % 4 : frame], state === "stale" ? 0.5 : 1);

    // current: short light streaks drifting downstream, fading in and out
    const speed = state === "flow" ? 34 : 7;
    const v = this.viewRect;
    ctx.fillStyle = state === "flow" ? "#bfe6f5" : "#a8b888";
    for (const st of this.streaks) {
      const y = (((st.y + t * speed * st.speed) % WORLD_H) + WORLD_H) % WORLD_H;
      if (y < v.y - 8 || y > v.y + v.h + 8) continue;
      const cx = this.map.riverCenter(y);
      const hw = this.map.riverHalf(y) - 5;
      const x = Math.round(cx + st.u * hw * 0.62);
      if (x < v.x - 2 || x > v.x + v.w + 2) continue;
      const a = 0.35 + 0.45 * Math.sin(t * 1.6 + st.phase);
      if (a <= 0.05) continue;
      ctx.globalAlpha = a * (state === "flow" ? 1 : 0.6);
      // follow the channel's slope so streaks bend with the meanders
      const slope = (this.map.riverCenter(y + st.len) - cx) / st.len;
      for (let k = 0; k < st.len; k++) ctx.fillRect(Math.round(x + slope * k), Math.round(y + k), 1, 1);
    }
    ctx.globalAlpha = 1;

    // eddy chevrons behind the bridge posts
    if (state === "flow") {
      ctx.fillStyle = "#d4eef8";
      for (const b of this.map.bridges) {
        const cx = this.map.riverCenter(b.y + b.h);
        const ph = Math.floor(t * 4) % 3;
        for (const dx of [-12, 12]) {
          ctx.fillRect(Math.round(cx + dx - 2), b.y + b.h + 2 + ph, 2, 1);
          ctx.fillRect(Math.round(cx + dx + 1), b.y + b.h + 2 + ph, 2, 1);
          ctx.fillRect(Math.round(cx + dx - 3), b.y + b.h + 4 + ph, 1, 1);
          ctx.fillRect(Math.round(cx + dx + 3), b.y + b.h + 4 + ph, 1, 1);
        }
      }
    }
  }

  // ---------------------------------------------------------------- characters

  private characterDraw(ctx: Ctx, chars: CharacterSprites, x: number, y: number, walking: boolean, face: Face, t: number, rate = 7, phase = 0): void {
    const frame = walking ? Math.floor(t * rate + phase) % 4 : 0;
    const set = face === "up" ? chars.up : face === "left" ? chars.left : face === "right" ? chars.right : chars.down;
    const spr = set[frame];
    const bob = walking && (frame === 1 || frame === 3) ? -1 : 0;
    ctx.fillStyle = "rgba(20,24,16,0.28)";
    ctx.fillRect(Math.round(x - 5), Math.round(y - 1), 10, 2);
    ctx.fillRect(Math.round(x - 4), Math.round(y - 2), 8, 1);
    ctx.drawImage(spr.canvas, Math.round(x - spr.w / 2), Math.round(y - spr.h + 2 + bob));
  }

  private npcDrawable(n: Npc, sim: ValleySim): Drawable {
    const s = this.s;
    return {
      baseline: n.y + 1,
      draw: (ctx) => {
        const walking = n.state === "walk";
        const chars = n.kind === "farmer" ? s.farmer : s.villagers[n.palette % s.villagers.length];
        if (n.state === "work") {
          // hoeing: bob down/up facing the plot
          const hit = Math.floor(sim.t * 5 + n.id) % 2;
          this.characterDraw(ctx, chars, n.x, n.y + hit, false, "down", sim.t);
          return;
        }
        if (n.state === "sleep") {
          this.characterDraw(ctx, chars, n.x, n.y, false, "down", sim.t);
          return;
        }
        this.characterDraw(ctx, chars, n.x, n.y, walking, n.face, sim.t, 6.5, n.id * 1.7);
      },
    };
  }

  private playerDrawable(p: Player, sim: ValleySim): Drawable {
    return {
      baseline: p.y + 2,
      draw: (ctx) => this.characterDraw(ctx, this.s.player, p.x, p.y, p.moving, p.face, sim.t, p.sprinting ? 11 : 7.5),
    };
  }

  // ---------------------------------------------------------------- statics

  private staticDrawable(item: StaticItem, sim: ValleySim, nf: number, sway: number): Drawable | null {
    const { p } = item;
    const s = this.s;
    if (p.kind === "building") {
      const spr = s.buildings[p.id];
      return this.buildingDrawable(p, spr, sim, nf, item.baseline);
    }
    if (p.kind === "oak" || p.kind === "pine" || p.kind === "birch" || p.kind === "fruit" || p.kind === "blossom") {
      const tree = s.trees[p.kind][p.variant % s.trees[p.kind].length];
      const k = Math.round(Math.sin(sim.t * 1.3 + p.x * 0.037 + p.y * 0.011) * sway);
      return {
        baseline: item.baseline,
        draw: (c) => {
          c.drawImage(tree.trunk.canvas, p.x, p.y);
          c.drawImage(tree.canopy.canvas, p.x + k, p.y);
        },
      };
    }
    if (p.kind === "scarecrowpost" && !sim.scarecrow) return null;
    const list = s.decor[p.kind as keyof ValleySprites["decor"]];
    if (!list) return null;
    const spr = list[p.variant % list.length];
    if (p.kind === "tallgrass" || p.kind === "reeds") {
      const k = Math.round(Math.sin(sim.t * 1.8 + p.x * 0.09) * sway * 0.8);
      return {
        baseline: item.baseline,
        draw: (c) => {
          // sway the top half only
          const half = Math.floor(spr.h / 2);
          c.drawImage(spr.canvas, 0, 0, spr.w, half, p.x + k, p.y, spr.w, half);
          c.drawImage(spr.canvas, 0, half, spr.w, spr.h - half, p.x, p.y + half, spr.w, spr.h - half);
        },
      };
    }
    if (p.kind === "hay") {
      return {
        baseline: item.baseline,
        draw: (c) => {
          const bales = clamp(sim.hayBales, 1, 4);
          for (let i = 0; i < bales; i++) {
            const col = i % 2;
            const row = Math.floor(i / 2);
            c.drawImage(s.hayBale.canvas, p.x + col * 13, p.y + 8 - row * 8);
          }
        },
      };
    }
    return { baseline: item.baseline, draw: (c) => c.drawImage(spr.canvas, p.x, p.y) };
  }

  private buildingDrawable(p: Placement, spr: BuildingSprite, sim: ValleySim, nf: number, baseline: number): Drawable {
    const key = this.map.buildings.find((b) => b.x === p.x && b.y === p.y)?.key ?? p.id;
    let lit = sim.serverOk;
    if (key.startsWith("house-")) {
      const c = sim.housesRanked[Number(key.slice(6))];
      lit = !!c && (c.isWarm || c.status === "active");
    } else if (key === "coop") lit = (sim.status?.sseTotal ?? 0) > 0;
    if (lit && nf > 0.25) {
      for (const w of spr.windows) this.litWindows.push({ x: p.x + w.x, y: p.y + w.y, w: w.w, h: w.h });
    }
    return {
      baseline,
      draw: (c) => {
        c.drawImage(spr.canvas, p.x, p.y);
        if (p.id === "silo") {
          const g = this.map.buildings.find((b) => b.id === "silo")!.spec.gauge!;
          const fill = Math.round(g.h * clamp(sim.siloFill, 0, 1));
          c.fillStyle = sim.siloFill > 0.85 ? "#d86a3a" : "#e2c050";
          if (fill > 0) c.fillRect(p.x + g.x, p.y + g.y + (g.h - fill), g.w, fill);
          c.fillStyle = "#f2dc80";
          if (fill > 1) c.fillRect(p.x + g.x, p.y + g.y + (g.h - fill), g.w, 1);
        } else if (p.id === "windmill") {
          const hub = this.map.buildings.find((b) => b.id === "windmill")!.spec.hub!;
          const n = this.s.sails.length;
          const turns = sim.t * (0.25 + sim.windmillSpeed * 1.4);
          const f = Math.floor(turns * n * 4) % n;
          const sails = this.s.sails[f];
          c.drawImage(sails.canvas, p.x + hub.x - sails.w / 2, p.y + hub.y - sails.h / 2);
          if (sim.windmillSpeed > 1.02) {
            c.fillStyle = "#ff5a3a";
            c.fillRect(p.x + hub.x - 1, p.y + hub.y - 1, 3, 3);
          }
        } else if (p.id === "fountain") {
          this.drawFountainSpray(c, p.x + 30, p.y + 5, sim.t);
        }
      },
    };
  }

  private drawFountainSpray(c: Ctx, x: number, y: number, t: number): void {
    // droplets arcing from the spout into the basin, plus ripples
    for (let i = 0; i < 14; i++) {
      const ph = (t * 0.9 + i / 14) % 1;
      const dir = i % 2 ? 1 : -1;
      const spread = 4 + (i % 4) * 3.2;
      const px = x + dir * spread * ph;
      const py = y - 5 + ph * ph * 30 - ph * 10;
      c.fillStyle = ph < 0.2 ? "#eefaff" : "#bfe6f5";
      c.fillRect(Math.round(px), Math.round(py), 1, ph < 0.5 ? 2 : 1);
    }
    c.fillStyle = "#d4eef8";
    const r = (t * 6) % 10;
    c.fillRect(Math.round(x - 10 - r), y + 21, 3, 1);
    c.fillRect(Math.round(x + 8 + r), y + 21, 3, 1);
  }

  // ---------------------------------------------------------------- main

  render(screen: Ctx, sim: ValleySim, input: RenderInput): void {
    this.sw = screen.canvas.width;
    this.sh = screen.canvas.height;
    this.u = input.ui;
    this.portrait = input.portrait;
    const nf = nightFactor(input.hour);
    this.litWindows.length = 0;

    const interior = sim.place !== "world" ? sim.interiors[sim.place] : undefined;
    if (interior) {
      this.renderInterior(screen, sim, input, interior);
      return;
    }

    // camera over the world
    const zoom = input.zoom;
    const srcW = Math.min(WORLD_W, Math.ceil(this.sw / zoom));
    const srcH = Math.min(WORLD_H, Math.ceil(this.sh / zoom));
    if (this.viewCanvas.width !== srcW || this.viewCanvas.height !== srcH) {
      this.viewCanvas.width = srcW;
      this.viewCanvas.height = srcH;
      this.vctx.imageSmoothingEnabled = false;
    }
    this.cam.x = clamp(Math.round(sim.player.x) - Math.floor(srcW / 2), 0, WORLD_W - srcW);
    this.cam.y = clamp(Math.round(sim.player.y - 10) - Math.floor(srcH / 2), 0, WORLD_H - srcH);
    this.viewRect = { x: this.cam.x, y: this.cam.y, w: srcW, h: srcH };
    const ctx = this.vctx;
    ctx.setTransform(1, 0, 0, 1, -this.cam.x, -this.cam.y);

    ctx.drawImage(this.terrain.ground, this.cam.x, this.cam.y, srcW, srcH, this.cam.x, this.cam.y, srcW, srcH);
    this.drawWater(ctx, sim);
    this.drawRainRipples(ctx, sim);

    // flat things on water/ground
    for (const it of this.flats) {
      if (!this.visible(it.bounds)) continue;
      const p = it.p;
      const list = this.s.decor[p.kind as keyof ValleySprites["decor"]];
      if (!list) continue;
      const spr = list[p.variant % list.length];
      const bob = p.kind === "boat" ? Math.round(Math.sin(sim.t * 1.4) * 0.8) : 0;
      ctx.drawImage(spr.canvas, p.x, p.y + bob);
    }
    for (const d of sim.ducks) {
      if (!this.visible({ x: d.x - 8, y: d.y - 8, w: 16, h: 12 })) continue;
      const moving = Math.hypot(d.tx - d.x, d.ty - d.y) > 1;
      const frames = d.facing === -1 ? this.s.duck : this.s.duckFlip;
      const spr = frames[Math.floor(sim.t * (moving ? 3 : 1.2) + d.x) % 2];
      ctx.drawImage(spr.canvas, Math.round(d.x - spr.w / 2), Math.round(d.y - spr.h + 4));
      if (moving) {
        ctx.fillStyle = "rgba(212,238,248,0.7)";
        ctx.fillRect(Math.round(d.x - d.facing * 8), Math.round(d.y + 2), 3, 1);
      }
    }
    for (const b of this.bridges) {
      if (!this.visible(b.rect)) continue;
      ctx.drawImage(b.deck.canvas, b.rect.x, b.rect.y);
      ctx.drawImage(b.backRail.canvas, b.rect.x, b.rect.y - 9);
    }
    for (let i = 0; i < sim.seedlingCount && i < this.map.seedbedPlots.length; i++) {
      const plot = this.map.seedbedPlots[i];
      ctx.drawImage(this.s.seedling.canvas, plot.x - 4, plot.y - 7);
    }

    const drawables: Drawable[] = [];
    const sway = sim.weather === "storm" ? 1.6 : sim.weather === "rain" ? 1.2 : 0.7;

    for (const b of this.bridges) {
      if (!this.visible(b.rect)) continue;
      drawables.push({ baseline: b.rect.y + b.rect.h, draw: (c) => c.drawImage(b.frontRail.canvas, b.rect.x, b.rect.y + b.rect.h - 10) });
    }

    const fs = this.s.fence;
    for (const f of this.map.fences) {
      if (!this.visible({ x: f.x - 2, y: f.y - 4, w: 24, h: 34 })) continue;
      const spr = f.kind === "h" ? fs.h : f.kind === "v" ? fs.v : fs.post;
      drawables.push({ baseline: f.y + 11, draw: (c) => c.drawImage(spr.canvas, f.x - 2, f.y - 3) });
    }

    for (const crop of sim.crops) {
      const plot = this.map.fieldPlots[crop.plot];
      if (!plot || !this.visible({ x: plot.x - 8, y: plot.y - 20, w: 16, h: 22 })) continue;
      const age = sim.t - crop.plantedAt;
      const stage = clamp(Math.floor((age / 90) * 4), 0, 3);
      const spr = this.s.crops[crop.color][stage];
      drawables.push({ baseline: plot.y, draw: (c) => c.drawImage(spr.canvas, Math.round(plot.x - spr.w / 2), Math.round(plot.y - spr.h + 3)) });
    }

    for (const it of this.statics) {
      if (!this.visible(it.bounds)) continue;
      const d = this.staticDrawable(it, sim, nf, sway);
      if (d) drawables.push(d);
    }

    for (let i = 0; i < sim.chickens.length; i++) {
      const ch = sim.chickens[i];
      if (!this.visible({ x: ch.x - 8, y: ch.y - 14, w: 16, h: 16 })) continue;
      const frame = ch.state === "peck" ? 2 : ch.state === "walk" ? Math.floor(sim.t * 6) % 2 : 0;
      const brown = i % 3 === 2;
      const set = brown ? (ch.facing === -1 ? this.s.chickenBrown : this.s.chickenBrownFlip) : ch.facing === -1 ? this.s.chicken : this.s.chickenFlip;
      const spr = set[frame];
      drawables.push({
        baseline: ch.y + 2,
        draw: (c) => {
          c.fillStyle = "rgba(20,24,16,0.25)";
          c.fillRect(Math.round(ch.x - 4), Math.round(ch.y + 1), 8, 2);
          c.drawImage(spr.canvas, Math.round(ch.x - spr.w / 2), Math.round(ch.y - spr.h + 4));
        },
      });
    }

    for (const n of sim.npcs) {
      if (!this.visible({ x: n.x - 10, y: n.y - 28, w: 20, h: 30 })) continue;
      drawables.push(this.npcDrawable(n, sim));
    }
    drawables.push(this.playerDrawable(sim.player, sim));

    drawables.sort((a, b) => a.baseline - b.baseline);
    for (const d of drawables) d.draw(ctx);

    this.drawParticles(ctx, sim);
    for (const f of sim.flyers) {
      const frame = Math.floor(f.phase) % 2;
      const spr = f.kind === "butterfly" ? this.s.butterfly[frame] : this.s.bird[frame];
      ctx.drawImage(spr.canvas, Math.round(f.x), Math.round(f.y));
    }
    this.drawClouds(ctx, sim);
    this.drawLighting(ctx, sim, nf, input.hour);
    this.drawWorldWeather(ctx, sim);
    this.drawBubbles(ctx, sim);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    screen.imageSmoothingEnabled = false;
    screen.fillStyle = "#08080f";
    screen.fillRect(0, 0, this.sw, this.sh);
    const ox = Math.round((this.sw - srcW * zoom) / 2);
    const oy = Math.round((this.sh - srcH * zoom) / 2);
    screen.drawImage(this.viewCanvas, 0, 0, srcW, srcH, Math.max(0, ox), Math.max(0, oy), srcW * zoom, srcH * zoom);
    this.view = { k: zoom, ox: Math.max(0, ox) - this.cam.x * zoom, oy: Math.max(0, oy) - this.cam.y * zoom };

    this.drawHudLayer(screen, sim, input, null);
  }

  private renderInterior(screen: Ctx, sim: ValleySim, input: RenderInput, interior: Interior): void {
    const ctx = this.rctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#050508";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    interior.drawBase(ctx, sim, this.s, input.hour);
    const ds: Drawable[] = interior.drawables(sim, this.s);
    ds.push(this.playerDrawable(sim.player, sim));
    ds.sort((a, b) => a.baseline - b.baseline);
    for (const d of ds) d.draw(ctx);
    for (const p of sim.particles) {
      if (p.kind !== "ping") continue;
      const lifeT = p.age / p.life;
      const r = 2 + lifeT * 6;
      ctx.strokeStyle = `rgba(255,246,200,${(0.9 * (1 - lifeT)).toFixed(3)})`;
      ctx.strokeRect(Math.round(p.x - r), Math.round(p.y - r * 0.6), Math.round(r * 2), Math.round(r * 1.2));
    }
    interior.drawOverlay(ctx, sim, this.s, input.hour);

    const zoom = input.zoom;
    const srcW = Math.min(VIEW_W, Math.ceil(this.sw / zoom));
    const srcH = Math.min(VIEW_H, Math.ceil(this.sh / zoom));
    const f = interior.floor;
    this.cam.x =
      f.w + 24 > srcW
        ? clamp(Math.round(sim.player.x) - srcW / 2, f.x - 12, f.x + f.w + 12 - srcW)
        : Math.round(f.x + f.w / 2) - srcW / 2;
    this.cam.y = clamp(Math.round(f.y + (f.h - WALL_H) / 2) - Math.floor(srcH / 2), 0, VIEW_H - srcH);
    screen.imageSmoothingEnabled = false;
    screen.fillStyle = "#050508";
    screen.fillRect(0, 0, this.sw, this.sh);
    const ox = Math.max(0, Math.round((this.sw - srcW * zoom) / 2));
    const oy = Math.max(0, Math.round((this.sh - srcH * zoom) / 2));
    screen.drawImage(this.room, this.cam.x, this.cam.y, srcW, srcH, ox, oy, srcW * zoom, srcH * zoom);
    this.view = { k: zoom, ox: ox - this.cam.x * zoom, oy: oy - this.cam.y * zoom };
    this.drawHudLayer(screen, sim, input, interior);
  }

  private drawHudLayer(screen: Ctx, sim: ValleySim, input: RenderInput, interior: Interior | null): void {
    const { sw, sh } = this;
    this.drawHud(screen, sim, input);
    if (interior) {
      const u = this.u;
      const ly = this.portrait ? 6 * u + 30 * u + 6 * u : 9 * u;
      drawText(screen, interior.label, Math.round(sw / 2), ly, C.uiDim, { align: "center", scale: u, shadow: "#000000" });
    }
    if (input.hover && !input.dialog && !input.mapOpen) this.drawHoverLabel(screen, input);
    if (input.dialog && !input.mapOpen) this.drawDialog(screen, input.dialog);
    if (input.mapOpen) this.drawMap(screen, sim);
    if (sim.connectionLost) this.drawConnectionLost(screen, sim);
    screen.imageSmoothingEnabled = true;
    screen.drawImage(this.vignette, 0, 0, sw, sh);
    screen.imageSmoothingEnabled = false;
    const fade = sim.transitionAlpha();
    if (fade > 0.01) {
      screen.globalAlpha = Math.min(1, fade);
      screen.fillStyle = "#000000";
      screen.fillRect(0, 0, sw, sh);
      screen.globalAlpha = 1;
    }
  }

  // inverse of the latest world -> screen blit, for pointer input
  toWorld(pt: { x: number; y: number }): { x: number; y: number } {
    return { x: (pt.x - this.view.ox) / this.view.k, y: (pt.y - this.view.oy) / this.view.k };
  }

  uiButtons(): { sound: Rect; zoom: Rect; map: Rect } {
    const { sw, u } = this;
    const m = 6 * u;
    if (!this.portrait) {
      return {
        sound: { x: sw - 164 * u, y: m, w: 20 * u, h: 15 * u },
        map: { x: sw - 140 * u, y: m, w: 30 * u, h: 15 * u },
        zoom: { x: sw - 106 * u, y: m, w: 34 * u, h: 15 * u },
      };
    }
    // portrait: the HUD board fills the top edge, so the buttons sit bottom right
    const y = this.sh - m - 15 * u;
    return {
      sound: { x: sw - 94 * u - m, y, w: 20 * u, h: 15 * u },
      map: { x: sw - 70 * u - m, y, w: 30 * u, h: 15 * u },
      zoom: { x: sw - 36 * u - m, y, w: 36 * u, h: 15 * u },
    };
  }

  // ---------------------------------------------------------------- map

  private snapshot: HTMLCanvasElement | null = null;

  // the whole world drawn once, statically, for the map screen
  private worldSnapshot(sim: ValleySim): HTMLCanvasElement {
    if (this.snapshot) return this.snapshot;
    const c = createCanvas(WORLD_W, WORLD_H);
    const ctx = ctx2d(c);
    const saved = this.viewRect;
    this.viewRect = { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
    ctx.drawImage(this.terrain.ground, 0, 0);
    this.drawLayer(ctx, this.terrain.pond, this.terrain.pond.shimmer[0]);
    this.drawLayer(ctx, this.terrain.river, this.terrain.river.shimmer[0]);
    for (const b of this.bridges) {
      ctx.drawImage(b.deck.canvas, b.rect.x, b.rect.y);
      ctx.drawImage(b.frontRail.canvas, b.rect.x, b.rect.y + b.rect.h - 10);
    }
    for (const it of this.flats) {
      const list = this.s.decor[it.p.kind as keyof ValleySprites["decor"]];
      if (list) ctx.drawImage(list[it.p.variant % list.length].canvas, it.p.x, it.p.y);
    }
    const ds: Drawable[] = [];
    for (const f of this.map.fences) {
      const spr = f.kind === "h" ? this.s.fence.h : f.kind === "v" ? this.s.fence.v : this.s.fence.post;
      ds.push({ baseline: f.y + 11, draw: (cc) => cc.drawImage(spr.canvas, f.x - 2, f.y - 3) });
    }
    for (const it of this.statics) {
      const d = this.staticDrawable(it, sim, 0, 0);
      if (d) ds.push(d);
    }
    ds.sort((a, b) => a.baseline - b.baseline);
    for (const d of ds) d.draw(ctx);
    this.litWindows.length = 0;
    this.viewRect = saved;
    this.snapshot = c;
    return c;
  }

  private mapLayout(): { x: number; y: number; w: number; h: number; k: number } {
    const { sw, sh, u } = this;
    const k = Math.min((sw - 28 * u) / WORLD_W, (sh - 56 * u) / WORLD_H);
    const w = Math.round(WORLD_W * k);
    const h = Math.round(WORLD_H * k);
    return { x: Math.round((sw - w) / 2), y: Math.round((sh - h) / 2 + 8 * u), w, h, k };
  }

  // screen point on the open map -> world point, or null outside it
  mapToWorld(pt: { x: number; y: number }): { x: number; y: number } | null {
    const m = this.mapLayout();
    if (pt.x < m.x || pt.y < m.y || pt.x > m.x + m.w || pt.y > m.y + m.h) return null;
    return { x: (pt.x - m.x) / m.k, y: (pt.y - m.y) / m.k };
  }

  private drawMap(ctx: Ctx, sim: ValleySim): void {
    const { u, sw } = this;
    const m = this.mapLayout();
    ctx.fillStyle = "rgba(6,5,10,0.72)";
    ctx.fillRect(0, 0, this.sw, this.sh);
    const pad = 5 * u;
    this.woodPanel(ctx, m.x - pad, m.y - pad, m.w + pad * 2, m.h + pad * 2);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.worldSnapshot(sim), m.x, m.y, m.w, m.h);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(m.x, m.y, m.w, m.h);

    const at = (wx: number, wy: number) => ({ x: Math.round(m.x + wx * m.k), y: Math.round(m.y + wy * m.k) });
    const label = (text: string, wx: number, wy: number, color: string = C.uiText, scale = u) => {
      const p = at(wx, wy);
      const w = textWidth(text, scale) + 4 * scale;
      ctx.fillStyle = "rgba(21,18,33,0.78)";
      ctx.fillRect(Math.round(p.x - w / 2), p.y - 2 * scale, w, 11 * scale);
      drawText(ctx, text, p.x, p.y, color, { align: "center", scale });
    };
    const small = Math.max(1, u - 1);
    const named: Record<string, string> = {
      farmhouse: "FARMHOUSE",
      barn: "BARN",
      coop: "COOP",
      windmill: "WINDMILL",
      greenhouse: "GREENHOUSE",
      store: "STORE",
      fountain: "PLAZA",
    };
    for (const b of this.map.buildings) {
      const cx = b.x + b.spec.w / 2;
      const cy = b.y + b.spec.base * 0.4;
      if (named[b.key]) label(named[b.key], cx, cy);
      else if (b.key.startsWith("house-")) {
        const c = sim.housesRanked[Number(b.key.slice(6))];
        if (c) label(c.country, cx, cy, c.isWarm || c.status === "active" ? C.uiYellow : C.uiDim, small);
      }
    }
    const fr = this.map.fieldRect;
    label("FIELD", fr.x + fr.w / 2, fr.y + fr.h / 2);
    const pr = this.map.pondRect;
    label("POND", pr.x + pr.w / 2, pr.y + pr.h / 2 - 6);
    label("RIVER", this.map.riverCenter(480), 480, C.uiBlue, small);

    // people: villagers, farmhands, you
    for (const n of sim.npcs) {
      const p = at(n.x, n.y);
      ctx.fillStyle = "#1a0f08";
      ctx.fillRect(p.x - u - 1, p.y - u - 1, 2 * u + 2, 2 * u + 2);
      ctx.fillStyle = n.kind === "farmer" ? C.uiGreen : C.uiPink;
      ctx.fillRect(p.x - u, p.y - u, 2 * u, 2 * u);
    }
    let me = { x: sim.player.x, y: sim.player.y };
    if (sim.place !== "world") {
      const d = sim.doors.find((dd) => dd.id === sim.place);
      if (d) me = d.outside;
    }
    const p = at(me.x, me.y);
    const pulse = Math.floor(sim.t * 3) % 2 === 0;
    const r = (pulse ? 4 : 3) * u;
    ctx.fillStyle = "#1a0f08";
    ctx.fillRect(p.x - r - u, p.y - r - u, (r + u) * 2, (r + u) * 2);
    ctx.fillStyle = "#f4f0e6";
    ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    ctx.fillStyle = C.uiRed;
    ctx.fillRect(p.x - r + u, p.y - r + u, (r - u) * 2, (r - u) * 2);

    drawText(ctx, "MAP", sw / 2, m.y - pad - 12 * u, C.uiYellow, { align: "center", scale: u, shadow: "#000000" });
    drawText(
      ctx,
      sim.place === "world" ? "CLICK A SPOT TO WALK THERE · M TO CLOSE" : "M TO CLOSE",
      sw / 2,
      m.y + m.h + pad + 4 * u,
      C.uiDim,
      { align: "center", scale: small, shadow: "#000000" },
    );
  }

  // wrap width for dialog text, in unscaled font pixels
  dialogTextWidth(): number {
    const u = this.u;
    const margin = this.portrait ? 8 * u : 24 * u;
    const inner = this.sw - margin * 2 - (8 + 52 + 10 + 16) * u;
    return Math.max(80, Math.floor(inner / u));
  }

  private drawRainRipples(ctx: Ctx, sim: ValleySim): void {
    if ((sim.weather !== "rain" && sim.weather !== "storm") || sim.weatherBlend < 0.4) return;
    const v = this.viewRect;
    ctx.fillStyle = "rgba(220,240,250,0.7)";
    const n = sim.weather === "storm" ? 60 : 36;
    for (let i = 0; i < n; i++) {
      const seed = i * 7919;
      const cycle = Math.floor(sim.t * 2 + i * 0.37);
      const x = Math.floor(v.x + (((seed + cycle * 131) * 2654435761) >>> 0) % v.w);
      const y = Math.floor(v.y + (((seed * 3 + cycle * 17) * 2246822519) >>> 0) % v.h);
      const water = this.map.water[y * WORLD_W + x];
      const ph = (sim.t * 2 + i * 0.37) % 1;
      const r = Math.round(1 + ph * 3);
      if (water) {
        ctx.fillRect(x - r, y, 1, 1);
        ctx.fillRect(x + r, y, 1, 1);
        ctx.fillRect(x, y - Math.ceil(r / 2), 1, 1);
        ctx.fillRect(x, y + Math.ceil(r / 2), 1, 1);
      } else if (ph < 0.3) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  private drawParticles(ctx: Ctx, sim: ValleySim): void {
    for (const p of sim.particles) {
      const lifeT = p.age / p.life;
      if (p.kind === "smoke") {
        const r = Math.round(1.5 + p.size + lifeT * 3);
        ctx.fillStyle = `rgba(214,208,198,${(0.55 * (1 - lifeT)).toFixed(3)})`;
        ctx.fillRect(Math.round(p.x - r / 2), Math.round(p.y - r / 2), r, r);
      } else if (p.kind === "splash") {
        const r = 2 + lifeT * 7;
        ctx.strokeStyle = `rgba(207,232,250,${(0.8 * (1 - lifeT)).toFixed(3)})`;
        ctx.strokeRect(Math.round(p.x - r) + 0.5, Math.round(p.y - r / 2) + 0.5, Math.round(r * 2), Math.round(r));
      } else if (p.kind === "ping") {
        const r = 2 + lifeT * 6;
        ctx.strokeStyle = `rgba(255,246,200,${(0.9 * (1 - lifeT)).toFixed(3)})`;
        ctx.strokeRect(Math.round(p.x - r) + 0.5, Math.round(p.y - r * 0.6) + 0.5, Math.round(r * 2), Math.round(r * 1.2));
      } else if (p.kind === "zzz") {
        drawText(ctx, "Z", p.x, p.y, `rgba(220,226,255,${(1 - lifeT).toFixed(3)})`);
      } else if (p.kind === "firefly") {
        // drawn in the lighting pass
      } else if (p.kind === "leaf") {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 1 - lifeT * 0.7;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 1);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 1 - lifeT;
        const sz = p.kind === "sparkle" && lifeT < 0.4 ? 2 : 1;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), sz, sz);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawClouds(ctx: Ctx, sim: ValleySim): void {
    const blend = sim.weatherBlend;
    const base = sim.weather === "sunny" ? 0.06 : 0.2 * blend;
    if (base <= 0.01) return;
    ctx.globalAlpha = base;
    for (let i = 0; i < 6; i++) {
      const spr = this.s.clouds[i % this.s.clouds.length];
      const span = WORLD_W + 400;
      const cx = ((sim.t * (5 + (i % 3) * 2.4) + i * 331) % span) - 200;
      const cy = 40 + ((i * 157) % (WORLD_H - 100));
      if (!this.visible({ x: cx, y: cy, w: spr.w, h: spr.h })) continue;
      ctx.drawImage(spr.canvas, Math.round(cx), cy);
    }
    ctx.globalAlpha = 1;
  }

  // rain streaks and storm dimming in world pixels, so they scale with the art
  private drawWorldWeather(ctx: Ctx, sim: ValleySim): void {
    const blend = sim.weatherBlend;
    if (blend <= 0.01) return;
    const w = sim.weather;
    const v = this.viewRect;
    if (w === "rain" || w === "storm") {
      const count = Math.round(((w === "storm" ? 150 : 80) * (v.w * v.h)) / (400 * 225));
      ctx.fillStyle = `rgba(190,215,245,${(0.55 * blend).toFixed(3)})`;
      for (let i = 0; i < count; i++) {
        const seed = i * 137.5;
        const x = v.x + ((((seed * 7.13 + sim.t * 90) % (v.w + 20)) + v.w + 20) % (v.w + 20)) - 10;
        const y = v.y + ((seed * 3.77 + sim.t * 190) % v.h);
        const rx = Math.round(x);
        const ry = Math.round(y);
        ctx.fillRect(rx, ry, 1, 2);
        ctx.fillRect(rx - 1, ry + 2, 1, 2);
      }
    }
    if (w === "storm") {
      ctx.fillStyle = `rgba(16,18,34,${(0.22 * blend).toFixed(3)})`;
      ctx.fillRect(v.x, v.y, v.w, v.h);
      if (sim.t < this.lightningUntil) {
        ctx.fillStyle = "rgba(240,244,255,0.16)";
        ctx.fillRect(v.x, v.y, v.w, v.h);
      }
    }
  }

  private drawLighting(ctx: Ctx, sim: ValleySim, nf: number, hour: number): void {
    const v = this.viewRect;
    const tint = skyTint(hour);
    if (tint.a > 0.01) {
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = tint.a;
      ctx.fillStyle = tint.color;
      ctx.fillRect(v.x, v.y, v.w, v.h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    if (nf > 0.2) {
      ctx.globalCompositeOperation = "lighter";
      const glow = (x: number, y: number, r: number, color: string, a: number) => {
        if (x + r < v.x || x - r > v.x + v.w || y + r < v.y || y - r > v.y + v.h) return;
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, color);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = a * nf;
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      };
      for (const it of this.statics) {
        if (it.p.kind === "lamp") glow(it.p.x + 5, it.p.y + 5, 30, "rgba(255,214,120,0.55)", 0.85);
      }
      for (const w of this.litWindows) {
        ctx.globalAlpha = 0.85 * nf;
        ctx.fillStyle = C.windowNight;
        ctx.fillRect(w.x, w.y, w.w, w.h);
        glow(w.x + w.w / 2, w.y + w.h / 2, 15, "rgba(255,214,120,0.5)", 0.7);
      }
      for (const p of sim.particles) {
        if (p.kind === "firefly") {
          const pulse = 0.4 + 0.6 * Math.abs(Math.sin(p.age * 3));
          glow(p.x, p.y, 7, "rgba(255,233,138,0.9)", pulse);
          ctx.globalAlpha = pulse * nf;
          ctx.fillStyle = "#ffe98a";
          ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  private drawBubbles(ctx: Ctx, sim: ValleySim): void {
    for (const n of sim.npcs) {
      if (!n.bubble) continue;
      const text = n.bubble.text;
      const w = textWidth(text) + 8;
      const x = Math.round(clamp(n.x - w / 2, 2, WORLD_W - w - 2));
      const y = Math.round(n.y - 44);
      ctx.fillStyle = "#f4f0e6";
      ctx.fillRect(x, y, w, 13);
      ctx.fillStyle = "#2b2118";
      ctx.fillRect(x + 1, y + 1, w - 2, 11);
      ctx.fillStyle = "#f4f0e6";
      ctx.fillRect(x + 2, y + 2, w - 4, 9);
      ctx.fillRect(Math.round(n.x) - 1, y + 13, 2, 2);
      ctx.fillRect(Math.round(n.x), y + 15, 1, 1);
      drawText(ctx, text, x + 4, y + 3, "#2b2118");
    }
  }

  private drawHud(ctx: Ctx, sim: ValleySim, input: RenderInput): void {
    const s = sim.status;
    const { sw, u } = this;
    const queue = s ? String(s.queueDepth) : "...";
    const api = s?.rate ? `${s.rate.usedLastMinute}/${s.rate.targetPerMinute}` : "...";
    const sse = s ? String(s.sseTotal) : "...";
    const vis = sim.visitors?.available ? String(sim.visitors.activeVisitors) : "-";
    const line1 = `QUEUE ${queue}  API ${api}`;
    const line2 = `SSE ${sse}  VISITORS ${vis}`;
    const m = 6 * u;

    // wooden board
    const bw = Math.max(textWidth(line1, u), textWidth(line2, u)) + 14 * u;
    const bh = 30 * u;
    const bx = m;
    const by = m;
    this.woodPanel(ctx, bx, by, bw, bh);
    drawText(ctx, line1, bx + 7 * u, by + 6 * u, C.uiText, { scale: u, shadow: "#1a0f08" });
    drawText(ctx, line2, bx + 7 * u, by + 17 * u, "#e8d8b8", { scale: u, shadow: "#1a0f08" });

    // clock + weather
    const hour = input.hour;
    const hh = Math.floor(hour);
    const mm = Math.floor((hour - hh) * 60);
    const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const icon =
      nightFactor(hour) > 0.5
        ? this.s.icons.moon
        : sim.weather === "sunny"
          ? this.s.icons.sun
          : sim.weather === "overcast"
            ? this.s.icons.cloud
            : sim.weather === "rain"
              ? this.s.icons.rain
              : this.s.icons.storm;
    const cw = textWidth(clock, u) + 18 * u;
    const cbx = sw - cw - m;
    this.woodPanel(ctx, cbx, m, cw, 15 * u);
    ctx.drawImage(icon.canvas, cbx + 4 * u, m + 3 * u, 9 * u, 9 * u);
    drawText(ctx, clock, cbx + 15 * u, m + 4 * u, C.uiText, { scale: u, shadow: "#1a0f08" });

    const button = (r: Rect, label: string, active: boolean) => {
      this.woodPanel(ctx, r.x, r.y, r.w, r.h, !active);
      drawText(ctx, label, r.x + r.w / 2, r.y + (r.h - FONT_H * u) / 2, active ? C.uiText : C.uiDim, {
        align: "center",
        scale: u,
        shadow: "#1a0f08",
      });
    };
    const btns = this.uiButtons();
    const soundOn = input.audioUnlocked && !input.muted;
    button(btns.sound, "♪", soundOn);
    if (!soundOn) {
      ctx.fillStyle = C.uiRed;
      ctx.fillRect(btns.sound.x + 4 * u, btns.sound.y + btns.sound.h - 4 * u, btns.sound.w - 8 * u, u);
    }
    button(btns.map, "MAP", true);
    button(btns.zoom, input.wide ? "ZOOM" : "WIDE", true);

    let chipY = by + bh + 5 * u;
    const chip = (text: string, color: string) => {
      const w = textWidth(text, u) + 9 * u;
      ctx.fillStyle = "rgba(21,18,33,0.88)";
      ctx.fillRect(bx, chipY, w, 12 * u);
      ctx.fillStyle = color;
      ctx.fillRect(bx, chipY, 2 * u, 12 * u);
      drawText(ctx, text, bx + 5 * u, chipY + 3 * u, color, { scale: u });
      chipY += 15 * u;
    };
    if (sim.connectionLost) chip("MONITOR OFFLINE", C.uiRed);
    else if (s) {
      if (!s.ok || !s.db) chip("SERVER NOT OK", C.uiRed);
      if (sim.riverState === "dry") chip("SCORE POLLER SILENT", C.uiRed);
      else if (sim.riverState === "stale") chip("SCORES STALLED", C.uiYellow);
      if (s.shedding) chip("QUEUE SHEDDING", C.uiYellow);
      if (s.workerPaused) chip("WORKERS PAUSED", C.uiYellow);
      if (s.storage?.overLimit) chip("STORAGE OVER LIMIT", C.uiRed);
    } else {
      chip("WAKING UP...", C.uiDim);
    }
  }

  // framed wooden plank panel for HUD pieces
  private woodPanel(ctx: Ctx, x: number, y: number, w: number, h: number, dim = false): void {
    const u = this.u;
    ctx.fillStyle = "#2a1a10";
    ctx.fillRect(x - u, y - u, w + 2 * u, h + 2 * u);
    ctx.fillStyle = dim ? "#5a3a24" : "#8a5a33";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = dim ? "#6a4630" : "#b07a46";
    ctx.fillRect(x, y, w, u);
    ctx.fillStyle = "#5a3920";
    ctx.fillRect(x, y + h - u, w, u);
    ctx.fillStyle = "rgba(30,18,10,0.5)";
    ctx.fillRect(x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u);
  }

  private drawHoverLabel(ctx: Ctx, input: RenderInput): void {
    if (!input.hover || !input.mouse) return;
    const { sw, sh, u } = this;
    const text = input.hover.label;
    const w = textWidth(text, u) + 8 * u;
    const x = Math.round(clamp(input.mouse.x + 8 * u, 2, sw - w - 2));
    const y = Math.round(clamp(input.mouse.y - 14 * u, 2, sh - 14 * u));
    ctx.fillStyle = "rgba(21,18,33,0.9)";
    ctx.fillRect(x, y, w, 12 * u);
    ctx.fillStyle = C.uiYellow;
    ctx.fillRect(x, y, u, 12 * u);
    drawText(ctx, text, x + 4 * u, y + 3 * u, C.uiText, { scale: u });
  }

  private drawDialog(ctx: Ctx, dialog: DialogState): void {
    const { sw, sh, u } = this;
    const margin = this.portrait ? 8 * u : 24 * u;
    const lineH = (FONT_H + 4) * u;
    const textH = 8 * u + (FONT_H + 6) * u + dialog.lines.length * lineH + 10 * u;
    const h = Math.max(70 * u, textH);
    const x = margin;
    const y = sh - h - 10 * u;
    const w = sw - margin * 2;
    ctx.fillStyle = "rgba(8,8,16,0.94)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.uiBorder;
    ctx.fillRect(x - 2 * u, y - 2 * u, w + 4 * u, 2 * u);
    ctx.fillRect(x - 2 * u, y + h, w + 4 * u, 2 * u);
    ctx.fillRect(x - 2 * u, y, 2 * u, h);
    ctx.fillRect(x + w, y, 2 * u, h);

    let textX = x + 10 * u;
    if (dialog.portrait) {
      const box = 52 * u;
      const pad = 8 * u;
      const top = Math.round(y + (h - box) / 2);
      ctx.fillStyle = "rgba(21,18,33,1)";
      ctx.fillRect(x + pad, top, box, box);
      ctx.fillStyle = C.uiDim;
      ctx.fillRect(x + pad, top, box, u);
      ctx.fillRect(x + pad, top + box - u, box, u);
      ctx.fillRect(x + pad, top, u, box);
      ctx.fillRect(x + pad + box - u, top, u, box);
      const p = dialog.portrait;
      const fit = Math.min((box - 8 * u) / p.w, (box - 8 * u) / p.h);
      const scale = fit >= 1 ? Math.floor(fit) : fit;
      const pw = Math.max(1, Math.round(p.w * scale));
      const ph = Math.max(1, Math.round(p.h * scale));
      ctx.drawImage(p.canvas, Math.round(x + pad + (box - pw) / 2), Math.round(top + (box - ph) / 2), pw, ph);
      textX = x + pad + box + 10 * u;
    }

    drawText(ctx, dialog.title, textX, y + 8 * u, dialog.accent, { scale: u });
    let shown = dialog.revealed;
    let lineY = y + 8 * u + (FONT_H + 6) * u;
    for (const line of dialog.lines) {
      if (shown <= 0) break;
      const part = line.slice(0, Math.max(0, Math.floor(shown)));
      drawText(ctx, part, textX, lineY, C.uiText, { scale: u });
      shown -= line.length;
      lineY += lineH;
    }
    const total = dialog.lines.reduce((a, l) => a + l.length, 0);
    if (dialog.revealed >= total && Math.floor(Date.now() / 400) % 2 === 0) {
      drawText(ctx, "↓", x + w - 14 * u, y + h - 14 * u, C.uiYellow, { scale: u });
    }
  }

  private drawConnectionLost(ctx: Ctx, sim: ValleySim): void {
    const text = "THE VALLEY CANNOT REACH THE FARM...";
    const { sw } = this;
    const scl = textWidth(text, this.u) + 20 * this.u <= sw ? this.u : Math.max(1, this.u - 1);
    const w = textWidth(text, scl) + 20 * scl;
    const bh = 20 * scl;
    const x = (sw - w) / 2;
    const y = 60 * this.u;
    ctx.fillStyle = "rgba(8,8,16,0.9)";
    ctx.fillRect(x, y, w, bh);
    ctx.fillStyle = C.uiRed;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + bh - 1, w, 1);
    const blink = Math.floor(sim.t * 2) % 2 === 0;
    drawText(ctx, text, sw / 2, y + (bh - FONT_H * scl) / 2, blink ? C.uiRed : C.uiDim, { align: "center", scale: scl });
  }
}
