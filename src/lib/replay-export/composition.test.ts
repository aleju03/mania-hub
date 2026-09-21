import { describe, expect, it } from "vitest";
import { fitReplayComposition, replayExportDimensions } from "./composition";
import { REPLAY_EXPORT_PRESETS } from "./limits";

describe("export aspect ratio", () => {
  it.each([
    { width: 2040, height: 930 },
    { width: 2040, height: 929 },
    { width: 1920, height: 1080 },
    { width: 1440, height: 1080 },
    { width: 390, height: 650 },
    { width: 3440, height: 1440 },
    { width: 5120, height: 1440 },
    { width: 1373.5, height: 731.25 },
  ])("encodes the complete $width × $height stage without padding in every preset", (viewport) => {
    for (const preset of Object.values(REPLAY_EXPORT_PRESETS)) {
      const output = replayExportDimensions(viewport, preset);
      expect(output.width % 2).toBe(0);
      expect(output.height % 2).toBe(0);
      expect(output.height).toBe(preset.height);
      const originalAspect = viewport.width / viewport.height;
      const roundingError = Math.min(
        Math.abs(output.width / originalAspect - output.height),
        Math.abs(output.height * originalAspect - output.width),
      );
      expect(roundingError).toBeLessThanOrEqual(1);
      expect(fitReplayComposition(viewport, output)).toMatchObject({
        x: 0, y: 0, width: output.width, height: output.height,
      });
    }
  });

  it("keeps the selected picture height instead of squeezing wide stages into a 16:9 box", () => {
    expect(replayExportDimensions({ width: 1280, height: 580 }, { width: 1280, height: 720 }))
      .toEqual({ width: 1588, height: 720 });
    expect(replayExportDimensions({ width: 2040, height: 930 }, { width: 1920, height: 1080 }))
      .toEqual({ width: 2370, height: 1080 });
    expect(replayExportDimensions({ width: 390, height: 650 }, { width: 1280, height: 720 }))
      .toEqual({ width: 432, height: 720 });
  });
});

describe("captured replay composition", () => {
  it.each([{ width: 1280, height: 720 }, { width: 1920, height: 1080 }])("preserves gaps between independently positioned overlays at $height p", (preset) => {
    const source = { width: 2040, height: 930 };
    const output = replayExportDimensions(source, preset);
    const fit = fitReplayComposition(source, output);
    const leaderboard = { x: 0, width: 180 };
    const handAccuracy = { x: 332, width: 190 };
    const misses = { x: 310, width: 205 };
    for (const overlay of [handAccuracy, misses]) {
      const originalGap = overlay.x - (leaderboard.x + leaderboard.width);
      const exportedGap = (fit.x + overlay.x * fit.scale)
        - (fit.x + (leaderboard.x + leaderboard.width) * fit.scale);
      expect(exportedGap).toBeCloseTo(originalGap * fit.scale);
      expect(exportedGap).toBeGreaterThan(0);
    }
    expect(fit.x).toBe(0);
    expect(fit.y).toBe(0);
    expect(fit.height).toBe(preset.height);
  });

  it("fills the output when the captured stage already has the output aspect ratio", () => {
    expect(fitReplayComposition({ width: 2560, height: 1440 }, { width: 1920, height: 1080 }))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1080, scale: 0.75 });
  });

  it("fits a portrait stage without cropping or stretching it", () => {
    const fit = fitReplayComposition({ width: 390, height: 650 }, { width: 1280, height: 720 });
    expect(fit.y).toBe(0);
    expect(fit.x).toBeGreaterThan(0);
    expect(fit.width / fit.height).toBeCloseTo(390 / 650);
    expect(fit.width * fit.height).toBeLessThanOrEqual(1280 * 720);
  });
});
