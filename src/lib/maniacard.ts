// Port of TinyBot's mania skill calculator (Tienei/TinyBot,
// Functions/osu/calc_player_skill.js). The original Discord bot composited a
// PNG via JIMP; we render the same numbers as a styled React card. Formulas
// kept verbatim so output matches the long-running community reference.

import type { OsuScore } from "./types";
import { getDisplayedAccuracy } from "./score";

export interface ManiaSkills {
  // Average star rating across the considered plays (raw, unrounded).
  starAvg: number;
  // The three numbers shown on the card. Each is the per-play average x 100,
  // rounded to integers (matches the toFixed(0) the bot emitted).
  fingerControl: number;
  speed: number;
  accuracy: number;
  // How many of the top plays actually contributed (NaN/Infinity dropped).
  sampleSize: number;
}

export type ManiaCardTier =
  | "common"
  | "rare"
  | "elite"
  | "superRare"
  | "ultraRare"
  | "master";

const MAX_PLAYS = 50;

function isUsable(score: OsuScore): boolean {
  const b = score.beatmap;
  if (!b) return false;
  return (
    Number.isFinite(b.difficulty_rating) && b.difficulty_rating > 0 &&
    Number.isFinite(b.bpm) && b.bpm > 0 &&
    Number.isFinite(b.accuracy) && b.accuracy > 0 &&
    Number.isFinite(b.drain) && b.drain > 0 &&
    Number.isFinite(b.cs) && b.cs > 0 &&
    Number.isFinite(b.count_circles + b.count_sliders) &&
    (b.count_circles + b.count_sliders) > 0
  );
}

export function computeManiaSkills(scores: OsuScore[]): ManiaSkills | null {
  const pool = scores.filter(isUsable).slice(0, MAX_PLAYS);
  if (pool.length === 0) return null;

  let starSum = 0;
  let aimSum = 0;
  let speedSum = 0;
  let accSum = 0;
  let count = 0;

  for (const score of pool) {
    const b = score.beatmap;
    const star = b.difficulty_rating;
    const bpm = b.bpm;
    const od = b.accuracy;
    const hp = b.drain;
    const cs = b.cs;
    const notes = b.count_circles + b.count_sliders;
    const acc = getDisplayedAccuracy(score) * 100;

    // Per-TinyBot mania (modenum == 3):
    const aim = Math.pow(star / 1.1, Math.log(bpm) / Math.log(star * 20));
    const accSkill =
      Math.pow(star, (Math.pow(acc, 3) / Math.pow(100, 3)) * 1.075) *
      (Math.pow(od, 0.02) / Math.pow(6, 0.02)) *
      (Math.pow(hp, 0.02) / Math.pow(5, 0.02));
    const speed = Math.pow(
      star,
      1.1 *
        Math.pow(bpm / 250, 0.4) *
        (Math.log(notes) / Math.log(star * 900)) *
        (Math.pow(od, 0.4) / Math.pow(8, 0.4)) *
        (Math.pow(hp, 0.2) / Math.pow(7.5, 0.2)) *
        Math.pow(cs / 4, 0.1),
    );

    if (![aim, accSkill, speed, star].every(Number.isFinite)) continue;

    starSum += star;
    aimSum += aim;
    speedSum += speed;
    accSum += accSkill;
    count++;
  }

  if (count === 0) return null;

  // The bot returned speed_avg with a 1.03 multiplier; preserve that so tier
  // thresholds line up with the original output.
  return {
    starAvg: starSum / count,
    fingerControl: Math.round((aimSum / count) * 100),
    speed: Math.round((speedSum / count) * 100 * 1.03),
    accuracy: Math.round((accSum / count) * 100),
    sampleSize: count,
  };
}

// Tier thresholds from Commands/osu.js (acc_avg cutoffs).
export function getManiaCardTier(accuracy: number): ManiaCardTier {
  if (accuracy >= 900) return "master";
  if (accuracy >= 825) return "ultraRare";
  if (accuracy >= 700) return "superRare";
  if (accuracy >= 525) return "elite";
  if (accuracy >= 300) return "rare";
  return "common";
}

export interface ManiaCardTierStyle {
  label: string;
  // Tailwind class fragments applied to the card surface.
  background: string;
  border: string;
  glow: string;
  // Star icon fill (text color class).
  starColor: string;
  // Tier badge text color class.
  badgeColor: string;
}

export const MANIA_TIER_STYLES: Record<ManiaCardTier, ManiaCardTierStyle> = {
  common: {
    label: "Common",
    background: "from-slate-500 via-slate-600 to-slate-800",
    border: "border-slate-300/40",
    glow: "shadow-[0_18px_58px_rgba(51,65,85,0.48)]",
    starColor: "text-amber-300",
    badgeColor: "text-slate-100",
  },
  rare: {
    label: "Rare",
    background: "from-sky-400 via-sky-600 to-indigo-800",
    border: "border-sky-200/60",
    glow: "shadow-[0_18px_58px_rgba(2,132,199,0.5)]",
    starColor: "text-amber-300",
    badgeColor: "text-sky-50",
  },
  elite: {
    label: "Elite",
    background: "from-violet-400 via-violet-600 to-purple-800",
    border: "border-violet-200/70",
    glow: "shadow-[0_18px_58px_rgba(109,40,217,0.55)]",
    starColor: "text-amber-300",
    badgeColor: "text-violet-50",
  },
  superRare: {
    label: "Super Rare",
    background: "from-fuchsia-400 via-purple-600 to-indigo-900",
    border: "border-fuchsia-200/75",
    glow: "shadow-[0_18px_62px_rgba(168,85,247,0.58)]",
    starColor: "text-amber-300",
    badgeColor: "text-fuchsia-50",
  },
  ultraRare: {
    label: "Ultra Rare",
    background: "from-rose-400 via-pink-600 to-fuchsia-900",
    border: "border-rose-200/80",
    glow: "shadow-[0_18px_64px_rgba(219,39,119,0.58)]",
    starColor: "text-amber-300",
    badgeColor: "text-rose-50",
  },
  master: {
    label: "Master",
    background: "from-amber-300 via-orange-500 to-rose-700",
    border: "border-amber-100/90",
    glow: "shadow-[0_18px_68px_rgba(217,119,6,0.62)]",
    starColor: "text-amber-100",
    badgeColor: "text-amber-50",
  },
};
