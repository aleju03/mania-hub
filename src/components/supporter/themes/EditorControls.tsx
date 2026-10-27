import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

/* The theme editor's own controls, drawn like the site's colour picker
   (layout/ThemePicker.tsx) instead of the browser's: a slider that can be a
   plain track or a gradient strip, and a pad for the page's dark base colour. */

const THUMB_HALF = 8;

/* Pointer drag over an element, as a 0..1 position across (and down). */
function useDrag(onMove: (x: number, y: number) => void, onStart?: () => void, onEnd?: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const pick = useCallback((clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = rect.width - THUMB_HALF * 2;
    const x = width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left - THUMB_HALF) / width)) : 0;
    const y = rect.height > 0 ? Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) : 0;
    onMove(x, y);
  }, [onMove]);
  const handlers = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* some browsers reject capture on synthetic events */
      }
      dragging.current = true;
      onStart?.();
      pick(event.clientX, event.clientY);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragging.current) pick(event.clientX, event.clientY);
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      onEnd?.();
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    },
  };
  return { ref, handlers };
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  gradient,
  thumbColor,
  format,
  onDragStart,
  onDragEnd,
  track,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  /** Paints the track as a strip (a hue or a strength) instead of a filled line. */
  gradient?: string;
  thumbColor?: string;
  /** Shows the value beside the track. */
  format?: (value: number) => string;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Something drawn inside the track, under the thumb (the moment's filmstrip). */
  track?: ReactNode;
}) {
  const snap = (raw: number) => Math.min(max, Math.max(min, Math.round(raw / step) * step));
  const { ref, handlers } = useDrag((x) => onChange(snap(min + x * (max - min))), onDragStart, onDragEnd);
  const pct = ((value - min) / (max - min)) * 100;
  const tall = track !== undefined;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format?.(value)}
        className={`group relative flex min-w-0 flex-1 cursor-pointer touch-none select-none items-center outline-none ${tall ? "h-10" : "h-5"}`}
        onKeyDown={(event) => {
          const big = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") onChange(snap(value - step * big));
          else if (event.key === "ArrowRight" || event.key === "ArrowUp") onChange(snap(value + step * big));
          else return;
          event.preventDefault();
        }}
        {...handlers}
      >
        {tall ? (
          <div className="absolute inset-x-0 inset-y-0 overflow-hidden rounded-md bg-osu-b6 ring-1 ring-white/[0.07]">{track}</div>
        ) : gradient ? (
          <div className="h-3 w-full rounded-full" style={{ background: gradient }} />
        ) : (
          <div className="relative h-1.5 w-full rounded-full bg-osu-b3">
            <div className="absolute inset-y-0 left-0 rounded-full bg-osu-pink" style={{ width: `${pct}%` }} />
          </div>
        )}
        {tall ? (
          <div className="pointer-events-none absolute inset-y-[-3px] w-[3px] -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" style={{ left: `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${pct / 100})` }} />
        ) : (
          <div
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform group-active:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-osu-pink-light"
            style={{
              left: `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${pct / 100})`,
              background: thumbColor ?? "#fff",
              boxShadow: gradient ? "0 0 0 2px rgba(255,255,255,0.95), 0 0 0 3px rgba(0,0,0,0.75), 0 1px 3px rgba(0,0,0,0.5)" : "0 0 0 3px rgba(255,102,171,0.9), 0 1px 3px rgba(0,0,0,0.5)",
            }}
          />
        )}
      </div>
      {format ? <span className="w-12 shrink-0 text-right font-mono text-[11.5px] text-osu-l2">{format(value)}</span> : null}
    </div>
  );
}

/* --- The base colour ------------------------------------------------------ */

/* The page's base under a theme stays dark: the pad runs hue across and
   only the dark end of lightness down, so no pick makes the profile's
   panels unreadable. */
const BASE_SAT = 45;
const BASE_LIGHT_MIN = 1.5;
const BASE_LIGHT_MAX = 14;

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHueLight(hex: string): [number, number] {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = ((max + min) / 2) * 100;
  if (max === min) return [0, light];
  const delta = max - min;
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [(hue * 60 + 360) % 360, light];
}

export function BasePad({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const { ref, handlers } = useDrag((x, y) => onChange(hslToHex(x * 360, BASE_SAT, BASE_LIGHT_MAX - y * (BASE_LIGHT_MAX - BASE_LIGHT_MIN))));
  const [hue, light] = hexToHueLight(value);
  const y = Math.max(0, Math.min(1, (BASE_LIGHT_MAX - light) / (BASE_LIGHT_MAX - BASE_LIGHT_MIN)));
  const across = Array.from({ length: 13 }, (_, index) => `hsl(${index * 30}, ${BASE_SAT}%, ${(BASE_LIGHT_MAX + BASE_LIGHT_MIN) / 2 + 2}%)`).join(", ");
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={value}
      className="relative h-14 w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg ring-1 ring-white/10"
      style={{ background: `linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.85)), linear-gradient(to right, ${across})` }}
      {...handlers}
    >
      <span
        className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          left: `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${hue / 360})`,
          top: `${y * 100}%`,
          background: value,
          boxShadow: "0 0 0 2px rgba(255,255,255,0.95), 0 0 0 3px rgba(0,0,0,0.75)",
        }}
      />
    </div>
  );
}

export const HUE_STRIP = "linear-gradient(to right, hsl(0,95%,55%), hsl(30,95%,55%), hsl(60,95%,50%), hsl(120,70%,45%), hsl(170,75%,45%), hsl(200,85%,50%), hsl(240,90%,60%), hsl(280,80%,55%), hsl(320,90%,55%), hsl(360,95%,55%))";

export function strengthStrip(hue: number): string {
  return `linear-gradient(to right, hsl(${hue}, 0%, 30%), hsl(${hue}, 50%, 45%), hsl(${hue}, 100%, 60%))`;
}

/* --- A popover anchored to a button -------------------------------------- */

export function Popover({ trigger, children, open, onOpenChange, className = "" }: {
  trigger: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);
  return (
    <div ref={ref} className="relative">
      {trigger}
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
            className={`absolute left-0 top-full z-40 mt-1.5 rounded-xl border border-white/[0.08] bg-osu-b5 p-2 shadow-[0_12px_40px_rgba(0,0,0,0.55)] ${className}`}
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* Remembers a value only while a pointer drags, for previews that follow a scrub. */
export function useScrubbing(): [boolean, () => void, () => void] {
  const [scrubbing, setScrubbing] = useState(false);
  return [scrubbing, useCallback(() => setScrubbing(true), []), useCallback(() => setScrubbing(false), [])];
}
