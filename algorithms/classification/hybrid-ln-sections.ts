import { parseManiaBeatmap } from "../chart/beatmap";
import { classifyChartLnTableHalf } from "./chart-classifier";
import { LN_PRIMARY_MIN_RATIO } from "../dan-estimator/ln";

export const HYBRID_LN_SECTIONS_VERSION = 1;

const WINDOW_MS = 10_000;

const WINDOW_MIN_NOTES = 8;

const MIN_SECTION_NOTES = 100;

export interface HybridLnSectionsReading {
  version: number;
  rawDan: number;
  label: string;
  noteShare: number;
}

export function cutHybridLnSections(osuText: string): { osuText: string; keptNotes: number; totalNotes: number } | null {
  const lines = osuText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[HitObjects]");
  if (start < 0) return null;
  const objects = lines.slice(start + 1).filter((line) => line.trim()).map((line) => {
    const parts = line.split(",");
    return { line, time: Number(parts[2]), hold: (Number(parts[3]) & 128) !== 0 };
  }).filter((object) => Number.isFinite(object.time));
  if (objects.length === 0) return null;
  const first = objects.reduce((min, object) => Math.min(min, object.time), Infinity);
  const windowOf = (time: number) => Math.floor((time - first) / WINDOW_MS);
  const windows = new Map<number, { notes: number; holds: number }>();
  for (const object of objects) {
    const window = windows.get(windowOf(object.time)) ?? { notes: 0, holds: 0 };
    window.notes += 1;
    if (object.hold) window.holds += 1;
    windows.set(windowOf(object.time), window);
  }
  const kept = objects.filter((object) => {
    const window = windows.get(windowOf(object.time))!;
    return window.notes >= WINDOW_MIN_NOTES && window.holds / window.notes >= LN_PRIMARY_MIN_RATIO;
  });
  return {
    osuText: [...lines.slice(0, start + 1), ...kept.map((object) => object.line)].join("\n"),
    keptNotes: kept.length,
    totalNotes: objects.length,
  };
}

export function rateHybridLnSections(osuText: string): HybridLnSectionsReading | null {
  const cut = cutHybridLnSections(osuText);
  if (!cut || cut.keptNotes < MIN_SECTION_NOTES) return null;
  const half = classifyChartLnTableHalf(parseManiaBeatmap(cut.osuText), cut.osuText);
  if (!half) return null;
  return {
    version: HYBRID_LN_SECTIONS_VERSION,
    rawDan: half.rawDan,
    label: half.displayName,
    noteShare: Math.round((cut.keptNotes / cut.totalNotes) * 10_000) / 10_000,
  };
}
