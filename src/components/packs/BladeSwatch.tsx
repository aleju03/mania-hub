import { useEffect, useRef } from "react";

import type { SupporterBladeId } from "#/lib/supporter-pack-style";
import { BladeFx, preloadSprites } from "./bladeFx";
import { bladeLook, bladeTrailLife, drawBladeTrail, type TrailPoint } from "./packBlades";

/* A blade in a small box, for the /supporter loadout and /support: the same
   streak, sparks and burst the pack stage draws (packBlades.ts, bladeFx.ts),
   scaled down. While `live` it slashes across, the pack gives, and it goes
   again; otherwise it holds one moment of the stroke. Only runs on screen. */

const SWEEP_MS = 340;
const LOOP_MS = 1700;

function pathAt(u: number, w: number, h: number) {
  return { x: w * (0.06 + 0.88 * u), y: h * (0.62 - 0.22 * u) - Math.sin(u * Math.PI) * h * 0.1 };
}

export function BladeSwatch({ blade, live = false, className = "" }: { blade: SupporterBladeId | null; live?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const look = bladeLook(blade);
    preloadSprites(look.sprites);
    const life = bladeTrailLife(look);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(h * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The stage draws for a whole viewport; a box this size gets everything smaller.
    const scale = Math.min(1, Math.max(0.3, h / 220));

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!live || reduced) {
      // One moment of the stroke: most of the sweep done, the tail fading.
      const now = 1000;
      const points: TrailPoint[] = [];
      for (let i = 0; i <= 16; i += 1) {
        const u = 0.12 + (0.7 * i) / 16;
        points.push({ ...pathAt(u, w, h), t: now - life * 0.9 * (1 - i / 16) });
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawBladeTrail(ctx, look, points, now, points[points.length - 1], scale);
      return;
    }

    const fx = new BladeFx();
    const box = { left: w * 0.3, top: h * 0.2, width: w * 0.4, height: h * 0.6 };
    let frame = 0;
    let visible = true;
    const points: TrailPoint[] = [];
    let start = performance.now();
    let travelled = 0;
    let sparked = 0;
    let ripped = false;
    let last: { x: number; y: number } | null = null;
    const step = (now: number) => {
      frame = 0;
      if (now - start > LOOP_MS) {
        start = now;
        points.length = 0;
        travelled = 0;
        sparked = 0;
        ripped = false;
        last = null;
      }
      const t = now - start;
      const sweeping = t <= SWEEP_MS;
      if (sweeping) {
        const u = 1 - (1 - t / SWEEP_MS) ** 3;
        const point = pathAt(u, w, h);
        points.push({ ...point, t: now });
        if (last) {
          const dx = point.x - last.x;
          const dy = point.y - last.y;
          travelled += Math.hypot(dx, dy) / scale;
          if (look.trail && look.trailEvery) {
            while (travelled >= look.trailEvery) {
              travelled -= look.trailEvery;
              look.trail(fx, point.x, point.y, dx, dy, scale);
            }
          }
        }
        last = point;
        if (u - sparked > 0.22) {
          sparked = u;
          look.cut(fx, point.x, point.y, scale);
        }
      } else if (!ripped) {
        ripped = true;
        look.rip?.(fx, box, box.top + box.height * 0.3, scale);
      }
      while (points.length && now - points[0].t > life) points.shift();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawBladeTrail(ctx, look, points, now, sweeping ? points[points.length - 1] ?? null : null, scale);
      fx.draw(ctx, w, h);
      if (visible) frame = requestAnimationFrame(step);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !frame) frame = requestAnimationFrame(step);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [blade, live]);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
