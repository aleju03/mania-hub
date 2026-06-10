import { motion, useMotionValue, useSpring } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import {
  createPackFrontCanvas,
  PACK_ART_HEIGHT,
  PACK_ART_WIDTH,
  PACK_ASPECT,
  PACK_TEAR_FRACTION,
} from "./packArt";

// The cut is tracked in vertical columns; each cut column remembers the y
// (as a fraction of pack height) where the blade crossed it, so the tear
// follows the cursor's actual path instead of a fixed line.
const BIN_COUNT = 48;
// Rendering samples the cut at a finer resolution than the recorded bins so
// the tear reads as a smooth curve instead of stair steps.
const SLICES_PER_BIN = 4;
const TEAR_COMPLETE_COVERAGE = 0.7;
// Vertical band (fractions of pack height) where a drag counts as a slash
// instead of a tilt. Kept tight around the perforation line (at 0.16) so the
// pack can only be cut where the dotted line says.
const TEAR_BAND_TOP = 0.08;
const TEAR_BAND_BOTTOM = 0.25;
// The recorded cut path is clamped to this range so the tear stays near the
// perforation even if the cursor wanders.
const CUT_MIN_Y = 0.09;
const CUT_MAX_Y = 0.24;
// How far the foil's freshly cut edge gapes away from the body, as a
// fraction of pack height. The foil is stiff: it eases to this and holds.
const MAX_LIFT_FRACTION = 0.028;
// Blade trail: how long a trail point lives and how many are kept. Short
// lifetimes make the streak chase the cursor instead of trailing a rope.
const TRAIL_LIFE_MS = 220;
const TRAIL_MAX_POINTS = 36;

interface SlashSpark {
  id: number;
  x: number;
  y: number;
  angle: number;
  distance: number;
  size: number;
}

interface PackStageProps {
  onOpened: () => void;
  reducedMotion: boolean;
}

function random01(value: number) {
  const x = Math.sin(value) * 43758.5453123;
  return x - Math.floor(x);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function PackStage({ onOpened, reducedMotion }: PackStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const packRef = useRef<HTMLDivElement | null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const artCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [packArt, setPackArt] = useState<string | null>(null);
  const [ripClips, setRipClips] = useState<{ strip: string; body: string } | null>(null);
  const [sparks, setSparks] = useState<SlashSpark[]>([]);

  const slashRef = useRef<{ pointerId: number; lastX: number; lastYFrac: number; lastSparkX: number } | null>(null);
  const rippingRef = useRef(false);
  const sparkIdRef = useRef(0);
  // Cut y per column as a height fraction; NaN = column not cut yet.
  const binsRef = useRef<Float32Array>(new Float32Array(BIN_COUNT).fill(Number.NaN));
  // Display-smoothed cut y per column.
  const smoothYRef = useRef<Float32Array>(new Float32Array(BIN_COUNT).fill(Number.NaN));
  const liftTargetRef = useRef<Float32Array>(new Float32Array(BIN_COUNT));
  const liftCurrentRef = useRef<Float32Array>(new Float32Array(BIN_COUNT));
  const settlingRef = useRef(false);
  const cutCountRef = useRef(0);
  const sizeRef = useRef<{ w: number; h: number; dpr: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const trailCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailPointsRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const trailHeldRef = useRef(false);
  const trailCursorRef = useRef<{ x: number; y: number } | null>(null);
  const trailRafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const rotateX = useSpring(useMotionValue(0), { stiffness: 200, damping: 22 });
  const rotateY = useSpring(useMotionValue(0), { stiffness: 200, damping: 22 });

  const recomputeCutFields = () => {
    const size = sizeRef.current;
    const bins = binsRef.current;
    const maxLift = (size ? size.h : 420) * MAX_LIFT_FRACTION;

    // Smoothed display curve: weighted average of nearby cut columns.
    const smooth = smoothYRef.current;
    const weights = [1, 2.2, 3, 2.2, 1];
    for (let i = 0; i < BIN_COUNT; i += 1) {
      if (!Number.isFinite(bins[i])) {
        smooth[i] = Number.NaN;
        continue;
      }
      let sum = 0;
      let total = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const j = i + offset;
        if (j < 0 || j >= BIN_COUNT || !Number.isFinite(bins[j])) continue;
        const weight = weights[offset + 2];
        sum += bins[j] * weight;
        total += weight;
      }
      smooth[i] = sum / total;
    }

    // Lift target: full gape inside the cut, tapering to zero at the uncut
    // frontier so the stiff foil bends instead of stepping.
    let mask = new Float32Array(BIN_COUNT);
    for (let i = 0; i < BIN_COUNT; i += 1) mask[i] = Number.isFinite(bins[i]) ? 1 : 0;
    for (let pass = 0; pass < 2; pass += 1) {
      const out = new Float32Array(BIN_COUNT);
      for (let i = 0; i < BIN_COUNT; i += 1) {
        let sum = 0;
        let count = 0;
        for (let j = i - 2; j <= i + 2; j += 1) {
          if (j < 0 || j >= BIN_COUNT) continue;
          sum += mask[j];
          count += 1;
        }
        out[i] = sum / count;
      }
      mask = out;
    }
    const targets = liftTargetRef.current;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      targets[i] = Number.isFinite(bins[i]) ? mask[i] * maxLift : 0;
    }
  };

  const drawFrame = () => {
    const canvas = liveCanvasRef.current;
    const art = artCanvasRef.current;
    const size = sizeRef.current;
    if (!canvas || !art || !size) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Ease the gape toward its target; the foil settles rigidly, no flutter.
    const targets = liftTargetRef.current;
    const lifts = liftCurrentRef.current;
    let maxDelta = 0;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      const delta = targets[i] - lifts[i];
      if (reducedMotionRef.current) lifts[i] = targets[i];
      else lifts[i] += delta * 0.16;
      maxDelta = Math.max(maxDelta, Math.abs(delta));
    }
    settlingRef.current = !reducedMotionRef.current && maxDelta > 0.15;

    if (cutCountRef.current === 0) {
      ctx.drawImage(art, 0, 0, w, h);
      return;
    }

    const bins = binsRef.current;
    const smooth = smoothYRef.current;
    const sliceCount = BIN_COUNT * SLICES_PER_BIN;
    const sliceW = w / sliceCount;

    // Sample the smoothed cut curve and gape per slice.
    const cut = new Array<boolean>(sliceCount).fill(false);
    const bodyY = new Float32Array(sliceCount);
    const edgeY = new Float32Array(sliceCount);
    for (let s = 0; s < sliceCount; s += 1) {
      const xc = (s + 0.5) * sliceW;
      const bin = Math.min(BIN_COUNT - 1, Math.floor((xc / w) * BIN_COUNT));
      if (!Number.isFinite(bins[bin])) continue;
      const b = (xc / w) * BIN_COUNT - 0.5;
      const i0 = clampNumber(Math.floor(b), 0, BIN_COUNT - 1);
      const i1 = Math.min(BIN_COUNT - 1, i0 + 1);
      const t = clampNumber(b - i0, 0, 1);
      const y0 = Number.isFinite(smooth[i0]) ? smooth[i0] : smooth[i1];
      const y1 = Number.isFinite(smooth[i1]) ? smooth[i1] : smooth[i0];
      const lift = lifts[i0] + (lifts[i1] - lifts[i0]) * t;
      cut[s] = true;
      bodyY[s] = (y0 + (y1 - y0) * t) * h;
      edgeY[s] = bodyY[s] - lift;
    }

    // Pass 1: pack body (and untouched columns).
    for (let s = 0; s < sliceCount; s += 1) {
      const x0 = s * sliceW;
      const dw = sliceW + 0.6;
      const sx = (x0 / w) * PACK_ART_WIDTH;
      const sw = (dw / w) * PACK_ART_WIDTH;
      if (!cut[s]) {
        ctx.drawImage(art, sx, 0, sw, PACK_ART_HEIGHT, x0, 0, dw, h);
      } else {
        const sy = (bodyY[s] / h) * PACK_ART_HEIGHT;
        ctx.drawImage(art, sx, sy, sw, PACK_ART_HEIGHT - sy, x0, bodyY[s], dw, h - bodyY[s]);
      }
    }

    // Pass 2: dark slit interior, filled as one smooth shape per cut run.
    ctx.fillStyle = "rgba(10, 7, 22, 0.92)";
    let runStart = -1;
    const fillRun = (from: number, to: number) => {
      ctx.beginPath();
      ctx.moveTo(from * sliceW, edgeY[from]);
      for (let s = from; s <= to; s += 1) ctx.lineTo((s + 0.5) * sliceW, edgeY[s]);
      ctx.lineTo((to + 1) * sliceW, edgeY[to]);
      ctx.lineTo((to + 1) * sliceW, bodyY[to] + 2);
      for (let s = to; s >= from; s -= 1) ctx.lineTo((s + 0.5) * sliceW, bodyY[s] + 2);
      ctx.lineTo(from * sliceW, bodyY[from] + 2);
      ctx.closePath();
      ctx.fill();
    };
    for (let s = 0; s < sliceCount; s += 1) {
      if (cut[s] && runStart === -1) runStart = s;
      if ((!cut[s] || s === sliceCount - 1) && runStart !== -1) {
        fillRun(runStart, cut[s] ? s : s - 1);
        runStart = -1;
      }
    }

    // Pass 3: foil above the cut. Top edge stays sealed at the crimp, the
    // cut edge gapes by the lift, so each column squashes slightly.
    for (let s = 0; s < sliceCount; s += 1) {
      if (!cut[s]) continue;
      const x0 = s * sliceW;
      const dw = sliceW + 0.6;
      const sx = (x0 / w) * PACK_ART_WIDTH;
      const sw = (dw / w) * PACK_ART_WIDTH;
      const sy = (bodyY[s] / h) * PACK_ART_HEIGHT;
      ctx.drawImage(art, sx, 0, sw, sy, x0, 0, dw, Math.max(2, edgeY[s]));
    }

    // Pass 4: glow plus a bright sliver along the freshly cut edge.
    const strokeRun = (from: number, to: number) => {
      ctx.beginPath();
      ctx.moveTo(from * sliceW, edgeY[from]);
      for (let s = from; s <= to; s += 1) ctx.lineTo((s + 0.5) * sliceW, edgeY[s]);
      ctx.lineTo((to + 1) * sliceW, edgeY[to]);
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    runStart = -1;
    for (let s = 0; s < sliceCount; s += 1) {
      if (cut[s] && runStart === -1) runStart = s;
      if ((!cut[s] || s === sliceCount - 1) && runStart !== -1) {
        const runEnd = cut[s] ? s : s - 1;
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.shadowColor = "rgba(167, 139, 250, 0.9)";
        ctx.shadowBlur = 9;
        strokeRun(runStart, runEnd);
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(240, 236, 255, 0.95)";
        strokeRun(runStart, runEnd);
        runStart = -1;
      }
    }
    ctx.restore();
  };

  const ensureLoop = () => {
    if (rafRef.current !== null || rippingRef.current) return;
    const step = () => {
      rafRef.current = null;
      drawFrame();
      const active = slashRef.current !== null || settlingRef.current;
      if (active && !rippingRef.current) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    const canvas = createPackFrontCanvas();
    artCanvasRef.current = canvas;
    setPackArt(canvas.toDataURL("image/png"));
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  // Blade trail: while the pointer is held down anywhere on the stage, a
  // fading streak chases the cursor (on and off the pack), so the slash
  // reads as a blade before it ever touches the foil.
  const ensureTrailLoop = () => {
    if (trailRafRef.current !== null) return;
    const step = () => {
      trailRafRef.current = null;
      const canvas = trailCanvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
        canvas.width = Math.round(vw * dpr);
        canvas.height = Math.round(vh * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);

      const now = performance.now();
      let points = trailPointsRef.current.filter((point) => now - point.t < TRAIL_LIFE_MS);
      if (points.length > TRAIL_MAX_POINTS) points = points.slice(-TRAIL_MAX_POINTS);
      trailPointsRef.current = points;

      if (points.length >= 2) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        // Glow pass under a bright core, both tapering toward the tail.
        for (let pass = 0; pass < 2; pass += 1) {
          for (let i = 1; i < points.length; i += 1) {
            const taper = i / (points.length - 1);
            const fade = Math.max(0, 1 - (now - points[i].t) / TRAIL_LIFE_MS);
            const alpha = taper * fade;
            if (alpha <= 0.01) continue;
            ctx.beginPath();
            ctx.moveTo(points[i - 1].x, points[i - 1].y);
            ctx.lineTo(points[i].x, points[i].y);
            if (pass === 0) {
              ctx.lineWidth = 3 + 11 * taper;
              ctx.strokeStyle = `rgba(167, 139, 250, ${(alpha * 0.45).toFixed(3)})`;
            } else {
              ctx.lineWidth = 1 + 6.5 * taper;
              ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.9).toFixed(3)})`;
            }
            ctx.stroke();
          }
        }
      }

      // Soft tip at the cursor while holding, so the blade exists even when
      // the hand pauses.
      if (trailHeldRef.current && trailCursorRef.current) {
        const tip = trailCursorRef.current;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(167, 139, 250, 0.4)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx.fill();
      }

      if (trailHeldRef.current || trailPointsRef.current.length > 0) {
        trailRafRef.current = requestAnimationFrame(step);
      }
    };
    trailRafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    if (reducedMotion) return;
    const onDown = (event: PointerEvent) => {
      if (rippingRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const stage = stageRef.current;
      if (!stage || !(event.target instanceof Node) || !stage.contains(event.target)) return;
      trailHeldRef.current = true;
      trailCursorRef.current = { x: event.clientX, y: event.clientY };
      trailPointsRef.current.push({ x: event.clientX, y: event.clientY, t: performance.now() });
      ensureTrailLoop();
    };
    const onMove = (event: PointerEvent) => {
      if (!trailHeldRef.current) return;
      trailCursorRef.current = { x: event.clientX, y: event.clientY };
      trailPointsRef.current.push({ x: event.clientX, y: event.clientY, t: performance.now() });
    };
    const onUp = () => {
      trailHeldRef.current = false;
      trailCursorRef.current = null;
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (trailRafRef.current !== null) cancelAnimationFrame(trailRafRef.current);
      trailRafRef.current = null;
      trailHeldRef.current = false;
      trailPointsRef.current = [];
    };
  }, [reducedMotion]);

  useEffect(() => {
    if (!packArt) return;
    const sync = () => {
      const root = packRef.current;
      const canvas = liveCanvasRef.current;
      if (!root || !canvas) return;
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      sizeRef.current = { w, h, dpr };
      recomputeCutFields();
      drawFrame();
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [packArt]);

  useEffect(() => {
    if (sparks.length === 0) return;
    const timer = window.setTimeout(() => setSparks([]), 700);
    return () => window.clearTimeout(timer);
  }, [sparks]);

  const fillUncutBins = () => {
    const bins = binsRef.current;
    let previous = Number.NaN;
    for (let i = 0; i < BIN_COUNT; i += 1) {
      if (Number.isFinite(bins[i])) previous = bins[i];
      else if (Number.isFinite(previous)) bins[i] = previous;
    }
    let next = Number.NaN;
    for (let i = BIN_COUNT - 1; i >= 0; i -= 1) {
      if (Number.isFinite(bins[i])) next = bins[i];
      else bins[i] = Number.isFinite(next) ? next : PACK_TEAR_FRACTION;
    }
  };

  const buildClipPaths = () => {
    const bins = binsRef.current;
    const points: string[] = [];
    for (let i = 0; i <= BIN_COUNT; i += 1) {
      const a = bins[Math.max(0, i - 1)];
      const b = bins[Math.min(BIN_COUNT - 1, i)];
      const xPct = (i / BIN_COUNT) * 100;
      const yPct = ((a + b) / 2) * 100 + (random01(i * 17.31 + 3.7) - 0.5) * 1.1;
      points.push(`${xPct.toFixed(2)}% ${yPct.toFixed(2)}%`);
    }
    return {
      strip: `polygon(0% 0%, 100% 0%, ${[...points].reverse().join(", ")})`,
      body: `polygon(${points.join(", ")}, 100% 100%, 0% 100%)`,
    };
  };

  const triggerRip = () => {
    if (rippingRef.current) return;
    rippingRef.current = true;
    slashRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    fillUncutBins();
    setRipClips(buildClipPaths());
    rotateX.set(0);
    rotateY.set(0);
    window.setTimeout(onOpened, reducedMotion ? 220 : 880);
  };

  const setCutSpan = (xa: number, yaFrac: number, xb: number, ybFrac: number) => {
    const size = sizeRef.current;
    if (!size) return;
    const binA = clampNumber(Math.floor((xa / size.w) * BIN_COUNT), 0, BIN_COUNT - 1);
    const binB = clampNumber(Math.floor((xb / size.w) * BIN_COUNT), 0, BIN_COUNT - 1);
    const low = Math.min(binA, binB);
    const high = Math.max(binA, binB);
    const bins = binsRef.current;
    let changed = false;
    for (let i = low; i <= high; i += 1) {
      // A column already cut keeps its original y; foil only tears once.
      if (Number.isFinite(bins[i])) continue;
      const t = binA === binB ? 0 : (i - binA) / (binB - binA);
      bins[i] = yaFrac + (ybFrac - yaFrac) * t;
      cutCountRef.current += 1;
      changed = true;
    }
    if (changed) recomputeCutFields();
  };

  const spawnSparks = (x: number, y: number) => {
    if (reducedMotion) return;
    setSparks((current) => {
      const next = current.slice(-26);
      for (let index = 0; index < 3; index += 1) {
        sparkIdRef.current += 1;
        next.push({
          id: sparkIdRef.current,
          x,
          y,
          angle: -Math.PI / 2 + (Math.random() - 0.5) * 1.8,
          distance: 26 + Math.random() * 54,
          size: 3 + Math.random() * 5,
        });
      }
      return next;
    });
  };

  const onPointerMoveTilt = (event: React.PointerEvent<HTMLDivElement>) => {
    if (slashRef.current || rippingRef.current) return;
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nx = (event.clientX - rect.left) / rect.width - 0.5;
    const ny = (event.clientY - rect.top) / rect.height - 0.5;
    rotateY.set(nx * 16);
    rotateX.set(ny * -12);
  };

  const onPointerLeaveTilt = () => {
    if (slashRef.current || rippingRef.current) return;
    rotateY.set(0);
    rotateX.set(0);
  };

  const beginSlash = (event: React.PointerEvent<HTMLDivElement>, rect: DOMRect, ny: number) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = clampNumber(event.clientX - rect.left, 0, rect.width);
    const yFrac = clampNumber(ny, CUT_MIN_Y, CUT_MAX_Y);
    slashRef.current = { pointerId: event.pointerId, lastX: x, lastYFrac: yFrac, lastSparkX: x };
    setCutSpan(x, yFrac, x, yFrac);
    ensureLoop();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (rippingRef.current) return;
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ny = (event.clientY - rect.top) / rect.height;
    if (ny < TEAR_BAND_TOP || ny > TEAR_BAND_BOTTOM) return;
    beginSlash(event, rect, ny);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const slash = slashRef.current;
    if (!slash || slash.pointerId !== event.pointerId) {
      // A held blade entering the band starts cutting even when the hold
      // began off the pack: a fruit-ninja swipe straight through.
      if (!rippingRef.current && !slashRef.current && (event.buttons & 1) === 1) {
        const rect = packRef.current?.getBoundingClientRect();
        if (rect) {
          const ny = (event.clientY - rect.top) / rect.height;
          if (ny >= TEAR_BAND_TOP && ny <= TEAR_BAND_BOTTOM) {
            beginSlash(event, rect, ny);
            return;
          }
        }
      }
      onPointerMoveTilt(event);
      return;
    }
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clampNumber(event.clientX - rect.left, 0, rect.width);
    const yFrac = clampNumber((event.clientY - rect.top) / rect.height, CUT_MIN_Y, CUT_MAX_Y);
    setCutSpan(slash.lastX, slash.lastYFrac, x, yFrac);
    slash.lastX = x;
    slash.lastYFrac = yFrac;
    if (Math.abs(x - slash.lastSparkX) > 18) {
      slash.lastSparkX = x;
      spawnSparks(x, yFrac * rect.height);
    }
    if (cutCountRef.current / BIN_COUNT >= TEAR_COMPLETE_COVERAGE) triggerRip();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (slashRef.current?.pointerId !== event.pointerId) return;
    slashRef.current = null;
    ensureLoop();
  };

  const ripping = ripClips !== null;

  const stripExit = reducedMotion
    ? { opacity: 0 }
    : { y: -170, x: 90, rotate: -14, opacity: 0 };
  const bodyExit = reducedMotion
    ? { opacity: 0 }
    : { y: 46, scale: 0.9, opacity: 0 };

  return (
    <div ref={stageRef} className="flex flex-col items-center">
      {/* Blade trail overlay, viewport-sized so the streak runs off the pack */}
      {!reducedMotion && (
        <canvas
          ref={trailCanvasRef}
          className="pointer-events-none fixed inset-0 z-30 h-full w-full"
          aria-hidden="true"
        />
      )}
      <div style={{ perspective: 1100 }}>
        <motion.div
          ref={packRef}
          className="relative select-none"
          style={{
            width: "min(310px, 76vw)",
            aspectRatio: `${PACK_ASPECT}`,
            rotateX,
            rotateY,
            transformStyle: "preserve-3d",
            touchAction: "none",
          }}
          animate={reducedMotion || ripping ? undefined : { y: [0, -7, 0] }}
          transition={reducedMotion || ripping ? undefined : { duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeaveTilt}
        >
          {packArt ? (
            <>
              {/* Live pack: canvas redraws the foil with the cut path and gape */}
              <canvas
                ref={liveCanvasRef}
                className="absolute inset-0 h-full w-full"
                style={{
                  filter: "drop-shadow(0 18px 40px rgba(0,0,0,0.55))",
                  visibility: ripping ? "hidden" : "visible",
                }}
              />
              {ripping && ripClips && (
                <>
                  {/* Torn-off top strip, clipped along the user's cut */}
                  <motion.div
                    className="absolute inset-0 z-10"
                    style={{
                      backgroundImage: `url(${packArt})`,
                      backgroundSize: "100% 100%",
                      clipPath: ripClips.strip,
                      filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.45))",
                    }}
                    initial={{ y: 0, x: 0, rotate: 0, opacity: 1 }}
                    animate={stripExit}
                    transition={{ duration: reducedMotion ? 0.18 : 0.62, ease: [0.2, 0.7, 0.3, 1] }}
                  />
                  {/* Pack body */}
                  <motion.div
                    className="absolute inset-0"
                    style={{
                      backgroundImage: `url(${packArt})`,
                      backgroundSize: "100% 100%",
                      clipPath: ripClips.body,
                      filter: "drop-shadow(0 18px 40px rgba(0,0,0,0.55))",
                    }}
                    initial={{ y: 0, scale: 1, opacity: 1 }}
                    animate={bodyExit}
                    transition={{ duration: reducedMotion ? 0.18 : 0.5, delay: reducedMotion ? 0 : 0.22, ease: "easeIn" }}
                  />
                </>
              )}
              {/* Slash sparks */}
              {sparks.map((spark) => (
                <motion.div
                  key={spark.id}
                  className="absolute z-30 rounded-full pointer-events-none"
                  style={{
                    left: spark.x,
                    top: spark.y,
                    width: spark.size,
                    height: spark.size,
                    background: "rgb(221, 214, 254)",
                    boxShadow: "0 0 8px rgba(196,181,253,0.9)",
                  }}
                  initial={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                  animate={{
                    opacity: 0,
                    x: Math.cos(spark.angle) * spark.distance,
                    y: Math.sin(spark.angle) * spark.distance,
                    scale: 0.4,
                  }}
                  transition={{ duration: 0.55, ease: "easeOut" }}
                />
              ))}
            </>
          ) : (
            <div className="absolute inset-0 rounded-xl bg-osu-b4/50 animate-pulse" />
          )}
        </motion.div>
      </div>

      <div className="mt-7 text-center" aria-live="polite">
        <div className="text-sm font-semibold text-white">
          {ripping ? "Opening..." : "Slash across the dotted line to open"}
        </div>
        <div className="mt-1 text-[12px] text-osu-f1">
          {ripping ? " " : "Hold and drag from one edge to the other"}
        </div>
      </div>
    </div>
  );
}
