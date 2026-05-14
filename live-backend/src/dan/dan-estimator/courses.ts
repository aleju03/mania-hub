import type { ManiaNote } from "../beatmap-parser.js";
import type { DanEstimateInput, DanFeatureMetrics } from "./types.js";

function countDanSegments(orderedRows: Array<[number, ManiaNote[]]>): number {
  if (orderedRows.length === 0) return 0;

  let segments = 0;
  let segmentStart = orderedRows[0][0];
  let segmentNotes = 0;

  for (let index = 0; index < orderedRows.length; index++) {
    const [time, rowNotes] = orderedRows[index];
    segmentNotes += rowNotes.length;
    const next = orderedRows[index + 1];
    if (!next || next[0] - time > 2500) {
      if (time - segmentStart >= 30000 && segmentNotes >= 400) segments++;
      if (next) {
        segmentStart = next[0];
        segmentNotes = 0;
      }
    }
  }

  return segments;
}

export function isDanCourse(input: DanEstimateInput, orderedRows: Array<[number, ManiaNote[]]>, durationMs: number, noteCount: number): boolean {
  const title = input.title?.toLowerCase() ?? "";
  const version = input.version?.toLowerCase() ?? "";
  const combined = `${title} ${version}`;
  if (!/\bdan\b/.test(combined)) return false;

  const segmentCount = countDanSegments(orderedRows);
  return (durationMs >= 180000 && segmentCount >= 3)
    || (durationMs >= 240000 && noteCount >= 6000 && segmentCount >= 3);
}

export function estimateDanCourseSr(metrics: DanFeatureMetrics, starRating: number, fallbackSr: number): number {
  if (starRating <= 0) return Math.max(1, fallbackSr - 0.8);

  const densityPressure = Math.max(0, metrics.sustainedNps10s - 24) * 0.035
    + Math.max(0, metrics.peakNps5s - 28) * 0.025;
  const endurancePressure = Math.min(0.12, metrics.noteCount / 100000);
  const midCourseProgression = starRating >= 4.45
    && starRating <= 5.58
    && metrics.noteCount >= 5500
    && metrics.sustainedNps10s >= 20
    && metrics.sustainedNps10s <= 24.2
    ? 0.18
    : 0;
  const sixthCourseEnduranceStep = starRating >= 4.6
    && starRating <= 4.8
    && metrics.noteCount >= 6000
    && metrics.sustainedNps10s >= 20
    && metrics.sustainedNps10s <= 21.2
    ? 0.3
    : 0;
  const lowIntroProgression = starRating >= 2.2
    && starRating <= 3
    && metrics.noteCount >= 1700
    && metrics.noteCount <= 3200
    && metrics.peakNps5s <= 12
    && metrics.sustainedNps10s <= 11
    ? starRating < 2.6 ? 1.2 : 1.15
    : 0;
  const highCourseDensityStep = metrics.noteCount >= 7000
    && metrics.noteCount <= 7800
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.42
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.55
    && metrics.fastRowRatio <= 0.62
    && metrics.peakNps5s >= 25
    && metrics.peakNps5s <= 26
    && metrics.sustainedNps10s >= 25
    && metrics.patternVariety >= 3.85
    ? 0.15
    : 0;
  const seventhCourseStaminaCompression = metrics.noteCount >= 7800
    && metrics.noteCount <= 8300
    && metrics.chordRatio >= 0.4
    && metrics.chordRatio <= 0.44
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.55
    && metrics.fastRowRatio <= 0.6
    && metrics.peakNps5s >= 24.5
    && metrics.peakNps5s <= 25.2
    && metrics.sustainedNps10s >= 22
    && metrics.sustainedNps10s <= 23
    && metrics.patternVariety >= 3.75
    ? 0.12
    : 0;
  const extraBetaCourseBridge = metrics.noteCount >= 8300
    && metrics.noteCount <= 8900
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.45
    && metrics.holdRatio < 0.02
    && metrics.fastRowRatio >= 0.55
    && metrics.fastRowRatio <= 0.62
    && metrics.peakNps5s >= 28
    && metrics.peakNps5s <= 29
    && metrics.sustainedNps10s >= 27
    && metrics.sustainedNps10s <= 28
    && metrics.patternVariety >= 3.65
    ? 0.2
    : 0;

  return starRating
    + Math.min(0.55, densityPressure + endurancePressure + midCourseProgression + sixthCourseEnduranceStep)
    + lowIntroProgression
    + highCourseDensityStep
    + extraBetaCourseBridge
    - seventhCourseStaminaCompression;
}
