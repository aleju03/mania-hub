import { useEffect, useRef, useState } from "react";
import { wysiTime } from "./Wysi";

/* The chain run's table: thick paint twisted around the centre and folded
   over itself, drawn in big pixels (one canvas pixel each) with three flat colour bands by one WebGL
   fragment shader. It fills the whole table, turns all the time, takes its
   colours from the stage (round, pack, shop, over; eased over about a
   second) and twists, flows faster and brightens with the room's heat. A 727
   eases it to a standstill; reduced motion draws one still frame. */

export type BackdropStage = "round" | "pack" | "shop" | "over";

type Rgb = [number, number, number];
const hex = (value: string): Rgb => [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255];

/* A: the bright paint, B: the second colour, C: the ground. */
const PALETTES: Record<BackdropStage, [Rgb, Rgb, Rgb]> = {
  round: [hex("#ff5fa8"), hex("#6f45d0"), hex("#160c24")],
  pack: [hex("#ffbf5a"), hex("#c24f8c"), hex("#1c0e18")],
  shop: [hex("#3fd0c8"), hex("#3a58d4"), hex("#0a1626")],
  over: [hex("#e04848"), hex("#6a1830"), hex("#120608")],
};

const VERTEX = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAGMENT = `precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uHeat;
uniform float uLight;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
float vignette(vec2 frag) {
  vec2 q = frag / uRes - 0.5;
  return 1.0 - 0.9 * dot(q, q);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (frag - 0.5 * uRes) / max(uRes.x, uRes.y);
  float len = length(uv);
  float ang = atan(uv.y, uv.x) + uTime * 0.06 - len * (3.0 + uHeat * 4.0);
  uv = len * vec2(cos(ang), sin(ang)) * 14.0;
  float s = uTime * 0.3;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    uv += 0.9 * vec2(sin(uv.y * 0.9 + s + fi * 1.3), cos(uv.x * 0.8 - s * 0.8 + fi * 0.7));
    uv = mat2(0.8, -0.6, 0.6, 0.8) * uv;
  }
  float v = 0.5 + 0.5 * sin(length(uv) * 1.6 + uv.x * 0.35 - s);
  float a = smoothstep(0.62, 0.66, v);
  float b = smoothstep(0.30, 0.34, v) * (1.0 - a);
  vec3 col = mix(uC, mix(uC, uB, 0.8), b);
  col = mix(col, mix(uB, uA, 0.75), a);
  // Background, not foreground: a third less colour, the bands pulled
  // toward the ground, and the middle (where the cards and numbers sit)
  // darker than the edges.
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.7);
  col = mix(uC, col, 0.7);
  float calm = 0.62 + 0.38 * smoothstep(0.08, 0.62, len);
  gl_FragColor = vec4(col * uLight * calm * vignette(frag), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("backdrop shader", gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

/* Canvas rows: each one is a paint pixel (CSS scales the canvas up without
   smoothing), so the shader runs once per visible block and no more. */
const ROWS_PER_CSS_PX = 1 / 2.6;

export function PaintBackdrop({ stage, heat, dim = false, reducedMotion }: { stage: BackdropStage; heat: number; dim?: boolean; reducedMotion: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const live = useRef({ heat, dim, stage });
  live.current = { heat: dim ? 0 : heat, dim, stage };
  /* False while the browser has taken the context away (phones keep only a
     few alive per page): the canvas hides and the flat ground shows. */
  const [drawing, setDrawing] = useState(true);
  const ground = PALETTES[stage][2];

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    /* A fresh canvas per mount: the cleanup hands its context back, and a
       canvas whose context was handed back stays dead (React mounts twice in
       development, and the second mount would get the dead one). */
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 h-full w-full";
    canvas.style.imageRendering = "pixelated";
    canvas.style.visibility = "var(--paint-visibility)";
    box.appendChild(canvas);
    const palette = PALETTES[live.current.stage].map((rgb) => [...rgb]) as Rgb[];
    let shownHeat = live.current.heat;
    let light = live.current.dim ? 0.45 : 0.7;
    let time = 20;
    let last = performance.now();
    let frame = 0;
    let draw: ((dt: number) => void) | null = null;

    const resize = () => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ROWS_PER_CSS_PX));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ROWS_PER_CSS_PX));
    };
    resize();

    /* Builds the program on the canvas's context; null when there is none. */
    const setup = (): ((dt: number) => void) | null => {
      const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, powerPreference: "low-power" });
      if (!gl || gl.isContextLost()) return null;
      const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      if (!vs || !fs) return null;
      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const u = (name: string) => gl.getUniformLocation(program, name);
      const uRes = u("uRes");
      const uTime = u("uTime");
      const uHeat = u("uHeat");
      const uLight = u("uLight");
      const uA = u("uA");
      const uB = u("uB");
      const uC = u("uC");
      return (dt: number) => {
        const target = PALETTES[live.current.stage];
        const ease = Math.min(1, dt * 2.2);
        for (let c = 0; c < 3; c += 1) for (let i = 0; i < 3; i += 1) palette[c][i] += (target[c][i] - palette[c][i]) * ease;
        shownHeat += (live.current.heat - shownHeat) * Math.min(1, dt * 1.6);
        light += ((live.current.dim ? 0.45 : 0.7 + shownHeat * 0.2) - light) * Math.min(1, dt * 1.6);
        // A 727 stops time: wysiTime.scale eases the flow to a standstill.
        time += dt * (1 + shownHeat * 1.8) * wysiTime.scale;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, time);
        gl.uniform1f(uHeat, shownHeat);
        gl.uniform1f(uLight, light);
        gl.uniform3fv(uA, palette[0]);
        gl.uniform3fv(uB, palette[1]);
        gl.uniform3fv(uC, palette[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
    };

    let drawn = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      drawn += dt;
      // Big pixels and a slow flow: about 30 frames a second is plenty.
      if (draw && drawn >= 1 / 32) {
        draw(drawn);
        drawn = 0;
      }
      frame = window.requestAnimationFrame(tick);
    };
    const start = () => {
      window.cancelAnimationFrame(frame);
      if (!draw) return;
      if (reducedMotion) {
        draw(0);
        return;
      }
      if (document.hidden) return;
      last = performance.now();
      frame = window.requestAnimationFrame(tick);
    };

    const onLost = (event: Event) => {
      // Asking for it back: without this the browser never restores it.
      event.preventDefault();
      window.cancelAnimationFrame(frame);
      draw = null;
      setDrawing(false);
    };
    const onRestored = () => {
      draw = setup();
      setDrawing(Boolean(draw));
      start();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    const observer = new ResizeObserver(() => {
      resize();
      if (reducedMotion) draw?.(0);
    });
    observer.observe(canvas);
    document.addEventListener("visibilitychange", start);

    draw = setup();
    setDrawing(Boolean(draw));
    start();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", start);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      // Hands the context back now rather than when the page is collected.
      (canvas.getContext("webgl") as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    };
  }, [reducedMotion]);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ backgroundColor: `rgb(${ground.map((v) => Math.round(v * 255)).join(" ")})`, ["--paint-visibility" as string]: drawing ? "visible" : "hidden" }}
    />
  );
}
