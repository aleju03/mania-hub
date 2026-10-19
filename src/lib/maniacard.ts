import type { CSSProperties } from "react";
import { MANIA_CARD_TIER_THRESHOLDS, type ManiaCardTier } from "../../backend/src/shared/maniacard";
export {
  computeManiaSkills, computeKeymodePpPrestige, resolveCardGlobalPp,
  getManiaCardTier, MANIA_CARD_TIER_THRESHOLDS,
  HONORARY_TIER, HONORARY_TIER_USER_IDS, AWARDED_TIERS, getHonoraryTier,
  type ManiaSkills, type ManiaCardTier, type KeymodePpWeight,
} from "../../backend/src/shared/maniacard";

export interface NextManiaCardTier {
  tier: ManiaCardTier;
  label: string;
  currentTier: ManiaCardTier;
  currentLabel: string;
  threshold: number;
  remaining: number;
  progress: number;
}

export function getNextManiaCardTier(cardPower: number): NextManiaCardTier | null {
  const nextIndex = MANIA_CARD_TIER_THRESHOLDS.findIndex(({ threshold }) => cardPower < threshold);
  if (nextIndex === -1) return null;
  const next = MANIA_CARD_TIER_THRESHOLDS[nextIndex];
  const prevThreshold = nextIndex === 0 ? 0 : MANIA_CARD_TIER_THRESHOLDS[nextIndex - 1].threshold;
  const span = next.threshold - prevThreshold;
  const progress = span > 0 ? Math.min(1, Math.max(0, (cardPower - prevThreshold) / span)) : 0;
  const currentTier: ManiaCardTier = nextIndex === 0 ? "common" : MANIA_CARD_TIER_THRESHOLDS[nextIndex - 1].tier;

  return {
    tier: next.tier,
    label: MANIA_TIER_STYLES[next.tier].label,
    currentTier,
    currentLabel: MANIA_TIER_STYLES[currentTier].label,
    threshold: next.threshold,
    remaining: next.threshold - cardPower,
    progress,
  };
}

/* Tiers whose text colour cannot just be their glow. Ascendant's glow is pure
   white, which on a dark page reads as "no tier at all" rather than as the top
   of the ladder, so the name takes the card's own white-gold-violet sweep
   instead. Only the bright end of a card's palette is usable here: these
   gradients fade to near black on the card, and so would the text. */
const TIER_TEXT_GRADIENTS: Partial<Record<ManiaCardTier, string>> = {
  ascendant: "linear-gradient(100deg, #ffffff 0%, #fde68a 34%, #f0abfc 68%, #e9d5ff 100%)",
};

/* How to print a player's name in the colour of the card they are on. */
export function maniaTierTextStyle(
  tier: ManiaCardTier,
  glow: { r: number; g: number; b: number },
): CSSProperties {
  const gradient = TIER_TEXT_GRADIENTS[tier];
  if (!gradient) return { color: `rgb(${glow.r}, ${glow.g}, ${glow.b})` };
  return {
    backgroundImage: gradient,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    // Painting the gradient through the glyphs, so the name is the sweep.
    WebkitTextFillColor: "transparent",
    color: "transparent",
  };
}

export interface ManiaCardTierStyle {
  label: string;
  // Tailwind class fragments applied to the card surface.
  background: string;
  border: string;
  glow: string;
  edgeFill: string;
  glowColor: string;
  // Star icon fill (text color class).
  starColor: string;
  // Tier badge text color class.
  badgeColor: string;
  // Mania mode badge tint (top-left logo tile) tuned to the tier palette.
  badgeGradient: string;
  badgeHalo: string;
  badgeGlyphShadow: string;
}

/* The card-surface style for a holding whose motif names a palette
   (CardMotif.palette), everything but the label, which stays the tier's. */
export const MANIA_PALETTE_STYLES: Record<"gold" | "prismatic" | "aurora" | "ember", Omit<ManiaCardTierStyle, "label">> = {
  prismatic: {
    background: "from-black via-violet-950 to-zinc-950",
    border: "border-cyan-200/90",
    glow: "shadow-[0_18px_90px_rgba(167,139,250,0.45)]",
    edgeFill: "rgba(167, 139, 250, 0.8)", glowColor: "rgba(167, 139, 250, 0.45)",
    starColor: "text-fuchsia-100", badgeColor: "text-white",
    badgeGradient: "linear-gradient(142deg, #f0abfc 0%, #a78bfa 34%, #67e8f9 70%, #090910 100%)",
    badgeHalo: "rgba(167, 139, 250, 0.65)", badgeGlyphShadow: "rgba(167, 139, 250, 0.4)",
  },
  aurora: {
    background: "from-black via-teal-950 to-zinc-950",
    border: "border-indigo-200/90",
    glow: "shadow-[0_18px_90px_rgba(45,212,191,0.45)]",
    edgeFill: "rgba(45, 212, 191, 0.8)", glowColor: "rgba(45, 212, 191, 0.45)",
    starColor: "text-cyan-100", badgeColor: "text-white",
    badgeGradient: "linear-gradient(142deg, #99f6e4 0%, #2dd4bf 34%, #818cf8 70%, #090910 100%)",
    badgeHalo: "rgba(45, 212, 191, 0.65)", badgeGlyphShadow: "rgba(45, 212, 191, 0.4)",
  },
  ember: {
    background: "from-black via-orange-950 to-zinc-950",
    border: "border-rose-200/90",
    glow: "shadow-[0_18px_90px_rgba(251,146,60,0.45)]",
    edgeFill: "rgba(251, 146, 60, 0.8)", glowColor: "rgba(251, 146, 60, 0.45)",
    starColor: "text-amber-100", badgeColor: "text-white",
    badgeGradient: "linear-gradient(142deg, #fed7aa 0%, #fb923c 34%, #fb7185 70%, #090910 100%)",
    badgeHalo: "rgba(251, 146, 60, 0.65)", badgeGlyphShadow: "rgba(251, 146, 60, 0.4)",
  },
  gold: {
    background: "from-black via-yellow-950 to-zinc-950",
    border: "border-yellow-100/95",
    glow: "shadow-[0_18px_90px_rgba(246,195,67,0.55)]",
    edgeFill: "rgba(74, 52, 6, 0.97)",
    glowColor: "rgba(246, 195, 67, 0.5)",
    starColor: "text-yellow-100",
    badgeColor: "text-yellow-50",
    badgeGradient:
      "linear-gradient(142deg, #fff3b0 0%, #f6c343 34%, #b8860b 70%, #0d0903 100%)",
    badgeHalo: "rgba(246,195,67,0.72)",
    badgeGlyphShadow: "rgba(74,52,6,0.58)",
  },
};

/* A tier's style, with the holding's palette swapped in when it has one. */
export function resolveManiaTierStyle(tier: ManiaCardTier, motif?: { palette?: keyof typeof MANIA_PALETTE_STYLES } | null): ManiaCardTierStyle {
  const base = MANIA_TIER_STYLES[tier];
  return motif?.palette ? { ...MANIA_PALETTE_STYLES[motif.palette], label: base.label } : base;
}

export const MANIA_TIER_STYLES: Record<ManiaCardTier, ManiaCardTierStyle> = {
  common: {
    label: "Common",
    background: "from-slate-500 via-slate-600 to-slate-800",
    border: "border-slate-300/40",
    glow: "shadow-[0_18px_58px_rgba(51,65,85,0.48)]",
    edgeFill: "rgba(30, 41, 59, 0.94)",
    glowColor: "rgba(148, 163, 184, 0.34)",
    starColor: "text-amber-300",
    badgeColor: "text-slate-100",
    badgeGradient:
      "linear-gradient(142deg, #cbd5e1 0%, #64748b 44%, #1e293b 100%)",
    badgeHalo: "rgba(148,163,184,0.55)",
    badgeGlyphShadow: "rgba(15,23,42,0.45)",
  },
  rare: {
    label: "Rare",
    background: "from-sky-400 via-sky-600 to-indigo-800",
    border: "border-sky-200/60",
    glow: "shadow-[0_18px_58px_rgba(2,132,199,0.5)]",
    edgeFill: "rgba(12, 74, 110, 0.94)",
    glowColor: "rgba(56, 189, 248, 0.36)",
    starColor: "text-amber-300",
    badgeColor: "text-sky-50",
    badgeGradient:
      "linear-gradient(142deg, #bae6fd 0%, #0ea5e9 44%, #1e3a8a 100%)",
    badgeHalo: "rgba(56,189,248,0.55)",
    badgeGlyphShadow: "rgba(12,74,110,0.45)",
  },
  elite: {
    label: "Elite",
    background: "from-violet-400 via-violet-600 to-purple-800",
    border: "border-violet-200/70",
    glow: "shadow-[0_18px_58px_rgba(109,40,217,0.55)]",
    edgeFill: "rgba(76, 29, 149, 0.94)",
    glowColor: "rgba(167, 139, 250, 0.38)",
    starColor: "text-amber-300",
    badgeColor: "text-violet-50",
    badgeGradient:
      "linear-gradient(142deg, #ddd6fe 0%, #7c3aed 44%, #4c1d95 100%)",
    badgeHalo: "rgba(167,139,250,0.55)",
    badgeGlyphShadow: "rgba(46,16,101,0.45)",
  },
  superRare: {
    label: "Super Rare",
    background: "from-fuchsia-400 via-purple-600 to-indigo-900",
    border: "border-fuchsia-200/75",
    glow: "shadow-[0_18px_62px_rgba(168,85,247,0.58)]",
    edgeFill: "rgba(88, 28, 135, 0.94)",
    glowColor: "rgba(232, 121, 249, 0.4)",
    starColor: "text-amber-300",
    badgeColor: "text-fuchsia-50",
    badgeGradient:
      "linear-gradient(142deg, #f5d0fe 0%, #c026d3 44%, #581c87 100%)",
    badgeHalo: "rgba(232,121,249,0.58)",
    badgeGlyphShadow: "rgba(88,28,135,0.45)",
  },
  ultraRare: {
    label: "Ultra Rare",
    background: "from-rose-400 via-pink-600 to-fuchsia-900",
    border: "border-rose-200/80",
    glow: "shadow-[0_18px_64px_rgba(219,39,119,0.58)]",
    edgeFill: "rgba(131, 24, 67, 0.94)",
    glowColor: "rgba(251, 113, 133, 0.4)",
    starColor: "text-amber-300",
    badgeColor: "text-rose-50",
    badgeGradient:
      "linear-gradient(142deg, #ff8ec4 0%, #ff3d8a 44%, #b81f68 100%)",
    badgeHalo: "rgba(255,70,150,0.58)",
    badgeGlyphShadow: "rgba(120,20,70,0.45)",
  },
  legendary: {
    label: "Legendary",
    background: "from-yellow-200 via-amber-400 to-orange-800",
    border: "border-yellow-100/95",
    glow: "shadow-[0_18px_74px_rgba(245,158,11,0.66)]",
    edgeFill: "rgba(146, 64, 14, 0.94)",
    glowColor: "rgba(251, 191, 36, 0.5)",
    starColor: "text-yellow-100",
    badgeColor: "text-yellow-50",
    badgeGradient:
      "linear-gradient(142deg, #fff7ad 0%, #fbbf24 42%, #92400e 100%)",
    badgeHalo: "rgba(251,191,36,0.66)",
    badgeGlyphShadow: "rgba(120,53,15,0.5)",
  },
  mythic: {
    label: "Mythic",
    background: "from-red-300 via-red-600 to-zinc-950",
    border: "border-red-100/95",
    glow: "shadow-[0_18px_78px_rgba(220,38,38,0.68)]",
    edgeFill: "rgba(127, 29, 29, 0.94)",
    glowColor: "rgba(248, 113, 113, 0.48)",
    starColor: "text-red-100",
    badgeColor: "text-red-50",
    badgeGradient:
      "linear-gradient(142deg, #fee2e2 0%, #ef4444 42%, #450a0a 100%)",
    badgeHalo: "rgba(248,113,113,0.66)",
    badgeGlyphShadow: "rgba(69,10,10,0.5)",
  },
  ascendant: {
    label: "Ascendant",
    background: "from-white via-amber-200 to-fuchsia-700",
    border: "border-white/95",
    glow: "shadow-[0_18px_82px_rgba(255,255,255,0.5)]",
    edgeFill: "rgba(120, 53, 15, 0.94)",
    glowColor: "rgba(255, 255, 255, 0.5)",
    starColor: "text-white",
    badgeColor: "text-white",
    badgeGradient:
      "linear-gradient(142deg, #ffffff 0%, #fde68a 34%, #f0abfc 68%, #7e22ce 100%)",
    badgeHalo: "rgba(255,255,255,0.72)",
    badgeGlyphShadow: "rgba(88,28,135,0.45)",
  },
  worldClass: {
    label: "World Class",
    background: "from-black via-emerald-950 to-zinc-950",
    border: "border-emerald-100/95",
    glow: "shadow-[0_18px_86px_rgba(16,185,129,0.48)]",
    edgeFill: "rgba(2, 44, 34, 0.97)",
    glowColor: "rgba(34, 197, 94, 0.42)",
    starColor: "text-emerald-100",
    badgeColor: "text-emerald-50",
    badgeGradient:
      "linear-gradient(142deg, #ecfdf5 0%, #22c55e 30%, #052e16 66%, #020617 100%)",
    badgeHalo: "rgba(34,197,94,0.68)",
    badgeGlyphShadow: "rgba(2,44,34,0.58)",
  },
  eternal: {
    label: "Eternal",
    background: "from-black via-purple-950 to-zinc-950",
    border: "border-purple-100/95",
    glow: "shadow-[0_18px_88px_rgba(168,85,247,0.52)]",
    edgeFill: "rgba(46, 16, 101, 0.97)",
    glowColor: "rgba(192, 132, 252, 0.46)",
    starColor: "text-purple-100",
    badgeColor: "text-purple-50",
    badgeGradient:
      "linear-gradient(142deg, #f3e8ff 0%, #a855f7 32%, #4c1d95 68%, #0b0614 100%)",
    badgeHalo: "rgba(168,85,247,0.7)",
    badgeGlyphShadow: "rgba(46,16,101,0.58)",
  },
  goat: {
    label: "GOAT",
    background: "from-black via-amber-950 to-zinc-950",
    border: "border-amber-100/95",
    glow: "shadow-[0_18px_90px_rgba(245,158,11,0.5)]",
    edgeFill: "rgba(69, 39, 5, 0.97)",
    glowColor: "rgba(245, 158, 11, 0.46)",
    starColor: "text-amber-100",
    badgeColor: "text-amber-50",
    badgeGradient:
      "linear-gradient(142deg, #fef3c7 0%, #f59e0b 34%, #78350f 70%, #0c0a09 100%)",
    badgeHalo: "rgba(245,158,11,0.7)",
    badgeGlyphShadow: "rgba(69,39,5,0.58)",
  },
};

/* The osu!mania mode glyph the card stamps top-left. Authored y-up (the canvas
   flips it), so an svg draws it inside viewBox="-40 -40 1080 1080" under
   matrix(1,0,0,-1,0,860), which centres it with the baseline at 0.86. */
export const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

/* The card front's floating osu! triangles as an svg document: a jittered
   grid so positions never line up, varied sizes, up or down but never tilted,
   overlapping into soft facets. Coords are authored on the 1000x1400 card and
   scaled to w x h. `solid` draws only the light facets, fully opaque, for use
   as a mask (a foil that shows through the triangles). Plain string so the
   server can base64 it for resvg and the client can inline it as a data url. */
export function maniaTriangleOverlaySvg(w: number, h: number, solid = false): string {
  const sx = w / 1000;
  const sy = h / 1400;
  const rand = (n: number) => {
    const v = Math.sin(n) * 43758.5453123;
    return v - Math.floor(v);
  };
  const poly = (pts: Array<[number, number]>, fill: string) =>
    `<path d='${pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} Z' fill='${fill}'/>`;
  let paths = "";
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const i = row * 11 + col;
      if (rand(i * 19.17 + 4.2) < 0.4) continue;
      const cx = (col * 200 + 100 + (rand(i * 43.91 + 8.5) - 0.5) * 130) * sx;
      const cy = (row * 233 + 117 + (rand(i * 29.37 + 12.4) - 0.5) * 130) * sy;
      const side = (230 + rand(i * 13.81 + 2.7) * 300) * sx;
      const hgt = side * 0.866;
      const up = rand(i * 7.3 + 3.1) > 0.5;
      const pts: Array<[number, number]> = up
        ? [[cx, cy - (hgt * 2) / 3], [cx + side / 2, cy + hgt / 3], [cx - side / 2, cy + hgt / 3]]
        : [[cx, cy + (hgt * 2) / 3], [cx + side / 2, cy - hgt / 3], [cx - side / 2, cy - hgt / 3]];
      // Fewer, larger, low-contrast facets. Dark ones stay extra faint since
      // dark-on-light reads strongly; ~50/50 light/dark so the pale top and
      // dark bottom each show some.
      const dark = rand(i * 3.11 + 6.9) > 0.5;
      if (solid) {
        if (!dark) paths += poly(pts, "#fff");
        continue;
      }
      const a = dark ? 0.035 + rand(i * 5.21 + 1.3) * 0.04 : 0.05 + rand(i * 5.21 + 1.3) * 0.06;
      paths += poly(pts, dark ? `rgba(0,0,0,${a.toFixed(3)})` : `rgba(255,255,255,${a.toFixed(3)})`);
    }
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${paths}</svg>`;
}
