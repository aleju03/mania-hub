/* The Sakura theme's petals as real geometry, drawn over its dusk backdrop
   (profile-theme-shaders.ts draws the sky; profile-theme-gl.ts calls this
   after it). Each petal is a cupped, curled mesh in a perspective scene:
   it falls, sways and tumbles in 3D, so its outline, shading and the light
   coming through it all follow from how it is actually turned. The nearest
   and farthest are softened as if out of focus, and the whole field rides
   the page's scroll at its depth and leans a little after the pointer.

   Positions are worked out on the CPU each frame (a few hundred petals) and
   sorted far to near, so their soft edges blend in order. */

// language=GLSL
const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_uv;
layout(location = 1) in vec4 a_pos;
layout(location = 2) in vec4 a_rot;
layout(location = 3) in vec4 a_shape;
layout(location = 4) in vec2 a_tone;
uniform mat4 u_proj;
uniform vec3 u_eye;
out vec2 v_uv;
out vec3 v_normal;
out vec3 v_view;
out float v_seed;
out float v_blur;
out float v_bright;
out float v_fog;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  float cup = a_shape.x, curl = a_shape.y;
  vec2 q = a_uv;
  // cupped across its width, bent along its length
  vec3 local = vec3(q, cup * q.x * q.x + curl * (q.y * q.y - .35));
  vec3 n = normalize(vec3(-2. * cup * q.x, -2. * curl * q.y, 1.));
  vec3 world = a_pos.xyz + qrot(a_rot, local * a_pos.w);
  v_uv = q;
  v_normal = qrot(a_rot, n);
  v_view = u_eye - world;
  v_seed = a_shape.z;
  v_blur = a_shape.w;
  v_bright = a_tone.x;
  v_fog = a_tone.y;
  gl_Position = u_proj * vec4(world - u_eye, 1.);
}
`;

// language=GLSL
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_normal;
in vec3 v_view;
in float v_seed;
in float v_blur;
in float v_bright;
in float v_fog;
uniform vec3 u_fogColor;
out vec4 fragColor;

const vec3 LIGHT = vec3(.45, .7, .55);

/* Signed distance to the petal's outline, in petal units: base at y = -1,
   the notched tip at y = 1. */
float petalShape(vec2 q) {
  float y = q.y;
  float hw = .64 * sqrt(max(0., 1. - y * y)) * (.58 + .42 * smoothstep(-1., .3, y));
  float side = abs(q.x) - hw;
  float notch = y - (1. - .2 * max(0., 1. - abs(q.x) / .17));
  return max(side, max(notch, -1. - y));
}

float hash1(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  float sd = petalShape(v_uv);
  float aa = fwidth(sd) * 1.1 + v_blur;
  float cover = smoothstep(aa, -aa, sd);
  if (cover < .01) discard;
  vec3 V = normalize(v_view);
  vec3 n = normalize(v_normal);
  bool upper = dot(n, V) >= 0.;
  vec3 facing = upper ? n : -n;
  vec3 L = normalize(LIGHT);
  float lit = max(dot(facing, L), 0.);
  float through = max(dot(-facing, L), 0.);
  float sheen = pow(max(dot(reflect(-L, facing), V), 0.), 12.);
  float along = clamp(v_uv.y * .5 + .5, 0., 1.);
  vec3 base = mix(vec3(.93, .38, .58), vec3(1., .6, .74), hash1(v_seed * 91.7));
  vec3 albedo = mix(base, vec3(1., .88, .92), smoothstep(0., .85, along));
  // the underside is paler
  albedo = upper ? albedo : mix(albedo, vec3(1., .92, .95), .25);
  // fine veins fanning out from the base
  float fan = atan(v_uv.x, v_uv.y + 1.15);
  float vein = .5 + .5 * cos(fan * 46. + 2.5 * sin(fan * 9. + along * 3. + v_seed * 20.));
  albedo *= 1. - .05 * vein * smoothstep(1., .15, along) * smoothstep(-.9, -.5, v_uv.y);
  // deeper pink along the rim, paler and pearly in the middle
  float inner = smoothstep(0., -.4, sd);
  albedo = mix(albedo * vec3(.97, .8, .88), albedo, .45 + .55 * inner);
  albedo = mix(albedo, vec3(1., .96, .97), .25 * inner * smoothstep(.2, .8, along));
  // shade stays rosy: light still passes through a petal turned away
  vec3 c = albedo * mix(vec3(.5, .3, .42), vec3(1.12), pow(lit, .8)) + albedo * vec3(1., .82, .78) * through * .5;
  c += vec3(1., .97, .98) * sheen * .3;
  c = mix(c * v_bright, u_fogColor, v_fog);
  fragColor = vec4(c * cover, cover);
}
`;

/* Mesh resolution: enough rows that the bend reads as a curve. */
const COLUMNS = 8;
const ROWS = 14;
const MAX_PETALS = 260;
const STRIDE = 14;
const FOV = (38 * Math.PI) / 180;
const NEAR_Z = 2.4;
/* The most a petal's edge softens, in petal units, and the grid's margin for it. */
const MAX_BLUR = 0.2;
const MESH_MARGIN = 0.32;
const FAR_Z = 13;

function rand(seed: number): number {
  let t = (seed * 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface Petal {
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
  seed: number;
}

function makePetals(): Petal[] {
  const petals: Petal[] = [];
  for (let i = 0; i < MAX_PETALS; i++) {
    const r = (k: number) => rand(i * 31 + k + 1);
    const ax = r(7) - 0.5, ay = r(8) - 0.5, az = r(9) - 0.5 + 0.15;
    const len = Math.hypot(ax, ay, az) || 1;
    petals.push({
      // more of them in the middle distance than right at the lens
      depth: NEAR_Z + (FAR_Z - NEAR_Z) * Math.pow(r(1), 0.85),
      x0: r(2),
      y0: r(3),
      size: 0.075 + 0.04 * r(4),
      fall: 0.16 + 0.12 * r(5),
      drift: 0.05 + 0.06 * r(6),
      swayF: 0.6 + 0.7 * r(10),
      swayA: 0.08 + 0.12 * r(11),
      phase: r(12) * Math.PI * 2,
      axis: [ax / len, ay / len, az / len],
      spin: (0.5 + 1.1 * r(13)) * (r(14) > 0.5 ? 1 : -1),
      rock: 0.35 + 0.5 * r(15),
      cup: 0.18 + 0.22 * r(16),
      curl: (r(17) - 0.5) * 0.5,
      seed: r(18),
    });
  }
  return petals;
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

export interface ThemeOverlay {
  draw(width: number, height: number, time: number, pointer: [number, number], scroll: number): void;
}

export function createSakuraPetals(gl: WebGL2RenderingContext): ThemeOverlay | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    if (import.meta.env.DEV) console.warn("sakura petals", gl.getShaderInfoLog(shader));
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
  const uFog = gl.getUniformLocation(program, "u_fogColor");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  // the petal's grid, x across its width and y along its length, with a
  // margin past the outline for the soft edge of an out-of-focus petal (the
  // fragment shader cuts the shape; a grid only as big as the petal would
  // square off the blur)
  const grid: number[] = [];
  for (let row = 0; row <= ROWS; row++) {
    for (let col = 0; col <= COLUMNS; col++) grid.push(((col / COLUMNS) * 2 - 1) * (0.66 + MESH_MARGIN), ((row / ROWS) * 2 - 1) * (1 + MESH_MARGIN));
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
  gl.bufferData(gl.ARRAY_BUFFER, MAX_PETALS * STRIDE * 4, gl.DYNAMIC_DRAW);
  const attribute = (location: number, size: number, offset: number) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  };
  attribute(1, 4, 0);
  attribute(2, 4, 4);
  attribute(3, 4, 8);
  attribute(4, 2, 12);
  gl.bindVertexArray(null);

  const petals = makePetals();
  const data = new Float32Array(MAX_PETALS * STRIDE);
  const order: Array<{ z: number; index: number }> = [];
  const scratch = new Float32Array(STRIDE);
  const tanHalf = Math.tan(FOV / 2);

  return {
    draw(width, height, time, pointer, scroll) {
      const aspect = width / height;
      // the eye leans a little after the pointer, so near petals slide past far ones
      const eye: [number, number, number] = [(pointer[0] - 0.5) * 0.35, (pointer[1] - 0.5) * 0.2, 0];
      const count = Math.min(MAX_PETALS, Math.round(95 * Math.min(Math.max(aspect / 1.78, 0.7), 2.6)));
      const gust = Math.max(0, Math.sin(time * 0.23)) ** 3 * 0.9;
      order.length = 0;
      for (let i = 0; i < count; i++) {
        const p = petals[i];
        const halfH = p.depth * tanHalf + 0.4;
        const halfW = halfH * aspect + 0.4;
        // the page scrolling carries the near ones off faster than the far
        const parallax = 0.25 + 0.6 * (1 - (p.depth - NEAR_Z) / (FAR_Z - NEAR_Z));
        const sway = Math.sin(time * p.swayF + p.phase);
        const y = wrap(p.y0 * halfH * 2 - time * p.fall + scroll * halfH * 2 * parallax, halfH * 2) - halfH;
        const x = wrap(p.x0 * halfW * 2 + time * p.drift + gust * time * 0.12 + sway * p.swayA, halfW * 2) - halfW;
        const z = -p.depth;
        // a steady tumble, plus a rock that follows the sway the way a
        // falling petal tips into each swing
        const tumble = quatAxis(p.axis[0], p.axis[1], p.axis[2], time * p.spin + p.phase * 3);
        const rock = quatAxis(0, 0, 1, Math.cos(time * p.swayF + p.phase) * p.rock);
        const q = quatMul(rock, tumble);
        const curl = p.curl + 0.12 * Math.sin(time * 1.7 + p.seed * 13);
        // out of focus nearest the lens and at the very back
        const near = Math.max(0, 1 - (p.depth - NEAR_Z) / 1.4);
        const far = Math.max(0, (p.depth - (FAR_Z - 3)) / 3);
        const blur = Math.min(MAX_BLUR, near * MAX_BLUR + far * 0.06);
        const fog = 0.55 * Math.pow((p.depth - NEAR_Z) / (FAR_Z - NEAR_Z), 1.4);
        const bright = 0.95 - 0.12 * near;
        const o = i * STRIDE;
        data[o] = x; data[o + 1] = y; data[o + 2] = z; data[o + 3] = p.size;
        data[o + 4] = q[0]; data[o + 5] = q[1]; data[o + 6] = q[2]; data[o + 7] = q[3];
        data[o + 8] = p.cup; data[o + 9] = curl; data[o + 10] = p.seed; data[o + 11] = blur;
        data[o + 12] = bright; data[o + 13] = fog;
        order.push({ z, index: i });
      }
      // far to near, so soft edges blend over what is behind them
      order.sort((a, b) => a.z - b.z);
      const sorted = new Float32Array(count * STRIDE);
      order.forEach(({ index }, slot) => {
        scratch.set(data.subarray(index * STRIDE, index * STRIDE + STRIDE));
        sorted.set(scratch, slot * STRIDE);
      });

      const f = 1 / tanHalf;
      const near = 0.3, far = 40;
      const proj = new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
      ]);

      gl.useProgram(program);
      gl.uniformMatrix4fv(uProj, false, proj);
      gl.uniform3f(uEye, eye[0], eye[1], eye[2]);
      gl.uniform3f(uFog, 0.09, 0.03, 0.065);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted);
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
