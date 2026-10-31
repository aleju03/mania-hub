import { CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";

/* Layer themes: the no-code way to make a profile theme. A stack of layers
   (a background, images, particles, fog, glow, stars) plus a finish, turned
   into the same `theme()` GLSL a code theme is, so it is checked, guarded,
   costed, rendered and taken down exactly like one.

   layersToGlsl() is pure and versioned. A saved theme keeps the generator
   version it was made with (the backend stores it), and this file only ever
   adds versions: a new one never changes how an old theme looks.

   The editor runs a "live" variant of the same code, where every number is
   read from a uniform array instead of written in, so dragging a slider only
   updates the array and never recompiles. Structure (which layers, their
   order, blend, shape, images) is the only thing that recompiles. The live
   code is the editor's own and never leaves the browser; what is saved is
   the plain variant, with the numbers written in. */

export const LAYER_GENERATOR_VERSION = 1;
export const LAYERS_MAX = 8;

export type LayerBlend = "normal" | "add" | "screen" | "multiply";
export const LAYER_BLENDS: readonly LayerBlend[] = ["normal", "add", "screen", "multiply"];

interface LayerBase {
  id: string;
  name: string;
  hidden?: boolean;
  /** 0..1 */
  opacity: number;
  blend: LayerBlend;
  /** How far it drifts as the page scrolls: 0 stays put, 1 moves with the page. */
  depth: number;
  /** How far it leans toward the pointer, 0..1. */
  follow: number;
}

export interface BackgroundLayer extends LayerBase {
  kind: "background";
  fill: "solid" | "linear" | "radial" | "image";
  color: string;
  color2: string;
  /** Degrees, for a linear fill. */
  angle: number;
  image: string | null;
  zoom: number;
  x: number;
  y: number;
  brightness: number;
}

export interface ImageLayer extends LayerBase {
  kind: "image";
  image: string | null;
  /** Centre, in canvas heights from the middle, y up. */
  x: number;
  y: number;
  /** Height, in canvas heights. */
  size: number;
  /** Degrees, counter-clockwise. */
  angle: number;
  /** Turns a second. */
  spin: number;
  sway: number;
  swaySpeed: number;
  brightness: number;
}

export type ParticleShape = "dot" | "soft" | "ring" | "streak" | "image";
export const PARTICLE_SHAPES: readonly ParticleShape[] = ["dot", "soft", "ring", "streak", "image"];

export interface ParticlesLayer extends LayerBase {
  kind: "particles";
  shape: ParticleShape;
  image: string | null;
  color: string;
  color2: string;
  /** Share of the grid's cells with a particle, 0..1. */
  amount: number;
  /** Cells per canvas height: more is more, smaller particles. */
  scale: number;
  /** Of a cell, 0..1. */
  size: number;
  sizeVariety: number;
  speed: number;
  /** Degrees: 270 falls, 90 rises. */
  direction: number;
  wander: number;
  twinkle: number;
}

export interface FogLayer extends LayerBase {
  kind: "fog";
  color: string;
  scale: number;
  speed: number;
  direction: number;
  density: number;
  softness: number;
  /** Keeps it to the bottom of the screen, 0..1. */
  low: number;
}

export interface GlowLayer extends LayerBase {
  kind: "glow";
  color: string;
  x: number;
  y: number;
  radius: number;
  rays: number;
  rayCount: number;
  spin: number;
  pulse: number;
  pulseSpeed: number;
}

export interface StarsLayer extends LayerBase {
  kind: "stars";
  color: string;
  scale: number;
  density: number;
  brightness: number;
}

export type Layer = BackgroundLayer | ImageLayer | ParticlesLayer | FogLayer | GlowLayer | StarsLayer;
export type LayerKind = Layer["kind"];
export const LAYER_KINDS: readonly LayerKind[] = ["background", "image", "particles", "fog", "glow", "stars"];

export interface LayerFinish {
  grain: number;
  scanlines: number;
  vignette: number;
  saturation: number;
  exposure: number;
  tint: string;
  tintAmount: number;
}

export interface LayerDoc {
  v: 1;
  /** Bottom first: the last one draws on top. */
  layers: Layer[];
  finish: LayerFinish;
}

/* --- Making and reading documents ---------------------------------------- */

let idCounter = 0;
export const newLayerId = () => `l${Date.now().toString(36)}${(idCounter++).toString(36)}`;

const BASE: Omit<LayerBase, "id" | "name"> = { opacity: 1, blend: "normal", depth: 0, follow: 0 };

export function newLayer(kind: LayerKind, name: string): Layer {
  const base = { ...BASE, id: newLayerId(), name };
  switch (kind) {
    case "background":
      return { ...base, kind, fill: "linear", color: "#0b0a1f", color2: "#2a1240", angle: 90, image: null, zoom: 1, x: 0, y: 0, brightness: 1 };
    case "image":
      return { ...base, kind, image: null, x: 0, y: 0, size: 0.5, angle: 0, spin: 0, sway: 0.01, swaySpeed: 0.6, brightness: 1, follow: 0.3 };
    case "particles":
      return { ...base, kind, shape: "soft", image: null, color: "#ffd9f0", color2: "#9fd8ff", amount: 0.35, scale: 9, size: 0.18, sizeVariety: 0.6, speed: 0.04, direction: 270, wander: 0.4, twinkle: 0.3, depth: 0.15, follow: 0.15 };
    case "fog":
      return { ...base, kind, color: "#5b3a8c", scale: 1.6, speed: 0.04, direction: 0, density: 0.45, softness: 0.5, low: 0.4, opacity: 0.7 };
    case "glow":
      return { ...base, kind, blend: "add", color: "#ff7ab8", x: 0.35, y: 0.2, radius: 0.12, rays: 0.25, rayCount: 12, spin: 0.02, pulse: 0.15, pulseSpeed: 0.6 };
    case "stars":
      return { ...base, kind, blend: "add", color: "#dfe8ff", scale: 70, density: 0.12, brightness: 0.8, depth: 0.05 };
  }
}

export const DEFAULT_FINISH: LayerFinish = { grain: 0.02, scanlines: 0, vignette: 0.35, saturation: 1, exposure: 1, tint: "#ffffff", tintAmount: 0 };

/* What a new layer theme starts as: dark sky, stars, low fog and a glow, so
   it looks like something from the first frame. */
export function starterLayerDoc(names: Record<LayerKind, string>): LayerDoc {
  return {
    v: 1,
    layers: [newLayer("background", names.background), newLayer("stars", names.stars), newLayer("fog", names.fog), newLayer("glow", names.glow)],
    finish: { ...DEFAULT_FINISH },
  };
}

/* What a new layer theme starts as in the editor: nothing, so the first
   layer is the maker's own choice. */
export function emptyLayerDoc(): LayerDoc {
  return { v: 1, layers: [], finish: { ...DEFAULT_FINISH } };
}

const HEX = /^#[0-9a-f]{6}$/i;
const IMAGE_URL = /^(https:\/\/cdn\.mania-tracker\.com\/theme-assets\/[a-f0-9]{64}\.webp|blob:.+)$/;

const num = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
};
const colour = (value: unknown, fallback: string) => (typeof value === "string" && HEX.test(value) ? value.toLowerCase() : fallback);
const image = (value: unknown) => (typeof value === "string" && IMAGE_URL.test(value) ? value : null);
const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);

/* A saved document, made safe: unknown kinds dropped, every number in range. */
export function parseLayerDoc(value: unknown): LayerDoc | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { layers?: unknown; finish?: unknown };
  if (!Array.isArray(raw.layers)) return null;
  const layers: Layer[] = [];
  for (const entry of raw.layers.slice(0, LAYERS_MAX)) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const kind = pick(r.kind, LAYER_KINDS, "stars");
    if (r.kind !== kind) continue;
    const d = newLayer(kind, "") as unknown as Record<string, unknown>;
    const base = {
      id: typeof r.id === "string" && r.id ? r.id.slice(0, 40) : newLayerId(),
      name: typeof r.name === "string" ? r.name.slice(0, 40) : "",
      hidden: r.hidden === true,
      opacity: num(r.opacity, 0, 1, 1),
      blend: pick(r.blend, LAYER_BLENDS, d.blend as LayerBlend),
      depth: num(r.depth, -1, 1, 0),
      follow: num(r.follow, 0, 1, 0),
    };
    const n = (key: string, min: number, max: number) => num(r[key], min, max, d[key] as number);
    const c = (key: string) => colour(r[key], d[key] as string);
    switch (kind) {
      case "background":
        layers.push({ ...base, kind, fill: pick(r.fill, ["solid", "linear", "radial", "image"] as const, "linear"), color: c("color"), color2: c("color2"), angle: n("angle", 0, 360), image: image(r.image), zoom: n("zoom", 1, 4), x: n("x", -1, 1), y: n("y", -1, 1), brightness: n("brightness", 0, 1.5) });
        break;
      case "image":
        layers.push({ ...base, kind, image: image(r.image), x: n("x", -2, 2), y: n("y", -1.5, 1.5), size: n("size", 0.02, 3), angle: n("angle", -360, 360), spin: n("spin", -1, 1), sway: n("sway", 0, 0.2), swaySpeed: n("swaySpeed", 0, 3), brightness: n("brightness", 0, 1.5) });
        break;
      case "particles":
        layers.push({ ...base, kind, shape: pick(r.shape, PARTICLE_SHAPES, "soft"), image: image(r.image), color: c("color"), color2: c("color2"), amount: n("amount", 0, 1), scale: n("scale", 2, 40), size: n("size", 0.02, 0.45), sizeVariety: n("sizeVariety", 0, 1), speed: n("speed", 0, 0.6), direction: n("direction", 0, 360), wander: n("wander", 0, 1), twinkle: n("twinkle", 0, 1) });
        break;
      case "fog":
        layers.push({ ...base, kind, color: c("color"), scale: n("scale", 0.3, 6), speed: n("speed", 0, 0.5), direction: n("direction", 0, 360), density: n("density", 0, 1), softness: n("softness", 0.05, 1), low: n("low", 0, 1) });
        break;
      case "glow":
        layers.push({ ...base, kind, color: c("color"), x: n("x", -2, 2), y: n("y", -1.5, 1.5), radius: n("radius", 0.01, 1), rays: n("rays", 0, 1), rayCount: n("rayCount", 2, 40), spin: n("spin", -1, 1), pulse: n("pulse", 0, 1), pulseSpeed: n("pulseSpeed", 0, 4) });
        break;
      case "stars":
        layers.push({ ...base, kind, color: c("color"), scale: n("scale", 10, 200), density: n("density", 0.01, 0.6), brightness: n("brightness", 0, 2) });
        break;
    }
  }
  const f = (raw.finish && typeof raw.finish === "object" ? raw.finish : {}) as Record<string, unknown>;
  return {
    v: 1,
    layers,
    finish: {
      grain: num(f.grain, 0, 0.2, DEFAULT_FINISH.grain),
      scanlines: num(f.scanlines, 0, 1, DEFAULT_FINISH.scanlines),
      vignette: num(f.vignette, 0, 1, DEFAULT_FINISH.vignette),
      saturation: num(f.saturation, 0, 2, DEFAULT_FINISH.saturation),
      exposure: num(f.exposure, 0.2, 2, DEFAULT_FINISH.exposure),
      tint: colour(f.tint, DEFAULT_FINISH.tint),
      tintAmount: num(f.tintAmount, 0, 1, DEFAULT_FINISH.tintAmount),
    },
  };
}

/* The images a document uses, in the order they bind to u_tex0..3. */
export function layerAssets(doc: LayerDoc): string[] {
  const urls: string[] = [];
  for (const layer of doc.layers) {
    const url = "image" in layer ? layer.image : null;
    if (layer.kind === "background" && layer.fill !== "image") continue;
    if (layer.kind === "particles" && layer.shape !== "image") continue;
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, CUSTOM_THEME_TEXTURES);
}

/* --- GLSL ----------------------------------------------------------------- */

const BLEND_INDEX: Record<LayerBlend, number> = { normal: 0, add: 1, screen: 2, multiply: 3 };
const SWIZZLE = "xyzw";

class Emitter {
  readonly params: number[] = [];
  constructor(readonly live: boolean) {}

  num(value: number): string {
    if (this.live) {
      const index = this.params.push(value) - 1;
      return `u_lp[${index >> 2}].${SWIZZLE[index & 3]}`;
    }
    const rounded = Math.round(value * 100000) / 100000;
    const text = Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
    return rounded < 0 ? `(${text})` : text;
  }

  vec2(x: number, y: number) {
    return `vec2(${this.num(x)}, ${this.num(y)})`;
  }

  colour(hex: string) {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
    return `vec3(${this.num(r)}, ${this.num(g)}, ${this.num(b)})`;
  }

  /* Radians from degrees, folded into the number. */
  radians(degrees: number) {
    return this.num((degrees * Math.PI) / 180);
  }
}

const HELPERS = `vec3 _lyr_blend(vec3 base, vec3 c, float a, int mode) {
  a = clamp(a, 0., 1.);
  if (mode == 1) return base + c * a;
  if (mode == 2) return 1. - (1. - base) * (1. - c * a);
  if (mode == 3) return mix(base, base * c, a);
  return mix(base, c, a);
}

vec4 _lyr_image(sampler2D tex, vec2 q) {
  vec2 inside = step(vec2(0.), q) * step(q, vec2(1.));
  vec4 s = texture(tex, vec2(q.x, 1. - q.y));
  return vec4(s.rgb / max(s.a, .001), s.a * inside.x * inside.y);
}
`;

function textureOf(url: string | null, assets: string[]): string | null {
  const index = url ? assets.indexOf(url) : -1;
  return index < 0 ? null : `u_tex${index}`;
}

function layerBody(layer: Layer, e: Emitter, assets: string[], index: number): string | null {
  // where this layer sits: drifted by the scroll and leaned toward the pointer
  const head = `    vec2 lp = p - vec2(0., u_scroll * ${e.num(layer.depth * 0.5)}) - ptr * ${e.num(layer.follow * 0.08)};\n    vec3 c = vec3(0.);\n    float a = 0.;\n`;
  let body: string;
  switch (layer.kind) {
    case "background": {
      if (layer.fill === "image") {
        const tex = textureOf(layer.image, assets);
        if (!tex) return null;
        body = `    vec2 ts = ${tex.replace("u_tex", "u_texSize")};
    float screen = u_res.x / u_res.y;
    vec2 q = (lp - ${e.vec2(layer.x * 0.3, layer.y * 0.3)}) / ${e.num(layer.zoom)};
    vec2 tuv = vec2(q.x / screen, q.y) + .5;
    float cover = screen / (ts.x / ts.y);
    if (cover > 1.) tuv.y = (tuv.y - .5) / cover + .5; else tuv.x = (tuv.x - .5) * cover + .5;
    vec4 s = _lyr_image(${tex}, clamp(tuv, 0., 1.));
    c = s.rgb * ${e.num(layer.brightness)};
    a = 1.;
`;
      } else if (layer.fill === "solid") {
        body = `    c = ${e.colour(layer.color)};\n    a = 1.;\n`;
      } else if (layer.fill === "radial") {
        body = `    c = mix(${e.colour(layer.color2)}, ${e.colour(layer.color)}, clamp(length(lp - ${e.vec2(layer.x * 0.5, layer.y * 0.5)}) * 1.3, 0., 1.));\n    a = 1.;\n`;
      } else {
        body = `    float ang = ${e.radians(layer.angle)};\n    c = mix(${e.colour(layer.color)}, ${e.colour(layer.color2)}, clamp(dot(lp, vec2(cos(ang), sin(ang))) + .5, 0., 1.));\n    a = 1.;\n`;
      }
      break;
    }
    case "image": {
      const tex = textureOf(layer.image, assets);
      if (!tex) return null;
      const sizeOf = tex.replace("u_tex", "u_texSize");
      body = `    float speed = ${e.num(layer.swaySpeed)};
    vec2 centre = ${e.vec2(layer.x, layer.y)} + vec2(sin(t * speed), sin(t * speed * .7 + 1.3)) * ${e.num(layer.sway)};
    vec2 q = rot(${e.radians(layer.angle)} + t * ${e.num(layer.spin * Math.PI * 2)}) * (lp - centre);
    float h = ${e.num(layer.size)};
    vec4 s = _lyr_image(${tex}, vec2(q.x / (h * ${sizeOf}.x / max(${sizeOf}.y, 1.)), q.y / h) + .5);
    c = s.rgb * ${e.num(layer.brightness)};
    a = s.a;
`;
      break;
    }
    case "particles": {
      const tex = layer.shape === "image" ? textureOf(layer.image, assets) : null;
      if (layer.shape === "image" && !tex) return null;
      const shape = {
        dot: "smoothstep(1., .75, d)",
        soft: "exp(-d * d * 2.6)",
        ring: "smoothstep(.22, .0, abs(d - .75))",
        streak: "smoothstep(1., .6, length(vec2(dot(f - o, dir), dot(f - o, vec2(-dir.y, dir.x)) * 4.)) / size)",
        image: "0.",
      }[layer.shape];
      body = `    float dens = ${e.num(layer.scale)};
    float ang = ${e.radians(layer.direction)};
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 g = lp * dens - dir * t * ${e.num(layer.speed)} * dens;
    vec2 id = floor(g);
    vec2 f = fract(g) - .5;
    float h = hash(id + ${(index * 13.17 + 3.1).toFixed(2)});
    if (h < ${e.num(layer.amount)}) {
      float size = ${e.num(layer.size)} * mix(1., hash(id + 4.1), ${e.num(layer.sizeVariety)});
      float room = max(0., .5 - size);
      vec2 o = (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * 2. * room;
      o += vec2(sin(t * (.4 + h) + h * 30.), cos(t * (.3 + h) + h * 17.)) * room * ${e.num(layer.wander)};
      float d = length(f - o) / max(size, .001);
${tex ? `      vec4 s = _lyr_image(${tex}, rot(h * 6.28 + t * (h - .5)) * (f - o) / (size * 2.) + .5);
      float shapeA = s.a;
      vec3 tint = s.rgb;` : `      float shapeA = ${shape};
      vec3 tint = vec3(1.);`}
      float tw = mix(1., .5 + .5 * sin(t * (1. + 3. * h) + h * 40.), ${e.num(layer.twinkle)});
      c = mix(${e.colour(layer.color)}, ${e.colour(layer.color2)}, hash(id + 9.1)) * tint;
      a = shapeA * tw;
    }
`;
      break;
    }
    case "fog": {
      body = `    float ang = ${e.radians(layer.direction)};
    vec2 q = lp * ${e.num(layer.scale)} + vec2(cos(ang), sin(ang)) * t * ${e.num(layer.speed)};
    float n = ifbm(q + ifbm(q * .6 + t * ${e.num(layer.speed * 0.5)}));
    float edge = 1. - ${e.num(layer.density)};
    a = smoothstep(edge - ${e.num(layer.softness * 0.5)}, edge + ${e.num(layer.softness * 0.5)}, n);
    a *= mix(1., smoothstep(.45, -.5, lp.y), ${e.num(layer.low)});
    c = ${e.colour(layer.color)};
`;
      break;
    }
    case "glow": {
      body = `    vec2 d = lp - ${e.vec2(layer.x, layer.y)};
    float r = length(d);
    float radius = ${e.num(layer.radius)};
    float glow = exp(-r / radius) * (1. + ${e.num(layer.pulse)} * sin(t * ${e.num(layer.pulseSpeed * Math.PI * 2)}));
    float spokes = pow(.5 + .5 * cos((atan(d.y, d.x) + t * ${e.num(layer.spin * Math.PI * 2)}) * floor(${e.num(layer.rayCount)})), 6.);
    a = glow + spokes * ${e.num(layer.rays)} * exp(-r / (radius * 5.));
    c = ${e.colour(layer.color)};
`;
      break;
    }
    case "stars": {
      body = `    a = stars(lp, ${e.num(layer.scale)}, ${e.num(layer.density)}, t) * ${e.num(layer.brightness)};
    c = ${e.colour(layer.color)};
`;
      break;
    }
  }
  return `${head}${body}    col = _lyr_blend(col, c, a * ${e.num(layer.opacity)}, ${BLEND_INDEX[layer.blend]});\n`;
}

function finishBody(finish: LayerFinish, e: Emitter): string {
  return `  // finish
  col *= ${e.num(finish.exposure)};
  col = mix(vec3(dot(col, vec3(.299, .587, .114))), col, ${e.num(finish.saturation)});
  col = mix(col, col * ${e.colour(finish.tint)} * 1.4, ${e.num(finish.tintAmount)});
  col *= 1. - ${e.num(finish.scanlines * 0.45)} * (.5 + .5 * sin(gl_FragCoord.y * 3.14159));
  col *= 1. - ${e.num(finish.vignette)} * smoothstep(.35, 1.15, length(p * vec2(.75, 1.)));
  col += (hash(gl_FragCoord.xy + fract(t) * 31.7) - .5) * ${e.num(finish.grain)};
`;
}

/* The document as a theme's GLSL. `live` reads every number from u_lp, for
   the editor's preview; the saved code has them written in. */
export function layersToGlsl(doc: LayerDoc, { live = false }: { live?: boolean } = {}): { glsl: string; params: Float32Array } {
  const e = new Emitter(live);
  const assets = layerAssets(doc);
  const bodies = doc.layers
    .filter((layer) => !layer.hidden)
    .map((layer, index) => {
      const body = layerBody(layer, e, assets, index);
      return body ? `  { // ${layer.kind}${layer.name ? `: ${layer.name.replace(/[^\x20-\x7e]|\*\/|\/\*/g, "")}` : ""}\n${body}  }\n` : null;
    })
    .filter(Boolean)
    .join("");
  const finish = finishBody(doc.finish, e);
  const main = `vec3 theme(vec2 uv, vec2 p, float t) {
  vec2 ptr = pointerP();
  vec3 col = vec3(0.);
${bodies}${finish}  return col;
}
`;
  const header = `// Made in the layer editor (generator ${LAYER_GENERATOR_VERSION}).\n`;
  const uniforms = live ? `uniform vec4 u_lp[${Math.max(1, Math.ceil(e.params.length / 4))}];\n` : "";
  const params = new Float32Array(Math.max(4, Math.ceil(e.params.length / 4) * 4));
  params.set(e.params);
  return { glsl: `${header}${uniforms}${HELPERS}\n${main}`, params };
}
