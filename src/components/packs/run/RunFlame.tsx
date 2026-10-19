import { useEffect, useRef } from "react";
import { RUN_FEEL } from "./runFeel";

/* The fire on the song score once it passes the target (bar F5). One WebGL
   quad behind the score's box: pixelated tongues scrolling up out of the box,
   deep orange at the root and yellow at the tips, with a hard edge. Its
   height follows `level` through a soft spring, so it flares when it catches
   and settles to the overshoot's level; when the level drops to 0 it burns
   down and the loop stops. The loop sleeps while the tab is hidden or the
   canvas is off screen (the phone and desktop HUDs both mount one; only the
   shown one ever gets a context). */

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/* Written for this table. Two octaves of scrolling value noise bend a
   height falloff that starts at the box's top edge; where the bent value
   clears zero the cell burns. */
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_level;
uniform float u_cell;
uniform float u_box;
uniform vec2 u_span;

// Stays in small numbers at any precision: the old fract(p * 456.21) hash
// overflowed half floats on high octaves and turned the whole flame NaN.
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

float fbm(vec2 p) {
  float total = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    total += amp * vnoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amp *= 0.5;
  }
  return total;
}

void main() {
  vec2 cell = (floor(gl_FragCoord.xy / u_cell) + 0.5) * u_cell;
  vec2 uv = cell / u_res;
  // Work in box heights: x across, h up from the box's top edge.
  float boxH = max(u_box, 0.05);
  float unit = boxH * u_res.y;
  float xb = uv.x * u_res.x / unit;
  float h = (uv.y - boxH) / boxH;
  float side = max(u_span.x - uv.x, uv.x - u_span.y) * u_res.x / unit;
  // Nothing below the box's top outside it: the fire sits on the box.
  if (u_level < 0.04 || (h < 0.0 && side > 0.0)) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float level = min(u_level, 1.6);
  float reach = 0.55 + 0.8 * level;
  float t = u_time;
  // Each column has its own height, drifting sideways, so the top is a
  // row of tongues rather than a ridge.
  float column = fbm(vec2(xb * 1.7 + t * 0.32, t * 0.5));
  float height = reach * (0.45 + 1.1 * column);
  // Turbulence scrolling up, plus finer licks that break off at the tips.
  float turb = fbm(vec2(xb * 2.4, h * 1.5 - t * 2.1));
  float lick = fbm(vec2(xb * 5.2 + 3.7, h * 3.2 - t * 3.6));
  float v = 1.0 - h / height + (turb - 0.5) * 0.95 + (lick - 0.5) * 0.5;
  v -= max(side, 0.0) * 2.6;
  // Thins out before the canvas's top edge instead of being cut by it.
  v -= max(uv.y - 0.82, 0.0) * 9.0;
  if (!(v > 0.0)) {
    gl_FragColor = vec4(0.0);
    return;
  }
  // Banded, hard edged: red rim, orange body, yellow heart, pale core.
  // Past the height the canvas allows (about 5x the target), a hotter fire
  // shows in its colour instead: the bands slide toward the rim, so a 20x
  // pack burns yellow and white where a 5x one burns orange.
  float heat = clamp((u_level - 0.9) / 0.7, 0.0, 1.0);
  vec3 col = vec3(0.86, 0.22, 0.10);
  col = mix(col, vec3(1.0, 0.50, 0.12), step(0.18 - 0.1 * heat, v));
  col = mix(col, vec3(1.0, 0.80, 0.30), step(0.5 - 0.26 * heat, v));
  col = mix(col, vec3(1.0, 0.95, 0.70), step(1.05 - 0.5 * heat, v));
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

interface FlameGl {
  gl: WebGLRenderingContext;
  draw: (time: number, level: number) => void;
  clear: () => void;
  dispose: () => void;
}

function createFlameGl(canvas: HTMLCanvasElement, box: () => { top: number; left: number; right: number }): FlameGl | null {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, stencil: false });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(program, "u_res");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uLevel = gl.getUniformLocation(program, "u_level");
  const uCell = gl.getUniformLocation(program, "u_cell");
  const uBox = gl.getUniformLocation(program, "u_box");
  const uSpan = gl.getUniformLocation(program, "u_span");
  gl.clearColor(0, 0, 0, 0);

  const resize = (): number => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    return dpr;
  };

  return {
    gl,
    draw: (time, level) => {
      const dpr = resize();
      const { top, left, right } = box();
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uLevel, level);
      gl.uniform1f(uCell, RUN_FEEL.flame.cellPx * dpr);
      gl.uniform1f(uBox, top);
      gl.uniform2f(uSpan, left, right);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    clear: () => {
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    dispose: () => {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}

/* The flame's target level for a score against its target, 0 below it
   (feel §3: log-scaled on the overshoot). */
export function flameLevel(score: number, target: number): number {
  if (!(target > 0) || score < target) return 0;
  const feel = RUN_FEEL.flame;
  return Math.min(feel.max, feel.base + feel.perLog5 * (Math.log(score / target) / Math.log(5)));
}

export function RunFlame({
  level,
  reducedMotion,
  boxTop,
  boxSpan = [0.08, 0.92],
  className = "",
}: {
  level: number;
  reducedMotion: boolean;
  /* Where the box's top edge sits, as a share of the canvas height from
     the bottom; the fire roots at it and rises above. */
  boxTop: number;
  /* The box's left and right edges as shares of the canvas width. */
  boxSpan?: readonly [number, number];
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  const boxRef = useRef({ top: boxTop, left: boxSpan[0], right: boxSpan[1] });
  boxRef.current = { top: boxTop, left: boxSpan[0], right: boxSpan[1] };
  const wakeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    wakeRef.current?.();
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let flame: FlameGl | null = null;
    let failed = false;
    let frame = 0;
    let running = false;
    let visible = true;
    let last = 0;
    let time = Math.random() * 20;
    const spring = { value: 0, velocity: 0 };
    const feel = RUN_FEEL.flame;

    const ensure = (): FlameGl | null => {
      if (flame || failed) return flame;
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return null;
      flame = createFlameGl(canvas, () => boxRef.current);
      if (!flame) failed = true;
      return flame;
    };

    const stop = () => {
      running = false;
      window.cancelAnimationFrame(frame);
    };

    const tick = (now: number) => {
      // A rAF stamp can sit before the performance.now() taken in wake().
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = Math.max(last, now);
      const target = Number.isFinite(levelRef.current) ? Math.max(0, levelRef.current) : 0;
      // Rises loose (so it flares past its level), falls damped.
      const damp = spring.velocity < 0 ? feel.dampDown : feel.dampUp;
      spring.velocity += (feel.stiffness * (target - spring.value) - damp * spring.velocity) * dt;
      spring.value = Math.max(0, spring.value + spring.velocity * dt);
      if (!Number.isFinite(spring.value) || !Number.isFinite(spring.velocity)) {
        spring.value = target;
        spring.velocity = 0;
      }
      // Wrapped so the noise coordinates stay small at any precision.
      time = (time + dt * (1 + feel.speedPerIntensity * spring.value)) % 240;
      if (!Number.isFinite(time)) time = 0;
      const gl = ensure();
      gl?.draw(time, spring.value);
      if (target === 0 && spring.value < 0.03 && Math.abs(spring.velocity) < 0.05) {
        spring.value = 0;
        spring.velocity = 0;
        gl?.clear();
        stop();
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };

    const wake = () => {
      if (reducedMotion) {
        // One still frame at the level, no spring and no scroll.
        spring.value = levelRef.current;
        const gl = ensure();
        if (spring.value > 0) gl?.draw(time, spring.value);
        else gl?.clear();
        return;
      }
      if (running || document.hidden || !visible) return;
      if (levelRef.current === 0 && spring.value === 0) return;
      running = true;
      last = performance.now();
      frame = window.requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const onVisibility = () => (document.hidden ? stop() : wake());
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) wake();
      else stop();
    });
    observer.observe(canvas);
    wake();
    return () => {
      stop();
      wakeRef.current = null;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      flame?.dispose();
    };
  }, [reducedMotion]);

  return <canvas ref={canvasRef} aria-hidden="true" className={`pointer-events-none absolute ${className}`} />;
}
