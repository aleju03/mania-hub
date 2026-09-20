import type { LeoBlackEstimatorOptions, LeoBlackReworkResult } from "../estimator/mixedEstimator.js";
import type { LeoBlackMsdResult } from "../ett/index.js";

/** Typed subset of the upstream pipeline used for integration parity checks. */
export function runAnalysisPipeline(input: {
  rawText: string;
  estimatorAlgorithm: "Mixed";
  options?: LeoBlackEstimatorOptions & {
    etternaVersion?: string;
    companellaEtternaVersion?: string;
    withEtterna?: boolean;
    withInterlude?: boolean;
  };
}): Promise<{
  rework: LeoBlackReworkResult;
  ettResult: LeoBlackMsdResult | null;
  ettError: string | null;
  companellaEttResult: LeoBlackMsdResult | null;
  companellaEttError: string | null;
  interludeStar: number;
  interludeError: string | null;
}>;
