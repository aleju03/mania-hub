import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Radio } from "lucide-react";

import { playTrackingStartedSound } from "../../lib/ui-sounds";
import { COMPOSER_TRIANGLES } from "./GoalToasts";

// Site-wide "tracking started" toast, mounted once in the root layout (like GoalToasts). The
// opt-in cards fire it via the module-level trigger below instead of rendering it themselves:
// on /my-stats the successful opt-in reloads the panel, which unmounts the card, so anything the
// card rendered would vanish with it. Module state keeps the moment alive across that remount.

const showListeners = new Set<() => void>();

/** Pop the site-wide "tracking started" toast (with its chime). Call after a successful opt-in. */
export function showTrackingStartedToast(): void {
  playTrackingStartedSound();
  for (const listener of showListeners) listener();
}

export function TrackingToasts() {
  const [toastId, setToastId] = useState<number | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const show = () => {
      seq.current += 1;
      setToastId(seq.current);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setToastId(null), 6500);
    };
    showListeners.add(show);
    return () => {
      showListeners.delete(show);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <AnimatePresence>
      {toastId != null ? (
        <motion.div
          key={toastId}
          initial={{ opacity: 0, y: 28, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 340, damping: 26 }}
          className="fixed inset-x-0 bottom-5 z-[80] flex justify-center px-4"
          role="status"
          aria-live="polite"
        >
          <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-osu-pink/45 bg-osu-b4 shadow-[0_20px_70px_rgba(0,0,0,0.55)]">
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl opacity-70">
              <svg viewBox="0 20 1200 360" preserveAspectRatio="xMidYMid slice" className="h-full w-full text-osu-pink-light" aria-hidden="true">
                {COMPOSER_TRIANGLES.map((triangle, index) => (
                  <polygon key={index} points={triangle.p} fill="currentColor" fillOpacity={triangle.o} />
                ))}
              </svg>
            </div>
            <div className="relative flex items-center gap-3 p-3.5">
              <motion.span
                initial={{ scale: 0.5 }}
                animate={{ scale: [0.5, 1.18, 1] }}
                transition={{ duration: 0.5, times: [0, 0.6, 1], ease: "easeOut" }}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-osu-pink/15 ring-1 ring-osu-pink/40"
              >
                <Radio className="h-6 w-6 text-osu-pink-light" />
              </motion.span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">tracking on</div>
                <div className="mt-0.5 text-[13.5px] font-bold text-white">Your plays are being recorded now</div>
              </div>
              <button
                type="button"
                onClick={() => setToastId(null)}
                aria-label="Dismiss"
                className="shrink-0 self-start rounded-md p-1 text-osu-f1/70 transition-colors hover:bg-osu-b3/60 hover:text-white"
              >
                <span className="block text-[15px] leading-none" aria-hidden="true">×</span>
              </button>
            </div>
            <motion.div
              key={`bar-${toastId}`}
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: 6.5, ease: "linear" }}
              style={{ transformOrigin: "left" }}
              className="h-0.5 bg-osu-pink/60"
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
