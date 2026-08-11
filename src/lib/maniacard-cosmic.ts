import type { ManiaCardTier } from "./maniacard";

/* Tiers at the top of the ladder drop the tier gradient and triangle flecks for
   a dark starfield front. One palette entry per tier drives the background
   wash, the star colors, and the foil rim.

   Data only, no canvas: the WebGL card (cardTexture.ts) paints these onto a
   1000x1400 texture, and the OG endpoint re-emits the same numbers as SVG, so
   a card shared into Discord matches the card on the page. */
export interface CosmicTierPalette {
  base: Array<[number, string]>;
  foilA: [string, string];
  foilB: [string, string];
  aurora: [string, string, string, string, string];
  stars: string[];
  // Star-core color and holo rainbow amount for the overlay shader (0-1 rgb).
  starTint: [number, number, number];
  rainbow: number;
  rim: Array<[number, string]>;
  rimGlow: string;
  glint: string;
  // Draws a large faint laurel + star behind the avatar, echoing the card back.
  laurelWatermark?: boolean;
}

export const COSMIC_TIERS: Partial<Record<ManiaCardTier, CosmicTierPalette>> = {
  worldClass: {
    base: [[0, "#010409"], [0.38, "#020617"], [0.72, "#030712"], [1, "#000000"]],
    foilA: ["rgba(74, 222, 128, 0.26)", "rgba(16, 185, 129, 0.14)"],
    foilB: ["rgba(45, 212, 191, 0.16)", "rgba(22, 163, 74, 0.1)"],
    aurora: [
      "rgba(20, 83, 45, 0)",
      "rgba(34, 197, 94, 0.13)",
      "rgba(6, 182, 212, 0.08)",
      "rgba(21, 128, 61, 0.1)",
      "rgba(20, 83, 45, 0)",
    ],
    stars: ["255, 255, 255", "187, 247, 208", "153, 246, 228", "209, 250, 229"],
    starTint: [0.78, 1.0, 0.9],
    rainbow: 1,
    rim: [
      [0, "rgba(236,253,245,0.72)"],
      [0.18, "rgba(34,197,94,0.88)"],
      [0.5, "rgba(6,182,212,0.26)"],
      [0.78, "rgba(34,197,94,0.72)"],
      [1, "rgba(236,253,245,0.62)"],
    ],
    rimGlow: "rgba(34,197,94,0.52)",
    glint: "rgba(220,252,231,0.88)",
  },
  goat: {
    base: [[0, "#0c0a09"], [0.38, "#1a1006"], [0.72, "#120a03"], [1, "#000000"]],
    foilA: ["rgba(251, 191, 36, 0.30)", "rgba(217, 119, 6, 0.14)"],
    foilB: ["rgba(253, 230, 138, 0.16)", "rgba(180, 83, 9, 0.1)"],
    aurora: [
      "rgba(120, 53, 15, 0)",
      "rgba(245, 158, 11, 0.12)",
      "rgba(253, 224, 71, 0.07)",
      "rgba(146, 64, 14, 0.1)",
      "rgba(120, 53, 15, 0)",
    ],
    stars: ["253, 230, 138", "251, 191, 36", "254, 243, 199", "252, 211, 77"],
    starTint: [1.0, 0.9, 0.62],
    rainbow: 0.3,
    rim: [
      [0, "rgba(254,243,199,0.72)"],
      [0.18, "rgba(245,158,11,0.9)"],
      [0.5, "rgba(253,224,71,0.28)"],
      [0.78, "rgba(217,119,6,0.75)"],
      [1, "rgba(254,243,199,0.62)"],
    ],
    rimGlow: "rgba(245,158,11,0.52)",
    glint: "rgba(254,243,199,0.9)",
    laurelWatermark: true,
  },
};

export function getCosmicTierPalette(tier: ManiaCardTier) {
  return COSMIC_TIERS[tier] ?? null;
}
