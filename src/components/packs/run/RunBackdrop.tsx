import { useEffect, useRef } from "react";
import { RUN_FEEL } from "./runFeel";

/* The run table's living background: a slow ink field that keeps folding
   into itself, in the site's dark palette. The mood shifts its colours and
   speed (blended over about a second), so a mod song, a burning score, a
   failed run and a cleared one each read in the room before anything is
   said. One quad, one fragment shader; a flat gradient stands in when WebGL
   is missing, and reduced motion gets one still frame. */

export type RunMood = "calm" | "mod" | "fire" | "failed" | "won";

type Rgb = readonly [number, number, number];

interface MoodPalette {
  base: Rgb;
  mid: Rgb;
  ink: Rgb;
  glint: Rgb;
  speed: number;
  swirl: number;
}

const hex = (value: string): Rgb => {
  const n = Number.parseInt(value.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/* Colours per mood. calm sits on osu-b5/b6 with violet ink and a trace of the
   site pink; the rest lean the same field toward their own hue. */
export const RUN_MOODS: Record<RunMood, MoodPalette> = {
  calm: { base: hex("#120f1a"), mid: hex("#231a33"), ink: hex("#46306a"), glint: hex("#ff66aa"), speed: 1, swirl: 0.9 },
  mod: { base: hex("#170c14"), mid: hex("#341526"), ink: hex("#6e2244"), glint: hex("#ff6b6b"), speed: 1.35, swirl: 1.25 },
  fire: { base: hex("#170806"), mid: hex("#3b130a"), ink: hex("#a83c14"), glint: hex("#ffc04d"), speed: 2.1, swirl: 1.5 },
  failed: { base: hex("#0f0d10"), mid: hex("#1d1619"), ink: hex("#3b2226"), glint: hex("#6d6878"), speed: 0.35, swirl: 0.5 },
  won: { base: hex("#0d1512"), mid: hex("#16302a"), ink: hex("#2f6a55"), glint: hex("#ffd36b"), speed: 1.2, swirl: 1.1 },
};

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/* Written for this table. Two layers of value noise feed each other's
   coordinates (domain warping) inside a rotation that grows with the distance
   from the centre, which is what makes the field read as ink being stirred
   rather than clouds drifting. */
const FRAGMENT = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_swirl;
uniform vec3 u_base;
uniform vec3 u_mid;
uniform vec3 u_ink;
uniform vec3 u_glint;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

float field(vec2 p) {
  float total = 0.0;
  float amp = 0.55;
  mat2 turn = mat2(1.62, 1.18, -1.18, 1.62);
  for (int i = 0; i < 4; i++) {
    total += amp * vnoise(p);
    p = turn * p + 3.1;
    amp *= 0.5;
  }
  return total;
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;
  float r = length(uv);
  // Stirred: the outer field turns further than the middle.
  uv = rot(t * 0.035 + u_swirl * (0.9 - r) * 0.9 + sin(t * 0.07) * 0.4) * uv;
  vec2 p = uv * 1.7;
  vec2 warpA = vec2(field(p + vec2(0.0, t * 0.06)), field(p + vec2(4.7, -1.9) - t * 0.05));
  vec2 warpB = vec2(
    field(p + 2.6 * warpA + vec2(1.3, 8.1) + t * 0.04),
    field(p + 2.6 * warpA + vec2(7.9, 2.2) - t * 0.045)
  );
  float ink = field(p + 3.2 * warpB);
  // Thin bright folds where the warp doubles back on itself.
  float fold = 1.0 - smoothstep(0.0, 0.06, abs(fract(ink * 3.0 + warpB.x * 1.5) - 0.5) - 0.38);
  vec3 col = mix(u_base, u_mid, smoothstep(0.25, 0.7, ink));
  col = mix(col, u_ink, smoothstep(0.5, 0.95, ink * length(warpB)) * 0.85);
  col += u_ink * fold * 0.18;
  col += u_glint * pow(smoothstep(0.62, 1.0, ink), 3.0) * 0.22;
  // Sinks to the base colour at the edges, so the table reads framed.
  col = mix(col, u_base, smoothstep(0.55, 1.25, r) * 0.7);
  gl_FragColor = vec4(col, 1.0);
}
`;

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

/* CSS stand-in for the field: the same palette as a still gradient. */
function fallbackGradient(mood: RunMood): string {
  const toCss = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
  const palette = RUN_MOODS[mood];
  return `radial-gradient(120% 90% at 50% 45%, ${toCss(palette.ink)} 0%, ${toCss(palette.mid)} 45%, ${toCss(palette.base)} 100%)`;
}

export function RunBackdrop({ mood, reducedMotion }: { mood: RunMood; reducedMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  /* Set by the render loop: draws one frame on demand (reduced motion, a
     mood change while paused). */
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    redrawRef.current?.();
  }, [mood]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl) {
      canvas.style.display = "none";
      return;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      canvas.style.display = "none";
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      canvas.style.display = "none";
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uRes = uniform("u_res");
    const uTime = uniform("u_time");
    const uSwirl = uniform("u_swirl");
    const uBase = uniform("u_base");
    const uMid = uniform("u_mid");
    const uInk = uniform("u_ink");
    const uGlint = uniform("u_glint");

    /* The live palette, eased toward the mood's each frame. */
    const start = RUN_MOODS[moodRef.current];
    const live = {
      base: [...start.base],
      mid: [...start.mid],
      ink: [...start.ink],
      glint: [...start.glint],
      speed: start.speed,
      swirl: start.swirl,
    };
    // Field time advances by speed, so a speed change never jumps the phase.
    let fieldTime = 40 + Math.random() * 60;
    let last = performance.now();
    let frame = 0;
    let running = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, RUN_FEEL.backdrop.maxDpr);
      const scale = dpr * RUN_FEEL.backdrop.resolutionScale;
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const draw = (dt: number) => {
      const target = RUN_MOODS[moodRef.current];
      // Exponential approach: about 95% of the way in moodLerpMs.
      const k = dt <= 0 ? 1 : 1 - Math.exp((-3 * dt) / RUN_FEEL.backdrop.moodLerpMs);
      for (const key of ["base", "mid", "ink", "glint"] as const) {
        for (let i = 0; i < 3; i += 1) live[key][i] += (target[key][i] - live[key][i]) * k;
      }
      live.speed += (target.speed - live.speed) * k;
      // The swirl winds up fast and unwinds slowly (feel §9).
      const swirlGap = target.swirl - live.swirl;
      const swirlStep = (dt / 1000) * (swirlGap > 0 ? RUN_FEEL.backdrop.swirlUpPerSec : RUN_FEEL.backdrop.swirlDownPerSec);
      live.swirl = dt <= 0 ? target.swirl : live.swirl + Math.sign(swirlGap) * Math.min(Math.abs(swirlGap), swirlStep);
      fieldTime += (dt / 1000) * live.speed;
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, fieldTime);
      gl.uniform1f(uSwirl, live.swirl);
      gl.uniform3fv(uBase, live.base);
      gl.uniform3fv(uMid, live.mid);
      gl.uniform3fv(uInk, live.ink);
      gl.uniform3fv(uGlint, live.glint);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      draw(dt);
      frame = window.requestAnimationFrame(loop);
    };
    const play = () => {
      if (running || reducedMotion || document.hidden) return;
      running = true;
      last = performance.now();
      frame = window.requestAnimationFrame(loop);
    };
    const pause = () => {
      running = false;
      window.cancelAnimationFrame(frame);
    };
    /* Reduced motion and a hidden tab: a still frame at the target mood. */
    redrawRef.current = () => {
      if (!running) draw(0);
    };
    const onVisibility = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new ResizeObserver(() => {
      if (!running) draw(0);
    });
    observer.observe(canvas);
    draw(0);
    play();
    return () => {
      pause();
      redrawRef.current = null;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, [reducedMotion]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden" style={{ background: fallbackGradient(mood) }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
