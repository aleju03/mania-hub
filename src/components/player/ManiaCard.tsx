import {
  computeManiaSkills,
  getManiaCardTier,
  MANIA_TIER_STYLES,
  type ManiaSkills,
  type ManiaCardTier,
} from "../../lib/maniacard";
import { ManiaCard3DPanel } from "./maniacard3d/ManiaCard3DPanel";
import type { OsuScore, OsuUser } from "../../lib/types";
import { useCallback, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";

const STAR_PATH =
  "M12 2.5l2.92 5.92 6.54.95-4.73 4.61 1.12 6.52L12 17.51l-5.85 3 1.12-6.52L2.54 9.37l6.54-.95L12 2.5z";
const IDLE_GLARE_OPACITY = 0.32;
const FOIL_INTENSITY = 0.62;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function StarRow({ value, color, size = 24 }: { value: number; color: string; size?: number }) {
  const max = Math.min(10, Math.max(1, Math.ceil(value)));
  const stars: ("full" | "half" | "empty")[] = [];
  for (let i = 0; i < max; i++) {
    const remaining = value - i;
    if (remaining >= 1) stars.push("full");
    else if (remaining >= 0.5) stars.push("half");
    else stars.push("empty");
  }
  return (
    <div className="flex items-center gap-0.5 justify-center">
      {stars.map((kind, i) => (
        <svg
          key={i}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          aria-hidden
          className={color}
          style={{ filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.45))" }}
        >
          <defs>
            <linearGradient id={`mc-half-${i}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="50%" stopColor="currentColor" />
              <stop offset="50%" stopColor="currentColor" stopOpacity="0.22" />
            </linearGradient>
          </defs>
          <path
            d={STAR_PATH}
            fill={
              kind === "full"
                ? "currentColor"
                : kind === "half"
                  ? `url(#mc-half-${i})`
                  : "currentColor"
            }
            fillOpacity={kind === "empty" ? 0.22 : 1}
            stroke="rgba(0,0,0,0.3)"
            strokeWidth={0.75}
          />
        </svg>
      ))}
    </div>
  );
}

function TrianglePattern({
  opacity,
  idSuffix,
  animated = true,
}: {
  opacity: number;
  idSuffix: string;
  animated?: boolean;
}) {
  const patternId = `mc-triangles-${idSuffix}`;
  const layers = [
    { id: `${patternId}-slow`, opacity: 0.46, from: "0 0", to: "0 -78", dur: "8.5s" },
    { id: `${patternId}-mid`, opacity: 0.34, from: "34 18", to: "34 -60", dur: "5.75s" },
    { id: `${patternId}-fast`, opacity: 0.22, from: "-26 42", to: "-26 -36", dur: "4.2s" },
  ];

  return (
    <svg
      className="maniacard-triangle-pattern absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden
      style={{ opacity }}
    >
      <defs>
        {layers.map((layer) => (
          <pattern key={layer.id} id={layer.id} width="90" height="78" patternUnits="userSpaceOnUse">
            {animated ? (
              <animateTransform
                attributeName="patternTransform"
                type="translate"
                from={layer.from}
                to={layer.to}
                dur={layer.dur}
                repeatCount="indefinite"
              />
            ) : null}
            <polygon points="45,8 82,70 8,70" fill="rgba(255,255,255,0.08)" />
            <polygon points="10,36 32,74 -12,74" fill="rgba(255,255,255,0.05)" />
            <polygon points="80,36 102,74 58,74" fill="rgba(255,255,255,0.05)" />
            <polygon points="58,2 70,22 46,22" fill="rgba(255,255,255,0.04)" />
            <polygon points="20,0 32,18 8,18" fill="rgba(0,0,0,0.08)" />
          </pattern>
        ))}
      </defs>
      {layers.map((layer) => (
        <rect
          key={layer.id}
          width="100%"
          height="100%"
          fill={`url(#${layer.id})`}
          opacity={layer.opacity}
        />
      ))}
    </svg>
  );
}

function NamePixelTrail() {
  const blocks = [
    "left-0 top-1 h-4 w-4 bg-black/26",
    "left-0 top-7 h-2.5 w-2.5 bg-black/34",
    "left-4 top-6 h-2 w-2 bg-white/14",
    "left-7 top-0 h-3 w-3 bg-black/18",
    "left-8 top-5 h-2.5 w-2.5 bg-black/30",
    "left-8 top-10 h-2 w-2 bg-white/12",
    "left-12 top-2 h-2.5 w-2.5 bg-black/22",
    "left-[52px] top-8 h-2 w-2 bg-black/30",
    "left-[68px] top-5 h-1.5 w-1.5 bg-white/10",
    "left-20 top-1 h-1.5 w-1.5 bg-black/18",
  ];

  return (
    <div
      className="absolute left-0 top-1/2 h-14 w-24 -translate-y-1/2 pointer-events-none"
      aria-hidden
    >
      {blocks.map((block, index) => (
        <span key={index} className={`absolute rounded-[1px] ${block}`} />
      ))}
    </div>
  );
}

// Official osu!mania glyph from osu-web's "extra" icon font
// (resources/fonts/extra/extra.svg, unicode U+E802). SVG font y-axis is
// inverted vs. SVG coordinates, hence the translate/scale matrix.
const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

function ManiaModeIcon({ tier }: { tier: ManiaCardTier }) {
  const tint = MANIA_TIER_STYLES[tier];
  const badgePatternId = `mc-badge-tris-${tier}`;

  return (
    <div className="relative h-[52px] w-[52px] sm:h-[68px] sm:w-[68px]">
      <div
        className="absolute -inset-2 rounded-[26px] pointer-events-none"
        style={{
          background: `radial-gradient(circle, ${tint.badgeHalo} 0%, transparent 70%)`,
          filter: "blur(6px)",
        }}
      />
      <div
        className="relative h-full w-full overflow-hidden rounded-[18px]"
        style={{ background: tint.badgeGradient }}
      >
        <svg
          className="absolute inset-0 h-full w-full pointer-events-none opacity-80"
          aria-hidden
        >
          <defs>
            <pattern
              id={badgePatternId}
              width="30"
              height="26"
              patternUnits="userSpaceOnUse"
            >
              <polygon
                points="15,3 28,22 2,22"
                fill="rgba(255,255,255,0.14)"
              />
              <polygon
                points="3,12 11,23 -5,23"
                fill="rgba(0,0,0,0.12)"
              />
              <polygon
                points="27,12 35,23 19,23"
                fill="rgba(255,255,255,0.08)"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${badgePatternId})`} />
        </svg>
        <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/22 to-transparent pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/25 to-transparent pointer-events-none" />
        <div className="absolute inset-0 rounded-[18px] ring-1 ring-white/35 pointer-events-none" />
        <div className="absolute inset-[2px] rounded-[16px] ring-1 ring-black/20 pointer-events-none" />
        <div className="relative grid h-full w-full place-items-center">
          <svg
            viewBox="0 0 1000 1000"
            className="h-[72%] w-[72%]"
            aria-hidden
            style={{ filter: `drop-shadow(0 2px 3px ${tint.badgeGlyphShadow})` }}
          >
            <g transform="translate(0 850) scale(1 -1)" fill="#ffffff">
              <path d={MANIA_GLYPH_D} />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

function BackStar({
  x,
  y,
  size,
  opacity = 1,
  rotate = 0,
}: {
  x: number;
  y: number;
  size: number;
  opacity?: number;
  rotate?: number;
}) {
  return (
    <path
      d={STAR_PATH}
      transform={`translate(${x - size / 2} ${y - size / 2}) rotate(${rotate} ${size / 2} ${size / 2}) scale(${size / 24})`}
      fill="currentColor"
      opacity={opacity}
    />
  );
}

function BackSparkle({
  x,
  y,
  size,
  opacity = 1,
}: {
  x: number;
  y: number;
  size: number;
  opacity?: number;
}) {
  return (
    <path
      d={`M${x} ${y - size} L${x + size * 0.22} ${y - size * 0.22} L${x + size} ${y} L${x + size * 0.22} ${y + size * 0.22} L${x} ${y + size} L${x - size * 0.22} ${y + size * 0.22} L${x - size} ${y} L${x - size * 0.22} ${y - size * 0.22} Z`}
      fill="currentColor"
      opacity={opacity}
    />
  );
}

function ManiaCardBackDesign({
  tier,
  tierLabel,
  glowColor,
}: {
  tier: ManiaCardTier;
  tierLabel: string;
  glowColor: string;
}) {
  const accent = cssRgb(glowColor);
  const accentDisc = cssRgba(glowColor, 0.82);
  const accentLogoBed = cssRgba(glowColor, 0.54);
  const ringTicks = Array.from({ length: 36 }, (_, index) => {
    const angle = index * 10;
    const prominent = index % 6 === 0;
    return (
      <line
        key={index}
        x1="250"
        y1={prominent ? "168" : "178"}
        x2="250"
        y2="186"
        stroke="currentColor"
        strokeWidth={prominent ? 1.6 : 1}
        strokeLinecap="round"
        opacity={prominent ? 0.62 : 0.36}
        transform={`rotate(${angle} 250 350)`}
      />
    );
  });
  const orbitStars = [
    [250, 177, 20, 0],
    [355, 215, 18, 18],
    [397, 350, 19, -10],
    [355, 485, 18, 12],
    [250, 523, 20, 0],
    [145, 485, 18, -16],
    [103, 350, 19, 8],
    [145, 215, 18, -12],
  ] as const;
  const laurelMask = {
    WebkitMaskImage: "url('/images/maniacard/laurel-wreath.svg')",
    maskImage: "url('/images/maniacard/laurel-wreath.svg')",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  } as CSSProperties;

  return (
    <div
      className="maniacard-back-design absolute inset-0 text-white"
      style={{ "--mc-back-accent": accent, "--mc-back-glow": glowColor } as CSSProperties}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(255,255,255,0.23),transparent_34%),radial-gradient(circle_at_72%_68%,rgba(8,20,70,0.42),transparent_52%),linear-gradient(155deg,rgba(255,255,255,0.2),transparent_24%,rgba(0,0,0,0.22)_72%)]" />
      <svg
        viewBox="0 0 500 700"
        className="absolute inset-0 h-full w-full"
        aria-hidden
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={`mc-back-frame-${tier}`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0.9)" />
            <stop offset="0.34" stopColor="rgba(255,255,255,0.34)" />
            <stop offset="0.62" stopColor={accent} stopOpacity="0.92" />
            <stop offset="1" stopColor="rgba(255,255,255,0.5)" />
          </linearGradient>
          <linearGradient id={`mc-back-disc-${tier}`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0.72)" />
            <stop offset="0.24" stopColor={accent} stopOpacity="0.88" />
            <stop offset="0.55" stopColor={accentDisc} />
            <stop offset="1" stopColor="rgba(9,16,58,0.82)" />
          </linearGradient>
          <pattern id={`mc-back-micro-tris-${tier}`} width="48" height="42" patternUnits="userSpaceOnUse">
            <polygon points="24,3 45,39 3,39" fill="rgba(255,255,255,0.052)" />
            <polygon points="3,18 15,39 -9,39" fill="rgba(0,0,0,0.055)" />
            <polygon points="45,18 57,39 33,39" fill="rgba(255,255,255,0.035)" />
          </pattern>
        </defs>

        <rect width="500" height="700" fill={`url(#mc-back-micro-tris-${tier})`} opacity="0.84" />

        <path
          d="M43 48 Q43 30 61 30 H439 Q457 30 457 48 V170 Q441 178 441 194 V506 Q441 522 457 530 V652 Q457 670 439 670 H61 Q43 670 43 652 V530 Q59 522 59 506 V194 Q59 178 43 170 Z"
          fill="none"
          stroke={`url(#mc-back-frame-${tier})`}
          strokeWidth="4"
          opacity="0.9"
        />
        <path
          d="M53 54 Q53 40 67 40 H433 Q447 40 447 54 V166 Q431 176 431 194 V506 Q431 524 447 534 V646 Q447 660 433 660 H67 Q53 660 53 646 V534 Q69 524 69 506 V194 Q69 176 53 166 Z"
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(255,255,255,0.46)"
          strokeWidth="1.4"
        />

        <path
          d="M166 30 H334 L318 58 Q314 66 304 66 H196 Q186 66 182 58 Z"
          fill="rgba(32,8,70,0.28)"
          stroke="rgba(255,255,255,0.28)"
          strokeWidth="1.4"
        />
        <path
          d="M176 39 H324 M190 54 H310"
          fill="none"
          stroke="rgba(255,255,255,0.42)"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        {[210, 230, 250, 270, 290].map((x) => (
          <BackStar key={x} x={x} y={38} size={12} opacity={0.58} />
        ))}

        <path
          d="M172 670 H328 L312 656 Q307 652 299 652 H201 Q193 652 188 656 Z"
          fill="rgba(24,8,64,0.3)"
          stroke="rgba(255,255,255,0.24)"
          strokeWidth="1.4"
        />
        <path d="M196 663 H238 M262 663 H304" stroke="rgba(255,255,255,0.42)" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M250 656 L256 663 L250 670 L244 663 Z" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.58" />

        <path d="M35 220 V310 M35 376 V466 M465 220 V310 M465 376 V466" stroke="rgba(255,255,255,0.4)" strokeWidth="1.4" strokeLinecap="round" />
        {[205, 226, 247, 486, 509, 532].map((y) => (
          <g key={y}>
            <circle cx="35" cy={y} r="1.6" fill="currentColor" opacity="0.54" />
            <circle cx="465" cy={y} r="1.6" fill="currentColor" opacity="0.54" />
          </g>
        ))}

        <g>
          <circle cx="250" cy="350" r="181" fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.34" />
          <circle cx="250" cy="350" r="168" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 6" opacity="0.46" />
          <circle cx="250" cy="350" r="150" fill="none" stroke="rgba(255,255,255,0.26)" strokeWidth="1.5" />
          {ringTicks}
          {orbitStars.map(([x, y, size, rotate]) => (
            <BackStar key={`${x}-${y}`} x={x} y={y} size={size} rotate={rotate} opacity={0.76} />
          ))}
        </g>

        <circle cx="250" cy="350" r="129" fill="rgba(0,0,0,0.22)" />
        <circle cx="250" cy="350" r="121" fill={`url(#mc-back-disc-${tier})`} stroke="rgba(255,255,255,0.56)" strokeWidth="2.8" />
        <circle cx="250" cy="350" r="97" fill={accentLogoBed} stroke="rgba(255,255,255,0.12)" strokeWidth="1.2" />
        <circle cx="250" cy="350" r="76" fill="none" stroke="white" strokeWidth="12" opacity="0.98" />
        <g transform="translate(174 274) scale(0.152)" fill="#ffffff">
          <g transform="translate(0 850) scale(1 -1)">
            <path d={MANIA_GLYPH_D} />
          </g>
        </g>

        <BackSparkle x={105} y={180} size={17} opacity={0.82} />
        <BackSparkle x={405} y={205} size={9} opacity={0.48} />
        <BackSparkle x={412} y={515} size={14} opacity={0.62} />
        <BackSparkle x={96} y={525} size={10} opacity={0.54} />
        <BackSparkle x={149} y={173} size={4} opacity={0.5} />
        <BackSparkle x={356} y={527} size={4} opacity={0.48} />

      </svg>

      <div
        className="absolute inset-x-0 bottom-[13.5%] flex justify-center pointer-events-none"
        aria-hidden
      >
        <div className="relative h-[52px] w-[108px] sm:h-[58px] sm:w-[120px]">
          <span
            className="absolute inset-0 bg-white/42"
            style={{
              ...laurelMask,
              filter: "drop-shadow(0 0 10px var(--mc-back-glow)) drop-shadow(0 2px 4px rgba(0,0,0,0.34))",
            }}
          />
          <svg
            viewBox="0 0 24 24"
            className="absolute left-1/2 top-[47%] h-[28px] w-[28px] -translate-x-1/2 -translate-y-1/2 text-white/68 sm:h-[32px] sm:w-[32px]"
            style={{ filter: "drop-shadow(0 0 8px var(--mc-back-glow))" }}
          >
            <path d={STAR_PATH} fill="currentColor" />
          </svg>
        </div>
      </div>

      <div
        className="absolute inset-x-0 bottom-[7.8%] flex justify-center text-[20px] sm:text-[23px] font-black uppercase text-white/42"
        style={{
          fontFamily: "Torus, sans-serif",
          textShadow: "0 0 14px var(--mc-back-glow), 0 2px 8px rgba(0,0,0,0.45)",
        }}
      >
        <RarityLabel label={tierLabel} />
      </div>
    </div>
  );
}

function RarityLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center justify-center gap-[0.34em]" aria-label={label}>
      {label.toUpperCase().split("").map((char, index) => (
        <span
          key={`${char}-${index}`}
          className={char === " " ? "w-[0.48em]" : undefined}
          aria-hidden
        >
          {char === " " ? "" : char}
        </span>
      ))}
    </span>
  );
}

interface ManiaCardPanelProps {
  user: Pick<OsuUser, "id" | "username" | "avatar_url" | "country_code"> & {
    statistics?: { global_rank: number | null };
  };
  scores: OsuScore[];
  loading: boolean;
}

// Tier-specific visual knobs layered on top of the base tier style.
const TIER_VISUALS: Record<ManiaCardTier, { triangleOpacity: number; extras?: ReactNode }> = {
  common: { triangleOpacity: 0.35 },
  rare: { triangleOpacity: 0.55 },
  elite: { triangleOpacity: 0.7 },
  superRare: { triangleOpacity: 0.85 },
  ultraRare: {
    triangleOpacity: 0.9,
    extras: (
      <div
        className="absolute inset-0 pointer-events-none mix-blend-overlay"
        style={{
          background:
            "linear-gradient(120deg, transparent 35%, rgba(255,255,255,0.32) 50%, transparent 65%)",
        }}
      />
    ),
  },
  master: {
    triangleOpacity: 1,
    extras: (
      <div
        className="absolute inset-0 pointer-events-none mix-blend-overlay opacity-70"
        style={{
          background:
            "conic-gradient(from 210deg at 50% 50%, rgba(255,0,128,0.35), rgba(255,200,0,0.35), rgba(0,220,255,0.3), rgba(255,0,128,0.35))",
        }}
      />
    ),
  },
  grandmaster: {
    triangleOpacity: 1,
    extras: (
      <div
        className="absolute inset-0 pointer-events-none mix-blend-screen opacity-80"
        style={{
          background:
            "linear-gradient(120deg, transparent 28%, rgba(255,255,255,0.32) 44%, rgba(255,220,120,0.24) 50%, transparent 66%)",
        }}
      />
    ),
  },
  ascendant: {
    triangleOpacity: 1,
    extras: (
      <div
        className="absolute inset-0 pointer-events-none mix-blend-screen opacity-90"
        style={{
          background:
            "conic-gradient(from 180deg at 50% 50%, rgba(255,255,255,0.34), rgba(255,210,90,0.3), rgba(240,120,255,0.32), rgba(80,220,255,0.26), rgba(255,255,255,0.34))",
        }}
      />
    ),
  },
};

const CARD_EDGE_LAYERS = [-5, -3.75, -2.5, -1.25, 0, 1.25, 2.5, 3.75, 5];

function cssRgb(value: string) {
  const [r = 168, g = 85, b = 247] = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return `rgb(${r}, ${g}, ${b})`;
}

function cssRgba(value: string, alpha: number) {
  const [r = 168, g = 85, b = 247] = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function ManiaCardPanel(props: ManiaCardPanelProps) {
  return <ManiaCard3DPanel {...props} />;
}

export function CssManiaCardPanel({ user, scores, loading }: ManiaCardPanelProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingTiltRef = useRef<{
    rotateX: number;
    rotateY: number;
    glareOpacity: number;
  } | null>(null);
  const dragRef = useRef({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    rotateX: 0,
    rotateY: 0,
    baseRotateX: 0,
    baseRotateY: 0,
  });

  const writeTilt = useCallback((rotateX: number, rotateY: number, glareOpacity: number) => {
    const card = cardRef.current;
    if (!card) return;

    const lightX = clamp(50 - Math.sin((rotateY * Math.PI) / 180) * 42, 8, 92);
    const lightY = clamp(48 + Math.sin((rotateX * Math.PI) / 180) * 42, 10, 90);
    const backgroundX = clamp(50 + (lightX - 50) * 0.5, 28, 72);
    const backgroundY = clamp(50 + (lightY - 50) * 0.42, 30, 70);

    card.style.setProperty("--mc-rotate-x", `${rotateX.toFixed(2)}deg`);
    card.style.setProperty("--mc-rotate-y", `${rotateY.toFixed(2)}deg`);
    card.style.setProperty("--mc-glare-x", `${lightX.toFixed(1)}%`);
    card.style.setProperty("--mc-glare-y", `${lightY.toFixed(1)}%`);
    card.style.setProperty("--mc-background-x", `${backgroundX.toFixed(1)}%`);
    card.style.setProperty("--mc-background-y", `${backgroundY.toFixed(1)}%`);
    card.style.setProperty("--mc-pointer-from-center", `${FOIL_INTENSITY}`);
    card.style.setProperty("--mc-glare-opacity", `${IDLE_GLARE_OPACITY}`);
  }, []);

  const applyTilt = useCallback((rotateX: number, rotateY: number, glareOpacity: number) => {
    pendingTiltRef.current = { rotateX, rotateY, glareOpacity };
    if (frameRef.current !== null) return;

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const next = pendingTiltRef.current;
      pendingTiltRef.current = null;
      if (next) writeTilt(next.rotateX, next.rotateY, next.glareOpacity);
    });
  }, [writeTilt]);

  const startDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();

    const card = cardRef.current;
    if (!card) return;

    dragRef.current.active = true;
    dragRef.current.pointerId = event.pointerId;
    dragRef.current.startX = event.clientX;
    dragRef.current.startY = event.clientY;
    dragRef.current.baseRotateX = dragRef.current.rotateX;
    dragRef.current.baseRotateY = dragRef.current.rotateY;

    card.setPointerCapture(event.pointerId);
    card.dataset.dragging = "true";
    applyTilt(dragRef.current.rotateX, dragRef.current.rotateY, IDLE_GLARE_OPACITY);
  }, [applyTilt]);

  const updateTilt = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || event.pointerId !== drag.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const nextRotateY = drag.baseRotateY + deltaX * 0.58;
    const nextRotateX = clamp(drag.baseRotateX - deltaY * 0.22, -24, 24);
    const intensity = clamp(
      0.28 + (Math.abs(nextRotateX) / 24) * 0.2 + (Math.abs(nextRotateY - drag.baseRotateY) / 180) * 0.42,
      0.28,
      0.9,
    );

    drag.rotateX = nextRotateX;
    drag.rotateY = nextRotateY;
    applyTilt(nextRotateX, nextRotateY, intensity);
  }, [applyTilt]);

  const stopDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active || event.pointerId !== drag.pointerId) return;

    drag.active = false;
    drag.pointerId = -1;
    const card = cardRef.current;
    if (!card) return;
    if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
    delete card.dataset.dragging;
    applyTilt(drag.rotateX, drag.rotateY, IDLE_GLARE_OPACITY);
  }, [applyTilt]);

  const cancelDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    stopDrag(event);
  }, [stopDrag]);

  if (loading) return <ManiaCardLoading />;

  const skills = computeManiaSkills(scores);
  if (!skills) {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center text-sm text-osu-f1">
        Need at least one ranked play with full beatmap data to mint a card.
      </div>
    );
  }

  const tier = getManiaCardTier(skills.cardPower);
  const style = MANIA_TIER_STYLES[tier];
  const visuals = TIER_VISUALS[tier];

  return (
    <div className="py-4 sm:py-6">
      <div className="maniacard-wrap max-w-[440px] mx-auto px-2">
        <div
          ref={cardRef}
          className="maniacard-stage relative rounded-[24px]"
          data-tier={tier}
          style={{
            aspectRatio: "5 / 7",
            "--mc-edge-fill": style.edgeFill,
            "--mc-glow-color": style.glowColor,
          } as CSSProperties}
          onPointerDown={startDrag}
          onPointerMove={updateTilt}
          onPointerUp={stopDrag}
          onPointerCancel={cancelDrag}
          onDragStart={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="maniacard-tilt relative h-full w-full rounded-[24px]"
          >
            <div className="maniacard-core" aria-hidden>
              {CARD_EDGE_LAYERS.map((z, index) => (
                <span
                  key={z}
                  style={{
                    "--mc-layer-z": `calc(${z}px * var(--mc-thickness-scale))`,
                    opacity: 0.82 + index * 0.018,
                  } as CSSProperties}
                />
              ))}
            </div>
            <div className={`maniacard-face maniacard-front bg-gradient-to-br ${style.background}`}>
              <div className={`maniacard-tier-flow maniacard-tier-${tier}`} aria-hidden />
              <TrianglePattern opacity={visuals.triangleOpacity} idSuffix={`${tier}-front`} />
              <div className="maniacard-foil" aria-hidden />
              <div className="maniacard-glare" aria-hidden />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(255,255,255,0.18),transparent_45%)] pointer-events-none" />
              <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/8 to-transparent pointer-events-none" />
              <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/38 to-transparent pointer-events-none" />
              {visuals.extras}

              <div className="maniacard-content relative h-full flex flex-col p-3 sm:p-5 gap-1.5 sm:gap-2.5">
                <div className="relative grid grid-cols-[auto_1fr] gap-2 sm:gap-2.5 pt-0.5">
                  <div className="row-span-2 relative z-10 -ml-1 -mt-1">
                    <ManiaModeIcon tier={tier} />
                  </div>
                  <div className="relative min-w-0 self-end overflow-hidden rounded-xl bg-black/34 px-3 py-1.5 sm:px-4 sm:py-2 shadow-[0_8px_18px_rgba(0,0,0,0.26),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-[2px]">
                    <NamePixelTrail />
                    <div
                      className="relative truncate text-center text-white text-base sm:text-xl leading-tight"
                      style={{
                        fontFamily: "Torus, sans-serif",
                        fontWeight: 900,
                        textShadow: "0 2px 4px rgba(0,0,0,0.5)",
                      }}
                    >
                      {user.username}
                    </div>
                  </div>
                  <div
                    className={`min-w-0 self-start truncate pr-1 text-right text-base sm:text-xl italic font-black ${style.badgeColor}`}
                    style={{
                      fontFamily: "Torus, sans-serif",
                      textShadow: "0 2px 4px rgba(0,0,0,0.5)",
                    }}
                  >
                    {style.label}
                  </div>
                </div>

                <div className="maniacard-avatar-frame relative mx-auto w-full max-w-[220px] sm:max-w-[310px] rounded-xl bg-white/14 p-[2px] sm:p-[3px] shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
                  <img
                    src={`/api/avatar?u=${user.id}`}
                    alt=""
                    className="maniacard-avatar aspect-square w-full rounded-lg object-cover object-center"
                    loading="eager"
                    crossOrigin="anonymous"
                    referrerPolicy="no-referrer"
                    draggable={false}
                  />
                </div>

                <div
                  className="rounded-2xl border border-white/16 bg-black/30 px-3.5 py-2 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-[2px]"
                  style={{ fontFamily: "Torus, sans-serif", textShadow: "0 2px 3px rgba(0,0,0,0.6)" }}
                >
                  <StatLine label="Control" value={skills.fingerControl} />
                  <StatLine label="Speed" value={skills.speed} />
                  <StatLine label="Precision" value={skills.accuracy} />
                </div>

                <div className="pb-1 sm:pb-3">
                  <StarRow value={skills.starAvg} color={style.starColor} size={18} />
                  <div className="mt-0.5 text-center text-[9px] uppercase tracking-[0.2em] text-white/58 font-semibold">
                    {skills.starAvg.toFixed(2)}★
                  </div>
                </div>
              </div>
            </div>

            <div className={`maniacard-face maniacard-back bg-gradient-to-br ${style.background}`}>
              <TrianglePattern opacity={visuals.triangleOpacity * 0.42} idSuffix={`${tier}-back`} animated={false} />
              <ManiaCardBackDesign tier={tier} tierLabel={style.label} glowColor={style.glowColor} />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function StatLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-0.5">
      <span className="text-left text-xs sm:text-[15px] font-semibold text-white/84">
        {label}:
      </span>
      <span className="text-lg sm:text-2xl font-black tabular-nums text-white min-w-[3ch] text-right leading-none">
        {value}
      </span>
    </div>
  );
}

function ManiaCardLoading() {
  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          className="relative rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40"
          style={{ aspectRatio: "5 / 7" }}
        >
          <div className="absolute inset-0 rounded-[22px] animate-pulse" />
        </div>
        <div className="mt-4 text-center text-[11px] text-osu-f1">Calculating skills...</div>
      </div>
    </div>
  );
}

export type { ManiaSkills, ManiaCardTier };
