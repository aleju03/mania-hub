import { useEffect, useRef, useState } from "react";

import {
  SMOKE_LIFETIME_MS,
  readCursorSettings,
  smokeAlpha,
  subscribeCursorSettings,
} from "../../lib/cursor";
import type { CursorSettings } from "../../lib/cursor";

const TRAIL_LIFETIME_MS = 240;
const TRAIL_MIN_DISTANCE = 4;
const SMOKE_MIN_DISTANCE = 3;
const SMOKE_MAX_POINTS = 4000;
/* Chromium and Firefox drop a cursor image larger than this whose box crosses
   the edge of the page (it could pass for browser UI) and show the fallback
   arrow instead. */
const NATIVE_CURSOR_EDGE_LIMIT = 32;
/* The native image hides a frame after the drawn orb first paints, so the
   swap starts this far before the image would reach the edge. */
const DRAWN_ORB_LEAD = 16;

interface TrailPoint {
  x: number;
  y: number;
  at: number;
}

interface SmokePoint {
  x: number;
  y: number;
  at: number;
  /** Starts a new stroke, so no segment is drawn back to the previous point. */
  strokeStart: boolean;
}

function hexChannel(hex: string, index: number): number {
  return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function mixTowardWhite(hex: string, amount: number): string {
  const r = Math.round(hexChannel(hex, 0) + (255 - hexChannel(hex, 0)) * amount);
  const g = Math.round(hexChannel(hex, 1) + (255 - hexChannel(hex, 1)) * amount);
  const b = Math.round(hexChannel(hex, 2) + (255 - hexChannel(hex, 2)) * amount);
  return `rgb(${r}, ${g}, ${b})`;
}

function withAlpha(hex: string, alpha: number): string {
  return `rgba(${hexChannel(hex, 0)}, ${hexChannel(hex, 1)}, ${hexChannel(hex, 2)}, ${alpha})`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") != null;
}

interface NativeCursor {
  css: string;
  image: HTMLCanvasElement | null;
  size: number;
}

/* Firefox scales a cursor image by the CSS zoom of the element under it, which
   shrinks the orb over the BBCode editor's fitted column. */
function hasCssZoom(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const zoom = (target as Element & { currentCSSZoom?: number }).currentCSSZoom;
  return zoom != null && Math.abs(zoom - 1) > 0.001;
}

function cursorRadius(settings: CursorSettings): number {
  return 15 * (settings.size / 100);
}

/* Let the browser move the orb as a native cursor, independently of page
   rendering. Only the decorative glow, trail and smoke, and the orb where the
   native image would be dropped or rescaled, wait for animation frames.
   The glow stays off the native image: Firefox on Windows paints its faint
   pixels nearly black, and it would push the image past the edge limit. */
function buildNativeCursor(settings: CursorSettings, pressScale = 1): NativeCursor {
  const radius = cursorRadius(settings) * pressScale;
  const size = Math.ceil((radius * 1.6 + 2) / 2) * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return { css: "auto", image: null, size: 0 };
  const c = size / 2;
  const color = settings.color;

  const bloom = context.createRadialGradient(c, c, 0, c, c, radius * 0.8);
  bloom.addColorStop(0, withAlpha(color, 0.95));
  bloom.addColorStop(0.5, mixTowardWhite(color, 0.15));
  bloom.addColorStop(1, withAlpha(color, 0));
  context.fillStyle = bloom;
  context.beginPath();
  context.arc(c, c, radius * 0.8, 0, Math.PI * 2);
  context.fill();

  const core = context.createRadialGradient(c, c, 0, c, c, radius * 0.34);
  core.addColorStop(0, "rgba(255, 255, 255, 1)");
  core.addColorStop(0.6, "rgba(255, 255, 255, 0.9)");
  core.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = core;
  context.beginPath();
  context.arc(c, c, radius * 0.34, 0, Math.PI * 2);
  context.fill();

  return { css: `url("${canvas.toDataURL("image/png")}") ${c} ${c}, auto`, image: canvas, size };
}

function buildGlowSprite(settings: CursorSettings, scale: number): { canvas: HTMLCanvasElement; size: number } | null {
  if (settings.glow <= 0) return null;
  const glowRadius = cursorRadius(settings) * (1 + 1.8 * (settings.glow / 100));
  const size = Math.ceil(glowRadius * 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size * scale);
  canvas.height = Math.ceil(size * scale);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(scale, scale);
  const c = size / 2;
  const glow = context.createRadialGradient(c, c, 0, c, c, glowRadius);
  glow.addColorStop(0, withAlpha(settings.color, 0.5));
  glow.addColorStop(0.45, withAlpha(settings.color, 0.16));
  glow.addColorStop(1, withAlpha(settings.color, 0));
  context.fillStyle = glow;
  context.beginPath();
  context.arc(c, c, glowRadius, 0, Math.PI * 2);
  context.fill();
  return { canvas, size };
}

function buildTrailSprite(settings: CursorSettings, scale: number): { canvas: HTMLCanvasElement; size: number } {
  const radius = cursorRadius(settings);
  const size = Math.ceil(radius * 2.4 * (settings.trailThickness / 100));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size * scale);
  canvas.height = Math.ceil(size * scale);
  const context = canvas.getContext("2d");
  if (!context) return { canvas, size };
  context.scale(scale, scale);
  const c = size / 2;
  const glow = context.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0, withAlpha(settings.trailColor, 0.55));
  glow.addColorStop(0.4, withAlpha(settings.trailColor, 0.22));
  glow.addColorStop(1, withAlpha(settings.trailColor, 0));
  context.fillStyle = glow;
  context.beginPath();
  context.arc(c, c, c, 0, Math.PI * 2);
  context.fill();
  return { canvas, size };
}

export function CustomCursor() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const finePointer = window.matchMedia("(pointer: fine)");
    const update = () => setActive(readCursorSettings().enabled && finePointer.matches);
    update();
    const unsubscribe = subscribeCursorSettings(update);
    finePointer.addEventListener("change", update);
    return () => {
      unsubscribe();
      finePointer.removeEventListener("change", update);
    };
  }, []);

  if (!active) return null;
  return <CursorOverlay />;
}

function CursorOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let settings: CursorSettings = readCursorSettings();
    const pointer = { x: -100, y: -100, pressed: false, inside: false, typing: false };
    let pressScale = 1;
    let smoking = false;
    let smokeStartsStroke = true;
    const trail: TrailPoint[] = [];
    const smoke: SmokePoint[] = [];
    let rafId: number | null = null;
    let lastFrameAt: number | null = null;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    /* No `desynchronized`: on Windows it puts the canvas on a low-latency swap
       chain that some drivers composite as opaque, painting the whole page
       black behind the cursor. The frame it saved is not worth that. */
    const context = canvas.getContext("2d");
    if (!context) return;

    const root = document.documentElement;
    let normalCursor = buildNativeCursor(settings);
    let pressedCursor = buildNativeCursor(settings, 1.25);
    // Where the browser would drop or rescale the native image, hide it and
    // draw the orb on the canvas instead.
    let drawnOrb = false;
    // Firefox hides the native image before the canvas frame that replaces it
    // reaches the screen, so the orb blinks out for a frame. Keep the native
    // image until the drawn orb has painted once.
    let orbPainted = false;
    let appliedCursor = "";
    let zoomTarget: EventTarget | null = null;
    let zoomed = false;
    const updateNativeCursor = () => {
      const next = drawnOrb && orbPainted ? "none" : (pointer.pressed ? pressedCursor : normalCursor).css;
      if (next === appliedCursor) return;
      appliedCursor = next;
      root.style.setProperty("--custom-cursor", next);
    };
    const needsDrawnOrb = (target: EventTarget | null) => {
      if (target !== zoomTarget) {
        zoomTarget = target;
        zoomed = hasCssZoom(target);
      }
      if (zoomed) return true;
      const size = Math.max(normalCursor.size, pressedCursor.size);
      if (size <= NATIVE_CURSOR_EDGE_LIMIT) return false;
      const half = size / 2 + 1 + DRAWN_ORB_LEAD;
      const width = root.clientWidth || window.innerWidth;
      const height = root.clientHeight || window.innerHeight;
      return pointer.x < half || pointer.y < half || pointer.x > width - half || pointer.y > height - half;
    };
    updateNativeCursor();
    root.dataset.customCursor = "true";
    let trailSprite = buildTrailSprite(settings, dpr);
    let glowSprite = buildGlowSprite(settings, dpr);

    /* Size the buffer from the canvas box, not the window: a fixed canvas stops
       at the scrollbar, and a buffer wider than its box squeezes every drawing
       toward the left. */
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      canvas.width = Math.round((box.width || window.innerWidth) * dpr);
      canvas.height = Math.round((box.height || window.innerHeight) * dpr);
      ensureRunning();
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);

    /* Effects still animate when hovering an unfocused window, but pause in
       hidden tabs. The native cursor doesn't depend on this render loop. */
    const isPageVisible = () => document.visibilityState === "visible";

    const draw = (time: number) => {
      rafId = null;

      const dt = lastFrameAt == null ? 0.016 : Math.min(0.05, (time - lastFrameAt) / 1000);
      lastFrameAt = time;

      updateNativeCursor();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

      const now = performance.now();
      while (smoke.length > 0 && now - smoke[0].at >= SMOKE_LIFETIME_MS) smoke.shift();
      while (trail.length > 0 && now - trail[0].at >= TRAIL_LIFETIME_MS) trail.shift();

      if (smoke.length > 1) {
        context.lineCap = "round";
        context.lineJoin = "round";
        for (let i = 1; i < smoke.length; i++) {
          const point = smoke[i];
          if (point.strokeStart) continue;
          const prev = smoke[i - 1];
          const alpha = smokeAlpha(now - (point.at + prev.at) / 2);
          if (alpha <= 0) continue;
          context.beginPath();
          context.moveTo(prev.x, prev.y);
          context.lineTo(point.x, point.y);
          context.strokeStyle = `rgba(245, 245, 250, ${alpha * 0.14})`;
          context.lineWidth = 7;
          context.stroke();
          context.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.5})`;
          context.lineWidth = 2.5;
          context.stroke();
        }
      }

      if (settings.trail) {
        for (const point of trail) {
          const life = 1 - (now - point.at) / TRAIL_LIFETIME_MS;
          if (life <= 0) continue;
          const size = trailSprite.size * (0.55 + 0.45 * life) * pressScale;
          context.globalAlpha = life * 0.8;
          context.drawImage(trailSprite.canvas, point.x - size / 2, point.y - size / 2, size, size);
        }
        context.globalAlpha = 1;
      }

      if (glowSprite && pointer.inside && !pointer.typing) {
        const size = glowSprite.size * pressScale;
        context.drawImage(glowSprite.canvas, pointer.x - size / 2, pointer.y - size / 2, size, size);
      }

      if (drawnOrb && pointer.inside && normalCursor.image) {
        const size = normalCursor.size * pressScale;
        context.drawImage(normalCursor.image, pointer.x - size / 2, pointer.y - size / 2, size, size);
        orbPainted = true;
      } else {
        orbPainted = false;
      }

      const targetScale = pointer.pressed ? 1.25 : 1;
      pressScale += (targetScale - pressScale) * Math.min(1, dt * 18);

      const idle =
        smoke.length === 0 &&
        trail.length === 0 &&
        Math.abs(pressScale - targetScale) < 0.01 &&
        !(orbPainted && appliedCursor !== "none");
      if (!idle && isPageVisible()) {
        rafId = requestAnimationFrame(draw);
      } else {
        lastFrameAt = null;
      }
    };

    const ensureRunning = () => {
      if (rafId != null || !isPageVisible()) return;
      lastFrameAt = null;
      rafId = requestAnimationFrame(draw);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const now = performance.now();
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.inside = true;
      pointer.typing = false;
      drawnOrb = needsDrawnOrb(event.target);

      if (settings.trail) {
        const last = trail[trail.length - 1];
        if (!last || Math.hypot(pointer.x - last.x, pointer.y - last.y) >= TRAIL_MIN_DISTANCE) {
          trail.push({ x: pointer.x, y: pointer.y, at: now });
          if (trail.length > 60) trail.shift();
        }
      }

      if (smoking) {
        const last = smoke[smoke.length - 1];
        if (
          smokeStartsStroke ||
          !last ||
          Math.hypot(pointer.x - last.x, pointer.y - last.y) >= SMOKE_MIN_DISTANCE
        ) {
          smoke.push({ x: pointer.x, y: pointer.y, at: now, strokeStart: smokeStartsStroke });
          smokeStartsStroke = false;
          if (smoke.length > SMOKE_MAX_POINTS) smoke.shift();
        }
      }

      ensureRunning();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer.pressed = true;
      updateNativeCursor();
      ensureRunning();
    };

    const handlePointerUp = () => {
      pointer.pressed = false;
      updateNativeCursor();
      ensureRunning();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) {
        // The system hides the pointer while typing; hide the glow and trail
        // with it until the mouse moves again. A drawn orb stays, since it is
        // the only cursor there is near the edges.
        if (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") {
          pointer.typing = true;
          trail.length = 0;
          ensureRunning();
        }
        return;
      }
      if (event.code !== "KeyC") return;
      if (!smoking) {
        smoking = true;
        smokeStartsStroke = true;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "KeyC") smoking = false;
    };

    const handleBlur = () => {
      smoking = false;
      pointer.pressed = false;
      smokeStartsStroke = true;
      updateNativeCursor();
      ensureRunning();
    };

    const handleMouseLeave = () => {
      smokeStartsStroke = true;
      pointer.inside = false;
      ensureRunning();
    };

    // Moves inside an iframe never reach this page, so a drawn orb would
    // freeze at its edge.
    const handlePointerOver = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLIFrameElement)) return;
      pointer.inside = false;
      ensureRunning();
    };

    const handleVisibilityChange = () => {
      if (isPageVisible()) {
        ensureRunning();
      } else {
        handleBlur();
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
          lastFrameAt = null;
        }
      }
    };

    const unsubscribeSettings = subscribeCursorSettings((next) => {
      settings = next;
      normalCursor = buildNativeCursor(next);
      pressedCursor = buildNativeCursor(next, 1.25);
      updateNativeCursor();
      trailSprite = buildTrailSprite(next, dpr);
      glowSprite = buildGlowSprite(next, dpr);
      if (!next.trail) trail.length = 0;
      ensureRunning();
    });

    resize();
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerover", handlePointerOver, { passive: true });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    window.addEventListener("pointercancel", handlePointerUp, { passive: true });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    document.documentElement.addEventListener("mouseleave", handleMouseLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    ensureRunning();

    return () => {
      delete document.documentElement.dataset.customCursor;
      root.style.removeProperty("--custom-cursor");
      if (rafId != null) cancelAnimationFrame(rafId);
      unsubscribeSettings();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerover", handlePointerOver);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      document.documentElement.removeEventListener("mouseleave", handleMouseLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[9999] h-full w-full"
    />
  );
}
