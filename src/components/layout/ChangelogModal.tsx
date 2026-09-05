import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion, stagger, useAnimate, useReducedMotion } from "framer-motion";
import { ChevronRight, X } from "lucide-react";

import { UPDATES, WIP, type ChangelogUpdate } from "#/data/changelog";
import { formatReleaseAge, groupUpdatesByDay } from "#/lib/changelog";
import { formatDate } from "#/lib/format";
import { useLingui } from "@lingui/react/macro";

const DAYS = groupUpdatesByDay(UPDATES);
/** Newest day only: it is the one the reader came for, and every other day
    stays a one-line row so the whole history fits without scrolling. */
const DEFAULT_OPEN_DAYS = DAYS.slice(0, 1).map((day) => day.date);

function UpdateText({ update }: { update: ChangelogUpdate }) {
  const reduceMotion = useReducedMotion();
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  const { text, emphasis } = update;
  const start = emphasis ? text.indexOf(emphasis) : -1;

  // Start the loop explicitly: the day's AnimatePresence disables initial
  // animations, which would also suppress a declarative loop on these letters.
  useEffect(() => {
    if (!scope.current) return;
    const animation = animate("span", {
      x: 0,
      y: reduceMotion ? 0 : [0, -1.5, 0],
      rotate: 0,
    }, reduceMotion ? { duration: 0 } : {
      duration: 1.8,
      delay: stagger(0.14),
      repeat: Infinity,
      ease: "easeInOut",
    });
    return () => animation.stop();
  }, [animate, emphasis, reduceMotion, scope, start]);

  const renderText = (value: string) => {
    const reference = update.reference;
    const referenceStart = reference ? value.indexOf(reference.text) : -1;
    if (!reference || referenceStart === -1) return value;
    return (
      <>
        {value.slice(0, referenceStart)}
        <a href={reference.href} target="_blank" rel="noopener noreferrer" className="text-osu-pink underline underline-offset-2 hover:text-osu-pink-light">
          {reference.text}
        </a>
        {value.slice(referenceStart + reference.text.length)}
      </>
    );
  };

  if (!emphasis || start === -1) return <>{renderText(text)}</>;

  return (
    <>
      {renderText(text.slice(0, start))}
      <strong className="inline-block whitespace-nowrap font-bold tracking-[0.04em] text-osu-c1">
        <span className="sr-only">{emphasis}</span>
        <span ref={scope} aria-hidden="true">
          {Array.from(emphasis).map((letter, index) => (
            <span key={index} className="inline-block">
              {letter}
            </span>
          ))}
        </span>
      </strong>
      {renderText(text.slice(start + emphasis.length))}
    </>
  );
}

export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLingui();
  const [openDays, setOpenDays] = useState<string[]>(DEFAULT_OPEN_DAYS);

  // Each visit starts from the newest day again: a day left open two sessions
  // ago is not a preference, it is leftover state.
  useEffect(() => {
    if (open) setOpenDays(DEFAULT_OPEN_DAYS);
  }, [open]);

  const toggleDay = useCallback((date: string) => {
    setOpenDays((current) =>
      current.includes(date) ? current.filter((value) => value !== date) : [...current, date],
    );
  }, []);

  useEffect(() => {
    if (!open) return;
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
            aria-label={t`Changelog`}
            initial={{ opacity: 0, y: 8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.99 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="modal-card-mobile-safe relative z-10 flex max-h-[min(560px,calc(100vh-2rem))] w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-osu-b3/50 px-4 py-3">
              <div className="text-sm font-bold text-white">{t`What's new`}</div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t`Close`}
                className="ml-auto cursor-pointer rounded-md p-1 text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              {DAYS.map((day) => {
                const expanded = openDays.includes(day.date);
                return (
                  <div key={day.date} className="border-b border-osu-b3/30 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleDay(day.date)}
                      aria-expanded={expanded}
                      className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-osu-b3/25"
                    >
                      <ChevronRight
                        className={`h-3.5 w-3.5 shrink-0 text-osu-f1 transition-transform duration-150 ${
                          expanded ? "rotate-90" : ""
                        }`}
                      />
                      {/* Age comes off the clock, so server and client can disagree by a day at
                          a UTC boundary; keep the server's text rather than letting a text
                          mismatch trigger a hydration recovery render. */}
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wider text-osu-c2/85"
                        title={formatDate(day.date)}
                        suppressHydrationWarning
                      >
                        {formatReleaseAge(day.date)}
                      </span>
                      <span className="ml-auto text-[11px] tabular-nums text-osu-f1">
                        {day.updates.length}
                      </span>
                    </button>

                    <AnimatePresence initial={false}>
                      {expanded ? (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.16, ease: "easeOut" }}
                          className="overflow-hidden"
                        >
                          <div className="pb-1.5">
                            {day.updates.map((update) => {
                              const row =
                                "flex items-baseline gap-2.5 py-1.5 pl-[2.375rem] pr-4 text-[13px] leading-snug text-osu-c2/85";
                              const bullet = (
                                <span className="mt-[-2px] size-1 shrink-0 rounded-full bg-osu-f1/60" />
                              );
                              if (!update.to || update.reference) {
                                return (
                                  <div key={update.text} className={row}>
                                    {bullet}
                                    <span className="min-w-0"><UpdateText update={update} /></span>
                                  </div>
                                );
                              }
                              return (
                                <Link
                                  key={update.text}
                                  to={update.to}
                                  search={update.search}
                                  onClick={onClose}
                                  className={`${row} transition-colors hover:bg-osu-b3/30 hover:text-white`}
                                >
                                  {bullet}
                                  <span className="min-w-0"><UpdateText update={update} /></span>
                                </Link>
                              );
                            })}
                          </div>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>

            {WIP.length > 0 ? (
              <div className="border-t border-osu-b3/50 bg-black/20 px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
                  working on next
                </div>
                <div className="mt-1 text-[12.5px] leading-relaxed text-osu-c2/80">
                  {WIP.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
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
