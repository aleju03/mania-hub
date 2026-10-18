import { isLnSkillSupported } from "../ln/skill";

export function msdHeadline(
  values: Record<string, number>,
  keyCount: number,
  lnIdentity: boolean,
): number {
  const overall = Number(values.Overall ?? 0);
  const ln = lnIdentity && isLnSkillSupported(keyCount) ? Number(values.LN ?? 0) : 0;
  return Math.max(overall, ln);
}
