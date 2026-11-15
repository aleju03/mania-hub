/* The Autumn maple theme's falling leaves as real geometry, drawn over its
   forest photo (profile-theme-shaders.ts draws the forest; profile-theme-gl.ts
   calls this after it). Each leaf is one of eight photographed maple leaves
   (maple-leaves.webp, 4 x 2 cells of 256 px) laid on a bent mesh in a
   perspective scene: cupped along its midrib, its lobe tips curling, a
   flutter rippling through it as it falls, sways and tumbles in 3D. Its
   light follows from how it is turned: the glow at the end of the forest
   path shines through a leaf turned away from it, the photo's own colour
   brightened the way a backlit leaf glows, while one facing us takes the
   soft daylight and a waxy sheen, and its underside is paler. The nearest
   and farthest are softened as if out of focus, and the whole fall rides
   the page's scroll at its depth and leans a little after the pointer.

   Modelled on profile-theme-petals.ts: positions are worked out on the CPU
   each frame (a few dozen leaves) and sorted far to near, so their soft
   edges blend in order. */
import type { ThemeOverlay } from "./profile-theme-petals";

const ATLAS_URL = "/images/profile-themes/maple-leaves-2x.webp";
/* Units 0-4 belong to the backdrop shaders and 5-8 to custom themes' images. */
const TEXTURE_UNIT = 9;

// language=GLSL
const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_uv;
layout(location = 1) in vec4 a_pos;
layout(location = 2) in vec4 a_rot;
layout(location = 3) in vec4 a_shape;
layout(location = 4) in vec4 a_tone;
uniform mat4 u_proj;
uniform vec3 u_eye;
out vec2 v_cell;
out vec3 v_normal;
out vec3 v_view;
out vec3 v_world;
out vec2 v_ndc;
out float v_blur;
out float v_fog;
flat out int v_sprite;

/* Which way each photographed leaf's tip points from its stalk, in its cell
   (radians, y up): the midrib it cups along. */
const float TIP[8] = float[8](-1.57, -1.35, 0., -1.57, .25, 0., -1.4, .1);

vec3 qrot(vec4 q, vec3 v) {
  return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  int k = int(a_tone.x + .5);
  bool mirrored = a_tone.y < 0.;
  float ang = mirrored ? 3.14159265 - TIP[k] : TIP[k];
  vec2 ax = vec2(cos(ang), sin(ang));
  vec2 side = vec2(ax.y, -ax.x);
  vec2 q = a_uv;
  // across the midrib, and along it toward the tip
  float mx = dot(q, side), my = dot(q, ax);
  float cup = a_shape.x, curl = a_shape.y, flex = a_shape.z, tip = a_shape.w;
  float r = length(q);
  float e = max(r - .45, 0.);
  // cupped across the midrib, bent along it, the lobe tips curling up, and
  // a flutter twisting through it
  float h = cup * mx * mx + curl * my * my + tip * e * e + flex * (.5 * my * my + .45 * mx * my);
  vec2 g = (2. * cup * mx + .45 * flex * my) * side + (2. * curl * my + flex * (my + .45 * mx)) * ax + 2. * tip * e * q / max(r, 1e-3);
  vec3 n = normalize(vec3(-g, 1.));
  vec3 world = a_pos.xyz + qrot(a_rot, vec3(q, h) * a_pos.w);
  v_cell = vec2(mirrored ? -q.x : q.x, q.y) * .5 + .5;
  v_normal = qrot(a_rot, n);
  v_view = u_eye - world;
  v_world = world;
  v_blur = a_tone.z;
  v_fog = a_tone.w;
  v_sprite = k;
  gl_Position = u_proj * vec4(world - u_eye, 1.);
  v_ndc = gl_Position.xy / gl_Position.w;
}
`;

// language=GLSL
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_cell;
in vec3 v_normal;
in vec3 v_view;
in vec3 v_world;
in vec2 v_ndc;
in float v_blur;
in float v_fog;
flat in int v_sprite;
uniform sampler2D u_leaves;
uniform vec3 u_light;
uniform vec3 u_fogColor;
out vec4 fragColor;

/* Soft daylight from above and in front, and the warm glow of the path far behind. */
const vec3 FILL = vec3(-.15, .7, .7);

void main() {
  vec2 c = v_cell;
  vec2 e = min(c, 1. - c);
  // fades out at its cell's edge, so a blurred mip never pulls in the next leaf
  float edge = smoothstep(0., .03, min(e.x, e.y));
  vec2 cell = vec2(float(v_sprite % 4), float(v_sprite / 4));
  vec4 s;
  if (v_blur < 1.5) {
    vec2 cc = clamp(c, 0., 1.);
    s = texture(u_leaves, vec2((cell.x + cc.x) / 4., (cell.y + 1. - cc.y) / 2.), v_blur) * edge;
  } else {
    // out of focus: a disc of taps at a finer mip rather than one coarse mip,
    // which a near leaf magnifies into visible blocks
    float radius = exp2(v_blur) / 512. * .55;
    float lod = max(0., v_blur - 2.2);
    s = vec4(0.);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 2.39996;
      vec2 o = vec2(cos(a), sin(a)) * radius * sqrt((float(i) + .5) / 12.);
      vec2 cc = c + o;
      vec2 ee = min(cc, 1. - cc);
      float inside = smoothstep(0., .03, min(ee.x, ee.y));
      cc = clamp(cc, 0., 1.);
      s += textureLod(u_leaves, vec2((cell.x + cc.x) / 4., (cell.y + 1. - cc.y) / 2.), lod) * inside;
    }
    s /= 12.;
  }
  if (s.a < .03) discard;
  vec3 alb = s.rgb / s.a;
  // the photographs were shot in cool daylight: warmed and deepened for the golden forest
  alb = max(mix(vec3(dot(alb, vec3(.3, .55, .15))), alb * vec3(1.04, .92, .78), 1.18), 0.);
  // a leaf right at the lens is out of focus and in its own shade: deeper and
  // calmer, never a flat neon shape over the scene
  float near = smoothstep(2.6, 4., v_blur);
  alb = mix(alb, mix(vec3(dot(alb, vec3(.3, .55, .15))), alb, .7) * .62, near);
  vec3 V = normalize(v_view);
  vec3 n = normalize(v_normal);
  bool upper = dot(n, V) >= 0.;
  vec3 facing = upper ? n : -n;
  vec3 L = normalize(u_light - v_world);
  vec3 F = normalize(FILL);
  float through = max(dot(-facing, L), 0.);
  float lit = max(dot(facing, F), 0.);
  float sheen = pow(max(dot(reflect(-F, facing), V), 0.), 18.);
  // the underside is paler and duller
  if (!upper) alb = mix(alb, alb * .55 + vec3(.24, .17, .11), .45);
  // light through it: the photo's own colour, deeper and brighter
  vec3 glow = alb * mix(alb, vec3(1.), .2) * vec3(1., .86, .62) * 1.6;
  // a leaf is thin: some of the glow behind comes through however it is turned
  vec3 col = alb * vec3(1., .92, .82) * (.26 + .7 * lit) + glow * (.2 + .8 * through * through) + vec3(1., .95, .85) * sheen * .22;
  // the brightest roll off softly instead of clipping flat
  float peak = max(col.r, max(col.g, col.b));
  col *= peak > .78 ? (.78 + (peak - .78) / (1. + 2.5 * (peak - .78))) / peak : 1.;
  col = mix(col, u_fogColor, v_fog);
  // quieter under the name and avatar, top left
  float ul = smoothstep(-.15, -.55, v_ndc.x) * smoothstep(-.05, .35, v_ndc.y);
  col *= 1. - .5 * ul;
  float a = s.a * (1. - .35 * ul);
  fragColor = vec4(col * a, a);
}
`;

/* Mesh resolution: enough that the cup, curl and flutter read as curves. */
const COLUMNS = 10;
const ROWS = 10;
/* The grid covers the leaf's whole cell and a little more, so a turned or
   bent leaf is never cut: the fragment shader cuts the leaf by its alpha. */
const MESH_MARGIN = 0.04;
const MAX_LEAVES = 64;
const STRIDE = 16;
const FOV = (38 * Math.PI) / 180;
const NEAR_LEAVES = 2;
const NEAR_Z = 3.2;
const FAR_Z = 12;
/* Mip levels of blur for the nearest, and for the farthest. */
const NEAR_BLUR = 4.2;
const FAR_BLUR = 1.6;
const GUST_PERIOD = 6;
/* Share of each photographed leaf: orange, three reds, gold, yellow, crimson, russet. */
const SPRITE_WEIGHTS = [0.12, 0.1, 0.1, 0.1, 0.2, 0.18, 0.12, 0.08];

function rand(seed: number): number {
  let t = (seed * 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface Leaf {
  depth: number;
  x0: number;
  y0: number;
  size: number;
  fall: number;
  drift: number;
  swayF: number;
  swayA: number;
  phase: number;
  axis: [number, number, number];
  spin: number;
  rock: number;
  cup: number;
  curl: number;
  tip: number;
  flutterF: number;
  sprite: number;
  mirror: number;
}

function pickSprite(value: number): number {
  let sum = 0;
  for (let k = 0; k < SPRITE_WEIGHTS.length; k++) {
    sum += SPRITE_WEIGHTS[k];
    if (value < sum) return k;
  }
  return SPRITE_WEIGHTS.length - 1;
}

function makeLeaves(): Leaf[] {
  const leaves: Leaf[] = [];
  for (let i = 0; i < MAX_LEAVES; i++) {
    const r = (k: number) => rand(i * 37 + k + 11);
    const near = i < NEAR_LEAVES;
    const ax = r(7) - 0.5, ay = r(8) - 0.5, az = r(9) - 0.5 + 0.2;
    const len = Math.hypot(ax, ay, az) || 1;
    leaves.push({
      // one or two close to the lens, the rest spread through the middle distance
      depth: near ? 1.5 + 0.6 * r(1) : NEAR_Z + (FAR_Z - NEAR_Z) * Math.pow(r(1), 0.9),
      x0: near ? 0.62 + 0.3 * r(2) : r(2),
      y0: r(3),
      size: near ? 0.3 + 0.06 * r(4) : 0.19 + 0.11 * r(4),
      fall: near ? 0.12 + 0.05 * r(5) : 0.22 + 0.16 * r(5),
      drift: 0.03 + 0.05 * r(6),
      swayF: 0.45 + 0.5 * r(10),
      swayA: 0.12 + 0.18 * r(11),
      phase: r(12) * Math.PI * 2,
      axis: [ax / len, ay / len, az / len],
      spin: (0.35 + 0.8 * r(13)) * (r(14) > 0.5 ? 1 : -1),
      rock: 0.4 + 0.5 * r(15),
      cup: 0.14 + 0.16 * r(16),
      curl: (r(17) - 0.5) * 0.24,
      tip: 0.12 + 0.2 * r(18),
      flutterF: 2.2 + 2.4 * r(19),
      sprite: pickSprite(r(20)),
      mirror: r(21) > 0.5 ? -1 : 1,
    });
  }
  return leaves;
}

function quatAxis(x: number, y: number, z: number, angle: number): [number, number, number, number] {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

function quatMul(a: number[], b: number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

/* The gust every six seconds: how far gusts have pushed so far (one unit
   each, eased in and out), and how hard it blows now (0..1). */
function gustAt(time: number): [number, number] {
  const n = time / GUST_PERIOD;
  const x = Math.min(1, Math.max(0, (n - Math.floor(n) - 0.04) / 0.6));
  return [Math.floor(n) + x * x * (3 - 2 * x), 4 * x * (1 - x)];
}

export function createMapleLeaves(gl: WebGL2RenderingContext): ThemeOverlay | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    if (import.meta.env.DEV) console.warn("maple leaves", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const uProj = gl.getUniformLocation(program, "u_proj");
  const uEye = gl.getUniformLocation(program, "u_eye");
  const uLight = gl.getUniformLocation(program, "u_light");
  const uFog = gl.getUniformLocation(program, "u_fogColor");
  const uLeaves = gl.getUniformLocation(program, "u_leaves");

  // the leaf photographs, premultiplied and mipmapped (the blur reads the mips)
  let atlas: WebGLTexture | null = null;
  const image = new Image();
  image.decoding = "async";
  image.onload = () => void image.decode().catch(() => {}).then(() => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    atlas = texture;
  });
  image.src = ATLAS_URL;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const grid: number[] = [];
  const reach = 1 + MESH_MARGIN;
  for (let row = 0; row <= ROWS; row++) {
    for (let col = 0; col <= COLUMNS; col++) grid.push(((col / COLUMNS) * 2 - 1) * reach, ((row / ROWS) * 2 - 1) * reach);
  }
  const indices: number[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const a = row * (COLUMNS + 1) + col, b = a + 1, c = a + COLUMNS + 1, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const meshBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  const instanceBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_LEAVES * STRIDE * 4, gl.DYNAMIC_DRAW);
  const attribute = (location: number, size: number, offset: number) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  };
  attribute(1, 4, 0);
  attribute(2, 4, 4);
  attribute(3, 4, 8);
  attribute(4, 4, 12);
  gl.bindVertexArray(null);

  const leaves = makeLeaves();
  const data = new Float32Array(MAX_LEAVES * STRIDE);
  const sorted = new Float32Array(MAX_LEAVES * STRIDE);
  const order: Array<{ z: number; index: number }> = [];
  const tanHalf = Math.tan(FOV / 2);

  return {
    ready: () => atlas !== null,
    draw(width, height, time, pointer, scroll) {
      if (!atlas) return;
      const aspect = width / height;
      // the eye leans a little after the pointer, so near leaves slide past far ones
      const eye: [number, number, number] = [(pointer[0] - 0.5) * 0.3, (pointer[1] - 0.5) * 0.18, 0];
      // about 34 on a wide screen, fewer on a phone (the near ones always)
      const count = Math.min(MAX_LEAVES, Math.round(34 * Math.min(Math.max(aspect / 1.78, 0.55), 1.8)));
      order.length = 0;
      for (let i = 0; i < count; i++) {
        const p = leaves[i];
        const margin = p.size * 1.6;
        const halfH = p.depth * tanHalf + margin;
        const halfW = halfH * aspect + margin;
        // the gust reaches the left of the screen first and sweeps across
        const [push, blow] = gustAt(time - p.x0 * 0.9);
        // the page scrolling carries the near ones off faster than the far
        const parallax = 0.25 + 0.6 * (1 - (p.depth - 1.5) / (FAR_Z - 1.5));
        const sway = Math.sin(time * p.swayF + p.phase);
        const span = halfH * 2;
        const fallen = p.y0 * span - time * p.fall + push * 0.12 + scroll * span * parallax;
        const y = wrap(fallen, span) - halfH;
        let x: number;
        if (i < NEAR_LEAVES) {
          // The close ones keep to the right half, clear of the name. Each
          // fall starts somewhere new, picked when it wraps back to the top
          // out of sight; within a fall it only drifts and is carried on by
          // the gusts, so it never jumps across the screen in view.
          const lap = Math.floor(fallen / span);
          const across = 1 - (y + halfH) / span;
          const [pushAtTop] = gustAt(time - (across * span) / p.fall - p.x0 * 0.9);
          x = halfW * (0.15 + 0.5 * rand(i * 101 + lap * 7919 + 5)) + across * span * p.drift * 2.5 + (push - pushAtTop) * 0.25 + sway * p.swayA;
        } else {
          x = wrap(p.x0 * halfW * 2 + time * p.drift + push * 0.55 + sway * p.swayA, halfW * 2) - halfW;
        }
        const z = -p.depth;
        // a steady tumble that quickens in the gust, and a rock that follows
        // the sway the way a falling leaf tips into each swing
        const tumble = quatAxis(p.axis[0], p.axis[1], p.axis[2], time * p.spin + push * 1.6 * Math.sign(p.spin) + p.phase * 3);
        const rock = quatAxis(0, 0, 1, Math.cos(time * p.swayF + p.phase) * p.rock);
        const q = quatMul(rock, tumble);
        const flex = (0.1 + 0.12 * blow) * Math.sin(time * p.flutterF + p.phase * 2);
        // out of focus nearest the lens and at the very back
        const blur = p.depth < 2.5 ? NEAR_BLUR : Math.max(0, (p.depth - (FAR_Z - 3)) / 3) * FAR_BLUR;
        const fog = 0.28 * Math.pow(Math.max(0, (p.depth - NEAR_Z) / (FAR_Z - NEAR_Z)), 1.4);
        const o = i * STRIDE;
        data[o] = x; data[o + 1] = y; data[o + 2] = z; data[o + 3] = p.size;
        data[o + 4] = q[0]; data[o + 5] = q[1]; data[o + 6] = q[2]; data[o + 7] = q[3];
        data[o + 8] = p.cup; data[o + 9] = p.curl; data[o + 10] = flex; data[o + 11] = p.tip;
        data[o + 12] = p.sprite; data[o + 13] = p.mirror; data[o + 14] = blur; data[o + 15] = fog;
        order.push({ z, index: i });
      }
      // far to near, so soft edges blend over what is behind them
      order.sort((a, b) => a.z - b.z);
      order.forEach(({ index }, slot) => sorted.set(data.subarray(index * STRIDE, index * STRIDE + STRIDE), slot * STRIDE));

      const f = 1 / tanHalf;
      const near = 0.3, far = 120;
      const proj = new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
      ]);

      gl.useProgram(program);
      gl.uniformMatrix4fv(uProj, false, proj);
      gl.uniform3f(uEye, eye[0], eye[1], eye[2]);
      // the glow at the end of the path: far behind, a little below the middle
      gl.uniform3f(uLight, 0, -14, -80);
      gl.uniform3f(uFog, 0.5, 0.36, 0.22);
      gl.uniform1i(uLeaves, TEXTURE_UNIT);
      gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted, 0, count * STRIDE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElementsInstanced(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0, count);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(null);
    },
  };
}
