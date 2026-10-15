import { useEffect, useRef } from "react";

import { cardOverlayFragmentShader } from "../player/maniacard3d/cardShaders";
import { supporterFoilIndex, type SupporterFoilId } from "../../lib/supporter-foils";

/* A live swatch of a supporter foil: the card's own overlay shader on a blank
   card, without the tier's sparkle, its light circling, or following the pointer while it is over the
   swatch. Every swatch on the page shares one offscreen WebGL context, drawn
   in turn and copied into each swatch's 2D canvas, so a drawer of them costs
   one context rather than one each (browsers cap those near 16, and the 3D
   card and name tags need theirs). They redraw at 30fps and only while on
   screen; a `still` swatch draws once. */

const VERTEX = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

interface Swatch {
  canvas: HTMLCanvasElement;
  target: CanvasRenderingContext2D | null;
  visible: boolean;
  style: number;
  phase: number;
  pointer: [number, number] | null;
}

interface Shared {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

const swatches = new Set<Swatch>();
let shared: Shared | null | undefined;
let frame = 0;
let lastDraw = 0;
const FRAME_MS = 1000 / 30;
const start = typeof performance === "undefined" ? 0 : performance.now();

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/* Null once it has failed, so a browser without WebGL leaves the swatches as their flat backing. */
function setUp(): Shared | null {
  if (shared !== undefined) return shared;
  shared = null;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, alpha: true, antialias: false });
  if (!gl) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, `#define MC_MEDIUM 1\n${cardOverlayFragmentShader}`);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  // The sampler must point at something; the motif branch never reads it here.
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

  const names = [
    "uTime", "uIntensity", "uFoil", "uSupporter", "uFoilStyle", "uTierLayer", "uStarfield", "uLight", "uTierColor", "uStarTint", "uRainbow",
    "uMotif", "uMotifOn", "uMotifSize", "uMotifOpacity", "uAvatarMask", "uTextureSize", "uAvatarRadius", "uFlagMask", "uFlagRadius",
  ];
  const uniforms = Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
  gl.uniform1f(uniforms.uIntensity, 0.88);
  // A common card's overlay with the sparkle left out, so all that shows is the foil.
  gl.uniform1f(uniforms.uFoil, 0);
  gl.uniform1f(uniforms.uTierLayer, 0);
  gl.uniform1f(uniforms.uSupporter, 1);
  gl.uniform1f(uniforms.uStarfield, 0);
  gl.uniform3f(uniforms.uTierColor, 0.62, 0.64, 0.74);
  gl.uniform3f(uniforms.uStarTint, 0.78, 1.0, 0.9);
  gl.uniform1f(uniforms.uRainbow, 1);
  gl.uniform1i(uniforms.uMotif, 0);
  gl.uniform1f(uniforms.uMotifOn, 0);
  gl.uniform2f(uniforms.uMotifSize, 0.34, 0.34);
  gl.uniform1f(uniforms.uMotifOpacity, 1);
  gl.uniform4f(uniforms.uAvatarMask, -1, -1, 0, 0);
  gl.uniform4f(uniforms.uFlagMask, -1, -1, 0, 0);
  gl.uniform2f(uniforms.uTextureSize, 1000, 1400);
  gl.uniform1f(uniforms.uAvatarRadius, 0);
  gl.uniform1f(uniforms.uFlagRadius, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ZERO);

  shared = { gl, canvas, uniforms };
  return shared;
}

function draw(now: number, only?: Swatch) {
  const context = setUp();
  if (!context) return;
  const { gl, canvas, uniforms } = context;
  const time = (now - start) / 1000;
  gl.uniform1f(uniforms.uTime, time);
  for (const swatch of only ? [only] : swatches) {
    if (!only && !swatch.visible) continue;
    const { width, height } = swatch.canvas;
    if (!width || !height) continue;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    const [x, y] = swatch.pointer ?? [0.5 + Math.cos(time * 0.7 + swatch.phase) * 0.3, 0.45 + Math.sin(time * 0.9 + swatch.phase) * 0.3];
    gl.uniform2f(uniforms.uLight, x, y);
    gl.uniform1f(uniforms.uFoilStyle, swatch.style);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    swatch.target ??= swatch.canvas.getContext("2d");
    if (!swatch.target) continue;
    swatch.target.clearRect(0, 0, width, height);
    swatch.target.drawImage(canvas, 0, 0);
  }
}

function loop(now: number) {
  if (now - lastDraw >= FRAME_MS) {
    lastDraw = now;
    draw(now);
  }
  frame = swatches.size > 0 ? requestAnimationFrame(loop) : 0;
}

export function FoilPreview({ foil, className, still = false }: { foil: SupporterFoilId; className?: string; still?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const swatchRef = useRef<Swatch | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const swatch: Swatch = { canvas, target: null, visible: true, style: supporterFoilIndex(foil), phase: supporterFoilIndex(foil) * 1.7, pointer: null };
    if (still || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(start + 4000, swatch);
      return;
    }
    swatchRef.current = swatch;
    swatches.add(swatch);
    const observer = new IntersectionObserver(([entry]) => {
      swatch.visible = entry.isIntersecting;
    });
    observer.observe(canvas);
    if (!frame) frame = requestAnimationFrame(loop);
    return () => {
      observer.disconnect();
      swatches.delete(swatch);
      swatchRef.current = null;
    };
  }, [foil, still]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (swatchRef.current) swatchRef.current.pointer = [(event.clientX - box.left) / box.width, 1 - (event.clientY - box.top) / box.height];
      }}
      onPointerLeave={() => {
        if (swatchRef.current) swatchRef.current.pointer = null;
      }}
    />
  );
}
