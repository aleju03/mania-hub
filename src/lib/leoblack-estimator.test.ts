import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "./beatmap-parser";
import { analyzeLeoBlackPatterns, estimateLeoBlackDan, runLeoBlackMixed } from "#dan/leoblack-estimator";

const NORMAL_LABELS = new Set([
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
]);
const VARIANTS = new Set([null, "--", "-", "+", "++"]);

function buildOsu({ keyCount = 4, hitObjects }: { keyCount?: number; hitObjects: string[] }): string {
  return [
    "osu file format v14",
    "",
    "[General]",
    "Mode: 3",
    "",
    "[Metadata]",
    "Title:Synthetic",
    "Artist:Test",
    "Creator:Test",
    "Version:Test",
    "",
    "[Difficulty]",
    `CircleSize:${keyCount}`,
    "OverallDifficulty:8",
    "HPDrainRate:8",
    "",
    "[TimingPoints]",
    "0,300,4,2,0,100,1,0",
    "",
    "[HitObjects]",
    ...hitObjects,
  ].join("\n");
}

function columnX(column: number, keyCount: number): number {
  return Math.floor(((column + 0.5) * 512) / keyCount);
}

function buildStreamChart(): string {
  // Dense 4K jumpstream-ish chart: 16ths at 200bpm (75ms) with a two-note chord
  // every fourth row and a varied column walk so clusters survive pruning.
  const rows: string[] = [];
  const walk = [0, 2, 1, 3, 2, 0, 3, 1, 0, 3, 1, 2];
  for (let i = 0; i < 2800; i++) {
    const time = i * 75;
    const column = walk[i % walk.length];
    rows.push(`${columnX(column, 4)},192,${time},1,0,0:0:0:0`);
    if (i % 4 === 0) {
      rows.push(`${columnX((column + 2) % 4, 4)},192,${time},1,0,0:0:0:0`);
    }
  }
  return buildOsu({ hitObjects: rows });
}

function buildLnChart(): string {
  // LN-dominant 4K chart: 300ms holds cycling columns every 90ms, so each column
  // is free again before its next head (no stacked LNs).
  const rows: string[] = [];
  for (let i = 0; i < 2400; i++) {
    const start = i * 90;
    rows.push(`${columnX(i % 4, 4)},192,${start},128,0,${start + 300}:0:0:0:0:`);
  }
  return buildOsu({ hitObjects: rows });
}

describe("estimateLeoBlackDan", () => {
  it("classifies a dense rice chart into the normal label vocabulary", () => {
    const text = buildStreamChart();
    const map = parseManiaBeatmap(text);
    const estimate = estimateLeoBlackDan(map, text, {});

    expect(NORMAL_LABELS.has(estimate.label)).toBe(true);
    expect(VARIANTS.has(estimate.variant)).toBe(true);
    expect(estimate.displayName).toBe(`${estimate.label}${estimate.variant ?? ""}`);
    expect(estimate.family).toBe("dan");
    expect(Number.isFinite(estimate.rawDan)).toBe(true);
    expect(Number.isFinite(estimate.estimatedSr)).toBe(true);
    expect(estimate.metrics.keyCount).toBe(4);
  });

  it("reports the LN half for LN-dominant charts", () => {
    const text = buildLnChart();
    const map = parseManiaBeatmap(text);
    const estimate = estimateLeoBlackDan(map, text, {});

    expect(estimate.family).toBe("ln");
    expect(/^\d+$/.test(estimate.label)).toBe(true);
    expect(VARIANTS.has(estimate.variant)).toBe(true);
  });

  it("honors preferFamily overrides", () => {
    const text = buildLnChart();
    const map = parseManiaBeatmap(text);
    const rc = estimateLeoBlackDan(map, text, { preferFamily: "rc" });
    const ln = estimateLeoBlackDan(map, text, { preferFamily: "ln" });

    expect(rc.family).toBe("dan");
    expect(ln.family).toBe("ln");
  });

  it("rejects non-4K charts", () => {
    const rows = Array.from({ length: 600 }, (_, i) => `${columnX(i % 7, 7)},192,${i * 75},1,0,0:0:0:0`);
    const text = buildOsu({ keyCount: 7, hitObjects: rows });
    const map = parseManiaBeatmap(text);

    expect(() => estimateLeoBlackDan(map, text, {})).toThrow(/4K/);
    // The raw Mixed verdict still works for 6K/7K.
    const mixed = runLeoBlackMixed(text);
    expect(mixed.columnCount).toBe(7);
    expect(mixed.estDiff.length).toBeGreaterThan(0);
  });
});

describe("analyzeLeoBlackPatterns", () => {
  it("tags rice charts as RC with a category", () => {
    const { report } = analyzeLeoBlackPatterns(buildStreamChart());

    expect(report.ModeTag).toBe("RC");
    expect(typeof report.Category).toBe("string");
    expect(report.Duration).toBeGreaterThan(0);
  });

  it("returns BPM-localized clusters for LN charts", () => {
    const { report, topFiveClusters } = analyzeLeoBlackPatterns(buildLnChart());

    expect(report.ModeTag).toBe("LN");
    expect(topFiveClusters.length).toBeGreaterThan(0);
    expect(topFiveClusters[0].BPM).toBeGreaterThan(0);
    expect(topFiveClusters[0].Amount).toBeGreaterThan(0);
  });
});
