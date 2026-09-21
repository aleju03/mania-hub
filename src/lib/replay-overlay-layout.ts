import type { ReplayOverlayReference } from "./replay-overlays";

export type ReplayOverlayStage = {
  w: number;
  h: number;
  playfieldX: number;
  playfieldWidth: number;
};

/** Map a saved top-left coordinate within its original gutter or playfield. */
export function replayOverlayX(
  x: number,
  width: number,
  reference: ReplayOverlayReference,
  stage: ReplayOverlayStage,
): number {
  const originalX = x * reference.width;
  const originalWidth = width * reference.height / stage.h;
  const originalRight = reference.playfieldX + reference.playfieldWidth;
  const right = stage.playfieldX + stage.playfieldWidth;

  if (originalX + originalWidth <= reference.playfieldX) {
    const originalSpace = reference.playfieldX - originalWidth;
    const space = Math.max(0, stage.playfieldX - width);
    return originalSpace > 0 ? originalX / originalSpace * space : 0;
  }
  if (originalX >= originalRight) {
    const originalSpace = reference.width - originalRight - originalWidth;
    const space = Math.max(0, stage.w - right - width);
    const gap = originalX - originalRight;
    const proportionalGap = originalSpace > 0 ? gap / originalSpace * space : 0;
    // Keep the authored clearance from the lanes (and their health bar)
    // when a narrower gutter would otherwise pull the overlay into it.
    const minimumGap = Math.min(space, gap * stage.h / reference.height);
    return right + Math.max(minimumGap, proportionalGap);
  }
  // Intentionally overlapping the playfield is allowed; preserve that
  // placement relative to the lanes rather than forcing it into a gutter.
  return stage.playfieldX + (originalX - reference.playfieldX) / reference.playfieldWidth * stage.playfieldWidth;
}

export function replayOverlayScale(reference: ReplayOverlayReference, stageHeight: number): number {
  return reference.hudScale * stageHeight / reference.height;
}
