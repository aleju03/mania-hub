// Maniacard player trait model.
//
// This intentionally avoids the old TinyBot formulas. Those were mostly
// star/BPM metadata transforms and treated "finger control" like a renamed
// aim stat. The model below stays inside data we already have on profile best
// plays, then normalizes per keymode so 4K and 7K are not compared on the same
// raw BPM/density scale.

import type { OsuScore, OsuScoreStatistics } from "./types";
import { getDisplayedAccuracy, getModAcronyms, getScoreRate } from "./score";

export interface ManiaSkills {
  // Average star rating across the considered plays (raw, unrounded).
  starAvg: number;
  // The three numbers shown on the card, on a generous RPG-style display scale.
  fingerControl: number;
  speed: number;
  accuracy: number;
  // Extra traits for future card surfaces.
  stamina: number;
  versatility: number;
  peak: number;
  cardPower: number;
  mainKeyMode: number;
  archetype: string;
  // How many of the top plays actually contributed (NaN/Infinity dropped).
  sampleSize: number;
}

export type ManiaCardTier =
  | "common"
  | "rare"
  | "elite"
  | "superRare"
  | "ultraRare"
  | "legendary"
  | "mythic"
  | "ascendant"
  | "worldClass";

const MAX_PLAYS = 200;

interface KeymodeBaseline {
  pp: [number, number];
  sr: [number, number];
  bpm: [number, number];
  density: [number, number];
  length: [number, number];
  objects: [number, number];
}

interface TraitSums {
  star: number;
  precision: number;
  precisionPeak: number;
  speed: number;
  control: number;
  stamina: number;
  peak: number;
  weight: number;
  count: number;
}

interface KeymodeProfile {
  keyMode: number;
  starAvg: number;
  precision: number;
  speed: number;
  control: number;
  stamina: number;
  peak: number;
  strength: number;
  weight: number;
  count: number;
}

const BASELINES: Record<number, KeymodeBaseline> = {
  4: {
    pp: [80, 1500],
    sr: [3.2, 8.8],
    bpm: [145, 265],
    density: [3.2, 9.5],
    length: [65, 240],
    objects: [280, 1800],
  },
  7: {
    pp: [90, 1700],
    sr: [3.4, 9.0],
    bpm: [125, 235],
    density: [3.5, 12.5],
    length: [70, 260],
    objects: [360, 2600],
  },
};

const DEFAULT_BASELINE: KeymodeBaseline = {
  pp: [70, 1500],
  sr: [3.0, 8.6],
  bpm: [120, 245],
  density: [3.0, 10.5],
  length: [65, 245],
  objects: [300, 2200],
};

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

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function normalize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  return clamp((value - min) / (max - min));
}

function curve(value: number, power: number): number {
  return Math.pow(clamp(value), power);
}

function getKeyMode(score: OsuScore): number {
  const cs = score.beatmap?.cs ?? 0;
  return Number.isFinite(cs) && cs > 0 ? Math.round(cs) : 4;
}

function getBaseline(keyMode: number): KeymodeBaseline {
  return BASELINES[keyMode] ?? DEFAULT_BASELINE;
}

function scoreWeight(score: OsuScore, index: number, keyModeCount: number): number {
  const pp = Math.max(0, score.pp ?? 0);
  const ppWeight = pp > 0 ? Math.pow(pp, 0.72) : 1;
  const rankWeight = Math.pow(0.965, index);
  const sampleWeight = keyModeCount >= 5 ? 1 : 0.72 + keyModeCount * 0.056;
  return ppWeight * rankWeight * sampleWeight;
}

function getAccuracyGate(acc: number): number {
  // Speed/control/stamina should not inflate from messy clears, but low-acc
  // plays still carry some signal when they are high enough to be in top plays.
  return 0.35 + curve(normalize(acc, 0.94, 0.995), 0.8) * 0.65;
}

function getMaxJudgementRatioScore(stats: OsuScoreStatistics): number | null {
  const max = stats.count_geki ?? stats.perfect ?? 0;
  const perfect = stats.count_300 ?? stats.great ?? 0;
  const total = max + perfect;
  if (total <= 0) return null;

  return curve(max / total, 0.72);
}

function getEffectiveStarRating(score: OsuScore, rate: number): number {
  const star = score.beatmap.difficulty_rating;
  if (!Number.isFinite(rate) || rate <= 0 || Math.abs(rate - 1) < 0.001) return star;

  // The best-score payload only includes beatmap base SR, not mod-adjusted SR.
  // Tempo mods still matter for mania difficulty, so approximate mania's
  // observed rate scaling until we have per-score beatmap attributes from osu!.
  return star * Math.pow(rate, 0.72);
}

function computePlayTraits(score: OsuScore, baseline: KeymodeBaseline) {
  const b = score.beatmap;
  const rate = getScoreRate(score.mods);
  const star = getEffectiveStarRating(score, rate);
  const effectiveBpm = b.bpm * rate;
  const length = Math.max(1, b.total_length / Math.max(0.1, rate));
  const objects = b.count_circles + b.count_sliders;
  const density = objects / length;
  const lnRatio = objects > 0 ? clamp(b.count_sliders / objects) : 0;
  const riceRatio = 1 - lnRatio;
  const riceDensity = b.count_circles / length;
  const lnDensity = b.count_sliders / length;
  const acc = getDisplayedAccuracy(score);
  const od = b.accuracy;
  const maxCombo = b.max_combo && b.max_combo > 0 ? b.max_combo : objects;
  const comboRatio = maxCombo > 0 ? clamp(score.max_combo / maxCombo) : 1;
  const missCount = score.statistics.count_miss ?? score.statistics.miss ?? 0;
  const missPenalty = clamp(1 - missCount * 0.035, 0.75, 1);
  const comboGate = 0.82 + curve(comboRatio, 0.65) * 0.18;
  const accGate = getAccuracyGate(acc);
  const acronyms = getModAcronyms(score.mods);
  const isRateFarm = acronyms.includes("DT") || acronyms.includes("NC");

  const srScore = curve(normalize(star, ...baseline.sr), 0.9);
  const bpmScore = curve(normalize(effectiveBpm, ...baseline.bpm), 0.95);
  const densityScore = curve(normalize(density, ...baseline.density), 0.85);
  const riceDensityScore = curve(normalize(riceDensity, ...baseline.density), 0.85);
  const lnDensityScore = curve(normalize(lnDensity, ...baseline.density), 0.85);
  const riceBias = 0.72 + riceRatio * 0.38;
  const lnBias = 0.82 + lnRatio * 0.42;
  const odScore = curve(normalize(od, 6.0, 9.8), 0.8);
  const lengthScore = curve(normalize(length, ...baseline.length), 0.8);
  const objectScore = curve(normalize(objects, ...baseline.objects), 0.75);
  const ppScore = curve(normalize(score.pp ?? 0, ...baseline.pp), 0.7);
  const precisionBase = curve(normalize(acc, 0.94, 0.999), 1.55);
  const maxJudgementRatioScore = getMaxJudgementRatioScore(score.statistics);
  const precisionDifficultyGate = 0.34 + srScore * 0.66;
  const judgementPrecision = maxJudgementRatioScore == null
    ? precisionBase
    : precisionBase * 0.7 + (maxJudgementRatioScore * precisionDifficultyGate) * 0.3;
  const speedRateGate = rate < 1 ? Math.pow(rate, 0.72) : 1;

  const precision = clamp(
    (judgementPrecision * 0.7 + curve(normalize(acc, 0.985, 1), 1.1) * 0.18 + odScore * 0.12) *
      (0.34 + srScore * 0.66) *
      missPenalty,
  );

  const speed = clamp(
    (bpmScore * 0.45 + riceDensityScore * 0.35 + srScore * 0.2) *
      accGate *
      speedRateGate *
      riceBias,
  );

  const control = clamp(
    (srScore * 0.34 +
      odScore * 0.18 +
      (densityScore * 0.09 + lnDensityScore * 0.13) +
      precisionBase * 0.2 +
      objectScore * 0.08) *
      lnBias *
      (isRateFarm ? 0.96 : 1.03) *
      accGate *
      comboGate,
  );

  const stamina = clamp(
    (lengthScore * 0.36 +
      objectScore * 0.25 +
      densityScore * 0.19 +
      srScore * 0.2) *
      accGate *
      comboGate,
  );

  return {
    star,
    precision,
    speed,
    control,
    stamina,
    peak: ppScore,
  };
}

function createEmptySums(): TraitSums {
  return {
    star: 0,
    precision: 0,
    precisionPeak: 0,
    speed: 0,
    control: 0,
    stamina: 0,
    peak: 0,
    weight: 0,
    count: 0,
  };
}

function toProfile(keyMode: number, sums: TraitSums): KeymodeProfile | null {
  if (sums.weight <= 0 || sums.count <= 0) return null;

  const averagePrecision = sums.precision / sums.weight;
  const precision = averagePrecision * 0.72 + sums.precisionPeak * 0.28;
  const speed = sums.speed / sums.weight;
  const control = sums.control / sums.weight;
  const stamina = sums.stamina / sums.weight;
  const peak = sums.peak / sums.weight;
  const strength =
    peak * 0.34 +
    precision * 0.2 +
    control * 0.18 +
    speed * 0.16 +
    stamina * 0.12;

  return {
    keyMode,
    starAvg: sums.star / sums.weight,
    precision,
    speed,
    control,
    stamina,
    peak,
    strength,
    weight: sums.weight,
    count: sums.count,
  };
}

function blendProfiles(profiles: KeymodeProfile[]): {
  starAvg: number;
  precision: number;
  speed: number;
  control: number;
  stamina: number;
  peak: number;
  mainKeyMode: number;
  versatility: number;
  archetype: string;
} {
  const countOrdered = [...profiles].sort((a, b) => b.count - a.count);
  const countMain = countOrdered[0];
  const countSecondary = countOrdered[1];
  const totalCount = profiles.reduce((sum, p) => sum + p.count, 0);
  const countMainShare = totalCount > 0 ? countMain.count / totalCount : 1;
  const countSecondaryShare = countSecondary && totalCount > 0 ? countSecondary.count / totalCount : 0;
  const isTrueHybrid =
    !!countSecondary &&
    countMainShare <= 0.58 &&
    countSecondaryShare >= 0.35 &&
    countMainShare - countSecondaryShare <= 0.18;

  const main = countMain;
  const secondary = countSecondary;
  const secondaryBlend = secondary
    ? isTrueHybrid
      ? clamp(countSecondaryShare * 0.55, 0.18, 0.32)
      : clamp((1 - countMainShare) * 0.18, 0, 0.12)
    : 0;
  const mainBlend = 1 - secondaryBlend;

  const blend = (field: keyof Pick<KeymodeProfile, "precision" | "speed" | "control" | "stamina" | "peak" | "starAvg">) =>
    main[field] * mainBlend + (secondary?.[field] ?? main[field]) * secondaryBlend;

  const balance =
    profiles.length <= 1
      ? 0
      : 1 - profiles.reduce((max, p) => Math.max(max, p.count / totalCount), 0);
  const secondaryStrength = secondary ? secondary.strength : 0;
  const versatility = clamp(balance * 1.3 + secondaryStrength * 0.35);

  const traitEntries = [
    ["Precision", blend("precision")] as const,
    ["Speed", blend("speed")] as const,
    ["Control", blend("control")] as const,
    ["Stamina", blend("stamina")] as const,
  ].sort((a, b) => b[1] - a[1]);

  const keyLabel =
    isTrueHybrid
      ? `${countMain.keyMode}K/${countSecondary.keyMode}K Hybrid`
      : `${countMain.keyMode}K ${traitEntries[0][0]}`;

  return {
    starAvg: blend("starAvg"),
    precision: blend("precision"),
    speed: blend("speed"),
    control: blend("control"),
    stamina: blend("stamina"),
    peak: blend("peak"),
    mainKeyMode: main.keyMode,
    versatility,
    archetype: keyLabel,
  };
}

function toCardValue(value: number): number {
  return Math.round(clamp(value) * 1000);
}

const DISPLAY_SKILL_SCALE = 1500;
const DISPLAY_SKILL_CURVE = 0.68;

function toDisplaySkillValue(value: number): number {
  return Math.round(curve(value, DISPLAY_SKILL_CURVE) * DISPLAY_SKILL_SCALE);
}

export function computeGlobalPpStrength(pp: number | null | undefined): number {
  const value = Math.max(0, pp ?? 0);
  return curve(normalize(value, 12_000, 24_000), 0.7);
}

export function computeManiaSkills(scores: OsuScore[], options: { globalPp?: number | null } = {}): ManiaSkills | null {
  const pool = scores.filter(isUsable).slice(0, MAX_PLAYS);
  if (pool.length === 0) return null;

  const keyModeCounts = new Map<number, number>();
  for (const score of pool) {
    const keyMode = getKeyMode(score);
    keyModeCounts.set(keyMode, (keyModeCounts.get(keyMode) ?? 0) + 1);
  }

  const byKeyMode = new Map<number, TraitSums>();

  for (const [index, score] of pool.entries()) {
    const keyMode = getKeyMode(score);
    const baseline = getBaseline(keyMode);
    const traits = computePlayTraits(score, baseline);
    if (!Object.values(traits).every(Number.isFinite)) continue;

    const weight = scoreWeight(score, index, keyModeCounts.get(keyMode) ?? 1);
    const sums = byKeyMode.get(keyMode) ?? createEmptySums();
    sums.star += traits.star * weight;
    sums.precision += traits.precision * weight;
    sums.precisionPeak = Math.max(sums.precisionPeak, traits.precision);
    sums.speed += traits.speed * weight;
    sums.control += traits.control * weight;
    sums.stamina += traits.stamina * weight;
    sums.peak += traits.peak * weight;
    sums.weight += weight;
    sums.count++;
    byKeyMode.set(keyMode, sums);
  }

  const profiles = [...byKeyMode.entries()]
    .map(([keyMode, sums]) => toProfile(keyMode, sums))
    .filter((profile): profile is KeymodeProfile => profile != null);
  if (profiles.length === 0) return null;

  const blended = blendProfiles(profiles);
  const globalPpStrength = computeGlobalPpStrength(options.globalPp);
  const cardPower =
    blended.peak * 0.33 +
    globalPpStrength * 0.39 +
    blended.control * 0.09 +
    blended.speed * 0.07 +
    blended.precision * 0.05 +
    blended.stamina * 0.07;

  return {
    starAvg: blended.starAvg,
    fingerControl: toDisplaySkillValue(blended.control),
    speed: toDisplaySkillValue(blended.speed),
    accuracy: toDisplaySkillValue(blended.precision),
    stamina: toDisplaySkillValue(blended.stamina),
    versatility: toDisplaySkillValue(blended.versatility),
    peak: toDisplaySkillValue(blended.peak),
    cardPower: toCardValue(cardPower),
    mainKeyMode: blended.mainKeyMode,
    archetype: blended.archetype,
    sampleSize: profiles.reduce((sum, profile) => sum + profile.count, 0),
  };
}

export function getManiaCardTier(cardPower: number): ManiaCardTier {
  if (cardPower >= 700) return "worldClass";
  if (cardPower >= 635) return "ascendant";
  if (cardPower >= 575) return "mythic";
  if (cardPower >= 470) return "legendary";
  if (cardPower >= 410) return "ultraRare";
  if (cardPower >= 330) return "superRare";
  if (cardPower >= 240) return "elite";
  if (cardPower >= 120) return "rare";
  return "common";
}

export interface NextManiaCardTier {
  tier: ManiaCardTier;
  label: string;
  currentTier: ManiaCardTier;
  currentLabel: string;
  threshold: number;
  remaining: number;
  progress: number;
}

const MANIA_CARD_TIER_THRESHOLDS: Array<{ tier: ManiaCardTier; threshold: number }> = [
  { tier: "rare", threshold: 120 },
  { tier: "elite", threshold: 240 },
  { tier: "superRare", threshold: 330 },
  { tier: "ultraRare", threshold: 410 },
  { tier: "legendary", threshold: 470 },
  { tier: "mythic", threshold: 575 },
  { tier: "ascendant", threshold: 635 },
  { tier: "worldClass", threshold: 700 },
];

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
};
