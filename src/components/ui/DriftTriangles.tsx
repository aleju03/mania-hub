import { useEffect, useRef } from "react";

// Canvas port of lazer's Triangles drawable (osu.Game/Graphics/Backgrounds/
// Triangles.cs): a dense field of equilateral triangles, sizes normally
// distributed around a 100px base, each an opaque shade between a dark and a
// light colour, drifting up at a speed proportional to size and respawning
// below the bottom edge. `active` (the skin upload's drag hover) swaps in a
// pinker palette and speeds the drift up. Drawn for a bg-osu-b4 surface.
// Static under reduced motion, and paused while scrolled out of view.
const TRI_BASE_SIZE = 100;
const TRI_BASE_VELOCITY = 50;
const TRI_EQUILATERAL = 0.866;
// Global scale: bigger triangles, correspondingly fewer (lazer's TriangleScale).
const TRI_SCALE = 1.6;
// Thin the field out versus lazer's default density (its SpawnRatio).
const TRI_SPAWN_RATIO = 0.4;
const TRI_MAX_COUNT = 320;

interface DriftTriangle {
  x: number; // relative 0..1
  y: number; // relative 0..1, the top vertex
  scale: number;
  shade: number; // 0..1 between the dark and light palette colours
}

function randomNormal(): number {
  const u1 = 1 - Math.random();
  const u2 = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
}

/* `calm` is for a field that sits behind controls on a page rather than an
   empty drop zone: a slower drift and shades closer to the surface, so text
   and buttons over it stay easy to read. */
export function DriftTriangles({ active = false, calm = false }: { active?: boolean; calm?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The osu colour tokens are @theme inline (no runtime CSS vars), so the
    // palettes are rebuilt from the theme hue/sat the way styles.css does.
    // Resting: shades just above the b4 surface. Dragging: unmistakably pink.
    const rootStyles = getComputedStyle(document.documentElement);
    const parsedHue = parseFloat(rootStyles.getPropertyValue("--theme-hue"));
    const parsedSat = parseFloat(rootStyles.getPropertyValue("--theme-sat"));
    const hue = Number.isFinite(parsedHue) ? parsedHue : 333;
    const sat = Number.isFinite(parsedSat) ? parsedSat : 1;
    const shadeAt = (shade: number, dark: [number, number], light: [number, number]) =>
      `hsl(${hue}, ${(dark[0] + (light[0] - dark[0]) * shade) * sat}%, ${dark[1] + (light[1] - dark[1]) * shade}%)`;
    const restingColour = (shade: number) => (calm
      ? shadeAt(shade, [10, 17], [11.5, 19.5])
      : shadeAt(shade, [10, 17], [13, 23.5]));
    const draggingColour = (shade: number) => shadeAt(shade, [30, 20], [48, 34]);

    let width = 0;
    let height = 0;
    let triangles: DriftTriangle[] = [];
    let colours: { resting: string; dragging: string }[] = [];
    let frame = 0;
    let last = performance.now();

    const createTriangle = (randomY: boolean): DriftTriangle => {
      const scale = Math.max(TRI_SCALE * (0.5 + 0.16 * randomNormal()), 0.1);
      // Spawns may sit slightly above the top so the field has no bare edge.
      const maxOffset = (TRI_BASE_SIZE * scale * TRI_EQUILATERAL) / height;
      return {
        x: Math.random(),
        y: randomY ? -maxOffset + Math.random() * (1 + maxOffset) : 1,
        scale,
        shade: Math.random(),
      };
    };

    /* Keeps the field across a resize. Regenerating it scattered every
       triangle to a new spot each time the host changed height, which on a
       card whose form grows and shrinks is a visible jump. Existing triangles
       hold their pixel position; only the count is topped up or trimmed. */
    const fit = (previousWidth: number, previousHeight: number) => {
      const aimCount = Math.min(TRI_MAX_COUNT, Math.ceil(((width * height) * 0.002 * TRI_SPAWN_RATIO) / (TRI_SCALE * TRI_SCALE)));
      if (previousWidth > 0 && previousHeight > 0) {
        for (const triangle of triangles) {
          triangle.x = (triangle.x * previousWidth) / width;
          triangle.y = (triangle.y * previousHeight) / height;
        }
      }
      if (triangles.length > aimCount) {
        // Drop the ones the shrink left out of view first.
        const inView = (triangle: DriftTriangle) => triangle.x <= 1 && triangle.y <= 1;
        triangles = [...triangles.filter(inView), ...triangles.filter((triangle) => !inView(triangle))].slice(0, aimCount);
      }
      while (triangles.length < aimCount) triangles.push(createTriangle(true));
      // Large triangles behind, small in front, lazer's draw order.
      triangles.sort((a, b) => b.scale - a.scale);
      colours = triangles.map((triangle) => ({
        resting: restingColour(triangle.shade),
        dragging: draggingColour(triangle.shade),
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const dragging = activeRef.current;
      for (let index = 0; index < triangles.length; index += 1) {
        const triangle = triangles[index];
        const size = TRI_BASE_SIZE * triangle.scale;
        const px = triangle.x * width;
        const py = triangle.y * height;
        ctx.fillStyle = dragging ? colours[index].dragging : colours[index].resting;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - size / 2, py + size * TRI_EQUILATERAL);
        ctx.lineTo(px + size / 2, py + size * TRI_EQUILATERAL);
        ctx.closePath();
        ctx.fill();
      }
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const previousWidth = width;
      const previousHeight = height;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fit(previousWidth, previousHeight);
      draw();
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const velocity = activeRef.current ? 1.8 : calm ? 0.2 : 0.6;
      const movedDistance = (dt * velocity * TRI_BASE_VELOCITY) / (height * TRI_SCALE);
      for (const triangle of triangles) {
        // Speed scales with size: smaller triangles drift more slowly.
        triangle.y -= Math.max(0.5, triangle.scale) * movedDistance;
        const bottomY = triangle.y + (TRI_BASE_SIZE * triangle.scale * TRI_EQUILATERAL) / height;
        if (bottomY < 0) {
          triangle.y = 1;
          triangle.x = Math.random();
        }
      }
      draw();
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (reduceMotion || frame) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    resize();
    start();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const visibility = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) start();
      else stop();
    });
    visibility.observe(host);
    return () => {
      stop();
      observer.disconnect();
      visibility.disconnect();
    };
  }, [calm]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />;
}
