import { analyzeLnSkillFromText, type LnSkillResult } from "./ln-skill.js";

// Shared native/LN SSR extrapolation window. Keep both axes on the same cap.
export const SSR_CALC_GOAL_CAP = 0.965;
export const SSR_EXTRAPOLATION_BASE_GOAL = 0.93;
// Safety bound on the chart’s 0.93→0.965 slope (measured ~1.07–1.11).
export const SSR_EXTRAPOLATION_MAX_SLOPE = 1.2;

/** The goal the LN solver actually runs at for a play. Same cap as the
 * MinaCalc SSR: the solver never sees a goal above SSR_CALC_GOAL_CAP. */
export function lnSsrSolverGoal(goal: number): number {
  return Math.min(SSR_CALC_GOAL_CAP, Math.max(0, Math.min(0.999, goal)));
}

/**
 * LN SSR for a play, on the same terms as the press SSR from runMsdAtGoal:
 * solve at most at SSR_CALC_GOAL_CAP and extrapolate the cap-to-base slope
 * above it. The LN solver's own response runs away toward 100% (a perfect
 * play on a 24.8 chart solved to 38.7, above the hardest 4K LN course),
 * which is not how the press axis prices an SS. The stored scoreGoal is the
 * solver goal, so playLnSkillCurrent can tell a capped result from an old
 * uncapped one without a model version bump.
 */
export function analyzeLnSsr(
  osuText: string,
  options: { rate: number; od?: number | null; scoreGoal: number },
): LnSkillResult | null {
  const goal = Math.max(0, Math.min(0.999, options.scoreGoal));
  const solverGoal = lnSsrSolverGoal(goal);
  const capped = analyzeLnSkillFromText(osuText, { rate: options.rate, od: options.od, scoreGoal: solverGoal, includeStructure: false });
  if (!capped || goal <= SSR_CALC_GOAL_CAP || !(capped.rating != null && capped.rating > 0)) return capped;
  const base = analyzeLnSkillFromText(osuText, { rate: options.rate, od: options.od, scoreGoal: SSR_EXTRAPOLATION_BASE_GOAL, includeStructure: false });
  const atCap = capped.rating, atBase = base?.rating ?? 0;
  if (!(atBase > 0) || atCap <= atBase) return capped;
  const exponent = (goal - SSR_CALC_GOAL_CAP) / (SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL);
  return { ...capped, rating: atCap * Math.pow(Math.min(atCap / atBase, SSR_EXTRAPOLATION_MAX_SLOPE), exponent) };
}
