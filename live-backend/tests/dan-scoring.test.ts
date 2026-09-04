import { describe, expect, it } from "vitest";
import { parseDan, srToRawDan } from "../src/dan/dan-estimator/labels.js";
import { estimateFamilyScores } from "../src/dan/dan-estimator/scoring.js";
import type { DanFeatureMetrics } from "../src/dan/dan-estimator/types.js";

const vertexBetaMidChordProfile: DanFeatureMetrics = {
  keyCount: 4,
  noteCount: 2438,
  durationMs: 252200,
  holdRatio: 0.0094,
  chordRatio: 0.6269,
  twoNoteChordRatio: 0.21,
  peakNps1s: 38,
  peakNps5s: 26.8,
  nps5sP50: 5.2,
  nps5sP90: 23.6,
  nps5sP95: 24.4,
  sustainedNps10s: 25.4,
  sustainedNps30s: 24.1,
  sustainedNps60s: 22.7,
  activeNps: 12.4,
  longGapRatio: 0.02,
  longGapCount: 3,
  jackPressure: 140.187,
  streamPressure: 4.367,
  jumpstreamPressure: 18,
  chordjackPressure: 171.727,
  chordColumnOverlapRatio: 0.52,
  adjacentColumnRehitShare: 0.24,
  twoBackColumnRehitShare: 0.38,
  twoBackColumnRehitExcess: 0.14,
  techPressure: 9.012,
  rowBurstPressure: 12.5,
  fastRowRatio: 0.17,
  rowIntervalEntropy: 1.812,
  offGridRowShare: 0,
  patternVariety: 2.443,
  rowPatternEntropy: 1.812,
  rowPatternVariety: 2.443,
  repeatedRowPatternRatio: 0.24,
  alternatingRowPatternRatio: 0.18,
  rowPatternChangeRate: 0.548,
  rowMotifRepeatRatio: 0.21,
  rhythmMotifRepeatRatio: 0.16,
  adjacentMotifRepeatRatio: 0.14,
  strainSpikiness: 1.786,
  sustainedPressureRatio: 0.668,
  anchorPressure: 0.111,
  lnReleasePressure: 1.175,
  lnDensity: 0.0091,
  lnOverlapPressure: 0.737,
  lnChordPressure: 1,
  lnHoldDurationAvg: 400.3,
  lnHoldDurationP90: 214.3,
  chordSizeChangeRate: 0.548,
  directionChangeRate: 0.669,
  staminaPressure: 25.4,
};

function jackRawDan(metrics: DanFeatureMetrics, starRating: number, durationMs: number): number {
  const score = estimateFamilyScores(metrics, starRating, durationMs).skillScores.jack;
  return srToRawDan(score, "jack");
}

describe("dan family scoring", () => {
  it("keeps low-rate mid-chord jack pressure below the faster variant", () => {
    const fasterProfile: DanFeatureMetrics = {
      ...vertexBetaMidChordProfile,
      peakNps1s: 42,
      peakNps5s: 28.8,
      nps5sP50: 5.6,
      nps5sP90: 25.6,
      nps5sP95: 26,
      sustainedNps10s: 27.2,
      jackPressure: 150,
      streamPressure: 4.571,
      chordjackPressure: 183.993,
      techPressure: 9.037,
      rowBurstPressure: 13.514,
      fastRowRatio: 0.192,
      patternVariety: 2.584,
      sustainedPressureRatio: 0.648,
      anchorPressure: 0.138,
      lnReleasePressure: 1.388,
      lnHoldDurationAvg: 373.6,
      lnHoldDurationP90: 200,
      staminaPressure: 27.2,
    };

    const slowerRaw = jackRawDan(vertexBetaMidChordProfile, 6.29, 252200);
    const fasterRaw = jackRawDan(fasterProfile, 6.63, 235300);

    expect(parseDan(slowerRaw).displayName).toBe("beta--");
    expect(parseDan(fasterRaw).label).toBe("beta");
    expect(fasterRaw).toBeGreaterThan(slowerRaw);
  });
});
