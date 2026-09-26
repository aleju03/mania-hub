// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import type { ReplayOverlayId, ReplayOverlaySettings } from "../../lib/replay-overlays";

type Box = { id: ReplayOverlayId; x: number; y: number; width: number; height: number };
type PointerRenderer = {
  overlayHitboxes: Box[];
  getOverlayAtPoint(x: number, y: number, pointerType?: string): Box | null;
  getOverlayResizeDirection(box: Box, x: number, y: number, pointerType?: string): string | null;
};

const prototype = ManiaReplayRenderer.prototype as unknown as {
  initPixi(): Promise<void>;
  render(): void;
};
const renderers: ManiaReplayRenderer[] = [];
const bar: Box = { id: "healthBar", x: 240, y: 260, width: 2, height: 85 };

beforeEach(() => {
  // Keep the real event listeners and layout/placement code; omit only GPU work.
  vi.spyOn(prototype, "initPixi").mockResolvedValue();
  vi.spyOn(prototype, "render").mockImplementation(() => {});
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
  vi.restoreAllMocks();
});

function viewer() {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 508 }) as DOMRect;
  const captures = new Set<number>();
  canvas.setPointerCapture = (id) => { captures.add(id); };
  canvas.hasPointerCapture = (id) => captures.has(id);
  canvas.releasePointerCapture = (id) => { captures.delete(id); };
  const save = vi.fn<(settings: ReplayOverlaySettings) => void>();
  const renderer = new ManiaReplayRenderer(canvas, [], 7, [], {
    viewport: { width: 360, height: 508, fullscreen: false, fullHeight: false, coarsePointer: true },
    onOverlaySettingsChange: save,
  });
  renderers.push(renderer);
  const internal = renderer as unknown as PointerRenderer;
  internal.overlayHitboxes = [{ ...bar }];
  return { canvas, renderer, internal, save };
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number, id = 1) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, cancelable: true });
  Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: id } });
  canvas.dispatchEvent(event);
  return event;
}

describe("thin replay overlay gestures", () => {
  it("moves the HP bar with one finger even when the finger misses its two-pixel line", () => {
    const { canvas, renderer, save } = viewer();
    expect(pointer(canvas, "pointerdown", 253, 300).defaultPrevented).toBe(true);
    pointer(canvas, "pointermove", 313, 280);
    pointer(canvas, "pointerup", 313, 280);

    const placement = renderer.getOverlaySettingsSnapshot().healthBar;
    expect(placement.x * 360).toBeCloseTo(300);
    expect(placement.y * 508).toBeCloseTo(240);
    expect(placement.scale).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(canvas.hasPointerCapture(1)).toBe(false);
  });

  it("uses two fingers to resize instead of turning a one-finger drag into a resize", () => {
    const { canvas, renderer } = viewer();
    pointer(canvas, "pointerdown", 241, 280);
    pointer(canvas, "pointerdown", 241, 320, 2);
    pointer(canvas, "pointermove", 241, 360, 2);
    expect(renderer.getOverlaySettingsSnapshot().healthBar.scale).toBeCloseTo(2);
  });

  it("keeps exact hits ahead of touch padding and otherwise picks the closest bar", () => {
    const { internal } = viewer();
    const nearby: Box = { id: "stageRight", x: 258, y: 260, width: 2, height: 85 };
    internal.overlayHitboxes.push(nearby);
    expect(internal.getOverlayAtPoint(241, 300, "touch")?.id).toBe("healthBar");
    expect(internal.getOverlayAtPoint(247, 300, "touch")?.id).toBe("healthBar");
    expect(internal.getOverlayAtPoint(255, 300, "touch")?.id).toBe("stageRight");
    expect(internal.getOverlayAtPoint(210, 300, "touch")).toBeNull();
    expect(internal.getOverlayAtPoint(247, 300, "mouse")).toBeNull();
  });

  it("leaves the center of a thin bar draggable with a mouse while retaining edge resizing", () => {
    const { internal } = viewer();
    expect(internal.getOverlayResizeDirection(bar, 241, 300)).toBeNull();
    expect(internal.getOverlayResizeDirection(bar, 240, 300)).toBe("w");
    expect(internal.getOverlayResizeDirection(bar, 242, 300)).toBe("e");
    expect(internal.getOverlayResizeDirection(bar, 241, 260)).toBe("n");
    expect(internal.getOverlayResizeDirection(bar, 240, 300, "touch")).toBeNull();
  });
});
