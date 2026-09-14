import { useLingui } from "@lingui/react/macro";
import { RangePill, type RangePillSkin } from "./RangePill";
import { starRatingColor, starSpectrumGradient } from "./SearchCard";

// The difficulty filter as a stretchable difficulty badge: the osu-web star
// pill on a faint spectrum rail. The drag/typing behaviour lives in RangePill;
// this is the star skin: spectrum colours, one-decimal stars, the star glyph.
interface Props {
  lo: number;
  hi: number;
  min: number;
  max: number;
  step: number;
  onChange: (min: number, max: number) => void;
  ariaLabel: string;
}

const STAR_PATH = "M12 1.7l3.1 6.9 7.2.8-5.4 5 1.5 7.2L12 17.9l-6.4 3.7 1.5-7.2-5.4-5 7.2-.8L12 1.7z";

// Last real spectrum stop; osu-web paints everything at or past it black.
const SPECTRUM_END = 9;
// Share of the rail given to the black SPECTRUM_END..hi tail.
const TAIL_FRACTION = 0.15;

export function StarRangePill({ lo, hi, min, max, step, onChange, ariaLabel }: Props) {
  const { t } = useLingui();
  const span = hi - lo || 1;
  // osu-web's spectrum ends at 9★ (everything past it is pure black), but the
  // filter runs to `hi`. Lay the live spectrum across most of the rail and
  // squeeze the dead 9..hi black tail into a short stub so the pill isn't
  // 40% black at rest.
  const knee = Math.min(SPECTRUM_END, hi);
  const hasTail = hi > SPECTRUM_END && lo < SPECTRUM_END;
  const posFrac = (stars: number) => {
    if (!hasTail) return (stars - lo) / span;
    if (stars <= knee) return ((stars - lo) / (knee - lo)) * (1 - TAIL_FRACTION);
    return 1 - TAIL_FRACTION + ((stars - knee) / (hi - knee)) * TAIL_FRACTION;
  };
  const fracToValue = (frac: number) => {
    if (!hasTail) return lo + frac * span;
    if (frac <= 1 - TAIL_FRACTION) return lo + (frac / (1 - TAIL_FRACTION)) * (knee - lo);
    return knee + ((frac - (1 - TAIL_FRACTION)) / TAIL_FRACTION) * (hi - knee);
  };
  const skin: RangePillSkin = {
    posFrac,
    fracToValue,
    gradient: starSpectrumGradient,
    format: (v) => v.toFixed(1),
    valueText: (v) => `${v.toFixed(1)} stars`,
    // Same text rule as StarRatingBadge.
    textColor: (center) => (center >= 6.5 ? "hsl(45, 100%, 70%)" : "hsl(200, 10%, 10%)"),
    labelColor: (mid) => starRatingColor(Math.min(mid, 6)),
    icon: (
      <svg viewBox="0 0 24 24" className="h-[9px] w-[9px] shrink-0" fill="currentColor" aria-hidden="true">
        <path d={STAR_PATH} />
      </svg>
    ),
    bucket: 1,
    decorations: /★/g,
    placeholder: "3.6-6.7",
    typeHint: t`Type a range: 3.6-6.7, 5+, <4`,
  };
  return <RangePill lo={lo} hi={hi} min={min} max={max} step={step} onChange={onChange} ariaLabel={ariaLabel} skin={skin} />;
}
