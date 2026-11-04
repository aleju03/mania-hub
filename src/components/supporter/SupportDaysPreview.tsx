import { useState } from "react";
import { Plural, useLingui } from "@lingui/react/macro";

import { SUPPORTER_DAYS_PER_DOLLAR } from "../../lib/supporter-ranks";

const PRESETS = [3, 5, 10, 15];

/* How many days of supporter an amount buys, worked out before paying: the
   Ko-fi panel is a frame the page can't read the amount from. */
export function SupportDaysPreview() {
  const { t } = useLingui();
  const [raw, setRaw] = useState("5");
  const amount = Number(raw);
  // whole dollars, as Ko-fi takes them
  const valid = raw !== "" && amount >= 1;
  const days = amount * SUPPORTER_DAYS_PER_DOLLAR;

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
        <div className="text-[17px] font-bold text-white">
          {valid ? (
            <>
              <span className="tabular-nums text-osu-pink-light">
                <Plural value={days} one="# day" other="# days" />
              </span>
              <span className="ml-1.5 text-[13px] font-medium text-osu-l2">{t`of supporter`}</span>
            </>
          ) : (
            <span className="text-osu-f1">{t`Enter an amount`}</span>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setRaw(String(preset))}
            aria-pressed={amount === preset}
            className={`h-7 cursor-pointer rounded-md px-2.5 text-[12px] font-semibold tabular-nums transition ${
              amount === preset ? "bg-osu-pink/20 text-osu-pink-light ring-1 ring-inset ring-osu-pink/40" : "bg-osu-b3 text-osu-l2 hover:bg-osu-b2 hover:text-white"
            }`}
          >
            ${preset}
          </button>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-osu-f1">{t`Any amount counts, to the day, and adds to the time you have left.`}</p>
    </div>
  );
}
