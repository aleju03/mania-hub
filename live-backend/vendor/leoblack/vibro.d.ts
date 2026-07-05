import type { LeoBlackPatternReport } from "./patterns/service";

export function detectVibro(
  msdValues: Record<string, unknown> | null | undefined,
  threshold: number,
): boolean;

export function detectVibroFromLongjackPattern(
  patternReport: LeoBlackPatternReport | null | undefined,
  threshold: number,
  minBpm?: number,
): boolean;
