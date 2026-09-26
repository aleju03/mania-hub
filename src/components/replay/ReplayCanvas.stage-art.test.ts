import { afterEach, describe, expect, it, vi } from "vitest";
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
  getLayout(): typeof LAYOUT;
  invalidateLayoutCache(): void;
  prepareOverlayLayout(): void;
  getOverlaySettingsSnapshot(options?: { resolveLayout?: boolean }): ReplayOverlaySettings;
  updateOverlayPlacement(id: ReplayOverlayId, placement: Partial<ReplayOverlaySettings[ReplayOverlayId]>): void;
  resetOverlayPlacement(id: ReplayOverlayId): void;
  getOverlayScale(layout: typeof LAYOUT, id: ReplayOverlayId): number;
  getOverlayFrame(layout: typeof LAYOUT, id: ReplayOverlayId, width: number, height: number): Frame;
  getStageArtLayout(layout: typeof LAYOUT, id: ReplayOverlayId): typeof LAYOUT;
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
  renderSkinHealthBar(layout: typeof LAYOUT, health: number): boolean;
};

const LAYOUT = { w: 1600, h: 900, playfieldX: 600, playfieldWidth: 400, layoutScale: 1.875 };
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
    fullHeightLayout: true, scrollSpeed: 20, modRate: 1,
    selectedOverlayIds: new Set<ReplayOverlayId>(),
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


// A padded stage-left image with a portrait above its leaderboard frame.
// The portrait makes the art's center differ from the board's center.
function mockPaddedArt() {
  vi.stubGlobal("Image", class {
    naturalWidth = 10;
    naturalHeight = 10;
    onload?: () => void;
    set src(_value: string) { this.onload?.(); }
  });
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => ({
      drawImage: vi.fn(),
      getImageData: () => {
        const data = new Uint8ClampedArray(400);
        for (let y = 1; y < 8; y++) {
          for (let x = 1; x < 5; x++) data[(y * 10 + x) * 4 + 3] = 255;
        }
        return { data };
      },
    }) }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("skinned HP bar hit area", () => {
  function healthBarRenderer({ blankFill = false, visibleBackground = false } = {}) {
    // aleju03-lazer uses a transparent 1x1 background and a 614x60 fill
    // whose only visible pixels are the horizontal strip at y=21..30.
    const assets = {
      scorebarBg: { src: `hp-bg-${visibleBackground}-${blankFill}`, width: 1, height: 1 },
      scorebarColour: { src: `hp-fill-${visibleBackground}-${blankFill}`, width: 614, height: 60 },
    };
    vi.stubGlobal("Image", class {
      naturalWidth = 1;
      naturalHeight = 1;
      onload?: () => void;
      source = "";
      set src(value: string) {
        this.source = value;
        const asset = value === assets.scorebarColour.src ? assets.scorebarColour : assets.scorebarBg;
        this.naturalWidth = asset.width;
        this.naturalHeight = asset.height;
        this.onload?.();
      }
    });
    vi.stubGlobal("document", {
      createElement: () => {
        let source = "";
        return { getContext: () => ({
          drawImage: (image: { source: string }) => { source = image.source; },
          getImageData: (_x: number, _y: number, width: number, height: number) => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y++) {
              const visible = source === assets.scorebarColour.src
                ? !blankFill && y >= Math.floor(21 / 60 * height) && y < Math.ceil(31 / 60 * height)
                : visibleBackground;
              if (visible) for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = 255;
            }
            return { data };
          },
        }) };
      },
    });
    const renderer = stageArtRenderer();
    const draw = vi.fn();
    Object.assign(renderer, {
      skinProfile: { assets: { stage: assets } },
      getStageAssetNativeSize: (asset: { width: number; height: number }) => asset,
      drawSkinImageRotatedCcw: draw,
    });
    const render = (health: number) => {
      renderer.overlayHitboxes = [];
      renderer.stageArtOverlayIds.clear();
      renderer.renderSkinHealthBar(LAYOUT, health);
      return renderer.overlayHitboxes.find((box) => box.id === "healthBar");
    };
    render(1); // Let the alpha reads complete before inspecting trimmed bounds.
    return { renderer, render, draw, assets };
  }

  it("lets the visible fill be grabbed when the skin's background is fully transparent", () => {
    const { renderer, render, draw, assets } = healthBarRenderer();
    const box = render(1)!;
    expect(box).toBeDefined();
    expect(renderer.listStageArtOverlayIds()).toContain("healthBar");
    const [, x, bottom, length, thickness] = draw.mock.calls.find(([asset]) => asset === assets.scorebarColour)!;
    const visibleCenter = x + thickness * 26 / 60;
    expect(box.x).toBeLessThan(visibleCenter);
    expect(box.x + box.width).toBeGreaterThan(visibleCenter);
    expect(box.y).toBeCloseTo(bottom - length);
    expect(box.height).toBeCloseTo(length);
    expect(render(0.25)).toEqual(box);
    expect(render(0)).toEqual(box);
  });

  it("does not make a fully invisible bar selectable", () => {
    const { renderer, render } = healthBarRenderer({ blankFill: true });
    expect(render(1)).toBeUndefined();
    expect(renderer.listStageArtOverlayIds()).not.toContain("healthBar");
  });

  it("includes visible background art as well as the fill", () => {
    const { render, draw, assets } = healthBarRenderer({ visibleBackground: true });
    const box = render(1)!;
    const [, bgX] = draw.mock.calls.find(([asset]) => asset === assets.scorebarBg)!;
    const [, fillX, , , thickness] = draw.mock.calls.find(([asset]) => asset === assets.scorebarColour)!;
    expect(box.x).toBeCloseTo(bgX);
    expect(box.x + box.width).toBeGreaterThan(fillX + thickness * 26 / 60);
  });
});

describe("moved skin art across viewport sizes", () => {
  it("keeps a padded frame aligned with its leaderboard through fitting, saving and export", () => {
    mockPaddedArt();
    const viewer = stageArtRenderer({
      stageLeft: { enabled: true, x: -0.02, y: 0, scale: 1.2 },
      leaderboard: { enabled: true, x: 0.02, y: 0.35, scale: 1 },
      handAccuracy: { enabled: true, x: 0.25, y: 0.4, scale: 1 },
    });
    const art = { asset: { src: "padded-leaderboard-frame" } };
    const draw = (renderer: StageArtRenderer) => {
      renderer.overlayHitboxes = [];
      const layout = renderer.getLayout();
      const native = renderer.getStageArtLayout(layout, "stageLeft");
      const frame = renderer.getStageArtFrame(layout, "stageLeft", {
        x: 0, y: 0, width: 240 * native.layoutScale, height: native.h,
      }, art)!;
      const scale = renderer.getOverlayScale(layout, "leaderboard");
      const board = renderer.getOverlayFrame(layout, "leaderboard", 112 * scale, 274 * scale);
      // Another overlay beside it forces the whole group to fit on a narrow stage.
      const handScale = renderer.getOverlayScale(layout, "handAccuracy");
      renderer.getOverlayFrame(layout, "handAccuracy", 100 * handScale, 80 * handScale);
      return { frame, board };
    };
    draw(viewer); // Alpha scan completes; the next frame has trimmed bounds.
    const original = draw(viewer);
    viewer.prepareOverlayLayout();
    const saved = viewer.getOverlaySettingsSnapshot();
    expect(saved.stageLeft.reference?.anchorY).toBeCloseTo((original.board.y + original.board.height / 2) / viewer.cssHeight);
    expect(saved.stageLeft.x).toBeCloseTo(-0.02); // Full rect, not trimmed hitbox.
    expect(saved.stageLeft.reference?.size?.groupExtent).toBe(saved.leaderboard.reference?.size?.groupExtent);

    for (const [width, height] of [[1000, 1100], [1600, 900], [1600, 1200], [1600, 900]]) {
      viewer.cssWidth = width;
      viewer.cssHeight = height;
      viewer.invalidateLayoutCache();
      const { frame, board } = draw(viewer);
      const ratio = board.width / original.board.width;
      expect(frame.width / original.frame.width).toBeCloseTo(ratio);
      expect(frame.height / original.frame.height).toBeCloseTo(ratio);
      expect(frame.x - board.x).toBeCloseTo((original.frame.x - original.board.x) * ratio);
      expect(frame.y - board.y).toBeCloseTo((original.frame.y - original.board.y) * ratio);
    }

    viewer.cssWidth = 1000;
    viewer.cssHeight = 1100;
    viewer.invalidateLayoutCache();
    const narrow = draw(viewer);
    viewer.updateOverlayPlacement("stageLeft", { ...viewer.getOverlayPlacementOrigin(viewer.overlayHitboxes[0]), scale: 1.8 });
    expect(draw(viewer).frame.width).toBeCloseTo(narrow.frame.width * 1.5);
    const capture = JSON.parse(JSON.stringify(viewer.getOverlaySettingsSnapshot({ resolveLayout: true })));
    const reopened = stageArtRenderer(capture);
    reopened.cssWidth = 1000;
    reopened.cssHeight = 1100;
    const restored = draw(reopened).frame;
    const current = draw(viewer).frame;
    for (const key of ["x", "y", "width", "height"] as const) expect(restored[key]).toBeCloseTo(current[key]);
    reopened.cssWidth = 1600;
    reopened.cssHeight = 900;
    reopened.invalidateLayoutCache();
    expect(draw(reopened).frame.width).toBeCloseTo(original.frame.width * 1.5);
  });

  it("authors the first move at the displayed size and can return to native skin positioning", () => {
    const viewer = stageArtRenderer();
    viewer.getLayout();
    viewer.cssWidth = 1000;
    viewer.cssHeight = 1100;
    viewer.invalidateLayoutCache();
    const layout = viewer.getLayout();
    const base = { x: 20, y: 0, width: 150 * layout.layoutScale, height: layout.h };
    const before = viewer.getStageArtFrame(layout, "stageLeft", base)!;
    viewer.updateOverlayPlacement("stageLeft", { x: before.x / layout.w, y: before.y / layout.h });
    const native = viewer.getStageArtLayout(layout, "stageLeft");
    expect(native.h).toBe(layout.h);
    expect(viewer.getStageArtFrame(layout, "stageLeft", base)).toEqual(before);
    viewer.resetOverlayPlacement("stageLeft");
    expect(viewer.getStageArtLayout(layout, "stageLeft")).toBe(layout);
    expect(viewer.getStageArtFrame(layout, "stageLeft", base)).toEqual(before);
  });
});
