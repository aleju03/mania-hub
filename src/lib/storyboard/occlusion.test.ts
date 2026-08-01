import { describe, expect, it } from "vitest";
import { opaqueStoryboardSpriteCoversRect } from "./occlusion";

const target = { left: 100, top: 0, right: 500, bottom: 480 };
const base = {
  sprite: { originX: 0.5, originY: 0.5 },
  state: {
    x: 320,
    y: 240,
    scaleX: 640,
    scaleY: 480,
    rotation: 0,
    alpha: 1,
    flipH: false,
    flipV: false,
    additive: false,
  },
  textureWidth: 1,
  textureHeight: 1,
  viewportScale: 1,
  viewportOffsetX: 0,
  mask: null,
};

describe("storyboard opaque coverage", () => {
  it("accepts an opaque axis-aligned sprite covering the target", () => {
    expect(opaqueStoryboardSpriteCoversRect(base, target)).toBe(true);
  });

  it("rejects blending that can reveal gameplay", () => {
    expect(opaqueStoryboardSpriteCoversRect({
      ...base,
      state: { ...base.state, alpha: 0.99 },
    }, target)).toBe(false);
    expect(opaqueStoryboardSpriteCoversRect({
      ...base,
      state: { ...base.state, alpha: 0.99999 },
    }, target)).toBe(false);
    expect(opaqueStoryboardSpriteCoversRect({
      ...base,
      state: { ...base.state, additive: true },
    }, target)).toBe(false);
  });

  it("rejects rotated or undersized coverage", () => {
    expect(opaqueStoryboardSpriteCoversRect({
      ...base,
      state: { ...base.state, rotation: 0.01 },
    }, target)).toBe(false);
    expect(opaqueStoryboardSpriteCoversRect({
      ...base,
      state: { ...base.state, scaleX: 300 },
    }, target)).toBe(false);
  });

  it("accounts for flips and storyboard masks", () => {
    expect(opaqueStoryboardSpriteCoversRect({
      ...base,
      state: { ...base.state, flipH: true, flipV: true },
    }, target)).toBe(true);
    expect(opaqueStoryboardSpriteCoversRect({
      ...base,
      mask: { left: 150, top: 0, right: 640, bottom: 480 },
    }, target)).toBe(false);
  });
});
