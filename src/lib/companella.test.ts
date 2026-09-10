import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeEtternaFromText } from "#leoblack/ett/index.js";
import { parseManiaBeatmap } from "./beatmap-parser";
import { classifyChartWithCompanella } from "./companella";
import * as leo from "#dan/leoblack-estimator";

const values = { Overall: 20, Stream: 20, Jumpstream: 19, Handstream: 18,
  Stamina: 20, JackSpeed: 19, Chordjack: 18, Technical: 19 };
vi.mock("#leoblack/ett/index.js", () => ({ analyzeEtternaFromText: vi.fn() }));

function chart(span: number, keys = 4): string {
  return ["osu file format v14", "[General]", "Mode:3", "[Difficulty]", `CircleSize:${keys}`,
    "OverallDifficulty:8", "[TimingPoints]", "0,350,4,2,0,100,1,0", "[HitObjects]",
    ...Array.from({ length: 2801 }, (_, i) => `${Math.floor((i % keys + .5) * 512 / keys)},192,${1000 + Math.round(i * span * 1000 / 2800)},1,0,0:0:0:0:`),
  ].join("\n");
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("browser marathon MSD preparation", () => {
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
