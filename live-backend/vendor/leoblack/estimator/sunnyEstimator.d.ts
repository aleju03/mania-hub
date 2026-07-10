import type { LeoBlackEstimatorOptions, LeoBlackReworkResult } from "./mixedEstimator.js";

export function runSunnyEstimatorFromText(
  osuText: string,
  options?: LeoBlackEstimatorOptions,
): Omit<LeoBlackReworkResult, "mixedCompanellaPlan">;
