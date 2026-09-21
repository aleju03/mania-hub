import { describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import type { ReplayOverlayId } from "../../lib/replay-overlays";

type Box = { id: ReplayOverlayId; x: number; y: number; width: number; height: number };
type ChromeRenderer = {
  overlayHitboxes: Box[];
  overlayCloseButtons: Array<{ id: ReplayOverlayId; x: number; y: number; radius: number }>;
  selectedOverlayIds: Set<ReplayOverlayId>;
  activeOverlayPointers: Map<number, { id: ReplayOverlayId; x: number; y: number }>;
  draggingOverlay: { pointerId: number } | null;
  resizingOverlay: { pointerId: number } | null;
  selectingOverlays: { pointerId: number } | null;
  pinchingOverlay: { pointerIds: number[] } | null;
  missThumbTagPress: { pointerId: number; x: number; y: number } | null;
  canvas: { style: { cursor: string }; hasPointerCapture(id: number): boolean; releasePointerCapture(id: number): void };
  isOverlayEditPoint(x: number, y: number, band: number): boolean;
  finishOverlayPointerInteraction(pointerId: number): void;
  cancelOverlayInteractions(): void;
};

function chromeRenderer(boxes: Box[] = []): ChromeRenderer {
  const captures = new Set([1, 2]);
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    cssWidth: 1600, cssHeight: 900,
    canvas: {
      style: { cursor: "grabbing" },
      // Exercise CSS-to-canvas conversion as well as offset coordinates.
      getBoundingClientRect: () => ({ left: 20, top: 40, width: 800, height: 450 }),
      hasPointerCapture: (id: number) => captures.has(id),
      releasePointerCapture: (id: number) => captures.delete(id),
    },
    overlayHitboxes: boxes, overlayCloseButtons: [],
    selectedOverlayIds: new Set<ReplayOverlayId>(), activeOverlayPointers: new Map(),
    draggingOverlay: null, resizingOverlay: null, selectingOverlays: null, pinchingOverlay: null,
    missThumbTagPress: null, canEditOverlays: () => true, render: vi.fn(),
  });
}

function blocksToolbar(renderer: ChromeRenderer, x: number, y: number): boolean {
  return renderer.isOverlayEditPoint(20 + x / 2, 40 + y / 2, 150);
}

const bottomArt: Box = { id: "stageRight", x: 1100, y: 650, width: 500, height: 400 };

describe("replay toolbar access around overlays", () => {
  it("reveals over unselected skin art, including the approach to a bottom decoration", () => {
    const renderer = chromeRenderer([bottomArt]);
    expect(blocksToolbar(renderer, 1300, 630)).toBe(false);
    expect(blocksToolbar(renderer, 1300, 850)).toBe(false);

    renderer.selectedOverlayIds.add("stageRight");
    expect(blocksToolbar(renderer, 1300, 630)).toBe(true);
    expect(blocksToolbar(renderer, 1300, 850)).toBe(true);
  });

  it("leaves the bottom 12 CSS pixels accessible even over selected art or a close button", () => {
    const renderer = chromeRenderer([bottomArt]);
    renderer.selectedOverlayIds.add("stageRight");
    renderer.overlayCloseButtons = [{ id: "stageRight", x: 1300, y: 890, radius: 10 }];
    expect(blocksToolbar(renderer, 1300, 870)).toBe(true);
    expect(blocksToolbar(renderer, 1300, 880)).toBe(false);
    expect(blocksToolbar(renderer, 1300, 890)).toBe(false);
  });

  it("still protects ordinary HUD overlays and their approach area", () => {
    const renderer = chromeRenderer([{ id: "hitError", x: 700, y: 830, width: 200, height: 30 }]);
    expect(blocksToolbar(renderer, 800, 800)).toBe(true);
    expect(blocksToolbar(renderer, 800, 840)).toBe(true);
    expect(blocksToolbar(renderer, 800, 870)).toBe(false);
    expect(blocksToolbar(renderer, 1000, 840)).toBe(false);
  });

  it.each(["draggingOverlay", "resizingOverlay", "selectingOverlays", "pinchingOverlay"] as const)(
    "ends an interrupted %s so it cannot keep blocking the entire toolbar",
    (gesture) => {
      const renderer = chromeRenderer();
      if (gesture === "pinchingOverlay") renderer.pinchingOverlay = { pointerIds: [1, 2] };
      else renderer[gesture] = { pointerId: 1 };
      if (gesture !== "selectingOverlays") renderer.activeOverlayPointers.set(1, { id: "stageRight", x: 0, y: 0 });
      // Active gestures still win over the bottom-edge escape strip.
      expect(blocksToolbar(renderer, 800, 895)).toBe(true);
      renderer.finishOverlayPointerInteraction(1);
      expect(blocksToolbar(renderer, 800, 895)).toBe(false);
      expect(renderer[gesture]).toBeNull();
      expect(renderer.canvas.hasPointerCapture(1)).toBe(false);
      expect(renderer.activeOverlayPointers.size).toBe(0);
      expect(renderer.canvas.style.cursor).toBe("");
    },
  );

  it("clears all interrupted pointers without treating cancellation as a click", () => {
    const renderer = chromeRenderer();
    renderer.selectedOverlayIds.add("misses");
    renderer.selectingOverlays = { pointerId: 1 };
    renderer.missThumbTagPress = { pointerId: 2, x: 100, y: 100 };
    renderer.activeOverlayPointers.set(2, { id: "misses", x: 100, y: 100 });
    renderer.cancelOverlayInteractions();
    expect(renderer.selectingOverlays).toBeNull();
    expect(renderer.missThumbTagPress).toBeNull();
    expect(renderer.activeOverlayPointers.size).toBe(0);
    expect(renderer.canvas.hasPointerCapture(1)).toBe(false);
    expect(renderer.canvas.hasPointerCapture(2)).toBe(false);
    expect([...renderer.selectedOverlayIds]).toEqual(["misses"]);
    expect(blocksToolbar(renderer, 800, 850)).toBe(false);
    // A subsequent lost-capture event is harmless.
    renderer.finishOverlayPointerInteraction(1);
    expect(blocksToolbar(renderer, 800, 850)).toBe(false);
  });
});
