export interface LeoBlackEstimatorOptions {
  speedRate?: number;
  odFlag?: number | null;
  cvtFlag?: string | null;
  withGraph?: boolean;
}

export interface LeoBlackReworkResult {
  star: number;
  lnRatio: number;
  columnCount: number;
  graph: unknown;
  estDiff: string;
  numericDifficulty: number | null;
  numericDifficultyHint: string | null;
  mixedCompanellaPlan: { lnRatio: number; lnDifficulty: string } | null;
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
