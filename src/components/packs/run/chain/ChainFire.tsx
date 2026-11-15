import { useEffect, useRef, useState } from "react";
import { drawFiltered } from "#/lib/canvas";
import { InkFlame, inkFlameLook } from "./InkFlame";

/* The fire on the round score once it passes the target, burning off the
   number itself: the number's own outlined glyphs are the fuel (so the
   fire never shows an edge of its own), and every pixel above takes the
   hottest fuel below it, near and straight under burning white, further and curled sideways
   cooling to the tips. Broad tongues lick to their own drifting heights with
   rounded tips, and slow turbulence shapes them. It is drawn in the paint backdrop's big pixels (CELL) and in flat
   bands, white by the glyphs out to the tips and a last band in the number's
   own outline ink, so number and fire read as one piece. Embers lift off as
   single pixels.

   It burns in the five looks the SVG fire had (inkFlameLook: an ember fire
   past the target, a blaze from 1.5x, white-hot from 3x, the pink inferno
   from 10x, the violet star fire from 100x); crossing into one flares the
   fire and fades its colours over, and it catches by rising out of the
   number on a spring. The loop sleeps while the tab is hidden or the canvas
   is off screen; reduced motion draws one still frame; without WebGL the SVG
   fire (InkFlame) stands in. */

/* CSS px per fire pixel: the paint backdrop's (ROWS_PER_CSS_PX). */
const CELL = 2.6;
const INK = "#120f1a";

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_mask;
uniform vec2 u_res;
uniform float u_time;
uniform float u_reach;
uniform float u_speed;
uniform float u_flare;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec3 u_ink;
uniform float u_embers;
uniform vec2 u_span;
uniform float u_base;

// Stays in small numbers at any precision (a sin hash overflows half floats).
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash11(float n) { return hash21(vec2(n, n * 0.371 + 7.13)); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), s.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), s.x), s.y);
}
float fbm(vec2 p) {
  float total = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    total += amp * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(3.1, 1.7);
    amp *= 0.5;
  }
  return total;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float t = u_time * u_speed;
  float reach = u_reach * (1.0 + 0.35 * u_flare);
  // Long fires take bigger steps, so the loop stays bounded.
  float step = max(1.0, reach / 96.0);
  // Broad tongues: each lick is several pixels wide and swells and shrinks.
  float c = fbm(vec2(p.x * 0.055 + t * 0.22, t * 0.55));
  float colLen = 0.3 + 1.45 * smoothstep(0.3, 0.8, c);
  float best = 0.0;
  for (int i = 0; i < 100; i++) {
    float fi = float(i) * step;
    if (fi > reach) break;
    // The falloff only shrinks from here and the mask is at most 1, so once
    // it is no more than the best found nothing further down can win: stop
    // (the same picture, a fraction of the lookups).
    float falloff = 1.0 - smoothstep(0.0, colLen, fi / reach);
    if (falloff <= best) break;
    // Slow, wide curls, more the further it gets from the glyphs.
    float drift = (fbm(vec2(p.x * 0.03, (p.y - fi) * 0.03 - t * 0.8)) - 0.5) * fi * 0.7;
    float m = texture2D(u_mask, (p - vec2(drift, fi)) / u_res).a;
    // Rounded tips: the falloff eases out instead of a straight ramp.
    best = max(best, m * falloff);
  }
  float v = 0.0;
  if (best > 0.0) {
    // Soft, low-frequency turbulence shapes the licks without shredding them
    // (and never makes fire from nothing).
    float n = fbm(vec2(p.x * 0.06, p.y * 0.05 - t * 1.6));
    v = best - (n - 0.45) * 0.5 * smoothstep(0.0, 0.6, 1.0 - best) + u_flare * 0.12;
  }
  vec4 col = vec4(0.0);
  if (v > 0.8) col = vec4(u_c3, 1.0);
  else if (v > 0.58) col = vec4(u_c2, 1.0);
  else if (v > 0.36) col = vec4(u_c1, 1.0);
  else if (v > 0.16) col = vec4(u_c0, 1.0);
  else if (v > 0.07) col = vec4(u_ink, 1.0);

  // Embers: single pixels lifting off the number.
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    if (fi > 24.0 * u_embers) break;
    float life = 1.4 + hash11(fi * 3.1) * 1.2;
    float phase = fract(t / life + hash11(fi * 7.7));
    float ex = floor(mix(u_span.x, u_span.y, hash11(fi * 1.3)) + sin(u_time * 2.0 + fi) * 3.0 * phase);
    float ey = floor(u_base + phase * reach * 1.4);
    if (abs(p.x - 0.5 - ex) < 0.6 && abs(p.y - 0.5 - ey) < 0.6 && col.a < 0.5 && phase < 0.85 && ey < u_res.y - 1.0) {
      col = vec4(mix(u_c3, u_c1, phase), 1.0);
    }
  }
  gl_FragColor = vec4(col.rgb * col.a, col.a);
}
`;

interface FireLook {
  /* Tips, body, hot, core (by the glyphs). */
  colors: [string, string, string, string];
  speed: number;
  embers: number;
}

/* The five looks, by inkFlameLook's index (1x, 1.5x, 3x, 10x, 100x). */
const LOOKS: FireLook[] = [
  { colors: ["#b8321a", "#f06a24", "#ffb43a", "#ffe9a8"], speed: 1, embers: 0.3 },
  { colors: ["#c2361a", "#ff7a1f", "#ffd24d", "#fff6d8"], speed: 1.15, embers: 0.5 },
  { colors: ["#e04420", "#ffa030", "#fff0a0", "#ffffff"], speed: 1.35, embers: 0.7 },
  { colors: ["#b0206e", "#ff4f9a", "#ffb3d6", "#fff3e6"], speed: 1.55, embers: 0.85 },
  { colors: ["#4b2bd0", "#7a5cff", "#6fe3ff", "#ffffff"], speed: 1.8, embers: 1 },
];

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as Rgb;
interface Shade {
  colors: Rgb[];
  speed: number;
  embers: number;
}
const SHADES: Shade[] = LOOKS.map((look) => ({ colors: look.colors.map(rgb), speed: look.speed, embers: look.embers }));
const mixShade = (a: Shade, b: Shade, k: number): Shade => ({
  colors: a.colors.map((color, index) => color.map((value, channel) => value + (b.colors[index][channel] - value) * k) as Rgb),
  speed: a.speed + (b.speed - a.speed) * k,
  embers: a.embers + (b.embers - a.embers) * k,
});

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

interface FireGl {
  upload: (mask: HTMLCanvasElement) => void;
  draw: (time: number, shade: Shade, reach: number, flare: number, span: [number, number], base: number) => void;
  /* Blocks until what was drawn is really done. */
  finish: () => void;
  dispose: () => void;
}

function createFireGl(canvas: HTMLCanvasElement): FireGl | null {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, stencil: false });
  if (!gl) return null;
  // Hands the context back now rather than when the page is collected.
  const release = () => gl.getExtension("WEBGL_lose_context")?.loseContext();
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) {
    release();
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    release();
    return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    mask: at("u_mask"),
    res: at("u_res"),
    time: at("u_time"),
    reach: at("u_reach"),
    speed: at("u_speed"),
    flare: at("u_flare"),
    colors: [at("u_c0"), at("u_c1"), at("u_c2"), at("u_c3")],
    ink: at("u_ink"),
    embers: at("u_embers"),
    span: at("u_span"),
    base: at("u_base"),
  };
  const ink = rgb(INK);
  gl.clearColor(0, 0, 0, 0);
  return {
    upload: (mask) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
    },
    draw: (time, shade, reach, flare, span, base) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1i(u.mask, 0);
      gl.uniform2f(u.res, canvas.width, canvas.height);
      // Wrapped, so the time stays small at mediump precision.
      gl.uniform1f(u.time, time % 600);
      gl.uniform1f(u.reach, reach);
      gl.uniform1f(u.speed, shade.speed);
      gl.uniform1f(u.flare, flare);
      shade.colors.forEach((color, index) => gl.uniform3f(u.colors[index], color[0], color[1], color[2]));
      gl.uniform3f(u.ink, ink[0], ink[1], ink[2]);
      gl.uniform1f(u.embers, shade.embers);
      gl.uniform2f(u.span, span[0], span[1]);
      gl.uniform1f(u.base, base);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    finish: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)),
    dispose: () => {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      release();
    },
  };
}

/* One fire kept ready between burns. The driver builds the shader on its
   first draw (tens of milliseconds, a dropped-frame hitch right as the number
   catches), so the table warms one while idle and each burn takes it. */
interface WarmFire {
  canvas: HTMLCanvasElement;
  fire: FireGl;
}
let spare: WarmFire | null = null;

function makeFire(): WarmFire | null {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:pixelated";
  canvas.width = 4;
  canvas.height = 4;
  const fire = createFireGl(canvas);
  if (!fire) return null;
  // One real draw, so the program is built before it is needed.
  fire.upload(canvas);
  fire.draw(0, SHADES[0], 4, 0, [0, 0], 0);
  fire.finish();
  return { canvas, fire };
}

function takeFire(): WarmFire | null {
  const warm = spare ?? makeFire();
  spare = null;
  return warm;
}

/* Called by the table while it sits idle; the returned function lets the
   spare go when the table leaves. */
export function warmChainFire(): () => void {
  let cancelled = false;
  const warm = () => {
    if (!cancelled && !spare) spare = makeFire();
  };
  const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(warm, { timeout: 2000 }) : window.setTimeout(warm, 300);
  return () => {
    cancelled = true;
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
    else window.clearTimeout(idle);
    spare?.fire.dispose();
    spare = null;
  };
}

/* Placed at the number's centre (the parent's 0,0): the canvas spans `width`
   across it and runs from `reach` px above the number's top down to just
   under it. `text`, `size` and `stroke` are the number as drawn (its font is
   the page's, at weight 900), so the glyphs the fire burns off sit exactly
   under the real ones. `level` and `ratio` as InkFlame's: on above zero, the
   look from score / target. */
export function ChainFire({
  text,
  size,
  stroke,
  width,
  reach,
  level,
  ratio,
  reducedMotion,
}: {
  text: string;
  size: number;
  stroke: number;
  width: number;
  reach: number;
  level: number;
  ratio: number;
  reducedMotion: boolean;
}) {
  /* The canvas comes warm from the table (takeFire) and goes back when the
     fire goes out; one that lost its context is dropped, since a released
     canvas only ever hands back its lost context. */
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const redraw = useRef<(() => void) | null>(null);
  const look = inkFlameLook(ratio);
  const cols = Math.max(4, Math.round(width / CELL));
  const top = reach + size * 0.6;
  const rows = Math.max(4, Math.round((top + size * 0.6) / CELL));
  const live = useRef({ look, reach: reach / CELL, text, size, stroke, cols, rows, top });
  live.current = { look, reach: reach / CELL, text, size, stroke, cols, rows, top };
  const on = level > 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !on) return;
    const taken = takeFire();
    if (!taken) {
      setFailed(true);
      return;
    }
    const { canvas, fire } = taken;
    host.appendChild(canvas);
    let dead = false;
    const mask = document.createElement("canvas");
    const font = getComputedStyle(canvas).fontFamily || "sans-serif";
    let drawn = "";
    let span: [number, number] = [0, 0];
    // The glyphs' top, in the fire's pixels from the bottom: where embers start.
    let base = 0;
    // The number's glyphs and outline, at the fire's pixel size.
    const paintMask = () => {
      const now = live.current;
      const key = `${now.text}|${now.size}|${now.stroke}|${now.cols}|${now.rows}|${now.top}`;
      if (key === drawn) return;
      drawn = key;
      if (canvas.width !== now.cols || canvas.height !== now.rows) {
        canvas.width = now.cols;
        canvas.height = now.rows;
      }
      mask.width = now.cols;
      mask.height = now.rows;
      const context = mask.getContext("2d");
      if (!context) return;
      context.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0);
      context.font = `900 ${now.size}px ${font}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineJoin = "round";
      const x = (now.cols * CELL) / 2;
      // The fuel is the number exactly as drawn (fill and outline) with a hair
      // of blur: wherever the fire starts, the digits sit over it, so no
      // edge of it ever shows.
      context.lineWidth = now.stroke;
      drawFiltered(context, `blur(${Math.max(1, now.size * 0.02)}px)`, (layer) => {
        layer.strokeText(now.text, x, now.top);
        layer.fillText(now.text, x, now.top);
      });
      const half = context.measureText(now.text).width / 2;
      span = [(x - half) / CELL, (x + half) / CELL];
      base = now.rows - (now.top - now.size * 0.35) / CELL;
      fire.upload(mask);
    };
    let frame = 0;
    let visible = true;
    let shown = live.current.look;
    let from = SHADES[shown];
    let fadeStart = -1;
    let flare = 0;
    // It catches by rising out of the number on a spring.
    let grown = reducedMotion ? 1 : 0;
    let velocity = 0;
    let last = performance.now();
    const started = last;
    const tick = (now: number) => {
      frame = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      paintMask();
      const wanted = live.current;
      if (wanted.look !== shown) {
        from = fadeStart >= 0 ? mixShade(from, SHADES[shown], Math.min(1, (now - fadeStart) / 450)) : SHADES[shown];
        if (wanted.look > shown && !reducedMotion) flare = 1;
        shown = wanted.look;
        fadeStart = now;
      }
      const fade = fadeStart < 0 || reducedMotion ? 1 : Math.min(1, (now - fadeStart) / 450);
      const shade = fade >= 1 ? SHADES[shown] : mixShade(from, SHADES[shown], fade);
      velocity += (170 * (1 - grown) - 11 * velocity) * dt;
      grown += velocity * dt;
      flare = Math.max(0, flare - dt * 1.4);
      fire.draw((now - started) / 1000, shade, wanted.reach * Math.max(0.05, grown), flare, span, base);
      if (!reducedMotion && visible && !document.hidden) frame = requestAnimationFrame(tick);
    };
    // A still fire (reduced motion) redraws when the number changes.
    redraw.current = () => {
      if (reducedMotion) tick(performance.now());
    };
    const wake = () => {
      if (!frame && visible && !document.hidden && !reducedMotion) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      wake();
    });
    observer.observe(canvas);
    document.addEventListener("visibilitychange", wake);
    const lost = (event: Event) => {
      event.preventDefault();
      dead = true;
      setFailed(true);
    };
    canvas.addEventListener("webglcontextlost", lost);
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", wake);
      canvas.removeEventListener("webglcontextlost", lost);
      redraw.current = null;
      canvas.remove();
      if (dead || spare) fire.dispose();
      else spare = taken;
    };
  }, [on, reducedMotion]);
  useEffect(() => {
    redraw.current?.();
  }, [text, size, look]);

  if (!on) return null;
  if (failed) {
    return (
      <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-full" style={{ left: 0, top: Math.round(size * 0.46) }}>
        <InkFlame level={level} ratio={ratio} width={width} reducedMotion={reducedMotion} />
      </div>
    );
  }
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{ left: -(cols * CELL) / 2, top: -top, width: cols * CELL, height: rows * CELL }}
    />
  );
}
