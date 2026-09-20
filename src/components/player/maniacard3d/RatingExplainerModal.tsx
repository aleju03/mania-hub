import { useLingui } from "@lingui/react/macro";
import { motion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MANIA_CARD_TIER_THRESHOLDS, MANIA_TIER_STYLES, getManiaCardTier, type ManiaCardTier, type NextManiaCardTier } from "#/lib/maniacard";
import { useBodyScrollLock } from "#/lib/use-body-scroll-lock";
import { ManiacardHistory } from "./ManiacardHistory";

export const TIER_TEXT_COLOR: Record<string, string> = {
  common: "text-slate-200",
  rare: "text-sky-200",
  elite: "text-violet-200",
  superRare: "text-fuchsia-200",
  ultraRare: "text-rose-200",
  legendary: "text-yellow-100",
  mythic: "text-red-200",
  ascendant: "text-white",
  worldClass: "text-emerald-200",
  eternal: "text-purple-200",
  goat: "text-amber-200",
};

export const TIER_FILL_COLOR: Record<string, string> = {
  common: "rgb(148, 163, 184)",
  rare: "rgb(56, 189, 248)",
  elite: "rgb(167, 139, 250)",
  superRare: "rgb(232, 121, 249)",
  ultraRare: "rgb(251, 113, 133)",
  legendary: "rgb(251, 191, 36)",
  mythic: "rgb(248, 113, 113)",
  ascendant: "rgb(226, 232, 240)",
  worldClass: "rgb(110, 231, 183)",
  eternal: "rgb(192, 132, 252)",
  goat: "rgb(251, 191, 36)",
};

// Full tier ladder (lowest -> highest), derived from the shared thresholds so
// it never drifts from getManiaCardTier. Common has no threshold of its own.
const TIER_LADDER: Array<{ tier: ManiaCardTier; min: number }> = [
  { tier: "common", min: 0 },
  ...MANIA_CARD_TIER_THRESHOLDS.map(({ tier, threshold }) => ({ tier, min: threshold })),
];

export function RatingExplainerModal({
  userId,
  nextTier,
  cardRating,
  isOwnProfile,
  onClose,
}: {
  userId: number;
  nextTier: NextManiaCardTier | null;
  cardRating: number;
  isOwnProfile: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"rank" | "progression">("rank");
  const [historyOpened, setHistoryOpened] = useState(false);
  const currentTier = getManiaCardTier(cardRating);
  const toColor = TIER_FILL_COLOR[nextTier?.tier ?? currentTier];
  const pct = Math.round((nextTier?.progress ?? 1) * 100);
  useBodyScrollLock(true);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === "Tab") {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [])]
          .filter((element) => !element.closest("[hidden]") && element.tabIndex >= 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // Highest tier at the top, so the ladder reads like an in-game rank ladder.
  const rungs = [...TIER_LADDER].reverse();

  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer py-4 pl-4 pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-card-mobile-safe relative isolate flex h-[min(720px,calc(100dvh-2rem))] flex-col bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[520px] max-w-full overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <div className="pointer-events-none absolute inset-0 bg-osu-b4" aria-hidden="true" />
        <button
          type="button"
          onClick={onClose}
          aria-label={t`Close`}
          className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>
        <header className="relative z-10 shrink-0 px-5 pt-5 pb-3 sm:px-6">
          <h2 id={titleId} className="text-[11px] uppercase tracking-wider text-osu-f1 font-semibold">{t`Maniacard`}</h2>
          <div className="mt-3 flex items-end justify-between gap-3">
            <div className="flex items-baseline gap-2.5">
              <span className="text-4xl font-bold text-white tabular-nums">{cardRating}</span>
              <span className={`text-xs font-semibold ${TIER_TEXT_COLOR[currentTier]}`}>{MANIA_TIER_STYLES[currentTier].label}</span>
            </div>
            {nextTier ? <span className="pb-1 text-xs text-osu-f1">
              <span className="font-bold tabular-nums" style={{ color: toColor }}>+{nextTier.remaining}</span>{" "}
              <span className="text-osu-f1">{t`to`}</span>{" "}
              <span className={`font-semibold ${TIER_TEXT_COLOR[nextTier.tier] ?? "text-osu-l2"}`}>{nextTier.label}</span>
            </span> : null}
          </div>
        </header>
        <div role="tablist" aria-label={t`Maniacard details`} className="relative z-10 flex shrink-0 gap-5 border-b border-osu-b3/40 px-5 sm:px-6">
          {(["rank", "progression"] as const).map((value) => (
            <button key={value} type="button" role="tab" id={`${titleId}-${value}-tab`} aria-selected={tab === value} aria-controls={`${titleId}-${value}`} tabIndex={tab === value ? 0 : -1}
              onClick={() => { setTab(value); if (value === "progression") setHistoryOpened(true); }}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? "rank" : event.key === "End" ? "progression" : value === "rank" ? "progression" : "rank";
                setTab(next);
                if (next === "progression") setHistoryOpened(true);
                document.getElementById(`${titleId}-${next}-tab`)?.focus();
              }}
              className={`-mb-px cursor-pointer border-b-2 py-3 text-[13px] font-semibold transition-colors focus-visible:outline-osu-pink-light ${tab === value ? "border-osu-pink-light text-osu-l1" : "border-transparent text-osu-f1 hover:text-white"}`}
            >{value === "rank" ? t`Card rank` : t`Progression`}</button>
          ))}
        </div>
        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5 [scrollbar-gutter:stable]">
          <div role="tabpanel" id={`${titleId}-rank`} aria-labelledby={`${titleId}-rank-tab`} hidden={tab !== "rank"}>
            <div className="relative">
              {/* Spine connecting the rungs. */}
              <div className="pointer-events-none absolute left-[15px] top-4 bottom-4 w-px bg-osu-b3/40" aria-hidden="true" />
              <div className="relative space-y-0.5">
                {rungs.map((rung) => {
                  const fill = TIER_FILL_COLOR[rung.tier] ?? "rgb(148, 163, 184)";
                  const achieved = cardRating >= rung.min;
                  const isCurrent = rung.tier === currentTier;

                  return (
                    <div
                      key={rung.tier}
                      className={`relative flex items-center gap-3 rounded-lg py-2 pr-3 pl-2 ${isCurrent ? "bg-osu-b3/40" : ""}`}
                    >
                      <div className="relative z-10 flex w-[11px] justify-center">
                        <span
                          className="block rounded-full"
                          style={
                            isCurrent
                              ? { width: 13, height: 13, backgroundColor: fill, boxShadow: "0 0 0 4px rgba(255,255,255,0.1)" }
                              : achieved
                                ? { width: 9, height: 9, backgroundColor: fill }
                                : { width: 9, height: 9, backgroundColor: "transparent", border: "1.5px solid rgba(148,163,184,0.35)" }
                          }
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[13px] font-semibold ${
                              isCurrent
                                ? TIER_TEXT_COLOR[rung.tier] ?? "text-white"
                                : achieved
                                  ? "text-osu-f1"
                                  : "text-osu-f1/45"
                            }`}
                          >
                            {MANIA_TIER_STYLES[rung.tier].label}
                          </span>
                          {isCurrent && isOwnProfile && (
                            <span className="rounded-full bg-white/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white">
                              {t`You`}
                            </span>
                          )}
                        </div>
                        {isCurrent && nextTier && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-osu-b3/50">
                              <div
                                className="h-full rounded-full transition-[width] duration-500"
                                style={{ width: `${Math.max(3, pct)}%`, backgroundColor: toColor }}
                              />
                            </div>
                            <span className="text-[10px] font-semibold tabular-nums" style={{ color: toColor }}>
                              {pct}%
                            </span>
                          </div>
                        )}
                      </div>
                      <span className={`text-[11px] tabular-nums ${achieved ? "text-osu-f1/70" : "text-osu-f1/40"}`}>
                        {rung.min}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <p className="mt-4 text-[11px] leading-snug text-osu-f1/55">
              {t`Rank is set by ${isOwnProfile ? t`your` : t`the player's`} top mania plays: mostly pp standing, plus control, speed, precision and stamina traits.`}
            </p>
          </div>
          <div role="tabpanel" id={`${titleId}-progression`} aria-labelledby={`${titleId}-progression-tab`} hidden={tab !== "progression"}>
            {historyOpened && <ManiacardHistory userId={userId} />}
          </div>
        </div>
      </motion.div>
    </motion.div>, document.body,
  );
}
