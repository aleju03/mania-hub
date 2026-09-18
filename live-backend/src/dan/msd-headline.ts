import { isLnSkillSupported } from "./ln-skill.js";

/**
 * The number a chart's MSD box headlines.
 *
 * MinaCalc's Overall rates presses only: an LN head counts as a tap and a
 * tail never reaches the calc, so on a 4K LN chart Overall is the rice left
 * once the holds are cut off. The independent LN model's value was fitted to
 * native Overall on the 4K LN courses, so it sits on the same range; when it
 * is the chart's hardest axis it takes the headline, as Overall would if LN
 * were a native skillset. A rice chart past the hold line carries an LN
 * number too, but only an LN identity can put it in the headline.
 *
 * Display only. The stored msd_overall column and every player rating keep
 * the native Overall.
 */
export function msdHeadline(
  values: Record<string, number>,
  keyCount: number,
  lnIdentity: boolean,
): number {
  const overall = Number(values.Overall ?? 0);
  const ln = lnIdentity && isLnSkillSupported(keyCount) ? Number(values.LN ?? 0) : 0;
  return Math.max(overall, ln);
}
