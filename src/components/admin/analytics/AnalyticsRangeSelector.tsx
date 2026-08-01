import {
  ANALYTICS_RANGE_PRESETS,
  ANALYTICS_RANGE_STEPS,
  clampAnalyticsRangeHours,
  formatAnalyticsRangeChipLabel,
  formatAnalyticsRangeLabel,
  getAnalyticsRangeStepIndex,
  type AnalyticsRange,
} from "../../../lib/analytics-monitor";

const THUMB_PX = 14;

export function AnalyticsRangeSelector({ range, onChange }: { range: AnalyticsRange; onChange: (range: AnalyticsRange) => void }) {
  const stepIndex = getAnalyticsRangeStepIndex(range);
  const lastStep = ANALYTICS_RANGE_STEPS.length - 1;
  const fraction = lastStep > 0 ? stepIndex / lastStep : 0;
  const rangeLabel = formatAnalyticsRangeLabel(range);
  const presetSteps = new Set(ANALYTICS_RANGE_PRESETS.map((entry) => getAnalyticsRangeStepIndex(entry)));
  // The native thumb travels between its own half-widths, so a raw percentage
  // fill drifts from the thumb at the ends. Offset by the thumb radius to track it.
  const offsetFor = (f: number) => `calc(${f * 100}% + ${(0.5 - f) * THUMB_PX}px)`;

  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/40 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-baseline gap-2">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-osu-f1">Range</div>
          <div className="text-[13px] font-semibold text-white">{rangeLabel}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {ANALYTICS_RANGE_PRESETS.map((entry) => {
            const active = clampAnalyticsRangeHours(entry) === clampAnalyticsRangeHours(range);
            return (
              <button
                key={entry}
                type="button"
                onClick={() => onChange(entry)}
                className={`cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-[120ms] ${
                  active ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
                }`}
              >
                {formatAnalyticsRangeChipLabel(entry)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <span className="w-7 shrink-0 text-right font-mono text-[10px] text-osu-f1">1h</span>
        <div className="relative h-5 min-w-0 flex-1">
          {/* base track */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-osu-b3/70" />
          {/* filled portion up to the thumb */}
          <div
            className="pointer-events-none absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-osu-pink"
            style={{ width: offsetFor(fraction) }}
          />
          {/* tick marks: taller + brighter on preset stops */}
          {ANALYTICS_RANGE_STEPS.map((_, index) => {
            const f = lastStep > 0 ? index / lastStep : 0;
            const isPreset = presetSteps.has(index);
            const passed = index <= stepIndex;
            return (
              <span
                key={index}
                className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                  isPreset ? "h-2.5 w-0.5" : "h-1.5 w-px"
                } ${passed ? "bg-osu-pink-light/70" : isPreset ? "bg-osu-f1/80" : "bg-osu-f1/40"}`}
                style={{ left: offsetFor(f) }}
              />
            );
          })}
          <input
            type="range"
            min={0}
            max={lastStep}
            step={1}
            value={stepIndex}
            onChange={(event) => {
              const nextStep = ANALYTICS_RANGE_STEPS[Number(event.currentTarget.value)];
              if (nextStep) onChange(nextStep);
            }}
            aria-label="Analytics range"
            aria-valuetext={rangeLabel}
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent
              [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-osu-pink [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:cursor-grab hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:cursor-grabbing
              [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-osu-pink [&::-moz-range-thumb]:cursor-grab"
          />
        </div>
        <span className="w-8 shrink-0 font-mono text-[10px] text-osu-f1">30d</span>
      </div>
    </div>
  );
}
