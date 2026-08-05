import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { PackTypeDef } from "#/lib/packs";
import { useWindowActive } from "#/lib/window-activity";
import {
  createPackBackCanvas,
  DEFAULT_PACK_ART_STYLE,
  getCachedPackFrontCanvas,
  packArtStyleFor,
  paintPackBackCanvas,
  PACK_ART_HEIGHT,
  PACK_ART_WIDTH,
  PACK_ASPECT,
  PACK_RIP_STRIP_FRACTION,
  PACK_TEAR_FRACTION,
} from "./packArt";
import { createPackScene, type PackScene } from "./packScene";
import { playPackRip, playSlashTick } from "./packSfx";

// The cut is tracked in vertical columns; each cut column remembers the y
// (as a fraction of pack height) where the blade crossed it, so the tear
// follows the cursor's actual path instead of a fixed line.
const BIN_COUNT = 48;
// Rendering samples the cut at a finer resolution than the recorded bins so
// the tear reads as a smooth curve instead of stair steps.
const SLICES_PER_BIN = 2;
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
// Kept small: the opening reads through the real hole in the front shell,
// not through a huge flap.
const MAX_LIFT_FRACTION = 0.02;
// Blade trail: how long a trail point lives and how many are kept. Short
// lifetimes make the streak chase the cursor instead of trailing a rope.
const TRAIL_LIFE_MS = 220;
const TRAIL_MAX_POINTS = 36;
// A fixed full-viewport canvas at native mobile/retina DPR can exceed 30m
// pixels. The blade is a soft, short-lived effect, so keep its backing store
// within a small GPU budget and let CSS upscale it when necessary.
const TRAIL_PIXEL_BUDGET = 2_500_000;
const TRAIL_MAX_SCALE = 1.5;
const TRAIL_MIN_SCALE = 0.5;

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
  /* Tints the foil art and subtitle; omitted = the standard pack look. */
  packType?: PackTypeDef;
}

function random01(value: number) {
  const x = Math.sin(value) * 43758.5453123;
  return x - Math.floor(x);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function PackStage({ onOpened, reducedMotion, packType }: PackStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const packRef = useRef<HTMLDivElement | null>(null);
  // Offscreen 2D canvas the cut renders into; the 3D scene shows it as the
  // front texture of the pack mesh.
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const artCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const backCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ripStripCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<PackScene | null>(null);
  const [artReady, setArtReady] = useState(false);
  // Flips when the async scene creation lands, so effects that push state
  // into the scene (window activity, reduced motion) re-sync to it.
  const [sceneReady, setSceneReady] = useState(false);
  const [ripping, setRipping] = useState(false);
  const [sparks, setSparks] = useState<SlashSpark[]>([]);

  const slashRef = useRef<{ lastX: number; lastYFrac: number; lastSparkX: number } | null>(null);
  const bladeHeldRef = useRef<{ pointerId: number } | null>(null);
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
  const rafRef = useRef<number | null>(null);
  const trailCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailPointsRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const trailHeldRef = useRef(false);
  const trailCursorRef = useRef<{ x: number; y: number } | null>(null);
  const trailRafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const windowActive = useWindowActive();
  const windowActiveRef = useRef(windowActive);
  const stageVisibleRef = useRef(true);
  windowActiveRef.current = windowActive;

  const recomputeCutFields = () => {
    const bins = binsRef.current;
    const maxLift = PACK_ART_HEIGHT * MAX_LIFT_FRACTION;

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
    if (!canvas || !art) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = PACK_ART_WIDTH;
    const h = PACK_ART_HEIGHT;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
      sceneRef.current?.markArtDirty();
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

    // The gap between the lifted foil edge and the body stays TRANSPARENT:
    // the front shell gets a real hole (the material alpha-tests it away)
    // and the pack's dark inside shows through with true parallax, instead
    // of a painted-on dark band.

    // Pass 2: foil above the cut. Top edge stays sealed at the crimp, the
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

    // Pass 3: a thin sliver of light along the freshly cut foil edge - just
    // enough to say "cut edge", no glow (a glow reads as painted-on).
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
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    let runStart = -1;
    for (let s = 0; s < sliceCount; s += 1) {
      if (cut[s] && runStart === -1) runStart = s;
      if ((!cut[s] || s === sliceCount - 1) && runStart !== -1) {
        strokeRun(runStart, cut[s] ? s : s - 1);
        runStart = -1;
      }
    }
    ctx.restore();
    sceneRef.current?.markArtDirty();
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
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  // 3D pack: a bulged foil pouch mesh textured with the live cut canvas.
  // Declared before the art effect so the texture canvas exists by the time
  // the first art draw runs.
  useEffect(() => {
    const host = packRef.current;
    if (!host) return;
    const live = document.createElement("canvas");
    live.width = PACK_ART_WIDTH;
    live.height = PACK_ART_HEIGHT;
    liveCanvasRef.current = live;
    const back = createPackBackCanvas();
    backCanvasRef.current = back;
    const strip = document.createElement("canvas");
    strip.width = PACK_ART_WIDTH;
    strip.height = Math.ceil(PACK_ART_HEIGHT * PACK_RIP_STRIP_FRACTION);
    ripStripCanvasRef.current = strip;
    // Async: the shared renderer/environment/shaders build staged across
    // frames on the first ever mount (and resolve instantly afterwards), so
    // the route transition never pays the whole WebGL setup in one frame.
    let cancelled = false;
    void createPackScene({
      host,
      textureCanvas: live,
      backCanvas: back,
      reducedMotion: reducedMotionRef.current,
    }).then((scene) => {
      if (cancelled) {
        scene.dispose();
        return;
      }
      sceneRef.current = scene;
      setSceneReady(true);
    }).catch(() => {
      // WebGL unavailable; the placeholder stays.
    });
    const onResize = () => sceneRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      sceneRef.current?.dispose();
      sceneRef.current = null;
      liveCanvasRef.current = null;
      ripStripCanvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sceneRef.current?.setWindowActive(windowActive && stageVisibleRef.current);
  }, [windowActive, sceneReady]);

  useEffect(() => {
    const host = packRef.current;
    if (!host || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        stageVisibleRef.current = visible;
        sceneRef.current?.setWindowActive(windowActiveRef.current && visible);
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    sceneRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, sceneReady]);

  useEffect(() => {
    const nextStyle = packType ? packArtStyleFor(packType) : DEFAULT_PACK_ART_STYLE;
    const next = getCachedPackFrontCanvas(nextStyle);
    setArtReady(true);
    // A per-frame blend redraws and uploads a 600x1000 texture for the whole
    // duration. Swapping the cached source in one frame keeps selection input
    // responsive and avoids a competing animation while the pack floats.
    artCanvasRef.current = next;
    drawFrame();
    // The back foil is stock too, so it takes the same tint; repainting in
    // place keeps the scene's existing back texture valid.
    const back = backCanvasRef.current;
    if (back) {
      paintPackBackCanvas(back, nextStyle.accent);
      sceneRef.current?.markBackArtDirty();
    }
  }, [packType, sceneReady]);

  // Blade trail: while the pointer is held down anywhere on the stage, a
  // fading streak chases the cursor (on and off the pack), so the slash
  // reads as a blade before it ever touches the foil.
  const ensureTrailLoop = () => {
    if (trailRafRef.current !== null) return;
    const step = () => {
      trailRafRef.current = null;
      const canvas = trailCanvasRef.current;
      if (!canvas) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const areaScale = Math.sqrt(TRAIL_PIXEL_BUDGET / Math.max(1, vw * vh));
      const renderScale = clampNumber(
        Math.min(window.devicePixelRatio || 1, areaScale),
        TRAIL_MIN_SCALE,
        TRAIL_MAX_SCALE,
      );
      if (canvas.width !== Math.round(vw * renderScale) || canvas.height !== Math.round(vh * renderScale)) {
        canvas.width = Math.round(vw * renderScale);
        canvas.height = Math.round(vh * renderScale);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
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

  /* Splits the pack along the recorded cut into transparent canvases: the
     torn-off strip and remaining body of the front print, plus the back
     foil's remaining body - a real slash goes through both layers, so the
     back shell has to lose its top too. The 3D scene maps them onto the
     pouch geometry for the rip animation. */
  const buildRipStrip = (
    art: HTMLCanvasElement,
    back: HTMLCanvasElement,
    body: HTMLCanvasElement,
    strip: HTMLCanvasElement,
  ) => {
    const width = PACK_ART_WIDTH;
    const height = PACK_ART_HEIGHT;
    const bins = binsRef.current;
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= BIN_COUNT; i += 1) {
      const a = bins[Math.max(0, i - 1)];
      const b = bins[Math.min(BIN_COUNT - 1, i)];
      const x = (i / BIN_COUNT) * width;
      const y = ((a + b) / 2 + (random01(i * 17.31 + 3.7) - 0.5) * 0.011) * height;
      points.push([x, y]);
    }
    const stripPath = new Path2D();
    stripPath.moveTo(0, 0);
    stripPath.lineTo(width, 0);
    for (let i = points.length - 1; i >= 0; i -= 1) stripPath.lineTo(points[i][0], points[i][1]);
    stripPath.closePath();
    const bodyPath = new Path2D();
    bodyPath.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) bodyPath.lineTo(points[i][0], points[i][1]);
    bodyPath.lineTo(width, height);
    bodyPath.lineTo(0, height);
    bodyPath.closePath();
    const stripContext = strip.getContext("2d");
    const bodyContext = body.getContext("2d");
    const backContext = back.getContext("2d");
    if (!stripContext || !bodyContext || !backContext) return null;

    stripContext.clearRect(0, 0, strip.width, strip.height);
    stripContext.save();
    stripContext.clip(stripPath);
    stripContext.drawImage(art, 0, 0);
    stripContext.restore();

    bodyContext.clearRect(0, 0, width, height);
    bodyContext.save();
    bodyContext.clip(bodyPath);
    bodyContext.drawImage(art, 0, 0);
    bodyContext.restore();

    // The back texture already points at this canvas. Punching its top away
    // in place avoids allocating, uploading, and later disposing another
    // full-size body texture at the exact moment the rip starts.
    backContext.save();
    backContext.globalCompositeOperation = "destination-out";
    backContext.fillStyle = "#000";
    backContext.fill(stripPath);
    backContext.restore();
    return strip;
  };

  const triggerRip = () => {
    if (rippingRef.current) return;
    rippingRef.current = true;
    playPackRip();
    slashRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    fillUncutBins();
    const art = artCanvasRef.current;
    const back = backCanvasRef.current;
    const body = liveCanvasRef.current;
    const strip = ripStripCanvasRef.current;
    if (art && back && body && strip) {
      const builtStrip = buildRipStrip(art, back, body, strip);
      if (builtStrip) sceneRef.current?.beginRip(builtStrip);
    }
    setRipping(true);
    window.setTimeout(onOpened, reducedMotion ? 220 : 880);
  };

  const setCutSpan = (xa: number, yaFrac: number, xb: number, ybFrac: number) => {
    const binA = clampNumber(Math.floor((xa / PACK_ART_WIDTH) * BIN_COUNT), 0, BIN_COUNT - 1);
    const binB = clampNumber(Math.floor((xb / PACK_ART_WIDTH) * BIN_COUNT), 0, BIN_COUNT - 1);
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
    if (changed) {
      recomputeCutFields();
      playSlashTick(cutCountRef.current / BIN_COUNT);
    }
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
    sceneRef.current?.setTiltTarget(ny * -12, nx * 16);
  };

  const onPointerLeaveTilt = () => {
    if (slashRef.current || rippingRef.current) return;
    sceneRef.current?.setTiltTarget(0, 0);
  };

  /* Advances the blade gesture at a viewport point: starts a slash when the
     blade enters the tear band, extends the cut while slashing. The point is
     mapped onto the tilted pack's plane by the 3D scene; x is tracked in
     texture pixels. */
  const cutAtPoint = (clientX: number, clientY: number) => {
    if (rippingRef.current) return;
    const point = sceneRef.current?.pointerToPack(clientX, clientY);
    if (!point) return;
    const ny = point.v;
    const slash = slashRef.current;
    if (!slash) {
      if (ny < TEAR_BAND_TOP || ny > TEAR_BAND_BOTTOM) return;
      // Horizontal slack so a swipe that starts off the pack still bites.
      if (point.u < -0.2 || point.u > 1.2) return;
      const x = clampNumber(point.u, 0, 1) * PACK_ART_WIDTH;
      const yFrac = clampNumber(ny, CUT_MIN_Y, CUT_MAX_Y);
      slashRef.current = { lastX: x, lastYFrac: yFrac, lastSparkX: x };
      setCutSpan(x, yFrac, x, yFrac);
      ensureLoop();
      return;
    }
    const x = clampNumber(point.u, 0, 1) * PACK_ART_WIDTH;
    const yFrac = clampNumber(ny, CUT_MIN_Y, CUT_MAX_Y);
    setCutSpan(slash.lastX, slash.lastYFrac, x, yFrac);
    slash.lastX = x;
    slash.lastYFrac = yFrac;
    if (Math.abs(x - slash.lastSparkX) > 35) {
      slash.lastSparkX = x;
      spawnSparks(clientX, clientY);
    }
    if (cutCountRef.current / BIN_COUNT >= TEAR_COMPLETE_COVERAGE) triggerRip();
  };

  /* The blade is driven from document-level pointer events: touch pointers
     are implicitly captured by whatever element the finger lands on, so
     element-bound handlers never see a swipe that starts off the pack (the
     reason cutting was impossible on mobile). Tracking the held pointer
     ourselves also sidesteps iOS Safari's unreliable PointerEvent.buttons. */
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (rippingRef.current || bladeHeldRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const stage = stageRef.current;
      if (!stage || !(event.target instanceof Node) || !stage.contains(event.target)) return;
      bladeHeldRef.current = { pointerId: event.pointerId };
      cutAtPoint(event.clientX, event.clientY);
    };
    const onMove = (event: PointerEvent) => {
      const held = bladeHeldRef.current;
      if (!held || held.pointerId !== event.pointerId) return;
      cutAtPoint(event.clientX, event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      if (bladeHeldRef.current?.pointerId !== event.pointerId) return;
      bladeHeldRef.current = null;
      slashRef.current = null;
      ensureLoop();
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
      bladeHeldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // pan-y: vertical swipes still scroll the page on touch, horizontal
    // swipes are the blade and never turn into a scroll.
    <div ref={stageRef} className="flex flex-col items-center" style={{ touchAction: "pan-y" }}>
      {/* Blade trail overlay, viewport-sized so the streak runs off the pack */}
      {!reducedMotion && (
        <canvas
          ref={trailCanvasRef}
          className="pointer-events-none fixed inset-0 z-30 h-full w-full"
          aria-hidden="true"
        />
      )}
      {/* Slash sparks, viewport-anchored like the trail */}
      {sparks.length > 0 && (
        <div className="pointer-events-none fixed inset-0 z-30" aria-hidden="true">
          {sparks.map((spark) => (
            <motion.div
              key={spark.id}
              className="absolute rounded-full"
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
        </div>
      )}
      {/* Host for the 3D pack; the scene's canvas overflows it on purpose so
          the tilted pack and the torn strip never clip */}
      <div
        ref={packRef}
        className="relative select-none"
        style={{
          // Narrower than the old squat pack: the 0.6 aspect makes it taller,
          // so this keeps roughly the same on-screen height.
          width: "min(270px, 66vw)",
          aspectRatio: `${PACK_ASPECT}`,
          touchAction: "none",
        }}
        onPointerMove={onPointerMoveTilt}
        onPointerLeave={onPointerLeaveTilt}
      >
        {!(artReady && sceneReady) && <div className="absolute inset-0 rounded-xl bg-osu-b4/50 animate-pulse" />}
      </div>
      {/* Ground shadow under the floating pack */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none mt-2 h-5 w-[min(210px,52vw)] rounded-[50%] bg-black/55 blur-lg"
        animate={ripping ? { opacity: 0 } : undefined}
        transition={{ duration: 0.5 }}
      />

      {/* One line: the old second line only restated the first one in other
          words, and the gesture is the whole instruction. */}
      <div className="mt-5 h-5 text-center" aria-live="polite">
        <div className="text-sm font-semibold text-white">
          {ripping ? "Opening..." : "Hold and drag across the dotted line"}
        </div>
      </div>
    </div>
  );
}
