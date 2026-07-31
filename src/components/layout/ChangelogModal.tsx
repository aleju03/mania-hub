import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

import { UPDATES, WIP } from "#/data/changelog";
import { formatReleaseAge, markChangelogSeen } from "#/lib/changelog";
import { formatDate } from "#/lib/format";

export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    // Opening the modal is the read receipt the footer dot waits on.
    markChangelogSeen();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/65"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Changelog"
            initial={{ opacity: 0, y: 8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.99 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="modal-card-mobile-safe relative z-10 flex max-h-[min(560px,calc(100vh-2rem))] w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-osu-b3/50 px-4 py-3">
              <div className="text-sm font-bold text-white">What&apos;s new</div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="ml-auto cursor-pointer rounded-md p-1 text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
              {UPDATES.map((update) => {
                const when = (
                  /* Age comes off the clock, so server and client can disagree by a day at
                     a UTC boundary; keep the server's text rather than letting a text
                     mismatch trigger a hydration recovery render. */
                  <span
                    className="w-[74px] shrink-0 text-[11px] text-osu-f1"
                    title={formatDate(update.date)}
                    suppressHydrationWarning
                  >
                    {formatReleaseAge(update.date)}
                  </span>
                );
                const row = "flex items-baseline gap-3 px-4 py-2 text-[13px] leading-snug";
                if (!update.to) {
                  return (
                    <div key={update.text} className={`${row} text-osu-c2/85`}>
                      {when}
                      <span className="min-w-0">{update.text}</span>
                    </div>
                  );
                }
                return (
                  <Link
                    key={update.text}
                    to={update.to}
                    onClick={onClose}
                    className={`${row} text-osu-c2/85 transition-colors hover:bg-osu-b3/30 hover:text-white`}
                  >
                    {when}
                    <span className="min-w-0">{update.text}</span>
                  </Link>
                );
              })}
            </div>

            {WIP.length > 0 ? (
              <div className="border-t border-osu-b3/50 bg-black/20 px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
                  working on next
                </div>
                <div className="mt-1 text-[12.5px] leading-relaxed text-osu-c2/80">
                  {WIP.join(" · ")}
                </div>
              </div>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
