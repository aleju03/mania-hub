import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, TriangleAlert } from "lucide-react";

import { playAdminActionFailedSound, playAdminActionSound } from "../../lib/ui-sounds";

// The admin desks say what a write did in a toast rather than a banner above the form: a grant
// happens at the bottom of a long page, and a line that appears at the top of it is easy to miss
// and easy to leave sitting there. Same shape as the goal toasts - bottom center, a chime, a
// close button, a bar that ticks the toast out - built here because the trigger has to survive the
// panel that fired it re-rendering after the refresh.

export type AdminToastTone = "success" | "error";

interface AdminToast {
  id: number;
  tone: AdminToastTone;
  message: string;
}

const SUCCESS_MS = 6500;
const ERROR_MS = 9000;

const listeners = new Set<(toast: AdminToast | null) => void>();
let seq = 0;

/** Pop the admin toast (with its sound). Errors stay up longer than successes. */
export function showAdminToast(message: string, tone: AdminToastTone = "success"): void {
  seq += 1;
  if (tone === "error") playAdminActionFailedSound();
  else playAdminActionSound();
  const toast: AdminToast = { id: seq, tone, message };
  for (const listener of listeners) listener(toast);
}

/** Drop whatever is on screen: the message named a target that is no longer the one being edited. */
export function hideAdminToast(): void {
  for (const listener of listeners) listener(null);
}

export function AdminToasts() {
  const [toast, setToast] = useState<AdminToast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const listener = (next: AdminToast | null) => {
      setToast(next);
      if (timer.current) clearTimeout(timer.current);
      if (next) {
        timer.current = setTimeout(() => setToast(null), next.tone === "error" ? ERROR_MS : SUCCESS_MS);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const failed = toast?.tone === "error";

  return (
    <AnimatePresence>
      {toast ? (
        <motion.div
          key={toast.id}
          initial={{ opacity: 0, y: 28, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 340, damping: 26 }}
          className="fixed inset-x-0 bottom-5 z-[80] flex justify-center px-4"
          role="status"
          aria-live="polite"
        >
          <div
            className={`w-full max-w-sm overflow-hidden rounded-2xl border bg-osu-b4 shadow-[0_20px_70px_rgba(0,0,0,0.55)] ${
              failed ? "border-osu-red/45" : "border-osu-green/45"
            }`}
          >
            <div className="flex items-center gap-3 p-3.5">
              <motion.span
                initial={{ scale: 0.5 }}
                animate={{ scale: [0.5, 1.18, 1] }}
                transition={{ duration: 0.5, times: [0, 0.6, 1], ease: "easeOut" }}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ring-1 ${
                  failed ? "bg-osu-red/15 ring-osu-red/40" : "bg-osu-green/15 ring-osu-green/40"
                }`}
              >
                {failed
                  ? <TriangleAlert className="h-5 w-5 text-osu-red-light" />
                  : <Check className="h-5 w-5 text-osu-green-light" />}
              </motion.span>
              <div className="min-w-0 flex-1 text-[13.5px] font-bold text-white">{toast.message}</div>
              <button
                type="button"
                onClick={() => setToast(null)}
                aria-label="Dismiss"
                className="shrink-0 self-start rounded-md p-1 text-osu-f1/70 transition-colors hover:bg-osu-b3/60 hover:text-white cursor-pointer"
              >
                <span className="block text-[15px] leading-none" aria-hidden="true">×</span>
              </button>
            </div>
            <motion.div
              key={`bar-${toast.id}`}
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: (failed ? ERROR_MS : SUCCESS_MS) / 1000, ease: "linear" }}
              style={{ transformOrigin: "left" }}
              className={`h-0.5 ${failed ? "bg-osu-red/60" : "bg-osu-green/60"}`}
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
