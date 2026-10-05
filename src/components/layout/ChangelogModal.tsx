import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion, stagger, useAnimate, useReducedMotion } from "framer-motion";
import { Bell, BellRing, ChevronLeft, ChevronRight, Search, X } from "lucide-react";

import { UPDATES, WIP, type ChangelogUpdate } from "#/data/changelog";
import {
  changelogKind,
  formatReleaseAge,
  groupUpdatesByDay,
  markChangelogSeen,
  type ChangelogKind,
} from "#/lib/changelog";
import { formatDate, intlLocaleTag } from "#/lib/format";
import { formatDateTime } from "#/lib/intl-formatters";
import { useLocale } from "#/lib/locale-context";
import type { AppLocale } from "#/lib/locale";
import { Trans, useLingui } from "@lingui/react/macro";
import { useAppStore, useChangelogNotify } from "#/store";

const DAYS = groupUpdatesByDay(UPDATES);
const NEWEST_DATE = DAYS[0]?.date ?? "";
const KINDS: ChangelogKind[] = ["new", "change", "fix"];
const KIND_DOT: Record<ChangelogKind, string> = {
  new: "bg-osu-pink",
  change: "bg-osu-blue",
  fix: "bg-osu-green-light",
};

/** Oldest first, so the strip reads left to right like time does. */
const STRIP = [...DAYS].reverse();
const BIGGEST_DAY = Math.max(1, ...DAYS.map((day) => day.updates.length));
const KIND_COUNTS = new Map(
  DAYS.map((day) => [
    day.date,
    KINDS.map((kind) => day.updates.filter((update) => changelogKind(update) === kind).length),
  ]),
);

/** "Oct 5", with the year only once the history reaches into another one. */
function formatShortDay(date: string, locale: AppLocale): string {
  const sameYear = date.slice(0, 4) === NEWEST_DATE.slice(0, 4);
  return formatDateTime(new Date(`${date}T00:00:00Z`), intlLocaleTag(locale), {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

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

  const renderBold = (value: string) => {
    const bold = update.bold;
    const boldStart = bold ? value.indexOf(bold) : -1;
    if (!bold || boldStart === -1) return value;
    return (
      <>
        {value.slice(0, boldStart)}
        <strong className="font-bold">{bold}</strong>
        {value.slice(boldStart + bold.length)}
      </>
    );
  };

  const renderLabel = (value: string) => {
    const label = update.label;
    const labelStart = label ? value.indexOf(label) : -1;
    if (!label || labelStart === -1) return renderBold(value);
    return (
      <>
        {renderBold(value.slice(0, labelStart))}
        <em>{label}</em>
        {renderBold(value.slice(labelStart + label.length))}
      </>
    );
  };

  const renderText = (value: string) => {
    const reference = update.reference;
    const referenceStart = reference ? value.indexOf(reference.text) : -1;
    if (!reference || referenceStart === -1) return renderLabel(value);
    return (
      <>
        {renderLabel(value.slice(0, referenceStart))}
        <a href={reference.href} target="_blank" rel="noopener noreferrer" className="text-osu-pink underline underline-offset-2 hover:text-osu-pink-light">
          {reference.text}
        </a>
        {renderLabel(value.slice(referenceStart + reference.text.length))}
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

/** Pink floods out from the bell when it turns on, and the bell swings once. */
function NotifyToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const { t } = useLingui();
  const reduceMotion = useReducedMotion();
  const [bell, animateBell] = useAnimate<HTMLSpanElement>();
  const ease = [0.3, 0, 0.2, 1] as const;

  const toggle = () => {
    const next = !on;
    onChange(next);
    if (next && !reduceMotion && bell.current) {
      void animateBell(bell.current, { rotate: [0, -24, 18, -12, 7, -3, 0] }, { duration: 0.75, ease: "easeOut" });
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={t`Notify me`}
      title={t`Shows a dot on the changelog link when there are new updates`}
      onClick={toggle}
      className={`relative ml-auto inline-flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full bg-osu-b3/70 pl-2.5 pr-3 text-[11px] font-semibold transition-[color,filter] duration-200 hover:brightness-110 ${
        on ? "text-white" : "text-osu-f1 hover:text-white"
      }`}
    >
      {/* Scaled rather than clip-path animated: a transform stays on the compositor, a clip-path repaints every frame. */}
      <motion.span
        aria-hidden="true"
        className="absolute left-[17px] top-1/2 -ml-[120px] -mt-[120px] size-[240px] rounded-full bg-osu-pink"
        initial={false}
        animate={{ scale: on ? 1 : 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.4, ease }}
      />
      <span ref={bell} aria-hidden="true" className="relative grid origin-[50%_15%] place-items-center">
        {on ? <BellRing className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
      </span>
      {/* Both labels share one cell so the pill keeps its width while they roll past each other. */}
      <span aria-hidden="true" className="relative grid overflow-hidden">
        <motion.span
          className="[grid-area:1/1]"
          initial={false}
          animate={{ y: on ? "-110%" : "0%" }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease }}
        >
          <Trans>Notify me</Trans>
        </motion.span>
        <motion.span
          className="[grid-area:1/1]"
          initial={false}
          animate={{ y: on ? "0%" : "110%" }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease }}
        >
          <Trans>Notifying</Trans>
        </motion.span>
      </span>
    </button>
  );
}

function KindDot({ kind }: { kind: ChangelogKind }) {
  return <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full ${KIND_DOT[kind]}`} />;
}

/** Bar height in px: a square-root-ish curve, so one huge release day does not flatten the rest. */
function barHeight(count: number): number {
  return Math.round(6 + Math.pow(count / BIGGEST_DAY, 0.7) * 38);
}

export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  const storedNotify = useChangelogNotify();
  const setChangelogNotify = useAppStore((state) => state.setChangelogNotify);
  // The toggle flips locally and reaches the store once its animation is over: any store
  // write re-serializes the whole persisted cache, which stalls a phone mid-animation.
  const [notify, setNotifyLocal] = useState(storedNotify);
  const notifyTimer = useRef<number | null>(null);
  useEffect(() => {
    if (notifyTimer.current === null) setNotifyLocal(storedNotify);
  }, [storedNotify]);
  // Says where the notification shows up, right after turning it on, until the modal closes.
  const [showNotifyHint, setShowNotifyHint] = useState(false);
  const setNotify = (next: boolean) => {
    // Turning it on counts what is already here as read, so the dot waits for the next update.
    if (next) markChangelogSeen();
    setNotifyLocal(next);
    setShowNotifyHint(next);
    if (notifyTimer.current !== null) window.clearTimeout(notifyTimer.current);
    notifyTimer.current = window.setTimeout(() => {
      notifyTimer.current = null;
      setChangelogNotify(next);
    }, 800);
  };

  const [selected, setSelected] = useState(NEWEST_DATE);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef(new Map<string, HTMLButtonElement>());

  // Each visit starts from the newest day with no search: a search left over
  // from last time would hide the update the reader came for.
  useEffect(() => {
    if (open) {
      setSelected(NEWEST_DATE);
      setQuery("");
      setSearching(false);
    } else setShowNotifyHint(false);
  }, [open]);

  // The newest bar sits at the right edge, which a narrow strip has scrolled out of view.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (stripRef.current) stripRef.current.scrollLeft = stripRef.current.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const result = new Map<string, ChangelogUpdate[]>();
    for (const day of DAYS) {
      const shown = needle ? day.updates.filter((update) => update.text.toLowerCase().includes(needle)) : day.updates;
      if (shown.length > 0) result.set(day.date, shown);
    }
    return result;
  }, [needle]);
  const reachable = DAYS.filter((day) => matches.has(day.date));
  const current = matches.has(selected) ? DAYS.find((day) => day.date === selected) : reachable[0];
  const position = current ? reachable.indexOf(current) : -1;
  const newer = reachable[position - 1];
  const older = reachable[position + 1];

  const select = (date: string) => {
    setSelected(date);
    detailRef.current?.scrollTo({ top: 0 });
    barRefs.current.get(date)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) {
        if (event.key === "Escape") {
          setQuery("");
          setSearching(false);
        }
        return;
      }
      if (event.key === "Escape") onClose();
      const target = event.key === "ArrowLeft" ? older : event.key === "ArrowRight" ? newer : undefined;
      if (target) {
        event.preventDefault();
        select(target.date);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!open) return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  const kindLabel: Record<ChangelogKind, string> = {
    new: t({ message: "New", context: "changelog kind" }),
    change: t`Changed`,
    fix: t`Fixed`,
  };
  const shown = current ? matches.get(current.date) ?? [] : [];

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
            className="modal-card-mobile-safe relative z-10 flex h-[min(720px,calc(100dvh-2rem))] w-[min(720px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
          >
            <div className="flex h-[52px] shrink-0 items-center gap-2 px-4">
              {searching ? (
                <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-osu-b6/70 px-2.5 text-osu-f1 focus-within:text-white">
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  <input
                    type="search"
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t`Search updates`}
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-osu-f1 [&::-webkit-search-cancel-button]:hidden"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setSearching(false);
                    }}
                    aria-label={t`Clear search`}
                    className="cursor-pointer text-osu-f1 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </label>
              ) : (
                <>
                  <div className="text-sm font-bold text-white">{t`What's new`}</div>
                  <button
                    type="button"
                    onClick={() => setSearching(true)}
                    aria-label={t`Search updates`}
                    className="cursor-pointer rounded-md p-1 text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
                  >
                    <Search className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              <NotifyToggle on={notify} onChange={setNotify} />
              <button
                type="button"
                onClick={onClose}
                aria-label={t`Close`}
                className="cursor-pointer rounded-md p-1 text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Only faded, never grown: animating its height reflowed the strip below on every frame. */}
            <AnimatePresence initial={false}>
              {showNotifyHint ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0 } }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="shrink-0 border-t border-white/[0.07]"
                >
                  <p className="px-4 py-2.5 text-[12px] leading-snug text-osu-c2/85">
                    <Trans>
                      A <span className="mx-0.5 inline-block h-1.5 w-1.5 rounded-full bg-osu-pink align-middle"><span className="sr-only">dot</span></span> shows next to <em>changelog</em> at the bottom of the page when there are new updates.
                    </Trans>
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {/* One bar per release day, oldest on the left, height by how much shipped, split by kind. */}
            <div
              ref={stripRef}
              className="shrink-0 overflow-x-auto overflow-y-hidden border-t border-white/[0.07] bg-osu-b5/40 px-4 pb-2 pt-7 [scrollbar-width:none]"
            >
              <div className="flex min-w-full gap-[3px]" role="listbox" aria-label={t`Release days`}>
                {STRIP.map((day, stripIndex) => {
                  const active = day.date === current?.date;
                  const available = matches.has(day.date);
                  const counts = KIND_COUNTS.get(day.date) ?? [0, 0, 0];
                  const total = counts.reduce((sum, value) => sum + value, 0);
                  const previous = STRIP[stripIndex - 1];
                  const newMonth = !previous || previous.date.slice(0, 7) !== day.date.slice(0, 7);
                  const edge = stripIndex < 3 ? "left-0" : stripIndex > STRIP.length - 4 ? "right-0" : "left-1/2 -translate-x-1/2";
                  return (
                    <button
                      key={day.date}
                      ref={(node) => {
                        if (node) barRefs.current.set(day.date, node);
                        else barRefs.current.delete(day.date);
                      }}
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-label={`${formatDate(day.date, "UTC", locale)}, ${total}`}
                      disabled={!available}
                      onClick={() => select(day.date)}
                      className="group relative flex h-[60px] min-w-[5px] flex-1 cursor-pointer flex-col justify-end disabled:cursor-default"
                    >
                      <span
                        className={`flex w-full flex-col-reverse overflow-hidden rounded-[2px] transition-opacity ${
                          active ? "opacity-100" : available ? "opacity-50 group-hover:opacity-85" : "opacity-10"
                        }`}
                        style={{ height: barHeight(total) }}
                      >
                        {KINDS.map((kind, kindIndex) =>
                          counts[kindIndex] > 0 ? (
                            <span key={kind} className={KIND_DOT[kind]} style={{ flexGrow: counts[kindIndex] }} />
                          ) : null,
                        )}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 h-0.5 w-full rounded-full ${active ? "bg-white" : "bg-transparent"}`}
                      />
                      <span
                        aria-hidden="true"
                        className={`absolute top-[60px] mt-1 whitespace-nowrap text-[11px] leading-none text-osu-f1 ${newMonth ? (stripIndex > STRIP.length - 4 ? "right-0" : "left-0") : "hidden"}`}
                      >
                        {newMonth
                          ? formatDateTime(new Date(`${day.date}T00:00:00Z`), intlLocaleTag(locale), { month: "short", timeZone: "UTC" })
                          : null}
                      </span>
                      {available ? (
                        <span
                          aria-hidden="true"
                          className={`pointer-events-none absolute -top-6 hidden whitespace-nowrap rounded bg-osu-b6 px-1.5 py-0.5 text-[11px] font-semibold text-white group-hover:block ${edge}`}
                        >
                          {formatShortDay(day.date, locale)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="h-4" />
            </div>

            <div ref={detailRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/[0.07] px-5 pb-8 pt-5 md:px-8 md:pt-6">
              {current ? (
                <>
                  <div className="flex items-baseline gap-2 text-[12px] text-osu-f1">
                    <span suppressHydrationWarning>{formatReleaseAge(current.date, Date.now(), locale)}</span>
                    {current.date === NEWEST_DATE ? (
                      <span className="font-semibold text-osu-pink">
                        <Trans context="changelog">Latest</Trans>
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-0.5 text-2xl font-bold text-white">{formatDate(current.date, "UTC", locale)}</h2>

                  {KINDS.map((kind) => {
                    const lines = shown.filter((update) => changelogKind(update) === kind);
                    if (lines.length === 0) return null;
                    return (
                      <section key={kind} className="mt-6">
                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                          <KindDot kind={kind} />
                          {kindLabel[kind]}
                          <span className="tabular-nums text-osu-f1/70">{lines.length}</span>
                        </div>
                        <div className="mt-1.5">
                          {lines.map((update) => {
                            const row = "group flex items-baseline gap-2 py-1.5 text-[14.5px] leading-relaxed text-osu-c2/90";
                            const image = update.image ? (
                              <img
                                src={update.image.src}
                                alt={update.image.alt}
                                width={update.image.width}
                                height={update.image.height}
                                loading="lazy"
                                decoding="async"
                                className="mb-3 mt-1.5 h-auto max-w-full rounded-lg"
                              />
                            ) : null;
                            if (!update.to || update.reference) {
                              return (
                                <div key={update.text}>
                                  <div className={row}>
                                    <span className="min-w-0 flex-1"><UpdateText update={update} /></span>
                                  </div>
                                  {image}
                                </div>
                              );
                            }
                            return (
                              <div key={update.text}>
                                <Link
                                  to={update.to}
                                  search={update.search}
                                  onClick={onClose}
                                  className={`${row} -mx-2 rounded-md px-2 transition-colors hover:bg-white/[0.04] hover:text-white`}
                                >
                                  <span className="min-w-0 flex-1"><UpdateText update={update} /></span>
                                  <ChevronRight className="relative top-[3px] h-3.5 w-3.5 shrink-0 self-start text-osu-f1 opacity-0 transition-opacity group-hover:opacity-100" />
                                </Link>
                                {image}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </>
              ) : (
                <p className="py-10 text-center text-[13px] text-osu-f1">
                  <Trans>No updates match.</Trans>
                </p>
              )}

              {WIP.length > 0 ? (
                <div className="mt-8 border-t border-white/[0.07] pt-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                    <Trans>working on next</Trans>
                  </div>
                  <div className="mt-1 text-[13px] leading-relaxed text-osu-c2/80">
                    {WIP.map((item) => (
                      <div key={item}>{item}</div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {current ? (
              <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.07] px-4 py-2.5">
                <button
                  type="button"
                  disabled={!older}
                  onClick={() => older && select(older.date)}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-osu-b3/60 pl-2 pr-3 text-[12px] font-semibold text-osu-c2 transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <Trans context="changelog">Older</Trans>
                  {older ? <span className="font-normal text-osu-f1">{formatShortDay(older.date, locale)}</span> : null}
                </button>
                <button
                  type="button"
                  disabled={!newer}
                  onClick={() => newer && select(newer.date)}
                  className="ml-auto inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-osu-b3/60 pl-3 pr-2 text-[12px] font-semibold text-osu-c2 transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
                >
                  {newer ? <span className="font-normal text-osu-f1">{formatShortDay(newer.date, locale)}</span> : null}
                  <Trans context="changelog">Newer</Trans>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
