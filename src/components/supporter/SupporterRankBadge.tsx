import { useEffect, useId, useRef, useState } from "react";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { useWebGlSlot } from "../../lib/gl-budget";
import { mountRankFire, RANK_FIRE_BLEED, type RankFire } from "../../lib/rank-fire";
import { SUPPORTER_RANKS, supporterRank, type SupporterRankDef } from "../../lib/supporter-ranks";
import { Switch } from "../ui/Switch";
import { Stagger, StaggerItem } from "./SupportMotion";

/* The supporter hexagon and heart (public/images/icons/supporter-heart.svg),
   filled with a rank's material. */
const HEX = "M65 4H35C27.8 4 21.3 7.8 17.7 14L2.7 40c-3.6 6.2-3.6 13.8 0 20l15 26c3.6 6.2 10.1 10 17.3 10h30c7.1 0 13.7-3.8 17.3-10l15-26c3.6-6.2 3.6-13.8 0-20l-15-26C78.7 7.8 72.1 4 65 4Z";
const HEART = "M50 69L33.6 53.2C28.4 48.2 28.2 40.2 33.2 35.6C38 31.2 45.4 32 50 38C54.6 32 62 31.2 66.8 35.6C71.8 40.2 71.6 48.2 66.4 53.2L50 69Z";
const DAY_MS = 24 * 60 * 60 * 1000;
/* How long the /support demo shows each rank burning before the next catches. */
const RANK_FIRE_DEMO_MS = 3200;

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

/* The rank gem, burning when a monthly subscription keeps it renewing
   (lib/rank-fire.ts): the fire canvas sits behind the gem, the licks over its
   face are screened on top. Still under reduced motion, and while the page
   has no WebGL slot to spare, a soft glow in the rank's colour stands in. */
function RankGem({ rank, renewing, className }: { rank: SupporterRankDef; renewing: boolean; className?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const [reduced, setReduced] = useState(true);
  useEffect(() => setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  const slot = useWebGlSlot(hostRef, { enabled: renewing && !reduced, low: true });
  const live = renewing && !reduced && slot;
  // one fire for as long as it's live; a new rank only recolours it
  const fireRef = useRef<RankFire | null>(null);
  const colorsRef = useRef(rank.fire);
  colorsRef.current = rank.fire;
  useEffect(() => {
    const back = backRef.current, front = frontRef.current;
    if (!live || !back || !front) return;
    const fire = mountRankFire(back, front, colorsRef.current);
    fireRef.current = fire;
    return () => {
      fire?.dispose();
      fireRef.current = null;
    };
  }, [live]);
  useEffect(() => {
    fireRef.current?.setColors(rank.fire);
  }, [rank]);
  const bleed = RANK_FIRE_BLEED;
  const box = { left: `${-bleed.x * 100}%`, top: `${-bleed.top * 100}%`, width: `${(1 + 2 * bleed.x) * 100}%`, height: `${(1 + bleed.top + bleed.bottom) * 100}%` };
  return (
    <span
      ref={hostRef}
      className={`relative inline-block shrink-0 ${className ?? ""}`}
      style={renewing && !live ? { filter: `drop-shadow(0 0 0.18em ${rank.fire[0]})` } : undefined}
    >
      {live ? <canvas ref={backRef} aria-hidden className="pointer-events-none absolute" style={box} /> : null}
      <SupporterRankIcon rank={rank} className="relative block h-full w-full" />
      {live ? <canvas ref={frontRef} aria-hidden className="pointer-events-none absolute mix-blend-screen" style={box} /> : null}
    </span>
  );
}

/* A supporter's rank beside their name, with how long they have kept it up
   and when the next one comes on hover or tap. Nothing for a run that
   isn't active (`runStartedAt` null). A renewing rank burns unless its
   supporter turned the fire off (`fire` false); the tip still says it renews.
   On their own profile (`onFireChange` set) the tip holds that switch, so it
   stays open while the pointer or focus is inside it. */
export function SupporterRankBadge({ runStartedAt, renewing = false, fire = true, onFireChange, className = "h-7 w-7" }: { runStartedAt: number | null; renewing?: boolean; fire?: boolean; onFireChange?: (fire: boolean) => void; className?: string }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  if (runStartedAt == null) return null;
  const rank = supporterRank(runStartedAt);
  const name = rank.def.name;
  const inARow = t`${name}, ${plural(rank.months, { one: "# month", other: "# months" })} in a row`;
  const label = renewing ? `${inARow}. ${t`Renews every month`}` : inARow;
  const fireSwitch = renewing && onFireChange ? onFireChange : undefined;
  return (
    <span
      className="relative inline-flex shrink-0"
      onPointerEnter={(event) => event.pointerType === "mouse" && setOpen(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="inline-flex items-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink-light"
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <RankGem rank={rank.def} renewing={renewing && fire} className={className} />
      </button>
      {/* only while open: the day count would differ between the server render and hydration */}
      {open ? <RankTip rank={rank} name={name} renewing={renewing} fire={fire} onFireChange={fireSwitch} /> : null}
    </span>
  );
}

function RankTip({ rank, name, renewing, fire, onFireChange }: { rank: ReturnType<typeof supporterRank>; name: string; renewing: boolean; fire: boolean; onFireChange?: (fire: boolean) => void }) {
  const { t } = useLingui();
  const months = rank.months;
  const next = rank.nextAt == null ? null : SUPPORTER_RANKS[rank.index + 1];
  const days = rank.nextAt == null ? 0 : Math.max(1, Math.ceil((rank.nextAt - Date.now()) / DAY_MS));
  const nextName = next ? next.name : "";
  return (
    // the padding, not a margin, bridges the gap under the gem, so the pointer
    // can cross it to the switch without the tip closing
    <span
      role={onFireChange ? undefined : "tooltip"}
      className={`absolute left-1/2 top-full z-30 w-max max-w-[16rem] -translate-x-1/2 pt-2 ${onFireChange ? "" : "pointer-events-none"}`}
    >
      <span className="block rounded-lg border border-white/10 bg-black/90 px-3 py-2 text-left text-[13px] font-normal leading-snug text-white shadow-xl">
        <span className="block">
          <span className="font-semibold" style={{ color: rank.def.accent }}>{name}</span>
          {" "}
          {t`${plural(months, { one: "# month", other: "# months" })} in a row`}
        </span>
        <span className="block text-white/60">
          {next ? t`${nextName} in ${plural(days, { one: "# day", other: "# days" })}` : t`The top rank`}
        </span>
        {renewing ? <span className="block text-white/60">{t`Renews every month`}</span> : null}
        {onFireChange ? (
          <label className="mt-2 flex cursor-pointer items-center gap-2 border-t border-white/10 pt-2 text-white/80">
            <Switch checked={fire} onChange={onFireChange} label={t`Show the fire on your rank`} />
            <span>{t`Show the fire on your rank`}</span>
          </label>
        ) : null}
      </span>
    </span>
  );
}

/* All twelve ranks in a row on /supporter: the ones reached in colour, the
   current one larger, the rest still to come faded. Client-only (the page
   loads the viewer's state after mount), so the day count is safe here. */
export function SupporterRankLadder({ runStartedAt, renewing = false, fire = true }: { runStartedAt: number; renewing?: boolean; fire?: boolean }) {
  const { t } = useLingui();
  const rank = supporterRank(runStartedAt);
  const name = rank.def.name;
  const next = rank.nextAt == null ? null : SUPPORTER_RANKS[rank.index + 1];
  const nextName = next ? next.name : "";
  const days = rank.nextAt == null ? 0 : Math.max(1, Math.ceil((rank.nextAt - Date.now()) / DAY_MS));
  return (
    <div className="mt-4">
      <p className="text-[13px] text-osu-l2">
        <span className="font-semibold" style={{ color: rank.def.accent }}>{name}</span>
        {" "}
        {t`${plural(rank.months, { one: "# month", other: "# months" })} in a row`}
        <span className="mx-2 inline-block h-3 w-px translate-y-[2px] bg-white/15" aria-hidden="true" />
        {next ? t`${nextName} in ${plural(days, { one: "# day", other: "# days" })}` : t`The top rank`}
        {renewing ? (
          <>
            <span className="mx-2 inline-block h-3 w-px translate-y-[2px] bg-white/15" aria-hidden="true" />
            {t`Renews every month`}
          </>
        ) : null}
      </p>
      <ol className="mt-2 flex items-center gap-1 sm:gap-1.5" aria-label={t`Supporter ranks`}>
        {SUPPORTER_RANKS.map((def, i) => (
          <li key={def.id} title={def.name} className={i > rank.index ? "opacity-25 grayscale transition-[opacity,filter] duration-200 hover:opacity-100 hover:grayscale-0" : undefined}>
            <RankGem rank={def} renewing={renewing && fire && i === rank.index} className={i === rank.index ? "h-8 w-8 sm:h-9 sm:w-9" : "h-5 w-5 sm:h-6 sm:w-6"} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/* The twelve ranks for /support, each with the month it is reached in, and
   under them what a monthly subscription does to one. */
export function SupporterRankShowcase() {
  const { t } = useLingui();
  return (
    <>
      <Stagger className="grid grid-cols-4 gap-3 sm:grid-cols-6">
        {SUPPORTER_RANKS.map((def, i) => {
          const month = i + 1;
          return (
            <StaggerItem key={def.id} className="flex flex-col items-center gap-2 rounded-xl bg-osu-b4/60 px-2 py-4">
              <SupporterRankIcon rank={def} className="h-12 w-12 sm:h-14 sm:w-14" />
              <span className="text-[13px] font-semibold text-white">{def.name}</span>
              <span className="-mt-1.5 text-[11px] text-osu-l2">{t`Month ${month}`}</span>
            </StaggerItem>
          );
        })}
      </Stagger>
      <RankFireDemo />
    </>
  );
}

/* One burning rank that steps through all twelve, so a visitor sees what a
   monthly subscription does to theirs. One live fire, not twelve: each is a
   WebGL context, and a phone's budget is five. Each rank catches fresh. */
function RankFireDemo() {
  const [index, setIndex] = useState(SUPPORTER_RANKS.length - 1);
  useEffect(() => {
    const timer = setInterval(() => setIndex((value) => (value + 1) % SUPPORTER_RANKS.length), RANK_FIRE_DEMO_MS);
    return () => clearInterval(timer);
  }, []);
  const rank = SUPPORTER_RANKS[index];
  return (
    <div className="mt-3 flex flex-col items-center gap-2 rounded-xl bg-osu-b4/60 pt-20 pb-5">
      <RankGem rank={rank} renewing className="h-16 w-16 sm:h-20 sm:w-20" />
      <span className="text-[13px] font-semibold" style={{ color: rank.accent }}>{rank.name}</span>
    </div>
  );
}
