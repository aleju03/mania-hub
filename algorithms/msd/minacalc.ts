export type MinaCalcSkillset =
  | "Overall"
  | "Stream"
  | "Jumpstream"
  | "Handstream"
  | "Stamina"
  | "JackSpeed"
  | "Chordjack"
  | "Technical";

export interface MinaCalcOptions {
  etternaVersion?: string;
  musicRate: number;
  scoreGoal?: number;
  keyOverride: number | null;
  lnTailTaps: boolean;
}

export interface MinaCalcResult {
  etternaVersion: string | null;
  values: Record<string, number>;
}

export declare const DEFAULT_ETTERNA_VERSION: "0.72.3";

export declare function pinnedEtternaVersionForKeycount(keyCount: number): string | null;

export declare function analyzeEtternaFromText(
  osuText: string,
  options: MinaCalcOptions,
): Promise<MinaCalcResult>;
