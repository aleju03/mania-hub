import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { classifyChart } from "../src/dan/chart-classifier.js";
import { runLeoBlackMixed, runLeoBlackSunny } from "../src/dan/leoblack-estimator.js";
import { runAzusaEstimatorFromText } from "../vendor/leoblack/estimator/azusaEstimator.js";
import type { CompanellaEstimate } from "../vendor/leoblack/estimator/companellaEstimator.js";

function chart(holds = 0, count = 1000, gap = 115): string {
  return ["osu file format v14", "[General]", "Mode:3", "[Difficulty]",
    "CircleSize:4", "OverallDifficulty:8", "[TimingPoints]", "0,352.94,4,2,0,100,1,0", "[HitObjects]",
    ...Array.from({ length: count }, (_, i) => {
      const start = 1000 + i * gap;
      return i < holds
        ? `${64 + i % 4 * 128},192,${start},128,0,${start + 80}:0:0:0:0:`
        : `${64 + i % 4 * 128},192,${start},1,0,0:0:0:0:`;
    }),
  ].join("\n");
}

function companella(numericDifficulty: number | null): CompanellaEstimate {
  return { estDiff: "Reform 6 mid", numericDifficulty, numericDifficultyHint: null,
    danLabel: "6", variant: "", confidence: 1, rawModelOutput: 5 };
}

describe("September LeoBlack update", () => {
  it("fuses a low-band rice verdict while keeping a usable synchronous fallback", () => {
    const text = chart();
    const map = parseManiaBeatmap(text);
    const mixed = runLeoBlackMixed(text);
    expect(mixed.mixedCompanellaPlan).toMatchObject({ fuseRc: true, onDisagree: "azusa" });
    const fallback = classifyChart(map, text);
    expect(fallback.rc?.rawDan).toBe(mixed.numericDifficulty);
    expect(fallback.companellaPending).toBe(true);
    const refined = classifyChart(map, text, { companella: companella(6) });
    expect(refined.rc?.rawDan).toBeCloseTo((Number(mixed.numericDifficulty) + 6) / 2, 2);
    expect(refined.rc?.source).toBe("leoblack-companella");
    expect(refined.companellaPending).toBe(false);
  });

  it("keeps trivial charts below Intro even when Companella was supplied", () => {
    const text = chart(0, 130, 500);
    const map = parseManiaBeatmap(text);
    const fallback = classifyChart(map, text);
    const refined = classifyChart(map, text, { companella: companella(6) });
    expect(refined.verdictText).toBe("< Intro 1 low");
    expect(refined.rc).toEqual(fallback.rc);
    // No ONNX pass should be requested for a chart already rerouted to Sunny.
    expect(fallback.companellaPending).toBe(false);
    expect(refined.companellaPending).toBe(false);
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])("keeps the fallback for invalid model numeric %s", (numeric) => {
    const text = chart();
    const map = parseManiaBeatmap(text);
    const fallback = classifyChart(map, text);
    const invalid = classifyChart(map, text, { companella: companella(numeric) });
    expect(invalid.rc).toEqual(fallback.rc);
    expect(invalid.companellaPending).toBe(true);
  });

  it("enforces Azusa's 18% hold limit without rejecting its boundary", () => {
    expect(runAzusaEstimatorFromText(chart(180)).numericDifficultyHint).not.toBe("UnsupportedLN");
    const rejected = runAzusaEstimatorFromText(chart(181));
    expect(rejected.numericDifficultyHint).toBe("UnsupportedLN");
    expect(rejected.numericDifficulty).toBeNull();
    // LN-heavy charts retain the original pure Companella plan for their RC half.
    const hybrid = runLeoBlackMixed(chart(500));
    expect(hybrid.mixedCompanellaPlan).not.toBeNull();
    expect(hybrid.mixedCompanellaPlan?.fuseRc).toBeUndefined();
  });

  it("falls back to chart OD for invalid Sunny overrides", () => {
    const text = chart();
    const normal = runLeoBlackSunny(text);
    for (const odFlag of ["none", "invalid", Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = runLeoBlackSunny(text, { odFlag });
      expect(result.star).toBe(normal.star);
      expect(result.estDiff).toBe(normal.estDiff);
    }
  });
});
