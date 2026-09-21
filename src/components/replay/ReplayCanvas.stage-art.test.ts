import { describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import { DEFAULT_REPLAY_SKIN_SETTINGS, getReplaySkinProfile } from "../../lib/replay-skin";
import { DEFAULT_REPLAY_OVERLAY_SETTINGS, REPLAY_OVERLAY_ANCHORED_COORD, REPLAY_STAGE_ART_MIN_COORD, normalizeReplayOverlaySettings } from "../../lib/replay-overlays";
import type { ReplayOverlayId, ReplayOverlaySettings } from "../../lib/replay-overlays";

type Frame = { x: number; y: number; width: number; height: number };
type Box = Frame & { id: ReplayOverlayId };
type Bounds = { left: number; top: number; right: number; bottom: number };
type StageArtRenderer = {
  cssWidth: number;
  cssHeight: number;
  overlaySettings: ReplayOverlaySettings;
  overlayHitboxes: Box[];
  stageArtOverlayIds: Set<ReplayOverlayId>;
  stageArtOriginOffsets: Map<ReplayOverlayId, { x: number; y: number }>;
  getStageArtFrame(
    layout: { w: number; h: number },
    id: ReplayOverlayId,
    base: Frame,
    art?: { asset: { src: string }; rotatedCcw?: boolean },
  ): (Frame & { scale: number }) | null;
  getStageArtHitbox(frame: Frame, bounds: Bounds, rotatedCcw: boolean): Frame;
  getOverlayPlacementOrigin(hitbox: Box): { x: number; y: number };
  clampOverlayPosition(id: ReplayOverlayId, x: number, y: number, width: number, height: number, layout: { w: number; h: number }): { x: number; y: number };
  listStageArtOverlayIds(): ReplayOverlayId[];
};

const LAYOUT = { w: 1600, h: 900 };
// The stage frame in the reported skin: taller than wide, art only on one side
// of a mostly transparent canvas.
const FRAME_BASE: Frame = { x: 200, y: 0, width: 500, height: LAYOUT.h };

function stageArtRenderer(overrides: Partial<ReplayOverlaySettings> = {}): StageArtRenderer {
  const settings = normalizeReplayOverlaySettings({ ...DEFAULT_REPLAY_OVERLAY_SETTINGS, ...overrides });
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    cssWidth: LAYOUT.w, cssHeight: LAYOUT.h, keyCount: 4,
    skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4),
    skinSettings: DEFAULT_REPLAY_SKIN_SETTINGS,
    ruleset: { accuracyMode: "stable" },
    overlaySettings: settings,
    overlaySettingsInputSignature: JSON.stringify(settings),
    overlayHitboxes: [] as Box[],
    stageArtOverlayIds: new Set<ReplayOverlayId>(),
    stageArtOriginOffsets: new Map<ReplayOverlayId, { x: number; y: number }>(),
    render: vi.fn(), onOverlaySettingsChange: vi.fn(),
  });
}

describe("skin stage art placement", () => {
  it("draws where the skin put it until it is moved", () => {
    const renderer = stageArtRenderer();
    const frame = renderer.getStageArtFrame(LAYOUT, "stageLeft", FRAME_BASE);

    expect(frame).toMatchObject({ ...FRAME_BASE, scale: 1 });
    // No art handed over, so the whole rect is grabbable.
    expect(renderer.overlayHitboxes).toEqual([{ id: "stageLeft", ...FRAME_BASE }]);
    expect(renderer.listStageArtOverlayIds()).toEqual(["stageLeft"]);
  });

  it("follows a stored placement and grows from the placement's scale", () => {
    const renderer = stageArtRenderer({
      stageLeft: { enabled: true, x: 0.5, y: 0.25, scale: 2 },
    });
    const frame = renderer.getStageArtFrame(LAYOUT, "stageLeft", FRAME_BASE);

    expect(frame).toMatchObject({ x: 800, y: 225, width: 1000, height: 1800, scale: 2 });
  });

  it("registers no hitbox for a piece that is turned off", () => {
    const renderer = stageArtRenderer({
      stageLeft: { enabled: false, x: REPLAY_OVERLAY_ANCHORED_COORD, y: REPLAY_OVERLAY_ANCHORED_COORD, scale: 1 },
    });

    expect(renderer.getStageArtFrame(LAYOUT, "stageLeft", FRAME_BASE)).toBeNull();
    expect(renderer.overlayHitboxes).toEqual([]);
    // Still the skin's, so the menu can offer it back.
    expect(renderer.listStageArtOverlayIds()).toEqual(["stageLeft"]);
  });

  it("grabs a stage frame by its visible pixels, not its whole rect", () => {
    const renderer = stageArtRenderer();
    const bounds: Bounds = { left: 0, top: 0.4, right: 0.5, bottom: 0.8 };

    expect(renderer.getStageArtHitbox(FRAME_BASE, bounds, false)).toEqual({
      x: 200, y: 360, width: 250, height: 360,
    });
  });

  it("reads a rotated piece's bounds down the axis it is drawn on", () => {
    const renderer = stageArtRenderer();
    // The health bar's art runs up the screen: the texture's x axis is the
    // frame's height, measured from the bottom.
    const bar: Frame = { x: 1000, y: 500, width: 200, height: 400 };
    const bounds: Bounds = { left: 0, top: 0.25, right: 0.5, bottom: 0.75 };

    expect(renderer.getStageArtHitbox(bar, bounds, true)).toEqual({
      x: 1050, y: 700, width: 100, height: 200,
    });
  });

  it("drags the art by its rect even when the grab was on the trimmed box", () => {
    const renderer = stageArtRenderer();
    renderer.stageArtOriginOffsets.set("stageLeft", { x: 40, y: 360 });

    const origin = renderer.getOverlayPlacementOrigin({ id: "stageLeft", x: 240, y: 360, width: 250, height: 360 });
    expect(origin.x).toBeCloseTo(200 / LAYOUT.w);
    expect(origin.y).toBeCloseTo(0);
  });

  it("lets stage art hang off the stage, keeping a strip to grab it by", () => {
    const renderer = stageArtRenderer();
    const far = renderer.clampOverlayPosition("stageLeft", -5, -5, 500, LAYOUT.h, LAYOUT);

    // A full-height frame clamped to the stage could never move vertically.
    expect(far.x).toBeCloseTo(-(500 - 32) / LAYOUT.w);
    // A piece as tall as the stage stops at the floor that keeps -1 reserved
    // for "still where the skin put it".
    expect(far.y).toBeCloseTo(REPLAY_STAGE_ART_MIN_COORD);
    expect(renderer.clampOverlayPosition("stageLeft", 5, 5, 500, LAYOUT.h, LAYOUT)).toEqual({ x: 1 - 32 / LAYOUT.w, y: 1 - 32 / LAYOUT.h });
  });

  it("keeps HUD overlays inside the stage", () => {
    const renderer = stageArtRenderer();

    expect(renderer.clampOverlayPosition("judgements", -5, -5, 200, 100, LAYOUT)).toEqual({ x: 0, y: 0 });
  });
});
