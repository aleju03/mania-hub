import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  danLadderBounds,
  danScaleImage,
  danScaleLabel,
  danTierColor,
  danTierSuffix,
  type DanScaleContext,
} from "../../lib/dan-images";

// Course labels round to the nearest level: Beta spans 11.5–12.5,
// with its unsuffixed course anchor at 12. All geometry uses that same axis.
export interface DanRailWindow {
  lo: number;
  hi: number;
}

// One course of context under the values and one above, so the neighbours a
// play is between stay readable, then widened to three bands when the ladder's
// ends leave it thinner than that.
export function danRailWindow(context: DanScaleContext, values: number[]): DanRailWindow {
  const bounds = danLadderBounds(context);
  const floor = bounds.min - 0.5;
  const ceiling = bounds.max + 0.5;
  const present = values.filter((value) => Number.isFinite(value));
  const anchors = present.length > 0 ? present : [floor];
  let lo = Math.max(floor, Math.round(Math.min(...anchors)) - 1.5);
  let hi = Math.min(ceiling, Math.round(Math.max(...anchors)) + 1.5);
  while (hi - lo < 3) {
    if (hi < ceiling) hi += 1;
    else if (lo > floor) lo -= 1;
    else break;
  }
  return { lo, hi };
}

/** "beta+" is the backend's own label; the rail titles it like a course name. */
function danDisplayLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  return /^[a-z]/.test(label) ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

// The before/after comparison carries the result; the ladder only locates
// those two values. Color spans the change, never the distance from zero.
export function DanProgressRail({
  context,
  chart,
  chartLabel,
  landed,
  landedLabel,
  rejected = false,
}: {
  context: DanScaleContext;
  chart: number | null;
  chartLabel?: string | null;
  landed?: number | null;
  landedLabel?: string | null;
  /** The clear credits nothing, so there is no landed level to draw. */
  rejected?: boolean;
}) {
  const { t } = useLingui();
  const [hover, setHover] = useState<number | null>(null);
  const landedValue = rejected ? null : landed ?? null;
  const range = danRailWindow(context, [chart, landedValue].filter((value): value is number => value != null));
  const span = range.hi - range.lo;
  const at = (value: number) => Math.min(1, Math.max(0, (value - range.lo) / span));
  const bands = Array.from({ length: span }, (_, index) => Math.ceil(range.lo) + index);
  const landedBand = landedValue != null ? Math.round(landedValue) : chart != null ? Math.round(chart) : null;
  const accent = (landedLabel ? danTierColor(danTierSuffix(landedLabel)) : null) ?? "var(--color-osu-pink)";
  const readValue = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.height <= 0) return;
    const fraction = Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height));
    setHover(range.lo + fraction * span);
  };

  return (
    <div className="flex h-full min-h-[260px] flex-col gap-3">
      <div className="flex h-4 items-baseline justify-between gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55"><Trans>Dan credit</Trans></span>
        {hover != null && <span className="text-[10px] tabular-nums text-osu-f1/70">{danScaleLabel(hover, context)} · {hover.toFixed(2)}</span>}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)] items-center gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[9px] text-osu-f1/70">
            <span className="h-1.5 w-1.5 rotate-45 border border-osu-l2" aria-hidden="true" />
            <Trans>Chart estimate</Trans>
          </span>
          <span className="text-[25px] font-bold leading-none tabular-nums text-osu-l2">{chart?.toFixed(2) ?? "—"}</span>
          <span className="text-[11px] font-semibold text-osu-f1/70">{danDisplayLabel(chartLabel) ?? "—"}</span>
        </div>
        <span className="text-lg text-osu-f1/40" aria-hidden="true">→</span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[9px] text-osu-f1/70">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: landedValue != null ? accent : "currentColor" }} aria-hidden="true" />
            <Trans>Your credit</Trans>
          </span>
          <span className="text-[25px] font-bold leading-none tabular-nums" style={{ color: landedValue != null ? accent : "var(--color-osu-f1)" }}>{landedValue?.toFixed(2) ?? "—"}</span>
          <span className="text-[11px] font-semibold text-osu-l1">{landedValue != null ? danDisplayLabel(landedLabel) ?? "—" : rejected ? t`No dan credit` : "—"}</span>
        </div>
      </div>
      <div className="flex min-h-[136px] flex-1 justify-center gap-3 border-t border-white/5 pt-3">
        <div className="relative flex flex-1 justify-center gap-3" onPointerMove={readValue} onPointerLeave={() => setHover(null)}>
          <div className="relative w-24 shrink-0">
            {bands.map((level) => {
              const src = danScaleImage(level, context);
              const label = danScaleLabel(level, context);
              return (
                <span
                  key={level}
                  className="absolute inset-x-0 flex translate-y-1/2 items-center gap-2"
                  style={{ bottom: `${at(level) * 100}%` }}
                  title={`${label}: ${(level - 0.5).toFixed(2)}–${(level + 0.5).toFixed(2)}`}
                >
                  {src ? <img src={src} alt={label} className={`h-6 w-6 object-contain ${level === landedBand ? "opacity-90" : "opacity-40"}`} /> : <span className="w-6" />}
                  <span className={`flex flex-col gap-1 ${level === landedBand ? "text-osu-l2" : "text-osu-f1/50"}`}>
                    <span className="text-[11px] font-semibold">{label}</span>
                    <span className="text-[9px] tabular-nums">{(level - 0.5).toFixed(1)}–{(level + 0.5).toFixed(1)}</span>
                  </span>
                </span>
              );
            })}
          </div>
          <div className="relative w-12 shrink-0">
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10" />
            {bands.slice(1).map((level) => (
              <span key={level} className="absolute left-1/2 h-px w-3 -translate-x-1/2 bg-white/10" style={{ bottom: `${at(level - 0.5) * 100}%` }} />
            ))}
            {chart != null && landedValue != null && (
              <>
                <span
                  data-testid="dan-credit-connector"
                  className="absolute left-1/2 w-0.5 -translate-x-1/2"
                  style={{ bottom: `${at(Math.min(chart, landedValue)) * 100}%`, height: `${Math.abs(at(landedValue) - at(chart)) * 100}%`, background: accent }}
                />
                <span className="absolute left-1/4 h-px w-1/4" style={{ bottom: `${at(chart) * 100}%`, background: accent }} />
                <span className="absolute left-1/2 h-px w-1/4" style={{ bottom: `${at(landedValue) * 100}%`, background: accent }} />
              </>
            )}
            {hover != null && <span className="absolute inset-x-0 h-px bg-osu-l1/20" style={{ bottom: `${at(hover) * 100}%` }} />}
            {chart != null && (
              <span
                data-testid="dan-chart-marker"
                title={t`Chart estimate: ${chart.toFixed(2)}`}
                className="absolute left-1/4 h-2 w-2 -translate-x-1/2 translate-y-1/2 rotate-45 border border-osu-l2 bg-osu-b4"
                style={{ bottom: `${at(chart) * 100}%` }}
              />
            )}
            {landedValue != null && (
              <span
                data-testid="dan-credit-marker"
                title={t`Your credit: ${landedValue.toFixed(2)}`}
                className="absolute left-3/4 h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full border border-white/25"
                style={{ bottom: `${at(landedValue) * 100}%`, background: accent }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
