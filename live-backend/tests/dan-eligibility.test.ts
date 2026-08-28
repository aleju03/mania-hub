import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import {
  DAN_INELIGIBLE_STACKED_HEAD_MIN,
  inspectChartDanEligibility,
} from "../src/dan/dan-eligibility.js";

function stackedChart(stackSize: number): string {
  const stack = Array.from(
    { length: stackSize },
    () => "36,192,15,128,0,47:0:0:0:0:",
  ).join("\n");
  return `osu file format v14

[General]
Mode: 3

[Metadata]
Title: Structural eligibility test
Artist: Test
Creator: Test
Version: 7K

[Difficulty]
CircleSize:7
OverallDifficulty:8

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${stack}
475,192,1000,1,0,0:0:0:0:
`;
}

describe("chart dan eligibility", () => {
  it("rejects exploit-sized same-column head stacks without consulting chart identity", () => {
    const verdict = inspectChartDanEligibility(parseManiaBeatmap(stackedChart(DAN_INELIGIBLE_STACKED_HEAD_MIN)));
    expect(verdict).toEqual({
      eligible: false,
      reason: "stacked_same_column_heads",
      maxSameColumnHeadStack: DAN_INELIGIBLE_STACKED_HEAD_MIN,
      redundantSameColumnHeads: DAN_INELIGIBLE_STACKED_HEAD_MIN - 1,
    });
  });

  it("does not turn a smaller mapper mistake into a whole-chart exclusion", () => {
    const stackSize = DAN_INELIGIBLE_STACKED_HEAD_MIN - 1;
    const verdict = inspectChartDanEligibility(parseManiaBeatmap(stackedChart(stackSize)));
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.maxSameColumnHeadStack).toBe(stackSize);
  });
});
