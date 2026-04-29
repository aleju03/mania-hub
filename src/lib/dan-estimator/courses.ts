import type { ManiaNote } from "../beatmap-parser";
import type { DanEstimateInput, DanFeatureMetrics } from "./types";

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
  return starRating + Math.min(0.55, densityPressure + endurancePressure);
}
