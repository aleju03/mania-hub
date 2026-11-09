import { useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";

import { SupportDaysPreview } from "./SupportDaysPreview";

type Plan = "monthly" | "once";

/* The two ways to support, side by side: a monthly subscription (the one
   that gets the most, so it comes first and is picked by default) and a
   one-time payment, with the days calculator. Both are paid on the Ko-fi
   panel; monthly is its "Make this monthly" box. */
export function SupportPlans() {
  const { t } = useLingui();
  const [plan, setPlan] = useState<Plan>("monthly");
  return (
    <div className="mt-5">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t`How to support`}>
        <PlanCard on={plan === "monthly"} onPick={() => setPlan("monthly")} title={t`Monthly`} price={t`$4 a month`} />
        <PlanCard on={plan === "once"} onPick={() => setPlan("once")} title={t`One-time`} price={t`Any amount`} />
      </div>
      {plan === "monthly" ? <MonthlyPerks /> : <SupportDaysPreview />}
    </div>
  );
}

function PlanCard({ on, onPick, title, price, note }: { on: boolean; onPick: () => void; title: string; price: string; note?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={`flex cursor-pointer flex-col items-start rounded-xl px-4 py-3 text-left transition-colors ${
        on ? "bg-osu-pink/15 ring-2 ring-inset ring-osu-pink" : "bg-osu-b4 ring-1 ring-inset ring-white/[0.06] hover:bg-osu-b3"
      }`}
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="text-[15px] font-bold text-white">{title}</span>
        {note ? <span className="text-[11px] font-semibold text-osu-pink-light">{note}</span> : null}
      </span>
      <span className="text-[12px] text-osu-l2">{price}</span>
    </button>
  );
}

/* What a subscription gets over paying once. */
function MonthlyPerks() {
  const { t } = useLingui();
  const perks: ReactNode[] = [
    t`Every supporter look, for as long as it renews.`,
    t`Your rank climbs a gem for every month in a row, all the way to Holo. If it lapses, it starts again at Amber.`,
    t`Your rank burns with a flame while your subscription renews.`,
    t`An extra gift code for a friend every third month, on top of the one every $4 brings. Time past 3 months ahead turns into more codes instead of piling up.`,
    t`At $10 a month or more, your rank's tooltip says Gold supporter.`,
  ];
  return (
    <div className="mt-3 rounded-xl bg-osu-b4 p-4 ring-1 ring-inset ring-white/[0.06]">
      <ul className="flex flex-col gap-2">
        {perks.map((perk, index) => (
          <li key={index} className="flex gap-2.5 text-[13px] leading-snug text-osu-l2">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-osu-pink" />
            <span>{perk}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] leading-relaxed text-osu-f1">{t`On the Ko-fi panel, tick "Make this monthly" before you pay. You can cancel any time on Ko-fi.`}</p>
    </div>
  );
}
