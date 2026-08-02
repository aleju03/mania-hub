/** MinaCalc skillset values, keyed by the official names (`Overall`, `Stream`, ...). */
export interface CompanellaMsdInput {
  [skillset: string]: number;
}

export interface CompanellaEstimate {
  /** Display difficulty, e.g. "Reform 8 mid/low" or "Epsilon low". */
  estDiff: string;
  /** Model output clamped to [1, 20] and shifted +1, rounded to 2dp. */
  numericDifficulty: number | null;
  numericDifficultyHint: string | null;
  danLabel: string;
  variant: string;
  /** 1.0 at a tier centre, falling to 0 at the boundary between tiers. */
  confidence: number;
  rawModelOutput: number;
}

export function classifyCompanellaDifficulty(input: {
  msdValues: CompanellaMsdInput | null | undefined;
  interludeStar: number;
  sunnyStar: number;
}): Promise<CompanellaEstimate>;
