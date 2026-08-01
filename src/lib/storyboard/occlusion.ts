import type { StoryboardSpriteState } from "./timeline";
import type { CompiledStoryboardSprite } from "./types";

export interface StoryboardRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface StoryboardSpriteCoverageOptions {
  sprite: Pick<CompiledStoryboardSprite, "originX" | "originY">;
  state: Pick<
    StoryboardSpriteState,
    "x" | "y" | "scaleX" | "scaleY" | "rotation" | "alpha" | "flipH" | "flipV" | "additive"
  >;
  textureWidth: number;
  textureHeight: number;
  viewportScale: number;
  viewportOffsetX: number;
  mask: StoryboardRect | null;
}

// Returns true only for the simple, provable case: an axis-aligned, normally
// blended, fully opaque sprite whose transformed image rectangle covers the
// target. Callers separately prove that every source-image pixel is opaque.
export function opaqueStoryboardSpriteCoversRect(
  options: StoryboardSpriteCoverageOptions,
  target: StoryboardRect,
): boolean {
  const { sprite, state } = options;
  if (state.alpha < 1 || state.additive) return false;
  if (state.rotation !== 0) return false;
  if (!(options.textureWidth > 0) || !(options.textureHeight > 0) || !(options.viewportScale > 0)) return false;

  const scaleX = (state.flipH ? -1 : 1) * state.scaleX;
  const scaleY = (state.flipV ? -1 : 1) * state.scaleY;
  if (scaleX === 0 || scaleY === 0) return false;

  const x0 = options.viewportOffsetX + (
    state.x + (-sprite.originX * options.textureWidth) * scaleX
  ) * options.viewportScale;
  const x1 = options.viewportOffsetX + (
    state.x + ((1 - sprite.originX) * options.textureWidth) * scaleX
  ) * options.viewportScale;
  const y0 = (
    state.y + (-sprite.originY * options.textureHeight) * scaleY
  ) * options.viewportScale;
  const y1 = (
    state.y + ((1 - sprite.originY) * options.textureHeight) * scaleY
  ) * options.viewportScale;

  let coverage: StoryboardRect = {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
  if (options.mask) {
    coverage = {
      left: Math.max(coverage.left, options.mask.left),
      top: Math.max(coverage.top, options.mask.top),
      right: Math.min(coverage.right, options.mask.right),
      bottom: Math.min(coverage.bottom, options.mask.bottom),
    };
  }

  return coverage.left <= target.left
    && coverage.top <= target.top
    && coverage.right >= target.right
    && coverage.bottom >= target.bottom;
}
