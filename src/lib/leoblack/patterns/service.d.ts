export interface LeoBlackPatternCluster {
  Pattern: string;
  SpecificTypes: Array<[string, number]>;
  RatingMultiplier: number;
  BPM: number;
  Mixed: boolean;
  Amount: number;
  readonly Importance: number;
  format(rate?: number): string;
}

export interface LeoBlackPatternReport {
  Clusters: LeoBlackPatternCluster[];
  Category: string;
  LNPercent: number;
  HBRowRatio: number;
  ModeTag: "RC" | "LN" | "HB" | "Mix";
  SVAmount: number;
  Duration: number;
  readonly ImportantClusters: LeoBlackPatternCluster[];
}

export function analyzePatternFromText(
  osuText: string,
  rate?: number,
): { report: LeoBlackPatternReport; topFiveClusters: LeoBlackPatternCluster[] };
