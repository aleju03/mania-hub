import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { useBodyScrollLock } from "#/lib/use-body-scroll-lock";

/* The pack surface's modal: a sheet on phones, a centered card everywhere
   else, same chrome as the showcase picker so a panel opened from the
   collection toolbar reads as part of the page it came from.

   Escape closes, focus returns to whatever opened it, and the close is
   animated by keeping the card mounted until its exit finishes, so callers
   can keep rendering it behind a plain boolean. */
const WIDTHS = {
  sm: "sm:max-w-[460px]",
  md: "sm:max-w-[620px]",
  lg: "sm:max-w-[860px]",
} as const;

export function PackDialog({ title, subtitle, children, onClose, busy = false, width = "md", layer = "default" }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  width?: keyof typeof WIDTHS;
  /* Managers can open the existing card picker (90) and spotlight (120). */
  layer?: "default" | "below-cards";
}) {
  const { t } = useLingui();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  useBodyScrollLock(true);

  const requestClose = useCallback(() => {
    if (!busy) setLeaving(true);
  }, [busy]);

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={onClose}>
      {!leaving && (
        <motion.div
          key="pack-dialog"
          className={`fixed inset-x-0 top-0 ${layer === "below-cards" ? "z-[80]" : "z-[140]"} flex h-[100dvh] min-h-0 items-end justify-center overscroll-none bg-black/70 p-0 sm:items-center sm:p-6`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={(event) => {
            if (event.target === event.currentTarget) requestClose();
          }}
        >
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, y: 14, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.17, ease: "easeOut" }}
            className={`modal-card-mobile-safe flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-osu-b3/30 bg-osu-b5 outline-none sm:max-h-[min(660px,calc(100dvh-3rem))] sm:rounded-2xl ${WIDTHS[width]}`}
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-osu-b3/30 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div id={titleId} className="text-[13px] font-bold text-white">{title}</div>
                {subtitle != null && <div className="mt-0.5 text-[11px] text-osu-f1">{subtitle}</div>}
              </div>
              <button
                type="button"
                onClick={requestClose}
                disabled={busy}
                aria-label={t`Close`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white disabled:opacity-40"
              >
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] [scrollbar-gutter:stable]">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
