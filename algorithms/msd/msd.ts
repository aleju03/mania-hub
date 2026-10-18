import { analyzeLnSkillOnThread, analyzePrismOnThread, AnalysisThreadUnavailableError, computeMsdOnThread, MsdThreadUnavailableError } from "./inline";
import { PRISM_VERSION, PRISM_ENABLED, usesPrism } from "./prism";
import { analyzeVibroSections, prepareVibroChart, usesSectionVibro, VIBRO_SECTION_VERSION, type VibroAnalysis } from "../vibro/sections";
import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { isLnSkillSupported, lnSkillDisplayValues, type LnSkillResult } from "../ln/skill";
import { DEFAULT_ETTERNA_VERSION, pinnedEtternaVersionForKeycount } from "leoblack/ett/constants";

export { usesPrism };

export interface MsdResult {
  etternaVersion: string;
  values: Record<string, number>;
  lnSkill?: LnSkillResult;
  vibroAnalysis?: VibroAnalysis;
  vibroVersion?: number;
  vibroAdjusted?: boolean;
}

export interface MsdOptions {
  etternaVersion?: string;
  adjustVibro?: boolean;
  rate?: number;
  keyCount?: number;
  scoreGoal?: number;
  lnTailTaps?: boolean;
  includeLnSkill?: boolean;
}

export function msdChartErrorFallback(error: unknown): null {
  if (error instanceof MsdThreadUnavailableError || error instanceof AnalysisThreadUnavailableError) throw error;
  return null;
}

const MSD_SUPPORTED_KEYS = new Set(Array.from({ length: 15 }, (_, i) => i + 4));

export const LN_TAIL_BLEND_BY_KEYMODE: Record<number, number> = PRISM_ENABLED ? {} : { 6: 0.3, 7: 0.3 };
export const LN_TAIL_MIN_RATIO = 0.02;

export function blendLnTailValues(
  base: Record<string, number>,
  tails: Record<string, number>,
  keyCount: number,
): Record<string, number> {
  const blend = LN_TAIL_BLEND_BY_KEYMODE[keyCount] ?? 0;
  const values: Record<string, number> = {};
  for (const [name, atBase] of Object.entries(base)) {
    if (name === "LN") {
      values.LN = atBase;
      continue;
    }
    const atTails = Number(tails[name] ?? atBase);
    values[name] = blend > 0 && atBase > 0 && atTails > atBase
      ? atBase + blend * (atTails - atBase)
      : atBase;
  }
  return values;
}

export function lnAdjustedMsd(
  base: Record<string, number> | null,
  tails: Record<string, number> | null,
  keyCount: number,
): Record<string, number> | null {
  if (!base || !tails) return null;
  const blended = blendLnTailValues(base, tails, keyCount);
  if (Number(blended.Overall ?? 0) - Number(base.Overall ?? 0) < 0.005) return null;
  return blended;
}

export function isMsdSupportedKeyCount(keyCount: number): boolean {
  return MSD_SUPPORTED_KEYS.has(keyCount);
}

export function prismEngineVersion(): string {
  return `prism-v${PRISM_VERSION}`;
}

export function minaCalcVersionFor(keyCount: number): string {
  if (usesPrism(keyCount)) return prismEngineVersion();
  return pinnedEtternaVersionForKeycount(keyCount) ?? DEFAULT_ETTERNA_VERSION;
}

export const ENGINE_MOVE_TAG = PRISM_ENABLED ? `nkey-0.75.0+${prismEngineVersion()}` : "nkey-0.75.0";

const UNSTAMPED_MINACALC_BY_KEY_COUNT: Readonly<Record<number, string>> = Object.fromEntries(
  Array.from({ length: 14 }, (_, i) => [i + 5, "0.74.0"]),
);
export const MINACALC_RESTAMPED_KEY_COUNTS: ReadonlySet<number> = new Set(Object.keys(UNSTAMPED_MINACALC_BY_KEY_COUNT).map(Number));

export function storedMinaCalcVersion(keyCount: number, stamp: string | null | undefined): string {
  return stamp ?? UNSTAMPED_MINACALC_BY_KEY_COUNT[keyCount] ?? minaCalcVersionFor(keyCount);
}

export function minaCalcCurrent(keyCount: number, stamp: string | null | undefined): boolean {
  return storedMinaCalcVersion(keyCount, stamp) === minaCalcVersionFor(keyCount);
}

export function chartMsdAwaitsPrism(keyCount: number, stamp: string | null | undefined): boolean {
  return usesPrism(keyCount) && !minaCalcCurrent(keyCount, stamp);
}

export async function computeMsd(
  osuText: string,
  options: MsdOptions = {},
  parsedMap?: ManiaBeatmap,
  vibro: { prepared?: ReturnType<typeof prepareVibroChart> } = {},
): Promise<MsdResult | null> {
  const keyCount = options.keyCount;
  if (keyCount != null && !isMsdSupportedKeyCount(keyCount)) return null;

  const map = parsedMap ?? parseManiaBeatmap(osuText);
  const prepared = options.adjustVibro ? (vibro.prepared ??= prepareVibroChart(osuText, options.rate ?? 1, map)) : null;
  const analysis = usesSectionVibro(map) ? prepared?.analysis ?? analyzeVibroSections(map, options.rate ?? 1) : undefined;
  let msd: MsdResult | null;
  if (usesPrism(map.keyCount)) {
    if (options.lnTailTaps) return null;
    const prism = await analyzePrismOnThread(prepared?.osuText ?? osuText, { rate: options.rate, goal: options.scoreGoal });
    msd = prism ? { etternaVersion: prismEngineVersion(), values: prism.values } : null;
  } else {
    msd = await computeMsdOnThread(prepared?.osuText ?? osuText,
      { ...options, lnTailTaps: map.keyCount === 4 ? false : options.lnTailTaps });
  }
  const lnSkill = msd && (keyCount == null || isLnSkillSupported(keyCount)) && !options.lnTailTaps && options.includeLnSkill !== false
    ? await analyzeLnSkillOnThread(osuText, { rate: options.rate, scoreGoal: options.scoreGoal }) : null;
  return msd ? { ...msd, vibroVersion: VIBRO_SECTION_VERSION, vibroAdjusted: options.adjustVibro === true,
    ...(lnSkill ? { lnSkill, values: lnSkillDisplayValues(lnSkill, msd.values) } : {}),
    ...(analysis ? { vibroAnalysis: analysis } : {}) } : null;
}
