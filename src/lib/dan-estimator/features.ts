import type { ManiaBeatmap, ManiaNote } from "../beatmap-parser";
import type { DanEstimateInput, DanFeatureExtractionResult } from "./types";
import {
  average,
  bucketEntropy,
  bucketValues,
  countInWindow,
  quantile,
  raoQuadraticEntropyLog,
  strainSpikiness,
} from "./math";

function getRatedNotes(map: ManiaBeatmap, rate: number): ManiaNote[] {
  return map.notes
    .filter((note) => note.column >= 0 && note.column < map.keyCount)
    .map((note) => rate === 1 ? note : {
      ...note,
      time: note.time / rate,
      endTime: note.endTime / rate,
    });
}

function groupNotesByTime(notes: ManiaNote[]): Array<[number, ManiaNote[]]> {
  const rows = new Map<number, ManiaNote[]>();
  for (const note of notes) {
    const row = rows.get(note.time);
    if (row) row.push(note);
    else rows.set(note.time, [note]);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]);
}

export function extractDanFeatures(map: ManiaBeatmap, input: DanEstimateInput, rate: number): DanFeatureExtractionResult {
  const notes = getRatedNotes(map, rate);
  const warnings: string[] = [];
  const noteTimes = notes.map((note) => note.time).sort((a, b) => a - b);
  const durationMs = Math.max(input.totalLength ? (input.totalLength * 1000) / rate : 0, map.totalLength / rate, noteTimes.at(-1) ?? 0);

  if (notes.length < 50 || durationMs <= 0) {
    warnings.push("This map has very little note data, so the estimate is low confidence.");
  }

  const orderedRows = groupNotesByTime(notes);
  const chordRows = orderedRows.filter(([, rowNotes]) => rowNotes.length >= 2).length;
  const holdRatio = notes.length ? notes.filter((note) => note.isHold).length / notes.length : 0;
  const chordRatio = orderedRows.length ? chordRows / orderedRows.length : 0;

  const lastByColumn = Array.from({ length: Math.max(1, map.keyCount) }, () => -Infinity);
  const jackValues: number[] = [];
  const streamValues: number[] = [];
  const rowDensities: number[] = [];
  const rowDensityWeights: number[] = [];
  const rowIntervals: number[] = [];
  const rowRates: number[] = [];
  const columnIntervals: number[] = [];
  const tailIntervals: number[] = [];
  const columnCounts = Array.from({ length: Math.max(1, map.keyCount) }, () => 0);
  const releaseTimes = notes.filter((note) => note.isHold && note.endTime > note.time).map((note) => note.endTime).sort((a, b) => a - b);
  let directionChanges = 0;
  let previousColumn: number | null = null;
  let previousDirection = 0;
  let previousChordSize = 0;
  let chordSizeChanges = 0;
  let previousRowTime: number | null = null;

  for (const [time, rowNotes] of orderedRows) {
    const columns = rowNotes.map((note) => note.column).sort((a, b) => a - b);
    for (const column of columns) {
      columnCounts[column]++;
    }
    if (previousChordSize && previousChordSize !== columns.length) chordSizeChanges++;
    if (previousRowTime != null) {
      const rowDelta = time - previousRowTime;
      if (rowDelta > 0 && rowDelta < 1200) {
        rowIntervals.push(rowDelta);
        rowRates.push(1000 / rowDelta);
        rowDensities.push((columns.length * 1000) / rowDelta);
        rowDensityWeights.push(Math.max(1, rowDelta));
      }
    }
    previousChordSize = columns.length;
    previousRowTime = time;

    for (const column of columns) {
      const sameDelta = time - lastByColumn[column];
      if (sameDelta > 0 && sameDelta < 1000) {
        jackValues.push(Math.min(230, 15000 / sameDelta));
      }
      if (sameDelta > 0 && sameDelta < 1600) {
        columnIntervals.push(sameDelta);
      }

      for (const neighbor of [column - 1, column + 1]) {
        if (neighbor < 0 || neighbor >= map.keyCount) continue;
        const delta = time - lastByColumn[neighbor];
        if (delta > 0 && delta < 260) {
          streamValues.push((260 - delta) / 35);
        }
      }

      if (previousColumn != null) {
        const direction = Math.sign(column - previousColumn);
        if (direction && previousDirection && direction !== previousDirection) directionChanges++;
        if (direction) previousDirection = direction;
      }
      previousColumn = column;
      lastByColumn[column] = time;
    }
  }

  for (let i = 1; i < releaseTimes.length; i++) {
    const tailDelta = releaseTimes[i] - releaseTimes[i - 1];
    if (tailDelta > 0 && tailDelta < 1600) {
      tailIntervals.push(tailDelta);
    }
  }

  const peakNps1s = countInWindow(noteTimes, 1000);
  const peakNps5s = countInWindow(noteTimes, 5000) / 5;
  const sustainedNps10s = countInWindow(noteTimes, 10000) / 10;
  const jackPressure = quantile(jackValues, 0.92);
  const streamPressure = quantile(streamValues, 0.9);
  const burstDensity = quantile(rowDensities, 0.9);
  const rowBurstPressure = quantile(rowRates, 0.9);
  const fastRowRatio = rowIntervals.length
    ? rowIntervals.filter((interval) => interval <= 80).length / rowIntervals.length
    : 0;
  const rowIntervalEntropy = bucketEntropy(rowIntervals, 5);
  const patternVariety = 0.5 * raoQuadraticEntropyLog(bucketValues(rowIntervals, 5), 1)
    + 1.125 * raoQuadraticEntropyLog(bucketValues(columnIntervals, 5), 2)
    + 0.11 * raoQuadraticEntropyLog(bucketValues(tailIntervals, 5), 1);
  const spikiness = strainSpikiness(rowDensities, rowDensityWeights);
  const sustainedPressureRatio = sustainedNps10s / Math.max(1, peakNps1s, peakNps5s);
  const averageColumnCount = average(columnCounts);
  const columnImbalance = averageColumnCount > 0
    ? columnCounts.reduce((sum, count) => sum + Math.abs(count - averageColumnCount), 0) / (columnCounts.length * averageColumnCount)
    : 0;
  const anchorPressure = columnImbalance * (0.5 + Math.min(1.5, jackPressure / 150)) + Math.max(0, quantile(columnIntervals.map((interval) => 1000 / interval), 0.9) - 7) * 0.04;
  const lnReleasePressure = releaseTimes.length
    ? countInWindow(releaseTimes, 5000) / 5 + quantile(tailIntervals.map((interval) => 1000 / interval), 0.9) * 0.15
    : 0;
  const chordSizeChangeRate = orderedRows.length ? chordSizeChanges / orderedRows.length : 0;
  const directionChangeRate = notes.length ? directionChanges / notes.length : 0;
  const chordjackPressure = jackPressure * (0.28 + chordRatio * 1.35) + burstDensity * chordRatio * 0.6;
  const techPressure = orderedRows.length
    ? (directionChanges / orderedRows.length) * 4.4 + (chordSizeChanges / orderedRows.length) * 3.5 + chordRatio * 1.6 + average(rowDensities) * 0.018
    : 0;

  return {
    notes,
    noteTimes,
    durationMs,
    orderedRows,
    warnings,
    metrics: {
      keyCount: map.keyCount,
      noteCount: notes.length,
      holdRatio,
      chordRatio,
      peakNps1s,
      peakNps5s,
      sustainedNps10s,
      jackPressure,
      streamPressure,
      chordjackPressure,
      techPressure,
      rowBurstPressure,
      fastRowRatio,
      rowIntervalEntropy,
      patternVariety,
      strainSpikiness: spikiness,
      sustainedPressureRatio,
      anchorPressure,
      lnReleasePressure,
      chordSizeChangeRate,
      directionChangeRate,
      staminaPressure: sustainedNps10s,
    },
  };
}
