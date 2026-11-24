import { useEffect, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";

import { SUPPORTER_RANKS } from "../../lib/supporter-ranks";
import { FrameThumb } from "./LoadoutSlots";
import { SupportDaysPreview } from "./SupportDaysPreview";
import { RankGem, SupporterRankIcon } from "./SupporterRankBadge";
import { useShowcaseViewer } from "./SupportShowcase";
import type { SupportMethod, SupportPlan } from "./SupportCheckout";

/* How long the monthly card's gem stays on each rank as it climbs. */
const CLIMB_MS = 2400;
const GOLD = SUPPORTER_RANKS.find((rank) => rank.id === "gold") ?? SUPPORTER_RANKS[0];

/* What the picked plan gets, beside the checkout: a subscription's rank
   ladder and perks, or the one-time days calculator. `amount` is the
   calculator's, which the crypto panel pays. */
export function SupportPlanInfo({ plan, method, amount, onAmount }: { plan: SupportPlan; method: SupportMethod | null; amount: string; onAmount: (amount: string) => void }) {
  const { t } = useLingui();
  const index = useClimbingRank();
  const rank = SUPPORTER_RANKS[index];
  if (plan === "monthly") {
    return (
      <>
        <PlanHeading gem={<RankGem rank={rank} renewing className="h-9 w-9" />} title={t`Monthly`} price={t`$4 a month`} />
        <MonthlyPerks index={index} method={method} />
      </>
    );
  }
  return (
    <>
      <PlanHeading gem={<SupporterRankIcon rank={rank} className="h-9 w-9" />} title={t`One-time`} price={t`Any amount`} />
      <SupportDaysPreview raw={amount} onRaw={onAmount} />
    </>
  );
}

function PlanHeading({ gem, title, price }: { gem: ReactNode; title: string; price: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0">{gem}</span>
      <span className="text-[17px] font-bold text-white">{title}</span>
      <span className="text-[13px] text-osu-l2">{price}</span>
    </div>
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
            : t`Ko-fi's monthly payment renews by itself. You can cancel any time on Ko-fi.`}
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
