import { describe, expect, it } from "vitest";
import { fitReplayComposition, replayExportDimensions, replayExportViewport } from "./composition";
import { REPLAY_EXPORT_PRESETS } from "./limits";

describe("standard export dimensions", () => {
  it.each([
    { width: 2040, height: 930 },
    { width: 2040, height: 929 },
    { width: 1920, height: 1080 },
    { width: 1440, height: 1080 },
    { width: 390, height: 650 },
    { width: 3440, height: 1440 },
    { width: 5120, height: 1440 },
    { width: 1373.5, height: 731.25 },
  ])("exports a $width × $height viewer at the exact selected resolution, without padding", (source) => {
    const viewport = { ...source, fullscreen: false, fullHeight: false, coarsePointer: false };
    for (const preset of Object.values(REPLAY_EXPORT_PRESETS)) {
      const output = replayExportDimensions(viewport, preset);
      expect(output).toEqual({ width: preset.width, height: preset.height });
      const composition = replayExportViewport(viewport, output);
      expect(composition.width).toBe(source.width);
      expect(composition.width / composition.height).toBeCloseTo(16 / 9);
      expect(fitReplayComposition(composition, output)).toMatchObject({
        x: 0, y: 0, width: output.width, height: output.height,
      });
      expect(viewport).toMatchObject(source);
    }
  });

  it("keeps layout flags when choosing the export viewport", () => {
    const viewport = { width: 390, height: 650, fullscreen: false, fullHeight: true, coarsePointer: true };
    expect(replayExportViewport(viewport, { width: 1920, height: 1080 })).toMatchObject({
      width: 390, height: 390 * 9 / 16, fullscreen: true, fullHeight: true, coarsePointer: true,
    });
  });

  it("still fits legacy captured compositions without cropping", () => {
    const fit = fitReplayComposition({ width: 2040, height: 930 }, { width: 1920, height: 1080 });
    expect(fit.x).toBe(0);
    expect(fit.y).toBeGreaterThan(0);
    expect(fit.y * 2 + fit.height).toBeCloseTo(1080);
  });
});
