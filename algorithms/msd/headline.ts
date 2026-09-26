// The single number a chart's MSD box shows. Display only: stored Overall
// and every player rating keep MinaCalc's native Overall.
import { isLnSkillSupported } from "../ln/skill";

/**
 * The number a chart's MSD box headlines.
 *
 * MinaCalc's Overall rates presses only: an LN head counts as a tap and a
 * tail never reaches the calc, so on a 4K LN chart Overall is the rice left
 * once the holds are cut off. The LN model was fitted to native Overall on
 * the 4K LN dan courses, so it sits on the same scale; when it is the chart's
 * hardest axis it takes the headline, as Overall would if LN were a native
 * skillset. A rice chart past the hold line also carries an LN number, but
 * only a chart that reads as LN can put it in the headline.
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
