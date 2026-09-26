// A player's LN SSR for one play: the LN rating solved at the play's own
// release-aware accuracy instead of the chart goal. Like the press SSR from
// MinaCalc, the solver never runs above a 0.965 goal; higher accuracy
// extrapolates the slope between 0.93 and 0.965.

import { analyzeLnSkillFromText, type LnSkillResult } from "./skill";

/** Highest goal either SSR solver (native and LN) runs at. */
export const SSR_CALC_GOAL_CAP = 0.965;
/** Lower end of the slope used to extrapolate above the cap. */
export const SSR_EXTRAPOLATION_BASE_GOAL = 0.93;
/** Bound on the 0.93-to-0.965 rating ratio used as the extrapolation base (measured around 1.07-1.11). */
export const SSR_EXTRAPOLATION_MAX_SLOPE = 1.2;

/** The goal the LN solver runs at for a play's accuracy. */
export function lnSsrSolverGoal(goal: number): number {
  return Math.min(SSR_CALC_GOAL_CAP, Math.max(0, Math.min(0.999, goal)));
}

/**
 * LN SSR for a play. Solved directly, the LN response runs away toward 100%:
 * a perfect play on a chart rated 24.8 solved to 38.7, above the hardest 4K
 * LN course. So above the cap the result is
 *   ssr(cap) * min(ssr(cap) / ssr(0.93), 1.2) ^ ((goal - 0.965) / (0.965 - 0.93)),
 * the same way the press axis prices high accuracy. The returned scoreGoal
 * is the solver goal, not the play's accuracy.
 */
export function analyzeLnSsr(
  osuText: string,
  options: { rate: number; od?: number | null; scoreGoal: number },
): LnSkillResult | null {
  const goal = Math.max(0, Math.min(0.999, options.scoreGoal));
  const solverGoal = lnSsrSolverGoal(goal);
  const capped = analyzeLnSkillFromText(osuText, { rate: options.rate, od: options.od, scoreGoal: solverGoal });
  if (!capped || goal <= SSR_CALC_GOAL_CAP || !(capped.rating != null && capped.rating > 0)) return capped;
  const base = analyzeLnSkillFromText(osuText, { rate: options.rate, od: options.od, scoreGoal: SSR_EXTRAPOLATION_BASE_GOAL });
  const atCap = capped.rating, atBase = base?.rating ?? 0;
  if (!(atBase > 0) || atCap <= atBase) return capped;
  const exponent = (goal - SSR_CALC_GOAL_CAP) / (SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL);
  return { ...capped, rating: atCap * Math.pow(Math.min(atCap / atBase, SSR_EXTRAPOLATION_MAX_SLOPE), exponent) };
}
