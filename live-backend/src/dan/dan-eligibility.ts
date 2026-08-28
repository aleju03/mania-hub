import type { ManiaBeatmap } from "./beatmap-parser.js";

// More than one object on the same column at the same instant still asks for
// one physical key action. A tiny overlap can be an ordinary mapper mistake,
// but a large pile is a known star-rating exploit: the difficulty calculator
// counts stored objects that gameplay effectively collapses. Eight keeps the
// integrity gate far above an accidental double while catching the abusive
// piles (the motivating charts carry 190, 1,000 and 1,248 heads).
export const DAN_INELIGIBLE_STACKED_HEAD_MIN = 8;

export interface ChartDanEligibility {
  eligible: boolean;
  reason: "stacked_same_column_heads" | null;
  maxSameColumnHeadStack: number;
  redundantSameColumnHeads: number;
}

/**
 * Structural player-dan eligibility, deliberately blind to every chart
 * identity and metadata field. The analyzer may still display its ordinary
 * dan verdict; this only says whether a play on the chart is trustworthy as
 * evidence about a player's dan.
 */
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
