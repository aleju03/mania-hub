import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeEtternaFromText } from "#leoblack/ett/index.js";
import { parseManiaBeatmap } from "./beatmap-parser";
import { classifyChartWithCompanella } from "./companella";
import * as leo from "#dan/leoblack-estimator";
import { classifyCompanellaDifficulty } from "#leoblack/estimator/companellaEstimator.js";
import * as patterns from "#leoblack/patterns/service.js";

const values = { Overall: 20, Stream: 20, Jumpstream: 19, Handstream: 18,
  Stamina: 20, JackSpeed: 19, Chordjack: 18, Technical: 19 };
vi.mock("#leoblack/ett/index.js", () => ({ analyzeEtternaFromText: vi.fn() }));
vi.mock("#leoblack/estimator/companellaEstimator.js", () => ({ classifyCompanellaDifficulty: vi.fn() }));

function chart(span: number, keys = 4): string {
  return ["osu file format v14", "[General]", "Mode:3", "[Difficulty]", `CircleSize:${keys}`,
    "OverallDifficulty:8", "[TimingPoints]", "0,350,4,2,0,100,1,0", "[HitObjects]",
    ...Array.from({ length: 2801 }, (_, i) => `${Math.floor((i % keys + .5) * 512 / keys)},192,${1000 + Math.round(i * span * 1000 / 2800)},1,0,0:0:0:0:`),
  ].join("\n");
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("browser marathon MSD preparation", () => {
  it("keeps both rate-floor readings while building patterns only once", async () => {
    vi.mocked(analyzeEtternaFromText).mockResolvedValue({ keycount: 4, lnRatio: 0, metadata: {}, values });
    vi.mocked(classifyCompanellaDifficulty).mockResolvedValue({ estDiff: "Reform 6 mid", numericDifficulty: 6,
      numericDifficultyHint: null, danLabel: "6", variant: "", confidence: 1, rawModelOutput: 6 });
    const text = chart(115);
    const map = parseManiaBeatmap(text);
    const unfloored = await Promise.all([0.75, 0.7, 0.65].map(rate =>
      classifyChartWithCompanella(map, text, { rate }, { rateFloor: false })));
    const clustering = vi.spyOn(patterns, "analyzePatternFromText");
    vi.mocked(analyzeEtternaFromText).mockClear();
    const floored = await classifyChartWithCompanella(map, text, { rate: 0.75 });
    expect(floored.rc?.rawDan).toBe(Math.max(...unfloored.map(result => result.rc!.rawDan)));
    expect(clustering).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeEtternaFromText).mock.calls.map(([, options]) => options?.musicRate))
      .toEqual([0.75, 0.7, 0.65]);
  });

  it("uses Sunny SR and a separate 0.74.0 pass even when native MSD is supplied", async () => {
    const text = chart(115);
    const modelValues = { ...values, Overall: 17, Stream: 16 };
    vi.mocked(analyzeEtternaFromText).mockResolvedValue({ keycount: 4, lnRatio: 0, metadata: {}, values: modelValues });
    vi.mocked(classifyCompanellaDifficulty).mockResolvedValue({ estDiff: "Reform 6 mid", numericDifficulty: 6,
      numericDifficultyHint: null, danLabel: "6", variant: "", confidence: 1, rawModelOutput: 6 });
    await classifyChartWithCompanella(parseManiaBeatmap(text), text, { rate: 0.75 }, { msdValues: values });
    // Other calls belong to the slower rates the Companella rate floor reads.
    expect(vi.mocked(analyzeEtternaFromText).mock.calls.filter(([, options]) => options?.musicRate === 0.75))
      .toEqual([[text, { musicRate: 0.75, keyOverride: 4, etternaVersion: "0.74.0" }]]);
    expect(classifyCompanellaDifficulty).toHaveBeenCalledWith(expect.objectContaining({
      msdValues: modelValues, sunnyStar: leo.runLeoBlackSunny(text, { speedRate: 0.75 }).star,
    }));
  });

  it("loads rate-specific raw MSD before Mixed even when Companella is skipped", async () => {
    vi.mocked(analyzeEtternaFromText).mockResolvedValue({ keycount: 4, lnRatio: 0, metadata: {}, values });
    const mixed = vi.spyOn(leo, "runLeoBlackMixed");
    const text = chart(420);
    await classifyChartWithCompanella(parseManiaBeatmap(text), text, { rate: 1.5 }, { skipCompanella: true });
    expect(analyzeEtternaFromText).toHaveBeenCalledExactlyOnceWith(text, { musicRate: 1.5, keyOverride: 4 });
    expect(mixed).toHaveBeenLastCalledWith(text, { speedRate: 1.5, marathonCorrection: { durationS: 420, ettValues: values } });
  });

  it("reuses supplied MSD and skips acquisition for short and non-4K charts", async () => {
    for (const [span, keys] of [[300, 4], [420, 7], [420, 4]]) {
      const text = chart(span, keys);
      await classifyChartWithCompanella(parseManiaBeatmap(text), text, {}, {
        skipCompanella: true, ...(span === 420 && keys === 4 ? { msdValues: values } : {}),
      });
    }
    expect(analyzeEtternaFromText).not.toHaveBeenCalled();
  });
});
