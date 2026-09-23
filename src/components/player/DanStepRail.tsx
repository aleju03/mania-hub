import { useLingui } from "@lingui/react/macro";
import { danVariantForOffset } from "#dan/dan-estimator/labels";
import { danLadderBounds, danScaleLabel, danTierColor, danTierName, danTierSuffix, type DanScaleContext } from "../../lib/dan-images";

// Every step is 0.2 wide and starts 0.1 past a multiple of 0.2 (12.9, 13.1,
// 13.3 ...), so a level's five steps run from level - 0.5 to level + 0.5.
const STEP = 0.2;
const round2 = (value: number) => Math.round(value * 100) / 100;

export interface DanStep {
  start: number;
  label: string;
}

/**
 * The step starts around a rawDan: two steps under the one it sits in and one
 * over, clipped to the ladder. Each start carries the label of the step it opens.
 */
export function danStepWindow(rawDan: number, context: DanScaleContext): { steps: DanStep[]; current: number } {
  const bounds = danLadderBounds(context);
  const currentStart = round2(Math.floor((rawDan - 0.1) / STEP + 1e-9) * STEP + 0.1);
  const steps: DanStep[] = [];
  for (let index = -2; index <= 2; index++) {
    const start = round2(currentStart + index * STEP);
    const level = Math.round(start + STEP / 2);
    if (level < bounds.min || level > bounds.max) continue;
    const variant = danVariantForOffset(start + STEP / 2 - level);
    steps.push({ start, label: `${danScaleLabel(level, context).toLowerCase()}${variant ?? ""}` });
  }
  return { steps, current: currentStart };
}

export function DanStepRail({
  rawDan,
  context,
  formatDan,
}: {
  rawDan: number;
  context: DanScaleContext;
  formatDan: (label: string) => string;
}) {
  const { t } = useLingui();
  const { steps, current } = danStepWindow(rawDan, context);
  if (steps.length < 2) return null;
  // Each step is drawn as the span it covers, so the rail ends one step past
  // the last start.
  const lo = steps[0].start;
  const hi = round2(steps[steps.length - 1].start + STEP);
  const at = (value: number) => Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  const next = steps.find((step) => step.start > rawDan);
  const ticks = [...steps.map((step) => step.start), hi];
  return (
    <div className="relative h-[170px] w-[250px]">
      <span className="absolute inset-y-0 left-[46px] w-0.5 -translate-x-1/2 rounded-full bg-white/10" />
      {ticks.map((tick) => (
        <span
          key={tick}
          className="absolute left-0 flex w-[52px] translate-y-1/2 items-center"
          style={{ bottom: `${at(tick) * 100}%` }}
        >
          <span className="w-9 text-right text-[10px] tabular-nums text-osu-f1">{tick.toFixed(1)}</span>
          <span className="ml-1 h-px w-2 bg-white/20" />
        </span>
      ))}
      {steps.map((step) => {
        const mine = step.start === current;
        const tierColor = danTierColor(danTierSuffix(step.label)) ?? "#ffffff";
        const middle = at(step.start + STEP / 2);
        return (
          <span key={step.start}>
            {mine ? (
              <span
                className="absolute left-[46px] w-0.5 -translate-x-1/2 rounded-full"
                style={{ bottom: `${at(step.start) * 100}%`, height: `${(at(step.start + STEP) - at(step.start)) * 100}%`, background: tierColor }}
              />
            ) : null}
            <span
              className="absolute left-[60px] flex translate-y-1/2 items-baseline gap-2 whitespace-nowrap"
              style={{ bottom: `${middle * 100}%` }}
            >
              <span
                className={`text-[12px] ${mine ? "font-semibold" : "text-osu-f1"}`}
                style={mine ? { color: tierColor } : undefined}
              >
                {danTierName(step.label, formatDan)}
              </span>
              {step === next ? (
                <span className="text-[11px] tabular-nums text-osu-f1">{t`+${(step.start - rawDan).toFixed(2)} to go`}</span>
              ) : null}
            </span>
          </span>
        );
      })}
      <span
        className="absolute left-[46px] h-2.5 w-2.5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-osu-b3 bg-white"
        style={{ bottom: `${at(rawDan) * 100}%` }}
        title={rawDan.toFixed(2)}
      />
    </div>
  );
}
