import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Plural, useLingui } from "@lingui/react/macro";

import { SUPPORTER_DAYS_PER_DOLLAR, SUPPORTER_YEAR_DOLLARS, supporterDaysFor } from "../../lib/supporter-ranks";

const MAX = 60;
// marked under the slider: a month, two, five, and the year deal
const STEPS = [5, 10, 25, 50];
const YEAR = 365;

/* How many days of supporter an amount buys, worked out before paying: the
   Ko-fi panel is a frame the page can't read the amount from. A slider picks
   the amount (the box takes anything past it); a bar shows the time against a
   year. One payment of $50 or more is a full year per $50 (supporterDaysFor):
   the days it adds over the plain rate show in green. */
export function SupportDaysPreview() {
  const { t } = useLingui();
  const [raw, setRaw] = useState("5");
  const amount = Number(raw);
  // whole dollars, as Ko-fi takes them
  const valid = raw !== "" && amount >= 1;
  const days = valid ? Math.floor(supporterDaysFor(amount)) : 0;
  const plain = valid ? Math.floor(amount * SUPPORTER_DAYS_PER_DOLLAR) : 0;
  const bonus = Math.max(0, days - plain);
  const scale = Math.max(YEAR, days);
  const months = Math.max(1, Math.round(days / 30.4));
  const fullYear = days >= YEAR - 2 && days <= YEAR + 2;
  const span = fullYear ? t`a full year` : days >= 28 ? <Plural value={months} one="about # month" other="about # months" /> : null;

  return (
    <div className="mt-5 rounded-xl bg-osu-b4 p-4 ring-1 ring-inset ring-white/[0.06]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <label className="flex h-11 items-center rounded-lg bg-osu-b5 pl-3 ring-1 ring-inset ring-white/[0.08] focus-within:ring-osu-pink/60">
          <span className="text-[17px] font-bold text-osu-f1">$</span>
          <input
            value={raw}
            onChange={(event) => setRaw(event.target.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, 4))}
            inputMode="numeric"
            aria-label={t`Amount in dollars`}
            className="h-full w-20 bg-transparent pl-1 pr-3 text-[17px] font-bold tabular-nums text-white outline-none"
          />
        </label>
        <div className="flex flex-col text-[17px] font-bold leading-tight text-white">
          {valid ? (
            <>
              <span>
                <span className="tabular-nums text-osu-pink-light">
                  <Plural value={days} one="# day" other="# days" />
                </span>
                <span className="ml-1.5 text-[13px] font-medium text-osu-l2">{t`of supporter`}</span>
              </span>
              {/* the year deal, in the bar's two colours */}
              {bonus > 0 && (
                <span className="mt-0.5 text-[12px] font-semibold tabular-nums text-osu-f1">
                  <span className="text-osu-pink-light">{plain}</span>
                  <span className="mx-1">+</span>
                  <span className="text-osu-green-light">{bonus}</span>
                  <span className="ml-1">{t`for paying a year at once`}</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-osu-f1">{t`Enter an amount`}</span>
          )}
        </div>
      </div>

      {/* the slider, with its steps marked under it */}
      <AmountSlider value={valid ? Math.min(amount, MAX) : 1} onChange={(value) => setRaw(String(value))} label={t`Amount in dollars`} />
      <div className="relative mx-[11px] mt-1.5 h-5">
        {STEPS.map((step) => {
          const at = ((step - 1) / (MAX - 1)) * 100;
          const reached = valid && amount >= step;
          return (
            <button
              key={step}
              type="button"
              onClick={() => setRaw(String(step))}
              style={{ left: `${at}%` }}
              className={`absolute -translate-x-1/2 cursor-pointer rounded px-1 text-[11px] font-semibold tabular-nums transition-colors ${
                amount === step ? "text-osu-pink-light" : reached ? "text-white" : "text-osu-f1 hover:text-white"
              }`}
            >
              ${step}
            </button>
          );
        })}
      </div>

      {/* the time against a year: plain days, then the year deal's extra */}
      <div className="mt-2">
        <div className="relative h-3 overflow-hidden rounded-full bg-osu-b6">
          <div className="absolute inset-y-0 left-0 bg-osu-pink transition-[width] duration-150" style={{ width: `${(plain / scale) * 100}%` }} />
          <div
            className="absolute inset-y-0 bg-osu-green-light transition-[left,width] duration-150"
            style={{ left: `${(plain / scale) * 100}%`, width: `${(bonus / scale) * 100}%` }}
          />
          {/* a hairline at each month */}
          {Array.from({ length: Math.floor(scale / 30.4) }, (_, i) => (
            <span key={i} className="absolute inset-y-0 w-px bg-black/30" style={{ left: `${(((i + 1) * 30.4) / scale) * 100}%` }} />
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-osu-f1">
          <span>{span}</span>
          <span>{scale > YEAR || fullYear ? null : t`1 year`}</span>
        </div>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-osu-f1">{t`Any amount counts, to the day, and adds to the time you have left: $5 is 30 days. Paying $50 or more at once buys a full year for every $50.`}</p>
    </div>
  );
}

/* The amount slider: a soft track whose year-deal zone (from $50) is tinted
   green, dots at the steps, a white thumb ringed in pink (green in that zone)
   that grows while held and shows the amount above it. Drag, click anywhere
   on the track, or use the arrow keys (Page keys move $5). */
function AmountSlider({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const pct = ((value - 1) / (MAX - 1)) * 100;
  const bonusAt = ((SUPPORTER_YEAR_DOLLARS - 1) / (MAX - 1)) * 100;
  const set = (raw: number) => onChange(Math.min(MAX, Math.max(1, Math.round(raw))));
  const fromPointer = (event: PointerEvent) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box) return;
    set(1 + ((event.clientX - box.left) / box.width) * (MAX - 1));
  };
  const onKey = (event: KeyboardEvent) => {
    const by: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 };
    if (event.key in by) set(value + by[event.key]);
    else if (event.key === "Home") set(1);
    else if (event.key === "End") set(MAX);
    else return;
    event.preventDefault();
  };
  return (
    <div className="mt-5 px-[11px]">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={1}
        aria-valuemax={MAX}
        aria-valuenow={value}
        aria-valuetext={`$${value}`}
        onKeyDown={onKey}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging) fromPointer(event);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className="group relative flex h-6 cursor-pointer touch-none select-none items-center outline-none"
      >
        {/* the rail, its year-deal zone tinted */}
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-osu-b6 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]">
          <div className="absolute inset-y-0 right-0 bg-osu-green/15" style={{ left: `${bonusAt}%` }} />
          {/* the fill: pink to $50, green past it */}
          <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-pink to-osu-pink-light" style={{ width: `${Math.min(pct, bonusAt)}%` }} />
          {pct >= bonusAt && (
            <div className="absolute inset-y-0 bg-gradient-to-r from-osu-green to-osu-green-light" style={{ left: `${bonusAt}%`, width: `${pct - bonusAt}%` }} />
          )}
        </div>
        {/* step dots */}
        {STEPS.map((step) => {
          const at = ((step - 1) / (MAX - 1)) * 100;
          return (
            <span
              key={step}
              aria-hidden
              className={`pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 rounded-full ${value >= step ? "bg-white/80" : "bg-white/25"}`}
              style={{ left: `${at}%` }}
            />
          );
        })}
        {/* the thumb */}
        <span
          aria-hidden
          className={`pointer-events-none absolute h-[22px] w-[22px] -translate-x-1/2 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.5)] ring-[3px] transition-[transform,box-shadow] duration-100 group-focus-visible:ring-4 ${
            value >= SUPPORTER_YEAR_DOLLARS ? "ring-osu-green-light" : "ring-osu-pink"
          } ${dragging ? "scale-110" : "group-hover:scale-105"}`}
          style={{ left: `${pct}%` }}
        />
        {/* the amount above the thumb while it is held */}
        <span
          aria-hidden
          className={`pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md bg-black/85 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-white transition-opacity ${dragging ? "opacity-100" : "opacity-0"}`}
          style={{ left: `${pct}%` }}
        >
          ${value}
        </span>
      </div>
    </div>
  );
}
