// Prism is the Rust workspace in ../prism; this file only declares the calls the rest of the code makes.
import type { ManiaBeatmap } from "../chart/beatmap";
import type { analyzeLnSkill, LnSkillResult } from "../ln/skill";

type LnSkillOptions = NonNullable<Parameters<typeof analyzeLnSkill>[1]>;
type LnSkillMap = Pick<ManiaBeatmap, "notes" | "keyCount" | "od">;

export interface PrismOptions {
  rate?: number;
  od?: number | null;
  goal?: number;
  overallOnly?: boolean;
}

export interface PrismResult {
  version: string;
  keyCount: number;
  rate: number;
  goal: number;
  values: Record<string, number>;
  centreHand: 0 | 1;
}

export declare const PRISM_VERSION: "0.25";
export declare const PRISM_ENABLED: true;
export declare const PRISM_KEY_COUNTS: ReadonlySet<number>;
export declare const PRISM_BASE_GOAL: 0.965;
export declare const PRISM_MAX_GOAL: 0.98;
export declare const PRISM_GOAL_FLOOR: 0.9;

export declare function usesPrism(keyCount: number | null | undefined): boolean;
export declare function analyzePrismFromText(osuText: string, options?: PrismOptions): PrismResult | null;
export declare function prismPlayLnSkill(map: LnSkillMap, options?: Omit<LnSkillOptions, "includeSkillsets">): LnSkillResult | null;
export declare function analyzeAnyLnSkillFromText(osuText: string, options?: LnSkillOptions): LnSkillResult | null;
export declare function prismLnLeadValues(keyCount: number, values: Record<string, number>, ln: number, holdRatio: number): Record<string, number>;
