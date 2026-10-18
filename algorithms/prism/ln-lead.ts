import { PRISM_KEY_COUNTS } from "./switch";

export const PRISM_LN_LEAD_SHARE = 0.85;

export function prismSkillsetsAt(values: Record<string, number>, target: number): Record<string, number> {
  let top = 0;
  for (const [name, value] of Object.entries(values)) if (name !== "Overall" && name !== "LN" && value > top) top = value;
  if (!(top > 0) || !(target > 0)) return values;
  const scale = target / top;
  const scaled: Record<string, number> = {};
  for (const [name, value] of Object.entries(values)) scaled[name] = name === "Overall" || name === "LN" ? value : value * scale;
  return scaled;
}

export const PRISM_LN_LEAD_FROM_HOLDS = 0.375;
export const PRISM_LN_LEAD_FULL_HOLDS = 0.9;

export function prismLnLeadWeight(holdRatio: number): number {
  const weight = (holdRatio - PRISM_LN_LEAD_FROM_HOLDS) / (PRISM_LN_LEAD_FULL_HOLDS - PRISM_LN_LEAD_FROM_HOLDS);
  return weight > 0 ? Math.min(1, weight) : 0;
}

export function prismLnLeadValues(keyCount: number, values: Record<string, number>, ln: number, holdRatio: number): Record<string, number> {
  if (!PRISM_KEY_COUNTS.has(keyCount) || !(ln > 0)) return values;
  const weight = prismLnLeadWeight(holdRatio);
  if (weight <= 0) return values;
  const lead = ln * PRISM_LN_LEAD_SHARE;
  return prismSkillsetsAt(values, weight >= 1 ? lead : (1 - weight) * Number(values.Overall) + weight * lead);
}
