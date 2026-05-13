import { describe, expect, it } from "vitest";
import { DEFAULT_REPLAY_OVERLAY_SETTINGS, normalizeReplayOverlaySettings } from "./replay-overlays";

describe("replay overlay settings", () => {
  it("uses the larger miss counter in the default layout", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.misses.scale).toBe(1);
  });

  it("uses a larger judgement overlay in the default layout", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements.scale).toBe(1.25);
  });

  it("migrates the old compact miss counter default to the current default", () => {
    const settings = normalizeReplayOverlaySettings({
      misses: { enabled: true, x: 0.085, y: 0.77, scale: 0.75 },
    });

    expect(settings.misses).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.misses);
  });

  it("migrates the old judgement overlay default to the current default", () => {
    const settings = normalizeReplayOverlaySettings({
      judgements: { enabled: true, x: 0.74, y: 0.07, scale: 1 },
    });

    expect(settings.judgements).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements);
  });

  it("preserves custom miss counter scale choices", () => {
    const settings = normalizeReplayOverlaySettings({
      misses: { enabled: true, x: 0.085, y: 0.77, scale: 1.2 },
    });

    expect(settings.misses.scale).toBe(1.2);
  });
});
