/* The fire a renewing supporter's rank burns with: pointed flames in the
   rank's own colours rise behind the gem on every side, and their bright tongues
   lick in over its face (drawn on a second canvas screened over the gem,
   which is what makes it read as a lit crystal).

   One WebGL context per badge, on a canvas kept off the page: each frame it
   draws the front pass and copies it onto the front canvas, then the back
   pass onto the back one. Both canvases on the page are plain 2D, so a lost
   context (a reload, a GPU reset) leaves them empty instead of painting the
   white box a lost WebGL canvas shows. The badge holds a gl-budget slot. */

/* How far the canvases reach past the badge, as shares of its size. */
export const RANK_FIRE_BLEED = { x: 0.75, top: 1.6, bottom: 0.45 };
/* How long it takes to catch when it first shows. */
const IGNITE_MS = 1100;

const VERT = "attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }";

const FRAG = `
precision highp float;
uniform float uTime; uniform float uIgnite; uniform vec3 uA; uniform vec3 uB; uniform vec2 uGem; uniform float uSize; uniform int uLayer;
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
float fbm3(vec2 p){ float v=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<3;i++){ v+=a*noise(p); p=m*p; a*=.5; } return v; }
// the gem: a regular hexagon with flat top and bottom, corners rounded
float sdHex(vec2 p, float r){ const vec3 k=vec3(-.866025404,.5,.577350269); p=abs(p); p-=2.*min(dot(k.xy,p),0.)*k.xy; p-=vec2(clamp(p.x,-k.z*r,k.z*r),r); return length(p)*sign(p.y); }
void main(){
  vec2 p = (gl_FragCoord.xy - uGem) / uSize; // badge units, y up, gem centre at 0
  float t = uTime;
  vec2 q = vec2(p.x * 3.8, p.y * 1.15 - t * 2.1);
  float warp = fbm3(q * .55 + vec2(0., -t * .35));
  float n = fbm3(q + vec2(warp, 0.));
  // the outline is sampled lower where the noise is high, so even the side
  // flames lean up instead of sticking out
  float lift = n * .28;
  // stretched tall above the middle, kept close below it, blended across the
  // middle so the two halves meet without a seam
  float above = smoothstep(-.2, .2, p.y);
  vec2 ps = vec2(p.x * 1.06, (p.y - lift * mix(.6, 1., above)) * mix(.9, .42, above));
  float d = sdHex(ps, .256) - .16;
  float dIn = sdHex(p, .256) - .16;
  float fuel = ((.14 - d) * 6.5 + (n - .5) * 2.4 - max(p.y, 0.) * 1.05) * 1.15 - .08;
  // catching: the flames grow up out of the gem instead of appearing whole
  fuel -= (1. - uIgnite) * 2.6;
  // thinner as they rise, so each tongue comes to a point
  float body = smoothstep(0., .1, fuel) * smoothstep(-.2, .35, fuel - max(p.y, 0.) * .5);
  float a = uLayer == 0 ? body
    : (dIn < 0. ? body * smoothstep(.35, 1.1, fuel) * smoothstep(-.14, 0., dIn) * .5 : 0.);
  vec3 col = mix(uA, uB, smoothstep(.2, 1., fuel));
  col = mix(col, vec3(1.), smoothstep(1.1, 1.9, fuel) * .5);
  a = clamp(a, 0., 1.) * .88 * smoothstep(0., .35, uIgnite);
  gl_FragColor = vec4(col * a, a);
}`;

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}


export interface RankFire {
  /** Shifts the fire to another rank's colours over a moment, without catching again. */
  setColors(colors: readonly [string, string]): void;
  dispose(): void;
}

/* How long a change of colours takes to blend over. */
const RECOLOR_MS = 500;

/* Starts the fire on the two canvases; null when WebGL is missing.
   `colors` is the rank's flame base and its light core. */
export function mountRankFire(back: HTMLCanvasElement, front: HTMLCanvasElement, colors: readonly [string, string]): RankFire | null {
  const offscreen = document.createElement("canvas");
  const gl = offscreen.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false, powerPreference: "low-power" });
  const ctx = front.getContext("2d");
  const backCtx = back.getContext("2d");
  if (!gl || !ctx || !backCtx) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uA = uniform("uA"), uB = uniform("uB");
  // the colours drawn now, and a blend toward new ones when the rank changes
  let shown = [rgb(colors[0]), rgb(colors[1])];
  let blend: { from: [number, number, number][]; to: [number, number, number][]; at: number } | null = null;
  const applyColors = (pair: [number, number, number][]) => {
    gl.uniform3fv(uA, pair[0]);
    gl.uniform3fv(uB, pair[1]);
  };
  applyColors(shown);
  const uTime = uniform("uTime"), uLayer = uniform("uLayer"), uIgnite = uniform("uIgnite");
  // a lost context empties both canvases and tells the badge's gl-budget slot
  // (which listens on the page for losses) so it can rebuild later
  const onLost = () => {
    ctx.clearRect(0, 0, front.width, front.height);
    backCtx.clearRect(0, 0, back.width, back.height);
    back.dispatchEvent(new Event("webglcontextlost"));
  };
  offscreen.addEventListener("webglcontextlost", onLost);
  const seed = Math.random() * 40;

  // the badge's size in CSS pixels, read from the back canvas' box
  let size = 0, dpr = 1;
  const resize = () => {
    const width = back.clientWidth;
    if (!width) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    size = width / (1 + 2 * RANK_FIRE_BLEED.x);
    for (const canvas of [back, front, offscreen]) {
      canvas.width = Math.round(back.clientWidth * dpr);
      canvas.height = Math.round(back.clientHeight * dpr);
    }
    gl.viewport(0, 0, offscreen.width, offscreen.height);
    gl.uniform2f(uniform("uGem"), (RANK_FIRE_BLEED.x + 0.5) * size * dpr, (RANK_FIRE_BLEED.bottom + 0.5) * size * dpr);
    gl.uniform1f(uniform("uSize"), size * dpr);
  };
  const sizer = new ResizeObserver(resize);
  sizer.observe(back);
  resize();

  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) queue();
  });
  watcher.observe(back);

  let frame = 0, drawnAt = 0;
  const start = performance.now();
  const queue = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    frame = 0;
    if (!visible || gl.isContextLost()) return;
    queue();
    // 40 fps is plenty for something this small
    if (now - drawnAt < 24) return;
    drawnAt = now;
    const t = (now - start) / 1000 + seed;
    // it catches over IGNITE_MS, easing out
    const ignite = 1 - (1 - Math.min(1, (now - start) / IGNITE_MS)) ** 3;
    gl.uniform1f(uIgnite, ignite);
    if (blend) {
      const k = Math.min(1, (now - blend.at) / RECOLOR_MS);
      const e = k * k * (3 - 2 * k);
      shown = blend.from.map((from, i) => from.map((value, c) => value + (blend!.to[i][c] - value) * e) as [number, number, number]);
      applyColors(shown);
      if (k >= 1) blend = null;
    }
    if (!size) return;

    // the licks over the gem, copied onto the front canvas
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uTime, t);
    gl.uniform1i(uLayer, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.clearRect(0, 0, front.width, front.height);
    ctx.drawImage(offscreen, 0, 0);
    // then the fire behind the gem
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(uLayer, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    backCtx.clearRect(0, 0, back.width, back.height);
    backCtx.drawImage(offscreen, 0, 0);
  };
  queue();

  const dispose = () => {
    cancelAnimationFrame(frame);
    sizer.disconnect();
    watcher.disconnect();
    offscreen.removeEventListener("webglcontextlost", onLost);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    // off the page, so letting it go now paints nothing
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  return {
    setColors(next) {
      blend = { from: shown, to: [rgb(next[0]), rgb(next[1])], at: performance.now() };
    },
    dispose,
  };
}
