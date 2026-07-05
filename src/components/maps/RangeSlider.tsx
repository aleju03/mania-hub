import { useEffect, useRef, useState } from "react";

// Generic dual-thumb range slider. Values of 0 mean "unset" (thumb parked at the
// bound), so the parent stores 0/0 for "any". Commits on release, like the maps
// star-range slider it's modelled on.
interface Props {
  lo: number;
  hi: number;
  min: number;
  max: number;
  step: number;
  onChange: (min: number, max: number) => void;
  format?: (value: number) => string;
  ariaLabel: string;
}

const THUMB =
  "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink-light [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:pointer-events-auto" +
  " [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-osu-pink-light [&::-moz-range-thumb]:shadow-[0_0_0_2px_rgba(0,0,0,0.35)] [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:pointer-events-auto";

export function RangeSlider({ lo, hi, min, max, step, onChange, format, ariaLabel }: Props) {
  const active = min > 0 || max > 0;
  const [localMin, setLocalMin] = useState(min > 0 ? min : lo);
  const [localMax, setLocalMax] = useState(max > 0 ? max : hi);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (draggingRef.current) return;
    setLocalMin(min > 0 ? min : lo);
    setLocalMax(max > 0 ? max : hi);
  }, [min, max, lo, hi]);

  const fmt = format ?? ((value: number) => String(Math.round(value)));
  const commit = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    onChange(localMin <= lo ? 0 : localMin, localMax >= hi ? 0 : localMax);
  };

  const show = active || dragging;
  const span = hi - lo || 1;
  const minPct = ((localMin - lo) / span) * 100;
  const maxPct = ((localMax - lo) / span) * 100;
  const atFloor = localMin <= lo + 1e-9;
  const atCeiling = localMax >= hi - 1e-9;
  const label = !show || (atFloor && atCeiling)
    ? "Any"
    : atCeiling
      ? `${fmt(localMin)}+`
      : atFloor
        ? `≤ ${fmt(localMax)}`
        : `${fmt(localMin)} – ${fmt(localMax)}`;
  const minOnTop = localMin - lo > span / 2;

  return (
    <div className="flex items-center gap-3 w-[280px] max-w-full">
      <div className="relative h-3.5 flex-1 min-w-[120px]">
        <div className="absolute top-1/2 -translate-y-1/2 inset-x-0 h-1 rounded-full" style={{ background: "var(--color-osu-b3)" }} />
        {show && (
          <div className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full" style={{ background: "var(--color-osu-pink)", left: `${minPct}%`, right: `${100 - maxPct}%` }} />
        )}
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={localMin}
          onChange={(e) => {
            const value = Math.max(lo, Math.min(Number(e.target.value), localMax - step));
            draggingRef.current = true;
            setDragging(true);
            setLocalMin(value);
          }}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          aria-label={`${ariaLabel} minimum`}
          className={`absolute inset-0 w-full h-full appearance-none bg-transparent pointer-events-none ${THUMB}`}
          style={{ zIndex: minOnTop ? 3 : 2 }}
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={localMax}
          onChange={(e) => {
            const value = Math.min(hi, Math.max(Number(e.target.value), localMin + step));
            draggingRef.current = true;
            setDragging(true);
            setLocalMax(value);
          }}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          aria-label={`${ariaLabel} maximum`}
          className={`absolute inset-0 w-full h-full appearance-none bg-transparent pointer-events-none ${THUMB}`}
          style={{ zIndex: minOnTop ? 2 : 3 }}
        />
      </div>
      <button
        type="button"
        onClick={() => active && onChange(0, 0)}
        className={`shrink-0 w-24 text-left text-[11px] font-semibold tabular-nums transition-colors ${active ? "text-osu-pink-light cursor-pointer hover:text-osu-pink" : "text-osu-f1/55 cursor-default"}`}
        title={active ? "Clear" : undefined}
      >
        {label}{active ? " ✕" : ""}
      </button>
    </div>
  );
}
