export interface LeoBlackEstimatorOptions {
  speedRate?: number;
  odFlag?: number | string | null;
  cvtFlag?: string | null;
  withGraph?: boolean;
  /** Use the -ext interval tables where a keymode has them (upstream's extended estimation range). */
  extendedEstimationRange?: boolean;
  /** Emit the "RC || LN" split even when lnRatio < 0.15. */
  enableAlwaysShowLNDifficulty?: boolean;
  /**
   * Inputs for the marathon duration correction Azusa and Roxy apply to their
   * own numeric difficulty. Omit it (or leave ettValues null) and neither
   * estimator moves. Upstream's pipeline only injects this for 4K charts over
   * 300 seconds; the module itself re-checks the duration.
   */
  marathonCorrection?: { durationS: number; ettValues: Record<string, number> | null } | null;
}

export interface MixedCompanellaPlan {
  lnRatio: number;
  lnDifficulty: string;
  /** Low-band Azusa/Companella blend; absent for the original hybrid path. */
  fuseRc?: boolean;
  onDisagree?: "azusa" | "companella";
  rcEstDiff?: string;
  rcNumeric?: number | null;
  rcNumericHint?: string | null;
}

export interface LeoBlackReworkResult {
  star: number;
  lnRatio: number;
  columnCount: number;
  graph: unknown;
  estDiff: string;
  numericDifficulty: number | null;
  numericDifficultyHint: string | null;
  mixedCompanellaPlan: MixedCompanellaPlan | null;
  /** The sub-algorithm the Mixed routing actually selected (Sunny/Roxy/Azusa/Daniel/Companella). */
  actualEstimatorAlgorithm?: string;
  /** Roxy/Azusa pre-calibration raw signal; absent when Sunny produced the result. */
  rawNumericDifficulty?: number | null;
  debug?: unknown;
}

export function runMixedEstimatorFromText(
  osuText: string,
  options?: LeoBlackEstimatorOptions,
): LeoBlackReworkResult;

export function applyCompanellaToMixedResult(
  mixedResult: LeoBlackReworkResult,
  companellaResult: { estDiff: string; numericDifficulty: number | null; numericDifficultyHint: string | null },
): LeoBlackReworkResult;

export function composeDifficultyFromRcLn(rcLabel: string, lnLabel: string, lnRatio: number): string;
