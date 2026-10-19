import { useEffect, useRef } from "react";
import { wysiTime } from "./Wysi";

/* The chain run's table: osu!'s own drifting triangles, as on the main menu
   (the maniacards draw them too), in the site's dark purple. One hue family
   for the whole run; heat (0..1) only makes them brighter, faster and more
   of them. A plain 2D canvas at a capped resolution and frame rate; reduced
   motion draws one still frame. */

interface Tri {
  x: number;
  y: number;
  size: number;
  shade: number;
  speed: number;
  /* Below this heat the triangle stays hidden, so heat adds triangles. */
  minHeat: number;
}

const COUNT = 90;
const BASE = { h: 266, s: 26 };

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTris(): Tri[] {
  const rand = seeded(7);
  return Array.from({ length: COUNT }, (_, index) => ({
    x: rand(),
    y: rand(),
    size: 0.03 + rand() ** 2 * 0.13,
    shade: rand(),
    speed: 0.6 + rand() * 0.8,
    minHeat: index < COUNT * 0.55 ? 0 : (index - COUNT * 0.55) / (COUNT * 0.45),
  }));
}

export function TriangleBackdrop({ heat, dim = false, reducedMotion }: { heat: number; dim?: boolean; reducedMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heatRef = useRef(heat);
  heatRef.current = dim ? 0 : heat;
  const dimRef = useRef(dim);
  dimRef.current = dim;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const tris = makeTris();
    let frame = 0;
    let last = performance.now();
    let drawn = 0;
    let shown = heatRef.current;
    let light = dimRef.current ? 0.6 : 1;

    const resize = () => {
      const dpr = Math.min(1.25, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr * 0.75));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr * 0.75));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (dt: number) => {
      // Heat and dimming ease toward their targets.
      shown += (heatRef.current - shown) * Math.min(1, dt * 1.6);
      light += ((dimRef.current ? 0.6 : 1) - light) * Math.min(1, dt * 1.6);
      const { width, height } = canvas;
      const unit = Math.max(width, height);
      context.fillStyle = `hsl(${BASE.h}, ${BASE.s}%, ${7 * light}%)`;
      context.fillRect(0, 0, width, height);
      for (const tri of tris) {
        // A 727 stops time: wysiTime.scale eases them to a standstill.
        tri.y -= (tri.speed * (0.012 + shown * 0.05) * dt * wysiTime.scale * unit) / height;
        if (tri.y < -tri.size * 1.2) {
          tri.y = 1 + tri.size;
          tri.x = (tri.x + 0.37) % 1;
        }
        const visible = Math.max(0, Math.min(1, (shown - tri.minHeat) * 4 + (tri.minHeat === 0 ? 1 : 0)));
        if (visible <= 0) continue;
        const size = tri.size * unit;
        const cx = tri.x * width;
        const cy = tri.y * height;
        const lightness = (7.5 + tri.shade * 7 + shown * 11) * light;
        context.fillStyle = `hsla(${BASE.h + tri.shade * 14}, ${BASE.s + shown * 14}%, ${lightness}%, ${(0.45 + shown * 0.4) * visible})`;
        context.beginPath();
        context.moveTo(cx, cy - size * 0.58);
        context.lineTo(cx + size * 0.5, cy + size * 0.29);
        context.lineTo(cx - size * 0.5, cy + size * 0.29);
        context.closePath();
        context.fill();
      }
    };

    if (reducedMotion) {
      draw(0);
      return () => observer.disconnect();
    }
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      drawn += dt;
      // About 30 frames a second is plenty for a slow drift.
      if (drawn >= 1 / 32) {
        draw(drawn);
        drawn = 0;
      }
      frame = window.requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      window.cancelAnimationFrame(frame);
      if (!document.hidden) {
        last = performance.now();
        frame = window.requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    draw(0);
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reducedMotion]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}
