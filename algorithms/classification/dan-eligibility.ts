import type { ManiaBeatmap } from "../chart/beatmap";

export const DAN_INELIGIBLE_STACKED_HEAD_MIN = 8;

export interface ChartDanEligibility {
  eligible: boolean;
  reason: "stacked_same_column_heads" | null;
  maxSameColumnHeadStack: number;
  redundantSameColumnHeads: number;
}

export function inspectChartDanEligibility(map: ManiaBeatmap): ChartDanEligibility {
  const heads = new Map<string, number>();
  for (const note of map.notes) {
    const key = `${note.column}:${note.time}`;
    heads.set(key, (heads.get(key) ?? 0) + 1);
  }

  let maxSameColumnHeadStack = 0;
  let redundantSameColumnHeads = 0;
  for (const count of heads.values()) {
    maxSameColumnHeadStack = Math.max(maxSameColumnHeadStack, count);
    redundantSameColumnHeads += Math.max(0, count - 1);
  }

  const eligible = maxSameColumnHeadStack < DAN_INELIGIBLE_STACKED_HEAD_MIN;
  return {
    eligible,
    reason: eligible ? null : "stacked_same_column_heads",
    maxSameColumnHeadStack,
    redundantSameColumnHeads,
  };
}
