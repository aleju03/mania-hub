import { useId, useState } from "react";

/* Scene card art for the pack run, in the linocut stamp style of the charm
   directions: one ink colour per card printed on a pale paper chip, rough
   cut edges, and carved hatching where a second tone would go. Everything is
   drawn here on a 128 grid. The roughness comes from a PRNG seeded by the
   card id, so every render of a card is the same print. Each card's markup
   is built once per module and reused; clip ids get the instance's useId.

   The character cards print from their real artwork instead: the source
   illustration run through scripts/art/linocut.py into a 512px WebP with the
   same chip, ink and paper. The SVG print stays as the fallback. */

export type SceneId =
  | "makiba"
  | "tree"
  | "onceForgotten"
  | "futureDominators"
  | "ascension"
  | "marioPaint"
  | "duplicity"
  | "echoes"
  | "aiae"
  | "scatteredFaith"
  | "foolMoon"
  | "moonGate"
  | "lostRequiem"
  | "purplePalace";

export const SCENE_IDS: readonly SceneId[] = [
  "makiba",
  "tree",
  "onceForgotten",
  "futureDominators",
  "ascension",
  "marioPaint",
  "duplicity",
  "echoes",
  "aiae",
  "scatteredFaith",
  "foolMoon",
  "moonGate",
  "lostRequiem",
  "purplePalace",
];

const PALETTE: Record<SceneId, { ink: string; paper: string }> = {
  makiba: { ink: "#2d6a1f", paper: "#e5f0cf" },
  tree: { ink: "#b03e17", paper: "#f7e3cd" },
  onceForgotten: { ink: "#1c2c6c", paper: "#e2e8f3" },
  futureDominators: { ink: "#b3123f", paper: "#f9e1e7" },
  ascension: { ink: "#9a5806", paper: "#f6edd0" },
  marioPaint: { ink: "#0c6570", paper: "#dbefec" },
  duplicity: { ink: "#4a1f86", paper: "#ebe2f5" },
  echoes: { ink: "#2b3040", paper: "#e9e5dc" },
  aiae: { ink: "#0d6b50", paper: "#d9efe6" },
  scatteredFaith: { ink: "#145d9c", paper: "#dce9f6" },
  foolMoon: { ink: "#5c3a1c", paper: "#f4e7d4" },
  moonGate: { ink: "#6b6512", paper: "#f0eed3" },
  lostRequiem: { ink: "#8e1616", paper: "#f4dcd6" },
  purplePalace: { ink: "#8c1a7e", paper: "#f5e0f1" },
};

// ---------- geometry ----------

type V = [number, number];
// A control point; a third value of 1 marks a sharp corner.
type C = [number, number] | [number, number, number];
type Rand = () => number;

function seeded(seed: string): Rand {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const rad = (deg: number) => (deg * Math.PI) / 180;
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const num = (x: number) => String(Math.round(x * 10) / 10);

function d(pts: readonly V[]): string {
  return `M${pts.map((p) => `${num(p[0])} ${num(p[1])}`).join("L")}Z`;
}

/* Hermite spline through control points (Catmull-Rom tangents, zero tangent
   at corners), sampled about every 2 units. */
function spline(ctrl: readonly C[], closed = false, tension = 0.5): V[] {
  const n = ctrl.length;
  const P = (i: number) => (closed ? ctrl[((i % n) + n) % n] : ctrl[Math.max(0, Math.min(n - 1, i))]);
  const tan = (i: number): V => {
    const p = P(i);
    if (p[2]) return [0, 0];
    const a = P(i - 1);
    const b = P(i + 1);
    return [(b[0] - a[0]) * tension, (b[1] - a[1]) * tension];
  };
  const out: V[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i);
    const p1 = P(i + 1);
    const m0 = tan(i);
    const m1 = tan(i + 1);
    const k = Math.max(2, Math.ceil(dist(p0, p1) / 2));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      out.push([h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0], h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1]]);
    }
  }
  if (!closed) out.push([ctrl[n - 1][0], ctrl[n - 1][1]]);
  return out;
}

function ellipse(cx: number, cy: number, rx: number, ry = rx, rot = 0, a0 = 0, a1 = 360): V[] {
  const n = Math.max(16, Math.ceil((Math.max(rx, ry) * TAU * Math.abs(a1 - a0)) / 360 / 2));
  const full = Math.abs(a1 - a0) >= 360;
  const out: V[] = [];
  const c = Math.cos(rad(rot));
  const s = Math.sin(rad(rot));
  for (let i = 0; i < (full ? n : n + 1); i++) {
    const a = rad(a0 + ((a1 - a0) * i) / n);
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}

function rrect(x: number, y: number, w: number, h: number, r: number): V[] {
  const out: V[] = [];
  const corners: [number, number, number][] = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  for (const [cx, cy, a0] of corners) out.push(...ellipse(cx, cy, r, r, 0, a0, a0 + 90));
  return out;
}

function star(cx: number, cy: number, ro: number, ri: number, pts = 5, rot = -90): V[] {
  const out: V[] = [];
  for (let i = 0; i < pts * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = rad(rot + (180 / pts) * i);
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

const mirrorX = (pts: readonly V[], axis = 64): V[] => pts.map(([x, y]) => [2 * axis - x, y] as V).reverse();
const mirrorC = (pts: readonly C[], axis = 64): C[] => pts.map((p) => (p[2] ? [2 * axis - p[0], p[1], 1] : [2 * axis - p[0], p[1]]) as C).reverse();
const shift = (pts: readonly V[], dx: number, dy = 0): V[] => pts.map(([x, y]) => [x + dx, y + dy] as V);

function resample(pts: readonly V[], step: number, closed: boolean): V[] {
  const src = closed ? [...pts, pts[0]] : pts;
  const out: V[] = [];
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i];
    const b = src[i + 1];
    const k = Math.max(1, Math.round(dist(a, b) / step));
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  if (!closed) out.push(src[src.length - 1]);
  return out;
}

function noise(r: Rand, len: number, wave: number): (s: number) => number {
  const knots = Array.from({ length: Math.ceil(len / wave) + 3 }, () => r() * 2 - 1);
  return (s) => {
    const u = s / wave;
    const i = Math.floor(u);
    const f = u - i;
    const e = f * f * (3 - 2 * f);
    return knots[i] * (1 - e) + knots[i + 1] * e;
  };
}

/* The cut edge of a carved shape: low-frequency wobble plus the odd chip
   where the gouge slipped. */
function rough(poly: readonly V[], r: Rand, amp = 0.7, chips = 0.025): V[] {
  const pts = resample(poly, 1.8, true);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const inward = area > 0 ? 1 : -1;
  const n = noise(r, pts.length * 1.8, 5.5);
  let chip = 0;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    if (chip <= 0 && r() < chips) chip = 2;
    const off = amp * n(i * 1.8) - (chip > 0 ? 1.3 * amp + 0.6 : 0);
    chip--;
    return [p[0] - (dy / l) * off * inward, p[1] + (dx / l) * off * inward];
  });
}

type Profile = "mid" | "base" | "flat" | "tip" | "plume";

/* A gouge or a ridge: a polyline given width, pointed per the profile. */
function taper(line: readonly V[], w: number, r: Rand, profile: Profile = "mid", tip = 0.12): V[] {
  const pts = resample(line, 1.6, false);
  const n = pts.length;
  if (n < 2) return [];
  const wob = noise(r, n * 1.6, 4);
  const L: V[] = [];
  const R: V[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const t = i / (n - 1);
    let f: number;
    if (profile === "mid") f = 0.22 + 0.78 * Math.sqrt(Math.sin(Math.PI * t));
    else if (profile === "base") f = tip + (1 - tip) * Math.sqrt(1 - t);
    else if (profile === "tip") f = Math.min(1, Math.sin(Math.PI * t) * 2.2);
    else if (profile === "plume") f = 0.2 + 0.8 * Math.sin(Math.PI * Math.pow(t, 1.5));
    else f = 1;
    const half = (w / 2) * Math.max(0.05, f) * (1 + 0.12 * wob(i * 1.6));
    L.push([pts[i][0] - (dy / l) * half, pts[i][1] + (dx / l) * half]);
    R.push([pts[i][0] + (dy / l) * half, pts[i][1] - (dx / l) * half]);
  }
  return [...L, ...R.reverse()];
}

function lengthOf(pts: readonly V[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

function bbox(pts: readonly V[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

// ---------- the block ----------

type ShapeOpts = { rough?: number; sep?: number; chips?: number };
type HatchOpts = { angle?: number; gap?: number; w?: number; dash?: [number, number]; ink?: boolean; jitter?: number };

class Plate {
  parts: string[] = [];
  defs: string[] = [];
  private k = 0;
  readonly r: Rand;
  readonly INK: string;
  readonly PAPER: string;

  constructor(id: SceneId) {
    this.r = seeded(id);
    this.INK = PALETTE[id].ink;
    this.PAPER = PALETTE[id].paper;
  }

  private shape(poly: readonly V[], fill: string, o: ShapeOpts): V[] {
    const p = o.rough === 0 ? [...poly] : rough(poly, this.r, o.rough ?? 0.6, o.chips);
    const other = fill === this.INK ? this.PAPER : this.INK;
    const sep = o.sep ? ` stroke="${other}" stroke-width="${o.sep}" paint-order="stroke" stroke-linejoin="round"` : "";
    this.parts.push(`<path d="${d(p)}" fill="${fill}"${sep}/>`);
    return p;
  }

  ink(poly: readonly V[], o: ShapeOpts = {}) {
    return this.shape(poly, this.INK, o);
  }

  paper(poly: readonly V[], o: ShapeOpts = {}) {
    return this.shape(poly, this.PAPER, o);
  }

  /** An uncut ridge of ink along a line. */
  ridge(line: readonly V[], w: number, profile: Profile = "mid", sep = 0, tip?: number) {
    return this.shape(taper(line, w, this.r, profile, tip), this.INK, { rough: 0, sep });
  }

  /** A gouge: paper along a line. */
  cut(line: readonly V[], w: number, profile: Profile = "mid", sep = 0, tip?: number) {
    return this.shape(taper(line, w, this.r, profile, tip), this.PAPER, { rough: 0, sep });
  }

  /** Paper with an ink rim (a carved outline around a cleared area). */
  outlined(poly: readonly V[], rim = 2.4, o: ShapeOpts = {}) {
    const p = o.rough === 0 ? [...poly] : rough(poly, this.r, o.rough ?? 0.5, o.chips);
    this.parts.push(`<path d="${d(p)}" fill="${this.PAPER}" stroke="${this.INK}" stroke-width="${rim * 2}" paint-order="stroke" stroke-linejoin="round"/>`);
    return p;
  }

  /** Several cleared shapes sharing one ink rim, so they print as one silhouette. */
  silhouette(polys: readonly V[][], rim: number, amp = 0.3): V[][] {
    const ps = polys.map((p) => (amp ? rough(p, this.r, amp, 0.01) : [...p]));
    const paths = ps.map((p) => `<path d="${d(p)}"/>`).join("");
    this.parts.push(`<g fill="${this.INK}" stroke="${this.INK}" stroke-width="${rim * 2}" stroke-linejoin="round">${paths}</g>`);
    this.parts.push(`<g fill="${this.PAPER}">${paths}</g>`);
    return ps;
  }

  dot(cx: number, cy: number, r: number, ink: boolean) {
    const poly = ellipse(cx, cy, r * (0.85 + this.r() * 0.3), r * (0.85 + this.r() * 0.3), this.r() * 180);
    this.parts.push(`<path d="${d(poly)}" fill="${ink ? this.INK : this.PAPER}"/>`);
  }

  clip(region: readonly V[] | readonly V[][], draw: () => void) {
    const id = `§${this.k++}`;
    const regions = (typeof region[0][0] === "number" ? [region] : region) as V[][];
    this.defs.push(`<clipPath id="${id}">${regions.map((p) => `<path d="${d(p)}"/>`).join("")}</clipPath>`);
    this.parts.push(`<g clip-path="url(#${id})">`);
    draw();
    this.parts.push("</g>");
  }

  group(transform: string, draw: () => void) {
    this.parts.push(`<g transform="${transform}">`);
    draw();
    this.parts.push("</g>");
  }

  /** Parallel gouges (or ridges) across a region, clipped to it. */
  hatch(region: readonly V[], o: HatchOpts = {}) {
    const { angle = 60, gap = 4, w = 1.8, dash, ink = false, jitter = 4 } = o;
    const b = bbox(region);
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const R = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + 2;
    const g: string[] = [];
    for (let k = -R + this.r() * gap; k < R; k += gap * (0.85 + this.r() * 0.3)) {
      const a = rad(angle + (this.r() * 2 - 1) * jitter);
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const ox = cx - uy * k;
      const oy = cy + ux * k;
      const segs: [number, number][] = [];
      if (dash) {
        let s = -R + this.r() * dash[1];
        while (s < R) {
          const len = dash[0] + this.r() * (dash[1] - dash[0]);
          segs.push([s, Math.min(R, s + len)]);
          s += len + dash[0] * (0.3 + this.r() * 0.6);
        }
      } else {
        segs.push([-R * (1 - this.r() * 0.15), R * (0.8 + this.r() * 0.2)]);
      }
      for (const [s0, s1] of segs) {
        if (s1 - s0 < 1.5) continue;
        const line: V[] = [
          [ox + ux * s0, oy + uy * s0],
          [ox + ux * s1, oy + uy * s1],
        ];
        g.push(`<path d="${d(taper(line, w * (0.8 + this.r() * 0.35), this.r))}"/>`);
      }
    }
    this.clip(region, () => this.parts.push(`<g fill="${ink ? this.INK : this.PAPER}">${g.join("")}</g>`));
  }

  /** The paper chip itself, with a few nicks of leftover ink by the border. */
  chip(nicks = 3) {
    this.parts.push(`<path d="${d(rough(rrect(3, 3, 122, 122, 13), this.r, 0.6, 0))}" fill="${this.PAPER}"/>`);
    for (let i = 0; i < nicks; i++) {
      const side = Math.floor(this.r() * 4);
      const u = 18 + this.r() * 92;
      const [x, y] = [
        [u, 7.5],
        [u, 120.5],
        [7.5, u],
        [120.5, u],
      ][side];
      const a = this.r() * TAU;
      const tri: V[] = [
        [-3.2, -0.7],
        [3.2, -1.1],
        [0.4, 1.5],
      ].map(([px, py]) => [x + px * Math.cos(a) - py * Math.sin(a), y + px * Math.sin(a) + py * Math.cos(a)] as V);
      this.parts.push(`<path d="${d(tri)}" fill="${this.INK}"/>`);
    }
  }

  markup() {
    return `<defs>${this.defs.join("")}</defs>${this.parts.join("")}`;
  }
}

/** The printed area inside the chip margin, for scenes with a background block. */
const BLOCK = rrect(9, 9, 110, 110, 8);

// ---------- 1. Makiba cat ----------

function makiba(pl: Plate) {
  const r = pl.r;
  pl.chip();
  // The pasture behind, carved light.
  pl.clip(rough(BLOCK, r, 0.4), () => {
    const hill = spline([[4, 99], [26, 92], [52, 95], [80, 90], [104, 94], [124, 89]]);
    const h = pl.ink([...hill, [124, 124], [4, 124]], { rough: 0.5 });
    pl.hatch(h, { angle: 3, gap: 2.5, w: 1.4, dash: [10, 30], jitter: 2 });
  });
  // Tail first so the body overlaps its root.
  pl.ridge(spline([[84, 109], [98, 110], [109, 102], [113, 89], [109, 78], [100, 75], [94, 81], [97, 88]]), 9, "base", 3, 0.45);
  const body = spline([[53, 62], [45, 72], [40, 86], [36, 100], [38, 112], [48, 116, 1], [80, 116, 1], [90, 111], [91, 98], [87, 84], [82, 72], [75, 62]], true);
  const b = pl.ink(body, { sep: 3 });
  pl.clip(b, () => pl.hatch([[75, 58], [100, 58], [100, 120], [75, 120]], { angle: 84, gap: 3, w: 1.4, dash: [7, 20], jitter: 3 }));
  // Front legs, haunch and toes carved in.
  pl.cut([[57, 86], [57.5, 100], [57, 115]], 2.6);
  pl.cut([[71, 86], [70.5, 100], [71, 115]], 2.6);
  pl.cut(spline([[45, 86], [42, 100], [47, 113]]), 2.2);
  for (const x of [52, 64, 76]) pl.cut([[x - 2, 114.6], [x + 2, 114.6]], 1.4);
  for (let i = 0; i < 3; i++) {
    const y = 70 + i * 5;
    pl.cut([[60, y - 2], [64, y + 1.5], [68, y - 2]], 1.6);
  }
  // Head: a plain round with cheek tufts and tall ears.
  const earR: C[] = [[74, 25], [82, 15], [89, 5, 1], [91, 20], [90, 33]];
  const head: C[] = [[64, 24], ...earR, [94, 41], [97, 48, 1], [93, 51], [96, 56, 1], [90, 61], [80, 67], [64, 70], [48, 67], [38, 61], [32, 56, 1], [35, 51], [31, 48, 1], [34, 41], ...mirrorC(earR)];
  pl.ink(spline(head, true), { sep: 3 });
  // Ear stripes, across the outer half of each ear.
  for (const s of [1, -1]) {
    const X = (x: number) => (s === 1 ? x : 128 - x);
    const tip: V = [X(89), 5];
    const outer: V = [X(90.5), 33];
    const inner: V = [X(74), 25];
    for (const t of [0.34, 0.54, 0.74]) {
      const o: V = [tip[0] + (outer[0] - tip[0]) * t, tip[1] + (outer[1] - tip[1]) * t];
      const i: V = [tip[0] + (inner[0] - tip[0]) * t, tip[1] + (inner[1] - tip[1]) * t];
      pl.cut([[o[0] + (i[0] - o[0]) * 0.08, o[1] + 0.6], [o[0] + (i[0] - o[0]) * 0.62, o[1] + (i[1] - o[1]) * 0.62]], 2);
    }
  }
  // Grass tufts.
  for (const [x, h] of [[18, 9], [24, 6], [104, 8], [110, 11], [118, 6]]) {
    for (const lean of [-3, 0, 3]) pl.ridge([[x, 117], [x + lean, 117 - h + Math.abs(lean) * 0.7]], 1.8, "base", 0, 0.1);
  }
}

// ---------- 2. Forgotten Tree ----------

function tree(pl: Plate) {
  const r = pl.r;
  pl.chip(2);
  const block = rough(BLOCK, r, 0.4);
  pl.clip(block, () => {
    // Dusk: a few long streaks at the top, thinning down into the fog.
    for (let i = 0; i < 6; i++) {
      const y = 11 + i * 4 + i * i * 0.45;
      const w = 2.5 - i * 0.34;
      let x = 4 + r() * 10;
      while (x < 124) {
        const len = 22 + r() * 40;
        pl.ridge([[x, y + (r() - 0.5) * 0.8], [x + len, y + (r() - 0.5) * 0.8]], w);
        x += len + 4 + r() * (8 + i * 5);
      }
    }
    // A far fir at the left edge, carved light.
    const fir = spline([[20, 44, 1], [24, 56], [22, 57], [27, 69], [24, 70], [30, 84], [26, 85], [32, 100, 1], [8, 100, 1], [14, 85], [10, 84], [16, 70], [13, 69], [18, 57], [16, 56]], true, 0.25);
    const f = pl.ink(fir, { sep: 1.6 });
    pl.hatch(f, { angle: 0, gap: 3, w: 0.8, dash: [8, 20], jitter: 2 });
    // Low sun sinking into the fog.
    pl.ink(ellipse(97, 84, 8.5), { rough: 0.3 });
    for (const [y, w] of [[85.5, 1.2], [88.5, 1.7], [91.5, 2.4]] as const) pl.cut([[87, y], [107, y]], w, "flat");
    // Fog: broken thin rules over the horizon.
    for (let i = 0; i < 4; i++) {
      const y = 92 + i * 2.6;
      let x = 4 + r() * 8;
      while (x < 124) {
        const len = 8 + r() * 22;
        pl.ridge([[x, y], [x + len, y + (r() - 0.5) * 0.5]], 0.7 + i * 0.35);
        x += len + 3 + r() * (10 - i * 2);
      }
    }
    // Field with grass gouged into it.
    const field = spline([[4, 104], [30, 102], [56, 104], [86, 101], [124, 103]]);
    const fp = pl.ink([...field, [124, 124], [4, 124]], { rough: 0.6 });
    pl.clip(fp, () => {
      for (let i = 0; i < 34; i++) {
        const x = 5 + r() * 118;
        const y = 108 + r() * 14;
        pl.cut([[x, y], [x + (r() - 0.5) * 3, y - 3 - r() * 6]], 1.1, "base");
      }
    });
    for (let i = 0; i < 14; i++) {
      const x = 6 + r() * 116;
      const h = 4 + r() * 6;
      pl.ridge([[x, 104], [x + (r() - 0.5) * 3, 104 - h]], 1.1, "base", 0, 0.1);
    }
  });
  // The tree: gnarled limbs forking into crooked twigs that turn up at the ends.
  const limb = (pts: C[], w: number, depth: number) => {
    const line = spline(pts);
    pl.ridge(line, w, "base", 0, 0.24);
    if (depth <= 0) return;
    const L = lengthOf(line);
    const kids = depth === 1 ? 2 : 3;
    for (let k = 0; k < kids; k++) {
      const t = 0.3 + ((k + r() * 0.7) / kids) * 0.62;
      const idx = Math.min(line.length - 2, Math.floor(t * (line.length - 1)));
      const p = line[idx];
      const q = line[idx + 1];
      const dir = Math.atan2(q[1] - p[1], q[0] - p[0]);
      let a = dir + ((k + depth) % 2 ? 1 : -1) * (0.5 + r() * 0.45);
      if (Math.sin(a) > 0.35) a = dir - (a - dir);
      const len = L * (0.36 + r() * 0.2);
      const p1: V = [p[0] + Math.cos(a) * len * 0.45, p[1] + Math.sin(a) * len * 0.45];
      const a2 = a + (r() - 0.5) * 0.9;
      const p2: V = [p1[0] + Math.cos(a2) * len * 0.33, p1[1] + Math.sin(a2) * len * 0.33];
      const p3: V = [p2[0] + Math.cos(a2) * len * 0.12, p2[1] - len * 0.2];
      limb([p, p1, p2, p3], Math.max(0.9, w * (0.25 + 0.75 * Math.sqrt(1 - t)) * 0.6), depth - 1);
    }
  };
  pl.clip(block, () => drawTree(pl, limb));
}

function drawTree(pl: Plate, limb: (pts: C[], w: number, depth: number) => void) {
  pl.ink(spline([[46, 106, 1], [53, 102], [56, 92], [62, 92], [64, 102], [72, 106, 1]], true), { rough: 0.4 });
  pl.ridge(spline([[58, 104], [59.5, 90], [58.5, 78], [60, 68]]), 10.5, "base", 0, 0.5);
  const limbs: [C[], number][] = [
    [[[59, 73], [48, 67], [36, 63], [24, 58], [12, 54]], 5.6],
    [[[59, 71], [53, 57], [46, 43], [40, 28]], 4.6],
    [[[60, 69], [61, 54], [58, 40], [60, 22]], 4.6],
    [[[61, 69], [68, 54], [74, 40], [80, 25]], 4.4],
    [[[61, 71], [74, 63], [88, 53], [102, 43], [116, 35]], 5.6],
  ];
  for (const [pts, w] of limbs) limb(pts, w, 2);
  limb([[58, 84], [50, 83], [42, 87]], 3, 1);
}

// ---------- 3. Once Forgotten ----------

function onceForgotten(pl: Plate) {
  const r = pl.r;
  pl.chip(0);
  const block = pl.ink(BLOCK, { rough: 0.6 });
  pl.clip(block, () => {
    // Falling snow.
    for (let i = 0; i < 46; i++) pl.dot(12 + r() * 104, 12 + r() * 96, 0.5 + r() * r() * 1.4, false);
    // The star, with its glow carved as broken rings.
    pl.paper(star(95, 22, 11, 2.4, 4, -90), { rough: 0.2 });
    pl.paper(star(95, 22, 5.5, 1.2, 4, -45), { rough: 0 });
    for (const [rr, w] of [[15.5, 1.1], [20, 0.8]] as const) {
      for (let a = 0; a < 360; a += 40) pl.cut(ellipse(95, 22, rr, rr, 0, a + r() * 8, a + 22 + r() * 8), w);
    }
    // Snow drift.
    const drift = spline([[4, 109], [30, 104], [58, 108], [84, 103], [124, 107]]);
    const dp = pl.paper([...drift, [124, 124], [4, 124]], { rough: 0.4 });
    pl.hatch(dp, { angle: -4, gap: 3.2, w: 0.9, dash: [3, 8], ink: true });
  });
  // Long hair behind her, streaming left in the wind and ending in locks.
  const hairBack: C[] = [[52, 22], [60, 23], [66, 30], [68, 44], [71, 60], [74, 76], [74, 90], [71, 104, 1], [66, 97], [60, 108, 1], [53, 100], [44, 111, 1], [38, 103], [27, 112, 1], [27, 101], [17, 102, 1], [24, 92], [21, 84, 1], [28, 76], [30, 62], [36, 46], [40, 32], [45, 25]];
  const hb = pl.outlined(spline(hairBack, true), 1.4);
  pl.clip(hb, () => {
    for (let i = 0; i < 11; i++) {
      const x0 = 40 + i * 2.8;
      const sway = -6 - i * 1.6;
      pl.ridge(spline([[x0, 36 + r() * 12], [x0 - 4 + r() * 2, 64 + r() * 8], [x0 + sway, 90 + r() * 8], [x0 + sway - 9, 112]]), 0.8, "tip");
    }
  });
  // Raised arm reaching for the star.
  pl.ridge(spline([[62, 50], [70, 40], [79, 30]]), 5.4, "flat");
  pl.outlined(taper(spline([[66, 44], [73, 36], [80, 29]]), 3.2, r, "flat"), 1, { rough: 0 });
  pl.outlined(ellipse(82, 26.5, 2.8, 3.4, 40), 0.9, { rough: 0 });
  for (const [dx, dy] of [[1.5, -4.5], [3.8, -3.6], [5, -1.4]]) {
    pl.ridge([[82, 26.5], [82 + dx, 26.5 + dy]], 2.6, "base", 0, 0.5);
    pl.cut([[82, 26.5], [82 + dx * 0.95, 26.5 + dy * 0.95]], 1.1, "base", 0, 0.5);
  }
  // Legs in dark stockings, fur cuffs.
  for (const x of [51, 59]) {
    pl.ridge([[x, 84], [x + (x < 55 ? -0.5 : 0.5), 112]], 4.8, "flat", 2.2);
    pl.ink(rrect(x - 3.6, 110, 7.2, 4.5, 2), { rough: 0.3, sep: 2 });
    pl.outlined(rrect(x - 3.2, 90, 6.4, 3.6, 1.6), 0.8, { rough: 0.5 });
  }
  // Dress.
  const dress: C[] = [[50, 49], [60, 49], [64, 54], [62, 62], [65, 70], [70, 80], [72, 88, 1], [66, 86], [60, 89], [54, 86], [48, 89], [42, 86], [38, 88, 1], [42, 78], [47, 69], [48, 61], [45, 54]];
  const dr = pl.ink(spline(dress, true), { sep: 2.6 });
  pl.clip(dr, () => {
    pl.hatch([[40, 66], [72, 66], [72, 92], [40, 92]], { angle: 80, gap: 3.4, w: 1.2, dash: [6, 14] });
    pl.cut(spline([[40, 84], [48, 85.5], [56, 83.5], [64, 85.5], [71, 84]]), 1.1);
  });
  // Puffed sleeves and the hanging arm.
  pl.ink(ellipse(46, 54, 4.6, 4), { sep: 2 });
  pl.outlined(taper([[45, 58], [44, 66], [45.5, 73]], 3, r, "flat"), 0.9, { rough: 0 });
  pl.ink(ellipse(62, 51, 4.2, 3.6, -30), { sep: 2 });
  // Scarf, its tail blowing back.
  pl.ink(rrect(47.5, 45.5, 15, 5.5, 2.5), { sep: 1.8, rough: 0.4 });
  const tail = spline([[49, 49], [40, 52], [30, 49], [20, 52], [13, 49]]);
  pl.ridge(tail, 5.2, "base", 1.8, 0.55);
  for (let i = 1; i < 6; i++) {
    const p = tail[Math.floor((i / 6) * (tail.length - 1))];
    pl.cut([[p[0] - 0.4, p[1] - 2.2], [p[0] + 0.4, p[1] + 2.2]], 0.9, "flat");
  }
  // Head: a plain face under a fringe, two braids, the flower.
  pl.outlined(ellipse(55, 33, 8.4, 9.6), 1, { rough: 0.3 });
  pl.outlined(ellipse(55, 39, 5.6, 6.4), 0.9, { rough: 0.2 });
  for (const [x0, y0, x1, y1] of [[51, 26, 49, 35], [55, 25, 54.5, 34], [59, 26, 61, 35]]) pl.ridge([[x0, y0], [x1, y1]], 0.8, "tip");
  pl.ridge(spline([[48.5, 34], [52, 35.5], [55, 33.5], [58, 35.5], [61.5, 34]]), 1, "flat");
  for (const [x0, x1] of [[48, 45.5], [62, 64.5]]) {
    const braid = spline([[x0, 40], [x0 + (x1 - x0) * 0.5, 55], [x1, 70]]);
    for (let i = 0; i < 10; i++) {
      const p = braid[Math.floor((i / 10) * (braid.length - 1))];
      pl.outlined(ellipse(p[0] + (i % 2 ? 0.7 : -0.7), p[1] + 1, 1.9, 2.4, i % 2 ? 35 : -35), 0.6, { rough: 0 });
    }
    pl.ink(ellipse(x1, 71, 2.2, 1.4), { rough: 0 });
    pl.outlined([[x1 - 1.4, 72.8], [x1 + 1.4, 72.8], [x1 + 0.8, 77], [x1 - 0.8, 77]], 0.6, { rough: 0 });
  }
  for (let i = 0; i < 5; i++) {
    const a = rad(-90 + i * 72);
    pl.ink(ellipse(62 + Math.cos(a) * 2.6, 27 + Math.sin(a) * 2.6, 2.3, 1.8, i * 72 - 90), { rough: 0 });
  }
  pl.paper(ellipse(62, 27, 1, 1), { rough: 0 });
}

// ---------- 4. Future Dominators ----------

function splash(pl: Plate, cx: number, cy: number, R: number, drips: number) {
  const r = pl.r;
  const n = 26;
  const ctrl: C[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const rr = R * (0.6 + r() * 0.16);
    ctrl.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    if (r() < 0.6) {
      const at = a + Math.PI / n;
      const tip = R * (0.95 + r() * r() * 1.1);
      ctrl.push([cx + Math.cos(at) * tip, cy + Math.sin(at) * tip, 1]);
      if (r() < 0.6) {
        const dr = tip + 2 + r() * R * 0.5;
        pl.dot(cx + Math.cos(at) * dr, cy + Math.sin(at) * dr, 0.6 + r() * 1.3, true);
      }
    }
  }
  pl.ink(spline(ctrl, true, 0.45), { rough: 0.4 });
  for (let i = 0; i < drips; i++) {
    const x = cx - R * 0.45 + r() * R * 0.9;
    const y0 = cy + R * 0.4;
    const len = 10 + r() * 16;
    pl.ridge([[x, y0], [x + (r() - 0.5), y0 + len]], 2.2 + r() * 1.2, "base", 0, 0.6);
    pl.dot(x, y0 + len + 0.6, 1.4, true);
  }
}

function futureDominators(pl: Plate) {
  const r = pl.r;
  pl.chip(0);
  pl.clip(rough(rrect(5, 5, 118, 118, 11), r, 0.3, 0), () => {
    splash(pl, 34, 34, 22, 3);
    splash(pl, 106, 106, 9, 0);
  });
  // Twin tails, carved along the strands so they print lighter than the dress.
  const tails: C[][] = [
    [[55, 24], [44, 30], [37, 44], [36, 58], [29, 74], [30, 90], [21, 106]],
    [[73, 24], [84, 30], [91, 44], [92, 58], [99, 74], [98, 90], [107, 106]],
  ];
  for (const t of tails) {
    const line = spline(t);
    const tp = pl.ink(taper(line, 17, r, "base", 0.06), { rough: 0.4, sep: 2.6 });
    const s = t[0][0] < 64 ? 1 : -1;
    pl.clip(tp, () => {
      for (let k = -3; k <= 3; k++) pl.cut(shift(line, k * 2.1 * s, 0).slice(3 + Math.abs(k) * 5 + Math.floor(r() * 6), -(4 + Math.floor(r() * 10))), 1.1, "tip");
    });
  }
  // Katana across the right side, held low at the hip.
  const blade = spline([[89, 62], [101, 41], [111, 23], [119, 9]]);
  pl.ink(taper(blade, 5.2, r, "base", 0.05), { rough: 0.2, sep: 2.4 });
  pl.cut(blade.slice(3, -6), 1, "tip");
  pl.ink(ellipse(87.6, 64.4, 4.8, 2.1, -58), { rough: 0, sep: 1.6 });
  pl.ridge([[86, 67], [78.5, 80]], 4.4, "flat", 1.8);
  for (let i = 1; i < 5; i++) {
    const x = 86 + (78.5 - 86) * (i / 5);
    const y = 67 + (80 - 67) * (i / 5);
    pl.paper([[x - 1.2, y], [x, y - 1.1], [x + 1.2, y], [x, y + 1.1]], { rough: 0 });
  }
  // Legs and shoes.
  for (const x of [58.5, 69.5]) {
    const o = x < 64 ? -1 : 1;
    pl.ridge([[x, 86], [x + o, 111]], 4.6, "flat", 2.2);
    pl.ink(rrect(x - 4 + o * 1.5, 109.5, 8, 4.6, 2.2), { rough: 0.3, sep: 2 });
  }
  // Frilled dress: two tiers with scalloped hems.
  const tier = (y0: number, y1: number, x0: number, x1: number, scallops: number) => {
    const hem: C[] = [];
    for (let i = 0; i <= scallops; i++) {
      const x = x1 - ((x1 - x0) * i) / scallops;
      hem.push([x, y1, 1]);
      if (i < scallops) hem.push([x - (x1 - x0) / scallops / 2, y1 + 3.2]);
    }
    const top = 64 - (x1 - x0) * 0.2;
    const p = pl.ink(spline([[128 - top, y0, 1], [top, y0, 1], ...hem.reverse()], true, 0.35), { sep: 2.4, rough: 0.35 });
    pl.clip(p, () => {
      for (let i = 0; i < scallops; i++) {
        const x = x1 - ((x1 - x0) * (i + 0.5)) / scallops;
        pl.cut(ellipse(x, y1 - 1, (x1 - x0) / scallops / 2 - 0.8, 2.6, 0, 20, 160), 1);
      }
    });
  };
  tier(58, 78, 48, 80, 5);
  tier(74, 89, 42, 86, 6);
  pl.ink(spline([[56, 45], [72, 45], [70, 60], [58, 60]], true, 0.2), { sep: 2.4 });
  pl.ink(ellipse(55, 48, 5, 4.4), { sep: 2 });
  pl.ink(ellipse(73, 48, 5, 4.4), { sep: 2 });
  // Arms: one at her side, one on the hilt.
  pl.outlined(taper(spline([[53, 52], [50, 62], [50, 72]]), 3.2, r, "flat"), 1, { rough: 0 });
  pl.outlined(taper(spline([[75, 52], [80, 62], [82, 72]]), 3.2, r, "flat"), 1, { rough: 0 });
  pl.outlined(ellipse(82.4, 73.6, 2.6, 2.4), 1, { rough: 0 });
  pl.outlined([[64, 47], [59, 44], [59, 50]], 0.8, { rough: 0 });
  pl.outlined([[64, 47], [69, 44], [69, 50]], 0.8, { rough: 0 });
  // Head: crown of hair, a plain face, jagged fringe, ties.
  pl.ink(ellipse(64, 30, 11.5, 12), { sep: 2.4, rough: 0.4 });
  pl.outlined(ellipse(64, 35, 6.8, 7.6), 1, { rough: 0.3 });
  pl.ink(spline([[54, 32, 1], [55, 22], [64, 18], [73, 22], [74, 32, 1], [70.5, 28], [68, 33, 1], [66, 28], [63, 32, 1], [61, 28], [58, 32, 1], [57, 28]], true), { rough: 0.3 });
  pl.cut(spline([[57, 22], [64, 19.5], [71, 22]]), 1.1);
  for (const x of [53, 75]) {
    pl.ink(star(x, 24, 4.8, 1.8, 2, x < 64 ? 20 : -20), { sep: 1.6, rough: 0 });
    pl.paper(ellipse(x, 24, 1, 1), { rough: 0 });
  }
}

// ---------- 5. Ascension to Heaven ----------

function ascension(pl: Plate) {
  const r = pl.r;
  pl.chip(0);
  const block = pl.ink(BLOCK, { rough: 0.6 });
  const S: V = [64, 50];
  pl.clip(block, () => {
    // Rays gouged out from the sun, widening as they go.
    const rays = 30;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU + r() * 0.04;
      const far = 96;
      const near = 35 + (i % 2) * 5;
      pl.cut([[S[0] + Math.cos(a) * far, S[1] + Math.sin(a) * far], [S[0] + Math.cos(a) * near, S[1] + Math.sin(a) * near]], i % 2 ? 2.6 : 4, "base", 0, 0.1);
    }
    // The sun: a cleared corona around a disc ringed with cuts.
    const ring = 4.4;
    pl.cut([...ellipse(S[0], S[1], 30), ellipse(S[0], S[1], 30)[0]], ring, "flat");
    for (const [rr, w] of [[24, 1.4], [18.5, 1.1]] as const) {
      for (let a = r() * 30; a < 360; a += 45) pl.cut(ellipse(S[0], S[1], rr, rr, 0, a, a + 32), w);
    }
  });
  // Clouds billowing across the bottom corners.
  pl.clip(rough(BLOCK, r, 0.3), () => {
    for (const [x, y, rr] of [[10, 112, 12], [28, 110, 11], [100, 110, 11], [118, 112, 12], [18, 122, 12], [110, 123, 13]] as const) {
      const p = pl.outlined(ellipse(x, y, rr, rr * 0.75), 1.3, { rough: 0.4 });
      pl.clip(p, () => {
        for (const k of [0.62, 0.32]) pl.ridge(ellipse(x, y + rr * 0.2, rr * k * 1.1, rr * k * 0.8, 0, 200, 340), 1);
      });
    }
  });
  // The white bird, printed as one cleared silhouette: wings raised with
  // primaries fanned from the wrist, a short neck, head in profile, crest
  // streaming back, and three tail plumes.
  pl.group("translate(64 66) scale(0.88) translate(-64 -62)", () => bird(pl));
}

function bird(pl: Plate) {
  const r = pl.r;
  const at = (o: V, deg: number, len: number): V => [o[0] + Math.cos(rad(deg)) * len, o[1] + Math.sin(rad(deg)) * len];
  const midAngle = (a: number, b: number) => a + (((b - a + 540) % 360) - 180) / 2;
  const W: V = [37, 29];
  const prim: [number, number][] = [[-98, 26], [-118, 29], [-139, 30], [-160, 30], [178, 28], [158, 25]];
  const secBase: V[] = [[38, 38], [43, 46], [49, 53], [55, 59]];
  const sec: [number, number][] = [[148, 22], [132, 21], [116, 19], [100, 16]];
  const half: V[][] = [];
  half.push(spline([[61, 54], [53, 44], [40, 27], [32, 30], [26, 44], [32, 58], [46, 64], [58, 66]], true));
  for (const [a, l] of prim) half.push(taper([at(W, a, 3), at(W, a, l)], 8.6, r, "mid"));
  sec.forEach(([a, l], i) => half.push(taper([secBase[i], at(secBase[i], a, l)], 9, r, "mid")));
  const plumes: C[][] = [
    [[61, 76], [56, 90], [46, 102], [36, 106], [31, 98]],
    [[64, 78], [65, 94], [61, 106], [64, 119]],
    [[67, 76], [72, 90], [82, 102], [92, 106], [97, 98]],
  ];
  const plumeLines = plumes.map((p) => spline(p));
  const parts: V[][] = [
    ...half,
    ...half.map((p) => mirrorX(p)),
    spline([[64, 46], [70, 53], [71, 66], [67, 77], [64, 84, 1], [61, 77], [57, 66], [58, 53]], true),
    taper(spline([[64, 54], [64, 40], [66, 29]]), 7.6, r, "flat"),
    ellipse(67, 26.5, 5, 4.6),
    [[71, 24], [79, 20.5], [73, 29]],
    ...[[52, 17], [55, 12], [59, 9.5]].map(([x1, y1]) => taper(spline([[65, 26], [59 + (x1 - 59) * 0.4, 19], [x1, y1]]), 3, r, "base", 0.25)),
    ...plumeLines.map((l) => taper(l, 10, r, "plume")),
  ];
  const sil = pl.silhouette(parts, 1.5, 0.25);
  pl.clip(sil, () => {
    for (const left of [true, false]) {
      const X = (v: V): V => (left ? v : [128 - v[0], v[1]]);
      prim.forEach(([a, l], i) => {
        if (i < prim.length - 1) pl.ridge([X(at(W, midAngle(a, prim[i + 1][0]), 6)), X(at(W, midAngle(a, prim[i + 1][0]), Math.min(l, prim[i + 1][1]) * 0.8))], 1.1, "base", 0, 0.3);
      });
      sec.forEach(([a, l], i) => {
        if (i < sec.length - 1) pl.ridge([X(at(secBase[i], a - 10, 4)), X(at(secBase[i], a - 12, l * 0.8))], 1.1, "base", 0, 0.3);
      });
      for (const [cx, cy] of [[50, 47], [43, 39], [37, 31]]) {
        const c = X([cx, cy]);
        pl.ridge(ellipse(c[0], c[1], 4.4, 3, left ? -45 : 45, 25, 155), 0.9);
      }
    }
    for (const y of [58, 65, 72]) pl.ridge(ellipse(64, y - 3, 4.2, 2.8, 0, 30, 150), 0.8);
    for (const line of plumeLines) {
      pl.ridge(line.slice(4, -10), 0.8, "tip");
      const e = line[line.length - 8];
      pl.ridge([...ellipse(e[0], e[1], 2.4), ellipse(e[0], e[1], 2.4)[0]], 1.1, "flat");
    }
  });
}

// ---------- 6. Mario Paint ----------

function marioPaint(pl: Plate) {
  const r = pl.r;
  pl.chip(2);
  const lines = [34, 45, 56, 67, 78];
  for (const y of lines) pl.ridge([[11, y + (r() - 0.5) * 0.6], [117, y + (r() - 0.5) * 0.6]], 2, "flat");
  pl.ridge([[117, 33], [117, 79]], 2.2, "flat");
  // Treble clef, its spiral round the G line.
  const clef = spline([[25, 62], [29, 65], [27, 71], [21, 72], [16, 67], [16, 59], [21, 51], [28, 43], [32, 34], [31, 23], [27, 17], [24, 21], [23, 31], [24, 46], [26, 62], [27, 78], [27, 86], [24, 91], [19, 90]]);
  pl.ink(taper(clef, 4.4, r, "flat"), { rough: 0.2, sep: 2.6 });
  pl.ink(ellipse(19.5, 87.5, 3.3), { rough: 0.3, sep: 1.6 });
  // The composer's stamps, sitting on the staff like notes.
  pl.ink(star(43, 67, 11.5, 5, 5, -90), { sep: 3.5, rough: 0.3 });
  const inner = star(43, 67.5, 5.2, 2.4, 5, -90);
  pl.cut([...inner, inner[0]], 1.2, "flat");
  const heart = (cx: number, cy: number, s: number): V[] =>
    spline([[cx, cy - 6 * s], [cx + 4 * s, cy - 11 * s], [cx + 10 * s, cy - 11 * s], [cx + 13 * s, cy - 5 * s], [cx + 10 * s, cy + 3 * s], [cx, cy + 11 * s, 1], [cx - 10 * s, cy + 3 * s], [cx - 13 * s, cy - 5 * s], [cx - 10 * s, cy - 11 * s], [cx - 4 * s, cy - 11 * s]], true);
  pl.ink(heart(65, 46, 1), { sep: 3.5 });
  pl.cut(spline([[55.5, 43], [56, 38.5], [59.5, 37]]), 1.5);
  for (let i = 0; i < 5; i++) {
    const a = rad(-90 + i * 72);
    pl.ink(ellipse(87 + Math.cos(a) * 6.4, 56 + Math.sin(a) * 6.4, 5, 4.2, i * 72 - 90), { sep: 3.5, rough: 0.3 });
  }
  pl.ink(ellipse(87, 56, 5), { rough: 0 });
  pl.cut([...ellipse(87, 56, 3.4), ellipse(87, 56, 3.4)[0]], 1.3, "flat");
  // Sailboat.
  pl.ink([[97, 40], [117, 40], [113, 46], [101, 46]], { sep: 3.5, rough: 0.4 });
  pl.ink([[107.5, 20], [107.5, 38], [97, 38]], { sep: 3, rough: 0.3 });
  pl.ink([[109.5, 23], [109.5, 38], [116, 38]], { sep: 3, rough: 0.3 });
  // The stamp palette along the bottom.
  for (let i = 0; i < 6; i++) {
    const x = 15 + i * 17.3;
    const p = pl.ink(rrect(x, 96, 14, 14, 3), { rough: 0.4 });
    const cx = x + 7;
    const cy = 103;
    pl.clip(p, () => {
      if (i === 0) pl.paper(star(cx, cy + 0.5, 5, 2.2), { rough: 0 });
      else if (i === 1) pl.paper(heart(cx, cy, 0.42), { rough: 0 });
      else if (i === 2) {
        for (let k = 0; k < 5; k++) {
          const a = rad(-90 + k * 72);
          pl.paper(ellipse(cx + Math.cos(a) * 2.6, cy + Math.sin(a) * 2.6, 1.9, 1.6, k * 72 - 90), { rough: 0 });
        }
      } else if (i === 3) {
        pl.paper([[cx - 4.5, cy + 1.5], [cx + 4.5, cy + 1.5], [cx + 3, cy + 4], [cx - 3, cy + 4]], { rough: 0 });
        pl.paper([[cx, cy - 5], [cx, cy + 0.5], [cx - 4, cy + 0.5]], { rough: 0 });
      } else if (i === 4) {
        pl.paper(ellipse(cx - 1, cy + 2.6, 2.2, 1.7, -20), { rough: 0 });
        pl.paper([[cx + 0.6, cy + 2.4], [cx + 0.6, cy - 5], [cx + 1.8, cy - 5], [cx + 1.8, cy + 2.4]], { rough: 0 });
      } else {
        pl.paper(ellipse(cx, cy, 4.2), { rough: 0 });
        pl.ink(ellipse(cx, cy, 1.8), { rough: 0 });
      }
    });
  }
}

// ---------- 7. Duplicity ----------

function hooded(pl: Plate, flip: boolean, inkFigure: boolean) {
  const m = (pts: C[]): C[] => (flip ? mirrorC(pts) : pts);
  const mv = (pts: V[]): V[] => (flip ? mirrorX(pts) : pts);
  const body: C[] = [[23, 11, 1], [34, 13], [44, 18], [50, 27], [52, 38], [49, 46], [54, 52], [57, 66], [58, 84], [60, 102], [62, 115, 1], [52, 113], [42, 116], [31, 113], [18, 115, 1], [19, 98], [16, 80], [16, 62], [19, 48], [21, 34], [21, 22]];
  const opening: C[] = [[40, 21], [47, 27], [50, 37], [46, 45], [40, 42], [37, 32]];
  const fig = inkFigure ? pl.ink(spline(m(body), true, 0.45), { rough: 0.5 }) : pl.paper(spline(m(body), true, 0.45), { rough: 0.5 });
  const line = (pts: V[], w: number) => (inkFigure ? pl.cut(pts, w, "mid") : pl.ridge(pts, w, "mid"));
  pl.clip(fig, () => {
    for (const f of [[[38, 52], [36, 80], [34, 112]], [[46, 55], [47, 84], [50, 112]], [[29, 50], [26, 82], [26, 112]]] as C[][]) line(spline(m(f)), 2);
    pl.hatch(mv([[8, 14], [25, 14], [25, 120], [8, 120]]), { angle: flip ? 94 : 86, gap: 2.8, w: 1, dash: [10, 26], ink: !inkFigure, jitter: 2 });
    line(spline(m([[51, 56], [44, 64], [52, 70]])), 1.6);
    line(spline(m([[24, 14], [30, 24], [34, 40], [34, 48]])), 1.4);
  });
  // The empty hood: a dark void.
  const op = spline(m(opening), true);
  if (inkFigure) pl.cut([...op, op[0], op[1]], 1.9, "flat");
  else pl.ink(op, { rough: 0.4 });
}

function duplicity(pl: Plate) {
  const r = pl.r;
  pl.chip(0);
  pl.clip(rough(rrect(3, 3, 122, 122, 13), r, 0.3, 0), () => {
    // The right half is the reverse print.
    pl.ink(spline([[64, -2], [63, 30], [65, 64], [63, 96], [64, 130], [130, 130, 1], [130, -2, 1]], true, 0.3), { rough: 0.5 });
    for (const y of [113, 117, 121]) {
      const w = 1.2 - (y - 113) * 0.08;
      pl.ridge([[6, y], [62, y + 0.5]], w);
      pl.cut([[66, y + 0.5], [122, y]], w);
    }
  });
  hooded(pl, false, true);
  hooded(pl, true, false);
}

// ---------- 8. Echoes of Memoria ----------

const GIRL: { hair: C[]; dress: C[] } = {
  hair: [[64, 18], [71, 20], [75, 27], [76, 35], [79, 42], [83, 47, 1], [75, 46], [71, 42], [57, 42], [53, 46], [45, 47, 1], [49, 42], [52, 35], [53, 27], [57, 20]],
  dress: [[59, 43], [69, 43], [72, 48], [69, 58], [73, 70], [79, 84], [82, 93, 1], [73, 95], [64, 93], [55, 95], [46, 93, 1], [49, 84], [55, 70], [59, 58], [56, 48]],
};

function girlParts(dx = 0, dy = 0, k = 1): V[][] {
  const t = (pts: V[]) => pts.map(([x, y]) => [64 + dx + (x - 64) * k, 95 + dy + (y - 95) * k] as V);
  return [t(spline(GIRL.hair, true)), t(spline(GIRL.dress, true)), t(ellipse(64, 30, 5.6, 6.6))];
}

function echoes(pl: Plate) {
  const r = pl.r;
  pl.chip(2);
  const C0: V = [64, 60];
  const disc = pl.ink(ellipse(C0[0], C0[1], 47), { rough: 0.5 });
  pl.clip(disc, () => {
    // Her echoes: only their outlines are cut, fainter the further out.
    for (const [dx, k, w, dash] of [[-33, 0.7, 0.8, "3 2.2"], [33, 0.7, 0.8, "3 2.2"], [-19, 0.85, 1.3, ""], [19, 0.85, 1.3, ""]] as const) {
      const paths = girlParts(dx, -4 * (1 - k) * 10, k).map((p) => `<path d="${d(rough(p, r, 0.3, 0))}"/>`).join("");
      pl.parts.push(`<g fill="${pl.PAPER}" stroke="${pl.PAPER}" stroke-width="${w * 2}" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}>${paths}</g><g fill="${pl.INK}">${paths}</g>`);
    }
    for (let a = r() * 30; a < 360; a += 40) pl.cut(ellipse(C0[0], C0[1], 43.5, 43.5, 0, a, a + 30 + r() * 6), 1.2);
  });
  pl.ridge([[36, 113], [92, 113]], 2.4);
  pl.ridge([[46, 117.5], [82, 117.5]], 1.6);
  // The girl in white.
  for (const x of [60, 68]) pl.outlined(taper([[x, 92], [x + (x < 64 ? -0.5 : 0.5), 107]], 3.6, r, "flat"), 1.2, { rough: 0 });
  const sil = pl.silhouette(girlParts().slice(0, 2), 1.5, 0.3);
  pl.clip(sil, () => {
    for (const [x0, x1] of [[55, 49], [58, 54], [70, 74], [73, 79]]) pl.ridge(spline([[x0, 30], [x0 + (x1 - x0) * 0.3, 38], [x1, 45]]), 0.8, "tip");
    for (const x of [59, 64, 69]) pl.ridge(spline([[x, 66], [x + (x - 64) * 0.7, 80], [x + (x - 64) * 1.3, 93]]), 0.9, "tip");
    pl.ridge(spline([[47, 91], [55, 93], [64, 91], [73, 93], [81, 91]]), 1.1, "flat");
    pl.ridge(spline([[58.5, 59], [64, 60.5], [69.5, 59]]), 1.4, "flat");
  });
  for (const x of [59, 69]) pl.ink(rrect(x - 3.4 + (x < 64 ? -0.5 : 0.5), 106.5, 6.8, 4, 1.8), { rough: 0.3 });
  pl.outlined(ellipse(64, 30, 5.6, 6.6), 1, { rough: 0.2 });
  pl.ink(spline([[57.5, 28, 1], [58, 22], [64, 19.5], [70, 22], [70.5, 28, 1], [67, 24.5], [64, 26, 1], [61, 24.5]], true), { rough: 0.2 });
  // A ribbon in her hair.
  pl.ink([[71, 21], [76, 17.5], [76.5, 24]], { rough: 0, sep: 1.2 });
  pl.ink([[71, 21], [67.5, 16], [66, 21.5]], { rough: 0, sep: 1.2 });
  // Arms bent to hold the hourglass at her chest.
  for (const s of [-1, 1]) pl.ridge(spline([[64 + s * 6.5, 45], [64 + s * 8.5, 52], [64 + s * 5.5, 55]]), 1.2, "flat");
  pl.ink(rrect(57.5, 42, 13, 2.6, 1.2), { rough: 0, sep: 1.4 });
  pl.ink(rrect(57.5, 58, 13, 2.6, 1.2), { rough: 0, sep: 1.4 });
  pl.ink(spline([[59, 44.6], [69, 44.6], [65, 51.3, 1], [69, 58], [59, 58], [63, 51.3, 1]], true, 0.2), { rough: 0, sep: 1.4 });
  pl.paper([[61.5, 46.3], [66.5, 46.3], [64, 49.6]], { rough: 0 });
  pl.paper([[64, 53.5], [65.8, 57], [62.2, 57]], { rough: 0 });
}

// ---------- printed from artwork ----------

/** Cards with a print made from the real artwork (scripts/art/linocut.py). */
const SCENE_IMAGE: Partial<Record<SceneId, string>> = {
  onceForgotten: "/images/packs/scene/onceForgotten.webp",
  futureDominators: "/images/packs/scene/futureDominators.webp",
  duplicity: "/images/packs/scene/duplicity.webp",
  echoes: "/images/packs/scene/echoes.webp",
  makiba: "/images/packs/scene/makiba.webp",
  aiae: "/images/packs/scene/aiae.webp",
  scatteredFaith: "/images/packs/scene/scatteredFaith.webp",
  foolMoon: "/images/packs/scene/foolMoon.webp",
  moonGate: "/images/packs/scene/moonGate.webp",
  lostRequiem: "/images/packs/scene/lostRequiem.webp",
  purplePalace: "/images/packs/scene/purplePalace.webp",
};

/** Who drew the artwork a card is printed from, as plain names for a small
    credit line (the UI supplies the "Art:" label). Null where the card is
    drawn here or the illustrator is not known. */
export const SCENE_CREDITS: Record<SceneId, string | null> = {
  makiba: null,
  tree: null,
  onceForgotten: "Creameries, Minerva Rin, enviyu, Hiro",
  futureDominators: null,
  ascension: null,
  marioPaint: null,
  duplicity: "pocap0ca, xiemon",
  echoes: "pineapple",
  aiae: null,
  scatteredFaith: null,
  foolMoon: null,
  moonGate: null,
  lostRequiem: null,
  purplePalace: null,
};

// ---------- component ----------

/* Cards printed only from artwork fall back to a blank chip. */
const DRAW: Partial<Record<SceneId, (pl: Plate) => void>> = {
  makiba,
  tree,
  onceForgotten,
  futureDominators,
  ascension,
  marioPaint,
  duplicity,
  echoes,
};

const built = new Map<SceneId, string>();

function sceneMarkup(id: SceneId): string {
  let m = built.get(id);
  if (!m) {
    const pl = new Plate(id);
    const draw = DRAW[id];
    if (draw) draw(pl);
    else pl.chip(0);
    m = pl.markup();
    built.set(id, m);
  }
  return m;
}

export function SceneArt({ id, size = 220, className }: { id: SceneId; size?: number; className?: string }) {
  const uid = `sa${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [failed, setFailed] = useState<string | null>(null);
  const src = SCENE_IMAGE[id];
  if (src && failed !== src) {
    // The WebP carries the chip itself (transparent outside it), so it sits
    // exactly where the SVG would.
    return <img src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} decoding="async" className={className} onError={() => setFailed(src)} />;
  }
  const html = sceneMarkup(id).replaceAll("§", `${uid}-`);
  return <svg viewBox="0 0 128 128" width={size} height={size} aria-hidden="true" className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
