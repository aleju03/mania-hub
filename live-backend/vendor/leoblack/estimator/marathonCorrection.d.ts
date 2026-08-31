/** Aggregated skill split the balance gate reads; null when there is no usable MSD. */
export function aggregateSkillsets(
  ettValues: Record<string, number> | null | undefined,
): { jk: number; st: number; te: number; en: number; total: number } | null;

/**
 * Correction amount in numeric-difficulty units, 0 when the chart is short,
 * carried by a single skillset, missing MSD, or tapered out at the top.
 */
export function computeMarathonCorrection(
  input: { durationS: number; ettValues?: Record<string, number> | null; numeric?: number | null },
  params?: {
    thresholdS?: number;
    scale?: number;
    cap?: number;
    balanceRatio?: number;
    taperLo?: number;
    taperHi?: number;
  } | null,
): number;

export function applyMarathonCorrectionToNumeric(numeric: number, corr: number): number;

export function applyMarathonCorrectionToRcResult<T extends { numericDifficulty: number | null; estDiff: string }>(
  result: T,
  input: { durationS?: number; ettValues?: Record<string, number> | null },
): T;

export const MARATHON_DURATION_THRESHOLD_S: number;
export const MARATHON_CORRECTION_SCALE: number;
export const MARATHON_CORRECTION_CAP: number;
export const MARATHON_BALANCE_RATIO: number;
export const MARATHON_TAPER_LO: number;
export const MARATHON_TAPER_HI: number;
