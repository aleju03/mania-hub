import { useId } from "react";
import type { ManiaCardTier } from "#/lib/maniacard";

/* The rank ladder's badge: a mania key per tier. The legend on the key climbs
   from blank through notes, a stair, an LN and a star to a crown, and the top
   two tiers add wings and a laurel around the key. Drawn on a 48-unit grid. */

export type LadderTier = Exclude<ManiaCardTier, "eternal" | "goat">;

interface CapStyle {
  top: string[];
  skirt: [string, string, string];
  edge: string;
  legend: string;
  shadow?: string;
}

const CAPS: Record<LadderTier, CapStyle> = {
  common: { top: ["#cbd5e1", "#94a3b8"], skirt: ["#7c8aa0", "#334155", "#1e293b"], edge: "#141b26", legend: "#fff" },
  rare: { top: ["#7dd3fc", "#0ea5e9"], skirt: ["#0ea5e9", "#0369a1", "#172554"], edge: "#0f1837", legend: "#fff" },
  elite: { top: ["#c4b5fd", "#8b5cf6"], skirt: ["#8b5cf6", "#6d28d9", "#2e1065"], edge: "#1e0a42", legend: "#fff" },
  superRare: { top: ["#f0abfc", "#d946ef"], skirt: ["#d946ef", "#a21caf", "#4a044e"], edge: "#300333", legend: "#fff" },
  ultraRare: { top: ["#fda4cb", "#ff4d94"], skirt: ["#ff4d94", "#be185d", "#5c0d33"], edge: "#3c0821", legend: "#fff" },
  legendary: { top: ["#fef3a3", "#fbbf24"], skirt: ["#fbbf24", "#d97706", "#78350f"], edge: "#4e220a", legend: "#fff", shadow: "#92400e" },
  mythic: { top: ["#fca5a5", "#ef4444"], skirt: ["#dc2626", "#7f1d1d", "#1c0505"], edge: "#120303", legend: "#fde68a", shadow: "#450a0a" },
  ascendant: { top: ["#ffffff", "#fde68a", "#f0abfc"], skirt: ["#f5d0fe", "#c026d3", "#4a044e"], edge: "#300333", legend: "#7e22ce", shadow: "#ffffff" },
  worldClass: { top: ["#10b981", "#064e3b"], skirt: ["#065f46", "#022c22", "#000000"], edge: "#34d399", legend: "#6ee7b7", shadow: "#000000" },
};

const SKIRT = "M12.6 6.5 H35.4 Q38.6 6.5 39 9.8 L41.8 37.2 Q42.2 42 37.4 42 H10.6 Q5.8 42 6.2 37.2 L9 9.8 Q9.4 6.5 12.6 6.5Z";
const CROWN = "M-6.4 4.2 L-7.2 -4 L-3.2 -.6 L0 -5.8 L3.2 -.6 L7.2 -4 L6.4 4.2 Z";
const WING = "M18 17.5 C13.5 12.5 8.5 9.2 2 8.2 C2.8 10.8 4.3 12.8 6.4 14 C4.6 14.8 3.6 16.2 3.3 17.6 C5.8 18.3 8.3 18.4 10.2 18.1 C8.7 19.2 7.8 20.6 7.6 22.1 C10.6 22.5 13.8 22.2 17 24.5 Z";
const WING_FEATHERS = "M6.4 14 C9.5 14.6 12.5 15.6 15.5 17.8 M10.2 18.1 C12.4 18.4 14.4 19.4 16.3 20.8";

const points = (pts: Array<[number, number]>) => pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
const STAR = points(Array.from({ length: 10 }, (_, i) => {
  const a = ((-90 + i * 36) * Math.PI) / 180;
  const r = i % 2 ? 7.6 * 0.45 : 7.6;
  return [24 + r * Math.cos(a), 20 + r * Math.sin(a)] as [number, number];
}));

/* Left laurel branch grown bottom to top along a circle; mirrored for the right. */
const LAUREL_CENTER = 24;
const LAUREL_R = 18.5;
const laurelPoint = (deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180;
  return [LAUREL_CENTER + LAUREL_R * Math.cos(r), LAUREL_CENTER + LAUREL_R * Math.sin(r)];
};
const LAUREL_STEM = Array.from({ length: 47 }, (_, i) => laurelPoint(98 + i * 3))
  .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
const tangentAngle = (deg: number) => {
  const r = (deg * Math.PI) / 180;
  return (Math.atan2(-Math.sin(r), -Math.cos(r)) * 180) / Math.PI;
};
const LAUREL_LEAVES = [
  ...Array.from({ length: 6 }, (_, i) => {
    const deg = 112 + i * 23;
    const len = 7.6 - i * 0.45;
    return [
      { at: laurelPoint(deg), angle: tangentAngle(deg) - 34, len },
      { at: laurelPoint(deg), angle: tangentAngle(deg) + 30, len: len * 0.85 },
    ];
  }).flat(),
  { at: laurelPoint(238), angle: tangentAngle(238), len: 5.5 },
];

function Leaf({ at: [x, y], angle, len }: { at: [number, number]; angle: number; len: number }) {
  const half = (side: number) => `M0 0 C${2.7 * side} -${(len * 0.3).toFixed(2)} ${2.5 * side} -${(len * 0.75).toFixed(2)} 0 -${len.toFixed(2)} Z`;
  return (
    <g transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle.toFixed(1)})`}>
      <path d={half(-1)} fill="#7addb8" />
      <path d={half(1)} fill="#0c8f65" />
    </g>
  );
}

function LaurelBranch() {
  return (
    <>
      <path d={LAUREL_STEM} fill="none" stroke="#0b8860" strokeWidth="1.3" strokeLinecap="round" />
      {LAUREL_LEAVES.map((leaf, i) => <Leaf key={i} {...leaf} />)}
    </>
  );
}

function Wing({ gradient }: { gradient: string }) {
  return (
    <>
      <path d={WING} fill={`url(#${gradient})`} stroke="#5f1a9b" strokeWidth="1" strokeLinejoin="round" />
      <path d={WING_FEATHERS} fill="none" stroke="#f6cdfd" strokeWidth=".9" strokeLinecap="round" />
    </>
  );
}

function Note({ x, y, w }: { x: number; y: number; w: number }) {
  return <rect x={x - w / 2} y={y - 1.8} width={w} height="3.6" rx="1.4" />;
}

function legendShapes(tier: LadderTier) {
  switch (tier) {
    case "common": return null;
    case "rare": return <Note x={24} y={19.5} w={9} />;
    case "elite": return <><Note x={20.2} y={23} w={6.6} /><Note x={27.8} y={16} w={6.6} /></>;
    case "superRare": return <><Note x={17.2} y={25} w={5.6} /><Note x={24} y={19.5} w={5.6} /><Note x={30.8} y={14} w={5.6} /></>;
    case "ultraRare": return <><Note x={24} y={26} w={7.4} /><Note x={24} y={13} w={7.4} /></>;
    case "legendary": return <polygon points={STAR} strokeLinejoin="round" />;
    default: return <path transform="translate(24 20) scale(1.05)" d={CROWN} strokeLinejoin="round" />;
  }
}

function Cap({ tier, id }: { tier: LadderTier; id: string }) {
  const cap = CAPS[tier];
  const shapes = legendShapes(tier);
  const topStops = cap.top.length === 3 ? [0, 0.5, 1] : [0, 1];
  return (
    <>
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2=".25">
          <stop offset="0" stopColor={cap.skirt[0]} />
          <stop offset=".45" stopColor={cap.skirt[1]} />
          <stop offset="1" stopColor={cap.skirt[2]} />
        </linearGradient>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2={cap.top.length === 3 ? ".9" : ".35"} y2="1">
          {cap.top.map((color, i) => <stop key={i} offset={topStops[i]} stopColor={color} />)}
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".35" />
        </linearGradient>
      </defs>
      {/* Skirt: wider at the base so the key reads as standing up, front face shaded. */}
      <path d={SKIRT} fill={`url(#${id}s)`} />
      <path d="M7.6 32 H40.4 L41.8 37.2 Q42.2 42 37.4 42 H10.6 Q5.8 42 6.2 37.2Z" fill={`url(#${id}f)`} />
      <path d={SKIRT} fill="none" stroke={cap.edge} strokeWidth="1.1" strokeLinejoin="round" />
      {/* Dished top face: darker lip along the top edge, light catch along the left and bottom. */}
      <rect x="12" y="8.5" width="24" height="22.5" rx="4.6" fill={`url(#${id}t)`} />
      <path d="M12.6 12.6 Q13 8.5 16.6 8.5 H31.4 Q35 8.5 35.4 12.6 Q24 10.2 12.6 12.6Z" fill="#000" opacity=".12" />
      <path d="M15.5 30.4 H32.5" stroke="#fff" strokeWidth="1" strokeLinecap="round" opacity=".35" />
      <path d="M13.6 25 V13.2 Q13.6 10.2 16.6 10.2" stroke="#fff" strokeWidth="1.2" fill="none" strokeLinecap="round" opacity=".45" />
      {tier === "ultraRare" && <rect x="21.2" y="13" width="5.6" height="13" fill={cap.legend} opacity=".45" />}
      {shapes && (
        <>
          <g transform="translate(0 .9)" fill={cap.shadow ?? "#000"} opacity={cap.shadow ? 0.45 : 0.28}>{shapes}</g>
          <g fill={cap.legend}>{shapes}</g>
        </>
      )}
    </>
  );
}

export function RankKeycap({ tier, size = 26, className }: { tier: LadderTier; size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-hidden="true">
      {tier === "ascendant" ? (
        <>
          <defs>
            <linearGradient id={`${id}w`} x1="0" y1="0" x2=".9" y2=".6">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset=".55" stopColor="#ffffff" />
              <stop offset="1" stopColor="#f4c0fd" />
            </linearGradient>
          </defs>
          <g transform="translate(0 1.5)">
            <Wing gradient={`${id}w`} />
            <g transform="translate(48 0) scale(-1 1)"><Wing gradient={`${id}w`} /></g>
          </g>
          <g transform="translate(24 27) scale(.78) translate(-24 -24)"><Cap tier={tier} id={id} /></g>
        </>
      ) : tier === "worldClass" ? (
        <>
          <LaurelBranch />
          <g transform="translate(48 0) scale(-1 1)"><LaurelBranch /></g>
          <g transform="translate(24 24.5) scale(.66) translate(-24 -24)"><Cap tier={tier} id={id} /></g>
        </>
      ) : (
        <Cap tier={tier} id={id} />
      )}
    </svg>
  );
}
