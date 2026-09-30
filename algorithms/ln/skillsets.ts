import type { ManiaBeatmap } from "../chart/beatmap";
import { lnSkillsetsOfWorkload } from "./skill";
import { buildLnWorkload, type LnFamilyVector } from "./workload";

export { LN_SKILLSET_IDS, type LnSkillsetId } from "./workload";
export interface LnSkillsets {
  scores: LnFamilyVector;
  /** Objects in consecutive rice phrases, excluding taps threaded through LN. */
  riceShare: number;
}

export function analyzeLnSkillsets(
  map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">,
  options: { rate?: number; od?: number | null } = {},
): LnSkillsets | null {
  const workload = buildLnWorkload(map, options);
  if (!workload || !workload.timeline.valid) return null;
  return { scores: lnSkillsetsOfWorkload(map, workload), riceShare: workload.riceShare };
}
