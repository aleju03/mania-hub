import type { ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { RangePill, type RangePillSkin } from "./RangePill";
import { PATTERN_COLOR } from "../../lib/pattern-labels";

// The LN share filter (hold share of the map, in percent) on the same
// stretchable pill as the difficulty filter, in the LN family colour.
interface Props {
  min: number;
  max: number;
  onChange: (min: number, max: number) => void;
  ariaLabel: string;
  heading?: ReactNode;
}

const LN_COLOR = PATTERN_COLOR.ln ?? "#f07474";

export function LnSharePill({ min, max, onChange, ariaLabel, heading }: Props) {
  const { t } = useLingui();
  const skin: RangePillSkin = {
    // Faint at 0%, full LN colour at 100%, so the pill reads as "more LN" to the right.
    gradient: (from, to) => `linear-gradient(90deg, color-mix(in srgb, ${LN_COLOR} ${Math.round(35 + from * 0.65)}%, #2a2233), color-mix(in srgb, ${LN_COLOR} ${Math.round(35 + to * 0.65)}%, #2a2233))`,
    format: (v) => `${Math.round(v)}%`,
    valueText: (v) => `${Math.round(v)}%`,
    textColor: (center) => (center >= 45 ? "hsl(0, 20%, 10%)" : "hsl(0, 30%, 94%)"),
    labelColor: () => LN_COLOR,
    bucket: 10,
    decorations: /%/g,
    placeholder: "40-60",
    typeHint: t`Type a range: 40-60, 50+, <30`,
  };
  return <RangePill lo={0} hi={100} min={min} max={max} step={5} onChange={onChange} ariaLabel={ariaLabel} skin={skin} heading={heading} />;
}
