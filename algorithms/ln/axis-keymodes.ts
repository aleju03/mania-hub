import { PRISM_ENABLED } from "../msd/prism";

export const LN_AXIS_KEY_COUNTS: ReadonlySet<number> = new Set(PRISM_ENABLED ? [4, 6, 7, 8] : [4]);

export function hasLnAxis(keyCount: number | null | undefined): boolean {
  return keyCount != null && LN_AXIS_KEY_COUNTS.has(keyCount);
}
