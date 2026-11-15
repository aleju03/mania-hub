import { useId } from "react";
import type { ChainModId } from "#/lib/chain-run";
import { KIT } from "./chainKit";

/* A mod card as an enamel pin: each mod's emblem cut as the pin itself,
   flat glossy enamel inside polished gold, with a soft shine and the drop
   shadow of a pin lying on the table. Drawn on a 100 grid. */
const ENAMEL = {
  cream: "#f3e9d8",
  ink: "#120c18",
  pink: "#ff7ab8",
  pinkDeep: "#d94f8f",
  gold: "#f6c343",
  red: "#e0446a",
  sky: "#9fd8ff",
  blue: "#3b82c4",
  silver: "#cfd6df",
  steel: "#8a96a6",
  teal: "#2cc5b0",
  green: "#59c96b",
  greenDeep: "#2f8f4a",
  slate: "#5b6b82",
};

function PinArt({ id, metal, rainbow }: { id: ChainModId; metal: string; rainbow: string }) {
  // Enamel with a gold edge: the stroke is the pin's metal.
  const e = (fill: string, width = 5) => ({ fill, stroke: metal, strokeWidth: width, strokeLinejoin: "round" as const, paintOrder: "stroke" as const });
  // A line drawn in metal with enamel down its middle.
  const line = (d: string, fill: string, width: number, key?: string) => (
    <g key={key}>
      <path d={d} fill="none" stroke={metal} strokeWidth={width + 7} strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} fill="none" stroke={fill} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
  switch (id) {
    case "mirror":
      return (
        <>
          <path d="M44 64 H56 L59 88 Q50 96 41 88 Z" {...e(ENAMEL.pink)} />
          <ellipse cx={50} cy={38} rx={28} ry={31} {...e(ENAMEL.gold)} />
          <ellipse cx={50} cy={38} rx={20} ry={23} {...e(ENAMEL.sky, 3)} />
          <path d="M37 32 L47 18 L52 20 L42 35 Z M40 42 L54 22 L57 25 L44 45 Z" fill={ENAMEL.cream} opacity={0.9} />
        </>
      );
    case "pfc":
      return (
        <>
          <path d="M14 72 L19 30 L36 50 L50 22 L64 50 L81 30 L86 72 Z" {...e(ENAMEL.gold)} />
          <path d="M14 72 H86 V86 H14 Z" {...e(ENAMEL.red)} />
          {[
            [19, 30],
            [50, 22],
            [81, 30],
          ].map(([x, y]) => (
            <circle key={x} cx={x} cy={y} r={6} {...e(ENAMEL.cream, 3)} />
          ))}
          {[30, 50, 70].map((x) => (
            <circle key={x} cx={x} cy={79} r={3.2} fill={ENAMEL.cream} />
          ))}
        </>
      );
    case "silver":
      return (
        <>
          <path d="M30 6 L46 6 L56 40 L42 46 Z" {...e(ENAMEL.blue)} />
          <path d="M70 6 L54 6 L44 40 L58 46 Z" {...e(ENAMEL.cream)} />
          <circle cx={50} cy={64} r={27} {...e(ENAMEL.silver)} />
          <circle cx={50} cy={64} r={19} {...e(ENAMEL.steel, 2.5)} />
          <path d="M50 51 L53.8 59.8 L63.3 60.6 L56.1 66.9 L58.2 76.2 L50 71.3 L41.8 76.2 L43.9 66.9 L36.7 60.6 L46.2 59.8 Z" fill={ENAMEL.silver} />
        </>
      );
    case "replay":
      // A circle running round the play button, its head pointing into the gap at the top.
      return (
        <>
          {line("M44.8 22.5 A30 30 0 1 0 62.2 24.6", ENAMEL.teal, 12)}
          <path d="M52.5 18.8 L71.5 15.6 L60.5 35.6 Z" {...e(ENAMEL.teal, 5)} />
          <path d="M42 38 L63 52 L42 66 Z" {...e(ENAMEL.cream, 4)} />
        </>
      );
    case "max":
      return (
        <path
          d="M50 8 L61.5 36.5 L92 38.5 L68.5 58 L76 88 L50 71.5 L24 88 L31.5 58 L8 38.5 L38.5 36.5 Z"
          {...e(rainbow, 6)}
        />
      );
    case "random":
      return (
        <>
          <path d="M50 10 L86 30 L50 50 L14 30 Z" {...e("#ff9ccb")} />
          <path d="M14 30 L50 50 L50 92 L14 72 Z" {...e(ENAMEL.pinkDeep)} />
          <path d="M86 30 L50 50 L50 92 L86 72 Z" {...e(ENAMEL.pink)} />
          <ellipse cx={50} cy={30} rx={6.5} ry={3.8} fill={ENAMEL.cream} />
          {[
            [24, 44],
            [40, 76],
            [32, 60],
          ].map(([x, y]) => (
            <ellipse key={`l${x}`} cx={x} cy={y} rx={3.8} ry={5.2} fill={ENAMEL.cream} />
          ))}
          {[
            [60, 56],
            [76, 48],
            [60, 76],
            [76, 68],
          ].map(([x, y]) => (
            <ellipse key={`r${x}${y}`} cx={x} cy={y} rx={3.8} ry={5.2} fill={ENAMEL.cream} />
          ))}
        </>
      );
    case "chameleon": {
      // Side on, gripping a branch: arched back, crested head, turret eye,
      // curled tail. Body, tail and legs are one piece: every gold edge goes
      // down first and the enamel over all of it, so no part sits behind another.
      const body = "M30 62 C29 40 50 28 68 34 C72 26 82 26 86 35 L93 45 C88 52 80 55 71 55 C60 62 44 67 30 62 Z";
      const tail = "M33 61 C20 61 13 71 17 79 C21 87 33 85 33 77 C33 71 25 71 26 76";
      const legs = "M44 64 L40 74 M66 58 L70 71";
      return (
        <>
          {line("M8 78 L92 72", "#8a5a2b", 6)}
          <path d={tail} fill="none" stroke={metal} strokeWidth={15} strokeLinecap="round" strokeLinejoin="round" />
          <path d={legs} fill="none" stroke={metal} strokeWidth={12} strokeLinecap="round" />
          <path d={body} fill={metal} stroke={metal} strokeWidth={10} strokeLinejoin="round" />
          <path d={tail} fill="none" stroke={ENAMEL.green} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
          <path d={legs} fill="none" stroke={ENAMEL.green} strokeWidth={5} strokeLinecap="round" />
          <path d={body} fill={ENAMEL.green} />
          <path d="M40 46 C48 40 58 38 66 42 M38 55 C48 50 58 49 66 51" fill="none" stroke={ENAMEL.greenDeep} strokeWidth={3} strokeLinecap="round" />
          <circle cx={78} cy={42} r={7.5} {...e("#a8e8a0", 3.5)} />
          <circle cx={79.5} cy={42} r={3.2} fill={ENAMEL.ink} />
        </>
      );
    }
    case "anchor":
      return (
        <>
          {line("M50 26 V82", ENAMEL.slate, 9)}
          {line("M32 38 H68", ENAMEL.slate, 9)}
          {line("M20 60 Q22 86 50 86 Q78 86 80 60", ENAMEL.slate, 9)}
          <path d="M11 66 L20 52 L30 66 Z" {...e(ENAMEL.slate)} />
          <path d="M70 66 L80 52 L89 66 Z" {...e(ENAMEL.slate)} />
          <circle cx={50} cy={17} r={9} {...e(ENAMEL.slate)} />
          <circle cx={50} cy={17} r={3.5} fill={ENAMEL.ink} />
        </>
      );
    case "keyChange":
      return (
        <>
          {line("M28 30 Q50 6 72 30", ENAMEL.gold, 6)}
          <path d="M64 22 L78 34 L62 37 Z" {...e(ENAMEL.gold, 4)} />
          <rect x={10} y={42} width={36} height={40} rx={7} {...e(ENAMEL.cream)} />
          <rect x={16} y={46} width={24} height={24} rx={4} fill="#fffaf0" />
          <rect x={54} y={42} width={36} height={40} rx={7} {...e(ENAMEL.blue)} />
          <rect x={60} y={46} width={24} height={24} rx={4} fill="#6aa6e0" />
        </>
      );
    case "rateUp":
      return (
        <>
          <path d="M10 72 A40 40 0 0 1 90 72 Z" {...e("#1e1b2e")} />
          <path d="M20 72 A30 30 0 0 1 33 47" fill="none" stroke={ENAMEL.green} strokeWidth={7} />
          <path d="M35 46 A30 30 0 0 1 65 46" fill="none" stroke={ENAMEL.gold} strokeWidth={7} />
          <path d="M67 47 A30 30 0 0 1 80 72" fill="none" stroke={ENAMEL.red} strokeWidth={7} />
          {line("M50 72 L74 52", ENAMEL.cream, 5)}
          <circle cx={50} cy={72} r={7} {...e(ENAMEL.cream, 4)} />
          <path d="M10 72 H90 V80 Q50 86 10 80 Z" {...e(ENAMEL.gold)} />
        </>
      );
  }
}

export function ModChip({ id, size, picked = false }: { id: ChainModId; size: number; picked?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const metal = `url(#pin-metal-${uid})`;
  return (
    <svg
      viewBox="-6 -6 112 116"
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0 overflow-visible"
      style={picked ? { filter: `drop-shadow(0 0 6px ${KIT.pink}) drop-shadow(0 0 2px ${KIT.pink})` } : undefined}
    >
      <defs>
        <linearGradient id={`pin-metal-${uid}`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#fff3c2" />
          <stop offset="0.45" stopColor="#e4ae45" />
          <stop offset="0.8" stopColor="#a87318" />
          <stop offset="1" stopColor="#6b4508" />
        </linearGradient>
        <linearGradient id={`pin-rainbow-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8fd0" />
          <stop offset="0.2" stopColor="#ff8fd0" />
          <stop offset="0.2" stopColor="#ffd36b" />
          <stop offset="0.4" stopColor="#ffd36b" />
          <stop offset="0.4" stopColor="#8ff2b7" />
          <stop offset="0.6" stopColor="#8ff2b7" />
          <stop offset="0.6" stopColor="#7fd3ff" />
          <stop offset="0.8" stopColor="#7fd3ff" />
          <stop offset="0.8" stopColor="#c4b2ff" />
          <stop offset="1" stopColor="#c4b2ff" />
        </linearGradient>
        <filter id={`pin-shine-${uid}`} x="-15%" y="-15%" width="130%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" result="blur" />
          <feSpecularLighting in="blur" surfaceScale="3" specularConstant="0.75" specularExponent="22" lightingColor="#ffffff" result="spec">
            <feDistantLight azimuth="235" elevation="48" />
          </feSpecularLighting>
          <feComposite in="spec" in2="SourceAlpha" operator="in" result="shine" />
          <feDropShadow in="SourceGraphic" dx="0" dy="3" stdDeviation="1.6" floodColor="#000" floodOpacity="0.5" result="shadow" />
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="shine" />
          </feMerge>
        </filter>
      </defs>
      <g filter={`url(#pin-shine-${uid})`}>
        <PinArt id={id} metal={metal} rainbow={`url(#pin-rainbow-${uid})`} />
      </g>
    </svg>
  );
}
