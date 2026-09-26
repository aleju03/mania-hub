// Whether a play on a chart may count as evidence of a player's dan.
// This reads the notes only, never chart identity or metadata. A chart that
// fails the gate still shows its ordinary dan verdict; clears on it are just
// not credited to the player.
import type { ManiaBeatmap } from "../chart/beatmap";

// Several objects on one column at the same instant still ask for one key
// press. A small overlap is an ordinary mapping mistake, but a large pile
// inflates star rating: the difficulty calculator counts every stored object
// while gameplay collapses them. Eight sits far above an accidental double and
// still catches the abusive piles, which carry 190, 1,000 and 1,248 stacked
// heads in the cases that motivated the gate.
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
