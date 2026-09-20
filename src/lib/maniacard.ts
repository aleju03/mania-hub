import type { CSSProperties } from "react";
import { MANIA_CARD_TIER_THRESHOLDS, type ManiaCardTier } from "../../live-backend/src/shared/maniacard";
export {
  computeManiaSkills, computeKeymodePpPrestige, resolveCardGlobalPp,
  getManiaCardTier, MANIA_CARD_TIER_THRESHOLDS,
  HONORARY_TIER, HONORARY_TIER_USER_IDS, AWARDED_TIERS, getHonoraryTier,
  type ManiaSkills, type ManiaCardTier, type KeymodePpWeight,
} from "../../live-backend/src/shared/maniacard";

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
