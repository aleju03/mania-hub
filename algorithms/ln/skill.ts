import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { chartIsLn, LN_EFFECTIVE_MIN_RATIO, LN_MIN_WORK_SHARE } from "../dan-estimator/ln-effective";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { classifyLnSkillsets } from "./skillset-classifier";
import { buildLnWorkload, emptyLnFamilyVector, type LnFamilyVector, type LnWorkload } from "./workload";

/** v13 keeps normalized strain units and replaces the withdrawn, example-tuned v10 draft with required-action
 * workloads. Model development uses synthetic mechanical invariants only.
 * v14 prices every written hold as a hold and every finger of a chord
 * (ln-workload.ts), on constants refit below. */
export const LN_SKILL_VERSION = 14;
export const LN_SKILL_KEY_COUNTS: ReadonlySet<number> = new Set([4]);
export const LN_SKILL_SCORE_GOAL = 0.93;
export function isLnSkillSupported(keyCount: number): boolean {
  return LN_SKILL_KEY_COUNTS.has(keyCount);
}

// Strain to rating units, fitted on scores: a player at LN Dan N should read
// on LN what a player at regular Dan N reads on Overall from rice plays
// alone, each over up to 20 top plays. Refit 2026-09-30 for v14 on the median
// of each Dan from 2 to 16 over 3.7k players with an LN Dan and 20k with a
// regular one (five plays or more on the side): Dans 3 to 15 agree within 1.8 (root mean square 1.1). LN Dans
// 1 and 2 still read above, a range few players sit in. Fitted together with
// the rate exponents below.
export const LN_SKILL_SCALE = 3.6427;
export const LN_SKILL_EXPONENT = 0.57;
/**
 * Extra rate^k on the rating for a play's rate mod, one exponent for speeding
 * up and one for slowing down. Pricing every hold, the strain already grows
 * with the rate: the same actions land closer under a fixed half-life, and
 * holds a tap would release at 1.5x keep their work. Fitted on same-player
 * scores (2026-09-30): how often a chart played at 1.5x and another at 1.0x
 * by the same player are ordered by their accuracies, on charts of 75%+
 * holds split by mapset, 109k pairs in all. 0.06 orders 88.6% of the held-out half
 * (native Overall 85.5%, the v13 curve at 0.649 86.5%); 0.649 on the v14
 * strain orders 73%. On the same player's plays of one chart at both rates
 * (900 pairs) the LN SSR then moves 1.08x where native Overall moves 1.22x.
 * Slowing down, -0.05 fits both readings (42k and 679 pairs): the strain alone
 * falls a little faster than native Overall.
 */
export const LN_SKILL_RATE_EXPONENT_UP = 0.06;
export const LN_SKILL_RATE_EXPONENT_DOWN = -0.05;
export function lnSkillRateFactor(rate: number): number {
  return Math.pow(rate, rate >= 1 ? LN_SKILL_RATE_EXPONENT_UP : LN_SKILL_RATE_EXPONENT_DOWN);
}
// Ranked-section decay, fixed before inspecting any real-chart results.
const SECTION_RANK_DECAY = 0.95;

export interface LnSkillResult {
  version: number;
  keyCount: number;
  rating: number | null;
  /** Mechanical family evidence; independent of the play's accuracy goal. */
  skillsets?: LnFamilyVector;
  strain: number;
  eligible: boolean;
  rated: boolean;
  holdRatio: number;
  effectiveRatio: number;
  effectiveHolds: number;
  rate: number;
  od: number;
  scoreGoal: number;
}

const FAMILY_VALUE_KEYS = { lnhybrid: "LNHybrid", lntechnical: "LNTechnical", lnwalls: "LNWalls", lnspeed: "LNSpeed" } as const;
/** Strip obsolete public family axes from cached numeric vectors. */
export function withoutLnFamilyRatings(base: Record<string, number>): Record<string, number> {
  const values = { ...base };
  for (const key of Object.values(FAMILY_VALUE_KEYS)) delete values[key];
  return values;
}

/** Publish one LN scalar alongside the untouched native MinaCalc keys. */
export function lnSkillDisplayValues(skill: LnSkillResult, base: Record<string, number> = {}): Record<string, number> {
  return { ...withoutLnFamilyRatings(base), LN: skill.rated ? skill.rating ?? 0 : 0 };
}

/** The strain a player scores `goal` on: sections sorted hardest first and
 * decayed by rank, each scored 93% at its own demand, solved by bisection. */
function strainAtGoal(sections: LnWorkload["sections"], goal: number): number {
  if (!sections.length || goal === 0) return 0;
  const weighted = [...sections].sort((a, b) => b.demand - a.demand)
    .map((section, index) => ({ demand: section.demand, weight: section.work * Math.pow(SECTION_RANK_DECAY, index) }));
  const total = weighted.reduce((sum, section) => sum + section.weight, 0);
  if (!(total > 0)) return 0;
  const logGoal = Math.log(LN_SKILL_SCORE_GOAL);
  let hi = weighted[0].demand * 10, lo = 0;
  for (let i = 0; i < 40; i += 1) {
    const skill = (lo + hi) / 2, scale = Math.max(skill, 1e-9);
    let score = 0;
    for (const section of weighted) score += section.weight * Math.exp(logGoal * Math.pow(section.demand / scale, 4));
    if (score / total < goal) lo = skill;
    else hi = skill;
  }
  return (lo + hi) / 2;
}

const lnRating = (strain: number, rate: number) => LN_SKILL_SCALE * Math.pow(strain, LN_SKILL_EXPONENT) * lnSkillRateFactor(rate);

/** The LN rating of a workload at an accuracy goal. */
export function lnRatingAtGoal(workload: LnWorkload, goal: number): number {
  return lnRating(strainAtGoal(workload.sections, goal), workload.timeline.playbackRate);
}

type LnSkillMap = Pick<ManiaBeatmap, "notes" | "keyCount" | "od">;
type LnSkillOptions = { rate?: number; od?: number | null; scoreGoal?: number; includeSkillsets?: boolean };

export function analyzeLnSkill(map: LnSkillMap, options: LnSkillOptions = {}): LnSkillResult | null {
  const workload = buildLnWorkload(map, options);
  return workload && lnSkillOfWorkload(map, workload, options);
}

/** analyzeLnSkill on a workload already built for this map, rate and OD. */
export function lnSkillOfWorkload(map: LnSkillMap, workload: LnWorkload, options: Omit<LnSkillOptions, "rate" | "od"> = {}): LnSkillResult {
  const { timeline, effective } = workload;
  const scoreGoal = Number.isFinite(options.scoreGoal) ? Math.max(0, Math.min(0.999, Number(options.scoreGoal))) : LN_SKILL_SCORE_GOAL;
  const worked = timeline.valid && effective.effectiveHolds > 0;
  const result: LnSkillResult = {
    version: LN_SKILL_VERSION, keyCount: map.keyCount, rating: timeline.valid ? 0 : null, strain: 0,
    eligible: worked && chartIsLn(4, { lnRatio: effective.holdRatio, lnEffectiveRatio: effective.effectiveLnRatio }) === true,
    // A chart whose holds a tap releases in time has no LN side to number,
    // unless its same-lane chains alone make it LN (inverse).
    rated: worked && effective.holdRatio >= lnPrimaryMinRatioFor(4) && effective.identityWorkShare >= LN_MIN_WORK_SHARE
      && (!effective.tapCovered || effective.effectiveLnRatio >= LN_EFFECTIVE_MIN_RATIO),
    holdRatio: effective.holdRatio, effectiveRatio: effective.effectiveLnRatio, effectiveHolds: effective.effectiveHolds,
    rate: timeline.playbackRate, od: workload.od, scoreGoal,
  };
  if (!timeline.valid) return result;
  if (options.includeSkillsets !== false) result.skillsets = lnSkillsetsOfWorkload(map, workload);
  if (!worked || scoreGoal === 0) return result;
  result.strain = strainAtGoal(workload.sections, scoreGoal);
  result.rating = lnRating(result.strain, timeline.playbackRate);
  return result;
}

/** The skillset vector, empty for a chart whose holds carry no LN work. */
export function lnSkillsetsOfWorkload(map: Pick<ManiaBeatmap, "notes">, workload: LnWorkload): LnFamilyVector {
  return workload.effective.identityWorkShare >= LN_MIN_WORK_SHARE
    ? classifyLnSkillsets(map.notes, workload.timeline.playbackRate) ?? emptyLnFamilyVector() : emptyLnFamilyVector();
}

export function analyzeLnSkillFromText(osuText: string, options: LnSkillOptions = {}): LnSkillResult | null {
  return analyzeLnSkill(parseManiaBeatmap(osuText), options);
}
