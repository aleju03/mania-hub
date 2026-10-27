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
  small = false,
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
  /** A thinner track and thumb, for dense inspector rows. */
  small?: boolean;
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
        className={`group relative flex min-w-0 flex-1 cursor-pointer touch-none select-none items-center outline-none ${tall ? "h-10" : small ? "h-7" : "h-5"}`}
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
          <div className={`relative w-full rounded-full ${small ? "h-[5px] bg-white/[0.09] group-hover:bg-white/[0.13]" : "h-1.5 bg-osu-b3"}`}>
            <div className="absolute inset-y-0 left-0 rounded-full bg-osu-pink" style={{ width: `${pct}%` }} />
          </div>
        )}
        {tall ? (
          <div className="pointer-events-none absolute inset-y-[-3px] w-[3px] -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" style={{ left: `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${pct / 100})` }} />
        ) : (
          <div
            className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform group-active:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-osu-pink-light ${small ? "h-3.5 w-3.5 group-hover:scale-110" : "h-4 w-4"}`}
            style={{
              left: `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${pct / 100})`,
              background: thumbColor ?? "#fff",
              boxShadow: gradient ? "0 0 0 2px rgba(255,255,255,0.95), 0 0 0 3px rgba(0,0,0,0.75), 0 1px 3px rgba(0,0,0,0.5)" : "0 0 0 1px rgba(0,0,0,0.35), 0 1px 4px rgba(0,0,0,0.55)",
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

export function Popover({ trigger, children, open, onOpenChange, className = "", align = "left" }: {
  align?: "left" | "right";
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
            className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-40 mt-1.5 rounded-xl border border-white/[0.08] bg-osu-b5 p-2 shadow-[0_12px_40px_rgba(0,0,0,0.55)] ${className}`}
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

/* --- Any colour ------------------------------------------------------------ */

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [(hue * 60 + 360) % 360, max === 0 ? 0 : delta / max, max];
}

function SatValuePad({ hue, sat, value, onChange, label }: { hue: number; sat: number; value: number; onChange: (sat: number, value: number) => void; label: string }) {
  const { ref, handlers } = useDrag((x, y) => onChange(x, 1 - y));
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      className="relative h-32 w-full cursor-crosshair touch-none select-none rounded-lg"
      style={{ background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hue}, 100%, 50%))` }}
      {...handlers}
    >
      <span
        className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${sat})`, top: `${(1 - value) * 100}%`, boxShadow: "0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,0.7)" }}
      />
    </div>
  );
}

/* A swatch that opens a picker: saturation and brightness on a pad, hue on a
   strip, and the hex code to type or paste. */
export function ColorField({ value, onChange, label, bar = false }: { value: string; onChange: (hex: string) => void; label: string; /** Drawn as an inspector bar, its name inside. */ bar?: boolean }) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [text, setText] = useState(value);
  // follow a value changed from outside, keeping the hue of a grey the user is on
  useEffect(() => {
    if (hsvToHex(...hsv) !== value) setHsv(hexToHsv(value));
    setText(value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (next: [number, number, number]) => {
    setHsv(next);
    onChange(hsvToHex(...next));
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-60"
      trigger={bar ? (
        <button
          type="button"
          aria-label={label}
          onClick={() => setOpen((current) => !current)}
          className={`flex h-8 w-full cursor-pointer items-center justify-between rounded-md bg-white/[0.045] pl-3 pr-1.5 ring-1 transition hover:bg-white/[0.07] ${open ? "ring-osu-pink/60" : "ring-white/[0.06] hover:ring-white/15"}`}
        >
          <span className="text-[12.5px] text-osu-l2">{label}</span>
          <span className="flex items-center gap-2 font-mono text-[12px] text-white">
            {value}
            <span className="h-5 w-7 rounded ring-1 ring-white/20" style={{ background: value }} />
          </span>
        </button>
      ) : (
        <button
          type="button"
          aria-label={label}
          onClick={() => setOpen((current) => !current)}
          className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-black/30 pl-1 pr-3 font-mono text-[12px] text-osu-l2 ring-1 ring-white/[0.07] transition hover:text-white hover:ring-white/20"
        >
          <span className="h-6 w-6 rounded-md ring-1 ring-white/15" style={{ background: value }} />
          {value}
        </button>
      )}
    >
      <div className="grid gap-2.5 p-1">
        <SatValuePad hue={hsv[0]} sat={hsv[1]} value={hsv[2]} onChange={(sat, val) => set([hsv[0], sat, val])} label={label} />
        <Slider value={hsv[0]} min={0} max={360} onChange={(hue) => set([hue, hsv[1], hsv[2]])} label={label} gradient={HUE_STRIP} thumbColor={`hsl(${hsv[0]}, 100%, 50%)`} />
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const hex = event.target.value.trim().replace(/^([0-9a-f]{6})$/i, "#$1").toLowerCase();
            if (/^#[0-9a-f]{6}$/.test(hex)) onChange(hex);
          }}
          spellCheck={false}
          className="h-8 w-full rounded-lg bg-osu-b6 px-2.5 font-mono text-[12px] text-white ring-1 ring-white/10 focus:outline-none focus:ring-osu-pink/50"
        />
      </div>
    </Popover>
  );
}

/* A row of choices, one picked: for a blend mode or a particle's shape. */
export function Choice<T extends string>({ value, options, onChange }: { value: T; options: readonly { id: T; label: string }[]; onChange: (value: T) => void }) {
  // up to four fit one segmented bar; more wrap as chips
  if (options.length <= 4) {
    return (
      <div className="grid grid-flow-col auto-cols-fr gap-0.5 rounded-lg bg-black/30 p-[3px] ring-1 ring-white/[0.07]">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={`h-7 min-w-0 cursor-pointer truncate rounded-md px-1.5 text-[12px] font-semibold transition-colors ${value === option.id ? "bg-white/[0.12] text-white shadow-[0_1px_2px_rgba(0,0,0,0.4)]" : "text-osu-f1 hover:text-white"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`h-8 cursor-pointer rounded-lg px-3 text-[12px] font-semibold transition-colors ${value === option.id ? "bg-osu-pink/20 text-osu-pink-light ring-1 ring-osu-pink/50" : "bg-black/30 text-osu-f1 ring-1 ring-white/[0.07] hover:text-white"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* --- An inspector number ---------------------------------------------------- */

/* One setting as a scrub bar, the way design tools do it: the whole field
   fills up to the value, its name on the left and the number on the right.
   Drag anywhere on it to change it (Shift for fine steps), or click it to
   type a number. The stored value can differ from the shown one: `scale`
   100 shows 0.25 as 25. */
export function NumberField({ label, value, min, max, step, onChange, scale = 1, unit = "", decimals = 0 }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  scale?: number;
  unit?: string;
  decimals?: number;
}) {
  const shown = (value * scale).toFixed(decimals);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; value: number; width: number; moved: boolean } | null>(null);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const snap = (next: number) => clamp(Math.round(next / step) * step);
  const fill = Math.max(0, Math.min(1, (value - min) / (max - min)));
  // a range across zero fills from zero, so a negative value reads as one
  const zero = min < 0 && max > 0 ? (0 - min) / (max - min) : 0;
  const from = Math.min(zero, fill);
  const to = Math.max(zero, fill);

  const commit = () => {
    const parsed = Number.parseFloat(text.replace(/[^0-9.+-]/g, ""));
    if (Number.isFinite(parsed)) onChange(clamp(parsed / scale));
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="relative h-8">
        <input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setEditing(false);
          }}
          spellCheck={false}
          aria-label={label}
          className="h-8 w-full rounded-md bg-black/50 pl-3 pr-8 text-right font-mono text-[12.5px] text-white ring-1 ring-osu-pink/70 focus:outline-none"
        />
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[12.5px] text-osu-f1">{label}</span>
        {unit ? <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-osu-f1">{unit}</span> : null}
      </div>
    );
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${shown}${unit}`}
      className={`group relative h-8 cursor-ew-resize touch-none select-none overflow-hidden rounded-md bg-white/[0.045] outline-none ring-1 transition-[box-shadow,background-color] ${dragging ? "bg-white/[0.07] ring-osu-pink/60" : "ring-white/[0.06] hover:bg-white/[0.07] hover:ring-white/15 focus-visible:ring-osu-pink/60"}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, value, width: event.currentTarget.getBoundingClientRect().width, moved: false };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const dx = event.clientX - start.x;
        if (!start.moved && Math.abs(dx) < 3) return;
        if (!start.moved) setDragging(true);
        start.moved = true;
        onChange(snap(start.value + (dx / start.width) * (max - min) * (event.shiftKey ? 0.1 : 1)));
      }}
      onPointerUp={() => {
        const start = drag.current;
        drag.current = null;
        setDragging(false);
        if (start && !start.moved) {
          setText(shown);
          setEditing(true);
        }
      }}
      onKeyDown={(event) => {
        const big = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") onChange(snap(value - step * big));
        else if (event.key === "ArrowRight" || event.key === "ArrowUp") onChange(snap(value + step * big));
        else if (event.key === "Enter") {
          setText(shown);
          setEditing(true);
        } else return;
        event.preventDefault();
      }}
    >
      <span
        className={`absolute inset-y-0 transition-colors ${dragging ? "bg-osu-pink/30" : "bg-osu-pink/[0.18] group-hover:bg-osu-pink/[0.24]"}`}
        style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }}
      />
      <span className="absolute inset-y-1.5 w-[2px] -translate-x-1/2 rounded-full bg-osu-pink" style={{ left: `${fill * 100}%` }} />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-between px-3">
        <span className="truncate text-[12.5px] text-osu-l2">{label}</span>
        <span className="font-mono text-[12px] text-white">
          {shown}
          {unit ? <span className="ml-0.5 text-osu-f1">{unit}</span> : null}
        </span>
      </span>
    </div>
  );
}
