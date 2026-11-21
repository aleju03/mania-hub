import { useEffect, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";

import { SUPPORTER_RANKS } from "../../lib/supporter-ranks";
import { FrameThumb } from "./LoadoutSlots";
import { SupportDaysPreview } from "./SupportDaysPreview";
import { RankGem, SupporterRankIcon } from "./SupporterRankBadge";
import { useShowcaseViewer } from "./SupportShowcase";
import type { SupportMethod } from "./SupportCheckout";

type Plan = "monthly" | "once";

/* How long the monthly card's gem stays on each rank as it climbs. */
const CLIMB_MS = 2400;
const GOLD = SUPPORTER_RANKS.find((rank) => rank.id === "gold") ?? SUPPORTER_RANKS[0];

/* The two ways to support, side by side: a monthly subscription (the one
   that gets the most, so it comes first and is picked by default) and a
   one-time payment, with the days calculator. Monthly's gem burns and climbs
   the twelve ranks, as a subscriber's does, and the ladder under it lifts the
   rank it is on. Both are paid on the checkout beside this. Patreon and
   lava.top only sell a membership, so One-time can't be picked while one of
   them is the method, and crypto only sells one-off packs, so Monthly
   can't be with it; Google takes a one-off but only in set amounts, which
   the plan says. */
export function SupportPlans({ method }: { method: SupportMethod | null }) {
  const { t } = useLingui();
  const [picked, setPlan] = useState<Plan>("monthly");
  const index = useClimbingRank();
  const rank = SUPPORTER_RANKS[index];
  const noOnce = method === "patreon" ? t`Not on Patreon` : method === "lava" ? t`Not on lava.top` : null;
  const noMonthly = method === "crypto" ? t`Not with crypto` : null;
  // The pick is kept, so it comes back with a method that takes it.
  const plan: Plan = noOnce ? "monthly" : noMonthly ? "once" : picked;
  return (
    <div className="mt-7">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t`How to support`}>
        <PlanCard on={plan === "monthly"} off={noMonthly != null} onPick={() => setPlan("monthly")} gem={<RankGem rank={rank} renewing className="h-10 w-10" />} title={t`Monthly`} price={noMonthly ?? t`$4 a month`} />
        <PlanCard on={plan === "once"} off={noOnce != null} onPick={() => setPlan("once")} gem={<SupporterRankIcon rank={rank} className="h-10 w-10" />} title={t`One-time`} price={noOnce ?? t`Any amount`} />
      </div>
      {plan === "monthly" ? <MonthlyPerks index={index} method={method} /> : (
        <>
          <SupportDaysPreview />
          {method === "google" || method === "crypto" ? (
            <p className="mt-2.5 rounded-xl bg-osu-b4 px-4 py-3 text-[12.5px] leading-relaxed text-osu-l2 ring-1 ring-inset ring-white/[0.06]">
              {method === "google"
                ? t`Google only takes a few set amounts, and the one you pay there is what counts. For any other amount, pay with Ko-fi.`
                : t`Crypto payments are 1, 3, 6 or 12 months. For any other amount, pay with Ko-fi.`}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/* A plan to pick, with the rank gem it gives: burning for monthly. The fire
   rises past the card's top edge, in front of its ring. */
function PlanCard({ on, off = false, onPick, gem, title, price }: { on: boolean; off?: boolean; onPick: () => void; gem: ReactNode; title: string; price: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={off}
      onClick={onPick}
      className={`relative flex items-center gap-3 rounded-xl px-3.5 py-3 text-left ring-inset transition-colors ${off ? "cursor-not-allowed bg-osu-b4/50 ring-1 ring-white/[0.04]" : on ? "cursor-pointer bg-osu-pink/15 ring-2 ring-osu-pink" : "cursor-pointer bg-osu-b4 ring-1 ring-white/[0.06] hover:bg-osu-b3"}`}
    >
      <span className={`shrink-0 ${off ? "opacity-35 grayscale" : ""}`}>{gem}</span>
      <span className="relative min-w-0">
        <span className={`block text-[15px] font-bold ${off ? "text-white/40" : "text-white"}`}>{title}</span>
        <span className={`block text-[12px] ${off ? "text-osu-f1" : "text-osu-l2"}`}>{price}</span>
      </span>
    </button>
  );
}

/* The gem steps up a rank at a time, the way a subscriber's does a month at
   a time; it stays on Holo for anyone who asked for less motion. */
function useClimbingRank(): number {
  const [index, setIndex] = useState(SUPPORTER_RANKS.length - 1);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setIndex(0);
    const timer = setInterval(() => setIndex((value) => (value + 1) % SUPPORTER_RANKS.length), CLIMB_MS);
    return () => clearInterval(timer);
  }, []);
  return index;
}

/* What a subscription gets: the rank ladder, then each perk beside a piece
   of the real thing (a burning gem, the viewer's avatar in a frame, the Gold
   gem). The fire row comes first so its flames rise into the ladder's foot
   and not over another row. */
function MonthlyPerks({ index, method }: { index: number; method: SupportMethod | null }) {
  const { t } = useLingui();
  const you = useShowcaseViewer();
  const rank = SUPPORTER_RANKS[index];
  const first = SUPPORTER_RANKS[0], last = SUPPORTER_RANKS[SUPPORTER_RANKS.length - 1];
  return (
    <div className="mt-2.5 overflow-hidden rounded-xl bg-osu-b4 ring-1 ring-inset ring-white/[0.06]">
      <div className="border-b border-white/[0.07] bg-black/20 px-4 pb-3 pt-4">
        <div className="grid grid-cols-12 items-end gap-1">
          {SUPPORTER_RANKS.map((def, i) => (
            <SupporterRankIcon key={def.id} rank={def} className={`h-auto w-full transition-transform duration-500 ${i === index ? "-translate-y-1 scale-[1.25]" : ""}`} />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[11px] font-bold">
          <span style={{ color: first.accent }}>{first.name}</span>
          <span style={{ color: last.accent }}>{last.name}</span>
        </div>
        <p className="mt-0.5 text-center text-[11.5px] leading-snug text-osu-f1">{t`One gem up for every month in a row. If it lapses, it starts again at Amber.`}</p>
      </div>
      <ul className="px-4 py-1">
        <PerkRow art={<RankGem rank={rank} renewing className="h-7 w-7" />} title={t`Rank on fire`} body={t`Your rank badge burns for as long as you stay subscribed.`} />
        <PerkRow art={<FrameThumb frame="autumn-maple" avatar={you.avatar} size={40} />} title={t`Every supporter look`} body={t`Frames, themes, name styles and card looks, for as long as it renews.`} />
        <PerkRow art={<TicketMark />} title={t`Extra gift codes`} body={t`One for a friend every third month, on top of the one every $4 brings. Time past 3 months ahead turns into more codes instead of piling up.`} />
        <PerkRow art={<SupporterRankIcon rank={GOLD} className="h-8 w-8" />} title={t`Gold supporter`} body={t`In your rank's tooltip, at $10 a month or more.`} />
      </ul>
      <p className="border-t border-white/[0.07] px-4 pb-3 pt-2.5 text-[12px] leading-relaxed text-osu-f1">
        {method === "google"
          ? t`In Google's checkout, pick a monthly amount. You can cancel any time from your Google account.`
          : method === "lava"
            ? t`lava.top's Supporter membership renews by itself. You can cancel any time on lava.top.`
            : method === "patreon"
              ? t`Patreon's Supporter tier renews by itself. You can cancel any time on Patreon.`
            : t`On the Ko-fi panel, tick "Make this monthly" before you pay. You can cancel any time on Ko-fi.`}
      </p>
    </div>
  );
}

function PerkRow({ art, title, body }: { art: ReactNode; title: string; body: string }) {
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-3 border-t border-white/[0.07] py-2.5 first:border-t-0">
      <span className="flex justify-center">{art}</span>
      <span>
        <span className="block text-[13.5px] font-bold text-white">{title}</span>
        <span className="mt-px block text-[12.5px] leading-snug text-osu-l2">{body}</span>
      </span>
    </li>
  );
}

/* The gift ticket: a stub, its tear line and the supporter heart. */
function TicketMark() {
  return (
    <svg viewBox="0 0 60 40" className="h-7 w-[42px]" aria-hidden="true">
      <path d="M6 4h48a4 4 0 0 1 4 4v7a5 5 0 0 0 0 10v7a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4v-7a5 5 0 0 0 0-10V8a4 4 0 0 1 4-4Z" className="fill-osu-pink" />
      <path d="M41 8v24" className="stroke-osu-b6/60" strokeWidth="2" strokeDasharray="3 3" />
      <path d="M22 28.500l-7.200-6.900c-2.300-2.200-2.400-5.700-.2-7.700 2.100-1.900 5.400-1.600 7.400 1 2-2.600 5.300-2.900 7.400-1 2.200 2 2.100 5.500-.2 7.700L22 28.500Z" className="fill-osu-b6/75" />
    </svg>
  );
}
