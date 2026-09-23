import { useId, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { LiveRecentRatingMissingReason } from "#/lib/live-backend";
import { OVERALL_AXIS_META } from "#/lib/skill-axes";
import { DanMark } from "./DanMark";
import type { RecentPlayRatingView } from "./recent-play-ratings";

export function RecentPlayRatingCells({ rating, keyCount, hideDan, compact = false }: {
  rating?: RecentPlayRatingView | null;
  keyCount: number;
  hideDan: boolean;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const dan = rating?.dan;
  const cell = compact ? "inline-flex items-center gap-1" : "flex w-[4.5rem] flex-col items-end justify-center gap-1 text-right";
  return <>
    {!hideDan && <div className={cell}>
      {dan ? <DanMark label={dan.label ?? dan.rawDan.toFixed(1)} keyCount={keyCount} side={dan.side} compact={compact} />
        : <RatingStatus axis={t`Dan`} reason={rating?.missing?.dan} rating={rating} compact={compact} />}
    </div>}
    <div className={cell}>
      {rating?.msd != null ? <>
        <span className={`${compact ? "text-xs" : "text-sm"} font-bold leading-none tabular-nums`} style={{ color: OVERALL_AXIS_META.color }}>{rating.msd.toFixed(2)}</span>
        <span className="text-[10px] font-semibold leading-none text-osu-f1">MSD</span>
      </> : <RatingStatus axis="MSD" reason={rating?.missing?.msd} rating={rating} compact={compact} />}
    </div>
  </>;
}

function RatingStatus({ axis, reason, rating, compact }: {
  axis: string;
  reason?: LiveRecentRatingMissingReason;
  rating?: RecentPlayRatingView | null;
  compact: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const id = useId();
  const loading = rating === undefined;
  const pending = reason === "pending" && rating?.pending === true;
  const label = loading ? t`Loading…` : rating?.loadError ? t`Retry` : pending ? t`Pending` : t`Unavailable`;
  const explanation = pending
    ? t`Analysis is scheduled. This rating will update here automatically when the result is ready. Some plays may not qualify for a rating.`
    : reason === "not_retained" ? t`This attempt has no saved MSD. Skill ratings keep selected plays, so a weaker repeat may have no rating.`
    : reason === "below_floor" ? t`This play is below the accuracy needed for an MSD rating.`
    : reason === "excluded" ? t`This play is excluded from skill ratings.`
    : reason === "failed_play" ? t`Failed plays do not receive an MSD rating.`
    : reason === "chart_changed" ? t`The chart changed after this play, so its rating cannot be verified.`
    : reason === "unsupported" ? t`A rating is not supported for this chart or mod combination.`
    : t`No rating is available, and no analysis is currently scheduled.`;
  if (loading) return <span className="text-[10px] leading-tight text-osu-f1" aria-label={`${axis}: ${label}`}>
    {label}<span className={compact ? "ml-1" : "mt-1 block"}>{axis}</span>
  </span>;
  return <span className="pointer-events-auto relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button
      type="button"
      aria-label={`${axis}: ${label}`}
      aria-describedby={open ? id : undefined}
      onClick={(event) => { event.stopPropagation(); if (rating?.loadError) rating.onRetry?.(); else setOpen(true); }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}
      className="rounded text-right text-[10px] leading-tight text-osu-f1 hover:text-osu-l2 focus-visible:outline-osu-pink-light"
    >
      {label}<span className={compact ? "ml-1" : "mt-1 block"}>{axis}</span>
    </button>
    {open && <span id={id} role="tooltip" className="absolute right-0 bottom-full z-30 mb-2 w-56 rounded-lg border border-osu-b2/50 bg-osu-b5 px-3 py-2 text-left text-xs leading-relaxed text-osu-l2 shadow-xl">
      {rating?.loadError ? t`Ratings could not be loaded. Tap Retry to try again.` : explanation}
    </span>}
  </span>;
}
