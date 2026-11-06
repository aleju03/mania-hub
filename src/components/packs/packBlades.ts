import type { SupporterBladeId } from "#/lib/supporter-pack-style";
import { pick, rand, type BladeFx, type SpriteId } from "./bladeFx";

/* How a pack is opened: the streak the blade leaves while the pointer is held
   (PackStage's trail canvas), what it throws off along the stroke and where it
   crosses the foil, and the burst when the pack gives. Null is the standard
   blade; the rest are a supporter's pick (lib/supporter-pack-style.ts). The
   particles are bladeFx.ts sprites; the recorded sounds (CC0, sources in
   public/audio/packs/blades/README.md) are played from packSfx.ts. `scale`
   shrinks everything for the small previews. */

type Rgb = readonly [number, number, number];

interface Stroke {
  rgb: Rgb;
  alpha: number;
  /* Line width at the tail and at the tip; the streak tapers between them. */
  width: readonly [number, number];
}

/* A point on the cut the player made, `t` from where it entered the pack (0)
   to where it left (1); a straight line at the burst's height when the
   stroke was not seen. */
export type CutPath = (t: number) => { x: number; y: number };

/* The cut as a CutPath: along the stroke's points by distance, or straight
   across the box at `y` without them. */
export function cutPath(box: PackBox, y: number, points?: readonly Point[]): CutPath {
  if (!points || points.length < 2) return (t) => ({ x: box.left + t * box.width, y });
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = lengths[lengths.length - 1] || 1;
  return (t) => {
    const want = Math.min(1, Math.max(0, t)) * total;
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < want) i += 1;
    const span = lengths[i] - lengths[i - 1] || 1;
    const k = (want - lengths[i - 1]) / span;
    return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * k, y: points[i - 1].y + (points[i].y - points[i - 1].y) * k };
  };
}

export interface PackBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BladeLook {
  /* How the WebGL renderer (bladeGl.ts) shades the streak: a plain bright
     blade, ice with glints, fire licking off it, a bolt (with `jitter`),
     streaks of wind, or a dark body (void, ink) laid over normally with its
     light at the edge. The strokes give its colours and widths either way. */
  style?: "frost" | "fire" | "gale" | "void" | "ink" | "rainbow";
  /* Thin at both ends and full in the middle, like a brush stroke (ink). */
  brush?: boolean;
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
  rip?: (fx: BladeFx, box: PackBox, y: number, scale: number, at: CutPath) => void;
  /* How hard the pack shakes as it gives, in px. */
  shake?: number;
  /* `loop`: a sound that runs the whole time the blade moves, its level
     following the speed (ink's brush on paper). */
  sound?: BladeSound;
}

export interface BladeSound {
  cut: string;
  rip: string;
  loop?: string;
}

const SOUNDS = "/audio/packs/blades/";

/* Fire cooling as it rises: white-hot, yellow, orange, red, ember. */
const FIRE = ["#fff4cc", "#ffd166", "#ffa12e", "#ff6a14", "#e0400f", "#a8260c", "#5c1408"] as const;

/* A leaf on the wind (gale): the flame sprite in leaf colours, laid over
   normally, spinning and swaying as it goes. vx, vy in px/s before scale. */
function leaf(fx: BladeFx, x: number, y: number, scale: number, delay: number, vx: number, vy: number, life = rand(1.1, 1.7)) {
  fx.emit({ sprite: "flame-05", color: pick(["#9be37a", "#e9c46a", "#f4a261", "#cfe8a9"]), normal: true, x, y, vx: vx * scale, vy: vy * scale, gravity: 140 * scale, drag: 0.7, wobble: rand(20, 40) * scale, size: rand(12, 20) * scale, endSize: rand(10, 16) * scale, rotation: rand(0, Math.PI * 2), spin: rand(-10, 10), life, alpha: 0.95, delay });
}

/* A drop of ink flung off the brush (ink): pale, now and then a red one. */
function inkDrop(fx: BladeFx, x: number, y: number, scale: number, vx: number, vy: number, size: number, delay: number, red: boolean) {
  const spec = { x, y, vx: vx * scale, vy: vy * scale, gravity: 700 * scale, drag: 0.6, life: rand(0.6, 0.9), delay };
  fx.emit({ ...spec, sprite: "dot-01", color: red ? "#d6453d" : "#f0e4ce", normal: true, size: size * scale, endSize: size * 0.8 * scale, alpha: 1 });
}

/* The rainbow's colours, red to violet. */
const RAINBOW = ["#ff3b3b", "#ff9a1f", "#ffe23b", "#3bd16f", "#3b9bff", "#a35bff"] as const;

/* A particle's colours over its life for star power: the rainbow `laps`
   times round, starting anywhere in it, so sparks flash through the colours. */
function cycle(laps = 1, start = Math.floor(Math.random() * RAINBOW.length)): string[] {
  const out: string[] = [];
  for (let i = 0; i <= RAINBOW.length * laps; i += 1) out.push(RAINBOW[(start + i) % RAINBOW.length]);
  return out;
}

/* Ember's easter egg (PackStage): the blade held still on the pack long
   enough sets it alight, and a burn front spreads out over it from that spot
   (emberBurnOverlay.ts draws the char and the glowing line). One frame of the
   fire: tongues of flame licking up off the front (`front`, its radius in px
   around `origin`), only where it crosses the pack, smoke rising off it now
   and then, and embers still glowing in what has burnt. Once the front has
   passed the whole pack (`front` null) only a low smoulder is left. */
export function emberBurn(fx: BladeFx, box: PackBox, origin: { x: number; y: number }, front: number | null, scale: number) {
  const inside = (x: number, y: number) => x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;
  const flame = (x: number, y: number, big: number) =>
    fx.emit({ sprite: "fire-01", color: FIRE[1], ramp: FIRE.slice(1), x, y, vx: rand(-12, 12) * scale, vy: rand(-240, -140) * scale * big, gravity: -120 * scale, drag: 0.5, wobble: rand(20, 45) * scale, size: rand(20, 30) * scale * big, endSize: rand(52, 80) * scale * big, life: rand(0.45, 0.75), alpha: 0.3, rotation: rand(0, 6.28), spin: rand(-2.5, 2.5), fadeIn: 0.04 });
  if (front !== null) {
    // the front's length inside the pack sets how much fire there is
    for (let i = 0; i < 32; i += 1) {
      const a = rand(0, Math.PI * 2);
      const r = front * rand(0.9, 1.06);
      const x = origin.x + Math.cos(a) * r;
      const y = origin.y + Math.sin(a) * r;
      if (!inside(x, y)) continue;
      flame(x, y, 1);
      if (Math.random() < 0.05) fx.emit({ sprite: "smoke-04", color: "#2a1d18", normal: true, x, y: y - 30 * scale, vx: rand(-10, 10) * scale, vy: rand(-70, -40) * scale, size: 30 * scale, endSize: 90 * scale, life: rand(1, 1.4), alpha: 0.16, fadeIn: 0.3, rotation: rand(0, 6.28), spin: rand(-0.4, 0.4) });
    }
  } else if (Math.random() < 0.35) {
    // burnt through: a low flame here and there
    const x = box.left + rand(0.08, 0.92) * box.width;
    const y = box.top + rand(0.1, 0.95) * box.height;
    flame(x, y, 0.6);
  }
  // embers glowing in what has burnt
  if (Math.random() < 0.25) {
    const reach = front ?? Math.hypot(box.width, box.height);
    const a = rand(0, Math.PI * 2);
    const r = Math.sqrt(Math.random()) * reach;
    const x = origin.x + Math.cos(a) * r;
    const y = origin.y + Math.sin(a) * r;
    if (inside(x, y)) fx.emit({ sprite: "circle-05", color: pick(["#ffe08a", "#ffb347", "#ff7a1f"]), x, y, vx: rand(-40, 40) * scale, vy: rand(-200, -90) * scale, gravity: -30 * scale, drag: 1.3, size: rand(3, 5) * scale, endSize: 1 * scale, life: rand(0.8, 1.3), alpha: 0.85, flicker: true });
  }
}

/* The cut's angle, from where it entered the pack to where it left, kept
   within a quarter turn of level so a curved sprite never draws upside down. */
function cutAngle(at: CutPath): number {
  const a = at(0);
  const b = at(1);
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return angle;
}

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
    rip: (fx, box, _y, scale, at) => {
      // the crescent and its glint lie along the cut you made
      const angle = cutAngle(at);
      const mid = at(0.5);
      const out = at(1);
      const w = box.width * 1.9;
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      fx.emit({ sprite: "slash-04", color: "#ffffff", x: mid.x + nx * 6 * scale, y: mid.y + ny * 6 * scale, size: w * 0.32, endSize: w * 0.36, aspect: 3.1, rotation: angle, life: 0.38, alpha: 1 });
      fx.emit({ sprite: "slash-04", color: "#8fc6ff", x: mid.x + nx * 14 * scale, y: mid.y + ny * 14 * scale, size: w * 0.3, endSize: w * 0.38, aspect: 3.3, rotation: angle, life: 0.5, alpha: 0.55, delay: 0.03 });
      const scratch = at(0.68);
      fx.emit({ sprite: "scratch-01", color: "#dbeaff", x: scratch.x, y: scratch.y, size: box.width * 0.5, endSize: box.width * 0.6, life: 0.3, alpha: 0.8, rotation: angle - 0.35 });
      fx.emit({ sprite: "star-06", color: "#ffffff", x: out.x, y: out.y, size: 150 * scale, endSize: 30 * scale, life: 0.42, spin: 2.4, delay: 0.06 });
      fx.emit({ sprite: "flare-01", color: "#bfe0ff", x: out.x, y: out.y, size: 260 * scale, endSize: 120 * scale, life: 0.35, alpha: 0.9, delay: 0.06 });
      for (let i = 0; i < 18; i += 1) {
        const side = i % 2 ? 1 : -1;
        const p = at(rand(0.1, 0.9));
        const speed = rand(500, 1300) * scale;
        fx.emit({ sprite: "trace-07", color: pick(["#ffffff", "#d6e9ff", "#a9d2ff"]), x: p.x, y: p.y + rand(-4, 4) * scale, vx: side * Math.cos(angle) * speed, vy: side * Math.sin(angle) * speed + rand(-160, 60) * scale, drag: 4, size: rand(16, 26) * scale, endSize: 6 * scale, life: rand(0.22, 0.4), stretch: 1.1 });
      }
      fx.flash("#dfeeff", 0.16, 0.12);
    },
    shake: 4,
    sound: { cut: `${SOUNDS}katana-cut.mp3`, rip: `${SOUNDS}katana-rip.mp3` },
  },
  /* Frost: an icy edge that leaves frost along the stroke and chips ice
     off the foil. When the pack gives, frost grows out over it from the cut
     (crystals blooming along the stroke you made), it cracks, and it
     shatters, the shards falling away. */
  frost: {
    style: "frost",
    bloom: 1.15,
    strokes: [
      { rgb: [70, 180, 255], alpha: 0.4, width: [6, 24] },
      { rgb: [170, 228, 255], alpha: 0.8, width: [3, 11] },
      { rgb: [255, 255, 255], alpha: 1, width: [1.2, 4.5] },
    ],
    life: 240,
    tip: { glow: "rgba(140, 220, 255, 0.5)", core: "rgba(255, 255, 255, 1)", radius: 4.5 },
    sprites: ["star-07", "trace-07", "circle-05", "spark-06"],
    trailEvery: 22,
    trail: (fx, x, y, _dx, _dy, scale) => {
      fx.emit({ sprite: "star-07", color: pick(["#ffffff", "#dff6ff", "#bfe9ff"]), x: x + rand(-5, 5) * scale, y: y + rand(-4, 4) * scale, vy: rand(4, 18) * scale, size: rand(7, 12) * scale, endSize: 2 * scale, rotation: rand(0, Math.PI), spin: rand(-2, 2), life: rand(0.6, 0.95), alpha: 0.85 });
    },
    cut: (fx, x, y, scale) => {
      for (let i = 0; i < 6; i += 1) {
        fx.emit({ sprite: "trace-07", color: pick(["#ffffff", "#d6f2ff", "#a8ddff"]), x, y, vx: rand(-260, 260) * scale, vy: rand(-320, -60) * scale, gravity: 900 * scale, drag: 1, size: rand(10, 16) * scale, endSize: 6 * scale, aspect: 0.35, rotation: rand(0, Math.PI), spin: rand(-10, 10), life: rand(0.35, 0.55) });
      }
      if (Math.random() < 0.4) fx.emit({ sprite: "star-07", color: "#eaf8ff", x, y, size: 30 * scale, endSize: 8 * scale, life: 0.2, rotation: rand(0, Math.PI) });
    },
    rip: (fx, _box, _y, scale, at) => {
      // frost blooming out along the cut, end to end
      for (let i = 0; i < 26; i += 1) {
        const t = i / 25;
        const p = at(t);
        fx.emit({ sprite: "star-07", color: pick(["#ffffff", "#e6f8ff", "#c4ecff"]), x: p.x + rand(-6, 6) * scale, y: p.y + rand(-16, 16) * scale, size: 3 * scale, endSize: rand(18, 30) * scale, rotation: rand(0, Math.PI), spin: rand(-1, 1), life: rand(0.45, 0.6), alpha: 0.9, delay: t * 0.12 });
      }
      // short cracks off it
      for (let i = 0; i < 7; i += 1) {
        const p = at(rand(0.1, 0.9));
        fx.emit({ sprite: "spark-06", color: "#f0fbff", x: p.x, y: p.y + rand(-6, 6) * scale, size: rand(22, 34) * scale, endSize: rand(26, 38) * scale, aspect: 0.3, rotation: rand(-1.2, 1.2), life: 0.35, alpha: 0.8, delay: rand(0.1, 0.16) });
      }
      // and it shatters: shards falling away from all along the cut
      for (let i = 0; i < 30; i += 1) {
        const p = at(rand(0, 1));
        fx.emit({ sprite: "trace-07", color: "#ffffff", ramp: ["#ffffff", "#d6f2ff", "#8fcfff", "#5aa8e6"], x: p.x, y: p.y + rand(-8, 8) * scale, vx: rand(-240, 240) * scale, vy: rand(-300, -40) * scale, gravity: 1100 * scale, drag: 0.6, size: rand(14, 26) * scale, endSize: 10 * scale, aspect: 0.32, rotation: rand(0, Math.PI), spin: rand(-12, 12), life: rand(0.7, 1.1), delay: rand(0.17, 0.24) });
      }
      fx.flash("#cfefff", 0.12, 0.12);
    },
    shake: 4,
    sound: { cut: `${SOUNDS}frost-cut.mp3`, rip: `${SOUNDS}frost-rip.mp3` },
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
    rip: (fx, box, _y, scale, at) => {
      const mid = at(0.5);
      // the body of the fire: puffs released along the cut over half a
      // second, outward from the middle, so it catches and spreads
      for (let i = 0; i < 230; i += 1) {
        const u = rand(0, 1);
        const delay = Math.abs(u - 0.5) * 0.28 + rand(0, 0.45);
        const p = at(u);
        fx.emit({
          sprite: Math.random() < 0.7 ? "fire-01" : "circle-05",
          color: FIRE[0],
          ramp: FIRE,
          x: p.x,
          y: p.y + rand(-4, 6) * scale,
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
        fx.emit({ sprite: "smoke-04", color: "#2a1d18", x: mid.x + rand(-0.4, 0.4) * box.width, y: mid.y - 80 * scale, vy: rand(-60, -30) * scale, vx: rand(-15, 15) * scale, size: box.width * 0.3, endSize: box.width * 0.7, life: rand(1.1, 1.5), alpha: 0.18, fadeIn: 0.4, normal: true, spin: rand(-0.4, 0.4), delay: 0.3 + rand(0, 0.2) });
      }
      for (let i = 0; i < 24; i += 1) {
        const ember = at(rand(0, 1));
        fx.emit({ sprite: "circle-05", color: pick(["#ffe08a", "#ffb347", "#ff7a1f"]), x: ember.x, y: ember.y, vx: rand(-110, 110) * scale, vy: rand(-360, -140) * scale, gravity: -30 * scale, drag: 1.3, wobble: 40 * scale, size: rand(3, 6) * scale, endSize: 1 * scale, life: rand(0.9, 1.6), alpha: 0.8, flicker: true, delay: rand(0.05, 0.5) });
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
    rip: (fx, box, _y, scale, at) => {
      // three bolts striking down onto points along the cut you made
      for (let i = 0; i < 3; i += 1) {
        const p = at(0.2 + 0.3 * i + rand(-0.06, 0.06));
        const tall = p.y + 40 * scale;
        fx.emit({ sprite: pick(["spark-05", "spark-06"] as const), color: "#e6f6ff", x: p.x, y: tall / 2, size: tall, aspect: 0.45, life: 0.32, flicker: true, delay: i * 0.05 });
        fx.emit({ sprite: pick(["spark-05", "spark-06"] as const), color: "#5aa8ff", x: p.x + 6 * scale, y: tall / 2, size: tall, aspect: 0.7, life: 0.38, alpha: 0.6, flicker: true, delay: i * 0.05 });
        fx.emit({ sprite: "star-06", color: "#cfeaff", x: p.x, y: p.y, size: 150 * scale, endSize: 40 * scale, life: 0.3, delay: i * 0.05 });
      }
      const mid = at(0.5);
      fx.emit({ sprite: "spark-07", color: "#bfe6ff", x: mid.x, y: mid.y, size: box.width * 0.5, aspect: 3, rotation: cutAngle(at), life: 0.35, flicker: true });
      for (let i = 0; i < 7; i += 1) {
        const p = at(rand(0, 1));
        fx.emit({ sprite: "spark-01", color: "#9fd4ff", x: p.x, y: p.y + rand(-14, 14) * scale, size: rand(70, 120) * scale, life: rand(0.18, 0.3), rotation: rand(0, Math.PI * 2), flicker: true, delay: rand(0, 0.2) });
      }
      fx.flash("#dff2ff", 0.45, 0.32, true);
    },
    shake: 7,
    sound: { cut: `${SOUNDS}lightning-cut.mp3`, rip: `${SOUNDS}lightning-rip.mp3` },
  },
  /* Void: a dark blade with its light at the edge, smoking as it goes. When
     the pack gives, light spirals into the cut, darkness wells out of it,
     and dark tendrils lash out with sparks of the light thrown after them. */
  void: {
    style: "void",
    bloom: 1.2,
    strokes: [
      { rgb: [140, 70, 255], alpha: 0.5, width: [10, 30] },
      { rgb: [220, 150, 255], alpha: 0.8, width: [6, 18] },
      { rgb: [8, 5, 14], alpha: 1, width: [8, 22] },
    ],
    life: 320,
    tip: { glow: "rgba(150, 80, 255, 0.55)", core: "rgba(230, 212, 255, 1)", radius: 4 },
    sprites: ["smoke-04", "magic-05", "circle-05"],
    trailEvery: 16,
    trail: (fx, x, y, _dx, _dy, scale) => {
      fx.emit({ sprite: "smoke-04", color: "#1b1030", normal: true, x: x + rand(-4, 4) * scale, y: y + rand(-4, 4) * scale, vx: rand(-14, 14) * scale, vy: rand(-26, -6) * scale, size: rand(22, 34) * scale, endSize: rand(46, 64) * scale, rotation: rand(0, Math.PI * 2), spin: rand(-1, 1), life: rand(0.7, 1), alpha: 0.6 });
      if (Math.random() < 0.35) fx.emit({ sprite: "magic-05", color: pick(["#b47bff", "#ff7ae0"]), x, y, vx: rand(-40, 40) * scale, vy: rand(-50, 0) * scale, size: rand(8, 14) * scale, endSize: 2 * scale, life: rand(0.4, 0.7) });
    },
    cut: (fx, x, y, scale) => {
      spray(fx, x, y, scale, 5, { sprite: "magic-05", colors: ["#b47bff", "#e2c4ff", "#ff7ae0"], speed: [80, 220], size: [10, 18], life: [0.35, 0.6], drag: 2.5, spread: 3 });
    },
    rip: (fx, _box, _y, scale, at) => {
      const mid = at(0.5);
      // light spiralling in: each mote starts out round the cut and curls into it
      for (let i = 0; i < 30; i += 1) {
        const a = rand(0, Math.PI * 2);
        const r = rand(70, 130) * scale;
        const inward = r * 2.4;
        const swirl = r * 3.2;
        fx.emit({ sprite: "magic-05", color: pick(["#b47bff", "#e2c4ff", "#ff7ae0"]), x: mid.x + Math.cos(a) * r, y: mid.y + Math.sin(a) * r * 0.7, vx: -Math.cos(a) * inward - Math.sin(a) * swirl, vy: -Math.sin(a) * inward * 0.7 + Math.cos(a) * swirl * 0.7, drag: 3.5, size: rand(10, 16) * scale, endSize: 3 * scale, life: 0.38 });
      }
      // darkness welling out of the cut, along all of it
      for (let i = 0; i < 12; i += 1) {
        const p = at(i / 11);
        fx.emit({ sprite: "smoke-04", color: "#160c28", normal: true, x: p.x, y: p.y + rand(-4, 4) * scale, vy: rand(-20, 20) * scale, size: 24 * scale, endSize: rand(64, 92) * scale, rotation: rand(0, Math.PI * 2), spin: rand(-0.8, 0.8), life: rand(1.1, 1.5), alpha: 0.85, delay: 0.3 + (i / 11) * 0.06 });
      }
      // tendrils lashing out, sparks of the light flung after them
      for (let i = 0; i < 8; i += 1) {
        const p = at(rand(0.1, 0.9));
        const a = rand(0, Math.PI * 2);
        const sp = rand(380, 620) * scale;
        fx.emit({ sprite: "smoke-04", color: "#1d1133", normal: true, x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.75, drag: 3, stretch: 1.4, size: rand(18, 26) * scale, endSize: 8 * scale, life: 0.55, alpha: 0.95, delay: 0.36 });
      }
      for (let i = 0; i < 26; i += 1) {
        const p = at(rand(0, 1));
        const a = rand(0, Math.PI * 2);
        const sp = rand(220, 520) * scale;
        fx.emit({ sprite: "magic-05", color: pick(["#b47bff", "#ff7ae0", "#e2c4ff"]), x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7, drag: 2.4, size: rand(10, 18) * scale, endSize: 2 * scale, life: rand(0.55, 0.85), delay: 0.38 });
      }
      fx.flash("#6a2cff", 0.1, 0.14);
    },
    shake: 5,
    sound: { cut: `${SOUNDS}void-cut.mp3`, rip: `${SOUNDS}void-rip.mp3` },
  },
  /* Gale: pale streaks of wind off the stroke and wisps trailing it. When
     the pack gives, the leaves caught in it whirl round the cut, and then
     a gust throws them away across the stage. */
  gale: {
    style: "gale",
    bloom: 0.8,
    strokes: [
      { rgb: [200, 255, 235], alpha: 0.25, width: [6, 26] },
      { rgb: [225, 255, 245], alpha: 0.8, width: [3, 14] },
      { rgb: [255, 255, 255], alpha: 1, width: [0.8, 2.5] },
    ],
    life: 300,
    tip: { glow: "rgba(220, 255, 240, 0.35)", core: "rgba(255, 255, 255, 1)", radius: 3.5 },
    sprites: ["trace-07", "flame-05"],
    trailEvery: 26,
    trail: (fx, x, y, dx, dy, scale) => {
      // a wisp left curling off behind the stroke
      const len = Math.hypot(dx, dy) || 1;
      fx.emit({ sprite: "trace-07", color: "#eafff6", x: x + rand(-4, 4) * scale, y: y + rand(-8, 8) * scale, vx: (-dx / len) * rand(40, 90) * scale, vy: (-dy / len) * rand(40, 90) * scale + rand(-20, 20) * scale, size: rand(18, 28) * scale, endSize: rand(26, 40) * scale, aspect: 0.08, rotation: Math.atan2(dy, dx) + Math.PI / 2 + rand(-0.3, 0.3), spin: rand(-1.5, 1.5), life: rand(0.35, 0.5), alpha: 0.4 });
    },
    cut: (fx, x, y, scale) => {
      for (let i = 0; i < 3; i += 1) {
        fx.emit({ sprite: "trace-07", color: "#eafff6", x, y: y + rand(-14, 14) * scale, vx: rand(500, 900) * scale, size: rand(26, 40) * scale, aspect: 0.12, rotation: Math.PI / 2, life: 0.25, alpha: 0.6 });
      }
      if (Math.random() < 0.5) leaf(fx, x, y, scale, 0, rand(300, 700), rand(-220, 80));
    },
    rip: (fx, box, _y, scale, at) => {
      const mid = at(0.5);
      // the leaves whirl round the cut first
      for (let i = 0; i < 16; i += 1) {
        const a = (i / 16) * Math.PI * 2;
        const r = rand(30, 60) * scale;
        leaf(fx, mid.x + Math.cos(a) * r, mid.y + Math.sin(a) * r * 0.5, scale, 0, -Math.sin(a) * 520, Math.cos(a) * 260, 0.32);
      }
      // then the gust: streaks of wind across the whole stage, the leaves thrown with it
      for (let i = 0; i < 14; i += 1) {
        fx.emit({ sprite: "trace-07", color: "#eafff6", x: box.left - rand(20, 80) * scale, y: box.top + rand(0.05, 0.95) * box.height, vx: rand(1000, 1500) * scale, vy: rand(-120, -40) * scale, size: rand(50, 90) * scale, aspect: 0.06, rotation: Math.PI / 2 - 0.08, life: rand(0.3, 0.42), alpha: 0.45, delay: 0.28 + rand(0, 0.06) });
      }
      for (let i = 0; i < 22; i += 1) {
        const p = at(rand(0, 1));
        leaf(fx, p.x, p.y + rand(-10, 10) * scale, scale, 0.3 + rand(0, 0.06), rand(600, 1000), rand(-260, 40));
      }
      fx.flash("#e9fff6", 0.05, 0.1);
    },
    shake: 3,
    sound: { cut: `${SOUNDS}gale-cut.mp3`, rip: `${SOUNDS}gale-rip.mp3` },
  },
  /* Ink brush: a calligraphy stroke in pale ink (white calligraphy on dark
     paper, so it reads on the dark page), full in the middle and thin at the
     ends, drying in breaks as it fades, flicking drops off. When the pack
     gives, ink splashes out of the cut: splats along the stroke you made and
     drops flung off them, a few red among them. */
  ink: {
    style: "ink",
    brush: true,
    bloom: 0.4,
    strokes: [
      { rgb: [20, 18, 24], alpha: 1, width: [14, 44] },
      { rgb: [255, 240, 214], alpha: 1, width: [14, 44] },
      { rgb: [240, 228, 206], alpha: 1, width: [14, 44] },
    ],
    life: 650,
    tip: { glow: "rgba(243, 230, 207, 0.25)", core: "rgba(243, 230, 207, 0.9)", radius: 3 },
    sprites: ["dot-01", "splat-01"],
    trailEvery: 20,
    trail: (fx, x, y, _dx, _dy, scale) => {
      if (Math.random() < 0.5) inkDrop(fx, x, y, scale, rand(-90, 90), rand(-140, 20), rand(3, 5), 0, false);
    },
    cut: (fx, x, y, scale) => {
      for (let i = 0; i < 5; i += 1) inkDrop(fx, x, y, scale, rand(-220, 220), rand(-260, 0), rand(3, 6), 0, false);
    },
    rip: (fx, _box, _y, scale, at) => {
      // a few flicks of ink along the cut, laid the way the stroke went
      const head = at(1);
      const tail = at(0);
      const along = Math.atan2(head.y - tail.y, head.x - tail.x);
      for (let i = 0; i < 4; i += 1) {
        const p = at(0.15 + i * 0.23 + rand(-0.05, 0.05));
        const size = rand(18, 30) * scale;
        const spec = { x: p.x + rand(-4, 4) * scale, y: p.y + rand(-4, 4) * scale, rotation: along + rand(-0.25, 0.25), aspect: 1.9, life: 1.3, delay: rand(0, 0.05) };
        fx.emit({ ...spec, sprite: "splat-01", color: i === 2 ? "#d6453d" : "#f0e4ce", normal: true, size: size * 0.3, endSize: size, alpha: 1 });
      }
      for (let i = 0; i < 34; i += 1) {
        const p = at(rand(0, 1));
        const a = rand(0, Math.PI * 2);
        const sp = rand(160, 520);
        inkDrop(fx, p.x, p.y, scale, Math.cos(a) * sp, Math.sin(a) * sp * 0.6 - 80, rand(3, 8), rand(0, 0.04), Math.random() < 0.18);
      }
    },
    shake: 3,
    sound: { cut: `${SOUNDS}ink-cut.mp3`, rip: `${SOUNDS}ink-rip.mp3`, loop: `${SOUNDS}ink-loop.mp3` },
  },
  /* Rainbow: star power. One bright blade whose glow flashes through every
     colour (bladeGl's rainbow mode), throwing off sparks that run through
     the colours as they fly. When the pack gives, a streak along the cut you
     made and a burst of sparks off it flash through the colours together, in
     step, like a star. No stripes, and never several colours at once. */
  rainbow: {
    style: "rainbow",
    bloom: 1.25,
    strokes: [
      { rgb: [255, 255, 255], alpha: 0.4, width: [6, 24] },
      { rgb: [255, 255, 255], alpha: 0.7, width: [3, 12] },
      { rgb: [255, 255, 255], alpha: 1, width: [1.2, 4.5] },
    ],
    life: 260,
    tip: { glow: "rgba(255, 255, 255, 0.5)", core: "rgba(255, 255, 255, 1)", radius: 4.5 },
    sprites: ["circle-05", "trace-07"],
    trailEvery: 18,
    trail: (fx, x, y, _dx, _dy, scale) => {
      fx.emit({ sprite: "circle-05", color: RAINBOW[0], ramp: cycle(), x: x + rand(-6, 6) * scale, y: y + rand(-6, 6) * scale, vx: rand(-40, 40) * scale, vy: rand(-40, 40) * scale, drag: 1.5, size: rand(6, 10) * scale, endSize: 2 * scale, life: rand(0.45, 0.7) });
    },
    cut: (fx, x, y, scale) => {
      for (let i = 0; i < 7; i += 1) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(180, 420) * scale;
        fx.emit({ sprite: "circle-05", color: RAINBOW[0], ramp: cycle(), x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80 * scale, drag: 2.5, gravity: 220 * scale, size: rand(7, 12) * scale, endSize: 2 * scale, life: rand(0.4, 0.6), stretch: 0.5 });
      }
    },
    rip: (fx, _box, _y, scale, at) => {
      // Everything flashes through the colours together, in step, the way a
      // star does: one start colour and one pace for the whole burst.
      const start = Math.floor(Math.random() * RAINBOW.length);
      const life = 0.75;
      // a streak along the cut you made, laid piece by piece so it bends with it
      const pieces = 16;
      for (let i = 0; i < pieces; i += 1) {
        const a = at(i / pieces);
        const b = at((i + 1) / pieces);
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const along = Math.atan2(b.y - a.y, b.x - a.x);
        fx.emit({ sprite: "trace-07", color: RAINBOW[start], ramp: cycle(3, start), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, size: length * 3.2, endSize: length * 3.6, aspect: (22 * scale) / (length * 3.2), rotation: along + Math.PI / 2, life, alpha: 1 });
      }
      // and sparks off it, in the same colour as the streak at every moment
      for (let i = 0; i < 40; i += 1) {
        const p = at(rand(0, 1));
        const a = rand(0, Math.PI * 2);
        const sp = rand(240, 620) * scale;
        fx.emit({ sprite: "circle-05", color: RAINBOW[start], ramp: cycle(3, start), x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.75 - 60 * scale, drag: 2.2, gravity: 160 * scale, size: rand(7, 12) * scale, endSize: 2 * scale, life, stretch: 0.6 });
      }
      fx.flash("#ffffff", 0.08, 0.12);
    },
    shake: 3,
    sound: { cut: `${SOUNDS}rainbow-cut.mp3`, rip: `${SOUNDS}rainbow-rip.mp3` },
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
/* A colour of the rainbow, red at 0 round to violet at 1. */
function hueRgb(t: number): Rgb {
  const h = (t * 0.85) * 6;
  const channel = (n: number) => Math.round(255 * Math.min(1, Math.max(0, Math.abs(((h + n) % 6) - 3) - 1)));
  return [channel(0), channel(4), channel(2)];
}

function fillRibbon(
  ctx: CanvasRenderingContext2D,
  path: readonly Point[],
  width: (i: number) => number,
  alpha: (i: number) => number,
  /* One colour, or a colour for each point along it (t 0 at the tail, 1 at the tip). */
  rgb: Rgb | ((t: number) => Rgb),
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
  const gradient = ctx.createLinearGradient(path[0].x, path[0].y, path[n - 1].x, path[n - 1].y);
  const stops = Math.min(n, typeof rgb === "function" ? 14 : 8);
  for (let k = 0; k < stops; k += 1) {
    const i = Math.round((k / (stops - 1)) * (n - 1));
    const [r, g, b] = typeof rgb === "function" ? rgb(k / (stops - 1)) : rgb;
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
      for (const [index, stroke] of look.strokes.entries()) {
        // the rainbow's glow runs through the colours along its length here
        // (the WebGL draw cycles them over time instead); its core stays white
        const rainbow = look.style === "rainbow" && index < look.strokes.length - 1;
        fillRibbon(
          ctx,
          points,
          (i) => (stroke.width[0] + (stroke.width[1] - stroke.width[0]) * (i / (n - 1))) * scale,
          (i) => fade(i) * stroke.alpha,
          rainbow ? hueRgb : stroke.rgb,
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
