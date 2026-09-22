// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import { DEFAULT_REPLAY_SKIN_SETTINGS, getReplaySkinProfile } from "../../lib/replay-skin";
import { DEFAULT_REPLAY_OVERLAY_SETTINGS, normalizeReplayOverlaySettings } from "../../lib/replay-overlays";
import type { ReplayOverlayId, ReplayOverlaySettings } from "../../lib/replay-overlays";

type OverlayBox = { id: ReplayOverlayId; x: number; y: number; width: number; height: number };
type NudgeEvent = { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; target?: unknown };
type KeyboardRenderer = {
  cssWidth: number;
  cssHeight: number;
  overlaySettings: ReplayOverlaySettings;
  overlayHitboxes: OverlayBox[];
  selectedOverlayIds: Set<ReplayOverlayId>;
  hideHud: boolean;
  applyOverlayNudgeKey(event: NudgeEvent): boolean;
  getOverlaySettingsSnapshot(): ReplayOverlaySettings;
};

afterEach(() => document.body.replaceChildren());

// The real renderer methods without a GPU canvas; renderViewport supplies
// the desktop pointer mode independently of the test DOM.
function keyboardRenderer(boxes: OverlayBox[]): KeyboardRenderer {
  const settings = normalizeReplayOverlaySettings(DEFAULT_REPLAY_OVERLAY_SETTINGS);
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    cssWidth: 1600, cssHeight: 900, fullscreenLayout: false, fullHeightLayout: false,
    barePlayfield: false, keyCount: 4, hideHud: false,
    skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4),
    skinSettings: DEFAULT_REPLAY_SKIN_SETTINGS, scrollSpeed: 20, modRate: 1,
    renderViewport: { coarsePointer: false },
    overlaySettings: settings, overlayHitboxes: boxes,
    overlaySettingsInputSignature: JSON.stringify(settings),
    overlayReferenceLayout: null, ruleset: { accuracyMode: "stable" },
    selectedOverlayIds: new Set<ReplayOverlayId>(),
    render: vi.fn(), onOverlaySettingsChange: vi.fn(),
  });
}

function box(id: ReplayOverlayId, x: number, y: number): OverlayBox {
  return { id, x, y, width: 120, height: 60 };
}

function placementOf(renderer: KeyboardRenderer, id: ReplayOverlayId) {
  const placement = renderer.getOverlaySettingsSnapshot()[id];
  return { x: placement.x * renderer.cssWidth, y: placement.y * renderer.cssHeight };
}

describe("arrow keys nudge the selected overlays", () => {
  it("moves one pixel per press and ten with shift", () => {
    const renderer = keyboardRenderer([box("judgements", 400, 300)]);
    renderer.selectedOverlayIds.add("judgements");

    expect(renderer.applyOverlayNudgeKey({ key: "ArrowRight" })).toBe(true);
    expect(placementOf(renderer, "judgements").x).toBeCloseTo(401);
    expect(placementOf(renderer, "judgements").y).toBeCloseTo(300);

    renderer.overlayHitboxes = [box("judgements", 401, 300)];
    expect(renderer.applyOverlayNudgeKey({ key: "ArrowUp", shiftKey: true })).toBe(true);
    expect(placementOf(renderer, "judgements").x).toBeCloseTo(401);
    expect(placementOf(renderer, "judgements").y).toBeCloseTo(290);
  });

  it("moves a multi-selection together and stops each one at the stage edge", () => {
    const renderer = keyboardRenderer([box("judgements", 1479, 300), box("accuracy", 200, 300)]);
    renderer.selectedOverlayIds.add("judgements");
    renderer.selectedOverlayIds.add("accuracy");

    expect(renderer.applyOverlayNudgeKey({ key: "ArrowRight", shiftKey: true })).toBe(true);
    // 1600 - 120 is as far right as the 120px-wide overlay goes; the other
    // one still travels its full ten pixels.
    expect(placementOf(renderer, "judgements").x).toBeCloseTo(1480);
    expect(placementOf(renderer, "accuracy").x).toBeCloseTo(210);
  });

  it("detaches an anchored overlay from where it is drawn", () => {
    const renderer = keyboardRenderer([box("hitError", 600, 800)]);
    renderer.selectedOverlayIds.add("hitError");

    expect(renderer.applyOverlayNudgeKey({ key: "ArrowLeft" })).toBe(true);
    expect(placementOf(renderer, "hitError").x).toBeCloseTo(599);
    expect(placementOf(renderer, "hitError").y).toBeCloseTo(800);
  });

  it("leaves the key to the page without a selection, in a typing field, or under a modifier", () => {
    const renderer = keyboardRenderer([box("judgements", 400, 300)]);
    expect(renderer.applyOverlayNudgeKey({ key: "ArrowRight" })).toBe(false);

    renderer.selectedOverlayIds.add("judgements");
    expect(renderer.applyOverlayNudgeKey({ key: "ArrowRight", target: document.createElement("input") })).toBe(false);
    expect(renderer.applyOverlayNudgeKey({ key: "ArrowRight", ctrlKey: true })).toBe(false);
    expect(renderer.applyOverlayNudgeKey({ key: "Space" })).toBe(false);

    renderer.hideHud = true;
    expect(renderer.applyOverlayNudgeKey({ key: "ArrowRight" })).toBe(false);
    expect(placementOf(renderer, "judgements").x).toBeCloseTo(0.92 * 1600);
    expect(placementOf(renderer, "judgements").y).toBeCloseTo(0.2 * 900);
  });

  it.each([
    '<button aria-haspopup="listbox"><span>Style</span></button>',
    '<button role="option"><span>Meters</span></button>',
    '<div role="listbox" tabindex="0"><span>Meters</span></div>',
    '<div role="slider" tabindex="0"><span>Volume</span></div>',
    '<a href="/skins"><span>Skins</span></a>',
    '<div contenteditable="true"><span>Draft</span></div>',
  ])("leaves arrows to a focused control and its descendants: %s", (markup) => {
    const renderer = keyboardRenderer([box("judgements", 400, 300)]);
    renderer.selectedOverlayIds.add("judgements");
    document.body.innerHTML = markup;
    const before = renderer.getOverlaySettingsSnapshot();

    for (const target of [document.body.firstElementChild, document.querySelector("span")]) {
      expect(renderer.applyOverlayNudgeKey({ key: "ArrowDown", target })).toBe(false);
    }
    expect(renderer.getOverlaySettingsSnapshot()).toEqual(before);
  });

  it.each([
    '<div role="dialog" aria-modal="true"></div>',
    '<dialog open></dialog>',
  ])("suspends nudging while a modal is open, even with focus outside it: %s", (markup) => {
    const renderer = keyboardRenderer([box("judgements", 400, 300)]);
    renderer.selectedOverlayIds.add("judgements");
    document.body.innerHTML = markup;
    const before = renderer.getOverlaySettingsSnapshot();

    expect(renderer.applyOverlayNudgeKey({ key: "ArrowDown", target: document.body })).toBe(false);
    expect(renderer.getOverlaySettingsSnapshot()).toEqual(before);

    document.body.replaceChildren();
    expect(renderer.applyOverlayNudgeKey({ key: "ArrowDown", target: document.body })).toBe(true);
    expect(placementOf(renderer, "judgements").y).toBeCloseTo(301);
  });

  it("ignores the nav's closed settings drawer, which stays mounted", () => {
    const renderer = keyboardRenderer([box("judgements", 400, 300)]);
    renderer.selectedOverlayIds.add("judgements");
    document.body.innerHTML = '<div role="dialog" aria-modal="true" aria-hidden="true"></div>';

    expect(renderer.applyOverlayNudgeKey({ key: "ArrowDown", target: document.body })).toBe(true);
    expect(placementOf(renderer, "judgements").y).toBeCloseTo(301);
  });

  it("drops an overlay that was closed while selected", () => {
    const renderer = keyboardRenderer([box("judgements", 400, 300)]);
    renderer.selectedOverlayIds.add("judgements");
    renderer.selectedOverlayIds.add("pp");

    expect(renderer.applyOverlayNudgeKey({ key: "ArrowDown" })).toBe(true);
    expect(Array.from(renderer.selectedOverlayIds)).toEqual(["judgements"]);
    expect(placementOf(renderer, "judgements").x).toBeCloseTo(400);
    expect(placementOf(renderer, "judgements").y).toBeCloseTo(301);
  });
});
