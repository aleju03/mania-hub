import { useEffect, useState } from "react";
import { Trans } from "@lingui/react/macro";
import { useAuth } from "#/lib/auth-context";
import { canUseAdminFeatures } from "#/lib/auth-shared";
import { DEFAULT_COUNTRY_CODE } from "#/lib/country";
import { fetchDonationGoal, openLiveEventSource, type LiveDonationGoal } from "#/lib/live-backend";
import { useLocale } from "#/lib/locale-context";

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function monthName(month: string, locale: string): string {
  const [year, index] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, index - 1, 1)));
}

/* The monthly server-cost bar at the top of the support popup. Fetched when the
   popup opens, then moved by the country-less `donation_goal` event the
   backend puts on the live stream for every payment. Renders nothing until the
   first answer, and nothing at all when the backend is unreachable. Admin-only
   until the Ko-fi and lava.top webhooks are set up in production. */
export function SupportGoalBar() {
  const locale = useLocale();
  const admin = canUseAdminFeatures(useAuth());
  const [goal, setGoal] = useState<LiveDonationGoal | null>(null);

  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    void fetchDonationGoal().then((next) => {
      if (!cancelled && next) setGoal(next);
    });
    const source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
    const onGoal = (event: MessageEvent) => {
      try {
        setGoal(JSON.parse(event.data) as LiveDonationGoal);
      } catch {
        // Malformed frame: the next open fetches the truth.
      }
    };
    source?.addEventListener("donation_goal", onGoal);
    return () => {
      cancelled = true;
      source?.removeEventListener("donation_goal", onGoal);
    };
  }, [admin]);

  if (!admin || !goal || goal.goalUsdCents <= 0) return null;
  const fill = Math.min(1, Math.max(0, goal.raisedUsdCents / goal.goalUsdCents));
  const filling = monthName(goal.month, locale);
  const covered = goal.coveredThrough ? monthName(goal.coveredThrough, locale) : null;
  const raised = formatUsd(goal.raisedUsdCents);
  const target = formatUsd(goal.goalUsdCents);

  return (
    <div className="border-b border-white/[0.07] px-4 py-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-osu-f1">
          {covered ? (
            <>
              <span className="truncate">
                <Trans>Covered through {covered}</Trans>
              </span>
              <span aria-hidden="true" className="h-2.5 w-px shrink-0 bg-current opacity-60" />
            </>
          ) : null}
          <span className="shrink-0 font-semibold text-white">{filling}</span>
        </div>
        <span className="shrink-0 text-[13px] font-semibold tabular-nums text-white">
          <Trans>{raised} of {target}</Trans>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div className="h-full rounded-full bg-osu-pink transition-[width] duration-500" style={{ width: `${fill * 100}%` }} />
      </div>
    </div>
  );
}
