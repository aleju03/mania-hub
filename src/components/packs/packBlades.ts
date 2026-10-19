import type { SupporterBladeId } from "#/lib/supporter-pack-style";
import { pick, rand, type BladeFx, type SpriteId } from "./bladeFx";

/* How a pack is opened: the streak the blade leaves while the pointer is held
   (PackStage's trail canvas), what it throws off along the stroke and where it
   crosses the foil, and the burst when the pack gives. Null is the standard
   blade; the rest are a supporter's pick (lib/supporter-pack-style.ts). The
   particles are bladeFx.ts sprites; the recorded sounds (Kenney's CC0 RPG,
   Sci-fi and Impact packs and OpenGameArt CC0 fire and thunder, trimmed and
   layered) are played from packSfx.ts. `scale` shrinks everything for the
   small previews. */

type Rgb = readonly [number, number, number];

interface Stroke {
  rgb: Rgb;
  alpha: number;
  /* Line width at the tail and at the tip; the streak tapers between them. */
  width: readonly [number, number];
}

export interface PackBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BladeLook {
  /* How the WebGL renderer (bladeGl.ts) shades the streak: a plain bright
     blade, two-tone tube light, fire licking off it, or a bolt (with
     `jitter`). The strokes give its colours and widths either way. */
  style?: "neon" | "fire";
  /* How far its light spreads (bloom), 1 for the standard blade. */
  bloom?: number;
  /* Drawn under to over: the widest glow first, the bright core last. */
  strokes: readonly Stroke[];
  /* Pixels a bolt's joints are knocked sideways, fresh every frame: lightning. */
  jitter?: number;
  /* The streak lives a little longer or shorter than the standard one. */
  life?: number;
  tip: { glow: string; core: string; radius: number };
  sprites: readonly SpriteId[];
  /* Thrown off the stroke itself every `trailEvery` px of travel. */
  trailEvery?: number;
  trail?: (fx: BladeFx, x: number, y: number, dx: number, dy: number, scale: number) => void;
  /* Where the blade crosses the foil. */
  cut: (fx: BladeFx, x: number, y: number, scale: number) => void;
  /* The pack giving along the cut (y in px). */
  rip?: (fx: BladeFx, box: PackBox, y: number, scale: number) => void;
  /* How hard the pack shakes as it gives, in px. */
  shake?: number;
  sound?: { cut: string; rip: string };
}

const SOUNDS = "/audio/packs/blades/";

/* Fire cooling as it rises: white-hot, yellow, orange, red, ember. */
const FIRE = ["#fff4cc", "#ffd166", "#ffa12e", "#ff6a14", "#e0400f", "#a8260c", "#5c1408"] as const;

/* Sparks flung up and out from a point. */
function spray(fx: BladeFx, x: number, y: number, scale: number, count: number, opts: { sprite: SpriteId; colors: readonly string[]; speed: [number, number]; size: [number, number]; life: [number, number]; spread?: number; up?: number; gravity?: number; drag?: number; stretch?: number; flicker?: boolean }) {
  for (let i = 0; i < count; i += 1) {
    const angle = -Math.PI / 2 + (opts.up ?? 0) + (Math.random() - 0.5) * (opts.spread ?? 2);
    const speed = rand(...opts.speed) * scale;
    fx.emit({
      sprite: opts.sprite,
      color: pick(opts.colors),
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      gravity: (opts.gravity ?? 0) * scale,
      drag: opts.drag ?? 0,
      size: rand(...opts.size) * scale,
      endSize: rand(...opts.size) * scale * 0.4,
      life: rand(...opts.life),
      stretch: opts.stretch ?? 0,
      flicker: opts.flicker ?? false,
    });
  }
}

const STANDARD: BladeLook = {
  strokes: [
    { rgb: [167, 139, 250], alpha: 0.45, width: [3, 14] },
    { rgb: [255, 255, 255], alpha: 0.9, width: [1, 7.5] },
  ],
  tip: { glow: "rgba(167, 139, 250, 0.4)", core: "rgba(255, 255, 255, 0.95)", radius: 4.5 },
  sprites: ["circle-05"],
  cut: (fx, x, y, scale) => spray(fx, x, y, scale, 3, { sprite: "circle-05", colors: ["#d8d0ff"], speed: [80, 160], size: [6, 12], life: [0.4, 0.6], drag: 2.2, gravity: 120 }),
};

export const BLADE_LOOKS: Record<SupporterBladeId, BladeLook> = {
  /* Steel: a razor line, white-hot streaks off the foil, and one clean
     crescent through the pack with a glint at its end. */
  katana: {
    bloom: 0.9,
    strokes: [
      { rgb: [170, 205, 255], alpha: 0.25, width: [2, 9] },
      { rgb: [255, 255, 255], alpha: 1, width: [0.6, 3.6] },
    ],
    life: 170,
    tip: { glow: "rgba(190, 214, 255, 0.4)", core: "rgba(255, 255, 255, 1)", radius: 3 },
    sprites: ["trace-07", "star-07", "slash-04", "scratch-01", "star-06", "flare-01"],
    cut: (fx, x, y, scale) => {
      spray(fx, x, y, scale, 4, { sprite: "trace-07", colors: ["#ffffff", "#cfe4ff"], speed: [420, 900], size: [14, 22], life: [0.16, 0.28], spread: 2.6, drag: 5, stretch: 0.9 });
      if (Math.random() < 0.35) fx.emit({ sprite: "star-07", color: "#eaf4ff", x, y, size: 34 * scale, endSize: 8 * scale, life: 0.22, rotation: rand(0, Math.PI) });
    },
    rip: (fx, box, y, scale) => {
      const cx = box.left + box.width / 2;
      const w = box.width * 1.9;
      fx.emit({ sprite: "slash-04", color: "#ffffff", x: cx, y: y + 6 * scale, size: w * 0.32, endSize: w * 0.36, aspect: 3.1, life: 0.38, alpha: 1 });
      fx.emit({ sprite: "slash-04", color: "#8fc6ff", x: cx - 10 * scale, y: y + 14 * scale, size: w * 0.3, endSize: w * 0.38, aspect: 3.3, life: 0.5, alpha: 0.55, delay: 0.03 });
      fx.emit({ sprite: "scratch-01", color: "#dbeaff", x: cx + box.width * 0.18, y, size: box.width * 0.5, endSize: box.width * 0.6, life: 0.3, alpha: 0.8, rotation: -0.35 });
      fx.emit({ sprite: "star-06", color: "#ffffff", x: box.left + box.width * 1.05, y: y - 4 * scale, size: 150 * scale, endSize: 30 * scale, life: 0.42, spin: 2.4, delay: 0.06 });
      fx.emit({ sprite: "flare-01", color: "#bfe0ff", x: box.left + box.width * 1.05, y: y - 4 * scale, size: 260 * scale, endSize: 120 * scale, life: 0.35, alpha: 0.9, delay: 0.06 });
      for (let i = 0; i < 18; i += 1) {
        const side = i % 2 ? 1 : -1;
        fx.emit({ sprite: "trace-07", color: pick(["#ffffff", "#d6e9ff", "#a9d2ff"]), x: box.left + rand(0.1, 0.9) * box.width, y: y + rand(-4, 4) * scale, vx: side * rand(500, 1300) * scale, vy: rand(-160, 60) * scale, drag: 4, size: rand(16, 26) * scale, endSize: 6 * scale, life: rand(0.22, 0.4), stretch: 1.1 });
      }
      fx.flash("#dfeeff", 0.16, 0.12);
    },
    shake: 4,
    sound: { cut: `${SOUNDS}katana-cut.mp3`, rip: `${SOUNDS}katana-rip.mp3` },
  },
  /* Sign tubes: pink in a cyan haze and light left hanging in the air. When
     the pack gives, the cut is a tube of its own that shorts: it stutters
     on the way a sign does, crackles along its length, and breaks, its glass
     falling away still lit. */
  neon: {
    style: "neon",
    bloom: 1.25,
    strokes: [
      { rgb: [40, 225, 255], alpha: 0.32, width: [6, 22] },
      { rgb: [255, 64, 200], alpha: 0.62, width: [3, 11] },
      { rgb: [255, 236, 250], alpha: 0.95, width: [1, 4.5] },
    ],
    life: 260,
    tip: { glow: "rgba(255, 64, 200, 0.5)", core: "rgba(255, 236, 250, 1)", radius: 5 },
    sprites: ["circle-05", "flare-01", "trace-07", "spark-07"],
    trailEvery: 22,
    trail: (fx, x, y, _dx, _dy, scale) => {
      fx.emit({ sprite: "circle-05", color: pick(["#ff4fd8", "#3ef0ff"]), x: x + rand(-6, 6) * scale, y: y + rand(-6, 6) * scale, vy: rand(-30, 30) * scale, vx: rand(-30, 30) * scale, size: rand(7, 12) * scale, endSize: 2 * scale, life: rand(0.5, 0.8), flicker: Math.random() < 0.3 });
    },
    cut: (fx, x, y, scale) => {
      spray(fx, x, y, scale, 3, { sprite: "flare-01", colors: ["#ff4fd8", "#3ef0ff"], speed: [160, 360], size: [30, 46], life: [0.35, 0.55], drag: 3, gravity: 60 });
    },
    rip: (fx, box, y, scale) => {
      // The tube is a row of short lit lengths, each trace-07 (a soft upright
      // bar) turned on its side and overlapping the next, so it reads as one
      // tube and can break into its own pieces.
      const pieces = 16;
      const span = box.width * 1.15;
      const left = box.left + (box.width - span) / 2;
      const step = span / pieces;
      const lit = (x: number, delay: number, life: number, flicker: boolean) => {
        fx.emit({ sprite: "trace-07", color: "#36e8ff", x, y, size: step * 3.4, aspect: (120 * scale) / (step * 3.4), rotation: Math.PI / 2, life, alpha: 0.1, flicker, delay });
        fx.emit({ sprite: "trace-07", color: "#ff3fc8", x, y, size: step * 3.2, aspect: (44 * scale) / (step * 3.2), rotation: Math.PI / 2, life, alpha: 0.5, flicker, delay });
      };
      for (let i = 0; i < pieces; i += 1) {
        const x = left + step * (i + 0.5);
        // on, off, on, off, then it holds until it breaks
        lit(x, 0, 0.05, false);
        lit(x, 0.1, 0.04, true);
        lit(x, 0.19, 0.36, Math.random() < 0.25);
        // and breaks: each length falls and turns, still lit
        fx.emit({
          sprite: "trace-07",
          color: pick(["#ff3fc8", "#ff3fc8", "#ff7be0", "#36e8ff"]),
          x: x + rand(-3, 3) * scale,
          y,
          vx: ((x - box.left) / box.width - 0.5) * rand(160, 420) * scale,
          vy: rand(-220, -60) * scale,
          gravity: 1500 * scale,
          drag: 0.4,
          size: step * rand(1.4, 2.2),
          endSize: step * 1.1,
          aspect: (34 * scale) / step,
          rotation: Math.PI / 2 + rand(-0.2, 0.2),
          spin: rand(-12, 12),
          life: rand(0.55, 0.8),
          alpha: 0.85,
          flicker: Math.random() < 0.3,
          delay: 0.52 + rand(0, 0.05),
        });
      }
      // it crackles along its length while it holds
      for (let i = 0; i < 6; i += 1) {
        fx.emit({ sprite: "spark-07", color: pick(["#ffb8ef", "#a8f6ff"]), x: box.left + rand(0.05, 0.95) * box.width, y: y + rand(-3, 3) * scale, size: rand(22, 34) * scale, aspect: rand(2.2, 3.4), rotation: rand(-0.15, 0.15), life: rand(0.06, 0.12), alpha: 0.7, flicker: true, delay: 0.19 + rand(0, 0.3) });
      }
      fx.flash("#ff3fc8", 0.05, 0.08);
    },
    shake: 3,
    sound: { cut: `${SOUNDS}neon-cut.mp3`, rip: `${SOUNDS}neon-rip.mp3` },
  },
  /* Fire: the stroke burns as it goes, and the pack catches along the cut.
     Built the way fire is in games: many small soft puffs, each cooling
     from white-yellow through orange to a dim red as it rises and sways,
     added together until they read as one body of flame. */
  ember: {
    style: "fire",
    bloom: 1.1,
    strokes: [
      { rgb: [255, 70, 20], alpha: 0.42, width: [4, 18] },
      { rgb: [255, 150, 40], alpha: 0.6, width: [2, 9] },
      { rgb: [255, 236, 170], alpha: 0.95, width: [1, 5] },
    ],
    life: 300,
    tip: { glow: "rgba(255, 110, 30, 0.5)", core: "rgba(255, 240, 190, 1)", radius: 5 },
    sprites: ["circle-05", "fire-01", "smoke-04"],
    trailEvery: 5,
    trail: (fx, x, y, _dx, _dy, scale) => {
      // Born already orange and a little above the blade: the streak itself
      // is the hot part, these are the flames it throws up.
      fx.emit({ sprite: "fire-01", color: FIRE[2], ramp: FIRE.slice(2), x: x + rand(-8, 8) * scale, y: y - rand(4, 12) * scale, vx: rand(-15, 15) * scale, vy: rand(-110, -50) * scale, gravity: -80 * scale, wobble: 30 * scale, size: rand(22, 40) * scale, endSize: rand(46, 76) * scale, life: rand(0.3, 0.55), alpha: 0.12, fadeIn: 0.06, rotation: rand(0, 6.28), spin: rand(-2, 2) });
    },
    cut: (fx, x, y, scale) => {
      spray(fx, x, y, scale, 4, { sprite: "circle-05", colors: ["#ffd76b", "#ff9a2e", "#ff5a1f"], speed: [60, 200], size: [5, 10], life: [0.7, 1.2], spread: 1.6, gravity: -90, drag: 1.2, flicker: true });
    },
    rip: (fx, box, y, scale) => {
      const cx = box.left + box.width / 2;
      // the body of the fire: puffs released along the cut over half a
      // second, outward from the middle, so it catches and spreads
      for (let i = 0; i < 230; i += 1) {
        const u = rand(0, 1);
        const delay = Math.abs(u - 0.5) * 0.28 + rand(0, 0.45);
        fx.emit({
          sprite: Math.random() < 0.7 ? "fire-01" : "circle-05",
          color: FIRE[0],
          ramp: FIRE,
          x: box.left + u * box.width,
          y: y + rand(-4, 6) * scale,
          vx: rand(-25, 25) * scale,
          vy: rand(-170, -80) * scale,
          gravity: -110 * scale,
          drag: 0.6,
          wobble: rand(20, 55) * scale,
          size: rand(28, 46) * scale,
          endSize: rand(60, 90) * scale,
          life: rand(0.45, 0.8),
          alpha: 0.14,
          rotation: rand(0, 6.28),
          spin: rand(-2, 2),
          fadeIn: 0.05,
          delay,
        });
      }
      // smoke drifting off above the flames
      for (let i = 0; i < 5; i += 1) {
        fx.emit({ sprite: "smoke-04", color: "#2a1d18", x: cx + rand(-0.4, 0.4) * box.width, y: y - 80 * scale, vy: rand(-60, -30) * scale, vx: rand(-15, 15) * scale, size: box.width * 0.3, endSize: box.width * 0.7, life: rand(1.1, 1.5), alpha: 0.18, fadeIn: 0.4, normal: true, spin: rand(-0.4, 0.4), delay: 0.3 + rand(0, 0.2) });
      }
      for (let i = 0; i < 24; i += 1) {
        fx.emit({ sprite: "circle-05", color: pick(["#ffe08a", "#ffb347", "#ff7a1f"]), x: box.left + rand(0, 1) * box.width, y, vx: rand(-110, 110) * scale, vy: rand(-360, -140) * scale, gravity: -30 * scale, drag: 1.3, wobble: 40 * scale, size: rand(3, 6) * scale, endSize: 1 * scale, life: rand(0.9, 1.6), alpha: 0.8, flicker: true, delay: rand(0.05, 0.5) });
      }
      fx.flash("#ff7a2a", 0.1, 0.35);
    },
    shake: 3,
    sound: { cut: `${SOUNDS}ember-cut.mp3`, rip: `${SOUNDS}ember-rip.mp3` },
  },
  /* A storm: the stroke is a bolt that crackles, and when the pack gives,
     lightning comes down on the cut. */
  lightning: {
    bloom: 1.4,
    strokes: [
      { rgb: [90, 150, 255], alpha: 0.2, width: [12, 24] },
      { rgb: [110, 180, 255], alpha: 0.5, width: [5, 9] },
      { rgb: [236, 248, 255], alpha: 1, width: [1.4, 3] },
    ],
    jitter: 11,
    life: 200,
    tip: { glow: "rgba(130, 200, 255, 0.55)", core: "rgba(240, 250, 255, 1)", radius: 4 },
    sprites: ["spark-01", "flare-01", "spark-05", "spark-06", "spark-07", "star-06"],
    trailEvery: 40,
    trail: (fx, x, y, _dx, _dy, scale) => {
      if (Math.random() < 0.6) fx.emit({ sprite: "spark-01", color: "#9fd4ff", x, y, size: rand(46, 70) * scale, life: 0.14, rotation: rand(0, Math.PI * 2), flicker: true });
    },
    cut: (fx, x, y, scale) => {
      spray(fx, x, y, scale, 3, { sprite: "flare-01", colors: ["#c6ecff", "#ffffff"], speed: [200, 480], size: [24, 36], life: [0.12, 0.22], drag: 6, flicker: true });
    },
    rip: (fx, box, y, scale) => {
      for (let i = 0; i < 3; i += 1) {
        const x = box.left + (0.2 + 0.3 * i + rand(-0.06, 0.06)) * box.width;
        const tall = y + 40 * scale;
        fx.emit({ sprite: pick(["spark-05", "spark-06"] as const), color: "#e6f6ff", x, y: tall / 2, size: tall, aspect: 0.45, life: 0.32, flicker: true, delay: i * 0.05 });
        fx.emit({ sprite: pick(["spark-05", "spark-06"] as const), color: "#5aa8ff", x: x + 6 * scale, y: tall / 2, size: tall, aspect: 0.7, life: 0.38, alpha: 0.6, flicker: true, delay: i * 0.05 });
        fx.emit({ sprite: "star-06", color: "#cfeaff", x, y, size: 150 * scale, endSize: 40 * scale, life: 0.3, delay: i * 0.05 });
      }
      fx.emit({ sprite: "spark-07", color: "#bfe6ff", x: box.left + box.width / 2, y, size: box.width * 0.5, aspect: 3, life: 0.35, flicker: true });
      for (let i = 0; i < 7; i += 1) {
        fx.emit({ sprite: "spark-01", color: "#9fd4ff", x: box.left + rand(0, 1) * box.width, y: y + rand(-14, 14) * scale, size: rand(70, 120) * scale, life: rand(0.18, 0.3), rotation: rand(0, Math.PI * 2), flicker: true, delay: rand(0, 0.2) });
      }
      fx.flash("#dff2ff", 0.45, 0.32, true);
    },
    shake: 7,
    sound: { cut: `${SOUNDS}lightning-cut.mp3`, rip: `${SOUNDS}lightning-rip.mp3` },
  },
};

export function bladeLook(blade: SupporterBladeId | null): BladeLook {
  return blade ? BLADE_LOOKS[blade] : STANDARD;
}

export const STANDARD_TRAIL_LIFE_MS = 220;

export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

type Point = { x: number; y: number };

/* One stroke of the streak as a single filled ribbon that tapers from tail to
   tip, so it never shows the beads that overlapping segment caps leave. Its
   fade runs along it as a gradient. */
function fillRibbon(
  ctx: CanvasRenderingContext2D,
  path: readonly Point[],
  width: (i: number) => number,
  alpha: (i: number) => number,
  rgb: Rgb,
) {
  const n = path.length;
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const half = width(i) / 2;
    left.push({ x: path[i].x - (dy / length) * half, y: path[i].y + (dx / length) * half });
    right.push({ x: path[i].x + (dy / length) * half, y: path[i].y - (dx / length) * half });
  }
  const [r, g, b] = rgb;
  const gradient = ctx.createLinearGradient(path[0].x, path[0].y, path[n - 1].x, path[n - 1].y);
  const stops = Math.min(n, 8);
  for (let k = 0; k < stops; k += 1) {
    const i = Math.round((k / (stops - 1)) * (n - 1));
    gradient.addColorStop(k / (stops - 1), `rgba(${r}, ${g}, ${b}, ${Math.max(0, alpha(i)).toFixed(3)})`);
  }
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n; i += 1) ctx.lineTo(left[i].x, left[i].y);
  // round the tip
  const tip = path[n - 1];
  const tail = path[n - 2];
  const heading = Math.atan2(tip.y - tail.y, tip.x - tail.x);
  ctx.arc(tip.x, tip.y, width(n - 1) / 2, heading - Math.PI / 2, heading + Math.PI / 2);
  for (let i = n - 1; i >= 0; i -= 1) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

/* A bolt along the stroke: a few straight legs between kinked joints, and a
   fork or two off it, all re-thrown every frame so it crackles. */
export function bolt(path: readonly Point[], kick: number): { main: Point[]; forks: Point[][] } {
  const main: Point[] = [path[0]];
  let travelled = 0;
  for (let i = 1; i < path.length; i += 1) {
    travelled += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (travelled < 16 && i < path.length - 1) continue;
    travelled = 0;
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const k = i === path.length - 1 ? 0 : (Math.random() - 0.5) * 2 * kick;
    main.push({ x: b.x - ((b.y - a.y) / length) * k, y: b.y + ((b.x - a.x) / length) * k });
  }
  const forks: Point[][] = [];
  if (main.length > 3) {
    const count = Math.random() < 0.5 ? 1 : 2;
    for (let f = 0; f < count; f += 1) {
      const from = main[1 + Math.floor(Math.random() * (main.length - 2))];
      const angle = Math.random() * Math.PI * 2;
      const fork: Point[] = [from];
      let at = from;
      for (let leg = 0; leg < 3; leg += 1) {
        const turn = angle + (Math.random() - 0.5) * 1.2;
        at = { x: at.x + Math.cos(turn) * kick * 1.6, y: at.y + Math.sin(turn) * kick * 1.6 };
        fork.push(at);
      }
      forks.push(fork);
    }
  }
  return { main, forks };
}

function strokePolyline(ctx: CanvasRenderingContext2D, line: readonly Point[]) {
  ctx.beginPath();
  ctx.moveTo(line[0].x, line[0].y);
  for (let i = 1; i < line.length; i += 1) ctx.lineTo(line[i].x, line[i].y);
  ctx.stroke();
}

/* Draws the streak over points that are still alive (oldest first), and the
   blade's tip when the pointer is held. The caller clears the canvas. `scale`
   thins it for a small preview box. */
export function drawBladeTrail(
  ctx: CanvasRenderingContext2D,
  look: BladeLook,
  points: readonly TrailPoint[],
  now: number,
  tip: { x: number; y: number } | null,
  scale = 1,
): void {
  const life = look.life ?? STANDARD_TRAIL_LIFE_MS;
  if (points.length >= 2) {
    const n = points.length;
    const fade = (i: number) => (i / (n - 1)) * Math.max(0, 1 - (now - points[i].t) / life);
    if (look.jitter) {
      // A bolt keeps its weight end to end and flickers as a whole.
      const { main, forks } = bolt(points, look.jitter * scale);
      const flicker = 0.7 + Math.random() * 0.3;
      const head = fade(n - 1);
      ctx.lineCap = "round";
      ctx.lineJoin = "miter";
      for (const stroke of look.strokes) {
        const [r, g, b] = stroke.rgb;
        const gradient = ctx.createLinearGradient(main[0].x, main[0].y, main[main.length - 1].x, main[main.length - 1].y);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
        gradient.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${(stroke.alpha * 0.6 * flicker * head).toFixed(3)})`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${(stroke.alpha * flicker * head).toFixed(3)})`);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = stroke.width[1] * scale;
        strokePolyline(ctx, main);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(stroke.alpha * 0.55 * flicker * head).toFixed(3)})`;
        ctx.lineWidth = stroke.width[1] * 0.5 * scale;
        for (const fork of forks) strokePolyline(ctx, fork);
      }
    } else {
      for (const stroke of look.strokes) {
        fillRibbon(
          ctx,
          points,
          (i) => (stroke.width[0] + (stroke.width[1] - stroke.width[0]) * (i / (n - 1))) * scale,
          (i) => fade(i) * stroke.alpha,
          stroke.rgb,
        );
      }
    }
  }
  if (tip) {
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, look.tip.radius * scale, 0, Math.PI * 2);
    ctx.fillStyle = look.tip.glow;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, look.tip.radius * 0.48 * scale, 0, Math.PI * 2);
    ctx.fillStyle = look.tip.core;
    ctx.fill();
  }
}

export function bladeTrailLife(look: BladeLook): number {
  return look.life ?? STANDARD_TRAIL_LIFE_MS;
}
