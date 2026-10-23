import { useId, useState } from "react";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { SUPPORTER_RANKS, supporterRank, type SupporterRankDef } from "../../lib/supporter-ranks";
import { Stagger, StaggerItem } from "./SupportMotion";

/* The supporter hexagon and heart (public/images/icons/supporter-heart.svg),
   filled with a rank's material. */
const HEX = "M65 4H35C27.8 4 21.3 7.8 17.7 14L2.7 40c-3.6 6.2-3.6 13.8 0 20l15 26c3.6 6.2 10.1 10 17.3 10h30c7.1 0 13.7-3.8 17.3-10l15-26c3.6-6.2 3.6-13.8 0-20l-15-26C78.7 7.8 72.1 4 65 4Z";
const HEART = "M50 69L33.6 53.2C28.4 48.2 28.2 40.2 33.2 35.6C38 31.2 45.4 32 50 38C54.6 32 62 31.2 66.8 35.6C71.8 40.2 71.6 48.2 66.4 53.2L50 69Z";
const DAY_MS = 24 * 60 * 60 * 1000;

export function SupporterRankIcon({ rank, className }: { rank: SupporterRankDef; className?: string }) {
  const fill = useId();
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          {rank.stops.map((color, i) => <stop key={i} offset={[0, 0.45, 0.7, 1][i]} stopColor={color} />)}
        </linearGradient>
      </defs>
      <path d={HEX} fill={`url(#${fill})`} />
      <path d={HEART} fill={rank.ink} />
    </svg>
  );
}

/* A supporter's rank beside their name, with how long they have kept it up
   and when the next one comes on hover or tap. Nothing for a run that
   isn't active (`runStartedAt` null). */
export function SupporterRankBadge({ runStartedAt, className = "h-7 w-7" }: { runStartedAt: number | null; className?: string }) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  if (runStartedAt == null) return null;
  const rank = supporterRank(runStartedAt);
  const name = i18n._(rank.def.name);
  const label = t`${name}, ${plural(rank.months, { one: "# month", other: "# months" })} in a row`;
  return (
    <button
      type="button"
      className="relative inline-flex shrink-0 items-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink-light"
      aria-label={label}
      onPointerEnter={(event) => event.pointerType === "mouse" && setOpen(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((value) => !value)}
    >
      <SupporterRankIcon rank={rank.def} className={className} />
      {/* only while open: the day count would differ between the server render and hydration */}
      {open ? <RankTip rank={rank} name={name} /> : null}
    </button>
  );
}

function RankTip({ rank, name }: { rank: ReturnType<typeof supporterRank>; name: string }) {
  const { t, i18n } = useLingui();
  const months = rank.months;
  const next = rank.nextAt == null ? null : SUPPORTER_RANKS[rank.index + 1];
  const days = rank.nextAt == null ? 0 : Math.max(1, Math.ceil((rank.nextAt - Date.now()) / DAY_MS));
  const nextName = next ? i18n._(next.name) : "";
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-max max-w-[16rem] -translate-x-1/2 rounded-lg border border-white/10 bg-black/90 px-3 py-2 text-left text-[13px] font-normal leading-snug text-white shadow-xl"
    >
      <span className="block">
        <span className="font-semibold" style={{ color: rank.def.accent }}>{name}</span>
        {" "}
        {t`${plural(months, { one: "# month", other: "# months" })} in a row`}
      </span>
      <span className="block text-white/60">
        {next ? t`${nextName} in ${plural(days, { one: "# day", other: "# days" })}` : t`The top rank`}
      </span>
    </span>
  );
}

/* All twelve ranks in a row on /supporter: the ones reached in colour, the
   current one larger, the rest still to come faded. Client-only (the page
   loads the viewer's state after mount), so the day count is safe here. */
export function SupporterRankLadder({ runStartedAt }: { runStartedAt: number }) {
  const { t, i18n } = useLingui();
  const rank = supporterRank(runStartedAt);
  const name = i18n._(rank.def.name);
  const next = rank.nextAt == null ? null : SUPPORTER_RANKS[rank.index + 1];
  const nextName = next ? i18n._(next.name) : "";
  const days = rank.nextAt == null ? 0 : Math.max(1, Math.ceil((rank.nextAt - Date.now()) / DAY_MS));
  return (
    <div className="mt-4">
      <p className="text-[13px] text-osu-l2">
        <span className="font-semibold" style={{ color: rank.def.accent }}>{name}</span>
        {" "}
        {t`${plural(rank.months, { one: "# month", other: "# months" })} in a row`}
        <span className="mx-2 inline-block h-3 w-px translate-y-[2px] bg-white/15" aria-hidden="true" />
        {next ? t`${nextName} in ${plural(days, { one: "# day", other: "# days" })}` : t`The top rank`}
      </p>
      <ol className="mt-2 flex items-center gap-1 sm:gap-1.5" aria-label={t`Supporter ranks`}>
        {SUPPORTER_RANKS.map((def, i) => (
          <li key={def.id} title={i18n._(def.name)} className={i > rank.index ? "opacity-25 grayscale transition-[opacity,filter] duration-200 hover:opacity-100 hover:grayscale-0" : undefined}>
            <SupporterRankIcon rank={def} className={i === rank.index ? "h-8 w-8 sm:h-9 sm:w-9" : "h-5 w-5 sm:h-6 sm:w-6"} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/* The twelve ranks for /support, each with the month it is reached in. */
export function SupporterRankShowcase() {
  const { t, i18n } = useLingui();
  return (
    <Stagger className="grid grid-cols-4 gap-3 sm:grid-cols-6">
      {SUPPORTER_RANKS.map((def, i) => {
        const month = i + 1;
        return (
          <StaggerItem key={def.id} className="flex flex-col items-center gap-2 rounded-xl bg-osu-b4/60 px-2 py-4">
            <SupporterRankIcon rank={def} className="h-12 w-12 sm:h-14 sm:w-14" />
            <span className="text-[13px] font-semibold text-white">{i18n._(def.name)}</span>
            <span className="-mt-1.5 text-[11px] text-osu-l2">{t`Month ${month}`}</span>
          </StaggerItem>
        );
      })}
    </Stagger>
  );
}
