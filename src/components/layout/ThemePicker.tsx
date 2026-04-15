import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DEFAULT_THEME_HUE, useAppStore, useHasHydrated } from "../../store";

interface ThemePickerProps {
  variant?: "desktop" | "mobile";
}

const PRESET_HUES: ReadonlyArray<{ hue: number; name: string }> = [
  { hue: 333, name: "pink" },
  { hue: 355, name: "rose" },
  { hue: 15, name: "red" },
  { hue: 30, name: "orange" },
  { hue: 50, name: "amber" },
  { hue: 95, name: "lime" },
  { hue: 140, name: "green" },
  { hue: 170, name: "teal" },
  { hue: 200, name: "cyan" },
  { hue: 225, name: "blue" },
  { hue: 260, name: "indigo" },
  { hue: 290, name: "purple" },
];

const RAINBOW_STRIP_GRADIENT =
  "linear-gradient(to right, hsl(0,95%,55%), hsl(30,95%,55%), hsl(60,95%,50%), hsl(120,70%,45%), hsl(170,75%,45%), hsl(200,85%,50%), hsl(240,90%,60%), hsl(280,80%,55%), hsl(320,90%,55%), hsl(360,95%,55%))";

function HueStrip({ hue, onChange }: { hue: number; onChange: (hue: number) => void }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const pickFromClientX = useCallback(
    (clientX: number) => {
      const el = stripRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onChange(Math.round(ratio * 360));
    },
    [onChange],
  );

  return (
    <div
      ref={stripRef}
      role="slider"
      tabIndex={0}
      aria-label="Custom theme hue"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hue)}
      className="relative h-3 rounded-full cursor-pointer touch-none select-none"
      style={{
        background: RAINBOW_STRIP_GRADIENT,
        boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.4)",
      }}
      onPointerDown={(event) => {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* some browsers reject setPointerCapture on synthetic events */
        }
        draggingRef.current = true;
        pickFromClientX(event.clientX);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        pickFromClientX(event.clientX);
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* pointer capture may already be released */
        }
      }}
      onClick={(event) => {
        if (draggingRef.current) return;
        pickFromClientX(event.clientX);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onChange((Math.round(hue) - 1 + 360) % 360);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onChange((Math.round(hue) + 1) % 360);
        }
      }}
    >
      <div
        className="absolute top-1/2 w-4 h-4 rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
        style={{
          left: `${(hue / 360) * 100}%`,
          background: `hsl(${hue}, 100%, 65%)`,
          boxShadow:
            "0 0 0 2px rgba(255, 255, 255, 0.95), 0 0 0 3px rgba(0, 0, 0, 0.75), 0 1px 3px rgba(0, 0, 0, 0.5)",
        }}
      />
    </div>
  );
}

function PaletteIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a9 9 0 0 0 0 18c1.1 0 2-.9 2-2 0-.55-.22-1.05-.58-1.41-.36-.36-.58-.86-.58-1.41 0-1.1.9-2 2-2h2a5 5 0 0 0 5-5A9 9 0 0 0 12 3Z" />
      <circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="17" cy="11" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ThemePicker({ variant = "desktop" }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const hue = useAppStore((state) => state.themeHue);
  const setThemeHue = useAppStore((state) => state.setThemeHue);
  const resetThemeHue = useAppStore((state) => state.resetThemeHue);
  const hydrated = useHasHydrated();
  const displayHue = hydrated ? hue : DEFAULT_THEME_HUE;

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const isDefault = displayHue === DEFAULT_THEME_HUE;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          variant === "desktop"
            ? "flex items-center justify-center w-9 h-9 rounded-lg hover:bg-osu-b3/50 transition-colors cursor-pointer text-osu-pink-light"
            : "flex items-center gap-3 w-full px-3 py-2 rounded-lg bg-osu-b4/60 hover:bg-osu-b4 transition-colors cursor-pointer text-osu-pink-light"
        }
        title="Theme color"
        aria-label="Theme color"
        aria-expanded={open}
      >
        <PaletteIcon className="w-5 h-5" />
        {variant === "mobile" ? (
          <span className="text-[12px] font-semibold capitalize">theme color</span>
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            className={
              variant === "desktop"
                ? "absolute right-0 top-[calc(100%+10px)] w-[260px] p-3 rounded-lg bg-osu-b5 border border-osu-b3/60 shadow-2xl z-[70]"
                : "absolute left-0 right-0 top-[calc(100%+8px)] p-3 rounded-lg bg-osu-b5 border border-osu-b3/60 shadow-2xl z-[70]"
            }
          >
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="text-[10px] font-semibold text-osu-l2 uppercase tracking-wider">
                Theme color
              </div>
              <button
                type="button"
                onClick={resetThemeHue}
                disabled={isDefault}
                className="text-[10px] font-semibold text-osu-f1 hover:text-white disabled:opacity-30 disabled:hover:text-osu-f1 transition-colors cursor-pointer disabled:cursor-default"
              >
                Reset
              </button>
            </div>
            <div className="grid grid-cols-6 gap-2">
              {PRESET_HUES.map(({ hue: presetHue, name }) => {
                const isActive = presetHue === displayHue;
                return (
                  <button
                    key={presetHue}
                    type="button"
                    onClick={() => setThemeHue(presetHue)}
                    title={name}
                    aria-label={name}
                    aria-pressed={isActive}
                    className={`relative aspect-square rounded-md cursor-pointer transition-transform hover:scale-110 focus:outline-none ${
                      isActive ? "scale-110" : ""
                    }`}
                    style={{
                      background: `hsl(${presetHue}, 100%, 65%)`,
                      boxShadow: isActive
                        ? "0 0 0 2px rgba(255, 255, 255, 0.95), 0 0 0 4px rgba(0, 0, 0, 0.75)"
                        : "0 1px 3px rgba(0, 0, 0, 0.4)",
                    }}
                  >
                    {isActive ? (
                      <svg
                        viewBox="0 0 24 24"
                        className="absolute inset-0 m-auto w-4 h-4 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
                        fill="none"
                        stroke="white"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M5 12l5 5L20 7" />
                      </svg>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 px-1">
              <HueStrip hue={displayHue} onChange={setThemeHue} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
