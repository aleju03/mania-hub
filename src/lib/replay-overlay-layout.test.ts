import { describe, expect, it } from "vitest";
import { replayOverlayScale, replayOverlayX } from "./replay-overlay-layout";
import type { ReplayOverlayReference } from "./replay-overlays";

const reference: ReplayOverlayReference = { width: 2048, height: 1020, playfieldX: 600, playfieldWidth: 848, hudScale: 1.45 };
const inline = { w: reference.width, h: reference.height, playfieldX: reference.playfieldX, playfieldWidth: reference.playfieldWidth };
const fullscreen = { w: 2048, h: 1152, playfieldX: 545, playfieldWidth: 958 };

describe("replay overlay layout", () => {
  it.each([0, 0.15, 0.5, 0.76, -0.02])("preserves an authored position %s in its original layout", (x) => {
    expect(replayOverlayX(x, 150, reference, inline)).toBeCloseTo(x * reference.width);
  });

  it("keeps right-side overlays outside the playfield and preserves their clearance", () => {
    const width = 150 * fullscreen.h / reference.height;
    const x = replayOverlayX(0.76, width, reference, fullscreen);
    const right = fullscreen.playfieldX + fullscreen.playfieldWidth;
    expect(x).toBeGreaterThanOrEqual(right);
    expect(x + width).toBeLessThanOrEqual(fullscreen.w);
    const oldRight = reference.playfieldX + reference.playfieldWidth;
    expect(x - right).toBeGreaterThanOrEqual((0.76 * reference.width - oldRight) * fullscreen.h / reference.height);
  });

  it("keeps a complete left-side overlay outside the playfield", () => {
    const width = 150 * fullscreen.h / reference.height;
    const x = replayOverlayX(0.15, width, reference, fullscreen);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(fullscreen.playfieldX);
    expect(x / (fullscreen.playfieldX - width))
      .toBeCloseTo(0.15 * reference.width / (reference.playfieldX - 150));
  });

  it("preserves deliberately placed overlays over the lanes", () => {
    const x = replayOverlayX(0.5, 150, reference, fullscreen);
    expect((x - fullscreen.playfieldX) / fullscreen.playfieldWidth).toBeCloseTo(0.5);
  });

  it("keeps export resolution independent of overlay placement and scale", () => {
    for (const height of [720, 1080, 1440]) {
      const ratio = height / fullscreen.h;
      const stage = { w: fullscreen.w * ratio, h: height, playfieldX: fullscreen.playfieldX * ratio, playfieldWidth: fullscreen.playfieldWidth * ratio };
      const width = 150 * fullscreen.h / reference.height;
      expect(replayOverlayX(0.76, width * ratio, reference, stage) / ratio)
        .toBeCloseTo(replayOverlayX(0.76, width, reference, fullscreen));
      expect(replayOverlayScale(reference, height) / ratio).toBeCloseTo(replayOverlayScale(reference, fullscreen.h));
    }
  });
});
