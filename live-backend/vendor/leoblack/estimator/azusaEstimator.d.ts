import type { LeoBlackEstimatorOptions, LeoBlackReworkResult } from "./mixedEstimator.js";

export function runAzusaEstimatorFromText(
  osuText: string,
  options?: LeoBlackEstimatorOptions,
): Omit<LeoBlackReworkResult, "mixedCompanellaPlan">;
