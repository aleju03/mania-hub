// Radar chart of a map's 8-family pattern vector (values 0..1). Styled to match
// the farm-helper difficulty radar so it feels native.

import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

// Axis names are the short forms the radar has room for; they carry their own
// descriptors because the full pattern names in SearchCard are too long here.
const AXES: Array<{ id: string; label: MessageDescriptor }> = [
  { id: "jack", label: msg`JACK` },
  { id: "stream", label: msg`STREAM` },
  { id: "jumpstream", label: msg`JS` },
  { id: "handstream", label: msg`HS` },
  { id: "stamina", label: msg`STAM` },
  { id: "chordjack", label: msg`CJ` },
  { id: "tech", label: msg`TECH` },
  { id: "ln", label: msg`LN` },
];

const SIZE = 260;
const CENTER = SIZE / 2;
const MAX_RADIUS = 82;
const LABEL_RADIUS = 106;
const RINGS = [0.33, 0.66, 1];

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

function polygonPoints(scale: number): string {
  return AXES.map((_, index) => {
    const angle = -Math.PI / 2 + (index / AXES.length) * Math.PI * 2;
    const radius = MAX_RADIUS * scale;
    return `${CENTER + Math.cos(angle) * radius},${CENTER + Math.sin(angle) * radius}`;
  }).join(" ");
}

export function PatternRadar({ patterns }: { patterns: Record<string, number> }) {
  const { t, i18n } = useLingui();
  const points = AXES.map((axis, index) => {
    const angle = -Math.PI / 2 + (index / AXES.length) * Math.PI * 2;
    const value = clamp01(patterns[axis.id] ?? 0);
    const radius = MAX_RADIUS * value;
    return {
      id: axis.id,
      label: i18n._(axis.label),
      x: CENTER + Math.cos(angle) * radius,
      y: CENTER + Math.sin(angle) * radius,
      axisX: CENTER + Math.cos(angle) * MAX_RADIUS,
      axisY: CENTER + Math.sin(angle) * MAX_RADIUS,
      labelX: CENTER + Math.cos(angle) * LABEL_RADIUS,
      labelY: CENTER + Math.sin(angle) * LABEL_RADIUS,
    };
  });
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-auto w-full max-w-[196px] text-osu-pink" role="img" aria-label={t`Pattern radar chart`}>
      {RINGS.map((ring) => (
        <polygon key={ring} points={polygonPoints(ring)} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
      ))}
      {points.map((point) => (
        <line key={point.id} x1={CENTER} y1={CENTER} x2={point.axisX} y2={point.axisY} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
      ))}
      <polygon points={polygon} fill="currentColor" fillOpacity="0.24" stroke="currentColor" strokeWidth="2" />
      {points.map((point) => (
        <g key={point.id}>
          <circle cx={point.x} cy={point.y} r="2.5" fill="currentColor" />
          <text
            x={point.labelX}
            y={point.labelY}
            textAnchor={point.labelX < CENTER - 4 ? "end" : point.labelX > CENTER + 4 ? "start" : "middle"}
            dominantBaseline="middle"
            className="fill-osu-f1 text-[10px] font-black uppercase"
          >
            {point.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
