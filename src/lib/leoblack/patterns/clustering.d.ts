import type { LeoBlackPatternCluster } from "./service.js";

// A found pattern window as appendFoundPattern builds it. MsPerBeat 0 is the
// Density/Inverse "no meaningful tempo" sentinel (resolvedMspb in
// findPatterns.js) and is excluded from cluster BPM averaging.
export interface LeoBlackFoundPattern {
  Pattern: string;
  SpecificType: string | null;
  Mixed: boolean;
  Start: number;
  End: number;
  MsPerBeat: number;
}

export function calculateClusteredPatterns(
  patterns: LeoBlackFoundPattern[],
  options?: { modeTag?: string },
): LeoBlackPatternCluster[];
