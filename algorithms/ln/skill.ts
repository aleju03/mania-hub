import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { chartIsLn, LN_EFFECTIVE_MIN_RATIO, LN_MIN_WORK_SHARE } from "../dan-estimator/ln-effective";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { classifyLnSkillsets } from "./skillset-classifier";
import { buildLnWorkload, emptyLnFamilyVector, type LnFamilyVector, type LnWorkload } from "./workload";
import { LN_AXIS_KEY_COUNTS } from "./axis-keymodes";
import { prismLnLeadValues } from "../prism/ln-lead";
import { PRISM_KEY_COUNTS } from "../prism/switch";

export const LN_SKILL_VERSION = 15;

export const LN_SKILL_KEY_COUNTS: ReadonlySet<number> = LN_AXIS_KEY_COUNTS;
export const LN_SKILL_SCORE_GOAL = 0.93;
export function isLnSkillSupported(keyCount: number): boolean {
  return LN_SKILL_KEY_COUNTS.has(keyCount);
}

export const LN_SKILL_SCALE = 3.6427;
export const LN_SKILL_EXPONENT = 0.57;

export const LN_SKILL_RATE_EXPONENT_UP = 0.06;
export const LN_SKILL_RATE_EXPONENT_DOWN = -0.05;
export function lnSkillRateFactor(rate: number): number {
  return Math.pow(rate, rate >= 1 ? LN_SKILL_RATE_EXPONENT_UP : LN_SKILL_RATE_EXPONENT_DOWN);
}

const SECTION_RANK_DECAY = 0.95;

export interface LnSkillResult {
  version: number;
  keyCount: number;
  rating: number | null;
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

export function withoutLnFamilyRatings(base: Record<string, number>): Record<string, number> {
  const values = { ...base };
  for (const key of Object.values(FAMILY_VALUE_KEYS)) delete values[key];
  return values;
}

const LN_OVERALL_WEIGHT_AT_60 = 0.5;
const LN_OVERALL_OFFSET = 1;
const LN_PUBLISHED_SCALE = 1.82;
const LN_PUBLISHED_EXPONENT = 0.84;

export function publishedLnRating(skill: Pick<LnSkillResult, "rated" | "rating" | "holdRatio"> & { keyCount?: number }, overall: number | null | undefined): number {
  if (!skill.rated || !(skill.rating != null && skill.rating > 0)) return 0;
  if (skill.keyCount != null && PRISM_KEY_COUNTS.has(skill.keyCount)) return skill.rating;
  const native = Number(overall);
  const weight = overall != null && Number.isFinite(native) && native > 0
    ? Math.max(0, Math.min(1, LN_OVERALL_WEIGHT_AT_60 - (skill.holdRatio - 0.6))) : 0;
  const blended = (1 - weight) * skill.rating + weight * (native + LN_OVERALL_OFFSET);
  return LN_PUBLISHED_SCALE * Math.pow(Math.max(0, blended), LN_PUBLISHED_EXPONENT);
}

export function lnSkillDisplayValues(skill: LnSkillResult, base: Record<string, number> = {}): Record<string, number> {
  const ln = publishedLnRating(skill, base.Overall);
  return prismLnLeadValues(skill.keyCount, { ...withoutLnFamilyRatings(base), LN: ln }, ln, skill.holdRatio);
}

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

export function lnRatingAtGoal(workload: LnWorkload, goal: number): number {
  return lnRating(strainAtGoal(workload.sections, goal), workload.timeline.playbackRate);
}

type LnSkillMap = Pick<ManiaBeatmap, "notes" | "keyCount" | "od">;
type LnSkillOptions = { rate?: number; od?: number | null; scoreGoal?: number; includeSkillsets?: boolean };

export function analyzeLnSkill(map: LnSkillMap, options: LnSkillOptions = {}): LnSkillResult | null {
  if (PRISM_KEY_COUNTS.has(map.keyCount)) return null;
  const workload = buildLnWorkload(map, options);
  return workload && lnSkillOfWorkload(map, workload, options);
}

export function lnSkillOfWorkload(map: LnSkillMap, workload: LnWorkload, options: Omit<LnSkillOptions, "rate" | "od"> = {}): LnSkillResult {
  const { timeline, effective } = workload;
  const scoreGoal = Number.isFinite(options.scoreGoal) ? Math.max(0, Math.min(0.999, Number(options.scoreGoal))) : LN_SKILL_SCORE_GOAL;
  const worked = timeline.valid && effective.effectiveHolds > 0;
  const result: LnSkillResult = {
    version: LN_SKILL_VERSION, keyCount: map.keyCount, rating: timeline.valid ? 0 : null, strain: 0,
    eligible: worked && chartIsLn(4, { lnRatio: effective.holdRatio, lnEffectiveRatio: effective.effectiveLnRatio }) === true,
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

export function lnSkillsetsOfWorkload(map: Pick<ManiaBeatmap, "notes">, workload: LnWorkload): LnFamilyVector {
  return workload.effective.identityWorkShare >= LN_MIN_WORK_SHARE
    ? classifyLnSkillsets(map.notes, workload.timeline.playbackRate) ?? emptyLnFamilyVector() : emptyLnFamilyVector();
}

export function analyzeLnSkillFromText(osuText: string, options: LnSkillOptions = {}): LnSkillResult | null {
  return analyzeLnSkill(parseManiaBeatmap(osuText), options);
}
