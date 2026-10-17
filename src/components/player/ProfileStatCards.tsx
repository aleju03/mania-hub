import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Trans, useLingui } from "@lingui/react/macro";

import { formatNumber } from "#/lib/format";
import { DEFAULT_PROFILE_STATS, formatTopPercent, PROFILE_STAT_LABELS, PROFILE_STATS, type ProfileStatId, type ProfileStatsData } from "#/lib/profile-stats";
import { INSIGHT_CELL_CLASS, INSIGHT_LABEL_CLASS } from "./ProfileParts";

/* The insight cards a supporter can swap in for the usual four
   (lib/profile-stats.ts), and the owner's picker that swaps them. Same cell, label
   and number sizes as the usual four, so a swapped panel reads as one. */

function StatCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={INSIGHT_CELL_CLASS}>
      <div className={INSIGHT_LABEL_CLASS}>{label}</div>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="mt-2 text-sm text-osu-f1">-</div>;
}

export function formatRatio(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(value >= 10 ? 1 : 2);
}

export function RatioCard({ ratio }: { ratio: ProfileStatsData["ratio"] }) {
  const { t } = useLingui();
  return (
    <StatCell label={t`Ratio`}>
      {ratio ? (
        <>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-[26px] font-black leading-none tabular-nums text-white">
              {ratio.great === 0 ? t`All MAX` : formatRatio(ratio.perfect / ratio.great)}
            </span>
            {ratio.great > 0 && <span className="text-[13px] font-bold text-osu-f1">: 1</span>}
          </div>
          <div className="mt-auto pt-2.5 text-[11px] text-osu-f1">{t`MAX to 300 over every tracked play`}</div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function LnSplitCard({ lnSplit }: { lnSplit: ProfileStatsData["lnSplit"] }) {
  const { t } = useLingui();
  const total = lnSplit ? lnSplit.ln + lnSplit.rice : 0;
  const lnShare = total > 0 ? Math.round((lnSplit!.ln / total) * 100) : 0;
  const riceLeads = lnShare < 50;
  return (
    <StatCell label={t`Rice / LN`}>
      {lnSplit && total > 0 ? (
        <>
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="flex items-baseline gap-1">
              <span className={`font-black leading-none tabular-nums text-osu-blue ${riceLeads ? "text-[26px]" : "text-[17px]"}`}>
                {100 - lnShare}<span className="text-[13px]">%</span>
              </span>
              <span className="text-[11px] font-bold text-osu-blue">{t`rice`}</span>
            </span>
            <span className="flex items-baseline gap-1">
              <span className={`font-black leading-none tabular-nums text-osu-orange ${riceLeads ? "text-[17px]" : "text-[26px]"}`}>
                {lnShare}<span className="text-[13px]">%</span>
              </span>
              <span className="text-[11px] font-bold text-osu-orange">{t`LN`}</span>
            </span>
          </div>
          <div className="mt-auto w-full pt-3">
            <div className="flex h-1 overflow-hidden rounded-full bg-osu-b3/50">
              <div className="bg-osu-blue" style={{ width: `${100 - lnShare}%` }} />
              <div className="bg-osu-orange" style={{ width: `${lnShare}%` }} />
            </div>
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function StreakCard({ streak }: { streak: ProfileStatsData["streak"] }) {
  const { t } = useLingui();
  return (
    <StatCell label={t`Longest streak`}>
      {streak && streak.longest > 0 ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-black leading-none tabular-nums text-white">{formatNumber(streak.longest)}</span>
            <span className="text-[11px] font-semibold text-osu-f1">{streak.longest === 1 ? t`day` : t`days`}</span>
          </div>
          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
            {streak.current > 0 ? <Trans>{formatNumber(streak.current)} going now</Trans> : t`In a row, with a play each day`}
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function PercentileCard({ percentile }: { percentile: ProfileStatsData["percentile"] }) {
  const { t } = useLingui();
  const top = percentile ? formatTopPercent(percentile.rank, percentile.players) : null;
  return (
    <StatCell label={t`Percentile`}>
      {percentile && top ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold text-osu-f1">{t`top`}</span>
            <span className="text-[26px] font-black leading-none tabular-nums text-osu-pink-light">{top}<span className="text-[15px]">%</span></span>
          </div>
          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
            <Trans>#{formatNumber(percentile.rank)} of {formatNumber(percentile.players)} tracked players</Trans>
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

/* What the four extra stats would show, for the picker. */
export function useExtraStatPreviews(data: ProfileStatsData): Partial<Record<ProfileStatId, string | null>> {
  const { t } = useLingui();
  const { ratio, lnSplit, streak, percentile } = data;
  const lnTotal = lnSplit ? lnSplit.ln + lnSplit.rice : 0;
  const top = percentile ? formatTopPercent(percentile.rank, percentile.players) : null;
  return {
    ratio: ratio ? (ratio.great === 0 ? t`All MAX` : `${formatRatio(ratio.perfect / ratio.great)} : 1`) : null,
    lnSplit: lnSplit && lnTotal > 0 ? t`${Math.round((lnSplit.ln / lnTotal) * 100)}% LN` : null,
    streak: streak ? t`${streak.longest} days` : null,
    percentile: top ? t`top ${top}%` : null,
  };
}

/* Two arrows passing each other, for the owner's swap button. */
function SwapIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M2.5 5.2h9.6M9.6 2.6l2.6 2.6-2.6 2.6" />
      <path d="M13.5 10.8H3.9M6.4 8.2l-2.6 2.6 2.6 2.6" />
    </svg>
  );
}

/* The owner's way to change one card: a small button in its corner (dim
   until the card is pointed at) that opens a list of every stat with what it would show.
   Picking one already shown in another card swaps the two. The list is
   portalled, since the panel clips its cells. */
export function ProfileStatPicker({ slot, slots, previews, onChange, variant = "corner", disabled = false }: {
  slot: number;
  slots: readonly ProfileStatId[];
  previews: Partial<Record<ProfileStatId, string | null>>;
  onChange: (next: ProfileStatId[]) => void;
  /** "corner" sits in a profile card's corner; "field" is a full-width row naming the stat (the /supporter page). */
  variant?: "corner" | "field";
  disabled?: boolean;
}) {
  const { t, i18n } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left?: number; right?: number; width?: number } | null>(null);
  const current = slots[slot];
  const isDefault = slots.every((stat, index) => stat === DEFAULT_PROFILE_STATS[index]);

  useEffect(() => {
    if (!anchor) return;
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "pointerdown" && (menuRef.current?.contains(event.target as Node) || buttonRef.current?.contains(event.target as Node))) return;
      setAnchor(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);

  const toggle = () => {
    if (anchor) return setAnchor(null);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (variant === "field") setAnchor({ top: rect.bottom + 6, left: rect.left, width: Math.max(240, rect.width) });
    else setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right - 8) });
  };

  const pick = (stat: ProfileStatId) => {
    setAnchor(null);
    if (stat === current) return;
    const next = [...slots];
    const other = next.indexOf(stat);
    if (other >= 0) next[other] = current;
    next[slot] = stat;
    onChange(next);
  };

  return (
    <>
      {variant === "field" ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-expanded={anchor !== null}
          className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors disabled:cursor-default disabled:opacity-50 ${anchor ? "bg-osu-b3" : "bg-osu-b4 hover:bg-osu-b3/70"}`}
        >
          <span className="w-4 shrink-0 text-[11px] font-bold tabular-nums text-osu-f1">{slot + 1}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">{i18n._(PROFILE_STAT_LABELS[current])}</span>
          {previews[current] && <span className="shrink-0 text-[12px] tabular-nums text-osu-f1">{previews[current]}</span>}
          <SwapIcon className="h-3.5 w-3.5 shrink-0 text-osu-f1" />
        </button>
      ) : (
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={t`Change this stat`}
        aria-expanded={anchor !== null}
        className={`absolute right-[26px] top-[9px] z-10 grid h-6 w-6 cursor-pointer place-items-center rounded-md text-osu-f1 transition-[opacity,color,background-color] hover:bg-osu-b3/60 hover:text-white focus-visible:opacity-100 ${anchor ? "bg-osu-b3/60 text-white opacity-100" : "opacity-60 group-hover/stat:opacity-100"}`}
      >
        <SwapIcon className="h-3.5 w-3.5" />
      </button>
      )}
      {anchor && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ top: anchor.top, left: anchor.left, right: anchor.right, width: anchor.width }}
          className="fixed z-[80] w-60 overflow-hidden rounded-lg border border-osu-b2/60 bg-osu-b4 py-1 text-[12px] shadow-2xl"
        >
          {PROFILE_STATS.map((stat) => {
            const shownAt = slots.indexOf(stat);
            const selected = stat === current;
            return (
              <button
                key={stat}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => pick(stat)}
                className={`flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left transition-colors ${selected ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-l2 hover:bg-osu-b3/60 hover:text-white"}`}
              >
                <span className="min-w-0 flex-1 truncate font-semibold">{i18n._(PROFILE_STAT_LABELS[stat])}</span>
                {!selected && shownAt >= 0 && <span className="shrink-0 text-[10px] text-osu-f1">{t`swap`}</span>}
                {stat in previews && <span className={`shrink-0 tabular-nums ${selected ? "text-osu-pink-light/80" : "text-osu-f1"}`}>{previews[stat] ?? "-"}</span>}
              </button>
            );
          })}
          {!isDefault && (
            <button
              type="button"
              onClick={() => {
                setAnchor(null);
                onChange([...DEFAULT_PROFILE_STATS]);
              }}
              className="mt-1 w-full cursor-pointer border-t border-osu-b3/50 px-3 pb-1 pt-2 text-left text-[11px] text-osu-f1 transition-colors hover:text-white"
            >
              {t`Back to the usual four`}
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
