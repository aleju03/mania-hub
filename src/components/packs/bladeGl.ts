import { spriteImage, type BladeFx, type FxItem, type SpriteId } from "./bladeFx";
import { bladeTrailLife, bolt, drawBladeTrail, type BladeLook, type TrailPoint } from "./packBlades";

/* Draws a blade (packBlades.ts) with WebGL2, the way game effects are drawn:
   everything is light, rendered brighter than white into a float buffer,
   then a bloom spreads soft light around whatever is brightest before it is
   tone-mapped onto the page. The streak is a ribbon smoothed through the
   pointer's path (no corners on a fast slash) and shaded per blade: a
   white-hot edge, tube light, flames licking off it, or a crackling bolt.
   The particles (bladeFx.ts) are instanced sprites. A pack giving way
   splits the light into its colours for a moment.

   Falls back to the canvas 2D drawing where WebGL2 is missing; a lost
   context draws nothing until the browser gives it back. */

type Rgb = readonly [number, number, number];
type Point = { x: number; y: number };

export interface BladeDrawInput {
  look: BladeLook;
  points: readonly TrailPoint[];
  now: number;
  tip: Point | null;
  fx: BladeFx | null;
  /* The canvas in CSS px; its backing store is already sized by the caller. */
  width: number;
  height: number;
  /* Backing pixels per CSS px. */
  pixelRatio: number;
  /* Shrinks the streak for a small preview box. */
  scale?: number;
}

export interface BladeRenderer {
  readonly webgl: boolean;
  draw(input: BladeDrawInput): void;
  /* The pack giving way at x, y (CSS px): a moment of split colour. */
  impact(x: number, y: number, strength?: number): void;
  dispose(): void;
}

/* ---- colours ------------------------------------------------------------ */

const colorCache = new Map<string, [number, number, number, number]>();

function parseColor(color: string): [number, number, number, number] {
  const cached = colorCache.get(color);
  if (cached) return cached;
  let out: [number, number, number, number] = [1, 1, 1, 1];
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex;
    out = [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255, 1];
  } else {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (match) {
      const [r, g, b, a] = match[1].split(",").map((part) => Number(part.trim()));
      out = [r / 255, g / 255, b / 255, Number.isFinite(a) ? a : 1];
    }
  }
  colorCache.set(color, out);
  return out;
}

const rgbOf = (rgb: Rgb): [number, number, number] => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];

/* ---- shaders ------------------------------------------------------------ */

const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const RIBBON_VS = `#version 300 es
in vec2 a_pos;
in vec4 a_info; // u along (tail 0, tip 1), v across (-1..1), fade, px along
uniform vec2 u_view;
out vec4 v_info;
void main() {
  vec2 clip = a_pos / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_info = a_info;
}`;

const RIBBON_FS = `#version 300 es
precision highp float;
in vec4 v_info;
uniform int u_mode; // 0 blade, 1 neon, 2 fire, 3 bolt
uniform vec3 u_glow;
uniform vec3 u_mid;
uniform vec3 u_core;
uniform float u_coreWidth;
uniform float u_time;
out vec4 o_color;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), s.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), s.x), s.y);
}
float fbm(vec2 p) {
  float total = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 4; i++) {
    total += noise(p) * amp;
    p *= 2.03;
    amp *= 0.5;
  }
  return total;
}
vec3 fireRamp(float h) {
  vec3 ember = vec3(0.45, 0.06, 0.02);
  vec3 red = vec3(0.95, 0.22, 0.04);
  vec3 orange = vec3(1.0, 0.55, 0.1);
  vec3 yellow = vec3(1.0, 0.86, 0.42);
  vec3 white = vec3(1.0, 0.98, 0.9);
  if (h < 0.25) return mix(ember, red, h / 0.25);
  if (h < 0.5) return mix(red, orange, (h - 0.25) / 0.25);
  if (h < 0.78) return mix(orange, yellow, (h - 0.5) / 0.28);
  return mix(yellow, white, (h - 0.78) / 0.22);
}

void main() {
  float u = v_info.x;
  float d = abs(v_info.y);
  float fade = v_info.z;
  float along = v_info.w;
  if (fade <= 0.001) discard;

  if (u_mode == 2) {
    // Flames: heat falls off away from the blade, broken up by noise that
    // runs along it and up, so it flickers without ever forming blobs.
    float n = fbm(vec2(along * 0.018 - u_time * 0.8, d * 1.6 - u_time * 2.6));
    float m = noise(vec2(along * 0.05 + u_time * 0.5, d * 3.2 - u_time * 4.2));
    float heat = exp(-d * d * 3.2) * (0.5 + 0.95 * n) * (0.8 + 0.4 * m);
    heat *= smoothstep(0.0, 0.22, u) * (0.4 + 0.6 * fade);
    vec3 color = fireRamp(clamp(heat, 0.0, 1.0)) * heat * 2.4;
    float core = smoothstep(u_coreWidth, u_coreWidth * 0.3, d);
    o_color = vec4(color * fade, core * fade * 0.35);
    return;
  }

  float core = smoothstep(u_coreWidth, u_coreWidth * 0.3, d);
  float mid = exp(-d * d * 10.0);
  float glow = exp(-d * d * 3.5) * (1.0 - d);
  vec3 color;
  if (u_mode == 1) {
    // Tube light: a steady hum along it, and the two hues separate at the edge.
    float hum = 0.9 + 0.1 * sin(u_time * 110.0 + along * 0.08);
    float tube = exp(-d * d * 16.0);
    color = (u_glow * glow * 0.6 + u_mid * tube * 1.9 + u_core * core * 0.45) * hum;
  } else if (u_mode == 3) {
    float bolt = exp(-d * d * 45.0);
    color = u_glow * glow * 1.2 + u_mid * bolt * 0.8 + u_core * core * 2.2;
  } else {
    color = u_glow * glow * 0.45 + u_mid * mid * 0.9 + u_core * core * 2.6;
  }
  o_color = vec4(color * fade, core * fade * 0.45);
}`;

const SPRITE_VS = `#version 300 es
in vec2 a_corner;
in vec4 a_rect;
in float a_angle;
in vec4 a_color;
uniform vec2 u_view;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 p = a_corner * a_rect.zw;
  float c = cos(a_angle);
  float s = sin(a_angle);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + a_rect.xy;
  vec2 clip = p / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_corner + 0.5;
  v_color = a_color;
}`;

const SPRITE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
uniform float u_boost;
uniform int u_normal;
out vec4 o_color;
void main() {
  float a = texture(u_tex, v_uv).a * v_color.a;
  if (u_normal == 1) {
    o_color = vec4(v_color.rgb * a, a);
  } else {
    o_color = vec4(v_color.rgb * a * u_boost, a * 0.25);
  }
}`;

// Dual-filter (Kawase) bloom: cheap, wide and smooth on a few half-size steps.
const DOWN_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
out vec4 o_color;
void main() {
  vec2 h = u_texel * 0.5;
  vec3 sum = texture(u_tex, v_uv).rgb * 4.0;
  sum += texture(u_tex, v_uv - h).rgb;
  sum += texture(u_tex, v_uv + h).rgb;
  sum += texture(u_tex, v_uv + vec2(h.x, -h.y)).rgb;
  sum += texture(u_tex, v_uv - vec2(h.x, -h.y)).rgb;
  o_color = vec4(sum / 8.0, 1.0);
}`;

const UP_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
out vec4 o_color;
void main() {
  vec2 h = u_texel * 0.5;
  vec3 sum = texture(u_tex, v_uv + vec2(-h.x * 2.0, 0.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(-h.x, h.y)).rgb * 2.0;
  sum += texture(u_tex, v_uv + vec2(0.0, h.y * 2.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(h.x, h.y)).rgb * 2.0;
  sum += texture(u_tex, v_uv + vec2(h.x * 2.0, 0.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(h.x, -h.y)).rgb * 2.0;
  sum += texture(u_tex, v_uv + vec2(0.0, -h.y * 2.0)).rgb;
  sum += texture(u_tex, v_uv + vec2(-h.x, -h.y)).rgb * 2.0;
  o_color = vec4(sum / 12.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
uniform float u_impact;
uniform vec2 u_impactAt;
uniform vec3 u_flash;
out vec4 o_color;
void main() {
  vec4 scene = texture(u_scene, v_uv);
  vec3 bloom = texture(u_bloom, v_uv).rgb;
  if (u_impact > 0.001) {
    // The light splits into its colours, pushed out from where the pack gave.
    vec2 shift = (v_uv - u_impactAt) * u_impact * 0.045;
    scene.r = texture(u_scene, v_uv + shift).r;
    scene.b = texture(u_scene, v_uv - shift).b;
    bloom.r = texture(u_bloom, v_uv + shift).r;
    bloom.b = texture(u_bloom, v_uv - shift).b;
  }
  vec3 light = scene.rgb + bloom * u_bloomStrength;
  // Tone map on the brightest channel, so a pink stays pink as it gets
  // brighter instead of washing out; only the hottest light runs to white.
  float peak = max(light.r, max(light.g, light.b));
  vec3 color = light * ((1.0 - exp(-peak * 1.15)) / max(peak, 1e-4));
  color = mix(color, vec3(1.0 - exp(-peak * 1.15)), smoothstep(2.2, 7.0, peak) * 0.75);
  color += u_flash;
  float lum = max(color.r, max(color.g, color.b));
  // Mostly added to the page (rgb above alpha), with a little cover where it is
  // brightest so the core reads on light themes too.
  o_color = vec4(color, clamp(scene.a + lum * 0.18, 0.0, 1.0));
}`;

/* ---- GL plumbing -------------------------------------------------------- */

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`blade shader: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`blade program: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

const BLOOM_LEVELS = 5;
const MAX_SPRITES = 1200;
const SPRITE_STRIDE = 9; // rect 4, angle 1, color 4

/* ---- the ribbon --------------------------------------------------------- */

/* A smooth path through the pointer's points: centripetal Catmull-Rom,
   sampled every few px, carrying each point's time along. */
function smoothPath(points: readonly TrailPoint[]): TrailPoint[] {
  if (points.length < 3) return [...points];
  const out: TrailPoint[] = [points[0]];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(1, Math.min(12, Math.ceil(length / 5)));
    const d01 = Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)) || 1e-4;
    const d12 = Math.sqrt(length) || 1e-4;
    const d23 = Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)) || 1e-4;
    // tangents (Barry-Goldman form), scaled to the middle segment
    const m1x = ((p1.x - p0.x) / d01 - (p2.x - p0.x) / (d01 + d12) + (p2.x - p1.x) / d12) * d12;
    const m1y = ((p1.y - p0.y) / d01 - (p2.y - p0.y) / (d01 + d12) + (p2.y - p1.y) / d12) * d12;
    const m2x = ((p2.x - p1.x) / d12 - (p3.x - p1.x) / (d12 + d23) + (p3.x - p2.x) / d23) * d12;
    const m2y = ((p2.y - p1.y) / d12 - (p3.y - p1.y) / (d12 + d23) + (p3.y - p2.y) / d23) * d12;
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      out.push({
        x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
        y: h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y,
        t: p1.t + (p2.t - p1.t) * t,
      });
    }
  }
  return out;
}

/* Writes a tapered strip along `path` into `out` from `offset` (floats);
   returns the new offset. Six floats a vertex: x, y, u, v, fade, along. */
function writeStrip(
  out: Float32Array,
  offset: number,
  path: readonly Point[],
  halfWidth: (u: number) => number,
  fade: (i: number) => number,
): number {
  const n = path.length;
  if (n < 2) return offset;
  let along = 0;
  for (let i = 0; i < n; i += 1) {
    if (offset + 12 > out.length) return offset;
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    if (i > 0) along += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    const u = i / (n - 1);
    const half = halfWidth(u);
    const f = fade(i);
    for (const side of [1, -1]) {
      out[offset++] = path[i].x + nx * half * side;
      out[offset++] = path[i].y + ny * half * side;
      out[offset++] = u;
      out[offset++] = side;
      out[offset++] = f;
      out[offset++] = along;
    }
  }
  return offset;
}

/* ---- the WebGL renderer ------------------------------------------------- */

function createGlRenderer(canvas: HTMLCanvasElement): BladeRenderer | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const floatTargets = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");

  let programs: {
    ribbon: WebGLProgram;
    sprite: WebGLProgram;
    down: WebGLProgram;
    up: WebGLProgram;
    composite: WebGLProgram;
  };
  let quad: WebGLVertexArrayObject;
  let ribbonVao: WebGLVertexArrayObject;
  let ribbonBuffer: WebGLBuffer;
  let spriteVao: WebGLVertexArrayObject;
  let spriteBuffer: WebGLBuffer;
  const textures = new Map<SpriteId, WebGLTexture>();
  let scene: Target | null = null;
  let bloom: Target[] = [];
  let lost = false;
  const ribbonData = new Float32Array(6 * 2 * 4000);
  const spriteData = new Float32Array(MAX_SPRITES * SPRITE_STRIDE);
  const uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  let impactAt = { x: 0.5, y: 0.5, at: -1e9, strength: 0 };

  const loc = (program: WebGLProgram, name: string) => {
    let table = uniforms.get(program);
    if (!table) uniforms.set(program, (table = new Map()));
    if (!table.has(name)) table.set(name, gl.getUniformLocation(program, name));
    return table.get(name)!;
  };

  const setup = () => {
    programs = {
      ribbon: compile(gl, RIBBON_VS, RIBBON_FS),
      sprite: compile(gl, SPRITE_VS, SPRITE_FS),
      down: compile(gl, QUAD_VS, DOWN_FS),
      up: compile(gl, QUAD_VS, UP_FS),
      composite: compile(gl, QUAD_VS, COMPOSITE_FS),
    };
    uniforms.clear();

    quad = gl.createVertexArray()!;
    gl.bindVertexArray(quad);
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const program of [programs.down, programs.up, programs.composite]) {
      const at = gl.getAttribLocation(program, "a_pos");
      if (at >= 0) {
        gl.enableVertexAttribArray(at);
        gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      }
    }

    ribbonVao = gl.createVertexArray()!;
    gl.bindVertexArray(ribbonVao);
    ribbonBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, ribbonData.byteLength, gl.DYNAMIC_DRAW);
    const rPos = gl.getAttribLocation(programs.ribbon, "a_pos");
    const rInfo = gl.getAttribLocation(programs.ribbon, "a_info");
    gl.enableVertexAttribArray(rPos);
    gl.vertexAttribPointer(rPos, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(rInfo);
    gl.vertexAttribPointer(rInfo, 4, gl.FLOAT, false, 24, 8);

    spriteVao = gl.createVertexArray()!;
    gl.bindVertexArray(spriteVao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const sCorner = gl.getAttribLocation(programs.sprite, "a_corner");
    gl.enableVertexAttribArray(sCorner);
    gl.vertexAttribPointer(sCorner, 2, gl.FLOAT, false, 0, 0);
    spriteBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, spriteData.byteLength, gl.DYNAMIC_DRAW);
    const stride = SPRITE_STRIDE * 4;
    for (const [name, size, offset] of [["a_rect", 4, 0], ["a_angle", 1, 16], ["a_color", 4, 20]] as const) {
      const at = gl.getAttribLocation(programs.sprite, name);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(at, 1);
    }
    gl.bindVertexArray(null);
    textures.clear();
    scene = null;
    bloom = [];
  };

  const makeTarget = (w: number, h: number): Target => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, tex, w, h };
  };

  const freeTarget = (target: Target) => {
    gl.deleteFramebuffer(target.fbo);
    gl.deleteTexture(target.tex);
  };

  const ensureTargets = (w: number, h: number) => {
    if (scene && scene.w === w && scene.h === h) return;
    if (scene) freeTarget(scene);
    for (const target of bloom) freeTarget(target);
    scene = makeTarget(w, h);
    bloom = [];
    let bw = w;
    let bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i += 1) {
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
      bloom.push(makeTarget(bw, bh));
    }
  };

  const textureFor = (id: SpriteId): WebGLTexture | null => {
    const known = textures.get(id);
    if (known) return known;
    const image = spriteImage(id);
    if (!image) return null;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures.set(id, tex);
    return tex;
  };

  const drawRibbon = (look: BladeLook, points: readonly TrailPoint[], now: number, scale: number, width: number, height: number) => {
    if (points.length < 2) return;
    const life = bladeTrailLife(look);
    const strokes = look.strokes;
    const outer = strokes[0];
    const core = strokes[strokes.length - 1];
    const middle = strokes.length > 2 ? strokes[1] : outer;
    const mode = look.jitter ? 3 : look.style === "neon" ? 1 : look.style === "fire" ? 2 : 0;
    // The glow is the bloom's job now, so the strip only needs room for the
    // widest stroke (and the flames, which reach well past it).
    const reach = mode === 2 ? 2.4 : mode === 3 ? 1.3 : 1.15;
    const coreWidth = Math.min(0.9, Math.max(0.12, core.width[1] / outer.width[1]));

    let count = 0;
    const strips: Array<[number, number]> = [];
    const pushStrip = (path: readonly Point[], half: (u: number) => number, fade: (i: number) => number) => {
      const start = count;
      count = writeStrip(ribbonData, count, path, half, fade);
      if (count > start) strips.push([start / 6, (count - start) / 6]);
    };

    if (mode === 3) {
      const { main, forks } = bolt(points, (look.jitter ?? 0) * scale);
      const head = Math.max(0, 1 - (now - points[points.length - 1].t) / life);
      const flicker = 0.65 + Math.random() * 0.35;
      const w = outer.width[1] * scale * reach * 0.5;
      pushStrip(main, (u) => w * (0.55 + 0.45 * u), (i) => Math.min(1, (i / Math.max(1, main.length - 1)) * 1.6) * head * flicker);
      for (const fork of forks) pushStrip(fork, (u) => w * 0.5 * (1 - u * 0.7), () => head * flicker * 0.6);
    } else {
      const path = smoothPath(points);
      const n = path.length;
      pushStrip(
        path,
        (u) => ((outer.width[0] + (outer.width[1] - outer.width[0]) * u) / 2) * scale * reach,
        (i) => (i / (n - 1)) * Math.max(0, 1 - (now - path[i].t) / life),
      );
    }
    if (count === 0) return;

    gl.useProgram(programs.ribbon);
    gl.uniform2f(loc(programs.ribbon, "u_view"), width, height);
    gl.uniform1i(loc(programs.ribbon, "u_mode"), mode);
    gl.uniform3fv(loc(programs.ribbon, "u_glow"), rgbOf(outer.rgb));
    gl.uniform3fv(loc(programs.ribbon, "u_mid"), rgbOf(middle.rgb));
    gl.uniform3fv(loc(programs.ribbon, "u_core"), rgbOf(core.rgb));
    gl.uniform1f(loc(programs.ribbon, "u_coreWidth"), coreWidth / reach);
    gl.uniform1f(loc(programs.ribbon, "u_time"), now / 1000);
    gl.bindVertexArray(ribbonVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, ribbonData, 0, count);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    for (const [first, vertices] of strips) gl.drawArrays(gl.TRIANGLE_STRIP, first, vertices);
  };

  const drawSprites = (items: readonly FxItem[], width: number, height: number) => {
    if (items.length === 0) return;
    gl.useProgram(programs.sprite);
    gl.uniform2f(loc(programs.sprite, "u_view"), width, height);
    gl.uniform1i(loc(programs.sprite, "u_tex"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
    // Smoke first, laid over normally; then the light, added.
    for (const additive of [false, true]) {
      const groups = new Map<SpriteId, FxItem[]>();
      for (const item of items) {
        if (item.additive !== additive) continue;
        const list = groups.get(item.sprite);
        if (list) list.push(item);
        else groups.set(item.sprite, [item]);
      }
      if (groups.size === 0) continue;
      gl.uniform1i(loc(programs.sprite, "u_normal"), additive ? 0 : 1);
      if (additive) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
      else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const [sprite, list] of groups) {
        const tex = textureFor(sprite);
        if (!tex) continue;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        let count = 0;
        for (const item of list) {
          if (count >= MAX_SPRITES) break;
          const [r, g, b] = parseColor(item.color);
          const o = count * SPRITE_STRIDE;
          spriteData[o] = item.x;
          spriteData[o + 1] = item.y;
          spriteData[o + 2] = item.w;
          spriteData[o + 3] = item.h;
          spriteData[o + 4] = item.angle;
          // Hot fire is brighter than white; it cools to its colour.
          const boost = 1 + item.heat * 0.9;
          spriteData[o + 5] = r * boost;
          spriteData[o + 6] = g * boost;
          spriteData[o + 7] = b * boost;
          spriteData[o + 8] = item.alpha;
          count += 1;
        }
        gl.uniform1f(loc(programs.sprite, "u_boost"), additive ? 1.35 : 1);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, spriteData, 0, count * SPRITE_STRIDE);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      }
    }
  };

  const tipItems = (look: BladeLook, tip: Point | null, scale: number): FxItem[] => {
    if (!tip) return [];
    const radius = look.tip.radius * scale;
    const glow = parseColor(look.tip.glow);
    return [
      { sprite: "circle-05", color: look.tip.glow, x: tip.x, y: tip.y, w: radius * 7, h: radius * 7, angle: 0, alpha: Math.min(1, glow[3] * 1.4), additive: true, heat: 0 },
      { sprite: "circle-05", color: look.tip.core, x: tip.x, y: tip.y, w: radius * 2.6, h: radius * 2.6, angle: 0, alpha: 1, additive: true, heat: 0.6 },
    ];
  };

  const pass = (program: WebGLProgram, target: Target | null, source: WebGLTexture, texelW: number, texelH: number, viewportW: number, viewportH: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(loc(program, "u_tex"), 0);
    gl.uniform2f(loc(program, "u_texel"), 1 / texelW, 1 / texelH);
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    lost = false;
    try {
      setup();
    } catch {
      lost = true;
    }
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  try {
    setup();
  } catch {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    return null;
  }

  return {
    webgl: true,
    impact(x, y, strength = 1) {
      impactAt = { x, y, at: performance.now(), strength };
    },
    draw({ look, points, now, tip, fx, width, height, scale = 1 }) {
      const frame = fx?.frame() ?? { items: [], flashes: [] };
      if (lost || gl.isContextLost()) return;
      const w = canvas.width;
      const h = canvas.height;
      if (w < 2 || h < 2) return;
      ensureTargets(w, h);
      if (!scene) return;

      gl.enable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawRibbon(look, points, now, scale, width, height);
      drawSprites([...frame.items, ...tipItems(look, tip, scale)], width, height);

      // Bloom: halve down the chain, then add each level back up into the one above.
      gl.disable(gl.BLEND);
      let source = scene;
      for (const target of bloom) {
        pass(programs.down, target, source.tex, source.w, source.h, target.w, target.h);
        source = target;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = bloom.length - 1; i > 0; i -= 1) {
        pass(programs.up, bloom[i - 1], bloom[i].tex, bloom[i].w, bloom[i].h, bloom[i - 1].w, bloom[i - 1].h);
      }
      gl.disable(gl.BLEND);

      const sinceImpact = (performance.now() - impactAt.at) / 1000;
      const impact = sinceImpact < 0.3 ? impactAt.strength * (1 - sinceImpact / 0.3) ** 2 : 0;
      let flash: [number, number, number] = [0, 0, 0];
      for (const item of frame.flashes) {
        const [r, g, b] = parseColor(item.color);
        flash = [flash[0] + r * item.alpha, flash[1] + g * item.alpha, flash[2] + b * item.alpha];
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const program = programs.composite;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.tex);
      gl.uniform1i(loc(program, "u_scene"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloom[0].tex);
      gl.uniform1i(loc(program, "u_bloom"), 1);
      gl.uniform1f(loc(program, "u_bloomStrength"), 0.9 * (look.bloom ?? 1));
      gl.uniform1f(loc(program, "u_impact"), impact);
      gl.uniform2f(loc(program, "u_impactAt"), impactAt.x / Math.max(1, width), 1 - impactAt.y / Math.max(1, height));
      gl.uniform3f(loc(program, "u_flash"), flash[0], flash[1], flash[2]);
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/* ---- the 2D fallback ---------------------------------------------------- */

function create2dRenderer(canvas: HTMLCanvasElement): BladeRenderer {
  return {
    webgl: false,
    impact() {},
    draw({ look, points, now, tip, fx, width, height, pixelRatio, scale = 1 }) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        fx?.frame();
        return;
      }
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawBladeTrail(ctx, look, points, now, tip, scale);
      fx?.draw(ctx, width, height);
    },
    dispose() {},
  };
}

export function createBladeRenderer(canvas: HTMLCanvasElement): BladeRenderer {
  try {
    return createGlRenderer(canvas) ?? create2dRenderer(canvas);
  } catch {
    return create2dRenderer(canvas);
  }
}
