import { describe, expect, it } from "vitest";
import { DEFAULT_REPLAY_SKIN_SETTINGS, getReplaySkinProfile } from "../../lib/replay-skin";
import { ManiaReplayRenderer } from "./ReplayCanvas";

function createLayoutRenderer(fullHeightLayout: boolean) {
  // Use the real layout calculations without allocating a GPU canvas.
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    cssWidth: 870,
    cssHeight: 680,
    fullHeightLayout,
    fullscreenLayout: false,
    barePlayfield: false,
    keyCount: 4,
    skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4),
    skinSettings: DEFAULT_REPLAY_SKIN_SETTINGS,
    scrollSpeed: 20,
    modRate: 1.5,
  }) as {
    cssWidth: number;
    cssHeight: number;
    invalidateLayoutCache(): void;
    getLayout(): { playfieldWidth: number; laneWidth: number; layoutScale: number; pixelsPerMs: number };
  };
}

describe("comparison skin scaling", () => {
  it("scales the skin uniformly when fullscreen makes a panel taller than wide", () => {
    const renderer = createLayoutRenderer(true);
    const inline = renderer.getLayout();

    renderer.cssHeight = 920;
    renderer.invalidateLayoutCache();
    const fullscreen = renderer.getLayout();
    expect(fullscreen.laneWidth / inline.laneWidth).toBeCloseTo(920 / 680);
    expect(fullscreen.pixelsPerMs / inline.pixelsPerMs).toBeCloseTo(920 / 680);
    expect(fullscreen.playfieldWidth / 920).toBeCloseTo(inline.playfieldWidth / 680);

    renderer.cssHeight = 680;
    renderer.invalidateLayoutCache();
    expect(renderer.getLayout()).toEqual(inline);
  });

  it("has no skin-width discontinuity at the panel's portrait boundary", () => {
    const renderer = createLayoutRenderer(true);
    renderer.cssHeight = 870;
    const before = renderer.getLayout();
    renderer.cssHeight = 871;
    renderer.invalidateLayoutCache();
    expect(renderer.getLayout().laneWidth / before.laneWidth).toBeCloseTo(871 / 870);
  });

  it("keeps the single-viewer phone portrait scale independent of extra height", () => {
    const renderer = createLayoutRenderer(false);
    renderer.cssWidth = 390;
    const before = renderer.getLayout();
    renderer.cssHeight = 920;
    renderer.invalidateLayoutCache();
    const after = renderer.getLayout();
    expect(after.layoutScale).toBe(before.layoutScale);
    expect(after.pixelsPerMs).toBe(before.pixelsPerMs);
  });
});
