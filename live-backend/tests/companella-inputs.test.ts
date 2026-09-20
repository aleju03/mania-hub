import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { classifyChartWithCompanella } from "../src/dan/companella.js";
import { runMixedEstimatorFromText, applyCompanellaToMixedResult } from "../vendor/leoblack/estimator/mixedEstimator.js";
import { classifyCompanellaDifficulty } from "../vendor/leoblack/estimator/companellaEstimator.js";
import { runAnalysisPipeline } from "../vendor/leoblack/pipeline/runAnalysisPipeline.js";

function chart(holdShare: number): string {
  return ["osu file format v14", "[General]", "Mode:3", "[Difficulty]",
    "CircleSize:4", "OverallDifficulty:8", "[TimingPoints]", "0,352.94,4,2,0,100,1,0", "[HitObjects]",
    ...Array.from({ length: 1000 }, (_, i) => {
      const start = 1000 + i * 115;
      return i < 1000 * holdShare
        ? `${64 + i % 4 * 128},192,${start},128,0,${start + 160}:0:0:0:0:`
        : `${64 + i % 4 * 128},192,${start},1,0,0:0:0:0:`;
    }),
  ].join("\n");
}

describe("Companella upstream input parity", () => {
  it.each([
    { holdShare: 0, rate: 1, odFlag: undefined },
    { holdShare: 0, rate: 0.75, odFlag: 9 },
    { holdShare: 0.35, rate: 1.25, odFlag: undefined },
  ])("matches the full upstream pipeline with real WASM and ONNX: %j", async ({ holdShare, rate, odFlag }) => {
    const text = chart(holdShare);
    const pipeline = await runAnalysisPipeline({ rawText: text, estimatorAlgorithm: "Mixed", options: {
      speedRate: rate, odFlag, etternaVersion: "0.72.3", companellaEtternaVersion: "0.74.0",
      withEtterna: true, withInterlude: true,
    } });
    expect(pipeline.ettError).toBeNull();
    expect(pipeline.companellaEttError).toBeNull();
    expect(pipeline.interludeError).toBeNull();
    if (!pipeline.ettResult || !pipeline.companellaEttResult) throw new Error("Missing upstream MSD inputs");
    expect(pipeline.ettResult.etternaVersion).toBe("0.72.3");
    expect(pipeline.companellaEttResult.etternaVersion).toBe("0.74.0");
    expect(pipeline.rework.mixedCompanellaPlan).not.toBeNull();
    const model = await classifyCompanellaDifficulty({
      msdValues: pipeline.companellaEttResult.values,
      interludeStar: pipeline.interludeStar, sunnyStar: pipeline.rework.star,
    });
    const upstream = applyCompanellaToMixedResult(pipeline.rework, model);
    const actual = await classifyChartWithCompanella(parseManiaBeatmap(text), text,
      { rate, odFlag }, { msdValues: pipeline.ettResult.values });
    expect(actual.companellaPending).toBe(false);
    expect(actual.verdictText).toBe(upstream.estDiff);
    expect(actual.sunnySr).toBe(upstream.star);
    expect(actual.rc?.rawDan).toBe(upstream.numericDifficulty);
    if (holdShare === 0) {
      expect(runMixedEstimatorFromText(text, { speedRate: rate, odFlag }).star).not.toBe(upstream.star);
    }
  }, 30_000);
});
