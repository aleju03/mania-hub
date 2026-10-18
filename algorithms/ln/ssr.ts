import { parseManiaBeatmap } from "../chart/beatmap";
import { isLnSkillSupported, lnRatingAtGoal, lnSkillOfWorkload, type LnSkillResult } from "./skill";
import { prismPlayLnSkill } from "../prism/ln-skill";
import { PRISM_BASE_GOAL, PRISM_KEY_COUNTS, PRISM_MAX_GOAL, usesPrism } from "../prism/params";
import { buildLnWorkload } from "./workload";

export const SSR_CALC_GOAL_CAP = 0.965;
export const SSR_EXTRAPOLATION_BASE_GOAL = 0.93;

export const SSR_EXTRAPOLATION_MAX_SLOPE = 1.2;

export function ssrGoalAnchors(keyCount: number | null | undefined): { cap: number; base: number } {
  return usesPrism(keyCount) ? { cap: PRISM_MAX_GOAL, base: PRISM_BASE_GOAL }
    : { cap: SSR_CALC_GOAL_CAP, base: SSR_EXTRAPOLATION_BASE_GOAL };
}

export function lnSsrSolverGoal(goal: number, keyCount?: number | null): number {
  return Math.min(ssrGoalAnchors(keyCount).cap, Math.max(0, Math.min(0.999, goal)));
}

export function analyzeLnSsr(
  osuText: string,
  options: { rate: number; od?: number | null; scoreGoal: number },
): LnSkillResult | null {
  const goal = Math.max(0, Math.min(0.999, options.scoreGoal));
  const solverGoal = lnSsrSolverGoal(goal);
  const map = parseManiaBeatmap(osuText);
  if (PRISM_KEY_COUNTS.has(map.keyCount)) {
    if (!isLnSkillSupported(map.keyCount)) return null;
    const skill = prismPlayLnSkill(map, { rate: options.rate, od: options.od, scoreGoal: goal });
    return skill && { ...skill, scoreGoal: lnSsrSolverGoal(goal, map.keyCount) };
  }
  const workload = buildLnWorkload(map, { rate: options.rate, od: options.od });
  if (!workload) return null;
  const capped = lnSkillOfWorkload(map, workload, { scoreGoal: solverGoal });
  if (goal <= SSR_CALC_GOAL_CAP || !(capped.rating != null && capped.rating > 0)) return capped;
  return { ...capped, rating: extrapolated(capped.rating, lnRatingAtGoal(workload, SSR_EXTRAPOLATION_BASE_GOAL), goal) };
}

function extrapolated(atCap: number, atBase: number, goal: number): number {
  if (!(atBase > 0) || atCap <= atBase) return atCap;
  const exponent = (goal - SSR_CALC_GOAL_CAP) / (SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL);
  return atCap * Math.pow(Math.min(atCap / atBase, SSR_EXTRAPOLATION_MAX_SLOPE), exponent);
}
