export interface LeoBlackMsdOptions {
  musicRate?: number;
  scoreGoal?: number;
  keyOverride?: number | null;
  cvtFlag?: string | null;
  etternaVersion?: string | null;
}

export interface LeoBlackMsdResult {
  keycount: number;
  lnRatio: number;
  metadata: Record<string, string>;
  requestedEtternaVersion?: string;
  etternaVersion?: string;
  etternaVersionFallbackReason?: string | null;
  values: Record<string, number>;
  engine?: string;
}

export function analyzeEtternaFromText(osuText: string, options?: LeoBlackMsdOptions): Promise<LeoBlackMsdResult>;

export const DEFAULT_SCORE_GOAL: number;
export const DISPLAY_SKILLSET_ORDER: readonly string[];
