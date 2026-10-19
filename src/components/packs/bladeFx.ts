/* The particles a blade throws (packBlades.ts): sprites from Kenney's
   Particle Pack (CC0, kenney.nl), white with alpha, tinted per blade and
   drawn additively so overlapping light adds up the way light does. One
   canvas draws them all, for the pack stage and the small previews alike. */

const SPRITE_ROOT = "/images/packs/fx/";

export type SpriteId =
  | "slash-04" | "scratch-01" | "star-06" | "star-07" | "flare-01" | "circle-05" | "circle-02" | "magic-05" | "trace-07"
  | "spark-01" | "spark-05" | "spark-06" | "spark-07" | "flame-05" | "fire-01" | "smoke-04";

const images = new Map<SpriteId, HTMLImageElement>();
const tinted = new Map<string, HTMLCanvasElement>();

export function preloadSprites(ids: readonly SpriteId[]): void {
  if (typeof window === "undefined") return;
  for (const id of ids) {
    if (images.has(id)) continue;
    const image = new Image();
    image.decoding = "async";
    image.src = spriteUrl(id);
    images.set(id, image);
  }
}

/* The sprite's image once it has loaded, for renderers that upload it. */
export function spriteImage(id: SpriteId): HTMLImageElement | null {
  const image = images.get(id);
  if (!image) {
    preloadSprites([id]);
    return null;
  }
  return image.complete && image.naturalWidth ? image : null;
}

/* The sprite in one colour, made once and kept. Null until the image is in. */
function tintedSprite(id: SpriteId, color: string): HTMLCanvasElement | null {
  const key = `${id}|${color}`;
  const cached = tinted.get(key);
  if (cached) return cached;
  const image = images.get(id);
  if (!image) {
    preloadSprites([id]);
    return null;
  }
  if (!image.complete || !image.naturalWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  tinted.set(key, canvas);
  return canvas;
}

export interface ParticleSpec {
  sprite: SpriteId;
  color: string;
  /* Colours it passes through over its life, first to last, instead of one:
     fire cooling from white to red. */
  ramp?: readonly string[];
  /* Sideways sway in px/s, a slow wave per particle: rising heat. */
  wobble?: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  /* px/s² pulling down (negative floats up). */
  gravity?: number;
  /* Fraction of speed lost per second. */
  drag?: number;
  /* Size in px at birth and at death; the sprite is square unless stretched. */
  size: number;
  endSize?: number;
  /* Width over height of the drawn sprite, for arcs and streaks. */
  aspect?: number;
  /* Turns the sprite along its velocity, lengthened with speed. */
  stretch?: number;
  rotation?: number;
  spin?: number;
  life: number;
  alpha?: number;
  /* Seconds it takes to reach full alpha. */
  fadeIn?: number;
  /* Random brightness every frame, for lightning. */
  flicker?: boolean;
  /* Drawn normally instead of added: smoke. */
  normal?: boolean;
  delay?: number;
}

interface Particle extends Required<Omit<ParticleSpec, "delay">> {
  born: number;
  phase: number;
}

export interface Flash {
  color: string;
  alpha: number;
  life: number;
  born: number;
  flicker: boolean;
}

/* One particle as it is drawn this frame: a sprite in one colour, centred
   at x, y, w by h, turned by angle. `heat` runs 1 to 0 over a ramped
   (fire) particle's life, for renderers that make hot light brighter. */
export interface FxItem {
  sprite: SpriteId;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  alpha: number;
  additive: boolean;
  heat: number;
}

export interface FxFlash {
  color: string;
  alpha: number;
}

export function spriteUrl(id: SpriteId): string {
  return `${SPRITE_ROOT}${id}.png`;
}

export class BladeFx {
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  private last = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  get alive(): boolean {
    return this.particles.length > 0 || this.flashes.length > 0;
  }

  emit(spec: ParticleSpec): void {
    if (this.particles.length > 420) return;
    this.particles.push({
      vx: 0,
      vy: 0,
      gravity: 0,
      drag: 0,
      endSize: spec.size,
      aspect: 1,
      stretch: 0,
      rotation: 0,
      spin: 0,
      alpha: 1,
      fadeIn: 0,
      flicker: false,
      normal: false,
      ramp: [],
      wobble: 0,
      ...spec,
      born: this.clock() + (spec.delay ?? 0) * 1000,
      phase: Math.random() * Math.PI * 2,
    });
  }

  flash(color: string, alpha: number, life: number, flicker = false): void {
    this.flashes.push({ color, alpha, life, born: this.clock(), flicker });
  }

  clear(): void {
    this.particles = [];
    this.flashes = [];
  }

  /* Moves everything on to now and lays out what each particle and flash
     looks like this frame, for whichever renderer draws it. */
  frame(): { items: FxItem[]; flashes: FxFlash[] } {
    const now = this.clock();
    const dt = Math.min(0.05, Math.max(0, (now - (this.last || now)) / 1000));
    this.last = now;

    const flashes: FxFlash[] = [];
    for (const flash of this.flashes) {
      const k = (now - flash.born) / 1000 / flash.life;
      if (k < 0 || k >= 1) continue;
      flashes.push({ color: flash.color, alpha: flash.alpha * (1 - k) * (flash.flicker ? 0.4 + Math.random() * 0.6 : 1) });
    }
    this.flashes = this.flashes.filter((flash) => now - flash.born < flash.life * 1000);

    const items: FxItem[] = [];
    const keep: Particle[] = [];
    for (const p of this.particles) {
      const age = (now - p.born) / 1000;
      if (age < 0) {
        keep.push(p);
        continue;
      }
      if (age >= p.life) continue;
      keep.push(p);
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + p.gravity * dt;
      p.x += (p.vx + (p.wobble ? Math.sin(age * 7 + p.phase) * p.wobble : 0)) * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      const k = age / p.life;
      const color = p.ramp.length ? p.ramp[Math.min(p.ramp.length - 1, Math.floor(k * p.ramp.length))] : p.color;
      const fade = p.fadeIn > 0 && age < p.fadeIn ? age / p.fadeIn : 1 - k * k;
      const alpha = p.alpha * fade * (p.flicker ? 0.35 + Math.random() * 0.65 : 1);
      if (alpha <= 0.01) continue;
      const size = p.size + (p.endSize - p.size) * k;
      let w = size * p.aspect;
      let h = size;
      let angle = p.rotation;
      if (p.stretch > 0) {
        const speed = Math.hypot(p.vx, p.vy);
        angle = Math.atan2(p.vy, p.vx);
        // a streak lies along its path: long side first
        w = size * (1 + (speed / 300) * p.stretch);
        h = size * 0.35;
      }
      items.push({ sprite: p.sprite, color, x: p.x, y: p.y, w, h, angle, alpha: Math.min(1, alpha), additive: !p.normal, heat: p.ramp.length ? 1 - k : 0 });
    }
    this.particles = keep;
    return { items, flashes };
  }

  /* Steps and draws everything onto a 2D ctx (already transformed to CSS px). */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const { items, flashes } = this.frame();
    for (const flash of flashes) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = flash.alpha;
      ctx.fillStyle = flash.color;
      ctx.fillRect(0, 0, width, height);
    }
    for (const item of items) {
      const sprite = tintedSprite(item.sprite, item.color);
      if (!sprite) continue;
      ctx.globalCompositeOperation = item.additive ? "lighter" : "source-over";
      ctx.globalAlpha = item.alpha;
      ctx.save();
      ctx.translate(item.x, item.y);
      if (item.angle) ctx.rotate(item.angle);
      ctx.drawImage(sprite, -item.w / 2, -item.h / 2, item.w, item.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
