// The living part of the valley: NPCs, animals, crops, particles and
// weather, all driven by diffs of the parsed backend status. The sim never
// reads the network itself; game.ts feeds it new snapshots.

import { clamp, lerp, mulberry32, TILE, MAP_W, MAP_H, VIEW_W, VIEW_H } from "./core";
import { isSolidAt, type ValleyMap } from "./map";
import { buildDoors, buildInteriors, interiorSolidAt, type DoorDef, type Interior } from "./interiors";
import type { ValleyStatus, ValleyVisitors, ValleyVisitorEvent } from "./types";
import { CROP_COLORS } from "./sprites";

export type Weather = "sunny" | "overcast" | "rain" | "storm";

export type SoundEvent =
  | "splash"
  | "harvest"
  | "plant"
  | "cluck"
  | "thunder"
  | "bubble"
  | "well"
  | "door";

export interface Crop {
  plot: number;
  plantedAt: number; // sim seconds
  color: string; // CROP_COLORS key
}

export interface Bubble {
  text: string;
  until: number;
}

export interface Npc {
  id: number;
  kind: "villager" | "farmer";
  x: number;
  y: number;
  tx: number;
  ty: number;
  node: number; // current graph node (villagers)
  prevNode: number;
  palette: number;
  state: "walk" | "pause" | "work" | "sleep";
  stateUntil: number;
  facing: 1 | -1;
  dy: number; // vertical movement component, for back-view sprites
  bubble: Bubble | null;
  workPlot: number; // farmer target plot
  speed: number;
}

export interface Player {
  x: number;
  y: number;
  facing: 1 | -1;
  dy: number;
  moving: boolean;
  sprinting: boolean;
  target: { x: number; y: number } | null;
  waypoints: Array<{ x: number; y: number }>; // remaining path after target
}

// feet-collision sample offsets shared by movement and pathfinding
const FEET = [
  [-4, 0],
  [4, 0],
  [-4, -3],
  [4, -3],
] as const;

export interface Chicken {
  x: number;
  y: number;
  tx: number;
  ty: number;
  state: "walk" | "pause" | "peck";
  stateUntil: number;
  facing: 1 | -1;
}

export interface Particle {
  kind: "smoke" | "sparkle" | "splash" | "drop" | "dirt" | "leaf" | "firefly" | "zzz" | "ping";
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color: string;
  size: number;
}

export interface Flyer {
  kind: "butterfly" | "bird";
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  phase: number;
}

const CROP_KEYS = Object.keys(CROP_COLORS);
const MAX_CROPS = 60;
const MAX_SEEDLINGS = 32;
const MAX_CHICKENS = 8;
const MAX_VILLAGERS = 10;
const FARMER_COUNT = 3;
const CROP_GROW_SECONDS = 90;

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class ValleySim {
  readonly map: ValleyMap;
  t = 0;

  status: ValleyStatus | null = null;
  visitors: ValleyVisitors | null = null;
  connectionLost = false; // polling the backend itself failed

  weather: Weather = "sunny";
  weatherBlend = 0; // 0 clear -> 1 full weather effect
  windmillSpeed = 0; // display value, eased
  windmillTarget = 0;
  siloFill = 0;
  hayBales = 1;
  scarecrow = false;
  serverOk = true;
  riverState: "flow" | "stale" | "dry" = "flow";

  crops: Crop[] = [];
  seedlingCount = 0;
  npcs: Npc[] = [];
  chickens: Chicken[] = [];
  particles: Particle[] = [];
  flyers: Flyer[] = [];
  sounds: SoundEvent[] = [];

  // the user's avatar; starts on the path outside the farmhouse
  player: Player = { x: 96, y: 146, facing: 1, dy: 0, moving: false, sprinting: false, target: null, waypoints: [] };
  moveInput = { x: 0, y: 0 };
  sprint = false; // held shift
  private static readonly PLAYER_SPEED = 70;
  private static readonly SPRINT_MULT = 1.6;

  // where the player is: "world" or an interior id from ./interiors
  place = "world";
  doors: DoorDef[];
  interiors: Record<string, Interior>;
  transition: { phase: "out" | "in"; t: number; toPlace: string; toX: number; toY: number } | null = null;
  housesRanked: Array<ValleyStatus["countries"][number] | null> = [];
  private pendingDoor: string | null = null;

  private plantQueue = 0;
  private harvestQueue = 0;
  private splashQueue = 0;
  private wellQueue = 0;
  private bubbleQueue: ValleyVisitorEvent[] = [];
  private seenEventKeys = new Set<string>();
  private lastEventAt: string | null = null;
  private lastFallbackAt: string | null = null;
  private nextNpcId = 1;
  private thunderAt = 0;
  private rng = mulberry32(99);
  private smokeAt = 0;
  private ambientAt = 0;
  private queueTickAt = 0;
  private targetVillagers = 1;
  private busyLanes = 0;
  private flowerSpots: Array<{ x: number; y: number }>;
  private treeSpots: Array<{ x: number; y: number }>;
  private walkable: Uint8Array; // per-tile walkability for tap pathfinding

  constructor(map: ValleyMap) {
    this.map = map;
    this.flowerSpots = map.placements.filter((p) => p.kind === "flower").map((p) => ({ x: p.x, y: p.y }));
    this.treeSpots = map.placements.filter((p) => p.kind === "oak").map((p) => ({ x: p.x + 11, y: p.y + 10 }));
    this.doors = buildDoors(map);
    this.interiors = buildInteriors(map);
    this.walkable = new Uint8Array(MAP_W * MAP_H);
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const cx = tx * TILE + 8;
        const cy = ty * TILE + 8;
        this.walkable[ty * MAP_W + tx] = FEET.every(([ox, oy]) => !isSolidAt(map, cx + ox, cy + oy)) ? 1 : 0;
      }
    }
    for (let i = 0; i < FARMER_COUNT; i++) this.spawnFarmer();
  }

  // ------------------------------------------------------------------ status

  setStatus(status: ValleyStatus): void {
    const prev = this.status;
    this.status = status;
    this.connectionLost = false;
    this.serverOk = status.ok && status.db;

    // river
    if (!status.osc || !status.osc.connected) this.riverState = "dry";
    else if (status.osc.stale) this.riverState = "stale";
    else this.riverState = "flow";

    // score ingest -> river splashes
    if (status.lastEventAt && status.lastEventAt !== this.lastEventAt) {
      if (this.lastEventAt !== null) this.splashQueue = Math.min(this.splashQueue + 2, 6);
      this.lastEventAt = status.lastEventAt;
    }

    // fallback scanner -> well activity
    const fb = status.scoresFallback;
    if (fb?.updatedAt && fb.updatedAt !== this.lastFallbackAt) {
      if (this.lastFallbackAt !== null && fb.inserted > 0) {
        this.wellQueue = Math.min(this.wellQueue + Math.min(fb.inserted, 4), 8);
        this.sounds.push("well");
      }
      this.lastFallbackAt = fb.updatedAt;
    }

    // crops <- queue depth
    const target = clamp(status.queueDepth, 0, MAX_CROPS);
    const diff = target - (this.crops.length + this.plantQueue - this.harvestQueue);
    if (diff > 0) this.plantQueue += diff;
    else if (diff < 0) this.harvestQueue += -diff;
    if (prev === null) {
      // first snapshot: plant instantly, pre-grown
      this.drainPlantQueue(true);
    }

    this.seedlingCount = clamp(Math.round(status.deferred / 50), status.deferred > 0 ? 1 : 0, MAX_SEEDLINGS);
    this.scarecrow = status.shedding;

    // windmill <- API rate
    if (status.rate) {
      this.windmillTarget = clamp(status.rate.usedLastMinute / Math.max(1, status.rate.targetPerMinute), 0, 2.2);
    }

    // silo <- storage
    if (status.storage) {
      this.siloFill = clamp(status.storage.bytes / Math.max(1, status.storage.maxBytes), 0, 1);
      this.hayBales = clamp(Math.ceil(status.storage.walBytes / (128 * 1024 * 1024)), 1, 4);
    }

    // chickens <- SSE clients
    const chickenTarget = clamp(status.sseTotal, 0, MAX_CHICKENS);
    while (this.chickens.length < chickenTarget) this.spawnChicken();
    if (this.chickens.length > chickenTarget) this.chickens.length = chickenTarget;

    this.busyLanes = status.lanes.filter((l) => l.active > 0).length;

    // top countries get the village houses (shared by renderer, dialogs and
    // the cottage interiors)
    const rankedCountries = [...status.countries].sort((a, b) => {
      const score = (c: ValleyStatus["countries"][number]) =>
        (c.pinned ? 8 : 0) +
        (c.featureTier === "snipes" ? 4 : c.featureTier === "live" ? 3 : c.featureTier === "maps_warm" ? 2 : 0) +
        (c.isWarm ? 1 : 0) +
        Math.min(c.activeUsers, 3) * 0.1;
      return score(b) - score(a);
    });
    this.housesRanked = this.map.villageHouses.map((_, i) => rankedCountries[i] ?? null);

    // weather. Storms (thunder + lightning) are reserved for a genuinely
    // broken/unreachable backend; a dry or erroring feed is gloomy rain and
    // chronic staleness is just overcast, so a bad feed day does not flash
    // the screen for hours.
    let weather: Weather = "sunny";
    if (!this.serverOk) weather = "storm";
    else if (this.riverState === "dry" || status.apiErrors15m >= 5) weather = "rain";
    else if (this.riverState === "stale" || status.shedding) weather = "overcast";
    this.weather = weather;
  }

  setVisitors(visitors: ValleyVisitors): void {
    this.visitors = visitors;
    this.targetVillagers = clamp(visitors.activeVisitors, visitors.activeVisitors > 0 ? 1 : 0, MAX_VILLAGERS);
    for (const ev of visitors.recent) {
      if (this.seenEventKeys.has(ev.key)) continue;
      this.seenEventKeys.add(ev.key);
      this.bubbleQueue.push(ev);
    }
    // keep memory bounded
    if (this.seenEventKeys.size > 4000) {
      this.seenEventKeys = new Set([...this.seenEventKeys].slice(-2000));
    }
    if (this.bubbleQueue.length > 12) this.bubbleQueue = this.bubbleQueue.slice(-12);
  }

  setConnectionLost(): void {
    this.connectionLost = true;
    this.serverOk = false;
    this.weather = "storm";
    this.riverState = "dry";
    this.windmillTarget = 0;
  }

  // ------------------------------------------------------------------ spawns

  private spawnFarmer(): void {
    const f = this.map.fieldRect;
    this.npcs.push({
      id: this.nextNpcId++,
      kind: "farmer",
      x: f.x + 20 + this.rng() * (f.w - 40),
      y: f.y + 24 + this.rng() * (f.h - 40),
      tx: 0,
      ty: 0,
      node: 0,
      prevNode: 0,
      palette: 0,
      state: "pause",
      stateUntil: this.t + 1 + this.rng() * 2,
      facing: 1,
      dy: 0,
      bubble: null,
      workPlot: -1,
      speed: 16,
    });
  }

  private spawnVillager(): void {
    const nodes = this.map.graph.nodes;
    const node = Math.floor(this.rng() * nodes.length);
    this.npcs.push({
      id: this.nextNpcId++,
      kind: "villager",
      x: nodes[node].x,
      y: nodes[node].y,
      tx: nodes[node].x,
      ty: nodes[node].y,
      node,
      prevNode: node,
      palette: Math.floor(this.rng() * 6),
      state: "pause",
      stateUntil: this.t + this.rng() * 2,
      facing: this.rng() < 0.5 ? 1 : -1,
      dy: 0,
      bubble: null,
      workPlot: -1,
      speed: 22 + this.rng() * 8,
    });
  }

  private spawnChicken(): void {
    const p = this.map.penRect;
    this.chickens.push({
      x: p.x + 8 + this.rng() * (p.w - 16),
      y: p.y + 8 + this.rng() * (p.h - 16),
      tx: 0,
      ty: 0,
      state: "pause",
      stateUntil: this.t + this.rng() * 2,
      facing: 1,
    });
  }

  private drainPlantQueue(instant: boolean): void {
    while (this.plantQueue > 0 && this.crops.length < MAX_CROPS) {
      const used = new Set(this.crops.map((c) => c.plot));
      const free: number[] = [];
      for (let i = 0; i < this.map.fieldPlots.length; i++) if (!used.has(i)) free.push(i);
      if (free.length === 0) break;
      const plot = free[Math.floor(this.rng() * free.length)];
      const colorKey = this.pickCropColor();
      this.crops.push({
        plot,
        plantedAt: instant ? this.t - this.rng() * CROP_GROW_SECONDS * 1.2 : this.t,
        color: colorKey,
      });
      this.plantQueue--;
      if (!instant) {
        this.sounds.push("plant");
        return; // one per tick when animated
      }
    }
    if (this.plantQueue > 0 && this.crops.length >= MAX_CROPS) this.plantQueue = 0;
  }

  // Weighted pick over the queue's job-type mix, so the field's crop variety
  // mirrors what the queue actually holds.
  private pickCropColor(): string {
    const s = this.status;
    const rows = (s?.queueSummary ?? []).filter((q) => q.count > 0);
    if (rows.length === 0) return CROP_KEYS[Math.floor(this.rng() * CROP_KEYS.length)];
    const total = rows.reduce((a, r) => a + r.count, 0);
    let r = this.rng() * total;
    for (const row of rows) {
      r -= row.count;
      if (r <= 0) return CROP_KEYS[hashStr(row.type) % CROP_KEYS.length];
    }
    return CROP_KEYS[hashStr(rows[rows.length - 1].type) % CROP_KEYS.length];
  }

  // ------------------------------------------------------------------ update

  update(dt: number, hour: number): void {
    this.t += dt;
    const t = this.t;

    // door fade: out -> teleport -> in
    if (this.transition) {
      const tr = this.transition;
      tr.t += dt / 0.3;
      if (tr.t >= 1) {
        if (tr.phase === "out") {
          this.place = tr.toPlace;
          this.player.x = tr.toX;
          this.player.y = tr.toY;
          this.player.target = null;
          this.player.moving = false;
          this.player.dy = 0;
          tr.phase = "in";
          tr.t = 0;
        } else {
          this.transition = null;
        }
      }
    }

    // eased dials
    this.windmillSpeed = lerp(this.windmillSpeed, this.windmillTarget, clamp(dt * 0.8, 0, 1));
    this.weatherBlend = lerp(this.weatherBlend, this.weather === "sunny" ? 0 : 1, clamp(dt * 0.6, 0, 1));

    // villager population drift
    const villagers = this.npcs.filter((n) => n.kind === "villager");
    if (villagers.length < this.targetVillagers) this.spawnVillager();
    else if (villagers.length > this.targetVillagers) {
      const idx = this.npcs.findIndex((n) => n.kind === "villager");
      if (idx >= 0) this.npcs.splice(idx, 1);
    }

    // queue-driven events, animated at a readable pace
    if (t >= this.queueTickAt) {
      this.queueTickAt = t + 0.35;
      if (this.plantQueue > 0) this.drainPlantQueue(false);
      if (this.harvestQueue > 0 && this.crops.length > 0) {
        this.harvestQueue--;
        const idx = Math.floor(this.rng() * this.crops.length);
        const crop = this.crops[idx];
        const plot = this.map.fieldPlots[crop.plot];
        this.crops.splice(idx, 1);
        this.burstSparkles(plot.x, plot.y - 4, CROP_COLORS[crop.color]);
        this.sounds.push("harvest");
        // send the nearest farmer to the harvested spot
        const farmer = this.nearestFarmer(plot.x, plot.y);
        if (farmer && farmer.state !== "work") {
          farmer.state = "walk";
          farmer.tx = plot.x;
          farmer.ty = plot.y + 4;
          farmer.workPlot = crop.plot;
        }
      } else if (this.harvestQueue > 0) {
        this.harvestQueue = 0;
      }
      if (this.splashQueue > 0) {
        this.splashQueue--;
        this.riverSplash();
      }
      if (this.wellQueue > 0) {
        this.wellQueue--;
        this.wellDrops();
      }
    }

    // speech bubbles from live visitor events
    if (this.bubbleQueue.length > 0) {
      const free = villagers.filter((v) => !v.bubble);
      if (free.length > 0) {
        const ev = this.bubbleQueue.shift()!;
        const v = free[Math.floor(this.rng() * free.length)];
        v.bubble = { text: ev.label, until: t + 4 };
        this.sounds.push("bubble");
      } else if (villagers.length === 0) {
        this.bubbleQueue.length = 0;
      }
    }

    if (this.transition) this.player.moving = false;
    else this.updatePlayer(dt);
    this.updateNpcs(dt);
    this.updateChickens(dt);
    this.updateParticles(dt);
    this.updateFlyers(dt, hour);

    // farmhouse chimney smoke
    if (this.serverOk && t >= this.smokeAt) {
      this.smokeAt = t + 0.7 + this.rng() * 0.5;
      this.particles.push({
        kind: "smoke",
        x: 44 + 56 + this.rng() * 3,
        y: 32 + 5,
        vx: 2 + this.rng() * 3,
        vy: -6 - this.rng() * 3,
        age: 0,
        life: 3 + this.rng() * 1.5,
        color: "#cfc9bd",
        size: 1 + this.rng() * 1.5,
      });
    }

    // storm thunder, sparingly
    if (this.weather === "storm" && t >= this.thunderAt) {
      this.thunderAt = t + 18 + this.rng() * 22;
      this.sounds.push("thunder");
    }

    // gentle ambient: fish jumps, falling leaves, fireflies
    if (t >= this.ambientAt) {
      this.ambientAt = t + 0.9;
      if (this.riverState === "flow" && this.rng() < 0.09) {
        this.riverSplash(true);
      }
      if (this.rng() < 0.3 && this.treeSpots.length > 0) {
        const spot = this.treeSpots[Math.floor(this.rng() * this.treeSpots.length)];
        this.particles.push({
          kind: "leaf",
          x: spot.x + this.rng() * 8 - 4,
          y: spot.y,
          vx: 3 + this.rng() * 4,
          vy: 5 + this.rng() * 3,
          age: 0,
          life: 2.5,
          color: this.rng() < 0.5 ? "#57a04b" : "#6fb75d",
          size: 1,
        });
      }
      const night = hour >= 20.5 || hour < 5;
      if (night && this.weather === "sunny" && this.particles.filter((p) => p.kind === "firefly").length < 14) {
        this.particles.push({
          kind: "firefly",
          x: this.rng() * VIEW_W,
          y: VIEW_H * 0.3 + this.rng() * VIEW_H * 0.6,
          vx: (this.rng() - 0.5) * 8,
          vy: (this.rng() - 0.5) * 6,
          age: 0,
          life: 6 + this.rng() * 6,
          color: "#ffe98a",
          size: 1,
        });
      }
    }
  }

  setMoveTarget(x: number, y: number): void {
    this.pendingDoor = null;
    const p = this.player;
    this.particles.push({
      kind: "ping",
      x,
      y,
      vx: 0,
      vy: 0,
      age: 0,
      life: 0.45,
      color: "#fff6c8",
      size: 1,
    });

    // interiors are small and convex enough for a straight walk
    if (this.place !== "world") {
      p.waypoints = [];
      p.target = { x, y };
      return;
    }

    const sx = clamp(Math.floor(p.x / TILE), 0, MAP_W - 1);
    const sy = clamp(Math.floor(p.y / TILE), 0, MAP_H - 1);
    let tx = clamp(Math.floor(x / TILE), 0, MAP_W - 1);
    let ty = clamp(Math.floor(y / TILE), 0, MAP_H - 1);

    // clicked something solid (water, a building base): aim for the nearest
    // walkable tile instead
    if (!this.walkable[ty * MAP_W + tx]) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let r = 1; r <= 3 && !best; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
            if (!this.walkable[ny * MAP_W + nx]) continue;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = { x: nx, y: ny };
            }
          }
        }
      }
      if (best) {
        tx = best.x;
        ty = best.y;
        x = tx * TILE + 8;
        y = ty * TILE + 8;
      }
    }

    const path = this.walkable[sy * MAP_W + sx] ? this.findPath(sx, sy, tx, ty) : null;
    if (!path || path.length === 0) {
      // same tile, or no route: walk straight and let collision handle it
      p.waypoints = [];
      p.target = { x, y };
      return;
    }
    path[path.length - 1] = { x, y }; // land on the exact click point
    const smoothed = this.smoothPath(path);
    p.target = smoothed.shift() ?? { x, y };
    p.waypoints = smoothed;
  }

  // A* over the tile grid, 4-directional
  private findPath(sx: number, sy: number, tx: number, ty: number): Array<{ x: number; y: number }> | null {
    const start = sy * MAP_W + sx;
    const goal = ty * MAP_W + tx;
    if (start === goal) return [];
    const g = new Float32Array(MAP_W * MAP_H).fill(Infinity);
    const f = new Float32Array(MAP_W * MAP_H).fill(Infinity);
    const from = new Int32Array(MAP_W * MAP_H).fill(-1);
    const closed = new Uint8Array(MAP_W * MAP_H);
    const open: number[] = [start];
    const heur = (i: number) => Math.abs((i % MAP_W) - tx) + Math.abs(Math.floor(i / MAP_W) - ty);
    g[start] = 0;
    f[start] = heur(start);
    while (open.length > 0) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) {
        const path: Array<{ x: number; y: number }> = [];
        for (let n = cur; n !== start; n = from[n]) {
          path.push({ x: (n % MAP_W) * TILE + 8, y: Math.floor(n / MAP_W) * TILE + 8 });
        }
        path.reverse();
        return path;
      }
      closed[cur] = 1;
      const cx = cur % MAP_W;
      const cy = Math.floor(cur / MAP_W);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        const ni = ny * MAP_W + nx;
        if (closed[ni] || !this.walkable[ni]) continue;
        const ng = g[cur] + 1;
        if (ng < g[ni]) {
          g[ni] = ng;
          f[ni] = ng + heur(ni);
          from[ni] = cur;
          if (!open.includes(ni)) open.push(ni);
        }
      }
    }
    return null;
  }

  // greedy line-of-sight smoothing: keep only the corners that matter, so
  // the walk cuts diagonals instead of hugging tile centers
  private smoothPath(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    let cur = { x: this.player.x, y: this.player.y };
    let i = 0;
    while (i < pts.length) {
      let j = i;
      for (let k = pts.length - 1; k > i; k--) {
        if (this.clearLine(cur.x, cur.y, pts[k].x, pts[k].y)) {
          j = k;
          break;
        }
      }
      out.push(pts[j]);
      cur = pts[j];
      i = j + 1;
    }
    return out;
  }

  private clearLine(x0: number, y0: number, x1: number, y1: number): boolean {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4);
    for (let i = 1; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      for (const [ox, oy] of FEET) {
        if (isSolidAt(this.map, x + ox, y + oy)) return false;
      }
    }
    return true;
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    const interior = this.place === "world" ? null : this.interiors[this.place];
    let vx = 0;
    let vy = 0;
    // shift sprints; long taps auto-run and slow to a walk on approach
    let speed = ValleySim.PLAYER_SPEED * (this.sprint ? ValleySim.SPRINT_MULT : 1);
    if (this.moveInput.x !== 0 || this.moveInput.y !== 0) {
      const len = Math.hypot(this.moveInput.x, this.moveInput.y);
      vx = (this.moveInput.x / len) * speed;
      vy = (this.moveInput.y / len) * speed;
      p.target = null;
      p.waypoints = [];
      this.pendingDoor = null;
    } else if (p.target) {
      const dx = p.target.x - p.x;
      const dy = p.target.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2.5) {
        p.target = p.waypoints.shift() ?? null;
      } else {
        // auto-run on long walks, slow down for the final approach
        if (dist > 110 || p.waypoints.length > 0) speed = ValleySim.PLAYER_SPEED * ValleySim.SPRINT_MULT;
        vx = (dx / dist) * speed;
        vy = (dy / dist) * speed;
      }
    }
    p.moving = vx !== 0 || vy !== 0;
    p.sprinting = p.moving && speed > ValleySim.PLAYER_SPEED + 1;
    if (!p.moving) return;

    if (p.sprinting && this.rng() < dt * 8) {
      this.particles.push({
        kind: "dirt",
        x: p.x - p.facing * 3 + (this.rng() - 0.5) * 4,
        y: p.y + 1,
        vx: -p.facing * (6 + this.rng() * 6),
        vy: -10 - this.rng() * 8,
        age: 0,
        life: 0.4,
        color: "#b3a17c",
        size: 1,
      });
    }

    // axis-separated movement so the player slides along walls; feet box
    const solid = (x: number, y: number): boolean =>
      interior ? interiorSolidAt(interior, x, y) : isSolidAt(this.map, x, y);
    const tryMove = (nx: number, ny: number): boolean => {
      for (const [ox, oy] of FEET) {
        if (solid(nx + ox, ny + oy)) return false;
      }
      p.x = nx;
      p.y = ny;
      return true;
    };
    const stepX = vx * dt;
    const stepY = vy * dt;
    const movedX = stepX !== 0 && tryMove(p.x + stepX, p.y);
    const movedY = stepY !== 0 && tryMove(p.x, p.y + stepY);
    if (!movedX && !movedY && p.target) {
      p.target = null; // stuck: drop the tap path
      p.waypoints = [];
      this.pendingDoor = null;
    }
    if (Math.abs(vx) > 0.5) p.facing = vx > 0 ? 1 : -1;
    p.dy = Math.hypot(vx, vy) > 0 ? vy / Math.hypot(vx, vy) : 0;
    if (Math.abs(vx) < 0.01) p.dy = vy < 0 ? -1 : 1;

    // door / exit transitions. Entering needs a mostly-upward walk (or a
    // pending door click) so sliding along a building base never swallows
    // the player; leaving needs a mostly-downward walk onto the mat.
    if (!interior) {
      for (const d of this.doors) {
        const tr = d.trigger;
        if (p.x >= tr.x && p.x <= tr.x + tr.w && p.y >= tr.y && p.y <= tr.y + tr.h) {
          if (this.pendingDoor === d.id || p.dy < -0.8) this.enterDoor(d.id);
          break;
        }
      }
    } else {
      const e = interior.exit;
      if (p.dy > 0.8 && p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h) {
        this.exitInterior();
      }
    }
  }

  // walk to a door and enter it (tap/click flow); enters immediately when
  // already standing at the doorstep
  requestEnter(id: string): void {
    if (this.place !== "world" || this.transition) return;
    const d = this.doors.find((dd) => dd.id === id);
    if (!d) return;
    const cx = d.trigger.x + d.trigger.w / 2;
    const cy = d.trigger.y + 4;
    if (Math.hypot(this.player.x - cx, this.player.y - cy) < 22) {
      this.enterDoor(id);
      return;
    }
    this.setMoveTarget(cx, cy);
    this.pendingDoor = id;
  }

  private enterDoor(id: string): void {
    const int = this.interiors[id];
    if (!int || this.transition) return;
    this.pendingDoor = null;
    this.player.target = null;
    this.transition = { phase: "out", t: 0, toPlace: id, toX: int.spawn.x, toY: int.spawn.y };
    this.sounds.push("door");
  }

  private exitInterior(): void {
    if (this.transition) return;
    const door = this.doors.find((d) => d.id === this.place);
    const out = door ? door.outside : { x: 96, y: 146 };
    this.player.target = null;
    this.transition = { phase: "out", t: 0, toPlace: "world", toX: out.x, toY: out.y };
    this.sounds.push("door");
  }

  // 0 = fully visible, 1 = fully black (mid-teleport)
  transitionAlpha(): number {
    if (!this.transition) return 0;
    const t = clamp(this.transition.t, 0, 1);
    return this.transition.phase === "out" ? t : 1 - t;
  }

  private nearestFarmer(x: number, y: number): Npc | null {
    let best: Npc | null = null;
    let bestD = Infinity;
    for (const n of this.npcs) {
      if (n.kind !== "farmer") continue;
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  private updateNpcs(dt: number): void {
    const t = this.t;
    const paused = this.status?.workerPaused === true;
    for (const n of this.npcs) {
      if (n.bubble && n.bubble.until < t) n.bubble = null;

      if (n.kind === "farmer") {
        if (paused) {
          if (n.state !== "sleep") {
            n.state = "sleep";
            n.stateUntil = t + 9999;
          }
          if (this.rng() < dt * 0.6) {
            this.particles.push({
              kind: "zzz",
              x: n.x + 4,
              y: n.y - 14,
              vx: 3,
              vy: -5,
              age: 0,
              life: 1.6,
              color: "#cfd6ff",
              size: 1,
            });
          }
          continue;
        } else if (n.state === "sleep") {
          n.state = "pause";
          n.stateUntil = t + 1;
        }

        if (n.state === "walk") {
          const arrived = this.moveToward(n, dt);
          if (arrived) {
            n.state = n.workPlot >= 0 ? "work" : "pause";
            n.stateUntil = t + (n.state === "work" ? 1.4 : 0.8 + this.rng() * 2.5);
          }
        } else if (t >= n.stateUntil) {
          if (n.state === "work") {
            n.workPlot = -1;
          }
          // busy farmers hop between plots; idle ones drift around the field
          const f = this.map.fieldRect;
          const busy = this.busyLanes > 0;
          if (busy && this.crops.length > 0 && this.rng() < 0.7) {
            const crop = this.crops[Math.floor(this.rng() * this.crops.length)];
            const plot = this.map.fieldPlots[crop.plot];
            n.tx = plot.x;
            n.ty = plot.y + 4;
            n.workPlot = crop.plot;
          } else {
            n.tx = f.x + 20 + this.rng() * (f.w - 40);
            n.ty = f.y + 26 + this.rng() * (f.h - 44);
            n.workPlot = -1;
          }
          n.state = "walk";
        }
        if (n.state === "work" && this.rng() < dt * 4) {
          this.particles.push({
            kind: "dirt",
            x: n.x + (this.rng() - 0.5) * 8,
            y: n.y + 2,
            vx: (this.rng() - 0.5) * 14,
            vy: -14 - this.rng() * 8,
            age: 0,
            life: 0.5,
            color: "#7a5233",
            size: 1,
          });
        }
        continue;
      }

      // villagers stroll the road graph: stay on the centerline, usually
      // continue straight through nodes, never backtrack unless dead-ended
      if (n.state === "walk") {
        const arrived = this.moveToward(n, dt);
        if (arrived) {
          n.state = "pause";
          n.stateUntil = this.rng() < 0.3 ? t + 0.6 + this.rng() * 2.2 : t;
        }
      } else if (t >= n.stateUntil) {
        const edges = this.map.graph.edges[n.node] ?? [];
        if (edges.length > 0) {
          let choices = edges.filter((e) => e !== n.prevNode);
          if (choices.length === 0) choices = edges;
          const next = choices[Math.floor(this.rng() * choices.length)];
          n.prevNode = n.node;
          n.node = next;
          const target = this.map.graph.nodes[next];
          n.tx = target.x;
          n.ty = target.y;
          n.state = "walk";
        } else {
          n.stateUntil = t + 2;
        }
      }
    }
  }

  private moveToward(n: Npc, dt: number): boolean {
    const dx = n.tx - n.x;
    const dy = n.ty - n.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) return true;
    const step = Math.min(dist, n.speed * dt);
    n.x += (dx / dist) * step;
    n.y += (dy / dist) * step;
    if (Math.abs(dx) > 0.5) n.facing = dx > 0 ? 1 : -1;
    n.dy = dy / dist;
    if (Math.abs(dx) < Math.abs(dy) * 0.4) n.dy = dy < 0 ? -1 : 1;
    return false;
  }

  private updateChickens(dt: number): void {
    const t = this.t;
    const p = this.map.penRect;
    for (const ch of this.chickens) {
      if (ch.state === "walk") {
        const dx = ch.tx - ch.x;
        const dy = ch.ty - ch.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1.5) {
          ch.state = this.rng() < 0.5 ? "peck" : "pause";
          ch.stateUntil = t + 0.8 + this.rng() * 1.8;
        } else {
          const step = Math.min(dist, 14 * dt);
          ch.x += (dx / dist) * step;
          ch.y += (dy / dist) * step;
          if (Math.abs(dx) > 0.5) ch.facing = dx > 0 ? 1 : -1;
        }
      } else if (t >= ch.stateUntil) {
        ch.tx = p.x + 6 + this.rng() * (p.w - 12);
        ch.ty = p.y + 6 + this.rng() * (p.h - 12);
        ch.state = "walk";
        if (this.rng() < 0.25) this.sounds.push("cluck");
      }
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.particles.splice(i, 1);
        continue;
      }
      if (p.kind === "firefly") {
        p.vx += (this.rng() - 0.5) * 20 * dt;
        p.vy += (this.rng() - 0.5) * 16 * dt;
        p.vx = clamp(p.vx, -10, 10);
        p.vy = clamp(p.vy, -8, 8);
      }
      if (p.kind === "leaf") {
        p.vx = 3 + Math.sin(p.age * 5) * 5;
      }
      if (p.kind === "dirt" || p.kind === "drop") {
        p.vy += 60 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (this.particles.length > 220) this.particles.splice(0, this.particles.length - 220);
  }

  private updateFlyers(dt: number, hour: number): void {
    const day = hour >= 7 && hour < 19;
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      f.age += dt;
      f.phase += dt * (f.kind === "butterfly" ? 9 : 7);
      if (f.kind === "butterfly") {
        f.vx += (this.rng() - 0.5) * 30 * dt;
        f.vy += (this.rng() - 0.5) * 26 * dt;
        f.vx = clamp(f.vx, -14, 14);
        f.vy = clamp(f.vy, -10, 10);
      }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      const gone = f.x < -20 || f.x > VIEW_W + 20 || f.y < -20 || f.y > VIEW_H + 20 || f.age > 26;
      if (gone) this.flyers.splice(i, 1);
    }
    if (day && this.weather === "sunny") {
      const butterflies = this.flyers.filter((f) => f.kind === "butterfly").length;
      if (butterflies < 3 && this.rng() < dt * 0.25 && this.flowerSpots.length > 0) {
        const spot = this.flowerSpots[Math.floor(this.rng() * this.flowerSpots.length)];
        this.flyers.push({
          kind: "butterfly",
          x: spot.x,
          y: spot.y - 6,
          vx: (this.rng() - 0.5) * 10,
          vy: -4,
          age: 0,
          phase: 0,
        });
      }
      if (this.rng() < dt * 0.03) {
        const fromLeft = this.rng() < 0.5;
        this.flyers.push({
          kind: "bird",
          x: fromLeft ? -12 : VIEW_W + 12,
          y: 20 + this.rng() * 70,
          vx: fromLeft ? 26 + this.rng() * 10 : -26 - this.rng() * 10,
          vy: (this.rng() - 0.5) * 4,
          age: 0,
          phase: this.rng() * 4,
        });
      }
    }
  }

  private burstSparkles(x: number, y: number, color: string): void {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + this.rng();
      this.particles.push({
        kind: "sparkle",
        x,
        y,
        vx: Math.cos(a) * (14 + this.rng() * 10),
        vy: Math.sin(a) * (14 + this.rng() * 10) - 8,
        age: 0,
        life: 0.55,
        color: this.rng() < 0.4 ? "#fff6c8" : color,
        size: 1,
      });
    }
  }

  private riverSplash(quiet = false): void {
    const ty = clamp(3 + this.rng() * 20, 3, 23);
    const cx = this.map.riverCenter(ty) * TILE;
    const y = ty * TILE;
    if (!quiet) this.sounds.push("splash");
    for (let i = 0; i < 5; i++) {
      this.particles.push({
        kind: "drop",
        x: cx + (this.rng() - 0.5) * 8,
        y,
        vx: (this.rng() - 0.5) * 20,
        vy: -26 - this.rng() * 14,
        age: 0,
        life: 0.6,
        color: "#cfe8fa",
        size: 1,
      });
    }
    this.particles.push({
      kind: "splash",
      x: cx,
      y,
      vx: 0,
      vy: 0,
      age: 0,
      life: 0.5,
      color: "#cfe8fa",
      size: 1,
    });
  }

  private wellDrops(): void {
    const well = { x: 188, y: 148 };
    for (let i = 0; i < 4; i++) {
      this.particles.push({
        kind: "drop",
        x: well.x + (this.rng() - 0.5) * 6,
        y: well.y - 2,
        vx: (this.rng() - 0.5) * 16,
        vy: -22 - this.rng() * 10,
        age: 0,
        life: 0.55,
        color: "#9fd0f0",
        size: 1,
      });
    }
    this.burstSparkles(well.x, well.y - 10, "#9fd0f0");
  }

  drainSounds(): SoundEvent[] {
    const out = this.sounds;
    this.sounds = [];
    return out;
  }
}
