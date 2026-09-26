// The job's own renderer and compositor.
//
// This is the same `ManiaReplayRenderer` the viewer uses, driven by the
// export's clock instead of by playback: fixed output size regardless of the
// device's pixel ratio, no autonomous ticker, no interaction handlers, no
// performance overlay, and its own copy of every asset. The onscreen canvas
// is never captured; the route it belongs to may not even be mounted.

import { loadReplayRenderer } from "../replay-renderer-loader";
import type { ReplayHitsoundSchedule, ReplayRendererLike } from "../replay-types";
import { ReplayExportError, asReplayExportError } from "./errors";
import type { ReplayExportSpecV1 } from "./render-spec";
import type { LocalExportResources } from "./types";
import { fitReplayComposition } from "./composition";

const RENDERER_READY_TIMEOUT_MS = 15_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, detail: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReplayExportError("renderer_failed", detail)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ReplayExportRendererHandle = {
  /** Canvas the encoder reads; already composited. */
  readonly canvas: HTMLCanvasElement;
  /** Draws the given source time onto the composite canvas. */
  renderFrame: (sourceMs: number) => Promise<void>;
  /** Whole-run hitsound timeline, from the renderer's own resolution. */
  getHitsoundSchedule: () => ReplayHitsoundSchedule;
  destroy: () => void;
};

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): void {
  const imageAspect = sourceWidth / sourceHeight;
  const canvasAspect = width / height;
  const drawHeight = imageAspect > canvasAspect ? height : width / imageAspect;
  const drawWidth = imageAspect > canvasAspect ? height * imageAspect : width;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

export async function createExportRenderer(
  spec: ReplayExportSpecV1,
  resources: LocalExportResources,
  signal: AbortSignal,
): Promise<ReplayExportRendererHandle> {
  const width = spec.output.width;
  const height = spec.output.height;
  const viewport = spec.visual.viewport ?? {
    width, height, fullscreen: true, fullHeight: false, coarsePointer: false,
  };
  const composition = fitReplayComposition(viewport, { width, height });

  // A host detached from the replay route's DOM lifecycle: navigating away
  // unmounts the route, not this.
  const host = document.createElement("div");
  host.dataset.replayFullscreen = String(viewport.fullscreen);
  host.dataset.replayExportHost = "true";
  host.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    `width:${viewport.width}px`,
    `height:${viewport.height}px`,
    "overflow:hidden",
    "pointer-events:none",
    "opacity:0",
  ].join(";");

  const stageCanvas = document.createElement("canvas");
  stageCanvas.width = Math.max(1, Math.round(composition.width));
  stageCanvas.height = Math.max(1, Math.round(composition.height));
  stageCanvas.style.width = `${viewport.width}px`;
  stageCanvas.style.height = `${viewport.height}px`;
  host.appendChild(stageCanvas);
  document.body.appendChild(host);

  let renderer: ReplayRendererLike | null = null;
  const destroy = () => {
    renderer?.destroy();
    renderer = null;
    host.remove();
  };

  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (signal.aborted) throw new ReplayExportError("export_interrupted");

    const { ManiaReplayRenderer } = await withTimeout(
      loadReplayRenderer(),
      RENDERER_READY_TIMEOUT_MS,
      "Timed out loading the replay renderer.",
    );

    renderer = new ManiaReplayRenderer(
      stageCanvas,
      resources.replayFrames,
      spec.ruleset.keyCount,
      resources.notes,
      {
        isConvert: spec.ruleset.isConvert,
        isLazer: spec.ruleset.isLazer,
        legacyReplayFrameRounding: spec.ruleset.legacyReplayFrameRounding,
        od: spec.ruleset.od ?? undefined,
        showInputOverlay: spec.visual.showInputOverlay,
        mods: spec.ruleset.mods,
        speedMultiplier: spec.ruleset.modRate,
        timingPoints: resources.timingPoints,
        transparentBackground: true,
        blackPlayfield: spec.visual.blackPlayfield,
        // No live FPS counter in a recorded file.
        hidePerformanceStats: true,
        hidePlaybackInfo: true,
        viewport,
        // Logical coordinates stay those of the viewer; GPU pixels stay
        // bounded by the output instead of the source monitor's resolution.
        renderResolution: composition.scale,
        scrollVelocities: resources.scrollVelocities,
        expectedCounts: resources.expectedCounts,
        realTotalScore: resources.realTotalScore,
        initialCombo: resources.initialCombo,
        lifeBarFrames: resources.lifeBarFrames,
        skinSettings: spec.visual.skinSettings,
        overlaySettings: spec.visual.overlaySettings,
        missThumbHand: spec.visual.missThumbHand,
        inputOverlayOnly: spec.visual.inputOverlayOnly,
        inputOverlayColor: spec.visual.inputOverlayColor,
        inputOverlayKeyHistory: spec.visual.inputOverlayKeyHistory,
      },
    ) as ReplayRendererLike;

    await withTimeout(renderer.ready(), RENDERER_READY_TIMEOUT_MS, "Timed out starting the export renderer.");
    if (signal.aborted) throw new ReplayExportError("export_interrupted");

    renderer.setScrollSpeed(spec.visual.scrollSpeed);
    renderer.setSpeed(spec.ruleset.userSpeed);
    renderer.setBackgroundDim(spec.visual.bgDim);
    renderer.setLeaderboard?.(resources.leaderboard, resources.leaderboardPlayerName, resources.leaderboardOptions);
    renderer.setLeaderboardVisible?.(spec.visual.leaderboardVisible);
    if (spec.ruleset.isLazer && spec.visual.leaderboardVisible) {
      await withTimeout(renderer.leaderboardReady?.() ?? Promise.resolve(), RENDERER_READY_TIMEOUT_MS, "Timed out loading leaderboard avatars.");
    }

    const storyboard = spec.visual.storyboardEnabled ? resources.storyboard : null;
    if (storyboard) {
      renderer.setStoryboard?.(storyboard);
      // Textures must be resident before the first frame encodes; a
      // storyboard that pops in three seconds late is a broken export.
      await withTimeout(
        renderer.storyboardReady?.() ?? Promise.resolve(),
        RENDERER_READY_TIMEOUT_MS,
        "Timed out loading storyboard textures.",
      );
    }
    if (signal.aborted) throw new ReplayExportError("export_interrupted");

    const composite = document.createElement("canvas");
    composite.width = width;
    composite.height = height;
    const ctx = composite.getContext("2d", { alpha: false });
    if (!ctx) throw new ReplayExportError("renderer_failed", "Couldn't create the video compositor.");

    // With a storyboard active the Pixi canvas is opaque (it draws its own
    // background and dim), so the composite background never shows.
    const backdropVisible = spec.visual.bgDim < 100 && !storyboard;
    const backdrop = document.createElement("canvas");
    backdrop.width = Math.max(1, Math.round(composition.width));
    backdrop.height = Math.max(1, Math.round(composition.height));
    const backdropCtx = backdrop.getContext("2d", { alpha: false });
    if (!backdropCtx) throw new ReplayExportError("renderer_failed", "Couldn't create the export backdrop.");

    // The gradient, the cover art, and the dim never change during a job, so
    // they are drawn once here rather than rebuilt for every frame.
    const gradient = backdropCtx.createLinearGradient(0, 0, 0, backdrop.height);
    gradient.addColorStop(0, "#0a0a18");
    gradient.addColorStop(0.5, "#1a1016");
    gradient.addColorStop(1, "#0c0c14");
    backdropCtx.fillStyle = gradient;
    backdropCtx.fillRect(0, 0, backdrop.width, backdrop.height);

    const image = backdropVisible ? resources.backgroundImage : null;
    if (image) {
      const sourceWidth = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
      const sourceHeight = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
      if (sourceWidth > 0 && sourceHeight > 0) {
        drawCover(backdropCtx, image, sourceWidth, sourceHeight, backdrop.width, backdrop.height);
      }
    }
    backdropCtx.fillStyle = `rgba(0, 0, 0, ${Math.max(0, Math.min(1, spec.visual.bgDim / 100))})`;
    backdropCtx.fillRect(0, 0, backdrop.width, backdrop.height);

    // Catch a tainted canvas now, not forty thousand frames in.
    try {
      backdropCtx.getImageData(0, 0, 1, 1);
    } catch (error) {
      throw new ReplayExportError(
        "asset_not_origin_clean",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const activeRenderer = renderer;
    return {
      canvas: composite,
      renderFrame: async (sourceMs: number) => {
        await activeRenderer.renderFrameAt?.(sourceMs);
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(backdrop, composition.x, composition.y, composition.width, composition.height);
        ctx.drawImage(stageCanvas, composition.x, composition.y, composition.width, composition.height);
      },
      getHitsoundSchedule: () => {
        const schedule = activeRenderer.getHitsoundSchedule?.();
        return schedule ?? { presses: [], comboBreakTimesMs: [] };
      },
      destroy,
    };
  } catch (error) {
    destroy();
    throw asReplayExportError(error, "renderer_failed");
  }
}
