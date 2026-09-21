import { describe, expect, it, vi } from "vitest";
import { DEFAULT_REPLAY_SKIN_SETTINGS, getReplaySkinProfile } from "../../lib/replay-skin";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import { DEFAULT_REPLAY_OVERLAY_SETTINGS, normalizeReplayOverlaySettings } from "../../lib/replay-overlays";
import type { ReplayOverlayId, ReplayOverlaySettings } from "../../lib/replay-overlays";
import type { ReplayOverlayStage } from "../../lib/replay-overlay-layout";
import type { ReplayViewportSnapshot } from "../../lib/replay-types";
import { fitReplayComposition, replayExportViewport } from "../../lib/replay-export/composition";
import { LAZER_LEADERBOARD } from "../../lib/replay-leaderboard";


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

// Exercise the real renderer methods while keeping WebGL out of these tests.

type OverlayLayout = ReplayOverlayStage & { layoutScale: number };
type OverlayBox = { id: ReplayOverlayId; x: number; y: number; width: number; height: number };
type OverlayRenderer = {
  cssWidth: number;
  cssHeight: number;
  fullscreenLayout: boolean;
  ruleset: { accuracyMode: "stable" | "lazer" };
  overlaySettings: ReplayOverlaySettings;
  overlayHitboxes: OverlayBox[];
  hidePlaybackInfo: boolean;
  getLayout(): OverlayLayout;
  invalidateLayoutCache(): void;
  getOverlayScale(layout: OverlayLayout, id: ReplayOverlayId): number;
  getOverlayFrame(layout: OverlayLayout, id: ReplayOverlayId, width: number, height: number, anchor?: { x: number; y: number }): OverlayBox;
  clampOverlayPosition(id: ReplayOverlayId, x: number, y: number, width: number, height: number, layout: OverlayLayout): { x: number; y: number };
  getOverlaySettingsSnapshot(options?: { resolveLayout?: boolean }): ReplayOverlaySettings;
  prepareOverlayLayout(): void;
  setOverlaySettings(settings: ReplayOverlaySettings): void;
  getOverlayPlacementOrigin(box: OverlayBox): { x: number; y: number };
  updateOverlayPlacements(placements: Array<readonly [ReplayOverlayId, Partial<ReplayOverlaySettings[ReplayOverlayId]>]>): void;
  updateOverlayPlacement(id: ReplayOverlayId, placement: Partial<ReplayOverlaySettings[ReplayOverlayId]>): void;
  resetOverlaySize(id: ReplayOverlayId): void;
  setSkinSettings(settings: typeof DEFAULT_REPLAY_SKIN_SETTINGS): void;
  renderHUD(layout: OverlayLayout): void;
  measureCanvas(): void;
  getViewportSnapshot(): ReplayViewportSnapshot;
};

function overlayRenderer(settings = DEFAULT_REPLAY_OVERLAY_SETTINGS): OverlayRenderer {
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    cssWidth: 2048, cssHeight: 900, fullscreenLayout: false, fullHeightLayout: false,
    barePlayfield: false, keyCount: 7,
    skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 7),
    skinSettings: DEFAULT_REPLAY_SKIN_SETTINGS, scrollSpeed: 20, modRate: 1,
    overlaySettings: normalizeReplayOverlaySettings(settings), overlayHitboxes: [],
    overlaySettingsInputSignature: JSON.stringify(normalizeReplayOverlaySettings(settings)),
    overlayReferenceLayout: null, ruleset: { accuracyMode: "stable" },
    selectedOverlayIds: new Set<ReplayOverlayId>(),
    render: vi.fn(), onOverlaySettingsChange: vi.fn(),
  });
}

function judgementFrame(renderer: OverlayRenderer): OverlayBox {
  const layout = renderer.getLayout();
  const scale = renderer.getOverlayScale(layout, "judgements");
  return { ...renderer.getOverlayFrame(layout, "judgements", 50 * scale, 108 * scale), id: "judgements" };
}

describe("overlay layout across fullscreen and video export", () => {
  it.each(["move", "resize", "multi-selection", "style change"] as const)("preserves authored sizes after a %s in a narrow window", (edit) => {
    const settings = structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    settings.leaderboard = { enabled: true, x: 0, y: 0.24, scale: 1 };
    settings.handAccuracy = { enabled: true, x: 0.18, y: 0.36, scale: 1 };
    settings.misses = { enabled: true, x: 0.18, y: 0.5, scale: 1 };
    const viewer = overlayRenderer(settings);
    Object.assign(viewer, { keyCount: 4, fullHeightLayout: true, skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4) });
    const draw = (renderer: OverlayRenderer) => {
      renderer.overlayHitboxes = [];
      const layout = renderer.getLayout();
      return (["handAccuracy", "misses"] as const).map((id) => {
        const scale = renderer.getOverlayScale(layout, id);
        return renderer.getOverlayFrame(layout, id, 100 * scale, 45 * scale);
      });
    };
    const original = draw(viewer);
    viewer.prepareOverlayLayout();
    viewer.cssWidth = 900;
    viewer.cssHeight = 1000;
    viewer.invalidateLayoutCache();
    const narrow = draw(viewer);
    expect(narrow[0].width / original[0].width).toBeLessThan(900 / 2048);
    const origin = viewer.getOverlayPlacementOrigin(narrow[0]);
    const scale = edit === "resize" ? 1.5 : 1;
    const patch = { x: origin.x, y: origin.y + 0.01, scale };
    if (edit === "multi-selection") {
      viewer.updateOverlayPlacements([["handAccuracy", patch], ["misses", {
        ...viewer.getOverlayPlacementOrigin(narrow[1]), y: narrow[1].y / viewer.cssHeight + 0.01,
      }]]);
    } else viewer.updateOverlayPlacement("handAccuracy", edit === "style change" ? { style: "plain" } : patch);
    expect(draw(viewer)[0].width).toBeCloseTo(narrow[0].width * scale);
    viewer.prepareOverlayLayout();
    viewer.cssWidth = 2048;
    viewer.cssHeight = 900;
    viewer.invalidateLayoutCache();
    const restored = draw(viewer);
    expect(restored[0].width).toBeCloseTo(original[0].width * scale);
    expect(restored[1].width).toBeCloseTo(original[1].width);

    const reopened = overlayRenderer(JSON.parse(JSON.stringify(viewer.getOverlaySettingsSnapshot())));
    Object.assign(reopened, { keyCount: 4, fullHeightLayout: true, skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4) });
    expect(draw(reopened).map((box) => box.width)).toEqual(restored.map((box) => box.width));
    reopened.updateOverlayPlacement("handAccuracy", { scale: 2.5 });
    expect(draw(reopened)[0].width).toBeCloseTo(original[0].width * 2.5);
  });

  it("recovers an already shrunken overlay without resetting its position or its neighbours", () => {
    const viewer = overlayRenderer();
    const normal = judgementFrame(viewer);
    const settings = viewer.getOverlaySettingsSnapshot();
    settings.judgements = {
      ...settings.judgements, scale: 2.5,
      reference: { ...settings.judgements.reference!, hudScale: 0.1 },
    };
    viewer.setOverlaySettings(settings);
    viewer.overlayHitboxes = [];
    const shrunken = judgementFrame(viewer);
    const neighbours = viewer.getOverlaySettingsSnapshot();
    expect(shrunken.width).toBeLessThan(normal.width / 2);

    viewer.resetOverlaySize("judgements");
    const restored = judgementFrame(viewer);
    expect(restored.width).toBeCloseTo(normal.width);
    expect(restored.x).toBeCloseTo(shrunken.x);
    expect(restored.y).toBeCloseTo(shrunken.y);
    expect(viewer.getOverlaySettingsSnapshot().misses).toEqual(neighbours.misses);
    expect(viewer.getOverlaySettingsSnapshot().leaderboard).toEqual(neighbours.leaderboard);
  });

  it.each(["before fullscreen", "in fullscreen"])("fits the leaderboard with hand stats when its scores arrive %s", (arrival) => {
    const settings = structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    settings.leaderboard = { enabled: true, x: 0, y: 0.24, scale: 1 };
    settings.handAccuracy = { enabled: true, x: 0.18, y: 0.36, scale: 1 };
    settings.misses = { enabled: true, x: 0.18, y: 0.5, scale: 1 };
    const viewer = overlayRenderer(settings);
    viewer.ruleset.accuracyMode = "lazer";
    viewer.cssHeight = 930;
    const skinProfile = { ...getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 7), columnWidths: Array(7).fill(66) };
    Object.assign(viewer, { skinProfile });
    const draw = (renderer: OverlayRenderer, hasScores: boolean) => {
      renderer.overlayHitboxes = [];
      const layout = renderer.getLayout();
      const ids: ReplayOverlayId[] = hasScores ? ["leaderboard", "handAccuracy", "misses"] : ["handAccuracy", "misses"];
      return ids.map((id) => {
        const scale = renderer.getOverlayScale(layout, id);
        return renderer.getOverlayFrame(layout, id,
          (id === "leaderboard" ? LAZER_LEADERBOARD.width : 100) * scale,
          (id === "leaderboard" ? LAZER_LEADERBOARD.height : 45) * scale);
      });
    };
    // The initial ResizeObserver callback runs while the score request is pending.
    draw(viewer, false);
    viewer.prepareOverlayLayout();
    const captured = viewer.getOverlaySettingsSnapshot({ resolveLayout: true });
    const original = draw(viewer, true);
    if (arrival === "in fullscreen") draw(viewer, false);
    for (let pass = 0; pass < 3; pass++) {
      viewer.prepareOverlayLayout();
      viewer.cssHeight = 1152;
      viewer.fullscreenLayout = true;
      viewer.invalidateLayoutCache();
      const fullscreen = draw(viewer, true);
      const scale = fullscreen[0].width / original[0].width;
      expect(scale).toBeLessThan(1);
      for (const index of [1, 2]) {
        const gap = fullscreen[index].x - fullscreen[0].x - fullscreen[0].width;
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeCloseTo((original[index].x - original[0].x - original[0].width) * scale);
      }
      expect((fullscreen[0].y + fullscreen[0].height / 2) / 1152)
        .toBeCloseTo((original[0].y + original[0].height / 2) / 930);
      for (const height of [720, 1080]) {
        const exporter = overlayRenderer(captured);
        Object.assign(exporter, { skinProfile });
        exporter.ruleset.accuracyMode = "lazer";
        exporter.cssWidth = height * 16 / 9;
        exporter.cssHeight = height;
        exporter.fullscreenLayout = true;
        const exported = draw(exporter, true);
        for (let i = 0; i < exported.length; i++) {
          for (const key of ["x", "y", "width", "height"] as const) {
            expect(exported[i][key] / (height / 1152)).toBeCloseTo(fullscreen[i][key]);
          }
        }
      }
      viewer.prepareOverlayLayout();
      viewer.cssHeight = 930;
      viewer.fullscreenLayout = false;
      viewer.invalidateLayoutCache();
      expect(draw(viewer, true)).toEqual(original);
    }
  });

  it.each(["stable", "lazer"] as const)("keeps %s overlay sizes/gaps through fullscreen, export, and return", (mode) => {
    const settings = structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    settings.leaderboard = { enabled: true, x: 0, y: 0.22, scale: 1 };
    settings.handAccuracy = { enabled: true, x: 0.21, y: 0.36, scale: 1 };
    settings.misses = { enabled: true, x: 0.21, y: 0.5, scale: 1 };
    const viewer = overlayRenderer(settings);
    viewer.ruleset.accuracyMode = mode;
    viewer.cssHeight = 930;
    Object.assign(viewer, { keyCount: 4, skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4) });
    const draw = (renderer: OverlayRenderer) => {
      renderer.overlayHitboxes = [];
      const layout = renderer.getLayout();
      return (["leaderboard", "handAccuracy", "misses"] as const).map((id) => {
        const scale = renderer.getOverlayScale(layout, id);
        const width = id === "leaderboard" ? (mode === "lazer" ? LAZER_LEADERBOARD.width : 112) : 100;
        return renderer.getOverlayFrame(layout, id, width * scale, (id === "leaderboard" ? 320 : 45) * scale);
      });
    };
    const original = draw(viewer);
    const captured = viewer.getOverlaySettingsSnapshot({ resolveLayout: true });
    viewer.prepareOverlayLayout();
    for (let pass = 0; pass < 3; pass++) {
      viewer.cssHeight = 1152;
      viewer.fullscreenLayout = true;
      viewer.invalidateLayoutCache();
      const fullscreen = draw(viewer);
      expect(fullscreen.map((box) => box.width)).toEqual(original.map((box) => box.width));
      expect((fullscreen[0].y + fullscreen[0].height / 2) / 1152)
        .toBeCloseTo((original[0].y + original[0].height / 2) / 930);
      for (const index of [1, 2]) {
        expect(fullscreen[index].x - fullscreen[0].x - fullscreen[0].width)
          .toBeCloseTo(original[index].x - original[0].x - original[0].width);
      }
      // A focus refresh must not reset the original geometry.
      viewer.setOverlaySettings(settings);
      for (const height of [720, 1080]) {
        const exporter = overlayRenderer(captured);
        exporter.ruleset.accuracyMode = mode;
        Object.assign(exporter, { keyCount: 4, skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4) });
        exporter.cssWidth = height * 16 / 9;
        exporter.cssHeight = height;
        exporter.fullscreenLayout = true;
        const exported = draw(exporter);
        const ratio = height / 1152;
        for (let i = 0; i < exported.length; i++) {
          for (const key of ["x", "y", "width", "height"] as const) {
            expect(exported[i][key] / ratio).toBeCloseTo(fullscreen[i][key]);
          }
        }
      }
      viewer.cssHeight = 930;
      viewer.fullscreenLayout = false;
      viewer.invalidateLayoutCache();
      expect(draw(viewer)).toEqual(original);
    }
  });

  it.each([4, 7])("fits a wide %iK viewer into 16:9 with shared side-overlay spacing", (keyCount) => {
    const settings = structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    settings.leaderboard = { enabled: true, x: 0, y: 0.24, scale: 1 };
    settings.handAccuracy = { enabled: true, x: 0.16, y: 0.46, scale: 1 };
    settings.misses = { enabled: true, x: 0.15, y: 0.58, scale: 1 };
    settings.judgements = { enabled: true, x: 0.77, y: 0.36, scale: 1 };
    const viewer = overlayRenderer(settings);
    Object.assign(viewer, { keyCount, skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, keyCount) });
    viewer.cssHeight = 930;
    const draw = (renderer: OverlayRenderer) => {
      const layout = renderer.getLayout();
      return (["leaderboard", "handAccuracy", "misses", "judgements"] as const).map((id) => {
        const scale = renderer.getOverlayScale(layout, id);
        return renderer.getOverlayFrame(layout, id, (id === "leaderboard" ? 112 : 145) * scale, 36 * scale);
      });
    };
    const original = draw(viewer);
    const sourceLayout = viewer.getLayout();
    const sourceSettings = structuredClone(viewer.overlaySettings);
    const captured = viewer.getOverlaySettingsSnapshot({ resolveLayout: true });
    for (const height of [720, 1080]) {
      const output = { width: height * 16 / 9, height };
      const viewport = replayExportViewport(viewer.getViewportSnapshot(), output);
      const fit = fitReplayComposition(viewport, output);
      const exporter = overlayRenderer(captured);
      Object.assign(exporter, { keyCount, skinProfile: getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, keyCount),
        canvas: { style: {} }, renderViewport: viewport, renderResolution: fit.scale,
      });
      exporter.measureCanvas();
      const frames = draw(exporter);
      const layout = exporter.getLayout();
      expect(fit).toMatchObject({ x: 0, y: 0, width: output.width, height });
      const groupScale = frames[0].width / original[0].width;
      for (const index of [1, 2]) {
        const originalGap = original[index].x - original[0].x - original[0].width;
        const gap = frames[index].x - frames[0].x - frames[0].width;
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeCloseTo(originalGap * groupScale);
        expect(frames[index].x + frames[index].width).toBeLessThanOrEqual(layout.playfieldX);
      }
      expect(frames[3].x).toBeGreaterThanOrEqual(layout.playfieldX + layout.playfieldWidth);
      expect(frames[3].x + frames[3].width).toBeLessThanOrEqual(layout.w);
    }
    expect(viewer.getLayout()).toEqual(sourceLayout);
    expect(viewer.overlaySettings).toEqual(sourceSettings);
  });

  it("clamps a saved off-screen lazer leaderboard when watching stable", () => {
    const settings = structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    settings.leaderboard.x = -0.06;
    const viewer = overlayRenderer(settings);
    const layout = viewer.getLayout();
    const frame = () => viewer.getOverlayFrame(layout, "leaderboard", 400, 300);
    const dragged = () => viewer.clampOverlayPosition("leaderboard", -0.5, 0.24, 400, 300, layout);

    viewer.ruleset.accuracyMode = "lazer";
    const lazerFrame = frame();
    expect(lazerFrame.x).toBeLessThan(0);
    expect(dragged().x * layout.w + 400).toBeCloseTo(32);

    viewer.ruleset.accuracyMode = "stable";
    expect(frame().x).toBe(0);
    expect(dragged().x).toBe(0);
    expect(viewer.overlaySettings.leaderboard.lazerPosition?.x).toBe(-0.06);

    viewer.ruleset.accuracyMode = "lazer";
    expect(frame()).toEqual(lazerFrame);
  });

  it("restores each leaderboard after editing and reopening the other replay type", () => {
    const lazer = overlayRenderer();
    lazer.ruleset.accuracyMode = "lazer";
    lazer.updateOverlayPlacement("leaderboard", { x: -0.06, y: 0.32, scale: 1.4 });
    const savedLazer = lazer.getOverlaySettingsSnapshot().leaderboard.lazerPosition;
    const frame = (viewer: OverlayRenderer) => viewer.getOverlayFrame(viewer.getLayout(), "leaderboard", 400, 300);
    const originalFrame = frame(lazer);
    const store = (viewer: OverlayRenderer) => JSON.parse(JSON.stringify(viewer.getOverlaySettingsSnapshot()));

    const stable = overlayRenderer(store(lazer));
    expect(frame(stable).x).toBe(0);
    stable.updateOverlayPlacements([["leaderboard", { x: 0.12, y: 0.15, scale: 0.8 }]]);
    stable.updateOverlayPlacement("misses", { x: 0.3 });
    const savedStable = stable.getOverlaySettingsSnapshot().leaderboard;
    expect(savedStable.lazerPosition).toEqual(savedLazer);

    const reopened = overlayRenderer(store(stable));
    reopened.ruleset.accuracyMode = "lazer";
    expect(frame(reopened)).toEqual(originalFrame);
    expect(reopened.getOverlaySettingsSnapshot().leaderboard.lazerPosition).toEqual(savedLazer);
    reopened.updateOverlayPlacements([["leaderboard", { x: -0.08, y: 0.4, scale: 1.6 }]]);
    const stableAgain = overlayRenderer(store(reopened));
    expect(frame(stableAgain)).toEqual(frame(stable));
    expect(stableAgain.overlaySettings.leaderboard).toMatchObject({ x: 0.12, y: 0.15, scale: 0.8, reference: savedStable.reference });
  });

  it("exports the captured inline composition without shrinking gaps between overlays", () => {
    const settings = structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    settings.leaderboard = { enabled: true, x: 0, y: 0.24, scale: 1 };
    settings.handAccuracy = { enabled: true, x: 0.16, y: 0.46, scale: 1 };
    settings.misses = { enabled: true, x: 0.15, y: 0.58, scale: 1 };
    const viewer = overlayRenderer(settings);
    viewer.cssHeight = 930;
    const draw = (renderer: OverlayRenderer) => {
      const layout = renderer.getLayout();
      return (["leaderboard", "handAccuracy", "misses"] as const).map((id) => {
        const scale = renderer.getOverlayScale(layout, id);
        return renderer.getOverlayFrame(layout, id, (id === "leaderboard" ? 112 : 145) * scale, 36 * scale);
      });
    };
    const original = draw(viewer);
    const viewport = viewer.getViewportSnapshot();
    const captured = viewer.getOverlaySettingsSnapshot();
    for (const height of [720, 1080]) {
      const output = { width: height * 16 / 9, height };
      const fit = fitReplayComposition(viewport, output);
      const exporter = overlayRenderer(captured);
      Object.assign(exporter, {
        canvas: { style: {}, getBoundingClientRect: () => output },
        renderViewport: viewport, renderResolution: fit.scale,
      });
      exporter.measureCanvas();
      expect(exporter.fullscreenLayout).toBe(false);
      expect(exporter.getLayout()).toEqual(viewer.getLayout());
      const frames = draw(exporter);
      expect(frames).toEqual(original);
      for (const index of [1, 2]) {
        const gap = frames[index].x - frames[0].x - frames[0].width;
        expect(gap).toBeGreaterThan(0);
        expect(gap * fit.scale).toBeCloseTo((original[index].x - original[0].width) * fit.scale);
      }
    }
  });

  it("keeps its reference on a settings refresh but rebinds legacy coordinates when the owner skin changes geometry", () => {
    const viewer = overlayRenderer();
    const original = viewer.getOverlaySettingsSnapshot().judgements.reference;
    viewer.cssHeight = 1152;
    viewer.invalidateLayoutCache();
    let profile = getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 7);
    Object.assign(viewer, {
      updateSkinCache: () => Object.assign(viewer, { skinProfile: profile }),
      prewarmSkinTextures: vi.fn(),
    });
    viewer.setSkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
    expect(viewer.getOverlaySettingsSnapshot().judgements.reference).toEqual(original);
    profile = { ...profile, columnStart: 73 };
    viewer.setSkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS);
    expect(viewer.getOverlaySettingsSnapshot().judgements.reference).toMatchObject({
      height: 1152, playfieldX: viewer.getLayout().playfieldX,
    });
  });

  it("keeps authored right-side judgement counts outside a 7K playfield", () => {
    const settings = structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS);
    settings.judgements = { enabled: true, x: 0.77, y: 0.35, scale: 1.5 };
    const viewer = overlayRenderer(settings);
    const original = judgementFrame(viewer);
    viewer.fullscreenLayout = true;
    viewer.cssHeight = 1152;
    viewer.invalidateLayoutCache();
    const fullscreen = judgementFrame(viewer);
    const layout = viewer.getLayout();
    expect(fullscreen.x).toBeGreaterThanOrEqual(layout.playfieldX + layout.playfieldWidth);
    expect(fullscreen.height).toBeCloseTo(original.height);
    expect(fullscreen.y / 1152).toBeCloseTo(original.y / 900);

    const captured = viewer.getOverlaySettingsSnapshot();
    for (const [width, height] of [[1920, 1080], [1280, 720]]) {
      const exporter = overlayRenderer(captured);
      exporter.cssWidth = width;
      exporter.cssHeight = height;
      exporter.fullscreenLayout = true;
      const frame = judgementFrame(exporter);
      const ratio = height / 1152;
      expect(frame.x / ratio).toBeCloseTo(fullscreen.x);
      expect(frame.y / ratio).toBeCloseTo(fullscreen.y);
      expect(frame.width / ratio).toBeCloseTo(fullscreen.width);
    }
    viewer.cssHeight = 900;
    viewer.invalidateLayoutCache();
    expect(judgementFrame(viewer)).toEqual(original);
  });

  it("begins a drag from the displayed position and remembers fullscreen edits", () => {
    const viewer = overlayRenderer();
    judgementFrame(viewer);
    viewer.cssHeight = 1152;
    viewer.invalidateLayoutCache();
    const before = judgementFrame(viewer);
    const origin = viewer.getOverlayPlacementOrigin(before);
    expect(origin.x).toBe(before.x / viewer.cssWidth);
    expect(origin.y).toBe(before.y / viewer.cssHeight);
    viewer.updateOverlayPlacement("judgements", { x: origin.x - 0.02, y: origin.y + 0.05 });
    const moved = judgementFrame(viewer);
    expect(moved.x).toBeCloseTo(before.x - 0.02 * viewer.cssWidth);
    expect(moved.y).toBeCloseTo(before.y + 0.05 * viewer.cssHeight);
    expect(moved.width).toBeCloseTo(before.width);
    viewer.updateOverlayPlacement("judgements", { enabled: false });
    const savedReference = viewer.overlaySettings.judgements.reference;
    viewer.cssHeight = 900;
    viewer.invalidateLayoutCache();
    viewer.updateOverlayPlacement("judgements", { enabled: true });
    expect(viewer.overlaySettings.judgements.reference).toEqual(savedReference);
    viewer.cssHeight = 1152;
    viewer.invalidateLayoutCache();
    expect(judgementFrame(viewer)).toEqual(moved);
  });

  it("keeps an anchored hit-error bar on its computed anchor", () => {
    const viewer = overlayRenderer();
    const layout = viewer.getLayout();
    const frame = viewer.getOverlayFrame(layout, "hitError", 400, 30, { x: 700, y: 850 });
    expect(frame).toMatchObject({ x: 700, y: 850 });
  });

  it("removes viewer transport labels from exports while retaining gameplay HUD", () => {
    const viewer = overlayRenderer();
    const addText = vi.fn();
    const score = vi.fn();
    Object.assign(viewer, {
      ...Object.fromEntries(["renderJudgementPop", "renderCombo", "renderLeaderboard", "renderHitErrorBar", "renderFailOverlay"].map((name) => [name, vi.fn()])),
      renderScoreBlock: score, shouldRenderCustomOverlays: () => false,
      addText, hidePerformanceStats: true, hudCachedTime: "3:14", playbackSpeed: 1,
    });
    viewer.renderHUD(viewer.getLayout());
    expect(addText.mock.calls.map(([text]) => text)).toEqual(["3:14", "1x"]);
    addText.mockClear();
    viewer.hidePlaybackInfo = true;
    viewer.renderHUD(viewer.getLayout());
    expect(addText).not.toHaveBeenCalled();
    expect(score).toHaveBeenCalledTimes(2);
  });
});
