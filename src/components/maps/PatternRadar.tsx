// Radar chart of a map's 8-family pattern vector (values 0..1). Styled to match
// the farm-helper difficulty radar so it feels native.

const AXES: Array<{ id: string; label: string }> = [
  { id: "jack", label: "JACK" },
  { id: "stream", label: "STREAM" },
  { id: "jumpstream", label: "JS" },
  { id: "handstream", label: "HS" },
  { id: "stamina", label: "STAM" },
  { id: "chordjack", label: "CJ" },
  { id: "tech", label: "TECH" },
  { id: "ln", label: "LN" },
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
  const points = AXES.map((axis, index) => {
    const angle = -Math.PI / 2 + (index / AXES.length) * Math.PI * 2;
    const value = clamp01(patterns[axis.id] ?? 0);
    const radius = MAX_RADIUS * value;
    return {
      id: axis.id,
      label: axis.label,
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
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-auto w-full max-w-[196px] text-osu-pink" role="img" aria-label="Pattern radar chart">
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
