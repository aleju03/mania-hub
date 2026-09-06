import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight, History, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  fetchLivePlayerSkillHistoryDirect,
  type LivePlayerSkillHistoryEntry,
  type LivePlayerSkillHistorySnapshot,
} from "../../lib/live-backend";
import { skillAxisMeta } from "../../lib/skill-axes";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { useLocale } from "../../lib/locale-context";
import { useNoDans } from "../../store";
import { Skeleton } from "../ui/LoadingSkeleton";
import { makeSkillHistoryPreview } from "./skill-history-preview";
import { groupSkillHistoryByDay, loadSkillHistoryDays } from "./skill-history-days";

const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_54px_80px_12px] items-center gap-2 px-4";

export function SkillHistoryModal({ userId, keyCount, onClose }: {
  userId: number; keyCount: number; onClose: () => void;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [items, setItems] = useState<LivePlayerSkillHistoryEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<LivePlayerSkillHistoryEntry[] | null>(null);
  const reduceMotion = useReducedMotion();
  const visibleItems = preview ?? items;
  const visibleDays = groupSkillHistoryByDay(visibleItems);
  const visibleLoading = loading && !preview;
  const visibleError = error && !preview;
  useBodyScrollLock(true);

  const loadPage = async (before?: number) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(false);
    try {
      const page = await loadSkillHistoryDays(async (cursor) => {
        controller.signal.throwIfAborted();
        return fetchLivePlayerSkillHistoryDirect(userId, keyCount, { before: cursor, signal: controller.signal });
      }, before);
      if (controller.signal.aborted) return;
      setItems((current) => before ? [...current, ...page.items] : page.items);
      setNextBefore(page.nextBefore);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    void loadPage();
    return () => controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === "Tab") {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/65 py-4 pl-4 pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.15 }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.99 }}
        transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
        className="modal-card-mobile-safe relative flex max-h-[min(560px,calc(100dvh-2rem))] w-full max-w-[460px] flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 text-osu-l2 shadow-2xl"
      >
        <header className="flex shrink-0 items-center gap-2.5 border-b border-osu-b3/50 px-4 py-3">
          <History className="h-3.5 w-3.5 text-osu-pink-light" aria-hidden="true" />
          <h2 id={titleId} className="text-[13px] font-bold text-white"><Trans>{keyCount}K skill history</Trans></h2>
          {preview ? <span className="text-[10px] text-osu-yellow">DEV</span> : null}
          <button type="button" autoFocus onClick={onClose} aria-label={t`Close`} className="ml-auto cursor-pointer rounded-md p-1 text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className={`${ROW_GRID} shrink-0 border-b border-osu-b3/30 py-2 text-[10px] font-semibold uppercase tracking-wider text-osu-f1`}>
          <span><Trans>Date</Trans></span><span className="text-right"><Trans>Rating</Trans></span><span className="text-right"><Trans context="skill rating difference">Change</Trans></span>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain py-1">
          {visibleItems.length > 0 ? (
            <ol>{visibleDays.map((entry) => <HistoryEntry key={`${preview ? "preview" : "real"}:${entry.day}`} entry={entry} />)}</ol>
          ) : !visibleLoading && !visibleError ? (
            <p className="px-4 py-8 text-center text-[12px] text-osu-f1"><Trans>No skill ratings have been recorded yet.</Trans></p>
          ) : null}
          {visibleLoading ? (
            <div role="status" aria-label={t`Loading history…`}>
              {Array.from({ length: visibleItems.length ? 2 : 6 }, (_, index) => (
                <div key={index} className={`${ROW_GRID} py-3`} aria-hidden="true">
                  <Skeleton className="h-3 w-24 max-w-full" /><Skeleton className="ml-auto h-3 w-10" /><Skeleton className="ml-auto h-3 w-10" />
                </div>
              ))}
            </div>
          ) : visibleError ? (
            <div role="alert" className="px-4 py-5 text-center text-[12px] text-osu-f1">
              <p><Trans>Could not load skill history.</Trans></p>
              <button type="button" onClick={() => void loadPage(items.length ? nextBefore ?? undefined : undefined)} className="mt-2 cursor-pointer text-osu-pink-light hover:text-white"><Trans>Try again</Trans></button>
            </div>
          ) : !preview && nextBefore != null ? (
            <button type="button" onClick={() => void loadPage(nextBefore)} className="w-full cursor-pointer py-3 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/25 hover:text-white"><Trans>Load older changes</Trans></button>
          ) : null}
        </div>
        {visibleItems.at(-1)?.previous === null || import.meta.env.DEV ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-osu-b3/40 px-4 py-2 text-[10px] text-osu-f1">
            <span>{visibleItems.at(-1)?.previous === null ? <Trans>Earlier changes weren’t recorded.</Trans> : null}</span>
            {import.meta.env.DEV ? (
              <button
                type="button"
                onClick={() => setPreview((current) => current ? null : makeSkillHistoryPreview(keyCount, items[0]?.snapshot))}
                className="ml-auto cursor-pointer text-osu-pink-light/80 transition-colors hover:text-white"
              >
                {preview ? "Show real history" : "DEV · Simulate history"}
              </button>
            ) : null}
          </footer>
        ) : null}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function signedChange(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function changeColor(value: number): string {
  return value > 0 ? "text-osu-green-light" : value < 0 ? "text-osu-red-light" : "text-osu-f1";
}

function HistoryEntry({ entry }: { entry: LivePlayerSkillHistoryEntry & { day: string } }) {
  const { i18n, t } = useLingui();
  const locale = useLocale();
  const noDans = useNoDans();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { snapshot, previous } = entry;
  const overall = snapshot.ratings.Overall ?? 0;
  const delta = previous ? Number((overall - (previous.ratings.Overall ?? 0)).toFixed(2)) : 0;
  const axes = previous ? Array.from(new Set([...Object.keys(snapshot.ratings), ...Object.keys(previous.ratings)]))
    .filter((axis) => axis !== "Overall" && snapshot.ratings[axis] !== previous.ratings[axis]) : [];
  const formatDan = (side: LivePlayerSkillHistorySnapshot["dan"]["rc"]) => side ? `${side.beyondTable ? "> " : ""}${side.label}` : "—";
  const danSides = previous && !noDans ? (["rc", "ln"] as const)
    .filter((side) => formatDan(snapshot.dan[side]) !== formatDan(previous.dan[side])) : [];
  const hasDetails = axes.length > 0 || danSides.length > 0;
  const date = new Date(entry.recordedAt);
  const row = (
    <>
      <time dateTime={entry.day} title={date.toLocaleDateString(locale, { dateStyle: "long" })} className="text-[11px] text-osu-l2">
        <span>{date.toLocaleDateString(locale, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) })}</span>
      </time>
      <span className="text-right text-[12px] font-semibold text-osu-l1 tabular-nums">{overall.toFixed(2)}</span>
      <span className={`text-right text-[12px] font-semibold tabular-nums ${changeColor(delta)}`}>
        {previous ? delta === 0 ? "—" : signedChange(delta) : <span className="text-[10px] font-normal"><Trans>Starting rating</Trans></span>}
      </span>
      {hasDetails ? <ChevronRight className={`h-3 w-3 text-osu-f1 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} aria-hidden="true" /> : <span />}
    </>
  );
  return (
    <li>
      {hasDetails ? (
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={detailsId} className={`${ROW_GRID} w-full cursor-pointer py-2.5 text-left transition-colors hover:bg-osu-b3/25`}>
          {row}
        </button>
      ) : <div className={`${ROW_GRID} py-2.5`}>{row}</div>}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div id={detailsId} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <div className="flex flex-wrap gap-x-4 gap-y-1 bg-osu-b5/30 px-4 py-2 text-[11px]">
              {axes.map((axis) => {
                const meta = skillAxisMeta(axis);
                const value = snapshot.ratings[axis];
                const old = previous!.ratings[axis];
                const change = value != null && old != null ? Number((value - old).toFixed(2)) : null;
                return (
                  <span key={axis} className="inline-flex gap-1.5">
                    <span className="text-osu-f1">{meta ? i18n._(meta.labelMsg) : axis}</span>
                    <span className={`font-semibold tabular-nums ${change != null ? changeColor(change) : "text-osu-l2"}`}>
                      {change != null ? signedChange(change) : value != null ? t`new` : "—"}
                    </span>
                  </span>
                );
              })}
              {danSides.map((side) => (
                <span key={side} className="inline-flex gap-1.5">
                  <span className="text-osu-f1">{side === "rc" ? t`Regular dan` : t`LN dan`}</span>
                  <span className="text-osu-l2">{formatDan(previous!.dan[side])} → {formatDan(snapshot.dan[side])}</span>
                </span>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
