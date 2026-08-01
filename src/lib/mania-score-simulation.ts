import type { Judgment } from "./mania-replay-judgement";

// Live score counters for the replay HUD, mirroring the two real clients:
// - stable: ScoreV1 osu!mania (wiki/Gameplay/Score/ScoreV1/osu!mania), 1M cap
//   split into base + bonus halves with the running 0-100 Bonus counter.
// - lazer: ManiaScoreProcessor (150k combo / 850k * Acc^(2+2*Acc) accuracy
//   split, log4 combo factor clamped to [0.5, log4(400)], Perfect = 305 base
//   but 300 combo score).
// Judgment indices follow mania-replay-judgement: 1=MAX 2=300 3=200 4=100
// 5=50 6=MISS.

export type ManiaScoreMode = "stable" | "lazer";

export interface ManiaScoreSimulator {
  readonly value: number;
  applyJudgment(judgment: Judgment): void;
  reset(): void;
  /** Multiplies the displayed value; used to pin the simulated end state to
   *  the score the play actually earned. */
  setScale(scale: number): void;
}

const STABLE_HIT_VALUE = [0, 320, 300, 200, 100, 50, 0];
const STABLE_HIT_BONUS_VALUE = [0, 32, 32, 16, 8, 4, 0];
const STABLE_HIT_BONUS = [0, 2, 1, 0, 0, 0, 0];
const STABLE_HIT_PUNISHMENT = [0, 0, 0, 8, 24, 44, Infinity];

const LAZER_BASE_SCORE = [0, 305, 300, 200, 100, 50, 0];
const LAZER_COMBO_BASE_SCORE = [0, 300, 300, 200, 100, 50, 0];
const LAZER_MAX_BASE_SCORE = 305;
const LAZER_COMBO_FACTOR_CAP = Math.log(400) / Math.log(4);

function lazerComboFactor(combo: number): number {
  if (combo <= 0) return 0.5;
  return Math.min(Math.max(0.5, Math.log(combo) / Math.log(4)), LAZER_COMBO_FACTOR_CAP);
}

export interface StableScoreModFactors {
  multiplier: number;
  divider: number;
}

// ScoreV1 table: difficulty reductions scale the whole score, difficulty
// increases only soften the Bonus punishment (mania gives them no score
// multiplier).
export function getStableManiaScoreModFactors(mods: string[]): StableScoreModFactors {
  const set = new Set(mods);
  let multiplier = 1;
  if (set.has("EZ")) multiplier *= 0.5;
  if (set.has("NF")) multiplier *= 0.5;
  if (set.has("HT") || set.has("DC")) multiplier *= 0.5;
  let divider = 1;
  if (set.has("HR")) divider *= 1.08;
  if (set.has("DT") || set.has("NC")) divider *= 1.1;
  if (set.has("HD")) divider *= 1.06;
  if (set.has("FI")) divider *= 1.06;
  if (set.has("FL")) divider *= 1.06;
  return { multiplier, divider };
}

// lazer's ManiaScoreMultiplierCalculator: EZ/NF/DA halve, rate mods use the
// truncated-rate formula, NR/Constant Speed/Hold Off shave 10%. Difficulty
// increases stay 1.0x. Key mods are left at 1.0x (the 0.9x change only
// applies to 2025.718.0+ clients; the real-score normalization absorbs it).
export function getLazerManiaScoreMultiplier(mods: string[], rate: number): number {
  const set = new Set(mods);
  let multiplier = 1;
  if (set.has("EZ")) multiplier *= 0.5;
  if (set.has("NF")) multiplier *= 0.5;
  if (set.has("DA")) multiplier *= 0.5;
  if (set.has("WU") || set.has("WD") || set.has("AS")) multiplier *= 0.5;
  if (set.has("NR")) multiplier *= 0.9;
  if (set.has("CS")) multiplier *= 0.9;
  if (set.has("HO")) multiplier *= 0.9;
  if (Number.isFinite(rate) && rate > 0 && rate !== 1) {
    const truncated = Math.trunc(rate * 10) / 10 - 1;
    multiplier *= rate >= 1 ? 1 + truncated / 5 : 0.6 + truncated;
  }
  return Math.max(0, multiplier);
}

class StableManiaScoreSimulator implements ManiaScoreSimulator {
  private readonly unit: number;
  private readonly divider: number;
  private bonus = 100;
  private rawScore = 0;
  private scale = 1;

  constructor(totalNotes: number, factors: StableScoreModFactors) {
    this.unit = totalNotes > 0 ? (1_000_000 * factors.multiplier * 0.5) / totalNotes : 0;
    this.divider = factors.divider > 0 ? factors.divider : 1;
  }

  get value(): number {
    return Math.round(this.rawScore * this.scale);
  }

  applyJudgment(judgment: Judgment): void {
    if (judgment < 1 || judgment > 6) return;
    this.bonus = judgment === 6
      ? 0
      : Math.max(0, Math.min(100, this.bonus + STABLE_HIT_BONUS[judgment] - STABLE_HIT_PUNISHMENT[judgment] / this.divider));
    this.rawScore += this.unit * (STABLE_HIT_VALUE[judgment] / 320);
    this.rawScore += this.unit * ((STABLE_HIT_BONUS_VALUE[judgment] * Math.sqrt(this.bonus)) / 320);
  }

  reset(): void {
    this.bonus = 100;
    this.rawScore = 0;
  }

  setScale(scale: number): void {
    this.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }
}

class LazerManiaScoreSimulator implements ManiaScoreSimulator {
  private readonly totalJudgements: number;
  private readonly maxComboPortion: number;
  private readonly multiplier: number;
  private combo = 0;
  private comboPortion = 0;
  private baseScoreSum = 0;
  private judged = 0;
  private scale = 1;

  constructor(totalJudgements: number, multiplier: number) {
    this.totalJudgements = Math.max(0, totalJudgements);
    this.multiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    let max = 0;
    for (let combo = 1; combo <= this.totalJudgements; combo++) {
      max += LAZER_COMBO_BASE_SCORE[1] * lazerComboFactor(combo);
    }
    this.maxComboPortion = max;
  }

  get value(): number {
    if (this.judged === 0) return 0;
    const accuracy = this.baseScoreSum / (this.judged * LAZER_MAX_BASE_SCORE);
    const comboProgress = this.maxComboPortion > 0 ? this.comboPortion / this.maxComboPortion : 1;
    const accuracyProgress = this.totalJudgements > 0 ? this.judged / this.totalJudgements : 0;
    const total = 150_000 * comboProgress
      + 850_000 * Math.pow(accuracy, 2 + 2 * accuracy) * accuracyProgress;
    return Math.round(total * this.multiplier * this.scale);
  }

  applyJudgment(judgment: Judgment): void {
    if (judgment < 1 || judgment > 6) return;
    this.judged++;
    this.baseScoreSum += LAZER_BASE_SCORE[judgment];
    if (judgment === 6) {
      this.combo = 0;
      return;
    }
    this.combo++;
    this.comboPortion += LAZER_COMBO_BASE_SCORE[judgment] * lazerComboFactor(this.combo);
  }

  reset(): void {
    this.combo = 0;
    this.comboPortion = 0;
    this.baseScoreSum = 0;
    this.judged = 0;
  }

  setScale(scale: number): void {
    this.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }
}

export interface ManiaScoreSimulatorOptions {
  mode: ManiaScoreMode;
  totalJudgements: number;
  mods: string[];
  /** Effective playback rate of the score's mods (1.5 for DT, 0.75 for HT). */
  rate: number;
}

export function createManiaScoreSimulator(options: ManiaScoreSimulatorOptions): ManiaScoreSimulator {
  if (options.mode === "stable") {
    return new StableManiaScoreSimulator(
      options.totalJudgements,
      getStableManiaScoreModFactors(options.mods),
    );
  }
  return new LazerManiaScoreSimulator(
    options.totalJudgements,
    getLazerManiaScoreMultiplier(options.mods, options.rate),
  );
}

/** Scale that pins a simulated final score to the score the play actually
 *  earned. Falls back to 1 when either side is unusable or the drift is big
 *  enough to suggest the real score belongs to different scoring rules. */
export function getScoreScaleToReal(simulatedFinal: number, realScore: number | null | undefined): number {
  if (realScore == null || !Number.isFinite(realScore) || realScore <= 0) return 1;
  if (!Number.isFinite(simulatedFinal) || simulatedFinal <= 0) return 1;
  const ratio = realScore / simulatedFinal;
  if (ratio < 0.5 || ratio > 2) return 1;
  return ratio;
}

export function formatStableScore(score: number): string {
  return String(Math.max(0, Math.round(score))).padStart(8, "0");
}

export function formatLazerScore(score: number): string {
  return Math.max(0, Math.round(score)).toLocaleString("en-US");
}
