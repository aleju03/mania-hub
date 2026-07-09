// Frame renderer: pre-rendered ground, animated water, y-sorted entities,
// weather, day/night lighting and the Deltarune-style dialog UI. Pure
// canvas-2d + bitmap font, so it also runs under the offline harness.

import { C, clamp, createCanvas, ctx2d, lerp, mulberry32, TILE, MAP_W, MAP_H, VIEW_W, VIEW_H, type Ctx, type Sprite } from "./core";
import { drawText, textWidth, FONT_H } from "./font";
import { T, tileAt, type ValleyMap, type Placement } from "./map";
import type { Interior } from "./interiors";
import type { ValleySim, Npc, Player } from "./sim";
import type { Rect, ValleySprites, BuildingSprite, CharacterSprites } from "./sprites";

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
  zoom: number; // 1 = whole map, 2 = follow the player
  muted: boolean;
  audioUnlocked: boolean;
  mouse: { x: number; y: number } | null; // screen space (canvas px)
  hover: { id: string; label: string } | null;
  dialog: DialogState | null;
}

interface Drawable {
  baseline: number;
  draw: (ctx: Ctx) => void;
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

export class ValleyRenderer {
  private map: ValleyMap;
  private s: ValleySprites;
  private ground: HTMLCanvasElement;
  private vignette: HTMLCanvasElement;
  private world: HTMLCanvasElement;
  private wctx: Ctx;
  private lightningUntil = 0;
  private litWindows: Array<{ x: number; y: number; w: number; h: number }> = [];
  readonly cam = { x: 0, y: 0 };
  // screen canvas dims + UI scale, refreshed every frame (mobile portrait
  // uses a narrower internal canvas with doubled UI text)
  private sw = VIEW_W;
  private sh = VIEW_H;
  private u = 1;
  // world -> screen mapping of the latest blit, for input inversion
  private view = { k: 2, ox: 0, oy: 0 };

  constructor(map: ValleyMap, sprites: ValleySprites) {
    this.map = map;
    this.s = sprites;
    this.ground = this.renderGround();
    this.vignette = this.renderVignette();
    this.world = createCanvas(VIEW_W, VIEW_H);
    this.wctx = ctx2d(this.world);
  }

  flashLightning(simT: number): void {
    this.lightningUntil = simT + 0.18;
  }

  // ---------------------------------------------------------------- ground

  private renderGround(): HTMLCanvasElement {
    const canvas = createCanvas(VIEW_W, VIEW_H);
    const ctx = ctx2d(canvas);
    const rng = mulberry32(4242);
    const { terrain } = this.map;

    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const t = tileAt(terrain, tx, ty);
        const x = tx * TILE;
        const y = ty * TILE;
        if (t === T.GRASS) {
          ctx.fillStyle = (tx + ty) % 2 === 0 ? C.grass : "#4d9847";
          ctx.fillRect(x, y, TILE, TILE);
          for (let i = 0; i < 3; i++) {
            const sx = x + Math.floor(rng() * TILE);
            const sy = y + Math.floor(rng() * TILE);
            ctx.fillStyle = rng() < 0.5 ? C.grassDark : C.grassLight;
            ctx.fillRect(sx, sy, 1, 1);
          }
          if (rng() < 0.14) {
            const sx = x + Math.floor(rng() * 12);
            const sy = y + Math.floor(rng() * 12);
            ctx.fillStyle = C.grassDarker;
            ctx.fillRect(sx, sy, 2, 1);
            ctx.fillRect(sx, sy - 1, 1, 1);
          }
        } else if (t === T.PATH) {
          ctx.fillStyle = C.path;
          ctx.fillRect(x, y, TILE, TILE);
          for (let i = 0; i < 3; i++) {
            ctx.fillStyle = rng() < 0.5 ? C.pathDark : "#d4af78";
            ctx.fillRect(x + Math.floor(rng() * TILE), y + Math.floor(rng() * TILE), 1, 1);
          }
          if (rng() < 0.3) {
            ctx.fillStyle = "#a3805280";
            ctx.fillRect(x + Math.floor(rng() * 12), y + Math.floor(rng() * 12), 2, 2);
          }
          // soft edges where path meets grass
          if (tileAt(terrain, tx, ty - 1) === T.GRASS) {
            ctx.fillStyle = C.pathEdge;
            ctx.fillRect(x, y, TILE, 1);
          }
          if (tileAt(terrain, tx, ty + 1) === T.GRASS) {
            ctx.fillStyle = C.pathEdge;
            ctx.fillRect(x, y + TILE - 1, TILE, 1);
          }
          if (tileAt(terrain, tx - 1, ty) === T.GRASS) {
            ctx.fillStyle = C.pathEdge;
            ctx.fillRect(x, y, 1, TILE);
          }
          if (tileAt(terrain, tx + 1, ty) === T.GRASS) {
            ctx.fillStyle = C.pathEdge;
            ctx.fillRect(x + TILE - 1, y, 1, TILE);
          }
        } else if (t === T.SOIL) {
          ctx.fillStyle = C.soil;
          ctx.fillRect(x, y, TILE, TILE);
          // furrows
          ctx.fillStyle = C.soilDark;
          ctx.fillRect(x, y + 5, TILE, 2);
          ctx.fillRect(x, y + 13, TILE, 2);
          ctx.fillStyle = C.soilRow;
          ctx.fillRect(x, y + 1, TILE, 1);
          ctx.fillRect(x, y + 9, TILE, 1);
          for (let i = 0; i < 2; i++) {
            ctx.fillStyle = rng() < 0.5 ? C.soilDark : C.soilRow;
            ctx.fillRect(x + Math.floor(rng() * TILE), y + Math.floor(rng() * TILE), 1, 1);
          }
        } else {
          // water/bridge tiles get a dark bed; live water drawn per frame
          ctx.fillStyle = "#2b4a80";
          ctx.fillRect(x, y, TILE, TILE);
        }
      }
    }

    // banks where grass touches water
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const t = tileAt(terrain, tx, ty);
        if (t === T.WATER || t === T.BRIDGE) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        ctx.fillStyle = C.bank;
        if (tileAt(terrain, tx + 1, ty) === T.WATER) ctx.fillRect(x + TILE - 2, y, 2, TILE);
        if (tileAt(terrain, tx - 1, ty) === T.WATER) ctx.fillRect(x, y, 2, TILE);
        if (tileAt(terrain, tx, ty + 1) === T.WATER) ctx.fillRect(x, y + TILE - 2, TILE, 2);
        if (tileAt(terrain, tx, ty - 1) === T.WATER) ctx.fillRect(x, y, TILE, 2);
      }
    }
    return canvas;
  }

  private renderVignette(): HTMLCanvasElement {
    const canvas = createCanvas(VIEW_W, VIEW_H);
    const ctx = ctx2d(canvas);
    const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.55, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.95);
    g.addColorStop(0, "rgba(10,8,20,0)");
    g.addColorStop(1, "rgba(10,8,20,0.28)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    return canvas;
  }

  // ---------------------------------------------------------------- water

  private drawWater(ctx: Ctx, sim: ValleySim): void {
    const { terrain } = this.map;
    const t = sim.t;
    const state = sim.riverState;
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const tile = tileAt(terrain, tx, ty);
        if (tile !== T.WATER && tile !== T.BRIDGE) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        const cx = this.map.riverCenter(ty);
        const nearEdge = Math.abs(tx + 0.5 - cx) > 1.4;
        if (state === "dry") {
          ctx.fillStyle = C.dryBed;
          ctx.fillRect(x, y, TILE, TILE);
          const r = mulberry32(tx * 131 + ty * 517);
          ctx.fillStyle = C.dryCrack;
          for (let i = 0; i < 3; i++) {
            ctx.fillRect(x + Math.floor(r() * 14), y + Math.floor(r() * 14), 2, 1);
          }
          if (r() < 0.12) {
            ctx.fillStyle = "#8fb0c9";
            ctx.fillRect(x + 4, y + 8, 5, 3);
          }
          continue;
        }
        const murky = state === "stale";
        ctx.fillStyle = murky ? (nearEdge ? C.waterMurk : C.waterMurkDeep) : nearEdge ? C.water : C.waterDeep;
        ctx.fillRect(x, y, TILE, TILE);
        // flowing highlight bands
        const speed = murky ? 6 : 16;
        const phase = Math.floor((t * speed + ty * 4 + tx * 2) % 16);
        ctx.fillStyle = murky ? "#8f9b62" : C.waterLight;
        ctx.fillRect(x + ((tx * 7) % 9), y + phase, 3, 1);
        ctx.fillRect(x + ((tx * 11 + 6) % 11), (y + ((phase + 9) % 16)), 2, 1);
        if (!murky && (tx * 31 + ty * 17) % 5 === 0) {
          const sparkle = Math.sin(t * 3 + tx * 1.7 + ty * 2.3);
          if (sparkle > 0.86) {
            ctx.fillStyle = C.waterSparkle;
            ctx.fillRect(x + 6, y + ((phase + 4) % 16), 2, 1);
          }
        }
        // lapping foam where water meets land
        if (!murky) {
          const foamPhase = Math.floor(t * 2 + tx + ty) % 2 === 0;
          ctx.fillStyle = foamPhase ? "#7fb2ea" : C.waterLight;
          if (tileAt(terrain, tx - 1, ty) !== T.WATER && tileAt(terrain, tx - 1, ty) !== T.BRIDGE) {
            ctx.fillRect(x, y + (foamPhase ? 2 : 4), 1, 8);
          }
          if (tileAt(terrain, tx + 1, ty) !== T.WATER && tileAt(terrain, tx + 1, ty) !== T.BRIDGE) {
            ctx.fillRect(x + TILE - 1, y + (foamPhase ? 5 : 3), 1, 8);
          }
        }
      }
    }

    // bridge planks over the water
    const b = this.map.bridgeRect;
    ctx.fillStyle = C.plank;
    ctx.fillRect(b.x, b.y + 4, b.w, b.h - 8);
    for (let px2 = b.x; px2 < b.x + b.w; px2 += 6) {
      ctx.fillStyle = C.woodDark;
      ctx.fillRect(px2, b.y + 4, 1, b.h - 8);
    }
    ctx.fillStyle = C.woodLight;
    ctx.fillRect(b.x, b.y + 4, b.w, 2);
    ctx.fillStyle = C.woodDarker;
    ctx.fillRect(b.x, b.y + 2, b.w, 2);
    ctx.fillRect(b.x, b.y + b.h - 4, b.w, 2);
    for (let px2 = b.x + 2; px2 < b.x + b.w; px2 += 12) {
      ctx.fillStyle = C.woodDark;
      ctx.fillRect(px2, b.y, 3, 4);
      ctx.fillRect(px2, b.y + b.h - 4, 3, 4);
    }
  }

  // ---------------------------------------------------------------- entities

  private shadow(ctx: Ctx, x: number, y: number, w: number): void {
    ctx.fillStyle = "rgba(20,24,16,0.25)";
    ctx.fillRect(Math.round(x - w / 2), Math.round(y - 1), Math.round(w), 3);
  }

  private buildingDrawable(p: Placement, sprite: BuildingSprite, lit: boolean, nf: number): Drawable {
    if (lit && nf > 0.25) {
      for (const w of sprite.windows) {
        this.litWindows.push({ x: p.x + w.x, y: p.y + w.y, w: w.w, h: w.h });
      }
    }
    return {
      baseline: p.y + sprite.h,
      draw: (ctx) => {
        this.shadow(ctx, p.x + sprite.w / 2, p.y + sprite.h, sprite.w * 0.9);
        ctx.drawImage(sprite.canvas, p.x, p.y);
      },
    };
  }

  private characterDraw(
    ctx: Ctx,
    chars: CharacterSprites,
    x: number,
    y: number, // feet position
    walking: boolean,
    facing: 1 | -1,
    dy: number,
    t: number,
    phaseOffset = 0,
    extraBob = 0,
    stepRate = 8.5,
  ): void {
    // step cycle: stand -> step -> stand -> step, small hop on step frames
    const phase = Math.floor(t * stepRate + phaseOffset) % 4;
    const stepping = phase === 1 || phase === 3;
    const bob = walking && stepping ? -1 : 0;
    let spr: Sprite;
    if (walking && Math.abs(dy) < 0.7) {
      // horizontal movement: profile view with a stride scissor
      const set = facing === -1 ? chars.side : chars.sideFlip;
      spr = set[stepping ? 1 : 0];
    } else {
      const back = walking && dy < -0.6;
      const set = back ? (facing === -1 ? chars.backFlip : chars.back) : facing === -1 ? chars.frontFlip : chars.front;
      spr = set[walking ? (phase === 1 ? 1 : phase === 3 ? 2 : 0) : 0];
    }
    this.shadow(ctx, x, y - 1, 10);
    ctx.drawImage(spr.canvas, Math.round(x - spr.w / 2), Math.round(y - spr.h + bob + extraBob));
  }

  private npcDrawable(n: Npc, sim: ValleySim): Drawable {
    const s = this.s;
    return {
      baseline: n.y + 1,
      draw: (ctx) => {
        const walking = n.state === "walk";
        const chars = n.kind === "farmer" ? s.farmer : s.villagers[n.palette % s.villagers.length];
        const work = n.state === "work" ? Math.floor(sim.t * 8) % 2 : 0;
        this.characterDraw(ctx, chars, n.x, n.y, walking, n.facing, n.dy, sim.t, n.id * 1.7, work * 2);
      },
    };
  }

  private playerDrawable(p: Player, sim: ValleySim): Drawable {
    return {
      baseline: p.y + 2,
      draw: (ctx) => {
        this.characterDraw(ctx, this.s.player, p.x, p.y, p.moving, p.facing, p.dy, sim.t, 0, 0, p.sprinting ? 13 : 8.5);
      },
    };
  }

  // ---------------------------------------------------------------- main

  render(screen: Ctx, sim: ValleySim, input: RenderInput): void {
    const { map, s } = this;
    this.sw = screen.canvas.width;
    this.sh = screen.canvas.height;
    this.u = this.sw < 520 ? 2 : 1;
    const nf = nightFactor(input.hour);
    this.litWindows.length = 0;
    const ctx = this.wctx;

    const interior = sim.place !== "world" ? sim.interiors[sim.place] : undefined;
    if (interior) {
      // interior scene: room drawn in world coordinates, void around it
      ctx.fillStyle = "#050508";
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      interior.drawBase(ctx, sim, s, input.hour);
      const ds: Drawable[] = interior.drawables(sim, s);
      ds.push(this.playerDrawable(sim.player, sim));
      ds.sort((a, b) => a.baseline - b.baseline);
      for (const d of ds) d.draw(ctx);
      // tap-to-move ping still reads indoors
      for (const p of sim.particles) {
        if (p.kind !== "ping") continue;
        const lifeT = p.age / p.life;
        const r = 2 + lifeT * 6;
        ctx.strokeStyle = `rgba(255,246,200,${(0.9 * (1 - lifeT)).toFixed(3)})`;
        ctx.strokeRect(Math.round(p.x - r), Math.round(p.y - r * 0.6), Math.round(r * 2), Math.round(r * 1.2));
      }
      interior.drawOverlay(ctx, sim, s, input.hour);
      this.blitAndHud(screen, sim, input, interior);
      return;
    }

    ctx.drawImage(this.ground, 0, 0);
    this.drawWater(ctx, sim);

    // seedbed seedlings (flat on soil, no sorting needed)
    for (let i = 0; i < sim.seedlingCount && i < map.seedbedPlots.length; i++) {
      const plot = map.seedbedPlots[i];
      ctx.drawImage(s.seedling.canvas, plot.x - 4, plot.y - 6);
    }

    const drawables: Drawable[] = [];

    // fences
    for (const f of map.fences) {
      drawables.push({
        baseline: f.y + 10,
        draw: (c) => {
          c.fillStyle = C.woodDark;
          if (f.kind === "h") {
            c.fillRect(f.x, f.y + 2, TILE, 2);
            c.fillRect(f.x, f.y + 6, TILE, 2);
          } else if (f.kind === "v") {
            c.fillRect(f.x + 1, f.y + 4, 2, TILE);
          }
          c.fillStyle = C.wood;
          c.fillRect(f.x, f.y - 2, 3, 11);
          c.fillStyle = C.woodLight;
          c.fillRect(f.x, f.y - 2, 3, 1);
        },
      });
    }

    // crops
    for (const crop of sim.crops) {
      const plot = map.fieldPlots[crop.plot];
      const age = sim.t - crop.plantedAt;
      const stage = clamp(Math.floor((age / 90) * 4), 0, 3);
      const spr = s.crops[crop.color][stage];
      drawables.push({
        baseline: plot.y + 6,
        draw: (c) => c.drawImage(spr.canvas, Math.round(plot.x - spr.w / 2), Math.round(plot.y - spr.h + 4)),
      });
    }

    // placements
    const countryHouses = this.assignHouses(sim);
    let houseIdx = 0;
    for (const p of map.placements) {
      switch (p.kind) {
        case "farmhouse":
          drawables.push(this.buildingDrawable(p, s.farmhouse, sim.serverOk, nf));
          break;
        case "barn":
          drawables.push(this.buildingDrawable(p, s.barn, sim.serverOk, nf));
          break;
        case "silo": {
          const silo = s.silo;
          drawables.push({
            baseline: p.y + silo.h,
            draw: (c) => {
              this.shadow(c, p.x + silo.w / 2, p.y + silo.h, silo.w);
              c.drawImage(silo.canvas, p.x, p.y);
              // fill gauge inside the hatch (x 8..12, y 16..54)
              const gaugeH = 38;
              const fill = Math.round(gaugeH * clamp(sim.siloFill, 0, 1));
              const full = sim.siloFill > 0.85;
              c.fillStyle = full ? "#d86a3a" : C.hay;
              if (fill > 0) c.fillRect(p.x + 8, p.y + 16 + (gaugeH - fill), 4, fill);
            },
          });
          break;
        }
        case "coop":
          drawables.push(this.buildingDrawable(p, s.coop, (sim.status?.sseTotal ?? 0) > 0, nf));
          break;
        case "house": {
          const info = countryHouses[houseIdx++] ?? null;
          const sprite = s.houses[p.variant % s.houses.length];
          const lit = info ? info.isWarm : false;
          drawables.push(this.buildingDrawable(p, sprite, lit, nf));
          break;
        }
        case "windmill": {
          const wm = s.windmill;
          drawables.push({
            baseline: p.y + wm.h,
            draw: (c) => {
              this.shadow(c, p.x + wm.w / 2, p.y + wm.h, wm.w);
              c.drawImage(wm.canvas, p.x, p.y);
              const phase = Math.floor(sim.t * (0.6 + sim.windmillSpeed * 3.4)) % 2;
              const blades = s.blades[phase];
              c.drawImage(blades.canvas, p.x + wm.w / 2 - blades.w / 2, p.y + 10 - blades.h / 2);
              if (sim.windmillSpeed > 1.02) {
                c.fillStyle = "#ff5a3a";
                c.fillRect(p.x + wm.w / 2 - 1, p.y + 9, 3, 3);
              }
            },
          });
          break;
        }
        case "well":
          // no ground-shadow bar: the stone base sits flush on the ground
          drawables.push({ baseline: p.y + s.well.h, draw: (c) => c.drawImage(s.well.canvas, p.x, p.y) });
          break;
        case "oak": {
          const spr = s.oaks[p.variant % s.oaks.length];
          drawables.push({
            baseline: p.y + spr.h,
            draw: (c) => {
              this.shadow(c, p.x + spr.w / 2, p.y + spr.h, spr.w * 0.7);
              c.drawImage(spr.canvas, p.x, p.y);
            },
          });
          break;
        }
        case "pine": {
          const spr = s.pines[p.variant % s.pines.length];
          drawables.push({
            baseline: p.y + spr.h,
            draw: (c) => {
              this.shadow(c, p.x + spr.w / 2, p.y + spr.h, spr.w * 0.7);
              c.drawImage(spr.canvas, p.x, p.y);
            },
          });
          break;
        }
        case "bush": {
          const spr = s.bushes[p.variant % s.bushes.length];
          drawables.push({ baseline: p.y + spr.h, draw: (c) => c.drawImage(spr.canvas, p.x, p.y) });
          break;
        }
        case "flower": {
          const spr = s.flowers[p.variant % s.flowers.length];
          drawables.push({ baseline: p.y + spr.h, draw: (c) => c.drawImage(spr.canvas, p.x, p.y) });
          break;
        }
        case "tuft":
          drawables.push({ baseline: p.y + 6, draw: (c) => c.drawImage(s.grassTuft.canvas, p.x, p.y) });
          break;
        case "rock": {
          const spr = s.rocks[p.variant % s.rocks.length];
          drawables.push({ baseline: p.y + spr.h, draw: (c) => c.drawImage(spr.canvas, p.x, p.y) });
          break;
        }
        case "stump":
          drawables.push({ baseline: p.y + s.stump.h, draw: (c) => c.drawImage(s.stump.canvas, p.x, p.y) });
          break;
        case "signpost":
          drawables.push({ baseline: p.y + s.signpost.h, draw: (c) => c.drawImage(s.signpost.canvas, p.x, p.y) });
          break;
        case "mailbox":
          drawables.push({ baseline: p.y + s.mailbox.h, draw: (c) => c.drawImage(s.mailbox.canvas, p.x, p.y) });
          break;
        case "lamp":
          drawables.push({ baseline: p.y + s.lampPost.h, draw: (c) => c.drawImage(s.lampPost.canvas, p.x, p.y) });
          break;
        case "boat":
          drawables.push({
            baseline: p.y + s.boat.h,
            draw: (c) => c.drawImage(s.boat.canvas, p.x, Math.round(p.y + (sim.riverState === "flow" ? Math.sin(sim.t * 1.4) * 1.2 : 0))),
          });
          break;
        case "hay": {
          drawables.push({
            baseline: p.y + s.hayBale.h,
            draw: (c) => {
              for (let i = 0; i < sim.hayBales; i++) {
                const col = i % 2;
                const row = Math.floor(i / 2);
                c.drawImage(s.hayBale.canvas, p.x + col * 15, p.y - row * 8 + (row > 0 ? 2 : 0));
              }
            },
          });
          break;
        }
      }
    }

    // scarecrow appears while the queue sheds load
    if (sim.scarecrow) {
      const x = map.fieldRect.x + map.fieldRect.w - 30;
      const y = map.fieldRect.y + 26;
      drawables.push({
        baseline: y + s.scarecrow.h,
        draw: (c) => {
          this.shadow(c, x + 7, y + s.scarecrow.h, 12);
          c.drawImage(s.scarecrow.canvas, x, y);
        },
      });
    }

    // chickens
    for (const ch of sim.chickens) {
      const frame = ch.state === "peck" ? 2 : Math.floor(sim.t * 5) % 2;
      const spr = (ch.facing === -1 ? s.chicken : s.chickenFlip)[frame];
      drawables.push({
        baseline: ch.y + 4,
        draw: (c) => {
          this.shadow(c, ch.x, ch.y + 2, 8);
          c.drawImage(spr.canvas, Math.round(ch.x - spr.w / 2), Math.round(ch.y - spr.h + 3));
        },
      });
    }

    // NPCs + player
    for (const n of sim.npcs) drawables.push(this.npcDrawable(n, sim));
    drawables.push(this.playerDrawable(sim.player, sim));

    drawables.sort((a, b) => a.baseline - b.baseline);
    for (const d of drawables) d.draw(ctx);

    // particles (world space)
    this.drawParticles(ctx, sim);

    // flyers (above world)
    for (const f of sim.flyers) {
      const frame = Math.floor(f.phase) % 2;
      const spr = f.kind === "butterfly" ? s.butterfly[frame] : s.bird[frame];
      ctx.drawImage(spr.canvas, Math.round(f.x), Math.round(f.y));
    }

    // drifting pixel cloud shadows + world lighting
    this.drawClouds(ctx, sim);
    this.drawLighting(ctx, sim, nf, input.hour);
    this.drawBubbles(ctx, sim);

    this.blitAndHud(screen, sim, input, null);
  }

  // Camera blit + screen-space UI shared by the outdoor and interior passes.
  private blitAndHud(screen: Ctx, sim: ValleySim, input: RenderInput, interior: Interior | null): void {
    const { sw, sh } = this;
    screen.imageSmoothingEnabled = false;
    if (input.zoom === 1) {
      // map view: fit the whole world, letterboxed when the screen is tall
      const k = Math.min(sw / VIEW_W, sh / VIEW_H);
      const dw = Math.round(VIEW_W * k);
      const dh = Math.round(VIEW_H * k);
      const ox = Math.round((sw - dw) / 2);
      const oy = Math.round((sh - dh) / 2);
      screen.fillStyle = "#08080f";
      screen.fillRect(0, 0, sw, sh);
      screen.drawImage(this.world, 0, 0, VIEW_W, VIEW_H, ox, oy, dw, dh);
      this.cam.x = 0;
      this.cam.y = 0;
      this.view = { k, ox, oy };
    } else {
      // follow camera, hard-locked to rounded positions: any smoothing makes
      // the rounded player and rounded camera drift by a pixel against each
      // other (visible jitter)
      const zoom = input.zoom;
      const srcW = Math.min(VIEW_W, Math.round(sw / zoom));
      const srcH = Math.min(VIEW_H, Math.round(sh / zoom));
      if (interior) {
        // frame the room; follow the player only when the room is wider than
        // the viewport (narrow portrait screens)
        const f = interior.floor;
        this.cam.x =
          f.w + 24 > srcW
            ? clamp(Math.round(sim.player.x) - srcW / 2, f.x - 12, f.x + f.w + 12 - srcW)
            : Math.round(f.x + f.w / 2) - srcW / 2;
        this.cam.y = clamp(Math.round(f.y + f.h / 2 - 16) - srcH / 2, 0, VIEW_H - srcH);
      } else {
        this.cam.x = clamp(Math.round(sim.player.x) - srcW / 2, 0, VIEW_W - srcW);
        this.cam.y = clamp(Math.round(sim.player.y) - srcH / 2, 0, VIEW_H - srcH);
      }
      screen.drawImage(this.world, this.cam.x, this.cam.y, srcW, srcH, 0, 0, srcW * zoom, srcH * zoom);
      this.view = { k: zoom, ox: -this.cam.x * zoom, oy: -this.cam.y * zoom };
    }

    // screen-space weather + UI (crisp, unaffected by camera); no weather
    // effects indoors
    if (!interior) this.drawScreenWeather(screen, sim);
    this.drawHud(screen, sim, input);
    if (interior) {
      // portrait: the wide HUD board owns the top edge, drop the label below it
      const ly = this.u === 1 ? 9 : 6 + 30 * this.u + 6;
      drawText(screen, interior.label, Math.round(sw / 2), ly, C.uiDim, { align: "center", scale: this.u });
    }
    if (input.hover && !input.dialog) this.drawHoverLabel(screen, input);
    if (input.dialog) this.drawDialog(screen, input.dialog);
    if (sim.connectionLost) this.drawConnectionLost(screen, sim);

    screen.drawImage(this.vignette, 0, 0, sw, sh);

    // door-transition fade covers everything
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

  // in-canvas UI buttons; on small (portrait) screens they drop below the
  // clock and double in size for touch
  uiButtons(): { sound: Rect; zoom: Rect } {
    const { sw, u } = this;
    if (u === 1) {
      return {
        sound: { x: sw - 132, y: 6, w: 20, h: 15 },
        zoom: { x: sw - 108, y: 6, w: 34, h: 15 },
      };
    }
    const y = 6 + 15 * u + 6;
    return {
      sound: { x: sw - 54 * u - 10, y, w: 20 * u, h: 15 * u },
      zoom: { x: sw - 34 * u - 6, y, w: 34 * u, h: 15 * u },
    };
  }

  private drawParticles(ctx: Ctx, sim: ValleySim): void {
    for (const p of sim.particles) {
      const lifeT = p.age / p.life;
      if (p.kind === "smoke") {
        const r = 1.5 + p.size + lifeT * 3;
        ctx.fillStyle = `rgba(207,201,189,${(0.5 * (1 - lifeT)).toFixed(3)})`;
        ctx.fillRect(Math.round(p.x - r / 2), Math.round(p.y - r / 2), Math.round(r), Math.round(r));
      } else if (p.kind === "splash") {
        const r = 2 + lifeT * 7;
        ctx.strokeStyle = `rgba(207,232,250,${(0.8 * (1 - lifeT)).toFixed(3)})`;
        ctx.strokeRect(Math.round(p.x - r), Math.round(p.y - r / 2), Math.round(r * 2), Math.round(r));
      } else if (p.kind === "ping") {
        const r = 2 + lifeT * 6;
        ctx.strokeStyle = `rgba(255,246,200,${(0.9 * (1 - lifeT)).toFixed(3)})`;
        ctx.strokeRect(Math.round(p.x - r), Math.round(p.y - r * 0.6), Math.round(r * 2), Math.round(r * 1.2));
      } else if (p.kind === "zzz") {
        ctx.fillStyle = `rgba(207,214,255,${(1 - lifeT).toFixed(3)})`;
        drawText(ctx, "Z", p.x, p.y, `rgba(220,226,255,${(1 - lifeT).toFixed(3)})`);
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
    if (blend <= 0.01 || sim.weather === "sunny") return;
    ctx.globalAlpha = 0.45 * blend;
    for (let i = 0; i < 3; i++) {
      const spr = this.s.clouds[i % this.s.clouds.length];
      const cx = ((sim.t * (5 + i * 2.4) + i * 331) % (VIEW_W + 260)) - 130;
      const cy = 30 + i * 128;
      ctx.drawImage(spr.canvas, Math.round(cx), cy);
    }
    ctx.globalAlpha = 1;
  }

  private drawScreenWeather(ctx: Ctx, sim: ValleySim): void {
    const blend = sim.weatherBlend;
    if (blend <= 0.01) return;
    const w = sim.weather;
    const { sw, sh } = this;

    if (w === "rain" || w === "storm") {
      const count = Math.round((w === "storm" ? 130 : 70) * (sw / VIEW_W));
      ctx.strokeStyle = `rgba(173,203,238,${(0.7 * blend).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const seed = i * 137.5;
        const x = (seed * 7.13 + sim.t * 160) % (sw + 40) - 20;
        const y = (seed * 3.77 + sim.t * 330) % sh;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 2, y + 7);
      }
      ctx.stroke();
    }

    if (w === "storm") {
      ctx.fillStyle = `rgba(16,18,34,${(0.22 * blend).toFixed(3)})`;
      ctx.fillRect(0, 0, sw, sh);
      if (sim.t < this.lightningUntil) {
        // gentle flash: bright enough to read as lightning, easy on the eyes
        ctx.fillStyle = "rgba(240,244,255,0.16)";
        ctx.fillRect(0, 0, sw, sh);
      }
    }
  }

  private drawLighting(ctx: Ctx, sim: ValleySim, nf: number, _hour: number): void {
    const tint = skyTint(_hour);
    if (tint.a > 0.01) {
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = tint.a;
      ctx.fillStyle = tint.color;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    if (nf > 0.2) {
      ctx.globalCompositeOperation = "lighter";
      const glow = (x: number, y: number, r: number, color: string, a: number) => {
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, color);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = a * nf;
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      };
      for (const p of this.map.placements) {
        if (p.kind === "lamp") glow(p.x + 5, p.y + 4, 26, "rgba(255,214,120,0.55)", 0.8);
      }
      for (const w of this.litWindows) {
        ctx.globalAlpha = 0.85 * nf;
        ctx.fillStyle = C.windowNight;
        ctx.fillRect(w.x, w.y, w.w, w.h);
        glow(w.x + w.w / 2, w.y + w.h / 2, 13, "rgba(255,214,120,0.5)", 0.7);
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
      const x = Math.round(clamp(n.x - w / 2, 2, VIEW_W - w - 2));
      const y = Math.round(n.y - 38);
      ctx.fillStyle = "#f4f0e6";
      ctx.fillRect(x, y, w, 13);
      ctx.fillStyle = "#2b2118";
      ctx.fillRect(x + 1, y + 1, w - 2, 11);
      ctx.fillStyle = "#f4f0e6";
      ctx.fillRect(x + 2, y + 2, w - 4, 9);
      // tail
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

    // wooden board (screen-space UI, world scrolls beneath it)
    const bw = Math.max(textWidth(line1, u), textWidth(line2, u)) + 12 * u;
    const bh = 30 * u;
    const bx = 6;
    const by = 6;
    ctx.fillStyle = "rgba(43,33,24,0.85)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = C.woodLight;
    ctx.fillRect(bx, by, bw, 1);
    ctx.fillRect(bx, by + bh - 1, bw, 1);
    ctx.fillRect(bx, by, 1, bh);
    ctx.fillRect(bx + bw - 1, by, 1, bh);
    drawText(ctx, line1, bx + 6 * u, by + 5 * u, C.uiText, { scale: u });
    drawText(ctx, line2, bx + 6 * u, by + 17 * u, C.uiDim, { scale: u });

    // clock + weather, top right
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
    const cw = textWidth(clock, u) + 14 * u + 4;
    const cbx = sw - cw - 8;
    ctx.fillStyle = "rgba(21,18,33,0.8)";
    ctx.fillRect(cbx, 6, cw + 2, 15 * u);
    ctx.drawImage(icon.canvas, cbx + 3, 6 + 3 * u, 9 * u, 9 * u);
    drawText(ctx, clock, cbx + 3 + 9 * u + 2, 6 + 4 * u, C.uiText, { scale: u });

    // sound + camera buttons
    const button = (r: Rect, label: string, active: boolean) => {
      ctx.fillStyle = "rgba(21,18,33,0.85)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = active ? C.uiText : "rgba(168,158,143,0.5)";
      ctx.fillRect(r.x, r.y, r.w, 1);
      ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
      ctx.fillRect(r.x, r.y, 1, r.h);
      ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
      drawText(ctx, label, r.x + r.w / 2, r.y + (r.h - FONT_H * u) / 2 + 1, active ? C.uiText : C.uiDim, {
        align: "center",
        scale: u,
      });
    };
    const btns = this.uiButtons();
    const soundOn = input.audioUnlocked && !input.muted;
    button(btns.sound, "♪", soundOn);
    if (!soundOn) {
      ctx.fillStyle = C.uiRed;
      ctx.fillRect(btns.sound.x + 4 * u, btns.sound.y + btns.sound.h - 5 * u, btns.sound.w - 8 * u, u);
    }
    button(btns.zoom, input.zoom > 1 ? "MAP" : "ZOOM", true);

    // alert chips
    let chipY = by + bh + 4;
    const chip = (text: string, color: string) => {
      const w = textWidth(text, u) + 8 * u;
      ctx.fillStyle = "rgba(21,18,33,0.85)";
      ctx.fillRect(bx, chipY, w, 12 * u);
      ctx.fillStyle = color;
      ctx.fillRect(bx, chipY, 2, 12 * u);
      drawText(ctx, text, bx + 5 * u, chipY + 3 * u, color, { scale: u });
      chipY += 15 * u;
    };
    if (sim.connectionLost) chip("MONITOR OFFLINE", C.uiRed);
    else if (s) {
      if (!s.ok || !s.db) chip("SERVER NOT OK", C.uiRed);
      if (s.osc && !s.osc.connected) chip("FEED DISCONNECTED", C.uiRed);
      else if (s.osc?.stale) chip("FEED STALE", C.uiYellow);
      if (s.shedding) chip("QUEUE SHEDDING", C.uiYellow);
      if (s.workerPaused) chip("WORKERS PAUSED", C.uiYellow);
      if (s.storage?.overLimit) chip("STORAGE OVER LIMIT", C.uiRed);
    } else {
      chip("WAKING UP...", C.uiDim);
    }
  }

  private drawHoverLabel(ctx: Ctx, input: RenderInput): void {
    if (!input.hover || !input.mouse) return;
    const { sw, sh, u } = this;
    const text = input.hover.label;
    const w = textWidth(text, u) + 8 * u;
    const x = Math.round(clamp(input.mouse.x + 8, 2, sw - w - 2));
    const y = Math.round(clamp(input.mouse.y - 14 * u, 2, sh - 14 * u));
    ctx.fillStyle = "rgba(21,18,33,0.9)";
    ctx.fillRect(x, y, w, 12 * u);
    ctx.fillStyle = C.uiYellow;
    ctx.fillRect(x, y, 1, 12 * u);
    drawText(ctx, text, x + 4 * u, y + 3 * u, C.uiText, { scale: u });
  }

  private drawDialog(ctx: Ctx, dialog: DialogState): void {
    const { sw, sh, u } = this;
    const margin = u === 1 ? 24 : 8;
    const lineH = (FONT_H + 4) * u;
    // grow with the wrapped text (portrait wraps into more, shorter lines)
    const textH = 8 + (FONT_H + 6) * u + dialog.lines.length * lineH + 10;
    const h = Math.max(u === 1 ? 78 : 68, textH);
    const x = margin;
    const y = sh - h - 10;
    const w = sw - margin * 2;
    // Deltarune-style: black box, chunky white border
    ctx.fillStyle = "rgba(8,8,16,0.94)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.uiBorder;
    ctx.fillRect(x - 2, y - 2, w + 4, 2);
    ctx.fillRect(x - 2, y + h, w + 4, 2);
    ctx.fillRect(x - 2, y, 2, h);
    ctx.fillRect(x + w, y, 2, h);

    let textX = x + 10;
    if (dialog.portrait) {
      const box = 52;
      const pad = 8;
      ctx.fillStyle = "rgba(21,18,33,1)";
      ctx.fillRect(x + pad, y + (h - box) / 2, box, box);
      ctx.strokeStyle = C.uiDim;
      ctx.strokeRect(x + pad + 0.5, y + (h - box) / 2 + 0.5, box - 1, box - 1);
      const p = dialog.portrait;
      let scale = Math.min((box - 8) / p.w, (box - 8) / p.h);
      if (scale >= 1) scale = Math.min(3, Math.floor(scale));
      const pw = Math.max(1, Math.round(p.w * scale));
      const ph = Math.max(1, Math.round(p.h * scale));
      ctx.drawImage(p.canvas, Math.round(x + pad + (box - pw) / 2), Math.round(y + (h - box) / 2 + (box - ph) / 2), pw, ph);
      textX = x + pad + box + 10;
    }

    drawText(ctx, dialog.title, textX, y + 8, dialog.accent, { scale: u });
    let shown = dialog.revealed;
    let lineY = y + 8 + (FONT_H + 6) * u;
    for (const line of dialog.lines) {
      if (shown <= 0) break;
      const part = line.slice(0, Math.max(0, Math.floor(shown)));
      drawText(ctx, part, textX, lineY, C.uiText, { scale: u });
      shown -= line.length;
      lineY += lineH;
    }
    // continue arrow when fully revealed
    const total = dialog.lines.reduce((a, l) => a + l.length, 0);
    if (dialog.revealed >= total && Math.floor(Date.now() / 400) % 2 === 0) {
      drawText(ctx, "↓", x + w - 14 * u, y + h - 14 * u, C.uiYellow, { scale: u });
    }
  }

  private drawConnectionLost(ctx: Ctx, sim: ValleySim): void {
    const text = "THE VALLEY CANNOT REACH THE FARM...";
    const { sw } = this;
    const scl = textWidth(text, this.u) + 20 <= sw ? this.u : 1;
    const w = textWidth(text, scl) + 20;
    const bh = 20 * scl;
    const x = (sw - w) / 2;
    const y = 60;
    ctx.fillStyle = "rgba(8,8,16,0.9)";
    ctx.fillRect(x, y, w, bh);
    ctx.fillStyle = C.uiRed;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + bh - 1, w, 1);
    const blink = Math.floor(sim.t * 2) % 2 === 0;
    drawText(ctx, text, sw / 2, y + (bh - FONT_H * scl) / 2, blink ? C.uiRed : C.uiDim, { align: "center", scale: scl });
  }

  private assignHouses(sim: ValleySim): Array<{ country: string; isWarm: boolean } | null> {
    return sim.housesRanked.map((c) => (c ? { country: c.country, isWarm: c.isWarm || c.status === "active" } : null));
  }
}
