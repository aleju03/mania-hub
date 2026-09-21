import type { ReplayOverlayReference } from "./replay-overlays";

export type ReplayOverlayStage = {
  w: number;
  h: number;
  playfieldX: number;
  playfieldWidth: number;
};

export function replayOverlayRegion(
  box: { x: number; width: number },
  stage: ReplayOverlayStage,
): "left" | "right" | "playfield" {
  if (box.x + box.width <= stage.playfieldX) return "left";
  if (box.x >= stage.playfieldX + stage.playfieldWidth) return "right";
  return "playfield";
}

/** A taller fullscreen viewport must not enlarge HUD text or compress its gaps.
 * Fit the occupied side-group extent only when that group would otherwise spill
 * onto the playfield; unused gutter space is not part of the group.
 */
export function replayOverlayLayoutScale(reference: ReplayOverlayReference, stage: ReplayOverlayStage): number {
  const scale = reference.region === "left" || reference.region === "right"
    ? stage.w / reference.width : Math.min(stage.w / reference.width, stage.h / reference.height);
  if (!reference.groupExtent || reference.region === "playfield") return scale;
  const available = reference.region === "left"
    ? stage.playfieldX : stage.w - stage.playfieldX - stage.playfieldWidth;
  return Math.max(0.001, Math.min(scale, available / reference.groupExtent));
}

/** All neighbours on one side use the same transform, independent of their widths. */
export function replayOverlayX(
  x: number,
  width: number,
  reference: ReplayOverlayReference,
  stage: ReplayOverlayStage,
): number {
  const scale = replayOverlayLayoutScale(reference, stage);
  const originalX = x * reference.width;
  const originalRight = reference.playfieldX + reference.playfieldWidth;
  const right = stage.playfieldX + stage.playfieldWidth;
  const region = reference.region ?? replayOverlayRegion({ x: originalX, width: width / scale }, {
    w: reference.width, h: reference.height,
    playfieldX: reference.playfieldX, playfieldWidth: reference.playfieldWidth,
  });
  if (region === "left" || region === "right") {
    const start = reference.groupStart ?? 0;
    const available = region === "left" ? stage.playfieldX : stage.w - right;
    const baseScale = reference.region ? stage.w / reference.width : Math.min(stage.w / reference.width, stage.h / reference.height);
    const offset = reference.groupExtent
      ? Math.min(start * baseScale, Math.max(0, available - reference.groupExtent * scale)) : 0;
    const position = originalX - (region === "right" ? originalRight : 0);
    return (region === "right" ? right : 0) + offset + (position - start) * scale;
  }
  const sourceCenter = reference.playfieldX + reference.playfieldWidth / 2;
  const targetCenter = stage.playfieldX + stage.playfieldWidth / 2;
  return targetCenter + (originalX - sourceCenter) * scale;
}

export function replayOverlayScale(reference: ReplayOverlayReference, stage: ReplayOverlayStage): number {
  return reference.hudScale * replayOverlayLayoutScale(reference, stage);
}

/** Keep a leaderboard's relative center when its size and the stage height
 * change by different amounts. Saved y remains a top-edge coordinate.
 */
export function replayOverlayCenteredY(
  y: number,
  height: number,
  reference: ReplayOverlayReference,
  stage: ReplayOverlayStage,
): number {
  const originalHeight = height / replayOverlayLayoutScale(reference, stage);
  return (y + originalHeight / (2 * reference.height)) * stage.h - height / 2;
}
