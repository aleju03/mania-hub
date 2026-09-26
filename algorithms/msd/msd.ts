// A chart's Etterna MSD (MinaCalc skillsets) at a rate and score goal, plus
// the in-house LN rating as an extra "LN" skillset on 4K. Also holds the 6K/7K
// LN-tail blend, which nudges MSD toward a pass that counts LN tails as taps.
import { analyzeEtternaFromText, DEFAULT_ETTERNA_VERSION, pinnedEtternaVersionForKeycount } from "./minacalc";
import { analyzeVibroSections, prepareVibroChart, usesSectionVibro, type VibroAnalysis } from "../vibro/sections";
import { parseManiaBeatmap } from "../chart/beatmap";
import { analyzeLnSkillFromText, isLnSkillSupported, type LnSkillResult } from "../ln/skill";

export interface MsdResult {
  etternaVersion: string;
  values: Record<string, number>;
  lnSkill?: LnSkillResult;
  vibroAnalysis?: VibroAnalysis;
  /** False on full-chart estimates; true when applying player-rating policy. */
  vibroAdjusted?: boolean;
}

export interface MsdOptions {
  /** Companella uses 0.74.0 independently of the ordinary 4K MSD default. */
  etternaVersion?: string;
  /** Opt player SSRs into localized vibro removal. */
  adjustVibro?: boolean;
  rate?: number;
  keyCount?: number;
  scoreGoal?: number;
  lnTailTaps?: boolean;
  includeLnSkill?: boolean;
}

// MinaCalc rates 4..18K: 4/5/6/7 through their own per-keycount classes, the
// rest through the generic n-key pipeline. Anything narrower than 4K has no calc.
const MSD_SUPPORTED_KEYS = new Set(Array.from({ length: 15 }, (_, i) => i + 4));

// 6K/7K tail-aware difficulty adjustment: the share of the way from base MSD
// toward the tails-as-taps pass. A heuristic, not a proven bound on release
// work. 4K never inserts tail taps: native MinaCalc is the press baseline and
// LN difficulty comes from the separate LN model. Other keymodes get no blend
// rather than a guessed weight.
export const LN_TAIL_BLEND_BY_KEYMODE: Record<number, number> = { 6: 0.3, 7: 0.3 };
/** Hold share (0-1) a chart must exceed before a tail-aware pass is run at all. */
export const LN_TAIL_MIN_RATIO = 0.02;

/**
 * Compute the Etterna MSD skillset values for a chart at the given rate.
 * `scoreGoal` is the target wife percent (default 0.93, the MSD baseline);
 * passing a score's accuracy turns the result into that score's SSR. The calc
 * clamps goals above 0.965 itself, mirroring Etterna's SSR cap.
 * Returns null for keymodes MinaCalc does not support (anything outside 4-18K).
 */
export async function computeMsd(
  osuText: string,
  options: MsdOptions = {},
): Promise<MsdResult | null> {
  const keyCount = options.keyCount;
  if (keyCount != null && !isMsdSupportedKeyCount(keyCount)) return null;

  const map = parseManiaBeatmap(osuText);
  const prepared = options.adjustVibro ? prepareVibroChart(osuText, options.rate ?? 1, map) : null;
  const analysis = usesSectionVibro(map) ? prepared?.analysis ?? analyzeVibroSections(map, options.rate ?? 1) : undefined;
  // 4K tails belong to the LN model. Even a caller asking for a tail pass
  // must not add extra presses to native MinaCalc on 4K.
  const msd = await runMinaCalc(prepared?.osuText ?? osuText,
    { ...options, lnTailTaps: map.keyCount === 4 ? false : options.lnTailTaps });
  // The LN model reads the original chart, not the vibro-trimmed one.
  const lnSkill = msd && (keyCount == null || isLnSkillSupported(keyCount)) && !options.lnTailTaps && options.includeLnSkill !== false
    ? analyzeLnSkillFromText(osuText, { rate: options.rate, scoreGoal: options.scoreGoal }) : null;
  return msd ? { ...msd, vibroAdjusted: options.adjustVibro === true,
    ...(lnSkill ? { lnSkill, values: { ...msd.values, LN: lnSkill.rated ? lnSkill.rating ?? 0 : 0 } } : {}),
    ...(analysis ? { vibroAnalysis: analysis } : {}) } : null;
}

/** Blend base MSD values toward the tail-aware pass by the keymode weight. */
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
    // Only ever raises a skillset: a tail pass that rates lower is ignored.
    values[name] = blend > 0 && atBase > 0 && atTails > atBase
      ? atBase + blend * (atTails - atBase)
      : atBase;
  }
  return values;
}

/**
 * Display-ready LN-adjusted MSD: the blended values, or null when blending
 * moves Overall by less than 0.005 (rice charts, keymodes without a blend
 * weight), so callers can hide a redundant readout.
 */
export function lnAdjustedMsd(
  base: Record<string, number> | null,
  tails: Record<string, number> | null,
  keyCount: number,
): Record<string, number> | null {
  if (!base || !tails) return null;
  const blended = blendLnTailValues(base, tails, keyCount);
  if (Number(blended.Overall ?? 0) - Number(base.Overall ?? 0) < 0.005) return null;
  // LN, when present, comes from the independent LN model in the base values.
  // It is never synthesized from Overall or blended with tails-as-taps.
  return blended;
}

export function isMsdSupportedKeyCount(keyCount: number): boolean {
  return MSD_SUPPORTED_KEYS.has(keyCount);
}

/** The MinaCalc build a keymode's MSD and SSRs come from when no version is requested. */
export function minaCalcVersionFor(keyCount: number): string {
  return pinnedEtternaVersionForKeycount(keyCount) ?? DEFAULT_ETTERNA_VERSION;
}

/**
 * What callers pass to `.catch()` around computeMsd: a chart the calculator
 * rejects gets no MSD, and callers fall back to their no-MSD path.
 */
export function msdChartErrorFallback(_error: unknown): null {
  return null;
}

async function runMinaCalc(osuText: string, options: MsdOptions): Promise<Pick<MsdResult, "etternaVersion" | "values">> {
  const result = await analyzeEtternaFromText(osuText, {
    etternaVersion: options.etternaVersion,
    musicRate: options.rate ?? 1,
    scoreGoal: options.scoreGoal,
    keyOverride: options.keyCount ?? null,
    lnTailTaps: options.lnTailTaps === true,
  });
  return { etternaVersion: result.etternaVersion ?? "unknown", values: result.values };
}
