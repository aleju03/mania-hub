import { describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import { REPLAY_MISS_STYLES } from "../../lib/replay-overlays";

describe.each(REPLAY_MISS_STYLES)("%s miss overlay", (style) => {
  function rendererFor(keys: number, hand = "right") {
    const graphics = Object.fromEntries(["circle", "roundRect", "stroke", "fill", "save", "setTransform", "restore"].map((name) => [name, vi.fn().mockReturnThis()]));
    return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
      overlaySettings: { misses: { style } },
      keyCount: keys,
      judgmentEvents: { length: 12000 },
      hudCachedLeftMisses: "0",
      hudCachedRightMisses: "12345",
      missThumbHand: hand,
      missThumbTagHovered: false,
      hideHud: false,
      getOverlayScale: () => 1,
      measureTextWidth: (text: string, size: number) => text.length * size * 0.6,
      getOverlayFrame: vi.fn((_layout, _id, width, height) => ({ x: 10, y: 20, width, height })),
      addText: vi.fn(),
      roundRect: vi.fn(),
      fillRect: vi.fn(),
      graphics,
      circle: vi.fn(),
    });
  }

  it("keeps zero and large counts bright and within a stable drag frame", () => {
    const renderer = rendererFor(7);
    renderer.renderMissOverlay({});
    const firstFrame = renderer.getOverlayFrame.mock.results[0].value;
    for (const value of ["0", "12345"]) {
      const [text, x, y, options] = renderer.addText.mock.calls.find(([text]: [string]) => text === value)!;
      const width = renderer.measureTextWidth(text, options.fontSize);
      const left = x - (options.anchorX ?? 0) * width;
      expect(left).toBeGreaterThanOrEqual(firstFrame.x);
      expect(left + width).toBeLessThanOrEqual(firstFrame.x + firstFrame.width);
      expect(y).toBeLessThanOrEqual(firstFrame.y + firstFrame.height);
      expect(options.alpha ?? 1).toBe(1);
    }
    renderer.hudCachedLeftMisses = "9999";
    renderer.hudCachedRightMisses = "1";
    renderer.renderMissOverlay({});
    expect(renderer.getOverlayFrame.mock.results[1].value).toEqual(firstFrame);
  });

  it.each(["left", "right"])("keeps the %s thumb target inside the draggable frame and clears it for even keymodes", (hand) => {
    const renderer = rendererFor(7, hand);
    renderer.renderMissOverlay({});
    const box = renderer.missThumbTagHitbox;
    const frame = renderer.getOverlayFrame.mock.results[0].value;
    expect(box.x).toBeGreaterThanOrEqual(frame.x);
    expect(box.y).toBeGreaterThanOrEqual(frame.y);
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
    expect(renderer.isMissThumbTagPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(true);
    renderer.keyCount = 4;
    renderer.addText.mockClear();
    renderer.renderMissOverlay({});
    expect(renderer.missThumbTagHitbox).toBeNull();
    expect(renderer.addText.mock.calls.some(([text]: [string]) => text === "+ THUMB")).toBe(false);
  });
});
